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
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { core, type Id, type StatsRange } from "../../core";
import { toCoreError } from "../../app/errors";
import { newJobId } from "../../app/run";
import { useAppStore, type Job } from "../../app/store";
import { t } from "../../i18n";
import { acquire, lastResult, release, runKey, type RunDeps } from "./runs";
import { needsRefresh, shown, statsReducer, type StatsState } from "./state";

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

export function useStats(repoId: Id, range: StatsRange, tip: string | null | undefined) {
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
      // Nothing changed since the last time: show it, no job.
      if (remembered && tipRef.current !== undefined && remembered.tip === tipRef.current) {
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
  }, [repoId, key, nonce]);

  // The branch moved on (commit, pull, checkout …): compute again, once per new tip.
  useEffect(() => {
    if (!needsRefresh(state, tip, triedFor.current)) return;
    triedFor.current = tip ?? null;
    setNonce((value) => value + 1);
  }, [state, tip]);

  const jobId = state.kind === "running" ? state.jobId : null;
  const job: Job | undefined = useAppStore((store) => (jobId ? store.jobs[jobId] : undefined));
  return { state, stats: shown(state), job, recompute: () => setNonce((value) => value + 1) };
}
