import { core, type Id, type Ref, type Sha, type Status } from "../../core";
import { toast } from "../../ui/Feedback";
import { choose, confirm, pickFromList, promptText } from "../dialogs";
import { t } from "../../i18n";
import { qk, queryClient } from "../queries";
import { runAction, showError, type ActionResult } from "../run";
import { withFreshStatus, withStatus } from "../statusCache";
import { useAppStore, type Selection } from "../store";
import { commitsBetween, isAncestor, loadGraphIndex } from "./ancestry";
import { cachedGraphRows, cachedRefs, clip, currentBranch, headSha, loadRefs, short } from "./context";
import { busyKeys } from "./keys";
import { blockingFiles } from "./merge";
import { stashChanges } from "./stash";

/** Spaces become "-" while typing (branch and tag names). */
export const normalizeRefName = (value: string) => value.replace(/\s/g, "-");

/** Validator for promptText: asks the core for Git's rules and existing names. */
export function refNameValidator(repoId: Id, kind: "branch" | "tag") {
  return async (value: string): Promise<string | null> => {
    const name = value.trim();
    if (!name) return null;
    try {
      const check = await core.refNameCheck({ repoId, name, kind });
      return check.valid ? null : (check.reason ?? t("actions.branches.invalidName"));
    } catch {
      // Validation not possible: the core reports it at the latest on creation.
      return null;
    }
  };
}

/** How a start point is called in texts: short SHA or the name. */
const pointName = (value: string) => (/^[0-9a-f]{40}$/.test(value) ? short(value) : value);

/**
 * Uncommitted changes block a switch: name the affected files and offer
 * to stash them. Returns true if it stashed and the caller should try again.
 */
async function offerStash(repoId: Id, files: string[], stashMessage: string): Promise<boolean> {
  const next = await choose({
    title: t("actions.branches.offerStash.title"),
    description: t("actions.branches.offerStash.description"),
    details: files,
    detailsLabel: files.length ? t("actions.branches.offerStash.affected") : undefined,
    options: [
      {
        key: "stash",
        label: t("actions.branches.offerStash.stash"),
        description: t("actions.branches.offerStash.stashDescription"),
      },
    ],
  });
  if (next !== "stash") return false;
  const stashed = await stashChanges(repoId, { message: stashMessage, quiet: true });
  return stashed.ok;
}

export interface CreateBranchOptions {
  /** Start point: branch, tag or SHA; null = HEAD. */
  start?: string | null;
  checkout?: boolean;
  tabId?: Id | null;
  /** Prefilled name (e.g. from an issue); the user can change it. */
  suggestedName?: string;
  /** Title and explanation of the dialog when the branch is not simply a "New branch". */
  title?: string;
  description?: string;
}

/**
 * Start point for "New branch" from the toolbar and Ctrl+B: if exactly one commit that is not HEAD
 * is selected in the graph, the branch starts there – otherwise at the current commit (null).
 */
export function selectedBranchStart(repoId: Id, selection: Selection): Sha | null {
  if (selection?.kind !== "commits" || selection.shas.length !== 1) return null;
  const sha = selection.shas[0]!;
  return sha === headSha(repoId) ? null : sha;
}

/** "abc1234 ("Summary")" for a SHA whose row is loaded in the graph; otherwise just the name. */
function describeStart(repoId: Id, start: string): string {
  const name = pointName(start);
  if (name === start) return name;
  const summary = cachedGraphRows(repoId).find((row) => row.sha === start)?.summary;
  return summary ? t("actions.branches.startWithSummary", { name, summary: clip(summary, 48) }) : name;
}

/** Asks for the name, creates the branch and checks it out (unless requested otherwise). */
export async function createBranch(repoId: Id, options: CreateBranchOptions = {}) {
  const start = options.start ?? null;
  const checkoutAfter = options.checkout ?? true;
  const name = await promptText({
    title: options.title ?? t("actions.branches.create.title"),
    description: options.description ?? (start ? t("actions.branches.create.startsAt", { start: describeStart(repoId, start) }) : t("actions.branches.create.startsAtHead")),
    label: t("actions.branches.create.name"),
    initial: options.suggestedName,
    placeholder: t("actions.branches.create.placeholder"),
    mono: true,
    normalize: normalizeRefName,
    validate: refNameValidator(repoId, "branch"),
    confirmLabel: t("actions.branches.create.action"),
  });
  if (!name) return null;
  const create = () => core.branchCreate({ repoId, name, start, checkout: checkoutAfter });
  const run = () =>
    runAction(t("actions.branches.create.action"), checkoutAfter ? withFreshStatus(repoId, create) : create, {
      busyKey: busyKeys.branch(repoId),
      quiet: ["dirty_worktree"],
      success: checkoutAfter ? t("actions.branches.create.doneCheckedOut", { name: clip(name) }) : t("actions.branches.create.done", { name: clip(name) }),
    });
  let result = await run();
  let stashed = false;
  if (!result.ok && result.error.code === "dirty_worktree") {
    stashed = await offerStash(repoId, blockingFiles(result.error), t("actions.branches.stashMessage", { target: name }));
    if (!stashed) return result;
    result = await run();
    if (!result.ok && result.error.code === "dirty_worktree") showError(t("actions.branches.create.action"), result.error);
  }
  if (result.ok) {
    queryClient.setQueryData(qk.refs(repoId), result.value);
    if (stashed) stashHint(name);
  }
  return result;
}

