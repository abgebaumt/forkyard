/**
 * Three-way merge for the conflict tool, without React.
 *
 * From base (common ancestor), ours (current side) and theirs (incoming side) a sequence of
 * blocks is produced:
 *   same      both sides equal – goes into the result as is
 *   auto      only one side changed (or both the same way) – taken automatically
 *   conflict  both sides changed the same place differently – the user decides
 *
 * The computation works on lines without line endings; CRLF is turned into LF beforehand and
 * converted back on saving. A missing newline at the end of the file is carried as a flag.
 */
import { diffIndices } from "node-diff3";

export type Side = "ours" | "theirs";
export type Eol = "lf" | "crlf";
export type ChunkKind = "same" | "auto" | "conflict";

export const otherSide = (side: Side): Side => (side === "ours" ? "theirs" : "ours");

export interface SplitText {
  lines: string[];
  finalNewline: boolean;
}

/** Splits a text into lines (without line endings). CRLF counts as LF. */
export function splitText(text: string): SplitText {
  if (text === "") return { lines: [], finalNewline: false };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const finalNewline = lines[lines.length - 1] === "";
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

/** Predominant line ending of a text; null without a line break. */
export function detectEol(text: string | null | undefined): Eol | null {
  if (!text) return null;
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
  }
  if (crlf + lf === 0) return null;
  return crlf > lf ? "crlf" : "lf";
}

export interface Chunk {
  /** Position in `MergeModel.chunks`. */
  id: number;
  kind: ChunkKind;
  ours: string[];
  theirs: string[];
  /** First line (0-based) of this block in the respective version. */
  oursStart: number;
  theirsStart: number;
  /** For `auto`: which side changed. */
  from: Side | "both" | null;
  /** For `conflict`: sequence number among the conflicts (0-based), otherwise −1. */
  conflict: number;
}

export interface MergeModel {
  chunks: Chunk[];
  /** IDs of the conflict blocks in order. */
  conflicts: number[];
  /** Line break at the end of the result. */
  finalNewline: boolean;
  eol: Eol;
  hasBase: boolean;
  /** Lines that were already in one of the versions – they never count as conflict markers when saving. */
  knownMarkerLines: Set<string>;
}

type Range = [number, number];
interface Region {
  kind: ChunkKind;
  a: Range;
  b: Range;
  from: Side | "both" | null;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, index) => line === b[index]);

/** Ersetze `a[aStart, aStart + aLength)` durch `b[bStart, bStart + bLength)`. */
interface Edit {
  aStart: number;
  aLength: number;
  bStart: number;
  bLength: number;
}

/** Longest increasing subsequence (indices into `values`), via patience sorting in O(n log n). */
function longestIncreasing(values: number[]): number[] {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const out: number[] = [];
  for (let index = tails.length > 0 ? tails[tails.length - 1]! : -1; index !== -1; index = previous[index]!) out.push(index);
  return out.reverse();
}

/** Diff of a small piece: cut off the common edges, hand the rest to node-diff3. */
function diffSegment(a: string[], aFrom: number, aTo: number, b: string[], bFrom: number, bTo: number, out: Edit[]): void {
  while (aFrom < aTo && bFrom < bTo && a[aFrom] === b[bFrom]) {
    aFrom++;
    bFrom++;
  }
  while (aFrom < aTo && bFrom < bTo && a[aTo - 1] === b[bTo - 1]) {
    aTo--;
    bTo--;
  }
  if (aFrom === aTo && bFrom === bTo) return;
  if (aFrom === aTo || bFrom === bTo) {
    out.push({ aStart: aFrom, aLength: aTo - aFrom, bStart: bFrom, bLength: bTo - bFrom });
    return;
  }
  for (const item of diffIndices(a.slice(aFrom, aTo), b.slice(bFrom, bTo))) {
    out.push({ aStart: aFrom + item.buffer1[0], aLength: item.buffer1[1], bStart: bFrom + item.buffer2[0], bLength: item.buffer2[1] });
  }
}

