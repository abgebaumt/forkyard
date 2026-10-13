/**
 * Pure logic of the rebase tool: actions, groups when squashing, checks before starting, what goes
 * to the core. Without React so it can be tested (model.test.ts).
 *
 * Order everywhere: oldest commit on top, as in Git's todo file. "Squash" folds a commit into the
 * one above it (the older one) – exactly like `squash` in Git.
 */
import type { RebaseAction, RebasePlanRow, Sha } from "../../core";
import { t } from "../../i18n";

export interface ActionInfo {
  label: string;
  /** Key in the list. */
  key: string;
  /** Phrase for menu and tooltip. */
  hint: string;
}

export const ACTIONS: RebaseAction[] = ["pick", "reword", "squash", "drop"];

export const actionInfo: Record<RebaseAction, ActionInfo> = {
  pick: { label: t("rebase.action.pick.label"), key: "P", hint: t("rebase.action.pick.hint") },
  reword: { label: t("rebase.action.reword.label"), key: "R", hint: t("rebase.action.reword.hint") },
  squash: { label: t("rebase.action.squash.label"), key: "S", hint: t("rebase.action.squash.hint") },
  drop: { label: t("rebase.action.drop.label"), key: "D", hint: t("rebase.action.drop.hint") },
};

/** Key (without modifier) → action. */
export function actionForKey(key: string): RebaseAction | null {
  switch (key.toLowerCase()) {
    case "p":
      return "pick";
    case "r":
      return "reword";
    case "s":
      return "squash";
    case "d":
      return "drop";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageParts {
  summary: string;
  description: string;
}

export function joinMessage({ summary, description }: MessageParts): string {
  const body = description.replace(/\s+$/, "");
  return body ? `${summary.trim()}\n\n${body}` : summary.trim();
}

export function splitMessage(message: string): MessageParts {
  const normalized = message.replace(/\r\n/g, "\n");
  const cut = normalized.indexOf("\n");
  if (cut < 0) return { summary: normalized.trim(), description: "" };
  return { summary: normalized.slice(0, cut).trim(), description: normalized.slice(cut + 1).replace(/^\n+/, "").replace(/\s+$/, "") };
}

/** Suggested message for a squashed commit: the summary of the first, the others below. */
export function combinedMessage(commits: { summary: string; description: string }[]): MessageParts {
  const [first, ...rest] = commits;
  if (!first) return { summary: "", description: "" };
  const parts = [first.description.trim(), ...rest.map((commit) => [commit.summary.trim(), commit.description.trim()].filter(Boolean).join("\n\n"))];
  return { summary: first.summary.trim(), description: parts.filter(Boolean).join("\n\n") };
}

/** Row with its own message: the new summary, otherwise the old one. */
export function shownSummary(row: RebasePlanRow): string {
  if (row.message && (row.action === "reword" || row.action === "pick")) return splitMessage(row.message).summary || row.summary;
  return row.summary;
}

// ---------------------------------------------------------------------------
// Groups when squashing
// ---------------------------------------------------------------------------

export interface RowRole {
  /** For "Squash": index of the row the commit is folded into; null = there is none. */
  target: number | null;
  /** For pick/reword: indices of the rows folded into it. */
  squashed: number[];
}

/**
 * For each row: the target of a "Squash" is the next row above that stays (pick or reword).
 * Dropped and other squashed rows in between don't count.
 */
export function rowRoles(rows: RebasePlanRow[]): RowRole[] {
  const roles: RowRole[] = rows.map(() => ({ target: null, squashed: [] }));
  let root: number | null = null;
  rows.forEach((row, index) => {
    if (row.action === "pick" || row.action === "reword") root = index;
    else if (row.action === "squash") {
      roles[index]!.target = root;
      if (root !== null) roles[root]!.squashed.push(index);
    }
  });
  return roles;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface PlanCheck {
  /** Reason why starting is locked – or null. */
  blocked: string | null;
  /** Notice per row (index → text). */
  rowProblems: Map<number, string>;
}

export function checkPlan(rows: RebasePlanRow[], original: RebasePlanRow[]): PlanCheck {
  const rowProblems = new Map<number, string>();
  const roles = rowRoles(rows);
  // Whether the first problem is a squash without a target – that gets its own sentence for the start button.
  let firstIsOrphan: boolean | null = null;
  rows.forEach((row, index) => {
    if (row.action === "squash" && roles[index]!.target === null) {
      rowProblems.set(index, t("rebase.check.noTarget"));
      firstIsOrphan ??= true;
    }
    if (row.action === "reword" && !(row.message ?? "").trim()) {
      rowProblems.set(index, t("rebase.check.rewordMissing"));
      firstIsOrphan ??= false;
    }
  });
  let blocked: string | null = null;
  if (rows.length === 0) blocked = t("rebase.check.empty");
  else if (rows.every((row) => row.action === "drop")) blocked = t("rebase.check.allDropped");
  else if (rowProblems.size) {
    const first = [...rowProblems.values()][0]!;
    blocked = firstIsOrphan ? t("rebase.check.topSquash") : first;
  } else if (!planChanged(original, rows)) blocked = t("rebase.check.unchanged");
  return { blocked, rowProblems };
}

/** Whether order, actions or messages differ from the loaded plan. */
export function planChanged(original: RebasePlanRow[], rows: RebasePlanRow[]): boolean {
  if (orderChanged(original, rows)) return true;
  const before = new Map(original.map((row) => [row.sha, row]));
  return rows.some((row) => {
    const old = before.get(row.sha);
    if (!old) return true;
    if (row.action !== "pick") return true;
    // A message on a pick row only counts with squashed commits below it.
    return false;
  });
}

export function orderChanged(original: RebasePlanRow[], rows: RebasePlanRow[]): boolean {
  return original.length !== rows.length || original.some((row, index) => rows[index]?.sha !== row.sha);
}

/**
 * What goes to `rebase_apply`: messages only where they apply – for "Reword" and at a group's
 * target (the result's message). Otherwise null, so the core does not take over anything stale.
 */
export function payloadRows(rows: RebasePlanRow[]): RebasePlanRow[] {
  const roles = rowRoles(rows);
  return rows.map((row, index) => {
    const keepsMessage = row.action === "reword" || (row.action === "pick" && roles[index]!.squashed.length > 0);
    return { ...row, message: keepsMessage && row.message?.trim() ? row.message : null };
  });
}

/** Commits after the rebase. */
export function resultCount(rows: RebasePlanRow[]): number {
  return rows.filter((row) => row.action === "pick" || row.action === "reword").length;
}

/** Short sentence on what the plan does, e.g. "1 reworded · 2 squashed · order changed". */
export function planSummary(original: RebasePlanRow[], rows: RebasePlanRow[]): string {
  const count = (action: RebaseAction) => rows.filter((row) => row.action === action).length;
  const parts: string[] = [];
  const reword = count("reword");
  const squash = count("squash");
  const drop = count("drop");
  if (reword) parts.push(t("rebase.summary.reworded", { count: reword }));
  if (squash) parts.push(t("rebase.summary.squashed", { count: squash }));
  if (drop) parts.push(t("rebase.summary.dropped", { count: drop }));
  if (orderChanged(original, rows)) parts.push(t("rebase.summary.reordered"));
  return parts.length ? parts.join(" · ") : t("rebase.summary.unchanged");
}

// ---------------------------------------------------------------------------
// List helpers
// ---------------------------------------------------------------------------

/** Moves an element from `from` to the insertion point `to` (0 … length, before the element there). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length, to));
  if (target === from || target === from + 1) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target > from ? target - 1 : target, 0, item!);
  return next;
}

/** New position after moving `from` to the insertion point `to`. */
export function movedIndex(from: number, to: number): number {
  return to > from ? to - 1 : to;
}

/** Orders commits into a chain: oldest first, each is the parent of the next. null if it is not a gapless chain. */
export function chainOldestFirst(commits: { sha: Sha; parents: Sha[] }[]): Sha[] | null {
  if (commits.length === 0) return [];
  const shas = new Set(commits.map((commit) => commit.sha));
  const childOf = new Map<Sha, Sha>();
  let oldest: Sha | null = null;
  for (const commit of commits) {
    if (commit.parents.length > 1) return null;
    const parent = commit.parents[0];
    if (parent && shas.has(parent)) {
      if (childOf.has(parent)) return null;
      childOf.set(parent, commit.sha);
    } else {
      if (oldest) return null;
      oldest = commit.sha;
    }
  }
  if (!oldest) return null;
  const chain: Sha[] = [oldest];
  while (childOf.has(chain[chain.length - 1]!)) chain.push(childOf.get(chain[chain.length - 1]!)!);
  return chain.length === commits.length ? chain : null;
}

export const isShaLike = (value: string) => /^[0-9a-f]{7,64}$/i.test(value);
