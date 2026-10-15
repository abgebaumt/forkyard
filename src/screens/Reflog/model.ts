/** Pure helpers of the reflog view: the ref filter and the action names. */
import type { ReflogAction, ReflogEntry, RefsSnapshot } from "../../core";
import type { SelectOption } from "../../ui/Select";
import { t } from "../../i18n";

/** Filter value for HEAD (the select list needs a non-empty value). */
export const HEAD_VALUE = "HEAD";

export const refValue = (ref: string | null): string => ref ?? HEAD_VALUE;
export const refFromValue = (value: string): string | null => (value === HEAD_VALUE ? null : value);

/** HEAD first, then the local branches; a remote branch opened from its menu stays selectable. */
export function refOptions(refs: RefsSnapshot | undefined, current: string | null): SelectOption[] {
  const options: SelectOption[] = [{ value: HEAD_VALUE, label: "HEAD" }];
  for (const ref of refs?.locals ?? []) options.push({ value: ref.fullName, label: ref.name });
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current.replace(/^refs\/(heads|remotes)\//, "") });
  }
  return options;
}

const ACTION_LABELS: Record<ReflogAction, string> = {
  checkout: t("reflog.action.checkout"),
  commit: t("reflog.action.commit"),
  reset: t("reflog.action.reset"),
  rebase: t("reflog.action.rebase"),
  merge: t("reflog.action.merge"),
  pull: t("reflog.action.pull"),
  cherry_pick: t("reflog.action.cherryPick"),
  amend: t("reflog.action.amend"),
  other: t("reflog.action.other"),
};

export const actionLabel = (action: ReflogAction): string => ACTION_LABELS[action];

/**
 * The selected reflog entry, kept by what it is rather than by `HEAD@{n}`: a new entry on top
 * renumbers every selector, but the entry itself (commit, time, Git's text) stays the same.
 */
export interface ReflogSelection {
  key: string;
  /** Position when it was selected – the fallback if the entry is gone. */
  index: number;
}

export const entryKey = (entry: Pick<ReflogEntry, "sha" | "time" | "message">): string => `${entry.sha}\u0000${entry.time}\u0000${entry.message}`;

/**
 * Index of the selected entry in `entries`. `found: false` means the selection has to be (re)made –
 * nothing chosen yet (the first entry) or the entry has gone (the nearest position).
 */
export function resolveSelection(entries: readonly Pick<ReflogEntry, "sha" | "time" | "message">[], selection: ReflogSelection | null): { index: number; found: boolean } {
  if (!selection) return { index: 0, found: false };
  let best = -1;
  entries.forEach((entry, index) => {
    if (entryKey(entry) !== selection.key) return;
    if (best < 0 || Math.abs(index - selection.index) < Math.abs(best - selection.index)) best = index;
  });
  if (best >= 0) return { index: best, found: true };
  return { index: Math.max(0, Math.min(selection.index, entries.length - 1)), found: false };
}

/**
 * The entry that still has to be selected so that the highlight and the commit panel agree: the first
 * one when the reflog opens, the nearest one when the selected entry has gone. null = nothing to do.
 */
export const entryToSelect = (entries: readonly unknown[], resolved: { index: number; found: boolean }): number | null =>
  !resolved.found && entries.length > 0 ? resolved.index : null;
