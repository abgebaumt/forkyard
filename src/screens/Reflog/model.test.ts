import { describe, expect, it } from "vitest";
import type { RefsSnapshot } from "../../core";
import { actionLabel, HEAD_VALUE, refFromValue, refOptions, refValue } from "./model";

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
