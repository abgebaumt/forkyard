/**
 * Context menus as pure functions: context in, entries out.
 * Screens attach them to `<ContextMenu entries={…}>`; the entries call the
 * actions from `src/app/actions/`. That way Left Panel, graph, Commit Panel and
 * Command Palette show the same actions everywhere.
 *
 * The signatures here are fixed. The contents live in `./entries.tsx`.
 *
 * Opening a menu at a position (drop menu after dragging, menu from a command):
 * `openMenuAt({ x, y }, dropMenu({ … }))` from `./host`.
 */
import type { DiffSource, FileChange, Id, Ref, Remote, Sha, Stash } from "../../core";
import type { MenuEntry } from "../../ui/Menu";
import * as entries from "./entries";

export interface MenuBase {
  repoId: Id;
  tabId: Id;
}

/** Right-click on one or more commits in the graph. `shas` in selection order. */
export function commitMenu(ctx: MenuBase & { shas: Sha[] }): MenuEntry[] {
  return entries.commitMenu(ctx);
}

/** Right-click on the WIP row. */
export function wipMenu(ctx: MenuBase): MenuEntry[] {
  return entries.wipMenu(ctx);
}

/** Local or remote branch – in the Left Panel and on the ref label in the graph. (A tag gets the tag menu.) */
export function branchMenu(ctx: MenuBase & { ref: Ref }): MenuEntry[] {
  return entries.branchMenu(ctx);
}

/** Several local branches selected (delete). */
export function branchesMenu(ctx: MenuBase & { refs: Ref[] }): MenuEntry[] {
  return entries.branchesMenu(ctx);
}

export function tagMenu(ctx: MenuBase & { ref: Ref }): MenuEntry[] {
  return entries.tagMenu(ctx);
}

export function stashMenu(ctx: MenuBase & { stash: Stash }): MenuEntry[] {
  return entries.stashMenu(ctx);
}

/** Right-click on a reflog entry. `exists: false`: the commit is gone – only copying the SHA remains. */
export function reflogMenu(ctx: MenuBase & { sha: Sha; exists: boolean }): MenuEntry[] {
  return entries.reflogMenu(ctx);
}

export function remoteMenu(ctx: MenuBase & { remote: Remote }): MenuEntry[] {
  return entries.remoteMenu(ctx);
}

/** One or more files in a file list. `source` says where the list comes from. */
export function fileMenu(ctx: MenuBase & { files: FileChange[]; source: DiffSource }): MenuEntry[] {
  return entries.fileMenu(ctx);
}

/**
 * After dragging a branch (or ref label) onto another one:
 * merge, rebase, interactive rebase, push. Spells out both names.
 */
export function dropMenu(ctx: MenuBase & { source: Ref; target: Ref }): MenuEntry[] {
  return entries.dropMenu(ctx);
}

export { closeMenu, openMenuAt, openMenuAtElement } from "./host";
