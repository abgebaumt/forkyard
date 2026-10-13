import { t } from "../../i18n";
import { core, type Id, type ResetMode, type Sha } from "../../core";
import { toast } from "../../ui/Feedback";
import { formatShortcut } from "../../ui/Kbd";
import { askMessage } from "../actionDialogs";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { withFreshStatus, withStatus } from "../statusCache";
import { useAppStore } from "../store";
import { commitsBetween, consecutiveOnHead, findRow, loadGraphIndex, oldestFirst } from "./ancestry";
import { clip, currentBranch, headSha, loadStatus, short } from "./context";
import { copyText } from "./clipboard";
import { busyKeys } from "./keys";
import { reportOpResult, showWip } from "./merge";

/** A commit never changes: from the cache, otherwise directly from the core (and then into the cache). */
async function loadCommit(repoId: Id, sha: Sha) {
  const key = qk.commitDetails(repoId, { kind: "commit", sha });
  const cached = queryClient.getQueryData<Awaited<ReturnType<typeof core.commitDetails>>>(key);
  if (cached) return cached;
  const value = await core.commitDetails({ repoId, source: { kind: "commit", sha } });
  queryClient.setQueryData(key, value);
  return value;
}

/** Reverts a commit with a new commit. Conflict → WIP view. */
export async function revertCommit(repoId: Id, sha: Sha, tabId?: Id | null) {
  const result = await runAction(t("actions.history.revert.label"), withFreshStatus(repoId, () => core.revertCommit({ repoId, sha })), { busyKey: busyKeys.history(repoId) });
  if (result.ok) {
    if (result.value.status === "up_to_date") {
      toast({ tone: "info", title: t("actions.history.revert.nothing"), description: t("actions.history.revert.nothingDescription", { sha: short(sha) }) });
    } else {
      reportOpResult(t("actions.history.revert.label"), result.value, tabId, { reveal: true });
    }
  }
  return result;
}

export const resetModeLabels: Record<ResetMode, { label: string; description: string }> = {
  soft: { label: t("actions.history.reset.mode.soft"), description: t("actions.history.reset.mode.softDescription") },
  mixed: { label: t("actions.history.reset.mode.mixed"), description: t("actions.history.reset.mode.mixedDescription") },
  hard: { label: t("actions.history.reset.mode.hard"), description: t("actions.history.reset.mode.hardDescription") },
};

/** Half-sentence per mode for menus. */
export const resetModeHints: Record<ResetMode, string> = {
  soft: t("actions.history.reset.hint.soft"),
  mixed: t("actions.history.reset.hint.mixed"),
  hard: t("actions.history.reset.hint.hard"),
};

/**
 * Resets the checked-out branch to `sha`. Hard asks first and says how many commits and
 * which uncommitted changes will be lost – and that undo brings both back.
 */
