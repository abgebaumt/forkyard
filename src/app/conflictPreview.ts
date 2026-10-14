/**
 * Conflict preview for dialogs and tools: asks the core (debounced) whether a merge, rebase,
 * cherry-pick or revert would stop on conflicts. The answer is a state for the view, never a
 * toast; a running check is cancelled when the operation changes or the view goes away.
 */
import { useEffect, useState } from "react";
import { core, type ConflictPreview, type Id, type PreviewOp } from "../core";
import { t } from "../i18n";
import { toCoreError } from "./errors";
import { newJobId } from "./run";
import { useAppStore } from "./store";

/** Wait this long after the last change before asking (reordering in the rebase tool). */
export const PREVIEW_DELAY_MS = 300;

export type PreviewState = { state: "idle" } | { state: "checking" } | { state: "done"; result: ConflictPreview } | { state: "failed" };

/** Stable key: the same operation does not trigger a second check. */
export function previewKey(op: PreviewOp | null): string {
  return op ? JSON.stringify(op) : "";
}

/** One line for the state; null = nothing to show. */
export function previewText(state: PreviewState, shortSha: (sha: string) => string): string | null {
  switch (state.state) {
    case "idle":
      return null;
    case "checking":
      return t("conflictPreview.checking");
    case "failed":
      return t("conflictPreview.failed");
    case "done": {
      const result = state.result;
      if (result.status === "clean") return t("conflictPreview.clean");
      if (result.status === "unknown") return t("conflictPreview.unknown", { reason: result.reason });
      const files = t("conflictPreview.conflicts", { count: result.files.length });
      return result.atCommit ? t("conflictPreview.conflictsFrom", { files, sha: shortSha(result.atCommit) }) : files;
    }
  }
}

/** Checks `op` (null = nothing to check) and keeps the answer up to date. */
export function useConflictPreview(repoId: Id | null | undefined, op: PreviewOp | null): PreviewState {
  const key = previewKey(op);
  const [state, setState] = useState<PreviewState>({ state: "idle" });
  useEffect(() => {
    if (!repoId || !op) {
      setState({ state: "idle" });
      return;
    }
    let live = true;
    const jobId = newJobId();
    setState({ state: "checking" });
    const timer = window.setTimeout(() => {
      core.conflictPreview({ repoId, jobId, op }).then(
        (result) => {
          if (live) setState({ state: "done", result });
        },
        (error: unknown) => {
          if (live && toCoreError(error).code !== "cancelled") setState({ state: "failed" });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      void core.jobCancel({ jobId }).catch(() => undefined);
    };
    // `key` stands for `op`: a new object with the same content must not start a new check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, key]);
  return state;
}

/**
 * One check without a view, with a time limit; null = no answer in time or the check failed.
 * While it runs, the status bar shows “Checking for conflicts…” (with cancel).
 */
export async function previewOnce(repoId: Id, op: PreviewOp, limitMs: number): Promise<ConflictPreview | null> {
  const jobId = newJobId();
  let timer = 0;
  const late = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), limitMs);
  });
  useAppStore.getState().startJob({ id: jobId, title: t("conflictPreview.checking"), repoId });
  try {
    return await Promise.race([core.conflictPreview({ repoId, jobId, op }).catch(() => null), late]);
  } finally {
    window.clearTimeout(timer);
    useAppStore.getState().finishJob(jobId);
    void core.jobCancel({ jobId }).catch(() => undefined);
  }
}
