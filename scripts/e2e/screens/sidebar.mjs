/**
 * sidebar – sidebar (left panel) in the real app against real Git repositories.
 *
 *   node scripts/e2e/screens/sidebar.mjs            everything, screenshots to target/e2e/shots/
 *   node scripts/e2e/screens/sidebar.mjs --show     visible window
 *
 * Checks the UI AND the repository itself (git in the fixtures) or the core
 * (view_state_get, graph_page). Exits with code 1 if anything differs or the page
 * reports a console error.
 *
 * Simulated at the core boundary rather than real: the states "loading" (refsList delayed)
 * and "error" (refsList rejected) – a repository whose refs cannot be read while its folder
 * still exists could not be produced reliably. For this the method on the UI's core object
 * is replaced (window.__gc.core, debug build only).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeEmptyRepo, makeRichRepo } from "../fixtures.mjs";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots";
const failures = [];
let current = "";
const check = (condition, message) => {
  if (!condition) {
    failures.push(`${current}: ${message}`);
    console.log(`  ✗ ${message}`);
  }
  return Boolean(condition);
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const until = async (read, test, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!test(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    value = await read();
  }
  return value;
};
/** Waits until the value matches (the UI answers asynchronously, slowly under load). */
const eventually = async (read, expected, message, timeoutMs = 8000) => equal(await until(read, (value) => JSON.stringify(value) === JSON.stringify(expected), timeoutMs), expected, message);
const eventuallyTrue = async (read, message, timeoutMs = 8000) => check(await until(read, Boolean, timeoutMs), message);
const section = async (name, run) => {
  current = name;
  const before = failures.length;
  try {
    await run();
  } catch (error) {
    check(false, `aborted: ${error?.message ?? error}`);
  }
  if (app && app.consoleErrors.length) {
    check(false, `Console errors:\n${app.consoleErrors.join("\n")}`);
    throw new Error(`Console errors in "${name}" – aborting.`);
  }
  console.log(`${failures.length === before ? "✓" : "✗"} ${name}`);
};

/** git directly in the fixture repository, with input on stdin (for update-ref --stdin). */
const gitIn = (cwd, args, input) => execFileSync("git", args, { cwd, input, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }).toString("utf8").trim();

/**
 * Create a fixture, retrying if needed: when several E2E scripts run at once, another process's
 * cleanup occasionally removes a folder that is just being copied from the cache.
 */
const make = (build) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return build();
    } catch (error) {
      if (attempt >= 4) throw error;
      console.log(`  Fixture retry (${error.code ?? error.message})`);
    }
  }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-s05-data-"));
const rich = make(() => makeRichRepo());
const clean = make(() => makeRichRepo({ dirty: false, name: "wetterstation-sauber" }));
const empty = make(() => makeEmptyRepo());
const long = make(() => makeCleanRepoWithRemote({ name: "lange-namen" }));
const many = make(() => makeCleanRepoWithRemote({ name: "viele-branches" }));
const repos = [rich, clean, empty, long, many];

// --- Extend fixtures -----------------------------------------------------------------------------
// Two merged branches to delete, one with a vanished upstream.
clean.git("branch", "aufraeumen/eins");
clean.git("branch", "aufraeumen/zwei");
clean.git("branch", "verwaist");
clean.git("config", "branch.verwaist.remote", "origin");
clean.git("config", "branch.verwaist.merge", "refs/heads/gibt-es-nicht-mehr");

const LONG_BRANCH = "feature/plausibilitaetspruefung-fuer-alle-sensoren-der-station-nord-und-sued";
const LONG_TAG = "auslieferung-2026-03-wetterstation-schuldach-hauptgebaeude-fassung-final-2";
const LONG_STASH = "Zwischenstand der Umstellung auf die neue Logger-Fassung: Plausibilitätsprüfung, Tagesmittel und Regensummen laufen schon, die Windmessung noch nicht, und die Tests für den Export fehlen ganz – nicht vergessen vor dem Merge";
long.git("branch", LONG_BRANCH);
long.git("branch", "team/auswertung/winterhalbjahr/station-nord/temperatur/tagesmittel-neu-berechnen");
long.git("tag", LONG_TAG);
long.git("tag", "-a", "v9.9.9", "-m", "Erste Zeile der Annotation\n\nZweiter Absatz mit einer längeren Erklärung, warum es diese Fassung gibt und was sich seit der letzten geändert hat.");
long.write("NOTIZ.md", "Zwischenstand\n");
long.git("stash", "push", "--include-untracked", "-m", LONG_STASH);

const MANY = 600;
{
  const head = many.git("rev-parse", "HEAD");
  let input = "";
  for (let index = 1; index <= MANY; index++) input += `create refs/heads/thema/zweig-${String(index).padStart(4, "0")} ${head}\n`;
  for (let index = 1; index <= 40; index++) input += `create refs/tags/archiv-${String(index).padStart(3, "0")} ${head}\n`;
  gitIn(many.path, ["update-ref", "--stdin"], input);
}

