/** Texts of "What is sent?": costs (always "about", spec 1.5), triggers, reasons. */
import type { AiAskTrigger, AiOmitReason, AiPreview } from "../../core";
import { locale, t } from "../../i18n";

const money = (value: number, lang: string) => new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

/** An estimate: "about 0.03 USD"; below one cent "under 0.01 USD". */
export function formatUsd(value: number, lang = locale()): string {
  if (value < 0.01) return t("ai.cost.under", { amount: money(0.01, lang) });
  return t("ai.cost.about", { amount: money(value, lang) });
}

/** An amount the user set (limit): "10.00 USD". */
export function formatUsdExact(value: number, lang = locale()): string {
  return t("ai.cost.exact", { amount: money(value, lang) });
}

/** "Don't ask again" exists only for size and cost; first use and repository are remembered anyway, the limit never. */
export const offersDontAskAgain = (asks: AiAskTrigger[]) => asks.some((ask) => ask === "large" || ask === "cost");

export function askLines(preview: AiPreview, lang = locale()): string[] {
  const numbers = new Intl.NumberFormat(lang);
  return preview.asks.map((ask) => {
    switch (ask) {
      case "first_use":
        return t("ai.preview.ask.firstUse");
      case "large":
        return t("ai.preview.ask.large", { chars: numbers.format(preview.chars) });
      case "cost":
        return t("ai.preview.ask.cost", { cost: formatUsd(preview.estimatedCostUsd ?? 0, lang) });
      case "repo_first":
        return t("ai.preview.ask.repoFirst");
      case "limit":
        return t("ai.preview.ask.limit", { spent: formatUsd(preview.monthCostUsd, lang), limit: formatUsdExact(preview.limitUsd ?? 0, lang) });
    }
  });
}

const REASONS: Record<AiOmitReason, string> = {
  secret: t("ai.preview.reason.secret"),
  ignored: t("ai.preview.reason.ignored"),
  generated: t("ai.preview.reason.generated"),
  binary: t("ai.preview.reason.binary"),
  budget: t("ai.preview.reason.budget"),
};

export const omittedReason = (reason: AiOmitReason) => REASONS[reason];

export function sizeLine(preview: AiPreview, lang = locale()): string {
  const numbers = new Intl.NumberFormat(lang);
  return t("ai.preview.size", { chars: numbers.format(preview.chars), tokens: numbers.format(preview.estimatedTokens) });
}
