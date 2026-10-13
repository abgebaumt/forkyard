/**
 * The ONE place through which command results reach the status cache.
 *
 * Many commands return the new status along with their result (stage, checkout, discard …).
 * Writing it straight into the cache saves a query – but a late answer must not overwrite a
 * newer state. Hence:
 *
 *   const result = await runAction("Stage", withStatus(repoId, () => core.stagePaths({ repoId, paths })));
 *
 * `withStatus` remembers when it was sent and takes over the result only if nothing newer has
 * been loaded since; otherwise it reloads. Commands WITHOUT status in their result (pull, merge,
 * commit …) use `withFreshStatus`: the status has then already been reloaded when the success
 * toast appears – the toolbar never briefly shows an in-between state.
 */
import type { Id, Status } from "../core";
import { qk, queryClient } from "./queries";
import { orderOf, readStatusOrdered, sameStatus, tick } from "./statusOrder";

export interface StatusTicket {
  repoId: Id;
  /** Number assigned when sent (see statusOrder.ts). */
  seq: number;
}

/** Take this immediately BEFORE sending a command that returns the status. */
export function statusTicket(repoId: Id): StatusTicket {
  return { repoId, seq: tick() };
}

/**
 * Takes a command's result into the cache. Returns false if something newer (or possibly
 * newer) has been loaded in the meantime – then the cache stays as it is and the status is
 * fetched again.
 */
export function applyStatus(ticket: StatusTicket, status: Status): boolean {
  const key = qk.status(ticket.repoId);
  const entry = orderOf(ticket.repoId);
  const cached = queryClient.getQueryData<Status>(key);
  if (cached && entry.asOf > ticket.seq) {
    if (sameStatus(cached, status)) return true;
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
    return false;
  }
  entry.asOf = Math.max(entry.asOf, ticket.seq);
  entry.applied += 1;
  entry.last = status;
  queryClient.setQueryData(key, status);
  return true;
}

/** Wraps a command that returns the new status: take a ticket, send, take over the result in order. */
export function withStatus(repoId: Id, send: () => Promise<Status>): () => Promise<Status> {
  return async () => {
    const ticket = statusTicket(repoId);
    const status = await send();
    applyStatus(ticket, status);
    return status;
  };
}

/**
 * Reloads the status now and waits for it. A query already in flight is discarded – it may date
 * from before the action. Errors stay silent: the display then has its own error state.
 */
export async function refreshStatus(repoId: Id): Promise<void> {
  await queryClient.refetchQueries({ queryKey: qk.status(repoId), exact: true }).catch(() => undefined);
}

/** Wraps a command WITHOUT status in its result: after success, the status is reloaded before continuing. */
export function withFreshStatus<T>(repoId: Id, send: () => Promise<T>): () => Promise<T> {
  return async () => {
    const value = await send();
    await refreshStatus(repoId);
    return value;
  };
}

/**
 * Fresh status for actions that must not rely on the cache – asked directly from the core (a
 * query through the query client could be aborted by a concurrent `repo:changed`). Lands in the
 * cache if nothing newer is there by then.
 */
export async function loadStatus(repoId: Id): Promise<Status> {
  const { status, started } = await readStatusOrdered(repoId);
  const key = qk.status(repoId);
  if (orderOf(repoId).asOf > started) return queryClient.getQueryData<Status>(key) ?? status;
  queryClient.setQueryData(key, status);
  return status;
}
