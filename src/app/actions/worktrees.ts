/**
 * Actions for worktrees: open, lock, unlock, remove, prune.
 * The add dialog lives in src/screens/Worktrees (it calls `addWorktree` here).
 */
import { t } from "../../i18n";
import { core, type CoreError, type ErrorCode, type Id, type Repo, type Worktree } from "../../core";
import { toast } from "../../ui/Feedback";
import { confirm } from "../dialogs";
import { shortSha } from "../format";
import { qk, queryClient } from "../queries";
import { runAction, type ActionResult } from "../run";
import { useAppStore } from "../store";
import { clip } from "./context";
import { openRepositoryAt } from "./repos";

export const worktreeBusyKey = (repoId: Id) => `${repoId}:worktree`;

/** Last part of a path, without a trailing separator. */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Compare paths: separators don't matter, on Windows case doesn't either. */
export function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const left = norm(a);
  const right = norm(b);
  return /^[A-Za-z]:\//.test(left) || left.startsWith("//") ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** What is checked out in the worktree, as a short text. */
export function worktreeTarget(worktree: Pick<Worktree, "branch" | "head">): string {
  if (worktree.branch) return worktree.branch;
  return worktree.head ? t("actions.worktrees.detachedAt", { sha: shortSha(worktree.head) }) : t("actions.worktrees.noCommit");
}

const setList = (repoId: Id, list: Worktree[]) => queryClient.setQueryData(qk.worktrees(repoId), list);
const cachedList = (repoId: Id) => queryClient.getQueryData<Worktree[]>(qk.worktrees(repoId));

/** Opens the worktree as a repository of its own in a tab (or activates its tab). */
export async function openWorktree(worktree: Worktree) {
  if (worktree.isPrunable) {
    toast({
      tone: "warning",
      title: t("actions.worktrees.open.missing", { name: clip(folderName(worktree.path), 40) }),
      description: `${worktree.path}\n${t("actions.worktrees.open.missingHint")}`,
    });
    return null;
  }
  if (worktree.isCurrent) {
    toast({ tone: "info", title: t("actions.worktrees.open.current") });
    return null;
  }
  return openRepositoryAt(worktree.path);
}

export interface AddWorktreeInput {
  path: string;
  branch: string;
  newBranch: boolean;
  start: string | null;
}

/** Errors the dialog shows itself at the field. */
export const ADD_WORKTREE_QUIET: ErrorCode[] = ["not_allowed", "path_not_found", "path_exists", "invalid_name", "name_exists", "not_found", "io", "unknown"];

export async function addWorktree(repoId: Id, input: AddWorktreeInput): Promise<ActionResult<Worktree[]>> {
  await whenFree(repoId);
  const result = await runAction(t("actions.worktrees.add"), () => core.worktreeAdd({ repoId, ...input }), {
    busyKey: worktreeBusyKey(repoId),
    quiet: ADD_WORKTREE_QUIET,
  });
  if (result.ok) {
    setList(repoId, result.value);
    void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
  }
  return result;
}

/** Shows a change to a worktree immediately; what the core returns afterwards stays authoritative. */
function showAtOnce(repoId: Id, path: string, change: Partial<Worktree>) {
  const list = cachedList(repoId);
  if (list) setList(repoId, list.map((item) => (samePath(item.path, path) ? { ...item, ...change } : item)));
}

/** If a worktree action is already running for this repository, the next one waits instead of silently fizzling out. */
async function whenFree(repoId: Id): Promise<void> {
  const key = worktreeBusyKey(repoId);
  for (let round = 0; round < 200 && useAppStore.getState().busy[key]; round++) await new Promise((resolve) => window.setTimeout(resolve, 50));
}

export async function lockWorktree(repoId: Id, worktree: Worktree, reason: string | null) {
  const name = folderName(worktree.path);
  const clean = reason?.trim() || null;
  await whenFree(repoId);
  showAtOnce(repoId, worktree.path, { isLocked: true, lockReason: clean });
  const result = await runAction(t("actions.worktrees.lock.label"), () => core.worktreeLock({ repoId, path: worktree.path, reason: clean }), {
    busyKey: worktreeBusyKey(repoId),
    success: worktree.isLocked ? t("actions.worktrees.lock.reasonChanged", { name: clip(name, 40) }) : t("actions.worktrees.lock.done", { name: clip(name, 40) }),
  });
  if (result.ok) setList(repoId, result.value);
  else void queryClient.invalidateQueries({ queryKey: qk.worktrees(repoId) });
  return result;
}

export async function unlockWorktree(repoId: Id, worktree: Worktree) {
  await whenFree(repoId);
  showAtOnce(repoId, worktree.path, { isLocked: false, lockReason: null });
  const result = await runAction(t("actions.worktrees.unlock.label"), () => core.worktreeUnlock({ repoId, path: worktree.path }), {
    busyKey: worktreeBusyKey(repoId),
    success: t("actions.worktrees.unlock.done", { name: clip(folderName(worktree.path), 40) }),
  });
  if (result.ok) setList(repoId, result.value);
  else void queryClient.invalidateQueries({ queryKey: qk.worktrees(repoId) });
  return result;
}

/** Why a worktree cannot be removed – or null. */
export function removeBlock(worktree: Worktree): string | null {
  if (worktree.isMain) return t("actions.worktrees.block.main");
  if (worktree.isCurrent) return t("actions.worktrees.block.current");
  if (worktree.isLocked) return t("actions.worktrees.block.locked");
  return null;
}

