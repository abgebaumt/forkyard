/**
 * Commit search: bar above the middle. Searches debounced in message, author and SHA over the
 * whole history (not just the loaded graph rows), shows the matches as a list and writes them to
 * the store so that the graph highlights them.
 *
 * Usage (focus stays in the search field, combobox pattern):
 *   Arrow down/up       move the marker in the result list
 *   Enter               jump to the marked match; if already there: to the next one
 *   Shift+Enter         to the previous match
 *   F3 / Shift+F3       next / previous match – also when the focus is in the graph
 *   Esc                 close the search, clear the highlighting in the graph
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Search, SearchX, X } from "lucide-react";
import type { CommitSummary, Id } from "../../core";
import { describeError, toCoreError } from "../../app/errors";
import { formatDate, formatDateTime, shortSha } from "../../app/format";
import { useCommitSearch, useSettings } from "../../app/queries";
import { parseSearchQuery } from "../../app/searchFilters";
import { useAppStore, useTabView } from "../../app/store";
import { Button, IconButton, Spinner } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/Feedback";
import { Kbd } from "../../ui/Kbd";
import { highlightParts, shaMatchLength } from "./highlight";
import { Trans } from "react-i18next";
import { locale, t } from "../../i18n";

export interface CommitSearchProps {
  repoId: Id;
  tabId: Id;
}

/** The list shows this many matches; one more is requested to detect “there are more”. */
export const SEARCH_LIMIT = 200;
const DEBOUNCE_MS = 200;
/** The core truncates search texts to this length. */
const MAX_QUERY = 500;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function Marked({ text, needle }: { text: string; needle: string }): ReactNode {
  return highlightParts(text, needle).map((part, index) =>
    part.match ? (
      <mark key={index} className="rounded-sm bg-warning-surface font-semibold text-text underline decoration-warning underline-offset-2">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

export function CommitSearch({ repoId, tabId }: CommitSearchProps) {
  const view = useTabView(tabId);
  const store = useAppStore.getState;
  const { data: settings } = useSettings();
  const [text, setText] = useState(view.search.query);
  const query = useDebounced(text.trim(), DEBOUNCE_MS);
  const search = useCommitSearch(repoId, query, SEARCH_LIMIT + 1);
  /** What is highlighted: the search text without the filters. */
  const needle = parseSearchQuery(query).query;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  /** Marker in the list (arrow keys); the active match (that was jumped to) is in the store. */
  const [cursor, setCursor] = useState(view.search.active);

  const found = search.data;
  const hits: CommitSummary[] = query && found ? found.slice(0, SEARCH_LIMIT) : [];
  const overLimit = Boolean(query && found && found.length > SEARCH_LIMIT);
  const active = view.search.active >= 0 && view.search.active < hits.length ? view.search.active : -1;
  const typing = text.trim() !== query;
  const error = query && search.isError ? toCoreError(search.error) : null;
  // Another search in the same repository (e.g. from the command palette) cancels this one in the core.
  const interrupted = error?.code === "cancelled";
  const loading = Boolean(text.trim()) && (typing || (search.isFetching && !found) || interrupted);

  // Matches into the store: the graph highlights them. The active match stays as long as the list is the same.
  useEffect(() => {
    const state = useAppStore.getState();
    const current = state.views[tabId]?.search;
    if (!query) {
      if (current && (current.query || current.hits.length || current.active !== -1)) state.setSearch(tabId, { query: "", hits: [], active: -1 });
      setCursor(-1);
      return;
    }
    if (search.isError) {
      state.setSearch(tabId, { query, hits: [], active: -1 });
      setCursor(-1);
      return;
    }
    if (!found) return;
    const shas = found.slice(0, SEARCH_LIMIT).map((hit) => hit.sha);
    const same = current !== undefined && current.query === query && current.hits.length === shas.length && current.hits.every((sha, index) => sha === shas[index]);
    if (same) return;
    state.setSearch(tabId, { query, hits: shas, active: -1 });
    setCursor(shas.length > 0 ? 0 : -1);
  }, [tabId, query, found, search.isError]);

  // Restart a cancelled search once.
  const retried = useRef<string | null>(null);
  const refetch = search.refetch;
  useEffect(() => {
    if (interrupted && retried.current !== query) {
      retried.current = query;
      void refetch();
    }
  }, [interrupted, query, refetch]);

  useEffect(() => {
    if (cursor >= 0) listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const close = () => {
    store().setSearchOpen(tabId, false);
    // The focus should not fall into nowhere: back to the middle (graph), if something is focusable there.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-area="center"] [role="grid"], [data-area="center"] [tabindex="0"]')?.focus();
    });
  };

  const jump = (index: number) => {
    const hit = hits[index];
    if (!hit) return;
    setCursor(index);
    const state = store();
    state.setSearch(tabId, { active: index });
    // From a file view back to the graph, otherwise the jump would not be visible.
    if (state.views[tabId]?.center.kind !== "graph") state.closeCenter(tabId);
    state.revealCommit(tabId, hit.sha);
  };

  const step = (delta: 1 | -1) => {
    const count = hits.length;
    if (count === 0) return;
    const from = active >= 0 ? active : delta > 0 ? -1 : 0;
    jump((from + delta + count) % count);
  };

  // F3 and Ctrl+F apply as long as the bar is open – also with the focus in the graph.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "F3" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        stepRef.current(event.shiftKey ? -1 : 1);
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) step(-1);
      else if (cursor >= 0 && cursor !== active) jump(cursor);
      else step(1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (hits.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCursor((current) => Math.max(0, Math.min(hits.length - 1, (current < 0 ? (delta > 0 ? -1 : hits.length) : current) + delta)));
    }
  };

  const total = `${hits.length.toLocaleString(locale())}${overLimit ? "+" : ""}`;
  const counter =
    !query || loading || error
      ? ""
      : hits.length === 0
        ? t("commitSearch.counter.none")
        : active >= 0
          ? t("commitSearch.counter.position", { position: active + 1, total })
          : t("commitSearch.counter.total", { total, count: hits.length });
  const showList = hits.length > 0 && !error;
  const dateFormat = settings?.dateFormat ?? "relative";

  return (
    <div role="search" aria-label={t("commitSearch.label")} data-screen="commit-search" className="@container flex shrink-0 flex-col border-b border-border bg-surface text-base">
      <div className="flex h-control-lg items-center gap-1 px-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-text-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            autoFocus
            value={text}
            maxLength={MAX_QUERY}
            spellCheck={false}
            autoComplete="off"
            aria-label={t("commitSearch.input")}
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && cursor >= 0 ? `${listId}-${cursor}` : undefined}
            placeholder={t("commitSearch.placeholder")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onInputKey}
            className={cn(
              "h-control-sm w-full rounded-md border border-border-input bg-surface-sunken pr-8 pl-7 text-base text-text",
              "placeholder:text-text-muted hover:border-text-muted focus-visible:border-accent",
            )}
          />
          {loading ? (
            <span className="absolute right-2 flex items-center">
              <Spinner label={t("commitSearch.searching")} />
            </span>
          ) : null}
        </div>
        <span role="status" data-testid="search-counter" className="min-w-16 shrink-0 px-1 text-right text-sm text-text-muted tabular-nums">
          {counter}
        </span>
        <IconButton size="sm" label={t("commitSearch.previous")} shortcut="Shift+F3" disabled={hits.length === 0} icon={<ChevronUp className="size-icon" aria-hidden />} onClick={() => step(-1)} />
        <IconButton size="sm" label={t("commitSearch.next")} shortcut="F3" disabled={hits.length === 0} icon={<ChevronDown className="size-icon" aria-hidden />} onClick={() => step(1)} />
        <IconButton size="sm" label={t("commitSearch.close")} shortcut="Esc" icon={<X className="size-icon" aria-hidden />} onClick={close} />
      </div>

      {!text.trim() ? (
        <p data-testid="search-hint" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pb-1.5 text-sm text-text-muted">
          <span>{t("commitSearch.hint")}</span>
          <span>{t("commitSearch.filtersHint")}</span>
          <span className="hidden items-center gap-1 @2xl:inline-flex">
            <Trans i18nKey="commitSearch.keys" components={{ enter: <Kbd>Enter</Kbd>, shift: <Kbd>Shift+Enter</Kbd>, esc: <Kbd>Esc</Kbd> }} />
          </span>
        </p>
      ) : error && !interrupted ? (
        <div data-testid="search-error">
          <Banner
            tone="danger"
            title={t("commitSearch.failed")}
            actions={
              <Button
                size="sm"
                onClick={() => {
                  void search.refetch();
                  // The button disappears with the error; the focus then belongs in the search field again.
                  inputRef.current?.focus();
                }}
              >
                {t("commitSearch.retry")}
              </Button>
            }
          >
            <span className="selectable">{describeError(error).text}</span>
          </Banner>
        </div>
      ) : loading && hits.length === 0 ? (
        <div role="status" aria-label={t("commitSearch.searching")} data-testid="search-loading" className="flex flex-col pb-1">
          {["w-1/2", "w-2/3", "w-2/5"].map((width) => (
            <div key={width} className="flex h-row items-center gap-3 px-3">
              <span aria-hidden className={cn("block h-3 animate-pulse rounded-sm bg-surface-raised", width)} />
              <span className="flex-1" />
              <span aria-hidden className="block h-3 w-14 animate-pulse rounded-sm bg-surface-raised" />
            </div>
          ))}
        </div>
      ) : hits.length === 0 ? (
        <p data-testid="search-empty" className="flex items-start gap-2 px-3 pb-2 text-sm text-text-muted">
          <SearchX className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 wrap-anywhere">
            {t("commitSearch.empty", { query })}
          </span>
        </p>
      ) : (
        <>
          <div ref={listRef} id={listId} role="listbox" aria-label={t("commitSearch.hits")} className={cn("max-h-48 overflow-x-hidden overflow-y-auto pb-1", loading && "opacity-60")}>
            {hits.map((hit, index) => {
              const isCursor = index === cursor;
              const isActive = index === active;
              const shaLength = shaMatchLength(hit.sha, needle);
              const short = shortSha(hit.sha);
              return (
                <div
                  key={hit.sha}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={isCursor}
                  aria-current={isActive ? "true" : undefined}
                  data-index={index}
                  data-sha={hit.sha}
                  title={`${hit.summary}\n${hit.author.name} <${hit.author.email}> · ${formatDateTime(hit.authoredAt)}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => jump(index)}
                  className={cn("flex h-row items-center gap-3 pr-3 pl-1", isCursor ? "bg-accent-surface" : "hover:bg-surface-raised")}
                >
                  <span className="flex size-icon shrink-0 items-center justify-center text-accent">
                    {isActive ? <ChevronRight className="size-3.5" strokeWidth={3} aria-hidden /> : null}
                    {isActive ? <span className="sr-only">{t("commitSearch.current")}</span> : null}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", isActive && "font-medium")}>
                    <Marked text={hit.summary || t("commitSearch.noMessage")} needle={needle} />
                  </span>
                  <span className="hidden w-36 shrink-0 truncate text-sm text-text-muted @xl:block">
                    <Marked text={hit.author.name} needle={needle} />
                  </span>
                  <span className="hidden w-28 shrink-0 truncate text-right text-sm text-text-muted @md:block">{formatDate(hit.authoredAt, dateFormat)}</span>
                  <code className="w-14 shrink-0 font-mono text-code text-text-muted">
                    {shaLength > 0 ? <Marked text={short} needle={short.slice(0, shaLength)} /> : short}
                  </code>
                </div>
              );
            })}
          </div>
          {overLimit ? (
            <p data-testid="search-limit" className="border-t border-border px-3 py-1 text-sm text-text-muted">
              {t("commitSearch.limit", { limit: SEARCH_LIMIT })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
