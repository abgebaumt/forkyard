/**
 * Actions for submodules: fetch (initialise), update, open as repository, remove.
 * The add dialog lives in src/screens/SubmoduleDialog and calls `addSubmodule` here.
 */
import { t } from "../../i18n";
import { core, type ErrorCode, type Id, type Repo, type Submodule, type SubmoduleState } from "../../core";
import { toast } from "../../ui/Feedback";
import { confirm } from "../dialogs";
import { errorInfo } from "../errors";
import { shortSha } from "../format";
import { qk, queryClient } from "../queries";
import { newJobId, runAction, showError, type ActionResult } from "../run";
import { clip } from "./context";
import { openRepositoryAt } from "./repos";

export const submoduleBusyKey = (repoId: Id) => `${repoId}:submodule`;

/** State of a submodule as a word – shown in the row, in the tooltip and for screen readers. */
export const submoduleStateText: Record<SubmoduleState, string> = {
  initialized: t("actions.submodules.state.initialized"),
  uninitialized: t("actions.submodules.state.uninitialized"),
  out_of_sync: t("actions.submodules.state.outOfSync"),
  modified: t("actions.submodules.state.modified"),
};

/** One sentence on what the state means. */
export const submoduleStateHint: Record<SubmoduleState, string> = {
  initialized: t("actions.submodules.hint.initialized"),
  uninitialized: t("actions.submodules.hint.uninitialized"),
  out_of_sync: t("actions.submodules.hint.outOfSync"),
  modified: t("actions.submodules.hint.modified"),
};

const setList = (repoId: Id, list: Submodule[]) => queryClient.setQueryData(qk.submodules(repoId), list);
const cachedList = (repoId: Id) => queryClient.getQueryData<Submodule[]>(qk.submodules(repoId));
const ALL_CODES = Object.keys(errorInfo) as ErrorCode[];

function afterChange(repoId: Id, list: Submodule[]) {
  setList(repoId, list);
  void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
}

export interface AddSubmoduleInput {
  jobId: string;
  url: string;
  path: string;
}

/** Clones and registers. The dialog reports errors itself (all codes silent). */
export async function addSubmodule(repoId: Id, input: AddSubmoduleInput): Promise<ActionResult<Submodule[]>> {
  const result = await runAction(t("actions.submodules.add.label"), () => core.submoduleAdd({ repoId, ...input }), {
    busyKey: submoduleBusyKey(repoId),
    job: { id: input.jobId, title: t("actions.submodules.fetchJob", { path: clip(input.path, 40) }), repoId },
    quiet: ALL_CODES,
    success: t("actions.submodules.add.done", { path: clip(input.path, 40) }),
  });
  if (result.ok) afterChange(repoId, result.value);
  return result;
}

/**
 * Fetches the registered commits. `targets: null` = all submodules; `init` also fetches those not
 * yet initialised. Runs as a job in the status bar and can be cancelled there.
 */
export async function updateSubmodules(repoId: Id, targets: Submodule[] | null, options: { init: boolean }) {
  const one = targets?.length === 1 ? targets[0]! : null;
  const fresh = one?.state === "uninitialized";
  const label = one ? (fresh ? t("actions.submodules.update.initOne") : t("actions.submodules.update.one")) : t("actions.submodules.update.all");
  const jobId = newJobId();
  const result = await runAction(label, () => core.submoduleUpdate({ repoId, jobId, paths: targets ? targets.map((item) => item.path) : null, init: options.init }), {
    busyKey: submoduleBusyKey(repoId),
    job: {
      id: jobId,
      title: one
        ? fresh
          ? t("actions.submodules.fetchJob", { path: clip(one.path, 40) })
          : t("actions.submodules.updateJob", { path: clip(one.path, 40) })
        : t("actions.submodules.update.all"),
      repoId,
    },
    quiet: ["dirty_worktree"],
    success: (list) => {
      if (one) return t("actions.submodules.update.doneOne", { path: clip(one.path, 40) });
      const open = list.filter((item) => item.state !== "initialized").length;
      if (list.length === 0) return t("actions.submodules.update.none");
      return open ? t("actions.submodules.update.doneOpen", { count: open }) : t("actions.submodules.update.doneAll", { count: list.length });
    },
  });
  if (result.ok) {
    afterChange(repoId, result.value);
    return result;
  }
  if (result.error.code === "dirty_worktree") {
    toast({
      tone: "danger",
      title: t("actions.hosts.failed", { label }),
      description: `${result.error.message || t("actions.submodules.update.dirty")}\n${t("actions.submodules.update.dirtyHint")}`,
    });
  }
  void queryClient.invalidateQueries({ queryKey: qk.submodules(repoId) });
  return result;
}

