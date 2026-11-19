import { describe, expect, it } from "vitest";
import type { RebasePlan, RebasePlanRow } from "../../core";
import { t } from "../../i18n";
import type { OkPlan } from "./apply";
import { qk, queryClient } from "../queries";
import { hasDirtyCenter, setCenterGuard } from "../store";
import { editStart, toggleDrop } from "./gestures";
import {
  confirmLeaveGraphEdit,
  enterGraphEdit,
  entryDecision,
  type GraphEdit,
  graphEditOf,
  hasDirtyGraphEdit,
  leaveAllGraphEdits,
  leaveGraphEdit,
  registerEditGuard,
  staleAfter,
  updateGraphEdit,
  useGraphEdit,
} from "./graphEdit";

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
  it("the graph puts the edit's guard back after another view used the centre", async () => {
    queryClient.setQueryData(qk.rebaseBranchPlan("r", null), okPlan(["a", "b"]));
    await expect(enterGraphEdit("r", "t2", { sha: "a" })).resolves.toBe(true);
    updateGraphEdit("t2", (edit) => ({ ...edit, state: toggleDrop(edit.state, "a") }));
    const unmount = registerEditGuard("t2");
    expect(hasDirtyCenter()).toBe(true);
    // The graph leaves the centre; another view registers its own guard and removes it again.
    unmount();
    const other = { dirty: () => false, confirmLeave: async () => true };
    setCenterGuard("t2", other);
    setCenterGuard("t2", null, other);
    expect(hasDirtyCenter()).toBe(false);
    // Back in the graph, the unapplied edit is guarded again.
    registerEditGuard("t2");
    expect(hasDirtyCenter()).toBe(true);
    leaveGraphEdit("t2");
    expect(hasDirtyCenter()).toBe(false);
  });
  it("quit and profile switch still see a dirty edit whose graph is not mounted", async () => {
    queryClient.setQueryData(qk.rebaseBranchPlan("r", null), okPlan(["a", "b"]));
    await enterGraphEdit("r", "t3", { sha: "a" });
    const unmount = registerEditGuard("t3");
    expect(hasDirtyGraphEdit()).toBe(false);
    updateGraphEdit("t3", (edit) => ({ ...edit, state: toggleDrop(edit.state, "b") }));
    // Tab switch: the graph unmounts and its guard leaves the centre slot.
    unmount();
    expect(hasDirtyCenter()).toBe(false);
    expect(hasDirtyGraphEdit()).toBe(true);
    leaveAllGraphEdits();
    expect(hasDirtyGraphEdit()).toBe(false);
    expect(graphEditOf("t3")).toBeNull();
  });
});
