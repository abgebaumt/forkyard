import { describe, expect, it } from "vitest";
import type { ComposeUnit } from "../../core";
import {
  SKIP,
  addCommit,
  allSkipped,
  blockedReason,
  digitTarget,
  dropRow,
  fromGroups,
  keyAction,
  moveCommit,
  moveUnit,
  orderOf,
  planOf,
  progressOf,
  refreshed,
  rowsOf,
  sameArrangement,
  setMessage,
  stepUnit,
  unitDetail,
  type Arrangement,
} from "./model";

function unit(id: string, path: string, kind: ComposeUnit["kind"] = "hunk", hunkIndex: number | null = 0, header = ""): ComposeUnit {
  return { id, path, oldPath: kind === "renamed" ? "alt/name.txt" : null, kind, hunkIndex, header, added: 1, removed: 1, lines: [], linesCut: false };
}

// As the core lists them: by path, the hunks of one file in file order.
const UNITS: ComposeUnit[] = [
  unit("-führend #1.md#0@aa", "-führend #1.md", "hunk", 0, "@@ -1,5 +1,5 @@"),
  unit("src/a.ts#0@bb", "src/a.ts", "hunk", 0, "@@ -1,5 +1,6 @@ export function a() {"),
  unit("src/a.ts#1@bb", "src/a.ts", "hunk", 1, "@@ -40,6 +41,6 @@"),
  unit("zz/bild.png#file@cc", "zz/bild.png", "binary", null),
];
const [DASH, A0, A1, BILD] = UNITS.map((u) => u.id) as [string, string, string, string];
const order = orderOf(UNITS);
/** Placement and summaries without the generated keys. */
const shape = (a: Arrangement) => ({ skip: a.skip, commits: a.commits.map((c) => ({ title: c.title, units: c.units })) });
const proposed = () =>
  fromGroups(UNITS, [
    { title: "Parser vereinfachen", body: "", units: [A1, A0] },
    { title: "Bild ersetzen", body: "Neues Logo.", units: [BILD] },
  ]);

