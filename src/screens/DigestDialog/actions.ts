/** "What's new": the palette command and the check after a fetch. */
import { core, type Id, type Tab } from "../../core";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { t } from "../../i18n";
import { showDigestDialog } from "./index";

/** Repositories with a dialog open or a check in flight: a second fetch or command meanwhile asks nothing. */
const busy = new Set<Id>();

/** Resolves once no sign-in or host prompt is open: that one lives outside the dialog queue, and a dialog opened over it would take its focus. */
function credentialsAnswered(): Promise<void> {
  return new Promise((resolve) => {
    if (!useAppStore.getState().credentialQueue.length) return resolve();
    const stop = useAppStore.subscribe((state) => {
      if (state.credentialQueue.length) return;
      stop();
      resolve();
    });
  });
}

/**
 * After a fetch: the dialog opens when the remote refs changed since the last one and the last 24
 * hours hold news. Only when the repository's tab is the active one of this window – each answer may cost host requests.
 */
export async function checkDigestAfterFetch(repoId: Id): Promise<void> {
  // Only for the repository in front: a dialog about a background tab would name nothing the user sees.
  const tab = (queryClient.getQueryData<Tab[]>(qk.tabs) ?? []).find((tab) => tab.repoId === repoId && tab.isActive);
  if (!tab || busy.has(repoId)) return;
  busy.add(repoId);
  try {
    const digest = await core.digestGet({ repoId, ifChanged: true });
    if (!digest) return;
    await credentialsAnswered();
    await showDigestDialog(repoId, tab.id, digest);
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
