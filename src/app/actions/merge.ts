import { t } from "../../i18n";
import { core, type CoreError, type Id, type MergeMode, type OpResult, type OperationKind } from "../../core";
import { toast } from "../../ui/Feedback";
import { confirm } from "../dialogs";
import { runAction } from "../run";
import { withFreshStatus, withStatus } from "../statusCache";
import { useAppStore } from "../store";
import { cachedSettings, currentBranch } from "./context";
import { busyKeys } from "./keys";
import { preflight } from "./preflight";

export const operationNames: Record<OperationKind, string> = {
  merge: t("actions.merge.operation.merge"),
  rebase: t("actions.merge.operation.rebase"),
  cherry_pick: t("actions.merge.operation.cherryPick"),
  revert: t("actions.merge.operation.revert"),
};

export interface ReportOptions {
  /** On success, select the new commit in the graph and scroll to it. */
  reveal?: boolean;
  /**
   * The result comes from applying a stash: on conflicts the stash is kept and
   * no operation is running – the message says so instead of "continue or abort".
   */
  stash?: boolean;
}

/** Shows the WIP view with the conflicted files: selection on WIP, Commit Panel visible. */
export function showWip(tabId: Id | null | undefined): void {
  if (!tabId) return;
  const store = useAppStore.getState();
  store.selectWip(tabId);
  store.setRightCollapsed(tabId, false);
}

