/**
 * Checks the shell (shell) in the real app: window title, shortcuts, panels by keyboard, tabs,
 * messages, context menu, error states, narrow window. Independent of which Git commands exist –
 * only what belongs to the shell is checked.
 *
 *   node scripts/e2e/shell.mjs            everything
 *   node scripts/e2e/shell.mjs --show     window visible
 *
 * Not testable over CDP: whether the WebView itself reacts to Ctrl+P, Ctrl+F, F5 (print, find,
 * reload). Synthetic keys never trigger these browser shortcuts. They are disabled in
 * src-tauri/src/lib.rs (`disable_browser_keys`); see there.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./driver.mjs";
import { makeEmptyRepo, makeNotARepo, makeRichRepo } from "./fixtures.mjs";

const show = process.argv.includes("--show");
const failures = [];
let current = "";
const check = (condition, message) => {
  if (!condition) {
    failures.push(`${current}: ${message}`);
    console.log(`  ✗ ${message}`);
  }
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
/** Like `equal`, but waits up to 5 s for the value to match: the UI answers asynchronously, and slowly under load. */
const eventually = async (read, expected, message, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  let actual = await read();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    actual = await read();
  }
  equal(actual, expected, message);
};
const section = async (name, run) => {
  current = name;
  const before = failures.length;
  try {
    await run();
  } catch (error) {
    check(false, `aborted: ${error?.message ?? error}`);
  }
  console.log(`${failures.length === before ? "✓" : "✗"} ${name}`);
};