describe("Compose model", () => {
  it("starts with every unit in “Don't commit”, in the core's order", () => {
    expect(shape(allSkipped(UNITS))).toEqual({ skip: [DASH, A0, A1, BILD], commits: [] });
  });

  it("takes the provider's groups; unknown, doubled and unplaced units never end up in a commit", () => {
    const a = fromGroups(UNITS, [
      { title: "Eins", body: "", units: [A0, "erfunden#0@00", A0] },
      { title: "Leer", body: "", units: ["erfunden#1@00"] },
      { title: "Zwei", body: "", units: [A0, BILD] },
    ]);
    expect(shape(a)).toEqual({ skip: [DASH, A1], commits: [{ title: "Eins", units: [A0] }, { title: "Zwei", units: [BILD] }] });
    expect(shape(proposed()).commits[0]!.units, "inside a group the core's order counts").toEqual([A0, A1]);
  });

  it("draws “Don't commit” first, then the commits in the order they are created", () => {
    const rows = rowsOf(proposed());
    expect(rows.map((row) => (row.kind === "group" ? `group ${row.group}` : `${row.group}: ${row.unit}`))).toEqual([
      `group ${SKIP}`,
      `${SKIP}: ${DASH}`,
      "group 0",
      `0: ${A0}`,
      `0: ${A1}`,
      "group 1",
      `1: ${BILD}`,
    ]);
  });

  it("Alt+↑/↓ moves a unit into the previous or next group; after the last commit a new one begins", () => {
    let a = proposed();
    a = stepUnit(a, DASH, 1, order);
    expect(shape(a).commits[0]).toEqual({ title: "Parser vereinfachen", units: [DASH, A0, A1] });
    a = stepUnit(a, BILD, 1, order);
    expect(shape(a).commits).toEqual([
      { title: "Parser vereinfachen", units: [DASH, A0, A1] },
      { title: "Bild ersetzen", units: [] },
      { title: "", units: [BILD] },
    ]);
    a = stepUnit(a, A0, -1, order);
    expect(shape(a).skip).toEqual([A0]);
    expect(stepUnit(a, A0, -1, order), "nothing above “Don't commit”").toBe(a);
  });

  it("1–9 move into commit n, 0 into “Don't commit”; a number past the next free one does nothing", () => {
    const a = proposed();
    expect(digitTarget("1")).toBe(0);
    expect(digitTarget("9")).toBe(8);
    expect(digitTarget("0")).toBe(SKIP);
    expect(digitTarget("a")).toBeNull();
    expect(shape(moveUnit(a, A1, 1, order)).commits[1]!.units).toEqual([A1, BILD]);
    expect(shape(moveUnit(a, A1, SKIP, order)).skip).toEqual([DASH, A1]);
    expect(shape(moveUnit(a, DASH, 2, order)).commits[2]).toEqual({ title: "", units: [DASH] });
    expect(moveUnit(a, DASH, 4, order)).toBe(a);
    expect(moveUnit(a, A0, 0, order), "already there").toBe(a);
  });

  it("Mod+↑/↓ reorders commits and keeps their messages", () => {
    const a = moveCommit(proposed(), 1, -1);
    expect(shape(a).commits.map((c) => c.title)).toEqual(["Bild ersetzen", "Parser vereinfachen"]);
    expect(a.commits[0]!.body).toBe("Neues Logo.");
    expect(moveCommit(a, 0, -1)).toBe(a);
    expect(moveCommit(a, 1, 1)).toBe(a);
  });

  it("dragging drops a unit into the group above the insertion point; commit headers do not move", () => {
    const a = proposed();
    const rows = rowsOf(a);
    // 0 skip, 1 DASH, 2 group 0, 3 A0, 4 A1, 5 group 1, 6 BILD
    expect(shape(dropRow(a, rows, 1, 6, order)).commits[1]!.units).toEqual([DASH, BILD]);
    expect(shape(dropRow(a, rows, 6, 0, order)).skip).toEqual([DASH, BILD]);
    expect(dropRow(a, rows, 1, 2, order), "dropped right below itself").toBe(a);
    expect(dropRow(a, rows, 2, 6, order), "a commit header is not dragged").toBe(a);
  });

  it("the plan leaves out empty commits; a missing summary or an empty plan blocks", () => {
    let a = addCommit(proposed());
    expect(planOf(a)).toEqual([
      { title: "Parser vereinfachen", body: "", units: [A0, A1] },
      { title: "Bild ersetzen", body: "Neues Logo.", units: [BILD] },
    ]);
    expect(blockedReason(a)).toBeNull();
    a = setMessage(a, 1, "   ", "Neues Logo.");
    expect(blockedReason(a)).toEqual({ reason: "title", commit: 1 });
    expect(blockedReason(allSkipped(UNITS))).toEqual({ reason: "nothing" });
  });

  it("maps keys, with Mod = Ctrl on Windows/Linux and Cmd on macOS", () => {
    const key = (k: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(keyAction(key("ArrowDown", { altKey: true }), false)).toEqual({ kind: "step", delta: 1 });
    expect(keyAction(key("ArrowUp", { altKey: true }), true)).toEqual({ kind: "step", delta: -1 });
    expect(keyAction(key("ArrowUp", { ctrlKey: true }), false)).toEqual({ kind: "moveCommit", delta: -1 });
    expect(keyAction(key("ArrowDown", { metaKey: true }), true)).toEqual({ kind: "moveCommit", delta: 1 });
    expect(keyAction(key("ArrowUp", { ctrlKey: true }), true), "Ctrl on macOS is not Mod").toBeNull();
    expect(keyAction(key("3"), false)).toEqual({ kind: "to", group: 2 });
    expect(keyAction(key("0"), false)).toEqual({ kind: "to", group: SKIP });
    expect(keyAction(key("F2"), false)).toEqual({ kind: "edit" });
    expect(keyAction(key("Enter", { ctrlKey: true }), false)).toEqual({ kind: "apply" });
    expect(keyAction(key("ArrowDown"), false), "plain arrows belong to the list").toBeNull();
    expect(keyAction(key("1", { altKey: true }), false)).toBeNull();
    expect(keyAction(key("Enter"), false)).toBeNull();
  });

  it("reading again keeps placed units, puts new ones into “Don't commit” and drops vanished ones", () => {
    const fresh = [UNITS[0]!, UNITS[1]!, unit("neu.txt#file@dd", "neu.txt", "added", null), UNITS[3]!];
    expect(shape(refreshed(proposed(), fresh))).toEqual({
      skip: [DASH, "neu.txt#file@dd"],
      commits: [
        { title: "Parser vereinfachen", units: [A0] },
        { title: "Bild ersetzen", units: [BILD] },
      ],
    });
  });

  it("compares arrangements by placement and messages", () => {
    const a = proposed();
    expect(sameArrangement(a, { ...a })).toBe(true);
    expect(sameArrangement(a, setMessage(a, 0, "Anders", ""))).toBe(false);
    expect(sameArrangement(a, moveUnit(a, DASH, 0, order))).toBe(false);
  });

  it("reads the core's progress line and names units", () => {
    expect(progressOf("2/3")).toEqual({ current: 2, total: 3 });
    expect(progressOf("")).toBeNull();
    expect(progressOf(undefined)).toBeNull();
    expect(unitDetail(UNITS[1]!)).toBe("@@ -1,5 +1,6 @@");
    expect(unitDetail(UNITS[3]!)).toBe("Binary file");
    expect(unitDetail(unit("neu/name.txt#file@ee", "neu/name.txt", "renamed", null))).toBe("Renamed from alt/name.txt");
  });
});
