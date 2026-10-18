/**
 * Pure logic of the agent review (src/screens/AgentReview): which files and lines are selected,
 * the `PatchSelection`s for `rangeApply`, the commit message from the task, which agents the centre
 * shows and why an action is not available. No React, no core.
 */
import type { Agent, AgentReview, DiffSource, FileChange, FileDiff, Id, PatchSelection, Status, TextDiff } from "../../core";
import type { AgentReviewShow } from "../../app/store";
import { lineKey } from "../DiffView/model";
import { t } from "../../i18n";
import { SUMMARY_LIMIT } from "../../core/limits";

/** A selected file: all its changes, or only some lines (`lineKey`s of its range diff). */
export type FilePick = { kind: "all" } | { kind: "lines"; keys: string[] };
/** Selected files by path; a missing path is “not selected”. */
export type FilePicks = Readonly<Record<string, FilePick>>;

/** Where “Selection into my working directory” puts it: unstaged, or staged (index and files). */
export type TakeOverTarget = "worktree" | "both";

// --- Files -------------------------------------------------------------------------------

/** Why a file can only come over by merging the branch; null = line by line possible. */
export function notPickable(file: FileChange): string | null {
  if (file.isBinary) return t("agents.review.onlyMerge.binary");
  if (file.isLfs) return t("agents.review.onlyMerge.lfs");
  if (file.status === "renamed") return t("agents.review.onlyMerge.renamed");
  if (file.status === "conflicted") return t("agents.review.onlyMerge.conflicted");
  return null;
}

/** At the start every line-pickable file is selected as a whole. */
export function initialPicks(files: readonly FileChange[]): FilePicks {
  const picks: Record<string, FilePick> = {};
  for (const file of files) if (notPickable(file) === null) picks[file.path] = { kind: "all" };
  return picks;
}

export function splitFiles(files: readonly FileChange[], picks: FilePicks): { chosen: FileChange[]; rest: FileChange[] } {
  const chosen: FileChange[] = [];
  const rest: FileChange[] = [];
  for (const file of files) (picks[file.path] ? chosen : rest).push(file);
  return { chosen, rest };
}

/** Selected ↔ not selected; files that can only be merged stay where they are. */
export function toggleFile(picks: FilePicks, file: FileChange): FilePicks {
  if (notPickable(file) !== null) return picks;
  const next: Record<string, FilePick> = { ...picks };
  if (next[file.path]) delete next[file.path];
  else next[file.path] = { kind: "all" };
  return next;
}

// --- Lines -------------------------------------------------------------------------------

/** Keys of all changed lines – what “all” means for this file. */
export function changedKeys(diff: TextDiff): string[] {
  const keys: string[] = [];
  diff.hunks.forEach((hunk, hunkOrd) =>
    hunk.lines.forEach((line, pos) => {
      if (line.kind !== "context") keys.push(lineKey(hunkOrd, pos));
    }),
  );
  return keys;
}

/** The check marks the diff shows for a pick. */
export function keysOf(pick: FilePick | undefined, diff: TextDiff): Set<string> {
  if (!pick) return new Set();
  return new Set(pick.kind === "all" ? changedKeys(diff) : pick.keys);
}

/** The diff's line selection as a pick: no line → not selected, every changed line → all. */
export function withLines(picks: FilePicks, path: string, keys: ReadonlySet<string>, diff: TextDiff): FilePicks {
  const all = changedKeys(diff);
  const kept = all.filter((key) => keys.has(key));
  const next: Record<string, FilePick> = { ...picks };
  if (kept.length === 0) delete next[path];
  else if (kept.length === all.length) next[path] = { kind: "all" };
  else next[path] = { kind: "lines", keys: kept };
  return next;
}

// --- Selections for rangeApply ------------------------------------------------------------

/** One file's pick as a `PatchSelection` of its range diff; null without a range token (not text, “ignore whitespace”). */
export function selectionFor(diff: FileDiff, pick: FilePick): PatchSelection | null {
  if (diff.kind !== "text" || !diff.rangeToken) return null;
  if (pick.kind === "all") return { path: diff.path, hunks: diff.hunks.map((hunk) => ({ index: hunk.index, lines: null })), expect: diff.rangeToken };
  const byHunk = new Map<number, number[]>();
  for (const key of pick.keys) {
    const [hunkOrd, pos] = key.split(":").map(Number) as [number, number];
    const hunk = diff.hunks[hunkOrd];
    const line = hunk?.lines[pos];
    if (!hunk || !line || line.kind === "context") continue;
    const list = byHunk.get(hunk.index) ?? [];
    list.push(pos);
    byHunk.set(hunk.index, list);
  }
  if (byHunk.size === 0) return null;
  return {
    path: diff.path,
    hunks: [...byHunk.entries()].sort((a, b) => a[0] - b[0]).map(([index, lines]) => ({ index, lines: lines.sort((a, b) => a - b) })),
    expect: diff.rangeToken,
  };
}

