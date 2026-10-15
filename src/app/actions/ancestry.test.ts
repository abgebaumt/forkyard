import { describe, expect, it } from "vitest";
import type { GraphRow } from "../../core";
import { commitsBetween, type GraphIndex } from "./ancestry";

const row = (sha: string, parents: string[]): GraphRow => ({ id: sha, kind: "commit", sha, parents, summary: sha }) as unknown as GraphRow;

function indexOf(rows: GraphRow[], complete = true): GraphIndex {
  const index: GraphIndex = { rows: new Map(), order: new Map(), complete };
  rows.forEach((entry, position) => {
    index.rows.set(entry.sha!, entry);
    index.order.set(entry.sha!, position);
  });
  return index;
}

// main: c1 -> c2 -> c3, then `git commit --amend` -> c3a. The old c3 is only in the reflog.
const amended = indexOf([row("c3a", ["c2"]), row("c2", ["c1"]), row("c1", [])]);

describe("commitsBetween", () => {
  it("lists the commits of tip that base does not reach", () => {
    expect(commitsBetween(amended, "c1", "c3a")?.rows.map((entry) => entry.sha)).toEqual(["c3a", "c2"]);
  });

  it("does not claim the whole history for a base outside the loaded graph", () => {
    // c3 is not a graph row: without its parents nothing is known about what it reaches.
    expect(commitsBetween(amended, "c3", "c3a")).toBeNull();
  });

  it("uses the parents of commits outside the graph when they are given", () => {
    const outside = new Map([["c3", ["c2"]]]);
    expect(commitsBetween(amended, "c3", "c3a", outside)?.rows.map((entry) => entry.sha)).toEqual(["c3a"]);
  });

  it("stays unknown when the commits outside the graph do not lead back into it", () => {
    const outside = new Map([["c3", ["c-unknown"]]]);
    expect(commitsBetween(amended, "c3", "c3a", outside)).toBeNull();
  });
});
