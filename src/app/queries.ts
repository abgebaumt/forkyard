/**
 * All reads from the core as TanStack Query hooks, plus the key factory `qk` and the ONE
 * place that subscribes to the core's events and invalidates selectively (useCoreSync).
 *
 * Keys are hierarchical: everything of a repo starts with ["repo", repoId, …],
 * so a repo can be invalidated as a whole.
 */
import { useEffect, useMemo } from "react";
import {
  QueryClient,
  useInfiniteQuery,
  useQueries,
  useQuery,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import { core, CoreError, type ActivityScope, type AgentReviewSource, type BisectAutopilot, type BisectStatus, type DiffSource, type FileHistoryEntry, type GraphPage, type Id, type ReflogPage, type Repo, type LineArchaeology, type RepoChange, type Settings, type Sha, type StackStatus, type Tab } from "../core";
import { toast } from "../ui/Feedback";
import { t } from "../i18n";
import { hostApi, type HostAccountInfo, type PrDetails, type PrListState } from "./actions/hostTypes";
import { reportHookOutput } from "./notifications/hooks";
import { reportSubmoduleUpdate } from "./notifications/submodules";
import { issueApi, type IssueFilter } from "../screens/Issues/api";
import { isFixedRev } from "../screens/Archaeology/model";
import { desktopNotify, wasManualSync } from "./notify";
import { readStatus } from "./statusOrder";
import { useAppStore, type ArchaeologyTarget } from "./store";
import { compileRules, type CompiledRule } from "./ticketLinks";
import { writesSettled } from "./writeQueue";
import { parseSearchQuery } from "./searchFilters";
import { createIndexScheduler } from "./ai/indexScheduler";
import { featureVisible } from "./ai/visibility";
import type { AiStatus as SemanticAiStatus, RepoSettings as SemanticRepoSettings } from "../core";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Freshness comes from the core's events, not from time passing.
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      // Core errors are deterministic; a second attempt achieves nothing.
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface DiffOptions {
  force?: boolean;
  ignoreWhitespace?: boolean;
}

export const qk = {
  appInfo: ["app", "info"] as const,
  keyring: ["app", "keyring"] as const,
  avatar: (email: string) => ["app", "avatar", email] as const,
  tabs: ["app", "tabs"] as const,
  repos: ["app", "repos"] as const,
  settings: ["app", "settings"] as const,
  profiles: ["app", "profiles"] as const,
  initTemplates: ["app", "initTemplates"] as const,
  sshKeys: ["app", "sshKeys"] as const,
  credentials: ["app", "credentials"] as const,
  // AI (v1.2): state and connection, this month's usage.
  aiStatus: ["app", "aiStatus"] as const,
  aiUsage: ["app", "aiUsage"] as const,
  agentTemplates: ["app", "agentTemplates"] as const,
  // Search by meaning (v1.2, 9.2): way and index per repository.
  aiSemanticStatus: (repoId: Id) => ["repo", repoId, "aiSemantic"] as const,
  activity: (scope: ActivityScope, repoId: Id | null) => ["activity", scope, repoId] as const,
  activityAll: ["activity"] as const,

  repo: (repoId: Id) => ["repo", repoId] as const,
  readme: (repoId: Id) => ["repo", repoId, "readme"] as const,
  refs: (repoId: Id) => ["repo", repoId, "refs"] as const,
  status: (repoId: Id) => ["repo", repoId, "status"] as const,
  graph: (repoId: Id) => ["repo", repoId, "graph"] as const,
  reflog: (repoId: Id, ref: string | null) => ["repo", repoId, "reflog", ref] as const,
  stackPlan: (repoId: Id, branch: string, base: string, cuts: string) => ["repo", repoId, "stack", "plan", branch, base, cuts] as const,
  stackStatus: (repoId: Id, branch: string) => ["repo", repoId, "stack", "status", branch] as const,
  bisect: (repoId: Id) => ["repo", repoId, "bisect"] as const,
  bisectAutopilot: (repoId: Id) => ["repo", repoId, "bisectAutopilot"] as const,
  commitDetails: (repoId: Id, source: DiffSource) => ["repo", repoId, "commit", source] as const,
  commitDetailsAll: (repoId: Id) => ["repo", repoId, "commit"] as const,
  diff: (repoId: Id, path: string, source: DiffSource, options: DiffOptions = {}) =>
    ["repo", repoId, "diff", source, path, { force: options.force ?? false, ignoreWhitespace: options.ignoreWhitespace ?? false }] as const,
  diffAll: (repoId: Id) => ["repo", repoId, "diff"] as const,
  search: (repoId: Id, query: string) => ["repo", repoId, "search", query] as const,
  tree: (repoId: Id, sha: Sha | null, filter: string | null) => ["repo", repoId, "tree", sha, filter] as const,
  stashes: (repoId: Id) => ["repo", repoId, "stashes"] as const,
  remotes: (repoId: Id) => ["repo", repoId, "remotes"] as const,
  undo: (repoId: Id) => ["repo", repoId, "undo"] as const,
  viewState: (repoId: Id) => ["repo", repoId, "viewState"] as const,
  draft: (repoId: Id) => ["repo", repoId, "draft"] as const,
  repoSettings: (repoId: Id) => ["repo", repoId, "repoSettings"] as const,
  linkRules: (repoId: Id) => ["repo", repoId, "linkRules"] as const,
  fileHistory: (repoId: Id, path: string) => ["repo", repoId, "fileHistory", path] as const,
  fileHistoryAll: (repoId: Id) => ["repo", repoId, "fileHistory"] as const,
  blame: (repoId: Id, path: string, sha: Sha | null) => ["repo", repoId, "blame", sha, path] as const,
  blameAll: (repoId: Id) => ["repo", repoId, "blame"] as const,
  lineArchaeology: (repoId: Id, path: string, line: number, sha: Sha | null) => ["repo", repoId, "lineArchaeology", sha, path, line] as const,
  file: (repoId: Id, path: string, sha: Sha | null) => ["repo", repoId, "file", sha, path] as const,
  fileAll: (repoId: Id) => ["repo", repoId, "file"] as const,
  conflict: (repoId: Id, path: string) => ["repo", repoId, "conflict", path] as const,
  conflictAll: (repoId: Id) => ["repo", repoId, "conflict"] as const,
  rebasePlan: (repoId: Id, base: string, autosquash = false) => ["repo", repoId, "rebasePlan", base, autosquash] as const,
  rebasePlanAll: (repoId: Id) => ["repo", repoId, "rebasePlan"] as const,
  worktrees: (repoId: Id) => ["repo", repoId, "worktrees"] as const,
  agents: (repoId: Id) => ["repo", repoId, "agents"] as const,
  agentReview: (repoId: Id, agentId: Id, source: AgentReviewSource) => ["repo", repoId, "agents", "review", agentId, source] as const,
  agentCollisions: (repoId: Id) => ["repo", repoId, "agentCollisions"] as const,
  submodules: (repoId: Id) => ["repo", repoId, "submodules"] as const,
  lfs: (repoId: Id) => ["repo", repoId, "lfs"] as const,
  /** Clean-up dialog: read fresh on every opening, never invalidated by `repo:changed` while a run changes the numbers. */
  cleanupPreview: (repoId: Id) => ["repo", repoId, "cleanupPreview"] as const,
  cleanupLfsEstimate: (repoId: Id) => ["repo", repoId, "cleanupLfsEstimate"] as const,
  /** Custom commands: with a repository its file and approval are included; without one only the user's own. */
  customCommands: (repoId: Id | null) => (repoId ? (["repo", repoId, "customCommands"] as const) : (["app", "customCommands"] as const)),
  lfsLocks: (repoId: Id, filter: string | null = null) => ["repo", repoId, "lfsLocks", filter] as const,
  lfsLocksAll: (repoId: Id) => ["repo", repoId, "lfsLocks"] as const,
  /** LFS status for the lock symbols – a separate key so it is not re-read on every worktree change. */
  lfsInUse: (repoId: Id) => ["repo", repoId, "lfsInUse"] as const,

  // Host integration (GitHub, GitLab): the app's accounts, the repository's host, pull requests.
  hostAccounts: ["app", "hostAccounts"] as const,
  hostRepo: (repoId: Id) => ["repo", repoId, "hostRepo"] as const,
  /** Release notes: the commits since the last tag up to `to` (null = HEAD). */
  releaseNotesRange: (repoId: Id, to: string | null) => ["repo", repoId, "releaseNotesRange", to ?? "HEAD"] as const,
  prLists: (repoId: Id) => ["repo", repoId, "prs"] as const,
  prList: (repoId: Id, state: PrListState) => ["repo", repoId, "prs", state] as const,
  prs: (repoId: Id) => ["repo", repoId, "pr"] as const,
  pr: (repoId: Id, number: number) => ["repo", repoId, "pr", number] as const,
  prReviewThreads: (repoId: Id, number: number) => ["repo", repoId, "pr", number, "threads"] as const,
  prTemplate: (repoId: Id) => ["repo", repoId, "prTemplate"] as const,

  // Issues of the host.
  issueLists: (repoId: Id) => ["repo", repoId, "issues"] as const,
  issueList: (repoId: Id, filter: IssueFilter) => ["repo", repoId, "issues", filter.state, filter.query.trim()] as const,
  issues: (repoId: Id) => ["repo", repoId, "issue"] as const,
  issue: (repoId: Id, number: number) => ["repo", repoId, "issue", number] as const,
};

/** Page size when loading more of the graph; the first page uses `settings.initialCommits`. */
export const GRAPH_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const useAppInfo = () => useQuery({ queryKey: qk.appInfo, queryFn: () => core.appInfo(), staleTime: Infinity });
/** Whether the OS keychain is reachable; asked only by the screens that store secrets. */
export const useKeyringAvailable = () => useQuery({ queryKey: qk.keyring, queryFn: () => core.appKeyringAvailable(), staleTime: Infinity }).data;
export const useTabs = () => useQuery({ queryKey: qk.tabs, queryFn: () => core.tabsList() });
export const useRepos = () => useQuery({ queryKey: qk.repos, queryFn: () => core.repoList() });
// Settings and profiles are read only once no change to them is in flight (see writeQueue.ts).
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => writesSettled().then(() => core.settingsGet()) });
/** AI state and connection (`aiStatus`); reloads on `app:changed` with `ai`. */
export const useAiStatus = () => useQuery({ queryKey: qk.aiStatus, queryFn: () => core.aiStatus() });

