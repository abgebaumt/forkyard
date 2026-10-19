/**
 * "Compose commits" (v1.2, Teilpaket 3.2) in the centre of the repo tab: the local changes since
 * HEAD as units (hunks, whole files), "Don't commit" on top, below the commits in the order they
 * will be created. The AI provider suggests the grouping; the user moves units by keyboard
 * (↑/↓, Alt+↑/↓, 1–9, 0, Mod+↑/↓, F2) or by dragging and creates every commit at once (Mod+Enter)
 * under one undo entry. A suggestion never replaces an arrangement the user already changed, and
 * an answer that arrives later never moves the focus.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { core, type AiPreview, type AiStatus, type ComposeState, type ComposeUnit, type Id } from "../../core";
import { confirmSend } from "../../app/ai/gate";
import { showAiPreview } from "../../app/ai/PreviewDialog";
import { openAiSetup } from "../../app/ai/open";
import { errorView, loadingView, type AiErrorView } from "../../app/ai/requestState";
import { aiVisibility } from "../../app/ai/visibility";
import { undo } from "../../app/actions/undo";
import { confirm, hasOpenDialog } from "../../app/dialogs";
import { describeError, toCoreError } from "../../app/errors";
import { hasOpenMenu } from "../../app/menus/host";
import { qk, queryClient, useAiStatus, useRepoSettings } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { setCenterGuard, useAppStore, type CenterGuard } from "../../app/store";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { Button } from "../../ui/Button";
import { DiffHunk, type DiffLine as UiDiffLine } from "../../ui/Diff";
import { Banner, EmptyState, toast } from "../../ui/Feedback";
import { Checkbox, TextArea, TextField } from "../../ui/Field";
import { isMacShortcuts } from "../../ui/shortcut";
import { cn } from "../../ui/cn";
import { locale, t } from "../../i18n";
import { ReorderList } from "../RebaseTool/ReorderList";
import { SkeletonRows, StartButton, ToolFooter, ToolHeader } from "../RebaseTool/parts";
import { useWipTab } from "../WipPanel/state";
import { closeCompose, composeVisible } from "./actions";
import { RequestError } from "./RequestError";
import {
  SKIP,
  addCommit,
  blockedReason,
  dropRow,
  fromGroups,
  keyAction,
  moveCommit,
  moveUnit,
  orderOf,
  planOf,
  progressOf,
  refreshed,
  rowsOf,
  sameArrangement,
  setMessage,
  stepUnit,
  unitDetail,
  type Arrangement,
  type Row,
} from "./model";

type Request =
  | { kind: "idle" }
  | { kind: "loading"; jobId: string; startedAt: number; atStart: Arrangement }
  | { kind: "failed"; error: AiErrorView }
  | { kind: "ready"; proposal: Arrangement }
  | { kind: "done"; enough: boolean };

const EMPTY: Arrangement = { skip: [], commits: [] };

function toUiLines(unit: ComposeUnit): UiDiffLine[] {
  return unit.lines.map((line) => ({ kind: line.kind, oldNo: line.oldNo ?? undefined, newNo: line.newNo ?? undefined, segments: [{ text: line.text }] }));
}

function groupName(group: number): string {
  return group === SKIP ? t("wip.compose.skip") : t("wip.compose.commit", { number: group + 1 });
}

function rowLabel(row: Row, arrangement: Arrangement, units: Map<string, ComposeUnit>): string {
  if (row.kind === "group") {
    const commit = row.group === SKIP ? null : arrangement.commits[row.group];
    const count = commit ? commit.units.length : arrangement.skip.length;
    const title = commit ? commit.title.trim() || t("wip.compose.untitled") : "";
    return [groupName(row.group), title, t("wip.compose.units", { count })].filter(Boolean).join(", ");
  }
  const unit = units.get(row.unit);
  return unit ? `${unit.path}, ${unitDetail(unit)}, ${t("wip.compose.inGroup", { group: groupName(row.group) })}` : row.unit;
}

function RowView({ row, arrangement, units, draft }: { row: Row; arrangement: Arrangement; units: Map<string, ComposeUnit>; draft: boolean }) {
  if (row.kind === "group") {
    if (row.group === SKIP) {
      return (
        <div data-compose-group="skip" className="flex min-w-0 flex-1 items-center gap-2 px-3 text-sm font-semibold text-text-muted">
          <span className="truncate">{t("wip.compose.skip")}</span>
          <span className="ml-auto shrink-0 font-normal">{t("wip.compose.units", { count: arrangement.skip.length })}</span>
        </div>
      );
    }
    const commit = arrangement.commits[row.group];
    if (!commit) return null;
    const title = commit.title.trim();
    return (
      <div data-compose-group={String(row.group)} className="flex min-w-0 flex-1 items-center gap-2 px-3 text-sm">
        <span className="shrink-0 font-semibold text-text">{t("wip.compose.commit", { number: row.group + 1 })}</span>
        <span data-compose-commit-title="" className={cn("min-w-0 truncate", title ? "text-text" : "text-text-muted")}>
          {title || t("wip.compose.untitled")}
        </span>
        {draft ? <span className="shrink-0 text-xs text-text-muted">{t("ai.suggestion.draft")}</span> : null}
        <span className="ml-auto shrink-0 text-text-muted">{t("wip.compose.units", { count: commit.units.length })}</span>
      </div>
    );
  }
  const unit = units.get(row.unit);
  if (!unit) return null;
  return (
    <div data-compose-unit="" data-path={unit.path} data-group={row.group === SKIP ? "skip" : String(row.group)} className="flex min-w-0 flex-1 items-center gap-2 pr-3 pl-8 text-sm">
      <span className="min-w-0 truncate font-mono text-code text-text">{unit.path}</span>
      <span className="shrink-0 truncate text-text-muted">{unitDetail(unit)}</span>
      <span className="ml-auto shrink-0 font-mono text-code text-text-muted">{t("wip.compose.lines", { added: unit.added, removed: unit.removed })}</span>
    </div>
  );
}

function Side({ row, arrangement, units, onMessage }: { row: Row | undefined; arrangement: Arrangement; units: Map<string, ComposeUnit>; onMessage: (index: number, title: string, body: string) => void }) {
  if (!row) return null;
  if (row.kind === "group") {
    if (row.group === SKIP) return <p className="m-0 text-sm text-text-muted">{t("wip.compose.skipHint")}</p>;
    const commit = arrangement.commits[row.group];
    if (!commit) return null;
    return (
      <div className="flex flex-col gap-3" data-compose-message="">
        <TextField label={t("wip.compose.titleLabel")} data-compose-title="" value={commit.title} onChange={(event) => onMessage(row.group, event.target.value, commit.body)} />
        <TextArea label={t("wip.compose.bodyLabel")} rows={6} value={commit.body} onChange={(event) => onMessage(row.group, commit.title, event.target.value)} />
      </div>
    );
  }
  const unit = units.get(row.unit);
  if (!unit) return null;
  return (
    <div className="flex flex-col gap-2" data-compose-hunk="">
      <p className="m-0 font-mono text-code break-all text-text">{unit.path}</p>
      {unit.lines.length > 0 ? <DiffHunk header={unit.header || unitDetail(unit)} lines={toUiLines(unit)} /> : <p className="m-0 text-sm text-text-muted">{unitDetail(unit)}</p>}
      {unit.linesCut ? <p className="m-0 text-sm text-text-muted">{t("wip.compose.cut", { count: unit.lines.length })}</p> : null}
    </div>
  );
}

export function ComposeView({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const root = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusedOnce = useRef(false);
  const wip = useWipTab(tabId);
  const { data: aiStatus } = useAiStatus();
  const { data: repoSettings } = useRepoSettings(repoId);
  const [state, setState] = useState<ComposeState | null>(null);
  const stateRef = useRef<ComposeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [arrangement, setArrangement] = useState<Arrangement>(EMPTY);
  const arrangementRef = useRef<Arrangement>(EMPTY);
  const dirty = useRef(false);
  const [draft, setDraft] = useState(false);
  const [active, setActive] = useState(0);
  const [request, setRequestState] = useState<Request>({ kind: "idle" });
  const requestRef = useRef<Request>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const [outdated, setOutdated] = useState(false);
  const [skipHooks, setSkipHooks] = useState(wip.skipHooks);
  const [applying, setApplying] = useState<string | null>(null);
  const applyingRef = useRef(false);
  const progressLine = useAppStore((store) => (applying ? store.jobs[applying]?.line : undefined));

  const order = useMemo(() => orderOf(state?.units ?? []), [state]);
  const units = useMemo(() => new Map((state?.units ?? []).map((unit) => [unit.id, unit])), [state]);
  const rows = useMemo(() => rowsOf(arrangement), [arrangement]);

  const setRequest = (next: Request) => {
    requestRef.current = next;
    setRequestState(next);
  };
  const show = (next: ComposeState) => {
    stateRef.current = next;
    setState(next);
  };
  /** `byUser`: unsaved work from now on, and the "draft" mark ends. */
  const arrange = (next: Arrangement, byUser: boolean) => {
    arrangementRef.current = next;
    setArrangement(next);
    if (byUser) {
      dirty.current = true;
      setDraft(false);
    }
  };

  const load = async (): Promise<ComposeState | null> => {
    try {
      const next = await core.composeUnits({ repoId });
      show(next);
      setOutdated(false);
      setLoadError(null);
      arrange(refreshed(arrangementRef.current, next.units), false);
      return next;
    } catch (error) {
      setLoadError(describeError(toCoreError(error)).text);
      return null;
    }
  };

  const propose = async () => {
    if (requestRef.current.kind === "loading") return;
    if (aiVisibility(queryClient.getQueryData<AiStatus>(qk.aiStatus)).elementsOpenSetup) {
      void openAiSetup();
      return;
    }
    let preview: AiPreview;
    try {
      preview = await core.aiPreview({ repoId, feature: "compose", input: { kind: "compose" }, locale: locale() });
    } catch (error) {
      setRequest({ kind: "failed", error: errorView(error) });
      return;
    }
    if (!(await confirmSend(repoId, "compose", preview))) {
      setRequest({ kind: "idle" });
      return;
    }
    const jobId = newJobId();
    setRequest({ kind: "loading", jobId, startedAt: Date.now(), atStart: arrangementRef.current });
    try {
      const proposal = await core.composeProposal({ repoId, jobId, locale: locale() });
      // Read back through a widened type: the await may have changed it.
      const current = requestRef.current as Request;
      // Cancelled or replaced meanwhile: the answer is dropped – there are no half results.
      if (current.kind !== "loading" || current.jobId !== jobId) return;
      const untouched = sameArrangement(arrangementRef.current, current.atStart);
      show(proposal.state);
      const proposed = fromGroups(proposal.state.units, proposal.groups);
      if (untouched) {
        arrange(proposed, false);
        dirty.current = false;
        setDraft(true);
        setRequest({ kind: "done", enough: proposal.groups.length === 1 });
      } else {
        arrange(refreshed(arrangementRef.current, proposal.state.units), false);
        setRequest({ kind: "ready", proposal: proposed });
      }
    } catch (error) {
      const current = requestRef.current as Request;
      if (current.kind !== "loading" || current.jobId !== jobId) return;
      const view = errorView(error);
      setRequest(view.kind === "cancelled" ? { kind: "idle" } : { kind: "failed", error: view });
    }
  };

  const cancelRequest = () => {
    const current = requestRef.current;
    if (current.kind !== "loading") return;
    setRequest({ kind: "idle" });
    void core.jobCancel({ jobId: current.jobId });
  };

  const whatIsSent = async () => {
    const result = await runAction(t("ai.preview.loading"), () => core.aiPreview({ repoId, feature: "compose", input: { kind: "compose" }, locale: locale() }));
    if (result.ok) await showAiPreview(result.value, "look");
  };

  const apply = async () => {
    const current = stateRef.current;
    if (!current || applyingRef.current || blockedReason(arrangementRef.current)) return;
    const commits = planOf(arrangementRef.current);
    const jobId = newJobId();
    applyingRef.current = true;
    setApplying(jobId);
    const result = await runAction(
      t("wip.compose.applyAction"),
      () => core.composeApply({ repoId, jobId, plan: { commits, skipHooks }, expectToken: current.token }),
      { busyKey: `${repoId}:compose`, job: { id: jobId, title: t("wip.compose.title"), repoId } },
    );
    applyingRef.current = false;
    setApplying(null);
    if (!result.ok) {
      if (result.error.code === "stale_state") setOutdated(true);
      return;
    }
    dirty.current = false;
    toast({
      tone: "success",
      title: t("wip.compose.created", { count: result.value.commits.length }),
      description: t("wip.compose.undoHint"),
      action: { label: t("wip.compose.undo"), onClick: () => void undo(repoId) },
    });
    closeCompose(tabId);
  };

  // Open: read the changes, then ask for a suggestion right away (the click on "Compose …" is the request).
  useEffect(() => {
    let alive = true;
    void load().then((next) => {
      if (alive && next && next.units.length > 0) void propose();
    });
    return () => {
      alive = false;
      const current = requestRef.current;
      if (current.kind === "loading") void core.jobCancel({ jobId: current.jobId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  useEffect(() => {
    if (request.kind !== "loading") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [request.kind]);

  // Changes from outside (terminal, editor, the Commit Panel): offer to read them again.
  useEffect(() => {
    const stop = core.on("repo:changed", ({ repoId: changed, what }) => {
      if (changed !== repoId || applyingRef.current) return;
      if (what.some((part) => part === "worktree" || part === "index" || part === "head")) setOutdated(true);
    });
    return () => stop();
  }, [repoId]);

  // Grundregel 1: AI switched off (globally, for compose or for this repository) – the view goes away.
  const visible = composeVisible(aiStatus, repoSettings);
  useEffect(() => {
    if (aiStatus && repoSettings && !visible) {
      dirty.current = false;
      closeCompose(tabId);
    }
  }, [aiStatus, repoSettings, visible, tabId]);

  useEffect(() => {
    const guard: CenterGuard = {
      dirty: () => dirty.current && !applyingRef.current,
      confirmLeave: () => confirm({ title: t("wip.compose.leave.title"), body: t("wip.compose.leave.body"), confirmLabel: t("wip.compose.leave.confirm"), danger: true }),
    };
    setCenterGuard(tabId, guard);
    return () => setCenterGuard(tabId, null, guard);
  }, [tabId]);

  // Keyboard first: once the units are there, the list takes the focus – exactly once (the click
  // on "Compose …" asked for the view), and only while no dialog, menu or overlay is open. The
  // suggestion that arrives later never moves the focus.
  useEffect(() => {
    if (focusedOnce.current || !state || state.units.length === 0) return;
    focusedOnce.current = true;
    if (viewMayTakeFocus()) listRef.current?.focus({ preventScroll: true });
  }, [state]);

  const activeRow: Row | undefined = rows[active];
  const activeGroup = activeRow?.group ?? SKIP;

  const follow = (next: Arrangement, unit: string) => {
    if (next === arrangementRef.current) return;
    arrange(next, true);
    const index = rowsOf(next).findIndex((row) => row.kind === "unit" && row.unit === unit);
    if (index >= 0) setActive(index);
  };

  const editMessage = (group: number) => {
    if (group === SKIP || !arrangementRef.current.commits[group]) return;
    const header = rowsOf(arrangementRef.current).findIndex((row) => row.kind === "group" && row.group === group);
    if (header >= 0) setActive(header);
    requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>("[data-compose-title]")?.focus());
  };

  /** Capture phase: Alt+↑/↓ must not reach the list's own reordering. */
  const onListKey = (event: ReactKeyboardEvent) => {
    const action = keyAction(event, isMacShortcuts());
    if (!action || !activeRow) return;
    const current = arrangementRef.current;
    switch (action.kind) {
      case "step":
        if (activeRow.kind === "unit") follow(stepUnit(current, activeRow.unit, action.delta, order), activeRow.unit);
        break;
      case "to":
        if (activeRow.kind === "unit") follow(moveUnit(current, activeRow.unit, action.group, order), activeRow.unit);
        break;
      case "moveCommit": {
        if (activeGroup === SKIP) break;
        const next = moveCommit(current, activeGroup, action.delta);
        if (next === current) break;
        arrange(next, true);
        const index =
          activeRow.kind === "unit"
            ? rowsOf(next).findIndex((row) => row.kind === "unit" && row.unit === activeRow.unit)
            : rowsOf(next).findIndex((row) => row.kind === "group" && row.group === activeGroup + action.delta);
        if (index >= 0) setActive(index);
        break;
      }
      case "edit":
        editMessage(activeGroup);
        break;
      case "apply":
        void apply();
        break;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  /** Esc closes, Mod+Enter creates – also from the message fields. */
  const onRootKey = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (hasOpenDialog() || hasOpenMenu() || root.current?.querySelector("[data-dragging]")) return;
      event.preventDefault();
      closeCompose(tabId);
      return;
    }
    if (keyAction(event, isMacShortcuts())?.kind === "apply") {
      event.preventDefault();
      void apply();
    }
  };

  const header = (
    <ToolHeader
      icon={<GitCommitHorizontal className="size-icon" aria-hidden />}
      title={t("wip.compose.title")}
      onClose={() => closeCompose(tabId)}
      subtitle={state ? <span className="min-w-0 truncate font-medium text-text">{state.branch}</span> : undefined}
    />
  );
  const shell = (body: ReactNode) => (
    <section ref={root} data-screen="compose" className="@container flex h-full min-w-0 flex-col bg-surface" onKeyDown={onRootKey}>
      {header}
      {body}
    </section>
  );

  if (loadError) return shell(<EmptyState title={t("wip.compose.loadFailed")}>{loadError}</EmptyState>);
  if (!state) return shell(<SkeletonRows />);
  if (state.units.length === 0) return shell(<EmptyState title={t("wip.compose.empty")} />);

  const loading = request.kind === "loading" ? loadingView(now - request.startedAt, aiStatus?.local ?? false, t("wip.compose.proposing")) : null;
  const progress = applying ? progressOf(progressLine) : null;
  const statusText = progress
    ? t("wip.compose.progress", progress)
    : loading
      ? [loading.text, loading.slow].filter(Boolean).join(" – ")
      : request.kind === "done" && request.enough
        ? t("wip.compose.enough")
        : draft
          ? t("wip.compose.draftHint")
          : "";
  const blocked = blockedReason(arrangement);
  const blockedText = !blocked ? null : blocked.reason === "nothing" ? t("wip.compose.nothingPlanned") : t("wip.compose.titleMissing", { number: blocked.commit + 1 });
  const planned = planOf(arrangement).length;
  const keys: [string, string][] = [
    ["Alt+↑ Alt+↓", t("wip.compose.keys.move")],
    ["1–9 0", t("wip.compose.keys.number")],
    ["Mod+↑ Mod+↓", t("wip.compose.keys.order")],
    ["F2", t("wip.compose.keys.edit")],
    ["Mod+Enter", t("wip.compose.keys.apply")],
  ];

  return shell(
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5">
        {request.kind === "loading" ? (
          <Button size="sm" variant="secondary" data-compose-cancel="" onClick={cancelRequest}>
            {t("ai.state.cancel")}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" data-compose-propose="" onClick={() => void propose()}>
            {t("wip.compose.propose")}
          </Button>
        )}
        <Button size="sm" variant="ghost" data-compose-what-is-sent="" onClick={() => void whatIsSent()}>
          {t("wip.compose.whatIsSent")}
        </Button>
        <p className="m-0 min-w-0 flex-1 truncate text-sm text-text-muted" aria-live="polite" data-compose-status="">
          {statusText}
        </p>
      </div>
      {request.kind === "failed" ? <RequestError error={request.error} provider={aiStatus?.provider ?? null} onAgain={() => void propose()} onShowSent={() => void whatIsSent()} /> : null}
      {request.kind === "ready" ? (
        <Banner
          tone="info"
          title={t("ai.suggestion.ready")}
          actions={
            <>
              <Button
                size="sm"
                onClick={() => {
                  arrange(request.proposal, false);
                  dirty.current = true;
                  setDraft(true);
                  setRequest({ kind: "done", enough: request.proposal.commits.length === 1 });
                }}
              >
                {t("wip.compose.readyApply")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRequest({ kind: "idle" })}>
                {t("ai.suggestion.discard")}
              </Button>
            </>
          }
        />
      ) : null}
      {state.signing ? <Banner tone="info" title={t("wip.compose.signing", { count: Math.max(planned, 1) })} /> : null}
      {outdated ? (
        <Banner
          tone="warning"
          title={t("wip.compose.outdated")}
          actions={
            <Button size="sm" onClick={() => void load()}>
              {t("wip.compose.reload")}
            </Button>
          }
        >
          {t("wip.compose.outdatedHint")}
        </Banner>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-border" onKeyDownCapture={onListKey}>
          <ReorderList
            count={rows.length}
            getKey={(index) => rows[index]?.key ?? String(index)}
            active={active}
            onActiveChange={setActive}
            ariaLabel={t("wip.compose.list")}
            listRef={listRef}
            reorderable
            onMove={(from, to) => {
              const row = rows[from];
              if (row?.kind === "unit") follow(dropRow(arrangementRef.current, rows, from, to, order), row.unit);
            }}
            renderRow={(index) => <RowView row={rows[index]!} arrangement={arrangement} units={units} draft={draft} />}
            rowLabel={(index) => rowLabel(rows[index]!, arrangement, units)}
            dragLabel={(index) => {
              const row = rows[index];
              return row?.kind === "unit" ? (units.get(row.unit)?.path ?? "") : "";
            }}
          />
        </div>
        <aside className="flex w-2/5 min-w-0 flex-col gap-2 overflow-auto p-3">
          <Side row={activeRow} arrangement={arrangement} units={units} onMessage={(index, title, body) => arrange(setMessage(arrangementRef.current, index, title, body), true)} />
        </aside>
      </div>
      <ToolFooter info={t("wip.compose.undoHint")} keys={keys}>
        <Checkbox label={t("wip.form.skipHooks")} checked={skipHooks} onCheckedChange={setSkipHooks} />
        <Button variant="secondary" data-compose-add="" onClick={() => arrange(addCommit(arrangementRef.current), true)}>
          {t("wip.compose.addCommit")}
        </Button>
        {applying ? (
          <Button variant="ghost" onClick={() => void core.jobCancel({ jobId: applying })}>
            {t("ai.state.cancel")}
          </Button>
        ) : null}
        <StartButton
          action="compose-apply"
          label={t("wip.compose.apply", { count: Math.max(planned, 1) })}
          blocked={blockedText}
          loading={Boolean(applying)}
          icon={<GitCommitHorizontal className="size-icon" aria-hidden />}
          onClick={() => void apply()}
        />
      </ToolFooter>
    </>,
  );
}
