/**
 * Actions of the file history: view a version, blame at a revision, restore a version (with a
 * prompt only if there are local changes, undo in the notification).
 */
import { core, type FileHistoryEntry, type Id, type Sha } from "../../core";
import { loadStatus } from "../../app/actions/context";
import { undo } from "../../app/actions/undo";
import { confirm } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { withStatus } from "../../app/statusCache";
import { toast } from "../../ui/Feedback";
import { t } from "../../i18n";

/**
 * Which revision a row of the history shows. For a deleting commit the file no longer exists
 * there – what is meant then is the version directly before (first parent).
 */
export function versionOf(entry: FileHistoryEntry): { sha: Sha | null; path: string; beforeDelete: boolean } {
  if (entry.status === "deleted") return { sha: entry.commit.parents[0] ?? null, path: entry.path, beforeDelete: true };
  return { sha: entry.commit.sha, path: entry.path, beforeDelete: false };
}

export const restoreBusyKey = (repoId: Id) => `${repoId}:file-restore`;

/**
 * Brings the version back into the working directory (it ends up staged). If the file has local
 * changes, it asks first. The core backs up what gets overwritten – the notification offers undo.
 */
export async function restoreVersion(repoId: Id, entry: FileHistoryEntry): Promise<boolean> {
  const version = versionOf(entry);
  if (!version.sha) return false;
  const sha = version.sha;
  const name = version.path.slice(version.path.lastIndexOf("/") + 1);
  const status = await loadStatus(repoId).catch(() => undefined);
  const local = [...(status?.unstaged ?? []), ...(status?.staged ?? []), ...(status?.conflicted ?? [])].some((file) => file.path === version.path);
  if (local) {
    const ok = await confirm({
      title: t("fileHistory.restore.confirmTitle", { name }),
      body: t("fileHistory.restore.confirmBody", { sha: shortSha(sha) }),
      confirmLabel: t("fileHistory.restore.confirm"),
      danger: true,
    });
    if (!ok) return false;
  }
  const result = await runAction(t("fileHistory.restore.confirm"), withStatus(repoId, () => core.fileRestore({ repoId, sha, paths: [version.path] })), { busyKey: restoreBusyKey(repoId) });
  if (!result.ok) return false;
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  toast({
    tone: "success",
    title: t("fileHistory.restore.doneTitle", { name, sha: shortSha(sha) }),
    description: t("fileHistory.restore.doneBody"),
    action: { label: t("fileHistory.restore.undo"), onClick: () => void undo(repoId) },
  });
  return true;
}
