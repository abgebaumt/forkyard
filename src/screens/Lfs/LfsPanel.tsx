/**
 * Git LFS for a repository: is it installed, which patterns go through it, plus "Fetch LFS files"
 * (job, cancellable) and "Prune" (with a prompt). Without Git LFS the section explains what is
 * missing and shows the patterns read-only.
 *
 * Lives in the settings under "This repository" and as its own dialog (command "Git LFS …").
 */
import { useId, useState } from "react";
import { Download, Eraser, HardDrive, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import { core, type Id } from "../../core";
import { lfsBusyKey, patternProblem, pruneLfs, pullLfs, trackPattern, untrackPattern } from "../../app/actions/lfs";
import { describeError } from "../../app/errors";
import { useLfsStatus } from "../../app/queries";
import { newJobId } from "../../app/run";
import { useAppStore, useBusy } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { Banner } from "../../ui/Feedback";
import { TextField } from "../../ui/Field";
import { t } from "../../i18n";

/** Common candidates; offered are those not tracked yet. */
const SUGGESTIONS = ["*.psd", "*.zip", "*.mp4", "*.bin"];

function PullProgress({ jobId, stopping }: { jobId: string; stopping: boolean }) {
  const job = useAppStore((state) => state.jobs[jobId]);
  const percent = job?.percent ?? null;
  const label = stopping ? t("lfs.progress.stopping") : t("lfs.progress.pulling");
  return (
    <div data-lfs-progress className="rounded-md border border-border bg-surface-sunken p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p aria-live="polite" className="min-w-0 truncate font-medium">
          {label} …
        </p>
        <span className="shrink-0 text-sm text-text-muted">{percent !== null && !stopping ? `${percent} %` : ""}</span>
      </div>
      <div
        role="progressbar"
        aria-label={t("lfs.progress.label")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent !== null ? t("lfs.progress.valueText", { label, percent }) : label}
        className="mt-2 h-1.5 overflow-hidden rounded-pill bg-border"
      >
        {percent !== null && !stopping ? (
          <div className="h-full rounded-pill bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-pill bg-accent" />
        )}
      </div>
      <p className="mt-2 truncate font-mono text-code text-text-muted" title={job?.line || undefined}>
        {job?.line?.trim() || t("lfs.progress.waiting")}
      </p>
    </div>
  );
}

function PatternList({ patterns, onRemove, removing }: { patterns: string[]; onRemove?: (pattern: string) => void; removing: string | null }) {
  return (
    <ul aria-label={t("lfs.patterns.label")} data-lfs-patterns className="max-h-48 overflow-y-auto rounded-md border border-border bg-surface-sunken py-1">
      {patterns.map((pattern) => (
        <li key={pattern} data-pattern={pattern} className="group flex h-row items-center gap-2 pr-1 pl-2 hover:bg-surface-raised">
          <HardDrive className="size-3.5 shrink-0 text-text-muted" aria-hidden />
          <span className="selectable min-w-0 flex-1 truncate font-mono text-code text-text" title={pattern}>
            {pattern}
          </span>
          {onRemove ? (
            <IconButton
              size="sm"
              label={t("lfs.patterns.remove", { pattern })}
              disabled={removing !== null}
              icon={<X className="size-3.5" aria-hidden />}
              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => onRemove(pattern)}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export interface LfsPanelProps {
  repoId: Id;
  /** The input field gets focus when opening (in the standalone dialog). */
  autoFocus?: boolean;
}

export function LfsPanel({ repoId, autoFocus }: LfsPanelProps) {
  const lfs = useLfsStatus(repoId);
  const fieldId = useId();
  const focusInput = () => document.getElementById(fieldId)?.focus();
  const [pattern, setPattern] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const adding = useBusy(lfsBusyKey(repoId, "track"));
  const pruning = useBusy(lfsBusyKey(repoId, "prune"));

  if (lfs.isPending) {
    return (
      <div role="status" aria-label={t("lfs.loading")} data-lfs="loading" className="flex animate-pulse flex-col gap-3 py-2">
        <div className="h-4 w-56 rounded-sm bg-surface-raised" />
        <div className="h-16 rounded-md bg-surface-raised" />
        <div className="h-control-md w-72 rounded-md bg-surface-raised" />
      </div>
    );
  }
  if (lfs.isError) {
    const { text, hint } = describeError(lfs.error);
    return (
      <div role="alert" data-lfs="error" className="flex items-start gap-3 rounded-md border border-border bg-danger-surface p-3">
        <TriangleAlert className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-text">{t("lfs.readFailed")}</p>
          <p className="selectable text-sm break-words text-text-muted">{hint ? `${text} ${hint}` : text}</p>
        </div>
        <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void lfs.refetch()}>
          {t("lfs.retry")}
        </Button>
      </div>
    );
  }

  const status = lfs.data;
  const patterns = status.patterns;

  if (!status.installed) {
    return (
      <div data-lfs="missing" className="flex flex-col gap-3">
        <div className="overflow-hidden rounded-md">
          <Banner
            tone="warning"
            title={t("lfs.missing.title")}
            actions={
              <Button size="sm" loading={lfs.isFetching} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void lfs.refetch()}>
                {t("lfs.missing.recheck")}
              </Button>
            }
          >
            {t("lfs.missing.body")}
          </Banner>
        </div>
        {patterns.length > 0 ? (
          <>
            <p className="text-sm text-text-muted">
              {t("lfs.missing.used", { count: patterns.length })}
            </p>
            <PatternList patterns={patterns} removing={null} />
          </>
        ) : (
          <p className="text-sm text-text-muted">{t("lfs.missing.unused")}</p>
        )}
      </div>
    );
  }

  const submit = async (raw: string) => {
    const value = raw.trim();
    const problem = patternProblem(value, patterns);
    if (problem) {
      setError(problem);
      focusInput();
      return;
    }
    setError(null);
    const result = await trackPattern(repoId, value);
    if (result.ok) {
      setPattern("");
      focusInput();
    } else if (["not_allowed", "name_exists", "invalid_name"].includes(result.error.code)) {
      setError(result.error.message || t("lfs.rejected"));
      focusInput();
    }
  };

  const remove = async (value: string) => {
    setRemoving(value);
    await untrackPattern(repoId, value);
    setRemoving(null);
    focusInput();
  };

  const pull = async () => {
    if (jobId) return;
    const id = newJobId();
    setStopping(false);
    setJobId(id);
    await pullLfs(repoId, id);
    setJobId(null);
    setStopping(false);
  };
  const stop = () => {
    if (!jobId || stopping) return;
    setStopping(true);
    void core.jobCancel({ jobId }).catch(() => setStopping(false));
  };

  const offers = SUGGESTIONS.filter((item) => !patterns.includes(item));

  return (
    <div data-lfs="ready" className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">
        {t("lfs.intro")}
      </p>

      <div className="-mb-1 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-text-muted">
          {t("lfs.patterns.heading")} <span className="font-normal tabular-nums">{patterns.length}</span>
        </span>
        <span data-lfs-version className="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 text-xs font-medium whitespace-nowrap text-text-muted">
          <HardDrive className="size-3" aria-hidden />
          Git LFS {status.version ?? t("lfs.installed")}
        </span>
      </div>
      {patterns.length > 0 ? (
        <PatternList patterns={patterns} removing={removing} onRemove={(value) => void remove(value)} />
      ) : (
        <p data-lfs-empty className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
          {t("lfs.patterns.empty")}
        </p>
      )}

      <form
        noValidate
        className="flex items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(pattern);
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField
            id={fieldId}
            label={t("lfs.newPattern.label")}
            mono
            autoFocus={autoFocus}
            data-autofocus={autoFocus ? "" : undefined}
            value={pattern}
            placeholder="*.psd"
            error={error ?? undefined}
            hint={t("lfs.newPattern.hint")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => {
              setPattern(event.target.value);
              if (error) setError(null);
            }}
          />
        </div>
        <Button type="submit" className="mt-5" loading={adding && removing === null} icon={<Plus className="size-icon" aria-hidden />}>
          {t("lfs.add")}
        </Button>
      </form>
      {offers.length > 0 ? (
        <div className="-mt-1 flex flex-wrap items-center gap-1 text-sm text-text-muted" data-lfs-suggestions>
          <span className="mr-1">{t("lfs.suggestions")}</span>
          {offers.map((item) => (
            <Button key={item} size="sm" variant="ghost" className="font-mono" disabled={adding} aria-label={t("lfs.addPattern", { pattern: item })} onClick={() => void submit(item)}>
              {item}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        {jobId ? <PullProgress jobId={jobId} stopping={stopping} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          {jobId ? (
            <Button loading={stopping} onClick={stop}>
              {t("lfs.pullCancel")}
            </Button>
          ) : (
            <Button icon={<Download className="size-icon" aria-hidden />} onClick={() => void pull()}>
              {t("lfs.pull")}
            </Button>
          )}
          <Button icon={<Eraser className="size-icon" aria-hidden />} loading={pruning} disabled={Boolean(jobId)} onClick={() => void pruneLfs(repoId)}>
            {t("lfs.prune")}
          </Button>
        </div>
        <p className="text-sm text-text-muted">
          {t("lfs.footer")}
        </p>
      </div>
    </div>
  );
}
