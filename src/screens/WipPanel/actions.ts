/**
 * Actions of the "Local changes" panel: stage, unstage, discard, take a whole side of conflicts,
 * commit. They read status and draft from the query cache so that buttons, shortcuts and the
 * commands in src/app/commands/wip.ts do exactly the same.
 */
import { core, type CommitDraft, type FileChange, type Id, type Operation, type Remote, type Settings, type Status } from "../../core";
import { discardPaths, followVanishedDiff, stagePaths, unstagePaths } from "../../app/actions/files";
import { busyKeys } from "../../app/actions/keys";
import { continueOperation, operationNames } from "../../app/actions/merge";
import { push } from "../../app/actions/sync";
import { showOutput } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { shortSha } from "../../app/format";
import { qk, queryClient } from "../../app/queries";
import { newOpId, runAction } from "../../app/run";
import { withFreshStatus, withStatus } from "../../app/statusCache";
import { getTabView, useAppStore } from "../../app/store";
import { toast } from "../../ui/Feedback";
import { t } from "../../i18n";
import { clearDraft, flushDraft, forgetDraft, getDraft, isUntouchedTemplate, joinMessage, splitMessage, updateDraft } from "./draft";
import { getWipTab, nextErrorNonce, useWipStore, type WipArea } from "./state";

export const wipBusy = {
  commit: (repoId: Id) => busyKeys.write(repoId, "commit"),
  stageAll: (repoId: Id) => busyKeys.write(repoId, "stageAll"),
  unstageAll: (repoId: Id) => busyKeys.write(repoId, "unstageAll"),
  resolve: (repoId: Id) => busyKeys.write(repoId, "resolve"),
};

const getStatus = (repoId: Id) => queryClient.getQueryData<Status>(qk.status(repoId));

/** The state changed underneath us: reload so the view is right again. */
function reloadIfStale(repoId: Id, code: string | undefined) {
  if (code === "stale_state" || code === "not_found") void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
}

// ---------------------------------------------------------------------------
// Stage, unstage, discard
// ---------------------------------------------------------------------------

/** After moving files the mark moves on to the next remaining file in the list. */
function advanceSelection(tabId: Id, area: WipArea, before: FileChange[], moved: string[]) {
  const gone = new Set(moved);
  const first = before.findIndex((file) => gone.has(file.path));
  const rest = before.filter((file) => !gone.has(file.path));
  const next = rest[Math.min(Math.max(first, 0), rest.length - 1)];
  useWipStore.getState().setSelected(tabId, area, next ? [next.path] : []);

  // If the centre is showing one of the moved files, it follows to the next one – or returns to the graph.
  const app = useAppStore.getState();
  const center = getTabView(tabId).center;
  if (center.kind === "diff" && center.source.kind === area && gone.has(center.path)) {
    if (next) app.openDiff(tabId, next.path, center.source);
    else app.closeCenter(tabId);
  } else if (center.kind === "conflict" && area === "conflicts" && gone.has(center.path)) {
    if (next) app.openConflict(tabId, next.path);
    else app.closeCenter(tabId);
  }
}

export async function stageFiles(repoId: Id, tabId: Id, paths: string[]) {
  if (paths.length === 0) return;
  const before = getStatus(repoId)?.unstaged ?? [];
  const result = await stagePaths(repoId, paths);
  if (result.ok) advanceSelection(tabId, "unstaged", before, paths);
  else reloadIfStale(repoId, result.error.code);
}

export async function unstageFiles(repoId: Id, tabId: Id, paths: string[]) {
  if (paths.length === 0) return;
  const before = getStatus(repoId)?.staged ?? [];
  const result = await unstagePaths(repoId, paths);
  if (result.ok) advanceSelection(tabId, "staged", before, paths);
  else reloadIfStale(repoId, result.error.code);
}

async function withBusy<T>(key: string, run: () => Promise<T>): Promise<T | null> {
  const store = useAppStore.getState();
  if (store.busy[key]) return null;
  store.setBusy(key, true);
  try {
    return await run();
  } finally {
    useAppStore.getState().setBusy(key, false);
  }
}

