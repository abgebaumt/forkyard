/** Context menu of commits in the graph. */
import { shortSha as short } from "../../format";
import {
  Bug,
  ChevronsDownUp,
  ChevronsUpDown,
  Cherry,
  Combine,
  Copy,
  FileDiff,
  FileText,
  GitBranchPlus,
  GitCompareArrows,
  ListOrdered,
  LogIn,
  Milestone,
  Pencil,
  RotateCcw,
  Tag,
  Undo2,
} from "lucide-react";
import type { GraphRow, Id, ResetMode, Sha } from "../../../core";
import type { MenuAction, MenuEntry } from "../../../ui/Menu";
import { consecutiveOnHead, findRow, graphIndex, isAncestor } from "../../actions/ancestry";
import { checkoutCommit, createBranch } from "../../actions/branches";
import { copyText } from "../../actions/clipboard";
import { setAllMergesCollapsed, setMergeCollapsed } from "../../actions/collapse";
import { cachedAiStatus, cachedBisect, cachedRepoSettings, cachedStatus, headSha } from "../../actions/context";
import { featureVisible } from "../../ai/visibility";
import { openReleaseNotes, type ReleaseNotesSubject } from "../../../screens/ReleaseNotes/Dialog";
import {
  cherryPick,
  compareCommits,
  copyCommitMessage,
  resetBranch,
  resetModeHints,
  revertCommit,
  rewordHead,
} from "../../actions/history";
import { interactiveRebase, rebaseOnto } from "../../actions/merge";
import { patchFromCommit } from "../../actions/patches";
import { markBisect, startBisect } from "../../../screens/Bisect/actions";
import { autopilotAccessFor, autopilotRunning, startAutopilot } from "../../../screens/Bisect/autopilotActions";
import { createTag } from "../../actions/tags";
import { t } from "../../../i18n";
import { commandShortcut } from "../../registry";
import { useAppStore } from "../../store";
import { customCommandEntries } from "../custom";
import { type MenuBase, SEPARATOR, item, tidy, operationBlock, currentName } from "./shared";

export function resetMenu(ctx: MenuBase, sha: Sha): MenuEntry[] {
  // The modes are named as in Git; the phrase after them says what happens to the changes.
  const entry = (mode: ResetMode, label: string, danger = false): MenuAction =>
    item(label, null, () => void resetBranch(ctx.repoId, sha, mode, ctx.tabId), { hint: resetModeHints[mode], danger });
  return [entry("soft", "Soft"), entry("mixed", "Mixed"), SEPARATOR, entry("hard", "Hard …", true)];
}

/** Collapse or expand a merge; plus "all merges" (also in the palette, Mod+Shift+[ / ]). */
/** Start a bisect from the selected commit(s); while one runs, mark this commit. */
function bisectEntries(ctx: MenuBase, shas: Sha[]): MenuEntry[] {
  const running = cachedBisect(ctx.repoId)?.active ?? false;
  const sha = shas[0];
  if (running && shas.length === 1 && sha) {
    return [
      item(t("menus.commit.bisectGood"), null, () => void markBisect(ctx.repoId, "good", ctx.tabId, sha)),
      item(t("menus.commit.bisectBad"), null, () => void markBisect(ctx.repoId, "bad", ctx.tabId, sha)),
      item(t("menus.commit.bisectSkip"), null, () => void markBisect(ctx.repoId, "skip", ctx.tabId, sha)),
    ];
  }
  if (shas.length === 0 || shas.length > 2) return [];
  const autopilot = autopilotAccessFor(ctx.repoId);
  return [
    item(t("menus.commit.bisectStart"), Bug, () => void startBisect(ctx.repoId, shas, ctx.tabId), {
      blocked: operationBlock(ctx.repoId) ?? (running ? t("menus.commit.bisectRunning") : null),
    }),
    // The autopilot works in its own worktree: neither an operation nor a manual bisect here blocks it.
    ...(autopilot === "hidden"
      ? []
      : [
          item(t("ui.bisectAutopilot"), null, () => void startAutopilot(ctx.repoId, shas, ctx.tabId), {
            blocked: autopilotRunning(ctx.repoId) ? t("commands.bisect.autopilot.running") : null,
          }),
        ]),
  ];
}

