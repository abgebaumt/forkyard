import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AiStatus } from "../../core";
import { commandItems } from "../../screens/CommandPalette/sources";
import type { CommandContext } from "../commandTypes";
import { qk } from "../queries";
import { isAvailable } from "../registry";
import { commands } from "../commands/ai";

const status = (patch: Partial<AiStatus>): AiStatus => ({
  state: "unset",
  provider: null,
  model: null,
  connected: false,
  keyHint: null,
  local: false,
  price: null,
  introPending: false,
  featuresOff: [],
  ...patch,
});

function ctxWith(value: AiStatus | undefined): CommandContext {
  const queryClient = new QueryClient();
  if (value) queryClient.setQueryData(qk.aiStatus, value);
  return { platform: "linux", tabs: [], tab: null, tabId: null, repoId: null, view: null, status: undefined, store: {} as CommandContext["store"], queryClient, source: "palette" };
}

const setup = commands.find((command) => command.id === "ai.setup");

describe("palette command “Set up AI …”", () => {
  it.each([
    ["unset", false, true],
    ["off", false, false],
    ["on", false, true],
    ["on", true, false],
  ] as const)("state %s, connected %s → offered %s", (state, connected, offered) => {
    const ctx = ctxWith(status({ state, connected }));
    expect(setup).toBeDefined();
    expect(isAvailable(setup!, ctx)).toBe(offered);
    expect(commandItems([setup!], ctx, (command) => isAvailable(command, ctx))).toHaveLength(offered ? 1 : 0);
  });

  it("is hidden until the status is known", () => {
    expect(isAvailable(setup!, ctxWith(undefined))).toBe(false);
  });
});
