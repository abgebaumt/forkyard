/** Context menus of tags, stashes, remotes and reflog entries. */
import { shortSha as short } from "../../format";
import { ArchiveRestore, CloudDownload, CloudUpload, Copy, FileDiff, GitBranchPlus, LogIn, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { Ref, Remote, Sha, Stash } from "../../../core";
import type { MenuEntry } from "../../../ui/Menu";
import { checkout, checkoutCommit, createBranch } from "../../actions/branches";
import { copyText } from "../../actions/clipboard";
import { cachedRemotes, cachedStatus, clipMiddle, headSha } from "../../actions/context";
import { patchFromStash } from "../../actions/patches";
import { editRemote, removeRemote } from "../../actions/remotes";
import { applyStash, dropStash, popStash, renameStash } from "../../actions/stash";
import { fetchAll } from "../../actions/sync";
import { deleteTag, pushTag } from "../../actions/tags";
import { t } from "../../../i18n";
import { commandShortcut } from "../../registry";
import { type MenuBase, SEPARATOR, item, q, tidy, operationBlock, currentName } from "./shared";
import { releaseNotesEntry, resetMenu } from "./commit";

export function tagMenu(ctx: MenuBase & { ref: Ref }): MenuEntry[] {
  const { repoId, tabId, ref } = ctx;
  const busy = operationBlock(repoId);
  const remotes = cachedRemotes(repoId);
  const noRemote = remotes && remotes.length === 0 ? t("menus.noRemote") : null;
  const several = (remotes?.length ?? 1) > 1;
  const only = remotes?.length === 1 ? remotes[0]!.name : null;
  return tidy([
    item(t("ui.checkOut"), LogIn, () => void checkout(repoId, ref.fullName, { tabId }), {
      hint: t("menus.detachedHint"),
      blocked: busy,
    }),
    item(t("menus.createBranchHere"), GitBranchPlus, () => void createBranch(repoId, { start: ref.fullName, tabId }), { blocked: busy }),
    SEPARATOR,
    item(
      several
        ? t("menus.tag.pushToRemoteChoose")
        : only
          ? t("menus.tag.pushTo", { name: clipMiddle(only, 24) })
          : t("menus.tag.pushToRemote"),
      CloudUpload,
      () => void pushTag(repoId, ref.name),
      { blocked: noRemote },
    ),
    item(t("menus.copyName"), Copy, () => void copyText(ref.name, t("ui.tagName"))),
    releaseNotesEntry(repoId, { kind: "tag", name: ref.name }),
    SEPARATOR,
    item(t("menus.tag.deleteLocal"), Trash2, () => void deleteTag(repoId, ref.name, null), { danger: true }),
    item(
      several ? t("menus.tag.deleteLocalAndRemote") : t("menus.tag.deleteRemoteToo"),
      Trash2,
      () => void deleteTag(repoId, ref.name, true),
      { danger: true, blocked: noRemote },
    ),
  ]);
}

export function stashMenu(ctx: MenuBase & { stash: Stash }): MenuEntry[] {
  const { repoId, tabId, stash } = ctx;
  const conflicted = cachedStatus(repoId)?.conflicted.length ? t("menus.stash.resolveOpenConflicts") : null;
  return tidy([
    item(t("menus.stash.apply"), ArchiveRestore, () => void applyStash(repoId, stash, tabId), {
      hint: conflicted ? undefined : t("menus.stash.applyHint"),
      blocked: conflicted,
    }),
    item(t("menus.stash.pop"), ArchiveRestore, () => void popStash(repoId, stash, tabId), {
      shortcut: stash.index === 0 ? commandShortcut("stash.pop") : undefined,
      hint: conflicted || stash.index === 0 ? undefined : t("menus.stash.popHint"),
      blocked: conflicted,
    }),
    SEPARATOR,
    item(t("ui.rename"), Pencil, () => void renameStash(repoId, stash)),
    item(t("menus.createPatch"), FileDiff, () => void patchFromStash(repoId, stash)),
    SEPARATOR,
    item(t("ui.delete"), Trash2, () => void dropStash(repoId, stash), { danger: true }),
  ]);
}

export function remoteMenu(ctx: MenuBase & { remote: Remote }): MenuEntry[] {
  const { repoId, remote } = ctx;
  return tidy([
    item(t("menus.remote.fetchFrom", { name: q(remote.name, 24) }), CloudDownload, () => void fetchAll(repoId, remote.name), {
      tooltip: t("menus.remote.fetchFrom", { name: t("menus.quoted", { name: remote.name }) }),
    }),
    item(t("menus.remote.edit"), Pencil, () => editRemote(remote.name)),
    item(t("ui.copyUrl"), Copy, () => void copyText(remote.fetchUrl, t("menus.remote.url")), {
      tooltip: t("menus.remote.copyUrlTip", { url: remote.fetchUrl }),
    }),
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
    item(t("ui.checkOutCommit"), LogIn, () => void checkoutCommit(repoId, sha, tabId), {
      hint: t("menus.detachedHint"),
      blocked: blocked ?? (headSha(repoId) === sha && detached ? t("menus.commit.alreadyCheckedOut") : null),
    }),
    item(t("menus.commit.resetHere", { name: current.label }), RotateCcw, () => undefined, {
      tooltip: t("menus.commit.resetTip", { name: current.full, sha: short(sha) }),
      ...(blocked ? { blocked } : { children: resetMenu(ctx, sha) }),
    }),
    SEPARATOR,
    item(t("ui.copySha"), Copy, () => void copyText(sha, "SHA"), { hint: short(sha) }),
  ]);
}
