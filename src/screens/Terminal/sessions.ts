/**
 * Terminal sessions: several per repository tab (shells in the repository's folder, later also programs such as coding agents), shown as terminal tabs (tabsModel.ts).
 *
 * A session lives outside React. The panel (index.tsx) only mounts and unmounts its element – on
 * tab switches and when hiding, the shell keeps running and output keeps landing in xterm.js's
 * buffer. It is ended when the tab disappears (closed, repository forgotten) or the user ends the
 * session: the core itself only cleans up terminals when the app quits.
 *
 * Order at startup (required by the core): first listen to `terminal:data` / `terminal:exit`,
 * then `terminalOpen`; whatever arrives before the answer with the ID waits, sorted by ID.
 */
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { CoreError, core, type AppInfo, type ErrorCode, type Id, type Tab } from "../../core";
import { describeError } from "../../app/errors";
import { qk, queryClient } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { dropTerminalFocus, isTerminalReply, registerTerminalController, requestTerminalFocus } from "./control";
import { WIN32_PART_LIMIT, inputParts, trackWin32Input } from "./win32Input";
import { readTerminalFontFamily, readTerminalTheme, terminalLineHeight, watchTerminalTheme } from "./theme";
import { t } from "../../i18n";
import { EMPTY_TABS, addProgram, addShell, closeEntry, selectEntry, type TerminalTabs } from "./tabsModel";

export type TerminalStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number | null }
  | { kind: "failed"; code: ErrorCode; text: string; hint: string };

/** Lines kept beyond the visible area. */
const SCROLLBACK_LINES = 5000;
/** Report the size to the shell only once dragging pauses briefly. */
const RESIZE_DELAY_MS = 80;
/** If no output comes after the start, the shell counts as ready after this time anyway. */
const QUIET_START_MS = 2500;

// xterm.js texts for screen readers, in the UI language.
Terminal.strings.promptLabel = t("terminal.promptLabel");

/** id of the hint "F6 leaves the terminal" (the terminal draws it, the input field refers to it). */
export const TERMINAL_HINT_ID = "gc-terminal-exit-hint";
Terminal.strings.tooMuchOutput = t("terminal.tooMuchOutput");

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Appearance (the same for all sessions)
// ---------------------------------------------------------------------------

let font = { size: 13, lineHeight: 20 };

/**
 * The app's zoom (CSS zoom on the root element). xterm.js converts mouse positions into rows and
 * columns and does not know about the zoom – at 120 % a click would hit the wrong row. The
 * terminal's element therefore cancels the zoom for itself and gets a correspondingly larger font
 * instead: same picture, but inside "one CSS pixel is one pixel" holds again.
 */
let zoom = 1;
function readZoom(): number {
  const value = Number.parseFloat(document.documentElement.style.getPropertyValue("zoom"));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Font size and line height in pixels (from the code settings); applies to all sessions immediately. */
export function setTerminalFont(size: number, lineHeight: number): void {
  if (font.size === size && font.lineHeight === lineHeight) return;
  font = { size, lineHeight };
  for (const session of allSessions()) session.applyAppearance();
}

/** The font must be loaded before xterm.js measures the character width – otherwise the grid is off. */
async function fontReady(): Promise<void> {
  try {
    await Promise.race([document.fonts.load(`${font.size}px ${readTerminalFontFamily()}`), sleep(1500)]);
  } catch {
    // without the Font API xterm.js measures with whatever is there
  }
}

/**
 * Windows before build 21376 does not wrap lines in the pseudo terminal itself; xterm.js has to
 * know that, otherwise lines shift when the width changes. The WebView does not reveal the build
 * number itself, but it does reveal "Windows 11 or older".
 */
let windowsBuild: number | undefined;
function detectWindowsBuild(): void {
  const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?(hints: string[]): Promise<{ platformVersion?: string }> } }).userAgentData;
  void data
    ?.getHighEntropyValues?.(["platformVersion"])
    .then((values) => {
      const major = Number.parseInt(values.platformVersion ?? "", 10);
      if (!Number.isFinite(major)) return;
      windowsBuild = major >= 13 ? 22000 : 19045;
      for (const session of allSessions()) session.applyAppearance();
    })
    .catch(() => undefined);
}