function stashHint(target: string) {
  toast({
    tone: "info",
    title: t("actions.branches.stashHint.title"),
    description: t("actions.branches.stashHint.description", { message: t("actions.branches.stashMessage", { target: clip(target, 40) }) }),
  });
}

export interface CheckoutOptions {
  tabId?: Id | null;
}

/** Target of the checkout currently running per repository. */
const runningCheckouts = new Map<Id, string>();

/**
 * A checkout that lands in a still-running action (second double-click in the graph while the
 * first switch is still working) is not started. A short message that disappears on its own says
 * so – unless it is the same target again: then what was wanted is happening anyway.
 */
function reportBusyCheckout(repoId: Id, target: string): void {
  const running = runningCheckouts.get(repoId);
  if (running === target) return;
  toast({
    tone: "info",
    title: t("actions.branches.busy.title", { target: clip(pointName(target), 40) }),
    description: running
      ? t("actions.branches.busy.running", { target: clip(pointName(running), 40) })
      : t("actions.branches.busy.other"),
  });
}

/**
 * Checks out: local branch, remote branch (creates the local tracking branch) or commit
 * or tag (afterwards no branch is checked out). If uncommitted changes block the switch,
 * it names the files and offers to stash them.
 */
export async function checkout(repoId: Id, target: string, options: CheckoutOptions = {}) {
  const run = () =>
    runAction(t("actions.branches.checkout.action"), withStatus(repoId, () => core.branchCheckout({ repoId, target })), {
      busyKey: busyKeys.history(repoId),
      quiet: ["dirty_worktree"],
    });
  if (useAppStore.getState().busy[busyKeys.history(repoId)]) {
    reportBusyCheckout(repoId, target);
    return run();
  }
  runningCheckouts.set(repoId, target);
  try {
    return await checkoutNow(repoId, target, options, run);
  } finally {
    runningCheckouts.delete(repoId);
  }
}

async function checkoutNow(repoId: Id, target: string, options: CheckoutOptions, run: () => Promise<ActionResult<Status>>) {
  let result = await run();
  let stashed = false;
  if (!result.ok && result.error.code === "dirty_worktree") {
    stashed = await offerStash(repoId, blockingFiles(result.error), t("actions.branches.stashMessage", { target: pointName(target) }));
    if (!stashed) return result;
    result = await run();
    if (!result.ok && result.error.code === "dirty_worktree") showError(t("actions.branches.checkout.action"), result.error);
  }
  if (!result.ok) return result;
  reportCheckout(repoId, result.value, options.tabId);
  if (stashed) stashHint(pointName(target));
  return result;
}

function reportCheckout(repoId: Id, status: Status, tabId?: Id | null) {
  const head = status.head;
  if (head.kind === "detached") {
    toast({
      tone: "info",
      title: t("actions.branches.checkout.detached.title", { sha: short(head.sha) }),
      description: t("actions.branches.checkout.detached.description"),
      action: { label: t("actions.branches.checkout.detached.action"), onClick: () => void createBranch(repoId, { tabId }) },
    });
  } else {
    toast({
      tone: "success",
      title: t("actions.branches.checkout.done", { name: clip(head.branch) }),
      description: status.upstream && !status.upstream.gone ? t("actions.branches.checkout.follows", { upstream: status.upstream.name }) : undefined,
    });
  }
  if (tabId && head.kind !== "unborn") useAppStore.getState().revealCommit(tabId, head.sha);
  // The abandoned detached HEAD carried commits of its own: they now hang on no ref.
  const left = status.leftBehind;
  if (left) {
    toast({
      tone: "warning",
      sticky: true,
      title: t("actions.branches.leftBehind.title", { count: left.count }),
      description: t("actions.branches.leftBehind.description", { count: left.count, sha: short(left.sha) }),
      action: { label: t("actions.branches.leftBehind.action"), onClick: () => void createBranch(repoId, { start: left.sha, checkout: false, tabId }) },
    });
  }
}

