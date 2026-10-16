import { locale, t } from "../../i18n";
import { core, type Id, type PullMode, type PushResult, type Ref, type Remote, type Settings } from "../../core";
import { toast } from "../../ui/Feedback";
import { askPushTarget } from "../actionDialogs";
import { choose, confirm, showOutput } from "../dialogs";
import { desktopNotify, markManualSync } from "../notify";
import { qk, queryClient } from "../queries";
import { newJobId, runAction, showError, type ActionResult } from "../run";
import { withFreshStatus } from "../statusCache";
import { guardSecrets } from "./pushCheck";
import { useAppStore } from "../store";
import { commitsBetween, loadGraphIndex } from "./ancestry";
import { chooseUpstream } from "./branches";
import { cachedRefs, cachedRemotes, cachedSettings, cachedStatus, clip, currentBranch, findLocalBranch, loadRefs, loadRemotes, loadStatus, short } from "./context";
import { busyKeys } from "./keys";
import { blockingFiles, reportOpResult } from "./merge";
import { popStash, stashChanges } from "./stash";
import { openPushDialog } from "../../screens/PushDialog";
import { allThrough, resultLines } from "../../screens/PushDialog/model";

export const pullModeLabels: Record<PullMode, string> = {
  ff: t("actions.sync.pullMode.ff"),
  ff_only: t("actions.sync.pullMode.ffOnly"),
  rebase: t("actions.sync.pullMode.rebase"),
};

export const pullModeHints: Record<PullMode, string> = {
  ff: t("actions.sync.pullMode.ffHint"),
  ff_only: t("actions.sync.pullMode.ffOnlyHint"),
  rebase: t("actions.sync.pullMode.rebaseHint"),
};

/** Pull mode that applies without an explicit choice: repo setting, otherwise global. */
export function effectivePullMode(repoId: Id): PullMode {
  const repoSettings = queryClient.getQueryData<{ defaultPullMode: PullMode | null }>(qk.repoSettings(repoId));
  const settings = queryClient.getQueryData<Settings>(qk.settings);
  return repoSettings?.defaultPullMode ?? settings?.defaultPullMode ?? "ff";
}

/** Opens the "Add remote" dialog. */
export function addRemote(): void {
  useAppStore.getState().openOverlay({ kind: "add_remote" });
}

/** Without a remote no network action works: say what is missing and offer the way there. */
function offerAddRemote(label: string): void {
  toast({
    tone: "warning",
    sticky: true,
    title: t("actions.sync.noRemote.title", { label }),
    description: t("actions.sync.noRemote.description"),
    action: { label: t("actions.sync.noRemote.action"), onClick: addRemote },
  });
}

/** After every network action: remembered credentials only now appear in the list, and there is no event for that. */
function afterNetwork(repoId: Id): void {
  markManualSync(repoId);
  void queryClient.invalidateQueries({ queryKey: qk.credentials });
}

const refsLabel = (count: number) => t("actions.sync.fetch.refs", { count });

