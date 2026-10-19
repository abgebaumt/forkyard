import { describe, expect, it } from "vitest";
import type { ComposeNote, ComposeUnit, DiffLine } from "../../core";
import {
  SKIP,
  blockedReason,
  brokenNeeds,
  commitProblems,
  displayOrder,
  emptySelection,
  extendSelection,
  firstProblem,
  fromProposal,
  keepOf,
  keyAction,
  matrixOf,
  mergeWithNext,
  moveCommit,
  moveUnits,
  nextUnsure,
  notesOf,
  orderOf,
  peekOf,
  planOf,
  progressOf,
  rangeSelection,
  refreshed,
  reproposed,
  selectOne,
  setTitle,
  splitPath,
  stepTarget,
  summaryOf,
  toggleSelection,
  unsureUnits,
  type Arrangement,
  type KeyInput,
} from "./model";

const line = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, oldNo: null, newNo: null, text, noNewline: false });

function unit(id: string, path: string, patch: Partial<ComposeUnit> = {}): ComposeUnit {
  return { id, path, oldPath: null, kind: "hunk", hunkIndex: 0, header: "", added: 1, removed: 0, lines: [], linesCut: false, requires: [], protected: null, ...patch };
}

// The prototype's working directory: a new MFA helper used by the staff table, a fix with its
// test, translations, a lock file, a changelog and a protected .env.local – in the core's order.
const MFA = "src/admin/accounts/mfa.ts#file@1";
const STAFF0 = "src/admin/accounts/StaffTable.tsx#0@2";
const STAFF1 = "src/admin/accounts/StaffTable.tsx#1@2";
const EXP = "src/portal/invite/expiry.ts#0@3";
const EXPTEST = "src/portal/invite/expiry.test.ts#0@4";
const DE0 = "src/i18n/de.json#0@5";
const DE1 = "src/i18n/de.json#1@5";
const CL = "CHANGELOG.md#0@6";
const ENV = ".env.local#file@7";
const UNITS: ComposeUnit[] = [
  unit(ENV, ".env.local", { kind: "added", hunkIndex: null, protected: "secret" }),
  unit(CL, "CHANGELOG.md", { added: 2 }),
  unit(MFA, "src/admin/accounts/mfa.ts", { kind: "added", hunkIndex: null, added: 24 }),
  unit(STAFF0, "src/admin/accounts/StaffTable.tsx", { added: 3, removed: 3 }),
  unit(STAFF1, "src/admin/accounts/StaffTable.tsx", { hunkIndex: 1, added: 6, removed: 1, requires: [MFA] }),
  unit(DE0, "src/i18n/de.json"),
  unit(DE1, "src/i18n/de.json", { hunkIndex: 1, removed: 1 }),
  unit(EXPTEST, "src/portal/invite/expiry.test.ts", { added: 12, requires: [EXP] }),
  unit(EXP, "src/portal/invite/expiry.ts", { added: 3, removed: 2 }),
];
const BY_ID = new Map(UNITS.map((u) => [u.id, u]));
const order = orderOf(UNITS);

const proposal = () =>
  fromProposal(UNITS, [
    { title: "feat(admin): Zwei-Faktor-Status", body: "", reason: "Neue Spalte samt Hilfsfunktion.", units: [STAFF1, MFA, DE0, CL, ENV] },
    { title: "fix(einladungen): Ablauf genau 7 × 24 h", body: "Mit Test.", reason: "Berechnung und Test.", units: [EXP, EXPTEST, DE1] },
    { title: "style(admin): Imports formatiert", body: "", reason: "", units: [STAFF0] },
  ]);
const shape = (a: Arrangement) => ({ skip: a.skip, commits: a.commits.map((c) => [c.title, ...c.units]) });

