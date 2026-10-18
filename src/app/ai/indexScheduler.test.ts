import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexScheduler } from "./indexScheduler";

describe("growing the search index after fetch and commit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits until the refs are quiet and runs once per repository", async () => {
    const update = vi.fn(async (_repoId: string) => undefined);
    const scheduler = createIndexScheduler({ delayMs: 3000, enabled: () => true, update });
    scheduler.changed("r1", ["refs"]);
    scheduler.changed("r2", ["refs"]);
    await vi.advanceTimersByTimeAsync(2000);
    scheduler.changed("r1", ["head", "worktree"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(update.mock.calls).toEqual([["r2"]]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(update.mock.calls, "r1 waited for its last change").toEqual([["r2"], ["r1"]]);
  });

  it("ignores working-directory changes and repositories where the search is not shown", async () => {
    const update = vi.fn(async (_repoId: string) => undefined);
    const scheduler = createIndexScheduler({ delayMs: 10, enabled: (repoId) => repoId === "on", update });
    scheduler.changed("on", ["worktree", "index", "stash"]);
    scheduler.changed("off", ["refs"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(update).not.toHaveBeenCalled();
  });

  it("never runs twice at once, catches up afterwards and stays quiet on errors", async () => {
    const finish: Array<(failed: boolean) => void> = [];
    const update = vi.fn((_repoId: string) => new Promise<void>((resolve, reject) => finish.push((failed) => (failed ? reject(new Error("offline")) : resolve()))));
    const scheduler = createIndexScheduler({ delayMs: 10, enabled: () => true, update });
    scheduler.changed("r", ["refs"]);
    await vi.advanceTimersByTimeAsync(10);
    scheduler.changed("r", ["refs"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(update).toHaveBeenCalledTimes(1);
    finish[0]?.(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(update).toHaveBeenCalledTimes(2);
    finish[1]?.(false);
    scheduler.changed("r", ["head"]);
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(50);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