const isWindows = () => (queryClient.getQueryData<AppInfo>(qk.appInfo)?.platform ?? "windows") === "windows";
const isMac = () => queryClient.getQueryData<AppInfo>(qk.appInfo)?.platform === "macos";

// ---------------------------------------------------------------------------
// Core events
// ---------------------------------------------------------------------------

type Early = { kind: "data"; data: string } | { kind: "exit"; code: number | null };

const byTerminalId = new Map<Id, Session>();
/** What arrives before `terminalOpen` has returned the ID. */
const early = new Map<Id, Early[]>();
let opening = 0;

function deliver(terminalId: Id, item: Early): void {
  const session = byTerminalId.get(terminalId);
  if (session) {
    session.receive(item);
    return;
  }
  // Unknown ID: only keep it while a start is in progress (otherwise it belongs to nobody anymore).
  if (opening === 0) return;
  const list = early.get(terminalId) ?? [];
  list.push(item);
  early.set(terminalId, list);
}

const ORPHAN_KEY = "gc.terminals";

/** IDs of our own terminals, so a reloaded window can end those of the old one. */
function rememberOpenIds(): void {
  try {
    sessionStorage.setItem(ORPHAN_KEY, JSON.stringify([...byTerminalId.keys()]));
  } catch {
    // without sessionStorage only the cleanup when leaving the page remains
  }
}

function closeOrphans(): void {
  try {
    const ids = JSON.parse(sessionStorage.getItem(ORPHAN_KEY) ?? "[]") as unknown;
    sessionStorage.removeItem(ORPHAN_KEY);
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === "string") void core.terminalClose({ terminalId: id }).catch(() => undefined);
  } catch {
    // nothing remembered
  }
}

let listening: Promise<void> | null = null;

/**
 * Subscribes to the terminal events once. `core.on` does not report when the subscription is in
 * place; a round trip to the core afterwards (plus a moment) makes sure the first start misses
 * nothing. In the app this happens on load – long before anyone opens a terminal.
 */
function ensureListening(): Promise<void> {
  if (listening) return listening;
  core.on("terminal:data", ({ terminalId, data }) => deliver(terminalId, { kind: "data", data }));
  core.on("terminal:exit", ({ terminalId, code }) => deliver(terminalId, { kind: "exit", code }));
  closeOrphans();
  listening = Promise.all([core.terminalClose({ terminalId: "" }).catch(() => undefined), sleep(40)]).then(() => undefined);
  return listening;
}

// ---------------------------------------------------------------------------
// Keys the terminal leaves to the app
// ---------------------------------------------------------------------------

/**
 * In the terminal the keyboard belongs to the shell – except for the shortcuts for leaving and
 * switching. Which ones those are is told by the panel (it knows the command registry).
 */
let passthrough: (event: KeyboardEvent) => boolean = () => false;
export function setTerminalPassthrough(test: (event: KeyboardEvent) => boolean): void {
  passthrough = test;
}

/** Opens the context menu (set by the panel); `point` is missing for the keyboard. */
let menuOpener: (session: Session, point: { x: number; y: number } | null) => void = () => undefined;
export function setTerminalMenuOpener(open: (session: Session, point: { x: number; y: number } | null) => void): void {
  menuOpener = open;
}

/** Copies the selection (set by the panel: with a toast via the app's clipboard action). */
let copier: (text: string) => void = () => undefined;
export function setTerminalCopier(copy: (text: string) => void): void {
  copier = copy;
}

const isFunctionKey = (event: KeyboardEvent) => /^F\d{1,2}$/.test(event.key);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Starts the session's process in the core and returns its terminal ID. */
export type Opener = (size: { cols: number; rows: number }) => Promise<Id>;

