/**
 * Development build only: access to menus, actions and commands for the E2E driver
 * (scripts/e2e) and the console – as long as the graph and the Left Panel do not open the menus
 * themselves, they can be triggered like this:
 *
 *   __gcUi.openMenuAt({ x: 400, y: 200 }, __gcUi.menus.commitMenu({ repoId, tabId, shas }))
 *   __gcUi.runCommand("sync.push")
 */
import * as branches from "./actions/branches";
import { lastCopiedText } from "./actions/clipboard";
import * as drop from "./actions/drop";
import * as files from "./actions/files";
import * as history from "./actions/history";
import * as merge from "./actions/merge";
import * as remotes from "./actions/remotes";
import * as stash from "./actions/stash";
import * as sync from "./actions/sync";
import * as tags from "./actions/tags";
import * as undo from "./actions/undo";
import * as view from "./actions/view";
import * as menus from "./menus";
import { closeMenu, hasOpenMenu, openMenuAt, openMenuAtElement } from "./menus/host";
import { buildCommandContext, getCommands, isAvailable, runCommand } from "./registry";

const hooks = {
  menus,
  openMenuAt,
  openMenuAtElement,
  closeMenu,
  hasOpenMenu,
  runCommand,
  /** All commands with their shortcut and whether they are currently available. */
  commands: () => {
    const ctx = buildCommandContext("menu");
    return getCommands().map((command) => ({ id: command.id, title: command.title, group: command.group, shortcut: command.shortcut ?? null, available: isAvailable(command, ctx) }));
  },
  actions: { branches, drop, files, history, merge, remotes, stash, sync, tags, undo, view },
  lastCopiedText,
};

declare global {
  interface Window {
    __gcUi?: typeof hooks;
  }
}

export function installDevHooks(): void {
  if (import.meta.env.DEV && typeof window !== "undefined") window.__gcUi = hooks;
}
