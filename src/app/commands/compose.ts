/** "Compose commits …" in the palette: only where the AI element is visible. */
import type { AiStatus, RepoSettings } from "../../core";
import { t } from "../../i18n";
import { composeVisible, hasChanges, startCompose } from "../../screens/Compose/actions";
import { kw, type AppCommand } from "../commandTypes";
import { qk } from "../queries";

export const commands: AppCommand[] = [
  {
    id: "wip.compose",
    title: t("commands.wip.compose.title"),
    group: "Commit",
    keywords: kw("commands.wip.compose.keywords"),
    hidden: (ctx) =>
      !ctx.repoId ||
      !composeVisible(
        ctx.queryClient.getQueryData<AiStatus>(qk.aiStatus),
        ctx.queryClient.getQueryData<RepoSettings>(qk.repoSettings(ctx.repoId)),
      ),
    when: (ctx) => Boolean(ctx.tabId) && hasChanges(ctx.status),
    disabledReason: (ctx) => (hasChanges(ctx.status) ? null : t("ui.noChanges")),
    run: (ctx) => startCompose(ctx.tabId!),
  },
];
