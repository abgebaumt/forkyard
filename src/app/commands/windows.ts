/** Windows: a new one, and the active tab into a new one (the keyboard way of dragging it out). */
import { t } from "../../i18n";
import { kw, type AppCommand } from "../commandTypes";
import { moveTabToNewWindow, newWindow } from "../actions/windows";

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
];
