/**
 * "Review and push …" in the palette (v1.2, spec 6.2) – hidden wherever the AI review is not
 * visible (AI off or not set up, function off, "AI off for this repository").
 */
import type { AiStatus, RepoSettings } from "../../core";
import { t } from "../../i18n";
import { reviewAndPush } from "../actions/sync";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { qk } from "../queries";
import { reviewOffered } from "../../screens/PushCheck/model";

const offered = (ctx: CommandContext): boolean =>
  Boolean(ctx.repoId) &&
  reviewOffered(ctx.queryClient.getQueryData<AiStatus>(qk.aiStatus), ctx.repoId ? ctx.queryClient.getQueryData<RepoSettings>(qk.repoSettings(ctx.repoId)) : undefined);

export const commands: AppCommand[] = [
  {
    id: "sync.push.review",
    title: t("pushCheck.review.command.title"),
    group: "Remote",
    keywords: kw("pushCheck.review.command.keywords"),
    hidden: (ctx) => !offered(ctx),
    when: (ctx) => Boolean(ctx.repoId && ctx.tabId) && !ctx.status?.operation && ctx.status?.head.kind === "branch",
    run: (ctx) => reviewAndPush(ctx.repoId!, { tabId: ctx.tabId }),
  },
];
