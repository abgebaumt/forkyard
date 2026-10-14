/**
 * "Issues" section in the left panel: the host's open issues at a glance. Enter opens the issue
 * in the centre; the context menu creates a branch for it or opens it in the browser.
 * Search, filters and closed issues are in the view ("Show all issues").
 *
 * Without a detected host (no remote at GitHub or GitLab) the section does not exist.
 */
import { useEffect, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { CircleDot, Copy, ExternalLink, GitBranchPlus, Link2, ListFilter, Plug, RefreshCw, SquareArrowOutUpRight } from "lucide-react";
import type { Id } from "../../core";
import { copyText } from "../../app/actions/clipboard";
import { openInBrowser, openIntegrations } from "../../app/actions/hosts";
import { describeHostError, hostKindLabels } from "../../app/actions/hostTypes";
import { useHostRepo, useIssues } from "../../app/queries";
import { useTabView } from "../../app/store";
import { Marked, MENU_SEPARATOR, menuItem, SideEmpty, SideSection, SideSkeleton, type SideRowState } from "../../components/SideSection";
import { Button, IconButton } from "../../ui/Button";
import { TreeRow } from "../../ui/Git";
import type { MenuEntry } from "../../ui/Menu";
import { t } from "../../i18n";
import type { IssueSummary } from "./api";
import { copyIssueLink, createIssueBranch, issuesWebUrl, openIssueInBrowser, openIssues, refreshIssues, SECTION_FILTER, setIssueSection, useIssueSection } from "./actions";
import { describeIssue, issueBranchName, issueSecondary, localizeTimes, matchesIssue } from "./model";

export interface IssuesSectionProps {
  repoId: Id;
  tabId: Id;
  /** Text of the panel's filter bar. */
  query: string;
}

function issueMenu(repoId: Id, tabId: Id, issue: IssueSummary): MenuEntry[] {
  return [
    menuItem(t("issues.section.open"), SquareArrowOutUpRight, () => openIssues(tabId, issue.number), { shortcut: "Enter" }),
    menuItem(t("issues.branch.label"), GitBranchPlus, () => void createIssueBranch(repoId, tabId, issue), { hint: issueBranchName(issue) }),
    MENU_SEPARATOR,
    menuItem(t("issues.details.openInBrowser"), ExternalLink, () => void openIssueInBrowser(issue), { blocked: issue.webUrl ? null : t("issues.section.noAddress") }),
    menuItem(t("issues.details.copyLink"), Link2, () => void copyIssueLink(issue), { blocked: issue.webUrl ? null : t("issues.section.noAddress") }),
    menuItem(t("issues.section.copyNumber"), Copy, () => void copyText(issue.key, t("issues.section.numberWhat"))),
  ];
}

function IssueRow({ issue, state, query, open }: { issue: IssueSummary; state: SideRowState; query: string; open: boolean }) {
  const secondary = issueSecondary(issue);
  return (
    <TreeRow
      {...state.attrs}
      label={issue.title}
      labelContent={<Marked text={issue.title || t("issues.untitled")} query={query} />}
      tip={
        <span className="flex max-w-80 flex-col gap-0.5">
          <span className="break-words">
            {issue.key} {issue.title}
          </span>
          {secondary ? <span className="text-text-muted">{secondary}</span> : null}
          {issue.assignees.length ? <span className="text-text-muted">{t("issues.section.assigned", { users: issue.assignees.map((user) => user.login).join(", ") })}</span> : null}
          {issue.labels.length ? <span className="text-text-muted">{t("issues.describe.labels", { labels: issue.labels.join(", ") })}</span> : null}
        </span>
      }
      icon={<CircleDot className="size-3.5 text-success" aria-hidden />}
      selected={state.selected || open}
      focusable={state.focusable}
      meta={<span className="shrink-0 text-xs text-text-muted tabular-nums">{issue.key}</span>}
      aria-label={describeIssue(issue)}
      data-kind="issue"
      data-issue={issue.number}
      className="scroll-mt-control-md"
    />
  );
}

/** "Issues" section – sits below the other sections of the left panel. */
export function IssuesSection({ repoId, tabId, query }: IssuesSectionProps) {
  const hostRepo = useHostRepo(repoId);
  const section = useIssueSection(repoId);
  const view = useTabView(tabId);
  const repo = hostRepo.data ?? null;
  const connected = Boolean(repo?.account);
  const filtering = query.trim().length > 0;
  const open = filtering ? true : !section.collapsed;
  // Load only once the section actually shows something.
  const issues = useIssues(repoId, SECTION_FILTER, connected && !section.hidden && open);

  // The host does not report changes: when coming back to the window the list counts as stale.
  useEffect(() => {
    if (!connected || section.hidden) return;
    const onFocus = () => {
      if (issues.isStale) void issues.refetch();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [connected, section.hidden, issues]);

  // No host detected (or the integration is missing entirely, or the repository has no tracker): no section.
  if (section.hidden || hostRepo.isPending || !repo || !repo.capabilities.issues) return null;
  const problem = hostRepo.isError ? describeHostError(hostRepo.error) : null;
  if (problem && (problem.kind === "not_built" || problem.kind === "unsupported")) return null;

  const all = issues.data?.pages.flatMap((page) => page.items) ?? [];
  const items = filtering ? all.filter((issue) => matchesIssue(issue, query)) : all;
  // While filtering only what has a match stays.
  if (filtering && items.length === 0) return null;

  const toggle = () => {
    if (!filtering) setIssueSection(repoId, { collapsed: !section.collapsed });
  };
  const showAll = () => openIssues(tabId, null);
  const webUrl = issuesWebUrl(repo);
  const host = repo.kind ? hostKindLabels[repo.kind] : t("issues.section.fallbackHost");
  const openNumber = view.center.kind === "issues" ? view.center.number : null;

  let placeholder: ReactNode = undefined;
  if (!connected) {
    placeholder = (
      <SideEmpty
        action={
          <Button size="sm" variant="ghost" icon={<Plug className="size-3.5" aria-hidden />} onClick={openIntegrations}>
            {t("issues.section.connect")}
          </Button>
        }
      >
        {t("issues.notConnected.title", { host })}
      </SideEmpty>
    );
  } else if (issues.isPending) placeholder = <SideSkeleton rows={2} />;
  else if (issues.isError && all.length === 0) {
    const info = describeHostError(issues.error);
    placeholder = (
      <div role={info.kind === "rate_limit" ? "status" : "alert"} data-load-error data-issues-state={info.kind} className="flex flex-col items-start gap-1.5 px-2 py-2 text-sm">
        <p className="font-medium text-text">{info.kind === "other" ? t("issues.section.loadError") : info.title}</p>
        <p className="selectable break-words text-text-muted">{localizeTimes(info.text)}</p>
        <span className="flex flex-wrap gap-1.5">
          {info.kind === "auth" || info.kind === "not_connected" ? (
            <Button size="sm" onClick={openIntegrations}>
              {t("issues.problem.openIntegrations")}
            </Button>
          ) : null}
          <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void issues.refetch()}>
            {t("issues.problem.retry")}
          </Button>
        </span>
      </div>
    );
  } else if (all.length === 0) placeholder = <SideEmpty>{t("issues.section.noOpen")}</SideEmpty>;

  const sectionMenu: MenuEntry[] = [
    menuItem(open ? t("issues.section.collapse") : t("issues.section.expand"), null, toggle, { blocked: filtering ? t("issues.section.alwaysOpen") : null }),
    menuItem(t("issues.section.hide"), null, () => setIssueSection(repoId, { hidden: true }), { hint: t("issues.section.hideHint") }),
    MENU_SEPARATOR,
    menuItem(t("issues.section.showAll"), ListFilter, showAll, { hint: t("issues.section.showAllHint") }),
    menuItem(t("issues.section.reload"), RefreshCw, () => void refreshIssues(repoId), { blocked: connected ? null : t("issues.section.notConnected") }),
    menuItem(t("issues.view.openInBrowser"), ExternalLink, () => void openInBrowser(webUrl), { blocked: webUrl ? null : t("issues.section.noAddress") }),
  ];

  const more = issues.hasNextPage;
  return (
    <SideSection
      id="issues"
      title={t("issues.view.title")}
      icon={<CircleDot aria-hidden />}
      count={!connected || issues.isPending || (issues.isError && all.length === 0) ? undefined : filtering ? `${items.length}/${all.length}${more ? "+" : ""}` : `${all.length}${more ? "+" : ""}`}
      open={open}
      onToggle={toggle}
      listLabel={t("issues.section.listLabel")}
      items={items}
      itemId={(issue) => `issue-${issue.number}`}
      itemText={(issue) => issue.title}
      renderRow={(issue, rowState) => <IssueRow key={issue.number} issue={issue} state={rowState} query={query} open={issue.number === openNumber} />}
      onActivate={(issue) => openIssues(tabId, issue.number)}
      rowMenu={(issue) => issueMenu(repoId, tabId, issue)}
      sectionMenu={sectionMenu}
      placeholder={placeholder}
      notice={
        issues.isError && all.length > 0 && !placeholder ? (
          <p role="status" className="px-2 pt-1 text-xs text-warning" data-issues-stale title={localizeTimes(describeHostError(issues.error).text)}>
            {t("issues.section.stale", { reason: describeHostError(issues.error).title })}
          </p>
        ) : more && !placeholder && !filtering ? (
          <p className="px-2 pt-1 text-xs text-text-muted" data-issues-more>
            <Trans i18nKey="issues.section.firstN" values={{ count: all.length }} components={{ view: <button type="button" className="rounded-sm text-accent hover:underline" onClick={showAll} /> }} />
          </p>
        ) : undefined
      }
      actions={<IconButton size="sm" data-action="issues-all" label={t("issues.section.showAll")} icon={<ListFilter className="size-3.5" aria-hidden />} onClick={showAll} />}
    />
  );
}
