/**
 * Activity log: every Git command the app has run, with time, duration, exit code and output.
 * Tabs “App” and “This repository”, filters, search, virtualised list.
 * New entries appear at the top without moving the reading position.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Check, ChevronRight, CircleSlash, Copy, RefreshCw, ScrollText, Search, SearchX, TriangleAlert, X } from "lucide-react";
import { Dialog as RadixDialog, Tabs } from "radix-ui";
import type { ActivityEntry, ActivityScope, Id } from "../../core";
import { describeError } from "../../app/errors";
import { useActivity, useRepo } from "../../app/queries";
import { Button, Spinner } from "../../ui/Button";
import { dialogSurface } from "../../ui/Dialog";
import { toast } from "../../ui/Feedback";
import { Checkbox } from "../../ui/Field";
import { ContextMenu } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { cn } from "../../ui/cn";
import { locale, t } from "../../i18n";

/** Height of a collapsed row in pixels – must match the row's `h-7` class. */
const ROW_HEIGHT = 28;
const PAGE_SIZE = 200;

const clock = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayAndClock = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fullTime = new Intl.DateTimeFormat(locale(), { dateStyle: "full", timeStyle: "medium" });

/** Local time to the second; on other days with the date in front. */
export function formatLogTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? clock.format(date) : dayAndClock.format(date).replace(",", "");
}

/** “840 ms”, “1.3 s”, “2 min 05 s”. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

const failed = (entry: ActivityEntry) => entry.exitCode !== null && entry.exitCode !== 0;

/** `done`: message after copying, e.g. “Command copied”. */
async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ tone: "success", title: done });
  } catch {
    toast({ tone: "danger", title: t("activity.copy.failed"), description: t("activity.copy.failedText") });
  }
}

function ExitBadge({ code }: { code: number | null }) {
  if (code === null) {
    return (
      <span
        title={t("activity.exit.noneTip")}
        className="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 text-xs font-medium text-text-muted"
      >
        <CircleSlash className="size-3" aria-hidden />
        {t("activity.exit.none")}
      </span>
    );
  }
  if (code === 0) {
    return (
      <span className="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 text-xs font-medium text-text-muted" title={t("activity.exit.okTip")}>
        <Check className="size-3 text-success" aria-hidden />
        OK
      </span>
    );
  }
  return (
    <span data-exit="error" className="inline-flex h-5 items-center gap-1 rounded-sm bg-danger-surface px-1.5 text-xs font-semibold text-text" title={t("activity.exit.errorTip", { code })}>
      <TriangleAlert className="size-3 text-danger" aria-hidden />
      {t("activity.exit.error", { code })}
    </span>
  );
}

