/**
 * Issues of the connected host (GitHub Issues, GitLab Issues) as a view in the centre:
 * on the left the list with search and filters, on the right the selected issue. In a narrow
 * window only one of the two is shown at a time.
 *
 * Keys: arrows in the list (Enter opens), "/" jumps to the search field, Esc goes back one step
 * (clear search → to the list → close view).
 *
 * Jira and Trello are not integrated.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CircleDot, ExternalLink, Inbox, MousePointerClick, RefreshCw, Search, SearchX, TriangleAlert, X } from "lucide-react";
import type { Id } from "../../core";
import { openInBrowser, openIntegrations } from "../../app/actions/hosts";
import { describeHostError, hostKindLabels } from "../../app/actions/hostTypes";
import { hasOpenDialog } from "../../app/dialogs";
import { hasOpenMenu } from "../../app/menus/host";
import { useHostRepo, useIssues } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { preventedByGuard } from "../../app/webviewGuards";
import { Button, IconButton } from "../../ui/Button";
import { Checkbox, SegmentedControl, TextField } from "../../ui/Field";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import type { IssueListState, IssueSummary } from "./api";
import { issuesWebUrl, openIssues, refreshIssues, useIssueFilter, useIssueFilters } from "./actions";
import { IssueDetailsPane } from "./Details";
import { describeIssue, isAssignedTo, issueSecondary, listStateLabels, localizeTimes } from "./model";
import { Blank, HostProblem, Labels, NoHost, NotConnected, StateIcon } from "./parts";

export interface IssuesViewProps {
  repoId: Id;
  tabId: Id;
  /** The opened issue; null = only the list. */
  number: number | null;
}

/** Below this view width only the list OR the issue is shown. */
const TWO_PANE_MIN = 640;
/** How long the search waits after the last keystroke before asking the host. */
const SEARCH_DELAY_MS = 300;

const STATE_OPTIONS: { value: IssueListState; label: string }[] = (["open", "closed", "all"] as const).map((value) => ({ value, label: listStateLabels[value] }));

