import { describe, expect, it } from "vitest";
import type { GraphRow, RepoViewState } from "../../core";
import { t } from "../../i18n";
import {
  QUIET_WIP,
  STASH_REF,
  childIndex,
  filterText,
  flatten,
  graphKey,
  moveTarget,
  parentIndex,
  rangeShas,
  type GraphKeyInput,
} from "./model";

const row = (kind: GraphRow["kind"], sha: string | null, parents: string[] = [], extra: Partial<GraphRow> = {}): GraphRow => ({
  ...QUIET_WIP,
  id: sha ?? "wip",
  kind,
  sha,
  parents,
  ...extra,
});

// wip, c1 (merge of c2 + s1-side c4), stash, c2, c3 (child of c2 via second parent), c4
const WIP = row("wip", null, [], { wipCount: 2 });
const C1 = row("merge", "c1", ["c2", "c4"]);
const STASH = row("stash", "s0", ["c2"], { stashIndex: 0 });
const C2 = row("commit", "c2", ["c3"]);
const C3 = row("commit", "c3", ["c4"]);
const C4 = row("commit", "c4", []);

describe("the flat row list", () => {
  it("keeps the local changes row first, drops duplicates and counts commits without stashes", () => {
    const flat = flatten([
      { rows: [C1, STASH, C2], nextCursor: "x", maxLane: 2 },
      { rows: [WIP, C2, C3], nextCursor: null, maxLane: 5 },
    ]);
    expect(flat.rows.map((r) => r.id)).toEqual(["wip", "c1", "s0", "c2", "c3"]);
    expect(flat.rows[0]).toBe(WIP);
    expect(flat.hasWip).toBe(true);
    expect(flat.maxLane).toBe(5);
    expect(flat.commitCount).toBe(3);
    expect(flat.indexByKey.get("c3")).toBe(4);
    expect(flat.indexByKey.get("stash:0")).toBe(2);
  });

  it("without pages there is only the quiet local changes row", () => {
    const flat = flatten(undefined);
    expect(flat.rows).toEqual([QUIET_WIP]);
    expect(flat.hasWip).toBe(false);
  });
});

describe("graph selection", () => {
  const rows = [WIP, C1, STASH, C2, C3, C4];
  const flat = flatten([{ rows, nextCursor: null, maxLane: 1 }]);

  it("a range holds only commits, in either direction", () => {
    expect(rangeShas(rows, 0, 3)).toEqual(["c1", "c2"]);
    expect(rangeShas(rows, 4, 1)).toEqual(["c3", "c2", "c1"]);
    expect(rangeShas(rows, 2, 2)).toEqual([]);
  });

  it("a move is clamped; extending skips stashes and the local changes", () => {
    expect(moveTarget(rows, 1, -5, false)).toBe(0);
    expect(moveTarget(rows, 1, 99, false)).toBe(5);
    expect(moveTarget(rows, 1, 2, true), "down over the stash").toBe(3);
    expect(moveTarget(rows, 3, 2, true), "up over the stash").toBe(1);
    expect(moveTarget(rows, 1, 0, true), "nothing above but the local changes").toBeNull();
  });

  it("H goes to the first parent, L to the nearest child (a first-parent child first)", () => {
    expect(parentIndex(flat.rows, flat.indexByKey, 1)).toBe(3);
    expect(parentIndex(flat.rows, flat.indexByKey, 5), "a root").toBe(-1);
    expect(parentIndex(flat.rows, flat.indexByKey, 2), "a stash is no commit").toBe(-1);
    expect(childIndex(flat.rows, 3)).toBe(1);
    // c4: c1 has it as second parent (nearer would win only as fallback), c3 as first parent.
    expect(childIndex(flat.rows, 5)).toBe(4);
    expect(childIndex(flat.rows, 1)).toBe(-1);
  });
});

describe("graph keys", () => {
  const key = (k: string, mods: Partial<GraphKeyInput> = {}): GraphKeyInput => ({
    key: k,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it("moves with arrows, J/K, Home/End and pages (Shift still moves)", () => {
    expect(graphKey(key("ArrowDown"), 4, 10, 50)).toEqual({ kind: "move", to: 5 });
    expect(graphKey(key("K", { shiftKey: true }), 4, 10, 50)).toEqual({ kind: "move", to: 3 });
    expect(graphKey(key("Home", { ctrlKey: true }), 4, 10, 50)).toEqual({ kind: "move", to: 0 });
    expect(graphKey(key("End"), 4, 10, 50)).toEqual({ kind: "move", to: 49 });
    expect(graphKey(key("PageDown"), 4, 10, 50)).toEqual({ kind: "move", to: 14 });
    expect(graphKey(key("PageUp"), 4, 10, 50)).toEqual({ kind: "move", to: -6 });
    expect(graphKey(key("Home", { altKey: true }), 4, 10, 50)).toBeNull();
    expect(graphKey(key("ArrowDown", { ctrlKey: true }), 4, 10, 50)).toBeNull();
  });

  it("maps the single keys only without modifiers", () => {
    expect(graphKey(key("h"), 0, 1, 2)).toEqual({ kind: "parent" });
    expect(graphKey(key("L"), 0, 1, 2)).toEqual({ kind: "child" });
    expect(graphKey(key("b"), 0, 1, 2)).toEqual({ kind: "highlight" });
    expect(graphKey(key("Escape"), 0, 1, 2)).toEqual({ kind: "escape" });
    expect(graphKey(key("Enter"), 0, 1, 2)).toEqual({ kind: "details" });
    expect(graphKey(key("ArrowLeft"), 0, 1, 2)).toEqual({ kind: "collapse", collapse: true });
    expect(graphKey(key("ArrowRight"), 0, 1, 2)).toEqual({ kind: "collapse", collapse: false });
    expect(graphKey(key("h", { shiftKey: true }), 0, 1, 2)).toBeNull();
    expect(graphKey(key("Enter", { metaKey: true }), 0, 1, 2)).toBeNull();
  });

  it("opens the menu with the menu key or Shift+F10", () => {
    expect(graphKey(key("ContextMenu", { ctrlKey: true }), 0, 1, 2)).toEqual({ kind: "menu" });
    expect(graphKey(key("F10", { shiftKey: true }), 0, 1, 2)).toEqual({ kind: "menu" });
    expect(graphKey(key("F10"), 0, 1, 2)).toBeNull();
  });
});

describe("the filter bar text", () => {
  const view = (patch: Partial<RepoViewState>) => ({ hiddenRefs: [], soloRefs: [], ...patch }) as RepoViewState;

  it("names one solo or hidden ref, counts several", () => {
    expect(filterText(view({ soloRefs: ["refs/heads/main"] }), null)).toBe(t("commitGraph.filter.soloOne", { name: "main" }));
    expect(filterText(view({ soloRefs: ["a", "b"] }), null)).toBe(t("commitGraph.filter.soloMany", { count: 2 }));
    expect(filterText(view({ hiddenRefs: [STASH_REF] }), null)).toBe(t("commitGraph.filter.hiddenOne", { name: t("ui.stashes") }));
    expect(filterText(view({ hiddenRefs: ["a", "b", "c"] }), null)).toBe(t("commitGraph.filter.hiddenMany", { count: 3 }));
  });
});
