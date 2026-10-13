/**
 * repo-management – groups as local workspaces: assign repositories to a group, "Fetch all" and
 * "Pull all" with progress and result per repository, rename and dissolve a group.
 * In the real app against real repositories with real remotes; also cross-checked with git.
 *
 *   node scripts/e2e/screens/repo-groups.mjs [--show] [--no-shots] [--only <part>]
 *
 * The "keyboard only" sections need no mouse.
 * Screenshots: target/e2e/shots/repo-groups-*.png
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { tamper } from "./commit-panel-lib.mjs";
import { createRun, sleep } from "./mustfix-lib.mjs";
import { addRepo, makeWorkspace, showManagement } from "./repo-entry-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("repo-groups", { argv });
const { check, equal, eventually, section, waitDialog, waitToast, shot } = t;

const ws = makeWorkspace("gruppen");
const cleanups = [() => ws.cleanup()];
const made = (repo) => {
  cleanups.push(() => repo.cleanup());
  return repo;
};

// Seven repositories, each in its own situation.
const nord = made(makeCleanRepoWithRemote({ name: "station-nord" })); // gets new commits from the remote
const sued = made(makeCleanRepoWithRemote({ name: "station-sued" })); // nothing new
const hafen = made(makeCleanRepoWithRemote({ name: "station-hafen" })); // remote unreachable
const west = made(makeCleanRepoWithRemote({ name: "station-west" })); // uncommitted changes in the way
const ost = made(makeCleanRepoWithRemote({ name: "station-ost" })); // pull ends in a conflict
const archiv = ws.repo("archiv-ohne-remote"); // no remote
const verzogen = ws.repo("verzogen"); // folder disappears later
const all = [nord, sued, hafen, west, ost];

let app = null;
let page = null;
const ids = {};

const press = async (key) => {
  await page.keyboard.press(key);
  await sleep(40);
};
const repoList = () => app.invoke("repo_list");
const groupOf = async (id) => (await repoList()).find((repo) => repo.id === id)?.groupName ?? null;
const listRow = (id) => page.locator(`[data-repo-scroll] [data-repo-id="${id}"]`);
const syncDialog = () => page.locator("[data-group-sync]");
/** Rows of the group dialog: name → { status, text }. */
const syncRows = () =>
  page.locator("[data-group-sync] li").evaluateAll((list) =>
    Object.fromEntries(
      list.map((item) => {
        const [name, text] = [...item.querySelectorAll(":scope > span:nth-child(2) > span")].map((part) => part.textContent.trim());
        return [name, { status: item.getAttribute("data-status"), text }];
      }),
    ),
  );