export class Session {
  readonly term: Terminal;
  /** Own element: xterm.js is opened into it once, the panel mounts and unmounts it. */
  readonly host: HTMLDivElement;
  private readonly fit = new FitAddon();
  private status: TerminalStatus = { kind: "starting" };
  private readonly listeners = new Set<() => void>();
  private terminalId: Id | null = null;
  /** Start counter: answers from an earlier start no longer count. */
  private run = 0;
  private opened = false;
  private started = false;
  private disposed = false;
  /** Input waiting to be sent – already split into chunks (win32Input.ts). */
  private queue: string[] = [];
  private sending = false;
  /** ConPTY requested "win32-input-mode": characters outside ASCII go out as key records. */
  private win32Input = false;
  private outputTail = "";
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private fitFrame: number | null = null;
  private sentSize: { cols: number; rows: number } | null = null;
  /** Focus was in the terminal when the shell ended: the panel moves it onto "Restart". */
  focusLostOnExit = false;
  /** Something came from the user since the shell started (see `isTerminalReply`). */
  private userInput = false;

  constructor(
    readonly tabId: Id,
    readonly repoId: Id,
    readonly key: Id,
    private readonly opener: Opener,
  ) {
    this.host = document.createElement("div");
    this.host.className = "h-full w-full";
    this.host.dataset.terminalHost = tabId;
    this.host.dataset.terminalSession = key;
    this.term = new Terminal({
      allowProposedApi: false,
      cursorBlink: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      scrollback: SCROLLBACK_LINES,
      // Whatever programs output: text stays readable on the background (WCAG AA).
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: false,
      // Links from the output are never opened by themselves.
      linkHandler: { activate: () => undefined },
      // Otherwise the output is only in rows with aria-hidden: with this mode xterm.js maintains an
      // accessible buffer including a live region – a screen reader reads what the shell writes.
      screenReaderMode: true,
      ...this.appearance(),
    });
    this.term.loadAddon(this.fit);
    this.term.onData((data) => this.send(data));
    this.term.onResize(() => this.scheduleResize());
    this.term.attachCustomKeyEventHandler((event) => this.filterKey(event));
  }

  // --- State -----------------------------------------------------------------

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getStatus = () => this.status;

  get id(): Id | null {
    return this.terminalId;
  }

  private setStatus(next: TerminalStatus): void {
    this.status = next;
    const live = next.kind === "starting" || next.kind === "running";
    this.term.options.disableStdin = !live;
    // No shell, no cursor: it would look as if one could still type. (A restart resets the terminal.)
    if (!live) this.term.write("\x1b[?25l");
    this.markInput(live);
    this.listeners.forEach((listener) => listener());
  }

  /**
   * xterm.js's input field is the target for F6 and the shell's focus guard
   * (src/app/commands/focus.ts) – as long as the shell runs. An ended shell does not accept
   * focus: F6 and Tab then land on "Restart".
   */
  private markInput(live: boolean): void {
    const textarea = this.term.textarea;
    if (!textarea) return;
    textarea.disabled = !live;
    textarea.toggleAttribute("data-focus-home", live);
  }

  // --- Appearance ------------------------------------------------------------

  private appearance() {
    const fontFamily = readTerminalFontFamily();
    return {
      theme: readTerminalTheme(),
      fontFamily,
      fontSize: font.size * zoom,
      lineHeight: terminalLineHeight(fontFamily, font.size * zoom, Math.round(font.lineHeight * zoom)),
      ...(isWindows() ? { windowsPty: { backend: "conpty" as const, buildNumber: windowsBuild } } : {}),
    };
  }

  applyAppearance(): void {
    if (this.disposed) return;
    this.host.style.zoom = zoom === 1 ? "" : String(1 / zoom);
    Object.assign(this.term.options, this.appearance());
    this.scheduleFit();
  }

  // --- Mounting and unmounting ----------------------------------------------------

