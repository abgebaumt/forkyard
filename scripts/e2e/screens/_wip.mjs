/**
 * Shared helpers for the checks of commit-panel (local changes) and stash-form (stash form).
 */
import fs from "node:fs";
import path from "node:path";

export function createChecks(name) {
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
  /** Waits up to `timeoutMs` for `read()` to return the expected value – the UI answers asynchronously. */
  const eventually = async (read, expected, message, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let actual = await read();
    while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      actual = await read();
    }
    return equal(actual, expected, message);
  };
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
  const section = async (title, run, onError) => {
    if (only && !only.some((part) => title.toLowerCase().includes(part.toLowerCase()))) return;
    current = title;
    const before = failures.length;
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
      await onError?.(title);
    }
    console.log(`${failures.length === before ? "✓" : "✗"} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  };
  const finish = () => {
    console.log(failures.length ? `\n${name}: ${failures.length} failures\n${failures.map((line) => `- ${line}`).join("\n")}` : `\n${name}: green.`);
    return failures.length ? 1 : 0;
  };
  return { check, equal, eventually, section, finish, failures };
}

/** Helpers around a running app instance. */
export function wipDriver(app, { check, eventually }) {
  const { page } = app;
  const panel = page.locator('[data-screen="commit-panel"], [data-screen="stash-form"]');
  const section = (name) => page.locator(`[data-section="${name}"]`);
  const row = (area, file) => section(area).locator(`[data-row-key=${JSON.stringify(file)}]`);
  const rows = (area) => section(area).locator("[data-row-key]").evaluateAll((list) => list.map((item) => item.dataset.rowKey));
  const summary = page.getByRole("textbox", { name: "Summary" });
  const description = page.getByRole("textbox", { name: "Description" });
  const commitButton = page.locator('form[aria-label="Commit"] button[data-action], form[aria-label="Amend last commit"] button[data-action]');
  const toasts = () => page.locator("[data-toast]").allInnerTexts();
  const closeToasts = async () => {
    for (let round = 0; round < 12 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click();
      await page.waitForTimeout(120);
    }
  };
  const waitToast = async (tone, pattern, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const texts = await page.locator(`[data-toast="${tone}"]`).allInnerTexts();
      const hit = texts.find((text) => pattern.test(text));
      if (hit) return hit;
      if (Date.now() > deadline) {
        check(false, `Expected a toast (${tone}) matching ${pattern}; present: ${JSON.stringify(await toasts())}`);
        return null;
      }
      await page.waitForTimeout(80);
    }
  };
  const status = (repoId) => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"]) ?? null, repoId);
  const counts = async (repoId) => {
    const data = await status(repoId);
    return data ? { unstaged: data.unstaged.length, staged: data.staged.length, conflicted: data.conflicted.length } : null;
  };
  /** View state of the tab; until something is set, the store defaults apply. */
  const view = (tabId) => page.evaluate((id) => ({ selection: { kind: "wip" }, center: { kind: "graph" }, rightPanel: "details", ...(window.__gc.store.getState().views[id] ?? {}) }), tabId);
  const focusedKey = () => page.evaluate(() => document.activeElement?.dataset?.rowKey ?? null);
  const focusedLabel = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!element) return null;
      return element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60) ?? element.tagName;
    });
  /** Presses Tab until the focused element matches (the predicate runs in the page). Keyboard only. */
  const tabUntil = async (predicate, arg, { max = 80, back = false } = {}) => {
    for (let step = 0; step < max; step++) {
      if (await page.evaluate(predicate, arg)) return true;
      await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    }
    const found = await page.evaluate(predicate, arg);
    check(found, `Tab does not reach the target (focus is on ${await focusedLabel()})`);
    return found;
  };
  const tabToList = (label) => tabUntil((name) => document.activeElement?.closest(`[aria-label="${name}"]`) !== null && document.activeElement?.hasAttribute("data-row-key"), label);
  const tabToField = (label) =>
    tabUntil((name) => {
      const element = document.activeElement;
      return element?.getAttribute("aria-label") === name || element?.labels?.[0]?.textContent?.trim() === name;
    }, label);
  const tabToText = (text) => tabUntil((wanted) => (document.activeElement?.textContent ?? "").trim() === wanted, text);
  const tabToCheckbox = (label) =>
    tabUntil((wanted) => {
      const element = document.activeElement;
      if (element?.getAttribute("role") !== "checkbox") return false;
      return (document.querySelector(`label[for="${element.id}"]`)?.textContent ?? "").startsWith(wanted);
    }, label);
  /** In the open menu, move to the entry with the arrow keys and trigger it with Enter. */
  const menuChoose = async (text) => {
    for (let step = 0; step < 20; step++) {
      const highlighted = await page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted]')?.textContent?.trim() ?? null);
      if (highlighted === text) {
        await page.keyboard.press("Enter");
        return true;
      }
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(40);
    }
    check(false, `Menu entry “${text}” not reached with the arrow keys`);
    return false;
  };
  const checkbox = (label) => page.getByRole("checkbox", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  const overflow = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const side = document.querySelector('[data-screen="commit-panel"], [data-screen="stash-form"]');
      return { page: root.scrollWidth - root.clientWidth, panel: side ? side.scrollWidth - side.clientWidth : 0 };
    });
  /** Waits until the UI shows the expected state. */
  const waitCounts = (repoId, expected, message, timeoutMs = 20000) => eventually(() => counts(repoId), expected, message ?? "list state", timeoutMs);
  /** External change in the working tree: window focus triggers a refresh in case the watcher has not reported yet. */
  const refresh = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
  };
  return {
    page,
    panel,
    section,
    row,
    rows,
    summary,
    description,
    commitButton,
    toasts,
    closeToasts,
    waitToast,
    status,
    counts,
    view,
    focusedKey,
    focusedLabel,
    tabUntil,
    tabToList,
    tabToField,
    tabToText,
    tabToCheckbox,
    menuChoose,
    checkbox,
    overflow,
    waitCounts,
    refresh,
  };
}

/** Writes a file into a fixture repository (creates folders). */
export function writeFile(repo, rel, content) {
  const file = path.join(repo.path, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export const readFile = (repo, rel) => fs.readFileSync(path.join(repo.path, rel), "utf8");
export const exists = (repo, rel) => fs.existsSync(path.join(repo.path, rel));
/** Lines of Git output without empty ones. */
export const lines = (text) => text.split(/\r?\n/).filter(Boolean);