describe("Compose arrangement", () => {
  it("takes the provider's groups in the core's order; a protected unit always stays in “Don't commit”", () => {
    const a = proposal();
    expect(shape(a)).toEqual({
      skip: [ENV],
      commits: [
        ["feat(admin): Zwei-Faktor-Status", CL, MFA, STAFF1, DE0],
        ["fix(einladungen): Ablauf genau 7 × 24 h", DE1, EXPTEST, EXP],
        ["style(admin): Imports formatiert", STAFF0],
      ],
    });
    expect(a.commits[0]!.reason).toBe("Neue Spalte samt Hilfsfunktion.");
    expect(a.commits.map((c) => c.origin)).toEqual(["ai", "ai", "ai"]);
    expect(displayOrder(a), "commits first, “Don't commit” last – as drawn").toEqual([CL, MFA, STAFF1, DE0, DE1, EXPTEST, EXP, STAFF0, ENV]);
  });

  it("moves several units at once, drops commits that become empty and never moves a protected unit", () => {
    const a = proposal();
    const moved = moveUnits(a, [STAFF0, ENV, DE1], 0, order, BY_ID);
    expect(moved.moved).toEqual([STAFF0, DE1]);
    expect(shape(moved.arrangement)).toEqual({
      skip: [ENV],
      commits: [
        ["feat(admin): Zwei-Faktor-Status", CL, MFA, STAFF0, STAFF1, DE0, DE1],
        ["fix(einladungen): Ablauf genau 7 × 24 h", EXPTEST, EXP],
      ],
    });
    expect(moved.target, "commit 1").toBe(0);
    const locked = moveUnits(a, [ENV], 1, order, BY_ID);
    expect(locked.moved).toEqual([]);
    expect(locked.arrangement).toBe(a);
  });

  it("“new” makes a new commit at the end from the selection; skipping works the same", () => {
    const a = proposal();
    const fresh = moveUnits(a, [EXPTEST], "new", order, BY_ID);
    expect(fresh.target).toBe(3);
    expect(fresh.arrangement.commits[3]).toMatchObject({ title: "", origin: "user", units: [EXPTEST] });
    const skipped = moveUnits(a, [STAFF0], SKIP, order, BY_ID);
    expect(shape(skipped.arrangement).skip).toEqual([ENV, STAFF0]);
    expect(skipped.arrangement.commits).toHaveLength(2);
    expect(skipped.target).toBe(SKIP);
  });

  it("Alt+↑/↓ goes to the previous or next group, “Don't commit” after the last commit", () => {
    const a = proposal();
    expect(stepTarget(a, CL, -1)).toBeNull();
    expect(stepTarget(a, CL, 1)).toBe(1);
    expect(stepTarget(a, STAFF0, 1)).toBe(SKIP);
    expect(stepTarget(a, STAFF0, -1)).toBe(1);
    expect(stepTarget(a, ENV, 1)).toBeNull();
    expect(stepTarget(a, ENV, -1)).toBe(2);
  });

  it("reorders, merges and renames commits", () => {
    const a = proposal();
    expect(moveCommit(a, 0, -1)).toBe(a);
    expect(moveCommit(a, 2, -1).commits.map((c) => c.title)).toEqual(["feat(admin): Zwei-Faktor-Status", "style(admin): Imports formatiert", "fix(einladungen): Ablauf genau 7 × 24 h"]);
    const merged = mergeWithNext(a, 1, order);
    expect(shape(merged).commits).toEqual([
      ["feat(admin): Zwei-Faktor-Status", CL, MFA, STAFF1, DE0],
      ["fix(einladungen): Ablauf genau 7 × 24 h", STAFF0, DE1, EXPTEST, EXP],
    ]);
    expect(merged.commits[1]!.origin).toBe("merged");
    expect(mergeWithNext(a, 2, order)).toBe(a);
    expect(setTitle(a, 2, "style: Imports").commits[2]!.title).toBe("style: Imports");
  });

  it("reading again keeps known units where they are; new ones go to “Don't commit”", () => {
    const a = proposal();
    const NEW = "neu.txt#file@9";
    const next = refreshed(a, [...UNITS.filter((u) => u.id !== DE1), unit(NEW, "neu.txt", { kind: "added", hunkIndex: null })]);
    expect(shape(next)).toEqual({
      skip: [ENV, NEW],
      commits: [
        ["feat(admin): Zwei-Faktor-Status", CL, MFA, STAFF1, DE0],
        ["fix(einladungen): Ablauf genau 7 × 24 h", EXPTEST, EXP],
        ["style(admin): Imports formatiert", STAFF0],
      ],
    });
  });
});

