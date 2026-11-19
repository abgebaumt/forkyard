/**
 * Actions of the file history: view a version, blame at a revision, restore a version (with a
 * prompt only if there are local changes, undo in the notification).
 */
import { core, type FileHistoryEntry, type Id } from "../../core";
import { loadStatus } from "../../app/actions/context";
import { undo } from "../../app/actions/undo";
import { confirm } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { withStatus } from "../../app/statusCache";
import { toast } from "../../ui/Feedback";
import { t } from "../../i18n";
import { baseName } from "../../app/paths";
import { busyKeys } from "../../app/actions/keys";
import { versionOf } from "./model";

export const restoreBusyKey = (repoId: Id) => busyKeys.write(repoId, "file-restore");

/**
 * Brings the version back into the working directory (it ends up staged). If the file has local
 * changes, it asks first. The core backs up what gets overwritten – the notification offers undo.
 */
export async function restoreVersion(repoId: Id, entry: FileHistoryEntry): Promise<boolean> {
  const version = versionOf(entry);
  if (!version.sha) return false;
  const sha = version.sha;
  const name = baseName(version.path);
  const status = await loadStatus(repoId).catch(() => undefined);
  const local = [...(status?.unstaged ?? []), ...(status?.staged ?? []), ...(status?.conflicted ?? [])].some(
    (file) => file.path === version.path,
  );
  if (local) {
    const ok = await confirm({
      title: t("fileHistory.restore.confirmTitle", { name }),
      body: t("fileHistory.restore.confirmBody", { sha: shortSha(sha) }),
      confirmLabel: t("fileHistory.restore.confirm"),
      danger: true,
    });
    if (!ok) return false;
  }
  const result = await runAction(
    t("fileHistory.restore.confirm"),
    withStatus(repoId, () => core.fileRestore({ repoId, sha, paths: [version.path] })),
    { busyKey: restoreBusyKey(repoId) },
  );
  if (!result.ok) return false;
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  toast({
    tone: "success",
    title: t("fileHistory.restore.doneTitle", { name, sha: shortSha(sha) }),
    description: t("fileHistory.restore.doneBody"),
    action: { label: t("ui.undo"), onClick: () => void undo(repoId) },
  });
  return true;
}
