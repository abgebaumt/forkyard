/** Context menu of files in a file list. */
import { shortSha as short } from "../../format";
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  ExternalLink,
  EyeOff,
  FileDiff,
  FilePenLine,
  FilePlus,
  FileX,
  FileText,
  FolderOpen,
  GitCompareArrows,
  History,
  Lock,
  LockOpen,
  Minus,
  Plus,
  RotateCcw,
  Trash2,
  Users,
  Wrench,
} from "lucide-react";
import type { DiffSource, FileChange, Id } from "../../../core";
import type { MenuEntry } from "../../../ui/Menu";
import { copyText } from "../../actions/clipboard";
import { cachedStashes, clipMiddle } from "../../actions/context";
import { createFile, deleteFile } from "../../commands/fileview";
import {
  discardPaths,
  ignoreFiles,
  ignoreSuggestions,
  openExternal,
  resolveConflictSide,
  stagePaths,
  stashFiles,
  unstagePaths,
  type IgnorePreset,
} from "../../actions/files";
import { restoreFile } from "../../actions/history";
import { patchFromFiles } from "../../actions/patches";
import { applyStashFiles } from "../../actions/stash";
import { cachedLocks, lockFiles, unlockFiles } from "../../../screens/Lfs/actions";
import { lockIndex, lockMenuState } from "../../../screens/Lfs/locks";
import { openDiffTool, openMergeTool } from "../../actions/tools";
import { t } from "../../../i18n";
import { useAppStore } from "../../store";
import { forgetLassoPaths } from "../../lasso";
import { customCommandEntries } from "../custom";
import { type MenuBase, SEPARATOR, item, tidy } from "./shared";

function ignoreMenu(repoId: Id, files: FileChange[]): MenuEntry[] {
  const suggestions = ignoreSuggestions(files);
  return suggestions.map((suggestion) =>
    item(`${suggestion.label} …`, null, () => void ignoreFiles(repoId, files, suggestion.key as IgnorePreset), {
      hint: clipMiddle(suggestion.pattern, 28),
    }),
  );
}

/** Lock / unlock via Git LFS – only when the repository's locks are known (server with locking). */
function lockMenu(repoId: Id, paths: string[]): MenuEntry[] {
  const list = cachedLocks(repoId);
  if (!list) return [];
  const { lockable, ownLocked, foreignLocked } = lockMenuState(paths, lockIndex(list));
  const entries: MenuEntry[] = [];
  if (lockable.length > 0) {
    entries.push(
      item(
        lockable.length === 1 ? t("ui.lock") : t("menus.file.lockMany", { n: lockable.length }),
        Lock,
        () => void lockFiles(repoId, lockable),
      ),
    );
  }
  if (ownLocked.length > 0) {
    entries.push(
      item(
        ownLocked.length === 1 ? t("ui.unlock") : t("menus.file.unlockMany", { n: ownLocked.length }),
        LockOpen,
        () => void unlockFiles(repoId, ownLocked, false),
      ),
    );
  }
  if (foreignLocked.length > 0) {
    const single = foreignLocked.length === 1 ? foreignLocked[0]! : null;
    entries.push(
      item(
        single ? t("ui.forceUnlock") : t("menus.file.forceUnlockMany", { n: foreignLocked.length }),
        LockOpen,
        () =>
          void unlockFiles(
            repoId,
            foreignLocked.map((lock) => lock.path),
            true,
            foreignLocked,
          ),
        {
          danger: true,
          hint: single ? t("menus.file.lockedBy", { owner: single.owner }) : undefined,
        },
      ),
    );
  }
  return entries;
}

