import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FolderGit2, FolderOpen, FolderPlus, RefreshCw, Search, SearchX, TriangleAlert, X } from "lucide-react";
import { core, type ErrorCode, type Id, type Repo } from "../../core";
import { forgetRepo, openRepoTab, openRepositoryAt } from "../../app/actions/repos";
import { describeError } from "../../app/errors";
import { qk, queryClient, useRepos } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { Banner, EmptyState } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { cn } from "../../ui/cn";
import { WrappingPath } from "../CloneDialog/PathText";
import { baseName } from "../CloneDialog/paths";
import { openInitDialogAt } from "../InitDialog/preset";
import { ReadmePreview } from "./ReadmePreview";
import { AiSetupEntry } from "./AiSetupEntry";
import { RepoList, type ListItem, type RepoListHandle } from "./RepoList";
import { resolveMissing } from "./repoActions";
import { locale, t } from "../../i18n";

export interface RepoManagementProps {
  /** The management tab; null if no tab is open at all. */
  tabId: Id | null;
}

type Grouping = "recent" | "groups";
type Notice = { kind: "not_a_repo" | "path_not_found"; path: string };

/** From this many entries on there is a filter field. */
const FILTER_FROM = 8;
const GROUPING_KEY = "gc.repoGrouping";
const QUIET: ErrorCode[] = ["not_a_repo", "path_not_found"];

function loadGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === "groups" ? "groups" : "recent";
  } catch {
    return "recent";
  }
}

const collator = new Intl.Collator(locale(), { sensitivity: "base", numeric: true });

function matches(repo: Repo, words: string[]): boolean {
  if (!words.length) return true;
  const text = `${repo.alias ?? ""}\n${repo.name}\n${repo.path}\n${repo.groupName ?? ""}`.toLocaleLowerCase(locale());
  return words.every((word) => text.includes(word));
}

function buildItems(repos: Repo[], grouping: Grouping): ListItem[] {
  const items: ListItem[] = [];
  const section = (key: string, label: string, list: Repo[], group?: string) => {
    if (!list.length) return;
    items.push({ kind: "header", key: `header:${key}`, label, count: list.length, group });
    for (const repo of list) items.push({ kind: "repo", key: repo.id, repo });
  };
  // The core already returns the list sorted by "last opened".
  section("favorites", t("repos.sections.favorites"), repos.filter((repo) => repo.isFavorite));
  const rest = repos.filter((repo) => !repo.isFavorite);
  if (grouping === "groups") {
    const names = [...new Set(rest.flatMap((repo) => (repo.groupName ? [repo.groupName] : [])))].sort(collator.compare);
    for (const name of names) section(`group:${name}`, name, rest.filter((repo) => repo.groupName === name), name);
    section("ungrouped", t("repos.sections.ungrouped"), rest.filter((repo) => !repo.groupName));
  } else {
    section("recent", t("repos.sections.recent"), rest);
  }
  return items;
}

