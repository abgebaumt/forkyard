/**
 * Why a command is not available right now – for disabled matches in the palette.
 *
 * Commands can supply their reason themselves (`disabledReason`). Otherwise it is guessed here from
 * the state: no repository, running operation, no selection, no remote, no stash, nothing to
 * stage. If nothing fits, a general sentence remains – better vague than wrong.
 */
import type { Remote, Stash } from "../../core";
import type { AppCommand, CommandContext } from "../../app/commandTypes";
import { operationNames } from "../../app/actions/merge";
import { qk } from "../../app/queries";
import { t } from "../../i18n";

const REPO_GROUPS = new Set(["Repository", "Remote", "Branch", "Stash", "Commit", "Datei"]);

export function unavailableReason(command: AppCommand, ctx: CommandContext): string {
  try {
    const own = command.disabledReason?.(ctx);
    if (own) return own;
  } catch {
    // eigener Grund kaputt: raten
  }
  const id = command.id;
  if (!ctx.repoId) {
    if (REPO_GROUPS.has(command.group) || id.startsWith("view.") || id.startsWith("wip.") || id.startsWith("focus.")) return t("palette.reason.repoOnly");
    if (id.startsWith("tab.")) return ctx.tabs.length <= 1 ? t("palette.reason.oneTab") : t("palette.reason.noSuchTab");
    return t("palette.reason.unavailable");
  }
  const status = ctx.status;
  if (!status) return t("palette.reason.loading");

  const remotes = ctx.queryClient.getQueryData<Remote[]>(qk.remotes(ctx.repoId));
  const stashes = ctx.queryClient.getQueryData<Stash[]>(qk.stashes(ctx.repoId)) ?? [];
  const selection = ctx.view?.selection ?? { kind: "wip" as const };
  const selected = selection?.kind === "commits" ? selection.shas.length : 0;
  const changes = status.unstaged.length + status.staged.length;

  if (id.startsWith("stash.") && id !== "stash.create" && id !== "stash.createNamed" && stashes.length === 0) return t("palette.reason.noStash");
  if ((id === "stash.create" || id === "stash.createNamed" || id.includes("discard")) && changes === 0) return t("palette.reason.noChanges");
  if (id === "wip.stageAll") return status.unstaged.length === 0 ? t("palette.reason.nothingToStage") : t("palette.reason.unavailable");
  if (id === "wip.unstageAll") return status.staged.length === 0 ? t("palette.reason.nothingStaged") : t("palette.reason.unavailable");
  if (id === "wip.commit" || id === "wip.commitAll") return t("palette.reason.openWip");

  if (status.operation && (id.startsWith("branch.") || id.startsWith("commit.") || id.startsWith("sync.") || id.includes("discard"))) {
    if (id === "operation.continue") return t("palette.reason.resolveConflicts");
    return t("palette.reason.finishOperation", { operation: operationNames[status.operation.kind] });
  }
  if (id === "operation.continue" || id === "operation.abort") {
    return status.operation ? t("palette.reason.resolveConflicts") : t("palette.reason.noOperation");
  }
  if ((id.startsWith("sync.") || id.startsWith("remote.") || id === "tag.push") && remotes && remotes.length === 0) return t("palette.reason.noRemote");
  if (id === "remote.fetchOne") return t("palette.reason.oneRemote");
  if (status.head.kind === "unborn" && (id.startsWith("branch.") || id.startsWith("tag.") || id.startsWith("commit."))) return t("palette.reason.unborn");
  if (status.head.kind === "detached" && (id.startsWith("sync.") || id.startsWith("branch."))) return t("palette.reason.detached");

  if (id === "commit.compare") return t("palette.reason.selectTwo");
  if (id === "commit.squash") return t("palette.reason.selectRange");
  if (id.startsWith("commit.") && /gewählt|selected/i.test(command.title)) {
    if (selected === 0) return t("palette.reason.selectCommit");
    if (selected > 1) return t("palette.reason.selectOne");
  }
  if (id === "branch.fastForward") return status.upstream ? t("palette.reason.notOnlyBehind") : t("palette.reason.noUpstream");
  if (id === "branch.unsetUpstream") return t("palette.reason.noUpstream");
  if (id === "branch.delete") return t("palette.reason.noOtherBranch");
  if ((id === "tag.push" || id === "tag.delete") ) return t("palette.reason.noTag");
  if (id === "sync.cancel") return t("palette.reason.nothingRunning");
  if (id === "view.graph") return t("palette.reason.graphShown");
  if (id.startsWith("tab.")) return ctx.tabs.length <= 1 ? t("palette.reason.oneTab") : t("palette.reason.noSuchTab");
  if (id === "selection.menu") return t("palette.reason.nothingSelected");
  return t("palette.reason.unavailable");
}