export function fileMenu(ctx: MenuBase & { files: FileChange[]; source: DiffSource }): MenuEntry[] {
  const { repoId, tabId, files, source } = ctx;
  if (files.length === 0) return [];
  const store = useAppStore.getState;
  const paths = files.map((file) => file.path);
  const single = files.length === 1 ? files[0]! : null;
  const count = files.length;
  const conflicted = files.filter((file) => file.status === "conflicted");
  const onlyConflicts = conflicted.length === count;
  const someConflicts = conflicted.length > 0 && !onlyConflicts ? t("menus.file.containsConflicts") : null;
  const worktree = source.kind === "unstaged" || source.kind === "staged";
  /** The file (still) exists in the working directory. */
  const onDisk = (file: FileChange) => !(worktree && file.status === "deleted");
  const sha =
    source.kind === "commit"
      ? source.sha
      : source.kind === "stash"
        ? (cachedStashes(repoId)?.find((stash) => stash.index === source.index)?.sha ?? null)
        : null;
  /** Version for file view and blame: the commit, otherwise the working directory. */
  const viewSha = source.kind === "commit" ? source.sha : source.kind === "range" ? source.to : null;

  const primary: (MenuEntry | null)[] = [];
  if (source.kind === "unstaged" && onlyConflicts) {
    primary.push(
      single ? item(t("menus.file.resolveConflict"), Wrench, () => store().openConflict(tabId, single.path)) : null,
      single ? item(t("menus.file.openMergeTool"), ExternalLink, () => void openMergeTool(repoId, single.path)) : null,
      item(t("ui.takeCurrentVersion"), Check, () => void resolveConflictSide(repoId, paths, "ours"), {
        hint: single ? undefined : t("menus.file.nFiles", { n: count }),
      }),
      item(t("ui.takeIncomingVersion"), Check, () => void resolveConflictSide(repoId, paths, "theirs"), {
        hint: single ? undefined : t("menus.file.nFiles", { n: count }),
      }),
    );
  } else if (source.kind === "unstaged") {
    const ignore = ignoreMenu(repoId, files);
    primary.push(
      item(
        single ? t("ui.stage") : t("menus.file.stageMany", { n: count }),
        Plus,
        () => void stagePaths(repoId, paths, () => forgetLassoPaths(tabId, paths)),
        {
          shortcut: "S",
          blocked: someConflicts,
        },
      ),
      item(
        single ? t("menus.file.stashOnly") : t("menus.file.stashOnlyMany", { n: count }),
        Archive,
        () => void stashFiles(repoId, paths, () => forgetLassoPaths(tabId, paths)),
        { blocked: someConflicts },
      ),
      item(t("ui.ignore"), EyeOff, () => undefined, ignore.length ? { children: ignore } : { blocked: t("menus.file.ignoreNone") }),
      item(
        single ? t("ui.discardChanges") : t("menus.file.discardMany", { n: count }),
        Trash2,
        () => void discardPaths(repoId, paths, { onApplied: () => forgetLassoPaths(tabId, paths) }),
        {
          danger: true,
          blocked: someConflicts,
        },
      ),
    );
  } else if (source.kind === "staged") {
    primary.push(
      item(single ? t("ui.unstage") : t("menus.file.unstageMany", { n: count }), Minus, () => void unstagePaths(repoId, paths), {
        shortcut: "U",
        hint: t("menus.file.unstageHint"),
      }),
    );
  } else if (sha) {
    primary.push(
      source.kind === "stash"
        ? // Individual files from a stash, through the stash itself: its untracked files live in
          // a parent of their own, not in the commit the list shows. The stash is kept.
          item(
            single ? t("menus.file.applyFromStash") : t("menus.file.applyFromStashMany", { n: count }),
            ArchiveRestore,
            () => void applyStashFiles(repoId, { index: source.index, message: "", sha }, files),
            {
              hint: files.every((file) => file.status === "untracked")
                ? t("menus.file.fromStashUntrackedHint")
                : t("menus.file.fromStashHint"),
              blocked: files.every((file) => file.status === "deleted") ? t("menus.file.goneInStash") : null,
            },
          )
        : item(
            single ? t("menus.file.restore") : t("menus.file.restoreMany", { n: count }),
            RotateCcw,
            () => void restoreFile(repoId, sha, paths),
            {
              hint: t("menus.file.restoreHint", { sha: short(sha) }),
              blocked: files.every((file) => file.status === "deleted") ? t("menus.file.goneInCommit") : null,
            },
          ),
    );
    if (source.kind === "commit") {
      primary.push(
        item(
          t("menus.file.compareWorktree"),
          GitCompareArrows,
          () => single && store().openDiff(tabId, single.path, { kind: "range", from: source.sha, to: null }),
          {
            blocked: single ? null : t("menus.file.onlyOne"),
          },
        ),
      );
    }
  }

  const one = single ? null : t("menus.file.onlyOne");
  const gone = single && !onDisk(single) ? t("menus.file.deleted") : null;
  return tidy([
    ...primary,
    SEPARATOR,
    ...lockMenu(repoId, paths),
    SEPARATOR,
    item(t("ui.history"), History, () => single && store().openHistory(tabId, single.path), { blocked: one }),
    item(t("ui.blame"), Users, () => single && store().openBlame(tabId, single.path, viewSha), {
      hint: one ? undefined : t("menus.file.blameHint"),
      blocked:
        one ??
        (single?.isBinary
          ? t("menus.file.binary")
          : viewSha === null
            ? gone
            : single?.status === "deleted"
              ? t("menus.file.deletedInCommit")
              : null),
    }),
    item(t("ui.viewFile"), FileText, () => single && store().openFile(tabId, single.path, viewSha, "view"), {
      blocked: one ?? (viewSha === null ? gone : single?.status === "deleted" ? t("menus.file.deletedInCommit") : null),
    }),
    item(t("ui.editFile"), FilePenLine, () => single && store().openFile(tabId, single.path, null, "edit"), {
      blocked: one ?? gone ?? (single?.isBinary ? t("menus.file.binary") : null),
    }),
    // New file next to the selected one: the folder is already in the field.
    worktree
      ? item(t("menus.file.create"), FilePlus, () => void createFile(repoId, tabId, (files[0]?.path ?? "").replace(/[^/]*$/, "")))
      : null,
    worktree
      ? item(t("ui.deleteFile"), FileX, () => single && void deleteFile(repoId, tabId, single.path), {
          danger: true,
          blocked: one ?? gone ?? (single?.status === "conflicted" ? t("menus.file.resolveConflictFirst") : null),
        })
      : null,
    SEPARATOR,
    item(t("menus.file.openDiffTool"), GitCompareArrows, () => single && void openDiffTool(repoId, single.path, source), {
      blocked: one ?? (single?.status === "conflicted" ? t("menus.file.useMergeTool") : null),
    }),
    item(t("ui.openInEditor"), ExternalLink, () => single && void openExternal(repoId, "editor", single.path), {
      blocked: one ?? gone,
    }),
    item(
      t("menus.file.showInFileManager"),
      FolderOpen,
      () => void openExternal(repoId, "file_manager", single ? single.path : (files[0]?.path ?? null)),
      { blocked: one },
    ),
    item(
      single ? t("ui.copyPath") : t("menus.file.copyPaths", { n: count }),
      Copy,
      () => void copyText(paths.join("\n"), single ? t("ui.path") : t("menus.file.paths", { n: count })),
    ),
    item(
      single ? t("menus.file.patch") : t("menus.file.patchMany", { n: count }),
      FileDiff,
      () => void patchFromFiles(repoId, source, files),
      {
        blocked:
          conflicted.length > 0
            ? t("menus.file.containsConflicts")
            : files.every((file) => file.isBinary)
              ? t("menus.file.binaryNoPatch")
              : null,
      },
    ),
    ...(single ? customCommandEntries(repoId, "file", { file: single.path, sha }) : []),
  ]);
}
