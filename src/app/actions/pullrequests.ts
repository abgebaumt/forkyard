/**
 * Pull requests: create, comment, merge, close, reopen, check out – at the repository's host
 * (GitHub or GitLab), through the core and with the user's token.
 * Menus and commands read the state from the query cache (`cached…`).
 */
import { t } from "../../i18n";
import type { InfiniteData } from "@tanstack/react-query";
import { core, type Id, type PushResult, type Ref, type Remote, type Sha, type Status } from "../../core";
import { toast } from "../../ui/Feedback";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { newJobId, runAction, type ActionResult } from "../run";
import { useAppStore } from "../store";
import { commitsBetween, loadGraphIndex } from "./ancestry";
import { cachedRefs, clip, loadRefs, loadRemotes } from "./context";
import { hostApi, hostErrorKind, hostPrWord, type HostAccountInfo, type HostRepo, type MergeMethod, type PrCreateInput, type PrDetails, type PrPage, type PrSummary } from "./hostTypes";
import { cachedHostAccounts, runHostAction } from "./hosts";
import { busyKeys } from "./keys";
import { fetchAll } from "./sync";
import { guardSecrets } from "./pushCheck";

// ---------------------------------------------------------------------------
// From the cache
// ---------------------------------------------------------------------------

export const cachedHostRepo = (repoId: Id) => queryClient.getQueryData<HostRepo | null>(qk.hostRepo(repoId));

/** The loaded open pull requests (all pages). */
export function cachedOpenPrs(repoId: Id): PrSummary[] | undefined {
  return queryClient.getQueryData<InfiniteData<PrPage>>(qk.prList(repoId, "open"))?.pages.flatMap((page) => page.items);
}

/** The open pull request whose source is this branch – as far as loaded. */
export function cachedPrForBranch(repoId: Id, branch: string): PrSummary | undefined {
  return cachedOpenPrs(repoId)?.find((pr) => pr.sourceBranch === branch);
}

export type HostLink =
  /** State not loaded yet. */
  | { state: "unknown" }
  | { state: "connected"; repo: HostRepo; account: HostAccountInfo }
  /** The host is recognised (or not), but no account matches it. */
  | { state: "not_connected"; repo: HostRepo | null };

/** Whether the repository is linked to a connected account – for menus and commands, without asking the core. */
export function hostLink(repoId: Id): HostLink {
  const repo = cachedHostRepo(repoId);
  const accounts = cachedHostAccounts();
  if (repo === undefined) return accounts && accounts.length === 0 ? { state: "not_connected", repo: null } : { state: "unknown" };
  if (repo?.account) return { state: "connected", repo, account: repo.account };
  return { state: "not_connected", repo };
}

export const prBusyKeys = {
  create: (repoId: Id) => `${repoId}:pr:create`,
  write: (repoId: Id, number: number) => `${repoId}:pr:${number}`,
};

/** Word for the pull request as this repository's host calls it (for hints). */
export const prWord = (repoId: Id) => hostPrWord[cachedHostRepo(repoId)?.kind ?? "github"];

// ---------------------------------------------------------------------------
// Opening views
// ---------------------------------------------------------------------------

/** Opens the form for a new pull request. If the branch already has an open pull request (as far as known), it goes there directly. */
export function openPrCreate(repoId: Id, tabId: Id, preset: { source?: string | null; target?: string | null } = {}): void {
  const existing = preset.source ? cachedPrForBranch(repoId, preset.source) : undefined;
  if (existing) {
    toast({ tone: "info", title: t("actions.pullrequests.exists", { branch: clip(preset.source!, 40), number: existing.number }) });
    openPr(tabId, existing.number);
    return;
  }
  useAppStore.getState().setCenter(tabId, { kind: "pr_create", source: preset.source ?? undefined, target: preset.target ?? undefined });
}

export function openPr(tabId: Id, number: number): void {
  useAppStore.getState().setCenter(tabId, { kind: "pr", number });
}

/** Reload everything about this repository's pull requests. */
export function refreshPullRequests(repoId: Id, number?: number): void {
  void queryClient.invalidateQueries({ queryKey: qk.prLists(repoId) });
  void queryClient.invalidateQueries({ queryKey: number === undefined ? qk.prs(repoId) : qk.pr(repoId, number) });
}

// ---------------------------------------------------------------------------
// Preparing: title, push
// ---------------------------------------------------------------------------

