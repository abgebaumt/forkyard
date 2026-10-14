/**
 * Actions for Git LFS: track patterns and untrack them again, fetch LFS files, prune.
 * The UI for this is src/screens/Lfs.
 */
import { t } from "../../i18n";
import { core, type ErrorCode, type Id, type LfsLock, type LfsLockFailure, type LfsLockList, type LfsLockOutcome, type LfsStatus } from "../../core";
import { forceUnlockConfirm } from "../../screens/Lfs/locks";
import { toast } from "../../ui/Feedback";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { newJobId, runAction, type ActionResult } from "../run";
import { useAppStore } from "../store";
import { clip } from "./context";

export const lfsBusyKey = (repoId: Id, what: "track" | "pull" | "prune" | "locks") => `${repoId}:lfs:${what}`;

function afterChange(repoId: Id, status: LfsStatus) {
  queryClient.setQueryData(qk.lfs(repoId), status);
  // File lists, menus and the commit panel decide by the patterns whether they read locks.
  queryClient.setQueryData(qk.lfsInUse(repoId), status);
  // The .gitattributes is now changed: the list of local changes shows that.
  void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
}

/** Errors the form shows at the field instead of as a message at the edge. */
const AT_FIELD: ErrorCode[] = ["not_allowed", "name_exists", "invalid_name"];

/**
 * Validates a pattern before it goes to Git. Returns the reason it is not usable, or null.
 * `existing` are the patterns already tracked.
 */
export function patternProblem(pattern: string, existing: string[]): string | null {
  const value = pattern.trim();
  if (!value) return t("actions.lfs.pattern.empty");
  if (/[\r\n]/.test(value)) return t("actions.lfs.pattern.multiline");
  if (value.startsWith("#")) return t("actions.lfs.pattern.comment");
  if (value.startsWith("!")) return t("actions.lfs.pattern.negation");
  if (value === "*" || value === "**" || value === "**/*") return t("actions.lfs.pattern.everything");
  if (existing.includes(value)) return t("actions.lfs.pattern.exists", { pattern: value });
  return null;
}

export async function trackPattern(repoId: Id, pattern: string): Promise<ActionResult<LfsStatus>> {
  const value = pattern.trim();
  const result = await runAction(t("actions.lfs.track.label"), () => core.lfsTrack({ repoId, pattern: value }), {
    busyKey: lfsBusyKey(repoId, "track"),
    quiet: AT_FIELD,
    success: t("actions.lfs.track.done", { pattern: clip(value, 40) }),
  });
  if (result.ok) afterChange(repoId, result.value);
  return result;
}

export async function untrackPattern(repoId: Id, pattern: string): Promise<ActionResult<LfsStatus>> {
  const result = await runAction(t("actions.lfs.untrack.label"), () => core.lfsUntrack({ repoId, pattern }), {
    busyKey: lfsBusyKey(repoId, "track"),
    quiet: ["not_found"],
    success: t("actions.lfs.untrack.done", { pattern: clip(pattern, 40) }),
  });
  if (result.ok) afterChange(repoId, result.value);
  // The pattern was already no longer there (edited by hand): simply fetch the state again.
  else if (result.error.code === "not_found") void queryClient.invalidateQueries({ queryKey: qk.lfs(repoId) });
  return result;
}

/** Fetches the contents behind the LFS pointers of the checked-out state. Job in the status bar, cancellable. */
export async function pullLfs(repoId: Id, jobId: string = newJobId()) {
  return runAction(t("actions.lfs.pull.label"), () => core.lfsPull({ repoId, jobId }), {
    busyKey: lfsBusyKey(repoId, "pull"),
    job: { id: jobId, title: t("actions.lfs.pull.label"), repoId },
    success: t("actions.lfs.pull.done"),
  });
}

