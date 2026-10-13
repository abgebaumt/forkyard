/**
 * Scenarios for the README images (scripts/screenshots/shoot.mjs). They work on the demo
 * repository from scripts/screenshots/demo-repo.mjs (`?fixture=<path>`).
 * Usage: `?scenario=Showcase.graph`, `.diff`, `.conflict`, `.rebase`, `.settings`, `.tour` (for the GIF).
 */
import type { Scenario, ScenarioContext } from "../scenarios";

async function open(ctx: ScenarioContext) {
  const opened = await ctx.repo();
  await ctx.waitFor(() => document.querySelector("canvas") !== null, 15_000);
  return opened;
}

async function shaOf(ctx: ScenarioContext, repoId: string, subject: string) {
  const page = await ctx.core.graphPage({ repoId, cursor: null, limit: 200 });
  const row = page.rows.find((item) => (item.kind === "commit" || item.kind === "merge") && item.summary === subject);
  if (!row?.sha) throw new Error(`Commit "${subject}" not found.`);
  return row.sha;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const scenarios: Record<string, Scenario> = {
  /** Graph with a selected merge commit and the details on the right. */
  async graph(ctx) {
    const { repoId, tabId } = await open(ctx);
    ctx.store.getState().revealCommit(tabId, await shaOf(ctx, repoId, "Merge branch 'feature/hourly-chart'"));
  },

  /** Diff of a changed file, the commit panel next to it. */
  async diff(ctx) {
    const { tabId } = await open(ctx);
    ctx.store.getState().selectWip(tabId);
    ctx.store.getState().openDiff(tabId, "src/forecast.ts", { kind: "unstaged" });
  },

  /** Conflict tool in the middle of a merge (demo repo with `--conflict`). */
  async conflict(ctx) {
    const { tabId } = await open(ctx);
    ctx.store.getState().openConflict(tabId, "src/forecast.ts");
  },

  /** Interactive rebase of feature/alerts onto main (demo repo with `--rebase`). */
  async rebase(ctx) {
    const { tabId } = await open(ctx);
    ctx.store.getState().openRebase(tabId, "main", "interactive");
  },

  /** Settings, project section. */
  async settings(ctx) {
    await open(ctx);
    ctx.store.getState().openOverlay({ kind: "preferences", section: "repo" });
  },

  /** Tour for the GIF: look at commits, diff, command palette, settings. Starts after `?delay=` ms. */
  async tour(ctx) {
    const { repoId, tabId } = await open(ctx);
    const store = ctx.store.getState();
    await pause(Number(ctx.params.get("delay") ?? 0) + 1500);
    for (const subject of ["Merge branch 'feature/hourly-chart'", "Chart: show precipitation as second row", "Add storm alert thresholds"]) {
      store.revealCommit(tabId, await shaOf(ctx, repoId, subject));
      await pause(1300);
    }
    store.selectWip(tabId);
    await pause(900);
    store.openDiff(tabId, "src/forecast.ts", { kind: "unstaged" });
    await pause(2600);
    store.closeCenter(tabId);
    store.openOverlay({ kind: "palette", mode: "all" });
    await pause(2400);
    store.closeOverlay();
    await pause(600);
    store.openOverlay({ kind: "preferences", section: "repo" });
    await pause(2600);
    store.closeOverlay();
  },
};
