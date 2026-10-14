/**
 * Statistics in the real app against a real repository with several authors: open via the
 * toolbar and the palette, the computation as a job, heatmap and authors against the core's
 * own numbers, treemap drill-down, a hotspot opens the file history and Esc leads back, a short
 * period, light and dark.
 *
 *   node scripts/e2e/screens/stats.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/stats.mjs --only treemap   only sections whose title contains "treemap"
 *   node scripts/e2e/screens/stats.mjs --show           visible window
 */
import { launchApp } from "../driver.mjs";
import { makeRichRepo } from "../fixtures.mjs";
import { createRun } from "./mustfix-lib.mjs";
import { sideHelpers } from "./submodules-lib.mjs";

const show = process.argv.includes("--show");
const t = createRun("stats");
const { check, equal, eventually, section } = t;

const fx = makeRichRepo({ dirty: false, name: "statistik-demo" });
const DAY_MS = 86_400_000;
const midnightDaysAgo = (days) => new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - days * DAY_MS).toISOString();

let app = null;
try {
  app = await launchApp({ show });
  t.attach(app);
  const { page } = app;
  const h = sideHelpers(app);
  const { repoId } = await app.openRepo(fx.path);
  const view = () => page.locator('[data-screen="stats"]');
  const state = () => view().getAttribute("data-stats");
  const compute = (range) => app.invoke("stats_compute", { repoId, jobId: `e2e-${Date.now()}`, range });

  // -------------------------------------------------------------------------------------------
  await section("Open from the toolbar, computed as a job", async () => {
    await t.toolButton("Statistics").click();
    await eventually(state, "ready", "the statistics are computed");
    const stats = await compute({ from: null, to: null, ref: "HEAD" });
    check(stats.cached, "the view's run filled the cache (the same range comes from it)");
    check(stats.commits > 0 && stats.authorCount > 1, `the fixture has history from several authors (${stats.commits} commits, ${stats.authorCount} authors)`);
    equal(await view().locator("[data-stats-heatmap] [data-cell]").count(), 168, "heatmap: 7 × 24 cells");
    equal(await view().locator("[data-stats-authors] [data-author]").count(), Math.min(stats.authors.length, 200), "one row per author");
    const firstAuthor = await view().locator("[data-stats-authors] [data-author]").first().getAttribute("data-author");
    equal(firstAuthor, stats.authors[0].email, "the most active author comes first");
    equal(await view().locator("[data-stats-hotspots] [data-hotspot]").count(), stats.hotspots.length, "one row per hotspot");
    check(/\d/.test(await view().locator("[data-stats-summary]").innerText()), "summary with numbers");
    equal(await page.locator('[data-toast="danger"]').count(), 0, "no error toast");
    await t.shot("stats");
  });

  // -------------------------------------------------------------------------------------------
  await section("Treemap: folder opens in place, Up goes back", async () => {
    const folder = view().locator('[data-stats-treemap] [data-kind="folder"]').first();
    if ((await folder.count()) === 0) {
      check(false, "the fixture has folders");
      return;
    }
    const path = await folder.getAttribute("data-tile");
    await folder.focus();
    await page.keyboard.press("Enter");
    await eventually(() => view().locator("[data-stats-folder]").getAttribute("data-stats-folder"), path, "Enter on a folder tile opens it");
    await view().getByRole("button", { name: /^Up to / }).click();
    await eventually(() => view().locator("[data-stats-folder]").getAttribute("data-stats-folder"), "", "Up returns to the repository");
  });

  // -------------------------------------------------------------------------------------------
  await section("A hotspot opens the file history, Esc comes back", async () => {
    const hotspot = view().locator("[data-hotspot]").first();
    const path = await hotspot.getAttribute("data-hotspot");
    await hotspot.click();
    await eventually(() => page.getByLabel(`History of ${path}`).count(), 1, "the file history of the hotspot is open");
    await page.keyboard.press("Escape");
    await eventually(() => view().count(), 1, "Esc: back to the statistics");
    await eventually(state, "ready", "the statistics are there again (from the cache)");
    await page.keyboard.press("Escape");
    await eventually(() => view().count(), 0, "Esc again: back to the graph");
  });

  // -------------------------------------------------------------------------------------------
  await section("Palette, short period and dark theme", async () => {
    await h.palette("Show statistics");
    await eventually(state, "ready", "opened from the palette");
    // The core's own numbers first, then wait until the view shows exactly them – "ready" alone
    // could still be the all-time result from before the click.
    const recent = await compute({ from: midnightDaysAgo(30), to: null, ref: "HEAD" });
    await view().getByRole("radio", { name: "30 days" }).click();
    if (recent.commits === 0) {
      await eventually(async () => /No commits in this period/.test(await view().innerText()), true, "empty period: the view says so");
    } else {
      await eventually(
        async () => (await state()) === "ready" && (await view().locator("[data-stats-authors] [data-author]").count()) === recent.authors.length,
        true,
        "authors of the short period",
      );
    }
    await app.setTheme("dark");
    const all = await compute({ from: null, to: null, ref: "HEAD" });
    await view().getByRole("radio", { name: "All time" }).click();
    await eventually(
      async () => (await state()) === "ready" && (await view().locator("[data-stats-authors] [data-author]").count()) === all.authors.length,
      true,
      "all time again",
    );
    await t.shot("stats-dark");
    await app.setTheme("light");
  });

  equal(app.consoleErrors, [], "console errors");
} catch (error) {
  t.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (app) await app.close().catch(() => undefined);
  fx.cleanup();
}
t.finish();
