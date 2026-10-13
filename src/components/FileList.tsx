import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { ChevronRight, Folder, FolderOpen, List, ListTree } from "lucide-react";
import type { FileChange } from "../core";
import { StatusBadge } from "../ui/Git";
import { ContextMenu, type MenuEntry } from "../ui/Menu";
import { cn } from "../ui/cn";
import { SegmentedControl } from "../ui/Field";
import { locale, t } from "../i18n";

/** Switch between flat list and folder tree, the same in every file panel. */
export function FileLayoutSwitch({ value, onChange }: { value: FileListView; onChange: (view: FileListView) => void }) {
  return (
    <SegmentedControl<FileListView>
      iconOnly
      label={t("graph.fileList.layout")}
      value={value}
      onValueChange={onChange}
      options={[
        { value: "flat", label: t("graph.fileList.layoutList"), icon: <List className="size-icon" aria-hidden /> },
        { value: "tree", label: t("graph.fileList.layoutTree"), icon: <ListTree className="size-icon" aria-hidden /> },
      ]}
    />
  );
}

/** From this many rows on, only the visible ones are rendered. */
export const VIRTUALIZE_FROM = 500;

export type FileListView = "flat" | "tree";

export interface FileSelectModifiers {
  /** Ctrl or Cmd: add the file to the selection or remove it. */
  additive: boolean;
  /** Shift: range from the anchor up to here. */
  range: boolean;
  /** Where the selection comes from – screens can e.g. open the diff only on click. */
  source?: "pointer" | "keyboard";
}

export interface FileListProps {
  files: FileChange[];
  /** Selected paths; the last one is the active one. */
  selected: string[];
  /** Click or arrow key. `additive` = Ctrl, `range` = Shift. */
  onSelect: (path: string, modifiers: FileSelectModifiers) => void;
  /** Enter or double click. */
  onActivate?: (file: FileChange) => void;
  /** Action in the row (stage button). Appears on hover and focus. */
  rowAction?: (file: FileChange) => ReactNode;
  /** Context menu for the selected files (or the file under the pointer). */
  menuFor?: (files: FileChange[]) => MenuEntry[];
  /** Additional keys, e.g. S and U. Returning true = handled. */
  onKey?: (event: KeyboardEvent, file: FileChange) => boolean;
  ariaLabel: string;
  /** Text when the list is empty. */
  empty?: ReactNode;

  // --- everything below is optional; without these props the list behaves as before ---

  /** "tree" shows folders as collapsible rows. Default: "flat". */
  view?: FileListView;
  /** Skeleton rows instead of content while the files are still loading. */
  loading?: boolean;
  /** The row action is always shown, not only on hover or focus (e.g. conflicted files). */
  actionAlways?: boolean;
  /** Short extra text on the right of the row, e.g. the kind of a conflict. */
  detail?: (file: FileChange) => string | null | undefined;
  /** Tree only: every folder starts closed instead of open. */
  collapsed?: boolean;
  /** Tree only: action in a folder row, for all files below it. */
  folderAction?: (files: FileChange[], folder: string) => ReactNode;
  /** Tree only: additional keys on a folder row. Returning true = handled. */
  onFolderKey?: (event: KeyboardEvent, files: FileChange[], folder: string) => boolean;
  /** Ctrl+A. If the function is missing, the key stays unhandled. */
  onSelectAll?: () => void;
  /** Threshold for virtualisation (default: 500 rows). */
  virtualizeFrom?: number;
}

// ---------------------------------------------------------------------------
// Selection helpers for screens
// ---------------------------------------------------------------------------

/**
 * Computes the next selection: a simple click replaces, Ctrl toggles, Shift selects the
 * range from the anchor (the path last chosen without Shift) to the target. The active path is at the end.
 */
export function nextFileSelection(
  paths: string[],
  current: string[],
  anchor: string | null,
  path: string,
  modifiers: FileSelectModifiers,
): { selected: string[]; anchor: string | null } {
  if (modifiers.range) {
    const from = paths.indexOf(anchor ?? current[current.length - 1] ?? path);
    const to = paths.indexOf(path);
    if (from < 0 || to < 0) return { selected: [path], anchor: path };
    const slice = from <= to ? paths.slice(from, to + 1) : paths.slice(to, from + 1).reverse();
    const base = modifiers.additive ? current.filter((item) => !slice.includes(item)) : [];
    return { selected: [...base, ...slice], anchor: anchor ?? paths[from] ?? path };
  }
  if (modifiers.additive) {
    const selected = current.includes(path) ? current.filter((item) => item !== path) : [...current, path];
    return { selected, anchor: path };
  }
  return { selected: [path], anchor: path };
}

