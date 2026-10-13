/**
 * Do the settings take effect where you see them? Date format (graph, commit details), toolbar
 * labels, font size and tab width (diff, editor), word wrap and whitespace in the diff, and
 * "Prune stale remote branches" on fetch – in the real app, against real repositories.
 *
 *   node scripts/e2e/screens/prefs-effects.mjs                everything (checks and screenshots)
 *   node scripts/e2e/screens/prefs-effects.mjs --only prune   only sections whose title contains "prune" (comma separates several)
 *   node scripts/e2e/screens/prefs-effects.mjs --show         visible window
 *
 * Changes are made in the settings themselves (settings), the first section keyboard only.
 * Auto-prune is verified in the repository (git branch -r). Aborts on console errors.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeRichRepo } from "../fixtures.mjs";
import { SHOTS, closeToasts, finish, makeChecks } from "./files-lib.mjs";
import { gitIn } from "./mustfix-lib.mjs";
import { pageHelpers } from "./prefs-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const checks = makeChecks("prefs-effects");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const rich = makeRichRepo({ dirty: true });
const remoteRepo = makeCleanRepoWithRemote({ name: "aufraeumen" });
const repos = [rich, remoteRepo];

const PREFS = '[data-screen="settings"]';
const commitGraphScreen = '[data-screen="commit-graph"]';
const commitDetailsScreen = '[data-screen="commit-details"]';
const diffScreen = '[data-screen="diff"]';
const fileViewScreen = '[data-screen="file-view"]';

let app = null;
try {
  app = await launchApp({ show });
  state.app = app;
  const { page } = app;
  const h = pageHelpers(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const richTab = await app.openRepo(rich.path);
  const remoteTab = await app.openRepo(remoteRepo.path);
  const use = async (tab) => {
    await app.invoke("tab_activate", { tabId: tab.tabId });
    await page.waitForFunction((id) => document.querySelector(`[data-tab-id="${id}"] [role="tab"]`)?.getAttribute("aria-selected") === "true", tab.tabId);
    await app.settle();
  };
  const settings = () => app.invoke("settings_get");
  const store = (method, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [method, args]);
  const prefs = page.locator(PREFS);
  const row = (title) => prefs.locator(`[data-setting="${title}"]`);
  const openPrefs = async (tab, { keyboard = false } = {}) => {
    await page.keyboard.press("Control+,");
    await prefs.waitFor();
    const selected = () => page.getByRole("tab", { selected: true }).innerText();
    if (keyboard) {
      for (let step = 0; step < 14; step++) {
        const now = await selected();
        if (now === tab) break;
        await page.keyboard.press("ArrowDown");
        await page.waitForFunction((before) => document.querySelector('[data-screen="settings"] [role="tab"][aria-selected="true"]')?.textContent?.trim() !== before, now, { timeout: 5000 }).catch(() => undefined);
      }
    } else {
      await page.getByRole("tab", { name: tab, exact: true }).click();
    }
    await eventually(selected, tab, `section "${tab}" is open`);
    await app.settle();
  };
  const closePrefs = async () => {
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "settings closed");
  };
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  state.resetView = async () => {
    for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await closeToasts(page);
    await app.settle();
  };
  const dateCells = () => page.locator(`${commitGraphScreen} [role="gridcell"][data-cell="date"]`).evaluateAll((cells) => cells.map((cell) => cell.textContent.trim()).filter(Boolean));
  const pad = (value) => String(value).padStart(2, "0");
  const isoLocal = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

  // -------------------------------------------------------------------------------------------
  await section("Date format – changed by keyboard only: graph and commit details follow", async () => {
    await use(richTab);
    const head = rich.git("rev-parse", "HEAD");
    const authored = new Date(rich.git("log", "-1", "--format=%aI", head));
    equal((await settings()).dateFormat, "relative", "initial state: relative");
    const before = await dateCells();
    check(before.length > 5 && before.every((text) => /^(yesterday|just now|last )| ago$/.test(text)), `relative: the graph shows "… ago" (${before.slice(0, 3).join(" | ")})`);

    await openPrefs("Appearance", { keyboard: true });
    await h.tabTo("Relative");
    await page.keyboard.press("ArrowRight");
    await eventually(() => settings().then((value) => value.dateFormat), "local", "arrow right: local");
    await page.keyboard.press("ArrowRight");
    await eventually(() => settings().then((value) => value.dateFormat), "iso", "once more: ISO");
    await closePrefs();

    await until(async () => (await dateCells()).every((text) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)), "ISO: every graph row shows year-month-day hour:minute");
    check((await dateCells()).includes(isoLocal(authored)), `the graph shows the HEAD date like git (${isoLocal(authored)})`);
    await store("selectCommits", richTab.tabId, [head]);
    const time = page.locator(`${commitDetailsScreen} time`).first();
    await eventually(() => time.innerText(), isoLocal(authored), "commit details: author date in ISO format");
    equal(new Date(await time.getAttribute("datetime")).getTime(), authored.getTime(), "and it is exactly the time from git log");
    await shot("prefs-effects-date-iso");

    await app.invoke("settings_set", { patch: { dateFormat: "local" } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    const local = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(authored);
    await eventually(() => time.innerText(), local, "local: commit details in the locale format");
    await until(async () => (await dateCells()).includes(local), "local: the graph too");
    await app.invoke("settings_set", { patch: { dateFormat: "relative" } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await until(async () => (await dateCells()).every((text) => /^(yesterday|just now|last )| ago$/.test(text)), "back to relative");
    await store("selectWip", richTab.tabId);
  });

  // -------------------------------------------------------------------------------------------
  await section("Toolbar labels", async () => {
    await use(richTab);
    const toolbar = page.getByRole("toolbar", { name: "Repository actions" });
    const labelBox = () => toolbar.getByRole("button", { name: /^Fetch/ }).first().evaluate((button) => {
      const label = Array.from(button.querySelectorAll("span")).find((span) => span.textContent === "Fetch");
      const box = label?.getBoundingClientRect();
      return { height: Math.round(button.getBoundingClientRect().height), labelVisible: Boolean(box && box.width > 4 && box.height > 4) };
    });
    equal((await labelBox()).labelVisible, true, "initial state: label below the icon");
    await openPrefs("Appearance");
    await row("Toolbar labels").getByRole("switch").click();
    await eventually(() => settings().then((value) => value.toolbarLabels), false, "setting: off");
    await closePrefs();
    await eventually(async () => (await labelBox()).labelVisible, false, "the toolbar shows icons only");
    check((await toolbar.getByRole("button", { name: /^Fetch/ }).count()) >= 1, "the buttons keep their name for screen readers");
    await shot("prefs-effects-toolbar-icons");
    await app.invoke("settings_set", { patch: { toolbarLabels: true } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await eventually(async () => (await labelBox()).labelVisible, true, "labels back");
  });

  // -------------------------------------------------------------------------------------------
  await section("Font size and tab width: diff and editor follow", async () => {
    await use(richTab);
    const file = "src/auswertung.py";
    await store("openDiff", richTab.tabId, file, { kind: "unstaged" });
    const codeStyle = (scope, selector) =>
      page.locator(`${scope} ${selector}`).first().evaluate((element) => {
        const style = getComputedStyle(element);
        return { fontSize: style.fontSize, tabSize: style.tabSize, lineHeight: style.lineHeight };
      });
    await page.locator(`${diffScreen} .selectable`).first().waitFor();
    equal(await codeStyle(diffScreen, ".selectable"), { fontSize: "13px", tabSize: "4", lineHeight: "20px" }, "initial state in the diff: 13 px, tab width 4");

    await openPrefs("Diff and editor");
    const size = row("Font size").locator("input");
    await size.fill("18");
    await size.press("Enter");
    await eventually(() => settings().then((value) => value.editorFontSize), 18, "font size 18 saved");
    const tab = row("Tab width").locator("input");
    await tab.fill("8");
    await tab.press("Enter");
    await eventually(() => settings().then((value) => value.editorTabSize), 8, "tab width 8 saved");
    await closePrefs();
    await eventually(() => codeStyle(diffScreen, ".selectable"), { fontSize: "18px", tabSize: "8", lineHeight: "27px" }, "diff: 18 px, line height 1.5x, tab width 8");
    await shot("prefs-effects-font-diff");

    await store("openFile", richTab.tabId, file, null, "view");
    await page.locator(`${fileViewScreen} .cm-content`).waitFor();
    await eventually(() => codeStyle(fileViewScreen, ".cm-content").then((style) => [style.fontSize, style.tabSize]), ["18px", "8"], "editor: same font size and tab width");
    await shot("prefs-effects-font-editor");
    await app.invoke("settings_set", { patch: { editorFontSize: 13, editorTabSize: 4 } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await eventually(() => codeStyle(fileViewScreen, ".cm-content").then((style) => [style.fontSize, style.tabSize]), ["13px", "4"], "back to 13 px and 4");
    await store("closeCenter", richTab.tabId);
  });

  // -------------------------------------------------------------------------------------------
  await section("Word wrap and whitespace from the settings take effect in the diff", async () => {
    await use(richTab);
    // A very long line and a whitespace-only change.
    fs.writeFileSync(path.join(rich.path, "notizen/lang.md"), `# Lang\n\n${"Die Station misst Temperatur, Luftfeuchte, Regen und Wind im Abstand von fünf Minuten. ".repeat(8)}\n`);
    const source = fs.readFileSync(path.join(rich.path, "src/export.py"), "utf8");
    fs.writeFileSync(path.join(rich.path, "src/export.py"), source.replace(/\n/, "   \n"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(async () => (await app.invoke("status_get", { repoId: richTab.repoId })).unstaged.some((item) => item.path === "src/export.py"), "the whitespace change is in the working directory");
    await app.settle();

    await store("openDiff", richTab.tabId, "notizen/lang.md", { kind: "unstaged" });
    const grid = page.locator(`${diffScreen} [role="grid"]`).first();
    await grid.waitFor();
    const widths = () => grid.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    let size = await widths();
    check(size.scroll > size.client, `without wrap the long line scrolls sideways (${size.scroll} > ${size.client})`);
    await openPrefs("Diff and editor");
    await row("Word wrap").getByRole("switch").click();
    await eventually(() => settings().then((value) => value.diffWordWrap), true, "word wrap on in the settings");
    await closePrefs();
    await until(async () => (await widths()).scroll <= (await widths()).client, "the open diff wraps now");
    equal(await page.locator(diffScreen).getByRole("button", { name: "Wrap long lines" }).getAttribute("aria-pressed"), "true", "the toggle in the diff shows \"on\"");

    await store("openDiff", richTab.tabId, "src/export.py", { kind: "unstaged" });
    await page.locator(`${diffScreen} [data-diff-title]`).filter({ hasText: "export.py" }).waitFor();
    await app.settle();
    equal(await page.locator(`${diffScreen} [data-notice]`).count(), 0, "with whitespace: the diff shows the change");
    await openPrefs("Diff and editor");
    await row("Ignore whitespace").getByRole("switch").click();
    await eventually(() => settings().then((value) => value.diffIgnoreWhitespace), true, "ignore whitespace on in the settings");
    await closePrefs();
    await eventually(() => page.locator(`${diffScreen} [data-notice]`).getAttribute("data-notice").catch(() => null), "whitespace", "without whitespace nothing is left – the diff says so");
    await app.invoke("settings_set", { patch: { diffWordWrap: false, diffIgnoreWhitespace: false } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await store("closeCenter", richTab.tabId);
  });

  // -------------------------------------------------------------------------------------------
  await section("Auto-prune: a branch deleted on the remote disappears on fetch – or stays", async () => {
    await use(remoteTab);
    const { repoId } = remoteTab;
    const config = path.join(remoteRepo.root, "gitconfig");
    const remotes = () => remoteRepo.git("branch", "-r", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
    const fetchButton = page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Fetch/ }).first();
    const fetchAndWait = async () => {
      await closeToasts(page);
      await fetchButton.click();
      await until(async () => (await h.toasts()).some((text) => /Fetch/.test(text)), "fetch toast", 30_000);
      await app.settle();
      return (await h.toasts()).join(" | ").replace(/\s+/g, " ");
    };
    // Two branches on the remote, known locally.
    for (const name of ["alt/messfehler", "alt/probe"]) gitIn(remoteRepo.remotePath, config, "branch", name, "main");
    await fetchAndWait();
    equal(remotes().filter((name) => name.startsWith("origin/alt/")), ["origin/alt/messfehler", "origin/alt/probe"], "initial state: both remote branches are known locally");
    await until(async () => (await app.invoke("refs_list", { repoId })).remotes.some((ref) => ref.name === "origin/alt/probe"), "the app knows them too");

    // Off: the deleted branch stays as a ref.
    await openPrefs("Git behavior");
    const toggle = row("Prune stale remote branches").getByRole("switch");
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await eventually(() => settings().then((value) => value.autoPrune), false, "setting: off");
    await closePrefs();
    gitIn(remoteRepo.remotePath, config, "branch", "-D", "alt/messfehler");
    let text = await fetchAndWait();
    check(remotes().includes("origin/alt/messfehler"), "without auto-prune the stale ref stays after the fetch (git branch -r)");
    check(!/removed/.test(text), `the toast mentions nothing removed (${text})`);

    // On: it disappears on the next fetch, and the toast says so.
    await openPrefs("Git behavior");
    await toggle.click();
    await eventually(() => settings().then((value) => value.autoPrune), true, "setting: on");
    await closePrefs();
    text = await fetchAndWait();
    equal(remotes().filter((name) => name.startsWith("origin/alt/")), ["origin/alt/probe"], "with auto-prune the stale ref is gone, the other one stays (git branch -r)");
    check(/1 stale remote branch removed/.test(text), `the toast says what was removed (${text})`);
    await until(async () => !(await app.invoke("refs_list", { repoId })).remotes.some((ref) => ref.name === "origin/alt/messfehler"), "the branch is gone in the app too");
    await eventually(() => page.locator('[data-area="left"]').getByText("messfehler", { exact: true }).count(), 0, "the left panel no longer shows it");
    await shot("prefs-effects-prune");
  });
} catch (error) {
  check(false, `script aborted: ${error?.stack ?? error}`);
}
await finish("prefs-effects", checks, app, () => repos.forEach((repo) => repo.cleanup()));
