import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError, type RepoStats, type StatsRange } from "../../core";
import { acquire, lastResult, release, resetRuns, runKey, type RunDeps } from "./runs";

const range: StatsRange = { ref: "HEAD", from: null, to: null };
const stats = (tip: string) => ({ tip, commits: 1 }) as RepoStats;

function fakeDeps() {
  const pending: Array<{ jobId: string; resolve: (stats: RepoStats) => void; reject: (raw: unknown) => void }> = [];
  const jobs = new Set<string>();
  let next = 0;
  const deps: RunDeps = {
    compute: vi.fn(({ jobId }) => new Promise<RepoStats>((resolve, reject) => pending.push({ jobId, resolve, reject }))),
    cancel: vi.fn((jobId: string) => {
      const call = pending.find((item) => item.jobId === jobId);
      call?.reject(new CoreError({ code: "cancelled", message: "cancelled", gitOutput: null }));
    }),
    newJobId: () => `job-${++next}`,
    startJob: ({ id }) => jobs.add(id),
    finishJob: (id) => jobs.delete(id),
    title: () => "Statistics",
    toError: (raw) => raw as CoreError,
  };
  return { deps, pending, jobs };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("shared statistics runs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRuns();
  });
  afterEach(() => vi.useRealTimers());

  it("StrictMode (acquire, release, acquire in one task) starts one computation and one job", async () => {
    const { deps, jobs } = fakeDeps();
    const first = acquire(deps, "r1", range);
    release(deps, "r1", range, first);
    const second = acquire(deps, "r1", range);
    vi.runAllTimers();
    expect(deps.compute).toHaveBeenCalledTimes(1);
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(second.jobId).toBe(first.jobId);
    expect(jobs.size).toBe(1);
  });

  it("two views on the same repository, period and branch share one job", async () => {
    const { deps, pending, jobs } = fakeDeps();
    const a = acquire(deps, "r1", range);
    const b = acquire(deps, "r1", range);
    expect(deps.compute).toHaveBeenCalledTimes(1);
    expect(jobs.size).toBe(1);
    release(deps, "r1", range, a);
    vi.runAllTimers();
    expect(deps.cancel).not.toHaveBeenCalled();
    pending[0]!.resolve(stats("t1"));
    expect(await b.result).toEqual({ ok: true, stats: stats("t1") });
    await flush();
    expect(jobs.size).toBe(0);
    expect(lastResult(runKey("r1", range))?.tip).toBe("t1");
  });

  it("another branch or repository is its own run", () => {
    const { deps } = fakeDeps();
    acquire(deps, "r1", range);
    acquire(deps, "r1", { ...range, ref: "refs/heads/dev" });
    acquire(deps, "r2", range);
    expect(deps.compute).toHaveBeenCalledTimes(3);
  });

  it("the last view leaving cancels the job; the next view starts a new one", async () => {
    const { deps, jobs } = fakeDeps();
    const run = acquire(deps, "r1", range);
    release(deps, "r1", range, run);
    expect(deps.cancel).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(deps.cancel).toHaveBeenCalledWith(run.jobId);
    expect((await run.result).ok).toBe(false);
    await flush();
    expect(jobs.size).toBe(0);
    const again = acquire(deps, "r1", range);
    expect(again.jobId).not.toBe(run.jobId);
    expect(deps.compute).toHaveBeenCalledTimes(2);
  });

  it("a finished run is not cancelled and the next acquire computes again (the core cache answers)", async () => {
    const { deps, pending } = fakeDeps();
    const run = acquire(deps, "r1", range);
    pending[0]!.resolve(stats("t1"));
    await run.result;
    await flush();
    release(deps, "r1", range, run);
    vi.runAllTimers();
    expect(deps.cancel).not.toHaveBeenCalled();
    acquire(deps, "r1", range);
    expect(deps.compute).toHaveBeenCalledTimes(2);
  });
});