  /** Mounts the terminal into `container`; the first time it is opened and the shell started. */
  attach(container: HTMLElement): void {
    if (this.disposed) return;
    container.appendChild(this.host);
    if (this.opened) {
      this.fitNow();
      // What arrived while unmounted is in the buffer; redraw now.
      this.term.refresh(0, this.term.rows - 1);
      return;
    }
    void fontReady().then(() => {
      if (this.disposed || this.opened || !this.host.isConnected) return;
      // Now the font is there: set the line height with its real metrics, then open.
      this.applyAppearance();
      this.opened = true;
      this.term.open(this.host);
      const textarea = this.term.textarea;
      if (textarea) {
        textarea.spellcheck = false;
        // xterm.js hides its input field with width and height 0; for the focus guard it needs an area.
        textarea.classList.add("min-h-px", "min-w-px");
        // Tab, Shift+Tab and Esc belong to the shell here: the way out (F6) is in the field's description.
        textarea.setAttribute("aria-describedby", TERMINAL_HINT_ID);
        // In screen reader mode xterm.js does not pass on text that arrives WITHOUT a keystroke
        // (Windows emoji picker, dictation, input aids): it would never reach the shell. Such text
        // therefore goes to the shell here – but only while no key is pressed: xterm.js handles
        // typed characters itself, they would otherwise appear twice.
        let keyIsDown = false;
        textarea.addEventListener("keydown", () => void (keyIsDown = true), true);
        textarea.addEventListener("keyup", () => void (keyIsDown = false), true);
        textarea.addEventListener("blur", () => void (keyIsDown = false));
        textarea.addEventListener("input", (event) => {
          if (!(event instanceof InputEvent) || event.inputType !== "insertText" || !event.data || event.isComposing || keyIsDown) return;
          this.term.input(event.data, true);
        });
      }
      this.markInput(this.status.kind === "starting" || this.status.kind === "running");
      this.host.addEventListener("keydown", (event) => this.shieldAppShortcuts(event));
      this.host.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        menuOpener(this, { x: event.clientX, y: event.clientY });
      });
      this.fitNow();
      if (!this.started) this.start();
      this.listeners.forEach((listener) => listener());
    });
  }

  detach(): void {
    if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
    this.fitFrame = null;
    this.host.remove();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Fit the size to the region – at most once per frame. */
  scheduleFit(): void {
    if (this.fitFrame !== null || this.disposed) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = null;
      this.fitNow();
    });
  }

  private fitNow(): void {
    if (!this.opened || !this.host.isConnected || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    try {
      this.fit.fit();
    } catch {
      // xterm.js is still measuring (font loading): the next occasion fits the size
    }
  }

  private scheduleResize(): void {
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.sendSize();
    }, RESIZE_DELAY_MS);
  }

  private sendSize(): void {
    const { cols, rows } = this.term;
    if (!this.terminalId || (this.sentSize?.cols === cols && this.sentSize.rows === rows)) return;
    this.sentSize = { cols, rows };
    void core.terminalResize({ terminalId: this.terminalId, cols, rows }).catch(() => undefined);
  }

  // --- Shell -----------------------------------------------------------------

  /** Starts the shell (again). A running one is ended first. */
  start(): void {
    if (this.disposed) return;
    this.started = true;
    const run = ++this.run;
    this.release();
    this.queue = [];
    this.win32Input = false;
    this.outputTail = "";
    this.focusLostOnExit = false;
    this.userInput = false;
    // The core answers the pseudo terminal's startup query with "cursor top left": the screen must be empty.
    this.term.reset();
    this.setStatus({ kind: "starting" });
    void this.open(run);
  }

  private async open(run: number): Promise<void> {
    const current = () => run === this.run && !this.disposed;
    await ensureListening();
    if (!current()) return;
    const { cols, rows } = this.term;
    opening++;
    try {
      const terminalId = await this.opener({ cols, rows });
      if (!current()) {
        early.delete(terminalId);
        void core.terminalClose({ terminalId }).catch(() => undefined);
        return;
      }
      this.terminalId = terminalId;
      this.sentSize = { cols, rows };
      byTerminalId.set(terminalId, this);
      rememberOpenIds();
      const waiting = early.get(terminalId) ?? [];
      early.delete(terminalId);
      for (const item of waiting) this.receive(item);
      if (!current() || this.terminalId !== terminalId) return;
      // By now the region may have a different size, and something may already have been typed.
      this.sendSize();
      void this.pump();
      this.quietTimer = setTimeout(() => {
        if (current() && this.status.kind === "starting") this.setStatus({ kind: "running" });
      }, QUIET_START_MS);
    } catch (error) {
      if (!current()) return;
      const code = error instanceof CoreError ? error.code : "unknown";
      this.setStatus({ kind: "failed", code, ...describeError(error) });
    } finally {
      opening--;
      if (opening === 0) early.clear();
    }
  }

  /** Output or end of the shell, from the core. */
  receive(item: Early): void {
    if (this.disposed) return;
    const run = this.run;
    if (item.kind === "data") {
      if (isWindows()) {
        const mode = trackWin32Input(this.win32Input, this.outputTail, item.data);
        this.win32Input = mode.enabled;
        this.outputTail = mode.tail;
      }
      // "Running" means: something is shown (greeting, prompt). Before that the pseudo terminal only sends control characters.
      this.term.write(item.data, () => {
        if (run === this.run && !this.disposed && this.status.kind === "starting" && this.hasOutput()) this.setStatus({ kind: "running" });
      });
      return;
    }
    const hadFocus = this.hasFocus();
    this.forget();
    // Let the last output be drawn first, then change the state.
    this.term.write("", () => {
      if (this.disposed || run !== this.run) return;
      this.focusLostOnExit = hadFocus;
      this.setStatus({ kind: "exited", code: item.code });
    });
  }

  private hasOutput(): boolean {
    const buffer = this.term.buffer.active;
    if (buffer.cursorX > 0 || buffer.cursorY > 0 || buffer.baseY > 0) return true;
    return (buffer.getLine(0)?.translateToString(true) ?? "") !== "";
  }

  /** Detaches from the shell without ending it (it has already ended). */
  private forget(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    if (this.terminalId) {
      byTerminalId.delete(this.terminalId);
      rememberOpenIds();
    }
    this.terminalId = null;
    this.sentSize = null;
    this.queue = [];
  }

  /** Ends the running shell including its child processes. */
  private release(): void {
    const terminalId = this.terminalId;
    this.forget();
    if (terminalId) void core.terminalClose({ terminalId }).catch(() => undefined);
  }

  /**
   * Whether anything has been typed into this shell since its start. The core does not reveal
   * whether a program is currently running in it; a shell that has been worked in is the best
   * indication that something may be lost on closing.
   */
  get hadInput(): boolean {
    return this.userInput;
  }

  private send(data: string): void {
    if (this.status.kind !== "starting" && this.status.kind !== "running") return;
    if (!isTerminalReply(data)) this.userInput = true;
    this.queue.push(...inputParts(data, this.win32Input));
    void this.pump();
  }

  /**
   * Input goes to the core one call at a time and in order: two concurrent calls could overtake
   * each other, and then characters would arrive swapped in the shell. Whatever is typed meanwhile
   * accumulates and – as far as it is small – goes out together in the next call.
   */
  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0 && this.terminalId) {
        let data = this.queue.shift()!;
        // A single Esc stays alone: with the next key in the same chunk the shell would read "Alt+key".
        while (this.queue.length > 0 && !data.endsWith("\x1b") && data.length + this.queue[0]!.length <= WIN32_PART_LIMIT) data += this.queue.shift()!;
        await core.terminalWrite({ terminalId: this.terminalId, data });
      }
    } catch {
      // The shell has ended by now; `terminal:exit` reports it.
      this.queue = [];
    } finally {
      this.sending = false;
    }
  }

  // --- Operation -------------------------------------------------------------

  hasFocus(): boolean {
    const active = document.activeElement;
    return active !== null && this.host.contains(active);
  }

  focus(): void {
    this.term.focus();
  }

  /**
   * Clear the scrollback: what has scrolled off the top disappears. On Windows the visible screen
   * stays – the pseudo terminal maintains it itself, and a screen cleared only here would no longer
   * match what the shell draws next (gaps, shifted prompt).
   * The shell clears the screen itself (`clear`, `cls`).
   */
  clear(): void {
    if (isWindows()) this.term.write("\x1b[3J");
    else this.term.clear();
  }

  selection(): string {
    return this.term.getSelection();
  }

  copySelection(): boolean {
    const text = this.term.getSelection();
    if (!text) return false;
    copier(text);
    return true;
  }

  selectAll(): void {
    this.term.selectAll();
  }

  /** Inserts text as if typed (with "bracketed paste" if the shell asks for it). */
  paste(text: string): void {
    if (text) this.term.paste(text);
  }

  /**
   * Keys that xterm.js should not send to the shell. `false` means: xterm.js leaves the key alone.
   */
  private filterKey(event: KeyboardEvent): boolean {
    // Ended: the keyboard belongs entirely to the UI again (Tab moves on to the next control).
    if (this.status.kind !== "starting" && this.status.kind !== "running") return false;
    if (passthrough(event)) return false;
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();
    const mod = isMac() ? event.metaKey : event.ctrlKey && event.shiftKey;
    if (mod && !event.altKey && key === "c") {
      // Ctrl+C alone stays the interrupt signal for the shell.
      event.preventDefault();
      this.copySelection();
      return false;
    }
    // The WebView handles pasting itself (paste event, which xterm.js evaluates).
    if (mod && !event.altKey && key === "v") return false;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      menuOpener(this, null);
      return false;
    }
    return true;
  }

  /**
   * From within the terminal, app shortcuts reach neither the command registry nor the WebView:
   * Ctrl+P, Ctrl+W or Alt+D mean something else in the shell. The only exceptions are the
   * shortcuts for leaving and switching.
   */
  private shieldAppShortcuts(event: KeyboardEvent): void {
    if (passthrough(event)) return;
    if (this.status.kind !== "starting" && this.status.kind !== "running") return;
    if (!(event.ctrlKey || event.metaKey || event.altKey || isFunctionKey(event))) return;
    event.stopPropagation();
    // AltGr (arrives as Ctrl+Alt on Windows): the key writes a character, which must arrive.
    const altGraph = (event.ctrlKey && event.altKey) || event.getModifierState("AltGraph");
    const key = event.key.toLowerCase();
    // Paste and – on macOS – copy, cut and select all are done by the WebView.
    const native = isMac() ? event.metaKey && ["c", "v", "x", "a"].includes(key) : event.ctrlKey && event.shiftKey && key === "v";
    if (!altGraph && !native) event.preventDefault();
  }

  // --- End -------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.run++;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.release();
    this.detach();
    this.term.dispose();
    this.listeners.clear();
  }

  // --- Insight for tests ----------------------------------------------------

  /** The whole buffer as text; wrapped lines are joined again. */
  bufferText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join("\n").replace(/\n+$/, "");
  }
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

