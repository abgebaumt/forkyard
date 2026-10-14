/**
 * Contents of the context menus. Each function reads what it needs to know from the query cache
 * (status, refs, remotes, loaded graph rows) and builds the entries from it: with icon, shortcut,
 * separators, disabled entries with their reason. Dangerous items come last in their group and are
 * red. Every entry calls an action from src/app/actions.
 */
import type { ComponentType } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Cherry,
  CloudDownload,
  CloudUpload,
  Combine,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FastForward,
  FileDiff,
  FileInput,
  FilePenLine,
  FilePlus,
  FileX,
  FileText,
  Focus,
  FolderOpen,
  GitBranchPlus,
  GitCompareArrows,
  GitMerge,
  GitPullRequestArrow,
  History,
  Link,
  ListOrdered,
  LogIn,
  Milestone,
  Minus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Tag,
  Trash2,
  Undo2,
  Unlink,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import type { DiffSource, FileChange, GraphRow, Id, Ref, Remote, ResetMode, Sha, Stash } from "../../core";
import type { MenuAction, MenuEntry } from "../../ui/Menu";
import { consecutiveOnHead, findRow, graphIndex, isAncestor } from "../actions/ancestry";
import { checkout, checkoutCommit, chooseUpstream, createBranch, deleteBranches, renameBranch, setUpstream } from "../actions/branches";
import { copyText } from "../actions/clipboard";
import { setAllMergesCollapsed, setMergeCollapsed } from "../actions/collapse";
import { cachedRefs, cachedRemotes, cachedStashes, cachedStatus, clipMiddle, currentBranch, headSha, short } from "../actions/context";
import { interactiveRebaseOnto, mergeInto, pushTo, rebaseBranchOnto } from "../actions/drop";
import { createFile, deleteFile } from "../commands/fileview";
import { fastForwardBranch, pullBranch } from "../actions/fastForward";
import { discardPaths, ignoreFiles, ignoreSuggestions, openExternal, resolveConflictSide, stagePaths, stashFiles, unstagePaths, type IgnorePreset } from "../actions/files";
import { cherryPick, compareCommits, copyCommitMessage, resetBranch, resetModeHints, restoreFile, revertCommit, rewordHead } from "../actions/history";
import { fastForward, interactiveRebase, mergeBranch, operationNames, rebaseOnto } from "../actions/merge";
import { gitflowBranch, kindLabels } from "../actions/gitflow";
import { applyPatch, patchFromCommit, patchFromFiles, patchFromStash, patchFromWip } from "../actions/patches";
import { cachedPrForBranch, hostLink, openPr, openPrCreate } from "../actions/pullrequests";
import { editRemote, removeRemote } from "../actions/remotes";
import { openRepositoryAt } from "../actions/repos";
import { openWorktreeDialog } from "../../screens/Worktrees/Dialog";
import { applyStash, dropStash, popStash, renameStash, stashChanges } from "../actions/stash";
import { fetchAll, pull, push } from "../actions/sync";
import { createTag, deleteTag, pushTag } from "../actions/tags";
import { openDiffTool, openMergeTool } from "../actions/tools";
import { isPinned, togglePinned } from "../actions/graphView";
import { isHidden, isSolo, toggleHidden, toggleSolo } from "../actions/view";
import { t } from "../../i18n";
import { useAppStore } from "../store";
import { openGitflowFinish } from "../../screens/Gitflow";

export interface MenuBase {
  repoId: Id;
  tabId: Id;
}

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

const SEPARATOR: MenuEntry = { type: "separator" };

/** An entry. `blocked` disables it and shows the reason; `tooltip` carries the untruncated names. */
function item(label: string, IconComponent: Icon | null, onSelect: () => void, extra: Partial<MenuAction> & { blocked?: string | null } = {}): MenuAction {
  const { blocked, ...rest } = extra;
  return {
    label,
    icon: IconComponent ? <IconComponent className="size-icon" aria-hidden /> : undefined,
    // Only once the menu is closed: while it is open, it holds on to focus – a prompt that opens right
    // away would otherwise not get focus on "Cancel".
    onSelect: blocked ? undefined : () => window.requestAnimationFrame(() => window.setTimeout(onSelect, 0)),
    ...rest,
    ...(blocked ? { disabled: true, hint: blocked } : {}),
  };
}

/** Name in quotes, truncated in the middle – the full name is in the entry's tooltip. */
const q = (name: string, max = 30) => t("menus.quoted", { name: clipMiddle(name, max) });

/** Removes duplicate and superfluous separators (at the start, at the end, consecutive). */
function tidy(entries: (MenuEntry | null | false | undefined)[]): MenuEntry[] {
  const result: MenuEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.type === "separator" && (result.length === 0 || result[result.length - 1]!.type === "separator")) continue;
    result.push(entry);
  }
  while (result.length && result[result.length - 1]!.type === "separator") result.pop();
  return result;
}

/** Reason why nothing in the history can be changed right now – or null. */
function operationBlock(repoId: Id): string | null {
  const operation = cachedStatus(repoId)?.operation;
  return operation ? t("menus.operationBlock", { operation: operationNames[operation.kind] }) : null;
}

