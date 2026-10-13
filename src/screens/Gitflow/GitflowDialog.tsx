/**
 * Gitflow. One dialog for everything: set up (main and development branch, prefixes), start a
 * feature, release or hotfix, and the running branches with "Finish …".
 * As long as Gitflow is not set up, starting stays locked – with a reason.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trans } from "react-i18next";
import { ArrowLeft, Check, GitBranch, GitMerge, RefreshCw, Settings2, Workflow } from "lucide-react";
import { core, type GitflowKind, type GitflowPrefixes, type GitflowStatus, type Id } from "../../core";
import { gitflowBusyKey, gitflowKey, initGitflow, kindLabels, startGitflow } from "../../app/actions/gitflow";
import { describeError } from "../../app/errors";
import { useRefs, useStatus } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { SegmentedControl, TextField } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";

export const useGitflow = (repoId: Id) => useQuery({ queryKey: gitflowKey(repoId), queryFn: () => core.gitflowStatus({ repoId }) });

const kinds: GitflowKind[] = ["feature", "release", "hotfix"];
/** Spaces turn into "-" while typing (as with branch names everywhere in the app). */
const dashed = (value: string) => value.replace(/\s/g, "-");

export interface GitflowDialogProps {
  repoId: Id;
  /** "Start" begins with this kind. */
  initialKind?: GitflowKind;
  /** `finish`: the user wants to finish this branch – the caller then opens the finish dialog. */
  onDone: (next: { finish: { kind: GitflowKind; name: string; branch: string } } | null) => void;
}

function Skeleton() {
  return (
    <div role="status" aria-label={t("gitflow.loading")} className="flex animate-pulse flex-col gap-3">
      <div className="h-4 w-64 rounded-sm bg-surface-raised" />
      <div className="h-control-md w-full rounded-md bg-surface-raised" />
      <div className="h-control-md w-full rounded-md bg-surface-raised" />
      <div className="h-4 w-40 rounded-sm bg-surface-raised" />
    </div>
  );
}

