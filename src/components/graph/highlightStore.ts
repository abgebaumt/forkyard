/**
 * Which branch is currently highlighted in the graph. This is set from two sides:
 * by the graph itself (pointer over a label, key B) and by the left panel (pointer or
 * keyboard focus on a branch). The graph then draws its commits normally and dims the rest.
 *
 * A separate, tiny store instead of the app store: the highlight changes with every
 * pointer movement over the labels and should redraw nothing but the graph.
 */
import { useSyncExternalStore } from "react";
import type { Id } from "../../core";

export interface HighlightTarget {
  repoId: Id;
  /** `refs/heads/…` or `refs/remotes/…`. */
  fullName: string;
  /** Stays until it is explicitly cleared (key B); otherwise it ends with the hover. */
  sticky: boolean;
}

let current: HighlightTarget | null = null;
/** The fixed highlight that an ending hover returns to. */
let pinnedTarget: HighlightTarget | null = null;
let timer: number | undefined;
const listeners = new Set<() => void>();

/** How long the pointer rests on a label before the graph switches (no flicker when moving across). */
const HOVER_DELAY_MS = 100;

function apply(next: HighlightTarget | null) {
  if (current?.repoId === next?.repoId && current?.fullName === next?.fullName && current?.sticky === next?.sticky) return;
  current = next;
  listeners.forEach((listener) => listener());
}

/** Highlight while the pointer (or keyboard focus) is on the branch. `delay: false` for the keyboard. */
export function hoverHighlight(repoId: Id, fullName: string, { delay = true }: { delay?: boolean } = {}): void {
  window.clearTimeout(timer);
  const target = { repoId, fullName, sticky: false };
  if (!delay) apply(target);
  else timer = window.setTimeout(() => apply(target), HOVER_DELAY_MS);
}

/** The hover has ended: back to the fixed highlight, otherwise none. */
export function endHoverHighlight(repoId: Id, fullName?: string): void {
  window.clearTimeout(timer);
  if (!current || current.sticky || current.repoId !== repoId) return;
  if (fullName !== undefined && current.fullName !== fullName) return;
  apply(pinnedTarget?.repoId === repoId ? pinnedTarget : null);
}

/** Fix the highlight or (same branch again, or null) clear it. */
export function toggleStickyHighlight(repoId: Id, fullName: string | null): void {
  window.clearTimeout(timer);
  if (fullName === null || (pinnedTarget?.repoId === repoId && pinnedTarget.fullName === fullName)) {
    pinnedTarget = null;
    apply(null);
    return;
  }
  pinnedTarget = { repoId, fullName, sticky: true };
  apply(pinnedTarget);
}

export function clearHighlight(repoId: Id): void {
  window.clearTimeout(timer);
  if (pinnedTarget?.repoId === repoId) pinnedTarget = null;
  if (current?.repoId === repoId) apply(null);
}

export const currentHighlight = (repoId: Id): HighlightTarget | null => (current?.repoId === repoId ? current : null);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The highlight of this repository – or null. */
export function useHighlightTarget(repoId: Id): HighlightTarget | null {
  return useSyncExternalStore(subscribe, () => (current?.repoId === repoId ? current : null));
}