let app = null;
try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir });
  let { page } = app;

  const panel = () => page.locator('[data-screen="sidebar"]');
  const row = (id) => panel().locator(`[data-row-id="${id}"]`);
  const sectionEl = (key) => panel().locator(`[data-section="${key}"]`);
  const header = (key) => sectionEl(key).locator("[data-section-header] button").first();
  const rowIds = (key) => sectionEl(key).locator("[data-row-id]").evaluateAll((list) => list.map((element) => element.dataset.rowId));
  const headerText = (key) => header(key).innerText().then((text) => text.replace(/\s+/g, " ").trim());
  const focusedRow = () => page.evaluate(() => document.activeElement?.getAttribute("data-row-id") ?? document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);
  const filter = () => panel().locator("[data-left-filter]");
  const toasts = (tone) => page.locator(tone ? `[data-toast="${tone}"]` : "[data-toast]").allInnerTexts();
  const closeToasts = async () => {
    for (let round = 0; round < 10 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click();
      await page.waitForTimeout(120);
    }
  };
  const viewState = (repoId) => app.invoke("view_state_get", { repoId });
  const tabView = (tabId) => page.evaluate((id) => window.__gc.store.getState().views[id] ?? null, tabId);
  const ready = () => panel().locator("[data-skeleton]").count().then((count) => count === 0);
  const open = async (repo) => {
    const opened = await app.openRepo(repo.path);
    await panel().waitFor();
    await eventuallyTrue(ready, "panel has loaded");
    await app.settle().catch(() => undefined);
    return opened;
  };
  const menu = () => page.locator('[role="menu"]');
  const menuItems = () => menu().locator('[role="menuitem"]').allInnerTexts().then((list) => list.map((text) => text.replace(/\s+/g, " ").trim()));
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await menu().waitFor({ state: "detached" });
  };
  /** In the open menu, move to an entry with the arrow keys and pick it with Enter. */
  const chooseByKeyboard = async (pattern) => {
    await menu().waitFor();
    const highlighted = () => page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? "");
    for (let step = 0; step < 25; step++) {
      const before = await highlighted();
      await page.keyboard.press("ArrowDown");
      // Radix moves focus a moment after the key; under load the next key would otherwise count twice.
      await page.waitForFunction((old) => (document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? "") !== old, before, { timeout: 400 }).catch(() => undefined);
      const text = await highlighted();
      if (pattern.test(text)) {
        await page.keyboard.press("Enter");
        await menu().waitFor({ state: "detached" });
        return true;
      }
    }
    await page.keyboard.press("Escape");
    return false;
  };
  const tooltip = () => page.locator('[role="tooltip"]').allInnerTexts().then((list) => list.join("\n"));
  /**
   * Pointer onto an element and a bit further: when switching between two tooltips Radix evaluates
   * several pointer moves – a single jump as Playwright does it is not enough.
   */
  const hoverTip = async (locator) => {
    await leave();
    await locator.hover();
    const box = await locator.boundingBox();
    const x = box.x + Math.min(box.width / 2, 20);
    const y = box.y + box.height / 2;
    // Small moves around the centre so the pointer stays on a 14 px icon too.
    for (const offset of [-2, 1, -1, 0]) await page.mouse.move(x + offset, y, { steps: 2 });
  };
  const leave = async () => {
    await page.mouse.move(700, 500, { steps: 3 });
    await page.mouse.move(705, 505, { steps: 3 });
    await page.locator('[role="tooltip"]').first().waitFor({ state: "detached", timeout: 3000 }).catch(() => undefined);
  };
  const graphRows = async (repoId) => (await app.invoke("graph_page", { repoId, cursor: null, limit: 500 })).rows;
  const labelNames = (rows) => [...new Set(rows.flatMap((item) => item.refs.map((ref) => ref.fullName)))].sort();
  const overflowX = () => page.evaluate(() => {
    const scroller = document.querySelector("[data-left-scroll]");
    return { panel: scroller.scrollWidth - scroller.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });

  // ===============================================================================================
  let richIds = null;
  await section("Layout: sections, tree, roles", async () => {
    richIds = await open(rich);
    equal(await headerText("local"), "LOCAL 5", "Local header with count");
    equal(await headerText("remote"), "REMOTE 3", "Remote header with count");
    equal(await headerText("tags"), "TAGS 3", "Tags header with count");
    equal(await headerText("stashes"), "STASHES 2", "Stashes header with count");
    equal(await panel().locator("[data-section]").count(), 4, "exactly four sections – no empty shells for worktrees or submodules");
    equal(
      await rowIds("local"),
      ["dir:local/bugfix", "refs/heads/bugfix/sensor-ausfall", "dir:local/experiment", "refs/heads/experiment/alte-auswertung", "dir:local/feature", "refs/heads/feature/luftdruck", "refs/heads/feature/wind-diagramm", "refs/heads/main"],
      "Local: "/" becomes folders, folders first",
    );
    equal(
      await rowIds("remote"),
      ["remote:origin", "dir:remote/origin/feature", "refs/remotes/origin/feature/temperatur-karte", "refs/remotes/origin/feature/wind-diagramm", "refs/remotes/origin/main"],
      "Remote: grouped by remote, its branches below",
    );
    equal(await rowIds("tags"), ["refs/tags/messreihe-januar", "refs/tags/v0.1.0", "refs/tags/v0.2.0"], "Tags");
    equal(await sectionEl("stashes").locator("[data-row-id]").count(), 2, "two stashes");

    const main = row("refs/heads/main");
    equal(await main.getAttribute("aria-current"), "true", "checked-out branch carries aria-current");
    check((await main.getAttribute("aria-label")).includes("checked out"), "… and says so as text");
    check(/font-semibold/.test(await main.locator("span.truncate").first().getAttribute("class")), "… and is bold");
    equal((await main.innerText()).replace(/\s+/g, " ").trim(), "main 2 1", "main shows ahead 2 / behind 1 – same order as the status bar (BUG-090)");
    equal(await row("dir:local/feature").getAttribute("aria-expanded"), "true", "folder carries aria-expanded");
    equal(await row("refs/heads/feature/luftdruck").getAttribute("aria-level"), "2", "child of a folder: aria-level 2");
    equal(await row("refs/remotes/origin/feature/wind-diagramm").getAttribute("aria-level"), "3", "remote › folder › branch: aria-level 3");
    equal(await sectionEl("local").locator('[role="tree"]').getAttribute("aria-label"), "Local", "tree with a name");
    equal(await panel().locator('[role="treeitem"][tabindex="0"]').count(), 1, "exactly one row is reachable by Tab (roving tabindex)");
    equal(await header("local").getAttribute("aria-expanded"), "true", "section header is a button with aria-expanded");
    const stash = sectionEl("stashes").locator("[data-row-id]").first();
    const stashText = (await stash.innerText()).replace(/\s+/g, " ").trim();
    check(stashText.startsWith("Ideen für das README") && /main · .+ ago/.test(stashText), `stash shows message, branch and relative date ("${stashText}")`);
    equal(await overflowX(), { panel: 0, page: 0 }, "no horizontal overflow");
    await main.click();
    await app.settle().catch(() => undefined);
    await app.screenshot(`${SHOTS}/sidebar.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/sidebar-light.png`);
    await app.setTheme("dark");
  });

  await section("Click shows the commit, tooltips", async () => {
    const { tabId } = richIds;
    await row("refs/heads/feature/luftdruck").click();
    const view = await tabView(tabId);
    equal(view.selection, { kind: "commits", shas: [rich.info.shas.secondMerge] }, "clicking a branch selects its commit");
    equal(view.reveal?.sha, rich.info.shas.secondMerge, "… and asks the graph to scroll there");
    equal(await row("refs/heads/feature/luftdruck").getAttribute("aria-selected"), "true", "the row is selected");

    const stash = sectionEl("stashes").locator("[data-row-id]").first();
    await stash.click();
    const stashSha = (await stash.getAttribute("data-row-id")).replace("stash:", "");
    equal((await tabView(tabId)).selection, { kind: "commits", shas: [stashSha] }, "clicking a stash shows it in the graph");
    await stash.dblclick();
    equal((await tabView(tabId)).selection, { kind: "stash", index: 0 }, "double-clicking a stash selects it (selectStash)");

    await hoverTip(row("refs/heads/main").locator("span.tabular-nums").first());
    await eventuallyTrue(async () => /2 commits ahead, 1 commit behind relative to origin\/main/.test(await tooltip()), "tooltip on the counters names ahead, behind and the upstream");
    await leave();
    await hoverTip(row("refs/tags/v0.1.0").locator("span.truncate").first());
    await eventuallyTrue(async () => /Erste nutzbare Fassung/.test(await tooltip()), "tooltip of an annotated tag shows the annotation");
    await leave();
  });

  await section("Checkout blocked by local changes: clear message, nothing happens", async () => {
    await row("refs/heads/experiment/alte-auswertung").dblclick();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const text = await dialog.innerText();
    check(/Uncommitted changes are blocking/.test(text), `confirmation explains why the switch is not possible ("${text.split("\n")[0]}")`);
    check(/README\.md/.test(text), "… and names the affected files");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    equal(rich.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "main is still checked out in the repository");
    equal(rich.git("stash", "list").split(/\r?\n/).length, 2, "… and no stash was added");
    equal(await row("refs/heads/main").getAttribute("aria-current"), "true", "in the panel too");
    equal(await toasts("danger"), [], "no additional error message");
    await closeToasts();
  });

  // ===============================================================================================
  let cleanIds = null;
  await section("Checkout by double-click and checking out a remote branch", async () => {
    cleanIds = await open(clean);
    equal(await headerText("stashes"), "STASHES 0", "clean repository: no stashes");
    equal((await sectionEl("stashes").locator("[data-empty]").innerText()).trim(), "No stashes", "empty section in one line");

    await row("refs/heads/bugfix/sensor-ausfall").dblclick();
    await eventually(async () => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "bugfix/sensor-ausfall", "double-click checks out (verified in the repository)");
    await eventually(() => row("refs/heads/bugfix/sensor-ausfall").getAttribute("aria-current"), "true", "check mark moves along in the panel");
    await eventually(() => row("refs/heads/main").getAttribute("aria-current"), null, "main is no longer marked");

    await row("refs/remotes/origin/feature/temperatur-karte").dblclick();
    await eventually(async () => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/temperatur-karte", "remote branch: the local branch is created and checked out");
    equal(clean.git("rev-parse", "--abbrev-ref", "feature/temperatur-karte@{upstream}"), "origin/feature/temperatur-karte", "… with upstream");
    await eventually(() => row("refs/heads/feature/temperatur-karte").getAttribute("aria-current"), "true", "the new local branch is in the panel and marked");
    equal(await toasts("danger"), [], "no error message");

    const gone = row("refs/heads/verwaist");
    equal(await gone.locator("[data-upstream-gone]").count(), 1, "vanished upstream has its own marker");
    await hoverTip(gone.locator("[data-upstream-gone]"));
    await eventuallyTrue(async () => /no longer exists/.test(await tooltip()), "… with a tooltip");
    await leave();
    await closeToasts();
  });

  await section("Keyboard only: filter, checkout, rename, hide, tree", async () => {
    const { repoId } = cleanIds;
    await page.keyboard.press("Control+Alt+f");
    await eventually(() => page.evaluate(() => document.activeElement?.hasAttribute("data-left-filter") ?? false), true, "Ctrl+Alt+F jumps into the filter bar");
    await page.keyboard.type("luft");
    await eventually(() => rowIds("local"), ["dir:local/feature", "refs/heads/feature/luftdruck"], "filter shows the hit with its folder");
    await page.keyboard.press("ArrowDown");
    await eventually(focusedRow, "dir:local/feature", "arrow down goes from the filter into the first row");
    await page.keyboard.press("ArrowDown");
    await eventually(focusedRow, "refs/heads/feature/luftdruck", "arrow down to the next row");
    await page.keyboard.press("Enter");
    await eventually(async () => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/luftdruck", "Enter checks out (verified in the repository)");
    await eventually(() => row("refs/heads/feature/luftdruck").getAttribute("aria-current"), "true", "check mark is set");

    await page.keyboard.press("F2");
    const input = panel().locator("[data-rename-input]");
    await input.waitFor();
    equal(await input.inputValue(), "feature/luftdruck", "F2 opens the input in the row with the full name");
    await page.keyboard.type("feature/luft druck");
    equal(await input.inputValue(), "feature/luft-druck", "spaces become \"-\"");
    await page.keyboard.press("Enter");
    await eventually(async () => clean.git("branch", "--list", "feature/luft*", "--format=%(refname:short)"), "feature/luft-druck", "Enter renames (verified in the repository)");
    await eventually(focusedRow, "refs/heads/feature/luft-druck", "focus is on the renamed row");
    equal(clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/luft-druck", "the renamed branch stays checked out");

    await page.keyboard.press("Shift+F10");
    check(await chooseByKeyboard(/hide/i), "Shift+F10 opens the context menu; \"Hide in graph\" with arrow keys and Enter");
    await eventually(async () => (await viewState(repoId)).hiddenRefs, ["refs/heads/feature/luft-druck"], "hiddenRefs in the core");
    await eventually(focusedRow, "refs/heads/feature/luft-druck", "after the menu, focus is back on the row");
    await page.keyboard.press("Shift+F10");
    check(await chooseByKeyboard(/show in (the )?graph again/i), "… and show it again via the menu");
    await eventually(async () => (await viewState(repoId)).hiddenRefs, [], "hiddenRefs empty again");

    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await eventually(() => page.evaluate(() => document.activeElement?.hasAttribute("data-left-filter") ?? false), true, "arrow up from the first row leads back into the filter");
    await page.keyboard.press("Escape");
    equal(await filter().inputValue(), "", "Esc clears the filter");
    await page.keyboard.press("ArrowDown");
    await eventually(focusedRow, "dir:local/aufraeumen", "first row of the tree");
    await page.keyboard.press("ArrowLeft");
    await eventually(() => row("dir:local/aufraeumen").getAttribute("aria-expanded"), "false", "arrow left collapses the folder");
    equal(await row("refs/heads/aufraeumen/eins").count(), 0, "its children are gone");
    await eventually(async () => (await viewState(repoId)).collapsedFolders, ["dir:local/aufraeumen"], "collapsedFolders in the core");
    await page.keyboard.press("ArrowRight");
    await eventually(() => row("dir:local/aufraeumen").getAttribute("aria-expanded"), "true", "arrow right expands");
    await page.keyboard.press("ArrowRight");
    await eventually(focusedRow, "refs/heads/aufraeumen/eins", "arrow right on an open folder jumps to the first child");
    await page.keyboard.press("ArrowLeft");
    await eventually(focusedRow, "dir:local/aufraeumen", "arrow left on a child jumps to the folder");
    await page.keyboard.press("End");
    const last = await focusedRow();
    check(last === "refs/tags/v0.2.0", `End jumps to the last row (${last})`);
    await page.keyboard.press("Home");
    await eventually(focusedRow, "dir:local/aufraeumen", "Home to the first");
    await page.keyboard.press("m");
    await eventually(focusedRow, "refs/heads/main", "typing jumps to the next entry starting like that");
    await page.keyboard.press("m");
    await eventually(focusedRow, "refs/remotes/origin/main", "the same letter again: the next one");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(800);
    await page.keyboard.press("v");
    await page.keyboard.press("e");
    await eventually(focusedRow, "refs/heads/verwaist", "several letters: \"ve\" finds \"verwaist\"");
    await page.keyboard.press("Home");
    await page.waitForTimeout(800);
    await page.keyboard.press("m");
    await eventually(focusedRow, "refs/heads/main", "back to main");
    await page.keyboard.press("Enter");
    await eventually(async () => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "Enter checks out main");
    equal(await toasts("danger"), [], "no error message");
  });

  await section("Rename: validation while typing, Esc discards", async () => {
    const target = row("refs/heads/feature/luft-druck");
    await target.focus();
    await page.keyboard.press("F2");
    const input = panel().locator("[data-rename-input]");
    await input.waitFor();
    await input.fill("main");
    await eventuallyTrue(async () => (await panel().locator('[role="alert"]').count()) === 1, "existing name: the reason is shown right at the row");
    const reason = await panel().locator('[role="alert"]').innerText();
    check(/main/.test(reason) && reason.length > 10, `reason is a full sentence ("${reason}")`);
    equal(await input.getAttribute("aria-invalid"), "true", "input is marked invalid");
    await app.screenshot(`${SHOTS}/sidebar-rename.png`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    equal(await input.count(), 1, "Enter with an invalid name does not rename");
    await input.fill("feature/..kaputt");
    await eventuallyTrue(async () => !/main/.test(await panel().locator('[role="alert"]').innerText().catch(() => "main")), "name invalid by Git rules: its own reason");
    await page.keyboard.press("Escape");
    await eventually(() => input.count(), 0, "Esc closes the input");
    equal(clean.git("branch", "--list", "feature/luft*", "--format=%(refname:short)"), "feature/luft-druck", "nothing is renamed in the repository");
    await eventually(focusedRow, "refs/heads/feature/luft-druck", "focus back on the row");

    // Via the menu (mouse): the same input
    await target.click({ button: "right" });
    await menu().waitFor();
    check((await menuItems()).some((text) => /^Rename/.test(text)), "context menu offers \"Rename\"");
    await menu().getByRole("menuitem", { name: /^Rename/ }).click();
    await input.waitFor();
    await eventually(() => page.evaluate(() => document.activeElement?.hasAttribute("data-rename-input") ?? false), true, "the input has focus, also after the menu closed");
    await input.fill("feature/luftdruck");
    await page.keyboard.press("Enter");
    await eventually(async () => clean.git("branch", "--list", "feature/luft*", "--format=%(refname:short)"), "feature/luftdruck", "renamed via the menu (verified in the repository)");
    await closeToasts();
  });

  await section("Folders and sections: collapse, maximize, hide", async () => {
    const { repoId } = cleanIds;
    await row("dir:local/feature").click();
    await eventually(() => row("dir:local/feature").getAttribute("aria-expanded"), "false", "click collapses the folder");
    equal(await row("refs/heads/feature/luftdruck").count(), 0, "children hidden");
    await eventuallyTrue(async () => (await viewState(repoId)).collapsedFolders.includes("dir:local/feature"), "collapsedFolders in the core");
    await row("remote:origin").click();
    await eventually(() => row("remote:origin").getAttribute("aria-expanded"), "false", "a remote collapses the same way");
    await row("remote:origin").click();

    await header("tags").click();
    await eventually(() => header("tags").getAttribute("aria-expanded"), "false", "clicking the header collapses the section");
    await eventuallyTrue(async () => (await viewState(repoId)).sections.find((item) => item.id === "tags")?.collapsed === true, "sections in the core: tags collapsed");
    await app.screenshot(`${SHOTS}/sidebar-collapsed.png`);

    await header("remote").dblclick();
    await eventually(() => panel().locator("[data-section]").count(), 1, "double-clicking the header maximizes: only this section left");
    equal(await sectionEl("remote").getAttribute("data-maximized"), "", "… and it is marked as maximized");
    equal(await header("remote").getAttribute("aria-expanded"), "true", "… and open");
    await app.screenshot(`${SHOTS}/sidebar-maximized.png`);
    await sectionEl("remote").getByRole("button", { name: "Show all sections" }).click();
    await eventually(() => panel().locator("[data-section]").count(), 4, "\"Show all sections\" restores");

    await header("stashes").focus();
    await page.keyboard.press("Shift+F10");
    await menu().waitFor();
    const items = await menuItems();
    check(["Collapse", "Maximize", "Hide section", "Local", "Remote", "Tags", "Stashes"].every((label) => items.includes(label)), `header context menu via Shift+F10 (${items.join(" | ")})`);
    await menu().getByRole("menuitem", { name: "Hide section" }).click();
    await eventually(() => sectionEl("stashes").count(), 0, "\"Hide section\" takes it out");
    await eventuallyTrue(async () => (await viewState(repoId)).sections.find((item) => item.id === "stashes")?.hidden === true, "sections in the core: stashes hidden");
    await header("local").click({ button: "right" });
    await menu().getByRole("menuitem", { name: "Stashes" }).click();
    await eventually(() => sectionEl("stashes").count(), 1, "shown again via another header's menu");
  });

  await section("Hide and solo: core, graph fetch, display", async () => {
    const { repoId } = cleanIds;
    const before = await graphRows(repoId);
    check(labelNames(before).includes("refs/heads/experiment/alte-auswertung"), "before, the graph carries the branch label");
    equal(await panel().locator("[data-view-filtered]").count(), 0, "no \"View filtered\" row yet");

    const target = row("refs/heads/experiment/alte-auswertung");
    equal(await target.locator('[data-toggle="hide"]').isVisible(), false, "toggles are not visible without hovering");
    await target.hover();
    equal(await target.locator('[data-toggle="hide"]').isVisible(), true, "… but are on hover");
    await target.focus();
    await page.mouse.move(700, 500);
    equal(await target.locator('[data-toggle="hide"]').isVisible(), true, "… and with keyboard focus");
    await target.hover();
    await target.locator('[data-toggle="hide"]').click();
    await eventually(async () => (await viewState(repoId)).hiddenRefs, ["refs/heads/experiment/alte-auswertung"], "hiddenRefs in the core (fullName)");
    const hidden = await graphRows(repoId);
    check(!labelNames(hidden).includes("refs/heads/experiment/alte-auswertung"), "graph_page no longer returns the label");
    check(hidden.length < before.length, `graph_page returns fewer rows (${before.length} → ${hidden.length}): the commit only on this branch is missing`);
    equal(await target.getAttribute("data-hidden"), "", "row marked as hidden");
    check(/text-text-disabled/.test(await target.getAttribute("class")), "… and dimmed");
    equal(await target.locator('[data-toggle="hide"]').getAttribute("aria-pressed"), "true", "toggle stays visible and pressed");
    check((await target.getAttribute("aria-label")).includes("hidden"), "… and says so as text");
    const bar = panel().locator("[data-view-filtered]");
    check(/View filtered/.test(await bar.textContent()) && /1 hidden/.test(await bar.textContent()), "\"View filtered\" at the top (for screen readers with \"1 hidden\")");
    const graphState = await page.evaluate((id) => {
      const state = window.__gc.queryClient.getQueryState(["repo", id, "graph"]);
      return state ? { invalidated: state.isInvalidated, fetching: state.fetchStatus } : null;
    }, repoId);
    console.log(`  UI graph query after hiding: ${JSON.stringify(graphState)}`);

    // Solo on one branch: the graph shows only its history
    const solo = row("refs/heads/bugfix/sensor-ausfall");
    await solo.hover();
    await solo.locator('[data-toggle="solo"]').click();
    await eventually(async () => (await viewState(repoId)).soloRefs, ["refs/heads/bugfix/sensor-ausfall"], "soloRefs in the core");
    const soloed = await graphRows(repoId);
    check(soloed.filter((item) => item.kind !== "wip").every((item) => item.sha !== clean.info.shas.head), "graph_page with solo: main's HEAD commit is not included");
    check(soloed.length < hidden.length, `… and there are fewer rows (${hidden.length} → ${soloed.length})`);
    equal(await solo.getAttribute("data-solo"), "", "solo row marked");
    check(/text-accent/.test(await solo.locator("span.truncate").first().getAttribute("class")), "… and clearly highlighted");
    check(/text-text-disabled/.test(await row("refs/heads/main").getAttribute("class")), "everything else is dimmed while solo applies");
    check(/1 hidden, 1 solo/.test(await bar.textContent()), "row names both");
    await page.mouse.move(700, 500);
    await app.screenshot(`${SHOTS}/sidebar-hide-solo.png`);

    // Folder and section
    await row("dir:local/aufraeumen").hover();
    await row("dir:local/aufraeumen").locator('[data-toggle="hide"]').click();
    await eventuallyTrue(async () => {
      const { hiddenRefs } = await viewState(repoId);
      return ["refs/heads/aufraeumen/eins", "refs/heads/aufraeumen/zwei"].every((name) => hiddenRefs.includes(name));
    }, "hiding a folder affects all branches in it");
    await sectionEl("tags").locator("[data-section-header]").hover();
    await sectionEl("tags").locator('[data-section-header] [data-toggle="hide"]').click();
    await eventuallyTrue(async () => {
      const { hiddenRefs } = await viewState(repoId);
      return clean.info.tags.every((name) => hiddenRefs.includes(`refs/tags/${name}`));
    }, "hiding a section affects all its refs");
    check(!labelNames(await graphRows(repoId)).some((name) => name.startsWith("refs/tags/")), "graph_page returns no tag labels anymore");
    equal(clean.git("tag", "--list").split(/\r?\n/).sort(), [...clean.info.tags].sort(), "all tags are still in the repository – only the view changes");
    equal(clean.git("branch", "--list", "experiment/*", "--format=%(refname:short)"), "experiment/alte-auswertung", "… and so is the hidden branch");
  });

  await section("Hide/solo, folders and sections survive a restart", async () => {
    const expected = await viewState(cleanIds.repoId);
    await app.close();
    app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir });
    page = app.page;
    cleanIds = await open(clean);
    const after = await viewState(cleanIds.repoId);
    equal([...after.hiddenRefs].sort(), [...expected.hiddenRefs].sort(), "hiddenRefs after the restart");
    equal(after.soloRefs, expected.soloRefs, "soloRefs after the restart");
    equal(after.collapsedFolders, expected.collapsedFolders, "collapsedFolders after the restart");
    equal(await row("refs/heads/experiment/alte-auswertung").getAttribute("data-hidden"), "", "panel shows the branch as hidden again");
    equal(await row("refs/heads/bugfix/sensor-ausfall").getAttribute("data-solo"), "", "… and solo");
    equal(await row("dir:local/feature").getAttribute("aria-expanded"), "false", "… the folder is still collapsed");
    equal(await header("tags").getAttribute("aria-expanded"), "false", "… the Tags section still collapsed");
    check(/View filtered/.test(await panel().locator("[data-view-filtered]").innerText()), "\"View filtered\" row is there");

    await panel().locator("[data-view-filtered]").getByRole("button", { name: "Reset" }).click();
    await eventually(async () => {
      const state = await viewState(cleanIds.repoId);
      return [state.hiddenRefs, state.soloRefs];
    }, [[], []], "\"Reset\" clears hiddenRefs and soloRefs in the core");
    await eventually(() => panel().locator("[data-view-filtered]").count(), 0, "the row disappears");
    check(labelNames(await graphRows(cleanIds.repoId)).includes("refs/heads/experiment/alte-auswertung"), "graph_page returns everything again");
    await header("tags").click();
    await row("dir:local/feature").click();
    await eventually(() => row("dir:local/feature").getAttribute("aria-expanded"), "true", "folder open again");
  });

  await section("Filter: hits, highlighting, no hits", async () => {
    await filter().fill("WIND");
    await eventually(() => rowIds("local"), ["dir:local/feature", "refs/heads/feature/wind-diagramm"], "case-insensitive substring; the folder stays because a child matches");
    await eventually(() => rowIds("remote"), ["remote:origin", "dir:remote/origin/feature", "refs/remotes/origin/feature/wind-diagramm"], "Remote section filtered");
    equal(await row("refs/heads/feature/wind-diagramm").locator("mark").allInnerTexts(), ["wind"], "hit highlighted");
    check(/1\/\d+/.test(await headerText("local")), `header shows hits/total (${await headerText("local")})`);
    equal(await sectionEl("tags").locator("[data-empty]").innerText(), "No match", "section without hits says so in one line");
    await filter().fill("origin/feature/t");
    await eventually(() => rowIds("remote"), ["remote:origin", "dir:remote/origin/feature", "refs/remotes/origin/feature/temperatur-karte"], "filter over the full name including \"/\"");
    await filter().fill("feat");
    await eventuallyTrue(async () => (await rowIds("local")).includes("refs/heads/feature/luftdruck"), "folder name as a hit shows all children");
    equal(await row("dir:local/feature").locator("mark").allInnerTexts(), ["feat"], "… and is highlighted in the folder");
    await app.screenshot(`${SHOTS}/sidebar-filter.png`);

    await filter().fill("gibt-es-nirgends");
    await eventually(() => panel().locator("[data-no-hits]").count(), 1, "\"no matches\" state");
    check(/No matches for “gibt-es-nirgends”/.test(await panel().locator("[data-no-hits]").innerText()), "… names the search text");
    await app.screenshot(`${SHOTS}/sidebar-no-hits.png`);
    await filter().focus();
    await page.keyboard.press("Escape");
    equal(await filter().inputValue(), "", "Esc clears");
    await eventually(() => panel().locator("[data-no-hits]").count(), 0, "everything back");
    await filter().fill("x");
    await panel().getByRole("button", { name: "Clear filter" }).click();
    equal(await filter().inputValue(), "", "\"Clear filter\" button");
  });

  await section("Multi-selection and deleting several branches", async () => {
    await row("refs/heads/aufraeumen/eins").click();
    await row("refs/heads/aufraeumen/zwei").click({ modifiers: ["Control"] });
    equal(await panel().locator('[role="treeitem"][aria-selected="true"]').evaluateAll((list) => list.map((element) => element.dataset.rowId)), ["refs/heads/aufraeumen/eins", "refs/heads/aufraeumen/zwei"], "Ctrl+click selects two local branches");
    await row("refs/tags/v0.1.0").click({ modifiers: ["Control"] });
    equal(await row("refs/tags/v0.1.0").getAttribute("aria-selected"), "true", "a tag cannot be added to the selection – it replaces it");
    await row("refs/heads/aufraeumen/eins").click();
    await row("refs/heads/aufraeumen/zwei").click({ modifiers: ["Shift"] });
    equal(await panel().locator('[role="treeitem"][aria-selected="true"]').count(), 2, "Shift+click selects the range");

    await row("refs/heads/aufraeumen/zwei").click({ button: "right" });
    await menu().waitFor();
    const items = await menuItems();
    check(items.some((text) => /delete/i.test(text)) && !items.some((text) => /^Rename/.test(text)), `menu for several branches (branchesMenu): ${items.join(" | ")}`);
    await closeMenu();

    await row("refs/heads/aufraeumen/zwei").focus();
    await page.keyboard.press("Delete");
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await dialog.waitFor();
    check(/Delete 2 branches\?/.test(await dialog.innerText()), "confirmation names the count");
    check(/aufraeumen\/eins/.test(await dialog.innerText()) && /aufraeumen\/zwei/.test(await dialog.innerText()), "… and the names");
    // The confirmation belongs to the shell (src/app/dialogs.tsx). In the debug build (StrictMode) Radix occasionally
    // returns focus to the triggering row – the panel then ignores all keys while the dialog is open.
    const focusedInDialog = await until(() => page.evaluate(() => document.activeElement?.textContent?.trim()), (value) => value === "Cancel", 3000);
    if (focusedInDialog !== "Cancel") console.log(`  Note: focus not on "Cancel" but on "${focusedInDialog}" (known effect in the debug build)`);
    await page.keyboard.press("Enter");
    if (focusedInDialog !== "Cancel") {
      await page.waitForTimeout(400);
      equal(await dialog.count(), 1, "Enter on the row behind the dialog triggers nothing");
      equal(clean.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "… not even a checkout");
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
    await dialog.waitFor({ state: "detached" });
    equal(clean.git("branch", "--list", "aufraeumen/*", "--format=%(refname:short)").split(/\r?\n/), ["aufraeumen/eins", "aufraeumen/zwei"], "Cancel: nothing deleted");

    await row("refs/heads/aufraeumen/eins").click();
    await row("refs/heads/aufraeumen/zwei").click({ modifiers: ["Control"] });
    await page.keyboard.press("Delete");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Delete branches" }).click();
    await eventually(async () => clean.git("branch", "--list", "aufraeumen/*", "--format=%(refname:short)"), "", "both branches are deleted in the repository");
    await eventually(() => row("dir:local/aufraeumen").count(), 0, "the empty folder disappears from the panel");
    await closeToasts();
  });

  await section("Actions in the section header", async () => {
    const { tabId } = cleanIds;
    const dialog = page.getByRole("dialog");
    await sectionEl("local").locator("[data-section-header]").hover();
    await sectionEl("local").getByRole("button", { name: "Create branch" }).click();
    await dialog.waitFor();
    await page.keyboard.type("feature/aus dem panel");
    await page.keyboard.press("Enter");
    await eventually(async () => clean.git("branch", "--list", "feature/aus-dem-panel", "--format=%(refname:short)"), "feature/aus-dem-panel", "Local \"+\" creates a branch (verified in the repository)");
    await eventually(() => row("refs/heads/feature/aus-dem-panel").count(), 1, "… and it appears in the panel");
    await dialog.waitFor({ state: "detached" });

    await sectionEl("tags").locator("[data-section-header]").hover();
    await sectionEl("tags").getByRole("button", { name: "Create tag at current commit" }).click();
    await dialog.waitFor();
    await page.keyboard.type("v0.3.0");
    await dialog.getByRole("button", { name: "Create tag" }).click();
    await eventually(async () => clean.git("tag", "--list", "v0.3.0"), "v0.3.0", "Tags \"+\" creates a tag at HEAD (verified in the repository)");
    equal(clean.git("rev-parse", "v0.3.0^{commit}"), clean.git("rev-parse", "HEAD"), "… on the checked-out commit");
    await eventually(() => row("refs/tags/v0.3.0").count(), 1, "… and it appears in the panel");
    await dialog.waitFor({ state: "detached" });

    await sectionEl("remote").locator("[data-section-header]").hover();
    await sectionEl("remote").getByRole("button", { name: "Add remote" }).click();
    equal(await page.evaluate(() => window.__gc.store.getState().overlay), { kind: "add_remote" }, "Remote \"+\" opens the add dialog (openOverlay add_remote)");
    await page.evaluate(() => window.__gc.store.getState().closeOverlay());
    await page.getByRole("dialog").waitFor({ state: "detached" }).catch(() => undefined);

    await sectionEl("stashes").locator("[data-section-header]").hover();
    await sectionEl("stashes").getByRole("button", { name: "Stash changes" }).click();
    equal((await tabView(tabId)).rightPanel, "stash_form", "Stashes \"+\" opens the stash form (openStashForm)");
    await page.evaluate((id) => window.__gc.store.getState().setRightPanel(id, "details"), tabId);
    await closeToasts();
  });

  await section("Dragging a branch onto another", async () => {
    const source = row("refs/heads/feature/luftdruck");
    const target = row("refs/heads/main");
    const from = await source.boundingBox();
    const to = await target.boundingBox();
    const headBefore = clean.git("rev-parse", "HEAD");

    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + from.height / 2 + 12, { steps: 4 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
    await eventually(() => page.locator("[data-drag-ghost]").count(), 1, "while dragging, a label follows the pointer");
    await eventually(() => target.getAttribute("data-drop-target"), "", "the target is marked");
    equal(await source.getAttribute("data-dragging"), "", "the source too");
    await app.screenshot(`${SHOTS}/sidebar-drag.png`);
    await page.keyboard.press("Escape");
    await eventually(() => page.locator("[data-drag-ghost]").count(), 0, "Esc cancels the drag");
    await page.mouse.up();
    await page.waitForTimeout(300);
    equal(await menu().count(), 0, "no menu opens after Esc");

    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + from.height / 2 + 12, { steps: 4 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
    await eventually(() => target.getAttribute("data-drop-target"), "", "second attempt: target marked");
    await page.mouse.up();
    await menu().waitFor();
    const text = (await menu().innerText()).replace(/\s+/g, " ");
    check(text.includes("feature/luftdruck") && text.includes("main"), `drop menu at the drop point names both branches ("${text}")`);
    const box = await menu().boundingBox();
    check(Math.abs(box.x - (to.x + 60)) < 40 && Math.abs(box.y - (to.y + to.height / 2)) < 40, "… and sits at the drop point");
    await app.screenshot(`${SHOTS}/sidebar-drop-menu.png`);
    await closeMenu();
    equal(clean.git("rev-parse", "HEAD"), headBefore, "without a choice nothing happens in the repository");
    equal(clean.git("status", "--porcelain"), "", "… and the working tree stays clean");
    equal(await page.locator("[data-drag-ghost]").count(), 0, "the label is gone");

    // A tag is not a target
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    const tag = await row("refs/tags/v0.1.0").boundingBox();
    await page.mouse.move(from.x + 70, from.y + from.height / 2 + 12, { steps: 4 });
    await page.mouse.move(tag.x + 60, tag.y + tag.height / 2, { steps: 8 });
    await page.waitForTimeout(200);
    equal(await row("refs/tags/v0.1.0").getAttribute("data-drop-target"), null, "a tag is not marked as a target");
    await page.mouse.up();
    await page.waitForTimeout(200);
    equal(await menu().count(), 0, "… and no menu opens");
  });

  await section("Row context menus", async () => {
    for (const [id, pattern, name] of [
      ["refs/heads/feature/luftdruck", /hide/i, "local branch"],
      ["refs/remotes/origin/main", /hide/i, "remote branch"],
      ["refs/tags/v0.1.0", /hide/i, "tag"],
      ["remote:origin", /Collapse/, "remote"],
      ["dir:local/feature", /Collapse/, "folder"],
    ]) {
      await row(id).click({ button: "right" });
      await menu().waitFor();
      const items = await menuItems();
      check(items.some((text) => pattern.test(text)), `${name}: menu with ${pattern} (${items.join(" | ")})`);
      if (id === "refs/heads/feature/luftdruck") await app.screenshot(`${SHOTS}/sidebar-menu.png`);
      await closeMenu();
    }
    // Right-click on empty space: neither our menu nor the WebView's
    const prevented = await page.evaluate(() => {
      const body = document.querySelector("[data-left-scroll] > div");
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 850 });
      body.dispatchEvent(event);
      return event.defaultPrevented;
    });
    equal(prevented, true, "empty space: no WebView menu");
    equal(await menu().count(), 0, "… and none of ours");
  });

  // ===============================================================================================
  await section("State: repository without a commit", async () => {
    await open(empty);
    equal(await rowIds("local"), ["head:unborn"], "Local: only the branch without a commit");
    const unborn = row("head:unborn");
    equal(await unborn.getAttribute("aria-current"), "true", "it counts as checked out");
    check(/main/.test(await unborn.innerText()) && /no commit yet/.test(await unborn.innerText()), "… and says \"no commit yet\"");
    equal(await headerText("local"), "LOCAL 1", "count 1");
    const remote = sectionEl("remote").locator("[data-empty]");
    check(/No remote yet/.test(await remote.innerText()), "Remote: \"No remote yet\"");
    await remote.getByRole("button", { name: "Add remote" }).click();
    equal(await page.evaluate(() => window.__gc.store.getState().overlay), { kind: "add_remote" }, "… with the action \"Add remote\"");
    await page.evaluate(() => window.__gc.store.getState().closeOverlay());
    equal((await sectionEl("tags").locator("[data-empty]").innerText()).trim(), "No tags", "Tags empty in one line");
    equal((await sectionEl("stashes").locator("[data-empty]").innerText()).trim(), "No stashes", "Stashes empty in one line");
    await unborn.dblclick();
    await page.waitForTimeout(300);
    equal(await toasts("danger"), [], "double-clicking the branch without a commit triggers nothing");
    await page.mouse.move(700, 500);
    await app.screenshot(`${SHOTS}/sidebar-empty.png`);
  });

  await section("State: very long names", async () => {
    await open(long);
    const branch = row(`refs/heads/${LONG_BRANCH}`);
    await branch.waitFor();
    equal(await overflowX(), { panel: 0, page: 0 }, "no horizontal overflow");
    const label = branch.locator("span.truncate").first();
    check(await label.evaluate((element) => element.scrollWidth > element.clientWidth), "the long name is truncated");
    await hoverTip(label);
    await eventuallyTrue(async () => (await tooltip()).includes(LONG_BRANCH), "tooltip shows the full name");
    await leave();
    const stash = sectionEl("stashes").locator("[data-row-id]").first();
    check(await stash.locator("span.truncate").first().evaluate((element) => element.scrollWidth > element.clientWidth), "200-character stash message is truncated");
    equal((await stash.boundingBox()).height, 40, "the row keeps its two-line height");
    equal(await row("refs/heads/team/auswertung/winterhalbjahr/station-nord/temperatur/tagesmittel-neu-berechnen").getAttribute("aria-level"), "6", "deeply nested folders");
    await row(`refs/tags/${LONG_TAG}`).scrollIntoViewIfNeeded();
    await hoverTip(row("refs/tags/v9.9.9").locator("span.truncate").first());
    await eventuallyTrue(async () => /Zweiter Absatz/.test(await tooltip()), "multi-line annotation in the tooltip");
    await leave();
    await panel().locator("[data-left-scroll]").evaluate((element) => (element.scrollTop = 0));
    await app.screenshot(`${SHOTS}/sidebar-long.png`);
    // Long names when renaming
    await branch.focus();
    await page.keyboard.press("F2");
    const input = panel().locator("[data-rename-input]");
    await input.waitFor();
    equal(await overflowX(), { panel: 0, page: 0 }, "input with a long name does not break the panel");
    await page.keyboard.press("Escape");
  });

  await section("State: 600 branches – virtualized, measured", async () => {
    const started = Date.now();
    await open(many);
    const openMs = Date.now() - started;
    check(/^LOCAL 60\d$/.test(await headerText("local")), `count in the header (${await headerText("local")})`);
    equal(await sectionEl("local").locator("[data-virtual]").count(), 1, "the list is virtualized");
    const rendered = await sectionEl("local").locator("[data-row-id]").count();
    check(rendered < 80, `only a window of the ${MANY} rows is in the DOM (${rendered})`);
    await app.screenshot(`${SHOTS}/sidebar-many.png`);

    // Scrolling: 120 px per frame, measure the time per frame
    const frames = await panel().locator("[data-left-scroll]").evaluate(
      (scroller) =>
        new Promise((resolve) => {
          const times = [];
          let last = performance.now();
          let blank = 0;
          const step = () => {
            const now = performance.now();
            times.push(now - last);
            last = now;
            // Is there a row in the window after the frame? (no blank areas)
            const box = scroller.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + 60, box.top + box.height / 2);
            if (!hit?.closest("[data-row-id], [data-section-header]")) blank++;
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 || times.length > 400) return resolve({ times, blank, height: scroller.scrollHeight });
            scroller.scrollTop += 120;
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    const sorted = [...frames.times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(`  measured: open until done ${openMs} ms; scrolling over ${frames.height} px in ${frames.times.length} frames, median ${median.toFixed(1)} ms, 95 % below ${p95.toFixed(1)} ms, largest ${sorted[sorted.length - 1].toFixed(1)} ms; blank frames ${frames.blank}`);
    check(median < 34, `scrolling stays smooth: median per frame ${median.toFixed(1)} ms (limit 34 ms)`);
    check(frames.blank <= 2, `no blank area remains while scrolling (${frames.blank} frames without a row)`);
    check((await sectionEl("local").locator("[data-row-id]").count()) < 80, "only a window in the DOM after scrolling too");

    // Keyboard across the whole list
    await panel().locator("[data-left-scroll]").evaluate((element) => (element.scrollTop = 0));
    await filter().focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await eventuallyTrue(async () => /^refs\/tags\/archiv-040$/.test(await focusedRow()), "End jumps to the very last row and renders it");
    await page.keyboard.press("Home");
    await eventually(focusedRow, "dir:local/feature", "Home back to the first");
    await row("dir:local/thema").focus();
    await page.keyboard.press("ArrowDown");
    for (let index = 0; index < 60; index++) await page.keyboard.press("ArrowDown");
    await eventually(focusedRow, "refs/heads/thema/zweig-0061", "60 × arrow down: focus moves along, also out of the rendered window");
    check(await row("refs/heads/thema/zweig-0061").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const scroller = element.closest("[data-left-scroll]").getBoundingClientRect();
      return box.top >= scroller.top + 20 && box.bottom <= scroller.bottom;
    }), "the focused row is visible and not covered by the section header");

    // Filtering across all 600
    const filterStart = Date.now();
    await filter().fill("zweig-0599");
    await eventually(() => rowIds("local"), ["dir:local/thema", "refs/heads/thema/zweig-0599"], "filter finds one of 600");
    console.log(`  measured: filter over ${MANY} branches until displayed ${Date.now() - filterStart} ms`);
    await row("refs/heads/thema/zweig-0599").dblclick();
    await eventually(async () => many.git("rev-parse", "--abbrev-ref", "HEAD"), "thema/zweig-0599", "checkout from the filtered long list (verified in the repository)");
    await filter().fill("");
    await eventually(() => sectionEl("local").locator("[data-virtual]").count(), 1, "virtualized again without a filter");
    await closeToasts();
  });

  await section("States: loading and error (simulated at the core boundary)", async () => {
    // refsList hangs until the test releases it – meanwhile the panel shows skeleton rows. The method on
    // the UI's core object (window.__gc.core) is replaced; everything else still goes to the real core.
    await page.evaluate(() => {
      const core = window.__gc.core;
      const original = (input) => window.__TAURI_INTERNALS__.invoke("refs_list", input);
      window.__s05 = { mode: "hold", release: null };
      core.refsList = (input) => {
        if (window.__s05.mode === "pass") return original(input);
        if (window.__s05.mode === "fail") return Promise.reject(Object.assign(new Error("The repository's refs could not be read (simulated error)."), { code: "io", gitOutput: null }));
        return new Promise((resolve, reject) => {
          window.__s05.release = () => original(input).then(resolve, reject);
        });
      };
    });
    const opened = await app.invoke("repo_open", { path: rich.path });
    await page.waitForFunction((tabId) => document.querySelector(`[data-tab-id="${tabId}"] [role="tab"]`)?.getAttribute("aria-selected") === "true", opened.tab.id);
    await page.evaluate((id) => {
      void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "refs"] });
    }, opened.repo.id);
    await eventuallyTrue(async () => (await panel().locator("[data-skeleton]").count()) >= 3, "while loading, Local, Remote and Tags show skeleton rows");
    equal(await panel().locator('[role="status"] svg.animate-spin').count(), 0, "no spinner");
    equal(await panel().locator("[data-section]").count(), 4, "the section headers are already there");
    await app.screenshot(`${SHOTS}/sidebar-loading.png`);
    await page.evaluate(() => {
      window.__s05.mode = "pass";
      window.__s05.release?.();
    });
    await eventually(() => panel().locator('[data-section="local"] [data-skeleton]').count(), 0, "they disappear after the answer");
    await eventually(() => row("refs/heads/main").count(), 1, "… and the rows are there");

    await page.evaluate((id) => {
      window.__s05.mode = "fail";
      void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "refs"] }).catch(() => undefined);
    }, opened.repo.id);
    const error = panel().locator("[data-load-error]");
    await error.waitFor();
    check(/Could not load branches and tags/.test(await error.innerText()), "error state says what failed");
    check(/could not be read/.test(await error.innerText()), "… and shows the core's message");
    equal(await sectionEl("stashes").count(), 1, "what is loaded (stashes) stays");
    equal(await sectionEl("local").count(), 0, "sections without data are not left standing empty");
    await app.screenshot(`${SHOTS}/sidebar-error.png`);
    await page.evaluate(() => (window.__s05.mode = "pass"));
    await error.getByRole("button", { name: "Try again" }).click();
    await eventually(() => row("refs/heads/main").count(), 1, "\"Try again\" reloads");
    equal(await error.count(), 0, "the error message is gone");
    await page.evaluate(() => {
      delete window.__gc.core.refsList;
    });
    // The simulated error does not reach the console as a query message; if it does, it does not count.
    for (let index = app.consoleErrors.length - 1; index >= 0; index--) if (/simulated error/.test(app.consoleErrors[index])) app.consoleErrors.splice(index, 1);
  });

  await section("Window sizes: 960×600, collapsing and expanding the panel", async () => {
    await app.setSize(960, 600);
    await eventually(() => panel().count(), 0, "below 1100 px the sidebar collapses on its own");
    await page.keyboard.press("Control+Alt+f");
    await eventually(() => page.evaluate(() => document.activeElement?.hasAttribute("data-left-filter") ?? false), true, "Ctrl+Alt+F brings the panel back and jumps into the filter");
    await eventuallyTrue(ready, "panel has loaded");
    equal(await overflowX(), { panel: 0, page: 0 }, "no horizontal overflow at 960×600");
    const box = await page.locator('[data-area="left"]').boundingBox();
    check(box.width >= 180 && box.height > 400, `panel has room (${Math.round(box.width)}×${Math.round(box.height)})`);
    await page.keyboard.press("ArrowDown");
    await row("refs/heads/main").click();
    await app.settle().catch(() => undefined);
    await app.screenshot(`${SHOTS}/sidebar-min.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/sidebar-min-light.png`);
    await app.setTheme("dark");
    await app.setSize(1440, 900);
  });

  current = "Console";
  check(app.consoleErrors.length === 0, `Console errors:\n${app.consoleErrors.join("\n")}`);
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/sidebar-fehler.png").catch(() => undefined);
  await app?.close().catch(() => undefined);
  for (const repo of repos) repo.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures.length ? `\nS05 failed: ${failures.length} deviations (image: target/e2e/sidebar-fehler.png).\n${failures.map((line) => ` - ${line}`).join("\n")}` : "\nS05 green.");
process.exit(failures.length ? 1 : 0);
