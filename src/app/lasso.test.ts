import { describe, expect, it } from "vitest";
import { dropStale, keysFor, lassoCounts, lassoSelections, setLassoFile, type LassoFile } from "./lasso";

const file = (path: string, keys: string[], token = "t1"): LassoFile => ({
  token,
  keys,
  lines: keys.length,
  selection: { path, expect: token, hunks: [{ index: 0, lines: keys.map((k) => Number(k.split(":")[1])) }] },
});

describe("lasso", () => {
  it("adds, replaces and removes a file", () => {
    let lasso = setLassoFile({}, "session.ts", file("session.ts", ["0:1", "0:2"]));
    lasso = setLassoFile(lasso, "session.ts", file("session.ts", ["0:3"]));
    expect(lasso["session.ts"]?.keys).toEqual(["0:3"]);
    expect(setLassoFile(lasso, "session.ts", file("session.ts", []))).toEqual({});
    expect(setLassoFile(lasso, "session.ts", null)).toEqual({});
  });
  it("counts lines and files", () => {
    const lasso = { "a.ts": file("a.ts", ["0:1", "0:2"]), "b ä.ts": file("b ä.ts", ["1:4"]) };
    expect(lassoCounts(lasso)).toEqual({ files: 2, lines: 3 });
    expect(lassoSelections(lasso).map((s) => s.path)).toEqual(["a.ts", "b ä.ts"]);
  });
  it("keeps keys only for the same token", () => {
    const lasso = { "a.ts": file("a.ts", ["0:1"]) };
    expect([...keysFor(lasso, "a.ts", "t1")]).toEqual(["0:1"]);
    expect(keysFor(lasso, "a.ts", "t2").size).toBe(0);
  });
  it("drops files whose token changed or that left the unstaged list", () => {
    const lasso = { "session.ts": file("session.ts", ["0:1"]), "b.ts": file("b.ts", ["0:1"]), "c.ts": file("c.ts", ["0:1"]) };
    const result = dropStale(lasso, { "session.ts": "t2", "b.ts": "t1", "c.ts": null });
    expect(result.dropped).toEqual(["c.ts", "session.ts"]);
    expect(Object.keys(result.lasso)).toEqual(["b.ts"]);
  });
});
