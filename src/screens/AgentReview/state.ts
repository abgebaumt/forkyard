/**
 * View state of the agent review per tab and agent – nothing of it lives in the core: the pinned
 * review (the two commits the selection belongs to), the selected files and lines, the active file,
 * where a takeover goes, and the commit message once the user edited it.
 */
import { create } from "zustand";
import type { AgentReview, AgentReviewSource, FileChange, Id } from "../../core";
import { initialPicks, type FilePicks, type TakeOverTarget } from "./model";

export interface PaneState {
  source: AgentReviewSource;
  /** The review the selection belongs to; a newer state of the agent only shows a notice. */
  pinned: AgentReview | null;
  /** null until the file list of `pinned` is known. */
  picks: FilePicks | null;
  /** Path of the file whose diff is shown. */
  active: string | null;
  target: TakeOverTarget;
  /** null = still the message from the task. */
  message: { summary: string; description: string } | null;
  skipHooks: boolean;
}

export const DEFAULT_PANE: PaneState = { source: "snapshot", pinned: null, picks: null, active: null, target: "worktree", message: null, skipHooks: false };

export const paneKey = (tabId: Id, agentId: Id) => `${tabId}:${agentId}`;

interface ReviewState {
  panes: Record<string, PaneState>;
  /** The pane focused last per tab – its selection is what the commit panel commits. */
  focus: Record<Id, Id>;
  patch(tabId: Id, agentId: Id, change: Partial<PaneState> | ((pane: PaneState) => Partial<PaneState>)): void;
  setFocus(tabId: Id, agentId: Id): void;
  /** Forgets every pane of a tab (its review was closed). */
  forget(tabId: Id): void;
}

export const useReviewStore = create<ReviewState>()((set) => ({
  panes: {},
  focus: {},
  patch: (tabId, agentId, change) =>
    set((state) => {
      const key = paneKey(tabId, agentId);
      const current = state.panes[key] ?? DEFAULT_PANE;
      const next = typeof change === "function" ? change(current) : change;
      return { panes: { ...state.panes, [key]: { ...current, ...next } } };
    }),
  setFocus: (tabId, agentId) => set((state) => (state.focus[tabId] === agentId ? state : { focus: { ...state.focus, [tabId]: agentId } })),
  forget: (tabId) =>
    set((state) => {
      const prefix = `${tabId}:`;
      const panes = Object.fromEntries(Object.entries(state.panes).filter(([key]) => !key.startsWith(prefix)));
      const focus = { ...state.focus };
      delete focus[tabId];
      return { panes, focus };
    }),
}));

export const usePane = (tabId: Id, agentId: Id): PaneState => useReviewStore((state) => state.panes[paneKey(tabId, agentId)] ?? DEFAULT_PANE);

export const getPane = (tabId: Id, agentId: Id): PaneState => useReviewStore.getState().panes[paneKey(tabId, agentId)] ?? DEFAULT_PANE;

/** Pins a review – the first one, after “Reload” or another source: the selection starts over. */
export function pin(tabId: Id, agentId: Id, review: AgentReview): void {
  useReviewStore.getState().patch(tabId, agentId, { pinned: review, picks: null, active: null });
}

/** The file list of the pinned range is known: every line-pickable file starts selected (once). */
export function initPicks(tabId: Id, agentId: Id, files: readonly FileChange[]): void {
  useReviewStore.getState().patch(tabId, agentId, (pane) => (pane.picks ? {} : { picks: initialPicks(files), active: pane.active ?? files[0]?.path ?? null }));
}

/** Whose selection the commit panel commits: the pane focused last, otherwise the first agent. */
export function focusedAgent(focus: Id | undefined, agentIds: readonly Id[]): Id | null {
  if (focus && agentIds.includes(focus)) return focus;
  return agentIds[0] ?? null;
}
