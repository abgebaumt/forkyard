import { t } from "../../i18n";
import { openBranchCleanup } from "../../screens/BranchCleanup/actions";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

export const commands: AppCommand[] = [
  {
    id: "repo.cleanupBranches",
    title: t("commands.repo.cleanupBranches.title"),
    group: "Repository",
    keywords: kw("commands.repo.cleanupBranches.keywords"),
    when: hasRepo,
    run: (ctx) => openBranchCleanup(ctx.tabId!),
  },
];
