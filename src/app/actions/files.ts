import { t } from "../../i18n";
import { core, type ExternalTarget, type FileChange, type Id, type Status, type Tab } from "../../core";
import { toast } from "../../ui/Feedback";
import { askIgnore, type IgnoreSuggestion } from "../actionDialogs";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { withStatus } from "../statusCache";
import { getTabView, useAppStore } from "../store";
import { cachedStatus, clip, clipMiddle, loadStatus } from "./context";
import { abortOperation, operationNames } from "./merge";
import { stashChanges } from "./stash";

/**
 * If the centre shows the diff of a file from "Unstaged" or "Staged" that no longer exists there
 * after an action ("Stage all", commit, discard via the context menu), it follows the file: to the
 * diff of the same file in the other list – or back to the graph. Otherwise a stale diff would
 * remain ("No content changes …") and hide, e.g., the new commit.
 * `after` is the status the action itself returned – at this moment the cache may still show
 * the state before (a concurrent query was faster). Without `after` the cache applies.
 */
export function followVanishedDiff(repoId: Id, after?: Status): void {
  const status = after ?? cachedStatus(repoId);
  if (!status) return;
  const tabs = queryClient.getQueryData<Tab[]>(qk.tabs) ?? [];
  for (const tab of tabs) {
    if (tab.repoId !== repoId) continue;
    const center = getTabView(tab.id).center;
    if (center.kind !== "diff" || (center.source.kind !== "unstaged" && center.source.kind !== "staged")) continue;
    const here = center.source.kind === "unstaged" ? status.unstaged : status.staged;
    if (here.some((file) => file.path === center.path)) continue;
    const there = center.source.kind === "unstaged" ? status.staged : status.unstaged;
    const store = useAppStore.getState();
    if (there.some((file) => file.path === center.path)) store.openDiff(tab.id, center.path, { kind: center.source.kind === "unstaged" ? "staged" : "unstaged" });
    else store.closeCenter(tab.id);
  }
}

/** `paths: null` = everything. */
export async function stagePaths(repoId: Id, paths: string[] | null) {
  const result = await runAction(t("actions.files.stage"), withStatus(repoId, () => core.stagePaths({ repoId, paths })));
  return result;
}

/** `paths: null` = everything. */
export async function unstagePaths(repoId: Id, paths: string[] | null) {
  const result = await runAction(t("actions.files.unstage"), withStatus(repoId, () => core.unstagePaths({ repoId, paths })));
  return result;
}

/**
 * Discards changes after a prompt. `paths: null` = everything, including untracked files.
 * The prompt names the files; undo right afterwards brings them back.
 */
export async function discardPaths(repoId: Id, paths: string[] | null, options: { follow?: boolean } = {}) {
  const all = paths === null;
  const status = cachedStatus(repoId);
  const affected = all ? [...new Set([...(status?.staged ?? []), ...(status?.unstaged ?? [])].map((file) => file.path))] : paths;
  const untracked = new Set((status?.unstaged ?? []).filter((file) => file.status === "untracked").map((file) => file.path));
  const deletes = affected.filter((path) => untracked.has(path)).length;
  const ok = await confirm({
    // Before a destructive action it must be readable WHICH file is meant: the file name stays
    // whole (the path in front is shortened), and the full path is shown below.
    title: all
      ? t("actions.files.discard.titleAll")
      : affected.length === 1
        ? t("actions.files.discard.titleOne", { path: fileNameForTitle(affected[0]!) })
        : t("actions.files.discard.titleMany", { count: affected.length }),
    body: all
      ? t("actions.files.discard.bodyAll")
      : deletes === affected.length
        ? t("actions.files.discard.bodyNew", { count: deletes })
        : deletes
          ? t("actions.files.discard.bodyWithNew", { count: deletes })
          : t("actions.files.discard.body"),
    details: affected.length > 1 || (affected.length === 1 && fileNameForTitle(affected[0]!) !== affected[0]) ? affected : undefined,
    detailsLabel: affected.length === 1 ? t("actions.files.discard.fullPath") : undefined,
    confirmLabel: all ? t("actions.files.discard.actionAll") : t("actions.files.discard.action"),
    danger: true,
  });
  if (!ok) return null;
  const result = await runAction(t("actions.files.discard.action"), withStatus(repoId, () => core.discardPaths({ repoId, paths })), {
    busyKey: `${repoId}:discard`,
    quiet: ["operation_in_progress"],
    success: all
      ? t("actions.files.discard.doneAll")
      : affected.length === 1
        ? t("actions.files.discard.doneOne", { path: clipMiddle(affected[0]!, 56) })
        : t("actions.files.discard.doneMany", { count: affected.length }),
  });
  // Discarded via the context menu too: an open diff of the file does not remain. (`follow: false`:
  // the caller updates the centre itself – the Commit Panel moves on to the next file in the list.)
  if (result.ok && options.follow !== false) followVanishedDiff(repoId, result.value);
  if (!result.ok && result.error.code === "operation_in_progress") {
    // In the middle of a merge, rebase, cherry-pick or revert only aborting the operation cleans up properly.
    const operation = (await loadStatus(repoId).catch(() => undefined))?.operation;
    toast({
      tone: "warning",
      sticky: true,
      title: t("actions.files.discard.blocked"),
      description: operation ? t("actions.files.discard.blockedOperation", { operation: operationNames[operation.kind] }) : result.error.message,
      action: operation ? { label: t("actions.merge.abortLabel", { operation: operationNames[operation.kind] }), onClick: () => void abortOperation(repoId, operation.kind) } : undefined,
    });
  }
  return result;
}

