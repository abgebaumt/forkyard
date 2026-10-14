/** Opening the statistics view, and the choice it reopens with. */
import type { Id } from "../../core";
import { useAppStore } from "../../app/store";
import type { StatsPreset } from "./model";

/** Shows the statistics of the tab's repository in the centre. */
export function openStats(tabId: Id): void {
  useAppStore.getState().setCenter(tabId, { kind: "stats" });
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
