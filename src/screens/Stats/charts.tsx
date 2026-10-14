/**
 * The cards' diagrams. Colours only through token classes (fill-accent, fill-lane-n, bg-lane-n,
 * text-success …), so they read in light and dark; the same author keeps the same lane colour
 * in Authors and Knowledge (layout.ts `authorPalette`). Every mark carries a tooltip (title)
 * and a name for screen readers; tiles and rows that lead somewhere are buttons.
 */
import type { ReactNode } from "react";
import type { StatsAuthor, StatsBucket, StatsCodeAge, StatsFolder, StatsHotspot, StatsRecords } from "../../core";
import { locale, t } from "../../i18n";
import { cn } from "../../ui/cn";
import { folderSegments, hotspotSeverity, initials, timeTicks, type AuthorPalette, type Severity } from "./layout";
import { ageShares, heatLevels, squarify, type AgeKey, type TreeNode } from "./model";

const numbers = new Intl.NumberFormat(locale());
const compact = new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 });
const percents = new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 });
const monthFormat = new Intl.DateTimeFormat(locale(), { month: "short", year: "numeric", timeZone: "UTC" });
const shortMonth = new Intl.DateTimeFormat(locale(), { month: "short", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "UTC" });
const rangeFormat = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const weekdayFormat = new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" });

export const formatCount = (value: number) => numbers.format(value);
/** 3100 → "3.1K" (in the UI language). */
export const formatCompact = (value: number) => compact.format(value);
/** 45 → "45%" (in the UI language). */
export const formatPercent = (value: number) => percents.format(value / 100);

const toDate = (period: string) => new Date(period.length === 7 ? `${period}-01T00:00:00Z` : `${period}T00:00:00Z`);

/** "2025-06" → "Jun 2025", "2025-06-02" → "Jun 2, 2025" (in the UI language). */
export function formatPeriod(period: string): string {
  const date = toDate(period);
  if (Number.isNaN(date.getTime())) return period;
  return period.length === 7 ? monthFormat.format(date) : dayFormat.format(date);
}

