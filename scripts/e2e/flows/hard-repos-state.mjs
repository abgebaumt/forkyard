/**
 * Difficult repositories, part 4: LOCATION AND STATE – in the real app, against real git.
 *
 *   node scripts/e2e/flows/hard-repos-state.mjs [--show] [--only <part>[,<part>]]
 *
 *   T1  repository path with spaces, umlauts, emoji, special characters (also remote, worktree, stash, undo)
 *   T2  folder is renamed while the app runs                T3  folder is deleted while the app runs
 *   T4  read-only repository (ACL)                          T5  foreign lock files (index.lock, HEAD.lock, …)
 *   T6  file locked exclusively by another program
 *   T7  operations started outside: merge, rebase (conflict and "edit"), cherry-pick sequence, revert, am, bisect
 *   T8  every conflict kind (both modified, both added, deleted by us/them, renamed/renamed, binary)
 *
 * At the end there is a list of green and red sections. Red sections with "BUG L2-…" are the tests
 * the respective bug is fixed against.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { healthy, call, closeRepo, coreLoop, coreStatusPaths, createRun, gitStatus, graphDom, lines, sorted, toasts, wipRows, workspace, write, zlist, selectWip, selectCommit, sleep } from "./hard-repos-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("hard-repos-state", { argv });
const { check, equal, eventually, note } = t;
/** Before each section: if the UI crashed (empty window), a fresh instance is started. */
async function ensureApp() {
  if (app && (await healthy(app))) return;
  if (app) {
    console.log("  · the UI does not respond anymore – new instance");
    await app.close().catch(() => undefined);
  }
  app = await launchApp({ show });
  t.attach(app);
}
const section = async (title, run, options) => {
  await ensureApp();
  return t.section(title, run, options);
};

let app = null;
const spaces = [];
const ws0 = (prefix, options) => {
  const ws = workspace(prefix, options);
  spaces.push(ws);
  return ws;
};
const cleanups = [];
const commitArgs = (repoId, summary) => ({ repoId, opId: `l2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, summary, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
const slash = (file) => file.replaceAll("\\", "/");
const samePath = (a, b) => path.resolve(a).replaceAll("\\", "/").toLowerCase() === path.resolve(b).replaceAll("\\", "/").toLowerCase();
const job = () => `l2-job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function small(ws, name = "klein") {
  const repo = ws.init(name);
  write(repo, "README.md", "# Klein\n");
  ws.commit(repo, "Erster Commit");
  write(repo, "src/a.txt", "a\n");
  ws.commit(repo, "Zweiter Commit");
  ws.git(repo, ["checkout", "-q", "-b", "seite"]);
  write(repo, "src/b.txt", "b\n");
  ws.commit(repo, "Seitenzweig");
  ws.git(repo, ["checkout", "-q", "main"]);
  write(repo, "src/a.txt", "a\nmehr\n");
  ws.commit(repo, "Dritter Commit");
  return repo;
}

/** main and "thema" change the same line: every merge, rebase, cherry-pick between them conflicts. */
function diverged(ws, name = "auseinander") {
  const repo = ws.init(name);
  write(repo, "text.txt", "eins\nzwei\ndrei\n");
  write(repo, "ruhig.txt", "ruhig\n");
  ws.commit(repo, "Basis");
  ws.git(repo, ["checkout", "-q", "-b", "thema"]);
  write(repo, "text.txt", "eins\nZWEI vom Thema\ndrei\n");
  ws.commit(repo, "Thema ändert Zeile zwei");
  write(repo, "thema.txt", "nur im thema\n");
  ws.commit(repo, "Thema: neue Datei");
  write(repo, "text.txt", "eins\nZWEI vom Thema\ndrei\nvier vom Thema\n");
  ws.commit(repo, "Thema: vierte Zeile");
  ws.git(repo, ["checkout", "-q", "main"]);
  write(repo, "text.txt", "eins\nzwei von main\ndrei\n");
  ws.commit(repo, "main ändert Zeile zwei");
  return repo;
}

/** Keeps `file` open exclusively (no sharing) until `release()` is called. */
async function lockExclusive(file) {
  const script = `$f=[System.IO.File]::Open('${file.replaceAll("'", "''")}','Open','ReadWrite','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 180`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The lock could not be taken.")), 30_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("locked")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => reject(new Error("PowerShell exited before the lock was in place.")));
  });
  const release = async () => {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await sleep(300);
  };
  cleanups.push(release);
  return release;
}

