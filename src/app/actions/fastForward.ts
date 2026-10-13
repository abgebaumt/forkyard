import { t } from "../../i18n";
import { core, type Id } from "../../core";
import { toast } from "../../ui/Feedback";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { busyKeys } from "./keys";
import { undo } from "./undo";

/**
 * Fast-forwards a NOT checked-out local branch to its upstream. Only the ref moves;
 * working directory and index stay as they are. Nothing is fetched – the state of the last
 * fetch applies. The message offers "Undo" (the core creates an undo step).
 *
 * For the checked-out branch there is `fastForward` in merge.ts (there the files move too).
 */
export async function fastForwardBranch(repoId: Id, branch: string, upstream: string) {
  const label = t("actions.fastForward.label");
  const result = await runAction(label, () => core.branchFastForward({ repoId, branch }), {
    busyKey: busyKeys.history(repoId),
  });
  if (!result.ok) {
    // The state in the menu was stale (own commits, upstream gone): reload refs, then the next look is right.
    void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
    return result;
  }
  void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  if (result.value.status === "done") {
    toast({
      tone: "success",
      title: t("actions.fastForward.done"),
      description: t("actions.fastForward.doneDescription", { summary: result.value.summary || t("actions.fastForward.summary", { branch, upstream }) }),
      action: { label: t("actions.undoLabel"), onClick: () => void undo(repoId) },
    });
  } else if (result.value.status === "up_to_date") {
    toast({ tone: "info", title: t("actions.fastForward.upToDate"), description: t("actions.fastForward.upToDateDescription", { branch, upstream }) });
  }
  return result;
}
