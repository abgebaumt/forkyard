/**
 * Gitflow: set up, start and finish feature/release/hotfix. The core works with
 * ordinary Git branches and the usual `gitflow.*` keys; this holds the cache, messages
 * and the entry points for menus and commands.
 */
import { t } from "../../i18n";
import { core, type GitflowFinishOptions, type GitflowKind, type GitflowPrefixes, type GitflowStatus, type Id } from "../../core";
import { toast } from "../../ui/Feedback";
import { qk, queryClient } from "../queries";
import { newJobId, runAction } from "../run";
import { withFreshStatus } from "../statusCache";
import { showWip } from "./merge";

export const gitflowKey = (repoId: Id) => [...qk.repo(repoId), "gitflow"] as const;
export const cachedGitflow = (repoId: Id) => queryClient.getQueryData<GitflowStatus>(gitflowKey(repoId));
export const gitflowBusyKey = (repoId: Id) => `${repoId}:gitflow`;

export const kindLabels: Record<GitflowKind, string> = {
  feature: t("actions.gitflow.kind.feature"),
  release: t("actions.gitflow.kind.release"),
  hotfix: t("actions.gitflow.kind.hotfix"),
};

/** The running Gitflow branch with this name, if Gitflow is set up and the state is in the cache. */
export function gitflowBranch(repoId: Id, branch: string | null) {
  if (!branch) return undefined;
  const status = cachedGitflow(repoId);
  return status?.initialized ? status.active.find((item) => item.branch === branch) : undefined;
}

/** Loads the state fresh and puts it into the cache. */
export async function loadGitflow(repoId: Id): Promise<GitflowStatus> {
  const status = await core.gitflowStatus({ repoId });
  queryClient.setQueryData(gitflowKey(repoId), status);
  return status;
}

/** After a Gitflow action: refs, graph and status follow (the core reports it itself too). */
function refreshRepo(repoId: Id) {
  for (const key of [qk.refs(repoId), qk.status(repoId), qk.graph(repoId), qk.undo(repoId)]) void queryClient.invalidateQueries({ queryKey: key });
}

/** Writes the setup. Name errors (`invalid_name`, `not_found`, `not_allowed`) are shown by the caller at the field. */
export async function initGitflow(repoId: Id, input: { main: string; develop: string; prefixes: GitflowPrefixes }) {
  const result = await runAction(t("actions.gitflow.init"), () => core.gitflowInit({ repoId, ...input }), {
    busyKey: gitflowBusyKey(repoId),
    quiet: ["invalid_name", "not_found", "not_allowed"],
  });
  if (result.ok) {
    queryClient.setQueryData(gitflowKey(repoId), result.value);
    refreshRepo(repoId);
    toast({ tone: "success", title: t("actions.gitflow.initDone"), description: t("actions.gitflow.initDescription", { main: result.value.main, develop: result.value.develop }) });
  }
  return result;
}

/** Creates the branch and checks it out. Name errors are shown by the caller at the field. */
export async function startGitflow(repoId: Id, kind: GitflowKind, name: string) {
  const result = await runAction(t("actions.gitflow.start", { kind: kindLabels[kind] }), withFreshStatus(repoId, () => core.gitflowStart({ repoId, kind, name, base: null })), {
    busyKey: gitflowBusyKey(repoId),
    quiet: ["invalid_name", "name_exists", "not_allowed"],
  });
  if (result.ok) {
    queryClient.setQueryData(gitflowKey(repoId), result.value);
    refreshRepo(repoId);
    const branch = result.value.active.find((item) => item.kind === kind && item.name === name)?.branch ?? name;
    toast({ tone: "success", title: t("actions.gitflow.started", { kind: kindLabels[kind] }), description: t("actions.gitflow.startedDescription", { branch }) });
  }
  return result;
}

/**
 * Finishes: merge(s), for release and hotfix the tag, delete the branch, push if requested.
 * On a conflict the tab jumps to the local changes; after resolving, the finish is invoked
 * again – the core skips what is already done.
 */
export async function finishGitflow(repoId: Id, tabId: Id | null, kind: GitflowKind, name: string, options: GitflowFinishOptions) {
  const jobId = options.push ? newJobId() : null;
  const label = t("actions.gitflow.finish", { kind: kindLabels[kind] });
  const result = await runAction(label, withFreshStatus(repoId, () => core.gitflowFinish({ repoId, kind, name, options, jobId })), {
    busyKey: gitflowBusyKey(repoId),
    job: jobId ? { id: jobId, title: t("actions.gitflow.finishPushJob", { kind: kindLabels[kind], name }), repoId } : undefined,
  });
  refreshRepo(repoId);
  void loadGitflow(repoId).catch(() => undefined);
  if (!result.ok) return result;
  const outcome = result.value;
  if (outcome.status === "done") {
    toast({ tone: "success", title: t("actions.gitflow.finished", { kind: kindLabels[kind], name }), description: outcome.summary || undefined });
  } else if (outcome.status === "up_to_date") {
    toast({ tone: "info", title: t("actions.gitflow.nothingLeft"), description: t("actions.gitflow.alreadyFinished", { kind: kindLabels[kind], name }) });
  } else {
    const count = outcome.files.length;
    toast({
      tone: "warning",
      sticky: true,
      title: t("actions.gitflow.conflict", { label, count }),
      description: `${outcome.note ? `${outcome.note} ` : ""}${t("actions.gitflow.conflictDescription", { label })}`,
    });
    showWip(tabId);
  }
  return result;
}
