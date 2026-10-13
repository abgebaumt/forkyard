import { t } from "../../i18n";
import type { LfsStatus } from "../../core";
import { pruneLfs, pullLfs } from "../actions/lfs";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { qk } from "../queries";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
/** As long as the state is not loaded, "maybe installed" applies; otherwise the core reports it understandably. */
const lfsUsable = (ctx: CommandContext) => hasRepo(ctx) && (ctx.queryClient.getQueryData<LfsStatus>(qk.lfs(ctx.repoId!))?.installed ?? true);
const missingReason = (ctx: CommandContext) => (hasRepo(ctx) ? t("commands.lfs.missing") : null);

export const commands: AppCommand[] = [
  {
    id: "lfs.manage",
    title: t("commands.lfs.manage.title"),
    group: "Repository",
    keywords: kw("commands.lfs.manage.keywords"),
    when: hasRepo,
    run: (ctx) => ctx.store.openOverlay({ kind: "lfs" }),
  },
  {
    id: "lfs.pull",
    title: t("commands.lfs.pull.title"),
    group: "Repository",
    keywords: kw("commands.lfs.pull.keywords"),
    when: lfsUsable,
    disabledReason: missingReason,
    run: (ctx) => pullLfs(ctx.repoId!),
  },
  {
    id: "lfs.prune",
    title: t("commands.lfs.prune.title"),
    group: "Repository",
    keywords: kw("commands.lfs.prune.keywords"),
    when: lfsUsable,
    disabledReason: missingReason,
    run: (ctx) => pruneLfs(ctx.repoId!),
  },
];
