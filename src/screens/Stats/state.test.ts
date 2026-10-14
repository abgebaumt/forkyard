import { describe, expect, it } from "vitest";
import { CoreError, type RepoStats } from "../../core";
import { needsRefresh, shown, statsReducer, type StatsState } from "./state";

const stats = (commits: number, tip: string | null = "t1") => ({ commits, tip }) as RepoStats;
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

  it("a view that comes back shows the remembered result at once while the new run goes", () => {
    const running = statsReducer(idle, { type: "start", jobId: "a", keep: false, fallback: stats(7) });
    expect(running).toEqual({ kind: "running", jobId: "a", previous: stats(7) });
    const done: StatsState = { kind: "done", stats: stats(3) };
    expect(shown(statsReducer(done, { type: "start", jobId: "b", keep: true, fallback: stats(7) }))?.commits, "what is on screen wins").toBe(3);
  });

  it("recomputes once when the branch tip moved past the shown result", () => {
    const done: StatsState = { kind: "done", stats: stats(3, "t1") };
    expect(needsRefresh(done, "t1", null)).toBe(false);
    expect(needsRefresh(done, "t2", null)).toBe(true);
    expect(needsRefresh(done, "t2", "t2"), "tried for this tip already").toBe(false);
    expect(needsRefresh(done, null, null), "tip unknown or unborn").toBe(false);
    expect(needsRefresh(done, undefined, null), "branches not loaded yet").toBe(false);
    expect(needsRefresh({ kind: "running", jobId: "a", previous: stats(3) }, "t2", null), "a run is going").toBe(false);
    expect(needsRefresh({ kind: "failed", error: error("not_found"), previous: null }, "t2", null)).toBe(false);
    expect(needsRefresh({ kind: "done", stats: stats(0, null) }, "t2", null), "empty before, a first commit now").toBe(true);
  });
});