export function ActivityLog({ repoId, onClose }: { repoId: Id | null; onClose: () => void }) {
  const [scope, setScope] = useState<ActivityScope>(repoId ? "repo" : "app");
  const { data: repo } = useRepo(repoId);
  // If the repo tab goes away, only the app log remains.
  const shownScope: ActivityScope = scope === "repo" && !repoId ? "app" : scope;

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="animate-fade fixed inset-0 z-40 bg-surface-sunken/70" />
        <RadixDialog.Content
          data-screen="activity-log"
          className={cn(dialogSurface, "animate-pop fixed top-1/2 left-1/2 z-50 h-170 w-232 -translate-x-1/2 -translate-y-1/2 overflow-hidden")}
          onOpenAutoFocus={(event) => {
            // Focus the search instead of the close button: its tooltip would otherwise swallow the first Esc.
            const search = event.currentTarget instanceof HTMLElement ? event.currentTarget.querySelector<HTMLElement>('input[type="search"]') : null;
            if (search) {
              event.preventDefault();
              search.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            // Esc in a non-empty search only clears the search.
            const focused = document.activeElement;
            if (focused instanceof HTMLInputElement && focused.type === "search" && focused.value) event.preventDefault();
          }}
        >
          <Tabs.Root value={shownScope} onValueChange={(value) => setScope(value as ActivityScope)} className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-start gap-3 px-4 pt-4">
              <div className="min-w-0 flex-1">
                <RadixDialog.Title className="text-lg font-semibold">{t("activity.title")}</RadixDialog.Title>
                <RadixDialog.Description className="text-base text-text-muted">
                  {t("activity.description")}
                </RadixDialog.Description>
              </div>
              <Tip label={t("activity.close")} shortcut="Esc">
                <RadixDialog.Close
                  aria-label={t("activity.closeLabel")}
                  className="inline-flex size-control-md shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
                >
                  <X className="size-icon" aria-hidden />
                </RadixDialog.Close>
              </Tip>
            </header>
            <Tabs.List aria-label={t("activity.tabs")} className="mt-3 flex gap-1 border-b border-border px-4">
              {repoId ? (
                <Tabs.Trigger value="repo" className={tabClass}>
                  <span className="shrink-0">{t("activity.tabRepo")}</span>
                  {repo ? <span className="min-w-0 truncate font-normal text-text-muted">{repo.alias ?? repo.name}</span> : null}
                </Tabs.Trigger>
              ) : null}
              <Tabs.Trigger value="app" className={tabClass}>
                {t("activity.tabApp")}
              </Tabs.Trigger>
            </Tabs.List>
            {/* One panel per tab; the key resets filter, selection and scroll position on switching. */}
            <Tabs.Content value={shownScope} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
              <LogList key={`${shownScope}:${repoId ?? ""}`} scope={shownScope} repoId={shownScope === "repo" ? repoId : null} />
            </Tabs.Content>
          </Tabs.Root>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

const tabClass =
  "-mb-px flex h-control-lg max-w-80 items-center gap-2 border-b-2 border-transparent px-2 text-base font-medium text-text-muted " +
  "hover:text-text data-[state=active]:border-accent data-[state=active]:text-text";

const columns = "flex items-center gap-3 pr-3 pl-2";

function LogList({ scope, repoId }: { scope: ActivityScope; repoId: Id | null }) {
  const activity = useActivity(scope, repoId, PAGE_SIZE);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<Id>>(() => new Set());
  const [activeId, setActiveId] = useState<Id | null>(null);
  const [fresh, setFresh] = useState(0);
  const [, bump] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef<Id | null>(null);
  /** Topmost visible entry before the last data update: the reading position is anchored to it. */
  const anchor = useRef<{ id: Id; index: number } | null>(null);

  const entries = useMemo(() => activity.data?.pages.flatMap((page) => page.entries) ?? [], [activity.data]);
  const needle = query.trim().toLowerCase();
  const filtering = onlyErrors || needle.length > 0;
  const rows = useMemo(
    () =>
      entries.filter((entry) => {
        if (onlyErrors && !failed(entry)) return false;
        if (needle && !entry.command.toLowerCase().includes(needle) && !entry.output.toLowerCase().includes(needle)) return false;
        return true;
      }),
    [entries, onlyErrors, needle],
  );
  const errorCount = useMemo(() => entries.filter(failed).length, [entries]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();

  // Keep the reading position: when new entries arrive at the top, the content moves down by exactly their height.
  // New rows are always collapsed, so their height is known.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const held = anchor.current;
    if (!element || !held) return;
    const index = rows.findIndex((row) => row.id === held.id);
    if (index > held.index && element.scrollTop > 2) {
      const added = index - held.index;
      element.scrollTop += added * ROW_HEIGHT;
      setFresh((count) => count + added);
    }
    if (index >= 0) anchor.current = { id: held.id, index };
    // React only to new data, not to filter changes (those reset the list to the top anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const rememberAnchor = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (element.scrollTop <= 2) setFresh(0);
    const first = virtualizer.getVirtualItems().find((item) => item.end > element.scrollTop);
    const row = first ? rows[first.index] : undefined;
    anchor.current = row && first ? { id: row.id, index: first.index } : null;
  }, [rows, virtualizer]);

  useEffect(() => {
    rememberAnchor();
  }, [rememberAnchor, items.length]);

  // Filter or search changed: back to the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setFresh(0);
  }, [onlyErrors, needle]);

  // Load older entries at the end of the list. With a filter only on button press – otherwise a
  // short result list would gradually load the whole log.
  const last = items[items.length - 1];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = activity;
  useEffect(() => {
    if (filtering || !last || !hasNextPage || isFetchingNextPage) return;
    if (last.index >= rows.length - 8) void fetchNextPage();
  }, [filtering, last, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Focus follows the keyboard, even if the target row still has to be rendered.
  useEffect(() => {
    const id = wantFocus.current;
    if (!id) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-entry-id="${id}"] [data-row]`);
    if (element) {
      element.focus({ preventScroll: true });
      wantFocus.current = null;
    }
  });

  const toggle = (id: Id) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const moveTo = (index: number) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!target) return;
    setActiveId(target.id);
    virtualizer.scrollToIndex(rows.indexOf(target), { align: "auto" });
    const rendered = scrollRef.current?.querySelector<HTMLElement>(`[data-entry-id="${target.id}"] [data-row]`);
    if (rendered) {
      rendered.focus({ preventScroll: true });
      return;
    }
    // Not rendered yet (outside the visible window): focus after the next render.
    wantFocus.current = target.id;
    bump((count) => count + 1);
  };

  const tabStop = rows.some((row) => row.id === activeId) ? activeId : (rows[0]?.id ?? null);
  const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 1);

  const emptyText =
    scope === "repo"
      ? t("activity.empty.repo")
      : t("activity.empty.app");

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1.5 left-2 size-icon text-text-muted" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            aria-label={t("activity.search.label")}
            placeholder={t("activity.search.placeholder")}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                // Clear the search first; the next Esc closes the log (see onEscapeKeyDown on the dialog).
                event.preventDefault();
                setQuery("");
              } else if (event.key === "ArrowDown" && rows.length) {
                event.preventDefault();
                moveTo(0);
              }
            }}
            className={cn(
              "h-control-md w-full rounded-md border border-border-input bg-surface-sunken pr-7 pl-7 text-base text-text",
              "placeholder:text-text-muted hover:border-text-muted focus-visible:border-accent [&::-webkit-search-cancel-button]:hidden",
            )}
          />
          {query ? (
            <button
              type="button"
              aria-label={t("activity.search.clear")}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-sm text-text-muted hover:bg-surface-raised hover:text-text"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
        <Checkbox label={errorCount ? t("activity.onlyErrorsCount", { count: errorCount }) : t("activity.onlyErrors")} checked={onlyErrors} onCheckedChange={setOnlyErrors} />
        <span className="flex-1" />
        <p role="status" data-log-count className="text-sm text-text-muted tabular-nums">
          {activity.isPending
            ? t("activity.count.loading")
            : filtering
              ? t("activity.count.filtered", { shown: rows.length.toLocaleString(locale()), total: entries.length.toLocaleString(locale()) })
              : hasNextPage
                ? t("activity.count.loaded", { count: entries.length })
                : t("activity.count.all", { count: entries.length })}
        </p>
        {activity.isFetching && !activity.isPending ? <Spinner label={t("activity.refreshing")} /> : null}
      </div>

      <div aria-hidden className={cn(columns, "h-row border-y border-border bg-surface-raised text-xs font-semibold tracking-wide text-text-muted uppercase")}>
        <span className="w-4 shrink-0" />
        <span className="w-28 shrink-0">{t("activity.column.time")}</span>
        <span className="min-w-0 flex-1">{t("activity.column.command")}</span>
        <span className="w-20 shrink-0 text-right">{t("activity.column.duration")}</span>
        <span className="w-24 shrink-0">{t("activity.column.exitCode")}</span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {fresh > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
            <Button
              size="sm"
              variant="primary"
              className="pointer-events-auto shadow-pop"
              icon={<ArrowUp className="size-3.5" aria-hidden />}
              onClick={() => {
                scrollRef.current?.scrollTo({ top: 0 });
                setFresh(0);
              }}
            >
              {t("activity.fresh", { count: fresh })}
            </Button>
          </div>
        ) : null}

        {activity.isPending ? (
          <div role="status" aria-label={t("activity.loading")} className="animate-pulse overflow-hidden">
            {Array.from({ length: 14 }, (_, index) => (
              <div key={index} className={cn(columns, "h-7 border-b border-border")}>
                <span className="w-4 shrink-0" />
                <span className="h-3 w-20 shrink-0 rounded-sm bg-surface-raised" />
                <span className="w-8 shrink-0" />
                <span className={cn("h-3 rounded-sm bg-surface-raised", index % 3 === 0 ? "w-96" : index % 3 === 1 ? "w-64" : "w-80")} />
              </div>
            ))}
          </div>
        ) : activity.isError ? (
          <div role="alert" data-state="error" className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <TriangleAlert className="size-6 text-danger" aria-hidden />
            <p className="text-md font-medium text-text">{t("activity.loadFailed")}</p>
            <p className="selectable max-w-120 text-base text-text-muted">{describeError(activity.error).text}</p>
            <Button className="mt-2" icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void activity.refetch()}>
              {t("activity.retry")}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div data-state={filtering ? "no-match" : "empty"} className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            {filtering ? <SearchX className="size-6 text-text-muted" aria-hidden /> : <ScrollText className="size-6 text-text-muted" aria-hidden />}
            <p className="text-md font-medium text-text">{filtering ? t("activity.noMatch.title") : t("activity.empty.title")}</p>
            <p className="max-w-96 text-base text-text-muted">
              {filtering
                ? needle && onlyErrors
                  ? t("activity.noMatch.both", { count: entries.length })
                  : needle
                    ? t("activity.noMatch.search", { count: entries.length })
                    : t("activity.noMatch.errors", { count: entries.length })
                : emptyText}
            </p>
            {filtering ? (
              <div className="mt-2 flex gap-2">
                <Button
                  onClick={() => {
                    setQuery("");
                    setOnlyErrors(false);
                  }}
                >
                  {t("activity.resetFilter")}
                </Button>
                {hasNextPage ? (
                  <Button loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                    {t("activity.loadOlder")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div ref={scrollRef} data-log-scroll onScroll={rememberAnchor} className="min-h-0 flex-1 overflow-y-auto">
            <ul aria-label={scope === "repo" ? t("activity.listRepo") : t("activity.listApp")} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((item) => {
                const entry = rows[item.index];
                if (!entry) return null;
                return (
                  <li
                    key={entry.id}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    data-entry-id={entry.id}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <LogRow
                      entry={entry}
                      open={expanded.has(entry.id)}
                      tabStop={entry.id === tabStop}
                      onToggle={() => toggle(entry.id)}
                      onFocus={() => setActiveId(entry.id)}
                      onMove={(delta) => moveTo(item.index + delta)}
                      onJump={(where) => moveTo(where === "start" ? 0 : rows.length - 1)}
                      pageRows={pageRows}
                    />
                  </li>
                );
              })}
            </ul>
            <div className="flex h-10 items-center justify-center gap-2 text-sm text-text-muted" data-log-end>
              {isFetchingNextPage ? (
                <>
                  <Spinner label={t("activity.loadingOlder")} />
                  {t("activity.loadingOlderText")}
                </>
              ) : hasNextPage ? (
                <Button size="sm" variant="ghost" onClick={() => void fetchNextPage()}>
                  {t("activity.loadOlder")}
                </Button>
              ) : (
                t("activity.start")
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

interface LogRowProps {
  entry: ActivityEntry;
  open: boolean;
  tabStop: boolean;
  onToggle: () => void;
  onFocus: () => void;
  onMove: (delta: number) => void;
  onJump: (where: "start" | "end") => void;
  pageRows: number;
}

function LogRow({ entry, open, tabStop, onToggle, onFocus, onMove, onJump, pageRows }: LogRowProps) {
  const isError = failed(entry);
  const panelId = `log-output-${entry.id}`;
  const started = new Date(entry.startedAt);
  const output = entry.output.replace(/\s+$/, "");

  return (
    <div className={cn(open && "bg-surface")}>
      <ContextMenu
        entries={[
          { label: open ? t("activity.row.collapse") : t("activity.row.expand"), onSelect: onToggle },
          { type: "separator" },
          { label: t("activity.row.copyCommand"), icon: <Copy className="size-icon" />, onSelect: () => void copy(entry.command, t("activity.copy.command")) },
          { label: t("activity.row.copyOutput"), icon: <Copy className="size-icon" />, disabled: !output, onSelect: () => void copy(output, t("activity.copy.output")) },
        ]}
      >
        <div
          data-row
          role="button"
          tabIndex={tabStop ? 0 : -1}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`${formatLogTime(entry.startedAt)}, ${entry.command}, ${formatDuration(entry.durationMs)}, ${
            entry.exitCode === null ? t("activity.row.noExit") : isError ? t("activity.row.failed", { code: entry.exitCode }) : t("activity.row.success")
          }`}
          onFocus={onFocus}
          onClick={() => {
            // Someone who has just selected text does not want to expand or collapse.
            if (window.getSelection()?.toString()) return;
            onToggle();
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const keys: Record<string, () => void> = {
              Enter: onToggle,
              " ": onToggle,
              ArrowDown: () => onMove(1),
              ArrowUp: () => onMove(-1),
              PageDown: () => onMove(pageRows),
              PageUp: () => onMove(-pageRows),
              Home: () => onJump("start"),
              End: () => onJump("end"),
              ArrowRight: () => {
                if (!open) onToggle();
              },
              ArrowLeft: () => {
                if (open) onToggle();
              },
            };
            const action = keys[event.key];
            if (action && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault();
              action();
            }
          }}
          className={cn(columns, "h-7 cursor-default border-b border-border -outline-offset-2 hover:bg-surface-raised", isError && "bg-danger-surface/40")}
        >
          <ChevronRight className={cn("size-4 shrink-0 text-text-muted transition-transform", open && "rotate-90")} aria-hidden />
          <time dateTime={entry.startedAt} title={Number.isNaN(started.getTime()) ? entry.startedAt : fullTime.format(started)} className="w-28 shrink-0 text-sm text-text-muted tabular-nums">
            {formatLogTime(entry.startedAt)}
          </time>
          <span className="selectable min-w-0 flex-1 truncate font-mono text-code text-text" title={entry.command}>
            {entry.command}
          </span>
          <span className="w-20 shrink-0 text-right text-sm text-text-muted tabular-nums">{formatDuration(entry.durationMs)}</span>
          <span className="flex w-24 shrink-0">
            <ExitBadge code={entry.exitCode} />
          </span>
        </div>
      </ContextMenu>
      {open ? (
        <div id={panelId} role="region" aria-label={t("activity.row.output", { command: entry.command })} className="border-b border-border pt-2 pr-3 pb-3 pl-9">
          <p className="selectable font-mono text-code break-all text-text">{entry.command}</p>
          <pre
            tabIndex={0}
            className={cn(
              "selectable mt-2 max-h-64 overflow-auto rounded-md border border-border bg-surface-sunken p-2 font-mono text-code break-words whitespace-pre-wrap",
              output ? "text-text" : "text-text-muted",
            )}
          >
            {output || t("activity.row.noOutput")}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" icon={<Copy className="size-3.5" aria-hidden />} onClick={() => void copy(entry.command, t("activity.copy.command"))}>
              {t("activity.row.copyCommand")}
            </Button>
            <Button size="sm" icon={<Copy className="size-3.5" aria-hidden />} disabled={!output} onClick={() => void copy(output, t("activity.copy.output"))}>
              {t("activity.row.copyOutput")}
            </Button>
            <span className="flex-1" />
            <span className="text-sm text-text-muted">{Number.isNaN(started.getTime()) ? entry.startedAt : fullTime.format(started)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
