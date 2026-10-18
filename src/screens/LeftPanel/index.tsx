import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Archive, Cloud, Eye, EyeOff, Focus, GitBranch, Laptop, ListFilter, Minimize2, Plus, RefreshCw, Search, SearchX, Tag, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { core, type Id } from "../../core";
import { checkout, createBranch, deleteBranches, refNameValidator } from "../../app/actions/branches";
import { dropStash, renameStash } from "../../app/actions/stash";
import { createTag, deleteTag } from "../../app/actions/tags";
import { hasOpenDialog } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { openMenuAt } from "../../app/menus/host";
import { qk, queryClient, useRefs, useRemotes, useStashes, useViewState } from "../../app/queries";
import { runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { useBranchHover } from "../../components/graph/useBranchHover";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { PanelSection } from "../../ui/Git";
import { ariaShortcut, formatShortcut } from "../../ui/shortcut";
import { ContextMenu, type MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { dropEntries, rowMenu, sectionMenu, sectionTitles } from "./menus";
import { buildTrees, countLeaves, filterTree, flatten, SECTION_ORDER, STASH_REF, triState, type FlatRow, type SectionKey, type TreeNode, type Tri } from "./model";
import { RefRow, type RowApi } from "./RefRow";
import { SectionRows } from "./SectionRows";
import { currentView, EMPTY_VIEW, patchView, resetVisibility, sectionState, setFolderCollapsed, setSection, toggleHidden, toggleSolo } from "./viewState";
import { ExtraSections, extraSectionEntries } from "./ExtraSections";
import { t } from "../../i18n";

export interface LeftPanelProps {
  repoId: Id;
  tabId: Id;
}

/** Shortcut that jumps into the filter bar (command in src/app/commands/leftpanel.ts). */
export const FILTER_SHORTCUT = "Mod+Alt+F";

/** Height of a stash row: two text lines, corresponds to `h-10` in TreeRow. */
const STASH_ROW_HEIGHT = 40;
/** From this pointer distance on, a pressed pointer counts as dragging. */
const DRAG_THRESHOLD = 6;
const TYPEAHEAD_PAUSE_MS = 700;
const SECTION_ICONS: Record<SectionKey, LucideIcon> = { local: Laptop, remote: Cloud, tags: Tag, stashes: Archive };
const sectionIcon = (key: SectionKey) => {
  const Icon = SECTION_ICONS[key];
  return <Icon aria-hidden />;
};

// Filter text and maximised section per tab – survive collapsing the panel, not a restart.
const filterMemory = new Map<Id, string>();
const maximizedMemory = new Map<Id, SectionKey>();

type MenuTarget = { kind: "row"; id: string } | { kind: "section"; section: SectionKey } | null;

const isBranchNode = (node: TreeNode | undefined | null): node is TreeNode => node?.kind === "branch" || node?.kind === "remote_branch";
const isMenuKey = (event: { key: string; shiftKey: boolean }) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

function readRowHeight(): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gc-size-row"));
  return Number.isFinite(value) && value > 0 ? value : 24;
}

/** Left panel: browse and control branches, remotes, tags and stashes. */
export function LeftPanel({ repoId, tabId }: LeftPanelProps) {
  // Selection, focus and filter belong to exactly one tab.
  return <Panel key={`${repoId}:${tabId}`} repoId={repoId} tabId={tabId} />;
}

function SkeletonRows({ count }: { count: number }) {
  const widths = ["w-28", "w-36", "w-20", "w-32"];
  return (
    <div aria-hidden data-skeleton>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-row items-center gap-1.5 px-2">
          <span className="size-3.5 shrink-0 animate-pulse rounded-sm bg-surface-raised" />
          <span className={cn("h-2.5 animate-pulse rounded-sm bg-surface-raised", widths[index % widths.length])} />
        </div>
      ))}
    </div>
  );
}

function EmptyLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-row items-center gap-2 pr-1 pl-2 text-sm text-text-muted" data-empty>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {action}
    </div>
  );
}

function LoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const { text, hint } = describeError(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-2 border-b border-border px-2 py-3 text-sm" data-load-error>
      <p className="flex items-start gap-1.5 font-medium text-text">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-danger" aria-hidden />
        {title}
      </p>
      <p className="selectable break-words text-text-muted">
        {text}
        {hint ? ` ${hint}` : ""}
      </p>
      <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
        {t("sidebar.retry")}
      </Button>
    </div>
  );
}

