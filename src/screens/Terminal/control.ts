/**
 * Slim remote control for the terminal sessions – without xterm.js.
 *
 * The commands (src/app/commands/terminal.ts) depend only on this: the command registry loads all
 * command files at startup and in the unit tests too, and there is neither a DOM nor the terminal
 * there. The actual sessions (sessions.ts) register here when they load.
 */
import type { Id } from "../../core";

/** State of a session, as coarse as commands and menus need it. */
export type TerminalStatusKind = "starting" | "running" | "exited" | "failed";

export interface TerminalController {
  /** State of the session shown in the tab. */
  statusOf(tabId: Id): TerminalStatusKind | null;
  /** Whether a running session of the tab has received anything from the user since its start. */
  hadInput(tabId: Id): boolean;
  /** Whether the session `key` of the tab is still running. */
  isLive(tabId: Id, key: Id): boolean;
  /** End the shown shell and start it fresh (without a prompt – the caller asks). */
  restart(tabId: Id): void;
  /** Clear the scrollback of the shown session; it keeps running. */
  clear(tabId: Id): void;
  /** End the shown session; returns how many sessions are left in the tab. */
  endActive(tabId: Id): number;
  /** End the session `key`; returns how many sessions are left in the tab. */
  close(tabId: Id, key: Id): number;
  /** Another shell in the tab, shown at once. */
  newShell(tabId: Id): void;
  /** End every session of the tab and forget them. */
  dispose(tabId: Id): void;
}

let controller: TerminalController | null = null;

export function registerTerminalController(next: TerminalController): void {
  controller = next;
}

export const terminalControl: TerminalController = {
  statusOf: (tabId) => controller?.statusOf(tabId) ?? null,
  hadInput: (tabId) => controller?.hadInput(tabId) ?? false,
  isLive: (tabId, key) => controller?.isLive(tabId, key) ?? false,
  restart: (tabId) => controller?.restart(tabId),
  clear: (tabId) => controller?.clear(tabId),
  endActive: (tabId) => controller?.endActive(tabId) ?? 0,
  close: (tabId, key) => controller?.close(tabId, key) ?? 0,
  newShell: (tabId) => controller?.newShell(tabId),
  dispose: (tabId) => controller?.dispose(tabId),
};

/**
 * Via `onData` xterm.js reports not only keys but also its own replies to queries from the shell
 * (device attributes, cursor position, colours) and focus reports. Those do not count as user
 * input.
 */
export function isTerminalReply(data: string): boolean {
  // CSI reports: ESC [ … c (device), … R (cursor), … n (status), … t (window), … y (mode); ESC [ I / O (focus)
  if (/^(?:\x1b\[[?>=]?[\d;$]*[cRnty]|\x1b\[[IO])+$/.test(data)) return true;
  // OSC and DCS replies: ESC ] … BEL|ST, ESC P … ST
  return /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/.test(data);
}

// ---------------------------------------------------------------------------
// Focus requests
// ---------------------------------------------------------------------------

/**
 * "Focus into the terminal": the request arises before the panel exists (the command shows it
 * first). It stays pending until the tab's panel picks it up.
 */
const focusWishes = new Set<Id>();
const focusListeners = new Set<() => void>();

export function requestTerminalFocus(tabId: Id): void {
  focusWishes.add(tabId);
  focusListeners.forEach((listener) => listener());
}

/** Picks up the request; true if there was one. */
export function takeTerminalFocus(tabId: Id): boolean {
  return focusWishes.delete(tabId);
}

export function dropTerminalFocus(tabId: Id): void {
  focusWishes.delete(tabId);
}

export function onTerminalFocusRequest(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}
