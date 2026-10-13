/**
 * UI translations (i18next). Each area has its own file per language
 * `locales/<language>/<area>.json`; its content sits under the key `<area>`, so
 * `t("preferences.appearance.title")` for `locales/en/preferences.json` › `appearance.title`.
 *
 * The language is stored in localStorage and set synchronously when the module loads, so that
 * module-level texts (command lists, menus) are translated too. A change reloads the UI.
 */
import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";

export type Language = "en" | "de";
export type LanguageSetting = Language | "system";

export const LANGUAGES: Language[] = ["en", "de"];
const STORAGE_KEY = "forkyard.language";

type Tree = { [key: string]: string | Tree };

function collect(files: Record<string, unknown>): Record<Language, Tree> {
  const out: Record<Language, Tree> = { en: {}, de: {} };
  for (const [path, module] of Object.entries(files)) {
    const match = /\/locales\/(en|de)\/([\w-]+)\.json$/.exec(path);
    if (!match) continue;
    const [, language, area] = match as unknown as [string, Language, string];
    out[language][area] = ((module as { default?: Tree }).default ?? module) as Tree;
  }
  return out;
}

export const RESOURCES = collect(import.meta.glob("./locales/*/*.json", { eager: true }));

export function languageSetting(): LanguageSetting {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "de") return stored;
  } catch {
    // Without storage the system language applies.
  }
  return "system";
}

export function resolveLanguage(setting: LanguageSetting, system = globalThis.navigator?.language ?? "en"): Language {
  if (setting !== "system") return setting;
  return system.toLowerCase().startsWith("de") ? "de" : "en";
}

/** Saves the choice and reloads the UI so that all texts are in the new language. */
export function setLanguageSetting(setting: LanguageSetting): void {
  try {
    if (setting === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    return;
  }
  window.location.reload();
}

/** `?lang=en|de` sets the language – only in the development build (E2E driver, screenshots). */
function forcedLanguage(): Language | null {
  if (import.meta.env.MODE === "test") return "en";
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const wanted = new URLSearchParams(window.location.search).get("lang");
  return wanted === "en" || wanted === "de" ? wanted : null;
}

// Tests always run in English, regardless of the machine's system language.
const language = forcedLanguage() ?? resolveLanguage(languageSetting());

export type Platform = "windows" | "mac" | "linux";

/** Operating system from the WebView's user agent – synchronous, so that module-level texts fit too. */
export function detectPlatform(agent = globalThis.navigator?.userAgent ?? ""): Platform {
  if (/Mac|iPhone|iPad/i.test(agent)) return "mac";
  if (/Windows/i.test(agent)) return "windows";
  return "linux";
}

export const platform = detectPlatform();

/** Words that differ per operating system; in the texts as `{{mod}}` and `{{revealInFileManager}}`. */
export function platformWords(lang: Language, os: Platform): Record<string, string> {
  const reveal = {
    en: { windows: "Show in Explorer", mac: "Reveal in Finder", linux: "Show in file manager" },
    de: { windows: "Im Explorer zeigen", mac: "Im Finder zeigen", linux: "Im Dateimanager zeigen" },
  } as const;
  return { mod: os === "mac" ? "⌘" : lang === "de" ? "Strg" : "Ctrl", revealInFileManager: reveal[lang][os] };
}

void i18next.use(initReactI18next).init({
  lng: language,
  fallbackLng: "en",
  supportedLngs: LANGUAGES,
  resources: { en: { translation: RESOURCES.en }, de: { translation: RESOURCES.de } },
  interpolation: { escapeValue: false, defaultVariables: platformWords(language, platform) },
  returnNull: false,
  initAsync: false,
});

if (typeof document !== "undefined") document.documentElement.lang = language;

export const i18n = i18next;
/** Translates a key; placeholders as `{{name}}`, plural via `count` (`_one`/`_other`). */
export const t = i18next.t.bind(i18next);
export { useTranslation };

/** Locale for date and number formats (Intl). */
export function locale(): string {
  return i18next.language === "de" ? "de-DE" : "en-US";
}
