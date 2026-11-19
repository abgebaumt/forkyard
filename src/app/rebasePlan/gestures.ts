/**
 * Edit gestures on a rebase plan (graph edit mode): move, fold onto a row, drop, set an action,
 * reword. Pure functions; each returns a new state, or the same object when nothing changes.
 *
 * Plan order (`rows`) is oldest first like Git's todo; the list shows newest first (display order).
 */
import type { RebaseAction, RebasePlanRow, Sha } from "../../core";
import { joinMessage, moveItem, rowRoles, splitMessage } from "./model";

export interface EditState {
  rows: RebasePlanRow[];
  /** SHAs the user moved. */
  moved: Sha[];
}

export const editStart = (rows: RebasePlanRow[]): EditState => ({ rows, moved: [] });

/** Display index ↔ plan index (also the reverse). */
export const flipIndex = (count: number, index: number) => count - 1 - index;

const withRows = (state: EditState, rows: RebasePlanRow[]): EditState => ({ ...state, rows });

function patchRow(state: EditState, sha: Sha, patch: (row: RebasePlanRow) => Partial<RebasePlanRow> | null): EditState {
  const index = state.rows.findIndex((row) => row.sha === sha);
  const change = index < 0 ? null : patch(state.rows[index]!);
  if (!change) return state;
  const rows = [...state.rows];
  rows[index] = { ...rows[index]!, ...change };
  return withRows(state, rows);
}

/** `to` = display insertion point (0 … count). */
export function moveDisplayed(state: EditState, from: number, to: number): EditState {
  const displayed = [...state.rows].reverse();
  const next = moveItem(displayed, from, to);
  if (next === displayed) return state;
  const sha = displayed[from]!.sha;
  return { rows: next.reverse(), moved: state.moved.includes(sha) ? state.moved : [...state.moved, sha] };
}

/**
 * Folds `sha` into the group of `onto` (placed after the group's last member); no-op onto itself or a dropped row.
 * A row already in that group only changes between squash and fixup in place. A group root carries its
 * squashed rows along: the whole group folds into the target, the members keep their action.
 * The folded row loses its own message (a reword's new text is dropped, `message: null`).
 */
export function squashOnto(state: EditState, sha: Sha, onto: Sha, fixup: boolean): EditState {
  const { rows } = state;
  const ontoIndex = rows.findIndex((row) => row.sha === onto);
  const fromIndex = rows.findIndex((row) => row.sha === sha);
  if (sha === onto || ontoIndex < 0 || fromIndex < 0 || rows[ontoIndex]!.action === "drop") return state;
  const roles = rowRoles(rows);
  const isRoot = (index: number) => rows[index]!.action === "pick" || rows[index]!.action === "reword";
  const root = isRoot(ontoIndex) ? ontoIndex : roles[ontoIndex]!.target;
  const action = fixup ? "fixup" : "squash";
  // A group root cannot fold into its own group.
  if (root === fromIndex) return state;
  if (root !== null && roles[fromIndex]!.target === root) return patchRow(state, sha, (row) => (row.action === action ? null : { action }));
  const members = isRoot(fromIndex) ? roles[fromIndex]!.squashed.map((index) => rows[index]!) : [];
  const moving = new Set([sha, ...members.map((row) => row.sha)]);
  const lastSha = rows[root === null ? ontoIndex : (roles[root]!.squashed.at(-1) ?? root)]!.sha;
  const next = rows.filter((row) => !moving.has(row.sha));
  next.splice(next.findIndex((row) => row.sha === lastSha) + 1, 0, { ...rows[fromIndex]!, action, message: null }, ...members);
  return withRows(state, next);
}

/** Del: drop ↔ pick. */
export function toggleDrop(state: EditState, sha: Sha): EditState {
  return patchRow(state, sha, (row) => ({ action: row.action === "drop" ? "pick" : "drop", message: null }));
}

/** P/S/F/D (R starts the inline edit in the view). */
export function setRowAction(state: EditState, sha: Sha, action: Exclude<RebaseAction, "reword">): EditState {
  // A pick row keeps its group's result message; every other change drops the message.
  return patchRow(state, sha, (row) =>
    row.action === action ? null : { action, message: action === "pick" && row.action === "pick" ? row.message : null },
  );
}

/** New summary, description kept (from the row's own message if it has one); equal to the original → pick without message. */
export function rewordSummary(state: EditState, sha: Sha, summary: string): EditState {
  return patchRow(state, sha, (row) => {
    // Like the tool's reword dialog: an own message (reword, or a group's result message) is the base.
    const description = row.message ? splitMessage(row.message).description : row.description;
    const message = joinMessage({ summary, description });
    return message === joinMessage({ summary: row.summary, description: row.description })
      ? { action: "pick", message: null }
      : { action: "reword", message };
  });
}

export function setMessage(state: EditState, sha: Sha, message: string): EditState {
  return patchRow(state, sha, (row) => (row.message === message ? null : { message }));
}

export type RowChip = "squash" | "fixup" | "reword" | "drop" | "moved";

const isMoved = (state: EditState, original: RebasePlanRow[], sha: Sha) =>
  state.moved.includes(sha) && state.rows.findIndex((row) => row.sha === sha) !== original.findIndex((row) => row.sha === sha);

export function rowChip(state: EditState, original: RebasePlanRow[], sha: Sha): RowChip | null {
  const row = state.rows.find((item) => item.sha === sha);
  if (row && row.action !== "pick") return row.action;
  return isMoved(state, original, sha) ? "moved" : null;
}

/** Changed actions plus moved rows; a dropped row the user also moved counts twice. */
export function changeCount(state: EditState, original: RebasePlanRow[]): number {
  return state.rows.reduce((sum, row) => sum + (row.action !== "pick" ? 1 : 0) + (isMoved(state, original, row.sha) ? 1 : 0), 0);
}

/** Git's todo lines, oldest first: "<action> <sha>". */
export function todoLines(rows: RebasePlanRow[]): string[] {
  return rows.map((row) => `${row.action} ${row.sha}`);
}