export async function stageEverything(repoId: Id, tabId: Id) {
  if (!getStatus(repoId)?.unstaged.length) return;
  const result = await withBusy(wipBusy.stageAll(repoId), () => stagePaths(repoId, null));
  if (result?.ok) {
    useWipStore.getState().setSelected(tabId, "unstaged", []);
    followVanishedDiff(repoId, result.value);
  } else if (result) reloadIfStale(repoId, result.error.code);
}

export async function unstageEverything(repoId: Id, tabId: Id) {
  if (!getStatus(repoId)?.staged.length) return;
  const result = await withBusy(wipBusy.unstageAll(repoId), () => unstagePaths(repoId, null));
  if (result?.ok) {
    useWipStore.getState().setSelected(tabId, "staged", []);
    followVanishedDiff(repoId, result.value);
  } else if (result) reloadIfStale(repoId, result.error.code);
}

/** Discards the changes to single files (with a prompt; undo brings them back). */
export async function discardFiles(repoId: Id, tabId: Id, paths: string[]) {
  if (paths.length === 0) return;
  const before = getStatus(repoId)?.unstaged ?? [];
  const result = await discardPaths(repoId, paths, { follow: false });
  if (result?.ok) {
    // First move on to the next file (mark and open diff), then clean up what would otherwise remain.
    advanceSelection(tabId, "unstaged", before, paths);
    followVanishedDiff(repoId, result.value);
    void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  } else if (result) reloadIfStale(repoId, result.error.code);
}

