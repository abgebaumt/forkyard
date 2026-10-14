/**
 * LFS file locks for the UI: when they are read on their own, the index by path, and (in later
 * functions of this file) what file lists, menus, the commit panel and the LFS panel make of them.
 * Pure functions plus `useLockIndex`; the actions are in app/actions/lfs.ts.
 */
import { useMemo } from "react";
import type { FileChange, Id, LfsLock, LfsLockList, LfsStatus } from "../../core";
import { useLfsInUse, useLfsLocks } from "../../app/queries";
import type { ConfirmOptions } from "../../app/dialogs";
import { t } from "../../i18n";
import type { FileLock } from "../../components/FileList";

export type LockIndex = ReadonlyMap<string, LfsLock>;

export const EMPTY_LOCKS: LockIndex = new Map();

/** File lists, menus and the commit panel read locks on their own only where LFS is in use. */
export function locksWanted(status: LfsStatus | undefined): boolean {
  return Boolean(status?.installed && status.patterns.length > 0);
}

export function lockIndex(list: LfsLockList | undefined): LockIndex {
  if (!list) return EMPTY_LOCKS;
  return new Map(list.locks.map((lock) => [lock.path, lock]));
}

/** The locks of the repository by path – empty while unknown, without LFS or on errors. */
export function useLockIndex(repoId: Id | null | undefined): LockIndex {
  const { data: lfs } = useLfsInUse(repoId);
  const { data } = useLfsLocks(repoId, null, locksWanted(lfs));
  return useMemo(() => lockIndex(data), [data]);
}

/** Prompt before forcing other people's locks: names owner and file of each. */
export function forceUnlockConfirm(foreign: LfsLock[]): ConfirmOptions {
  return {
    title: t("actions.lfs.forceUnlock.title", { count: foreign.length, owner: foreign[0]?.owner ?? "" }),
    body: t("actions.lfs.forceUnlock.body"),
    confirmLabel: t("actions.lfs.forceUnlock.action"),
    danger: true,
    details: foreign.map((lock) => `${lock.path} – ${lock.owner}`),
    detailsLabel: t("actions.lfs.forceUnlock.details"),
  };
}

export interface PanelActions {
  /** “Unlock”: the selected own locks. */
  unlock: string[];
  /** “Force unlock …”: everything selected. */
  force: string[];
  /** How many of the selected locks belong to others (they need the prompt). */
  foreign: number;
}

/** What the buttons below the lock list do with the selection (in list order). */
export function panelActions(locks: LfsLock[], selected: ReadonlySet<string>): PanelActions {
  const chosen = locks.filter((lock) => selected.has(lock.path));
  return {
    unlock: chosen.filter((lock) => lock.ours).map((lock) => lock.path),
    force: chosen.map((lock) => lock.path),
    foreign: chosen.filter((lock) => !lock.ours).length,
  };
}

/** What a file row shows for a lock: symbol (own or someone else's) and the tooltip text. */
export function fileLock(lock: LfsLock | undefined): FileLock | undefined {
  if (!lock) return undefined;
  return { ours: lock.ours, label: lock.ours ? t("lfs.locks.byYou") : t("lfs.locks.byOther", { owner: lock.owner }) };
}

export interface LockMenuState {
  /** Not locked by anyone: "Lock". */
  lockable: string[];
  /** Locked by you: "Unlock". */
  ownLocked: string[];
  /** Locked by others: "Force unlock …". */
  foreignLocked: LfsLock[];
}

/** Sorts the files of a context menu by their lock state (order kept). */
export function lockMenuState(paths: string[], index: LockIndex): LockMenuState {
  const state: LockMenuState = { lockable: [], ownLocked: [], foreignLocked: [] };
  for (const path of paths) {
    const lock = index.get(path);
    if (!lock) state.lockable.push(path);
    else if (lock.ours) state.ownLocked.push(path);
    else state.foreignLocked.push(lock);
  }
  return state;
}

/** Staged files someone else has locked (in the order of the staged list). */
export function foreignStaged(staged: FileChange[], index: LockIndex): LfsLock[] {
  const out: LfsLock[] = [];
  for (const file of staged) {
    const lock = index.get(file.path);
    if (lock && !lock.ours) out.push(lock);
  }
  return out;
}

/** The commit panel's warning; null when there is nothing to warn about. Committing stays possible. */
export function foreignWarning(locks: LfsLock[]): string | null {
  const first = locks[0];
  if (!first) return null;
  if (locks.length === 1) return t("wip.form.lockedByOther", { path: first.path, owner: first.owner });
  const owners = [...new Set(locks.map((lock) => lock.owner))].join(", ");
  return t("wip.form.lockedByOthers", { count: locks.length, owners });
}
