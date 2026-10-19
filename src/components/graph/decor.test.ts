import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphRow, RefLabelInfo, RefsSnapshot, Ref } from "../../core";
import { branchLabelOf, computeHighlight, computePinnedChain, decorateRow, EdgeHighlighter, laneMapsAt, mapLane, nearestBranch } from "./decor";
import { smartSelection } from "./smart";

const edge = (top: number | null, bottom: number | null, color = 0): GraphEdge => ({ top, bottom, color, dashed: false });
const label = (name: string, kind: RefLabelInfo["kind"] = "local", isHead = false): RefLabelInfo => ({
  kind,
  name,
  fullName: `${kind === "local" ? "refs/heads" : kind === "remote" ? "refs/remotes" : "refs/tags"}/${name}`,
  isHead,
});

function row(sha: string, lane: number, parents: string[], edges: GraphEdge[], refs: RefLabelInfo[] = []): GraphRow {
  return {
    id: sha,
    kind: parents.length > 1 ? "merge" : "commit",
    sha,
    lane,
    color: lane,
    edges,
    parents,
    summary: sha,
    authorName: "",
    authorEmail: "",
    authoredAt: null,
    refs,
    isHead: false,
    stashIndex: null,
    wipCount: null,
    collapsedCount: null,
    collapseTooLarge: false,
    sync: "none",
  };
}

/**
 * main:    m3 ── m2 (merge of f1) ── m1 ── m0
 * feature: f2 ── f1 ── m1          (f2 is only on feature)
 *
 * Rows from the top: f2, m3, m2, f1, m1, m0 – layout as in the core: first parent in the node's lane.
 */
const rows: GraphRow[] = [
  row("f2", 0, ["f1"], [edge(null, 0)], [label("feature")]),
  row("m3", 1, ["m2"], [edge(0, 0), edge(null, 1)], [label("main", "local", true)]),
  // m2 merges f1: the second line turns into the running lane 0 (where f2 → f1 is waiting).
  row("m2", 1, ["m1", "f1"], [edge(0, 0), edge(1, null), edge(null, 1), edge(null, 0)]),
  row("f1", 0, ["m1"], [edge(0, null), edge(1, 1), edge(null, 0)]),
  row("m1", 0, ["m0"], [edge(0, null), edge(1, null), edge(null, 0)]),
  row("m0", 0, [], [edge(0, null)]),
];
const index = new Map(rows.map((entry, at) => [entry.id, at]));

describe("computeHighlight", () => {
  it("takes the tip and all loaded ancestors", () => {
    const main = computeHighlight(rows, index, "m3", false)!;
    expect([...main.member]).toEqual([0, 1, 1, 1, 1, 1]);
    expect(main.count).toBe(5);
    expect(main.start).toBe(1);
    const feature = computeHighlight(rows, index, "f2", false)!;
    expect([...feature.member]).toEqual([1, 0, 0, 1, 1, 1]);
  });

  it("does not know a tip that is not loaded", () => {
    expect(computeHighlight(rows, index, "fehlt", false)).toBeNull();
  });

  it("counts the local changes row as part of the checked-out branch", () => {
    const wip: GraphRow = { ...row("wip", 0, [], [{ top: null, bottom: 0, color: 0, dashed: true }]), kind: "wip", sha: null };
    const withWip = [wip, row("a", 0, [], [edge(0, null)])];
    const at = new Map(withWip.map((entry, position) => [entry.id, position]));
    const result = computeHighlight(withWip, at, "a", true)!;
    expect([...result.member]).toEqual([1, 1]);
    expect(result.start).toBe(0);
    expect(result.count).toBe(1);
  });
});

