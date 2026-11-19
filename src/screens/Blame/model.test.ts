import { describe, expect, test } from "vitest";
import type { BlameLine } from "../../core";
import { buildModel, PENDING_SHA } from "./model";

const S1 = "1".repeat(40);
const line = (lineNo: number, sha: string): BlameLine => ({
  lineNo,
  text: `Zeile ${lineNo}`,
  sha,
  author: sha === PENDING_SHA ? { name: "", email: "" } : { name: "Lena Hartmann", email: "lena@example.org" },
  authoredAt: sha === PENDING_SHA ? "" : "2026-03-02T09:02:00.000Z",
  summary: sha === PENDING_SHA ? "" : "Messintervall auf fünf Minuten",
  uncommitted: false,
});

describe("blame model", () => {
  test("pending lines form pending blocks that count nowhere", () => {
    const model = buildModel([line(1, S1), line(2, PENDING_SHA), line(3, PENDING_SHA), line(4, S1)]);
    expect(model.blocks.map((block) => [block.sha, block.pending, block.startLine, block.endLine])).toEqual([
      [S1, false, 1, 1],
      [PENDING_SHA, true, 2, 3],
      [S1, false, 4, 4],
    ]);
    expect(model.authors.map((author) => [author.name, author.lines])).toEqual([["Lena Hartmann", 2]]);
    expect(model.commitCount).toBe(1);
    expect(model.uncommittedLines).toBe(0);
    expect(model.ages.reduce((sum, age) => sum + age.lines, 0)).toBe(2);
    expect(model.blocks[1]!.age).toBeNull();
    expect(model.text).toBe("Zeile 1\nZeile 2\nZeile 3\nZeile 4");
  });

  test("a finished model has no pending block", () => {
    const model = buildModel([line(1, S1), line(2, S1), line(3, "2".repeat(40))]);
    expect(model.blocks.every((block) => !block.pending)).toBe(true);
  });
});
