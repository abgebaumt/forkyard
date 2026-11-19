/** AI provider kinds that several views ask about. */
import type { AiProviderKind } from "../../core";

/** The tools that run with the user's own sign-in (a CLI), not with a key. */
export type CliProvider = "claude_code" | "codex" | "opencode";
export const CLI_PROVIDERS: CliProvider[] = ["claude_code", "codex", "opencode"];
export const isCli = (provider: AiProviderKind): provider is CliProvider =>
  provider === "claude_code" || provider === "codex" || provider === "opencode";