/** Path for a dialog title: the full file name, preceded by as much of the path as fits ("…/nord/datei.py"). */
export function fileNameForTitle(path: string, max = 48): string {
  if (path.length <= max) return path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.length >= max - 2) return clipMiddle(name, max);
  const room = max - name.length - 2;
  const dir = path.slice(0, path.length - name.length - 1);
  return `…${dir.slice(Math.max(0, dir.length - room))}/${name}`;
}

const externalLabels: Record<ExternalTarget, string> = {
  editor: t("actions.files.external.editor"),
  terminal: t("actions.files.external.terminal"),
  file_manager: t("actions.files.external.fileManager"),
  diff_tool: t("actions.files.external.diffTool"),
  merge_tool: t("actions.files.external.mergeTool"),
};

/** Open repo or file in editor, terminal or file manager. `path` relative to the repo; null = the repository itself. */
export function openExternal(repoId: Id, target: ExternalTarget, path: string | null = null) {
  return runAction(externalLabels[target], () => core.openExternal({ repoId, target, path }), {
    busyKey: `${repoId}:open:${target}:${path ?? ""}`,
  });
}

/** Pattern into the .gitignore in the root directory; optionally stop tracking. */
export async function ignorePattern(repoId: Id, pattern: string, stopTracking = false) {
  const result = await runAction(t("actions.files.ignore.action"), withStatus(repoId, () => core.ignoreAdd({ repoId, pattern, stopTracking })), {
    success: stopTracking ? t("actions.files.ignore.doneUntracked", { pattern: clip(pattern, 44) }) : t("actions.files.ignore.done", { pattern: clip(pattern, 44) }),
  });
  return result;
}

/** Take characters that have a meaning in .gitignore literally. */
function escapeIgnore(path: string): string {
  let escaped = path.replace(/([\\*?[\]])/g, "\\$1").replace(/( +)$/, (spaces) => spaces.replace(/ /g, "\\ "));
  if (/^[#!]/.test(escaped)) escaped = `\\${escaped}`;
  return escaped;
}

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : null;
};
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null);

export type IgnorePreset = "file" | "extension" | "folder";

/** What can be ignored for these files: the file itself, its extension, its folder. */
export function ignoreSuggestions(files: Pick<FileChange, "path">[]): IgnoreSuggestion[] {
  const paths = files.map((file) => file.path);
  if (!paths.length) return [];
  const suggestions: IgnoreSuggestion[] = [];
  if (paths.length === 1) suggestions.push({ key: "file", label: t("actions.files.ignore.file"), pattern: `/${escapeIgnore(paths[0]!)}` });
  const extension = extensionOf(paths[0]!);
  if (extension && paths.every((path) => extensionOf(path) === extension)) {
    suggestions.push({ key: "extension", label: t("actions.files.ignore.extension", { extension }), pattern: `*${escapeIgnore(extension)}` });
  }
  const folder = folderOf(paths[0]!);
  if (folder && paths.every((path) => folderOf(path) === folder)) {
    suggestions.push({ key: "folder", label: t("actions.files.ignore.folder", { folder: clip(folder, 32) }), pattern: `/${escapeIgnore(folder)}/` });
  }
  return suggestions;
}

/**
 * Opens the ignore dialog for the files: pick a suggestion, edit the pattern if needed,
 * see the new line, optionally "stop tracking".
 */
export async function ignoreFiles(repoId: Id, files: Pick<FileChange, "path" | "status">[], preset: IgnorePreset = "file") {
  const suggestions = ignoreSuggestions(files);
  if (!suggestions.length) {
    toast({ tone: "info", title: t("actions.files.ignore.noPattern"), description: t("actions.files.ignore.noPatternDescription") });
    return null;
  }
  const tracked = files.some((file) => file.status !== "untracked");
  const choice = await askIgnore(suggestions, preset, tracked);
  if (!choice) return null;
  return ignorePattern(repoId, choice.pattern, choice.stopTracking);
}

/** Stashes only these files. */
export function stashFiles(repoId: Id, paths: string[]) {
  if (!paths.length) return Promise.resolve(null);
  return stashChanges(repoId, {
    paths,
    message: paths.length === 1 ? t("actions.files.stashOne", { path: paths[0] }) : t("actions.files.stashMany", { count: paths.length, paths: clip(paths.join(", "), 60) }),
    includeUntracked: true,
  });
}

/** Takes one side of a conflicted file entirely; afterwards it is staged. */
export async function resolveConflictSide(repoId: Id, paths: string[], side: "ours" | "theirs") {
  let last = null;
  for (const path of paths) {
    last = await runAction(side === "ours" ? t("actions.files.resolve.ours") : t("actions.files.resolve.theirs"), withStatus(repoId, () => core.conflictResolve({ repoId, path, content: null, side })));
    if (!last.ok) return last;
  }
  if (last?.ok) {
    const open = last.value.conflicted.length;
    toast({
      tone: "success",
      title: paths.length === 1 ? t("actions.files.resolve.doneOne", { path: clip(paths[0]!, 44) }) : t("actions.files.resolve.doneMany", { count: paths.length }),
      description: open ? t("actions.files.resolve.open", { count: open }) : t("actions.files.resolve.allDone"),
    });
  }
  return last;
}
