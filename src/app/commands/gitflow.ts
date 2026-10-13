/**
 * Commands for Gitflow: open the dialog, start feature/release/hotfix, finish the checked-out
 * Gitflow branch. So that menus and commands know whether Gitflow is set up and
 * which branches are running, this module keeps the active repository's state current in the cache.
 */
import { t } from "../../i18n";
import { core, type GitflowKind, type Tab } from "../../core";
import { cachedGitflow, gitflowBranch, gitflowKey, kindLabels, loadGitflow } from "../actions/gitflow";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { qk, queryClient } from "../queries";
import { openGitflow, openGitflowFinish } from "../../screens/Gitflow";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const currentBranch = (ctx: CommandContext) => (ctx.status?.head.kind === "branch" ? ctx.status.head.branch : null);
const currentFlow = (ctx: CommandContext) => (ctx.repoId ? gitflowBranch(ctx.repoId, currentBranch(ctx)) : undefined);
/** As long as the state is not loaded yet, "maybe" applies – the dialog then shows what is missing. */
const notSetUp = (ctx: CommandContext) => (ctx.repoId ? cachedGitflow(ctx.repoId)?.initialized === false : false);

const startCommand = (kind: GitflowKind): AppCommand => ({
  id: `gitflow.start.${kind}`,
  title: t("commands.gitflow.start.title", { kind: kindLabels[kind] }),
  group: "Branch",
  keywords: kw("commands.gitflow.start.keywords", [kind]),
  when: (ctx) => hasRepo(ctx) && !notSetUp(ctx),
  disabledReason: (ctx) => (hasRepo(ctx) && notSetUp(ctx) ? t("commands.gitflow.notSetUp") : null),
  run: (ctx) => openGitflow(ctx.repoId!, ctx.tabId, kind),
});

export const commands: AppCommand[] = [
  {
    id: "gitflow.open",
    title: t("commands.gitflow.open.title"),
    group: "Branch",
    keywords: kw("commands.gitflow.open.keywords"),
    when: hasRepo,
    run: (ctx) => openGitflow(ctx.repoId!, ctx.tabId),
  },
  startCommand("feature"),
  startCommand("release"),
  startCommand("hotfix"),
  {
    id: "gitflow.finish",
    title: t("commands.gitflow.finish.title"),
    group: "Branch",
    keywords: kw("commands.gitflow.finish.keywords"),
    when: (ctx) => hasRepo(ctx) && currentFlow(ctx) !== undefined,
    disabledReason: (ctx) => (!hasRepo(ctx) ? null : notSetUp(ctx) ? t("commands.gitflow.notSetUp") : t("commands.gitflow.finish.notFlowBranch")),
    run: (ctx) => {
      const target = currentFlow(ctx);
      if (target) return openGitflowFinish(ctx.repoId!, ctx.tabId, target);
    },
  },
];

// ---------------------------------------------------------------------------
// Keeping the state in the cache
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  /** Loads the active repository's state as soon as the tabs change. */
  const prefetchActive = () => {
    const tab = queryClient.getQueryData<Tab[]>(qk.tabs)?.find((item) => item.isActive);
    if (tab?.repoId && cachedGitflow(tab.repoId) === undefined) void loadGitflow(tab.repoId).catch(() => undefined);
  };
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "success" && event.query.queryKey[0] === "app" && event.query.queryKey[1] === "tabs") prefetchActive();
  });
  prefetchActive();
  // Branches and configuration change: the Gitflow state depends on both.
  core.on("repo:changed", ({ repoId, what }) => {
    if (what.some((part) => part === "refs" || part === "config" || part === "head") && queryClient.getQueryState(gitflowKey(repoId))) {
      void queryClient.invalidateQueries({ queryKey: gitflowKey(repoId) });
      if (!queryClient.getQueryCache().find({ queryKey: gitflowKey(repoId) })?.getObserversCount()) void loadGitflow(repoId).catch(() => undefined);
    }
  });
}
