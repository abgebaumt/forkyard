import { describe, expect, it } from "vitest";
import type { CleanupPreview, CleanupResult, CleanupUndoBackup } from "../../core";
import { backupsOlderThan, durationParts, initialForm, lowSpace, outcomeOf, plannedSteps, sizeChange, stepPosition, toOptions, visibleOptions } from "./model";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function preview(change: Partial<CleanupPreview> = {}): CleanupPreview {
  return {
    objects: { looseCount: 120, looseBytes: 480 * 1024, inPack: 9000, packs: 2, packBytes: 200 * MB, garbageCount: 0, garbageBytes: 0, totalBytes: 200 * MB + 480 * 1024 },
    lfsBytes: null,
    undoBackups: [],
    orphanedWorktrees: 0,
    linkedWorktrees: 0,
    oldReflogEntries: 0,
    freeBytes: 50 * GB,
    ...change,
  };
}

describe("sizes", () => {
  it("shows before → after in German and English", () => {
    expect(sizeChange(1.2 * GB, 340 * MB, "de-DE")).toBe("1,2 GB → 340 MB");
    expect(sizeChange(1.2 * GB, 340 * MB, "en-US")).toBe("1.2 GB → 340 MB");
    expect(sizeChange(800 * MB, 120 * MB, "de-DE")).toBe("800 MB → 120 MB");
    expect(sizeChange(512, 0, "en-US")).toBe("512 B → 0 B");
  });
});

describe("undo backups for N days", () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const backups: CleanupUndoBackup[] = [
    { entryId: "a", createdAt: "2026-10-16T06:00:00.000Z", orphaned: false }, // 6 hours old
    { entryId: "b", createdAt: "2026-10-03T12:00:00.000Z", orphaned: false }, // 13 days
    { entryId: "c", createdAt: "2026-10-01T11:59:00.000Z", orphaned: true }, // a little over 15 days
    { entryId: "d", createdAt: "2025-01-01T00:00:00.000Z", orphaned: true }, // well over a year
    { entryId: "e", createdAt: null, orphaned: true }, // backup on a tree: age unknown
  ];

  it("counts backups older than N plus those of unknown age", () => {
    expect(backupsOlderThan(backups, 14, now)).toBe(3);
    expect(backupsOlderThan(backups, 30, now)).toBe(2);
    expect(backupsOlderThan(backups, 1, now)).toBe(4);
    expect(backupsOlderThan(backups, 3650, now)).toBe(1);
  });
});

describe("which options the dialog shows and sends", () => {
  it("hides LFS without LFS and the worktree option without orphaned worktrees", () => {
    expect(visibleOptions(preview())).toEqual({ lfs: false, worktrees: false });
    expect(visibleOptions(preview({ lfsBytes: 0, orphanedWorktrees: 2 }))).toEqual({ lfs: true, worktrees: true });
  });

  it("starts with Normal, the reflog off, undo backups off and 14 days", () => {
    expect(initialForm(preview())).toEqual({ mode: "normal", lfs: false, worktrees: false, undo: false, undoDays: 14, reflog: false });
    expect(initialForm(preview({ orphanedWorktrees: 1 })).worktrees).toBe(true);
    expect(initialForm(preview({ lfsBytes: 4096 })).lfs).toBe(false);
  });

  it("never sends a hidden option and keeps the days within 1 to 3650", () => {
    const form = { mode: "thorough" as const, lfs: true, worktrees: true, undo: true, undoDays: 0, reflog: true };
    expect(toOptions(form, { lfs: false, worktrees: false })).toEqual({ mode: "thorough", lfs: false, worktrees: false, undoOlderThanDays: 1, reflog: true });
    expect(toOptions({ ...form, undoDays: 99_999 }, { lfs: true, worktrees: true })).toEqual({ mode: "thorough", lfs: true, worktrees: true, undoOlderThanDays: 3650, reflog: true });
    expect(toOptions({ ...form, undo: false }, { lfs: true, worktrees: true }).undoOlderThanDays).toBeNull();
  });

  it("warns about space only when the packs need more than is free", () => {
    expect(lowSpace(preview({ freeBytes: 100 * MB }))).toBe(true);
    expect(lowSpace(preview({ freeBytes: 300 * MB }))).toBe(false);
    expect(lowSpace(preview({ freeBytes: null }))).toBe(false);
  });
});

describe("progress and result", () => {
  it("reads “step n of m” from the step key in the job line", () => {
    const planned = plannedSteps({ mode: "normal", lfs: true, worktrees: true, undoOlderThanDays: 14, reflog: false });
    expect(planned).toEqual(["worktrees", "undo", "lfs", "gc"]);
    expect(stepPosition(planned, "undo")).toEqual({ step: "undo", index: 2, total: 4 });
    expect(stepPosition(planned, "gc")).toEqual({ step: "gc", index: 4, total: 4 });
    expect(stepPosition(planned, "waiting")).toBeNull();
    expect(stepPosition(planned, "reflog")).toBeNull();
    expect(plannedSteps({ mode: "thorough", lfs: false, worktrees: false, undoOlderThanDays: null, reflog: false })).toEqual(["gc"]);
  });

  it("splits the duration and names the outcome", () => {
    expect(durationParts(61_400)).toEqual({ minutes: 1, seconds: 1 });
    expect(durationParts(59_600)).toEqual({ minutes: 1, seconds: 0 });
    expect(durationParts(4_200)).toEqual({ minutes: 0, seconds: 4 });
    const base: CleanupResult = { before: preview().objects, after: preview().objects, lfsBefore: null, lfsAfter: null, steps: [], durationMs: 0, cancelled: false, failure: null };
    expect(outcomeOf(base)).toBe("done");
    expect(outcomeOf({ ...base, cancelled: true })).toBe("cancelled");
    expect(outcomeOf({ ...base, failure: { step: "gc", error: { code: "locked", message: "x", gitOutput: null }, gcPid: 4711, diskFull: false } })).toBe("failed");
  });
});
