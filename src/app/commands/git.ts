/**
 * Git actions as commands for the command palette and keyboard shortcuts. Each command calls an action
 * from src/app/actions – the same one the toolbar and context menus call.
 *
 * Commands with "selected" work on the selection in the graph; "current" means the checked-out
 * branch. Where a target is missing, the command asks for it with a filterable list.
 */
import { t } from "../../i18n";
import { core, type Ref, type RefsSnapshot, type Remote, type Sha, type Stash } from "../../core";
import { chooseUpstream, checkout, checkoutCommit, createBranch, deleteBranches, pickBranch, renameBranch, setUpstream } from "../actions/branches";
import { copyText } from "../actions/clipboard";
import { discardPaths } from "../actions/files";
import { cherryPick, compareCommits, copyCommitMessage, resetBranch, revertCommit, rewordHead } from "../actions/history";
import { fastForward, interactiveRebase, mergeBranch, rebaseOnto } from "../actions/merge";
import { editRemote, removeRemote } from "../actions/remotes";
import { applyStash, dropStash, renameStash } from "../actions/stash";
import { fetchAll, push } from "../actions/sync";
import { createTag, deleteTag, pushTag } from "../actions/tags";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { pickFromList } from "../dialogs";
import { commitMenu, openMenuAtElement, stashMenu, wipMenu } from "../menus";
import { qk } from "../queries";
import { runAction } from "../run";
import { useAppStore } from "../store";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const refs = (ctx: CommandContext) => (ctx.repoId ? ctx.queryClient.getQueryData<RefsSnapshot>(qk.refs(ctx.repoId)) : undefined);
const remotes = (ctx: CommandContext) => (ctx.repoId ? ctx.queryClient.getQueryData<Remote[]>(qk.remotes(ctx.repoId)) : undefined);
const stashes = (ctx: CommandContext) => (ctx.repoId ? (ctx.queryClient.getQueryData<Stash[]>(qk.stashes(ctx.repoId)) ?? []) : []);
/** As long as the remotes are not loaded yet, "maybe" applies – otherwise the action reports it itself. */
const hasRemote = (ctx: CommandContext) => hasRepo(ctx) && (remotes(ctx)?.length ?? 1) > 0;
const idle = (ctx: CommandContext) => hasRepo(ctx) && !ctx.status?.operation;
const branchName = (ctx: CommandContext) => (ctx.status?.head.kind === "branch" ? ctx.status.head.branch : null);
const onBranch = (ctx: CommandContext) => idle(ctx) && branchName(ctx) !== null;
const headRef = (ctx: CommandContext): Ref | undefined => refs(ctx)?.locals.find((ref) => ref.isHead);
const hasCommits = (ctx: CommandContext) => hasRepo(ctx) && ctx.status?.head.kind !== "unborn";

/** The commits selected in the graph (in selection order). */
const selected = (ctx: CommandContext): Sha[] => (ctx.view?.selection?.kind === "commits" ? ctx.view.selection.shas : []);
const one = (ctx: CommandContext): Sha | null => {
  const shas = selected(ctx);
  return shas.length === 1 ? shas[0]! : null;
};
const oneSelected = (ctx: CommandContext) => idle(ctx) && one(ctx) !== null;

async function pickTag(ctx: CommandContext, title: string, confirmLabel: string): Promise<Ref | null> {
  const tags = refs(ctx)?.tags ?? [];
  const picked = await pickFromList({
    title,
    label: t("commands.pick.tag"),
    items: tags.map((tag) => ({ key: tag.fullName, label: tag.name, description: tag.isAnnotated ? t("commands.pick.annotated") : undefined })),
    empty: t("commands.pick.noTags"),
    confirmLabel,
    mono: true,
  });
  return picked ? (tags.find((tag) => tag.fullName === picked) ?? null) : null;
}

