/**
 * The right panel while an agent review is open: commits the selection of the agent whose pane had
 * the focus last on the checked-out branch. Summary and description start from the agent's task
 * (`commitMessageFromTask`) until the user edits them; the core refuses when something of the user's
 * own is already staged. Enter in the summary commits.
 */
import type { Id } from "../../core";
import { useAgentReview, useAgents, useStatus } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Checkbox, TextArea, TextField } from "../../ui/Field";
import { EmptyState } from "../../ui/Feedback";
import { t } from "../../i18n";
import { displayName } from "../Agents/model";
import { commitSelection, reviewBusyKey } from "./actions";
import { blocker, commitMessageFromTask } from "./model";
import { focusedAgent, usePane, useReviewStore } from "./state";

export function ReviewCommitPanel({ repoId, tabId, agentIds }: { repoId: Id; tabId: Id; agentIds: Id[] }) {
  const agents = useAgents(repoId);
  const focus = useReviewStore((state) => state.focus[tabId]);
  const agentId = focusedAgent(focus, agentIds);
  const pane = usePane(tabId, agentId ?? "");
  const latest = useAgentReview(repoId, agentId, pane.source);
  const { data: status } = useStatus(repoId);
  const busy = useBusy(reviewBusyKey(repoId));
  const agent = agents.data?.find((item) => item.id === agentId);
  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <EmptyState title={t("agents.review.gone")} />
      </div>
    );
  }
  const message = pane.message ?? commitMessageFromTask(agent.task);
  const chosen = Object.keys(pane.picks ?? {}).length;
  const why = blocker("commit", { agent, latest: latest.data ?? null, chosen, status, summary: message.summary });
  const head = status?.head;
  const setMessage = (next: { summary: string; description: string }) => useReviewStore.getState().patch(tabId, agent.id, { message: next });
  return (
    <form
      data-panel="review-commit"
      aria-label={t("agents.review.commitTitle")}
      className="flex h-full min-h-0 flex-col gap-3 overflow-auto bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!why && !busy) void commitSelection(tabId, agent, message, pane.skipHooks);
      }}
    >
      <h2 className="text-md font-semibold text-text">{t("agents.review.commitTitle")}</h2>
      <p className="text-sm text-text-muted">
        {head && head.kind !== "detached" ? t("agents.review.commitOnto", { name: displayName(agent), branch: head.branch }) : t("agents.review.commitDetached", { name: displayName(agent) })}
      </p>
      <TextField label={t("agents.review.summary")} data-field="review-summary" value={message.summary} onChange={(event) => setMessage({ ...message, summary: event.target.value })} />
      <TextArea label={t("agents.review.description")} data-field="review-description" rows={6} value={message.description} onChange={(event) => setMessage({ ...message, description: event.target.value })} />
      <Checkbox label={t("agents.review.skipHooks")} checked={pane.skipHooks} onCheckedChange={(skipHooks) => useReviewStore.getState().patch(tabId, agent.id, { skipHooks })} />
      <Button type="submit" variant="primary" data-action="review-commit" loading={busy} disabled={Boolean(why)}>
        {t("agents.review.commit", { count: chosen })}
      </Button>
      {why ? (
        <p aria-live="polite" data-review-blocker="commit" className="text-sm text-text-muted">
          {why}
        </p>
      ) : null}
    </form>
  );
}
