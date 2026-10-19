import i18next from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import { detectPlatform, t } from "../i18n";
import { ariaShortcut, formatShortcut, isMacShortcuts, setShortcutPlatform, shortcutKeys, shortcutPlatform } from "./shortcut";

const en = i18next.getFixedT("en");
const de = i18next.getFixedT("de");

describe("formatShortcut on Windows and Linux", () => {
  it("writes the modifiers as text joined with +", () => {
    expect(formatShortcut("Mod+Shift+P", { platform: "windows", t: en })).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Mod+Shift+P", { platform: "linux", t: en })).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Mod+Alt+F", { platform: "linux", t: en })).toBe("Ctrl+Alt+F");
    expect(formatShortcut("Ctrl+Tab", { platform: "windows", t: en })).toBe("Ctrl+Tab");
    expect(formatShortcut("Mod+Enter", { platform: "windows", t: en })).toBe("Ctrl+Enter");
    expect(formatShortcut("Alt+S", { platform: "linux", t: en })).toBe("Alt+S");
    expect(formatShortcut("Shift+F6", { platform: "linux", t: en })).toBe("Shift+F6");
  });

  it("uses the German key caps in German", () => {
    expect(formatShortcut("Mod+Shift+P", { platform: "windows", t: de })).toBe("Strg+Shift+P");
    expect(formatShortcut("Mod+Shift+P", { platform: "linux", t: de })).toBe("Strg+Shift+P");
    expect(formatShortcut("Ctrl+Shift+Tab", { platform: "linux", t: de })).toBe("Strg+Shift+Tab");
    expect(formatShortcut("Mod+Alt+F", { platform: "windows", t: de })).toBe("Strg+Alt+F");
    expect(formatShortcut("Shift+Delete", { platform: "linux", t: de })).toBe("Shift+Entf");
    expect(formatShortcut("PageDown", { platform: "windows", t: de })).toBe("Bild↓");
  });

  it("handles punctuation, a + key and arrows", () => {
    expect(formatShortcut("Mod+,", { platform: "linux", t: en })).toBe("Ctrl+,");
    expect(formatShortcut("Mod+/", { platform: "windows", t: en })).toBe("Ctrl+/");
    expect(formatShortcut("Mod++", { platform: "linux", t: en })).toBe("Ctrl++");
    expect(formatShortcut("Mod+`", { platform: "linux", t: en })).toBe("Ctrl+`");
    expect(formatShortcut("Alt+ArrowUp", { platform: "windows", t: en })).toBe("Alt+↑");
    expect(formatShortcut("Escape", { platform: "linux", t: en })).toBe("Esc");
    expect(formatShortcut("F2", { platform: "linux", t: en })).toBe("F2");
  });

  it("never shows a macOS glyph", () => {
    const all = ["Mod+Shift+P", "Mod+Alt+Shift+K", "Ctrl+Enter", "Mod+Shift+Enter", "Alt+ArrowLeft", "Cmd+K"];
    for (const platform of ["windows", "linux"] as const) {
      for (const tr of [en, de]) {
        for (const shortcut of all) expect(formatShortcut(shortcut, { platform, t: tr })).not.toMatch(/[⌘⌥⇧⌃↩]/);
      }
    }
  });

  it("splits into the single key caps", () => {
    expect(shortcutKeys("Mod+Shift+P", { platform: "linux", t: en })).toEqual(["Ctrl", "Shift", "P"]);
    expect(shortcutKeys("Mod+Shift+P", { platform: "windows", t: de })).toEqual(["Strg", "Shift", "P"]);
    expect(shortcutKeys("Mod++", { platform: "linux", t: en })).toEqual(["Ctrl", "+"]);
  });
});

