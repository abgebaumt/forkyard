/**
 * Editing the branch history in the graph's place: the branch's own commits as a reorderable list
 * (newest on top, like the graph), chips for what changes, a conflict preview of exactly this plan
 * and one Apply. The edit itself lives in `useGraphEdit` (src/app/rebasePlan/graphEdit.ts).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Id, Sha } from "../../core";
import { askMessage } from "../../app/actionDialogs";
import { busyKeys } from "../../app/actions/keys";
import { stashChanges } from "../../app/actions/stash";
import { previewText, useConflictPreview } from "../../app/conflictPreview";
import { shortSha } from "../../app/format";
import { openMenuAt, openMenuAtElement } from "../../app/menus";
import { useRebaseBranchPlan } from "../../app/queries";
import { applyRebasePlan, refusalTitle } from "../../app/rebasePlan/apply";
import {
  changeCount,
  type EditState,
  flipIndex,
  moveDisplayed,
  type RowChip,
  rewordSummary,
  rowChip,
  setRowAction,
  squashOnto,
  toggleDrop,
} from "../../app/rebasePlan/gestures";
import {
  confirmLeaveGraphEdit,
  type GraphEdit,
  graphEditOf,
  leaveGraphEdit,
  openGraphEditInTool,
  refreshedPlan,
  staleAfter,
  updateGraphEdit,
} from "../../app/rebasePlan/graphEdit";
import {
  ACTIONS,
  actionForKey,
  actionInfo,
  checkPlan,
  combinedMessage,
  joinMessage,
  payloadRows,
  rowRoles,
  shownSummary,
  splitMessage,
} from "../../app/rebasePlan/model";
import { useBusy } from "../../app/store";
import { keyBelongsToView, viewMayTakeFocus } from "../../app/viewFocus";
import { ReorderList } from "../../components/ReorderList";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { cn, laneColor } from "../../ui/cn";
import { Checkbox } from "../../ui/Field";
import type { MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { editMessage, hasOwnMessage, hiddenCount, previewStep, takenOverDrag } from "./editModel";
import type { FlatGraph } from "./model";

const chipLabel: Record<RowChip, string> = {
  squash: t("commitGraph.edit.chip.squash"),
  fixup: t("commitGraph.edit.chip.fixup"),
  reword: t("commitGraph.edit.chip.reword"),
  drop: t("commitGraph.edit.chip.drop"),
  moved: t("commitGraph.edit.chip.moved"),
};

const chipTone: Record<RowChip, string> = {
  squash: "bg-warning-surface text-warning",
  fixup: "bg-warning-surface text-warning",
  reword: "bg-accent-surface text-accent",
  drop: "bg-danger-surface text-danger",
  moved: "border border-border text-text",
};

/** Inline summary field (R, Enter, double click): Enter or leaving the field applies, Escape cancels. */
function RewordField({ initial, onDone }: { initial: string; onDone: (summary: string | null, refocus: boolean) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (summary: string | null, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(summary, refocus);
  };
  return (
    <input
      data-edit-reword=""
      data-no-drag=""
      autoFocus
      aria-label={t("ui.editMessage")}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        // Ctrl+Enter commits the field and travels on to the view, which applies.
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          finish(value, true);
          return;
        }
        // Other keys belong to the field, not to the list around it.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null, true);
        }
      }}
      onBlur={() => finish(value, false)}
      className="h-control-sm min-w-0 flex-1 rounded-sm border border-border-input bg-surface-sunken px-1.5 text-text outline-none focus:border-accent"
    />
  );
}

