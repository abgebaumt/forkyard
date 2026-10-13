/**
 * Issues of the connected host (GitHub Issues, GitLab Issues) – via the host's public REST API,
 * with the user's token. The core makes the call; here are the shapes the UI works with, and the
 * one place that calls the core for them.
 *
 * The core is authoritative. What it returns is brought into a fixed shape here once, so that
 * list and detail view do not have to reckon with "field missing" everywhere.
 *
 * Jira and Trello are not integrated (separate accounts and interfaces).
 */
import { core, CoreError, type Id } from "../../core";
import { toUser, type HostUser } from "../../app/actions/hostTypes";
import { t } from "../../i18n";

export type IssueState = "open" | "closed";
export type IssueListState = IssueState | "all";

export interface IssueSummary {
  /** Number at the host (GitLab: the number within the project, "iid"). */
  number: number;
  /** How the issue is displayed: "#12". */
  key: string;
  title: string;
  state: IssueState;
  author: HostUser | null;
  assignees: HostUser[];
  labels: string[];
  updatedAt: string | null;
  webUrl: string | null;
  /** Number of comments, if the core reports it in the list. */
  commentCount: number | null;
}

export interface IssueComment {
  id: string;
  author: HostUser | null;
  body: string;
  createdAt: string | null;
}

export interface IssueDetails extends IssueSummary {
  /** Markdown from the host – untrusted, only show sanitised. */
  body: string;
  createdAt: string | null;
  comments: IssueComment[];
}

/** This many issues per page are requested by the UI. */
export const ISSUE_PAGE_SIZE = 30;
/** Only if the core does not report the next page: if fewer than this arrive, it was the last page. */
export const ISSUE_PAGE_MIN = 20;

export interface IssuePage {
  items: IssueSummary[];
  /** Number of the next page; null = that was the last one. */
  nextPage: number | null;
}

export interface IssueFilter {
  state: IssueListState;
  /** Search text; empty = all. */
  query: string;
}

// ---------------------------------------------------------------------------
// Reading what the core returns
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const notNull = <T,>(value: T | null): value is T => value !== null;

const toLabel = (value: unknown): string | null => (isObject(value) ? text(value.name ?? value.title) : text(value));

export function toIssueSummary(value: unknown): IssueSummary | null {
  if (!isObject(value)) return null;
  const raw = value.number ?? value.iid;
  const number = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(number)) return null;
  const comments = value.commentCount ?? (typeof value.comments === "number" ? value.comments : null);
  return {
    number,
    key: text(value.key) ?? `#${number}`,
    title: text(value.title) ?? "",
    state: value.state === "closed" ? "closed" : "open",
    author: toUser(value.author),
    assignees: list(value.assignees).map(toUser).filter(notNull),
    labels: list(value.labels).map(toLabel).filter(notNull),
    updatedAt: text(value.updatedAt),
    webUrl: text(value.webUrl),
    commentCount: typeof comments === "number" ? comments : null,
  };
}

function toComment(value: unknown, index: number): IssueComment | null {
  if (!isObject(value)) return null;
  return { id: text(value.id) ?? `kommentar-${index}`, author: toUser(value.author), body: text(value.body) ?? "", createdAt: text(value.createdAt) };
}

export function toIssueDetails(value: unknown): IssueDetails | null {
  const summary = toIssueSummary(value);
  if (!summary || !isObject(value)) return null;
  const comments = list(value.comments).map(toComment).filter(notNull);
  return {
    ...summary,
    commentCount: summary.commentCount ?? comments.length,
    body: text(value.body) ?? "",
    createdAt: text(value.createdAt),
    comments,
  };
}

/**
 * One page of the list. The core names the next page (`nextPage`); if it only returns the
 * entries, a short page counts as the last one.
 */
export function toIssuePage(value: unknown, page: number): IssuePage {
  if (Array.isArray(value)) {
    const items = value.map(toIssueSummary).filter(notNull);
    return { items, nextPage: value.length < ISSUE_PAGE_MIN ? null : page + 1 };
  }
  if (!isObject(value)) return { items: [], nextPage: null };
  const next = value.nextPage;
  return { items: list(value.items).map(toIssueSummary).filter(notNull), nextPage: typeof next === "number" && next > page ? next : null };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const issueApi = {
  /** Page 1 first, most recently changed on top. `nextPage: null` means end. */
  list: async (repoId: Id, filter: IssueFilter, page: number): Promise<IssuePage> => toIssuePage(await core.issueList({ repoId, state: filter.state, query: filter.query.trim() || null, page, perPage: ISSUE_PAGE_SIZE }), page),
  get: async (repoId: Id, number: number): Promise<IssueDetails> => {
    const details = toIssueDetails(await core.issueGet({ repoId, number }));
    if (!details) throw new CoreError({ code: "unknown", message: t("issues.unexpected"), gitOutput: null });
    return details;
  },
};