interface TabGroup {
  repoId: Id;
  tabs: TerminalTabs;
  sessions: Map<Id, Session>;
}

const groups = new Map<Id, TabGroup>();
const tabListeners = new Set<() => void>();
let keyCounter = 0;
const newKey = (): Id => `term-${Date.now().toString(36)}-${(keyCounter++).toString(36)}`;
const shellTitle = (number: number) => (number === 1 ? t("terminal.tabs.shell") : t("terminal.tabs.shellNumbered", { n: number }));
const shellOpener =
  (repoId: Id): Opener =>
  ({ cols, rows }) =>
    core.terminalOpen({ repoId, cols, rows });
const isLiveStatus = (status: TerminalStatus) => status.kind === "starting" || status.kind === "running";

function* allSessions(): Generator<Session> {
  for (const group of groups.values()) yield* group.sessions.values();
}

/** Tells the tab strips. Deferred: sessions are also created while a panel renders. */
function notifyTabs(): void {
  queueMicrotask(() => tabListeners.forEach((listener) => listener()));
}

export function subscribeTerminalTabs(listener: () => void): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

/** The terminal tabs of a repository tab (the same object until something changes). */
export function terminalTabs(tabId: Id): TerminalTabs {
  return groups.get(tabId)?.tabs ?? EMPTY_TABS;
}

