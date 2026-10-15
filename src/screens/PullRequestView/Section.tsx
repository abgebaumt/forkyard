/**
 * "Pull Requests" section in the left panel: the repository's open pull requests at the host,
 * switchable between "Mine", "To review" and "All", each with a counter. The panel's filter
 * matches number, title, author and branches. A click (or Enter) opens the view.
 *
 * The section only appears if the remote belongs to GitHub or GitLab. Without a connected account
 * it shows a row with "Connect".
 */
import { useEffect, useState, type ReactNode } from "react";
import { Copy, ExternalLink, GitBranch, GitPullRequestArrow, GitPullRequestCreate, Plug, Plus, RefreshCw, Settings2 } from "lucide-react";
import type { Id } from "../../core";
import { copyText } from "../../app/actions/clipboard";
import { openInBrowser, openIntegrations } from "../../app/actions/hosts";
import { describeHostError, hostKindLabels, type PrSummary } from "../../app/actions/hostTypes";
import { checkoutPr, openPr, openPrCreate, refreshPullRequests } from "../../app/actions/pullrequests";
import { qk, queryClient, useHostRepo, usePullRequests } from "../../app/queries";
import { useTabView } from "../../app/store";
import { Marked, MENU_SEPARATOR, menuItem, SideEmpty, SideSection, SideSkeleton, type SideRowState } from "../../components/SideSection";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { TreeRow } from "../../ui/Git";
import type { MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { openConnectDialog } from "../Hosts";
import { t } from "../../i18n";
import { checkInfo, checksText, phaseInfo, prPhase, reviewLabel, userName } from "./parts";
import { groupLabels, groupPrs, matchesPr, PR_GROUPS, type PrGroup } from "./sectionModel";

export interface PullRequestsSectionProps {
  repoId: Id;
  tabId: Id;
  /** Text of the panel's filter bar. */
  query: string;
}

const GROUP_KEY = "gc.prGroup";
const COLLAPSED_KEY = "gc.prSectionCollapsed";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // then only applies until restart
  }
}

function prMenu(repoId: Id, tabId: Id, pr: PrSummary): MenuEntry[] {
  return [
    menuItem(t("pullRequest.view.section.open"), GitPullRequestArrow, () => openPr(tabId, pr.number), { shortcut: "Enter" }),
    menuItem(t("pullRequest.view.openInBrowser"), ExternalLink, () => void openInBrowser(pr.webUrl, t("pullRequest.view.page")), { blocked: pr.webUrl ? null : t("pullRequest.view.section.noAddress") }),
    MENU_SEPARATOR,
    menuItem(t("pullRequest.view.files.checkout"), GitBranch, () => void checkoutPr(repoId, pr), { hint: pr.sourceBranch.length > 28 ? undefined : pr.sourceBranch }),
    MENU_SEPARATOR,
    menuItem(t("pullRequest.view.section.copyNumber"), Copy, () => void copyText(`#${pr.number}`, t("pullRequest.view.section.numberWhat"))),
    menuItem(t("pullRequest.view.section.copyAddress"), Copy, () => void copyText(pr.webUrl ?? "", t("pullRequest.view.section.addressWhat")), { blocked: pr.webUrl ? null : t("pullRequest.view.section.noAddress") }),
  ];
}

function PrRow({ pr, state, query, current, tabId }: { pr: PrSummary; state: SideRowState; query: string; current: boolean; tabId: Id }) {
  const phase = prPhase(pr);
  const info = phaseInfo[phase];
  const Icon = info.icon;
  const author = userName(pr.author);
  const label = `#${pr.number} ${pr.title}`;
  const check = pr.checks ? checkInfo[pr.checks] : null;
  const CheckIcon = check?.icon;
  const review = reviewLabel(pr.reviewState);
  const describe = [t("pullRequest.view.section.describe", { number: pr.number, title: pr.title }), info.label, t("pullRequest.view.section.by", { author }), t("pullRequest.view.section.branches", { source: pr.sourceBranch, target: pr.targetBranch }), checksText(pr.checks), review].filter(Boolean).join(", ");
  return (
    <TreeRow
      {...state.attrs}
      label={label}
      labelContent={
        <>
          <span className="text-text-muted tabular-nums">#{pr.number}</span> <Marked text={pr.title || t("pullRequest.view.untitled")} query={query} />
        </>
      }
      tip={
        <span className="flex max-w-80 flex-col gap-0.5">
          <span className="break-words">{label}</span>
          <span className="text-text-muted">
            {info.label} · {author}
          </span>
          <span className="break-all text-text-muted">
            {pr.sourceBranch} → {pr.targetBranch}
          </span>
          <span className="text-text-muted">{[checksText(pr.checks), review].filter(Boolean).join(" · ")}</span>
        </span>
      }
      secondary={
        <>
          <Marked text={author} query={query} /> · <Marked text={pr.sourceBranch} query={query} />
        </>
      }
      icon={<Icon className={cn("size-3.5", info.tone)} aria-hidden />}
      selected={state.selected || current}
      focusable={state.focusable}
      meta={
        CheckIcon && check ? (
          <Tip label={checksText(pr.checks)} side="right">
            <span className="inline-flex shrink-0 items-center" data-pr-checks={pr.checks ?? undefined}>
              <CheckIcon className={cn("size-3.5", check.tone)} aria-hidden />
            </span>
          </Tip>
        ) : undefined
      }
      aria-label={describe}
      aria-current={current ? "true" : undefined}
      data-kind="pull-request"
      data-pr={pr.number}
      data-pr-phase={phase}
      className="scroll-mt-control-md cursor-default"
      onClick={(event) => {
        // A single click opens – except with a modifier key (that belongs to selection) or on a button in the row.
        if (event.ctrlKey || event.metaKey || event.shiftKey || (event.target as HTMLElement).closest("button")) return;
        openPr(tabId, pr.number);
      }}
    />
  );
}

