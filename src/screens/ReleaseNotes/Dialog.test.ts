import { describe, expect, it, vi } from "vitest";

const signInInTerminal = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../app/ai/cliLogin", () => ({ signInInTerminal }));

import { signInFor } from "./Dialog";

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