/** What the checked-out state is called in labels. */
function currentName(repoId: Id): { branch: string | null; label: string; full: string } {
  const branch = currentBranch(repoId);
  return { branch, label: branch ? q(branch) : "HEAD", full: branch ? t("menus.quoted", { name: branch }) : "HEAD" };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function resetMenu(ctx: MenuBase, sha: Sha): MenuEntry[] {
  // The modes are named as in Git; the phrase after them says what happens to the changes.
  const entry = (mode: ResetMode, label: string, danger = false): MenuAction =>
    item(label, null, () => void resetBranch(ctx.repoId, sha, mode, ctx.tabId), { hint: resetModeHints[mode], danger });
  return [entry("soft", "Soft"), entry("mixed", "Mixed"), SEPARATOR, entry("hard", "Hard …", true)];
}

/** Collapse or expand a merge; plus "all merges" (also in the palette, Mod+Shift+[ / ]). */
function mergeEntries(ctx: MenuBase, sha: Sha, row: GraphRow | undefined): MenuEntry[] {
  if (row?.kind !== "merge") return [];
  const collapsed = row.collapsedCount !== null;
  // The row carries the full SHA; the view state stores full SHAs.
  const merge = row.sha ?? sha;
  return [
    item(collapsed ? t("menus.commit.expandMerge") : t("menus.commit.collapseMerge"), collapsed ? ChevronsUpDown : ChevronsDownUp, () => void setMergeCollapsed(ctx.repoId, merge, !collapsed), {
      hint: row.collapseTooLarge ? t("graph.row.collapseTooLarge") : collapsed ? t("menus.commit.hiddenCommits", { count: row.collapsedCount ?? 0 }) : undefined,
    }),
    item(t("menus.commit.collapseAll"), ChevronsDownUp, () => void setAllMergesCollapsed(ctx.repoId, true), { shortcut: "Mod+Shift+[" }),
    item(t("menus.commit.expandAll"), ChevronsUpDown, () => void setAllMergesCollapsed(ctx.repoId, false), { shortcut: "Mod+Shift+]" }),
  ];
}

export function commitMenu(ctx: MenuBase & { shas: Sha[] }): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const shas = [...new Set(ctx.shas)];
  if (shas.length === 0) return [];
  const status = cachedStatus(repoId);
  const head = headSha(repoId);
  const current = currentName(repoId);
  const index = graphIndex(repoId);
  const busy = operationBlock(repoId);
  const detached = status?.head.kind === "detached";

  if (shas.length > 1) {
    const count = shas.length;
    const allContained = index && head ? shas.every((sha) => isAncestor(index, sha, head) === true) : false;
    const squash = index ? consecutiveOnHead(index, head, shas) : ({ ok: null } as const);
    const [first, second] = shas;
    return tidy([
      // Several commits: first into the rebase tool – check the order, deselect individual ones, then start.
      item(t("menus.commit.cherryPickMany", { n: count }), Cherry, () => useAppStore.getState().openRebase(tabId, "HEAD", "cherry_pick", shas), {
        hint: busy || allContained ? undefined : t("menus.commit.onto", { name: current.label }),
        tooltip: t("menus.commit.cherryPickManyTip", { n: count, name: current.full }),
        blocked: busy ?? (allContained ? t("menus.alreadyIn", { name: current.label }) : null),
      }),
      item(t("menus.commit.squashMany", { n: count }), Combine, () => useAppStore.getState().openRebase(tabId, "", "squash", shas), {
        blocked: busy ?? (detached ? t("menus.noBranch") : squash.ok === false ? squash.reason : null),
      }),
      count === 2 && first && second ? item(t("menus.commit.compare"), GitCompareArrows, () => compareCommits(tabId, first, second), { hint: `${short(first)} ↔ ${short(second)}` }) : null,
      SEPARATOR,
      item(t("menus.commit.copyShas", { n: count }), Copy, () => void copyText(shas.join("\n"), t("menus.commit.shas", { n: count }))),
    ]);
  }

  const sha = shas[0]!;
  const row = index ? findRow(index, sha) : undefined;
  const isHead = head === sha;
  const contained = index && head ? isAncestor(index, sha, head) : null;
  const above = index && head ? isAncestor(index, head, sha) : null;

  return tidy([
    item(t("menus.createBranchHere"), GitBranchPlus, () => void createBranch(repoId, { start: sha, tabId }), { blocked: busy }),
    item(t("menus.commit.createTagHere"), Tag, () => void createTag(repoId, sha)),
    SEPARATOR,
    item(t("menus.commit.checkout"), LogIn, () => void checkoutCommit(repoId, sha, tabId), {
      hint: t("menus.detachedHint"),
      blocked: busy ?? (isHead && detached ? t("menus.commit.alreadyCheckedOut") : null),
    }),
    SEPARATOR,
    item(t("menus.commit.cherryPick"), Cherry, () => void cherryPick(repoId, [sha], tabId), {
      hint: t("menus.commit.onto", { name: current.label }),
      tooltip: t("menus.commit.cherryPickTip", { name: current.full }),
      blocked: busy ?? (contained ? t("menus.alreadyIn", { name: current.label }) : null),
    }),
    item(t("menus.commit.revert"), Undo2, () => void revertCommit(repoId, sha, tabId), {
      hint: t("menus.commit.revertHint"),
      blocked: busy ?? (contained === false ? t("menus.commit.notIn", { name: current.label }) : null),
    }),
    SEPARATOR,
    item(t("menus.commit.resetHere", { name: current.label }), RotateCcw, () => undefined, {
      tooltip: t("menus.commit.resetTip", { name: current.full, sha: short(sha) }),
      ...(busy ? { blocked: busy } : { children: resetMenu(ctx, sha) }),
    }),
    item(t("menus.commit.rebaseOntoCommit", { name: current.label }), Milestone, () => void rebaseOnto(repoId, sha, null, tabId), {
      tooltip: t("menus.rebaseTip", { name: current.full, target: short(sha) }),
      blocked: busy ?? (detached ? t("menus.noBranch") : contained ? t("menus.alreadyBasedOn", { name: current.label }) : null),
    }),
    item(t("menus.commit.interactiveHere"), ListOrdered, () => interactiveRebase(tabId, sha), {
      hint: t("menus.commit.interactiveHint"),
      blocked:
        busy ?? (detached ? t("menus.noBranch") : isHead ? t("menus.commit.noLaterCommit") : contained === false || above ? t("menus.commit.onlyCommitsOf", { name: current.label }) : null),
    }),
    SEPARATOR,
    ...mergeEntries(ctx, sha, row),
    SEPARATOR,
    isHead ? item(t("menus.commit.reword"), Pencil, () => void rewordHead(repoId, sha, tabId), { blocked: busy }) : null,
    item(t("menus.commit.copySha"), Copy, () => void copyText(sha, "SHA"), { hint: short(sha) }),
    item(t("menus.commit.copyMessage"), Copy, () => void copyCommitMessage(repoId, sha), { tooltip: row?.summary ? t("menus.commit.copyMessageTip", { summary: row.summary }) : undefined }),
    item(t("menus.createPatch"), FileDiff, () => void patchFromCommit(repoId, sha), { hint: t("menus.commit.createPatchHint") }),
  ]);
}

