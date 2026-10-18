/**
 * Grows the index of the search by meaning after fetches and commits (spec 9.2: "inkrementell im
 * Hintergrund"): a `repo:changed` with `refs` or `head` starts a quiet period per repository; when it
 * ends and the search is shown for the repository, `update` runs – never twice at once, a change
 * during a run is caught up afterwards. Errors stay quiet (background work is no toast). The core
 * itself does nothing before the first search and never asks.
 */
export interface IndexScheduler {
  changed(repoId: string, what: readonly string[]): void;
  cancel(): void;
}

export interface IndexSchedulerOptions {
  delayMs: number;
  enabled: (repoId: string) => boolean;
  update: (repoId: string) => Promise<unknown>;
}

export function createIndexScheduler(options: IndexSchedulerOptions): IndexScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const again = new Set<string>();

  const schedule = (repoId: string) => {
    const previous = timers.get(repoId);
    if (previous !== undefined) clearTimeout(previous);
    timers.set(
      repoId,
      setTimeout(() => start(repoId), options.delayMs),
    );
  };

  const start = (repoId: string) => {
    timers.delete(repoId);
    if (!options.enabled(repoId)) return;
    if (running.has(repoId)) {
      again.add(repoId);
      return;
    }
    running.add(repoId);
    void options
      .update(repoId)
      .catch(() => undefined)
      .finally(() => {
        running.delete(repoId);
        if (again.delete(repoId)) schedule(repoId);
      });
  };

  return {
    changed(repoId, what) {
      if (what.some((item) => item === "refs" || item === "head")) schedule(repoId);
    },
    cancel() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      again.clear();
    },
  };
}