describe("EdgeHighlighter", () => {
  it("highlights a shared lane only from the merge on", () => {
    const highlight = computeHighlight(rows, index, "m3", false)!;
    const flags = new EdgeHighlighter(rows, highlight, 1).range(0, 5).map((list) => (list ? [...list] : null));
    expect(flags[0]).toBeNull(); // above the tip
    expect(flags[1]).toEqual([0, 1]); // lane 0 only carries f2 → f1 here; m3 starts its line
    expect(flags[2]).toEqual([0, 1, 1, 1]); // at m2: both outgoing lines belong to main
    expect(flags[3]).toEqual([1, 1, 1]); // from here on lane 0 is highlighted (m2 → f1 runs in it)
    expect(flags[4]).toEqual([1, 1, 1]);
    expect(flags[5]).toEqual([1]);
  });

  it("returns the same for a section as for everything, also backwards", () => {
    const highlight = computeHighlight(rows, index, "m3", false)!;
    const all = new EdgeHighlighter(rows, highlight, 1).range(0, 5).map((list) => (list ? [...list] : null));
    const partial = new EdgeHighlighter(rows, highlight, 1);
    expect(partial.range(3, 5).map((list) => [...list!])).toEqual(all.slice(3));
    expect(partial.range(1, 2).map((list) => [...list!])).toEqual(all.slice(1, 3));
    expect(partial.range(4, 4).map((list) => [...list!])).toEqual(all.slice(4, 5));
  });

  it("stays correct over many rows and checkpoints", () => {
    // 1000 commits in lane 0, next to it a foreign line runs through in lane 1.
    const many: GraphRow[] = [row("x", 1, ["z"], [edge(null, 1)])];
    for (let at = 0; at < 1000; at++) many.push(row(`c${at}`, 0, at < 999 ? [`c${at + 1}`] : [], at === 0 ? [edge(1, 1), edge(null, 0)] : at < 999 ? [edge(0, null), edge(1, 1), edge(null, 0)] : [edge(0, null), edge(1, 1)]));
    const at = new Map(many.map((entry, position) => [entry.id, position]));
    const highlight = computeHighlight(many, at, "c0", false)!;
    expect(highlight.count).toBe(1000);
    const walker = new EdgeHighlighter(many, highlight, 1);
    expect([...walker.range(900, 900)[0]!]).toEqual([1, 0, 1]);
    expect([...walker.range(300, 300)[0]!]).toEqual([1, 0, 1]);
    expect([...walker.range(1000, 1000)[0]!]).toEqual([1, 0]);
  });
});

describe("Pinning", () => {
  it("reorders lanes so that the pinned ones come first and the rest keeps its order", () => {
    expect([0, 1, 2, 3, 4].map((lane) => mapLane(lane, [3]))).toEqual([1, 2, 3, 0, 4]);
    expect([0, 1, 2, 3].map((lane) => mapLane(lane, [0]))).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((lane) => mapLane(lane, [2, 0]))).toEqual([1, 2, 0, 3]);
    expect([0, 1, 2].map((lane) => mapLane(lane, []))).toEqual([0, 1, 2]);
  });

  it("follows the chain of first parents", () => {
    const chain = computePinnedChain(rows, index, "m3", false)!;
    expect([...chain.node]).toEqual([-1, 1, 1, -1, 0, 0]);
    // m3 and m2 in lane 1 (also through the row of f1), from m1 on in lane 0; after the last commit it ends.
    expect([...chain.below]).toEqual([-1, 1, 1, 1, 0, -1]);
  });

  it("puts the pinned branch's line in lane 0 without tearing lines apart", () => {
    const chain = computePinnedChain(rows, index, "m3", false)!;
    const painted = rows.map((entry, at) => decorateRow(entry, laneMapsAt([chain], at), false, null, false));
    // The nodes of main are leftmost.
    expect(painted.map((entry) => entry.lane)).toEqual([0, 0, 0, 1, 0, 0]);
    // At every row boundary the lanes match: what arrives at the bottom continues at the top of the next row.
    for (let at = 0; at + 1 < painted.length; at++) {
      const bottoms = painted[at]!.edges.map((item) => item.bottom).filter((lane) => lane !== null).sort();
      const tops = painted[at + 1]!.edges.map((item) => item.top).filter((lane) => lane !== null).sort();
      expect([...new Set(tops)], `Grenze unter Zeile ${at}`).toEqual([...new Set(bottoms)]);
    }
    // The first row (above the tip) stays as it is.
    expect(laneMapsAt([chain], 0)).toBeNull();
  });

  it("leaves everything unchanged if the line is already leftmost", () => {
    const chain = computePinnedChain(rows, index, "f2", false)!;
    expect(rows.map((_, at) => laneMapsAt([chain], at))).toEqual([null, null, null, null, null, null]);
  });
});

