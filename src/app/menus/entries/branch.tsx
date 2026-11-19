/** Context menus of local and remote branches. */
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  Eye,
  EyeOff,
  FastForward,
  Focus,
  FolderOpen,
  GitMerge,
  GitPullRequestArrow,
  History,
  Link,
  ListOrdered,
  Milestone,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Unlink,
  Workflow,
} from "lucide-react";
import type { Id, Ref } from "../../../core";
import type { MenuAction, MenuEntry } from "../../../ui/Menu";
import { graphIndex, isAncestor } from "../../actions/ancestry";
import { checkout, chooseUpstream, deleteBranches, renameBranch, setUpstream } from "../../actions/branches";
import { copyText } from "../../actions/clipboard";
import { cachedRefs, cachedRemotes, clipMiddle, headSha } from "../../actions/context";
import { fastForwardBranch, pullBranch } from "../../actions/fastForward";
import { fastForward, interactiveRebase, mergeBranch, rebaseOnto } from "../../actions/merge";
import { gitflowBranch } from "../../../screens/Gitflow/actions";
import { kindLabels } from "../../../screens/Gitflow/model";
import { cachedPrForBranch, hostLink, openPr, openPrCreate } from "../../actions/pullrequests";
import { openRepositoryAt } from "../../actions/repos";
import { openWorktreeDialog } from "../../../screens/Worktrees/Dialog";
import { deleteRemoteBranch, pull, push, pushWithMore } from "../../actions/sync";
import { isPinned, togglePinned } from "../../actions/graphView";
import { isHidden, isSolo, toggleHidden, toggleSolo } from "../../actions/view";
import { t } from "../../../i18n";
import { nothingToPush, publishTarget, refPublishState } from "../../publishState";
import { commandShortcut } from "../../registry";
import { useAppStore } from "../../store";
import { customCommandEntries } from "../custom";
import { openGitflowFinish } from "../../../screens/Gitflow";
import { type MenuBase, SEPARATOR, item, q, tidy, operationBlock, currentName } from "./shared";
import { tagMenu } from "./refs";

/** Entries "Merge X into Y", "Rebase Y onto X" for a branch relative to the checked-out one. */
function combineEntries(ctx: MenuBase, ref: Ref): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const current = currentName(repoId);
  const head = headSha(repoId);
  const busy = operationBlock(repoId);
  const same = ref.isHead ? t("menus.branch.isCheckedOutBranch") : head && ref.sha === head ? t("menus.sameCommit") : null;
  const noBranch = current.branch ? null : t("menus.noBranch");
  const index = graphIndex(repoId);
  const merged = index && head ? isAncestor(index, ref.sha, head) : null;
  const behind = index && head ? isAncestor(index, head, ref.sha) : null;
  return [
    item(
      t("menus.mergeInto", { source: q(ref.name), target: current.label }),
      GitMerge,
      () => void mergeBranch(repoId, ref.name, undefined, tabId),
      {
        tooltip: t("menus.mergeInto", { source: t("menus.quoted", { name: ref.name }), target: current.full }),
        hint: !busy && !same && behind ? t("menus.viaFastForward") : undefined,
        blocked: busy ?? same ?? (merged ? t("menus.alreadyIn", { name: current.label }) : null),
      },
    ),
    item(
      t("menus.rebaseTip", { name: current.label, target: q(ref.name) }),
      Milestone,
      () => void rebaseOnto(repoId, ref.name, null, tabId),
      {
        tooltip: t("menus.rebaseTip", { name: current.full, target: t("menus.quoted", { name: ref.name }) }),
        blocked: busy ?? noBranch ?? same ?? (merged ? t("menus.alreadyBasedOn", { name: current.label }) : null),
      },
    ),
    item(t("menus.interactiveOnto", { name: current.label, target: q(ref.name) }), ListOrdered, () => interactiveRebase(tabId, ref.name), {
      tooltip: t("menus.interactiveOntoTip", { name: current.full, target: t("menus.quoted", { name: ref.name }) }),
      blocked: busy ?? noBranch ?? same ?? (behind ? t("menus.noOwnCommits", { name: current.label }) : null),
    }),
  ];
}

function visibilityEntries(repoId: Id, ref: Ref): MenuEntry[] {
  const hidden = isHidden(repoId, ref.fullName);
  const solo = isSolo(repoId, ref.fullName);
  return [
    item(hidden ? t("menus.view.show") : t("menus.view.hide"), hidden ? Eye : EyeOff, () => void toggleHidden(repoId, ref.fullName)),
    item(solo ? t("menus.view.soloOff") : t("menus.view.solo"), Focus, () => void toggleSolo(repoId, ref.fullName), {
      hint: solo ? undefined : t("menus.view.soloHint"),
    }),
    // Only branches have a line that can be pinned.
    ...(ref.kind === "tag"
      ? []
      : [
          isPinned(repoId, ref.fullName)
            ? item(t("menus.view.unpin"), PinOff, () => void togglePinned(repoId, ref.fullName, ref.name), {
                hint: t("menus.view.unpinHint"),
              })
            : item(t("menus.view.pin"), Pin, () => void togglePinned(repoId, ref.fullName, ref.name), { hint: t("menus.view.pinHint") }),
        ]),
  ];
}

