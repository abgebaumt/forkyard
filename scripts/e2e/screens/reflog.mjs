/**
 * Reflog in the real app against a real repository: open from the palette, the list against Git's
 * own reflog, keyboard selection shows the commit in the details, a commit that no branch reaches
 * any more is brought back with "Create branch here", the branch filter, Esc back to the graph,
 * light and dark.
 *
 *   node scripts/e2e/screens/reflog.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/reflog.mjs --only branch    only sections whose title contains "branch"
 *   node scripts/e2e/screens/reflog.mjs --show           visible window
 */
import { launchApp } from "../driver.mjs";
import { makeRichRepo } from "../fixtures.mjs";
import { createRun } from "./mustfix-lib.mjs";
import { sideHelpers } from "./submodules-lib.mjs";

const show = process.argv.includes("--show");
const t = createRun("reflog");
const { check, equal, eventually, section, waitDialog } = t;

// A commit that only the reflog still knows: committed, then reset away.
const fx = makeRichRepo({ dirty: false, name: "reflog-demo" });
const branch = fx.git("symbolic-ref", "--short", "HEAD").trim();
fx.write("notiz.txt", "Nur noch im Reflog\n");
fx.git("add", "notiz.txt");
fx.git("commit", "-q", "-m", "Notiz, die verloren geht");
const lost = fx.git("rev-parse", "HEAD").trim();
fx.git("reset", "-q", "--hard", "HEAD~1");
const head = fx.git("rev-parse", "HEAD").trim();

let app = null;
try {
  app = await launchApp({ show });
  t.attach(app);
  const { page } = app;
  const h = sideHelpers(app);
  const { tabId, repoId } = await app.openRepo(fx.path);
  const view = () => page.locator('[data-screen="reflog"]');
  const list = () => view().locator("[data-reflog-list]");
  const options = () =>
    list()
      .locator('[role="option"]')
      .evaluateAll((rows) => rows.map((row) => ({ index: Number(row.dataset.index), sha: row.dataset.sha, action: row.dataset.reflogAction, exists: row.dataset.exists === "true", selected: row.getAttribute("aria-selected") === "true" })));
  const selectedShas = () => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.selection?.shas ?? null, tabId);

  // -------------------------------------------------------------------------------------------
  await section("Open from the palette, entries as Git has them", async () => {
    await h.palette("Show reflog");
    await eventually(() => view().count(), 1, "the reflog is open");
    await eventually(async () => (await options()).length > 0, true, "entries are listed");
    const rows = await options();
    const gitShas = fx.git("reflog", "--format=%H", "-n", String(rows.length)).trim().split("\n");
    equal(rows.map((row) => row.sha), gitShas.slice(0, rows.length), "newest first, as git reflog");
    equal(rows[0]?.action, "reset", "the newest entry is the reset");
    check(rows.some((row) => row.sha === lost && row.action === "commit"), "the reset-away commit is listed");
    equal(await page.evaluate(() => Boolean(document.activeElement?.closest("[data-reflog-list]"))), true, "the list has the focus");
    await t.shot("reflog");
  });

  // -------------------------------------------------------------------------------------------
  await section("Keyboard: arrows select, Enter shows the commit in the details", async () => {
    const rows = await options();
    const target = rows.find((row) => row.sha === lost);
    for (let step = 0; step < target.index; step++) await page.keyboard.press("ArrowDown");
    await eventually(async () => (await options()).find((row) => row.selected)?.sha, lost, "ArrowDown reaches the lost commit");
    await eventually(selectedShas, [lost], "the commit panel shows it");
    await page.keyboard.press("Enter");
    await eventually(() => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.rightPanel ?? null, tabId), "details", "Enter opens the details");
    await page.keyboard.press("Home");
    await eventually(selectedShas, [head], "Home: back to the newest entry");
  });

  // -------------------------------------------------------------------------------------------
  await section("Create branch here brings the lost commit back", async () => {
    const row = list().locator(`[role="option"][data-sha="${lost}"]`).first();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Create branch here/ }).click();
    const dialog = await waitDialog(/^New branch$/);
    await dialog.getByLabel("Name").fill("gerettet");
    await dialog.getByRole("button", { name: "Create branch" }).click();
    await t.waitToast(/Branch “gerettet” created/);
    equal(fx.git("rev-parse", "gerettet").trim(), lost, "the branch points at the lost commit");
    equal(fx.git("symbolic-ref", "--short", "HEAD").trim(), "gerettet", "and is checked out");
    await eventually(async () => (await options())[0]?.action, "checkout", "the checkout is the newest entry now");
  });

  // -------------------------------------------------------------------------------------------
  await section("Branch filter shows the reflog of one branch", async () => {
    await view().getByRole("combobox", { name: "Show the reflog of" }).click();
    await page.getByRole("option", { name: branch, exact: true }).click();
    const gitShas = fx.git("reflog", "--format=%H", branch).trim().split("\n");
    await eventually(async () => (await options()).map((row) => row.sha), gitShas.slice(0, (await options()).length), `the entries of ${branch}`);
    await app.setTheme("dark");
    await t.shot("reflog-dark");
    await app.setTheme("light");
  });

  // -------------------------------------------------------------------------------------------
  await section("Esc goes back to the graph", async () => {
    await list().focus();
    await page.keyboard.press("Escape");
    await eventually(() => view().count(), 0, "the reflog is closed");
    await eventually(() => page.locator('[data-screen="commit-graph"]').count(), 1, "the graph is back");
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
