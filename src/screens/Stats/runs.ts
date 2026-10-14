/**
 * Shared statistics runs: one `statsCompute` job per repository, period and branch, however
 * many views ask for it. A view `acquire`s the run for its key and `release`s it when it goes;
 * the job is only cancelled when the last view is gone – one macrotask later, so React's
 * StrictMode (mount, unmount, mount in the same task) or a quick remount joins the same run
 * instead of starting a second one.
 *
 * The last result per key stays for the session (`lastResult`): a view that comes back shows it
 * at once while the new run is going.
 */
import type { CoreError, Id, RepoStats, StatsRange } from "../../core";

export interface RunDeps {
  compute(input: { repoId: Id; jobId: string; range: StatsRange }): Promise<RepoStats>;
  cancel(jobId: string): void;
  newJobId(): string;
  startJob(job: { id: string; title: string; repoId: Id }): void;
  finishJob(jobId: string): void;
  title(): string;
  toError(raw: unknown): CoreError;
}

export type RunOutcome = { ok: true; stats: RepoStats } | { ok: false; error: CoreError };

export interface Run {
  jobId: string;
  /** Never rejects. */
  result: Promise<RunOutcome>;
}

interface Entry extends Run {
  users: number;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/** Results kept for the session (keys: repository, period, branch). */
const MAX_REMEMBERED = 24;

const running = new Map<string, Entry>();
const remembered = new Map<string, RepoStats>();

export function runKey(repoId: Id, range: StatsRange): string {
  return JSON.stringify([repoId, range.ref, range.from, range.to]);
}

/** The last result for this key in this session. */
export function lastResult(key: string): RepoStats | null {
  return remembered.get(key) ?? null;
}

function remember(key: string, stats: RepoStats) {
  remembered.delete(key);
  remembered.set(key, stats);
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

/** Joins the run for `key`, or starts one. Pair every call with one `release`. */
export function acquire(deps: RunDeps, repoId: Id, range: StatsRange): Run {
  const key = runKey(repoId, range);
  const current = running.get(key);
  if (current) {
    current.users += 1;
    if (current.cancelTimer !== null) {
      clearTimeout(current.cancelTimer);
      current.cancelTimer = null;
    }
    return current;
  }
  const jobId = deps.newJobId();
  deps.startJob({ id: jobId, title: deps.title(), repoId });
  const entry: Entry = {
    jobId,
    users: 1,
    cancelTimer: null,
    settled: false,
    result: deps.compute({ repoId, jobId, range }).then(
      (stats): RunOutcome => {
        remember(key, stats);
        return { ok: true, stats };
      },
      (raw: unknown): RunOutcome => ({ ok: false, error: deps.toError(raw) }),
    ),
  };
  void entry.result.then(() => {
    entry.settled = true;
    if (entry.cancelTimer !== null) clearTimeout(entry.cancelTimer);
    if (running.get(key) === entry) running.delete(key);
    deps.finishJob(jobId);
  });
  running.set(key, entry);
  return entry;
}

/** A view no longer needs the run; the last one leaving cancels it (one macrotask later). */
export function release(deps: RunDeps, repoId: Id, range: StatsRange, run: Run): void {
  const key = runKey(repoId, range);
  const entry = running.get(key);
  if (!entry || entry !== run || entry.settled) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  entry.cancelTimer = setTimeout(() => {
    entry.cancelTimer = null;
    if (entry.users > 0 || entry.settled) return;
    if (running.get(key) === entry) running.delete(key);
    deps.cancel(entry.jobId);
  }, 0);
}

/** For tests: forget everything. */
export function resetRuns(): void {
  for (const entry of running.values()) if (entry.cancelTimer !== null) clearTimeout(entry.cancelTimer);
  running.clear();
  remembered.clear();
}