/** Fetch from all remotes or from one. Reports what arrived; without a remote it offers "Add remote". */
export async function fetchAll(repoId: Id, remote: string | null = null) {
  if (cachedRemotes(repoId)?.length === 0) {
    offerAddRemote(t("actions.sync.fetch.label"));
    return null;
  }
  const settings = cachedSettings();
  const jobId = newJobId();
  const label = remote ? t("actions.sync.fetch.labelFrom", { remote }) : t("actions.sync.fetch.label");
  markManualSync(repoId);
  const result = await runAction(label, withFreshStatus(repoId, () => core.fetch({ repoId, jobId, remote, prune: settings?.autoPrune ?? false })), {
    busyKey: busyKeys.fetch(repoId),
    quiet: ["no_remote"],
    job: { id: jobId, title: label, repoId },
  });
  afterNetwork(repoId);
  if (!result.ok) {
    if (result.error.code === "no_remote") offerAddRemote(t("actions.sync.fetch.label"));
    return result;
  }
  const { updatedRefs, prunedRefs, failed } = result.value;
  if (failed.length === 0) useAppStore.getState().markFetched(repoId);
  if (failed.length) {
    // The reason is shown per remote (unreachable, authentication rejected …); and whatever did arrive, too.
    const title = failed.length === 1 ? t("actions.sync.fetch.failedOne", { remote: failed[0]!.remote }) : t("actions.sync.fetch.failedMany", { count: failed.length });
    const lines = failed.map((item) => `${item.remote}: ${item.message}`);
    const others = Math.max(0, (cachedRemotes(repoId)?.length ?? failed.length) - failed.length);
    if (others > 0) {
      lines.push(updatedRefs ? t("actions.sync.fetch.othersRefs", { count: others, refs: refsLabel(updatedRefs) }) : t("actions.sync.fetch.others", { count: others }));
    }
    const description = lines.join("\n");
    // If nothing arrived, it is an error and stays; if part arrived, a notice is enough.
    toast({ tone: others > 0 ? "warning" : "danger", title, description });
    desktopNotify(settings?.notifyOnError, title, description);
  } else {
    const parts = [refsLabel(updatedRefs)];
    if (prunedRefs) parts.push(t("actions.sync.fetch.pruned", { count: prunedRefs }));
    const description = updatedRefs || prunedRefs ? parts.join(", ") : t("actions.sync.fetch.nothingNew");
    const title = t("actions.merge.result.done", { label });
    toast({ tone: "success", title, description });
    if (updatedRefs) desktopNotify(settings?.notifyOnFetch, title, description);
  }
  return result;
}

/**
 * Pull of the checked-out branch. `mode: null` takes the default from the settings.
 * Conflict → WIP view. Uncommitted changes in the way → offer "Stash first, then pull".
 */
export async function pull(repoId: Id, mode: PullMode | null = null, tabId?: Id | null) {
  const run = () => {
    const jobId = newJobId();
    markManualSync(repoId);
    return runAction(t("actions.sync.pull.label"), withFreshStatus(repoId, () => core.pull({ repoId, jobId, mode })), {
      busyKey: busyKeys.pull(repoId),
      quiet: ["dirty_worktree", "no_remote", "no_upstream"],
      job: { id: jobId, title: t("actions.sync.pull.label"), repoId },
    });
  };

  let result = await run();
  afterNetwork(repoId);

  if (!result.ok && result.error.code === "dirty_worktree") {
    const files = blockingFiles(result.error);
    const next = await choose({
      title: t("actions.sync.pull.dirty.title"),
      description: t("actions.sync.pull.dirty.description"),
      details: files,
      detailsLabel: files.length ? t("actions.branches.offerStash.affected") : undefined,
      options: [{ key: "stash", label: t("actions.sync.pull.dirty.stash"), description: t("actions.sync.pull.dirty.stashDescription") }],
    });
    if (next !== "stash") return result;
    const stashed = await stashChanges(repoId, { message: t("actions.sync.pull.stashMessage"), quiet: true });
    if (!stashed.ok) return result;
    result = await run();
    if (result.ok && result.value.status !== "conflict") {
      reportOpResult(t("actions.sync.pull.label"), result.value, tabId);
      useAppStore.getState().markFetched(repoId);
      await popStash(repoId, 0, tabId);
      return result;
    }
    // The pull is stuck in a conflict or failed: the saved changes stay in the stash.
    toast({
      tone: "info",
      title: t("actions.branches.stashHint.title"),
      description: t("actions.sync.pull.stashKept", { message: t("actions.sync.pull.stashMessage") }),
    });
  }

  if (!result.ok) {
    if (result.error.code === "no_remote") offerAddRemote(t("actions.sync.pull.label"));
    else if (result.error.code === "no_upstream") {
      const branch = currentBranch(repoId);
      toast({
        tone: "warning",
        sticky: true,
        title: t("actions.sync.pull.noUpstream.title"),
        description: branch ? t("actions.sync.pull.noUpstream.descriptionBranch", { branch }) : t("actions.sync.pull.noUpstream.description"),
        action: branch
          ? {
              label: t("actions.sync.pull.noUpstream.action"),
              onClick: () => void chooseUpstream(repoId, branch),
            }
          : undefined,
      });
    } else if (result.error.code === "dirty_worktree") showError(t("actions.sync.pull.label"), result.error);
    return result;
  }
  useAppStore.getState().markFetched(repoId);
  reportOpResult(t("actions.sync.pull.label"), result.value, tabId);
  return result;
}

