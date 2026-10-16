/**
 * Review of coding agents in the centre (`CenterView { kind: "agent_review" }`): per agent the files
 * “Selected / Not selected”, the diff of its state against the commit it forked from with line check
 * marks, and the ways to take the work over. Two agents: “A | B | Side by side” (at most two columns).
 * Esc returns to the view the review was opened from.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { Id } from "../../core";
import { hasOpenDialog } from "../../app/dialogs";
import { useAgents } from "../../app/queries";
import type { AgentReviewShow } from "../../app/store";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import { displayName } from "../Agents/model";
import { isPlainEscape } from "../FileView/parts";
import { reviewColumns } from "./model";
import { closeAgentReview, showColumns, stopComparing } from "./navigation";
import { pickComparison } from "./actions";
import { ReviewPane } from "./ReviewPane";

export function AgentReviewView({ repoId, tabId, agentIds, show }: { repoId: Id; tabId: Id; agentIds: Id[]; show: AgentReviewShow }) {
  const agents = useAgents(repoId);
  const root = useRef<HTMLElement>(null);
  const byId = new Map((agents.data ?? []).map((agent) => [agent.id, agent]));
  const first = agentIds[0] ? byId.get(agentIds[0]) : undefined;
  const second = agentIds[1] ? byId.get(agentIds[1]) : undefined;
  const columns = reviewColumns(agentIds, show);

  // Once the agents are there: the focus into the first file list – never while a dialog is open, and
  // never away from where the user already put it (a late answer does not move the focus).
  useEffect(() => {
    if (!agents.isSuccess || !viewMayTakeFocus()) return;
    const current = document.activeElement;
    if (current && current !== document.body && !root.current?.contains(current)) return;
    root.current?.querySelector<HTMLElement>('[data-review-list] [role="option"], [data-review-list] [role="listbox"]')?.focus();
  }, [agents.isSuccess]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The diff grid stops Esc while it clears a line selection; only a plain Esc arrives here.
    if (isPlainEscape(event.nativeEvent) && !hasOpenDialog()) {
      event.preventDefault();
      closeAgentReview(tabId);
    }
  };

  const title = first && second ? t("agents.review.titleTwo", { a: displayName(first), b: displayName(second) }) : t("agents.review.title", { name: first ? displayName(first) : "" });

  return (
    <section ref={root} data-screen="agent-review" aria-label={t("agents.review.label")} onKeyDown={onKeyDown} className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex min-h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1">
        <h1 className="min-w-0 flex-1 truncate text-md font-semibold text-text">{title}</h1>
        {first && second ? (
          <SegmentedControl<AgentReviewShow>
            label={t("agents.review.columns")}
            value={show}
            onValueChange={(value) => showColumns(tabId, value)}
            options={[
              { value: "first", label: displayName(first) },
              { value: "second", label: displayName(second) },
              { value: "both", label: t("agents.review.sideBySide") },
            ]}
          />
        ) : null}
        {second ? (
          <Button size="sm" variant="ghost" data-action="review-stop-comparing" onClick={() => stopComparing(tabId)}>
            {t("agents.review.stopComparing")}
          </Button>
        ) : first ? (
          <Button size="sm" variant="ghost" data-action="review-compare" onClick={() => void pickComparison(repoId, tabId, agentIds)}>
            {t("agents.review.compare")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" data-action="review-close" onClick={() => closeAgentReview(tabId)}>
          {t("agents.review.close")}
        </Button>
      </header>
      {agents.isPending ? null : !first ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState title={t("agents.review.gone")} />
        </div>
      ) : (
        <div className={cn("grid min-h-0 flex-1", columns.length === 2 ? "grid-cols-2 divide-x divide-border" : "grid-cols-1")}>
          {columns.map((id) => {
            const agent = byId.get(id);
            return agent ? (
              <ReviewPane key={id} repoId={repoId} tabId={tabId} agent={agent} compact={columns.length === 2} />
            ) : (
              <div key={id} className="flex items-center justify-center">
                <EmptyState title={t("agents.review.gone")} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
