/** Settings › AI › Search by meaning: the embedder choice, model hints, the index line. */
import type { AiSemanticStatus, Settings } from "../../../core";
import { t } from "../../../i18n";

export type EmbedChoice = "main" | "ollama" | "lmstudio";
export const EMBED_CHOICES: EmbedChoice[] = ["main", "ollama", "lmstudio"];

export function embedChoice(settings: Pick<Settings, "aiSearchEmbedProvider">): EmbedChoice {
  const provider = settings.aiSearchEmbedProvider;
  return provider === "ollama" || provider === "lmstudio" ? provider : "main";
}

/** Another embedder: model and address of the previous one no longer apply. */
export function embedChoicePatch(choice: EmbedChoice): Pick<Settings, "aiSearchEmbedProvider" | "aiSearchEmbedModel" | "aiSearchEmbedBaseUrl"> {
  return { aiSearchEmbedProvider: choice === "main" ? null : choice, aiSearchEmbedModel: null, aiSearchEmbedBaseUrl: null };
}

/** An example (local) or the default the core uses (OpenAI, Gemini); empty where there is none. */
export function embedModelPlaceholder(settings: Pick<Settings, "aiSearchEmbedProvider" | "aiProvider">): string {
  const choice = embedChoice(settings);
  if (choice === "ollama") return "nomic-embed-text";
  if (choice === "lmstudio") return "text-embedding-nomic-embed-text-v1.5";
  if (settings.aiProvider === "openai") return "text-embedding-3-small";
  if (settings.aiProvider === "gemini") return "gemini-embedding-001";
  return "";
}

export function indexText(status: AiSemanticStatus | null | undefined, hasRepo: boolean): string {
  if (!hasRepo) return t("ai.search.index.noRepo");
  if (!status) return "";
  if (status.route === "rephrase") return t("ai.search.index.rephrase");
  if (!status.used) return t("ai.search.index.none");
  return t("ai.search.index.count", { count: status.indexed, model: status.model ?? "" });
}
