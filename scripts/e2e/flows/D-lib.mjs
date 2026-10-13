/**
 * Shared helpers of the D flow scripts (scripts/e2e/flows/D-F07.mjs … D-F20.mjs): check harness with
 * one section per test case, a section fails on console errors, a clear list at the end (green
 * sections, red sections), helpers for menus, toasts, dialogs and for git in the fixture repository.
 *
 *   const t = createFlow("D-F07");
 *   await t.launch();                          // starts the app (t.app, t.page)
 *   await t.section("F07-H1", "Happy path …", async () => { … t.check(…) … });
 *   await t.section("F07-E5", "…", async () => { … }, { bug: "D-01" });   // red section = open bug
 *   await t.finish();
 *
 * Usage:  node scripts/e2e/flows/D-F07.mjs [--only F07-H1,F07-E5] [--show]
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { gitIsolationEnv } from "../fixtures.mjs";

// Reading git calls of the checks must not take index.lock (otherwise "locked" in the app).
process.env.GIT_OPTIONAL_LOCKS = "0";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const lines = (text) => text.split(/\r?\n/).filter(Boolean);
export const BUG_SHOTS = "target/e2e/bugs";

// ---------------------------------------------------------------------------
// git in the fixture repository
// ---------------------------------------------------------------------------

/** git with its own environment (date, author, input) in the fixture's isolated configuration. */
export function gitRaw(repo, args, { input, env = {}, cwd = repo.path } = {}) {
  return execFileSync("git", args, {
    cwd,
    input,
    env: { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")), ...env },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
    .toString("utf8")
    .replace(/\r?\n$/, "");
}
/**
 * Like gitRaw, but asynchronous – required for calls against a test server in this process
 * (a synchronous `git push` there blocks the server that is supposed to answer it).
 */
export function gitAsync(repo, args, { env = {}, cwd = repo.path } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")), ...env }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed:\n${stdout}${stderr}`));
      else resolve(String(stdout).replace(/\r?\n$/, ""));
    });
  });
}
/** Like gitRaw, but returns { ok, out } instead of throwing. */
export function gitTry(repo, args, options) {
  try {
    return { ok: true, out: gitRaw(repo, args, options) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || String(error.message) };
  }
}
export const commit = (repo, file, content, message) => {
  repo.write(file, content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return repo.git("rev-parse", "HEAD");
};
/** Commit with a fixed date including time zone, e.g. "2026-03-29T01:59:00+01:00". */
export const commitAt = (repo, file, content, message, date, person = null) => {
  repo.write(file, content);
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...(person ? { GIT_AUTHOR_NAME: person.name, GIT_AUTHOR_EMAIL: person.email, GIT_COMMITTER_NAME: person.name, GIT_COMMITTER_EMAIL: person.email } : {}) };
  gitRaw(repo, ["add", "-A"], { env });
  gitRaw(repo, ["commit", "-q", "-m", message], { env });
  return gitRaw(repo, ["rev-parse", "HEAD"]);
};
export const head = (repo, ref = "HEAD") => repo.git("rev-parse", ref);
export const branchOf = (repo) => repo.git("rev-parse", "--abbrev-ref", "HEAD");
export const parentsOf = (repo, ref = "HEAD") => repo.git("rev-list", "--parents", "-n", "1", ref).split(" ").slice(1);
export const subjects = (repo, range) => lines(repo.git("log", "--reverse", "--format=%s", range));
export const porcelain = (repo) => repo.git("status", "--porcelain", "--untracked-files=all");
export const readFile = (repo, file) => fs.readFileSync(path.join(repo.path, file), "utf8");
export const exists = (repo, file) => fs.existsSync(path.join(repo.path, file));
export const gitDirHas = (repo, name) => fs.existsSync(path.join(repo.path, ".git", name));

