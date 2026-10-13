/**
 * Commands around the tab bar that go beyond the basic commands in shell.ts.
 * F2 itself is not a global shortcut: it applies to the focused tab (and in lists to their
 * entries) and is therefore listed with the fixed keys in the shortcut overview.
 */
import { t } from "../../i18n";
import { kw, type AppCommand } from "../commandTypes";
import { requestTabRename } from "../shell/tabAlias";

export const commands: AppCommand[] = [
  {
    id: "tab.rename",
    title: t("commands.tab.rename.title"),
    group: "Tabs",
    keywords: kw("commands.tab.rename.keywords"),
    when: (ctx) => Boolean(ctx.tab?.kind === "repo" && ctx.repoId && ctx.tabId),
    disabledReason: () => t("commands.tab.rename.repoOnly"),
    run: (ctx) => requestTabRename(ctx.tabId!),
  },
];
