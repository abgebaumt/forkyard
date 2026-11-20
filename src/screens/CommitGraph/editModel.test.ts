import { describe, expect, it } from "vitest";
import type { PreviewState } from "../../app/conflictPreview";
import type { GraphRow, RebaseAction, RebasePlanRow } from "../../core";
import { editStart } from "../../app/rebasePlan/gestures";
import { editMessage, hiddenCount, previewStep, takenOverDrag } from "./editModel";
import { QUIET_WIP } from "./model";

const wip = (): GraphRow => ({ ...QUIET_WIP, wipCount: 1 });
const c = (sha: string): GraphRow => ({ ...QUIET_WIP, id: sha, kind: "commit", sha });
const row = (sha: string, action: RebaseAction): RebasePlanRow => ({
  sha,
  summary: `Änderung ${sha}`,
  description: "",
  author: { name: "Jürgen", email: "j@example.org" },
  authoredAt: "2026-11-19T10:00:00Z",
  action,
  message: null,
});
const pick = (sha: string) => row(sha, "pick");
const drop = (sha: string) => row(sha, "drop");

describe("the edit view model", () => {
  it("counts the loaded rows of other branches between range and base", () => {
    const rows = [wip(), c("a"), c("x"), c("b"), c("y"), c("z"), c("base"), c("q")];
    expect(hiddenCount(rows, new Set(["a", "b"]), "base")).toBe(3);
    expect(hiddenCount(rows.slice(0, 5), new Set(["a", "b"]), "base")).toBe(2); // base not loaded yet
  });

  it("names the step and file of the first conflict", () => {
    const preview: PreviewState = { state: "done", result: { status: "conflicts", files: ["datei.ts"], atCommit: "c3" } };
    expect(previewStep(preview, [pick("c1"), drop("c2"), pick("c4"), pick("c3")])).toEqual({ step: 3, file: "datei.ts" });
    expect(previewStep({ state: "done", result: { status: "clean" } }, [])).toBeNull();
  });

  it("edits a message: a group root keeps its action, a plain row becomes a reword or a pick again", () => {
    const group = editStart([pick("a"), row("b", "squash"), pick("c")]);
    expect(editMessage(group, "a", "Zusammengefasst").rows[0]).toMatchObject({ action: "pick", message: "Zusammengefasst" });
    const reworded = editMessage(group, "c", "Änderung c\n\nNeuer Text");
    expect(reworded.rows[2]).toMatchObject({ action: "reword", message: "Änderung c\n\nNeuer Text" });
    expect(editMessage(reworded, "c", "Änderung c").rows[2]).toMatchObject({ action: "pick", message: null });
    expect(editMessage(group, "b", "egal")).toBe(group);
  });
});

describe("a drag handed over from a graph row", () => {
  const rows = [pick("a"), pick("b"), pick("c")];
  const drag = { sha: "a", pointerId: 3, clientX: 10, clientY: 20 };
  it("continues on the row's displayed position (newest on top)", () => {
    expect(takenOverDrag(drag, rows)).toEqual({ index: 2, pointerId: 3, clientX: 10, clientY: 20 });
  });
  it("is dropped when the pointer went up while the plan loaded, or the row is not in the plan", () => {
    expect(takenOverDrag({ ...drag, released: true }, rows)).toBeNull();
    expect(takenOverDrag({ ...drag, sha: "z" }, rows)).toBeNull();
    expect(takenOverDrag(null, rows)).toBeNull();
  });
});
