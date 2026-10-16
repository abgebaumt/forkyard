/**
 * “Clean up repository” (overlay `{ kind: "repo_cleanup", repoId }`, spec Paket 10): what takes
 * space now, which kind of clean-up and which extra steps, then the run with its step and a
 * seconds counter, then the result. The run is a job in the core; the dialog may be closed
 * meanwhile and shows the same run again when it opens again.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { core, CoreError, type CleanupFailure, type CleanupPreview, type CleanupResult, type CleanupStep, type CleanupStepStatus, type Id } from "../../core";
import { cancelCleanup, runCleanup } from "../../app/actions/cleanup";
import { describeError } from "../../app/errors";
import { formatBytes } from "../../app/format";
import { qk } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Dialog } from "../../ui/Dialog";
import { Checkbox } from "../../ui/Field";
import { NumberField } from "../../ui/NumberField";
import { RadioChoice } from "../../ui/Radio";
import { locale, t } from "../../i18n";
import {
  MAX_UNDO_DAYS,
  MIN_UNDO_DAYS,
  backupsOlderThan,
  durationParts,
  initialForm,
  lowSpace,
  outcomeOf,
  sizeChange,
  stepPosition,
  toOptions,
  visibleOptions,
  type CleanupForm,
  type CleanupOutcome,
} from "./model";
import { useCleanupRuns, type CleanupRun } from "./runs";

const STEP_LABEL: Record<CleanupStep, string> = {
  worktrees: t("cleanup.step.worktrees"),
  undo: t("cleanup.step.undo"),
  reflog: t("cleanup.step.reflog"),
  lfs: t("cleanup.step.lfs"),
  gc: t("cleanup.step.gc"),
};
const STEP_NAME: Record<CleanupStep, string> = {
  worktrees: t("cleanup.result.name.worktrees"),
  undo: t("cleanup.result.name.undo"),
  reflog: t("cleanup.result.name.reflog"),
  lfs: t("cleanup.result.name.lfs"),
  gc: t("cleanup.result.name.gc"),
};
const STATUS_WORD: Record<CleanupStepStatus, string> = {
  done: t("cleanup.result.status.done"),
  skipped: t("cleanup.result.status.skipped"),
  failed: t("cleanup.result.status.failed"),
  cancelled: t("cleanup.result.status.cancelled"),
  not_run: t("cleanup.result.status.notRun"),
};
/** Status never by colour alone: the dot goes with the word above. */
const STATUS_DOT: Record<CleanupStepStatus, string> = {
  done: "bg-success",
  skipped: "bg-text-muted",
  failed: "bg-danger",
  cancelled: "bg-text-muted",
  not_run: "bg-text-muted",
};
const OUTCOME_TEXT: Record<CleanupOutcome, string> = {
  done: t("cleanup.result.done"),
  failed: t("cleanup.result.failed"),
  cancelled: t("cleanup.result.cancelled"),
};

const count = (value: number) => value.toLocaleString(locale());

function Figure({ name, label, value, text }: { name: string; label: string; value: number | null; text: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-text-muted">{label}</dt>
      <dd data-figure={name} data-value={value ?? ""} className="text-text tabular-nums">
        {text}
      </dd>
    </div>
  );
}

function NowSection({ preview }: { preview: CleanupPreview }) {
  const { objects } = preview;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium text-text-muted">{t("cleanup.now.heading")}</h3>
      <dl className="text-base">
        <Figure name="objects" label={t("cleanup.now.objects")} value={objects.totalBytes} text={formatBytes(objects.totalBytes)} />
        <Figure name="loose" label={t("cleanup.now.loose")} value={objects.looseCount} text={count(objects.looseCount)} />
        <Figure name="packs" label={t("cleanup.now.packs")} value={objects.packs} text={count(objects.packs)} />
        {preview.lfsBytes !== null ? <Figure name="lfs" label={t("cleanup.now.lfs")} value={preview.lfsBytes} text={formatBytes(preview.lfsBytes)} /> : null}
        <Figure name="undo" label={t("cleanup.now.undo")} value={preview.undoBackups.length} text={count(preview.undoBackups.length)} />
        <Figure name="worktrees" label={t("cleanup.now.worktrees")} value={preview.orphanedWorktrees} text={count(preview.orphanedWorktrees)} />
        <Figure
          name="reflog"
          label={t("cleanup.now.reflog")}
          value={preview.oldReflogEntries}
          text={preview.oldReflogEntries === null ? t("cleanup.now.notCounted") : count(preview.oldReflogEntries)}
        />
        <Figure name="free" label={t("cleanup.now.free")} value={preview.freeBytes} text={preview.freeBytes === null ? t("cleanup.now.unknown") : formatBytes(preview.freeBytes)} />
      </dl>
      {preview.linkedWorktrees > 0 ? (
        <p data-cleanup-shared className="text-sm text-text-muted">
          {t("cleanup.now.shared", { count: preview.linkedWorktrees })}
        </p>
      ) : null}
    </section>
  );
}