/**
 * "Create pull request …" or "Open pull request #n" for a local branch. Without a recognised host
 * (local repository, other provider) the entry does not exist; without a connected account it is
 * disabled and says why.
 */
function pullRequestEntry(ctx: MenuBase, ref: Ref): MenuEntry | null {
  const link = hostLink(ctx.repoId);
  if (link.state === "unknown" || (link.state === "not_connected" && !link.repo?.kind)) return null;
  const existing = link.state === "connected" ? cachedPrForBranch(ctx.repoId, ref.name) : undefined;
  if (existing) {
    return item(t("menus.pr.open", { number: existing.number }), GitPullRequestArrow, () => openPr(ctx.tabId, existing.number), {
      tooltip: t("menus.pr.openTip", { number: existing.number, title: existing.title }),
    });
  }
  const target = link.state === "connected" ? link.repo.defaultBranch : null;
  return item(t("menus.pr.create"), GitPullRequestArrow, () => openPrCreate(ctx.repoId, ctx.tabId, { source: ref.name }), {
    hint:
      link.state === "connected" && target && target !== ref.name ? t("menus.pr.toBranch", { name: clipMiddle(target, 24) }) : undefined,
    blocked: link.state !== "connected" ? t("menus.pr.noHostAccount") : target === ref.name ? t("menus.pr.isDefaultBranch") : null,
  });
}

/** "Split into stacked pull requests …": the stack view for this local branch. */
function stackEntry(ctx: MenuBase, ref: Ref): MenuEntry {
  return item(t("menus.pr.stack"), null, () => useAppStore.getState().setCenter(ctx.tabId, { kind: "stack", branch: ref.name }), {
    tooltip: t("menus.pr.stackTip", { name: t("menus.quoted", { name: ref.name }) }),
  });
}

/** Hint on "Push" for a local branch: what goes where – or, not on the remote yet, what it creates there. */
export function pushHint(ref: Ref, remotes: readonly string[]): string | undefined {
  const state = refPublishState(ref);
  if (state.kind === "published")
    return state.ahead ? t("menus.branch.pushHint", { count: state.ahead, upstream: clipMiddle(state.upstream, 24) }) : undefined;
  const target = publishTarget(state, ref.name, remotes);
  return target ? t("menus.branch.createsRemote", { target: clipMiddle(target, 32) }) : t("menus.branch.createsRemoteBranch");
}