function groupOf(tabId: Id, repoId: Id): TabGroup {
  const existing = groups.get(tabId);
  if (existing && existing.repoId === repoId) return existing;
  if (existing) disposeSession(tabId);
  const group: TabGroup = { repoId, tabs: EMPTY_TABS, sessions: new Map() };
  groups.set(tabId, group);
  return group;
}

function addSession(group: TabGroup, tabId: Id, key: Id, opener: Opener, tabs: TerminalTabs): Session {
  const session = new Session(tabId, group.repoId, key, opener);
  group.sessions.set(key, session);
  group.tabs = tabs;
  notifyTabs();
  return session;
}

/** The shown session of the tab; the first time (or after the last one ended) a shell. */
export function acquireSession(tabId: Id, repoId: Id): Session {
  const group = groupOf(tabId, repoId);
  const shown = group.tabs.active ? group.sessions.get(group.tabs.active) : undefined;
  if (shown) return shown;
  const key = newKey();
  return addSession(group, tabId, key, shellOpener(repoId), addShell(group.tabs, key, shellTitle));
}

/** Another shell in the same repository tab; it is shown right away. */
export function newShellSession(tabId: Id, repoId: Id): Session {
  const group = groupOf(tabId, repoId);
  const key = newKey();
  return addSession(group, tabId, key, shellOpener(repoId), addShell(group.tabs, key, shellTitle));
}

