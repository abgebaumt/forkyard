import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "../../i18n";

export interface HeightHandleProps {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
  /** Enter hides the terminal. */
  onCollapse: () => void;
}

const STEP = 16;
const BIG_STEP = 64;

/**
 * Handle at the top edge of the terminal – the counterpart to the side panels' handle
 * (src/app/shell/Splitter.tsx), only horizontal. Dragging changes the height; by keyboard ↑ / ↓
 * (with Shift in large steps), Home / End for the smallest / largest height, Enter hides;
 * double click restores the default height.
 */
export function HeightHandle({ value, min, max, defaultValue, onChange, onCollapse }: HeightHandleProps) {
  const start = useRef<{ y: number; value: number } | null>(null);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { y: event.clientY, value };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    // CSS zoom on the root element: convert the mouse distance into CSS pixels.
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom || "1") || 1;
    onChange(clamp(start.current.value + (start.current.y - event.clientY) / zoom));
  };

  const onPointerUp = () => {
    start.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number | null = null;
    if (event.key === "ArrowUp") next = value + step;
    else if (event.key === "ArrowDown") next = value - step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") {
      event.preventDefault();
      onCollapse();
      return;
    }
    if (next !== null) {
      event.preventDefault();
      onChange(clamp(next));
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("terminal.height")}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-side="terminal"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(defaultValue)}
      // Grip area above the top edge; the line itself is the region's border.
      className="group absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none outline-none"
    >
      <span aria-hidden className="absolute inset-x-0 bottom-1/2 h-0.5 bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
}