/** Trash can in the header: discard everything, including staged and untracked files. */
export async function discardEverything(repoId: Id, tabId: Id) {
  const result = await discardPaths(repoId, null);
  if (result?.ok) {
    useWipStore.getState().clearSelection(tabId);
    void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  } else if (result) reloadIfStale(repoId, result.error.code);
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface SideNames {
  ours: string;
  theirs: string;
}

/** What the two sides of a conflict are called – with the names from the running operation. */
export function conflictSides(operation: Operation | null, status: Status | undefined): SideNames {
  const head = status?.head;
  const current = head?.kind === "branch" || head?.kind === "unborn" ? head.branch : null;
  if (!operation) return { ours: current ?? t("wip.sides.workingState"), theirs: t("wip.sides.incomingChange") };
  const ours = operation.target ?? current ?? t("wip.sides.currentState");
  switch (operation.kind) {
    case "merge":
    case "rebase":
      return { ours, theirs: operation.source ?? t("wip.sides.incomingState") };
    case "cherry_pick":
      return { ours, theirs: operation.source ? t("wip.sides.commit", { source: operation.source }) : t("wip.sides.pickedCommit") };
    case "revert":
      return { ours, theirs: operation.source ? t("wip.sides.stateBefore", { source: operation.source }) : t("wip.sides.stateBeforeCommit") };
  }
}

/** Takes one whole side for the files; afterwards they are staged. */
export async function resolveConflicts(repoId: Id, tabId: Id, paths: string[], side: "ours" | "theirs", sides: SideNames) {
  if (paths.length === 0) return;
  const before = getStatus(repoId)?.conflicted ?? [];
  const name = side === "ours" ? sides.ours : sides.theirs;
  const result = await runAction(
    side === "ours" ? t("wip.resolve.takeCurrent") : t("wip.resolve.takeIncoming"),
    async () => {
      let status: Status | null = null;
      // Each answer individually and in order into the cache (statusCache.ts): a late one overwrites nothing newer.
      for (const path of paths) status = await withStatus(repoId, () => core.conflictResolve({ repoId, path, content: null, side }))();
      return status;
    },
    {
      busyKey: wipBusy.resolve(repoId),
      success: paths.length === 1 ? t("wip.resolve.doneOne", { path: paths[0], name }) : t("wip.resolve.doneMany", { count: paths.length, name }),
    },
  );
  if (result.ok && result.value) {
    advanceSelection(tabId, "conflicts", before, paths);
  } else {
    // Failed in the middle of the list: show what is already resolved.
    void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
  }
}

// ---------------------------------------------------------------------------
// Committen
// ---------------------------------------------------------------------------

export type CommitMode = "commit" | "amend" | "merge" | "continue";

export interface CommitPlan {
  mode: CommitMode;
  /** Label of the primary button. */
  label: string;
  /** Why it is not possible right now (for tooltip and screen readers); null = possible. */
  blocked: string | null;
  stageAll: boolean;
}

/** What the primary button would do right now – one place for label, lock and execution. */
export function planCommit(status: Status | undefined, draft: CommitDraft, stageAll: boolean): CommitPlan {
  if (!status) return { mode: "commit", label: t("wip.plan.commit"), blocked: t("wip.plan.loading"), stageAll };
  const operation = status.operation;
  const conflicts = status.conflicted.length;
  const staged = status.staged.length;
  const unstaged = status.unstaged.length;
  const conflictReason =
    conflicts > 0 ? t("wip.plan.conflicts", { count: conflicts }) : null;

  if (operation) {
    const name = operationNames[operation.kind];
    if (operation.kind === "merge") return { mode: "merge", label: t("wip.plan.finishMerge"), blocked: conflictReason, stageAll: false };
    return { mode: "continue", label: t("wip.plan.continue", { name }), blocked: conflictReason, stageAll: false };
  }
  const identity = status.identitySet ? null : t("wip.plan.noIdentity");
  if (draft.amend) {
    const all = stageAll && unstaged > 0;
    return { mode: "amend", label: all ? t("wip.plan.stageAllAmend") : t("wip.plan.amend"), blocked: conflictReason ?? identity, stageAll: all };
  }
  if (stageAll && unstaged > 0) return { mode: "commit", label: t("wip.plan.stageAllCommit"), blocked: conflictReason ?? identity, stageAll: true };
  if (staged === 0) {
    const reason =
      unstaged > 0
        ? t("wip.plan.nothingStaged")
        : t("wip.plan.noChanges");
    return { mode: "commit", label: t("wip.plan.commit"), blocked: conflictReason ?? reason, stageAll: false };
  }
  return { mode: "commit", label: t("wip.plan.commitFiles", { count: staged }), blocked: conflictReason ?? identity, stageAll: false };
}

function failSummary(tabId: Id, text: string) {
  useWipStore.getState().patch(tabId, { summaryError: { text, nonce: nextErrorNonce() } });
}

/**
 * Commits with message and options from the form (Ctrl+Enter), with `stageAll` after staging all
 * changes (Ctrl+Shift+Enter). If a merge is running, this concludes it; for rebase, cherry-pick
 * and revert it continues.
 */
/** Whether "Push after commit" is possible right now, and whether it is checked. */
export function pushAfterState(
  chosen: boolean | null,
  settings: Settings | undefined,
  status: Status | undefined,
  remotes: Remote[] | undefined,
): { checked: boolean; blocked: string | null } {
  let blocked: string | null = null;
  if (status?.head.kind === "detached") blocked = t("wip.pushAfter.detached");
  else if (remotes && remotes.length === 0) blocked = t("wip.pushAfter.noRemote");
  else if (status?.operation) blocked = t("wip.pushAfter.operation");
  return { checked: blocked === null && (chosen ?? settings?.pushAfterCommit ?? false), blocked };
}

export async function commitChanges(repoId: Id, tabId: Id, options: { stageAll?: boolean } = {}) {
  const status = getStatus(repoId);
  const draft = getDraft(repoId);
  const plan = planCommit(status, draft, options.stageAll ?? false);
  const wip = getWipTab(tabId);
  if (plan.blocked) {
    toast({ tone: "info", title: t("wip.commit.blocked", { label: plan.label }), description: plan.blocked });
    return;
  }
  if (plan.mode === "continue") {
    await continueOperation(repoId, null, tabId);
    return;
  }

  const fallback = plan.mode === "merge" ? splitMessage(status?.operation?.message ?? "") : null;
  const summary = draft.summary.trim() || fallback?.summary || "";
  const description = draft.summary.trim() ? draft.description : draft.description || fallback?.description || "";
  if (!summary) {
    failSummary(tabId, t("wip.commit.summaryMissing"));
    return;
  }
  // Like Git in the terminal: with the unchanged template as the message, nothing is committed.
  if (plan.mode !== "merge" && isUntouchedTemplate(repoId, { summary, description })) {
    failSummary(tabId, t("wip.commit.untouchedTemplate"));
    return;
  }
  useWipStore.getState().patch(tabId, { summaryError: null });
  flushDraft(repoId);

  if (plan.mode === "merge") {
    const result = await continueOperation(repoId, joinMessage({ summary, description }), tabId, wip.skipHooks);
    if (result.ok && result.value.status !== "conflict") clearDraft(repoId);
    return;
  }

  const amend = plan.mode === "amend";
  const opId = newOpId();
  const pushAfter = pushAfterState(wip.pushAfter, queryClient.getQueryData<Settings>(qk.settings), status, queryClient.getQueryData<Remote[]>(qk.remotes(repoId))).checked;
  const label = amend ? t("wip.plan.amend") : t("wip.commit.action");
  // The shell reports every failed hook itself (event hook:output, with "Show output").
  // If the event arrives, our own toast is dropped – otherwise the same error would appear twice.
  let hookReported = false;
  const stopListening = core.on("hook:output", (payload) => {
    if (payload.repoId === repoId && payload.exitCode !== 0) hookReported = true;
  });
  const result = await runAction(
    label,
    // The status is reloaded before the "Commit …" toast appears (statusCache.ts).
    // With amend, the commit the form showed as the last one goes along: if HEAD is a different one
    // by now (commit in the terminal at the same moment), the core refuses.
    withFreshStatus(repoId, () =>
      core.commitCreate({ repoId, opId, summary, description, amend, skipHooks: wip.skipHooks, pushAfter, stageAll: plan.stageAll, expectedHead: amend ? wip.amendSha : null }),
    ),
    {
      busyKey: wipBusy.commit(repoId),
      quiet: ["empty_message", "hook_failed", "identity_missing"],
      job: pushAfter ? { id: opId, title: t("wip.commit.jobTitle"), repoId } : undefined,
    },
  );

  if (!result.ok) {
    const { error } = result;
    if (error.code === "empty_message") failSummary(tabId, t("wip.commit.summaryMissing"));
    else if (error.code === "hook_failed") {
      // Event and answer travel separate ways: give the event a moment.
      if (!hookReported) await new Promise((resolve) => window.setTimeout(resolve, 250));
      const output = error.gitOutput?.trim();
      if (!hookReported) {
        toast({
          tone: "danger",
          title: t("wip.commit.hookRejected"),
          description: `${describeError(error).text}\n${t("wip.commit.hookUnchanged")}`,
          action: output ? { label: t("wip.commit.showOutput"), onClick: () => void showOutput(t("wip.commit.hookOutput"), output) } : undefined,
        });
      }
    } else if (error.code === "identity_missing") {
      toast({
        tone: "danger",
        title: t("wip.identity.title"),
        description: t("wip.identity.text"),
        action: { label: t("wip.identity.openProfile"), onClick: () => useAppStore.getState().openOverlay({ kind: "preferences", section: "profiles" }) },
      });
    }
    stopListening();
    // The core also reports repo:changed for rejected commits; this is only for the case that the state has changed.
    if (error.code !== "empty_message") void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
    return;
  }
  stopListening();

  // Success: the draft is cleared in the core, the selection stays on the local changes.
  forgetDraft(repoId);
  useWipStore.getState().patch(tabId, { amendFilled: null, amendSha: null, summaryError: null });
  useWipStore.getState().clearSelection(tabId);
  // An open diff of a file just committed gives way to the graph with the new commit.
  followVanishedDiff(repoId);
  void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });

  const { sha, push: pushed } = result.value;
  const what = `${shortSha(sha)} · ${summary}`;
  const done = amend ? t("wip.commit.amended") : t("wip.commit.created");
  if (pushed?.status === "rejected") {
    toast({
      tone: "warning",
      title: t("wip.commit.notPushed", { done }),
      description: `${what}\n${pushed.reason || t("wip.commit.pushRejected")}`,
      action: { label: t("wip.commit.retryPush"), onClick: () => void push(repoId, { tabId }) },
    });
  } else if (pushed?.status === "done") {
    toast({ tone: "success", title: t("wip.commit.pushed", { done, remote: pushed.remote, branch: pushed.branch }), description: what });
  } else {
    toast({ tone: "success", title: done, description: what });
  }
}

