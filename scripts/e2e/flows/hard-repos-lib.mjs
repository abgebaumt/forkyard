/**
 * Shared helpers of the hard-repos-*.mjs scripts (tester L2, angle "difficult repositories").
 *
 * - `workspace(prefix)`   own temp folder with an isolated gitconfig, `git()` with fixed identity and clock
 * - `createRun(name)`     check harness: sections, a "green" and "red" list at the end; a red section
 *                         with `{ bug: "L2-07" }` is the test that the bug is fixed against afterwards
 * - `coreLoop(...)`       the core loop against a repository: open, graph, view commit, diff, stage,
 *                         commit, create and switch branch – every step compared against real git
 *
 * Always tests Forkyard itself, locally; no network.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEST_IDENTITY, gitIsolationEnv, globalGitConfig, sweepStaleTemp } from "../fixtures.mjs";

// Reading git calls of the checks must not take index.lock (otherwise "locked" in the app).
process.env.GIT_OPTIONAL_LOCKS = "0";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../..");
export const BUG_SHOTS = "target/e2e/bugs";
/** 2026-03-02 08:00:00 +01:00 – like the fixtures. */
export const EPOCH = 1772434800;

const live = new Set();
function removeDir(dir) {
  try {
    // Clear the read-only flag ("read-only" section) first, otherwise the folder stays behind.
    if (process.platform === "win32") spawnSync("attrib", ["-R", path.join(dir, "*"), "/S", "/D"], { stdio: "ignore", windowsHide: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch {
    // On Windows a just-ended process still holds the folder briefly; then it stays in temp.
  }
}
process.on("exit", () => {
  for (const dir of live) removeDir(dir);
});

let swept = false;

/** Workspace: own temp folder, own gitconfig, running clock. */
export function workspace(prefix, { parentName = null } = {}) {
  if (!swept) {
    swept = true;
    sweepStaleTemp("gc-fix-");
  }
  let root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `gc-fix-hard-${prefix}-`)));
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  live.add(root);
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(config, globalGitConfig());
  const cleanupRoot = root;
  // Optionally an intermediate folder with a difficult name (spaces, umlauts, emoji).
  if (parentName) {
    root = path.join(root, parentName);
    fs.mkdirSync(root, { recursive: true });
  }
  const baseEnv = { ...process.env, ...gitIsolationEnv(config) };
  let clock = EPOCH;

  const ws = {
    root,
    config,
    tick(minutes = 37) {
      clock += minutes * 60;
      return clock;
    },
    /** git in `cwd`; returns stdout without trailing newline (`raw: true`: Buffer). Errors throw with Git's output. */
    git(cwd, args, { input, person = TEST_IDENTITY, time, env = {}, raw = false, date = null, noIdentity = false } = {}) {
      const when = date ?? `${time ?? clock} +0100`;
      const identity = noIdentity
        ? {}
        : {
            GIT_AUTHOR_NAME: person.name,
            GIT_AUTHOR_EMAIL: person.email,
            GIT_AUTHOR_DATE: when,
            GIT_COMMITTER_NAME: person.name,
            GIT_COMMITTER_EMAIL: person.email,
            GIT_COMMITTER_DATE: when,
          };
      try {
        const out = execFileSync("git", args, {
          cwd,
          input,
          env: { ...baseEnv, ...identity, ...env },
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024 * 1024,
          windowsHide: true,
        });
        return raw ? out : out.toString("utf8").replace(/\r?\n$/, "");
      } catch (error) {
        const detail = [error.stdout, error.stderr].map((part) => (part ? part.toString("utf8") : "")).join("\n").trim();
        throw new Error(`git ${args.join(" ").slice(0, 300)} failed (in ${cwd}):\n${detail || error.message}`);
      }
    },
    /** Like `git`, but does not throw: returns { ok, out }. */
    tryGit(cwd, args, options) {
      try {
        return { ok: true, out: ws.git(cwd, args, options) };
      } catch (error) {
        return { ok: false, out: String(error.message) };
      }
    },
    /** New repository `name` with branch main and a local identity. `config`: more local entries. */
    init(name, { bare = false, config: entries = {} } = {}) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      ws.git(dir, bare ? ["init", "-q", "--bare", "-b", "main"] : ["init", "-q", "-b", "main"]);
      if (!bare) {
        ws.git(dir, ["config", "user.name", TEST_IDENTITY.name]);
        ws.git(dir, ["config", "user.email", TEST_IDENTITY.email]);
      }
      for (const [key, value] of Object.entries(entries)) ws.git(dir, ["config", key, String(value)]);
      return dir;
    },
    /** `add -A` and commit; returns the SHA. */
    commit(repo, message, options = {}) {
      const time = ws.tick();
      ws.git(repo, ["add", "-A"], { time });
      ws.git(repo, ["commit", "-q", "--allow-empty", "-m", message], { time, ...options });
      return ws.git(repo, ["rev-parse", "HEAD"]);
    },
    cleanup() {
      removeDir(cleanupRoot);
      live.delete(cleanupRoot);
    },
  };
  return ws;
}

