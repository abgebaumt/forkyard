/**
 * What the UI lays over the core's layout without changing it – pure functions:
 *
 * - **Highlighting**: which loaded rows belong to a branch (its tip and all ancestors),
 *   and which line segments connect two such commits? The rest is drawn dimmed.
 * - **Pinning**: the line of a pinned branch lies leftmost. For that the lanes
 *   are reordered per row boundary (the pinned ones to the front, all others keep their order).
 * - **Ghost label**: the nearest branch that contains a commit.
 *
 * Based on the rules of the core layout (crates/core/src/commands/graph/layout.rs):
 * the line to the first parent stays in the node's lane, passing lines never change
 * lanes, and the rows are in topological order (children before parents).
 */
import type { GraphRow, RefLabelInfo, Sha } from "../../core";

/** Key of a row in `indexByKey`: the SHA for commits. */
export type RowIndex = ReadonlyMap<string, number>;

const isCommit = (row: GraphRow | undefined): row is GraphRow & { sha: Sha } => Boolean(row && row.sha && (row.kind === "commit" || row.kind === "merge"));

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

export interface Highlight {
  /** First row that belongs to it (the tip, or the local changes row above it). */
  start: number;
  /** 1 = belongs to the branch. Length = number of loaded rows. */
  member: Uint8Array;
  /** Number of commits that belong to it (without the local changes row). */
  count: number;
}

/**
 * Tip and all loaded ancestors. `withWip`: the local changes row belongs to it
 * (the branch is checked out). null if the tip is not among the loaded rows.
 */
export function computeHighlight(rows: readonly GraphRow[], indexByKey: RowIndex, tip: Sha, withWip: boolean): Highlight | null {
  const tipIndex = indexByKey.get(tip);
  if (tipIndex === undefined || !isCommit(rows[tipIndex])) return null;
  const member = new Uint8Array(rows.length);
  member[tipIndex] = 1;
  let count = 0;
  // Children come before their parents: one pass from top to bottom is enough.
  for (let index = tipIndex; index < rows.length; index++) {
    if (member[index] !== 1) continue;
    count += 1;
    for (const parent of rows[index]!.parents) {
      const at = indexByKey.get(parent);
      if (at !== undefined && at > index) member[at] = 1;
    }
  }
  let start = tipIndex;
  // The local changes row belongs to the checked-out branch – even without changes (then it has no line).
  if (withWip && rows[0]?.kind === "wip") {
    member[0] = 1;
    if (rows[0].lane >= 0) start = 0;
  }
  return { start, member, count };
}

/** Distance between the checkpoints at which the state of the lanes is remembered. */
const CHECKPOINT_EVERY = 256;

/**
 * Which line segments of a row are highlighted. A line is highlighted as soon as a commit of the
 * branch feeds it – that can change in the middle of a lane when a merge commit turns into an
 * already running line. The state per lane is therefore carried along from top to bottom
 * and remembered every 256 rows; only a section is ever drawn.
 */
export class EdgeHighlighter {
  private readonly checkpoints: Uint8Array[] = [];
  /** State at the top edge of row `cursor`. */
  private state: Uint8Array;
  private cursor: number;

  constructor(
    private readonly rows: readonly GraphRow[],
    private readonly highlight: Highlight,
    maxLane: number,
  ) {
    this.state = new Uint8Array(Math.max(1, maxLane + 2));
    this.cursor = highlight.start;
    this.checkpoints.push(this.state.slice());
  }

  private ensure(lane: number): void {
    if (lane < this.state.length) return;
    const grown = new Uint8Array(lane + 8);
    grown.set(this.state);
    this.state = grown;
  }

  /** Processes row `index` (state at its top edge → bottom edge); returns 1 = highlighted per edge. */
  private step(index: number, record: boolean): Uint8Array | null {
    const row = this.rows[index];
    const flags = record && row ? new Uint8Array(row.edges.length) : null;
    if (!row) return flags;
    const own = this.highlight.member[index] === 1 ? 1 : 0;
    const edges = row.edges;
    let moved: number[] | null = null;
    for (let at = 0; at < edges.length; at++) {
      const edge = edges[at]!;
      if (edge.top === null) continue;
      this.ensure(edge.top);
      const hot = this.state[edge.top]!;
      if (flags) flags[at] = hot;
      if (edge.bottom === null) this.state[edge.top] = 0;
      else if (edge.bottom !== edge.top) {
        // Does not occur in the core's layout; for completeness the state moves along.
        this.state[edge.top] = 0;
        (moved ??= []).push(edge.bottom, hot);
      }
    }
    if (moved) {
      for (let at = 0; at < moved.length; at += 2) {
        this.ensure(moved[at]!);
        this.state[moved[at]!] = moved[at + 1]!;
      }
    }
    for (let at = 0; at < edges.length; at++) {
      const edge = edges[at]!;
      if (edge.top !== null || edge.bottom === null) continue;
      this.ensure(edge.bottom);
      if (flags) flags[at] = own;
      // New line: only this commit feeds it. If it turns into a running one, that one's state counts too.
      this.state[edge.bottom] = this.state[edge.bottom]! | own;
    }
    return flags;
  }

