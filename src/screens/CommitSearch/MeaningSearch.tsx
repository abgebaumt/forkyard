/**
 * Commit search by meaning (v1.2, spec 9.2). The question runs on Enter – not while typing, every run
 * is an AI request. The core picks the way (local embeddings, the main provider's embeddings, or
 * rephrasing into a Git search) and returns the hits with a reason each. Keys as in the text search:
 *   ↓/↑ marker · Enter search, or jump if the question was searched · Shift+Enter previous ·
 *   F3/Shift+F3 next/previous · Esc cancel a running search, otherwise close.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Search, SearchX, X } from "lucide-react";
import type { AiProviderKind } from "../../core";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { errorView, loadingView, type AiErrorView } from "../../app/ai/requestState";
import { openAiSettings, openAiSetup } from "../../app/ai/open";
import { formatDate, formatDateTime, shortSha } from "../../app/format";
import { useAiSemanticStatus, useAiStatus, useSettings } from "../../app/queries";
import { useAppStore, useTabView } from "../../app/store";
import { Button, IconButton, Spinner } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/Feedback";
import { locale, t } from "../../i18n";
import { enterAction, hitReason, routeNote, searchedFor } from "./meaningModel";
import type { SearchPartProps } from "./types";
import { useMeaningSearch } from "./useMeaningSearch";

/** The core cuts questions to this length. */
const MAX_QUESTION = 500;
/** The index takes the newest this many commits. */
const MAX_INDEXED = 200_000;