const rich = makeRichRepo();
const plain = makeNotARepo();
const extra = [];
let app = null;
try {
  app = await launchApp({ show });
  const { page } = app;
  const press = async (keys) => {
    await page.keyboard.press(keys);
    await page.waitForTimeout(120);
  };
  /** German keyboard: characters like "/" and "=" are on Shift+digit; Playwright only knows the US layout. */
  const pressKey = async (init) => {
    await page.evaluate((event) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...event })), init);
    await page.waitForTimeout(150);
  };
  const toasts = () => page.locator("[data-toast]").allInnerTexts();
  const closeToasts = async () => {
    // Always close the first one: the list moves up after every click.
    for (let round = 0; round < 10 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click();
      await page.waitForTimeout(150);
    }
  };
  const dialogs = () => page.locator('[role="dialog"]').evaluateAll((list) => list.map((dialog) => dialog.getAttribute("aria-label") ?? dialog.querySelector("h2")?.textContent ?? ""));
  const widths = () =>
    page.evaluate(() => ({
      left: document.querySelector('[data-area="left"]')?.getBoundingClientRect().width ?? null,
      right: document.querySelector('[data-area="right"]')?.getBoundingClientRect().width ?? null,
    }));
  const overflow = () => page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);
  const activeTab = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null);
  const tabCount = () => page.locator('[role="tab"]').count();

  let tabId = null;

  await section("Start without repository", async () => {
    await eventually(() => app.windowTitle(), "forkyard", "window title");
    await eventually(activeTab, "Repositories", "active tab");
    await eventually(toasts, [], "messages");
    await eventually(overflow, { x: 0, y: 0 }, "page overflow");
    check((await page.evaluate(() => document.hasFocus())) === true, "the page counts as focused");
  });

  await section("Open repository: Alt+O, window title, no flood of errors", async () => {
    await app.pick(rich.path);
    await press("Alt+o");
    await page.getByRole("tab", { name: /wetterstation/ }).waitFor();
    await app.settle();
    tabId = await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-tab-id]")?.getAttribute("data-tab-id"));
    await eventually(() => app.windowTitle(), "wetterstation – forkyard", "window title");
    // Even if many read commands still report "unsupported": no toast, no console error.
    await page.waitForTimeout(600);
    await eventually(toasts, [], "messages after opening");
    equal(app.consoleErrors, [], "console errors after opening");
    await eventually(overflow, { x: 0, y: 0 }, "page overflow");
    const footer = page.locator("footer");
    check((await footer.getByText("main", { exact: true }).count()) === 1, "status bar shows the branch");
    check((await footer.getByLabel("2 commits ahead").count()) === 1 && (await footer.getByLabel("1 commit behind").count()) === 1, "status bar shows 2 ahead and 1 behind (singular respected)");
  });

  await section("Panels: Ctrl+J, Ctrl+K, drag handle by keyboard", async () => {
    const start = await widths();
    check(start.left > 0 && start.right > 0, `both panels visible (${JSON.stringify(start)})`);
    await press("Control+j");
    await eventually(async () => (await widths()).left, null, "Ctrl+J collapses the sidebar");
    await press("Control+j");
    await eventually(async () => (await widths()).left, start.left, "Ctrl+J expands it again");
    await press("Control+k");
    await eventually(async () => (await widths()).right, null, "Ctrl+K collapses the commit panel");
    await press("Control+k");
    await eventually(async () => (await widths()).right, start.right, "Ctrl+K expands it again");

    const grip = page.locator('[role="separator"][data-side="left"]');
    await grip.focus();
    await press("ArrowRight");
    await eventually(async () => (await widths()).left, start.left + 8, "Arrow right widens by 8");
    await press("Shift+ArrowLeft");
    await eventually(async () => (await widths()).left, start.left - 24, "Shift+Arrow left narrows by 32");
    await press("Home");
    await eventually(async () => (await widths()).left < start.left, true, "Home sets the minimum width");
    const minimum = (await widths()).left;
    await eventually(async () => Number(await grip.getAttribute("aria-valuenow")), minimum, "aria-valuenow follows");
    await press("Enter");
    await eventually(async () => [(await widths()).left, await focused()], [null, "Show sidebar"], "Enter collapses, focus is on the show button");
    await press("Enter");
    await eventually(async () => [(await widths()).left, await focused()], [minimum, "Sidebar width"], "Enter expands, focus is back on the handle");
    await grip.dblclick();
    await eventually(async () => (await widths()).left, 260, "double click restores the default width");
  });

  await section("Overlays and search: Ctrl+P, Ctrl+comma, Ctrl+/, Ctrl+F", async () => {
    await press("Control+p");
    await page.waitForTimeout(150);
    await eventually(async () => (await dialogs()).length, 1, `Ctrl+P opens the command palette (open: ${JSON.stringify(await dialogs())})`);
    await press("Escape");
    await page.waitForTimeout(150);
    await eventually(dialogs, [], "Escape closes it");
    await press("Control+,");
    await page.waitForTimeout(150);
    await eventually(async () => (await dialogs()).length, 1, "Ctrl+comma opens the preferences");
    await press("Escape");
    await page.waitForTimeout(150);
    await pressKey({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true });
    await page.waitForTimeout(150);
    await eventually(async () => (await dialogs()).length, 1, "Ctrl+/ (German layout: Ctrl+Shift+7) opens the shortcuts");
    await press("Escape");
    await page.waitForTimeout(150);
    await eventually(dialogs, [], "all overlays closed again");

    const searchOpen = () => page.evaluate((id) => window.__gc.store.getState().views[id]?.searchOpen ?? false, tabId);
    await press("Control+f");
    await eventually(searchOpen, true, "Ctrl+F opens the commit search");
    await page.evaluate((id) => window.__gc.store.getState().setSearchOpen(id, false), tabId);
  });

  await section("Zoom: Ctrl+Plus, Ctrl+Minus, Ctrl+0", async () => {
    const zoom = async () => (await app.invoke("settings_get")).zoom;
    await press("Control+=");
    await page.waitForTimeout(250);
    await eventually(async () => [await zoom(), await page.evaluate(() => document.documentElement.style.zoom)], [1.1, "1.1"], "Ctrl+= zooms in to 110 %");
    await eventually(overflow, { x: 0, y: 0 }, "no overflow at 110 %");
    await pressKey({ key: "=", code: "Digit0", ctrlKey: true, shiftKey: true });
    await page.waitForTimeout(250);
    await eventually(zoom, 1.2, "Ctrl+= in German layout (Ctrl+Shift+0) zooms in further");
    await press("Control+-");
    await page.waitForTimeout(250);
    await eventually(zoom, 1.1, "Ctrl+- zooms out");
    await press("Control+0");
    await page.waitForTimeout(250);
    await eventually(zoom, 1, "Ctrl+0 resets");
    // The WebView does not zoom by itself (zoom control is disabled in Tauri): Ctrl+mouse wheel changes nothing.
    await page.mouse.move(700, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await page.waitForTimeout(200);
    equal(await page.evaluate(() => [window.innerWidth, window.devicePixelRatio]), [1440, 1], "Ctrl+mouse wheel does not zoom the page");
    await app.settle();
  });

  await section("Messages do not pile up", async () => {
    // The same error three times: one message. (A folder that does not exist – independent of commands still missing.)
    for (let round = 0; round < 3; round++) {
      await app.pick(path.join(plain.root, "gibt-es-nicht"));
      await press("Alt+o");
      await page.waitForTimeout(250);
    }
    await eventually(async () => (await toasts()).length, 1, "the same error three times yields one message");
    const once = await toasts();
    check(/Open repository failed/.test(once[0] ?? ""), `message names the action: ${once[0]}`);
    // Different errors: at most four at a time.
    for (let round = 0; round < 6; round++) {
      await app.pick(path.join(plain.root, `gibt-es-nicht-${round}`));
      await press("Alt+o");
      await page.waitForTimeout(200);
    }
    check((await toasts()).length <= 4, `at most four messages at a time (got ${(await toasts()).length})`);
    await closeToasts();
    await page.waitForTimeout(200);
    await eventually(toasts, [], "all messages can be closed");
    // Not a repository: the message explains it
    await app.pick(plain.path);
    await press("Alt+o");
    await page.waitForTimeout(300);
    await eventually(async () => (await toasts()).length, 1, "an ordinary folder yields one message");
    await closeToasts();
  });

  await section("WebView context menu", async () => {
    const prevented = (selector) =>
      page.evaluate(
        (target) =>
          new Promise((resolve) => {
            const element = document.querySelector(target);
            window.addEventListener("contextmenu", (event) => setTimeout(() => resolve(event.defaultPrevented), 0), { once: true });
            element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
          }),
        selector,
      );
    equal(await prevented("main"), true, "suppressed outside of text fields");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "gc-e2e-probe";
      document.body.appendChild(input);
    });
    equal(await prevented("#gc-e2e-probe"), false, "kept in text fields (cut, copy, paste)");
    await page.evaluate(() => document.getElementById("gc-e2e-probe")?.remove());
  });

  await section("Tabs: Ctrl+T, Ctrl+1…9, Ctrl+Tab, Ctrl+W, many tabs", async () => {
    const before = await tabCount();
    await press("Control+t");
    await page.waitForTimeout(200);
    await eventually(async () => [await tabCount(), await activeTab()], [before + 1, "Repositories"], "Ctrl+T opens repository management");
    await press("Control+1");
    await page.waitForTimeout(200);
    await eventually(async () => /^wetterstation/.test((await activeTab()) ?? ""), true, "Ctrl+1 activates the first tab");
    await press("Control+Tab");
    await page.waitForTimeout(200);
    await eventually(activeTab, "Repositories", "Ctrl+Tab goes to the next tab");
    await press("Control+w");
    await page.waitForTimeout(200);
    await eventually(tabCount, before, "Ctrl+W closes the active tab");

    for (let index = 1; index <= 12; index++) {
      const repo = makeEmptyRepo({ name: `station-${String(index).padStart(2, "0")}` });
      extra.push(repo);
      await app.invoke("repo_open", { path: repo.path });
    }
    await app.settle();
    await page.waitForTimeout(300);
    await eventually(overflow, { x: 0, y: 0 }, "13 tabs do not break the page");
    const narrowest = await page.locator("[data-tab-id]").evaluateAll((list) => Math.min(...list.map((item) => item.getBoundingClientRect().width)));
    check(narrowest >= 127, `tabs stay wide enough to read (narrowest: ${narrowest} px)`);
    await eventually(() => page.getByRole("button", { name: "All tabs" }).count(), 1, "the overflow menu \"All tabs\" appears");
    const activeVisible = await page.evaluate(() => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]')?.getBoundingClientRect();
      const list = document.querySelector('[role="tablist"]')?.getBoundingClientRect();
      return Boolean(tab && list && tab.left >= list.left - 1 && tab.right <= list.right + 1);
    });
    check(activeVisible, "the active tab is in the visible part of the bar");
    await press("Control+1");
    await page.waitForTimeout(200);
  });

  await section("Narrow window 960×600", async () => {
    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    await eventually(overflow, { x: 0, y: 0 }, "no overflow");
    const layout = await widths();
    check(layout.left === null && layout.right > 0, `sidebar is collapsed, commit panel visible (${JSON.stringify(layout)})`);
    const center = await page.evaluate(() => document.querySelector('[data-area="center"]')?.getBoundingClientRect().width ?? 0);
    check(center >= 320, `the center keeps its minimum width (${center} px)`);
    const clipped = await page.getByRole("toolbar", { name: "Repository actions" }).evaluate((bar) => bar.scrollWidth - bar.clientWidth);
    check(clipped <= 0, `the toolbar fits (${clipped} px too wide)`);
    await app.setSize(1440, 900);
  });

  await section("The repository folder disappears", async () => {
    const away = `${rich.path}-moved`;
    fs.renameSync(rich.path, away);
    try {
      // Window focus triggers the status refresh.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.getByRole("heading", { name: /wetterstation” is gone/ }).waitFor({ timeout: 5000 });
      check((await page.getByRole("toolbar", { name: "Repository actions" }).count()) === 0, "the repo toolbar is gone");
      await eventually(toasts, [], "no message for it – the state is shown full page");
    } finally {
      fs.renameSync(away, rich.path);
    }
    await page.getByRole("button", { name: "Check again" }).click();
    await page.getByRole("toolbar", { name: "Repository actions" }).waitFor({ timeout: 5000 });
  });

  current = "Console";
  check(app.consoleErrors.length === 0, `Console errors:\n${app.consoleErrors.join("\n")}`);
  await app.close();
  app = null;

  await section("Start without Git", async () => {
    app = await launchApp({ show, gitPath: path.join(plain.root, "no-git", "git.exe"), waitForShell: false });
    equal(await app.waitForShell(), "fullpage", "a full-page message is shown instead of the shell");
    check((await app.page.getByRole("heading", { name: "Git was not found" }).count()) === 1, "heading \"Git was not found\"");
    check((await app.page.getByRole("button", { name: "Check again" }).count()) === 1, "button \"Check again\"");
    equal(app.consoleErrors, [], "console errors");
  });
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/shell-error.png").catch(() => undefined);
  await app?.close();
  rich.cleanup();
  plain.cleanup();
  for (const repo of extra) repo.cleanup();
}
console.log(failures.length ? `\nShell check failed: ${failures.length} deviations (image: target/e2e/shell-error.png).` : "\nShell check green.");
process.exit(failures.length ? 1 : 0);
