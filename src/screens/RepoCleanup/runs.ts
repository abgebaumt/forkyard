/**
 * Clean-up runs per repository, in memory: the dialog may close while the core keeps working and
 * shows the same run (progress, then result) when it opens again.
 */
import { create } from "zustand";
import type { CleanupResult, CleanupStep, CoreError, Id } from "../../core";

export interface CleanupRun {
  jobId: string;
  /** `Date.now()` when the run went to the core; the seconds counter starts here. */
  startedAt: number;
  /** The steps that will run, in the core's order (`plannedSteps`). */
  steps: CleanupStep[];
  /** “Cancel” was pressed; the core is ending the step. */
  stopping: boolean;
  result: CleanupResult | null;
  /** The core refused before any step ran (trust, options, cancelled while waiting). */
  error: CoreError | null;
}

interface CleanupRunsState {
  runs: Record<Id, CleanupRun>;
  /** Open dialogs per repository; they show the outcome themselves. */
  watchers: Record<Id, number>;
  start(repoId: Id, run: Pick<CleanupRun, "jobId" | "startedAt" | "steps">): void;
  finish(repoId: Id, outcome: { result: CleanupResult } | { error: CoreError }): void;
  markStopping(repoId: Id): void;
  clear(repoId: Id): void;
  /** Registers an open dialog; returns the function that unregisters it. */
  watch(repoId: Id): () => void;
  isWatched(repoId: Id): boolean;
}

export const useCleanupRuns = create<CleanupRunsState>()((set, get) => ({
  runs: {},
  watchers: {},
  start: (repoId, run) => set((state) => ({ runs: { ...state.runs, [repoId]: { ...run, stopping: false, result: null, error: null } } })),
  finish: (repoId, outcome) =>
    set((state) => {
      const run = state.runs[repoId];
      if (!run) return state;
      const next: CleanupRun = "result" in outcome ? { ...run, stopping: false, result: outcome.result } : { ...run, stopping: false, error: outcome.error };
      return { runs: { ...state.runs, [repoId]: next } };
    }),
  markStopping: (repoId) =>
    set((state) => {
      const run = state.runs[repoId];
      return run ? { runs: { ...state.runs, [repoId]: { ...run, stopping: true } } } : state;
    }),
  clear: (repoId) =>
    set((state) => {
      if (!(repoId in state.runs)) return state;
      const runs = { ...state.runs };
      delete runs[repoId];
      return { runs };
    }),
  watch: (repoId) => {
    set((state) => ({ watchers: { ...state.watchers, [repoId]: (state.watchers[repoId] ?? 0) + 1 } }));
    return () => set((state) => ({ watchers: { ...state.watchers, [repoId]: Math.max(0, (state.watchers[repoId] ?? 1) - 1) } }));
  },
  isWatched: (repoId) => (get().watchers[repoId] ?? 0) > 0,
}));