export function EditHistory({ repoId, tabId, edit, flat }: { repoId: Id; tabId: Id; edit: GraphEdit; flat: FlatGraph }) {
  const { plan, state } = edit;
  const rows = state.rows;
  const displayed = useMemo(() => [...rows].reverse(), [rows]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const busy = useBusy(busyKeys.history(repoId));
  const [applying, setApplying] = useState(false);
  const [rewording, setRewording] = useState<Sha | null>(null);

  // A drag on a graph row that opened the mode continues here; taken over once, then cleared.
  const [initialDrag] = useState(() => takenOverDrag(edit.drag, rows));
  const [active, setActive] = useState(
    () =>
      initialDrag?.index ??
      Math.max(
        0,
        displayed.findIndex((row) => row.sha === edit.entry),
      ),
  );
  useEffect(() => {
    if (graphEditOf(tabId)?.drag) updateGraphEdit(tabId, (current) => ({ ...current, drag: null }));
    if (viewMayTakeFocus()) listRef.current?.focus({ preventScroll: true });
  }, [tabId]);

  // The branch moved under the edit (not by our own apply): end it, nothing was applied.
  const fresh = useRebaseBranchPlan(repoId, edit.from).data;
  // Same commits: a push or a dependent branch made meanwhile still reaches the note and the apply.
  useEffect(() => {
    if (applying) return;
    if (staleAfter(edit, fresh)) {
      leaveGraphEdit(tabId, "stale");
      return;
    }
    const plan = refreshedPlan(edit, fresh);
    if (plan) updateGraphEdit(tabId, (current) => ({ ...current, plan }));
  }, [applying, edit, fresh, tabId]);
  const dirtyWorktree = fresh?.status === "refused" && fresh.reason === "dirty_worktree";

  const preview = useConflictPreview(repoId, {
    kind: "rebase",
    onto: plan.base,
    upstream: null,
    branch: null,
    commits: rows.filter((row) => row.action !== "drop").map((row) => row.sha),
  });
  const step = previewStep(preview, rows);
  const previewLine =
    preview.state === "checking"
      ? t("conflictPreview.checking")
      : preview.state === "done" && preview.result.status === "clean"
        ? t("commitGraph.edit.noConflicts")
        : step
          ? t("commitGraph.edit.conflictAt", step)
          : previewText(preview, shortSha);

  const changes = changeCount(state, plan.rows);
  const blocked = checkPlan(rows, plan.rows).blocked ?? (dirtyWorktree ? refusalTitle.dirty_worktree : null);
  const hidden = hiddenCount(flat.rows, new Set(plan.rows.map((row) => row.sha)), plan.base);
  const graphRow = (sha: Sha) => flat.rows[flat.indexByKey.get(sha) ?? -1];
  const baseRow = graphRow(plan.base);

  const update = (change: (current: EditState) => EditState) =>
    updateGraphEdit(tabId, (current) => ({ ...current, state: change(current.state) }));
  const focusList = () => {
    if (viewMayTakeFocus()) listRef.current?.focus({ preventScroll: true });
  };

  const apply = async () => {
    // Read the edit fresh: an inline field may have just applied its text on blur.
    const current = graphEditOf(tabId);
    if (!current || applying || busy) return;
    if (checkPlan(current.state.rows, current.plan.rows).blocked || dirtyWorktree) return;
    setApplying(true);
    try {
      const result = await applyRebasePlan(repoId, tabId, current.plan, payloadRows(current.state.rows), {
        updateRefs: current.updateRefs,
        askForPushed: false,
        label: t("commitGraph.edit.apply"),
      });
      if (result === "done" || result === "up_to_date") leaveGraphEdit(tabId);
      else if (result === "stale") leaveGraphEdit(tabId, "stale");
      else focusList();
    } finally {
      setApplying(false);
    }
  };

  const askEditMessage = async (sha: Sha) => {
    const list = graphEditOf(tabId)?.state.rows ?? rows;
    const index = list.findIndex((row) => row.sha === sha);
    const row = list[index];
    if (!row || (row.action !== "pick" && row.action !== "reword")) return;
    const group = hasOwnMessage(list, index) && row.action === "pick";
    // Only "Squash" rows add their message to a group's result; "Fixup" rows only add their changes.
    const members = group
      ? rowRoles(list)
          [index]!.squashed.map((position) => list[position]!)
          .filter((member) => member.action === "squash")
      : [];
    const start = row.message ? splitMessage(row.message) : combinedMessage([row, ...members]);
    const input = await askMessage({
      title: group ? t("rebase.interactive.resultTitle") : t("ui.editMessage"),
      description: group
        ? t("rebase.interactive.resultBody", { count: members.length + 1 })
        : t("rebase.interactive.rewordBody", { sha: shortSha(row.sha) }),
      summary: start.summary,
      body: start.description,
      confirmLabel: t("rebase.interactive.applyMessage"),
    });
    focusList();
    if (input) update((current) => editMessage(current, sha, joinMessage(input)));
  };

  const finishReword = (sha: Sha, summary: string | null, refocus: boolean) => {
    setRewording(null);
    if (summary?.trim()) update((current) => rewordSummary(current, sha, summary.trim()));
    if (refocus) focusList();
  };

  // Only once the menu is closed, so the field or the dialog gets focus.
  const afterMenu = (run: () => void) => () => window.requestAnimationFrame(() => window.setTimeout(run, 0));

  const rowMenu = (index: number): MenuEntry[] => {
    const row = displayed[index];
    if (!row) return [];
    return [
      ...ACTIONS.map((action) => ({
        label: actionInfo[action].label,
        hint: actionInfo[action].hint,
        shortcut: actionInfo[action].key,
        checked: row.action === action,
        danger: action === "drop",
        onSelect:
          action === "reword" ? afterMenu(() => setRewording(row.sha)) : () => update((current) => setRowAction(current, row.sha, action)),
      })),
      { type: "separator" },
      {
        label: t("commitGraph.edit.editMessage"),
        shortcut: "M",
        disabled: row.action !== "pick" && row.action !== "reword",
        onSelect: afterMenu(() => void askEditMessage(row.sha)),
      },
    ];
  };

  const onKey = (event: ReactKeyboardEvent, index: number) => {
    if (!keyBelongsToView(event.nativeEvent) || event.altKey) return false;
    const row = displayed[index];
    if (!row) return false;
    if (event.key === "Escape") {
      void confirmLeaveGraphEdit(tabId);
      return true;
    }
    if (event.key === "Delete") {
      update((current) => toggleDrop(current, row.sha));
      return true;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      openMenuAtElement(listRef.current?.querySelector(`[data-index="${index}"]`) ?? null, rowMenu(index));
      return true;
    }
    if (event.shiftKey) return false;
    if (event.key.toLowerCase() === "m") {
      void askEditMessage(row.sha);
      return true;
    }
    const action = actionForKey(event.key);
    if (!action) return false;
    if (action === "reword") setRewording(row.sha);
    else update((current) => setRowAction(current, row.sha, action));
    return true;
  };

  return (
    <section
      data-screen="graph-edit"
      aria-label={t("commitGraph.edit.title")}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        // Escape leaves from anywhere in the view (the bar's buttons too); the list handles its own first.
        if (event.key === "Escape" && !event.defaultPrevented && keyBelongsToView(event.nativeEvent)) {
          event.preventDefault();
          void confirmLeaveGraphEdit(tabId);
          return;
        }
        // Ctrl+Enter applies from anywhere in the view; consumed so "Commit" behind it does not fire.
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.defaultPrevented) return;
        event.preventDefault();
        void apply();
      }}
    >
      <div data-edit-bar="" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5 text-sm">
        <span data-edit-count="" aria-live="polite" className="shrink-0 font-medium text-text">
          {t("commitGraph.edit.changes", { count: changes })}
        </span>
        <span
          data-edit-preview=""
          aria-live="polite"
          className={cn("min-w-0 truncate", step ? "text-warning" : "text-text-muted")}
          title={previewLine ?? undefined}
        >
          {previewLine}
        </span>
        {plan.rewritesPushed ? (
          <span data-edit-pushed="" className="min-w-0 text-warning">
            {t("commitGraph.edit.pushed")}
          </span>
        ) : null}
        {plan.dependentBranches.length > 0 ? (
          <Checkbox
            label={t("preflight.updateRefs")}
            checked={edit.updateRefs}
            onCheckedChange={(updateRefs) => updateGraphEdit(tabId, (current) => ({ ...current, updateRefs }))}
            hint={t("preflight.updateRefsHint", { branches: plan.dependentBranches.join(", ") })}
          />
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" data-edit-discard="" onClick={() => void confirmLeaveGraphEdit(tabId)}>
            {t("commitGraph.edit.discard")}
          </Button>
          <Button size="sm" data-edit-open-tool="" onClick={() => openGraphEditInTool(tabId)}>
            {t("commitGraph.edit.openTool")}
          </Button>
          {dirtyWorktree ? (
            <Button size="sm" onClick={() => void stashChanges(repoId)}>
              {t("ui.stashChanges")}
            </Button>
          ) : null}
          {/* View-local on purpose: the chord is wip.commit's, and this view consumes it (preventDefault) while it is shown. */}
          <Tip label={blocked ?? t("commitGraph.edit.apply")} shortcut={blocked ? undefined : "Mod+Enter"}>
            <Button
              size="sm"
              variant="primary"
              data-edit-apply=""
              loading={applying || busy}
              data-blocked={blocked ? "" : undefined}
              {...(blocked ? { "aria-disabled": true, "aria-description": blocked } : {})}
              className="data-[blocked]:cursor-default data-[blocked]:bg-surface-raised data-[blocked]:text-text-disabled data-[blocked]:hover:brightness-100"
              onClick={() => void apply()}
            >
              {t("commitGraph.edit.apply")}
            </Button>
          </Tip>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ReorderList
          listRef={listRef}
          count={displayed.length}
          getKey={(index) => displayed[index]!.sha}
          active={active}
          onActiveChange={setActive}
          ariaLabel={t("commitGraph.edit.title")}
          reorderable
          onMove={(from, to) => update((current) => moveDisplayed(current, from, to))}
          onDropOn={(from, onto, alt) => {
            const sha = displayed[from]?.sha;
            const target = displayed[onto]?.sha;
            if (!sha || !target) return;
            update((current) => squashOnto(current, sha, target, alt));
            // The folded row moved below its target: keep it active.
            const next = graphEditOf(tabId)?.state.rows ?? [];
            setActive(
              flipIndex(
                next.length,
                next.findIndex((row) => row.sha === sha),
              ),
            );
          }}
          initialDrag={initialDrag}
          onKey={onKey}
          onActivate={(index) => setRewording(displayed[index]?.sha ?? null)}
          dragLabel={(index) => shownSummary(displayed[index]!)}
          rowLabel={(index) => {
            const row = displayed[index]!;
            const chip = rowChip(state, plan.rows, row.sha);
            return `${chip ? `${chipLabel[chip]}: ` : ""}${shownSummary(row)}, ${row.author.name}`;
          }}
          renderRow={(index) => {
            const row = displayed[index]!;
            const chip = rowChip(state, plan.rows, row.sha);
            const lane = graphRow(row.sha);
            const summary = shownSummary(row);
            return (
              <div
                data-edit-row={row.sha}
                className="flex min-w-0 flex-1 items-center gap-2 px-3"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setActive(index);
                  openMenuAt({ x: event.clientX, y: event.clientY }, rowMenu(index));
                }}
              >
                <span aria-hidden className="flex w-6 shrink-0 justify-center">
                  <span
                    className="size-2 rounded-full bg-text-muted"
                    style={lane ? { backgroundColor: laneColor(lane.color) } : undefined}
                  />
                </span>
                <span className="flex w-20 shrink-0">
                  {chip ? (
                    <span data-chip={chip} className={cn("rounded-sm px-1.5 text-xs font-medium", chipTone[chip])}>
                      {chipLabel[chip]}
                    </span>
                  ) : null}
                </span>
                {rewording === row.sha ? (
                  <RewordField initial={summary} onDone={(text, refocus) => finishReword(row.sha, text, refocus)} />
                ) : (
                  <span
                    className={cn("min-w-0 flex-1 truncate", row.action === "drop" ? "text-text-muted line-through" : "text-text")}
                    title={summary}
                  >
                    {summary}
                  </span>
                )}
                <span className="w-40 shrink-0 truncate text-text-muted">{row.author.name}</span>
                <span className="w-16 shrink-0 font-mono text-code text-text-muted">{shortSha(row.sha)}</span>
              </div>
            );
          }}
        />
      </div>
      {hidden > 0 ? (
        <div data-edit-hidden="" className="border-t border-border px-3 py-1 text-sm text-text-muted">
          {t("commitGraph.edit.hidden", { count: hidden })}
        </div>
      ) : null}
      <div data-edit-base="" className="flex h-graph-row shrink-0 items-center gap-2 border-t border-border px-3 text-text-muted">
        <span aria-hidden className="flex w-6 shrink-0 justify-center">
          <span className="size-2 rounded-full bg-text-muted" style={baseRow ? { backgroundColor: laneColor(baseRow.color) } : undefined} />
        </span>
        <span className="w-20 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{baseRow?.summary ?? ""}</span>
        <span className="w-16 shrink-0 font-mono text-code">{shortSha(plan.base)}</span>
      </div>
    </section>
  );
}