function mergeEntries(ctx: MenuBase, sha: Sha, row: GraphRow | undefined): MenuEntry[] {
  if (row?.kind !== "merge") return [];
  const collapsed = row.collapsedCount !== null;
  // The row carries the full SHA; the view state stores full SHAs.
  const merge = row.sha ?? sha;
  return [
    // A merge with nothing to hide (every commit it brought in is on a visible branch or tag) has no entry of its own.
    ...(row.collapsible
      ? [
          item(
            collapsed ? t("ui.expandMerge") : t("menus.commit.collapseMerge"),
            collapsed ? ChevronsUpDown : ChevronsDownUp,
            () => void setMergeCollapsed(ctx.repoId, merge, !collapsed),
            {
              hint: row.collapseTooLarge
                ? t("graph.row.collapseTooLarge")
                : collapsed
                  ? t("menus.commit.hiddenCommits", { count: row.collapsedCount ?? 0 })
                  : undefined,
            },
          ),
        ]
      : []),
    item(t("menus.commit.collapseAll"), ChevronsDownUp, () => void setAllMergesCollapsed(ctx.repoId, true), {
      shortcut: commandShortcut("graph.collapseAllMerges"),
    }),
    item(t("menus.commit.expandAll"), ChevronsUpDown, () => void setAllMergesCollapsed(ctx.repoId, false), {
      shortcut: commandShortcut("graph.expandAllMerges"),
    }),
  ];
}

/**
 * "Write release notes …" – only while the AI function is visible (AI on, function on, repository
 * not "AI off"). Unknown repository settings count as "AI off here" (the repository toolbar keeps
 * them loaded for the open repository).
 */
export function releaseNotesEntry(repoId: Id, subject: ReleaseNotesSubject): MenuAction | null {
  if (!featureVisible(cachedAiStatus(), "release_notes", cachedRepoSettings(repoId)?.aiOff ?? true)) return null;
  const label = subject.kind === "tag" ? t("menus.tag.releaseNotes") : t("menus.commit.releaseNotes");
  return item(label, FileText, () => void openReleaseNotes(repoId, subject));
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
      item(
        t("menus.commit.cherryPickMany", { n: count }),
        Cherry,
        () => useAppStore.getState().openRebase(tabId, "HEAD", "cherry_pick", shas),
        {
          hint: busy || allContained ? undefined : t("menus.commit.onto", { name: current.label }),
          tooltip: t("menus.commit.cherryPickManyTip", { n: count, name: current.full }),
          blocked: busy ?? (allContained ? t("menus.alreadyIn", { name: current.label }) : null),
        },
      ),
      item(t("menus.commit.squashMany", { n: count }), Combine, () => useAppStore.getState().openRebase(tabId, "", "squash", shas), {
        blocked: busy ?? (detached ? t("menus.noBranch") : squash.ok === false ? squash.reason : null),
      }),
      count === 2 && first && second
        ? item(t("ui.compare"), GitCompareArrows, () => compareCommits(tabId, first, second), {
            hint: `${short(first)} ↔ ${short(second)}`,
          })
        : null,
      SEPARATOR,
      ...bisectEntries(ctx, shas),
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
    releaseNotesEntry(repoId, { kind: "commit", sha }),
    SEPARATOR,
    item(t("ui.checkOutCommit"), LogIn, () => void checkoutCommit(repoId, sha, tabId), {
      hint: t("menus.detachedHint"),
      blocked: busy ?? (isHead && detached ? t("menus.commit.alreadyCheckedOut") : null),
    }),
    SEPARATOR,
    item(t("ui.cherryPick"), Cherry, () => void cherryPick(repoId, [sha], tabId), {
      hint: t("menus.commit.onto", { name: current.label }),
      tooltip: t("menus.commit.cherryPickTip", { name: current.full }),
      blocked: busy ?? (contained ? t("menus.alreadyIn", { name: current.label }) : null),
    }),
    item(t("ui.revert"), Undo2, () => void revertCommit(repoId, sha, tabId), {
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
        busy ??
        (detached
          ? t("menus.noBranch")
          : isHead
            ? t("menus.commit.noLaterCommit")
            : contained === false || above
              ? t("menus.commit.onlyCommitsOf", { name: current.label })
              : null),
    }),
    SEPARATOR,
    ...mergeEntries(ctx, sha, row),
    ...bisectEntries(ctx, [sha]),
    SEPARATOR,
    isHead ? item(t("menus.commit.reword"), Pencil, () => void rewordHead(repoId, sha, tabId), { blocked: busy }) : null,
    item(t("ui.copySha"), Copy, () => void copyText(sha, "SHA"), { hint: short(sha) }),
    item(t("menus.commit.copyMessage"), Copy, () => void copyCommitMessage(repoId, sha), {
      tooltip: row?.summary ? t("menus.commit.copyMessageTip", { summary: row.summary }) : undefined,
    }),
    item(t("menus.createPatch"), FileDiff, () => void patchFromCommit(repoId, sha), { hint: t("menus.commit.createPatchHint") }),
    ...customCommandEntries(repoId, "commit", { sha }),
  ]);
}
