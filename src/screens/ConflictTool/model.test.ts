import { describe, expect, it } from "vitest";
import {
  buildModel,
  baseColumn,
  buildRows,
  chunkText,
  diffLines,
  emptyChoice,
  finalizeText,
  markerLines,
  resolveMarkers,
  splitText,
  toggleLine,
  toggleSide,
  worktreeMatches,
  type Choice,
  type MergeModel,
} from "./model";

const labels = { ours: "main", theirs: "feature" };
const text = (model: MergeModel, choices: Map<number, Choice> = new Map()) =>
  model.chunks
    .map((chunk) => chunkText(chunk, choices.get(chunk.id) ?? (chunk.kind === "conflict" ? emptyChoice(chunk) : null), labels))
    .join("");

describe("buildModel", () => {
  const base = "a\nb\nc\nd\ne\nf\ng\n";
  const ours = "a\nB1\nc\nd\ne\nf\nG\n";
  const theirs = "a\nB2\nc\nD\ne\nf\ng\n";

  it("separates conflict, one-sided changes and unchanged parts", () => {
    const model = buildModel(base, ours, theirs);
    expect(model.chunks.map((chunk) => [chunk.kind, chunk.from, chunk.ours, chunk.theirs])).toEqual([
      ["same", null, ["a"], ["a"]],
      ["conflict", null, ["B1"], ["B2"]],
      ["same", null, ["c"], ["c"]],
      ["auto", "theirs", ["d"], ["D"]],
      ["same", null, ["e", "f"], ["e", "f"]],
      ["auto", "ours", ["G"], ["g"]],
    ]);
    expect(model.conflicts).toEqual([1]);
    expect(text(model)).toBe("a\n<<<<<<< main\nB1\n=======\nB2\n>>>>>>> feature\nc\nD\ne\nf\nG\n");
  });

  it("both sides in the chosen order, single lines", () => {
    const model = buildModel("x\n1\ny\n", "x\no1\no2\ny\n", "x\nt1\ny\n");
    const chunk = model.chunks[model.conflicts[0]!]!;
    let choice = toggleSide(chunk, emptyChoice(chunk), "theirs", true);
    choice = toggleSide(chunk, choice, "ours", true);
    expect(chunkText(chunk, choice, labels)).toBe("t1\no1\no2\n");
    choice = toggleLine(chunk, choice, "ours", 0, false);
    expect(chunkText(chunk, choice, labels)).toBe("t1\no2\n");
    choice = toggleLine(chunk, choice, "theirs", 0, false);
    choice = toggleLine(chunk, choice, "ours", 1, false);
    expect(choice.order).toEqual([]);
    expect(chunkText(chunk, choice, labels)).toContain("<<<<<<< main");
  });

  it("the same change on both sides is not a conflict", () => {
    const model = buildModel("a\nb\n", "a\nX\n", "a\nX\n");
    expect(model.conflicts).toEqual([]);
    expect(text(model)).toBe("a\nX\n");
  });

  it("without an ancestor: common parts stay, differences become conflicts", () => {
    const model = buildModel(null, "kopf\neins\nmitte\nzwei\nende\n", "kopf\nEINS\nmitte\nZWEI\nende\n");
    expect(model.conflicts.length).toBe(2);
    expect(model.chunks.filter((chunk) => chunk.kind === "same").map((chunk) => chunk.ours)).toEqual([["kopf"], ["mitte"], ["ende"]]);
  });

  it("CRLF and a missing newline at the end are preserved", () => {
    // Directly adjacent changes collide (as in Git) – that is why there is a line in between.
    const model = buildModel("a\r\nb\r\nx\r\nc", "a\r\nB\r\nx\r\nc", "a\r\nb\r\nx\r\nC");
    expect(model.eol).toBe("crlf");
    expect(model.finalNewline).toBe(false);
    expect(model.conflicts).toEqual([]);
    expect(finalizeText(text(model), model)).toBe("a\r\nB\r\nx\r\nC");
  });

  it("splitText", () => {
    expect(splitText("")).toEqual({ lines: [], finalNewline: false });
    expect(splitText("a\r\nb\r\n")).toEqual({ lines: ["a", "b"], finalNewline: true });
  });

  it("rows of the side-by-side view have equal height per block", () => {
    const model = buildModel("x\n1\ny\n", "x\no1\no2\ny\n", "x\nt1\ny\n");
    const { rows, chunkStart } = buildRows(model);
    expect(rows.map((row) => (row.type === "head" ? "head" : `${row.ours?.text ?? "-"}|${row.theirs?.text ?? "-"}`))).toEqual([
      "x|x",
      "head",
      "o1|t1",
      "o2|-",
      "y|y",
    ]);
    expect(chunkStart).toEqual([0, 1, 4]);
    expect(rows[3]).toEqual({ type: "line", chunk: 1, ours: { line: 2, offset: 1, text: "o2" }, base: null, theirs: null });
  });
});