/** The selections of all picks (sorted by path) and the files that cannot be taken over line by line. */
export function buildSelections(picks: FilePicks, diffs: ReadonlyMap<string, FileDiff>): { selections: PatchSelection[]; refused: string[] } {
  const selections: PatchSelection[] = [];
  const refused: string[] = [];
  for (const path of Object.keys(picks).sort()) {
    const diff = diffs.get(path);
    const pick = picks[path];
    const selection = diff && pick ? selectionFor(diff, pick) : null;
    if (selection) selections.push(selection);
    else refused.push(path);
  }
  return { selections, refused };
}

/** The range diff of the pinned review: its two fixed commits, so diff and `rangeToken` never move. */
export function rangeSource(review: Pick<AgentReview, "from" | "to">): DiffSource {
  return { kind: "range", from: review.from, to: review.to };
}

// --- Commit message ------------------------------------------------------------------------

/** Summary = first non-empty line of the task (≤ 72 characters, cut at a space), description = the rest. */
export function commitMessageFromTask(task: string): { summary: string; description: string } {
  const lines = task.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return { summary: "", description: "" };
  const chars = [...lines[first]!.trim().replace(/\s+/g, " ")];
  let summary = chars.join("");
  let overflow = "";
  if (chars.length > SUMMARY_LIMIT) {
    const space = chars.slice(0, SUMMARY_LIMIT + 1).lastIndexOf(" ");
    const at = space > 0 ? space : SUMMARY_LIMIT;
    summary = chars.slice(0, at).join("").trimEnd();
    overflow = chars.slice(at).join("").trim();
  }
  const rest = lines.slice(first + 1).join("\n").trim();
  return { summary, description: [overflow, rest].filter(Boolean).join("\n\n") };
}

// --- Columns ---------------------------------------------------------------------------------

/** The agents the centre shows: one, or two with “A | B | side by side”. */
export function reviewColumns(agentIds: readonly Id[], show: AgentReviewShow): Id[] {
  const [first, second] = agentIds;
  if (!first) return [];
  if (!second) return [first];
  return show === "first" ? [first] : show === "second" ? [second] : [first, second];
}

/** Agents that can be added for comparison. */
export function compareCandidates(agents: readonly Agent[], current: readonly Id[]): Agent[] {
  return agents.filter((agent) => agent.status !== "orphaned" && !current.includes(agent.id));
}

// --- Blockers ----------------------------------------------------------------------------------

export type ReviewAction = "takeOver" | "commit" | "merge" | "rebase" | "discard";

export interface ReviewFacts {
  agent: Agent;
  /** The agent's current state from `agentReview` (not the pinned one); null while loading. */
  latest: AgentReview | null;
  /** Number of selected files. */
  chosen: number;
  /** Status of your own repository. */
  status: Pick<Status, "staged" | "operation"> | undefined;
  /** Summary in the commit panel. */
  summary: string;
}

/** Why an action cannot run now; null = it can. */
export function blocker(action: ReviewAction, facts: ReviewFacts): string | null {
  const { agent, latest } = facts;
  if (!latest) return t("agents.review.blocked.loading");
  const running = agent.terminalId !== null;
  switch (action) {
    case "takeOver":
      return facts.chosen === 0 ? t("agents.review.blocked.nothingChosen") : null;
    case "commit":
      if (facts.chosen === 0) return t("agents.review.blocked.nothingChosen");
      if (facts.status?.operation) return t("agents.review.blocked.operation");
      if ((facts.status?.staged.length ?? 0) > 0) return t("agents.review.blocked.staged");
      if (!facts.summary.trim()) return t("agents.review.blocked.summary");
      return null;
    case "merge":
      return agent.commitsAhead === 0 ? t("agents.review.blocked.noCommits") : null;
    case "rebase":
      if (!agent.worktreeRepoId) return t("agents.review.blocked.noWorktree");
      if (running) return t("agents.review.blocked.running");
      if (latest.uncommittedFiles > 0) return t("agents.review.blocked.uncommitted", { count: latest.uncommittedFiles });
      return null;
    case "discard":
      if (!agent.worktreeRepoId) return t("agents.review.blocked.noWorktree");
      if (running) return t("agents.review.blocked.running");
      if (latest.uncommittedFiles === 0) return t("agents.review.blocked.nothingToDiscard");
      return null;
  }
}