export async function resetBranch(repoId: Id, sha: Sha, mode: ResetMode, tabId?: Id | null) {
  const branch = currentBranch(repoId);
  const subject = branch ? t("actions.history.reset.subjectBranch", { name: clip(branch, 40) }) : "HEAD";
  const head = headSha(repoId);
  const index = await loadGraphIndex(repoId);
  const range = index && head ? commitsBetween(index, sha, head) : null;
  const dropped = range && !range.partial ? range.rows.length : null;

  if (mode === "hard") {
    const status = await loadStatus(repoId).catch(() => undefined);
    const tracked = status ? [...status.conflicted, ...status.staged, ...status.unstaged.filter((file) => file.status !== "untracked")] : [];
    const files = [...new Set(tracked.map((file) => file.path))];
    const untracked = status?.unstaged.some((file) => file.status === "untracked") ?? false;
    const commits =
      dropped === null
        ? t("actions.history.reset.commitsUnknown")
        : dropped === 0
          ? t("actions.history.reset.commitsNone")
          : t("actions.history.reset.commits", {
              count: dropped,
              list: range
                ? ` (${range.rows
                    .slice(0, 3)
                    .map((row) => t("actions.history.quoted", { text: clip(row.summary, 36) }))
                    .join(", ")}${dropped > 3 ? " …" : ""})`
                : "",
            });
    const changes = !status
      ? t("actions.history.reset.changesUnknown")
      : files.length
        ? t("actions.history.reset.changes", { count: files.length })
        : t("actions.history.reset.changesNone");
    const ok = await confirm({
      title: t("actions.history.reset.hardTitle", { subject, sha: short(sha) }),
      body: [commits, changes, untracked ? t("actions.history.reset.untracked") : null, t("actions.history.reset.undo", { shortcut: formatShortcut("Mod+Z") })]
        .filter(Boolean)
        .join(" "),
      details: files,
      detailsLabel: files.length ? t("actions.history.reset.detailsLabel") : undefined,
      confirmLabel: t("actions.history.reset.hardAction"),
      danger: true,
    });
    if (!ok) return null;
  }

  const result = await runAction(t("actions.history.reset.label", { mode: resetModeLabels[mode].label }), withStatus(repoId, () => core.resetBranch({ repoId, sha, mode })), {
    busyKey: busyKeys.history(repoId),
  });
  if (!result.ok) return result;
  const kept = dropped ? t("actions.history.reset.keptCount", { count: dropped }) : t("actions.history.reset.kept");
  toast({
    tone: "success",
    title: t("actions.history.reset.done", { subject, sha: short(sha) }),
    description:
      mode === "soft"
        ? t("actions.history.reset.doneSoft", { kept })
        : mode === "mixed"
          ? t("actions.history.reset.doneMixed", { kept })
          : t("actions.history.reset.doneHard", { shortcut: formatShortcut("Mod+Z") }),
  });
  if (mode === "hard") {
    if (tabId) useAppStore.getState().revealCommit(tabId, sha);
  } else if (result.value.staged.length + result.value.unstaged.length > 0) {
    showWip(tabId);
  }
  return result;
}

/** Applies commits onto the checked-out branch, in history order (oldest first). Conflict → WIP view. */
export async function cherryPick(repoId: Id, shas: Sha[], tabId?: Id | null) {
  if (!shas.length) return null;
  const ordered = oldestFirst(await loadGraphIndex(repoId), shas);
  const label = ordered.length === 1 ? t("actions.history.cherryPick.label") : t("actions.history.cherryPick.labelMany", { count: ordered.length });
  const result = await runAction(label, withFreshStatus(repoId, () => core.cherryPick({ repoId, shas: ordered })), {
    busyKey: busyKeys.history(repoId),
  });
  if (result.ok) {
    if (result.value.status === "up_to_date") {
      toast({ tone: "info", title: t("actions.history.cherryPick.nothing"), description: t("actions.history.cherryPick.nothingDescription") });
    } else {
      reportOpResult(label, result.value, tabId, { reveal: true });
    }
  }
  return result;
}

/** Beyond this many commits the squash dialog does not ask for their descriptions individually. */
const SQUASH_DETAIL_LIMIT = 30;

/**
 * Squashes consecutive commits of the checked-out branch into one. Asks for
 * the message of the result (prefilled from the messages of those involved).
 */
export async function squashCommits(repoId: Id, shas: Sha[], tabId?: Id | null) {
  if (shas.length < 2) return null;
  const index = await loadGraphIndex(repoId);
  const check = index ? consecutiveOnHead(index, headSha(repoId), shas) : ({ ok: null } as const);
  if (check.ok === false) {
    toast({ tone: "warning", title: t("actions.history.squash.impossible"), description: t("actions.history.squash.impossibleDescription", { reason: check.reason }) });
    return null;
  }
  const ordered = check.ok ? check.shas : oldestFirst(index, shas);

  let summary = "";
  let body = "";
  if (ordered.length <= SQUASH_DETAIL_LIMIT) {
    const details = await Promise.all(ordered.map((sha) => loadCommit(repoId, sha).catch(() => null)));
    const commits = details.map((item) => item?.commit ?? null).filter((commit) => commit !== null);
    summary = commits[0]?.summary ?? "";
    body = commits
      .map((commit, position) => (position === 0 ? commit.description : [commit.summary, commit.description].filter(Boolean).join("\n\n")).trim())
      .filter(Boolean)
      .join("\n\n");
  } else if (index) {
    const rows = ordered.map((sha) => findRow(index, sha)).filter((row) => row !== undefined);
    summary = rows[0]?.summary ?? "";
    body = rows.slice(1).map((row) => `- ${row.summary}`).join("\n");
  }

  const message = await askMessage({
    title: t("actions.history.squash.title", { count: ordered.length }),
    description: t("actions.history.squash.description"),
    summary,
    body,
    confirmLabel: t("actions.history.squash.action"),
  });
  if (!message) return null;
  const text = message.description ? `${message.summary}\n\n${message.description}` : message.summary;
  const result = await runAction(t("actions.history.squash.label"), withFreshStatus(repoId, () => core.squashCommits({ repoId, shas: ordered, message: text })), {
    busyKey: busyKeys.history(repoId),
  });
  if (result.ok) reportOpResult(t("actions.history.squash.label"), result.value, tabId, { reveal: true });
  return result;
}

