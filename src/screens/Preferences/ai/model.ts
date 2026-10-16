/** Pure helpers of Settings › AI (provider kinds, patterns, amounts, own prices). */
import type { AiCliPaths, AiFeature, AiPriceOverride, AiProviderKind } from "../../../core";

/** In the order of the provider menu: the tools with the user's own sign-in first. */
export const PROVIDERS: AiProviderKind[] = ["claude_code", "codex", "opencode", "anthropic", "openai", "gemini", "openai_compatible", "ollama", "lmstudio"];

export type CliProvider = "claude_code" | "codex" | "opencode";
export const CLI_PROVIDERS: CliProvider[] = ["claude_code", "codex", "opencode"];
export const isCli = (provider: AiProviderKind): provider is CliProvider => provider === "claude_code" || provider === "codex" || provider === "opencode";

const CLI_PATH_FIELD: Record<CliProvider, keyof AiCliPaths> = { claude_code: "claudeCode", codex: "codex", opencode: "opencode" };
export const cliPathField = (provider: CliProvider): keyof AiCliPaths => CLI_PATH_FIELD[provider];

/** Sets the own path of one tool; blank = found automatically. */
export function withCliPath(paths: AiCliPaths, provider: CliProvider, value: string): AiCliPaths {
  return { ...paths, [CLI_PATH_FIELD[provider]]: value.trim() || null };
}

export const FEATURES: AiFeature[] = [
  "commit_message",
  "pr_description",
  "compose",
  "conflict_intent",
  "push_review",
  "plan",
  "archaeology",
  "release_notes",
  "bisect_script",
  "semantic_search",
  "review_fix",
];

export const needsKey = (provider: AiProviderKind) => provider === "anthropic" || provider === "openai" || provider === "gemini";
export const acceptsKey = (provider: AiProviderKind) => needsKey(provider) || provider === "openai_compatible";
export const usesBaseUrl = (provider: AiProviderKind) => provider === "openai_compatible" || provider === "ollama" || provider === "lmstudio";
export const isLocal = (provider: AiProviderKind) => provider === "ollama" || provider === "lmstudio";

/** One pattern per line; blank lines and doubles drop out (the core tidies up the same way). */
export function parsePatterns(text: string): string[] {
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const pattern = line.trim();
    if (pattern && !seen.has(pattern)) {
      seen.add(pattern);
      patterns.push(pattern);
    }
  }
  return patterns;
}

export const patternsText = (patterns: string[]) => patterns.join("\n");

/** "0,10", "0.10", "25 USD" → number; "" → null; anything else "invalid". */
export function parseUsd(text: string): number | null | "invalid" {
  const value = text.trim().replace(/\s*USD$/i, "").replace(",", ".");
  if (!value) return null;
  if (!/^\d+(\.\d+)?$/.test(value)) return "invalid";
  return Number(value);
}

export function featureToggle(off: AiFeature[], feature: AiFeature, on: boolean): AiFeature[] {
  const rest = off.filter((item) => item !== feature);
  return on ? rest : [...rest, feature].sort();
}

/** "input / output" in USD per million tokens. */
export function parsePricePair(text: string): { input: number; output: number } | null | "invalid" {
  const value = text.trim();
  if (!value) return null;
  const parts = value.split("/");
  if (parts.length !== 2) return "invalid";
  const input = parseUsd(parts[0] ?? "");
  const output = parseUsd(parts[1] ?? "");
  if (typeof input !== "number" || typeof output !== "number") return "invalid";
  return { input, output };
}

export function pricePairText(price: AiPriceOverride | undefined): string {
  return price ? `${price.inputUsdPerMtok} / ${price.outputUsdPerMtok}` : "";
}

export function withOwnPrice(prices: AiPriceOverride[], model: string, pair: { input: number; output: number } | null): AiPriceOverride[] {
  const rest = prices.filter((price) => price.model !== model);
  return pair ? [...rest, { model, inputUsdPerMtok: pair.input, outputUsdPerMtok: pair.output }] : rest;
}
