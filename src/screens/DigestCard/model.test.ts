import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Digest, DigestRef } from "../../core";

type GetInput = { repoId: string; minAgeHours?: number | null };
const digestGet = vi.fn<(input: GetInput) => Promise<Digest | null>>();
const toastSpy = vi.fn<(options: { tone: string; title: string }) => void>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: { digestGet: (input: GetInput) => digestGet(input), on: () => () => undefined },
}));

vi.mock("../../ui/Feedback", async (original) => ({
  ...(await original<typeof import("../../ui/Feedback")>()),
  toast: (options: { tone: string; title: string }) => toastSpy(options),
}));

const ref = (partial: Partial<DigestRef> & Pick<DigestRef, "name">): DigestRef => ({
  kind: "remote",
  change: "updated",
  oldSha: "a".repeat(40),
  newSha: "b".repeat(40),
  newCommits: 0,
  commits: [],
  ...partial,
});

const sample: Digest = {
  seenAt: "2026-11-19T08:00:00Z",
  refs: [
    ref({
      name: "origin/main",
      newCommits: 3,
      commits: [
        { sha: "c".repeat(40), subject: "Anmeldung prüfen", author: "Jörg" },
        { sha: "d".repeat(40), subject: "Fix build", author: "Ana" },
      ],
    }),
    ref({ name: "v1.0", kind: "tag", change: "new", oldSha: null }),
  ],
  newCommits: 3,
  yourFiles: [{ path: "src/main.rs", sha: "c".repeat(40), local: true, onBranch: false }],
  behind: { branch: "feature", base: "origin/main", behind: 3, ahead: 1 },
  prs: {
    changed: [
      { number: 7, title: "Login", change: "opened", author: "ana", webUrl: "https://example.test/7" },
      { number: 5, title: "Cache", change: "merged", author: null, webUrl: "https://example.test/5" },
    ],
    comments: [{ number: 7, title: "Login", count: 2 }],
  },
  prDataMissing: null,
  prMaxNumber: 7,
  isEmpty: false,
};

const deletedOnly: Digest = {
  ...sample,
  refs: [ref({ name: "origin/old", change: "deleted", newSha: null })],
  behind: null,
  prs: null,
  yourFiles: [],
};

const { qk, queryClient } = await import("../../app/queries");
const { useAppStore } = await import("../../app/store");
const { checkDigestAfterFetch, openDigestCard } = await import("./actions");

const withTab = () => queryClient.setQueryData(qk.tabs, [{ id: "t1", kind: "repo", repoId: "r1" }]);

const { digestNumbers, digestRows } = await import("./model");

describe("digestNumbers", () => {
  it("counts commits, changed pull requests with comments, and your files", () => {
    expect(digestNumbers(sample)).toEqual({ commits: 3, prs: 3, files: 1 });
  });
  it("counts no pull requests without PR data", () => expect(digestNumbers(deletedOnly).prs).toBe(0));
});

describe("digestRows", () => {
  it("lists behind first, each ref with its commits, then PRs and files", () => {
    expect(digestRows(sample).map((row) => row.kind)).toEqual(["behind", "ref", "commit", "commit", "ref", "pr", "pr", "pr", "file"]);
  });
  it("keys stay unique when a pull request is both changed and commented", () => {
    const keys = digestRows(sample).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("names the change in words, a new tag as such", () => {
    const labels = digestRows(sample).map((row) => row.label);
    expect(labels).toContain("v1.0 – new tag");
    expect(labels).toContain("origin/main – updated");
    expect(labels).toContain("feature is 3 commits behind origin/main");
  });
  it("a deleted ref row has no target", () => {
    expect(digestRows(deletedOnly)[0]).toMatchObject({ kind: "ref", sha: null });
  });
});

beforeEach(() => {
  digestGet.mockReset();
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
