/**
 * Creating and applying patches – the entry points for menus and commands. Each opens the matching
 * dialog from src/screens/Patches and describes in a half-sentence what the patch is made from.
 */
import { t } from "../../i18n";
import type { DiffSource, FileChange, Id, Sha, Stash } from "../../core";
import { openApplyPatch, openCreatePatch } from "../../screens/Patches";
import { findRow, graphIndex } from "./ancestry";
import { cachedStashes, clip, currentBranch, short } from "./context";

function sourceLabel(repoId: Id, source: DiffSource): { what: string; nameHint: string | null } {
  switch (source.kind) {
    case "unstaged":
      return { what: t("actions.patches.unstaged"), nameHint: currentBranch(repoId) };
    case "staged":
      return { what: t("actions.patches.staged"), nameHint: currentBranch(repoId) };
    case "commit": {
      const index = graphIndex(repoId);
      const summary = index ? findRow(index, source.sha)?.summary : undefined;
      return { what: summary ? t("actions.patches.commitWithSummary", { sha: short(source.sha), summary: clip(summary, 56) }) : t("actions.patches.commit", { sha: short(source.sha) }), nameHint: summary ?? null };
    }
    case "stash": {
      const stash = cachedStashes(repoId)?.find((item) => item.index === source.index);
      return { what: stash ? t("actions.patches.stash", { message: clip(stash.message, 48) }) : t("actions.patches.stashIndex", { index: source.index }), nameHint: stash?.message ?? null };
    }
    case "range":
      return {
        what:
          source.to === null
            ? t("actions.patches.compareWorktree", { from: short(source.from) })
            : t("actions.patches.compare", { from: short(source.from), to: short(source.to) }),
        nameHint: source.to === null ? short(source.from) : `${short(source.from)}-${short(source.to)}`,
      };
  }
}

/** Patch from a commit – in `git format-patch` format, with author and message. */
export function patchFromCommit(repoId: Id, sha: Sha) {
  const source: DiffSource = { kind: "commit", sha };
  return openCreatePatch(repoId, { source, paths: null, ...sourceLabel(repoId, source) });
}

export function patchFromStash(repoId: Id, stash: Pick<Stash, "index">) {
  const source: DiffSource = { kind: "stash", index: stash.index };
  return openCreatePatch(repoId, { source, paths: null, ...sourceLabel(repoId, source) });
}

/** Patch from the local changes; if there are staged and unstaged ones, the dialog lets you choose. */
export function patchFromWip(repoId: Id) {
  return openCreatePatch(repoId, { source: "wip", paths: null, what: t("actions.patches.local"), nameHint: currentBranch(repoId) });
}

/** Patch from only the selected files of a source (working directory, commit, stash, comparison). */
export function patchFromFiles(repoId: Id, source: DiffSource, files: Pick<FileChange, "path">[]) {
  if (files.length === 0) return Promise.resolve(null);
  return openCreatePatch(repoId, { source, paths: files.map((file) => file.path), ...sourceLabel(repoId, source) });
}

export function applyPatch(repoId: Id, tabId: Id | null) {
  return openApplyPatch(repoId, tabId);
}
