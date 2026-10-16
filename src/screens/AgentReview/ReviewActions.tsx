/**
 * The ways to take an agent's work over, below its files and diff. A button that cannot run now is
 * disabled and says why (tooltip, and for the takeover a line below the bar). The destructive step
 * carries the word.
 */
import type { Agent, AgentReview, Id } from "../../core";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { SegmentedControl } from "../../ui/Field";
import { t } from "../../i18n";
import { discardRest, mergeAgent, rebaseAgent, reviewBusyKey, takeOver } from "./actions";
import { blocker, type ReviewAction, type TakeOverTarget } from "./model";
import { usePane, useReviewStore } from "./state";

export function ReviewActions({ repoId, tabId, agent, latest, chosen }: { repoId: Id; tabId: Id; agent: Agent; latest: AgentReview | null; chosen: number }) {
  const pane = usePane(tabId, agent.id);
  const busy = useBusy(reviewBusyKey(repoId));
  const why = (action: ReviewAction) => blocker(action, { agent, latest, chosen, status: undefined, summary: "" });
  const takeOverWhy = why("takeOver");
  return (
    <div role="toolbar" aria-label={t("agents.review.actions")} className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2">
      <span data-review-target="">
        <SegmentedControl<TakeOverTarget>
          label={t("agents.review.target")}
          value={pane.target}
          onValueChange={(target) => useReviewStore.getState().patch(tabId, agent.id, { target })}
          options={[
            { value: "worktree", label: t("agents.review.targetWorktree") },
            { value: "both", label: t("agents.review.targetStaged") },
          ]}
        />
      </span>
      <Button size="sm" variant="primary" data-action="review-take-over" disabled={busy || Boolean(takeOverWhy)} title={takeOverWhy ?? undefined} onClick={() => void takeOver(tabId, agent)}>
        {t("agents.review.takeOver")}
      </Button>
      <span className="flex-1" />
      <Button size="sm" data-action="review-merge" disabled={busy || Boolean(why("merge"))} title={why("merge") ?? undefined} onClick={() => void mergeAgent(tabId, agent)}>
        {t("agents.review.merge")}
      </Button>
      <Button size="sm" data-action="review-rebase" disabled={busy || Boolean(why("rebase"))} title={why("rebase") ?? undefined} onClick={() => void rebaseAgent(agent)}>
        {t("agents.review.rebase", { base: agent.base })}
      </Button>
      <Button
        size="sm"
        variant="danger"
        data-action="review-discard"
        disabled={busy || Boolean(why("discard"))}
        title={why("discard") ?? undefined}
        onClick={() => void discardRest(agent, latest?.uncommittedFiles ?? 0)}
      >
        {t("agents.review.discard")} <span className="text-xs font-normal">({t("agents.review.destructive")})</span>
      </Button>
      {takeOverWhy && latest ? (
        <p aria-live="polite" data-review-blocker="take-over" className="w-full text-sm text-text-muted">
          {takeOverWhy}
        </p>
      ) : null}
    </div>
  );
}
