/**
 * Terminal below the view: a shell in the repository's folder, a separate one per tab.
 *
 * The panel only displays; the session itself (xterm.js, connection to the core) lives in
 * sessions.ts and survives tab switches and hiding.
 *
 * Keyboard: in the terminal every key belongs to the shell – Tab too. Ways out are F6 / Shift+F6
 * (next / previous region), Alt+1/2/3 (left panel, view, commit panel) and Ctrl+` (hide); the way
 * in is Alt+4. Copy Ctrl+Shift+C, paste Ctrl+Shift+V; Ctrl+C stays the interrupt signal.
 * Registered in src/screens/Shortcuts/fixedKeys.ts.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, CircleStop, ClipboardPaste, Copy, Eraser, ExternalLink, Plus, RotateCw, SquareTerminal, TextSelect, Trash2, X } from "lucide-react";
import type { Id } from "../../core";
import { copyText } from "../../app/actions/clipboard";
import { openExternal } from "../../app/actions/files";
import { matchesShortcut } from "../../app/commandTypes";
import { openMenuAt } from "../../app/menus/host";
import { useAppInfo, useRepo } from "../../app/queries";
import { getCommands } from "../../app/registry";
import { useCodeSettings } from "../../components/code/settings";
import { Button, IconButton, Spinner } from "../../ui/Button";
import { Banner, toast } from "../../ui/Feedback";
import { formatShortcut } from "../../ui/Kbd";
import type { MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { clearTerminal, closeTerminalSession, endTerminal, hideTerminal, newTerminalShell, restartTerminal } from "./actions";
import { onTerminalFocusRequest, takeTerminalFocus } from "./control";
import { HeightHandle } from "./HeightHandle";
import { TERMINAL_HEIGHT, maxTerminalHeight, setTerminalHeight, shownTerminalHeight, useTerminalHeight } from "./height";
import {
  acquireSession,
  selectSession,
  sessionByKey,
  setTerminalCopier,
  setTerminalFont,
  setTerminalMenuOpener,
  setTerminalPassthrough,
  subscribeTerminalTabs,
  terminalTabs,
  type Session,
  type TerminalStatus,
  TERMINAL_HINT_ID,
} from "./sessions";
import { useAgentSessionWaiting } from "../Agents/session";
import { STATE_TONE, neighbour, sessionState, type StatusTone, type TabEntry, type TerminalTabs } from "./tabsModel";
import { t } from "../../i18n";

export interface TerminalPanelProps {
  repoId: Id;
  tabId: Id;
}

/** App commands that also apply from within the terminal: leave the region, toggle terminal and tab. */
const LEAVE_COMMANDS = new Set([
  "focus.next",
  "focus.previous",
  "focus.leftPanel",
  "focus.center",
  "focus.commitPanel",
  "terminal.focus",
  "view.terminal",
  "tab.next",
  "tab.previous",
]);

function isLeaveShortcut(event: KeyboardEvent, mac: boolean): boolean {
  for (const command of getCommands()) {
    if (!LEAVE_COMMANDS.has(command.id)) continue;
    for (const shortcut of [command.shortcut, ...(command.aliases ?? [])]) {
      if (shortcut && matchesShortcut(event, shortcut, mac)) return true;
    }
  }
  return false;
}

const isLive = (status: TerminalStatus) => status.kind === "starting" || status.kind === "running";

async function pasteFromClipboard(session: Session): Promise<void> {
  try {
    session.paste(await navigator.clipboard.readText());
  } catch {
    toast({
      tone: "warning",
      title: t("terminal.clipboardFailed"),
      description: t("terminal.clipboardHint", { shortcut: formatShortcut("Mod+Shift+V") }),
    });
  }
  session.focus();
}

