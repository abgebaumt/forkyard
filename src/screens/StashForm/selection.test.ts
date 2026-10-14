import { describe, expect, it } from "vitest";
import type { PatchSelection, Status } from "../../core";
import { addToPending, currentPending, pendingCounts, toStashSelection } from "./selection";

const sel = (path: string, token = "t"): PatchSelection => ({ path, hunks: [{ index: 0, lines: [1] }], expect: token });
const statusAt = (sha: string) => ({ head: { kind: "branch", branch: "main", sha } }) as unknown as Status;

describe("pending partial stash", () => {
  it("collects files per area and replaces a file that is selected again", () => {
    let pending = addToPending(null, "h1", { area: "unstaged", selection: sel("a.txt"), lines: 2 });
    pending = addToPending(pending, "h1", { area: "staged", selection: sel("a.txt"), lines: 1 });
    pending = addToPending(pending, "h1", { area: "unstaged", selection: sel("b.txt"), lines: 3 });
    pending = addToPending(pending, "h1", { area: "unstaged", selection: sel("a.txt", "neu"), lines: 4 });
    expect(pendingCounts(pending)).toEqual({ files: 2, lines: 8 });
    expect(toStashSelection(pending)).toEqual({ expectHead: "h1", staged: [sel("a.txt")], unstaged: [sel("b.txt"), sel("a.txt", "neu")] });
  });

  it("starts over on another HEAD and is ignored once HEAD has moved", () => {
    const old = addToPending(null, "h1", { area: "unstaged", selection: sel("a.txt"), lines: 2 });
    const fresh = addToPending(old, "h2", { area: "unstaged", selection: sel("b.txt"), lines: 1 });
    expect(fresh.entries.map((entry) => entry.selection.path)).toEqual(["b.txt"]);
    expect(currentPending(old, statusAt("h1"))).toBe(old);
    expect(currentPending(old, statusAt("h2"))).toBeNull();
    expect(currentPending(null, statusAt("h1"))).toBeNull();
    expect(currentPending(old, undefined)).toBeNull();
  });
});
