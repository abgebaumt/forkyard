/**
 * The app window never scrolls, whatever happens: keyboard focus through every section of the left
 * panel (ref rows, Worktrees, Submodules, section headers), Tab/Shift+Tab/F6, scroll keys while
 * nothing scrollable has focus, the mouse wheel over the status bar and the title bar, a text
 * selection dragged to the window edge, scrollIntoView() on elements at the bottom, dialogs and
 * menus, and a window resized to a small height. After every step the document, body, #root and
 * every shell container (`[data-shell]`, `[data-no-scroll]`) sit at scroll position 0 and the status
 * bar ends exactly at the bottom of the window.
 *
 *   node scripts/e2e-wd/features/shell-no-scroll.mjs
 *   E2E_WD_ONLY="wheel" node scripts/e2e-wd/features/shell-no-scroll.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRichRepo } from "../../e2e/fixtures.mjs";
import { AssertionError, scenario } from "../lib.mjs";

// Small window: the left panel has more rows than fit, so moving through it has to scroll its list.
const LAUNCH = { width: 1100, height: 640, theme: "light", lang: "en" };
const STATUS_BAR = '[data-shell="app"] > footer';

/** Scroll offsets of the frame (document, body, #root, shell containers) and where the status bar ends. */
const layout = (app) =>
  app.exec((statusSelector) => {
    const offsets = {};
    const note = (name, element) => {
      if (!element) return;
      if (element.scrollTop !== 0 || element.scrollLeft !== 0) offsets[name] = [element.scrollTop, element.scrollLeft];
    };
    note("scrollingElement", document.scrollingElement);
    note("html", document.documentElement);
    note("body", document.body);
    note("root", document.getElementById("root"));
    for (const [index, element] of [...document.querySelectorAll("[data-shell], [data-no-scroll]")].entries()) {
      note(`${element.getAttribute("data-shell") ? `shell:${element.getAttribute("data-shell")}` : (element.getAttribute("data-area") ?? element.tagName.toLowerCase())}#${index}`, element);
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) offsets.window = [window.scrollY, window.scrollX];
    const status = document.querySelector(statusSelector);
    const shell = document.querySelector('[data-shell="app"]');
    const active = document.activeElement;
    return {
      offsets,
      statusBottom: status ? Math.round(status.getBoundingClientRect().bottom) : null,
      shellTop: shell ? Math.round(shell.getBoundingClientRect().top) : null,
      // Nothing in the frame sticks out below it (the original cause: status bar buttons 1 px too tall).
      shellOverflow: shell ? shell.scrollHeight - shell.clientHeight : null,
      innerHeight: window.innerHeight,
      focus: active ? (active.getAttribute("data-side-row") ?? active.getAttribute("data-row-id") ?? active.getAttribute("aria-label") ?? active.tagName) : null,
    };
  }, STATUS_BAR);

async function assertPinned(app, step) {
  const now = await layout(app);
  const problems = Object.entries(now.offsets).map(([name, [top, left]]) => `${name} scrolled to ${top}/${left}`);
  if (now.statusBottom !== now.innerHeight) problems.push(`status bar ends at ${now.statusBottom}, window is ${now.innerHeight}`);
  if (now.shellTop !== 0) problems.push(`shell top at ${now.shellTop}`);
  if (now.shellOverflow) problems.push(`shell content ${now.shellOverflow} px taller than the window`);
  if (problems.length) throw new AssertionError(`${step} (focus ${now.focus}): ${problems.join(", ")}`);
  return now;
}

/** Two animation frames: scroll events and the guard have run. */
const frames = (app) => app.exec(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));

function addWorktrees(repoPath, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-wd-wt-"));
  for (let index = 1; index <= count; index++) {
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", `arbeit-${index}`, path.join(dir, `arbeit-${index}`)], { stdio: "pipe" });
  }
  return dir;
}

async function start(t, repo, options = {}) {
  const app = await t.launch({ ...LAUNCH, ...options });
  await app.openRepo(repo.path);
  await app.waitFor('[data-left-scroll] [data-row-id^="refs/heads/"]', 20_000, { message: "branch rows in the left panel" });
  await app.waitFor(STATUS_BAR, 10_000, { message: "status bar" });
  await app.settle();
  await assertPinned(app, "after opening");
  return app;
}

