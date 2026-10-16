/**
 * Host integration (GitHub, GitLab, Gitea/Forgejo, Bitbucket Cloud, Azure DevOps via their public REST APIs, with the user's token):
 * the shapes the UI works with, and the one place that calls the core for it.
 *
 * The core is authoritative. What it returns is brought into a fixed shape here once
 * (`to…` functions), so that screens and actions don't have to reckon with "field missing" or
 * "name as text instead of object" everywhere. The token itself never comes back: the core
 * stores it in the system keychain and reveals at most the last characters (`tokenHint`).
 */
import { core, CoreError, EMPTY_TREE_SHA, type Id, type Sha, type Status } from "../../core";
import { locale, t } from "../../i18n";

export type HostKind = "github" | "gitlab" | "gitea" | "bitbucket" | "azure_devops";

/** In the order the app offers them. */
export const HOST_KINDS: HostKind[] = ["github", "gitlab", "gitea", "bitbucket", "azure_devops"];

export const hostKindLabels: Record<HostKind, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea/Forgejo", bitbucket: "Bitbucket", azure_devops: "Azure DevOps" };

/** What the host calls the thing – GitLab speaks of merge requests. The app uniformly says pull request. */
export const hostPrWord: Record<HostKind, string> = {
  github: t("actions.hosts.prWord.github"),
  gitlab: t("actions.hosts.prWord.gitlab"),
  gitea: t("actions.hosts.prWord.default"),
  bitbucket: t("actions.hosts.prWord.default"),
  azure_devops: t("actions.hosts.prWord.default"),
};

export interface HostUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface HostAccountInfo {
  id: Id;
  kind: HostKind;
  /** Address of the web UI, e.g. `https://github.com` or that of the self-hosted instance; null = the public service. */
  baseUrl: string | null;
  /** User name for Basic authentication (Bitbucket); null for the other hosts. */
  username: string | null;
  /** null while the token is not (or no longer) valid. */
  user: HostUser | null;
  /** The last characters of the token, for recognition. Never the token. */
  tokenHint: string | null;
  scopesOk: boolean;
  /** Permissions the token lacks – named the way the host names them. */
  missingScopes: string[];
  lastError: string | null;
}

export interface HostRepo {
  /** Name of the remote at which the host was recognised. */
  remote: string | null;
  account: HostAccountInfo | null;
  kind: HostKind | null;
  owner: string;
  name: string;
  webUrl: string | null;
  defaultBranch: string | null;
  canPush: boolean;
  forkParent: { owner: string; name: string; defaultBranch: string | null } | null;
  /** What the host offers for this repository. */
  capabilities: HostCapabilities;
  /** The account is there, but the host did not answer or refused (token, quota, network). */
  error: CoreError | null;
}

export type PrState = "open" | "closed" | "merged";
export type PrListState = PrState | "all";
export type CheckState = "passing" | "failing" | "pending";
export type CheckRunState = CheckState | "skipped";
export type MergeMethod = "merge" | "squash" | "rebase";

/** What the host offers – the core reports it per repository; these are the fallbacks per host kind. */
export interface HostCapabilities {
  issues: boolean;
  issueCreate: boolean;
  draftPrs: boolean;
  draftToggle: boolean;
  mergeMethods: MergeMethod[];
  deleteSourceBranch: boolean;
  prReopen: boolean;
  prReviewers: boolean;
  prLabels: boolean;
  forkCheckout: boolean;
  releases: boolean;
}

const ALL_FEATURES: Omit<HostCapabilities, "mergeMethods"> = {
  issues: true,
  issueCreate: false,
  draftPrs: true,
  draftToggle: true,
  deleteSourceBranch: true,
  prReopen: true,
  prReviewers: true,
  prLabels: true,
  forkCheckout: true,
  releases: true,
};

/** GitLab has no "rebase" when merging via the API; GitHub cannot toggle drafts there. */
export const defaultCapabilities: Record<HostKind, HostCapabilities> = {
  github: { ...ALL_FEATURES, draftToggle: false, mergeMethods: ["merge", "squash", "rebase"] },
  gitlab: { ...ALL_FEATURES, mergeMethods: ["merge", "squash"] },
  gitea: { ...ALL_FEATURES, mergeMethods: ["merge", "squash", "rebase"] },
  bitbucket: { ...ALL_FEATURES, prReopen: false, prReviewers: false, prLabels: false, forkCheckout: false, releases: false, mergeMethods: ["merge", "squash"] },
  azure_devops: { ...ALL_FEATURES, issueCreate: true, prReviewers: false, forkCheckout: false, releases: false, mergeMethods: ["merge", "squash", "rebase"] },
};

