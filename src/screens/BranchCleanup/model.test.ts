import { describe, expect, it } from "vitest";
import type { BranchCleanupCandidate } from "../../core";
import { groupCandidates, initialSelection, lostCommits, remoteNames, remoteTargets, selectionCount, toggleSelection } from "./model";

const candidate = (partial: Partial<BranchCleanupCandidate> & Pick<BranchCleanupCandidate, "name" | "class">): BranchCleanupCandidate => ({
  sha: "a".repeat(40),
  reasons: [],
  committedAt: "2026-01-01T00:00:00Z",
  upstreamRemote: null,
  upstreamBranch: null,
  upstreamSha: null,
  ...partial,
});

const list: BranchCleanupCandidate[] = [
  candidate({
    name: "fertig",
    class: "safe",
    reasons: [{ kind: "merged" }],
    upstreamRemote: "origin",
    upstreamBranch: "fertig",
    upstreamSha: "c".repeat(40),
  }),
  candidate({ name: "alt", class: "review", reasons: [{ kind: "stale" }, { kind: "unmerged", count: 1 }] }),
  candidate({
    name: "release/2026.1",
    class: "blocked",
    reasons: [{ kind: "protected" }],
    upstreamRemote: "upstream",
    upstreamBranch: "release/2026.1",
    upstreamSha: "d".repeat(40),
  }),
  candidate({
    name: "feature/thema-20",
    class: "safe",
    reasons: [
      { kind: "prMerged", number: 20 },
      { kind: "unmerged", count: 2 },
    ],
  }),
  candidate({ name: "verwaist", class: "review", reasons: [{ kind: "upstreamGone" }, { kind: "unpushed", count: 3 }] }),
];
const byName = (name: string) => list.find((entry) => entry.name === name)!;

describe("branch cleanup model", () => {
  it("groups by class in the order safe, review, blocked and filters by name", () => {
    expect(groupCandidates(list, "").map((group) => [group.class, group.rows.map((row) => row.name)])).toEqual([
      ["safe", ["fertig", "feature/thema-20"]],
      ["review", ["alt", "verwaist"]],
      ["blocked", ["release/2026.1"]],
    ]);
    expect(groupCandidates(list, "THEMA").map((group) => group.class)).toEqual(["safe"]);
    expect(groupCandidates(list, "gibt es nicht")).toEqual([]);
  });

  it("preselects safe branches only and never selects blocked ones", () => {
    const selection = initialSelection(list);
    expect([...selection].sort()).toEqual(["feature/thema-20", "fertig"]);
    expect(toggleSelection(selection, byName("release/2026.1"))).toEqual(selection);
    expect(selectionCount(list, toggleSelection(selection, byName("alt")))).toEqual({ selected: 3, total: 4 });
    expect(toggleSelection(selection, byName("fertig")).has("fertig")).toBe(false);
    expect(selection.has("fertig")).toBe(true);
  });

  it("names the commits that get lost for review branches with unmerged commits", () => {
    expect(lostCommits(byName("alt"))).toBe(1);
    expect(lostCommits(byName("feature/thema-20"))).toBeNull(); // safe: its PR is merged
    expect(lostCommits(byName("verwaist"))).toBeNull();
  });

  it("offers the remote only for selected branches with an existing upstream", () => {
    expect(remoteTargets(list, new Set(["fertig", "alt"]))).toEqual([
      { remote: "origin", branch: "fertig", expected: "c".repeat(40), label: "origin/fertig" },
    ]);
    expect(remoteNames(list)).toEqual(["origin", "upstream"]);
  });
});
