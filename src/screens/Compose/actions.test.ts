import { describe, expect, it, vi } from "vitest";

const openAiSetup = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
vi.mock("../../app/ai/open", () => ({ openAiSettings: vi.fn(), openAiSetup: () => openAiSetup() }));

import type { AiStatus, RepoSettings, Status } from "../../core";
import { qk, queryClient } from "../../app/queries";
import { getTabView, useAppStore } from "../../app/store";
import { closeCompose, composeVisible, hasChanges, openCompose, startCompose } from "./actions";

const status = (patch: Partial<AiStatus> = {}): AiStatus => ({
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
const repo = (aiOff: boolean) => ({ aiOff }) as RepoSettings;

describe("Compose entry points", () => {
  it("are visible only with AI on, compose on and the repository not opted out", () => {
    expect(composeVisible(status(), repo(false))).toBe(true);
    expect(composeVisible(status({ connected: false }), repo(false)), "a click opens the setup").toBe(true);
    expect(composeVisible(status({ state: "unset", connected: false }), repo(false))).toBe(false);
    expect(composeVisible(status({ state: "off" }), repo(false))).toBe(false);
    expect(composeVisible(status({ featuresOff: ["compose"] }), repo(false))).toBe(false);
    expect(composeVisible(status(), repo(true))).toBe(false);
    expect(composeVisible(undefined, undefined), "unknown status: hidden").toBe(false);
  });

  it("need staged, unstaged or untracked changes", () => {
    expect(hasChanges({ staged: [], unstaged: [] } as unknown as Status)).toBe(false);
    expect(hasChanges({ staged: [], unstaged: [{ path: "neu.txt" }] } as unknown as Status)).toBe(true);
    expect(hasChanges(undefined)).toBe(false);
  });

  it("open the view in the centre, or the AI setup while no provider is connected", () => {
    queryClient.setQueryData(qk.aiStatus, status());
    startCompose("tab-a");
    expect(getTabView("tab-a").center).toEqual({ kind: "compose" });
    closeCompose("tab-a");
    expect(getTabView("tab-a").center).toEqual({ kind: "graph" });

    queryClient.setQueryData(qk.aiStatus, status({ connected: false }));
    startCompose("tab-b");
    expect(getTabView("tab-b").center.kind).toBe("graph");
    expect(openAiSetup).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().overlay, "the setup is a dialog, not the settings overlay").toBeNull();
    openCompose("tab-b");
    expect(getTabView("tab-b").center).toEqual({ kind: "compose" });
  });
});
