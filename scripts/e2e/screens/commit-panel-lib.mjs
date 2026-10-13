/**
 * Shared helpers for commit-details.mjs and commit-search.mjs: check scaffolding, selection through the store, keyboard,
 * Git in test repositories and a repository with very many files.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitIsolationEnv, globalGitConfig, TEST_IDENTITY } from "../fixtures.mjs";

export function createChecks() {
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
  /** Waits up to `timeoutMs` for `read()` to return the expected value. */
  const eventually = async (read, expected, message, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let actual = await read();
    while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      actual = await read();
    }
    return equal(actual, expected, message);
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
  return { failures, check, equal, eventually, section };
}

/** Aborts if the page reported console errors. */
export function assertNoConsoleErrors(app, where) {
  if (app.consoleErrors.length > 0) {
    throw new Error(`Console errors (${where}):\n${app.consoleErrors.join("\n")}`);
  }
}

/** Access to the app's view state (only present in the debug build). */
export function storeApi(app, tabId) {
  const { page } = app;
  return {
    selectCommits: (shas) => page.evaluate(([tab, list]) => window.__gc.store.getState().selectCommits(tab, list), [tabId, shas]),
    selectStash: (index) => page.evaluate(([tab, at]) => window.__gc.store.getState().selectStash(tab, at), [tabId, index]),
    selectWip: () => page.evaluate((tab) => window.__gc.store.getState().selectWip(tab), tabId),
    closeCenter: () => page.evaluate((tab) => window.__gc.store.getState().closeCenter(tab), tabId),
    view: () => page.evaluate((tab) => window.__gc.store.getState().views[tab] ?? null, tabId),
    selection: () => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.selection ?? null, tabId),
    center: () => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.center ?? null, tabId),
    search: () => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.search ?? null, tabId),
    searchOpen: () => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.searchOpen ?? false, tabId),
  };
}

/** Presses Tab (or Shift+Tab) until `matches` (runs in the page, receives the focused element) is true. */
export async function tabUntil(page, matches, { max = 120, back = false, arg = null } = {}) {
  for (let count = 0; count <= max; count++) {
    if (await page.evaluate(([source, value]) => Boolean(new Function("el", "arg", `return (${source})(el, arg)`)(document.activeElement, value)), [matches.toString(), arg])) return count;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  throw new Error(`Not reached within ${max} Tab steps: ${matches.toString()}`);
}

export const toasts = (page) => page.locator("[data-toast]").allInnerTexts();
export async function closeToasts(page) {
  for (let round = 0; round < 10 && (await page.locator("[data-toast]").count()) > 0; round++) {
    await page.getByRole("button", { name: "Close message" }).first().click();
    await page.waitForTimeout(120);
  }
}

/** Horizontal overflow of the page and of the element itself. */
export async function overflowX(page, selector) {
  return page.evaluate((css) => {
    const element = document.querySelector(css);
    const root = document.documentElement;
    return {
      page: root.scrollWidth - root.clientWidth,
      element: element ? element.scrollWidth - element.clientWidth : null,
    };
  }, selector);
}

/**
 * Makes the calls of ONE core command in the UI wait or fail – only to show the "loading" and
 * "error" states, which cannot be forced with a healthy repository. The core itself stays
 * unchanged; all other commands run normally. `method` is the name from src/core/api.ts
 * (e.g. "commitDetails"). `restore()` undoes it.
 *
 * Technique: `core` is a proxy; a property set on it takes precedence over the call through
 * Tauri. (`__TAURI_INTERNALS__.invoke` itself cannot be overridden.)
 */
export async function tamper(page, method, { delayMs = 0, fail = null, hold = false } = {}) {
  await page.evaluate(
    ([name, delay, error, held]) => {
      const core = window.__gc.core;
      delete core[name];
      const original = core[name];
      window.__gcHeld ??= {};
      // `hold`: the calls wait until the test releases them – not a fixed time. With a fixed delay,
      // "loading" was already over when getting there (command via the palette) took longer under
      // load than the delay.
      const gate = held ? new Promise((resolve) => (window.__gcHeld[name] = resolve)) : null;
      core[name] = async (input) => {
        if (gate) await gate;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (error) throw error;
        return original(input);
      };
    },
    [method, delayMs, fail, hold],
  );
  return {
    /** Releases calls held with `hold`. */
    release: () => page.evaluate((name) => void window.__gcHeld?.[name]?.(), method),
    restore: () => page.evaluate((name) => void (window.__gcHeld?.[name]?.(), delete window.__gc.core[name]), method),
    /**
     * Presses the button `label` under `root` – and lifts the tampering exactly with that click.
     * Until then every reload triggered by a core event fails too: the error stays until the button
     * is pressed. (Restoring first and clicking afterwards went wrong: if an event came in between,
     * the query reloaded by itself and the button was gone before the click hit it.)
     */
    restoreAndPress: async (root, label) => {
      await page.evaluate(
        ([name, scope, text]) => {
          const onClick = (event) => {
            const button = event.target instanceof Element ? event.target.closest("button") : null;
            if (!button || !button.closest(scope) || (button.textContent ?? "").replace(/\s+/g, " ").trim() !== text) return;
            document.removeEventListener("click", onClick, true);
            window.__gcHeld?.[name]?.();
            delete window.__gc.core[name];
          };
          document.addEventListener("click", onClick, true);
        },
        [method, root, label],
      );
      await page.locator(root).getByRole("button", { name: label, exact: true }).first().click();
      return true;
    },
  };
}

/**
 * Replaces `navigator.clipboard.writeText` with a recorder: the test sees what the app wanted to
 * copy without reading or overwriting the machine's clipboard.
 */
export async function captureClipboard(page) {
  await page.evaluate(() => {
    window.__gcCopied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__gcCopied.push(text);
        },
      },
    });
  });
  return { copied: () => page.evaluate(() => window.__gcCopied) };
}

