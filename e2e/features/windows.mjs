/**
 * Several windows: tabs move between windows through the tab menu (with their terminal), "New
 * window" from the shortcut and the palette, the same repository in two windows, windows survive a
 * restart, closing the main window keeps the other one, closing the last window quits.
 *
 *   node e2e/features/windows.mjs
 *
 * WebKitWebDriver lists every app window as its own handle, so a scenario switches into a window
 * (`app.switchToWindow`) to drive and read it; core calls then run as that window. Dragging a tab
 * between windows needs pointer capture outside a window, which WebDriver cannot do: that and the
 * other manual checks are listed in e2e/README.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCleanRepoWithRemote, makeEmptyRepo } from "../fixtures/fixtures.mjs";
import { commitUi } from "../fixtures/commit-ui.mjs";
import { appPid, makeDataDir, readMarker, waitForExit } from "../fixtures/crash.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const TERMINAL = '[data-screen="terminal"]';
const PALETTE_INPUT = '[data-screen="command-palette"] input[role="combobox"]';

/** A throw-away HOME with a plain bash, so the user's shell profile is never touched. */
function shellEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-shell-home-"));
  fs.writeFileSync(path.join(home, ".bash_profile"), "export PS1='fy$ '\nunset HISTFILE\nexport HISTSIZE=0\n");
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
  return { SHELL: "/bin/bash", HOME: home, HISTFILE: "/dev/null" };
}

const windowList = (app) => app.invoke("window_list");
const label = (app) => app.exec(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
const tabIds = (app) => app.exec(() => [...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id")));
const tabActive = (app, tabId) =>
  app.exec((id) => document.querySelector(`[data-tab-id="${id}"] [role="tab"]`)?.getAttribute("aria-selected") === "true", tabId);
const openTerminals = (app) => app.exec(() => window.__gcTerminal?.openIds() ?? []);

const waitWindows = (app, count) =>
  app.waitFor(
    async () => {
      const list = await windowList(app);
      return list.length === count ? list : null;
    },
    15_000,
    { message: `${count} window(s) in window_list` },
  );

/** Waits for `count` window handles; returns them. */
const waitHandles = (app, count) =>
  app.waitFor(
    async () => {
      const handles = await app.windowHandles();
      return handles.length === count ? handles : null;
    },
    15_000,
    { message: `${count} window handle(s)` },
  );

/** Switches into the window with this label (waits for its page) and returns its handle. */
async function switchTo(app, wanted) {
  return app.waitFor(
    async () => {
      for (const handle of await app.windowHandles()) {
        await app.switchToWindow(handle);
        const here = await label(app).catch(() => null);
        if (here === wanted) return handle;
      }
      return null;
    },
    15_000,
    { message: `window ${wanted}` },
  );
}

/** Switches into a window and waits for its shell. */
async function enter(app, wanted) {
  await switchTo(app, wanted);
  await app.waitForShell(30_000);
  await app.settle();
}

/** Opens the tab's context menu (as a right click does). */
const tabMenu = (app, tabId) =>
  app.exec((id) => {
    const target = document.querySelector(`[data-tab-id="${id}"] [role="tab"]`);
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 10,
        clientY: box.top + box.height / 2,
        button: 2,
      }),
    );
    return true;
  }, tabId);

/** A visible menu item (submenus included) whose text starts with `text`. */
const menuItem = (app, text) =>
  app.waitFor(
    () =>
      app.exec((wanted) => {
        const norm = (value) => (value ?? "").replace(/\s+/g, " ").trim();
        return (
          [...document.querySelectorAll('[role="menuitem"]')].find(
            (item) => item.getBoundingClientRect().width > 0 && norm(item.innerText).startsWith(wanted),
          ) ?? null
        );
      }, text),
    10_000,
    { message: `menu item “${text}”` },
  );

/** Tab menu › "Move to new window"; returns the new window's label. */
async function moveToNewWindow(app, tabId) {
  const before = (await windowList(app)).map((info) => info.label);
  await tabMenu(app, tabId);
  await app.click(await menuItem(app, "Move to new window"));
  const list = await waitWindows(app, before.length + 1);
  return list.find((info) => !before.includes(info.label)).label;
}