/** Files blocking an action: from the core's message (‘…’), otherwise from Git's output. */
export function blockingFiles(error: CoreError): string[] {
  const quoted = [...error.message.matchAll(/[‘‚]([^’‘]+)[’‘]/g)].map((match) => match[1]!);
  if (quoted.length) return quoted;
  return (error.gitOutput ?? "")
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Reports the result of merge, rebase, cherry-pick, revert, pull and stash apply.
 * On conflicts the tab (if given) jumps to the WIP view, where the conflicted files are.
 */
export function reportOpResult(label: string, result: OpResult, tabId?: Id | null, options: ReportOptions = {}): void {
  switch (result.status) {
    case "done":
      toast({
        tone: "success",
        title: t("actions.merge.result.done", { label }),
        description: result.summary || (result.fastForward ? t("actions.merge.result.fastForward") : undefined),
      });
      if (options.reveal && tabId && result.sha) useAppStore.getState().revealCommit(tabId, result.sha);
      break;
    case "up_to_date":
      toast({ tone: "info", title: t("actions.merge.result.upToDate"), description: t("actions.merge.result.nothingToDo", { label }) });
      break;
    case "conflict": {
      const count = result.files.length;
      const title = t("actions.merge.result.conflict", { label, count });
      if (count === 0) {
        // Rebase stops without a conflict (edit/break): the operation keeps running.
        toast({ tone: "warning", title: t("actions.merge.result.stopped", { label }), description: t("actions.merge.result.stoppedDescription") });
      } else if (options.stash) {
        toast({
          tone: "warning",
          title,
          description: t("actions.merge.result.conflictStash"),
        });
      } else if (!result.operation) {
        toast({
          tone: "warning",
          title,
          description: t("actions.merge.result.conflictNoOperation"),
        });
      } else {
        toast({
          tone: "warning",
          title,
          description: t("actions.merge.result.conflictOperation", { operation: operationNames[result.operation.kind] }),
        });
      }
      showWip(tabId);
      break;
    }
  }
}

/** Merge mode without an explicit choice: squash if the setting "Squash when merging" is on. */
export function defaultMergeMode(): MergeMode {
  return cachedSettings()?.squashOnMerge ? "squash" : "default";
}

/**
 * Merges `source` into the checked-out branch. Without `mode` the setting applies (squash or
 * fast-forward if possible). Conflict → WIP view.
 */
export async function mergeBranch(repoId: Id, source: string, mode?: MergeMode, tabId?: Id | null) {
  const effective = mode ?? defaultMergeMode();
  const target = currentBranch(repoId);
  const label = effective === "squash" ? t("actions.merge.squashLabel") : t("actions.merge.label");
  if (effective !== "ff_only") {
    const choice = await preflight(repoId, { title: t("preflight.mergeTitle", { source, target: target ?? "HEAD" }), confirmLabel: label, op: { kind: "merge", theirs: source } });
    if (!choice) return null;
  }
  const result = await runAction(label, withFreshStatus(repoId, () => core.mergeStart({ repoId, source, mode: effective })), {
    busyKey: busyKeys.history(repoId),
  });
  if (!result.ok) return result;
  if (effective === "squash" && result.value.status === "done") {
    // Squash creates no commit: the changes are staged and wait for the message.
    toast({
      tone: "success",
      title: t("actions.merge.squashDone", { source }),
      description: target ? t("actions.merge.squashCommitInto", { target }) : t("actions.merge.squashCommit"),
    });
    showWip(tabId);
    return result;
  }
  reportOpResult(label, result.value, tabId, { reveal: true });
  return result;
}

/** Fast-forwards the checked-out branch to `upstream`; fails if local commits are in the way. */
export async function fastForward(repoId: Id, upstream: string, tabId?: Id | null) {
  const result = await runAction(t("actions.fastForward.label"), withFreshStatus(repoId, () => core.mergeStart({ repoId, source: upstream, mode: "ff_only" })), {
    busyKey: busyKeys.history(repoId),
  });
  if (result.ok) reportOpResult(t("actions.fastForward.label"), result.value, tabId, { reveal: true });
  return result;
}

/**
 * Continue a running merge, rebase, cherry-pick or revert. `message` only when concluding a
 * merge; likewise `skipHooks` ("Skip Git hooks" in the commit form also applies to the merge commit).
 */
export async function continueOperation(repoId: Id, message: string | null = null, tabId?: Id | null, skipHooks: boolean | null = null) {
  const result = await runAction(t("actions.merge.continue"), withFreshStatus(repoId, () => core.operationContinue({ repoId, message, skipHooks })), {
    busyKey: busyKeys.write(repoId, "operation"),
  });
  if (result.ok) reportOpResult(t("actions.merge.continue"), result.value, tabId, { reveal: true });
  return result;
}

export async function abortOperation(repoId: Id, kind: OperationKind) {
  const name = operationNames[kind];
  const ok = await confirm({
    title: t("actions.merge.abort.title", { operation: name }),
    body: t("actions.merge.abort.body", { operation: name }),
    confirmLabel: t("actions.merge.abort.action", { operation: name }),
    danger: true,
  });
  if (!ok) return null;
  const result = await runAction(t("actions.merge.abort.action", { operation: name }), withStatus(repoId, () => core.operationAbort({ repoId })), {
    busyKey: busyKeys.write(repoId, "operation"),
    success: t("actions.merge.abort.done", { operation: name }),
  });
  return result;
}

/** Rebases the checked-out branch (or `branch`) onto `onto`. Conflict → WIP view. Offers to move dependent branches along. */
export async function rebaseOnto(repoId: Id, onto: string, branch: string | null = null, tabId?: Id | null) {
  const choice = await preflight(repoId, {
    title: t("preflight.rebaseTitle", { branch: branch ?? currentBranch(repoId) ?? "HEAD", onto }),
    confirmLabel: t("actions.merge.rebaseLabel"),
    op: { kind: "rebase", onto, upstream: null, branch, commits: null },
    rebase: { onto, branch },
  });
  if (!choice) return null;
  const result = await runAction(t("actions.merge.rebaseLabel"), withFreshStatus(repoId, () => core.rebaseStart({ repoId, onto, branch, updateRefs: choice.updateRefs })), {
    busyKey: busyKeys.history(repoId),
  });
  if (result.ok) reportOpResult(t("actions.merge.rebaseLabel"), result.value, tabId, { reveal: true });
  return result;
}

/** Opens the rebase tool for the commits between `base` and HEAD. */
export function interactiveRebase(tabId: Id, base: string): void {
  useAppStore.getState().openRebase(tabId, base, "interactive");
}
