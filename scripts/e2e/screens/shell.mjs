/**
 * shell – shell: start focus, alias right on the tab, tab titles truncated in the middle, Git hooks
 * visible, system notifications. In the real app against real Git repositories.
 *
 *   node scripts/e2e/screens/shell.mjs                 everything
 *   node scripts/e2e/screens/shell.mjs --only alias    only sections whose title contains “alias”
 *   node scripts/e2e/screens/shell.mjs --show          visible window
 *   node scripts/e2e/screens/shell.mjs --no-shots      without screenshots
 *
 * Also checked outside the UI: core entries (repo_list, tabs_list, settings_get), the title of the
 * real window, `git` in the repository (refs, status, hook logs), the remote.
 * The sections “Start focus”, “Alias: keyboard only” and “Hooks: commit” use no mouse.
 * Screenshots: target/e2e/shots/shell-*.png
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appBinary, launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { createRun, sleep } from "./mustfix-lib.mjs";
import { makeWorkspace } from "./repo-entry-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("shell", { argv });
const { check, equal, eventually, section, waitDialog, waitToast, shot } = t;

const ws = makeWorkspace("shell");
const dataDir = ws.dir("daten");
const cleanups = [() => ws.cleanup()];
const made = (repo) => {
  cleanups.push(() => repo.cleanup());
  return repo;
};

let app = null;
let page = null;

const start = async (options = {}) => {
  const launch = () => launchApp({ show, width: 1440, height: 900, theme: "dark", ...options });
  try {
    app = await launch();
  } catch (error) {
    // Other processes may save files meanwhile: if the page loads a half-written state, it stays empty.
    // A second start is then the honest attempt; if it fails too, it is an error.
    console.log(`    (start failed, second attempt: ${String(error?.message ?? error).split("\n")[0]})`);
    await sleep(3000);
    app = await launch();
  }
  page = app.page;
  t.attach(app);
  // Auto-fetch should only run where a section explicitly turns it on.
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  return app;
};
const stop = async () => {
  if (app) await app.close().catch(() => undefined);
  app = null;
  page = null;
};

/** Where is the focus – and is it visible? */
const focus = () =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { tag: "BODY", role: null, label: "", visible: false, inGraph: false, rowId: null };
    return {
      tag: element.tagName,
      role: element.getAttribute("role"),
      label: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
      visible: element.matches(":focus-visible"),
      inGraph: Boolean(element.closest("[data-graph-scroller]")),
      rowId: element.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null,
    };
  });
const press = async (key) => {
  await page.keyboard.press(key);
  await sleep(40);
};
/** Presses `key` until the focused element matches (the check runs in the page). */
const pressUntil = async (key, matches, what, max = 30) => {
  for (let count = 0; count <= max; count++) {
    if (await page.evaluate((source) => Boolean(new Function("el", `return (${source})(el)`)(document.activeElement)), matches.toString())) return true;
    await press(key);
  }
  return check(false, `${what}: not reached with ${max}× ${key} (focus: ${JSON.stringify(await focus())})`);
};
/** In the open menu, arrow keys to the entry whose label starts like this, then Enter. */
const menuChoose = async (label) => {
  await page.locator('[role="menu"]').first().waitFor({ timeout: 10_000 });
  for (let step = 0; step < 30; step++) {
    const highlighted = await page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted]')?.textContent?.trim() ?? null);
    if (highlighted?.startsWith(label)) {
      await press("Enter");
      await eventually(() => page.locator('[role="menu"]').count(), 0, "the menu closes after the choice");
      return true;
    }
    await press("ArrowDown");
  }
  return check(false, `menu entry “${label}” not reached with the arrow keys`);
};
const menuEntries = () =>
  page
    .getByRole("menu")
    .last()
    .locator('[role="menuitem"]')
    .evaluateAll((list) => list.map((item) => ({ text: (item.innerText ?? "").replace(/\s+/g, " ").trim(), disabled: item.hasAttribute("data-disabled") })));
