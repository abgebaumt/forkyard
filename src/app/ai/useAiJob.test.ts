import { describe, expect, it, vi } from "vitest";

vi.mock("../../core", () => ({ core: {} }));

import { JOB_IDLE, jobStep, type JobState } from "./useAiJob";

const other = { kind: "other", text: "boom" } as const;
const running = (jobId: string): JobState => jobStep(JOB_IDLE, { type: "start", jobId, at: 5 });

describe("jobStep", () => {
  it("runs a job and returns to idle on its answer", () => {
    const s = running("a");
    expect(s).toEqual({ run: { kind: "running", startedAt: 5 }, active: "a", asking: false });
    expect(jobStep(s, { type: "done", jobId: "a" })).toEqual(JOB_IDLE);
  });

  it("ignores the answer and the error of a job that is no longer active", () => {
    const cancelled = jobStep(running("a"), { type: "cancel" });
    expect(jobStep(cancelled, { type: "done", jobId: "a" })).toBe(cancelled);
    expect(jobStep(cancelled, { type: "fail", jobId: "a", view: other })).toBe(cancelled);
    const superseded = jobStep(running("a"), { type: "start", jobId: "b", at: 6 });
    expect(jobStep(superseded, { type: "done", jobId: "a" })).toBe(superseded);
  });

  it("shows a job error inline, but a cancel from the core as idle", () => {
    expect(jobStep(running("a"), { type: "fail", jobId: "a", view: other })).toEqual({
      run: { kind: "failed", view: other },
      active: null,
      asking: false,
    });
    expect(jobStep(running("a"), { type: "fail", jobId: "a", view: { kind: "cancelled" } })).toEqual(JOB_IDLE);
  });

  it("an error outside a job (preview) shows inline and leaves the active job alone", () => {
    expect(jobStep(JOB_IDLE, { type: "fail", jobId: null, view: other }).run).toEqual({ kind: "failed", view: other });
    expect(jobStep(running("a"), { type: "fail", jobId: null, view: other }).active).toBe("a");
  });

  it("the open send gate clears an old error and counts as busy until it closes", () => {
    const failed = jobStep(JOB_IDLE, { type: "fail", jobId: null, view: other });
    const asking = jobStep(failed, { type: "ask" });
    expect(asking).toEqual({ run: { kind: "idle" }, active: null, asking: true });
    expect(jobStep(asking, { type: "asked" }).asking).toBe(false);
    expect(jobStep(asking, { type: "start", jobId: "a", at: 1 }).asking).toBe(false);
  });
});