// ---------------------------------------------------------------------------
// WIP row
// ---------------------------------------------------------------------------

export function wipMenu(ctx: MenuBase): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const status = cachedStatus(repoId);
  const unstaged = status?.unstaged.length ?? 0;
  const staged = status?.staged.length ?? 0;
  const conflicted = status?.conflicted.length ?? 0;
  const changes = unstaged + staged;
  const noChanges = status && changes === 0 ? t("menus.wip.noChanges") : null;
  const stashBlock = status?.head.kind === "unborn" ? t("menus.wip.needsCommit") : conflicted ? t("menus.wip.resolveConflictsFirst") : noChanges;
  return tidy([
    item(t("menus.wip.stageAll"), Plus, () => void stagePaths(repoId, null), { shortcut: "Mod+Shift+S", blocked: status && unstaged === 0 ? t("menus.wip.nothingToStage") : null }),
    item(t("menus.wip.unstageAll"), Minus, () => void unstagePaths(repoId, null), { shortcut: "Mod+Shift+U", blocked: status && staged === 0 ? t("menus.wip.nothingStaged") : null }),
    SEPARATOR,
    item(t("menus.wip.stash"), Archive, () => void stashChanges(repoId), { shortcut: "Alt+S", blocked: stashBlock }),
    item(t("menus.wip.stashWithMessage"), Archive, () => useAppStore.getState().openStashForm(tabId), { blocked: stashBlock }),
    SEPARATOR,
    item(t("menus.wip.patchFromChanges"), FileDiff, () => void patchFromWip(repoId), { blocked: noChanges }),
    item(t("menus.wip.applyPatch"), FileInput, () => void applyPatch(repoId, tabId), { blocked: conflicted ? t("menus.wip.resolveConflictsFirst") : null }),
    SEPARATOR,
    item(t("menus.wip.discardAll"), Trash2, () => void discardPaths(repoId, null), { danger: true, blocked: noChanges }),
  ]);
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

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
    item(t("menus.mergeInto", { source: q(ref.name), target: current.label }), GitMerge, () => void mergeBranch(repoId, ref.name, undefined, tabId), {
      tooltip: t("menus.mergeInto", { source: t("menus.quoted", { name: ref.name }), target: current.full }),
      hint: !busy && !same && behind ? t("menus.viaFastForward") : undefined,
      blocked: busy ?? same ?? (merged ? t("menus.alreadyIn", { name: current.label }) : null),
    }),
    item(t("menus.rebaseTip", { name: current.label, target: q(ref.name) }), Milestone, () => void rebaseOnto(repoId, ref.name, null, tabId), {
      tooltip: t("menus.rebaseTip", { name: current.full, target: t("menus.quoted", { name: ref.name }) }),
      blocked: busy ?? noBranch ?? same ?? (merged ? t("menus.alreadyBasedOn", { name: current.label }) : null),
    }),
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
    item(solo ? t("menus.view.soloOff") : t("menus.view.solo"), Focus, () => void toggleSolo(repoId, ref.fullName), { hint: solo ? undefined : t("menus.view.soloHint") }),
    // Only branches have a line that can be pinned.
    ...(ref.kind === "tag"
      ? []
      : [
          isPinned(repoId, ref.fullName)
            ? item(t("menus.view.unpin"), PinOff, () => void togglePinned(repoId, ref.fullName, ref.name), { hint: t("menus.view.unpinHint") })
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
    return item(t("menus.pr.open", { number: existing.number }), GitPullRequestArrow, () => openPr(ctx.tabId, existing.number), { tooltip: t("menus.pr.openTip", { number: existing.number, title: existing.title }) });
  }
  const target = link.state === "connected" ? link.repo.defaultBranch : null;
  return item(t("menus.pr.create"), GitPullRequestArrow, () => openPrCreate(ctx.repoId, ctx.tabId, { source: ref.name }), {
    hint: link.state === "connected" && target && target !== ref.name ? t("menus.pr.toBranch", { name: clipMiddle(target, 24) }) : undefined,
    blocked: link.state !== "connected" ? t("menus.pr.noHostAccount") : target === ref.name ? t("menus.pr.isDefaultBranch") : null,
  });
}