async function pickRemoteEntry(ctx: CommandContext, title: string, confirmLabel: string): Promise<Remote | null> {
  const list = remotes(ctx) ?? [];
  if (list.length === 1) return list[0]!;
  const picked = await pickFromList({
    title,
    label: t("commands.pick.remote"),
    items: list.map((remote) => ({ key: remote.name, label: remote.name, description: remote.fetchUrl })),
    empty: t("commands.pick.noRemotes"),
    confirmLabel,
  });
  return picked ? (list.find((remote) => remote.name === picked) ?? null) : null;
}

const resetCommands: AppCommand[] = (["soft", "mixed", "hard"] as const).map((mode) => ({
  id: `commit.reset.${mode}`,
  title: t(`commands.commit.reset.${mode}.title`),
  group: "Commit" as const,
  keywords: kw("commands.commit.reset.keywords", [mode]),
  when: oneSelected,
  run: (ctx: CommandContext) => resetBranch(ctx.repoId!, one(ctx)!, mode, ctx.tabId),
}));

export const commands: AppCommand[] = [
  // --- Selection -----------------------------------------------------------------------------
  {
    id: "selection.menu",
    title: t("commands.selection.menu.title"),
    group: "Allgemein",
    shortcut: "Mod+.",
    keywords: kw("commands.selection.menu.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.view?.selection),
    run: (ctx) => {
      const selection = ctx.view!.selection!;
      const base = { repoId: ctx.repoId!, tabId: ctx.tabId! };
      const anchor = document.activeElement !== document.body ? document.activeElement : null;
      if (selection.kind === "commits") openMenuAtElement(anchor, commitMenu({ ...base, shas: selection.shas }), t("commands.selection.menu.commits"));
      else if (selection.kind === "wip") openMenuAtElement(anchor, wipMenu(base), t("commands.selection.menu.wip"));
      else {
        const stash = stashes(ctx).find((item) => item.index === selection.index);
        if (stash) openMenuAtElement(anchor, stashMenu({ ...base, stash }), t("commands.selection.menu.stash"));
      }
    },
  },

  // --- Remote ---------------------------------------------------------------------------------
  {
    id: "sync.push.force",
    title: t("commands.sync.push.force.title"),
    group: "Remote",
    keywords: kw("commands.sync.push.force.keywords"),
    when: (ctx) => hasRemote(ctx) && onBranch(ctx),
    run: (ctx) => push(ctx.repoId!, { force: true, tabId: ctx.tabId }),
  },
  {
    id: "sync.cancel",
    title: t("commands.sync.cancel.title"),
    group: "Remote",
    keywords: kw("commands.sync.cancel.keywords"),
    when: (ctx) => hasRepo(ctx) && Object.values(ctx.store.jobs).some((job) => job.repoId === ctx.repoId),
    run: async (ctx) => {
      for (const job of Object.values(ctx.store.jobs)) {
        if (job.repoId === ctx.repoId) await runAction(t("commands.sync.cancel.action"), () => core.jobCancel({ jobId: job.id }));
      }
    },
  },
  {
    id: "remote.fetchOne",
    title: t("commands.remote.fetchOne.title"),
    group: "Remote",
    when: (ctx) => hasRepo(ctx) && (remotes(ctx)?.length ?? 0) > 1,
    run: async (ctx) => {
      const remote = await pickRemoteEntry(ctx, t("commands.remote.fetchOne.pick"), t("commands.remote.fetchOne.confirm"));
      if (remote) return fetchAll(ctx.repoId!, remote.name);
    },
  },
  {
    id: "remote.edit",
    title: t("commands.remote.edit.title"),
    group: "Remote",
    when: (ctx) => hasRepo(ctx) && (remotes(ctx)?.length ?? 0) > 0,
    run: async (ctx) => {
      const remote = await pickRemoteEntry(ctx, t("commands.remote.edit.pick"), t("commands.remote.edit.confirm"));
      if (remote) editRemote(remote.name);
    },
  },
  {
    id: "remote.remove",
    title: t("commands.remote.remove.title"),
    group: "Remote",
    when: (ctx) => hasRepo(ctx) && (remotes(ctx)?.length ?? 0) > 0,
    run: async (ctx) => {
      const remote = await pickRemoteEntry(ctx, t("commands.remote.remove.pick"), t("commands.pick.next"));
      if (remote) return removeRemote(ctx.repoId!, remote);
    },
  },

  // --- Branch ---------------------------------------------------------------------------------
  {
    id: "branch.checkout",
    title: t("commands.branch.checkout.title"),
    group: "Branch",
    keywords: kw("commands.branch.checkout.keywords"),
    when: (ctx) => idle(ctx) && hasCommits(ctx),
    run: async (ctx) => {
      const ref = await pickBranch(ctx.repoId!, { title: t("commands.branch.checkout.pick"), confirmLabel: t("commands.branch.checkout.confirm"), remotes: true, excludeCurrent: true });
      if (ref) return checkout(ctx.repoId!, ref.name, { tabId: ctx.tabId });
    },
  },
  {
    id: "branch.rename",
    title: t("commands.branch.rename.title"),
    group: "Branch",
    when: onBranch,
    run: (ctx) => renameBranch(ctx.repoId!, branchName(ctx)!),
  },
  {
    id: "branch.delete",
    title: t("commands.branch.delete.title"),
    group: "Branch",
    when: (ctx) => hasRepo(ctx) && (refs(ctx)?.locals.length ?? 2) > 1,
    run: async (ctx) => {
      const ref = await pickBranch(ctx.repoId!, { title: t("commands.branch.delete.pick"), description: t("commands.pick.confirmFollows"), confirmLabel: t("commands.pick.next"), excludeCurrent: true });
      if (ref) return deleteBranches(ctx.repoId!, [ref.name]);
    },
  },
  {
    id: "branch.merge",
    title: t("commands.branch.merge.title"),
    group: "Branch",
    keywords: kw("commands.branch.merge.keywords"),
    when: (ctx) => idle(ctx) && hasCommits(ctx),
    run: async (ctx) => {
      const target = branchName(ctx);
      const ref = await pickBranch(ctx.repoId!, { title: target ? t("commands.branch.merge.pickInto", { target }) : t("commands.branch.merge.pick"), confirmLabel: t("commands.branch.merge.confirm"), remotes: true, excludeCurrent: true });
      if (ref) return mergeBranch(ctx.repoId!, ref.name, undefined, ctx.tabId);
    },
  },
  {
    id: "branch.rebase",
    title: t("commands.branch.rebase.title"),
    group: "Branch",
    keywords: kw("commands.branch.rebase.keywords"),
    when: onBranch,
    run: async (ctx) => {
      const ref = await pickBranch(ctx.repoId!, { title: t("commands.branch.rebase.pick", { branch: branchName(ctx) }), confirmLabel: t("commands.branch.rebase.confirm"), remotes: true, excludeCurrent: true });
      if (ref) return rebaseOnto(ctx.repoId!, ref.name, null, ctx.tabId);
    },
  },
  {
    id: "branch.rebaseInteractive",
    title: t("commands.branch.rebaseInteractive.title"),
    group: "Branch",
    keywords: kw("commands.branch.rebaseInteractive.keywords"),
    when: onBranch,
    run: async (ctx) => {
      const ref = await pickBranch(ctx.repoId!, { title: t("commands.branch.rebaseInteractive.pick", { branch: branchName(ctx) }), confirmLabel: t("commands.pick.next"), remotes: true, excludeCurrent: true });
      if (ref) interactiveRebase(ctx.tabId!, ref.name);
    },
  },
  {
    id: "branch.fastForward",
    title: t("commands.branch.fastForward.title"),
    group: "Branch",
    keywords: kw("commands.branch.fastForward.keywords"),
    when: (ctx) => {
      const upstream = ctx.status?.upstream;
      return onBranch(ctx) && Boolean(upstream && !upstream.gone && upstream.behind > 0 && upstream.ahead === 0);
    },
    run: (ctx) => fastForward(ctx.repoId!, ctx.status!.upstream!.name, ctx.tabId),
  },
  {
    id: "branch.setUpstream",
    title: t("commands.branch.setUpstream.title"),
    group: "Branch",
    keywords: kw("commands.branch.setUpstream.keywords"),
    when: (ctx) => hasRepo(ctx) && branchName(ctx) !== null && hasRemote(ctx),
    run: (ctx) => chooseUpstream(ctx.repoId!, branchName(ctx)!),
  },
  {
    id: "branch.unsetUpstream",
    title: t("commands.branch.unsetUpstream.title"),
    group: "Branch",
    when: (ctx) => hasRepo(ctx) && branchName(ctx) !== null && Boolean(ctx.status?.upstream ?? headRef(ctx)?.upstream),
    run: (ctx) => setUpstream(ctx.repoId!, branchName(ctx)!, null),
  },
  {
    id: "branch.copyName",
    title: t("commands.branch.copyName.title"),
    group: "Branch",
    when: (ctx) => hasRepo(ctx) && branchName(ctx) !== null,
    run: (ctx) => copyText(branchName(ctx)!, t("menus.branch.name")),
  },

  // --- Commit (selection in the graph) -----------------------------------------------------------
  {
    id: "commit.branchHere",
    title: t("commands.commit.branchHere.title"),
    group: "Commit",
    when: oneSelected,
    run: (ctx) => createBranch(ctx.repoId!, { start: one(ctx), tabId: ctx.tabId }),
  },
  {
    id: "commit.tagHere",
    title: t("commands.commit.tagHere.title"),
    group: "Commit",
    when: (ctx) => hasRepo(ctx) && one(ctx) !== null,
    run: (ctx) => createTag(ctx.repoId!, one(ctx)),
  },
  {
    id: "tag.create",
    title: t("commands.tag.create.title"),
    group: "Commit",
    keywords: kw("commands.tag.create.keywords"),
    when: hasCommits,
    run: (ctx) => createTag(ctx.repoId!, null),
  },
  {
    id: "tag.createAnnotated",
    title: t("commands.tag.createAnnotated.title"),
    group: "Commit",
    keywords: kw("commands.tag.createAnnotated.keywords"),
    when: hasCommits,
    run: (ctx) => createTag(ctx.repoId!, null, true),
  },
  {
    id: "tag.push",
    title: t("commands.tag.push.title"),
    group: "Remote",
    when: (ctx) => hasRemote(ctx) && (refs(ctx)?.tags.length ?? 0) > 0,
    run: async (ctx) => {
      const tag = await pickTag(ctx, t("commands.tag.push.pick"), t("commands.tag.push.confirm"));
      if (tag) return pushTag(ctx.repoId!, tag.name);
    },
  },
  {
    id: "tag.delete",
    title: t("commands.tag.delete.title"),
    group: "Commit",
    when: (ctx) => hasRepo(ctx) && (refs(ctx)?.tags.length ?? 0) > 0,
    run: async (ctx) => {
      const tag = await pickTag(ctx, t("commands.tag.delete.pick"), t("commands.pick.next"));
      if (tag) return deleteTag(ctx.repoId!, tag.name, null);
    },
  },
  {
    id: "commit.checkout",
    title: t("commands.commit.checkout.title"),
    group: "Commit",
    when: oneSelected,
    run: (ctx) => checkoutCommit(ctx.repoId!, one(ctx)!, ctx.tabId),
  },
  {
    id: "commit.cherryPick",
    title: t("commands.commit.cherryPick.title"),
    group: "Commit",
    keywords: kw("commands.commit.cherryPick.keywords"),
    when: (ctx) => idle(ctx) && selected(ctx).length > 0,
    // Several commits go to the rebase tool first: check the order, deselect individual ones.
    run: (ctx) => (selected(ctx).length > 1 ? useAppStore.getState().openRebase(ctx.tabId!, "HEAD", "cherry_pick", selected(ctx)) : cherryPick(ctx.repoId!, selected(ctx), ctx.tabId)),
  },
  {
    id: "commit.revert",
    title: t("commands.commit.revert.title"),
    group: "Commit",
    when: oneSelected,
    run: (ctx) => revertCommit(ctx.repoId!, one(ctx)!, ctx.tabId),
  },
  ...resetCommands,
  {
    id: "commit.rebaseOnto",
    title: t("commands.commit.rebaseOnto.title"),
    group: "Commit",
    when: (ctx) => onBranch(ctx) && one(ctx) !== null,
    run: (ctx) => rebaseOnto(ctx.repoId!, one(ctx)!, null, ctx.tabId),
  },
  {
    id: "commit.rebaseInteractive",
    title: t("commands.commit.rebaseInteractive.title"),
    group: "Commit",
    when: (ctx) => onBranch(ctx) && one(ctx) !== null,
    run: (ctx) => interactiveRebase(ctx.tabId!, one(ctx)!),
  },
  {
    id: "commit.squash",
    title: t("commands.commit.squash.title"),
    group: "Commit",
    when: (ctx) => onBranch(ctx) && selected(ctx).length > 1,
    run: (ctx) => useAppStore.getState().openRebase(ctx.tabId!, "", "squash", selected(ctx)),
  },
  {
    id: "commit.compare",
    title: t("commands.commit.compare.title"),
    group: "Commit",
    when: (ctx) => hasRepo(ctx) && selected(ctx).length === 2,
    run: (ctx) => compareCommits(ctx.tabId!, selected(ctx)[0]!, selected(ctx)[1]!),
  },
  {
    id: "commit.reword",
    title: t("commands.commit.reword.title"),
    group: "Commit",
    keywords: kw("commands.commit.reword.keywords"),
    when: (ctx) => idle(ctx) && hasCommits(ctx) && ctx.status !== undefined,
    run: (ctx) => {
      const head = ctx.status!.head;
      if (head.kind !== "unborn") return rewordHead(ctx.repoId!, head.sha, ctx.tabId);
    },
  },
  {
    id: "commit.copySha",
    title: t("commands.commit.copySha.title"),
    group: "Commit",
    when: (ctx) => hasRepo(ctx) && selected(ctx).length > 0,
    run: (ctx) => copyText(selected(ctx).join("\n"), selected(ctx).length === 1 ? "SHA" : t("menus.commit.shas", { n: selected(ctx).length })),
  },
  {
    id: "commit.copyMessage",
    title: t("commands.commit.copyMessage.title"),
    group: "Commit",
    when: (ctx) => hasRepo(ctx) && one(ctx) !== null,
    run: (ctx) => copyCommitMessage(ctx.repoId!, one(ctx)!),
  },
  {
    id: "changes.discardAll",
    title: t("commands.changes.discardAll.title"),
    group: "Commit",
    keywords: kw("commands.changes.discardAll.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(ctx.status && ctx.status.unstaged.length + ctx.status.staged.length > 0),
    run: (ctx) => discardPaths(ctx.repoId!, null),
  },

  // --- Stash ----------------------------------------------------------------------------------
  {
    id: "stash.apply",
    title: t("commands.stash.apply.title"),
    group: "Stash",
    when: (ctx) => hasRepo(ctx) && stashes(ctx).length > 0,
    run: (ctx) => applyStash(ctx.repoId!, stashes(ctx)[0]!, ctx.tabId),
  },
  {
    id: "stash.rename",
    title: t("commands.stash.rename.title"),
    group: "Stash",
    when: (ctx) => hasRepo(ctx) && stashes(ctx).length > 0,
    run: (ctx) => renameStash(ctx.repoId!, stashes(ctx)[0]!),
  },
  {
    id: "stash.drop",
    title: t("commands.stash.drop.title"),
    group: "Stash",
    when: (ctx) => hasRepo(ctx) && stashes(ctx).length > 0,
    run: (ctx) => dropStash(ctx.repoId!, stashes(ctx)[0]!),
  },
];
