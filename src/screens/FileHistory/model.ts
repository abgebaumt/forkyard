/** Pure parts of the file history: which version a row means, former names and the list keys. */
import type { FileHistoryEntry, Sha } from "../../core";

/**
 * Which revision a row of the history shows. For a deleting commit the file no longer exists
 * there – what is meant then is the version directly before (first parent).
 */
export function versionOf(entry: FileHistoryEntry): { sha: Sha | null; path: string; beforeDelete: boolean } {
  if (entry.status === "deleted") return { sha: entry.commit.parents[0] ?? null, path: entry.path, beforeDelete: true };
  return { sha: entry.commit.sha, path: entry.path, beforeDelete: false };
}

export /** Former name that a row mentions in addition: for the rename itself and for all commits before it. */
function formerName(entry: FileHistoryEntry, currentPath: string): { kind: "renamed" | "then"; path: string } | null {
  if (entry.status === "renamed" && entry.oldPath) return { kind: "renamed", path: entry.oldPath };
  return entry.path !== currentPath ? { kind: "then", path: entry.path } : null;
}

/** Every former name of the file (newest first), without the current one. */
export const olderNamesOf = (entries: FileHistoryEntry[], path: string): string[] =>
  Array.from(new Set(entries.map((entry) => entry.path).filter((name) => name !== path)));

export type HistoryKey = { kind: "select"; index: number } | { kind: "open" } | { kind: "blame" } | { kind: "reveal" } | { kind: "menu" };

/** What a key in the history list does; `page`: rows per page. null = not a key of the list. */
export function historyKey(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  selected: number,
  page: number,
  count: number,
): HistoryKey | null {
  const select = (index: number): HistoryKey => ({ kind: "select", index: Math.min(count - 1, Math.max(0, index)) });
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
  const { key } = event;
  if (key === "ArrowDown" && plain) return select(selected + 1);
  if (key === "ArrowUp" && plain) return select(selected - 1);
  if (key === "PageDown" && plain) return select(selected + page);
  if (key === "PageUp" && plain) return select(selected - page);
  if (key === "Home" && plain) return select(0);
  if (key === "End" && plain) return select(count - 1);
  if (key === "Enter" && plain) return { kind: "open" };
  if ((key === "b" || key === "B") && plain && !event.shiftKey) return { kind: "blame" };
  if ((key === "g" || key === "G") && plain && !event.shiftKey) return { kind: "reveal" };
  if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) return { kind: "menu" };
  return null;
}