/**
 * Line diff that stays fast even for very long files: lines that occur exactly once in both
 * versions serve as anchors (patience method); only the pieces in between go to node-diff3,
 * whose running time grows quadratically with the length of common stretches.
 */
export function diffLines(a: string[], b: string[]): Edit[] {
  const out: Edit[] = [];
  let start = 0;
  const limit = Math.min(a.length, b.length);
  while (start < limit && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (start === aEnd && start === bEnd) return out;

  // Lines that occur exactly once in both middle pieces.
  const seen = new Map<string, { a: number; b: number; countA: number; countB: number }>();
  for (let index = start; index < aEnd; index++) {
    const entry = seen.get(a[index]!);
    if (entry) entry.countA++;
    else seen.set(a[index]!, { a: index, b: -1, countA: 1, countB: 0 });
  }
  for (let index = start; index < bEnd; index++) {
    const entry = seen.get(b[index]!);
    if (!entry) continue;
    entry.countB++;
    entry.b = index;
  }
  const pairs: { a: number; b: number }[] = [];
  for (const entry of seen.values()) if (entry.countA === 1 && entry.countB === 1) pairs.push({ a: entry.a, b: entry.b });
  // `seen` is ordered by first occurrence in a – so the pairs are already sorted by a.
  const chain = longestIncreasing(pairs.map((pair) => pair.b));

  let aPos = start;
  let bPos = start;
  for (const at of chain) {
    const anchor = pairs[at]!;
    if (anchor.a > aPos || anchor.b > bPos) diffSegment(a, aPos, anchor.a, b, bPos, anchor.b, out);
    aPos = anchor.a + 1;
    bPos = anchor.b + 1;
  }
  diffSegment(a, aPos, aEnd, b, bPos, bEnd, out);
  return out;
}

/**
 * Three-way regions over line arrays. Changes of a and b relative to o that overlap or touch
 * form one region together (as in Git: directly adjacent changes collide as well).
 */
function regions(a: string[], o: string[], b: string[]): Region[] {
  interface Hunk {
    side: "a" | "b";
    oStart: number;
    oLength: number;
    length: number;
  }
  const hunks: Hunk[] = [];
  for (const edit of diffLines(o, a)) hunks.push({ side: "a", oStart: edit.aStart, oLength: edit.aLength, length: edit.bLength });
  for (const edit of diffLines(o, b)) hunks.push({ side: "b", oStart: edit.aStart, oLength: edit.aLength, length: edit.bLength });
  hunks.sort((x, y) => x.oStart - y.oStart || (x.side === y.side ? 0 : x.side === "a" ? -1 : 1));

  const out: Region[] = [];
  let oPos = 0;
  let aPos = 0;
  let bPos = 0;
  const same = (oEnd: number) => {
    const length = oEnd - oPos;
    if (length <= 0) return;
    out.push({ kind: "same", a: [aPos, aPos + length], b: [bPos, bPos + length], from: null });
    aPos += length;
    bPos += length;
    oPos = oEnd;
  };

  let index = 0;
  while (index < hunks.length) {
    const first = hunks[index++]!;
    const start = first.oStart;
    let end = first.oStart + first.oLength;
    const group = [first];
    while (index < hunks.length && hunks[index]!.oStart <= end) {
      const next = hunks[index++]!;
      end = Math.max(end, next.oStart + next.oLength);
      group.push(next);
    }
    same(start);
    let aLength = end - start;
    let bLength = end - start;
    let changedA = false;
    let changedB = false;
    for (const hunk of group) {
      if (hunk.side === "a") {
        aLength += hunk.length - hunk.oLength;
        changedA = true;
      } else {
        bLength += hunk.length - hunk.oLength;
        changedB = true;
      }
    }
    const aRange: Range = [aPos, aPos + aLength];
    const bRange: Range = [bPos, bPos + bLength];
    if (changedA && changedB) {
      const equal = sameLines(a.slice(...aRange), b.slice(...bRange));
      out.push({ kind: equal ? "auto" : "conflict", a: aRange, b: bRange, from: equal ? "both" : null });
    } else {
      out.push({ kind: "auto", a: aRange, b: bRange, from: changedA ? "ours" : "theirs" });
    }
    aPos += aLength;
    bPos += bLength;
    oPos = end;
  }
  same(o.length);
  return out;
}

const hasWordCharacter = (lines: string[]) => lines.some((line) => /[\p{L}\p{N}]/u.test(line));

/**
 * Splits a conflict where both sides have equal lines: a common start and a common end always
 * drop out, common lines in the middle only if they contain letters or digits (a blank line
 * alone should not tear a conflict apart).
 */
function refine(region: Region, a: string[], b: string[]): Region[] {
  const aLines = a.slice(...region.a);
  const bLines = b.slice(...region.b);
  interface Piece {
    common: boolean;
    a: Range;
    b: Range;
  }
  const pieces: Piece[] = [];
  let aPos = 0;
  let bPos = 0;
  const common = (length: number, edge: boolean) => {
    if (length <= 0) return;
    const keep = edge || hasWordCharacter(aLines.slice(aPos, aPos + length));
    pieces.push({ common: keep, a: [region.a[0] + aPos, region.a[0] + aPos + length], b: [region.b[0] + bPos, region.b[0] + bPos + length] });
    aPos += length;
    bPos += length;
  };
  for (const edit of diffLines(aLines, bLines)) {
    // A common start always drops out, common parts in the middle only with letters or digits.
    common(edit.aStart - aPos, aPos === 0);
    pieces.push({ common: false, a: [region.a[0] + aPos, region.a[0] + aPos + edit.aLength], b: [region.b[0] + bPos, region.b[0] + bPos + edit.bLength] });
    aPos += edit.aLength;
    bPos += edit.bLength;
  }
  common(aLines.length - aPos, true);
  // Merge adjacent conflict pieces (also across swallowed common lines).
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && !last.common && !piece.common) {
      last.a = [last.a[0], piece.a[1]];
      last.b = [last.b[0], piece.b[1]];
    } else merged.push({ ...piece });
  }
  return merged
    .filter((piece) => piece.a[1] > piece.a[0] || piece.b[1] > piece.b[0])
    .map((piece) => ({ kind: piece.common ? "same" : "conflict", a: piece.a, b: piece.b, from: null }));
}