/** "feature/neue-auswertung" → "Neue auswertung". */
export function titleFromBranch(branch: string): string {
  const last = branch.split("/").filter(Boolean).pop() ?? branch;
  const words = last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

/** Title suggestion: with exactly one commit its first line, otherwise the branch name in words. */
export function suggestTitle(branch: string, commitSummaries: string[] | null): string {
  if (commitSummaries?.length === 1 && commitSummaries[0]!.trim()) return commitSummaries[0]!.trim();
  return titleFromBranch(branch);
}

/** The commits `source` has ahead of `target` (newest first) – from the graph; null = unknown. */
export async function commitsAhead(repoId: Id, sourceSha: Sha, targetSha: Sha): Promise<{ sha: Sha; summary: string }[] | null> {
  const index = await loadGraphIndex(repoId);
  const range = index ? commitsBetween(index, targetSha, sourceSha) : null;
  if (!range || range.partial) return null;
  return range.rows.map((row) => ({ sha: row.sha!, summary: row.summary }));
}

export type PushState =
  | { state: "pushed"; upstream: string }
  /** The remote branch exists, but there are local commits missing there. */
  | { state: "ahead"; upstream: string; count: number }
  | { state: "no_upstream" }
  | { state: "unknown" };

/** Is the branch fully on the remote? */
export function pushState(ref: Ref | undefined): PushState {
  if (!ref) return { state: "unknown" };
  if (!ref.upstream || ref.upstreamGone) return { state: "no_upstream" };
  return ref.ahead > 0 ? { state: "ahead", upstream: ref.upstream, count: ref.ahead } : { state: "pushed", upstream: ref.upstream };
}

/** The remote the host belongs to; if it is not known, the one named `origin`, otherwise the first. */
function preferredRemote(repoId: Id, remotes: Remote[]): string | null {
  const hosted = cachedHostRepo(repoId)?.remote;
  return (remotes.find((remote) => remote.name === hosted) ?? remotes.find((remote) => remote.name === "origin") ?? remotes[0])?.name ?? null;
}

/**
 * Pushes `branch` (creates the remote branch if needed and sets it as upstream). The progress
 * runs under `jobId` – the caller shows it. Returns the result; errors have already been reported.
 */
export async function pushBranchForPr(repoId: Id, branch: string, jobId: string): Promise<ActionResult<PushResult>> {
  const ref = cachedRefs(repoId)?.locals.find((item) => item.name === branch);
  const needsTarget = !ref?.upstream || ref.upstreamGone;
  const remote = needsTarget ? preferredRemote(repoId, await loadRemotes(repoId).catch(() => [] as Remote[])) : null;
  // The same jobId may be used again once the first attempt has ended.
  const result = await guardSecrets(repoId, (acceptedSecrets) =>
    runAction(t("actions.sync.push.label"), () => core.push({ repoId, jobId, branch, remote, remoteBranch: needsTarget ? branch : null, force: false, expected: null, acceptedSecrets }), {
      busyKey: busyKeys.push(repoId),
      job: { id: jobId, title: t("actions.pullrequests.pushJob", { branch: clip(branch, 32) }), repoId },
    }),
  );
  await loadRefs(repoId).catch(() => undefined);
  if (result.ok && result.value.status === "rejected") toast({ tone: "danger", title: t("actions.pullrequests.pushRejected"), description: result.value.reason });
  return result;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Creates the pull request. Errors go back to the form (without a message); on success its view opens. */
export async function createPullRequest(input: PrCreateInput, tabId: Id): Promise<ActionResult<PrSummary>> {
  const result = await runHostAction(t("actions.pullrequests.create.label"), () => hostApi.prCreate(input), { busyKey: prBusyKeys.create(input.repoId), inline: true });
  if (result.ok) {
    refreshPullRequests(input.repoId);
    toast({ tone: "success", title: t("actions.pullrequests.create.done", { number: result.value.number }), description: clip(result.value.title, 80) });
    openPr(tabId, result.value.number);
  } else if (hostErrorKind(result.error) === "auth") {
    void queryClient.invalidateQueries({ queryKey: qk.hostAccounts });
  }
  return result;
}

export async function commentOnPr(repoId: Id, number: number, body: string): Promise<boolean> {
  const result = await runHostAction(t("actions.pullrequests.comment.label"), () => hostApi.prComment(repoId, number, body), { busyKey: prBusyKeys.write(repoId, number) });
  if (result.ok) {
    await queryClient.invalidateQueries({ queryKey: qk.pr(repoId, number) });
    toast({ tone: "success", title: t("actions.pullrequests.comment.done") });
  }
  return result.ok;
}

export const mergeMethodLabels: Record<MergeMethod, string> = {
  merge: t("actions.pullrequests.method.merge"),
  squash: t("actions.pullrequests.method.squash"),
  rebase: t("actions.pullrequests.method.rebase"),
};
export const mergeMethodHints: Record<MergeMethod, string> = {
  merge: t("actions.pullrequests.method.mergeHint"),
  squash: t("actions.pullrequests.method.squashHint"),
  rebase: t("actions.pullrequests.method.rebaseHint"),
};

/**
 * Why the pull request cannot be merged right now – or null. The host decides in the end;
 * this only blocks what it would certainly refuse or what should not be done by accident.
 */
export function mergeBlock(pr: Pick<PrDetails, "state" | "isDraft" | "mergeable" | "mergeBlocked" | "checks">): string | null {
  if (pr.state === "merged") return t("actions.pullrequests.block.merged");
  if (pr.state === "closed") return t("actions.pullrequests.block.closed");
  if (pr.isDraft) return t("actions.pullrequests.block.draft");
  if (pr.mergeable === false) return pr.mergeBlocked ?? t("actions.pullrequests.block.conflicts");
  if (pr.checks === "failing") return t("actions.pullrequests.block.checksFailing");
  if (pr.checks === "pending") return t("actions.pullrequests.block.checksPending");
  if (pr.mergeable === null) return t("actions.pullrequests.block.checking");
  return null;
}

export async function mergePr(repoId: Id, pr: Pick<PrSummary, "number" | "targetBranch" | "sourceBranch">, method: MergeMethod, deleteBranch: boolean): Promise<boolean> {
  const result = await runHostAction(t("actions.pullrequests.merge.label"), () => hostApi.prMerge(repoId, pr.number, method, deleteBranch), { busyKey: prBusyKeys.write(repoId, pr.number) });
  refreshPullRequests(repoId, pr.number);
  if (!result.ok) return false;
  toast({
    tone: "success",
    title: t("actions.pullrequests.merge.done", { number: pr.number }),
    description: deleteBranch
      ? t("actions.pullrequests.merge.descriptionDeleted", { target: clip(pr.targetBranch, 40), source: clip(pr.sourceBranch, 40) })
      : t("actions.pullrequests.merge.description", { target: clip(pr.targetBranch, 40) }),
    action: { label: t("actions.pullrequests.merge.fetch"), onClick: () => void fetchAll(repoId) },
    sticky: true,
  });
  return true;
}

export async function closePr(repoId: Id, pr: Pick<PrSummary, "number" | "title">): Promise<boolean> {
  const ok = await confirm({
    title: t("actions.pullrequests.close.title", { number: pr.number }),
    body: t("actions.pullrequests.close.body", { title: clip(pr.title, 80) }),
    // Not just "Close": that is already the name of the button with the cross in the dialog.
    confirmLabel: t("actions.pullrequests.close.action"),
  });
  if (!ok) return false;
  const result = await runHostAction(t("actions.pullrequests.close.label"), () => hostApi.prClose(repoId, pr.number), {
    busyKey: prBusyKeys.write(repoId, pr.number),
    success: t("actions.pullrequests.close.done", { number: pr.number }),
  });
  refreshPullRequests(repoId, pr.number);
  return result.ok;
}

export async function reopenPr(repoId: Id, pr: Pick<PrSummary, "number">): Promise<boolean> {
  const result = await runHostAction(t("actions.pullrequests.reopen.label"), () => hostApi.prReopen(repoId, pr.number), {
    busyKey: prBusyKeys.write(repoId, pr.number),
    success: t("actions.pullrequests.reopen.done", { number: pr.number }),
  });
  refreshPullRequests(repoId, pr.number);
  return result.ok;
}

/** Fetches the pull request's branch and checks it out. */
export async function checkoutPr(repoId: Id, pr: Pick<PrSummary, "number" | "sourceBranch">): Promise<boolean> {
  const jobId = newJobId();
  const result = await runHostAction(t("actions.pullrequests.checkout.label"), () => hostApi.prCheckout(repoId, pr.number), {
    busyKey: busyKeys.history(repoId),
    job: { id: jobId, title: t("actions.pullrequests.checkout.job", { number: pr.number }), repoId },
  });
  // The core reports the changes itself too; here immediately so graph and Left Panel don't lag behind.
  for (const key of [qk.refs(repoId), qk.status(repoId), qk.graph(repoId), qk.undo(repoId)]) void queryClient.invalidateQueries({ queryKey: key });
  if (!result.ok) return false;
  const status = result.value as Partial<Status> | null;
  const branch = status?.head && status.head.kind === "branch" ? status.head.branch : pr.sourceBranch;
  toast({
    tone: "success",
    title: t("actions.branches.checkout.done", { name: clip(branch, 48) }),
    description: t("actions.pullrequests.checkout.done", { number: pr.number }),
  });
  return true;
}