export interface PrSummary {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  author: HostUser | null;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string | null;
  webUrl: string | null;
  checks: CheckState | null;
  /** `approved`, `changes_requested`, `review_required` (requested, still open), `commented` – or null. */
  reviewState: string | null;
  labels: string[];
  /** The source branch lives in a fork. */
  isFork: boolean;
}

export interface PrPage {
  items: PrSummary[];
  /** Number of the next page; null = end. */
  nextPage: number | null;
}

export interface PrComment {
  id: string;
  author: HostUser | null;
  body: string;
  createdAt: string | null;
  /** Comment on a line of the diff. */
  path: string | null;
  line: number | null;
}

export interface PrCheck {
  name: string;
  state: CheckRunState;
  url: string | null;
}

export interface PrCommit {
  sha: Sha;
  summary: string;
  authorName: string;
  authoredAt: string | null;
}

export interface PrReviewer {
  user: HostUser;
  /** `approved`, `changes_requested`, `commented`, `pending` … or null if the host says nothing. */
  state: string | null;
}

export interface PrDetails extends PrSummary {
  body: string;
  reviewers: PrReviewer[];
  comments: PrComment[];
  commits: PrCommit[];
  /** null = the host is still computing. */
  mergeable: boolean | null;
  /** Reason given by the host why the pull request cannot be merged. */
  mergeBlocked: string | null;
  checkRuns: PrCheck[];
  baseSha: Sha | null;
  headSha: Sha | null;
}

export interface PrCreateInput {
  repoId: Id;
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  reviewers: string[];
  labels: string[];
  /**
   * Remote of the target repository if it is not our own (pull request from a fork into the
   * original; `sourceBranch` is then "<owner>:<branch>" on GitHub). Otherwise null.
   */
  remote: string | null;
}

// ---------------------------------------------------------------------------
// Reading what the core returns
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const flag = (value: unknown, fallback = false): boolean => (typeof value === "boolean" ? value : fallback);
const pick = (source: Loose, ...keys: string[]): unknown => {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return null;
};

export function toUser(value: unknown): HostUser | null {
  if (typeof value === "string") return value ? { login: value, name: null, avatarUrl: null } : null;
  if (!isObject(value)) return null;
  const login = text(pick(value, "login", "username", "name"));
  if (!login) return null;
  const name = text(value.name);
  return { login, name: name && name !== login ? name : null, avatarUrl: text(value.avatarUrl) };
}

const toLabel = (value: unknown): string | null => (isObject(value) ? text(value.name) : text(value));
const notNull = <T,>(value: T | null): value is T => value !== null;

const toKind = (value: unknown): HostKind | null => ((HOST_KINDS as unknown[]).includes(value) ? (value as HostKind) : null);

export function toAccount(value: unknown): HostAccountInfo | null {
  if (!isObject(value)) return null;
  const id = text(value.id);
  const kind = toKind(value.kind);
  if (!id || !kind) return null;
  return {
    id,
    kind,
    baseUrl: text(value.baseUrl),
    username: text(value.username),
    user: toUser(value.user),
    tokenHint: text(value.tokenHint),
    scopesOk: flag(value.scopesOk, true),
    missingScopes: list(value.missingScopes).map(text).filter(notNull),
    lastError: text(value.lastError),
  };
}

type CapabilityFlag = Exclude<keyof HostCapabilities, "mergeMethods">;
const CAPABILITY_FLAGS: CapabilityFlag[] = ["issues", "issueCreate", "draftPrs", "draftToggle", "deleteSourceBranch", "prReopen", "prReviewers", "prLabels", "forkCheckout", "releases"];
const isMergeMethod = (value: unknown): value is MergeMethod => value === "merge" || value === "squash" || value === "rebase";

/** The core's capabilities; whatever is missing or malformed comes from the host kind's defaults. */
export function toCapabilities(value: unknown, kind: HostKind | null): HostCapabilities {
  const fallback = defaultCapabilities[kind ?? "github"];
  if (!isObject(value)) return fallback;
  const result: HostCapabilities = { ...fallback, mergeMethods: Array.isArray(value.mergeMethods) ? value.mergeMethods.filter(isMergeMethod) : fallback.mergeMethods };
  for (const key of CAPABILITY_FLAGS) result[key] = flag(value[key], fallback[key]);
  return result;
}

