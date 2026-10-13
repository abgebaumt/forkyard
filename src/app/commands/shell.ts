import { t } from "../../i18n";
import { activateTab, changeZoom, closeTab, newTab, openRepository, setZoom, ZOOM_STEP } from "../actions/repos";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { focusAreaSoon } from "./focus";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

const tabNumberCommands: AppCommand[] = Array.from({ length: 9 }, (_, index) => ({
  id: `tab.goto.${index + 1}`,
  title: index === 8 ? t("commands.tab.goto.last") : t("commands.tab.goto.number", { number: index + 1 }),
  group: "Tabs" as const,
  shortcut: `Mod+${index + 1}`,
  // Mod+9 jumps to the last tab, as in browsers.
  when: (ctx: CommandContext) => (index === 8 ? ctx.tabs.length > 0 : ctx.tabs.length > index),
  run: (ctx: CommandContext) => {
    const target = index === 8 ? ctx.tabs[ctx.tabs.length - 1] : ctx.tabs[index];
    if (target && !target.isActive) return activateTab(target.id);
  },
}));

export const commands: AppCommand[] = [
  {
    id: "tab.new",
    title: t("commands.tab.new.title"),
    group: "Tabs",
    shortcut: "Mod+T",
    keywords: kw("commands.tab.new.keywords"),
    run: () => newTab(),
  },
  {
    id: "tab.close",
    title: t("commands.tab.close.title"),
    group: "Tabs",
    shortcut: "Mod+W",
    when: (ctx) => Boolean(ctx.tabId),
    run: (ctx) => closeTab(ctx.tabId!),
  },
  {
    id: "tab.next",
    title: t("commands.tab.next.title"),
    group: "Tabs",
    shortcut: "Ctrl+Tab",
    when: (ctx) => ctx.tabs.length > 1,
    run: (ctx) => {
      const index = ctx.tabs.findIndex((tab) => tab.isActive);
      const next = ctx.tabs[(index + 1) % ctx.tabs.length];
      if (next) return activateTab(next.id);
    },
  },
  {
    id: "tab.previous",
    title: t("commands.tab.previous.title"),
    group: "Tabs",
    shortcut: "Ctrl+Shift+Tab",
    when: (ctx) => ctx.tabs.length > 1,
    run: (ctx) => {
      const index = ctx.tabs.findIndex((tab) => tab.isActive);
      const previous = ctx.tabs[(index - 1 + ctx.tabs.length) % ctx.tabs.length];
      if (previous) return activateTab(previous.id);
    },
  },
  ...tabNumberCommands,
  {
    id: "view.toggleLeftPanel",
    title: t("commands.view.toggleLeftPanel.title"),
    group: "Ansicht",
    shortcut: "Mod+J",
    when: hasRepo,
    run: (ctx) => ctx.store.toggleLeftPanel(ctx.tabId!),
  },
  {
    id: "view.toggleCommitPanel",
    title: t("commands.view.toggleCommitPanel.title"),
    group: "Ansicht",
    shortcut: "Mod+K",
    when: hasRepo,
    run: (ctx) => ctx.store.toggleRightPanel(ctx.tabId!),
  },
  {
    id: "app.palette",
    title: t("commands.app.palette.title"),
    group: "Allgemein",
    shortcut: "Mod+P",
    keywords: kw("commands.app.palette.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "palette", mode: "all" }),
  },
  {
    id: "view.search",
    title: t("commands.view.search.title"),
    group: "Ansicht",
    shortcut: "Mod+F",
    keywords: kw("commands.view.search.keywords"),
    when: hasRepo,
    run: (ctx) => {
      // Ctrl+F always opens (and then focuses the field); closing works with Esc or the button.
      ctx.store.setSearchOpen(ctx.tabId!, true);
    },
  },
  {
    id: "app.preferences",
    title: t("commands.app.preferences.title"),
    group: "Allgemein",
    shortcut: "Mod+,",
    keywords: kw("commands.app.preferences.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "preferences", section: "general" }),
  },
  {
    id: "app.shortcuts",
    title: t("commands.app.shortcuts.title"),
    group: "Allgemein",
    shortcut: "Mod+/",
    keywords: kw("commands.app.shortcuts.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "shortcuts" }),
  },
  {
    id: "app.activity",
    title: t("commands.app.activity.title"),
    group: "Allgemein",
    keywords: kw("commands.app.activity.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "activity" }),
  },
  {
    id: "view.zoomIn",
    title: t("commands.view.zoomIn.title"),
    group: "Ansicht",
    // The key shown is the one called "Plus" everywhere; "=" (the same key on the US layout) counts as an alias.
    shortcut: "Mod++",
    aliases: ["Mod+=", "Mod+Shift+="],
    run: () => changeZoom(ZOOM_STEP),
  },
  {
    id: "view.zoomOut",
    title: t("commands.view.zoomOut.title"),
    group: "Ansicht",
    shortcut: "Mod+-",
    run: () => changeZoom(-ZOOM_STEP),
  },
  {
    id: "view.zoomReset",
    title: t("commands.view.zoomReset.title"),
    group: "Ansicht",
    shortcut: "Mod+0",
    run: () => setZoom(1),
  },
  {
    id: "repo.open",
    title: t("commands.repo.open.title"),
    group: "Repository",
    shortcut: "Alt+O",
    aliases: ["Mod+O"],
    keywords: kw("commands.repo.open.keywords"),
    run: async () => {
      const result = await openRepository();
      // The folder dialog took the focus with it: continue in the graph of the opened repository.
      if (result?.ok && !document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) focusAreaSoon("center");
      return result;
    },
  },
  {
    id: "repo.clone",
    title: t("commands.repo.clone.title"),
    group: "Repository",
    keywords: kw("commands.repo.clone.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "clone" }),
  },
  {
    id: "repo.init",
    title: t("commands.repo.init.title"),
    group: "Repository",
    keywords: kw("commands.repo.init.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "init" }),
  },
];
