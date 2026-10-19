/**
 * "Compose commits" (v1.2, Teilpaket 3.2) in the centre of the repo tab: the local changes since
 * HEAD as units (hunks, whole files), grouped into the commits the AI provider proposes.
 *
 * On top the history as it will look afterwards; on the left the commits with inline messages,
 * reasons and the dependency check ("doesn't build on its own"), "Don't commit" at the end; on the
 * right the selected unit with the AI's reason and its diff; below an instruction for a new
 * proposal and "Create n commits". Keyboard: ↑/↓ choose, Shift+↑/↓ extend, 1–9 / 0 move, Alt+↑/↓
 * previous/next commit, N new commit from the selection, U next unsure, Enter confirm, F2 message,
 * Mod+↑/↓ reorder, Mod+Enter create. Units the user moved stay where they are in a new proposal; a
 * proposal that arrives later never moves the focus.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { core, type AiPreview, type AiStatus, type ComposeKeep, type ComposeNote, type ComposeState, type Id } from "../../core";
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
import { Banner, EmptyState } from "../../ui/Feedback";
import { Checkbox, SegmentedControl } from "../../ui/Field";
import { Kbd } from "../../ui/Kbd";
import { isMacShortcuts } from "../../ui/shortcut";
import { locale, t } from "../../i18n";
import { SkeletonRows, ToolHeader } from "../RebaseTool/parts";
import { useWipTab } from "../WipPanel/state";
import { closeCompose, composeVisible } from "./actions";
import { askBroken, showApply, type Settled } from "./ApplyDialog";
import { CommitList } from "./CommitList";
import { Detail } from "./Detail";
import { FileMatrix } from "./FileMatrix";
import { History } from "./History";
import { RequestError } from "./RequestError";
import {
  SKIP,
  blockedReason,
  commitProblems,
  displayOrder,
  emptySelection,
  extendSelection,
  firstProblem,
  fromProposal,
  groupOf,
  keepOf,
  keyAction,
  mergeWithNext,
  moveCommit,
  moveUnits,
  nextUnsure,
  notesOf,
  orderOf,
  planOf,
  rangeSelection,
  refreshed,
  reproposed,
  selectOne,
  setTitle,
  splitPath,
  stepTarget,
  summaryOf,
  toggleSelection,
  unsureUnits,
  type Arrangement,
  type Review,
  type Selection,
} from "./model";

type Request =
  | { kind: "idle" }
  | { kind: "loading"; jobId: string; startedAt: number; instruction: string | null }
  | { kind: "failed"; error: AiErrorView }
  | { kind: "done"; enough: boolean };

const EMPTY: Arrangement = { skip: [], commits: [] };
const NO_REVIEW: Review = { pinned: new Set(), confirmed: new Set() };
/** How long a notice under the list stays. */
const NOTICE_MS = 2600;

const fileOf = (path: string) => splitPath(path).name;