describe("Compose review", () => {
  const notes = notesOf([
    { unit: STAFF0, reason: "Nur Formatierung.", unsure: true },
    { unit: CL, reason: "Erwähnt beide Änderungen.", unsure: false },
    { unit: DE1, reason: "Gehört wohl zum Fix.", unsure: true },
  ] satisfies ComposeNote[]);

  it("lists the unsure units in display order; confirmed and moved ones no longer count", () => {
    const a = proposal();
    expect(unsureUnits(a, notes, { pinned: new Set(), confirmed: new Set() })).toEqual([DE1, STAFF0]);
    expect(unsureUnits(a, notes, { pinned: new Set([STAFF0]), confirmed: new Set() })).toEqual([DE1]);
    expect(unsureUnits(a, notes, { pinned: new Set(), confirmed: new Set([DE1]) })).toEqual([STAFF0]);
  });

  it("U jumps to the next unsure unit after the cursor and wraps around", () => {
    const a = proposal();
    const review = { pinned: new Set<string>(), confirmed: new Set<string>() };
    expect(nextUnsure(a, notes, review, null)).toBe(DE1);
    expect(nextUnsure(a, notes, review, DE1)).toBe(STAFF0);
    expect(nextUnsure(a, notes, review, STAFF0)).toBe(DE1);
    expect(nextUnsure(a, notes, { pinned: new Set([DE1, STAFF0]), confirmed: new Set() }, CL)).toBeNull();
  });
});

describe("Compose dependencies", () => {
  it("a unit needing something from a later commit or from “Don't commit” is broken", () => {
    const a = proposal();
    expect(brokenNeeds(a, BY_ID, STAFF1), "mfa.ts is in the same commit").toEqual([]);
    expect(brokenNeeds(a, BY_ID, EXPTEST), "expiry.ts is in the same commit").toEqual([]);
    const late = moveUnits(a, [MFA], "new", order, BY_ID).arrangement;
    expect(brokenNeeds(late, BY_ID, STAFF1)).toEqual([{ need: MFA, group: 3 }]);
    const testFirst = moveUnits(a, [EXP], 2, order, BY_ID).arrangement;
    expect(commitProblems(testFirst, BY_ID, 1)).toEqual([{ unit: EXPTEST, need: EXP, group: 2 }]);
    const skipped = moveUnits(a, [MFA], SKIP, order, BY_ID).arrangement;
    expect(brokenNeeds(skipped, BY_ID, STAFF1)).toEqual([{ need: MFA, group: SKIP }]);
    expect(firstProblem(skipped, BY_ID)).toEqual({ commit: 0, unit: STAFF1, need: MFA, group: SKIP });
    expect(firstProblem(a, BY_ID)).toBeNull();
  });

  it("an earlier requirement is fine, and a unit in “Don't commit” needs nothing", () => {
    const a = proposal();
    const earlier = moveUnits(a, [STAFF1], 2, order, BY_ID).arrangement;
    expect(brokenNeeds(earlier, BY_ID, STAFF1)).toEqual([]);
    const both = moveUnits(a, [STAFF1, MFA], SKIP, order, BY_ID).arrangement;
    expect(brokenNeeds(both, BY_ID, STAFF1)).toEqual([]);
  });
});

