/**
 * Pure rules of the PR review in the diff (8.3): where threads and drafts sit between the code rows,
 * whether commenting is possible, which votes the submit dialog offers.
 * Without React, so it can be tested (reviewPlacement.test.ts).
 */
import type { HostCapabilities, HostRepoInfo, PrDetails, PrSummary, ReviewDraft, ReviewSide, ReviewThread, ReviewVote } from "../../core";
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

/** Inserts one ReviewRow after every code row that has threads/drafts (thread anchor = its last line `line`, side `side`); the rest goes to stale. */
export function placeThreads(rows: Row[], path: string, threads: ReviewThread[], drafts: ReviewDraft[]): Placement {
  const index = new Map<string, number>();
  rows.forEach((row, i) => {
    const anchor = row.type === "line" ? rowAnchor(row) : null;
    if (anchor) index.set(anchorKey(anchor), i);
  });
  const at: Placement["at"] = new Map();
  const slot = (key: string) => {
    let entry = at.get(key);
    if (!entry) at.set(key, (entry = { threads: [], drafts: [] }));
    return entry;
  };
  const keyOf = (item: { line: number | null; side: ReviewSide }) =>
    item.line === null ? null : anchorKey({ side: item.side, line: item.line });

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

  const out = [...rows];
  const inserts = [...at.keys()].map((key) => [index.get(key)!, key] as const).sort((a, b) => b[0] - a[0]);
  for (const [i, anchor] of inserts) {
    const row: ReviewRow = { type: "review", anchor };
    // A "No newline at end of file" note belongs to its line: the review row goes below it.
    out.splice(out[i + 1]?.type === "note" ? i + 2 : i + 1, 0, row);
  }
  return { rows: out, at, stale, staleDrafts };
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
