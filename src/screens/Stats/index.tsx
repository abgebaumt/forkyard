/**
 * Statistics of a repository over the whole window (no side panels, see store.ts
 * `showsSidePanels`). Header: branch, period, week or month, and whether the numbers are up to
 * date. Cards: activity by weekday and hour, commits over time, records; where changes happen
 * (treemap), hotspots, authors; knowledge per folder and code age. The core computes everything
 * as one job (status bar, cancellable) and recomputes when the branch moves (useStats.ts);
 * errors stay in the view.
 *
 * A file (treemap tile, hotspot) opens its history; a folder opens in the treemap; the biggest
 * commit is shown in the graph. It opens and closes through its toolbar button only (actions.ts).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Id, RepoStats } from "../../core";
import { describeError } from "../../app/errors";
import { useCommitDetails, useRefs, useRepo } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner, EmptyState } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { showInGraph } from "../FileView/nav";
import { leaveStats, rememberChoice, rememberedChoice } from "./actions";
import { AuthorsList, CodeAgeChart, formatCount, formatPercent, Heatmap, HotspotList, KnowledgeTable, Records, TimeChart, Treemap } from "./charts";
import { authorPalette, knowledgeRows, statusOf } from "./layout";
import { buildTree, currentTip, DAY_MS, defaultGranularity, fillMonths, fillWeeks, findNode, parentFolder, PRESETS, rangeFor, type Granularity, type StatsPreset } from "./model";
import { useStats, useUtcDay } from "./useStats";

export interface StatsViewProps {
  repoId: Id;
  tabId: Id;
}

const PRESET_LABELS: Record<StatsPreset, string> = {
  all: t("stats.preset.all"),
  year: t("stats.preset.year"),
  quarter: t("stats.preset.quarter"),
  month: t("stats.preset.month"),
};

/** Rows of the knowledge card. */
const KNOWLEDGE_ROWS = 6;

function Card({ id, title, hint, aside, className, children }: { id: string; title: string; hint?: ReactNode; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`stats-${id}`} data-stats-section={id} className={cn("flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-3", className)}>
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id={`stats-${id}`} className="shrink-0 text-base font-semibold text-text">
          {title}
        </h2>
        {hint ? <span className="min-w-0 flex-1 truncate text-sm text-text-muted">{hint}</span> : <span className="flex-1" />}
        {aside}
      </div>
      {children}
    </section>
  );
}

/** In place of the tiles when the first run was cancelled (status bar): say so and offer to compute again. */
export function StatsCancelled({ onCompute }: { onCompute: () => void }) {
  return (
    <div data-stats-cancelled="">
      <EmptyState title={t("stats.cancelled.title")} action={<Button onClick={onCompute}>{t("stats.cancelled.compute")}</Button>}>
        {t("stats.cancelled.body")}
      </EmptyState>
    </div>
  );
}

/** In place of the tiles when nothing was counted: a branch without any commit, or none in the period. */
export function StatsEmpty({ stats }: { stats: RepoStats }) {
  const unborn = stats.tip === null;
  return (
    <div data-stats-empty={unborn ? "unborn" : "period"}>
      <EmptyState title={unborn ? t("stats.unborn.title") : t("stats.empty.title")}>{unborn ? t("stats.unborn.body") : t("stats.empty.body")}</EmptyState>
    </div>
  );
}