/** Create a hook in the repository (sh script; Git for Windows runs it through its sh). */
export function writeHook(repo, name, script) {
  const file = path.join(repo.path, ".git", "hooks", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return () => fs.rmSync(file, { force: true });
}

/**
 * Keeps a file open exclusively (Windows: FileShare.None) – like an editor or virus scanner that is
 * locking it. Returns `release()`. Windows only; null elsewhere.
 */
export async function lockFileExclusive(file, seconds = 40) {
  if (process.platform !== "win32") return null;
  const script = `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None'); [Console]::Out.WriteLine('locked'); Start-Sleep -Seconds ${seconds}; $f.Close()`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Could not lock the file (PowerShell does not respond).")), 20_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("locked")) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("Could not lock the file."));
    });
  });
  return async () => {
    child.kill();
    await sleep(300);
  };
}

// ---------------------------------------------------------------------------
// Check harness
// ---------------------------------------------------------------------------

export function createFlow(name, { argv = process.argv.slice(2) } = {}) {
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
  const show = argv.includes("--show");
  /** Result per section: { id, title, ok, bug, failures[] } */
  const results = [];
  const cleanups = [];
  const tempDirs = [];
  let current = null;
  let app = null;
  let page = null;

  const check = (condition, message) => {
    if (!condition) {
      current?.failures.push(message);
      console.log(`  ✗ ${message}`);
    }
    return Boolean(condition);
  };
  const short = (value) => {
    const text = JSON.stringify(value);
    return text && text.length > 700 ? `${text.slice(0, 700)}… (${text.length} chars)` : text;
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${short(expected)}, got ${short(actual)}`);

  const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));

  /** Waits until `read()` returns the expected value (or meets the condition). Read errors count as "not yet". */
  const eventually = async (read, expected, message, timeoutMs = 15_000) => {
    const matches = (value) => (typeof expected === "function" ? Boolean(expected(value)) : JSON.stringify(value) === JSON.stringify(expected));
    const attempt = async () => {
      try {
        return await read();
      } catch (error) {
        return `Error: ${String(error?.message ?? error).split("\n")[0]}`;
      }
    };
    const deadline = Date.now() + timeoutMs;
    let actual = await attempt();
    while (!matches(actual) && Date.now() < deadline) {
      await sleep(80);
      actual = await attempt();
    }
    if (matches(actual)) return true;
    const shown = page ? await toasts().catch(() => []) : [];
    return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${short(expected)}`}, got ${short(actual)}${shown.length ? ` – toasts: ${short(shown)}` : ""}`);
  };
  /** Like eventually, but without a failure entry – only returns true/false. */
  const waitFor = async (read, matches, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value;
      try {
        value = await read();
      } catch {
        value = undefined;
      }
      if (matches(value)) return true;
      if (Date.now() > deadline) return false;
      await sleep(80);
    }
  };

  // --- Toasts, dialogs, menus -----------------------------------------------------------------
  const closeToasts = async () => {
    for (let round = 0; round < 12 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click({ timeout: 2000 }).catch(() => undefined);
      await sleep(80);
    }
  };
  const waitToast = async (pattern, tone = null, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await toasts()).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone));
      if (hit) return hit;
      if (Date.now() > deadline) {
        check(false, `Toast ${pattern}${tone ? ` (${tone})` : ""} missing; present: ${short(await toasts())}`);
        return null;
      }
      await sleep(80);
    }
  };
  /** First toast that appears – no failure entry if none appears. */
  const anyToast = async (timeoutMs = 15_000, tone = null) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await toasts()).find((toast) => !tone || toast.tone === tone);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await sleep(80);
    }
  };
  const dangerToasts = async () => (await toasts()).filter((toast) => toast.tone === "danger");

  const dialog = () => page.getByRole("dialog");
  const dialogTitle = () => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).at(-1)?.querySelector("h2")?.textContent?.trim() ?? null);
  const waitDialog = async (pattern, timeoutMs = 20_000) => {
    await eventually(dialogTitle, (title) => title !== null && typeof title === "string" && pattern.test(title), `Dialog ${pattern}`, timeoutMs);
    return dialog().last();
  };
  const noDialog = (message = "no dialog open anymore") => eventually(() => page.locator('[role="dialog"], [role="alertdialog"]').count(), 0, message);
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { text: "", label: null, role: null, tag: el ? el.tagName : null, visible: false };
      const ring = (target) => {
        const style = getComputedStyle(target);
        return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || (style.boxShadow !== "none" && style.boxShadow !== "");
      };
      const framed = el.closest("label, [data-field]");
      return {
        text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120),
        label: el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent?.trim() ?? null,
        role: el.getAttribute("role"),
        tag: el.tagName,
        rowId: el.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null,
        // Focus is visible when a ring is drawn. After a shortcut with Alt or Ctrl, Chromium does not apply
        // :focus-visible; the app then draws the ring itself (html[data-input="keyboard"]) – so an outline on
        // the focused element counts even without :focus-visible.
        visible:
          (el.matches(":focus-visible") && (ring(el) || (framed ? ring(framed) : false) || getComputedStyle(el).caretColor !== "transparent")) ||
          (getComputedStyle(el).outlineStyle !== "none" && parseFloat(getComputedStyle(el).outlineWidth) > 0),
        // For diagnosis when "visible" is wrong:
        focusVisible: el.matches(":focus-visible"),
        outline: `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineWidth}`,
        shadow: getComputedStyle(el).boxShadow.slice(0, 60),
      };
    });
  const focusedText = async () => (await focused()).text || (await focused()).label || (await focused()).tag;

  const menuItems = () =>
    page.locator('[role="menu"]').last().locator('[role="menuitem"]').evaluateAll((list) =>
      list.map((item) => ({ text: item.innerText.replace(/\s+/g, " ").trim(), disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true", title: item.getAttribute("title") ?? "" })),
    );
  const waitMenu = () => page.locator('[role="menu"]').first().waitFor({ timeout: 10_000 });
  const closeMenu = async () => {
    for (let round = 0; round < 3 && (await page.locator('[role="menu"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await sleep(120);
    }
  };
  /** Pick an entry with the mouse; `sub` opens a submenu first. */
  const pick = async (namePattern, sub = null) => {
    if (sub) {
      await page.getByRole("menuitem", { name: sub }).click();
      await page.locator('[role="menu"]').nth(1).waitFor({ timeout: 5000 });
    }
    await page.getByRole("menuitem", { name: namePattern }).click();
    await eventually(() => page.locator('[role="menu"]').count(), 0, "the menu closes after picking");
  };
  /** In the open menu, move with arrow keys only to the entry whose text matches, then press Enter. */
  const pickByKeyboard = async (pattern, { open = "Enter", max = 40 } = {}) => {
    await waitMenu();
    for (let step = 0; step < max; step++) {
      const highlighted = await page.evaluate(() => {
        const items = document.querySelectorAll('[role="menuitem"][data-highlighted]');
        return items.length ? (items[items.length - 1].textContent ?? "").replace(/\s+/g, " ").trim() : null;
      });
      if (highlighted !== null && pattern.test(highlighted)) {
        await page.keyboard.press(open);
        return true;
      }
      await page.keyboard.press("ArrowDown");
      await sleep(40);
    }
    return check(false, `Menu entry ${pattern} not reached with arrow keys (entries: ${short((await menuItems()).map((item) => item.text))})`);
  };

  // --- App state -------------------------------------------------------------------------------
  /** Reloads status, refs, remotes, stashes, undo and graph (as after a core event). */
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
  /**
   * The repository was changed from outside (git in a terminal): as the user experiences it – the
   * window gets focus back, the app syncs. NO forced cache reload.
   */
  const comeBack = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle().catch(() => undefined);
  };
  const cachedStatus = (repoId) => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"]) ?? null, repoId);
  const conflictedCount = async (repoId) => (await cachedStatus(repoId))?.conflicted.length ?? -1;
  const operationKind = async (repoId) => (await cachedStatus(repoId))?.operation?.kind ?? null;
  const view = (tabId) =>
    page.evaluate((id) => {
      const state = window.__gc.store.getState().views[id] ?? {};
      return { selection: state.selection ?? { kind: "wip" }, center: state.center ?? { kind: "graph" } };
    }, tabId);
  const store = (method, ...args) => page.evaluate(([fn, list]) => window.__gc.store.getState()[fn](...list), [method, args]);
  const footer = () => page.locator("footer").last().innerText().then((text) => text.replace(/\s+/g, " ").trim());
  const toolbar = () => page.getByRole("toolbar", { name: "Repository actions" });
  const toolButton = (label) => toolbar().getByRole("button", { name: new RegExp(`^${label}`) }).first();
  const overflow = () => page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));
  /** Is the element fully inside the window? */
  const inViewport = (locator) =>
    locator.first().evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth + 0.5 && box.bottom <= window.innerHeight + 0.5;
    });

  /** Opens the fixture; only its tab stays open. Writes repoId and tabId onto the fixture. */
  const open = async (fixture) => {
    await closeToasts();
    const ids = await app.openRepo(fixture.path);
    Object.assign(fixture, ids);
    for (const tab of await app.invoke("tabs_list")) if (tab.id !== ids.tabId && tab.kind === "repo") await app.invoke("tab_close", { tabId: tab.id });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await refresh(fixture.repoId);
    return fixture;
  };

  // --- Driving the real UI ------------------------------------------------------------------
  const graphRow = (sha) => page.locator(`[data-screen="commit-graph"] [data-row-id="${sha}"]`);
  /** Row of a local branch in the left panel (by role and accessible name). */
  const branchRow = (branch, kind = "Local branch") => page.getByRole("treeitem", { name: new RegExp(`^${escapeRegExp(kind)} ${escapeRegExp(branch)}(,|$)`) }).first();
  /** Right-click a commit in the graph (scrolls it into view first). */
  const commitMenu = async (repo, sha) => {
    await store("revealCommit", repo.tabId, sha);
    await graphRow(sha).waitFor({ timeout: 20_000 });
    await graphRow(sha).click({ button: "right" });
    await waitMenu();
  };
  const branchMenu = async (branch) => {
    const row = branchRow(branch);
    await row.scrollIntoViewIfNeeded();
    await row.click({ button: "right" });
    await waitMenu();
  };
  /** Presses `key` until `matches` (runs in the page, gets the focused element) holds. */
  const pressUntil = async (key, matches, what, max = 60) => {
    for (let count = 0; count <= max; count++) {
      if (await page.evaluate((source) => Boolean(new Function("el", `return (${source})(el)`)(document.activeElement)), matches.toString())) return true;
      await page.keyboard.press(key);
      await sleep(30);
    }
    return check(false, `${what}: not reached with ${max}× ${key} (focus: ${short(await focused())})`);
  };

  /**
   * Controls without an accessible name inside `selector` (for screen readers): buttons, checkboxes,
   * fields, lists, options. Empty list = all have a name. Invisible ones do not count.
   */
  const unnamedControls = (selector) =>
    page.evaluate((scope) => {
      const out = [];
      const text = (ids) =>
        (ids ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
      for (const root of document.querySelectorAll(scope)) {
        for (const el of root.querySelectorAll('button, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="listbox"], [role="tree"], [role="option"], [role="treeitem"], [role="menuitem"], [role="tab"], input:not([type="hidden"]), textarea, select, a[href]')) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0 || el.closest('[aria-hidden="true"]')) continue;
          const name =
            (el.getAttribute("aria-label") ?? "").trim() ||
            text(el.getAttribute("aria-labelledby")) ||
            (el.labels && el.labels[0] ? (el.labels[0].textContent ?? "").trim() : "") ||
            (el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? "").trim() : "") ||
            (el.closest("label")?.textContent ?? "").trim() ||
            (el.textContent ?? "").trim() ||
            (el.getAttribute("title") ?? "").trim() ||
            (el.getAttribute("placeholder") ?? "").trim();
          if (!name) out.push(`${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${el.getAttribute("data-action") ? `[data-action=${el.getAttribute("data-action")}]` : ""}.${String(el.className).split(" ").slice(0, 3).join(".")}`);
        }
      }
      return out;
    }, selector);

  /** Evidence for a bug: screenshot to target/e2e/bugs/<ID>.png (ID as in the report, e.g. D-01). */
  const bugShot = async (id, suffix = "") => {
    if (!app) return null;
    await sleep(150);
    return app.screenshot(`${BUG_SHOTS}/${id}${suffix}.png`).catch(() => null);
  };

  // --- Start, restart -------------------------------------------------------------------------
  const launch = async (options = {}) => {
    app = await launchApp({ show, width: 1440, height: 900, theme: "dark", ...options });
    page = app.page;
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } }).catch(() => undefined);
    return app;
  };
  const close = async () => {
    if (app) await app.close().catch(() => undefined);
    app = null;
    page = null;
  };
  /** Own data directory that survives a restart (deleted at the end). */
  const makeDataDir = () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-e2e-D-data-")));
    tempDirs.push(dir);
    return dir;
  };

  // --- Sections -------------------------------------------------------------------------------
  /**
   * One section per test case. `bug`: ID of a reported bug – the section stays red until the bug is
   * fixed. Console errors make the section fail.
   */
  const section = async (id, title, run, { bug = null, keep = false } = {}) => {
    if (only && !only.some((part) => id.toLowerCase().includes(part.toLowerCase()) || title.toLowerCase().includes(part.toLowerCase()))) return;
    current = { id, title, bug, failures: [], ok: false };
    results.push(current);
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
    }
    if (app && page) {
      if (app.consoleErrors.length) {
        check(false, `Console errors:\n${app.consoleErrors.join("\n")}`);
        app.consoleErrors.length = 0;
      }
      if (current.failures.length) await app.screenshot(`target/e2e/${name}-failure-${id}.png`).catch(() => undefined);
      try {
        if (!keep) {
          await closeMenu();
          for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"]').count()) > 0; round++) {
            await page.keyboard.press("Escape");
            await sleep(150);
          }
          await closeToasts();
        }
      } catch {
        // the app is already closed
      }
    }
    current.ok = current.failures.length === 0;
    console.log(`${current.ok ? "✓" : "✗"} ${id} ${title}${bug ? ` [BUG ${bug}]` : ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    current = null;
  };

  const made = (repo) => {
    cleanups.push(() => repo.cleanup());
    return repo;
  };

  const finish = async () => {
    await close();
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // Cleanup must not hide the report.
      }
    }
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const green = results.filter((result) => result.ok);
    const red = results.filter((result) => !result.ok);
    console.log(`\n${name}: ${results.length} sections, ${green.length} green, ${red.length} red.`);
    console.log(`\nGreen sections (${green.length}):`);
    for (const result of green) console.log(`  ✓ ${result.id} ${result.title}${result.bug ? ` – NOTE: marked as BUG ${result.bug}, but runs green` : ""}`);
    console.log(`\nRed sections (${red.length}):`);
    for (const result of red) {
      console.log(`  ✗ ${result.id} ${result.title}${result.bug ? ` – BUG ${result.bug}` : " – no bug ID"}`);
      for (const failure of result.failures) console.log(`      - ${failure.split("\n").join("\n        ")}`);
    }
    process.exit(red.length ? 1 : 0);
  };

  return {
    name,
    show,
    results,
    get app() {
      return app;
    },
    get page() {
      return page;
    },
    launch,
    close,
    makeDataDir,
    made,
    check,
    equal,
    eventually,
    waitFor,
    toasts,
    closeToasts,
    waitToast,
    anyToast,
    dangerToasts,
    dialog,
    dialogTitle,
    waitDialog,
    noDialog,
    focused,
    focusedText,
    menuItems,
    waitMenu,
    closeMenu,
    pick,
    pickByKeyboard,
    refresh,
    comeBack,
    cachedStatus,
    conflictedCount,
    operationKind,
    view,
    store,
    footer,
    toolbar,
    toolButton,
    overflow,
    inViewport,
    open,
    graphRow,
    branchRow,
    commitMenu,
    branchMenu,
    pressUntil,
    unnamedControls,
    bugShot,
    section,
    finish,
  };
}