function ListSkeleton() {
  return (
    <div role="status" aria-label={t("issues.view.loading")} data-loading="" className="animate-pulse">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex items-start gap-2 border-b border-border px-3 py-2">
          <div className="mt-0.5 size-icon shrink-0 rounded-pill bg-surface-raised" />
          <div className="min-w-0 flex-1">
            <div className={cn("h-3 rounded-sm bg-surface-raised", index % 3 === 0 ? "w-4/5" : index % 3 === 1 ? "w-3/5" : "w-11/12")} />
            <div className="mt-2 h-2.5 w-2/5 rounded-sm bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}

function IssueOption({ issue, selected, focusable, onOpen }: { issue: IssueSummary; selected: boolean; focusable: boolean; onOpen: () => void }) {
  const secondary = issueSecondary(issue);
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={describeIssue(issue)}
      tabIndex={focusable ? 0 : -1}
      data-issue-row={issue.number}
      data-state={issue.state}
      onClick={onOpen}
      className={cn("flex cursor-default items-start gap-2 border-b border-border px-3 py-2 -outline-offset-2", selected ? "bg-accent-surface" : "hover:bg-surface-raised")}
    >
      <StateIcon state={issue.state} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="m-0 flex items-baseline gap-1.5 text-base text-text">
          <span className="min-w-0 flex-1 truncate" title={issue.title}>
            {issue.title || t("issues.untitled")}
          </span>
          <span className="shrink-0 text-sm text-text-muted tabular-nums">{issue.key}</span>
        </p>
        <p className="m-0 mt-0.5 flex min-w-0 items-center gap-2 text-sm text-text-muted">
          <span className="min-w-0 shrink truncate">{secondary}</span>
          <span className="min-w-0 shrink-0">
            <Labels labels={issue.labels} max={2} />
          </span>
        </p>
      </div>
    </div>
  );
}

/** Issues. */
export function IssuesView({ repoId, tabId, number }: IssuesViewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchId = useId();
  const searchField = () => document.getElementById(searchId) as HTMLInputElement | null;
  const hostRepo = useHostRepo(repoId);
  const filter = useIssueFilter(repoId);
  const patchFilter = useIssueFilters((state) => state.patch);
  const closeCenter = useAppStore((state) => state.closeCenter);

  const repo = hostRepo.data ?? null;
  const connected = Boolean(repo?.account);
  const me = repo?.account?.user?.login ?? null;

  // The search field keeps its own text; it goes to the host only once typing pauses briefly.
  const [typed, setTyped] = useState(filter.query);
  useEffect(() => {
    if (typed === filter.query) return;
    const timer = window.setTimeout(() => patchFilter(repoId, { query: typed }), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed, filter.query, patchFilter, repoId]);

  const issues = useIssues(repoId, { state: filter.state, query: filter.query }, connected);
  const loaded = useMemo(() => issues.data?.pages.flatMap((page) => page.items) ?? [], [issues.data]);
  const shown = useMemo(() => (filter.mine ? loaded.filter((issue) => isAssignedTo(issue, me)) : loaded), [filter.mine, loaded, me]);

  // --- one or two columns -----------------------------------------------------------------------
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= TWO_PANE_MIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const showList = wide || number === null;
  const showDetails = number !== null;

  // --- List: one row is reachable via Tab, arrows move ------------------------------------------
  const [activeNumber, setActiveNumber] = useState<number | null>(number);
  const activeIndex = shown.findIndex((issue) => issue.number === activeNumber);
  const tabStop = activeIndex >= 0 ? activeNumber : (shown.find((issue) => issue.number === number)?.number ?? shown[0]?.number ?? null);
  const rowElement = (issueNumber: number) => listRef.current?.querySelector<HTMLElement>(`[data-issue-row="${issueNumber}"]`) ?? null;
  const focusRow = (issueNumber: number | undefined) => {
    if (issueNumber === undefined) return;
    setActiveNumber(issueNumber);
    const element = rowElement(issueNumber);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };
  const open = (issue: IssueSummary) => {
    setActiveNumber(issue.number);
    openIssues(tabId, issue.number);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const current = shown.findIndex((issue) => String(issue.number) === target.dataset.issueRow);
    if (current < 0) return;
    const go = (index: number) => {
      event.preventDefault();
      focusRow(shown[Math.max(0, Math.min(shown.length - 1, index))]?.number);
    };
    switch (event.key) {
      case "ArrowDown":
        return go(current + 1);
      case "ArrowUp":
        return go(current - 1);
      case "Home":
        return go(0);
      case "End":
        return go(shown.length - 1);
      case "PageDown":
        return go(current + 8);
      case "PageUp":
        return go(current - 8);
      case "Enter":
      case " ": {
        event.preventDefault();
        const issue = shown[current];
        if (issue) open(issue);
        return;
      }
    }
  };

  // Narrow view: opening an issue makes the list disappear – focus goes into the issue's text
  // (where the arrow keys scroll) instead of falling into nothing.
  useEffect(() => {
    if (wide || number === null) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !rootRef.current?.contains(active)) return;
      rootRef.current?.querySelector<HTMLElement>("[data-issue-scroll]")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [wide, number]);

  // Back to the list (narrow view): focus lands on the issue's row again.
  const backToList = () => {
    const from = number;
    openIssues(tabId, null);
    if (from !== null) requestAnimationFrame(() => rowElement(from)?.focus());
  };

  // --- Esc: one step back; "/": into the search field -----------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (hasOpenDialog() || hasOpenMenu() || useAppStore.getState().overlay) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]')) return;
      const target = event.target instanceof Element ? event.target : null;
      const inside = Boolean(target && rootRef.current?.contains(target));
      const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      // If focus is in a field outside the view (left panel filter, commit message), the key belongs there.
      if (!inside && inField) return;
      if (target?.closest('[role="menu"], [role="dialog"], [data-toast], .xterm')) return;

      if (event.key === "/" && !event.shiftKey && !inField && (inside || !target || target === document.body)) {
        const field = searchField();
        if (!field) return;
        event.preventDefault();
        field.focus();
        field.select();
        return;
      }
      if (event.key !== "Escape" || event.shiftKey) return;
      if (event.defaultPrevented && !preventedByGuard(event)) return;
      event.preventDefault();
      if (target instanceof HTMLInputElement && target === searchField() && target.value) {
        setTyped("");
        patchFilter(repoId, { query: "" });
        return;
      }
      if (!wide && number !== null) {
        backToList();
        return;
      }
      closeCenter(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide, number, tabId, repoId]);

  // --- Header -------------------------------------------------------------------------------------
  const webUrl = issuesWebUrl(repo);
  const where = repo ? `${repo.owner}/${repo.name}` : null;
  const refreshing = issues.isFetching && !issues.isFetchingNextPage && !issues.isPending;

  // --- State of the list --------------------------------------------------------------------------
  const filtering = filter.query.trim().length > 0 || filter.mine || filter.state !== "open";
  const listState = hostRepo.isPending
    ? "loading"
    : hostRepo.isError
      ? describeHostError(hostRepo.error).kind
      : !repo
        ? "no_host"
        : !repo.capabilities.issues
          ? "disabled"
          : !connected
          ? "not_connected"
          : issues.isPending
            ? "loading"
            : issues.isError && loaded.length === 0
              ? describeHostError(issues.error).kind
              : shown.length === 0
                ? "empty"
                : "filled";

  const resetFilters = () => {
    setTyped("");
    patchFilter(repoId, { query: "", mine: false, state: "open" });
  };

  let listBody;
  if (hostRepo.isPending) listBody = <ListSkeleton />;
  else if (hostRepo.isError) listBody = <HostProblem error={hostRepo.error} onRetry={() => void hostRepo.refetch()} retrying={hostRepo.isFetching} />;
  else if (!repo) listBody = <NoHost />;
  else if (!repo.capabilities.issues)
    listBody = (
      <Blank state="disabled" icon={<Inbox className="size-8" aria-hidden />} title={t("issues.view.disabledTitle")}>
        {t("issues.view.disabled", { where })}
      </Blank>
    );
  else if (!connected) listBody = <NotConnected repo={repo} />;
  else if (issues.isPending) listBody = <ListSkeleton />;
  else if (issues.isError && loaded.length === 0) listBody = <HostProblem error={issues.error} onRetry={() => void issues.refetch()} retrying={issues.isFetching} />;
  else if (shown.length === 0) {
    listBody = filtering ? (
      <Blank
        state="empty"
        icon={<SearchX className="size-8" aria-hidden />}
        title={t("issues.view.noResults")}
        action={
          <Button size="sm" onClick={resetFilters}>
            {t("issues.view.resetFilters")}
          </Button>
        }
      >
        {filter.mine && loaded.length > 0
          ? t("issues.view.noneAssigned", { count: loaded.length })
          : filter.query.trim()
            ? t("issues.view.noMatch", { query: filter.query.trim() })
            : t("issues.view.noneInState", { state: listStateLabels[filter.state] })}
        {filter.mine && issues.hasNextPage ? t("issues.view.notAllLoaded") : ""}
      </Blank>
    ) : (
      <Blank state="empty" icon={<Inbox className="size-8" aria-hidden />} title={t("issues.view.noOpen")}>
        {t("issues.view.nothingOpen", { where })}
      </Blank>
    );
  } else {
    listBody = (
      <div ref={listRef} role="listbox" aria-label={t("issues.view.title")} aria-orientation="vertical" onKeyDown={onListKeyDown} data-issue-list>
        {shown.map((issue) => (
          <IssueOption key={issue.number} issue={issue} selected={issue.number === number} focusable={issue.number === tabStop} onOpen={() => open(issue)} />
        ))}
      </div>
    );
  }

  const showControls = Boolean(repo && connected && repo.capabilities.issues);
  const staleProblem = connected && issues.isError && loaded.length > 0 && !issues.isFetchNextPageError ? describeHostError(issues.error) : null;
  const knownIssue = number !== null ? loaded.find((issue) => issue.number === number) : undefined;

  return (
    <section ref={rootRef} aria-label={t("issues.view.title")} data-screen="issues" data-state={listState} data-layout={wide ? "two" : "one"} className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <CircleDot className="size-icon shrink-0 text-text-muted" aria-hidden />
        <h2 className="m-0 shrink-0 text-base font-medium text-text">{t("issues.view.title")}</h2>
        {where ? (
          <span className="selectable min-w-0 truncate font-mono text-code text-text-muted" title={repo?.kind ? t("issues.view.atHost", { where, host: hostKindLabels[repo.kind] }) : where}>
            {where}
          </span>
        ) : null}
        <span className="flex-1" />
        {showControls ? (
          <>
            <IconButton
              size="sm"
              label={t("issues.view.reload")}
              data-action="issues-refresh"
              icon={<RefreshCw className={cn("size-icon", refreshing && "animate-spin")} aria-hidden />}
              onClick={() => void refreshIssues(repoId)}
            />
            <IconButton size="sm" label={t("issues.view.openInBrowser")} data-action="issues-web" disabled={!webUrl} icon={<ExternalLink className="size-icon" aria-hidden />} onClick={() => void openInBrowser(webUrl)} />
          </>
        ) : null}
        <IconButton size="sm" label={t("issues.view.close")} shortcut="Escape" data-back="" icon={<X className="size-icon" aria-hidden />} onClick={() => closeCenter(tabId)} />
      </header>

      <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-1">
        {showList ? (
          <div className={cn("flex min-h-0 min-w-0 flex-col", wide && (showDetails || listState === "filled") ? "w-80 shrink-0 border-r border-border" : "flex-1")} data-issues-pane="list">
            {showControls ? (
              <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface p-2" role="search" aria-label={t("issues.view.filterLabel")}>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-2 left-2 size-icon text-text-muted" aria-hidden />
                  <TextField
                    id={searchId}
                    type="search"
                    aria-label={t("issues.view.search")}
                    placeholder={t("issues.view.search")}
                    value={typed}
                    autoComplete="off"
                    className="pl-8"
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                      // Arrow down leads from the search field into the list.
                      if (event.key === "ArrowDown" && shown.length > 0) {
                        event.preventDefault();
                        focusRow(tabStop ?? shown[0]?.number);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        patchFilter(repoId, { query: typed });
                      }
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <SegmentedControl label={t("issues.view.stateLabel")} value={filter.state} options={STATE_OPTIONS} onValueChange={(state) => patchFilter(repoId, { state })} />
                  <Checkbox label={t("issues.view.mine")} checked={filter.mine} disabled={!me} hint={me ? undefined : t("issues.view.notSignedIn")} onCheckedChange={(mine) => patchFilter(repoId, { mine })} />
                </div>
              </div>
            ) : null}
            {/* Reload failed, but a list is still there: it stays (it is still useful) – with a clear notice that it is not current. */}
            {staleProblem ? (
              <div
                role={staleProblem.kind === "rate_limit" ? "status" : "alert"}
                data-issues-stale={staleProblem.kind}
                className={cn("shrink-0 border-b border-border px-3 py-2 text-sm", staleProblem.kind === "rate_limit" ? "bg-warning-surface" : "bg-danger-surface")}
              >
                <p className="m-0 flex items-start gap-1.5 text-base font-medium text-text">
                  <TriangleAlert className={cn("mt-0.5 size-icon shrink-0", staleProblem.kind === "rate_limit" ? "text-warning" : "text-danger")} aria-hidden />
                  {t("issues.view.stale")}
                </p>
                <p className="selectable m-0 mt-0.5 break-words text-text-muted">{localizeTimes(staleProblem.text)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" loading={issues.isFetching} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void issues.refetch()}>
                    {t("issues.problem.retry")}
                  </Button>
                  {staleProblem.kind === "auth" || staleProblem.kind === "not_connected" ? (
                    <Button size="sm" onClick={openIntegrations}>
                      {t("issues.problem.openIntegrations")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-issues-scroll>
              {listBody}
              {listState === "filled" || (listState === "empty" && issues.hasNextPage) ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 text-sm text-text-muted" data-issues-footer>
                  <span role="status" className="min-w-0 flex-1">
                    {filter.mine ? t("issues.view.shownOfLoaded", { shown: shown.length, count: loaded.length }) : t("issues.view.loaded", { count: loaded.length })}
                    {issues.hasNextPage ? "" : t("issues.view.thatsAll")}
                    {issues.isFetchNextPageError ? (
                      <span className="selectable block break-words text-danger" data-issues-more-error>
                        {t("issues.view.moreFailed", { reason: localizeTimes(describeHostError(issues.error).text) })}
                      </span>
                    ) : null}
                  </span>
                  {issues.hasNextPage ? (
                    <Button size="sm" loading={issues.isFetchingNextPage} data-action="issues-more" onClick={() => void issues.fetchNextPage()}>
                      {t("issues.view.loadMore")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {showDetails && number !== null ? (
          <IssueDetailsPane key={number} repoId={repoId} tabId={tabId} number={number} known={knownIssue} onBack={wide ? undefined : backToList} />
        ) : wide && listState === "filled" ? (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center" data-issues-pane="hint">
            <p className="flex max-w-72 flex-col items-center gap-2 px-6 text-center text-base text-text-muted">
              <MousePointerClick className="size-6" aria-hidden />
              {t("issues.view.pick")}
            </p>
          </div>
        ) : null}
        {refreshing ? (
          <span role="status" className="sr-only">
            {t("issues.view.refreshing")}
          </span>
        ) : null}
      </div>
    </section>
  );
}
