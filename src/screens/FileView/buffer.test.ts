import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { bufferFrom, isDirty, majorityEol, normalizeEol } from "./buffer";

describe("line endings in the editor state", () => {
  it("normalises “\\r\\n” and keeps a single “\\r”", () => {
    expect(normalizeEol("a\r\nb\nc\r\n")).toBe("a\nb\nc\n");
    expect(normalizeEol("fortschritt: 10%\r20%\r30%;ok\nende\n")).toBe("fortschritt: 10%\r20%\r30%;ok\nende\n");
  });

  it("a document that only splits at “\\n” returns single “\\r” unchanged", () => {
    const text = "spalte;wert\nfortschritt: 10%\r20%\r30%;ok\nende\n";
    const state = EditorState.create({ doc: text, extensions: EditorState.lineSeparator.of("\n") });
    expect(state.doc.lines).toBe(4);
    const typed = state.update({ changes: { from: 0, insert: "X" } }).state;
    expect(typed.doc.toString()).toBe(`X${text}`);
    // For comparison: without the option every “\r” would be a line ending – and would come back as “\n”.
    expect(EditorState.create({ doc: text }).doc.toString()).toBe(text.replace(/\r/g, "\n"));
  });

  it("counts the more frequent kind and detects unsaved content", () => {
    expect(majorityEol("a\r\nb\r\nc\n")).toBe("crlf");
    expect(majorityEol("a\nb\n")).toBe("lf");
    const buffer = bufferFrom("r|datei", { text: "a\r\nb\rc\r\n", encoding: "utf-8", eol: "crlf" } as never);
    expect(buffer.base).toBe("a\nb\rc\n");
    expect(isDirty(buffer)).toBe(false);
    expect(isDirty({ ...buffer, text: `${buffer.base}x` })).toBe(true);
  });
});