/** A session with its own program (coding agents, 2a): `open` starts it in the core. */
export function openProgramSession(tabId: Id, repoId: Id, title: string, open: Opener): Session {
  const group = groupOf(tabId, repoId);
  const key = newKey();
  return addSession(group, tabId, key, open, addProgram(group.tabs, key, title));
}

export function selectSession(tabId: Id, key: Id): void {
  const group = groups.get(tabId);
  if (!group) return;
  const next = selectEntry(group.tabs, key);
  if (next === group.tabs) return;
  group.tabs = next;
  notifyTabs();
}

/** The shown session of the tab, or null. */
export function getSession(tabId: Id): Session | null {
  const group = groups.get(tabId);
  if (!group || !group.tabs.active) return null;
  return group.sessions.get(group.tabs.active) ?? null;
}

export function sessionByKey(tabId: Id, key: Id): Session | null {
  return groups.get(tabId)?.sessions.get(key) ?? null;
}

/** Ends one session; returns how many are left in the tab. */
export function closeSession(tabId: Id, key: Id): number {
  const group = groups.get(tabId);
  const session = group?.sessions.get(key);
  if (!group || !session) return group?.tabs.entries.length ?? 0;
  group.sessions.delete(key);
  group.tabs = closeEntry(group.tabs, key);
  session.dispose();
  const left = group.tabs.entries.length;
  if (left === 0) {
    groups.delete(tabId);
    dropTerminalFocus(tabId);
  }
  notifyTabs();
  return left;
}

/** Ends every session of the tab. */
export function disposeSession(tabId: Id): void {
  const group = groups.get(tabId);
  if (!group) return;
  groups.delete(tabId);
  dropTerminalFocus(tabId);
  for (const session of group.sessions.values()) session.dispose();
  notifyTabs();
}

/** End the sessions of tabs that no longer exist (or that show a different repository). */
function reconcileWithTabs(): void {
  if (groups.size === 0) return;
  const tabs = queryClient.getQueryData<Tab[]>(qk.tabs);
  if (!tabs) return;
  for (const [tabId, group] of [...groups]) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab || tab.kind !== "repo" || tab.repoId !== group.repoId) disposeSession(tabId);
  }
}

