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
