/** The submenu "Custom commands" of the context menus (commit, branch, file, submodule). */
import { SquareTerminal } from "lucide-react";
import type { CustomCommandContext, CustomCommandList, CustomCommandScope, Id } from "../../core";
import { menuItem } from "../../components/SideSection";
import { commandsFor } from "../../screens/CustomCommands/model";
import type { MenuEntry } from "../../ui/Menu";
import { t } from "../../i18n";
import { runCustomCommand } from "../actions/customCommands";
import { qk, queryClient } from "../queries";

/** Separator plus submenu, or nothing if no loaded command has this scope. */
export function customCommandEntries(repoId: Id, scope: CustomCommandScope, context: CustomCommandContext): MenuEntry[] {
  const list = queryClient.getQueryData<CustomCommandList>(qk.customCommands(repoId));
  const entries = commandsFor(list?.commands, scope);
  if (entries.length === 0) return [];
  return [
    { type: "separator" },
    {
      label: t("menus.custom.title"),
      icon: <SquareTerminal className="size-icon" aria-hidden />,
      children: entries.map((entry) =>
        menuItem(entry.command.title, null, () => void runCustomCommand(repoId, entry, context), {
          tooltip: entry.source === "repo" ? t("menus.custom.fromRepo") : undefined,
          blocked: entry.runnable ? null : t("menus.custom.untrusted"),
        }),
      ),
    },
  ];
}
