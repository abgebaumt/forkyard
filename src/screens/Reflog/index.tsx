/**
 * Reflog: where HEAD (or a branch) has pointed, newest first – including commits that no branch
 * reaches any more. Selecting an entry shows the commit in the commit panel; the menu creates a branch
 * there, checks it out, resets the current branch to it (with undo) or copies the SHA. Entries whose
 * commit Git has already removed stay visible, but only offer copying the SHA.
 *
 * Keys in the list: ↑/↓, PgUp/PgDn, Home/End select · Enter: details · menu key/Shift+F10: actions · Esc: back.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileWarning, History, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { Id, ReflogEntry } from "../../core";
import { hasOpenDialog } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { formatDateTime, formatRelative, shortSha } from "../../app/format";
import { openMenuAt, reflogMenu } from "../../app/menus";
import { hasOpenMenu } from "../../app/menus/host";
import { useRefs, useReflog } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { EmptyState } from "../../ui/Feedback";
import type { MenuEntry } from "../../ui/Menu";
import { Select } from "../../ui/Select";
import { goBack } from "../FileView/nav";
import { BackButton, isPlainEscape, ownsKey } from "../FileView/parts";
import { actionLabel, refFromValue, refOptions, refValue } from "./model";
import { t } from "../../i18n";

/** Two lines of text per entry (h-12). */
const ROW_HEIGHT = 48;

export interface ReflogViewProps {
  repoId: Id;
  tabId: Id;
  /** null = HEAD. */
  refName: string | null;
}

export function ReflogView({ repoId, tabId, refName }: ReflogViewProps) {
  const store = useAppStore.getState;
  const query = useReflog(repoId, refName);
  const { data: refs } = useRefs(repoId);
  const entries = useMemo(() => query.data?.pages.flatMap((page) => page.entries) ?? [], [query.data]);
  const options = useMemo(() => refOptions(refs, refName), [refs, refName]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [refName]);

  const select = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return;
      setSelected(index);
      // The commit panel shows the commit – as long as it still exists.
      if (entry.exists) store().selectCommits(tabId, [entry.sha]);
    },
    [entries, store, tabId],
  );
  const open = useCallback(
    (index: number) => {
      select(index);
      store().setRightPanel(tabId, "details");
    },
    [select, store, tabId],
  );
  const menuFor = useCallback((entry: ReflogEntry) => reflogMenu({ repoId, tabId, sha: entry.sha, exists: entry.exists }), [repoId, tabId]);
  const { hasNextPage, isFetching, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (!isFetching) void fetchNextPage();
  }, [isFetching, fetchNextPage]);

  // Esc: back to the graph (the list does not pass Esc on).
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

  let content: ReactNode;
  if (query.isPending) {
    content = (
      <Centered>
        <p role="status" className="text-sm text-text-muted">
          {t("reflog.loading")}
        </p>
      </Centered>
    );
  } else if (query.isError) {
    content = (
      <Centered>
        <EmptyState
          icon={<FileWarning className="size-6 text-danger" aria-hidden />}
          title={t("reflog.error.title")}
          action={
            <Button icon={<RefreshCw className="size-icon" aria-hidden />} loading={query.isFetching} onClick={() => void query.refetch()}>
              {t("reflog.error.retry")}
            </Button>
          }
        >
          {describeError(query.error).text}
        </EmptyState>
      </Centered>
    );
  } else if (entries.length === 0) {
    content = (
      <Centered>
        <div data-reflog-empty="">
          <EmptyState icon={<History className="size-6" aria-hidden />} title={t("reflog.empty.title")}>
            {t("reflog.empty.body")}
          </EmptyState>
        </div>
      </Centered>
    );
  } else {
    content = (
      <ReflogList
        entries={entries}
        selected={Math.min(selected, entries.length - 1)}
        hasMore={Boolean(hasNextPage)}
        loadingMore={query.isFetchingNextPage}
        onLoadMore={loadMore}
        onSelect={select}
        onOpen={open}
        menuFor={menuFor}
      />
    );
  }

  return (
    <section aria-label={t("reflog.ariaLabel")} data-screen="reflog" className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <History className="size-icon shrink-0 text-text-muted" aria-hidden />
        <h2 className="shrink-0 text-md font-medium text-text">{t("reflog.title")}</h2>
        <div className="w-56 min-w-0">
          <Select ariaLabel={t("reflog.filter")} value={refValue(refName)} options={options} onValueChange={(value) => store().openReflog(tabId, refFromValue(value))} />
        </div>
        <div className="flex-1" />
        <BackButton tabId={tabId} />
      </header>
      {content}
    </section>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-sunken">{children}</div>;
}