describe("Ghost label", () => {
  it("takes the row's branch label: checked out before local before remote, never a tag", () => {
    expect(branchLabelOf(row("a", 0, [], [], [label("v1", "tag"), label("origin/x", "remote"), label("x")]))?.name).toBe("x");
    expect(branchLabelOf(row("a", 0, [], [], [label("x"), label("y", "local", true)]))?.name).toBe("y");
    expect(branchLabelOf(row("a", 0, [], [], [label("v1", "tag")]))).toBeNull();
  });

  it("finds the nearest branch that contains a commit", () => {
    expect(nearestBranch(rows, 3)?.ref.name).toBe("feature"); // f1 is on feature's line (f2 above it, same lane)
    expect(nearestBranch(rows, 2)?.ref.name).toBe("main");
    // m0 and m1 are in lane 0; their line leads up via f1 to feature.
    expect(nearestBranch(rows, 5)?.ref.name).toBe("feature");
    expect(nearestBranch(rows, 0)).toBeNull(); // carries a label itself
    // The line ends without a label (merged branch without a name): the nearest branch that contains it via the merge.
    const merged = [
      row("t", 0, ["m"], [edge(null, 0)], [label("main")]),
      row("m", 0, ["a", "x"], [edge(0, null), edge(null, 0), edge(null, 1)]),
      row("x", 1, ["a"], [edge(0, 0), edge(1, null), edge(null, 1)]),
      row("a", 0, [], [edge(0, null), edge(1, null)]),
    ];
    expect(nearestBranch(merged, 2)).toEqual({ ref: label("main"), rowIndex: 0 });
    // A commit that no loaded branch contains
    const lonely = [row("t", 0, ["u"], [edge(null, 0)], [label("x")]), row("s", 1, [], [])];
    expect(nearestBranch(lonely, 1)).toBeNull();
  });
});

describe("smartSelection", () => {
  const ref = (name: string, kind: Ref["kind"], extra: Partial<Ref> = {}): Ref => ({
    name,
    fullName: `${kind === "local" ? "refs/heads" : "refs/remotes"}/${name}`,
    kind,
    sha: name,
    isHead: false,
    upstream: null,
    upstreamGone: false,
    pushesToUpstream: true,
    unpublished: null,
    ahead: 0,
    behind: 0,
    remote: kind === "remote" ? "origin" : null,
    annotation: null,
    isAnnotated: false,
    worktreePath: null,
    ...extra,
  });
  const snapshot = (head: string, locals: Ref[], remotes: Ref[]): RefsSnapshot => ({ head: { kind: "branch", branch: head, sha: head }, locals, remotes, tags: [] });

  it("takes the checked-out branch, its upstream and the main branch", () => {
    const refs = snapshot("feature/x", [ref("feature/x", "local", { isHead: true, upstream: "origin/feature/x" }), ref("main", "local"), ref("andere", "local")], [ref("origin/feature/x", "remote"), ref("origin/main", "remote")]);
    expect(smartSelection(refs, "main")?.refs).toEqual(["refs/heads/feature/x", "refs/remotes/origin/feature/x", "refs/heads/main"]);
  });

  it("has no target if the main branch itself is checked out", () => {
    const refs = snapshot("main", [ref("main", "local", { isHead: true, upstream: "origin/main" }), ref("feature", "local")], [ref("origin/main", "remote")]);
    const selection = smartSelection(refs, "main")!;
    expect(selection.refs).toEqual(["refs/heads/main", "refs/remotes/origin/main"]);
    expect(selection.target).toBeNull();
  });

  it("takes the remote branch as target if the main branch does not exist locally, and skips a vanished upstream", () => {
    const refs = snapshot("fix", [ref("fix", "local", { isHead: true, upstream: "origin/fix", upstreamGone: true })], [ref("origin/master", "remote")]);
    expect(smartSelection(refs, "main")?.refs).toEqual(["refs/heads/fix", "refs/remotes/origin/master"]);
  });

  it("returns nothing for a detached HEAD", () => {
    expect(smartSelection({ head: { kind: "detached", sha: "a" }, locals: [ref("main", "local")], remotes: [], tags: [] }, "main")).toBeNull();
    expect(smartSelection(undefined, "main")).toBeNull();
  });
});
