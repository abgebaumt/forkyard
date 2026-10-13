/**
 * Ordering for changes to settings, profiles and signing details.
 *
 * Writing: changes run one after another – each builds on the state the previous one left
 * behind.
 *
 * Reading: queries for the same data wait with `writesSettled()` until no change is in flight.
 * Without this, a query overtook a change: the core reports every change as an event, and the
 * event of the previous change sometimes only arrived while the next one was already running.
 * The query it triggered then read the state BEFORE the running change and overwrote the
 * optimistic value in the cache. A field that compares its text with this value took the next
 * input for "unchanged" and did not save it (measured in the repository settings: clear the
 * name, enter the same name again – in 3 of 30 attempts `user.name` stayed empty while the
 * field showed the name).
 */
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;

/** Appends a change to the end of the queue and returns its result. */
export function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  pending += 1;
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    pending -= 1;
  });
  return result;
}

/** Waits until no change is in flight. For the queries of the data written here. */
export async function writesSettled(): Promise<void> {
  while (pending > 0) await queue;
}
