import { t } from "../../i18n";
import { openDigestCard } from "../../screens/DigestCard/actions";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

export const commands: AppCommand[] = [
  {
    id: "repo.digest",
    title: t("commands.repo.digest.title"),
    group: "Repository",
    keywords: kw("commands.repo.digest.keywords"),
    when: hasRepo,
    run: (ctx) => openDigestCard(ctx.repoId!),
  },
];
