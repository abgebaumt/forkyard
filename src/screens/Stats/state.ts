/**
 * What the statistics view shows while jobs come and go. Answers of a job that is no longer
 * the current one are ignored; a cancelled run falls back to what was shown before, or – with
 * nothing to fall back to – says so in the view until it is started again. Errors stay in the view
 * (no toast).
 */
import type { CoreError, RepoStats } from "../../core";

export type StatsState =
  | { kind: "idle" }
  /** The first run was cancelled: nothing to show, computing again is up to the user. */
  | { kind: "cancelled" }
  | { kind: "running"; jobId: string; previous: RepoStats | null }
  | { kind: "done"; stats: RepoStats }
  | { kind: "failed"; error: CoreError; previous: RepoStats | null };

export type StatsEvent =
  /**
   * `keep`: the same period and branch again – the old numbers stay visible meanwhile.
   * `fallback`: shown meanwhile when nothing else is (the last result of this session).
   */
  | { type: "start"; jobId: string; keep: boolean; fallback?: RepoStats | null }
  | { type: "done"; jobId: string; stats: RepoStats }
  /** A result that needs no job (the session's last one, still up to date). */
  | { type: "show"; stats: RepoStats }
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
    case "cancelled":
      return null;
  }
}

export function statsReducer(state: StatsState, event: StatsEvent): StatsState {
  switch (event.type) {
    case "start":
      return { kind: "running", jobId: event.jobId, previous: (event.keep ? shown(state) : null) ?? event.fallback ?? null };
    case "done":
      return state.kind === "running" && state.jobId === event.jobId ? { kind: "done", stats: event.stats } : state;
    case "show":
      return { kind: "done", stats: event.stats };
    case "failed":
      if (state.kind !== "running" || state.jobId !== event.jobId) return state;
      if (event.error.code === "cancelled") return state.previous ? { kind: "done", stats: state.previous } : { kind: "cancelled" };
      return { kind: "failed", error: event.error, previous: state.previous };
  }
}

const DAY_MS = 86_400_000;

/**
 * Whether a result was measured on an earlier UTC day than `today` (a day number, see
 * model.ts `utcDay`): its period presets and code age are then yesterday's. Without a reference
 * time (nothing committed) nothing can be out of date.
 */
export function fromEarlierDay(stats: RepoStats, today: number): boolean {
  if (!stats.referenceTime) return false;
  const time = Date.parse(stats.referenceTime);
  return Number.isFinite(time) && Math.floor(time / DAY_MS) < today;
}

/** Whether the session's last result can be shown without a job: same tip, same day. */
export function canReuse(remembered: RepoStats | null, tip: string | null | undefined, today: number): boolean {
  return remembered !== null && tip !== undefined && remembered.tip === tip && !fromEarlierDay(remembered, today);
}

/** What `needsRefresh` remembers a refresh by: the tip and the day it ran for. */
export const refreshMark = (tip: string | null | undefined, today: number): string => `${tip ?? ""}@${today}`;

/**
 * Whether the shown result is out of date: its tip is not the current one (`tip`; undefined =
 * branches not loaded, null = no commit), or it is from an earlier day than `today` (the view
 * stayed open past midnight). `triedFor`: the `refreshMark` a refresh already ran for – so a tip
 * the core sees differently cannot loop.
 */
export function needsRefresh(state: StatsState, tip: string | null | undefined, triedFor: string | null, today: number): boolean {
  if (state.kind !== "done" || !tip || refreshMark(tip, today) === triedFor) return false;
  return state.stats.tip !== tip || fromEarlierDay(state.stats, today);
}