describe("formatShortcut on macOS", () => {
  it("uses the glyphs in the order Control, Option, Shift, Command", () => {
    expect(formatShortcut("Mod+Shift+P", { platform: "mac", t: en })).toBe("⇧⌘P");
    expect(formatShortcut("Mod+Alt+F", { platform: "mac", t: en })).toBe("⌥⌘F");
    expect(formatShortcut("Shift+Alt+Ctrl+Mod+K", { platform: "mac", t: en })).toBe("⌃⌥⇧⌘K");
    expect(formatShortcut("Mod+Enter", { platform: "mac", t: en })).toBe("⌘↩");
    expect(formatShortcut("Mod+,", { platform: "mac", t: de })).toBe("⌘,");
  });

  it("keeps the Control key apart from Command", () => {
    // matchesShortcut wants the real Control key for "Ctrl", so it must not read as ⌘.
    expect(formatShortcut("Ctrl+Tab", { platform: "mac", t: en })).toBe("⌃Tab");
    expect(formatShortcut("Ctrl+Shift+Tab", { platform: "mac", t: en })).toBe("⌃⇧Tab");
  });

  it("is the same in every language", () => {
    expect(formatShortcut("Mod+Shift+P", { platform: "mac", t: de })).toBe("⇧⌘P");
    expect(shortcutKeys("Mod+Shift+P", { platform: "mac", t: de })).toEqual(["⇧", "⌘", "P"]);
  });
});

describe("shortcut platform", () => {
  const before = shortcutPlatform();
  afterEach(() => setShortcutPlatform(before));

  it("follows the platform reported by the core", () => {
    setShortcutPlatform("macos");
    expect(isMacShortcuts()).toBe(true);
    expect(formatShortcut("Mod+P", { t: en })).toBe("⌘P");
    setShortcutPlatform("linux");
    expect(isMacShortcuts()).toBe(false);
    expect(formatShortcut("Mod+P", { t: en })).toBe("Ctrl+P");
    setShortcutPlatform("windows");
    expect(formatShortcut("Mod+P", { t: de })).toBe("Strg+P");
  });

  it("corrects {{mod}} in the texts", () => {
    setShortcutPlatform("macos");
    expect(t("patches.apply.clipboardFailed")).toBe("The clipboard could not be read. Click into the field and paste with ⌘+V.");
    setShortcutPlatform("linux");
    expect(t("patches.apply.clipboardFailed")).toBe("The clipboard could not be read. Click into the field and paste with Ctrl+V.");
  });

  it("does not take a WebKitGTK user agent that claims to be a Mac for macOS", () => {
    const spoofed = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(detectPlatform(spoofed, "Linux x86_64")).toBe("linux");
    expect(detectPlatform(spoofed, "MacIntel")).toBe("mac");
    expect(detectPlatform("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15", "Linux x86_64")).toBe("linux");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0", "Win32")).toBe("windows");
  });
});

describe("ariaShortcut", () => {
  it("uses the standard key names in every language", () => {
    expect(ariaShortcut("Mod+Alt+F", { platform: "linux" })).toBe("Control+Alt+F");
    expect(ariaShortcut("Mod+Alt+F", { platform: "windows" })).toBe("Control+Alt+F");
    expect(ariaShortcut("Mod+Shift+P", { platform: "windows" })).toBe("Control+Shift+P");
    expect(ariaShortcut("Ctrl+Tab", { platform: "linux" })).toBe("Control+Tab");
  });

  it("names Command Meta on macOS and keeps Control apart", () => {
    expect(ariaShortcut("Mod+Alt+F", { platform: "mac" })).toBe("Alt+Meta+F");
    expect(ariaShortcut("Ctrl+Tab", { platform: "mac" })).toBe("Control+Tab");
  });

  it("writes keys as KeyboardEvent.key values", () => {
    expect(ariaShortcut("Esc", { platform: "linux" })).toBe("Escape");
    expect(ariaShortcut("Escape", { platform: "linux" })).toBe("Escape");
    expect(ariaShortcut("Alt+ArrowUp", { platform: "linux" })).toBe("Alt+ArrowUp");
    expect(ariaShortcut("Mod++", { platform: "linux" })).toBe("Control+Plus");
    expect(ariaShortcut("Mod+s", { platform: "linux" })).toBe("Control+S");
    expect(ariaShortcut("F2", { platform: "linux" })).toBe("F2");
  });

  it("does not depend on the current language or platform", () => {
    const before = shortcutPlatform();
    setShortcutPlatform("windows");
    expect(ariaShortcut("Mod+Alt+F")).toBe("Control+Alt+F");
    setShortcutPlatform(before);
  });
});