function Panel({ repoId, tabId }: LeftPanelProps) {
  const refsQuery = useRefs(repoId);
  const stashesQuery = useStashes(repoId);
  const remotesQuery = useRemotes(repoId);
  const viewQuery = useViewState(repoId);
  const view = viewQuery.data ?? EMPTY_VIEW;
  const viewReady = viewQuery.data !== undefined;
  const store = useAppStore.getState;

  const [query, setQueryState] = useState(() => filterMemory.get(tabId) ?? "");
  const [maximized, setMaximizedState] = useState<SectionKey | null>(() => maximizedMemory.get(tabId) ?? null);
  /** Sections collapsed by hand while filtering – the saved state stays untouched. */
  const [closedWhileFiltering, setClosedWhileFiltering] = useState<SectionKey[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ sourceId: string; targetId: string | null } | null>(null);
  const [menu, setMenu] = useState<MenuTarget>(null);
  const [rowHeight] = useState(readRowHeight);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Pointer or keyboard focus on a branch highlights its commits in the graph.
  const branchHover = useBranchHover(repoId);
  const filterRef = useRef<HTMLInputElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostAt = useRef({ x: 0, y: 0 });
  const anchorRef = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const suppressClick = useRef(false);
  const typeahead = useRef({ text: "", at: 0 });
  const stopDrag = useRef<(() => void) | null>(null);

  const setQuery = (value: string) => {
    if (value) filterMemory.set(tabId, value);
    else filterMemory.delete(tabId);
    setQueryState(value);
    setClosedWhileFiltering([]);
  };
  const setMaximized = (section: SectionKey | null) => {
    if (section) maximizedMemory.set(tabId, section);
    else maximizedMemory.delete(tabId);
    setMaximizedState(section);
  };

  // --- Data → trees → visible rows ------------------------------------------------------------
  const trees = useMemo(() => buildTrees(refsQuery.data, remotesQuery.data, stashesQuery.data), [refsQuery.data, remotesQuery.data, stashesQuery.data]);
  const filtering = query.trim().length > 0;
  const filtered = useMemo(
    () => ({
      local: filterTree(trees.local, query),
      remote: filterTree(trees.remote, query),
      tags: filterTree(trees.tags, query),
      stashes: filterTree(trees.stashes, query),
    }),
    [trees, query],
  );
  const collapsedFolders = useMemo(() => new Set(view.collapsedFolders), [view.collapsedFolders]);
  const rowsBySection = useMemo(
    () => ({
      local: flatten(filtered.local, collapsedFolders, filtering),
      remote: flatten(filtered.remote, collapsedFolders, filtering),
      tags: flatten(filtered.tags, collapsedFolders, filtering),
      stashes: flatten(filtered.stashes, collapsedFolders, filtering),
    }),
    [filtered, collapsedFolders, filtering],
  );
  const totals = useMemo(
    () => ({ local: countLeaves(trees.local), remote: countLeaves(trees.remote), tags: countLeaves(trees.tags), stashes: trees.stashes.length }),
    [trees],
  );
  const matched = useMemo(
    () => ({ local: countLeaves(filtered.local), remote: countLeaves(filtered.remote), tags: countLeaves(filtered.tags), stashes: filtered.stashes.length }),
    [filtered],
  );
  /** Sections with folders or remotes: there, leaves are indented by the width of the arrow. */
  const gutters = useMemo(() => {
    const hasContainers = (nodes: TreeNode[]) => nodes.some((node) => node.kind === "folder" || node.kind === "remote");
    return { local: hasContainers(trees.local), remote: hasContainers(trees.remote), tags: hasContainers(trees.tags), stashes: false };
  }, [trees]);
  /** Names per section that the section header's hide and solo act on. */
  const sectionNames = useMemo(
    () => ({
      local: trees.local.flatMap((node) => node.refNames),
      remote: trees.remote.flatMap((node) => node.refNames),
      tags: trees.tags.flatMap((node) => node.refNames),
      stashes: trees.stashes.length ? [STASH_REF] : [],
    }),
    [trees],
  );

  const hiddenSet = useMemo(() => new Set(view.hiddenRefs), [view.hiddenRefs]);
  const soloSet = useMemo(() => new Set(view.soloRefs), [view.soloRefs]);
  // Solo only applies while one of the solo refs still exists (the graph computes it the same way).
  const soloActive = useMemo(
    () => [...sectionNames.local, ...sectionNames.remote, ...sectionNames.tags].some((name) => soloSet.has(name)),
    [sectionNames, soloSet],
  );
  const viewFiltered = view.hiddenRefs.length > 0 || view.soloRefs.length > 0;

  const sections = useMemo(() => {
    const info = {} as Record<SectionKey, { collapsed: boolean; hidden: boolean }>;
    for (const key of SECTION_ORDER) info[key] = sectionState(view, key);
    return info;
  }, [view]);
  const visibleSections = SECTION_ORDER.filter((key) => !sections[key].hidden);
  const maximizedSection = maximized && visibleSections.includes(maximized) ? maximized : null;
  const shownSections = maximizedSection ? [maximizedSection] : visibleSections;
  const isOpen = (key: SectionKey) => (filtering ? !closedWhileFiltering.includes(key) : !sections[key].collapsed);

  const refsFailed = refsQuery.isError && !refsQuery.data;
  const refsLoading = refsQuery.isPending;
  const sectionHasRows = (key: SectionKey) => (key === "stashes" ? !stashesQuery.isPending : !refsLoading && !refsFailed);

  /** All rows currently visible, top to bottom – the order of the arrow keys. */
  const allRows: FlatRow[] = [];
  for (const key of shownSections) if (isOpen(key) && sectionHasRows(key)) allRows.push(...rowsBySection[key]);
  const rowIndex = new Map<string, number>();
  allRows.forEach((row, index) => rowIndex.set(row.node.id, index));
  const rowOf = (id: string | null | undefined): FlatRow | undefined => (id ? allRows[rowIndex.get(id) ?? -1] : undefined);
  const focusableId = activeId && rowIndex.has(activeId) ? activeId : (allRows[0]?.node.id ?? null);
  const totalMatched = shownSections.reduce((sum, key) => sum + matched[key], 0);

  const hiddenOf = (node: TreeNode): Tri => (node.kind === "stash" ? "none" : triState(node.refNames, hiddenSet));
  const soloOf = (node: TreeNode): Tri => (node.kind === "stash" ? "none" : triState(node.refNames, soloSet));
  const dimmedOf = (node: TreeNode): boolean => {
    if (node.kind === "stash") return hiddenSet.has(STASH_REF);
    if (!node.refNames.length) return false;
    if (triState(node.refNames, hiddenSet) === "all") return true;
    return soloActive && triState(node.refNames, soloSet) === "none";
  };

  // --- Focus and selection ----------------------------------------------------------------------
  const rowElement = (id: string) => scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`) ?? null;
  const focusRow = (id: string) => {
    setActiveId(id);
    pendingFocus.current = id;
  };
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const element = rowElement(id);
    if (!element) return;
    pendingFocus.current = null;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
  });

  const selectOnly = (id: string) => {
    setSelected([id]);
    anchorRef.current = id;
  };
  /** Marks the local branches between the anchor and `id` (only branches can be multi-selected). */
  const selectRange = (id: string) => {
    const branches = rowsBySection.local.filter((row) => row.node.kind === "branch").map((row) => row.node.id);
    const from = branches.indexOf(anchorRef.current ?? "");
    const to = branches.indexOf(id);
    if (from < 0 || to < 0) return selectOnly(id);
    const range = branches.slice(Math.min(from, to), Math.max(from, to) + 1).filter((item) => item !== id);
    setSelected([...range, id]);
  };
  const selectedBranchesFor = (node: TreeNode): TreeNode[] => {
    if (node.kind !== "branch" || !selected.includes(node.id)) return [];
    return rowsBySection.local.filter((row) => row.node.kind === "branch" && selected.includes(row.node.id)).map((row) => row.node);
  };

  // --- Actions -----------------------------------------------------------------------------------
  const reveal = (node: TreeNode) => {
    if (node.ref) store().revealCommit(tabId, node.ref.sha);
    // A stash is its own graph row, not the commit row of its SHA.
    else if (node.stash) store().selectStash(tabId, node.stash.index, node.stash.sha);
    else if (node.head?.kind === "detached") store().revealCommit(tabId, node.head.sha);
  };

  const toggleExpanded = (row: FlatRow) => {
    // While filtering all folders are open so no match stays hidden.
    if (row.expanded === undefined || filtering || !viewReady) return;
    // The state comes from the cache, not from the last render: otherwise two quick clicks would not cancel out.
    const collapsed = currentView(repoId).collapsedFolders.includes(row.node.id);
    void setFolderCollapsed(repoId, row.node.id, !collapsed);
  };

  /** Main action: check out a branch, view a stash, expand or collapse a folder. */
  const activate = async (row: FlatRow) => {
    const { node } = row;
    if (isBranchNode(node) && node.ref) {
      if (node.ref.isHead || busyId) return;
      setBusyId(node.id);
      const result = await checkout(repoId, node.ref.name, { tabId });
      setBusyId(null);
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
      // The remote branch has become a local one: that one is now in the selection.
      if (node.kind === "remote_branch" && node.ref.remote) selectOnly(`refs/heads/${node.ref.name.slice(node.ref.remote.length + 1)}`);
      return;
    }
    if (node.stash) return store().selectStash(tabId, node.stash.index, node.stash.sha);
    if (row.expanded !== undefined) return toggleExpanded(row);
    reveal(node);
  };

  const remove = (node: TreeNode) => {
    if (node.kind === "branch" && node.ref) {
      const group = selectedBranchesFor(node);
      const names = group.length > 1 ? group.flatMap((item) => (item.ref ? [item.ref.name] : [])) : [node.ref.name];
      return void deleteBranches(repoId, names);
    }
    if (node.kind === "tag" && node.ref) return void deleteTag(repoId, node.ref.name);
    if (node.stash) return void dropStash(repoId, node.stash);
  };

  const startRename = (node: TreeNode, delayed = false) => {
    if (node.stash) return void renameStash(repoId, node.stash);
    if (node.kind !== "branch" || !node.ref) return;
    // From within the menu: first wait until it is closed and has returned focus.
    if (delayed) window.setTimeout(() => setEditingId(node.id), 60);
    else setEditingId(node.id);
  };

  const rename = async (node: TreeNode, name: string): Promise<string | null> => {
    if (!node.ref) return null;
    const oldFull = node.ref.fullName;
    const result = await runAction(t("sidebar.menu.rename"), () => core.branchRename({ repoId, name: node.ref!.name, newName: name }), {
      quiet: ["invalid_name", "name_exists"],
      success: t("sidebar.renamed", { name }),
    });
    if (!result.ok) return describeError(result.error).text;
    queryClient.setQueryData(qk.refs(repoId), result.value);
    const newFull = `refs/heads/${name}`;
    // Hide and solo are tied to the full name: they move along.
    const current = currentView(repoId);
    if (current.hiddenRefs.includes(oldFull) || current.soloRefs.includes(oldFull)) {
      const swap = (list: string[]) => list.map((item) => (item === oldFull ? newFull : item));
      void patchView(repoId, { hiddenRefs: swap(current.hiddenRefs), soloRefs: swap(current.soloRefs) });
    }
    setEditingId(null);
    selectOnly(newFull);
    focusRow(newFull);
    return null;
  };

  const endRename = (refocus: boolean) => {
    const id = editingId;
    setEditingId(null);
    if (refocus && id) focusRow(id);
  };

  const toggleSection = (key: SectionKey) => {
    if (filtering) {
      setClosedWhileFiltering((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]));
      return;
    }
    if (!viewReady) return;
    // Read from the cache: in a double click the two clicks follow each other faster than a render.
    void setSection(repoId, key, { collapsed: !sectionState(currentView(repoId), key).collapsed });
  };
  const toggleMaximized = (key: SectionKey) => {
    if (maximizedSection === key) return setMaximized(null);
    setMaximized(key);
    // A maximised section is open – otherwise an empty header would fill the panel.
    if (filtering) setClosedWhileFiltering((list) => list.filter((item) => item !== key));
    else if (viewReady && sectionState(currentView(repoId), key).collapsed) void setSection(repoId, key, { collapsed: false });
  };
  const setSectionVisible = (key: SectionKey, visible: boolean) => {
    if (!viewReady) return;
    if (!visible && visibleSections.length <= 1 && visibleSections.includes(key)) return;
    if (!visible && maximizedSection === key) setMaximized(null);
    void setSection(repoId, key, { hidden: !visible });
  };

  // The rows are memoised; they get functions that never change and always see the latest state.
  const live = { rename, endRename, viewReady };
  const liveRef = useRef(live);
  liveRef.current = live;
  const api = useMemo<RowApi>(
    () => ({
      toggleHide: (node) => void (liveRef.current.viewReady && toggleHidden(repoId, node.refNames)),
      toggleSolo: (node) => void (liveRef.current.viewReady && toggleSolo(repoId, node.refNames)),
      validateName: refNameValidator(repoId, "branch"),
      rename: (node, name) => liveRef.current.rename(node, name),
      endRename: (refocus) => liveRef.current.endRename(refocus),
    }),
    [repoId],
  );

  // --- Context menu ------------------------------------------------------------------------------
  /** Opens the menu at an element – for the menu key and Shift+F10. */
  const openContextMenuFor = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: rect.left + Math.min(rect.width / 2, 48), clientY: rect.bottom - 2 }),
    );
  };

  const onContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Worktrees and submodules bring their own menu.
    if (target.closest("[data-extra-section]")) return;
    // In the input the menu with copy and paste belongs there.
    if (target.closest("input")) {
      event.stopPropagation();
      return;
    }
    const rowEl = target.closest<HTMLElement>("[data-row-id]");
    const id = rowEl?.dataset.rowId;
    if (id && rowIndex.has(id)) {
      if (!selected.includes(id)) selectOnly(id);
      setActiveId(id);
      setMenu({ kind: "row", id });
      return;
    }
    const section = target.closest("[data-section-header]")?.closest<HTMLElement>("[data-section]")?.dataset.section as SectionKey | undefined;
    if (section) {
      setMenu({ kind: "section", section });
      return;
    }
    // Empty area: no menu, not even the WebView's.
    event.preventDefault();
    event.stopPropagation();
  };

  let menuEntries: MenuEntry[] = [];
  if (menu?.kind === "row") {
    const row = rowOf(menu.id);
    if (row) {
      const { node } = row;
      const remote = node.kind === "remote" ? (node.remote ?? null) : null;
      menuEntries = rowMenu({
        repoId,
        tabId,
        node,
        expanded: filtering ? undefined : row.expanded,
        hidden: hiddenOf(node),
        solo: soloOf(node),
        canToggle: viewReady,
        selectedBranches: selectedBranchesFor(node),
        remote,
        toggleExpanded: () => toggleExpanded(row),
        toggleHide: () => api.toggleHide(node),
        toggleSolo: () => api.toggleSolo(node),
        startRename: () => startRename(node, true),
        reveal: () => reveal(node),
        activate: () => void activate(row),
        remove: () => remove(node),
      });
    }
  } else if (menu?.kind === "section") {
    const key = menu.section;
    menuEntries = sectionMenu({
      section: key,
      collapsed: !isOpen(key),
      maximized: maximizedSection === key,
      hidden: triState(sectionNames[key], hiddenSet),
      solo: key === "stashes" ? "none" : triState(sectionNames[key], soloSet),
      canToggle: viewReady,
      hasRefs: sectionNames[key].length > 0,
      visible: { local: !sections.local.hidden, remote: !sections.remote.hidden, tags: !sections.tags.hidden, stashes: !sections.stashes.hidden },
      toggleCollapsed: () => toggleSection(key),
      toggleMaximized: () => toggleMaximized(key),
      toggleHide: () => void toggleHidden(repoId, sectionNames[key]),
      toggleSolo: () => void toggleSolo(repoId, sectionNames[key]),
      setVisible: setSectionVisible,
    });
    // Worktrees and submodules can be shown again here.
    menuEntries = [...menuEntries, ...extraSectionEntries(repoId, view)];
  }
  if (!menuEntries.length) menuEntries = [{ label: t("sidebar.menu.none"), disabled: true }];

  // --- Mouse-------------------------------------------------------------------------------------------
  const rowFromEvent = (event: { target: EventTarget }): FlatRow | undefined => {
    const target = event.target as HTMLElement;
    if (target.closest("button, input")) return undefined;
    return rowOf(target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) return;
    const row = rowFromEvent(event);
    if (!row) return;
    const { node } = row;
    setActiveId(node.id);
    if ((event.ctrlKey || event.metaKey) && node.kind === "branch") {
      // Ctrl+click collects local branches (for "delete several").
      const branches = selected.filter((id) => rowOf(id)?.node.kind === "branch");
      setSelected(branches.includes(node.id) ? branches.filter((id) => id !== node.id) : [...branches, node.id]);
      anchorRef.current = node.id;
      return;
    }
    if (event.shiftKey && node.kind === "branch") return selectRange(node.id);
    selectOnly(node.id);
    // The second click of a double click does not immediately collapse again.
    if (row.expanded !== undefined) {
      if (event.detail < 2) toggleExpanded(row);
      return;
    }
    reveal(node);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const row = rowFromEvent(event);
    if (!row || row.expanded !== undefined || editingId) return;
    void activate(row);
  };

  // --- Dragging a branch onto another (pointer events, no HTML5 drag and drop) ---
  const liveRows = { rowOf };
  const liveRowsRef = useRef(liveRows);
  liveRowsRef.current = liveRows;

  const placeGhost = () => {
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${ghostAt.current.x + 14}px, ${ghostAt.current.y + 10}px)`;
  };
  useLayoutEffect(placeGhost);
  useEffect(() => () => stopDrag.current?.(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || editingId) return;
    const row = rowFromEvent(event);
    if (!row || !isBranchNode(row.node)) return;
    const sourceId = row.node.id;
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let targetId: string | null = null;

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      stopDrag.current = null;
      if (!dragging) return;
      document.body.style.cursor = "";
      setDrag(null);
      // The click that follows the release selects nothing.
      window.setTimeout(() => (suppressClick.current = false), 0);
    };
    const onMove = (move: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_THRESHOLD) return;
        dragging = true;
        suppressClick.current = true;
        document.body.style.cursor = "grabbing";
        setDrag({ sourceId, targetId: null });
      }
      ghostAt.current = { x: move.clientX, y: move.clientY };
      placeGhost();
      // Keep scrolling at the edge of the panel
      const scroller = scrollRef.current;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (move.clientY < box.top + rowHeight) scroller.scrollTop -= rowHeight / 2;
        else if (move.clientY > box.bottom - rowHeight) scroller.scrollTop += rowHeight / 2;
      }
      const under = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
      const candidate = under && under !== sourceId && isBranchNode(liveRowsRef.current.rowOf(under)?.node) ? under : null;
      if (candidate !== targetId) {
        targetId = candidate;
        setDrag({ sourceId, targetId });
      }
    };
    const onUp = (up: PointerEvent) => {
      const drop = dragging && targetId ? { sourceId, targetId } : null;
      finish();
      if (!drop) return;
      const source = liveRowsRef.current.rowOf(drop.sourceId)?.node;
      const target = liveRowsRef.current.rowOf(drop.targetId)?.node;
      // Menu at the drop location; without a choice (Esc, click elsewhere) nothing happens.
      if (source && target) openMenuAt({ x: up.clientX, y: up.clientY }, dropEntries({ repoId, tabId, source, target }), t("sidebar.dropBranch"));
    };
    const onCancel = () => finish();
    const onKey = (key: globalThis.KeyboardEvent) => {
      if (key.key !== "Escape" || !dragging) return;
      key.preventDefault();
      key.stopPropagation();
      finish();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    stopDrag.current = finish;
  };

  // --- Keyboard ----------------------------------------------------------------------------------------
  const moveTo = (row: FlatRow | undefined, extend = false) => {
    if (!row) return;
    focusRow(row.node.id);
    if (extend && row.node.kind === "branch") selectRange(row.node.id);
    else selectOnly(row.node.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // If a modal dialog is open and focus still lands here, no key triggers anything in the tree.
    if (hasOpenDialog() || document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
    if (isMenuKey(event)) {
      const anchor = target.closest<HTMLElement>("[data-row-id]") ?? target.closest<HTMLElement>("[data-section-header]");
      if (!anchor || target.closest("input")) return;
      event.preventDefault();
      // On Windows only releasing the key opens the WebView's menu – this replaces it.
      window.addEventListener("keyup", (up) => up.preventDefault(), { capture: true, once: true });
      openContextMenuFor(anchor);
      return;
    }
    if (!target.matches("[data-row-id]")) return;
    const index = rowIndex.get(target.dataset.rowId ?? "");
    const row = index === undefined ? undefined : allRows[index];
    if (index === undefined || !row) return;
    const { node } = row;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        return moveTo(allRows[index + 1], event.shiftKey);
      case "ArrowUp":
        event.preventDefault();
        if (index === 0) return filterRef.current?.focus();
        return moveTo(allRows[index - 1], event.shiftKey);
      case "Home":
        event.preventDefault();
        return moveTo(allRows[0]);
      case "End":
        event.preventDefault();
        return moveTo(allRows[allRows.length - 1]);
      case "ArrowRight":
        event.preventDefault();
        if (row.expanded === false) return toggleExpanded(row);
        if (row.expanded === true && allRows[index + 1]?.parentId === node.id) return moveTo(allRows[index + 1]);
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (row.expanded === true && !filtering) return toggleExpanded(row);
        if (row.parentId) return moveTo(rowOf(row.parentId));
        return;
      case "Enter":
        event.preventDefault();
        selectOnly(node.id);
        return void activate(row);
      case " ":
        if (typeahead.current.text && Date.now() - typeahead.current.at < TYPEAHEAD_PAUSE_MS) break;
        event.preventDefault();
        selectOnly(node.id);
        return reveal(node);
      case "F2":
        event.preventDefault();
        return startRename(node);
      case "Delete":
        event.preventDefault();
        return remove(node);
      case "Escape":
        if (selected.length > 1) {
          event.preventDefault();
          selectOnly(node.id);
        }
        return;
    }

    // Typing jumps to the next entry whose name starts that way.
    if (plain && event.key.length === 1) {
      const now = Date.now();
      const buffer = typeahead.current;
      const key = event.key.toLowerCase();
      buffer.text = now - buffer.at > TYPEAHEAD_PAUSE_MS ? key : buffer.text + key;
      buffer.at = now;
      const repeated = [...buffer.text].every((char) => char === buffer.text[0]);
      const needle = repeated ? (buffer.text[0] ?? key) : buffer.text;
      const offset = repeated || buffer.text.length === 1 ? 1 : 0;
      for (let step = 0; step < allRows.length; step++) {
        const candidate = allRows[(index + offset + step) % allRows.length];
        if (candidate?.node.label.toLowerCase().startsWith(needle)) {
          event.preventDefault();
          return moveTo(candidate);
        }
      }
    }
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (query) {
        event.preventDefault();
        setQuery("");
      }
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      const first = allRows[0];
      if (!first) return;
      event.preventDefault();
      moveTo(first);
    }
  };

  // --- Rendering -----------------------------------------------------------------------------------
  const renderRow = (row: FlatRow) => {
    const { node } = row;
    return (
      <RefRow
        key={node.id}
        row={row}
        query={query}
        selected={selected.includes(node.id)}
        focusable={focusableId === node.id}
        hidden={hiddenOf(node)}
        solo={soloOf(node)}
        dimmed={dimmedOf(node)}
        canToggle={viewReady}
        dragging={drag?.sourceId === node.id}
        dropTarget={drag?.targetId === node.id}
        busy={busyId === node.id}
        editing={editingId === node.id}
        gutter={gutters[node.section]}
        api={api}
      />
    );
  };

  const sectionBody = (key: SectionKey): ReactNode => {
    if (key === "stashes") {
      if (stashesQuery.isPending) return <SkeletonRows count={1} />;
      if (stashesQuery.isError && !stashesQuery.data) {
        return <LoadError title={t("sidebar.stashesFailed")} error={stashesQuery.error} onRetry={() => void stashesQuery.refetch()} />;
      }
    } else if (refsLoading) {
      return <SkeletonRows count={key === "local" ? 4 : 2} />;
    }
    const rows = rowsBySection[key];
    if (rows.length === 0) {
      if (filtering) return totals[key] > 0 ? <EmptyLine>{t("sidebar.noMatch")}</EmptyLine> : null;
      if (key === "remote") {
        return (
          <EmptyLine
            action={
              <Button size="sm" variant="ghost" onClick={() => store().openOverlay({ kind: "add_remote" })}>
                {t("sidebar.addRemote")}
              </Button>
            }
          >
            {t("sidebar.noRemote")}
          </EmptyLine>
        );
      }
      return <EmptyLine>{key === "local" ? t("sidebar.noLocal") : key === "tags" ? t("sidebar.noTags") : t("sidebar.noStashes")}</EmptyLine>;
    }
    return (
      <SectionRows
        label={sectionTitles[key]}
        rows={rows}
        rowHeight={key === "stashes" ? STASH_ROW_HEIGHT : rowHeight}
        scrollRef={scrollRef}
        keepIndex={rows.findIndex((row) => row.node.id === focusableId)}
        multiselectable={key === "local"}
        renderRow={renderRow}
      />
    );
  };

  const sectionHeaderActions = (key: SectionKey) => {
    const hidden = triState(sectionNames[key], hiddenSet);
    const solo = key === "stashes" ? "none" : triState(sectionNames[key], soloSet);
    const title = sectionTitles[key];
    const canToggle = viewReady && sectionNames[key].length > 0;
    const soloButton =
      canToggle && key !== "stashes" ? (
        <IconButton
          key="solo"
          size="sm"
          tabIndex={-1}
          data-toggle="solo"
          label={solo === "all" ? t("sidebar.toggle.soloEnd") : t("sidebar.section.solo", { title })}
          active={solo === "all"}
          icon={<Focus className="size-3.5" aria-hidden />}
          onClick={() => void toggleSolo(repoId, sectionNames[key])}
        />
      ) : null;
    const hideButton = canToggle ? (
      <IconButton
        key="hide"
        size="sm"
        tabIndex={-1}
        data-toggle="hide"
        label={hidden === "all" ? t("sidebar.header.show", { title }) : t("sidebar.header.hide", { title })}
        active={hidden === "all"}
        icon={hidden === "none" ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
        onClick={() => void toggleHidden(repoId, sectionNames[key])}
      />
    ) : null;
    const add: Record<SectionKey, { label: string; run: () => void }> = {
      local: { label: t("sidebar.add.branch"), run: () => void createBranch(repoId) },
      remote: { label: t("sidebar.addRemote"), run: () => store().openOverlay({ kind: "add_remote" }) },
      tags: { label: t("sidebar.add.tag"), run: () => void createTag(repoId, null) },
      stashes: { label: t("sidebar.add.stash"), run: () => store().openStashForm(tabId) },
    };
    const addButton = (
      <IconButton key="add" size="sm" data-action="add" label={add[key].label} icon={<Plus className="size-3.5" aria-hidden />} onClick={add[key].run} />
    );
    const restoreButton =
      maximizedSection === key ? (
        <IconButton key="restore" size="sm" data-action="restore" label={t("sidebar.section.showAll")} active icon={<Minimize2 className="size-3.5" aria-hidden />} onClick={() => setMaximized(null)} />
      ) : null;
    return {
      actions: [solo === "none" ? soloButton : null, hidden === "none" ? hideButton : null, addButton],
      pinned: [solo !== "none" ? soloButton : null, hidden !== "none" ? hideButton : null, restoreButton].filter(Boolean),
    };
  };

  const filterHint = formatShortcut(FILTER_SHORTCUT);
  const filterSummary = [view.hiddenRefs.length ? t("sidebar.summary.hidden", { count: view.hiddenRefs.length }) : null, view.soloRefs.length ? t("sidebar.summary.solo", { count: view.soloRefs.length }) : null]
    .filter(Boolean)
    .join(", ");
  const dragSource = drag ? rowOf(drag.sourceId)?.node : undefined;
  const dragTarget = drag?.targetId ? rowOf(drag.targetId)?.node : undefined;
  const nothingFound = filtering && totalMatched === 0 && !refsLoading && !refsFailed;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-screen="sidebar" data-ready={refsLoading ? undefined : ""}>
      <div className="shrink-0 border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-muted" aria-hidden />
          <input
            ref={filterRef}
            type="text"
            role="searchbox"
            data-left-filter
            aria-label={t("sidebar.filter.label")}
            aria-keyshortcuts={ariaShortcut(FILTER_SHORTCUT)}
            placeholder={t("sidebar.filter.placeholder", { shortcut: filterHint })}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFilterKeyDown}
            className="h-control-sm w-full rounded-md border border-border-input bg-surface-sunken pr-7 pl-7 text-base text-text placeholder:text-text-muted hover:border-text-muted focus-visible:border-accent"
          />
          {query ? (
            <IconButton
              size="xs"
              label={t("sidebar.filter.clear")}
              shortcut="Esc"
              icon={<X className="size-3.5" aria-hidden />}
              className="absolute top-1/2 right-0.5 -translate-y-1/2"
              onClick={() => {
                setQuery("");
                filterRef.current?.focus();
              }}
            />
          ) : null}
        </div>
      </div>

      {viewFiltered ? (
        <div role="status" data-view-filtered className="flex h-control-md shrink-0 items-center gap-1.5 border-b border-border bg-accent-surface pr-1 pl-2 text-sm">
          <ListFilter className="size-3.5 shrink-0 text-accent" aria-hidden />
          <Tip label={t("sidebar.viewFiltered.tip", { summary: filterSummary })} side="right">
            <span className="min-w-0 flex-1 truncate">
              {t("sidebar.viewFiltered.title")}
              <span className="sr-only">: {filterSummary}</span>
            </span>
          </Tip>
          <Button size="sm" variant="ghost" className="-my-1" onClick={() => void resetVisibility(repoId)}>
            {t("sidebar.viewFiltered.reset")}
          </Button>
        </div>
      ) : null}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-left-scroll>
        <ContextMenu entries={menuEntries}>
          <div
            className="min-h-full"
            onContextMenuCapture={onContextMenuCapture}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            {...branchHover}
          >
            {refsFailed ? (
              <LoadError title={t("sidebar.refsFailed")} error={refsQuery.error} onRetry={() => void refsQuery.refetch()} />
            ) : null}

            {nothingFound ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center" data-no-hits>
                <SearchX className="size-6 text-text-muted" aria-hidden />
                <p className="max-w-full font-medium break-words text-text">{t("sidebar.noHits.title", { query: query.trim() })}</p>
                <p className="text-sm text-text-muted">{t("sidebar.noHits.text")}</p>
                <Button size="sm" onClick={() => setQuery("")}>
                  {t("sidebar.filter.clear")}
                </Button>
              </div>
            ) : (
              shownSections.map((key) => {
                if (refsFailed && key !== "stashes") return null;
                const { actions, pinned } = sectionHeaderActions(key);
                const loading = key === "stashes" ? stashesQuery.isPending : refsLoading;
                return (
                  <PanelSection
                    key={key}
                    data-section={key}
                    data-maximized={maximizedSection === key ? "" : undefined}
                    title={sectionTitles[key]}
                    icon={sectionIcon(key)}
                    count={loading ? undefined : filtering && totals[key] > 0 ? `${matched[key]}/${totals[key]}` : totals[key]}
                    open={isOpen(key)}
                    onOpenChange={() => toggleSection(key)}
                    onHeaderDoubleClick={() => toggleMaximized(key)}
                    stickyHeader
                    actions={actions}
                    pinnedActions={pinned.length ? pinned : undefined}
                  >
                    {sectionBody(key)}
                  </PanelSection>
                );
              })
            )}

            {maximizedSection ? null : <ExtraSections repoId={repoId} tabId={tabId} query={query} />}

            {visibleSections.length === 0 ? (
              <EmptyLine
                action={
                  <Button size="sm" variant="ghost" onClick={() => void patchView(repoId, { sections: view.sections.map((section) => ({ ...section, hidden: false })) })}>
                    {t("sidebar.allHidden.show")}
                  </Button>
                }
              >
                {t("sidebar.allHidden.text")}
              </EmptyLine>
            ) : null}
          </div>
        </ContextMenu>
      </div>

      {drag && dragSource ? (
        <div
          ref={ghostRef}
          aria-hidden
          data-drag-ghost
          className="pointer-events-none fixed top-0 left-0 z-50 flex h-row max-w-64 items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 text-sm text-text shadow-pop"
        >
          <GitBranch className="size-3.5 shrink-0 text-text-muted" aria-hidden />
          <span className="truncate">{dragSource.ref?.name ?? dragSource.label}</span>
          {dragTarget ? <span className="shrink-0 text-text-muted">→ {dragTarget.label}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
