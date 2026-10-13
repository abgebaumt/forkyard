/**
 * List for the rebase tool: virtualised, keyboard-operable and reorderable by pointer.
 *
 * Focus: the list itself is the one focusable element (listbox with aria-activedescendant).
 * Arrow keys, Home/End, Page Up/Down move the active row, Alt+↑/↓ moves it, Enter triggers the
 * main action. Further keys (P/R/S/D, space) are passed on to `onKey`.
 *
 * Dragging: pointer events, no HTML5 drag and drop (Tauri intercepts that on Windows). Dragging
 * only starts after a few pixels of movement so a click stays a click; Esc cancels. A line shows
 * where the row will land. At the top and bottom edge the list scrolls along.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GripVertical } from "lucide-react";
import { cn } from "../../ui/cn";

/** Row height from the token `size.graph-row` – rebase rows carry a select and need a bit more room. */
function readRowHeight(): number {
  if (typeof document === "undefined") return 28;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gc-size-graph-row"));
  return Number.isFinite(value) && value > 0 ? value : 28;
}

/** Movement from which a click becomes a drag (in CSS pixels). */
const DRAG_THRESHOLD = 4;

export interface RowState {
  active: boolean;
  dragging: boolean;
}

export interface ReorderListProps {
  count: number;
  getKey: (index: number) => string;
  active: number;
  onActiveChange: (index: number) => void;
  ariaLabel: string;
  /** Multi-selection (cherry-pick: which commits go along). Without it: selected = active. */
  isSelected?: (index: number) => boolean;
  reorderable: boolean;
  /** `to` is the insertion point (0 … count), before the row there. */
  onMove?: (from: number, to: number) => void;
  onKey?: (event: KeyboardEvent, index: number) => boolean;
  /** Enter or double click. */
  onActivate?: (index: number) => void;
  renderRow: (index: number, state: RowState) => ReactNode;
  /** Announcement per row for screen readers (action, message, author). */
  rowLabel: (index: number) => string;
  /** What is shown next to the pointer while dragging (short, e.g. the summary). */
  dragLabel?: (index: number) => ReactNode;
  listRef?: RefObject<HTMLDivElement | null>;
  describedBy?: string;
}

interface Drag {
  from: number;
  pointerId: number;
  startY: number;
  lastX: number;
  lastY: number;
  started: boolean;
  /** Insertion point. */
  over: number;
}

