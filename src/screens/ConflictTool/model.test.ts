import { describe, expect, it } from "vitest";
import { buildModel, buildRows, chunkText, diffLines, emptyChoice, finalizeText, markerLines, resolveMarkers, splitText, toggleLine, toggleSide, worktreeMatches, type Choice, type MergeModel } from "./model";

const labels = { ours: "main", theirs: "feature" };
const text = (model: MergeModel, choices: Map<number, Choice> = new Map()) =>
  model.chunks.map((chunk) => chunkText(chunk, choices.get(chunk.id) ?? (chunk.kind === "conflict" ? emptyChoice(chunk) : null), labels)).join("");

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
    expect(rows.map((row) => (row.type === "head" ? "head" : `${row.ours?.text ?? "-"}|${row.theirs?.text ?? "-"}`))).toEqual(["x|x", "head", "o1|t1", "o2|-", "y|y"]);
    expect(chunkStart).toEqual([0, 1, 4]);
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
      [["a", "b", "c"], ["a", "c"]],
      [["a", "b", "c"], ["a", "x", "y", "c", "d"]],
      [["", "", "a", "", ""], ["", "a", "", "", "b", ""]],
      [["x", "x", "x", "x"], ["x", "x", "y", "x", "x", "x"]],
      [["1", "2", "3", "4", "5"], ["5", "4", "3", "2", "1"]],
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
