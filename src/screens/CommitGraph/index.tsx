/**
 * Commit graph: the history as a virtualised list. The rows are real DOM
 * (role=grid/row/gridcell), the lanes are drawn by a canvas on top (src/components/graph).
 *
 * Where things come from:
 * - Rows and lanes: useGraph (infinite query, layout from the core).
 * - Count and text of the “local changes” row: useStatus – the graph is not reloaded on changes in
 *   the working directory. Only when “clean” and “changed” switch does it reload, because then the
 *   row's lane is added or removed.
 * - Selection, search, “show this commit”: the store (a separate small subscription per row).
 * - Columns: RepoViewState.columns, saved via viewStateSet.
 * - Pinned branches (RepoViewState.pinnedRefs), highlighting a branch and the ghost label are laid
 *   over the core's layout by the UI (src/components/graph/decor.ts) – the core supplies nothing of
 *   its own for that.
 * - “Only current branch, upstream and target”: via the view's solo refs (src/components/graph/smart.ts).
 *
 * Keys in the list: ↑ ↓ J K Home End PgUp PgDn (Shift extends), H / L (parent / child),
 * Enter (details), B (highlight the row's branch, again or Esc clears it), menu key.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Filter, GitCommitHorizontal, Highlighter, Loader2, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { core, CoreError, type GraphPage, type GraphRow, type Id, type Ref, type RefLabelInfo, type RepoViewState, type Sha } from "../../core";
import { checkout, createBranch } from "../../app/actions/branches";
import { setSmartVisibility, smartBlock, syncSmartVisibility } from "../../app/actions/graphView";
import { confirm, showOutput } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { shortSha } from "../../app/format";
import { branchMenu, commitMenu, dropMenu, stashMenu, tagMenu, wipMenu } from "../../app/menus";
import { qk, queryClient, useGraph, useRefs, useSettings, useStashes, useStatus, useViewState } from "../../app/queries";
import { runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { layoutColumns, normalizeColumns, type ColumnState } from "../../components/graph/columns";
import { branchLabelOf, computeHighlight, computePinnedChain, decorateRow, EdgeHighlighter, laneMapsAt, nearestBranch, type PaintRow, type PinnedChain } from "../../components/graph/decor";
import { graphWidthFor, readMetrics, rootZoom } from "../../components/graph/geometry";
import { GraphCanvas, type GraphDecor } from "../../components/graph/GraphCanvas";
import { GraphHeader, type SmartToggle } from "../../components/graph/GraphHeader";
import { activeKey, changeCount, GraphRowView, ROW_SELECTED, rowFlags, rowKey, selectionOf, type RowShared } from "../../components/graph/GraphRowView";
import { clearHighlight, currentHighlight, endHoverHighlight, hoverHighlight, toggleStickyHighlight, useHighlightTarget } from "../../components/graph/highlightStore";
import { PointMenu, type PointMenuState } from "../../components/graph/PointMenu";
import { RowMarks } from "../../components/graph/rowMarks";
import { setSmartRecord, smartSelection, useSmartRecord, type SmartSelection } from "../../components/graph/smart";
import { useRefDrag } from "../../components/graph/useRefDrag";
import { Button } from "../../ui/Button";
import { Banner, EmptyState, toast } from "../../ui/Feedback";
import type { MenuEntry } from "../../ui/Menu";
import { cn } from "../../ui/cn";
import { Trans } from "react-i18next";
import { t } from "../../i18n";

export interface CommitGraphProps {
  repoId: Id;
  tabId: Id;
}

/** The next page is fetched this many rows before the end of the loaded history. */
const LOAD_AHEAD = 150;
/** “Show this commit”: at most this many pages (500 commits each) are loaded for it. */
const REVEAL_PAGES = 30;
const STASH_REF = "refs/stash";

/** Shown at the top while the graph has no row of its own for the local changes (yet). */
const QUIET_WIP: GraphRow = Object.freeze({
  id: "wip",
  kind: "wip",
  sha: null,
  lane: -1,
  color: 0,
  edges: [],
  parents: [],
  summary: "",
  authorName: "",
  authorEmail: "",
  authoredAt: null,
  refs: [],
  isHead: false,
  stashIndex: null,
  wipCount: null,
}) as GraphRow;

interface FlatGraph {
  /** Index 0 is always the local changes row. */
  rows: GraphRow[];
  indexByKey: Map<string, number>;
  hasWip: boolean;
  maxLane: number;
  commitCount: number;
}

function flatten(pages: GraphPage[] | undefined): FlatGraph {
  let wip: GraphRow | null = null;
  let maxLane = 0;
  let commitCount = 0;
  const rows: GraphRow[] = [QUIET_WIP];
  const indexByKey = new Map<string, number>([["wip", 0]]);
  for (const page of pages ?? []) {
    maxLane = Math.max(maxLane, page.maxLane);
    for (const row of page.rows) {
      if (row.kind === "wip") {
        wip = row;
        continue;
      }
      const key = rowKey(row);
      if (indexByKey.has(key)) continue;
      indexByKey.set(key, rows.length);
      rows.push(row);
      if (row.kind !== "stash") commitCount += 1;
    }
  }
  if (wip) rows[0] = wip;
  return { rows, indexByKey, hasWip: wip !== null, maxLane, commitCount };
}

const isCommitRow = (row: GraphRow | undefined): row is GraphRow & { sha: Sha } => Boolean(row && row.sha && (row.kind === "commit" || row.kind === "merge"));

