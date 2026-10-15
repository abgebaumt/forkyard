/** Texts around a pending crash report: the line that describes it, the dialog title, the file name. */
import type { CrashReportSummary } from "../../core";
import { locale, t } from "../../i18n";

const MAX_MESSAGE = 140;

/** Suggested name in the save dialog. */
export function crashReportFileName(report: CrashReportSummary): string {
  return `forkyard-crash-${report.id}.txt`;
}

function formatTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(time);
}

/** The line ends inside a sentence ("…: {{line}}. It contains…"), so a closing period goes. */
function shorten(message: string): string {
  const first = message.split("\n")[0]!.trim().replace(/\.+$/, "");
  return first.length > MAX_MESSAGE ? `${first.slice(0, MAX_MESSAGE - 1)}…` : first;
}

/** "14 Oct 2026, 12:00 · Internal error · Forkyard 1.0.0 · index out of bounds…" */
export function crashReportLine(report: CrashReportSummary): string {
  return t("crash.line", {
    time: formatTime(report.time),
    kind: t(report.kind === "panic" ? "crash.kind.panic" : "crash.kind.unexpectedExit"),
    version: report.appVersion,
    message: shorten(report.message),
  });
}

/** Dialog title; with several pending reports it says which one is shown (`index` from 0). */
export function crashReportTitle(count: number, index: number): string {
  return count > 1 ? t("crash.dialog.titleOf", { index: index + 1, count }) : t("crash.dialog.title");
}
