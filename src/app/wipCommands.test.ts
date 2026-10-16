import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus, RepoSettings, Status } from "../core";
import type { CommandContext } from "./commandTypes";

const toggled: string[] = [];
const previews: unknown[][] = [];
vi.mock("../screens/WipPanel/actions", () => ({ commitChanges: vi.fn(), discardEverything: vi.fn(), stageEverything: vi.fn(), unstageEverything: vi.fn() }));
vi.mock("../screens/WipPanel/aiDraftActions", () => ({
  toggleWriteMessage: (repoId: string) => {
    toggled.push(repoId);
    return Promise.resolve();
  },
}));
vi.mock("./ai/gate", () => ({
  showWhatIsSent: (...args: unknown[]) => {
    previews.push(args);
    return Promise.resolve();
  },
}));

const { qk } = await import("./queries");
const { getCommands, isAvailable } = await import("./registry");
const { commandItems } = await import("../screens/CommandPalette/sources");
const { commands } = await import("./commands/wip");

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

function ctxWith({ ai, aiOff = false, staged = 1, repo = true }: { ai?: AiStatus; aiOff?: boolean; staged?: number; repo?: boolean }): CommandContext {
  const queryClient = new QueryClient();
  if (ai) queryClient.setQueryData(qk.aiStatus, ai);
  queryClient.setQueryData(qk.repoSettings(REPO), { aiOff } as RepoSettings);
  const status = { staged: Array.from({ length: staged }, (_, index) => ({ path: `f${index}.txt` })), unstaged: [], conflicted: [], operation: null } as unknown as Status;
  return { platform: "linux", tabs: [], tab: null, tabId: repo ? "tab-1" : null, repoId: repo ? REPO : null, view: null, status, store: {} as CommandContext["store"], queryClient, source: "palette" };
}

const write = commands.find((command) => command.id === "wip.writeMessage")!;
const preview = commands.find((command) => command.id === "wip.writeMessagePreview")!;

beforeEach(() => {
  toggled.length = 0;
  previews.length = 0;
});

describe("palette: write commit message (spec 3.1)", () => {
  it("is Mod+Shift+M and toggles Write in the commit form", async () => {
    expect(write.shortcut).toBe("Mod+Shift+M");
    const owners = getCommands().filter((command) => command.shortcut === "Mod+Shift+M" || command.aliases?.includes("Mod+Shift+M")).map((command) => command.id);
    expect(owners, "the shortcut is free (Alt+M stays focus.commitMessage)").toEqual(["wip.writeMessage"]);
    const ctx = ctxWith({ ai: aiOn() });
    expect(isAvailable(write, ctx)).toBe(true);
    await write.run(ctx);
    expect(toggled).toEqual([REPO]);
  });

  it.each([
    ["AI is not set up", { ai: aiOn({ state: "unset", connected: false }) }],
    ["AI is off", { ai: aiOn({ state: "off" }) }],
    ["the function is off", { ai: aiOn({ featuresOff: ["commit_message"] }) }],
    ["AI is off for this repository", { ai: aiOn(), aiOff: true }],
    ["no repository is open", { ai: aiOn(), repo: false }],
    ["the AI status is not known yet", {}],
  ] as const)("is hidden when %s", (_name, options) => {
    const ctx = ctxWith(options);
    for (const command of [write, preview]) {
      expect(isAvailable(command, ctx)).toBe(false);
      expect(commandItems([command], ctx, (item) => isAvailable(item, ctx))).toHaveLength(0);
    }
  });

  it("is greyed out with “Nothing staged” without staged changes", () => {
    const ctx = ctxWith({ ai: aiOn(), staged: 0 });
    expect(isAvailable(write, ctx)).toBe(false);
    expect(write.disabledReason?.(ctx)).toBe("Nothing staged");
    expect(commandItems([write], ctx, (item) => isAvailable(item, ctx))).toHaveLength(1);
  });

  it("stays offered while the provider is missing – the commit form then opens the setup", () => {
    expect(isAvailable(write, ctxWith({ ai: aiOn({ connected: false, provider: null }) }))).toBe(true);
  });

  it("“What is sent?” shows the commit message's text", async () => {
    await preview.run(ctxWith({ ai: aiOn() }));
    expect(previews).toEqual([[REPO, "commit_message", { kind: "commit_message" }]]);
  });
});