function FormBody({ repoId, preview, form, onChange }: { repoId: Id; preview: CleanupPreview; form: CleanupForm; onChange: (form: CleanupForm) => void }) {
  const visible = visibleOptions(preview);
  const patch = (change: Partial<CleanupForm>) => onChange({ ...form, ...change });
  const estimate = useQuery({
    queryKey: qk.cleanupLfsEstimate(repoId),
    queryFn: () => core.repoCleanupLfsEstimate({ repoId }),
    enabled: visible.lfs && form.lfs,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const undoCount = backupsOlderThan(preview.undoBackups, form.undoDays);
  const estimateText = estimate.isError
    ? t("cleanup.extra.lfs.estimateFailed")
    : estimate.data
      ? t("cleanup.extra.lfs.estimate", { count: estimate.data.files, size: formatBytes(estimate.data.bytes) })
      : t("cleanup.extra.lfs.estimating");
  return (
    <div className="flex flex-col gap-4">
      <NowSection preview={preview} />
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-text-muted">{t("cleanup.mode.label")}</h3>
        <RadioChoice
          label={t("cleanup.mode.label")}
          value={form.mode}
          autoFocus
          onValueChange={(mode) => patch({ mode })}
          options={[
            { value: "normal", label: t("cleanup.mode.normal.label"), description: t("cleanup.mode.normal.frees") },
            {
              value: "thorough",
              label: t("cleanup.mode.thorough.label"),
              description: (
                <>
                  {t("cleanup.mode.thorough.frees")}
                  <span data-warning="thorough" className="block text-warning">
                    {t("cleanup.mode.thorough.warning")}
                  </span>
                  {lowSpace(preview) ? (
                    <span data-warning="low-space" className="block text-warning">
                      {t("cleanup.mode.thorough.lowSpace")}
                    </span>
                  ) : null}
                </>
              ),
            },
          ]}
        />
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-text-muted">{t("cleanup.extra.heading")}</h3>
        {visible.lfs ? (
          <div data-option="lfs" className="flex flex-col gap-1">
            <Checkbox label={t("cleanup.extra.lfs.label")} hint={t("cleanup.extra.lfs.frees")} checked={form.lfs} onCheckedChange={(lfs) => patch({ lfs })} />
            {form.lfs ? (
              <p aria-live="polite" data-lfs-estimate className="ml-6 text-sm text-text-muted">
                {estimateText}
              </p>
            ) : null}
          </div>
        ) : null}
        {visible.worktrees ? (
          <div data-option="worktrees">
            <Checkbox label={t("cleanup.extra.worktrees.label")} hint={t("cleanup.extra.worktrees.frees")} checked={form.worktrees} onCheckedChange={(worktrees) => patch({ worktrees })} />
          </div>
        ) : null}
        <div data-option="undo" className="flex flex-col gap-1">
          <Checkbox label={t("cleanup.extra.undo.label")} hint={t("cleanup.extra.undo.frees")} checked={form.undo} onCheckedChange={(undo) => patch({ undo })} />
          <div className="ml-6 flex items-center gap-2">
            <NumberField
              value={form.undoDays}
              min={MIN_UNDO_DAYS}
              max={MAX_UNDO_DAYS}
              unit={t("cleanup.extra.undo.unit")}
              ariaLabel={t("cleanup.extra.undo.days")}
              onCommit={(undoDays) => patch({ undoDays })}
            />
            <span data-undo-count={undoCount} aria-live="polite" className="text-sm text-text-muted">
              {t("cleanup.extra.undo.count", { count: undoCount })}
            </span>
          </div>
          <p data-warning="undo" className="ml-6 text-sm text-warning">
            {t("cleanup.extra.undo.warning")}
          </p>
        </div>
        <div data-option="reflog" className="flex flex-col gap-1">
          <Checkbox label={t("cleanup.extra.reflog.label")} hint={t("cleanup.extra.reflog.frees")} checked={form.reflog} onCheckedChange={(reflog) => patch({ reflog })} />
          <p data-warning="reflog" className="ml-6 text-sm text-danger">
            <strong className="font-semibold">{t("cleanup.extra.reflog.warningWord")}</strong> {t("cleanup.extra.reflog.warning")}
          </p>
        </div>
      </section>
      <p data-cleanup-irreversible className="text-sm text-text-muted">
        {t("cleanup.irreversible")}
      </p>
    </div>
  );
}

function Progress({ run }: { run: CleanupRun }) {
  const job = useAppStore((state) => state.jobs[run.jobId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000));
  const position = stepPosition(run.steps, job?.line ?? "");
  const text = run.stopping
    ? t("cleanup.progress.stopping")
    : position
      ? t("cleanup.progress.step", { index: position.index, total: position.total, label: STEP_LABEL[position.step] })
      : t("cleanup.progress.waiting");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p aria-live="polite" data-cleanup-progress={position?.step ?? "waiting"} className="min-w-0 font-medium text-text">
          {text}
        </p>
        <span className="shrink-0 text-sm text-text-muted tabular-nums">{t("cleanup.progress.seconds", { seconds })}</span>
      </div>
      <div role="progressbar" aria-label={t("cleanup.progress.label")} aria-valuetext={text} className="h-1.5 overflow-hidden rounded-pill bg-border">
        <div className="h-full w-1/3 animate-pulse rounded-pill bg-accent" />
      </div>
      <p className="text-sm text-text-muted">{t("cleanup.progress.hint")}</p>
    </div>
  );
}

function failureText(failure: CleanupFailure): string {
  if (failure.diskFull) return t("cleanup.failure.diskFull");
  if (failure.gcPid !== null) return t("cleanup.failure.gcRunning", { pid: failure.gcPid });
  const { text, hint } = describeError(new CoreError(failure.error));
  return hint ? `${text} ${hint}` : text;
}

function Result({ result }: { result: CleanupResult }) {
  const outcome = outcomeOf(result);
  const { minutes, seconds } = durationParts(result.durationMs);
  return (
    <div className="flex flex-col gap-3">
      <p aria-live="polite" data-outcome={outcome} className="font-medium text-text">
        {OUTCOME_TEXT[outcome]}
      </p>
      <div className="flex flex-col gap-0.5 text-base text-text">
        <p data-result-line="objects">{t("cleanup.result.objects", { change: sizeChange(result.before.totalBytes, result.after.totalBytes) })}</p>
        {result.lfsBefore !== null && result.lfsAfter !== null ? (
          <p data-result-line="lfs">{t("cleanup.result.lfs", { change: sizeChange(result.lfsBefore, result.lfsAfter) })}</p>
        ) : null}
      </div>
      {result.failure ? (
        <p role="alert" data-failure-step={result.failure.step} className="selectable text-sm break-words text-danger">
          {failureText(result.failure)}
        </p>
      ) : null}
      <ul aria-label={t("cleanup.result.steps")} className="flex flex-col gap-1">
        {result.steps.map((entry) => (
          <li key={entry.step} data-step={entry.step} data-status={entry.status} className="flex items-center gap-2 text-base">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-pill", STATUS_DOT[entry.status])} />
            <span className="min-w-0 flex-1 truncate text-text">{STEP_NAME[entry.step]}</span>
            <span className="shrink-0 text-sm text-text-muted">
              {STATUS_WORD[entry.status]}
              {entry.status === "done" && entry.removed !== null ? ` · ${t("cleanup.result.removed", { count: entry.removed })}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-text-muted">{minutes > 0 ? t("cleanup.duration.minutes", { minutes, seconds }) : t("cleanup.duration.seconds", { seconds })}</p>
    </div>
  );
}

function Refused({ error }: { error: CoreError }) {
  if (error.code === "cancelled") {
    return (
      <p aria-live="polite" data-outcome="cancelled" className="font-medium text-text">
        {t("cleanup.result.cancelledEarly")}
      </p>
    );
  }
  const { text, hint } = describeError(error);
  return (
    <p role="alert" className="selectable text-sm break-words text-danger">
      {hint ? `${text} ${hint}` : text}
    </p>
  );
}

function Loading() {
  return (
    <div role="status" aria-label={t("cleanup.loading")} className="flex animate-pulse flex-col gap-2 py-2">
      <div className="h-4 w-56 rounded-sm bg-surface-raised" />
      <div className="h-24 rounded-md bg-surface-raised" />
      <div className="h-16 rounded-md bg-surface-raised" />
    </div>
  );
}

function PreviewError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { text, hint } = describeError(error);
  return (
    <div role="alert" className="flex flex-col gap-2">
      <p className="font-medium text-text">{t("cleanup.previewFailed")}</p>
      <p className="selectable text-sm break-words text-text-muted">{hint ? `${text} ${hint}` : text}</p>
      <div>
        <Button size="sm" onClick={onRetry}>
          {t("cleanup.retry")}
        </Button>
      </div>
    </div>
  );
}

export function RepoCleanupDialog({ repoId, onClose }: { repoId: Id; onClose: () => void }) {
  const run = useCleanupRuns((state) => state.runs[repoId] ?? null);
  useEffect(() => useCleanupRuns.getState().watch(repoId), [repoId]);
  const preview = useQuery({
    queryKey: qk.cleanupPreview(repoId),
    queryFn: () => core.repoCleanupPreview({ repoId }),
    enabled: run === null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [form, setForm] = useState<CleanupForm | null>(null);
  const shown = form ?? (preview.data ? initialForm(preview.data) : null);
  const finished = Boolean(run?.result || run?.error);

  const close = () => {
    // A finished run has been seen: the next opening starts with a fresh preview.
    if (finished) useCleanupRuns.getState().clear(repoId);
    onClose();
  };
  const start = () => {
    if (!preview.data || !shown) return;
    void runCleanup(repoId, toOptions(shown, visibleOptions(preview.data)));
  };

  // Two footer slots that keep their place, so the focused button stays when the view changes.
  let state: string;
  let body: ReactNode;
  let secondary: ReactNode = null;
  let primary: ReactNode = null;
  if (run && !finished) {
    state = "running";
    body = <Progress run={run} />;
    secondary = <Button onClick={onClose}>{t("cleanup.background")}</Button>;
    primary = (
      <Button loading={run.stopping} onClick={() => cancelCleanup(repoId)}>
        {t("cleanup.cancel")}
      </Button>
    );
  } else if (run?.result) {
    state = "result";
    body = <Result result={run.result} />;
    primary = (
      <Button variant="primary" onClick={close}>
        {t("cleanup.close")}
      </Button>
    );
  } else if (run?.error) {
    state = "refused";
    body = <Refused error={run.error} />;
    primary = (
      <Button variant="primary" onClick={close}>
        {t("cleanup.close")}
      </Button>
    );
  } else if (preview.isError) {
    state = "error";
    body = <PreviewError error={preview.error} onRetry={() => void preview.refetch()} />;
    secondary = <Button onClick={close}>{t("cleanup.cancel")}</Button>;
  } else if (!preview.data || !shown) {
    state = "loading";
    body = <Loading />;
    secondary = <Button onClick={close}>{t("cleanup.cancel")}</Button>;
  } else {
    state = "form";
    body = <FormBody repoId={repoId} preview={preview.data} form={shown} onChange={setForm} />;
    secondary = <Button onClick={close}>{t("cleanup.cancel")}</Button>;
    primary = (
      <Button variant="primary" onClick={start}>
        {t("cleanup.start")}
      </Button>
    );
  }
  return (
    <Dialog
      open
      size="md"
      title={t("cleanup.title")}
      description={t("cleanup.description")}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        <>
          {secondary}
          {primary}
        </>
      }
    >
      <div data-screen="repo-cleanup" data-cleanup={state}>
        {body}
      </div>
    </Dialog>
  );
}

/** Opens the dialog for `repoId` (also a repository that is not open in a tab); resolves once it closes. */
export function openRepoCleanup(repoId: Id): Promise<void> {
  useAppStore.getState().openOverlay({ kind: "repo_cleanup", repoId });
  return new Promise((resolve) => {
    const stop = useAppStore.subscribe((state) => {
      if (state.overlay?.kind === "repo_cleanup" && state.overlay.repoId === repoId) return;
      stop();
      resolve();
    });
  });
}
