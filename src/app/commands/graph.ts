/**
 * Commands for the graph view: pin a branch, highlight a branch, "only current
 * branch, upstream and target". They change nothing in the repository.
 */
import { t } from "../../i18n";
import { clearHighlight, currentHighlight, toggleStickyHighlight } from "../../components/graph/highlightStore";
import { isSmartOn, smartBlock, togglePinned, toggleSmartVisibility } from "../actions/graphView";
import { cachedRefs } from "../actions/context";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

/** The checked-out branch – null for a detached HEAD or while the branches are not loaded. */
const headBranch = (ctx: CommandContext) => (ctx.repoId ? (cachedRefs(ctx.repoId)?.locals.find((ref) => ref.isHead) ?? null) : null);

const needsBranch = (ctx: CommandContext) => (!ctx.repoId ? t("commands.reason.repoTabOnly") : headBranch(ctx) ? null : t("commands.reason.noBranch"));

/** The highlight takes effect in the graph: if a diff or a file is currently in the centre, the graph comes back. */
function showGraph(ctx: CommandContext) {
  if (ctx.tabId && ctx.view && ctx.view.center.kind !== "graph") ctx.store.closeCenter(ctx.tabId);
}

export const commands: AppCommand[] = [
  {
    id: "graph.smartVisibility",
    title: t("commands.graph.smartVisibility.title"),
    group: "Ansicht",
    keywords: kw("commands.graph.smartVisibility.keywords"),
    when: (ctx) => hasRepo(ctx) && (isSmartOn(ctx.repoId!) || smartBlock(ctx.repoId!) === null),
    disabledReason: (ctx) => (ctx.repoId ? smartBlock(ctx.repoId) : t("commands.reason.repoTabOnly")),
    run: (ctx) => {
      showGraph(ctx);
      return toggleSmartVisibility(ctx.repoId!);
    },
  },
  {
    id: "graph.pinCurrentBranch",
    title: t("commands.graph.pinCurrentBranch.title"),
    group: "Ansicht",
    keywords: kw("commands.graph.pinCurrentBranch.keywords"),
    when: (ctx) => hasRepo(ctx) && headBranch(ctx) !== null,
    disabledReason: needsBranch,
    run: (ctx) => {
      const branch = headBranch(ctx)!;
      showGraph(ctx);
      return togglePinned(ctx.repoId!, branch.fullName, branch.name);
    },
  },
  {
    id: "graph.highlightCurrentBranch",
    title: t("commands.graph.highlightCurrentBranch.title"),
    group: "Ansicht",
    keywords: kw("commands.graph.highlightCurrentBranch.keywords"),
    when: (ctx) => hasRepo(ctx) && (headBranch(ctx) !== null || Boolean(currentHighlight(ctx.repoId!)?.sticky)),
    disabledReason: needsBranch,
    run: (ctx) => {
      const branch = headBranch(ctx);
      showGraph(ctx);
      if (branch) toggleStickyHighlight(ctx.repoId!, branch.fullName);
      else clearHighlight(ctx.repoId!);
    },
  },
];