describe("markerLines", () => {
  it("finds markers, ignores known lines", () => {
    const known = new Set(["======="]);
    expect(markerLines("a\n<<<<<<< x\nb\n=======\nc\n>>>>>>> y\n", new Set())).toEqual([2, 4, 6]);
    expect(markerLines("Titel\n=======\n", known)).toEqual([]);
    expect(markerLines("<<<<<<<<\n", new Set())).toEqual([]);
  });
});

describe("diffLines", () => {
  const apply = (a: string[], b: string[]) => {
    const out: string[] = [];
    let position = 0;
    for (const edit of diffLines(a, b)) {
      out.push(...a.slice(position, edit.aStart), ...b.slice(edit.bStart, edit.bStart + edit.bLength));
      position = edit.aStart + edit.aLength;
    }
    out.push(...a.slice(position));
    return out;
  };

  it("returns changes that turn a into b", () => {
    const cases: [string[], string[]][] = [
      [[], []],
      [[], ["x"]],
      [["x"], []],
      [
        ["a", "b", "c"],
        ["a", "c"],
      ],
      [
        ["a", "b", "c"],
        ["a", "x", "y", "c", "d"],
      ],
      [
        ["", "", "a", "", ""],
        ["", "a", "", "", "b", ""],
      ],
      [
        ["x", "x", "x", "x"],
        ["x", "x", "y", "x", "x", "x"],
      ],
      [
        ["1", "2", "3", "4", "5"],
        ["5", "4", "3", "2", "1"],
      ],
    ];
    for (const [a, b] of cases) expect(apply(a, b)).toEqual(b);
  });

  it("stays fast with 130 000 lines and few changes", () => {
    const a = Array.from({ length: 130_000 }, (_, index) => `Zeile ${index}`);
    const b = a.slice();
    b[10] = "anders";
    b.splice(60_000, 2);
    b[120_000] = "auch anders";
    const started = performance.now();
    const edits = diffLines(a, b);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(edits).toEqual([
      { aStart: 10, aLength: 1, bStart: 10, bLength: 1 },
      { aStart: 60_000, aLength: 2, bStart: 60_000, bLength: 0 },
      { aStart: 120_002, aLength: 1, bStart: 120_000, bLength: 1 },
    ]);
    const model = buildModel(a.join("\n"), a.join("\n").replace("Zeile 10\n", "ours\n"), b.join("\n"));
    expect(model.conflicts.length).toBe(1);
  });
});

describe("comparison with the file in the working directory", () => {
  const model = buildModel("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n");
  it("resolves markers in favour of one side, also in diff3 style", () => {
    const merged = "a\n<<<<<<< HEAD\nB1\n||||||| basis\nb\n=======\nB2\n>>>>>>> feature\nc\n";
    expect(resolveMarkers(merged, "ours")).toBe("a\nB1\nc");
    expect(resolveMarkers(merged, "theirs")).toBe("a\nB2\nc");
    expect(resolveMarkers("a\n<<<<<<< HEAD\nB1\n", "ours")).toBeNull();
    expect(worktreeMatches(model, merged)).toBe(true);
  });
  it("detects a file edited by hand", () => {
    expect(worktreeMatches(model, "a\nganz anders\nc\n")).toBe(false);
    expect(worktreeMatches(model, null)).toBe(true);
  });
});