const user = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME}`;
/** Deny writing and deleting under `dir` (ACL); returns the undo. */
function denyWrite(dir) {
  const result = spawnSync("icacls", [dir, "/deny", `${user}:(OI)(CI)(WD,AD,WEA,WA,DE,DC)`, "/T", "/C", "/Q"], { encoding: "utf8", windowsHide: true });
  const undo = () => spawnSync("icacls", [dir, "/remove:d", user, "/T", "/C", "/Q"], { stdio: "ignore", windowsHide: true });
  cleanups.push(async () => undo());
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), undo };
}

try {
  // ---------------------------------------------------------------------------------------------
  const HARD_PARENTS = ["Projekte mit Leerzeichen/Übergrößen & Ärger", "🚀 start/日本語 プロジェクト", "klammern (kopie) [1]/{x}/a'b", "prozent %20 und #raute/!ausruf; semikolon", "punkt.git/ende.git"];
  for (const parent of HARD_PARENTS) {
    await section(`T1 path "${parent}": core loop, remote in the same path, worktree, stash, undo`, async () => {
      const ws = ws0("t1", { parentName: parent });
      const repo = small(ws, "mein repo ü");
      const remote = ws.init("entfernt ö.git", { bare: true });
      ws.git(repo, ["remote", "add", "origin", remote]);
      ws.git(repo, ["push", "-q", "-u", "origin", "main"]);
      write(repo, "src/a.txt", "a\nmehr\nlokal\n");
      write(repo, "neu ü.txt", "neu\n");
      const seen = await coreLoop(t, app, ws, repo, { summary: "Commit in einem schwierigen Pfad" });
      const { repoId, tabId } = seen.opened;
      check(samePath((await call(app, "repo_list", {})).value.find((entry) => entry.id === repoId)?.path ?? "", repo), "repo_list reports the path unchanged");
      // Push, fetch, pull against the remote in the same path
      const push = await call(app, "push", { repoId, jobId: job(), branch: null, remote: null, remoteBranch: null, force: false });
      check(push.ok && push.value.status === "done", `push: ${push.ok ? JSON.stringify(push.value) : `${push.code} – ${push.message}`}`);
      equal(ws.git(remote, ["rev-parse", "refs/heads/main"]), ws.git(repo, ["rev-parse", "main"]), "git: the remote has the commit");
      const fetch = await call(app, "fetch", { repoId, jobId: job(), remote: null, prune: true });
      check(fetch.ok && fetch.value.failed.length === 0, `fetch: ${fetch.ok ? JSON.stringify(fetch.value) : `${fetch.code} – ${fetch.message}`}`);
      // Clone from the difficult path into a difficult path
      const cloned = await call(app, "repo_clone", { jobId: job(), url: remote, parentPath: ws.root, name: "klon mit ü & co", options: { depth: null, shallowSince: null, branch: null, sparsePaths: [], recurseSubmodules: false } });
      check(cloned.ok, `repo_clone fails: ${cloned.code} – ${cloned.message}`);
      if (cloned.ok) {
        equal(ws.git(path.join(ws.root, "klon mit ü & co"), ["rev-parse", "HEAD"]), ws.git(repo, ["rev-parse", "main"]), "git: the clone is on the same commit");
        await closeRepo(app, { repoId: cloned.value.repo.id, tabId: cloned.value.tab.id });
      }
      // Worktree in the difficult path
      const tree = path.join(ws.root, "baum ä (2)");
      const added = await call(app, "worktree_add", { repoId, path: tree, branch: "seite", newBranch: false, start: null });
      check(added.ok && added.value.length === 2, `worktree_add: ${added.ok ? added.value.length : `${added.code} – ${added.message}`}`);
      if (added.ok) {
        equal(ws.git(tree, ["symbolic-ref", "--short", "HEAD"]), "seite", "git: the worktree is on seite");
        const removed = await call(app, "worktree_remove", { repoId, path: tree, force: false });
        check(removed.ok, `worktree_remove fails: ${removed.code} – ${removed.message}`);
      }
      // Stash, discard, undo (backups in the Git directory)
      write(repo, "src/a.txt", "a\nmehr\nlokal\nnoch mehr\n");
      write(repo, "unverfolgt ß.txt", "x\n");
      const stash = await call(app, "stash_create", { repoId, opId: job(), message: "Stash im schwierigen Pfad", paths: null, includeUntracked: true });
      check(stash.ok && stash.value.length === 1, `stash_create: ${stash.ok ? stash.value.length : `${stash.code} – ${stash.message}`}`);
      const pop = await call(app, "stash_pop", { repoId, index: 0 });
      check(pop.ok && pop.value.status === "done", `stash_pop: ${pop.ok ? pop.value.status : `${pop.code} – ${pop.message}`}`);
      const discard = await call(app, "discard_paths", { repoId, paths: null });
      check(discard.ok, `discard_paths(all) fails: ${discard.code} – ${discard.message}`);
      equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after discarding");
      const undo = await call(app, "undo", { repoId });
      check(undo.ok, `undo fails: ${undo.code} – ${undo.message}`);
      equal(gitStatus(ws, repo).unstaged, ["src/a.txt", "unverfolgt ß.txt"], "git: undo brings both changes back");
      // File watching in the difficult path
      const events = await app.recordEvents(["repo:changed"]);
      write(repo, "von außen.txt", "x\n");
      await events.waitFor("repo:changed", 15_000).catch(() => undefined);
      const got = await events.take();
      await events.stop();
      check(got.length > 0, "repo:changed after a change from outside");
      // UI: tab title and window title
      const tab = await app.page.locator(`[data-tab-id="${tabId}"]`).innerText().catch(() => "");
      check(tab.replace(/\s+/g, " ").includes("mein repo ü"), `tab title: ${JSON.stringify(tab)}`);
      const readme = await call(app, "repo_readme", { repoId });
      check(readme.ok && readme.value?.includes("# Klein"), `repo_readme: ${readme.ok ? JSON.stringify(readme.value?.slice(0, 20)) : `${readme.code} – ${readme.message}`}`);
      // Opening in the file manager / terminal would start real programs – not checked.
      await closeRepo(app, seen.opened);
    });
  }

  // ---------------------------------------------------------------------------------------------
  await section("T2 folder is renamed while the app runs: clear message, continue at the new location, renaming back works too", async () => {
    const ws = ws0("t2");
    const repo = small(ws, "wird-umbenannt");
    write(repo, "README.md", "# Klein\ngeändert\n");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    await app.settle();
    const moved = path.join(ws.root, "heißt jetzt anders");
    let renamed = false;
    let reason = "";
    for (let attempt = 0; attempt < 20 && !renamed; attempt++) {
      try {
        fs.renameSync(repo, moved);
        renamed = true;
      } catch (error) {
        reason = `${error.code}: ${error.message}`;
        await sleep(250);
      }
    }
    // If the app holds the folder, the user cannot rename it in Explorer while the tab is open.
    if (!check(renamed, `the folder can be renamed while the repository is open in the app (${reason})`)) {
      await closeRepo(app, opened);
      return;
    }
    await sleep(1500);
    const status = await call(app, "status_get", { repoId });
    check(!status.ok && ["path_not_found", "not_a_repo"].includes(status.code), `status_get after renaming: ${status.ok ? "still returns a status" : `${status.code} – ${status.message}`}`);
    const graph = await call(app, "graph_page", { repoId, cursor: null, limit: 100 });
    check(!graph.ok && graph.code !== "unknown", `graph_page after renaming: ${graph.ok ? "still returns rows" : `${graph.code} – ${graph.message}`}`);
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(2500);
    check(await healthy(app), "the UI is still up");
    const text = (await app.page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    const shown = await toasts(app);
    note(`UI after renaming: toasts ${JSON.stringify(shown).slice(0, 300)}`);
    check(/no longer|anymore|not found|missing|moved|deleted/i.test(text), `UI says that the folder is missing (excerpt: ${JSON.stringify(text.slice(0, 300))})`);
    const repos = await call(app, "repo_list", {});
    check(repos.ok && repos.value.find((entry) => entry.id === repoId)?.missing === true, `repo_list marks the entry as missing: ${repos.ok ? JSON.stringify(repos.value.find((entry) => entry.id === repoId)) : repos.message}`);
    // Open at the new location
    const again = await call(app, "repo_open", { path: moved });
    check(again.ok, `repo_open(new location) fails: ${again.code} – ${again.message}`);
    if (again.ok) {
      const st = await call(app, "status_get", { repoId: again.value.repo.id });
      check(st.ok && st.value.unstaged.length === 1, `status at the new location: ${st.ok ? st.value.unstaged.length : `${st.code} – ${st.message}`}`);
      const commit = await call(app, "commit_create", { ...commitArgs(again.value.repo.id, "Commit am neuen Ort"), stageAll: true });
      check(commit.ok, `commit_create at the new location fails: ${commit.code} – ${commit.message}`);
      await closeRepo(app, { repoId: again.value.repo.id, tabId: again.value.tab.id });
    }
    // Rename back: the old entry works again
    fs.renameSync(moved, repo);
    await eventually(async () => (await call(app, "status_get", { repoId })).ok, true, "after renaming back the old entry answers again", 15_000);
    void tabId;
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("T3 folder is deleted while the app runs: clear message, no crash, tab can be closed", async () => {
    const ws = ws0("t3");
    const repo = small(ws, "wird-geloescht");
    write(repo, "README.md", "# Klein\ngeändert\n");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    await selectWip(app, tabId);
    await app.page.locator('[data-section="unstaged"] [data-row-key="README.md"]').click();
    await app.settle();
    let removed = false;
    let reason = "";
    for (let attempt = 0; attempt < 20 && !removed; attempt++) {
      try {
        fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed = !fs.existsSync(repo);
      } catch (error) {
        reason = `${error.code}: ${error.message}`;
        await sleep(250);
      }
    }
    if (!check(removed, `the folder can be deleted while the repository is open in the app (${reason})`)) {
      await closeRepo(app, opened);
      return;
    }
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(3000);
    check(await healthy(app), "the UI is still up");
    for (const [command, args] of [
      ["status_get", { repoId }],
      ["graph_page", { repoId, cursor: null, limit: 100 }],
      ["refs_list", { repoId }],
      ["stage_paths", { repoId, paths: null }],
      ["commit_create", commitArgs(repoId, "geht nicht")],
      ["diff_file", { repoId, path: "README.md", source: { kind: "unstaged" } }],
      ["fetch", { repoId, jobId: job(), remote: null, prune: false }],
    ]) {
      const result = await call(app, command, args);
      check(!result.ok && ["path_not_found", "not_a_repo"].includes(result.code), `${command} after deleting: ${result.ok ? "reports success" : `${result.code} – ${result.message}`}`);
    }
    const text = (await app.page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    check(/no longer|anymore|not found|missing|moved|deleted/i.test(text), `UI says that the folder is missing (excerpt: ${JSON.stringify(text.slice(0, 300))})`);
    const dangers = (await toasts(app)).filter((toast) => toast.tone === "danger");
    note(`error toasts after deleting: ${dangers.length} – ${JSON.stringify(dangers.map((toast) => toast.text.slice(0, 90)))}`);
    check(dangers.length <= 2, `at most two error toasts, no pile (${dangers.length})`);
    // Closing the tab works; the entry stays in the list as "missing" and can be forgotten
    const closed = await call(app, "tab_close", { tabId });
    check(closed.ok, `tab_close fails: ${closed.code} – ${closed.message}`);
    const forget = await call(app, "repo_forget", { repoId });
    check(forget.ok, `repo_forget fails: ${forget.code} – ${forget.message}`);
    app.consoleErrors.length = 0;
  });

  // ---------------------------------------------------------------------------------------------
  await section("T4 read-only repository (ACL): viewing works, writing reports clearly, nothing hangs", async () => {
    const ws = ws0("t4");
    const repo = small(ws, "nur-lesen");
    write(repo, "README.md", "# Klein\ngeändert vor dem Schreibschutz\n");
    const denied = denyWrite(repo);
    if (!check(denied.ok, `fixture: icacls fails: ${denied.out}`)) return;
    let writable = true;
    try {
      fs.writeFileSync(path.join(repo, ".git", "probe"), "x");
    } catch {
      writable = false;
    }
    if (!check(!writable, "fixture: the repository really is read-only")) {
      denied.undo();
      return;
    }
    if (!check(ws.tryGit(repo, ["log", "--oneline", "-n", "1"]).ok && ws.tryGit(repo, ["status", "--porcelain"]).ok, "fixture: git itself can read the repository")) {
      denied.undo();
      return;
    }
    try {
      const opened = await call(app, "repo_open", { path: repo });
      if (!check(opened.ok, `repo_open(read-only) fails: ${opened.code} – ${opened.message}`)) return;
      const repoId = opened.value.repo.id;
      const timed = async (command, args, limit = 30_000) => {
        const started = Date.now();
        const result = await Promise.race([call(app, command, args), sleep(limit).then(() => ({ ok: false, code: "hung", message: `no answer after ${limit} ms` }))]);
        return { ...result, ms: Date.now() - started };
      };
      const status = await timed("status_get", { repoId });
      check(status.ok && status.value.unstaged.length === 1, `status_get: ${status.ok ? status.value.unstaged.length : `${status.code} – ${status.message}`}`);
      const graph = await timed("graph_page", { repoId, cursor: null, limit: 100 });
      check(graph.ok && graph.value.rows.length >= 4, `graph_page: ${graph.ok ? graph.value.rows.length : `${graph.code} – ${graph.message}`}`);
      const diff = await timed("diff_file", { repoId, path: "README.md", source: { kind: "unstaged" } });
      check(diff.ok && diff.value.kind === "text", `diff_file: ${diff.ok ? diff.value.kind : `${diff.code} – ${diff.message}`}`);
      const head = ws.git(repo, ["rev-parse", "HEAD"]);
      const details = await timed("commit_details", { repoId, source: { kind: "commit", sha: head } });
      check(details.ok, `commit_details: ${details.code} – ${details.message}`);
      for (const [command, args] of [
        ["stage_paths", { repoId, paths: ["README.md"] }],
        ["commit_create", { ...commitArgs(repoId, "geht nicht"), stageAll: true }],
        ["branch_create", { repoId, name: "neu", start: null, checkout: false }],
        ["branch_checkout", { repoId, target: "seite" }],
        ["discard_paths", { repoId, paths: ["README.md"] }],
        ["stash_create", { repoId, opId: job(), message: null, paths: null, includeUntracked: false }],
        ["tag_create", { repoId, name: "v1", sha: null, message: null }],
        ["file_write", { repoId, path: "README.md", content: "x\n", encoding: "utf-8", eol: "lf" }],
      ]) {
        const result = await timed(command, args);
        check(!result.ok, `${command} reports success in the read-only repository`);
        check(result.code !== "hung", `${command} hangs: ${result.message}`);
        check(result.code !== "unknown" && /writ|access|permission|locked|read-only/i.test(result.message), `${command}: clear message instead of ${result.code} – ${result.message}`);
      }
      equal(ws.git(repo, ["rev-parse", "HEAD"]), head, "git: HEAD unchanged");
      equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# Klein\ngeändert vor dem Schreibschutz\n", "the modified file is untouched");
      await app.settle(20_000).catch(() => undefined);
      check(await healthy(app), "the UI is still up");
      await call(app, "tab_close", { tabId: opened.value.tab.id });
      await call(app, "repo_forget", { repoId });
    } finally {
      denied.undo();
    }
  });

  // ---------------------------------------------------------------------------------------------
  const LOCKS = [
    ["index.lock", ["stage_paths", (repoId) => ({ repoId, paths: ["README.md"] })]],
    ["HEAD.lock", ["branch_checkout", (repoId) => ({ repoId, target: "seite" })]],
    ["refs/heads/main.lock", ["commit_create", (repoId) => ({ ...commitArgs(repoId, "geht nicht"), stageAll: true })]],
    ["packed-refs.lock", ["branch_delete", (repoId) => ({ repoId, names: ["gepackt"], force: true })]],
  ];
  const lockSection = (title, list, options) => section(title, async () => {
    for (const [lock, [command, args]] of list) {
      const ws = ws0("t5");
      const repo = small(ws, "gesperrt");
      ws.git(repo, ["branch", "gepackt", "HEAD~1"]);
      ws.git(repo, ["pack-refs", "--all"]);
      write(repo, "README.md", "# Klein\ngeändert\n");
      const opened = await app.openRepo(repo);
      const { repoId } = opened;
      const file = path.join(repo, ".git", lock);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
      const status = await call(app, "status_get", { repoId });
      check(status.ok && status.value.unstaged.length === 1, `${lock}: status_get still reads (${status.ok ? status.value.unstaged.length : `${status.code} – ${status.message}`})`);
      const graph = await call(app, "graph_page", { repoId, cursor: null, limit: 100 });
      check(graph.ok, `${lock}: graph_page still reads (${graph.code} – ${graph.message})`);
      const diff = await call(app, "diff_file", { repoId, path: "README.md", source: { kind: "unstaged" } });
      check(diff.ok, `${lock}: diff_file still reads (${diff.code} – ${diff.message})`);
      const started = Date.now();
      const blocked = await call(app, command, args(repoId));
      const ms = Date.now() - started;
      check(!blocked.ok, `${lock}: ${command} reports success despite the lock`);
      if (!blocked.ok) {
        check(blocked.code === "locked", `${lock}: ${command} answers with code ${blocked.code} instead of locked – ${blocked.message}`);
        check(/lock/i.test(blocked.message), `${lock}: the message names the lock: ${blocked.message}`);
      }
      check(ms < 30_000, `${lock}: ${command} answers after ${ms} ms`);
      note(`${lock}: ${command} → ${blocked.ok ? "ok" : `${blocked.code} – ${blocked.message.slice(0, 160)}`} (${ms} ms)`);
      check(fs.existsSync(file), `${lock}: the foreign lock file was not silently deleted`);
      fs.rmSync(file, { force: true });
      const after = await call(app, command, args(repoId));
      check(after.ok, `${lock}: after removing the lock ${command} works (${after.code} – ${after.message})`);
      await closeRepo(app, opened);
    }
  }, options);
  await lockSection("T5 foreign lock files left behind (index, HEAD, branch, packed-refs): reading continues, writing names the lock, afterwards it works again", LOCKS);
  // BUG L2-14: a leftover .git/config.lock is not recognised as a lock – code `unknown`, message
  // "Git command 'git remote' failed (exit code 128)" (git: "could not lock config file").
  await lockSection("T5 foreign config.lock: writing to the configuration names the lock", [["config.lock", ["remote_add", (repoId) => ({ repoId, name: "neu", fetchUrl: "https://example.invalid/x.git", pushUrl: null })]]], { bug: "L2-14" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-01 (third trigger): if another program holds a modified file open exclusively, git cannot read
  // it – `git diff --numstat` aborts, and status_get fails as a whole.
  await section("T6 modified file locked exclusively by another program: status stays readable, other files can be committed", async () => {
    const ws = ws0("t6");
    const repo = small(ws, "datei-gesperrt");
    write(repo, "src/a.txt", "a\nmehr\nwird gleich gesperrt\n");
    write(repo, "README.md", "# Klein\ngeändert\n");
    const release = await lockExclusive(path.join(repo, "src", "a.txt"));
    try {
      const want = gitStatus(ws, repo);
      equal(want.unstaged, ["README.md", "src/a.txt"], "fixture: git status lists both files despite the lock");
      const opened = await app.openRepo(repo).catch((error) => ({ error }));
      if (!check(!opened.error, `openRepo fails: ${String(opened.error?.message).split("\n")[0]}`)) return;
      const { repoId, tabId } = opened;
      const status = await call(app, "status_get", { repoId });
      check(status.ok, `status_get fails: ${status.code} – ${status.message} – ${String(status.gitOutput ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
      if (status.ok) equal(coreStatusPaths(status.value), want, "status as in git status");
      await selectWip(app, tabId);
      await eventually(async () => (await wipRows(app, "unstaged")).includes("README.md"), true, "UI: README.md is in \"Unstaged\"", 10_000);
      const diff = await call(app, "diff_file", { repoId, path: "src/a.txt", source: { kind: "unstaged" } });
      check(diff.ok || (diff.code !== "unknown" && /locked|access|another program|in use|read/i.test(diff.message)), `diff_file(locked file): ${diff.code} – ${diff.message}`);
      const stage = await call(app, "stage_paths", { repoId, paths: ["README.md"] });
      check(stage.ok, `stage_paths(README.md) fails: ${stage.code} – ${stage.message}`);
      const commit = await call(app, "commit_create", commitArgs(repoId, "README trotz gesperrter Nachbardatei"));
      check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
      equal(ws.git(repo, ["log", "-1", "--format=%s"]), "README trotz gesperrter Nachbardatei", "git: the commit is there");
      await closeRepo(app, opened);
    } finally {
      await release();
    }
  }, { bug: "L2-01" });

  // ---------------------------------------------------------------------------------------------
  await section("T6 locked file: staging, discarding and switching branches report clearly, nothing is left half-done", async () => {
    const ws = ws0("t6b");
    const repo = small(ws, "datei-gesperrt-2");
    // seite and main differ in src/a.txt: a switch has to touch the file.
    const release = await lockExclusive(path.join(repo, "src", "a.txt"));
    try {
      const opened = await app.openRepo(repo).catch((error) => ({ error }));
      if (!check(!opened.error, `openRepo fails: ${String(opened.error?.message).split("\n")[0]}`)) return;
      const { repoId } = opened;
      const before = ws.git(repo, ["rev-parse", "HEAD"]);
      const started = Date.now();
      const co = await Promise.race([call(app, "branch_checkout", { repoId, target: "seite" }), sleep(90_000).then(() => ({ ok: false, code: "hung", message: "no answer after 90 s" }))]);
      const ms = Date.now() - started;
      note(`branch_checkout with a locked file: ${co.ok ? "ok" : `${co.code} – ${co.message.slice(0, 200)}`} (${ms} ms)`);
      check(co.code !== "hung", "branch_checkout does not hang on the Git for Windows prompt (\"Should I try again?\")");
      // Git cannot read the locked file and therefore considers it modified; the app reports this like git.
      check(!co.ok && co.code !== "unknown", `branch_checkout: clear refusal instead of ${co.code} – ${co.message}`);
      const now = ws.tryGit(repo, ["symbolic-ref", "--short", "HEAD"]).out;
      note(`afterwards: HEAD ${now}, status ${JSON.stringify(gitStatus(ws, repo))}`);
      equal(now, "main", "git: HEAD is still on main");
      equal(ws.git(repo, ["rev-parse", "HEAD"]), before, "git: HEAD commit unchanged");
      check(!fs.existsSync(path.join(repo, "src", "b.txt")), "nothing from the other branch is half checked out");
      void before;
      await closeRepo(app, opened);
    } finally {
      await release();
    }
  });

  // ---------------------------------------------------------------------------------------------
  await section("T7 merge with conflict, started outside: detected, resolved and concluded in the app", async () => {
    const ws = ws0("t7a");
    const repo = diverged(ws);
    check(!ws.tryGit(repo, ["merge", "--no-ff", "thema"]).ok, "fixture: the merge ends in a conflict");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.operation?.kind === "merge" && status.value.operation.source === "thema", `operation detected: ${status.ok ? JSON.stringify(status.value.operation) : status.message}`);
    check(status.ok && status.value.conflicted.map((file) => file.path).join() === "text.txt", `conflicted file: ${status.ok ? JSON.stringify(status.value.conflicted.map((file) => file.path)) : ""}`);
    check(status.ok && status.value.staged.map((file) => file.path).join() === "thema.txt", `cleanly merged file is staged: ${status.ok ? JSON.stringify(status.value.staged.map((file) => file.path)) : ""}`);
    await selectWip(app, tabId);
    await eventually(async () => /Merge/.test(await app.page.locator('[data-screen="commit-panel"]').innerText()), true, "UI: the commit panel shows the running merge");
    const conflict = await call(app, "conflict_get", { repoId, path: "text.txt" });
    check(conflict.ok && conflict.value.ours?.includes("zwei von main") && conflict.value.theirs?.includes("ZWEI vom Thema"), `conflict_get: ${conflict.ok ? JSON.stringify([conflict.value.oursLabel, conflict.value.theirsLabel]) : `${conflict.code} – ${conflict.message}`}`);
    const resolved = await call(app, "conflict_resolve", { repoId, path: "text.txt", content: "eins\nzwei von beiden\ndrei\nvier vom Thema\n", side: null });
    check(resolved.ok && resolved.value.conflicted.length === 0, `conflict_resolve: ${resolved.ok ? resolved.value.conflicted.length : `${resolved.code} – ${resolved.message}`}`);
    const done = await call(app, "operation_continue", { repoId, message: "Merge von thema, von außen begonnen" });
    check(done.ok && done.value.status === "done", `operation_continue: ${done.ok ? JSON.stringify(done.value) : `${done.code} – ${done.message}`}`);
    equal(ws.git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").length, 3, "git: a merge commit with two parents");
    equal(ws.git(repo, ["log", "-1", "--format=%s"]), "Merge von thema, von außen begonnen", "git: message of the merge commit");
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("T7 rebase with conflict, started outside: detected with step, abort restores the start; continue works", async () => {
    const ws = ws0("t7b");
    const repo = diverged(ws);
    ws.git(repo, ["checkout", "-q", "thema"]);
    const before = ws.git(repo, ["rev-parse", "thema"]);
    check(!ws.tryGit(repo, ["rebase", "main"]).ok, "fixture: the rebase ends in a conflict");
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    let status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.operation?.kind === "rebase", `operation detected: ${status.ok ? JSON.stringify(status.value.operation) : status.message}`);
    if (status.ok && status.value.operation) {
      equal([status.value.operation.step, status.value.operation.totalSteps], [1, 3], "step 1 of 3");
      check(status.value.operation.target === "thema" || status.value.operation.source === "thema", `the branch "thema" is named: ${JSON.stringify(status.value.operation)}`);
    }
    check(status.ok && status.value.head.kind !== "branch" ? true : status.ok, "HEAD during the rebase");
    const abort = await call(app, "operation_abort", { repoId });
    check(abort.ok && abort.value.operation === null, `operation_abort: ${abort.ok ? JSON.stringify(abort.value.operation) : `${abort.code} – ${abort.message}`}`);
    equal(ws.git(repo, ["rev-parse", "thema"]), before, "git: thema is back at the start");
    equal(ws.git(repo, ["symbolic-ref", "--short", "HEAD"]), "thema", "git: thema is checked out");
    // Once more, this time continue: resolve the conflict (theirs = the commit from thema), then the rest runs through
    check(!ws.tryGit(repo, ["rebase", "main"]).ok, "fixture: second rebase ends in a conflict");
    status = await call(app, "status_get", { repoId });
    const resolved = await call(app, "conflict_resolve", { repoId, path: "text.txt", content: "eins\nZWEI vom Thema\ndrei\n", side: null });
    check(resolved.ok, `conflict_resolve fails: ${resolved.code} – ${resolved.message}`);
    let step = await call(app, "operation_continue", { repoId, message: null });
    for (let round = 0; round < 4 && step.ok && step.value.status === "conflict"; round++) {
      for (const file of step.value.files) await call(app, "conflict_resolve", { repoId, path: file, content: null, side: "theirs" });
      step = await call(app, "operation_continue", { repoId, message: null });
    }
    check(step.ok && step.value.status === "done", `operation_continue to the end: ${step.ok ? JSON.stringify(step.value).slice(0, 200) : `${step.code} – ${step.message}`}`);
    equal(ws.git(repo, ["merge-base", "thema", "main"]), ws.git(repo, ["rev-parse", "main"]), "git: thema sits on main");
    equal(ws.git(repo, ["rev-list", "--count", "main..thema"]), "3", "git: three commits on thema");
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean, no rebase open anymore");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("T7 interactive rebase, stopped outside at \"edit\" (no conflict): detected, amend commit, continue", async () => {
    const ws = ws0("t7c");
    const repo = diverged(ws);
    ws.git(repo, ["checkout", "-q", "thema"]);
    // The todo list: second commit set to "edit"
    const editor = path.join(ws.root, "todo-editor.mjs");
    fs.writeFileSync(editor, `import fs from "node:fs";\nconst file = process.argv[2];\nconst rows = fs.readFileSync(file, "utf8").split("\\n");\nlet seen = 0;\nfs.writeFileSync(file, rows.map((row) => (row.startsWith("pick ") && ++seen === 2 ? row.replace("pick", "edit") : row)).join("\\n"));\n`);
    const started = ws.tryGit(repo, ["rebase", "-i", "HEAD~3"], { env: { GIT_SEQUENCE_EDITOR: `node "${slash(editor)}"` } });
    note(`git rebase -i: ${started.ok ? "stopped" : started.out.split("\n").slice(-2).join(" ")}`);
    check(fs.existsSync(path.join(repo, ".git", "rebase-merge")), "fixture: the rebase is stopped");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.operation?.kind === "rebase", `operation detected: ${status.ok ? JSON.stringify(status.value.operation) : status.message}`);
    if (status.ok && status.value.operation) equal([status.value.operation.step, status.value.operation.totalSteps], [2, 3], "step 2 of 3");
    check(status.ok && status.value.conflicted.length === 0, "no conflict");
    await selectWip(app, tabId);
    const panel = (await app.page.locator('[data-screen="commit-panel"]').innerText().catch(() => "")).replace(/\s+/g, " ");
    note(`commit panel during the stopped rebase: ${JSON.stringify(panel.slice(0, 260))}`);
    check(/Rebase/i.test(panel), "UI: the commit panel names the running rebase");
    const cont = await call(app, "operation_continue", { repoId, message: null });
    check(cont.ok && cont.value.status === "done", `operation_continue: ${cont.ok ? JSON.stringify(cont.value).slice(0, 200) : `${cont.code} – ${cont.message}`}`);
    equal(lines(ws.git(repo, ["log", "--format=%s", "-n", "3", "thema"])), ["Thema: vierte Zeile", "Thema: neue Datei", "Thema ändert Zeile zwei"], "git: the three commits");
    check(!fs.existsSync(path.join(repo, ".git", "rebase-merge")), "git: no rebase open anymore");
    equal(ws.tryGit(repo, ["symbolic-ref", "--short", "HEAD"]).out, "thema", "git: thema is checked out again");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("T7 cherry-pick sequence and revert with conflict, started outside: detected, abort restores the start", async () => {
    const ws = ws0("t7d");
    const repo = diverged(ws);
    const before = ws.git(repo, ["rev-parse", "main"]);
    const picks = lines(ws.git(repo, ["rev-list", "--reverse", "main..thema"]));
    // thema~1 (new file) applies cleanly, thema~2 and thema (text.txt) do not: order chosen so the second one stops.
    check(!ws.tryGit(repo, ["cherry-pick", picks[1], picks[0], picks[2]]).ok, "fixture: the cherry-pick sequence stops in a conflict");
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    let status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.operation?.kind === "cherry_pick", `operation detected: ${status.ok ? JSON.stringify(status.value.operation) : status.message}`);
    if (status.ok && status.value.operation) equal([status.value.operation.step, status.value.operation.totalSteps], [2, 3], "step 2 of 3");
    let abort = await call(app, "operation_abort", { repoId });
    check(abort.ok && abort.value.operation === null, `operation_abort(cherry-pick): ${abort.ok ? JSON.stringify(abort.value.operation) : `${abort.code} – ${abort.message}`}`);
    equal(ws.git(repo, ["rev-parse", "main"]), before, "git: main is back at the start (the first, already applied commit is reverted too)");
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean");
    // Revert with conflict: reverting the base commit collides with the change on main
    ws.git(repo, ["checkout", "-q", "thema"]);
    write(repo, "text.txt", "eins\nZWEI vom Thema, noch einmal geändert\ndrei\nvier vom Thema\n");
    ws.commit(repo, "Thema ändert Zeile zwei erneut");
    const themaBefore = ws.git(repo, ["rev-parse", "thema"]);
    check(!ws.tryGit(repo, ["revert", "--no-edit", picks[0]]).ok, "fixture: the revert stops in a conflict");
    status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.operation?.kind === "revert", `operation detected: ${status.ok ? JSON.stringify(status.value.operation) : status.message}`);
    abort = await call(app, "operation_abort", { repoId });
    check(abort.ok, `operation_abort(revert) fails: ${abort.code} – ${abort.message}`);
    equal(ws.git(repo, ["rev-parse", "thema"]), themaBefore, "git: thema unchanged");
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-15: if a "git am" started outside stops in a conflict, the app detects no operation. The commit
  // panel says "Conflicts from an applied stash" (wrong), and there is neither "Continue" nor "Abort":
  // operation_abort answers "No operation is running …". The operation stays open.
  await section("T7 \"git am\" with conflict, started outside: not reported as a stash conflict; abort works or explains", async () => {
    const ws = ws0("t7e");
    const repo = diverged(ws);
    const before = ws.git(repo, ["rev-parse", "main"]);
    const patch = path.join(ws.root, "thema.patch");
    fs.writeFileSync(patch, ws.git(repo, ["format-patch", "--stdout", "main..thema"], { raw: true }));
    const am = ws.tryGit(repo, ["am", "--3way", patch]);
    check(!am.ok && fs.existsSync(path.join(repo, ".git", "rebase-apply", "applying")), "fixture: git am stops in a conflict");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const status = await call(app, "status_get", { repoId });
    check(status.ok, `status_get fails: ${status.code} – ${status.message}`);
    note(`status during git am: operation=${status.ok ? JSON.stringify(status.value.operation) : "-"}, conflicts=${status.ok ? JSON.stringify(status.value.conflicted.map((file) => file.path)) : "-"}`);
    await selectWip(app, tabId);
    const panel = (await app.page.locator('[data-screen="commit-panel"]').innerText().catch(() => "")).replace(/\s+/g, " ");
    note(`commit panel during git am: ${JSON.stringify(panel.slice(0, 260))}`);
    // Whatever the app shows: "Abort" must really end the running operation – or say that it is a "git am".
    const abort = await call(app, "operation_abort", { repoId });
    note(`operation_abort during git am: ${abort.ok ? "ok" : `${abort.code} – ${abort.message}`}`);
    const still = fs.existsSync(path.join(repo, ".git", "rebase-apply"));
    if (abort.ok) {
      check(!still, "after a successful abort \"git am\" is really ended");
      equal(ws.git(repo, ["rev-parse", "main"]), before, "git: main is back at the start");
    } else {
      check(abort.code !== "unknown" && /\bam\b|Patch/i.test(abort.message), `the refusal names "git am" / applying patches: ${abort.code} – ${abort.message}`);
    }
    if (status.ok && status.value.operation) check(status.value.operation.kind !== "rebase", `a running "git am" is reported as ${status.value.operation.kind}`);
    check(!/applied stash/i.test(panel), `the commit panel does not attribute the conflicts to a stash: ${JSON.stringify(panel.slice(0, 120))}`);
    ws.tryGit(repo, ["am", "--abort"]);
    await closeRepo(app, opened);
  }, { bug: "L2-15" });

  // ---------------------------------------------------------------------------------------------
  await section("T7 bisect, started outside: app stays usable, HEAD state is right, bisect state is not destroyed", async () => {
    const ws = ws0("t7f");
    const repo = small(ws, "bisect");
    for (let index = 0; index < 8; index++) {
      write(repo, "src/a.txt", `a\nmehr\n${"x\n".repeat(index + 1)}`);
      ws.commit(repo, `Weiterer Commit ${index + 1}`);
    }
    const good = ws.git(repo, ["rev-parse", "HEAD~8"]);
    ws.git(repo, ["bisect", "start", "HEAD", good]);
    const at = ws.git(repo, ["rev-parse", "HEAD"]);
    const seen = await coreLoop(t, app, ws, repo, { mutate: false });
    const { repoId, tabId } = seen.opened;
    const refs = await call(app, "refs_list", { repoId });
    check(refs.ok && refs.value.head.kind === "detached" && refs.value.head.sha === at, `HEAD detached at the bisect commit: ${refs.ok ? JSON.stringify(refs.value.head) : refs.message}`);
    await selectWip(app, tabId);
    const body = (await app.page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    note(`UI mentions bisect: ${/bisect/i.test(body)}`);
    // The bisect refs (refs/bisect/*) must not show up as branches or tags
    check(refs.ok && ![...refs.value.locals, ...refs.value.tags, ...refs.value.remotes].some((ref) => /bisect/.test(ref.fullName)), "refs/bisect/* do not show up as branch or tag");
    equal(lines(ws.git(repo, ["bisect", "log"])).length >= 3, true, "git: the bisect is still running");
    ws.git(repo, ["bisect", "reset"]);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("T8 every conflict kind: display, \"ours\" and \"theirs\" give what git checkout --ours/--theirs would give", async () => {
    const build = (ws) => {
      const repo = ws.init("konfliktarten");
      write(repo, "beide-geaendert.txt", "eins\nzwei\ndrei\n");
      write(repo, "von-uns-geloescht.txt", "bleibt bei ihnen\n");
      write(repo, "von-ihnen-geloescht.txt", "bleibt bei uns\n");
      write(repo, "umbenannt.txt", "wird auf beiden Seiten verschieden umbenannt\nzweite Zeile\ndritte Zeile\n");
      fs.writeFileSync(path.join(repo, "binaer.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
      write(repo, "crlf.txt", "eins\r\nzwei\r\ndrei\r\n");
      fs.writeFileSync(path.join(repo, "latin1.txt"), Buffer.from("Größe: eins\nzwei\n", "latin1"));
      ws.commit(repo, "Basis");
      ws.git(repo, ["checkout", "-q", "-b", "ihre"]);
      write(repo, "beide-geaendert.txt", "eins\nZWEI von ihnen\ndrei\n");
      write(repo, "von-uns-geloescht.txt", "bleibt bei ihnen\nund von ihnen geändert\n");
      fs.rmSync(path.join(repo, "von-ihnen-geloescht.txt"));
      write(repo, "beide-neu.txt", "von ihnen neu\n");
      ws.git(repo, ["mv", "umbenannt.txt", "name-von-ihnen.txt"]);
      fs.writeFileSync(path.join(repo, "binaer.bin"), Buffer.from([0, 9, 9, 9, 0, 255]));
      write(repo, "crlf.txt", "eins\r\nZWEI von ihnen\r\ndrei\r\n");
      fs.writeFileSync(path.join(repo, "latin1.txt"), Buffer.from("Größe: eins\nzwei von ihnen (ü)\n", "latin1"));
      ws.commit(repo, "Ihre Seite");
      ws.git(repo, ["checkout", "-q", "main"]);
      write(repo, "beide-geaendert.txt", "eins\nzwei von uns\ndrei\n");
      fs.rmSync(path.join(repo, "von-uns-geloescht.txt"));
      write(repo, "von-ihnen-geloescht.txt", "bleibt bei uns\nund von uns geändert\n");
      write(repo, "beide-neu.txt", "von uns neu\n");
      ws.git(repo, ["mv", "umbenannt.txt", "name-von-uns.txt"]);
      fs.writeFileSync(path.join(repo, "binaer.bin"), Buffer.from([0, 7, 7, 7, 0, 255]));
      write(repo, "crlf.txt", "eins\r\nzwei von uns\r\ndrei\r\n");
      fs.writeFileSync(path.join(repo, "latin1.txt"), Buffer.from("Größe: eins\nzwei von uns (ä)\n", "latin1"));
      ws.commit(repo, "Unsere Seite");
      ws.tryGit(repo, ["merge", "--no-ff", "ihre"]);
      return repo;
    };
    const kindsWanted = { "beide-geaendert.txt": "both_modified", "beide-neu.txt": "both_added", "von-uns-geloescht.txt": "deleted_by_us", "von-ihnen-geloescht.txt": "deleted_by_them", "umbenannt.txt": "both_deleted", "name-von-uns.txt": "added_by_us", "name-von-ihnen.txt": "added_by_them", "binaer.bin": "both_modified", "crlf.txt": "both_modified", "latin1.txt": "both_modified" };
    for (const side of ["ours", "theirs"]) {
      const ws = ws0(`t8-${side}`);
      const repo = build(ws);
      // Reference: the same repository, resolved with git itself
      const wsRef = ws0(`t8-ref-${side}`);
      const reference = build(wsRef);
      const stage = side === "ours" ? 2 : 3;
      const unmerged = lines(wsRef.git(reference, ["ls-files", "-u"]));
      for (const file of Object.keys(kindsWanted)) {
        const has = unmerged.some((row) => row.endsWith(`\t${file}`) && row.split(/\s+/)[2] === String(stage));
        if (has) {
          wsRef.git(reference, ["checkout", side === "ours" ? "--ours" : "--theirs", "--", file]);
          wsRef.git(reference, ["add", "--", file]);
        } else {
          wsRef.git(reference, ["rm", "-q", "--cached", "--ignore-unmatch", "--", file]);
          fs.rmSync(path.join(reference, file), { force: true });
        }
      }
      const opened = await app.openRepo(repo);
      const { repoId } = opened;
      const status = await call(app, "status_get", { repoId });
      if (!check(status.ok, `status_get fails: ${status.code} – ${status.message}`)) continue;
      const got = Object.fromEntries(status.value.conflicted.map((file) => [file.path, file.conflict]));
      if (side === "ours") equal(got, Object.fromEntries(Object.entries(kindsWanted).sort(([a], [b]) => (a < b ? -1 : 1))), "conflict kinds as in git status");
      for (const file of Object.keys(kindsWanted)) {
        const conflict = await call(app, "conflict_get", { repoId, path: file });
        check(conflict.ok && conflict.value.kind === kindsWanted[file], `conflict_get(${file}): ${conflict.ok ? conflict.value.kind : `${conflict.code} – ${conflict.message}`}`);
        if (conflict.ok && file === "binaer.bin") check(conflict.value.isBinary, "binaer.bin detected as binary");
        if (conflict.ok && file === "latin1.txt") check(conflict.value.ours?.includes("Größe") && conflict.value.theirs?.includes("ü"), `latin1.txt decoded readably: ${JSON.stringify([conflict.value.ours, conflict.value.theirs, conflict.value.encoding])}`);
        const resolved = await call(app, "conflict_resolve", { repoId, path: file, content: null, side });
        check(resolved.ok, `conflict_resolve(${file}, ${side}) fails: ${resolved.code} – ${resolved.message}`);
      }
      equal(lines(ws.git(repo, ["ls-files", "-u"])), [], `(${side}) git: no unresolved entries left`);
      equal(ws.git(repo, ["ls-files", "-s"]), wsRef.git(reference, ["ls-files", "-s"]), `(${side}) git: the index matches what git checkout --${side} / git rm gives`);
      for (const file of Object.keys(kindsWanted)) {
        const mine = fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file)).toString("hex") : null;
        const theirs = fs.existsSync(path.join(reference, file)) ? fs.readFileSync(path.join(reference, file)).toString("hex") : null;
        equal(mine, theirs, `(${side}) ${file}: file in the working tree as after git checkout --${side}`);
      }
      const done = await call(app, "operation_continue", { repoId, message: `Merge mit ${side}` });
      check(done.ok && done.value.status === "done", `(${side}) operation_continue: ${done.ok ? done.value.status : `${done.code} – ${done.message}`}`);
      await closeRepo(app, opened);
    }
  });
} catch (error) {
  t.check(false, `script aborted: ${error?.stack ?? error}`);
} finally {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  await app?.close().catch(() => undefined);
  for (const ws of spaces) ws.cleanup();
}
await sleep(50);
process.exit(t.finish());
