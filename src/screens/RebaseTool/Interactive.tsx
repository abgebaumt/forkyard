/**
 * Interactive rebase: reorder, reword, squash and drop commits between base and HEAD. The plan
 * comes from `rebase_plan` and is executed with `rebase_apply`.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ChevronDown, CornerDownRight, GripVertical, ListOrdered, MessageSquareText, Milestone, Pencil, Play, RotateCcw } from "lucide-react";
import { core, type Id, type PreviewOp, type RebaseAction, type RebasePlan, type RebasePlanRow } from "../../core";
import { askMessage } from "../../app/actionDialogs";
import { useConflictPreview } from "../../app/conflictPreview";
import { ConflictPreviewNote } from "../../components/ConflictPreviewNote";
import { confirm } from "../../app/dialogs";
import { toCoreError } from "../../app/errors";
import { busyKeys } from "../../app/actions/keys";
import { rebaseOnto, reportOpResult } from "../../app/actions/merge";
import { stashChanges } from "../../app/actions/stash";
import { shortSha } from "../../app/format";
import { openMenuAtElement } from "../../app/menus";
import { useRebasePlan, useSettings } from "../../app/queries";
import { runAction } from "../../app/run";
import { withFreshStatus } from "../../app/statusCache";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner, toast } from "../../ui/Feedback";
import type { MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import {
  ACTIONS,
  actionForKey,
  actionInfo,
  checkPlan,
  combinedMessage,
  isShaLike,
  joinMessage,
  moveItem,
  payloadRows,
  planChanged,
  planSummary,
  resultCount,
  rowRoles,
  shownSummary,
  splitMessage,
} from "./model";
import { ColumnBar, CommitCells, LoadError, Name, SkeletonRows, StartButton, StatePanel, ToolFooter, ToolHeader, type StartRef } from "./parts";
import { ReorderList } from "./ReorderList";
import { t } from "../../i18n";

const pillTone: Record<RebaseAction, string> = {
  pick: "border-border-input text-text",
  reword: "border-accent bg-accent-surface text-accent",
  squash: "border-warning bg-warning-surface text-warning",
  drop: "border-danger bg-danger-surface text-danger",
};

type Refusal = Extract<RebasePlan, { status: "refused" }>;

const refusalTitle: Record<Refusal["reason"], string> = {
  merge_commits: t("rebase.refused.mergeCommits"),
  no_common_ancestor: t("rebase.refused.noCommonAncestor"),
  nothing_to_rebase: t("rebase.refused.nothingToRebase"),
  dirty_worktree: t("rebase.refused.dirtyWorktree"),
  detached: t("rebase.refused.detached"),
  operation_in_progress: t("rebase.refused.operationInProgress"),
};

interface Notice {
  tone: "info" | "warning";
  title: string;
  text: string;
}

const signature = (plan: Extract<RebasePlan, { status: "ok" }>) => `${plan.base}:${plan.rows.map((row) => row.sha).join(",")}`;

/**
 * Prompt before starting if the plan costs something: commits fall out of the branch, or commits
 * that are already on a remote get rewritten. A plan that only reorders, rewords or squashes
 * local commits starts without a prompt.
 */
async function confirmRewrite(plan: Extract<RebasePlan, { status: "ok" }>, rows: RebasePlanRow[]): Promise<boolean> {
  const dropped = rows.filter((row) => row.action === "drop");
  if (!plan.rewritesPushed && dropped.length === 0) return true;
  const sentences: string[] = [];
  if (dropped.length) {
    sentences.push(t("rebase.confirm.dropped", { count: dropped.length, branch: plan.branch }));
  }
  if (plan.rewritesPushed) {
    sentences.push(t("rebase.confirm.pushed"));
  }
  sentences.push(t("rebase.confirm.undo"));
  return confirm({
    title: dropped.length ? t("rebase.confirm.dropTitle", { count: dropped.length }) : t("rebase.confirm.pushedTitle", { branch: plan.branch }),
    body: sentences.join(" "),
    details: dropped.map((row) => `${shortSha(row.sha)}  ${row.summary}`),
    detailsLabel: dropped.length ? t("rebase.confirm.droppedLabel") : undefined,
    confirmLabel: t("rebase.interactive.start"),
    danger: true,
  });
}

