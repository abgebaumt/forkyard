/**
 * Pure parts of the commit graph view: the flat row list, the texts of the filter bar, and the
 * selection and keyboard rules of the list.
 */
import type { GraphPage, GraphRow, RepoViewState, Sha } from "../../core";
import { rowKey } from "../../components/graph/GraphRowView";
import type { SmartSelection } from "../../components/graph/smart";
import { t } from "../../i18n";

export const STASH_REF = "refs/stash";

/** Shown at the top while the graph has no row of its own for the local changes (yet). */
export const QUIET_WIP: GraphRow = Object.freeze({
  id: "wip",
  kind: "wip",
  sha: null,
  lane: -1,
  color: 0,
  edges: [],
  parents: [],
  summary: "",
  authorName: "",
  authorEmail: "",
  authoredAt: null,
  refs: [],
  isHead: false,
  stashIndex: null,
  wipCount: null,
  collapsedCount: null,
  collapseTooLarge: false,
  collapsible: false,
  sync: "none",
}) as GraphRow;

export interface FlatGraph {
  /** Index 0 is always the local changes row. */
  rows: GraphRow[];
  indexByKey: Map<string, number>;
  hasWip: boolean;
  maxLane: number;
  commitCount: number;
}

export function flatten(pages: GraphPage[] | undefined): FlatGraph {
  let wip: GraphRow | null = null;
  let maxLane = 0;
  let commitCount = 0;
  const rows: GraphRow[] = [QUIET_WIP];
  const indexByKey = new Map<string, number>([["wip", 0]]);
  for (const page of pages ?? []) {
    maxLane = Math.max(maxLane, page.maxLane);
    for (const row of page.rows) {
      if (row.kind === "wip") {
        wip = row;
        continue;
      }
      const key = rowKey(row);
      if (indexByKey.has(key)) continue;
      indexByKey.set(key, rows.length);
      rows.push(row);
      if (row.kind !== "stash") commitCount += 1;
    }
  }
  if (wip) rows[0] = wip;
  return { rows, indexByKey, hasWip: wip !== null, maxLane, commitCount };
}

export const isCommitRow = (row: GraphRow | undefined): row is GraphRow & { sha: Sha } =>
  Boolean(row?.sha && (row.kind === "commit" || row.kind === "merge"));

export const shortRefName = (fullName: string) =>
  fullName === STASH_REF ? t("ui.stashes") : fullName.replace(/^refs\/(heads|remotes|tags)\//, "");

/** “main, origin/main and develop” – what the selection “current branch, upstream, target” shows. */
export function smartText(selection: SmartSelection): string {
  const names = [selection.current.name, selection.upstream?.name, selection.target?.name].filter((name): name is string => Boolean(name));
  return names.length <= 1
    ? (names[0] ?? "")
    : t("commitGraph.filter.list", { first: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

export function filterText(view: RepoViewState, smart: SmartSelection | null): string {
  if (smart) {
    const parts = [
      t("commitGraph.filter.currentBranch"),
      smart.upstream ? t("commitGraph.filter.upstream") : null,
      smart.target ? t("commitGraph.filter.target") : null,
    ].filter(Boolean);
    return t("commitGraph.filter.smart", { names: smartText(smart), parts: parts.join(", ") });
  }
  if (view.soloRefs.length === 1) return t("commitGraph.filter.soloOne", { name: shortRefName(view.soloRefs[0]!) });
  if (view.soloRefs.length > 1) return t("commitGraph.filter.soloMany", { count: view.soloRefs.length });
  if (view.hiddenRefs.length === 1) return t("commitGraph.filter.hiddenOne", { name: shortRefName(view.hiddenRefs[0]!) });
  return t("commitGraph.filter.hiddenMany", { count: view.hiddenRefs.length });
}

/** The commits from row `from` to row `to` (both included, either direction), in that order. */
export function rangeShas(rows: GraphRow[], from: number, to: number): Sha[] {
  const step = from <= to ? 1 : -1;
  const shas: Sha[] = [];
  for (let at = from; at !== to + step; at += step) {
    const between = rows[at];
    if (isCommitRow(between)) shas.push(between.sha);
  }
  return shas;
}

/**
 * The row a key move lands on: `target` clamped to the list. Extending the selection skips stash
 * rows and the local changes (a range consists of commits only); null when no commit is left that way.
 */
export function moveTarget(rows: GraphRow[], cursor: number, target: number, extend: boolean): number | null {
  let next = Math.max(0, Math.min(rows.length - 1, target));
  if (!extend) return next;
  const step = next >= cursor ? 1 : -1;
  while (rows[next] && !isCommitRow(rows[next])) next += step;
  return rows[next] ? next : null;
}

/** H: the row of the first parent; -1 if it is not loaded or the row is no commit. */
export function parentIndex(rows: GraphRow[], indexByKey: ReadonlyMap<string, number>, cursor: number): number {
  const row = rows[cursor];
  if (!isCommitRow(row)) return -1;
  const parent = row.parents[0];
  return parent ? (indexByKey.get(parent) ?? -1) : -1;
}

/** L: the nearest child above; one that has this commit as its first parent takes precedence. -1 if none. */
export function childIndex(rows: GraphRow[], cursor: number): number {
  const row = rows[cursor];
  if (!isCommitRow(row)) return -1;
  let other = -1;
  for (let index = cursor - 1; index >= 0; index--) {
    const candidate = rows[index];
    if (!isCommitRow(candidate) || !candidate.parents.includes(row.sha)) continue;
    if (candidate.parents[0] === row.sha) return index;
    if (other < 0) other = index;
  }
  return other;
}

export interface GraphKeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type GraphKey =
  /** Move the cursor to `to` (unclamped); Shift extends the selection. */
  | { kind: "move"; to: number }
  | { kind: "parent" }
  | { kind: "child" }
  | { kind: "highlight" }
  /** Esc: clears a sticky highlight (only then is the key used). */
  | { kind: "escape" }
  | { kind: "details" }
  /** ← / →: collapse or expand the selected merge. */
  | { kind: "collapse"; collapse: boolean }
  /** E: edit the branch's history in the graph. */
  | { kind: "edit" }
  | { kind: "menu" };

/** What a key in the list does; `page`: rows per page; null = not a key of the list. */
export function graphKey(event: GraphKeyInput, cursor: number, page: number, count: number): GraphKey | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (plain && (key === "ArrowDown" || key === "j")) return { kind: "move", to: cursor + 1 };
  if (plain && (key === "ArrowUp" || key === "k")) return { kind: "move", to: cursor - 1 };
  if (key === "Home" && !event.altKey) return { kind: "move", to: 0 };
  if (key === "End" && !event.altKey) return { kind: "move", to: count - 1 };
  if (plain && key === "PageDown") return { kind: "move", to: cursor + page };
  if (plain && key === "PageUp") return { kind: "move", to: cursor - page };
  const single = plain && !event.shiftKey;
  if (single && key === "h") return { kind: "parent" };
  if (single && key === "l") return { kind: "child" };
  if (single && key === "b") return { kind: "highlight" };
  if (single && key === "e") return { kind: "edit" };
  if (single && key === "Escape") return { kind: "escape" };
  if (single && key === "Enter") return { kind: "details" };
  if (single && (key === "ArrowLeft" || key === "ArrowRight")) return { kind: "collapse", collapse: key === "ArrowLeft" };
  if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) return { kind: "menu" };
  return null;
}
