/**
 * Line archaeology in the UI (v1.2, 7.1): which line a blame or diff row means, the rows of the
 * timeline panel and the AI notes next to their steps. Pure – no core calls.
 */
import { EMPTY_TREE_SHA, type ArchaeologyAnswer, type ArchaeologyConfidence, type ArchaeologyRef, type DiffLine, type AiProviderKind, type DiffSource, type LineArchaeology, type Sha } from "../../core";
import { shortSha } from "../../app/format";
import { loadingView, type AiErrorView } from "../../app/ai/requestState";
import type { ArchaeologyTarget } from "../../app/store";
import type { MenuEntry } from "../../ui/Menu";
import { locale, t } from "../../i18n";
import { isCli } from "../Preferences/ai/model";

export type TargetOrReason = { target: ArchaeologyTarget } | { reason: string };

export interface DiffRowLine {
  kind: DiffLine["kind"];
  oldNo: number | null;
  newNo: number | null;
}

/** The line under the cursor of a blame view; an uncommitted line has no history. */
export function blameTarget(path: string, sha: Sha | null, line: number, uncommitted: boolean): TargetOrReason {
  if (uncommitted) return { reason: t("blame.archaeology.notCommitted") };
  return { target: { path, line, sha } };
}

/**
 * The commit that has the line of a diff row: added and context lines on the new side, removed lines
 * on the old side; a line of the working directory is traced by the core (`sha: null`).
 */
export function diffLineTarget(source: DiffSource, file: { path: string; oldPath: string | null }, row: DiffRowLine): TargetOrReason {
  const notCommitted: TargetOrReason = { reason: t("diff.whyLine.notCommitted") };
  const at = (path: string, line: number | null, sha: Sha | null): TargetOrReason => (line ? { target: { path, line, sha } } : { reason: t("diff.whyLine.noLine") });
  const oldPath = file.oldPath ?? file.path;
  switch (source.kind) {
    case "commit":
      return row.kind === "remove" ? at(oldPath, row.oldNo, `${source.sha}^`) : at(file.path, row.newNo, source.sha);
    case "range":
      if (row.kind === "remove") return source.from === EMPTY_TREE_SHA ? notCommitted : at(oldPath, row.oldNo, source.from);
      if (source.to === null) return row.kind === "add" ? notCommitted : at(file.path, row.newNo, null);
      return at(file.path, row.newNo, source.to);
    case "staged":
      return row.kind === "add" ? notCommitted : at(oldPath, row.oldNo, "HEAD");
    case "unstaged":
      if (row.kind === "add") return notCommitted;
      if (row.kind === "remove") return { reason: t("diff.whyLine.indexOnly") };
      return at(file.path, row.newNo, null);
    case "stash":
      return { reason: t("diff.whyLine.stash") };
  }
}

/** “Why is this so?” while the AI function is visible, otherwise “History of this line” (Entscheidung 11). */
export function whyLabel(aiVisible: boolean): string {
  return aiVisible ? t("blame.menu.why") : t("blame.menu.lineHistory");
}

export function whyEntry(why: TargetOrReason, aiVisible: boolean, open: (target: ArchaeologyTarget) => void, shortcut?: string): MenuEntry {
  if ("target" in why) return { label: whyLabel(aiVisible), shortcut, onSelect: () => open(why.target) };
  return { label: whyLabel(aiVisible), shortcut, disabled: true, hint: why.reason };
}

export type TimelineLineKind = "add" | "remove" | "context" | "note";

export interface TimelineRow {
  sha: Sha;
  short: string;
  summary: string;
  author: string;
  authoredAt: string;
  path: string;
  /** The file had this name before the change (the next older step's path). */
  renamedFrom: string | null;
  /** “Line 3” / “Lines 3–5”. */
  lines: string;
  diff: { kind: TimelineLineKind; text: string }[];
  refs: ArchaeologyRef[];
  /** The AI's sentence about this step, if any. */
  note: string | null;
  /** The oldest step and no older history: the line starts here. */
  introduced: boolean;
}

const lineKind = (line: string): TimelineLineKind => (line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith(" ") ? "context" : "note");

