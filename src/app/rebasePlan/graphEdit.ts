/**
 * Editing the history in the graph: one edit per tab (plan, gesture state, a drag that started it),
 * entering with the checks before it, and leaving with the question when something would be lost.
 */
import { create } from "zustand";
import { core, type Id, type RebasePlan, type Sha } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { stashChanges } from "../actions/stash";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { showError } from "../run";
import { type CenterGuard, confirmLeaveCenter, getTabView, setCenterGuard, useAppStore } from "../store";
import { type OkPlan, planSignature, refusalTitle } from "./apply";
import { changeCount, type EditState, editStart } from "./gestures";

/** A pointer drag on a graph row that opened the mode; the edit view takes it over. */
export interface PendingDrag {
  sha: Sha;
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface GraphEdit {
  repoId: Id;
  /** Start commit chosen by "Edit history from here"; null = the branch's own commits. */
  from: Sha | null;
  plan: OkPlan;
  state: EditState;
  drag: PendingDrag | null;
  updateRefs: boolean;
}

export const useGraphEdit = create<{ byTab: Record<Id, GraphEdit> }>()(() => ({ byTab: {} }));

export const graphEditOf = (tabId: Id): GraphEdit | null => useGraphEdit.getState().byTab[tabId] ?? null;

export function updateGraphEdit(tabId: Id, change: (edit: GraphEdit) => GraphEdit): void {
  useGraphEdit.setState(({ byTab }) => (byTab[tabId] ? { byTab: { ...byTab, [tabId]: change(byTab[tabId]) } } : { byTab }));
}

export type EntryDecision =
  | { kind: "enter" }
  | { kind: "refused"; title: string; message: string; stash: boolean }
  | { kind: "notInRange" };

export function entryDecision(plan: RebasePlan, sha: Sha | null): EntryDecision {
  if (plan.status === "refused") {
    return { kind: "refused", title: refusalTitle[plan.reason], message: plan.message, stash: plan.reason === "dirty_worktree" };
  }
  return sha === null || plan.rows.some((row) => row.sha === sha) ? { kind: "enter" } : { kind: "notInRange" };
}

/** True when a fresh plan no longer fits the edit (other base or commits, or refused other than dirty_worktree). */
export function staleAfter(edit: GraphEdit, fresh: RebasePlan | undefined): boolean {
  if (!fresh) return false;
  if (fresh.status === "refused") return fresh.reason !== "dirty_worktree";
  return planSignature(fresh) !== planSignature(edit.plan);
}

const guards = new Map<Id, CenterGuard>();

function guardFor(tabId: Id): CenterGuard {
  return {
    dirty: () => {
      const edit = graphEditOf(tabId);
      return edit !== null && changeCount(edit.state, edit.plan.rows) > 0;
    },
    confirmLeave: async () => {
      const leave = await confirm({
        title: t("commitGraph.edit.leaveTitle"),
        body: t("commitGraph.edit.leaveBody"),
        confirmLabel: t("commitGraph.edit.discard"),
        danger: true,
      });
      if (leave) leaveGraphEdit(tabId);
      return leave;
    },
  };
}

/** Loads the plan (cache first), decides, toasts a refusal, or opens the mode (graph centre, guard). */
export async function enterGraphEdit(
  repoId: Id,
  tabId: Id,
  options: { from?: Sha | null; sha?: Sha | null; drag?: PendingDrag | null } = {},
): Promise<boolean> {
  if (graphEditOf(tabId)) return true;
  const from = options.from ?? null;
  let plan: RebasePlan;
  try {
    // Invalidated plans count as stale, so a changed branch is loaded again.
    plan = await queryClient.fetchQuery({
      queryKey: qk.rebaseBranchPlan(repoId, from),
      queryFn: () => core.rebaseBranchPlan({ repoId, from }),
      staleTime: Number.POSITIVE_INFINITY,
    });
  } catch (error) {
    showError(t("menus.commit.editHistory"), error);
    return false;
  }
  const decision = entryDecision(plan, options.sha ?? null);
  if (decision.kind === "notInRange") {
    toast({ tone: "info", title: t("commitGraph.edit.notInRange") });
    return false;
  }
  if (decision.kind === "refused") {
    toast({
      tone: "info",
      title: decision.title,
      description: decision.message,
      action: decision.stash ? { label: t("ui.stashChanges"), onClick: () => void stashChanges(repoId) } : undefined,
    });
    return false;
  }
  if (plan.status !== "ok") return false;
  // Another view in the centre (maybe with unsaved work of its own) gives way to the graph first.
  if (getTabView(tabId).center.kind !== "graph") {
    if (!(await confirmLeaveCenter(tabId))) return false;
    useAppStore.getState().closeCenter(tabId);
    // The statistics only close through their own button.
    if (getTabView(tabId).center.kind !== "graph") {
      toast({ tone: "info", title: t("commitGraph.edit.statsOpen") });
      return false;
    }
  }
  if (graphEditOf(tabId)) return true;
  const edit: GraphEdit = { repoId, from, plan, state: editStart(plan.rows), drag: options.drag ?? null, updateRefs: false };
  useGraphEdit.setState(({ byTab }) => ({ byTab: { ...byTab, [tabId]: edit } }));
  guards.set(tabId, guardFor(tabId));
  return true;
}

/**
 * Puts the edit's guard into the store's centre slot while the graph shows the edit; returns the
 * unregister. Another view in the centre takes the slot over, so the graph registers again each time it shows.
 */
export function registerEditGuard(tabId: Id): () => void {
  const guard = guards.get(tabId);
  if (!guard) return () => undefined;
  setCenterGuard(tabId, guard);
  return () => setCenterGuard(tabId, null, guard);
}

export function leaveGraphEdit(tabId: Id, notice?: "stale"): void {
  if (!graphEditOf(tabId)) return;
  useGraphEdit.setState(({ byTab }) => {
    const { [tabId]: _left, ...rest } = byTab;
    return { byTab: rest };
  });
  const guard = guards.get(tabId);
  guards.delete(tabId);
  if (guard) setCenterGuard(tabId, null, guard);
  if (notice === "stale") toast({ tone: "info", title: t("commitGraph.edit.ended") });
}

/** Whether any tab has unapplied history edits – also tabs whose graph is not mounted (and so not guarding the centre). */
export function hasDirtyGraphEdit(): boolean {
  return Object.keys(useGraphEdit.getState().byTab).some((tabId) => guardFor(tabId).dirty());
}

/** Ends every edit (after the user agreed to lose them, e.g. on a profile switch). */
export function leaveAllGraphEdits(): void {
  for (const tabId of Object.keys(useGraphEdit.getState().byTab)) leaveGraphEdit(tabId);
}

/** Asks when the edit has changes; true = left (or nothing to lose). */
export async function confirmLeaveGraphEdit(tabId: Id): Promise<boolean> {
  const guard = guards.get(tabId) ?? guardFor(tabId);
  if (guard.dirty() && !(await guard.confirmLeave())) return false;
  leaveGraphEdit(tabId);
  return true;
}