  private seek(index: number): void {
    const { start } = this.highlight;
    const target = Math.max(start, index);
    if (target < this.cursor) {
      const slot = Math.floor((target - start) / CHECKPOINT_EVERY);
      this.state = this.checkpoints[slot]!.slice();
      this.cursor = start + slot * CHECKPOINT_EVERY;
    }
    while (this.cursor < target) {
      this.step(this.cursor, false);
      this.cursor += 1;
      if ((this.cursor - start) % CHECKPOINT_EVERY === 0) {
        const slot = (this.cursor - start) / CHECKPOINT_EVERY;
        if (!this.checkpoints[slot]) this.checkpoints[slot] = this.state.slice();
      }
    }
  }

  /** Edge flags of the rows `first…last`; above the tip nothing is highlighted (null). */
  range(first: number, last: number): (Uint8Array | null)[] {
    const result: (Uint8Array | null)[] = [];
    const { start } = this.highlight;
    for (let index = first; index < Math.min(start, last + 1); index++) result.push(null);
    if (last < start) return result;
    this.seek(first);
    for (let index = Math.max(first, start); index <= last; index++) {
      result.push(this.step(index, true));
      this.cursor = index + 1;
      if ((this.cursor - start) % CHECKPOINT_EVERY === 0) {
        const slot = (this.cursor - start) / CHECKPOINT_EVERY;
        if (!this.checkpoints[slot]) this.checkpoints[slot] = this.state.slice();
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

/**
 * Where the line of a pinned branch runs: from its tip along the first parents
 * to the end of the loaded rows.
 */
export interface PinnedChain {
  /** Lane of the node if the row is a commit of the chain; otherwise −1. */
  node: Int16Array;
  /** Lane of the chain at the bottom edge of the row; −1 where it does not run (yet) or no longer runs. */
  below: Int16Array;
}

export function computePinnedChain(rows: readonly GraphRow[], indexByKey: RowIndex, tip: Sha, withWip: boolean): PinnedChain | null {
  let index = indexByKey.get(tip);
  if (index === undefined || !isCommit(rows[index])) return null;
  const node = new Int16Array(rows.length).fill(-1);
  const below = new Int16Array(rows.length).fill(-1);
  // The dashed line of the local changes belongs to the checked-out branch.
  if (withWip && rows[0]?.kind === "wip" && rows[0].lane >= 0 && index > 0) {
    node[0] = rows[0].lane;
    for (let at = 0; at < index; at++) below[at] = rows[0].lane;
  }
  for (;;) {
    const row = rows[index]!;
    node[index] = row.lane;
    const parent = row.parents[0];
    if (!parent) break;
    const next = indexByKey.get(parent);
    // The first parent is not loaded yet: the line continues to the end.
    const end = next !== undefined && next > index ? next : rows.length;
    for (let at = index; at < end; at++) below[at] = row.lane;
    if (next === undefined || next <= index) break;
    index = next;
  }
  return { node, below };
}

/** New lane of `lane` when the lanes `pinned` (in this order) move to the front. */
export function mapLane(lane: number, pinned: readonly number[]): number {
  let less = 0;
  for (let at = 0; at < pinned.length; at++) {
    const value = pinned[at]!;
    if (value === lane) return at;
    if (value < lane) less += 1;
  }
  return lane - less + pinned.length;
}

const NONE: readonly number[] = [];

/** The pinned lanes at one spot, without gaps and duplicates (two chains can share the same line). */
function collect(chains: readonly PinnedChain[], read: (chain: PinnedChain) => number): readonly number[] {
  let list: number[] | null = null;
  for (const chain of chains) {
    const lane = read(chain);
    if (lane < 0 || list?.includes(lane)) continue;
    (list ??= []).push(lane);
  }
  return list ?? NONE;
}

export interface LaneMaps {
  top: readonly number[];
  node: readonly number[];
  bottom: readonly number[];
}

/** The reordering lanes at the top edge, node and bottom edge of row `index`; null = nothing to do. */
export function laneMapsAt(chains: readonly PinnedChain[], index: number): LaneMaps | null {
  if (chains.length === 0) return null;
  const top = index > 0 ? collect(chains, (chain) => chain.below[index - 1] ?? -1) : NONE;
  const bottom = collect(chains, (chain) => chain.below[index] ?? -1);
  const node = collect(chains, (chain) => {
    const own = chain.node[index] ?? -1;
    return own >= 0 ? own : (chain.below[index] ?? -1);
  });
  const identity = (list: readonly number[]) => list.every((lane, at) => lane === at);
  if (identity(top) && identity(bottom) && identity(node)) return null;
  return { top, node, bottom };
}

// ---------------------------------------------------------------------------
// Row for the canvas
// ---------------------------------------------------------------------------

export interface PaintEdge {
  top: number | null;
  bottom: number | null;
  color: number;
  dashed: boolean;
  dim?: boolean;
}

/** What `paintGraph` needs from a row; a `GraphRow` fits without conversion. */
export interface PaintRow {
  kind: GraphRow["kind"];
  lane: number;
  color: number;
  isHead: boolean;
  edges: readonly PaintEdge[];
  dim?: boolean;
}

/** Applies pinning and highlighting to a row. Without either, the row comes back unchanged. */
export function decorateRow(row: GraphRow, maps: LaneMaps | null, dimNode: boolean, hot: Uint8Array | null, dimEdges: boolean): PaintRow {
  if (!maps && !dimNode && !dimEdges) return row;
  const edges: PaintEdge[] = new Array(row.edges.length);
  for (let at = 0; at < row.edges.length; at++) {
    const edge = row.edges[at]!;
    edges[at] = {
      top: edge.top === null ? null : maps ? mapLane(edge.top, maps.top) : edge.top,
      bottom: edge.bottom === null ? null : maps ? mapLane(edge.bottom, maps.bottom) : edge.bottom,
      color: edge.color,
      dashed: edge.dashed,
      dim: dimEdges && !(hot && hot[at] === 1),
    };
  }
  return { kind: row.kind, lane: maps && row.lane >= 0 ? mapLane(row.lane, maps.node) : row.lane, color: row.color, isHead: row.isHead, edges, dim: dimNode };
}

// ---------------------------------------------------------------------------
// Ghost label
// ---------------------------------------------------------------------------

const refRank = (ref: RefLabelInfo) => (ref.kind === "local" ? (ref.isHead ? 0 : 1) : ref.kind === "remote" ? 2 : 9);

/** The branch label of a row that stands for it: checked out before local before remote; tags do not count. */
export function branchLabelOf(row: GraphRow | undefined): RefLabelInfo | null {
  let best: RefLabelInfo | null = null;
  for (const ref of row?.refs ?? []) {
    if (ref.kind === "tag") continue;
    if (!best || refRank(ref) < refRank(best)) best = ref;
  }
  return best;
}

/** At most this many rows above a commit are searched for a branch. */
export const GHOST_SCAN_LIMIT = 20_000;

/**
 * The nearest branch that contains the commit of row `index` – derived from the loaded rows,
 * the core does not provide the mapping.
 *
 * First the branch on whose line the commit lies: the line is followed upwards (the
 * child whose first parent it is and that is in the same lane) until a row carries a
 * branch label. If the line ends without a label (a merged branch whose name was deleted),
 * the nearest row above it that descends from it and carries a label applies.
 * null: the row is not a commit, carries a branch label itself, or no branch among the loaded rows
 * contains it.
 */
export function nearestBranch(rows: readonly GraphRow[], index: number, limit = GHOST_SCAN_LIMIT): { ref: RefLabelInfo; rowIndex: number } | null {
  const row = rows[index];
  if (!isCommit(row) || branchLabelOf(row)) return null;
  const descendants = new Set<Sha>([row.sha]);
  let fallback: { ref: RefLabelInfo; rowIndex: number } | null = null;
  /** The topmost commit found so far on the row's line; null as soon as the line ends. */
  let line: (GraphRow & { sha: Sha }) | null = row;
  const stop = Math.max(0, index - limit);
  for (let at = index - 1; at >= stop; at--) {
    const candidate = rows[at];
    if (!isCommit(candidate)) continue;
    let related = false;
    for (const parent of candidate.parents) {
      if (descendants.has(parent)) {
        related = true;
        break;
      }
    }
    if (!related) continue;
    const ref = branchLabelOf(candidate);
    if (line && candidate.parents[0] === line.sha && candidate.lane === line.lane) {
      if (ref) return { ref, rowIndex: at };
      line = candidate;
    }
    if (ref) {
      fallback ??= { ref, rowIndex: at };
      continue;
    }
    descendants.add(candidate.sha);
  }
  return fallback;
}
