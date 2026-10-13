import { describe, expect, it } from "vitest";
import { analyzeSelection, orderNewestFirst, type CommitBrief } from "./logic";

/**
 * History used by the tests (newest at the top):
 *
 *   f  merge of s2 into the main line (parents: e, s2)
 *   e        s2
 *   d        s1
 *   c ───────┘
 *   b
 *   a  root
 */
const history: Record<string, string[]> = {
  f: ["e", "s2"],
  e: ["d"],
  s2: ["s1"],
  d: ["c"],
  s1: ["c"],
  c: ["b"],
  b: ["a"],
  a: [],
};
const graphOrder = ["f", "e", "s2", "d", "s1", "c", "b", "a"];

function briefs(shas: string[], withOrder = true): Map<string, CommitBrief> {
  return new Map(
    shas.map((sha) => [
      sha,
      {
        sha,
        parents: history[sha] ?? [],
        summary: `Commit ${sha}`,
        authorName: "Test",
        authorEmail: "test@example.com",
        authoredAt: new Date(Date.UTC(2026, 0, 20 - graphOrder.indexOf(sha))).toISOString(),
        order: withOrder ? graphOrder.indexOf(sha) : null,
      },
    ]),
  );
}

describe("analyzeSelection", () => {
  it("detects a contiguous sequence regardless of the selection order", () => {
    const shas = ["d", "e", "c"];
    expect(analyzeSelection(shas, briefs(shas))).toEqual({ kind: "chain", chain: ["e", "d", "c"], newest: "e", oldest: "c", base: "b" });
  });

  it("reports a gap when a commit in between is missing", () => {
    const shas = ["e", "c", "b"];
    expect(analyzeSelection(shas, briefs(shas))).toEqual({ kind: "gap", ordered: ["e", "c", "b"] });
  });

  it("reports a gap for commits from two branches", () => {
    const shas = ["d", "s1", "c"];
    expect(analyzeSelection(shas, briefs(shas)).kind).toBe("gap");
  });

  it("follows the first parent for a merge", () => {
    const main = ["f", "e", "d"];
    expect(analyzeSelection(main, briefs(main))).toEqual({ kind: "chain", chain: ["f", "e", "d"], newest: "f", oldest: "d", base: "c" });
    // A merge commit plus side branch is not a sequence: the comparison would run against the first parent.
    const side = ["f", "s2", "s1"];
    expect(analyzeSelection(side, briefs(side)).kind).toBe("gap");
    // The side branch on its own is one.
    const sideOnly = ["s2", "s1"];
    expect(analyzeSelection(sideOnly, briefs(sideOnly))).toEqual({ kind: "chain", chain: ["s2", "s1"], newest: "s2", oldest: "s1", base: "c" });
  });

  it("distinguishes the sequence up to the root commit: there is no revision before it", () => {
    const shas = ["a", "b", "c"];
    expect(analyzeSelection(shas, briefs(shas))).toEqual({ kind: "root", chain: ["c", "b", "a"], newest: "c", oldest: "a" });
  });
});

describe("orderNewestFirst", () => {
  it("uses the order in the graph", () => {
    expect(orderNewestFirst(["a", "f", "c"], briefs(["a", "f", "c"]))).toEqual(["f", "c", "a"]);
  });

  it("falls back to the date without a graph position", () => {
    expect(orderNewestFirst(["a", "f", "c"], briefs(["a", "f", "c"], false))).toEqual(["f", "c", "a"]);
  });

  it("keeps the selection order without any information", () => {
    expect(orderNewestFirst(["x", "y"], new Map())).toEqual(["x", "y"]);
  });
});
