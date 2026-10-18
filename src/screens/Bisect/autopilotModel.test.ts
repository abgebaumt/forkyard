import { describe, expect, it } from "vitest";
import type { AiStatus, BisectAutopilot, BisectAutopilotStep, BisectStatus } from "../../core";
import { MAX_SCRIPT_BYTES, autopilotAccess, autopilotBar, exitMeaning, isRunning, rangeFromBisect, scriptProblem, shellFor, stepTimeoutSecs } from "./autopilotModel";

const run = (patch: Partial<BisectAutopilot>): BisectAutopilot => ({
  jobId: "j",
  phase: "testing",
  worktreePath: "/home/anna/Mein Projekt.agents/bisect-1",
  bad: "b",
  good: ["g"],
  current: null,
  remainingSteps: null,
  steps: [],
  result: null,
  candidates: [],
  stepTimeoutSecs: 600,
  message: null,
  startedAt: "2026-10-16T08:00:00Z",
  ...patch,
});
const step = (sha: string, timedOut = false): BisectAutopilotStep => ({ sha, verdict: timedOut ? "skip" : "good", exitCode: timedOut ? null : 0, timedOut, durationMs: 10, outputTail: "" });
const ai = (patch: Partial<AiStatus>) => ({ state: "on", provider: "ollama", model: "qwen3:8b", connected: true, keyHint: null, local: true, price: null, introPending: false, featuresOff: [], ...patch }) as AiStatus;
const bisect = (patch: Partial<BisectStatus>): BisectStatus => ({ active: true, bad: null, good: [], skipped: [], current: null, remainingSteps: null, stepsDone: 0, result: null, onlySkippedLeft: false, ...patch });

describe("autopilotBar", () => {
  it("is off without a run and counts the step under test with Git's estimate", () => {
    expect(autopilotBar(null)).toEqual({ kind: "off" });
    expect(autopilotBar(run({ phase: "preparing" }))).toEqual({ kind: "preparing" });
    expect(autopilotBar(run({ steps: [step("a"), step("c", true)], current: "d", remainingSteps: 2 }))).toEqual({ kind: "testing", step: 3, total: 5, current: "d", timedOut: 1 });
    expect(autopilotBar(run({ remainingSteps: null }))).toEqual({ kind: "testing", step: 1, total: 1, current: null, timedOut: 0 });
  });

  it("names the result, the candidates or the failure", () => {
    expect(autopilotBar(run({ phase: "found", result: "x", steps: [step("a"), step("b"), step("c", true)] }))).toEqual({ kind: "found", sha: "x", steps: 3, timedOut: 1 });
    expect(autopilotBar(run({ phase: "only_skipped", candidates: ["s", "b"] }))).toEqual({ kind: "only_skipped", candidates: ["s", "b"], timedOut: 0 });
    expect(autopilotBar(run({ phase: "failed", message: "The test script ended with exit code 130 on abc1234." }))).toEqual({ kind: "failed", message: "The test script ended with exit code 130 on abc1234." });
    expect(autopilotBar(run({ phase: "found", result: null, message: null }))).toEqual({ kind: "failed", message: "" });
  });
});

describe("exit codes, time limit and script", () => {
  it("reads exit codes as git bisect run does (spec 9.1)", () => {
    const table: [number, string][] = [[0, "good"], [1, "bad"], [124, "bad"], [125, "skip"], [126, "bad"], [127, "bad"], [128, "stops"], [255, "stops"], [-1, "stops"]];
    for (const [code, meaning] of table) expect(exitMeaning(code)).toBe(meaning);
  });

  it("turns minutes into seconds within 1 to 240 minutes, default 10", () => {
    expect(stepTimeoutSecs(10)).toBe(600);
    expect(stepTimeoutSecs(0)).toBe(60);
    expect(stepTimeoutSecs(241)).toBe(14_400);
    expect(stepTimeoutSecs(2.6)).toBe(180);
    expect(stepTimeoutSecs(Number.NaN)).toBe(600);
  });

  it("refuses empty and oversized scripts by bytes, not characters", () => {
    expect(scriptProblem("")).toBe("empty");
    expect(scriptProblem("  \n")).toBe("empty");
    expect(scriptProblem("exit 0\n")).toBeNull();
    expect(scriptProblem("ä".repeat(MAX_SCRIPT_BYTES / 2))).toBeNull();
    expect(scriptProblem("ä".repeat(MAX_SCRIPT_BYTES / 2 + 1))).toBe("tooLong");
  });

  it("runs sh except on Windows", () => {
    expect([shellFor("windows"), shellFor("linux"), shellFor("mac")]).toEqual(["powershell", "sh", "sh"]);
  });
});

describe("range and availability", () => {
  it("takes over the range of a running manual bisect only while it has one", () => {
    expect(rangeFromBisect(undefined)).toBeNull();
    expect(rangeFromBisect(bisect({ active: false, bad: "b", good: ["g"] }))).toBeNull();
    expect(rangeFromBisect(bisect({ bad: "b" }))).toBeNull();
    expect(rangeFromBisect(bisect({ bad: "b", good: ["g1", "g2"], result: "b" }))).toBeNull();
    expect(rangeFromBisect(bisect({ bad: "b", good: ["g1", "g2"] }))).toEqual({ bad: "b", good: ["g1", "g2"] });
  });

  it("follows the visibility of AI elements (spec 1.3)", () => {
    expect(autopilotAccess(undefined, false)).toBe("hidden");
    expect(autopilotAccess(ai({ state: "unset", connected: false }), false)).toBe("hidden");
    expect(autopilotAccess(ai({ state: "off" }), false)).toBe("hidden");
    expect(autopilotAccess(ai({}), false)).toBe("ready");
    expect(autopilotAccess(ai({ connected: false }), false)).toBe("setup");
    expect(autopilotAccess(ai({ featuresOff: ["bisect_script"] }), false)).toBe("hidden");
    expect(autopilotAccess(ai({}), true)).toBe("hidden");
  });

  it("knows a running run", () => {
    expect([isRunning(null), isRunning(run({ phase: "preparing" })), isRunning(run({})), isRunning(run({ phase: "found", result: "x" }))]).toEqual([false, true, true, false]);
  });
});