export function toHostRepo(value: unknown, accounts: HostAccountInfo[] = []): HostRepo | null {
  if (!isObject(value)) return null;
  const owner = text(value.owner);
  const name = text(value.name);
  if (!owner || !name) return null;
  // The core names the account as an object or as an ID.
  const account = toAccount(value.account) ?? accounts.find((item) => item.id === text(pick(value, "accountId", "account"))) ?? null;
  const parent = isObject(value.forkParent) ? value.forkParent : null;
  const parentOwner = parent ? text(parent.owner) : null;
  const parentName = parent ? text(parent.name) : null;
  const failure = isObject(value.error) ? value.error : null;
  const kind = toKind(value.kind) ?? account?.kind ?? null;
  return {
    remote: text(value.remote),
    account,
    kind,
    owner,
    name,
    webUrl: text(value.webUrl),
    defaultBranch: text(value.defaultBranch),
    canPush: flag(value.canPush, true),
    forkParent: parent && parentOwner && parentName ? { owner: parentOwner, name: parentName, defaultBranch: text(parent.defaultBranch) } : null,
    capabilities: toCapabilities(value.capabilities, kind),
    error: failure ? new CoreError({ code: (text(failure.code) ?? "unknown") as CoreError["code"], message: text(failure.message) ?? "", gitOutput: null }) : null,
  };
}

const toPrState = (value: unknown): PrState => (value === "closed" || value === "merged" ? value : "open");
const toCheckState = (value: unknown): CheckState | null => (value === "passing" || value === "failing" || value === "pending" ? value : null);

export function toPrSummary(value: unknown): PrSummary | null {
  if (!isObject(value)) return null;
  const number = typeof value.number === "number" ? value.number : Number(value.number);
  if (!Number.isFinite(number)) return null;
  return {
    number,
    title: text(value.title) ?? "",
    state: toPrState(value.state),
    isDraft: flag(value.isDraft),
    author: toUser(value.author),
    sourceBranch: text(value.sourceBranch) ?? "",
    targetBranch: text(value.targetBranch) ?? "",
    updatedAt: text(value.updatedAt),
    webUrl: text(value.webUrl),
    checks: toCheckState(value.checks),
    reviewState: text(value.reviewState),
    labels: list(value.labels).map(toLabel).filter(notNull),
    isFork: flag(value.isFork),
  };
}

function toComment(value: unknown, index: number): PrComment | null {
  if (!isObject(value)) return null;
  return {
    id: text(value.id) ?? `kommentar-${index}`,
    author: toUser(value.author),
    body: text(value.body) ?? "",
    createdAt: text(value.createdAt),
    path: text(value.path),
    line: typeof value.line === "number" ? value.line : null,
  };
}

function toCheck(value: unknown): PrCheck | null {
  if (!isObject(value)) return null;
  const name = text(value.name);
  const state = value.state === "skipped" ? "skipped" : toCheckState(value.state);
  return name && state ? { name, state, url: text(value.url) } : null;
}

function toCommit(value: unknown): PrCommit | null {
  if (!isObject(value)) return null;
  const sha = text(value.sha);
  if (!sha) return null;
  const author = value.author;
  return {
    sha,
    summary: (text(pick(value, "summary", "message", "title")) ?? "").split("\n")[0] ?? "",
    authorName: (isObject(author) ? text(pick(author, "name", "login")) : text(author)) ?? text(value.authorName) ?? "",
    authoredAt: text(pick(value, "authoredAt", "date", "createdAt")),
  };
}

function toReviewer(value: unknown): PrReviewer | null {
  // Either { user, state } or the user directly.
  const user = isObject(value) && value.user !== undefined ? toUser(value.user) : toUser(value);
  if (!user) return null;
  return { user, state: isObject(value) ? text(value.state) : null };
}