const tabs = () => app.invoke("tabs_list");
const repos = () => app.invoke("repo_list");
const activeTabText = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("aria-label") ?? null);
const renameInput = () => page.locator("[data-tab-rename]");
const tabButton = (name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const selection = (tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.selection ?? { kind: "wip" }, tabId);

try {
  // -------------------------------------------------------------------------
  await section("Start focus: without a repository on “Open …”, with a repository in the graph – keyboard only", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "startfokus" }));
    await start({ dataDir });
    equal((await tabs()).map((tab) => tab.kind), ["management"], "fresh start: only repository management");
    await eventually(() => focus().then((info) => info.label), "Open …", "on start, focus is on the first action “Open …”");
    check((await focus()).visible, "the focus is visible (:focus-visible)");
    equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== "none"), true, "with focus ring");
    await shot("shell-start-focus");

    // Enter opens the folder dialog (in the test: prepared answer); then the focus is in the graph.
    await app.pick(repo.path);
    await press("Enter");
    await tabButton("startfokus").waitFor({ timeout: 30_000 });
    await eventually(() => focus().then((info) => info.inGraph), true, "after opening, focus is in the graph");
    check((await focus()).visible, `it is visible there too (${JSON.stringify(await focus())})`);
    const [tab] = (await tabs()).filter((item) => item.isActive);
    // The keyboard works right away: arrow down selects the top commit.
    await app.settle();
    await press("ArrowDown");
    await eventually(() => selection(tab.id).then((value) => value?.kind), "commits", "arrow down selects a commit without further ado");
    equal((await selection(tab.id)).shas, [repo.git("rev-list", "--all", "--date-order", "-n", "1")], "it is the top commit of the graph (git rev-list --all -n 1)");

    // Restart with the same data directory: the app comes back with the repository tab – focus in the graph.
    await stop();
    await start({ dataDir });
    await tabButton("startfokus").waitFor({ timeout: 30_000 });
    equal((await tabs()).find((item) => item.isActive)?.title, "startfokus", "after the restart the repository tab is active again");
    await eventually(() => focus().then((info) => info.inGraph && info.role === "row"), true, "start with an open repository: focus is on a graph row");
    check((await focus()).visible, "and is visible");
    await shot("shell-start-focus-repo");
    await press("ArrowDown");
    const restarted = (await tabs()).find((item) => item.isActive);
    await eventually(() => selection(restarted.id).then((value) => value?.kind), "commits", "here too the first key works right away");

    // The start focus applies exactly once: whoever removes the focus afterwards (click into empty space) keeps it that way.
    await blur();
    await sleep(600);
    equal((await focus()).tag, "BODY", "after deliberately removing it, nothing takes the focus back");
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  // -------------------------------------------------------------------------
  await section("Alias: keyboard only – F2 on the tab, Enter applies, empty resets, Esc discards", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "messnetz" }));
    await start();
    const { repoId } = await app.openRepo(repo.path);
    const alias = async () => (await repos()).find((item) => item.id === repoId)?.alias ?? null;
    // No click, not even to dismiss: success messages disappear on their own after five seconds.
    const toastsGone = () => eventually(() => page.locator("[data-toast]").count(), 0, "the message disappears on its own", 9000);

    await eventually(() => focus().then((info) => info.inGraph), true, "focus is in the graph");
    // F6 to the toolbar, from there Shift+Tab back into the tab bar.
    await pressUntil("F6", (el) => Boolean(el?.closest('[data-shell] > [role="toolbar"]')), "F6 reaches the toolbar", 6);
    await pressUntil("Shift+Tab", (el) => el?.getAttribute("role") === "tab", "Shift+Tab reaches the tab", 8);
    equal((await focus()).label, "messnetz", "focus is on the tab “messnetz”");
    equal(await tabButton("messnetz").getAttribute("aria-keyshortcuts"), "F2", "the tab names its shortcut (aria-keyshortcuts)");

    await press("F2");
    await renameInput().waitFor();
    equal(await renameInput().evaluate((input) => input === document.activeElement), true, "F2 opens the input right on the tab, with focus");
    equal(await renameInput().inputValue(), "messnetz", "prefilled with the current title");
    equal(await renameInput().evaluate((input) => input.selectionStart === 0 && input.selectionEnd === input.value.length), true, "the text is selected – typing replaces it");
    equal(await renameInput().getAttribute("aria-label"), "Alias for messnetz", "the field has a label");
    equal(await page.locator('[data-tab-id]:has([data-tab-rename]) button[aria-label^="Close "]').isVisible(), false, "while editing, the width belongs to the field – the close button is hidden");
    equal(await page.locator('[data-tab-id]:has([data-tab-rename]) [role="tab"]').count(), 1, "the tab stays available for screen readers");
    await page.keyboard.type("Messnetz der Schulen");
    await shot("shell-tab-rename");
    await press("Enter");
    await waitToast(/Tab is now called “Messnetz der Schulen”/, "success");
    await eventually(alias, "Messnetz der Schulen", "the alias is stored in the core (repo_list)");
    await eventually(activeTabText, "Messnetz der Schulen", "the tab shows the alias");
    equal((await tabs()).find((item) => item.isActive)?.title, "Messnetz der Schulen", "tabs_list has the alias as title");
    await eventually(() => app.windowTitle(), "Messnetz der Schulen – forkyard", "the title of the real window follows");
    await eventually(() => focus().then((info) => `${info.role}:${info.label}`), "tab:Messnetz der Schulen", "after Enter, focus is back on the tab");
    check(fs.existsSync(path.join(repo.path, ".git")) && path.basename(repo.path) === "messnetz", "the folder on disk is still called “messnetz”");
    equal(repo.git("status", "--porcelain"), "", "nothing changed in the repository (git status)");
    await toastsGone();

    // Esc discards.
    await press("F2");
    await renameInput().waitFor();
    await page.keyboard.type("Doch nicht");
    await press("Escape");
    await eventually(() => renameInput().count(), 0, "Esc closes the field");
    await sleep(200);
    equal(await alias(), "Messnetz der Schulen", "Esc changes nothing");
    equal(await t.toasts(), [], "and reports nothing");
    await eventually(() => focus().then((info) => info.role), "tab", "focus is back on the tab");

    // Confirmed unchanged: nothing to do, no message.
    await press("F2");
    await renameInput().waitFor();
    await press("Enter");
    await eventually(() => renameInput().count(), 0, "Enter closes the field");
    await sleep(200);
    equal(await t.toasts(), [], "an unchanged alias triggers nothing");

    // Empty resets: the placeholder shows what the tab will be called.
    await press("F2");
    await renameInput().waitFor();
    await press("Control+a");
    await press("Backspace");
    equal(await renameInput().inputValue(), "", "the field is empty");
    equal(await renameInput().getAttribute("placeholder"), "messnetz", "the placeholder names the folder");
    await shot("shell-tab-rename-empty");
    await press("Enter");
    await waitToast(/Alias removed/, "success");
    await eventually(alias, null, "empty alias: removed in the core (repo_list)");
    await eventually(activeTabText, "messnetz", "the tab is named after the folder again");
    await eventually(() => app.windowTitle(), "messnetz – forkyard", "so is the window title");
    await toastsGone();

    // Context menu by keyboard (Shift+F10): “Rename …” opens the same field.
    await eventually(() => focus().then((info) => info.role), "tab", "focus on the tab");
    await press("Shift+F10");
    await page.getByRole("menu").waitFor();
    const entries = await menuEntries();
    check(entries.some((entry) => entry.text.startsWith("Rename …") && entry.text.includes("F2") && !entry.disabled), `the tab menu has “Rename …” with shortcut: ${JSON.stringify(entries.map((entry) => entry.text))}`);
    check(!entries.some((entry) => entry.text.startsWith("Remove alias")), "without an alias there is no “Remove alias”");
    await shot("shell-tab-menu");
    await menuChoose("Rename");
    await renameInput().waitFor();
    await eventually(() => renameInput().evaluate((input) => input === document.activeElement), true, "from the menu: the field has focus");
    await page.keyboard.type("Wetter");
    await press("Enter");
    await eventually(alias, "Wetter", "alias set from the menu");
    await toastsGone();
    // With alias: “Change alias …” and “Remove alias”.
    await eventually(() => focus().then((info) => info.role), "tab", "focus on the tab");
    await press("Shift+F10");
    await page.getByRole("menu").waitFor();
    const withAlias = (await menuEntries()).map((entry) => entry.text);
    check(withAlias.some((text) => text.startsWith("Change alias …")) && withAlias.some((text) => text.startsWith("Remove alias") && text.includes("messnetz")), `with alias: change and remove (names the folder): ${JSON.stringify(withAlias)}`);
    await menuChoose("Remove alias");
    await waitToast(/Alias removed/, "success");
    await eventually(alias, null, "“Remove alias” resets");
    await toastsGone();

    // Command palette: “Rename tab” opens the same field – from anywhere, including the graph.
    await press("Alt+2");
    await eventually(() => focus().then((info) => info.inGraph), true, "Alt+2: focus in the graph");
    await press("F1");
    await page.getByRole("dialog").waitFor();
    await page.keyboard.type("Rename tab");
    await eventually(() => page.evaluate(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? ""), (text) => text.includes("Rename tab (alias)"), "the palette finds “Rename tab (alias) …”");
    await press("Enter");
    await renameInput().waitFor();
    await eventually(() => renameInput().evaluate((input) => input === document.activeElement), true, "from the palette: the field on the tab has focus");
    await page.keyboard.type("Aus der Palette");
    await press("Enter");
    await eventually(alias, "Aus der Palette", "alias set via the command palette");
    await eventually(() => focus().then((info) => info.role), "tab", "afterwards focus is on the tab");
    await press("F2");
    await renameInput().waitFor();
    await press("Control+a");
    await press("Backspace");
    await press("Enter");
    await eventually(alias, null, "and reset again");
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Alias: mouse (double-click, click outside applies), very long alias, list in repo-management, light and 960×600", async () => {
    const repoId = (await repos()).find((item) => item.name === "messnetz")?.id;
    const alias = async () => (await repos()).find((item) => item.id === repoId)?.alias ?? null;
    await t.closeToasts();
    await tabButton("messnetz").dblclick();
    await renameInput().waitFor();
    await renameInput().fill("Per Maus benannt");
    // Clicking outside (into the graph) applies, like renaming in a file manager.
    await page.locator("[data-graph-scroller]").click({ position: { x: 600, y: 300 } });
    await eventually(alias, "Per Maus benannt", "clicking outside applies the input");
    await eventually(() => renameInput().count(), 0, "the field is closed");
    await t.closeToasts();

    // Very long alias: at most 80 characters, the tab truncates in the middle, nothing overflows.
    const long = "Messnetz der drei Schulstationen Nord, Süd und Hafen – Auswertung Winter 2025/2026 (Archiv)";
    await tabButton("Per Maus benannt").dblclick();
    await renameInput().waitFor();
    equal(await renameInput().getAttribute("maxlength"), "80", "the field takes at most 80 characters");
    await renameInput().fill(long);
    equal((await renameInput().inputValue()).length <= 80, true, "longer input is cut off");
    await shot("shell-tab-rename-long");
    await page.keyboard.press("Enter");
    const stored = long.slice(0, 80).trim();
    await eventually(alias, stored, "the long alias is saved");
    await t.closeToasts();
    const tabBox = await page.locator('[data-tab-id]:has([role="tab"][aria-selected="true"])').boundingBox();
    check(tabBox.width <= 210, `the tab stays at its maximum width (${Math.round(tabBox.width)} px)`);
    const parts = await page.locator('[role="tab"][aria-selected="true"] [data-middle-text] > span').evaluateAll((list) => list.map((item) => ({ text: item.textContent, cut: item.scrollWidth > item.clientWidth })));
    check(parts.length === 2 && parts[0].cut && !parts[1].cut && stored.endsWith(parts[1].text), `the start is truncated, the end stays: ${JSON.stringify(parts)}`);
    equal(await activeTabText(), stored, "the full alias stays the tab's name (aria-label)");
    equal(await t.overflow(), { x: 0, y: 0 }, "no overflow");
    await shot("shell-tab-alias-long");

    // Repository management shows the same alias, followed by the folder name.
    await page.keyboard.press("Control+t");
    await page.locator('[data-screen="repo-management"]').waitFor();
    const row = page.locator(`[data-repo-id="${repoId}"]`);
    await row.waitFor();
    check((await row.innerText()).includes("messnetz") && (await row.getAttribute("aria-label")).startsWith(stored), "the list shows the alias and the folder name");
    await page.keyboard.press("Control+w");
    await tabButton("Messnetz der drei").waitFor();

    await tabButton("Messnetz der drei").dblclick();
    await renameInput().waitFor();
    await renameInput().fill("Messnetz");
    await app.setTheme("light");
    await shot("shell-tab-rename-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600 with open field: no overflow");
    const inputBox = await renameInput().boundingBox();
    check(inputBox.width >= 120 && inputBox.x >= 0 && inputBox.x + inputBox.width <= 960, `the field is fully visible at 960×600 (${Math.round(inputBox.width)} px wide)`);
    await shot("shell-tab-rename-min");
    await app.setSize(1440, 900);
    await page.keyboard.press("Enter");
    await eventually(alias, "Messnetz", "alias “Messnetz”");
    // An alias equal to the folder name is no alias.
    await t.closeToasts();
    await tabButton("Messnetz").dblclick();
    await renameInput().waitFor();
    await renameInput().fill("messnetz");
    await page.keyboard.press("Enter");
    await eventually(alias, null, "exactly the folder name resets the alias");
    // The management tab cannot be renamed.
    await t.closeToasts();
    await page.keyboard.press("Control+t");
    await page.getByRole("tab", { name: "Repositories" }).waitFor();
    await page.getByRole("tab", { name: "Repositories" }).focus();
    await press("F2");
    await sleep(200);
    equal(await renameInput().count(), 0, "F2 on the management tab does nothing");
    await page.getByRole("tab", { name: "Repositories" }).click({ button: "right" });
    await page.getByRole("menu").waitFor();
    check(!(await menuEntries()).some((entry) => /Rename|Alias/.test(entry.text)), "its menu offers no rename");
    await press("Escape");
    await page.keyboard.press("Control+w");
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  // -------------------------------------------------------------------------
  await section("Many similar tabs: titles truncated in the middle, the end stays readable", async () => {
    await start();
    const names = Array.from({ length: 14 }, (_, index) => `station-${String(index + 1).padStart(2, "0")}`);
    for (const name of names) await app.invoke("repo_open", { path: ws.repo(`viele/${name}`) });
    const other = ["kundenportal-frontend-2025", "kundenportal-frontend-2026"];
    for (const name of other) await app.invoke("repo_open", { path: ws.repo(`viele/${name}`) });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await app.invoke("repo_open", { path: ws.repo("viele/kurz") });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await eventually(() => page.locator('[role="tab"]').count(), 17, "17 repository tabs");
    // The second-to-last tab becomes active: the long names and the last stations are then in the visible part.
    await page.keyboard.press("Control+9");
    await page.getByRole("tab", { name: "kurz", selected: true }).waitFor();
    await app.settle();
    const shown = () =>
      page.locator("[data-tab-id]").evaluateAll((list) => {
        const strip = document.querySelector('[role="tablist"]').getBoundingClientRect();
        return list
          .map((item) => {
            const tab = item.querySelector('[role="tab"]');
            const text = tab.querySelector("[data-middle-text]");
            const [head, tail] = text.children.length === 2 ? [...text.children] : [text, null];
            const box = (tail ?? head).getBoundingClientRect();
            return {
              name: tab.getAttribute("aria-label"),
              full: text.textContent,
              tail: tail ? tail.textContent : null,
              headCut: head.scrollWidth > head.clientWidth,
              tailCut: tail ? tail.scrollWidth > tail.clientWidth + 1 : false,
              tailVisible: box.width > 0 && box.left >= strip.left - 1 && box.right <= strip.right + 1,
            };
          })
          .filter((item) => item.tailVisible);
      });
    const visible = await shown();
    const stations = visible.filter((item) => item.name.startsWith("station-"));
    check(stations.length >= 8, `at least eight station tabs are in the visible part of the bar (${stations.length})`);
    check(stations.every((item) => item.full === item.name), "the full name stays in the tab (for search and screen readers)");
    check(stations.every((item) => item.tail && /^-\d\d$/.test(item.tail) && !item.tailCut), `every tab shows its end untruncated (“-01” … “-14”): ${JSON.stringify(stations.map((item) => item.tail))}`);
    equal(new Set(stations.map((item) => item.tail)).size, stations.length, "the visible ends are all different – the tabs can be told apart");
    const portals = visible.filter((item) => item.name.startsWith("kundenportal"));
    check(portals.length === 2 && portals[0].tail === "-2025" && portals[1].tail === "-2026", `long names with the same start: the year stays: ${JSON.stringify(portals.map((item) => item.tail))}`);
    check(portals.every((item) => item.headCut && !item.tailCut), "the start is truncated (“ku…”), not the end");
    equal(await t.overflow(), { x: 0, y: 0 }, "no overflow");
    await page.mouse.move(700, 500);
    await shot("shell-tabs-middle");
    await app.setTheme("light");
    await shot("shell-tabs-middle-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no overflow");
    const narrow = (await shown()).filter((item) => item.name.startsWith("station-") || item.name.startsWith("kundenportal"));
    check(narrow.length >= 4 && narrow.every((item) => item.tail && !item.tailCut), `960×600: the ends stay readable there too (${narrow.map((item) => item.tail).join(" ")})`);
    await shot("shell-tabs-middle-min");
    await app.setSize(1440, 900);
    // Short names stay whole, without splitting.
    equal(await page.getByRole("tab", { name: "kurz" }).locator("[data-middle-text]").evaluate((item) => `${item.children.length}:${item.textContent}`), "0:kurz", "a short name stays unsplit");
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  // -------------------------------------------------------------------------
  // Git hooks: real scripts in the hooks folder of the fixture repository.
  // -------------------------------------------------------------------------
  const hookRepo = { repo: null, repoId: null, tabId: null };
  const hookFile = (name) => path.join(hookRepo.repo.path, ".git", "hooks", name);
  const writeHook = (name, body) => {
    fs.mkdirSync(path.dirname(hookFile(name)), { recursive: true });
    fs.writeFileSync(hookFile(name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const removeHook = (name) => fs.rmSync(hookFile(name), { force: true });
  const hookLog = () => {
    try {
      return fs.readFileSync(path.join(hookRepo.repo.path, ".git", "hook-protokoll.txt"), "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };
  const dangerToasts = () => t.toasts().then((list) => list.filter((toast) => toast.tone === "danger"));
  const leftRow = (id) => page.locator(`[data-screen="sidebar"] [data-row-id="${id}"]`);
  const graphRow = (sha) => page.locator(`[data-screen="commit-graph"] [data-row-id="${sha}"]`);
  const menu = () => page.getByRole("menu").last();
  const refreshRepo = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await t.refresh(hookRepo.repoId);
  };
  /** Opens the message's “Show output” and returns the dialog text; closes it again. */
  const readOutput = async (toastTone, title, picture = null) => {
    await page.locator(`[data-toast="${toastTone}"]`).getByRole("button", { name: "Show output" }).first().click();
    const dialog = await waitDialog(title);
    const text = await dialog.locator("pre").innerText();
    if (picture) await shot(picture);
    await page.keyboard.press("Escape");
    await eventually(() => page.getByRole("dialog").count(), 0, "Esc closes the output");
    return text;
  };
  const activity = async () => (await app.invoke("activity_list", { scope: "repo", repoId: hookRepo.repoId, cursor: null, limit: 40 })).entries ?? [];

  await section("Hooks: commit by keyboard only – post-commit writes something and reports its output", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "hooks" }));
    hookRepo.repo = repo;
    writeHook("post-commit", 'betreff=$(git log -1 --format=%s)\necho "$betreff" >> .git/hook-protokoll.txt\necho "post-commit: notiert – $betreff"\necho "Zweite Zeile: Protokoll liegt unter .git/hook-protokoll.txt"');
    await start();
    Object.assign(hookRepo, await app.openRepo(repo.path));
    repo.write("notizen/wartung.md", "# Wartung\n\nSensor Nord am 3. März gereinigt.\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(() => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"])?.unstaged.length ?? -1, hookRepo.repoId), 1, "the app sees the new file");
    await app.settle();
    // Stage everything, write the message, commit – keys only.
    await press("Control+Shift+S");
    await eventually(() => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"])?.staged.length ?? -1, hookRepo.repoId), 1, "Ctrl+Shift+S stages the file");
    await press("Alt+m");
    await eventually(() => focus().then((info) => info.label.startsWith("Summary")), true, "Alt+M puts focus in the summary");
    await page.keyboard.type("Wartung notiert");
    await press("Control+Enter");
    const info = await waitToast(/Hook “post-commit” printed something/, "info");
    check(/post-commit: notiert – Wartung notiert/.test(info?.text ?? ""), `the message shows the first output line: ${info?.text}`);
    check(/Show output/.test(info?.text ?? ""), "and offers “Show output”");
    equal(repo.git("log", "-1", "--format=%s"), "Wartung notiert", "git: the commit is created");
    equal(hookLog(), ["Wartung notiert"], "the hook really wrote (.git/hook-protokoll.txt)");
    equal(await dangerToasts(), [], "no error");
    await shot("shell-hook-output");
    // The message stays until it is read; the full output is in the dialog.
    await sleep(5600);
    check((await t.toasts()).some((toast) => /post-commit/.test(toast.text)), "the message with the hook output stays (longer than five seconds)");
    const output = await readOutput("info", /^Output of post-commit$/, "shell-hook-output-dialog");
    check(output.includes("post-commit: notiert – Wartung notiert") && output.includes("Zweite Zeile: Protokoll liegt unter .git/hook-protokoll.txt"), `the dialog shows the full output: ${JSON.stringify(output)}`);
    await t.closeToasts();
    equal(app.consoleErrors, [], "console errors");
  }, { keep: true });

  await section("Hooks: pre-rebase rejects – rebase, interactive rebase and squash; one message, nothing changed", async () => {
    const { repo } = hookRepo;
    writeHook("pre-rebase", 'echo "pre-rebase: Rebase gesperrt – der Branch ist eingefroren." >&2\necho "Bitte erst mit dem Team sprechen (Hook der Fixture)." >&2\nexit 3');
    // Check out feature/export (double-click); main meanwhile has one more commit.
    await leftRow("refs/heads/feature/export").dblclick();
    await waitToast(/“feature\/export” checked out/, "success");
    await t.closeToasts();
    const before = repo.git("rev-parse", "feature/export");
    await leftRow("refs/heads/main").click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /Rebase “feature\/export” onto “main”/ }).click();
    const refused = await waitToast(/Rebase: rejected by a Git hook/, "danger");
    check(/pre-rebase/.test(refused?.text ?? "") && /exit code 3/.test(refused?.text ?? ""), `the message names the hook and exit code: ${refused?.text}`);
    check(/Rebase gesperrt – der Branch ist eingefroren/.test(refused?.text ?? ""), "and the first line of its output");
    await sleep(700);
    equal((await dangerToasts()).length, 1, "exactly one error message – not one for the hook and one for the rebase");
    equal(repo.git("rev-parse", "feature/export"), before, "git: the branch is unchanged");
    check(!fs.existsSync(path.join(repo.path, ".git", "rebase-merge")) && !fs.existsSync(path.join(repo.path, ".git", "rebase-apply")), "git: no started rebase is left behind");
    equal(repo.git("status", "--porcelain"), "", "git: the working tree is clean");
    await shot("shell-hook-refused");
    await app.setTheme("light");
    await shot("shell-hook-refused-light");
    await app.setTheme("dark");
    const output = await readOutput("danger", /^Output of pre-rebase$/);
    check(output.includes("Rebase gesperrt") && output.includes("Bitte erst mit dem Team sprechen"), `“Show output” shows both lines of the hook: ${JSON.stringify(output)}`);
    // The activity log (activity-log) has the rejected command with the hook's output.
    const entry = (await activity()).find((item) => /^git .*rebase/.test(item.command));
    check(Boolean(entry) && entry.exitCode !== 0 && /Rebase gesperrt/.test(entry.output), `the activity log has the rejected rebase with the hook output: ${JSON.stringify(entry && { command: entry.command, exitCode: entry.exitCode, output: entry.output.slice(0, 120) })}`);
    await t.closeToasts();
    await page.locator("footer").getByRole("button", { name: /Log/ }).click();
    const log = page.locator('[data-screen="activity-log"]');
    await log.waitFor();
    await eventually(async () => /rebase/.test(await log.innerText()), true, "the activity log shows the rebase");
    await shot("shell-hook-log");
    await page.keyboard.press("Escape");
    await log.waitFor({ state: "detached" });

    // Interactive rebase: reword, start – the hook rejects, the tool stays open with the plan.
    const base = repo.git("merge-base", "feature/export", "main");
    await page.evaluate(([id, sha]) => window.__gc.store.getState().openRebase(id, sha, "interactive"), [hookRepo.tabId, base]);
    const tool = page.locator('[data-screen="rebase"]');
    await tool.locator('[role="listbox"]').waitFor({ timeout: 30_000 });
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("role")), "listbox", "focus is in the list");
    await press("r");
    const reword = await waitDialog(/^Reword commit$/);
    await reword.getByLabel("Summary").fill("CSV-Export, umformuliert");
    await press("Control+Enter");
    await eventually(() => page.getByRole("dialog").count(), 0, "the dialog closes");
    await press("Control+Enter");
    // The commit is on origin: first the confirmation, then the hook rejects.
    const ask = await waitDialog(/^Rewrite pushed commits of “feature\/export”\?$/);
    await ask.getByRole("button", { name: "Start rebase" }).click();
    const refusedPlan = await waitToast(/Interactive rebase: rejected by a Git hook/, "danger");
    check(/pre-rebase/.test(refusedPlan?.text ?? "") && /Rebase gesperrt/.test(refusedPlan?.text ?? ""), `interactive rebase: hook and output: ${refusedPlan?.text}`);
    await sleep(700);
    equal((await dangerToasts()).length, 1, "again exactly one error message");
    equal(await page.evaluate((id) => window.__gc.store.getState().views[id]?.center?.kind, hookRepo.tabId), "rebase", "the tool stays open");
    equal(await tool.locator('[role="option"] [data-action]').first().getAttribute("data-action"), "reword", "the plan is still there");
    equal(repo.git("rev-parse", "feature/export"), before, "git: nothing rewritten");
    await shot("shell-hook-refused-plan");
    await t.closeToasts();
    await tool.locator('[role="listbox"]').focus();
    await press("Escape");
    await eventually(() => page.evaluate((id) => window.__gc.store.getState().views[id]?.center?.kind, hookRepo.tabId), "graph", "Esc closes the tool");

    // Squash two local commits on main: same hook, same kind of message.
    await leftRow("refs/heads/main").dblclick();
    await waitToast(/“main” checked out/, "success");
    await t.closeToasts();
    repo.write("notizen/wartung.md", "# Wartung\n\nSensor Nord am 3. März gereinigt.\nSensor Süd am 4. März.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Wartung Süd nachgetragen");
    await refreshRepo();
    const [second, first] = repo.git("rev-list", "-n", "2", "main").split("\n");
    const mainBefore = second;
    await graphRow(second).click();
    await graphRow(first).click({ modifiers: ["Shift"] });
    await graphRow(first).click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /Squash 2 commits/ }).click();
    await tool.locator('[role="listbox"]').waitFor({ timeout: 30_000 });
    await tool.locator('button[data-action="start"]').click();
    const refusedSquash = await waitToast(/Squash: rejected by a Git hook/, "danger");
    check(/pre-rebase/.test(refusedSquash?.text ?? ""), `Squash: ${refusedSquash?.text}`);
    equal(repo.git("rev-parse", "main"), mainBefore, "git: main is unchanged");
    await t.closeToasts();
    await tool.locator('[role="listbox"]').focus();
    await press("Escape");
    removeHook("pre-rebase");
    equal(app.consoleErrors, [], "console errors");
  }, { keep: true });

  await section("Hooks: cherry-pick of several commits (one notice for both runs), revert and tag push rejected", async () => {
    const { repo } = hookRepo;
    // Two commits on a side branch that main does not have yet.
    repo.git("checkout", "-q", "-b", "beitrag", "main~2");
    repo.write("beitraege/eins.md", "eins\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Beitrag eins");
    repo.write("beitraege/zwei.md", "zwei\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Beitrag zwei");
    const [two, one] = repo.git("rev-list", "-n", "2", "beitrag").split("\n");
    repo.git("checkout", "-q", "main");
    fs.rmSync(path.join(repo.path, ".git", "hook-protokoll.txt"), { force: true });
    await refreshRepo();
    await graphRow(one).click();
    await graphRow(two).click({ modifiers: ["Control"] });
    await graphRow(two).click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /Cherry-pick 2 commits/ }).click();
    const tool = page.locator('[data-screen="rebase"]');
    await tool.locator('[role="listbox"]').waitFor({ timeout: 30_000 });
    await tool.locator('button[data-action="start"]').click();
    await waitToast(/Cherry-pick of 2 commits complete/, "success");
    const twice = await waitToast(/Hook “post-commit” printed something/, "info");
    check(Boolean(twice), "two runs of the same hook make ONE message");
    equal((await t.toasts()).filter((toast) => /post-commit/.test(toast.text)).length, 1, "there is only one hook message");
    equal(hookLog(), ["Beitrag eins", "Beitrag zwei"], "the hook ran for both commits (.git/hook-protokoll.txt)");
    equal(repo.git("log", "-2", "--format=%s", "main"), "Beitrag zwei\nBeitrag eins", "git: both commits are on main");
    const both = await readOutput("info", /^Output of post-commit$/);
    check(both.includes("notiert – Beitrag eins") && both.includes("notiert – Beitrag zwei"), `the dialog collects both outputs: ${JSON.stringify(both)}`);
    await shot("shell-hook-cherry-pick");
    await t.closeToasts();

    // Revert: prepare-commit-msg rejects reverts – nothing stays staged, HEAD stays where it was.
    writeHook("prepare-commit-msg", 'if grep -q "^Revert" "$1"; then\n  echo "prepare-commit-msg: Reverts brauchen eine Ticket-Nummer." >&2\n  exit 1\nfi');
    const headBefore = repo.git("rev-parse", "HEAD");
    await refreshRepo();
    await graphRow(headBefore).click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /^Revert/ }).click();
    const refusedRevert = await waitToast(/Revert: rejected by a Git hook/, "danger");
    check(/prepare-commit-msg/.test(refusedRevert?.text ?? "") && /Ticket-Nummer/.test(refusedRevert?.text ?? ""), `revert: hook and output: ${refusedRevert?.text}`);
    await sleep(700);
    equal((await dangerToasts()).length, 1, "exactly one error message");
    equal(repo.git("rev-parse", "HEAD"), headBefore, "git: no revert commit");
    equal(repo.git("status", "--porcelain"), "", "git: nothing is left staged or changed");
    check(!fs.existsSync(path.join(repo.path, ".git", "REVERT_HEAD")), "git: no pending revert");
    await t.closeToasts();
    removeHook("prepare-commit-msg");

    // Tag push: pre-push lets branches through and rejects tags.
    writeHook("pre-push", 'while read lokal sha_lokal remote sha_remote; do\n  case "$remote" in\n    refs/tags/*) echo "pre-push: Tags gehen nur über die Freigabe." >&2; exit 1;;\n  esac\ndone\nexit 0');
    repo.git("tag", "v0.9");
    await refreshRepo();
    await leftRow("refs/tags/v0.9").click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /^Push/ }).click();
    const refusedTag = await waitToast(/Push tag: rejected by a Git hook/, "danger", 60_000);
    check(/pre-push/.test(refusedTag?.text ?? "") && /Tags gehen nur über die Freigabe/.test(refusedTag?.text ?? ""), `tag push: hook and output: ${refusedTag?.text}`);
    equal(repo.git("ls-remote", "--tags", "origin"), "", "git ls-remote: the tag is not on the remote");
    await shot("shell-hook-refused-tag");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600 with message: no overflow");
    await shot("shell-hook-refused-min");
    await app.setSize(1440, 900);
    await t.closeToasts();
    // The same hook lets the branch through: pushing main works.
    await t.toolButton("Push").click();
    await waitToast(/Pushed to origin\/main/, "success", 60_000);
    equal(repo.git("rev-parse", "origin/main"), repo.git("rev-parse", "main"), "git: main is pushed – the hook only rejected the tag");
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  // -------------------------------------------------------------------------
  // System notifications. The invisible test window always counts as “in front”, and what the
  // system really shows cannot be read. So the check uses the redirect
  // `window.__gcTestNotifications`: whether, when and with which texts the app calls the system.
  // -------------------------------------------------------------------------
  await section("Notifications: only in the background, with the message texts, settings take effect", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "melder" }));
    await start();
    const { repoId } = await app.openRepo(repo.path);
    hookRepo.repo = repo;
    hookRepo.repoId = repoId;
    const realUrl = repo.git("remote", "get-url", "origin");
    const deadUrl = "http://127.0.0.1:9/gibt-es-nicht.git";
    // Sending goes through the notification plugin in the Rust part. What does it say about permission?
    const plugin = await page.evaluate(() => window.__gc.core.notifyPermission());
    console.log(`    (plugin: permission “${plugin}”)`);
    check(["granted", "denied", "default"].includes(plugin), `the plugin answers the permission question: ${plugin}`);
    // The settings say honestly what the system allows – and only then promise notifications.
    await press("Control+Comma");
    const honest = page.locator('[data-screen="settings"]');
    await honest.waitFor();
    await honest.getByRole("tab", { name: "Notifications" }).click();
    const sectionState = honest.locator("[data-system-notifications]");
    const wanted = plugin === "granted" ? "granted" : plugin === "denied" ? "blocked" : "unknown";
    await eventually(() => sectionState.getAttribute("data-system-notifications"), wanted, "the state in the settings matches the plugin's answer");
    const state = await sectionState.getAttribute("data-system-notifications");
    const intro = (await sectionState.locator("header").innerText()).replace(/\s+/g, " ");
    console.log(`    (settings: system notifications “${state}”)`);
    check(state === "blocked" ? /blocked for this app – messages only appear in the window/.test(intro) && !/also arrive as system notification/.test(intro) : /also arrive as system notifications/.test(intro) && !/only appear in the window/.test(intro), `the text only promises what the system allows: ${intro}`);
    const systemRow = honest.locator('[data-setting="System notifications"]');
    const badge = (await systemRow.locator("[data-system-state]").innerText()).replace(/\s+/g, " ");
    check(badge.includes(state === "granted" ? "Allowed" : state === "blocked" ? "Blocked by the system" : "Not asked yet"), `the state is shown as a word: ${badge}`);
    const probe = systemRow.getByRole("button", { name: "Send test" });
    equal(await probe.isDisabled(), state === "blocked", "“Send test” is only disabled when the system blocks");
    await shot("shell-notifications-system");
    if (state !== "blocked") {
      // A REAL call to the system (no redirect): the test goes through the plugin and reports success.
      // By keyboard: the button is reachable with Tab and triggers with Enter.
      await probe.focus();
      await press("Enter");
      await eventually(() => systemRow.locator("[data-probe]").getAttribute("data-probe"), "sent", "the test notification went to the system without error", 20_000);
      check(/Sent/.test(await systemRow.locator("[data-probe]").innerText()), "and the row confirms it");
      equal(await page.evaluate(() => window.__gc.core.notify({ title: "E2E: second real call", body: "directly via core.notify" })), true, "core.notify reports success");
      await shot("shell-notifications-probe");
    }
    await press("Escape");
    await honest.waitFor({ state: "detached" });
    await blur();
    await page.evaluate(() => {
      window.__gcTestNotifications = { focused: true, sent: [] };
    });
    const sent = () => page.evaluate(() => window.__gcTestNotifications.sent.slice());
    /** Window in front (true) or in the background (false); clears the list. */
    const front = (focused) =>
      page.evaluate((value) => {
        window.__gcTestNotifications.focused = value;
        window.__gcTestNotifications.sent.length = 0;
      }, focused);
    const settingsNow = () => app.invoke("settings_get");
    const setUrl = async (url) => {
      repo.git("remote", "set-url", "origin", url);
      await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "remotes"] }), repoId);
      await t.refresh(repoId);
    };
    /** Toggles a setting in the “Notifications” section by keyboard. */
    const toggle = async (title, field, wanted) => {
      await blur();
      await press("Control+Comma");
      const prefs = page.locator('[data-screen="settings"]');
      await prefs.waitFor();
      await prefs.getByRole("tab", { name: "Notifications" }).click();
      const control = prefs.locator(`[data-setting="${title}"]`).getByRole("switch");
      await control.waitFor();
      if ((await control.getAttribute("aria-checked")) !== String(wanted)) {
        await control.focus();
        await press("Space");
      }
      await eventually(async () => (await settingsNow())[field], wanted, `“${title}” is ${wanted ? "on" : "off"} (settings_get)`);
      return prefs;
    };
    const closePrefs = async (prefs) => {
      await press("Escape");
      await prefs.waitFor({ state: "detached" });
      await blur();
    };
    equal([(await settingsNow()).notifyOnError, (await settingsNow()).notifyOnFetch], [true, false], "defaults: on errors on, on fetch results off");

    // 1. Error, window in front: the message in the app is enough.
    await setUrl(deadUrl);
    await t.toolButton("Fetch").click();
    const shown = await waitToast(/Fetch from “origin” failed/, "danger", 90_000);
    await sleep(300);
    equal(await sent(), [], "window in front: no system notification");
    await t.closeToasts();

    // 2. The same error, window in the background: notification with the message's title and text.
    await front(false);
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch from “origin” failed/, "danger", 90_000);
    await eventually(async () => (await sent()).length, 1, "window in the background: exactly one notification");
    const [note] = await sent();
    equal(note.title, "Fetch from “origin” failed", "its title is the message title");
    check(note.body.startsWith("origin: ") && (shown?.text ?? "").includes(note.body.slice(0, 60)), `its text is the message text: ${JSON.stringify(note)} / ${shown?.text}`);
    check(!/\n/.test(note.body) && note.body.length <= 240, "single line and no longer than 240 characters");
    await t.closeToasts();

    // 3. “On background errors” off: the message stays, the system is silent.
    let prefs = await toggle("On background errors", "notifyOnError", false);
    await shot("shell-notifications-setting");
    await closePrefs(prefs);
    await front(false);
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch from “origin” failed/, "danger", 90_000);
    await sleep(300);
    equal(await sent(), [], "setting off: no notification although the window is in the background");
    await t.closeToasts();
    prefs = await toggle("On background errors", "notifyOnError", true);
    await closePrefs(prefs);

    // 4. A hook rejects: one message in the app, ONE notification – with hook, exit code and first line.
    await setUrl(realUrl);
    writeHook("pre-rebase", 'echo "pre-rebase: heute wird nicht umgeschrieben." >&2\nexit 2');
    repo.write("lokal.md", "lokal\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Lokaler Commit auf main");
    repo.git("checkout", "-q", "feature/export");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await t.refresh(repoId);
    await front(false);
    await leftRow("refs/heads/main").click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /Rebase “feature\/export” onto “main”/ }).click();
    await waitToast(/Rebase: rejected by a Git hook/, "danger");
    await sleep(500);
    equal(await sent(), [{ title: "Hook “pre-rebase” failed (exit code 2)", body: "pre-rebase: heute wird nicht umgeschrieben." }], "hook error: one notification with hook, exit code and first line");
    removeHook("pre-rebase");
    repo.git("checkout", "-q", "main");
    repo.git("reset", "-q", "--hard", "origin/main");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await t.refresh(repoId);
    await t.closeToasts();

    // 5. Fetch results: off by default; when on, a fetch with news reports – one without news does not.
    repo.commitOnRemote({ message: "Neues vom Remote (1)", file: "docs/eins.md" });
    await front(false);
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch complete/, "success", 60_000);
    await sleep(300);
    equal(await sent(), [], "“On fetch results” off: no notification");
    await t.closeToasts();
    prefs = await toggle("On fetch results", "notifyOnFetch", true);
    await closePrefs(prefs);
    repo.commitOnRemote({ message: "Neues vom Remote (2)", file: "docs/zwei.md" });
    await front(false);
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch complete/, "success", 60_000);
    await eventually(sent, [{ title: "Fetch complete", body: "1 ref updated" }], "on: notification with the fetch result");
    await t.closeToasts();
    await front(false);
    await t.toolButton("Fetch").click();
    const nothing = await waitToast(/Fetch complete/, "success", 60_000);
    check(/Nothing new/.test(nothing?.text ?? ""), "a fetch without news reports that in the app");
    await sleep(300);
    equal(await sent(), [], "but not to the system – there is nothing to see");
    await t.closeToasts();

    // 6. Auto-fetch (1 minute): “new on the remote” as a message and as a notification, without any action.
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 1 } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await sleep(5000); // the fetch just now still counts as “manual”
    const remoteSha = repo.commitOnRemote({ message: "Während du weg warst", file: "docs/weg.md" });
    await front(false);
    await page.mouse.move(700, 500);
    const started = Date.now();
    const auto = await waitToast(/melder: new on the remote/, "info", 110_000);
    console.log(`    (auto-fetch after ${Math.round((Date.now() - started) / 1000)} s)`);
    check(/Nothing was changed locally/.test(auto?.text ?? ""), `the message says nothing was changed locally: ${auto?.text}`);
    await eventually(sent, [{ title: "melder: new on the remote", body: "Auto-fetch brought new commits or branches." }], "plus the notification – it names the repository");
    equal(repo.git("rev-parse", "origin/main"), remoteSha, "git: origin/main is up to date");
    check(repo.git("rev-parse", "main") !== remoteSha, "git: main is unchanged");
    await shot("shell-notification-autofetch");
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  // -------------------------------------------------------------------------
  // Start from outside: start argument, link, second instance.
  // -------------------------------------------------------------------------
  const activeTab = async () => (await tabs()).find((tab) => tab.isActive) ?? null;
  const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  /** Starts the app a second time with the same data directory; it hands over its request and exits. */
  const secondInstance = (args) =>
    spawnSync(appBinary(), args, {
      env: { ...process.env, FORKYARD_DATA_DIR: app.dataDir, FORKYARD_E2E_WINDOW: "hidden", WEBVIEW2_USER_DATA_FOLDER: ws.dir("zweite-instanz") },
      timeout: 20_000,
      windowsHide: true,
      stdio: "ignore",
    });

  await section("Start from outside: start argument <folder> opens the repository in a tab", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "von-aussen" }));
    await start({ args: [repo.path] });
    await tabButton("von-aussen").waitFor({ timeout: 30_000 });
    const tab = await activeTab();
    check(tab?.kind === "repo" && samePath(tab.path, repo.path), `the tab of the passed folder is active: ${JSON.stringify(tab)}`);
    equal((await tabs()).length, 1, "there is exactly this one tab – the management tab became the repository tab");
    await page.locator('[data-screen="commit-graph"][data-state="ready"]').waitFor({ timeout: 30_000 });
    await eventually(() => focus().then((info) => info.inGraph), true, "focus is in the graph");
    equal(await selection(tab.id), { kind: "wip" }, "without --commit the selection stays on the local changes");
    equal(await t.toasts(), [], "no message");
    await shot("shell-start-argument");
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  await section("Start from outside: --commit <sha> and forkyard:// link show the commit", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "von-aussen" }));
    const second = repo.git("rev-parse", "main~1"); // “Liste der Stationen”
    await start({ args: [repo.path, "--commit", second.slice(0, 9)] });
    await tabButton("von-aussen").waitFor({ timeout: 30_000 });
    let tab = await activeTab();
    await eventually(() => selection(tab.id), { kind: "commits", shas: [second] }, "the abbreviated SHA is resolved and the commit selected");
    const row = page.locator(`[data-screen="commit-graph"] [data-row-id="${second}"]`);
    await row.waitFor();
    check((await row.innerText()).includes("Liste der Stationen"), "the graph shows the commit's row");
    await eventually(async () => (await page.locator('[data-area="right"]').innerText()).includes("Liste der Stationen"), true, "the commit panel shows its details");
    await shot("shell-start-commit");
    await stop();

    // The same request as a link, with an encoded path. A link can come from any web page: for a
    // folder that is not in the list yet, the app asks first (security finding SEC-02).
    const root = repo.git("rev-list", "--max-parents=0", "main");
    const link = `forkyard://open?path=${encodeURIComponent(repo.path)}&commit=${root}`;
    const linkData = ws.dir("daten-link");
    await start({ args: [link], dataDir: linkData });
    let ask = await waitDialog(/Open folder from a link\?/);
    check((await ask.innerText()).includes(repo.path), `the confirmation shows the full path: ${await ask.innerText()}`);
    // … visible untruncated: the text wraps instead of ending with “…”.
    const shown = await ask.locator("[data-launch-path]").evaluate((element) => ({ fits: element.scrollWidth <= element.clientWidth + 1, text: element.textContent }));
    equal(shown, { fits: true, text: repo.path }, "the path is fully readable");
    equal((await tabs()).map((item) => item.kind), ["management"], "nothing is open before the answer");
    equal((await app.invoke("repo_list")).length, 0, "… and nothing added to the list");
    await shot("shell-start-link-confirm");
    // Cancel: stays in management.
    await page.keyboard.press("Escape");
    await sleep(600);
    equal((await tabs()).map((item) => item.kind), ["management"], "cancel: no tab");
    equal((await app.invoke("repo_list")).length, 0, "cancel: no entry in the list");
    await stop();

    // Agree: now the link opens the folder and shows the commit.
    await start({ args: [link], dataDir: linkData });
    ask = await waitDialog(/Open folder from a link\?/);
    await ask.getByRole("button", { name: "Open folder" }).click();
    await tabButton("von-aussen").waitFor({ timeout: 30_000 });
    tab = await activeTab();
    check(samePath(tab.path, repo.path), "the link opens the same folder");
    await eventually(() => selection(tab.id), { kind: "commits", shas: [root] }, "the commit from the link is selected");
    await eventually(async () => (await page.locator('[data-area="right"]').innerText()).includes("Projekt für das Messnetz angelegt"), true, "the commit panel shows it");
    equal(app.consoleErrors, [], "console errors");
    await stop();

    // If the folder is already in the list, the same link opens without confirmation.
    await start({ args: [link], dataDir: linkData });
    await tabButton("von-aussen").waitFor({ timeout: 30_000 });
    tab = await activeTab();
    await eventually(() => selection(tab.id), { kind: "commits", shas: [root] }, "known repository: the link works right away");
    equal(await page.getByRole("dialog").count(), 0, "known repository: no confirmation");
    await stop();

    // A link to another computer: neither opened nor touched.
    const remotePath = "\\\\127.0.0.1\\forkyard-gibt-es-nicht\\repo";
    await start({ args: [`forkyard://open?path=${encodeURIComponent(remotePath)}`] });
    const refused = await waitToast(/The link was not opened/, "warning");
    check((refused?.text ?? "").includes(remotePath) && /folders on other computers/.test(refused?.text ?? ""), `the message names the path and the reason: ${refused?.text}`);
    equal((await tabs()).map((item) => item.kind), ["management"], "network path: no tab");
    equal(await page.getByRole("dialog").count(), 0, "network path: no confirmation either – it is never opened");
    await shot("shell-start-link-network-path");
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  await section("Start from outside: second instance hands over to the running one, existing tab is activated", async () => {
    const first = made(makeCleanRepoWithRemote({ name: "erstes" }));
    const other = made(makeCleanRepoWithRemote({ name: "zweites" }));
    await start({ args: [first.path] });
    await tabButton("erstes").waitFor({ timeout: 30_000 });

    // Second start with another folder: the process ends, the running app opens the tab.
    const forwarded = secondInstance([other.path]);
    equal(forwarded.status, 0, `the second instance exits after handing over the request (${forwarded.error?.message ?? "no error"})`);
    await tabButton("zweites").waitFor({ timeout: 30_000 });
    await eventually(async () => (await activeTab())?.title, "zweites", "the running app shows the second repository");
    equal((await tabs()).map((tab) => tab.title), ["erstes", "zweites"], "two tabs, in this order");

    // Once more with the first folder and a commit: no third tab, the existing one becomes active.
    const sha = first.git("rev-parse", "main~1");
    const again = secondInstance([first.path, `--commit=${sha}`]);
    equal(again.status, 0, "this request is handed over too");
    await eventually(async () => (await activeTab())?.title, "erstes", "the existing tab is activated");
    equal((await tabs()).length, 2, "no further tab is added");
    const tab = await activeTab();
    await eventually(() => selection(tab.id), { kind: "commits", shas: [sha] }, "and the commit from the request is selected");
    await shot("shell-start-second-instance");
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });

  await section("Start from outside: no repository, unknown commit, folder missing – clearly explained", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "von-aussen" }));
    // A folder that is not a repository.
    const plain = ws.dir("nur-ein-ordner");
    fs.writeFileSync(path.join(plain, "notiz.txt"), "kein Repository\n");
    await start({ args: [plain] });
    const noRepo = await waitToast(/“nur-ein-ordner” is not a Git repository/, "warning");
    check((noRepo?.text ?? "").includes("but there is no repository there") && /Create a repository here/.test(noRepo?.text ?? ""), `the message explains it and offers to create one: ${noRepo?.text}`);
    equal((await tabs()).map((tab) => tab.kind), ["management"], "the app is in repository management");
    await shot("shell-start-no-repo");
    await app.setTheme("light");
    await shot("shell-start-no-repo-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no overflow");
    await shot("shell-start-no-repo-min");
    await app.setSize(1440, 900);
    // The message's action opens “Create new” with exactly this folder.
    await page.locator('[data-toast="warning"]').getByRole("button", { name: "Create a repository here" }).click();
    const init = await waitDialog(/Repository/);
    check((await init.innerText()).includes("nur-ein-ordner"), "the “Create new” dialog is prefilled with the folder");
    await page.keyboard.press("Escape");
    await stop();

    // A commit that does not exist in the repository.
    await start({ args: [repo.path, "--commit", "0123abcd"] });
    await tabButton("von-aussen").waitFor({ timeout: 30_000 });
    const noCommit = await waitToast(/Commit 0123abc not found/, "warning");
    check(/is open, but this commit does not exist there/.test(noCommit?.text ?? ""), `the message says the repository is open and the commit is missing: ${noCommit?.text}`);
    equal(await selection((await activeTab()).id), { kind: "wip" }, "the selection stays as it was");
    await shot("shell-start-commit-missing");
    await stop();

    // A folder that does not exist: the core discards the request – the app starts normally.
    await start({ args: [ws.at("gibt-es-nicht")] });
    await sleep(800);
    equal((await tabs()).map((tab) => tab.kind), ["management"], "with a path that does not exist, the app starts in management");
    console.log(`    (messages for a missing folder: ${JSON.stringify(await t.toasts())})`);
    equal(app.consoleErrors, [], "console errors");
    await stop();
  });
} catch (error) {
  t.check(false, `aborted: ${error?.stack ?? error}`);
} finally {
  await stop();
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Cleanup is secondary.
    }
  }
}
t.finish();