/** Common start and common end of all three versions – saves the diff the work. */
function commonEdges(a: string[], o: string[] | null, b: string[]): { prefix: number; suffix: number } {
  const limit = Math.min(a.length, b.length, o ? o.length : Number.POSITIVE_INFINITY);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix] && (!o || o[prefix] === a[prefix])) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix] &&
    (!o || o[o.length - 1 - suffix] === a[a.length - 1 - suffix])
  )
    suffix++;
  return { prefix, suffix };
}

/** From this number of lines (both sides together) a file counts as “very large”: no block diff any more. */
export const LARGE_LINES = 120_000;
/** From this number of characters (both sides together). */
export const LARGE_CHARS = 8_000_000;

export function isLarge(ours: string | null, theirs: string | null): boolean {
  const chars = (ours?.length ?? 0) + (theirs?.length ?? 0);
  if (chars > LARGE_CHARS) return true;
  let lines = 0;
  for (const text of [ours, theirs]) {
    if (!text) continue;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
  }
  return lines > LARGE_LINES;
}

const MARKER = /^([<=>|])\1{6}(?:\s|$)/;

/**
 * Builds the model. `base` null: there is no common ancestor (both newly created) – then
 * everything both sides have in common is unchanged, the rest is conflict.
 */
export function buildModel(base: string | null, ours: string, theirs: string): MergeModel {
  const a = splitText(ours);
  const b = splitText(theirs);
  const o = base === null ? null : splitText(base);
  const A = a.lines;
  const B = b.lines;
  const O = o?.lines ?? null;

  const { prefix, suffix } = commonEdges(A, O, B);
  const regionsOut: Region[] = [];
  if (prefix > 0) regionsOut.push({ kind: "same", a: [0, prefix], b: [0, prefix], from: null });
  const aMid = A.slice(prefix, A.length - suffix);
  const bMid = B.slice(prefix, B.length - suffix);
  const oMid = O ? O.slice(prefix, O.length - suffix) : [];
  for (const region of regions(aMid, oMid, bMid)) {
    const shifted: Region = { ...region, a: [region.a[0] + prefix, region.a[1] + prefix], b: [region.b[0] + prefix, region.b[1] + prefix] };
    if (shifted.kind === "conflict") regionsOut.push(...refine(shifted, A, B));
    else if (shifted.kind === "auto" && !O) {
      // Without an ancestor there is no one-sided change: what only one side has is a conflict (against nothing).
      regionsOut.push({ ...shifted, kind: shifted.from === "both" ? "same" : "conflict", from: null });
    } else regionsOut.push(shifted);
  }
  if (suffix > 0) regionsOut.push({ kind: "same", a: [A.length - suffix, A.length], b: [B.length - suffix, B.length], from: null });

  // Merge neighbours of the same kind, drop empty blocks.
  const compact: Region[] = [];
  for (const region of regionsOut) {
    if (region.a[1] === region.a[0] && region.b[1] === region.b[0]) continue;
    const last = compact[compact.length - 1];
    if (last && last.kind === "same" && region.kind === "same") {
      last.a = [last.a[0], region.a[1]];
      last.b = [last.b[0], region.b[1]];
    } else compact.push({ ...region });
  }

  const chunks: Chunk[] = [];
  const conflicts: number[] = [];
  for (const region of compact) {
    const id = chunks.length;
    const conflict = region.kind === "conflict" ? conflicts.length : -1;
    if (region.kind === "conflict") conflicts.push(id);
    chunks.push({
      id,
      kind: region.kind,
      ours: A.slice(...region.a),
      theirs: B.slice(...region.b),
      oursStart: region.a[0],
      theirsStart: region.b[0],
      from: region.from,
      conflict,
    });
  }

  let finalNewline = a.finalNewline;
  if (a.finalNewline !== b.finalNewline) {
    // Only one side changed the end of the file: its version applies.
    if (o && a.finalNewline === o.finalNewline) finalNewline = b.finalNewline;
  }
  if (A.length === 0 && B.length > 0) finalNewline = b.finalNewline;

  const known = new Set<string>();
  for (const line of [...A, ...B]) if (MARKER.test(line)) known.add(line);

  return {
    chunks,
    conflicts,
    finalNewline,
    eol: detectEol(ours) ?? detectEol(theirs) ?? "lf",
    hasBase: Boolean(O),
    knownMarkerLines: known,
  };
}

