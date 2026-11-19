/** Opening the "Clean up branches" view and deleting the marked branches (locally with undo, on the remote on request). */
import { core, type BranchCleanupCandidate, type Id } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { busyKeys } from "../../app/actions/keys";
import { afterNetwork } from "../../app/actions/sync";
import { undo } from "../../app/actions/undo";
import { confirm } from "../../app/dialogs";
import { qk, queryClient } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { remoteTargets } from "./model";

export function openBranchCleanup(tabId: Id): void {
  useAppStore.getState().setCenter(tabId, { kind: "branch_cleanup" });
}

/**
 * Deletes the marked branches in one core call (one undo entry, each checked against its SHA). With
 * `alsoRemote`, after a danger prompt, it then deletes each tracked remote branch on its own: a
 * failure there is reported for that branch and neither stops the others nor undoes the local deletion.
 */
export async function deleteSelected(
  repoId: Id,
  list: BranchCleanupCandidate[],
  selection: Set<string>,
  alsoRemote: boolean,
): Promise<void> {
  const targets = list
    .filter((candidate) => candidate.class !== "blocked" && selection.has(candidate.name))
    .map(({ name, sha }) => ({ name, sha }));
  if (targets.length === 0) return;
  const remotes = alsoRemote ? remoteTargets(list, selection) : [];
  if (remotes.length > 0) {
    const count = remotes.length;
    const ok = await confirm({
      title: t("cleanupBranches.remote.confirmTitle", { count }),
      body: t("cleanupBranches.remote.confirmBody"),
      details: remotes.map((target) => target.label),
      confirmLabel: t("cleanupBranches.remote.confirmAction", { count }),
      danger: true,
    });
    if (!ok) return;
  }

  const local = await runAction(t("cleanupBranches.deleting"), () => core.branchCleanupDelete({ repoId, targets }), {
    busyKey: busyKeys.branch(repoId),
  });
  if (!local.ok) return;
  queryClient.setQueryData(qk.refs(repoId), local.value);
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  toast({
    tone: "success",
    title: t("cleanupBranches.done", { count: targets.length }),
    action: { label: t("ui.undo"), onClick: () => void undo(repoId) },
  });

  if (remotes.length === 0) return;
  let succeeded = 0;
  for (const { remote, branch, label } of remotes) {
    const jobId = newJobId();
    const result = await runAction(
      t("actions.sync.deleteRemote.label"),
      () => core.branchDeleteRemote({ repoId, jobId, remote, name: branch }),
      { busyKey: busyKeys.push(repoId), job: { id: jobId, title: t("actions.sync.deleteRemote.job", { target: label }), repoId } },
    );
    if (result.ok) succeeded++;
  }
  afterNetwork(repoId);
  if (succeeded > 0) toast({ tone: "success", title: t("cleanupBranches.remote.done", { count: succeeded }) });
}
