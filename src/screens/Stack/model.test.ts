import { describe, expect, it } from "vitest";
import type { PushResult, Ref, RefsSnapshot, StackCommit, StackStatus } from "../../core";
import {
  allPushed,
  baseOptions,
  checkTone,
  cutsOf,
  defaultBase,
  defaultBody,
  firstWithoutPr,
  fromSuggestion,
  isCutAfter,
  isUntouched,
  listKey,
  needsForce,
  placeSplit,
  prParts,
  prTargets,
  ranges,
  rejectedRefs,
  singlePart,
  titleOf,
  toggleCut,
  type DraftPart,
} from "./model";

const commit = (sha: string, subject: string): StackCommit => ({ sha, subject, files: 1, added: 1, deleted: 0 });
const COMMITS = [commit("a1", "Datenmodell für Stationen"), commit("b2", "Import der Messwerte"), commit("c3", "Auswertung je Monat"), commit("d4", "Diagramme")];

const ref = (name: string, extra: Partial<Ref> = {}): Ref => ({
  name,
  fullName: extra.remote ? `refs/remotes/${name}` : `refs/heads/${name}`,
  kind: extra.remote ? "remote" : "local",
  sha: "0".repeat(40),
  isHead: false,
  upstream: null,
  upstreamGone: false,
  ahead: 0,
  behind: 0,
  remote: null,
  annotation: null,
  isAnnotated: false,
  worktreePath: null,
  ...extra,
});

const snapshot = (locals: Ref[], remotes: Ref[] = []): RefsSnapshot => ({ head: { kind: "branch", branch: "feature/auswertung", sha: "0".repeat(40) }, locals, remotes, tags: [] });

const STATUS: StackStatus = {
  base: "refs/remotes/origin/main",
  baseName: "main",
  parts: [
    { branch: "f-1-modell", parent: "refs/remotes/origin/main", tip: "a", containsParent: true, worktreePath: null, subjects: ["Datenmodell für Stationen", "Import der Messwerte"] },
    { branch: "f-2-auswertung", parent: "refs/heads/f-1-modell", tip: "b", containsParent: true, worktreePath: null, subjects: ["Auswertung je Monat"] },
    { branch: "f-3-diagramme", parent: "refs/heads/f-2-auswertung", tip: "c", containsParent: true, worktreePath: null, subjects: [] },
  ],
  restack: null,
};

describe("cuts", () => {
  it("splitting after a commit makes two parts, splitting there again joins them", () => {
    const one = singlePart(4);
    expect(isUntouched(one, 4)).toBe(true);
    const two = toggleCut(one, 2, 4);
    expect(two).toEqual([
      { end: 2, name: "", title: null, why: null },
      { end: 4, name: "", title: null, why: null },
    ]);
    expect(ranges(two)).toEqual([
      { first: 1, end: 2 },
      { first: 3, end: 4 },
    ]);
    expect(isCutAfter(two, 2)).toBe(true);
    expect(isCutAfter(two, 4)).toBe(false);
    expect(toggleCut(two, 2, 4)).toEqual(one);
  });

  it("the new lower part starts without a name, the upper one keeps its name and title", () => {
    const named: DraftPart[] = [{ end: 4, name: "Auswertung", title: "Auswertung je Station", why: "Weil." }];
    expect(toggleCut(named, 1, 4)).toEqual([
      { end: 1, name: "", title: null, why: null },
      { end: 4, name: "Auswertung", title: "Auswertung je Station", why: null },
    ]);
    const joined = toggleCut([{ end: 1, name: "Modell", title: null, why: null }, { end: 4, name: "Rest", title: "Rest", why: null }], 1, 4);
    expect(joined).toEqual([{ end: 4, name: "Modell", title: "Rest", why: null }]);
  });

  it("nothing is cut after the newest commit or before the first", () => {
    const one = singlePart(4);
    expect(toggleCut(one, 4, 4)).toBe(one);
    expect(toggleCut(one, 0, 4)).toBe(one);
  });

  it("cuts carry the trimmed names to the core", () => {
    expect(cutsOf([{ end: 2, name: "  Datenmodell ", title: null, why: null }, { end: 4, name: "", title: "x", why: null }])).toEqual([
      { end: 2, name: "Datenmodell" },
      { end: 4, name: "" },
    ]);
  });
});

describe("suggestions", () => {
  it("become parts with names, titles and reasons", () => {
    expect(fromSuggestion({ parts: [{ end: 2, name: "Modell", title: "Datenmodell", why: "Eigenes Thema." }, { end: 4, name: "Rest", title: "", why: "" }] })).toEqual([
      { end: 2, name: "Modell", title: "Datenmodell", why: "Eigenes Thema." },
      { end: 4, name: "Rest", title: null, why: null },
    ]);
  });

  it("go straight into an untouched plan, otherwise they are offered", () => {
    const own = toggleCut(singlePart(4), 3, 4);
    expect(placeSplit(singlePart(4), singlePart(4), 4)).toBe("insert");
    expect(placeSplit(null, null, 4)).toBe("insert");
    expect(placeSplit(own, own, 4)).toBe("choose");
    expect(placeSplit(toggleCut(own, 1, 4), own, 4)).toBe("ready");
  });
});

