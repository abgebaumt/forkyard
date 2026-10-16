import { describe, expect, it } from "vitest";
import type { Agent, AgentTemplateInfo } from "../../core";
import {
  actionsFor,
  agentCounts,
  cleanupLines,
  defaultTemplateId,
  displayName,
  formatRuntime,
  manyAgentsHint,
  needsYou,
  sortAgents,
  startBlocker,
  startLabel,
  statusChanges,
  statusLabel,
  statusOrigin,
  statusTone,
  templateOptionLabel,
  testLabel,
  toolbarLabel,
  unattendedChoice,
  type StartDraft,
} from "./model";

const agent = (patch: Partial<Agent>): Agent => ({
  id: "a1",
  repoId: "r",
  worktreeRepoId: "w",
  shortName: "fix-login",
  templateId: "claude",
  templateName: "Claude Code",
  task: "Fix login",
  branch: "agent/fix-login",
  worktreePath: "/home/anna/web.agents/fix-login",
  base: "main",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  unattended: false,
  status: "running",
  statusSource: "agent",
  terminalId: "t1",
  startedAt: "2026-10-16T08:00:00.000Z",
  endedAt: null,
  exitCode: null,
  lastLine: null,
  changedFiles: 0,
  commitsAhead: 0,
  test: null,
  ...patch,
});

const template = (patch: Partial<AgentTemplateInfo>): AgentTemplateInfo => ({
  id: "claude",
  kind: "claude",
  name: "Claude Code",
  program: "claude",
  path: "/usr/local/bin/claude",
  version: "2.1.301",
  unattendedBlocked: null,
  unattendedNote: null,
  canResume: true,
  statusHook: true,
  ...patch,
});

describe("agents: status", () => {
  it("uses the spec's tones and always a word", () => {
    expect(["running", "waiting", "done", "failed", "stopped"].map((s) => statusTone(s as Agent["status"]))).toEqual(["accent", "warning", "success", "danger", "muted"]);
    expect(statusTone("starting")).toBe("accent");
    expect(statusTone("orphaned")).toBe("warning");
    expect(statusLabel("waiting")).toBe("waiting for you");
    expect(statusLabel("stopped")).toBe("stopped");
    expect(statusLabel("orphaned")).toBe("orphaned");
  });
  it("names where the status comes from only while a session runs", () => {
    expect(statusOrigin(agent({}))).toBe("according to Claude Code");
    expect(statusOrigin(agent({ statusSource: "guess" }))).toBe("guessed");
    expect(statusOrigin(agent({ terminalId: null, status: "stopped" }))).toBeNull();
  });
  it("counts running agents and those that wait for the user", () => {
    const list = [agent({ id: "1", status: "waiting" }), agent({ id: "2", status: "done" }), agent({ id: "3" }), agent({ id: "4", status: "done", terminalId: null })];
    expect(agentCounts(list)).toEqual({ running: 3, waiting: 2 });
    expect(needsYou(list[3]!)).toBe(false);
    expect(sortAgents(list).map((a) => a.id)).toEqual(["1", "2", "3", "4"]);
  });
  it("formats the runtime", () => {
    const now = Date.parse("2026-10-16T10:05:30.000Z");
    expect(formatRuntime("2026-10-16T10:05:18.000Z", null, now)).toBe("12 s");
    expect(formatRuntime("2026-10-16T09:58:00.000Z", null, now)).toBe("7 min");
    expect(formatRuntime("2026-10-16T08:00:00.000Z", "2026-10-16T09:04:59.000Z", now)).toBe("1 h 04 min");
    expect(formatRuntime("kaputt", null, now)).toBe("");
  });
  it("shows “without prompts” in the name and the tests as words", () => {
    expect(displayName(agent({ unattended: true }))).toBe("fix-login · without prompts");
    expect(displayName(agent({}))).toBe("fix-login");
    expect(testLabel(null)).toBeNull();
    expect(testLabel({ state: "passed", exitCode: 0, output: "", startedAt: "x", finishedAt: "y" })).toBe("tests passed");
    expect(testLabel({ state: "failed", exitCode: 7, output: "", startedAt: "x", finishedAt: "y" })).toBe("tests failed (exit code 7)");
    expect(testLabel({ state: "running", exitCode: null, output: "", startedAt: "x", finishedAt: null })).toBe("tests running …");
  });
});

