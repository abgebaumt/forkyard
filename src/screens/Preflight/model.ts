/** Pure decisions of the preflight before merge, rebase, cherry-pick and revert. No React, no core calls. */
import type { ConflictPreview } from "../../core";

export interface PreflightFacts {
  /** null = no answer in time (or the check failed). */
  preview: ConflictPreview | null;
  /** Local branches a rebase could move along (`--update-refs`). */
  dependents: string[];
}

/** Files the preview expects conflicts in (empty if none or unknown). */
export function conflictFiles(preview: ConflictPreview | null): string[] {
  return preview?.status === "conflicts" ? preview.files : [];
}

/** A dialog only when there is something to say: expected conflicts or branches to move along. */
export function needsDialog(facts: PreflightFacts): boolean {
  return conflictFiles(facts.preview).length > 0 || facts.dependents.length > 0;
}
