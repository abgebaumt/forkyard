/** Pure helpers of the bisect autopilot (9.1): bar state, exit codes, inputs, availability. */
import type { AiStatus, BisectAutopilot, BisectShell, BisectStatus, Sha } from "../../core";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";

export const DEFAULT_STEP_MINUTES = 10;
export const MAX_STEP_MINUTES = 240;
/** Same limits as the core (`ai::bisect`). */
export const MAX_SCRIPT_BYTES = 64 * 1024;
export const MAX_DESCRIPTION = 4000;
export const MAX_TEST_COMMAND = 1000;

export type AutopilotBarState =
  | { kind: "off" }
  | { kind: "preparing" }
  | { kind: "testing"; step: number; total: number; current: Sha | null; timedOut: number }
  | { kind: "found"; sha: Sha; steps: number; timedOut: number }
  | { kind: "only_skipped"; candidates: Sha[]; timedOut: number }
  | { kind: "failed"; message: string };

export function autopilotBar(run: BisectAutopilot | null | undefined): AutopilotBarState {
  if (!run) return { kind: "off" };
  const timedOut = run.steps.filter((step) => step.timedOut).length;
  switch (run.phase) {
    case "preparing":
      return { kind: "preparing" };
    case "testing": {
      const step = run.steps.length + 1;
      return { kind: "testing", step, total: step + (run.remainingSteps ?? 0), current: run.current, timedOut };
    }
    case "found":
      return run.result ? { kind: "found", sha: run.result, steps: run.steps.length, timedOut } : { kind: "failed", message: run.message ?? "" };
    case "only_skipped":
      return { kind: "only_skipped", candidates: run.candidates, timedOut };
    case "failed":
      return { kind: "failed", message: run.message ?? "" };
  }
}

export type ExitMeaning = "good" | "bad" | "skip" | "stops";

/** As `git bisect run` reads an exit code (spec 9.1). */
export function exitMeaning(code: number): ExitMeaning {
  if (code === 0) return "good";
  if (code === 125) return "skip";
  if (Number.isInteger(code) && code >= 1 && code <= 127) return "bad";
  return "stops";
}

export function stepTimeoutSecs(minutes: number): number {
  const whole = Number.isFinite(minutes) ? Math.round(minutes) : DEFAULT_STEP_MINUTES;
  return Math.min(MAX_STEP_MINUTES, Math.max(1, whole)) * 60;
}

export type ScriptProblem = "empty" | "tooLong" | null;

export function scriptProblem(script: string): ScriptProblem {
  if (script.trim() === "") return "empty";
  if (new TextEncoder().encode(script).length > MAX_SCRIPT_BYTES) return "tooLong";
  return null;
}

/** Bad and good commits of a running manual bisect that has both and no result yet. */
export function rangeFromBisect(status: BisectStatus | undefined): { bad: Sha; good: Sha[] } | null {
  if (!status?.active || status.result || !status.bad || status.good.length === 0) return null;
  return { bad: status.bad, good: [...status.good] };
}

export type AutopilotAccess = "hidden" | "setup" | "ready";

/** Hidden like every AI element; "setup" while AI is on without a provider (a click opens Settings › AI). */
export function autopilotAccess(status: AiStatus | null | undefined, repoAiOff: boolean): AutopilotAccess {
  if (!featureVisible(status, "bisect_script", repoAiOff)) return "hidden";
  return aiVisibility(status).elementsOpenSetup ? "setup" : "ready";
}

/** The shell the core runs scripts with (`BisectShell::current`). */
export function shellFor(platform: string): BisectShell {
  return platform === "windows" ? "powershell" : "sh";
}

export function isRunning(run: BisectAutopilot | null | undefined): boolean {
  return run?.phase === "preparing" || run?.phase === "testing";
}
