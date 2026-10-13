/**
 * Write actions of the diff view: stage, unstage and discard hunks and lines, plus the three
 * view settings. Everything goes through `runAction`; the result (status) is put into the query
 * cache right away, the core's events take care of the rest.
 */
import { core, type DiffMode, type Id, type PatchSelection, type Settings, type Status } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { undo } from "../../app/actions/undo";
import { confirm } from "../../app/dialogs";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { withStatus } from "../../app/statusCache";
import { toast } from "../../ui/Feedback";
import { t } from "../../i18n";

export type PatchAction = "stage" | "unstage" | "discard";

export type PatchOutcome =
  | { result: "done"; status: Status }
  /** The file changed since it was loaded; the diff is reloaded. */
  | { result: "stale" }
  | { result: "cancelled" }
  | { result: "failed" };

/** One key for all three actions: while one is running, the buttons are disabled. */
export const patchBusyKey = (repoId: Id) => busyKeys.write(repoId, "patch");

/** Reloads all diffs of this file (unstaged and staged, every option). */
export function reloadDiffs(repoId: Id, path: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: qk.diffAll(repoId),
    predicate: (query) => query.queryKey[4] === path,
  });
}

const labels: Record<PatchAction, string> = { stage: t("diff.patch.stage"), unstage: t("diff.patch.unstage"), discard: t("diff.patch.discard") };

/**
 * Runs stage, unstage or discard for a selection.
 * `lines`: number of selected lines, or null for a whole hunk (only for the texts).
 */
export async function applyPatch(action: PatchAction, repoId: Id, selection: PatchSelection, lines: number | null): Promise<PatchOutcome> {
  if (action === "discard") {
    const ok = await confirm({
      title: lines === null ? t("diff.discard.hunkTitle", { path: selection.path }) : t("diff.discard.linesTitle", { count: lines, path: selection.path }),
      body: lines === null ? t("diff.discard.hunkBody") : t("diff.discard.linesBody"),
      confirmLabel: lines === null ? t("diff.hunk.discard") : t("diff.selection.discard", { count: lines }),
      danger: true,
    });
    if (!ok) return { result: "cancelled" };
  }

  const call = action === "stage" ? core.stagePatch : action === "unstage" ? core.unstagePatch : core.discardPatch;
  const outcome = await runAction(labels[action], withStatus(repoId, () => call({ repoId, selection })), { busyKey: patchBusyKey(repoId), quiet: ["stale_state"] });

  if (!outcome.ok) {
    if (outcome.error.code === "stale_state") {
      void reloadDiffs(repoId, selection.path);
      toast({ tone: "info", title: t("diff.stale.title"), description: t("diff.stale.body") });
      return { result: "stale" };
    }
    if (outcome.error.code === "duplicate") return { result: "cancelled" };
    return { result: "failed" };
  }

  void reloadDiffs(repoId, selection.path);
  if (action === "discard") {
    void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
    toast({
      tone: "success",
      title: lines === null ? t("diff.discard.hunkDone") : t("diff.discard.linesDone", { count: lines }),
      action: { label: t("diff.undo"), onClick: () => void undo(repoId) },
    });
  }
  return { result: "done", status: outcome.value };
}

/** Saves a view setting (mode, wrapping, whitespace) and puts it into the cache right away. */
export async function saveViewSetting(patch: Partial<Pick<Settings, "diffMode" | "diffWordWrap" | "diffIgnoreWhitespace">>): Promise<void> {
  // Switch immediately; the core's answer only confirms.
  const before = queryClient.getQueryData<Settings>(qk.settings);
  if (before) queryClient.setQueryData(qk.settings, { ...before, ...patch });
  const result = await runAction(t("diff.saveSetting"), () => core.settingsSet({ patch }));
  if (result.ok) queryClient.setQueryData(qk.settings, result.value);
  else if (before) queryClient.setQueryData(qk.settings, before);
}

export const modeLabels: Record<DiffMode, string> = { hunks: t("diff.mode.hunks"), inline: t("diff.mode.inline"), split: t("diff.mode.split") };
