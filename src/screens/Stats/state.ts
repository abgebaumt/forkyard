/**
 * What the statistics view shows while jobs come and go. Answers of a job that is no longer
 * the current one are ignored; a cancelled run falls back to what was shown before. Errors stay
 * in the view (no toast).
 */
import type { CoreError, RepoStats } from "../../core";

export type StatsState =
  | { kind: "idle" }
  | { kind: "running"; jobId: string; previous: RepoStats | null }
  | { kind: "done"; stats: RepoStats }
  | { kind: "failed"; error: CoreError; previous: RepoStats | null };

export type StatsEvent =
  /** `keep`: the same period and branch again – the old numbers stay visible meanwhile. */
  | { type: "start"; jobId: string; keep: boolean }
  | { type: "done"; jobId: string; stats: RepoStats }
  | { type: "failed"; jobId: string; error: CoreError };

/** The statistics on screen (also while a new run is going). */
export function shown(state: StatsState): RepoStats | null {
  switch (state.kind) {
    case "done":
      return state.stats;
    case "running":
    case "failed":
      return state.previous;
    case "idle":
      return null;
  }
}

export function statsReducer(state: StatsState, event: StatsEvent): StatsState {
  switch (event.type) {
    case "start":
      return { kind: "running", jobId: event.jobId, previous: event.keep ? shown(state) : null };
    case "done":
      return state.kind === "running" && state.jobId === event.jobId ? { kind: "done", stats: event.stats } : state;
    case "failed":
      if (state.kind !== "running" || state.jobId !== event.jobId) return state;
      if (event.error.code === "cancelled") return state.previous ? { kind: "done", stats: state.previous } : { kind: "idle" };
      return { kind: "failed", error: event.error, previous: state.previous };
  }
}
