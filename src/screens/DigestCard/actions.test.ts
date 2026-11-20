import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Digest } from "../../core";

type GetInput = { repoId: string; minAgeHours?: number | null };
const digestGet = vi.fn<(input: GetInput) => Promise<Digest | null>>();
const digestMarkSeen = vi.fn<(input: { repoId: string; prMaxNumber?: number | null }) => Promise<void>>();
const toastSpy = vi.fn<(options: { tone: string; title: string }) => void>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    digestGet: (input: GetInput) => digestGet(input),
    digestMarkSeen: (input: { repoId: string; prMaxNumber?: number | null }) => digestMarkSeen(input),
    on: () => () => undefined,
  },
}));

vi.mock("../../ui/Feedback", async (original) => ({
  ...(await original<typeof import("../../ui/Feedback")>()),
  toast: (options: { tone: string; title: string }) => toastSpy(options),
}));

const sample = {
  seenAt: "2026-11-19T08:00:00Z",
  refs: [
    { name: "origin/main", kind: "remote", change: "updated", oldSha: "a".repeat(40), newSha: "b".repeat(40), newCommits: 1, commits: [] },
  ],
  newCommits: 1,
  yourFiles: [],
  behind: null,
  prs: null,
  prDataMissing: null,
  prMaxNumber: 7,
  isEmpty: false,
} satisfies Digest;

const { qk, queryClient } = await import("../../app/queries");
const { useAppStore } = await import("../../app/store");
const { checkDigestAfterFetch, digestFetchedWhileOpen, markDigestSeen, openDigestCard } = await import("./actions");

const withTab = () => queryClient.setQueryData(qk.tabs, [{ id: "t1", kind: "repo", repoId: "r1" }]);

beforeEach(() => {
  digestGet.mockReset();
  digestMarkSeen.mockReset();
  toastSpy.mockReset();
  queryClient.clear();
  useAppStore.setState({ digestOpen: {} });
});

describe("checkDigestAfterFetch", () => {
  it("after a fetch the core is asked with minAgeHours 8 only", async () => {
    withTab();
    digestGet.mockResolvedValue(null);
    await checkDigestAfterFetch("r1");
    expect(digestGet).toHaveBeenCalledWith({ repoId: "r1", minAgeHours: 8 });
    expect(useAppStore.getState().digestOpen.r1).toBeFalsy();
  });

  it("opens the card only for a non-empty digest", async () => {
    withTab();
    digestGet.mockResolvedValue({ ...sample, isEmpty: true });
    await checkDigestAfterFetch("r1");
    expect(useAppStore.getState().digestOpen.r1).toBeFalsy();
    digestGet.mockResolvedValue(sample);
    await checkDigestAfterFetch("r1");
    expect(useAppStore.getState().digestOpen.r1).toBe(true);
    expect(queryClient.getQueryData(qk.digest("r1"))).toEqual(sample);
  });

  it("does nothing in a window without a tab for the repository", async () => {
    queryClient.setQueryData(qk.tabs, [{ id: "t2", kind: "repo", repoId: "r2" }]);
    await checkDigestAfterFetch("r1");
    expect(digestGet).not.toHaveBeenCalled();
  });

  it("asks the core once while the card is open or a check runs, however many fetches come in", async () => {
    withTab();
    let answer: (value: Digest | null) => void = () => undefined;
    digestGet.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const first = checkDigestAfterFetch("r1");
    await checkDigestAfterFetch("r1");
    answer(sample);
    await first;
    expect(useAppStore.getState().digestOpen.r1).toBe(true);
    await checkDigestAfterFetch("r1");
    await checkDigestAfterFetch("r1");
    expect(digestGet).toHaveBeenCalledTimes(1);
  });
});

describe("openDigestCard", () => {
  it("asks without a minimum age and opens a non-empty digest", async () => {
    digestGet.mockResolvedValue(sample);
    await openDigestCard("r1");
    expect(digestGet).toHaveBeenCalledWith({ repoId: "r1" });
    expect(useAppStore.getState().digestOpen.r1).toBe(true);
  });

  it("says nothing new instead of opening an empty card", async () => {
    digestGet.mockResolvedValue({ ...sample, isEmpty: true });
    await openDigestCard("r1");
    expect(useAppStore.getState().digestOpen.r1).toBeFalsy();
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Nothing new since /) }));
  });
});

describe("markDigestSeen", () => {
  it("closes the card and marks with the shown PR number", async () => {
    withTab();
    digestGet.mockResolvedValue(sample);
    digestMarkSeen.mockResolvedValue(undefined);
    await checkDigestAfterFetch("r1");
    await markDigestSeen("r1", 7);
    expect(digestMarkSeen).toHaveBeenCalledWith({ repoId: "r1", prMaxNumber: 7 });
    expect(useAppStore.getState().digestOpen.r1).toBe(false);
  });

  it("reopens the card when marking fails", async () => {
    useAppStore.getState().openDigest("r1");
    digestMarkSeen.mockRejectedValue(new Error("db locked"));
    await markDigestSeen("r1", null);
    expect(useAppStore.getState().digestOpen.r1).toBe(true);
  });

  it("a fetch while the card is open: marking reloads the card instead of swallowing unseen news", async () => {
    withTab();
    queryClient.setQueryData(qk.digest("r1"), sample);
    useAppStore.getState().openDigest("r1");
    digestGet.mockResolvedValue(sample);
    // What the `repo:changed` handler does on `fetched`: no core call while the card is open.
    digestFetchedWhileOpen("r1");
    await checkDigestAfterFetch("r1");
    expect(digestGet).not.toHaveBeenCalled();
    await markDigestSeen("r1", 7);
    expect(digestMarkSeen).not.toHaveBeenCalled();
    expect(digestGet).toHaveBeenCalledTimes(1);
    expect(digestGet).toHaveBeenCalledWith({ repoId: "r1" });
    expect(useAppStore.getState().digestOpen.r1).toBe(true);
    expect(queryClient.getQueryState(qk.digest("r1"))?.isInvalidated).toBe(false);
  });
});
