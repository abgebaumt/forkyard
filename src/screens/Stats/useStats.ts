/**
 * Runs `statsCompute` for the statistics view: one job per repository, period and branch (shown
 * in the status bar, cancellable there), shared by every view that shows the same (runs.ts) and
 * cancelled when the last of them closes. Errors stay in the view as state – no toast (spec:
 * background checks report in the view).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { core, type Id, type StatsRange } from "../../core";
import { toCoreError } from "../../app/errors";
import { newJobId } from "../../app/run";
import { useAppStore, type Job } from "../../app/store";
import { t } from "../../i18n";
import { acquire, release, type RunDeps } from "./runs";
import { shown, statsReducer, type StatsState } from "./state";

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

export function useStats(repoId: Id, range: StatsRange) {
  const [state, dispatch] = useReducer(statsReducer, IDLE);
  const [nonce, setNonce] = useState(0);
  const lastKey = useRef<string | null>(null);
  const key = JSON.stringify([repoId, range.ref, range.from, range.to]);

  useEffect(() => {
    const [, ref, from, to] = JSON.parse(key) as [Id, string, string | null, string | null];
    const wanted: StatsRange = { ref, from, to };
    const run = acquire(deps, repoId, wanted);
    dispatch({ type: "start", jobId: run.jobId, keep: lastKey.current === key });
    lastKey.current = key;
    void run.result.then((outcome) =>
      dispatch(outcome.ok ? { type: "done", jobId: run.jobId, stats: outcome.stats } : { type: "failed", jobId: run.jobId, error: outcome.error }),
    );
    return () => release(deps, repoId, wanted, run);
  }, [repoId, key, nonce]);

  const jobId = state.kind === "running" ? state.jobId : null;
  const job: Job | undefined = useAppStore((store) => (jobId ? store.jobs[jobId] : undefined));
  return { state, stats: shown(state), job, recompute: () => setNonce((value) => value + 1) };
}
