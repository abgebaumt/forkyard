import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../core";

const settingsSet = vi.fn<(input: { patch: { zoom?: number } }) => Promise<Settings>>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: { settingsSet: (input: { patch: { zoom?: number } }) => settingsSet(input), on: () => () => undefined },
}));

const { qk, queryClient } = await import("../queries");
const { setZoom } = await import("./repos");

beforeEach(() => {
  queryClient.clear();
  settingsSet.mockReset();
});

describe("zoom", () => {
  it("zoom presses resolve in order", async () => {
    queryClient.setQueryData(qk.settings, { zoom: 1 } as Settings);
    const resolvers: Array<() => void> = [];
    settingsSet.mockImplementation(({ patch }) => new Promise<Settings>((resolve) => resolvers.push(() => resolve({ zoom: patch.zoom } as Settings))));
    const all = Promise.all([setZoom(1.1), setZoom(1.2), setZoom(1.3)]);
    // Without the queue all three calls are already in flight; resolve the first one last.
    await vi.waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(resolvers.length).toBe(i + 1));
      resolvers[i]?.();
    }
    await all;
    expect(settingsSet.mock.calls.map(([input]) => input.patch.zoom)).toEqual([1.1, 1.2, 1.3]);
    expect(queryClient.getQueryData<Settings>(qk.settings)?.zoom).toBe(1.3);
  });
});
