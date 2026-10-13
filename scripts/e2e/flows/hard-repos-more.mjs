/**
 * Difficult repositories, part 5: WHAT ELSE GOES WRONG – in the real app, against real git.
 *
 *   node scripts/e2e/flows/hard-repos-more.mjs [--show] [--only <part>[,<part>]]
 *
 *   M1  SHA-256 repository (64-character object names)     M2  reftable as ref storage
 *   M3  tags on non-commits (tree, blob, tag on tag)        M4  HEAD points to a branch that does not exist
 *   M5  corrupt index                                       M6  corrupt .git/config
 *   M7  nested repository (not a submodule)                 M8  every status combination (MM, AM, AD, RM, T, intent-to-add …)
 *   M9  case-only rename                                    M10 very long line (900 000 characters), 2500 hunks
 *   M11 wide graph (300 open branches)                      M12 300 stashes
 *   M13 repository opened through a link (junction)         M14 partial clone (without blobs)
 *   M15 script in file content, README and file names is not executed
 *
 * At the end there is a list of green and red sections. Red sections with "BUG L2-…" are the tests
 * the respective bug is fixed against.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { bugShot, healthy, call, closeRepo, coreLoop, coreStatusPaths, createRun, gitStatus, graphDom, lines, sorted, toasts, wipRows, workspace, write, zlist, selectWip, selectCommit, sleep } from "./hard-repos-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("hard-repos-more", { argv });
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
const WHO = "Lena Hartmann <lena.hartmann@wetterstation.example>";
const commitArgs = (repoId, summary) => ({ repoId, opId: `l2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, summary, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
const slash = (file) => file.replaceAll("\\", "/");
const samePath = (a, b) => path.resolve(a).replaceAll("\\", "/").toLowerCase() === path.resolve(b).replaceAll("\\", "/").toLowerCase();
const frames = () =>
  Promise.race([
    app.page.evaluate(() => new Promise((resolve) => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0)))); })),
    sleep(20_000).then(() => "hung"),
  ]);

/**
 * Longest time the page does not respond after `run()` (gap between two timer ticks), in ms.
 * The ticks arrive via console.log – this works even while `page.evaluate` does not get through.
 * If no tick arrives at all until `maxMs`, the result is `maxMs`.
 */
async function worstBlock(run, { maxMs = 100_000 } = {}) {
  const ticks = [];
  const onConsole = (message) => {
    const line = message.text();
    if (line.startsWith("L2GAP ")) ticks.push({ at: Date.now(), gap: Number(line.slice(6)) });
  };
  app.page.on("console", onConsole);
  await app.page.evaluate(() => {
    let last = performance.now();
    clearInterval(window.__l2Gap);
    window.__l2Gap = setInterval(() => {
      const now = performance.now();
      console.log(`L2GAP ${Math.round(now - last)}`);
      last = now;
    }, 200);
  });
  await sleep(500);
  ticks.length = 0;
  const started = Date.now();
  await run();
  // Wait until the page ticks again for two seconds in a row (or until the limit).
  for (;;) {
    await sleep(250);
    const recent = ticks.filter((tick) => tick.at > Date.now() - 2000);
    if (Date.now() - started > 3000 && recent.length >= 6 && recent.every((tick) => tick.gap < 600)) break;
    if (Date.now() - started > maxMs) break;
  }
  app.page.off("console", onConsole);
  const silent = ticks.length ? 0 : Date.now() - started;
  await Promise.race([app.page.evaluate(() => clearInterval(window.__l2Gap)).catch(() => undefined), sleep(5000)]);
  return Math.max(silent, ...ticks.map((tick) => tick.gap), 0);
}

/** Fills a freshly created repository like `small` in the other scripts. */
function fill(ws, repo) {
  ws.git(repo, ["config", "user.name", "Lena Hartmann"]);
  ws.git(repo, ["config", "user.email", "lena.hartmann@wetterstation.example"]);
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
  ws.git(repo, ["tag", "-a", "v1", "-m", "Version 1"]);
  return repo;
}
function small(ws, name = "klein") {
  return fill(ws, ws.init(name));
}