export function ComposeView({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const listId = useId();
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
  const [original, setOriginal] = useState<Arrangement | null>(null);
  const [notes, setNotes] = useState<ReadonlyMap<string, ComposeNote>>(new Map());
  const [review, setReviewState] = useState<Review>(NO_REVIEW);
  const reviewRef = useRef<Review>(NO_REVIEW);
  const [selection, setSelectionState] = useState<Selection>(emptySelection);
  const selectionRef = useRef<Selection>(emptySelection);
  const [view, setView] = useState<"commits" | "files">("commits");
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null);
  const dirty = useRef(false);
  const [request, setRequestState] = useState<Request>({ kind: "idle" });
  const requestRef = useRef<Request>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const [outdated, setOutdated] = useState(false);
  const [skipHooks, setSkipHooks] = useState(wip.skipHooks);
  const [instruction, setInstruction] = useState("");
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);

  const order = useMemo(() => orderOf(state?.units ?? []), [state]);
  const units = useMemo(() => new Map((state?.units ?? []).map((unit) => [unit.id, unit])), [state]);
  const unsure = useMemo(() => new Set(unsureUnits(arrangement, notes, review)), [arrangement, notes, review]);

  const setRequest = (next: Request) => {
    requestRef.current = next;
    setRequestState(next);
  };
  const show = (next: ComposeState) => {
    stateRef.current = next;
    setState(next);
  };
  const setReview = (next: Review) => {
    reviewRef.current = next;
    setReviewState(next);
  };
  const setSelection = (next: Selection) => {
    selectionRef.current = next;
    setSelectionState(next);
  };
  const arrange = (next: Arrangement, byUser: boolean) => {
    arrangementRef.current = next;
    setArrangement(next);
    if (byUser) dirty.current = true;
  };
  const say = (text: string) => setNotice({ text, id: Date.now() });

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (moved.size === 0) return;
    const timer = window.setTimeout(() => setMoved(new Set()), 900);
    return () => window.clearTimeout(timer);
  }, [moved]);

  // The cursor row stays in view.
  useEffect(() => {
    if (!selection.cursor) return;
    root.current?.querySelector(`[data-cursor]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selection.cursor, view]);

  /** A unit ID the selection may point at after the units changed. */
  const keepSelection = (ids: Set<string>) => {
    const current = selectionRef.current;
    const kept = current.ids.filter((id) => ids.has(id));
    if (current.cursor && ids.has(current.cursor)) setSelection({ ...current, ids: kept.length ? kept : [current.cursor] });
    else setSelection(emptySelection);
  };

  const load = async (): Promise<ComposeState | null> => {
    try {
      const next = await core.composeUnits({ repoId });
      show(next);
      setOutdated(false);
      setLoadError(null);
      const fresh = arrangementRef.current === EMPTY ? { skip: next.units.map((unit) => unit.id), commits: [] } : refreshed(arrangementRef.current, next.units);
      arrange(fresh, false);
      keepSelection(new Set(next.units.map((unit) => unit.id)));
      return next;
    } catch (error) {
      setLoadError(describeError(toCoreError(error)).text);
      return null;
    }
  };

  const propose = async (text: string | null) => {
    if (requestRef.current.kind === "loading") return;
    if (aiVisibility(queryClient.getQueryData<AiStatus>(qk.aiStatus)).elementsOpenSetup) {
      void openAiSetup();
      return;
    }
    const keep: ComposeKeep[] = keepOf(arrangementRef.current, reviewRef.current.pinned);
    let preview: AiPreview;
    try {
      preview = await core.aiPreview({ repoId, feature: "compose", input: { kind: "compose", instruction: text, keep }, locale: locale() });
    } catch (error) {
      setRequest({ kind: "failed", error: errorView(error) });
      return;
    }
    if (!(await confirmSend(repoId, "compose", preview))) {
      setRequest({ kind: "idle" });
      return;
    }
    const jobId = newJobId();
    setRequest({ kind: "loading", jobId, startedAt: Date.now(), instruction: text });
    try {
      // The units placed meanwhile go along as well: they stay where the user put them.
      const proposal = await core.composeProposal({ repoId, jobId, locale: locale(), instruction: text, keep: keepOf(arrangementRef.current, reviewRef.current.pinned) });
      const current = requestRef.current as Request;
      // Cancelled or replaced meanwhile: the answer is dropped – there are no half results.
      if (current.kind !== "loading" || current.jobId !== jobId) return;
      show(proposal.state);
      const ids = new Set(proposal.state.units.map((unit) => unit.id));
      const pinned = new Set([...reviewRef.current.pinned].filter((id) => ids.has(id)));
      const nextOrder = orderOf(proposal.state.units);
      const fresh = fromProposal(proposal.state.units, proposal.groups);
      const merged = reproposed(fresh, refreshed(arrangementRef.current, proposal.state.units), pinned, nextOrder);
      arrange(merged, false);
      dirty.current = pinned.size > 0;
      setOriginal(fresh);
      setNotes(notesOf(proposal.notes));
      setReview({ pinned, confirmed: new Set() });
      keepSelection(ids);
      if (!selectionRef.current.cursor) {
        const first = nextUnsure(merged, notesOf(proposal.notes), { pinned, confirmed: new Set() }, null) ?? displayOrder(merged)[0];
        if (first) setSelection(selectOne(emptySelection, first));
      }
      setRequest({ kind: "done", enough: proposal.groups.length === 1 && pinned.size === 0 });
      if (text !== null) say(pinned.size > 0 ? t("wip.compose.reproposedKept", { count: pinned.size }) : t("wip.compose.reproposed"));
      if (text !== null) setInstruction("");
    } catch (error) {
      const current = requestRef.current as Request;
      if (current.kind !== "loading" || current.jobId !== jobId) return;
      const failed = errorView(error);
      setRequest(failed.kind === "cancelled" ? { kind: "idle" } : { kind: "failed", error: failed });
    }
  };

  const cancelRequest = () => {
    const current = requestRef.current;
    if (current.kind !== "loading") return;
    setRequest({ kind: "idle" });
    void core.jobCancel({ jobId: current.jobId });
  };

  const whatIsSent = async () => {
    const keep = keepOf(arrangementRef.current, reviewRef.current.pinned);
    const text = instruction.trim() || null;
    const result = await runAction(t("ai.preview.loading"), () => core.aiPreview({ repoId, feature: "compose", input: { kind: "compose", instruction: text, keep }, locale: locale() }));
    if (result.ok) await showAiPreview(result.value, "look");
  };

  // ---- Selection and moves -------------------------------------------------------------------

  const select = (unit: string, mode: "one" | "toggle" | "range") => {
    const current = selectionRef.current;
    const next = mode === "toggle" ? toggleSelection(current, unit) : mode === "range" ? rangeSelection(current, unit, displayOrder(arrangementRef.current)) : selectOne(current, unit);
    setSelection(next);
  };

  const groupName = (group: number) => (group === SKIP ? t("wip.compose.skipQuoted") : t("wip.compose.commit", { number: group + 1 }));

  /** Moves the selection (or `ids`) and marks the moved units as placed by the user. */
  const moveTo = (target: number | "new", ids = selectionRef.current.ids) => {
    const result = moveUnits(arrangementRef.current, ids, target, order, units);
    if (result.moved.length === 0) {
      const locked = ids.map((id) => units.get(id)).find((unit) => unit?.protected);
      if (locked) say(t("wip.compose.protectedToast", { file: fileOf(locked.path) }));
      return null;
    }
    arrange(result.arrangement, true);
    setReview({ ...reviewRef.current, pinned: new Set([...reviewRef.current.pinned, ...result.moved]) });
    setMoved(new Set(result.moved));
    const cursor = selectionRef.current.cursor;
    setSelection({ cursor: cursor && result.moved.includes(cursor) ? cursor : result.moved[0]!, ids: result.moved, anchor: result.moved[0]! });
    const name = groupName(result.target);
    say(result.moved.length === 1 ? t("wip.compose.movedTo", { group: name }) : t("wip.compose.movedManyTo", { count: result.moved.length, group: name }));
    return result;
  };

  const focusSubject = (index: number) => {
    setView("commits");
    requestAnimationFrame(() => {
      const input = root.current?.querySelector<HTMLInputElement>(`[data-compose-subject="${index}"]`);
      input?.focus();
      input?.select();
    });
  };

  const newCommit = () => {
    const result = moveTo("new");
    if (result) focusSubject(result.target);
  };

  const confirmUnit = (unit: string) => {
    const next: Review = { ...reviewRef.current, confirmed: new Set([...reviewRef.current.confirmed, unit]) };
    setReview(next);
    const left = unsureUnits(arrangementRef.current, notes, next);
    say(left.length > 0 ? t("wip.compose.confirmed", { count: left.length }) : t("wip.compose.allConfirmed"));
    const following = nextUnsure(arrangementRef.current, notes, next, unit);
    if (following) setSelection(selectOne(selectionRef.current, following));
  };

  const goNextUnsure = () => {
    const next = nextUnsure(arrangementRef.current, notes, reviewRef.current, selectionRef.current.cursor);
    if (!next) return;
    setView("commits");
    setSelection(selectOne(selectionRef.current, next));
    listRef.current?.focus({ preventScroll: true });
  };

  const goto = (unit: string) => {
    setView("commits");
    setSelection(selectOne(selectionRef.current, unit));
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  };

  const jumpToCommit = (index: number) => {
    const own = commitProblems(arrangementRef.current, units, index)[0]?.unit ?? arrangementRef.current.commits[index]?.units[0];
    if (own) goto(own);
  };

  const restart = () => {
    if (!original || !state) return;
    arrange(refreshed(original, state.units), false);
    dirty.current = false;
    setReview(NO_REVIEW);
    say(t("wip.compose.restarted"));
  };

  // ---- Apply ---------------------------------------------------------------------------------

  const apply = async () => {
    const current = stateRef.current;
    const plan = arrangementRef.current;
    if (!current || applyingRef.current || blockedReason(plan)) return;
    const problem = firstProblem(plan, units);
    if (problem) {
      const file = fileOf(units.get(problem.need)?.path ?? "");
      const text =
        problem.group === SKIP
          ? t("wip.compose.broken.skipped", { commit: problem.commit + 1, file })
          : t("wip.compose.broken.later", { commit: problem.commit + 1, file, number: problem.group + 1 });
      const choice = await askBroken(text);
      if (choice !== "go") {
        if (choice === "fix") goto(problem.unit);
        return;
      }
    }
    const commits = planOf(plan);
    const jobId = newJobId();
    applyingRef.current = true;
    setApplying(true);
    useAppStore.getState().startJob({ id: jobId, title: t("wip.compose.title"), repoId });
    const settled: Promise<Settled<{ steps: { hooks: string[] }[] }>> = core.composeApply({ repoId, jobId, plan: { commits, skipHooks }, expectToken: current.token }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: toCoreError(error) }),
    );
    const choice = await showApply({ jobId, steps: commits.map((commit) => ({ title: commit.title })), hooks: current.hooks, skipHooks, settled });
    const outcome = await settled;
    useAppStore.getState().finishJob(jobId);
    applyingRef.current = false;
    setApplying(false);
    if (!outcome.ok) {
      if (outcome.error.code === "stale_state") setOutdated(true);
      return;
    }
    if (choice === "undo") {
      applyingRef.current = true;
      const undone = await undo(repoId);
      dirty.current = true;
      await load();
      applyingRef.current = false;
      if (undone.ok) say(t("wip.compose.run.undone"));
      return;
    }
    dirty.current = false;
    closeCompose(tabId);
  };

  // ---- Effects -------------------------------------------------------------------------------

  // Open: read the changes, then ask for a proposal right away (the click on "Compose …" is the request).
  useEffect(() => {
    let alive = true;
    void load().then((next) => {
      if (alive && next && next.units.length > 0) void propose(null);
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
  // Only a real difference counts: the core's state token is compared (our own undo also sends events).
  useEffect(() => {
    let timer = 0;
    const check = () => {
      const shown = stateRef.current?.token;
      if (!shown || applyingRef.current) return;
      void core
        .composeUnits({ repoId })
        .then((next) => {
          if (!applyingRef.current && stateRef.current && next.token !== stateRef.current.token) setOutdated(true);
        })
        .catch(() => setOutdated(true));
    };
    const stop = core.on("repo:changed", ({ repoId: changed, what }) => {
      if (changed !== repoId || applyingRef.current) return;
      if (!what.some((part) => part === "worktree" || part === "index" || part === "head")) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 400);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
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
  // proposal that arrives later never moves the focus.
  useEffect(() => {
    if (focusedOnce.current || !state || state.units.length === 0) return;
    focusedOnce.current = true;
    if (viewMayTakeFocus()) requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  }, [state]);

  // ---- Keys ----------------------------------------------------------------------------------

  /** Keys of the list (and of the detail buttons): moves, selection, review. */
  const onKey = (event: ReactKeyboardEvent) => {
    // Typing in a commit's message is text, not shortcuts (Mod+Enter is handled by the view).
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    const action = keyAction(event, isMacShortcuts());
    if (!action) return;
    const current = arrangementRef.current;
    const sel = selectionRef.current;
    const ids = displayOrder(current);
    const cursor = sel.cursor;
    switch (action.kind) {
      case "step": {
        const at = cursor ? ids.indexOf(cursor) : -1;
        const next = ids[Math.max(0, Math.min(ids.length - 1, at + action.delta))] ?? ids[0];
        if (next) setSelection(selectOne(sel, next));
        break;
      }
      case "extend":
        setSelection(extendSelection(sel, action.delta, ids));
        break;
      case "shift": {
        if (!cursor) break;
        const target = stepTarget(current, cursor, action.delta);
        if (target !== null) moveTo(target);
        break;
      }
      case "moveCommit": {
        const group = cursor ? groupOf(current, cursor) : null;
        if (group === null || group === SKIP) break;
        const next = moveCommit(current, group, action.delta);
        if (next !== current) arrange(next, true);
        break;
      }
      case "to":
        if (action.group !== SKIP && action.group >= current.commits.length) return;
        moveTo(action.group);
        break;
      case "newCommit":
        newCommit();
        break;
      case "nextUnsure":
        goNextUnsure();
        break;
      case "confirm":
        if (!cursor || !unsure.has(cursor)) return;
        confirmUnit(cursor);
        break;
      case "edit": {
        const group = cursor ? groupOf(current, cursor) : null;
        if (group !== null && group !== SKIP) focusSubject(group);
        break;
      }
      case "apply":
        void apply();
        break;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  /** Esc closes, Mod+Enter creates – also from the message fields; the list keys from anywhere else in the view that is no field or button. */
  const onRootKey = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (hasOpenDialog() || hasOpenMenu() || root.current?.querySelector("[data-compose-list][data-dragging]")) return;
      if (target.matches("input[data-compose-subject]")) {
        event.preventDefault();
        listRef.current?.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      closeCompose(tabId);
      return;
    }
    const action = keyAction(event, isMacShortcuts());
    if (action?.kind === "apply") {
      event.preventDefault();
      void apply();
      return;
    }
    if (target.closest("input, textarea, select, button, a, [role=switch], [contenteditable]")) return;
    onKey(event);
  };

  // ---- Render --------------------------------------------------------------------------------

  const header = (
    <ToolHeader
      icon={<GitCommitHorizontal className="size-icon" aria-hidden />}
      title={t("wip.compose.title")}
      onClose={() => closeCompose(tabId)}
      subtitle={state ? <span className="min-w-0 truncate font-medium text-text">{state.branch}</span> : undefined}
    />
  );
  const shell = (body: ReactNode) => (
    <section ref={root} data-screen="compose" className="@container relative flex h-full min-w-0 flex-col bg-bg" onKeyDown={onRootKey}>
      {header}
      {body}
    </section>
  );

  if (loadError) return shell(<EmptyState title={t("wip.compose.loadFailed")}>{loadError}</EmptyState>);
  if (!state) return shell(<SkeletonRows />);
  if (state.units.length === 0) return shell(<EmptyState title={t("wip.compose.empty")} />);

  const loading = request.kind === "loading" ? loadingView(now - request.startedAt, aiStatus?.local ?? false, request.instruction ? t("wip.compose.proposingFor", { text: request.instruction }) : t("wip.compose.proposing")) : null;
  const statusText = loading ? [loading.text, loading.slow].filter(Boolean).join(" – ") : request.kind === "done" && request.enough ? t("wip.compose.enough") : "";
  const summary = summaryOf(arrangement);
  const blocked = blockedReason(arrangement);
  const blockedText = !blocked ? null : blocked.reason === "nothing" ? t("wip.compose.nothingPlanned") : t("wip.compose.titleMissing", { number: blocked.commit + 1 });
  const broken = firstProblem(arrangement, units) !== null;
  const files = new Set(state.units.map((unit) => unit.path)).size;
  const unsureCount = unsure.size;
  const planned = planOf(arrangement).length;
  const mac = isMacShortcuts();

  return shell(
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <span className="text-sm text-text-muted" data-compose-meta="">
          {t("wip.compose.meta", { count: state.units.length, files })}
          {original ? ` · ${t("wip.compose.metaProposed")}` : ""}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" data-compose-what-is-sent="" onClick={() => void whatIsSent()}>
          {t("wip.compose.whatIsSent")}
        </Button>
        {original ? (
          <Button
            size="sm"
            variant="secondary"
            data-compose-review=""
            disabled={unsureCount === 0}
            onClick={goNextUnsure}
            className={unsureCount > 0 ? "border-transparent bg-warning-surface text-warning" : "disabled:bg-success-surface! disabled:text-success!"}
          >
            {unsureCount > 0 ? t("wip.compose.review", { count: unsureCount }) : t("wip.compose.reviewed")}
          </Button>
        ) : null}
        <SegmentedControl
          label={t("wip.compose.viewLabel")}
          value={view}
          onValueChange={setView}
          options={[
            { value: "commits", label: t("wip.compose.byCommits") },
            { value: "files", label: t("wip.compose.byFiles") },
          ]}
        />
        {original ? (
          <Button size="sm" variant="secondary" data-compose-restart="" onClick={restart}>
            {t("wip.compose.restart")}
          </Button>
        ) : null}
      </div>
      <History arrangement={arrangement} units={units} branch={state.branch} headSubject={state.headSubject} onJump={jumpToCommit} />
      {request.kind === "loading" || statusText ? (
        <div className="flex items-center gap-3 border-b border-border px-4 py-1.5">
          <p className="m-0 min-w-0 flex-1 truncate text-sm text-text-muted" aria-live="polite" data-compose-status="">
            {statusText}
          </p>
          {request.kind === "loading" ? (
            <Button size="sm" variant="secondary" data-compose-cancel="" onClick={cancelRequest}>
              {t("ai.state.cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {request.kind === "failed" ? <RequestError error={request.error} provider={aiStatus?.provider ?? null} onAgain={() => void propose(null)} onShowSent={() => void whatIsSent()} /> : null}
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
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-[1.05] flex-col border-r border-border">
          {view === "commits" ? (
            <CommitList
              listId={listId}
              listRef={listRef}
              arrangement={arrangement}
              units={units}
              notes={notes}
              review={review}
              unsure={unsure}
              selection={selection}
              moved={moved}
              onSelect={select}
              onDrop={(ids, group) => {
                setSelection({ cursor: ids[0] ?? null, ids, anchor: ids[0] ?? null });
                moveTo(group, ids);
              }}
              onTitle={(index, title) => arrange(setTitle(arrangementRef.current, index, title), true)}
              onMoveCommit={(index, delta) => arrange(moveCommit(arrangementRef.current, index, delta), true)}
              onMerge={(index) => {
                arrange(mergeWithNext(arrangementRef.current, index, order), true);
                say(t("wip.compose.mergedToast", { first: index + 1, second: index + 2 }));
              }}
              onGoto={goto}
              onKeyDown={onKey}
            />
          ) : (
            <FileMatrix arrangement={arrangement} units={state.units} onGoto={goto} />
          )}
        </div>
        <aside className="min-w-0 flex-1 overflow-auto" aria-live="polite" onKeyDown={onRootKeyFromDetail(onKey)}>
          <Detail arrangement={arrangement} units={units} notes={notes} review={review} unsure={unsure} selection={selection} onMove={(target) => (target === "new" ? newCommit() : moveTo(target))} onConfirm={confirmUnit} />
        </aside>
        {notice ? (
          <div key={notice.id} role="status" data-compose-notice="" className="pointer-events-none absolute bottom-3 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-md bg-text px-3.5 py-2 text-sm text-bg shadow-pop">
            {notice.text}
          </div>
        ) : null}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 border-t border-border bg-surface px-4 py-3">
        <form
          className="flex min-w-0 grow basis-96 items-center gap-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const text = instruction.trim();
            if (!text) return;
            void propose(text);
          }}
        >
          <input
            data-compose-instruction=""
            value={instruction}
            maxLength={300}
            onChange={(event) => setInstruction(event.target.value)}
            aria-label={t("wip.compose.instruction")}
            placeholder={t("wip.compose.instructionPlaceholder")}
            className="h-control-md min-w-0 flex-1 rounded-md border border-border-input bg-surface-raised px-2.5 text-sm text-text outline-none placeholder:text-text-disabled focus-visible:border-accent"
          />
          <Button type="submit" variant="secondary" data-compose-repropose="" disabled={request.kind === "loading"}>
            {t("wip.compose.repropose")}
          </Button>
        </form>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          <span className="text-sm text-text-muted" data-compose-summary="">
            {t("wip.compose.summary", { count: summary.commits, units: summary.units })} · {t("wip.compose.staying", { count: summary.skipped })}
            {summary.untitled > 0 ? <span className="text-danger"> · {t("wip.compose.untitledCount", { count: summary.untitled })}</span> : broken ? <span className="text-warning"> · {t("wip.compose.checkOrder")}</span> : null}
          </span>
          <Checkbox label={t("wip.form.skipHooks")} checked={skipHooks} onCheckedChange={setSkipHooks} />
          <Button
            variant="primary"
            data-action="compose-apply"
            data-blocked={blockedText ? "" : undefined}
            disabled={Boolean(blockedText) || applying}
            title={blockedText ?? undefined}
            loading={applying}
            onClick={() => void apply()}
          >
            {t("wip.compose.apply", { count: Math.max(planned, 1) })}
            <Kbd className="ml-1 opacity-75">{mac ? "⌘ ↵" : t("wip.compose.applyKeys")}</Kbd>
          </Button>
        </div>
      </footer>
    </>,
  );
}

/** Keys pressed on a move button in the detail act like in the list – except Enter and space, which press the button. */
function onRootKeyFromDetail(onKey: (event: ReactKeyboardEvent) => void) {
  return (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") return;
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    onKey(event);
  };
}