/** Selection of a single file list as React state, matching `selected` and `onSelect`. */
export function useFileSelection(files: FileChange[]) {
  const [state, setState] = useState<{ selected: string[]; anchor: string | null }>({ selected: [], anchor: null });
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const known = useMemo(() => new Set(paths), [paths]);
  const selected = useMemo(() => state.selected.filter((path) => known.has(path)), [state.selected, known]);
  const onSelect = useCallback(
    (path: string, modifiers: FileSelectModifiers) => setState((current) => nextFileSelection(paths, current.selected, current.anchor, path, modifiers)),
    [paths],
  );
  const selectAll = useCallback(() => setState({ selected: [...paths], anchor: paths[0] ?? null }), [paths]);
  const clear = useCallback(() => setState({ selected: [], anchor: null }), []);
  return { selected, onSelect, selectAll, clear, setSelected: (next: string[]) => setState({ selected: next, anchor: next[next.length - 1] ?? null }) };
}

// ---------------------------------------------------------------------------
// Rows: flat or as a tree
// ---------------------------------------------------------------------------

type Row =
  | { kind: "file"; key: string; file: FileChange; depth: number }
  | { kind: "dir"; key: string; name: string; path: string; depth: number; files: FileChange[]; open: boolean };

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: FileChange[];
  all: FileChange[];
}

const collator = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" });
const dirKey = (path: string) => `dir:${path}`;

function buildTree(files: FileChange[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [], all: files };
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    let node = root;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path: prefix, dirs: new Map(), files: [], all: [] };
        node.dirs.set(part, next);
      }
      next.all.push(file);
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

/**
 * Rows of the tree. `toggled` are the folders the user has flipped: closed ones normally, open
 * ones when `collapsed` (every folder starts closed).
 */
export function treeRows(files: FileChange[], toggled: ReadonlySet<string>, collapsed: boolean): Row[] {
  const rows: Row[] = [];
  const walk = (node: DirNode, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name));
    for (let dir of dirs) {
      // Collapse chains of folders with exactly one subfolder and no files of their own into one row.
      let name = dir.name;
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        const only = [...dir.dirs.values()][0];
        if (!only) break;
        dir = only;
        name = `${name}/${dir.name}`;
      }
      const open = toggled.has(dir.path) === collapsed;
      rows.push({ kind: "dir", key: dirKey(dir.path), name, path: dir.path, depth, files: dir.all, open });
      if (open) walk(dir, depth + 1);
    }
    const own = [...node.files].sort((a, b) => collator.compare(a.path, b.path));
    for (const file of own) rows.push({ kind: "file", key: file.path, file, depth });
  };
  walk(buildTree(files), 0);
  return rows;
}

/** Events from portals (menus of the row action) bubble through the row in React – they do not belong to it. */
const fromOutside = (event: { currentTarget: EventTarget; target: EventTarget }) =>
  !(event.currentTarget as Node).contains(event.target as Node) || (event.target as HTMLElement).closest?.("[data-row-action]") !== null;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

/** Indentation per level: three units of the spacing grid (12 px), as in the ref list. */
const indent = (depth: number): CSSProperties | undefined =>
  depth > 0 ? { paddingLeft: `calc(var(--spacing) * ${2 + depth * 3})` } : undefined;

const SKELETON_WIDTHS = ["w-2/5", "w-3/5", "w-1/3", "w-1/2", "w-2/3", "w-1/4"];

function SkeletonRows({ label }: { label: string }) {
  return (
    <div role="status" aria-label={t("graph.fileList.loading", { label })} className="animate-pulse">
      {SKELETON_WIDTHS.map((width, index) => (
        <div key={index} aria-hidden className="flex h-row items-center gap-2 px-2">
          <span className="size-3 shrink-0 rounded-sm bg-surface-raised" />
          <span className={cn("h-2 rounded-sm bg-surface-raised", width)} />
        </div>
      ))}
    </div>
  );
}

