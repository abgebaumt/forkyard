import { t } from "../../i18n";
import type { Submodule } from "../../core";
import { updateSubmodules } from "../actions/submodules";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { qk } from "../queries";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
/** Unknown (not loaded yet) counts as "maybe" – the core then answers with an empty list. */
const mayHaveSubmodules = (ctx: CommandContext) => hasRepo(ctx) && (ctx.queryClient.getQueryData<Submodule[]>(qk.submodules(ctx.repoId!))?.length ?? 1) > 0;

export const commands: AppCommand[] = [
  {
    id: "submodule.add",
    title: t("commands.submodule.add.title"),
    group: "Repository",
    keywords: kw("commands.submodule.add.keywords"),
    when: hasRepo,
    run: (ctx) => ctx.store.openOverlay({ kind: "add_submodule" }),
  },
  {
    id: "submodule.updateAll",
    title: t("commands.submodule.updateAll.title"),
    group: "Repository",
    keywords: kw("commands.submodule.updateAll.keywords"),
    when: mayHaveSubmodules,
    disabledReason: (ctx) => (hasRepo(ctx) ? t("commands.submodule.updateAll.none") : null),
    run: (ctx) => updateSubmodules(ctx.repoId!, null, { init: true }),
  },
];
