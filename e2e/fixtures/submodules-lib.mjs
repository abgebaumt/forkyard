/**
 * Shared helpers for submodules.mjs (submodules), worktrees.mjs and lfs.mjs: fixtures with local bare
 * repositories as source, access to the sections in the left panel, menus by keyboard.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { appendAppGitConfig, gitIn } from "./mustfix-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const slashed = (file) => file.replaceAll("\\", "/");
export const samePath = (a, b) => slashed(a).replace(/\/+$/, "").toLowerCase() === slashed(b).replace(/\/+$/, "").toLowerCase();

/** git in `cwd` with the isolated configuration of fixture `fx`. */
export const git = (fx, cwd, ...args) => gitIn(cwd, path.join(fx.root, "gitconfig"), ...args);
/** Like `git`, with the file transport allowed (for submodules from local folders). */
export const gitFile = (fx, cwd, ...args) => git(fx, cwd, "-c", "protocol.file.allow=always", ...args);

/** Allows the app to use local folders as submodule sources, as a user would in their gitconfig. */
export function allowFileProtocol(app) {
  appendAppGitConfig(app, '[protocol "file"]\n\tallow = always\n');
}

/**
 * Creates a bare repository `<name>.git` next to the fixture, with `commits` commits in one file.
 * Returns { path, shas } (shas[0] is the oldest commit).
 */
export function makeLibrary(fx, name, { commits = 2, files = {} } = {}) {
  const work = path.join(fx.root, `_quelle-${name}`);
  fs.mkdirSync(work, { recursive: true });
  git(fx, work, "init", "-q", "-b", "main");
  git(fx, work, "config", "user.name", "Jonas Albrecht");
  git(fx, work, "config", "user.email", "jonas.albrecht@wetterstation.example");
  const shas = [];
  for (let index = 1; index <= commits; index++) {
    fs.writeFileSync(path.join(work, "LIESMICH.md"), `# ${name}\n\nStand ${index}.\n`);
    if (index === 1) {
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
        fs.writeFileSync(path.join(work, rel), content);
      }
    }
    git(fx, work, "add", "-A");
    git(fx, work, "commit", "-q", "-m", index === 1 ? `${name}: Grundgerüst` : `${name}: Stand ${index}`);
    shas.push(git(fx, work, "rev-parse", "HEAD"));
  }
  const bare = path.join(fx.root, `${name}.git`);
  git(fx, fx.root, "clone", "-q", "--bare", work, bare);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { path: bare, shas };
}

export const LIBS = {
  ready: "libs/sensor-treiber",
  drifted: "libs/karten-kacheln",
  edited: "libs/auswertung-kern",
  fresh: "extern/protokoll",
};

/**
 * Repository "station" with four submodules in four states:
 * initialized, drifted (other commit checked out), modified (own file), not initialized.
 * Plus `clonePath`: a fresh clone without submodules (all not initialized).
 */
export function makeSubmoduleRepo() {
  const fx = makeCleanRepoWithRemote({ name: "station" });
  const libs = {
    ready: makeLibrary(fx, "sensor-treiber", { commits: 2 }),
    drifted: makeLibrary(fx, "karten-kacheln", { commits: 3 }),
    edited: makeLibrary(fx, "auswertung-kern", { commits: 2 }),
    fresh: makeLibrary(fx, "protokoll", { commits: 1 }),
    extra: makeLibrary(fx, "wetter-symbole", { commits: 2, files: { "symbole/sonne.svg": "<svg/>\n" } }),
  };
  for (const key of ["ready", "drifted", "edited", "fresh"]) gitFile(fx, fx.path, "submodule", "add", "-q", libs[key].path, LIBS[key]);
  git(fx, fx.path, "commit", "-q", "-m", "Bibliotheken als Submodule eingebunden");
  git(fx, fx.path, "push", "-q", "origin", "main");

  const clonePath = path.join(fx.root, "station-klon");
  git(fx, fx.root, "clone", "-q", fx.remotePath, clonePath);
  git(fx, clonePath, "config", "user.name", "Lena Hartmann");
  git(fx, clonePath, "config", "user.email", "lena.hartmann@wetterstation.example");

  // Set up the states in the first repository.
  git(fx, path.join(fx.path, LIBS.drifted), "checkout", "-q", libs.drifted.shas[0]);
  fs.writeFileSync(path.join(fx.path, LIBS.edited, "NOTIZ.md"), "Lokaler Versuch, noch nicht committet.\n");
  gitFile(fx, fx.path, "submodule", "deinit", "-q", "-f", LIBS.fresh);
  return { fx, libs, clonePath };
}