export function write(repo, rel, content) {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Lines of Git output without empty ones. */
export const lines = (text) => String(text).split(/\r?\n/).filter(Boolean);
/** Entries of a `-z` output. */
export const zlist = (text) => String(text).split("\0").filter((entry) => entry.length > 0);
export const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** `git status --porcelain=v1 -z -uall` as { staged, unstaged, conflicted } (paths, sorted). */
export function gitStatus(ws, repo) {
  const out = ws.git(repo, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall", "--no-renames"], { raw: true }).toString("utf8");
  const staged = [];
  const unstaged = [];
  const conflicted = [];
  for (const entry of zlist(out)) {
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicted.push(file);
      continue;
    }
    if (x === "?" && y === "?") {
      unstaged.push(file);
      continue;
    }
    if (x !== " ") staged.push(file);
    if (y !== " ") unstaged.push(file);
  }
  return { staged: sorted(staged), unstaged: sorted(unstaged), conflicted: sorted(conflicted) };
}

/** Paths of a status from the core, like `gitStatus` (renames count with old and new path). */
export function coreStatusPaths(status) {
  const flat = (list) => sorted(list.flatMap((change) => (change.status === "renamed" && change.oldPath ? [change.oldPath, change.path] : [change.path])));
  return { staged: flat(status.staged), unstaged: flat(status.unstaged), conflicted: flat(status.conflicted) };
}

// ---------------------------------------------------------------------------
// Check harness
// ---------------------------------------------------------------------------

/** State of the running section – for the bug screenshot (see `bugShot` and `closeRepo`). */
const runState = { bug: null, failed: false, shot: false };

/**
 * Screenshot of the app for the running section's bug to target/e2e/bugs/<ID><suffix>.png – at the moment
 * the bug is visible. `closeRepo` calls this on its own before closing the tab.
 */
export async function bugShot(app, suffix = "") {
  if (!runState.bug || !app) return;
  await Promise.race([app.screenshot(`${BUG_SHOTS}/${runState.bug}${suffix}.png`).catch(() => undefined), sleep(20_000)]);
  runState.shot = true;
}

export function createRun(name, { argv = process.argv.slice(2) } = {}) {
  const failures = [];
  /** `--bugs`: only the sections that reproduce a reported bug. */
  const bugsOnly = argv.includes("--bugs");
  const green = [];
  const red = [];
  const notes = [];
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
  let current = "";
  let app = null;

  const check = (condition, message) => {
    if (!condition) {
      runState.failed = true;
      failures.push(`${current}: ${message}`);
      console.log(`  ✗ ${String(message).slice(0, 1500)}`);
    }
    return Boolean(condition);
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${short(expected)}, got ${short(actual)}`);
  const note = (text) => {
    notes.push(`${current}: ${text}`);
    console.log(`  · ${text}`);
  };
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
    return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${short(expected)}`}, got ${short(actual)}`);
  };

  /**
   * `bug`: ID of a reported bug – the section stays red until the bug is fixed.
   * When red, a screenshot of the app goes to target/e2e/bugs/<bug>.png.
   */
  const section = async (title, run, { bug = null } = {}) => {
    if (only && !only.some((part) => title.toLowerCase().includes(part.toLowerCase()))) return;
    if (bugsOnly && !bug) return;
    current = title;
    Object.assign(runState, { bug, failed: false, shot: false });
    const before = failures.length;
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
    }
    if (app) {
      if (app.consoleErrors.length) {
        check(false, `Console errors:\n${app.consoleErrors.join("\n").slice(0, 2000)}`);
        app.consoleErrors.length = 0;
      }
    }
    const ok = failures.length === before;
    // The bug screenshot is taken in `closeRepo` or `bugShot` while the bug is visible; only the rest here.
    if (!ok && app && !(bug && runState.shot)) {
      const file = bug ? `${BUG_SHOTS}/${bug}.png` : `target/e2e/${name}-failure-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)}.png`;
      await Promise.race([app.screenshot(file).catch(() => undefined), sleep(20_000)]);
    }
    Object.assign(runState, { bug: null, failed: false, shot: false });
    if (app) {
      try {
        for (let round = 0; round < 4 && (await app.page.getByRole("dialog").count()) > 0; round++) await app.page.keyboard.press("Escape");
        for (let round = 0; round < 12 && (await app.page.locator("[data-toast]").count()) > 0; round++) {
          await app.page.getByRole("button", { name: "Close message" }).first().click({ timeout: 2000 }).catch(() => undefined);
          await sleep(80);
        }
      } catch {
        // the app is already closed
      }
    }
    const label = `${title}${bug ? `  [BUG ${bug}]` : ""}`;
    (ok ? green : red).push(label);
    console.log(`${ok ? "✓" : "✗"} ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return ok;
  };

  const finish = () => {
    console.log(`\n===== ${name} =====`);
    console.log(`GREEN (${green.length}):`);
    for (const title of green) console.log(`  ✓ ${title}`);
    console.log(`RED (${red.length}):`);
    for (const title of red) console.log(`  ✗ ${title}`);
    if (notes.length) {
      console.log("Notes:");
      for (const line of notes) console.log(`  · ${line}`);
    }
    if (failures.length) console.log(`\n${failures.length} deviations:\n${failures.map((line) => `- ${line.slice(0, 1200)}`).join("\n")}`);
    else console.log(`\n${name}: green.`);
    return failures.length ? 1 : 0;
  };

  return {
    failures,
    green,
    red,
    attach(next) {
      app = next;
    },
    get app() {
      return app;
    },
    check,
    equal,
    note,
    eventually,
    section,
    finish,
  };
}

