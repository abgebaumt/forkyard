/**
 * Tabs between windows: tear out into a new window, move into another one, take over arriving tabs.
 * The view state travels through the core (`tabHandoffPut` here, `tabHandoffTake` in the target).
 */
import { core, type Id, type ScreenPoint, type Tab } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { saveDraftNow } from "../../screens/WipPanel/draft";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { confirmLeaveCenter, useAppStore } from "../store";
import { dropTarget } from "../windows/dropTarget";
import { applyHandoff, buildHandoff, parseHandoff, serializeHandoff } from "../windows/handoff";
import { indexWithout } from "../shell/tabDrag";
import { discardAfterLeaving, moveTab, settleUnsaved } from "./repos";

const tabsHere = () => queryClient.getQueryData<Tab[]>(qk.tabs) ?? [];

export async function newWindow(): Promise<void> {
  await runAction(t("windows.menu.newWindow"), () => core.windowNew());
}

/**
 * Moves the tab with its view state: asks about unsaved work, hands the view over, runs `move`.
 * If anything fails after the terminals were released, they come back here.
 */
async function moveOut(tabId: Id, move: () => Promise<unknown>): Promise<boolean> {
  if (!(await confirmLeaveCenter(tabId))) return false;
  const repoId = tabsHere().find((tab) => tab.id === tabId)?.repoId ?? null;
  const settled = await settleUnsaved(repoId);
  if (!settled) return false;
  // The target reads the commit message from the core: it must be there before the tab leaves.
  if (repoId && !(await runAction(t("windows.moveFailed"), () => saveDraftNow(repoId))).ok) return false;
  const handoff = buildHandoff(tabId);
  const result = await runAction(t("windows.moveFailed"), async () => {
    const terminalIds = handoff.terminals.map((terminal) => terminal.terminalId);
    await core.tabHandoffPut({ tabId, handoff: serializeHandoff(handoff), terminalIds });
    return move();
  });
  if (!result.ok) {
    // The tab is still here: its terminals (already released) and view come back; a stored hand-over goes.
    applyHandoff(tabId, repoId, handoff);
    void core.tabHandoffTake({ tabId }).catch(() => null);
    return false;
  }
  useAppStore.getState().dropTabView(tabId);
  if (repoId && settled.discard) discardAfterLeaving(repoId);
  toast({ tone: "success", title: t("windows.moved") });
  return true;
}

export async function moveTabToNewWindow(tabId: Id, at: ScreenPoint | null): Promise<void> {
  if (tabsHere().length < 2) {
    toast({ tone: "info", title: t("windows.onlyTab") });
    return;
  }
  const moved = await moveOut(tabId, () => core.tabMoveToNewWindow({ tabId, at }));
  if (moved) await queryClient.invalidateQueries({ queryKey: qk.tabs });
}

/** As the window's only tab it moves too; the emptied window then closes. */
export async function moveTabToWindow(tabId: Id, window: string, position: number): Promise<void> {
  await moveOut(tabId, async () => queryClient.setQueryData(qk.tabs, await core.tabMoveToWindow({ tabId, window, position })));
}

/**
 * A tab let go outside its strip at `point` (screen, logical). `insideSelf`: the point lies inside
 * this window. Without known window positions (Wayland) outside always means a new window.
 */
export async function dropTab(tabId: Id, point: ScreenPoint, insideSelf: boolean): Promise<void> {
  const layout = await core.windowLayout().catch(() => null);
  if (!layout) {
    if (!insideSelf) await moveTabToNewWindow(tabId, null);
    return;
  }
  // The cursor as the binding sees it is the more reliable one (logical pixels on its monitor).
  const at = layout.cursor ?? point;
  const target = dropTarget(layout, at, core.windowLabel(), insideSelf);
  switch (target.kind) {
    case "reorder": {
      // `index` counts the dragged tab's own middle; `moveTab` counts without it.
      const from = tabsHere()
        .slice()
        .sort((a, b) => a.position - b.position)
        .findIndex((tab) => tab.id === tabId);
      const to = indexWithout(target.index, from);
      if (from >= 0 && to !== from) await moveTab(tabId, to);
      return;
    }
    case "move":
      return moveTabToWindow(tabId, target.window, target.index);
    case "new":
      return moveTabToNewWindow(tabId, layout.positionsKnown ? target.at : null);
    case "none":
      return;
  }
}

/** Tab ids this window has already seen; a new one may bring a hand-over. */
let seen: Set<Id> | null = null;

/**
 * After this window's tab list changed: tabs that arrived from another window get their view state
 * and terminals. Only once `qk.tabs` holds the tab with that repository, otherwise the terminal
 * bookkeeping would end the adopted sessions again.
 */
export async function adoptArrivedTabs(tabs: Tab[]): Promise<void> {
  const fresh = tabs.filter((tab) => !seen?.has(tab.id));
  seen = new Set(tabs.map((tab) => tab.id));
  await Promise.all(
    fresh.map(async (tab) => {
      const text = await core.tabHandoffTake({ tabId: tab.id }).catch(() => null);
      const handoff = text === null ? null : parseHandoff(text);
      if (!handoff) return;
      // Gone again before it was taken: without a repository `applyHandoff` ends the terminals.
      applyHandoff(tab.id, tabsHere().find((item) => item.id === tab.id)?.repoId ?? null, handoff);
    }),
  );
}
