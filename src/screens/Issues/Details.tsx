/**
 * Single view of an issue: title, state, people, labels, description and comments.
 * Text from the host is Markdown from a third party – it is only shown sanitised (no scripts,
 * no images from the network, links open in the browser only after a prompt).
 */
import { ArrowLeft, ExternalLink, GitBranchPlus, Link2, MessageSquare, RefreshCw } from "lucide-react";
import type { Id } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { formatDateTime, formatRelative } from "../../app/format";
import { useIssue } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { Tip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { SafeMarkdown } from "../PullRequestView/Markdown";
import type { IssueSummary } from "./api";
import { copyIssueLink, createIssueBranch, openIssueInBrowser } from "./actions";
import { HostProblem, Labels, Person, StateBadge } from "./parts";

function When({ value, prefix }: { value: string | null; prefix: string }) {
  if (!value) return null;
  return (
    <span title={formatDateTime(value)} className="whitespace-nowrap">
      {prefix} {formatRelative(value)}
    </span>
  );
}

function BodySkeleton() {
  return (
    <div role="status" aria-label={t("issues.details.loading")} data-loading="" className="flex animate-pulse flex-col gap-2 py-2">
      <div className="h-3 w-11/12 rounded-sm bg-surface-raised" />
      <div className="h-3 w-4/5 rounded-sm bg-surface-raised" />
      <div className="h-3 w-2/3 rounded-sm bg-surface-raised" />
      <div className="mt-3 h-3 w-3/4 rounded-sm bg-surface-raised" />
      <div className="h-3 w-1/2 rounded-sm bg-surface-raised" />
    </div>
  );
}

export interface IssueDetailsProps {
  repoId: Id;
  tabId: Id;
  number: number;
  /** What the list already knows about the issue – shown immediately while the details load. */
  known?: IssueSummary;
  /** Narrow view: button back to the list. */
  onBack?: () => void;
}

export function IssueDetailsPane({ repoId, tabId, number, known, onBack }: IssueDetailsProps) {
  const query = useIssue(repoId, number);
  const branchBusy = useBusy(busyKeys.branch(repoId));
  const issue = query.data ?? known;
  const details = query.data;

  return (
    <article aria-label={issue ? `Issue ${issue.key}` : `Issue #${number}`} data-issue={number} data-state={query.isPending ? "loading" : query.isError ? "error" : "filled"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border bg-surface px-4 py-3">
        <div className="flex items-start gap-2">
          {onBack ? <IconButton size="sm" label={t("issues.details.back")} data-issue-back="" icon={<ArrowLeft className="size-icon" aria-hidden />} onClick={onBack} /> : null}
          <h3 className="selectable m-0 min-w-0 flex-1 text-lg font-semibold break-words text-text" data-issue-title>
            {issue ? issue.title || t("issues.untitled") : `Issue #${number}`} <span className="font-normal text-text-muted tabular-nums">{issue?.key ?? `#${number}`}</span>
          </h3>
        </div>
        {issue ? (
          <>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
              <StateBadge state={issue.state} />
              {issue.author ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {t("issues.details.by")} <Person user={issue.author} />
                </span>
              ) : null}
              <When value={details?.createdAt ?? null} prefix={t("issues.details.created")} />
              <When value={issue.updatedAt} prefix={t("issues.details.changed")} />
              {issue.commentCount ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <MessageSquare className="size-3.5" aria-hidden />
                  {t("issues.comments", { count: issue.commentCount })}
                </span>
              ) : null}
            </p>
            {issue.assignees.length || issue.labels.length ? (
              <dl className="mt-2 flex flex-col gap-1 text-sm">
                {issue.assignees.length ? (
                  <div className="flex items-start gap-2" data-issue-assignees>
                    <dt className="w-24 shrink-0 text-text-muted">{t("issues.details.assigned")}</dt>
                    <dd className="m-0 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-text">
                      {issue.assignees.map((user) => (
                        <Person key={user.login} user={user} />
                      ))}
                    </dd>
                  </div>
                ) : null}
                {issue.labels.length ? (
                  <div className="flex items-start gap-2">
                    <dt className="w-24 shrink-0 text-text-muted">{t("issues.details.labels")}</dt>
                    <dd className="m-0 min-w-0">
                      <Labels labels={issue.labels} />
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tip label={t("issues.branch.tip")}>
                <Button variant="primary" size="sm" loading={branchBusy} icon={<GitBranchPlus className="size-3.5" aria-hidden />} aria-label={t("issues.branch.label")} data-action="issue-branch" onClick={() => void createIssueBranch(repoId, tabId, issue)}>
                  {t("issues.branch.button")}
                </Button>
              </Tip>
              <Button size="sm" icon={<ExternalLink className="size-3.5" aria-hidden />} data-action="issue-web" disabled={!issue.webUrl} onClick={() => void openIssueInBrowser(issue)}>
                {t("issues.details.openInBrowser")}
              </Button>
              <IconButton size="sm" label={t("issues.details.copyLink")} disabled={!issue.webUrl} icon={<Link2 className="size-icon" aria-hidden />} onClick={() => void copyIssueLink(issue)} />
              <IconButton
                size="sm"
                label={t("issues.details.reload")}
                icon={<RefreshCw className={query.isFetching ? "size-icon animate-spin" : "size-icon"} aria-hidden />}
                onClick={() => void query.refetch()}
              />
            </div>
          </>
        ) : null}
      </header>

      {query.isError && !details ? (
        <HostProblem error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : (
        // Reachable via Tab: then arrow and page keys scroll the text, even without a mouse.
        <div role="region" aria-label={t("issues.details.region")} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 -outline-offset-2" data-issue-scroll tabIndex={0}>
          {details ? (
            <>
              <section aria-label={t("issues.details.description")} data-issue-body>
                <SafeMarkdown source={details.body} origin={t("issues.details.descriptionOrigin")} empty={t("issues.details.noDescription")} />
              </section>
              <section aria-label={t("issues.details.comments")} className="mt-5" data-issue-comments>
                <h4 className="m-0 mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
                  {details.comments.length ? t("issues.details.commentsCount", { count: details.comments.length }) : t("issues.details.comments")}
                </h4>
                {details.comments.length === 0 ? (
                  <p className="text-sm text-text-muted">{t("issues.details.noComments")}</p>
                ) : (
                  <ol className="m-0 flex list-none flex-col gap-3 p-0">
                    {details.comments.map((comment) => (
                      <li key={comment.id} data-comment={comment.id} className="rounded-md border border-border bg-surface">
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-sm text-text-muted">
                          {comment.author ? <Person user={comment.author} /> : <span>{t("issues.details.unknown")}</span>}
                          <When value={comment.createdAt} prefix="" />
                        </p>
                        <div className="px-3 py-2">
                          <SafeMarkdown source={comment.body} origin={t("issues.details.commentOrigin")} empty={t("issues.details.emptyComment")} />
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                {details.commentCount !== null && details.commentCount > details.comments.length ? (
                  <p className="mt-2 text-sm text-text-muted" data-comments-more>
                    {t("issues.details.moreComments", { count: details.commentCount - details.comments.length })}
                  </p>
                ) : null}
              </section>
            </>
          ) : (
            <BodySkeleton />
          )}
        </div>
      )}
    </article>
  );
}
