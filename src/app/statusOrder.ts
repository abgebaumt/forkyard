/**
 * Ordering for a repository's status.
 *
 * The status reaches the cache in two ways: as a query (`statusGet`, triggered by events from
 * the core) and as the result of a command (stage, checkout, discard …). Both run side by side,
 * and whoever arrives last is not necessarily the newer one. This file keeps track of that –
 * with a clock that only counts:
 *
 * - Every query and every command gets a number when it is SENT.
 * - `asOf` is the number of what is in the cache.
 * - A command result is only taken over if nothing that started later has landed in the cache
 *   since it was sent (see statusCache.ts).
 * - A query during which a command result was taken over may be older than that result. If it
 *   differs from it, it asks again instead of overwriting the newer state.
 *
 * No dependency on queries.ts, so that `useStatus` can read from here.
 */
import { replaceEqualDeep } from "@tanstack/react-query";
import { core, type Id, type Status } from "../core";

interface Entry {
  /** Number of what is in the cache (or is about to land there). */
  asOf: number;
  /** Counts command results taken over. */
  applied: number;
  /** The most recently taken-over command result. */
  last: Status | null;
}

let clock = 0;
const entries = new Map<Id, Entry>();

/** Next number of the clock. */
export const tick = (): number => ++clock;

export function orderOf(repoId: Id): Entry {
  let entry = entries.get(repoId);
  if (!entry) {
    entry = { asOf: 0, applied: 0, last: null };
    entries.set(repoId, entry);
  }
  return entry;
}

/** Equal in content (field by field). */
export const sameStatus = (a: Status, b: Status): boolean => replaceEqualDeep(a, b) === a;

/** How often a query asks again at most when commands get in between. */
const MAX_REREADS = 2;

export interface StatusRead {
  status: Status;
  /** Number this query started with. */
  started: number;
}

/** Asks the core; see the top of the file. With `signal`, an aborted query does not count as loaded. */
export async function readStatusOrdered(repoId: Id, signal?: AbortSignal): Promise<StatusRead> {
  const entry = orderOf(repoId);
  for (let attempt = 0; ; attempt += 1) {
    const started = tick();
    const appliedBefore = entry.applied;
    const status = await core.statusGet({ repoId });
    const overtaken = entry.applied !== appliedBefore && entry.last !== null && !sameStatus(entry.last, status);
    if (overtaken && attempt < MAX_REREADS && !signal?.aborted) continue;
    if (!signal?.aborted) entry.asOf = Math.max(entry.asOf, started);
    return { status, started };
  }
}

/** For `useStatus`: the status, in the right order relative to command results. */
export const readStatus = (repoId: Id, signal?: AbortSignal): Promise<Status> => readStatusOrdered(repoId, signal).then((read) => read.status);

/** Tests only. */
export function resetStatusOrder(): void {
  clock = 0;
  entries.clear();
}
