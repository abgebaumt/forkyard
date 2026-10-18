/**
 * The column “Intent” of the conflict tool (v1.2, Teilpaket 6.1), without React: which blocks go to
 * the core (line ranges only – the core reads the text from the index itself), the small diff of a
 * proposal against the block's current text, which blocks may be applied, the request state (an
 * answer that arrives after “Cancel” or for an older request is dropped) and the remembered width.
 */
import type { ConflictBlockRange, ConflictIntent, ConflictIntentBlock } from "../../core";
import type { AiErrorView } from "../../app/ai/requestState";
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
export const canApply = (block: ConflictIntentBlock): block is ConflictIntentBlock & { text: string } => block.sent === "full" && block.text !== null;

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

export type IntentState =
  | { kind: "idle" }
  | { kind: "preparing"; startedAt: number }
  | { kind: "loading"; startedAt: number; jobId: string }
  | { kind: "ready"; intent: ConflictIntent; decisions: Partial<Record<number, IntentDecision>> }
  | { kind: "error"; view: AiErrorView };

export type IntentEvent =
  | { type: "start"; at: number }
  | { type: "sending"; jobId: string }
  | { type: "answer"; jobId: string; intent: ConflictIntent }
  | { type: "failed"; jobId: string | null; view: AiErrorView }
  | { type: "cancel" }
  | { type: "decide"; block: number; decision: IntentDecision };

/** `preparing` = building “What is sent?” and asking where the core wants it; `loading` = the job runs. */
export function intentReducer(state: IntentState, event: IntentEvent): IntentState {
  switch (event.type) {
    case "start":
      return { kind: "preparing", startedAt: event.at };
    case "sending":
      return state.kind === "preparing" ? { kind: "loading", startedAt: state.startedAt, jobId: event.jobId } : state;
    case "answer":
      return state.kind === "loading" && state.jobId === event.jobId ? { kind: "ready", intent: event.intent, decisions: {} } : state;
    case "failed": {
      const mine = event.jobId === null ? state.kind === "preparing" : state.kind === "loading" && state.jobId === event.jobId;
      if (!mine) return state;
      return event.view.kind === "cancelled" ? { kind: "idle" } : { kind: "error", view: event.view };
    }
    case "cancel":
      return state.kind === "preparing" || state.kind === "loading" ? { kind: "idle" } : state;
    case "decide":
      return state.kind === "ready" ? { ...state, decisions: { ...state.decisions, [event.block]: event.decision } } : state;
  }
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
