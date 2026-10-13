/**
 * Proof of "Several repositories in tabs (new, close, reorder, switch)" in the real app.
 *
 *   node scripts/e2e/screens/mustfix-tabs.mjs [--show] [--no-shots] [--only <part>]
 *
 * Flows (the UI state AND the core's `tabs_list` are compared):
 * - New tab with Ctrl+T and the plus button, open a repository in it (Alt+O), the window title follows.
 * - Switching: Ctrl+1…9 (Ctrl+9 = last), Ctrl+Tab / Ctrl+Shift+Tab with wrap-around, click, arrow keys + Enter.
 * - Opening the same repository again: no second tab, the existing one becomes active.
 * - Reordering: dragging with the mouse, Ctrl+Shift+←/→ on the focused tab, context menu via keyboard.
 * - Closing: Ctrl+W, middle click, Del, × button, context menu "Close other tabs"; the last tab.
 * - Many tabs: overflow menu "All tabs", active tab stays visible, nothing overflows (1440x900, 960x600).
 * - Restart: with "Remember tabs" tabs, order and active tab are back; without it the app starts
 *   with repository management, the repositories stay in the list.
 */
import fs from "node:fs";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeEmptyRepo, makeRichRepo } from "../fixtures.mjs";
import { createRun, sleep } from "./mustfix-lib.mjs";
import { makeWorkspace } from "./repo-entry-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("mustfix-tabs", { argv });
const { check, equal, eventually, section, shot } = t;

const ws = makeWorkspace("tabs");
const dataDir = ws.dir("app-daten");
const rich = makeRichRepo(); // "wetterstation", with uncommitted changes
const clean = makeCleanRepoWithRemote(); // "messnetz"
const empty = makeEmptyRepo({ name: "leeres-projekt" });
const many = [];

let app = null;
let page = null;

/** Tabs as the strip shows them (in display order). */
const uiTabs = () =>
  page.locator("[data-tab-id]").evaluateAll((list) =>
    list.map((item) => {
      const tab = item.querySelector('[role="tab"]');
      return { title: tab?.querySelector(".truncate")?.textContent ?? "", active: tab?.getAttribute("aria-selected") === "true" };
    }),
  );
/** Tabs as the core keeps them. */
const coreTabs = async () =>
  (await app.invoke("tabs_list"))
    .sort((a, b) => a.position - b.position)
    .map((tab) => ({ title: tab.kind === "management" ? "Repositories" : tab.title, active: tab.isActive }));
const titles = (list) => list.map((tab) => tab.title);
const activeTitle = (list) => list.find((tab) => tab.active)?.title ?? null;

/** Expects this order and this active tab – in the strip and in the core. */
const expectTabs = async (order, active, message) => {
  await eventually(async () => ({ order: titles(await uiTabs()), active: activeTitle(await uiTabs()) }), { order, active }, `${message} (strip)`);
  await eventually(async () => ({ order: titles(await coreTabs()), active: activeTitle(await coreTabs()) }), { order, active }, `${message} (tabs_list)`);
};