function localBranchMenu(ctx: MenuBase, ref: Ref): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const busy = operationBlock(repoId);
  const hasRemote = (cachedRemotes(repoId)?.length ?? 1) > 0;
  const upstream = ref.upstream && !ref.upstreamGone ? ref.upstream : null;
  const flow = gitflowBranch(repoId, ref.name);

  const fastForwardBlock = !upstream
    ? null
    : busy ??
      (ref.behind === 0
        ? t("menus.branch.upToDate")
        : ref.ahead > 0
          ? t("menus.branch.aheadInWay", { count: ref.ahead })
          : // A branch checked out in another worktree only moves there (otherwise that worktree's files would no longer match).
            !ref.isHead && ref.worktreePath
            ? t("menus.otherWorktree")
            : null);

  return tidy([
    item(t("menus.checkout"), Check, () => void checkout(repoId, ref.name, { tabId }), {
      blocked: ref.isHead ? t("menus.branch.isCheckedOut") : ref.worktreePath ? t("menus.otherWorktree") : busy,
    }),
    SEPARATOR,
    ...(ref.isHead ? [] : combineEntries(ctx, ref)),
    SEPARATOR,
    upstream
      ? // Checked out: merge only by fast-forward (the files move along). Otherwise only the ref moves – without checkout.
        item(t("menus.branch.fastForwardTo", { name: q(upstream) }), FastForward, () => void (ref.isHead ? fastForward(repoId, upstream, tabId) : fastForwardBranch(repoId, ref.name, upstream)), {
          tooltip: t(ref.isHead ? "menus.branch.fastForwardTip" : "menus.branch.fastForwardTipNoCheckout", {
            name: t("menus.quoted", { name: ref.name }),
            upstream: t("menus.quoted", { name: upstream }),
          }),
          hint: fastForwardBlock ? undefined : t("menus.commits", { count: ref.behind }),
          blocked: fastForwardBlock,
        })
      : null,
    ref.isHead
      ? item(t("menus.branch.pull"), ArrowDownToLine, () => void pull(repoId, null, tabId), {
          shortcut: "Mod+Shift+D",
          blocked: busy ?? (!hasRemote ? t("menus.noRemote") : !upstream ? t("menus.branch.noUpstream") : null),
        })
      : // Not checked out: fetch, then only the ref moves (no checkout).
        item(t("menus.branch.pull"), ArrowDownToLine, () => void (upstream && pullBranch(repoId, ref.name, upstream)), {
          tooltip: upstream ? t("menus.branch.pullOtherTip", { name: t("menus.quoted", { name: ref.name }), upstream: t("menus.quoted", { name: upstream }) }) : undefined,
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
      shortcut: ref.isHead ? "Mod+Shift+P" : undefined,
      hint: !hasRemote ? undefined : upstream ? (ref.ahead ? t("menus.branch.pushHint", { count: ref.ahead, upstream: clipMiddle(upstream, 24) }) : undefined) : t("menus.branch.createsRemoteBranch"),
      blocked: !hasRemote ? t("menus.noRemote") : upstream && ref.ahead === 0 ? t("menus.nothingToPush") : null,
    }),
    item(ref.upstream ? t("menus.branch.changeUpstream") : t("menus.branch.setUpstream"), Link, () => void chooseUpstream(repoId, ref.name), {
      hint: ref.upstream ? (ref.upstreamGone ? t("menus.branch.upstreamMissing", { name: clipMiddle(ref.upstream, 24) }) : clipMiddle(ref.upstream, 24)) : undefined,
      blocked: !hasRemote ? t("menus.noRemote") : null,
    }),
    ref.upstream ? item(t("menus.branch.unsetUpstream"), Unlink, () => void setUpstream(repoId, ref.name, null)) : null,
    pullRequestEntry(ctx, ref),
    SEPARATOR,
    // Gitflow: a running feature, release or hotfix can be finished here.
    flow ? item(t("menus.branch.gitflowFinish", { kind: kindLabels[flow.kind] }), Workflow, () => void openGitflowFinish(repoId, tabId, flow), { blocked: busy }) : null,
    flow ? SEPARATOR : null,
    item(t("menus.rename"), Pencil, () => void renameBranch(repoId, ref.name)),
    item(t("menus.copyName"), Copy, () => void copyText(ref.name, t("menus.branch.name"))),
    item(t("menus.branch.reflog"), History, () => useAppStore.getState().openReflog(tabId, ref.fullName)),
    SEPARATOR,
    ...visibilityEntries(repoId, ref),
    SEPARATOR,
    // Worktrees: open the folder where the branch is already checked out – or create one for it.
    ref.worktreePath
      ? item(t("menus.branch.openWorktree"), FolderOpen, () => void openRepositoryAt(ref.worktreePath!), { tooltip: t("menus.branch.openWorktreeTip", { path: ref.worktreePath }) })
      : item(t("menus.branch.createWorktree"), FolderOpen, () => void openWorktreeDialog(repoId, { branch: ref.name }), {
          hint: ref.isHead ? t("menus.branch.createWorktreeHintHead") : t("menus.branch.createWorktreeHint"),
        }),
    SEPARATOR,
    item(t("menus.branch.delete", { name: q(ref.name) }), Trash2, () => void deleteBranches(repoId, [ref.name]), {
      danger: true,
      tooltip: t("menus.branch.deleteTip", { name: t("menus.quoted", { name: ref.name }) }),
      blocked: ref.isHead ? t("menus.branch.cannotDeleteHead") : ref.worktreePath ? t("menus.otherWorktree") : null,
    }),
  ]);
}

