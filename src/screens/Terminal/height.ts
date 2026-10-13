/**
 * Height of the terminal region: one value for all tabs, remembered across restarts
 * (like the widths of the side panels).
 */
import { useSyncExternalStore } from "react";

// Dimensions from design/tokens.json › layout.terminal
export const TERMINAL_HEIGHT = {
  default: 256,
  min: 112,
  max: 720,
  /** At least this much remains for the view above (graph, diff). */
  viewMin: 140,
} as const;

const KEY = "gc.terminalHeight";

const clamp = (value: number) => Math.round(Math.min(TERMINAL_HEIGHT.max, Math.max(TERMINAL_HEIGHT.min, value)));

function load(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    if (Number.isFinite(raw) && raw > 0) return clamp(raw);
  } catch {
    // no localStorage: default height
  }
  return TERMINAL_HEIGHT.default;
}

let height = load();
const listeners = new Set<() => void>();

export const getTerminalHeight = () => height;

/** Sets the desired height (clamped to the limits) and remembers it. */
export function setTerminalHeight(value: number): void {
  const next = clamp(value);
  if (next === height) return;
  height = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    // then only applies until restart
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalHeight(): number {
  return useSyncExternalStore(subscribe, getTerminalHeight);
}

/**
 * The most that is possible with `available` pixels for view and terminal together: the view
 * keeps `viewMin`, but the terminal never shrinks below its minimum.
 */
export function maxTerminalHeight(available: number | null): number {
  if (available === null || available <= 0) return TERMINAL_HEIGHT.max;
  return Math.max(TERMINAL_HEIGHT.min, Math.min(TERMINAL_HEIGHT.max, Math.floor(available - TERMINAL_HEIGHT.viewMin)));
}

/** The displayed height: the desired one, clamped to what fits right now. The desired one stays remembered. */
export function shownTerminalHeight(wish: number, available: number | null): number {
  return Math.min(wish, maxTerminalHeight(available));
}
