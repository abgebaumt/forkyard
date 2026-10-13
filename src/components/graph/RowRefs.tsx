import { memo } from "react";
import { Cloud, GitBranch, Pin, Unplug } from "lucide-react";
import { Popover } from "radix-ui";
import type { RefLabelInfo } from "../../core";
import { RefLabel } from "../../ui/Git";
import { cn, laneColor } from "../../ui/cn";
import { collisionPadding } from "../../app/zoom";
import { t } from "../../i18n";

/** A label of the row; `twin` is the remote branch of the same name on the same commit. */
export interface RefGroup {
  primary: RefLabelInfo;
  twin: RefLabelInfo | null;
}

// Dimensions of a ref label (src/ui/Git.tsx): border, padding, icon, gap – and the upper limit max-w-44.
const LABEL_CHROME = 30;
const LABEL_MAX = 176;
const TWIN_WIDTH = 22;
/** The pin in front of a pinned branch. */
const PIN_WIDTH = 16;
/** Width of the "HEAD" marker including gap (detached HEAD); the row subtracts it from the column width. */
export const HEAD_CHIP_WIDTH = 60;
const MORE_WIDTH = 32;
const GAP = 4;
/** Narrower than this a truncated label is not worth it; then only "+N" is shown. */
const LABEL_MIN = 48;
/** Padding of the cell left and right. */
const CELL_PADDING = 12;

const widthCache = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null | undefined;

/** Width of a name in the labels' font (xs, 500); measured, not estimated. */
function textWidth(name: string): number {
  const cached = widthCache.get(name);
  if (cached !== undefined) return cached;
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
    if (measureContext) {
      const style = getComputedStyle(document.body);
      const size = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-xs")) || 11;
      measureContext.font = `500 ${size}px ${style.fontFamily}`;
    }
    // Widths measured before the font has loaded are not quite right.
    void document.fonts?.ready.then(() => widthCache.clear());
  }
  const width = measureContext ? Math.ceil(measureContext.measureText(name).width) : name.length * 6;
  widthCache.set(name, width);
  return width;
}

const groupWidth = (group: RefGroup, pinned?: ReadonlySet<string> | null) =>
  Math.min(LABEL_MAX, textWidth(group.primary.name) + LABEL_CHROME) + (group.twin ? GAP / 2 + TWIN_WIDTH : 0) + (pinned?.has(group.primary.fullName) ? PIN_WIDTH : 0);
const groupCount = (group: RefGroup) => (group.twin ? 2 : 1);

/**
 * Combines a local branch and its remote branch on the same commit.
 * `upstreams`: short name of the local branch → short name of its upstream.
 */
export function groupRefs(refs: RefLabelInfo[], upstreams: ReadonlyMap<string, string> | null): RefGroup[] {
  const remotes = refs.filter((ref) => ref.kind === "remote");
  const taken = new Set<string>();
  const groups: RefGroup[] = [];
  for (const ref of refs) {
    if (ref.kind !== "local") continue;
    const upstream = upstreams?.get(ref.name);
    const twin = remotes.find((remote) => !taken.has(remote.fullName) && (remote.name === upstream || remote.name.slice(remote.name.indexOf("/") + 1) === ref.name)) ?? null;
    if (twin) taken.add(twin.fullName);
    groups.push({ primary: ref, twin });
  }
  for (const ref of refs) {
    if (ref.kind === "local" || taken.has(ref.fullName)) continue;
    groups.push({ primary: ref, twin: null });
  }
  return groups;
}

/** How many groups fit into `width`? The rest is behind "+N". */
export function fitRefs(groups: RefGroup[], width: number, pinned?: ReadonlySet<string> | null): { shown: number; truncateFirst: boolean } {
  const available = width - CELL_PADDING;
  let used = 0;
  let shown = 0;
  for (let index = 0; index < groups.length; index++) {
    const need = groupWidth(groups[index]!, pinned) + (shown > 0 ? GAP : 0);
    const reserve = index < groups.length - 1 ? GAP + MORE_WIDTH : 0;
    if (used + need + reserve > available) break;
    used += need;
    shown += 1;
  }
  if (shown > 0) return { shown, truncateFirst: false };
  if (groups.length === 1) return { shown: 1, truncateFirst: true };
  return available - GAP - MORE_WIDTH >= LABEL_MIN ? { shown: 1, truncateFirst: true } : { shown: 0, truncateFirst: false };
}

const kindText = { local: t("graph.refs.kind.local"), remote: t("graph.refs.kind.remote"), tag: t("graph.refs.kind.tag") } as const;

const dropMarks = "data-[drop=true]:outline-2 data-[drop=true]:outline-offset-1 data-[drop=true]:outline-accent data-[dragging=true]:opacity-40";

/** A label with the details needed by click, context menu and dragging (handled in the row list). */
function LabelChip({ info, rowIndex, lane, shrink }: { info: RefLabelInfo; rowIndex: number; lane: number; shrink?: boolean }) {
  return (
    <span
      data-ref-full={info.fullName}
      data-ref-kind={info.kind}
      data-ref-row={rowIndex}
      className={cn(
        "inline-flex rounded-sm",
        // The label itself (src/ui) does not shrink; here it may, so that the name ends with "…" instead of being cut off.
        shrink ? "max-w-full min-w-0 shrink [&>span]:max-w-full [&>span]:min-w-0 [&>span]:shrink" : "shrink-0",
        dropMarks,
      )}
    >
      <RefLabel kind={info.kind} name={info.name} lane={lane} head={info.isHead} />
    </span>
  );
}

