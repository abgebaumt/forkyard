import { describe, expect, it } from "vitest";
import type { RebaseAction, RebasePlanRow } from "../../core";
import { t } from "../../i18n";
import { chainOldestFirst, checkPlan, combinedMessage, moveItem, payloadRows, planChanged, planSummary, resultCount, rowRoles, splitMessage } from "./model";

const row = (sha: string, action: RebaseAction = "pick", message: string | null = null): RebasePlanRow => ({
  sha,
  summary: `Commit ${sha}`,
  description: "",
  author: { name: "Lena", email: "lena@example.com" },
  authoredAt: "2026-01-01T00:00:00Z",
  action,
  message,
});

describe("rowRoles", () => {
  it("squashes into the next remaining row above, skipping dropped ones", () => {
    const rows = [row("a"), row("b", "drop"), row("c", "squash"), row("d", "squash"), row("e")];
    const roles = rowRoles(rows);
    expect(roles[2]!.target).toBe(0);
    expect(roles[3]!.target).toBe(0);
    expect(roles[0]!.squashed).toEqual([2, 3]);
    expect(roles[4]!.squashed).toEqual([]);
  });
  it("without a remaining row above there is no target", () => {
    expect(rowRoles([row("a", "drop"), row("b", "squash")])[1]!.target).toBeNull();
  });
});

describe("checkPlan", () => {
  const original = [row("a"), row("b"), row("c")];
  it("unchanged is locked", () => {
    expect(checkPlan(original, original).blocked).toBe(t("rebase.check.unchanged"));
  });
  it("the topmost remaining commit must not be squashed", () => {
    const result = checkPlan([row("a", "squash"), row("b"), row("c")], original);
    expect(result.blocked).toBe(t("rebase.check.topSquash"));
    expect(result.rowProblems.has(0)).toBe(true);
  });
  it("dropping everything is locked", () => {
    expect(checkPlan([row("a", "drop"), row("b", "drop"), row("c", "drop")], original).blocked).toBe(t("rebase.check.allDropped"));
  });
  it("reordering alone is a change", () => {
    const moved = [original[1]!, original[0]!, original[2]!];
    expect(planChanged(original, moved)).toBe(true);
    expect(checkPlan(moved, original).blocked).toBeNull();
    expect(planSummary(original, moved)).toBe("Order changed");
  });
});

describe("payloadRows", () => {
  it("keeps messages only for reword and at a group's target", () => {
    const rows = [row("a", "pick", "Ergebnis"), row("b", "squash", "x"), row("c", "pick", "alt"), row("d", "reword", "Neu\n\nText")];
    expect(payloadRows(rows).map((item) => item.message)).toEqual(["Ergebnis", null, null, "Neu\n\nText"]);
    expect(resultCount(rows)).toBe(3);
  });
});

describe("helpers", () => {
  it("moveItem moves to the insertion point", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 2)).toEqual(["a", "b", "c"]);
  });
  it("splitMessage and combinedMessage", () => {
    expect(splitMessage("Titel\n\nZeile 1\nZeile 2\n")).toEqual({ summary: "Titel", description: "Zeile 1\nZeile 2" });
    expect(combinedMessage([{ summary: "Eins", description: "" }, { summary: "Zwei", description: "Mehr" }])).toEqual({ summary: "Eins", description: "Zwei\n\nMehr" });
  });
  it("chainOldestFirst orders a gapless chain, otherwise null", () => {
    expect(chainOldestFirst([{ sha: "c", parents: ["b"] }, { sha: "a", parents: ["root"] }, { sha: "b", parents: ["a"] }])).toEqual(["a", "b", "c"]);
    expect(chainOldestFirst([{ sha: "c", parents: ["x"] }, { sha: "a", parents: ["root"] }])).toBeNull();
    expect(chainOldestFirst([{ sha: "m", parents: ["a", "b"] }, { sha: "a", parents: [] }])).toBeNull();
  });
});
