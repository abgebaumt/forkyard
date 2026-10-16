/**
 * Terminal tabs of one repository tab: which sessions exist, in which order, which one is shown, and
 * how a tab shows its state. Pure logic without xterm.js – the sessions (sessions.ts) keep one value
 * of this per repository tab.
 */

export type SessionKind = "shell" | "program";

export interface TabEntry {
  key: string;
  kind: SessionKind;
  title: string;
  /** Shells are numbered ("Shell", "Shell 2" …); the number of a closed shell is reused. */
  number: number | null;
}

export interface TerminalTabs {
  entries: readonly TabEntry[];
  /** The shown session. */
  active: string | null;
}

export const EMPTY_TABS: TerminalTabs = Object.freeze({ entries: Object.freeze([]) as readonly TabEntry[], active: null });

export function addShell(tabs: TerminalTabs, key: string, title: (number: number) => string): TerminalTabs {
  const used = new Set(tabs.entries.filter((entry) => entry.kind === "shell").map((entry) => entry.number));
  let number = 1;
  while (used.has(number)) number += 1;
  return { entries: [...tabs.entries, { key, kind: "shell", title: title(number), number }], active: key };
}

export function addProgram(tabs: TerminalTabs, key: string, title: string): TerminalTabs {
  return { entries: [...tabs.entries, { key, kind: "program", title, number: null }], active: key };
}

/** Removes a tab. If it was shown, its right neighbour is shown, else the left one. */
export function closeEntry(tabs: TerminalTabs, key: string): TerminalTabs {
  const index = tabs.entries.findIndex((entry) => entry.key === key);
  if (index < 0) return tabs;
  const entries = tabs.entries.filter((entry) => entry.key !== key);
  if (tabs.active !== key) return { entries, active: tabs.active };
  const next = entries[index] ?? entries[index - 1] ?? null;
  return { entries, active: next ? next.key : null };
}

/** Shows a tab; returns the same object if nothing changes. */
export function selectEntry(tabs: TerminalTabs, key: string): TerminalTabs {
  if (tabs.active === key || !tabs.entries.some((entry) => entry.key === key)) return tabs;
  return { entries: tabs.entries, active: key };
}

/** The tab `delta` steps away, wrapping around (arrow keys in the tab strip). */
export function neighbour(tabs: TerminalTabs, key: string, delta: number): string | null {
  const count = tabs.entries.length;
  if (count === 0) return null;
  const from = Math.max(0, tabs.entries.findIndex((entry) => entry.key === key));
  return tabs.entries[(((from + delta) % count) + count) % count]!.key;
}

export type SessionStatus = { kind: "starting" } | { kind: "running" } | { kind: "exited"; code: number | null } | { kind: "failed" };
export type SessionState = "starting" | "running" | "waiting" | "done" | "failed" | "exited";
export type StatusTone = "accent" | "warning" | "success" | "danger" | "muted";

/**
 * What a tab says about its session. An ended shell is "ended" whatever its exit code (an interactive
 * shell often ends with the last command's code); an ended program is "done" with 0, otherwise "error".
 * `waiting` comes from a coding agent's status signal (2a).
 */
export function sessionState(kind: SessionKind, status: SessionStatus, waiting = false): SessionState {
  switch (status.kind) {
    case "starting":
      return "starting";
    case "running":
      return waiting ? "waiting" : "running";
    case "failed":
      return "failed";
    case "exited":
      return kind === "shell" ? "exited" : status.code === 0 ? "done" : "failed";
  }
}

/** Colour of the dot; never alone – the tab also shows the state as a word. */
export const STATE_TONE: Record<SessionState, StatusTone> = {
  starting: "accent",
  running: "accent",
  waiting: "warning",
  done: "success",
  failed: "danger",
  exited: "muted",
};
