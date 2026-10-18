/**
 * Pure helpers of the push check (v1.2, spec 6.2): the dialog of the local secret scan
 * ("Looks like a key") and the result of the AI review before a push.
 */
import type { AiPushFindingKind, AiPushReview, AiStatus, RepoSettings, SecretFinding, SecretRule } from "../../core";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { t } from "../../i18n";

/** The fields of the push result `secrets_found`. */
export interface SecretsFound {
  findings: SecretFinding[];
  commits: number;
  partial: boolean;
}

export interface SecretRow {
  id: string;
  location: string;
  rule: string;
  excerpt: string;
  commit: string;
}

export interface ReviewRow {
  key: string;
  location: string;
  kind: string;
  note: string;
}

const RULES: Record<SecretRule, string> = {
  known_token: t("pushCheck.secrets.rule.knownToken"),
  private_key: t("pushCheck.secrets.rule.privateKey"),
  credential: t("pushCheck.secrets.rule.credential"),
  url_password: t("pushCheck.secrets.rule.urlPassword"),
  high_entropy: t("pushCheck.secrets.rule.highEntropy"),
};

const KINDS: Record<AiPushFindingKind, string> = {
  debug_output: t("pushCheck.review.kind.debugOutput"),
  commented_code: t("pushCheck.review.kind.commentedCode"),
  likely_bug: t("pushCheck.review.kind.likelyBug"),
};

type Place = { path: string; line: number | null };

/** Code-unit order (like Git's byte order for ASCII), then line; no locale rules. */
const byPlace = (a: Place, b: Place): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0));

export const findingLocation = (finding: Place): string => (finding.line ? `${finding.path}:${finding.line}` : finding.path);
export const ruleLabel = (rule: SecretRule): string => RULES[rule];
export const kindLabel = (kind: AiPushFindingKind): string => KINDS[kind];

export function secretRows(findings: SecretFinding[]): SecretRow[] {
  return [...findings].sort(byPlace).map((finding) => ({
    id: finding.id,
    location: findingLocation(finding),
    rule: ruleLabel(finding.rule),
    excerpt: finding.excerpt,
    commit: finding.commit.slice(0, 7),
  }));
}

export const secretsTitle = (count: number): string => t("pushCheck.secrets.title", { count });

export function secretsNotes(found: SecretsFound): string[] {
  const notes = [t("pushCheck.secrets.scanned", { count: found.commits })];
  if (found.partial) notes.push(t("pushCheck.secrets.partial"));
  return notes;
}

/** What "Push anyway" accepts: every finding the dialog showed (the core checks them again). */
export const acceptedIds = (findings: SecretFinding[]): string[] => [...new Set(findings.map((finding) => finding.id))];

/** Findings the user has not marked "Don't report again" in this dialog. */
export const stillReported = (findings: SecretFinding[], ignored: ReadonlySet<string>): SecretFinding[] => findings.filter((finding) => !ignored.has(finding.id));

export function reviewRows(review: AiPushReview): ReviewRow[] {
  return [...review.findings].sort(byPlace).map((finding, index) => ({
    key: `${finding.path}:${finding.line ?? ""}:${finding.kind}:${index}`,
    location: findingLocation(finding),
    kind: kindLabel(finding.kind),
    note: finding.note,
  }));
}

export function reviewSummary(review: AiPushReview): string {
  if (review.commits === 0) return t("pushCheck.review.nothing");
  const head = review.findings.length ? t("pushCheck.review.found", { count: review.findings.length }) : t("pushCheck.review.none");
  return `${head} · ${t("pushCheck.review.commits", { count: review.commits })}`;
}

/** "Push" only after a review without findings; otherwise "Push anyway" – always possible. */
export const reviewPushLabel = (phase: "loading" | "done" | "error", findings: number): string =>
  phase === "done" && findings === 0 ? t("pushCheck.review.push") : t("pushCheck.review.pushAnyway");

type ReviewRepo = Pick<RepoSettings, "aiOff" | "aiReviewBeforePush">;

/** "Review and push …" appears (menu, palette) exactly where the function is visible (1a, 1.3). */
export const reviewOffered = (status: AiStatus | null | undefined, repo: ReviewRepo | null | undefined): boolean => featureVisible(status, "push_review", repo?.aiOff ?? false);

/**
 * A normal push reviews first: the project opted in, the function is visible here and the provider
 * is connected. Without a provider the review cannot run, so the normal push stays a plain push
 * (pushing must always be possible); only the explicit "Review and push …" opens the setup.
 */
export const reviewFirst = (status: AiStatus | null | undefined, repo: ReviewRepo | null | undefined): boolean =>
  Boolean(repo?.aiReviewBeforePush) && reviewOffered(status, repo) && !aiVisibility(status).elementsOpenSetup;
