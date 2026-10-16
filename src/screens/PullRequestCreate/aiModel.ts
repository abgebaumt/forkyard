/**
 * Pure rules of "Write from commits" in the pull request form (Paket 4): when the title is
 * replaced, where the suggested description goes, the field's one-step undo of an insertion and
 * why the button is disabled.
 */
import { placeSuggestion, type Placement } from "../../app/ai/suggestion";
import { t } from "../../i18n";

export type TitleDecision = "replace" | "ask" | "same";

/** Replaced only while the title is empty or still the automatic suggestion (`suggestTitle`); otherwise "Replace title?". */
export function titleDecision(current: string, automatic: string, proposed: string): TitleDecision {
  if (current.trim() === proposed.trim()) return "same";
  if (current.trim() === "" || current === automatic) return "replace";
  return "ask";
}

/** Like `placeSuggestion`, but the untouched repository template counts as empty: the answer is the filled template. */
export function placeDescription(current: string, atStart: string, untouchedTemplate: boolean, suggestion: string): Placement {
  if (current !== atStart) return { kind: "ready" };
  if (untouchedTemplate) return { kind: "insert", text: suggestion };
  return placeSuggestion(current, atStart, suggestion);
}

/** What an insertion replaced – Mod+Z brings it back while the field still shows the inserted text. */
export interface InsertUndo {
  before: string;
  after: string;
}

export function undoInsertion(current: string, undo: InsertUndo | null): string | null {
  return undo && current === undo.after ? undo.before : null;
}

export function isUndoKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
}

/** null = the button may be used; an unknown commit count (`ahead: null`) is left to the core. */
export function writeBlockedReason(input: { source: string | null; target: string | null; ahead: number | null; sameBranch: boolean }): string | null {
  if (!input.source) return t("pullRequest.create.ai.blocked.noSource");
  if (!input.target) return t("pullRequest.create.ai.blocked.noTarget");
  if (input.sameBranch) return t("pullRequest.create.ai.blocked.same");
  if (input.ahead === 0) return t("pullRequest.create.ai.blocked.nothing");
  return null;
}
