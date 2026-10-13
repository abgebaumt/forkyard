/**
 * Changes for the “Side by side” view from the hunks Git already delivered.
 *
 * Otherwise CodeMirror's merge view compares both versions itself, character by character over
 * the whole file. With many scattered changes (2375 changed lines out of 19 000) the UI froze for
 * more than 30 seconds. Git's hunks say line by line what changed – in linear time; only within
 * small change blocks is a character-level comparison still done, so that the changed spots in
 * the line stay marked.
 */
import { Change, diff as charDiff } from "@codemirror/merge";
import type { Hunk } from "../../core";

/** Larger blocks are no longer compared character by character: the whole block counts as changed. */
const REFINE_MAX_CHARS = 4000;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

/** Character changes from `oldText` to `newText`, derived from `hunks` (line numbers from 1). */
export function changesFromHunks(oldText: string, newText: string, hunks: readonly Hunk[]): Change[] {
  const startsA = lineStarts(oldText);
  const startsB = lineStarts(newText);
  /** Start of line `line` (from 1); past the last line the end of the text. */
  const at = (starts: number[], line: number, length: number) => (line - 1 < starts.length ? (starts[line - 1] as number) : length);
  const changes: Change[] = [];

  for (const hunk of hunks) {
    // Without old or new lines respectively, the hunk names the line BEFORE.
    let nextOld = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    let nextNew = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    let block: { oldFrom: number; oldCount: number; newFrom: number; newCount: number } | null = null;
    const flush = () => {
      if (!block) return;
      const fromA = at(startsA, block.oldFrom, oldText.length);
      const toA = at(startsA, block.oldFrom + block.oldCount, oldText.length);
      const fromB = at(startsB, block.newFrom, newText.length);
      const toB = at(startsB, block.newFrom + block.newCount, newText.length);
      block = null;
      if (fromA === toA && fromB === toB) return;
      const small = toA - fromA > 0 && toB - fromB > 0 && toA - fromA <= REFINE_MAX_CHARS && toB - fromB <= REFINE_MAX_CHARS;
      if (!small) {
        changes.push(new Change(fromA, toA, fromB, toB));
        return;
      }
      for (const part of charDiff(oldText.slice(fromA, toA), newText.slice(fromB, toB), { scanLimit: 500, timeout: 20 })) {
        changes.push(new Change(fromA + part.fromA, fromA + part.toA, fromB + part.fromB, fromB + part.toB));
      }
    };
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        flush();
        if (line.oldNo !== null) nextOld = line.oldNo + 1;
        if (line.newNo !== null) nextNew = line.newNo + 1;
        continue;
      }
      block ??= { oldFrom: nextOld, oldCount: 0, newFrom: nextNew, newCount: 0 };
      if (line.kind === "remove") {
        block.oldCount++;
        nextOld = (line.oldNo ?? nextOld) + 1;
      } else {
        block.newCount++;
        nextNew = (line.newNo ?? nextNew) + 1;
      }
    }
    flush();
  }
  return changes;
}
