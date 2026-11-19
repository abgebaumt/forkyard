/**
 * A tab's view state for the window it moves to: the `TabView`, its terminal sessions and the top
 * graph row. It travels as opaque JSON through the core (`tabHandoffPut` / `tabHandoffTake`).
 */
import type { Id, Sha } from "../../core";
import { adoptSessions, releaseSessions, type TerminalHandoff } from "../../screens/Terminal/sessions";
import { qk, queryClient } from "../queries";
import { defaultTabView, getTabView, useAppStore, type TabView } from "../store";

export interface TabHandoff {
  version: 1;
  view: TabView;
  terminals: TerminalHandoff[];
  topSha: Sha | null;
}

/** Top graph row per tab, as the graph last reported it. */
const graphTops = new Map<Id, Sha>();

/** The graph reports its top visible commit here, so a move can restore the scroll position. */
export function noteGraphTop(tabId: Id, sha: Sha | null): void {
  if (sha) graphTops.set(tabId, sha);
  else graphTops.delete(tabId);
}

/** Takes the tab's terminals out of this window (they keep running in the core) and reads its view. */
export function buildHandoff(tabId: Id): TabHandoff {
  const topSha = graphTops.get(tabId) ?? null;
  graphTops.delete(tabId);
  return { version: 1, view: getTabView(tabId), terminals: releaseSessions(tabId), topSha };
}

export function serializeHandoff(h: TabHandoff): string {
  return JSON.stringify(h);
}

/** `null` for broken JSON or another version; unknown fields are dropped. */
export function parseHandoff(text: string): TabHandoff | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { version, view, terminals, topSha } = value as Record<string, unknown>;
  if (version !== 1 || typeof view !== "object" || view === null || !Array.isArray(terminals)) return null;
  if (topSha !== null && typeof topSha !== "string") return null;
  return { version: 1, view: view as TabView, terminals: terminals as TerminalHandoff[], topSha };
}

let revealNonce = 0;

/** Restores the view in this window, scrolls the graph to the top row and attaches the terminals. */
export function applyHandoff(tabId: Id, repoId: Id | null, h: TabHandoff): void {
  // The source's reveal request was handled there; only the top row is asked for again.
  // Negative nonces cannot collide with the store's own counter (1, 2, …).
  const reveal = h.topSha ? { sha: h.topSha, nonce: -++revealNonce } : null;
  useAppStore.setState((state) => ({ views: { ...state.views, [tabId]: { ...defaultTabView(), ...h.view, reveal } } }));
  if (!repoId) return;
  adoptSessions(tabId, repoId, h.terminals);
  // The source flushed the draft into the core before the move.
  void queryClient.invalidateQueries({ queryKey: qk.draft(repoId) });
}
