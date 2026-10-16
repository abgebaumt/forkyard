import { describe, expect, it } from "vitest";
import type { AiCliFound, AiDetection, AiProviderKind } from "../../core";
import { canLeaveModel, canLeaveProvider, draftFromPick, EMPTY_DRAFT, isUsableCli, pickId, primaryAction, settingsPatch, setupOverview, whereKind } from "./setupModel";

const cli = (provider: AiProviderKind, patch: Partial<AiCliFound> = {}): AiCliFound => ({
  provider,
  path: `/home/lena/.local/bin/${provider === "claude_code" ? "claude" : provider}`,
  version: "1.0.0",
  source: "path",
  login: "logged_in",
  loginMethod: null,
  usesEnvKey: false,
  supported: true,
  problem: null,
  loginCommand: "tool login",
  ...patch,
});

const detection = (patch: Partial<AiDetection> = {}): AiDetection => ({ clis: [], local: [], keys: [], elapsedMs: 420, ...patch });

describe("AI setup (spec 1.3)", () => {
  it("exactly one signed-in tool: preselected, one click with the tool's default model and every function on", () => {
    const view = setupOverview(detection({ clis: [cli("claude_code", { loginMethod: "claude.ai" }), cli("codex", { login: "logged_out" }), cli("opencode", { supported: false, problem: "too old" })] }));
    expect(view.picks.map(pickId)).toEqual(["cli:claude_code"]);
    expect(view.preselected ? pickId(view.preselected) : null).toBe("cli:claude_code");
    expect(primaryAction(view.preselected)).toBe("turnOn");
    expect(view.nothingUsable).toBe(false);
    expect(settingsPatch(draftFromPick(view.preselected!))).toEqual({ aiEnabled: true, aiProvider: "claude_code", aiModel: null, aiFeaturesOff: [] });
  });

  it("two signed-in tools: nothing is chosen for the user", () => {
    const view = setupOverview(detection({ clis: [cli("claude_code"), cli("codex")] }));
    expect(view.picks.map(pickId)).toEqual(["cli:claude_code", "cli:codex"]);
    expect(view.preselected).toBeNull();
    expect(primaryAction(null)).toBeNull();
  });

  it("local models and stored keys are choices with a model step, after the tools", () => {
    const view = setupOverview(
      detection({
        clis: [cli("claude_code")],
        local: [
          { provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: ["qwen3:8b", "llama3.2:3b"] },
          { provider: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", models: [] },
        ],
        keys: ["gemini"],
      }),
    );
    expect(view.picks.map(pickId)).toEqual(["cli:claude_code", "local:ollama", "key:gemini"]);
    expect(view.preselected ? pickId(view.preselected) : null).toBe("cli:claude_code");
    const [, ollama, gemini] = view.picks;
    expect(primaryAction(ollama!)).toBe("continue");
    expect(draftFromPick(ollama!)).toEqual({ ...EMPTY_DRAFT, provider: "ollama", models: ["qwen3:8b", "llama3.2:3b"], model: "qwen3:8b", checked: true });
    expect(draftFromPick(gemini!)).toEqual({ ...EMPTY_DRAFT, provider: "gemini" });
  });

  it("nothing usable: offer a key, a local model or the cockpit only", () => {
    expect(setupOverview(detection()).nothingUsable).toBe(true);
    const signedOut = setupOverview(detection({ clis: [cli("claude_code", { login: "logged_out" }), cli("codex", { login: "unknown" })] }));
    expect(signedOut.picks).toEqual([]);
    expect(signedOut.nothingUsable).toBe(true);
    expect(isUsableCli(cli("codex", { login: "unknown" }))).toBe(false);
    expect(isUsableCli(cli("codex", { supported: false }))).toBe(false);
  });

  it("the provider step is left only after a successful check, the model step only with a model (tools keep their default)", () => {
    expect(canLeaveProvider(EMPTY_DRAFT)).toBe(false);
    expect(canLeaveProvider({ ...EMPTY_DRAFT, provider: "anthropic" })).toBe(false);
    expect(canLeaveProvider({ ...EMPTY_DRAFT, provider: "anthropic", checked: true })).toBe(true);
    expect(canLeaveModel({ ...EMPTY_DRAFT, provider: "codex" })).toBe(true);
    expect(canLeaveModel({ ...EMPTY_DRAFT, provider: "ollama", model: "  " })).toBe(false);
    expect(canLeaveModel({ ...EMPTY_DRAFT, provider: "ollama", model: "qwen3:8b" })).toBe(true);
  });

  it("writes the address only for providers that have one, trims the model and keeps switched-off functions", () => {
    expect(settingsPatch({ ...EMPTY_DRAFT, provider: "openai_compatible", baseUrl: " https://llm.firma.example/v1 ", model: " mistral-large-latest ", featuresOff: ["compose", "plan"] })).toEqual({
      aiEnabled: true,
      aiProvider: "openai_compatible",
      aiModel: "mistral-large-latest",
      aiFeaturesOff: ["compose", "plan"],
      aiBaseUrl: "https://llm.firma.example/v1",
    });
    expect(settingsPatch({ ...EMPTY_DRAFT, provider: "anthropic", baseUrl: "https://ignoriert.example", model: "claude-sonnet-5-5" })).not.toHaveProperty("aiBaseUrl");
    expect(settingsPatch({ ...EMPTY_DRAFT, provider: "codex", model: "   " }).aiModel).toBeNull();
  });

  it("says where the requests go", () => {
    const kinds: AiProviderKind[] = ["claude_code", "opencode", "ollama", "lmstudio", "anthropic", "openai_compatible"];
    expect(kinds.map(whereKind)).toEqual(["cli", "cli", "local", "local", "api", "api"]);
  });
});
