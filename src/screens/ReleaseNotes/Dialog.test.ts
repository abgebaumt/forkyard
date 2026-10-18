import { describe, expect, it, vi } from "vitest";

const signInInTerminal = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../app/ai/cliLogin", () => ({ signInInTerminal }));
const open = vi.hoisted(() => ({ openAiSetup: vi.fn(async () => true), openAiSettings: vi.fn() }));
vi.mock("../../app/ai/open", () => open);
const showDialog = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../app/dialogs", () => ({ showDialog }));
const aiStatus = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../app/actions/context", () => ({ cachedAiStatus: () => aiStatus.current, short: (sha: string) => sha.slice(0, 7) }));

import { openReleaseNotes, setupFor, signInFor } from "./Dialog";

describe("release notes dialog: “Sign in in the terminal”", () => {
  it("is offered only for the terminal tools, not for API or local providers", () => {
    for (const provider of ["claude_code", "codex", "opencode"] as const) expect(signInFor(provider, () => undefined), provider).toBeTypeOf("function");
    for (const provider of ["anthropic", "openai", "openai_compatible", "gemini", "ollama", "lmstudio", null] as const) expect(signInFor(provider, () => undefined), String(provider)).toBeUndefined();
  });

  it("closes the dialog before it opens the sign-in, because the terminal sits behind it", () => {
    const order: string[] = [];
    signInInTerminal.mockImplementation(() => {
      order.push("signIn");
      return true;
    });
    signInFor("codex", () => order.push("close"))!();
    expect(order).toEqual(["close", "signIn"]);
    expect(signInInTerminal).toHaveBeenCalledWith("codex");
  });
});

describe("release notes: AI on without a provider (spec 1.3, visibility table)", () => {
  it("opens the first-time setup, not Settings › AI", async () => {
    aiStatus.current = { state: "on", connected: false };
    await openReleaseNotes("repo-1", { kind: "tag", name: "v1.2.0" });
    expect(open.openAiSetup).toHaveBeenCalledTimes(1);
    expect(open.openAiSettings).not.toHaveBeenCalled();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it("the setup button of the writer closes the dialog first, then opens the setup", () => {
    const order: string[] = [];
    open.openAiSetup.mockImplementation(async () => {
      order.push("setup");
      return true;
    });
    setupFor(() => order.push("close"))();
    expect(order).toEqual(["close", "setup"]);
    expect(open.openAiSettings).not.toHaveBeenCalled();
  });
});
