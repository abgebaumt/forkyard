/** Windows: a new one, the active tab into a new one (the keyboard way of dragging it out), quitting with every window kept. */
import { t } from "../../i18n";
import { kw, type AppCommand } from "../commandTypes";
import { moveTabToNewWindow, newWindow } from "../actions/windows";
import { quitApp } from "../closeGuard";

export const commands: AppCommand[] = [
  {
    id: "window.new",
    title: t("windows.menu.newWindow"),
    group: "Tabs",
    shortcut: "Mod+Shift+N",
    keywords: kw("commands.window.new.keywords"),
    run: () => newWindow(),
  },
  {
    id: "tab.moveToNewWindow",
    title: t("windows.menu.moveToNew"),
    group: "Tabs",
    keywords: kw("commands.tab.moveToNewWindow.keywords"),
    when: (ctx) => Boolean(ctx.tabId && ctx.tabs.length >= 2),
    disabledReason: (ctx) => (ctx.tabId ? t("windows.onlyTab") : null),
    run: (ctx) => moveTabToNewWindow(ctx.tabId!, null),
  },
  {
    id: "window.quit",
    title: t("windows.menu.quit"),
    group: "General",
    shortcut: "Mod+Q",
    keywords: kw("commands.window.quit.keywords"),
    run: () => quitApp(),
  },
];