/** The remote branch of a combined pair: only the cloud, the name is in the tooltip. */
function TwinChip({ info, rowIndex, lane }: { info: RefLabelInfo; rowIndex: number; lane: number }) {
  return (
    <span
      data-ref-full={info.fullName}
      data-ref-kind={info.kind}
      data-ref-row={rowIndex}
      title={t("graph.refs.twinTitle", { kind: kindText.remote, name: info.name })}
      className={cn("inline-flex h-4.5 shrink-0 items-center rounded-sm border bg-surface px-1 text-text", dropMarks)}
      style={{ borderColor: laneColor(lane) }}
    >
      <Cloud className="size-3" aria-hidden />
      <span className="sr-only">
        {kindText.remote}: {info.name}
      </span>
    </span>
  );
}

/** The pin in front of a pinned branch – as a sign, not only recognisable by the position of the line. */
function PinMark({ name }: { name: string }) {
  return (
    <span data-pinned-mark title={t("graph.refs.pinnedTitle", { name })} className="inline-flex h-4.5 shrink-0 items-center text-text-muted">
      <Pin className="size-3" aria-hidden />
      <span className="sr-only">{t("graph.refs.pinned")}</span>
    </span>
  );
}

function Group({ group, rowIndex, lane, shrink, pinned }: { group: RefGroup; rowIndex: number; lane: number; shrink?: boolean; pinned?: boolean }) {
  if (!group.twin && !pinned) return <LabelChip info={group.primary} rowIndex={rowIndex} lane={lane} shrink={shrink} />;
  return (
    <span className={cn("inline-flex items-center gap-0.5", shrink ? "max-w-full min-w-0 shrink" : "shrink-0")}>
      {pinned ? <PinMark name={group.primary.name} /> : null}
      <LabelChip info={group.primary} rowIndex={rowIndex} lane={lane} shrink={shrink} />
      {group.twin ? <TwinChip info={group.twin} rowIndex={rowIndex} lane={lane} /> : null}
    </span>
  );
}

/**
 * Ghost label: the nearest branch that contains this row's commit. Faint and dashed,
 * because the branch is not here – it only shows where the commit belongs.
 */
export function GhostLabel({ info }: { info: RefLabelInfo }) {
  return (
    <span
      data-ghost-ref={info.fullName}
      title={info.kind === "remote" ? t("graph.refs.ghostRemote", { name: info.name }) : t("graph.refs.ghostLocal", { name: info.name })}
      className="inline-flex h-4.5 max-w-full min-w-0 items-center gap-1 rounded-sm border border-dashed border-border-input px-1.5 text-xs font-medium text-text-muted"
    >
      {info.kind === "remote" ? <Cloud className="size-3 shrink-0" aria-hidden /> : <GitBranch className="size-3 shrink-0" aria-hidden />}
      <span className="sr-only">{t("graph.refs.containedIn")}</span>
      <span className="truncate">{info.name}</span>
    </span>
  );
}

/** Marker on the checked-out commit when no branch is checked out. */
export function DetachedHeadChip() {
  return (
    <span
      data-head-detached
      title={t("graph.refs.detachedTitle")}
      className="inline-flex h-4.5 shrink-0 items-center gap-1 rounded-sm border border-warning bg-warning-surface px-1.5 text-xs font-semibold text-text"
    >
      <Unplug className="size-3" aria-hidden />
      HEAD
      <span className="sr-only">{t("graph.refs.detachedSr")}</span>
    </span>
  );
}

export interface RowRefsProps {
  refs: RefLabelInfo[];
  rowIndex: number;
  /** Colour index of the row – the labels carry the colour of their lane. */
  lane: number;
  /** Width of the refs column. */
  width: number;
  upstreams: ReadonlyMap<string, string> | null;
  /** `fullName` of the branches pinned to the left in the graph. */
  pinned?: ReadonlySet<string> | null;
}

/** Ref labels of a row. What does not fit is behind "+N" (names in the tooltip, labels in the popover). */
export const RowRefs = memo(function RowRefs({ refs, rowIndex, lane, width, upstreams, pinned = null }: RowRefsProps) {
  const groups = groupRefs(refs, upstreams);
  const fit = fitRefs(groups, width, pinned);
  const visible = groups.slice(0, fit.shown);
  const hidden = groups.slice(fit.shown);
  const hiddenCount = hidden.reduce((sum, group) => sum + groupCount(group), 0);
  const hiddenNames = hidden.flatMap((group) => (group.twin ? [group.primary.name, group.twin.name] : [group.primary.name]));
  return (
    <>
      {visible.map((group, index) => (
        <Group key={group.primary.fullName} group={group} rowIndex={rowIndex} lane={lane} shrink={fit.truncateFirst && index === 0} pinned={pinned?.has(group.primary.fullName)} />
      ))}
      {hiddenCount > 0 ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              tabIndex={-1}
              data-more-refs
              aria-label={t("graph.refs.showMore", { count: hiddenCount })}
              title={hiddenNames.join("\n")}
              className="inline-flex h-4.5 shrink-0 items-center rounded-sm border border-border-input bg-surface-raised px-1 text-xs font-medium text-text-muted tabular-nums hover:text-text"
            >
              +{hiddenCount}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={collisionPadding()}
              aria-label={t("graph.refs.moreLabel")}
              className="animate-pop z-50 flex max-w-80 flex-col items-start gap-1 rounded-lg border border-border bg-surface-raised p-2 shadow-pop"
            >
              {hidden.map((group) => (
                <Group key={group.primary.fullName} group={group} rowIndex={rowIndex} lane={lane} shrink pinned={pinned?.has(group.primary.fullName)} />
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </>
  );
});
