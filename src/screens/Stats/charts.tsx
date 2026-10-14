/**
 * The diagrams of the statistics view as SVG. Colours only through token classes (fill-accent,
 * fill-lane-n, fill-surface-sunken …), so they read in light and dark. Every mark carries a
 * <title> (tooltip on hover, name for screen readers); tiles and rows that lead somewhere are
 * buttons and work by keyboard (Enter/Space). Geometry is in viewBox units, not CSS pixels.
 */
import type { KeyboardEvent, ReactNode } from "react";
import type { StatsAuthor, StatsBucket, StatsCodeAge, StatsFolder, StatsHotspot, StatsRecords } from "../../core";
import { shortSha } from "../../app/format";
import { locale, t } from "../../i18n";
import { cn } from "../../ui/cn";
import { ageShares, squarify, heatLevels, type AgeKey, type TreeNode } from "./model";

const numbers = new Intl.NumberFormat(locale());
const percents = new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 });
const monthFormat = new Intl.DateTimeFormat(locale(), { month: "short", year: "numeric", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "UTC" });
const weekdayFormat = new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" });

export const formatCount = (value: number) => numbers.format(value);
/** 45 → "45%" (in the UI language). */
export const formatPercent = (value: number) => percents.format(value / 100);
/** "2025-06" → "Jun 2025", "2025-06-02" → "Jun 2, 2025" (in the UI language). */
export function formatPeriod(period: string): string {
  const date = new Date(period.length === 7 ? `${period}-01T00:00:00Z` : `${period}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return period;
  return period.length === 7 ? monthFormat.format(date) : dayFormat.format(date);
}

/** Short weekday names, Monday first (2024-01-01 was a Monday). */
const WEEKDAYS = Array.from({ length: 7 }, (_, day) => weekdayFormat.format(new Date(Date.UTC(2024, 0, 1 + day))));
const HEAT_FILLS = ["fill-surface-sunken", "fill-accent/25", "fill-accent/50", "fill-accent/75", "fill-accent"];
const LANE_FILLS = ["fill-lane-1", "fill-lane-2", "fill-lane-3", "fill-lane-4", "fill-lane-5", "fill-lane-6", "fill-lane-7", "fill-lane-8"];
const AGE_FILLS: Record<AgeKey, string> = { month: "fill-lane-3", halfYear: "fill-lane-1", year: "fill-lane-2", twoYears: "fill-lane-5", older: "fill-text-disabled" };
const AGE_LABELS: Record<AgeKey, string> = {
  month: t("stats.age.month"),
  halfYear: t("stats.age.halfYear"),
  year: t("stats.age.year"),
  twoYears: t("stats.age.twoYears"),
  older: t("stats.age.older"),
};

/** Enter and Space on an SVG element with role="button". */
function onActivate(action: () => void) {
  return (event: KeyboardEvent<SVGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    action();
  };
}

// ---------------------------------------------------------------------------
// Heatmap weekday × hour
// ---------------------------------------------------------------------------

const CELL = 12;
const GAP = 2;
const DAY_LABEL = 30;
const HOUR_LABEL = 12;

export function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const levels = heatLevels(heatmap);
  const width = DAY_LABEL + 24 * (CELL + GAP);
  const height = HOUR_LABEL + 7 * (CELL + GAP);
  return (
    <svg data-stats-heatmap="" role="img" aria-label={t("stats.heatmap.label")} viewBox={`0 0 ${width} ${height}`} className="w-full max-w-3xl">
      {[0, 6, 12, 18].map((hour) => (
        <text key={hour} x={DAY_LABEL + hour * (CELL + GAP)} y={HOUR_LABEL - 3} fontSize={8} className="fill-text-muted">
          {hour}
        </text>
      ))}
      {levels.map((row, day) => (
        <g key={day}>
          <text x={0} y={HOUR_LABEL + day * (CELL + GAP) + CELL - 3} fontSize={8} className="fill-text-muted">
            {WEEKDAYS[day]}
          </text>
          {row.map((level, hour) => (
            <rect
              key={hour}
              data-cell={`${day}-${hour}`}
              x={DAY_LABEL + hour * (CELL + GAP)}
              y={HOUR_LABEL + day * (CELL + GAP)}
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
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Commits over time
// ---------------------------------------------------------------------------

const TIME_WIDTH = 600;
const TIME_HEIGHT = 120;

export function TimeChart({ buckets }: { buckets: StatsBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.commits));
  const step = TIME_WIDTH / Math.max(1, buckets.length);
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  return (
    <div className="flex flex-col gap-1">
      <svg data-stats-time="" role="img" aria-label={t("stats.time.label")} viewBox={`0 0 ${TIME_WIDTH} ${TIME_HEIGHT}`} preserveAspectRatio="none" className="h-32 w-full">
        {buckets.map((bucket, index) => {
          const height = (bucket.commits / max) * (TIME_HEIGHT - 4);
          return (
            <rect key={bucket.period} data-period={bucket.period} x={index * step + step * 0.1} y={TIME_HEIGHT - height} width={Math.max(step * 0.8, 0.5)} height={height} className="fill-accent">
              <title>{t("stats.time.bar", { period: formatPeriod(bucket.period), count: bucket.commits })}</title>
            </rect>
          );
        })}
        <line x1={0} y1={TIME_HEIGHT - 0.5} x2={TIME_WIDTH} y2={TIME_HEIGHT - 0.5} vectorEffect="non-scaling-stroke" className="stroke-border" />
      </svg>
      {first && last ? (
        <div className="flex justify-between text-sm text-text-muted">
          <span>{formatPeriod(first.period)}</span>
          <span>{formatPeriod(last.period)}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

/** Horizontal bar 0–100 % of the row, for tables. */
function Bar({ value, max, className }: { value: number; max: number; className: string }) {
  return (
    <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="h-2 w-full" aria-hidden>
      <rect width={max > 0 ? (value / max) * 100 : 0} height={6} rx={1} className={className} />
    </svg>
  );
}

export function AuthorsTable({ authors, total }: { authors: StatsAuthor[]; total: number }) {
  const max = Math.max(1, ...authors.map((author) => author.commits));
  return (
    <div className="flex flex-col gap-1">
      <table data-stats-authors="" className="w-full table-fixed text-base">
        <thead className="text-left text-sm text-text-muted">
          <tr>
            <th className="w-2/5 py-1 font-medium">{t("stats.authors.name")}</th>
            <th className="py-1 text-right font-medium">{t("stats.authors.commits")}</th>
            <th className="py-1 text-right font-medium">{t("stats.authors.added")}</th>
            <th className="py-1 text-right font-medium">{t("stats.authors.removed")}</th>
            <th className="w-1/5 py-1">
              <span className="sr-only">{t("stats.authors.share")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {authors.map((author) => (
            <tr key={`${author.email}|${author.name}`} data-author={author.email} className="border-t border-border">
              <td className="truncate py-1 pr-2 text-text" title={author.email}>
                {author.name}
              </td>
              <td className="py-1 text-right tabular-nums">{formatCount(author.commits)}</td>
              <td className="py-1 text-right tabular-nums text-success">+{formatCount(author.added)}</td>
              <td className="py-1 text-right tabular-nums text-danger">−{formatCount(author.removed)}</td>
              <td className="py-1 pl-2">
                <Bar value={author.commits} max={max} className="fill-accent" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > authors.length ? <p className="text-sm text-text-muted">{t("stats.authors.more", { count: total - authors.length })}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 480;
/** More tiles per level are not drawn (they would be too small to hit). */
const MAX_TILES = 300;

export function Treemap({ node, onFile, onFolder }: { node: TreeNode; onFile(path: string): void; onFolder(path: string): void }) {
  const tiles = squarify(
    node.children.slice(0, MAX_TILES).map((child) => ({ value: child.value, item: child })),
    { x: 0, y: 0, w: MAP_WIDTH, h: MAP_HEIGHT },
  );
  const open = (child: TreeNode) => (child.file ? onFile(child.path) : onFolder(child.path));
  return (
    <svg data-stats-treemap="" role="group" aria-label={t("stats.treemap.label", { path: node.path || t("stats.treemap.root") })} viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="w-full">
      {tiles.map((tile, index) => {
        const child = tile.item;
        const label = child.file ? t("stats.treemap.file", { path: child.path, count: child.value }) : t("stats.treemap.folder", { path: child.path, count: child.value });
        return (
          <g
            key={child.path}
            data-tile={child.path}
            data-kind={child.file ? "file" : "folder"}
            role="button"
            tabIndex={0}
            aria-label={label}
            className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-accent"
            onClick={() => open(child)}
            onKeyDown={onActivate(() => open(child))}
          >
            <rect
              x={tile.x + 1}
              y={tile.y + 1}
              width={Math.max(tile.w - 2, 0)}
              height={Math.max(tile.h - 2, 0)}
              rx={3}
              strokeWidth={3}
              className={cn(LANE_FILLS[index % LANE_FILLS.length], child.file ? "opacity-70" : "", "stroke-bg")}
            >
              <title>{label}</title>
            </rect>
            {tile.w > 80 && tile.h > 24 ? (
              <svg x={tile.x} y={tile.y} width={tile.w} height={tile.h} className="pointer-events-none" aria-hidden>
                <text x={8} y={20} fontSize={14} className="fill-on-lane">
                  {child.file ? child.name : `${child.name}/`}
                </text>
              </svg>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hotspots and knowledge
// ---------------------------------------------------------------------------

export function HotspotList({ hotspots, onFile }: { hotspots: StatsHotspot[]; onFile(path: string): void }) {
  if (hotspots.length === 0) return <p className="text-base text-text-muted">{t("stats.hotspots.empty")}</p>;
  const max = Math.max(1, ...hotspots.map((spot) => spot.score));
  return (
    <ol data-stats-hotspots="" className="flex flex-col">
      {hotspots.map((spot) => (
        <li key={spot.path} className="border-t border-border first:border-t-0">
          <button
            type="button"
            data-hotspot={spot.path}
            aria-label={t("stats.hotspots.open", { path: spot.path })}
            className="flex w-full items-center gap-3 py-1 text-left hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => onFile(spot.path)}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-code text-text">{spot.path}</span>
            <span className="shrink-0 text-sm text-text-muted tabular-nums">{t("stats.hotspots.detail", { commits: formatCount(spot.commits), authors: formatCount(spot.authors) })}</span>
            <span className="w-24 shrink-0">
              <Bar value={spot.score} max={max} className="fill-warning" />
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function KnowledgeTable({ folders, onFolder }: { folders: StatsFolder[]; onFolder(path: string): void }) {
  return (
    <table data-stats-knowledge="" className="w-full table-fixed text-base">
      <thead className="text-left text-sm text-text-muted">
        <tr>
          <th className="w-2/5 py-1 font-medium">{t("stats.knowledge.folder")}</th>
          <th className="py-1 font-medium">{t("stats.knowledge.main")}</th>
          <th className="w-20 py-1 text-right font-medium">{t("stats.knowledge.share")}</th>
          <th className="w-24 py-1 text-right font-medium">{t("stats.knowledge.busFactor")}</th>
        </tr>
      </thead>
      <tbody>
        {folders.map((folder) => {
          const name = folder.path || t("stats.knowledge.root");
          return (
            <tr key={folder.path} data-folder={folder.path} className="border-t border-border">
              <td className="py-1 pr-2">
                <button type="button" aria-label={t("stats.knowledge.open", { path: name })} className="block max-w-full truncate font-mono text-code text-accent hover:underline" onClick={() => onFolder(folder.path)}>
                  {name}
                </button>
              </td>
              <td className="truncate py-1 pr-2" title={folder.mainAuthor.email}>
                {folder.mainAuthor.name}
              </td>
              <td className="py-1 text-right tabular-nums">{formatPercent(folder.mainShare)}</td>
              <td className={cn("py-1 text-right tabular-nums", folder.busFactor === 1 ? "font-semibold text-warning" : "")}>{folder.busFactor}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Code age and records
// ---------------------------------------------------------------------------

export function CodeAgeBar({ age }: { age: StatsCodeAge }) {
  if (age.files === 0) return <p className="text-base text-text-muted">{t("stats.age.none")}</p>;
  const shares = ageShares(age);
  const total = shares.reduce((sum, share) => sum + share.lines, 0);
  let x = 0;
  return (
    <div data-stats-age="" className="flex flex-col gap-2">
      <svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={t("stats.age.label")} className="h-3 w-full">
        {shares.map((share) => {
          const width = total > 0 ? (share.lines / total) * 100 : 0;
          const rect = (
            <rect key={share.key} data-age={share.key} x={x} y={0} width={width} height={8} className={AGE_FILLS[share.key]}>
              <title>{`${AGE_LABELS[share.key]}: ${t("stats.age.lines", { count: share.lines })}`}</title>
            </rect>
          );
          x += width;
          return rect;
        })}
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
        {shares.map((share) => (
          <li key={share.key} className="flex items-center gap-1">
            <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
              <rect width={8} height={8} rx={2} className={AGE_FILLS[share.key]} />
            </svg>
            <span>
              {AGE_LABELS[share.key]} · {formatPercent(share.percent)}
            </span>
          </li>
        ))}
      </ul>
      {age.skipped > 0 ? <p className="text-sm text-text-muted">{t("stats.age.skipped", { count: age.skipped })}</p> : null}
    </div>
  );
}

function Record({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-lg font-semibold text-text tabular-nums">{value}</dd>
      {detail ? <dd className="text-sm text-text-muted">{detail}</dd> : null}
    </div>
  );
}

export function Records({ records, onCommit }: { records: StatsRecords; onCommit(sha: string): void }) {
  const { longestStreak, biggestCommit, busiestDay } = records;
  const none = t("stats.records.none");
  return (
    <dl data-stats-records="" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Record
        label={t("stats.records.streak")}
        value={longestStreak ? t("stats.records.days", { count: longestStreak.days }) : none}
        detail={longestStreak ? `${formatPeriod(longestStreak.start)} – ${formatPeriod(longestStreak.end)}` : undefined}
      />
      <Record
        label={t("stats.records.biggest")}
        value={biggestCommit ? t("stats.records.lines", { count: biggestCommit.added + biggestCommit.removed }) : none}
        detail={
          biggestCommit ? (
            <button type="button" data-record-commit={biggestCommit.sha} className="font-mono text-code text-accent hover:underline" onClick={() => onCommit(biggestCommit.sha)}>
              {t("stats.records.showCommit", { sha: shortSha(biggestCommit.sha) })}
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
