import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus } from "../core";
import type { CommandContext } from "./commandTypes";

const started: unknown[][] = [];
vi.mock("../screens/Bisect/autopilotActions", async (original) => ({
  ...(await original<typeof import("../screens/Bisect/autopilotActions")>()),
  startAutopilot: (...args: unknown[]) => {
    started.push(args);
    return Promise.resolve(null);
  },
}));

const { qk, queryClient } = await import("./queries");
const { isAvailable } = await import("./registry");
const { commands } = await import("./commands/history");

const REPO = "repo-1";
const aiOn = (patch: Partial<AiStatus> = {}): AiStatus => ({
  state: "on",
  provider: "ollama",
  model: "qwen3:8b",
  connected: true,
  keyHint: null,
  local: true,
  price: null,
  introPending: false,
  featuresOff: [],
  ...patch,
});

function ctx(repoId: string | null): CommandContext {
  return {
    platform: "linux",
    tabs: [],
    tab: null,
    tabId: repoId ? "tab-1" : null,
    repoId,
    view: null,
    status: undefined,
    store: {} as CommandContext["store"],
    queryClient: new QueryClient(),
    source: "palette",
  };
}

const run = (phase: string) => ({ jobId: "j1", phase, worktreePath: "/tmp/repo.agents/bisect-1", bad: "1".repeat(40), good: ["2".repeat(40)], current: null, remainingSteps: null, steps: [], result: null, candidates: [], stepTimeoutSecs: 600, message: null, startedAt: "2026-10-18T09:00:00Z" });

const autopilot = () => commands.find((command) => command.id === "bisect.autopilot");

describe("palette command “Bisect autopilot …”", () => {
  beforeEach(() => {
    queryClient.clear();
    started.length = 0;
    queryClient.setQueryData(qk.aiStatus, aiOn());
    queryClient.setQueryData(qk.repoSettings(REPO), { aiOff: false });
  });

  it("is offered in a repository tab while AI is on, also without a manual bisect", () => {
    expect(autopilot()).toBeDefined();
    expect(autopilot()!.title).toBe("Bisect autopilot …");
    expect(isAvailable(autopilot()!, ctx(REPO))).toBe(true);
  });

  it("is not available outside a repository tab and says why", () => {
    expect(isAvailable(autopilot()!, ctx(null))).toBe(false);
    expect(autopilot()!.disabledReason?.(ctx(null))).toBe("Only in a repository tab");
  });

  it("is hidden when AI is not set up, off, the function is off or the repository has AI off", () => {
    const cases: [AiStatus | undefined, boolean][] = [
      [undefined, false],
      [aiOn({ state: "unset" }), false],
      [aiOn({ state: "off" }), false],
      [aiOn({ featuresOff: ["bisect_script"] }), false],
      [aiOn(), true],
    ];
    for (const [status, repoAiOff] of cases) {
      queryClient.clear();
      if (status) queryClient.setQueryData(qk.aiStatus, status);
      queryClient.setQueryData(qk.repoSettings(REPO), { aiOff: repoAiOff });
      expect(autopilot()!.hidden?.(ctx(REPO)), JSON.stringify({ status, repoAiOff })).toBe(true);
      expect(isAvailable(autopilot()!, ctx(REPO))).toBe(false);
    }
  });

  it("is unavailable while a run is going, with the reason, and available again once it has a result", () => {
    queryClient.setQueryData(qk.bisectAutopilot(REPO), run("testing"));
    expect(isAvailable(autopilot()!, ctx(REPO))).toBe(false);
    expect(autopilot()!.disabledReason?.(ctx(REPO))).toBe("The bisect autopilot is already running");
    queryClient.setQueryData(qk.bisectAutopilot(REPO), run("found"));
    expect(isAvailable(autopilot()!, ctx(REPO))).toBe(true);
  });

  it("starts the autopilot for the repository of the tab without preselected commits", async () => {
    await autopilot()!.run(ctx(REPO));
    expect(started).toEqual([[REPO, [], "tab-1"]]);
  });
});