function localBranchMenu(ctx: MenuBase, ref: Ref): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const busy = operationBlock(repoId);
  const hasRemote = (cachedRemotes(repoId)?.length ?? 1) > 0;
  const upstream = ref.upstream && !ref.upstreamGone ? ref.upstream : null;
  // The remote branch behind the upstream – only if it is known here (it carries the remote's name).
  const upstreamRef = upstream
    ? cachedRefs(repoId)?.remotes.find((candidate) => candidate.name === upstream && candidate.remote)
    : undefined;
  const flow = gitflowBranch(repoId, ref.name);

  const fastForwardBlock = !upstream
    ? null
    : (busy ??
      (ref.behind === 0
        ? t("menus.branch.upToDate")
        : ref.ahead > 0
          ? t("menus.branch.aheadInWay", { count: ref.ahead })
          : // A branch checked out in another worktree only moves there (otherwise that worktree's files would no longer match).
            !ref.isHead && ref.worktreePath
            ? t("menus.otherWorktree")
            : null));

  return tidy([
    item(t("menus.checkout"), Check, () => void checkout(repoId, ref.name, { tabId }), {
      blocked: ref.isHead ? t("menus.branch.isCheckedOut") : ref.worktreePath ? t("menus.otherWorktree") : busy,
    }),
    SEPARATOR,
    ...(ref.isHead ? [] : combineEntries(ctx, ref)),
    SEPARATOR,
    upstream
      ? // Checked out: merge only by fast-forward (the files move along). Otherwise only the ref moves – without checkout.
        item(
          t("menus.branch.fastForwardTo", { name: q(upstream) }),
          FastForward,
          () => void (ref.isHead ? fastForward(repoId, upstream, tabId) : fastForwardBranch(repoId, ref.name, upstream)),
          {
            tooltip: t(ref.isHead ? "menus.branch.fastForwardTip" : "menus.branch.fastForwardTipNoCheckout", {
              name: t("menus.quoted", { name: ref.name }),
              upstream: t("menus.quoted", { name: upstream }),
            }),
            hint: fastForwardBlock ? undefined : t("menus.commits", { count: ref.behind }),
            blocked: fastForwardBlock,
          },
        )
      : null,
    ref.isHead
      ? item(t("menus.branch.pull"), ArrowDownToLine, () => void pull(repoId, null, tabId), {
          shortcut: commandShortcut("sync.pull"),
          blocked: busy ?? (!hasRemote ? t("menus.noRemote") : !upstream ? t("menus.branch.noUpstream") : null),
        })
      : // Not checked out: fetch, then only the ref moves (no checkout).
        item(t("menus.branch.pull"), ArrowDownToLine, () => void (upstream && pullBranch(repoId, ref.name, upstream)), {
          tooltip: upstream
            ? t("menus.branch.pullOtherTip", {
                name: t("menus.quoted", { name: ref.name }),
                upstream: t("menus.quoted", { name: upstream }),
              })
            : undefined,
          blocked:
            busy ??
            (!hasRemote
              ? t("menus.noRemote")
              : !upstream
                ? t("menus.branch.noUpstream")
                : ref.ahead > 0
                  ? t("menus.branch.aheadInWay", { count: ref.ahead })
                  : ref.worktreePath
                    ? t("menus.otherWorktree")
                    : null),
        }),
    item(t("menus.branch.push"), ArrowUpFromLine, () => void push(repoId, { branch: ref.isHead ? null : ref.name, tabId }), {
      shortcut: ref.isHead ? commandShortcut("sync.push") : undefined,
      hint: !hasRemote ? undefined : pushHint(ref, cachedRemotes(repoId)?.map((remote) => remote.name) ?? []),
      blocked: !hasRemote ? t("menus.noRemote") : nothingToPush(refPublishState(ref)) ? t("menus.nothingToPush") : null,
    }),
    item(t("pushMany.menuSingle"), ArrowUpFromLine, () => void pushWithMore(repoId, { branch: ref.name }), {
      blocked: !hasRemote ? t("menus.noRemote") : null,
    }),
    item(
      ref.upstream ? t("menus.branch.changeUpstream") : t("menus.branch.setUpstream"),
      Link,
      () => void chooseUpstream(repoId, ref.name),
      {
        hint: ref.upstream
          ? ref.upstreamGone
            ? t("menus.branch.upstreamMissing", { name: clipMiddle(ref.upstream, 24) })
            : clipMiddle(ref.upstream, 24)
          : undefined,
        blocked: !hasRemote ? t("menus.noRemote") : null,
      },
    ),
    ref.upstream ? item(t("menus.branch.unsetUpstream"), Unlink, () => void setUpstream(repoId, ref.name, null)) : null,
    pullRequestEntry(ctx, ref),
    stackEntry(ctx, ref),
    SEPARATOR,
    // Gitflow: a running feature, release or hotfix can be finished here.
    flow
      ? item(
          t("menus.branch.gitflowFinish", { kind: kindLabels[flow.kind] }),
          Workflow,
          () => void openGitflowFinish(repoId, tabId, flow),
          { blocked: busy },
        )
      : null,
    flow ? SEPARATOR : null,
    item(t("menus.rename"), Pencil, () => void renameBranch(repoId, ref.name)),
    item(t("menus.copyName"), Copy, () => void copyText(ref.name, t("menus.branch.name"))),
    item(t("menus.branch.reflog"), History, () => useAppStore.getState().openReflog(tabId, ref.fullName)),
    SEPARATOR,
    ...visibilityEntries(repoId, ref),
    SEPARATOR,
    // Worktrees: open the folder where the branch is already checked out – or create one for it.
    ref.worktreePath
      ? item(t("menus.branch.openWorktree"), FolderOpen, () => void openRepositoryAt(ref.worktreePath!), {
          tooltip: t("menus.branch.openWorktreeTip", { path: ref.worktreePath }),
        })
      : item(t("menus.branch.createWorktree"), FolderOpen, () => void openWorktreeDialog(repoId, { branch: ref.name }), {
          hint: ref.isHead ? t("menus.branch.createWorktreeHintHead") : t("menus.branch.createWorktreeHint"),
        }),
    ...customCommandEntries(repoId, "branch", { branch: ref.name }),
    SEPARATOR,
    item(t("menus.branch.delete", { name: q(ref.name) }), Trash2, () => void deleteBranches(repoId, [ref.name]), {
      danger: true,
      tooltip: t("menus.branch.deleteTip", { name: t("menus.quoted", { name: ref.name }) }),
      blocked: ref.isHead ? t("menus.branch.cannotDeleteHead") : ref.worktreePath ? t("menus.otherWorktree") : null,
    }),
    upstreamRef
      ? item(t("menus.branch.deleteUpstream", { name: q(upstreamRef.name) }), Trash2, () => void deleteRemoteBranch(repoId, upstreamRef), {
          danger: true,
          tooltip: t("menus.branch.deleteUpstreamTip", {
            name: t("menus.quoted", { name: upstreamRef.name }),
            local: t("menus.quoted", { name: ref.name }),
          }),
          blocked: busy,
        })
      : null,
  ]);
}

