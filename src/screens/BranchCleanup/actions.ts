/** Opening the "Clean up branches" view and deleting the marked branches (locally with undo, on the remote on request). */
import { core, type BranchCleanupCandidate, type Id } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { clip } from "../../app/actions/context";
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
 * `alsoRemote`, after a danger prompt, it then deletes each tracked remote branch on its own, only at
 * the tip the list showed (a lease): a failure there, such as commits pushed since, is reported for that
 * branch and neither stops the others nor undoes the local deletion.
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
  if (!local.ok) {
    // Nothing was deleted; the list no longer matches the repository: load it again so the next try sends fresh SHAs.
    if (["stale_state", "not_found", "not_allowed"].includes(local.error.code))
      void queryClient.invalidateQueries({ queryKey: qk.branchCleanup(repoId) });
    return;
  }
  queryClient.setQueryData(qk.refs(repoId), local.value);
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  toast({
    tone: "success",
    title: t("cleanupBranches.done", { count: targets.length }),
    action: { label: t("ui.undo"), onClick: () => void undo(repoId) },
  });

  if (remotes.length === 0) return;
  let succeeded = 0;
  for (const { remote, branch, expected, label } of remotes) {
    const jobId = newJobId();
    const result = await runAction(
      t("actions.sync.deleteRemote.label"),
      () => core.branchDeleteRemote({ repoId, jobId, remote, name: branch, expected }),
      {
        busyKey: busyKeys.push(repoId),
        job: { id: jobId, title: t("actions.sync.deleteRemote.job", { target: clip(label, 32) }), repoId },
      },
    );
    // Already gone there: the core removed the stale remote branch here; say so instead of counting it as deleted.
    if (result.ok && result.value.status === "up_to_date")
      toast({
        tone: "info",
        title: t("actions.sync.deleteRemote.gone", { target: clip(label) }),
        description: t("actions.sync.deleteRemote.goneDescription"),
      });
    else if (result.ok) succeeded++;
  }
  afterNetwork(repoId);
  void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
  if (succeeded > 0) toast({ tone: "success", title: t("cleanupBranches.remote.done", { count: succeeded }) });
}
