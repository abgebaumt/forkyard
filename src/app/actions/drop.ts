/**
 * What happens after dragging a branch onto another (and likewise via the context menu):
 * merge, rebase, interactive rebase, push – each between two named refs.
 * The core always merges and plans for the checked-out branch; where another one is meant,
 * it is checked out first (with the offer to stash if changes are in the way).
 */
import type { Id, MergeMode, Ref } from "../../core";
import { useAppStore } from "../store";
import { checkout } from "./branches";
import { mergeBranch, rebaseOnto } from "./merge";
import { push } from "./sync";

/** Checks out `ref` unless it is already checked out. false = did not work or was declined. */
async function ensureCheckedOut(repoId: Id, ref: Ref, tabId: Id | null | undefined): Promise<boolean> {
  if (ref.isHead) return true;
  const result = await checkout(repoId, ref.name, { tabId });
  return Boolean(result?.ok);
}

/** Merges `source` into the local branch `target`. */
export async function mergeInto(repoId: Id, source: Ref, target: Ref, tabId?: Id | null, mode?: MergeMode) {
  if (!(await ensureCheckedOut(repoId, target, tabId))) return null;
  return mergeBranch(repoId, source.name, mode, tabId);
}

/** Rebases the local branch `source` onto `target`. */
export function rebaseBranchOnto(repoId: Id, source: Ref, target: Ref, tabId?: Id | null) {
  return rebaseOnto(repoId, target.name, source.isHead ? null : source.name, tabId);
}

/** Opens the rebase tool for the commits of `source` that are not in `target`. */
export async function interactiveRebaseOnto(repoId: Id, source: Ref, target: Ref, tabId: Id) {
  if (!(await ensureCheckedOut(repoId, source, tabId))) return false;
  useAppStore.getState().openRebase(tabId, target.name, "interactive");
  return true;
}

/** Name of the branch on the remote: `origin/feature/x` → `feature/x`. */
export function remoteBranchName(ref: Ref): string {
  return ref.remote && ref.name.startsWith(`${ref.remote}/`) ? ref.name.slice(ref.remote.length + 1) : ref.name;
}

/** Pushes the local branch `source` to the remote branch `target` and records it as upstream. */
export function pushTo(repoId: Id, source: Ref, target: Ref, tabId?: Id | null) {
  if (!target.remote) return Promise.resolve(null);
  // If the branch already tracks the target, it is an ordinary push (with "rejected → pull or force").
  if (source.upstream === target.name) return push(repoId, { branch: source.isHead ? null : source.name, tabId });
  return push(repoId, { branch: source.isHead ? null : source.name, remote: target.remote, remoteBranch: remoteBranchName(target), tabId });
}
