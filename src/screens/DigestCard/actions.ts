/** "What's new since …": the core calls behind the card, the palette command and the check after a fetch. */
import { core, type Digest, type DigestMark, type Id, type Tab } from "../../core";
import { formatRelative } from "../../app/format";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { AUTO_MIN_AGE_HOURS } from "./model";

/** Repositories with a check in flight: a second fetch meanwhile asks nothing. */
const checking = new Set<Id>();

/**
 * After a fetch: the card opens when the seen state is old enough and something is new. Only in a
 * window with a tab for the repository, and never while its card is open – each answer may cost
 * host requests, and the open card keeps what it shows until it is marked as seen.
 */
export async function checkDigestAfterFetch(repoId: Id): Promise<void> {
  const tabs = queryClient.getQueryData<Tab[]>(qk.tabs) ?? [];
  if (!tabs.some((tab) => tab.repoId === repoId)) return;
  if (useAppStore.getState().digestOpen[repoId] || checking.has(repoId)) return;
  checking.add(repoId);
  try {
    const digest = await core.digestGet({ repoId, minAgeHours: AUTO_MIN_AGE_HOURS });
    if (!digest || digest.isEmpty) return;
    queryClient.setQueryData<Digest | null>(qk.digest(repoId), digest);
    useAppStore.getState().openDigest(repoId);
  } catch (error) {
    // A background check: the user asked for nothing, the palette command still shows errors.
    console.debug("What's new: check after a fetch failed", error);
  } finally {
    checking.delete(repoId);
  }
}

const freshDigest = (repoId: Id) =>
  queryClient.fetchQuery({ queryKey: qk.digest(repoId), queryFn: () => core.digestGet({ repoId }), staleTime: 0 });

/** From the palette: always a fresh answer; nothing new is a toast instead of an empty card. */
export async function openDigestCard(repoId: Id): Promise<void> {
  const result = await runAction(t("commands.repo.digest.title"), () => freshDigest(repoId));
  if (!result.ok) return;
  const digest = result.value;
  if (digest && !digest.isEmpty) useAppStore.getState().openDigest(repoId);
  else toast({ tone: "info", title: t("digest.nothingNew", { time: formatRelative(digest?.seenAt ?? Date.now()) }) });
}

/** Fetches seen per repository while its card was open; a reload compares it to catch a fetch that ran meanwhile. */
const fetchesWhileOpen = new Map<Id, number>();

/**
 * While the card is open, a fetch with changed refs only marks the digest stale (`digestFetchedWhileOpen`).
 * Marking would then swallow news the card never showed: the card reloads instead and the user marks again.
 */
export function digestFetchedWhileOpen(repoId: Id): void {
  if (!useAppStore.getState().digestOpen[repoId]) return;
  fetchesWhileOpen.set(repoId, (fetchesWhileOpen.get(repoId) ?? 0) + 1);
  void queryClient.invalidateQueries({ queryKey: qk.digest(repoId), refetchType: "none" });
}

/**
 * "Mark as seen" and ×: the seen state becomes what the shown digest compared (`mark`) and the card closes – unless it is behind a fetch, then it
 * reloads ("reloaded") and the user marks again. A failed reload is "failed": the error toast says it all.
 */
export async function markDigestSeen(repoId: Id, mark: DigestMark): Promise<"reloaded" | "marked" | "failed"> {
  if (queryClient.getQueryState(qk.digest(repoId))?.isInvalidated) {
    const before = fetchesWhileOpen.get(repoId);
    const result = await runAction(t("commands.repo.digest.title"), () => freshDigest(repoId));
    if (!result.ok) return "failed";
    // A fetch during the reload: its answer may predate it, so the card stays stale.
    if (fetchesWhileOpen.get(repoId) !== before) {
      await queryClient.invalidateQueries({ queryKey: qk.digest(repoId), refetchType: "none" });
    }
    return "reloaded";
  }
  // Closed first: the disabled query then ignores the `seen` event instead of loading a full digest.
  useAppStore.getState().closeDigest(repoId);
  const result = await runAction(t("digest.markSeen"), () => core.digestMarkSeen({ repoId, mark }));
  if (!result.ok) useAppStore.getState().openDigest(repoId);
  return "marked";
}
