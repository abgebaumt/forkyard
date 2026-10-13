/**
 * Shared harness of the B flow tests (F03, F04, F12, F19): sections with a green/red list at the end,
 * app start with retry on start timeout, fixtures, cleanup, accessibility checks.
 *
 *   const flow = createFlow("B-F03");
 *   await flow.section("F03-E7 …", async () => { const { app, ui } = flow; … }, { bug: "B-01" });
 *   process.exit(await flow.finish());
 *
 * Rules (as in scripts/e2e/screens): real app via launchApp, real fixture repositories, checks run
 * against the repository itself via git, selectors by role and name. Every section ends with the
 * check "no console errors". After a red section the app restarts so one failure does not drag
 * down the following sections.
 *
 *   --only <text[,text]>   only sections whose title contains one of the texts
 *   --show                 visible window
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, ROOT } from "../driver.mjs";
import { wipDriver } from "../screens/_wip.mjs";

export { exists, lines, readFile, writeFile } from "../screens/_wip.mjs";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFlow(name) {
  const failures = [];
  const green = [];
  const red = [];
  const skipped = [];
  let current = "";
  const show = process.argv.includes("--show");
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

  const check = (condition, message) => {
    if (!condition) {
      failures.push(`${current}: ${message}`);
      console.log(`  ✗ ${message}`);
    }
    return Boolean(condition);
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  /** Waits up to `timeoutMs` for `read()` to return the expected value. */
  const eventually = async (read, expected, message, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    let actual = await read();
    while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
      await sleep(60);
      actual = await read();
    }
    return equal(actual, expected, message);
  };
  /** Waits until `read()` returns something truthy. */
  const until = async (read, message, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    let actual = await read();
    while (!actual && Date.now() < deadline) {
      await sleep(60);
      actual = await read();
    }
    return check(actual, message);
  };
  const checks = { check, equal, eventually, until };

  const state = { app: null, ui: null };
  const repos = [];
  const tempDirs = [];
  const cleanups = [];

  /** Starts the app; a start that hits the timeout (machine under load) is retried. */
  const start = async (options = {}) => {
    await stop();
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        state.app = await launchApp({ show, timeoutMs: 90_000, ...options });
        state.ui = wipDriver(state.app, checks);
        return state.app;
      } catch (error) {
        lastError = error;
        console.log(`  (app start ${attempt} failed: ${String(error?.message ?? error).split("\n")[0]})`);
        await sleep(3000 * attempt);
      }
    }
    throw lastError;
  };
  const stop = async () => {
    const running = state.app;
    state.app = null;
    state.ui = null;
    if (running) await running.close().catch(() => undefined);
  };
  /** A second instance (second window); the caller closes it. */
  const second = async (options = {}) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const other = await launchApp({ show, timeoutMs: 90_000, ...options });
        return { app: other, ui: wipDriver(other, checks) };
      } catch (error) {
        lastError = error;
        await sleep(3000 * attempt);
      }
    }
    throw lastError;
  };

  /** Fixture from the shared cache; if another script is copying it right now, wait briefly and retry. */
  const fixture = async (make, ...args) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const repo = make(...args);
        repos.push(repo);
        return repo;
      } catch (error) {
        if (attempt >= 4) throw error;
        await sleep(1500 * attempt);
      }
    }
  };
  const tempDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  /** Before every section: close open menus, dialogs and toasts, window back to normal size. */
  const reset = async () => {
    const { app, ui } = state;
    if (!app) return;
    const { page } = app;
    for (let round = 0; round < 4; round++) {
      const open = await page.locator('[role="menu"], [role="dialog"], [role="alertdialog"]').count();
      if (!open) break;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.__gc?.store.getState().closeOverlay());
    await ui.closeToasts();
    const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    if (size[0] !== 1440 || size[1] !== 900) await app.setSize(1440, 900);
    app.consoleErrors.length = 0;
  };

  const slug = (title) => title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 48);

  /**
   * One section. `bug`: id of the bug this section demonstrates – it stays red until the bug is
   * fixed. `launch`: options for launchApp when the section needs its own instance
   * (`launch: false` = the section starts the app itself).
   */
  const section = async (title, body, { bug = null, launch = undefined } = {}) => {
    if (only && !only.some((part) => title.toLowerCase().includes(part.toLowerCase()))) {
      skipped.push(title);
      return;
    }
    current = title;
    const before = failures.length;
    const started = Date.now();
    try {
      if (launch) await start(launch);
      else if (launch !== false && !state.app) await start();
      await reset();
      await body();
      if (state.app) {
        equal(state.app.consoleErrors, [], "console errors");
        state.app.consoleErrors.length = 0;
      }
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
      if (state.app) await state.app.screenshot(`target/e2e/${name}-error-${slug(title)}.png`).catch(() => undefined);
    }
    const ok = failures.length === before;
    (ok ? green : red).push(bug ? `${title}  [BUG ${bug}]` : title);
    console.log(`${ok ? "✓" : "✗"} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    // Own instance or red section: continue with a fresh app.
    if (launch || !ok) await stop();
  };

  /** Evidence for a bug: screenshot at target/e2e/bugs/<ID>.png (only if the check failed). */
  const bugShot = async (id, failed = true, app = state.app) => {
    if (!failed || !app) return;
    await app.screenshot(`target/e2e/bugs/${id}.png`).catch(() => undefined);
  };

  const finish = async () => {
    await stop();
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
    for (const repo of repos) repo.cleanup();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    console.log(`\n${name}: ${green.length} green, ${red.length} red${skipped.length ? `, ${skipped.length} skipped (--only)` : ""}`);
    console.log("Green sections:");
    for (const title of green) console.log(`  ✓ ${title}`);
    console.log("Red sections:");
    if (!red.length) console.log("  (none)");
    for (const title of red) console.log(`  ✗ ${title}`);
    if (failures.length) console.log(`\nDeviations:\n${failures.map((line) => `- ${line}`).join("\n")}`);
    return red.length ? 1 : 0;
  };

  return {
    name,
    ROOT,
    ...checks,
    failures,
    section,
    start,
    stop,
    second,
    fixture,
    tempDir,
    cleanups,
    bugShot,
    finish,
    get app() {
      return state.app;
    },
    get ui() {
      return state.ui;
    },
    get page() {
      return state.app?.page ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** The topmost open dialog (confirmations are alertdialog or dialog). */
export const dialogOf = (page) => page.locator('[role="alertdialog"], [role="dialog"]').last();
export const dialogTitle = (page) => page.locator('[role="alertdialog"] h2, [role="dialog"] h2').last().textContent({ timeout: 8000 }).catch(() => null);
export const noDialog = (page, timeout = 8000) => page.locator('[role="alertdialog"], [role="dialog"]').first().waitFor({ state: "detached", timeout });

/** All toasts of one tone (danger, warning, info, success) as texts. */
export const toastsOf = (page, tone) => page.locator(tone ? `[data-toast="${tone}"]` : "[data-toast]").allInnerTexts();

/** Creates a hook (sh script; Git for Windows runs it through its sh). */
export function writeHook(repo, name, script) {
  const dir = path.join(repo.path, ".git", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

/**
 * Accessible names of all controls under `root`: returns the elements WITHOUT a name
 * (role and a piece of HTML), i.e. [] when everything is named.
 */
export function unnamedControls(page, root) {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return [`${selector} missing`];
    const nameOf = (element) => {
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) {
        const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (text) return text;
      }
      const aria = element.getAttribute("aria-label");
      if (aria?.trim()) return aria.trim();
      if (element.labels?.length) return [...element.labels].map((label) => label.textContent).join(" ").trim();
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label?.textContent?.trim()) return label.textContent.trim();
      }
      const title = element.getAttribute("title");
      if (title?.trim()) return title.trim();
      if (element.matches("input, textarea, select")) return "";
      return (element.textContent ?? "").trim();
    };
    const controls = scope.querySelectorAll('button, input, textarea, select, a[href], [role="button"], [role="checkbox"], [role="option"], [role="treeitem"], [role="radio"], [role="separator"][tabindex], [role="listbox"], [role="tree"], [role="grid"], [role="textbox"]');
    const missing = [];
    for (const element of controls) {
      if (element.closest("[aria-hidden='true']")) continue;
      if (!nameOf(element)) missing.push(`${element.getAttribute("role") ?? element.tagName.toLowerCase()}: ${element.outerHTML.slice(0, 120)}`);
    }
    return missing;
  }, root);
}

/** Does the focused element have a visible focus ring (outline or box-shadow)? */
export function focusVisible(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { ok: false, what: "no focus" };
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    const shadow = style.boxShadow && style.boxShadow !== "none";
    // Some fields draw the ring on the surrounding element (focus-within).
    const parent = element.parentElement ? getComputedStyle(element.parentElement) : null;
    const around = parent ? (parent.outlineStyle !== "none" && Number.parseFloat(parent.outlineWidth) > 0) || (parent.boxShadow && parent.boxShadow !== "none") : false;
    return { ok: Boolean(outline || shadow || around), what: `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30) ?? ""}] outline=${style.outlineStyle} ${style.outlineWidth} shadow=${style.boxShadow.slice(0, 40)}` };
  });
}

/**
 * Runs axe-core over part of the page. Returns the violations as short texts.
 * Colour contrast is left out (npm run check:contrast checks all token pairs).
 */
export async function axeViolations(page, root, { disable = ["color-contrast"] } = {}) {
  const source = fs.readFileSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");
  const loaded = await page.evaluate(() => Boolean(window.axe));
  if (!loaded) await page.evaluate(source);
  const result = await page.evaluate(
    async ([selector, off]) => {
      const rules = Object.fromEntries(off.map((id) => [id, { enabled: false }]));
      const outcome = await window.axe.run(document.querySelector(selector) ?? document, { rules, resultTypes: ["violations"] });
      return outcome.violations.map((violation) => `${violation.id} (${violation.impact}): ${violation.help} – ${violation.nodes.slice(0, 3).map((node) => node.html.slice(0, 100)).join(" | ")}`);
    },
    [root, disable],
  );
  return result;
}

/** Does not close a repository tab – only clears toasts and overlays (as in commit-panel.mjs). */
export async function tidy(flow) {
  const { ui, page } = flow;
  if (!ui) return;
  await ui.closeToasts();
  await page.evaluate(() => window.__gc.store.getState().closeOverlay());
}

/** Waits for the finished diff of `file` in the center. */
export async function diffReady(app, file) {
  await app.page.waitForFunction(
    (label) => {
      const root = document.querySelector('[data-screen="diff"]');
      return root?.getAttribute("aria-label") === label && !root.querySelector("[data-diff-loading]");
    },
    `Diff of ${file}`,
    { timeout: 30_000 },
  );
  await app.settle();
}

/** Access to the diff view (diff) of an instance. */
export function diffDriver(app) {
  const { page } = app;
  const screen = page.locator('[data-screen="diff"]');
  const grid = screen.locator("[data-diff-grid]");
  const token = () => screen.getAttribute("data-diff-token").catch(() => null);
  const rows = () =>
    grid.locator('[data-row][role="row"]').evaluateAll((list) =>
      list.map((row) => ({
        kind: row.dataset.kind ?? (row.dataset.hunk !== undefined ? "hunk" : "other"),
        selected: row.getAttribute("aria-selected") === "true",
        text: row.querySelector(".selectable")?.textContent?.replace(/​/g, "") ?? row.textContent,
      })),
    );
  const changed = async () => (await rows()).filter((row) => row.kind === "add" || row.kind === "remove").map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`);
  const selected = async () => (await rows()).filter((row) => row.selected).map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`);
  const hunkCount = () => grid.locator("[data-hunk]").count();
  const notice = () => screen.locator("[data-notice]").getAttribute("data-notice", { timeout: 3000 }).catch(() => null);
  /** Waits until the diff has reloaded after a write (different fingerprint or different file). */
  const changedSince = async (old, file) => {
    await page.waitForFunction(
      ([before, label]) => {
        const root = document.querySelector('[data-screen="diff"]');
        return !root || root.getAttribute("aria-label") !== label || root.getAttribute("data-diff-token") !== before;
      },
      [old, `Diff of ${file}`],
      { timeout: 20_000 },
    );
    await app.settle();
  };
  const open = async (area, file) => {
    const row = page.locator(`[data-section="${area}"] [data-row-key=${JSON.stringify(file)}]`);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await diffReady(app, file);
  };
  /** Line-number cell of the n-th row of a kind ("add" | "remove"). */
  const gutter = (kind, index = 0) => grid.locator(`[data-kind="${kind}"] [data-gutter]`).nth(index);
  return { screen, grid, token, rows, changed, selected, hunkCount, notice, changedSince, open, gutter, bar: page.locator("[data-selection-bar]") };
}
