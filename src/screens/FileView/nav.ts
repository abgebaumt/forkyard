/**
 * “Back” for file view, history and blame.
 *
 * The store only knows the current middle. So that “Close” from a version that was opened via
 * the history lands in the history again (and not in the graph), this module remembers per tab
 * where each of these three views came from. For that it listens to the store – no matter who
 * switches the middle (diff view, menus, commands, these screens).
 *
 * Rules:
 * - Switching INTO one of the three views from another middle (diff, history, blame, file):
 *   the previous middle goes onto the stack.
 * - Switching to the graph or to an unrelated view (conflict, rebase …): clear the stack.
 * - Only the mode of the file view changes (view ↔ edit): remember nothing.
 */
import { useSyncExternalStore } from "react";
import type { Id } from "../../core";
import { useAppStore, type CenterView } from "../../app/store";
import { t } from "../../i18n";

const OWN = new Set<CenterView["kind"]>(["file", "history", "blame"]);
const MAX_DEPTH = 20;

const stacks = new Map<Id, CenterView[]>();
const listeners = new Set<() => void>();
let restoring = false;
let version = 0;

const emit = () => {
  version++;
  listeners.forEach((listener) => listener());
};

const samePlace = (a: CenterView, b: CenterView) => a.kind === "file" && b.kind === "file" && a.path === b.path && a.sha === b.sha;

useAppStore.subscribe((state, prev) => {
  let changed = false;
  for (const tabId of Array.from(stacks.keys())) {
    if (!(tabId in state.views)) {
      stacks.delete(tabId);
      changed = true;
    }
  }
  for (const [tabId, view] of Object.entries(state.views)) {
    const before = prev.views[tabId]?.center;
    const after = view.center;
    if (!before || before === after || restoring) continue;
    if (!OWN.has(after.kind) || before.kind === "graph") {
      if (stacks.delete(tabId)) changed = true;
      continue;
    }
    if (samePlace(before, after)) continue;
    const stack = stacks.get(tabId) ?? [];
    stack.push(before);
    if (stack.length > MAX_DEPTH) stack.shift();
    stacks.set(tabId, stack);
    changed = true;
  }
  if (changed) emit();
});

/** Where “Back” leads; null = to the graph. */
export function backTarget(tabId: Id): CenterView | null {
  const stack = stacks.get(tabId);
  return stack?.[stack.length - 1] ?? null;
}

/** Back to the previous view, otherwise to the graph. */
export function goBack(tabId: Id): void {
  const stack = stacks.get(tabId);
  const target = stack?.pop() ?? null;
  const store = useAppStore.getState();
  if (!target) {
    stacks.delete(tabId);
    store.closeCenter(tabId);
    emit();
    return;
  }
  restoring = true;
  try {
    store.setCenter(tabId, target);
  } finally {
    restoring = false;
  }
  emit();
}

/** Label of the back button to the previous view. */
export function backLabel(target: CenterView | null): string {
  switch (target?.kind) {
    case "diff":
      return t("fileView.back.diff");
    case "history":
      return t("fileView.back.history");
    case "blame":
      return t("fileView.back.blame");
    case "file":
      return t("fileView.back.file");
    default:
      return t("fileView.back.graph");
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current target of “Back” for a tab, as a hook. */
export function useBackTarget(tabId: Id): CenterView | null {
  useSyncExternalStore(subscribe, () => version);
  return backTarget(tabId);
}

/** Shows a commit in the graph: close the middle, select the commit and scroll to it. */
export function showInGraph(tabId: Id, sha: string | null): void {
  const store = useAppStore.getState();
  stacks.delete(tabId);
  store.closeCenter(tabId);
  if (sha) store.revealCommit(tabId, sha);
  else store.selectWip(tabId);
  store.setRightCollapsed(tabId, false);
  emit();
}
