import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CircleDot, CloudDownload, GitBranch, GitCommitHorizontal, Minus, Plus, ScrollText, TriangleAlert, X } from "lucide-react";
import { core, type Id, type Operation } from "../../core";
import { IconButton } from "../../ui/Button";
import { StatusBar } from "../../ui/Chrome";
import { toast } from "../../ui/Feedback";
import { Tip } from "../../ui/Tooltip";
import { changeZoom, setZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "../actions/repos";
import { useEffectiveZoom } from "../zoom";
import { operationNames } from "../actions/merge";
import { describeError } from "../errors";
import { formatDateTime, formatRelative, shortSha } from "../format";
import { useSettings, useStatus } from "../queries";
import { runAction } from "../run";
import { useAppStore, type Job } from "../store";
import { useUpdateInfo, visibleUpdate } from "../updates";
import { openInBrowser } from "../actions/hosts";
import { t } from "../../i18n";

/** Updates relative times once per minute. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
}

/** "Merge in progress: feature/x → main (2/5)" – what comes in, where to, and the step. */
function operationText(operation: Operation): { short: string; full: string } {
  const name = operationNames[operation.kind];
  const step = operation.step && operation.totalSteps ? ` (${operation.step}/${operation.totalSteps})` : "";
  const route = operation.source && operation.target ? `${operation.source} → ${operation.target}` : (operation.source ?? operation.target ?? "");
  return {
    short: t("shell.status.operation", { name, step }),
    full: t(route ? "shell.status.operationRoute" : "shell.status.operationFull", { name, route, step }),
  };
}

function BranchInfo({ repoId }: { repoId: Id }) {
  const { data: status, error } = useStatus(repoId);
  if (!status) {
    if (!error) return null;
    // The status could not be read: note it quietly here, the details are in the tooltip.
    return (
      <span className="flex min-w-0 items-center gap-1 text-warning" title={describeError(error).text}>
        <TriangleAlert className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{t("shell.status.unreadable")}</span>
      </span>
    );
  }
  const head = status.head;
  const detached = head.kind === "detached";
  const name = head.kind === "branch" ? head.branch : head.kind === "unborn" ? t("shell.status.unborn", { branch: head.branch }) : t("shell.status.detached", { sha: shortSha(head.sha) });
  const title =
    head.kind === "branch"
      ? t("shell.status.checkedOut", { branch: head.branch })
      : detached
        ? t("shell.status.detachedHint", { sha: head.sha })
        : name;
  const upstream = status.upstream;
  const operation = status.operation ? operationText(status.operation) : null;
  return (
    <>
      <span className={`flex min-w-0 items-center gap-1 ${detached ? "text-warning" : "text-text"}`} title={title}>
        {detached ? <GitCommitHorizontal className="size-3 shrink-0" aria-hidden /> : <GitBranch className="size-3 shrink-0" aria-hidden />}
        <span className="truncate">{name}</span>
      </span>
      {upstream ? (
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums" title={upstream.gone ? t("shell.status.upstreamGone", { name: upstream.name }) : t("shell.status.upstream", { name: upstream.name })}>
          {upstream.gone ? (
            <span className="text-warning">{t("shell.status.upstreamMissing")}</span>
          ) : (
            <>
              <span className="inline-flex items-center" aria-label={t("shell.status.ahead", { count: upstream.ahead })}>
                <ArrowUp className="size-3" aria-hidden />
                {upstream.ahead}
              </span>
              <span className="inline-flex items-center" aria-label={t("shell.status.behind", { count: upstream.behind })}>
                <ArrowDown className="size-3" aria-hidden />
                {upstream.behind}
              </span>
            </>
          )}
        </span>
      ) : head.kind === "branch" ? (
        <span className="shrink-0" title={t("shell.status.noUpstreamHint")}>
          {t("shell.status.noUpstream")}
        </span>
      ) : null}
      {operation ? (
        <span className="flex min-w-0 shrink items-center gap-1 text-warning" title={operation.full}>
          <CircleDot className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{operation.short}</span>
        </span>
      ) : null}
    </>
  );
}

function JobItem({ job }: { job: Job }) {
  const [cancelling, setCancelling] = useState(false);
  const percent = job.percent === null ? null : Math.max(0, Math.min(100, Math.round(job.percent)));
  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    const result = await runAction(t("ui.cancel"), () => core.jobCancel({ jobId: job.id }), { quiet: ["not_found"] });
    if (result.ok) toast({ tone: "info", title: t("shell.status.jobCancelled", { title: job.title }) });
    // The job disappears with job:done; if the core reports "unknown", it was already done.
    else setCancelling(false);
  };
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5" title={job.line || job.phase || job.title}>
      <span className="truncate text-text">{cancelling ? t("shell.status.jobCancelling", { title: job.title }) : job.title}</span>
      {/* The phase only if it says something new ("Fetch" + "Fetch origin" would be redundant). */}
      {!cancelling && job.phase && !job.phase.toLowerCase().startsWith(job.title.toLowerCase()) && !job.title.toLowerCase().startsWith(job.phase.toLowerCase()) ? (
        <span className="hidden truncate xl:inline">{job.phase}</span>
      ) : null}
      <span
        role="progressbar"
        aria-label={job.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? t("shell.status.jobRunning") : t("shell.status.percent", { n: percent })}
        className="relative h-1 w-16 shrink-0 overflow-hidden rounded-pill bg-surface-raised"
      >
        <span
          className={percent === null ? "absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-pill bg-accent" : "absolute inset-y-0 left-0 rounded-pill bg-accent"}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </span>
      {percent !== null ? <span className="shrink-0 tabular-nums">{t("shell.status.percent", { n: percent })}</span> : null}
      <IconButton size="xs" label={t("shell.status.jobCancel", { title: job.title })} disabled={cancelling} icon={<X className="size-3" aria-hidden />} onClick={() => void cancel()} />
    </span>
  );
}

