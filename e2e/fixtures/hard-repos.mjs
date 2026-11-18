/**
 * Shared helpers of the features hard-repos-*.mjs (tester L2, angle "difficult repositories").
 *
 * - `workspace(prefix)`   own temp folder with an isolated gitconfig, `git()` with fixed identity and clock
 * - `createRun(name)`     soft checks inside scenarios: `section(title, run, { bug })` declares one
 *                         scenario with its own app; every failed check is listed. A section with
 *                         `{ bug: "L2-07" }` is the test that bug was fixed against.
 * - `coreLoop(...)`       the core loop against a repository: open, graph, view commit, diff, stage,
 *                         commit, create and switch branch – every step compared against real git
 *
 * Always tests Forkyard itself, locally; no network.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, scenario } from "../lib.mjs";
import { TEST_IDENTITY, gitIsolationEnv, globalGitConfig, sweepStaleTemp } from "./fixtures.mjs";

// Reading git calls of the checks must not take index.lock (otherwise "locked" in the app).
process.env.GIT_OPTIONAL_LOCKS = "0";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 2026-03-02 08:00:00 +01:00 – like the fixtures. */
export const EPOCH = 1772434800;

const live = new Set();
function removeDir(dir) {
  try {
    // Make read-only folders ("read-only" section) writable first, otherwise the folder stays behind.
    spawnSync("chmod", ["-R", "u+w", dir], { stdio: "ignore" });
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
        const detail = [error.stdout, error.stderr]
          .map((part) => (part ? part.toString("utf8") : ""))
          .join("\n")
          .trim();
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
export const zlist = (text) =>
  String(text)
    .split("\0")
    .filter((entry) => entry.length > 0);
export const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** `git status --porcelain=v1 -z -uall` as { staged, unstaged, conflicted } (paths, sorted). */
export function gitStatus(ws, repo) {
  const out = ws
    .git(repo, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall", "--no-renames"], { raw: true })
    .toString("utf8");
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
  const flat = (list) =>
    sorted(list.flatMap((change) => (change.status === "renamed" && change.oldPath ? [change.oldPath, change.path] : [change.path])));
  return { staged: flat(status.staged), unstaged: flat(status.unstaged), conflicted: flat(status.conflicted) };
}

// ---------------------------------------------------------------------------
// Check harness
// ---------------------------------------------------------------------------

/** State of the running section – for the bug screenshot (see `bugShot` and `closeRepo`). */
const runState = { bug: null, failed: false, shot: false, scenario: null };

/**
 * Screenshot of the app for the running section's bug (shots/<feature>/<ID><suffix>.png) – at the
 * moment the bug is visible. `closeRepo` calls this on its own before closing the tab.
 */
export async function bugShot(app, suffix = "") {
  if (!runState.bug || !app || !runState.scenario) return;
  await Promise.race([runState.scenario.shot(`${runState.bug}${suffix}`, app).catch(() => undefined), sleep(20_000)]);
  runState.shot = true;
}

/** JSON with sorted object keys: WebDriver hands objects back with its own key order. */
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

export function createRun() {
  let failures = [];
  let current = "";

  const check = (condition, message) => {
    if (!condition) {
      runState.failed = true;
      failures.push(message);
      console.log(`  ✗ ${String(message).slice(0, 1500)}`);
    }
    return Boolean(condition);
  };
  const equal = (actual, expected, message) =>
    check(canonical(actual) === canonical(expected), `${message}: expected ${short(expected)}, got ${short(actual)}`);
  const note = (text) => runState.scenario?.step(`${current}: ${text}`);
  const eventually = async (read, expected, message, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    const matches = (value) => (typeof expected === "function" ? expected(value) : canonical(value) === canonical(expected));
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
    return check(
      false,
      `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${short(expected)}`}, got ${short(actual)}`,
    );
  };

  /**
   * One scenario: launches an app (English UI), runs `run(app)`, then checks for console errors.
   * `bug`: ID of a reported bug – when red, a screenshot goes to shots/<feature>/<bug>.png.
   * `ignoreErrors`: RegExps of page errors the section expects.
   */
  const section = (title, run, { bug = null, ignoreErrors = [] } = {}) =>
    scenario(bug ? `${title}  [BUG ${bug}]` : title, "edge", async (t) => {
      current = title;
      failures = [];
      Object.assign(runState, { bug, failed: false, shot: false, scenario: t });
      try {
        const app = await t.launch({ lang: "en", ignoreErrors });
        try {
          await run(app);
        } catch (error) {
          check(false, `aborted: ${error?.stack ?? error}`);
        }
        const errors = await app.errors().catch(() => []);
        if (errors.length) check(false, `Console errors:\n${errors.join("\n").slice(0, 2000)}`);
        if (failures.length && bug && !runState.shot) await bugShot(app);
      } finally {
        Object.assign(runState, { bug: null, failed: false, shot: false, scenario: null });
      }
      assert(failures.length === 0, failures.join("\n"));
    });

  return {
    check,
    equal,
    note,
    eventually,
    section,
    /** Another app inside the running section (closed with the scenario). */
    launch: (options) => runState.scenario.launch({ lang: "en", ...options }),
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
  const state = await Promise.race([
    app.exec(() => document.querySelector("[data-shell]")?.getAttribute("data-shell") ?? null).catch(() => null),
    sleep(8000).then(() => null),
  ]);
  return state === "app";
}

export const toasts = (app) =>
  app.exec(() =>
    [...document.querySelectorAll("[data-toast]")].map((item) => ({
      tone: item.getAttribute("data-toast"),
      text: item.innerText.replace(/\s+/g, " ").trim(),
    })),
  );

/** Number of elements matching `css`. */
export const count = (app, css) => app.exec((sel) => document.querySelectorAll(sel).length, css);
/** innerText of the first element matching `css`, "" if there is none. */
export const textOf = (app, css) => app.exec((sel) => document.querySelector(sel)?.innerText ?? "", css);
/** `data-row-key` of every element matching `css`. */
export const rowKeys = (app, css) => app.exec((sel) => [...document.querySelectorAll(sel)].map((item) => item.dataset.rowKey), css);
/** The row with this `data-row-key` inside `scope` (no CSS escaping: names may hold quotes or newlines), scrolled into view. */
export async function row(app, scope, key) {
  const element = await app.waitFor(
    () =>
      app.exec(
        (sel, wanted) => [...document.querySelectorAll(`${sel} [data-row-key]`)].find((item) => item.dataset.rowKey === wanted) ?? null,
        scope,
        key,
      ),
    15_000,
    {
      message: `row ${JSON.stringify(key)} in ${scope}`,
    },
  );
  await app.exec((item) => item.scrollIntoView({ block: "center" }), element);
  return element;
}
/**
 * Records core events (`window.__gc.core.on`): `take()` returns the ones received since as
 * [{ name, payload }] and empties the list; `waitFor(name)`; `stop()`.
 */
export async function recordEvents(app, names) {
  const key = `__gcEvents${Math.random().toString(36).slice(2)}`;
  await app.exec(
    async (slot, list) => {
      const store = { events: [], stops: [] };
      for (const name of list) store.stops.push(window.__gc.core.on(name, (payload) => store.events.push({ name, payload })));
      window[slot] = store;
      await Promise.all(store.stops.map((stop) => stop.ready));
    },
    key,
    names,
  );
  return {
    take: () => app.exec((slot) => window[slot].events.splice(0), key),
    waitFor: (name, timeout = 5000) =>
      app.waitFor(() => app.exec((slot, wanted) => window[slot].events.some((event) => event.name === wanted), key, name), timeout, {
        message: `event ${name}`,
      }),
    stop: () =>
      app.exec((slot) => {
        for (const stop of window[slot].stops) stop();
      }, key),
  };
}

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
  app.exec(
    (root) =>
      Array.from(document.querySelectorAll(`${root} [data-row-id]`)).map((row) => ({
        id: row.getAttribute("data-row-id"),
        kind: row.getAttribute("data-row-kind"),
        text: (row.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
    commitGraphScreen,
  );

/** Selects a commit through the store and waits for the details. */
export async function selectCommit(app, tabId, sha) {
  await app.exec((tab, id) => window.__gc.store.getState().selectCommits(tab, [id]), tabId, sha);
  await app.settle(30_000);
}
export async function selectWip(app, tabId) {
  await app.exec((tab) => window.__gc.store.getState().selectWip(tab), tabId);
  await app.settle(30_000);
}

/** Rows of a file section in the WIP panel (data-row-key). */
export const wipRows = (app, area) =>
  app.exec((sel) => [...document.querySelectorAll(sel)].map((item) => item.dataset.rowKey), `[data-section="${area}"] [data-row-key]`);

/**
 * The core loop against an opened repository. Every step is compared against git.
 * Returns what it saw. Options:
 *   commits      expected SHAs in the graph (default: `git rev-list --all` plus HEAD, at most `limit`)
 *   headFiles    check the files of the HEAD commit (default true)
 *   mutate       stage, commit, create and switch branch (default true)
 *   diffLimit    diff at most this many files per list (default 40)
 *   allowDiffKinds  allowed diff kinds per path, function (path) => string[] | null
 */
export async function coreLoop(
  t,
  app,
  ws,
  repo,
  {
    mutate = true,
    headFiles = true,
    diffLimit = 40,
    limit = 2000,
    summary = "L2: core loop",
    branch = "l2/prüf-zweig",
    expectUnborn = false,
  } = {},
) {
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
  const expectedHead = !headSha.ok
    ? { kind: "unborn", branch: headBranch.out }
    : headBranch.ok
      ? { kind: "branch", branch: headBranch.out, sha: headSha.out }
      : { kind: "detached", sha: headSha.out };
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
  const all =
    headSha.ok || localNames.length || tagNames.length ? lines(ws.git(repo, ["rev-list", "--all", ...(headSha.ok ? ["HEAD"] : [])])) : [];
  const stashShas = new Set(lines(ws.tryGit(repo, ["rev-list", "-g", "refs/stash"]).out ?? ""));
  const expected = new Set(all);
  if (expected.size <= limit) {
    const missing = [...expected].filter((sha) => !rowShas.includes(sha) && !stashShas.has(sha));
    const extra = rowShas.filter((sha) => !expected.has(sha));
    // The graph shows stash commits and their helper commits as their own row kind.
    check(
      missing.length === 0 || missing.every((sha) => isStashHelper(ws, repo, sha)),
      `Graph: ${missing.length} commits missing (e.g. ${missing.slice(0, 3).join(", ")})`,
    );
    equal(extra, [], "graph: no foreign rows");
  }
  if (expectUnborn) equal(rowShas.length, 0, "graph of a repository without commits is empty");

  // --- UI: graph is up, no error toast ---------------------------------------------------------
  await app.settle(30_000);
  if (rowShas.length) {
    await t.eventually(
      async () => (await graphDom(app)).filter((row) => row.kind === "commit" || row.kind === "merge").length > 0,
      true,
      "UI: the graph shows commit rows",
      30_000,
    );
  }
  const danger = (await toasts(app)).filter((toast) => toast.tone === "danger");
  equal(danger, [], "UI: no error toast after opening");

  // --- View commit ---------------------------------------------------------------------------
  if (headSha.ok && headFiles) {
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: headSha.out } });
    if (check(details.ok, `commit_details(HEAD) fails: ${details.code} ${details.message}`)) {
      seen.details = details.value;
      const parents = lines(ws.git(repo, ["rev-list", "--parents", "-n", "1", headSha.out]))[0]
        .split(" ")
        .slice(1);
      equal(details.value.commit?.parents ?? null, parents, "parents of the HEAD commit");
      const subject = ws.git(repo, ["log", "-1", "--format=%s", headSha.out]);
      equal(details.value.commit?.summary ?? null, subject, "summary of the HEAD commit");
      // Files against the first parent, without rename detection, compared as the set of all touched paths.
      const touched = zlist(
        ws
          .git(
            repo,
            [
              "-c",
              "core.quotepath=false",
              "diff-tree",
              "--no-commit-id",
              "-r",
              "--root",
              "--name-only",
              "-z",
              "--no-renames",
              ...(parents.length ? [parents[0], headSha.out] : [headSha.out]),
            ],
            { raw: true },
          )
          .toString("utf8"),
      );
      const shown = sorted(
        details.value.files.flatMap((file) => (file.status === "renamed" && file.oldPath ? [file.oldPath, file.path] : [file.path])),
      );
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
      equal(after.unstaged, [], 'after "stage all" git reports nothing unstaged');
      equal(coreStatusPaths(stagedAll.value).staged, after.staged, "staged files as in git");
    }
    // --- Commit ---------------------------------------------------------------------------
    const before = headSha.ok ? headSha.out : null;
    const committed = await call(app, "commit_create", {
      repoId,
      opId: `l2-${Date.now()}`,
      summary,
      description: "",
      amend: false,
      skipHooks: false,
      pushAfter: false,
      stageAll: false,
    });
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
  equal(
    (await toasts(app)).filter((toast) => toast.tone === "danger"),
    [],
    "UI: no error toast after the core loop",
  );
  return seen;
}

function isStashHelper(ws, repo, sha) {
  const subject = ws.tryGit(repo, ["log", "-1", "--format=%s", sha]);
  return subject.ok && /^(index on|untracked files on|WIP on|On) /.test(subject.out);
}