/** Picks the default mode (for this repo if it has its own default, otherwise global) and pulls with it. */
export async function setDefaultPullMode(repoId: Id, mode: PullMode) {
  const repoSettings = queryClient.getQueryData<{ defaultPullMode: PullMode | null }>(qk.repoSettings(repoId));
  if (repoSettings?.defaultPullMode) {
    const result = await runAction(t("actions.sync.pullMode.save"), () => core.repoSettingsSet({ repoId, patch: { defaultPullMode: mode } }));
    if (result.ok) queryClient.setQueryData(qk.repoSettings(repoId), result.value);
    return result;
  }
  const result = await runAction(t("actions.sync.pullMode.save"), () => core.settingsSet({ patch: { defaultPullMode: mode } }));
  if (result.ok) queryClient.setQueryData(qk.settings, result.value);
  return result;
}

function reportPush(result: PushResult) {
  if (result.status === "done") {
    toast({
      tone: "success",
      title: result.forced
        ? t("actions.sync.push.doneForced", { target: `${result.remote}/${result.branch}` })
        : t("actions.sync.push.done", { target: `${result.remote}/${result.branch}` }),
      description: result.createdUpstream ? t("actions.sync.push.createdUpstream") : undefined,
    });
  } else if (result.status === "up_to_date") {
    toast({ tone: "info", title: t("actions.sync.push.nothing"), description: t("actions.sync.push.nothingDescription") });
  }
}

export interface PushOptions {
  /** Force right away (with a prompt). */
  force?: boolean;
  tabId?: Id | null;
  /** A branch other than the checked-out one. */
  branch?: string | null;
  /** Preset the target (drop menu "push X to origin/Y"); sets the upstream. */
  remote?: string | null;
  remoteBranch?: string | null;
}

function isRejected(result: ActionResult<PushResult>): boolean {
  return (!result.ok && result.error.code === "push_rejected") || (result.ok && result.value.status === "rejected");
}

/**
 * Asks whether the push should be forced. Fetches the remote's state first: `--force-with-lease`
 * only overwrites what this repository knows – and the prompt should name what will be lost.
 */
async function confirmForcePush(repoId: Id, branch: string | null): Promise<{ expected: string | null } | null> {
  const fetchJob = newJobId();
  markManualSync(repoId);
  const fetched = await runAction(t("actions.sync.force.fetchLabel"), () => core.fetch({ repoId, jobId: fetchJob, remote: null, prune: false }), {
    busyKey: busyKeys.fetch(repoId),
    job: { id: fetchJob, title: t("actions.sync.force.fetchJob"), repoId },
  });
  if (!fetched.ok) return null;

  // Only after the fetch is what lies on the remote accurate.
  const [status, refs] = await Promise.all([loadStatus(repoId).catch(() => undefined), loadRefs(repoId).catch(() => undefined)]);
  const local = branch ? refs?.locals.find((ref) => ref.name === branch) : refs?.locals.find((ref) => ref.isHead);
  const upstream = local?.upstream ?? status?.upstream?.name ?? null;
  const remoteRef = upstream ? refs?.remotes.find((ref) => ref.name === upstream) : undefined;
  const target = upstream ?? t("actions.sync.force.remoteBranch");

  let details: string[] = [];
  let lost = local?.behind ?? status?.upstream?.behind ?? 0;
  if (local && remoteRef && lost > 0) {
    const index = await loadGraphIndex(repoId, { fresh: true });
    const range = index ? commitsBetween(index, local.sha, remoteRef.sha) : null;
    if (range) {
      details = range.rows.map((row) => `${short(row.sha!)}  ${clip(row.summary, 80)} · ${row.authorName}`);
      if (!range.partial) lost = range.rows.length;
    }
  }
  const what =
    lost > 0
      ? t("actions.sync.force.lost", { count: lost, formatted: lost.toLocaleString(locale()), target })
      : t("actions.sync.force.nothingLost", { target });
  const ok = await confirm({
    title: upstream ? t("actions.sync.force.titleTo", { upstream: clip(upstream, 40) }) : t("actions.sync.force.title"),
    body: `${t("actions.sync.force.body")} ${what}`,
    details,
    detailsLabel: details.length ? t("actions.sync.force.detailsLabel") : undefined,
    confirmLabel: t("actions.sync.force.action"),
    danger: true,
  });
  // The state the prompt showed is passed along: if the app (auto-fetch) fetches something new
  // in the meantime, the core refuses instead of overwriting commits that were never named here.
  return ok ? { expected: remoteRef?.sha ?? null } : null;
}

