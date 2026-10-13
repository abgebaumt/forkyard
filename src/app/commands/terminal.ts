/**
 * Commands for the built-in terminal.
 *
 *   Alt+4    focus into the terminal (shows it if needed)
 *   Ctrl+`   show and hide – listed with the view commands in repo.ts
 *
 * From inside the terminal only the shortcuts for leaving and switching apply (F6, Shift+F6,
 * Alt+1…4, Ctrl+`, Ctrl+Tab); everything else goes to the shell. The list is in
 * src/screens/Terminal/index.tsx (LEAVE_COMMANDS).
 *
 * This file only depends on the sessions' remote control, not on xterm.js: the registry loads
 * it in the unit tests too.
 */
import { t } from "../../i18n";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { clearTerminal, endTerminal, restartTerminal, showTerminal } from "../../screens/Terminal/actions";
import { terminalControl } from "../../screens/Terminal/control";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const hasSession = (ctx: CommandContext) => hasRepo(ctx) && terminalControl.statusOf(ctx.tabId!) !== null;
const noSession = (ctx: CommandContext) => (hasRepo(ctx) ? t("commands.terminal.noSession") : t("commands.reason.repoTabOnly"));

export const commands: AppCommand[] = [
  {
    id: "terminal.focus",
    title: t("commands.terminal.focus.title"),
    group: "Ansicht",
    shortcut: "Alt+4",
    keywords: kw("commands.terminal.focus.keywords"),
    when: hasRepo,
    disabledReason: () => t("commands.reason.repoTabOnly"),
    run: (ctx) => showTerminal(ctx.tabId!),
  },
  {
    id: "terminal.restart",
    title: t("commands.terminal.restart.title"),
    group: "Ansicht",
    keywords: kw("commands.terminal.restart.keywords"),
    when: hasSession,
    disabledReason: noSession,
    run: (ctx) => restartTerminal(ctx.tabId!),
  },
  {
    id: "terminal.clear",
    title: t("commands.terminal.clear.title"),
    group: "Ansicht",
    keywords: kw("commands.terminal.clear.keywords"),
    when: hasSession,
    disabledReason: noSession,
    run: (ctx) => clearTerminal(ctx.tabId!),
  },
  {
    id: "terminal.end",
    title: t("commands.terminal.end.title"),
    group: "Ansicht",
    keywords: kw("commands.terminal.end.keywords"),
    when: hasSession,
    disabledReason: noSession,
    run: (ctx) => endTerminal(ctx.tabId!),
  },
];
