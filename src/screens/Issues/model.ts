/**
 * Pure functions around issues: branch name from number and title, filter, texts.
 */
import { formatRelative } from "../../app/format";
import { locale, t } from "../../i18n";
import type { IssueListState, IssueState, IssueSummary } from "./api";

/** Longest name part taken from the title; the number goes in front. */
const SLUG_LIMIT = 48;

const GERMAN: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", Ä: "Ae", Ö: "Oe", Ü: "Ue", ẞ: "SS" };

/**
 * Turns a title into a name part that Git and every shell accept without quotes: lower-case
 * letters, digits and hyphens. Umlauts are spelled out, other accents are dropped.
 * Shortened at a word boundary.
 */
export function slugify(title: string, limit = SLUG_LIMIT): string {
  const plain = title
    .replace(/[äöüßÄÖÜẞ]/g, (char) => GERMAN[char] ?? char)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  const lastDash = cut.lastIndexOf("-");
  // Cut in the middle of a word only if the first word alone is already too long.
  return (lastDash >= limit / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

/** Suggested branch for an issue: "<number>-<title-in-lower-case>". The user can change it. */
export function issueBranchName(issue: Pick<IssueSummary, "number" | "title">): string {
  const slug = slugify(issue.title);
  return slug ? `${issue.number}-${slug}` : `issue-${issue.number}`;
}

export const stateLabels: Record<IssueState, string> = { open: t("issues.state.open"), closed: t("issues.state.closed") };

export const listStateLabels: Record<IssueListState, string> = { open: t("issues.state.open"), closed: t("issues.state.closed"), all: t("issues.state.all") };

/** Whether the issue is assigned to the user with this login (case-insensitive). */
export function isAssignedTo(issue: Pick<IssueSummary, "assignees">, login: string | null | undefined): boolean {
  if (!login) return false;
  const wanted = login.toLowerCase();
  return issue.assignees.some((user) => user.login.toLowerCase() === wanted);
}

/** Match in the title, the number or a label – for the left panel's filter. */
export function matchesIssue(issue: IssueSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return issue.title.toLowerCase().includes(needle) || issue.key.toLowerCase().includes(needle) || String(issue.number) === needle.replace(/^#/, "") || issue.labels.some((label) => label.toLowerCase().includes(needle));
}

/** Second line of a list row: who, when, how many comments. */
export function issueSecondary(issue: IssueSummary): string {
  const parts: string[] = [];
  if (issue.author) parts.push(issue.author.login);
  if (issue.updatedAt) parts.push(formatRelative(issue.updatedAt));
  if (issue.commentCount) parts.push(t("issues.comments", { count: issue.commentCount }));
  return parts.join(" · ");
}

/** Full description of a row for screen readers. */
export function describeIssue(issue: IssueSummary): string {
  const parts = [t("issues.describe.title", { number: issue.number, title: issue.title || t("issues.describe.untitledLower") }), stateLabels[issue.state].toLowerCase()];
  if (issue.assignees.length) parts.push(t("issues.describe.assigned", { users: issue.assignees.map((user) => user.login).join(", ") }));
  if (issue.labels.length) parts.push(t("issues.describe.labels", { labels: issue.labels.join(", ") }));
  if (issue.updatedAt) parts.push(t("issues.describe.changed", { when: formatRelative(issue.updatedAt) }));
  return parts.join(", ");
}

/** Timestamps as the core states them in messages: ISO-8601 in UTC, e.g. `2026-10-11T14:32:05Z`. */
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

const clock = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" });
const dayAndClock = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

/** "2:32 PM" in local time – with the date if the moment is not today. */
export function localTime(iso: string, now = new Date()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return t("issues.time", { time: (sameDay ? clock : dayAndClock).format(date) });
}

/** Replaces timestamps in a core message (ISO, UTC) with local time – the way one reads them off a clock. */
export function localizeTimes(message: string, now = new Date()): string {
  return message.replace(ISO_TIME, (iso) => localTime(iso, now) ?? iso);
}

/** The time from a rate-limit message in local time ("2:32 PM"), if the core states one. */
export function retryTime(message: string, now = new Date()): string | null {
  const iso = message.match(ISO_TIME)?.[0];
  return iso ? localTime(iso, now) : null;
}