/** Tab menu › "Move to window" › the entry for the window `target`, named `title`. */
async function moveToWindow(app, tabId, target, title) {
  // The menu names windows from this window's cached list, which refreshes after a change elsewhere.
  await app.waitFor(
    () =>
      app.exec(
        (wanted, name) => window.__gc.queryClient.getQueryData(["app", "windows"])?.find((info) => info.label === wanted)?.title === name,
        target,
        title,
      ),
    10_000,
    { message: `${target} listed as ${title}` },
  );
  await tabMenu(app, tabId);
  await app.click(await menuItem(app, "Move to window"));
  await app.click(await menuItem(app, title));
}

/** Main window with the repositories R and S open; S's tab is the active one. */
async function openTwo(t, options = {}) {
  const r = makeEmptyRepo({ name: "alpha" });
  const s = makeEmptyRepo({ name: "beta" });
  t.cleanup.push(r.cleanup, s.cleanup);
  const app = await t.launch({ ...LAUNCH, ...options });
  const R = await app.openRepo(r.path);
  const S = await app.openRepo(s.path);
  return { app, R, S, r, s };
}

/** Wraps a scenario body: `t.cleanup` runs afterwards in any case. */
const withCleanup = (fn) => async (t) => {
  t.cleanup = [];
  try {
    await fn(t);
  } finally {
    for (const cleanup of t.cleanup) cleanup();
  }
};