describe("Compose selection", () => {
  const a = proposal();
  const ids = displayOrder(a);

  it("click selects one, Ctrl toggles, Shift selects the range from the anchor", () => {
    let s = selectOne(emptySelection, STAFF1);
    expect(s).toEqual({ cursor: STAFF1, ids: [STAFF1], anchor: STAFF1 });
    s = toggleSelection(s, EXP);
    expect(s.ids).toEqual([STAFF1, EXP]);
    s = toggleSelection(s, STAFF1);
    expect(s.ids).toEqual([EXP]);
    expect(toggleSelection(selectOne(emptySelection, CL), CL).ids, "the last one stays selected").toEqual([CL]);
    s = rangeSelection(selectOne(emptySelection, DE0), EXPTEST, ids);
    expect(s).toEqual({ cursor: EXPTEST, ids: [DE0, DE1, EXPTEST], anchor: DE0 });
    s = rangeSelection(s, MFA, ids);
    expect(s.ids, "upwards from the same anchor").toEqual([MFA, STAFF1, DE0]);
  });

  it("Shift+↑/↓ extends the selection by one", () => {
    let s = selectOne(emptySelection, DE1);
    s = extendSelection(s, 1, ids);
    s = extendSelection(s, 1, ids);
    expect(s).toEqual({ cursor: EXP, ids: [DE1, EXPTEST, EXP], anchor: DE1 });
    expect(extendSelection(selectOne(emptySelection, ENV), 1, ids).ids).toEqual([ENV]);
  });
});

describe("Compose views", () => {
  it("the file matrix counts the hunks per commit and marks split files", () => {
    const a = moveUnits(proposal(), [DE1], 0, order, BY_ID).arrangement;
    const rows = matrixOf(moveUnits(a, [DE1], 1, order, BY_ID).arrangement, UNITS);
    const staff = rows.find((row) => row.path === "src/admin/accounts/StaffTable.tsx")!;
    expect(staff.split).toBe(true);
    expect(staff.cells).toEqual([
      { group: 0, count: 1, first: STAFF1 },
      { group: 1, count: 0, first: null },
      { group: 2, count: 1, first: STAFF0 },
      { group: SKIP, count: 0, first: null },
    ]);
    const de = matrixOf(a, UNITS).find((row) => row.path === "src/i18n/de.json")!;
    expect(de.split, "both hunks in commit 1").toBe(false);
    expect(de.cells[0]).toEqual({ group: 0, count: 2, first: DE0 });
    expect(rows.map((row) => row.path), "files in the core's order").toEqual([".env.local", "CHANGELOG.md", "src/admin/accounts/mfa.ts", "src/admin/accounts/StaffTable.tsx", "src/i18n/de.json", "src/portal/invite/expiry.test.ts", "src/portal/invite/expiry.ts"]);
  });

  it("a row shows the first two changed lines and the path with its folder apart", () => {
    const u = unit("x#0@1", "src/x.ts", {
      lines: [line("context", "const a = 1;"), line("remove", "  return endOfDay(days);  "), line("add", ""), line("add", "  return new Date();"), line("add", "never shown")],
    });
    expect(peekOf(u)).toEqual([
      { kind: "remove", text: "return endOfDay(days);" },
      { kind: "add", text: "" },
    ]);
    expect(splitPath("src/admin/accounts/mfa.ts")).toEqual({ dir: "src/admin/accounts/", name: "mfa.ts" });
    expect(splitPath(".env.local")).toEqual({ dir: "", name: ".env.local" });
  });

  it("the summary counts commits, units, what stays and what is missing", () => {
    const a = proposal();
    expect(summaryOf(a)).toEqual({ commits: 3, units: 8, skipped: 1, untitled: 0 });
    const fresh = moveUnits(a, [CL], "new", order, BY_ID).arrangement;
    expect(summaryOf(fresh)).toEqual({ commits: 4, units: 8, skipped: 1, untitled: 1 });
    expect(blockedReason(fresh)).toEqual({ reason: "title", commit: 3 });
    expect(blockedReason({ skip: [ENV], commits: [] })).toEqual({ reason: "nothing" });
    expect(blockedReason(a)).toBeNull();
  });
});

