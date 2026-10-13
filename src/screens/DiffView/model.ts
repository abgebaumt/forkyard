/**
 * Pure functions of the diff view: build the view's rows from a `TextDiff`, determine word
 * differences, translate the selection into a `PatchSelection`.
 * No React, no core – that keeps it easy to test.
 */
import { diffWordsWithSpace } from "diff";
import type { DiffLineKind, DiffSource, Hunk, PatchSelection, TextDiff } from "../../core";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// Rows of the view
// ---------------------------------------------------------------------------

export interface LineRow {
  type: "line";
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** Position of the hunk in `diff.hunks`; null for rows outside any hunk (“Whole file” view). */
  hunkOrd: number | null;
  /** Position in `hunk.lines`; null outside hunks. */
  pos: number | null;
}

export interface HunkRow {
  type: "hunk";
  hunkOrd: number;
  hunk: Hunk;
  added: number;
  removed: number;
}

/** Header of an unchanged region in “Whole file”: collapses and expands it. */
export interface FoldRow {
  type: "fold";
  id: number;
  /** First and last line of the region in the new version. */
  from: number;
  to: number;
  collapsed: boolean;
}

/** Note below a line, e.g. “No newline at end of file”. */
export interface NoteRow {
  type: "note";
  kind: DiffLineKind;
  note: "no_newline";
}

export type Row = LineRow | HunkRow | FoldRow | NoteRow;

export interface RowModel {
  rows: Row[];
  /** Index of the first row of every change block – targets for “previous/next change”. */
  changeStarts: number[];
  /** Longest line in columns (tabs counted with `tabSize`), for the width without wrapping. */
  maxColumns: number;
  /** Digits of the largest line number. */
  digits: number;
  /** Number of changed lines (add + remove). */
  changedLines: number;
  foldCount: number;
}

/** Unchanged regions shorter than this get no collapse header. */
export const FOLD_MIN_LINES = 8;

const columnsOf = (text: string, tabSize: number) => {
  let columns = text.length;
  if (text.includes("\t")) {
    columns = 0;
    for (const char of text) columns += char === "\t" ? tabSize - (columns % tabSize) : 1;
  }
  return columns;
};

class Builder {
  rows: Row[] = [];
  changeStarts: number[] = [];
  maxColumns = 0;
  maxNo = 0;
  changedLines = 0;
  foldCount = 0;
  private inChange = false;

  constructor(private tabSize: number) {}

  push(row: Row) {
    if (row.type === "line") {
      const changed = row.kind !== "context";
      if (changed && !this.inChange) this.changeStarts.push(this.rows.length);
      if (changed) this.changedLines++;
      this.inChange = changed;
      this.maxColumns = Math.max(this.maxColumns, columnsOf(row.text, this.tabSize));
      this.maxNo = Math.max(this.maxNo, row.oldNo ?? 0, row.newNo ?? 0);
    } else if (row.type !== "note") {
      this.inChange = false;
    }
    this.rows.push(row);
  }

  hunkLines(hunk: Hunk, hunkOrd: number) {
    hunk.lines.forEach((line, pos) => {
      this.push({ type: "line", kind: line.kind, oldNo: line.oldNo, newNo: line.newNo, text: line.text, hunkOrd, pos });
      if (line.noNewline) this.push({ type: "note", kind: line.kind, note: "no_newline" });
    });
  }

  done(): RowModel {
    return {
      rows: this.rows,
      changeStarts: this.changeStarts,
      maxColumns: this.maxColumns,
      digits: Math.max(2, String(this.maxNo).length),
      changedLines: this.changedLines,
      foldCount: this.foldCount,
    };
  }
}

const countKind = (hunk: Hunk, kind: DiffLineKind) => hunk.lines.reduce((sum, line) => sum + (line.kind === kind ? 1 : 0), 0);

/** “Hunks” view: a header per hunk, its lines below. */
export function buildHunkRows(diff: TextDiff, tabSize: number): RowModel {
  const builder = new Builder(tabSize);
  diff.hunks.forEach((hunk, hunkOrd) => {
    builder.push({ type: "hunk", hunkOrd, hunk, added: countKind(hunk, "add"), removed: countKind(hunk, "remove") });
    builder.hunkLines(hunk, hunkOrd);
  });
  return builder.done();
}

/** Text as lines without line endings (LF or CRLF); a line ending at the end yields no empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * “Whole file” view: the new version in full, the hunks in their place (with the removed lines),
 * unchanged regions in between collapsible.
 * `collapsed` contains the IDs of the collapsed regions (consecutive from 0).
 */
