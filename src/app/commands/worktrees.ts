import { t } from "../../i18n";
import { core, type Worktree } from "../../core";
import { folderName, openWorktree, pruneWorktrees, worktreeTarget } from "../actions/worktrees";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { pickFromList } from "../dialogs";
import { qk } from "../queries";
import { runAction } from "../run";
import { toast } from "../../ui/Feedback";
import { openWorktreeDialog } from "../../screens/Worktrees/Dialog";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

/** Picks one of the other worktrees from a list and opens it in a tab. */
async function pickAndOpen(ctx: CommandContext) {
  const repoId = ctx.repoId!;
  const result = await runAction(t("commands.worktree.open.loadAction"), () => core.worktreeList({ repoId }));
  if (!result.ok) return;
  ctx.queryClient.setQueryData(qk.worktrees(repoId), result.value);
  const others = result.value.filter((item) => !item.isCurrent && !item.isPrunable);
  if (others.length === 0) {
    toast({ tone: "info", title: t("commands.worktree.open.noneTitle"), description: t("commands.worktree.open.noneText") });
    return;
  }
  const describe = (item: Worktree) => [worktreeTarget(item), item.isMain ? t("commands.worktree.open.main") : null, item.isLocked ? t("commands.worktree.open.locked") : null].filter(Boolean).join(" · ");
  const path = await pickFromList({
    title: t("commands.worktree.open.dialogTitle"),
    description: t("commands.worktree.open.description"),
    label: t("commands.worktree.open.label"),
    items: others.map((item) => ({ key: item.path, label: folderName(item.path), description: describe(item) })),
    confirmLabel: t("commands.worktree.open.confirm"),
  });
  const chosen = others.find((item) => item.path === path);
  if (chosen) await openWorktree(chosen);
}

export const commands: AppCommand[] = [
  {
    id: "worktree.add",
    title: t("commands.worktree.add.title"),
    group: "Repository",
    keywords: kw("commands.worktree.add.keywords"),
    when: hasRepo,
    run: (ctx) => openWorktreeDialog(ctx.repoId!),
  },
  {
    id: "worktree.open",
    title: t("commands.worktree.open.title"),
    group: "Repository",
    keywords: kw("commands.worktree.open.keywords"),
    when: hasRepo,
    run: pickAndOpen,
  },
  {
    id: "worktree.prune",
    title: t("commands.worktree.prune.title"),
    group: "Repository",
    keywords: kw("commands.worktree.prune.keywords"),
    when: hasRepo,
    run: (ctx) => pruneWorktrees(ctx.repoId!),
  },
];
