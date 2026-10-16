/**
 * The work of the agent review, each through the existing dialogs, toasts and undo: the selection
 * into the user's working directory (`rangeApply` between the two pinned commits), the selection as a
 * commit (`agentReviewCommit`), merging the agent's branch, rebasing it in its own worktree, and
 * discarding the rest there.
 */
import { core, type Agent, type AgentReview, type FileDiff, type Id, type PatchSelection } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { abortOperation, mergeBranch, reportOpResult } from "../../app/actions/merge";
import { preflight } from "../../app/actions/preflight";
import { undo } from "../../app/actions/undo";
import { confirm, pickFromList } from "../../app/dialogs";
import { qk, queryClient } from "../../app/queries";
import { newOpId, runAction } from "../../app/run";
import { withFreshStatus, withStatus } from "../../app/statusCache";
import { toast } from "../../ui/Feedback";
import { t } from "../../i18n";
import { displayName } from "../Agents/model";
import { buildSelections, compareCandidates, rangeSource, type FilePicks } from "./model";
import { getPane, useReviewStore } from "./state";
import { compareWith, openAgentReview } from "./navigation";

export const reviewBusyKey = (repoId: Id) => busyKeys.write(repoId, "agent-review");

/** The range diffs of the picked files – with “show anyway”, so large files have their hunks too. */
async function loadDiffs(repoId: Id, review: AgentReview, paths: string[]): Promise<Map<string, FileDiff>> {
  const source = rangeSource(review);
  const entries = await Promise.all(
    paths.map(async (path) => {
      const diff = await queryClient.fetchQuery({
        queryKey: qk.diff(repoId, path, source, { force: true }),
        queryFn: () => core.diffFile({ repoId, path, source, force: true, ignoreWhitespace: false }),
        staleTime: Infinity,
      });
      return [path, diff] as const;
    }),
  );
  return new Map(entries);
}

/** The selections of all picks; null (with a notice naming the files) if one can only be merged. */
async function selectionsOf(repoId: Id, review: AgentReview, picks: FilePicks): Promise<PatchSelection[] | null> {
  const { selections, refused } = buildSelections(picks, await loadDiffs(repoId, review, Object.keys(picks)));
  if (refused.length === 0) return selections;
  toast({ tone: "warning", sticky: true, title: t("agents.review.refused", { count: refused.length }), description: refused.join(", ") });
  return null;
}

/** “Selection into my working directory”: unstaged or staged, with a three-way pre-check in the core. */
export async function takeOver(tabId: Id, agent: Agent): Promise<boolean> {
  const { pinned, picks, target } = getPane(tabId, agent.id);
  if (!pinned || !picks || Object.keys(picks).length === 0) return false;
  const repoId = agent.repoId;
  const result = await runAction(
    t("agents.review.takeOverAction"),
    async () => {
      const selections = await selectionsOf(repoId, pinned, picks);
      if (!selections) return null;
      return withStatus(repoId, () => core.rangeApply({ repoId, from: pinned.from, to: pinned.to, selections, target }))();
    },
    { busyKey: reviewBusyKey(repoId) },
  );
  if (!result.ok || !result.value) return false;
  const count = Object.keys(picks).length;
  toast({
    tone: "success",
    title: target === "both" ? t("agents.review.takenOverStaged", { count }) : t("agents.review.takenOver", { count }),
    action: { label: t("agents.review.undo"), onClick: () => void undo(repoId) },
  });
  return true;
}

/** “Commit selection”: on the checked-out branch; nothing of your own may be staged (the core checks). */
export async function commitSelection(tabId: Id, agent: Agent, message: { summary: string; description: string }, skipHooks: boolean): Promise<boolean> {
  const { pinned, picks } = getPane(tabId, agent.id);
  if (!pinned || !picks || Object.keys(picks).length === 0) return false;
  const repoId = agent.repoId;
  const result = await runAction(
    t("agents.review.commitAction"),
    async () => {
      const selections = await selectionsOf(repoId, pinned, picks);
      if (!selections) return null;
      return core.agentReviewCommit({ agentId: agent.id, opId: newOpId(), from: pinned.from, to: pinned.to, selections, summary: message.summary, description: message.description, skipHooks });
    },
    { busyKey: reviewBusyKey(repoId) },
  );
  if (!result.ok || !result.value) return false;
  // Committed: nothing stays selected, the message starts again from the task.
  useReviewStore.getState().patch(tabId, agent.id, { picks: {}, message: null });
  toast({ tone: "success", title: t("agents.review.committed", { summary: message.summary.trim() }), action: { label: t("agents.review.undo"), onClick: () => void undo(repoId) } });
  return true;
}

