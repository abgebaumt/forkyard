/**
 * Bisect autopilot actions (9.1): start from the bisect bar, a commit's menu or the palette; stop;
 * keep or remove the temporary worktree. The core runs everything; the run itself is a job.
 */
import { core, type AiStatus, type BisectAutopilot, type Id, type RepoSettings, type Sha } from "../../core";
import { cachedBisect, headSha } from "../../app/actions/context";
import { openAiSetup } from "../../app/ai/open";
import { qk, queryClient } from "../../app/queries";
import { newJobId, runAction, type ActionResult } from "../../app/run";
import { useAppStore } from "../../app/store";
import { t } from "../../i18n";
import { chooseRange } from "./actions";
import { showAutopilotDialog, type AutopilotPlan, type AutopilotRange } from "./AutopilotDialog";
import { autopilotAccess, isRunning, rangeFromBisect, type AutopilotAccess } from "./autopilotModel";

export const autopilotBusyKey = (repoId: Id) => `${repoId}:bisect-autopilot`;
export const cachedAutopilot = (repoId: Id) => queryClient.getQueryData<BisectAutopilot | null>(qk.bisectAutopilot(repoId)) ?? null;
export const autopilotRunning = (repoId: Id | null) => Boolean(repoId && isRunning(cachedAutopilot(repoId)));

/** For menus and the palette (synchronous): AI status and "AI off" of the repository from the cache. */
export function autopilotAccessFor(repoId: Id | null): AutopilotAccess {
  const status = queryClient.getQueryData<AiStatus>(qk.aiStatus);
  const repoAiOff = repoId ? (queryClient.getQueryData<RepoSettings>(qk.repoSettings(repoId))?.aiOff ?? false) : false;
  return autopilotAccess(status, repoAiOff);
}

/** Selected commits → the chooser; none → the range of a running manual bisect, otherwise HEAD as the bad commit. */
async function pickRange(repoId: Id, shas: Sha[]): Promise<AutopilotRange | null> {
  let from = shas;
  if (from.length === 0) {
    const running = rangeFromBisect(cachedBisect(repoId));
    if (running) return running;
    const head = headSha(repoId);
    from = head ? [head] : [];
  }
  const chosen = await chooseRange(repoId, from, t("bisect.autopilot.title"), t("bisect.autopilot.chooseConfirm"));
  return chosen ? { bad: chosen.bad, good: [chosen.good] } : null;
}

async function runAutopilot(repoId: Id, range: AutopilotRange, plan: AutopilotPlan, tabId: Id | null) {
  const jobId = newJobId();
  const result = await runAction(
    t("bisect.autopilot.runLabel"),
    () => core.bisectAutopilotRun({ repoId, jobId, bad: range.bad, good: range.good, script: plan.script, stepTimeoutSecs: plan.stepTimeoutSecs }),
    { busyKey: autopilotBusyKey(repoId), job: { id: jobId, title: t("bisect.autopilot.jobTitle"), repoId, askBeforeQuit: true } },
  );
  if (result.ok) {
    queryClient.setQueryData(qk.bisectAutopilot(repoId), result.value);
    if (tabId && result.value.result) useAppStore.getState().revealCommit(tabId, result.value.result);
  } else {
    void queryClient.invalidateQueries({ queryKey: qk.bisectAutopilot(repoId) });
  }
  return result;
}

export async function startAutopilot(repoId: Id, shas: Sha[], tabId: Id | null): Promise<ActionResult<BisectAutopilot> | null> {
  if (autopilotAccessFor(repoId) === "setup") {
    void openAiSetup();
    return null;
  }
  const range = await pickRange(repoId, shas);
  if (!range) return null;
  const plan = await showAutopilotDialog(repoId, range);
  if (!plan) return null;
  return runAutopilot(repoId, range, plan, tabId);
}

/** Cancels the run's job: the core ends the script, resets the bisect and removes the worktree. */
export async function stopAutopilot(repoId: Id): Promise<void> {
  const run = cachedAutopilot(repoId);
  if (run && isRunning(run)) await core.jobCancel({ jobId: run.jobId });
}

export async function closeAutopilot(repoId: Id, keep: boolean): Promise<ActionResult<string | null>> {
  const result = await runAction(keep ? t("bisect.autopilot.keep") : t("bisect.autopilot.remove"), () => core.bisectAutopilotClose({ repoId, keepWorktree: keep }), {
    busyKey: autopilotBusyKey(repoId),
    success: (path) => (path ? t("bisect.autopilot.kept", { path }) : null),
  });
  if (result.ok) queryClient.setQueryData(qk.bisectAutopilot(repoId), null);
  return result;
}