/** Way and index of the search by meaning for this repository (`aiSemanticStatus`, sends nothing). */
export const useAiSemanticStatus = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.aiSemanticStatus(repoId ?? ""), queryFn: () => core.aiSemanticStatus({ repoId: repoId! }), enabled: enabledFor(repoId) });
/** This month's AI usage (numbers only). */
export const useAiUsage = () => useQuery({ queryKey: qk.aiUsage, queryFn: () => core.aiUsage() });
/**
 * Avatar from GitHub for an email address – for `AvatarSourceContext` (called as a hook in every
 * `Avatar`). Off while "Initials instead of avatars" is set; without an image the initials remain.
 */
export function useAvatarUrl(email: string | undefined): string | null {
  const { data: settings } = useSettings();
  const key = email?.trim().toLowerCase() ?? "";
  const enabled = Boolean(key) && settings !== undefined && !settings.showInitials;
  const { data } = useQuery({ queryKey: qk.avatar(key), queryFn: () => core.avatarGet({ email: key }), enabled, staleTime: Infinity, gcTime: Infinity, retry: false });
  return enabled ? (data ?? null) : null;
}
export const useProfiles = () => useQuery({ queryKey: qk.profiles, queryFn: () => writesSettled().then(() => core.profileList()) });
export const useInitTemplates = () =>
  useQuery({ queryKey: qk.initTemplates, queryFn: () => core.initTemplates(), staleTime: Infinity });