/** “Merge branch”: the existing merge (with its pre-check) of the agent's branch into the checked-out one. */
export function mergeAgent(tabId: Id, agent: Agent): ReturnType<typeof mergeBranch> {
  return mergeBranch(agent.repoId, agent.branch, undefined, tabId);
}

/**
 * “Rebase onto <base>”: in the agent's own worktree (its branch is checked out there), with the
 * existing pre-check. A conflict leaves the rebase there; the toast offers to abort it.
 */
export async function rebaseAgent(agent: Agent): Promise<void> {
  const repoId = agent.worktreeRepoId;
  if (!repoId) return;
  const label = t("actions.merge.rebaseLabel");
  const choice = await preflight(repoId, {
    title: t("preflight.rebaseTitle", { branch: agent.branch, onto: agent.base }),
    confirmLabel: label,
    op: { kind: "rebase", onto: agent.base, upstream: null, branch: agent.branch, commits: null },
    rebase: { onto: agent.base, branch: agent.branch },
  });
  if (!choice) return;
  const result = await runAction(label, withFreshStatus(repoId, () => core.rebaseStart({ repoId, onto: agent.base, branch: agent.branch, updateRefs: choice.updateRefs })), {
    busyKey: busyKeys.history(repoId),
  });
  if (!result.ok) return;
  if (result.value.status !== "conflict") {
    reportOpResult(label, result.value, null);
    return;
  }
  toast({
    tone: "warning",
    sticky: true,
    title: t("agents.review.rebaseConflict", { name: displayName(agent), count: result.value.files.length }),
    description: t("agents.review.rebaseConflictHint"),
    action: { label: t("agents.review.abortRebase"), onClick: () => void abortOperation(repoId, "rebase") },
  });
}

/** “Discard the rest in the agent's worktree”: everything uncommitted there, after a confirmation; undo on the worktree. */
export async function discardRest(agent: Agent, uncommitted: number): Promise<boolean> {
  const worktree = agent.worktreeRepoId;
  if (!worktree) return false;
  const ok = await confirm({
    title: t("agents.review.discardTitle", { name: displayName(agent) }),
    body: t("agents.review.discardBody", { count: uncommitted }),
    details: [agent.worktreePath],
    confirmLabel: t("agents.review.discardConfirm"),
    danger: true,
  });
  if (!ok) return false;
  const result = await runAction(t("agents.review.discardAction"), withStatus(worktree, () => core.agentDiscardRest({ agentId: agent.id })), { busyKey: reviewBusyKey(agent.repoId) });
  if (!result.ok) return false;
  toast({ tone: "info", title: t("agents.review.discarded", { name: displayName(agent) }), action: { label: t("agents.review.undo"), onClick: () => void undo(worktree) } });
  return true;
}

const pickItems = (agents: Agent[]) => agents.map((agent) => ({ key: agent.id, label: displayName(agent), description: agent.branch }));

const loadAgents = (repoId: Id, label: string) => runAction(label, () => queryClient.fetchQuery({ queryKey: qk.agents(repoId), queryFn: () => core.agentList({ repoId }) }));

/** Palette “Review coding agent …”: the only agent directly, otherwise a pick list. */
export async function reviewAgentFromPalette(repoId: Id, tabId: Id): Promise<void> {
  const loaded = await loadAgents(repoId, t("agents.review.pickTitle"));
  if (!loaded.ok) return;
  const open = loaded.value.filter((agent) => agent.status !== "orphaned");
  if (open.length === 0) {
    toast({ tone: "info", title: t("agents.review.noAgents") });
    return;
  }
  const chosen =
    open.length === 1
      ? open[0]!.id
      : await pickFromList({ title: t("agents.review.pickTitle"), label: t("agents.review.pickLabel"), items: pickItems(open), confirmLabel: t("agents.review.pickConfirm") });
  if (chosen) openAgentReview(tabId, chosen);
}

/** “Compare with …” in the review's header: a second agent, shown side by side. */
export async function pickComparison(repoId: Id, tabId: Id, current: Id[]): Promise<void> {
  const loaded = await loadAgents(repoId, t("agents.review.compare"));
  if (!loaded.ok) return;
  const candidates = compareCandidates(loaded.value, current);
  if (candidates.length === 0) {
    toast({ tone: "info", title: t("agents.review.noOtherAgents") });
    return;
  }
  const chosen = await pickFromList({ title: t("agents.review.compareTitle"), label: t("agents.review.compareLabel"), items: pickItems(candidates), confirmLabel: t("agents.review.compareConfirm") });
  if (chosen) compareWith(tabId, chosen);
}
