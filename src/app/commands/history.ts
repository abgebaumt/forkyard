/**
 * Commands around the history: collapse or expand all merges in the graph, show the reflog.
 * They change nothing in the repository.
 */
import { t } from "../../i18n";
import { setAllMergesCollapsed } from "../actions/collapse";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const repoOnly = (ctx: CommandContext) => (hasRepo(ctx) ? null : t("commands.reason.repoTabOnly"));

/** The change takes effect in the graph: if a diff or a file is in the centre, the graph comes back. */
function showGraph(ctx: CommandContext) {
  if (ctx.tabId && ctx.view && ctx.view.center.kind !== "graph") ctx.store.closeCenter(ctx.tabId);
}

export const commands: AppCommand[] = [
  {
    id: "graph.collapseAllMerges",
    title: t("commands.graph.collapseAllMerges.title"),
    group: "Ansicht",
    shortcut: "Mod+Shift+[",
    // Code editors fold with the same keys: there they keep their meaning.
    textEditing: true,
    keywords: kw("commands.graph.collapseAllMerges.keywords"),
    when: hasRepo,
    disabledReason: repoOnly,
    run: (ctx) => {
      showGraph(ctx);
      return setAllMergesCollapsed(ctx.repoId!, true);
    },
  },
  {
    id: "graph.expandAllMerges",
    title: t("commands.graph.expandAllMerges.title"),
    group: "Ansicht",
    shortcut: "Mod+Shift+]",
    textEditing: true,
    keywords: kw("commands.graph.expandAllMerges.keywords"),
    when: hasRepo,
    disabledReason: repoOnly,
    run: (ctx) => {
      showGraph(ctx);
      return setAllMergesCollapsed(ctx.repoId!, false);
    },
  },
  {
    id: "history.reflog",
    title: t("commands.history.reflog.title"),
    group: "Repository",
    keywords: kw("commands.history.reflog.keywords"),
    when: hasRepo,
    disabledReason: repoOnly,
    run: (ctx) => ctx.store.openReflog(ctx.tabId!, null),
  },
];
