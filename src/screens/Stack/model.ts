/**
 * Pure rules of the stacked pull requests view (Paket 8.1): cuts between commits, placing a
 * suggestion, the texts and targets of the pull requests, the default base, the tone of a check
 * state, what pushing needs, and the keys of the commit list.
 */
import type { AiStackSplit, PushResult, Ref, RefsSnapshot, StackCheckState, StackCommit, StackCut, StackPrPart, StackStatus } from "../../core";

export interface DraftPart {
  /** The part ends after commit `end` (1 = the oldest commit). */
  end: number;
  /** Words for the branch name; empty = the subject of the part's first commit. */
  name: string;
  /** Pull request title; null = the subject of the part's first commit. */
  title: string | null;
  /** The AI's reason while the part is as suggested. */
  why: string | null;
}

export function singlePart(commitCount: number): DraftPart[] {
  return [{ end: commitCount, name: "", title: null, why: null }];
}

/** Still the plan the view opened with: one part, no name, no title. */
export function isUntouched(parts: DraftPart[] | null, commitCount: number): boolean {
  if (!parts) return true;
  const [only] = parts;
  return parts.length === 1 && only !== undefined && only.end === commitCount && only.name === "" && only.title === null;
}

export function ranges(parts: DraftPart[]): { first: number; end: number }[] {
  let first = 1;
  return parts.map((part) => {
    const range = { first, end: part.end };
    first = part.end + 1;
    return range;
  });
}

export function cutsOf(parts: DraftPart[]): StackCut[] {
  return parts.map((part) => ({ end: part.end, name: part.name.trim() }));
}

/** A part ends after this commit (and it is not the last commit). */
export function isCutAfter(parts: DraftPart[], commit: number): boolean {
  return parts.slice(0, -1).some((part) => part.end === commit);
}

/**
 * Splits the part containing commit `after` behind it – the new lower part starts without name and
 * title – or, if a part already ends there, joins it with the next one (the lower name and title win).
 */
export function toggleCut(parts: DraftPart[], after: number, total: number): DraftPart[] {
  const index = parts.findIndex((part, i) => part.end === after && i < parts.length - 1);
  if (index >= 0) {
    const lower = parts[index]!;
    const upper = parts[index + 1]!;
    const joined: DraftPart = { end: upper.end, name: lower.name || upper.name, title: lower.title ?? upper.title, why: null };
    return [...parts.slice(0, index), joined, ...parts.slice(index + 2)];
  }
  if (after < 1 || after >= total) return parts;
  const at = parts.findIndex((part) => part.end > after);
  if (at < 0) return parts;
  const part = parts[at]!;
  return [...parts.slice(0, at), { end: after, name: "", title: null, why: null }, { ...part, why: null }, ...parts.slice(at + 1)];
}

export function fromSuggestion(split: AiStackSplit): DraftPart[] {
  return split.parts.map((part) => ({ end: part.end, name: part.name, title: part.title || null, why: part.why || null }));
}

export type SplitPlacement = "insert" | "choose" | "ready";

const sameParts = (a: DraftPart[] | null, b: DraftPart[] | null) =>
  JSON.stringify((a ?? []).map((part) => [part.end, part.name, part.title])) === JSON.stringify((b ?? []).map((part) => [part.end, part.name, part.title]));

/** "Umgang mit Vorschlägen": an untouched plan takes it; own cuts get an offer ("ready" if they changed meanwhile). */
export function placeSplit(current: DraftPart[] | null, atStart: DraftPart[] | null, commitCount: number): SplitPlacement {
  if (isUntouched(current, commitCount)) return "insert";
  return sameParts(current, atStart) ? "choose" : "ready";
}

export function titleOf(part: DraftPart, commits: StackCommit[], first: number): string {
  return part.title ?? commits[first - 1]?.subject ?? "";
}

export function defaultBody(subjects: string[]): string {
  return subjects.map((subject) => `- ${subject}`).join("\n");
}

