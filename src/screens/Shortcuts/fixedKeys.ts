/**
 * Fixed keys of the lists and views – they are not in the command registry because they only
 * apply while focus is in the respective list or view. Taken from the screens' keyboard handlers
 * (left panel, graph, local changes, diff, file, history, blame, conflict tool, rebase tool,
 * search); whoever adds a key there adds it here.
 *
 * `keys`: alternatives (each in shortcut notation, "Mod" = Ctrl or ⌘).
 */
import { t } from "../../i18n";

export interface FixedKey {
  keys: string[];
  label: string;
}

export interface FixedKeyGroup {
  id: string;
  title: string;
  /** Where it applies, as a short sentence below the heading. */
  where: string;
  entries: FixedKey[];
}

export const fixedKeyGroups: FixedKeyGroup[] = [
  {
    id: "graph",
    title: t("shortcuts.fixed.graph.title"),
    where: t("shortcuts.fixed.graph.where"),
    entries: [
      { keys: ["ArrowDown", "J"], label: t("shortcuts.fixed.graph.entries.next") },
      { keys: ["ArrowUp", "K"], label: t("shortcuts.fixed.graph.entries.previous") },
      { keys: ["H"], label: t("shortcuts.fixed.graph.entries.parent") },
      { keys: ["L"], label: t("shortcuts.fixed.graph.entries.child") },
      { keys: ["Shift+ArrowDown", "Shift+ArrowUp"], label: t("shortcuts.fixed.graph.entries.extendSelection") },
      { keys: ["PageDown", "PageUp"], label: t("shortcuts.fixed.graph.entries.page") },
      { keys: ["Home", "End"], label: t("shortcuts.fixed.graph.entries.firstLast") },
      { keys: ["Enter"], label: t("shortcuts.fixed.graph.entries.openDetails") },
      { keys: ["B"], label: t("shortcuts.fixed.graph.entries.highlightBranch") },
      { keys: ["ContextMenu", "Shift+F10"], label: t("shortcuts.fixed.graph.entries.contextMenu") },
    ],
  },
  {
    id: "lists",
    title: t("shortcuts.fixed.lists.title"),
    where: t("shortcuts.fixed.lists.where"),
    entries: [
      { keys: ["ArrowDown", "ArrowUp"], label: t("shortcuts.fixed.lists.entries.move") },
      { keys: ["ArrowRight", "ArrowLeft"], label: t("shortcuts.fixed.lists.entries.expandCollapse") },
      { keys: ["Enter"], label: t("shortcuts.fixed.lists.entries.mainAction") },
      { keys: ["Space"], label: t("shortcuts.fixed.lists.entries.mark") },
      { keys: ["Shift+ArrowDown"], label: t("shortcuts.fixed.lists.entries.markMore") },
      { keys: ["Mod+A"], label: t("shortcuts.fixed.lists.entries.markAll") },
      { keys: ["F2"], label: t("shortcuts.fixed.lists.entries.renameBranch") },
      { keys: ["Delete"], label: t("shortcuts.fixed.lists.entries.delete") },
      { keys: ["Mod+Alt+F"], label: t("shortcuts.fixed.lists.entries.filter") },
      { keys: ["ContextMenu", "Shift+F10"], label: t("shortcuts.fixed.lists.entries.contextMenu") },
    ],
  },
  {
    id: "wip",
    title: t("shortcuts.fixed.wip.title"),
    where: t("shortcuts.fixed.wip.where"),
    entries: [
      { keys: ["S"], label: t("shortcuts.fixed.wip.entries.stage") },
      { keys: ["U"], label: t("shortcuts.fixed.wip.entries.unstage") },
      { keys: ["Delete"], label: t("shortcuts.fixed.wip.entries.discard") },
      { keys: ["Mod+Enter"], label: t("shortcuts.fixed.wip.entries.commit") },
      { keys: ["Mod+Shift+Enter"], label: t("shortcuts.fixed.wip.entries.stageAllCommit") },
      { keys: ["ArrowLeft", "ArrowRight"], label: t("shortcuts.fixed.wip.entries.toggleCommitStash") },
    ],
  },
  {
    id: "diff",
    title: t("shortcuts.fixed.diff.title"),
    where: t("shortcuts.fixed.diff.where"),
    entries: [
      { keys: ["F7", "Alt+ArrowDown"], label: t("shortcuts.fixed.diff.entries.nextChange") },
      { keys: ["Shift+F7", "Alt+ArrowUp"], label: t("shortcuts.fixed.diff.entries.previousChange") },
      { keys: ["Alt+ArrowRight", "Alt+ArrowLeft"], label: t("shortcuts.fixed.diff.entries.nextPreviousFile") },
      { keys: ["Space"], label: t("shortcuts.fixed.diff.entries.markLine") },
      { keys: ["Shift+ArrowDown", "Shift+ArrowUp"], label: t("shortcuts.fixed.diff.entries.markLines") },
      { keys: ["Enter"], label: t("shortcuts.fixed.diff.entries.stage") },
      { keys: ["S", "U"], label: t("shortcuts.fixed.diff.entries.stageUnstage") },
      { keys: ["Delete"], label: t("shortcuts.fixed.diff.entries.discard") },
      { keys: ["Escape"], label: t("shortcuts.fixed.diff.entries.escape") },
    ],
  },
  {
    id: "search",
    title: t("shortcuts.fixed.search.title"),
    where: t("shortcuts.fixed.search.where"),
    entries: [
      { keys: ["Enter", "F3"], label: t("shortcuts.fixed.search.entries.next") },
      { keys: ["Shift+Enter", "Shift+F3"], label: t("shortcuts.fixed.search.entries.previous") },
      { keys: ["ArrowDown", "ArrowUp"], label: t("shortcuts.fixed.search.entries.mark") },
      { keys: ["Escape"], label: t("shortcuts.fixed.search.entries.close") },
    ],
  },
  {
    id: "conflict",
    title: t("shortcuts.fixed.conflict.title"),
    where: t("shortcuts.fixed.conflict.where"),
    entries: [
      { keys: ["F7", "Alt+ArrowDown"], label: t("shortcuts.fixed.conflict.entries.next") },
      { keys: ["Shift+F7", "Alt+ArrowUp"], label: t("shortcuts.fixed.conflict.entries.previous") },
      { keys: ["Alt+ArrowRight", "Alt+ArrowLeft"], label: t("shortcuts.fixed.conflict.entries.nextPreviousFile") },
      { keys: ["ArrowLeft", "ArrowRight"], label: t("shortcuts.fixed.conflict.entries.switchSide") },
      { keys: ["Space", "Enter"], label: t("shortcuts.fixed.conflict.entries.take") },
      { keys: ["T"], label: t("shortcuts.fixed.conflict.entries.swapOrder") },
      { keys: ["Mod+F"], label: t("shortcuts.fixed.conflict.entries.find") },
      { keys: ["Mod+S"], label: t("shortcuts.fixed.conflict.entries.resolved") },
      { keys: ["Escape"], label: t("shortcuts.fixed.conflict.entries.close") },
    ],
  },
  {
    id: "rebase",
    title: t("shortcuts.fixed.rebase.title"),
    where: t("shortcuts.fixed.rebase.where"),
    entries: [
      { keys: ["P"], label: t("shortcuts.fixed.rebase.entries.pick") },
      { keys: ["R"], label: t("shortcuts.fixed.rebase.entries.reword") },
      { keys: ["S"], label: t("shortcuts.fixed.rebase.entries.squash") },
      { keys: ["D"], label: t("shortcuts.fixed.rebase.entries.drop") },
      { keys: ["Alt+ArrowUp", "Alt+ArrowDown"], label: t("shortcuts.fixed.rebase.entries.move") },
      { keys: ["Enter"], label: t("shortcuts.fixed.rebase.entries.editMessage") },
      { keys: ["Space"], label: t("shortcuts.fixed.rebase.entries.chooseAction") },
      { keys: ["Mod+Enter"], label: t("shortcuts.fixed.rebase.entries.start") },
      { keys: ["Escape"], label: t("shortcuts.fixed.rebase.entries.close") },
    ],
  },
  {
    id: "history",
    title: t("shortcuts.fixed.history.title"),
    where: t("shortcuts.fixed.history.where"),
    entries: [
      { keys: ["Enter"], label: t("shortcuts.fixed.history.entries.openDiff") },
      { keys: ["B"], label: t("shortcuts.fixed.history.entries.blame") },
      { keys: ["G"], label: t("shortcuts.fixed.history.entries.showInGraph") },
      { keys: ["Escape"], label: t("shortcuts.fixed.history.entries.close") },
    ],
  },
  {
    id: "blame",
    title: t("shortcuts.fixed.blame.title"),
    where: t("shortcuts.fixed.blame.where"),
    entries: [
      { keys: ["ArrowDown", "ArrowUp"], label: t("shortcuts.fixed.blame.entries.move") },
      { keys: ["Enter"], label: t("shortcuts.fixed.blame.entries.showInGraph") },
      { keys: ["P"], label: t("shortcuts.fixed.blame.entries.parentBlame") },
      { keys: ["I"], label: t("shortcuts.fixed.blame.entries.card") },
      { keys: ["Escape"], label: t("shortcuts.fixed.blame.entries.close") },
    ],
  },
  {
    id: "file",
    title: t("shortcuts.fixed.file.title"),
    where: t("shortcuts.fixed.file.where"),
    entries: [
      { keys: ["Mod+S"], label: t("shortcuts.fixed.file.entries.save") },
      { keys: ["Mod+Shift+H"], label: t("shortcuts.fixed.file.entries.history") },
      { keys: ["Escape"], label: t("shortcuts.fixed.file.entries.close") },
    ],
  },
  {
    id: "terminal",
    title: t("shortcuts.fixed.terminal.title"),
    where: t("shortcuts.fixed.terminal.where"),
    entries: [
      { keys: ["F6", "Shift+F6"], label: t("shortcuts.fixed.terminal.entries.leaveNextPrevious") },
      { keys: ["Alt+1", "Alt+2", "Alt+3"], label: t("shortcuts.fixed.terminal.entries.leaveArea") },
      { keys: ["Mod+Shift+C"], label: t("shortcuts.fixed.terminal.entries.copy") },
      { keys: ["Mod+Shift+V", "Shift+Insert"], label: t("shortcuts.fixed.terminal.entries.paste") },
      { keys: ["Shift+PageUp", "Shift+PageDown"], label: t("shortcuts.fixed.terminal.entries.scroll") },
      { keys: ["ContextMenu", "Shift+F10"], label: t("shortcuts.fixed.terminal.entries.contextMenu") },
      { keys: ["ArrowUp", "ArrowDown"], label: t("shortcuts.fixed.terminal.entries.resize") },
    ],
  },
  {
    id: "tabs",
    title: t("shortcuts.fixed.tabs.title"),
    where: t("shortcuts.fixed.tabs.where"),
    entries: [
      { keys: ["ArrowLeft", "ArrowRight"], label: t("shortcuts.fixed.tabs.entries.previousNext") },
      { keys: ["Home", "End"], label: t("shortcuts.fixed.tabs.entries.firstLast") },
      { keys: ["Mod+Shift+ArrowLeft", "Mod+Shift+ArrowRight"], label: t("shortcuts.fixed.tabs.entries.move") },
      { keys: ["F2"], label: t("shortcuts.fixed.tabs.entries.rename") },
      { keys: ["Delete"], label: t("shortcuts.fixed.tabs.entries.close") },
      { keys: ["ContextMenu", "Shift+F10"], label: t("shortcuts.fixed.tabs.entries.contextMenu") },
    ],
  },
  {
    id: "palette",
    title: t("shortcuts.fixed.palette.title"),
    where: t("shortcuts.fixed.palette.where"),
    entries: [
      { keys: [">"], label: t("shortcuts.fixed.palette.entries.commands") },
      { keys: ["@"], label: t("shortcuts.fixed.palette.entries.refs") },
      { keys: ["/"], label: t("shortcuts.fixed.palette.entries.files") },
      { keys: ["#"], label: t("shortcuts.fixed.palette.entries.commits") },
      { keys: ["~"], label: t("shortcuts.fixed.palette.entries.repositories") },
      { keys: ["Tab"], label: t("shortcuts.fixed.palette.entries.moreActions") },
      { keys: ["Escape"], label: t("shortcuts.fixed.palette.entries.back") },
    ],
  },
  {
    id: "dialogs",
    title: t("shortcuts.fixed.dialogs.title"),
    where: t("shortcuts.fixed.dialogs.where"),
    entries: [
      { keys: ["Enter"], label: t("shortcuts.fixed.dialogs.entries.confirm") },
      { keys: ["Escape"], label: t("shortcuts.fixed.dialogs.entries.close") },
      { keys: ["Tab", "Shift+Tab"], label: t("shortcuts.fixed.dialogs.entries.nextPrevious") },
      { keys: ["Mod+."], label: t("shortcuts.fixed.dialogs.entries.selectionMenu") },
    ],
  },
];

const KEY_NAMES: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: t("shortcuts.keyNames.pageUp"),
  PageDown: t("shortcuts.keyNames.pageDown"),
  Home: t("shortcuts.keyNames.home"),
  End: t("shortcuts.keyNames.end"),
  Delete: t("shortcuts.keyNames.delete"),
  Insert: t("shortcuts.keyNames.insert"),
  Backspace: t("shortcuts.keyNames.backspace"),
  Escape: "Esc",
  Space: t("shortcuts.keyNames.space"),
  ContextMenu: t("shortcuts.keyNames.contextMenu"),
};

/** Make key names readable ("Alt+ArrowUp" → "Alt+↑"); Kbd then handles Mod/Ctrl/⌘. */
export function displayShortcut(shortcut: string): string {
  if (shortcut === "+" || shortcut.length === 1) return shortcut;
  return shortcut
    .split("+")
    .map((part) => KEY_NAMES[part] ?? part)
    .join("+");
}