/** Content of .gitmodules as a list of { name, path, url }. */
export function readGitmodules(repoPath) {
  const file = path.join(repoPath, ".gitmodules");
  if (!fs.existsSync(file)) return [];
  const entries = [];
  let current = null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const head = /^\[submodule "(.+)"\]$/.exec(line.trim());
    if (head) {
      current = { name: head[1], path: null, url: null };
      entries.push(current);
      continue;
    }
    const pair = /^\s*(path|url)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current[pair[1]] = pair[2].trim();
  }
  return entries;
}

/** `git worktree list --porcelain` as a list of { path, branch, head, locked, prunable, detached }. */
export function worktreeList(fx, repoPath) {
  const out = git(fx, repoPath, "worktree", "list", "--porcelain");
  return out
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const entry = { path: null, branch: null, head: null, locked: false, lockReason: null, prunable: false, detached: false };
      for (const line of block.split(/\r?\n/)) {
        const [key, ...rest] = line.split(" ");
        const value = rest.join(" ");
        if (key === "worktree") entry.path = value;
        else if (key === "HEAD") entry.head = value;
        else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "detached") entry.detached = true;
        else if (key === "locked") {
          entry.locked = true;
          entry.lockReason = value || null;
        } else if (key === "prunable") entry.prunable = true;
      }
      return entry;
    });
}