/** "2025-03-03" … "2025-03-25" → "March 3 – 25, 2025" (in the UI language). */
export function formatDayRange(start: string, end: string): string {
  const from = toDate(start);
  const to = toDate(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${start} – ${end}`;
  return start === end ? rangeFormat.format(from) : rangeFormat.formatRange(from, to);
}

/** Short weekday names, Monday first (2024-01-01 was a Monday). */
const WEEKDAYS = Array.from({ length: 7 }, (_, day) => weekdayFormat.format(new Date(Date.UTC(2024, 0, 1 + day))));
const HEAT_FILLS = ["fill-surface-sunken", "fill-accent/25", "fill-accent/50", "fill-accent/75", "fill-accent"];
/** Full class names, so Tailwind finds them. */
const LANE_BGS = ["bg-lane-1", "bg-lane-2", "bg-lane-3", "bg-lane-4", "bg-lane-5", "bg-lane-6", "bg-lane-7", "bg-lane-8"];
const laneBg = (lane: number | null) => (lane ? (LANE_BGS[lane - 1] ?? "bg-text-disabled") : "bg-text-disabled");
const SEVERITY_BG: Record<Severity, string> = { high: "bg-danger", medium: "bg-warning", low: "bg-lane-1" };
const AGE_LABELS: Record<AgeKey, string> = {
  month: t("stats.age.month"),
  halfYear: t("stats.age.halfYear"),
  year: t("stats.age.year"),
  twoYears: t("stats.age.twoYears"),
  older: t("stats.age.older"),
};

/** Horizontal bar 0–100 % on a sunken track. */
function Meter({ percent, className }: { percent: number; className: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-pill bg-surface-sunken" aria-hidden>
      <span className={cn("block h-full rounded-pill", className)} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Activity: weekday × hour
// ---------------------------------------------------------------------------

const CELL = 12;
const GAP = 2;
const DAY_LABEL = 26;
const HOUR_LABEL = 12;

export function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const levels = heatLevels(heatmap);
  const width = DAY_LABEL + 24 * (CELL + GAP);
  const height = 7 * (CELL + GAP) + HOUR_LABEL;
  return (
    <svg data-stats-heatmap="" role="img" aria-label={t("stats.heatmap.label")} viewBox={`0 0 ${width} ${height}`} className="w-full">
      {levels.map((row, day) => (
        <g key={day}>
          <text x={0} y={day * (CELL + GAP) + CELL - 3} fontSize={8} className="fill-text-muted">
            {WEEKDAYS[day]}
          </text>
          {row.map((level, hour) => (
            <rect
              key={hour}
              data-cell={`${day}-${hour}`}
              x={DAY_LABEL + hour * (CELL + GAP)}
              y={day * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={2}
              className={HEAT_FILLS[level] ?? HEAT_FILLS[0]}
            >
              <title>{t("stats.heatmap.cell", { day: WEEKDAYS[day], hour, count: heatmap[day]?.[hour] ?? 0 })}</title>
            </rect>
          ))}
        </g>
      ))}
      {[0, 6, 12, 18].map((hour) => (
        <text key={hour} x={DAY_LABEL + hour * (CELL + GAP)} y={height - 2} fontSize={8} className="fill-text-muted">
          {String(hour).padStart(2, "0")}
        </text>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Commits over time
// ---------------------------------------------------------------------------

const TIME_WIDTH = 600;
const TIME_HEIGHT = 160;
const MAX_TICKS = 7;
/** A few buckets do not become wide blocks. */
const MAX_BAR = 16;

export function TimeChart({ buckets }: { buckets: StatsBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.commits));
  const step = TIME_WIDTH / Math.max(1, buckets.length);
  const ticks = timeTicks(buckets, MAX_TICKS);
  const years = new Set(ticks.map((tick) => tick.period.slice(0, 4))).size;
  const tickLabel = (period: string) => (years > 1 ? monthFormat.format(toDate(period)) : shortMonth.format(toDate(period)));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <svg data-stats-time="" role="img" aria-label={t("stats.time.label")} viewBox={`0 0 ${TIME_WIDTH} ${TIME_HEIGHT}`} preserveAspectRatio="none" className="h-40 w-full">
        {buckets.map((bucket, index) => {
          const height = (bucket.commits / max) * (TIME_HEIGHT - 4);
          const width = Math.min(Math.max(step * 0.7, 0.5), MAX_BAR);
          return (
            <rect key={bucket.period} data-period={bucket.period} x={index * step + (step - width) / 2} y={TIME_HEIGHT - height} width={width} height={height} rx={1} className="fill-lane-3">
              <title>{t("stats.time.bar", { period: formatPeriod(bucket.period), count: bucket.commits })}</title>
            </rect>
          );
        })}
      </svg>
      <div className="relative h-4 text-sm text-text-muted" aria-hidden>
        {ticks.map((tick) => (
          <span key={tick.period} className="absolute top-0 -translate-x-1/2 whitespace-nowrap first:translate-x-0" style={{ left: `${((tick.index + 0.5) / Math.max(1, buckets.length)) * 100}%` }}>
            {tickLabel(tick.period)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function Record({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-lg font-semibold text-text tabular-nums">{value}</dd>
      {detail ? <dd className="min-w-0 truncate text-sm text-text-muted">{detail}</dd> : null}
    </div>
  );
}

/** `biggest`: message and author of the biggest commit, once loaded (the core's numbers name only its SHA). */
export function Records({ records, biggest, onCommit }: { records: StatsRecords; biggest?: { summary: string; author: string } | null; onCommit(sha: string): void }) {
  const { longestStreak, biggestCommit, busiestDay } = records;
  const none = t("stats.records.none");
  return (
    <dl data-stats-records="" className="flex flex-col gap-3">
      <Record
        label={t("stats.records.streak")}
        value={longestStreak ? t("stats.records.days", { count: longestStreak.days }) : none}
        detail={longestStreak ? formatDayRange(longestStreak.start, longestStreak.end) : undefined}
      />
      <Record
        label={t("stats.records.biggest")}
        value={
          biggestCommit ? (
            <span>
              <span className="text-success">+{formatCount(biggestCommit.added)}</span> <span className="text-danger">−{formatCount(biggestCommit.removed)}</span>
            </span>
          ) : (
            none
          )
        }
        detail={
          biggestCommit ? (
            <button
              type="button"
              data-record-commit={biggestCommit.sha}
              title={t("stats.records.showCommit", { sha: biggestCommit.sha.slice(0, 7) })}
              className="max-w-full truncate text-left hover:text-text hover:underline"
              onClick={() => onCommit(biggestCommit.sha)}
            >
              {biggest ? `${biggest.summary} · ${biggest.author}` : t("stats.records.showCommit", { sha: biggestCommit.sha.slice(0, 7) })}
            </button>
          ) : undefined
        }
      />
      <Record
        label={t("stats.records.busiest")}
        value={busiestDay ? t("stats.records.commits", { count: busiestDay.commits }) : none}
        detail={busiestDay ? formatPeriod(busiestDay.date) : undefined}
      />
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Where changes happen (treemap)
// ---------------------------------------------------------------------------

/** More tiles per level are not drawn (they would be too small to hit). */
const MAX_TILES = 120;
const MAP_W = 100;
const MAP_H = 50;

export function Treemap({ node, onFile, onFolder }: { node: TreeNode; onFile(path: string): void; onFolder(path: string): void }) {
  const tiles = squarify(
    node.children.slice(0, MAX_TILES).map((child) => ({ value: child.value, item: child })),
    { x: 0, y: 0, w: MAP_W, h: MAP_H },
  );
  const open = (child: TreeNode) => (child.file ? onFile(child.path) : onFolder(child.path));
  return (
    <div data-stats-treemap="" role="group" aria-label={t("stats.treemap.label", { path: node.path || t("stats.treemap.root") })} className="relative aspect-[2/1] w-full">
      {tiles.map((tile, index) => {
        const child = tile.item;
        const label = child.file ? t("stats.treemap.file", { path: child.path, count: child.value }) : t("stats.treemap.folder", { path: child.path, count: child.value });
        const big = tile.w > 9 && tile.h > 7;
        return (
          <button
            key={child.path}
            type="button"
            data-tile={child.path}
            data-kind={child.file ? "file" : "folder"}
            aria-label={label}
            title={label}
            className={cn(
              "absolute flex flex-col items-start justify-start overflow-hidden rounded-sm border-2 border-surface p-1.5 text-left text-on-lane",
              "hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
              LANE_BGS[index % LANE_BGS.length],
              child.file ? "opacity-80" : "",
            )}
            style={{ left: `${tile.x}%`, top: `${(tile.y / MAP_H) * 100}%`, width: `${tile.w}%`, height: `${(tile.h / MAP_H) * 100}%` }}
            onClick={() => open(child)}
          >
            {big ? (
              <span className="flex min-w-0 flex-col leading-tight" aria-hidden>
                <span className="truncate text-sm font-semibold">{child.file ? child.name : `${child.name}/`}</span>
                <span className="truncate text-sm tabular-nums">
                  {index === 0 ? t("stats.treemap.changes", { count: child.value, n: formatCount(child.value) }) : formatCount(child.value)}
                </span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hotspots
// ---------------------------------------------------------------------------

export function HotspotList({ hotspots, onFile, limit = 8 }: { hotspots: StatsHotspot[]; onFile(path: string): void; limit?: number }) {
  if (hotspots.length === 0) return <p className="text-base text-text-muted">{t("stats.hotspots.empty")}</p>;
  const shown = hotspots.slice(0, limit);
  const max = Math.max(1, ...shown.map((spot) => spot.score));
  return (
    <table data-stats-hotspots="" className="w-full table-fixed text-base">
      <thead className="text-left text-sm text-text-muted">
        <tr>
          <th className="py-1 font-normal">{t("stats.hotspots.file")}</th>
          <th className="w-20 py-1 text-right font-normal">{t("stats.hotspots.changes")}</th>
          <th className="w-20 py-1 text-right font-normal">{t("stats.hotspots.authors")}</th>
          <th className="w-1/4 py-1">
            <span className="sr-only">{t("stats.hotspots.score")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {shown.map((spot) => {
          const severity = hotspotSeverity(spot.score, max);
          return (
            <tr key={spot.path} data-severity={severity}>
              <td className="py-1 pr-2">
                <button
                  type="button"
                  data-hotspot={spot.path}
                  aria-label={t("stats.hotspots.open", { path: spot.path })}
                  title={spot.path}
                  className="block max-w-full truncate font-mono text-code text-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => onFile(spot.path)}
                >
                  {spot.path}
                </button>
              </td>
              <td className="py-1 text-right text-text-muted tabular-nums">{formatCount(spot.commits)}</td>
              <td className="py-1 text-right text-text-muted tabular-nums">{formatCount(spot.authors)}</td>
              <td className="py-1 pl-4">
                <Meter percent={(spot.score / max) * 100} className={SEVERITY_BG[severity]} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

export function Avatar({ name, lane }: { name: string; lane: number | null }) {
  return (
    <span aria-hidden className={cn("flex size-5 shrink-0 items-center justify-center rounded-pill text-xs font-semibold text-on-lane", laneBg(lane))}>
      {initials(name)}
    </span>
  );
}

export function AuthorsList({ authors, total, palette, limit = 8 }: { authors: StatsAuthor[]; total: number; palette: AuthorPalette; limit?: number }) {
  const shown = authors.slice(0, limit);
  return (
    <div className="flex flex-col gap-2">
      <ul data-stats-authors="" className="flex flex-col gap-1.5">
        {shown.map((author) => (
          <li key={`${author.email}|${author.name}`} data-author={author.email} className="flex min-w-0 items-center gap-2 text-base">
            <Avatar name={author.name} lane={palette.of(author)} />
            <span className="min-w-0 flex-1 truncate text-text" title={author.email}>
              {author.name}
            </span>
            <span className="w-12 shrink-0 text-right text-text-muted tabular-nums" title={t("stats.authors.commits")}>
              {formatCount(author.commits)}
            </span>
            <span className="w-20 shrink-0 text-right text-success tabular-nums" title={t("stats.authors.added")}>
              +{formatCount(author.added)}
            </span>
            <span className="w-16 shrink-0 text-right text-danger tabular-nums" title={t("stats.authors.removed")}>
              −{formatCount(author.removed)}
            </span>
          </li>
        ))}
      </ul>
      {total > shown.length ? <p className="text-sm text-text-muted">{t("stats.authors.more", { count: total - shown.length })}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge per folder
// ---------------------------------------------------------------------------

export function KnowledgeTable({ folders, palette, onFolder }: { folders: StatsFolder[]; palette: AuthorPalette; onFolder(path: string): void }) {
  return (
    <table data-stats-knowledge="" className="w-full table-fixed text-base">
      <thead className="text-left text-sm text-text-muted">
        <tr>
          <th className="w-1/4 py-1 font-normal">{t("stats.knowledge.folder")}</th>
          <th className="py-1 font-normal">{t("stats.knowledge.lines")}</th>
          <th className="w-24 py-1 text-right font-normal">{t("stats.knowledge.busFactor")}</th>
        </tr>
      </thead>
      <tbody>
        {folders.map((folder) => {
          const name = folder.path ? `${folder.path}/` : t("stats.knowledge.root");
          const segments = folderSegments(folder, palette);
          return (
            <tr key={folder.path} data-folder={folder.path}>
              <td className="py-1 pr-2">
                <button
                  type="button"
                  aria-label={t("stats.knowledge.open", { path: name })}
                  title={name}
                  className="block max-w-full truncate font-mono text-code text-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => onFolder(folder.path)}
                >
                  {name}
                </button>
              </td>
              <td className="py-1">
                <span className="flex h-1.5 w-full gap-px overflow-hidden rounded-pill bg-surface-sunken">
                  {segments.map((segment, index) => (
                    <span
                      key={segment.email ?? `others-${index}`}
                      data-share={segment.email ?? "others"}
                      title={`${segment.name ?? t("stats.knowledge.others")}: ${formatPercent(Math.round(segment.percent))}`}
                      className={cn("h-full", laneBg(segment.lane))}
                      style={{ width: `${segment.percent}%` }}
                    />
                  ))}
                </span>
              </td>
              <td className={cn("py-1 text-right font-semibold tabular-nums", folder.busFactor === 1 ? "text-danger" : folder.busFactor === 2 ? "text-warning" : "text-success")}>
                {folder.busFactor}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Code age
// ---------------------------------------------------------------------------

export function CodeAgeChart({ age }: { age: StatsCodeAge }) {
  if (age.files === 0) return <p className="text-base text-text-muted">{t("stats.age.none")}</p>;
  const shares = ageShares(age);
  const max = Math.max(1, ...shares.map((share) => share.lines));
  return (
    <div data-stats-age="" className="flex min-h-0 flex-1 flex-col gap-2">
      <div role="img" aria-label={t("stats.age.label")} className="flex h-40 items-end gap-3">
        {shares.map((share) => (
          <div key={share.key} data-age={share.key} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${AGE_LABELS[share.key]}: ${t("stats.age.lines", { count: share.lines })}`}>
            <span className="text-sm font-semibold text-text tabular-nums">{formatCompact(share.lines)}</span>
            <span className="w-full rounded-t-sm bg-lane-5" style={{ height: `${(share.lines / max) * 80}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-3 text-sm text-text-muted" aria-hidden>
        {shares.map((share) => (
          <span key={share.key} className="min-w-0 flex-1 truncate text-center">
            {AGE_LABELS[share.key]}
          </span>
        ))}
      </div>
      {age.skipped > 0 ? <p className="text-sm text-text-muted">{t("stats.age.skipped", { count: age.skipped })}</p> : null}
    </div>
  );
}
