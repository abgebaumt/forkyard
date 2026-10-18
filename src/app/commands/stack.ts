/**
 * Palette command for stacked pull requests (Paket 8.1): opens the stack view for the checked-out
 * branch. The same view opens from every local branch's context menu.
 */
import { t } from "../../i18n";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const currentBranch = (ctx: CommandContext) => (ctx.status?.head.kind === "branch" ? ctx.status.head.branch : null);

export const commands: AppCommand[] = [
  {
    id: "pr.stack",
    title: t("commands.pr.stack.title"),
    group: "Branch",
    keywords: [...kw("commands.pr.keywords"), ...kw("commands.pr.stack.keywords")],
    when: (ctx) => Boolean(ctx.repoId && ctx.tabId && currentBranch(ctx)),
    disabledReason: (ctx) => (ctx.repoId && !currentBranch(ctx) ? t("commands.pr.stack.noBranch") : null),
    run: (ctx) => ctx.store.setCenter(ctx.tabId!, { kind: "stack", branch: currentBranch(ctx)! }),
  },
];