// ---------------------------------------------------------------------------
// Amend
// ---------------------------------------------------------------------------

/**
 * The last commit is a different one than when "Amend" was checked (commit in the terminal, pull,
 * undo): the check box meant the old one. If its untouched message is still in the form, it
 * follows the new last commit; if the user has already typed, the box is unchecked – their text
 * stays and does not land unasked on a commit they never saw.
 */
export async function amendHeadMoved(repoId: Id, tabId: Id, template: { summary: string; description: string } | null) {
  const draft = getDraft(repoId);
  const wip = getWipTab(tabId);
  const head = getStatus(repoId)?.head;
  // Unchecked in the meantime, committed or already followed: nothing to do.
  if (!draft.amend || !head || head.kind === "unborn" || wip.amendSha === null || wip.amendSha === head.sha) return;
  const filled = wip.amendFilled;
  const untouched = filled !== null && draft.summary === filled.summary && draft.description === filled.description;
  const empty = !draft.summary.trim() && !draft.description.trim();
  if (untouched || empty) {
    updateDraft(repoId, { summary: "", description: "" });
    useWipStore.getState().patch(tabId, { amendFilled: null });
    await setAmend(repoId, tabId, true, template);
    return;
  }
  updateDraft(repoId, { amend: false });
  useWipStore.getState().patch(tabId, { amendFilled: null, amendSha: null });
  toast({
    tone: "info",
    title: t("wip.amendMoved.title"),
    description: t("wip.amendMoved.text"),
  });
}

