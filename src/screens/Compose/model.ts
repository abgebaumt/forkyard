/**
 * Pure logic of "Compose commits" (v1.2, 3.2): where each unit sits, moves of one or several units
 * by keyboard and pointer, the review of what the AI provider was unsure about, the dependency
 * check ("doesn't build on its own"), the file matrix, the plan for the core and how a new proposal
 * keeps what the user placed. Without React, tested in model.test.ts.
 *
 * Order everywhere: the commits in the order they are created (commit 1 is the oldest), then
 * "Don't commit". Inside a group the units keep the order the core listed them in. Every function
 * returns the same object when nothing changes.
 */
import type { ComposeGroup, ComposeKeep, ComposeNote, ComposeUnit } from "../../core";
import { t } from "../../i18n";

/** The group "Don't commit" in moves, cells and problems. */
export const SKIP = -1;

/** Who made a commit: the AI provider's proposal, the user ("N", new commit) or a merge of two. */
export type Origin = "ai" | "user" | "merged";

export interface DraftCommit {
  /** Stable key for list rows; does not change when the commit moves. */
  key: string;
  title: string;
  body: string;
  /** The provider's reason for the grouping (empty for the user's own commits). */
  reason: string;
  origin: Origin;
  units: string[];
}

export interface Arrangement {
  skip: string[];
  commits: DraftCommit[];
}

/** What the user did to the proposal: moved units ("by you") and confirmed unsure ones. */
export interface Review {
  pinned: ReadonlySet<string>;
  confirmed: ReadonlySet<string>;
}

export interface Selection {
  /** The row with the keyboard focus ring and the detail on the right. */
  cursor: string | null;
  /** Selected units in the order they were added (or in display order for a range). */
  ids: string[];
  /** Start of a Shift range. */
  anchor: string | null;
}

export type Units = ReadonlyMap<string, ComposeUnit>;

export type KeyAction =
  | { kind: "step"; delta: -1 | 1 }
  | { kind: "extend"; delta: -1 | 1 }
  | { kind: "shift"; delta: -1 | 1 }
  | { kind: "moveCommit"; delta: -1 | 1 }
  | { kind: "to"; group: number }
  | { kind: "newCommit" }
  | { kind: "nextUnsure" }
  | { kind: "confirm" }
  | { kind: "edit" }
  | { kind: "apply" };

export interface KeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type Blocked = { reason: "nothing" } | { reason: "title"; commit: number };

/** A requirement placed later than the unit that needs it, or not at all (`group` SKIP). */
export interface Need {
  need: string;
  group: number;
}

export interface Problem {
  unit: string;
  need: string;
  group: number;
}

export interface MatrixCell {
  group: number;
  count: number;
  /** The first unit of this file in the group (click target). */
  first: string | null;
}

export interface MatrixRow {
  path: string;
  cells: MatrixCell[];
  /** The file's units sit in more than one group. */
  split: boolean;
}

let commitCounter = 0;
function newKey(): string {
  commitCounter += 1;
  return `commit-${commitCounter}`;
}

/** Position of every unit in the core's list. */
export function orderOf(units: ComposeUnit[]): Map<string, number> {
  return new Map(units.map((unit, index) => [unit.id, index]));
}

function sorted(ids: string[], order: ReadonlyMap<string, number>): string[] {
  const at = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...ids].sort((a, b) => at(a) - at(b));
}

const isProtected = (unit: ComposeUnit | undefined) => Boolean(unit?.protected);

/** Before (or without) a proposal: everything in "Don't commit". */
export function allSkipped(units: ComposeUnit[]): Arrangement {
  return { skip: units.map((unit) => unit.id), commits: [] };
}

/** The provider's groups. Unknown, doubled and protected units never end up in a commit; what it did not place stays in "Don't commit". */
export function fromProposal(units: ComposeUnit[], groups: ComposeGroup[]): Arrangement {
  const order = orderOf(units);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const placed = new Set<string>();
  const commits: DraftCommit[] = [];
  for (const group of groups) {
    const ids: string[] = [];
    for (const id of group.units) {
      if (!order.has(id) || placed.has(id) || isProtected(byId.get(id))) continue;
      placed.add(id);
      ids.push(id);
    }
    if (ids.length > 0) commits.push({ key: newKey(), title: group.title, body: group.body, reason: group.reason ?? "", origin: "ai", units: sorted(ids, order) });
  }
  return { skip: units.map((unit) => unit.id).filter((id) => !placed.has(id)), commits };
}

/** After reading the changes again: known units keep their place, new ones go to "Don't commit", vanished ones are dropped. */
export function refreshed(arrangement: Arrangement, units: ComposeUnit[]): Arrangement {
  const order = orderOf(units);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const commits = arrangement.commits
    .map((commit) => ({ ...commit, units: sorted(commit.units.filter((id) => order.has(id) && !isProtected(byId.get(id))), order) }))
    .filter((commit) => commit.units.length > 0);
  const placed = new Set(commits.flatMap((commit) => commit.units));
  return { skip: units.map((unit) => unit.id).filter((id) => !placed.has(id)), commits };
}