export const useSshKeys = () => useQuery({ queryKey: qk.sshKeys, queryFn: () => core.sshKeyList() });
export const useCredentials = () => useQuery({ queryKey: qk.credentials, queryFn: () => core.credentialsList() });

/** Active tab from the tab list (or null). */
export function useActiveTab(): Tab | null {
  const { data } = useTabs();
  return data?.find((tab) => tab.isActive) ?? null;
}

/** Repository entry for an ID from the repo list. */
export function useRepo(repoId: Id | null | undefined) {
  const query = useRepos();
  return { ...query, data: repoId ? query.data?.find((repo) => repo.id === repoId) : undefined };
}

export const useActivity = (scope: ActivityScope, repoId: Id | null, limit = 200) =>
  useInfiniteQuery({
    queryKey: qk.activity(scope, repoId),
    queryFn: ({ pageParam }) => core.activityList({ scope, repoId, cursor: pageParam, limit }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

const enabledFor = (repoId: Id | null | undefined): repoId is Id => Boolean(repoId);

export const useRefs = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.refs(repoId ?? ""), queryFn: () => core.refsList({ repoId: repoId! }), enabled: enabledFor(repoId) });

export const useStatus = (repoId: Id | null | undefined) =>
  // Via statusOrder.ts: a query overtaken by a command result does not overwrite it with an older state.
  useQuery({ queryKey: qk.status(repoId ?? ""), queryFn: ({ signal }) => readStatus(repoId!, signal), enabled: enabledFor(repoId) });

/**
 * The repository's folder is gone or no longer a repository – according to the repo list or the
 * latest status fetch. Then the shell shows a full-page message instead of the repo view, and
 * toolbar and status bar offer nothing that needs a repository.
 */
export function useRepoMissing(repoId: Id | null | undefined): boolean {
  const { data: repo } = useRepo(repoId);
  const { error } = useStatus(repoId);
  const code = error instanceof CoreError ? error.code : null;
  return Boolean(repoId) && (repo?.missing === true || code === "path_not_found" || code === "not_a_repo");
}

/**
 * Whether the core does not (yet) work in this repository because it brings its own commands
 * and the user has not consented. The shell then shows the prompt instead of the view.
 */
export function useRepoLocked(repoId: Id | null | undefined): boolean {
  const { data: repo } = useRepo(repoId);
  return Boolean(repoId) && repo?.trusted === false;
}

export const trustKey = (repoId: Id) => ["trust", repoId] as const;

/** What the check finds in the repository (for the prompt). */
export const useRepoTrust = (repoId: Id) => useQuery({ queryKey: trustKey(repoId), queryFn: () => core.repoTrustGet({ repoId }), staleTime: 0 });

/** Graph as an infinite query. Concatenate `data.pages`; `fetchNextPage()` loads more. */
export function useGraph(repoId: Id | null | undefined) {
  const { data: settings } = useSettings();
  const firstLimit = Math.max(GRAPH_PAGE_SIZE, settings?.initialCommits ?? 2000);
  return useInfiniteQuery({
    queryKey: qk.graph(repoId ?? ""),
    queryFn: ({ pageParam }): Promise<GraphPage> =>
      core.graphPage({ repoId: repoId!, cursor: pageParam, limit: pageParam === null ? firstLimit : GRAPH_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabledFor(repoId) && settings !== undefined,
  });
}

/** Page size of the reflog view. */
export const REFLOG_PAGE_SIZE = 500;

/** Reflog of HEAD (`refName` null) or a branch, page by page. */
export const useReflog = (repoId: Id | null | undefined, refName: string | null) =>
  useInfiniteQuery({
    queryKey: qk.reflog(repoId ?? "", refName),
    queryFn: ({ pageParam }): Promise<ReflogPage> => core.reflogList({ repoId: repoId!, refName, cursor: pageParam, limit: REFLOG_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabledFor(repoId),
  });

/** Bisect state from the Git directory (also one started on the command line). */
export const useBisectStatus = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.bisect(repoId ?? ""), queryFn: (): Promise<BisectStatus> => core.bisectStatus({ repoId: repoId! }), enabled: enabledFor(repoId) });

/** The bisect autopilot's run of the repository (null = none); reloaded on its `job:progress`. */
export const useBisectAutopilot = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.bisectAutopilot(repoId ?? ""), queryFn: (): Promise<BisectAutopilot | null> => core.bisectAutopilotStatus({ repoId: repoId! }), enabled: enabledFor(repoId) });

/** Commits, ranges and stashes never change – only sources involving the working directory go stale. */
const isLive = (source: DiffSource) =>
  source.kind === "unstaged" || source.kind === "staged" || (source.kind === "range" && source.to === null);

export const useCommitDetails = (repoId: Id | null | undefined, source: DiffSource | null | undefined) =>
  useQuery({
    queryKey: qk.commitDetails(repoId ?? "", source ?? { kind: "unstaged" }),
    queryFn: () => core.commitDetails({ repoId: repoId!, source: source! }),
    enabled: enabledFor(repoId) && Boolean(source),
    staleTime: source && !isLive(source) && source.kind !== "stash" ? Infinity : undefined,
  });

export const useDiff = (
  repoId: Id | null | undefined,
  path: string | null | undefined,
  source: DiffSource | null | undefined,
  options: DiffOptions = {},
) =>
  useQuery({
    queryKey: qk.diff(repoId ?? "", path ?? "", source ?? { kind: "unstaged" }, options),
    queryFn: () =>
      core.diffFile({ repoId: repoId!, path: path!, source: source!, force: options.force, ignoreWhitespace: options.ignoreWhitespace }),
    enabled: enabledFor(repoId) && Boolean(path) && Boolean(source),
    staleTime: source && !isLive(source) && source.kind !== "stash" ? Infinity : undefined,
  });

/** Search across the whole history; `code:`, `path:`, `since:`, `until:` in the text narrow it. An empty search does not ask the core. */
export const useCommitSearch = (repoId: Id | null | undefined, query: string, limit = 200) => {
  const parsed = parseSearchQuery(query);
  return useQuery({
    queryKey: qk.search(repoId ?? "", query),
    queryFn: () => core.commitSearch({ repoId: repoId!, query: parsed.query, limit, filters: parsed.filters }),
    enabled: enabledFor(repoId) && (parsed.query.length > 0 || parsed.filters !== null),
  });
};

export const useTree = (repoId: Id | null | undefined, sha: Sha | null, filter: string | null = null, enabled = true) =>
  useQuery({
    queryKey: qk.tree(repoId ?? "", sha, filter),
    queryFn: () => core.treeList({ repoId: repoId!, sha, filter }),
    enabled: enabledFor(repoId) && enabled,
  });

export const useStashes = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.stashes(repoId ?? ""), queryFn: () => core.stashList({ repoId: repoId! }), enabled: enabledFor(repoId) });