/** Toggles "Amend last commit". If the fields are empty, the last commit's message goes in. */
export async function setAmend(repoId: Id, tabId: Id, amend: boolean, template: { summary: string; description: string } | null) {
  const draft = getDraft(repoId);
  const wip = getWipTab(tabId);
  const isTemplate = template !== null && draft.summary === template.summary && draft.description === template.description;
  if (!amend) {
    const filled = wip.amendFilled;
    const untouched = filled !== null && draft.summary === filled.summary && draft.description === filled.description;
    updateDraft(repoId, untouched ? { amend: false, summary: template?.summary ?? "", description: template?.description ?? "" } : { amend: false });
    useWipStore.getState().patch(tabId, { amendFilled: null, amendSha: null });
    return;
  }
  updateDraft(repoId, { amend: true });
  const head = getStatus(repoId)?.head;
  // The commit that is now the last one: the check box refers only to it.
  useWipStore.getState().patch(tabId, { amendSha: head && head.kind !== "unborn" ? head.sha : null });
  if (draft.summary.trim() || draft.description.trim()) {
    if (!isTemplate) return;
  }
  if (!head || head.kind === "unborn") return;
  try {
    const details = await queryClient.fetchQuery({
      queryKey: qk.commitDetails(repoId, { kind: "commit", sha: head.sha }),
      queryFn: () => core.commitDetails({ repoId, source: { kind: "commit", sha: head.sha } }),
      staleTime: Infinity,
    });
    const commit = details.commit;
    const current = getDraft(repoId);
    // Unchecked in the meantime or something already typed: overwrite nothing.
    if (!commit || !current.amend || current.summary !== draft.summary || current.description !== draft.description) return;
    updateDraft(repoId, { summary: commit.summary, description: commit.description });
    useWipStore.getState().patch(tabId, { amendFilled: { summary: commit.summary, description: commit.description }, summaryError: null });
  } catch {
    // Amending still works without the old message; the fields stay as they are.
  }
}
