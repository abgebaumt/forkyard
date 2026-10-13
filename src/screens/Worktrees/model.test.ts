import { describe, expect, it } from "vitest";
import type { Worktree } from "../../core";
import { patternProblem } from "../../app/actions/lfs";
import { removeBlock, samePath } from "../../app/actions/worktrees";
import { t } from "../../i18n";
import { branchBlock, describeWorktree, matchesWorktree, suggestFolder, worktreeSecondary } from "./model";

const tree = (patch: Partial<Worktree>): Worktree => ({
  path: "C:\\arbeit\\messnetz-karte",
  branch: "feature/karte",
  head: "abcdef1234567890abcdef1234567890abcdef12",
  isMain: false,
  isCurrent: false,
  isLocked: false,
  lockReason: null,
  isPrunable: false,
  hasChanges: false,
  ...patch,
});

describe("worktree: row", () => {
  it("states branch and properties as words", () => {
    expect(worktreeSecondary(tree({}))).toBe("feature/karte");
    expect(worktreeSecondary(tree({ isMain: true, branch: "main", hasChanges: true }))).toBe("main · main folder · changed");
    expect(worktreeSecondary(tree({ branch: null }))).toBe("detached · abcdef1");
    expect(worktreeSecondary(tree({ isLocked: true }))).toBe("feature/karte · locked");
    expect(worktreeSecondary(tree({ isPrunable: true }))).toBe("folder missing · orphaned");
  });
  it("tells screen readers what the check mark and the lock mean", () => {
    expect(describeWorktree(tree({ isCurrent: true, isMain: true, branch: "main", path: "C:\\arbeit\\messnetz" }))).toBe("Worktree messnetz, branch main, main folder, open in this tab");
    expect(describeWorktree(tree({ isLocked: true, lockReason: "USB-Stick" }))).toBe("Worktree messnetz-karte, branch feature/karte, locked: USB-Stick");
  });
  it("filters by path and branch", () => {
    expect(matchesWorktree(tree({}), "KARTE")).toBe(true);
    expect(matchesWorktree(tree({ branch: null }), "feature")).toBe(false);
    expect(matchesWorktree(tree({}), "")).toBe(true);
  });
});

describe("worktree: suggestion and locking", () => {
  it("builds the folder name from repository and target", () => {
    expect(suggestFolder("messnetz", "feature/karte neu")).toBe("messnetz-feature-karte-neu");
    expect(suggestFolder("messnetz", "origin/main")).toBe("messnetz-origin-main");
    expect(suggestFolder("messnetz", "")).toBe("");
    expect(suggestFolder("", "v1.0")).toBe("worktree-v1.0");
  });
  it("says why a branch or worktree is not possible right now", () => {
    expect(branchBlock({ isHead: true, worktreePath: null })).toBe("checked out here");
    expect(branchBlock({ isHead: false, worktreePath: "C:\\x" })).toBe("in another worktree");
    expect(branchBlock({ isHead: false, worktreePath: null })).toBeNull();
    expect(removeBlock(tree({ isMain: true }))).toBe(t("actions.worktrees.block.main"));
    expect(removeBlock(tree({ isCurrent: true }))).toBe(t("actions.worktrees.block.current"));
    expect(removeBlock(tree({ isLocked: true }))).toBe(t("actions.worktrees.block.locked"));
    expect(removeBlock(tree({}))).toBeNull();
  });
  it("compares paths regardless of separators and – on Windows – case", () => {
    expect(samePath("C:\\Arbeit\\Messnetz\\", "c:/arbeit/messnetz")).toBe(true);
    expect(samePath("/home/lena/Messnetz", "/home/lena/messnetz")).toBe(false);
    expect(samePath("/home/lena/messnetz/", "/home/lena/messnetz")).toBe(true);
  });
});

describe("LFS: checking patterns", () => {
  it("lets common patterns through", () => {
    expect(patternProblem("*.psd", [])).toBeNull();
    expect(patternProblem("bilder/**", ["*.psd"])).toBeNull();
  });
  it("names the reason for patterns that are unsuitable", () => {
    expect(patternProblem("  ", [])).toBe(t("actions.lfs.pattern.empty"));
    expect(patternProblem("*", [])).toBe(t("actions.lfs.pattern.everything"));
    expect(patternProblem("#x", [])).toBe(t("actions.lfs.pattern.comment"));
    expect(patternProblem("!x.bin", [])).toBe(t("actions.lfs.pattern.negation"));
    expect(patternProblem("*.psd", ["*.psd"])).toBe(t("actions.lfs.pattern.exists", { pattern: "*.psd" }));
  });
});