export function timelineRows(data: LineArchaeology, answer: ArchaeologyAnswer | null = null): TimelineRow[] {
  const notes = new Map((answer?.notes ?? []).map((note) => [note.sha, note.note]));
  const number = (value: number) => value.toLocaleString(locale());
  return data.steps.map((step, index) => {
    const older = data.steps[index + 1];
    return {
      sha: step.commit.sha,
      short: shortSha(step.commit.sha),
      summary: step.commit.summary || t("blame.noMessage"),
      author: step.commit.author.name,
      authoredAt: step.commit.authoredAt,
      path: step.path,
      renamedFrom: older && older.path !== step.path ? older.path : null,
      lines: step.startLine === step.endLine ? t("blame.line", { line: number(step.startLine) }) : t("blame.lineRange", { from: number(step.startLine), to: number(step.endLine) }),
      diff: step.diff.map((line) => {
        const kind = lineKind(line);
        return { kind, text: kind === "note" ? line : line.slice(1) };
      }),
      refs: step.refs,
      note: notes.get(step.commit.sha) ?? null,
      introduced: index === data.steps.length - 1 && !data.mayHaveMore,
    };
  });
}

/** A full SHA-1/SHA-256 (optionally `^`) names a commit that never moves; `HEAD`, branch names and `null` (working directory) do. */
export function isFixedRev(rev: unknown): boolean {
  return typeof rev === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\^?$/.test(rev);
}

export function confidenceLabel(confidence: ArchaeologyConfidence): string {
  switch (confidence) {
    case "high":
      return t("blame.archaeology.confidence.high");
    case "medium":
      return t("blame.archaeology.confidence.medium");
    case "low":
      return t("blame.archaeology.confidence.low");
  }
}

/** State of “Explain” in the panel. A cancelled request returns to `idle` – there are no half results. */
export type ExplainState =
  | { kind: "idle" }
  | { kind: "loading"; jobId: string; startedAt: number }
  | { kind: "done"; answer: ArchaeologyAnswer }
  | { kind: "error"; error: Exclude<AiErrorView, { kind: "cancelled" }> };

export interface ExplainView {
  /** What the main button does. */
  button: "explain" | "cancel" | "again";
  label: string;
  /** Text of the live region; null = nothing to announce. */
  status: string | null;
  /** “Local models take longer” / “The provider is answering slowly” after 30 s. */
  slow: string | null;
  /** Errors are announced assertively, everything else politely. */
  urgent: boolean;
}

export function explainView(state: ExplainState, now: number, local: boolean): ExplainView {
  switch (state.kind) {
    case "idle":
      return { button: "explain", label: t("blame.archaeology.explain"), status: null, slow: null, urgent: false };
    case "loading": {
      const shown = loadingView(now - state.startedAt, local, t("blame.archaeology.explaining"));
      return { button: "cancel", label: t("blame.archaeology.cancel"), status: shown.text, slow: shown.slow, urgent: false };
    }
    case "done":
      return { button: "again", label: t("blame.archaeology.again"), status: t("blame.archaeology.done"), slow: null, urgent: false };
    case "error":
      return { button: "again", label: t("blame.archaeology.again"), status: state.error.text, slow: null, urgent: true };
  }
}

/** Extra buttons under an error of “Explain” (the main button already reads “Explain again”). */
export type ExplainErrorAction = "signIn" | "sendOnce" | "setup" | "showSent";

/**
 * Spec “Zustände jedes KI-Elements”: a signed-out command-line tool offers “Sign in in the terminal”,
 * the limit offers “Send this time” (a new request whose preview asks with the limit trigger), both
 * next to “Set up AI …” (Settings › AI holds the sign-in of API providers and the limit).
 */
export function errorActions(error: Exclude<AiErrorView, { kind: "cancelled" }>, provider: AiProviderKind | null): ExplainErrorAction[] {
  switch (error.kind) {
    case "setup":
      return ["setup"];
    case "notLoggedIn":
      return provider && isCli(provider) ? ["signIn", "setup"] : ["setup"];
    case "limit":
      return ["sendOnce", "setup"];
    case "invalid":
      return ["showSent"];
    default:
      return [];
  }
}
