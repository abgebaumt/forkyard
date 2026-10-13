/**
 * Stash only selected files and apply single files from a stash – in the real app, against a real
 * repository.
 *
 *   node scripts/e2e/screens/stash-files.mjs                 everything (checks and screenshots)
 *   node scripts/e2e/screens/stash-files.mjs --only single   only sections whose title contains "single" (comma separates several)
 *   node scripts/e2e/screens/stash-files.mjs --show          window visible
 *
 * Checked in the repository: git stash list / show, file content, index. The "keyboard only"
 * section does not use the mouse. Fails on console errors.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { SHOTS, closeToasts, finish, makeChecks, makeDriver } from "./files-lib.mjs";
import { wipDriver } from "./_wip.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const checks = makeChecks("stash-files");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const repo = makeCleanRepoWithRemote({ name: "stash-dateien" });
const file = (name) => path.join(repo.path, name);
const read = (name) => fs.readFileSync(file(name), "utf8");
const lines = (text) => text.split(/\r?\n/).filter(Boolean);
const head = { readme: read("README.md"), stations: read("stationen.csv"), compare: read("src/vergleich.py") };
const changed = {
  readme: `${head.readme}\nStand: im Stash geparkt.\n`,
  stations: `${head.stations}W;Wald;212\n`,
  compare: `${head.compare}\n\ndef mittel(a, b):\n    return (a + b) / 2\n`,
};

const commitDetailsScreen = '[data-screen="commit-details"]';

let app = null;
try {
  app = await launchApp({ show });
  state.app = app;
  const { page } = app;
  const { repoId, tabId } = await app.openRepo(repo.path);
  const ui = makeDriver(app, tabId, checks);
  const wip = wipDriver(app, checks);
  const store = (method, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [method, args]);
  const refresh = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
  };
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  const stashRow = (name) => page.locator(`${commitDetailsScreen} [data-row-key=${JSON.stringify(name)}]`).first();
  const selectStash = async () => {
    await store("selectStash", tabId, 0);
    await page.locator(`${commitDetailsScreen}[data-selection="stash"]`).waitFor();
    await stashRow("README.md").waitFor();
    await app.settle();
  };
  /** In the open menu, arrow keys to the entry with this label, then Enter. */
  const chooseByKeys = async (label) => {
    for (let step = 0; step < 24; step++) {
      const now = await page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted] span.truncate')?.textContent?.trim() ?? null);
      if (now === label) {
        await page.keyboard.press("Enter");
        return true;
      }
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(40);
    }
    return check(false, `menu entry "${label}" not reached with the arrow keys`);
  };
  state.resetView = async () => {
    for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await closeToasts(page);
    await app.settle();
  };

  // -------------------------------------------------------------------------------------------
  await section("Stash only selected files: two of four, through the selection menu", async () => {
    fs.writeFileSync(file("README.md"), changed.readme);
    fs.writeFileSync(file("stationen.csv"), changed.stations);
    fs.writeFileSync(file("src/vergleich.py"), changed.compare);
    fs.mkdirSync(file("notizen"), { recursive: true });
    fs.writeFileSync(file("notizen/neu.txt"), "noch nicht verfolgt\n");
    await refresh();
    await wip.waitCounts(repoId, { unstaged: 4, staged: 0, conflicted: 0 }, "four changed files");
    await wip.row("unstaged", "README.md").click();
    await wip.row("unstaged", "stationen.csv").click({ modifiers: ["Control"] });
    await wip.row("unstaged", "stationen.csv").click({ button: "right" });
    await ui.menuItem("Stash only these 2 files").click();
    await wip.waitToast("success", /stashed|Stash/);
    await wip.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "two files stay in the working tree");
    equal(lines(repo.git("stash", "list")).length, 1, "git stash list: one stash");
    equal(lines(repo.git("stash", "show", "--name-only", "stash@{0}")).sort(), ["README.md", "stationen.csv"], "git stash show: exactly the two selected files");
    equal([read("README.md"), read("stationen.csv")], [head.readme, head.stations], "the stashed files are back at the HEAD state");
    equal([read("src/vergleich.py"), read("notizen/neu.txt")], [changed.compare, "noch nicht verfolgt\n"], "the other two are untouched");
    await closeToasts(page);
    await store("closeCenter", tabId);
  });

  // -------------------------------------------------------------------------------------------
  await section("Apply a single file from the stash – keyboard only", async () => {
    await selectStash();
    equal(await page.locator(`${commitDetailsScreen} [data-row-key]`).evaluateAll((rows) => rows.map((item) => item.dataset.rowKey).sort()), ["README.md", "stationen.csv"], "the stash files are listed in the commit panel");
    // Into the list, to the README, context menu with Shift+F10.
    await wip.tabUntil((name) => document.activeElement?.closest(`[aria-label="${name}"]`) !== null && document.activeElement?.hasAttribute("data-row-key"), "Files in this stash");
    for (let step = 0; step < 4 && (await wip.focusedKey()) !== "README.md"; step++) await page.keyboard.press("ArrowUp");
    equal(await wip.focusedKey(), "README.md", "focus is on README.md");
    await page.keyboard.press("Shift+F10");
    await page.locator('[role="menu"]').waitFor();
    const entry = ui.menuItem("Apply only this file from the stash …");
    equal(await entry.count(), 1, "the menu offers \"Apply only this file from the stash …\"");
    check((await entry.innerText()).includes("ends up staged"), "and says where the file ends up");
    await shot("stash-file-menu");
    await chooseByKeys("Apply only this file from the stash …");
    await wip.waitToast("success", /README\.md.*restored/);

    equal(read("README.md"), changed.readme, "README.md has the version from the stash");
    equal(lines(repo.git("diff", "--cached", "--name-only")), ["README.md"], "git: the file is staged");
    equal(read("stationen.csv"), head.stations, "the other stash file is not applied");
    equal(lines(repo.git("stash", "list")).length, 1, "the stash is kept");
    equal(lines(repo.git("stash", "show", "--name-only", "stash@{0}")).sort(), ["README.md", "stationen.csv"], "unchanged with both files");
    await wip.waitCounts(repoId, { unstaged: 2, staged: 1, conflicted: 0 }, "the lists show the new state");
    await closeToasts(page);

    // Undo reverts the apply.
    await page.keyboard.press("Control+z");
    await eventually(() => read("README.md"), head.readme, "Ctrl+Z: README.md is back at the HEAD state");
    await eventually(() => repo.git("diff", "--cached", "--name-only"), "", "and nothing is staged any more");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Locally changed file: confirmation before overwriting; several files at once", async () => {
    fs.writeFileSync(file("stationen.csv"), `${head.stations}X;Lokal;1\n`);
    await refresh();
    await selectStash();
    await stashRow("stationen.csv").click({ button: "right" });
    await ui.menuItem("Apply only this file from the stash …").click();
    const ask = page.getByRole("dialog", { name: /Overwrite.*stationen\.csv.*\?/ });
    await ask.waitFor();
    check((await ask.innerText()).includes("uncommitted changes"), "the confirmation says that local changes are replaced");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on \"Cancel\"");
    await shot("stash-file-confirm");
    await page.keyboard.press("Enter");
    await eventually(() => ask.count(), 0, "Enter cancels");
    equal(read("stationen.csv"), `${head.stations}X;Lokal;1\n`, "after cancelling the local change is still there");

    // Select both stash files and apply them together.
    await stashRow("README.md").click();
    await stashRow("stationen.csv").click({ modifiers: ["Control"] });
    await stashRow("stationen.csv").click({ button: "right" });
    await ui.menuItem("Apply only these 2 files from the stash …").click();
    await page.getByRole("dialog", { name: /Overwrite 2 files.*\?/ }).getByRole("button", { name: "Overwrite", exact: true }).click();
    await wip.waitToast("success", /2 files.*restored/);
    equal([read("README.md"), read("stationen.csv")], [changed.readme, changed.stations], "both files have the version from the stash");
    equal(lines(repo.git("diff", "--cached", "--name-only")).sort(), ["README.md", "stationen.csv"], "git: both are staged");
    equal(lines(repo.git("stash", "list")).length, 1, "the stash is kept");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Minimum window and light theme: menu stays inside the window", async () => {
    await app.setSize(960, 600);
    await selectStash();
    await stashRow("README.md").click({ button: "right" });
    const menu = page.locator('[role="menu"]').first();
    await menu.waitFor();
    const box = await menu.boundingBox();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `the menu lies entirely inside the window (${JSON.stringify(box)})`);
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no horizontal overflow");
    await shot("stash-file-menu-min");
    await app.setTheme("light");
    await shot("stash-file-menu-light");
    await app.setTheme("dark");
    await page.keyboard.press("Escape");
    await app.setSize(1440, 900);
  });
} catch (error) {
  check(false, `script aborted: ${error?.stack ?? error}`);
}
await finish("stash-files", checks, app, () => repo.cleanup());