export const useRemotes = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.remotes(repoId ?? ""), queryFn: () => core.remoteList({ repoId: repoId! }), enabled: enabledFor(repoId) });

export const useUndoState = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.undo(repoId ?? ""), queryFn: () => core.undoPeek({ repoId: repoId! }), enabled: enabledFor(repoId) });

export const useViewState = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.viewState(repoId ?? ""), queryFn: () => core.viewStateGet({ repoId: repoId! }), enabled: enabledFor(repoId) });

export const useDraft = (repoId: Id | null | undefined) =>
  useQuery({
    queryKey: qk.draft(repoId ?? ""),
    queryFn: () => core.draftGet({ repoId: repoId! }),
    enabled: enabledFor(repoId),
    // The draft belongs to the input field; do not reload it under the user's fingers.
    staleTime: Infinity,
  });

export const useRepoSettings = (repoId: Id | null | undefined) =>
  useQuery({
    queryKey: qk.repoSettings(repoId ?? ""),
    queryFn: () => writesSettled().then(() => core.repoSettingsGet({ repoId: repoId! })),
    enabled: enabledFor(repoId),
  });

/** The stack `branch` is a part of; null if it is no part. */
export const useStackStatus = (repoId: Id, branch: string) =>
  useQuery<StackStatus | null>({ queryKey: qk.stackStatus(repoId, branch), queryFn: () => core.stackStatus({ repoId, branch }), enabled: enabledFor(repoId) });

/** Effective ticket link rules (settings, `.forkyard/links.json`, host). */
export const useLinkRules = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.linkRules(repoId ?? ""), queryFn: () => core.linkRulesGet({ repoId: repoId! }), enabled: enabledFor(repoId) });

const NO_RULES: readonly CompiledRule[] = [];

/** The repository's ticket link rules, compiled for matching; empty while loading or on an error. */
export function useTicketLinks(repoId: Id | null | undefined): readonly CompiledRule[] {
  const { data } = useLinkRules(repoId);
  return useMemo(() => (data ? compileRules(data.rules) : NO_RULES), [data]);
}

export const useReadme = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.readme(repoId ?? ""), queryFn: () => core.repoReadme({ repoId: repoId! }), enabled: enabledFor(repoId) });

export const useFileHistory = (repoId: Id | null | undefined, path: string | null | undefined, limit = 1000) =>
  useQuery({
    // The limit is part of the key: loading more (larger limit) refetches and shows the previous list until then.
    queryKey: [...qk.fileHistory(repoId ?? "", path ?? ""), limit] as const,
    queryFn: () => core.fileHistory({ repoId: repoId!, path: path!, limit }),
    enabled: enabledFor(repoId) && Boolean(path),
    placeholderData: (previous: FileHistoryEntry[] | undefined, query) => (query?.queryKey[3] === path ? previous : undefined),
  });

