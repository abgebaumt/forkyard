/**
 * Applying a rebase plan, shared by the rebase tool and the graph's edit mode: prompt where the
 * plan costs something, then `rebase_apply` (which checks the plan against `base..HEAD`, backs up
 * and records the undo entry).
 */
import { core, type Id, type RebasePlan, type RebasePlanRow } from "../../core";
import { t } from "../../i18n";
import { busyKeys } from "../actions/keys";
import { reportOpResult } from "../actions/merge";
import { confirm } from "../dialogs";
import { shortSha } from "../format";
import { runAction } from "../run";
import { withFreshStatus } from "../statusCache";
import { checkPlan, payloadRows } from "./model";

export type OkPlan = Extract<RebasePlan, { status: "ok" }>;
type Refusal = Extract<RebasePlan, { status: "refused" }>;

export const refusalTitle: Record<Refusal["reason"], string> = {
  merge_commits: t("rebase.refused.mergeCommits"),
  no_common_ancestor: t("rebase.refused.noCommonAncestor"),
  nothing_to_rebase: t("rebase.refused.nothingToRebase"),
  dirty_worktree: t("rebase.refused.dirtyWorktree"),
  detached: t("rebase.refused.detached"),
  operation_in_progress: t("rebase.refused.operationInProgress"),
};

export const planSignature = (plan: OkPlan) => `${plan.branch}@${plan.base}:${plan.rows.map((row) => row.sha).join(",")}`;

/**
 * Prompt before starting if the plan costs something: commits fall out of the branch, or commits
 * that are already on a remote get rewritten (unless `askForPushed` is false because the view
 * already says so). A plan that only reorders, rewords or squashes local commits starts without a prompt.
 */
export async function confirmRewrite(plan: OkPlan, rows: RebasePlanRow[], options: { askForPushed?: boolean } = {}): Promise<boolean> {
  const pushed = plan.rewritesPushed && (options.askForPushed ?? true);
  const dropped = rows.filter((row) => row.action === "drop");
  if (!pushed && dropped.length === 0) return true;
  const sentences: string[] = [];
  if (dropped.length) {
    sentences.push(t("rebase.confirm.dropped", { count: dropped.length, branch: plan.branch }));
  }
  if (pushed) {
    sentences.push(t("rebase.confirm.pushed"));
  }
  sentences.push(t("rebase.confirm.undo"));
  return confirm({
    title: dropped.length
      ? t("rebase.confirm.dropTitle", { count: dropped.length })
      : t("rebase.confirm.pushedTitle", { branch: plan.branch }),
    body: sentences.join(" "),
    details: dropped.map((row) => `${shortSha(row.sha)}  ${row.summary}`),
    detailsLabel: dropped.length ? t("rebase.confirm.droppedLabel") : undefined,
    confirmLabel: t("rebase.interactive.start"),
    danger: true,
  });
}

/** checkPlan ("blocked") → confirmRewrite ("cancelled") → rebaseApply → reportOpResult; "stale" on stale_state. */
export async function applyRebasePlan(
  repoId: Id,
  tabId: Id,
  plan: OkPlan,
  rows: RebasePlanRow[],
  options: { updateRefs: boolean; askForPushed: boolean; label: string },
): Promise<"done" | "up_to_date" | "stale" | "failed" | "cancelled" | "blocked"> {
  // A blocked plan never starts; the views show the reason and keep the start button locked.
  if (checkPlan(rows, plan.rows).blocked) return "blocked";
  if (!(await confirmRewrite(plan, rows, { askForPushed: options.askForPushed }))) return "cancelled";
  const result = await runAction(
    options.label,
    withFreshStatus(repoId, () =>
      core.rebaseApply({
        repoId,
        base: plan.base,
        rows: payloadRows(rows),
        updateRefs: plan.dependentBranches.length > 0 && options.updateRefs,
      }),
    ),
    { busyKey: busyKeys.history(repoId), quiet: ["stale_state"] },
  );
  if (!result.ok) return result.error.code === "stale_state" ? "stale" : "failed";
  if (result.value.status === "up_to_date") return "up_to_date";
  reportOpResult(options.label, result.value, tabId, { reveal: true });
  return "done";
}