// ---------------------------------------------------------------------------
// Auswahl je Konflikt
// ---------------------------------------------------------------------------

export interface Choice {
  /** Taken sides in the order of choice; empty = open. */
  order: Side[];
  /** Per line of the side: taken? */
  ours: boolean[];
  theirs: boolean[];
}

export const emptyChoice = (chunk: Chunk): Choice => ({ order: [], ours: chunk.ours.map(() => false), theirs: chunk.theirs.map(() => false) });

/** Select or deselect a whole side. */
export function toggleSide(chunk: Chunk, choice: Choice, side: Side, on: boolean): Choice {
  const lines = chunk[side].map(() => on);
  const order = on ? (choice.order.includes(side) ? choice.order : [...choice.order, side]) : choice.order.filter((item) => item !== side);
  return { ...choice, order, [side]: lines };
}

/** Select or deselect one line. The side counts as taken as long as one of its lines is selected. */
export function toggleLine(_chunk: Chunk, choice: Choice, side: Side, line: number, on: boolean): Choice {
  const lines = choice[side].slice();
  lines[line] = on;
  const any = lines.some(Boolean);
  const order = any ? (choice.order.includes(side) ? choice.order : [...choice.order, side]) : choice.order.filter((item) => item !== side);
  return { ...choice, order, [side]: lines };
}

