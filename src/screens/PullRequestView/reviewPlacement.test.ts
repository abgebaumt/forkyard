import { describe, expect, test } from "vitest";
import type { HostCapabilities, HostRepoInfo, ReviewDraft, ReviewThread, TextDiff } from "../../core";
import { defaultCapabilities } from "../../app/hosts";
import { buildHunkRows, type LineRow, type Row } from "../DiffView/model";
import {
  anchorKey,
  canComment,
  commentFor,
  commentRange,
  isOwnPr,
  placeThreads,
  reviewChoices,
  rowAnchor,
  submitLabel,
} from "./reviewPlacement";

const PATH = "src/größe.rs";
const diff: TextDiff = {
  path: PATH,
  oldPath: null,
  status: "modified",
  hunks: [
    {
      index: 0,
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      section: "",
      lines: [
        { kind: "context", oldNo: 10, newNo: 10, text: "fn größe() {", noNewline: false },
        { kind: "remove", oldNo: 11, newNo: null, text: "    alt", noNewline: false },
        { kind: "add", oldNo: null, newNo: 11, text: "    neu", noNewline: false },
        { kind: "add", oldNo: null, newNo: 12, text: "    dazu", noNewline: false },
        { kind: "context", oldNo: 12, newNo: 13, text: "}", noNewline: false },
      ],
    },
  ],
  oldText: null,
  newText: null,
  encoding: "utf-8",
  token: null,
};
const rows = buildHunkRows(diff, 4).rows;

const thread = (partial: Partial<ReviewThread>): ReviewThread => ({
  id: "t",
  path: PATH,
  line: 12,
  startLine: null,
  side: "new",
  commit: null,
  resolved: false,
  resolveId: null,
  outdated: false,
  comments: [],
  ...partial,
});
const draft = (partial: Partial<ReviewDraft>): ReviewDraft => ({
  id: "d",
  origin: "local",
  path: PATH,
  line: 12,
  startLine: null,
  side: "new",
  oldLine: null,
  commit: "h".repeat(40),
  body: "Bitte prüfen",
  error: null,
  ...partial,
});
const noCaps: HostCapabilities = {
  ...defaultCapabilities.github,
  reviewComment: false,
  reviewCommentRange: false,
  reviewResolve: false,
  reviewSubmitBatch: false,
  reviewApprove: false,
  reviewRequestChanges: false,
  reviewVoteOwnPr: false,
};

/** Types of the rows between the code row with this anchor and the next code row. */
function rowsAfter(list: Row[], key: string): string[] {
  const start = list.findIndex((row) => row.type === "line" && rowAnchor(row) && anchorKey(rowAnchor(row)!) === key);
  const after: string[] = [];
  for (const row of list.slice(start + 1)) {
    if (row.type === "line") break;
    after.push(row.type);
  }
  return after;
}

describe("placeThreads", () => {
  test("threads sit under their side's row, ranges under their last line", () => {
    const p = placeThreads(
      rows,
      PATH,
      [
        thread({ id: "1", side: "new", line: 12 }),
        thread({ id: "2", side: "old", line: 11 }),
        thread({ id: "3", side: "new", line: 13, startLine: 11 }),
      ],
      [],
    );
    expect(rowsAfter(p.rows, "new:12")).toEqual(["review"]);
    expect(rowsAfter(p.rows, "old:11")).toEqual(["review"]);
    expect(rowsAfter(p.rows, "new:11")).toEqual([]);
    expect(p.at.get("old:11")!.threads.map((t) => t.id)).toEqual(["2"]);
    expect(p.at.get("new:13")!.threads.map((t) => t.id)).toEqual(["3"]);
    expect(p.rows.filter((row) => row.type === "review")).toHaveLength(3);
    expect(p.stale).toEqual([]);
  });

  test("gone, outdated and foreign-file threads are stale; drafts follow the same rules", () => {
    const p = placeThreads(
      rows,
      PATH,
      [
        thread({ id: "gone", line: null }),
        thread({ id: "old", line: 12, outdated: true }),
        thread({ id: "far", line: 400 }),
        thread({ id: "other", path: "b.rs", line: 12 }),
      ],
      [draft({ id: "7", line: 11, side: "old" }), draft({ id: "8", line: 999 }), draft({ id: "9", path: "b.rs" })],
    );
    expect(p.stale.map((t) => t.id)).toEqual(["gone", "old", "far"]);
    expect(p.at.get("old:11")!.drafts.map((d) => d.id)).toEqual(["7"]);
    expect(p.staleDrafts.map((d) => d.id)).toEqual(["8"]);
  });

  test("a code row with threads and drafts gets one review row", () => {
    const p = placeThreads(rows, PATH, [thread({ id: "1" })], [draft({ id: "5" })]);
    expect(rowsAfter(p.rows, "new:12")).toEqual(["review"]);
    expect(p.at.get("new:12")).toMatchObject({ threads: [{ id: "1" }], drafts: [{ id: "5" }] });
    expect(p.rows.find((row) => row.type === "review")).toEqual({ type: "review", anchor: "new:12" });
  });
});

test("an old-side thread on a context row sits under that row", () => {
  const p = placeThreads(rows, PATH, [thread({ id: "ctx", side: "old", line: 12 })], []);
  expect(p.stale).toEqual([]);
  expect(rowsAfter(p.rows, "new:13")).toEqual(["review"]);
  expect(p.rows.find((row) => row.type === "review")).toEqual({ type: "review", anchor: "old:12" });
});

