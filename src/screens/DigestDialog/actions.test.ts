import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Digest } from "../../core";

type GetInput = { repoId: string; ifChanged?: boolean | null };
const digestGet = vi.fn<(input: GetInput) => Promise<Digest | null>>();
const showDigestDialog = vi.fn<(repoId: string, tabId: string, digest: Digest) => Promise<null>>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: { digestGet: (input: GetInput) => digestGet(input), on: () => () => undefined },
}));
vi.mock("./index", () => ({ showDigestDialog: (...args: [string, string, Digest]) => showDigestDialog(...args) }));

const sample = {
  since: "2026-11-19T08:00:00Z",
  refs: [{ name: "origin/main", kind: "remote", newSha: "b".repeat(40), newCommits: 1, commits: [] }],
  newCommits: 1,
  yourFiles: [],
  behind: null,
  prs: null,
  prDataMissing: null,
  isEmpty: false,
} satisfies Digest;

const { qk, queryClient } = await import("../../app/queries");
const { checkDigestAfterFetch, openDigest } = await import("./actions");

const withTab = (isActive = true) => queryClient.setQueryData(qk.tabs, [{ id: "t1", kind: "repo", repoId: "r1", isActive }]);

beforeEach(() => {
  digestGet.mockReset();
  showDigestDialog.mockReset();
  showDigestDialog.mockResolvedValue(null);
  queryClient.clear();
});

describe("checkDigestAfterFetch", () => {
  it("asks the core for a changed digest and shows the dialog in the repository's tab", async () => {
    withTab();
    digestGet.mockResolvedValue(sample);
    await checkDigestAfterFetch("r1");
    expect(digestGet).toHaveBeenCalledWith({ repoId: "r1", ifChanged: true });
    expect(showDigestDialog).toHaveBeenCalledWith("r1", "t1", sample);
  });

  it("shows nothing when the core has nothing new", async () => {
    withTab();
    digestGet.mockResolvedValue(null);
    await checkDigestAfterFetch("r1");
    expect(showDigestDialog).not.toHaveBeenCalled();
  });

  it("does nothing for a repository in a background tab", async () => {
    withTab(false);
    await checkDigestAfterFetch("r1");
    expect(digestGet).not.toHaveBeenCalled();
  });

  it("does nothing in a window without a tab for the repository", async () => {
    queryClient.setQueryData(qk.tabs, [{ id: "t2", kind: "repo", repoId: "r2" }]);
    await checkDigestAfterFetch("r1");
    expect(digestGet).not.toHaveBeenCalled();
  });

  it("a failing check is silent", async () => {
    withTab();
    digestGet.mockRejectedValue(new Error("network down"));
    await expect(checkDigestAfterFetch("r1")).resolves.toBeUndefined();
    expect(showDigestDialog).not.toHaveBeenCalled();
  });

  it("asks once while a check runs or the dialog is open, however many fetches come in", async () => {
    withTab();
    let close: (value: null) => void = () => undefined;
    digestGet.mockResolvedValue(sample);
    showDigestDialog.mockImplementation(() => new Promise((resolve) => (close = resolve)));
    const first = checkDigestAfterFetch("r1");
    await vi.waitFor(() => expect(showDigestDialog).toHaveBeenCalledTimes(1));
    await checkDigestAfterFetch("r1");
    await openDigest("r1", "t1");
    expect(digestGet).toHaveBeenCalledTimes(1);
    close(null);
    await first;
    digestGet.mockResolvedValue(null);
    await checkDigestAfterFetch("r1");
    expect(digestGet).toHaveBeenCalledTimes(2);
  });
});

describe("openDigest", () => {
  it("asks without ifChanged and shows the digest, also an empty one", async () => {
    digestGet.mockResolvedValue({ ...sample, refs: [], isEmpty: true });
    await openDigest("r1", "t1");
    expect(digestGet).toHaveBeenCalledWith({ repoId: "r1" });
    expect(showDigestDialog).toHaveBeenCalledWith("r1", "t1", expect.objectContaining({ isEmpty: true }));
  });
});