const tabButton = (title) => page.getByRole("tab", { name: new RegExp(`^${title}`) });
const tabBox = (title) => page.locator("[data-tab-id]").filter({ has: tabButton(title) }).first();
const press = async (keys) => {
  await page.keyboard.press(keys);
  await sleep(60);
};
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const openByKeyboard = async (repoPath, title) => {
  await app.pick(repoPath);
  await press("Alt+o");
  await tabButton(title).waitFor();
  await app.settle();
};
const menuItems = () => page.getByRole("menuitem").evaluateAll((list) => list.map((item) => ({ text: (item.textContent ?? "").trim(), disabled: item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled") })));

async function start() {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir });
  page = app.page;
  t.attach(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
}

try {
  await start();

  await section("New tab: Ctrl+T, plus button, open a repository in it", async () => {
    await expectTabs(["Repositories"], "Repositories", "start with repository management");
    equal(await app.windowTitle(), "forkyard", "window title without repository");
    // Opened in the management tab, it turns into the repo tab (no empty tab is left behind).
    await openByKeyboard(rich.path, "wetterstation");
    await expectTabs(["wetterstation"], "wetterstation", "Alt+O in the management tab turns it into the repo tab");
    await eventually(() => app.windowTitle(), "wetterstation – forkyard", "the window title follows");
    await press("Control+t");
    await expectTabs(["wetterstation", "Repositories"], "Repositories", "Ctrl+T opens a new tab with repository management");
    await eventually(() => app.windowTitle(), "forkyard", "window title in the management tab");
    await openByKeyboard(clean.path, "messnetz");
    await page.getByRole("button", { name: "New tab" }).click();
    await expectTabs(["wetterstation", "messnetz", "Repositories"], "Repositories", "the plus button opens a new tab");
    await openByKeyboard(empty.path, "leeres-projekt");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "leeres-projekt", "three repositories in three tabs");
    await eventually(
      () => tabButton("wetterstation").evaluate((tab) => tab.textContent?.includes("uncommitted changes") ?? false),
      true,
      "the tab of a repository with changes carries the dot (with text for screen readers)",
    );
    equal(await tabButton("messnetz").getAttribute("title"), clean.path, "a tab's tooltip is the full path");
    await shot("mustfix-tabs");
  });

  await section("Switching: Ctrl+1…9, Ctrl+Tab, click, arrow keys", async () => {
    await blur();
    await press("Control+1");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "wetterstation", "Ctrl+1");
    await eventually(() => app.windowTitle(), "wetterstation – forkyard", "window title after Ctrl+1");
    await eventually(() => page.getByRole("toolbar", { name: "Repository actions" }).count(), 1, "the tab's repo view is there");
    await press("Control+2");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "messnetz", "Ctrl+2");
    await press("Control+9");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "leeres-projekt", "Ctrl+9 jumps to the last tab");
    await press("Control+5");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "leeres-projekt", "Ctrl+5 without a fifth tab changes nothing");
    await press("Control+Tab");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "wetterstation", "Ctrl+Tab wraps from the last to the first");
    await press("Control+Tab");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "messnetz", "Ctrl+Tab goes to the next one");
    await press("Control+Shift+Tab");
    await press("Control+Shift+Tab");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "leeres-projekt", "Ctrl+Shift+Tab wraps backwards");
    await tabButton("messnetz").click();
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "messnetz", "click activates");
    await eventually(() => app.windowTitle(), "messnetz – forkyard", "window title after the click");
    // Keyboard in the strip: arrows move focus, Enter activates.
    await tabButton("messnetz").focus();
    await press("ArrowLeft");
    equal((await t.focused()).text.startsWith("wetterstation"), true, "arrow left moves focus to the previous tab");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "messnetz", "focus alone does not switch the tab yet");
    await press("End");
    equal((await t.focused()).text.startsWith("leeres-projekt"), true, "End jumps to the last tab");
    await press("Home");
    await press("Enter");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "wetterstation", "Enter activates the focused tab");
    // Fast switching: the last key press wins.
    await blur();
    await page.keyboard.press("Control+Tab");
    await page.keyboard.press("Control+Tab");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "leeres-projekt", "Ctrl+Tab twice quickly lands two tabs further");
  });

  await section("Opening the same repository again: no second tab", async () => {
    await openByKeyboard(rich.path, "wetterstation");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "wetterstation", "Alt+O on an open repository activates its tab");
    // From repository management: the existing tab becomes active, no duplicate.
    await press("Control+t");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt", "Repositories"], "Repositories", "new tab");
    await app.pick(clean.path);
    await press("Alt+o");
    await eventually(async () => activeTitle(await uiTabs()), "messnetz", "the already open repository becomes active");
    const now = await app.invoke("tabs_list");
    const repoIds = now.filter((tab) => tab.repoId).map((tab) => tab.repoId);
    equal(new Set(repoIds).size, repoIds.length, "no repository sits in two tabs");
    equal(repoIds.length, 3, "still three repo tabs");
    // Close the leftover management tab (if it stayed).
    const management = now.find((tab) => tab.kind === "management");
    if (management) await app.invoke("tab_close", { tabId: management.id });
    await press("Control+2");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "messnetz", "starting point restored");
  });

  await section("Reordering: drag, Ctrl+Shift+arrow, context menu via keyboard", async () => {
    // Drag: "leeres-projekt" before "wetterstation".
    const from = await tabBox("leeres-projekt").boundingBox();
    const to = await tabBox("wetterstation").boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(to.x + 6, to.y + to.height / 2, { steps: 12 });
    check((await page.locator("[data-tab-id] > span.bg-accent").count()) === 1, "while dragging a marker shows the insertion point");
    await shot("mustfix-tabs-drag");
    await page.mouse.up();
    await expectTabs(["leeres-projekt", "wetterstation", "messnetz"], "messnetz", "dragging reorders without switching the active tab");

    // A short click without movement moves nothing.
    await tabButton("wetterstation").click();
    await expectTabs(["leeres-projekt", "wetterstation", "messnetz"], "wetterstation", "a click moves nothing");

    // Keyboard: Ctrl+Shift+→ on the focused tab.
    await tabButton("wetterstation").focus();
    await press("Control+Shift+ArrowRight");
    await expectTabs(["leeres-projekt", "messnetz", "wetterstation"], "wetterstation", "Ctrl+Shift+→ moves the tab to the right");
    await eventually(() => t.focused().then((focus) => focus.text.startsWith("wetterstation")), true, "focus stays on the moved tab");
    await press("Control+Shift+ArrowRight");
    await expectTabs(["leeres-projekt", "messnetz", "wetterstation"], "wetterstation", "at the right edge it goes no further");
    await press("Control+Shift+ArrowLeft");
    await press("Control+Shift+ArrowLeft");
    await expectTabs(["wetterstation", "leeres-projekt", "messnetz"], "wetterstation", "Ctrl+Shift+← twice: all the way to the left");
    await eventually(() => t.focused().then((focus) => focus.text.startsWith("wetterstation")), true, "focus moved along");

    // Context menu via keyboard (Shift+F10) on the middle tab.
    await tabButton("wetterstation").focus();
    await press("ArrowRight");
    await press("Shift+F10");
    await page.getByRole("menu").waitFor();
    const items = await menuItems();
    equal(
      items.map((item) => item.text.replace(/Ctrl\+?.*$/, "").replace(/\s*display name only\s*F2$/, "").trim()),
      ["Close tab", "Close other tabs", "Rename …", "Move left", "Move right", "Show in Explorer", "Copy path", "New tab"],
      "entries of the tab menu",
    );
    await shot("mustfix-tabs-menu");
    await page.getByRole("menuitem", { name: "Move right" }).focus();
    await press("Enter");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "wetterstation", "\"Move right\" from the menu");
    // At the edge the matching entry is disabled.
    await tabButton("wetterstation").click({ button: "right" });
    await page.getByRole("menu").waitFor();
    equal((await menuItems()).find((item) => item.text.startsWith("Move left"))?.disabled, true, "at the far left \"Move left\" is disabled");
    await press("Escape");
    equal(await t.overflow(), { x: 0, y: 0 }, "no overflow");
  });

  await section("Closing: Ctrl+W, middle click, Del, ×, \"Close other tabs\", last tab", async () => {
    await blur();
    await press("Control+t");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt", "Repositories"], "Repositories", "a fourth tab");
    await press("Control+w");
    await expectTabs(["wetterstation", "messnetz", "leeres-projekt"], "leeres-projekt", "Ctrl+W closes the active tab; the neighbour becomes active");

    // Middle click on an inactive tab: it disappears, the active one stays.
    const box = await tabBox("messnetz").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "middle" });
    await expectTabs(["wetterstation", "leeres-projekt"], "leeres-projekt", "middle click closes without switching tabs");
    check(fs.existsSync(clean.path), "the folder of the closed repository is untouched");
    check((await app.invoke("repo_list")).some((repo) => repo.name === "messnetz"), "the repository stays in the list");

    // Reopen, then close via the × button and via Del.
    await openByKeyboard(clean.path, "messnetz");
    await expectTabs(["wetterstation", "leeres-projekt", "messnetz"], "messnetz", "open again (appended at the end)");
    await page.getByRole("button", { name: "Close messnetz" }).click();
    await expectTabs(["wetterstation", "leeres-projekt"], "leeres-projekt", "the × button closes");
    await openByKeyboard(clean.path, "messnetz");
    await tabButton("messnetz").focus();
    await press("Delete");
    await expectTabs(["wetterstation", "leeres-projekt"], "leeres-projekt", "Del on the focused tab closes it");

    // "Close other tabs"
    await openByKeyboard(clean.path, "messnetz");
    await press("Control+t");
    await expectTabs(["wetterstation", "leeres-projekt", "messnetz", "Repositories"], "Repositories", "four tabs");
    await tabButton("leeres-projekt").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close other tabs" }).click();
    await expectTabs(["leeres-projekt"], "leeres-projekt", "\"Close other tabs\" keeps exactly this one and activates it");
    await page.getByRole("toolbar", { name: "Repository actions" }).waitFor();

    // The last tab: closing leads to repository management, the strip is never empty.
    await blur();
    await press("Control+w");
    await expectTabs(["Repositories"], "Repositories", "after the last tab repository management is shown");
    await page.locator('[data-screen="repo-management"]').waitFor();
    await press("Control+w");
    await expectTabs(["Repositories"], "Repositories", "Ctrl+W on the only management tab leaves it");
    equal(app.consoleErrors, [], "console errors");
  });

  await section("Many tabs: overflow menu, active tab visible, no overflow", async () => {
    for (let index = 1; index <= 14; index++) {
      const repo = makeEmptyRepo({ name: `station-${String(index).padStart(2, "0")}` });
      many.push(repo);
      await app.invoke("repo_open", { path: repo.path });
      if (index < 14) await app.invoke("tab_open", { repoId: null });
    }
    await app.settle();
    const all = Array.from({ length: 14 }, (_, index) => `station-${String(index + 1).padStart(2, "0")}`);
    await expectTabs(all, "station-14", "14 tabs");
    equal(await t.overflow(), { x: 0, y: 0 }, "1440x900: the page does not overflow");
    await eventually(() => page.getByRole("button", { name: "All tabs" }).count(), 1, "the overflow menu \"All tabs\" appears");
    const visible = (title) =>
      page.evaluate((name) => {
        const list = document.querySelector('[role="tablist"]').getBoundingClientRect();
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((item) => item.textContent?.startsWith(name))?.getBoundingClientRect();
        return Boolean(tab && tab.left >= list.left - 1 && tab.right <= list.right + 1);
      }, title);
    await eventually(() => visible("station-14"), true, "the active tab is in the visible part of the strip");
    const narrowest = await page.locator("[data-tab-id]").evaluateAll((list) => Math.min(...list.map((item) => item.getBoundingClientRect().width)));
    check(narrowest >= 127, `tabs stay readably wide (narrowest: ${narrowest} px)`);
    await shot("mustfix-tabs-many");

    // Overflow menu via keyboard: open, pick the first entry.
    await page.getByRole("button", { name: "All tabs" }).focus();
    await press("Enter");
    await page.getByRole("menu").waitFor();
    const entries = await page.getByRole("menu").locator('[role^="menuitem"]').evaluateAll((list) => list.map((item) => ({ text: (item.textContent ?? "").trim(), checked: item.getAttribute("aria-current") === "true" })));
    equal(entries.map((entry) => entry.text), all, "the menu lists all tabs in their order");
    equal(entries.filter((entry) => entry.checked).map((entry) => entry.text), ["station-14"], "the active tab is marked in the menu");
    await shot("mustfix-tabs-overflow-menu");
    await press("Home");
    await press("Enter");
    await expectTabs(all, "station-01", "picking in the menu activates the tab");
    await eventually(() => visible("station-01"), true, "and scrolls it into the visible part");
    await blur();
    await press("Control+9");
    await expectTabs(all, "station-14", "Ctrl+9 jumps to the last one with 14 tabs too");
    await eventually(() => visible("station-14"), true, "the last tab is visible again");

    await app.setTheme("light");
    await shot("mustfix-tabs-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(200);
    equal(await t.overflow(), { x: 0, y: 0 }, "960x600: the page does not overflow");
    await eventually(() => visible("station-14"), true, "960x600: the active tab stays visible");
    check((await page.getByRole("button", { name: "New tab" }).boundingBox()).x < 960, "960x600: the plus button stays reachable");
    await shot("mustfix-tabs-min");
    await app.setSize(1440, 900);

    // Clean up for the restart test: only three tabs in a known order.
    for (const tab of await app.invoke("tabs_list")) await app.invoke("tab_close", { tabId: tab.id });
  });

  await section("Restart with \"Remember tabs\": tabs, order and active tab are back", async () => {
    const opened = [];
    for (const repo of [rich, clean, empty]) {
      opened.push(await app.invoke("repo_open", { path: repo.path }));
      await app.invoke("tab_open", { repoId: null });
    }
    // Order deliberately not the opening order: leeres-projekt, wetterstation, messnetz, management; wetterstation is active.
    await app.invoke("tab_move", { tabId: opened[2].tab.id, position: 0 });
    await app.invoke("tab_activate", { tabId: opened[0].tab.id });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    const order = ["leeres-projekt", "wetterstation", "messnetz", "Repositories"];
    await expectTabs(order, "wetterstation", "starting point before the restart");
    equal((await app.invoke("settings_get")).rememberTabs, true, "\"Remember tabs\" is the default");
    await app.close();
    await start();
    await expectTabs(order, "wetterstation", "after the restart the same tabs are there in the same order");
    await eventually(() => app.windowTitle(), "wetterstation – forkyard", "the window title belongs to the active tab");
    await page.getByRole("toolbar", { name: "Repository actions" }).waitFor();
    await eventually(() => tabButton("wetterstation").evaluate((tab) => tab.textContent?.includes("uncommitted changes") ?? false), true, "the status loads again (dot for changes)");
    equal(app.consoleErrors, [], "console errors after the restart");
    await shot("mustfix-tabs-restored");
  });

  await section("Restart without \"Remember tabs\": start with repository management, repositories stay in the list", async () => {
    await blur();
    await press("Control+Comma");
    const prefs = page.locator('[data-screen="settings"]');
    await prefs.waitFor();
    const toggle = prefs.getByRole("switch", { name: "Remember tabs" });
    await toggle.waitFor();
    equal(await toggle.getAttribute("aria-checked"), "true", "the switch is on");
    await toggle.focus();
    await press("Space");
    await eventually(() => toggle.getAttribute("aria-checked"), "false", "turned off with Space");
    await eventually(async () => (await app.invoke("settings_get")).rememberTabs, false, "the setting is saved");
    await shot("mustfix-tabs-setting");
    await t.closeToasts();
    await press("Escape");
    await prefs.waitFor({ state: "detached" });
    await expectTabs(["leeres-projekt", "wetterstation", "messnetz", "Repositories"], "wetterstation", "in the running session the tabs stay");
    await app.close();
    await start();
    await expectTabs(["Repositories"], "Repositories", "after the restart only repository management is there");
    equal(await app.windowTitle(), "forkyard", "window title without repository");
    const names = (await app.invoke("repo_list")).map((repo) => repo.name).sort();
    check(["leeres-projekt", "messnetz", "wetterstation"].every((name) => names.includes(name)), `the repositories are still in the list: ${names.join(", ")}`);
    await page.locator('[data-screen="repo-management"]').getByText("wetterstation").first().waitFor();
    equal(app.consoleErrors, [], "console errors");
    await shot("mustfix-tabs-not-restored");
  });
} catch (error) {
  t.check(false, `Aborted: ${error?.stack ?? error}`);
} finally {
  await app?.close();
  rich.cleanup();
  clean.cleanup();
  empty.cleanup();
  for (const repo of many) repo.cleanup();
  ws.cleanup();
}
t.finish();
