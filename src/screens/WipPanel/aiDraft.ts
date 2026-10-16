/**
 * Rules of "Write" for the commit message (spec 3.1, "Umgang mit Vorschlägen"), without React and
 * without the core: where the suggestion goes (empty fields – or the untouched template – get it as
 * a draft; the user's text is never replaced unasked; if the user typed while the request ran, the
 * answer is only offered), what Mod+Z undoes, and what the button says.
 */
import type { AiCommitMessage } from "../../core";
import type { AiErrorView } from "../../app/ai/requestState";
import { applySuggestion, placeSuggestion } from "../../app/ai/suggestion";
import { t } from "../../i18n";
import { joinMessage, splitMessage, type MessageParts } from "./draft";

export type AiDraftPhase =
  | { kind: "idle" }
  | { kind: "running"; jobId: string; startedAt: number; atStart: MessageParts }
  | { kind: "done"; inserted: boolean }
  | { kind: "offer"; reason: "choose" | "ready"; suggestion: MessageParts }
  | { kind: "error"; view: AiErrorView };

/** The one step Mod+Z takes back: the fields before an insertion and what was inserted. */
export interface InsertUndo {
  before: MessageParts;
  inserted: MessageParts;
}

export interface AiDraftState {
  phase: AiDraftPhase;
  undo: InsertUndo | null;
}

export const sameParts = (a: MessageParts, b: MessageParts) => a.summary === b.summary && a.description === b.description;

export function suggestionParts(answer: AiCommitMessage): MessageParts {
  return { summary: answer.summary, description: answer.body ?? "" };
}

export function placeCommitSuggestion(current: MessageParts, atStart: MessageParts, template: MessageParts | null, suggestion: MessageParts): { kind: "insert" } | { kind: "choose" } | { kind: "ready" } {
  // The untouched template is not the user's text.
  const asField = (fields: MessageParts) => (template && sameParts(fields, template) ? "" : joinMessage(fields));
  const placement = placeSuggestion(asField(current), asField(atStart), joinMessage(suggestion));
  return placement.kind === "insert" ? { kind: "insert" } : placement;
}

export function resolveOffer(current: MessageParts, suggestion: MessageParts, how: "replace" | "append"): MessageParts {
  if (how === "replace") return { ...suggestion };
  return splitMessage(applySuggestion(joinMessage(current), joinMessage(suggestion), how));
}

export function undoTarget(undo: InsertUndo | null, current: MessageParts): MessageParts | null {
  return undo && sameParts(undo.inserted, current) ? undo.before : null;
}

export function writeLabel(phase: AiDraftPhase["kind"]): "write" | "cancel" | "again" {
  if (phase === "running") return "cancel";
  return phase === "done" || phase === "offer" ? "again" : "write";
}

/** Why "Write" cannot run, or null. */
export function writeBlocked(staged: number): string | null {
  return staged > 0 ? null : t("wip.ai.nothingStaged");
}
