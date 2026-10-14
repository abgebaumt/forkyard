import { describe, expect, it } from "vitest";
import { CoreError, type RepoStats } from "../../core";
import { shown, statsReducer, type StatsState } from "./state";

const stats = (commits: number) => ({ commits }) as RepoStats;
const error = (code: "cancelled" | "not_found") => new CoreError({ code, message: code, gitOutput: null });
const idle: StatsState = { kind: "idle" };

describe("statistics view state", () => {
  it("start → done shows the result of exactly this job", () => {
    const running = statsReducer(idle, { type: "start", jobId: "a", keep: false });
    expect(running).toEqual({ kind: "running", jobId: "a", previous: null });
    expect(statsReducer(running, { type: "done", jobId: "b", stats: stats(9) })).toBe(running);
    expect(shown(statsReducer(running, { type: "done", jobId: "a", stats: stats(9) }))?.commits).toBe(9);
  });

  it("recomputing keeps the old numbers visible, another period does not", () => {
    const done: StatsState = { kind: "done", stats: stats(3) };
    expect(shown(statsReducer(done, { type: "start", jobId: "x", keep: true }))?.commits).toBe(3);
    expect(shown(statsReducer(done, { type: "start", jobId: "y", keep: false }))).toBeNull();
  });

  it("a failure stays in the view with the old numbers; a cancelled run falls back", () => {
    const running: StatsState = { kind: "running", jobId: "a", previous: stats(3) };
    const failed = statsReducer(running, { type: "failed", jobId: "a", error: error("not_found") });
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.error.code).toBe("not_found");
    expect(shown(failed)?.commits).toBe(3);
    expect(statsReducer(running, { type: "failed", jobId: "a", error: error("cancelled") })).toEqual({ kind: "done", stats: stats(3) });
    expect(statsReducer({ kind: "running", jobId: "a", previous: null }, { type: "failed", jobId: "a", error: error("cancelled") })).toEqual(idle);
    expect(statsReducer(running, { type: "failed", jobId: "old", error: error("not_found") })).toBe(running);
  });
});
