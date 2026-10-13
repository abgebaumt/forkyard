/**
 * Add a submodule: address and folder in the repository (suggested from the address), checked
 * while typing, progress as a job, cancellable. Errors stay in the dialog and say what to do;
 * after a failure or cancel nothing is left behind in the repository.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Globe, HardDrive, KeyRound } from "lucide-react";
import { core, type CoreError, type ErrorCode, type Id } from "../../core";
import { addSubmodule } from "../../app/actions/submodules";
import { showOutput } from "../../app/dialogs";
import { errorInfo } from "../../app/errors";
import { useRepo, useSubmodules } from "../../app/queries";
import { newJobId } from "../../app/run";
import { useAppStore } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { TextField } from "../../ui/Field";
import { joinPath } from "../CloneDialog/paths";
import { WrappingPath } from "../CloneDialog/PathText";
import { describeUrl, parseCloneUrl, type ParsedUrl } from "../CloneDialog/url";
import { t } from "../../i18n";
import { normalizePath, pathProblem, suggestPath } from "./model";

export { SubmodulesSection, type SubmodulesSectionProps } from "./Section";

export interface SubmoduleDialogProps {
  repoId: Id;
  onClose: () => void;
}

type FieldName = "url" | "path";

/** What can go wrong while fetching – in our own words, with the next step. */
const FAILURES: Partial<Record<ErrorCode, { title: string; hint: string; field?: FieldName }>> = {
  auth_failed: { title: t("submodules.failures.authFailed.title"), hint: t("submodules.failures.authFailed.hint") },
  offline: { title: t("submodules.failures.offline.title"), hint: t("submodules.failures.offline.hint") },
  not_found: { title: t("submodules.failures.notFound.title"), hint: t("submodules.failures.notFound.hint"), field: "url" },
  path_exists: { title: t("submodules.failures.pathExists.title"), hint: t("submodules.failures.pathExists.hint"), field: "path" },
  host_key_unknown: { title: t("submodules.failures.hostKeyUnknown.title"), hint: t("submodules.failures.hostKeyUnknown.hint") },
  timeout: { title: t("submodules.failures.timeout.title"), hint: t("submodules.failures.timeout.hint") },
  not_allowed: { title: t("submodules.failures.notAllowed.title"), hint: "" },
  locked: { title: t("submodules.failures.locked.title"), hint: t("submodules.failures.locked.hint") },
};

/** Phases as Git reports them while cloning → our own words. */
function phaseLabel(phase: string): string {
  const key = phase.toLowerCase();
  if (key.startsWith("enumerating") || key.startsWith("counting")) return t("submodules.phase.counting");
  if (key.startsWith("compressing")) return t("submodules.phase.compressing");
  if (key.startsWith("receiving")) return t("submodules.phase.receiving");
  if (key.startsWith("resolving")) return t("submodules.phase.resolving");
  if (key.startsWith("updating files") || key.startsWith("checking out")) return t("submodules.phase.checkout");
  return t("submodules.phase.connecting");
}

function UrlBadge({ parsed }: { parsed: ParsedUrl }) {
  const Icon = parsed.kind === "local" || parsed.kind === "file" ? HardDrive : parsed.kind === "ssh" ? KeyRound : Globe;
  return (
    <span data-url-kind={parsed.kind} className="inline-flex min-w-0 items-center gap-1 text-sm text-text-muted">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{describeUrl(parsed)}</span>
    </span>
  );
}

