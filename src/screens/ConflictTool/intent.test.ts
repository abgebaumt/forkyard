import { describe, expect, it } from "vitest";
import type { ConflictIntent, ConflictIntentBlock } from "../../core";
import { blockNote, canApply, clampIntentWidth, conflictRanges, hasChange, intentReducer, suggestionDiff, type IntentState } from "./intent";
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

describe("Apply replaces exactly one block (spec 6.1)", () => {
  const model = buildModel("kopf\neins\nmitte\nzwei\nende\n", "kopf\nEINS main\nmitte\nZWEI main\nende\n", "kopf\neins feature\nmitte\nZWEI feature\nende\n");
  const chunks = ["kopf\n", "<<<<<<< main\nEINS main\n=======\neins feature\n>>>>>>> feature\n", "mitte\n", "<<<<<<< main\nZWEI main\n=======\nZWEI feature\n>>>>>>> feature\n", "ende\n"];
  const boundsOf = (parts: string[]) => parts.reduce<number[]>((out, part) => [...out, out[out.length - 1]! + part.length], [0]);

  it("starts from what the tool shows: markers in both conflicts", () => {
    expect(model.chunks.map((chunk) => chunkText(chunk, chunk.kind === "conflict" ? emptyChoice(chunk) : null, labels))).toEqual(chunks);
  });

  it("moves only the bounds after the block; the other blocks keep their text", () => {
    const proposal = "EINS feature\nzusatz\n";
    const after = [chunks[0]!, proposal, chunks[2]!, chunks[3]!, chunks[4]!];
    expect(shiftBounds(boundsOf(chunks), [{ chunk: 1, text: proposal }])).toEqual(boundsOf(after));
    expect(shiftBounds(boundsOf(chunks), [{ chunk: 3, text: "" }, { chunk: 1, text: proposal }]), "unsorted changes").toEqual(boundsOf([chunks[0]!, proposal, chunks[2]!, "", chunks[4]!]));
  });

  it("makes the block count as edited by hand and resolved; the other conflict stays open", () => {
    const manual = manualOf([chunks[0]!, "EINS feature\n", chunks[2]!, chunks[3]!, chunks[4]!], chunks);
    expect(manual).toEqual([null, "EINS feature\n", null, null, null]);
    expect(isResolved(emptyChoice(model.chunks[1]!), manual[1] ?? null, model.knownMarkerLines)).toBe(true);
    expect(isResolved(emptyChoice(model.chunks[3]!), manual[3] ?? null, model.knownMarkerLines)).toBe(false);
  });
});

describe("blocks that may be applied", () => {
  const block = (patch: Partial<ConflictIntentBlock>): ConflictIntentBlock => ({ block: 0, sent: "full", oursWhy: "a", theirsWhy: "b", text: "x\n", ...patch });

  it("only complete blocks with a proposal", () => {
    expect(canApply(block({}))).toBe(true);
    expect(canApply(block({ text: null }))).toBe(false);
    expect(canApply(block({ sent: "shortened", text: null }))).toBe(false);
    expect([block({}), block({ sent: "shortened" }), block({ sent: "redacted" }), block({ sent: "left_out" })].map(blockNote)).toEqual([null, "shortened", "redacted", "leftOut"]);
  });
});

describe("the request state", () => {
  const intent: ConflictIntent = { path: "a.txt", blocks: [{ block: 0, sent: "full", oursWhy: "a", theirsWhy: "b", text: "x\n" }] };
  const idle: IntentState = { kind: "idle" };

  it("goes preparing → loading → ready and drops answers of cancelled or older jobs", () => {
    const preparing = intentReducer(idle, { type: "start", at: 1000 });
    expect(preparing).toEqual({ kind: "preparing", startedAt: 1000 });
    const loading = intentReducer(preparing, { type: "sending", jobId: "j1" });
    expect(loading).toEqual({ kind: "loading", startedAt: 1000, jobId: "j1" });
    expect(intentReducer(loading, { type: "answer", jobId: "j0", intent })).toBe(loading);
    const ready = intentReducer(loading, { type: "answer", jobId: "j1", intent });
    expect(ready).toEqual({ kind: "ready", intent, decisions: {} });
    const cancelled = intentReducer(loading, { type: "cancel" });
    expect(cancelled).toEqual(idle);
    expect(intentReducer(cancelled, { type: "answer", jobId: "j1", intent }), "no half results after cancel").toBe(cancelled);
  });

  it("shows errors, but a cancelled request just goes back", () => {
    const loading = intentReducer(intentReducer(idle, { type: "start", at: 0 }), { type: "sending", jobId: "j1" });
    expect(intentReducer(loading, { type: "failed", jobId: "j1", view: { kind: "invalid", text: "Answer unusable" } })).toEqual({ kind: "error", view: { kind: "invalid", text: "Answer unusable" } });
    expect(intentReducer(loading, { type: "failed", jobId: "j1", view: { kind: "cancelled" } })).toEqual(idle);
    expect(intentReducer(loading, { type: "failed", jobId: "j9", view: { kind: "other", text: "x" } })).toBe(loading);
    const preparing = intentReducer(idle, { type: "start", at: 0 });
    expect(intentReducer(preparing, { type: "failed", jobId: null, view: { kind: "other", text: "x" } }).kind).toBe("error");
  });

  it("remembers Apply and Discard per block", () => {
    const ready: IntentState = { kind: "ready", intent, decisions: {} };
    const taken = intentReducer(ready, { type: "decide", block: 0, decision: "taken" });
    expect(taken).toEqual({ kind: "ready", intent, decisions: { 0: "taken" } });
    expect(intentReducer(idle, { type: "decide", block: 0, decision: "taken" })).toBe(idle);
  });
});

describe("the column width", () => {
  it("stays between a fifth and half of the tool", () => {
    expect([clampIntentWidth(0.05), clampIntentWidth(0.3), clampIntentWidth(0.9)]).toEqual([0.2, 0.3, 0.5]);
  });
});
