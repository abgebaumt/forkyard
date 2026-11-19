import { describe, expect, it } from "vitest";
import type { ConflictIntentBlock } from "../../core";
import {
  blockNote,
  canApply,
  clampIntentWidth,
  conflictRanges,
  hasChange,
  type IntentResult,
  openProposals,
  planApplyAll,
  suggestionDiff,
} from "./intent";
import { buildModel, chunkText, emptyChoice, isResolved, manualOf, shiftBounds } from "./model";

const labels = { ours: "main", theirs: "feature" };

describe("the conflict blocks sent to the core", () => {
  const base = "kopf\neins\nmitte\nzwei\nende\n";
  const ours = "kopf\nEINS main\nmitte\nZWEI main\nende\n";
  const theirs = "kopf\neins feature\nzusatz\nmitte\nZWEI feature\nende\n";
  const expected = [
    { oursStart: 1, oursCount: 1, theirsStart: 1, theirsCount: 2 },
    { oursStart: 3, oursCount: 1, theirsStart: 4, theirsCount: 1 },
  ];

  it("are line ranges of both sides, in the order of the conflicts", () => {
    expect(conflictRanges(buildModel(base, ours, theirs))).toEqual(expected);
  });

  it("count lines the same way with CRLF and without a final newline", () => {
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    expect(conflictRanges(buildModel(crlf(base), crlf(ours), crlf(theirs).replace(/\r\n$/, "")))).toEqual(expected);
  });
});

describe("the proposal as a small diff against the block's current text", () => {
  it("marks changed lines with their kind", () => {
    expect(suggestionDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
    expect(suggestionDiff("EINS main\n", "EINS main\nzusatz\n")).toEqual([
      { kind: "same", text: "EINS main" },
      { kind: "add", text: "zusatz" },
    ]);
    expect(suggestionDiff("x\n", "")).toEqual([{ kind: "del", text: "x" }]);
  });

  it("sees no change when only the line endings differ", () => {
    const rows = suggestionDiff("a\r\nb\r\n", "a\nb\n");
    expect(rows).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
    expect(hasChange(rows)).toBe(false);
  });
});

describe("Apply replaces exactly one block", () => {
  const model = buildModel(
    "kopf\neins\nmitte\nzwei\nende\n",
    "kopf\nEINS main\nmitte\nZWEI main\nende\n",
    "kopf\neins feature\nmitte\nZWEI feature\nende\n",
  );
  const chunks = [
    "kopf\n",
    "<<<<<<< main\nEINS main\n=======\neins feature\n>>>>>>> feature\n",
    "mitte\n",
    "<<<<<<< main\nZWEI main\n=======\nZWEI feature\n>>>>>>> feature\n",
    "ende\n",
  ];
  const boundsOf = (parts: string[]) => parts.reduce<number[]>((out, part) => [...out, out[out.length - 1]! + part.length], [0]);

  it("starts from what the tool shows: markers in both conflicts", () => {
    expect(model.chunks.map((chunk) => chunkText(chunk, chunk.kind === "conflict" ? emptyChoice(chunk) : null, labels))).toEqual(chunks);
  });

  it("moves only the bounds after the block; the other blocks keep their text", () => {
    const proposal = "EINS feature\nzusatz\n";
    const after = [chunks[0]!, proposal, chunks[2]!, chunks[3]!, chunks[4]!];
    expect(shiftBounds(boundsOf(chunks), [{ chunk: 1, text: proposal }])).toEqual(boundsOf(after));
    expect(
      shiftBounds(boundsOf(chunks), [
        { chunk: 3, text: "" },
        { chunk: 1, text: proposal },
      ]),
      "unsorted changes",
    ).toEqual(boundsOf([chunks[0]!, proposal, chunks[2]!, "", chunks[4]!]));
  });

  it("makes the block count as edited by hand and resolved; the other conflict stays open", () => {
    const manual = manualOf([chunks[0]!, "EINS feature\n", chunks[2]!, chunks[3]!, chunks[4]!], chunks);
    expect(manual).toEqual([null, "EINS feature\n", null, null, null]);
    expect(isResolved(emptyChoice(model.chunks[1]!), manual[1] ?? null, model.knownMarkerLines)).toBe(true);
    expect(isResolved(emptyChoice(model.chunks[3]!), manual[3] ?? null, model.knownMarkerLines)).toBe(false);
  });
});

describe("blocks that may be applied", () => {
  const block = (patch: Partial<ConflictIntentBlock>): ConflictIntentBlock => ({
    block: 0,
    sent: "full",
    oursWhy: "a",
    theirsWhy: "b",
    text: "x\n",
    reason: null,
    ...patch,
  });

  it("only complete blocks with a proposal", () => {
    expect(canApply(block({}))).toBe(true);
    expect(canApply(block({ text: null }))).toBe(false);
    expect(canApply(block({ sent: "shortened", text: null }))).toBe(false);
    expect([block({}), block({ sent: "shortened" }), block({ sent: "redacted" }), block({ sent: "left_out" })].map(blockNote)).toEqual([
      null,
      "shortened",
      "redacted",
      "leftOut",
    ]);
  });
});

describe("apply all", () => {
  const full = (n: number): ConflictIntentBlock => ({
    block: n,
    sent: "full",
    oursWhy: "…",
    theirsWhy: "…",
    text: `Vorschlag ${n}\n`,
    reason: null,
  });
  const shortened = (n: number): ConflictIntentBlock => ({ ...full(n), sent: "shortened", text: null });
  // 0 full open · 1 full taken · 2 full discarded · 3 shortened (no text) · 4 full open, edited by hand · 5 full open
  const result: IntentResult = {
    intent: { path: "src/station.py", blocks: [full(0), full(1), full(2), shortened(3), full(4), full(5)] },
    decisions: { 1: "taken", 2: "discarded" },
  };
  it("counts undecided proposals, hand-edited ones included", () => {
    expect(openProposals(result)).toBe(3);
    expect(openProposals({ ...result, decisions: { ...result.decisions, 0: "taken", 4: "discarded", 5: "taken" } })).toBe(0);
  });
  it("applies every undecided proposal and skips blocks edited by hand", () => {
    expect(planApplyAll(result, (conflict) => conflict === 4)).toEqual({
      apply: [
        { conflict: 0, text: "Vorschlag 0\n" },
        { conflict: 5, text: "Vorschlag 5\n" },
      ],
      skipped: [4],
    });
  });
});

describe("the column width", () => {
  it("stays between a fifth and half of the tool", () => {
    expect([clampIntentWidth(0.05), clampIntentWidth(0.3), clampIntentWidth(0.9)]).toEqual([0.2, 0.3, 0.5]);
  });
});
