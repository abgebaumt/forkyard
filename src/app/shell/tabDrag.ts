/** When a tab dragged in the strip counts as dragged out of it. */

/** px beyond the strip before a drag counts as "out". */
export const DRAG_OUT_MARGIN = 24;

/** Whether the pointer (client coordinates) is further than `margin` from the strip on any side. */
export function leftStrip(
  strip: { left: number; top: number; right: number; bottom: number },
  clientX: number,
  clientY: number,
  margin = DRAG_OUT_MARGIN,
): boolean {
  return clientX < strip.left - margin || clientX > strip.right + margin || clientY < strip.top - margin || clientY > strip.bottom + margin;
}

/**
 * A `getBoundingClientRect` inside the CSS-zoomed root (layout pixels) in the pixels of pointer
 * coordinates and of the window (visible pixels).
 */
export function visibleRect(rect: { left: number; top: number; right: number; bottom: number }, zoom: number) {
  return { left: rect.left * zoom, top: rect.top * zoom, right: rect.right * zoom, bottom: rect.bottom * zoom };
}

/** An insertion slot counted with the dragged tab (at `from`) as a position in the list without it. */
export function indexWithout(target: number, from: number): number {
  return from >= 0 && target > from ? target - 1 : target;
}
