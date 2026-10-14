/**
 * Pull request view. View in the centre: header (title, state, author, branches, checks as text
 * and icon), below it the tabs conversation, commits and files.
 *
 * Actions: comment, merge (choose method, delete branch; locked with a reason on conflicts,
 * running or failed checks), close and reopen, check out the branch, open at the host in the
 * browser. Texts from the host are rendered sanitised (Markdown.tsx): no scripts, no images from
 * the network, links only in the browser after a prompt.
 *
 * Keys: Esc closes; in the tab bar the arrow keys switch; Ctrl+Enter sends the comment.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ban, CircleAlert, ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequestArrow, GitPullRequestClosed, KeyRound, MessageSquarePlus, Plug, RefreshCw, RotateCcw, Timer, X } from "lucide-react";
import { Tabs } from "radix-ui";
import { core, CoreError, type Id } from "../../core";
import { openInBrowser, openIntegrations } from "../../app/actions/hosts";
import { defaultCapabilities, describeHostError, hostKindLabels, type HostCapabilities, type HostErrorText, type PrComment, type PrCommit, type PrDetails } from "../../app/actions/hostTypes";
import { checkoutPr, closePr, commentOnPr, mergeBlock, prBusyKeys, refreshPullRequests, reopenPr } from "../../app/actions/pullrequests";
import { busyKeys } from "../../app/actions/keys";
import { fetchAll } from "../../app/actions/sync";
import { hasOpenDialog } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { hasOpenMenu } from "../../app/menus/host";
import { useHostRepo, usePullRequest } from "../../app/queries";
import { runAction } from "../../app/run";
import { useAppStore, useBusy } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { EmptyState, toast } from "../../ui/Feedback";
import { TextArea } from "../../ui/Field";
import { Avatar } from "../../ui/Git";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import { isPlainEscape, ownsKey } from "../FileView/parts";
import { openConnectDialog } from "../Hosts";
import { PrFiles } from "./Files";
import { SafeMarkdown } from "./Markdown";
import { openMergeDialog } from "./MergeDialog";
import { BlockTitle, BranchChip, ChecksSummary, PhaseBadge, ReviewState, When, checkInfo, reviewLabel, userName } from "./parts";

export interface PullRequestViewProps {
  repoId: Id;
  tabId: Id;
  number: number;
}

type TabId = "conversation" | "commits" | "files";

const errorIcons: Partial<Record<HostErrorText["kind"], ReactNode>> = {
  not_connected: <Plug className="size-6" aria-hidden />,
  auth: <KeyRound className="size-6" aria-hidden />,
  rate_limit: <Timer className="size-6" aria-hidden />,
  permission: <Ban className="size-6" aria-hidden />,
};

/** Full-area error state: not connected, token expired, quota, no permission, not found. */
function LoadFailure({ error, number, onRetry }: { error: unknown; number: number; onRetry: () => void }) {
  const info = describeHostError(error);
  const title = info.kind === "not_found" ? t("pullRequest.view.notFound", { number }) : info.kind === "other" ? t("pullRequest.view.loadError") : info.title;
  return (
    <div data-pr-state={`error-${info.kind}`} className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <EmptyState
        icon={errorIcons[info.kind] ?? <CircleAlert className="size-6" aria-hidden />}
        title={title}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {info.kind === "not_connected" ? (
              <Button size="sm" variant="primary" icon={<Plug className="size-3.5" aria-hidden />} onClick={() => void openConnectDialog()}>
                {t("pullRequest.view.connect")}
              </Button>
            ) : null}
            {info.kind === "auth" ? (
              <Button size="sm" variant="primary" onClick={openIntegrations}>
                {t("pullRequest.view.openIntegrations")}
              </Button>
            ) : null}
            <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
              {t("pullRequest.view.retry")}
            </Button>
          </div>
        }
      >
        {info.text} {info.hint}
      </EmptyState>
    </div>
  );
}

