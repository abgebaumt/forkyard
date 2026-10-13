import type { Scenario } from "../scenarios";
import { qk } from "../../app/queries";

/** Scenarios for repo-management. Usage: `?scenario=repo-management.manage` etc. */
export const scenarios: Record<string, Scenario> = {
  /** Open the management tab (or activate an existing one). */
  async manage(ctx) {
    const tabs = await ctx.core.tabsList();
    const existing = tabs.find((tab) => tab.kind === "management");
    const next = existing ? await ctx.core.tabActivate({ tabId: existing.id }) : await ctx.core.tabOpen({ repoId: null });
    ctx.queryClient.setQueryData(qk.tabs, next);
    await ctx.waitFor(() => document.querySelector('[data-screen="repo-management"]') !== null);
  },

  /** Management with the clone dialog open. */
  async clone(ctx) {
    await scenarios.manage!(ctx);
    ctx.store.getState().openOverlay({ kind: "clone" });
    await ctx.waitFor(() => document.querySelector('[data-screen="clone"]') !== null);
  },
};
