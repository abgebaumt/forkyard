/**
 * Statistics of a repository in the centre: period and branch at the top, then when commits
 * happen, commits over time, authors, records, the treemap of the most changed files,
 * hotspots, knowledge per folder and code age. The core computes everything as one job
 * (status bar, cancellable); errors stay in the view.
 *
 * A file (treemap tile, hotspot) opens its history; a folder opens in the treemap; the biggest
 * commit is shown in the graph. Esc: back.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Id } from "../../core";
import { hasOpenDialog } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { formatShortDate } from "../../app/format";
import { hasOpenMenu } from "../../app/menus/host";
import { useRefs } from "../../app/queries";
import { useAppStore, type Job } from "../../app/store";
import { t } from "../../i18n";
import { Button, Spinner } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner, EmptyState } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { goBack, showInGraph } from "../FileView/nav";
import { BackButton, isPlainEscape, ownsKey } from "../FileView/parts";
import { rememberChoice, rememberedChoice } from "./actions";
import { AuthorsTable, CodeAgeBar, formatPercent, Heatmap, HotspotList, KnowledgeTable, Records, TimeChart, Treemap } from "./charts";
import { buildTree, currentTip, defaultGranularity, fillMonths, fillWeeks, findNode, parentFolder, PRESETS, rangeFor, type Granularity, type StatsPreset } from "./model";
import { useStats } from "./useStats";

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

function Section({ id, title, hint, aside, wide = false, children }: { id: string; title: string; hint?: string; aside?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section aria-labelledby={`stats-${id}`} data-stats-section={id} className={cn("flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4", wide ? "xl:col-span-2" : "")}>
      <div className="flex min-w-0 items-center gap-2">
        <h2 id={`stats-${id}`} className="min-w-0 flex-1 truncate text-md font-semibold text-text">
          {title}
        </h2>
        {aside}
      </div>
      {hint ? <p className="text-sm text-text-muted">{hint}</p> : null}
      {children}
    </section>
  );
}

function Progress({ job }: { job: Job | undefined }) {
  return (
    <div role="status" data-stats-progress="" className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1 text-sm text-text-muted">
      <Spinner label={t("stats.computing")} />
      <span>{job?.phase === "blame" ? t("stats.phase.blame") : t("stats.phase.history")}</span>
      {typeof job?.percent === "number" ? <span className="tabular-nums">{formatPercent(job.percent)}</span> : null}
    </div>
  );
}

export function StatsView({ repoId, tabId }: StatsViewProps) {
  const [preset, setPreset] = useState<StatsPreset>(() => rememberedChoice(tabId).preset);
  const [ref, setRef] = useState(() => rememberedChoice(tabId).ref);
  const [granularity, setGranularity] = useState<Granularity | null>(null);
  const [folder, setFolder] = useState("");
  const range = useMemo(() => rangeFor(preset, ref), [preset, ref]);
  const { state, stats, job, recompute } = useStats(repoId, range);
  const { data: refs } = useRefs(repoId);
  const tree = useMemo(() => buildTree(stats?.files ?? []), [stats]);
  const weeks = useMemo(() => fillWeeks(stats?.weeks ?? []), [stats]);
  const months = useMemo(() => fillMonths(stats?.months ?? []), [stats]);
  useEffect(() => setFolder(""), [range]);
  useEffect(() => rememberChoice(tabId, { preset, ref }), [tabId, preset, ref]);

  // Esc: back (the view itself does not use Esc).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlainEscape(event)) return;
      if (!ownsKey(event, hasOpenDialog() || hasOpenMenu() || Boolean(useAppStore.getState().overlay))) return;
      event.preventDefault();
      goBack(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabId]);

  const refOptions = useMemo(
    () => [
      { value: "HEAD", label: t("stats.ref.head") },
      ...(refs?.locals ?? []).map((item) => ({ value: item.fullName, label: item.name })),
      ...(refs?.remotes ?? []).map((item) => ({ value: item.fullName, label: item.name })),
    ],
    [refs],
  );
  const running = state.kind === "running";
  const tip = currentTip(refs, ref);
  const outdated = state.kind === "done" && Boolean(stats?.tip && tip && stats.tip !== tip);
  const node = findNode(tree, folder) ?? tree;
  const shownGranularity = granularity ?? defaultGranularity(weeks);
  const openFile = (path: string) => useAppStore.getState().openHistory(tabId, path);
  const openFolder = (path: string) => {
    setFolder(path);
    document.querySelector('[data-stats-section="treemap"]')?.scrollIntoView({ block: "nearest" });
  };

  return (
    <section
      data-screen="stats"
      data-stats={running ? "running" : state.kind === "failed" ? "failed" : stats ? "ready" : "idle"}
      aria-label={t("stats.ariaLabel")}
      className="flex h-full min-h-0 flex-col bg-bg"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <BackButton tabId={tabId} />
        <h1 className="text-md font-semibold text-text">{t("stats.title")}</h1>
        <div className="flex-1" />
        <SegmentedControl label={t("stats.preset.label")} value={preset} options={PRESETS.map((value) => ({ value, label: PRESET_LABELS[value] }))} onValueChange={setPreset} />
        <div className="w-56">
          <Select ariaLabel={t("stats.ref.label")} value={ref} options={refOptions} onValueChange={setRef} />
        </div>
        <Button size="sm" variant="ghost" disabled={running} onClick={recompute}>
          {t("stats.recompute")}
        </Button>
      </header>
      {running ? <Progress job={job} /> : null}
      {outdated ? (
        <Banner
          title={t("stats.outdated.title")}
          actions={
            <Button size="sm" onClick={recompute}>
              {t("stats.outdated.action")}
            </Button>
          }
        />
      ) : null}
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
      <div className={cn("min-h-0 flex-1 overflow-auto p-4", running && stats ? "opacity-60" : "")}>
        {!stats ? null : stats.commits === 0 ? (
          <EmptyState title={t("stats.empty.title")}>{t("stats.empty.body")}</EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            <p data-stats-summary="" className="text-base text-text-muted">
              {t("stats.summary", { count: stats.commits, first: formatShortDate(stats.firstAt ?? ""), last: formatShortDate(stats.lastAt ?? "") })}
            </p>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Section id="heatmap" title={t("stats.heatmap.title")}>
                <Heatmap heatmap={stats.heatmap} />
              </Section>
              <Section
                id="time"
                title={t("stats.time.title")}
                aside={
                  <SegmentedControl
                    label={t("stats.time.granularity")}
                    value={shownGranularity}
                    options={[
                      { value: "weeks", label: t("stats.time.weeks") },
                      { value: "months", label: t("stats.time.months") },
                    ]}
                    onValueChange={setGranularity}
                  />
                }
              >
                <TimeChart buckets={shownGranularity === "weeks" ? weeks : months} />
              </Section>
              <Section id="authors" title={t("stats.authors.title", { count: stats.authorCount })}>
                <AuthorsTable authors={stats.authors} total={stats.authorCount} />
              </Section>
              <Section id="records" title={t("stats.records.title")}>
                <Records records={stats.records} onCommit={(sha) => showInGraph(tabId, sha)} />
              </Section>
              <Section id="treemap" title={t("stats.treemap.title")} hint={t("stats.treemap.hint")} wide>
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  {node.path ? (
                    <Button size="sm" variant="ghost" onClick={() => setFolder(parentFolder(node.path))}>
                      {t("stats.treemap.up", { path: parentFolder(node.path) || t("stats.treemap.root") })}
                    </Button>
                  ) : null}
                  <span data-stats-folder={node.path} className="truncate font-mono text-code text-text-muted">
                    {node.path || t("stats.treemap.root")}
                  </span>
                </div>
                <Treemap node={node} onFile={openFile} onFolder={setFolder} />
                {stats.fileCount > stats.files.length ? <p className="text-sm text-text-muted">{t("stats.treemap.partial", { files: stats.files.length })}</p> : null}
              </Section>
              <Section id="hotspots" title={t("stats.hotspots.title")} hint={t("stats.hotspots.hint")}>
                <HotspotList hotspots={stats.hotspots} onFile={openFile} />
              </Section>
              <Section id="knowledge" title={t("stats.knowledge.title")} hint={t("stats.knowledge.hint")}>
                <KnowledgeTable folders={stats.folders} onFolder={openFolder} />
              </Section>
              <Section id="age" title={t("stats.age.title")} hint={t("stats.age.hint", { files: stats.codeAge.files })} wide>
                <CodeAgeBar age={stats.codeAge} />
              </Section>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
