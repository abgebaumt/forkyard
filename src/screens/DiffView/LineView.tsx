/**
 * The custom-drawn line view for “Hunks” and “Whole file”: a virtualised grid (role=grid) with
 * line numbers, signs, syntax colours and word diff, plus line selection with mouse and
 * keyboard.
 *
 * Keyboard in the grid:
 *   ↑ ↓ PgUp PgDn Home End      change line             with Shift   extend the selection
 *   Space                       select/deselect line    Ctrl+A       all changed lines
 *   Enter (or S / U)            stage or unstage the selection; without a selection the hunk
 *   Del                         discard the selection or hunk (with a prompt)
 *   Esc                         clear the selection
 */
import { defaultRangeExtractor, useVirtualizer, type Range as VirtualRange } from "@tanstack/react-virtual";
import { Archive, ChevronDown, ChevronRight, Copy, Minus, Plus, Trash2, Undo2, X } from "lucide-react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CodeSettings } from "../../components/code/settings";
import type { LineTokens } from "../../components/code/highlight";
import type { TextDiff } from "../../core";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { toast } from "../../ui/Feedback";
import { ContextMenu, type MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import type { PatchAction } from "./actions";
import { DiffMinimap, type MinimapSource } from "./Minimap";
import { hunkRange, isSelectable, keysBetween, lineKey, segmentsOf, type FoldRow, type HunkRow, type LineRow, type NoteRow, type PatchMode, type Row, type RowModel, type WordDiffCache } from "./model";
import { t } from "../../i18n";

export type PatchTarget = { kind: "selection" } | { kind: "hunk"; hunkOrd: number };

export interface LineViewHandle {
  /** Jumps to the next (1) or previous (−1) change block and puts the focus there. false = none left. */
  goToChange(direction: 1 | -1): boolean;
  focus(): void;
}

export interface LineViewProps {
  diff: TextDiff;
  model: RowModel;
  /** “hunks” shows hunk headers, “inline” the whole file. */
  mode: "hunks" | "inline";
  wrap: boolean;
  patchMode: PatchMode;
  /** false: staging not possible (no token, e.g. conflict or “Ignore whitespace”). */
  canPatch: boolean;
  busy: boolean;
  code: CodeSettings;
  oldTokens: LineTokens | null;
  newTokens: LineTokens | null;
  words: WordDiffCache;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  onPatch: (action: PatchAction, target: PatchTarget) => void;
  /** Put the selected lines aside for a partial stash; missing = not offered. */
  onStash?: () => void;
  /** More entries for a code row, after a separator (v1.2: “Why is this so?”); missing = none. */
  lineMenu?: (row: LineRow) => MenuEntry[];
  onToggleFold: (id: number) => void;
  /** Reports which change block the cursor is in (−1 = before the first). */
  onChangeIndex?: (index: number) => void;
  label: string;
}

const signs = { context: " ", add: "+", remove: "−" } as const;
const signLabels = { context: "", add: t("diff.line.added"), remove: t("diff.line.removed") } as const;
const lineTone = { context: "", add: "bg-diff-added", remove: "bg-diff-removed" } as const;
const gutterTone = { context: "bg-surface-sunken", add: "bg-diff-added", remove: "bg-diff-removed" } as const;
const markTone = { context: "", add: "bg-diff-added-strong", remove: "bg-diff-removed-strong" } as const;

/** Reads a size from the tokens (`--gc-size-*`) in pixels. */
function tokenPx(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const isFocusable = (row: Row | undefined) => row?.type === "line" || row?.type === "fold";

// ---------------------------------------------------------------------------
// Zeilen
// ---------------------------------------------------------------------------

/** Longer lines are not coloured (see CodeLine). */
const HIGHLIGHT_MAX_LINE = 5000;

interface CodeLineProps {
  row: LineRow;
  index: number;
  wrap: boolean;
  selected: boolean;
  selectable: boolean;
  isCursor: boolean;
  tokens: LineTokens | null;
  words: WordDiffCache;
  numberStyle: CSSProperties;
  onGutterDown: (index: number, event: ReactPointerEvent) => void;
  onCodeClick: (index: number) => void;
}

const CodeLine = memo(function CodeLine({ row, index, wrap, selected, selectable, isCursor, tokens, words, numberStyle, onGutterDown, onCodeClick }: CodeLineProps) {
  const lineNo = row.kind === "remove" ? row.oldNo : row.newNo;
  // Very long lines (minified code, single-line JSON) stay uncoloured: tens of thousands of
  // coloured segments in ONE line froze the view for seconds.
  const lineTokens = lineNo !== null && row.text.length <= HIGHLIGHT_MAX_LINE ? tokens?.[lineNo - 1] : undefined;
  const marks = row.kind !== "context" && row.hunkOrd !== null && row.pos !== null ? words.get(row.hunkOrd, row.pos) : undefined;
  const segments = segmentsOf(row.text, lineTokens, marks);
  const gutterClass = selected ? "bg-accent-surface text-text" : cn(gutterTone[row.kind], "text-text-muted", selectable && "hover:text-text");
  return (
    <div
      role="row"
      data-row={index}
      data-kind={row.kind}
      aria-rowindex={index + 1}
      aria-selected={selectable ? selected : undefined}
      tabIndex={isCursor ? 0 : -1}
      className={cn("relative flex min-w-full -outline-offset-2", lineTone[row.kind])}
    >
      <div
        data-gutter=""
        className={cn("sticky left-0 z-1 flex shrink-0 select-none", gutterClass)}
        onPointerDown={selectable ? (event) => onGutterDown(index, event) : undefined}
      >
        {selected ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
        <span role="gridcell" style={numberStyle} className="shrink-0 pr-2 text-right tabular-nums">
          {row.oldNo ?? ""}
        </span>
        <span role="gridcell" style={numberStyle} className="shrink-0 pr-2 text-right tabular-nums">
          {row.newNo ?? ""}
        </span>
        <span role="gridcell" className={cn("w-5 shrink-0 text-center", row.kind !== "context" && "font-semibold")}>
          <span aria-hidden>{signs[row.kind]}</span>
          {row.kind !== "context" ? <span className="sr-only">{signLabels[row.kind]}</span> : null}
        </span>
      </div>
      <span
        // With the syntax colours the whole content of the cell changes: rebuild instead of sorting
        // in segment by segment (React looks up the neighbours for every new node – quadratic).
        key={lineTokens ? "coloured" : "plain"}
        role="gridcell"
        className={cn("selectable min-w-0 flex-1 pr-4 pl-1 text-text", wrap ? "whitespace-pre-wrap wrap-anywhere" : "whitespace-pre")}
        onClick={() => onCodeClick(index)}
      >
        {segments.map((segment, segmentIndex) =>
          segment.marked ? (
            <mark key={segmentIndex} className={cn("rounded-sm text-inherit", markTone[row.kind], segment.className)}>
              {segment.text}
            </mark>
          ) : segment.className ? (
            <span key={segmentIndex} className={segment.className}>
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
        {/* Empty lines keep their height. */}
        {row.text === "" ? "​" : null}
      </span>
    </div>
  );
});

function NoteLine({ row, index, gutterStyle }: { row: NoteRow; index: number; gutterStyle: CSSProperties }) {
  return (
    <div role="row" data-row={index} aria-rowindex={index + 1} className={cn("flex min-w-full", lineTone[row.kind])}>
      <div aria-hidden style={gutterStyle} className={cn("sticky left-0 z-1 shrink-0", gutterTone[row.kind])} />
      <span role="gridcell" className="flex-1 pr-4 pl-1 font-sans text-sm text-text-muted italic">
        {t("diff.line.noNewline")}
      </span>
    </div>
  );
}

interface HunkHeadProps {
  row: HunkRow;
  index: number;
  total: number;
  first: boolean;
  patchMode: PatchMode;
  canPatch: boolean;
  busy: boolean;
  onPatch: (action: PatchAction, target: PatchTarget) => void;
}

function HunkHead({ row, index, total, first, patchMode, canPatch, busy, onPatch }: HunkHeadProps) {
  const { hunk, hunkOrd } = row;
  const target: PatchTarget = { kind: "hunk", hunkOrd };
  const range = hunkRange(hunk);
  return (
    <div role="row" data-row={index} data-hunk={hunkOrd} aria-rowindex={index + 1} className={cn("min-w-full", !first && "pt-2")}>
      <div
        role="gridcell"
        className="sticky left-0 flex h-control-lg w-(--gc-diff-viewport) items-center gap-2 border-y border-border bg-surface px-3 font-sans text-sm"
      >
        <span className="shrink-0 font-medium text-text">
          {t("diff.hunk.title", { index: hunkOrd + 1 })}
          <span className="font-normal text-text-muted"> {t("diff.hunk.ofTotal", { total })}</span>
        </span>
        <span className="shrink-0 text-text-muted">{range}</span>
        {hunk.section ? (
          <Tip label={hunk.section}>
            <code className="min-w-0 flex-1 truncate font-mono text-code text-text-muted">{hunk.section}</code>
          </Tip>
        ) : (
          <span className="flex-1" />
        )}
        <span className="flex shrink-0 gap-1.5 font-mono text-code tabular-nums" aria-label={t("diff.hunk.counts", { added: row.added, removed: row.removed })}>
          {row.added ? <span className="text-success">+{row.added}</span> : null}
          {row.removed ? <span className="text-danger">−{row.removed}</span> : null}
        </span>
        {patchMode === "unstaged" && canPatch ? (
          <>
            <Button size="sm" disabled={busy} icon={<Plus className="size-icon" aria-hidden />} onClick={() => onPatch("stage", target)}>
              {t("diff.hunk.stage")}
            </Button>
            <IconButton size="sm" danger disabled={busy} label={t("diff.hunk.discard")} icon={<Trash2 className="size-icon" aria-hidden />} onClick={() => onPatch("discard", target)} />
          </>
        ) : null}
        {patchMode === "staged" && canPatch ? (
          <Button size="sm" disabled={busy} icon={<Minus className="size-icon" aria-hidden />} onClick={() => onPatch("unstage", target)}>
            {t("diff.hunk.unstage")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FoldHead({ row, index, isCursor, onToggle }: { row: FoldRow; index: number; isCursor: boolean; onToggle: (id: number) => void }) {
  const count = row.to - row.from + 1;
  return (
    <div role="row" data-row={index} aria-rowindex={index + 1} className="min-w-full">
      <div role="gridcell" className="sticky left-0 w-(--gc-diff-viewport)">
        <button
          type="button"
          data-row-focus={index}
          data-fold={row.id}
          tabIndex={isCursor ? 0 : -1}
          aria-expanded={!row.collapsed}
          onClick={() => onToggle(row.id)}
          className="flex h-row w-full items-center gap-2 border-y border-border bg-surface px-3 text-left font-sans text-sm text-text-muted -outline-offset-2 hover:text-text"
        >
          {row.collapsed ? <ChevronRight className="size-icon shrink-0" aria-hidden /> : <ChevronDown className="size-icon shrink-0" aria-hidden />}
          <span>
            {t("diff.fold.unchanged", { count })}
            <span className="text-text-muted">
              {" "}
              · {row.from}–{row.to}
            </span>
            {row.collapsed ? ` · ${t("diff.fold.hidden")}` : ""}
          </span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

export const LineView = forwardRef<LineViewHandle, LineViewProps>(function LineView(
  { diff, model, mode, wrap, patchMode, canPatch, busy, code, oldTokens, newTokens, words, selected, onSelectedChange, onPatch, onStash, lineMenu, onToggleFold, onChangeIndex, label },
  ref,
) {
  const { rows, changeStarts } = model;
  const scroller = useRef<HTMLDivElement>(null);
  const [cursor, setCursorState] = useState(() => changeStarts[0] ?? rows.findIndex(isFocusable));
  const [menuRow, setMenuRow] = useState<number | null>(null);
  /** Every increment puts the focus on the cursor row after the next paint – even if the cursor stays the same. */
  const [focusTick, setFocusTick] = useState(0);
  const anchor = useRef<number | null>(null);
  const base = useRef<ReadonlySet<string>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const allowSelect = patchMode !== "none" && canPatch;

  const sizes = useMemo(() => ({ hunk: tokenPx("--gc-size-control-lg", 32), row: tokenPx("--gc-size-row", 24), gap: 8 }), []);
  // The cursor is always on a focusable row – also after the content has changed.
  const cursorIndex = useMemo(() => {
    const start = Math.min(Math.max(cursor, 0), Math.max(rows.length - 1, 0));
    for (let index = start; index < rows.length; index++) if (isFocusable(rows[index])) return index;
    for (let index = start - 1; index >= 0; index--) if (isFocusable(rows[index])) return index;
    return 0;
  }, [cursor, rows]);
  /** Always the latest cursor – also between two quick calls before React has re-rendered. */
  const cursorRef = useRef(cursorIndex);
  cursorRef.current = cursorIndex;
  /** The keyboard focus was last in the grid (stays true when the focused row drops out of the DOM). */
  const focusInside = useRef(false);
  /** The user has already moved the cursor (click, key, jump). */
  const visited = useRef(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.type === "hunk") return sizes.hunk + (index === 0 ? 0 : sizes.gap);
      if (row?.type === "fold") return sizes.row;
      return code.lineHeight;
    },
    overscan: 16,
    // The row with the keyboard focus always stays in the DOM, even when it scrolls out of view.
    rangeExtractor: useCallback(
      (range: VirtualRange) => {
        const indexes = defaultRangeExtractor(range);
        if (cursorIndex < range.startIndex - range.overscan || cursorIndex > range.endIndex + range.overscan) {
          indexes.push(cursorIndex);
          indexes.sort((a, b) => a - b);
        }
        return indexes;
      },
      [cursorIndex],
    ),
  });

  // Wrapping, font or content changed: discard all measured heights.
  useLayoutEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap, code.lineHeight, code.fontSize, model]);

  // Width of the visible area as a CSS variable: hunk headers stay in place when scrolling sideways.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const apply = () => element.style.setProperty("--gc-diff-viewport", `${element.clientWidth}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const focusRow = useCallback((index: number) => {
    const root = scroller.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-row-focus="${index}"]`) ?? root.querySelector<HTMLElement>(`[data-row="${index}"]`);
    target?.focus({ preventScroll: true });
  }, []);

  const setCursor = useCallback(
    (index: number, options: { focus?: boolean; align?: "auto" | "center" | "start" } = {}) => {
      cursorRef.current = index;
      setCursorState(index);
      if (options.focus !== false) setFocusTick((tick) => tick + 1);
      virtualizer.scrollToIndex(index, { align: options.align ?? "auto" });
    },
    [virtualizer],
  );

  useEffect(() => {
    if (focusTick > 0) focusRow(cursorIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  // After staging the diff reloads; if the focused row disappeared in the process, the focus returns to the grid.
  useEffect(() => {
    if (focusInside.current && (document.activeElement === document.body || document.activeElement === null)) focusRow(cursorIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // As a layout effect: the number in the header (“2/3”) changes in the same frame as the cursor. An ordinary
  // effect reports it only in a later task – the header would then visibly lag one step behind.
  useLayoutEffect(() => {
    if (!onChangeIndex) return;
    let found = -1;
    for (let index = 0; index < changeStarts.length; index++) {
      if ((changeStarts[index] as number) <= cursorIndex) found = index;
      else break;
    }
    onChangeIndex(found);
  }, [cursorIndex, changeStarts, onChangeIndex]);

  useImperativeHandle(
    ref,
    () => ({
      goToChange(direction) {
        // If the cursor has never been moved deliberately (diff freshly opened), “next” is the block it is on.
        const at = cursorRef.current;
        const fresh = !visited.current;
        visited.current = true;
        let target: number | undefined;
        if (direction === 1) {
          target = fresh ? (changeStarts.find((start) => start >= at) ?? changeStarts[0]) : changeStarts.find((start) => start > at);
        } else {
          for (const start of changeStarts) if (start < at) target = start;
        }
        if (target === undefined) {
          if (changeStarts.length) focusRow(cursorIndex);
          return false;
        }
        anchor.current = null;
        setCursor(target, { align: "center" });
        return true;
      },
      focus() {
        focusRow(cursorIndex);
      },
    }),
    [changeStarts, cursorIndex, focusRow, setCursor],
  );

  // --- Auswahl ---------------------------------------------------------------

  const toggleKey = useCallback(
    (index: number) => {
      const row = rowsRef.current[index];
      if (!isSelectable(row)) return;
      const key = lineKey(row.hunkOrd, row.pos);
      const next = new Set(selectedRef.current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      anchor.current = index;
      base.current = next;
      onSelectedChange(next);
    },
    [onSelectedChange],
  );

  const extendTo = useCallback(
    (index: number, from: number) => {
      if (anchor.current === null) {
        anchor.current = from;
        base.current = new Set(selectedRef.current);
      }
      const next = new Set(base.current);
      for (const key of keysBetween(rowsRef.current, anchor.current, index)) next.add(key);
      onSelectedChange(next);
    },
    [onSelectedChange],
  );

  // Dragging in the line number column: selects the swept range (or deselects it, if started on a selected line).
  const drag = useRef<{ start: number; base: ReadonlySet<string>; remove: boolean } | null>(null);

  const onGutterDown = useCallback(
    (index: number, event: ReactPointerEvent) => {
      if (event.button !== 0 || !allowSelect) return;
      event.preventDefault();
      visited.current = true;
      setCursorState(index);
      setFocusTick((tick) => tick + 1);
      if (event.shiftKey) {
        extendTo(index, cursorIndex);
        return;
      }
      const row = rowsRef.current[index];
      if (!isSelectable(row)) return;
      const wasSelected = selectedRef.current.has(lineKey(row.hunkOrd, row.pos));
      toggleKey(index);
      drag.current = { start: index, base: new Set(selectedRef.current), remove: wasSelected };
      const move = (moveEvent: PointerEvent) => {
        const state = drag.current;
        if (!state) return;
        const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-row]");
        if (!element || !scroller.current?.contains(element)) return;
        const over = Number(element.dataset.row);
        const next = new Set(state.base);
        for (const key of keysBetween(rowsRef.current, state.start, over)) {
          if (state.remove) next.delete(key);
          else next.add(key);
        }
        base.current = next;
        onSelectedChange(next);
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [allowSelect, cursorIndex, extendTo, onSelectedChange, toggleKey],
  );

  const onCodeClick = useCallback((index: number) => {
    // Only set the cursor; a text selection stays untouched.
    if (window.getSelection()?.isCollapsed === false) return;
    anchor.current = null;
    visited.current = true;
    setCursorState(index);
    setFocusTick((tick) => tick + 1);
  }, []);

  // --- Aktionen --------------------------------------------------------------

  const hunkOrdAt = (index: number): number | null => {
    const row = rows[index];
    if (row?.type === "hunk") return row.hunkOrd;
    if (row?.type === "line") return row.hunkOrd;
    if (row?.type === "note") {
      const previous = rows[index - 1];
      return previous?.type === "line" ? previous.hunkOrd : null;
    }
    return null;
  };

  const primaryAction: PatchAction | null = !allowSelect ? null : patchMode === "unstaged" ? "stage" : "unstage";

  const runOn = (action: PatchAction, index: number) => {
    if (!allowSelect || busy) return;
    if (selected.size > 0) {
      onPatch(action, { kind: "selection" });
      return;
    }
    const hunkOrd = hunkOrdAt(index);
    if (hunkOrd !== null) onPatch(action, { kind: "hunk", hunkOrd });
  };

  const step = (from: number, direction: 1 | -1, count = 1): number => {
    let index = from;
    let found = from;
    let left = count;
    while (left > 0) {
      index += direction;
      if (index < 0 || index >= rows.length) break;
      if (isFocusable(rows[index])) {
        found = index;
        left--;
      }
    }
    return found;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    visited.current = true;
    const target = event.target as HTMLElement;
    // Buttons in hunk headers keep Enter and Space.
    if (target.closest("button") && !target.closest("[data-row-focus]")) return;
    if (event.altKey) return;
    // The key applies to the row that has the focus – not to one the cursor remembered.
    const own = target.closest<HTMLElement>("[data-row-focus], [data-row]");
    const ownIndex = own ? Number(own.dataset.rowFocus ?? own.dataset.row) : Number.NaN;
    const cursorAt = Number.isInteger(ownIndex) && isFocusable(rows[ownIndex]) ? ownIndex : cursorIndex;
    const row = rows[cursorAt];
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / code.lineHeight) - 1);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        next = step(cursorAt, 1);
        break;
      case "ArrowUp":
        next = step(cursorAt, -1);
        break;
      case "PageDown":
        next = step(cursorAt, 1, page);
        break;
      case "PageUp":
        next = step(cursorAt, -1, page);
        break;
      case "Home":
        next = step(-1, 1);
        break;
      case "End":
        next = step(rows.length, -1);
        break;
      case " ":
        event.preventDefault();
        if (row?.type === "fold") onToggleFold(row.id);
        else if (allowSelect) toggleKey(cursorAt);
        return;
      case "Enter":
        event.preventDefault();
        if (row?.type === "fold") onToggleFold(row.id);
        else if (primaryAction) runOn(primaryAction, cursorAt);
        return;
      case "Delete":
        if (patchMode === "unstaged") {
          event.preventDefault();
          runOn("discard", cursorAt);
        }
        return;
      case "Escape":
        if (selected.size > 0) {
          event.preventDefault();
          event.stopPropagation();
          anchor.current = null;
          onSelectedChange(new Set());
        }
        return;
      default: {
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === "a" && allowSelect) {
          event.preventDefault();
          anchor.current = null;
          onSelectedChange(new Set(keysBetween(rows, 0, rows.length - 1)));
        } else if (!event.ctrlKey && !event.metaKey && key === "s" && patchMode === "unstaged") {
          event.preventDefault();
          runOn("stage", cursorAt);
        } else if (!event.ctrlKey && !event.metaKey && key === "u" && patchMode === "staged") {
          event.preventDefault();
          runOn("unstage", cursorAt);
        }
        return;
      }
    }
    if (next === null) return;
    event.preventDefault();
    if (event.shiftKey && allowSelect) extendTo(next, cursorAt);
    else anchor.current = null;
    setCursor(next);
  };

  // --- Context menu ----------------------------------------------------------

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast({ tone: "success", title: t("diff.copy.done") }),
      () => toast({ tone: "danger", title: t("diff.copy.failed"), description: t("diff.copy.failedBody") }),
    );
  };

  const menuEntries = (): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    const index = menuRow ?? cursorIndex;
    const row = rows[index];
    const hunkOrd = hunkOrdAt(index);
    const count = selected.size;
    if (allowSelect) {
      if (count > 0) {
        if (patchMode === "unstaged") {
          entries.push({ label: t("diff.selection.stage", { count }), icon: <Plus className="size-icon" />, shortcut: "Enter", disabled: busy, onSelect: () => onPatch("stage", { kind: "selection" }) });
          entries.push({ label: t("diff.selection.discard", { count }), icon: <Trash2 className="size-icon" />, shortcut: "Delete", danger: true, disabled: busy, onSelect: () => onPatch("discard", { kind: "selection" }) });
        } else {
          entries.push({ label: t("diff.selection.unstage", { count }), icon: <Minus className="size-icon" />, shortcut: "Enter", disabled: busy, onSelect: () => onPatch("unstage", { kind: "selection" }) });
        }
        entries.push({ label: t("diff.selection.clear"), icon: <X className="size-icon" />, shortcut: "Escape", onSelect: () => onSelectedChange(new Set()) });
        entries.push({ type: "separator" });
      }
      if (hunkOrd !== null) {
        const target: PatchTarget = { kind: "hunk", hunkOrd };
        if (patchMode === "unstaged") {
          entries.push({ label: t("diff.hunk.stageN", { index: hunkOrd + 1 }), icon: <Plus className="size-icon" />, disabled: busy, onSelect: () => onPatch("stage", target) });
          entries.push({ label: t("diff.hunk.discardN", { index: hunkOrd + 1 }), icon: <Trash2 className="size-icon" />, danger: true, disabled: busy, onSelect: () => onPatch("discard", target) });
        } else {
          entries.push({ label: t("diff.hunk.unstageN", { index: hunkOrd + 1 }), icon: <Undo2 className="size-icon" />, disabled: busy, onSelect: () => onPatch("unstage", target) });
        }
        entries.push({ type: "separator" });
      }
      if (isSelectable(row)) {
        const isSelected = selected.has(lineKey(row.hunkOrd, row.pos));
        entries.push({ label: isSelected ? t("diff.menu.deselectLine") : t("diff.menu.selectLine"), shortcut: "Space", onSelect: () => toggleKey(index) });
      }
      entries.push({ label: t("diff.menu.selectAll"), shortcut: "Mod+A", onSelect: () => onSelectedChange(new Set(keysBetween(rows, 0, rows.length - 1))) });
      entries.push({ type: "separator" });
    }
    entries.push({ label: t("diff.menu.copyLine"), icon: <Copy className="size-icon" />, disabled: row?.type !== "line", onSelect: () => row?.type === "line" && copy(row.text) });
    if (hunkOrd !== null) {
      const hunk = diff.hunks[hunkOrd];
      entries.push({
        label: t("diff.menu.copyHunk"),
        onSelect: () =>
          hunk &&
          copy(
            [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ` ${hunk.section}` : ""}`, ...hunk.lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`)].join("\n"),
          ),
      });
    }
    if (row?.type === "line" && lineMenu) {
      const more = lineMenu(row);
      if (more.length) entries.push({ type: "separator" }, ...more);
    }
    return entries;
  };

  // --- Dimensions ------------------------------------------------------------

  const numberStyle = useMemo<CSSProperties>(() => ({ width: `calc(${model.digits}ch + 1.25rem)` }), [model.digits]);
  const gutterStyle = useMemo<CSSProperties>(() => ({ width: `calc(${model.digits * 2}ch + 3.75rem)` }), [model.digits]);
  const innerStyle: CSSProperties = {
    height: virtualizer.getTotalSize(),
    // Without wrapping the longest line determines the width; the grid then scrolls sideways.
    width: wrap ? "100%" : `calc(${model.digits * 2 + model.maxColumns}ch + 5.5rem)`,
    minWidth: "100%",
  };
  const hunkTotal = diff.hunks.length;
  const selectionCount = selected.size;

  // --- Minimap ----------------------------------------------------------------
  // The position of every row comes from the virtualizer (measured where already painted, otherwise estimated).
  const totalSize = virtualizer.getTotalSize();
  const minimap = useMemo<MinimapSource>(
    () => ({
      scroller: () => scroller.current,
      total: () => virtualizer.getTotalSize(),
      size: rows.length,
      marks(emit) {
        const measured = virtualizer.measurementsCache;
        let runKind: "add" | "remove" | null = null;
        let runTop = 0;
        let runBottom = 0;
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]!;
          const kind = (row.type === "line" || row.type === "note") && row.kind !== "context" ? row.kind : null;
          const item = kind ? measured[index] : undefined;
          if (kind && item && kind === runKind) {
            runBottom = item.end;
            continue;
          }
          if (runKind) emit(runTop, runBottom, runKind);
          runKind = kind && item ? kind : null;
          if (item) {
            runTop = item.start;
            runBottom = item.end;
          }
        }
        if (runKind) emit(runTop, runBottom, runKind);
      },
    }),
    [rows, virtualizer],
  );

  return (
    <div className="relative flex h-full min-h-0">
      <ContextMenu entries={menuEntries()}>
        <div
          ref={scroller}
          role="grid"
          aria-label={label}
          aria-multiselectable={allowSelect || undefined}
          aria-rowcount={rows.length}
          data-diff-grid={mode}
          className="gc-code min-h-0 min-w-0 flex-1 overflow-auto bg-surface-sunken"
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            focusInside.current = true;
            // Roving tabindex: wherever the focus arrives (Tab, click, focus from outside), that is where the cursor is.
            const element = (event.target as HTMLElement).closest<HTMLElement>("[data-row-focus], [data-row]");
            const index = element ? Number(element.dataset.rowFocus ?? element.dataset.row) : Number.NaN;
            if (Number.isInteger(index) && index !== cursorIndex && isFocusable(rowsRef.current[index])) setCursorState(index);
          }}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && !event.currentTarget.contains(next)) focusInside.current = false;
          }}
          onContextMenuCapture={(event) => {
            const element = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
            setMenuRow(element ? Number(element.dataset.row) : null);
          }}
        >
          <div role="rowgroup" className="relative" style={innerStyle}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const isCursor = item.index === cursorIndex;
              let content;
              if (row.type === "line") {
                const selectable = allowSelect && isSelectable(row);
                content = (
                  <CodeLine
                    row={row}
                    index={item.index}
                    wrap={wrap}
                    selectable={selectable}
                    selected={selectable && row.hunkOrd !== null && row.pos !== null && selected.has(lineKey(row.hunkOrd, row.pos))}
                    isCursor={isCursor}
                    tokens={row.kind === "remove" ? oldTokens : newTokens}
                    words={words}
                    numberStyle={numberStyle}
                    onGutterDown={onGutterDown}
                    onCodeClick={onCodeClick}
                  />
                );
              } else if (row.type === "hunk") {
                content = <HunkHead row={row} index={item.index} total={hunkTotal} first={item.index === 0} patchMode={patchMode} canPatch={canPatch} busy={busy} onPatch={onPatch} />;
              } else if (row.type === "fold") {
                content = <FoldHead row={row} index={item.index} isCursor={isCursor} onToggle={onToggleFold} />;
              } else {
                content = <NoteLine row={row} index={item.index} gutterStyle={gutterStyle} />;
              }
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  role="presentation"
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {content}
                </div>
              );
            })}
          </div>
        </div>
      </ContextMenu>
      {changeStarts.length > 0 ? <DiffMinimap source={minimap} version={`${rows.length}:${Math.round(totalSize)}:${wrap}:${model.changedLines}:${model.foldCount}:${code.lineHeight}`} /> : null}

      {selectionCount > 0 && allowSelect ? (
        <div
          role="toolbar"
          aria-label={t("diff.selection.toolbar")}
          data-selection-bar=""
          className="animate-pop absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-surface-raised py-1.5 pr-1.5 pl-3 text-sm shadow-pop"
        >
          <span className="font-medium whitespace-nowrap text-text" aria-live="polite">
            {t("diff.selection.selected", { count: selectionCount })}
          </span>
          {patchMode === "unstaged" ? (
            <>
              <Button size="sm" variant="primary" disabled={busy} icon={<Plus className="size-icon" aria-hidden />} onClick={() => onPatch("stage", { kind: "selection" })}>
                {t("diff.selection.stage", { count: selectionCount })}
              </Button>
              <Button size="sm" disabled={busy} icon={<Trash2 className="size-icon" aria-hidden />} onClick={() => onPatch("discard", { kind: "selection" })}>
                {t("diff.selection.discard", { count: selectionCount })}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={busy} icon={<Minus className="size-icon" aria-hidden />} onClick={() => onPatch("unstage", { kind: "selection" })}>
              {t("diff.selection.unstage", { count: selectionCount })}
            </Button>
          )}
          {onStash ? (
            <Button size="sm" disabled={busy} icon={<Archive className="size-icon" aria-hidden />} data-action="stash-selection" onClick={onStash}>
              {t("partialStash.selection", { count: selectionCount })}
            </Button>
          ) : null}
          <IconButton size="sm" label={t("diff.selection.clear")} shortcut="Escape" icon={<X className="size-icon" aria-hidden />} onClick={() => onSelectedChange(new Set())} />
        </div>
      ) : null}
    </div>
  );
});
