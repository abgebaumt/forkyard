/**
 * Pure logic of "Compose commits" (v1.2, 3.2): where each unit sits, the flat row list the view
 * draws, moves by keyboard and pointer, what blocks creating the commits and the plan for the
 * core. Without React, tested in model.test.ts.
 *
 * Order everywhere: "Don't commit" first, then the commits in the order they are created (commit 1
 * is the oldest). Inside a group the units keep the order the core listed them in. Every function
 * returns the same object when nothing changes.
 */
import type { ComposeGroup, ComposeUnit } from "../../core";
import { t } from "../../i18n";

/** The group "Don't commit" in moves and rows. */
export const SKIP = -1;

export interface DraftCommit {
  /** Stable key for list rows; does not change when the commit moves. */
  key: string;
  title: string;
  body: string;
  units: string[];
}

export interface Arrangement {
  skip: string[];
  commits: DraftCommit[];
}

export type Row = { kind: "group"; group: number; key: string } | { kind: "unit"; group: number; unit: string; key: string };

export type KeyAction = { kind: "step"; delta: -1 | 1 } | { kind: "to"; group: number } | { kind: "moveCommit"; delta: -1 | 1 } | { kind: "edit" } | { kind: "apply" };

export interface KeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type Blocked = { reason: "nothing" } | { reason: "title"; commit: number };

let commitCounter = 0;
function newKey(): string {
  commitCounter += 1;
  return `commit-${commitCounter}`;
}

/** Position of every unit in the core's list. */
export function orderOf(units: ComposeUnit[]): Map<string, number> {
  return new Map(units.map((unit, index) => [unit.id, index]));
}

function sorted(ids: string[], order: Map<string, number>): string[] {
  const at = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...ids].sort((a, b) => at(a) - at(b));
}

/** Before (or without) a suggestion: everything in "Don't commit". */
export function allSkipped(units: ComposeUnit[]): Arrangement {
  return { skip: units.map((unit) => unit.id), commits: [] };
}

/** The provider's groups. Unknown or doubled IDs are dropped; what it did not place stays in "Don't commit". */
export function fromGroups(units: ComposeUnit[], groups: ComposeGroup[]): Arrangement {
  const order = orderOf(units);
  const placed = new Set<string>();
  const commits: DraftCommit[] = [];
  for (const group of groups) {
    const ids: string[] = [];
    for (const id of group.units) {
      if (!order.has(id) || placed.has(id)) continue;
      placed.add(id);
      ids.push(id);
    }
    if (ids.length > 0) commits.push({ key: newKey(), title: group.title, body: group.body, units: sorted(ids, order) });
  }
  return { skip: units.map((unit) => unit.id).filter((id) => !placed.has(id)), commits };
}

/** After reading the changes again: known units keep their place, new ones go to "Don't commit", vanished ones are dropped. */
export function refreshed(arrangement: Arrangement, units: ComposeUnit[]): Arrangement {
  const order = orderOf(units);
  const commits = arrangement.commits.map((commit) => ({ ...commit, units: sorted(commit.units.filter((id) => order.has(id)), order) }));
  const placed = new Set(commits.flatMap((commit) => commit.units));
  return { skip: units.map((unit) => unit.id).filter((id) => !placed.has(id)), commits };
}

export function rowsOf(arrangement: Arrangement): Row[] {
  const rows: Row[] = [{ kind: "group", group: SKIP, key: "group-skip" }];
  for (const unit of arrangement.skip) rows.push({ kind: "unit", group: SKIP, unit, key: `unit-${unit}` });
  arrangement.commits.forEach((commit, index) => {
    rows.push({ kind: "group", group: index, key: `group-${commit.key}` });
    for (const unit of commit.units) rows.push({ kind: "unit", group: index, unit, key: `unit-${unit}` });
  });
  return rows;
}

export function groupOf(arrangement: Arrangement, unit: string): number | null {
  if (arrangement.skip.includes(unit)) return SKIP;
  const index = arrangement.commits.findIndex((commit) => commit.units.includes(unit));
  return index >= 0 ? index : null;
}