/**
 * Pushes the checked-out branch (or `branch`). Without an upstream it asks "Push where?";
 * if the push is rejected, it offers "Pull first" or "Force push".
 */
export async function push(repoId: Id, options: PushOptions = {}): Promise<ActionResult<PushResult> | null> {
  const branch = options.branch ?? null;
  const run = (remote: string | null, remoteBranch: string | null, force: boolean, expected: string | null = null) =>
    guardSecrets(repoId, (acceptedSecrets) => {
      const jobId = newJobId();
      const title = force ? t("actions.sync.push.jobForced") : branch ? t("actions.pullrequests.pushJob", { branch: clip(branch, 32) }) : t("actions.sync.push.label");
      markManualSync(repoId);
      return runAction(
        force ? t("actions.sync.push.labelForced") : t("actions.sync.push.label"),
        withFreshStatus(repoId, () => core.push({ repoId, jobId, branch, remote, remoteBranch, force, expected, acceptedSecrets })),
        {
          busyKey: busyKeys.push(repoId),
          quiet: ["no_upstream", "push_rejected", "no_remote"],
          job: { id: jobId, title, repoId },
        },
      );
    });
  const finish = (result: ActionResult<PushResult>) => {
    afterNetwork(repoId);
    if (!result.ok) {
      if (result.error.code === "no_remote") offerAddRemote(t("actions.sync.push.label"));
      else if (result.error.code === "no_upstream" || result.error.code === "push_rejected") showError(t("actions.sync.push.label"), result.error);
      return result;
    }
    if (result.value.status === "rejected") {
      toast({ tone: "danger", title: t("actions.pullrequests.pushRejected"), description: result.value.reason });
      desktopNotify(cachedSettings()?.notifyOnError, t("actions.pullrequests.pushRejected"), result.value.reason);
      return result;
    }
    reportPush(result.value);
    return result;
  };

  if (options.force) {
    const confirmed = await confirmForcePush(repoId, branch);
    if (!confirmed) return null;
    return finish(await run(options.remote ?? null, options.remoteBranch ?? null, true, confirmed.expected));
  }

  let result = await run(options.remote ?? null, options.remoteBranch ?? null, false);

  if (!result.ok && result.error.code === "no_upstream") {
    const remotes = await loadRemotes(repoId).catch(() => [] as Remote[]);
    if (remotes.length === 0) {
      offerAddRemote(t("actions.sync.push.label"));
      return result;
    }
    const status = cachedStatus(repoId);
    const name = branch ?? (status?.head.kind === "branch" || status?.head.kind === "unborn" ? status.head.branch : (currentBranch(repoId) ?? ""));
    const target = await askPushTarget(name, remotes);
    if (!target) return result;
    result = await run(target.remote, target.remoteBranch, false);
  }

  if (isRejected(result)) {
    const reason = result.ok && result.value.status === "rejected" ? result.value.reason : !result.ok ? result.error.message : "";
    const isHead = !branch || findLocalBranch(repoId, branch)?.isHead === true;
    const next = await choose({
      title: t("actions.pullrequests.pushRejected"),
      description: reason || t("actions.sync.rejected.description"),
      options: [
        ...(isHead ? [{ key: "pull" as const, label: t("actions.sync.rejected.pull"), description: t("actions.sync.rejected.pullDescription") }] : []),
        {
          key: "force" as const,
          label: t("actions.sync.rejected.force"),
          description: t("actions.sync.rejected.forceDescription"),
          danger: true,
        },
      ],
    });
    if (next === "pull") {
      const pulled = await pull(repoId, null, options.tabId);
      if (pulled.ok && pulled.value.status !== "conflict") return push(repoId, { tabId: options.tabId, branch });
      return result;
    }
    if (next !== "force") return result;
    const confirmed = await confirmForcePush(repoId, branch);
    if (!confirmed) return result;
    result = await run(null, null, true, confirmed.expected);
  }

  return finish(result);
}