export const useBlame = (repoId: Id | null | undefined, path: string | null | undefined, sha: Sha | null) =>
  useQuery({
    queryKey: qk.blame(repoId ?? "", path ?? "", sha),
    queryFn: () => core.fileBlame({ repoId: repoId!, path: path!, sha }),
    enabled: enabledFor(repoId) && Boolean(path),
    staleTime: sha ? Infinity : undefined,
  });

/** History of one line (no AI); a committed state never changes, the working directory follows its changes. */
export const useLineArchaeology = (repoId: Id | null | undefined, target: ArchaeologyTarget | null) =>
  useQuery<LineArchaeology>({
    queryKey: qk.lineArchaeology(repoId ?? "", target?.path ?? "", target?.line ?? 0, target?.sha ?? null),
    queryFn: () => core.lineArchaeology({ repoId: repoId!, path: target!.path, line: target!.line, sha: target!.sha }),
    enabled: enabledFor(repoId) && Boolean(target),
    staleTime: isFixedRev(target?.sha) ? Infinity : undefined,
    retry: false,
  });

export const useFileContent = (repoId: Id | null | undefined, path: string | null | undefined, sha: Sha | null) =>
  useQuery({
    queryKey: qk.file(repoId ?? "", path ?? "", sha),
    queryFn: () => core.fileRead({ repoId: repoId!, path: path!, sha }),
    enabled: enabledFor(repoId) && Boolean(path),
    staleTime: sha ? Infinity : undefined,
  });

export const useConflict = (repoId: Id | null | undefined, path: string | null | undefined) =>
  useQuery({
    queryKey: qk.conflict(repoId ?? "", path ?? ""),
    queryFn: () => core.conflictGet({ repoId: repoId!, path: path! }),
    enabled: enabledFor(repoId) && Boolean(path),
  });

/**
 * Details of several commits at once (squash and cherry-pick preview). Same keys as
 * useCommitDetails, hence the same cache. Returns the results in the order of `shas`.
 */
export const useCommitInfos = (repoId: Id | null | undefined, shas: Sha[]) =>
  useQueries({
    queries: shas.map((sha) => ({
      queryKey: qk.commitDetails(repoId ?? "", { kind: "commit", sha }),
      queryFn: () => core.commitDetails({ repoId: repoId!, source: { kind: "commit", sha } }),
      enabled: enabledFor(repoId),
      staleTime: Infinity,
    })),
  });

/** `autosquash`: the plan in Git's autosquash order (8.2: fixup commits below their targets). */
export const useRebasePlan = (repoId: Id | null | undefined, base: string | null | undefined, autosquash = false) =>
  useQuery({
    queryKey: qk.rebasePlan(repoId ?? "", base ?? "", autosquash),
    queryFn: () => core.rebasePlan({ repoId: repoId!, base: base!, autosquash }),
    enabled: enabledFor(repoId) && Boolean(base),
  });

/** All working directories of the repository; the main worktree comes first. */
export const useWorktrees = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.worktrees(repoId ?? ""), queryFn: () => core.worktreeList({ repoId: repoId! }), enabled: enabledFor(repoId) });

/** Worktree repository → repository the agent belongs to (filled by `useAgents`), so a change in an agent's worktree refreshes the cockpit. */
const agentOwners = new Map<Id, Id>();
export const agentOwner = (worktreeRepoId: Id): Id | undefined => agentOwners.get(worktreeRepoId);

export const useAgents = (repoId: Id | null | undefined) =>
  useQuery({
    queryKey: qk.agents(repoId ?? ""),
    queryFn: async () => {
      const agents = await core.agentList({ repoId: repoId! });
      for (const agent of agents) if (agent.worktreeRepoId) agentOwners.set(agent.worktreeRepoId, agent.repoId);
      return agents;
    },
    enabled: enabledFor(repoId),
  });

/** What the review of an agent compares (refetched with the agents: their watcher and `agents:changed`). */
export const useAgentReview = (repoId: Id | null | undefined, agentId: Id | null | undefined, source: AgentReviewSource) =>
  useQuery({
    queryKey: qk.agentReview(repoId ?? "", agentId ?? "", source),
    queryFn: () => core.agentReview({ agentId: agentId!, source }),
    enabled: enabledFor(repoId) && Boolean(agentId),
  });

/**
 * The agent templates with their programs' version and sign-in state – asking that starts every
 * tool (`claude --version`, `claude auth status` …), so only where it is needed (`enabled`).
 */
export const useAgentTemplates = (enabled = true) => useQuery({ queryKey: qk.agentTemplates, queryFn: () => core.agentTemplates(), staleTime: 60_000, enabled });

/** The last collision report of the repository's agents; kept current by `agents:collisions`. */
export const useAgentCollisions = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.agentCollisions(repoId ?? ""), queryFn: () => core.agentCollisions({ repoId: repoId! }), enabled: enabledFor(repoId) });

export const useSubmodules = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.submodules(repoId ?? ""), queryFn: () => core.submoduleList({ repoId: repoId! }), enabled: enabledFor(repoId) });

/** The user's own custom commands and – with a repository – those of its `.forkyard/commands.json` with their approval. */
export const useCustomCommandList = (repoId: Id | null | undefined) =>
  useQuery({ queryKey: qk.customCommands(repoId ?? null), queryFn: () => core.customCommandsList({ repoId: repoId ?? null }) });

