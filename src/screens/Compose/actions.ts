/** Who may see "Compose commits", and opening and closing it (v1.2, 3.2). */
import type { AiStatus, Id, RepoSettings, Status } from "../../core";
import { openAiSetup } from "../../app/ai/open";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { qk, queryClient } from "../../app/queries";
import { getTabView, useAppStore } from "../../app/store";

/** The AI element is visible: AI on (connected or not), compose not switched off, the repository not "AI off". */
export function composeVisible(ai: AiStatus | null | undefined, repoSettings: RepoSettings | null | undefined): boolean {
  return featureVisible(ai, "compose", repoSettings?.aiOff ?? false);
}

/** Anything to compose: staged, unstaged or untracked changes. */
export function hasChanges(status: Status | null | undefined): boolean {
  return Boolean(status && status.staged.length + status.unstaged.length > 0);
}

export function openCompose(tabId: Id): void {
  if (getTabView(tabId).center.kind === "compose") return;
  useAppStore.getState().setCenter(tabId, { kind: "compose" });
}

/** The button and the palette: without a connected provider the setup dialog opens instead (spec 1.3). */
export function startCompose(tabId: Id): void {
  if (aiVisibility(queryClient.getQueryData<AiStatus>(qk.aiStatus)).elementsOpenSetup) void openAiSetup();
  else openCompose(tabId);
}

export function closeCompose(tabId: Id): void {
  if (getTabView(tabId).center.kind === "compose") useAppStore.getState().closeCenter(tabId);
}