/**
 * Deletes a remote branch on its server (`git push <remote> --delete`) after a danger prompt that
 * names remote and branch and the local branch that tracks it (it stays). `up_to_date` from the
 * core means it was already gone there; the core then removed the stale remote branch here.
 * Errors (protected branch, auth, offline) go through the normal error display.
 */
export async function deleteRemoteBranch(repoId: Id, ref: Ref): Promise<ActionResult<PushResult> | null> {
  const remote = ref.remote;
  if (!remote) return null;
  const name = ref.name.startsWith(`${remote}/`) ? ref.name.slice(remote.length + 1) : ref.name;
  const refs = cachedRefs(repoId) ?? (await loadRefs(repoId).catch(() => undefined));
  const tracking = refs?.locals.find((local) => local.upstream === ref.name);
  const ok = await confirm({
    title: t("actions.sync.deleteRemote.title", { name: clip(name, 40), remote }),
    body: tracking ? t("actions.sync.deleteRemote.bodyTracked", { remote, local: clip(tracking.name, 40) }) : t("actions.sync.deleteRemote.body", { remote }),
    confirmLabel: t("actions.sync.deleteRemote.action", { remote: clip(remote, 24) }),
    danger: true,
  });
  if (!ok) return null;
  const jobId = newJobId();
  const target = clip(ref.name);
  const result = await runAction(t("actions.sync.deleteRemote.label"), withFreshStatus(repoId, () => core.branchDeleteRemote({ repoId, jobId, remote, name })), {
    busyKey: busyKeys.push(repoId),
    job: { id: jobId, title: t("actions.sync.deleteRemote.job", { target: clip(ref.name, 32) }), repoId },
  });
  afterNetwork(repoId);
  if (!result.ok) return result;
  if (result.value.status === "up_to_date") {
    toast({ tone: "info", title: t("actions.sync.deleteRemote.gone", { target }), description: t("actions.sync.deleteRemote.goneDescription") });
  } else {
    toast({ tone: "success", title: t("actions.sync.deleteRemote.done", { target }) });
  }
  void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
  return result;
}

/**
 * “Push …” with further branches and tags: the dialog collects them, one push sends everything
 * (“all or nothing” by default). Afterwards a toast, and with rejections a list per ref.
 */
export async function pushWithMore(repoId: Id, options: { branch?: string | null; preselected?: string[] } = {}): Promise<ActionResult<PushResult> | null> {
  const status = cachedStatus(repoId);
  const branch = options.branch ?? (status?.head.kind === "branch" ? status.head.branch : null) ?? currentBranch(repoId);
  if (!branch) {
    toast({ tone: "info", title: t("pushMany.noBranch") });
    return null;
  }
  const plan = await openPushDialog(repoId, branch, options.preselected ?? []);
  if (!plan) return null;
  const refs = await loadRefs(repoId).catch(() => undefined);
  const local = refs?.locals.find((ref) => ref.name === branch);
  const upstreamRemote = local?.upstream ? (refs?.remotes.find((ref) => ref.name === local.upstream)?.remote ?? null) : null;
  const remote = upstreamRemote === plan.remote ? null : plan.remote;
  const result = await guardSecrets(repoId, (acceptedSecrets) => {
    const jobId = newJobId();
    markManualSync(repoId);
    return runAction(
      t("actions.sync.push.label"),
      withFreshStatus(repoId, () => core.push({ repoId, jobId, branch, remote, remoteBranch: null, force: false, expected: null, extra: plan.extras, atomic: plan.atomic, acceptedSecrets })),
      { busyKey: busyKeys.push(repoId), quiet: ["no_remote"], job: { id: jobId, title: t("pushMany.job", { count: plan.extras.length + 1 }), repoId } },
    );
  });
  afterNetwork(repoId);
  if (!result.ok) {
    if (result.error.code === "no_remote") offerAddRemote(t("actions.sync.push.label"));
    return result;
  }
  if (result.value.status === "secrets_found") return result;
  const lines = resultLines(result.value);
  if (allThrough(result.value)) toast({ tone: "success", title: t("pushMany.done", { count: lines.length }) });
  else void showOutput(t("pushMany.result.title"), lines.map((line) => `${line.ref}  ${line.text}`).join("\n"));
  return result;
}
