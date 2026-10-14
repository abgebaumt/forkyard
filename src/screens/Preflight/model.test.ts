import { describe, expect, it } from "vitest";
import { conflictFiles, needsDialog } from "./model";

describe("preflight before merge, rebase, cherry-pick and revert", () => {
  it("asks only when conflicts are expected or branches can move along", () => {
    expect(needsDialog({ preview: { status: "clean" }, dependents: [] })).toBe(false);
    expect(needsDialog({ preview: null, dependents: [] })).toBe(false);
    expect(needsDialog({ preview: { status: "unknown", reason: "zu viele" }, dependents: [] })).toBe(false);
    expect(needsDialog({ preview: { status: "conflicts", files: ["a.txt"], atCommit: null }, dependents: [] })).toBe(true);
    expect(needsDialog({ preview: { status: "clean" }, dependents: ["teil"] })).toBe(true);
  });

  it("lists the files with expected conflicts", () => {
    expect(conflictFiles({ status: "conflicts", files: ["a.txt", "b c.txt"], atCommit: "abc" })).toEqual(["a.txt", "b c.txt"]);
    expect(conflictFiles({ status: "clean" })).toEqual([]);
    expect(conflictFiles(null)).toEqual([]);
  });
});