/** Changes the message of the last commit (without touching the index). Warns if it is already pushed. */
export async function rewordHead(repoId: Id, sha: Sha, tabId?: Id | null) {
  const details = await loadCommit(repoId, sha).catch(() => null);
  const commit = details?.commit;
  if (!commit) {
    toast({ tone: "danger", title: t("actions.history.reword.failed"), description: t("actions.history.commitNotLoaded", { sha: short(sha) }) });
    return null;
  }
  // The co-author lines are in the description and stay as long as they are not touched.
  const message = await askMessage({
    title: t("actions.history.reword.title"),
    summary: commit.summary,
    body: commit.description,
    confirmLabel: t("actions.history.reword.action"),
    warning: commit.isPushed
      ? {
          title: t("actions.history.reword.pushedTitle"),
          text: t("actions.history.reword.pushedText"),
        }
      : undefined,
  });
  if (!message) return null;
  if (message.summary === commit.summary && message.description === commit.description.replace(/\s+$/, "")) return null;
  const result = await runAction(t("actions.history.reword.action"), withFreshStatus(repoId, () => core.commitReword({ repoId, summary: message.summary, description: message.description, sha: commit.sha })), {
    busyKey: busyKeys.history(repoId),
    success: t("actions.history.reword.done"),
  });
  if (result.ok && tabId) useAppStore.getState().revealCommit(tabId, result.value.sha);
  return result;
}

/**
 * Restores files from a commit; they end up staged. If they are modified locally, it asks
 * first – the local changes would be overwritten.
 */
export async function restoreFile(repoId: Id, sha: Sha, paths: string[]) {
  if (!paths.length) return null;
  const status = await loadStatus(repoId).catch(() => undefined);
  const changed = new Set([...(status?.unstaged ?? []), ...(status?.staged ?? []), ...(status?.conflicted ?? [])].map((file) => file.path));
  const overwritten = paths.filter((path) => changed.has(path));
  const single = paths.length === 1;
  if (overwritten.length) {
    const ok = await confirm({
      title: single
        ? t("actions.history.restore.titleOne", { path: clip(paths[0]!, 44), sha: short(sha) })
        : t("actions.history.restore.titleMany", { count: paths.length, sha: short(sha) }),
      body:
        overwritten.length === 1 && single ? t("actions.history.restore.bodyOne") : t("actions.history.restore.bodyMany", { count: overwritten.length }),
      details: single ? undefined : overwritten,
      detailsLabel: t("actions.history.restore.detailsLabel"),
      confirmLabel: t("actions.history.restore.action"),
      danger: true,
    });
    if (!ok) return null;
  }
  const result = await runAction(t("actions.history.restore.label"), withStatus(repoId, () => core.fileRestore({ repoId, sha, paths })), {
    success: single
      ? t("actions.history.restore.doneOne", { path: clip(paths[0]!, 44), sha: short(sha) })
      : t("actions.history.restore.doneMany", { count: paths.length, sha: short(sha) }),
  });
  return result;
}

/** Compare two commits: select both, the Commit Panel shows the difference. */
export function compareCommits(tabId: Id, a: Sha, b: Sha): void {
  const store = useAppStore.getState();
  store.selectCommits(tabId, [a, b]);
  store.setRightCollapsed(tabId, false);
  store.closeCenter(tabId);
}

/** Copies the full message of a commit (summary and description). */
export async function copyCommitMessage(repoId: Id, sha: Sha) {
  const details = await loadCommit(repoId, sha).catch(() => null);
  const commit = details?.commit;
  if (!commit) {
    toast({ tone: "danger", title: t("actions.clipboard.failed"), description: t("actions.history.commitNotLoaded", { sha: short(sha) }) });
    return false;
  }
  return copyText(commit.description ? `${commit.summary}

${commit.description}` : commit.summary, t("actions.history.messageWhat"));
}