const summary = () => page.locator("[data-group-sync-summary]").innerText();
const finished = () => eventually(() => syncDialog().getAttribute("data-running"), null, "the run is over", 120_000);
const closeSync = async () => {
  await page.locator("[data-group-sync-close]").click();
  await eventually(() => syncDialog().count(), 0, "the dialog is closed");
};
/** In the open menu, arrow down to the item whose text starts like this. */
const menuTo = async (label) => {
  for (let step = 0; step < 30; step++) {
    const highlighted = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"][data-highlighted]')].at(-1)?.textContent?.trim() ?? null);
    if (highlighted?.startsWith(label)) return true;
    await press("ArrowDown");
  }
  return check(false, `menu item '${label}' not reached with the arrow keys`);
};
const focusRow = async (id) => {
  // Tab into the list, then arrow keys to the row.
  for (let step = 0; step < 30 && !(await page.evaluate(() => document.activeElement?.getAttribute("role") === "option")); step++) await press("Tab");
  await press("Home");
  for (let step = 0; step < 20 && (await page.evaluate(() => document.activeElement?.getAttribute("data-repo-id"))) !== id; step++) await press("ArrowDown");
  return equal(await page.evaluate(() => document.activeElement?.getAttribute("data-repo-id")), id, "the arrow keys reach the row");
};

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  page = app.page;
  t.attach(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  for (const [key, repoPath] of Object.entries({ nord: nord.path, sued: sued.path, hafen: hafen.path, west: west.path, ost: ost.path, archiv, verzogen })) {
    ids[key] = (await addRepo(app, repoPath)).id;
  }
  await showManagement(app);
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
  await app.settle();

  // -------------------------------------------------------------------------
  await section("Create a group and assign repositories – keyboard only", async () => {
    await focusRow(ids.nord);
    await press("Shift+F10");
    await page.getByRole("menu").waitFor();
    await menuTo("Assign group");
    await press("Enter");
    const dialog = await waitDialog(/^Group for “station-nord”$/);
    equal(await page.evaluate(() => document.activeElement?.tagName), "INPUT", "focus is in the name field");
    await page.keyboard.type("Messnetz");
    await shot("repo-groups-zuweisen");
    await press("Enter");
    await eventually(() => groupOf(ids.nord), "Messnetz", "the group is in the core (repo_list)");
    void dialog;
    // The others join (as through the same menu; shortened here via the core).
    for (const key of ["sued", "hafen", "west", "ost", "archiv", "verzogen"]) await app.invoke("repo_update", { repoId: ids[key], groupName: "Messnetz" });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
    await app.settle();

    // Arrangement "Groups": toggle by keyboard.
    await page.getByRole("radiogroup", { name: "List arrangement" }).or(page.getByRole("group", { name: "List arrangement" })).first().waitFor();
    for (let step = 0; step < 30 && !(await page.evaluate(() => Boolean(document.activeElement?.closest('[aria-label="List arrangement"]')))); step++) await press("Shift+Tab");
    await press("ArrowRight");
    await eventually(() => page.locator("[data-repo-section]").evaluateAll((list) => list.map((item) => item.textContent)), ["Messnetz7"], "the list shows the group with its seven repositories");
    const actions = page.locator('[data-group-actions="Messnetz"] button');
    equal(await actions.evaluateAll((list) => list.map((button) => button.getAttribute("aria-label"))), ["Fetch group “Messnetz”", "Pull group “Messnetz”", "More actions for group “Messnetz”"], "the heading carries the group actions, with names");
    equal(await actions.evaluateAll((list) => list.map((button) => button.tabIndex)), [-1, -1, -1], "no own tab stops – the list keeps exactly one");
    await shot("repo-groups");
  });

  // -------------------------------------------------------------------------
  await section("Fetch all – keyboard only: progress per repository, result and reason per row", async () => {
    // Set up: nord gets a commit, hafen is unreachable, verzogen disappears.
    const nordRemote = nord.commitOnRemote({ message: "Nord: neuer Sensor", file: "docs/sensor.md" });
    hafen.git("remote", "set-url", "origin", "http://127.0.0.1:9/hafen.git");
    fs.renameSync(verzogen, `${verzogen}-woanders`);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
    await app.settle();
    const heads = Object.fromEntries(all.map((repo) => [repo.path, repo.git("rev-parse", "HEAD")]));

    // The fetch is delayed by 1.5 s in the window so the running state can be seen and checked.
    const slow = await tamper(page, "fetch", { delayMs: 1500 });
    await focusRow(ids.sued);
    await press("Shift+F10");
    await page.getByRole("menu").waitFor();
    await menuTo("Group “Messnetz”");
    await press("ArrowRight");
    await eventually(() => page.getByRole("menu").count(), 2, "the group submenu opens");
    const entries = await page.getByRole("menu").last().locator('[role="menuitem"]').evaluateAll((list) => list.map((item) => item.innerText.replace(/\s+/g, " ").trim()));
    check(entries[0].startsWith("Fetch all 7") && entries[1].startsWith("Pull all 7") && entries.some((text) => text.startsWith("Rename group")) && entries.some((text) => text.startsWith("Dissolve group")), `group entries: ${JSON.stringify(entries)}`);
    await shot("repo-groups-menue");
    await press("Enter");
    await syncDialog().waitFor();
    equal(await page.getByRole("dialog").getByRole("heading").first().innerText(), "Fetch group “Messnetz”", "the dialog names group and operation");
    await eventually(async () => Object.values(await syncRows()).filter((row) => row.status === "running").length, 3, "three repositories run at the same time");
    const during = await syncRows();
    equal(Object.keys(during).length, 7, "one row per repository");
    check(Object.values(during).some((row) => row.status === "waiting" && row.text.includes("waiting")), `the others are waiting: ${JSON.stringify(during)}`);
    equal(await syncDialog().locator('[role="progressbar"]').count(), 3, "running rows show a progress bar");
    check(/of 7 done/.test(await summary()), `the summary counts along: ${await summary()}`);
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "while it runs, focus is on 'Cancel'");
    await shot("repo-groups-holen-laeuft");
    await finished();
    await slow.restore();

    const rows = await syncRows();
    equal(rows["station-nord"], { status: "done", text: "Done: 1 ref updated" }, "nord: fetched new commits");
    equal(rows["station-sued"], { status: "unchanged", text: "Unchanged: Nothing new on the remote." }, "sued: nothing new");
    check(rows["station-hafen"].status === "failed" && /^Failed: origin: .*can’t be reached/.test(rows["station-hafen"].text), `hafen: failure with remote and reason: ${JSON.stringify(rows["station-hafen"])}`);
    equal(rows["archiv-ohne-remote"], { status: "unchanged", text: "Unchanged: No remote set up – skipped." }, "archiv: skipped without remote");
    check(rows["verzogen"].status === "failed" && /Folder not found/.test(rows["verzogen"].text), `verzogen: the folder is missing: ${JSON.stringify(rows["verzogen"])}`);
    equal(await summary(), "1 with new changes · 4 unchanged · 2 failed", "summary at the end");
    equal(nord.git("rev-parse", "origin/main"), nordRemote, "git: origin/main of nord is up to date");
    equal(Object.fromEntries(all.map((repo) => [repo.path, repo.git("rev-parse", "HEAD")])), heads, "git: nothing changed locally anywhere (HEAD everywhere as before)");
    equal(await t.toasts(), [], "no individual toasts – everything is in the dialog");
    await shot("repo-groups-holen");
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Close", "at the end focus is on 'Close'");
    check((await page.getByRole("dialog").getByRole("button", { name: "Retry 2 repositories" }).count()) === 1, "there is a 'Retry' for the failed ones");
    await press("Enter");
    await eventually(() => syncDialog().count(), 0, "Enter closes the dialog");
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Cancel and retry", async () => {
    const slow = await tamper(page, "fetch", { delayMs: 2500 });
    await page.locator('[data-group-actions="Messnetz"]').getByRole("button", { name: "Fetch group “Messnetz”" }).click();
    await syncDialog().waitFor();
    await eventually(async () => Object.values(await syncRows()).filter((row) => row.status === "running").length, 3, "three are running");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await finished();
    await slow.restore();
    const rows = await syncRows();
    const cancelled = Object.values(rows).filter((row) => row.status === "cancelled").length;
    check(cancelled >= 3, `the waiting repositories are cancelled (${cancelled}): ${JSON.stringify(rows)}`);
    check(/cancelled/.test(await summary()), `the summary says so: ${await summary()}`);
    await shot("repo-groups-abgebrochen");
    // Esc closes now (nothing is running) – before, it would only have cancelled.
    const retry = page.getByRole("dialog").getByRole("button", { name: /^Retry / });
    check((await retry.count()) === 1, "'Retry …' takes the cancelled and failed ones");
    await retry.click();
    await finished();
    const after = await syncRows();
    equal(Object.values(after).filter((row) => row.status === "cancelled").length, 0, "after the retry nothing is 'cancelled' anymore");
    equal(after["station-sued"].status, "unchanged", "sued is checked again");
    await closeSync();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Pull all: fast-forward, conflict, changes in the way – errors per row, with 'Open'", async () => {
    // sued gets new commits (fast-forward); west has an uncommitted change to a file the remote changes;
    // ost has its own commit at the same place as the remote (conflict).
    const suedRemote = sued.commitOnRemote({ message: "Süd: Dach erneuert", file: "docs/dach.md" });
    west.commitOnRemote({ message: "West: README ergänzt", file: "README.md", content: "# Messnetz\n\nVom Remote geändert.\n" });
    west.write("README.md", "# Messnetz\n\nLokal geändert, nicht committet.\n");
    ost.commitOnRemote({ message: "Ost: Stationen vom Remote", file: "stationen.csv", content: "kürzel;name;höhe_m\nO;Ost (Remote);12\n" });
    ost.write("stationen.csv", "kürzel;name;höhe_m\nO;Ost (lokal);15\n");
    ost.git("add", "-A");
    ost.git("commit", "-q", "-m", "Ost: Stationen lokal");
    const ostLocal = ost.git("rev-parse", "HEAD");
    const nordRemote = nord.git("rev-parse", "origin/main");

    await page.locator('[data-group-actions="Messnetz"]').getByRole("button", { name: "Pull group “Messnetz”" }).click();
    await syncDialog().waitFor();
    equal(await page.getByRole("dialog").getByRole("heading").first().innerText(), "Pull group “Messnetz”", "dialog for the pull");
    await finished();
    const rows = await syncRows();
    check(rows["station-nord"].status === "done" && rows["station-sued"].status === "done", `nord and sued are updated: ${JSON.stringify([rows["station-nord"], rows["station-sued"]])}`);
    equal(nord.git("rev-parse", "HEAD"), nordRemote, "git: nord is at the remote state");
    equal(sued.git("rev-parse", "HEAD"), suedRemote, "git: sued is at the remote state");
    equal(nord.git("rev-list", "--count", "--merges", "HEAD"), "0", "git: by fast-forward, without a merge commit");
    check(rows["station-west"].status === "failed" && /Uncommitted changes are in the way/.test(rows["station-west"].text), `west: changes in the way, with a way out: ${JSON.stringify(rows["station-west"])}`);
    equal(fs.readFileSync(path.join(west.path, "README.md"), "utf8"), "# Messnetz\n\nLokal geändert, nicht committet.\n", "git: the uncommitted change in west is untouched");
    check(rows["station-ost"].status === "attention" && /Conflict in one file/.test(rows["station-ost"].text), `ost: conflict, explained in the row: ${JSON.stringify(rows["station-ost"])}`);
    check(fs.existsSync(path.join(ost.path, ".git", "MERGE_HEAD")), "git: the merge is in progress in ost (MERGE_HEAD)");
    check(rows["station-hafen"].status === "failed" && /can’t be reached/.test(rows["station-hafen"].text), `hafen: unreachable: ${JSON.stringify(rows["station-hafen"])}`);
    equal(rows["archiv-ohne-remote"].status, "unchanged", "archiv: skipped");
    check(/2 updated/.test(await summary()) && /1 needs you/.test(await summary()) && /3 failed/.test(await summary()), `summary: ${await summary()}`);
    await shot("repo-groups-pullen");
    await app.setTheme("light");
    await shot("repo-groups-pullen-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no overflow");
    const box = await page.getByRole("dialog").boundingBox();
    check(box.y >= 0 && box.y + box.height <= 600, "960×600: the dialog fits completely into the window");
    await shot("repo-groups-pullen-min");
    await app.setSize(1440, 900);

    // "Open" on the conflict row leads to the tab where the conflict is resolved.
    await syncDialog().locator(`li[data-repo-id="${ids.ost}"]`).getByRole("button", { name: "Open" }).click();
    await eventually(() => syncDialog().count(), 0, "the dialog closes");
    await page.getByRole("tab", { name: /^station-ost/, selected: true }).waitFor({ timeout: 30_000 });
    await eventually(async () => (await app.invoke("status_get", { repoId: ids.ost })).conflicted.length, 1, "the ost tab shows the conflict (status_get)");
    // Clean up: abort the merge, back to management.
    await app.invoke("operation_abort", { repoId: ids.ost });
    equal(ost.git("rev-parse", "HEAD"), ostLocal, "git: after aborting, ost is back on its own commit");
    await showManagement(app);
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Many repositories and long names; rename and dissolve a group (with confirmation)", async () => {
    // 30 small repositories without a remote in a second group with a very long name.
    const long = "Auswertungen der Schulstationen für das Schuljahr 2025/26";
    for (let index = 1; index <= 30; index++) {
      const dir = ws.repo(`viele/reihe-${String(index).padStart(2, "0")}-mit-einem-ziemlich-langen-namen-fuer-die-auswertung`);
      await addRepo(app, dir, { groupName: long });
    }
    await showManagement(app);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
    await app.settle();
    await page.locator(`[data-group-actions="${long}"]`).getByRole("button", { name: `Fetch group “${long}”` }).click();
    await syncDialog().waitFor();
    await finished();
    equal(Object.keys(await syncRows()).length, 30, "30 rows");
    equal(await summary(), "30 unchanged", "without a remote all are skipped");
    const listBox = await syncDialog().locator("ul").evaluate((list) => ({ scrolls: list.scrollHeight > list.clientHeight, width: list.scrollWidth - list.clientWidth }));
    check(listBox.scrolls && listBox.width === 0, `the list scrolls vertically and does not grow sideways: ${JSON.stringify(listBox)}`);
    equal(await t.overflow(), { x: 0, y: 0 }, "no overflow");
    await shot("repo-groups-viele");
    await closeSync();

    // The filter hides two members (archiv, verzogen) – the group actions still apply to all seven.
    await page.getByLabel("Filter repositories").fill("station-");
    await eventually(() => page.locator("[data-repo-section]").evaluateAll((list) => list.map((item) => item.textContent)), ["Messnetz5"], "filtered: five of the seven are visible");
    // Rename via the heading menu.
    await page.locator('[data-group-actions="Messnetz"]').getByRole("button", { name: "More actions for group “Messnetz”" }).click();
    await page.getByRole("menuitem", { name: /^Rename group/ }).click();
    const rename = await waitDialog(/^Rename group “Messnetz”$/);
    await rename.getByLabel("Group name").fill("Messnetz Küste");
    await page.keyboard.press("Enter");
    await waitToast(/Group is now called “Messnetz Küste”/, "success");
    await eventually(async () => (await repoList()).filter((repo) => repo.groupName === "Messnetz Küste").length, 7, "all seven repositories carry the new group name (repo_list)");
    equal((await repoList()).filter((repo) => repo.groupName === "Messnetz").length, 0, "the old name is gone");
    await t.closeToasts();

    // Dissolving asks first; focus is on "Cancel".
    await page.locator('[data-group-actions="Messnetz Küste"]').getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: /^Dissolve group/ }).click();
    const ask = await waitDialog(/^Dissolve group “Messnetz Küste”\?$/);
    check(/stay in the list and on disk/.test(await ask.innerText()) && (await ask.innerText()).includes("station-nord"), "the confirmation says what stays and names the repositories");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on 'Cancel'");
    await shot("repo-groups-aufloesen");
    await page.keyboard.press("Enter");
    await sleep(300);
    equal((await repoList()).filter((repo) => repo.groupName === "Messnetz Küste").length, 7, "Enter cancels – the group still exists");
    await page.locator('[data-group-actions="Messnetz Küste"]').getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: /^Dissolve group/ }).click();
    await waitDialog(/^Dissolve group “Messnetz Küste”\?$/);
    await page.getByRole("dialog").getByRole("button", { name: "Dissolve group" }).click();
    await waitToast(/Group “Messnetz Küste” dissolved/, "success");
    await eventually(async () => (await repoList()).filter((repo) => repo.groupName === "Messnetz Küste").length, 0, "the assignment is gone (repo_list)");
    equal((await repoList()).length, 37, "all repositories are still in the list");
    check(fs.existsSync(path.join(nord.path, ".git")), "nothing is deleted on disk");
    equal(app.consoleErrors, [], "console errors");
  });
} catch (error) {
  t.check(false, `aborted: ${error?.stack ?? error}`);
} finally {
  if (app) await app.close().catch(() => undefined);
  try {
    fs.renameSync(`${verzogen}-woanders`, verzogen);
  } catch {
    // was never moved
  }
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Cleanup is secondary.
    }
  }
}
t.finish();
