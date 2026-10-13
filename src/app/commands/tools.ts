/**
 * Commands for external tools: show the open diff in the diff tool, open the open conflicted file
 * in the merge tool. The same actions are in the header of the views and in the File menu.
 */
import { t } from "../../i18n";
import { openDiffTool, openMergeTool } from "../actions/tools";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

export const commands: AppCommand[] = [
  {
    id: "file.externalDiff",
    title: t("commands.file.externalDiff.title"),
    group: "Datei",
    keywords: kw("commands.file.externalDiff.keywords"),
    when: (ctx) => hasRepo(ctx) && ctx.view?.center.kind === "diff",
    disabledReason: (ctx) => (hasRepo(ctx) && ctx.view?.center.kind !== "diff" ? t("commands.file.externalDiff.noDiff") : null),
    run: (ctx) => {
      const center = ctx.view!.center;
      if (center.kind === "diff") return openDiffTool(ctx.repoId!, center.path, center.source);
    },
  },
  {
    id: "file.externalMerge",
    title: t("commands.file.externalMerge.title"),
    group: "Datei",
    keywords: kw("commands.file.externalMerge.keywords"),
    when: (ctx) => hasRepo(ctx) && ctx.view?.center.kind === "conflict",
    disabledReason: (ctx) => (hasRepo(ctx) && ctx.view?.center.kind !== "conflict" ? t("commands.file.externalMerge.noConflict") : null),
    run: (ctx) => {
      const center = ctx.view!.center;
      if (center.kind === "conflict") return openMergeTool(ctx.repoId!, center.path);
    },
  },
];