/** A server that accepts connections and never answers, so a clone reliably hangs "in flight". */
export function startSilentServer() {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: (name) => `http://127.0.0.1:${port}/${name}`,
        connections: () => sockets.size,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Access to the "Worktrees" and "Submodules" sections in the left panel and to menus. */
export function sideHelpers(app) {
  const { page } = app;
  const panel = () => page.locator('[data-screen="sidebar"]');
  const section = (id) => panel().locator(`[data-extra-section="${id}"]`);
  const header = (id) => section(id).locator("[data-section-header] button").first();
  const headerText = (id) => header(id).innerText().then((text) => text.replace(/\s+/g, " ").trim());
  const rows = (id) => section(id).locator("[data-side-row]");
  const row = (id, key) => section(id).locator(`[data-side-row="${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`);
  /** Row whose key (path) ends with `suffix`, for worktrees whose full path is long. */
  const rowEnding = async (id, suffix) => {
    const key = await rows(id).evaluateAll((list, end) => list.map((el) => el.dataset.sideRow).find((item) => item.replaceAll("\\", "/").toLowerCase().endsWith(end.toLowerCase())) ?? null, slashed(suffix));
    return key ? row(id, key) : null;
  };
  const rowTexts = (id) => rows(id).evaluateAll((list) => list.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
  const rowLabels = (id) => rows(id).evaluateAll((list) => list.map((el) => el.getAttribute("aria-label")));
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return el.getAttribute("data-side-row") ?? el.getAttribute("data-row-id") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) ?? el.tagName;
    });
  const menu = () => page.locator('[role="menu"]');
  const menuItems = () =>
    menu()
      .last()
      .locator('[role="menuitem"]')
      .evaluateAll((list) => list.map((item) => ({ text: item.innerText.replace(/\s+/g, " ").trim(), disabled: item.hasAttribute("data-disabled") })));
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await menu().first().waitFor({ state: "detached" });
  };
  /** In the open menu, move to the entry with the arrow keys and choose it with Enter. */
  const chooseByKeyboard = async (pattern) => {
    await menu().first().waitFor();
    const highlighted = () => page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? "");
    // Opened by keyboard, the first entry is already focused (a moment after opening).
    await page.waitForFunction(() => Boolean(document.querySelector('[role="menuitem"][data-highlighted]')), null, { timeout: 600 }).catch(() => undefined);
    for (let step = 0; step < 30; step++) {
      const before = await highlighted();
      if (step > 0 || !before) {
        await page.keyboard.press("ArrowDown");
        // Radix moves focus a moment after the key: wait for it, otherwise the key counts twice.
        await page.waitForFunction((old) => (document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? "") !== old, before, { timeout: 400 }).catch(() => undefined);
      }
      const text = await highlighted();
      if (pattern.test(text)) {
        await page.keyboard.press("Enter");
        await menu().first().waitFor({ state: "detached" });
        return true;
      }
    }
    await page.keyboard.press("Escape");
    return false;
  };
  /** Presses Tab until `matches()` is true in the page. */
  const tabUntil = async (matches, arg = null, { max = 80, back = false } = {}) => {
    for (let step = 0; step < max; step++) {
      if (await page.evaluate(matches, arg)) return true;
      await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    }
    return page.evaluate(matches, arg);
  };
  /** Runs a command via the command palette, keyboard only. */
  const palette = async (text) => {
    await page.keyboard.press("F1");
    await page.locator('input[role="combobox"]').first().waitFor();
    await page.keyboard.type(text, { delay: 5 });
    await page.waitForFunction((wanted) => (document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "").toLowerCase().includes(wanted.toLowerCase()), text, { timeout: 5000 }).catch(() => undefined);
    await page.keyboard.press("Enter");
  };
  const tabs = () => page.locator('[role="tablist"] [role="tab"]').evaluateAll((list) => list.map((tab) => ({ title: tab.getAttribute("aria-label") ?? tab.innerText.replace(/\s+/g, " ").trim(), active: tab.getAttribute("aria-selected") === "true" })));
  const escaping = (selector) =>
    page.evaluate((sel) => {
      const root = Array.from(document.querySelectorAll(sel)).at(-1);
      if (!root) return ["Element missing"];
      const box = root.getBoundingClientRect();
      const out = [];
      for (const el of root.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || el.closest(".sr-only")) continue;
        if (rect.left < box.left - 1 || rect.right > box.right + 1) out.push(`${el.tagName.toLowerCase()}: ${(el.textContent ?? "").trim().slice(0, 40)}`);
      }
      return out.slice(0, 5);
    }, selector);
  /**
   * Moves, keyboard only, to a row of section `id` whose key ends with `ending`:
   * Ctrl+Alt+F into the filter bar, ArrowDown into the ref rows, End to the last one, and from there
   * ArrowDown on through worktrees and submodules.
   */
  const focusRowByKeyboard = async (id, ending) => {
    await page.keyboard.press("Control+Alt+f");
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-left-filter"), null, { timeout: 5000 }).catch(() => undefined);
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-row-id"), null, { timeout: 3000 }).catch(() => undefined);
    await page.keyboard.press("End");
    await page.waitForTimeout(150);
    for (let step = 0; step < 160; step++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(25);
      const hit = await page.evaluate(
        ([section, end]) => {
          const element = document.activeElement;
          const key = element?.getAttribute("data-side-row");
          return Boolean(key && element.closest(`[data-extra-section="${section}"]`) && key.replaceAll("\\", "/").toLowerCase().endsWith(end.toLowerCase()));
        },
        [id, slashed(ending)],
      );
      if (hit) return true;
    }
    return false;
  };
  /** Refetches a query (as after a core event). */
  const refetch = (queryKey) => page.evaluate((key) => window.__gc.queryClient.invalidateQueries({ queryKey: key }), queryKey);
  /** Tells the page the window got focus (the invisible test window never really gets it). */
  const windowFocus = () => page.evaluate(() => void window.dispatchEvent(new Event("focus")));
  /** Does anything stick out of the left panel, or does it scroll horizontally? */
  const panelOverflow = () =>
    page.evaluate(() => {
      const scroller = document.querySelector("[data-left-scroll]");
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, panel: scroller ? scroller.scrollWidth - scroller.clientWidth : -1 };
    });
  const activeTabId = () => page.evaluate(() => window.__gc.queryClient.getQueryData(["app", "tabs"])?.find((tab) => tab.isActive)?.id ?? null);
  const activateTab = async (tabId) => {
    await page.locator(`[data-tab-id="${tabId}"] [role="tab"]`).click();
    await page.waitForFunction((id) => document.querySelector(`[data-tab-id="${id}"] [role="tab"]`)?.getAttribute("aria-selected") === "true", tabId);
    await app.settle();
  };
  return {
    panel,
    section,
    header,
    headerText,
    rows,
    row,
    rowEnding,
    rowTexts,
    rowLabels,
    focusRowByKeyboard,
    focused,
    menu,
    menuItems,
    closeMenu,
    chooseByKeyboard,
    tabUntil,
    palette,
    tabs,
    escaping,
    refetch,
    windowFocus,
    panelOverflow,
    activeTabId,
    activateTab,
  };
}