export const swapOrder = (choice: Choice): Choice => ({ ...choice, order: [...choice.order].reverse() });

/** State of a side for its block checkbox. */
export function sideState(chunk: Chunk, choice: Choice, side: Side): boolean | "mixed" {
  if (!choice.order.includes(side)) return false;
  const lines = choice[side];
  if (chunk[side].length === 0) return true;
  const count = lines.filter(Boolean).length;
  return count === lines.length ? true : count === 0 ? false : "mixed";
}

export interface Labels {
  ours: string;
  theirs: string;
}

const linesText = (lines: string[]) => lines.map((line) => `${line}\n`).join("");

/** Text of the block with conflict markers, as Git writes it. */
export function markerText(chunk: Chunk, labels: Labels): string {
  return `<<<<<<< ${labels.ours}\n${linesText(chunk.ours)}=======\n${linesText(chunk.theirs)}>>>>>>> ${labels.theirs}\n`;
}

/** What a block writes into the result without manual editing. */
export function chunkText(chunk: Chunk, choice: Choice | null, labels: Labels): string {
  switch (chunk.kind) {
    case "same":
      return linesText(chunk.ours);
    case "auto":
      return linesText(chunk.from === "theirs" ? chunk.theirs : chunk.ours);
    case "conflict": {
      if (!choice || choice.order.length === 0) return markerText(chunk, labels);
      return choice.order.map((side) => linesText(chunk[side].filter((_, index) => choice[side][index]))).join("");
    }
  }
}

export type BlockState = "open" | "ours" | "theirs" | "both" | "manual";

export function blockState(choice: Choice, manual: string | null): BlockState {
  if (manual !== null) return "manual";
  if (choice.order.length === 0) return "open";
  if (choice.order.length === 2) return "both";
  return choice.order[0]!;
}

/** Per block: its text if it differs from what the selection would produce (“edited by hand”), otherwise null. */
export function manualOf(texts: string[], expected: string[]): (string | null)[] {
  return texts.map((text, index) => (text === expected[index] ? null : text));
}

/** Lines (1-based) with conflict markers. Lines that were already in a version do not count. */
export function markerLines(text: string, known: ReadonlySet<string>): number[] {
  const found: number[] = [];
  let line = 1;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const first = text.charCodeAt(start);
    // Fast pre-filter: only lines starting with < = > |.
    if (first === 60 || first === 61 || first === 62 || first === 124) {
      const content = text.slice(start, end).replace(/\r$/, "");
      if (MARKER.test(content) && !known.has(content)) found.push(line);
    }
    if (end === text.length) break;
    start = end + 1;
    line++;
  }
  return found;
}

/** A manually edited block counts as resolved when no conflict markers are left in it. */
export const isResolved = (choice: Choice, manual: string | null, known: ReadonlySet<string>): boolean =>
  manual !== null ? markerLines(manual, known).length === 0 : choice.order.length > 0;

/** Result text for saving: the file's line ending, end without a newline if the versions had it that way. */
export function finalizeText(doc: string, model: { eol: Eol; finalNewline: boolean }): string {
  let text = doc;
  if (!model.finalNewline && text.endsWith("\n")) text = text.slice(0, -1);
  return model.eol === "crlf" ? text.replace(/\r?\n/g, "\r\n") : text;
}

/**
 * Block bounds after replacing the ranges of `changes` (block i lies in [bounds[i], bounds[i + 1])).
 * Only the bounds after a replaced block move; every other block keeps its text.
 */
export function shiftBounds(old: number[], changes: { chunk: number; text: string }[]): number[] {
  const sorted = [...changes].sort((a, b) => a.chunk - b.chunk);
  const next = old.slice();
  let delta = 0;
  let cursor = 0;
  for (const change of sorted) {
    for (; cursor <= change.chunk; cursor++) next[cursor] = old[cursor]! + delta;
    delta += change.text.length - (old[change.chunk + 1]! - old[change.chunk]!);
  }
  for (; cursor < old.length; cursor++) next[cursor] = old[cursor]! + delta;
  return next;
}

