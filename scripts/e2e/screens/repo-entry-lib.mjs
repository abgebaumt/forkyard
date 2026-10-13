/**
 * Shared helpers for repo-management.mjs, clone.mjs and init.mjs: check harness, Git in temp folders,
 * many small repositories, repository list entries, keyboard.
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
      check(false, `aborted: ${error?.stack ?? error}`);
    }
    console.log(`${failures.length === before ? "✓" : "✗"} ${name}`);
  };
  return { failures, check, equal, eventually, section };
}

/** Temp folder with its own gitconfig; `git(cwd, ...args)` runs isolated from the machine. */
export function makeWorkspace(prefix) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `gc-fix-${prefix}-`)));
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(config, globalGitConfig());
  const env = {
    ...process.env,
    ...gitIsolationEnv(config),
    GIT_AUTHOR_NAME: TEST_IDENTITY.name,
    GIT_AUTHOR_EMAIL: TEST_IDENTITY.email,
    GIT_COMMITTER_NAME: TEST_IDENTITY.name,
    GIT_COMMITTER_EMAIL: TEST_IDENTITY.email,
    GIT_AUTHOR_DATE: "1772434800 +0100",
    GIT_COMMITTER_DATE: "1772434800 +0100",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).toString("utf8").replace(/\r?\n$/, "");
  const ws = {
    root,
    git,
    /** Path below the workspace. */
    at: (...parts) => path.join(root, ...parts),
    /** Creates a folder (nested too) and returns its path. */
    dir(...parts) {
      const dir = path.join(root, ...parts);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** New repository with one commit. `files`: { "README.md": "…" }. */
    repo(name, files = { "README.md": `# ${name}\n` }, { bare = false } = {}) {
      const dir = ws.dir(name);
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.name", TEST_IDENTITY.name);
      git(dir, "config", "user.email", TEST_IDENTITY.email);
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "Erster Stand");
      if (!bare) return dir;
      const bareDir = path.join(root, `${name}.git`);
      git(root, "clone", "-q", "--bare", dir, bareDir);
      return bareDir;
    },
    /** Another commit in a repository; `date` e.g. "2026-02-10T12:00:00+01:00". */
    commit(dir, rel, content, message, date = null) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
      git(dir, "add", "-A");
      const dated = date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env;
      execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env: dated, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      return git(dir, "rev-parse", "HEAD");
    },
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } catch {
        // On Windows a process that just exited sometimes still holds the folder briefly.
      }
    },
  };
  return ws;
}

/** Copies of a small repository under `parent`, one per name; returns the paths. */
export function copyRepos(source, parent, names) {
  fs.mkdirSync(parent, { recursive: true });
  return names.map((name) => {
    const target = path.join(parent, name);
    copyDir(source, target);
    return target;
  });
}

/** Own copy instead of fs.cpSync: on Windows that mangles non-ASCII characters in the target name (Node 24). */
function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** file:// URL of a local folder (three slashes for Git on Windows). */
export function fileUrl(dir) {
  const normal = dir.replaceAll("\\", "/");
  return normal.startsWith("/") ? `file://${normal}` : `file:///${normal}`;
}

/** Shows the management tab (activates an existing one or opens one). */
export async function showManagement(app) {
  const tabs = await app.invoke("tabs_list");
  const existing = tabs.find((tab) => tab.kind === "management");
  if (existing) await app.invoke("tab_activate", { tabId: existing.id });
  else await app.invoke("tab_open", { repoId: null });
  await app.page.locator('[data-screen="repo-management"]').waitFor();
  await app.settle();
}

/** Adds a repository to the list without leaving a tab open. `patch` as for repo_update. */
export async function addRepo(app, repoPath, patch = null) {
  // repo_open turns an active management tab into a repo tab; restore the management tab afterwards.
  const before = (await app.invoke("tabs_list")).find((tab) => tab.isActive);
  const opened = await app.invoke("repo_open", { path: repoPath });
  await app.invoke("tab_close", { tabId: opened.tab.id });
  if (before?.kind === "management" && before.id === opened.tab.id) {
    const tabs = await app.invoke("tabs_list");
    const management = tabs.find((tab) => tab.kind === "management");
    if (management) await app.invoke("tab_activate", { tabId: management.id });
    else await app.invoke("tab_open", { repoId: null });
  }
  if (patch) return app.invoke("repo_update", { repoId: opened.repo.id, ...patch });
  return opened.repo;
}

export const repoList = (app) => app.invoke("repo_list");
export const findRepo = async (app, repoPath) => (await repoList(app)).find((repo) => repo.path.toLowerCase() === repoPath.toLowerCase()) ?? null;

/** Reloads the UI's repository list (as after a core event). */
export async function refreshRepos(app) {
  await app.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
  await app.settle();
}

/**
 * Sets "last opened" directly in the app database – only for believable screenshots
 * (otherwise everything would read "just now"). `entries`: [[path, minutesAgo]].
 */
export async function ageRepos(app, entries) {
  const { DatabaseSync } = await import("node:sqlite");
  const file = fs.readdirSync(app.dataDir).find((name) => /\.(db|sqlite3?)$/.test(name));
  if (!file) throw new Error(`No database found in ${app.dataDir}.`);
  const db = new DatabaseSync(path.join(app.dataDir, file));
  try {
    db.exec("pragma busy_timeout = 5000");
    const statement = db.prepare("update repositories set last_opened_at = ? where lower(path) = lower(?)");
    for (const [repoPath, minutes] of entries) statement.run(new Date(Date.now() - minutes * 60_000).toISOString(), repoPath);
  } finally {
    db.close();
  }
  await refreshRepos(app);
}

/** Presses Tab until `predicate(arg)` is true in the page. Returns the number of steps or -1. */
export async function tabUntil(page, predicate, arg, { max = 40, shift = false } = {}) {
  for (let step = 0; step <= max; step++) {
    if (await page.evaluate(predicate, arg)) return step;
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
  }
  return -1;
}

export const overflow = (page) =>
  page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));

export const toasts = (page) => page.locator("[data-toast]").allInnerTexts();

export async function closeToasts(page) {
  for (let round = 0; round < 10 && (await page.locator("[data-toast]").count()) > 0; round++) {
    await page.getByRole("button", { name: "Close message" }).first().click();
    await page.waitForTimeout(120);
  }
}

/** Heading of the topmost open dialog, or null. */
export const dialogTitle = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"]')).at(-1)?.querySelector("h2")?.textContent ?? null);

export function finish(name, failures, picture) {
  console.log(failures.length ? `\n${name}: ${failures.length} failures${picture ? ` (screenshot: ${picture})` : ""}.` : `\n${name}: green.`);
  process.exit(failures.length ? 1 : 0);
}