function terminalMenu(session: Session): MenuEntry[] {
  const status = session.getStatus();
  const live = isLive(status);
  const selected = session.selection().length > 0;
  const icon = "size-icon";
  return [
    {
      label: t("terminal.menu.copy"),
      icon: <Copy className={icon} aria-hidden />,
      shortcut: "Mod+Shift+C",
      disabled: !selected,
      hint: selected ? undefined : t("terminal.menu.nothingSelected"),
      onSelect: () => void session.copySelection(),
    },
    {
      label: t("terminal.menu.paste"),
      icon: <ClipboardPaste className={icon} aria-hidden />,
      shortcut: "Mod+Shift+V",
      disabled: !live,
      hint: live ? undefined : t("terminal.menu.shellEnded"),
      onSelect: () => void pasteFromClipboard(session),
    },
    { label: t("terminal.menu.selectAll"), icon: <TextSelect className={icon} aria-hidden />, onSelect: () => session.selectAll() },
    { type: "separator" },
    { label: t("terminal.menu.clear"), icon: <Eraser className={icon} aria-hidden />, hint: t("terminal.menu.clearHint"), onSelect: () => session.clear() },
    { label: live ? t("terminal.menu.restartAsk") : t("terminal.menu.restart"), icon: <RotateCw className={icon} aria-hidden />, onSelect: () => void restartTerminal(session.tabId) },
    { type: "separator" },
    { label: live ? t("terminal.menu.endAsk") : t("terminal.menu.end"), icon: <Trash2 className={icon} aria-hidden />, danger: true, onSelect: () => void endTerminal(session.tabId) },
  ];
}

// Once: how the terminal copies and opens its menu (the sessions know neither menus nor toasts).
setTerminalCopier((text) => void copyText(text, t("terminal.copySelection")));
setTerminalMenuOpener((session, point) => {
  const rect = session.host.getBoundingClientRect();
  openMenuAt(point ?? { x: rect.left + rect.width / 3, y: rect.top + rect.height / 3 }, terminalMenu(session), t("terminal.title"));
});

function exitText(code: number | null): string {
  if (code === null) return t("terminal.exit.unknown");
  return code === 0 ? t("terminal.exit.ok") : t("terminal.exit.error", { code });
}

function failureTitle(status: Extract<TerminalStatus, { kind: "failed" }>): string {
  if (status.code === "path_not_found") return t("terminal.failure.pathNotFound");
  if (status.code === "not_allowed") return t("terminal.failure.notAllowed");
  return t("terminal.failure.other");
}

const DOT: Record<StatusTone, string> = { accent: "bg-accent", warning: "bg-warning", success: "bg-success", danger: "bg-danger", muted: "bg-text-muted" };
const STARTING: TerminalStatus = { kind: "starting" };
const noSubscribe = () => () => undefined;

function SessionTab({ tabId, entry, active, onArrow }: { tabId: Id; entry: TabEntry; active: boolean; onArrow: (key: Id, delta: number) => void }) {
  const session = sessionByKey(tabId, entry.key);
  const status = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getStatus ?? (() => STARTING));
  const waiting = useAgentSessionWaiting(entry.key);
  const state = sessionState(entry.kind, status, waiting);
  return (
    <div data-terminal-tab={entry.key} data-active={active ? "true" : undefined} data-state={state} className={`flex shrink-0 items-center rounded-sm ${active ? "bg-surface-sunken" : ""}`}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        data-action="select-session"
        className="flex h-control-sm items-center gap-1.5 rounded-sm px-2 text-sm text-text"
        onClick={() => selectSession(tabId, entry.key)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          onArrow(entry.key, event.key === "ArrowRight" ? 1 : -1);
        }}
      >
        <span className={`inline-flex size-1.5 shrink-0 rounded-full ${DOT[STATE_TONE[state]]}`} aria-hidden />
        <span className="max-w-40 truncate">{entry.title}</span>
        <span className="text-xs text-text-muted">{t(`terminal.tabs.status.${state}`)}</span>
      </button>
      <IconButton
        size="sm"
        label={t("terminal.tabs.close", { name: entry.title })}
        data-action="close-session"
        icon={<X className="size-icon" aria-hidden />}
        onClick={() => void closeTerminalSession(tabId, entry.key, entry.title)}
      />
    </div>
  );
}