export function toPrDetails(value: unknown): PrDetails | null {
  const summary = toPrSummary(value);
  if (!summary || !isObject(value)) return null;
  const mergeable = value.mergeable;
  const commits = list(value.commits).map(toCommit).filter(notNull);
  return {
    ...summary,
    body: text(value.body) ?? "",
    reviewers: list(value.reviewers).map(toReviewer).filter(notNull),
    comments: list(value.comments).map(toComment).filter(notNull),
    commits,
    mergeable: typeof mergeable === "boolean" ? mergeable : mergeable === "mergeable" ? true : mergeable === "conflicting" || mergeable === "blocked" ? false : null,
    mergeBlocked: text(pick(value, "mergeBlocked", "mergeBlockedReason", "mergeableReason")),
    // `checks` is the summary in the list, and the list of individual checks in the details.
    checkRuns: list(Array.isArray(value.checks) ? value.checks : value.checkRuns).map(toCheck).filter(notNull),
    checks: summary.checks ?? summarizeChecks(list(Array.isArray(value.checks) ? value.checks : value.checkRuns).map(toCheck).filter(notNull)),
    baseSha: text(value.baseSha),
    headSha: text(value.headSha) ?? commits[commits.length - 1]?.sha ?? null,
  };
}

/** A failed check makes everything red; if one is still running, "running" applies; without checks (or only skipped ones): null. */
export function summarizeChecks(all: Pick<PrCheck, "state">[]): CheckState | null {
  const checks = all.filter((check) => check.state !== "skipped");
  if (checks.length === 0) return null;
  if (checks.some((check) => check.state === "failing")) return "failing";
  if (checks.some((check) => check.state === "pending")) return "pending";
  return "passing";
}

// ---------------------------------------------------------------------------
// What a pull request changes, from the local repository
// ---------------------------------------------------------------------------

export type PrRange =
  /** The commits are present locally: the diff is `from..to`. */
  | { state: "local"; from: Sha; to: Sha }
  /** The commits are missing locally (not fetched yet, or they live in a fork). */
  | { state: "missing" }
  /** The pull request has no commits. */
  | { state: "empty" };

/**
 * Finds the pull request's range in the local repository: from the parent of its oldest
 * commit to its newest. The order of the list doesn't matter (hosts deliver it
 * differently) – the oldest is the one whose parent does not itself belong to the pull request.
 */