function remoteBranchMenu(ctx: MenuBase, ref: Ref): MenuEntry[] {
  const { repoId, tabId } = ctx;
  const busy = operationBlock(repoId);
  const localName = ref.remote && ref.name.startsWith(`${ref.remote}/`) ? ref.name.slice(ref.remote.length + 1) : ref.name;
  const local = cachedRefs(repoId)?.locals.find((candidate) => candidate.name === localName);
  return tidy([
    item(t("menus.checkout"), Check, () => void checkout(repoId, ref.name, { tabId }), {
      hint: local ? t("menus.remoteBranch.switchesTo", { name: q(localName, 24) }) : t("menus.remoteBranch.creates", { name: q(localName, 24) }),
      tooltip: local
        ? t("menus.remoteBranch.switchTip", { name: t("menus.quoted", { name: localName }) })
        : t("menus.remoteBranch.createTip", { name: t("menus.quoted", { name: localName }), remote: t("menus.quoted", { name: ref.name }) }),
      blocked: busy ?? (local?.isHead ? t("menus.remoteBranch.isCheckedOut", { name: q(localName, 24) }) : null),
    }),
    SEPARATOR,
    ...combineEntries(ctx, ref),
    SEPARATOR,
    item(t("menus.copyName"), Copy, () => void copyText(ref.name, t("menus.branch.name"))),
    item(t("menus.branch.reflog"), History, () => useAppStore.getState().openReflog(tabId, ref.fullName)),
    SEPARATOR,
    ...visibilityEntries(repoId, ref),
    // "Delete on remote" is missing on purpose: the core has no command for it yet (push --delete).
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
    item(t("menus.branches.copyNames", { count: ctx.refs.length }), Copy, () => void copyText(ctx.refs.map((ref) => ref.name).join("\n"), t("menus.branches.names", { count: ctx.refs.length }))),
    SEPARATOR,
    item(t("menus.branches.delete", { count: deletable.length }), Trash2, () => void deleteBranches(repoId, deletable.map((ref) => ref.name)), {
      danger: true,
      hint: deletable.length && skipped ? t("menus.branches.withoutHead") : undefined,
      blocked: locals.length === 0 ? t("menus.branches.onlyLocal") : deletable.length === 0 ? t("menus.branch.cannotDeleteHead") : null,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Tags, Stashes, Remotes
// ---------------------------------------------------------------------------

export function tagMenu(ctx: MenuBase & { ref: Ref }): MenuEntry[] {
  const { repoId, tabId, ref } = ctx;
  const busy = operationBlock(repoId);
  const remotes = cachedRemotes(repoId);
  const noRemote = remotes && remotes.length === 0 ? t("menus.noRemote") : null;
  const several = (remotes?.length ?? 1) > 1;
  const only = remotes?.length === 1 ? remotes[0]!.name : null;
  return tidy([
    item(t("menus.checkout"), LogIn, () => void checkout(repoId, ref.fullName, { tabId }), { hint: t("menus.detachedHint"), blocked: busy }),
    item(t("menus.createBranchHere"), GitBranchPlus, () => void createBranch(repoId, { start: ref.fullName, tabId }), { blocked: busy }),
    SEPARATOR,
    item(several ? t("menus.tag.pushToRemoteChoose") : only ? t("menus.tag.pushTo", { name: clipMiddle(only, 24) }) : t("menus.tag.pushToRemote"), CloudUpload, () => void pushTag(repoId, ref.name), { blocked: noRemote }),
    item(t("menus.copyName"), Copy, () => void copyText(ref.name, t("menus.tag.name"))),
    SEPARATOR,
    item(t("menus.tag.deleteLocal"), Trash2, () => void deleteTag(repoId, ref.name, null), { danger: true }),
    item(several ? t("menus.tag.deleteLocalAndRemote") : t("menus.tag.deleteRemoteToo"), Trash2, () => void deleteTag(repoId, ref.name, true), { danger: true, blocked: noRemote }),
  ]);
}

export function stashMenu(ctx: MenuBase & { stash: Stash }): MenuEntry[] {
  const { repoId, tabId, stash } = ctx;
  const conflicted = cachedStatus(repoId)?.conflicted.length ? t("menus.stash.resolveOpenConflicts") : null;
  return tidy([
    item(t("menus.stash.apply"), ArchiveRestore, () => void applyStash(repoId, stash, tabId), { hint: conflicted ? undefined : t("menus.stash.applyHint"), blocked: conflicted }),
    item(t("menus.stash.pop"), ArchiveRestore, () => void popStash(repoId, stash, tabId), {
      shortcut: stash.index === 0 ? "Alt+P" : undefined,
      hint: conflicted || stash.index === 0 ? undefined : t("menus.stash.popHint"),
      blocked: conflicted,
    }),
    SEPARATOR,
    item(t("menus.rename"), Pencil, () => void renameStash(repoId, stash)),
    item(t("menus.createPatch"), FileDiff, () => void patchFromStash(repoId, stash)),
    SEPARATOR,
    item(t("menus.stash.delete"), Trash2, () => void dropStash(repoId, stash), { danger: true }),
  ]);
}

export function remoteMenu(ctx: MenuBase & { remote: Remote }): MenuEntry[] {
  const { repoId, remote } = ctx;
  return tidy([
    item(t("menus.remote.fetchFrom", { name: q(remote.name, 24) }), CloudDownload, () => void fetchAll(repoId, remote.name), { tooltip: t("menus.remote.fetchFrom", { name: t("menus.quoted", { name: remote.name }) }) }),
    item(t("menus.remote.edit"), Pencil, () => editRemote(remote.name)),
    item(t("menus.remote.copyUrl"), Copy, () => void copyText(remote.fetchUrl, t("menus.remote.url")), { tooltip: t("menus.remote.copyUrlTip", { url: remote.fetchUrl }) }),
    SEPARATOR,
    item(t("menus.remote.remove"), Trash2, () => void removeRemote(repoId, remote), { danger: true }),
  ]);
}

// ---------------------------------------------------------------------------
// Reflog
// ---------------------------------------------------------------------------

/** Right-click on a reflog entry. If the commit is gone, only copying the SHA remains. */
export function reflogMenu(ctx: MenuBase & { sha: Sha; exists: boolean }): MenuEntry[] {
  const { repoId, tabId, sha } = ctx;
  const blocked = ctx.exists ? operationBlock(repoId) : t("menus.reflog.gone");
  const current = currentName(repoId);
  const detached = cachedStatus(repoId)?.head.kind === "detached";
  return tidy([
    item(t("menus.createBranchHere"), GitBranchPlus, () => void createBranch(repoId, { start: sha, tabId }), { blocked }),
    item(t("menus.commit.checkout"), LogIn, () => void checkoutCommit(repoId, sha, tabId), {
      hint: t("menus.detachedHint"),
      blocked: blocked ?? (headSha(repoId) === sha && detached ? t("menus.commit.alreadyCheckedOut") : null),
    }),
    item(t("menus.commit.resetHere", { name: current.label }), RotateCcw, () => undefined, {
      tooltip: t("menus.commit.resetTip", { name: current.full, sha: short(sha) }),
      ...(blocked ? { blocked } : { children: resetMenu(ctx, sha) }),
    }),
    SEPARATOR,
    item(t("menus.commit.copySha"), Copy, () => void copyText(sha, "SHA"), { hint: short(sha) }),
  ]);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function ignoreMenu(repoId: Id, files: FileChange[]): MenuEntry[] {
  const suggestions = ignoreSuggestions(files);
  return suggestions.map((suggestion) => item(`${suggestion.label} …`, null, () => void ignoreFiles(repoId, files, suggestion.key as IgnorePreset), { hint: clipMiddle(suggestion.pattern, 28) }));
}

export function fileMenu(ctx: MenuBase & { files: FileChange[]; source: DiffSource }): MenuEntry[] {
  const { repoId, tabId, files, source } = ctx;
  if (files.length === 0) return [];
  const store = useAppStore.getState;
  const paths = files.map((file) => file.path);
  const single = files.length === 1 ? files[0]! : null;
  const count = files.length;
  const conflicted = files.filter((file) => file.status === "conflicted");
  const onlyConflicts = conflicted.length === count;
  const someConflicts = conflicted.length > 0 && !onlyConflicts ? t("menus.file.containsConflicts") : null;
  const worktree = source.kind === "unstaged" || source.kind === "staged";
  /** The file (still) exists in the working directory. */
  const onDisk = (file: FileChange) => !(worktree && file.status === "deleted");
  const sha = source.kind === "commit" ? source.sha : source.kind === "stash" ? (cachedStashes(repoId)?.find((stash) => stash.index === source.index)?.sha ?? null) : null;
  /** Version for file view and blame: the commit, otherwise the working directory. */
  const viewSha = source.kind === "commit" ? source.sha : source.kind === "range" ? source.to : null;

  const primary: (MenuEntry | null)[] = [];
  if (source.kind === "unstaged" && onlyConflicts) {
    primary.push(
      single ? item(t("menus.file.resolveConflict"), Wrench, () => store().openConflict(tabId, single.path)) : null,
      single ? item(t("menus.file.openMergeTool"), ExternalLink, () => void openMergeTool(repoId, single.path)) : null,
      item(t("menus.file.takeOurs"), Check, () => void resolveConflictSide(repoId, paths, "ours"), { hint: single ? undefined : t("menus.file.nFiles", { n: count }) }),
      item(t("menus.file.takeTheirs"), Check, () => void resolveConflictSide(repoId, paths, "theirs"), { hint: single ? undefined : t("menus.file.nFiles", { n: count }) }),
    );
  } else if (source.kind === "unstaged") {
    const ignore = ignoreMenu(repoId, files);
    primary.push(
      item(single ? t("menus.file.stage") : t("menus.file.stageMany", { n: count }), Plus, () => void stagePaths(repoId, paths), { shortcut: "S", blocked: someConflicts }),
      item(single ? t("menus.file.stashOnly") : t("menus.file.stashOnlyMany", { n: count }), Archive, () => void stashFiles(repoId, paths), { blocked: someConflicts }),
      item(t("menus.file.ignore"), EyeOff, () => undefined, ignore.length ? { children: ignore } : { blocked: t("menus.file.ignoreNone") }),
      item(single ? t("menus.file.discard") : t("menus.file.discardMany", { n: count }), Trash2, () => void discardPaths(repoId, paths), { danger: true, blocked: someConflicts }),
    );
  } else if (source.kind === "staged") {
    primary.push(item(single ? t("menus.file.unstage") : t("menus.file.unstageMany", { n: count }), Minus, () => void unstagePaths(repoId, paths), { shortcut: "U", hint: t("menus.file.unstageHint") }));
  } else if (sha) {
    primary.push(
      source.kind === "stash"
        ? // Individual files from a stash: the same action, called by its name. The stash is kept.
          item(single ? t("menus.file.applyFromStash") : t("menus.file.applyFromStashMany", { n: count }), ArchiveRestore, () => void restoreFile(repoId, sha, paths), {
            hint: t("menus.file.fromStashHint"),
            blocked: files.every((file) => file.status === "deleted") ? t("menus.file.goneInStash") : null,
          })
        : item(single ? t("menus.file.restore") : t("menus.file.restoreMany", { n: count }), RotateCcw, () => void restoreFile(repoId, sha, paths), {
            hint: t("menus.file.restoreHint", { sha: short(sha) }),
            blocked: files.every((file) => file.status === "deleted") ? t("menus.file.goneInCommit") : null,
          }),
    );
    if (source.kind === "commit") {
      primary.push(
        item(t("menus.file.compareWorktree"), GitCompareArrows, () => single && store().openDiff(tabId, single.path, { kind: "range", from: source.sha, to: null }), {
          blocked: single ? null : t("menus.file.onlyOne"),
        }),
      );
    }
  }

  const one = single ? null : t("menus.file.onlyOne");
  const gone = single && !onDisk(single) ? t("menus.file.deleted") : null;
  return tidy([
    ...primary,
    SEPARATOR,
    item(t("menus.file.history"), History, () => single && store().openHistory(tabId, single.path), { blocked: one }),
    item(t("menus.file.blame"), Users, () => single && store().openBlame(tabId, single.path, viewSha), {
      hint: one ? undefined : t("menus.file.blameHint"),
      blocked: one ?? (single?.isBinary ? t("menus.file.binary") : viewSha === null ? gone : single?.status === "deleted" ? t("menus.file.deletedInCommit") : null),
    }),
    item(t("menus.file.view"), FileText, () => single && store().openFile(tabId, single.path, viewSha, "view"), {
      blocked: one ?? (viewSha === null ? gone : single?.status === "deleted" ? t("menus.file.deletedInCommit") : null),
    }),
    item(t("menus.file.edit"), FilePenLine, () => single && store().openFile(tabId, single.path, null, "edit"), { blocked: one ?? gone ?? (single?.isBinary ? t("menus.file.binary") : null) }),
    // New file next to the selected one: the folder is already in the field.
    worktree ? item(t("menus.file.create"), FilePlus, () => void createFile(repoId, tabId, (files[0]?.path ?? "").replace(/[^/]*$/, ""))) : null,
    worktree ? item(t("menus.file.delete"), FileX, () => single && void deleteFile(repoId, tabId, single.path), { danger: true, blocked: one ?? gone ?? (single?.status === "conflicted" ? t("menus.file.resolveConflictFirst") : null) }) : null,
    SEPARATOR,
    item(t("menus.file.openDiffTool"), GitCompareArrows, () => single && void openDiffTool(repoId, single.path, source), {
      blocked: one ?? (single?.status === "conflicted" ? t("menus.file.useMergeTool") : null),
    }),
    item(t("menus.file.openEditor"), ExternalLink, () => single && void openExternal(repoId, "editor", single.path), { blocked: one ?? gone }),
    item(t("menus.file.showInFileManager"), FolderOpen, () => void openExternal(repoId, "file_manager", single ? single.path : (files[0]?.path ?? null)), { blocked: one }),
    item(single ? t("menus.file.copyPath") : t("menus.file.copyPaths", { n: count }), Copy, () => void copyText(paths.join("\n"), single ? t("menus.file.path") : t("menus.file.paths", { n: count }))),
    item(single ? t("menus.file.patch") : t("menus.file.patchMany", { n: count }), FileDiff, () => void patchFromFiles(repoId, source, files), {
      blocked: conflicted.length > 0 ? t("menus.file.containsConflicts") : files.every((file) => file.isBinary) ? t("menus.file.binaryNoPatch") : null,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Drop menu
// ---------------------------------------------------------------------------

export function dropMenu(ctx: MenuBase & { source: Ref; target: Ref }): MenuEntry[] {
  const { repoId, tabId, source, target } = ctx;
  const busy = operationBlock(repoId);
  const s = q(source.name, 26);
  const d = q(target.name, 26);
  const fullS = t("menus.quoted", { name: source.name });
  const fullT = t("menus.quoted", { name: target.name });
  const same = source.fullName === target.fullName ? t("menus.drop.sameBranch") : source.sha === target.sha ? t("menus.sameCommit") : null;
  const index = graphIndex(repoId);
  const merged = index ? isAncestor(index, source.sha, target.sha) : null;
  const ahead = index ? isAncestor(index, target.sha, source.sha) : null;
  const sourceLocal = source.kind === "local" ? null : t("menus.drop.onlyLocalRebase");
  const targetLocal = target.kind === "local" ? null : target.kind === "remote" ? t("menus.drop.targetMustBeLocal") : t("menus.drop.noMergeIntoTag");

  const entries: MenuEntry[] = [
    item(t("menus.mergeInto", { source: s, target: d }), GitMerge, () => void mergeInto(repoId, source, target, tabId), {
      tooltip: t("menus.mergeInto", { source: fullS, target: fullT }),
      hint:
        busy || same || targetLocal || merged
          ? undefined
          : target.isHead
            ? ahead
              ? t("menus.viaFastForward")
              : undefined
            : t("menus.drop.checksOutFirst", { name: clipMiddle(target.name, 20) }),
      blocked: busy ?? targetLocal ?? same ?? (merged ? t("menus.alreadyIn", { name: d }) : null),
    }),
    item(t("menus.rebaseTip", { name: s, target: d }), Milestone, () => void rebaseBranchOnto(repoId, source, target, tabId), {
      tooltip: t("menus.rebaseTip", { name: fullS, target: fullT }),
      hint: busy || same || sourceLocal || ahead || source.isHead ? undefined : t("menus.drop.checksOutFirst", { name: clipMiddle(source.name, 20) }),
      blocked: busy ?? sourceLocal ?? same ?? (ahead ? t("menus.drop.basedOn", { source: s, target: d }) : null),
    }),
    item(t("menus.interactiveOnto", { name: s, target: d }), ListOrdered, () => void interactiveRebaseOnto(repoId, source, target, tabId), {
      tooltip: t("menus.interactiveOntoTip", { name: fullS, target: fullT }),
      blocked: busy ?? sourceLocal ?? same ?? (merged ? t("menus.noOwnCommits", { name: s }) : null),
    }),
  ];
  if (target.kind === "remote") {
    entries.push(
      SEPARATOR,
      item(t("menus.drop.pushTo", { source: s, target: d }), ArrowUpFromLine, () => void pushTo(repoId, source, target, tabId), {
        tooltip: t("menus.drop.pushTo", { source: fullS, target: fullT }),
        hint: source.kind !== "local" || merged || source.upstream === target.name ? undefined : t("menus.drop.becomesUpstream"),
        blocked: source.kind !== "local" ? t("menus.drop.onlyLocalPush") : merged ? t("menus.nothingToPush") : null,
      }),
    );
  }
  // A pull request is created at the host (GitHub, GitLab). The entry is enabled as soon as an account
  // is connected for this repository's host (Preferences › Integrations); otherwise it is disabled and
  // says what is missing.
  const link = hostLink(repoId);
  const targetBranch = target.kind === "remote" && target.remote && target.name.startsWith(`${target.remote}/`) ? target.name.slice(target.remote.length + 1) : target.name;
  const prBlock =
    link.state !== "connected"
      ? t("menus.drop.needsHost")
      : source.kind !== "local"
        ? t("menus.drop.sourceMustBeLocal")
        : target.kind === "tag"
          ? t("menus.drop.targetMustBeBranch")
          : same;
  entries.push(
    SEPARATOR,
    // Short label so the reason fits next to it; both names are spelled out in the tooltip.
    item(t("menus.pr.create"), GitPullRequestArrow, () => openPrCreate(repoId, tabId, { source: source.name, target: targetBranch }), {
      tooltip:
        link.state === "connected"
          ? t("menus.drop.prTip", { source: fullS, target: t("menus.quoted", { name: targetBranch }) })
          : t("menus.drop.prTipNoAccount", { source: fullS, target: fullT }),
      blocked: prBlock,
    }),
  );
  return tidy(entries);
}
