import { describe, expect, it } from "vitest";
import type { RefsSnapshot } from "../../core";
import { actionLabel, entryKey, HEAD_VALUE, refFromValue, refOptions, refValue, resolveSelection } from "./model";

const refs = {
  head: { kind: "branch", branch: "main", sha: "a" },
  locals: [
    { name: "main", fullName: "refs/heads/main" },
    { name: "feature/x", fullName: "refs/heads/feature/x" },
  ],
  remotes: [{ name: "origin/main", fullName: "refs/remotes/origin/main" }],
  tags: [],
} as unknown as RefsSnapshot;

describe("refOptions", () => {
  it("offers HEAD first, then the local branches", () => {
    expect(refOptions(refs, null).map((option) => option.value)).toEqual([HEAD_VALUE, "refs/heads/main", "refs/heads/feature/x"]);
    expect(refOptions(undefined, null)).toEqual([{ value: HEAD_VALUE, label: "HEAD" }]);
  });

  it("keeps a remote branch opened from its menu selectable", () => {
    expect(refOptions(refs, "refs/remotes/origin/main").at(-1)).toEqual({ value: "refs/remotes/origin/main", label: "origin/main" });
    expect(refOptions(refs, "refs/heads/main")).toHaveLength(3);
  });
});

describe("refValue / refFromValue", () => {
  it("maps HEAD to null and back", () => {
    expect(refValue(null)).toBe(HEAD_VALUE);
    expect(refFromValue(HEAD_VALUE)).toBeNull();
    expect(refFromValue(refValue("refs/heads/main"))).toBe("refs/heads/main");
  });
});

describe("actionLabel", () => {
  it("names every action", () => {
    expect(actionLabel("cherry_pick")).toBe("Cherry-pick");
    expect(actionLabel("amend")).toBe("Amend");
    expect(actionLabel("other")).toBe("Other");
  });
});

describe("resolveSelection", () => {
  const wind = { sha: "w1", time: "2026-10-15T10:00:03Z", message: "commit: Wind erfassen" };
  const older = [
    { sha: "c1", time: "2026-10-15T10:00:05Z", message: "checkout: moving from feature/wind to main" },
    { sha: "c2", time: "2026-10-15T10:00:04Z", message: "commit: Messreihe" },
    { sha: "c3", time: "2026-10-15T10:00:04Z", message: "commit: Regen" },
    wind,
  ];

  it("starts with the first entry, which still has to be selected", () => {
    expect(resolveSelection(older, null)).toEqual({ index: 0, found: false });
  });

  it("follows the selected entry when a new one arrives on top", () => {
    const selection = { key: entryKey(wind), index: 3 };
    const newer = [{ sha: "n1", time: "2026-10-15T10:01:00Z", message: "commit: neu" }, ...older];
    expect(resolveSelection(newer, selection)).toEqual({ index: 4, found: true });
  });

  it("falls back to the nearest position when the entry is gone", () => {
    expect(resolveSelection(older.slice(0, 2), { key: entryKey(wind), index: 3 })).toEqual({ index: 1, found: false });
  });

  it("picks the nearest of identical entries", () => {
    const twice = [wind, older[0]!, wind];
    expect(resolveSelection(twice, { key: entryKey(wind), index: 2 })).toEqual({ index: 2, found: true });
  });
});
