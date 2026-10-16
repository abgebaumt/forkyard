/**
 * The states every AI element shows (spec "Zustände jedes KI-Elements"), as a pure model so every
 * function renders the same words: while loading the button becomes "Cancel" and the text counts
 * seconds from 3 s, after 30 s a hint says local models take longer / the provider is slow; errors
 * map to the inline states (never a toast for an unreachable local service). Texts: `ai.state.*`.
 */
import { t } from "../../i18n";
import { describeError, toCoreError } from "../errors";

export const COUNTER_FROM_MS = 3_000;
export const SLOW_FROM_MS = 30_000;

export interface AiLoadingView {
  text: string;
  slow: string | null;
}

export function loadingView(elapsedMs: number, local: boolean, label: string = t("ai.state.loading")): AiLoadingView {
  const elapsed = Math.max(0, elapsedMs);
  const text = elapsed >= COUNTER_FROM_MS ? t("ai.state.loadingFor", { label, seconds: Math.floor(elapsed / 1000) }) : label;
  const slow = elapsed > SLOW_FROM_MS ? (local ? t("ai.state.slowLocal") : t("ai.state.slowRemote")) : null;
  return { text, slow };
}

export type AiErrorView =
  | { kind: "cancelled" }
  | { kind: "setup"; text: string }
  | { kind: "unavailable"; text: string; retryAt: string | null }
  | { kind: "notLoggedIn"; text: string }
  | { kind: "invalid"; text: string }
  | { kind: "tooLarge"; text: string }
  | { kind: "limit"; text: string }
  | { kind: "refused"; text: string }
  | { kind: "other"; text: string };

export function errorView(error: unknown): AiErrorView {
  const e = toCoreError(error);
  switch (e.code) {
    case "cancelled":
      return { kind: "cancelled" };
    case "ai_not_configured":
      return { kind: "setup", text: e.message };
    case "ai_provider_unavailable":
    case "offline":
    case "timeout":
      return { kind: "unavailable", text: e.message, retryAt: e.retryAt };
    case "ai_not_logged_in":
      return { kind: "notLoggedIn", text: e.message };
    case "ai_invalid_answer":
      return { kind: "invalid", text: t("ai.state.invalid") };
    case "ai_too_large":
      return { kind: "tooLarge", text: e.message };
    case "ai_limit_reached":
      return { kind: "limit", text: e.message };
    case "ai_refused":
      return { kind: "refused", text: e.message };
    default:
      return { kind: "other", text: describeError(e).text };
  }
}