function nearestScrollParent(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * File list: listbox (flat) or tree of file rows with keyboard control – one focusable
 * element, arrow keys, Home/End, Page Up/Down, Enter, Space, Menu key and Shift+F10.
 * Virtualised from 500 rows on; scrolling happens in the nearest scrolling ancestor.
 */
export function FileList({
  files,
  selected,
  onSelect,
  onActivate,
  rowAction,
  menuFor,
  onKey,
  ariaLabel,
  empty,
  view = "flat",
  collapsed = false,
  loading = false,
  actionAlways = false,
  detail,
  folderAction,
  onFolderKey,
  onSelectAll,
  virtualizeFrom = VIRTUALIZE_FROM,
}: FileListProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [menuEntries, setMenuEntries] = useState<MenuEntry[]>([]);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  /** Row that last had keyboard focus – if it disappears (staged), focus moves along. */
  const focusedKey = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);

  const tree = view === "tree";
  const rows = useMemo<Row[]>(
    () => (tree ? treeRows(files, toggled, collapsed) : files.map((file) => ({ kind: "file", key: file.path, file, depth: 0 }))),
    [files, tree, toggled, collapsed],
  );
  const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const active = selected[selected.length - 1];

  // The keyboard cursor follows the selection from outside (e.g. after staging it moves up).
  useEffect(() => {
    if (active !== undefined) setCursor(active);
  }, [active]);

  const cursorIndex = (cursor !== null ? indexByKey.get(cursor) : undefined) ?? (active !== undefined ? indexByKey.get(active) : undefined) ?? 0;
  const cursorRow = rows[cursorIndex];

  const rowHeight = useRef(24);
  // From the threshold on the whole list is never rendered – not even in the first pass before the
  // scrolling ancestor is known (otherwise this pass alone takes over a second for 2000 rows).
  const virtual = rows.length >= virtualizeFrom;
  const measured = virtual && scrollParent !== null;
  const virtualizer = useVirtualizer({
    count: measured ? rows.length : 0,
    getScrollElement: () => scrollParent,
    estimateSize: () => rowHeight.current,
    overscan: 12,
    scrollMargin,
    // The row with focus stays rendered, even if it has been scrolled out of view.
    rangeExtractor: (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (cursorIndex < range.startIndex || cursorIndex > range.endIndex) {
        if (cursorIndex >= 0 && cursorIndex < range.count) indexes.push(cursorIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const height = Number.parseFloat(getComputedStyle(root).getPropertyValue("--gc-size-row"));
    if (Number.isFinite(height) && height > 0) rowHeight.current = height;
    const parent = nearestScrollParent(root);
    setScrollParent((current) => (current === parent ? current : parent));
    if (parent) {
      const margin = Math.round(root.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop);
      setScrollMargin((current) => (Math.abs(current - margin) < 1 ? current : margin));
    }
  });

  const rowElement = useCallback((key: string) => {
    const root = rootRef.current;
    if (!root) return null;
    for (const element of root.querySelectorAll<HTMLElement>("[data-row-key]")) {
      if (element.dataset.rowKey === key) return element;
    }
    return null;
  }, []);

  const reveal = useCallback(
    (index: number) => {
      if (measured) virtualizer.scrollToIndex(index, { align: "auto" });
    },
    [measured, virtualizer],
  );

  // Set focus as soon as the row is rendered (for virtualised lists only after scrolling).
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted !== null) {
      const element = rowElement(wanted);
      if (element) {
        pendingFocus.current = null;
        element.focus({ preventScroll: virtual });
        if (!virtual) element.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    // The row with focus has disappeared and nobody else has it: set it on the current row.
    const lost = focusedKey.current;
    if (lost !== null && !indexByKey.has(lost) && (document.activeElement === document.body || document.activeElement === null)) {
      focusedKey.current = null;
      const next = cursorRow ? rowElement(cursorRow.key) : null;
      next?.focus({ preventScroll: true });
    }
  });

  const moveTo = (index: number, event: KeyboardEvent) => {
    const row = rows[index];
    if (!row) return;
    setCursor(row.key);
    pendingFocus.current = row.key;
    reveal(index);
    if (row.kind === "file") onSelect(row.file.path, { additive: false, range: event.shiftKey, source: "keyboard" });
  };

  const toggleDir = (path: string, open?: boolean) =>
    setToggled((current) => {
      const next = new Set(current);
      const isOpen = current.has(path) === collapsed;
      // Flipped = differs from the default state.
      if ((open ?? !isOpen) === collapsed) next.add(path);
      else next.delete(path);
      return next;
    });

  const openMenuAt = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + Math.min(rect.width / 2, 160), clientY: rect.top + rect.height / 2 }),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys from embedded controls (the row's action button, its menu) do not belong to the list.
    if (fromOutside(event)) return;
    const row = cursorRow;
    if (!row) return;
    const index = cursorIndex;
    const page = Math.max(1, Math.floor((scrollParent?.clientHeight ?? 240) / rowHeight.current) - 1);

    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const element = rowElement(row.key);
      if (element && menuFor) {
        event.preventDefault();
        openMenuAt(element);
      }
      return;
    }
    if (event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && onSelectAll) {
      event.preventDefault();
      onSelectAll();
      return;
    }

    let next = -1;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(rows.length - 1, index + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, index - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      case "PageDown":
        next = Math.min(rows.length - 1, index + page);
        break;
      case "PageUp":
        next = Math.max(0, index - page);
        break;
      case "ArrowRight":
        if (!tree) return;
        event.preventDefault();
        if (row.kind === "dir" && !row.open) toggleDir(row.path, true);
        else if (row.kind === "dir") moveTo(Math.min(rows.length - 1, index + 1), event);
        return;
      case "ArrowLeft": {
        if (!tree) return;
        event.preventDefault();
        if (row.kind === "dir" && row.open) {
          toggleDir(row.path, false);
          return;
        }
        // to the parent folder
        for (let parent = index - 1; parent >= 0; parent--) {
          const candidate = rows[parent];
          if (candidate && candidate.kind === "dir" && candidate.depth < row.depth) {
            moveTo(parent, event);
            break;
          }
        }
        return;
      }
      case "Enter":
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        if (row.kind === "dir") toggleDir(row.path);
        else onActivate?.(row.file);
        return;
      case " ":
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        if (row.kind === "dir") toggleDir(row.path);
        else onSelect(row.file.path, { additive: true, range: false, source: "keyboard" });
        return;
      default: {
        const handled = row.kind === "dir" ? onFolderKey?.(event, row.files, row.path) : onKey?.(event, row.file);
        if (handled) event.preventDefault();
        return;
      }
    }
    if (next < 0) return;
    event.preventDefault();
    if (next !== index || row.kind === "file") moveTo(next, event);
  };

  if (loading) return <SkeletonRows label={ariaLabel} />;
  if (files.length === 0) return <div className="px-2 py-1 text-sm text-text-muted">{empty}</div>;

  const menuTargets = (file: FileChange) => (selectedSet.has(file.path) ? files.filter((candidate) => selectedSet.has(candidate.path)) : [file]);

  const renderRow = (row: Row, index: number, style?: CSSProperties) => {
    const focusable = index === cursorIndex;
    const common = {
      "data-row-key": row.key,
      "data-index": index,
      tabIndex: focusable ? 0 : -1,
      onFocus: (event: FocusEvent) => {
        if (!(event.currentTarget as Node).contains(event.target as Node)) return;
        focusedKey.current = row.key;
        if (cursor !== row.key) setCursor(row.key);
      },
      onBlur: (event: FocusEvent) => {
        // Only when focus really goes somewhere else – not when the row is just being removed.
        if (event.relatedTarget && (event.currentTarget as Node).contains(event.target as Node)) focusedKey.current = null;
      },
    };

    if (row.kind === "dir") {
      const action = folderAction?.(row.files, row.path);
      return (
        <div
          key={row.key}
          {...common}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.open}
          aria-selected={false}
          aria-label={t("graph.fileList.folder", { name: row.name, count: row.files.length })}
          title={row.path}
          onClick={(event: MouseEvent) => {
            if (fromOutside(event)) return;
            setCursor(row.key);
            toggleDir(row.path);
          }}
          className="group flex h-row items-center gap-1.5 px-2 text-base text-text-muted hover:bg-surface-raised hover:text-text"
          style={{ ...style, ...indent(row.depth) }}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", row.open && "rotate-90")} aria-hidden />
          {row.open ? <FolderOpen className="size-icon shrink-0" aria-hidden /> : <Folder className="size-icon shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <span className={cn("shrink-0 text-xs tabular-nums", action && "group-focus-within:hidden group-hover:hidden")}>{row.files.length}</span>
          {action ? (
            <span data-row-action className="hidden shrink-0 group-focus-within:inline-flex group-hover:inline-flex">
              {action}
            </span>
          ) : null}
        </div>
      );
    }

    const { file } = row;
    const isSelected = selectedSet.has(file.path);
    const action = rowAction?.(file);
    const extra = detail?.(file);
    const hasCounts = file.added !== null || file.removed !== null;
    const name = baseName(file.path);
    const dir = tree ? "" : dirName(file.path);
    return (
      <div
        key={row.key}
        {...common}
        role={tree ? "treeitem" : "option"}
        aria-level={tree ? row.depth + 1 : undefined}
        aria-selected={isSelected}
        title={`${file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}${extra ? ` – ${extra}` : ""}`}
        onClick={(event: MouseEvent) => {
          if (fromOutside(event)) return;
          setCursor(row.key);
          onSelect(file.path, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey, source: "pointer" });
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
        onDoubleClick={(event: MouseEvent) => {
          if (fromOutside(event)) return;
          onActivate?.(file);
        }}
        onContextMenu={(event: MouseEvent) => {
          if (!menuFor || !(event.currentTarget as Node).contains(event.target as Node)) return;
          const targets = menuTargets(file);
          if (!isSelected) onSelect(file.path, { additive: false, range: false, source: "pointer" });
          const entries = menuFor(targets);
          if (entries.length === 0) {
            // No entry: show neither an empty menu nor the WebView's menu.
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          setMenuEntries(entries);
        }}
        className={cn("group flex h-row items-center gap-2 px-2 text-base", isSelected ? "bg-accent-surface" : "hover:bg-surface-raised")}
        style={{ ...style, ...indent(tree ? row.depth : 0) }}
      >
        <StatusBadge status={file.status} />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn(file.status === "deleted" && "line-through")}>{name}</span>
          {dir ? <span className="ml-2 text-sm text-text-muted">{dir}</span> : null}
        </span>
        {extra ? <span className="max-w-2/5 shrink-0 truncate text-sm text-text-muted">{extra}</span> : null}
        {file.isLfs ? <span className="shrink-0 rounded-sm border border-border-input px-1 text-xs font-medium text-text-muted">LFS</span> : null}
        {hasCounts && !(action && actionAlways) ? (
          <span className={cn("shrink-0 font-mono text-xs tabular-nums", action && "group-focus-within:hidden group-hover:hidden")}>
            {file.added ? <span className="text-success">+{file.added}</span> : null}
            {file.added && file.removed ? " " : null}
            {file.removed ? <span className="text-danger">−{file.removed}</span> : null}
          </span>
        ) : null}
        {action ? (
          <span data-row-action className={cn("shrink-0", actionAlways ? "inline-flex" : "hidden group-focus-within:inline-flex group-hover:inline-flex")}>
            {action}
          </span>
        ) : null}
      </div>
    );
  };

  const list = (
    <div
      ref={rootRef}
      role={tree ? "tree" : "listbox"}
      aria-label={ariaLabel}
      aria-multiselectable
      data-file-list={view}
      data-virtual={virtual || undefined}
      onKeyDown={onKeyDown}
      className={virtual ? "relative" : undefined}
      style={virtual ? { height: measured ? virtualizer.getTotalSize() : rows.length * rowHeight.current } : undefined}
    >
      {virtual && !measured
        ? rows.slice(0, 40).map((row, index) =>
            renderRow(row, index, { position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${index * rowHeight.current}px)` }),
          )
        : virtual
        ? virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return renderRow(row, item.index, {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
            });
          })
        : rows.map((row, index) => renderRow(row, index))}
    </div>
  );

  if (!menuFor) return list;
  return <ContextMenu entries={menuEntries}>{list}</ContextMenu>;
}
