/**
 * Commands around the history: collapse or expand all merges in the graph, show the reflog, and
 * mark the commit under test while a bisect runs.
 */
import { t } from "../../i18n";
import { cachedBisect } from "../actions/context";
import { endBisect, markBisect } from "../../screens/Bisect/actions";
import { autopilotAccessFor, autopilotRunning, startAutopilot } from "../../screens/Bisect/autopilotActions";
import { setAllMergesCollapsed } from "../actions/collapse";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const repoOnly = (ctx: CommandContext) => (hasRepo(ctx) ? null : t("commands.reason.repoTabOnly"));
const bisectRunning = (ctx: CommandContext) => Boolean(ctx.repoId && cachedBisect(ctx.repoId)?.active);
const notRunning = (ctx: CommandContext) => (!hasRepo(ctx) ? t("commands.reason.repoTabOnly") : bisectRunning(ctx) ? null : t("commands.bisect.notRunning"));

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
  {
    id: "bisect.good",
    title: t("commands.bisect.good.title"),
    group: "Commit",
    when: bisectRunning,
    disabledReason: notRunning,
    run: (ctx) => markBisect(ctx.repoId!, "good", ctx.tabId),
  },
  {
    id: "bisect.bad",
    title: t("commands.bisect.bad.title"),
    group: "Commit",
    when: bisectRunning,
    disabledReason: notRunning,
    run: (ctx) => markBisect(ctx.repoId!, "bad", ctx.tabId),
  },
  {
    id: "bisect.skip",
    title: t("commands.bisect.skip.title"),
    group: "Commit",
    when: bisectRunning,
    disabledReason: notRunning,
    run: (ctx) => markBisect(ctx.repoId!, "skip", ctx.tabId),
  },
  {
    id: "bisect.end",
    title: t("commands.bisect.end.title"),
    group: "Commit",
    when: bisectRunning,
    disabledReason: notRunning,
    run: (ctx) => endBisect(ctx.repoId!, ctx.tabId),
  },
  {
    id: "bisect.autopilot",
    title: t("commands.bisect.autopilot.title"),
    group: "Commit",
    keywords: kw("commands.bisect.autopilot.keywords"),
    // An AI element: hidden while AI is not set up, off, or off for this repository (spec 1.3).
    hidden: (ctx) => autopilotAccessFor(ctx.repoId) === "hidden",
    when: (ctx) => hasRepo(ctx) && !autopilotRunning(ctx.repoId),
    disabledReason: (ctx) => (!hasRepo(ctx) ? t("commands.reason.repoTabOnly") : autopilotRunning(ctx.repoId) ? t("commands.bisect.autopilot.running") : null),
    run: (ctx) => startAutopilot(ctx.repoId!, [], ctx.tabId),
  },
];
