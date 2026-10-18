/**
 * Pure helpers of the search by meaning (spec 9.2): when Enter runs a search, how the reason of a
 * hit reads, what the note about the way and the "searched for" line say.
 */
import type { AiSemanticHit, AiSemanticResult, AiSemanticStatus } from "../../core";
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
