/** Reopen the pending crash reports (the dialog from the start, on demand). */
import { t } from "../../i18n";
import { offerCrashReports } from "../../screens/CrashReport";
import { kw, type AppCommand } from "../commandTypes";

export const commands: AppCommand[] = [
  {
    id: "app.crashReports",
    title: t("commands.app.crashReports.title"),
    group: "Allgemein",
    keywords: kw("commands.app.crashReports.keywords"),
    run: () => offerCrashReports({ quietIfNone: false }),
  },
];
