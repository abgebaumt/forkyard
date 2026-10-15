/** "Check for updates…": asks GitHub now, whatever the setting says (see src/app/updates.ts). */
import { t } from "../../i18n";
import { kw, type AppCommand } from "../commandTypes";
import { checkNow } from "../updates";

export const commands: AppCommand[] = [
  {
    id: "app.checkForUpdates",
    title: t("updates.command.title"),
    group: "Allgemein",
    keywords: kw("updates.command.keywords"),
    run: () => checkNow(),
  },
];