/** Into `target`: SKIP, a commit, or `commits.length` = a new commit at the end. */
export function moveUnit(arrangement: Arrangement, unit: string, target: number, order: Map<string, number>): Arrangement {
  const from = groupOf(arrangement, unit);
  if (from === null || from === target || target < SKIP || target > arrangement.commits.length) return arrangement;
  const without = (ids: string[]) => ids.filter((id) => id !== unit);
  let skip = without(arrangement.skip);
  let commits = arrangement.commits.map((commit) => (commit.units.includes(unit) ? { ...commit, units: without(commit.units) } : commit));
  if (target === SKIP) skip = sorted([...skip, unit], order);
  else if (target === commits.length) commits = [...commits, { key: newKey(), title: "", body: "", units: [unit] }];
  else commits = commits.map((commit, index) => (index === target ? { ...commit, units: sorted([...commit.units, unit], order) } : commit));
  return { skip, commits };
}

/** Alt+↑/↓: the previous or next group. */
export function stepUnit(arrangement: Arrangement, unit: string, delta: -1 | 1, order: Map<string, number>): Arrangement {
  const from = groupOf(arrangement, unit);
  if (from === null) return arrangement;
  return moveUnit(arrangement, unit, from + delta, order);
}

export function moveCommit(arrangement: Arrangement, index: number, delta: -1 | 1): Arrangement {
  const target = index + delta;
  const count = arrangement.commits.length;
  if (index < 0 || index >= count || target < 0 || target >= count) return arrangement;
  const commits = [...arrangement.commits];
  [commits[index], commits[target]] = [commits[target]!, commits[index]!];
  return { ...arrangement, commits };
}

export function addCommit(arrangement: Arrangement): Arrangement {
  return { ...arrangement, commits: [...arrangement.commits, { key: newKey(), title: "", body: "", units: [] }] };
}

export function setMessage(arrangement: Arrangement, index: number, title: string, body: string): Arrangement {
  return { ...arrangement, commits: arrangement.commits.map((commit, i) => (i === index ? { ...commit, title, body } : commit)) };
}

/** Pointer drop of row `from` at insertion point `to` (before row `to`): into the group of the row above. */
export function dropRow(arrangement: Arrangement, rows: Row[], from: number, to: number, order: Map<string, number>): Arrangement {
  const row = rows[from];
  if (!row || row.kind !== "unit") return arrangement;
  const above = to > 0 ? rows[to - 1] : undefined;
  return moveUnit(arrangement, row.unit, above ? above.group : SKIP, order);
}

/** "1"–"9" → commit index 0–8, "0" → SKIP. */
export function digitTarget(key: string): number | null {
  if (!/^[0-9]$/.test(key)) return null;
  return key === "0" ? SKIP : Number(key) - 1;
}

export function keyAction(event: KeyInput, mac: boolean): KeyAction | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (other) return null;
  const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  if (vertical !== 0 && !event.shiftKey) {
    if (event.altKey && !mod) return { kind: "step", delta: vertical as -1 | 1 };
    if (mod && !event.altKey) return { kind: "moveCommit", delta: vertical as -1 | 1 };
    return null;
  }
  if (event.key === "Enter" && mod && !event.altKey) return { kind: "apply" };
  if (event.altKey || mod || event.shiftKey) return null;
  if (event.key === "F2") return { kind: "edit" };
  const target = digitTarget(event.key);
  return target === null ? null : { kind: "to", group: target };
}

/** What goes to the core: commits with units, messages trimmed. */
export function planOf(arrangement: Arrangement): ComposeGroup[] {
  return arrangement.commits.filter((commit) => commit.units.length > 0).map((commit) => ({ title: commit.title.trim(), body: commit.body.trim(), units: [...commit.units] }));
}

export function blockedReason(arrangement: Arrangement): Blocked | null {
  const used = arrangement.commits.map((commit, index) => ({ commit, index })).filter(({ commit }) => commit.units.length > 0);
  if (used.length === 0) return { reason: "nothing" };
  const missing = used.find(({ commit }) => !commit.title.trim());
  return missing ? { reason: "title", commit: missing.index } : null;
}

export function sameArrangement(a: Arrangement, b: Arrangement): boolean {
  const flat = (x: Arrangement) => JSON.stringify([x.skip, x.commits.map((commit) => [commit.title, commit.body, commit.units])]);
  return flat(a) === flat(b);
}

/** The core's `job:progress` line "<n>/<total>". */
export function progressOf(line: string | undefined): { current: number; total: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(line?.trim() ?? "");
  return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
}

/** What a row says next to the path: the hunk's line ranges, or what happened to the whole file. */
export function unitDetail(unit: ComposeUnit): string {
  if (unit.kind === "hunk") return unit.header.replace(/^(@@ [^@]+ @@).*$/, "$1");
  if (unit.kind === "renamed") return t("wip.compose.kind.renamed", { from: unit.oldPath ?? "" });
  return t(`wip.compose.kind.${unit.kind}`);
}
