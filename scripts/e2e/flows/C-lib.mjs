/**
 * Shared helpers of the flow tests C-F05, C-F06, C-F09, C-F10, C-F14, C-F16 (branches, sync, stash,
 * undo, tags, search): check scaffold with one section per test case, toasts, dialogs, toolbar, real
 * context menus (right click or Shift+F10), git in the fixtures – also with custom date and time
 * zone –, app restart with the same data directory, axe check.
 *
 *   const t = createFlow("C-F05");
 *   const app = await t.launch();                       // starts the app and attaches it
 *   await t.section(["F05-H1"], "Title", async () => { … t.check(…); await t.eventually(…); });
 *   await t.section(["F05-E7"], "Title", async () => { … }, { bug: "C-03" });   // red section = bug C-03
 *   await t.end();                                      // list: green / red, exit code
 *
 * A section ends red when a check fails, the section throws or the page reported a console error.
 * Checks look at the repository itself (git), not only at the UI. `--only <text>` runs only sections
 * whose title or case id contains the text.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT, launchApp } from "../driver.mjs";
import { gitIsolationEnv } from "../fixtures.mjs";

// Reading git calls of the checks must not take index.lock (otherwise "locked" in the app).
process.env.GIT_OPTIONAL_LOCKS = "0";

const execFileAsync = promisify(execFile);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const lines = (text) => String(text ?? "").split(/\r?\n/).filter(Boolean);
export const short = (sha) => sha.slice(0, 7);
export const BUG_SHOTS = "target/e2e/bugs";

// ---------------------------------------------------------------------------
// git in the fixtures
// ---------------------------------------------------------------------------

/** Fixture environment: isolated from the machine's configuration. */
export const gitEnv = (repo, extra = {}) => ({ ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")), ...extra });

/** git in the fixture repository with input, custom environment or in another folder. Returns stdout (without trailing newline). */
export function gitRaw(repo, args, { input, env = {}, cwd = repo.path, allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, input, env: gitEnv(repo, env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .replace(/\r?\n$/, "");
  } catch (error) {
    if (allowFail) return null;
    const detail = [error.stdout, error.stderr].map((part) => (part ? part.toString("utf8") : "")).join("\n").trim();
    throw new Error(`git ${args.join(" ")} failed:\n${detail || error.message}`);
  }
}
/** Async – required for calls against a server in this process (git-http-server.mjs). */
export async function gitAsync(repo, args, { env = {}, cwd = repo.path } = {}) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv(repo, env), windowsHide: true });
  return stdout.toString().replace(/\r?\n$/, "");
}
/** git that may fail because of a lock held right now: retry briefly. */
export function gitTry(repo, ...args) {
  for (let round = 0; ; round++) {
    try {
      return repo.git(...args);
    } catch (error) {
      if (round >= 6) throw error;
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 150)"]);
    }
  }
}
/** git in the bare repository behind "origin". */
export const remoteGit = (repo, ...args) => execFileSync("git", ["--git-dir", repo.remotePath, ...args], { windowsHide: true, env: gitEnv(repo) }).toString("utf8").replace(/\r?\n$/, "");
export const head = (repo) => gitTry(repo, "rev-parse", "HEAD");
export const currentBranch = (repo) => gitTry(repo, "rev-parse", "--abbrev-ref", "HEAD");
export const branches = (repo) => lines(gitTry(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads"));
export const tags = (repo) => lines(gitTry(repo, "for-each-ref", "--format=%(refname:short)", "refs/tags"));
export const stashList = (repo) => lines(gitRaw(repo, ["stash", "list", "--format=%gs"], { allowFail: true }) ?? "");
export const porcelain = (repo) => lines(gitTry(repo, "status", "--porcelain", "--untracked-files=all")).sort();
export const readFile = (repo, rel) => fs.readFileSync(path.join(repo.path, rel), "utf8");
export const exists = (repo, rel) => fs.existsSync(path.join(repo.path, rel));
/** Write a file, stage everything, commit. `date` e.g. "2026-03-29T01:30:00+01:00" (author and committer date). */
export function commit(repo, file, content, message, { date = null, name = null, email = null } = {}) {
  repo.write(file, content);
  repo.git("add", "-A");
  if (date || name) {
    const env = {};
    if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    if (name) Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email ?? "test@wetterstation.example", GIT_COMMITTER_EMAIL: email ?? "test@wetterstation.example" });
    gitRaw(repo, ["commit", "-q", "-m", message], { env });
  } else {
    repo.git("commit", "-q", "-m", message);
  }
  return repo.git("rev-parse", "HEAD");
}
/** Write a hook into the repository (sh script; Git for Windows ships the shell). */
export function writeHook(repo, name, body) {
  const file = path.join(repo.path, ".git", "hooks", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
export const removeHook = (repo, name) => fs.rmSync(path.join(repo.path, ".git", "hooks", name), { force: true });

/** Create a fixture, retrying if needed (cleanup of a script running in parallel can disturb a copy from the cache). */
export function make(build) {
  for (let attempt = 1; ; attempt++) {
    try {
      return build();
    } catch (error) {
      if (attempt >= 4) throw error;
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1200)"]);
    }
  }
}

// ---------------------------------------------------------------------------
// Check scaffold
// ---------------------------------------------------------------------------

export function createFlow(name, { argv = process.argv.slice(2) } = {}) {
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
  const show = argv.includes("--show");
  const failures = [];
  /** { ids, title, ok, bug, seconds } per section that ran. */
  const results = [];
  const cleanups = [];
  const apps = new Set();
  let current = "";
  let app = null;
  let page = null;

  const check = (condition, message) => {
    if (!condition) {
      failures.push(`${current}: ${message}`);
      console.log(`  ✗ ${message}`);
    }
    return Boolean(condition);
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

  const toasts = () =>
    page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));

  /** Waits until `read()` returns the expected value (or satisfies the condition). An error while reading counts as "not yet". */
  const until = async (read, expected, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    const matches = (value) => (typeof expected === "function" ? Boolean(expected(value)) : JSON.stringify(value) === JSON.stringify(expected));
    const attempt = async () => {
      try {
        return await read();
      } catch (error) {
        return `Error: ${String(error?.message ?? error).split("\n")[0]}`;
      }
    };
    let actual = await attempt();
    while (!matches(actual) && Date.now() < deadline) {
      await sleep(80);
      actual = await attempt();
    }
    return { ok: matches(actual), actual };
  };
  const eventually = async (read, expected, message, timeoutMs = 15_000) => {
    const { ok, actual } = await until(read, expected, timeoutMs);
    if (ok) return true;
    const shown = page ? await toasts().catch(() => []) : [];
    return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${JSON.stringify(expected)}`}, got ${JSON.stringify(actual)}${shown.length ? ` – toasts: ${JSON.stringify(shown)}` : ""}`);
  };

  const closeToasts = async () => {
    for (let round = 0; round < 14 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click({ timeout: 2000 }).catch(() => undefined);
      await sleep(80);
    }
  };
  /** Waits for a toast whose text matches; returns it (or null, then the section is red). */
  const waitToast = async (pattern, tone = null, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await toasts()).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone));
      if (hit) return hit;
      if (Date.now() > deadline) {
        check(false, `toast ${pattern}${tone ? ` (${tone})` : ""} missing; present: ${JSON.stringify(await toasts())}`);
        return null;
      }
      await sleep(80);
    }
  };
  /** Like waitToast, but no failure if nothing shows up. */
  const maybeToast = async (pattern, tone = null, timeoutMs = 4000) => {
    const { actual } = await until(async () => (await toasts()).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone)) ?? null, (value) => value !== null, timeoutMs);
    return actual && typeof actual === "object" ? actual : null;
  };
  const dangerToasts = async () => (await toasts()).filter((toast) => toast.tone === "danger");
  const noErrorToast = async (message) => equal(await dangerToasts(), [], message);

  const dialog = () => page.getByRole("dialog");
  /** Heading of the topmost dialog. */
  const dialogTitle = () => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).at(-1)?.querySelector("h2")?.textContent?.trim() ?? null);
  const waitDialog = async (pattern, timeoutMs = 20_000) => {
    await eventually(dialogTitle, (title) => typeof title === "string" && pattern.test(title), `Dialog ${pattern}`, timeoutMs);
    return page.locator('[role="dialog"], [role="alertdialog"]').last();
  };
  const noDialog = (message = "no dialog open any more") => eventually(dialogTitle, null, message);
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      const style = el ? getComputedStyle(el) : null;
      const ring = (target) => {
        const computed = getComputedStyle(target);
        return (computed.outlineStyle !== "none" && parseFloat(computed.outlineWidth) > 0) || (computed.boxShadow !== "none" && computed.boxShadow !== "");
      };
      const framed = el?.closest("label, [data-field]");
      return {
        text: (el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        label: el?.getAttribute("aria-label") ?? el?.labels?.[0]?.textContent?.trim() ?? null,
        tag: el?.tagName ?? null,
        role: el?.getAttribute("role") ?? null,
        rowId: el?.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null,
        inDialog: Boolean(el?.closest('[role="dialog"], [role="alertdialog"]')),
        inMenu: Boolean(el?.closest('[role="menu"]')),
        visible: Boolean(el && el !== document.body && el.matches(":focus-visible") && (ring(el) || (framed ? ring(framed) : false) || style.caretColor !== "transparent")),
      };
    });
  const overflow = () =>
    page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));
  /** Is the element fully inside the window? */
  const inViewport = async (locator) => {
    const box = await locator.boundingBox();
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    return Boolean(box) && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 0.5 && box.y + box.height <= size.height + 0.5;
  };

  const toolbar = () => page.getByRole("toolbar", { name: "Repository actions" });
  const toolButton = (label) => toolbar().getByRole("button", { name: new RegExp(`^${label}`) }).first();
  const toolState = (label) =>
    toolButton(label).evaluate((button) => ({ disabled: button.getAttribute("aria-disabled") === "true", busy: button.getAttribute("aria-busy") === "true", label: button.getAttribute("aria-label") }));
  /** The reason or description is in the tooltip and – for screen readers – in aria-describedby. */
  const toolHint = async (label) => {
    // An open tooltip attaches itself to aria-describedby: move the pointer away first and wait until it is closed.
    await page.mouse.move(700, 520);
    const read = () => toolButton(label).evaluate((button) => (document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? "").trim());
    let text = await read();
    for (let round = 0; round < 40 && !text; round++) {
      // The tooltip only closes on a pointer move: move the pointer a bit further.
      await page.mouse.move(700 + (round % 5) * 3, 520 + (round % 3) * 3, { steps: 2 });
      await sleep(120);
      text = await read();
    }
    return text;
  };
  const footer = () => page.locator("footer").innerText().then((text) => text.replace(/\s+/g, " ").trim());
  const blur = () => page.evaluate(() => document.activeElement?.blur?.());

  /** Reloads status, refs, remotes, stashes, graph and undo – only where the test itself (not the app) changed the repository and does NOT check that the app catches up. */
  const refresh = async (repoId) => {
    await page.evaluate(async (id) => {
      const { core, queryClient: client } = window.__gc;
      const key = (part) => ["repo", id, part];
      const settle = async (load) => {
        for (let round = 0; ; round++) {
          try {
            return await load();
          } catch (error) {
            if (round > 4 || !String(error).includes("CancelledError")) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      };
      await Promise.all(["status", "refs", "remotes", "stashes", "undo", "graph"].map((part) => client.cancelQueries({ queryKey: key(part), exact: true })));
      await Promise.all([
        settle(() => client.fetchQuery({ queryKey: key("status"), queryFn: () => core.statusGet({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchQuery({ queryKey: key("refs"), queryFn: () => core.refsList({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchQuery({ queryKey: key("remotes"), queryFn: () => core.remoteList({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchQuery({ queryKey: key("stashes"), queryFn: () => core.stashList({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchQuery({ queryKey: key("undo"), queryFn: () => core.undoPeek({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchInfiniteQuery({ queryKey: key("graph"), queryFn: ({ pageParam }) => core.graphPage({ repoId: id, cursor: pageParam, limit: 2000 }), initialPageParam: null, staleTime: 0 })),
      ]);
    }, repoId);
    await app.settle();
  };
  /** State in the UI cache (what the app knows right now – without reloading). */
  const cached = (repoId, part) => page.evaluate(([id, key]) => window.__gc.queryClient.getQueryData(["repo", id, key]) ?? null, [repoId, part]);
  /** Window focus: triggers the refresh, as when the user switches from the terminal back to the app. */
  const windowFocus = () => page.evaluate(() => void window.dispatchEvent(new Event("focus")));

  // Graph, left panel, menus --------------------------------------------------------------------
  const graph = () => page.locator("[data-graph-scroller]");
  const graphRow = (sha) => graph().locator(`[role="row"][data-row-id="${sha}"]`);
  const graphRowText = (sha) => graphRow(sha).innerText().then((text) => text.replace(/\s+/g, " ").trim());
  const leftPanel = () => page.locator('[data-screen="sidebar"]');
  const leftRow = (id) => leftPanel().locator(`[data-row-id="${id}"]`);
  const leftRowIds = () => leftPanel().locator("[data-row-id]").evaluateAll((list) => list.map((item) => item.getAttribute("data-row-id")));
  const menu = () => page.getByRole("menu").last();
  const menuEntries = () =>
    menu()
      .locator('[role="menuitem"]')
      .evaluateAll((list) => list.map((item) => ({ text: (item.innerText ?? "").replace(/\s+/g, " ").trim(), disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true" })));
  const closeMenu = async () => {
    for (let round = 0; round < 3 && (await page.getByRole("menu").count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await sleep(120);
    }
  };
  /** Right click an element, then pick the entry with the mouse. */
  const rightClickPick = async (locator, pattern) => {
    await locator.click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: pattern }).first().click();
    await eventually(() => page.getByRole("menu").count(), 0, "the menu closes after the choice", 5000);
  };
  /** In the open menu, go to the entry with the arrow keys and choose it with Enter (keyboard only). */
  const menuChooseByKeyboard = async (pattern, max = 40) => {
    await menu().waitFor();
    const highlighted = () => page.evaluate(() => (Array.from(document.querySelectorAll('[role="menuitem"][data-highlighted]')).at(-1)?.textContent ?? "").replace(/\s+/g, " ").trim());
    for (let step = 0; step < max; step++) {
      const now = await highlighted();
      if (pattern.test(now)) {
        await page.keyboard.press("Enter");
        return true;
      }
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction((old) => (Array.from(document.querySelectorAll('[role="menuitem"][data-highlighted]')).at(-1)?.textContent ?? "").replace(/\s+/g, " ").trim() !== old, now, { timeout: 500 }).catch(() => undefined);
    }
    check(false, `menu entry ${pattern} not reached with the arrow keys (last: "${await highlighted()}")`);
    await closeMenu();
    return false;
  };
  /** Keyboard focus on a row in the left panel: Alt+1, then arrow keys. */
  const focusLeftRowByKeyboard = async (rowId) => {
    await blur();
    await page.keyboard.press("Alt+1");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-screen="sidebar"]'))), true, "Alt+1 puts the focus into the left panel");
    const now = () => page.evaluate(() => document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null);
    for (let step = 0; step < 80 && (await now()) !== rowId; step++) {
      await page.keyboard.press(step === 0 ? "Home" : "ArrowDown");
      await sleep(30);
    }
    return equal(await now(), rowId, `the arrow keys reach the row ${rowId}`);
  };
  /** Keyboard focus on a row in the graph: Alt+2, Home, then arrow down to the commit. */
  const focusGraphRowByKeyboard = async (sha, max = 60) => {
    await blur();
    await page.keyboard.press("Alt+2");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest("[data-graph-scroller]"))), true, "Alt+2 puts the focus into the graph");
    const now = () => page.evaluate(() => document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null);
    await page.keyboard.press("Home");
    for (let step = 0; step < max && (await now()) !== sha; step++) {
      await page.keyboard.press("ArrowDown");
      await sleep(40);
    }
    return equal(await now(), sha, `the arrow keys reach commit ${sha.slice(0, 7)} in the graph`);
  };
  const selection = (tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.selection ?? null, tabId);
  const runCommand = (id) =>
    page.evaluate((commandId) => {
      void window.__gcUi.runCommand(commandId, "palette");
    }, id);

  /** Image for a bug report (target/e2e/bugs/<ID>.png) or for viewing (target/e2e/…). */
  const shot = async (file) => {
    await page.waitForTimeout(200);
    return app.screenshot(file.includes("/") ? file : `target/e2e/${name}-${file}.png`);
  };

  /**
   * Run axe-core over a region (colour contrast is left out – the design system checks it).
   * Returns the violations as short texts.
   */
  const axe = async (selector, { disable = ["color-contrast"] } = {}) => {
    if (!(await page.evaluate(() => Boolean(window.axe)))) await page.evaluate(fs.readFileSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8"));
    return page.evaluate(
      async ([css, off]) => {
        const rules = Object.fromEntries(off.map((id) => [id, { enabled: false }]));
        const outcome = await window.axe.run(document.querySelector(css) ?? document, { rules, resultTypes: ["violations"] });
        return outcome.violations.map((violation) => `${violation.id} (${violation.impact}): ${violation.help} – ${violation.nodes.slice(0, 3).map((node) => node.html.slice(0, 120)).join(" | ")}`);
      },
      [selector, disable],
    );
  };

  // App ------------------------------------------------------------------------------------------
  const attach = (next) => {
    app = next;
    page = next?.page ?? null;
    if (next) apps.add(next);
  };
  /** Starts the app (a start that hits the time limit is retried – the machine is under load) and attaches it. */
  const launch = async (options = {}) => {
    let started = null;
    for (let attempt = 1; ; attempt++) {
      try {
        started = await launchApp({ show, width: 1440, height: 900, theme: "dark", timeoutMs: 90_000, ...options });
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        console.log(`  Starting again (${String(error?.message ?? error).split("\n")[0]})`);
        await sleep(3000);
      }
    }
    apps.add(started);
    // Auto-fetch must not interfere with any flow.
    await started.invoke("settings_set", { patch: { autoFetchMinutes: 0 } }).catch(() => undefined);
    if (options.attach !== false) attach(started);
    return started;
  };
  /** Opens the repository in the attached window; only its tab stays open. Writes repoId and tabId onto the fixture. */
  const open = async (fixture, { keepTabs = false } = {}) => {
    const ids = await app.openRepo(fixture.path);
    Object.assign(fixture, ids);
    if (!keepTabs) {
      for (const tab of await app.invoke("tabs_list")) if (tab.id !== ids.tabId) await app.invoke("tab_close", { tabId: tab.id });
      await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    }
    await refresh(ids.repoId);
    return fixture;
  };
  /** Own data directory for "restart the app" cases; removed at the end. */
  const tempDataDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-e2e-cdata-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return dir;
  };
  const made = (repo) => {
    cleanups.push(() => repo.cleanup());
    return repo;
  };

  /**
   * One section = one or more test cases. `bug`: the section shows this bug and stays red until it
   * is fixed.
   */
  const section = async (ids, title, run, { bug = null, keep = false } = {}) => {
    const label = `[${ids.join(", ")}] ${title}`;
    if (only && !only.some((part) => label.toLowerCase().includes(part.toLowerCase()))) return;
    current = label;
    const before = failures.length;
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
    }
    for (const instance of apps) {
      if (instance.consoleErrors.length) {
        check(false, `console errors:\n${instance.consoleErrors.join("\n")}`);
        instance.consoleErrors.length = 0;
      }
    }
    const ok = failures.length === before;
    if (!ok && app && page) await app.screenshot(`target/e2e/${name}-red-${ids[0]}.png`).catch(() => undefined);
    if (app && page) {
      try {
        if (!keep || !ok) {
          await closeMenu();
          for (let round = 0; round < 4 && (await dialogTitle()) !== null; round++) {
            await page.keyboard.press("Escape");
            await sleep(150);
          }
          await closeToasts();
          await page.evaluate(() => window.__gc?.store.getState().closeOverlay());
        }
      } catch {
        // the app is already closed
      }
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ ids, title, ok, bug, seconds });
    console.log(`${ok ? "✓" : "✗"} ${label}${!ok && bug ? `  → BUG ${bug}` : ""} (${seconds} s)`);
  };

  /** Closes everything, cleans up, prints the list of green and red sections and ends the process. */
  const end = async () => {
    for (const instance of apps) await instance.close().catch(() => undefined);
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Cleanup is not important enough to fail over.
      }
    }
    const green = results.filter((result) => result.ok);
    const red = results.filter((result) => !result.ok);
    console.log(`\n${name} – green sections (${green.length}):`);
    for (const result of green) console.log(`  ✓ [${result.ids.join(", ")}] ${result.title}${result.bug ? `  (was BUG ${result.bug} – now green)` : ""}`);
    console.log(`\n${name} – red sections (${red.length}):`);
    for (const result of red) console.log(`  ✗ [${result.ids.join(", ")}] ${result.title}${result.bug ? `  → BUG ${result.bug}` : "  → no bug number (check)"}`);
    if (failures.length) console.log(`\n${name}: ${failures.length} deviations.\n${failures.map((line) => `- ${line}`).join("\n")}`);
    else console.log(`\n${name}: green.`);
    process.exit(red.length ? 1 : 0);
  };

  return {
    name,
    show,
    failures,
    results,
    cleanups,
    get app() {
      return app;
    },
    get page() {
      return page;
    },
    attach,
    launch,
    open,
    made,
    tempDataDir,
    check,
    equal,
    until,
    eventually,
    toasts,
    closeToasts,
    waitToast,
    maybeToast,
    dangerToasts,
    noErrorToast,
    dialog,
    dialogTitle,
    waitDialog,
    noDialog,
    focused,
    overflow,
    inViewport,
    toolbar,
    toolButton,
    toolState,
    toolHint,
    footer,
    blur,
    refresh,
    cached,
    windowFocus,
    graph,
    graphRow,
    graphRowText,
    leftPanel,
    leftRow,
    leftRowIds,
    menu,
    menuEntries,
    closeMenu,
    rightClickPick,
    menuChooseByKeyboard,
    focusLeftRowByKeyboard,
    focusGraphRowByKeyboard,
    selection,
    runCommand,
    shot,
    axe,
    section,
    end,
  };
}

/**
 * Makes the UI's calls of ONE core command wait (`hold`) or delays them – to keep the UI on a stale
 * state (the repository changes outside, the list does not know yet). The core itself stays
 * unchanged. Same technique as screens/commit-panel-lib.mjs.
 */
export async function holdCore(page, method, { delayMs = 0 } = {}) {
  await page.evaluate(
    ([name, delay]) => {
      const core = window.__gc.core;
      delete core[name];
      const original = core[name];
      window.__gcHeldC ??= {};
      const gate = delay ? null : new Promise((resolve) => (window.__gcHeldC[name] = resolve));
      core[name] = async (input) => {
        if (gate) await gate;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return original(input);
      };
    },
    [method, delayMs],
  );
  return { release: () => page.evaluate((name) => void (window.__gcHeldC?.[name]?.(), delete window.__gc.core[name]), method) };
}
