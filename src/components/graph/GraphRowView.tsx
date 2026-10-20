import { memo, type ReactNode } from "react";
import { Archive, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { DateFormat, GraphRow, Id, RefLabelInfo, Status, SyncMark } from "../../core";
import { toggleMergeCollapsed } from "../../app/actions/collapse";
import { formatDate, formatDateTime, shortSha } from "../../app/format";
import { useStatus } from "../../app/queries";
import { useAppStore, type AppState, type Selection } from "../../app/store";
import { Avatar } from "../../ui/Git";
import { cn } from "../../ui/cn";
import { AUTHOR_NAME_FROM, type ColumnLayout } from "./columns";
import { graphStats } from "./GraphCanvas";
import { DetachedHeadChip, GhostLabel, HEAD_CHIP_WIDTH, RowRefs } from "./RowRefs";
import { useRowDim, useRowGhost, type RowMarks } from "./rowMarks";
import { locale, t } from "../../i18n";
import type { BisectMark } from "../../screens/Bisect/model";
import type { CompiledRule } from "../../app/ticketLinks";
import { keepFocus, LinkedText } from "../LinkedText";

/** What all rows need in common; the object stays the same as long as none of it changes. */
export interface RowShared {
  repoId: Id;
  tabId: Id;
  dateFormat: DateFormat;
  /** Short name of the local branch → short name of its upstream. */
  upstreams: ReadonlyMap<string, string> | null;
  /** "Dimmed" and ghost label per row; the rows subscribe to it individually. */
  marks: RowMarks;
  /** `fullName` of the branches pinned to the left. */
  pinned: ReadonlySet<string>;
  /** No branch checked out: the HEAD commit gets the "HEAD" marker. */
  detached: boolean;
  /** Bisect marks per commit (good, bad, skipped); empty without a bisect. */
  bisect: ReadonlyMap<string, BisectMark>;
  /** Ticket link rules of the repository, compiled; links in the message column. */
  links: readonly CompiledRule[];
}

// ---------------------------------------------------------------------------
// State of a row from the store – each row subscribes only to its own four bits.
// ---------------------------------------------------------------------------

export const ROW_SELECTED = 1;
export const ROW_ACTIVE = 2;
export const ROW_HIT = 4;
export const ROW_ACTIVE_HIT = 8;

const WIP_SELECTION: Selection = { kind: "wip" };
const setCache = new WeakMap<readonly string[], Set<string>>();
function setOf(list: readonly string[]): Set<string> {
  let set = setCache.get(list);
  if (!set) {
    set = new Set(list);
    setCache.set(list, set);
  }
  return set;
}

/** Selection of a tab; a tab without its own state shows the local changes (store default). */
export function selectionOf(state: AppState, tabId: Id): Selection {
  const view = state.views[tabId];
  return view ? view.selection : WIP_SELECTION;
}

/** Identifier of the active row (the last selected): "wip", "stash:<n>" or the SHA. */
export function activeKey(selection: Selection): string | null {
  if (!selection) return null;
  if (selection.kind === "wip") return "wip";
  if (selection.kind === "stash") return `stash:${selection.index}`;
  return selection.shas[selection.shas.length - 1] ?? null;
}

export function rowKey(row: GraphRow): string {
  if (row.kind === "wip") return "wip";
  if (row.kind === "stash") return `stash:${row.stashIndex ?? -1}`;
  return row.sha ?? row.id;
}

export function rowFlags(state: AppState, tabId: Id, row: GraphRow): number {
  const selection = selectionOf(state, tabId);
  let flags = 0;
  if (selection) {
    if (selection.kind === "wip") {
      if (row.kind === "wip") flags |= ROW_SELECTED | ROW_ACTIVE;
    } else if (selection.kind === "stash") {
      if (row.kind === "stash" && row.stashIndex === selection.index) flags |= ROW_SELECTED | ROW_ACTIVE;
    } else if (row.sha && row.kind !== "stash" && row.kind !== "wip") {
      if (setOf(selection.shas).has(row.sha)) flags |= ROW_SELECTED;
      if (selection.shas[selection.shas.length - 1] === row.sha) flags |= ROW_ACTIVE;
    }
  }
  const search = state.views[tabId]?.search;
  if (search && search.hits.length > 0 && row.sha && row.kind !== "stash" && row.kind !== "wip") {
    if (setOf(search.hits).has(row.sha)) flags |= ROW_HIT;
    if (search.hits[search.active] === row.sha) flags |= ROW_ACTIVE_HIT;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

/** Number of changed paths; a path that is staged and additionally modified counts once. */
export function changeCount(status: Status): number {
  const paths = new Set<string>();
  for (const file of status.unstaged) paths.add(file.path);
  for (const file of status.staged) paths.add(file.path);
  for (const file of status.conflicted) paths.add(file.path);
  return paths.size;
}

const kindLabel: Record<GraphRow["kind"], string> = {
  commit: t("graph.row.kind.commit"),
  merge: t("graph.row.kind.merge"),
  wip: t("graph.row.kind.wip"),
  stash: t("graph.row.kind.stash"),
};

/** "On main: text" or "WIP on main: 1a2b3c4 text" from Git's reflog. */
export function parseStashSummary(summary: string): { text: string; branch: string | null; unnamed: boolean } {
  const match = /^(WIP on|On) ([^:]+): ([\s\S]*)$/.exec(summary);
  if (!match) return { text: summary, branch: null, unnamed: false };
  const unnamed = match[1] === "WIP on";
  return { text: unnamed ? t("graph.row.stashUnnamed") : (match[3] ?? ""), branch: match[2] ?? null, unnamed };
}

function WipMessage({ repoId }: { repoId: Id }) {
  const { data: status, isError } = useStatus(repoId);
  if (!status) return <span className="truncate text-text-muted italic">{isError ? t("graph.row.wipUnreadable") : t("graph.row.kind.wip")}</span>;
  const total = changeCount(status);
  if (total === 0) return <span className="truncate text-text-muted">{t("graph.row.noChanges")}</span>;
  const details: string[] = [];
  if (status.conflicted.length > 0) details.push(t("graph.row.conflicts", { count: status.conflicted.length }));
  if (status.staged.length > 0) details.push(t("graph.row.staged", { count: status.staged.length }));
  return (
    <>
      <span className="shrink-0 font-medium text-text italic">{t("graph.row.changedFiles", { count: total, formatted: total.toLocaleString(locale()) })}</span>
      {details.length > 0 ? <span className="truncate text-sm text-text-muted">{details.join(" · ")}</span> : null}
    </>
  );
}

const utcDateTime = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Tooltip of the date column: local time, plus the same moment in UTC – "02.03.2026, 20:50 (02.03.2026, 19:50 UTC)". */
export function dateTooltip(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return formatDateTime(iso);
  return `${formatDateTime(date)} (${utcDateTime.format(date)} UTC)`;
}

/** Arrow on merge rows: collapse (hide the commits the merge brought in) or expand again. */
/** Not focusable, also not by a mouse press: the row keeps the focus for the keyboard navigation. */
export function CollapseToggle({ repoId, sha, collapsed, tooLarge, empty = false }: { repoId: Id; sha: string; collapsed: boolean; tooLarge: boolean; empty?: boolean }) {
  const label = tooLarge ? t("graph.row.collapseTooLarge") : empty ? t("graph.row.collapseNothing") : collapsed ? t("graph.row.expand") : t("graph.row.collapse");
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={keepFocus}
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
      data-collapse-toggle={collapsed ? "collapsed" : "expanded"}
      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-raised hover:text-text"
      onClick={() => void toggleMergeCollapsed(repoId, sha)}
    >
      {collapsed ? <ChevronRight className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
    </button>
  );
}

/** ↑ not pushed yet, ↓ not pulled yet (checked-out branch and its upstream). */
function SyncArrow({ sync }: { sync: Exclude<SyncMark, "none"> }) {
  const label = sync === "ahead" ? t("graph.row.notPushed") : t("graph.row.notPulled");
  return (
    <span data-sync={sync} title={label} className="shrink-0 font-mono text-sm text-text-muted">
      <span aria-hidden>{sync === "ahead" ? "↑" : "↓"}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

const BISECT_LABELS: Record<BisectMark, string> = {
  good: t("graph.row.bisectGood"),
  bad: t("graph.row.bisectBad"),
  skip: t("graph.row.bisectSkip"),
};
const BISECT_TONES: Record<BisectMark, string> = { good: "text-success", bad: "text-danger", skip: "text-text-muted" };

function BisectChip({ mark }: { mark: BisectMark }) {
  return (
    <span data-bisect={mark} className={cn("shrink-0 text-sm font-medium", BISECT_TONES[mark])}>
      {BISECT_LABELS[mark]}
    </span>
  );
}

function messageCell(row: GraphRow, shared: RowShared, hit: boolean): ReactNode {
  if (row.kind === "wip") return <WipMessage repoId={shared.repoId} />;
  const marker = hit ? (
    <>
      <Search className="size-3 shrink-0 text-warning" aria-hidden />
      <span className="sr-only">{t("graph.row.searchHit")}</span>
    </>
  ) : null;
  if (row.kind === "stash") {
    const stash = parseStashSummary(row.summary);
    return (
      <>
        <Archive className="size-3.5 shrink-0 text-text-muted" aria-hidden />
        {/* The name keeps its space; the "on <branch>" suffix gives way first – with "…". */}
        <span className={cn("min-w-16 shrink truncate", stash.unnamed && "text-text-muted italic")} title={stash.branch ? t("graph.row.stashOnBranch", { text: stash.text, branch: stash.branch }) : stash.text}>
          {stash.text}
        </span>
        {stash.branch ? <span className="min-w-0 shrink-[1000] truncate text-sm text-text-muted">{t("graph.row.onBranch", { branch: stash.branch })}</span> : null}
      </>
    );
  }
  const mark = row.sha ? shared.bisect.get(row.sha) : undefined;
  const before = (
    <>
      {marker}
      {row.kind === "merge" && row.sha ? <CollapseToggle repoId={shared.repoId} sha={row.sha} collapsed={row.collapsedCount !== null} tooLarge={row.collapseTooLarge} empty={row.collapsedCount === 0} /> : null}
      {mark ? <BisectChip mark={mark} /> : null}
      {row.sync !== "none" ? <SyncArrow sync={row.sync} /> : null}
    </>
  );
  const after = row.collapsedCount ? (
    <span data-collapsed-count={row.collapsedCount} className="shrink-0 text-sm text-text-muted">
      {t("graph.row.collapsedCount", { count: row.collapsedCount, formatted: row.collapsedCount.toLocaleString(locale()) })}
    </span>
  ) : null;
  if (!row.summary) {
    return (
      <>
        {before}
        <span className="truncate text-text-muted italic">{t("graph.row.noMessage")}</span>
        {after}
      </>
    );
  }
  return (
    <>
      {before}
      <span className={cn("truncate", row.kind === "merge" && "text-text-muted", row.isHead && "font-medium")} title={row.summary}>
        {shared.links.length > 0 ? <LinkedText text={row.summary} rules={shared.links} focusable={false} /> : row.summary}
      </span>
      {after}
    </>
  );
}


// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export interface GraphRowViewProps {
  row: GraphRow;
  index: number;
  /** Position in the list in CSS pixels. */
  top: number;
  layout: ColumnLayout;
  /** This row is the list's single tab stop (roving tabindex). */
  tabStop: boolean;
  shared: RowShared;
}

/**
 * A graph row as real DOM (role=row). Clicks, keys, context menu and dragging are handled by
 * the list (one handler for all rows); for that the row carries `data-row-index`.
 */
export const GraphRowView = memo(function GraphRowView({ row, index, top, layout, tabStop, shared }: GraphRowViewProps) {
  graphStats.rowRenders += 1;
  const flags = useAppStore((state) => rowFlags(state, shared.tabId, row));
  const dim = useRowDim(shared.marks, index);
  const ghost = useRowGhost(shared.marks, row.id);
  const selected = (flags & ROW_SELECTED) !== 0;
  const hit = (flags & ROW_HIT) !== 0;
  const activeHit = (flags & ROW_ACTIVE_HIT) !== 0;

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      data-row-index={index}
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-active={(flags & ROW_ACTIVE) !== 0 || undefined}
      data-hit={hit ? (activeHit ? "active" : "true") : undefined}
      data-dim={dim || undefined}
      className={cn(
        "absolute top-0 left-0 flex h-graph-row w-full items-center text-base focus-visible:-outline-offset-2",
        // Not part of the highlighted branch: toned down, but still readable and usable.
        "transition-opacity data-[dim=true]:opacity-40",
        "data-[drop=true]:inset-ring-2 data-[drop=true]:inset-ring-accent",
        selected ? "bg-accent-surface" : hit ? "bg-warning-surface" : "hover:bg-surface",
        activeHit && "inset-ring-2 inset-ring-warning",
      )}
      style={{ transform: `translateY(${top}px)` }}
    >
      <RowCells row={row} index={index} layout={layout} shared={shared} ghost={ghost} hit={hit} />
    </div>
  );
});

interface RowCellsProps {
  row: GraphRow;
  index: number;
  layout: ColumnLayout;
  shared: RowShared;
  ghost: RefLabelInfo | null;
  hit: boolean;
}

/**
 * The cells of a row – memoized separately: if only "dimmed", "selected" or the position changes,
 * React redraws just the outer element. Toggling the highlight changes the state of all visible rows;
 * previously all cells were recreated every time (formatting dates, labels, avatar),
 * and on average a toggle took slightly longer than one frame.
 */
const RowCells = memo(function RowCells({ row, index, layout, shared, ghost, hit }: RowCellsProps) {
  const isCommit = row.kind === "commit" || row.kind === "merge";
  const hasPerson = row.kind !== "wip" && row.authorName !== "";
  const headChip = shared.detached && row.isHead && isCommit;
  return (
    <>
      {layout.order.map((column) => {
        const width = layout.widths[column];
        switch (column) {
          case "refs":
            return (
              <div key={column} role="gridcell" data-cell={column} className="flex h-full shrink-0 items-center justify-end gap-1 overflow-hidden pr-1 pl-2" style={{ width }}>
                {headChip ? <DetachedHeadChip /> : null}
                {/* Ghost label: only on rows without their own branch label; next to tags it shares the space with them. */}
                {ghost && !headChip ? <GhostLabel info={ghost} /> : null}
                {row.refs.length > 0 ? (
                  <RowRefs
                    refs={row.refs}
                    rowIndex={index}
                    lane={row.color}
                    width={headChip ? width - HEAD_CHIP_WIDTH : ghost ? width / 2 : width}
                    upstreams={shared.upstreams}
                    pinned={shared.pinned}
                  />
                ) : null}
              </div>
            );
          case "graph":
            return (
              <div key={column} role="gridcell" data-cell={column} className="h-full shrink-0" style={{ width }}>
                <span className="sr-only">{row.isHead && isCommit ? t("graph.row.checkedOut", { kind: kindLabel[row.kind] }) : kindLabel[row.kind]}</span>
              </div>
            );
          case "message":
            return (
              <div key={column} role="gridcell" data-cell={column} className="flex h-full min-w-40 flex-1 items-center gap-1.5 overflow-hidden px-2">
                {messageCell(row, shared, hit)}
              </div>
            );
          case "author": {
            const compact = width < AUTHOR_NAME_FROM;
            return (
              <div
                key={column}
                role="gridcell"
                data-cell={column}
                title={hasPerson ? (row.authorEmail ? `${row.authorName} <${row.authorEmail}>` : row.authorName) : undefined}
                className={cn("flex h-full shrink-0 items-center gap-1.5 overflow-hidden", compact ? "justify-center" : "px-2")}
                style={{ width }}
              >
                {hasPerson ? (
                  <>
                    {/* Images from the host are not available yet (the contract provides no source): initials are the fallback in both settings. */}
                    <Avatar name={row.authorName} email={row.authorEmail || undefined} size={18} />
                    <span className={compact ? "sr-only" : "truncate text-text-muted"}>{row.authorName}</span>
                  </>
                ) : null}
              </div>
            );
          }
          case "date":
            return (
              <div
                key={column}
                role="gridcell"
                data-cell={column}
                title={row.authoredAt && row.kind !== "wip" ? dateTooltip(row.authoredAt) : undefined}
                className="flex h-full shrink-0 items-center overflow-hidden px-2 text-text-muted tabular-nums"
                style={{ width }}
              >
                {row.authoredAt && row.kind !== "wip" ? <span className="truncate">{formatDate(row.authoredAt, shared.dateFormat)}</span> : null}
              </div>
            );
          case "sha":
            return (
              <div key={column} role="gridcell" data-cell={column} className="flex h-full shrink-0 items-center overflow-hidden px-2 font-mono text-code text-text-muted" style={{ width }}>
                {row.sha && row.kind !== "wip" ? <span className="truncate">{shortSha(row.sha)}</span> : null}
              </div>
            );
        }
      })}
    </>
  );
});