/** The provider's notes by unit. */
export function notesOf(notes: ComposeNote[]): Map<string, ComposeNote> {
  return new Map(notes.map((note) => [note.unit, note]));
}

export function groupOf(arrangement: Arrangement, unit: string): number | null {
  if (arrangement.skip.includes(unit)) return SKIP;
  const index = arrangement.commits.findIndex((commit) => commit.units.includes(unit));
  return index >= 0 ? index : null;
}

/** Every unit as drawn: commit by commit, then "Don't commit". */
export function displayOrder(arrangement: Arrangement): string[] {
  return [...arrangement.commits.flatMap((commit) => commit.units), ...arrangement.skip];
}

/**
 * Moves `ids` into `target`: a commit index, SKIP or "new" (a new commit at the end). Protected
 * units stay where they are; commits that become empty are dropped. `target` of the result: the
 * group the moved units are in afterwards.
 */
export function moveUnits(
  arrangement: Arrangement,
  ids: string[],
  target: number | "new",
  order: ReadonlyMap<string, number>,
  units: Units,
): { arrangement: Arrangement; moved: string[]; target: number } {
  const moving = ids.filter((id) => !isProtected(units.get(id)) && groupOf(arrangement, id) !== null && groupOf(arrangement, id) !== target);
  const unchanged = { arrangement, moved: [] as string[], target: typeof target === "number" ? target : SKIP };
  if (moving.length === 0) return unchanged;
  if (typeof target === "number" && (target < SKIP || target >= arrangement.commits.length)) return unchanged;
  const gone = new Set(moving);
  const without = (list: string[]) => list.filter((id) => !gone.has(id));
  let skip = without(arrangement.skip);
  let commits = arrangement.commits.map((commit) => (commit.units.some((id) => gone.has(id)) ? { ...commit, units: without(commit.units) } : commit));
  let key: string | null = null;
  if (target === "new") {
    key = newKey();
    commits = [...commits, { key, title: "", body: "", reason: "", origin: "user", units: sorted(moving, order) }];
  } else if (target === SKIP) {
    skip = sorted([...skip, ...moving], order);
  } else {
    key = arrangement.commits[target]!.key;
    commits = commits.map((commit, index) => (index === target ? { ...commit, units: sorted([...commit.units, ...moving], order) } : commit));
  }
  commits = commits.filter((commit) => commit.units.length > 0);
  const next = { skip, commits };
  return { arrangement: next, moved: moving, target: key === null ? SKIP : commits.findIndex((commit) => commit.key === key) };
}

/** Alt+↑/↓: the group before or after the unit's group (commits, then "Don't commit"); `null` at the ends. */
export function stepTarget(arrangement: Arrangement, unit: string, delta: -1 | 1): number | null {
  const from = groupOf(arrangement, unit);
  if (from === null) return null;
  const sequence = [...arrangement.commits.map((_, index) => index), SKIP];
  const next = sequence[sequence.indexOf(from) + delta];
  return next === undefined ? null : next;
}

export function moveCommit(arrangement: Arrangement, index: number, delta: -1 | 1): Arrangement {
  const target = index + delta;
  const count = arrangement.commits.length;
  if (index < 0 || index >= count || target < 0 || target >= count) return arrangement;
  const commits = [...arrangement.commits];
  [commits[index], commits[target]] = [commits[target]!, commits[index]!];
  return { ...arrangement, commits };
}

/** Commit `index` takes the units of the next one and keeps its own message. */
export function mergeWithNext(arrangement: Arrangement, index: number, order: ReadonlyMap<string, number>): Arrangement {
  const first = arrangement.commits[index];
  const second = arrangement.commits[index + 1];
  if (!first || !second) return arrangement;
  const merged: DraftCommit = { ...first, origin: "merged", reason: "", units: sorted([...first.units, ...second.units], order) };
  return { ...arrangement, commits: [...arrangement.commits.slice(0, index), merged, ...arrangement.commits.slice(index + 2)] };
}

export function setTitle(arrangement: Arrangement, index: number, title: string): Arrangement {
  if (arrangement.commits[index]?.title === title) return arrangement;
  return { ...arrangement, commits: arrangement.commits.map((commit, i) => (i === index ? { ...commit, title } : commit)) };
}

// ---------------------------------------------------------------------------------------------
// Review

/** Units the provider was unsure about that the user has neither confirmed nor moved, in display order. */
export function unsureUnits(arrangement: Arrangement, notes: ReadonlyMap<string, ComposeNote>, review: Review): string[] {
  return displayOrder(arrangement).filter((id) => notes.get(id)?.unsure && !review.confirmed.has(id) && !review.pinned.has(id));
}