// ---------------------------------------------------------------------------
// Git in test repositories
// ---------------------------------------------------------------------------

/** git in a fixture repository, isolated from the machine's configuration. */
export function gitIn(repoPath, args, { input } = {}) {
  const config = path.join(path.dirname(repoPath), "gitconfig");
  if (!fs.existsSync(config)) fs.writeFileSync(config, globalGitConfig());
  return execFileSync("git", args, {
    cwd: repoPath,
    input,
    env: { ...process.env, ...gitIsolationEnv(config) },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  })
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

export const lines = (text) => text.split(/\r?\n/).filter(Boolean);

/**
 * Repository "dateiberg" with very many files, via `git fast-import`:
 *   commit 1 (root)  creates `fileCount` files (default 20,000),
 *   commit 2         changes `changed` of them (default 600).
 */
export function makeManyFilesRepo({ fileCount = 20_000, changed = 600 } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-fix-many-")));
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  fs.writeFileSync(path.join(root, "gitconfig"), globalGitConfig());
  const repo = path.join(root, "dateiberg");
  fs.mkdirSync(repo);
  gitIn(repo, ["init", "-q", "-b", "main"]);
  gitIn(repo, ["config", "user.name", TEST_IDENTITY.name]);
  gitIn(repo, ["config", "user.email", TEST_IDENTITY.email]);

  const who = `${TEST_IDENTITY.name} <${TEST_IDENTITY.email}>`;
  const file = (index) => `archiv/jahr-${2000 + (index % 25)}/station-${String(index % 40).padStart(2, "0")}/messreihe-${String(index).padStart(5, "0")}.csv`;
  const parts = [];
  const commit = (mark, time, message, from, body) => {
    parts.push(`commit refs/heads/main\nmark :${mark}\nauthor ${who} ${time} +0100\ncommitter ${who} ${time} +0100\ndata ${Buffer.byteLength(message)}\n${message}\n${from ? `from :${from}\n` : ""}${body}\n`);
  };
  let first = "";
  for (let index = 0; index < fileCount; index++) {
    const content = `datum;wert\n2026-01-01;${index % 97}\n`;
    first += `M 100644 inline ${file(index)}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  commit(1, 1772434800, `Archiv mit ${fileCount} Messreihen angelegt`, null, first);
  let second = "";
  for (let index = 0; index < changed; index++) {
    const target = Math.floor((index * fileCount) / changed);
    const content = `datum;wert\n2026-01-01;${target % 97}\n2026-01-02;${(target * 7) % 97}\n`;
    second += `M 100644 inline ${file(target)}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  commit(2, 1772438400, `Zweiten Messtag in ${changed} Reihen nachgetragen`, 1, second);
  gitIn(repo, ["fast-import", "--quiet", "--date-format=raw"], { input: Buffer.from(parts.join(""), "utf8") });
  gitIn(repo, ["checkout", "-q", "-f", "main"]);
  const [head, rootSha] = lines(gitIn(repo, ["rev-list", "main"]));
  return {
    path: repo,
    root,
    info: { head, root: rootSha, fileCount, changed, sample: file(12345 % fileCount) },
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } catch {
        // stays in the temp folder; the next fixtures run removes orphaned folders
      }
    },
  };
}
