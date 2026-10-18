import { describe, expect, it } from "vitest";
import type { Agent, AgentCollision, CollisionReport } from "../../core";
import { agentNames, collisionTitle, collisionsOf, conflictFiles, fileLabel, formatRanges, informTargets, informText, newCollisionIds, sideLabels } from "./collision";

const agent = (over: Partial<Agent>): Agent => ({
  id: "a",
  repoId: "r",
  worktreeRepoId: "w",
  shortName: "a-login",
  templateId: "claude",
  templateName: "Claude Code",
  task: "Login",
  branch: "agent/a-login",
  worktreePath: "/tmp/repo.agents/a-login",
  base: "main",
  baseSha: "1".repeat(40),
  unattended: false,
  status: "running",
  statusSource: "agent",
  terminalId: "t1",
  startedAt: "2026-10-16T08:00:00.000Z",
  endedAt: null,
  exitCode: null,
  lastLine: null,
  changedFiles: 1,
  commitsAhead: 0,
  test: null,
  ...over,
});
const A = agent({ id: "a", shortName: "a-login" });
const B = agent({ id: "b", shortName: "b-auth", startedAt: "2026-10-16T08:05:00.000Z", terminalId: "t2" });
const names = agentNames([A, B]);
const pair: AgentCollision = { id: "a+b", kind: "conflict", agentId: "a", otherAgentId: "b", base: null, files: [{ path: "src/auth.ts", conflict: true, ranges: [{ start: 40, end: 62 }] }] };
const withBase: AgentCollision = { ...pair, id: "a+base", otherAgentId: null, base: "main" };
const report = (over: Partial<CollisionReport>): CollisionReport => ({ repoId: "r", state: "done", checkedAt: "2026-10-16T08:10:00.000Z", error: null, collisions: [], skipped: [], ...over });

describe("agents: collision texts", () => {
  it("formats line ranges without grouping", () => {
    expect(formatRanges([])).toBe("");
    expect(formatRanges([{ start: 7, end: 7 }])).toBe("line 7");
    expect(formatRanges([{ start: 40, end: 62 }])).toBe("lines 40–62");
    expect(formatRanges([{ start: 7, end: 7 }, { start: 40, end: 62 }])).toBe("lines 7, 40–62");
    expect(formatRanges([{ start: 15001, end: 15200 }])).toBe("lines 15001–15200");
  });

  it("names a file with its lines", () => {
    expect(fileLabel(pair.files[0]!)).toBe("src/auth.ts (lines 40–62)");
    expect(fileLabel({ path: "bild.bin", conflict: true, ranges: [] })).toBe("bild.bin");
  });

  it("says in words who collides where", () => {
    expect(collisionTitle(pair, names)).toBe("“a-login” and “b-auth” would collide in src/auth.ts (lines 40–62)");
    const more: AgentCollision = { ...pair, files: [...pair.files, { path: "README.md", conflict: true, ranges: [] }, { path: "x.txt", conflict: true, ranges: [] }] };
    expect(collisionTitle(more, names)).toBe("“a-login” and “b-auth” would collide in src/auth.ts (lines 40–62) and 2 more files");
    const overlap: AgentCollision = { ...pair, kind: "overlap", files: [{ path: "f.txt", conflict: false, ranges: [] }, { path: "g.txt", conflict: false, ranges: [] }] };
    expect(collisionTitle(overlap, names)).toBe("“a-login” and “b-auth” both change f.txt and 1 more file");
    expect(collisionTitle(withBase, names)).toBe("“a-login” would collide with the current main in src/auth.ts (lines 40–62)");
    expect(collisionTitle({ ...withBase, kind: "overlap", files: [{ path: "g.txt", conflict: false, ranges: [] }] }, names)).toBe("“a-login” and the current main both change g.txt");
    // An agent the list does not know (any more) is shown by its id.
    expect(collisionTitle({ ...pair, otherAgentId: "zzz" }, names)).toBe("“a-login” and “zzz” would collide in src/auth.ts (lines 40–62)");
  });

  it("labels both sides of a preview and picks the conflicting files", () => {
    expect(sideLabels(pair, names)).toEqual(["a-login", "b-auth"]);
    expect(sideLabels(withBase, names)).toEqual(["a-login", "current main"]);
    expect(conflictFiles({ ...pair, files: [...pair.files, { path: "f.txt", conflict: false, ranges: [] }] }).map((file) => file.path)).toEqual(["src/auth.ts"]);
  });
});

describe("agents: which collisions a view shows", () => {
  it("filters by agent and drops unknown agents and failed reports", () => {
    const ghost: AgentCollision = { ...pair, id: "a+x", otherAgentId: "x" };
    const all = report({ collisions: [pair, withBase, ghost] });
    expect(collisionsOf(all, [A, B]).map((c) => c.id)).toEqual(["a+b", "a+base"]);
    expect(collisionsOf(all, [A, B], "b").map((c) => c.id)).toEqual(["a+b"]);
    expect(collisionsOf(report({ state: "failed", error: "kaputt", collisions: [pair] }), [A, B])).toEqual([]);
    expect(collisionsOf(report({ state: "checking", collisions: [pair] }), [A, B]).map((c) => c.id)).toEqual(["a+b"]);
    expect(collisionsOf(undefined, [A, B])).toEqual([]);
  });

  it("announces only collisions that are new", () => {
    expect(newCollisionIds(new Set(["a+b"]), [pair, withBase])).toEqual(["a+base"]);
    expect(newCollisionIds(new Set(["a+b", "a+base"]), [pair])).toEqual([]);
  });
});

describe("agents: informing an agent", () => {
  it("offers the running agents of the collision, the later one first", () => {
    expect(informTargets(pair, [A, B]).map((a) => a.id)).toEqual(["b", "a"]);
    expect(informTargets(pair, [A, { ...B, terminalId: null, status: "stopped" }]).map((a) => a.id)).toEqual(["a"]);
    expect(informTargets(pair, [{ ...A, terminalId: null }, { ...B, terminalId: null }])).toEqual([]);
    expect(informTargets(withBase, [A, B]).map((a) => a.id)).toEqual(["a"]);
  });

  it("prefills a note naming the other side and the files", () => {
    expect(informText(pair, "b", names)).toBe(
      "Note from Forkyard: the coding agent “a-login” is also changing src/auth.ts (lines 40–62). Please avoid conflicting edits there, or tell me how you want to proceed.",
    );
    expect(informText(pair, "a", names)).toBe(
      "Note from Forkyard: the coding agent “b-auth” is also changing src/auth.ts (lines 40–62). Please avoid conflicting edits there, or tell me how you want to proceed.",
    );
    expect(informText(withBase, "a", names)).toBe(
      "Note from Forkyard: main has changed src/auth.ts (lines 40–62) since you started. Please avoid conflicting edits there, or tell me how you want to proceed.",
    );
  });
});
