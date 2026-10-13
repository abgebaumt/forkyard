import type { Id } from "../../core";

/** Keys for runAction › busyKey, so that toolbar and menus see the same lock. */
export const busyKeys = {
  fetch: (repoId: Id) => `${repoId}:fetch`,
  pull: (repoId: Id) => `${repoId}:pull`,
  push: (repoId: Id) => `${repoId}:push`,
  stash: (repoId: Id) => `${repoId}:stash`,
  pop: (repoId: Id) => `${repoId}:pop`,
  undo: (repoId: Id) => `${repoId}:undo`,
  branch: (repoId: Id) => `${repoId}:branch`,
  /**
   * Everything that rebuilds history or the checked-out state (checkout, merge, rebase, reset, revert,
   * cherry-pick, squash): at most one of them at a time, a second click fizzles out.
   */
  history: (repoId: Id) => `${repoId}:history`,
  /** All other write actions of a repo. */
  write: (repoId: Id, name: string) => `${repoId}:${name}`,
  openRepo: "app:openRepo",
};

/** The network actions of a repo; while one runs, the others wait for the same lock in the core anyway. */
export const syncKeys = (repoId: Id) => [busyKeys.fetch(repoId), busyKeys.pull(repoId), busyKeys.push(repoId)];
