import { describe, expect, it } from "vitest";
import type { FileDiff } from "../core";
import {
  currentTokens,
  dropStale,
  guardQueries,
  keysFor,
  lassoCounts,
  lassoSelections,
  setLassoFile,
  useLassoStore,
  type LassoFile,
} from "./lasso";
import { useAppStore } from "./store";

const file = (path: string, keys: string[], token = "t1"): LassoFile => ({
  token,
  keys,
  lines: keys.length,
  forced: false,
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
  it("counts nothing as changed while our own write runs", () => {
    const text = (token: string) => ({ data: { kind: "text", token } as FileDiff, isFetching: false });
    const unstaged = new Set(["a.ts"]);
    expect(currentTokens(["a.ts", "b.ts"], unstaged, [text("t2"), text("t1")], true)).toEqual({});
    expect(currentTokens(["a.ts", "b.ts"], unstaged, [text("t2"), text("t1")], false)).toEqual({ "a.ts": "t2", "b.ts": null });
    expect(currentTokens(["a.ts"], unstaged, [{ ...text("t2"), isFetching: true }], false)).toEqual({});
  });
  it("compares a force-opened file against the forced diff", () => {
    const lasso = { "big.json": { ...file("big.json", ["0:1"]), forced: true }, "a.ts": file("a.ts", ["0:1"]) };
    const options = guardQueries("r1", lasso, ["a.ts", "big.json"]).map((query) => query.queryKey[5]);
    expect(options).toEqual([
      { force: false, ignoreWhitespace: false },
      { force: true, ignoreWhitespace: false },
    ]);
  });
  it("forgets a tab's lasso when the tab closes", () => {
    useAppStore.getState().setRightCollapsed("tab-9", false);
    useLassoStore.getState().setFile("tab-9", "a.ts", file("a.ts", ["0:1"]));
    expect(Object.keys(useLassoStore.getState().byTab["tab-9"] ?? {})).toEqual(["a.ts"]);
    useAppStore.getState().dropTabView("tab-9");
    expect(useLassoStore.getState().byTab).not.toHaveProperty("tab-9");
  });
});
