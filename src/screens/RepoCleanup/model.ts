/**
 * Pure logic of the clean-up dialog: which options it shows, what it sends, how it reads the
 * core's progress and result. No React and no core calls – tested in model.test.ts.
 */
import type { CleanupMode, CleanupOptions, CleanupPreview, CleanupResult, CleanupStep, CleanupUndoBackup } from "../../core";
import { formatBytes } from "../../app/format";

/** The core's order of the steps (crates/core/src/commands/cleanup/run.rs, `ORDER`). */
export const STEP_ORDER: readonly CleanupStep[] = ["worktrees", "undo", "reflog", "lfs", "gc"];
export const DEFAULT_UNDO_DAYS = 14;
export const MIN_UNDO_DAYS = 1;
export const MAX_UNDO_DAYS = 3650;
const DAY_MS = 86_400_000;

/** What the user chose in the dialog. */
export interface CleanupForm {
  mode: CleanupMode;
  lfs: boolean;
  worktrees: boolean;
  undo: boolean;
  undoDays: number;
  reflog: boolean;
}

export interface VisibleOptions {
  lfs: boolean;
  worktrees: boolean;
}

export type CleanupOutcome = "done" | "failed" | "cancelled";

/** LFS only when the repository uses it; orphaned worktrees only when there are some. */
export function visibleOptions(preview: CleanupPreview): VisibleOptions {
  return { lfs: preview.lfsBytes !== null, worktrees: preview.orphanedWorktrees > 0 };
}

/** Normal; orphaned worktrees ticked when shown; LFS, undo backups and the reflog unticked. */
export function initialForm(preview: CleanupPreview): CleanupForm {
  return { mode: "normal", lfs: false, worktrees: visibleOptions(preview).worktrees, undo: false, undoDays: DEFAULT_UNDO_DAYS, reflog: false };
}

export function clampDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_UNDO_DAYS;
  return Math.min(MAX_UNDO_DAYS, Math.max(MIN_UNDO_DAYS, Math.round(days)));
}

/** What goes to `repoCleanupRun`; a hidden option is never sent. */
export function toOptions(form: CleanupForm, visible: VisibleOptions): CleanupOptions {
  return {
    mode: form.mode,
    lfs: visible.lfs && form.lfs,
    worktrees: visible.worktrees && form.worktrees,
    undoOlderThanDays: form.undo ? clampDays(form.undoDays) : null,
    reflog: form.reflog,
  };
}

/** The steps that will run, in the core's order (`gc` always). */
export function plannedSteps(options: CleanupOptions): CleanupStep[] {
  const chosen: Record<CleanupStep, boolean> = {
    worktrees: options.worktrees,
    undo: options.undoOlderThanDays !== null,
    reflog: options.reflog,
    lfs: options.lfs,
    gc: true,
  };
  return STEP_ORDER.filter((step) => chosen[step]);
}

/** “Step 2 of 4”: where the run is, from the step key in `job:progress.line`; null while it waits. */
export function stepPosition(planned: readonly CleanupStep[], line: string): { step: CleanupStep; index: number; total: number } | null {
  const index = planned.indexOf(line as CleanupStep);
  const step = index < 0 ? undefined : planned[index];
  return step === undefined ? null : { step, index: index + 1, total: planned.length };
}

/** Backups a run would remove for `days`: older than the limit, or of unknown age. */
export function backupsOlderThan(backups: readonly CleanupUndoBackup[], days: number, now: number = Date.now()): number {
  const cutoff = now - clampDays(days) * DAY_MS;
  return backups.filter((backup) => {
    if (backup.createdAt === null) return true;
    const at = Date.parse(backup.createdAt);
    return Number.isNaN(at) || at < cutoff;
  }).length;
}

/** Thorough repacks everything: with less free space than the packs take, it probably runs out. */
export function lowSpace(preview: CleanupPreview): boolean {
  return preview.freeBytes !== null && preview.freeBytes < preview.objects.packBytes;
}

/** “1.2 GB → 340 MB” in the UI language (`loc` for tests). */
export function sizeChange(before: number, after: number, loc?: string): string {
  return `${formatBytes(before, loc)} → ${formatBytes(after, loc)}`;
}

export function durationParts(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.round(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

export function outcomeOf(result: CleanupResult): CleanupOutcome {
  if (result.failure) return "failed";
  return result.cancelled ? "cancelled" : "done";
}
