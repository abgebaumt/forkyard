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

/** `active`: job of the running request (null = none); `asking`: the send gate is open. */
export interface JobState {
  run: AiRun;
  active: string | null;
  asking: boolean;
}

export type JobEvent =
  | { type: "ask" }
  | { type: "asked" }
  | { type: "start"; jobId: string; at: number }
  | { type: "done"; jobId: string }
  /** `jobId` null: an error outside a job (preview, gate). */
  | { type: "fail"; jobId: string | null; view: AiErrorView }
  | { type: "cancel" }
  | { type: "reset" };

const IDLE: AiRun = { kind: "idle" };
export const JOB_IDLE: JobState = { run: IDLE, active: null, asking: false };

/** The job state machine. An answer or error of a job that is no longer active leaves the state as it is. */
export function jobStep(state: JobState, event: JobEvent): JobState {
  switch (event.type) {
    case "ask":
      return { ...state, run: IDLE, asking: true };
    case "asked":
      return { ...state, asking: false };
    case "start":
      return { run: { kind: "running", startedAt: event.at }, active: event.jobId, asking: false };
    case "done":
      return state.active === event.jobId ? { ...state, run: IDLE, active: null } : state;
    case "fail": {
      if (event.jobId !== null && state.active !== event.jobId) return state;
      const run: AiRun = event.view.kind === "cancelled" ? IDLE : { kind: "failed", view: event.view };
      return { ...state, run, active: event.jobId === null ? state.active : null };
    }
    case "cancel":
      return { ...state, run: IDLE, active: null };
    case "reset":
      return { ...state, run: IDLE };
  }
}

export interface AiJob {
  run: AiRun;
  running: boolean;
  /** Loading text and slow hint while running, else null. */
  loading: AiLoadingView | null;
  /** True while a job is out or its send gate is open (also before React re-rendered). */
  busy: () => boolean;
  /** Back to idle (e.g. before a new preview). */
  reset: () => void;
  /** Shows an error inline; a cancel only resets. */
  fail: (error: unknown) => void;
  /**
   * Runs `send` as a new job. Resolves with the answer, or with undefined when the job failed
   * (then `run` shows why), was cancelled or was superseded. With `gate` (e.g. `askAi`) the gate
   * runs first: a falsy result sends nothing, a throw shows inline, and while a job or a gate is
   * out a second call is ignored. Nothing starts once the view is gone.
   */
  start: <T>(send: (jobId: string) => Promise<T>, gate?: () => Promise<unknown>) => Promise<T | undefined>;
  cancel: () => void;
}

/** `local`: the provider runs on this machine (slower hint); `label`: the loading text. */
export function useAiJob(local: boolean, label?: string): AiJob {
  const [run, setRun] = useState<AiRun>(IDLE);
  const [now, setNow] = useState(() => Date.now());
  const state = useRef<JobState>(JOB_IDLE);
  const mounted = useRef(true);
  const running = run.kind === "running";

  /** Applies `event`; false when the state machine ignored it (a stale job). */
  const dispatch = (event: JobEvent): boolean => {
    const next = jobStep(state.current, event);
    if (next === state.current) return false;
    state.current = next;
    setRun(next.run);
    return true;
  };

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Leaving the view cancels a running request; its answer is dropped.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const jobId = state.current.active;
      state.current = jobStep(state.current, { type: "cancel" });
      if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
    };
  }, []);

  const busy = () => state.current.active !== null || state.current.asking;
  const fail = (error: unknown) => void dispatch({ type: "fail", jobId: null, view: errorView(error) });

  const start = async <T>(send: (jobId: string) => Promise<T>, gate?: () => Promise<unknown>): Promise<T | undefined> => {
    if (gate) {
      if (busy() || !mounted.current) return undefined;
      dispatch({ type: "ask" });
      let sent: unknown;
      try {
        sent = await gate();
      } catch (error) {
        dispatch({ type: "asked" });
        if (mounted.current) fail(error);
        return undefined;
      }
      dispatch({ type: "asked" });
      if (!sent) return undefined;
    }
    if (!mounted.current) return undefined;
    const jobId = newJobId();
    setNow(Date.now());
    dispatch({ type: "start", jobId, at: Date.now() });
    try {
      const answer = await send(jobId);
      return dispatch({ type: "done", jobId }) ? answer : undefined;
    } catch (error) {
      dispatch({ type: "fail", jobId, view: errorView(error) });
      return undefined;
    }
  };

  const cancel = () => {
    const jobId = state.current.active;
    dispatch({ type: "cancel" });
    if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
  };

  return {
    run,
    running,
    loading: run.kind === "running" ? loadingView(now - run.startedAt, local, label) : null,
    busy,
    reset: () => void dispatch({ type: "reset" }),
    fail,
    start,
    cancel,
  };
}
