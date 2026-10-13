/**
 * Commands around the host's issues: open the view, reload, open in the browser,
 * create a branch for the open issue.
 */
import { t } from "../../i18n";
import type { InfiniteData } from "@tanstack/react-query";
import { openInBrowser } from "../actions/hosts";
import type { HostRepo } from "../actions/hostTypes";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { qk } from "../queries";
import { createIssueBranch, issuesWebUrl, openIssues, refreshIssues } from "../../screens/Issues/actions";
import type { IssueDetails, IssuePage, IssueSummary } from "../../screens/Issues/api";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const hostRepo = (ctx: CommandContext) => (ctx.repoId ? (ctx.queryClient.getQueryData<HostRepo | null>(qk.hostRepo(ctx.repoId)) ?? null) : null);
/** As long as the host is not determined, "maybe" applies; the view then explains what is missing. */
const mayHaveIssues = (ctx: CommandContext) => hasRepo(ctx) && ctx.queryClient.getQueryData(qk.hostRepo(ctx.repoId!)) !== null;
const noHostReason = (ctx: CommandContext) => (hasRepo(ctx) ? t("commands.issues.noHost") : null);
const connected = (ctx: CommandContext) => Boolean(hostRepo(ctx)?.account);

/** The issue currently open in the centre – from the cache of the detail view or of the lists. */
function openIssue(ctx: CommandContext): IssueSummary | null {
  const center = ctx.view?.center;
  if (!ctx.repoId || center?.kind !== "issues" || center.number === null) return null;
  const details = ctx.queryClient.getQueryData<IssueDetails>(qk.issue(ctx.repoId, center.number));
  if (details) return details;
  for (const [, data] of ctx.queryClient.getQueriesData<InfiniteData<IssuePage>>({ queryKey: qk.issueLists(ctx.repoId) })) {
    const found = data?.pages.flatMap((page) => page.items).find((issue) => issue.number === center.number);
    if (found) return found;
  }
  return null;
}

export const commands: AppCommand[] = [
  {
    id: "issues.show",
    title: t("commands.issues.show.title"),
    group: "Repository",
    keywords: kw("commands.issues.show.keywords"),
    when: mayHaveIssues,
    disabledReason: noHostReason,
    run: (ctx) => openIssues(ctx.tabId!, ctx.view?.center.kind === "issues" ? ctx.view.center.number : null),
  },
  {
    id: "issues.refresh",
    title: t("commands.issues.refresh.title"),
    group: "Repository",
    keywords: kw("commands.issues.refresh.keywords"),
    when: (ctx) => hasRepo(ctx) && connected(ctx),
    disabledReason: (ctx) => (hasRepo(ctx) ? t("commands.issues.noAccount") : null),
    run: (ctx) => refreshIssues(ctx.repoId!),
  },
  {
    id: "issues.web",
    title: t("commands.issues.web.title"),
    group: "Repository",
    keywords: kw("commands.issues.web.keywords"),
    when: (ctx) => hasRepo(ctx) && issuesWebUrl(hostRepo(ctx)) !== null,
    disabledReason: noHostReason,
    run: (ctx) => openInBrowser(issuesWebUrl(hostRepo(ctx))),
  },
  {
    id: "issues.branch",
    title: t("commands.issues.branch.title"),
    group: "Branch",
    keywords: kw("commands.issues.branch.keywords"),
    when: (ctx) => hasRepo(ctx) && openIssue(ctx) !== null,
    disabledReason: (ctx) => (hasRepo(ctx) ? t("commands.issues.branch.noIssue") : null),
    run: (ctx) => {
      const issue = openIssue(ctx);
      return issue ? createIssueBranch(ctx.repoId!, ctx.tabId, issue) : undefined;
    },
  },
];
