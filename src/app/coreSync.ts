/**
 * The ONE place that subscribes to the core's events and keeps query cache and store up to date
 * (useCoreSync), plus what a `repo:changed` invalidates (invalidateRepo).
 */
import { useEffect } from "react";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import {
  core,
  type AiStatus as SemanticAiStatus,
  type Id,
  type Repo,
  type RepoChange,
  type RepoSettings as SemanticRepoSettings,
  type DiffSource,
  type Settings,
  type Tab,
} from "../core";
import { toast } from "../ui/Feedback";
import { t } from "../i18n";
import { reportHookOutput } from "./notifications/hooks";
import { reportSubmoduleUpdate } from "./notifications/submodules";
import { isFixedRev } from "../screens/Archaeology/model";
import { desktopNotify, wasManualSync } from "./notify";
import { useAppStore } from "./store";
import { createIndexScheduler } from "./ai/indexScheduler";
import { featureVisible } from "./ai/visibility";
import { agentOwner, isLive, keepFirstPage, qk, queryClient } from "./queries";
import { busyKeys } from "./actions/keys";

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
    // The graph edit's plan is refused while the working directory is dirty (it offers to stash).
    case "rebasePlan":
      return key[3] === "branch" && typeof key[4] === "string";
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

const REFS_PARTS = new Set([
  "refs",
  "graph",
  "status",
  "undo",
  "search",
  "fileHistory",
  "rebasePlan",
  "readme",
  "worktrees",
  "reflog",
  "bisect",
  "agents",
  "stack",
  "branchCleanup",
]);
const STASH_PARTS = new Set(["stashes", "graph", "undo"]);
// "hostRepo": a repository's host follows from its remote URL, and so do its host link rules ("linkRules").
const CONFIG_PARTS = new Set(["remotes", "repoSettings", "refs", "submodules", "lfs", "hostRepo", "linkRules", "lineArchaeology", "stack"]);
const OPERATION_PARTS = new Set(["status", "conflict", "undo", "bisect"]);

/** What a `repo:changed` means for a repo's queries. */
export function invalidateRepo(client: QueryClient, repoId: Id, what: RepoChange[]): Promise<void> {
  const changes = new Set(what);
  // Other refs, other rows: refetching every scrolled page would be thousands of commits.
  if (changes.has("refs") || changes.has("head") || changes.has("stash")) client.setQueryData(qk.graph(repoId), keepFirstPage);
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
  if (busy[busyKeys.fetch(repoId)] || busy[busyKeys.pull(repoId)] || busy[busyKeys.push(repoId)] || wasManualSync(repoId)) return;
  const settings = queryClient.getQueryData<Settings>(qk.settings);
  const name = queryClient.getQueryData<Repo[]>(qk.repos)?.find((repo) => repo.id === repoId);
  const where = name ? (name.alias ?? name.name) : t("ui.repository");
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
    featureVisible(
      queryClient.getQueryData<SemanticAiStatus>(qk.aiStatus),
      "semantic_search",
      queryClient.getQueryData<SemanticRepoSettings>(qk.repoSettings(repoId))?.aiOff ?? false,
    ),
  update: async (repoId) => {
    const done = await core.aiSemanticIndexUpdate({ repoId, jobId: `semantic-index-${repoId}-${Date.now().toString(36)}` });
    if (done.added > 0 || done.removed > 0) await queryClient.invalidateQueries({ queryKey: qk.aiSemanticStatus(repoId) });
  },
});

export const APP_KEYS: Record<string, QueryKey> = {
  // Host accounts (connected, disconnected, verified).
  host_accounts: qk.hostAccounts,
  tabs: qk.tabs,
  windows: qk.windows,
  repos: qk.repos,
  settings: qk.settings,
  profiles: qk.profiles,
  ai: qk.aiStatus,
  // A profile switch changes both lists, even when it ends in an error.
  credentials: qk.credentials,
  ssh_keys: qk.sshKeys,
};

/**
 * Whether this window shows a job's progress: one it started itself, or one in a repository it has a tab for.
 * Every window hears every job; the others belong to other windows.
 */
export function jobBelongsHere(jobId: string, repoId: Id | null, ownJobs: ReadonlySet<string>, tabRepoIds: ReadonlySet<Id>): boolean {
  return ownJobs.has(jobId) || (repoId !== null && tabRepoIds.has(repoId));
}

/** `jobBelongsHere` against this window's store (`runAction` registers its jobs before they start) and tabs. */
export function ownsJob(jobId: string, repoId: Id | null): boolean {
  const tabRepoIds = new Set((queryClient.getQueryData<Tab[]>(qk.tabs) ?? []).flatMap((tab) => (tab.repoId ? [tab.repoId] : [])));
  return jobBelongsHere(jobId, repoId, new Set(Object.keys(useAppStore.getState().jobs)), tabRepoIds);
}

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
            predicate: (query) =>
              query.queryKey[0] === "repo" && (part(query) === "issues" || part(query) === "issue" || part(query) === "linkRules"),
          });
        }
        if (what.includes("custom_commands")) {
          void queryClient.invalidateQueries({
            predicate: (query) =>
              (query.queryKey[0] === "app" && query.queryKey[1] === "customCommands") ||
              (query.queryKey[0] === "repo" && part(query) === "customCommands"),
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
        if (!ownsJob(payload.jobId, payload.repoId)) return;
        store().updateJob(payload);
        // The bisect autopilot reports each step under its own phase (`PROGRESS_PHASE` in the core): its bar reloads the run.
        if (payload.phase === "bisect-autopilot" && payload.repoId)
          void queryClient.invalidateQueries({ queryKey: qk.bisectAutopilot(payload.repoId) });
      }),
      core.on("job:done", ({ jobId, repoId }) => {
        if (ownsJob(jobId, repoId)) store().finishJob(jobId);
      }),
      core.onWindow("credential:request", (request) => store().enqueueCredential(request)),
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
    // Another window may change tabs, windows or repositories while this one loads, before its
    // listeners stand: once they do, those lists load again.
    void Promise.all(stops.map((stop) => stop.ready)).then(() => {
      for (const key of [qk.tabs, qk.windows, qk.repos]) void queryClient.invalidateQueries({ queryKey: key });
    });
    return () => stops.forEach((stop) => stop());
  }, []);

  // Status refresh when the window gets focus (changes from terminal or editor).
  useEffect(() => {
    if (!activeRepoId) return;
    const onFocus = () => {
      void queryClient.invalidateQueries({ queryKey: qk.status(activeRepoId) });
      void queryClient.invalidateQueries({ queryKey: qk.refs(activeRepoId) });
      // Another window may have changed the commit message draft.
      void queryClient.invalidateQueries({ queryKey: qk.draft(activeRepoId) });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeRepoId]);
}
