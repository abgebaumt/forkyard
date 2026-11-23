/** Pure logic of the "Clean up branches" view: groups, filter, selection and what a deletion affects. */
import type { BranchCleanupCandidate, BranchCleanupClass } from "../../core";

const CLASS_ORDER: BranchCleanupClass[] = ["safe", "review", "blocked"];

/** The candidates the filter shows (a case-insensitive part of the name); only these count and get deleted. */
export function shownCandidates(list: BranchCleanupCandidate[], filter: string): BranchCleanupCandidate[] {
  const needle = filter.trim().toLowerCase();
  return needle ? list.filter((candidate) => candidate.name.toLowerCase().includes(needle)) : list;
}

/** Candidates per class in the order safe, review, blocked, as `shownCandidates` filters them; empty groups are left out. */
export function groupCandidates(
  list: BranchCleanupCandidate[],
  filter: string,
): { class: BranchCleanupClass; rows: BranchCleanupCandidate[] }[] {
  const shown = shownCandidates(list, filter);
  return CLASS_ORDER.map((kind) => ({ class: kind, rows: shown.filter((candidate) => candidate.class === kind) })).filter(
    (group) => group.rows.length > 0,
  );
}

/** What is marked when the list arrives: every safe branch. */
export function initialSelection(list: BranchCleanupCandidate[]): Set<string> {
  return new Set(list.filter((candidate) => candidate.class === "safe").map((candidate) => candidate.name));
}

/** Marks or unmarks a branch; a blocked branch can never be marked. */
export function toggleSelection(selection: Set<string>, candidate: BranchCleanupCandidate): Set<string> {
  if (candidate.class === "blocked") return selection;
  const next = new Set(selection);
  if (!next.delete(candidate.name)) next.add(candidate.name);
  return next;
}

/** `total`: the branches that can be marked at all (not blocked). */
export function selectionCount(list: BranchCleanupCandidate[], selection: Set<string>): { selected: number; total: number } {
  const open = list.filter((candidate) => candidate.class !== "blocked");
  return { selected: open.filter((candidate) => selection.has(candidate.name)).length, total: open.length };
}

/** Commits only this branch holds, named for branches that need a check first; null otherwise. */
export function lostCommits(candidate: BranchCleanupCandidate): number | null {
  if (candidate.class !== "review") return null;
  const unmerged = candidate.reasons.find((reason) => reason.kind === "unmerged");
  return unmerged ? unmerged.count : null;
}

/**
 * The remote branches the marked branches track (only where the core offers them: the upstream exists
 * and holds nothing beyond the branch and the default branch); `expected` is the tip that may be deleted.
 */
export function remoteTargets(
  list: BranchCleanupCandidate[],
  selection: Set<string>,
): { remote: string; branch: string; expected: string; label: string }[] {
  return list.flatMap((candidate) =>
    selection.has(candidate.name) &&
    candidate.class !== "blocked" &&
    candidate.upstreamRemote &&
    candidate.upstreamBranch &&
    candidate.upstreamSha
      ? [
          {
            remote: candidate.upstreamRemote,
            branch: candidate.upstreamBranch,
            expected: candidate.upstreamSha,
            label: `${candidate.upstreamRemote}/${candidate.upstreamBranch}`,
          },
        ]
      : [],
  );
}

/** The remotes the candidates track, each once, sorted. */
export function remoteNames(list: BranchCleanupCandidate[]): string[] {
  return [...new Set(list.flatMap((candidate) => (candidate.upstreamRemote ? [candidate.upstreamRemote] : [])))].sort();
}
