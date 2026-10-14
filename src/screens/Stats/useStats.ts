/**
 * Runs `statsCompute` for the statistics view: one job per period and branch (shown in the
 * status bar, cancellable there), cancelled when the view closes or the choice changes.
 * Errors stay in the view as state – no toast (spec: background checks report in the view).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { core, type Id, type StatsRange } from "../../core";
import { toCoreError } from "../../app/errors";
import { newJobId } from "../../app/run";
import { useAppStore, type Job } from "../../app/store";
import { t } from "../../i18n";
import { shown, statsReducer, type StatsState } from "./state";

const IDLE: StatsState = { kind: "idle" };

export function useStats(repoId: Id, range: StatsRange) {
  const [state, dispatch] = useReducer(statsReducer, IDLE);
  const [nonce, setNonce] = useState(0);
  const lastKey = useRef<string | null>(null);
  const key = JSON.stringify([repoId, range.ref, range.from, range.to]);

  useEffect(() => {
    const [, ref, from, to] = JSON.parse(key) as [Id, string, string | null, string | null];
    const jobId = newJobId();
    dispatch({ type: "start", jobId, keep: lastKey.current === key });
    lastKey.current = key;
    let running = true;
    useAppStore.getState().startJob({ id: jobId, title: t("stats.job"), repoId });
    core
      .statsCompute({ repoId, jobId, range: { ref, from, to } })
      .then((stats) => dispatch({ type: "done", jobId, stats }))
      .catch((raw: unknown) => dispatch({ type: "failed", jobId, error: toCoreError(raw) }))
      .finally(() => {
        running = false;
        useAppStore.getState().finishJob(jobId);
      });
    return () => {
      if (running) void core.jobCancel({ jobId }).catch(() => undefined);
    };
  }, [repoId, key, nonce]);

  const jobId = state.kind === "running" ? state.jobId : null;
  const job: Job | undefined = useAppStore((store) => (jobId ? store.jobs[jobId] : undefined));
  return { state, stats: shown(state), job, recompute: () => setNonce((value) => value + 1) };
}
