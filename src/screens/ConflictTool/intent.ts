/**
 * The column “Intent” of the conflict tool, without React: which blocks go to
 * the core (line ranges only – the core reads the text from the index itself), the small diff of a
 * proposal against the block's current text, which blocks may be applied and the remembered width.
 */
import type { ConflictBlockRange, ConflictIntent, ConflictIntentBlock } from "../../core";
import { diffLines, splitText, type MergeModel } from "./model";

/** The conflict blocks of the model, in order, as line ranges of both sides. */
export function conflictRanges(model: MergeModel): ConflictBlockRange[] {
  return model.conflicts.map((id) => {
    const chunk = model.chunks[id]!;
    return { oursStart: chunk.oursStart, oursCount: chunk.ours.length, theirsStart: chunk.theirsStart, theirsCount: chunk.theirs.length };
  });
}

export interface DiffRow {
  kind: "same" | "add" | "del";
  text: string;
}

/** Line diff of the proposal against the current text of the block (CRLF counts as LF). */
export function suggestionDiff(current: string, proposal: string): DiffRow[] {
  const a = splitText(current).lines;
  const b = splitText(proposal).lines;
  const rows: DiffRow[] = [];
  let aPos = 0;
  for (const edit of diffLines(a, b)) {
    for (; aPos < edit.aStart; aPos++) rows.push({ kind: "same", text: a[aPos]! });
    for (let index = 0; index < edit.aLength; index++) rows.push({ kind: "del", text: a[edit.aStart + index]! });
    for (let index = 0; index < edit.bLength; index++) rows.push({ kind: "add", text: b[edit.bStart + index]! });
    aPos = edit.aStart + edit.aLength;
  }
  for (; aPos < a.length; aPos++) rows.push({ kind: "same", text: a[aPos]! });
  return rows;
}

export const hasChange = (rows: DiffRow[]): boolean => rows.some((row) => row.kind !== "same");

/** Only a block that went out completely carries a proposal. */
export const canApply = (block: ConflictIntentBlock): block is ConflictIntentBlock & { text: string } =>
  block.sent === "full" && block.text !== null;

export function blockNote(block: ConflictIntentBlock): "shortened" | "redacted" | "leftOut" | null {
  switch (block.sent) {
    case "shortened":
      return "shortened";
    case "redacted":
      return "redacted";
    case "left_out":
      return "leftOut";
    default:
      return null;
  }
}

export type IntentDecision = "taken" | "discarded";

/** The answer with what the user did per block (Apply / Discard). */
export interface IntentResult {
  intent: ConflictIntent;
  decisions: Partial<Record<number, IntentDecision>>;
}

const OPEN_KEY = "gc.conflictIntentOpen";
const WIDTH_KEY = "gc.conflictIntentWidth";
/** Width of the column as a fraction of the conflict tool. */
export const DEFAULT_INTENT_WIDTH = 0.3;
export const INTENT_WIDTH_MIN = 0.2;
export const INTENT_WIDTH_MAX = 0.5;

export const clampIntentWidth = (value: number): number => Math.min(INTENT_WIDTH_MAX, Math.max(INTENT_WIDTH_MIN, value));

export function storedIntentWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? clampIntentWidth(value) : DEFAULT_INTENT_WIDTH;
  } catch {
    return DEFAULT_INTENT_WIDTH;
  }
}

export function rememberIntentWidth(value: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(value));
  } catch {
    // Without storage the width only lasts until closing.
  }
}

export function storedIntentOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "closed";
  } catch {
    return true;
  }
}

export function rememberIntentOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "open" : "closed");
  } catch {
    // Without storage the column opens again next time.
  }
}
