/**
 * Pending crash reports: on start (only a panic of the previous run) and from the command palette.
 * A hard end without a panic (kill -9, out of memory, a WebKit crash) cannot be told from a
 * deliberate kill, so on start it stays quiet and waits for the command.
 * One dialog per report, newest first: View / Save… / Discard. Closing the dialog keeps the
 * reports for later (command "Show crash reports"). Nothing is ever uploaded.
 */
import { useEffect } from "react";
import { core, type CrashReportSummary } from "../../core";
import { t } from "../../i18n";
import { choose, showOutput } from "../../app/dialogs";
import { showError } from "../../app/run";
import { toast } from "../../ui/Feedback";
import { pickSavePath } from "../../app/savePath";
import { crashReportFileName, crashReportLine, crashReportTitle } from "./model";

type Choice = "view" | "save" | "discard";

let running = false;

/** `onStart`: only panics are offered, and nothing is said when there are none. */
export async function offerCrashReports(options: { onStart: boolean }): Promise<void> {
  if (running) return;
  running = true;
  try {
    let reports: CrashReportSummary[];
    try {
      reports = await core.crashReportsList();
      if (options.onStart) reports = reports.filter((report) => report.kind === "panic");
    } catch (error) {
      if (!options.onStart) showError(t("crash.loadFailed"), error);
      return;
    }
    if (reports.length === 0) {
      if (!options.onStart) toast({ tone: "info", title: t("crash.none") });
      return;
    }
    for (let index = 0; index < reports.length; index += 1) {
      const kept = await handleReport(reports[index]!, reports.length, index);
      // Closed without a choice: the remaining reports wait for later.
      if (kept === "closed") return;
    }
  } finally {
    running = false;
  }
}

async function handleReport(report: CrashReportSummary, count: number, index: number): Promise<"closed" | "next"> {
  for (;;) {
    const choice = await choose<Choice>({
      title: crashReportTitle(count, index),
      description: t("crash.dialog.description", { line: crashReportLine(report) }),
      options: [
        { key: "view", label: t("crash.dialog.view"), description: t("crash.dialog.viewHint") },
        { key: "save", label: t("crash.dialog.save"), description: t("crash.dialog.saveHint") },
        { key: "discard", label: t("ui.discard"), description: t("crash.dialog.discardHint"), danger: true },
      ],
    });
    if (choice === null) return "closed";
    try {
      if (choice === "view") {
        await showOutput(t("crash.view.title"), await core.crashReportGet({ id: report.id }));
      } else if (choice === "save") {
        const path = await pickSavePath({
          title: t("crash.save.title"),
          defaultPath: crashReportFileName(report),
          filters: [{ name: t("crash.save.filterName"), extensions: ["txt"] }],
        });
        if (path) {
          await core.crashReportSave({ id: report.id, path });
          toast({ tone: "success", title: t("crash.save.done"), description: path });
        }
      } else {
        await core.crashReportDiscard({ id: report.id });
        toast({ tone: "info", title: t("crash.discarded") });
        return "next";
      }
    } catch (error) {
      showError(choice === "save" ? t("crash.save.failed") : t("crash.loadFailed"), error);
    }
  }
}

let offeredOnStart = false;

/** Once per window, as soon as the shell is up: offer what the previous run left behind. */
export function useCrashReportsOnStart(ready: boolean): void {
  useEffect(() => {
    if (!ready || offeredOnStart) return;
    offeredOnStart = true;
    void offerCrashReports({ onStart: true });
  }, [ready]);
}
