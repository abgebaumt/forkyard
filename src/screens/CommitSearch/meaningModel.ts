/**
 * Pure helpers of the search by meaning (spec 9.2): when Enter runs a search, how the reason of a
 * hit reads, what the note about the way and the "searched for" line say.
 */
import type { AiPreview, AiSemanticHit, AiSemanticResult, AiSemanticStatus, CoreError } from "../../core";
import { toCoreError } from "../../app/errors";
import { locale, t } from "../../i18n";

export type SearchMode = "text" | "meaning";

/** Enter: a new question runs the search; the question already shown jumps through its hits. */
export function enterAction(text: string, submitted: string | null, running: boolean): "run" | "jump" | "none" {
  const question = text.trim();
  if (!question) return "none";
  if (question !== submitted) return "run";
  return running ? "none" : "jump";
}

/** The model's reason, otherwise the similarity in percent and the words of the question in the subject. */
export function hitReason(hit: AiSemanticHit, lang = locale()): string {
  if (hit.reason) return hit.reason;
  if (hit.score === null) return t("commitSearch.meaning.fromSearch");
  const percent = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(Math.max(0, Math.min(1, hit.score)));
  return hit.matchedTerms.length > 0 ? t("commitSearch.meaning.similarWith", { percent, terms: hit.matchedTerms.join(", ") }) : t("commitSearch.meaning.similar", { percent });
}

/** Which way the search goes and how many commits the index has. */
export function routeNote(status: AiSemanticStatus | null | undefined): string {
  if (!status) return "";
  if (status.route === "rephrase") return t("commitSearch.meaning.routeRephrase");
  const provider = status.provider ? t(`ai.providers.${status.provider}`) : "";
  const route = t("commitSearch.meaning.routeEmbeddings", { provider, model: status.model ?? "" });
  return status.used ? `${route} ${t("commitSearch.meaning.indexed", { count: status.indexed })}` : route;
}

/** Rephrase route: the terms and filters the search ran with; `null` for the embedding routes. */
export function searchedFor(result: AiSemanticResult): string | null {
  if (result.route !== "rephrase") return null;
  const parts = result.terms.map((text) => t("commitSearch.meaning.quoted", { text }));
  const filters = result.filters;
  if (filters?.pickaxe) parts.push(t("commitSearch.meaning.code", { text: filters.pickaxe }));
  for (const path of filters?.paths ?? []) parts.push(t("commitSearch.meaning.path", { text: path }));
  if (result.author) parts.push(t("commitSearch.meaning.author", { text: result.author }));
  if (filters?.since) parts.push(t("commitSearch.meaning.since", { date: filters.since }));
  if (filters?.until) parts.push(t("commitSearch.meaning.until", { date: filters.until }));
  return parts.length > 0 ? t("commitSearch.meaning.searchedFor", { parts: parts.join(", ") }) : null;
}

export interface MeaningDeps {
  preview(): Promise<AiPreview>;
  /** The send gate: asks only when the preview has triggers (1a `confirmSend`). */
  confirm(preview: AiPreview): Promise<boolean>;
  search(): Promise<AiSemanticResult>;
}

export type MeaningOutcome =
  | { kind: "done"; result: AiSemanticResult }
  | { kind: "declined" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: CoreError }
  | { kind: "stale" };

/** One search: "What is sent?" → confirmation → search. `current() === false`: a newer run or "Cancel" – the answer is dropped. */
export async function runMeaning(deps: MeaningDeps, current: () => boolean): Promise<MeaningOutcome> {
  try {
    const preview = await deps.preview();
    if (!current()) return { kind: "stale" };
    const send = await deps.confirm(preview);
    if (!current()) return { kind: "stale" };
    if (!send) return { kind: "declined" };
    const result = await deps.search();
    return current() ? { kind: "done", result } : { kind: "stale" };
  } catch (raw) {
    if (!current()) return { kind: "stale" };
    const error = toCoreError(raw);
    return error.code === "cancelled" ? { kind: "cancelled" } : { kind: "failed", error };
  }
}