/** U: the next unsure unit after `cursor`, wrapping around; `null` when none is left. */
export function nextUnsure(arrangement: Arrangement, notes: ReadonlyMap<string, ComposeNote>, review: Review, cursor: string | null): string | null {
  const list = unsureUnits(arrangement, notes, review);
  if (list.length === 0) return null;
  const order = displayOrder(arrangement);
  const at = cursor ? order.indexOf(cursor) : -1;
  return list.find((id) => order.indexOf(id) > at) ?? list[0]!;
}

// ---------------------------------------------------------------------------------------------
// Dependencies

/** What `unit` needs that comes later or not at all. A unit in "Don't commit" needs nothing. */
export function brokenNeeds(arrangement: Arrangement, units: Units, unit: string): Need[] {
  const group = groupOf(arrangement, unit);
  if (group === null || group === SKIP) return [];
  const out: Need[] = [];
  for (const need of units.get(unit)?.requires ?? []) {
    const at = groupOf(arrangement, need);
    if (at === null) continue;
    if (at === SKIP || at > group) out.push({ need, group: at });
  }
  return out;
}

export function commitProblems(arrangement: Arrangement, units: Units, index: number): Problem[] {
  const commit = arrangement.commits[index];
  if (!commit) return [];
  return commit.units.flatMap((unit) => brokenNeeds(arrangement, units, unit).map((need) => ({ unit, ...need })));
}