function SessionTabs({ tabId, tabs }: { tabId: Id; tabs: TerminalTabs }) {
  const listRef = useRef<HTMLDivElement>(null);
  const move = (key: Id, delta: number) => {
    const next = neighbour(tabs, key, delta);
    if (!next) return;
    selectSession(tabId, next);
    // Roving focus: the keyboard selected the tab, the focus follows it.
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-terminal-tab="${next}"] [role="tab"]`)?.focus());
  };
  return (
    <div ref={listRef} role="tablist" aria-label={t("terminal.tabs.label")} className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {tabs.entries.map((entry) => (
        <SessionTab key={entry.key} tabId={tabId} entry={entry} active={entry.key === tabs.active} onArrow={move} />
      ))}
      <IconButton size="sm" label={t("terminal.tabs.new")} data-action="new-shell" icon={<Plus className="size-icon" aria-hidden />} onClick={() => newTerminalShell(tabId)} />
    </div>
  );
}

export function TerminalPanel({ repoId, tabId }: TerminalPanelProps) {
  const session = acquireSession(tabId, repoId);
  const status = useSyncExternalStore(session.subscribe, session.getStatus);
  const tabs = useSyncExternalStore(subscribeTerminalTabs, () => terminalTabs(tabId));
  const shownEntry = tabs.entries.find((entry) => entry.key === tabs.active) ?? null;
  const liveText = shownEntry ? t("terminal.tabs.live", { name: shownEntry.title, status: t(`terminal.tabs.status.${sessionState(shownEntry.kind, status)}`) }) : "";
  const { data: repo } = useRepo(repoId);
  const { data: info } = useAppInfo();
  const mac = info?.platform === "macos";
  const code = useCodeSettings();
  const wish = useTerminalHeight();
  const [available, setAvailable] = useState<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const live = isLive(status);

  // Font: family from the tokens, size as in the editor and the diff.
  useEffect(() => setTerminalFont(code.fontSize, code.lineHeight), [code.fontSize, code.lineHeight]);

  useEffect(() => {
    setTerminalPassthrough((event) => isLeaveShortcut(event, mac));
  }, [mac]);

  // Mount the terminal; on leaving (tab switch, hiding) only unmount it – the shell keeps running.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    session.attach(body);
    const observer = new ResizeObserver(() => session.scheduleFit());
    observer.observe(body);
    return () => {
      observer.disconnect();
      session.detach();
    };
  }, [session]);

  // Space shared by view and terminal: limits the height.
  useLayoutEffect(() => {
    const parent = sectionRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailable(parent.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // Focus: in on request (command, showing) – into the shell, or onto "Restart" if it has ended.
  useEffect(() => {
    let frame: number | null = null;
    let alive = true;
    const focusAction = () => sectionRef.current?.querySelector<HTMLElement>("button[data-focus-home]")?.focus();
    const run = (tries: number) => {
      if (!alive) return;
      if (isLive(session.getStatus())) {
        // On the very first open the font is still loading; until then there is no input field.
        if (session.isOpen) session.focus();
        else if (tries > 0) frame = requestAnimationFrame(() => run(tries - 1));
      } else {
        focusAction();
      }
    };
    // Only in the next frame: the panel is then surely mounted (also after the double mount in
    // React's development mode), and only then is the request consumed.
    const focus = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        if (takeTerminalFocus(tabId)) run(120);
      });
    };
    focus();
    const stop = onTerminalFocusRequest(focus);
    return () => {
      alive = false;
      if (frame !== null) cancelAnimationFrame(frame);
      stop();
    };
  }, [session, tabId]);

  // If the shell ends while typing in it, focus goes to "Restart" – Enter is enough.
  useEffect(() => {
    if (status.kind !== "exited" || !session.focusLostOnExit) return;
    session.focusLostOnExit = false;
    sectionRef.current?.querySelector<HTMLElement>("button[data-focus-home]")?.focus();
  }, [session, status]);

  const max = maxTerminalHeight(available);
  const height = shownTerminalHeight(wish, available);
  const path = repo?.path ?? "";

  const restart = () => void restartTerminal(tabId);

  return (
    <section
      ref={sectionRef}
      aria-label={t("terminal.title")}
      data-area="terminal"
      data-screen="terminal"
      data-state={status.kind}
      className="relative flex shrink-0 flex-col border-t border-border bg-surface-sunken"
      style={{ height }}
    >
      <HeightHandle
        value={height}
        min={TERMINAL_HEIGHT.min}
        max={max}
        defaultValue={TERMINAL_HEIGHT.default}
        onChange={setTerminalHeight}
        onCollapse={() => hideTerminal(tabId)}
      />

      <header className="flex h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <SquareTerminal className="size-icon shrink-0 text-text-muted" aria-hidden />
        <h2 className="shrink-0 text-sm font-medium text-text">{t("terminal.title")}</h2>
        <SessionTabs tabId={tabId} tabs={tabs} />
        {path ? (
          <Tip label={path}>
            <span className="min-w-0 flex-1 basis-0 truncate font-mono text-code text-text-muted">{path}</span>
          </Tip>
        ) : null}
        {status.kind === "exited" ? <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-text-muted">{t("terminal.badge.exited")}</span> : null}
        {status.kind === "failed" ? <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-text-muted">{t("terminal.badge.failed")}</span> : null}
        <div className="ml-auto flex shrink-0 items-center">
          <IconButton size="sm" label={t("terminal.clearLabel")} data-action="clear" icon={<Eraser className="size-icon" aria-hidden />} onClick={() => clearTerminal(tabId)} />
          <IconButton size="sm" label={live ? t("terminal.menu.restartAsk") : t("terminal.menu.restart")} data-action="restart" icon={<RotateCw className="size-icon" aria-hidden />} onClick={restart} />
          <IconButton
            size="sm"
            label={t("terminal.external")}
            shortcut="Alt+T"
            data-action="external"
            icon={<ExternalLink className="size-icon" aria-hidden />}
            onClick={() => void openExternal(repoId, "terminal")}
          />
          <IconButton
            size="sm"
            danger
            label={live ? t("terminal.menu.endAsk") : t("terminal.menu.end")}
            data-action="end"
            icon={<Trash2 className="size-icon" aria-hidden />}
            onClick={() => void endTerminal(tabId)}
          />
          <IconButton
            size="sm"
            label={t("terminal.hide")}
            shortcut="Mod+`"
            data-action="hide"
            icon={<ChevronDown className="size-icon" aria-hidden />}
            onClick={() => hideTerminal(tabId)}
          />
        </div>
      </header>
      <p className="sr-only" aria-live="polite">
        {liveText}
      </p>

      {status.kind === "failed" ? (
        <Banner
          tone="danger"
          title={failureTitle(status)}
          actions={
            <Button size="sm" data-focus-home data-action="retry" icon={<RotateCw className="size-icon" aria-hidden />} onClick={restart}>
              {t("terminal.retry")}
            </Button>
          }
        >
          <p className="selectable">
            {status.text} {status.hint}
          </p>
        </Banner>
      ) : null}

      <div className="group/term relative min-h-0 flex-1">
        {/* As long as the keyboard belongs to the shell (Tab, Shift+Tab and Esc arrive there), the way out is shown. */}
        <p
          id={TERMINAL_HINT_ID}
          className="pointer-events-none absolute top-1 right-3 z-1 hidden rounded-sm border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted group-has-[textarea:focus]/term:block"
        >
          {t("terminal.exitHint")}
        </p>
        {/* Focus is in xterm.js's input field; the border shows that the keyboard currently belongs to the shell. */}
        <div
          ref={bodyRef}
          data-terminal-body
          className="absolute inset-0 overflow-hidden py-1 pr-1 pl-2 -outline-offset-2 outline-accent has-[textarea:focus]:outline-2"
        />
        {status.kind === "starting" ? (
          <div role="status" className="pointer-events-none absolute inset-0 flex items-start gap-2 bg-surface-sunken py-1 pl-2 font-mono text-code text-text-muted">
            <Spinner label={t("terminal.starting")} />
            <span>{t("terminal.starting")} …</span>
          </div>
        ) : null}
      </div>

      {status.kind === "exited" ? (
        <footer role="status" className="flex min-h-control-lg shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-1">
          <CircleStop className="size-icon shrink-0 text-text-muted" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-base text-text">{exitText(status.code)}</p>
          <Button size="sm" variant="primary" data-focus-home data-action="restart-shell" icon={<RotateCw className="size-icon" aria-hidden />} onClick={restart}>
            {t("terminal.menu.restart")}
          </Button>
          <Button size="sm" variant="ghost" data-action="end-session" onClick={() => void endTerminal(tabId)}>
            {t("terminal.close")}
          </Button>
        </footer>
      ) : null}
    </section>
  );
}
