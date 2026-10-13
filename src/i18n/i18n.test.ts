import { describe, expect, it } from "vitest";
import { RESOURCES, detectPlatform, platformWords, resolveLanguage, t } from ".";

type Tree = { [key: string]: string | Tree };

function keys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [prefix + key] : keys(value, `${prefix}${key}.`),
  );
}

/** Plural forms count as one key. */
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");

const SOURCES = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/i18n/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("Translations", () => {
  it("English and German have the same keys", () => {
    const en = new Set(keys(RESOURCES.en).map(base));
    const de = new Set(keys(RESOURCES.de).map(base));
    expect([...en].filter((key) => !de.has(key)), "fehlt auf Deutsch").toEqual([]);
    expect([...de].filter((key) => !en.has(key)), "fehlt auf Englisch").toEqual([]);
  });

  it("every literal key in the code exists", () => {
    const known = new Set(keys(RESOURCES.en).map(base));
    expect(Object.keys(SOURCES).length, "Quelltexte gelesen").toBeGreaterThan(100);
    const missing: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      for (const match of text.matchAll(/\b(?:t|i18nKey=)\(?\s*["'`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)["'`]/g)) {
        if (!known.has(match[1]!)) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("German system language yields German, everything else English", () => {
    expect(resolveLanguage("system", "de-AT")).toBe("de");
    expect(resolveLanguage("system", "fr-FR")).toBe("en");
    expect(resolveLanguage("de", "en-US")).toBe("de");
  });

  it("unknown keys do not silently fall back to empty", () => {
    expect(t("gibt.es.nicht")).toBe("gibt.es.nicht");
  });

  it("detects the operating system and names the Ctrl key and file manager accordingly", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit")).toBe("mac");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit")).toBe("linux");
    expect(platformWords("de", "windows")).toEqual({ mod: "Strg", revealInFileManager: "Im Explorer zeigen" });
    expect(platformWords("en", "mac")).toEqual({ mod: "⌘", revealInFileManager: "Reveal in Finder" });
    expect(platformWords("en", "linux").revealInFileManager).toBe("Show in file manager");
  });

  it("inserts the platform words into the texts", () => {
    expect(t("stash.onlyMarkedHint")).not.toContain("{{");
    expect(t("menus.showInFileManager")).not.toContain("{{");
  });
});

