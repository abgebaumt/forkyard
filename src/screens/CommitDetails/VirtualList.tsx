/**
 * Virtualised listbox for very long lists (all files of a commit, many selected commits).
 *
 * Focus: the list itself is the one focusable element; the active row is announced via
 * aria-activedescendant. This way the focus is kept even when the row drops out of the DOM while
 * scrolling. Arrow keys, Home/End, Page Up/Down move, Enter triggers the main action.
 */
import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../../ui/cn";

/** Row height from the token `size.row`. */
function readRowHeight(): number {
  if (typeof document === "undefined") return 24;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gc-size-row"));
  return Number.isFinite(value) && value > 0 ? value : 24;
}

export interface VirtualListProps {
  count: number;
  /** Index of the active row, -1 = none. */
  active: number;
  onActiveChange: (index: number) => void;
  /** Enter or double-click. */
  onActivate?: (index: number) => void;
  /** A single click triggers the main action right away (files: click opens). */
  activateOnClick?: boolean;
  renderRow: (index: number, active: boolean) => ReactNode;
  getKey?: (index: number) => string | number;
  ariaLabel: string;
  /** More keys. Return true = handled. */
  onKey?: (event: KeyboardEvent, index: number) => boolean;
  className?: string;
}

export function VirtualList({ count, active, onActiveChange, onActivate, activateOnClick, renderRow, getKey, ariaLabel, onKey, className }: VirtualListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const rowHeight = useMemo(readRowHeight, []);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: getKey,
  });

  const current = active >= 0 && active < count ? active : -1;

  useEffect(() => {
    if (current >= 0) virtualizer.scrollToIndex(current, { align: "auto" });
  }, [current, virtualizer]);

  const move = (index: number) => {
    if (count === 0) return;
    onActiveChange(Math.max(0, Math.min(count - 1, index)));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight * 10) / rowHeight) - 1);
    const from = current < 0 ? -1 : current;
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
        if (current < 0) return;
        onActivate?.(current);
        break;
      default:
        if (current >= 0 && onKey?.(event, current)) break;
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={scrollRef}
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-activedescendant={current >= 0 ? `${baseId}-${current}` : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (current < 0 && count > 0) onActiveChange(0);
      }}
      className={cn("h-full overflow-x-hidden overflow-y-auto -outline-offset-2", className)}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const isActive = item.index === current;
          return (
            <div
              key={item.key}
              id={`${baseId}-${item.index}`}
              role="option"
              aria-selected={isActive}
              aria-posinset={item.index + 1}
              aria-setsize={count}
              data-index={item.index}
              data-active={isActive ? "true" : undefined}
              onClick={() => {
                onActiveChange(item.index);
                if (activateOnClick) onActivate?.(item.index);
              }}
              onDoubleClick={() => {
                if (!activateOnClick) onActivate?.(item.index);
              }}
              className={cn("absolute top-0 left-0 flex h-row w-full items-center", isActive ? "bg-accent-surface" : "hover:bg-surface-raised")}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(item.index, isActive)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
