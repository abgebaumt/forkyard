/**
 * Where a tab dragged out of its strip lands. Rust supplies the facts (window rectangles, strips and
 * tab midpoints in screen coordinates, focus order); this decides.
 */
import type { ScreenPoint, ScreenRect, WindowLayout } from "../../core";

export type DropTarget =
  | { kind: "reorder"; index: number }
  | { kind: "move"; window: string; index: number }
  | { kind: "new"; at: ScreenPoint }
  | { kind: "none" };

/** Half-open: `[x, x + width)` × `[y, y + height)`. */
const contains = (rect: ScreenRect, point: ScreenPoint) =>
  point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;

/**
 * `self` is the source window's label, `insideSelf` whether the point is inside it (the source knows
 * that even when positions are unknown). The most recently focused window counts as the top one.
 * shortcut: a window hidden while it closes still counts as a target, the layout does not say it is hidden.
 */
export function dropTarget(layout: WindowLayout, point: ScreenPoint, self: string, insideSelf: boolean): DropTarget {
  const top = layout.frames
    .filter((frame) => frame.inner !== null && contains(frame.inner, point))
    .sort((a, b) => a.focusRank - b.focusRank)[0];
  if (!top) return insideSelf ? { kind: "none" } : { kind: "new", at: point };
  if (!top.strip || !contains(top.strip, point)) return { kind: "none" };
  const index = top.tabMids.filter((mid) => mid < point.x).length;
  return top.label === self ? { kind: "reorder", index } : { kind: "move", window: top.label, index };
}