/** Checks out a commit (detached HEAD); the message afterwards explains what that means. */
export function checkoutCommit(repoId: Id, sha: Sha, tabId?: Id | null) {
  return checkout(repoId, sha, { tabId });
}

export async function renameBranch(repoId: Id, name: string) {
  const newName = await promptText({
    title: t("actions.branches.rename.title", { name: clip(name, 40) }),
    label: t("actions.branches.rename.label"),
    initial: name,
    mono: true,
    normalize: normalizeRefName,
    validate: async (value) => (value === name ? t("actions.branches.rename.unchanged") : refNameValidator(repoId, "branch")(value)),
    confirmLabel: t("actions.branches.rename.action"),
  });
  if (!newName) return null;
  const result = await runAction(t("actions.branches.rename.action"), () => core.branchRename({ repoId, name, newName }), {
    busyKey: busyKeys.branch(repoId),
    success: t("actions.branches.rename.done", { name: clip(newName) }),
  });
  if (result.ok) queryClient.setQueryData(qk.refs(repoId), result.value);
  return result;
}

interface MergedNote {
  /** true = merged, false = certainly not, null = unknown. */
  merged: boolean | null;
  text: string;
}

/** What happens to a branch's commits when it is deleted – as far as the loaded data can tell. */
async function mergedNote(repoId: Id, ref: Ref): Promise<MergedNote> {
  const current = currentBranch(repoId);
  const head = headSha(repoId);
  const into = current ? t("actions.branches.merged.intoBranch", { name: clip(current, 40) }) : t("actions.branches.merged.intoDetached");
  if (head && ref.sha === head) return { merged: true, text: t("actions.branches.merged.sameCommit", { into }) };
  const index = head ? await loadGraphIndex(repoId) : null;
  const contained = index && head ? isAncestor(index, ref.sha, head) : null;
  if (contained) return { merged: true, text: t("actions.branches.merged.contained", { into }) };
  if (ref.upstream && !ref.upstreamGone && ref.ahead === 0) return { merged: true, text: t("actions.branches.merged.onUpstream", { upstream: ref.upstream }) };
  if (contained === false && index && head) {
    const range = commitsBetween(index, head, ref.sha);
    const count = range && !range.partial ? range.rows.length : null;
    return {
      merged: false,
      text: count ? t("actions.branches.merged.notMergedCount", { count }) : t("actions.branches.merged.notMerged"),
    };
  }
  return { merged: null, text: t("actions.branches.merged.unknown") };
}

/**
 * Deletes local branches after a prompt. The prompt names them and whether they are merged;
 * for unmerged ones the button reads "Delete anyway".
 */
export async function deleteBranches(repoId: Id, names: string[]) {
  if (!names.length) return null;
  const refs = cachedRefs(repoId) ?? (await loadRefs(repoId).catch(() => undefined));
  const targets = names.map((name) => refs?.locals.find((ref) => ref.name === name) ?? null);
  const notes = await Promise.all(targets.map((ref) => (ref ? mergedNote(repoId, ref) : Promise.resolve<MergedNote>({ merged: null, text: t("actions.branches.merged.unknown") }))));
  const single = names.length === 1;
  const unmerged = notes.filter((note) => note.merged === false).length;
  const done = single ? t("actions.branches.delete.doneOne", { name: clip(names[0]!) }) : t("actions.branches.delete.doneMany", { count: names.length });

  const ok = await confirm(
    single
      ? {
          title: unmerged ? t("actions.branches.delete.titleUnmerged", { name: clip(names[0]!, 40) }) : t("actions.branches.delete.title", { name: clip(names[0]!, 40) }),
          body: unmerged
            ? t("actions.branches.delete.bodyUnmerged", { note: notes[0]!.text })
            : notes[0]!.merged
              ? t("actions.branches.delete.bodyMerged", { note: notes[0]!.text })
              : t("actions.branches.delete.body", { note: notes[0]!.text }),
          confirmLabel: unmerged ? t("actions.branches.delete.anyway") : t("actions.branches.delete.action"),
          danger: true,
        }
      : {
          title: t("actions.branches.delete.titleMany", { count: names.length }),
          body: unmerged ? t("actions.branches.delete.bodyManyUnmerged", { count: unmerged }) : t("actions.branches.delete.bodyMany"),
          details: names.map((name, position) => `${name} – ${notes[position]!.text}`),
          confirmLabel: unmerged ? t("actions.branches.delete.anyway") : t("actions.branches.delete.actionMany"),
          danger: true,
        },
  );
  if (!ok) return null;

  const run = (force: boolean) =>
    runAction(t("actions.branches.delete.action"), () => core.branchDelete({ repoId, names, force }), {
      busyKey: busyKeys.branch(repoId),
      quiet: force ? [] : ["not_merged"],
      success: done,
    });
  // Whoever has already confirmed "Delete anyway" is not asked a second time.
  let result = await run(unmerged > 0);
  if (!result.ok && result.error.code === "not_merged") {
    const force = await confirm({
      title: t("actions.branches.delete.forceTitle"),
      body: t("actions.branches.delete.forceBody", { message: result.error.message }),
      confirmLabel: t("actions.branches.delete.anyway"),
      danger: true,
    });
    if (!force) return result;
    result = await run(true);
  }
  if (result.ok) queryClient.setQueryData(qk.refs(repoId), result.value);
  return result;
}

