import { describe, expect, it } from "vitest";
import type { Digest, DigestRef } from "../../core";
import { digestNumbers, digestRows } from "./model";

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
