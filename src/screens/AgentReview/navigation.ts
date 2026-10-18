/**
 * Opening and closing the agent review (`CenterView { kind: "agent_review" }`): back to the view it
 * replaced (usually the cockpit); while it is open the right panel shows its commit field.
 */
import type { Id } from "../../core";
import { getTabView, useAppStore, type AgentReviewShow, type CenterView } from "../../app/store";
import { useReviewStore } from "./state";

const before = new Map<Id, CenterView>();

export function openAgentReview(tabId: Id, agentId: Id): void {
  const center = getTabView(tabId).center;
  if (center.kind !== "agent_review") before.set(tabId, center);
  const store = useAppStore.getState();
  store.setCenter(tabId, { kind: "agent_review", agentIds: [agentId], show: "first" });
  // The centre may refuse (statistics, unsaved conflict resolution): then the panel stays too.
  if (getTabView(tabId).center.kind === "agent_review") store.setRightPanel(tabId, "review_commit");
}

export function closeAgentReview(tabId: Id): void {
  if (getTabView(tabId).center.kind !== "agent_review") return;
  const target = before.get(tabId) ?? { kind: "cockpit" };
  before.delete(tabId);
  const store = useAppStore.getState();
  store.setCenter(tabId, target);
  store.setRightPanel(tabId, "details");
  useReviewStore.getState().forget(tabId);
}

/** Adds (or replaces) the second agent; both are shown side by side. */
export function compareWith(tabId: Id, agentId: Id): void {
  const center = getTabView(tabId).center;
  if (center.kind !== "agent_review") return;
  const [first] = center.agentIds;
  if (!first || first === agentId) return;
  useAppStore.getState().setCenter(tabId, { kind: "agent_review", agentIds: [first, agentId], show: "both" });
}

export function stopComparing(tabId: Id): void {
  const center = getTabView(tabId).center;
  if (center.kind !== "agent_review" || center.agentIds.length < 2) return;
  useAppStore.getState().setCenter(tabId, { kind: "agent_review", agentIds: [center.agentIds[0]!], show: "first" });
}

export function showColumns(tabId: Id, show: AgentReviewShow): void {
  const center = getTabView(tabId).center;
  if (center.kind !== "agent_review" || center.show === show) return;
  useAppStore.getState().setCenter(tabId, { ...center, show });
}