const shortRefName = (fullName: string) => (fullName === STASH_REF ? t("commitGraph.filter.stashes") : fullName.replace(/^refs\/(heads|remotes|tags)\//, ""));

/** “main, origin/main and develop” – what the selection “current branch, upstream, target” shows. */
function smartText(selection: SmartSelection): string {
  const names = [selection.current.name, selection.upstream?.name, selection.target?.name].filter((name): name is string => Boolean(name));
  return names.length <= 1 ? (names[0] ?? "") : t("commitGraph.filter.list", { first: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

function filterText(view: RepoViewState, smart: SmartSelection | null): string {
  if (smart) {
    const parts = [t("commitGraph.filter.currentBranch"), smart.upstream ? t("commitGraph.filter.upstream") : null, smart.target ? t("commitGraph.filter.target") : null].filter(Boolean);
    return t("commitGraph.filter.smart", { names: smartText(smart), parts: parts.join(", ") });
  }
  if (view.soloRefs.length === 1) return t("commitGraph.filter.soloOne", { name: shortRefName(view.soloRefs[0]!) });
  if (view.soloRefs.length > 1) return t("commitGraph.filter.soloMany", { count: view.soloRefs.length });
  if (view.hiddenRefs.length === 1) return t("commitGraph.filter.hiddenOne", { name: shortRefName(view.hiddenRefs[0]!) });
  return t("commitGraph.filter.hiddenMany", { count: view.hiddenRefs.length });
}

/** Load the graph from the start: keep only the first page so that not all loaded pages are fetched again. */
function reloadGraph(repoId: Id) {
  queryClient.setQueryData<InfiniteData<GraphPage, string | null>>(qk.graph(repoId), (data) =>
    data && data.pages.length > 1 ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
  );
  return queryClient.invalidateQueries({ queryKey: qk.graph(repoId) });
}

async function showAllRefs(repoId: Id) {
  // “Show all” also turns off the selection “current branch, upstream, target”.
  setSmartRecord(repoId, null);
  const result = await runAction(t("commitGraph.filter.clear"), () => core.viewStateSet({ repoId, patch: { hiddenRefs: [], soloRefs: [] } }));
  if (!result.ok) return;
  queryClient.setQueryData(qk.viewState(repoId), result.value);
  void reloadGraph(repoId);
}

// ---------------------------------------------------------------------------
// States without a list
// ---------------------------------------------------------------------------

const HEADER_LABELS = ["Refs", "Graph", "Message"];
/** Widths of the placeholder bars in quarters of the column; repeats, but does not look uniform. */
const SKELETON_MESSAGE = ["w-3/5", "w-2/5", "w-4/5", "w-1/2", "w-2/3", "w-1/3", "w-3/4", "w-1/2", "w-3/5", "w-2/5", "w-2/3", "w-4/5"];

function GraphSkeleton() {
  return (
    <div role="status" aria-label={t("commitGraph.loading")} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-control-md shrink-0 items-center border-b border-border bg-surface text-xs font-semibold tracking-wide text-text-muted uppercase" aria-hidden>
        <span className="w-40 px-2">{HEADER_LABELS[0]}</span>
        <span className="w-16 px-2">{HEADER_LABELS[1]}</span>
        <span className="flex-1 px-2">{HEADER_LABELS[2]}</span>
      </div>
      <div className="animate-pulse" aria-hidden>
        {Array.from({ length: 24 }, (_, index) => (
          <div key={index} className="flex h-graph-row items-center">
            <div className="flex w-40 justify-end px-2">{index % 5 === 1 ? <span className="h-4 w-20 rounded-sm bg-surface-raised" /> : null}</div>
            <div className="flex w-16 items-center px-2">
              <span className="ml-1 size-node rounded-pill bg-surface-raised" />
            </div>
            <div className="flex-1 px-2">
              <span className={cn("block h-3 rounded-sm bg-surface-raised", SKELETON_MESSAGE[index % SKELETON_MESSAGE.length])} />
            </div>
            <div className="w-28 px-2">
              <span className="block h-3 w-16 rounded-sm bg-surface-raised" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphError({ error, busy, onRetry }: { error: unknown; busy: boolean; onRetry: () => void }) {
  const { text, hint } = describeError(error);
  const output = error instanceof CoreError ? error.gitOutput?.trim() : null;
  return (
    <div role="alert" className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <EmptyState
        icon={<TriangleAlert className="size-6 text-danger" aria-hidden />}
        title={t("commitGraph.loadFailed")}
        action={
          <div className="flex justify-center gap-2">
            <Button variant="primary" loading={busy} icon={<RefreshCw className="size-icon" aria-hidden />} onClick={onRetry}>
              {t("commitGraph.retry")}
            </Button>
            {output ? <Button onClick={() => void showOutput(t("commitGraph.outputTitle"), output)}>{t("commitGraph.showOutput")}</Button> : null}
          </div>
        }
      >
        <span className="selectable">{hint ? `${text} ${hint}` : text}</span>
      </EmptyState>
    </div>
  );
}

function FilterBar({ repoId, view, smart }: { repoId: Id; view: RepoViewState; smart: SmartSelection | null }) {
  return (
    <div role="status" data-graph-filter={smart ? "smart" : "manual"} className="flex h-control-md shrink-0 items-center gap-2 border-b border-border bg-accent-surface pr-1 pl-2 text-sm">
      <Filter className="size-3.5 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">{t("commitGraph.filter.title")}</span>
        <span className="text-text-muted"> · {filterText(view, smart)}</span>
      </p>
      <Button size="sm" variant="ghost" onClick={() => void showAllRefs(repoId)}>
        {t("commitGraph.filter.showAll")}
      </Button>
    </div>
  );
}

/** No branch checked out: says so above the graph and offers the way out (the commit panel shows the same for the local changes). */
function DetachedBar({ repoId, tabId, sha }: { repoId: Id; tabId: Id; sha: Sha }) {
  return (
    <div role="status" data-graph-detached className="flex min-h-control-md shrink-0 items-center gap-2 border-b border-border bg-warning-surface pr-1 pl-2 text-sm">
      <Unplug className="size-3.5 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">{t("commitGraph.detached.title")}</span>
        <span className="text-text-muted">
          {" "}
          <Trans i18nKey="commitGraph.detached.text" values={{ sha: shortSha(sha) }} components={{ code: <code className="font-mono text-code" /> }} />
        </span>
      </p>
      <Button size="sm" variant="ghost" onClick={() => void createBranch(repoId, { checkout: true, tabId })}>
        {t("commitGraph.detached.createBranch")}
      </Button>
    </div>
  );
}

/** A branch is pinned as highlighted (key B): says which one and how to clear it. */
function HighlightBar({ repoId, name, count, loaded }: { repoId: Id; name: string; count: number | null; loaded: boolean }) {
  return (
    <div role="status" data-graph-highlight className="flex h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-2 text-sm">
      <Highlighter className="size-3.5 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">{t("commitGraph.highlight.title", { name })}</span>
        <span className="text-text-muted">
          {" "}
          · {count === null ? t("commitGraph.highlight.notLoaded") : loaded ? t("commitGraph.highlight.count", { count }) : t("commitGraph.highlight.countLoaded", { count })}
        </span>
      </p>
      <Button size="sm" variant="ghost" onClick={() => clearHighlight(repoId)}>
        {t("commitGraph.highlight.clear")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

type GraphQuery = ReturnType<typeof useGraph>;
type FooterState = "loading" | "more" | "error" | "end";

function GraphFooter({ top, state, count, columns, onMore }: { top: number; state: FooterState; count: number; columns: number; onMore: () => void }) {
  return (
    <div role="row" data-graph-footer={state} className="absolute top-0 left-0 flex h-graph-row w-full items-center justify-center text-sm text-text-muted" style={{ transform: `translateY(${top}px)` }}>
      <div role="gridcell" aria-colspan={columns} className="flex items-center gap-2">
        {state === "loading" ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <span>{t("commitGraph.footer.loading")}</span>
          </>
        ) : state === "more" ? (
          <Button size="sm" variant="ghost" onClick={onMore}>
            {t("commitGraph.footer.loadMore")}
          </Button>
        ) : state === "error" ? (
          <>
            <span>{t("commitGraph.footer.loadFailed")}</span>
            <Button size="sm" variant="ghost" onClick={onMore}>
              {t("commitGraph.retry")}
            </Button>
          </>
        ) : (
          <span>{t("commitGraph.footer.end", { count })}</span>
        )}
      </div>
    </div>
  );
}

interface GraphGridProps extends CommitGraphProps {
  graph: GraphQuery;
  flat: FlatGraph;
  viewState: RepoViewState | undefined;
  /** No branch checked out (and no operation in progress). */
  detached: boolean;
  smart: SmartToggle | null;
}

const NO_PINS: readonly string[] = [];

function GraphGrid({ repoId, tabId, graph, flat, viewState, detached, smart }: GraphGridProps) {
  const { rows, indexByKey } = flat;
  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = graph;
  const { data: settings } = useSettings();
  const { data: refs } = useRefs(repoId);
  const { data: stashes } = useStashes(repoId);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const metrics = useMemo(() => readMetrics(), []);
  const rowHeight = metrics.rowHeight;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const indexByKeyRef = useRef(indexByKey);
  indexByKeyRef.current = indexByKey;

  // --- Dimensions of the list -------------------------------------------------------------------
  const [box, setBox] = useState({ width: 0, gutter: 0 });
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => {
      const width = scroller.clientWidth;
      const gutter = scroller.offsetWidth - width;
      setBox((current) => (current.width === width && current.gutter === gutter ? current : { width, gutter }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // --- Spalten ----------------------------------------------------------------------------------
  const stored = useMemo(() => normalizeColumns(viewState?.columns), [viewState?.columns]);
  const [draft, setDraft] = useState<ColumnState[] | null>(null);
  const columns = draft ?? stored;
  const saveSeq = useRef(0);
  const changeColumns = useCallback(
    (next: ColumnState[], { persist }: { persist: boolean }) => {
      // The draft applies immediately and stays until the core has answered – so the next key
      // already builds on the new state, even if the answer is still on its way.
      setDraft(next);
      if (!persist) return;
      const seq = ++saveSeq.current;
      queryClient.setQueryData<RepoViewState>(qk.viewState(repoId), (current) => (current ? { ...current, columns: next } : current));
      void runAction(t("commitGraph.saveColumns"), () => core.viewStateSet({ repoId, patch: { columns: next } })).then((result) => {
        if (seq !== saveSeq.current) return;
        if (result.ok) queryClient.setQueryData(qk.viewState(repoId), result.value);
        else void queryClient.invalidateQueries({ queryKey: qk.viewState(repoId) });
        setDraft(null);
      });
    },
    [repoId],
  );
  const dateFormat = settings?.dateFormat ?? "relative";
  const graphNatural = graphWidthFor(flat.maxLane, metrics);
  const layout = useMemo(
    () => layoutColumns({ columns, available: box.width, graphNatural, dateFormat }),
    [columns, box.width, graphNatural, dateFormat],
  );

  // --- Refs -------------------------------------------------------------------------------------
  const refByFull = useMemo(() => {
    const map = new Map<string, Ref>();
    for (const ref of [...(refs?.locals ?? []), ...(refs?.remotes ?? []), ...(refs?.tags ?? [])]) map.set(ref.fullName, ref);
    return map;
  }, [refs]);
  const upstreams = useMemo(() => {
    const map = new Map<string, string>();
    for (const ref of refs?.locals ?? []) if (ref.upstream) map.set(ref.name, ref.upstream);
    return map;
  }, [refs]);
  // --- Angeheftete Branches, Hervorheben, Ghost-Label ---------------------------------------------
  const marks = useMemo(() => new RowMarks(), []);
  const pinnedKey = (viewState?.pinnedRefs ?? NO_PINS).join("\n");
  const pinnedList = useMemo(() => (pinnedKey ? pinnedKey.split("\n") : NO_PINS), [pinnedKey]);
  const pinned = useMemo(() => new Set(pinnedList), [pinnedList]);
  const chains = useMemo(() => {
    const list: PinnedChain[] = [];
    for (const fullName of pinnedList) {
      const ref = refByFull.get(fullName);
      const chain = ref && ref.kind !== "tag" ? computePinnedChain(rows, indexByKey, ref.sha, ref.isHead) : null;
      if (chain) list.push(chain);
    }
    return list;
  }, [pinnedList, refByFull, rows, indexByKey]);

  const target = useHighlightTarget(repoId);
  const targetRef = target ? refByFull.get(target.fullName) : undefined;
  const targetSha = targetRef?.sha ?? null;
  const targetIsHead = targetRef?.isHead ?? false;
  const highlight = useMemo(() => (targetSha ? computeHighlight(rows, indexByKey, targetSha, targetIsHead) : null), [rows, indexByKey, targetSha, targetIsHead]);
  useLayoutEffect(() => {
    marks.setMember(highlight?.member ?? null);
  }, [marks, highlight]);
  // If the graph disappears (other tab, diff in the middle), hovering ends too.
  useEffect(() => () => endHoverHighlight(repoId), [repoId]);

  const decor = useMemo<GraphDecor | null>(() => {
    if (!highlight && chains.length === 0) return null;
    const edges = highlight ? new EdgeHighlighter(rows, highlight, flat.maxLane) : null;
    return {
      rows(first, last) {
        const hot = edges ? edges.range(first, last) : null;
        // The canvas asks for every row twice (edges, then nodes).
        const made = new Map<number, PaintRow>();
        return (index) => {
          const row = rows[index];
          if (!row) return undefined;
          let painted = made.get(index);
          if (!painted) {
            painted = decorateRow(row, laneMapsAt(chains, index), highlight !== null && highlight.member[index] !== 1, hot ? (hot[index - first] ?? null) : null, highlight !== null);
            made.set(index, painted);
          }
          return painted;
        };
      },
    };
  }, [rows, highlight, chains, flat.maxLane]);

  const shared = useMemo<RowShared>(
    () => ({ repoId, tabId, dateFormat, upstreams, marks, pinned, detached }),
    [repoId, tabId, dateFormat, upstreams, marks, pinned, detached],
  );

  // --- Selection and focus ----------------------------------------------------------------------
  const activeId = useAppStore((state) => activeKey(selectionOf(state, tabId)));
  const activeIndex = activeId !== null ? (indexByKey.get(activeId) ?? -1) : -1;
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  /** Row a range (Shift) starts from. */
  const anchor = useRef<string | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const keep = useRef<number[]>([]);
  // Without duplicates: if the active row is also the focused one, it would otherwise be in the list (and the DOM) twice.
  keep.current = [...new Set([activeIndex, focusedIndex ?? -1])].filter((index) => index >= 0 && index < rows.length);

  // Ghost label for the active and the hovered row: the nearest branch that contains the commit.
  const hoverRow = useRef(-1);
  const hoverFrame = useRef(0);
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const ghostCache = useRef(new Map<string, RefLabelInfo | null>());
  const updateGhosts = useCallback(() => {
    const next = new Map<string, RefLabelInfo>();
    for (const index of [activeIndexRef.current, hoverRow.current]) {
      const row = rowsRef.current[index];
      if (!row || !isCommitRow(row)) continue;
      let ghost = ghostCache.current.get(row.id);
      if (ghost === undefined) {
        ghost = nearestBranch(rowsRef.current, index)?.ref ?? null;
        ghostCache.current.set(row.id, ghost);
      }
      if (ghost) next.set(row.id, ghost);
    }
    marks.setGhosts(next);
  }, [marks]);
  useEffect(() => {
    ghostCache.current.clear();
  }, [rows]);
  useEffect(() => {
    updateGhosts();
  }, [rows, activeIndex, updateGhosts]);
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);

  const rangeExtractor = useCallback((range: Range) => {
    const base = defaultRangeExtractor(range);
    // The active and the focused row stay in the DOM even when scrolled out of view:
    // otherwise the keyboard focus would be lost.
    const extra = keep.current.filter((index) => index < range.count && !base.includes(index));
    return extra.length === 0 ? base : [...base, ...extra].sort((a, b) => a - b);
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length + 1,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    rangeExtractor,
  });
  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  const rowElement = (index: number) => scrollerRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`) ?? null;
  const focusRow = useCallback((index: number) => {
    pendingFocus.current = index;
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
    if (element) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }, []);
  // After keyboard navigation: focus the row as soon as it is in the DOM.
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const element = rowElement(pendingFocus.current);
    if (!element) return;
    element.focus({ preventScroll: true });
    pendingFocus.current = null;
  });

  const select = useCallback(
    (index: number, mode: "single" | "toggle" | "range") => {
      const list = rowsRef.current;
      const row = list[index];
      if (!row) return;
      const store = useAppStore.getState();
      if (row.kind === "wip") {
        store.selectWip(tabId);
        anchor.current = rowKey(row);
        return;
      }
      if (row.kind === "stash") {
        store.selectStash(tabId, row.stashIndex ?? 0);
        anchor.current = rowKey(row);
        return;
      }
      if (!row.sha) return;
      const selection = selectionOf(store, tabId);
      if (mode === "toggle") {
        if (selection?.kind === "commits") store.toggleCommit(tabId, row.sha);
        else store.selectCommits(tabId, [row.sha]);
        anchor.current = rowKey(row);
        return;
      }
      if (mode === "range") {
        const from = (anchor.current !== null ? indexByKeyRef.current.get(anchor.current) : undefined) ?? indexByKeyRef.current.get(activeKey(selection) ?? "") ?? index;
        const step = from <= index ? 1 : -1;
        const shas: Sha[] = [];
        for (let at = from; at !== index + step; at += step) {
          const between = list[at];
          if (isCommitRow(between)) shas.push(between.sha);
        }
        if (shas.length > 0) {
          store.selectCommits(tabId, shas);
          return;
        }
      }
      store.selectCommits(tabId, [row.sha]);
      anchor.current = rowKey(row);
    },
    [tabId],
  );
  /** Row that keyboard commands start from. */
  const cursorIndex = () => (activeIndex >= 0 ? activeIndex : (focusedIndex ?? items[0]?.index ?? 0));

  const moveTo = (target: number, extend: boolean) => {
    const cursor = cursorIndex();
    let next = Math.max(0, Math.min(rows.length - 1, target));
    if (extend) {
      // A range consists of commits only: skip stash rows and the local changes.
      const step = next >= cursor ? 1 : -1;
      while (rows[next] && !isCommitRow(rows[next])) next += step;
      if (!rows[next]) return;
    }
    select(next, extend ? "range" : "single");
    pendingFocus.current = next;
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  const openDetails = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const store = useAppStore.getState();
    if ((rowFlags(store, tabId, row) & ROW_SELECTED) === 0) select(index, "single");
    store.setRightPanel(tabId, "details");
    // The focus goes into the commit panel so that keyboard use continues there; back with Shift+Tab.
    // The details load asynchronously: wait up to one second for the first usable element.
    const started = performance.now();
    const focusPanel = () => {
      const panel = document.querySelector<HTMLElement>('[data-area="right"]');
      const elapsed = performance.now() - started;
      const anything = panel?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? null;
      // Local changes: straight into the file list (S, U, Del work there), otherwise into the message field –
      // not onto the first button in the panel header (that is “Discard all changes”).
      let target = anything;
      if (!isCommitRow(row)) {
        const fileRow = panel?.querySelector<HTMLElement>('[role="option"][tabindex="0"], [role="treeitem"][tabindex="0"]') ?? null;
        const field = panel?.querySelector<HTMLElement>("input:not([disabled]):not([type='checkbox']), textarea:not([disabled])") ?? null;
        // The list is still loading: first wait briefly for a file, then take the field, finally anything.
        target = fileRow ?? (elapsed > 300 ? field : null) ?? (elapsed > 900 ? anything : null);
      }
      if (target) target.focus();
      else if (elapsed < 1000) requestAnimationFrame(focusPanel);
    };
    requestAnimationFrame(focusPanel);
  };

  // --- Menus ------------------------------------------------------------------------------------
  const [menu, setMenu] = useState<PointMenuState | null>(null);
  /** Where the focus goes when the menu closes (the menu itself is then already gone from the state). */
  const menuRestore = useRef<(() => void) | null>(null);
  const keyboardMenuAt = useRef(0);
  const openMenu = useCallback((request: { entries: MenuEntry[]; x: number; y: number; label: string; restore: () => void }) => {
    if (request.entries.length === 0) return false;
    menuRestore.current = request.restore;
    setMenu({ entries: request.entries, label: request.label, x: request.x, y: request.y });
    return true;
  }, []);

  const openRowMenu = (index: number, point: { x: number; y: number }) => {
    const row = rows[index];
    if (!row) return false;
    if ((rowFlags(useAppStore.getState(), tabId, row) & ROW_SELECTED) === 0) select(index, "single");
    const restore = () => focusRow(index);
    if (row.kind === "wip") return openMenu({ entries: wipMenu({ repoId, tabId }), label: t("commitGraph.menu.wip"), ...point, restore });
    if (row.kind === "stash") {
      const stash = stashes?.find((candidate) => candidate.index === row.stashIndex);
      return stash ? openMenu({ entries: stashMenu({ repoId, tabId, stash }), label: t("commitGraph.menu.stash", { message: stash.message }), ...point, restore }) : false;
    }
    if (!row.sha) return false;
    const selection = selectionOf(useAppStore.getState(), tabId);
    const shas = selection?.kind === "commits" && selection.shas.includes(row.sha) ? selection.shas : [row.sha];
    return openMenu({
      entries: commitMenu({ repoId, tabId, shas }),
      label: shas.length === 1 ? t("commitGraph.menu.commit", { sha: shortSha(row.sha) }) : t("commitGraph.menu.commits", { count: shas.length }),
      ...point,
      restore,
    });
  };

  const openRefMenu = (fullName: string, rowIndex: number, point: { x: number; y: number }) => {
    const ref = refByFull.get(fullName);
    if (!ref) return false;
    const entries = ref.kind === "tag" ? tagMenu({ repoId, tabId, ref }) : branchMenu({ repoId, tabId, ref });
    return openMenu({ entries, label: ref.kind === "tag" ? t("commitGraph.menu.tag", { name: ref.name }) : t("commitGraph.menu.branch", { name: ref.name }), ...point, restore: () => focusRow(rowIndex) });
  };

  // --- Checkout per Doppelklick -------------------------------------------------------------------
  const checkoutCommit = async (row: GraphRow) => {
    if (!row.sha || row.isHead) return;
    const ok = await confirm({
      title: t("commitGraph.checkout.title", { sha: shortSha(row.sha) }),
      body: t("commitGraph.checkout.body"),
      confirmLabel: t("commitGraph.checkout.confirm"),
    });
    if (ok) void checkout(repoId, row.sha, { tabId });
  };
  const activateRef = (fullName: string, rowIndex: number) => {
    const row = rows[rowIndex];
    const info = row?.refs.find((candidate) => candidate.fullName === fullName);
    if (!info || !row) return;
    if (info.kind === "tag") void checkoutCommit(row);
    else if (!info.isHead) void checkout(repoId, info.name, { tabId });
  };
  const activateRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (!isCommitRow(row)) {
      openDetails(index);
      return;
    }
    const locals = row.refs.filter((ref) => ref.kind === "local");
    const remotes = row.refs.filter((ref) => ref.kind === "remote");
    // The checked-out branch is already here: nothing to do.
    if (locals.some((ref) => ref.isHead)) return;
    if (locals[0]) void checkout(repoId, locals[0].name, { tabId });
    else if (remotes[0]) void checkout(repoId, remotes[0].name, { tabId });
    else void checkoutCommit(row);
  };

  // --- Ziehen von Ref-Labels ----------------------------------------------------------------------
  const drag = useRefDrag({
    scrollerRef,
    canDrag: (source) => source.kind === "local" || source.kind === "remote",
    resolveTarget: (source, under) => {
      if (under.label && under.label.fullName !== source.fullName) {
        const ref = refByFull.get(under.label.fullName);
        if (ref && ref.kind !== "tag") return { fullName: ref.fullName, element: under.label.element };
      }
      if (under.row) {
        const candidate = rowsRef.current[under.row.index]?.refs.find((ref) => ref.kind !== "tag" && ref.fullName !== source.fullName);
        if (candidate && refByFull.has(candidate.fullName)) return { fullName: candidate.fullName, element: under.row.element };
      }
      return null;
    },
    onDrop: (source, target, point) => {
      const from = refByFull.get(source.fullName);
      const to = refByFull.get(target.fullName);
      if (!from || !to) return;
      openMenu({
        entries: dropMenu({ repoId, tabId, source: from, target: to }),
        label: t("commitGraph.menu.dropped", { from: from.name, to: to.name }),
        ...point,
        restore: () => focusRow(source.rowIndex),
      });
    },
  });

  // --- Events of the list (one handler for all rows) ---------------------------------------------
  const indexOf = (element: Element | null, attribute: string) => {
    const value = element?.getAttribute(attribute);
    const index = value === null || value === undefined ? NaN : Number(value);
    return Number.isInteger(index) && index >= 0 ? index : -1;
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    if (target.closest("button")) return;
    const index = indexOf(target.closest("[data-row-index]"), "data-row-index");
    if (index < 0) return;
    select(index, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single");
  };

  const onDoubleClick = (event: MouseEvent) => {
    const target = event.target as Element;
    if (target.closest("button") || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const label = target.closest("[data-ref-full]");
    if (label) {
      activateRef(label.getAttribute("data-ref-full") ?? "", indexOf(label, "data-ref-row"));
      return;
    }
    const index = indexOf(target.closest("[data-row-index]"), "data-row-index");
    if (index >= 0) activateRow(index);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    // The menu key additionally fires its own contextmenu event; the menu is already open by then.
    if (Date.now() - keyboardMenuAt.current < 400) return;
    const target = event.target as Element;
    const point = { x: event.clientX, y: event.clientY };
    const label = target.closest("[data-ref-full]");
    const index = label ? indexOf(label, "data-ref-row") : indexOf(target.closest("[data-row-index]"), "data-row-index");
    if (index < 0) return;
    if (label) {
      const row = rows[index];
      if (row && (rowFlags(useAppStore.getState(), tabId, row) & ROW_SELECTED) === 0) select(index, "single");
      if (openRefMenu(label.getAttribute("data-ref-full") ?? "", index, point)) return;
    }
    openRowMenu(index, point);
  };

  // Pointer over a branch label (including the ghost label): highlight its commits. Over a row: show its ghost label.
  const onPointerOver = (event: ReactPointerEvent) => {
    // While a label is being dragged, the graph stays as it is.
    if (event.pointerType === "mouse" && event.buttons !== 0) return;
    const element = event.target as Element;
    const label = element.closest("[data-ref-full], [data-ghost-ref]");
    const fullName = label?.getAttribute("data-ref-full") ?? label?.getAttribute("data-ghost-ref") ?? null;
    const ref = fullName ? refByFull.get(fullName) : undefined;
    if (ref && ref.kind !== "tag") hoverHighlight(repoId, ref.fullName);
    else endHoverHighlight(repoId);
    const index = indexOf(element.closest("[data-row-index]"), "data-row-index");
    if (index === hoverRow.current) return;
    hoverRow.current = index;
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(updateGhosts);
  };
  const onPointerLeave = () => {
    endHoverHighlight(repoId);
    if (hoverRow.current < 0) return;
    hoverRow.current = -1;
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(updateGhosts);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element;
    if (target.closest("button") || !target.closest("[data-row-index]")) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const cursor = cursorIndex();
    const page = Math.max(1, Math.floor((scrollerRef.current?.clientHeight ?? rowHeight) / rowHeight) - 1);
    let next: number;
    if (plain && (key === "ArrowDown" || key === "j")) next = cursor + 1;
    else if (plain && (key === "ArrowUp" || key === "k")) next = cursor - 1;
    else if (key === "Home" && !event.altKey) next = 0;
    else if (key === "End" && !event.altKey) next = rows.length - 1;
    else if (plain && key === "PageDown") next = cursor + page;
    else if (plain && key === "PageUp") next = cursor - page;
    else if (plain && !event.shiftKey && (key === "h" || key === "l")) {
      // H follows the line to the (first) parent commit, L back to the child – also across rows of other branches.
      event.preventDefault();
      const row = rows[cursor];
      if (!isCommitRow(row)) return;
      let target = -1;
      if (key === "h") {
        const parent = row.parents[0];
        target = parent ? (indexByKey.get(parent) ?? -1) : -1;
      } else {
        // The nearest child above; one that has this commit as its first parent takes precedence.
        let other = -1;
        for (let index = cursor - 1; index >= 0 && target < 0; index--) {
          const candidate = rows[index];
          if (!isCommitRow(candidate) || !candidate.parents.includes(row.sha)) continue;
          if (candidate.parents[0] === row.sha) target = index;
          else if (other < 0) other = index;
        }
        if (target < 0) target = other;
      }
      if (target >= 0) moveTo(target, false);
      return;
    } else if (plain && !event.shiftKey && key === "b") {
      // B highlights this row's branch – its own label, otherwise the nearest branch that contains the commit.
      event.preventDefault();
      const label = branchLabelOf(rows[cursor]) ?? nearestBranch(rows, cursor)?.ref ?? null;
      if (label) toggleStickyHighlight(repoId, label.fullName);
      else toast({ tone: "info", title: t("commitGraph.highlight.noneTitle"), description: t("commitGraph.highlight.noneText") });
      return;
    } else if (key === "Escape" && plain && !event.shiftKey && currentHighlight(repoId)?.sticky) {
      event.preventDefault();
      clearHighlight(repoId);
      return;
    } else if (plain && !event.shiftKey && key === "Enter") {
      event.preventDefault();
      openDetails(cursor);
      return;
    } else if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const element = rowElement(cursor);
      const rect = element?.getBoundingClientRect();
      const zoom = rootZoom();
      // Below the row, at the start of the message.
      const opened = rect ? openRowMenu(cursor, { x: rect.left + (layout.widths.refs + layout.widths.graph + 8) * zoom, y: rect.bottom }) : false;
      if (opened) keyboardMenuAt.current = Date.now();
      return;
    } else return;
    event.preventDefault();
    moveTo(next, event.shiftKey);
  };

  const onFocus = (event: FocusEvent) => {
    const index = indexOf((event.target as Element).closest("[data-row-index]"), "data-row-index");
    setFocusedIndex(index >= 0 ? index : null);
  };
  const onBlur = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusedIndex(null);
  };

  // --- Nachladen --------------------------------------------------------------------------------
  const lazyLoad = settings?.lazyLoad ?? true;
  const lastVisible = items.length > 0 ? Math.max(...items.slice(-3).map((item) => item.index)) : 0;
  useEffect(() => {
    if (!lazyLoad || !hasNextPage || isFetching || isFetchNextPageError) return;
    if (lastVisible >= rows.length - LOAD_AHEAD) void fetchNextPage({ cancelRefetch: false });
  }, [lazyLoad, hasNextPage, isFetching, isFetchNextPageError, lastVisible, rows.length, fetchNextPage]);
  const footer: FooterState = isFetchingNextPage ? "loading" : isFetchNextPageError ? "error" : hasNextPage ? (lazyLoad ? "loading" : "more") : "end";

  // --- “Show this commit” ---------------------------------------------------------------------------
  const reveal = useAppStore((state) => state.views[tabId]?.reveal ?? null);
  const [seeking, setSeeking] = useState<{ sha: Sha; nonce: number; key?: string } | null>(null);
  const seekBudget = useRef(0);
  const handledReveal = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.nonce === handledReveal.current) return;
    handledReveal.current = reveal.nonce;
    seekBudget.current = REVEAL_PAGES;
    setSeeking(reveal);
  }, [reveal]);
  useEffect(() => {
    if (!seeking) return;
    const index = indexByKey.get(seeking.key ?? seeking.sha);
    if (index !== undefined) {
      virtualizer.scrollToIndex(index, { align: "center" });
      setSeeking(null);
      return;
    }
    if (isFetching) return;
    const name = shortSha(seeking.sha);
    if (!hasNextPage) {
      const filtered = Boolean(viewState && (viewState.hiddenRefs.length > 0 || viewState.soloRefs.length > 0));
      toast({
        tone: "info",
        title: t("commitGraph.reveal.notInView", { sha: name }),
        description: filtered ? t("commitGraph.reveal.filtered") : t("commitGraph.reveal.unreachable"),
        action: filtered ? { label: t("commitGraph.filter.showAll"), onClick: () => void showAllRefs(repoId) } : undefined,
      });
      setSeeking(null);
      return;
    }
    if (seekBudget.current <= 0) {
      const again = seeking;
      toast({
        tone: "info",
        title: t("commitGraph.reveal.further", { sha: name }),
        description: t("commitGraph.reveal.notLoaded", { count: flat.commitCount }),
        action: {
          label: t("commitGraph.reveal.continue"),
          onClick: () => {
            seekBudget.current = REVEAL_PAGES;
            setSeeking({ ...again });
          },
        },
      });
      setSeeking(null);
      return;
    }
    seekBudget.current -= 1;
    void fetchNextPage({ cancelRefetch: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeking, indexByKey, isFetching, hasNextPage]);

  // The active search match is scrolled into view if it is already loaded (loading more is triggered by the search via “show this commit”).
  const activeHit = useAppStore((state) => {
    const search = state.views[tabId]?.search;
    return search && search.active >= 0 ? (search.hits[search.active] ?? null) : null;
  });
  useEffect(() => {
    if (!activeHit) return;
    const index = indexByKeyRef.current.get(activeHit);
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHit]);

  // Close open menus when the list scrolls – otherwise they would sit next to the wrong row.
  useEffect(() => {
    if (!menu) return;
    const scroller = scrollerRef.current;
    const close = () => setMenu(null);
    scroller?.addEventListener("scroll", close, { passive: true });
    return () => scroller?.removeEventListener("scroll", close);
  }, [menu]);

  const rendered = new Set(items.map((item) => item.index));
  const firstVisible = items.find((item) => item.start + item.size > (scrollerRef.current?.scrollTop ?? 0))?.index ?? 0;
  const tabStop = activeIndex >= 0 && rendered.has(activeIndex) ? activeIndex : focusedIndex !== null && rendered.has(focusedIndex) ? focusedIndex : firstVisible;

  return (
    <div
      role="grid"
      aria-label={t("commitGraph.label")}
      aria-multiselectable
      aria-rowcount={hasNextPage ? -1 : rows.length + 1}
      aria-colcount={layout.order.length}
      aria-busy={isFetching || undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      <GraphHeader columns={columns} layout={layout} gutter={box.gutter} onChange={changeColumns} onMenu={openMenu} smart={smart} />
      {target?.sticky ? <HighlightBar repoId={repoId} name={targetRef?.name ?? target.fullName.replace(/^refs\/(heads|remotes)\//, "")} count={highlight ? highlight.count : null} loaded={!hasNextPage} /> : null}
      {seeking ? (
        <div role="status" className="flex h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface px-2 text-sm text-text-muted">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("commitGraph.reveal.seeking", { sha: shortSha(seeking.sha), count: flat.commitCount })}</span>
          <Button size="sm" variant="ghost" onClick={() => setSeeking(null)}>
            {t("commitGraph.cancel")}
          </Button>
        </div>
      ) : null}
      <div ref={scrollerRef} role="rowgroup" data-graph-scroller className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div
          role="presentation"
          className="relative overflow-hidden"
          style={{ height: totalHeight }}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
          onPointerDown={drag.onPointerDown}
          onPointerOver={onPointerOver}
          onPointerLeave={onPointerLeave}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          {box.width > 0 ? (
            <>
              <GraphCanvas scrollerRef={scrollerRef} rows={rows} left={layout.graphLeft} width={layout.widths.graph} totalHeight={rows.length * rowHeight} decor={decor} />
              {items.map((item) => {
                const row = rows[item.index];
                if (!row) {
                  return item.index === rows.length ? (
                    <GraphFooter key="footer" top={item.start} state={footer} count={flat.commitCount} columns={layout.order.length} onMore={() => void fetchNextPage({ cancelRefetch: false })} />
                  ) : null;
                }
                return <GraphRowView key={row.id} row={row} index={item.index} top={item.start} layout={layout} tabStop={item.index === tabStop} shared={shared} />;
              })}
            </>
          ) : null}
        </div>
      </div>
      <PointMenu menu={menu} onClose={() => setMenu(null)} restoreFocus={() => menuRestore.current?.()} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** Commit-Graph. */
export function CommitGraph({ repoId, tabId }: CommitGraphProps) {
  const graph = useGraph(repoId);
  const { data: status } = useStatus(repoId);
  const { data: viewState } = useViewState(repoId);
  const flat = useMemo(() => flatten(graph.data?.pages), [graph.data]);
  const { refetch, isFetching, error, errorUpdatedAt, dataUpdatedAt } = graph;
  const hasData = graph.data !== undefined;
  const stale = error instanceof CoreError && error.code === "stale_state";

  // Refs, HEAD or stashes changed since the first page: silently load from the start.
  const handledStale = useRef(0);
  useEffect(() => {
    if (!stale || isFetching || handledStale.current === errorUpdatedAt) return;
    handledStale.current = errorUpdatedAt;
    void refetch({ cancelRefetch: false });
  }, [stale, isFetching, errorUpdatedAt, refetch]);

  // “Clean” and “changed” switched: the local changes row gains or loses its lane.
  const dirty = status ? changeCount(status) > 0 : null;
  const syncedAt = useRef(0);
  useEffect(() => {
    if (dirty === null || !hasData || isFetching || dirty === flat.hasWip || syncedAt.current === dataUpdatedAt) return;
    syncedAt.current = dataUpdatedAt;
    void refetch({ cancelRefetch: false });
  }, [dirty, hasData, isFetching, flat.hasWip, dataUpdatedAt, refetch]);

  // Hide/solo changed (in the left panel): the graph has different starting points and starts over.
  const filterKey = viewState ? JSON.stringify([viewState.hiddenRefs, viewState.soloRefs]) : null;
  const loadedFilter = useRef<string | null>(null);
  useEffect(() => {
    if (filterKey === null) return;
    const previous = loadedFilter.current;
    loadedFilter.current = filterKey;
    if (previous !== null && previous !== filterKey) void reloadGraph(repoId);
  }, [filterKey, repoId]);

  // “Only current branch, upstream and target”: on as long as this repository has a remembered state.
  const { data: refs } = useRefs(repoId);
  const { data: settings } = useSettings();
  const smartRecord = useSmartRecord(repoId);
  const selection = useMemo(() => smartSelection(refs, settings?.defaultBranchName), [refs, settings?.defaultBranchName]);
  const soloKey = viewState ? viewState.soloRefs.join("\n") : null;
  useEffect(() => {
    // Catch up after a checkout (or when someone changes the solo filter by hand).
    if (smartRecord && soloKey !== null && refs) void syncSmartVisibility(repoId);
  }, [smartRecord, soloKey, refs, settings?.defaultBranchName, repoId]);
  const smartOn = smartRecord !== null;
  const smart = useMemo<SmartToggle>(
    () => ({
      on: smartOn,
      blocked: refs ? smartBlock(repoId) : t("commitGraph.smartLoading"),
      detail: selection ? smartText(selection) : null,
      onToggle: () => void setSmartVisibility(repoId, !smartOn),
    }),
    [smartOn, refs, selection, repoId],
  );
  const detachedSha = status && status.head.kind === "detached" && !status.operation ? status.head.sha : null;

  const filtered = Boolean(viewState && (viewState.hiddenRefs.length > 0 || viewState.soloRefs.length > 0));
  const empty = hasData && flat.rows.length <= 1;
  const state = !hasData ? (graph.isError && !stale ? "error" : "loading") : empty ? "empty" : "ready";

  return (
    <section data-screen="commit-graph" data-state={state} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg">
      {detachedSha ? <DetachedBar repoId={repoId} tabId={tabId} sha={detachedSha} /> : null}
      {filtered && viewState && hasData ? <FilterBar repoId={repoId} view={viewState} smart={smartOn && viewState.soloRefs.length > 0 ? selection : null} /> : null}
      {state === "ready" && graph.isRefetchError && !stale && !isFetching ? (
        <Banner
          tone="danger"
          title={t("commitGraph.stale")}
          actions={
            <Button size="sm" onClick={() => void refetch()}>
              {t("commitGraph.retry")}
            </Button>
          }
        >
          <span className="selectable">{describeError(error).text}</span>
        </Banner>
      ) : null}
      {state === "loading" ? (
        <GraphSkeleton />
      ) : state === "error" ? (
        <GraphError error={error} busy={isFetching} onRetry={() => void refetch()} />
      ) : state === "empty" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
          {filtered && status?.head.kind !== "unborn" ? (
            <EmptyState icon={<Filter className="size-6" aria-hidden />} title={t("commitGraph.empty.filteredTitle")} action={<Button onClick={() => void showAllRefs(repoId)}>{t("commitGraph.filter.showAll")}</Button>}>
              {t("commitGraph.empty.filteredText")}
            </EmptyState>
          ) : (
            <EmptyState
              icon={<GitCommitHorizontal className="size-6" aria-hidden />}
              title={t("commitGraph.empty.title")}
              action={
                <Button
                  onClick={() => {
                    const store = useAppStore.getState();
                    store.selectWip(tabId);
                    store.setRightCollapsed(tabId, false);
                  }}
                >
                  {t("commitGraph.empty.showChanges")}
                </Button>
              }
            >
              {t("commitGraph.empty.text")}
            </EmptyState>
          )}
        </div>
      ) : (
        <GraphGrid repoId={repoId} tabId={tabId} graph={graph} flat={flat} viewState={viewState} detached={detachedSha !== null} smart={smart} />
      )}
    </section>
  );
}
