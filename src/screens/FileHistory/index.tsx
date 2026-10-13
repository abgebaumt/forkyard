/**
 * File history. All commits that changed a file, newest first; follows renames and, for deleted
 * files, reaches up to the deletion. The selection shows the diff of this file in this commit
 * next to it (or below it when space gets tight).
 *
 * Keys in the list: ↑/↓, Home/End, PgUp/PgDn select · Enter: view this version ·
 * B: blame at this revision · G: show in the graph · menu key/Shift+F10: all actions · Esc: back.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, CornerDownRight, Crosshair, Eye, FileClock, FileQuestion, FileWarning, GitCompareArrows, History, RefreshCw, RotateCcw, UserSearch } from "lucide-react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { FileHistoryEntry, Id } from "../../core";
import { copyText } from "../../app/actions/clipboard";
import { hasOpenDialog } from "../../app/dialogs";
import { describeError, toCoreError } from "../../app/errors";
import { formatDateTime, formatRelative, shortSha } from "../../app/format";
import { openMenuAt } from "../../app/menus";
import { hasOpenMenu } from "../../app/menus/host";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { useFileHistory, useStatus } from "../../app/queries";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner, EmptyState } from "../../ui/Feedback";
import { Avatar, StatusBadge } from "../../ui/Git";
import type { MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { goBack, showInGraph } from "../FileView/nav";
import { BackButton, Divider, FileTitle, Tag, isPlainEscape, ownsKey, splitPath } from "../FileView/parts";
import { DiffView } from "../DiffView";
import { restoreBusyKey, restoreVersion, versionOf } from "./actions";
import { t } from "../../i18n";

export interface FileHistoryProps {
  repoId: Id;
  tabId: Id;
  path: string;
}

/** First page and load-more step. */
const PAGE = 200;
/** Row height of the list (two lines of text, h-12). */
const ROW_HEIGHT = 48;
/** With a third line for the former name (h-16). */
const ROW_HEIGHT_NAMED = 64;

/** Former name that a row mentions in addition: for the rename itself and for all commits before it. */
function formerName(entry: FileHistoryEntry, currentPath: string): { kind: "renamed" | "then"; path: string } | null {
  if (entry.status === "renamed" && entry.oldPath) return { kind: "renamed", path: entry.oldPath };
  return entry.path !== currentPath ? { kind: "then", path: entry.path } : null;
}
/** From this width on, list and diff are side by side, below it stacked. */
const SIDE_BY_SIDE_MIN = 760;

/** Selection per tab and file: whoever comes back from a version or the blame is on the same commit again. */
const remembered = new Map<string, string>();

