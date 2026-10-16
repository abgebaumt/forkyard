/**
 * Repository clean-up: sends `repoCleanupRun` as a job (status bar, cancellable) and keeps the run
 * in `useCleanupRuns`, so the dialog may be closed while it runs. With the dialog closed, the
 * outcome comes as a message; an open dialog shows it itself.
 */
import { t } from "../../i18n";
import { core, CoreError, type CleanupOptions, type CleanupResult, type Id } from "../../core";
import { plannedSteps, sizeChange } from "../../screens/RepoCleanup/model";
import { useCleanupRuns } from "../../screens/RepoCleanup/runs";
import { toast } from "../../ui/Feedback";
import { toCoreError } from "../errors";
import { newJobId, showError } from "../run";
import { useAppStore } from "../store";

export const cleanupBusyKey = (repoId: Id) => `${repoId}:cleanup`;

/** Runs the clean-up; `null` if one already runs for the repository or the core refused it. */
export async function runCleanup(repoId: Id, options: CleanupOptions): Promise<CleanupResult | null> {
  const busyKey = cleanupBusyKey(repoId);
  if (useAppStore.getState().busy[busyKey]) return null;
  const jobId = newJobId();
  const label = t("cleanup.action.label");
  useCleanupRuns.getState().start(repoId, { jobId, startedAt: Date.now(), steps: plannedSteps(options) });
  useAppStore.getState().setBusy(busyKey, true);
  useAppStore.getState().startJob({ id: jobId, title: label, repoId });
  try {
    const result = await core.repoCleanupRun({ repoId, jobId, options });
    useCleanupRuns.getState().finish(repoId, { result });
    if (!useCleanupRuns.getState().isWatched(repoId)) announce(label, result);
    return result;
  } catch (raw) {
    const error = toCoreError(raw);
    useCleanupRuns.getState().finish(repoId, { error });
    if (!useCleanupRuns.getState().isWatched(repoId) && error.code !== "cancelled") showError(label, error);
    return null;
  } finally {
    useAppStore.getState().setBusy(busyKey, false);
    useAppStore.getState().finishJob(jobId);
  }
}

function announce(label: string, result: CleanupResult): void {
  if (result.failure) showError(label, new CoreError(result.failure.error));
  else if (!result.cancelled) toast({ tone: "success", title: t("cleanup.toast.done", { change: sizeChange(result.before.totalBytes, result.after.totalBytes) }) });
}

/** Asks the core to stop the running clean-up; finished steps stay. */
export function cancelCleanup(repoId: Id): void {
  const run = useCleanupRuns.getState().runs[repoId];
  if (!run || run.result || run.error || run.stopping) return;
  useCleanupRuns.getState().markStopping(repoId);
  void core.jobCancel({ jobId: run.jobId }).catch(() => undefined);
}
