/**
 * Shared helpers for the mustfix-*.mjs scripts (checks of the must-haves in the real app):
 * check harness with sections, toasts, dialogs, toolbar, cache reload, git without locks.
 *
 *   const t = createRun("mustfix-https");
 *   t.attach(app);                        // after launchApp
 *   await t.section("…", async () => { … t.check(…); await t.eventually(…); });
 *   t.finish();
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gitIsolationEnv } from "../fixtures.mjs";

// Read-only git calls of the checks must not take index.lock (otherwise "locked" in the app).
process.env.GIT_OPTIONAL_LOCKS = "0";

const execFileAsync = promisify(execFile);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const SHOTS = "target/e2e/shots";

/** git in `cwd` with an isolated configuration (`config` = path of a gitconfig). */
export function gitIn(cwd, config, ...args) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...gitIsolationEnv(config) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString("utf8").trim();
}
/** Like gitIn, but asynchronous – required for calls against a server in this process. */
export async function gitInAsync(cwd, config, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...process.env, ...gitIsolationEnv(config) }, windowsHide: true });
  return stdout.toString().trim();
}

export function createRun(name, { argv = process.argv.slice(2) } = {}) {
  const failures = [];
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const shots = !argv.includes("--no-shots");
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

  const eventually = async (read, expected, message, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    const matches = (value) => (typeof expected === "function" ? expected(value) : JSON.stringify(value) === JSON.stringify(expected));
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
    if (matches(actual)) return true;
    const shown = page ? await toasts().catch(() => []) : [];
    return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${JSON.stringify(expected)}`}, got ${JSON.stringify(actual)}${shown.length ? ` – toasts: ${JSON.stringify(shown)}` : ""}`);
  };

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
        check(false, `Toast ${pattern}${tone ? ` (${tone})` : ""} missing; present: ${JSON.stringify(await toasts())}`);
        return null;
      }
      await sleep(80);
    }
  };
  const noErrorToast = async (message) => equal((await toasts()).filter((toast) => toast.tone === "danger"), [], message);

  const dialog = () => page.getByRole("dialog");
  /** Heading of the topmost dialog. */
  const dialogTitle = () => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"]')).at(-1)?.querySelector("h2")?.textContent?.trim() ?? null);
  const waitDialog = async (pattern, timeoutMs = 20_000) => {
    await eventually(dialogTitle, (title) => title !== null && pattern.test(title), `Dialog ${pattern}`, timeoutMs);
    return dialog().last();
  };
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return { text: (el?.textContent ?? "").trim(), label: el?.getAttribute("aria-label") ?? el?.labels?.[0]?.textContent ?? null, tag: el?.tagName ?? null, role: el?.getAttribute("role") ?? null };
    });
  const overflow = () =>
    page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));

  const toolbar = () => page.getByRole("toolbar", { name: "Repository actions" });
  const toolButton = (label) => toolbar().getByRole("button", { name: new RegExp(`^${label}`) }).first();
  const toolState = (label) => toolButton(label).evaluate((button) => ({ disabled: button.getAttribute("aria-disabled") === "true", busy: button.getAttribute("aria-busy") === "true", label: button.getAttribute("aria-label") }));

  /** Reloads status, refs, remotes, graph and undo of a repository (as after an event). */
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
      // In-flight queries do not count: fetchQuery attaches to a running query, which may have read
      // the state before the test's last step. Cancel first, then load.
      await Promise.all(["status", "refs", "remotes", "undo", "graph"].map((part) => client.cancelQueries({ queryKey: key(part), exact: true })));
      await Promise.all([
        settle(() => client.fetchQuery({ queryKey: key("status"), queryFn: () => core.statusGet({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchQuery({ queryKey: key("refs"), queryFn: () => core.refsList({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchQuery({ queryKey: key("remotes"), queryFn: () => core.remoteList({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchQuery({ queryKey: key("undo"), queryFn: () => core.undoPeek({ repoId: id }), staleTime: 0 })),
        settle(() => client.fetchInfiniteQuery({ queryKey: key("graph"), queryFn: ({ pageParam }) => core.graphPage({ repoId: id, cursor: pageParam, limit: 2000 }), initialPageParam: null, staleTime: 0 })),
      ]);
    }, repoId);
    await app.settle();
  };

  const shot = async (file) => {
    if (!shots) return;
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/${file}.png`);
  };

  /** `keep: true` leaves open dialogs and toasts in place (the next section continues in them). */
  const section = async (title, run, { keep = false } = {}) => {
    if (only && !title.toLowerCase().includes(only.toLowerCase())) return;
    current = title;
    const before = failures.length;
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
      if (app) await app.screenshot(`target/e2e/${name}-error-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)}.png`).catch(() => undefined);
    }
    if (app && page) {
      if (app.consoleErrors.length) {
        check(false, `Console errors:\n${app.consoleErrors.join("\n")}`);
        app.consoleErrors.length = 0;
      }
      try {
        if (!keep || failures.length !== before) {
          for (let round = 0; round < 4 && (await dialog().count()) > 0; round++) await page.keyboard.press("Escape");
          await closeToasts();
        }
      } catch {
        // the app is already closed
      }
    }
    console.log(`${failures.length === before ? "✓" : "✗"} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  };

  const finish = () => {
    console.log(failures.length ? `\n${name}: ${failures.length} failures.\n${failures.map((line) => `- ${line}`).join("\n")}` : `\n${name}: green.`);
    process.exit(failures.length ? 1 : 0);
  };

  return {
    failures,
    shots,
    attach(next) {
      app = next;
      page = next?.page ?? null;
    },
    get app() {
      return app;
    },
    get page() {
      return page;
    },
    check,
    equal,
    eventually,
    toasts,
    closeToasts,
    waitToast,
    noErrorToast,
    dialog,
    dialogTitle,
    waitDialog,
    focused,
    overflow,
    toolbar,
    toolButton,
    toolState,
    refresh,
    shot,
    section,
    finish,
  };
}

/** Appends lines to the app's global gitconfig (the app rereads it on every git call). */
export function appendAppGitConfig(app, text) {
  fs.appendFileSync(app.gitConfigPath, text.endsWith("\n") ? text : `${text}\n`);
}

/** Path with forward slashes (for gitconfig on Windows). */
export const slash = (file) => path.resolve(file).replaceAll("\\", "/");