/** "Forkyard 1.2.0 is available" – opens the release page; gone once the version is skipped. */
function UpdateHint() {
  const release = visibleUpdate(useUpdateInfo());
  if (!release) return null;
  return (
    <Tip label={t("updates.hintTitle", { version: release.version })}>
      <button
        type="button"
        data-update-hint={release.version}
        onClick={() => void openInBrowser(release.url, t("updates.page"))}
        className="shrink-0 rounded-sm px-1 text-accent hover:bg-surface-raised"
      >
        {t("updates.hint", { version: release.version })}
      </button>
    </Tip>
  );
}

/** Status bar: branch or detached HEAD, ahead/behind, running operation, jobs with progress and cancel, last fetch; on the right zoom and activity log. */
export function StatusLine({ repoId }: { repoId: Id | null }) {
  useMinuteTick();
  const jobs = useAppStore((state) => state.jobs);
  const lastFetch = useAppStore((state) => (repoId ? state.lastFetch[repoId] : undefined));
  const openOverlay = useAppStore((state) => state.openOverlay);
  const { data: settings } = useSettings();
  const zoom = settings?.zoom ?? 1;
  // In a small window less than configured applies (zoom.ts) – that is then shown alongside.
  const applied = useEffectiveZoom(zoom);
  const limited = applied < zoom - 0.001;
  const visibleJobs = Object.values(jobs)
    .filter((job) => job.repoId === null || job.repoId === repoId)
    .sort((a, b) => a.startedAt - b.startedAt);

  return (
    <StatusBar
      left={
        <>
          {repoId ? <BranchInfo repoId={repoId} /> : null}
          {visibleJobs.length ? (
            <span role="status" aria-live="polite" className="flex min-w-0 items-center gap-3">
              {visibleJobs.map((job) => (
                <JobItem key={job.id} job={job} />
              ))}
            </span>
          ) : null}
          {repoId && lastFetch ? (
            <span className="flex shrink-0 items-center gap-1" title={t("shell.status.lastFetch", { time: formatDateTime(lastFetch) })}>
              <CloudDownload className="size-3" aria-hidden />
              {t("shell.status.fetchAgo", { time: formatRelative(lastFetch) })}
            </span>
          ) : null}
        </>
      }
      right={
        <>
          <UpdateHint />
          <span className="flex items-center" role="group" aria-label={t("shell.status.zoom")}>
            <IconButton
              size="xs"
              label={t("shell.status.zoomOut")}
              shortcut="Mod+-"
              disabled={zoom <= ZOOM_MIN + 0.001}
              icon={<Minus className="size-3" aria-hidden />}
              onClick={() => void changeZoom(-ZOOM_STEP)}
            />
            <Tip label={limited ? t("shell.status.zoomResetLimited", { applied: Math.round(applied * 100), zoom: Math.round(zoom * 100) }) : t("shell.status.zoomReset")} shortcut="Mod+0">
              <button
                type="button"
                data-zoom-applied={Math.round(applied * 100)}
                aria-label={limited ? t("shell.status.zoomLabelLimited", { applied: Math.round(applied * 100), zoom: Math.round(zoom * 100) }) : t("shell.status.zoomLabel", { zoom: Math.round(zoom * 100) })}
                onClick={() => void setZoom(1)}
                className="min-w-10 rounded-sm px-1 text-center tabular-nums hover:bg-surface-raised hover:text-text"
              >
                {t("shell.status.percent", { n: Math.round(zoom * 100) })}
              </button>
            </Tip>
            <IconButton
              size="xs"
              label={t("shell.status.zoomIn")}
              shortcut="Mod++"
              disabled={zoom >= ZOOM_MAX - 0.001}
              icon={<Plus className="size-3" aria-hidden />}
              onClick={() => void changeZoom(ZOOM_STEP)}
            />
          </span>
          <Tip label={t("shell.status.activityHint")}>
            <button
              type="button"
              onClick={() => openOverlay({ kind: "activity" })}
              className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-raised hover:text-text"
            >
              <ScrollText className="size-3" aria-hidden />
              {t("shell.status.activity")}
            </button>
          </Tip>
        </>
      }
    />
  );
}
