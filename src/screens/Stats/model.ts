/**
 * Preparing the statistics for display: period presets, gap-free time series, heatmap levels,
 * code-age shares, the tip a ref points to now, the folder tree of the treemap and its
 * squarified layout. Pure functions – tested in model.test.ts.
 */
import type { RefsSnapshot, StatsBucket, StatsCodeAge, StatsFile, StatsRange } from "../../core";

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

export type AgeKey = "month" | "halfYear" | "year" | "twoYears" | "older";
export interface AgeShare {
  key: AgeKey;
  lines: number;
  /** Rounded; 0 without any line. */
  percent: number;
}

export function ageShares(age: StatsCodeAge): AgeShare[] {
  const parts: [AgeKey, number][] = [
    ["month", age.month],
    ["halfYear", age.halfYear],
    ["year", age.year],
    ["twoYears", age.twoYears],
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

// ---------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------

export interface TreeNode {
  /** Last path segment; "" for the root. */
  name: string;
  /** Path from the repository root; "" for the root. */
  path: string;
  /** Commits: of the file, or summed over the folder. */
  value: number;
  /** The file for a leaf, null for a folder. */
  file: StatsFile | null;
  /** Largest first. */
  children: TreeNode[];
}

const byValue = (a: TreeNode, b: TreeNode) => b.value - a.value || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function sortTree(node: TreeNode): void {
  node.children.sort(byValue);
  node.children.forEach(sortTree);
}

/** Folder tree of the files the core returned, with the commits as the size. */
export function buildTree(files: StatsFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", value: 0, file: null, children: [] };
  const folders = new Map<string, TreeNode>([["", root]]);
  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    root.value += file.commits;
    for (let depth = 1; depth < parts.length; depth++) {
      const path = parts.slice(0, depth).join("/");
      let folder = folders.get(path);
      if (!folder) {
        folder = { name: parts[depth - 1] ?? "", path, value: 0, file: null, children: [] };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      folder.value += file.commits;
      parent = folder;
    }
    parent.children.push({ name: parts[parts.length - 1] ?? file.path, path: file.path, value: file.commits, file, children: [] });
  }
  sortTree(root);
  return root;
}

/** The folder at `path` ("" = root); null if the tree does not have it. */
export function findNode(root: TreeNode, path: string): TreeNode | null {
  if (!path) return root;
  const parts = path.split("/");
  let node: TreeNode | undefined = root;
  for (let depth = 1; depth <= parts.length && node; depth++) {
    const prefix = parts.slice(0, depth).join("/");
    node = node.children.find((child) => child.path === prefix && !child.file);
  }
  return node ?? null;
}

/** "src/app" → "src", "src" → "". */
export const parentFolder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Tile<T> extends Rect {
  item: T;
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk 2000): lays out the items – largest first – in
 * `rect`, row by row along the shorter side, so that the tiles come out as square as possible.
 * Items with a value of 0 get no tile; the tiles fill `rect` exactly.
 */
export function squarify<T>(items: { value: number; item: T }[], rect: Rect): Tile<T>[] {
  const positive = items.filter((entry) => entry.value > 0);
  const total = positive.reduce((sum, entry) => sum + entry.value, 0);
  if (total === 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const areas = positive.map((entry) => ({ area: entry.value * scale, item: entry.item }));
  type Area = (typeof areas)[number];
  const tiles: Tile<T>[] = [];
  let free: Rect = { ...rect };

  const worst = (row: Area[], side: number) => {
    const sum = row.reduce((s, entry) => s + entry.area, 0);
    const max = Math.max(...row.map((entry) => entry.area));
    const min = Math.min(...row.map((entry) => entry.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const place = (row: Area[]) => {
    const sum = row.reduce((s, entry) => s + entry.area, 0);
    if (free.w >= free.h) {
      // A column on the left over the full height.
      const width = sum / free.h;
      let y = free.y;
      for (const entry of row) {
        const h = entry.area / width;
        tiles.push({ x: free.x, y, w: width, h, item: entry.item });
        y += h;
      }
      free = { x: free.x + width, y: free.y, w: free.w - width, h: free.h };
    } else {
      // A row at the top over the full width.
      const height = sum / free.w;
      let x = free.x;
      for (const entry of row) {
        const w = entry.area / height;
        tiles.push({ x, y: free.y, w, h: height, item: entry.item });
        x += w;
      }
      free = { x: free.x, y: free.y + height, w: free.w, h: free.h - height };
    }
  };

  let row: Area[] = [];
  for (const entry of areas) {
    const side = Math.min(free.w, free.h);
    if (row.length === 0 || worst([...row, entry], side) <= worst(row, side)) {
      row.push(entry);
    } else {
      place(row);
      row = [entry];
    }
  }
  if (row.length) place(row);
  return tiles;
}
