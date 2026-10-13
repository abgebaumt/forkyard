/**
 * Difficult repositories, part 3: REPOSITORY LAYOUT AND HISTORY – in the real app, against real git.
 *
 *   node scripts/e2e/flows/hard-repos-structure.mjs [--show] [--only <part>[,<part>]]
 *
 *   S1  opened in a subfolder              S2  bare repository
 *   S3  worktree                           S4  .git as a file (gitdir, separate Git directory)
 *   S5  shallow clone                      S6  repository without commits
 *   S7  orphan branch (two roots)          S8  octopus merge (three and eight parents)
 *   S9  commit without message, with 10,000 characters, with special characters
 *   file-view dates 1970, 2100, beyond 2106; unusual time zones
 *   file-history author without email, without name, with a very long name
 *   blame 2000 branches and 5000 tags
 *   conflict branch names: slashes, umlauts, shared prefixes, "HEAD", local branch "origin/main"
 *   rebase tag and branch with the same name: checkout, merge, push, delete mean the branch
 *   stash-form detached HEAD
 *   command-palette damaged ref (empty, garbage, pointer to a missing object)
 *   commit-search missing object (blob, tree, commit)
 *   terminal submodules: initialized, uninitialized, missing commit, without an entry in .gitmodules
 *
 * At the end there is a list of green and red sections. Red sections with "BUG L2-…" are the tests
 * the respective bug is fixed against.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { bugShot, healthy, call, closeRepo, coreLoop, coreStatusPaths, createRun, gitStatus, graphDom, lines, sorted, toasts, wipRows, workspace, write, zlist, selectWip, selectCommit, sleep } from "./hard-repos-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("hard-repos-structure", { argv });
const { check, equal, eventually, note } = t;
/** Before each section: if the UI crashed (empty window), a fresh instance is started. */
async function ensureApp() {
  if (app && (await healthy(app))) return;
  if (app) {
    console.log("  · the UI no longer responds – new instance");
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
const data = (text) => `data ${Buffer.byteLength(text)}\n${text}`;
const commitArgs = (repoId, summary) => ({ repoId, opId: `l2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, summary, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
const slash = (file) => file.replaceAll("\\", "/");
const samePath = (a, b) => path.resolve(a).replaceAll("\\", "/").toLowerCase() === path.resolve(b).replaceAll("\\", "/").toLowerCase();

/** Small repository with three commits on main and a side branch. */
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

/** Graph rows from the core (without WIP and stash). */
async function graphRows(repoId, limit = 2000) {
  const page = await call(app, "graph_page", { repoId, cursor: null, limit });
  return page.ok ? page.value.rows.filter((row) => row.kind === "commit" || row.kind === "merge") : page;
}

try {

  // ---------------------------------------------------------------------------------------------
  await section("S1 Repository opened in a subfolder: it opens the root, paths are root-relative", async () => {
    const ws = ws0("s1");
    const repo = small(ws);
    write(repo, "src/tief/unten/datei.txt", "tief\n");
    write(repo, "README.md", "# Klein\nund mehr\n");
    const sub = path.join(repo, "src", "tief", "unten");
    const opened = await call(app, "repo_open", { path: sub });
    if (!check(opened.ok, `repo_open(subfolder) fails: ${opened.code} ${opened.message}`)) return;
    check(samePath(opened.value.repo.path, repo), `the repository root is opened (got ${opened.value.repo.path})`);
    equal(opened.value.repo.name, "klein", "tab name is the repository folder");
    const repoId = opened.value.repo.id;
    const status = await call(app, "status_get", { repoId });
    if (check(status.ok, `status_get fails: ${status.code} ${status.message}`)) equal(coreStatusPaths(status.value), gitStatus(ws, repo), "status root-relative as in git status");
    const stage = await call(app, "stage_paths", { repoId, paths: ["src/tief/unten/datei.txt"] });
    check(stage.ok, `stage_paths fails: ${stage.code} ${stage.message}`);
    // The same folder again via the root: the same entry, no second tab.
    const again = await call(app, "repo_open", { path: repo });
    check(again.ok && again.value.repo.id === repoId && again.value.tab.id === opened.value.tab.id, "opening via the root lands in the same entry and tab");
    await closeRepo(app, { repoId, tabId: opened.value.tab.id });
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-09: A bare repository is refused with "… is not a Git repository. Choose the folder that contains
  // the .git subfolder, or create a new repository there." That is wrong – it IS a repository, just without
  // a working tree – and the advice to create one there is wrong.
  await section("S2 Bare repository: can be viewed (graph, commit, diff) or is refused clearly", async () => {
    const ws = ws0("s2");
    const repo = small(ws);
    const bare = path.join(ws.root, "klein.git");
    ws.git(ws.root, ["clone", "-q", "--bare", repo, bare]);
    const opened = await call(app, "repo_open", { path: bare });
    note(`repo_open(bare): ${opened.ok ? "opened" : `${opened.code} – ${opened.message}`}`);
    if (!opened.ok) {
      check(opened.code !== "unknown" && /bare|working (tree|directory)|work tree/i.test(opened.message), `the refusal names the reason (bare, no working tree): ${opened.code} – ${opened.message}`);
      check(!/not a Git repository/i.test(opened.message), `the message does not claim it is not a Git repository: ${opened.message}`);
      // The same path through the UI (Alt+O), for the bug screenshot.
      await app.pick(bare);
      await app.page.keyboard.press("Alt+o");
      await eventually(async () => (await toasts(app)).length > 0, true, "UI: toast after opening");
      const shown = (await toasts(app)).map((toast) => toast.text).join(" | ");
      check(!/create a new repository/i.test(shown), `UI does not advise creating a new repository inside the bare repository: ${JSON.stringify(shown)}`);
      await bugShot(app);
      return;
    }
    const repoId = opened.value.repo.id;
    await app.settle(30_000);
    const rows = await graphRows(repoId);
    check(Array.isArray(rows) && rows.length === 4, `graph shows the four commits: ${Array.isArray(rows) ? rows.length : `${rows.code} ${rows.message}`}`);
    const head = ws.git(bare, ["rev-parse", "HEAD"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    check(details.ok && details.value.files.length === 1, `commit_details: ${details.ok ? details.value.files.length : `${details.code} ${details.message}`}`);
    const diff = await call(app, "diff_file", { repoId, path: "src/a.txt", source: { kind: "commit", sha: head } });
    check(diff.ok && diff.value.kind === "text", `diff_file: ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`);
    const status = await call(app, "status_get", { repoId });
    note(`status_get(bare): ${status.ok ? `ok, ${status.value.unstaged.length}/${status.value.staged.length}` : `${status.code} – ${status.message}`}`);
    check(status.ok || status.code !== "unknown", `status_get(bare) answers clearly: ${status.code} – ${status.message}`);
    const refs = await call(app, "refs_list", { repoId });
    check(refs.ok && refs.value.locals.length === 2, `refs_list: ${refs.ok ? refs.value.locals.length : `${refs.code} ${refs.message}`}`);
    // Write actions that need a working tree refuse clearly – nothing breaks.
    const checkout = await call(app, "branch_checkout", { repoId, target: "seite" });
    note(`branch_checkout(bare): ${checkout.ok ? "ok" : `${checkout.code} – ${checkout.message}`}`);
    check(checkout.ok || checkout.code !== "unknown", `branch_checkout(bare) answers clearly: ${checkout.code} – ${checkout.message}`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "geht nicht"));
    check(!commit.ok && commit.code !== "unknown", `commit_create(bare): ${commit.ok ? "committed" : `${commit.code} – ${commit.message}`}`);
    equal(ws.git(bare, ["rev-list", "--all", "--count"]), "4", "git: the bare repository is unchanged");
    const shown = (await toasts(app)).filter((toast) => toast.tone === "danger");
    note(`error toasts in the UI: ${JSON.stringify(shown)}`);
    await closeRepo(app, { repoId, tabId: opened.value.tab.id });
  }, { bug: "L2-09" });

  // ---------------------------------------------------------------------------------------------
  await section("S3 Worktree: core loop in the worktree, the other worktree's branch is locked", async () => {
    const ws = ws0("s3");
    const repo = small(ws);
    const tree = path.join(ws.root, "zweiter baum ü");
    ws.git(repo, ["worktree", "add", "-q", tree, "seite"]);
    write(tree, "src/b.txt", "b\nim Worktree geändert\n");
    write(tree, "neu im worktree.txt", "neu\n");
    const seen = await coreLoop(t, app, ws, tree, { summary: "Commit aus dem Worktree" });
    equal(ws.git(repo, ["log", "-1", "--format=%s", "seite"]), "Commit aus dem Worktree", "git: the commit is on the worktree's branch");
    const { repoId } = seen.opened;
    const list = await call(app, "worktree_list", { repoId });
    check(list.ok && list.value.length === 2 && list.value.some((entry) => entry.isCurrent && samePath(entry.path, tree)), `worktree_list: ${list.ok ? JSON.stringify(list.value.map((entry) => [entry.path, entry.isCurrent, entry.isMain])) : `${list.code} ${list.message}`}`);
    // main is checked out in the main worktree: switching to it is refused, with a reason.
    const blocked = await call(app, "branch_checkout", { repoId, target: "main" });
    check(!blocked.ok && blocked.code !== "unknown" && /Worktree/i.test(blocked.message), `branch_checkout(main in the worktree): ${blocked.ok ? "switched" : `${blocked.code} – ${blocked.message}`}`);
    equal(ws.git(tree, ["symbolic-ref", "--short", "HEAD"]), "seite", "git: the worktree stays on its branch");
    // Open the main repository alongside: the two statuses are separate
    write(repo, "nur im haupt.txt", "x\n");
    const main = await app.openRepo(repo);
    const mainStatus = await call(app, "status_get", { repoId: main.repoId });
    check(mainStatus.ok && mainStatus.value.unstaged.map((file) => file.path).join() === "nur im haupt.txt", `status of the main worktree: ${mainStatus.ok ? JSON.stringify(mainStatus.value.unstaged.map((file) => file.path)) : mainStatus.message}`);
    const treeStatus = await call(app, "status_get", { repoId });
    check(treeStatus.ok && treeStatus.value.unstaged.length === 0, `status of the worktree stays empty: ${treeStatus.ok ? JSON.stringify(treeStatus.value.unstaged.map((file) => file.path)) : treeStatus.message}`);
    check(main.repoId !== repoId, "main repository and worktree are two entries");
    await closeRepo(app, main);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("S4 .git as a file (separate Git directory): core loop", async () => {
    const ws = ws0("s4");
    const repo = path.join(ws.root, "arbeitsordner");
    const gitDir = path.join(ws.root, "woanders", "daten.git");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    ws.git(repo, ["init", "-q", "-b", "main", `--separate-git-dir=${gitDir}`]);
    ws.git(repo, ["config", "user.name", "Lena Hartmann"]);
    ws.git(repo, ["config", "user.email", "lena.hartmann@wetterstation.example"]);
    check(fs.statSync(path.join(repo, ".git")).isFile(), "fixture: .git is a file");
    write(repo, "a.txt", "a\n");
    ws.commit(repo, "Erster");
    write(repo, "a.txt", "a\nb\n");
    write(repo, "neu.txt", "neu\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit mit getrenntem Git-Verzeichnis" });
    const { repoId } = seen.opened;
    // Stash, undo and discard need the Git directory for backups
    write(repo, "a.txt", "a\nb\nc\n");
    const discard = await call(app, "discard_paths", { repoId, paths: ["a.txt"] });
    check(discard.ok, `discard_paths fails: ${discard.code} ${discard.message}`);
    const undo = await call(app, "undo", { repoId });
    check(undo.ok, `undo fails: ${undo.code} ${undo.message}`);
    equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "a\nb\nc\n", "undo brings the discarded change back");
    // File watching: a change in the Git directory (commit from outside) arrives
    const events = await app.recordEvents(["repo:changed"]);
    ws.git(repo, ["commit", "-q", "-am", "Commit von außen"]);
    await events.waitFor("repo:changed", 15_000).catch(() => undefined);
    const got = await events.take();
    await events.stop();
    check(got.length > 0, "repo:changed after a commit from outside (Git directory is elsewhere)");
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("S5 Shallow clone (depth 2): core loop, view the boundary commit", async () => {
    const ws = ws0("s5");
    const origin = small(ws, "quelle");
    for (let index = 0; index < 6; index++) {
      write(origin, "src/a.txt", `a\nmehr\n${"x\n".repeat(index + 1)}`);
      ws.commit(origin, `Weiterer Commit ${index + 1}`);
    }
    const repo = path.join(ws.root, "flach");
    ws.git(ws.root, ["clone", "-q", "--depth", "2", `file://${slash(origin)}`, repo]);
    ws.git(repo, ["config", "user.name", "Lena Hartmann"]);
    ws.git(repo, ["config", "user.email", "lena.hartmann@wetterstation.example"]);
    equal(ws.git(repo, ["rev-parse", "--is-shallow-repository"]), "true", "fixture: shallow clone");
    write(repo, "src/a.txt", "a\nlokal geändert\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit in the shallow clone" });
    const { repoId } = seen.opened;
    const rows = await graphRows(repoId);
    if (check(Array.isArray(rows), `graph_page: ${rows.code} ${rows.message}`)) {
      const boundary = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]).split(/\r?\n/);
      const shallow = lines(fs.readFileSync(path.join(repo, ".git", "shallow"), "utf8"));
      note(`boundary commit: ${shallow.join(", ")}; rows in the graph: ${rows.length}`);
      for (const sha of shallow) {
        const row = rows.find((entry) => entry.sha === sha);
        check(Boolean(row), `the boundary commit ${sha.slice(0, 7)} is in the graph`);
        const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha } });
        check(details.ok, `commit_details(boundary commit) fails: ${details.code} ${details.message}`);
        if (details.ok) {
          for (const file of details.value.files.slice(0, 5)) {
            const diff = await call(app, "diff_file", { repoId, path: file.path, source: { kind: "commit", sha } });
            check(diff.ok, `diff_file(boundary commit, ${file.path}) fails: ${diff.code} ${diff.message}`);
          }
        }
      }
      void boundary;
    }
    // Search, history and blame end at the boundary, without errors
    const history = await call(app, "file_history", { repoId, path: "src/a.txt", limit: 50 });
    check(history.ok && history.value.length >= 2, `file_history in the shallow clone: ${history.ok ? history.value.length : `${history.code} ${history.message}`}`);
    const blame = await call(app, "file_blame", { repoId, path: "src/a.txt", sha: null });
    check(blame.ok, `file_blame in the shallow clone fails: ${blame.code} ${blame.message}`);
    const search = await call(app, "commit_search", { repoId, query: "Weiterer", limit: 50 });
    check(search.ok, `commit_search in the shallow clone fails: ${search.code} ${search.message}`);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("S6 Repository without commits: first commit; creating a branch before that is refused clearly", async () => {
    const ws = ws0("s6");
    const repo = ws.init("ganz-neu");
    write(repo, "erste.txt", "erste\n");
    write(repo, "ordner/zweite.txt", "zweite\n");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const refs = await call(app, "refs_list", { repoId });
    check(refs.ok && refs.value.head.kind === "unborn" && refs.value.head.branch === "main", `HEAD \"unborn\": ${refs.ok ? JSON.stringify(refs.value.head) : refs.message}`);
    const page = await call(app, "graph_page", { repoId, cursor: null, limit: 500 });
    check(page.ok && page.value.rows.every((row) => row.kind === "wip"), `graph without commits: ${page.ok ? JSON.stringify(page.value.rows.map((row) => row.kind)) : `${page.code} ${page.message}`}`);
    for (const [command, args] of [
      ["branch_create", { repoId, name: "neu", start: null, checkout: true }],
      ["tag_create", { repoId, name: "v0", sha: null, message: null }],
      ["stash_create", { repoId, opId: "l2-s6", message: null, paths: null, includeUntracked: true }],
      ["commit_search", { repoId, query: "x", limit: 10 }],
      ["file_history", { repoId, path: "erste.txt", limit: 10 }],
      ["file_blame", { repoId, path: "erste.txt", sha: null }],
      ["undo_peek", { repoId }],
      ["stash_list", { repoId }],
      ["worktree_list", { repoId }],
      ["submodule_list", { repoId }],
      ["tree_list", { repoId, sha: null, filter: null }],
      ["rebase_plan", { repoId, base: "main" }],
    ]) {
      const result = await call(app, command, args);
      check(result.ok || result.code !== "unknown", `${command} in a repository without commits: ${result.code} – ${result.message}`);
      if (!result.ok) note(`${command}: ${result.code} – ${result.message}`);
    }
    equal(sorted(lines(ws.git(repo, ["for-each-ref", "--format=%(refname)"]))), [], "git: no ref was created");
    const diff = await call(app, "diff_file", { repoId, path: "erste.txt", source: { kind: "unstaged" } });
    check(diff.ok && diff.value.kind === "text", `diff_file(untracked): ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`);
    const stage = await call(app, "stage_paths", { repoId, paths: ["erste.txt"] });
    check(stage.ok, `stage_paths fails: ${stage.code} ${stage.message}`);
    const staged = await call(app, "diff_file", { repoId, path: "erste.txt", source: { kind: "staged" } });
    check(staged.ok && staged.value.kind === "text" && staged.value.hunks.length === 1, `diff_file(staged, before the first commit): ${staged.ok ? staged.value.kind : `${staged.code} ${staged.message}`}`);
    const un = await call(app, "unstage_paths", { repoId, paths: ["erste.txt"] });
    check(un.ok, `unstage_paths before the first commit fails: ${un.code} ${un.message}`);
    equal(ws.git(repo, ["ls-files"]), "", "git: index empty again");
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok, `stage_paths(all) fails: ${all.code} ${all.message}`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "Allererster Commit"));
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(ws.git(repo, ["log", "--format=%s"]), "Allererster Commit", "git: the first commit exists");
    // Amend the root commit and undo it
    write(repo, "dritte.txt", "dritte\n");
    const amend = await call(app, "commit_create", { ...commitArgs(repoId, "Allererster Commit, ergänzt"), amend: true, stageAll: true });
    check(amend.ok, `amend of the root commit fails: ${amend.code} ${amend.message}`);
    equal(ws.git(repo, ["rev-list", "--count", "HEAD"]), "1", "git: still one commit");
    const undo = await call(app, "undo", { repoId });
    check(undo.ok, `undo(amend of the root commit) fails: ${undo.code} ${undo.message}`);
    equal(ws.git(repo, ["log", "--format=%s"]), "Allererster Commit", "git: undo restores the first commit");
    // Undo the only commit (undo of the very first commit)
    await closeRepo(app, opened);
    void tabId;
  });

  // ---------------------------------------------------------------------------------------------
  await section("S7 Orphan branch (two roots): graph shows both, merge without common history reports clearly", async () => {
    const ws = ws0("s7");
    const repo = small(ws);
    ws.git(repo, ["checkout", "-q", "--orphan", "gh-pages"]);
    ws.git(repo, ["rm", "-rfq", "."]);
    write(repo, "index.html", "<h1>Seite</h1>\n");
    ws.commit(repo, "Erste Seite (eigene Wurzel)");
    write(repo, "index.html", "<h1>Seite</h1>\n<p>mehr</p>\n");
    ws.commit(repo, "Seite ergänzt");
    ws.git(repo, ["checkout", "-q", "main"]);
    write(repo, "README.md", "# Klein\ngeändert\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit neben einer zweiten Wurzel" });
    const { repoId } = seen.opened;
    const rows = await graphRows(repoId);
    if (Array.isArray(rows)) equal(rows.filter((row) => row.parents.length === 0).length, 2, "graph: two root commits");
    const merge = await call(app, "merge_start", { repoId, source: "gh-pages", mode: "default" });
    note(`merge_start(no common history): ${merge.ok ? JSON.stringify(merge.value) : `${merge.code} – ${merge.message}`}`);
    check(!merge.ok && merge.code !== "unknown" && /histor(y|ies)|common|unrelated/i.test(merge.message), `merge without common history: ${merge.ok ? "merged" : `${merge.code} – ${merge.message}`}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: nothing is started after the refused merge");
    const rebase = await call(app, "rebase_start", { repoId, onto: "gh-pages", branch: null });
    note(`rebase_start(onto the other root): ${rebase.ok ? rebase.value.status : `${rebase.code} – ${rebase.message}`}`);
    const op = await call(app, "status_get", { repoId });
    if (op.ok && op.value.operation) {
      const abort = await call(app, "operation_abort", { repoId });
      check(abort.ok, `operation_abort fails: ${abort.code} ${abort.message}`);
    } else if (rebase.ok) {
      const undo = await call(app, "undo", { repoId });
      check(undo.ok, `undo(Rebase) fails: ${undo.code} ${undo.message}`);
    }
    const plan = await call(app, "rebase_plan", { repoId, base: "gh-pages" });
    check(plan.ok && (plan.value.status === "refused" || plan.value.status === "ok"), `rebase_plan(other root): ${plan.ok ? plan.value.status : `${plan.code} ${plan.message}`}`);
    // Compare two commits without common history
    const other = ws.git(repo, ["rev-parse", "gh-pages"]);
    const range = await call(app, "commit_details", { repoId, source: { kind: "range", from: other, to: ws.git(repo, ["rev-parse", "main"]) } });
    check(range.ok, `commit_details(compare across two roots) fails: ${range.code} ${range.message}`);
    const co = await call(app, "branch_checkout", { repoId, target: "gh-pages" });
    check(co.ok, `branch_checkout(gh-pages) fails: ${co.code} ${co.message}`);
    equal(sorted(fs.readdirSync(repo).filter((entry) => entry !== ".git")), ["index.html"], "working tree of the orphan branch");
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("S8 Octopus merge (three and eight parents): graph, parents, diff, revert reports clearly", async () => {
    const ws = ws0("s8");
    const repo = ws.init("octopus");
    write(repo, "basis.txt", "basis\n");
    ws.commit(repo, "Basis");
    const arms = [];
    for (let index = 1; index <= 9; index++) {
      ws.git(repo, ["checkout", "-q", "-b", `arm-${index}`, "main"]);
      write(repo, `arm-${index}.txt`, `arm ${index}\n`);
      ws.commit(repo, `Arm ${index}`);
      arms.push(`arm-${index}`);
    }
    ws.git(repo, ["checkout", "-q", "main"]);
    ws.git(repo, ["merge", "-q", "--no-ff", "-m", "Octopus: zwei Arme auf einmal", "arm-1", "arm-2"], { time: ws.tick() });
    const three = ws.git(repo, ["rev-parse", "HEAD"]);
    ws.git(repo, ["merge", "-q", "--no-ff", "-m", "Octopus: sieben Arme auf einmal", ...arms.slice(2)], { time: ws.tick() });
    const eight = ws.git(repo, ["rev-parse", "HEAD"]);
    equal(ws.git(repo, ["rev-list", "--parents", "-n", "1", three]).split(" ").length - 1, 3, "fixture: three parents");
    equal(ws.git(repo, ["rev-list", "--parents", "-n", "1", eight]).split(" ").length - 1, 8, "fixture: eight parents");
    write(repo, "basis.txt", "basis\nnach dem Octopus\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit nach dem Octopus" });
    const { repoId, tabId } = seen.opened;
    const rows = await graphRows(repoId);
    if (Array.isArray(rows)) {
      for (const [sha, count] of [[three, 3], [eight, 8]]) {
        const row = rows.find((entry) => entry.sha === sha);
        check(row?.kind === "merge" && row.parents.length === count, `graph row of the octopus with ${count} parents: ${row ? `${row.kind}, ${row.parents.length} parents` : "missing"}`);
        const starting = row?.edges.filter((edge) => edge.top === null).length;
        check(starting === count, `graph: ${count} lines go down from the node (got ${starting})`);
      }
    }
    for (const [sha, count, files] of [[three, 3, ["arm-1.txt"]], [eight, 8, ["arm-3.txt"]]]) {
      const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha } });
      if (!check(details.ok, `commit_details(Octopus ${count}) fails: ${details.code} ${details.message}`)) continue;
      equal(details.value.commit.parents.length, count, `commit details: ${count} parents`);
      // Against the first parent: everything the other arms bring in
      const want = sorted(lines(ws.git(repo, ["diff", "--name-only", `${sha}^1`, sha])));
      equal(sorted(details.value.files.map((file) => file.path)), want, `files of the octopus (${count}) against the first parent`);
      void files;
    }
    await selectCommit(app, tabId, eight);
    await eventually(async () => (await app.page.locator('[data-screen="commit-details"]').innerText()).includes("Octopus: sieben Arme"), true, "UI: commit details of the octopus");
    const text = (await app.page.locator('[data-screen="commit-details"]').innerText()).replace(/\s+/g, " ");
    const parents = ws.git(repo, ["rev-list", "--parents", "-n", "1", eight]).split(" ").slice(1);
    const shownParents = parents.filter((sha) => text.includes(sha.slice(0, 7)));
    check(shownParents.length === 8, `UI: all eight parents are listed (${shownParents.length} found)`);
    const revert = await call(app, "revert_commit", { repoId, sha: three });
    note(`revert_commit(Octopus): ${revert.ok ? revert.value.status : `${revert.code} – ${revert.message}`}`);
    check(revert.ok || revert.code !== "unknown", `revert of a merge commit answers clearly: ${revert.code} – ${revert.message}`);
    const pick = await call(app, "cherry_pick", { repoId, shas: [eight] });
    note(`cherry_pick(Octopus): ${pick.ok ? pick.value.status : `${pick.code} – ${pick.message}`}`);
    check(pick.ok || pick.code !== "unknown", `cherry-pick of a merge commit answers clearly: ${pick.code} – ${pick.message}`);
    const state = await call(app, "status_get", { repoId });
    check(state.ok && state.value.operation === null, `no operation running afterwards: ${state.ok ? JSON.stringify(state.value.operation) : state.message}`);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  const ODD_MESSAGES = [
    ["empty", ""],
    ["spaces only", "   "],
    ["newlines only", "\n\n\n"],
    ["10,000 characters in one line", `${"Sehr-lange-Zusammenfassung ".repeat(371)}Ende`.slice(0, 10_000)],
    ["10,000 characters without spaces", "x".repeat(10_000)],
    ["HTML", '<script>window.__l2Msg=1</script><img src=x onerror="window.__l2Msg=2"> <b>fett</b>'],
    ["emoji and RTL", "🚀🌦️ ‮umgekehrt‬ عربى 日本語"],
    ["control characters", "Tab\there, Glocke\u0007, ESC\u001b[31mrot\u001b[0m, CR\rmittendrin"],
    ["leading blank lines", "\n\nSumme nach zwei Leerzeilen\n\nund eine Beschreibung"],
    ["CRLF", "Summe mit CRLF\r\n\r\nBeschreibung mit CRLF\r\nzweite Zeile\r\n"],
    ["description 200,000 characters", `Kurze Summe\n\n${"Sehr lange Beschreibung mit vielen Wörtern. ".repeat(4600)}`],
  ];
  await section("S9 Commit messages: empty, 10,000 characters, HTML, control characters – graph, details, search, amend", async () => {
    const ws = ws0("s9");
    const repo = ws.init("messages");
    let stream = "";
    let mark = 0;
    for (const [, message] of ODD_MESSAGES) {
      mark += 1;
      const body = `Datei ${mark}\n`;
      stream += `commit refs/heads/main\nmark :${mark}\nauthor ${WHO} ${1772434800 + mark * 600} +0100\ncommitter ${WHO} ${1772434800 + mark * 600} +0100\n${data(message)}\n${mark > 1 ? `from :${mark - 1}\n` : ""}M 100644 inline datei-${mark}.txt\n${data(body)}\n`;
    }
    ws.git(repo, ["fast-import", "--quiet"], { input: Buffer.from(stream, "utf8") });
    ws.git(repo, ["checkout", "-q", "-f", "main"]);
    const shas = lines(ws.git(repo, ["rev-list", "--reverse", "main"]));
    write(repo, "neu.txt", "neu\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Gewöhnlicher Commit danach", headFiles: false });
    const { repoId, tabId } = seen.opened;
    const rows = await graphRows(repoId);
    if (check(Array.isArray(rows), `graph_page: ${rows.code} ${rows.message}`)) {
      for (const [index, [label, message]] of ODD_MESSAGES.entries()) {
        const row = rows.find((entry) => entry.sha === shas[index]);
        const subject = ws.git(repo, ["log", "-1", "--format=%s", shas[index]]);
        if (!check(Boolean(row), `graph: row for "${label}" missing`)) continue;
        check(row.summary === subject, `graph summary "${label}" as in git %s: expected ${JSON.stringify(subject.slice(0, 80))}…(${subject.length}), got ${JSON.stringify(row.summary.slice(0, 80))}…(${row.summary.length})`);
        const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: shas[index] } });
        if (!check(details.ok, `commit_details("${label}") fails: ${details.code} ${details.message}`)) continue;
        const body = ws.git(repo, ["log", "-1", "--format=%b", shas[index]]);
        check(details.value.commit.summary === subject, `details summary "${label}" as in git`);
        check(details.value.commit.description.trim() === body.trim(), `details description "${label}" as in git %b (${details.value.commit.description.length} vs ${body.length} characters)`);
        void message;
      }
    }
    // UI: every row stays one row, nothing overflows, no script runs
    await app.settle();
    const dom = await app.page.evaluate(() => {
      const list = Array.from(document.querySelectorAll('[data-screen="commit-graph"] [data-row-id]'));
      return { heights: [...new Set(list.map((row) => Math.round(row.getBoundingClientRect().height)))], overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, count: list.length };
    });
    equal(dom.heights.length, 1, `UI: all ${dom.count} graph rows have the same height (${JSON.stringify(dom.heights)})`);
    equal(dom.overflow, 0, "UI: no horizontal overflow");
    for (const index of [0, 3, 4, 5, 7, 10]) {
      await selectCommit(app, tabId, shas[index]);
      await sleep(200);
      const panel = await app.page.evaluate(() => {
        const root = document.querySelector('[data-screen="commit-details"]');
        return { overflow: root ? root.scrollWidth - root.clientWidth : null, page: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: (root?.innerText ?? "").replace(/\s+/g, " ").slice(0, 120) };
      });
      check(panel.overflow !== null && panel.overflow <= 1 && panel.page === 0, `UI: commit details "${ODD_MESSAGES[index][0]}" without overflow (${JSON.stringify(panel)})`);
      if (index === 0) note(`commit details of a commit without message: ${JSON.stringify(panel.text)}`);
    }
    equal(await app.page.evaluate(() => window.__l2Msg ?? null), null, "no script from a commit message was executed");
    const graphText = (await graphDom(app)).find((row) => row.id === shas[0])?.text ?? null;
    note(`graph row of the commit without message: ${JSON.stringify(graphText)}`);
    // Search finds the long message; search for HTML
    const search = await call(app, "commit_search", { repoId, query: "Sehr-lange-Zusammenfassung", limit: 20 });
    check(search.ok && search.value.some((hit) => hit.sha === shas[3]), `commit_search finds the commit with 10,000 characters: ${search.ok ? search.value.length : `${search.code} ${search.message}`}`);
    // Changing the last commit's message to empty is refused; to 10,000 characters works
    const long = "y".repeat(10_000);
    const reword = await call(app, "commit_reword", { repoId, summary: long, description: "" });
    check(reword.ok, `commit_reword(10,000 characters) fails: ${reword.code} ${reword.message}`);
    equal(ws.git(repo, ["log", "-1", "--format=%s"]).length, 10_000, "git: summary with 10,000 characters");
    const empty = await call(app, "commit_reword", { repoId, summary: "", description: "" });
    check(!empty.ok && empty.code === "empty_message", `commit_reword(empty): ${empty.ok ? "accepted" : `${empty.code} – ${empty.message}`}`);
    // Rebase plan over the commits with odd messages
    const plan = await call(app, "rebase_plan", { repoId, base: shas[0] });
    check(plan.ok && plan.value.status === "ok" && plan.value.rows.length === ODD_MESSAGES.length, `rebase_plan over all commits: ${plan.ok ? `${plan.value.status} ${plan.value.rows?.length ?? plan.value.message}` : `${plan.code} ${plan.message}`}`);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  const ODD_PEOPLE = [
    ["1970", "Lena Hartmann <lena@wetter.example>", "0 +0000"],
    ["1970 with zone", "Lena Hartmann <lena@wetter.example>", "3600 +0100"],
    ["2038", "Lena Hartmann <lena@wetter.example>", "2147483648 +0000"],
    ["2100", "Lena Hartmann <lena@wetter.example>", "4102444800 +0100"],
    ["zone +1400", "Lena Hartmann <lena@wetter.example>", "1772434800 +1400"],
    ["zone -1200", "Lena Hartmann <lena@wetter.example>", "1772434800 -1200"],
    ["zone +0545", "Lena Hartmann <lena@wetter.example>", "1772434800 +0545"],
    ["zone -0000", "Lena Hartmann <lena@wetter.example>", "1772434800 -0000"],
    ["without email", "Nur Name <>", "1772434800 +0100"],
    ["without name", "<nur@mail.example>", "1772434800 +0100"],
    ["without both", "<>", "1772434800 +0100"],
    ["email without @", "Lokal <rechner>", "1772434800 +0100"],
    ["long name", `${"Sehr Langer Name ".repeat(60).trim()} <lang@wetter.example>`, "1772434800 +0100"],
    ["special characters", "Ünïcödé 名前 🚀 \"Zitat\" 'x' <ü@bücher.example>", "1772434800 +0100"],
    ["HTML in the name", "&lt;b&gt;Fett&amp;kursiv {{x}} ${y} <html@wetter.example>", "1772434800 +0100"],
  ];
  await section("file-view/file-history Dates 1970 to 9999, time zones, author without email/name: graph, details, search", async () => {
    const ws = ws0("s10");
    const repo = ws.init("zeiten-und-autoren");
    let stream = "";
    let mark = 0;
    for (const [label, who, when] of ODD_PEOPLE) {
      mark += 1;
      stream += `commit refs/heads/main\nmark :${mark}\nauthor ${who} ${when}\ncommitter ${who} ${when}\n${data(`Commit: ${label}`)}\n${mark > 1 ? `from :${mark - 1}\n` : ""}M 100644 inline datei.txt\n${data(`${label}\n`)}\n`;
    }
    const imported = ws.tryGit(repo, ["fast-import", "--quiet", "--date-format=raw-permissive"], { input: Buffer.from(stream, "utf8") });
    if (!check(imported.ok, `fixture: fast-import fails: ${imported.out}`)) return;
    ws.git(repo, ["checkout", "-q", "-f", "main"]);
    const shas = lines(ws.git(repo, ["rev-list", "--reverse", "main"]));
    equal(shas.length, ODD_PEOPLE.length, "fixture: all commits created");
    write(repo, "datei.txt", "lokal\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Gewöhnlicher Commit nach den seltsamen" });
    const { repoId, tabId } = seen.opened;
    const rows = await graphRows(repoId);
    if (check(Array.isArray(rows), `graph_page: ${rows.code} ${rows.message}`)) {
      equal(rows.length, ODD_PEOPLE.length + 1, "graph: all commits as rows");
      for (const [index, [label, , when]] of ODD_PEOPLE.entries()) {
        const sha = shas[index];
        const row = rows.find((entry) => entry.sha === sha);
        if (!check(Boolean(row), `graph: row "${label}" missing`)) continue;
        const [seconds] = when.split(" ");
        const wantIso = Number(seconds) <= 253402300799 ? new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z") : null;
        check(row.authoredAt === wantIso || (row.authoredAt && new Date(row.authoredAt).getTime() === Number(seconds) * 1000), `graph "${label}": authoredAt ${row.authoredAt}, expected ${wantIso}`);
        equal(row.authorName, ws.git(repo, ["log", "-1", "--format=%an", sha]), `graph "${label}": name as in git %an`);
        equal(row.authorEmail, ws.git(repo, ["log", "-1", "--format=%ae", sha]), `graph "${label}": email as in git %ae`);
        const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha } });
        if (!check(details.ok, `commit_details("${label}") fails: ${details.code} ${details.message}`)) continue;
        check(new Date(details.value.commit.authoredAt).getTime() === Number(seconds) * 1000, `details "${label}": authoredAt ${details.value.commit.authoredAt}`);
        const zone = when.split(" ")[1];
        const minutes = (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
        equal(details.value.commit.authorOffsetMinutes, minutes, `details "${label}": time zone in minutes`);
      }
    }
    // UI: every row has a readable date and an author (no "Invalid Date", no "undefined", no NaN)
    await app.settle();
    const dom = await graphDom(app);
    for (const row of dom) check(!/Invalid Date|undefined|NaN|null/.test(row.text), `UI: graph row shows nonsense: ${JSON.stringify(row.text.slice(0, 160))}`);
    for (const index of [0, 2, 3, 8, 9, 10, 12, 13, 14]) {
      await selectCommit(app, tabId, shas[index]);
      await sleep(150);
      const panel = await app.page.evaluate(() => {
        const root = document.querySelector('[data-screen="commit-details"]');
        return { text: (root?.innerText ?? "").replace(/\s+/g, " ").slice(0, 400), overflow: root ? root.scrollWidth - root.clientWidth : null, page: document.documentElement.scrollWidth - document.documentElement.clientWidth, bold: root?.querySelectorAll("b, i").length ?? 0 };
      });
      check(!/Invalid Date|undefined|NaN/.test(panel.text), `UI: commit details "${ODD_PEOPLE[index][0]}" show nonsense: ${JSON.stringify(panel.text.slice(0, 200))}`);
      check(panel.overflow !== null && panel.overflow <= 1 && panel.page === 0, `UI: commit details "${ODD_PEOPLE[index][0]}" without overflow (${panel.overflow}/${panel.page})`);
      if ([0, 3, 8, 9, 10].includes(index)) note(`details "${ODD_PEOPLE[index][0]}": ${JSON.stringify(panel.text.slice(0, 170))}`);
    }
    const search = await call(app, "commit_search", { repoId, query: "Nur Name", limit: 20 });
    check(search.ok && search.value.some((hit) => hit.sha === shas[8]), `commit_search for the author without email: ${search.ok ? search.value.length : `${search.code} ${search.message}`}`);
    const blame = await call(app, "file_blame", { repoId, path: "datei.txt", sha: shas[10] });
    check(blame.ok && blame.value.length === 1, `file_blame on a commit without author: ${blame.ok ? JSON.stringify(blame.value[0]?.author) : `${blame.code} ${blame.message}`}`);
    const history = await call(app, "file_history", { repoId, path: "datei.txt", limit: 100 });
    check(history.ok && history.value.length === ODD_PEOPLE.length + 1, `file_history over all odd commits: ${history.ok ? history.value.length : `${history.code} ${history.message}`}`);
    // Cherry-pick and rebase keep author and date
    const plan = await call(app, "rebase_plan", { repoId, base: shas[0] });
    check(plan.ok && plan.value.status === "ok", `rebase_plan: ${plan.ok ? `${plan.value.status} ${plan.value.message ?? ""}` : `${plan.code} ${plan.message}`}`);
    if (plan.ok && plan.value.status === "ok") {
      const rowsPlan = plan.value.rows.map((row, index) => (index === 0 ? { ...row, action: "reword", message: "Commit: 1970 with zone (reworded)" } : row));
      const applied = await call(app, "rebase_apply", { repoId, base: shas[0], rows: rowsPlan });
      check(applied.ok && applied.value.status === "done", `rebase_apply over the odd commits: ${applied.ok ? JSON.stringify(applied.value).slice(0, 200) : `${applied.code} – ${applied.message}`}`);
      const after = lines(ws.git(repo, ["log", "--reverse", "--format=%an|%ae|%at|%ad", "--date=raw", "main"]));
      const before = lines(ws.git(repo, ["log", "--reverse", "--format=%an|%ae|%at|%ad", "--date=raw", ...shas.slice(-1)]));
      equal(after.slice(0, ODD_PEOPLE.length), before, "git: author, email, date and time zone of every commit unchanged after the rebase");
    }
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("blame 2000 branches and 5000 tags: refs, graph, left panel, filter, checkout", async () => {
    const ws = ws0("s12");
    const repo = small(ws, "viele-refs");
    const shas = lines(ws.git(repo, ["rev-list", "--all"]));
    let input = "";
    for (let index = 0; index < 2000; index++) input += `create refs/heads/team-${index % 40}/thema-${String(index).padStart(4, "0")} ${shas[index % shas.length]}\n`;
    for (let index = 0; index < 5000; index++) input += `create refs/tags/v${Math.floor(index / 100)}.${index % 100}.0 ${shas[index % shas.length]}\n`;
    ws.git(repo, ["update-ref", "--stdin"], { input });
    ws.git(repo, ["pack-refs", "--all"]);
    write(repo, "README.md", "# Klein\nmit vielen Refs\n");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    let started = Date.now();
    const refs = await call(app, "refs_list", { repoId });
    const refsMs = Date.now() - started;
    note(`refs_list: ${refsMs} ms`);
    check(refs.ok && refs.value.locals.length === 2002 && refs.value.tags.length === 5000, `refs_list: ${refs.ok ? `${refs.value.locals.length} branches, ${refs.value.tags.length} tags` : `${refs.code} ${refs.message}`}`);
    check(refsMs < 10_000, `refs_list takes ${refsMs} ms`);
    started = Date.now();
    const page = await call(app, "graph_page", { repoId, cursor: null, limit: 2000 });
    const graphMs = Date.now() - started;
    note(`graph_page: ${graphMs} ms`);
    check(page.ok && page.value.rows.filter((row) => row.kind !== "wip").length === 4, `graph_page: ${page.ok ? page.value.rows.length : `${page.code} ${page.message}`}`);
    check(graphMs < 10_000, `graph_page takes ${graphMs} ms`);
    if (page.ok) note(`labels per row: ${JSON.stringify(page.value.rows.map((row) => row.refs.length))}`);
    await app.settle(60_000);
    // UI stays smooth; left panel and graph are virtualized
    const dom = await Promise.race([
      app.page.evaluate(() => new Promise((resolve) => {
        const t0 = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ frames: performance.now() - t0, nodes: document.querySelectorAll("*").length, refRows: document.querySelectorAll("[data-ref-row]").length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth })));
      })),
      sleep(20_000).then(() => "hangs"),
    ]);
    note(`UI with 7000 refs: ${JSON.stringify(dom)}`);
    check(dom !== "hangs" && dom.frames < 1000, `UI: two frames take ${dom.frames} ms`);
    check(dom !== "hangs" && dom.nodes < 20_000, `UI: ${dom.nodes} DOM nodes`);
    check(dom !== "hangs" && dom.overflow === 0, `UI: no horizontal overflow (${dom.overflow})`);
    // Graph row with over 1700 labels: the row stays one row
    const heights = await app.page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('[data-screen="commit-graph"] [data-row-id]')).map((row) => Math.round(row.getBoundingClientRect().height)))]);
    equal(heights.length, 1, `UI: all graph rows have the same height (${JSON.stringify(heights)})`);
    // Check out a branch deep in the list, delete a tag, delete branches in bulk
    started = Date.now();
    const co = await call(app, "branch_checkout", { repoId, target: "team-39/thema-1999" });
    note(`branch_checkout: ${Date.now() - started} ms`);
    check(!co.ok ? co.code === "dirty_worktree" || co.code !== "unknown" : true, `branch_checkout: ${co.code} ${co.message}`);
    const names = Array.from({ length: 100 }, (_, index) => `team-${index % 40}/thema-${String(index).padStart(4, "0")}`);
    started = Date.now();
    const del = await call(app, "branch_delete", { repoId, names, force: true });
    note(`branch_delete(100 branches): ${Date.now() - started} ms`);
    check(del.ok && del.value.locals.length === 1902, `branch_delete(100): ${del.ok ? del.value.locals.length : `${del.code} ${del.message}`}`);
    // (Duration and undo of the bulk delete: separate section for BUG L2-10.)
    ws.git(repo, ["update-ref", "--stdin"], { input: names.map((name, index) => `create refs/heads/${name} ${shas[index % shas.length]}\n`).join("") });
    equal(lines(ws.git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"])).length, 2002, "fixture: 2002 branches again");
    void tabId;
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  const ODD_BRANCHES = ["feature", "feature-x", "feature_x", "feature.x", "Feature-Y", "bugfix/größe-ändern", "bugfix/größe-ändern-2", "🚀/start", "a/b/c/d/e/f/g/h", "release/1.0", "release/1.0.1", "mit#raute", "mit%prozent", "mit@at", "mit+plus", "mit'apostroph", "mit(klammer)", "mit{geschweift}", "mit=gleich", "mit,komma", "mit;semikolon", "mit&und", "mit$dollar", "mit!ausruf", "HEAD", "origin/main", "1234567", "deadbeef", "日本語/ブランチ"];
  await section("conflict Branch names (umlauts, emoji, shared prefixes, special characters): each can be checked out and committed on", async () => {
    const ws = ws0("s13");
    const repo = small(ws, "branch-namen");
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const base = ws.git(repo, ["rev-parse", "HEAD~1"]);
    let input = "";
    for (const name of ODD_BRANCHES) input += `create refs/heads/${name} ${base}\n`;
    ws.git(repo, ["update-ref", "--stdin"], { input });
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    const refs = await call(app, "refs_list", { repoId });
    if (check(refs.ok, `refs_list fails: ${refs.code} ${refs.message}`)) equal(sorted(refs.value.locals.map((ref) => ref.name)), sorted([...ODD_BRANCHES, "main", "seite"]), "refs_list lists every name unchanged");
    for (const name of ODD_BRANCHES) {
      const co = await call(app, "branch_checkout", { repoId, target: name });
      if (!check(co.ok, `branch_checkout(${JSON.stringify(name)}) fails: ${co.code} – ${co.message}`)) continue;
      const now = ws.tryGit(repo, ["symbolic-ref", "-q", "HEAD"]);
      if (!check(now.ok && now.out === `refs/heads/${name}`, `git: HEAD is refs/heads/${name} (got ${now.ok ? now.out : `detached at ${ws.git(repo, ["rev-parse", "--short", "HEAD"])}`})`)) {
        ws.git(repo, ["checkout", "-q", "-f", "main"]);
        continue;
      }
      write(repo, "branch.txt", `auf ${name}\n`);
      const commit = await call(app, "commit_create", { ...commitArgs(repoId, `Commit auf ${name}`), stageAll: true });
      check(commit.ok, `commit_create on ${JSON.stringify(name)} fails: ${commit.code} – ${commit.message}`);
      equal(ws.git(repo, ["log", "-1", "--format=%s", `refs/heads/${name}`]), `Commit auf ${name}`, `git: the commit is on refs/heads/${name}`);
    }
    equal(ws.git(repo, ["rev-parse", "refs/heads/main"]), head, "git: main is untouched by all of this");
    const back = await call(app, "branch_checkout", { repoId, target: "main" });
    check(back.ok, `branch_checkout(main) fails: ${back.code} ${back.message}`);
    equal(ws.git(repo, ["symbolic-ref", "HEAD"]), "refs/heads/main", "git: back on main");
    // Merge, rename, delete with difficult names
    for (const name of ["bugfix/größe-ändern", "🚀/start", "mit#raute", "feature", "HEAD", "1234567", "deadbeef", "origin/main"]) {
      const before = ws.git(repo, ["rev-parse", `refs/heads/${name}`]);
      const merge = await call(app, "merge_start", { repoId, source: name, mode: "no_ff" });
      if (check(merge.ok && merge.value.status !== "up_to_date", `merge_start(${JSON.stringify(name)}): ${merge.ok ? merge.value.status : `${merge.code} – ${merge.message}`}`)) {
        if (merge.value.status === "conflict") {
          await call(app, "conflict_resolve", { repoId, path: "branch.txt", content: null, side: "theirs" });
          const done = await call(app, "operation_continue", { repoId, message: `Merge ${name}` });
          check(done.ok, `operation_continue after merging ${JSON.stringify(name)} fails: ${done.code} – ${done.message}`);
        }
        const second = ws.tryGit(repo, ["rev-parse", "-q", "--verify", "HEAD^2"]);
        equal(second.ok ? second.out : null, before, `git: second parent of the merge is refs/heads/${name}`);
      }
      const renamed = await call(app, "branch_rename", { repoId, name, newName: `${name}-neu` });
      check(renamed.ok, `branch_rename(${JSON.stringify(name)}) fails: ${renamed.code} – ${renamed.message}`);
      if (renamed.ok) {
        equal(ws.tryGit(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}-neu`]).out, before, `git: refs/heads/${name}-neu points to the old state`);
        const deleted = await call(app, "branch_delete", { repoId, names: [`${name}-neu`], force: false });
        check(deleted.ok, `branch_delete(${JSON.stringify(`${name}-neu`)}) fails: ${deleted.code} – ${deleted.message}`);
        check(!ws.tryGit(repo, ["rev-parse", "-q", "--verify", `refs/heads/${name}-neu`]).ok, `git: refs/heads/${name}-neu is deleted`);
      }
    }
    equal((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error toast in the UI");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("rebase Tag and branch with the same name: checkout, merge, rebase, push and delete mean the branch", async () => {
    const ws = ws0("s14");
    const repo = small(ws, "doppelname");
    const remote = ws.init("origin.git", { bare: true });
    ws.git(repo, ["remote", "add", "origin", remote]);
    ws.git(repo, ["push", "-q", "-u", "origin", "main"]);
    const tagAt = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    // Branch "release" with its own commit; tag "release" on the very first commit.
    ws.git(repo, ["checkout", "-q", "-b", "release", "main"]);
    write(repo, "release.txt", "freigabe\n");
    const branchAt = ws.commit(repo, "Commit auf dem Branch release");
    ws.git(repo, ["checkout", "-q", "main"]);
    ws.git(repo, ["tag", "release", tagAt]);
    ws.git(repo, ["tag", "main", tagAt]);
    const mainAt = ws.git(repo, ["rev-parse", "refs/heads/main"]);
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    const refs = await call(app, "refs_list", { repoId });
    if (check(refs.ok, `refs_list fails: ${refs.code} ${refs.message}`)) {
      equal(refs.value.locals.find((ref) => ref.name === "release")?.sha, branchAt, "refs_list: Branch release");
      equal(refs.value.tags.find((ref) => ref.name === "release")?.sha, tagAt, "refs_list: Tag release");
      equal(refs.value.head, { kind: "branch", branch: "main", sha: mainAt }, "HEAD: branch main (not the tag)");
    }
    const status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.upstream?.name === "origin/main" && status.value.upstream.ahead === 0 && status.value.upstream.behind === 0, `upstream of main despite tag "main": ${status.ok ? JSON.stringify(status.value.upstream) : status.message}`);
    // Checkout
    const co = await call(app, "branch_checkout", { repoId, target: "release" });
    check(co.ok, `branch_checkout(release) fails: ${co.code} – ${co.message}`);
    equal(ws.tryGit(repo, ["symbolic-ref", "-q", "HEAD"]).out, "refs/heads/release", "git: the BRANCH release is checked out");
    equal(ws.git(repo, ["rev-parse", "HEAD"]), branchAt, "git: HEAD is on the branch's commit");
    // Commit on the branch
    write(repo, "release.txt", "freigabe\nzweite Zeile\n");
    const commit = await call(app, "commit_create", { ...commitArgs(repoId, "Zweiter Commit auf release"), stageAll: true });
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    const branchNow = ws.git(repo, ["rev-parse", "refs/heads/release"]);
    equal(ws.git(repo, ["rev-parse", "refs/tags/release"]), tagAt, "git: the tag release is unchanged");
    // Push the branch (git push origin release would be ambiguous)
    const push = await call(app, "push", { repoId, jobId: `l2-push-${Date.now()}`, branch: "release", remote: "origin", remoteBranch: "release", force: false });
    check(push.ok && push.value.status === "done", `push(release): ${push.ok ? JSON.stringify(push.value) : `${push.code} – ${push.message} – ${String(push.gitOutput ?? "").trim().slice(0, 200)}`}`);
    equal(ws.tryGit(remote, ["rev-parse", "-q", "--verify", "refs/heads/release"]).out, branchNow, "git: the remote has the branch release on the new commit");
    check(!ws.tryGit(remote, ["rev-parse", "-q", "--verify", "refs/tags/release"]).ok, "git: the tag was not pushed along");
    // Back to main and merge the BRANCH release
    const back = await call(app, "branch_checkout", { repoId, target: "main" });
    check(back.ok, `branch_checkout(main) fails: ${back.code} – ${back.message}`);
    equal(ws.tryGit(repo, ["symbolic-ref", "-q", "HEAD"]).out, "refs/heads/main", "git: the BRANCH main is checked out (not the tag main)");
    const merge = await call(app, "merge_start", { repoId, source: "release", mode: "no_ff" });
    check(merge.ok && merge.value.status === "done", `merge_start(release): ${merge.ok ? JSON.stringify(merge.value) : `${merge.code} – ${merge.message}`}`);
    equal(ws.tryGit(repo, ["rev-parse", "-q", "--verify", "HEAD^2"]).out, branchNow, "git: the branch release was merged (second parent), not the tag");
    await call(app, "undo", { repoId });
    // (Rebase onto "release" and branch from "release": separate section for BUG L2-08.)
    // Deleting the tag keeps the branch; deleting the branch keeps the tag
    const tagDelete = await call(app, "tag_delete", { repoId, name: "main", remote: null });
    check(tagDelete.ok, `tag_delete(main) fails: ${tagDelete.code} – ${tagDelete.message}`);
    check(ws.tryGit(repo, ["rev-parse", "-q", "--verify", "refs/heads/main"]).ok && !ws.tryGit(repo, ["rev-parse", "-q", "--verify", "refs/tags/main"]).ok, "git: tag main gone, branch main present");
    const branchDelete = await call(app, "branch_delete", { repoId, names: ["release"], force: true });
    check(branchDelete.ok, `branch_delete(release) fails: ${branchDelete.code} – ${branchDelete.message}`);
    check(!ws.tryGit(repo, ["rev-parse", "-q", "--verify", "refs/heads/release"]).ok && ws.tryGit(repo, ["rev-parse", "-q", "--verify", "refs/tags/release"]).out === tagAt, "git: branch release gone, tag release unchanged");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("stash-form Detached HEAD (on commit, on tag, on remote branch): core loop, commit stays reachable", async () => {
    const ws = ws0("s15");
    const repo = small(ws, "losgeloest");
    ws.git(repo, ["tag", "-a", "v1", "-m", "Version 1", "HEAD~1"]);
    ws.git(repo, ["checkout", "-q", "--detach", "v1"]);
    write(repo, "src/a.txt", "a\nim losgelösten Zustand\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit ohne Branch", branch: "gerettet" });
    const { repoId } = seen.opened;
    // The core loop created a branch and did not switch back afterwards (no original branch).
    equal(ws.git(repo, ["symbolic-ref", "--short", "HEAD"]), "gerettet", "git: the new branch holds the commit");
    equal(ws.git(repo, ["log", "-1", "--format=%s", "gerettet"]), "Commit ohne Branch", "git: the commit from the detached state is on the branch");
    const co = await call(app, "branch_checkout", { repoId, target: ws.git(repo, ["rev-parse", "main~2"]) });
    check(co.ok, `branch_checkout(SHA) fails: ${co.code} – ${co.message}`);
    const refs = await call(app, "refs_list", { repoId });
    check(refs.ok && refs.value.head.kind === "detached", `detached HEAD: ${refs.ok ? JSON.stringify(refs.value.head) : refs.message}`);
    for (const [command, args] of [["pull", { repoId, jobId: "l2-pull", mode: null }], ["push", { repoId, jobId: "l2-push", branch: null, remote: null, remoteBranch: null, force: false }], ["rebase_plan", { repoId, base: "main" }]]) {
      const result = await call(app, command, args);
      check(result.ok || result.code !== "unknown", `${command} in detached state answers clearly: ${result.code} – ${result.message}`);
    }
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-08: If a branch has a tag with the same name, rebase_start(onto), rebase_plan(base) and
  // branch_create(start) resolve the short name like `git rev-parse` – which prefers the TAG. The UI passes
  // exactly this short name (`ref.name`) in "Rebase … onto 'release'" (context menu, drop menu, command
  // palette) and in the command palette's "create new branch here". The rebase then silently goes onto the
  // tag's commit. Checkout, merge, push and delete correctly mean the branch (rebase).
  await section("rebase Tag and branch with the same name: rebase onto the branch and branch from the branch", async () => {
    const ws = ws0("s14b");
    const repo = small(ws, "doppelname-rebase");
    const tagAt = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    const mainAt = ws.git(repo, ["rev-parse", "refs/heads/main"]);
    ws.git(repo, ["checkout", "-q", "-b", "release", "main"]);
    write(repo, "release.txt", "freigabe\n");
    const branchAt = ws.commit(repo, "Commit auf dem Branch release");
    ws.git(repo, ["tag", "release", tagAt]);
    ws.git(repo, ["checkout", "-q", "-b", "thema", mainAt]);
    write(repo, "thema.txt", "thema\n");
    ws.commit(repo, "Commit auf thema");
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    const created = await call(app, "branch_create", { repoId, name: "von-release", start: "release", checkout: false });
    check(created.ok, `branch_create(start: release) fails: ${created.code} – ${created.message}`);
    equal(ws.tryGit(repo, ["rev-parse", "-q", "--verify", "refs/heads/von-release"]).out, branchAt, "git: the new branch starts at the BRANCH release (not at the tag)");
    // The branch release is not an ancestor of thema (the tag would be): with the branch as base the plan
    // for the rebase tool rightly refuses – what matters is that it does not silently take the tag.
    const plan = await call(app, "rebase_plan", { repoId, base: "release" });
    check(plan.ok && plan.value.base !== tagAt && (plan.value.status === "refused" || plan.value.base === branchAt), `rebase_plan(base: release) means the branch, not the tag: ${plan.ok ? JSON.stringify({ status: plan.value.status, base: plan.value.base, message: plan.value.message }) : `${plan.code} – ${plan.message}`}`);
    const rebase = await call(app, "rebase_start", { repoId, onto: "release", branch: null });
    check(rebase.ok && rebase.value.status === "done", `rebase_start(onto: release): ${rebase.ok ? JSON.stringify(rebase.value) : `${rebase.code} – ${rebase.message}`}`);
    equal(ws.git(repo, ["rev-parse", "thema~1"]), branchAt, "git: after the rebase thema sits on the BRANCH release (not on the tag)");
    await closeRepo(app, opened);
  }, { bug: "L2-08" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-10: Deleting several branches at once is ONE action but leaves one undo step per branch:
  // "Undo" only brings back the last deleted one. Also every branch runs its own git call – 500 branches
  // took 40 s (git itself: under 1 s).
  await section("blame Delete several branches: one undo brings all back, 200 branches in a few seconds", async () => {
    const ws = ws0("s12b");
    const repo = small(ws, "viele-loeschen");
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    ws.git(repo, ["update-ref", "--stdin"], { input: Array.from({ length: 200 }, (_, index) => `create refs/heads/alt/thema-${String(index).padStart(3, "0")} ${head}\n`).join("") });
    for (const name of ["b1", "b2", "b3"]) {
      ws.git(repo, ["checkout", "-q", "-b", name, "main"]);
      write(repo, `${name}.txt`, "x\n");
      ws.commit(repo, `nur auf ${name}`);
    }
    ws.git(repo, ["checkout", "-q", "main"]);
    const before = ws.git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    const del = await call(app, "branch_delete", { repoId, names: ["b1", "b2", "b3"], force: true });
    check(del.ok, `branch_delete(b1, b2, b3) fails: ${del.code} – ${del.message}`);
    equal(lines(ws.git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).filter((name) => /^b\d$/.test(name)), [], "git: all three deleted");
    const undo = await call(app, "undo", { repoId });
    check(undo.ok, `undo fails: ${undo.code} – ${undo.message}`);
    equal(ws.git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]), before, "git: ONE undo brings all three branches back");
    if (undo.ok) note(`after one undo: next undo step ${JSON.stringify(undo.value.undo?.label ?? null)}`);
    // Restore the rest in case it is three steps after all – the timing part should run independently.
    for (let round = 0; round < 3 && ws.git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]) !== before; round++) await call(app, "undo", { repoId });
    const names = Array.from({ length: 200 }, (_, index) => `alt/thema-${String(index).padStart(3, "0")}`);
    const started = Date.now();
    const many = await call(app, "branch_delete", { repoId, names, force: false });
    const ms = Date.now() - started;
    note(`branch_delete(200 branches): ${ms} ms`);
    check(many.ok, `branch_delete(200) fails: ${many.code} – ${many.message}`);
    check(ms < 5000, `deleting 200 branches takes ${ms} ms (limit 5000 ms)`);
    await closeRepo(app, opened);
  }, { bug: "L2-10" });

  // ---------------------------------------------------------------------------------------------
  await section("file-view Date 2106, year 9999, absurdly large, zone +9999 (hand-built commits): graph and details stay usable", async () => {
    const ws = ws0("s10b");
    const repo = small(ws, "ferne-zukunft");
    const tree = ws.git(repo, ["rev-parse", "HEAD^{tree}"]);
    let parent = ws.git(repo, ["rev-parse", "HEAD"]);
    const made = [];
    for (const [label, when] of [["2106", "4294967296 +0000"], ["year 9999", "253402300799 +0000"], ["huge", "99999999999999 +0000"], ["zone +9999", "1772434800 +9999"]]) {
      const raw = `tree ${tree}\nparent ${parent}\nauthor Lena Hartmann <lena@wetter.example> ${when}\ncommitter Lena Hartmann <lena@wetter.example> ${when}\n\nCommit: ${label}\n`;
      const made1 = ws.tryGit(repo, ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: raw });
      if (!check(made1.ok, `fixture: commit "${label}" could not be written: ${made1.out}`)) continue;
      parent = made1.out;
      made.push([label, parent, when]);
    }
    ws.git(repo, ["update-ref", "refs/heads/zukunft", parent]);
    note(`git log of the future: ${JSON.stringify(lines(ws.tryGit(repo, ["log", "--format=%s|%aI", "zukunft", "-n", "5"]).out))}`);
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const rows = await graphRows(repoId);
    if (check(Array.isArray(rows), `graph_page fails: ${rows.code} – ${rows.message}`)) {
      equal(rows.length, 4 + made.length, "graph: all commits as rows, including those with a distant date");
      for (const [label, sha] of made) {
        const row = rows.find((entry) => entry.sha === sha);
        check(Boolean(row), `graph: row "${label}" missing`);
        if (row) note(`"${label}": authoredAt ${row.authoredAt}`);
        const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha } });
        check(details.ok, `commit_details("${label}") fails: ${details.code} – ${details.message}`);
      }
    }
    await app.settle(30_000);
    await eventually(async () => (await graphDom(app)).length >= 4, true, "UI: the graph is up", 20_000);
    for (const row of await graphDom(app)) check(!/Invalid Date|undefined|NaN/.test(row.text), `UI: graph row shows nonsense: ${JSON.stringify(row.text.slice(0, 160))}`);
    for (const [label, sha] of made) {
      await selectCommit(app, tabId, sha);
      await sleep(150);
      const text = ((await app.page.locator('[data-screen="commit-details"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
      check(text.includes(`Commit: ${label}`) && !/Invalid Date|undefined|NaN/.test(text), `UI: commit details "${label}": ${JSON.stringify(text.slice(0, 200))}`);
    }
    equal((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error toast");
    const co = await call(app, "branch_checkout", { repoId, target: "zukunft" });
    check(co.ok, `branch_checkout(zukunft) fails: ${co.code} – ${co.message}`);
    write(repo, "README.md", "# Klein\nnach der Zukunft\n");
    const commit = await call(app, "commit_create", { ...commitArgs(repoId, "Commit nach der fernen Zukunft"), stageAll: true });
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-11: A single commit with a date from the year 10000 on (timestamp 253402300800) crashes the whole
  // UI: `formatDateTime` (src/app/format.ts) throws "RangeError: Invalid time value", the window is empty
  // afterwards. Because the tab is remembered, it stays empty after a restart too – the app is only usable
  // again once the data directory is deleted.
  await section("file-view Commit dated in the year 10000: the UI stays up, also after a restart", async () => {
    const ws = ws0("s10c");
    const repo = small(ws, "jahr-10000");
    const tree = ws.git(repo, ["rev-parse", "HEAD^{tree}"]);
    const parent = ws.git(repo, ["rev-parse", "HEAD"]);
    const raw = `tree ${tree}\nparent ${parent}\nauthor Lena Hartmann <lena@wetter.example> 253402300800 +0000\ncommitter Lena Hartmann <lena@wetter.example> 253402300800 +0000\n\nCommit aus dem Jahr 10000\n`;
    const sha = ws.git(repo, ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: raw });
    ws.git(repo, ["update-ref", "refs/heads/main", sha]);
    ws.git(repo, ["reset", "-q", "--hard"]);
    // Own instance with its own data directory: the crash must not take the other sections down.
    const dataDir = fs.mkdtempSync(path.join(ws.root, "daten-"));
    const shared = app;
    let own = await launchApp({ show, dataDir });
    t.attach(own);
    try {
      const opened = await call(own, "repo_open", { path: repo });
      check(opened.ok, `repo_open fails: ${opened.code} – ${opened.message}`);
      await sleep(2500);
      check(await healthy(own), "after opening the shell is still up (window not empty)");
      const rows = await own.page.locator('[data-screen="commit-graph"] [data-row-id]').count().catch(() => 0);
      check(rows >= 4, `the graph shows the commits (${rows} rows)`);
      const crashed = own.consoleErrors.filter((line) => /RangeError|Invalid time value/.test(line));
      check(crashed.length === 0, `no UI crash: ${crashed[0]?.split("\n").slice(0, 2).join(" ") ?? ""}`);
      await bugShot(own);
      own.consoleErrors.length = 0;
      await own.close();
      // Restart with the same data directory (the tab is remembered)
      own = await launchApp({ show, dataDir, waitForShell: false });
      t.attach(own);
      await sleep(6000);
      check(await healthy(own), "after a restart the shell is up (the app is not permanently unusable)");
      if (!(await healthy(own))) await bugShot(own, "-after-restart");
      own.consoleErrors.length = 0;
    } finally {
      await own.close().catch(() => undefined);
      t.attach(shared);
    }
  }, { bug: "L2-11" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-12: A single damaged ref cripples parts of the app, although git itself only skips it with a
  // warning: if the ref points to a missing object, refs_list and graph_page fail entirely ("git for-each-ref
  // … exit code 128") – no branches, no history. If the ref file is empty or contains garbage, the commit
  // search fails with "Not found." (`git log --all` aborts).
  for (const [label, content] of [["empty ref file", ""], ["garbage", "das ist kein SHA\n"], ["pointer to a missing object", `${"1234567890".repeat(4)}\n`], ["NUL bytes (after a crash)", "\0".repeat(41)]]) {
    await section(`command-palette Damaged ref (${label}): repository stays usable, the damage is named`, async () => {
      const ws = ws0("s16");
      const repo = small(ws, "kaputter-ref");
      fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "kaputt"), content);
      write(repo, "README.md", "# Klein\ngeändert\n");
      note(`git for-each-ref: ${JSON.stringify(ws.tryGit(repo, ["for-each-ref", "--format=%(refname)"]).out.slice(0, 200))}`);
      note(`git log --all: ${ws.tryGit(repo, ["log", "--all", "--oneline"]).ok ? "works" : "fails"}`);
      const opened = await call(app, "repo_open", { path: repo });
      if (!check(opened.ok, `repo_open fails: ${opened.code} – ${opened.message}`)) return;
      const repoId = opened.value.repo.id;
      const refs = await call(app, "refs_list", { repoId });
      check(refs.ok && refs.value.locals.some((ref) => ref.name === "main") && refs.value.locals.some((ref) => ref.name === "seite"), `refs_list lists the healthy branches: ${refs.ok ? JSON.stringify(refs.value.locals.map((ref) => ref.name)) : `${refs.code} – ${refs.message}`}`);
      const rows = await graphRows(repoId);
      check(Array.isArray(rows) && rows.length === 4, `graph shows the four healthy commits: ${Array.isArray(rows) ? rows.length : `${rows.code} – ${rows.message} – ${String(rows.gitOutput ?? "").trim().slice(0, 160)}`}`);
      const status = await call(app, "status_get", { repoId });
      check(status.ok && status.value.unstaged.length === 1, `status_get: ${status.ok ? status.value.unstaged.length : `${status.code} – ${status.message}`}`);
      const commit = await call(app, "commit_create", { ...commitArgs(repoId, "Commit trotz kaputtem Ref"), stageAll: true });
      check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
      const co = await call(app, "branch_checkout", { repoId, target: "seite" });
      check(co.ok, `branch_checkout(seite) fails: ${co.code} – ${co.message}`);
      await app.settle(30_000).catch(() => undefined);
      await eventually(async () => (await graphDom(app)).filter((row) => row.kind === "commit").length > 0, true, "UI: the graph shows commits", 15_000);
      const search = await call(app, "commit_search", { repoId, query: "Commit", limit: 20 });
      check(search.ok && search.value.length >= 4, `commit_search: ${search.ok ? search.value.length : `${search.code} – ${search.message}`}`);
      await closeRepo(app, { repoId, tabId: opened.value.tab.id });
    }, { bug: "L2-12" });
  }

  // ---------------------------------------------------------------------------------------------
  // BUG L2-13: If an object is missing (damaged repository), the core answers with code `unknown` and
  // "Git command 'git diff-tree' failed (exit code 128)" – what is missing and that the repository is damaged
  // (git fsck) is only in the raw output. The commit details of a healthy commit missing a single blob do
  // not load at all (not even author and message).
  await section("commit-search Missing object (blob of an old commit): graph stays, the one diff reports clearly", async () => {
    const ws = ws0("s17");
    const repo = small(ws, "fehlender-blob");
    const victimCommit = ws.git(repo, ["rev-parse", "HEAD~1"]);
    const blob = ws.git(repo, ["rev-parse", `${victimCommit}:src/a.txt`]);
    const object = path.join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    fs.chmodSync(object, 0o666);
    fs.rmSync(object);
    const seen = await coreLoop(t, app, ws, repo, { mutate: false, headFiles: false });
    const { repoId, tabId } = seen.opened;
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: victimCommit } });
    note(`commit_details(commit with missing blob): ${details.ok ? `ok, ${details.value.files.length} files` : `${details.code} – ${details.message}`}`);
    check(details.ok || (details.code !== "unknown" && /object|damaged|missing/i.test(details.message)), `commit_details answers clearly: ${details.code} – ${details.message}`);
    const diff = await call(app, "diff_file", { repoId, path: "src/a.txt", source: { kind: "commit", sha: victimCommit } });
    note(`diff_file(missing blob): ${diff.ok ? diff.value.kind : `${diff.code} – ${diff.message}`}`);
    check(!diff.ok && diff.code !== "unknown" && /object|damaged|missing/i.test(diff.message), `diff_file names the missing object: ${diff.ok ? `returns ${diff.value.kind}` : `${diff.code} – ${diff.message}`}`);
    const read = await call(app, "file_read", { repoId, path: "src/a.txt", sha: victimCommit });
    check(!read.ok && read.code !== "unknown", `file_read(missing blob): ${read.ok ? "returns content" : `${read.code} – ${read.message}`}`);
    // The rest stays usable
    write(repo, "README.md", "# Klein\ntrotzdem\n");
    const commit = await call(app, "commit_create", { ...commitArgs(repoId, "Commit trotz fehlendem Objekt"), stageAll: true });
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    await selectCommit(app, tabId, victimCommit);
    await sleep(500);
    const text = ((await app.page.locator('[data-screen="commit-details"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    note(`UI, commit with missing blob: ${JSON.stringify(text.slice(0, 220))}`);
    check(text.includes("Zweiter Commit"), `UI: message and author of the commit are visible despite the missing blob (text: ${JSON.stringify(text.slice(0, 160))})`);
    await closeRepo(app, seen.opened);
  }, { bug: "L2-13" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-01 (second trigger): if the blob of a file changed in the working tree is missing, `git diff
  // --numstat` aborts ("unable to read") – and with it the whole status, although `git status` lists everything.
  await section("commit-search Missing object of a changed file: status stays readable, other files can be committed", async () => {
    const ws = ws0("s17b");
    const repo = small(ws, "fehlender-blob-geaendert");
    const blob = ws.git(repo, ["rev-parse", "HEAD:src/a.txt"]);
    const object = path.join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    fs.chmodSync(object, 0o666);
    fs.rmSync(object);
    write(repo, "src/a.txt", "a\nmehr\nund lokal geändert\n");
    write(repo, "README.md", "# Klein\ngeändert\n");
    const want = gitStatus(ws, repo);
    equal(want.unstaged, ["README.md", "src/a.txt"], "fixture: git status lists both files");
    const opened = await app.openRepo(repo);
    const { repoId, tabId } = opened;
    const status = await call(app, "status_get", { repoId });
    check(status.ok, `status_get fails: ${status.code} – ${status.message} – ${String(status.gitOutput ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    if (status.ok) equal(coreStatusPaths(status.value), want, "status as in git status");
    await selectWip(app, tabId);
    await eventually(async () => (await wipRows(app, "unstaged")).includes("README.md"), true, "UI: README.md is in \"Unstaged\"", 10_000);
    const stage = await call(app, "stage_paths", { repoId, paths: ["README.md"] });
    check(stage.ok, `stage_paths(README.md) fails: ${stage.code} – ${stage.message}`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "README trotz fehlendem Objekt"));
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    await closeRepo(app, opened);
  }, { bug: "L2-01" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-13: If a commit in the middle of the history is missing, the graph only shows "Git command
  // 'git log' failed (exit code 128)" (code `unknown`) – the message does not say that an object is missing.
  await section("commit-search Missing commit in the middle of the history: clear message, app stays usable", async () => {
    const ws = ws0("s17c");
    const repo = small(ws, "fehlender-commit");
    const victim = ws.git(repo, ["rev-parse", "HEAD~1"]);
    const object = path.join(repo, ".git", "objects", victim.slice(0, 2), victim.slice(2));
    fs.chmodSync(object, 0o666);
    fs.rmSync(object);
    write(repo, "README.md", "# Klein\ngeändert\n");
    const opened = await call(app, "repo_open", { path: repo });
    if (!check(opened.ok, `repo_open fails: ${opened.code} – ${opened.message}`)) return;
    const repoId = opened.value.repo.id;
    const page = await call(app, "graph_page", { repoId, cursor: null, limit: 500 });
    note(`graph_page: ${page.ok ? `${page.value.rows.length} rows` : `${page.code} – ${page.message}`}`);
    check(page.ok || (page.code !== "unknown" && /object|damaged|missing/i.test(page.message)), `graph_page answers clearly: ${page.code} – ${page.message}`);
    const status = await call(app, "status_get", { repoId });
    check(status.ok, `status_get fails: ${status.code} – ${status.message}`);
    await app.settle(20_000).catch(() => undefined);
    await sleep(500);
    const shown = await toasts(app);
    const screen = ((await app.page.locator('[data-screen="commit-graph"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    note(`UI: graph ${JSON.stringify(screen.slice(0, 200))}; toasts ${JSON.stringify(shown).slice(0, 300)}`);
    // Committing still works (HEAD itself is healthy)
    const commit = await call(app, "commit_create", { ...commitArgs(repoId, "Commit trotz Lücke in der Historie"), stageAll: true });
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    await closeRepo(app, { repoId, tabId: opened.value.tab.id });
  }, { bug: "L2-13" });

  // ---------------------------------------------------------------------------------------------
  /** Superproject with a submodule `teile/sensor` (local clone as source). */
  function withSubmodule(ws, name = "super") {
    const source = ws.init("sensor-quelle");
    write(source, "sensor.txt", "sensor v1\n");
    ws.commit(source, "Sensor v1");
    write(source, "sensor.txt", "sensor v2\n");
    ws.commit(source, "Sensor v2");
    const repo = small(ws, name);
    ws.git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", `file://${slash(source)}`, "teile/sensor"]);
    ws.commit(repo, "Submodul teile/sensor eingebunden");
    return { repo, source };
  }

  await section("terminal Submodule initialized: core loop, states modified and other commit, stage the pointer", async () => {
    const ws = ws0("s18");
    const { repo, source } = withSubmodule(ws);
    write(repo, "README.md", "# Klein\nmit Submodul\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Commit neben einem Submodul" });
    const { repoId } = seen.opened;
    const sub = path.join(repo, "teile", "sensor");
    let list = await call(app, "submodule_list", { repoId });
    check(list.ok && list.value.length === 1 && list.value[0].state === "initialized", `submodule_list: ${list.ok ? JSON.stringify(list.value.map((entry) => [entry.path, entry.state])) : `${list.code} – ${list.message}`}`);
    // own change in the submodule
    write(sub, "sensor.txt", "sensor v2\nlokal\n");
    list = await call(app, "submodule_list", { repoId });
    check(list.ok && list.value[0]?.state === "modified", `state "modified": ${list.ok ? list.value[0]?.state : list.message}`);
    let status = await call(app, "status_get", { repoId });
    if (check(status.ok, `status_get fails: ${status.code} – ${status.message}`)) {
      equal(coreStatusPaths(status.value), gitStatus(ws, repo), "status as in git status (submodule with its own change)");
      const diff = await call(app, "diff_file", { repoId, path: "teile/sensor", source: { kind: "unstaged" } });
      check(diff.ok, `diff_file(submodule, modified) fails: ${diff.code} – ${diff.message}`);
      if (diff.ok) note(`diff of a submodule with its own change: ${JSON.stringify(diff.value).slice(0, 260)}`);
      // "Stage all" must not fail on a submodule with local changes
      const all = await call(app, "stage_paths", { repoId, paths: null });
      check(all.ok, `stage_paths(all) with a modified submodule fails: ${all.code} – ${all.message}`);
      const discard = await call(app, "discard_paths", { repoId, paths: ["teile/sensor"] });
      note(`discard_paths(submodule with its own change): ${discard.ok ? "ok" : `${discard.code} – ${discard.message}`}`);
      check(discard.ok || discard.code !== "unknown", `discard_paths(submodule) answers clearly: ${discard.code} – ${discard.message}`);
    }
    ws.git(sub, ["checkout", "-q", "--", "."]);
    // other commit checked out in the submodule
    ws.git(sub, ["checkout", "-q", "HEAD~1"]);
    list = await call(app, "submodule_list", { repoId });
    check(list.ok && list.value[0]?.state === "out_of_sync", `state "out_of_sync": ${list.ok ? list.value[0]?.state : list.message}`);
    status = await call(app, "status_get", { repoId });
    if (check(status.ok, `status_get fails: ${status.code} – ${status.message}`)) equal(coreStatusPaths(status.value), gitStatus(ws, repo), "status as in git status (submodule on another commit)");
    const diff = await call(app, "diff_file", { repoId, path: "teile/sensor", source: { kind: "unstaged" } });
    check(diff.ok, `diff_file(submodule, other commit) fails: ${diff.code} – ${diff.message}`);
    if (diff.ok) note(`diff of a submodule pointer: ${JSON.stringify(diff.value).slice(0, 300)}`);
    const stage = await call(app, "stage_paths", { repoId, paths: ["teile/sensor"] });
    check(stage.ok, `stage_paths(submodule) fails: ${stage.code} – ${stage.message}`);
    equal(ws.git(repo, ["ls-files", "-s", "teile/sensor"]).split(/\s+/)[1], ws.git(sub, ["rev-parse", "HEAD"]), "git: the submodule pointer is staged");
    const commit = await call(app, "commit_create", commitArgs(repoId, "Submodul auf v1 zurück"));
    check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    check(details.ok && details.value.files.length === 1 && details.value.files[0].path === "teile/sensor", `commit_details(pointer commit): ${details.ok ? JSON.stringify(details.value.files.map((file) => file.path)) : details.message}`);
    const shown = await call(app, "diff_file", { repoId, path: "teile/sensor", source: { kind: "commit", sha: head } });
    check(shown.ok, `diff_file(pointer commit) fails: ${shown.code} – ${shown.message}`);
    // Switch branches across the "submodule present / absent" boundary
    const co = await call(app, "branch_checkout", { repoId, target: "seite" });
    check(co.ok, `branch_checkout(seite, without submodule) fails: ${co.code} – ${co.message}`);
    const st2 = await call(app, "status_get", { repoId });
    if (check(st2.ok, `status_get on seite fails: ${st2.code} – ${st2.message}`)) equal(coreStatusPaths(st2.value), gitStatus(ws, repo), "status on the branch without submodule as in git status");
    const backToMain = await call(app, "branch_checkout", { repoId, target: "main" });
    check(backToMain.ok, `branch_checkout(main) fails: ${backToMain.code} – ${backToMain.message}`);
    void source;
    await closeRepo(app, seen.opened);
  });

  await section("terminal Submodule uninitialized, with missing commit, pointer without a .gitmodules entry", async () => {
    const ws = ws0("s18b");
    const { repo, source } = withSubmodule(ws, "super-quelle");
    // 1. freshly cloned, not initialized
    const clone = path.join(ws.root, "klon");
    ws.git(ws.root, ["clone", "-q", `file://${slash(repo)}`, clone]);
    ws.git(clone, ["config", "user.name", "Lena Hartmann"]);
    ws.git(clone, ["config", "user.email", "lena.hartmann@wetterstation.example"]);
    write(clone, "README.md", "# Klein\nim Klon\n");
    const seen = await coreLoop(t, app, ws, clone, { summary: "Commit im Klon ohne initialisiertes Submodul" });
    let list = await call(app, "submodule_list", { repoId: seen.opened.repoId });
    check(list.ok && list.value.length === 1 && list.value[0].state === "uninitialized", `submodule_list(uninitialized): ${list.ok ? JSON.stringify(list.value.map((entry) => [entry.path, entry.state])) : `${list.code} – ${list.message}`}`);
    const diffUninit = await call(app, "diff_file", { repoId: seen.opened.repoId, path: "teile/sensor", source: { kind: "commit", sha: ws.git(clone, ["rev-parse", "origin/main"]) } });
    check(diffUninit.ok, `diff_file(commit that adds the submodule) fails: ${diffUninit.code} – ${diffUninit.message}`);
    await closeRepo(app, seen.opened);

    // 2. Pointer to a commit that does not exist in the submodule
    const missing = "1234567890123456789012345678901234567890";
    ws.git(repo, ["update-index", "--cacheinfo", `160000,${missing},teile/sensor`]);
    ws.git(repo, ["commit", "-q", "-m", "Submodul zeigt auf einen Commit, den es nicht gibt"]);
    write(repo, "README.md", "# Klein\nneben dem kaputten Zeiger\n");
    const want = gitStatus(ws, repo);
    const broken = await call(app, "repo_open", { path: repo });
    if (check(broken.ok, `repo_open(submodule with missing commit) fails: ${broken.code} – ${broken.message}`)) {
      const repoId = broken.value.repo.id;
      const status = await call(app, "status_get", { repoId });
      if (check(status.ok, `status_get fails: ${status.code} – ${status.message} – ${String(status.gitOutput ?? "").replace(/\s+/g, " ").slice(0, 200)}`)) equal(coreStatusPaths(status.value), want, "status as in git status (pointer to a missing commit)");
      list = await call(app, "submodule_list", { repoId });
      check(list.ok && list.value.length === 1, `submodule_list(missing commit): ${list.ok ? JSON.stringify(list.value.map((entry) => [entry.path, entry.state, entry.sha.slice(0, 7), entry.headSha?.slice(0, 7)])) : `${list.code} – ${list.message}`}`);
      const head = ws.git(repo, ["rev-parse", "HEAD"]);
      const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
      check(details.ok, `commit_details fails: ${details.code} – ${details.message}`);
      const diff = await call(app, "diff_file", { repoId, path: "teile/sensor", source: { kind: "commit", sha: head } });
      check(diff.ok, `diff_file(pointer to a missing commit) fails: ${diff.code} – ${diff.message}`);
      const update = await call(app, "submodule_update", { repoId, jobId: `l2-sub-${Date.now()}`, paths: null, init: true });
      note(`submodule_update(missing commit): ${update.ok ? "ok" : `${update.code} – ${update.message}`}`);
      check(!update.ok && update.code !== "unknown", `submodule_update with a missing commit reports clearly: ${update.ok ? "reports success" : `${update.code} – ${update.message}`}`);
      const stage = await call(app, "stage_paths", { repoId, paths: ["README.md"] });
      check(stage.ok, `stage_paths(README.md) fails: ${stage.code} – ${stage.message}`);
      const commit = await call(app, "commit_create", commitArgs(repoId, "README neben dem kaputten Zeiger"));
      check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
      await closeRepo(app, { repoId, tabId: broken.value.tab.id });
    }

    // 3. Gitlink without an entry in .gitmodules ("no submodule mapping found")
    const orphan = small(ws, "ohne-gitmodules");
    ws.git(orphan, ["update-index", "--add", "--cacheinfo", `160000,${ws.git(source, ["rev-parse", "HEAD"])},fremd/modul`]);
    ws.git(orphan, ["commit", "-q", "-m", "Gitlink ohne .gitmodules"]);
    write(orphan, "README.md", "# Klein\nneben dem Gitlink\n");
    const seen3 = await coreLoop(t, app, ws, orphan, { summary: "Commit neben einem Gitlink ohne .gitmodules" });
    list = await call(app, "submodule_list", { repoId: seen3.opened.repoId });
    note(`submodule_list(gitlink without .gitmodules): ${list.ok ? JSON.stringify(list.value.map((entry) => [entry.path, entry.state])) : `${list.code} – ${list.message}`}`);
    check(list.ok || list.code !== "unknown", `submodule_list answers clearly: ${list.code} – ${list.message}`);
    await closeRepo(app, seen3.opened);
  });

} catch (error) {
  t.check(false, `script aborted: ${error?.stack ?? error}`);
} finally {
  await app?.close().catch(() => undefined);
  for (const ws of spaces) ws.cleanup();
}
await sleep(50);
process.exit(t.finish());