export function InteractiveRebase({ repoId, tabId, base, onClose, startRef }: { repoId: Id; tabId: Id; base: string; onClose: () => void; startRef: StartRef }) {
  startRef.current = null;
  const planQuery = useRebasePlan(repoId, base);
  const { data: settings } = useSettings();
  const busy = useBusy(busyKeys.history(repoId));
  const plan = planQuery.data;
  const okPlan = plan?.status === "ok" ? plan : null;

  const [rows, setRows] = useState<RebasePlanRow[] | null>(null);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const loaded = useRef<string | null>(null);
  const forceReset = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Take over the plan – on first load and when the branch has changed. If the commits stay the
  // same (e.g. after a fetch), the edits stay.
  useEffect(() => {
    if (!okPlan) return;
    const next = signature(okPlan);
    if (loaded.current === next && !forceReset.current) return;
    if (loaded.current !== null && loaded.current !== next && !forceReset.current && rowsRef.current) {
      setNotice({
        tone: "info",
        title: t("rebase.interactive.reloadedTitle"),
        text: t("rebase.interactive.reloadedBody"),
      });
    }
    forceReset.current = false;
    loaded.current = next;
    setRows(okPlan.rows);
    setActive(0);
  }, [okPlan]);

  const original = okPlan?.rows ?? [];
  const current = rows ?? original;
  const roles = useMemo(() => rowRoles(current), [current]);
  const check = useMemo(() => checkPlan(current, original), [current, original]);
  const changed = planChanged(original, current);
  // Preview of exactly this plan: dropped rows are left out, the order counts.
  const previewOp = useMemo<PreviewOp | null>(
    () => (okPlan ? { kind: "rebase", onto: okPlan.base, upstream: null, branch: null, commits: current.filter((row) => row.action !== "drop").map((row) => row.sha) } : null),
    [okPlan, current],
  );
  const preview = useConflictPreview(repoId, previewOp);

  // A failed reload keeps the old plan in the cache; while the new attempt runs, the tool shows the
  // skeleton instead of briefly the earlier error.
  const loading = planQuery.isPending || (planQuery.isError && planQuery.isFetching);
  const failed = planQuery.isError && !planQuery.isFetching;

  // As soon as the list is really visible, focus belongs to it – the keyboard can start right away.
  const listShown = !loading && !failed && Boolean(okPlan) && Boolean(rows?.length);
  useEffect(() => {
    if (listShown) listRef.current?.focus({ preventScroll: true });
  }, [listShown]);

  const updateRow = (sha: string, patch: Partial<RebasePlanRow>) => setRows((list) => (list ?? original).map((row) => (row.sha === sha ? { ...row, ...patch } : row)));

  /** New message for "Reword" – in the dialog with summary and description. */
  const reword = async (sha: string) => {
    const row = rowsRef.current?.find((item) => item.sha === sha);
    if (!row) return;
    const start = row.message ? splitMessage(row.message) : { summary: row.summary, description: row.description };
    const input = await askMessage({
      title: t("rebase.interactive.rewordTitle"),
      description: t("rebase.interactive.rewordBody", { sha: shortSha(row.sha) }),
      summary: start.summary,
      body: start.description,
      confirmLabel: t("rebase.interactive.applyMessage"),
    });
    listRef.current?.focus({ preventScroll: true });
    if (!input) return;
    const message = joinMessage(input);
    const unchanged = message === joinMessage({ summary: row.summary, description: row.description });
    // Same message as before: then it is not a reword but a pick.
    updateRow(sha, unchanged ? { action: "pick", message: null } : { action: "reword", message });
  };

  /** Message of the commit that results from a group (target plus the squashed ones below it). */
  const editResultMessage = async (index: number) => {
    const list = rowsRef.current;
    const root = list?.[index];
    if (!list || !root) return;
    const members = rowRoles(list)[index]!.squashed.map((position) => list[position]!);
    const start = root.message
      ? splitMessage(root.message)
      : combinedMessage([{ summary: root.summary, description: root.description }, ...members.map((row) => ({ summary: row.summary, description: row.description }))]);
    const input = await askMessage({
      title: t("rebase.interactive.resultTitle"),
      description: t("rebase.interactive.resultBody", { count: members.length + 1 }),
      summary: start.summary,
      body: start.description,
      confirmLabel: t("rebase.interactive.applyMessage"),
    });
    listRef.current?.focus({ preventScroll: true });
    if (input) updateRow(root.sha, { message: joinMessage(input) });
  };

  const setAction = (index: number, action: RebaseAction) => {
    const row = rowsRef.current?.[index];
    if (!row) return;
    if (action === "reword") {
      void reword(row.sha);
      return;
    }
    // The new message from "Reword" only belongs to it; as a pick row with a group it keeps the result message.
    updateRow(row.sha, { action, message: action === "pick" && row.action === "pick" ? row.message : null });
  };

  const actionMenu = (index: number): MenuEntry[] => {
    const row = current[index];
    if (!row) return [];
    return [
      { type: "label", label: t("rebase.interactive.actionForCommit") },
      ...ACTIONS.map((action) => ({
        label: actionInfo[action].label,
        hint: actionInfo[action].hint,
        shortcut: actionInfo[action].key,
        checked: row.action === action,
        danger: action === "drop",
        // Only once the menu is closed, so the "Reword" dialog gets focus.
        onSelect: () => window.requestAnimationFrame(() => window.setTimeout(() => setAction(index, action), 0)),
      })),
    ];
  };

  const openActionMenu = (index: number) => {
    const element = listRef.current?.querySelector(`[data-index="${index}"] [data-action-pill]`) ?? listRef.current?.querySelector(`[data-index="${index}"]`) ?? null;
    openMenuAtElement(element, actionMenu(index), t("rebase.interactive.chooseAction"));
  };

  const onKey = (event: KeyboardEvent, index: number) => {
    if (event.altKey) return false;
    const action = event.shiftKey ? null : actionForKey(event.key);
    if (action) {
      setAction(index, action);
      return true;
    }
    if (event.key === " " || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      openActionMenu(index);
      return true;
    }
    return false;
  };

  const activate = (index: number) => {
    const row = current[index];
    if (!row) return;
    if (row.action === "reword") void reword(row.sha);
    else if (roles[index]?.squashed.length) void editResultMessage(index);
    else openActionMenu(index);
  };

  const reset = () => {
    setRows(original);
    setActive(0);
    setNotice(null);
    listRef.current?.focus({ preventScroll: true });
  };

  const start = async () => {
    if (!okPlan || check.blocked) return;
    // After "Cancel" focus returns to where it was (list or start button); the plan stays.
    if (!(await confirmRewrite(okPlan, current))) return;
    const result = await runAction(t("rebase.tool.interactive"), withFreshStatus(repoId, () => core.rebaseApply({ repoId, base: okPlan.base, rows: payloadRows(current) })), {
      busyKey: busyKeys.history(repoId),
      quiet: ["stale_state"],
    });
    if (!result.ok) {
      if (result.error.code === "stale_state") {
        setNotice({
          tone: "warning",
          title: t("rebase.interactive.staleTitle"),
          text: t("rebase.interactive.staleBody"),
        });
        forceReset.current = true;
        void planQuery.refetch();
      }
      return;
    }
    if (result.value.status === "up_to_date") {
      toast({ tone: "info", title: t("rebase.interactive.upToDateTitle"), description: t("rebase.interactive.upToDateBody") });
      return;
    }
    onClose();
    reportOpResult(t("rebase.tool.interactive"), result.value, tabId, { reveal: true });
  };

  // --- Header -----------------------------------------------------------------------------------
  const baseLabel = okPlan ? (isShaLike(base) ? shortSha(okPlan.base) : base) : isShaLike(base) ? shortSha(base) : base;
  const header = (
    <ToolHeader
      icon={<ListOrdered className="size-icon" aria-hidden />}
      title={t("rebase.tool.interactive")}
      onClose={onClose}
      subtitle={
        okPlan ? (
          <>
            <Name>{okPlan.branch}</Name>
            <span className="shrink-0">{t("rebase.interactive.onto")}</span>
            <Name mono={isShaLike(base)}>{baseLabel}</Name>
            {!isShaLike(base) ? <span className="shrink-0 font-mono text-code">{shortSha(okPlan.base)}</span> : null}
            <span className="shrink-0">· {t("rebase.commits", { count: okPlan.rows.length })}</span>
          </>
        ) : (
          <span className="truncate">{t("rebase.interactive.from", { base: baseLabel })}</span>
        )
      }
    />
  );

  // --- States -----------------------------------------------------------------------------------
  if (loading) {
    return (
      <>
        {header}
        <ColumnBar direction={t("rebase.direction.oldestTop")} lead={<span className="w-48 shrink-0 pl-8">{t("rebase.column.action")}</span>} />
        <SkeletonRows />
      </>
    );
  }
  if (failed) {
    return (
      <>
        {header}
        <LoadError error={toCoreError(planQuery.error)} icon={<ListOrdered className="size-8" aria-hidden />} onRetry={() => void planQuery.refetch()} onClose={onClose} />
      </>
    );
  }
  if (plan?.status === "refused") {
    const canRebaseFirst = plan.reason === "no_common_ancestor" && !isShaLike(base) && plan.detail === "not_ancestor";
    return (
      <>
        {header}
        <StatePanel
          state={`refused-${plan.reason}`}
          icon={<AlertTriangle className="size-8 text-warning" aria-hidden />}
          title={refusalTitle[plan.reason]}
          actions={
            <>
              <Button variant={canRebaseFirst || plan.reason === "dirty_worktree" ? "secondary" : "primary"} onClick={onClose}>
                {t("rebase.backToGraph")}
              </Button>
              {plan.reason === "dirty_worktree" ? (
                <Button
                  variant="primary"
                  onClick={async () => {
                    const result = await stashChanges(repoId);
                    if (result?.ok) void planQuery.refetch();
                  }}
                >
                  {t("rebase.interactive.stash")}
                </Button>
              ) : null}
              {canRebaseFirst ? (
                <Button
                  variant="primary"
                  icon={<Milestone className="size-icon" aria-hidden />}
                  onClick={async () => {
                    const result = await rebaseOnto(repoId, base, null, tabId);
                    if (result.ok && result.value.status !== "conflict") void planQuery.refetch();
                    else if (result.ok) onClose();
                  }}
                >
                  {t("rebase.interactive.rebaseFirst", { base })}
                </Button>
              ) : null}
            </>
          }
        >
          <p className="m-0">{plan.message}</p>
          {canRebaseFirst ? (
            <p className="m-0 mt-2">
              {t("rebase.interactive.rebaseFirstBody", { base })}
            </p>
          ) : null}
        </StatePanel>
      </>
    );
  }
  if (!okPlan || !rows) {
    return (
      <>
        {header}
        <SkeletonRows />
      </>
    );
  }

  startRef.current = () => void start();
  const after = resultCount(current);
  // The letters are already shown in every row next to the action – here only briefly what the keys do.
  const keys: [string, string][] = [
    ["P R S D", t("rebase.keys.action")],
    ["Alt+↑ Alt+↓", t("rebase.keys.move")],
    ["Enter", t("rebase.keys.message")],
    [t("rebase.keys.spaceKey"), t("rebase.keys.choose")],
    ["Mod+Enter", t("rebase.keys.start")],
  ];

  return (
    <>
      {header}
      {okPlan.rewritesPushed ? (
        <Banner tone="warning" title={t("rebase.interactive.pushedTitle")}>
          {t("rebase.interactive.pushedBody")}
        </Banner>
      ) : null}
      {notice ? (
        <Banner
          tone={notice.tone}
          title={notice.title}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
              {t("rebase.interactive.dismiss")}
            </Button>
          }
        >
          {notice.text}
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5" data-rebase-checks="">
        <ConflictPreviewNote preview={preview} />
      </div>
      <ColumnBar direction={t("rebase.direction.oldestTopNewestBottom")} lead={<span className="w-48 shrink-0 pl-8">{t("rebase.column.action")}</span>} />
      <div className="min-h-0 flex-1">
        <ReorderList
          listRef={listRef}
          count={current.length}
          getKey={(index) => current[index]!.sha}
          active={active}
          onActiveChange={setActive}
          ariaLabel={t("rebase.interactive.listLabel")}
          describedBy="s14-keys"
          reorderable
          onMove={(from, to) => setRows((list) => moveItem(list ?? original, from, to))}
          onKey={onKey}
          onActivate={activate}
          dragLabel={(index) => shownSummary(current[index]!)}
          rowLabel={(index) => {
            const row = current[index]!;
            const problem = check.rowProblems.get(index);
            return `${actionInfo[row.action].label}: ${shownSummary(row)}, ${row.author.name}, ${shortSha(row.sha)}${problem ? ` – ${problem}` : ""}`;
          }}
          renderRow={(index) => {
            const row = current[index]!;
            const role = roles[index]!;
            const problem = check.rowProblems.get(index);
            const target = role.target !== null ? current[role.target] : null;
            const isGroupRoot = role.squashed.length > 0;
            const hasOwnMessage = Boolean(row.message) && (row.action === "reword" || isGroupRoot);
            const summary = shownSummary(row);
            return (
              <div className="flex min-w-0 flex-1 items-center gap-2 pr-3" data-action={row.action}>
                <span aria-hidden className="flex w-6 shrink-0 cursor-grab justify-center text-text-muted" title={t("rebase.dragToReorder")}>
                  <GripVertical className="size-icon" />
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  data-no-drag=""
                  data-action-pill=""
                  aria-haspopup="menu"
                  aria-label={t("rebase.interactive.pillLabel", { action: actionInfo[row.action].label })}
                  title={`${actionInfo[row.action].label}: ${actionInfo[row.action].hint}`}
                  onClick={(event) => {
                    setActive(index);
                    // Below the selection, not below the pointer: that keeps the row readable.
                    openMenuAtElement(event.currentTarget, actionMenu(index), t("rebase.interactive.chooseAction"));
                  }}
                  className={cn("flex h-5 w-40 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 text-sm font-medium", pillTone[row.action])}
                >
                  <span className="w-3 shrink-0 text-center font-mono text-xs">{actionInfo[row.action].key}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{actionInfo[row.action].label}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
                </button>
                <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", row.action === "squash" && "pl-5")}>
                  {row.action === "squash" ? (
                    <Tip label={target ? t("rebase.interactive.squashInto", { summary: shownSummary(target) }) : t("rebase.interactive.noTarget")}>
                      <CornerDownRight className={cn("size-icon shrink-0", target ? "text-warning" : "text-danger")} aria-hidden />
                    </Tip>
                  ) : null}
                  <span
                    className={cn("min-w-0 truncate", row.action === "drop" ? "text-text-muted line-through opacity-60" : row.action === "squash" ? "text-text-muted" : "text-text")}
                    title={summary !== row.summary ? t("rebase.interactive.previously", { summary: row.summary }) : summary}
                    data-summary=""
                  >
                    {summary}
                  </span>
                  {hasOwnMessage ? (
                    <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-text-muted" data-message-badge="">
                      {row.action === "reword" ? t("rebase.interactive.newMessage") : t("rebase.interactive.messageEdited")}
                    </span>
                  ) : null}
                  {isGroupRoot ? <span className="shrink-0 text-xs text-text-muted">+{role.squashed.length}</span> : null}
                </span>
                {problem ? (
                  <Tip label={problem}>
                    <AlertTriangle className="size-icon shrink-0 text-danger" aria-label={problem} data-row-problem="" />
                  </Tip>
                ) : null}
                {row.action === "reword" || isGroupRoot ? (
                  <Tip label={row.action === "reword" ? t("rebase.interactive.editMessage") : t("rebase.interactive.editResultMessage")} shortcut="Enter">
                    <button
                      type="button"
                      tabIndex={-1}
                      data-no-drag=""
                      aria-label={row.action === "reword" ? t("rebase.interactive.editMessage") : t("rebase.interactive.editResultMessage")}
                      onClick={() => {
                        setActive(index);
                        if (row.action === "reword") void reword(row.sha);
                        else void editResultMessage(index);
                      }}
                      className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-raised hover:text-text"
                    >
                      {row.action === "reword" ? <Pencil className="size-icon" aria-hidden /> : <MessageSquareText className="size-icon" aria-hidden />}
                    </button>
                  </Tip>
                ) : null}
                <CommitCells
                  authorName={row.author.name}
                  authorEmail={row.author.email}
                  authoredAt={row.authoredAt}
                  sha={row.sha}
                  dateFormat={settings?.dateFormat ?? "relative"}
                  dimmed={row.action === "drop"}
                />
              </div>
            );
          }}
        />
      </div>
      <span id="s14-keys" className="sr-only">
        {t("rebase.interactive.keysHelp")}
      </span>
      <ToolFooter
        keys={keys}
        info={
          check.blocked && changed ? (
            <span className="flex min-w-0 items-center gap-1.5 text-warning" role="status">
              <AlertTriangle className="size-icon shrink-0" aria-hidden />
              <span className="truncate" title={check.blocked}>
                {check.blocked}
              </span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5" role="status">
              <span className="shrink-0 font-medium">
                {t("rebase.commits", { count: current.length })} → {t("rebase.commits", { count: after })}
              </span>
              <span className="truncate text-text-muted">· {planSummary(original, current)}</span>
            </span>
          )
        }
      >
        <Tip label={changed ? t("rebase.interactive.resetTip") : t("rebase.interactive.nothingChanged")}>
          <Button
            icon={<RotateCcw className="size-icon" aria-hidden />}
            data-action="reset"
            {...(!changed ? { "aria-disabled": true } : {})}
            className={cn(!changed && "cursor-default text-text-disabled hover:border-border")}
            onClick={() => {
              if (changed) reset();
            }}
          >
            {t("rebase.interactive.reset")}
          </Button>
        </Tip>
        <Button variant="ghost" onClick={onClose}>
          {t("rebase.cancel")}
        </Button>
        <StartButton
          action="start"
          label={t("rebase.interactive.start")}
          blocked={check.blocked}
          loading={busy}
          icon={<Play className="size-icon" aria-hidden />}
          onClick={() => void start()}
        />
      </ToolFooter>
    </>
  );
}