/** Full path of a submodule on disk, or null if the repository is unknown. */
export function submoduleFolder(repoId: Id, submodule: Pick<Submodule, "path">): string | null {
  const repo = queryClient.getQueryData<Repo[]>(qk.repos)?.find((item) => item.id === repoId);
  if (!repo) return null;
  const separator = repo.path.includes("\\") ? "\\" : "/";
  return `${repo.path.replace(/[\\/]+$/, "")}${separator}${submodule.path.replace(/\//g, separator)}`;
}

/** Opens the submodule as a repository of its own in a tab. */
export async function openSubmodule(repoId: Id, submodule: Submodule) {
  if (submodule.state === "uninitialized") {
    toast({
      tone: "info",
      title: t("actions.submodules.open.notFetched", { path: clip(submodule.path, 40) }),
      description: t("actions.submodules.open.notFetchedDescription"),
      action: { label: t("actions.submodules.open.init"), onClick: () => void updateSubmodules(repoId, [submodule], { init: true }) },
    });
    return null;
  }
  const folder = submoduleFolder(repoId, submodule);
  if (!folder) {
    showError(t("actions.submodules.open.label"), { code: "not_found", message: t("actions.submodules.open.noFolder"), gitOutput: null });
    return null;
  }
  return openRepositoryAt(folder);
}

/**
 * Removes a submodule after a prompt. With local changes or a diverging commit a second prompt
 * follows; only then is it removed with `force`.
 */
export async function removeSubmodule(repoId: Id, submodule: Submodule) {
  const name = clip(submodule.path, 40);
  const ok = await confirm({
    title: t("actions.submodules.remove.title", { name }),
    body: submodule.url ? t("actions.submodules.remove.bodyUrl") : t("actions.submodules.remove.body"),
    details: submodule.url ? [submodule.path, submodule.url] : [submodule.path],
    detailsLabel: t("actions.submodules.remove.detailsLabel"),
    confirmLabel: t("actions.submodules.remove.action"),
    danger: true,
  });
  if (!ok) return null;

  // `reason`: the core's explanation when it refuses removal without `force` (e.g. unpushed commits).
  const askForce = (state: SubmoduleState, reason?: string) => {
    // The core's explanation mentions unpushed commits (German or English).
    const unpushed = reason !== undefined && /nicht gepusht|not pushed|unpushed/i.test(reason);
    return confirm({
      title: unpushed
        ? t("actions.submodules.force.titleUnpushed", { name })
        : state === "out_of_sync"
          ? t("actions.submodules.force.titleOutOfSync", { name })
          : t("actions.submodules.force.titleModified", { name }),
      body: unpushed
        ? t("actions.submodules.force.bodyUnpushed", { reason })
        : state === "out_of_sync"
          ? submodule.headSha
            ? t("actions.submodules.force.bodyOutOfSync", { head: shortSha(submodule.headSha), sha: shortSha(submodule.sha) })
            : t("actions.submodules.force.bodyOutOfSyncUnknown", { sha: shortSha(submodule.sha) })
          : t("actions.submodules.force.bodyModified"),
      details: [submodule.path],
      detailsLabel: t("actions.submodules.force.detailsLabel"),
      confirmLabel: t("actions.submodules.force.action"),
      danger: true,
    });
  };
  const run = (force: boolean) =>
    runAction(t("actions.submodules.remove.action"), () => core.submoduleRemove({ repoId, path: submodule.path, force }), {
      busyKey: submoduleBusyKey(repoId),
      quiet: ["dirty_worktree"],
      success: t("actions.submodules.remove.done", { name }),
    });

  // Fetch the state fresh: work may have happened in the submodule between display and click.
  const fresh = await core.submoduleList({ repoId }).catch(() => cachedList(repoId) ?? []);
  const current = fresh.find((item) => item.path === submodule.path) ?? submodule;
  const risky = current.state === "modified" || current.state === "out_of_sync";
  let force = false;
  if (risky) {
    if (!(await askForce(current.state))) return null;
    force = true;
  }
  let result = await run(force);
  if (!result.ok && result.error.code === "dirty_worktree" && !force) {
    if (!(await askForce("modified", result.error.message))) return null;
    result = await run(true);
  }
  if (!result.ok) {
    if (result.error.code === "dirty_worktree") showError(t("actions.submodules.remove.action"), result.error);
    return result;
  }
  afterChange(repoId, result.value);
  return result;
}
