import { describe, expect, it } from "vitest";
import type { RebasePlanRow } from "../../core";
import { changeCount, editStart, moveDisplayed, rewordSummary, rowChip, setMessage, squashOnto, todoLines, toggleDrop } from "./gestures";

const rows = (...shas: string[]): RebasePlanRow[] =>
  shas.map((sha) => ({
    sha,
    summary: sha,
    description: sha === "c3" ? "Körper" : "",
    author: { name: "Jürgen Weiß", email: "juergen@example.com" },
    authoredAt: "2026-01-01T00:00:00Z",
    action: "pick",
    message: null,
  }));

const original = rows("c1", "c2", "c3", "c4", "c5");
const start = editStart(original);

describe("rebase plan gestures", () => {
  it("dragging a row to a new place reorders the todo", () => {
    const next = moveDisplayed(editStart(rows("c1", "c2", "c3", "c4", "c5")), 0, 4); // c5 above c1
    expect(todoLines(next.rows)).toEqual(["pick c1", "pick c5", "pick c2", "pick c3", "pick c4"]);
    expect(rowChip(next, original, "c5")).toBe("moved");
    expect(rowChip(next, original, "c2")).toBeNull();
  });
  it("dropping a row onto another squashes it into that one", () => {
    expect(todoLines(squashOnto(start, "c4", "c1", false).rows)).toEqual(["pick c1", "squash c4", "pick c2", "pick c3", "pick c5"]);
  });
  it("with Alt it is a fixup", () => {
    expect(todoLines(squashOnto(start, "c2", "c5", true).rows)).toEqual(["pick c1", "pick c3", "pick c4", "pick c5", "fixup c2"]);
  });
  it("onto a member joins its group, onto itself or a dropped row changes nothing", () => {
    const grouped = squashOnto(start, "c4", "c1", false);
    expect(todoLines(squashOnto(grouped, "c3", "c4", false).rows)).toEqual(["pick c1", "squash c4", "squash c3", "pick c2", "pick c5"]);
    expect(squashOnto(start, "c2", "c2", false)).toBe(start);
    expect(squashOnto(toggleDrop(start, "c1"), "c2", "c1", false).rows).toEqual(toggleDrop(start, "c1").rows);
  });
  it("a row already in the group stays in place and only switches between squash and fixup", () => {
    const grouped = squashOnto(squashOnto(start, "c4", "c1", false), "c3", "c4", false); // pick c1, squash c4, squash c3, pick c2, pick c5
    expect(squashOnto(grouped, "c3", "c1", false)).toBe(grouped);
    expect(squashOnto(grouped, "c4", "c1", false)).toBe(grouped);
    expect(todoLines(squashOnto(grouped, "c3", "c4", true).rows)).toEqual(["pick c1", "squash c4", "fixup c3", "pick c2", "pick c5"]);
  });
  it("folding a group root carries its members along", () => {
    let grouped = squashOnto(start, "c4", "c1", false);
    grouped = squashOnto(grouped, "c3", "c4", true); // pick c1, squash c4, fixup c3, pick c2, pick c5
    expect(todoLines(squashOnto(grouped, "c1", "c5", false).rows)).toEqual(["pick c2", "pick c5", "squash c1", "squash c4", "fixup c3"]);
    expect(todoLines(squashOnto(grouped, "c1", "c2", true).rows)).toEqual(["pick c2", "fixup c1", "squash c4", "fixup c3", "pick c5"]);
  });
  it("Del drops and Del again picks", () => {
    const dropped = toggleDrop(start, "c2");
    expect(todoLines(dropped.rows)[1]).toBe("drop c2");
    expect(todoLines(toggleDrop(dropped, "c2").rows)[1]).toBe("pick c2");
  });
  it("inline reword keeps the description; the old summary is a pick again", () => {
    const next = rewordSummary(start, "c3", "Neu: Übersicht");
    expect(next.rows[2]).toMatchObject({ action: "reword", message: "Neu: Übersicht\n\nKörper" });
    expect(rewordSummary(next, "c3", "c3").rows[2]).toMatchObject({ action: "pick", message: null });
  });
  it("confirming the unchanged summary keeps squash and drop, and turns a reword back to pick", () => {
    const squashed = squashOnto(start, "c4", "c1", false);
    expect(rewordSummary(squashed, "c4", "c4")).toBe(squashed);
    const dropped = toggleDrop(start, "c2");
    expect(rewordSummary(dropped, "c2", "c2").rows[1]!.action).toBe("drop");
  });
  it("rewording a pick with a group result message keeps that message's description", () => {
    const grouped = setMessage(squashOnto(start, "c4", "c1", false), "c1", "Gruppe\n\nAlles zusammen");
    expect(rewordSummary(grouped, "c1", "Neu").rows[0]).toMatchObject({ action: "reword", message: "Neu\n\nAlles zusammen" });
  });
  it("combined gesture gives the todo of the Rust oracle", () => {
    let s = squashOnto(start, "c4", "c1", false);
    s = squashOnto(s, "c2", "c5", true);
    s = moveDisplayed(s, 2, 0); // c3 to the top
    s = toggleDrop(s, "c3");
    expect(todoLines(s.rows)).toEqual(["pick c1", "squash c4", "pick c5", "fixup c2", "drop c3"]);
    expect(changeCount(s, original)).toBe(4);
  });
});