export function StatsView({ repoId, tabId }: StatsViewProps) {
  const [preset, setPreset] = useState<StatsPreset>(() => rememberedChoice(tabId).preset);
  const [ref, setRef] = useState(() => rememberedChoice(tabId).ref);
  const [granularity, setGranularity] = useState<Granularity | null>(null);
  const [folder, setFolder] = useState("");
  // The presets count back from today: a view left open past midnight moves on with the day.
  const today = useUtcDay();
  const range = useMemo(() => rangeFor(preset, ref, today * DAY_MS), [preset, ref, today]);
  const { data: refs } = useRefs(repoId);
  const { data: repo } = useRepo(repoId);
  const { state, stats, job, recompute } = useStats(repoId, range, refs ? currentTip(refs, ref) : undefined, today);
  const tree = useMemo(() => buildTree(stats?.files ?? []), [stats]);
  const weeks = useMemo(() => fillWeeks(stats?.weeks ?? []), [stats]);
  const months = useMemo(() => fillMonths(stats?.months ?? []), [stats]);
  const palette = useMemo(() => authorPalette(stats?.authors ?? []), [stats]);
  const biggestSha = stats?.records.biggestCommit?.sha ?? null;
  const { data: biggest } = useCommitDetails(repoId, biggestSha ? { kind: "commit", sha: biggestSha } : null);
  useEffect(() => setFolder(""), [preset, ref]);
  useEffect(() => rememberChoice(tabId, { preset, ref }), [tabId, preset, ref]);

  const head = refs?.head;
  const headLabel = head && head.kind !== "detached" ? t("stats.ref.head", { branch: head.branch }) : t("stats.ref.detached");
  const refOptions = useMemo(
    () => [
      { value: "HEAD", label: headLabel },
      ...(refs?.locals ?? []).map((item) => ({ value: item.fullName, label: item.name })),
      ...(refs?.remotes ?? []).map((item) => ({ value: item.fullName, label: item.name })),
    ],
    [refs, headLabel],
  );
  const refName = ref === "HEAD" ? "HEAD" : (refOptions.find((option) => option.value === ref)?.label ?? ref);
  const status = statusOf(state);
  const statusText =
    status === "updating"
      ? typeof job?.percent === "number"
        ? t("stats.status.updatingPercent", { percent: formatPercent(job.percent) })
        : t("stats.status.updating")
      : status === "cached"
        ? t("stats.status.cached", { ref: refName })
        : status === "fresh"
          ? t("stats.status.fresh", { ref: refName })
          : null;
  const running = state.kind === "running";
  const node = findNode(tree, folder) ?? tree;
  const shownGranularity = granularity ?? defaultGranularity(weeks);
  const buckets = shownGranularity === "weeks" ? weeks : months;
  const openFile = (path: string) => leaveStats(() => useAppStore.getState().openHistory(tabId, path));
  const openFolder = (path: string) => {
    setFolder(path);
    document.querySelector('[data-stats-section="treemap"]')?.scrollIntoView({ block: "nearest" });
  };

  return (
    <section
      data-screen="stats"
      data-stats={running ? "running" : state.kind === "failed" || state.kind === "cancelled" ? state.kind : stats ? "ready" : "idle"}
      aria-label={t("stats.ariaLabel")}
      className="flex h-full min-h-0 flex-col bg-bg"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2">
        <h1 className="text-md font-semibold text-text">{t("stats.title")}</h1>
        <span className="min-w-0 truncate text-base text-text-muted">{repo?.alias ?? repo?.name ?? ""}</span>
        <div className="flex-1" />
        <div role="group" aria-label={t("stats.choice")} className="flex flex-wrap items-center gap-2">
          <div className="w-48">
            <Select ariaLabel={t("stats.ref.label")} prefix={t("stats.ref.label")} value={ref} options={refOptions} onValueChange={setRef} />
          </div>
          <div className="w-52">
            <Select ariaLabel={t("stats.preset.label")} prefix={t("stats.preset.label")} value={preset} options={PRESETS.map((value) => ({ value, label: PRESET_LABELS[value] }))} onValueChange={setPreset} />
          </div>
          <SegmentedControl
            label={t("stats.time.granularity")}
            value={shownGranularity}
            options={[
              { value: "weeks", label: t("stats.time.weeks") },
              { value: "months", label: t("stats.time.months") },
            ]}
            onValueChange={setGranularity}
          />
        </div>
        {statusText ? (
          <span role="status" data-stats-status={status ?? ""} className="text-sm text-text-muted tabular-nums">
            {statusText}
          </span>
        ) : null}
      </header>
      {state.kind === "failed" ? (
        <Banner
          tone="danger"
          title={t("stats.failed")}
          actions={
            <Button size="sm" onClick={recompute}>
              {t("stats.retry")}
            </Button>
          }
        >
          {describeError(state.error).text}
        </Banner>
      ) : null}
      <div className={cn("min-h-0 flex-1 overflow-auto p-4", running && stats ? "opacity-70" : "")}>
        {state.kind === "cancelled" ? (
          <StatsCancelled onCompute={recompute} />
        ) : !stats ? null : stats.commits === 0 ? (
          <StatsEmpty stats={stats} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card id="heatmap" title={t("stats.heatmap.title")} hint={t("stats.heatmap.hint")}>
              <Heatmap heatmap={stats.heatmap} />
            </Card>
            <Card
              id="time"
              title={t("stats.time.title")}
              hint={t(shownGranularity === "weeks" ? "stats.time.hintWeeks" : "stats.time.hintMonths", { count: stats.commits, n: formatCount(stats.commits) })}
            >
              <TimeChart buckets={buckets} />
            </Card>
            <Card id="records" title={t("stats.records.title")}>
              <Records
                records={stats.records}
                biggest={biggest?.commit ? { summary: biggest.commit.summary, author: biggest.commit.author.name } : null}
                onCommit={(sha) => leaveStats(() => showInGraph(tabId, sha))}
              />
            </Card>
            <Card
              id="treemap"
              title={t("stats.treemap.title")}
              hint={
                <>
                  <span data-stats-folder={node.path} className="font-mono text-code">
                    {node.path ? `${node.path}/` : t("stats.treemap.root")}
                  </span>
                  {" · "}
                  {t("stats.treemap.hint")}
                </>
              }
              aside={
                node.path ? (
                  <Button size="sm" variant="ghost" onClick={() => setFolder(parentFolder(node.path))}>
                    {t("stats.treemap.up", { path: parentFolder(node.path) || t("stats.treemap.root") })}
                  </Button>
                ) : null
              }
            >
              <Treemap node={node} onFile={openFile} onFolder={setFolder} />
              {stats.fileCount > stats.files.length ? <p className="text-sm text-text-muted">{t("stats.treemap.partial", { files: stats.files.length })}</p> : null}
            </Card>
            <Card id="hotspots" title={t("stats.hotspots.title")} hint={t("stats.hotspots.hint")}>
              <HotspotList hotspots={stats.hotspots} onFile={openFile} />
            </Card>
            <Card id="authors" title={t("stats.authors.title")} hint={t("stats.authors.count", { count: stats.authorCount })}>
              <AuthorsList authors={stats.authors} total={stats.authorCount} palette={palette} />
            </Card>
            <Card id="knowledge" title={t("stats.knowledge.title")} hint={t("stats.knowledge.hint")} className="md:col-span-2">
              <KnowledgeTable folders={knowledgeRows(stats.folders, KNOWLEDGE_ROWS)} palette={palette} onFolder={openFolder} />
            </Card>
            <Card id="age" title={t("stats.age.title")} hint={t("stats.age.hint", { ref: refName, files: stats.codeAge.files })} className="md:col-span-2 xl:col-span-1">
              <CodeAgeChart age={stats.codeAge} />
            </Card>
          </div>
        )}
      </div>
    </section>
  );
}
