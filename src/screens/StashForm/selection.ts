/**
 * Selected lines waiting for a partial stash: the diff view collects them per file (staged or
 * unstaged), the stash form shows “only the selection (n files, m lines)” and sends them. A
 * selection belongs to one HEAD; once HEAD moves, it no longer counts.
 */
import type { Id, PatchSelection, StashSelection, Status } from "../../core";
import { qk, queryClient } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { useWipStore } from "../WipPanel/state";

export interface PendingEntry {
  area: "staged" | "unstaged";
  selection: PatchSelection;
  /** Number of selected lines (for the label only). */
  lines: number;
}

export interface PendingStash {
  head: string;
  entries: PendingEntry[];
}

/** Adds the selection of one file; the same file in the same area is replaced. Another HEAD starts over. */
export function addToPending(pending: PendingStash | null, head: string, entry: PendingEntry): PendingStash {
  const kept = pending && pending.head === head ? pending.entries.filter((item) => !(item.area === entry.area && item.selection.path === entry.selection.path)) : [];
  return { head, entries: [...kept, entry] };
}

export function pendingCounts(pending: PendingStash): { files: number; lines: number } {
  return {
    files: new Set(pending.entries.map((item) => item.selection.path)).size,
    lines: pending.entries.reduce((sum, item) => sum + item.lines, 0),
  };
}

/** The core's input. */
export function toStashSelection(pending: PendingStash): StashSelection {
  return {
    expectHead: pending.head,
    staged: pending.entries.filter((item) => item.area === "staged").map((item) => item.selection),
    unstaged: pending.entries.filter((item) => item.area === "unstaged").map((item) => item.selection),
  };
}

/** The pending selection if it still belongs to the current HEAD. */
export function currentPending(pending: PendingStash | null, status: Status | undefined): PendingStash | null {
  if (!pending || !status || status.head.kind === "unborn") return null;
  return status.head.sha === pending.head ? pending : null;
}

/** From the diff view: remember the selection and open the stash form. false = no commit yet. */
export function queueStashSelection(repoId: Id, tabId: Id, area: "staged" | "unstaged", selection: PatchSelection, lines: number): boolean {
  const status = queryClient.getQueryData<Status>(qk.status(repoId));
  if (!status || status.head.kind === "unborn") return false;
  const head = status.head.sha;
  useWipStore.getState().patch(tabId, (tab) => ({ stashSelection: addToPending(tab.stashSelection, head, { area, selection, lines }), stashOnlySelected: false }));
  useAppStore.getState().setRightPanel(tabId, "stash_form");
  return true;
}
