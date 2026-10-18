/** Opening and closing the agent cockpit (`CenterView { kind: "cockpit" }`): back to the view it replaced. */
import type { Id } from "../../core";
import { getTabView, useAppStore, type CenterView } from "../../app/store";

const before = new Map<Id, CenterView>();

export function openCockpit(tabId: Id): void {
  const center = getTabView(tabId).center;
  if (center.kind === "cockpit") return;
  before.set(tabId, center);
  useAppStore.getState().setCenter(tabId, { kind: "cockpit" });
}

export function closeCockpit(tabId: Id): void {
  if (getTabView(tabId).center.kind !== "cockpit") return;
  const target = before.get(tabId) ?? { kind: "graph" };
  before.delete(tabId);
  useAppStore.getState().setCenter(tabId, target);
}

export function toggleCockpit(tabId: Id): void {
  if (getTabView(tabId).center.kind === "cockpit") closeCockpit(tabId);
  else openCockpit(tabId);
}