/** Title (remembered → first subject → branch name) and body (the subjects) of every part. */
export function prParts(status: StackStatus, titles: Record<string, string>): StackPrPart[] {
  return status.parts.map((part) => ({
    branch: part.branch,
    title: (titles[part.branch] ?? "").trim() || part.subjects[0] || part.branch,
    body: defaultBody(part.subjects),
    draft: false,
  }));
}

/** The target of each part's pull request: the base's name on the host, then the part below. */
export function prTargets(status: StackStatus): string[] {
  return status.parts.map((_, index) => (index === 0 ? status.baseName : status.parts[index - 1]!.branch));
}

export function firstWithoutPr(status: StackStatus, hasPr: (branch: string) => boolean): number {
  const index = status.parts.findIndex((part) => !hasPr(part.branch));
  return index < 0 ? status.parts.length : index;
}

/** The host's default branch on its remote, else locally, else origin/main, main, master – never the split branch. */
export function defaultBase(refs: RefsSnapshot | undefined, remote: string | null, defaultBranch: string | null, source: string): string | null {
  if (!refs) return null;
  const known = new Set([...refs.locals, ...refs.remotes].map((item) => item.fullName));
  const candidates = [
    remote && defaultBranch ? `refs/remotes/${remote}/${defaultBranch}` : null,
    defaultBranch ? `refs/heads/${defaultBranch}` : null,
    "refs/remotes/origin/main",
    "refs/heads/main",
    "refs/remotes/origin/master",
    "refs/heads/master",
  ];
  return candidates.find((candidate): candidate is string => candidate !== null && known.has(candidate) && candidate !== `refs/heads/${source}`) ?? null;
}

export function baseOptions(refs: RefsSnapshot | undefined, source: string): { value: string; label: string }[] {
  if (!refs) return [];
  return [...refs.locals.filter((item) => item.name !== source), ...refs.remotes.filter((item) => !item.name.endsWith("/HEAD"))].map((item) => ({ value: item.fullName, label: item.name }));
}

export type CheckTone = "accent" | "success" | "danger" | "warning";

export function checkTone(state: StackCheckState | "running"): CheckTone {
  switch (state) {
    case "running":
      return "accent";
    case "passed":
      return "success";
    case "failed":
      return "danger";
    case "timed_out":
      return "warning";
  }
}

/** Every part has its upstream on `remote` and is neither ahead nor behind it. */
export function allPushed(status: StackStatus, locals: Ref[], remote: string): boolean {
  return status.parts.every((part) => {
    const local = locals.find((item) => item.name === part.branch);
    return Boolean(local && local.upstream === `${remote}/${part.branch}` && !local.upstreamGone && local.ahead === 0 && local.behind === 0);
  });
}

/** A part is behind its upstream (rewritten by a restack): the push needs `--force-with-lease`. */
export function needsForce(status: StackStatus, locals: Ref[]): boolean {
  return status.parts.some((part) => {
    const local = locals.find((item) => item.name === part.branch);
    return Boolean(local?.upstream && !local.upstreamGone && local.behind > 0);
  });
}

export function rejectedRefs(result: PushResult): string[] {
  if (result.status === "rejected") return [result.reason];
  if (result.status !== "multi") return [];
  return result.refs.filter((item) => item.status === "rejected").map((item) => `${item.remoteRef.replace(/^refs\/heads\//, "")}: ${item.reason ?? ""}`.trim());
}

export type ListKey = { kind: "move"; index: number } | { kind: "toggle" } | null;

/** Keys of the commit list; `modified`: Ctrl, Alt, Meta or Shift held. */
export function listKey(key: string, modified: boolean, index: number, count: number): ListKey {
  if (modified || count === 0) return null;
  const clamp = (next: number) => ({ kind: "move" as const, index: Math.min(count - 1, Math.max(0, next)) });
  switch (key) {
    case "ArrowDown":
      return clamp(index + 1);
    case "ArrowUp":
      return clamp(index - 1);
    case "Home":
      return clamp(0);
    case "End":
      return clamp(count - 1);
    case " ":
      return { kind: "toggle" };
    default:
      return null;
  }
}
