/** Pure parts of the graph's edit view (EditHistory.tsx). */
import type { GraphRow, RebasePlanRow, Sha } from "../../core";
import type { PendingDrag } from "../../app/rebasePlan/graphEdit";
import type { PreviewState } from "../../app/conflictPreview";
import { type EditState, flipIndex, setMessage } from "../../app/rebasePlan/gestures";
import { joinMessage, rowRoles } from "../../app/rebasePlan/model";
import { isCommitRow } from "./model";

/** Loaded commit rows between the first range row and the base row (or the end) that are not in the range. */
export function hiddenCount(rows: GraphRow[], range: ReadonlySet<Sha>, base: Sha): number {
  const first = rows.findIndex((row) => isCommitRow(row) && range.has(row.sha));
  if (first < 0) return 0;
  let count = 0;
  for (const row of rows.slice(first)) {
    if (!isCommitRow(row)) continue;
    if (row.sha === base) break;
    if (!range.has(row.sha)) count += 1;
  }
  return count;
}

/** Conflict preview as a step of the plan: 1-based among the rows that are not dropped. */
export function previewStep(preview: PreviewState, rows: RebasePlanRow[]): { step: number; file: string } | null {
  if (preview.state !== "done" || preview.result.status !== "conflicts") return null;
  const { atCommit, files } = preview.result;
  const step = rows.filter((row) => row.action !== "drop").findIndex((row) => row.sha === atCommit);
  return step < 0 || !files[0] ? null : { step: step + 1, file: files[0] };
}

/** Rows whose own message counts: reword rows and the root of a squash group. */
export function hasOwnMessage(rows: RebasePlanRow[], index: number): boolean {
  const row = rows[index];
  return row?.action === "reword" || (row?.action === "pick" && rowRoles(rows)[index]!.squashed.length > 0);
}

/**
 * M / "Edit message …": a group root keeps its action and gets the result message; any other kept
 * row becomes a reword, or a plain pick again when the message equals the original. Folded and dropped rows have none.
 */
export function editMessage(state: EditState, sha: Sha, message: string): EditState {
  const index = state.rows.findIndex((row) => row.sha === sha);
  const row = state.rows[index];
  if (!row || (row.action !== "pick" && row.action !== "reword")) return state;
  if (row.action === "pick" && hasOwnMessage(state.rows, index)) return setMessage(state, sha, message);
  const unchanged = message === joinMessage({ summary: row.summary, description: row.description });
  const rows = [...state.rows];
  rows[index] = unchanged ? { ...row, action: "pick", message: null } : { ...row, action: "reword", message };
  return { ...state, rows };
}

/** A drag from a graph row as the list's `initialDrag` (displayed position); none once its pointer went up while the plan loaded. */
export function takenOverDrag(
  drag: PendingDrag | null,
  rows: RebasePlanRow[],
): { index: number; pointerId: number; clientX: number; clientY: number } | null {
  const index = drag && !drag.released ? rows.findIndex((row) => row.sha === drag.sha) : -1;
  return drag && index >= 0
    ? { index: flipIndex(rows.length, index), pointerId: drag.pointerId, clientX: drag.clientX, clientY: drag.clientY }
    : null;
}
