/**
 * The one place that turns shortcut notation ("Mod+Shift+P") into what the user reads.
 *
 * - macOS: glyphs in Apple's order ⌃⌥⇧⌘, no separator ("⇧⌘P"). "Mod"/"Cmd" is ⌘, "Ctrl" the
 *   real Control key ⌃ (that is what `matchesShortcut` checks for).
 * - Windows/Linux: key caps as text in the UI language, joined with "+" ("Ctrl+Shift+P",
 *   German "Strg+Shift+P"). "Mod", "Cmd" and "Ctrl" are all the Ctrl key there.
 *
 * The platform comes from the core (`setShortcutPlatform`, called with appInfo at startup); until
 * then the WebView's guess applies. Tests pass `platform` and `t` explicitly.
 */
import i18next from "i18next";
import { platform as guessedPlatform, platformWords, type Language, type Platform } from "../i18n";
import type { Platform as CorePlatform } from "../core/types";

export type ShortcutPlatform = Platform;

type Translate = (key: string) => string;

export interface ShortcutOptions {
  platform?: ShortcutPlatform;
  t?: Translate;
}

let current: ShortcutPlatform = guessedPlatform;

/** Sets the platform reported by the core and keeps `{{mod}}` in the texts in step with it. */
export function setShortcutPlatform(os: CorePlatform | ShortcutPlatform): void {
  current = os === "macos" ? "mac" : os;
  const interpolation = i18next.options.interpolation;
  if (interpolation) {
    const language = (i18next.language === "de" ? "de" : "en") satisfies Language;
    interpolation.defaultVariables = { ...interpolation.defaultVariables, ...platformWords(language, current) };
  }
}

export function shortcutPlatform(): ShortcutPlatform {
  return current;
}

export function isMacShortcuts(): boolean {
  return current === "mac";
}

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Mod"] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES = new Map<string, Modifier>([
  ["Ctrl", "Ctrl"],
  ["Control", "Ctrl"],
  ["Alt", "Alt"],
  ["Option", "Alt"],
  ["Shift", "Shift"],
  ["Mod", "Mod"],
  ["Cmd", "Mod"],
  ["Meta", "Mod"],
]);

const MAC_GLYPHS: Record<Modifier, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };

const TEXT_KEYS: Record<Modifier, string> = { Ctrl: "ui.keys.ctrl", Alt: "ui.keys.alt", Shift: "ui.keys.shift", Mod: "ui.keys.ctrl" };

/** Named keys as printed on the keyboard (per language). */
const NAMED_KEYS: Record<string, string> = {
  PageUp: "ui.keys.pageUp",
  PageDown: "ui.keys.pageDown",
  Home: "ui.keys.home",
  End: "ui.keys.end",
  Delete: "ui.keys.delete",
  Insert: "ui.keys.insert",
  Backspace: "ui.keys.backspace",
  Space: "ui.keys.space",
  ContextMenu: "ui.keys.menu",
};

const SYMBOL_KEYS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };

function keyName(key: string, mac: boolean, tr: Translate): string {
  if (mac && key === "Enter") return "↩";
  if (SYMBOL_KEYS[key]) return SYMBOL_KEYS[key];
  if (NAMED_KEYS[key]) return tr(NAMED_KEYS[key]);
  return key;
}

/** Splits "Mod+Shift+S" into the key caps as they are called on the platform. */
export function shortcutKeys(shortcut: string, options: ShortcutOptions = {}): string[] {
  const mac = (options.platform ?? current) === "mac";
  const tr = options.t ?? ((key: string) => i18next.t(key));
  const parts = shortcut
    .split("+")
    .map((part, index, all) => (part === "" && index === all.length - 1 ? "+" : part))
    .filter(Boolean);
  const modifiers = new Set<Modifier>();
  const keys: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part);
    if (modifier) modifiers.add(mac || modifier !== "Mod" ? modifier : "Ctrl");
    else keys.push(keyName(part, mac, tr));
  }
  const caps = MODIFIERS.filter((modifier) => modifiers.has(modifier)).map((modifier) => (mac ? MAC_GLYPHS[modifier] : tr(TEXT_KEYS[modifier])));
  return [...caps, ...keys];
}

/** Shortcut as readable text (tooltips, texts, the shortcut filter). */
export function formatShortcut(shortcut: string, options: ShortcutOptions = {}): string {
  const mac = (options.platform ?? current) === "mac";
  return shortcutKeys(shortcut, options).join(mac ? "" : "+");
}

const ARIA_MODIFIERS: Record<Modifier, string> = { Ctrl: "Control", Alt: "Alt", Shift: "Shift", Mod: "Meta" };
const ARIA_KEYS: Record<string, string> = { Esc: "Escape", "+": "Plus", Del: "Delete" };

/**
 * Shortcut for `aria-keyshortcuts`: standard KeyboardEvent.key names joined with "+"
 * ("Control+Alt+F"), independent of the UI language. "Mod" is Meta on macOS, Control elsewhere.
 */
export function ariaShortcut(shortcut: string, options: Pick<ShortcutOptions, "platform"> = {}): string {
  const mac = (options.platform ?? current) === "mac";
  const parts = shortcut
    .split("+")
    .map((part, index, all) => (part === "" && index === all.length - 1 ? "+" : part))
    .filter(Boolean);
  const modifiers = new Set<Modifier>();
  const keys: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part);
    if (modifier) modifiers.add(mac || modifier !== "Mod" ? modifier : "Ctrl");
    else keys.push(ARIA_KEYS[part] ?? (part.length === 1 ? part.toUpperCase() : part));
  }
  return [...MODIFIERS.filter((modifier) => modifiers.has(modifier)).map((modifier) => ARIA_MODIFIERS[modifier]), ...keys].join("+");
}
