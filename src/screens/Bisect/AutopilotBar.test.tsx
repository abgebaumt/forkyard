import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BisectAutopilot } from "../../core";

const current = vi.hoisted(() => ({ run: null as unknown }));
vi.mock("../../app/queries", async (original) => ({
  ...(await original<typeof import("../../app/queries")>()),
  useBisectAutopilot: () => ({ data: current.run }),
  useAiStatus: () => ({ data: undefined }),
  useRepoSettings: () => ({ data: undefined }),
}));

import { TooltipProvider } from "../../ui/Tooltip";
import { AutopilotBar } from "./AutopilotBar";

const BAD = "c0ffee1234567890c0ffee1234567890c0ffee12";
const GOOD = "0123456789abcdef0123456789abcdef01234567";
const MID = "abcdef0123456789abcdef0123456789abcdef01";

const run = (patch: Partial<BisectAutopilot>): BisectAutopilot => ({
  jobId: "j1",
  phase: "testing",
  worktreePath: "/home/anna/projekte/hafen.agents/bisect-1",
  bad: BAD,
  good: [GOOD],
  current: null,
  remainingSteps: null,
  steps: [],
  result: null,
  candidates: [],
  stepTimeoutSecs: 600,
  message: null,
  startedAt: "2026-10-18T09:00:00Z",
  ...patch,
});
const step = (sha: string, timedOut = false): BisectAutopilot["steps"][number] => ({ sha, verdict: timedOut ? "skip" : "bad", exitCode: timedOut ? null : 1, timedOut, durationMs: 1200, outputTail: "" });

const bar = (value: BisectAutopilot | null) => {
  current.run = value;
  return renderToStaticMarkup(
    <TooltipProvider>
      <AutopilotBar repoId="r1" tabId="t1" />
    </TooltipProvider>,
  );
};

describe("bisect autopilot bar", () => {
  it("is not there without a run", () => {
    expect(bar(null)).toBe("");
  });

  it("while testing: running dot + word, the step and commit, only Stop", () => {
    const markup = bar(run({ phase: "testing", current: MID, remainingSteps: 2, steps: [step(GOOD), step(BAD, true)] }));
    expect(markup).toContain('data-bisect-autopilot="testing"');
    expect(markup).toContain("bg-accent");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Running · Step 3 of ~5 · testing abcdef0");
    expect(markup).toContain("1 step skipped after the time limit");
    expect(markup).toContain('data-autopilot-action="stop"');
    expect(markup).not.toContain('data-autopilot-action="keep"');
    expect(markup).not.toContain('data-autopilot-action="remove"');
  });

  it("while preparing: the worktree is being set up, Stop is offered", () => {
    const markup = bar(run({ phase: "preparing" }));
    expect(markup).toContain('data-bisect-autopilot="preparing"');
    expect(markup).toContain("Setting up the temporary worktree …");
    expect(markup).toContain('data-autopilot-action="stop"');
  });

  it("found: done, the first bad commit after n steps, Show / Keep / Remove, no Stop", () => {
    const markup = bar(run({ phase: "found", result: BAD, steps: [step(MID), step(GOOD)] }));
    expect(markup).toContain('data-bisect-autopilot="found"');
    expect(markup).toContain("bg-success");
    expect(markup).toContain("Done · First bad commit: c0ffee1 after 2 steps");
    for (const action of ["show", "keep", "remove"]) expect(markup).toContain(`data-autopilot-action="${action}"`);
    expect(markup).not.toContain('data-autopilot-action="stop"');
  });

  it("only skipped: undecided with the number of candidates", () => {
    const markup = bar(run({ phase: "only_skipped", candidates: [MID, BAD] }));
    expect(markup).toContain('data-bisect-autopilot="only_skipped"');
    expect(markup).toContain("bg-warning");
    expect(markup).toContain("Undecided · Only skipped commits are left – the first bad commit is among 2 candidates");
    expect(markup).toContain('data-autopilot-action="keep"');
    expect(markup).not.toContain('data-autopilot-action="show"');
  });

  it("failed: danger dot, the core's message announced assertively, Keep / Remove", () => {
    const markup = bar(run({ phase: "failed", message: "The test script ended with exit code 200." }));
    expect(markup).toContain('data-bisect-autopilot="failed"');
    expect(markup).toContain("bg-danger");
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("Failed · The test script ended with exit code 200.");
    expect(markup).toContain('data-autopilot-action="remove"');
  });
});
