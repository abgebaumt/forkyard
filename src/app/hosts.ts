/**
 * Host integration (GitHub, GitLab, Gitea/Forgejo, Bitbucket Cloud, Azure DevOps via their public REST APIs, with the user's token):
 * what the UI adds to the core's host contract – labels, fallback capabilities, the local range of a
 * pull request and how host errors are told to the user. The shapes themselves are the generated
 * core types; the token never comes back (the core reveals at most `tokenHint`).
 */
import { core, CoreError, EMPTY_TREE_SHA, type HostCapabilities, type HostKind, type Id, type PrDetails, type Sha } from "../core";
import { locale, t } from "../i18n";

/** In the order the app offers them. */
export const HOST_KINDS: HostKind[] = ["github", "gitlab", "gitea", "bitbucket", "azure_devops"];

export const hostKindLabels: Record<HostKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea/Forgejo",
  bitbucket: "Bitbucket",
  azure_devops: "Azure DevOps",
};

/** What the host calls the thing – GitLab speaks of merge requests. The app uniformly says pull request. */
export const hostPrWord: Record<HostKind, string> = {
  github: t("ui.pullRequest"),
  gitlab: t("actions.hosts.prWord.gitlab"),
  gitea: t("ui.pullRequest"),
  bitbucket: t("ui.pullRequest"),
  azure_devops: t("ui.pullRequest"),
};

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
  reviewThreads: true,
  reviewReply: true,
  reviewReplyQuotes: false,
  reviewComment: false,
  reviewCommentRange: false,
  reviewResolve: false,
  reviewSubmitBatch: false,
  reviewApprove: false,
  reviewRequestChanges: false,
  reviewVoteOwnPr: false,
};

/** GitLab has no "rebase" when merging via the API; GitHub cannot toggle drafts there. */
export const defaultCapabilities: Record<HostKind, HostCapabilities> = {
  github: {
    ...ALL_FEATURES,
    draftToggle: false,
    reviewComment: true,
    reviewCommentRange: true,
    reviewResolve: true,
    reviewSubmitBatch: true,
    reviewApprove: true,
    reviewRequestChanges: true,
    mergeMethods: ["merge", "squash", "rebase"],
  },
  gitlab: {
    ...ALL_FEATURES,
    reviewComment: true,
    reviewResolve: true,
    reviewSubmitBatch: true,
    reviewApprove: true,
    mergeMethods: ["merge", "squash"],
  },
  gitea: {
    ...ALL_FEATURES,
    reviewReplyQuotes: true,
    reviewComment: true,
    reviewSubmitBatch: true,
    reviewApprove: true,
    reviewRequestChanges: true,
    mergeMethods: ["merge", "squash", "rebase"],
  },
  bitbucket: {
    ...ALL_FEATURES,
    prReopen: false,
    prReviewers: false,
    prLabels: false,
    forkCheckout: false,
    releases: false,
    reviewComment: true,
    reviewResolve: true,
    reviewApprove: true,
    reviewRequestChanges: true,
    mergeMethods: ["merge", "squash"],
  },
  azure_devops: {
    ...ALL_FEATURES,
    issueCreate: true,
    prReviewers: false,
    forkCheckout: false,
    releases: false,
    reviewComment: true,
    reviewCommentRange: true,
    reviewResolve: true,
    reviewApprove: true,
    reviewRequestChanges: true,
    reviewVoteOwnPr: true,
    mergeMethods: ["merge", "squash", "rebase"],
  },
};

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
export async function prRange(repoId: Id, pr: Pick<PrDetails, "commits" | "headSha">): Promise<PrRange> {
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
// Host integration errors
// ---------------------------------------------------------------------------

export type HostErrorKind =
  | "not_connected"
  | "auth"
  | "rate_limit"
  | "not_found"
  | "unsupported"
  | "rejected"
  | "permission"
  | "offline"
  | "other";

export function hostErrorKind(error: unknown): HostErrorKind {
  const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
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
  other: errorText("other", false),
};

/** Sentence and suggested action for a host integration error; the core's message takes precedence. */
export function describeHostError(error: unknown): HostErrorText {
  const kind = hostErrorKind(error);
  const info = errorTitles[kind];
  // Thrown `CoreError`s and the plain `HostRepoInfo.error` both carry `message`.
  const raw = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : null;
  const message = typeof raw === "string" ? raw.trim() : "";
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
