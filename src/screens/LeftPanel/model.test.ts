import { describe, expect, it } from "vitest";
import type { Ref, RefsSnapshot, Remote, Stash } from "../../core";
import { buildTrees, countLeaves, filterTree, findNode, flatten, highlightRanges, toggleNames, triState, typeaheadMatch } from "./model";

const ref = (name: string, kind: Ref["kind"], remote: string | null = null): Ref => ({
  name,
  fullName: kind === "local" ? `refs/heads/${name}` : kind === "remote" ? `refs/remotes/${name}` : `refs/tags/${name}`,
  kind,
  sha: "a".repeat(40),
  isHead: false,
  upstream: null,
  upstreamGone: false,
  pushesToUpstream: false,
  unpublished: null,
  ahead: 0,
  behind: 0,
  remote,
  annotation: null,
  isAnnotated: false,
  worktreePath: null,
});
const remote = (name: string): Remote => ({ name, fetchUrl: `https://example.test/${name}.git`, pushUrl: null, host: "other" });
const stash = (index: number, message: string, branch: string | null = null): Stash => ({
  index,
  sha: `s${index}`,
  message,
  branch,
  baseSha: "b",
  createdAt: "2026-01-01T00:00:00Z",
  fileCount: 1,
});

const REFS: RefsSnapshot = {
  head: { kind: "branch", branch: "main", sha: "a".repeat(40) },
  locals: [ref("main", "local"), ref("feature/karte", "local"), ref("feature/b10", "local"), ref("feature/b9", "local")],
  remotes: [ref("origin/main", "remote", "origin"), ref("origin/feature/karte", "remote", "origin")],
  tags: [ref("v1.0", "tag")],
};

describe("left panel trees", () => {
  const trees = buildTrees(REFS, [remote("origin"), remote("leer")], [stash(0, "WIP an der Karte", "feature/karte")]);

  it("puts folders first and sorts names numerically", () => {
    expect(trees.local.map((node) => node.label)).toEqual(["feature", "main"]);
    expect(trees.local[0]!.children.map((node) => node.label)).toEqual(["b9", "b10", "karte"]);
    expect(trees.local[0]!.refNames).toHaveLength(3);
  });

  it("groups remote branches under their remote, also an empty remote", () => {
    expect(trees.remote.map((node) => node.id)).toEqual(["remote:leer", "remote:origin"]);
    const origin = trees.remote[1]!;
    expect(origin.remote?.name).toBe("origin");
    expect(origin.children.map((node) => node.label)).toEqual(["feature", "main"]);
    const karte = findNode(trees.remote, (node) => node.ref?.name === "origin/feature/karte")!;
    expect(karte.label).toBe("karte");
    expect(karte.path.slice(karte.labelStart)).toBe("karte");
  });

  it("shows a detached or unborn HEAD on top; only the unborn branch counts", () => {
    const detached = buildTrees({ ...REFS, head: { kind: "detached", sha: "c" } }, [], []);
    expect(detached.local[0]!.id).toBe("head:detached");
    expect(countLeaves(detached.local)).toBe(4);
    const unborn = buildTrees({ head: { kind: "unborn", branch: "main" }, locals: [], remotes: [], tags: [] }, [], []);
    expect(unborn.local.map((node) => node.label)).toEqual(["main"]);
    expect(countLeaves(unborn.local)).toBe(1);
  });

  it("without refs it still lists the remotes; stashes are named by message or position", () => {
    const empty = buildTrees(undefined, [remote("origin")], [stash(1, "")]);
    expect(empty.remote.map((node) => node.id)).toEqual(["remote:origin"]);
    expect(empty.stashes[0]!.label).toBe("stash@{1}");
    expect(countLeaves(trees.stashes)).toBe(1);
  });

  it("filters by the full name and by a stash's branch, keeping parents of matches", () => {
    const local = filterTree(trees.local, " KAR ");
    expect(local.map((node) => node.label)).toEqual(["feature"]);
    expect(local[0]!.children.map((node) => node.label)).toEqual(["karte"]);
    expect(
      filterTree(trees.remote, "leer").map((node) => node.id),
      "an empty remote by its name",
    ).toEqual(["remote:leer"]);
    expect(filterTree(trees.stashes, "feature/karte")).toHaveLength(1);
    expect(filterTree(trees.local, "")).toBe(trees.local);
  });

  it("marks the matching part of the label only", () => {
    const karte = findNode(trees.local, (node) => node.label === "karte")!;
    expect(highlightRanges(karte, "e/ka")).toEqual([[0, 2]]);
    expect(highlightRanges(karte, "feature")).toEqual([]);
    expect(highlightRanges(karte, "  ")).toEqual([]);
  });

  it("flattens to visible rows with depth and position", () => {
    const rows = flatten(trees.local, new Set());
    expect(rows.map((row) => [row.node.label, row.depth, row.expanded])).toEqual([
      ["feature", 0, true],
      ["b9", 1, undefined],
      ["b10", 1, undefined],
      ["karte", 1, undefined],
      ["main", 0, undefined],
    ]);
    expect(rows[2]).toMatchObject({ parentId: trees.local[0]!.id, posInSet: 2, setSize: 3 });
    const closed = flatten(trees.local, new Set([trees.local[0]!.id]));
    expect(closed.map((row) => row.node.label)).toEqual(["feature", "main"]);
    expect(flatten(trees.local, new Set([trees.local[0]!.id]), true)).toHaveLength(5);
  });
});

describe("hide and solo toggles", () => {
  it("reads none, some or all", () => {
    expect(triState([], new Set(["a"]))).toBe("none");
    expect(triState(["a", "b"], new Set(["a"]))).toBe("some");
    expect(triState(["a", "b"], new Set(["a", "b"]))).toBe("all");
    expect(triState(["c"], new Set(["a"]))).toBe("none");
  });

  it("removes the names when all are in, otherwise adds the missing ones", () => {
    expect(toggleNames(["a", "b", "c"], ["a", "b"])).toEqual(["c"]);
    expect(toggleNames(["a"], ["a", "b"])).toEqual(["a", "b"]);
    expect(toggleNames(["a"], [])).toEqual(["a"]);
  });
});

describe("type-ahead in the tree", () => {
  const rows = flatten(buildTrees(REFS, [], []).local, new Set());
  const labels = rows.map((row) => row.node.label); // feature, b9, b10, karte, main
  const at = (label: string) => labels.indexOf(label);

  it("jumps to the next name starting with the text, wrapping around", () => {
    expect(typeaheadMatch(rows, at("feature"), "m")?.node.label).toBe("main");
    expect(typeaheadMatch(rows, at("main"), "f")?.node.label).toBe("feature");
    expect(typeaheadMatch(rows, at("main"), "x")).toBeUndefined();
  });

  it("a longer text may stay on the current row; one repeated letter cycles", () => {
    expect(typeaheadMatch(rows, at("b10"), "b1")?.node.label).toBe("b10");
    expect(typeaheadMatch(rows, at("b9"), "bb")?.node.label).toBe("b10");
    expect(typeaheadMatch(rows, at("b10"), "bbb")?.node.label).toBe("b9");
  });
});
