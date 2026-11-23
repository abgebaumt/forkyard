/** "What's new": the palette command and the check after a fetch. */
import { core, type Id, type Tab } from "../../core";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { t } from "../../i18n";
import { showDigestDialog } from "./index";

/** Repositories with a dialog open or a check in flight: a second fetch or command meanwhile asks nothing. */
const busy = new Set<Id>();

/**
 * After a fetch: the dialog opens when the remote refs changed since the last one and the last 24
 * hours hold news. Only in a window with a tab for the repository – each answer may cost host requests.
 */
export async function checkDigestAfterFetch(repoId: Id): Promise<void> {
  const tab = (queryClient.getQueryData<Tab[]>(qk.tabs) ?? []).find((tab) => tab.repoId === repoId);
  if (!tab || busy.has(repoId)) return;
  busy.add(repoId);
  try {
    const digest = await core.digestGet({ repoId, ifChanged: true });
    if (digest) await showDigestDialog(repoId, tab.id, digest);
  } catch (error) {
    // A background check: the user asked for nothing, the palette command still shows errors.
    console.debug("What's new: check after a fetch failed", error);
  } finally {
    busy.delete(repoId);
  }
}

/** From the palette: always opens, with the empty state when the last 24 hours hold nothing. */
export async function openDigest(repoId: Id, tabId: Id): Promise<void> {
  if (busy.has(repoId)) return;
  busy.add(repoId);
  try {
    const result = await runAction(t("commands.repo.digest.title"), () => core.digestGet({ repoId }));
    if (result.ok && result.value) await showDigestDialog(repoId, tabId, result.value);
  } finally {
    busy.delete(repoId);
  }
}
