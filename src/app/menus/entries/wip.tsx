/** Context menu of the WIP row. */
import { Archive, FileDiff, FileInput, Minus, Plus, Trash2 } from "lucide-react";
import type { MenuEntry } from "../../../ui/Menu";
import { cachedStatus } from "../../actions/context";
import { discardPaths, stagePaths, unstagePaths } from "../../actions/files";
import { applyPatch, patchFromWip } from "../../actions/patches";
import { stashChanges } from "../../actions/stash";
import { t } from "../../../i18n";
import { commandShortcut } from "../../registry";
import { useAppStore } from "../../store";
import { forgetLassoPaths } from "../../lasso";
import { type MenuBase, SEPARATOR, item, tidy } from "./shared";

export function wipMenu(ctx: MenuBase): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const status = cachedStatus(repoId);
  const unstaged = status?.unstaged.length ?? 0;
  const staged = status?.staged.length ?? 0;
  const conflicted = status?.conflicted.length ?? 0;
  const changes = unstaged + staged;
  const noChanges = status && changes === 0 ? t("menus.wip.noChanges") : null;
  const stashBlock =
    status?.head.kind === "unborn" ? t("menus.wip.needsCommit") : conflicted ? t("menus.wip.resolveConflictsFirst") : noChanges;
  return tidy([
    item(t("ui.stageAll"), Plus, () => void stagePaths(repoId, null, () => forgetLassoPaths(tabId, null)), {
      shortcut: commandShortcut("wip.stageAll"),
      blocked: status && unstaged === 0 ? t("menus.wip.nothingToStage") : null,
    }),
    item(t("ui.unstageAll"), Minus, () => void unstagePaths(repoId, null), {
      shortcut: commandShortcut("wip.unstageAll"),
      blocked: status && staged === 0 ? t("menus.wip.nothingStaged") : null,
    }),
    SEPARATOR,
    item(t("ui.createStash"), Archive, () => void stashChanges(repoId, { onApplied: () => forgetLassoPaths(tabId, null) }), {
      shortcut: commandShortcut("stash.create"),
      blocked: stashBlock,
    }),
    item(t("menus.wip.stashWithMessage"), Archive, () => useAppStore.getState().openStashForm(tabId), { blocked: stashBlock }),
    SEPARATOR,
    item(t("menus.wip.patchFromChanges"), FileDiff, () => void patchFromWip(repoId), { blocked: noChanges }),
    item(t("ui.applyPatch"), FileInput, () => void applyPatch(repoId, tabId), {
      blocked: conflicted ? t("menus.wip.resolveConflictsFirst") : null,
    }),
    SEPARATOR,
    item(t("menus.wip.discardAll"), Trash2, () => void discardPaths(repoId, null, { onApplied: () => forgetLassoPaths(tabId, null) }), {
      danger: true,
      blocked: noChanges,
    }),
  ]);
}
