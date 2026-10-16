import { describe, expect, it } from "vitest";
import { lineCaps } from "./model";

const nothing = { select: false, primary: null, discard: false, patchActions: false };

describe("lineCaps (what the line grid offers per mode)", () => {
  it("the staging modes keep their actions", () => {
    expect(lineCaps("unstaged", true)).toEqual({ select: true, primary: "stage", discard: true, patchActions: true });
    expect(lineCaps("staged", true)).toEqual({ select: true, primary: "unstage", discard: false, patchActions: true });
  });

  it("pick mode selects lines but offers no staging (agent review)", () => {
    expect(lineCaps("pick", true)).toEqual({ select: true, primary: null, discard: false, patchActions: false });
  });

  it("without a token or in a read-only diff nothing is selectable", () => {
    expect(lineCaps("pick", false)).toEqual(nothing);
    expect(lineCaps("unstaged", false)).toEqual(nothing);
    expect(lineCaps("staged", false)).toEqual(nothing);
    expect(lineCaps("none", true)).toEqual(nothing);
  });
});
