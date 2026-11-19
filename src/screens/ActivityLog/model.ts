/** Pure parts of the activity log: times, durations and which entries show. */
import type { ActivityEntry } from "../../core";
import { locale } from "../../i18n";

const clock = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayAndClock = new Intl.DateTimeFormat(locale(), {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Local time to the second; on other days with the date in front. */
export function formatLogTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? clock.format(date) : dayAndClock.format(date).replace(",", "");
}

/** “840 ms”, “1.3 s”, “2 min 05 s”. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

export const failed = (entry: ActivityEntry) => entry.exitCode !== null && entry.exitCode !== 0;

/** The entries shown: only failed ones if wanted, and those whose command or output contains `needle` (lower case). */
export function visibleEntries(entries: ActivityEntry[], onlyErrors: boolean, needle: string): ActivityEntry[] {
  return entries.filter((entry) => {
    if (onlyErrors && !failed(entry)) return false;
    if (needle && !entry.command.toLowerCase().includes(needle) && !entry.output.toLowerCase().includes(needle)) return false;
    return true;
  });
}