function Progress({ jobId, source, target, stopping }: { jobId: string; source: string; target: string; stopping: boolean }) {
  const job = useAppStore((state) => state.jobs[jobId]);
  const percent = job?.percent ?? null;
  const label = stopping ? t("submodules.phase.stopping") : phaseLabel(job?.phase ?? "");
  return (
    <div data-submodule-progress className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base">
        <dt className="text-text-muted">{t("submodules.progress.from")}</dt>
        <dd className="min-w-0">
          <WrappingPath path={source} />
        </dd>
        <dt className="text-text-muted">{t("submodules.progress.to")}</dt>
        <dd className="min-w-0">
          <WrappingPath path={target} />
        </dd>
      </dl>
      <div className="rounded-md border border-border bg-surface-sunken p-3">
        <div className="flex items-baseline justify-between gap-3">
          <p aria-live="polite" className="min-w-0 truncate font-medium">
            {label} …
          </p>
          <span className="shrink-0 text-sm text-text-muted">{percent !== null && !stopping ? `${percent} %` : ""}</span>
        </div>
        <div
          role="progressbar"
          aria-label={t("submodules.progress.label")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={percent !== null ? t("submodules.progress.valueText", { label, percent }) : label}
          className="mt-2 h-1.5 overflow-hidden rounded-pill bg-border"
        >
          {percent !== null && !stopping ? (
            <div className="h-full rounded-pill bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
          ) : (
            <div className="h-full w-1/3 animate-pulse rounded-pill bg-accent" />
          )}
        </div>
        <p className="mt-2 truncate font-mono text-code text-text-muted" title={job?.line || undefined}>
          {job?.line?.trim() || t("submodules.progress.waiting")}
        </p>
      </div>
    </div>
  );
}

/** Add a submodule. */
export function SubmoduleDialog({ repoId, onClose }: SubmoduleDialogProps) {
  const formId = useId();
  const { data: repo } = useRepo(repoId);
  const submodules = useSubmodules(repoId);

  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const pathTouched = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<CoreError | null>(null);
  const [fieldFailure, setFieldFailure] = useState<{ field: FieldName; text: string } | null>(null);
  const [wasCancelled, setWasCancelled] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const closeAfterStop = useRef(false);
  const [focusRequest, setFocusRequest] = useState<{ field: FieldName; at: number } | null>(null);
  const focusField = (field: FieldName) => setFocusRequest({ field, at: Date.now() });
  useEffect(() => {
    if (focusRequest) document.getElementById(`${formId}-${focusRequest.field}`)?.focus();
  }, [focusRequest, formId]);

  const running = jobId !== null;
  const parsed = parseCloneUrl(url);
  const existing = submodules.data ?? [];
  const cleanPath = normalizePath(path);
  const local = parsed.ok && (parsed.kind === "local" || parsed.kind === "file");
  const failureAt = (field: FieldName) => (fieldFailure?.field === field ? fieldFailure.text : null);
  const errors: Record<FieldName, string | null> = {
    url: url.trim() ? (parsed.ok ? failureAt("url") : parsed.reason) : submitted ? t("submodules.dialog.url.required") : null,
    path: path.trim() ? (pathProblem(path, existing) ?? failureAt("path")) : submitted ? t("submodules.path.required") : null,
  };

  const changeUrl = (value: string) => {
    setUrl(value);
    if (fieldFailure?.field === "url") setFieldFailure(null);
    if (!pathTouched.current) setPath(suggestPath(value));
  };

  const submit = async () => {
    if (running) return;
    setSubmitted(true);
    const order: FieldName[] = ["url", "path"];
    const missing: Record<FieldName, boolean> = { url: !url.trim(), path: !path.trim() };
    // A core message at the field does not block the next attempt.
    const firstBad = order.find((field) => missing[field] || (errors[field] !== null && errors[field] !== failureAt(field)));
    if (firstBad) {
      focusField(firstBad);
      return;
    }
    const id = newJobId();
    setFailure(null);
    setFieldFailure(null);
    setWasCancelled(false);
    setStopping(false);
    closeAfterStop.current = false;
    setJobId(id);
    const result = await addSubmodule(repoId, { jobId: id, url: url.trim(), path: cleanPath });
    setJobId(null);
    setStopping(false);
    setConfirmClose(false);
    if (result.ok || closeAfterStop.current) {
      onClose();
      return;
    }
    if (result.error.code === "cancelled") {
      setWasCancelled(true);
      focusField("url");
      return;
    }
    setFailure(result.error);
    const known = FAILURES[result.error.code];
    // "not_allowed" can refer to the address or the folder: the core says which in the text (shown at the top of the box).
    const message = result.error.message;
    const field: FieldName | undefined =
      known?.field ?? (result.error.code === "not_allowed" ? (/protocol|protokoll|url|adresse|lokal/i.test(message) ? "url" : /path|directory|folder|outside|pfad|ordner|außerhalb/i.test(message) ? "path" : undefined) : undefined);
    if (field) {
      setFieldFailure({
        field,
        text:
          result.error.code === "path_exists"
            ? t("submodules.failures.field.pathExists")
            : result.error.code === "not_found"
              ? t("submodules.failures.field.notFound")
              : field === "url"
                ? t("submodules.failures.field.url")
                : t("submodules.failures.field.path"),
      });
      focusField(field);
    }
  };

  const stop = () => {
    if (!jobId || stopping) return;
    setStopping(true);
    void core.jobCancel({ jobId }).catch(() => setStopping(false));
  };

  const requestClose = () => {
    if (running) setConfirmClose(true);
    else onClose();
  };

  const known = failure ? FAILURES[failure.code] : undefined;
  const failureTitle = known?.title ?? t("submodules.failures.generic");
  const failureText: ReactNode = failure ? (known?.hint ? known.hint : failure.message || errorInfo[failure.code]?.text || errorInfo.unknown.text) : null;
  const output = failure?.gitOutput?.trim();
  const target = repo && cleanPath ? joinPath(repo.path, cleanPath.replace(/\//g, repo.path.includes("\\") ? "\\" : "/")) : "";

  let footer: ReactNode;
  if (running && confirmClose) {
    footer = (
      <>
        <Button key="ask-continue" autoFocus onClick={() => setConfirmClose(false)}>
          {t("submodules.dialog.continue")}
        </Button>
        <Button
          key="ask-cancel"
          variant="danger"
          loading={stopping}
          onClick={() => {
            closeAfterStop.current = true;
            stop();
          }}
        >
          {t("submodules.dialog.stop")}
        </Button>
      </>
    );
  } else if (running) {
    footer = (
      <>
        <Button key="cancel" loading={stopping} onClick={stop}>
          {t("submodules.dialog.stop")}
        </Button>
        <Button key="busy" variant="primary" loading>
          {t("submodules.dialog.busy")}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button onClick={onClose}>{t("submodules.dialog.cancel")}</Button>
        <Button variant="primary" type="submit" form={formId}>
          {t("submodules.dialog.title")}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open
      size="md"
      title={t("submodules.dialog.title")}
      description={running ? undefined : t("submodules.dialog.description")}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      footer={footer}
    >
      <form
        id={formId}
        data-screen="submodules"
        data-state={running ? "running" : failure ? "error" : "form"}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {running && jobId ? (
          <>
            <Progress jobId={jobId} source={url.trim()} target={target || cleanPath} stopping={stopping} />
            {confirmClose ? (
              <div className="overflow-hidden rounded-md">
                <Banner tone="warning" title={t("submodules.dialog.closeWarning.title")}>
                  {t("submodules.dialog.closeWarning.text")}
                </Banner>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {failure ? (
              <div className="overflow-hidden rounded-md" data-submodule-error={failure.code}>
                <Banner
                  tone="danger"
                  title={failureTitle}
                  actions={
                    output ? (
                      <Button size="sm" onClick={() => void showOutput(t("submodules.dialog.outputTitle"), output)}>
                        {t("submodules.dialog.showOutput")}
                      </Button>
                    ) : undefined
                  }
                >
                  <span className="selectable">{failureText}</span> {t("submodules.failures.nothingLeft")}
                </Banner>
              </div>
            ) : wasCancelled ? (
              <div className="overflow-hidden rounded-md" data-submodule-cancelled>
                <Banner tone="info" title={t("submodules.dialog.cancelled.title")}>
                  {t("submodules.dialog.cancelled.text")}
                </Banner>
              </div>
            ) : null}

            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={`${formId}-url`} className="shrink-0 text-sm font-medium text-text-muted">
                  {t("submodules.dialog.url.label")}
                </label>
                {url.trim() && parsed.ok ? <UrlBadge parsed={parsed} /> : null}
              </div>
              <TextField
                id={`${formId}-url`}
                autoFocus
                data-autofocus
                mono
                value={url}
                placeholder={t("submodules.dialog.url.placeholder")}
                error={errors.url ?? undefined}
                hint={
                  local
                    ? t("submodules.dialog.url.hintLocal")
                    : t("submodules.dialog.url.hint")
                }
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => changeUrl(event.target.value)}
              />
            </div>

            <TextField
              id={`${formId}-path`}
              label={t("submodules.dialog.path.label")}
              mono
              value={path}
              placeholder={t("submodules.dialog.path.placeholder")}
              error={errors.path ?? undefined}
              hint={t("submodules.dialog.path.hint")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => {
                pathTouched.current = event.target.value !== "";
                setPath(event.target.value);
                if (fieldFailure?.field === "path") setFieldFailure(null);
              }}
            />

            <p data-submodule-target className="text-sm text-text-muted">
              {target && !errors.path ? (
                <>
                  {t("submodules.dialog.target")} <WrappingPath path={target} className="text-text" />
                </>
              ) : (
                t("submodules.dialog.targetEmpty")
              )}
            </p>
          </>
        )}
      </form>
    </Dialog>
  );
}