function EntryButtons({ onOpen }: { onOpen: () => void }) {
  const openOverlay = useAppStore((state) => state.openOverlay);
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" icon={<FolderOpen className="size-icon" aria-hidden />} onClick={onOpen}>
        {t("repos.entry.open")}
      </Button>
      <Button icon={<Download className="size-icon" aria-hidden />} onClick={() => openOverlay({ kind: "clone" })}>
        {t("repos.entry.clone")}
      </Button>
      <Button icon={<FolderPlus className="size-icon" aria-hidden />} onClick={() => openOverlay({ kind: "init" })}>
        {t("repos.entry.init")}
      </Button>
      <AiSetupEntry />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label={t("repos.loading")} className="flex flex-col pt-7">
      {["w-40", "w-56", "w-32", "w-48", "w-36", "w-52"].map((width, index) => (
        <div key={index} className="flex h-11 items-center gap-2.5 px-4">
          <div className="size-4 animate-pulse rounded-sm bg-surface-raised" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className={cn("h-3 animate-pulse rounded-sm bg-surface-raised", width)} />
            <div className="h-2.5 w-3/5 animate-pulse rounded-sm bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Repository management: open, clone, create, recently opened and favourites. */
export function RepoManagement({ tabId: _tabId }: RepoManagementProps) {
  const reposQuery = useRepos();
  const repos = reposQuery.data;
  const [filter, setFilter] = useState("");
  const [grouping, setGrouping] = useState<Grouping>(loadGrouping);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const [previewId, setPreviewId] = useState<Id | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const list = useRef<RepoListHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const hasGroups = Boolean(repos?.some((repo) => repo.groupName));
  const groups = useMemo(() => [...new Set((repos ?? []).flatMap((repo) => (repo.groupName ? [repo.groupName] : [])))].sort(collator.compare), [repos]);
  const effectiveGrouping: Grouping = hasGroups ? grouping : "recent";
  const showFilter = (repos?.length ?? 0) >= FILTER_FROM;
  const words = useMemo(() => (showFilter ? filter.toLocaleLowerCase("de").split(/\s+/).filter(Boolean) : []), [filter, showFilter]);

  const items = useMemo(() => buildItems((repos ?? []).filter((repo) => matches(repo, words)), effectiveGrouping), [repos, words, effectiveGrouping]);
  const visibleRepos = useMemo(() => items.flatMap((item) => (item.kind === "repo" ? [item.repo] : [])), [items]);

  // A visible entry is always selected.
  useEffect(() => {
    if (selectedId && visibleRepos.some((repo) => repo.id === selectedId)) return;
    setSelectedId(visibleRepos[0]?.id ?? null);
  }, [visibleRepos, selectedId]);

  // The preview follows the selection with a short delay – arrowing through the list does not load every README.
  useEffect(() => {
    if (previewId === null) {
      setPreviewId(selectedId);
      return;
    }
    const timer = window.setTimeout(() => setPreviewId(selectedId), 140);
    return () => window.clearTimeout(timer);
  }, [selectedId, previewId]);

  const previewRepo = repos?.find((repo) => repo.id === previewId) ?? null;

  const changeGrouping = (next: Grouping) => {
    setGrouping(next);
    try {
      localStorage.setItem(GROUPING_KEY, next);
    } catch {
      // then only applies until restart
    }
  };

  /** "Open …": pick a folder; if it is not a repository, the offer to create one there stays. */
  const openFolder = async () => {
    const path = await core.pickFolder({ title: t("repos.pickFolderTitle") });
    if (!path) return;
    setNotice(null);
    const result = await openRepositoryAt(path, { quiet: QUIET });
    if (!result.ok && (result.error.code === "not_a_repo" || result.error.code === "path_not_found")) setNotice({ kind: result.error.code, path });
  };

  const openRepo = async (repo: Repo) => {
    if (repo.missing) {
      await resolveMissing(repo);
      return;
    }
    const result = await openRepositoryAt(repo.path, { quiet: QUIET });
    if (!result.ok && (result.error.code === "not_a_repo" || result.error.code === "path_not_found")) {
      // The folder has disappeared since the last load: refresh the list, then the row shows it.
      setNotice({ kind: result.error.code, path: repo.path });
      void queryClient.invalidateQueries({ queryKey: qk.repos });
    }
  };

  const openInTab = (repo: Repo) => {
    if (repo.missing) void resolveMissing(repo);
    else void openRepoTab(repo.id);
  };

  const remove = async (repo: Repo) => {
    const index = visibleRepos.findIndex((item) => item.id === repo.id);
    const neighbour = visibleRepos[index + 1] ?? visibleRepos[index - 1] ?? null;
    const result = await forgetRepo(repo);
    if (!result?.ok) return;
    queryClient.setQueryData<Repo[]>(qk.repos, (current) => current?.filter((item) => item.id !== repo.id));
    setSelectedId(neighbour?.id ?? null);
    // Focus was on the removed row; it moves to the next one.
    window.setTimeout(() => list.current?.focusRow(neighbour?.id ?? null), 0);
  };

  const closeNotice = <IconButton size="sm" label={t("repos.notice.close")} icon={<X className="size-icon" aria-hidden />} onClick={() => setNotice(null)} />;
  const noticeBanner = notice ? (
    <div className="px-4 pb-3" data-notice={notice.kind}>
      <div className="overflow-hidden rounded-md">
        {notice.kind === "not_a_repo" ? (
          <Banner tone="warning" title={t("repos.notice.notARepoTitle", { name: baseName(notice.path) })} actions={closeNotice}>
            <p>
              <WrappingPath path={notice.path} className="text-text" /> {t("repos.notice.notARepoBody")}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" icon={<FolderPlus className="size-icon" aria-hidden />} onClick={() => openInitDialogAt(notice.path)}>
                {t("repos.notice.createHere")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void openFolder()}>
                {t("repos.notice.pickOther")}
              </Button>
            </div>
          </Banner>
        ) : (
          <Banner tone="danger" title={t("repos.notice.notFoundTitle")} actions={closeNotice}>
            <p>
              <WrappingPath path={notice.path} className="text-text" /> {t("repos.notice.notFoundBody")}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void openFolder()}>
                {t("repos.notice.pickOther")}
              </Button>
            </div>
          </Banner>
        )}
      </div>
    </div>
  ) : null;

  // --- No repository at all yet: only the three entry points ----------------------
  if (reposQuery.isSuccess && repos && repos.length === 0) {
    return (
      <div data-screen="repo-management" data-state="empty" className="flex min-h-0 flex-1 flex-col bg-bg">
        {notice ? <div className="mx-auto w-full max-w-180 pt-4">{noticeBanner}</div> : null}
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon={<FolderGit2 className="size-8" aria-hidden />} title={t("repos.empty.title")} action={<EntryButtons onOpen={() => void openFolder()} />}>
            {t("repos.empty.body")}
          </EmptyState>
        </div>
      </div>
    );
  }

  const total = repos?.length ?? 0;
  const shown = visibleRepos.length;

  let listBody;
  if (reposQuery.isPending) {
    listBody = <ListSkeleton />;
  } else if (reposQuery.isError) {
    listBody = (
      <div className="flex flex-1 items-center justify-center" data-list-error>
        <EmptyState
          icon={<TriangleAlert className="size-6" aria-hidden />}
          title={t("repos.listError")}
          action={
            <Button icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void reposQuery.refetch()}>
              {t("repos.retry")}
            </Button>
          }
        >
          {describeError(reposQuery.error).text}
        </EmptyState>
      </div>
    );
  } else if (shown === 0) {
    listBody = (
      <div className="flex flex-1 items-center justify-center" data-list-nomatch>
        <EmptyState
          icon={<SearchX className="size-6" aria-hidden />}
          title={t("repos.noMatch.title")}
          action={
            <Button
              onClick={() => {
                setFilter("");
                filterRef.current?.focus();
              }}
            >
              {t("repos.filter.clear")}
            </Button>
          }
        >
          {t("repos.noMatch.body", { filter: filter.trim() })}
        </EmptyState>
      </div>
    );
  } else {
    listBody = (
      <RepoList
        handle={list}
        items={items}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpen={(repo) => void openRepo(repo)}
        onOpenInTab={openInTab}
        onRemove={(repo) => void remove(repo)}
        groups={groups}
        groupMembers={(name) => (repos ?? []).filter((repo) => repo.groupName === name)}
        showGroup={effectiveGrouping === "recent"}
      />
    );
  }

  return (
    <div data-screen="repo-management" data-state={reposQuery.isPending ? "loading" : reposQuery.isError ? "error" : "ready"} className="@container flex min-h-0 flex-1 bg-bg">
      <section aria-label={t("repos.title")} className="flex min-w-0 flex-1 flex-col bg-surface @5xl:w-130 @5xl:flex-none @5xl:border-r @5xl:border-border">
        <div className="mx-auto flex min-h-0 w-full max-w-180 flex-1 flex-col">
          <header className="flex flex-col gap-3 px-4 pt-5 pb-4">
            <h1 className="text-xl font-semibold">{t("repos.title")}</h1>
            <EntryButtons onOpen={() => void openFolder()} />
          </header>
          {noticeBanner}
          {reposQuery.isSuccess && (showFilter || hasGroups) ? (
            <div className="flex items-center gap-2 px-4 pb-2">
              {showFilter ? (
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-muted" aria-hidden />
                  <input
                    ref={filterRef}
                    type="text"
                    aria-label={t("repos.filter.label")}
                    placeholder={t("repos.filter.placeholder")}
                    value={filter}
                    spellCheck={false}
                    autoComplete="off"
                    className={cn(
                      "h-control-md w-full rounded-md border border-border-input bg-surface-sunken pr-7 pl-7 text-base text-text",
                      "placeholder:text-text-muted hover:border-text-muted focus-visible:border-accent",
                    )}
                    onChange={(event) => setFilter(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && filter) {
                        event.preventDefault();
                        event.stopPropagation();
                        setFilter("");
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        list.current?.focusRow(selectedId);
                      } else if (event.key === "Enter") {
                        const first = visibleRepos.find((repo) => repo.id === selectedId) ?? visibleRepos[0];
                        if (first) void openRepo(first);
                      }
                    }}
                  />
                  {filter ? (
                    <span className="absolute top-1/2 right-0.5 -translate-y-1/2">
                      <IconButton
                        size="sm"
                        label={t("repos.filter.clear")}
                        icon={<X className="size-3.5" aria-hidden />}
                        onClick={() => {
                          setFilter("");
                          filterRef.current?.focus();
                        }}
                      />
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="flex-1" />
              )}
              {hasGroups ? (
                <SegmentedControl
                  label={t("repos.grouping.label")}
                  value={grouping}
                  options={[
                    { value: "recent", label: t("repos.grouping.recent") },
                    { value: "groups", label: t("repos.grouping.groups") },
                  ]}
                  onValueChange={changeGrouping}
                />
              ) : null}
              <span data-repo-count className="shrink-0 text-sm text-text-muted" aria-live="polite">
                {words.length ? t("repos.countFiltered", { shown: shown.toLocaleString(locale()), total: total.toLocaleString(locale()) }) : t("repos.count", { count: total })}
              </span>
            </div>
          ) : null}
          {listBody}
        </div>
      </section>
      <aside aria-label={t("repos.readmeLabel")} className="hidden min-w-0 flex-1 flex-col bg-bg @5xl:flex">
        <ReadmePreview repo={reposQuery.isSuccess ? previewRepo : null} />
      </aside>
    </div>
  );
}