describe("Compose plan and new proposals", () => {
  it("the plan sends trimmed messages and the units", () => {
    const a = setTitle(proposal(), 2, "  style: Imports  ");
    expect(planOf(a)[2]).toEqual({ title: "style: Imports", body: "", units: [STAFF0] });
    expect(planOf(a)[1]!.body).toBe("Mit Test.");
  });

  it("moved units go along as “keep” with their commit's summary, and stay where they are in the new proposal", () => {
    const a = moveUnits(moveUnits(proposal(), [STAFF0], 0, order, BY_ID).arrangement, [CL], SKIP, order, BY_ID).arrangement;
    const pinned = new Set([STAFF0, CL]);
    expect(keepOf(a, pinned)).toEqual([
      { unit: STAFF0, commit: "feat(admin): Zwei-Faktor-Status" },
      { unit: CL, commit: null },
    ]);
    // The new answer leaves the kept units out and names its commits differently.
    const fresh = fromProposal(UNITS, [
      { title: "feat(admin): MFA-Spalte", body: "", reason: "", units: [MFA, STAFF1, DE0] },
      { title: "fix(einladungen): Ablauf", body: "", reason: "", units: [EXP, DE1] },
      { title: "test(einladungen): Zeitumstellung", body: "", reason: "", units: [EXPTEST] },
    ]);
    const merged = reproposed(fresh, a, pinned, order);
    expect(shape(merged)).toEqual({
      skip: [ENV, CL],
      commits: [
        ["feat(admin): MFA-Spalte", MFA, STAFF1, DE0],
        ["fix(einladungen): Ablauf", DE1, EXP],
        ["test(einladungen): Zeitumstellung", EXPTEST],
        ["feat(admin): Zwei-Faktor-Status", STAFF0],
      ],
    });
    expect(merged.commits[3]!.origin).toBe("user");
    // A kept unit whose commit title the new proposal reuses joins that commit.
    const same = reproposed(fromProposal(UNITS, [{ title: "feat(admin): Zwei-Faktor-Status", body: "", reason: "", units: [MFA] }]), a, pinned, order);
    expect(shape(same).commits).toEqual([["feat(admin): Zwei-Faktor-Status", MFA, STAFF0]]);
  });

  it("reads the job progress line", () => {
    expect(progressOf("2/3")).toEqual({ current: 2, total: 3 });
    expect(progressOf("fetching")).toBeNull();
    expect(progressOf(undefined)).toBeNull();
  });
});

describe("Compose keyboard", () => {
  const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

  it("maps the prototype's keys", () => {
    expect(keyAction(key("ArrowDown"), false)).toEqual({ kind: "step", delta: 1 });
    expect(keyAction(key("ArrowUp", { shiftKey: true }), false)).toEqual({ kind: "extend", delta: -1 });
    expect(keyAction(key("ArrowDown", { altKey: true }), false)).toEqual({ kind: "shift", delta: 1 });
    expect(keyAction(key("ArrowUp", { ctrlKey: true }), false)).toEqual({ kind: "moveCommit", delta: -1 });
    expect(keyAction(key("ArrowUp", { metaKey: true }), true)).toEqual({ kind: "moveCommit", delta: -1 });
    expect(keyAction(key("3"), false)).toEqual({ kind: "to", group: 2 });
    expect(keyAction(key("0"), false)).toEqual({ kind: "to", group: SKIP });
    expect(keyAction(key("n"), false)).toEqual({ kind: "newCommit" });
    expect(keyAction(key("N", { shiftKey: true }), false)).toEqual({ kind: "newCommit" });
    expect(keyAction(key("u"), false)).toEqual({ kind: "nextUnsure" });
    expect(keyAction(key("Enter"), false)).toEqual({ kind: "confirm" });
    expect(keyAction(key("F2"), false)).toEqual({ kind: "edit" });
    expect(keyAction(key("Enter", { ctrlKey: true }), false)).toEqual({ kind: "apply" });
    expect(keyAction(key("Enter", { metaKey: true }), true)).toEqual({ kind: "apply" });
  });

  it("leaves other combinations alone", () => {
    expect(keyAction(key("3", { ctrlKey: true }), false)).toBeNull();
    expect(keyAction(key("n", { ctrlKey: true }), false)).toBeNull();
    expect(keyAction(key("Enter", { metaKey: true }), false)).toBeNull();
    expect(keyAction(key("x"), false)).toBeNull();
    expect(keyAction(key("ArrowDown", { altKey: true, shiftKey: true }), false)).toBeNull();
  });
});
