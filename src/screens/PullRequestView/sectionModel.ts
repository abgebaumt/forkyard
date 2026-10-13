import type { PrSummary } from "../../app/actions/hostTypes";
import { t } from "../../i18n";

export type PrGroup = "mine" | "review" | "all";

export const PR_GROUPS: PrGroup[] = ["mine", "review", "all"];

export const groupLabels: Record<PrGroup, { label: string; hint: string; empty: string }> = {
  mine: { label: t("pullRequest.view.groups.mine"), hint: t("pullRequest.view.groups.mineHint"), empty: t("pullRequest.view.groups.mineEmpty") },
  review: { label: t("pullRequest.view.groups.review"), hint: t("pullRequest.view.groups.reviewHint"), empty: t("pullRequest.view.groups.reviewEmpty") },
  all: { label: t("pullRequest.view.groups.all"), hint: t("pullRequest.view.groups.allHint"), empty: t("pullRequest.view.groups.allEmpty") },
};

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * Splits the open pull requests. "To review": by someone else, not a draft, and the host reports a
 * requested, still open review. Without a known own name none counts as "mine".
 */
export function groupPrs(prs: PrSummary[], me: string | null): Record<PrGroup, PrSummary[]> {
  const open = prs.filter((pr) => pr.state === "open");
  return {
    mine: open.filter((pr) => same(pr.author?.login, me)),
    review: open.filter((pr) => !same(pr.author?.login, me) && !pr.isDraft && pr.reviewState === "review_required"),
    all: open,
  };
}

/** The panel's filter: number (also with #), title, author, source and target branch, label. */
export function matchesPr(pr: PrSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [`#${pr.number}`, pr.title, pr.author?.login ?? "", pr.author?.name ?? "", pr.sourceBranch, pr.targetBranch, ...pr.labels];
  return haystack.some((part) => part.toLowerCase().includes(needle));
}