describe("base column", () => {
  it("every block carries its lines of the common ancestor", () => {
    const model = buildModel("a\nb\nc\nd\ne\nf\ng\n", "a\nB1\nc\nd\ne\nf\nG\n", "a\nB2\nc\nD\ne\nf\ng\n");
    expect(model.chunks.map((chunk) => [chunk.kind, chunk.base, chunk.baseStart])).toEqual([
      ["same", ["a"], 0],
      ["conflict", ["b"], 1],
      ["same", ["c"], 2],
      ["auto", ["d"], 3],
      ["same", ["e", "f"], 4],
      ["auto", ["g"], 6],
    ]);
  });

  it("three columns: a block is as tall as the longest of base, ours and theirs", () => {
    const model = buildModel("x\n1\n2\n3\ny\n", "x\nö1\ny\n", "x\nt1\nt2\ny\n");
    const id = model.conflicts[0]!;
    expect(model.chunks[id]!.base).toEqual(["1", "2", "3"]);
    const { rows, chunkStart } = buildRows(model, true);
    const block = rows.slice(chunkStart[id]!, chunkStart[id + 1]);
    expect(block.map((row) => row.type)).toEqual(["head", "line", "line", "line"]);
    expect(block[3]).toEqual({ type: "line", chunk: id, ours: null, base: { line: 3, offset: 2, text: "3" }, theirs: null });
    // Without the base the same block has the height of the longer side only.
    expect(buildRows(model, false).rows.filter((row) => row.type === "line" && row.chunk === id)).toHaveLength(2);
  });

  it("both sides added lines where the ancestor had none: the base side is empty", () => {
    const model = buildModel("x\ny\n", "x\nNeue Zeile\ny\n", "x\nÄnderung\ny\n");
    const id = model.conflicts[0]!;
    expect(model.chunks[id]!.base).toEqual([]);
    const lines = buildRows(model, true).rows.filter((row) => row.type === "line" && row.chunk === id);
    expect(lines).toHaveLength(1);
    expect(lines.every((row) => row.type === "line" && row.base === null)).toBe(true);
  });

  it("a conflict split along shared lines keeps its whole base on the first piece", () => {
    const model = buildModel("k\n1\nm\n", "k\nA\nGleiche Zeile\nB\nm\n", "k\nC\nGleiche Zeile\nD\nm\n");
    expect(model.chunks.map((chunk) => [chunk.kind, chunk.base])).toEqual([
      ["same", ["k"]],
      ["conflict", ["1"]],
      ["same", []],
      ["conflict", []],
      ["same", ["m"]],
    ]);
  });

  it("lines both sides deleted do not stretch or misalign the base column", () => {
    const model = buildModel("a\nb\nc\n", "a\nc\n", "a\nc\n");
    expect(model.chunks).toHaveLength(1);
    const plain = buildRows(model).rows;
    const withBase = buildRows(model, true).rows;
    expect(withBase).toEqual(plain.map((row) => (row.type === "line" ? { ...row, base: row.ours } : row)));
    expect(withBase).toHaveLength(2);
  });

  it("without an ancestor every block has an empty base", () => {
    const model = buildModel(null, "a\nb\n", "a\nc\n");
    expect(model.hasBase).toBe(false);
    expect(model.chunks.every((chunk) => chunk.base.length === 0)).toBe(true);
  });

  it("the base does not change the blocks, also when a both-deleted block drops out", () => {
    const model = buildModel("a\nb\nc\nd\n", "a\nc\nD1\n", "a\nc\nD2\n");
    expect(model.chunks.map((chunk) => [chunk.kind, chunk.ours, chunk.theirs])).toEqual([
      ["same", ["a", "c"], ["a", "c"]],
      ["conflict", ["D1"], ["D2"]],
    ]);
  });

  it("the base does not change the blocks", () => {
    // Same chunk boundaries as before the base existed: sessions saved by older builds still fit.
    const model = buildModel("a\nb\nc\nd\ne\nf\ng\n", "a\nB1\nc\nd\ne\nf\nG\n", "a\nB2\nc\nD\ne\nf\ng\n");
    expect(model.chunks.map((chunk) => [chunk.ours, chunk.theirs])).toEqual([
      [["a"], ["a"]],
      [["B1"], ["B2"]],
      [["c"], ["c"]],
      [["d"], ["D"]],
      [
        ["e", "f"],
        ["e", "f"],
      ],
      [["G"], ["g"]],
    ]);
  });

  it("baseColumn says when and why the base cannot be shown", () => {
    expect(baseColumn({ setting: true, hasBase: true, wide: true })).toEqual({ shown: true, disabled: null });
    expect(baseColumn({ setting: false, hasBase: true, wide: true })).toEqual({ shown: false, disabled: null });
    expect(baseColumn({ setting: true, hasBase: false, wide: true })).toEqual({ shown: false, disabled: "noBase" });
    expect(baseColumn({ setting: true, hasBase: true, wide: false })).toEqual({ shown: false, disabled: "narrow" });
  });
});
