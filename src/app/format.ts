/**
 * Time and number formats in the UI language. Times arrive as UTC (ISO) or ms and are shown in
 * local time. The language is fixed at load time (switching it reloads the UI).
 */
import type { DateFormat } from "../core";
import { locale, t } from "../i18n";

const relative = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
const dateTime = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" });
const shortDate = new Intl.DateTimeFormat(locale(), { dateStyle: "medium" });

const toDate = (value: string | number | Date) => (value instanceof Date ? value : new Date(value));

/** Shown where a timestamp cannot be parsed (damaged commit, year beyond what can be represented). */
export const UNKNOWN_DATE = t("format.unknownDate");
const isValid = (date: Date) => !Number.isNaN(date.getTime());

/** Midnight (local time) of the day `date` falls on. */
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * "3 minutes ago", "yesterday", "2 months ago" (or the German equivalents …).
 *
 * "yesterday" and "2 days ago" are calendar days, not 24-hour blocks: a commit from 23:55 the
 * day before yesterday is still "2 days ago" at 05:00, one from 00:20 today is "23 hours ago"
 * at 23:30. Under 22 hours apart (and always on the same day) hours are shown.
 */
export function formatRelative(value: string | number | Date, now = Date.now()): string {
  const date = toDate(value);
  if (!isValid(date)) return UNKNOWN_DATE;
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return t("format.justNow");
  if (abs < 45 * 60) return relative.format(Math.round(seconds / 60), "minute");
  // Math.round evens out the hour a day is longer or shorter when the clocks change (DST).
  const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86_400_000);
  if (abs < 22 * 3600 || days === 0) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 26 * 86400) return relative.format(days, "day");
  if (abs < 320 * 86400) return relative.format(Math.round(seconds / (30 * 86400)), "month");
  return relative.format(Math.round(seconds / (365 * 86400)), "year");
}

/** Date according to the "Date format" setting. */
export function formatDate(value: string | number | Date, format: DateFormat = "relative"): string {
  const date = toDate(value);
  if (!isValid(date)) return UNKNOWN_DATE;
  if (format === "relative") return formatRelative(date);
  if (format === "iso") {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return dateTime.format(date);
}

/** `Intl.DateTimeFormat.format` throws on an invalid date – that must never break the view. */
const safeFormat = (formatter: Intl.DateTimeFormat, value: string | number | Date) => {
  const date = toDate(value);
  return isValid(date) ? formatter.format(date) : UNKNOWN_DATE;
};
export const formatDateTime = (value: string | number | Date) => safeFormat(dateTime, value);
export const formatShortDate = (value: string | number | Date) => safeFormat(shortDate, value);

/** Short SHA (7 characters). */
export const shortSha = (sha: string) => sha.slice(0, 7);

const plural = new Intl.PluralRules(locale());

/** "1 file" / "3 files". For new texts prefer `t()` with `count` (plurals in the translations). */
export function countLabel(count: number, one: string, many: string): string {
  return `${count.toLocaleString(locale())} ${plural.select(count) === "one" ? one : many}`;
}

/** Human-readable bytes: "12,4 KB" or "12.4 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale(), { maximumFractionDigits: 1 })} ${units[unit]}`;
}