interface ReflogListProps {
  entries: ReflogEntry[];
  selected: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  menuFor: (entry: ReflogEntry) => MenuEntry[];
}

function ReflogList({ entries, selected, hasMore, loadingMore, onLoadMore, onSelect, onOpen, menuFor }: ReflogListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const virtualizer = useVirtualizer({ count: entries.length + (hasMore ? 1 : 0), getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1]?.index ?? 0;

  useEffect(() => {
    if (hasMore && last >= entries.length - 5) onLoadMore();
  }, [hasMore, last, entries.length, onLoadMore]);
  useEffect(() => {
    virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [selected, virtualizer]);
  // The list gets the focus as soon as it is there: arrows and Enter work right away.
  useEffect(() => {
    if (viewMayTakeFocus()) scroller.current?.focus({ preventScroll: true });
  }, []);

  const openMenuFor = (index: number, x: number, y: number) => {
    const entry = entries[index];
    if (!entry) return;
    onSelect(index);
    openMenuAt({ x, y }, menuFor(entry), t("reflog.menuLabel", { selector: entry.selector }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 1);
    const move = (index: number) => onSelect(Math.min(entries.length - 1, Math.max(0, index)));
    let handled = true;
    if (plain && event.key === "ArrowDown") move(selected + 1);
    else if (plain && event.key === "ArrowUp") move(selected - 1);
    else if (plain && event.key === "PageDown") move(selected + page);
    else if (plain && event.key === "PageUp") move(selected - page);
    else if (plain && event.key === "Home") move(0);
    else if (plain && event.key === "End") move(entries.length - 1);
    else if (plain && event.key === "Enter") onOpen(selected);
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const rect = scroller.current?.querySelector(`[data-index="${selected}"]`)?.getBoundingClientRect();
      openMenuFor(selected, (rect?.left ?? 0) + 24, rect?.bottom ?? 0);
    } else handled = false;
    if (handled) event.preventDefault();
  };

  return (
    <div
      ref={scroller}
      role="listbox"
      aria-label={t("reflog.listLabel")}
      aria-activedescendant={entries.length ? `${idBase}-${selected}` : undefined}
      tabIndex={0}
      data-reflog-list=""
      onKeyDown={onKeyDown}
      // The focus is shown by the frame around the selected row.
      className="group/list relative min-h-0 flex-1 overflow-y-auto bg-surface outline-none"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((item) => {
          const style: CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` };
          const entry = entries[item.index];
          if (!entry) {
            return (
              <div key="more" style={style} data-index={item.index} role="presentation" className="flex items-center justify-center text-sm text-text-muted">
                {loadingMore ? t("reflog.loadingMore") : t("reflog.more")}
              </div>
            );
          }
          const isSelected = item.index === selected;
          return (
            <div
              key={item.index}
              id={`${idBase}-${item.index}`}
              role="option"
              aria-selected={isSelected}
              aria-disabled={entry.exists ? undefined : true}
              data-index={item.index}
              data-sha={entry.sha}
              data-reflog-action={entry.action}
              data-exists={String(entry.exists)}
              style={style}
              onClick={() => onSelect(item.index)}
              onDoubleClick={() => onOpen(item.index)}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenuFor(item.index, event.clientX, event.clientY);
              }}
              className={cn(
                "flex cursor-default flex-col justify-center gap-0.5 border-b border-border px-3",
                isSelected ? "bg-accent-surface group-focus-visible/list:ring-2 group-focus-visible/list:ring-accent group-focus-visible/list:ring-inset" : "hover:bg-surface-raised",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-sm font-medium text-text-muted">{actionLabel(entry.action)}</span>
                <span className={cn("min-w-0 flex-1 truncate text-base", entry.exists ? "text-text" : "text-text-muted line-through")} title={entry.message}>
                  {entry.message || t("reflog.noMessage")}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
                <span className="shrink-0 whitespace-nowrap" title={formatDateTime(entry.time)}>
                  {formatRelative(entry.time)}
                </span>
                <span aria-hidden>·</span>
                <span className="shrink-0 font-mono">{shortSha(entry.sha)}</span>
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate font-mono">{entry.selector}</span>
                {entry.exists ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{t("reflog.gone")}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
