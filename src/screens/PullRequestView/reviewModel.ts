/**
 * Pure rules of "Open review comments" (8.2): which threads are shown and in which order, how their
 * lines read, whether "Suggest fix" is offered, the reply draft and why a fixup target was chosen.
 * Without React, so it can be tested (reviewModel.test.ts).
 */
import type { AiReviewFix, ReviewThread, Sha } from "../../core";
import { shortSha } from "../../app/format";
import { t } from "../../i18n";

export const REVIEW_FEATURE = "review_fix" as const;

/** Open threads by file, then line (lines that are gone last); resolved threads only counted. */
export function splitThreads(threads: ReviewThread[]): { open: ReviewThread[]; resolved: number } {
  const open = threads.filter((thread) => !thread.resolved);
  const last = Number.MAX_SAFE_INTEGER;
  open.sort((a, b) => a.path.localeCompare(b.path, "en") || (a.line ?? last) - (b.line ?? last));
  return { open, resolved: threads.length - open.length };
}

/** "lines 40–42", "line 42" – or nothing when the lines are no longer in the pull request. */
export function threadLines(thread: Pick<ReviewThread, "line" | "startLine">): string {
  if (thread.line === null) return "";
  if (thread.startLine !== null && thread.startLine < thread.line) return t("pullRequest.view.reviewThreads.lines", { from: thread.startLine, to: thread.line });
  return t("pullRequest.view.reviewThreads.line", { line: thread.line });
}

export type FixAvailability = "hidden" | "unavailable" | "setup" | "ready";

/** "Suggest fix": hidden without AI for this function/repository; only for current lines on the new side. */
export function fixAvailability(thread: Pick<ReviewThread, "line" | "side" | "outdated">, ai: { visible: boolean; opensSetup: boolean }): FixAvailability {
  if (!ai.visible) return "hidden";
  if (thread.outdated || thread.side === "old" || thread.line === null) return "unavailable";
  return ai.opensSetup ? "setup" : "ready";
}

/** The editable reply: the reason, and once the fix is committed "Fixed in <sha>: <reason>". */
export function replyDraft(why: string, commit: Sha | null): string {
  const reason = why.trim();
  return commit ? t("pullRequest.view.reviewThreads.replyDraft", { sha: shortSha(commit), why: reason }) : reason;
}

/** Why the core chose the target – only while the chosen commit is still the core's choice. */
export function targetHint(fix: Pick<AiReviewFix, "target">, chosen: string): string {
  if (!fix.target || fix.target.sha !== chosen) return "";
  if (fix.target.reason === "blame") return t("pullRequest.view.reviewThreads.targetBlame");
  if (fix.target.reason === "file") return t("pullRequest.view.reviewThreads.targetFile");
  return "";
}