function ErrorActions({ kind, provider, onRetry, onShowSent }: { kind: AiErrorView["kind"]; provider: AiProviderKind | null; onRetry: () => void; onShowSent: () => void }) {
  if (kind === "setup") {
    return (
      <Button size="sm" onClick={() => void openAiSetup()}>
        {t("commitSearch.meaning.openSetup")}
      </Button>
    );
  }
  if (kind === "notLoggedIn" && provider) {
    // 1b: runs the tool's sign-in in the built-in terminal; then "Try again".
    return (
      <>
        <Button size="sm" onClick={() => void signInInTerminal(provider)}>
          {t("ai.setup.cli.signIn")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          {t("commitSearch.meaning.retry")}
        </Button>
      </>
    );
  }
  if (kind === "limit") {
    return (
      <>
        <Button size="sm" onClick={onRetry}>
          {t("commitSearch.meaning.sendAnyway")}
        </Button>
        <Button size="sm" variant="ghost" onClick={openAiSettings}>
          {t("commitSearch.meaning.changeLimit")}
        </Button>
      </>
    );
  }
  if (kind === "invalid") {
    return (
      <>
        <Button size="sm" onClick={onRetry}>
          {t("commitSearch.meaning.retry")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onShowSent}>
          {t("commitSearch.meaning.showSent")}
        </Button>
      </>
    );
  }
  return (
    <Button size="sm" onClick={onRetry}>
      {t("commitSearch.meaning.retry")}
    </Button>
  );
}

export function MeaningSearch({ repoId, tabId, text, setText, modeSwitch }: SearchPartProps) {
  const view = useTabView(tabId);
  const store = useAppStore.getState;
  const { data: settings } = useSettings();
  const { data: aiStatus } = useAiStatus();
  const { data: status } = useAiSemanticStatus(repoId);
  const meaning = useMeaningSearch(repoId);
  const progress = useAppStore((state) => (meaning.jobId ? state.jobs[meaning.jobId] : undefined));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [cursor, setCursor] = useState(-1);
  const [now, setNow] = useState(() => Date.now());

  const result = meaning.result;
  const hits = result?.hits ?? [];
  const active = view.search.active >= 0 && view.search.active < hits.length ? view.search.active : -1;

  // Seconds counter while a search runs (from 3 s, see loadingView).
  useEffect(() => {
    if (!meaning.running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [meaning.running]);

  // Hits into the store: the graph highlights them, Enter and F3 jump through them.
  useEffect(() => {
    const shas = result?.hits.map((hit) => hit.commit.sha) ?? [];
    useAppStore.getState().setSearch(tabId, { query: result ? (meaning.submitted ?? "") : "", hits: shas, active: -1 });
    setCursor(shas.length > 0 ? 0 : -1);
  }, [tabId, result, meaning.submitted]);

  useEffect(() => {
    if (cursor >= 0) listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const close = () => {
    meaning.cancel();
    store().setSearchOpen(tabId, false);
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
    if (state.views[tabId]?.center.kind !== "graph") state.closeCenter(tabId);
    state.revealCommit(tabId, hit.commit.sha);
  };

  const step = (delta: 1 | -1) => {
    const count = hits.length;
    if (count === 0) return;
    const from = active >= 0 ? active : delta > 0 ? -1 : 0;
    jump((from + delta + count) % count);
  };

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

  const retry = () => {
    if (meaning.submitted) void meaning.run(meaning.submitted);
    // The button disappears with the error; the focus then belongs in the search field again.
    inputRef.current?.focus();
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (meaning.running) meaning.cancel();
      else close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        step(-1);
        return;
      }
      const action = enterAction(text, meaning.submitted, meaning.running);
      if (action === "run") void meaning.run(text.trim());
      else if (action === "jump") {
        if (cursor >= 0 && cursor !== active) jump(cursor);
        else step(1);
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (hits.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCursor((current) => Math.max(0, Math.min(hits.length - 1, (current < 0 ? (delta > 0 ? -1 : hits.length) : current) + delta)));
    }
  };

  const loading = meaning.running ? loadingView(now - (meaning.startedAt ?? now), status?.local ?? aiStatus?.local ?? false, t("commitSearch.meaning.searching")) : null;
  const indexing = progress?.phase === "index" && progress.line ? t("commitSearch.meaning.indexing", { progress: progress.line }) : null;
  const failure = meaning.error ? errorView(meaning.error) : null;
  const total = hits.length.toLocaleString(locale());
  const counter =
    !result || meaning.running
      ? ""
      : hits.length === 0
        ? t("commitSearch.counter.none")
        : active >= 0
          ? t("commitSearch.counter.position", { position: active + 1, total })
          : t("commitSearch.counter.total", { total, count: hits.length });
  const searched = result ? searchedFor(result) : null;
  const note = routeNote(status);
  const showList = hits.length > 0;
  const dateFormat = settings?.dateFormat ?? "relative";

  return (
    <div role="search" aria-label={t("commitSearch.label")} data-screen="commit-search" data-mode="meaning" className="@container flex shrink-0 flex-col border-b border-border bg-surface text-base">
      <div className="flex h-control-lg items-center gap-1 px-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-text-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            autoFocus
            value={text}
            maxLength={MAX_QUESTION}
            spellCheck={false}
            autoComplete="off"
            aria-label={t("commitSearch.input")}
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && cursor >= 0 ? `${listId}-${cursor}` : undefined}
            placeholder={t("commitSearch.meaning.placeholder")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onInputKey}
            className={cn(
              "h-control-sm w-full rounded-md border border-border-input bg-surface-sunken pr-8 pl-7 text-base text-text",
              "placeholder:text-text-muted hover:border-text-muted focus-visible:border-accent",
            )}
          />
          {meaning.running ? (
            <span className="absolute right-2 flex items-center">
              <Spinner label={t("commitSearch.meaning.searching")} />
            </span>
          ) : null}
        </div>
        {modeSwitch}
        <span role="status" data-testid="search-counter" className="min-w-16 shrink-0 px-1 text-right text-sm text-text-muted tabular-nums">
          {counter}
        </span>
        <IconButton size="sm" label={t("commitSearch.previous")} shortcut="Shift+F3" disabled={hits.length === 0} icon={<ChevronUp className="size-icon" aria-hidden />} onClick={() => step(-1)} />
        <IconButton size="sm" label={t("commitSearch.next")} shortcut="F3" disabled={hits.length === 0} icon={<ChevronDown className="size-icon" aria-hidden />} onClick={() => step(1)} />
        <IconButton size="sm" label={t("commitSearch.close")} shortcut="Esc" icon={<X className="size-icon" aria-hidden />} onClick={close} />
      </div>

      {failure && failure.kind !== "cancelled" ? (
        <div data-testid="meaning-error">
          <Banner tone="danger" title={t("commitSearch.meaning.failed")} actions={<ErrorActions kind={failure.kind} provider={aiStatus?.provider ?? null} onRetry={retry} onShowSent={() => void meaning.showSent(meaning.submitted ?? text.trim())} />}>
            <span className="selectable">{failure.text}</span>
          </Banner>
        </div>
      ) : meaning.running ? (
        <div role="status" aria-live="polite" data-testid="meaning-loading" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pb-1.5 text-sm text-text-muted">
          <span>{loading?.text}</span>
          {indexing ? <span>{indexing}</span> : null}
          {loading?.slow ? <span>{loading.slow}</span> : null}
          <Button size="sm" variant="ghost" onClick={meaning.cancel}>
            {t("commitSearch.meaning.cancel")}
          </Button>
        </div>
      ) : !result ? (
        <div data-testid="meaning-hint" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pb-1.5 text-sm text-text-muted">
          <span>{t("commitSearch.meaning.hint")}</span>
          {note ? <span>{note}</span> : null}
          <Button size="sm" variant="ghost" data-ai-what-is-sent disabled={!text.trim()} onClick={() => void meaning.showSent(text.trim())}>
            {t("commitSearch.meaning.whatIsSent")}
          </Button>
        </div>
      ) : (
        <>
          {searched || result.ignored.length > 0 || !result.ranked || result.capped ? (
            <div data-testid="meaning-notes" className="flex flex-col gap-0.5 px-3 pb-1 text-sm text-text-muted">
              {searched ? <p data-searched-for>{searched}</p> : null}
              {result.ignored.length > 0 ? <p>{t("commitSearch.meaning.ignored", { items: result.ignored.join(", ") })}</p> : null}
              {!result.ranked ? <p>{t("commitSearch.meaning.unranked")}</p> : null}
              {result.capped ? <p>{t("commitSearch.meaning.capped", { limit: MAX_INDEXED.toLocaleString(locale()) })}</p> : null}
            </div>
          ) : null}
          {hits.length === 0 ? (
            <p data-testid="search-empty" className="flex items-start gap-2 px-3 pb-2 text-sm text-text-muted">
              <SearchX className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 wrap-anywhere">{t("commitSearch.meaning.empty", { query: meaning.submitted ?? "" })}</span>
            </p>
          ) : (
            <div ref={listRef} id={listId} role="listbox" aria-label={t("commitSearch.hits")} className="max-h-48 overflow-x-hidden overflow-y-auto pb-1">
              {hits.map((hit, index) => {
                const isCursor = index === cursor;
                const isActive = index === active;
                return (
                  <div
                    key={hit.commit.sha}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={isCursor}
                    aria-current={isActive ? "true" : undefined}
                    data-index={index}
                    data-sha={hit.commit.sha}
                    title={`${hit.commit.summary}\n${hit.commit.author.name} <${hit.commit.author.email}> · ${formatDateTime(hit.commit.authoredAt)}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => jump(index)}
                    className={cn("flex items-start gap-3 py-0.5 pr-3 pl-1", isCursor ? "bg-accent-surface" : "hover:bg-surface-raised")}
                  >
                    <span className="flex size-icon shrink-0 items-center justify-center text-accent">
                      {isActive ? <ChevronRight className="size-3.5" strokeWidth={3} aria-hidden /> : null}
                      {isActive ? <span className="sr-only">{t("commitSearch.current")}</span> : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("truncate", isActive && "font-medium")}>{hit.commit.summary || t("commitSearch.noMessage")}</span>
                      <span data-reason className="truncate text-sm text-text-muted">
                        {hitReason(hit)}
                      </span>
                    </span>
                    <span className="hidden w-36 shrink-0 truncate text-sm text-text-muted @xl:block">{hit.commit.author.name}</span>
                    <span className="hidden w-28 shrink-0 truncate text-right text-sm text-text-muted @md:block">{formatDate(hit.commit.authoredAt, dateFormat)}</span>
                    <code className="w-14 shrink-0 font-mono text-code text-text-muted">{shortSha(hit.commit.sha)}</code>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
