/** The `forkyard` command on the command line: link it where no installer does (AppImage, macOS). */
import { t } from "../../i18n";
import { installCli } from "../actions/cli";
import { kw, type AppCommand } from "../commandTypes";

export const commands: AppCommand[] = [
  {
    id: "app.installCli",
    title: t("commands.app.installCli.title"),
    group: "Allgemein",
    keywords: kw("commands.app.installCli.keywords"),
    when: (ctx) => ctx.platform !== "windows",
    run: () => installCli(),
  },
];
