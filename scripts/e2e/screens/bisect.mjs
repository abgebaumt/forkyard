/**
 * Bisect in the real app against a real repository: start from the commit menu (bad = the clicked
 * commit, good = a tag picked in the list), mark Good/Bad from the bar and from the palette until the
 * first bad commit is found, the marks in the graph, End returns to the branch, light and dark.
 *
 *   node scripts/e2e/screens/bisect.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/bisect.mjs --only mark      only sections whose title contains "mark"
 *   node scripts/e2e/screens/bisect.mjs --show           visible window
 */
import { launchApp } from "../driver.mjs";
import { makeEmptyRepo } from "../fixtures.mjs";
import { createRun } from "./mustfix-lib.mjs";
import { sideHelpers } from "./submodules-lib.mjs";

const show = process.argv.includes("--show");
const t = createRun("bisect");
const { check, equal, eventually, section, waitDialog } = t;
const GRAPH = '[data-screen="commit-graph"]';

// Nine commits on main; the sixth breaks the measurement. Tag `gut` on the first.
const fx = makeEmptyRepo({ name: "bisect-demo", withFile: false });
const shas = [];
for (let n = 1; n <= 9; n++) {
  fx.write("messung.txt", n >= 6 ? `Messung ${n}: kaputt\n` : `Messung ${n}: in Ordnung\n`);
  fx.git("add", "messung.txt");
  fx.git("commit", "-q", "-m", `Messung ${n}`);
  shas.push(fx.git("rev-parse", "HEAD").trim());
}
fx.git("tag", "gut", shas[0]);
const firstBad = shas[5];
const isBroken = (sha) => fx.git("show", `${sha}:messung.txt`).includes("kaputt");

let app = null;
try {
  app = await launchApp({ show });
  t.attach(app);
  const { page } = app;
  const h = sideHelpers(app);
  const { tabId, repoId } = await app.openRepo(fx.path);
  const status = () => app.invoke("bisect_status", { repoId });
  const bar = () => page.locator("[data-graph-bisect]");
  const barKind = () => bar().getAttribute("data-graph-bisect").catch(() => null);
  /** The graph row of `sha` (from the graph query, which knows the row ids). */
  const rowOf = async (sha) => {
    const id = await page.evaluate(
      ([repo, wanted]) => {
        const data = window.__gc.queryClient.getQueryData(["repo", repo, "graph"]);
        for (const graphPage of data?.pages ?? []) for (const row of graphPage.rows) if (row.sha === wanted) return row.id;
        return null;
      },
      [repoId, sha],
    );
    return page.locator(`${GRAPH} [data-row-id="${id}"]`);
  };
  await page.waitForSelector(`${GRAPH} [data-row-kind="commit"]`, { state: "attached", timeout: 60_000 });

  // -------------------------------------------------------------------------------------------
  await section("Start from the commit menu with a tag as the good commit", async () => {
    const head = await rowOf(shas[8]);
    await head.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Start bisect/ }).click();
    const dialog = await waitDialog(/^Start bisect$/);
    await dialog.getByRole("option", { name: /^gut/ }).click();
    await dialog.getByRole("button", { name: "Start bisect" }).click();
    await eventually(barKind, "running", "the bar shows the running bisect");
    const started = await status();
    check(started.active && started.bad === shas[8] && started.good.includes(shas[0]), `bad = HEAD, good = gut (${JSON.stringify(started)})`);
    check(started.current && !shas.slice(0, 1).concat(shas[8]).includes(started.current), "Git checked out a commit in between");
    check(/Step \d+ of ~\d+ · testing [0-9a-f]{7}/.test(await bar().innerText()), "the bar names the step and the commit under test");
    await eventually(() => page.locator(`${GRAPH} [data-bisect="bad"]`).count(), 1, "the graph marks the bad commit");
    await t.shot("bisect-running");
  });

  // -------------------------------------------------------------------------------------------
  await section("Mark from the bar and the palette until the first bad commit is found", async () => {
    let usePalette = false;
    for (let round = 0; round < 8; round++) {
      const before = await status();
      if (before.result || !before.active) break;
      const verdict = isBroken(before.current) ? "bad" : "good";
      if (usePalette) await h.palette(verdict === "good" ? "Bisect: mark the commit under test as good" : "Bisect: mark the commit under test as bad");
      else await bar().locator(`[data-bisect-verdict="${verdict}"]`).click();
      usePalette = !usePalette;
      await eventually(async () => {
        const after = await status();
        return after.stepsDone > before.stepsDone || Boolean(after.result);
      }, true, `round ${round + 1}: the mark arrived`);
      const marked = await status();
      const ref = verdict === "bad" ? marked.bad : marked.good;
      check(verdict === "bad" ? ref === before.current : marked.good.includes(before.current), `round ${round + 1}: ${verdict} applies to the commit the bar showed`);
    }
    const done = await status();
    equal(done.result, firstBad, "the first bad commit");
    await eventually(barKind, "found", "the bar shows the result");
    check((await bar().innerText()).includes(firstBad.slice(0, 7)), "the bar names the result");
    await bar().getByRole("button", { name: "Show details" }).click();
    await eventually(() => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.selection?.shas ?? null, tabId), [firstBad], "Show details selects the result");
    await t.shot("bisect-found");
    await app.setTheme("dark");
    await t.shot("bisect-found-dark");
    await app.setTheme("light");
  });

  // -------------------------------------------------------------------------------------------
  await section("End returns to the branch", async () => {
    await bar().getByRole("button", { name: "End bisect" }).click();
    await eventually(() => bar().count(), 0, "the bar is gone");
    equal((await status()).active, false, "no bisect any more");
    equal(fx.git("symbolic-ref", "--short", "HEAD").trim(), "main", "back on main");
    equal(fx.git("rev-parse", "HEAD").trim(), shas[8], "at the tip again");
    equal(await page.locator(`${GRAPH} [data-bisect]`).count(), 0, "no marks left in the graph");
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