/** Prunes the local LFS storage – after a prompt. */
export async function pruneLfs(repoId: Id) {
  const ok = await confirm({
    title: t("actions.lfs.prune.title"),
    body: t("actions.lfs.prune.body"),
    confirmLabel: t("actions.lfs.prune.action"),
  });
  if (!ok) return null;
  return runAction(t("actions.lfs.prune.label"), () => core.lfsPrune({ repoId }), {
    busyKey: lfsBusyKey(repoId, "prune"),
    success: (summary) => (summary.trim() ? t("actions.lfs.prune.doneSummary", { summary: clip(summary.trim(), 120) }) : t("actions.lfs.prune.done")),
  });
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/** The unfiltered lock list from the query cache (for menus); undefined while unknown. */
export function cachedLocks(repoId: Id): LfsLockList | undefined {
  return queryClient.getQueryData<LfsLockList>(qk.lfsLocks(repoId));
}

function afterLocks(repoId: Id, label: string, outcome: LfsLockOutcome) {
  // Filtered lists follow through `repo:changed` with `locks`.
  queryClient.setQueryData(qk.lfsLocks(repoId), outcome.locks);
  reportFailures(label, outcome.failed);
}

/** Paths that failed in an otherwise successful call: one warning with the reasons. */
function reportFailures(label: string, failed: LfsLockFailure[]) {
  if (failed.length === 0) return;
  toast({
    tone: "warning",
    title: t("actions.lfs.partial", { label, count: failed.length }),
    description: failed
      .slice(0, 5)
      .map((failure) => `${failure.path}: ${failure.reason}`)
      .join("\n"),
  });
}

/** Locks the files at the LFS server. */
export async function lockFiles(repoId: Id, paths: string[]): Promise<ActionResult<LfsLockOutcome>> {
  const label = t("actions.lfs.lock.label");
  const result = await runAction(label, () => core.lfsLock({ repoId, paths }), {
    busyKey: lfsBusyKey(repoId, "locks"),
    success: (outcome) => (outcome.failed.length === 0 ? t("actions.lfs.lock.done", { count: paths.length }) : null),
  });
  if (result.ok) afterLocks(repoId, label, result.value);
  return result;
}

/**
 * The locks on `paths` that belong to others. Looks in `known` (e.g. the list a panel shows), then
 * in every cached lock list (filtered ones too), and reads the list again for paths still unknown –
 * an empty answer must never come from a cache entry that was merely collected. If that read fails,
 * unknown paths count as other people's locks, so the prompt still comes.
 */
async function foreignLocks(repoId: Id, paths: string[], known: LfsLock[]): Promise<LfsLock[]> {
  const index = new Map<string, LfsLock>();
  const add = (locks: LfsLock[]) => {
    for (const lock of locks) if (!index.has(lock.path)) index.set(lock.path, lock);
  };
  add(known);
  add(cachedLocks(repoId)?.locks ?? []);
  for (const [, data] of queryClient.getQueriesData<LfsLockList>({ queryKey: qk.lfsLocksAll(repoId) })) add(data?.locks ?? []);
  let unknown = paths.filter((path) => !index.has(path));
  if (unknown.length > 0) {
    try {
      const fresh = await core.lfsLocks({ repoId, filter: null });
      queryClient.setQueryData(qk.lfsLocks(repoId), fresh);
      add(fresh.locks);
      // Read successfully and still not listed: nobody holds a lock on these paths.
      unknown = [];
    } catch {
      // Owner unknown: ask anyway.
    }
  }
  const unknownOwner = t("actions.lfs.forceUnlock.unknownOwner");
  return paths.flatMap((path) => {
    const lock = index.get(path);
    if (lock) return lock.ours ? [] : [lock];
    return unknown.includes(path) ? [{ id: "", path, owner: unknownOwner, lockedAt: null, ours: false }] : [];
  });
}

/**
 * Unlocks the files. With `force` and other people's locks among them, it asks first (owner and
 * file named); `null` = declined. `known` are locks the caller already shows (the panel's list).
 */
export async function unlockFiles(repoId: Id, paths: string[], force: boolean, known: LfsLock[] = []): Promise<ActionResult<LfsLockOutcome> | null> {
  if (force) {
    const foreign = await foreignLocks(repoId, paths, known);
    if (foreign.length > 0 && !(await confirm(forceUnlockConfirm(foreign)))) return null;
  }
  const label = t("actions.lfs.unlock.label");
  const result = await runAction(label, () => core.lfsUnlock({ repoId, paths, force }), {
    busyKey: lfsBusyKey(repoId, "locks"),
    success: (outcome) => (outcome.failed.length === 0 ? t("actions.lfs.unlock.done", { count: paths.length }) : null),
  });
  if (result.ok) afterLocks(repoId, label, result.value);
  return result;
}

/**
 * Reads the locks from the server again – may ask for credentials. Errors show up as the state of
 * the lock list (the core has dropped its list, so the next read reports them), not as a toast.
 */
export async function refreshLocks(repoId: Id): Promise<void> {
  const key = lfsBusyKey(repoId, "locks");
  if (useAppStore.getState().busy[key]) return;
  useAppStore.getState().setBusy(key, true);
  try {
    queryClient.setQueryData(qk.lfsLocks(repoId), await core.lfsLocks({ repoId, filter: null, refresh: true }));
  } catch {
    // Shown by the lock list after the invalidation below.
  } finally {
    useAppStore.getState().setBusy(key, false);
    void queryClient.invalidateQueries({ queryKey: qk.lfsLocksAll(repoId) });
  }
}