/** The core loop plus the usual follow-up actions that pass object names around. */
async function loopWithShas(ws, repo, label) {
  write(repo, "src/a.txt", "a\nmehr\nlokal\n");
  write(repo, "neu.txt", "neu\n");
  const seen = await coreLoop(t, app, ws, repo, { summary: `Commit (${label})` });
  if (!seen.opened) return seen;
  const { repoId, tabId } = seen.opened;
  const head = ws.git(repo, ["rev-parse", "HEAD"]);
  const root = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
  const prev = ws.git(repo, ["rev-parse", "HEAD~1"]);
  const steps = [
    ["commit_details(Root)", "commit_details", { repoId, source: { kind: "commit", sha: root } }],
    ["diff_file(Root, README.md)", "diff_file", { repoId, path: "README.md", source: { kind: "commit", sha: root } }],
    ["commit_details(comparison)", "commit_details", { repoId, source: { kind: "range", from: root, to: head } }],
    ["commit_details(against working tree)", "commit_details", { repoId, source: { kind: "range", from: prev, to: null } }],
    ["diff_file(comparison)", "diff_file", { repoId, path: "src/a.txt", source: { kind: "range", from: root, to: head } }],
    ["commit_search(Message)", "commit_search", { repoId, query: "Zweiter", limit: 10 }],
    ["commit_search(SHA prefix)", "commit_search", { repoId, query: head.slice(0, 8), limit: 10 }],
    ["file_history", "file_history", { repoId, path: "src/a.txt", limit: 10 }],
    ["file_blame", "file_blame", { repoId, path: "src/a.txt", sha: null }],
    ["file_blame(Commit)", "file_blame", { repoId, path: "src/a.txt", sha: prev }],
    ["file_read(Commit)", "file_read", { repoId, path: "src/a.txt", sha: prev }],
    ["tree_list(Commit)", "tree_list", { repoId, sha: prev, filter: null }],
    ["tag_create(on SHA)", "tag_create", { repoId, name: "l2-tag", sha: prev, message: "Annotation" }],
    ["branch_create(from SHA)", "branch_create", { repoId, name: "l2-ab-sha", start: prev, checkout: false }],
    ["branch_checkout(SHA)", "branch_checkout", { repoId, target: prev }],
    ["branch_checkout(main)", "branch_checkout", { repoId, target: "main" }],
    ["cherry_pick", "cherry_pick", { repoId, shas: [ws.git(repo, ["rev-parse", "seite"])] }],
    ["revert_commit", "revert_commit", { repoId, sha: ws.git(repo, ["rev-parse", "main"]) }],
    ["undo(Revert)", "undo", { repoId }],
    ["reset_branch(soft)", "reset_branch", { repoId, sha: prev, mode: "soft" }],
    ["undo(Reset)", "undo", { repoId }],
    ["file_restore", "file_restore", { repoId, sha: root, paths: ["README.md"] }],
    ["undo(restore)", "undo", { repoId }],
    ["rebase_plan", "rebase_plan", { repoId, base: root }],
    ["stash_create", "stash_create", { repoId, opId: `l2-${Date.now()}`, message: "Stash", paths: null, includeUntracked: true }],
    ["stash_list", "stash_list", { repoId }],
    ["patch_create(Commit)", "patch_create", { repoId, source: { kind: "commit", sha: head }, paths: null }],
    ["refs_list", "refs_list", { repoId }],
    ["graph_page", "graph_page", { repoId, cursor: null, limit: 500 }],
  ];
  for (const [title, command, args] of steps) {
    if (command === "revert_commit") args.sha = ws.git(repo, ["rev-parse", "main"]);
    if (command === "stash_create") write(repo, "src/a.txt", `${fs.readFileSync(path.join(repo, "src/a.txt"), "utf8")}für den Stash\n`);
    const result = await call(app, command, args);
    check(result.ok, `${label}: ${title} fails: ${result.code} – ${result.message} – ${String(result.gitOutput ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    if (result.ok && command === "commit_search" && title.includes("SHA")) check(result.value.some((hit) => hit.sha === head), `${label}: searching for the SHA prefix finds the commit`);
    if (result.ok && command === "rebase_plan") check(result.value.status === "ok", `${label}: rebase_plan ${result.value.status} ${result.value.message ?? ""}`);
  }
  // UI: select a commit, details and SHA appear
  await selectCommit(app, tabId, root);
  await eventually(async () => (await app.page.locator('[data-screen="commit-details"]').innerText()).includes("Erster Commit"), true, `${label}: UI shows the details of the root commit`);
  equal((await toasts(app)).filter((toast) => toast.tone === "danger"), [], `${label}: no error toast in the UI`);
  return seen;
}

try {
  // ---------------------------------------------------------------------------------------------
  await section("M1 SHA-256 repository: core loop and everything that passes object names around", async () => {
    const ws = ws0("m1");
    const repo = path.join(ws.root, "sha256");
    fs.mkdirSync(repo);
    ws.git(repo, ["init", "-q", "-b", "main", "--object-format=sha256"]);
    fill(ws, repo);
    equal(ws.git(repo, ["rev-parse", "HEAD"]).length, 64, "fixture: 64-character object names");
    const seen = await loopWithShas(ws, repo, "SHA-256");
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M2 reftable as ref storage: core loop, branches, tags, stash, file watching", async () => {
    const ws = ws0("m2");
    const repo = path.join(ws.root, "reftable");
    fs.mkdirSync(repo);
    const made = ws.tryGit(repo, ["init", "-q", "-b", "main", "--ref-format=reftable"]);
    if (!check(made.ok, `fixture: git init --ref-format=reftable fails: ${made.out}`)) return;
    fill(ws, repo);
    check(fs.existsSync(path.join(repo, ".git", "reftable")), "fixture: refs live in the reftable storage");
    const seen = await loopWithShas(ws, repo, "Reftable");
    if (seen.opened) {
      const { repoId } = seen.opened;
      // A commit from outside only changes .git/reftable – the app must notice anyway
      const events = await app.recordEvents(["repo:changed"]);
      ws.git(repo, ["commit", "-q", "--allow-empty", "-m", "Commit von außen"]);
      await events.waitFor("repo:changed", 15_000).catch(() => undefined);
      const got = await events.take();
      await events.stop();
      check(got.length > 0, "repo:changed after a commit from outside");
      const refs = await call(app, "refs_list", { repoId });
      equal(refs.ok ? refs.value.head.sha : null, ws.git(repo, ["rev-parse", "HEAD"]), "refs_list knows the new HEAD");
      // Operation from outside: merge conflict is detected (MERGE_HEAD is still a file)
      const rename = await call(app, "branch_rename", { repoId, name: "seite", newName: "seite/umbenannt" });
      check(rename.ok, `branch_rename fails: ${rename.code} – ${rename.message}`);
      const del = await call(app, "branch_delete", { repoId, names: ["seite/umbenannt"], force: true });
      check(del.ok, `branch_delete fails: ${del.code} – ${del.message}`);
      const undo = await call(app, "undo", { repoId });
      check(undo.ok, `undo(delete branch) fails: ${undo.code} – ${undo.message}`);
      check(ws.tryGit(repo, ["rev-parse", "-q", "--verify", "refs/heads/seite/umbenannt"]).ok, "git: undo brings the branch back");
    }
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M3 tags on non-commits (tree, blob, tag on tag): refs, graph, left panel, selecting", async () => {
    const ws = ws0("m3");
    const repo = small(ws, "seltsame-tags");
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const tree = ws.git(repo, ["rev-parse", "HEAD^{tree}"]);
    const blob = ws.git(repo, ["rev-parse", "HEAD:README.md"]);
    ws.git(repo, ["tag", "auf-tree", tree]);
    ws.git(repo, ["tag", "auf-blob", blob]);
    ws.git(repo, ["tag", "-a", "annotiert-auf-tree", "-m", "zeigt auf einen Tree", tree]);
    ws.git(repo, ["tag", "-a", "annotiert-auf-blob", "-m", "zeigt auf einen Blob", blob]);
    ws.git(repo, ["tag", "-a", "tag-auf-tag", "-m", "zeigt auf einen Tag", "v1"]);
    ws.git(repo, ["tag", "-a", "tag-auf-tag-auf-tag", "-m", "dreifach", "tag-auf-tag"]);
    write(repo, "README.md", "# Klein\ngeändert\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit neben seltsamen Tags" });
    const { repoId, tabId } = seen.opened;
    const refs = await call(app, "refs_list", { repoId });
    if (check(refs.ok, `refs_list fails: ${refs.code} – ${refs.message}`)) {
      const byName = Object.fromEntries(refs.value.tags.map((tag) => [tag.name, tag]));
      equal(sorted(Object.keys(byName)), sorted(["v1", "auf-tree", "auf-blob", "annotiert-auf-tree", "annotiert-auf-blob", "tag-auf-tag", "tag-auf-tag-auf-tag"]), "all tags listed");
      equal(byName["tag-auf-tag"]?.sha, head, "tag on tag: resolved down to the commit");
      equal(byName["tag-auf-tag-auf-tag"]?.sha, head, "tag on tag on tag: resolved down to the commit");
      note(`tags on non-commits: ${JSON.stringify(["auf-tree", "auf-blob", "annotiert-auf-tree", "annotiert-auf-blob"].map((name) => [name, byName[name]?.sha?.slice(0, 7), byName[name]?.isAnnotated]))}`);
    }
    await app.settle(30_000);
    check(await healthy(app), "the UI is up");
    // What the user can do with such a tag: check out, delete, branch from it – each with a clear answer
    for (const name of ["auf-tree", "auf-blob", "annotiert-auf-tree"]) {
      const sha = refs.ok ? refs.value.tags.find((tag) => tag.name === name)?.sha : null;
      const co = await call(app, "branch_checkout", { repoId, target: name });
      check(!co.ok && co.code !== "unknown", `branch_checkout(${name}): ${co.ok ? "checked out" : `${co.code} – ${co.message}`}`);
      const branch = await call(app, "branch_create", { repoId, name: `aus-${name}`, start: name, checkout: false });
      check(!branch.ok && branch.code !== "unknown", `branch_create(start: ${name}): ${branch.ok ? "created" : `${branch.code} – ${branch.message}`}`);
      if (sha) {
        const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha } });
        check(!details.ok ? details.code !== "unknown" : true, `commit_details(target of ${name}): ${details.code} – ${details.message}`);
        await selectCommit(app, tabId, sha).catch(() => undefined);
        await sleep(300);
        check(await healthy(app), `UI is up after selecting the target of ${name}`);
      }
      const del = await call(app, "tag_delete", { repoId, name, remote: null });
      check(del.ok, `tag_delete(${name}) fails: ${del.code} – ${del.message}`);
    }
    equal(ws.git(repo, ["symbolic-ref", "--short", "HEAD"]), "main", "git: HEAD is still on main");
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M4 HEAD points to a branch that does not exist (repository with history): graph shows the history, switching works", async () => {
    const ws = ws0("m4");
    const repo = small(ws, "verwaister-head");
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/gibt-es-nicht\n");
    const want = gitStatus(ws, repo);
    const opened = await call(app, "repo_open", { path: repo });
    if (!check(opened.ok, `repo_open fails: ${opened.code} – ${opened.message}`)) return;
    const repoId = opened.value.repo.id;
    const tabId = opened.value.tab.id;
    const refs = await call(app, "refs_list", { repoId });
    check(refs.ok && refs.value.head.kind === "unborn" && refs.value.head.branch === "gibt-es-nicht" && refs.value.locals.length === 2, `refs_list: ${refs.ok ? JSON.stringify([refs.value.head, refs.value.locals.map((ref) => ref.name)]) : `${refs.code} – ${refs.message}`}`);
    const page = await call(app, "graph_page", { repoId, cursor: null, limit: 500 });
    check(page.ok && page.value.rows.filter((row) => row.kind === "commit" || row.kind === "merge").length === 4, `graph_page shows the four commits of the existing branches: ${page.ok ? JSON.stringify(page.value.rows.map((row) => row.kind)) : `${page.code} – ${page.message}`}`);
    const status = await call(app, "status_get", { repoId });
    if (check(status.ok, `status_get fails: ${status.code} – ${status.message}`)) equal(coreStatusPaths(status.value), want, "status as in git status (everything staged as new)");
    await app.settle(30_000);
    await eventually(async () => (await graphDom(app)).filter((row) => row.kind === "commit").length, 4, "UI: the graph shows the four commits (not the empty state)", 15_000);
    void tabId;
    const co = await call(app, "branch_checkout", { repoId, target: "main" });
    note(`branch_checkout(main) from the orphaned HEAD: ${co.ok ? "ok" : `${co.code} – ${co.message}`}`);
    check(co.ok || co.code !== "unknown", `branch_checkout(main) answers clearly: ${co.code} – ${co.message}`);
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-13 (like commit-search in hard-repos-structure.mjs): a corrupt index only yields "Git command 'git status'
  // failed (exit code 128)" with code `unknown`; the commit details do not load anymore either.
  await section("M5 corrupt index: history stays visible, the status names the damage", async () => {
    const ws = ws0("m5");
    const repo = small(ws, "kaputter-index");
    fs.writeFileSync(path.join(repo, ".git", "index"), Buffer.from("das ist kein Index\n".repeat(20)));
    note(`git status: ${ws.tryGit(repo, ["status", "--porcelain"]).out.split("\n").slice(-2).join(" ").slice(0, 160)}`);
    const opened = await call(app, "repo_open", { path: repo });
    if (!check(opened.ok, `repo_open fails: ${opened.code} – ${opened.message}`)) return;
    const repoId = opened.value.repo.id;
    const page = await call(app, "graph_page", { repoId, cursor: null, limit: 500 });
    check(page.ok && page.value.rows.filter((row) => row.kind === "commit").length === 4, `graph_page: ${page.ok ? page.value.rows.length : `${page.code} – ${page.message}`}`);
    const refs = await call(app, "refs_list", { repoId });
    check(refs.ok, `refs_list fails: ${refs.code} – ${refs.message}`);
    const status = await call(app, "status_get", { repoId });
    check(!status.ok && status.code !== "unknown" && /Index/i.test(status.message), `status_get names the corrupt index: ${status.ok ? "returns a status" : `${status.code} – ${status.message}`}`);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: ws.git(repo, ["rev-parse", "HEAD"]) } });
    check(details.ok, `commit_details fails: ${details.code} – ${details.message}`);
    await app.settle(20_000).catch(() => undefined);
    await sleep(500);
    check(await healthy(app), "the UI is up");
    await eventually(async () => (await graphDom(app)).filter((row) => row.kind === "commit").length, 4, "UI: the graph shows the history despite the broken index", 15_000);
    const body = (await app.page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    note(`UI: ${JSON.stringify((await toasts(app)).map((toast) => toast.text.slice(0, 120)))}; mentions "index": ${/Index/.test(body)}`);
    await closeRepo(app, { repoId, tabId: opened.value.tab.id });
    app.consoleErrors.length = 0;
  }, { bug: "L2-13" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-13: a single broken line in .git/config ("fatal: bad config line 12 in file .git/config")
  // and the app reports "… is not a Git repository. … or create a new repository there."
  await section("M6 corrupt .git/config: the message names the configuration (not \"not a Git repository\")", async () => {
    const ws = ws0("m6");
    const repo = small(ws, "kaputte-config");
    fs.appendFileSync(path.join(repo, ".git", "config"), "\n[kaputt\n\tohne = ende\n");
    note(`git status: ${ws.tryGit(repo, ["status", "--porcelain"]).out.split("\n").slice(-2).join(" ").slice(0, 160)}`);
    const opened = await call(app, "repo_open", { path: repo });
    note(`repo_open: ${opened.ok ? "opened" : `${opened.code} – ${opened.message}`}`);
    if (opened.ok) {
      const status = await call(app, "status_get", { repoId: opened.value.repo.id });
      check(!status.ok && /configuration|config/i.test(status.message), `status_get names the configuration: ${status.ok ? "returns a status" : `${status.code} – ${status.message}`}`);
      await sleep(1500);
      check(await healthy(app), "the UI is up");
      await closeRepo(app, { repoId: opened.value.repo.id, tabId: opened.value.tab.id });
      app.consoleErrors.length = 0;
    } else {
      check(/configuration|config/i.test(opened.message) && !/not a Git repository/i.test(opened.message), `the message names the corrupt configuration: ${opened.code} – ${opened.message}`);
      // The same path through the UI (Alt+O), for the bug screenshot.
      await app.pick(repo);
      await app.page.keyboard.press("Alt+o");
      await eventually(async () => (await toasts(app)).length > 0, true, "UI: toast after opening");
      await bugShot(app, "-config");
    }
  }, { bug: "L2-13" });

  // ---------------------------------------------------------------------------------------------
  await section("M7 nested repository (not a submodule): status, diff, \"stage all\" does not silently create a gitlink", async () => {
    const ws = ws0("m7");
    const repo = small(ws, "aussen");
    const inner = path.join(repo, "werkzeug", "innen");
    fs.mkdirSync(inner, { recursive: true });
    ws.git(inner, ["init", "-q", "-b", "main"]);
    write(inner, "innen.txt", "innen\n");
    ws.git(inner, ["add", "-A"]);
    ws.git(inner, ["-c", "user.name=X", "-c", "user.email=x@example.com", "commit", "-q", "-m", "innen"]);
    write(repo, "README.md", "# Klein\ngeändert\n");
    const want = gitStatus(ws, repo);
    note(`git status: ${JSON.stringify(want)}`);
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const status = await call(app, "status_get", { repoId });
    if (check(status.ok, `status_get fails: ${status.code} – ${status.message}`)) equal(coreStatusPaths(status.value), want, "status as in git status");
    const nested = status.ok ? status.value.unstaged.find((file) => file.path.startsWith("werkzeug/innen")) : null;
    if (check(Boolean(nested), "the nested repository is in the list")) {
      const diff = await call(app, "diff_file", { repoId, path: nested.path, source: { kind: "unstaged" } });
      note(`diff_file(${nested.path}): ${diff.ok ? diff.value.kind : `${diff.code} – ${diff.message}`}`);
      check(diff.ok || diff.code !== "unknown", `diff_file(nested repository) answers clearly: ${diff.code} – ${diff.message}`);
      await selectWip(app, tabId);
      await app.page.locator(`[data-section="unstaged"] [data-row-key=${JSON.stringify(nested.path)}]`).click();
      await app.settle();
      await sleep(300);
      const shown = ((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
      note(`UI: ${JSON.stringify(shown.slice(0, 200))}`);
      check(await healthy(app), "the UI is up");
    }
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok, `stage_paths(all) fails: ${all.code} – ${all.message}`);
    const entry = ws.git(repo, ["ls-files", "-s", "werkzeug/innen"]);
    note(`index after "stage all": ${JSON.stringify(entry)}`);
    // git add creates a gitlink without .gitmodules for an embedded repository and only warns on the console.
    // In the app the user does not see the warning – they must at least be able to tell WHAT is staged.
    if (entry.startsWith("160000")) {
      const st = await call(app, "status_get", { repoId });
      const staged = st.ok ? st.value.staged.find((file) => file.path.startsWith("werkzeug/innen")) : null;
      const diff = staged ? await call(app, "diff_file", { repoId, path: staged.path, source: { kind: "staged" } }) : null;
      note(`staged gitlink: ${JSON.stringify(staged)}; Diff: ${diff ? (diff.ok ? JSON.stringify(diff.value).slice(0, 200) : `${diff.code} – ${diff.message}`) : "-"}`);
      const shown = await toasts(app);
      note(`toasts after "stage all": ${JSON.stringify(shown.map((toast) => toast.text.slice(0, 140)))}`);
    }
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M8 every status combination (MM, AM, AD, MD, RM, RD, type change, intent-to-add, ignored): lists and diffs as in git", async () => {
    const ws = ws0("m8");
    const repo = ws.init("status-zoo", { config: { "core.symlinks": "false" } });
    const body = (name) => `${Array.from({ length: 12 }, (_, index) => `${name} Zeile ${index + 1}`).join("\n")}\n`;
    for (const name of ["m-index", "m-worktree", "mm", "md", "d-index", "d-worktree", "r-quelle", "rm-quelle", "rd-quelle", "typ-index", "typ-worktree", "c-quelle"]) write(repo, `${name}.txt`, body(name));
    write(repo, ".gitignore", "ignoriert.log\n");
    ws.commit(repo, "Ausgangsstand");
    const edit = (name, mark) => write(repo, `${name}.txt`, body(name).replace("Zeile 3", `Zeile 3 ${mark}`));
    edit("m-index", "INDEX");
    ws.git(repo, ["add", "m-index.txt"]);
    edit("m-worktree", "WORKTREE");
    edit("mm", "INDEX");
    ws.git(repo, ["add", "mm.txt"]);
    write(repo, "mm.txt", body("mm").replace("Zeile 3", "Zeile 3 INDEX").replace("Zeile 10", "Zeile 10 WORKTREE"));
    edit("md", "INDEX");
    ws.git(repo, ["add", "md.txt"]);
    fs.rmSync(path.join(repo, "md.txt"));
    ws.git(repo, ["rm", "-q", "d-index.txt"]);
    fs.rmSync(path.join(repo, "d-worktree.txt"));
    ws.git(repo, ["mv", "r-quelle.txt", "r-ziel.txt"]);
    ws.git(repo, ["mv", "rm-quelle.txt", "rm-ziel.txt"]);
    write(repo, "rm-ziel.txt", body("rm-quelle").replace("Zeile 11", "Zeile 11 WORKTREE"));
    ws.git(repo, ["mv", "rd-quelle.txt", "rd-ziel.txt"]);
    fs.rmSync(path.join(repo, "rd-ziel.txt"));
    write(repo, "a-index.txt", body("a-index"));
    ws.git(repo, ["add", "a-index.txt"]);
    write(repo, "am.txt", body("am"));
    ws.git(repo, ["add", "am.txt"]);
    write(repo, "am.txt", `${body("am")}angehängt\n`);
    write(repo, "ad.txt", body("ad"));
    ws.git(repo, ["add", "ad.txt"]);
    fs.rmSync(path.join(repo, "ad.txt"));
    write(repo, "unverfolgt.txt", "neu\n");
    write(repo, "ignoriert.log", "nicht zeigen\n");
    write(repo, "ita.txt", body("ita"));
    ws.git(repo, ["add", "-N", "ita.txt"]);
    // Type change in the index: file → symlink
    const link = ws.git(repo, ["hash-object", "-w", "--stdin"], { input: "m-index.txt" });
    ws.git(repo, ["update-index", "--cacheinfo", `120000,${link},typ-index.txt`]);
    fs.writeFileSync(path.join(repo, "typ-index.txt"), "m-index.txt");
    const porcelain = ws.git(repo, ["status", "--porcelain=v1", "--no-renames"]);
    note(`git status: ${JSON.stringify(porcelain.split("\n"))}`);
    const want = gitStatus(ws, repo);
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const status = await call(app, "status_get", { repoId });
    if (!check(status.ok, `status_get fails: ${status.code} – ${status.message}`)) return;
    equal(coreStatusPaths(status.value), want, "status as in git status");
    check(!status.value.unstaged.some((file) => file.path === "ignoriert.log"), "ignored file is not in the list");
    const kinds = (list) => Object.fromEntries(list.map((file) => [file.path, file.status]));
    note(`staged: ${JSON.stringify(kinds(status.value.staged))}`);
    note(`unstaged: ${JSON.stringify(kinds(status.value.unstaged))}`);
    equal(kinds(status.value.staged)["r-ziel.txt"], "renamed", "R: detected as renamed");
    equal(status.value.staged.find((file) => file.path === "r-ziel.txt")?.oldPath, "r-quelle.txt", "R: old path");
    for (const [area, list] of [["staged", status.value.staged], ["unstaged", status.value.unstaged]]) {
      for (const file of list) {
        const diff = await call(app, "diff_file", { repoId, path: file.path, source: { kind: area } });
        check(diff.ok, `diff_file(${area}, ${file.path}/${file.status}) fails: ${diff.code} – ${diff.message}`);
        if (!diff.ok || diff.value.kind !== "text") continue;
        // Cross-check with git: same number of changed lines
        const numstat = ws.git(repo, ["diff", ...(area === "staged" ? ["--cached"] : []), "--numstat", "--no-renames", "--", file.path]).split("\t");
        const added = diff.value.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").length;
        const removed = diff.value.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "remove").length;
        if (file.status !== "renamed" && file.status !== "untracked" && numstat.length >= 2 && numstat[0] !== "-") {
          equal([added, removed], [Number(numstat[0]), Number(numstat[1])], `diff_file(${area}, ${file.path}): line counts as in git diff --numstat`);
        }
      }
    }
    // UI: both lists complete
    await selectWip(app, tabId);
    await eventually(async () => sorted(await wipRows(app, "staged")), sorted(status.value.staged.map((file) => file.path)), "UI: \"Staged\" list");
    await eventually(async () => sorted(await wipRows(app, "unstaged")), sorted(status.value.unstaged.map((file) => file.path)), "UI: \"Unstaged\" list");
    // Stage a hunk in mm.txt (already changed in the index), in the intent-to-add file and in the renamed file
    for (const rel of ["mm.txt", "ita.txt", "rm-ziel.txt"]) {
      const diff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
      if (!check(diff.ok && diff.value.kind === "text" && diff.value.hunks.length >= 1, `diff_file(unstaged, ${rel}): ${diff.ok ? diff.value.kind : `${diff.code} – ${diff.message}`}`)) continue;
      const staged = await call(app, "stage_patch", { repoId, selection: { path: rel, hunks: [{ index: 0, lines: null }], expect: diff.value.token } });
      check(staged.ok, `stage_patch(${rel}) fails: ${staged.code} – ${staged.message}`);
      equal(ws.git(repo, ["rev-parse", `:${rel}`]), ws.git(repo, ["hash-object", "--", rel]), `${rel}: index after staging the hunk equals the file`);
    }
    // Unstage everything, stage everything, commit
    const un = await call(app, "unstage_paths", { repoId, paths: null });
    check(un.ok, `unstage_paths(all) fails: ${un.code} – ${un.message}`);
    equal(ws.git(repo, ["diff", "--cached", "--name-only"]), "", "git: after \"unstage all\" nothing is staged");
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok, `stage_paths(all) fails: ${all.code} – ${all.message}`);
    equal(gitStatus(ws, repo).unstaged, [], "git: after \"stage all\" nothing unstaged");
    const commit = await call(app, "commit_create", commitArgs(repoId, "Der ganze Zoo"));
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean");
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    if (check(details.ok, `commit_details fails: ${details.code} – ${details.message}`)) {
      note(`commit details: ${JSON.stringify(kinds(details.value.files))}`);
      const typ = details.value.files.find((file) => file.path === "typ-index.txt");
      const diff = typ ? await call(app, "diff_file", { repoId, path: "typ-index.txt", source: { kind: "commit", sha: head } }) : null;
      check(Boolean(typ) && diff?.ok, `type change (file → symlink) in the commit: ${typ ? (diff?.ok ? diff.value.kind : `${diff?.code} – ${diff?.message}`) : "missing from the file list"}`);
    }
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M9 case-only rename (readme.md → README.md): status, unstage, commit, switch", async () => {
    const ws = ws0("m9");
    const repo = ws.init("gross-klein-umbenennen");
    write(repo, "readme.md", "# lies mich\n");
    write(repo, "ordner/datei.txt", "x\n");
    ws.commit(repo, "klein geschrieben");
    ws.git(repo, ["branch", "vorher"]);
    ws.git(repo, ["mv", "readme.md", "README.md"]);
    ws.git(repo, ["mv", "ordner", "Ordner-tmp"]);
    ws.git(repo, ["mv", "Ordner-tmp", "Ordner"]);
    const want = gitStatus(ws, repo);
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    let status = await call(app, "status_get", { repoId });
    if (check(status.ok, `status_get fails: ${status.code} – ${status.message}`)) equal(coreStatusPaths(status.value), want, "status as in git status");
    for (const file of status.ok ? status.value.staged : []) {
      const diff = await call(app, "diff_file", { repoId, path: file.path, source: { kind: "staged" } });
      check(diff.ok, `diff_file(staged, ${file.path}) fails: ${diff.code} – ${diff.message}`);
    }
    const un = await call(app, "unstage_paths", { repoId, paths: status.ok ? status.value.staged.map((file) => file.path) : [] });
    check(un.ok, `unstage_paths(renames) fails: ${un.code} – ${un.message}`);
    equal(sorted(lines(ws.git(repo, ["ls-files"]))), ["ordner/datei.txt", "readme.md"], "git: the index is lower case again");
    status = await call(app, "status_get", { repoId });
    if (status.ok) equal(coreStatusPaths(status.value), gitStatus(ws, repo), "status as in git status after unstaging");
    // Rename again and commit
    ws.git(repo, ["mv", "-f", "readme.md", "README.md"]);
    const commit = await call(app, "commit_create", commitArgs(repoId, "README groß geschrieben"));
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    check(lines(ws.git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).includes("README.md"), "git: in the commit the file is called README.md");
    // Switch across the rename and back: clean status, correct case on disk
    const back = await call(app, "branch_checkout", { repoId, target: "vorher" });
    check(back.ok, `branch_checkout(vorher) fails: ${back.code} – ${back.message}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean on \"vorher\"");
    check(fs.readdirSync(repo).includes("readme.md"), `on disk the file is called readme.md (${fs.readdirSync(repo).join(", ")})`);
    const forth = await call(app, "branch_checkout", { repoId, target: "main" });
    check(forth.ok, `branch_checkout(main) fails: ${forth.code} – ${forth.message}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean on main");
    check(fs.readdirSync(repo).includes("README.md"), `on disk the file is called README.md (${fs.readdirSync(repo).join(", ")})`);
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-16: the diff of a file with a very long line (minified JS, single-line JSON) freezes the UI as
  // soon as the file is clicked: almost 6 s for a 58 KB line, over two minutes for 260 KB (quadratic in the
  // line length). The core returns the diff in 0.1 s; the time is spent in the hunks view. The "large diff"
  // limit (1 MB / 20 000 lines) does not kick in.
  await section("M10 very long line (100 KB in one line): the diff view does not freeze", async () => {
    const ws = ws0("m10");
    const repo = ws.init("lange-zeile");
    const longLine = (mark) => `var daten=[${Array.from({ length: 35_000 }, (_, index) => (index === 17_500 ? mark : index % 97)).join(",")}];`;
    write(repo, "min.js", `${longLine(1)}\n`);
    ws.commit(repo, "Minifizierte Datei");
    write(repo, "min.js", `${longLine(123456)}\n`);
    note(`min.js: one line with ${fs.statSync(path.join(repo, "min.js")).size} bytes`);
    const { repoId, tabId } = await app.openRepo(repo);
    await selectWip(app, tabId);
    const started = Date.now();
    const diff = await call(app, "diff_file", { repoId, path: "min.js", source: { kind: "unstaged" } });
    note(`diff_file in the core: ${Date.now() - started} ms, kind ${diff.ok ? diff.value.kind : diff.code}`);
    check(diff.ok && diff.value.kind === "text", `diff_file: ${diff.ok ? diff.value.kind : `${diff.code} – ${diff.message}`}`);
    const blocked = await worstBlock(() => app.page.locator('[data-section="unstaged"] [data-row-key="min.js"]').click());
    note(`UI after clicking min.js: longest block ${blocked} ms`);
    check(blocked < 2000, `the UI does not respond for ${blocked} ms after the click (limit 2000 ms)`);
    await closeRepo(app, { repoId, tabId }).catch(() => undefined);
  }, { bug: "L2-16" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-17: "Side by side" for a large diff that still loads on its own (19 000 lines, 2375 changed,
  // 240 KB – below the 20 000 line limit) blocks the UI for a good 30 s. "Hunks" and "Whole file" show
  // the same diff immediately. The chosen mode is remembered.
  await section("M10 2375 changed lines in 19 000: \"Side by side\" does not freeze", async () => {
    const ws = ws0("m10b");
    const repo = ws.init("viele-hunks");
    write(repo, "viele-hunks.txt", Array.from({ length: 19_000 }, (_, index) => `Zeile ${index + 1}`).join("\n") + "\n");
    ws.commit(repo, "Viele Zeilen");
    write(repo, "viele-hunks.txt", Array.from({ length: 19_000 }, (_, index) => (index % 8 === 3 ? `Zeile ${index + 1} GEÄNDERT` : `Zeile ${index + 1}`)).join("\n") + "\n");
    const { repoId, tabId } = await app.openRepo(repo);
    await selectWip(app, tabId);
    const view = app.page.locator('[data-screen="diff"]');
    const open = await worstBlock(() => app.page.locator('[data-section="unstaged"] [data-row-key="viele-hunks.txt"]').click());
    note(`hunks view: longest block ${open} ms`);
    check(open < 2000, `hunks view blocks for ${open} ms`);
    const whole = await worstBlock(() => view.getByRole("radio", { name: /Whole file/ }).first().click());
    note(`"Whole file": longest block ${whole} ms`);
    check(whole < 2000, `"Whole file" blocks for ${whole} ms`);
    const split = await worstBlock(() => view.getByRole("radio", { name: /Side by side/ }).first().click());
    note(`"Side by side": longest block ${split} ms`);
    check(split < 2000, `"Side by side" blocks the UI for ${split} ms (limit 2000 ms)`);
    // Reset the mode – it is remembered in the settings.
    await view.getByRole("radio", { name: /^Hunks/ }).first().click({ timeout: 60_000 }).catch(() => undefined);
    await closeRepo(app, { repoId, tabId }).catch(() => undefined);
  }, { bug: "L2-17" });

  // ---------------------------------------------------------------------------------------------
  await section("M11 wide graph (300 open branches, a merge with 60 parents): drawing, width, scrolling", async () => {
    const ws = ws0("m11");
    const repo = ws.init("breit");
    let stream = `commit refs/heads/main\nmark :1\nauthor ${WHO} 1772434800 +0100\ncommitter ${WHO} 1772434800 +0100\ndata 5\nBasis\nM 100644 inline basis.txt\ndata 6\nbasis\n\n`;
    let mark = 1;
    const tips = [];
    for (let index = 0; index < 300; index++) {
      let from = 1;
      for (let step = 0; step < 3; step++) {
        mark += 1;
        const message = `Branch ${index + 1}, Schritt ${step + 1}`;
        stream += `commit refs/heads/thema-${String(index).padStart(3, "0")}\nmark :${mark}\nauthor ${WHO} ${1772434800 + mark * 60} +0100\ncommitter ${WHO} ${1772434800 + mark * 60} +0100\ndata ${Buffer.byteLength(message)}\n${message}\nfrom :${from}\nM 100644 inline t-${index}.txt\ndata 2\n${step}\n\n`;
        from = mark;
      }
      tips.push(mark);
    }
    mark += 1;
    stream += `commit refs/heads/main\nmark :${mark}\nauthor ${WHO} ${1772434800 + mark * 60} +0100\ncommitter ${WHO} ${1772434800 + mark * 60} +0100\ndata 20\nMerge von 60 Themen\nfrom :1\n${tips.slice(0, 60).map((tip) => `merge :${tip}\n`).join("")}M 100644 inline basis.txt\ndata 7\nbasis2\n\n`;
    stream = stream.replace("data 20\nMerge von 60 Themen", `data ${Buffer.byteLength("Merge von 60 Themen")}\nMerge von 60 Themen`);
    ws.git(repo, ["fast-import", "--quiet"], { input: Buffer.from(stream, "utf8") });
    ws.git(repo, ["checkout", "-q", "-f", "main"]);
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    let started = Date.now();
    const page = await call(app, "graph_page", { repoId, cursor: null, limit: 2000 });
    note(`graph_page: ${Date.now() - started} ms, ${page.ok ? `${page.value.rows.length} rows, widest lane ${page.value.maxLane}` : page.code}`);
    check(page.ok && page.value.rows.length === 902, `graph_page: ${page.ok ? page.value.rows.length : `${page.code} – ${page.message}`}`);
    if (page.ok) {
      const merge = page.value.rows.find((row) => row.parents.length === 61);
      check(Boolean(merge), "the row of the merge with 61 parents is there");
      const bytes = JSON.stringify(page.value).length;
      note(`response size: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
      check(bytes < 60 * 1024 * 1024, `the graph_page response is ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    await app.settle(60_000);
    await eventually(async () => (await graphDom(app)).length > 5, true, "UI: the graph is up", 30_000);
    const first = await frames();
    const shape = await app.page.evaluate(() => {
      const root = document.querySelector('[data-screen="commit-graph"]');
      const canvas = Array.from(root.querySelectorAll("canvas")).map((item) => ({ width: item.width, height: item.height, css: Math.round(item.getBoundingClientRect().width) }));
      return { overflowPage: document.documentElement.scrollWidth - document.documentElement.clientWidth, canvas, rows: root.querySelectorAll("[data-row-id]").length };
    });
    note(`UI: frames ${first} ms, ${JSON.stringify(shape)}`);
    check(first !== "hung" && first < 1500, `two frames take ${first} ms`);
    equal(shape.overflowPage, 0, "no horizontal page overflow");
    check(shape.canvas.every((item) => item.width <= 16_384 && item.height <= 16_384), `canvas stays below the size at which Chromium stops drawing: ${JSON.stringify(shape.canvas)}`);
    // Scroll through the whole graph
    started = Date.now();
    const scrolled = await Promise.race([
      app.page.evaluate(async () => {
        const scroller = document.querySelector("[data-graph-scroller]");
        let worst = 0;
        for (let step = 0; step < 30; step++) {
          const t0 = performance.now();
          scroller.scrollTop = (scroller.scrollHeight / 30) * step;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          worst = Math.max(worst, performance.now() - t0);
        }
        return Math.round(worst);
      }),
      sleep(60_000).then(() => "hung"),
    ]);
    note(`scrolling: slowest step ${scrolled} ms (total ${Date.now() - started} ms)`);
    check(scrolled !== "hung" && scrolled < 1500, `scrolling in the wide graph: slowest step ${scrolled} ms`);
    // The message column is still visible (the graph does not take the whole width)
    const message = await app.page.evaluate(() => {
      const row = document.querySelector('[data-screen="commit-graph"] [data-row-kind="commit"]');
      return row ? (row.textContent ?? "").replace(/\s+/g, " ").slice(0, 80) : null;
    });
    check(message !== null && /Branch \d+|Basis|Merge/.test(message), `a commit row shows its message: ${JSON.stringify(message)}`);
    void tabId;
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M12 300 stashes: list, graph, applying the oldest, dropping", async () => {
    const ws = ws0("m12");
    const repo = small(ws, "viele-stashes");
    for (let index = 0; index < 300; index++) {
      fs.writeFileSync(path.join(repo, "src", "a.txt"), `a\nmehr\nStash ${index}\n`);
      ws.git(repo, ["stash", "push", "-q", "-m", `Stash Nummer ${index} mit Ümläuten`], { time: ws.tick(1) });
    }
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    let started = Date.now();
    const list = await call(app, "stash_list", { repoId });
    note(`stash_list: ${Date.now() - started} ms`);
    check(list.ok && list.value.length === 300 && list.value[0].message.includes("Stash Nummer 299"), `stash_list: ${list.ok ? `${list.value.length}, first ${JSON.stringify(list.value[0]?.message)}` : `${list.code} – ${list.message}`}`);
    check(Date.now() - started < 15_000, `stash_list takes ${Date.now() - started} ms`);
    started = Date.now();
    const page = await call(app, "graph_page", { repoId, cursor: null, limit: 2000 });
    note(`graph_page with 300 stashes: ${Date.now() - started} ms, ${page.ok ? page.value.rows.filter((row) => row.kind === "stash").length : page.code} stash rows`);
    check(page.ok && page.value.rows.filter((row) => row.kind === "commit" || row.kind === "merge").length === 4, `graph_page shows the four commits (no stash helper commits): ${page.ok ? page.value.rows.filter((row) => row.kind === "commit" || row.kind === "merge").length : page.message}`);
    await app.settle(60_000);
    const frame = await frames();
    check(frame !== "hung" && frame < 1500, `UI with 300 stashes: two frames ${frame} ms`);
    const diff = await call(app, "commit_details", { repoId, source: { kind: "stash", index: 299 } });
    check(diff.ok && diff.value.files.length === 1, `commit_details(oldest stash): ${diff.ok ? diff.value.files.length : `${diff.code} – ${diff.message}`}`);
    const apply = await call(app, "stash_apply", { repoId, index: 299 });
    check(apply.ok && apply.value.status === "done", `stash_apply(oldest): ${apply.ok ? apply.value.status : `${apply.code} – ${apply.message}`}`);
    equal(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "a\nmehr\nStash 0\n", "the oldest stash is applied");
    const drop = await call(app, "stash_drop", { repoId, index: 150 });
    check(drop.ok && drop.value.length === 299, `stash_drop(150): ${drop.ok ? drop.value.length : `${drop.code} – ${drop.message}`}`);
    check(!lines(ws.git(repo, ["stash", "list"])).some((row) => row.includes("Stash Nummer 149 ")), "git: exactly the stash at position 150 (number 149) is dropped");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M13 repository opened through a link (junction): one entry, watching, core loop", async () => {
    const ws = ws0("m13");
    const repo = small(ws, "echt");
    const link = path.join(ws.root, "verknüpfung");
    const made = spawnSync("cmd", ["/c", "mklink", "/J", link, repo], { encoding: "utf8", windowsHide: true });
    if (!check(made.status === 0, `fixture: mklink /J fails: ${made.stdout}${made.stderr}`)) return;
    write(repo, "README.md", "# Klein\ngeändert\n");
    const viaLink = await call(app, "repo_open", { path: link });
    if (!check(viaLink.ok, `repo_open(junction) fails: ${viaLink.code} – ${viaLink.message}`)) return;
    const real = await call(app, "repo_open", { path: repo });
    check(real.ok, `repo_open(real path) fails: ${real.code} – ${real.message}`);
    note(`paths: through the link ${viaLink.value.repo.path}; direct ${real.ok ? real.value.repo.path : "-"}; same entry: ${real.ok && real.value.repo.id === viaLink.value.repo.id}`);
    const repoId = viaLink.value.repo.id;
    const status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.unstaged.length === 1, `status_get through the link: ${status.ok ? status.value.unstaged.length : `${status.code} – ${status.message}`}`);
    const events = await app.recordEvents(["repo:changed"]);
    write(repo, "neu.txt", "x\n");
    await events.waitFor("repo:changed", 15_000).catch(() => undefined);
    const got = await events.take();
    await events.stop();
    check(got.some((event) => event.payload?.repoId === repoId), `repo:changed for the entry opened through the link (${got.length} events)`);
    const commit = await call(app, "commit_create", { ...commitArgs(repoId, "Commit über die Verknüpfung"), stageAll: true });
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    if (real.ok && real.value.repo.id !== repoId) {
      // Two entries for the same repository: both must show the same state
      const other = await call(app, "refs_list", { repoId: real.value.repo.id });
      equal(other.ok ? other.value.head.sha : null, ws.git(repo, ["rev-parse", "HEAD"]), "the second entry knows the new HEAD");
      await closeRepo(app, { repoId: real.value.repo.id, tabId: real.value.tab.id });
    }
    await closeRepo(app, { repoId, tabId: viaLink.value.tab.id });
    fs.rmdirSync(link);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M14 partial clone (without blobs): core loop, an old commit can be viewed", async () => {
    const ws = ws0("m14");
    const origin = small(ws, "quelle");
    ws.git(origin, ["config", "uploadpack.allowFilter", "true"]);
    ws.git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const repo = path.join(ws.root, "ohne-blobs");
    const cloned = ws.tryGit(ws.root, ["clone", "-q", "--filter=blob:none", `file://${slash(origin)}`, repo]);
    if (!check(cloned.ok, `fixture: partial clone fails: ${cloned.out}`)) return;
    ws.git(repo, ["config", "user.name", "Lena Hartmann"]);
    ws.git(repo, ["config", "user.email", "lena.hartmann@wetterstation.example"]);
    write(repo, "README.md", "# Klein\nim Partial Clone\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit im Partial Clone" });
    const { repoId } = seen.opened;
    const old = ws.git(repo, ["rev-parse", "origin/main~1"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: old } });
    check(details.ok, `commit_details(old commit, blobs missing locally) fails: ${details.code} – ${details.message}`);
    const diff = await call(app, "diff_file", { repoId, path: "src/a.txt", source: { kind: "commit", sha: old } });
    check(diff.ok && diff.value.kind === "text", `diff_file(old commit): ${diff.ok ? diff.value.kind : `${diff.code} – ${diff.message}`}`);
    const blame = await call(app, "file_blame", { repoId, path: "src/a.txt", sha: null });
    check(blame.ok, `file_blame fails: ${blame.code} – ${blame.message}`);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("M15 script in file content, README, branch, tag and file names is never executed", async () => {
    const ws = ws0("m15");
    const repo = ws.init("skripte");
    const payload = (id) => `<img src=x onerror="window.__l2Xss='${id}'"><script>window.__l2Xss='${id}-script'</script><svg onload="window.__l2Xss='${id}-svg'"></svg>`;
    write(repo, "README.md", `# Titel ${payload("readme-titel")}\n\n${payload("readme")}\n\n[klick](javascript:window.__l2Xss='link')\n\n<a href="javascript:window.__l2Xss='a'">a</a>\n\n<iframe srcdoc="<script>parent.__l2Xss='iframe'</script>"></iframe>\n`);
    write(repo, "seite.html", `${payload("html")}\n`);
    write(repo, `datei ${"<img src=x onerror=window.__l2Xss=1>".replace(/[<>]/g, (char) => (char === "<" ? "‹" : "›"))}.txt`, "x\n");
    write(repo, "<img src=x onerror=window.__l2Xss='name'>.txt".replace(/[<>]/g, ""), "x\n");
    ws.commit(repo, `Commit ${payload("message")}`);
    ws.git(repo, ["update-ref", "refs/heads/<img/src=x/onerror=window.__l2Xss='branch'>".replace(/[<>]/g, ""), "HEAD"]);
    ws.tryGit(repo, ["update-ref", "refs/tags/x'onmouseover='window.__l2Xss=1", "HEAD"]);
    ws.git(repo, ["tag", "-a", "annotiert", "-m", payload("annotation")]);
    write(repo, "seite.html", `${payload("html")}\nfür den Stash\n`);
    ws.git(repo, ["stash", "push", "-q", "-m", payload("stash")]);
    write(repo, "seite.html", `${payload("html")}\n${payload("html-neu")}\n`);
    write(repo, "README.md", `${fs.readFileSync(path.join(repo, "README.md"), "utf8")}\n${payload("readme-neu")}\n`);
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    await app.settle(30_000);
    await selectWip(app, tabId);
    for (const rel of ["seite.html", "README.md"]) {
      await app.page.locator(`[data-section="unstaged"] [data-row-key=${JSON.stringify(rel)}]`).click();
      await app.settle();
      await sleep(300);
      for (const mode of [/Whole file/, /Side by side/, /^Hunks/]) {
        await app.page.locator('[data-screen="diff"]').getByRole("radio", { name: mode }).first().click().catch(() => undefined);
        await sleep(250);
      }
    }
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    await selectCommit(app, tabId, head);
    await sleep(400);
    for (const [command, args] of [["repo_readme", { repoId }], ["file_blame", { repoId, path: "README.md", sha: null }], ["file_history", { repoId, path: "README.md", limit: 5 }], ["commit_search", { repoId, query: "onerror", limit: 5 }], ["stash_list", { repoId }]]) {
      const result = await call(app, command, args);
      check(result.ok, `${command} fails: ${result.code} – ${result.message}`);
    }
    // The README preview of the management view (repo-management) and the Markdown preview of the file view
    await app.page.evaluate(([tab]) => window.__gc.store.getState().openFile?.(tab, "README.md"), [tabId]).catch(() => undefined);
    await sleep(800);
    await app.page.keyboard.press("Control+t");
    await sleep(1200);
    await app.page.keyboard.press("Control+w");
    await sleep(500);
    equal(await app.page.evaluate(() => window.__l2Xss ?? null), null, "no injected script was executed");
    const injected = await app.page.evaluate(() => ({ scripts: Array.from(document.querySelectorAll("script")).filter((node) => (node.textContent ?? "").includes("__l2Xss")).length, handlers: document.querySelectorAll("[onerror], [onload], [onmouseover]").length, iframes: document.querySelectorAll("iframe").length }));
    equal(injected, { scripts: 0, handlers: 0, iframes: 0 }, "no injected element in the DOM");
    app.consoleErrors.length = 0;
    await closeRepo(app, opened);
  });
} catch (error) {
  t.check(false, `script aborted: ${error?.stack ?? error}`);
} finally {
  await app?.close().catch(() => undefined);
  for (const ws of spaces) ws.cleanup();
}
await sleep(50);
process.exit(t.finish());
