import { describe, expect, it, vi } from "vitest";
import type { PatchSelection, Status } from "../../core";

const stagePatch = vi.fn<(input: unknown) => Promise<Status>>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: { stagePatch: (input: unknown) => stagePatch(input), on: () => () => undefined },
}));
vi.mock("../../ui/Feedback", async (original) => ({ ...(await original<typeof import("../../ui/Feedback")>()), toast: vi.fn() }));

const { qk, queryClient } = await import("../../app/queries");
const { applyPatch } = await import("./actions");

const selection: PatchSelection = { path: "sitzung.ts", expect: "tok", hunks: [{ index: 0, lines: [1] }] };
const after = { head: { kind: "branch", branch: "main", sha: "h1" }, unstaged: [], staged: [] } as unknown as Status;

describe("applyPatch", () => {
  it("reports success before the new status reaches the cache, so the lasso guard never sees our own change", async () => {
    stagePatch.mockResolvedValue(after);
    let cachedAtCallback: unknown = "unset";
    const outcome = await applyPatch("stage", "r1", selection, 1, () => {
      cachedAtCallback = queryClient.getQueryData(qk.status("r1"));
    });
    expect(outcome.result).toBe("done");
    expect(cachedAtCallback).toBeUndefined();
    expect(queryClient.getQueryData(qk.status("r1"))).toBe(after);
  });

  it("does not report success when the core refuses", async () => {
    stagePatch.mockRejectedValue({ code: "stale_state", message: "stale", gitOutput: null });
    const onApplied = vi.fn();
    await expect(applyPatch("stage", "r2", selection, 1, onApplied)).resolves.toEqual({ result: "stale" });
    expect(onApplied).not.toHaveBeenCalled();
  });
});
