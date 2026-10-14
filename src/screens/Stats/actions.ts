/**
 * Opening and closing the statistics view, and the choice it reopens with. The view opens via
 * its toolbar button or the palette and closes only via the button (store.ts `leavingStats`),
 * back to the view it replaced.
 */
import type { Id } from "../../core";
import { getTabView, leavingStats, useAppStore, type CenterView } from "../../app/store";
import type { StatsPreset } from "./model";

/** Per tab: the centre the statistics replaced. */
const before = new Map<Id, CenterView>();

/** Shows the statistics of the tab's repository in the centre. */
export function openStats(tabId: Id): void {
  const center = getTabView(tabId).center;
  if (center.kind === "stats") return;
  before.set(tabId, center);
  useAppStore.getState().setCenter(tabId, { kind: "stats" });
}

/** Back to the view the statistics replaced (the graph if there was none). */
export function closeStats(tabId: Id): void {
  if (getTabView(tabId).center.kind !== "stats") return;
  const target = before.get(tabId) ?? { kind: "graph" };
  before.delete(tabId);
  leavingStats(() => useAppStore.getState().setCenter(tabId, target));
}

/** The toolbar button. */
export function toggleStats(tabId: Id): void {
  if (getTabView(tabId).center.kind === "stats") closeStats(tabId);
  else openStats(tabId);
}

/** For the view's own links (file history, commit in the graph): they leave it on purpose. */
export function leaveStats(change: () => void): void {
  leavingStats(change);
}

/** Period and branch of the view. */
export interface StatsChoice {
  preset: StatsPreset;
  ref: string;
}

const DEFAULT_CHOICE: StatsChoice = { preset: "all", ref: "HEAD" };
/** Per tab, for this session only: a file history opened from the view remounts it on the way back. */
const choices = new Map<Id, StatsChoice>();

export function rememberedChoice(tabId: Id): StatsChoice {
  return choices.get(tabId) ?? DEFAULT_CHOICE;
}

export function rememberChoice(tabId: Id, choice: StatsChoice): void {
  choices.set(tabId, choice);
}
