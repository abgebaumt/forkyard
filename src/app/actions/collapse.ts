/**
 * Collapse and expand merges in the graph. Changes only the view (viewStateSet), nothing in the
 * repository; the graph then loads from the start, because rows and lanes change.
 */
import type { InfiniteData } from "@tanstack/react-query";
import { core, type GraphPage, type Id, type RepoViewState, type Sha } from "../../core";
import { ALL_COLLAPSED, isMergeCollapsed, nextCollapse, NONE_COLLAPSED, type CollapseState } from "../../components/graph/collapse";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { cachedGraphRows, cachedViewState } from "./context";

/** Merge commits among the loaded graph rows. */
function loadedMerges(repoId: Id): Sha[] {
  return cachedGraphRows(repoId).flatMap((row) => (row.kind === "merge" && row.sha ? [row.sha] : []));
}

async function writeCollapse(repoId: Id, patch: CollapseState): Promise<boolean> {
  const before = cachedViewState(repoId) ?? (await core.viewStateGet({ repoId }).catch(() => undefined));
  if (!before) return false;
  if (before.collapseAllMerges === patch.collapseAllMerges && before.collapsedMerges.join("\n") === patch.collapsedMerges.join("\n")) return true;
  // Show immediately; the core confirms.
  queryClient.setQueryData<RepoViewState>(qk.viewState(repoId), { ...before, ...patch });
  const result = await runAction(t("graph.collapse.save"), () => core.viewStateSet({ repoId, patch }));
  if (!result.ok) {
    queryClient.setQueryData(qk.viewState(repoId), before);
    return false;
  }
  queryClient.setQueryData(qk.viewState(repoId), result.value);
  // Other rows, other lanes: load from the start, keeping only the first page.
  queryClient.setQueryData<InfiniteData<GraphPage, string | null>>(qk.graph(repoId), (data) =>
    data && data.pages.length > 1 ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
  );
  await queryClient.invalidateQueries({ queryKey: qk.graph(repoId) });
  return true;
}

export async function setMergeCollapsed(repoId: Id, sha: Sha, collapse: boolean): Promise<boolean> {
  const view = cachedViewState(repoId);
  if (!view) return false;
  const before: CollapseState = { collapsedMerges: view.collapsedMerges, collapseAllMerges: view.collapseAllMerges };
  if (!(await writeCollapse(repoId, nextCollapse(view, sha, collapse, loadedMerges(repoId))))) return false;
  // Everything the merge brought in is also on a visible branch or tag: nothing disappeared, so the
  // arrow must not claim it did.
  if (collapse && !before.collapseAllMerges && cachedGraphRows(repoId).find((row) => row.sha === sha)?.collapsedCount === 0) {
    await writeCollapse(repoId, before);
    toast({ tone: "info", title: t("graph.collapse.nothing.title"), description: t("graph.collapse.nothing.description") });
  }
  return true;
}

export const toggleMergeCollapsed = (repoId: Id, sha: Sha) => setMergeCollapsed(repoId, sha, !isMergeCollapsed(cachedViewState(repoId), sha));

export const setAllMergesCollapsed = (repoId: Id, collapse: boolean) => writeCollapse(repoId, collapse ? ALL_COLLAPSED : NONE_COLLAPSED);
