/**
 * What the cards of the statistics view need beyond the raw numbers: one colour per author
 * (the same in Authors and Knowledge), the share segments per folder, which folders to show,
 * hotspot severity, the ticks of the time axis and the status text in the header. Pure
 * functions – tested in layout.test.ts.
 */
import type { Person, StatsAuthor, StatsBucket, StatsFolder } from "../../core";
import type { StatsState } from "./state";

/** Lane colours (`lane-1` … `lane-8`) for the authors with the most commits. */
export const AUTHOR_LANES = 8;

/** The core counts a person by the address in lower case (without one: the name). */
const personKey = (person: Person) => {
  const email = person.email.trim().toLowerCase();
  return email ? email : `name:${person.name.trim()}`;
};

export interface AuthorPalette {
  /** Lane 1–8, or null for an author without an own colour. */
  of(person: Person): number | null;
}

/** `authors` as the core sorts them (most commits first). */
export function authorPalette(authors: StatsAuthor[]): AuthorPalette {
  const lanes = new Map<string, number>();
  for (const author of authors) {
    if (lanes.size >= AUTHOR_LANES) break;
    const key = personKey(author);
    if (!lanes.has(key)) lanes.set(key, lanes.size + 1);
  }
  return { of: (person) => lanes.get(personKey(person)) ?? null };
}

/** "Maya Chen" → "MC": first letters of the first and the last name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0];
  if (!first) return "?";
  const last = words.length > 1 ? words[words.length - 1]![0]! : "";
  return (first + last).toUpperCase();
}

export interface ShareSegment {
  /** null: all other authors together. */
  name: string | null;
  email: string | null;
  /** Of the folder's weight, not rounded (for the bar width). */
  percent: number;
  lane: number | null;
}

/** The bar of a folder: one segment per named author, then the others. */
export function folderSegments(folder: StatsFolder, palette: AuthorPalette): ShareSegment[] {
  if (folder.weight <= 0) return [];
  const segments: ShareSegment[] = folder.top
    .filter((share) => share.weight > 0)
    .map((share) => ({ name: share.author.name, email: share.author.email, percent: (share.weight / folder.weight) * 100, lane: palette.of(share.author) }));
  const named = folder.top.reduce((sum, share) => sum + share.weight, 0);
  if (named < folder.weight) segments.push({ name: null, email: null, percent: ((folder.weight - named) / folder.weight) * 100, lane: null });
  return segments;
}

/**
 * The heaviest of the innermost folders the core reports (a folder whose subfolders are listed
 * gives way to them); the root only if the repository has no folder.
 */
export function knowledgeRows(folders: StatsFolder[], limit: number): StatsFolder[] {
  const paths = folders.map((folder) => folder.path).filter(Boolean);
  const below = folders.filter((folder) => folder.path !== "" && !paths.some((path) => path.startsWith(`${folder.path}/`)));
  const rows = below.length ? below : folders;
  return [...rows].sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1)).slice(0, limit);
}

export type Severity = "high" | "medium" | "low";

/** How hot a hotspot is compared with the hottest one. */
export function hotspotSeverity(score: number, max: number): Severity {
  if (max <= 0) return "low";
  const ratio = score / max;
  return ratio >= 0.75 ? "high" : ratio >= 0.45 ? "medium" : "low";
}

export interface TimeTick {
  /** Index of the bucket. */
  index: number;
  /** The month the tick names ("YYYY-MM"). */
  period: string;
}

/** A tick at the first bucket of every month, at most `limit` of them (evenly thinned). */
export function timeTicks(buckets: StatsBucket[], limit: number): TimeTick[] {
  const ticks: TimeTick[] = [];
  let month = "";
  buckets.forEach((bucket, index) => {
    const period = bucket.period.slice(0, 7);
    if (period !== month) ticks.push({ index, period });
    month = period;
  });
  if (ticks.length <= limit) return ticks;
  const step = Math.ceil(ticks.length / Math.max(1, limit));
  return ticks.filter((_, n) => n % step === 0);
}

export type StatsStatus = "updating" | "cached" | "fresh";

/** The status text next to the choice: a run is going, or where the shown numbers came from. */
export function statusOf(state: StatsState): StatsStatus | null {
  if (state.kind === "running") return "updating";
  if (state.kind !== "done" || !state.stats.tip) return null;
  return state.stats.cached ? "cached" : "fresh";
}
