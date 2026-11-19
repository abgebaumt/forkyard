import { describe, expect, it } from "vitest";
import type { RebasePlan, RebasePlanRow } from "../../core";
import { t } from "../../i18n";
import type { OkPlan } from "./apply";
import { editStart } from "./gestures";
import { confirmLeaveGraphEdit, entryDecision, type GraphEdit, graphEditOf, staleAfter, useGraphEdit } from "./graphEdit";

const row = (sha: string): RebasePlanRow => ({
  sha,
  summary: `Änderung ${sha}`,
  description: "",
  author: { name: "Jürgen Weiß", email: "juergen@example.com" },
  authoredAt: "2026-01-01T00:00:00Z",
  action: "pick",
  message: null,
});

const okPlan = (shas: string[], base = "base"): OkPlan => ({
  status: "ok",
  branch: "feature/übung",
  base,
  rows: shas.map(row),
  rewritesPushed: false,
  dependentBranches: [],
});

const refused = (reason: Extract<RebasePlan, { status: "refused" }>["reason"]): RebasePlan => ({
  status: "refused",
  reason,
  detail: null,
  message: `Abgelehnt: ${reason}`,
});

const editOf = (plan: OkPlan): GraphEdit => ({ repoId: "r", from: null, plan, state: editStart(plan.rows), drag: null, updateRefs: false });

describe("graph edit", () => {
  it("enters for a commit in the range, refuses with reason, or names the range", () => {
    expect(entryDecision(okPlan(["a", "b"]), "a")).toEqual({ kind: "enter" });
    expect(entryDecision(okPlan(["a", "b"]), null)).toEqual({ kind: "enter" });
    expect(entryDecision(okPlan(["a", "b"]), "z")).toEqual({ kind: "notInRange" });
    expect(entryDecision(refused("dirty_worktree"), "a")).toMatchObject({ kind: "refused", stash: true });
    expect(entryDecision(refused("merge_commits"), "a")).toMatchObject({
      kind: "refused",
      stash: false,
      title: t("rebase.refused.mergeCommits"),
    });
  });
  it("a changed plan ends the edit, a dirty worktree does not", () => {
    const edit = editOf(okPlan(["a", "b"]));
    expect(staleAfter(edit, okPlan(["a", "b"]))).toBe(false);
    expect(staleAfter(edit, undefined)).toBe(false);
    expect(staleAfter(edit, okPlan(["a", "b", "c"]))).toBe(true);
    expect(staleAfter(edit, okPlan(["a", "b"], "other-base"))).toBe(true);
    expect(staleAfter(edit, refused("dirty_worktree"))).toBe(false);
    expect(staleAfter(edit, refused("operation_in_progress"))).toBe(true);
  });
  it("leaving without changes needs no question", async () => {
    useGraphEdit.setState({ byTab: { t1: editOf(okPlan(["a"])) } });
    await expect(confirmLeaveGraphEdit("t1")).resolves.toBe(true);
    expect(graphEditOf("t1")).toBeNull();
  });
});