/** Dateiverlauf. */
export function FileHistory({ repoId, tabId, path }: FileHistoryProps) {
  const store = useAppStore.getState;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [path]);
  const query = useFileHistory(repoId, path, limit);
  const entries = useMemo(() => query.data ?? [], [query.data]);
  const mayHaveMore = entries.length >= limit;
  const { data: status } = useStatus(repoId);

  const memoKey = `${tabId}|${path}`;
  const [selectedSha, setSelectedSha] = useState<string | null>(() => remembered.get(memoKey) ?? null);
  useEffect(() => setSelectedSha(remembered.get(memoKey) ?? null), [memoKey]);
  const selectedIndex = Math.max(0, selectedSha ? entries.findIndex((entry) => entry.commit.sha === selectedSha) : 0);
  const selected = entries[selectedIndex] ?? null;

  // --- Width: side by side or stacked -----------------------------------------------------------
  const root = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= SIDE_BY_SIDE_MIN));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // --- Aktionen --------------------------------------------------------------------------------
  const openVersion = useCallback(
    (entry: FileHistoryEntry) => {
      const version = versionOf(entry);
      if (version.sha) store().openFile(tabId, version.path, version.sha, "view");
    },
    [store, tabId],
  );
  const openBlame = useCallback(
    (entry: FileHistoryEntry) => {
      const version = versionOf(entry);
      if (version.sha) store().openBlame(tabId, version.path, version.sha);
    },
    [store, tabId],
  );
  const restoring = useBusy(restoreBusyKey(repoId));

  const menuFor = useCallback(
    (entry: FileHistoryEntry): MenuEntry[] => {
      const version = versionOf(entry);
      const none = version.sha ? undefined : t("fileHistory.noEarlierVersion");
      return [
        { label: version.beforeDelete ? t("fileHistory.action.viewBeforeDelete") : t("fileHistory.action.view"), icon: <Eye className="size-icon" />, shortcut: "Enter", disabled: !version.sha, hint: none, onSelect: () => openVersion(entry) },
        { label: t("fileHistory.action.blame"), icon: <UserSearch className="size-icon" />, shortcut: "B", disabled: !version.sha, hint: none, onSelect: () => openBlame(entry) },
        {
          label: t("fileHistory.action.compareWorkdir"),
          icon: <GitCompareArrows className="size-icon" />,
          disabled: !version.sha,
          onSelect: () => version.sha && store().openDiff(tabId, path, { kind: "range", from: version.sha, to: null }),
        },
        { type: "separator" },
        { label: t("fileHistory.action.showInGraph"), icon: <Crosshair className="size-icon" />, shortcut: "G", onSelect: () => showInGraph(tabId, entry.commit.sha) },
        { label: t("fileHistory.action.copySha"), icon: <Copy className="size-icon" />, onSelect: () => void copyText(entry.commit.sha, "SHA") },
        { type: "separator" },
        {
          label: version.beforeDelete ? t("fileHistory.action.restoreBeforeDeleteMenu") : t("fileHistory.action.restoreMenu"),
          icon: <RotateCcw className="size-icon" />,
          disabled: !version.sha || restoring,
          hint: none ?? t("fileHistory.action.restoreHint", { sha: shortSha(version.sha ?? "") }),
          onSelect: () => void restoreVersion(repoId, entry),
        },
      ];
    },
    [openBlame, openVersion, path, repoId, restoring, store, tabId],
  );

  // Esc: back (the list and the embedded diff do not pass Esc on).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlainEscape(event)) return;
      if (!ownsKey(event, hasOpenDialog() || hasOpenMenu() || Boolean(useAppStore.getState().overlay))) return;
      event.preventDefault();
      goBack(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabId]);

  // --- States ----------------------------------------------------------------------------------
  const listed = [...(status?.unstaged ?? []), ...(status?.staged ?? [])].find((file) => file.path === path);
  const isNew = listed?.status === "untracked" || listed?.status === "added";
  const deletedIn = entries[0]?.status === "deleted" ? entries[0] : null;
  const olderNames = useMemo(() => Array.from(new Set(entries.map((entry) => entry.path).filter((name) => name !== path))), [entries, path]);

  let content: ReactNode;
  if (query.isPending) {
    content = <ListSkeleton wide={wide} />;
  } else if (query.isError) {
    const error = toCoreError(query.error);
    content = (
      <Centered>
        <EmptyState
          icon={<FileWarning className="size-6 text-danger" aria-hidden />}
          title={t("fileHistory.error.title")}
          action={
            <Button icon={<RefreshCw className="size-icon" aria-hidden />} loading={query.isFetching} onClick={() => void query.refetch()}>
              {t("fileHistory.error.retry")}
            </Button>
          }
        >
          {describeError(error).text}
        </EmptyState>
      </Centered>
    );
  } else if (entries.length === 0) {
    content = (
      <Centered data-history-empty={isNew ? "new" : "unknown"}>
        <EmptyState
          icon={isNew ? <FileClock className="size-6" aria-hidden /> : <FileQuestion className="size-6" aria-hidden />}
          title={isNew ? t("fileHistory.empty.newTitle") : t("fileHistory.empty.noneTitle")}
          action={
            isNew ? (
              <Button icon={<Eye className="size-icon" aria-hidden />} onClick={() => store().openFile(tabId, path, null, "view")}>
                {t("fileHistory.empty.viewFile")}
              </Button>
            ) : undefined
          }
        >
          {isNew
            ? t("fileHistory.empty.newBody", { name: splitPath(path).name })
            : t("fileHistory.empty.noneBody")}
        </EmptyState>
      </Centered>
    );
  } else {
    content = (
      <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        <HistoryList
          entries={entries}
          currentPath={path}
          selectedIndex={selectedIndex}
          wide={wide}
          loadingMore={query.isFetching && query.isPlaceholderData}
          mayHaveMore={mayHaveMore}
          onLoadMore={() => {
            if (!query.isFetching) setLimit((current) => (entries.length >= current ? current + PAGE : current));
          }}
          onSelect={(index) => {
            const sha = entries[index]?.commit.sha ?? null;
            if (sha) remembered.set(memoKey, sha);
            setSelectedSha(sha);
          }}
          onOpen={(index) => entries[index] && openVersion(entries[index])}
          onBlame={(index) => entries[index] && openBlame(entries[index])}
          onReveal={(index) => entries[index] && showInGraph(tabId, entries[index].commit.sha)}
          menuFor={menuFor}
        />
        {selected ? (
          <Detail
            key={`${selected.commit.sha}|${selected.path}`}
            repoId={repoId}
            tabId={tabId}
            entry={selected}
            restoring={restoring}
            onOpen={() => openVersion(selected)}
            onBlame={() => openBlame(selected)}
            onRestore={() => void restoreVersion(repoId, selected)}
            onReveal={() => showInGraph(tabId, selected.commit.sha)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <section ref={root} aria-label={t("fileHistory.ariaLabel", { path })} data-screen="file-history" data-layout={wide ? "wide" : "stacked"} className="@container flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <FileTitle path={path} icon={<History className="size-icon" aria-hidden />} prefix={t("fileHistory.prefix")} strike={Boolean(deletedIn)} />
        {entries.length > 0 ? (
          <Tag data-history-count={String(entries.length)}>{mayHaveMore ? t("fileHistory.countMore", { count: entries.length }) : t("fileHistory.count", { count: entries.length })}</Tag>
        ) : null}
        <Divider />
        <Button size="sm" variant="ghost" icon={<Eye className="size-icon" aria-hidden />} disabled={Boolean(deletedIn)} title={deletedIn ? t("fileHistory.goneFromWorkdir") : undefined} onClick={() => store().openFile(tabId, path, null, "view")}>
          <span className="hidden @3xl:inline">{t("fileHistory.current")}</span>
          <span className="sr-only @3xl:hidden">{t("fileHistory.viewCurrent")}</span>
        </Button>
        <Button size="sm" variant="ghost" icon={<UserSearch className="size-icon" aria-hidden />} disabled={Boolean(deletedIn) || entries.length === 0} onClick={() => store().openBlame(tabId, path, null)}>
          <span className="hidden @3xl:inline">{t("fileHistory.blame")}</span>
          <span className="sr-only @3xl:hidden">{t("fileHistory.blame")}</span>
        </Button>
        <Divider />
        <BackButton tabId={tabId} />
      </header>
      {deletedIn ? (
        <Banner tone="info" title={t("fileHistory.deleted.title", { sha: shortSha(deletedIn.commit.sha) })}>
          {t("fileHistory.deleted.body", { summary: deletedIn.commit.summary })}
        </Banner>
      ) : null}
      {olderNames.length > 0 ? (
        <div role="status" data-history-renamed="" className="flex min-h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-0.5 text-sm text-text-muted">
          <span className="min-w-0 flex-1 truncate">
            {t("fileHistory.followsRename")} <span className="font-mono text-code text-text">{olderNames.join(", ")}</span>
          </span>
        </div>
      ) : null}
      {content}
    </section>
  );
}

function Centered({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-sunken" {...rest}>
      {children}
    </div>
  );
}

function ListSkeleton({ wide }: { wide: boolean }) {
  return (
    <div role="status" aria-label={t("fileHistory.loading")} data-loading="" className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
      <div className={cn("flex shrink-0 flex-col border-border", wide ? "w-80 border-r" : "h-2/5 border-b")}>
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex h-12 flex-col justify-center gap-1.5 px-3">
            <div className={cn("h-3 animate-pulse rounded-sm bg-surface-raised", index % 3 === 0 ? "w-3/4" : index % 3 === 1 ? "w-1/2" : "w-2/3")} />
            <div className="h-2.5 w-2/5 animate-pulse rounded-sm bg-surface-raised" />
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 bg-surface-sunken" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

interface HistoryListProps {
  entries: FileHistoryEntry[];
  currentPath: string;
  selectedIndex: number;
  wide: boolean;
  loadingMore: boolean;
  mayHaveMore: boolean;
  onLoadMore: () => void;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onBlame: (index: number) => void;
  onReveal: (index: number) => void;
  menuFor: (entry: FileHistoryEntry) => MenuEntry[];
}

function HistoryList({ entries, currentPath, selectedIndex, wide, loadingMore, mayHaveMore, onLoadMore, onSelect, onOpen, onBlame, onReveal, menuFor }: HistoryListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const count = entries.length + (mayHaveMore ? 1 : 0);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (entries[index] && formerName(entries[index], currentPath) ? ROW_HEIGHT_NAMED : ROW_HEIGHT),
    overscan: 12,
  });
  // Other entries, other heights: measure again.
  useEffect(() => virtualizer.measure(), [entries, currentPath, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1]?.index ?? 0;

  useEffect(() => {
    if (mayHaveMore && last >= entries.length - 5) onLoadMore();
  }, [last, entries.length, mayHaveMore, onLoadMore]);

  useEffect(() => {
    virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  // The list gets the focus as soon as it is there: arrows and Enter work right away.
  useEffect(() => {
    if (viewMayTakeFocus()) scroller.current?.focus({ preventScroll: true });
  }, []);

  // Stable callbacks: while scrolling React only renders new rows, not all visible ones.
  const latest = useRef({ entries, menuFor, onSelect });
  latest.current = { entries, menuFor, onSelect };
  const onMenu = useCallback((index: number, x: number, y: number) => {
    const entry = latest.current.entries[index];
    if (!entry) return;
    latest.current.onSelect(index);
    openMenuAt({ x, y }, latest.current.menuFor(entry), t("fileHistory.commitActions"));
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 1);
    const move = (index: number) => onSelect(Math.min(entries.length - 1, Math.max(0, index)));
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    let handled = true;
    if (event.key === "ArrowDown" && plain) move(selectedIndex + 1);
    else if (event.key === "ArrowUp" && plain) move(selectedIndex - 1);
    else if (event.key === "PageDown" && plain) move(selectedIndex + page);
    else if (event.key === "PageUp" && plain) move(selectedIndex - page);
    else if (event.key === "Home" && plain) move(0);
    else if (event.key === "End" && plain) move(entries.length - 1);
    else if (event.key === "Enter" && plain) onOpen(selectedIndex);
    else if ((event.key === "b" || event.key === "B") && plain && !event.shiftKey) onBlame(selectedIndex);
    else if ((event.key === "g" || event.key === "G") && plain && !event.shiftKey) onReveal(selectedIndex);
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const row = scroller.current?.querySelector(`[data-index="${selectedIndex}"]`);
      const rect = row?.getBoundingClientRect();
      const entry = entries[selectedIndex];
      if (entry) openMenuAt({ x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0 }, menuFor(entry), t("fileHistory.commitActions"));
    } else handled = false;
    if (handled) event.preventDefault();
  };

  return (
    <div
      ref={scroller}
      role="listbox"
      aria-label={t("fileHistory.listLabel")}
      aria-activedescendant={entries.length ? `${idBase}-${selectedIndex}` : undefined}
      tabIndex={0}
      data-history-list=""
      onKeyDown={onKeyDown}
      // The focus is shown by the frame around the selected row.
      className={cn("group/list relative shrink-0 overflow-y-auto bg-surface outline-none", wide ? "w-80 border-r border-border" : "h-2/5 border-b border-border")}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((item) => {
          const entry = entries[item.index];
          if (!entry) {
            const style = { position: "absolute" as const, top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` };
            return (
              <div key="more" style={style} data-index={item.index} className="flex items-center justify-center text-sm text-text-muted" role="presentation">
                {loadingMore ? t("fileHistory.loadingMore") : t("fileHistory.more")}
              </div>
            );
          }
          return (
            <Row
              key={entry.commit.sha}
              id={`${idBase}-${item.index}`}
              index={item.index}
              start={item.start}
              size={item.size}
              entry={entry}
              currentPath={currentPath}
              selected={item.index === selectedIndex}
              onSelect={onSelect}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          );
        })}
      </div>
    </div>
  );
}

const Row = memo(function Row({
  id,
  index,
  start,
  size,
  entry,
  currentPath,
  selected,
  onSelect,
  onOpen,
  onMenu,
}: {
  id: string;
  index: number;
  start: number;
  size: number;
  entry: FileHistoryEntry;
  currentPath: string;
  selected: boolean;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onMenu: (index: number, x: number, y: number) => void;
}) {
  const style: CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height: size, transform: `translateY(${start}px)` };
  const { commit } = entry;
  const former = formerName(entry, currentPath);
  const statusText = entry.status === "added" ? t("fileHistory.status.added") : entry.status === "deleted" ? t("fileHistory.status.deleted") : entry.status === "renamed" ? t("fileHistory.status.renamed") : t("fileHistory.status.modified");
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${commit.summary}, ${commit.author.name}, ${formatRelative(commit.authoredAt)}, ${statusText}`}
      data-index={index}
      data-sha={commit.sha}
      data-status={entry.status}
      data-path={entry.path}
      data-added={entry.added ?? undefined}
      data-removed={entry.removed ?? undefined}
      style={style}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onOpen(index)}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        onMenu(index, event.clientX, event.clientY);
      }}
      className={cn(
        "flex cursor-default flex-col justify-center gap-0.5 border-b border-border px-3",
        selected ? "bg-accent-surface group-focus-visible/list:ring-2 group-focus-visible/list:ring-accent group-focus-visible/list:ring-inset" : "hover:bg-surface-raised",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusBadge status={entry.status} />
        <span className="min-w-0 flex-1 truncate text-base text-text">{commit.summary || t("fileHistory.noMessage")}</span>
        {entry.added || entry.removed ? (
          <span className="flex shrink-0 gap-1 font-mono text-xs tabular-nums">
            {entry.added ? <span className="text-success">+{entry.added}</span> : null}
            {entry.removed ? <span className="text-danger">−{entry.removed}</span> : null}
          </span>
        ) : entry.added === null ? (
          <span className="shrink-0 text-xs text-text-muted">{t("fileHistory.binary")}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-6 text-xs text-text-muted">
        <Avatar name={commit.author.name} email={commit.author.email} size={16} />
        <span className="min-w-0 shrink truncate">{commit.author.name}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0 whitespace-nowrap" title={formatDateTime(commit.authoredAt)}>
          {formatRelative(commit.authoredAt)}
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0 font-mono">{shortSha(commit.sha)}</span>
      </div>
      {former ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-6 text-xs text-text-muted" data-former-name={former.path} title={former.kind === "renamed" ? `${former.path} → ${entry.path}` : former.path}>
          <CornerDownRight className="size-3 shrink-0" aria-hidden />
          <span className="shrink-0">{former.kind === "renamed" ? t("fileHistory.renamedFrom") : t("fileHistory.calledThen")}</span>
          <span className="min-w-0 truncate font-mono">{former.path}</span>
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Diff of the selected commit
// ---------------------------------------------------------------------------

function Detail({
  repoId,
  tabId,
  entry,
  restoring,
  onOpen,
  onBlame,
  onRestore,
  onReveal,
}: {
  repoId: Id;
  tabId: Id;
  entry: FileHistoryEntry;
  restoring: boolean;
  onOpen: () => void;
  onBlame: () => void;
  onRestore: () => void;
  onReveal: () => void;
}) {
  const version = versionOf(entry);
  const noVersion = !version.sha;
  return (
    <div className="@container/detail flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="toolbar" aria-label={t("fileHistory.commitActions")} data-history-actions="" className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border bg-surface pr-2 pl-3">
        <Tip label={<span className="selectable font-mono text-code">{entry.commit.sha}</span>}>
          <span className="shrink-0 font-mono text-code text-text-muted">{shortSha(entry.commit.sha)}</span>
        </Tip>
        <span className="min-w-0 flex-1 truncate text-sm text-text" title={entry.commit.summary}>
          {entry.commit.summary}
        </span>
        <ActionButton label={version.beforeDelete ? t("fileHistory.action.viewBeforeDelete") : t("fileHistory.action.view")} action="view" short={t("fileHistory.short.view")} shortcut="Enter" icon={<Eye className="size-icon" aria-hidden />} disabled={noVersion} onClick={onOpen} />
        <ActionButton label={t("fileHistory.action.blame")} action="blame" short={t("fileHistory.blame")} shortcut="B" icon={<UserSearch className="size-icon" aria-hidden />} disabled={noVersion} onClick={onBlame} />
        <ActionButton
          label={version.beforeDelete ? t("fileHistory.action.restoreBeforeDelete") : t("fileHistory.action.restore")}
          action="restore"
          short={t("fileHistory.short.restore")}
          icon={<RotateCcw className="size-icon" aria-hidden />}
          disabled={noVersion || restoring}
          onClick={onRestore}
        />
        <ActionButton label={t("fileHistory.action.showInGraph")} action="reveal" short={t("fileHistory.short.showInGraph")} shortcut="G" icon={<Crosshair className="size-icon" aria-hidden />} onClick={onReveal} />
      </div>
      <div className="min-h-0 flex-1">
        <DiffView repoId={repoId} tabId={tabId} path={entry.path} source={{ kind: "commit", sha: entry.commit.sha }} embedded />
      </div>
    </div>
  );
}

function ActionButton({ label, action, short, shortcut, icon, disabled, onClick }: { label: string; action: string; short: string; shortcut?: string; icon: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <Tip label={label} shortcut={shortcut}>
      <Button size="sm" variant="ghost" icon={icon} disabled={disabled} onClick={onClick} aria-label={label} data-action={action}>
        <span className="hidden @3xl/detail:inline">{short}</span>
      </Button>
    </Tip>
  );
}
