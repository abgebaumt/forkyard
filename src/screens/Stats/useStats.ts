/**
 * Runs `statsCompute` for the statistics view: one job per repository, period and branch (shown
 * in the status bar, cancellable there), shared by every view that shows the same (runs.ts) and
 * cancelled when the last of them closes. Errors stay in the view as state – no toast (spec:
 * background checks report in the view).
 *
 * Keeping up with the branch: `tip` is its current commit (from the refs query, which follows
 * `repo:changed`; undefined while it loads). A view that comes back shows the session's last
 * result at once; it computes again only when that result is behind `tip` (or `tip` is not known
 * yet – the core's cache then answers). A result that falls behind while the view is open is
 * recomputed in the background, the old numbers stay visible meanwhile.
 *
 * Keeping up with the calendar: `today` is the current UTC day (`useUtcDay`). A result measured
 * on an earlier day – periods start at midnight UTC, the code age is measured against now – is
 * recomputed too, also while the view stays open past midnight (the core's cache answers quickly).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { core, type Id, type StatsRange } from "../../core";
import { toCoreError } from "../../app/errors";
import { newJobId } from "../../app/run";
import { useAppStore, type Job } from "../../app/store";
import { t } from "../../i18n";
import { acquire, lastResult, release, runKey, type RunDeps } from "./runs";
import { msToNextUtcDay, utcDay } from "./model";
import { canReuse, needsRefresh, refreshMark, shown, statsReducer, type StatsState } from "./state";

const IDLE: StatsState = { kind: "idle" };

const deps: RunDeps = {
  compute: (input) => core.statsCompute(input),
  cancel: (jobId) => void core.jobCancel({ jobId }).catch(() => undefined),
  newJobId,
  startJob: (job) => useAppStore.getState().startJob(job),
  finishJob: (jobId) => useAppStore.getState().finishJob(jobId),
  title: () => t("stats.job"),
  toError: toCoreError,
};

/** The current UTC day (day number); changes at midnight UTC and when the window comes back after a sleep. */
export function useUtcDay(): number {
  const [day, setDay] = useState(() => utcDay());
  useEffect(() => {
    const check = () => setDay(utcDay());
    // A second late, so the timer never fires just before midnight.
    const timer = setTimeout(check, msToNextUtcDay() + 1000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [day]);
  return day;
}

export function useStats(repoId: Id, range: StatsRange, tip: string | null | undefined, today: number) {
  const [state, dispatch] = useReducer(statsReducer, IDLE);
  const [nonce, setNonce] = useState(0);
  const lastKey = useRef<string | null>(null);
  const lastNonce = useRef(nonce);
  const tipRef = useRef(tip);
  tipRef.current = tip;
  const triedFor = useRef<string | null>(null);
  const key = runKey(repoId, range);

  useEffect(() => {
    const [, ref, from, to] = JSON.parse(key) as [Id, string, string | null, string | null];
    const wanted: StatsRange = { ref, from, to };
    const again = lastKey.current === key;
    // A recompute (button, branch moved) – not a remount (StrictMode) or another period.
    const requested = again && lastNonce.current !== nonce;
    if (!again) triedFor.current = null;
    lastKey.current = key;
    lastNonce.current = nonce;
    const remembered = lastResult(key);
    if (!requested) {
      // Nothing changed since the last time (same tip, same day): show it, no job.
      if (remembered && canReuse(remembered, tipRef.current, today)) {
        dispatch({ type: "show", stats: remembered });
        return;
      }
    }
    const run = acquire(deps, repoId, wanted);
    dispatch({ type: "start", jobId: run.jobId, keep: again, fallback: remembered });
    void run.result.then((outcome) =>
      dispatch(outcome.ok ? { type: "done", jobId: run.jobId, stats: outcome.stats } : { type: "failed", jobId: run.jobId, error: outcome.error }),
    );
    return () => release(deps, repoId, wanted, run);
  }, [repoId, key, nonce, today]);

  // The branch moved on (commit, pull, checkout …) or a new day began: compute again, once per tip and day.
  useEffect(() => {
    if (!needsRefresh(state, tip, triedFor.current, today)) return;
    triedFor.current = refreshMark(tip, today);
    setNonce((value) => value + 1);
  }, [state, tip, today]);

  const jobId = state.kind === "running" ? state.jobId : null;
  const job: Job | undefined = useAppStore((store) => (jobId ? store.jobs[jobId] : undefined));
  return { state, stats: shown(state), job, recompute: () => setNonce((value) => value + 1) };
}
