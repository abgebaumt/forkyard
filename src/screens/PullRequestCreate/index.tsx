/**
 * Create a pull request. View in the centre: source and target, title (prefilled from the only
 * commit or the branch name), description in Markdown with preview (prefilled from the
 * repository's template), draft, reviewers, labels.
 *
 * Before creating, the view checks what the host would otherwise reject: is the branch on the
 * remote (otherwise "Push first" as a separate step, with progress)? Is there already an open pull
 * request for it (then a button leads there)? After creating, the pull request view opens.
 *
 * Keys: Ctrl+Enter creates (from any field), Esc closes (asks if there is already text).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { ArrowRight, Check, CircleAlert, CloudUpload, GitPullRequestArrow, GitPullRequestCreate, Loader2, Plug, RefreshCw, Unplug, X } from "lucide-react";
import type { Id, Ref } from "../../core";
import { openIntegrations } from "../../app/actions/hosts";
import { describeHostError, hostKindLabels, hostPrWord, type HostErrorText, type HostRepo } from "../../app/actions/hostTypes";
import { commitsAhead, createPullRequest, openPr, prBusyKeys, pushBranchForPr, pushState, suggestTitle } from "../../app/actions/pullrequests";
import { busyKeys } from "../../app/actions/keys";
import { confirm, hasOpenDialog } from "../../app/dialogs";
import { hasOpenMenu } from "../../app/menus/host";
import { useHostRepo, usePrTemplate, usePullRequests, useRefs, useRemotes, useStatus } from "../../app/queries";
import { newJobId } from "../../app/run";
import { setCenterGuard, useAppStore, useBusy, useTabView, type CenterGuard } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { Banner, EmptyState } from "../../ui/Feedback";
import { Checkbox, SegmentedControl, TextArea, TextField } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { cn } from "../../ui/cn";
import { isPlainEscape, ownsKey } from "../FileView/parts";
import { SafeMarkdown } from "../PullRequestView/Markdown";
import { openConnectDialog } from "../Hosts";
import { t } from "../../i18n";
import { parentRemote, splitNames, targetBranches } from "./model";

export interface PullRequestCreateProps {
  repoId: Id;
  tabId: Id;
}

function Frame({ tabId, detail, children, onClose }: { tabId: Id; detail?: string | null; children: ReactNode; onClose?: () => void }) {
  const closeCenter = useAppStore((state) => state.closeCenter);
  return (
    <section aria-label={t("pullRequest.create.title")} data-screen="pr-create" className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <GitPullRequestCreate className="size-icon shrink-0 text-text-muted" aria-hidden />
        <h2 className="m-0 shrink-0 text-base font-medium text-text">{t("pullRequest.create.title")}</h2>
        {detail ? (
          <span className="selectable min-w-0 truncate font-mono text-code text-text-muted" title={detail}>
            {detail}
          </span>
        ) : null}
        <span className="flex-1" />
        <IconButton size="sm" label={t("pullRequest.create.close")} shortcut="Escape" data-back="" icon={<X className="size-icon" aria-hidden />} onClick={onClose ?? (() => closeCenter(tabId))} />
      </header>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div role="status" aria-label={t("pullRequest.create.loading")} data-loading="" className="mx-auto flex w-full max-w-180 animate-pulse flex-col gap-4 p-6">
      <div className="h-8 w-2/3 rounded-sm bg-surface-raised" />
      <div className="h-8 w-full rounded-sm bg-surface-raised" />
      <div className="h-40 w-full rounded-sm bg-surface-raised" />
      <div className="h-8 w-1/3 rounded-sm bg-surface-raised" />
    </div>
  );
}

/** Full-area state instead of the form: not connected, no host detected, error. */
function Blocked({ state, icon, title, children, action }: { state: string; icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div data-pr-state={state} className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <EmptyState icon={icon} title={title} action={action}>
        {children}
      </EmptyState>
    </div>
  );
}