/** Whether Git LFS is installed and which patterns the repository tracks with it. */
export const useLfsStatus = (repoId: Id | null | undefined, enabled = true) =>
  useQuery({ queryKey: qk.lfs(repoId ?? ""), queryFn: () => core.lfsStatus({ repoId: repoId! }), enabled: enabledFor(repoId) && enabled });

/**
 * LFS file locks at the server. The core keeps the list and reads it again only after a fetch
 * (`repo:changed` with `locks`) or on a manual refresh – so here it never goes stale by time.
 */
export const useLfsLocks = (repoId: Id | null | undefined, filter: string | null = null, enabled = true) =>
  useQuery({
    queryKey: qk.lfsLocks(repoId ?? "", filter),
    queryFn: () => core.lfsLocks({ repoId: repoId!, filter }),
    enabled: enabledFor(repoId) && enabled,
    staleTime: Infinity,
  });

/**
 * The LFS status as file lists, menus and the commit panel need it (does the repository use LFS?).
 * Unlike `useLfsStatus` (`qk.lfs`, re-read on every worktree change) it is re-read only after a
 * checkout (`head`) or a configuration change, and when a pattern is tracked in the LFS panel –
 * otherwise every saved file would run `git lfs` twice in every open repository.
 */
export const useLfsInUse = (repoId: Id | null | undefined) =>
  useQuery({
    queryKey: qk.lfsInUse(repoId ?? ""),
    queryFn: () => core.lfsStatus({ repoId: repoId! }),
    enabled: enabledFor(repoId),
    staleTime: Infinity,
  });

// ---------------------------------------------------------------------------
// Host integration (GitHub, GitLab)
// ---------------------------------------------------------------------------

/** What lives at the host changes without an event from the core: after two minutes it counts as stale. */
export const HOST_STALE_MS = 2 * 60_000;

/** The connected accounts – without token; that lives in the system keychain. */
export const useHostAccounts = () => useQuery({ queryKey: qk.hostAccounts, queryFn: () => hostApi.accounts() });

/** Host, owner and name of the repository according to its remote URL; null if nothing was recognised. */
export const useHostRepo = (repoId: Id | null | undefined) =>
  useQuery({
    queryKey: qk.hostRepo(repoId ?? ""),
    queryFn: () => hostApi.repoInfo(repoId!, queryClient.getQueryData<HostAccountInfo[]>(qk.hostAccounts) ?? []),
    enabled: enabledFor(repoId),
    staleTime: HOST_STALE_MS,
  });

/** "n commits since v1.1.0" of the release notes – no AI, no network. */
export const useReleaseNotesRange = (repoId: Id | null | undefined, to: string | null) =>
  useQuery({
    queryKey: qk.releaseNotesRange(repoId ?? "", to),
    queryFn: () => core.releaseNotesRange({ repoId: repoId!, from: null, to }),
    enabled: enabledFor(repoId),
  });

