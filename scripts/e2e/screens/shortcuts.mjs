/**
 * shortcuts – Keyboard shortcuts overview in the real app.
 *
 *   node scripts/e2e/screens/shortcuts.mjs            everything, writes the screenshots to target/e2e/shots/
 *   node scripts/e2e/screens/shortcuts.mjs --show     visible window
 *   node scripts/e2e/screens/shortcuts.mjs --no-shots without screenshots
 *
 * Everything via the keyboard. Checks: opening with Ctrl+/ (also with a German layout,
 * Ctrl+Shift+7), every shortcut from the command registry is listed (compared with the registry
 * of the running app), the fixed keys of lists and views, filter (word, key, several words),
 * nothing found, Esc in two steps, focus return, scrolling via keyboard, jump to the command
 * palette, two columns, 960×600, light theme. Spot checks: the shown shortcuts do what they say.
 * Fails on console errors.
 */
import { launchApp } from "../driver.mjs";
import { makeRichRepo } from "../fixtures.mjs";
import { assertNoConsoleErrors, createChecks, overflowX, storeApi, tabUntil } from "./commit-panel-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";
const show = process.argv.includes("--show");
const shots = !process.argv.includes("--no-shots");
const { failures, check, equal, eventually, section } = createChecks();
const SHOT_DIR = "target/e2e/shots";
const OVERLAY = '[data-screen="shortcuts"]';

const cleanups = [];
const apps = [];
const shot = async (app, name) => {
  if (!shots) return;
  await app.settle();
  await app.page.waitForTimeout(200);
  await app.screenshot(`${SHOT_DIR}/${name}.png`);
};

