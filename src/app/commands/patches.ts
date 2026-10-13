/**
 * Commands for patches: create from the local changes, the selected commit or stash,
 * and apply a patch. The same actions are in the context menus.
 */
import { t } from "../../i18n";
import type { Stash } from "../../core";
import { applyPatch, patchFromCommit, patchFromStash, patchFromWip } from "../actions/patches";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { qk } from "../queries";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const changes = (ctx: CommandContext) => (ctx.status ? ctx.status.unstaged.length + ctx.status.staged.length : 0);
const oneCommit = (ctx: CommandContext) => (ctx.view?.selection?.kind === "commits" && ctx.view.selection.shas.length === 1 ? ctx.view.selection.shas[0]! : null);
const stashIndex = (ctx: CommandContext) => (ctx.view?.selection?.kind === "stash" ? ctx.view.selection.index : null);

export const commands: AppCommand[] = [
  {
    id: "patch.create.wip",
    title: t("commands.patch.create.wip.title"),
    group: "Commit",
    keywords: kw("commands.patch.create.wip.keywords"),
    when: (ctx) => hasRepo(ctx) && changes(ctx) > 0,
    disabledReason: (ctx) => (hasRepo(ctx) && ctx.status && changes(ctx) === 0 ? t("commands.patch.noChanges") : null),
    run: (ctx) => patchFromWip(ctx.repoId!),
  },
  {
    id: "patch.create.commit",
    title: t("commands.patch.create.commit.title"),
    group: "Commit",
    keywords: kw("commands.patch.create.commit.keywords"),
    when: (ctx) => hasRepo(ctx) && oneCommit(ctx) !== null,
    disabledReason: (ctx) => (hasRepo(ctx) && oneCommit(ctx) === null ? t("commands.patch.selectOneCommit") : null),
    run: (ctx) => patchFromCommit(ctx.repoId!, oneCommit(ctx)!),
  },
  {
    id: "patch.create.stash",
    title: t("commands.patch.create.stash.title"),
    group: "Stash",
    keywords: kw("commands.patch.create.stash.keywords"),
    when: (ctx) => hasRepo(ctx) && stashIndex(ctx) !== null && Boolean(ctx.queryClient.getQueryData<Stash[]>(qk.stashes(ctx.repoId!))?.some((stash) => stash.index === stashIndex(ctx))),
    disabledReason: (ctx) => (hasRepo(ctx) && stashIndex(ctx) === null ? t("commands.patch.selectStash") : null),
    run: (ctx) => patchFromStash(ctx.repoId!, { index: stashIndex(ctx)! }),
  },
  {
    id: "patch.apply",
    title: t("commands.patch.apply.title"),
    group: "Commit",
    keywords: kw("commands.patch.apply.keywords"),
    when: hasRepo,
    run: (ctx) => applyPatch(ctx.repoId!, ctx.tabId),
  },
];
