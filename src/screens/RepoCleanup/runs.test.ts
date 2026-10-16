import { beforeEach, describe, expect, it } from "vitest";
import { CoreError, type CleanupResult, type ObjectStats } from "../../core";
import { useCleanupRuns } from "./runs";

function stats(loose: number): ObjectStats {
  return { looseCount: loose, looseBytes: loose * 4096, inPack: 0, packs: 0, packBytes: 0, garbageCount: 0, garbageBytes: 0, totalBytes: loose * 4096 };
}
const RESULT: CleanupResult = { before: stats(5), after: stats(0), lfsBefore: null, lfsAfter: null, steps: [{ step: "gc", status: "done", removed: null }], durationMs: 1200, cancelled: false, failure: null };

beforeEach(() => useCleanupRuns.setState({ runs: {}, watchers: {} }));

describe("clean-up runs", () => {
  it("survive closing the dialog and show their result when it opens again", () => {
    const runs = useCleanupRuns.getState();
    const unwatch = runs.watch("r1");
    runs.start("r1", { jobId: "job-1", startedAt: 1000, steps: ["gc"] });
    unwatch();
    expect(useCleanupRuns.getState().isWatched("r1")).toBe(false);
    useCleanupRuns.getState().finish("r1", { result: RESULT });
    expect(useCleanupRuns.getState().runs.r1).toEqual({ jobId: "job-1", startedAt: 1000, steps: ["gc"], stopping: false, result: RESULT, error: null });
    useCleanupRuns.getState().watch("r1");
    expect(useCleanupRuns.getState().isWatched("r1")).toBe(true);
    useCleanupRuns.getState().clear("r1");
    expect(useCleanupRuns.getState().runs.r1).toBeUndefined();
  });

  it("count two open dialogs of the same repository separately", () => {
    const first = useCleanupRuns.getState().watch("r1");
    useCleanupRuns.getState().watch("r1");
    first();
    expect(useCleanupRuns.getState().isWatched("r1")).toBe(true);
    expect(useCleanupRuns.getState().isWatched("r2")).toBe(false);
  });

  it("keep a refusal before any step as error, and “stopping” ends with the run", () => {
    useCleanupRuns.getState().start("r1", { jobId: "job-2", startedAt: 0, steps: ["undo", "gc"] });
    useCleanupRuns.getState().markStopping("r1");
    expect(useCleanupRuns.getState().runs.r1?.stopping).toBe(true);
    useCleanupRuns.getState().finish("r1", { error: new CoreError({ code: "cancelled", message: "Cancelled.", gitOutput: null }) });
    const run = useCleanupRuns.getState().runs.r1;
    expect([run?.stopping, run?.error?.code, run?.result]).toEqual([false, "cancelled", null]);
  });

  it("do not mix repositories", () => {
    useCleanupRuns.getState().start("r1", { jobId: "job-a", startedAt: 0, steps: ["gc"] });
    useCleanupRuns.getState().start("r2", { jobId: "job-b", startedAt: 0, steps: ["gc"] });
    useCleanupRuns.getState().finish("r2", { result: RESULT });
    expect(useCleanupRuns.getState().runs.r1?.result).toBeNull();
    useCleanupRuns.getState().finish("r3", { result: RESULT });
    expect(useCleanupRuns.getState().runs.r3).toBeUndefined();
  });
});