/** Centre of an element in viewport coordinates (integers, inside the window). */
const centre = (app, element) =>
  app.exec((el) => {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, element);

async function wheel(app, element, deltaY) {
  const { x, y } = await centre(app, element);
  await app.webdriver("POST", "/actions", {
    actions: [{ type: "wheel", id: "wheel", actions: [{ type: "scroll", x, y, deltaX: 0, deltaY, duration: 100, origin: "viewport" }] }],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
  await frames(app);
}

scenario("keyboard focus through every left panel section incl. Worktrees", "main", async (t) => {
  const repo = makeRichRepo();
  const worktreesDir = addWorktrees(repo.path, 6);
  try {
    const app = await start(t, repo);
    const worktreeRow = await app.waitFor(
      () => app.exec(() => [...document.querySelectorAll('[data-extra-section="worktrees"] [data-side-row]')].find((row) => row.textContent.includes("arbeit-6")) ?? null),
      20_000,
      { message: "worktree rows in the left panel" },
    );
    t.step("repository with 6 worktrees open");

    // Into the left panel with the keyboard, all the way down row by row (crosses into Worktrees and
    // Submodules), and back up again.
    await app.click('[data-left-scroll] [data-row-id^="refs/heads/"]');
    await assertPinned(app, "branch row clicked");
    const rowCount = await app.exec(() => document.querySelectorAll("[data-left-scroll] [data-side-row], [data-left-scroll] [data-row-id]").length);
    for (let index = 0; index < rowCount + 4; index++) {
      await app.press("ArrowDown");
      await assertPinned(app, `ArrowDown #${index + 1}`);
    }
    for (let index = 0; index < rowCount + 4; index++) {
      await app.press("ArrowUp");
      await assertPinned(app, `ArrowUp #${index + 1}`);
    }
    t.step(`ArrowDown/ArrowUp through ${rowCount} rows`);

    // Straight onto a worktree row (focus ring), Home/End, the section header.
    await app.click(worktreeRow);
    await assertPinned(app, "worktree row clicked");
    for (const key of ["End", "Home", "End", "ArrowUp", "ArrowDown", "PageDown", "PageUp"]) {
      await app.press(key);
      await assertPinned(app, `worktree ${key}`);
    }
    const header = await app.waitFor('[data-extra-section="worktrees"] [data-section-header] button', 5_000, { message: "Worktrees header button" });
    await app.exec((element) => element.focus(), header);
    await assertPinned(app, "Worktrees header focused");
    await app.press("ArrowDown");
    await assertPinned(app, "Worktrees header ArrowDown");
    t.step("Home/End/PageDown and header in Worktrees");

    // From the last worktree row, Tab and F6 cycle through the whole shell, status bar included.
    await app.exec(() => {
      const row = [...document.querySelectorAll('[data-extra-section="worktrees"] [data-side-row]')].at(-1);
      row?.focus();
      return Boolean(row);
    });
    await assertPinned(app, "last worktree row focused");
    for (let index = 0; index < 30; index++) {
      await app.press("Tab");
      await assertPinned(app, `Tab #${index + 1}`);
    }
    for (let index = 0; index < 30; index++) {
      await app.press("Shift+Tab");
      await assertPinned(app, `Shift+Tab #${index + 1}`);
    }
    for (let index = 0; index < 8; index++) {
      await app.press("F6");
      await assertPinned(app, `F6 #${index + 1}`);
    }
    t.step("Tab, Shift+Tab and F6 cycles");
    await t.shot("after-keyboard");
    await t.noConsoleErrors(app);
  } finally {
    fs.rmSync(worktreesDir, { recursive: true, force: true });
    repo.cleanup();
  }
});

scenario("scroll keys while nothing scrollable has focus", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await start(t, repo);
    await app.exec(() => {
      document.activeElement?.blur();
      return true;
    });
    for (const key of ["Space", "PageDown", "End", "ArrowDown", "Shift+Space", "PageUp", "Home"]) {
      await app.exec(() => {
        document.activeElement?.blur();
        return true;
      });
      await app.press(key === "Space" ? " " : key === "Shift+Space" ? "Shift+ " : key);
      await frames(app);
      await assertPinned(app, `${key} on body`);
    }
    t.step("Space/PageDown/End/ArrowDown on body");
    // A focused element that does not scroll itself: a status bar button.
    const statusButton = await app.waitFor(`${STATUS_BAR} button`, 5_000, { message: "status bar button" });
    await app.exec((element) => element.focus(), statusButton);
    for (const key of ["PageDown", "End", "ArrowDown"]) {
      await app.press(key);
      await frames(app);
      await assertPinned(app, `${key} on a status bar button`);
    }
    t.step("PageDown/End/ArrowDown on a status bar button");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("mouse wheel over the status bar and the title bar", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await start(t, repo);
    const status = await app.$(STATUS_BAR);
    const tabStrip = await app.$('[data-shell="app"] > :first-child');
    for (const [name, element] of [["status bar", status], ["title bar", tabStrip]]) {
      for (const deltaY of [600, -600, 600]) {
        await wheel(app, element, deltaY);
        await assertPinned(app, `wheel ${deltaY} over the ${name}`);
      }
    }
    t.step("wheel over status bar and title bar");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("a text selection dragged to the bottom edge of the window", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await start(t, repo);
    // Selectable text: the details of a commit (message, SHA) in the right panel.
    const commits = await app.waitFor(async () => {
      const found = await app.$$('[data-row-kind="commit"]');
      return found.length >= 3 ? found : null;
    }, 20_000, { message: "commit rows" });
    await app.click(commits[2]);
    const text = await app.waitFor(
      () => app.exec(() => [...document.querySelectorAll(".selectable")].find((el) => el.getBoundingClientRect().height > 0 && el.textContent.trim().length > 3) ?? null),
      15_000,
      { message: "selectable text" },
    );
    const from = await centre(app, text);
    const { innerHeight } = await layout(app);
    await app.webdriver("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", x: from.x, y: from.y, origin: "viewport", duration: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", x: from.x, y: innerHeight - 1, origin: "viewport", duration: 300 },
            { type: "pause", duration: 800 },
            { type: "pointerMove", x: Math.max(1, from.x - 200), y: innerHeight - 1, origin: "viewport", duration: 200 },
            { type: "pause", duration: 400 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await app.webdriver("DELETE", "/actions").catch(() => undefined);
    await frames(app);
    await assertPinned(app, "selection dragged to the bottom edge");
    t.step("selection drag");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("scrollIntoView() and focus() on elements at the bottom", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await start(t, repo);
    for (const block of ["start", "center", "end", "nearest"]) {
      await app.exec(
        (where, statusSelector) => {
          const rows = [...document.querySelectorAll("[data-left-scroll] [data-row-id], [data-left-scroll] [data-side-row]")];
          rows.at(-1)?.scrollIntoView({ block: where });
          document.querySelector(statusSelector)?.scrollIntoView({ block: where, inline: where });
          for (const button of document.querySelectorAll(`${statusSelector} button`)) button.focus();
          return true;
        },
        block,
        STATUS_BAR,
      );
      await frames(app);
      await assertPinned(app, `scrollIntoView({ block: "${block}" })`);
    }
    // Even a direct assignment does not stick.
    await app.exec(() => {
      document.scrollingElement.scrollTop = 200;
      document.getElementById("root").scrollTop = 200;
      document.querySelector('[data-shell="app"]').scrollTop = 200;
      return true;
    });
    await frames(app);
    await assertPinned(app, "scrollTop assigned");
    t.step("programmatic scrolls");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("something sticking out of the frame still cannot scroll the window", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await start(t, repo);
    // An absolutely positioned element far below the window escapes every clip (its containing
    // block is the viewport) and makes the viewport scrollable for script: the guard must hold it.
    await app.exec(() => {
      const probe = document.createElement("button");
      probe.id = "scroll-probe";
      probe.textContent = "probe";
      probe.style.cssText = "position:absolute;left:0;top:2400px;";
      document.getElementById("root").append(probe);
      probe.scrollIntoView({ block: "end" });
      probe.focus();
      window.scrollTo(0, 1200);
      document.scrollingElement.scrollTop = 900;
      return document.scrollingElement.scrollHeight > window.innerHeight;
    });
    await frames(app);
    try {
      await assertPinned(app, "probe below the window");
    } finally {
      await app.exec(() => {
        document.getElementById("scroll-probe")?.remove();
        return true;
      });
    }
    t.step("viewport pinned despite overflow");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("opening and closing a dialog and a menu", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await start(t, repo);
    await app.press("Control+p");
    await app.waitFor('[data-screen="command-palette"]', 10_000, { message: "command palette" });
    await assertPinned(app, "palette open");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="command-palette"]')), 10_000, { message: "palette closed" });
    await frames(app);
    await assertPinned(app, "palette closed");

    await app.click('[data-left-scroll] [data-row-id^="refs/heads/"]');
    await app.press("Shift+F10");
    await app.waitFor('[role="menu"]', 10_000, { message: "context menu" });
    await assertPinned(app, "menu open");
    await app.press("End", "Home");
    await assertPinned(app, "menu End/Home");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[role="menu"]')), 10_000, { message: "menu closed" });
    await frames(app);
    await assertPinned(app, "menu closed");
    t.step("palette and context menu");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("window resized to a small height and back", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await start(t, repo);
    // 600 is the window's minimum height (tauri.conf.json); the screen is barely larger than the window.
    for (const height of [600, 620, LAUNCH.height]) {
      await app.webdriver("POST", "/window/rect", { width: LAUNCH.width, height });
      // No decorations on Xvfb: outer and inner height are the same.
      await app.waitFor(() => app.exec((wanted) => window.innerHeight === wanted, height), 10_000, { message: `window height ${height}` });
      await app.settle();
      await frames(app);
      await assertPinned(app, `resized to ${height}`);
      // Keyboard focus to the bottom of the left panel in the small window.
      await app.click('[data-left-scroll] [data-row-id^="refs/heads/"]');
      await app.press("End", "PageDown", "ArrowDown", "Tab", "Tab");
      await frames(app);
      await assertPinned(app, `keys after resize to ${height}`);
    }
    t.step("resize");
    await t.shot("after-resize");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
