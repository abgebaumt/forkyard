import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { FlatRow } from "./model";

/** From this many rows on, a section renders only what is in the viewport. */
export const VIRTUAL_FROM = 120;

export interface SectionRowsProps {
  label: string;
  rows: FlatRow[];
  /** Height of a row in CSS pixels (from the row height token). */
  rowHeight: number;
  /** The panel's scrolling area – all sections share it. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Row that stays rendered even outside the viewport (it holds the focus). */
  keepIndex: number;
  multiselectable?: boolean;
  renderRow: (row: FlatRow) => ReactNode;
}

/** A section's rows as a tree; long lists virtualised within the shared scroll area. */
export function SectionRows({ label, rows, rowHeight, scrollRef, keepIndex, multiselectable, renderRow }: SectionRowsProps) {
  const virtual = rows.length >= VIRTUAL_FROM;
  const containerRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);

  // Offset of the list from the start of the scroll content; changes when sections above expand or collapse.
  useLayoutEffect(() => {
    if (!virtual) return;
    const container = containerRef.current;
    const scroller = scrollRef.current;
    if (!container || !scroller) return;
    // offsetTop instead of getBoundingClientRect: independent of scroll position and UI zoom.
    let next = 0;
    let element: HTMLElement | null = container;
    while (element && element !== scroller) {
      next += element.offsetTop;
      element = element.offsetParent instanceof HTMLElement ? element.offsetParent : null;
    }
    if (next !== margin) setMargin(next);
  });

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (keepIndex < 0 || keepIndex >= range.count || indexes.includes(keepIndex)) return indexes;
      return [...indexes, keepIndex].sort((a, b) => a - b);
    },
    [keepIndex],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    scrollMargin: margin,
    enabled: virtual,
    rangeExtractor,
    useFlushSync: false,
  });

  if (!virtual) {
    return (
      <div role="tree" aria-label={label} aria-multiselectable={multiselectable || undefined}>
        {rows.map(renderRow)}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={label}
      aria-multiselectable={multiselectable || undefined}
      data-virtual
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <div
            key={row.node.id}
            role="presentation"
            className="absolute inset-x-0 top-0 focus-within:z-20"
            style={{ height: item.size, transform: `translateY(${item.start - margin}px)` }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}
