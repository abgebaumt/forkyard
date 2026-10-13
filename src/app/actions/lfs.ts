/**
 * Actions for Git LFS: track patterns and untrack them again, fetch LFS files, prune.
 * The UI for this is src/screens/Lfs.
 */
import { t } from "../../i18n";
import { core, type ErrorCode, type Id, type LfsStatus } from "../../core";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { newJobId, runAction, type ActionResult } from "../run";
import { clip } from "./context";

export const lfsBusyKey = (repoId: Id, what: "track" | "pull" | "prune") => `${repoId}:lfs:${what}`;

function afterChange(repoId: Id, status: LfsStatus) {
  queryClient.setQueryData(qk.lfs(repoId), status);
  // The .gitattributes is now changed: the list of local changes shows that.
  void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
}

/** Errors the form shows at the field instead of as a message at the edge. */
const AT_FIELD: ErrorCode[] = ["not_allowed", "name_exists", "invalid_name"];

/**
 * Validates a pattern before it goes to Git. Returns the reason it is not usable, or null.
 * `existing` are the patterns already tracked.
 */
export function patternProblem(pattern: string, existing: string[]): string | null {
  const value = pattern.trim();
  if (!value) return t("actions.lfs.pattern.empty");
  if (/[\r\n]/.test(value)) return t("actions.lfs.pattern.multiline");
  if (value.startsWith("#")) return t("actions.lfs.pattern.comment");
  if (value.startsWith("!")) return t("actions.lfs.pattern.negation");
  if (value === "*" || value === "**" || value === "**/*") return t("actions.lfs.pattern.everything");
  if (existing.includes(value)) return t("actions.lfs.pattern.exists", { pattern: value });
  return null;
}

export async function trackPattern(repoId: Id, pattern: string): Promise<ActionResult<LfsStatus>> {
  const value = pattern.trim();
  const result = await runAction(t("actions.lfs.track.label"), () => core.lfsTrack({ repoId, pattern: value }), {
    busyKey: lfsBusyKey(repoId, "track"),
    quiet: AT_FIELD,
    success: t("actions.lfs.track.done", { pattern: clip(value, 40) }),
  });
  if (result.ok) afterChange(repoId, result.value);
  return result;
}

export async function untrackPattern(repoId: Id, pattern: string): Promise<ActionResult<LfsStatus>> {
  const result = await runAction(t("actions.lfs.untrack.label"), () => core.lfsUntrack({ repoId, pattern }), {
    busyKey: lfsBusyKey(repoId, "track"),
    quiet: ["not_found"],
    success: t("actions.lfs.untrack.done", { pattern: clip(pattern, 40) }),
  });
  if (result.ok) afterChange(repoId, result.value);
  // The pattern was already no longer there (edited by hand): simply fetch the state again.
  else if (result.error.code === "not_found") void queryClient.invalidateQueries({ queryKey: qk.lfs(repoId) });
  return result;
}

/** Fetches the contents behind the LFS pointers of the checked-out state. Job in the status bar, cancellable. */
export async function pullLfs(repoId: Id, jobId: string = newJobId()) {
  return runAction(t("actions.lfs.pull.label"), () => core.lfsPull({ repoId, jobId }), {
    busyKey: lfsBusyKey(repoId, "pull"),
    job: { id: jobId, title: t("actions.lfs.pull.label"), repoId },
    success: t("actions.lfs.pull.done"),
  });
}

/** Prunes the local LFS storage – after a prompt. */
export async function pruneLfs(repoId: Id) {
  const ok = await confirm({
    title: t("actions.lfs.prune.title"),
    body: t("actions.lfs.prune.body"),
    confirmLabel: t("actions.lfs.prune.action"),
  });
  if (!ok) return null;
  return runAction(t("actions.lfs.prune.label"), () => core.lfsPrune({ repoId }), {
    busyKey: lfsBusyKey(repoId, "prune"),
    success: (summary) => (summary.trim() ? t("actions.lfs.prune.doneSummary", { summary: clip(summary.trim(), 120) }) : t("actions.lfs.prune.done")),
  });
}
