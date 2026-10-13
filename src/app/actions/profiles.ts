/**
 * Switching profiles – shared by the profile chip, the command palette and the settings.
 * On a switch the core closes the old profile's tabs and opens the new one's.
 */
import { t } from "../../i18n";
import { core, type Profile } from "../../core";
import { type Losses } from "../closeGuard";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { hasDirtyCenter, useAppStore, type AppState } from "../store";
import { unsavedFiles } from "../../screens/FileView/buffer";
import { writesSettled } from "../writeQueue";
import { toast } from "../../ui/Feedback";

/** Lane colour 1–8 of a profile: the stored one, otherwise by position in the list. */
export function profileColor(profile: Pick<Profile, "color">, index: number): number {
  return profile.color ?? (index % 8) + 1;
}

/**
 * What is open at the switch. Unlike on quit, every running action counts (push, pull,
 * commit …), not just those with a prompt on quit: their tab closes with the switch.
 */
export function switchLosses(state: Pick<AppState, "jobs" | "busy">, files: string[], views: boolean): Losses {
  const jobs = Object.values(state.jobs).map((job) => job.title);
  if (jobs.length === 0 && Object.keys(state.busy).length > 0) jobs.push(t("actions.profiles.someAction"));
  return { jobs, files, views };
}

/** Text of the prompt before the switch, or null if nothing will be lost. */
export function switchWarning(now: Losses): string | null {
  const lines: string[] = [];
  if (now.jobs.length > 0) {
    lines.push(now.jobs.length === 1 ? t("actions.profiles.warning.jobOne", { job: now.jobs[0] }) : t("actions.profiles.warning.jobMany", { count: now.jobs.length }));
  }
  if (now.views) lines.push(t("actions.profiles.warning.views"));
  if (now.files.length > 0) {
    lines.push(now.files.length === 1 ? t("actions.profiles.warning.fileOne") : t("actions.profiles.warning.fileMany", { count: now.files.length }));
  }
  return lines.length > 0 ? lines.join(" ") : null;
}

/** Reload what depends on the profile: identity in every repository's status, keys, credentials. */
export function refreshAfterProfileChange(switched: boolean) {
  void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" && query.queryKey[2] === "status" });
  if (switched) {
    for (const key of [qk.settings, qk.tabs, qk.sshKeys, qk.credentials, qk.repos]) void queryClient.invalidateQueries({ queryKey: key });
  }
}

/**
 * Switches the active profile. Asks only if something would be lost; commit drafts are
 * kept anyway. Returns whether it switched.
 */
export async function switchProfile(profile: Profile): Promise<boolean> {
  if (profile.isActive) return true;
  const files = unsavedFiles().map((file) => file.path);
  const warning = switchWarning(switchLosses(useAppStore.getState(), files, hasDirtyCenter()));
  if (warning) {
    const ok = await confirm({ title: t("actions.profiles.switch.title", { name: profile.name }), body: warning, confirmLabel: t("actions.profiles.switch.action") });
    if (!ok) return false;
  }
  // A settings change still in flight belongs to the old profile.
  await writesSettled();
  const result = await runAction(t("actions.profiles.switch.action"), () => core.profileActivate({ id: profile.id }));
  if (!result.ok) return false;
  queryClient.setQueryData(qk.profiles, result.value);
  refreshAfterProfileChange(true);
  toast({
    tone: "success",
    title: t("actions.profiles.switch.done", { name: profile.name }),
    description: profile.authorName ? t("actions.profiles.switch.author", { author: profile.authorName }) : undefined,
  });
  return true;
}