describe("agents: start dialog", () => {
  const draft = (patch: Partial<StartDraft>): StartDraft => ({ templateId: "claude", task: "Fix login", branch: "agent/fix-login", base: "main", unattended: false, ...patch });
  const templates = [template({}), template({ id: "opencode", kind: "opencode", name: "opencode", path: null, version: null, unattendedBlocked: "too old", statusHook: false })];

  it("switches warning and button text with “without prompts”", () => {
    expect(startLabel(false)).toBe("Start");
    expect(startLabel(true)).toBe("Start without prompts");
    expect(unattendedChoice(templates[0])).toEqual({ available: true, reason: null, note: null });
    expect(unattendedChoice(templates[1])).toEqual({ available: false, reason: "too old", note: null });
    expect(unattendedChoice(template({ unattendedNote: "Windows" }))).toEqual({ available: true, reason: null, note: "Windows" });
  });
  it("only found templates can be chosen, the first found is the default", () => {
    expect(templateOptionLabel(templates[0]!)).toBe("Claude Code · 2.1.301");
    expect(templateOptionLabel(templates[1]!)).toBe("opencode – not found");
    expect(templateOptionLabel(template({ version: null }))).toBe("Claude Code");
    expect(defaultTemplateId(templates)).toBe("claude");
    expect(defaultTemplateId([templates[1]!])).toBeNull();
  });
  it("names the first reason the start is not possible", () => {
    const ok = { branchProblem: null };
    expect(startBlocker(draft({}), templates, ok, false)).toBeNull();
    expect(startBlocker(draft({ templateId: null }), templates, ok, false)).toBe("Choose an agent.");
    expect(startBlocker(draft({ templateId: "opencode" }), templates, ok, false)).toBe("opencode was not found.");
    expect(startBlocker(draft({ task: "  " }), templates, ok, false)).toBe("Describe the task.");
    expect(startBlocker(draft({ branch: "" }), templates, ok, false)).toBe("Enter a branch name.");
    expect(startBlocker(draft({}), templates, null, true)).toBe("Checking the branch name …");
    expect(startBlocker(draft({}), templates, { branchProblem: "A branch “agent/fix-login” already exists." }, false)).toBe("A branch “agent/fix-login” already exists.");
    expect(startBlocker(draft({ unattended: true }), [template({ unattendedBlocked: "no switch" })], ok, false)).toBe("no switch");
  });
  it("hints from five running agents on", () => {
    expect(manyAgentsHint(4)).toBeNull();
    expect(manyAgentsHint(5)).toBe("5 agents are already running in this repository. Each one uses memory and API quota.");
  });
});

describe("agents: actions and cleanup", () => {
  const opts = { canResume: true, hasTestCommand: false, hasHost: false };
  it("offers what fits the state", () => {
    expect(actionsFor(agent({}), opts)).toEqual(["terminal", "stop", "copyPath", "cleanup"]);
    expect(actionsFor(agent({ terminalId: null, status: "stopped" }), opts)).toEqual(["resume", "copyPath", "cleanup"]);
    expect(actionsFor(agent({ terminalId: null, status: "stopped" }), { ...opts, canResume: false })).toEqual(["copyPath", "cleanup"]);
    expect(actionsFor(agent({ commitsAhead: 2 }), { canResume: true, hasTestCommand: true, hasHost: true })).toEqual(["terminal", "stop", "copyPath", "review", "tests", "pr", "cleanup"]);
    expect(actionsFor(agent({ terminalId: null, status: "done", changedFiles: 3 }), opts)).toEqual(["resume", "copyPath", "review", "cleanup"]);
    expect(actionsFor(agent({ status: "orphaned", terminalId: null }), opts)).toEqual(["forget"]);
  });
  it("warns about unpushed commits and names what is kept", () => {
    expect(cleanupLines({ unpushedCommits: 0, changedFiles: 0, running: false, locked: false })).toEqual([
      { tone: "info", text: "The worktree folder and the branch are removed. Undo (Ctrl+Z) brings them back for 14 days." },
    ]);
    expect(cleanupLines({ unpushedCommits: 2, changedFiles: 1, running: true, locked: false })).toEqual([
      { tone: "warning", text: "Warning: 2 commits of this branch are not pushed. They are only kept by the undo backup (14 days)." },
      { tone: "info", text: "1 uncommitted file is backed up for undo." },
      { tone: "info", text: "The agent is still running and will be stopped." },
      { tone: "info", text: "The worktree folder and the branch are removed. Undo (Ctrl+Z) brings them back for 14 days." },
    ]);
  });
});

describe("agents: status changes worth a notification", () => {
  it("reports waiting, done and failed once, only after a known earlier status", () => {
    const before = new Map([
      ["1", "running"],
      ["2", "running"],
      ["3", "running"],
      ["4", "waiting"],
    ] as const);
    const now = [
      agent({ id: "1", status: "waiting" }),
      agent({ id: "2", status: "done" }),
      agent({ id: "3", status: "failed", terminalId: null }),
      agent({ id: "4", status: "waiting" }),
      agent({ id: "5", status: "waiting" }),
      agent({ id: "6", status: "stopped", terminalId: null }),
    ];
    expect(statusChanges(new Map(before), now).map((change) => [change.agent.id, change.kind])).toEqual([
      ["1", "waiting"],
      ["2", "done"],
      ["3", "failed"],
    ]);
    expect(statusChanges(new Map(), now)).toEqual([]);
  });
  it("names the running agents on the toolbar button", () => {
    expect(toolbarLabel(0)).toBe("Agents");
    expect(toolbarLabel(3)).toBe("Agents 3");
  });
});
