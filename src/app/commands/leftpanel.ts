import { t } from "../../i18n";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { getTabView, isLeftCollapsed } from "../store";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

/** The Left Panel's filter bar carries this attribute. */
const FILTER_SELECTOR = "[data-left-filter]";

/** Focuses the filter bar; if the panel was only just expanded, it is there after a few frames. */
function focusFilter(triesLeft = 30): void {
  const input = document.querySelector<HTMLInputElement>(FILTER_SELECTOR);
  if (input) {
    input.focus();
    input.select();
    return;
  }
  if (triesLeft > 0) requestAnimationFrame(() => focusFilter(triesLeft - 1));
}

export const commands: AppCommand[] = [
  {
    id: "leftPanel.filter",
    title: t("commands.leftPanel.filter.title"),
    group: "Ansicht",
    shortcut: "Mod+Alt+F",
    keywords: kw("commands.leftPanel.filter.keywords"),
    when: hasRepo,
    run: (ctx) => {
      // A collapsed panel comes back for this.
      if (isLeftCollapsed(getTabView(ctx.tabId!), ctx.store)) ctx.store.setLeftCollapsed(ctx.tabId!, false);
      focusFilter();
    },
  },
];
