import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Sha } from "../../core";
import type { PendingDrag } from "../../app/rebasePlan/graphEdit";
import { DRAG_THRESHOLD } from "../../components/graph/useRefDrag";

/**
 * Dragging a commit row (pointer events): once the pointer has moved `DRAG_THRESHOLD` px with the
 * primary button down (no Shift, Ctrl or Cmd), `onStart` gets the row's SHA and where the drag is. Ref labels keep their own drag.
 */
export function useRowDrag(options: { canStart: (index: number) => Sha | null; onStart: (sha: Sha, drag: PendingDrag) => void }): {
  onPointerDown: (event: ReactPointerEvent) => void;
} {
  const latest = useRef(options);
  latest.current = options;
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    // Shift and Ctrl/Cmd clicks select rows; they never start a drag.
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || stop.current) return;
    const target = event.target as Element;
    if (target.closest("[data-ref-full], button")) return;
    const index = Number(target.closest("[data-row-index]")?.getAttribute("data-row-index") ?? Number.NaN);
    if (!Number.isInteger(index)) return;
    const sha = latest.current.canStart(index);
    if (!sha) return;
    const { pointerId, clientX: startX, clientY: startY } = event;

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId || Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return;
      end();
      const drag: PendingDrag = { sha, pointerId, clientX: move.clientX, clientY: move.clientY };
      watchRelease(drag);
      latest.current.onStart(sha, drag);
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      stop.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    stop.current = end;
  }, []);

  return { onPointerDown };
}

/**
 * Marks the drag `released` when its pointer goes up while the plan loads, so the edit view does not take
 * a dead drag over. One-shot: after the take-over the flag is no longer read.
 */
export function watchRelease(drag: PendingDrag, target: EventTarget = window): void {
  const onUp = (event: Event) => {
    if ((event as PointerEvent).pointerId !== drag.pointerId) return;
    drag.released = true;
    target.removeEventListener("pointerup", onUp);
    target.removeEventListener("pointercancel", onUp);
  };
  target.addEventListener("pointerup", onUp);
  target.addEventListener("pointercancel", onUp);
}
