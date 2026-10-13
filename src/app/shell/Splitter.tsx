import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../../ui/cn";

export interface SplitterProps {
  /** e.g. "Width of the Left Panel". */
  label: string;
  /** Which panel the handle resizes (set as data-side on the element). */
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  /** Which side grows when the handle is dragged to the right. */
  grows: "left" | "right";
  onChange: (value: number) => void;
  /** Enter collapses the panel. */
  onCollapse?: () => void;
}

const STEP = 8;
const BIG_STEP = 32;

/**
 * Drag handle between two areas. By keyboard: arrow keys (with Shift in large steps),
 * Home/End for minimum/maximum, Enter collapses; double-click restores the default width.
 */
export function Splitter({ label, side, value, min, max, defaultValue, grows, onChange, onCollapse }: SplitterProps) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const sign = grows === "left" ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, value };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    // CSS zoom on the root element: convert mouse movement to CSS pixels.
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom || "1") || 1;
    onChange(start.current.value + (sign * (event.clientX - start.current.x)) / zoom);
  };

  const onPointerUp = () => {
    start.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = value + sign * step;
    else if (event.key === "ArrowLeft") next = value - sign * step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter" && onCollapse) {
      event.preventDefault();
      onCollapse();
      return;
    }
    if (next !== null) {
      event.preventDefault();
      onChange(Math.min(max, Math.max(min, next)));
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-side={side}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(defaultValue)}
      // 8 px grip area over the panel edge; the line itself is the panel's border.
      className={cn("group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none")}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 w-0.5 bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent group-active:bg-accent",
          // The highlight lies exactly on the panel's border (to its left or right respectively).
          grows === "left" ? "right-1/2" : "left-1/2",
        )}
      />
    </div>
  );
}
