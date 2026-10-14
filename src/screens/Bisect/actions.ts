/**
 * Bisect: start from the graph, mark the commit under test, end. The core reads the state from the
 * Git directory; each answer replaces the cached state, and the graph jumps to the next commit to
 * test (or to the result).
 */
import { core, type BisectStatus, type BisectVerdict, type Id, type Sha } from "../../core";
import { cachedRefs, loadRefs } from "../../app/actions/context";
import { choose, pickFromList } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { t } from "../../i18n";
import { markTarget } from "./model";

export const bisectBusyKey = (repoId: Id) => `${repoId}:bisect`;

const MARK_LABELS: Record<BisectVerdict, string> = {
  good: t("bisect.mark.good"),
  bad: t("bisect.mark.bad"),
  skip: t("bisect.mark.skip"),
};

/** Takes over the core's answer and shows the commit that matters now. */
function showState(repoId: Id, tabId: Id | null | undefined, status: BisectStatus) {
  queryClient.setQueryData(qk.bisect(repoId), status);
  const next = status.result ?? status.current;
  if (tabId && next) useAppStore.getState().revealCommit(tabId, next);
}

/** Bad and good commit: from two selected commits (the user confirms the order), otherwise good from the branches and tags. */
async function chooseRange(repoId: Id, shas: Sha[]): Promise<{ bad: Sha; good: Sha } | null> {
  const [first, second] = shas;
  if (!first) return null;
  if (second) {
    const choice = await choose<"as_selected" | "swapped">({
      title: t("bisect.start.title"),
      description: t("bisect.start.twoBody"),
      options: [
        { key: "as_selected", label: t("bisect.start.option", { bad: shortSha(first), good: shortSha(second) }) },
        { key: "swapped", label: t("bisect.start.option", { bad: shortSha(second), good: shortSha(first) }) },
      ],
    });
    if (!choice) return null;
    return choice === "as_selected" ? { bad: first, good: second } : { bad: second, good: first };
  }
  const refs = cachedRefs(repoId) ?? (await loadRefs(repoId).catch(() => undefined));
  const candidates = [...(refs?.tags ?? []), ...(refs?.locals ?? []), ...(refs?.remotes ?? [])].filter((ref) => ref.sha !== first);
  const picked = await pickFromList({
    title: t("bisect.start.title"),
    description: t("bisect.start.pickBody", { sha: shortSha(first) }),
    label: t("bisect.start.pickLabel"),
    items: candidates.map((ref) => ({ key: ref.fullName, label: ref.name, description: shortSha(ref.sha) })),
    empty: t("bisect.start.noRefs"),
    confirmLabel: t("bisect.start.confirm"),
    mono: true,
  });
  const good = candidates.find((ref) => ref.fullName === picked)?.sha;
  return good ? { bad: first, good } : null;
}

export async function startBisect(repoId: Id, shas: Sha[], tabId?: Id | null) {
  const range = await chooseRange(repoId, shas);
  if (!range) return null;
  const result = await runAction(t("bisect.start.label"), () => core.bisectStart({ repoId, bad: range.bad, good: [range.good] }), { busyKey: bisectBusyKey(repoId) });
  if (result.ok) showState(repoId, tabId, result.value);
  return result;
}

/** `sha: null` = the commit under test, as the bar shows it (see `markTarget`). */
export async function markBisect(repoId: Id, verdict: BisectVerdict, tabId?: Id | null, sha: Sha | null = null) {
  const target = markTarget(queryClient.getQueryData<BisectStatus>(qk.bisect(repoId)), sha);
  const result = await runAction(MARK_LABELS[verdict], () => core.bisectMark({ repoId, verdict, sha: target }), { busyKey: bisectBusyKey(repoId) });
  if (result.ok) showState(repoId, tabId, result.value);
  return result;
}

export async function endBisect(repoId: Id, tabId?: Id | null) {
  const result = await runAction(t("bisect.end.label"), () => core.bisectReset({ repoId }), { busyKey: bisectBusyKey(repoId) });
  if (result.ok) {
    queryClient.setQueryData(qk.bisect(repoId), result.value);
    if (tabId) useAppStore.getState().selectWip(tabId);
  }
  return result;
}