describe("pull requests", () => {
  it("a part's title is the typed one, else its first commit's subject", () => {
    expect(titleOf({ end: 2, name: "", title: null, why: null }, COMMITS, 1)).toBe("Datenmodell für Stationen");
    expect(titleOf({ end: 4, name: "", title: "Eigener Titel", why: null }, COMMITS, 3)).toBe("Eigener Titel");
    expect(defaultBody(["Datenmodell für Stationen", "Import der Messwerte"])).toBe("- Datenmodell für Stationen\n- Import der Messwerte");
  });

  it("use remembered titles, then the first subject, then the branch name, and target the part below", () => {
    expect(prParts(STATUS, { "f-2-auswertung": "  Auswertung je Monat und Jahr " })).toEqual([
      { branch: "f-1-modell", title: "Datenmodell für Stationen", body: "- Datenmodell für Stationen\n- Import der Messwerte", draft: false },
      { branch: "f-2-auswertung", title: "Auswertung je Monat und Jahr", body: "- Auswertung je Monat", draft: false },
      { branch: "f-3-diagramme", title: "f-3-diagramme", body: "", draft: false },
    ]);
    expect(prTargets(STATUS)).toEqual(["main", "f-1-modell", "f-2-auswertung"]);
  });

  it("continue with the first part that has no pull request yet", () => {
    expect(firstWithoutPr(STATUS, () => false)).toBe(0);
    expect(firstWithoutPr(STATUS, (branch) => branch === "f-1-modell")).toBe(1);
    expect(firstWithoutPr(STATUS, () => true)).toBe(3);
  });
});

describe("base and push", () => {
  const locals = [ref("main"), ref("feature/auswertung", { isHead: true }), ref("dev")];
  const remotes = [ref("origin/main", { remote: "origin" }), ref("origin/HEAD", { remote: "origin" }), ref("team/release", { remote: "team" })];

  it("the default base is the host's default branch on its remote, then locally, then main", () => {
    expect(defaultBase(snapshot(locals, remotes), "origin", "main", "feature/auswertung")).toBe("refs/remotes/origin/main");
    expect(defaultBase(snapshot(locals, remotes), "team", "release", "feature/auswertung")).toBe("refs/remotes/team/release");
    expect(defaultBase(snapshot(locals, remotes), "origin", "dev", "feature/auswertung")).toBe("refs/heads/dev");
    expect(defaultBase(snapshot(locals), null, null, "feature/auswertung")).toBe("refs/heads/main");
    // Never the split branch itself.
    expect(defaultBase(snapshot([ref("main")]), null, null, "main")).toBe(null);
    expect(defaultBase(undefined, "origin", "main", "x")).toBe(null);
  });

  it("offers every branch except the split one and the remote HEAD", () => {
    expect(baseOptions(snapshot(locals, remotes), "feature/auswertung").map((option) => option.value)).toEqual([
      "refs/heads/main",
      "refs/heads/dev",
      "refs/remotes/origin/main",
      "refs/remotes/team/release",
    ]);
  });

  it("pull requests need every part pushed; a part behind its upstream needs force with lease", () => {
    const pushed = STATUS.parts.map((part) => ref(part.branch, { upstream: `origin/${part.branch}` }));
    expect(allPushed(STATUS, pushed, "origin")).toBe(true);
    expect(allPushed(STATUS, pushed.slice(0, 2), "origin")).toBe(false);
    expect(allPushed(STATUS, [pushed[0]!, { ...pushed[1]!, ahead: 1 }, pushed[2]!], "origin")).toBe(false);
    expect(allPushed(STATUS, pushed, "team")).toBe(false);
    expect(needsForce(STATUS, pushed)).toBe(false);
    expect(needsForce(STATUS, [pushed[0]!, { ...pushed[1]!, ahead: 2, behind: 1 }, pushed[2]!])).toBe(true);
    // Without an upstream there is nothing to overwrite.
    expect(needsForce(STATUS, [ref("f-1-modell", { behind: 3 })])).toBe(false);
  });

  it("names the refused refs of a push", () => {
    const multi: PushResult = {
      status: "multi",
      remote: "origin",
      atomic: true,
      refs: [
        { local: "refs/heads/f-1-modell", remoteRef: "refs/heads/f-1-modell", status: "rejected", forced: false, reason: "atomic push failed" },
        { local: "refs/heads/f-2-auswertung", remoteRef: "refs/heads/f-2-auswertung", status: "rejected", forced: false, reason: "non-fast-forward" },
        { local: "refs/heads/f-3-diagramme", remoteRef: "refs/heads/f-3-diagramme", status: "ok", forced: false, reason: null },
      ],
    };
    expect(rejectedRefs(multi)).toEqual(["f-1-modell: atomic push failed", "f-2-auswertung: non-fast-forward"]);
    expect(rejectedRefs({ status: "rejected", reason: "fetch first" })).toEqual(["fetch first"]);
    expect(rejectedRefs({ status: "up_to_date" })).toEqual([]);
  });
});

describe("states and keys", () => {
  it("every check state has its own tone, never colour alone (the view adds the word)", () => {
    expect(["running", "passed", "failed", "timed_out"].map((state) => checkTone(state as "running"))).toEqual(["accent", "success", "danger", "warning"]);
  });

  it("arrows move, Home/End jump, space toggles; modified keys are left alone", () => {
    expect(listKey("ArrowDown", false, 0, 4)).toEqual({ kind: "move", index: 1 });
    expect(listKey("ArrowDown", false, 3, 4)).toEqual({ kind: "move", index: 3 });
    expect(listKey("ArrowUp", false, 0, 4)).toEqual({ kind: "move", index: 0 });
    expect(listKey("Home", false, 2, 4)).toEqual({ kind: "move", index: 0 });
    expect(listKey("End", false, 0, 4)).toEqual({ kind: "move", index: 3 });
    expect(listKey(" ", false, 1, 4)).toEqual({ kind: "toggle" });
    expect(listKey(" ", true, 1, 4)).toBe(null);
    expect(listKey("a", false, 1, 4)).toBe(null);
  });
});
