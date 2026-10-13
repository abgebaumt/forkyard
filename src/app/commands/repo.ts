import { t } from "../../i18n";
import type { Remote, Stash } from "../../core";
import { createBranch, selectedBranchStart } from "../actions/branches";
import { openExternal } from "../actions/files";
import { abortOperation, continueOperation } from "../actions/merge";
import { forgetRepo } from "../actions/repos";
import { popStash, stashChanges } from "../actions/stash";
import { fetchAll, pull, pullModeLabels, push } from "../actions/sync";
import { redo, undo } from "../actions/undo";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { qk } from "../queries";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const hasRemote = (ctx: CommandContext) =>
  hasRepo(ctx) && (ctx.queryClient.getQueryData<Remote[]>(qk.remotes(ctx.repoId!))?.length ?? 1) > 0;
const onBranch = (ctx: CommandContext) => ctx.status?.head.kind !== "detached";
const hasChanges = (ctx: CommandContext) =>
  Boolean(ctx.status && ctx.status.unstaged.length + ctx.status.staged.length > 0);

export const commands: AppCommand[] = [
  {
    id: "repo.undo",
    title: t("commands.repo.undo.title"),
    group: "Repository",
    shortcut: "Mod+Z",
    textEditing: true,
    when: hasRepo,
    run: (ctx) => undo(ctx.repoId!),
  },
  {
    id: "repo.redo",
    title: t("commands.repo.redo.title"),
    group: "Repository",
    shortcut: "Mod+Y",
    aliases: ["Mod+Shift+Z"],
    textEditing: true,
    when: hasRepo,
    run: (ctx) => redo(ctx.repoId!),
  },
  {
    id: "sync.fetch",
    title: t("commands.sync.fetch.title"),
    group: "Remote",
    shortcut: "Mod+Shift+L",
    when: hasRemote,
    run: (ctx) => fetchAll(ctx.repoId!),
  },
  {
    id: "sync.pull",
    title: t("commands.sync.pull.title"),
    group: "Remote",
    shortcut: "Mod+Shift+D",
    keywords: Object.values(pullModeLabels),
    when: (ctx) => hasRemote(ctx) && onBranch(ctx),
    run: (ctx) => pull(ctx.repoId!, null, ctx.tabId),
  },
  {
    id: "sync.pull.rebase",
    title: pullModeLabels.rebase,
    group: "Remote",
    when: (ctx) => hasRemote(ctx) && onBranch(ctx),
    run: (ctx) => pull(ctx.repoId!, "rebase", ctx.tabId),
  },
  {
    id: "sync.pull.ffOnly",
    title: pullModeLabels.ff_only,
    group: "Remote",
    when: (ctx) => hasRemote(ctx) && onBranch(ctx),
    run: (ctx) => pull(ctx.repoId!, "ff_only", ctx.tabId),
  },
  {
    id: "sync.push",
    title: t("commands.sync.push.title"),
    group: "Remote",
    shortcut: "Mod+Shift+P",
    when: (ctx) => hasRemote(ctx) && onBranch(ctx),
    run: (ctx) => push(ctx.repoId!, { tabId: ctx.tabId }),
  },
  {
    id: "branch.create",
    title: t("commands.branch.create.title"),
    group: "Branch",
    shortcut: "Mod+B",
    when: (ctx) => hasRepo(ctx) && ctx.status?.head.kind !== "unborn",
    // With exactly one commit selected in the graph, the branch starts there, otherwise at HEAD.
    run: (ctx) => createBranch(ctx.repoId!, { start: selectedBranchStart(ctx.repoId!, ctx.view?.selection ?? null), tabId: ctx.tabId }),
  },
  {
    id: "stash.create",
    title: t("commands.stash.create.title"),
    group: "Stash",
    // Ctrl+Shift+S belongs to "Stage all" (src/app/commands/wip.ts); stash and pop live on Alt.
    shortcut: "Alt+S",
    when: (ctx) => hasRepo(ctx) && hasChanges(ctx),
    run: (ctx) => stashChanges(ctx.repoId!),
  },
  {
    id: "stash.createNamed",
    title: t("commands.stash.createNamed.title"),
    group: "Stash",
    when: (ctx) => hasRepo(ctx) && hasChanges(ctx),
    run: (ctx) => ctx.store.openStashForm(ctx.tabId!),
  },
  {
    id: "stash.pop",
    title: t("commands.stash.pop.title"),
    group: "Stash",
    shortcut: "Alt+P",
    when: (ctx) => hasRepo(ctx) && (ctx.queryClient.getQueryData<Stash[]>(qk.stashes(ctx.repoId!))?.length ?? 0) > 0,
    run: (ctx) => popStash(ctx.repoId!, 0, ctx.tabId),
  },
  {
    id: "commit.showWip",
    title: t("commands.commit.showWip.title"),
    group: "Commit",
    keywords: kw("commands.commit.showWip.keywords"),
    when: hasRepo,
    run: (ctx) => {
      ctx.store.selectWip(ctx.tabId!);
      ctx.store.closeCenter(ctx.tabId!);
    },
  },
  {
    id: "operation.continue",
    title: t("commands.operation.continue.title"),
    group: "Repository",
    keywords: kw("commands.operation.continue.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.status?.operation) && ctx.status!.conflicted.length === 0,
    run: (ctx) => continueOperation(ctx.repoId!, null, ctx.tabId),
  },
  {
    id: "operation.abort",
    title: t("commands.operation.abort.title"),
    group: "Repository",
    keywords: kw("commands.operation.abort.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.status?.operation),
    run: (ctx) => abortOperation(ctx.repoId!, ctx.status!.operation!.kind),
  },
  {
    id: "view.terminal",
    title: t("commands.view.terminal.title"),
    group: "Ansicht",
    shortcut: "Mod+`",
    when: hasRepo,
    run: (ctx) => ctx.store.toggleTerminal(ctx.tabId!),
  },
  {
    id: "view.graph",
    title: t("commands.view.graph.title"),
    group: "Ansicht",
    when: (ctx) => hasRepo(ctx) && ctx.view?.center.kind !== "graph",
    run: (ctx) => ctx.store.closeCenter(ctx.tabId!),
  },
  {
    id: "repo.openFileManager",
    title: t("commands.repo.openFileManager.title"),
    group: "Repository",
    shortcut: "Alt+D",
    keywords: kw("commands.repo.openFileManager.keywords"),
    when: hasRepo,
    run: (ctx) => openExternal(ctx.repoId!, "file_manager"),
  },
  {
    id: "repo.openTerminal",
    title: t("commands.repo.openTerminal.title"),
    group: "Repository",
    shortcut: "Alt+T",
    keywords: kw("commands.repo.openTerminal.keywords"),
    when: hasRepo,
    run: (ctx) => openExternal(ctx.repoId!, "terminal"),
  },
  {
    id: "repo.openEditor",
    title: t("commands.repo.openEditor.title"),
    group: "Repository",
    shortcut: "Alt+E",
    keywords: kw("commands.repo.openEditor.keywords"),
    when: hasRepo,
    run: (ctx) => openExternal(ctx.repoId!, "editor"),
  },
  {
    id: "remote.add",
    title: t("commands.remote.add.title"),
    group: "Remote",
    when: hasRepo,
    run: (ctx) => ctx.store.openOverlay({ kind: "add_remote" }),
  },
  {
    id: "repo.forget",
    title: t("commands.repo.forget.title"),
    group: "Repository",
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.tab),
    run: (ctx) =>
      forgetRepo({ id: ctx.repoId!, name: ctx.tab!.title, alias: null, path: ctx.tab!.path ?? "" }),
  },
];
