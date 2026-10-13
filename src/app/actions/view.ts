/**
 * Visibility of refs in the graph (hide, solo). Changes only the view, nothing in the repository.
 */
import { t } from "../../i18n";
import { core, type Id, type RepoViewState } from "../../core";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { cachedViewState } from "./context";

async function patchView(repoId: Id, label: string, change: (view: RepoViewState) => Partial<RepoViewState>) {
  const current = cachedViewState(repoId) ?? (await core.viewStateGet({ repoId }).catch(() => undefined));
  if (!current) return null;
  const patch = change(current);
  // Show immediately; the core confirms.
  queryClient.setQueryData<RepoViewState>(qk.viewState(repoId), { ...current, ...patch });
  const result = await runAction(label, () => core.viewStateSet({ repoId, patch }));
  if (result.ok) {
    queryClient.setQueryData(qk.viewState(repoId), result.value);
    // Hidden and solo refs determine which commits the graph loads at all.
    void queryClient.invalidateQueries({ queryKey: qk.graph(repoId) });
  } else {
    queryClient.setQueryData(qk.viewState(repoId), current);
  }
  return result;
}

const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

export const isHidden = (repoId: Id, fullName: string) => cachedViewState(repoId)?.hiddenRefs.includes(fullName) ?? false;
export const isSolo = (repoId: Id, fullName: string) => cachedViewState(repoId)?.soloRefs.includes(fullName) ?? false;

/** Hides a ref in the graph or shows it again. */
export function toggleHidden(repoId: Id, fullName: string) {
  return patchView(repoId, t("actions.graphView.change"), (view) => ({
    hiddenRefs: toggle(view.hiddenRefs, fullName),
    // Hide and solo are mutually exclusive.
    soloRefs: view.soloRefs.filter((item) => item !== fullName),
  }));
}

/** Shows only this ref in the graph (and other solo refs), or undoes that. */
export function toggleSolo(repoId: Id, fullName: string) {
  return patchView(repoId, t("actions.graphView.change"), (view) => ({
    soloRefs: toggle(view.soloRefs, fullName),
    hiddenRefs: view.hiddenRefs.filter((item) => item !== fullName),
  }));
}

/** Clears solo for all refs. */
export function clearSolo(repoId: Id) {
  return patchView(repoId, t("actions.graphView.change"), () => ({ soloRefs: [] }));
}
