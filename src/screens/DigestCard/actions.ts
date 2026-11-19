/** "What's new since …": the core calls behind the card, the palette command and the check after a fetch. */
import { core, type Digest, type Id, type Tab } from "../../core";
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
  } catch {
    // A background check: the user asked for nothing, the palette command still shows errors.
  } finally {
    checking.delete(repoId);
  }
}

/** From the palette: always a fresh answer; nothing new is a toast instead of an empty card. */
export async function openDigestCard(repoId: Id): Promise<void> {
  const result = await runAction(t("commands.repo.digest.title"), () =>
    queryClient.fetchQuery({ queryKey: qk.digest(repoId), queryFn: () => core.digestGet({ repoId }), staleTime: 0 }),
  );
  if (!result.ok) return;
  const digest = result.value;
  if (digest && !digest.isEmpty) useAppStore.getState().openDigest(repoId);
  else toast({ tone: "info", title: t("digest.nothingNew", { time: formatRelative(digest?.seenAt ?? Date.now()) }) });
}

/** "Mark as seen" and ×: the seen state moves to now (its `seen` event reloads the digest), the card closes. */
export async function markDigestSeen(repoId: Id, prMaxNumber: number | null): Promise<void> {
  const result = await runAction(t("digest.markSeen"), () => core.digestMarkSeen({ repoId, prMaxNumber }));
  if (result.ok) useAppStore.getState().closeDigest(repoId);
}
