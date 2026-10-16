import { t } from "../../i18n";
import { openRepoCleanup } from "../../screens/RepoCleanup";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

export const commands: AppCommand[] = [
  {
    id: "repo.cleanup",
    title: t("commands.repo.cleanup.title"),
    group: "Repository",
    keywords: kw("commands.repo.cleanup.keywords"),
    when: hasRepo,
    run: (ctx) => {
      void openRepoCleanup(ctx.repoId!);
    },
  },
];
