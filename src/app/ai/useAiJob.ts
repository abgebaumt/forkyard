/**
 * The lifecycle every AI request in a view shares: one job at a time, a clock for the loading
 * text, cancelling (also when the view goes away), and a late answer of a cancelled job is dropped.
 * Errors land in `run` as the inline view from requestState.ts; a cancel is no error.
 */
import { useEffect, useRef, useState } from "react";
import { core } from "../../core";
import { newJobId } from "../run";
import { errorView, loadingView, type AiErrorView, type AiLoadingView } from "./requestState";

export type AiFailure = Exclude<AiErrorView, { kind: "cancelled" }>;
export type AiRun = { kind: "idle" } | { kind: "running"; startedAt: number } | { kind: "failed"; view: AiFailure };

export interface AiJob {
  run: AiRun;
  running: boolean;
  /** Loading text and slow hint while running, else null. */
  loading: AiLoadingView | null;
  /** True while a job is out (also before React re-rendered). */
  busy: () => boolean;
  /** Back to idle (e.g. before a new preview). */
  reset: () => void;
  /** Shows an error inline; a cancel only resets. */
  fail: (error: unknown) => void;
  /**
   * Runs `send` as a new job. Resolves with the answer, or with undefined when the job failed
   * (then `run` shows why), was cancelled or was superseded.
   */
  start: <T>(send: (jobId: string) => Promise<T>) => Promise<T | undefined>;
  cancel: () => void;
}

/** `local`: the provider runs on this machine (slower hint); `label`: the loading text. */
export function useAiJob(local: boolean, label?: string): AiJob {
  const [run, setRun] = useState<AiRun>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  /** Job of the running request; null = none (a late answer of a cancelled one is dropped). */
  const active = useRef<string | null>(null);
  const running = run.kind === "running";

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Leaving the view cancels a running request; its answer is dropped.
  useEffect(
    () => () => {
      const jobId = active.current;
      active.current = null;
      if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
    },
    [],
  );

  const fail = (error: unknown) => {
    const view = errorView(error);
    setRun(view.kind === "cancelled" ? { kind: "idle" } : { kind: "failed", view });
  };

  const start = async <T>(send: (jobId: string) => Promise<T>): Promise<T | undefined> => {
    const jobId = newJobId();
    active.current = jobId;
    setNow(Date.now());
    setRun({ kind: "running", startedAt: Date.now() });
    try {
      const answer = await send(jobId);
      if (active.current !== jobId) return undefined;
      active.current = null;
      setRun({ kind: "idle" });
      return answer;
    } catch (error) {
      if (active.current !== jobId) return undefined;
      active.current = null;
      fail(error);
      return undefined;
    }
  };

  const cancel = () => {
    const jobId = active.current;
    active.current = null;
    setRun({ kind: "idle" });
    if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
  };

  return {
    run,
    running,
    loading: run.kind === "running" ? loadingView(now - run.startedAt, local, label) : null,
    busy: () => active.current !== null,
    reset: () => setRun({ kind: "idle" }),
    fail,
    start,
    cancel,
  };
}
