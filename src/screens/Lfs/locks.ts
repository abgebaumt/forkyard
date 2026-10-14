/**
 * LFS file locks for the UI: when they are read on their own, the index by path, and (in later
 * functions of this file) what file lists, menus, the commit panel and the LFS panel make of them.
 * Pure functions plus `useLockIndex`; the actions are in app/actions/lfs.ts.
 */
import { useMemo } from "react";
import type { Id, LfsLock, LfsLockList, LfsStatus } from "../../core";
import { useLfsInUse, useLfsLocks } from "../../app/queries";

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