export function firstProblem(arrangement: Arrangement, units: Units): (Problem & { commit: number }) | null {
  for (let index = 0; index < arrangement.commits.length; index += 1) {
    const problem = commitProblems(arrangement, units, index)[0];
    if (problem) return { commit: index, ...problem };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Selection

export const emptySelection: Selection = { cursor: null, ids: [], anchor: null };

export function selectOne(_selection: Selection, id: string): Selection {
  return { cursor: id, ids: [id], anchor: id };
}

/** Ctrl/Cmd click: add or remove; the last selected unit stays selected. */
export function toggleSelection(selection: Selection, id: string): Selection {
  const has = selection.ids.includes(id);
  const ids = has ? selection.ids.filter((x) => x !== id) : [...selection.ids, id];
  return { cursor: id, ids: ids.length > 0 ? ids : [id], anchor: id };
}

/** Shift click: everything between the anchor and `id` in display order. */
export function rangeSelection(selection: Selection, id: string, order: string[]): Selection {
  const anchor = selection.anchor ?? id;
  const a = order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return selectOne(selection, id);
  const [from, to] = a <= b ? [a, b] : [b, a];
  return { cursor: id, ids: order.slice(from, to + 1), anchor };
}

/** Shift+↑/↓: the neighbour of the cursor joins the selection. */
export function extendSelection(selection: Selection, delta: -1 | 1, order: string[]): Selection {
  if (!selection.cursor) return selection;
  const next = order[order.indexOf(selection.cursor) + delta];
  if (!next) return selection;
  return { ...selection, cursor: next, ids: selection.ids.includes(next) ? selection.ids : [...selection.ids, next] };
}

// ---------------------------------------------------------------------------------------------
// Views

/** "By files": per file (in the core's order) how many units sit in each commit and in "Don't commit". */
export function matrixOf(arrangement: Arrangement, units: ComposeUnit[]): MatrixRow[] {
  const groups = [...arrangement.commits.map((_, index) => index), SKIP];
  const where = new Map<string, number>();
  arrangement.commits.forEach((commit, index) => commit.units.forEach((id) => where.set(id, index)));
  arrangement.skip.forEach((id) => where.set(id, SKIP));
  const paths: string[] = [];
  const byPath = new Map<string, ComposeUnit[]>();
  for (const unit of units) {
    if (!byPath.has(unit.path)) {
      byPath.set(unit.path, []);
      paths.push(unit.path);
    }
    byPath.get(unit.path)!.push(unit);
  }
  return paths.map((path) => {
    const list = byPath.get(path)!;
    const cells = groups.map((group) => {
      const here = list.filter((unit) => where.get(unit.id) === group);
      return { group, count: here.length, first: here[0]?.id ?? null };
    });
    return { path, cells, split: cells.filter((cell) => cell.count > 0).length > 1 };
  });
}

/** The first two changed lines of a unit, trimmed – what a row shows instead of `@@` numbers. */
export function peekOf(unit: ComposeUnit): { kind: "add" | "remove"; text: string }[] {
  return unit.lines
    .filter((line) => line.kind === "add" || line.kind === "remove")
    .slice(0, 2)
    .map((line) => ({ kind: line.kind as "add" | "remove", text: line.text.trim() }));
}

export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}

export function summaryOf(arrangement: Arrangement): { commits: number; units: number; skipped: number; untitled: number } {
  return {
    commits: arrangement.commits.length,
    units: arrangement.commits.reduce((sum, commit) => sum + commit.units.length, 0),
    skipped: arrangement.skip.length,
    untitled: arrangement.commits.filter((commit) => !commit.title.trim()).length,
  };
}

export function blockedReason(arrangement: Arrangement): Blocked | null {
  const used = arrangement.commits.map((commit, index) => ({ commit, index })).filter(({ commit }) => commit.units.length > 0);
  if (used.length === 0) return { reason: "nothing" };
  const missing = used.find(({ commit }) => !commit.title.trim());
  return missing ? { reason: "title", commit: missing.index } : null;
}

// ---------------------------------------------------------------------------------------------
// Plan and new proposals

/** What goes to the core: commits with units, messages trimmed. */
export function planOf(arrangement: Arrangement): ComposeGroup[] {
  return arrangement.commits.filter((commit) => commit.units.length > 0).map((commit) => ({ title: commit.title.trim(), body: commit.body.trim(), units: [...commit.units] }));
}

/** The units the user placed, with the summary of their commit (`null` = "Don't commit"), in display order. */
export function keepOf(arrangement: Arrangement, pinned: ReadonlySet<string>): ComposeKeep[] {
  return displayOrder(arrangement)
    .filter((id) => pinned.has(id))
    .map((id) => {
      const group = groupOf(arrangement, id);
      return { unit: id, commit: group === null || group === SKIP ? null : arrangement.commits[group]!.title };
    });
}

/**
 * A new proposal with every unit the user placed where it was: into the new commit with the same
 * summary, otherwise into a commit of their own with that summary at the end, or "Don't commit".
 */
export function reproposed(fresh: Arrangement, current: Arrangement, pinned: ReadonlySet<string>, order: ReadonlyMap<string, number>): Arrangement {
  const kept = displayOrder(current).filter((id) => pinned.has(id));
  if (kept.length === 0) return fresh;
  const gone = new Set(kept);
  let skip = fresh.skip.filter((id) => !gone.has(id));
  let commits = fresh.commits.map((commit) => ({ ...commit, units: commit.units.filter((id) => !gone.has(id)) }));
  for (const id of kept) {
    const group = groupOf(current, id);
    if (group === null || group === SKIP) {
      skip.push(id);
      continue;
    }
    const source = current.commits[group]!;
    let index = commits.findIndex((commit) => commit.title.trim() !== "" && commit.title.trim() === source.title.trim());
    if (index < 0) {
      commits.push({ key: newKey(), title: source.title, body: source.body, reason: "", origin: "user", units: [] });
      index = commits.length - 1;
    }
    commits[index] = { ...commits[index]!, units: [...commits[index]!.units, id] };
  }
  skip = sorted(skip, order);
  commits = commits.map((commit) => ({ ...commit, units: sorted(commit.units, order) })).filter((commit) => commit.units.length > 0);
  return { skip, commits };
}

// ---------------------------------------------------------------------------------------------
// Keys and texts

export function keyAction(event: KeyInput, mac: boolean): KeyAction | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (other) return null;
  const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  if (vertical !== 0) {
    const delta = vertical as -1 | 1;
    if (event.altKey && !mod && !event.shiftKey) return { kind: "shift", delta };
    if (mod && !event.altKey && !event.shiftKey) return { kind: "moveCommit", delta };
    if (event.shiftKey && !event.altKey && !mod) return { kind: "extend", delta };
    if (!event.altKey && !mod && !event.shiftKey) return { kind: "step", delta };
    return null;
  }
  if (event.key === "Enter" && !event.altKey && !event.shiftKey) return mod ? { kind: "apply" } : { kind: "confirm" };
  if (event.altKey || mod) return null;
  if (event.key === "n" || event.key === "N") return { kind: "newCommit" };
  if (event.shiftKey) return null;
  if (event.key === "u" || event.key === "U") return { kind: "nextUnsure" };
  if (event.key === "F2") return { kind: "edit" };
  if (/^[0-9]$/.test(event.key)) return { kind: "to", group: event.key === "0" ? SKIP : Number(event.key) - 1 };
  return null;
}

/** The core's `job:progress` line "<n>/<total>". */
export function progressOf(line: string | undefined): { current: number; total: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(line?.trim() ?? "");
  return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
}

/** What happened to a whole file, or the hunk's line ranges. */
export function unitDetail(unit: ComposeUnit): string {
  if (unit.kind === "hunk") return unit.header.replace(/^(@@ [^@]+ @@).*$/, "$1");
  if (unit.kind === "renamed") return t("wip.compose.kind.renamed", { from: unit.oldPath ?? "" });
  return t(`wip.compose.kind.${unit.kind}`);
}