try {
  const rich = makeRichRepo();
  cleanups.push(() => rich.cleanup());
  const app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  apps.push(app);
  const { page } = app;
  const tab = await app.openRepo(rich.path);
  const store = storeApi(app, tab.tabId);
  const overlay = page.locator(OVERLAY);
  const input = overlay.locator('input[type="search"]');
  const entries = overlay.locator("[data-entry]");
  const isOpen = async () => (await overlay.count()) > 0;
  const entryKeys = () => entries.evaluateAll((rows) => rows.map((row) => row.dataset.entry));
  const entryText = (id) => overlay.locator(`[data-entry="${id}"]`).evaluate((row) => ({ label: row.querySelector("dt")?.textContent ?? "", keys: [...row.querySelectorAll("kbd")].map((key) => key.textContent) }));
  const focusInfo = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      return element ? { tag: element.tagName, role: element.getAttribute("role"), row: element.getAttribute("data-row-index"), label: element.getAttribute("aria-label"), text: (element.textContent ?? "").trim().slice(0, 40) } : null;
    });
  const type = async (text) => {
    await page.keyboard.press("Control+a");
    if (text) await page.keyboard.type(text, { delay: 5 });
    else await page.keyboard.press("Backspace");
    await page.waitForTimeout(60);
  };
  const open = async () => {
    await page.keyboard.press("Control+/");
    await input.waitFor({ timeout: 5000 });
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("type")), "search", "focus is in the search field");
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    if ((await isOpen()) && (await input.inputValue().catch(() => "")) === "") await page.waitForTimeout(50);
    await eventually(isOpen, false, "Esc closes the overview");
  };

  await section("Ctrl+/ opens (also with a German layout), focus in the search field, Esc returns focus", async () => {
    await page.locator('[data-screen="commit-graph"] [data-row-index][tabindex="0"]').first().focus();
    const before = await focusInfo();
    check(before?.row !== null, "before, focus is on a row in the graph");
    // German keyboard: "/" is Shift+7.
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "/", code: "Digit7", ctrlKey: true, shiftKey: true })));
    await input.waitFor({ timeout: 5000 });
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("type")), "search", "focus is in the search field");
    equal(await overlay.getAttribute("role"), "dialog", "the overview is a dialog");
    equal(await overlay.locator("h2").first().textContent(), "Keyboard shortcuts", "title");
    check(((await input.getAttribute("placeholder")) ?? "").includes("Search"), "the search field explains itself");
    check((await overlay.locator("label").first().textContent()).includes("Search shortcuts"), "the search field has a label");
    await shot(app, "shortcuts");
    await page.keyboard.press("Escape");
    await eventually(isOpen, false, "Esc closes");
    await eventually(focusInfo, before, "focus is back on the row in the graph");

    // The same shortcut closes again.
    await open();
    await page.keyboard.press("Control+/");
    await eventually(isOpen, false, "Ctrl+/ closes the open overview again");
    await eventually(focusInfo, before, "afterwards focus is back in the graph too");
  });

  await section("Every shortcut from the command registry is listed – with this platform's keys", async () => {
    await open();
    const registered = (await page.evaluate(() => window.__gcUi.commands())).filter((command) => command.shortcut);
    check(registered.length >= 30, `the registry knows ${registered.length} commands with a shortcut`);
    const shown = new Set(await entryKeys());
    const numbered = registered.filter((command) => /^tab\.goto\.[1-8]$/.test(command.id));
    for (const command of registered) {
      if (numbered.includes(command)) continue;
      if (!check(shown.has(command.id), `“${command.title}” (${command.id}) is in the overview`)) continue;
      const row = await entryText(command.id);
      // Mod → Ctrl on Windows; the last key is shown literally.
      const parts = command.shortcut.split("+").map((part, index, all) => (part === "" && index === all.length - 1 ? "+" : part)).filter(Boolean);
      const want = parts.map((part) => (part === "Mod" ? "Ctrl" : part));
      equal(row.keys, want, `keys of “${command.title}”`);
      check(!row.keys.includes("Mod"), `“${command.title}” shows no “Mod”`);
    }
    check(shown.has("tab.goto.range"), "Ctrl+1 to Ctrl+8 are listed as one row");
    const range = await entryText("tab.goto.range");
    equal(range.keys, ["Ctrl", "1", "Ctrl", "8"], "… from Ctrl+1 to Ctrl+8");
    // Groups as in the palette
    const groups = await overlay.locator('[data-part="commands"] h3').allTextContents();
    for (const group of ["General", "View and focus", "Tabs", "Repository", "Remote", "Branch", "Commit", "Stash"]) check(groups.includes(group), `group “${group}”`);
    for (const id of ["focus.next", "focus.previous", "focus.leftPanel", "focus.center", "focus.commitPanel", "app.palette", "app.shortcuts", "wip.commit", "sync.push", "repo.undo"]) {
      check(shown.has(id), `${id} is included`);
    }
  });

  await section("Fixed keys of lists and views", async () => {
    const sections = await overlay.locator('[data-part="fixed"] [data-section]').evaluateAll((list) =>
      list.map((element) => ({ id: element.dataset.section, title: element.querySelector("h3")?.textContent, keys: [...element.querySelectorAll("kbd")].map((key) => key.textContent), text: element.textContent })),
    );
    const byId = Object.fromEntries(sections.map((entry) => [entry.id, entry]));
    const has = (id, keys, what) => {
      const found = byId[`fixed-${id}`];
      if (!check(Boolean(found), `section “${what}” is missing`)) return;
      for (const key of keys) check(found.keys.includes(key), `${what}: key “${key}”`);
    };
    has("graph", ["J", "K", "H", "L", "↑", "↓", "Shift", "Enter", "Home", "End"], "Commit graph");
    has("wip", ["S", "U", "Ctrl", "Enter", "Del"], "Local changes");
    has("diff", ["F7", "Alt", "→", "←", "Space"], "Diff");
    has("conflict", ["F7", "T", "Space", "Ctrl", "S"], "Conflict tool");
    has("rebase", ["P", "R", "S", "D", "Alt", "↑", "↓", "Space"], "Rebase tool");
    has("history", ["B", "G", "Enter"], "File history");
    has("blame", ["P", "Enter"], "Blame");
    has("lists", ["F2", "Del", "Space"], "Lists and trees");
    has("search", ["F3", "Enter"], "Commit search");
    has("palette", [">", "@", "/", "#", "Tab"], "Command palette");
    check(byId["fixed-wip"]?.text.includes("Ctrl") && byId["fixed-wip"]?.text.includes("Stage all and commit"), "WIP: Ctrl+Shift+Enter is explained");
    check(!sections.some((entry) => entry.keys.includes("Mod") || entry.keys.some((key) => /^Arrow/.test(key ?? ""))), "no raw key names (Mod, ArrowUp …)");
  });

  await section("Two columns, nothing overflows; scrolling via keyboard", async () => {
    const lefts = await overlay.locator("[data-section]").evaluateAll((list) => [...new Set(list.map((element) => Math.round(element.getBoundingClientRect().left)))]);
    equal(lefts.length, 2, "at 1440 px the groups are in two columns");
    equal(await overflowX(page, `${OVERLAY} [data-scroll]`), { page: 0, element: 0 }, "no horizontal overflow");
    const scroller = overlay.locator("[data-scroll]");
    const top = () => scroller.evaluate((element) => Math.round(element.scrollTop));
    equal(await top(), 0, "the list is at the start");
    await page.keyboard.press("PageDown");
    await eventually(async () => (await top()) > 100, true, "PgDn in the search field scrolls the list");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("type")), "search", "focus stays in the search field");
    await page.keyboard.press("PageUp");
    await eventually(top, 0, "PgUp scrolls back");
    // The list itself is a tab stop too (for screen readers and arrow keys).
    await tabUntil(page, (element) => element?.getAttribute("role") === "region", { max: 6 });
    await page.keyboard.press("End");
    await eventually(async () => (await top()) > 300, true, "End in the list jumps down");
    await shot(app, "shortcuts-fixed");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
  });

  await section("Filter: word, key, several words; Esc clears first, then closes", async () => {
    await input.focus();
    await type("stash");
    const stash = await entryKeys();
    check(stash.length > 0 && stash.length < 15, `“stash” narrows down (${stash.length} entries)`);
    check(stash.includes("stash.create") || stash.some((id) => id.startsWith("stash.")), "the stash commands remain");
    const texts = await entries.allTextContents();
    const sectionTitles = await overlay.locator("[data-section] h3").allTextContents();
    check(texts.every((text, index) => /stash/i.test(text)) || sectionTitles.some((title) => /stash/i.test(title)), "every match mentions “Stash” – in its text or its group");
    await shot(app, "shortcuts-filter");

    await type("F7");
    const f7 = await entries.allTextContents();
    check(f7.length >= 2 && f7.every((text) => text.includes("F7")), `“F7” finds by key (${f7.length})`);

    await type("ctrl shift p");
    const push = await entryKeys();
    check(push.includes("sync.push"), "“ctrl shift p” finds Push");
    check(!push.includes("app.palette"), "… but not Ctrl+P without Shift");

    await type("undo");
    equal(await entryKeys(), ["repo.undo"], "“undo” finds “Undo”");

    await type("qqxyzzy");
    const empty = overlay.locator("[data-empty]");
    await empty.waitFor();
    check((await empty.innerText()).includes("“qqxyzzy”"), "nothing found: the text names the search term");
    equal(await entries.count(), 0, "no entries");
    await shot(app, "shortcuts-no-results");

    await page.keyboard.press("Escape");
    await eventually(() => input.inputValue(), "", "the first Esc clears the filter");
    equal(await isOpen(), true, "the overview stays open");
    check((await entries.count()) > 40, "all entries are back");
    await page.keyboard.press("Escape");
    await eventually(isOpen, false, "the second Esc closes");
  });

  await section("From the overview to the command palette (keyboard only)", async () => {
    await open();
    await tabUntil(page, (element) => (element?.textContent ?? "").includes("Open command palette"), { max: 8 });
    await page.keyboard.press("Enter");
    const palette = page.locator('[data-screen="command-palette"]');
    await palette.locator('input[role="combobox"]').waitFor();
    equal(await isOpen(), false, "the overview is closed");
    equal(await palette.locator('input[role="combobox"]').inputValue(), ">", "the palette starts with the commands");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox", "focus is in the palette input");
    await page.keyboard.press("Escape");
    await eventually(async () => palette.count(), 0, "Esc closes the palette");
    // Focus is returned a moment after unmounting.
    await eventually(async () => (await focusInfo())?.row !== null, true, "afterwards focus is back on the row in the graph");
  });

  await section("Spot checks: the shown shortcuts do what they say", async () => {
    // Areas (F6, Alt+1/2/3)
    const area = () =>
      page.evaluate(() => {
        const element = document.activeElement;
        if (!element) return null;
        if (element.closest('[data-area="left"]')) return "left";
        if (element.closest('[data-area="center"]')) return "center";
        if (element.closest('[data-area="right"]')) return "right";
        if (element.closest('[data-shell] > [role="toolbar"]')) return "toolbar";
        return element.tagName;
      });
    await page.keyboard.press("Alt+1");
    await eventually(area, "left", "Alt+1 → sidebar");
    await page.keyboard.press("Alt+2");
    await eventually(area, "center", "Alt+2 → view");
    await page.keyboard.press("Alt+3");
    await eventually(area, "right", "Alt+3 → commit panel");
    await page.keyboard.press("F6");
    await eventually(area, "toolbar", "F6 → toolbar");
    await page.keyboard.press("F6");
    await eventually(area, "left", "F6 → sidebar");
    await page.keyboard.press("Shift+F6");
    await eventually(area, "toolbar", "Shift+F6 → back");
    // Graph: J/K
    await page.keyboard.press("Alt+2");
    await eventually(area, "center", "back in the graph");
    const row = () => page.evaluate(() => document.activeElement?.getAttribute("data-row-index"));
    const start = Number(await row());
    await page.keyboard.press("j");
    await eventually(async () => Number(await row()), start + 1, "J → next commit");
    await page.keyboard.press("k");
    await eventually(async () => Number(await row()), start, "K → previous commit");
    // Ctrl+F → search
    await page.keyboard.press("Control+f");
    await eventually(store.searchOpen, true, "Ctrl+F opens the commit search");
    await page.keyboard.press("Escape");
    await eventually(store.searchOpen, false, "Esc closes it");
  });

  await section("Light and 960×600", async () => {
    await open();
    await app.setTheme("light");
    await shot(app, "shortcuts-light");
    await app.setTheme("dark");
    await close();
    await app.setSize(960, 600);
    await page.waitForTimeout(300);
    await open();
    const box = await overlay.boundingBox();
    check(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `fits in the window (${Math.round(box.width)}×${Math.round(box.height)})`);
    equal(await overflowX(page, `${OVERLAY} [data-scroll]`), { page: 0, element: 0 }, "no horizontal overflow");
    const lefts = await overlay.locator("[data-section]").evaluateAll((list) => [...new Set(list.map((element) => Math.round(element.getBoundingClientRect().left)))]);
    equal(lefts.length, 2, "two columns even in the smallest window");
    const clipped = await overlay.locator("[data-entry]").evaluateAll((rows) => rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length);
    equal(clipped, 0, "no row is clipped");
    await shot(app, "shortcuts-min");
    await type("rebase");
    await shot(app, "shortcuts-min-filter");
    await page.keyboard.press("Escape");
    await close();
    await app.setSize(1440, 900);
  });

  assertNoConsoleErrors(app, "shortcuts");
  await app.close();
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  for (const app of apps) await app.close().catch(() => undefined);
  for (const cleanup of cleanups) cleanup();
}

if (failures.length > 0) {
  console.error(`\nS26: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nS26: all green");