/** Sets the upstream of a local branch; `upstream: null` removes the link. */
export async function setUpstream(repoId: Id, name: string, upstream: string | null) {
  const result = await runAction(upstream ? t("actions.branches.upstream.set") : t("actions.branches.upstream.unset"), () => core.branchSetUpstream({ repoId, name, upstream }), {
    busyKey: busyKeys.branch(repoId),
    success: upstream
      ? t("actions.branches.upstream.setDone", { name: clip(name, 40), upstream: clip(upstream, 40) })
      : t("actions.branches.upstream.unsetDone", { name: clip(name, 40) }),
  });
  if (result.ok) {
    queryClient.setQueryData(qk.refs(repoId), result.value);
    void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
  }
  return result;
}

/** Lets the user pick the upstream from the remote branches (set or change). */
export async function chooseUpstream(repoId: Id, name: string) {
  const refs = await loadRefs(repoId).catch(() => cachedRefs(repoId));
  const local = refs?.locals.find((ref) => ref.name === name);
  const remotes = refs?.remotes ?? [];
  // The remote branch with the same name is at the top: it is almost always the one meant.
  const sorted = [...remotes].sort((a, b) => Number(b.name.endsWith(`/${name}`)) - Number(a.name.endsWith(`/${name}`)) || a.name.localeCompare(b.name));
  const picked = await pickFromList({
    title: local?.upstream ? t("actions.branches.upstream.changeTitle", { name: clip(name, 36) }) : t("actions.branches.upstream.setTitle", { name: clip(name, 36) }),
    description: t("actions.branches.upstream.description"),
    label: t("actions.branches.upstream.label"),
    items: sorted.map((ref) => ({ key: ref.name, label: ref.name, description: ref.name === local?.upstream ? t("actions.branches.upstream.current") : undefined })),
    initial: local?.upstream && !local.upstreamGone ? local.upstream : sorted[0]?.name,
    empty: t("actions.branches.upstream.empty"),
    confirmLabel: t("actions.branches.upstream.set"),
    mono: true,
  });
  if (!picked) return null;
  if (picked === local?.upstream && !local.upstreamGone) return null;
  return setUpstream(repoId, name, picked);
}

export interface PickBranchOptions {
  title: string;
  description?: string;
  confirmLabel: string;
  /** Also offer remote branches. */
  remotes?: boolean;
  /** Leave out the checked-out branch. */
  excludeCurrent?: boolean;
}

/** Pick a branch from a filterable list – for commands from the command palette. Returns the ref or null. */
export async function pickBranch(repoId: Id, options: PickBranchOptions): Promise<Ref | null> {
  const refs = cachedRefs(repoId) ?? (await loadRefs(repoId).catch(() => undefined));
  if (!refs) return null;
  const all = [...refs.locals, ...(options.remotes ? refs.remotes : [])].filter((ref) => !(options.excludeCurrent && ref.isHead));
  const picked = await pickFromList({
    title: options.title,
    description: options.description,
    label: t("actions.branches.pick.label"),
    items: all.map((ref) => ({
      key: ref.fullName,
      label: ref.name,
      description: ref.isHead
        ? t("actions.branches.pick.checkedOut")
        : ref.kind === "remote"
          ? t("actions.branches.pick.remote")
          : ref.upstream
            ? t("actions.branches.pick.follows", { upstream: ref.upstream })
            : undefined,
    })),
    empty: t("actions.branches.pick.empty"),
    confirmLabel: options.confirmLabel,
    mono: true,
  });
  return picked ? (all.find((ref) => ref.fullName === picked) ?? null) : null;
}