export function buildFileRows(diff: TextDiff, newText: string, collapsed: ReadonlySet<number>, tabSize: number): RowModel {
  const builder = new Builder(tabSize);
  const lines = splitLines(newText);
  let nextNew = 1;
  /** new line number − old line number in the unchanged region before the next hunk */
  let offset = 0;

  const region = (from: number, to: number) => {
    if (to < from) return;
    const foldable = to - from + 1 >= FOLD_MIN_LINES;
    const id = builder.foldCount;
    const isCollapsed = foldable && collapsed.has(id);
    if (foldable) {
      builder.foldCount++;
      builder.push({ type: "fold", id, from, to, collapsed: isCollapsed });
    }
    if (isCollapsed) return;
    for (let no = from; no <= to; no++) {
      builder.push({ type: "line", kind: "context", oldNo: no - offset, newNo: no, text: lines[no - 1] ?? "", hunkOrd: null, pos: null });
    }
  };

  diff.hunks.forEach((hunk, hunkOrd) => {
    // For a hunk without new lines `newStart` names the line BEFORE.
    const firstNew = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    region(nextNew, firstNew - 1);
    builder.hunkLines(hunk, hunkOrd);
    nextNew = firstNew + hunk.newLines;
    offset += hunk.newLines - hunk.oldLines;
  });
  region(nextNew, lines.length);
  return builder.done();
}

// ---------------------------------------------------------------------------
// Wort-Diff
// ---------------------------------------------------------------------------

export interface Range {
  from: number;
  to: number;
}

/** Above this length a word-by-word comparison is no longer worth it (and would be slow). */
const WORD_DIFF_MAX_LENGTH = 2000;
/** If less than this share stays the same, they are two different lines – then no highlighting. */
const WORD_DIFF_MIN_COMMON = 0.3;

/** Changed segments of a line pair: `[old, new]`, or null if the pair cannot be compared meaningfully. */
export function wordDiff(oldText: string, newText: string): [Range[], Range[]] | null {
  if (oldText === newText || oldText.length > WORD_DIFF_MAX_LENGTH || newText.length > WORD_DIFF_MAX_LENGTH) return null;
  const parts = diffWordsWithSpace(oldText, newText);
  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  let oldAt = 0;
  let newAt = 0;
  let common = 0;
  const add = (ranges: Range[], from: number, to: number) => {
    const last = ranges[ranges.length - 1];
    if (last && last.to === from) last.to = to;
    else ranges.push({ from, to });
  };
  for (const part of parts) {
    const length = part.value.length;
    if (part.added) {
      add(newRanges, newAt, newAt + length);
      newAt += length;
    } else if (part.removed) {
      add(oldRanges, oldAt, oldAt + length);
      oldAt += length;
    } else {
      if (part.value.trim() !== "") common += length;
      oldAt += length;
      newAt += length;
    }
  }
  const longest = Math.max(oldText.trim().length, newText.trim().length);
  if (longest === 0 || common / longest < WORD_DIFF_MIN_COMMON) return null;
  return [joinAcrossSpace(oldRanges, oldText), joinAcrossSpace(newRanges, newText)];
}

/** Two highlights with only whitespace between them become one – that reads more calmly. */
function joinAcrossSpace(ranges: Range[], text: string): Range[] {
  const joined: Range[] = [];
  for (const range of ranges) {
    const last = joined[joined.length - 1];
    if (last && text.slice(last.to, range.from).trim() === "") last.to = range.to;
    else joined.push({ ...range });
  }
  return joined;
}

/**
 * Word differences per hunk, computed on demand and memoised. In a change block (first removed,
 * then added lines) the lines belong together in order.
 */
export class WordDiffCache {
  private byHunk = new Map<number, Map<number, Range[]>>();

  constructor(private diff: TextDiff) {}

  /** Highlighted segments of line `pos` in hunk `hunkOrd`, or undefined. */
  get(hunkOrd: number, pos: number): Range[] | undefined {
    let marks = this.byHunk.get(hunkOrd);
    if (!marks) {
      marks = this.compute(this.diff.hunks[hunkOrd]);
      this.byHunk.set(hunkOrd, marks);
    }
    return marks.get(pos);
  }

  private compute(hunk: Hunk | undefined): Map<number, Range[]> {
    const marks = new Map<number, Range[]>();
    if (!hunk) return marks;
    const lines = hunk.lines;
    let index = 0;
    while (index < lines.length) {
      if (lines[index]?.kind !== "remove") {
        index++;
        continue;
      }
      const removeStart = index;
      while (lines[index]?.kind === "remove") index++;
      const addStart = index;
      while (lines[index]?.kind === "add") index++;
      const pairs = Math.min(addStart - removeStart, index - addStart);
      // Very large blocks are mostly rewritten sections; highlighting does not help there.
      if (pairs === 0 || pairs > 400) continue;
      for (let pair = 0; pair < pairs; pair++) {
        const oldLine = lines[removeStart + pair];
        const newLine = lines[addStart + pair];
        if (!oldLine || !newLine) continue;
        const result = wordDiff(oldLine.text, newLine.text);
        if (!result) continue;
        if (result[0].length) marks.set(removeStart + pair, result[0]);
        if (result[1].length) marks.set(addStart + pair, result[1]);
      }
    }
    return marks;
  }
}

// ---------------------------------------------------------------------------
// Segments of a line: overlay syntax colours and word highlighting
// ---------------------------------------------------------------------------

