/** Pure helpers of Settings › AI (provider kinds, patterns, amounts, own prices). */
import type { AiFeature, AiPriceOverride, AiProviderKind } from "../../../core";

/** In the order of the provider menu. */
export const PROVIDERS: AiProviderKind[] = ["anthropic", "openai", "gemini", "openai_compatible", "ollama", "lmstudio"];

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
