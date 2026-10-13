/** Pure functions for worktrees: row texts, filter, folder name suggestion. No React, no core. */
import type { Ref, Worktree } from "../../core";
import { folderName, worktreeTarget } from "../../app/actions/worktrees";
import { shortSha } from "../../app/format";
import { t } from "../../i18n";

/** Second line: what is checked out, followed by the properties as words. */
export function worktreeSecondary(worktree: Worktree): string {
  if (worktree.isPrunable) return worktree.isLocked ? t("worktrees.row.missingLocked") : t("worktrees.row.missingOrphaned");
  const parts = [worktree.branch ?? (worktree.head ? t("worktrees.row.detached", { sha: shortSha(worktree.head) }) : t("worktrees.row.noCommit"))];
  if (worktree.isMain) parts.push(t("worktrees.row.main"));
  if (worktree.isLocked) parts.push(t("worktrees.row.locked"));
  if (worktree.hasChanges) parts.push(t("worktrees.row.changed"));
  return parts.join(" · ");
}

/**
 * List order: the worktree opened here, the main folder, then those with a branch (by branch name),
 * the detached ones (by folder) and finally the orphaned ones.
 */
export function sortWorktrees(worktrees: Worktree[]): Worktree[] {
  const rank = (item: Worktree) => (item.isPrunable ? 4 : item.isCurrent ? 0 : item.isMain ? 1 : item.branch ? 2 : 3);
  const key = (item: Worktree) => (item.branch && !item.isPrunable ? item.branch : folderName(item.path));
  return [...worktrees].sort((a, b) => rank(a) - rank(b) || key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Splits the folder name into the part all worktrees share ("messnetz-") and the part that tells
 * them apart. Without a common prefix the first part stays empty.
 */
export function splitFolderName(name: string, repoName: string): [prefix: string, rest: string] {
  if (!repoName || name.length <= repoName.length + 1) return ["", name];
  const head = name.slice(0, repoName.length);
  const separator = name.charAt(repoName.length);
  if (head.toLowerCase() !== repoName.toLowerCase() || !"-_. ".includes(separator)) return ["", name];
  return [name.slice(0, repoName.length + 1), name.slice(repoName.length + 1)];
}

/** What a screen reader announces for the row. */
export function describeWorktree(worktree: Worktree): string {
  const parts = [t("worktrees.describe.name", { name: folderName(worktree.path) })];
  if (worktree.isPrunable) parts.push(t("worktrees.describe.orphaned"));
  else parts.push(worktree.branch ? t("worktrees.describe.branch", { branch: worktree.branch }) : worktreeTarget(worktree));
  if (worktree.isMain) parts.push(t("worktrees.row.main"));
  if (worktree.isCurrent) parts.push(t("worktrees.describe.current"));
  if (worktree.isLocked) parts.push(worktree.lockReason ? t("worktrees.describe.lockedReason", { reason: worktree.lockReason }) : t("worktrees.row.locked"));
  if (worktree.hasChanges && !worktree.isPrunable) parts.push(t("worktrees.describe.changes"));
  return parts.join(", ");
}

/** Tooltip lines: full path first. */
export function worktreeTipLines(worktree: Worktree): string[] {
  const lines = [worktree.path];
  if (worktree.isPrunable) lines.push(t("worktrees.tip.orphaned"));
  else lines.push(worktree.branch ? t("worktrees.tip.branch", { branch: worktree.branch }) : t("worktrees.tip.noBranch", { target: worktreeTarget(worktree) }));
  if (worktree.isMain) lines.push(t("worktrees.tip.main"));
  if (worktree.isCurrent) lines.push(t("worktrees.tip.current"));
  if (worktree.isLocked) lines.push(worktree.lockReason ? t("worktrees.tip.lockedReason", { reason: worktree.lockReason }) : t("worktrees.tip.lockedNoReason"));
  if (worktree.hasChanges && !worktree.isPrunable) lines.push(t("worktrees.tip.changes"));
  return lines;
}

export function matchesWorktree(worktree: Worktree, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return worktree.path.toLowerCase().includes(needle) || (worktree.branch?.toLowerCase().includes(needle) ?? false);
}

/**
 * "wetterstation" + "feature/wind-diagramm" → "wetterstation-feature-wind-diagramm".
 * Without a target there is no suggestion yet (the main folder is already named like the repository).
 */
export function suggestFolder(repoName: string, target: string): string {
  const slug = target
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/[<>:"|?*\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!slug) return "";
  const base = repoName.trim() || "worktree";
  return `${base}-${slug}`;
}

/** Why a local branch cannot be checked out in a new worktree right now – or null. */
export function branchBlock(ref: Pick<Ref, "isHead" | "worktreePath">): string | null {
  if (ref.isHead) return t("worktrees.block.here");
  if (ref.worktreePath) return t("worktrees.block.elsewhere");
  return null;
}
