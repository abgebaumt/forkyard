/**
 * Write the view state per repository (sections, collapsed folders, hide and solo).
 * The UI shows the change immediately; what the core returns stays authoritative.
 */
import { core, type Id, type RepoViewState, type SectionId } from "../../core";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { toggleNames } from "./model";
import { t } from "../../i18n";

export const EMPTY_VIEW: RepoViewState = {
  hiddenRefs: [],
  soloRefs: [],
  pinnedRefs: [],
  collapsedFolders: [],
  columns: [],
  sections: [],
  collapsedMerges: [],
  collapseAllMerges: false,
};

/** Running writes per repository – only the answer of the last one counts. */
const pending = new Map<Id, number>();

export function currentView(repoId: Id): RepoViewState {
  return queryClient.getQueryData<RepoViewState>(qk.viewState(repoId)) ?? EMPTY_VIEW;
}

/**
 * Writes `patch`. If `hiddenRefs` or `soloRefs` change, the graph reloads –
 * only what it shows changes, never the repository.
 */
export async function patchView(repoId: Id, patch: Partial<RepoViewState>): Promise<boolean> {
  const key = qk.viewState(repoId);
  const previous = queryClient.getQueryData<RepoViewState>(key);
  if (previous) queryClient.setQueryData<RepoViewState>(key, { ...previous, ...patch });
  pending.set(repoId, (pending.get(repoId) ?? 0) + 1);
  const result = await runAction(t("sidebar.saveView"), () => core.viewStateSet({ repoId, patch }));
  const left = (pending.get(repoId) ?? 1) - 1;
  pending.set(repoId, left);
  if (!result.ok) {
    void queryClient.invalidateQueries({ queryKey: key });
    return false;
  }
  if (left === 0) queryClient.setQueryData(key, result.value);
  if ("hiddenRefs" in patch || "soloRefs" in patch) void queryClient.invalidateQueries({ queryKey: qk.graph(repoId) });
  return true;
}

export function sectionState(view: RepoViewState, id: SectionId): { collapsed: boolean; hidden: boolean } {
  const found = view.sections.find((section) => section.id === id);
  return { collapsed: found?.collapsed ?? false, hidden: found?.hidden ?? false };
}

export function setSection(repoId: Id, id: SectionId, change: { collapsed?: boolean; hidden?: boolean }) {
  const view = currentView(repoId);
  const exists = view.sections.some((section) => section.id === id);
  const sections = exists
    ? view.sections.map((section) => (section.id === id ? { ...section, ...change } : section))
    : [...view.sections, { id, collapsed: false, hidden: false, ...change }];
  return patchView(repoId, { sections });
}

export function setFolderCollapsed(repoId: Id, folderId: string, collapsed: boolean) {
  const view = currentView(repoId);
  const has = view.collapsedFolders.includes(folderId);
  if (has === collapsed) return Promise.resolve(true);
  const collapsedFolders = collapsed ? [...view.collapsedFolders, folderId] : view.collapsedFolders.filter((item) => item !== folderId);
  return patchView(repoId, { collapsedFolders });
}

/** Toggle hiding. What is hidden cannot be solo at the same time. */
export function toggleHidden(repoId: Id, names: string[]) {
  if (!names.length) return Promise.resolve(true);
  const view = currentView(repoId);
  const hiddenRefs = toggleNames(view.hiddenRefs, names);
  const nowHidden = new Set(hiddenRefs);
  const soloRefs = view.soloRefs.filter((name) => !nowHidden.has(name));
  return patchView(repoId, soloRefs.length === view.soloRefs.length ? { hiddenRefs } : { hiddenRefs, soloRefs });
}

/** Toggle solo. What is solo cannot be hidden at the same time. */
export function toggleSolo(repoId: Id, names: string[]) {
  if (!names.length) return Promise.resolve(true);
  const view = currentView(repoId);
  const soloRefs = toggleNames(view.soloRefs, names);
  const nowSolo = new Set(soloRefs);
  const hiddenRefs = view.hiddenRefs.filter((name) => !nowSolo.has(name));
  return patchView(repoId, hiddenRefs.length === view.hiddenRefs.length ? { soloRefs } : { soloRefs, hiddenRefs });
}

export function resetVisibility(repoId: Id) {
  return patchView(repoId, { hiddenRefs: [], soloRefs: [] });
}
