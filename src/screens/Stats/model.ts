/**
 * Preparing the statistics for display: period presets, gap-free time series, heatmap levels,
 * code-age shares and the tip a ref points to now. Pure functions – tested in model.test.ts.
 */
import type { RefsSnapshot, StatsBucket, StatsCodeAge, StatsRange } from "../../core";

// ---------------------------------------------------------------------------
// Periods and time series
// ---------------------------------------------------------------------------

export type StatsPreset = "all" | "year" | "quarter" | "month";
export const PRESETS: readonly StatsPreset[] = ["all", "year", "quarter", "month"];
const PRESET_DAYS: Record<Exclude<StatsPreset, "all">, number> = { year: 365, quarter: 90, month: 30 };
const DAY_MS = 86_400_000;

/**
 * The range for a preset. `from` is midnight (UTC) `n` days before today, so that the same
 * choice hits the core's cache for the rest of the day; `to` stays open.
 */
export function rangeFor(preset: StatsPreset, ref: string, now: number = Date.now()): StatsRange {
  if (preset === "all") return { from: null, to: null, ref };
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return { from: new Date(today - PRESET_DAYS[preset] * DAY_MS).toISOString(), to: null, ref };
}

export type Granularity = "weeks" | "months";
/** Weeks as long as there are at most two years of them, otherwise months. */
export const WEEKS_LIMIT = 104;
export const defaultGranularity = (weeks: StatsBucket[]): Granularity => (weeks.length <= WEEKS_LIMIT ? "weeks" : "months");

/** More buckets are not drawn (a very old repository by weeks). */
const MAX_BUCKETS = 2000;

function fill(buckets: StatsBucket[], next: (period: string) => string): StatsBucket[] {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (!first || !last) return [];
  const known = new Map(buckets.map((bucket) => [bucket.period, bucket]));
  const out: StatsBucket[] = [];
  for (let period = first.period; out.length < MAX_BUCKETS; period = next(period)) {
    out.push(known.get(period) ?? { period, commits: 0, added: 0, removed: 0 });
    if (period >= last.period) break;
  }
  return out;
}

/** Week buckets ("YYYY-MM-DD", Mondays) without gaps: missing weeks come with zeros. */
export function fillWeeks(buckets: StatsBucket[]): StatsBucket[] {
  return fill(buckets, (period) => {
    const date = new Date(`${period}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 7);
    return date.toISOString().slice(0, 10);
  });
}

/** Month buckets ("YYYY-MM") without gaps. */
export function fillMonths(buckets: StatsBucket[]): StatsBucket[] {
  return fill(buckets, (period) => {
    const [year = 0, month = 1] = period.split("-").map(Number);
    return month >= 12 ? `${String(year + 1).padStart(4, "0")}-01` : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
  });
}

// ---------------------------------------------------------------------------
// Heatmap, code age, tip
// ---------------------------------------------------------------------------

/** Level 0–4 per cell: 0 = no commit, otherwise quarters of the busiest cell (any commit at least 1). */
export function heatLevels(heatmap: number[][]): number[][] {
  const max = Math.max(0, ...heatmap.flat());
  return heatmap.map((row) => row.map((count) => (count <= 0 || max === 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4)))));
}

export type AgeKey = "month" | "year" | "threeYears" | "older";
export interface AgeShare {
  key: AgeKey;
  lines: number;
  /** Rounded; 0 without any line. */
  percent: number;
}

export function ageShares(age: StatsCodeAge): AgeShare[] {
  const parts: [AgeKey, number][] = [
    ["month", age.month],
    ["year", age.year],
    ["threeYears", age.threeYears],
    ["older", age.older],
  ];
  const total = parts.reduce((sum, [, lines]) => sum + lines, 0);
  return parts.map(([key, lines]) => ({ key, lines, percent: total === 0 ? 0 : Math.round((lines / total) * 100) }));
}

/**
 * The commit `ref` points to now – to notice that the statistics are out of date.
 * Unknown here (tags, refs not loaded yet): null.
 */
export function currentTip(refs: RefsSnapshot | undefined, ref: string): string | null {
  if (!refs) return null;
  if (ref === "HEAD") return refs.head.kind === "unborn" ? null : refs.head.sha;
  return [...refs.locals, ...refs.remotes].find((item) => item.fullName === ref)?.sha ?? null;
}
