import { describe, expect, it } from "vitest";
import { ALL_COLLAPSED, isMergeCollapsed, nextCollapse, NONE_COLLAPSED } from "./collapse";

describe("nextCollapse", () => {
  it("adds and removes a single merge", () => {
    const one = nextCollapse(NONE_COLLAPSED, "m1", true, ["m1", "m2"]);
    expect(one).toEqual({ collapsedMerges: ["m1"], collapseAllMerges: false });
    expect(nextCollapse(one, "m2", true, [])).toEqual({ collapsedMerges: ["m1", "m2"], collapseAllMerges: false });
    expect(nextCollapse(one, "m1", false, [])).toEqual(NONE_COLLAPSED);
    expect(nextCollapse(one, "m1", true, [])).toEqual(one);
  });

  it("expanding one merge under “collapse all” keeps the other loaded merges collapsed", () => {
    expect(nextCollapse(ALL_COLLAPSED, "m2", false, ["m1", "m2", "m3"])).toEqual({ collapsedMerges: ["m1", "m3"], collapseAllMerges: false });
    expect(nextCollapse(ALL_COLLAPSED, "m2", true, ["m1"])).toBe(ALL_COLLAPSED);
  });
});

describe("isMergeCollapsed", () => {
  it("knows single merges and “collapse all”", () => {
    expect(isMergeCollapsed(undefined, "m1")).toBe(false);
    expect(isMergeCollapsed({ collapsedMerges: ["m1"], collapseAllMerges: false }, "m1")).toBe(true);
    expect(isMergeCollapsed({ collapsedMerges: ["m1"], collapseAllMerges: false }, "m2")).toBe(false);
    expect(isMergeCollapsed(ALL_COLLAPSED, "x")).toBe(true);
  });
});
