import { describe, expect, it } from "vitest";
import type { CommitSummary, FileHistoryEntry } from "../../core";
import { formerName, historyKey, olderNamesOf, versionOf } from "./model";

const entry = (sha: string, path: string, status: FileHistoryEntry["status"], oldPath: string | null = null): FileHistoryEntry => ({
  commit: { sha, parents: [`${sha}^`] } as CommitSummary,
  path,
  oldPath,
  status,
  added: 1,
  removed: 0,
});

describe("file history rows", () => {
  it("a deleting commit means the version before it", () => {
    expect(versionOf(entry("c3", "a.ts", "deleted"))).toEqual({ sha: "c3^", path: "a.ts", beforeDelete: true });
    expect(versionOf(entry("c2", "a.ts", "modified"))).toEqual({ sha: "c2", path: "a.ts", beforeDelete: false });
  });

  it("mentions the former name at the rename and before it", () => {
    expect(formerName(entry("c2", "neu.ts", "renamed", "alt.ts"), "neu.ts")).toEqual({ kind: "renamed", path: "alt.ts" });
    expect(formerName(entry("c1", "alt.ts", "modified"), "neu.ts")).toEqual({ kind: "then", path: "alt.ts" });
    expect(formerName(entry("c3", "neu.ts", "modified"), "neu.ts")).toBeNull();
  });

  it("lists every former name once", () => {
    const list = [
      entry("c3", "neu.ts", "modified"),
      entry("c2", "mitte.ts", "renamed"),
      entry("c1", "alt.ts", "added"),
      entry("c0", "alt.ts", "added"),
    ];
    expect(olderNamesOf(list, "neu.ts")).toEqual(["mitte.ts", "alt.ts"]);
  });
});

describe("file history keys", () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
    key: k,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it("moves within the list, clamped", () => {
    expect(historyKey(key("ArrowDown"), 3, 5, 10)).toEqual({ kind: "select", index: 4 });
    expect(historyKey(key("ArrowUp"), 0, 5, 10)).toEqual({ kind: "select", index: 0 });
    expect(historyKey(key("PageDown"), 8, 5, 10)).toEqual({ kind: "select", index: 9 });
    expect(historyKey(key("PageUp"), 3, 5, 10)).toEqual({ kind: "select", index: 0 });
    expect(historyKey(key("End"), 3, 5, 10)).toEqual({ kind: "select", index: 9 });
    expect(historyKey(key("Home", { ctrlKey: true }), 3, 5, 10)).toBeNull();
  });

  it("opens, blames, reveals and opens the menu", () => {
    expect(historyKey(key("Enter"), 0, 1, 2)).toEqual({ kind: "open" });
    expect(historyKey(key("B"), 0, 1, 2)).toEqual({ kind: "blame" });
    expect(historyKey(key("g"), 0, 1, 2)).toEqual({ kind: "reveal" });
    expect(historyKey(key("b", { shiftKey: true }), 0, 1, 2)).toBeNull();
    expect(historyKey(key("F10", { shiftKey: true }), 0, 1, 2)).toEqual({ kind: "menu" });
    expect(historyKey(key("x"), 0, 1, 2)).toBeNull();
  });
});