test("the review row goes below a no-newline note", () => {
  const last = diff.hunks[0]!.lines.at(-1)!;
  const noNewline = {
    ...diff,
    hunks: [{ ...diff.hunks[0]!, lines: [...diff.hunks[0]!.lines.slice(0, -1), { ...last, noNewline: true }] }],
  };
  const p = placeThreads(buildHunkRows(noNewline, 4).rows, PATH, [thread({ id: "end", line: 13 })], []);
  expect(p.rows.slice(-3).map((row) => row.type)).toEqual(["line", "note", "review"]);
});

describe("rowAnchor", () => {
  test("removed rows anchor on the old side, the rest on the new side", () => {
    const lines = rows.filter((row) => row.type === "line");
    expect(lines.map((row) => anchorKey(rowAnchor(row)!))).toEqual(["new:10", "old:11", "new:11", "new:12", "new:13"]);
  });
});

test("commenting needs the PR head locally and the capability", () => {
  const caps = { ...noCaps, reviewComment: true };
  expect(canComment({ state: "local", from: "a", to: "h" }, { headSha: "h" }, caps)).toBe(true);
  expect(canComment({ state: "local", from: "a", to: "x" }, { headSha: "h" }, caps)).toBe(false);
  expect(canComment({ state: "missing" }, { headSha: "h" }, caps)).toBe(false);
  expect(canComment(undefined, { headSha: "h" }, caps)).toBe(false);
  expect(canComment({ state: "local", from: "a", to: "h" }, { headSha: "h" }, noCaps)).toBe(false);
});

test("own pull request: no votes where the host forbids them", () => {
  const github = { ...noCaps, reviewComment: true, reviewApprove: true, reviewRequestChanges: true };
  expect(reviewChoices(github, false)).toEqual(["comment", "approve", "request_changes"]);
  expect(reviewChoices(github, true)).toEqual(["comment"]);
  expect(reviewChoices({ ...github, reviewVoteOwnPr: true }, true)).toEqual(["comment", "approve", "request_changes"]);
  expect(reviewChoices({ ...github, reviewRequestChanges: false }, false)).toEqual(["comment", "approve"]);
});

test("own is decided by login, case-insensitive", () => {
  const info = (login: string | null) =>
    ({
      account: login === null ? null : { user: { login, name: null, avatarUrl: null } },
    }) as unknown as HostRepoInfo;
  const pr = { author: { login: "lena", name: null, avatarUrl: null } };
  expect(isOwnPr(info("Lena"), pr)).toBe(true);
  expect(isOwnPr(info("jonas"), pr)).toBe(false);
  expect(isOwnPr(info(null), pr)).toBe(false);
  expect(isOwnPr(null, pr)).toBe(false);
  expect(isOwnPr(info("lena"), { author: null })).toBe(false);
});

test("submit label counts all drafts", () => {
  expect(submitLabel([draft({}), draft({ origin: "host" })])).toBe("Submit review (2)");
});

test("threads on both sides of a context row share one review row", () => {
  const p = placeThreads(
    rows,
    PATH,
    [thread({ id: "neu", line: 13 }), thread({ id: "alt", side: "old", line: 12 })],
    [draft({ line: 13 })],
  );
  expect(rowsAfter(p.rows, "new:13")).toEqual(["review"]);
  expect(p.at.get("new:13")).toMatchObject({ threads: [{ id: "neu" }, { id: "alt" }], drafts: [{ id: "d" }] });
  expect(p.at.has("old:12")).toBe(false);
});

test("the open comment box gets a review row of its own and wins the row's anchor", () => {
  const p = placeThreads(rows, PATH, [thread({ id: "alt", side: "old", line: 12 })], [], "new:13");
  expect(p.rows.filter((row) => row.type === "review")).toEqual([{ type: "review", anchor: "new:13" }]);
  expect(p.at.get("new:13")!.threads.map((t) => t.id)).toEqual(["alt"]);
  expect(placeThreads(rows, PATH, [], [], "new:400").rows).toEqual(rows);
});

describe("commentRange", () => {
  const at = (key: string) => rows.findIndex((row) => row.type === "line" && anchorKey(rowAnchor(row)!) === key);
  const keys = (range: ReturnType<typeof commentRange>) =>
    range && { first: anchorKey(rowAnchor(range.first)!), last: anchorKey(rowAnchor(range.last)!) };

  test("a range stays on one side inside one hunk", () => {
    expect(keys(commentRange(rows, at("new:11"), at("new:13"), true))).toEqual({ first: "new:11", last: "new:13" });
    expect(keys(commentRange(rows, at("new:13"), at("new:11"), true))).toEqual({ first: "new:11", last: "new:13" });
    expect(keys(commentRange(rows, at("old:11"), at("new:12"), true))).toEqual({ first: "new:12", last: "new:12" });
    expect(keys(commentRange(rows, at("new:11"), at("new:13"), false))).toEqual({ first: "new:13", last: "new:13" });
  });

  test("not across hunks, and nothing on a non-code row", () => {
    const two = buildHunkRows({ ...diff, hunks: [diff.hunks[0]!, { ...diff.hunks[0]!, index: 1 }] }, 4).rows;
    const second = two.length - 1; // new:13 of the second hunk
    expect(keys(commentRange(two, 1, second, true))).toEqual({ first: "new:13", last: "new:13" });
    expect(commentRange(rows, 0, 0, true)).toBeNull();
  });
});

test("a comment carries its side, the range start and the old number of an unchanged line", () => {
  const line = (key: string) => rows.find((row) => row.type === "line" && anchorKey(rowAnchor(row)!) === key) as LineRow;
  expect(commentFor(PATH, line("new:11"), line("new:13"), "h")).toEqual({
    commit: "h",
    path: PATH,
    line: 13,
    startLine: 11,
    side: "new",
    oldLine: 12,
  });
  expect(commentFor(PATH, line("old:11"), line("old:11"), "h")).toMatchObject({ line: 11, startLine: null, side: "old", oldLine: null });
});
