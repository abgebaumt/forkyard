/**
 * Entry points into the command palette with a preselected scope. Ctrl+P itself is in shell.ts.
 */
import { t } from "../../i18n";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

export const commands: AppCommand[] = [
  {
    id: "palette.commands",
    title: t("commands.palette.commands.title"),
    group: "Allgemein",
    shortcut: "F1",
    keywords: kw("commands.palette.commands.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "palette", mode: "commands" }),
  },
  {
    id: "palette.files",
    title: t("commands.palette.files.title"),
    group: "Datei",
    shortcut: "Mod+Shift+O",
    keywords: kw("commands.palette.files.keywords"),
    when: hasRepo,
    disabledReason: () => t("commands.reason.repoTabOnly"),
    run: (ctx) => ctx.store.openOverlay({ kind: "palette", mode: "files" }),
  },
  {
    id: "palette.branches",
    title: t("commands.palette.branches.title"),
    group: "Branch",
    shortcut: "Mod+Shift+B",
    keywords: kw("commands.palette.branches.keywords"),
    when: hasRepo,
    disabledReason: () => t("commands.reason.repoTabOnly"),
    run: (ctx) => ctx.store.openOverlay({ kind: "palette", mode: "branches" }),
  },
  {
    id: "palette.repos",
    title: t("commands.palette.repos.title"),
    group: "Repository",
    keywords: kw("commands.palette.repos.keywords"),
    run: (ctx) => ctx.store.openOverlay({ kind: "palette", mode: "repos" }),
  },
];
