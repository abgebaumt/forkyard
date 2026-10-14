/** Commands of the statistics view (src/screens/Stats). */
import { t } from "../../i18n";
import { kw, type AppCommand } from "../commandTypes";
import { openStats } from "../../screens/Stats/actions";

export const commands: AppCommand[] = [
  {
    id: "stats.show",
    title: t("commands.stats.show.title"),
    group: "Repository",
    keywords: kw("commands.stats.show.keywords"),
    when: (ctx) => Boolean(ctx.repoId && ctx.tabId),
    run: (ctx) => openStats(ctx.tabId!),
  },
];
