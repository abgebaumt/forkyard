/**
 * Which merges the graph shows collapsed – pure functions over the view state. A collapsed merge hides
 * the commits it brought in; the core computes which ones (graph_page).
 *
 * "Collapse all" is the flag `collapseAllMerges`: the core then collapses every merge, also on pages
 * loaded later. Expanding one merge while the flag is on turns the flag off and keeps the other merges
 * of the loaded pages collapsed.
 */
import type { RepoViewState, Sha } from "../../core";

export type CollapseState = Pick<RepoViewState, "collapsedMerges" | "collapseAllMerges">;

export const ALL_COLLAPSED: CollapseState = Object.freeze({ collapsedMerges: [], collapseAllMerges: true }) as CollapseState;
export const NONE_COLLAPSED: CollapseState = Object.freeze({ collapsedMerges: [], collapseAllMerges: false }) as CollapseState;

export const isMergeCollapsed = (view: CollapseState | undefined, sha: Sha): boolean =>
  Boolean(view && (view.collapseAllMerges || view.collapsedMerges.includes(sha)));

/** State after collapsing (`collapse: true`) or expanding the merge `sha`. `loaded`: the merges of the loaded pages. */
export function nextCollapse(view: CollapseState, sha: Sha, collapse: boolean, loaded: readonly Sha[]): CollapseState {
  if (view.collapseAllMerges) {
    if (collapse) return view;
    return { collapsedMerges: loaded.filter((merge) => merge !== sha), collapseAllMerges: false };
  }
  const without = view.collapsedMerges.filter((merge) => merge !== sha);
  return { collapsedMerges: collapse ? [...without, sha] : without, collapseAllMerges: false };
}