/** "Delete … on <remote>": deletes the remote branch on its server (local branches stay). */
function deleteOnRemoteEntry(repoId: Id, ref: Ref, busy: string | null): MenuAction | null {
  const remote = ref.remote;
  if (!remote) return null;
  const name = ref.name.startsWith(`${remote}/`) ? ref.name.slice(remote.length + 1) : ref.name;
  return item(
    t("menus.remoteBranch.delete", { name: q(name), remote: clipMiddle(remote, 24) }),
    Trash2,
    () => void deleteRemoteBranch(repoId, ref),
    {
      danger: true,
      tooltip: t("menus.remoteBranch.deleteTip", { name: t("menus.quoted", { name: ref.name }), remote }),
      blocked: busy,
    },
  );
}

function remoteBranchMenu(ctx: MenuBase, ref: Ref): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const busy = operationBlock(repoId);
  const localName = ref.remote && ref.name.startsWith(`${ref.remote}/`) ? ref.name.slice(ref.remote.length + 1) : ref.name;
  const local = cachedRefs(repoId)?.locals.find((candidate) => candidate.name === localName);
  return tidy([
    item(t("menus.checkout"), Check, () => void checkout(repoId, ref.name, { tabId }), {
      hint: local
        ? t("menus.remoteBranch.switchesTo", { name: q(localName, 24) })
        : t("menus.remoteBranch.creates", { name: q(localName, 24) }),
      tooltip: local
        ? t("menus.remoteBranch.switchTip", { name: t("menus.quoted", { name: localName }) })
        : t("menus.remoteBranch.createTip", {
            name: t("menus.quoted", { name: localName }),
            remote: t("menus.quoted", { name: ref.name }),
          }),
      blocked: busy ?? (local?.isHead ? t("menus.remoteBranch.isCheckedOut", { name: q(localName, 24) }) : null),
    }),
    SEPARATOR,
    ...combineEntries(ctx, ref),
    SEPARATOR,
    item(t("menus.copyName"), Copy, () => void copyText(ref.name, t("menus.branch.name"))),
    item(t("menus.branch.reflog"), History, () => useAppStore.getState().openReflog(tabId, ref.fullName)),
    SEPARATOR,
    ...visibilityEntries(repoId, ref),
    ...customCommandEntries(repoId, "branch", { branch: ref.name, remote: ref.remote ?? null }),
    SEPARATOR,
    deleteOnRemoteEntry(repoId, ref, busy),
  ]);
}

export function branchMenu(ctx: MenuBase & { ref: Ref }): MenuEntry[] {
  if (ctx.ref.kind === "tag") return tagMenu(ctx);
  return ctx.ref.kind === "remote" ? remoteBranchMenu(ctx, ctx.ref) : localBranchMenu(ctx, ctx.ref);
}

export function branchesMenu(ctx: MenuBase & { refs: Ref[] }): MenuEntry[] {
  const { repoId } = ctx;
  const locals = ctx.refs.filter((ref) => ref.kind === "local");
  const deletable = locals.filter((ref) => !ref.isHead && !ref.worktreePath);
  const skipped = locals.length - deletable.length;
  return tidy([
    item(
      t("menus.branches.copyNames", { count: ctx.refs.length }),
      Copy,
      () => void copyText(ctx.refs.map((ref) => ref.name).join("\n"), t("menus.branches.names", { count: ctx.refs.length })),
    ),
    item(
      t("pushMany.menu", { count: locals.length }),
      ArrowUpFromLine,
      () => void pushWithMore(repoId, { branch: locals[0]!.name, preselected: locals.slice(1).map((ref) => ref.fullName) }),
      {
        blocked: locals.length < 2 ? t("pushMany.menuNeedsTwo") : null,
      },
    ),
    SEPARATOR,
    item(
      t("menus.branches.delete", { count: deletable.length }),
      Trash2,
      () =>
        void deleteBranches(
          repoId,
          deletable.map((ref) => ref.name),
        ),
      {
        danger: true,
        hint: deletable.length && skipped ? t("menus.branches.withoutHead") : undefined,
        blocked: locals.length === 0 ? t("menus.branches.onlyLocal") : deletable.length === 0 ? t("menus.branch.cannotDeleteHead") : null,
      },
    ),
  ]);
}