/** "Mine / To review / All" switch with counters. Arrow keys switch, like a radio group. */
function GroupSwitch({ value, counts, onChange }: { value: PrGroup; counts: Record<PrGroup, number>; onChange: (next: PrGroup) => void }) {
  return (
    <div role="radiogroup" aria-label={t("pullRequest.view.section.groupsLabel")} data-pr-groups="" className="flex flex-wrap gap-1 px-2 pb-1">
      {PR_GROUPS.map((group, index) => {
        const active = group === value;
        return (
          <button
            key={group}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-group={group}
            title={groupLabels[group].hint}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-pill border px-2 text-xs whitespace-nowrap",
              active ? "border-accent bg-accent-surface font-medium text-text" : "border-border text-text-muted hover:border-border-input hover:text-text",
            )}
            onClick={() => onChange(group)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              event.stopPropagation();
              const next = PR_GROUPS[(index + step + PR_GROUPS.length) % PR_GROUPS.length]!;
              onChange(next);
              const parent = event.currentTarget.parentElement;
              requestAnimationFrame(() => parent?.querySelector<HTMLElement>(`[data-group="${next}"]`)?.focus());
            }}
          >
            {groupLabels[group].label}
            <span className="tabular-nums">{counts[group]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** "Pull Requests" section – sits below the ref sections of the left panel. */
export function PullRequestsSection({ repoId, tabId, query }: PullRequestsSectionProps) {
  const hostRepo = useHostRepo(repoId);
  const repo = hostRepo.data ?? null;
  const connected = Boolean(repo?.account) && !repo?.error;
  const prs = usePullRequests(repoId, "open", connected);
  const center = useTabView(tabId).center;
  const [group, setGroup] = useState<PrGroup>(() => {
    const value = stored(GROUP_KEY);
    return PR_GROUPS.includes(value as PrGroup) ? (value as PrGroup) : "all";
  });
  const [collapsed, setCollapsed] = useState(() => stored(COLLAPSED_KEY) !== "0");

  // What is at the host changes without the app doing anything: refetch when coming back to the window, at most once per minute.
  useEffect(() => {
    if (!connected) return;
    const onFocus = () => {
      const updated = queryClient.getQueryState(qk.prList(repoId, "open"))?.dataUpdatedAt ?? 0;
      if (Date.now() - updated > 60_000) void queryClient.invalidateQueries({ queryKey: qk.prList(repoId, "open") });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repoId, connected]);

  // Without a detected host (local repository, other provider) the section does not exist.
  if (!repo?.kind) return null;

  const hostName = hostKindLabels[repo.kind];
  const all = prs.data?.pages.flatMap((page) => page.items) ?? [];
  const me = repo.account?.user?.login ?? null;
  const groups = groupPrs(all, me);
  const filtering = query.trim().length > 0;
  const inGroup = groups[group];
  const items = filtering ? inGroup.filter((pr) => matchesPr(pr, query)) : inGroup;
  // While filtering only what has a match stays.
  if (filtering && (!connected || items.length === 0)) return null;

  const open = filtering ? true : !collapsed;
  const toggle = () => {
    if (filtering) return;
    setCollapsed(!collapsed);
    store(COLLAPSED_KEY, collapsed ? "0" : "1");
  };
  const changeGroup = (next: PrGroup) => {
    setGroup(next);
    store(GROUP_KEY, next);
  };
  const refresh = () => {
    void hostRepo.refetch();
    refreshPullRequests(repoId);
  };
  const create = () => openPrCreate(repoId, tabId);

  let placeholder: ReactNode = undefined;
  let notice: ReactNode = undefined;
  if (!repo.account) {
    placeholder = (
      <SideEmpty
        action={
          <Button size="sm" variant="ghost" icon={<Plug className="size-3.5" aria-hidden />} onClick={() => void openConnectDialog({ kind: repo.kind ?? undefined })}>
            {t("pullRequest.view.section.connect")}
          </Button>
        }
      >
        <span data-pr-section="not-connected" title={t("pullRequest.view.section.noAccount", { host: hostName })}>
          {t("pullRequest.view.section.notConnected", { host: hostName })}
        </span>
      </SideEmpty>
    );
  } else if (repo.error || (prs.isError && !prs.data)) {
    const info = describeHostError(repo.error ?? prs.error);
    placeholder = (
      <div role="alert" data-pr-section={`error-${info.kind}`} className="flex flex-col items-start gap-1.5 px-2 py-1.5 text-sm">
        <p className="font-medium text-text">{info.title}</p>
        <p className="selectable break-words text-text-muted">{info.text}</p>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={refresh}>
            {t("pullRequest.view.retry")}
          </Button>
          {info.kind === "auth" || info.kind === "not_connected" ? (
            <Button size="sm" variant="ghost" onClick={openIntegrations}>
              {t("pullRequest.view.section.integrations")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  } else if (prs.isPending) {
    placeholder = <SideSkeleton rows={2} />;
  } else {
    notice = (
      <>
        <GroupSwitch value={group} counts={{ mine: groups.mine.length, review: groups.review.length, all: groups.all.length }} onChange={changeGroup} />
        {prs.isError ? (
          <p role="alert" data-pr-section="stale" className="px-2 pb-1 text-xs text-warning">
            {t("pullRequest.view.section.stale", { title: describeHostError(prs.error).title })}
          </p>
        ) : null}
        {items.length === 0 ? (
          <SideEmpty
            action={
              all.length === 0 ? (
                <Button size="sm" variant="ghost" onClick={create}>
                  {t("pullRequest.view.section.create")}
                </Button>
              ) : undefined
            }
          >
            {all.length === 0 ? t("pullRequest.view.groups.allEmpty") : groupLabels[group].empty}
          </SideEmpty>
        ) : null}
      </>
    );
  }

  const sectionMenu: MenuEntry[] = [
    menuItem(open ? t("pullRequest.view.section.collapse") : t("pullRequest.view.section.expand"), null, toggle, { blocked: filtering ? t("pullRequest.view.section.alwaysOpen") : null }),
    MENU_SEPARATOR,
    menuItem(t("pullRequest.view.section.createMenu"), GitPullRequestCreate, create, { blocked: connected ? null : t("pullRequest.view.section.noAccountShort") }),
    menuItem(t("pullRequest.view.refresh"), RefreshCw, refresh),
    menuItem(t("pullRequest.view.section.openAtHost"), ExternalLink, () => void openInBrowser(repo.webUrl, t("pullRequest.view.page")), { blocked: repo.webUrl ? null : t("pullRequest.view.section.noAddress") }),
    MENU_SEPARATOR,
    menuItem(t("pullRequest.view.section.integrationsMenu"), Settings2, openIntegrations),
  ];

  const more = prs.hasNextPage ? "+" : "";
  return (
    <SideSection
      id="pull-requests"
      title={t("pullRequest.view.section.title")}
      icon={<GitPullRequestArrow aria-hidden />}
      count={!connected || prs.isPending || (prs.isError && !prs.data) ? undefined : filtering ? `${items.length}/${inGroup.length}` : `${all.length}${more}`}
      open={open}
      onToggle={toggle}
      listLabel={t("pullRequest.view.section.title")}
      items={placeholder ? [] : items}
      itemId={(pr) => String(pr.number)}
      itemText={(pr) => pr.title}
      renderRow={(pr, rowState) => <PrRow key={pr.number} pr={pr} state={rowState} query={query} tabId={tabId} current={center.kind === "pr" && center.number === pr.number} />}
      onActivate={(pr) => openPr(tabId, pr.number)}
      rowMenu={(pr) => prMenu(repoId, tabId, pr)}
      sectionMenu={sectionMenu}
      notice={notice}
      footer={
        notice && prs.hasNextPage && !filtering ? (
          <div className="px-2 py-1">
            <Button size="sm" variant="ghost" loading={prs.isFetchingNextPage} onClick={() => void prs.fetchNextPage()}>
              {t("pullRequest.view.section.loadMore")}
            </Button>
          </div>
        ) : undefined
      }
      placeholder={placeholder}
      actions={
        connected ? (
          <>
            <IconButton size="sm" data-action="refresh" label={t("pullRequest.view.section.refresh")} icon={<RefreshCw className={cn("size-3.5", prs.isFetching && "animate-spin")} aria-hidden />} onClick={refresh} />
            <IconButton size="sm" data-action="add" label={t("pullRequest.view.section.createLabel")} icon={<Plus className="size-3.5" aria-hidden />} onClick={create} />
          </>
        ) : undefined
      }
    />
  );
}
