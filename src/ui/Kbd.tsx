import type { ReactNode } from "react";
import { cn } from "./cn";
import { platform, t } from "../i18n";

// Preset from the WebView's user agent; appInfo confirms it at startup.
let mac = platform === "mac";

/**
 * Set once at startup (from appInfo). On macOS "Mod" and "Ctrl" become ⌘,
 * "Alt" becomes ⌥ and "Shift" ⇧; otherwise "Mod" and "Ctrl" become the Ctrl key in the UI language (Ctrl or Strg).
 */
export function setShortcutPlatform(isMac: boolean): void {
  mac = isMac;
}

export function isMacShortcuts(): boolean {
  return mac;
}

const macKeys: Record<string, string> = { Mod: "⌘", Ctrl: "⌘", Cmd: "⌘", Alt: "⌥", Shift: "⇧", Enter: "↩" };

/**
 * Key names as printed on the keyboard (per language). Applies wherever a shortcut is
 * shown – menus, tooltips, command palette and shortcut overview name the same key the same way.
 */
export const KEY_NAMES: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: t("ui.keys.pageUp"),
  PageDown: t("ui.keys.pageDown"),
  Home: t("ui.keys.home"),
  End: t("ui.keys.end"),
  Delete: t("ui.keys.delete"),
  Insert: t("ui.keys.insert"),
  Backspace: t("ui.keys.backspace"),
  Escape: "Esc",
  Space: t("ui.keys.space"),
  ContextMenu: t("ui.keys.menu"),
};

/** Splits "Mod+Shift+S" into keys as they are called on this platform. */
export function shortcutKeys(shortcut: string): string[] {
  const parts = shortcut.split("+").map((part, index, all) => (part === "" && index === all.length - 1 ? "+" : part)).filter(Boolean);
  return parts.map((part) => (mac ? (macKeys[part] ?? KEY_NAMES[part] ?? part) : part === "Mod" || part === "Cmd" || part === "Ctrl" ? t("ui.keys.ctrl") : (KEY_NAMES[part] ?? part)));
}

/** Shortcut as readable text, e.g. for aria-keyshortcuts or tooltips. */
export function formatShortcut(shortcut: string): string {
  return shortcutKeys(shortcut).join(mac ? "" : "+");
}

/** Keyboard shortcut. "Ctrl+Shift+S" is split into individual keys. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  const keys = typeof children === "string" ? shortcutKeys(children) : [children];
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((key, index) => (
        <kbd
          key={index}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-surface px-1 font-sans text-xs font-medium text-text-muted"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