function short(value) {
  const text = JSON.stringify(value);
  return text && text.length > 700 ? `${text.slice(0, 700)}… (${text.length} chars)` : text;
}

// ---------------------------------------------------------------------------
// App helpers
// ---------------------------------------------------------------------------

/** Calls the core and returns { ok, value } or { ok: false, code, message } – never throws. */
export async function call(app, command, args) {
  try {
    return { ok: true, value: await app.invoke(command, args) };
  } catch (error) {
    return { ok: false, code: error.code ?? "unknown", message: String(error.message ?? error), gitOutput: error.gitOutput ?? null };
  }
}

/** Is the shell up and does the page respond? (After a UI crash the window is empty.) */
export async function healthy(app) {
  if (!app) return false;
  const state = await Promise.race([app.page.evaluate(() => document.querySelector("[data-shell]")?.getAttribute("data-shell") ?? null).catch(() => null), sleep(8000).then(() => null)]);
  return state === "app";
}

export const toasts = (app) =>
  app.page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));

/** Closes a repository's tab and forgets it (keeps the instance small). */
export async function closeRepo(app, opened) {
  if (!opened) return;
  // Red and a reported bug: screenshot first, then close.
  if (runState.bug && runState.failed && !runState.shot) await bugShot(app);
  await app.invoke("tab_close", { tabId: opened.tabId }).catch(() => undefined);
  await app.invoke("repo_forget", { repoId: opened.repoId }).catch(() => undefined);
  await app.settle().catch(() => undefined);
}

const commitGraphScreen = '[data-screen="commit-graph"]';

/** What the graph currently shows in the DOM. */
export const graphDom = (app) =>
  app.page.evaluate((root) => Array.from(document.querySelectorAll(`${root} [data-row-id]`)).map((row) => ({ id: row.getAttribute("data-row-id"), kind: row.getAttribute("data-row-kind"), text: (row.textContent ?? "").replace(/\s+/g, " ").trim() })), commitGraphScreen);

/** Selects a commit through the store and waits for the details. */
export async function selectCommit(app, tabId, sha) {
  await app.page.evaluate(([tab, id]) => window.__gc.store.getState().selectCommits(tab, [id]), [tabId, sha]);
  await app.settle(30_000);
}
export async function selectWip(app, tabId) {
  await app.page.evaluate((tab) => window.__gc.store.getState().selectWip(tab), tabId);
  await app.settle(30_000);
}

/** Rows of a file section in the WIP panel (data-row-key). */
export const wipRows = (app, area) => app.page.locator(`[data-section="${area}"] [data-row-key]`).evaluateAll((list) => list.map((item) => item.dataset.rowKey));