// ---------------------------------------------------------------------------
// Rows of the side-by-side view (top)
// ---------------------------------------------------------------------------

export interface SideCell {
  /** Line in the version, 0-based. */
  line: number;
  /** Position within the block. */
  offset: number;
  text: string;
}

export type Row =
  | { type: "head"; chunk: number }
  | { type: "line"; chunk: number; ours: SideCell | null; theirs: SideCell | null };

export interface RowModel {
  rows: Row[];
  /** Index of the first row per block. */
  chunkStart: number[];
  /** Per block and side the row indices that hold a line of this side. */
}

/**
 * Both sides next to each other, block by block of equal height (missing lines are padded) –
 * this way both columns run in one scroll area. Conflicts and automatically taken blocks get a
 * header row.
 */
export function buildRows(model: MergeModel): RowModel {
  const rows: Row[] = [];
  const chunkStart: number[] = [];
  for (const chunk of model.chunks) {
    chunkStart.push(rows.length);
    if (chunk.kind !== "same") rows.push({ type: "head", chunk: chunk.id });
    const height = Math.max(chunk.ours.length, chunk.theirs.length);
    for (let offset = 0; offset < height; offset++) {
      const cell = (side: Side): SideCell | null => {
        const lines = chunk[side];
        if (offset >= lines.length) return null;
        return { line: (side === "ours" ? chunk.oursStart : chunk.theirsStart) + offset, offset, text: lines[offset]! };
      };
      rows.push({ type: "line", chunk: chunk.id, ours: cell("ours"), theirs: cell("theirs") });
    }
  }
  return { rows, chunkStart };
}

// ---------------------------------------------------------------------------
// Comparison with the file in the working directory
// ---------------------------------------------------------------------------

/**
 * Resolves the conflict markers of a text entirely in favour of one side (also in diff3 style
 * with `|||||||`). Returns null if the markers do not match up.
 */
export function resolveMarkers(text: string, side: Side): string | null {
  const out: string[] = [];
  let part: "outside" | "ours" | "base" | "theirs" = "outside";
  const { lines } = splitText(text);
  for (const line of lines) {
    const marker = MARKER.test(line) ? line[0] : null;
    if (part === "outside") {
      if (marker === "<") part = "ours";
      else out.push(line);
    } else if (part === "ours") {
      if (marker === "|") part = "base";
      else if (marker === "=") part = "theirs";
      else if (marker === "<" || marker === ">") return null;
      else if (side === "ours") out.push(line);
    } else if (part === "base") {
      if (marker === "=") part = "theirs";
      else if (marker === "<" || marker === ">") return null;
    } else {
      if (marker === ">") part = "outside";
      else if (marker === "<") return null;
      else if (side === "theirs") out.push(line);
    }
  }
  return part === "outside" ? out.join("\n") : null;
}

/** Result lines if every conflict goes entirely to one side. */
export function resolvedLines(model: MergeModel, side: Side): string[] {
  const out: string[] = [];
  for (const chunk of model.chunks) {
    if (chunk.kind === "same") out.push(...chunk.ours);
    else if (chunk.kind === "auto") out.push(...(chunk.from === "theirs" ? chunk.theirs : chunk.ours));
    else out.push(...chunk[side]);
  }
  return out;
}

/**
 * Does the file in the working directory (with Git's conflict markers) match this diff? False
 * means: it was already edited by hand after the conflict – or Git merged differently.
 */
export function worktreeMatches(model: MergeModel, merged: string | null): boolean {
  if (merged === null) return true;
  for (const side of ["ours", "theirs"] as Side[]) {
    const resolved = resolveMarkers(merged, side);
    if (resolved === null || resolved !== resolvedLines(model, side).join("\n")) return false;
  }
  return true;
}
