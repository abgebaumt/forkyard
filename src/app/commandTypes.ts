/**
 * Types and keyboard helpers for the command registry. Command files under
 * src/app/commands/*.ts import only from here (not from registry.ts),
 * so there are no circular imports.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Id, Platform, Status, Tab } from "../core";
import { t } from "../i18n";
import type { AppState, TabView } from "./store";

export interface CommandContext {
  platform: Platform;
  tabs: Tab[];
  /** Active tab (repo or repository management). */
  tab: Tab | null;
  tabId: Id | null;
  /** Only set if the active tab shows a repository that actually exists. */
  repoId: Id | null;
  view: TabView | null;
  /** Status of the active repo from the cache, if already loaded. */
  status: Status | undefined;
  /** Snapshot of the store; actions via `store.selectWip(...)` etc. */
  store: AppState;
  queryClient: QueryClient;
  /** How the command was triggered. */
  source: "keyboard" | "palette" | "menu";
}

/** Group of a command. The values are identifiers; what is displayed is `commandGroupLabel(group)`. */
export type CommandGroup = "Allgemein" | "Tabs" | "Ansicht" | "Repository" | "Remote" | "Branch" | "Stash" | "Commit" | "Datei";

const GROUP_KEYS: Record<CommandGroup, string> = {
  Allgemein: "general",
  Tabs: "tabs",
  Ansicht: "view",
  Repository: "repository",
  Remote: "remote",
  Branch: "branch",
  Stash: "stash",
  Commit: "commit",
  Datei: "file",
};

/** Displayed name of a command group in the UI language. */
export function commandGroupLabel(group: CommandGroup): string {
  return t(`commands.groups.${GROUP_KEYS[group]}`);
}

/** Search words for the palette from a translation (comma-separated), plus fixed words. */
export function kw(key: string, extra: readonly string[] = []): string[] {
  return [
    ...t(key)
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean),
    ...extra,
  ];
}

export interface AppCommand {
  /** Unique, prefixed with the area, e.g. "tab.new", "sync.pull". */
  id: string;
  /** Title for the palette and the shortcut overview (translated). */
  title: string;
  group: CommandGroup;
  /**
   * Shortcut. "Mod" is Ctrl, Cmd on macOS. Examples: "Mod+T", "Mod+Shift+Z", "Alt+O", "Mod+=".
   * Displayed and executed.
   */
  shortcut?: string;
  /** Further shortcuts that do the same (not displayed). */
  aliases?: string[];
  /**
   * The shortcut has its own meaning in text fields (e.g. Mod+Z): do not intercept it there.
   * Default: shortcuts with Mod/Ctrl/Meta also apply in text fields, all others do not.
   */
  textEditing?: boolean;
  /** Further search words for the palette. */
  keywords?: string[];
  /** Only executable if true. If missing, the command is always available. */
  when?(ctx: CommandContext): boolean;
  /**
   * Not offered at all while true: neither in the palette nor by shortcut (unlike `when`, which
   * shows the command greyed out with a reason). For things that must not appear, e.g. AI in "off".
   */
  hidden?(ctx: CommandContext): boolean;
  /**
   * Optional: why the command is not possible right now (a short phrase, e.g. "No stash present").
   * The Command Palette shows it for disabled commands; if missing, it guesses a generic reason.
   */
  disabledReason?(ctx: CommandContext): string | null;
  run(ctx: CommandContext): void | Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Recognising shortcuts
// ---------------------------------------------------------------------------

interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+");
  // "Mod++" → last key is "+"
  const key = parts[parts.length - 1] === "" && parts.length > 1 ? "+" : (parts[parts.length - 1] ?? "");
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
  return {
    mod: modifiers.has("mod") || modifiers.has("cmd"),
    ctrl: modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

const codePunctuation: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadDivide: "/",
};

/** Checks whether a KeyboardEvent matches the shortcut – taking keyboard layouts (e.g. German) into account. */
export function matchesShortcut(event: KeyboardEvent, shortcut: string, mac: boolean): boolean {
  const parsed = parseShortcut(shortcut);
  const wantCtrl = parsed.ctrl || (parsed.mod && !mac);
  const wantMeta = parsed.mod && mac;
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta || event.altKey !== parsed.alt) return false;

  const { key } = parsed;
  if (/^[a-z]$/.test(key)) {
    // Letters by layout; with Alt on macOS, key yields a special character, then the physical key counts.
    const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : "";
    return letter === key && event.shiftKey === parsed.shift;
  }
  if (/^[0-9]$/.test(key)) {
    const digit = event.code.startsWith("Digit") ? event.code.slice(5) : event.code.startsWith("Numpad") ? event.code.slice(6) : "";
    return digit === key && event.shiftKey === parsed.shift;
  }
  if (key.length === 1) {
    // Punctuation: the produced character counts (on a German keyboard "/" is Shift+7), Shift ignored.
    if (event.key === key) return true;
    return codePunctuation[event.code] === key && event.shiftKey === parsed.shift;
  }
  // Named keys: Enter, Escape, F7, ArrowUp …
  return event.key.toLowerCase() === key.toLowerCase() && event.shiftKey === parsed.shift;
}

/**
 * Whether the shortcut does not serve for typing in text fields: with Ctrl/Mod, or a function key
 * (F1–F12 type no text – F6 "next area" should also work from inside the commit field).
 * Alt+letter types nothing on Windows and Linux either (AltGr arrives as Ctrl+Alt and matches no
 * pure Alt shortcut): Alt+1/2/3, Alt+S, Alt+P apply there in the commit message field too.
 * On macOS Option+key writes special characters – there Alt shortcuts stay off in text fields.
 */
export function hasCommandModifier(shortcut: string, mac = false): boolean {
  const parsed = parseShortcut(shortcut);
  return parsed.mod || parsed.ctrl || (parsed.alt && !mac) || /^F\d{1,2}$/.test(parsed.key);
}