function Skeleton() {
  return (
    <div role="status" aria-label={t("pullRequest.view.loading")} data-pr-state="loading" className="flex animate-pulse flex-col gap-4 p-6">
      <div className="h-6 w-2/3 rounded-sm bg-surface-raised" />
      <div className="h-4 w-1/2 rounded-sm bg-surface-raised" />
      <div className="h-8 w-80 max-w-full rounded-sm bg-surface-raised" />
      <div className="h-32 w-full rounded-sm bg-surface-raised" />
      <div className="h-20 w-full rounded-sm bg-surface-raised" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function CommentCard({ comment }: { comment: PrComment }) {
  const name = userName(comment.author);
  return (
    <li data-comment={comment.id} className="rounded-md border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1.5 text-sm text-text-muted">
        <Avatar name={name} size={18} />
        <span className="selectable font-medium text-text">{name}</span>
        <When value={comment.createdAt} />
        {comment.path ? (
          <span className="selectable min-w-0 truncate font-mono text-code" title={comment.line ? t("pullRequest.view.commentOnLine", { path: comment.path, line: comment.line }) : t("pullRequest.view.commentOn", { path: comment.path })}>
            {comment.path}
            {comment.line ? `:${comment.line}` : ""}
          </span>
        ) : null}
      </header>
      <SafeMarkdown source={comment.body} origin={t("pullRequest.view.commentOrigin", { name })} empty={t("pullRequest.view.markdown.empty")} className="px-3 py-2" />
    </li>
  );
}

function CommentForm({ repoId, number }: { repoId: Id; number: number }) {
  const [text, setText] = useState("");
  const busy = useBusy(prBusyKeys.write(repoId, number));
  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    if (await commentOnPr(repoId, number, body)) setText("");
  };
  return (
    <form
      data-comment-form=""
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextArea
        label={t("pullRequest.view.commentLabel")}
        name="comment"
        rows={4}
        value={text}
        placeholder={t("pullRequest.view.commentPlaceholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" disabled={!text.trim()} loading={busy} icon={<MessageSquarePlus className="size-3.5" aria-hidden />}>
          {t("pullRequest.view.commentSubmit")}
        </Button>
      </div>
    </form>
  );
}

function Conversation({ repoId, pr }: { repoId: Id; pr: PrDetails }) {
  const author = userName(pr.author);
  return (
    <div className="@container mx-auto flex w-full max-w-200 flex-col gap-5 px-6 py-5">
      <section aria-label={t("pullRequest.view.description")} data-pr-body="" className="rounded-md border border-border bg-surface">
        <header className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm text-text-muted">
          <Avatar name={author} size={18} />
          <span className="selectable font-medium text-text">{author}</span>
          <span>{t("pullRequest.view.description")}</span>
        </header>
        <SafeMarkdown source={pr.body} origin={t("pullRequest.view.descriptionOrigin")} empty={t("pullRequest.view.noDescription")} className="px-3 py-2" />
      </section>

      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-3">
        <section aria-label={t("pullRequest.view.reviewers")} data-pr-reviewers="">
          <BlockTitle count={pr.reviewers.length || undefined}>{t("pullRequest.view.reviewers")}</BlockTitle>
          {pr.reviewers.length === 0 ? (
            <p className="text-base text-text-muted">{t("pullRequest.view.noReviewers")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {pr.reviewers.map((reviewer) => (
                <li key={reviewer.user.login} className="flex min-w-0 items-center gap-2 text-base">
                  <Avatar name={userName(reviewer.user)} size={18} />
                  <span className="selectable min-w-0 truncate" title={reviewer.user.login}>
                    {userName(reviewer.user)}
                  </span>
                  {reviewLabel(reviewer.state) ? <ReviewState state={reviewer.state} className="shrink-0 text-text-muted" /> : <span className="shrink-0 text-sm text-text-muted">{t("pullRequest.view.requested")}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={t("pullRequest.view.labels")} data-pr-labels="">
          <BlockTitle count={pr.labels.length || undefined}>{t("pullRequest.view.labels")}</BlockTitle>
          {pr.labels.length === 0 ? (
            <p className="text-base text-text-muted">{t("pullRequest.view.noLabels")}</p>
          ) : (
            <ul className="flex flex-wrap gap-1">
              {pr.labels.map((label) => (
                <li key={label} title={label} className="selectable max-w-full truncate rounded-pill border border-border bg-surface-raised px-2 text-sm text-text">
                  {label}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={t("pullRequest.view.checks")} data-pr-checks="">
          <BlockTitle count={pr.checkRuns.length || undefined}>{t("pullRequest.view.checks")}</BlockTitle>
          {pr.checkRuns.length === 0 ? (
            <ChecksSummary summary={pr.checks} />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {pr.checkRuns.map((check, index) => {
                const info = check.state === "skipped" ? null : checkInfo[check.state];
                const IconComponent = info?.icon ?? Ban;
                return (
                  <li key={`${check.name}-${index}`} data-check={check.state} className="flex min-w-0 items-center gap-1.5 text-base">
                    <IconComponent className={cn("size-3.5 shrink-0", info?.tone ?? "text-text-muted")} aria-hidden />
                    <span className="selectable min-w-0 flex-1 truncate" title={check.name}>
                      {check.name}
                    </span>
                    <span className="shrink-0 text-sm text-text-muted">{info?.label ?? t("pullRequest.view.check.skipped")}</span>
                    {check.url ? <IconButton size="xs" label={t("pullRequest.view.openCheck", { name: check.name })} icon={<ExternalLink className="size-3" aria-hidden />} onClick={() => void openInBrowser(check.url, t("pullRequest.view.page"))} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section aria-label={t("pullRequest.view.comments")} data-pr-comments="">
        <BlockTitle count={pr.comments.length || undefined}>{t("pullRequest.view.comments")}</BlockTitle>
        {pr.comments.length === 0 ? (
          <p className="text-base text-text-muted">{t("pullRequest.view.noComments")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pr.comments.map((comment) => (
              <CommentCard key={comment.id} comment={comment} />
            ))}
          </ul>
        )}
      </section>

      <CommentForm repoId={repoId} number={pr.number} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/** Shows the commit in the graph – if it is available locally; otherwise the notice with "Fetch". */
async function revealCommit(repoId: Id, tabId: Id, commit: PrCommit) {
  const found = await runAction(t("pullRequest.view.findCommit"), () => core.commitDetails({ repoId, source: { kind: "commit", sha: commit.sha } }), { quiet: ["not_found"] });
  if (found.ok) {
    const store = useAppStore.getState();
    store.revealCommit(tabId, commit.sha);
    store.closeCenter(tabId);
    return;
  }
  if (found.error instanceof CoreError && found.error.code === "not_found") {
    toast({
      tone: "info",
      title: t("pullRequest.view.commitMissing", { sha: shortSha(commit.sha) }),
      description: t("pullRequest.view.commitMissingText"),
      action: { label: t("pullRequest.view.files.fetch"), onClick: () => void fetchAll(repoId) },
    });
  }
}

function Commits({ repoId, tabId, pr }: { repoId: Id; tabId: Id; pr: PrDetails }) {
  if (pr.commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center" data-pr-commits="empty">
        <EmptyState icon={<GitCommitHorizontal className="size-6" aria-hidden />} title={t("pullRequest.view.files.noCommits")}>
          {t("pullRequest.view.noCommitsText")}
        </EmptyState>
      </div>
    );
  }
  return (
    <ul aria-label={t("pullRequest.view.commitsLabel")} data-pr-commits="" className="mx-auto w-full max-w-200 px-6 py-4">
      {pr.commits.map((commit) => (
        <li key={commit.sha} className="border-b border-border last:border-b-0">
          <button
            type="button"
            data-commit={commit.sha}
            title={t("pullRequest.view.showInGraph")}
            className="flex w-full min-w-0 items-center gap-3 rounded-sm px-2 py-1.5 text-left -outline-offset-2 hover:bg-surface-raised"
            onClick={() => void revealCommit(repoId, tabId, commit)}
          >
            <span className="shrink-0 font-mono text-code text-text-muted">{shortSha(commit.sha)}</span>
            <span className="min-w-0 flex-1 truncate text-base text-text" title={commit.summary}>
              {commit.summary || t("pullRequest.view.noMessage")}
            </span>
            <span className="hidden max-w-40 shrink-0 truncate text-sm text-text-muted @xl:inline">{commit.authorName}</span>
            <span className="shrink-0 text-sm text-text-muted">
              <When value={commit.authoredAt} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function Body({ repoId, tabId, pr, capabilities, hostName, stale }: { repoId: Id; tabId: Id; pr: PrDetails; capabilities: HostCapabilities; hostName: string; stale: HostErrorText | null }) {
  const [tab, setTab] = useState<TabId>("conversation");
  const writing = useBusy(prBusyKeys.write(repoId, pr.number));
  const checkingOut = useBusy(busyKeys.history(repoId));
  const blocked = mergeBlock(pr);
  const author = userName(pr.author);
  const open = pr.state === "open";
  const forkBlocked = pr.isFork && !capabilities.forkCheckout;
  const tabList = useRef<HTMLDivElement>(null);

  // On open, focus goes into the view (onto the active tab) – unless a dialog or menu is currently on top.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[role="dialog"], [role="alertdialog"], [role="menu"], input, textarea')) return;
      tabList.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <div data-pr-head="" className="shrink-0 border-b border-border bg-surface px-6 pt-3 pb-2">
        {/* Very long titles: at most three lines, the full text is in the tooltip – otherwise a small window would leave no room for the content. */}
        <h3 data-pr-title="" title={pr.title} className="selectable m-0 line-clamp-3 text-lg font-semibold break-words text-text">
          {pr.title || t("pullRequest.view.untitled")} <span className="font-normal text-text-muted">#{pr.number}</span>
        </h3>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-text-muted">
          <PhaseBadge pr={pr} />
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Avatar name={author} size={18} />
            <span className="selectable truncate font-medium text-text">{author}</span>
          </span>
          <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
            <BranchChip name={pr.sourceBranch} label={t("pullRequest.view.source")} />
            <span aria-hidden>→</span>
            <span className="sr-only">{t("pullRequest.view.into")}</span>
            <BranchChip name={pr.targetBranch} label={t("pullRequest.view.target")} />
          </span>
          <When value={pr.updatedAt} prefix={t("pullRequest.view.updated")} />
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          <ChecksSummary summary={pr.checks} runs={pr.checkRuns} />
          <ReviewState state={pr.reviewState} />
          {pr.isFork ? <span className="text-sm text-text-muted">{t("pullRequest.view.fromFork")}</span> : null}
        </p>

        <div role="toolbar" aria-label={t("pullRequest.view.actions")} data-pr-actions="" className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={checkingOut}
            disabled={forkBlocked}
            title={forkBlocked ? t("pullRequest.view.forkCheckoutUnsupported", { host: hostName }) : undefined}
            icon={<GitBranch className="size-3.5" aria-hidden />}
            onClick={() => void checkoutPr(repoId, pr)}
          >
            {t("pullRequest.view.files.checkout")}
          </Button>
          {open ? (
            <Button size="sm" variant="primary" disabled={Boolean(blocked) || writing} icon={<GitMerge className="size-3.5" aria-hidden />} aria-describedby={blocked ? "s24-merge-blocked" : undefined} onClick={() => void openMergeDialog(repoId, pr, capabilities)}>
              {t("pullRequest.view.mergeButton")}
            </Button>
          ) : null}
          {open ? (
            <Button size="sm" disabled={writing} icon={<GitPullRequestClosed className="size-3.5" aria-hidden />} onClick={() => void closePr(repoId, pr)}>
              {t("pullRequest.view.closeButton")}
            </Button>
          ) : pr.state === "closed" && capabilities.prReopen ? (
            <Button size="sm" loading={writing} icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => void reopenPr(repoId, pr)}>
              {t("pullRequest.view.reopen")}
            </Button>
          ) : null}
        </div>
        {open && blocked ? (
          <p id="s24-merge-blocked" data-merge-blocked="" className="mt-1.5 flex items-start gap-1.5 text-sm text-text-muted">
            <Ban className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              <span className="font-medium text-text">{t("pullRequest.view.mergeBlocked")}</span> {blocked}
            </span>
          </p>
        ) : null}
      </div>

      {stale ? (
        <div role="alert" data-pr-stale={stale.kind} className="flex shrink-0 items-start gap-2 border-b border-border bg-warning-surface px-6 py-2 text-base text-text">
          <CircleAlert className="mt-0.5 size-icon shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("pullRequest.view.stale", { title: stale.title })}</p>
            <p className="selectable text-sm break-words text-text-muted">
              {stale.text} {stale.hint}
            </p>
          </div>
          {stale.kind === "auth" || stale.kind === "not_connected" ? (
            <Button size="sm" onClick={openIntegrations}>
              {t("pullRequest.view.openIntegrations")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as TabId)} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List ref={tabList} aria-label={t("pullRequest.view.tabs")} className="flex h-control-lg shrink-0 items-end gap-1 border-b border-border bg-surface px-5">
          {(
            [
              ["conversation", t("pullRequest.view.conversation"), pr.comments.length],
              ["commits", t("pullRequest.view.commits"), pr.commits.length],
              ["files", t("pullRequest.view.filesTab"), null],
            ] as const
          ).map(([id, label, count]) => (
            <Tabs.Trigger
              key={id}
              value={id}
              className={cn(
                "inline-flex h-control-md items-center gap-1.5 border-b-2 border-transparent px-2 text-base text-text-muted -outline-offset-2",
                "hover:text-text data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-text",
              )}
            >
              {label}
              {count ? <span className="rounded-pill bg-surface-raised px-1.5 text-xs text-text-muted tabular-nums">{count}</span> : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="conversation" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <Conversation repoId={repoId} pr={pr} />
        </Tabs.Content>
        <Tabs.Content value="commits" tabIndex={-1} className="@container min-h-0 flex-1 overflow-y-auto outline-none">
          <Commits repoId={repoId} tabId={tabId} pr={pr} />
        </Tabs.Content>
        <Tabs.Content value="files" tabIndex={-1} className="min-h-0 flex-1 overflow-hidden outline-none">
          <PrFiles repoId={repoId} tabId={tabId} pr={pr} />
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}

/** Pull Request. */
export function PullRequestView({ repoId, tabId, number }: PullRequestViewProps) {
  const closeCenter = useAppStore((state) => state.closeCenter);
  const query = usePullRequest(repoId, number);
  const hostRepo = useHostRepo(repoId);
  const root = useRef<HTMLElement>(null);
  const pr = query.data ?? null;

  // Esc closes – except in text fields, menus and dialogs; the embedded diff does not pass Esc on.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlainEscape(event)) return;
      if (!ownsKey(event, hasOpenDialog() || hasOpenMenu() || Boolean(useAppStore.getState().overlay))) return;
      event.preventDefault();
      closeCenter(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabId, closeCenter]);

  const refresh = () => {
    refreshPullRequests(repoId, number);
    void query.refetch();
  };

  let content: ReactNode;
  const hostKind = hostRepo.data?.kind ?? "github";
  if (pr) content = <Body key={number} repoId={repoId} tabId={tabId} pr={pr} capabilities={hostRepo.data?.capabilities ?? defaultCapabilities[hostKind]} hostName={hostKindLabels[hostKind]} stale={query.isError ? describeHostError(query.error) : null} />;
  else if (query.isError) content = <LoadFailure error={query.error} number={number} onRetry={() => void query.refetch()} />;
  else content = <Skeleton />;

  const repo = hostRepo.data ?? null;
  return (
    <section ref={root} aria-label={t("pullRequest.view.heading", { number })} data-screen="pr-view" data-pr-number={number} className="@container flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <GitPullRequestArrow className="size-icon shrink-0 text-text-muted" aria-hidden />
        <h2 className="m-0 shrink-0 text-base font-medium text-text">{t("pullRequest.view.heading", { number })}</h2>
        {repo ? (
          <span className="selectable min-w-0 truncate font-mono text-code text-text-muted" title={`${repo.owner}/${repo.name}`}>
            {repo.owner}/{repo.name}
          </span>
        ) : null}
        <span className="flex-1" />
        {/* In a narrow centre only the icons remain; the name is then there for screen readers and in the tooltip. */}
        <Button size="sm" variant="ghost" title={t("pullRequest.view.refresh")} loading={query.isFetching && Boolean(pr)} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={refresh}>
          <span className="sr-only @2xl:not-sr-only">{t("pullRequest.view.refresh")}</span>
        </Button>
        <Button size="sm" variant="ghost" title={t("pullRequest.view.openInBrowser")} disabled={!pr?.webUrl} icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => void openInBrowser(pr?.webUrl, t("pullRequest.view.page"))}>
          <span className="sr-only @2xl:not-sr-only">{t("pullRequest.view.openInBrowser")}</span>
        </Button>
        <IconButton size="sm" label={t("pullRequest.view.close")} shortcut="Escape" data-back="" icon={<X className="size-icon" aria-hidden />} onClick={() => closeCenter(tabId)} />
      </header>
      {content}
    </section>
  );
}
