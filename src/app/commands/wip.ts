import { t } from "../../i18n";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { commitChanges, discardEverything, stageEverything, unstageEverything } from "../../screens/WipPanel/actions";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
/** The local changes are visible (WIP row selected, Commit Panel open, commit form in front). */
const wipShown = (ctx: CommandContext) => {
  if (!hasRepo(ctx)) return false;
  // Without an entry in the store, the default of a new tab applies: the local changes are selected.
  const view = ctx.view;
  return view === null || (view.selection?.kind === "wip" && view.rightPanel === "details" && !view.rightCollapsed);
};

/** Commands of the core loop: stage, unstage, commit. */
export const commands: AppCommand[] = [
  {
    id: "wip.stageAll",
    title: t("commands.wip.stageAll.title"),
    group: "Commit",
    shortcut: "Mod+Shift+S",
    keywords: kw("commands.wip.stageAll.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.status?.unstaged.length),
    run: (ctx) => stageEverything(ctx.repoId!, ctx.tabId!),
  },
  {
    id: "wip.unstageAll",
    title: t("commands.wip.unstageAll.title"),
    group: "Commit",
    shortcut: "Mod+Shift+U",
    keywords: kw("commands.wip.unstageAll.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.status?.staged.length),
    run: (ctx) => unstageEverything(ctx.repoId!, ctx.tabId!),
  },
  {
    id: "wip.commit",
    title: t("commands.wip.commit.title"),
    group: "Commit",
    shortcut: "Mod+Enter",
    keywords: kw("commands.wip.commit.keywords"),
    when: wipShown,
    run: (ctx) => commitChanges(ctx.repoId!, ctx.tabId!),
  },
  {
    id: "wip.commitAll",
    title: t("commands.wip.commitAll.title"),
    group: "Commit",
    shortcut: "Mod+Shift+Enter",
    keywords: kw("commands.wip.commitAll.keywords"),
    when: wipShown,
    run: (ctx) => commitChanges(ctx.repoId!, ctx.tabId!, { stageAll: true }),
  },
  {
    id: "wip.discardAll",
    title: t("commands.wip.discardAll.title"),
    group: "Commit",
    keywords: kw("commands.wip.discardAll.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.status && ctx.status.unstaged.length + ctx.status.staged.length > 0 && !ctx.status.operation),
    run: (ctx) => discardEverything(ctx.repoId!, ctx.tabId!),
  },
];
