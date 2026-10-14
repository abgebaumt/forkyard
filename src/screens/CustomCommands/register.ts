/** Puts the custom commands with scope `repo` into the command palette of the active repository. */
import { useEffect } from "react";
import type { Id } from "../../core";
import { runCustomCommand } from "../../app/actions/customCommands";
import { kw, type AppCommand } from "../../app/commandTypes";
import { useCustomCommandList } from "../../app/queries";
import { registerCommands } from "../../app/registry";
import { t } from "../../i18n";
import { commandsFor } from "./model";

export function useCustomCommandRegistration(repoId: Id | null): void {
  const { data } = useCustomCommandList(repoId);
  useEffect(() => {
    if (!repoId) return;
    const entries = commandsFor(data?.commands, "repo");
    if (entries.length === 0) return;
    const commands: AppCommand[] = entries.map((entry) => ({
      id: `custom.${entry.key}`,
      title: t("commands.custom.title", { title: entry.command.title }),
      group: "Repository",
      keywords: kw("commands.custom.keywords", [entry.command.id]),
      when: (ctx) => ctx.repoId === repoId && entry.runnable,
      disabledReason: () => (entry.runnable ? null : t("commands.custom.untrusted")),
      run: (ctx) => runCustomCommand(ctx.repoId!, entry, {}),
    }));
    return registerCommands(commands);
  }, [data, repoId]);
}