function StepRow({ state, title, children, action }: { state: "done" | "todo" | "running" | "problem"; title: string; children?: ReactNode; action?: ReactNode }) {
  const icon =
    state === "done" ? (
      <Check className="size-icon text-success" aria-hidden />
    ) : state === "running" ? (
      <Loader2 className="size-icon animate-spin text-accent" aria-hidden />
    ) : state === "problem" ? (
      <CircleAlert className="size-icon text-danger" aria-hidden />
    ) : (
      <CloudUpload className="size-icon text-warning" aria-hidden />
    );
  return (
    <li data-step-state={state} className="flex items-start gap-2 px-3 py-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-base text-text">{title}</p>
        {children ? <div className="text-sm text-text-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

/** Progress of the running push (percent and Git's last line), from the status bar's jobs. */
function PushProgress({ jobId }: { jobId: string }) {
  const job = useAppStore((state) => state.jobs[jobId]);
  const percent = job?.percent ?? null;
  return (
    <div data-push-progress="" className="mt-1 flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={t("pullRequest.create.pushProgress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1 w-full overflow-hidden rounded-pill bg-surface-raised"
      >
        <div className={cn("h-full rounded-pill bg-accent", percent === null && "w-1/3 animate-pulse")} style={percent === null ? undefined : { width: `${Math.max(2, Math.min(100, percent))}%` }} />
      </div>
      <p className="truncate font-mono text-code text-text-muted">{job?.line || job?.phase || t("pullRequest.create.connecting")}</p>
    </div>
  );
}

/** A pull request title may not be longer than this (the hosts' limit is higher). */
const TITLE_LIMIT = 300;

export function PullRequestCreate({ repoId, tabId }: PullRequestCreateProps) {
  const closeCenter = useAppStore((state) => state.closeCenter);
  const hostRepo = useHostRepo(repoId);

  let body: ReactNode;
  const error = hostRepo.isError ? describeHostError(hostRepo.error) : null;
  const repo = hostRepo.data ?? null;

  if (hostRepo.isPending) {
    body = <Skeleton />;
  } else if (error && error.kind !== "not_connected") {
    body = (
      <Blocked
        state={`error-${error.kind}`}
        icon={<CircleAlert className="size-6" aria-hidden />}
        title={error.title}
        action={
          <div className="flex gap-2">
            <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void hostRepo.refetch()}>
              {t("pullRequest.create.retry")}
            </Button>
            {error.kind === "auth" ? (
              <Button size="sm" onClick={openIntegrations}>
                {t("pullRequest.create.openIntegrations")}
              </Button>
            ) : null}
          </div>
        }
      >
        {error.text} {error.hint}
      </Blocked>
    );
  } else if (!repo || !repo.kind) {
    body = (
      <Blocked
        state="no-host"
        icon={<Unplug className="size-6" aria-hidden />}
        title={t("pullRequest.create.noHost")}
        action={
          <Button size="sm" icon={<Plug className="size-3.5" aria-hidden />} onClick={() => void openConnectDialog()}>
            {t("pullRequest.create.connect")}
          </Button>
        }
      >
        {t("pullRequest.create.noHostText")}
      </Blocked>
    );
  } else if (!repo.account || error) {
    body = (
      <Blocked
        state="not-connected"
        icon={<Plug className="size-6" aria-hidden />}
        title={t("pullRequest.create.notConnected", { host: hostKindLabels[repo.kind] })}
        action={
          <Button size="sm" variant="primary" icon={<Plug className="size-3.5" aria-hidden />} onClick={() => void openConnectDialog({ kind: repo.kind ?? undefined })}>
            {t("pullRequest.create.connect")}
          </Button>
        }
      >
        {t("pullRequest.create.notConnectedText", { repo: `${repo.owner}/${repo.name}`, host: hostKindLabels[repo.kind], word: hostPrWord[repo.kind] })}
      </Blocked>
    );
  } else {
    return <CreateForm key={repoId} repoId={repoId} tabId={tabId} repo={repo} />;
  }

  return (
    <Frame tabId={tabId} detail={repo ? `${repo.owner}/${repo.name}` : null} onClose={() => closeCenter(tabId)}>
      {body}
    </Frame>
  );
}

function CreateForm({ repoId, tabId, repo }: { repoId: Id; tabId: Id; repo: HostRepo }) {
  const center = useTabView(tabId).center;
  const preset = center.kind === "pr_create" ? center : { source: undefined, target: undefined };
  const refs = useRefs(repoId);
  const status = useStatus(repoId);
  const remotes = useRemotes(repoId);
  const openPrs = usePullRequests(repoId, "open");
  const template = usePrTemplate(repoId);
  const creating = useBusy(prBusyKeys.create(repoId));
  const pushing = useBusy(busyKeys.push(repoId));
  const root = useRef<HTMLFormElement>(null);

  const locals = refs.data?.locals ?? [];
  const headBranch = status.data?.head.kind === "branch" ? status.data.head.branch : (locals.find((ref) => ref.isHead)?.name ?? null);

  const [source, setSource] = useState<string | null>(preset.source ?? null);
  const [target, setTarget] = useState<string | null>(preset.target ?? null);
  const [intoParent, setIntoParent] = useState(false);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [text, setText] = useState("");
  const [textTouched, setTextTouched] = useState(false);
  const [fromTemplate, setFromTemplate] = useState(false);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState("");
  const [labels, setLabels] = useState("");
  const [failure, setFailure] = useState<HostErrorText | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [pushJob, setPushJob] = useState<string | null>(null);
  const [ahead, setAhead] = useState<number | null>(null);
  const sent = useRef(false);

  const sourceName = source ?? headBranch;
  const sourceRef: Ref | undefined = locals.find((ref) => ref.name === sourceName);
  // Fork: the pull request can also go to the original – if it is set up as a remote (only then
  // does the app know its branches and the core the target). With GitLab this only works at the host itself.
  const upstream = useMemo(() => (repo.kind === "github" ? parentRemote(remotes.data ?? [], repo.forkParent, repo.remote) : null), [remotes.data, repo]);
  const toParent = intoParent && upstream !== null;
  const targetOptions = useMemo(
    () => (toParent ? targetBranches(refs.data?.remotes ?? [], remotes.data ?? [], null, upstream) : targetBranches(refs.data?.remotes ?? [], remotes.data ?? [], repo.defaultBranch, repo.remote)),
    [refs.data, remotes.data, toParent, upstream, repo],
  );
  // The default branch comes from the host. If it does not answer right now (limit, token), the last
  // known one applies; otherwise the usual name – never simply the first branch in the list.
  const knownDefault = useRef(repo.defaultBranch);
  if (repo.defaultBranch) knownDefault.current = repo.defaultBranch;
  const usual = (names: string[]) => names.find((name) => name === knownDefault.current) ?? names.find((name) => name === "main") ?? names.find((name) => name === "master") ?? names[0] ?? null;
  const hostDefault = toParent ? null : knownDefault.current;
  const defaultTarget = toParent ? usual(targetOptions) : (knownDefault.current ?? usual(targetOptions));
  const targetName = target ?? defaultTarget;
  const pushed = pushState(sourceRef);
  const existing = sourceName ? (openPrs.data?.pages.flatMap((page) => page.items).find((pr) => pr.sourceBranch === sourceName) ?? null) : null;
  const sameBranch = Boolean(sourceName && targetName && sourceName === targetName && !toParent);

  // Title suggestion: the only commit, otherwise the branch name – as long as nobody has typed.
  const targetSha = useMemo(() => {
    if (!targetName) return null;
    const all = refs.data?.remotes ?? [];
    const remote = toParent ? upstream : (repo.remote ?? "origin");
    return (all.find((ref) => ref.name === `${remote}/${targetName}`) ?? all.find((ref) => ref.remote && ref.name === `${ref.remote}/${targetName}`) ?? refs.data?.locals.find((ref) => ref.name === targetName))?.sha ?? null;
  }, [refs.data, targetName, toParent, upstream, repo.remote]);
  useEffect(() => {
    if (!sourceName) return;
    let current = true;
    const sourceSha = sourceRef?.sha ?? null;
    void (async () => {
      const commits = sourceSha && targetSha ? await commitsAhead(repoId, sourceSha, targetSha) : null;
      if (!current) return;
      setAhead(commits ? commits.length : null);
      if (!titleTouched) setTitle(suggestTitle(sourceName, commits ? commits.map((commit) => commit.summary) : null));
    })();
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, sourceName, sourceRef?.sha, targetSha]);

  // Template from the repository, as long as the description is empty and untouched.
  useEffect(() => {
    if (template.data && !textTouched && !text) {
      setText(template.data);
      setFromTemplate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.data]);

  // Unsent text: leaving asks first.
  const dirty = (titleTouched && title.trim().length > 0) || (textTouched && text.trim().length > 0);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const guard: CenterGuard = {
      dirty: () => dirtyRef.current && !sent.current,
      confirmLeave: () =>
        confirm({
          title: t("pullRequest.create.leave.title"),
          body: t("pullRequest.create.leave.body"),
          confirmLabel: t("pullRequest.create.leave.confirm"),
          danger: true,
        }),
    };
    setCenterGuard(tabId, guard);
    return () => setCenterGuard(tabId, null, guard);
  }, [tabId]);

  const close = () => useAppStore.getState().closeCenter(tabId);

  // On open, focus is in the title – unless a dialog or menu is currently on top.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      root.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Esc closes – except in text fields, menus and dialogs.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlainEscape(event)) return;
      if (!ownsKey(event, hasOpenDialog() || hasOpenMenu() || Boolean(useAppStore.getState().overlay))) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const runPush = async (): Promise<boolean> => {
    if (!sourceName) return false;
    const jobId = newJobId();
    setPushJob(jobId);
    const result = await pushBranchForPr(repoId, sourceName, jobId);
    setPushJob(null);
    return result.ok && result.value.status !== "rejected";
  };

  const needsPush = pushed.state === "no_upstream" || pushed.state === "ahead";
  const blockedReason = !sourceName
    ? t("pullRequest.create.blocked.noSource")
    : !targetName
      ? t("pullRequest.create.blocked.noTarget")
      : sameBranch
        ? t("pullRequest.create.blocked.same")
        : existing
          ? t("pullRequest.create.blocked.existing", { branch: sourceName, number: existing.number })
          : ahead === 0 && !needsPush
            ? t("pullRequest.create.blocked.nothing", { source: sourceName, target: targetName })
            : null;

  const submit = async () => {
    if (creating || pushing || blockedReason || !sourceName || !targetName) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setTitleError(t("pullRequest.create.titleRequired"));
      root.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
      return;
    }
    setFailure(null);
    if (needsPush && !(await runPush())) return;
    // Already now: on success the centre switches to the pull request view, and the leave guard must not ask anymore then.
    sent.current = true;
    const result = await createPullRequest(
      {
        repoId,
        title: cleanTitle,
        body: text,
        // From the fork into the original: GitHub wants the source as "owner:branch", the target repository via its remote.
        sourceBranch: toParent ? `${repo.owner}:${sourceName}` : sourceName,
        targetBranch: targetName,
        draft: repo.capabilities.draftPrs && draft,
        reviewers: repo.capabilities.prReviewers ? splitNames(reviewers) : [],
        labels: repo.capabilities.prLabels ? splitNames(labels) : [],
        remote: toParent ? upstream : null,
      },
      tabId,
    );
    if (result.ok) return;
    sent.current = false;
    if (result.error.code === "cancelled" || result.error.code === "duplicate") return;
    // Meanwhile someone created one for the branch: reload the list – then the notice at the top leads there.
    if (result.error.code === "name_exists") void openPrs.refetch();
    setFailure(describeHostError(result.error));
  };

  const onFormKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const kind = repo.kind ?? "github";
  const word = hostPrWord[kind];
  const sourceOptions = locals.map((ref) => ({ value: ref.name, label: ref.name }));
  const loadingRefs = refs.isPending;

  return (
    <Frame tabId={tabId} detail={`${repo.owner}/${repo.name}`} onClose={close}>
      <form
        ref={root}
        data-pr-state="form"
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={onFormKeyDown}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="@container mx-auto flex w-full max-w-180 flex-col gap-4 px-6 py-5">
            {!repo.canPush && !repo.forkParent ? (
              <div className="overflow-hidden rounded-md" data-pr-note="no-push">
                <Banner tone="warning" title={t("pullRequest.create.noPush.title")}>
                  {t("pullRequest.create.noPush.text", { word })}
                </Banner>
              </div>
            ) : null}

            {/* Source and target */}
            {repo.error ? (
              <div className="overflow-hidden rounded-md" data-pr-note="host-error">
                <Banner tone="warning" title={describeHostError(repo.error).title}>
                  {describeHostError(repo.error).text} {t("pullRequest.create.lastState")}
                </Banner>
              </div>
            ) : null}

            {/* min-w-0: otherwise a fieldset never gets narrower than its content – long branch names would burst the row. */}
            <fieldset className="flex min-w-0 flex-wrap items-end gap-3">
              <legend className="sr-only">{t("pullRequest.create.sourceAndTarget")}</legend>
              <div className="min-w-40 flex-1">
                {loadingRefs ? (
                  <div role="status" aria-label={t("pullRequest.create.loadingBranches")} className="h-control-md animate-pulse rounded-md bg-surface-raised" />
                ) : sourceOptions.length ? (
                  <Select label={t("pullRequest.create.sourceLabel")} value={sourceName ?? ""} placeholder={t("pullRequest.create.chooseBranch")} options={sourceOptions} onValueChange={(next) => setSource(next)} />
                ) : (
                  <p className="text-base text-text-muted">{t("pullRequest.create.noLocals")}</p>
                )}
              </div>
              <ArrowRight className="mb-2 size-icon shrink-0 text-text-muted" aria-hidden />
              <div className="min-w-40 flex-1">
                {loadingRefs ? (
                  <div role="status" aria-label={t("pullRequest.create.loadingBranches")} className="h-control-md animate-pulse rounded-md bg-surface-raised" />
                ) : (
                  <Select
                    label={toParent && repo.forkParent ? t("pullRequest.create.targetIn", { repo: `${repo.forkParent.owner}/${repo.forkParent.name}` }) : t("pullRequest.create.target")}
                    value={targetName ?? ""}
                    placeholder={t("pullRequest.create.chooseBranch")}
                    options={targetOptions.map((name) => ({ value: name, label: name === hostDefault ? t("pullRequest.create.default", { name }) : name }))}
                    onValueChange={(next) => setTarget(next)}
                  />
                )}
              </div>
            </fieldset>

            {repo.forkParent && upstream ? (
              <div data-pr-fork="choice">
                <span className="mb-1 block text-sm font-medium text-text-muted">{t("pullRequest.create.targetRepo")}</span>
                <SegmentedControl
                  label={t("pullRequest.create.targetRepo")}
                  value={toParent ? "parent" : "own"}
                  options={[
                    { value: "own", label: `${repo.owner}/${repo.name}` },
                    { value: "parent", label: t("pullRequest.create.original", { repo: `${repo.forkParent.owner}/${repo.forkParent.name}` }) },
                  ]}
                  onValueChange={(next) => {
                    setIntoParent(next === "parent");
                    setTarget(null);
                  }}
                />
              </div>
            ) : repo.forkParent ? (
              <p data-pr-fork="hint" className="text-sm text-text-muted">
                {t("pullRequest.create.forkHint", { repo: `${repo.forkParent.owner}/${repo.forkParent.name}`, word })}{" "}
                {repo.kind === "github"
                  ? t("pullRequest.create.forkGithub")
                  : repo.kind === "gitlab"
                    ? t("pullRequest.create.forkGitlab")
                    : t("pullRequest.create.forkOther", { word, host: hostKindLabels[repo.kind ?? "gitea"] })}
              </p>
            ) : null}

            {/* Pre-checks */}
            <ul aria-label={t("pullRequest.create.steps")} data-pr-steps="" className="divide-y divide-border rounded-md border border-border bg-surface">
              {sameBranch ? (
                <StepRow state="problem" title={t("pullRequest.create.same.title")}>
                  {t("pullRequest.create.same.text")}
                </StepRow>
              ) : null}
              {existing ? (
                <StepRow
                  state="problem"
                  title={t("pullRequest.create.existing.title", { branch: sourceName, number: existing.number })}
                  action={
                    <Button size="sm" variant="primary" icon={<GitPullRequestArrow className="size-3.5" aria-hidden />} onClick={() => openPr(tabId, existing.number)}>
                      {t("pullRequest.create.existing.open", { number: existing.number })}
                    </Button>
                  }
                >
                  {t("pullRequest.create.existing.text", { title: existing.title })}
                </StepRow>
              ) : openPrs.isError ? (
                <StepRow
                  state="todo"
                  title={t("pullRequest.create.checkFailed")}
                  action={
                    <Button size="sm" onClick={() => void openPrs.refetch()}>
                      {t("pullRequest.create.checkAgain")}
                    </Button>
                  }
                >
                  {describeHostError(openPrs.error).text}
                </StepRow>
              ) : null}
              {pushJob ? (
                <StepRow state="running" title={t("pullRequest.create.pushing", { branch: sourceName })}>
                  <PushProgress jobId={pushJob} />
                </StepRow>
              ) : pushed.state === "pushed" ? (
                <StepRow state="done" title={t("pullRequest.create.pushed.title")}>
                  <Trans i18nKey="pullRequest.create.pushed.text" values={{ upstream: pushed.upstream, branch: sourceName }} components={{ code: <span className="font-mono text-code" /> }} />
                </StepRow>
              ) : pushed.state === "unknown" ? (
                <StepRow state="todo" title={t("pullRequest.create.pushUnknown")} />
              ) : (
                <StepRow
                  state="todo"
                  title={t("pullRequest.create.pushFirst")}
                  action={
                    <Button size="sm" loading={pushing} icon={<CloudUpload className="size-3.5" aria-hidden />} onClick={() => void runPush()}>
                      {t("pullRequest.create.pushNow")}
                    </Button>
                  }
                >
                  {pushed.state === "no_upstream"
                    ? t("pullRequest.create.noUpstream", { branch: sourceName })
                    : t("pullRequest.create.behind", { count: pushed.count, upstream: pushed.upstream })}{" "}
                  {t("pullRequest.create.pushAndCreateHint")}
                </StepRow>
              )}
              {ahead === 0 && !needsPush && !sameBranch ? (
                <StepRow state="problem" title={t("pullRequest.create.nothing")}>
                  {t("pullRequest.create.blocked.nothing", { source: sourceName, target: targetName })}
                </StepRow>
              ) : null}
            </ul>

            <TextField
              name="title"
              label={t("pullRequest.create.titleLabel")}
              value={title}
              autoComplete="off"
              maxLength={TITLE_LIMIT}
              hint={[...title].length >= TITLE_LIMIT - 40 ? `${t("pullRequest.create.titleLength", { count: [...title].length, max: TITLE_LIMIT })}${title.length >= TITLE_LIMIT ? t("pullRequest.create.titleCut") : ""}` : undefined}
              error={titleError ?? undefined}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleTouched(true);
                setTitleError(null);
              }}
            />

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label htmlFor="s23-body" className="flex-1 text-sm font-medium text-text-muted">
                  {t("pullRequest.create.bodyLabel")}
                </label>
                <SegmentedControl
                  label={t("pullRequest.create.bodyMode")}
                  value={mode}
                  options={[
                    { value: "write", label: t("pullRequest.create.write") },
                    { value: "preview", label: t("pullRequest.create.preview") },
                  ]}
                  onValueChange={setMode}
                />
              </div>
              {mode === "write" ? (
                <TextArea
                  id="s23-body"
                  name="body"
                  rows={10}
                  value={text}
                  className="font-mono text-code"
                  spellCheck
                  hint={template.isPending ? t("pullRequest.create.templateLoading") : fromTemplate && !textTouched ? t("pullRequest.create.fromTemplate") : t("pullRequest.create.bodyHint")}
                  onChange={(event) => {
                    setText(event.target.value);
                    setTextTouched(true);
                  }}
                />
              ) : (
                <div id="s23-body" role="region" aria-label={t("pullRequest.create.previewLabel")} tabIndex={0} data-pr-preview="" className="max-h-96 min-h-40 overflow-auto rounded-md border border-border bg-surface-sunken px-3 py-2">
                  <SafeMarkdown source={text} origin={t("pullRequest.create.previewOrigin")} empty={t("pullRequest.create.noDescription")} />
                </div>
              )}
            </div>

            {repo.capabilities.draftPrs ? <Checkbox label={t("pullRequest.create.draft")} hint={t("pullRequest.create.draftHint")} checked={draft} onCheckedChange={setDraft} /> : null}

            {repo.capabilities.prReviewers || repo.capabilities.prLabels ? (
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                {repo.capabilities.prReviewers ? (
                  <TextField
                    name="reviewers"
                    label={t("pullRequest.create.reviewers")}
                    value={reviewers}
                    autoComplete="off"
                    placeholder={t("pullRequest.create.reviewersPlaceholder")}
                    hint={t("pullRequest.create.reviewersHint")}
                    onChange={(event) => setReviewers(event.target.value)}
                  />
                ) : null}
                {repo.capabilities.prLabels ? (
                  <TextField name="labels" label={t("pullRequest.create.labels")} value={labels} autoComplete="off" placeholder={t("pullRequest.create.labelsPlaceholder")} hint={t("pullRequest.create.labelsHint")} onChange={(event) => setLabels(event.target.value)} />
                ) : null}
              </div>
            ) : null}

            {failure ? (
              <div role="alert" data-pr-error={failure.kind} className="flex items-start gap-2 rounded-md border border-border bg-danger-surface p-3">
                <CircleAlert className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text">{failure.kind === "other" ? t("pullRequest.create.failed") : failure.title}</p>
                  <p className="selectable text-sm break-words whitespace-pre-line text-text-muted">{failure.hint ? `${failure.text} ${failure.hint}` : failure.text}</p>
                </div>
                {failure.kind === "auth" || failure.kind === "not_connected" ? (
                  <Button size="sm" onClick={openIntegrations}>
                    {t("pullRequest.create.openIntegrations")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-border bg-surface px-6 py-2">
          <p data-pr-blocked={blockedReason ? "" : undefined} className="min-w-0 flex-1 text-sm text-text-muted">
            {blockedReason ?? t("pullRequest.create.footer", { word, host: hostKindLabels[kind], user: repo.account?.user?.login ?? t("pullRequest.create.yourAccount") })}
          </p>
          <Button onClick={close}>{t("pullRequest.create.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={Boolean(blockedReason)} loading={creating || Boolean(pushJob)} icon={<GitPullRequestCreate className="size-icon" aria-hidden />}>
            {needsPush ? t("pullRequest.create.pushAndCreate") : repo.capabilities.draftPrs && draft ? t("pullRequest.create.createDraft") : t("pullRequest.create.title")}
          </Button>
        </footer>
      </form>
    </Frame>
  );
}