scenario(
  "tab via menu into a new window, its terminal moves along",
  "main",
  withCleanup(async (t) => {
    const { app, S } = await openTwo(t, { env: shellEnv() });
    await app.press("Control+`");
    await app.waitFor(TERMINAL, 10_000, { message: "terminal panel" });
    const terminalId = await app.waitFor(
      () => app.exec((tabId) => (window.__gcTerminal?.status(tabId)?.kind === "running" ? window.__gcTerminal.id(tabId) : null), S.tabId),
      20_000,
      { message: "shell running in S" },
    );
    assertIncludes(await openTerminals(app), terminalId, "main holds the terminal");

    const target = await moveToNewWindow(app, S.tabId);
    const list = await windowList(app);
    const moved = list.find((info) => info.label === target);
    assertEqual({ tabs: moved.tabs, title: moved.title }, { tabs: 1, title: "beta" }, "the new window holds S alone");
    await app.waitFor(async () => !(await tabIds(app)).includes(S.tabId), 10_000, { message: "S left main's strip" });
    await app.waitFor(async () => !(await openTerminals(app)).includes(terminalId), 10_000, { message: "terminal left main" });
    t.step("S moved out of main");

    await enter(app, target);
    assertEqual(await tabIds(app), [S.tabId], "the new window's strip");
    await app.waitFor(async () => (await openTerminals(app)).includes(terminalId), 15_000, {
      message: "terminal adopted by the new window",
    });
    await t.shot("moved-to-new-window");
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "move a tab into another window via the menu and back again",
  "main",
  withCleanup(async (t) => {
    const { app, R, S } = await openTwo(t);
    const second = await moveToNewWindow(app, S.tabId);
    const tRepo = makeEmptyRepo({ name: "gamma" });
    t.cleanup.push(tRepo.cleanup);
    const T = await app.openRepo(tRepo.path);

    await moveToWindow(app, T.tabId, second, "beta");
    const list = await app.waitFor(
      async () => {
        const now = await windowList(app);
        return now.find((info) => info.label === second)?.tabs === 2 ? now : null;
      },
      15_000,
      { message: "the second window holds two tabs" },
    );
    assertEqual(list.find((info) => info.label === "main").tabs, 1, "main keeps R");
    await enter(app, second);
    await app.waitFor(() => tabActive(app, T.tabId), 15_000, { message: "T active in the second window" });
    assertEqual(await tabIds(app), [S.tabId, T.tabId], "second window's strip: S, then T");
    t.step("T moved into the second window");

    // Back from the second window into main (named after its active tab, R).
    await moveToWindow(app, T.tabId, "main", "alpha");
    await app.waitFor(async () => !(await tabIds(app)).includes(T.tabId), 15_000, { message: "T left the second window" });
    await enter(app, "main");
    await app.waitFor(() => tabActive(app, T.tabId), 15_000, { message: "T active in main again" });
    assertEqual(await tabIds(app), [R.tabId, T.tabId], "main's strip: R, then T");
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "same repository in two windows: a commit in one appears in the other",
  "main",
  withCleanup(async (t) => {
    const repo = makeCleanRepoWithRemote();
    t.cleanup.push(repo.cleanup);
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    const { repoId } = await app.openRepo(repo.path);
    const second = await app.invoke("window_new");
    await enter(app, second);
    await app.openRepo(repo.path);
    t.step("the repository is open in both windows");

    await enter(app, "main");
    const ui = commitUi(app);
    repo.write("notiz.txt", "Zweites Fenster prüfen.\n");
    await ui.refresh();
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one changed file");
    await app.click({ text: "Stage all", within: '[data-section="unstaged"]' });
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "staged");
    await ui.fill(await ui.summary(), "Notiz aus dem ersten Fenster");
    await app.press("Control+Enter");
    await ui.waitToast("success", /Commit created/);

    await enter(app, second);
    await app.waitFor(
      () =>
        app.exec(() =>
          [...document.querySelectorAll('[data-row-kind="commit"] [data-cell="message"]')].some((cell) =>
            cell.innerText.includes("Notiz aus dem ersten Fenster"),
          ),
        ),
      20_000,
      { message: "the commit in the second window's graph" },
    );
    await t.shot("commit-in-other-window");
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "New window from the shortcut and from the palette",
  "main",
  withCleanup(async (t) => {
    const app = await t.launch(LAUNCH);
    await app.press("Control+Shift+n");
    await waitWindows(app, 2);
    await switchTo(app, "main");
    await app.press("Control+p");
    await app.waitFor(PALETTE_INPUT, 5000, { message: "palette open" });
    await app.type(PALETTE_INPUT, "New window");
    await app.waitFor(
      () =>
        app.exec(() => document.querySelector('[data-screen="command-palette"] [aria-selected="true"]')?.innerText.includes("New window")),
      10_000,
      { message: "New window selected in the palette" },
    );
    await app.press("Enter");
    const list = await waitWindows(app, 3);
    assertEqual(
      list.map((info) => info.tabs),
      [1, 1, 1],
      "each new window starts with one tab",
    );
    await waitHandles(app, 3);
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "restart restores both windows; closing main keeps the other one for the next start",
  "main",
  withCleanup(async (t) => {
    const data = makeDataDir();
    t.cleanup.push(data.cleanup);
    const { app: first, S } = await openTwo(t, { dataDir: data.path });
    const second = await moveToNewWindow(first, S.tabId);
    await first.close();

    const app = await t.launch({ ...LAUNCH, dataDir: data.path });
    await waitHandles(app, 2);
    const list = await waitWindows(app, 2);
    assertEqual(
      list.map((info) => [info.label, info.tabs]),
      [
        ["main", 1],
        [second, 1],
      ],
      "both windows with their tab counts",
    );
    t.step("both windows restored");

    // Close main from inside (as its × does once nothing is unsaved); the other window stays.
    await switchTo(app, "main");
    await app.exec(() => {
      void window.__TAURI_INTERNALS__.invoke("window_close");
      return true;
    });
    await waitHandles(app, 1);
    await enter(app, second);
    assertEqual(
      (await waitWindows(app, 1)).map((info) => [info.title, info.tabs]),
      [["beta", 1]],
      "only the second window is left",
    );
    await app.close();

    const again = await t.launch({ ...LAUNCH, dataDir: data.path });
    await waitHandles(again, 1);
    assertEqual(
      (await waitWindows(again, 1)).map((info) => [info.title, info.tabs]),
      [["beta", 1]],
      "the next start opens the remaining window",
    );
    await t.noConsoleErrors(again);
  }),
);

scenario(
  "the only tab cannot be torn out",
  "edge",
  withCleanup(async (t) => {
    const app = await t.launch(LAUNCH);
    const [only] = await app.waitFor(async () => ((await tabIds(app)).length === 1 ? tabIds(app) : null), 10_000, { message: "one tab" });
    await tabMenu(app, only);
    const item = await menuItem(app, "Move to new window");
    assert((await item.attr("data-disabled")) !== null, "the entry is disabled");
    assertIncludes(await app.exec((el) => el.innerText, item), "The tab is already alone in its window.", "the entry names the reason");
    await app.press("Escape");
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "closing the last window quits the app",
  "edge",
  withCleanup(async (t) => {
    const data = makeDataDir();
    t.cleanup.push(data.cleanup);
    const app = await t.launch({ ...LAUNCH, dataDir: data.path });
    const { pid } = await appPid(data.path);
    await app.exec(() => {
      void window.__TAURI_INTERNALS__.invoke("window_close");
      return true;
    });
    assert(await waitForExit(pid), "the app process ended");
    assertEqual(readMarker(data.path), null, "a clean quit, no crash marker");
  }),
);
