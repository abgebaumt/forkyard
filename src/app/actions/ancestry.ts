/**
 * Ancestry of commits from the loaded graph rows: "is contained in", "commits
 * in between", "consecutive". There is no core command for this; the rows arrive
 * topologically sorted (children before parents), so much can be answered reliably
 * as long as the commit in question is loaded. Where not, the answer is "unknown" (null),
 * and the core decides on execution.
 */
import { core, type GraphRow, type Id, type Sha } from "../../core";
import { t } from "../../i18n";
import { cachedGraphRows, graphComplete } from "./context";

export interface GraphIndex {
  rows: Map<Sha, GraphRow>;
  /** Position in the display (0 = top, newest). */
  order: Map<Sha, number>;
  /** The history is loaded up to the beginning. */
  complete: boolean;
}

function build(rows: GraphRow[], complete: boolean): GraphIndex {
  const index: GraphIndex = { rows: new Map(), order: new Map(), complete };
  rows.forEach((row, position) => {
    if (!row.sha || row.kind === "wip" || row.kind === "stash") return;
    index.rows.set(row.sha, row);
    index.order.set(row.sha, position);
  });
  return index;
}

/** From the cache; null if the graph is not loaded yet. */
export function graphIndex(repoId: Id): GraphIndex | null {
  const rows = cachedGraphRows(repoId);
  return rows.length ? build(rows, graphComplete(repoId)) : null;
}

/**
 * From the cache, otherwise the first page directly from the core (without keeping it).
 * `fresh` always asks the core – needed right after a fetch, when the cache still shows the old state.
 */
export async function loadGraphIndex(repoId: Id, options: { fresh?: boolean } = {}): Promise<GraphIndex | null> {
  const cached = options.fresh ? null : graphIndex(repoId);
  if (cached) return cached;
  try {
    const page = await core.graphPage({ repoId, cursor: null, limit: 1000 });
    return build(page.rows, page.nextCursor === null);
  } catch {
    return null;
  }
}

/** Finds a commit also by a SHA prefix. */
export function findRow(index: GraphIndex, sha: Sha): GraphRow | undefined {
  const exact = index.rows.get(sha);
  if (exact || sha.length >= 40) return exact;
  for (const [full, row] of index.rows) if (full.startsWith(sha)) return row;
  return undefined;
}

/** Parents of commits that are not graph rows (e.g. a commit only the reflog still knows). */
export type OutsideParents = ReadonlyMap<Sha, readonly Sha[]>;

/** All loaded ancestors of `tip` (including `tip`); `outside` bridges commits that are not graph rows. */
function ancestors(index: GraphIndex, tip: Sha, stop?: Set<Sha>, outside?: OutsideParents): { seen: Set<Sha>; open: boolean } {
  const seen = new Set<Sha>();
  let open = false;
  const stack = [tip];
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha) || stop?.has(sha)) continue;
    const row = index.rows.get(sha);
    const bridge = row ? undefined : outside?.get(sha);
    if (bridge) {
      seen.add(sha);
      for (const parent of bridge) stack.push(parent);
      continue;
    }
    if (!row) {
      // Beyond the loaded pages: from here on nothing is known.
      open = true;
      continue;
    }
    seen.add(sha);
    for (const parent of row.parents) stack.push(parent);
  }
  return { seen, open };
}

/** Is `ancestor` reachable from `descendant`? null = cannot be told from the loaded rows. */
export function isAncestor(index: GraphIndex, ancestor: Sha, descendant: Sha): boolean | null {
  if (ancestor === descendant) return true;
  if (!index.rows.has(descendant)) return null;
  const { seen } = ancestors(index, descendant);
  if (seen.has(ancestor)) return true;
  // If the commit is loaded, all its descendants are loaded too (children come before parents).
  return index.rows.has(ancestor) || index.complete ? false : null;
}

export interface CommitRange {
  /** Newest first. */
  rows: GraphRow[];
  /** There are more commits beyond the loaded pages. */
  partial: boolean;
}

/**
 * Commits reachable from `tip` but not from `base` (like `git log base..tip`). A `base` that is not a
 * graph row (a commit only the reflog knows, an unfetched remote commit) needs its parents in `outside`
 * up to the loaded rows; otherwise what it reaches is unknown and so is the range (null).
 */
export function commitsBetween(index: GraphIndex, base: Sha, tip: Sha, outside?: OutsideParents): CommitRange | null {
  if (!index.rows.has(tip)) return null;
  const { seen: excluded, open: baseOpen } = ancestors(index, base, undefined, outside);
  // An unloaded base whose ancestry does not lead fully back into the rows: anything might be shared.
  if (baseOpen && !index.rows.has(base)) return null;
  const { seen, open } = ancestors(index, tip, excluded);
  const rows = [...seen].map((sha) => index.rows.get(sha)!).sort((a, b) => index.order.get(a.sha!)! - index.order.get(b.sha!)!);
  return { rows, partial: open && !index.complete };
}

export type Consecutive =
  | { ok: true; /** Oldest first. */ shas: Sha[]; /** Parent of the oldest commit; null for the very first. */ base: Sha | null }
  | { ok: false; reason: string }
  /** Cannot be told from the loaded rows – the core checks. */
  | { ok: null };

/**
 * Checks what `squash_commits` requires: at least two commits, directly consecutive,
 * on the checked-out branch, no merge commit in the selection or above it.
 */
export function consecutiveOnHead(index: GraphIndex, head: Sha | null, selected: Sha[]): Consecutive {
  if (selected.length < 2) return { ok: false, reason: t("actions.ancestry.atLeastTwo") };
  const rows = selected.map((sha) => index.rows.get(sha));
  if (rows.some((row) => !row)) return { ok: null };
  const sorted = (rows as GraphRow[]).sort((a, b) => index.order.get(a.sha!)! - index.order.get(b.sha!)!);
  if (sorted.some((row) => row.parents.length > 1)) return { ok: false, reason: t("actions.ancestry.containsMerge") };
  for (let position = 0; position < sorted.length - 1; position++) {
    if (sorted[position]!.parents[0] !== sorted[position + 1]!.sha) return { ok: false, reason: t("actions.ancestry.consecutiveOnly") };
  }
  const newest = sorted[0]!;
  const oldest = sorted[sorted.length - 1]!;
  if (!head) return { ok: false, reason: t("actions.ancestry.noHead") };
  // From the checked-out commit down along the first parents to the newest of the selection.
  let cursor: Sha | undefined = head;
  for (let steps = 0; cursor && cursor !== newest.sha; steps++) {
    const row = index.rows.get(cursor);
    if (!row) return { ok: null };
    if (row.parents.length > 1) {
      return isAncestor(index, newest.sha!, head) ? { ok: false, reason: t("actions.ancestry.mergeAbove") } : { ok: false, reason: t("actions.ancestry.headBranchOnly") };
    }
    cursor = row.parents[0];
    if (steps > index.rows.size) return { ok: null };
  }
  if (cursor !== newest.sha) return { ok: false, reason: t("actions.ancestry.headBranchOnly") };
  return { ok: true, shas: sorted.map((row) => row.sha!).reverse(), base: oldest.parents[0] ?? null };
}

/** SHAs in history order, oldest first (for cherry-picking several commits). */
export function oldestFirst(index: GraphIndex | null, shas: Sha[]): Sha[] {
  if (!index || shas.some((sha) => !index.order.has(sha))) return shas;
  return [...shas].sort((a, b) => index.order.get(b)! - index.order.get(a)!);
}