export function ReorderList(props: ReorderListProps) {
  const { count, getKey, active, onActiveChange, ariaLabel, isSelected, reorderable, onMove, onKey, onActivate, renderRow, rowLabel, dragLabel, listRef, describedBy } = props;
  const ownRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = listRef ?? ownRef;
  const baseId = useId();
  const rowHeight = useMemo(readRowHeight, []);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 16,
    getItemKey: (index) => getKey(index),
  });

  const current = active >= 0 && active < count ? active : -1;
  useEffect(() => {
    if (current >= 0) virtualizer.scrollToIndex(current, { align: "auto" });
  }, [current, virtualizer]);

  // --- Dragging -----------------------------------------------------------------------------
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const handlers = useRef({ onMove, onActiveChange, count });
  handlers.current = { onMove, onActiveChange, count };

  /** Pointer position in list coordinates. Computes via the ratio of screen to CSS height – so it is right with zoom too. */
  const contentY = useCallback(
    (clientY: number) => {
      const element = scrollRef.current;
      if (!element) return 0;
      const rect = element.getBoundingClientRect();
      const scale = rect.height > 0 ? element.clientHeight / rect.height : 1;
      return (clientY - rect.top) * scale + element.scrollTop;
    },
    [scrollRef],
  );
  /** Insertion point below the pointer. */
  const insertionAt = useCallback((clientY: number) => Math.max(0, Math.min(handlers.current.count, Math.round(contentY(clientY) / rowHeight))), [contentY, rowHeight]);

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  useEffect(() => {
    if (!drag) return;
    const onPointerMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const started = state.started || Math.abs(event.clientY - state.startY) > DRAG_THRESHOLD;
      update({ ...state, started, lastX: event.clientX, lastY: event.clientY, over: started ? insertionAt(event.clientY) : state.over });
    };
    const finish = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      update(null);
      if (!state.started) return;
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      if (event.type === "pointerup" && state.over !== state.from && state.over !== state.from + 1) {
        handlers.current.onMove?.(state.from, state.over);
        handlers.current.onActiveChange(state.over > state.from ? state.over - 1 : state.over);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current?.started) return;
      event.preventDefault();
      event.stopPropagation();
      update(null);
    };
    // Keep scrolling at the edge as long as the pointer stays there.
    const timer = window.setInterval(() => {
      const state = dragRef.current;
      const element = scrollRef.current;
      if (!state?.started || !element) return;
      const rect = element.getBoundingClientRect();
      const edge = Math.min(rect.height / 4, rowHeight * (rect.height / Math.max(1, element.clientHeight)));
      let delta = 0;
      if (state.lastY < rect.top + edge) delta = -rowHeight / 2;
      else if (state.lastY > rect.bottom - edge) delta = rowHeight / 2;
      if (!delta) return;
      element.scrollTop += delta;
      update({ ...state, over: insertionAt(state.lastY) });
    }, 50);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", onKeyDown, true);
    };
    // Only subscribe and unsubscribe when a drag starts or ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag === null]);

  const onRowPointerDown = (event: ReactPointerEvent, index: number) => {
    if (!reorderable || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest("[data-no-drag]")) return;
    update({ from: index, pointerId: event.pointerId, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, started: false, over: index });
  };

  // --- Keyboard ------------------------------------------------------------------------------
  const move = (index: number) => {
    if (count === 0) return;
    onActiveChange(Math.max(0, Math.min(count - 1, index)));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight * 10) / rowHeight) - 1);
    const from = current;
    if (event.altKey) {
      if (!reorderable || from < 0 || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      if (event.key === "ArrowUp" && from > 0) {
        onMove?.(from, from - 1);
        onActiveChange(from - 1);
      } else if (event.key === "ArrowDown" && from < count - 1) {
        onMove?.(from, from + 2);
        onActiveChange(from + 1);
      }
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        move(from + 1);
        break;
      case "ArrowUp":
        move(from < 0 ? 0 : from - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(count - 1);
        break;
      case "PageDown":
        move(from + page);
        break;
      case "PageUp":
        move(from < 0 ? 0 : from - page);
        break;
      case "Enter":
        if (from < 0) return;
        onActivate?.(from);
        break;
      default:
        if (from >= 0 && onKey?.(event, from)) break;
        return;
    }
    event.preventDefault();
  };

  const dragging = drag?.started ? drag : null;
  const showLine = dragging && dragging.over !== dragging.from && dragging.over !== dragging.from + 1;
  const total = virtualizer.getTotalSize();
  // The line stays fully visible even at the very top and bottom.
  const lineTop = dragging ? Math.max(0, Math.min(total - 2, dragging.over * rowHeight - 1)) : 0;
  // A label with the row hangs to the lower right of the pointer – offset so it does not cover the
  // insertion line. The row itself stays dimmed in its place.
  let ghost: { top: number; left: number } | null = null;
  if (dragging && scrollRef.current) {
    const element = scrollRef.current;
    const rect = element.getBoundingClientRect();
    const scaleX = rect.width > 0 ? element.clientWidth / rect.width : 1;
    const x = (dragging.lastX - rect.left) * scaleX;
    const bottom = Math.max(total, element.scrollTop + element.clientHeight) - rowHeight;
    ghost = {
      top: Math.max(0, Math.min(bottom, contentY(dragging.lastY) + rowHeight / 2)),
      left: Math.max(0, Math.min(element.clientWidth / 2, x + rowHeight / 2)),
    };
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-multiselectable={isSelected ? true : undefined}
      aria-activedescendant={current >= 0 ? `${baseId}-${current}` : undefined}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget && current < 0 && count > 0) onActiveChange(0);
      }}
      data-dragging={dragging ? "" : undefined}
      // The focus ring sits on the active row (see below), not around the whole list.
      // Space for the scrollbar is always reserved – so the columns line up under those of the header, however long the list is.
      className={cn("group relative h-full overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]", count > 0 ? "outline-none" : "-outline-offset-2", dragging && "cursor-grabbing")}
    >
      <div className="relative w-full" style={{ height: total }}>
        {virtualizer.getVirtualItems().map((item) => {
          const index = item.index;
          const isActive = index === current;
          const isDragged = dragging?.from === index;
          return (
            <div
              key={item.key}
              id={`${baseId}-${index}`}
              role="option"
              aria-selected={isSelected ? isSelected(index) : isActive}
              aria-label={rowLabel(index)}
              aria-posinset={index + 1}
              aria-setsize={count}
              data-index={index}
              data-row-sha={getKey(index)}
              data-active={isActive ? "" : undefined}
              data-dragged={isDragged ? "" : undefined}
              onPointerDown={(event) => onRowPointerDown(event, index)}
              onClick={() => {
                if (suppressClick.current) return;
                onActiveChange(index);
              }}
              onDoubleClick={(event) => {
                if (event.target instanceof Element && event.target.closest("[data-no-drag]")) return;
                onActivate?.(index);
              }}
              className={cn(
                "absolute top-0 left-0 flex h-graph-row w-full items-center border-b border-border",
                isActive ? "bg-accent-surface" : "hover:bg-surface-raised",
                // The list's keyboard focus: the same ring as everywhere, on the active row.
                isActive && "outline-accent group-focus-visible:outline-2 group-focus-visible:-outline-offset-2",
                isDragged && "bg-surface-raised opacity-60",
              )}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(index, { active: isActive, dragging: isDragged })}
            </div>
          );
        })}
        {showLine ? <div aria-hidden data-drop-line="" className="pointer-events-none absolute right-0 left-0 z-10 h-0.5 bg-accent" style={{ top: lineTop }} /> : null}
        {dragging && ghost ? (
          <div
            aria-hidden
            data-drag-ghost=""
            className="pointer-events-none absolute z-20 flex h-row max-w-2/5 items-center gap-1.5 rounded-md border border-accent bg-surface-raised px-2 text-sm font-medium text-text shadow-pop"
            style={ghost}
          >
            <GripVertical className="size-icon shrink-0 text-text-muted" />
            <span className="min-w-0 truncate">{dragLabel ? dragLabel(dragging.from) : rowLabel(dragging.from)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
