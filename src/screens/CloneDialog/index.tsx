import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FolderOpen, Globe, HardDrive, KeyRound } from "lucide-react";
import { Collapsible } from "radix-ui";
import { core, type CoreError, type ErrorCode } from "../../core";
import { showOutput } from "../../app/dialogs";
import { errorInfo } from "../../app/errors";
import { useRepos } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { Checkbox, SegmentedControl, TextArea, TextField } from "../../ui/Field";
import { joinPath, parentOf, pathKey, rememberParent, rememberedParent } from "../../app/osPaths";
import { WrappingPath } from "./PathText";
import {
  CLONE_ERRORS,
  advancedSummary,
  cloneOptions,
  failureField,
  fieldErrors,
  firstBadField,
  isAdvancedField,
  phaseLabel,
  type CloneForm,
  type FieldName,
} from "./model";
import { describeUrl, parseCloneUrl, type ParsedUrl } from "./url";
import { t } from "../../i18n";

export interface CloneDialogProps {
  onClose: () => void;
}

const ALL_CODES = Object.keys(errorInfo) as ErrorCode[];

const BRANCH_MISSING = {
  title: t("clone.errors.branchMissing.title"),
  hint: t("clone.errors.branchMissing.hint"),
};

function UrlBadge({ parsed }: { parsed: ParsedUrl }) {
  const Icon = parsed.kind === "local" || parsed.kind === "file" ? HardDrive : parsed.kind === "ssh" ? KeyRound : Globe;
  return (
    <span data-url-kind={parsed.kind} className="inline-flex min-w-0 items-center gap-1 text-sm text-text-muted">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{describeUrl(parsed)}</span>
    </span>
  );
}