/** Closes the tab and list entry of a worktree that was open as a repository. */
async function forgetOpened(path: string) {
  const repos = queryClient.getQueryData<Repo[]>(qk.repos) ?? (await core.repoList().catch(() => [] as Repo[]));
  const entry = repos.find((repo) => samePath(repo.path, path));
  if (!entry) return;
  await core.repoForget({ repoId: entry.id }).catch(() => undefined);
  void queryClient.invalidateQueries({ queryKey: qk.repos });
  void queryClient.invalidateQueries({ queryKey: qk.tabs });
}

/**
 * Removes a worktree after a prompt. If it has uncommitted changes, a second, clear warning
 * follows; only then is it removed with `force`.
 */
export async function removeWorktree(repoId: Id, worktree: Worktree) {
  const name = folderName(worktree.path);
  const blocked = removeBlock(worktree);
  if (blocked) {
    toast({ tone: "info", title: t("actions.worktrees.remove.blocked", { name: clip(name, 40) }), description: t("actions.worktrees.remove.reason", { reason: blocked }) });
    return null;
  }
  if (worktree.isPrunable) return pruneWorktrees(repoId);

  const keeps = worktree.branch ? t("actions.worktrees.remove.keepsBranch", { branch: worktree.branch }) : t("actions.worktrees.remove.keepsDetached");
  const ok = await confirm({
    title: t("actions.worktrees.remove.title", { name: clip(name, 40) }),
    body: t("actions.worktrees.remove.body", { keeps }),
    details: [worktree.path],
    detailsLabel: t("actions.worktrees.remove.detailsLabel"),
    confirmLabel: t("actions.worktrees.remove.action"),
    danger: true,
  });
  if (!ok) return null;

  const run = (force: boolean) =>
    runAction(t("actions.worktrees.remove.action"), () => core.worktreeRemove({ repoId, path: worktree.path, force }), {
      busyKey: worktreeBusyKey(repoId),
      quiet: ["dirty_worktree"],
      success: t("actions.worktrees.remove.done", { name: clip(name, 40) }),
    });
  const askForce = () =>
    confirm({
      title: t("actions.worktrees.force.title", { name: clip(name, 40) }),
      body: t("actions.worktrees.force.body"),
      details: [worktree.path],
      detailsLabel: t("actions.submodules.force.detailsLabel"),
      confirmLabel: t("actions.worktrees.force.action"),
      danger: true,
    });

  // Fetch the state fresh: the list may be older than the last change in the other folder.
  const fresh = await core.worktreeList({ repoId }).catch(() => cachedList(repoId) ?? []);
  const current = fresh.find((item) => samePath(item.path, worktree.path)) ?? worktree;
  let force = false;
  if (current.hasChanges) {
    if (!(await askForce())) return null;
    force = true;
  }
  // If the worktree itself was open as a repository, the app still watches its folder: close the tab
  // first, otherwise on Windows the watcher holds on to the folder.
  await forgetOpened(worktree.path);
  await whenFree(repoId);
  let result = await run(force);
  if (!result.ok && result.error.code === "dirty_worktree" && !force) {
    if (!(await askForce())) return null;
    result = await run(true);
  }
  if (!result.ok) {
    if (result.error.code === "dirty_worktree") reportDirty(result.error);
    return result;
  }
  setList(repoId, result.value);
  void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
  return result;
}

function reportDirty(error: CoreError) {
  toast({
    tone: "danger",
    title: t("actions.hosts.failed", { label: t("actions.worktrees.remove.action") }),
    description: error.message || t("actions.worktrees.remove.dirty"),
  });
}

/** Prunes entries whose folder is missing. Asks first and names the entries. */
export async function pruneWorktrees(repoId: Id) {
  const list = await core.worktreeList({ repoId }).catch(() => cachedList(repoId) ?? []);
  const orphans = list.filter((item) => item.isPrunable);
  if (orphans.length === 0) {
    setList(repoId, list);
    toast({ tone: "info", title: t("actions.worktrees.prune.nothing"), description: t("actions.worktrees.prune.nothingDescription") });
    return null;
  }
  const locked = orphans.filter((item) => item.isLocked);
  const removable = orphans.filter((item) => !item.isLocked);
  if (removable.length === 0) {
    toast({
      tone: "info",
      title: t("actions.worktrees.prune.nothing"),
      description: t("actions.worktrees.prune.allLocked", { count: locked.length }),
    });
    return null;
  }
  const ok = await confirm({
    title: t("actions.worktrees.prune.title", { count: removable.length }),
    body: locked.length
      ? `${t("actions.worktrees.prune.body", { count: removable.length })} ${t("actions.worktrees.prune.lockedStay", { count: locked.length })}`
      : t("actions.worktrees.prune.body", { count: removable.length }),
    details: removable.map((item) => item.path),
    detailsLabel: t("actions.worktrees.prune.detailsLabel"),
    confirmLabel: t("actions.lfs.prune.action"),
  });
  if (!ok) return null;
  await whenFree(repoId);
  const result = await runAction(t("actions.lfs.prune.action"), () => core.worktreePrune({ repoId }), {
    busyKey: worktreeBusyKey(repoId),
    success: (next) => {
      const gone = list.length - next.length;
      return gone > 0 ? t("actions.worktrees.prune.done", { count: gone }) : t("actions.worktrees.prune.nothing");
    },
  });
  if (result.ok) {
    setList(repoId, result.value);
    void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
  }
  return result;
}