async function prRange(repoId: Id, pr: Pick<PrDetails, "commits" | "headSha">): Promise<PrRange> {
  const shas = pr.commits.map((commit) => commit.sha);
  if (shas.length === 0) return { state: "empty" };
  const own = new Set(shas);
  const load = async (sha: Sha) => (await core.commitDetails({ repoId, source: { kind: "commit", sha } })).commit;
  try {
    const first = await load(shas[0]!);
    const last = shas.length > 1 ? await load(shas[shas.length - 1]!) : first;
    if (!first || !last) return { state: "missing" };
    const firstIsOldest = !first.parents[0] || !own.has(first.parents[0]);
    const oldest = firstIsOldest ? first : last;
    const newest = firstIsOldest ? last : first;
    return { state: "local", from: oldest.parents[0] ?? EMPTY_TREE_SHA, to: pr.headSha && own.has(pr.headSha) ? pr.headSha : newest.sha };
  } catch (error) {
    if (error instanceof CoreError && error.code === "not_found") return { state: "missing" };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

const need = <T,>(value: T | null, what: string): T => {
  if (value === null) throw new CoreError({ code: "unknown", message: t("actions.hosts.unexpectedShape", { what }), gitOutput: null });
  return value;
};

/** The host integration commands from src/core/api.ts, with the results in the shape above. */
export const hostApi = {
  accounts: async (): Promise<HostAccountInfo[]> => list(await core.hostAccounts()).map(toAccount).filter(notNull),
  /** Checks the token against the API and stores it in the keychain. `username` only for Bitbucket. */
  connect: async (input: { kind: HostKind; baseUrl: string | null; token: string; username?: string | null }): Promise<HostAccountInfo> =>
    need(toAccount(await core.hostConnect(input)), t("actions.hosts.what.account")),
  /** GitHub with the GitHub CLI's login: the core reads the token from gh itself. */
  connectGh: async (baseUrl: string | null): Promise<HostAccountInfo> => need(toAccount(await core.hostConnectGh({ baseUrl })), t("actions.hosts.what.account")),
  disconnect: (accountId: Id): Promise<unknown> => core.hostDisconnect({ accountId }),
  /** Returns even when the host refuses – the reason is in `lastError`. */
  check: async (accountId: Id): Promise<HostAccountInfo | null> => toAccount(await core.hostCheck({ accountId })),
  repoInfo: async (repoId: Id, accounts: HostAccountInfo[] = []): Promise<HostRepo | null> => toHostRepo(await core.hostRepoInfo({ repoId }), accounts),

  /** One page of the list (page 1 first), most recently changed first. */
  prList: async (repoId: Id, state: PrListState, page: number): Promise<PrPage> => {
    const raw: unknown = await core.prList({ repoId, state, page });
    const items = list(isObject(raw) ? raw.items : raw).map(toPrSummary).filter(notNull);
    const next = isObject(raw) ? raw.nextPage : null;
    return { items, nextPage: typeof next === "number" ? next : null };
  },
  prGet: async (repoId: Id, number: number): Promise<PrDetails> => need(toPrDetails(await core.prGet({ repoId, number })), t("actions.hosts.what.pr")),
  prCreate: async (input: PrCreateInput): Promise<PrSummary> => need(toPrSummary(await core.prCreate(input)), t("actions.hosts.what.newPr")),
  prComment: (repoId: Id, number: number, body: string): Promise<unknown> => core.prComment({ repoId, number, body }),
  prMerge: (repoId: Id, number: number, method: MergeMethod, deleteBranch: boolean): Promise<unknown> => core.prMerge({ repoId, number, method, deleteBranch }),
  prClose: (repoId: Id, number: number): Promise<unknown> => core.prClose({ repoId, number }),
  prReopen: (repoId: Id, number: number): Promise<unknown> => core.prReopen({ repoId, number }),
  /** Fetches the pull request's branch and checks it out. */
  prCheckout: (repoId: Id, number: number): Promise<Status> => core.prCheckout({ repoId, number }),
  /** From the working directory; no network call. */
  prTemplate: async (repoId: Id): Promise<string | null> => text(await core.prTemplate({ repoId })),
  prRange,
};

// ---------------------------------------------------------------------------
// Host integration errors
// ---------------------------------------------------------------------------

export type HostErrorKind = "not_connected" | "auth" | "rate_limit" | "not_found" | "unsupported" | "rejected" | "permission" | "offline" | "not_built" | "other";

export function hostErrorKind(error: unknown): HostErrorKind {
  const code = isObject(error) || error instanceof Error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : isObject(error) ? String(error.message ?? "") : String(error ?? "");
  switch (code) {
    case "host_not_connected":
      return "not_connected";
    case "host_auth_failed":
      // Token invalid, expired or revoked (401).
      return "auth";
    case "host_forbidden":
      // The token is valid but not allowed to do this (403) – a different situation for the user.
      return "permission";
    case "host_rate_limited":
      return "rate_limit";
    case "host_not_found":
      return "not_found";
    case "host_unsupported":
      return "unsupported";
    case "host_rejected":
      return "rejected";
    case "not_allowed":
      return "permission";
    case "offline":
    case "timeout":
      return "offline";
  }
  // The app is still running with a core without host integration (command not registered).
  if (/command .* not found/i.test(message)) return "not_built";
  return "other";
}

export interface HostErrorText {
  kind: HostErrorKind;
  title: string;
  text: string;
  /** What can be done now. */
  hint: string;
}

const errorText = (key: string, hint = true) => ({
  title: t(`actions.hosts.error.${key}.title`),
  fallback: t(`actions.hosts.error.${key}.fallback`),
  hint: hint ? t(`actions.hosts.error.${key}.hint`) : "",
});

const errorTitles: Record<HostErrorKind, { title: string; fallback: string; hint: string }> = {
  not_connected: errorText("notConnected"),
  auth: errorText("auth"),
  rate_limit: errorText("rateLimit"),
  not_found: errorText("notFound"),
  unsupported: errorText("unsupported", false),
  rejected: errorText("rejected", false),
  permission: errorText("permission"),
  offline: errorText("offline"),
  not_built: errorText("notBuilt"),
  other: errorText("other", false),
};

/** Sentence and suggested action for a host integration error; the core's message takes precedence. */
export function describeHostError(error: unknown): HostErrorText {
  const kind = hostErrorKind(error);
  const info = errorTitles[kind];
  const message = kind === "not_built" ? "" : error instanceof Error ? error.message.trim() : "";
  return { kind, title: info.title, text: localTimes(message) || info.fallback, hint: info.hint };
}

const localTime = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" });

/**
 * The core gives timestamps in UTC ("2026-10-11T22:52:31Z" – e.g. when the host's limit
 * is free again). For humans they are shown here in local time: "12.10.2026, 00:52".
 */
export function localTimes(message: string): string {
  return message.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g, (stamp) => {
    const date = new Date(stamp);
    return Number.isNaN(date.getTime()) ? stamp : t("actions.hosts.localTime", { time: localTime.format(date) });
  });
}
