/**
 * Pure rules of the PR review in the diff (8.3): where threads and drafts sit between the code rows,
 * whether commenting is possible, which votes the submit dialog offers.
 * Without React, so it can be tested (reviewPlacement.test.ts).
 */
import type {
  HostCapabilities,
  HostRepoInfo,
  NewReviewComment,
  PrDetails,
  PrSummary,
  ReviewDraft,
  ReviewSide,
  ReviewThread,
  ReviewVote,
} from "../../core";
import type { PrRange } from "../../app/hosts";
import { t } from "../../i18n";
import type { LineRow, ReviewRow, Row } from "../DiffView/model";

export type Anchor = { side: ReviewSide; line: number };
export const anchorKey = (a: Anchor) => `${a.side}:${a.line}`;

/** The anchor of a code row: removed → old side with oldNo; added/context → new side with newNo. */
export function rowAnchor(row: LineRow): Anchor | null {
  const line = row.kind === "remove" ? row.oldNo : row.newNo;
  return line === null ? null : { side: row.kind === "remove" ? "old" : "new", line };
}

export interface Placement {
  rows: Row[];
  at: Map<string, { threads: ReviewThread[]; drafts: ReviewDraft[] }>;
  stale: ReviewThread[];
  staleDrafts: ReviewDraft[];
}

/**
 * Inserts one ReviewRow after every code row that has threads/drafts (thread anchor = its last line `line`, side `side`); the rest goes to stale.
 * `open` (an anchor key) is where the comment box is open: that row gets a review row even without threads.
 * A context row with threads on both sides gets one review row; the box's anchor, else the first one found, names it.
 */
export function placeThreads(rows: Row[], path: string, threads: ReviewThread[], drafts: ReviewDraft[], open?: string): Placement {
  const index = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.type !== "line") return;
    const anchor = rowAnchor(row);
    if (anchor) index.set(anchorKey(anchor), i);
    // A context row exists on both sides: a thread on its old line sits there too.
    if (row.kind === "context" && row.oldNo !== null) index.set(anchorKey({ side: "old", line: row.oldNo }), i);
  });
  const at: Placement["at"] = new Map();
  const slot = (key: string) => {
    let entry = at.get(key);
    if (!entry) at.set(key, (entry = { threads: [], drafts: [] }));
    return entry;
  };
  const keyOf = (item: { line: number | null; side: ReviewSide }) =>
    item.line === null ? null : anchorKey({ side: item.side, line: item.line });

  if (open !== undefined && index.has(open)) slot(open);
  const stale: ReviewThread[] = [];
  for (const thread of threads) {
    if (thread.path !== path) continue;
    const key = keyOf(thread);
    if (key !== null && !thread.outdated && index.has(key)) slot(key).threads.push(thread);
    else stale.push(thread);
  }
  const staleDrafts: ReviewDraft[] = [];
  for (const draft of drafts) {
    if (draft.path !== path) continue;
    const key = keyOf(draft);
    if (key !== null && index.has(key)) slot(key).drafts.push(draft);
    else staleDrafts.push(draft);
  }

  const byRow = new Map<number, string>();
  for (const [key, entry] of at) {
    const i = index.get(key)!;
    const first = byRow.get(i);
    if (first === undefined) {
      byRow.set(i, key);
      continue;
    }
    const kept = at.get(first)!;
    kept.threads.push(...entry.threads);
    kept.drafts.push(...entry.drafts);
    at.delete(key);
  }

  const out = [...rows];
  const inserts = [...at.keys()].map((key) => [index.get(key)!, key] as const).sort((a, b) => b[0] - a[0]);
  for (const [i, anchor] of inserts) {
    const row: ReviewRow = { type: "review", anchor };
    // A "No newline at end of file" note belongs to its line: the review row goes below it.
    out.splice(out[i + 1]?.type === "note" ? i + 2 : i + 1, 0, row);
  }
  return { rows: out, at, stale, staleDrafts };
}

/**
 * The lines a new comment covers: from `anchorIndex` to `cursorIndex` when ranges are allowed and both are code rows on
 * the same side of the same hunk; otherwise the single line at the cursor. null when the cursor is not on a code row
 * of a hunk.
 */
export function commentRange(
  rows: Row[],
  anchorIndex: number,
  cursorIndex: number,
  rangeAllowed: boolean,
): { first: LineRow; last: LineRow } | null {
  const cursor = rows[cursorIndex];
  // Lines outside every hunk ("Whole file") are not part of the pull request's diff: hosts refuse comments there.
  if (cursor?.type !== "line" || cursor.hunkOrd === null || !rowAnchor(cursor)) return null;
  const from = rows[anchorIndex];
  const ok =
    rangeAllowed &&
    from?.type === "line" &&
    from.hunkOrd !== null &&
    from.hunkOrd === cursor.hunkOrd &&
    rowAnchor(from)?.side === rowAnchor(cursor)!.side;
  if (!ok) return { first: cursor, last: cursor };
  return anchorIndex <= cursorIndex ? { first: from, last: cursor } : { first: cursor, last: from };
}

/** The comment on the lines `first..last` (from commentRange) against the head commit `commit`, without its text. */
export function commentFor(path: string, first: LineRow, last: LineRow, commit: string): Omit<NewReviewComment, "body"> {
  const end = rowAnchor(last)!;
  const start = rowAnchor(first)!.line;
  return {
    commit,
    path,
    line: end.line,
    startLine: start < end.line ? start : null,
    side: end.side,
    // GitLab needs both numbers of an unchanged line.
    oldLine: last.kind === "context" ? last.oldNo : null,
  };
}

/** Commenting needs the local diff at the PR head and the host capability. */
export function canComment(range: PrRange | undefined, pr: Pick<PrDetails, "headSha">, caps: HostCapabilities): boolean {
  return caps.reviewComment && range?.state === "local" && range.to === pr.headSha;
}

/** Votes offered in the submit dialog. */
export function reviewChoices(caps: HostCapabilities, own: boolean): ReviewVote[] {
  const votes = !own || caps.reviewVoteOwnPr;
  return [
    "comment",
    ...(votes && caps.reviewApprove ? (["approve"] as const) : []),
    ...(votes && caps.reviewRequestChanges ? (["request_changes"] as const) : []),
  ];
}

/** Whether the signed-in account wrote the PR (case-insensitive login). */
export function isOwnPr(info: HostRepoInfo | null | undefined, pr: Pick<PrSummary, "author">): boolean {
  const me = info?.account?.user?.login;
  const author = pr.author?.login;
  return Boolean(me && author && me.toLowerCase() === author.toLowerCase());
}

/** "Submit review (3)" counts local + host drafts. */
export function submitLabel(drafts: ReviewDraft[]): string {
  return t("pullRequest.view.review.submitCount", { count: drafts.length });
}
