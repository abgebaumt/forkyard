/**
 * What individual graph rows additionally show: "dimmed" (not part of the highlighted
 * branch) and the ghost label (nearest branch that contains the commit).
 *
 * One object per graph that the rows subscribe to individually: when the highlight changes,
 * React only redraws the rows whose state actually changes – not the whole list.
 */
import { useSyncExternalStore } from "react";
import type { RefLabelInfo } from "../../core";

export class RowMarks {
  private readonly listeners = new Set<() => void>();
  private member: Uint8Array | null = null;
  private ghosts = new Map<string, RefLabelInfo>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  /** `member[index] === 1`: the row belongs to the highlighted branch. null clears the highlight. */
  setMember(member: Uint8Array | null) {
    if (this.member === member) return;
    this.member = member;
    this.notify();
  }

  /** Ghost labels per row ID (active and hovered row). */
  setGhosts(next: Map<string, RefLabelInfo>) {
    if (next.size === this.ghosts.size && [...next].every(([key, ref]) => this.ghosts.get(key)?.fullName === ref.fullName)) return;
    // Unchanged entries keep their object: the corresponding row then does not redraw.
    const merged = new Map<string, RefLabelInfo>();
    for (const [key, ref] of next) {
      const before = this.ghosts.get(key);
      merged.set(key, before && before.fullName === ref.fullName ? before : ref);
    }
    this.ghosts = merged;
    this.notify();
  }

  isDim(index: number): boolean {
    return this.member !== null && this.member[index] !== 1;
  }

  ghostOf(rowId: string): RefLabelInfo | null {
    return this.ghosts.get(rowId) ?? null;
  }

  get highlighting(): boolean {
    return this.member !== null;
  }
}

export function useRowDim(marks: RowMarks, index: number): boolean {
  return useSyncExternalStore(marks.subscribe, () => marks.isDim(index));
}

export function useRowGhost(marks: RowMarks, rowId: string): RefLabelInfo | null {
  return useSyncExternalStore(marks.subscribe, () => marks.ghostOf(rowId));
}