registerTerminalController({
  statusOf: (tabId) => getSession(tabId)?.getStatus().kind ?? null,
  hadInput: (tabId) => [...(groups.get(tabId)?.sessions.values() ?? [])].some((session) => isLiveStatus(session.getStatus()) && session.hadInput),
  isLive: (tabId, key) => {
    const session = sessionByKey(tabId, key);
    return session ? isLiveStatus(session.getStatus()) : false;
  },
  restart: (tabId) => getSession(tabId)?.start(),
  clear: (tabId) => getSession(tabId)?.clear(),
  endActive: (tabId) => {
    const key = groups.get(tabId)?.tabs.active;
    return key ? closeSession(tabId, key) : 0;
  },
  close: closeSession,
  newShell: (tabId) => {
    const group = groups.get(tabId);
    if (group) newShellSession(tabId, group.repoId);
  },
  dispose: disposeSession,
});

if (typeof window !== "undefined") {
  // Tab closed, repository forgotten: the list of tabs changes, the shell ends.
  queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key[0] === qk.tabs[0] && key[1] === qk.tabs[1]) reconcileWithTabs();
  });

  // When a tab's terminal is shown, one should be able to type right away.
  useAppStore.subscribe((state, previous) => {
    if (state.views === previous.views) return;
    for (const [tabId, view] of Object.entries(state.views)) {
      if (view.terminalOpen && !previous.views[tabId]?.terminalOpen) requestTerminalFocus(tabId);
    }
  });

  watchTerminalTheme(() => {
    for (const session of allSessions()) session.applyAppearance();
  });
  detectWindowsBuild();

  zoom = readZoom();
  new MutationObserver(() => {
    const next = readZoom();
    if (next === zoom) return;
    zoom = next;
    for (const session of allSessions()) session.applyAppearance();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

  // Reloading or closing the window: leave nothing behind (the core only cleans up when the app quits).
  window.addEventListener("pagehide", () => {
    for (const terminalId of byTerminalId.keys()) void core.terminalClose({ terminalId }).catch(() => undefined);
  });

  if (isTauri()) void ensureListening();

  if (import.meta.env.DEV) {
    // For the E2E driver (scripts/e2e/screens/terminal.mjs) and the console.
    window.__gcTerminal = {
      tabs: () => [...groups.keys()],
      openIds: () => [...byTerminalId.keys()],
      sessions: (tabId) => {
        const tabs = terminalTabs(tabId);
        return tabs.entries.map((entry) => ({
          key: entry.key,
          title: entry.title,
          kind: entry.kind,
          active: entry.key === tabs.active,
          status: sessionByKey(tabId, entry.key)?.getStatus().kind ?? null,
        }));
      },
      status: (tabId) => getSession(tabId)?.getStatus() ?? null,
      id: (tabId) => getSession(tabId)?.id ?? null,
      text: (tabId) => getSession(tabId)?.bufferText() ?? null,
      size: (tabId) => {
        const term = getSession(tabId)?.term;
        return term ? { cols: term.cols, rows: term.rows, lines: term.buffer.active.length, viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY } : null;
      },
      selection: (tabId) => getSession(tabId)?.selection() ?? null,
      options: (tabId) => {
        const term = getSession(tabId)?.term;
        return term ? { theme: { ...term.options.theme }, fontFamily: term.options.fontFamily, fontSize: term.options.fontSize, lineHeight: term.options.lineHeight, scrollback: term.options.scrollback } : null;
      },
    };
  }
}

declare global {
  interface Window {
    __gcTerminal?: {
      tabs(): Id[];
      openIds(): Id[];
      sessions(tabId: Id): { key: Id; title: string; kind: "shell" | "program"; active: boolean; status: TerminalStatus["kind"] | null }[];
      status(tabId: Id): TerminalStatus | null;
      id(tabId: Id): Id | null;
      text(tabId: Id): string | null;
      size(tabId: Id): { cols: number; rows: number; lines: number; viewportY: number; baseY: number } | null;
      selection(tabId: Id): string | null;
      options(tabId: Id): { theme: Record<string, unknown>; fontFamily: string | undefined; fontSize: number | undefined; lineHeight: number | undefined; scrollback: number | undefined } | null;
    };
  }
}
