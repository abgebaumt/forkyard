/**
 * Graph view settings that change nothing in the repository: pin a branch on the left and the toggle
 * "only current branch, upstream and target". Both live in the core's RepoViewState
 * (`pinnedRefs`, `soloRefs`) and apply per repository.
 */
import { t } from "../../i18n";
import { core, type Id, type RepoViewState } from "../../core";
import { sameRefs, setSmartRecord, smartRecord, smartSelection } from "../../components/graph/smart";
import { toast } from "../../ui/Feedback";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { cachedRefs, cachedSettings, cachedViewState, clipMiddle } from "./context";

async function writeView(repoId: Id, label: string, patch: Partial<RepoViewState>): Promise<RepoViewState | null> {
  const before = cachedViewState(repoId);
  // Show immediately; the core confirms.
  if (before) queryClient.setQueryData<RepoViewState>(qk.viewState(repoId), { ...before, ...patch });
  const result = await runAction(label, () => core.viewStateSet({ repoId, patch }));
  if (result.ok) {
    queryClient.setQueryData(qk.viewState(repoId), result.value);
    return result.value;
  }
  if (before) queryClient.setQueryData(qk.viewState(repoId), before);
  return null;
}

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

export const isPinned = (repoId: Id, fullName: string) => cachedViewState(repoId)?.pinnedRefs.includes(fullName) ?? false;

/** Pins a branch on the left of the graph or unpins it. The pinning order is kept. */
export async function togglePinned(repoId: Id, fullName: string, name: string) {
  const view = cachedViewState(repoId) ?? (await core.viewStateGet({ repoId }).catch(() => null));
  if (!view) return null;
  const pinned = view.pinnedRefs.includes(fullName);
  const next = await writeView(repoId, pinned ? t("actions.graphView.unpin") : t("actions.graphView.pin"), {
    pinnedRefs: pinned ? view.pinnedRefs.filter((item) => item !== fullName) : [...view.pinnedRefs, fullName],
  });
  if (next) {
    toast({
      tone: "success",
      title: pinned ? t("actions.graphView.unpinned", { name: clipMiddle(name, 40) }) : t("actions.graphView.pinned", { name: clipMiddle(name, 40) }),
      description: pinned ? undefined : t("actions.graphView.pinnedDescription"),
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Only current branch, upstream and target
// ---------------------------------------------------------------------------

export const isSmartOn = (repoId: Id) => smartRecord(repoId) !== null;

/** Why the toggle does not work right now – or null. */
export function smartBlock(repoId: Id): string | null {
  const refs = cachedRefs(repoId);
  if (!refs) return t("actions.graphView.smart.refsLoading");
  if (refs.head.kind === "detached") return t("actions.graphView.smart.detached");
  if (refs.head.kind === "unborn") return t("actions.graphView.smart.unborn");
  return smartSelection(refs, cachedSettings()?.defaultBranchName) ? null : t("actions.graphView.smart.headLoading");
}

/** Turns the selection on or off. When turning off, the previous solo filter comes back. */
export async function setSmartVisibility(repoId: Id, on: boolean) {
  const view = cachedViewState(repoId) ?? (await core.viewStateGet({ repoId }).catch(() => null));
  if (!view) return false;
  if (!on) {
    const record = smartRecord(repoId);
    if (!record) return true;
    const refs = cachedRefs(repoId);
    const known = new Set([...(refs?.locals ?? []), ...(refs?.remotes ?? []), ...(refs?.tags ?? [])].map((ref) => ref.fullName));
    // Only revert what the toggle set itself; a filter changed by hand stays.
    const ours = sameRefs(view.soloRefs, record.applied);
    setSmartRecord(repoId, null);
    if (ours) await writeView(repoId, t("actions.graphView.change"), { soloRefs: record.previous.filter((name) => known.has(name) || name === "refs/stash") });
    return true;
  }
  const selection = smartSelection(cachedRefs(repoId), cachedSettings()?.defaultBranchName);
  if (!selection) return false;
  const previous = smartRecord(repoId)?.previous ?? view.soloRefs;
  setSmartRecord(repoId, { applied: selection.refs, previous });
  const written = await writeView(repoId, t("actions.graphView.change"), { soloRefs: selection.refs });
  if (!written) setSmartRecord(repoId, null);
  return written !== null;
}

export const toggleSmartVisibility = (repoId: Id) => setSmartVisibility(repoId, !isSmartOn(repoId));

/**
 * Keeps the selection current while the toggle is on: after a checkout the graph shows the
 * new branch. If someone has changed the solo filter by hand in the meantime, their choice applies – the
 * toggle then turns off without resetting anything.
 */
export async function syncSmartVisibility(repoId: Id): Promise<void> {
  const record = smartRecord(repoId);
  const view = cachedViewState(repoId);
  const refs = cachedRefs(repoId);
  if (!record || !view || !refs) return;
  if (!sameRefs(view.soloRefs, record.applied)) {
    setSmartRecord(repoId, null);
    return;
  }
  const selection = smartSelection(refs, cachedSettings()?.defaultBranchName);
  // No branch checked out: meanwhile the graph shows everything; the toggle stays on and applies again as soon as a branch is checked out.
  const desired = selection?.refs ?? [];
  if (sameRefs(desired, record.applied)) return;
  setSmartRecord(repoId, { applied: desired, previous: record.previous });
  const written = await writeView(repoId, t("actions.graphView.change"), { soloRefs: desired });
  if (!written) setSmartRecord(repoId, { applied: view.soloRefs, previous: record.previous });
}