/** Pull requests page by page (page 1 first). */
export const usePullRequests = (repoId: Id | null | undefined, state: PrListState, enabled = true) =>
  useInfiniteQuery({
    queryKey: qk.prList(repoId ?? "", state),
    queryFn: ({ pageParam }) => hostApi.prList(repoId!, state, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    enabled: enabledFor(repoId) && enabled,
    staleTime: HOST_STALE_MS,
  });

export const usePullRequest = (repoId: Id | null | undefined, number: number | null | undefined) =>
  useQuery({
    queryKey: qk.pr(repoId ?? "", number ?? 0),
    queryFn: () => hostApi.prGet(repoId!, number!),
    enabled: enabledFor(repoId) && typeof number === "number",
    staleTime: HOST_STALE_MS,
  });

/**
 * Where a pull request's commits are in the local repository (for the "Files" tab):
 * the range for the diff – or "missing locally".
 */
export const usePrRange = (repoId: Id | null | undefined, pr: Pick<PrDetails, "number" | "commits" | "headSha"> | null | undefined, enabled = true) =>
  useQuery({
    queryKey: [...qk.pr(repoId ?? "", pr?.number ?? 0), "range", pr?.headSha ?? null, pr?.commits.length ?? 0] as const,
    queryFn: () => hostApi.prRange(repoId!, pr!),
    enabled: enabledFor(repoId) && Boolean(pr) && enabled,
    staleTime: 0,
  });

/** Review threads of a pull request (8.2) – only where the host offers them; refreshed with the pull request. */
export const usePrReviewThreads = (repoId: Id | null | undefined, number: number | null | undefined, enabled = true) =>
  useQuery({
    queryKey: qk.prReviewThreads(repoId ?? "", number ?? 0),
    queryFn: () => hostApi.reviewThreads(repoId!, number!),
    enabled: enabledFor(repoId) && typeof number === "number" && enabled,
    staleTime: HOST_STALE_MS,
  });

/** Text of the pull request template from the repository; null if there is none. */
export const usePrTemplate = (repoId: Id | null | undefined, enabled = true) =>
  useQuery({ queryKey: qk.prTemplate(repoId ?? ""), queryFn: () => hostApi.prTemplate(repoId!), enabled: enabledFor(repoId) && enabled, staleTime: Infinity });

// ---------------------------------------------------------------------------
// Issues of the host
// ---------------------------------------------------------------------------

/** Issues page by page (page 1 first); the core names the next page. */
export const useIssues = (repoId: Id | null | undefined, filter: IssueFilter, enabled = true) =>
  useInfiniteQuery({
    queryKey: qk.issueList(repoId ?? "", filter),
    queryFn: ({ pageParam }) => issueApi.list(repoId!, filter, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    enabled: enabledFor(repoId) && enabled,
    staleTime: HOST_STALE_MS,
  });

export const useIssue = (repoId: Id | null | undefined, number: number | null | undefined) =>
  useQuery({
    queryKey: qk.issue(repoId ?? "", number ?? 0),
    queryFn: () => issueApi.get(repoId!, number!),
    enabled: enabledFor(repoId) && typeof number === "number",
    staleTime: HOST_STALE_MS,
  });

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/** Key part at position 2 (after "repo", repoId). */
const part = (query: Query) => query.queryKey[2] as string | undefined;

/** Queries that depend on the working directory or index. */
function dependsOnWorktree(query: Query): boolean {
  const key = query.queryKey;
  switch (part(query)) {
    case "status":
    case "conflict":
      return true;
    case "diff":
    case "commit":
      return isLive(key[3] as DiffSource);
    case "file":
    case "blame":
    case "tree":
      return key[3] === null;
    // A working-directory line is traced through blame; `HEAD` moves; a full SHA never changes.
    case "lineArchaeology":
      return !isFixedRev(key[3]);
    // Submodule state and the LFS patterns (.gitattributes) depend on the working directory.
    // `.forkyard/commands.json` (custom commands) as well.
    case "submodules":
    case "lfs":
    case "customCommands":
      return true;
    // `.forkyard/links.json` is read from the working directory (otherwise from HEAD).
    case "linkRules":
      return true;
    default:
      return false;
  }
}

const REFS_PARTS = new Set(["refs", "graph", "status", "undo", "search", "fileHistory", "rebasePlan", "readme", "worktrees", "reflog", "bisect", "agents", "stack"]);
const STASH_PARTS = new Set(["stashes", "graph", "undo"]);
// "hostRepo": a repository's host follows from its remote URL, and so do its host link rules ("linkRules").
const CONFIG_PARTS = new Set(["remotes", "repoSettings", "refs", "submodules", "lfs", "hostRepo", "linkRules", "lineArchaeology", "stack"]);
const OPERATION_PARTS = new Set(["status", "conflict", "undo", "bisect"]);

/** What a `repo:changed` means for a repo's queries. */
export function invalidateRepo(client: QueryClient, repoId: Id, what: RepoChange[]): Promise<void> {
  const changes = new Set(what);
  return client.invalidateQueries({
    queryKey: qk.repo(repoId),
    predicate: (query) => {
      const name = part(query);
      if (!name) return false;
      // The undo state also depends on the working directory: discard creates an entry and reports only "worktree".
      if ((changes.has("worktree") || changes.has("index")) && (dependsOnWorktree(query) || name === "undo")) return true;
      if ((changes.has("refs") || changes.has("head")) && (REFS_PARTS.has(name) || dependsOnWorktree(query))) return true;
      if (changes.has("stash") && STASH_PARTS.has(name)) return true;
      if (changes.has("config") && CONFIG_PARTS.has(name)) return true;
      if (changes.has("operation") && OPERATION_PARTS.has(name)) return true;
      if (changes.has("locks") && name === "lfsLocks") return true;
      if ((changes.has("head") || changes.has("config")) && name === "lfsInUse") return true;
      return false;
    },
  });
}

/**
 * A fetch in the activity log that nobody clicked is the core's auto-fetch. It only reports on
 * new refs or on the first failure of a kind – here that becomes, depending on the settings, a
 * toast (and a notification if the window is not in front).
 */
/** Error codes for which a failed auto-fetch does not interrupt: no network, no credentials, timeout, unknown host. */
const QUIET_FETCH_FAILURES: ReadonlySet<string> = new Set(["offline", "auth_failed", "timeout", "host_key_unknown"]);

function reportBackgroundFetch(repoId: Id, exitCode: number | null, output: string, code: string | null): void {
  const busy = useAppStore.getState().busy;
  if (busy[`${repoId}:fetch`] || busy[`${repoId}:pull`] || busy[`${repoId}:push`] || wasManualSync(repoId)) return;
  const settings = queryClient.getQueryData<Settings>(qk.settings);
  const name = queryClient.getQueryData<Repo[]>(qk.repos)?.find((repo) => repo.id === repoId);
  const where = name ? (name.alias ?? name.name) : t("app.queries.repository");
  if (exitCode === 0) {
    if (!settings?.notifyOnFetch) return;
    toast({ tone: "info", title: t("app.queries.fetchNews", { where }), description: t("app.queries.fetchNewsText") });
    desktopNotify(true, t("app.queries.fetchNews", { where }), t("app.queries.fetchNewsShort"));
    return;
  }
  if (!settings?.notifyOnError || !output.startsWith("Auto-fetch failed")) return;
  const reason = (output.split("\n")[0] ?? "").replace(/^Auto-fetch failed:\s*/, "");
  // No network, no credentials, unknown host: that is normal on the road and no reason to interrupt.
  // The entry is in the activity log; a manual fetch prompts or names the error.
  if (code !== null && QUIET_FETCH_FAILURES.has(code)) return;
  toast({ tone: "warning", title: t("app.queries.fetchFailed", { where }), description: reason || undefined });
  desktopNotify(true, t("app.queries.fetchFailed", { where }), reason);
}

/** Grows the index of the search by meaning after fetch and commit; the core does nothing before the first search. */
const semanticIndex = createIndexScheduler({
  delayMs: 3000,
  enabled: (repoId) =>
    featureVisible(queryClient.getQueryData<SemanticAiStatus>(qk.aiStatus), "semantic_search", queryClient.getQueryData<SemanticRepoSettings>(qk.repoSettings(repoId))?.aiOff ?? false),
  update: async (repoId) => {
    const done = await core.aiSemanticIndexUpdate({ repoId, jobId: `semantic-index-${repoId}-${Date.now().toString(36)}` });
    if (done.added > 0 || done.removed > 0) await queryClient.invalidateQueries({ queryKey: qk.aiSemanticStatus(repoId) });
  },
});

const APP_KEYS: Record<string, QueryKey> = {
  // Host accounts (connected, disconnected, verified).
  host_accounts: qk.hostAccounts,
  tabs: qk.tabs,
  repos: qk.repos,
  settings: qk.settings,
  profiles: qk.profiles,
  ai: qk.aiStatus,
};

/**
 * Subscribes to all of the core's events and keeps query cache and store up to date.
 * Call exactly once in the shell.
 */
export function useCoreSync(activeRepoId: Id | null) {
  useEffect(() => {
    const store = useAppStore.getState;
    const stops = [
      core.on("agents:changed", ({ repoId, running }) => {
        store().setAgentsRunning(running);
        store().noteAgentRepo(repoId);
        void queryClient.invalidateQueries({ queryKey: qk.agents(repoId) });
      }),
      core.on("repo:changed", ({ repoId, what }) => {
        void invalidateRepo(queryClient, repoId, what);
        const owner = agentOwner(repoId);
        if (owner && (what.includes("worktree") || what.includes("index") || what.includes("refs") || what.includes("head"))) {
          void queryClient.invalidateQueries({ queryKey: qk.agents(owner) });
        }
        semanticIndex.changed(repoId, what);
      }),
      core.on("app:changed", ({ what }) => {
        for (const item of what) {
          const key = APP_KEYS[item];
          if (key) void queryClient.invalidateQueries({ queryKey: key });
        }
        if (what.includes("settings")) void queryClient.invalidateQueries({ queryKey: qk.agentTemplates });
        // Host accounts have changed (connected, token replaced, disconnected): whatever is loaded about issues –
        // including a list that failed because of the expired token – counts as stale and reloads; link rules follow from the recognised host.
        if (what.includes("host_accounts")) {
          void queryClient.invalidateQueries({
            predicate: (query) => query.queryKey[0] === "repo" && (part(query) === "issues" || part(query) === "issue" || part(query) === "linkRules"),
          });
        }
        if (what.includes("custom_commands")) {
          void queryClient.invalidateQueries({
            predicate: (query) => (query.queryKey[0] === "app" && query.queryKey[1] === "customCommands") || (query.queryKey[0] === "repo" && part(query) === "customCommands"),
          });
        }
        // AI settings (embedder, model) or "Delete index": way and index of the search by meaning.
        if (what.includes("ai")) {
          void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" && part(query) === "aiSemantic" });
        }
        // Switching profile changes settings, tabs and identity
        if (what.includes("profiles")) {
          void queryClient.invalidateQueries({ queryKey: qk.settings });
          void queryClient.invalidateQueries({ queryKey: qk.tabs });
        }
      }),
      core.on("log:appended", (entry) => {
        void queryClient.invalidateQueries({ queryKey: qk.activityAll });
        if (!entry.repoId || !/^git\s+fetch\b/.test(entry.command)) return;
        if (entry.exitCode === 0) store().markFetched(entry.repoId);
        reportBackgroundFetch(entry.repoId, entry.exitCode, entry.output, entry.code ?? null);
      }),
      core.on("job:progress", (payload) => {
        store().updateJob(payload);
        // The bisect autopilot reports each step under its own phase (`PROGRESS_PHASE` in the core): its bar reloads the run.
        if (payload.phase === "bisect-autopilot" && payload.repoId) void queryClient.invalidateQueries({ queryKey: qk.bisectAutopilot(payload.repoId) });
      }),
      core.on("job:done", ({ jobId }) => store().finishJob(jobId)),
      core.on("credential:request", (request) => store().enqueueCredential(request)),
      // Hook output and failures: one toast per incident, see notifications/hooks.ts.
      core.on("hook:output", (payload) => reportHookOutput(payload, queryClient.getQueryData<Settings>(qk.settings)?.notifyOnError)),
      // Collision check of coding agents: the report replaces the cached one (no refetch needed).
      core.on("agents:collisions", (report) => {
        queryClient.setQueryData(qk.agentCollisions(report.repoId), report);
      }),
      // Follow-up job after checkout, pull …: refresh the list; a failure is a warning toast.
      core.on("submodules:updated", (event) => {
        void queryClient.invalidateQueries({ queryKey: qk.submodules(event.repoId) });
        reportSubmoduleUpdate(event);
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  // Status refresh when the window gets focus (changes from terminal or editor).
  useEffect(() => {
    if (!activeRepoId) return;
    const onFocus = () => {
      void queryClient.invalidateQueries({ queryKey: qk.status(activeRepoId) });
      void queryClient.invalidateQueries({ queryKey: qk.refs(activeRepoId) });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeRepoId]);
}
