/**
 * Change a repository's alias directly on the tab. The alias is only a display name (tab, list,
 * window title); the folder on disk keeps its name. An empty alias – or exactly the folder's
 * name – resets it.
 */
import { core, type Id, type Repo, type Tab } from "../../core";
import { toast } from "../../ui/Feedback";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { t } from "../../i18n";

// --- Triggering a rename from outside (Command Palette) ----------------------------------------

type RenameListener = (tabId: Id) => void;
const renameListeners = new Set<RenameListener>();

/** Asks the tab strip to open the input on tab `tabId`. */
export function requestTabRename(tabId: Id): void {
  for (const listener of renameListeners) listener(tabId);
}

/** The tab strip subscribes here; the returned function unsubscribes. */
export function onTabRenameRequest(listener: RenameListener): () => void {
  renameListeners.add(listener);
  return () => renameListeners.delete(listener);
}

/** What the input turns into: the new alias, `null` for "reset" or `undefined` for "nothing to do". */
export function aliasFromInput(repo: Pick<Repo, "name" | "alias">, input: string): string | null | undefined {
  const value = input.trim();
  const next = value === "" || value === repo.name ? null : value;
  return next === (repo.alias ?? null) ? undefined : next;
}

export async function setTabAlias(repo: Repo, input: string) {
  const alias = aliasFromInput(repo, input);
  if (alias === undefined) return null;
  const label = alias === null ? t("shell.alias.remove") : t("shell.alias.save");
  const result = await runAction(label, () => core.repoUpdate({ repoId: repo.id, alias }));
  if (!result.ok) return result;
  const updated = result.value;
  // Show it in the list and tab strip right away; the core's event reconciles afterwards.
  queryClient.setQueryData<Repo[]>(qk.repos, (list) => list?.map((item) => (item.id === updated.id ? updated : item)));
  queryClient.setQueryData<Tab[]>(qk.tabs, (tabs) => tabs?.map((tab) => (tab.repoId === updated.id ? { ...tab, title: updated.alias ?? updated.name } : tab)));
  void queryClient.invalidateQueries({ queryKey: qk.tabs });
  void queryClient.invalidateQueries({ queryKey: qk.repos });
  toast(
    alias === null
      ? { tone: "success", title: t("shell.alias.removed"), description: t("shell.alias.removedText", { name: updated.name }) }
      : { tone: "success", title: t("shell.alias.saved", { alias }), description: t("shell.alias.savedText", { name: updated.name }) },
  );
  return result;
}