function CloneProgress({ jobId, source, target, stopping }: { jobId: string; source: string; target: string; stopping: boolean }) {
  const job = useAppStore((state) => state.jobs[jobId]);
  const percent = job?.percent ?? null;
  const label = stopping ? t("clone.phase.stopping") : phaseLabel(job?.phase ?? "");
  return (
    <div data-clone-progress className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base">
        <dt className="text-text-muted">{t("ui.from")}</dt>
        <dd className="min-w-0">
          <WrappingPath path={source} />
        </dd>
        <dt className="text-text-muted">{t("ui.to")}</dt>
        <dd className="min-w-0">
          <WrappingPath path={target} />
        </dd>
      </dl>
      <div className="rounded-md border border-border bg-surface-sunken p-3">
        <div className="flex items-baseline justify-between gap-3">
          <p aria-live="polite" className="min-w-0 truncate font-medium">
            {label} …
          </p>
          <span data-clone-percent className="shrink-0 text-sm text-text-muted">
            {percent !== null && !stopping ? `${percent} %` : ""}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={t("clone.progress.label")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={percent !== null ? t("clone.progress.valueText", { label, percent }) : label}
          className="mt-2 h-1.5 overflow-hidden rounded-pill bg-border"
        >
          {percent !== null && !stopping ? (
            <div
              className="h-full rounded-pill bg-accent transition-[width]"
              style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
            />
          ) : (
            <div className="h-full w-1/3 animate-pulse rounded-pill bg-accent" />
          )}
        </div>
        <p data-clone-line className="mt-2 truncate font-mono text-code text-text-muted" title={job?.line || undefined}>
          {job?.line?.trim() || t("clone.progress.waiting")}
        </p>
      </div>
    </div>
  );
}

/** Repository klonen. */
export function CloneDialog({ onClose }: CloneDialogProps) {
  const formId = useId();
  const urlLabelId = useId();
  const { data: repos } = useRepos();

  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(rememberedParent);
  const [name, setName] = useState("");
  const nameTouched = useRef(false);
  const parentTouched = useRef(parent !== "");

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [shallow, setShallow] = useState(false);
  const [shallowBy, setShallowBy] = useState<"depth" | "since">("depth");
  const [depth, setDepth] = useState("1");
  const [since, setSince] = useState("");
  const [branch, setBranch] = useState("");
  const [sparse, setSparse] = useState(false);
  const [sparseText, setSparseText] = useState("");
  const [submodules, setSubmodules] = useState(false);

  const [submitted, setSubmitted] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<CoreError | null>(null);
  /** Core error that belongs to a field; disappears as soon as the field is changed. */
  const [fieldFailure, setFieldFailure] = useState<{ field: FieldName; text: string } | null>(null);
  const [wasCancelled, setWasCancelled] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const closeAfterStop = useRef(false);
  // Set focus only after rendering: fields that are just being (re)mounted would otherwise take the focus back via autoFocus.
  const [focusRequest, setFocusRequest] = useState<{ field: FieldName; at: number } | null>(null);
  const focusField = (field: FieldName) => setFocusRequest({ field, at: Date.now() });
  useEffect(() => {
    if (focusRequest) document.getElementById(`${formId}-${focusRequest.field}`)?.focus();
  }, [focusRequest, formId]);

  const running = jobId !== null;

  // No remembered target folder yet: suggest one next to the most recently opened repository.
  const newestRepoPath = repos?.find((repo) => !repo.missing)?.path;
  useEffect(() => {
    if (parentTouched.current || !newestRepoPath) return;
    setParent((current) => current || parentOf(newestRepoPath));
  }, [newestRepoPath]);

  const parsed = parseCloneUrl(url);
  const target = parent.trim() && name ? joinPath(parent, name) : "";
  const knownAtTarget = target ? repos?.find((repo) => pathKey(repo.path) === pathKey(target)) : undefined;
  const form: CloneForm = { url, parent, name, shallow, shallowBy, depth, since, branch, sparse, sparseText, submodules };
  const failureFor = (field: FieldName) => (fieldFailure?.field === field ? fieldFailure.text : null);
  const errors = fieldErrors(form, { parsed, submitted, knownAtTarget, failureFor });

  const changeUrl = (value: string) => {
    setUrl(value);
    if (fieldFailure?.field === "url") setFieldFailure(null);
    const next = parseCloneUrl(value);
    if (!nameTouched.current) setName(next.ok ? next.name : "");
  };

  const browse = async () => {
    const picked = await core.pickFolder({ title: t("clone.pickFolderTitle"), defaultPath: parent.trim() || undefined });
    if (!picked) return;
    parentTouched.current = true;
    setParent(picked);
    if (fieldFailure?.field === "parent" || fieldFailure?.field === "name") setFieldFailure(null);
  };

  const submit = async () => {
    if (running) return;
    setSubmitted(true);
    const firstBad = firstBadField(form, errors, failureFor);
    if (firstBad) {
      if (isAdvancedField(firstBad)) setAdvancedOpen(true);
      focusField(firstBad);
      return;
    }

    rememberParent(parent);
    const id = newJobId();
    const options = cloneOptions(form);
    setFailure(null);
    setFieldFailure(null);
    setWasCancelled(false);
    setStopping(false);
    closeAfterStop.current = false;
    setJobId(id);
    const result = await runAction(
      t("clone.action"),
      () => core.repoClone({ jobId: id, url: url.trim(), parentPath: parent.trim(), name, options }),
      {
        // If someone closes the window meanwhile, the app asks first (closeGuard.ts).
        job: { id, title: t("clone.jobTitle", { name }), repoId: null, askBeforeQuit: true },
        // Errors stay here in the dialog, not as a notification at the edge.
        quiet: ALL_CODES,
        success: (opened) => t("clone.success", { name: opened.repo.name }),
      },
    );
    setJobId(null);
    setStopping(false);
    setConfirmClose(false);
    if (result.ok) {
      onClose();
      return;
    }
    if (closeAfterStop.current) {
      onClose();
      return;
    }
    if (result.error.code === "cancelled") {
      setWasCancelled(true);
      focusField("url");
      return;
    }
    setFailure(result.error);
    const failed = failureField(result.error, options.branch);
    if (failed) {
      setFieldFailure(failed);
      if (failed.field === "branch") setAdvancedOpen(true);
      focusField(failed.field);
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

  const summary = advancedSummary(form);

  const branchMissing = failure?.code === "not_found" && fieldFailure?.field === "branch";
  // A CHANGED key is something other than a not yet confirmed server: there is never a prompt for
  // it. The core explains it; the text “confirm it on the next attempt” would be wrong here.
  const hostKeyChanged = failure?.code === "host_key_unknown" && /has changed|no longer matches/.test(failure.message);
  const known = failure
    ? branchMissing
      ? BRANCH_MISSING
      : hostKeyChanged
        ? { title: t("clone.errors.hostKeyChanged"), hint: failure.message }
        : CLONE_ERRORS[failure.code]
    : undefined;
  const failureTitle = known?.title ?? t("clone.errors.failed");
  const failureText: ReactNode = failure
    ? known?.hint
      ? known.hint
      : failure.message || errorInfo[failure.code]?.text || errorInfo.unknown.text
    : null;
  const output = failure?.gitOutput?.trim();

  let footer: ReactNode;
  if (running && confirmClose) {
    footer = (
      <>
        <Button key="ask-continue" autoFocus onClick={() => setConfirmClose(false)}>
          {t("clone.continue")}
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
          {t("clone.stop")}
        </Button>
      </>
    );
  } else if (running) {
    footer = (
      <>
        <Button key="cancel" loading={stopping} onClick={stop}>
          {t("clone.stop")}
        </Button>
        <Button key="busy" variant="primary" loading>
          {t("clone.busy")}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button onClick={onClose}>{t("ui.cancel")}</Button>
        <Button variant="primary" type="submit" form={formId}>
          {t("clone.action")}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open
      size="md"
      title={t("clone.title")}
      description={running ? undefined : t("clone.description")}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      footer={footer}
    >
      <form
        id={formId}
        data-screen="clone"
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
            <CloneProgress jobId={jobId} source={url.trim()} target={target} stopping={stopping} />
            {confirmClose ? (
              <div className="overflow-hidden rounded-md">
                <Banner tone="warning" title={t("clone.stillRunning.title")}>
                  {t("clone.stillRunning.body")}
                </Banner>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {failure ? (
              <div className="overflow-hidden rounded-md" data-clone-error={failure.code}>
                <Banner
                  tone="danger"
                  title={failureTitle}
                  actions={
                    output ? (
                      <Button size="sm" onClick={() => void showOutput(t("clone.errors.outputTitle"), output)}>
                        {t("ui.showOutput")}
                      </Button>
                    ) : undefined
                  }
                >
                  <span className="selectable">{failureText}</span> {t("clone.errors.noLeftovers")}
                </Banner>
              </div>
            ) : wasCancelled ? (
              <div className="overflow-hidden rounded-md" data-clone-cancelled>
                <Banner tone="info" title={t("clone.cancelled.title")}>
                  {t("clone.cancelled.body")}
                </Banner>
              </div>
            ) : null}

            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <label id={urlLabelId} htmlFor={`${formId}-url`} className="shrink-0 text-sm font-medium text-text-muted">
                  {t("ui.address")}
                </label>
                {url.trim() && parsed.ok ? <UrlBadge parsed={parsed} /> : null}
              </div>
              <TextField
                id={`${formId}-url`}
                autoFocus
                mono
                value={url}
                placeholder={t("clone.url.placeholder")}
                error={errors.url ?? undefined}
                hint={t("clone.url.hint")}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => changeUrl(event.target.value)}
              />
            </div>

            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  id={`${formId}-parent`}
                  label={t("clone.parent.label")}
                  mono
                  value={parent}
                  placeholder={t("clone.parent.placeholder")}
                  error={errors.parent ?? undefined}
                  autoComplete="off"
                  onChange={(event) => {
                    parentTouched.current = true;
                    setParent(event.target.value);
                    if (fieldFailure?.field === "parent" || fieldFailure?.field === "name") setFieldFailure(null);
                  }}
                />
              </div>
              <Button className="mt-5" icon={<FolderOpen className="size-icon" aria-hidden />} onClick={() => void browse()}>
                {t("ui.browse")}
              </Button>
            </div>

            <TextField
              id={`${formId}-name`}
              label={t("ui.folderName")}
              mono
              value={name}
              placeholder={t("clone.name.placeholder")}
              error={errors.name ?? undefined}
              autoComplete="off"
              onChange={(event) => {
                nameTouched.current = event.target.value !== "";
                setName(event.target.value);
                if (fieldFailure?.field === "name") setFieldFailure(null);
              }}
            />

            <p data-clone-target className="text-sm text-text-muted">
              {target ? (
                <>
                  {t("clone.target")} <WrappingPath path={target} className="text-text" />
                </>
              ) : (
                t("clone.targetHint")
              )}
            </p>

            <Collapsible.Root open={advancedOpen} onOpenChange={setAdvancedOpen} className="border-t border-border pt-2">
              <Collapsible.Trigger className="group flex h-control-sm w-full items-center gap-1 rounded-md text-left text-base text-text hover:bg-surface-raised">
                <ChevronRight
                  className="size-icon shrink-0 text-text-muted transition-transform group-data-[state=open]:rotate-90"
                  aria-hidden
                />
                <span className="font-medium">{t("clone.advanced")}</span>
                {!advancedOpen && summary.length ? (
                  <span className="min-w-0 truncate text-sm text-text-muted">– {summary.join(", ")}</span>
                ) : null}
              </Collapsible.Trigger>
              <Collapsible.Content className="flex flex-col gap-3 pt-2 pl-5">
                <Checkbox label={t("clone.shallow.label")} hint={t("clone.shallow.hint")} checked={shallow} onCheckedChange={setShallow} />
                {shallow ? (
                  <div className="flex items-start gap-3 pl-6">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-text-muted">{t("clone.shallow.limitBy")}</span>
                      <div className="flex h-control-md items-center">
                        <SegmentedControl
                          label={t("clone.shallow.limitByLabel")}
                          value={shallowBy}
                          options={[
                            { value: "depth", label: t("clone.shallow.depth") },
                            { value: "since", label: t("ui.date") },
                          ]}
                          onValueChange={setShallowBy}
                        />
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      {shallowBy === "depth" ? (
                        <TextField
                          id={`${formId}-depth`}
                          label={t("clone.shallow.depthLabel")}
                          mono
                          inputMode="numeric"
                          value={depth}
                          error={errors.depth ?? undefined}
                          onChange={(event) => setDepth(event.target.value)}
                        />
                      ) : (
                        <TextField
                          id={`${formId}-since`}
                          label={t("clone.shallow.sinceLabel")}
                          mono
                          value={since}
                          placeholder="2026-01-31"
                          error={errors.since ?? undefined}
                          onChange={(event) => setSince(event.target.value)}
                        />
                      )}
                    </div>
                  </div>
                ) : null}

                <TextField
                  id={`${formId}-branch`}
                  label={t("ui.branch")}
                  mono
                  value={branch}
                  placeholder={t("clone.branch.placeholder")}
                  hint={t("clone.branch.hint")}
                  error={errors.branch ?? undefined}
                  autoComplete="off"
                  onChange={(event) => {
                    setBranch(event.target.value);
                    if (fieldFailure?.field === "branch") setFieldFailure(null);
                  }}
                />

                <Checkbox label={t("ui.sparseCheckout")} hint={t("clone.sparse.hint")} checked={sparse} onCheckedChange={setSparse} />
                {sparse ? (
                  <div className="pl-6">
                    <TextArea
                      id={`${formId}-sparse`}
                      label={t("clone.sparse.pathsLabel")}
                      rows={3}
                      className="font-mono text-code"
                      spellCheck={false}
                      value={sparseText}
                      placeholder={t("clone.sparse.pathsPlaceholder")}
                      error={errors.sparse ?? undefined}
                      onChange={(event) => setSparseText(event.target.value)}
                    />
                  </div>
                ) : null}

                <Checkbox label={t("clone.submodules")} checked={submodules} onCheckedChange={setSubmodules} />
              </Collapsible.Content>
            </Collapsible.Root>
          </>
        )}
      </form>
    </Dialog>
  );
}