/**
 * The core loop against an opened repository. Every step is compared against git.
 * Returns what it saw. Options:
 *   commits      expected SHAs in the graph (default: `git rev-list --all` plus HEAD, at most `limit`)
 *   headFiles    check the files of the HEAD commit (default true)
 *   mutate       stage, commit, create and switch branch (default true)
 *   diffLimit    diff at most this many files per list (default 40)
 *   allowDiffKinds  allowed diff kinds per path, function (path) => string[] | null
 */
export async function coreLoop(t, app, ws, repo, { mutate = true, headFiles = true, diffLimit = 40, limit = 2000, summary = "L2: core loop", branch = "l2/prüf-zweig", expectUnborn = false } = {}) {
  const { check, equal } = t;
  const seen = {};
  const opened = await app.openRepo(repo);
  seen.opened = opened;
  const { repoId } = opened;

  // --- Refs and HEAD ----------------------------------------------------------------------
  const refs = await call(app, "refs_list", { repoId });
  if (!check(refs.ok, `refs_list fails: ${refs.code} ${refs.message}`)) return seen;
  seen.refs = refs.value;
  const headSha = ws.tryGit(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
  const headBranch = ws.tryGit(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const expectedHead = !headSha.ok ? { kind: "unborn", branch: headBranch.out } : headBranch.ok ? { kind: "branch", branch: headBranch.out, sha: headSha.out } : { kind: "detached", sha: headSha.out };
  equal(refs.value.head, expectedHead, "HEAD as in git");
  const localNames = lines(ws.git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]));
  equal(sorted(refs.value.locals.map((ref) => ref.name)), sorted(localNames), "local branches as in git for-each-ref");
  const tagNames = lines(ws.git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/tags"]));
  equal(sorted(refs.value.tags.map((ref) => ref.name)).length, tagNames.length, "number of tags as in git");

  // --- Graph ------------------------------------------------------------------------------
  const page = await call(app, "graph_page", { repoId, cursor: null, limit });
  if (!check(page.ok, `graph_page fails: ${page.code} ${page.message}`)) return seen;
  seen.graph = page.value;
  const rowShas = page.value.rows.filter((row) => row.kind === "commit" || row.kind === "merge").map((row) => row.sha);
  const all = headSha.ok || localNames.length || tagNames.length ? lines(ws.git(repo, ["rev-list", "--all", ...(headSha.ok ? ["HEAD"] : [])])) : [];
  const stashShas = new Set(lines(ws.tryGit(repo, ["rev-list", "-g", "refs/stash"]).out ?? ""));
  const expected = new Set(all);
  if (expected.size <= limit) {
    const missing = [...expected].filter((sha) => !rowShas.includes(sha) && !stashShas.has(sha));
    const extra = rowShas.filter((sha) => !expected.has(sha));
    // The graph shows stash commits and their helper commits as their own row kind.
    check(missing.length === 0 || missing.every((sha) => isStashHelper(ws, repo, sha)), `Graph: ${missing.length} commits missing (e.g. ${missing.slice(0, 3).join(", ")})`);
    equal(extra, [], "graph: no foreign rows");
  }
  if (expectUnborn) equal(rowShas.length, 0, "graph of a repository without commits is empty");

  // --- UI: graph is up, no error toast ---------------------------------------------------------
  await app.settle(30_000);
  if (rowShas.length) {
    await t.eventually(async () => (await graphDom(app)).filter((row) => row.kind === "commit" || row.kind === "merge").length > 0, true, "UI: the graph shows commit rows", 30_000);
  }
  const danger = (await toasts(app)).filter((toast) => toast.tone === "danger");
  equal(danger, [], "UI: no error toast after opening");

  // --- View commit ---------------------------------------------------------------------------
  if (headSha.ok && headFiles) {
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: headSha.out } });
    if (check(details.ok, `commit_details(HEAD) fails: ${details.code} ${details.message}`)) {
      seen.details = details.value;
      const parents = lines(ws.git(repo, ["rev-list", "--parents", "-n", "1", headSha.out]))[0].split(" ").slice(1);
      equal(details.value.commit?.parents ?? null, parents, "parents of the HEAD commit");
      const subject = ws.git(repo, ["log", "-1", "--format=%s", headSha.out]);
      equal(details.value.commit?.summary ?? null, subject, "summary of the HEAD commit");
      // Files against the first parent, without rename detection, compared as the set of all touched paths.
      const touched = zlist(ws.git(repo, ["-c", "core.quotepath=false", "diff-tree", "--no-commit-id", "-r", "--root", "--name-only", "-z", "--no-renames", ...(parents.length ? [parents[0], headSha.out] : [headSha.out])], { raw: true }).toString("utf8"));
      const shown = sorted(details.value.files.flatMap((file) => (file.status === "renamed" && file.oldPath ? [file.oldPath, file.path] : [file.path])));
      equal(shown, sorted(touched), "files of the HEAD commit as in git diff-tree");
      for (const file of details.value.files.slice(0, diffLimit)) {
        const diff = await call(app, "diff_file", { repoId, path: file.path, source: { kind: "commit", sha: headSha.out } });
        check(diff.ok, `diff_file(commit, ${JSON.stringify(file.path)}) fails: ${diff.code} ${diff.message}`);
      }
    }
  }

  // --- Status -----------------------------------------------------------------------------
  const status = await call(app, "status_get", { repoId });
  if (!check(status.ok, `status_get fails: ${status.code} ${status.message}`)) return seen;
  seen.status = status.value;
  const want = gitStatus(ws, repo);
  equal(coreStatusPaths(status.value), want, "status as in git status");
  for (const file of status.value.unstaged.slice(0, diffLimit)) {
    const diff = await call(app, "diff_file", { repoId, path: file.path, source: { kind: "unstaged" } });
    check(diff.ok, `diff_file(unstaged, ${JSON.stringify(file.path)}) fails: ${diff.code} ${diff.message}`);
  }
  for (const file of status.value.staged.slice(0, diffLimit)) {
    const diff = await call(app, "diff_file", { repoId, path: file.path, source: { kind: "staged" } });
    check(diff.ok, `diff_file(staged, ${JSON.stringify(file.path)}) fails: ${diff.code} ${diff.message}`);
  }
  if (!mutate) return seen;

  // --- Stage -------------------------------------------------------------------------------
  const hadChanges = want.staged.length + want.unstaged.length > 0;
  if (hadChanges) {
    const stagedAll = await call(app, "stage_paths", { repoId, paths: null });
    if (check(stagedAll.ok, `stage_paths(all) fails: ${stagedAll.code} ${stagedAll.message}`)) {
      const after = gitStatus(ws, repo);
      equal(after.unstaged, [], "after \"stage all\" git reports nothing unstaged");
      equal(coreStatusPaths(stagedAll.value).staged, after.staged, "staged files as in git");
    }
    // --- Commit ---------------------------------------------------------------------------
    const before = headSha.ok ? headSha.out : null;
    const committed = await call(app, "commit_create", { repoId, opId: `l2-${Date.now()}`, summary, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
    if (check(committed.ok, `commit_create fails: ${committed.code} ${committed.message}`)) {
      const now = ws.git(repo, ["rev-parse", "HEAD"]);
      check(now !== before, "git: HEAD moved");
      equal(committed.value.sha, now, "commit_create returns the new SHA");
      equal(ws.git(repo, ["log", "-1", "--format=%s"]), summary, "git: summary of the new commit");
      const rest = gitStatus(ws, repo);
      equal(rest, { staged: [], unstaged: [], conflicted: [] }, "git: working tree clean after the commit");
      seen.committed = now;
    }
  }

  // --- Create branch, switch, back --------------------------------------------------------------
  if (ws.tryGit(repo, ["rev-parse", "--verify", "-q", "HEAD"]).ok) {
    const origin = ws.tryGit(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
    const created = await call(app, "branch_create", { repoId, name: branch, start: null, checkout: true });
    if (check(created.ok, `branch_create(${branch}) fails: ${created.code} ${created.message}`)) {
      equal(ws.git(repo, ["symbolic-ref", "--short", "HEAD"]), branch, "git: new branch is checked out");
      if (origin.ok) {
        const back = await call(app, "branch_checkout", { repoId, target: origin.out });
        check(back.ok, `branch_checkout(${origin.out}) fails: ${back.code} ${back.message}`);
        equal(ws.git(repo, ["symbolic-ref", "--short", "HEAD"]), origin.out, "git: back on the original branch");
      }
    }
  }
  await app.settle(30_000);
  equal((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "UI: no error toast after the core loop");
  return seen;
}

function isStashHelper(ws, repo, sha) {
  const subject = ws.tryGit(repo, ["log", "-1", "--format=%s", sha]);
  return subject.ok && /^(index on|untracked files on|WIP on|On) /.test(subject.out);
}
