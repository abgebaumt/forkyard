import { describe, expect, it } from "vitest";
import type { DiffLine, Hunk } from "../../core";
import { changesFromHunks } from "./hunkChanges";

const line = (kind: DiffLine["kind"], text: string, oldNo: number | null, newNo: number | null): DiffLine => ({ kind, text, oldNo, newNo, noNewline: false });
const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: DiffLine[]): Hunk => ({ index: 0, oldStart, oldLines, newStart, newLines, section: "", lines });

/** Applies the changes: the old text must turn into the new one. */
function apply(oldText: string, newText: string, changes: { fromA: number; toA: number; fromB: number; toB: number }[]): string {
  let out = "";
  let at = 0;
  for (const change of changes) {
    out += oldText.slice(at, change.fromA) + newText.slice(change.fromB, change.toB);
    at = change.toA;
  }
  return out + oldText.slice(at);
}

describe("changesFromHunks (“Side by side” without its own comparison of the whole file)", () => {
  it("changed, added and deleted lines yield exactly the change of the text", () => {
    const oldText = "eins\nzwei\ndrei\nvier\nfünf\n";
    const newText = "eins\nZWEI\ndrei\nfünf\nsechs\n";
    const changes = changesFromHunks(oldText, newText, [
      hunk(1, 5, 1, 5, [
        line("context", "eins", 1, 1),
        line("remove", "zwei", 2, null),
        line("add", "ZWEI", null, 2),
        line("context", "drei", 3, 3),
        line("remove", "vier", 4, null),
        line("context", "fünf", 5, 4),
        line("add", "sechs", null, 5),
      ]),
    ]);
    expect(apply(oldText, newText, changes)).toBe(newText);
    // The changed line is captured character by character, not as a whole line.
    expect(changes[0]).toMatchObject({ fromA: 5, toA: 9, fromB: 5, toB: 9 });
  });

  it("inserting into an empty file and emptying a file", () => {
    expect(apply("", "neu\n", changesFromHunks("", "neu\n", [hunk(0, 0, 1, 1, [line("add", "neu", null, 1)])]))).toBe("neu\n");
    expect(apply("alt\n", "", changesFromHunks("alt\n", "", [hunk(1, 1, 0, 0, [line("remove", "alt", 1, null)])]))).toBe("");
  });

  it("2375 changed lines out of 19 000: in milliseconds, not seconds", () => {
    const oldLines = Array.from({ length: 19_000 }, (_, index) => `Zeile ${index + 1}`);
    const newLines = oldLines.map((text, index) => (index % 8 === 3 ? `${text} GEÄNDERT` : text));
    const hunks: Hunk[] = [];
    for (let index = 3; index < oldLines.length; index += 8) {
      hunks.push(hunk(index + 1, 1, index + 1, 1, [line("remove", oldLines[index] as string, index + 1, null), line("add", newLines[index] as string, null, index + 1)]));
    }
    const [oldText, newText] = [`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`];
    const started = performance.now();
    const changes = changesFromHunks(oldText, newText, hunks);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(changes.length).toBe(2375);
    expect(apply(oldText, newText, changes)).toBe(newText);
  });
});
