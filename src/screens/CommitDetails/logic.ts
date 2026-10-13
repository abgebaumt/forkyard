/**
 * Pure logic of the commit panel: what does a multi-selection mean?
 *
 * For `range` the core literally compares two revisions. Whether several selected commits form
 * a contiguous sequence – only then does the comparison “parent of the oldest → newest” show
 * exactly the changes of these commits – is decided by the UI from the parents.
 */
import type { Sha } from "../../core";

export interface CommitBrief {
  sha: Sha;
  parents: Sha[];
  summary: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string | null;
  /** Position in the loaded graph (0 = top row); null if the commit is not shown there. */
  order: number | null;
}

export type SelectionAnalysis =
  /** Contiguous sequence along the first parents. `chain` is newest first. */
  | { kind: "chain"; chain: Sha[]; newest: Sha; oldest: Sha; base: Sha }
  /** The sequence reaches back to the repository's first commit: there is no revision before it. */
  | { kind: "root"; chain: Sha[]; newest: Sha; oldest: Sha }
  /** The commits are not directly connected. */
  | { kind: "gap"; ordered: Sha[] };

/** Newest first: by position in the graph, otherwise by date, otherwise in selection order. */
export function orderNewestFirst(shas: Sha[], briefs: Map<Sha, CommitBrief>): Sha[] {
  const index = new Map(shas.map((sha, position) => [sha, position]));
  return [...shas].sort((a, b) => {
    const left = briefs.get(a);
    const right = briefs.get(b);
    if (left?.order != null && right?.order != null) return left.order - right.order;
    const leftTime = left?.authoredAt ? Date.parse(left.authoredAt) : NaN;
    const rightTime = right?.authoredAt ? Date.parse(right.authoredAt) : NaN;
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
    return (index.get(a) ?? 0) - (index.get(b) ?? 0);
  });
}

/**
 * Do the selected commits form a sequence in which each one is the first parent of its successor?
 * The first parent counts because the comparison of a merge commit also runs against it.
 */
export function analyzeSelection(shas: Sha[], briefs: Map<Sha, CommitBrief>): SelectionAnalysis {
  const selected = new Set(shas);
  const firstParent = (sha: Sha) => briefs.get(sha)?.parents[0] ?? null;
  const isFirstParentOfSelected = new Set<Sha>();
  for (const sha of selected) {
    const parent = firstParent(sha);
    if (parent && selected.has(parent)) isFirstParentOfSelected.add(parent);
  }
  const tips = [...selected].filter((sha) => !isFirstParentOfSelected.has(sha));
  const tip = tips.length === 1 ? tips[0] : undefined;
  if (tip !== undefined) {
    const chain: Sha[] = [tip];
    let current = tip;
    for (;;) {
      const parent = firstParent(current);
      if (!parent || !selected.has(parent) || chain.includes(parent)) break;
      chain.push(parent);
      current = parent;
    }
    if (chain.length === selected.size) {
      const base = firstParent(current);
      return base ? { kind: "chain", chain, newest: tip, oldest: current, base } : { kind: "root", chain, newest: tip, oldest: current };
    }
  }
  return { kind: "gap", ordered: orderNewestFirst(shas, briefs) };
}
