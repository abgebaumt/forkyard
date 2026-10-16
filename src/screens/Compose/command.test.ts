import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AiStatus, RepoSettings, Status } from "../../core";
import type { CommandContext } from "../../app/commandTypes";
import { qk } from "../../app/queries";
import { commands } from "../../app/commands/compose";

const command = commands.find((c) => c.id === "wip.compose")!;

const ai = (patch: Partial<AiStatus> = {}): AiStatus => ({
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

function ctx({ status = ai(), aiOff = false, changes = 1, repoId = "r1" }: { status?: AiStatus; aiOff?: boolean; changes?: number; repoId?: string | null } = {}): CommandContext {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.aiStatus, status);
  if (repoId) queryClient.setQueryData(qk.repoSettings(repoId), { aiOff } as RepoSettings);
  const repoStatus = { staged: [], unstaged: Array.from({ length: changes }, (_, i) => ({ path: `f${i}.txt` })) } as unknown as Status;
  return { platform: "linux", tabs: [], tab: null, tabId: "t1", repoId, view: null, status: repoStatus, store: {} as CommandContext["store"], queryClient, source: "palette" };
}

describe("palette command “Compose commits …”", () => {
  it("is hidden wherever the AI element is hidden (spec 1.3)", () => {
    expect(command.hidden!(ctx())).toBe(false);
    expect(command.hidden!(ctx({ status: ai({ connected: false }) })), "shown; it opens the setup").toBe(false);
    expect(command.hidden!(ctx({ status: ai({ state: "unset", connected: false }) }))).toBe(true);
    expect(command.hidden!(ctx({ status: ai({ state: "off" }) }))).toBe(true);
    expect(command.hidden!(ctx({ status: ai({ featuresOff: ["compose"] }) }))).toBe(true);
    expect(command.hidden!(ctx({ aiOff: true })), "AI off for this repository").toBe(true);
    expect(command.hidden!(ctx({ repoId: null })), "no repository").toBe(true);
  });

  it("needs changes and says so", () => {
    expect(command.when!(ctx())).toBe(true);
    const none = ctx({ changes: 0 });
    expect(command.when!(none)).toBe(false);
    expect(command.disabledReason!(none)).toBe("No changes");
    expect(command.disabledReason!(ctx())).toBeNull();
  });

  it("is a Commit command without a shortcut, found by compose and split", () => {
    expect(command.group).toBe("Commit");
    expect(command.shortcut).toBeUndefined();
    expect(command.title).toBe("Compose commits …");
    expect(command.keywords).toEqual(expect.arrayContaining(["compose", "split"]));
  });
});