export interface Segment {
  text: string;
  className?: string;
  marked: boolean;
}

/** Splits `text` at all boundaries of syntax segments and highlights. */
export function segmentsOf(text: string, tokens: readonly { from: number; to: number; className: string }[] | undefined, marks: readonly Range[] | undefined): Segment[] {
  if (!tokens?.length && !marks?.length) return [{ text, marked: false }];
  const cuts = new Set<number>([0, text.length]);
  for (const token of tokens ?? []) {
    if (token.from < text.length) cuts.add(Math.max(0, token.from));
    if (token.to < text.length) cuts.add(Math.max(0, token.to));
  }
  for (const mark of marks ?? []) {
    if (mark.from < text.length) cuts.add(mark.from);
    if (mark.to < text.length) cuts.add(mark.to);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let tokenIndex = 0;
  let markIndex = 0;
  for (let index = 0; index + 1 < points.length; index++) {
    const from = points[index] as number;
    const to = points[index + 1] as number;
    while (tokens && tokenIndex < tokens.length && (tokens[tokenIndex] as { to: number }).to <= from) tokenIndex++;
    while (marks && markIndex < marks.length && (marks[markIndex] as Range).to <= from) markIndex++;
    const token = tokens?.[tokenIndex];
    const mark = marks?.[markIndex];
    const className = token && token.from <= from ? token.className : undefined;
    const marked = Boolean(mark && mark.from <= from);
    const last = segments[segments.length - 1];
    if (last && last.className === className && last.marked === marked) last.text += text.slice(from, to);
    else segments.push({ text: text.slice(from, to), className, marked });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Auswahl
// ---------------------------------------------------------------------------

/** Key of a selectable line: position of the hunk and of the line. */
export const lineKey = (hunkOrd: number, pos: number) => `${hunkOrd}:${pos}`;

export const isSelectable = (row: Row | undefined): row is LineRow & { hunkOrd: number; pos: number } =>
  Boolean(row && row.type === "line" && row.kind !== "context" && row.hunkOrd !== null && row.pos !== null);

/** Keys of all selectable lines between two rows of the view (boundaries included). */
export function keysBetween(rows: readonly Row[], a: number, b: number): string[] {
  const keys: string[] = [];
  for (let index = Math.min(a, b); index <= Math.max(a, b); index++) {
    const row = rows[index];
    if (isSelectable(row)) keys.push(lineKey(row.hunkOrd, row.pos));
  }
  return keys;
}

/** Selection → `PatchSelection` for `stagePatch`, `unstagePatch`, `discardPatch`. */
export function selectionToPatch(diff: TextDiff, selected: ReadonlySet<string>): PatchSelection | null {
  if (!diff.token) return null;
  const byHunk = new Map<number, number[]>();
  for (const key of selected) {
    const [hunkOrd, pos] = key.split(":").map(Number) as [number, number];
    const hunk = diff.hunks[hunkOrd];
    const line = hunk?.lines[pos];
    if (!hunk || !line || line.kind === "context") continue;
    const list = byHunk.get(hunk.index) ?? [];
    list.push(pos);
    byHunk.set(hunk.index, list);
  }
  if (byHunk.size === 0) return null;
  return {
    path: diff.path,
    hunks: [...byHunk.entries()].sort((a, b) => a[0] - b[0]).map(([index, lines]) => ({ index, lines: lines.sort((a, b) => a - b) })),
    expect: diff.token,
  };
}

/** A whole hunk as a `PatchSelection`. */
export function hunkToPatch(diff: TextDiff, hunkOrd: number): PatchSelection | null {
  const hunk = diff.hunks[hunkOrd];
  if (!diff.token || !hunk) return null;
  return { path: diff.path, hunks: [{ index: hunk.index, lines: null }], expect: diff.token };
}

// ---------------------------------------------------------------------------
// Beschriftungen
// ---------------------------------------------------------------------------

/** What is possible with hunks and lines of this source. */
export type PatchMode = "unstaged" | "staged" | "none";

export const patchModeOf = (source: DiffSource): PatchMode => (source.kind === "unstaged" ? "unstaged" : source.kind === "staged" ? "staged" : "none");

/** Readable line range of a hunk: “Line 4”, “Lines 12–18”; for pure deletions the old range. */
export function hunkRange(hunk: Hunk): string {
  const useOld = hunk.newLines === 0;
  const start = useOld ? hunk.oldStart : hunk.newStart;
  const count = useOld ? hunk.oldLines : hunk.newLines;
  const label = count <= 1 ? t("diff.hunkRange.line", { start }) : t("diff.hunkRange.lines", { start, end: start + count - 1 });
  return useOld ? t("diff.hunkRange.old", { label }) : label;
}

/** Folder and file name separately. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

export const sourceKey = (source: DiffSource): string =>
  source.kind === "commit" ? `commit:${source.sha}` : source.kind === "range" ? `range:${source.from}..${source.to ?? ""}` : source.kind === "stash" ? `stash:${source.index}` : source.kind;
