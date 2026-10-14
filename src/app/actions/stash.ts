import { t } from "../../i18n";
import { core, type Id, type Sha, type Stash, type StashSelection } from "../../core";
import { toast } from "../../ui/Feedback";
import { confirm, promptText } from "../dialogs";
import { qk, queryClient } from "../queries";
import { newOpId, runAction, showError } from "../run";
import { withFreshStatus } from "../statusCache";
import { clip, loadStashes } from "./context";
import { busyKeys } from "./keys";
import { blockingFiles, reportOpResult } from "./merge";

export interface StashOptions {
  message?: string | null;
  /** null = all changes. */
  paths?: string[] | null;
  includeUntracked?: boolean;
  /** No success message (the caller reports itself, e.g. "stash and switch"). */
  quiet?: boolean;
  /** false: without its own undo entry ("stash and undo" – the undo afterwards means the action before). */
  undoable?: boolean;
  /** Only these lines (partial stash); `paths` must then be null. */
  selection?: StashSelection | null;
}

/** A stash as menus and lists pass it. With `sha` the action finds it again even if the list has shifted. */
export type StashRef = Pick<Stash, "index" | "message"> & { sha?: Sha };

const stashName = (stash: StashRef) => clip(stash.message || `stash@{${stash.index}}`, 48);

/**
 * The core's stash commands only take the position. If the list has changed since loading
 * (terminal, second window), the old position would hit a different stash: so load fresh
 * first and find it again by SHA. null = the stash no longer exists.
 */
async function resolveIndex(repoId: Id, stash: StashRef): Promise<number | null> {
  if (!stash.sha) return stash.index;
  const list = await loadStashes(repoId).catch(() => null);
  if (!list) return stash.index;
  const found = list.find((item) => item.sha === stash.sha);
  if (!found) {
    toast({ tone: "warning", title: t("actions.stash.gone"), description: t("actions.stash.goneDescription") });
    return null;
  }
  return found.index;
}

/** Stashes the changes (toolbar "Stash"; the stash form calls it with a message). `paths` stashes only these files. */
export async function stashChanges(repoId: Id, options: StashOptions = {}) {
  const paths = options.paths ?? null;
  const result = await runAction(
    t("actions.stash.label"),
    withFreshStatus(repoId, () =>
      core.stashCreate({
        repoId,
        opId: newOpId(),
        message: options.message?.trim() || null,
        paths,
        includeUntracked: options.includeUntracked ?? true,
        undoable: options.undoable ?? null,
        selection: options.selection ?? null,
      }),
    ),
    {
      busyKey: busyKeys.stash(repoId),
      success: options.quiet ? undefined : options.selection ? t("partialStash.done") : paths ? t("actions.stash.doneFiles", { count: paths.length }) : t("actions.stash.done"),
    },
  );
  if (result.ok) queryClient.setQueryData(qk.stashes(repoId), result.value);
  return result;
}

async function applyOrPop(repoId: Id, kind: "apply" | "pop", stash: StashRef, tabId?: Id | null) {
  const label = kind === "pop" ? t("actions.stash.pop") : t("actions.stash.apply");
  const index = await resolveIndex(repoId, stash);
  if (index === null) return null;
  const result = await runAction(label, withFreshStatus(repoId, () => (kind === "pop" ? core.stashPop({ repoId, index }) : core.stashApply({ repoId, index }))), {
    busyKey: busyKeys.pop(repoId),
    quiet: ["dirty_worktree"],
  });
  if (result.ok) {
    reportOpResult(label, result.value, tabId, { stash: true });
    return result;
  }
  if (result.error.code === "dirty_worktree") {
    // The core applied nothing; name the files that are in the way.
    const files = blockingFiles(result.error);
    showError(label, result.error);
    if (files.length > 3) toast({ tone: "info", title: t("actions.stash.inTheWay"), description: files.slice(0, 12).join("\n") });
  }
  return result;
}

/** Applies a stash and removes it (default: the newest). On conflicts it is kept. */
export function popStash(repoId: Id, stash: number | StashRef = 0, tabId?: Id | null) {
  return applyOrPop(repoId, "pop", typeof stash === "number" ? { index: stash, message: "" } : stash, tabId);
}

/** Applies a stash without removing it. */
export function applyStash(repoId: Id, stash: number | StashRef, tabId?: Id | null) {
  return applyOrPop(repoId, "apply", typeof stash === "number" ? { index: stash, message: "" } : stash, tabId);
}

export async function dropStash(repoId: Id, stash: StashRef) {
  const ok = await confirm({
    title: t("actions.stash.drop.title", { name: stashName(stash) }),
    body: t("actions.stash.drop.body"),
    confirmLabel: t("actions.stash.drop.action"),
    danger: true,
  });
  if (!ok) return null;
  const index = await resolveIndex(repoId, stash);
  if (index === null) return null;
  const result = await runAction(t("actions.stash.drop.action"), () => core.stashDrop({ repoId, index }), {
    busyKey: busyKeys.pop(repoId),
    success: t("actions.stash.drop.done"),
  });
  if (result.ok) queryClient.setQueryData(qk.stashes(repoId), result.value);
  return result;
}

export async function renameStash(repoId: Id, stash: StashRef) {
  const message = await promptText({
    title: t("actions.stash.rename.title"),
    label: t("actions.stash.rename.label"),
    initial: stash.message,
    confirmLabel: t("actions.branches.rename.action"),
    validate: (value) => (value === stash.message ? t("actions.stash.rename.unchanged") : null),
  });
  if (message === null) return null;
  const index = await resolveIndex(repoId, stash);
  if (index === null) return null;
  const result = await runAction(t("actions.stash.rename.title"), () => core.stashRename({ repoId, index, message }), {
    success: t("actions.stash.rename.done", { name: clip(message, 48) }),
  });
  if (result.ok) queryClient.setQueryData(qk.stashes(repoId), result.value);
  return result;
}