function SectionTitle({ children, id }: { children: string; id?: string }) {
  return (
    <h3 id={id} className="text-xs font-semibold tracking-wide text-text-muted uppercase">
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Set up
// ---------------------------------------------------------------------------

function SetupForm({ repoId, status, onCancel }: { repoId: Id; status: GitflowStatus; onCancel: (() => void) | null }) {
  const { data: refs } = useRefs(repoId);
  const busy = useBusy(gitflowBusyKey(repoId));
  const locals = refs?.locals.map((ref) => ref.name) ?? [];
  const [main, setMain] = useState(status.main);
  const [develop, setDevelop] = useState(status.develop);
  const [prefixes, setPrefixes] = useState<GitflowPrefixes>(status.prefixes);
  const [failure, setFailure] = useState<string | null>(null);

  // The core's suggestion applies as long as that branch exists; otherwise the checked-out or the first one.
  const mainOptions = locals.length ? locals : [status.main];
  const mainValue = mainOptions.includes(main) ? main : (refs?.locals.find((ref) => ref.isHead)?.name ?? mainOptions[0] ?? main);
  const developName = develop.trim();
  const developExists = locals.includes(developName);
  const sameBranch = developName !== "" && developName === mainValue;
  const developError = sameBranch ? t("gitflow.setup.sameBranch") : null;
  const emptyPrefix = kinds.find((kind) => !prefixes[kind].trim());
  const duplicate = new Set(kinds.map((kind) => prefixes[kind].trim())).size < kinds.length;
  const prefixError = emptyPrefix ? t("gitflow.setup.prefixMissing", { kind: kindLabels[emptyPrefix] }) : duplicate ? t("gitflow.setup.prefixDuplicate") : null;
  const blocked = !developName ? t("gitflow.setup.developMissing") : (developError ?? prefixError);

  const submit = async () => {
    if (blocked || busy) return;
    setFailure(null);
    const result = await initGitflow(repoId, {
      main: mainValue,
      develop: developName,
      prefixes: { feature: prefixes.feature.trim(), release: prefixes.release.trim(), hotfix: prefixes.hotfix.trim(), versionTag: prefixes.versionTag.trim() },
    });
    if (result.ok) onCancel?.();
    else if (["invalid_name", "not_found", "not_allowed"].includes(result.error.code)) setFailure(describeError(result.error).text);
  };

  const prefixField = (key: keyof GitflowPrefixes, label: string, placeholder: string) => (
    <TextField
      label={label}
      mono
      value={prefixes[key]}
      placeholder={placeholder}
      autoComplete="off"
      onChange={(event) => setPrefixes((current) => ({ ...current, [key]: dashed(event.target.value) }))}
    />
  );

  return (
    <form
      data-gitflow-form="setup"
      aria-label={t("gitflow.setup.label")}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Select
          label={t("gitflow.setup.main")}
          hint={t("gitflow.setup.mainHint")}
          value={mainValue}
          options={mainOptions.map((name) => ({ value: name, label: name }))}
          onValueChange={setMain}
        />
        <TextField
          label={t("gitflow.setup.develop")}
          mono
          data-autofocus
          value={develop}
          autoComplete="off"
          error={developError ?? undefined}
          hint={!developName ? undefined : developExists ? t("gitflow.setup.developExists") : t("gitflow.setup.developCreated", { base: mainValue })}
          onChange={(event) => setDevelop(dashed(event.target.value))}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">{t("gitflow.setup.prefixes")}</legend>
        <div className="grid grid-cols-4 gap-3">
          {prefixField("feature", t("gitflow.setup.feature"), "feature/")}
          {prefixField("release", t("gitflow.setup.release"), "release/")}
          {prefixField("hotfix", t("gitflow.setup.hotfix"), "hotfix/")}
          {prefixField("versionTag", t("gitflow.setup.versionTag"), t("gitflow.setup.versionTagPlaceholder"))}
        </div>
        <p className="text-sm text-text-muted">
          <Trans i18nKey="gitflow.setup.example" values={{ feature: prefixes.feature || "…", tag: prefixes.versionTag }} components={{ code: <span className="font-mono text-code text-text" /> }} />
        </p>
        {prefixError ? (
          <p role="alert" className="text-sm text-danger">
            {prefixError}
          </p>
        ) : null}
      </fieldset>
      {failure ? (
        <div className="overflow-hidden rounded-md" data-gitflow-failure>
          <Banner tone="danger" title={t("gitflow.setup.failed")}>
            <span className="selectable">{failure}</span>
          </Banner>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button icon={<ArrowLeft className="size-icon" aria-hidden />} onClick={onCancel}>
            {t("gitflow.setup.back")}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          data-action="gitflow-init"
          aria-disabled={blocked ? true : undefined}
          title={blocked ?? undefined}
          className="aria-disabled:cursor-default aria-disabled:bg-surface-raised aria-disabled:text-text-disabled aria-disabled:hover:brightness-100"
        >
          {status.initialized ? t("gitflow.setup.save") : t("gitflow.setup.submit")}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function StartForm({ repoId, status, initialKind, onStarted }: { repoId: Id; status: GitflowStatus; initialKind: GitflowKind; onStarted: () => void }) {
  const busy = useBusy(gitflowBusyKey(repoId));
  const { data: repoStatus } = useStatus(repoId);
  const [kind, setKind] = useState<GitflowKind>(initialKind);
  const [name, setName] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const checkId = useRef(0);
  const nameId = useId();
  const ready = status.initialized;

  const prefix = status.prefixes[kind];
  const full = `${prefix}${name.trim()}`;
  const running = kind === "feature" ? undefined : status.active.find((item) => item.kind === kind);
  const base = kind === "hotfix" ? status.main : status.develop;
  const operation = repoStatus?.operation ?? null;

  // While typing, the name is checked against Git's rules and existing branches.
  useEffect(() => {
    const id = ++checkId.current;
    setFailure(null);
    if (!ready || !name.trim()) {
      setReason(null);
      return;
    }
    const timer = window.setTimeout(() => {
      core.refNameCheck({ repoId, name: full, kind: "branch" }).then(
        (result) => {
          if (id === checkId.current) setReason(result.valid ? null : (result.reason ?? t("gitflow.start.nameInvalid")));
        },
        () => undefined,
      );
    }, 150);
    return () => window.clearTimeout(timer);
  }, [repoId, full, name, ready]);

  const blocked = !ready
    ? t("gitflow.start.notReady")
    : operation
      ? t("gitflow.start.operation")
      : running
        ? t("gitflow.start.running", { kind: kindLabels[kind], name: running.name, branch: running.branch })
        : !name.trim()
          ? t("gitflow.start.nameMissing")
          : reason;

  const submit = async () => {
    if (blocked || busy) return;
    setFailure(null);
    const result = await startGitflow(repoId, kind, name.trim());
    if (result.ok) onStarted();
    else if (["invalid_name", "name_exists", "not_allowed"].includes(result.error.code)) setFailure(describeError(result.error).text);
  };

  return (
    <form
      data-gitflow-form="start"
      aria-labelledby={`${nameId}-title`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <SectionTitle id={`${nameId}-title`}>{t("gitflow.start.title")}</SectionTitle>
      {!ready ? (
        <p className="text-sm text-text-muted" data-gitflow-locked>
          {t("gitflow.start.locked")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl label={t("gitflow.start.kind")} value={kind} options={kinds.map((value) => ({ value, label: kindLabels[value] }))} onValueChange={setKind} />
        <p className="text-sm text-text-muted">
          <Trans i18nKey="gitflow.start.branchesFrom" values={{ base }} components={{ code: <span className="font-mono text-code text-text" /> }} />
        </p>
      </div>
      <div className="flex items-start gap-2">
        <div className="relative min-w-0 flex-1">
          <label htmlFor={nameId} className="sr-only">
            {t("gitflow.start.name")}
          </label>
          <div
            className={cn(
              "flex h-control-md items-center rounded-md border bg-surface-sunken focus-within:border-accent",
              (reason || failure) && name.trim() ? "border-danger" : "border-border-input",
              !ready && "border-border",
            )}
          >
            <span aria-hidden className="shrink-0 pl-2 font-mono text-code text-text-muted">
              {prefix}
            </span>
            <input
              id={nameId}
              data-autofocus={ready ? "" : undefined}
              disabled={!ready}
              value={name}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={kind === "feature" ? t("gitflow.start.featurePlaceholder") : "1.2.0"}
              aria-invalid={(reason || failure) && name.trim() ? true : undefined}
              aria-describedby={`${nameId}-note`}
              className="h-full min-w-0 flex-1 rounded-md bg-transparent pr-2 font-mono text-code text-text outline-none placeholder:text-text-muted disabled:text-text-disabled"
              onChange={(event) => setName(dashed(event.target.value))}
            />
          </div>
        </div>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          icon={<GitBranch className="size-icon" aria-hidden />}
          data-action="gitflow-start"
          aria-disabled={blocked ? true : undefined}
          title={blocked ?? undefined}
          className="aria-disabled:cursor-default aria-disabled:bg-surface-raised aria-disabled:text-text-disabled aria-disabled:hover:brightness-100"
        >
          {t("gitflow.start.submit", { kind: kindLabels[kind] })}
        </Button>
      </div>
      <p id={`${nameId}-note`} role={failure || (reason && name.trim()) || running ? "alert" : undefined} data-gitflow-note className={cn("min-h-4 text-sm", failure || (reason && name.trim()) || running ? "text-danger" : "text-text-muted")}>
        {!ready
          ? ""
          : (failure ??
            (running
              ? blocked
              : name.trim()
                ? (reason ?? t("gitflow.start.willCreate", { branch: full }))
                : kind === "feature"
                  ? t("gitflow.start.featureHint")
                  : kind === "release"
                    ? t("gitflow.start.releaseHint")
                    : t("gitflow.start.hotfixHint")))}
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function GitflowDialog({ repoId, initialKind = "feature", onDone }: GitflowDialogProps) {
  const gitflow = useGitflow(repoId);
  const { data: repoStatus } = useStatus(repoId);
  const [editing, setEditing] = useState(false);
  const status = gitflow.data;
  const current = repoStatus?.head.kind === "branch" ? repoStatus.head.branch : null;
  const state = gitflow.isPending ? "loading" : gitflow.isError ? "error" : !status!.initialized ? "setup" : editing ? "editing" : "ready";

  // After setting up (or changing) the form disappears: focus goes to the name field of "Start",
  // and when the change form opens, to its first field.
  const previous = useRef(state);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before === state) return;
    const root = document.querySelector('[data-screen="gitflow"]');
    if (state === "ready" && (before === "setup" || before === "editing")) root?.querySelector<HTMLElement>('form[data-gitflow-form="start"] input')?.focus();
    else if (state === "editing") root?.querySelector<HTMLElement>('form[data-gitflow-form="setup"] input')?.focus();
  }, [state]);

  return (
    <Dialog
      open
      size="md"
      title={t("gitflow.title")}
      description={
        state === "setup"
          ? t("gitflow.description.setup")
          : state === "ready" || state === "editing"
            ? t("gitflow.description.ready")
            : undefined
      }
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={<Button onClick={() => onDone(null)}>{t("gitflow.close")}</Button>}
    >
      <div data-screen="gitflow" data-gitflow-state={state} className="flex flex-col gap-4">
        {state === "loading" ? <Skeleton /> : null}
        {state === "error" ? (
          <div className="overflow-hidden rounded-md">
            <Banner
              tone="danger"
              title={t("gitflow.readFailed")}
              actions={
                <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void gitflow.refetch()}>
                  {t("gitflow.retry")}
                </Button>
              }
            >
              <span className="selectable">{describeError(gitflow.error).text}</span>
            </Banner>
          </div>
        ) : null}

        {status && state === "setup" ? (
          <>
            <div className="overflow-hidden rounded-md">
              <Banner tone="info" title={t("gitflow.notSetUp.title")}>
                {t("gitflow.notSetUp.body")}
              </Banner>
            </div>
            <SetupForm repoId={repoId} status={status} onCancel={null} />
            <StartForm repoId={repoId} status={status} initialKind={initialKind} onStarted={() => onDone(null)} />
          </>
        ) : null}

        {status && state === "editing" ? <SetupForm repoId={repoId} status={status} onCancel={() => setEditing(false)} /> : null}

        {status && state === "ready" ? (
          <>
            <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2" data-gitflow-summary>
              <Workflow className="size-icon shrink-0 text-text-muted" aria-hidden />
              <p className="min-w-0 flex-1 text-sm text-text-muted">
                <Trans i18nKey="gitflow.summary.branches" values={{ main: status.main, develop: status.develop }} components={{ code: <span className="font-mono text-code text-text" /> }} />
                <span className="block truncate">
                  {t("gitflow.summary.prefixes", { list: [status.prefixes.feature, status.prefixes.release, status.prefixes.hotfix].join(" · ") })}
                  {status.prefixes.versionTag ? t("gitflow.summary.tags", { prefix: status.prefixes.versionTag }) : ""}
                </span>
              </p>
              <Button size="sm" variant="ghost" icon={<Settings2 className="size-3.5" aria-hidden />} onClick={() => setEditing(true)}>
                {t("gitflow.editSetup")}
              </Button>
            </div>

            <StartForm repoId={repoId} status={status} initialKind={initialKind} onStarted={() => onDone(null)} />

            <section aria-labelledby="gitflow-active-title" className="flex flex-col gap-2">
              <SectionTitle id="gitflow-active-title">{t("gitflow.active.title", { count: status.active.length })}</SectionTitle>
              {status.active.length === 0 ? (
                <p className="text-sm text-text-muted" data-gitflow-empty>
                  {t("gitflow.active.empty")}
                </p>
              ) : (
                <ul aria-label={t("gitflow.active.label")} className="max-h-48 overflow-auto rounded-md border border-border bg-surface-sunken py-1">
                  {status.active.map((item) => (
                    <li key={item.branch} data-gitflow-branch={item.branch} className="flex h-control-lg items-center gap-2 px-2">
                      <span className="w-16 shrink-0 text-sm font-medium text-text-muted">{kindLabels[item.kind]}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-code text-text" title={item.branch}>
                        {item.branch}
                      </span>
                      {item.branch === current ? (
                        <span className="flex shrink-0 items-center gap-1 text-sm text-text-muted">
                          <Check className="size-3.5" aria-hidden />
                          {t("gitflow.active.checkedOut")}
                        </span>
                      ) : null}
                      <Button
                        size="sm"
                        icon={<GitMerge className="size-3.5" aria-hidden />}
                        aria-label={t("gitflow.active.finishLabel", { kind: kindLabels[item.kind], name: item.name })}
                        onClick={() => onDone({ finish: item })}
                      >
                        {t("gitflow.active.finish")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
