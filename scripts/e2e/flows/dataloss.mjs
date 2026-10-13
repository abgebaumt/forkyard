/**
 * Angle DATA LOSS (tester L1): is there a way in which the app loses the user's work or damages a
 * repository – without explicit confirmation and without a way back?
 *
 *   node scripts/e2e/flows/dataloss.mjs                  all sections
 *   node scripts/e2e/flows/dataloss.mjs --only C03,C21   only sections whose title contains one of the parts
 *   node scripts/e2e/flows/dataloss.mjs --show           window visible
 *
 * Runs in the real app (launchApp) against real fixture repositories; checks happen in the repository
 * itself: file contents byte for byte, git status, git fsck, git stash list, refs. No real service,
 * only local bare repositories.
 *
 * Red sections carry "BUG L1-xx" in their title: they are the test the bug is fixed against.
 * The script ends with the list of green and red sections; exit code 1 if anything is red.
 *
 * The numbers (C01 …) are ordered by topic; the "Addenda" block was added later and therefore sits
 * outside the numbering. State at hand-off (2026-10-12, two full runs): 59 sections, 37 green, 22 red (15 bugs).
 *
 * Notes for whoever fixes things:
 * - A run takes 8 to 10 minutes under load (C66 waits for the real auto-fetch, a good minute).
 * - The app's SSH folder is redirected to a temp folder (FORKYARD_SSH_DIR); the real ~/.ssh is never
 *   touched. C53 closes the window via WM_CLOSE, C80–C82 kill the app hard (taskkill).
 * - UI confirmations in C60, C63 and C16 are triggered through the app's action modules
 *   (`/src/app/actions/…`), i.e. exactly the function the menu entry calls – not via the click path.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { gitIsolationEnv, globalGitConfig, makeCleanRepoWithRemote, makeConflictRepo, makeEmptyRepo } from "../fixtures.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",").map((part) => part.toLowerCase()) : null;
const BUGS = "target/e2e/bugs";

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let current = null;

function check(condition, message) {
  if (!condition) {
    current.failures.push(message);
    console.log(`    ✗ ${message}`);
  }
  return Boolean(condition);
}
const show1 = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${show1(expected)}, got ${show1(actual)}`);
const note = (text) => {
  current.notes.push(text);
  console.log(`    · ${text}`);
};

async function eventually(read, test, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    try {
      value = await read();
    } catch (error) {
      value = `Error: ${String(error?.message ?? error).split("\n")[0]}`;
    }
    if (test(value)) return true;
    if (Date.now() > deadline) return check(false, `${message} (last: ${show1(value)})`);
    await sleep(100);
  }
}

/** One section = one test case. A section that shows a bug carries its ID in the title (stays red until fixed). */
async function section(title, run) {
  if (only && !only.some((part) => title.toLowerCase().includes(part))) return;
  current = { title, failures: [], notes: [], seconds: 0 };
  const started = Date.now();
  console.log(`▶ ${title}`);
  try {
    await run();
  } catch (error) {
    check(false, `aborted: ${error?.stack ?? error}`);
    await shot(`target/e2e/dataloss-failure-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`);
  }
  current.seconds = (Date.now() - started) / 1000;
  console.log(`${current.failures.length ? "✗" : "✓"} ${title} (${current.seconds.toFixed(1)} s)`);
  results.push(current);
  await cleanupSection();
}

// ---------------------------------------------------------------------------
// App and repositories
// ---------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-l1-"));
const dataDir = path.join(workDir, "data");
let app = null;
const opened = [];
const repos = [];

async function start(options = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      // The SSH folder is redirected: no section ever touches the machine's real ~/.ssh.
      app = await launchApp({ show, dataDir, timeoutMs: 120_000, ...options, env: { FORKYARD_SSH_DIR: path.join(workDir, "ssh"), ...(options.env ?? {}) } });
      break;
    } catch (error) {
      // The machine is under load: a start timeout is not a finding. Retry.
      if (attempt >= 3) throw error;
      console.log(`  (app start failed, attempt ${attempt + 1}: ${String(error?.message ?? error).split("\n")[0]})`);
      await sleep(3000);
    }
  }
  // Auto-fetch off: no section should depend on when the app fetches on its own.
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  return app;
}

async function restart(options = {}) {
  await app.close();
  opened.length = 0;
  return start(options);
}

async function shot(file) {
  try {
    await app?.screenshot(file);
  } catch {
    // A screenshot is never more important than the finding.
  }
}

/** Fresh repository (main + feature/export, bare origin) – opened in the app. */
async function fresh({ open = true } = {}) {
  const repo = makeCleanRepoWithRemote();
  repos.push(repo);
  const handle = { repo, path: repo.path, repoId: null, tabId: null };
  if (open) Object.assign(handle, await openRepo(repo.path));
  return handle;
}

async function openRepo(repoPath) {
  const ids = await app.openRepo(repoPath);
  opened.push(ids.tabId);
  return ids;
}

async function cleanupSection() {
  // Close the section's open dialogs and tabs; repositories stay until the end.
  try {
    if (app) {
      for (let round = 0; round < 4 && (await app.page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) {
        await app.page.keyboard.press("Escape");
        await app.page.waitForTimeout(150);
      }
      for (const tabId of opened.splice(0)) await app.invoke("tab_close", { tabId }).catch(() => undefined);
      await app.settle().catch(() => undefined);
    }
  } catch {
    // Cleanup must not block the next section.
  }
}

const core = (command, args) => app.invoke(command, args);
/** Call that may fail: returns { ok, value | code, message }. */
async function tryCore(command, args) {
  try {
    return { ok: true, value: await app.invoke(command, args) };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message, gitOutput: error.gitOutput };
  }
}

// ---------------------------------------------------------------------------
// Looking into the repository
// ---------------------------------------------------------------------------

const abs = (repo, rel) => path.join(repo.path ?? repo, rel);
const bytes = (repo, rel) => fs.readFileSync(abs(repo, rel));
const hex = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 12);
const exists = (repo, rel) => fs.existsSync(abs(repo, rel));
function put(repo, rel, content) {
  const file = abs(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** All files of the working tree (without .git) as { path: hash }. */
function files(repo, dir = "") {
  const out = {};
  for (const entry of fs.readdirSync(abs(repo, dir), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, files(repo, rel));
    else out[rel] = hex(bytes(repo, rel));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const statusText = (repo) => repo.git("status", "--porcelain=v1", "--untracked-files=all");
/** The whole visible state: files byte for byte, status, index, HEAD, stashes. */
const state = (repo) => ({
  files: files(repo),
  status: statusText(repo),
  index: repo.git("ls-files", "--stage"),
  head: repo.git("rev-parse", "HEAD"),
  branch: repo.git("rev-parse", "--abbrev-ref", "HEAD"),
  stashes: repo.git("stash", "list", "--format=%H %gs"),
});
/** `git fsck` – returns the output if the repository is damaged, otherwise "". */
function fsck(repo) {
  try {
    const out = repo.git("fsck", "--no-progress", "--no-dangling");
    return /error|missing|corrupt|fatal/i.test(out) ? out : "";
  } catch (error) {
    return String(error.message);
  }
}
const noLock = (repo) => !fs.existsSync(path.join(repo.path, ".git", "index.lock"));
const undoRefs = (repo) => repo.git("for-each-ref", "--format=%(refname)", "refs/forkyard/").split("\n").filter(Boolean);
const lines = (text) => text.split(/\r?\n/).filter(Boolean);

/** Uncommitted work of every kind: modified, staged, deleted, renamed, untracked, ignored. */
function dirty(repo) {
  put(repo, "README.md", `${bytes(repo, "README.md").toString("utf8")}\nNachtrag: Station Hafen meldet seit Montag doppelt.\n`);
  put(repo, "stationen.csv", `${bytes(repo, "stationen.csv").toString("utf8")}W;Waldrand;212\n`);
  repo.git("add", "stationen.csv");
  put(repo, "stationen.csv", `${bytes(repo, "stationen.csv").toString("utf8")}M;Moor;4\n`);
  put(repo, "notizen/größen & einheiten.txt", "Luftdruck in hPa, Böen in m/s.\r\nZweite Zeile ohne Ende");
  put(repo, "notizen/binär.dat", Buffer.from([0, 1, 2, 3, 255, 254, 13, 10, 0, 10]));
  put(repo, "ausgabe/bericht.txt", "ignoriert, darf nie verschwinden\n");
  put(repo, "src/neu.py", "print('neu')\n");
  repo.git("add", "src/neu.py");
  fs.rmSync(abs(repo, "src/vergleich.py"));
}

const UNDO = (repoId) => core("undo", { repoId });
const REDO = (repoId) => core("redo", { repoId });
const peek = (repoId) => core("undo_peek", { repoId });

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

try {
  await start();

  // ===== Discard =================================================================================

  await section("C01 Discard all → undo → redo → undo: state byte for byte as before", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    await core("discard_paths", { repoId, paths: null });
    equal(statusText(repo), "", "after \"Discard all\" the working tree is clean");
    check(exists(repo, "ausgabe/bericht.txt"), "the ignored file stays when discarding");
    check((await peek(repoId)).undo?.action === "discard", "undo offers to revert the discard");
    await UNDO(repoId);
    equal(state(repo), before, "undo restores files, index and status byte for byte");
    await REDO(repoId);
    equal(statusText(repo), "", "redo discards everything again");
    await UNDO(repoId);
    equal(state(repo), before, "second undo (undo of redo) restores everything again");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C02 Discard single files (modified+staged, untracked, umlauts) → undo byte for byte", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    await core("discard_paths", { repoId, paths: ["stationen.csv", "notizen/größen & einheiten.txt", "notizen/binär.dat", "README.md"] });
    check(!exists(repo, "notizen/binär.dat") && !exists(repo, "notizen/größen & einheiten.txt"), "untracked files are deleted");
    check(bytes(repo, "stationen.csv").toString().endsWith("W;Waldrand;212\n"), "the staged part of stationen.csv stays, only the unstaged part is gone");
    await UNDO(repoId);
    equal(state(repo), before, "undo brings all four files back byte for byte");
  });

  await section("C03 BUG L1-01 Discard all → keep working → undo: new work must not disappear", async () => {
    // BUG L1-01
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "verworfene Fassung\n");
    await core("discard_paths", { repoId, paths: null });
    // The user keeps working: a new file, and another tracked file is modified.
    put(repo, "notizen/nach-dem-verwerfen.txt", "Diese Datei entstand NACH dem Verwerfen.\n");
    put(repo, "stationen.csv", "kürzel;name\nNEU;nach dem Verwerfen geändert\n");
    await UNDO(repoId);
    equal(bytes(repo, "README.md").toString(), "verworfene Fassung\n", "undo brings the discarded change back");
    const fileKept = check(exists(repo, "notizen/nach-dem-verwerfen.txt"), "the file created after the discard is still there after undo");
    const editKept = check(bytes(repo, "stationen.csv").toString().includes("nach dem Verwerfen geändert"), "the change to stationen.csv made after the discard is still there after undo");
    if (!fileKept || !editKept) {
      await shot(`${BUGS}/L1-01.png`);
      // Is there a way back? Redo gets it – but the next recorded action clears the redo stack.
      const refsBefore = undoRefs(repo);
      repo.git("add", "README.md");
      await core("commit_create", { repoId, opId: crypto.randomUUID(), summary: "Weiterarbeiten nach dem Undo", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
      const redo = (await peek(repoId)).redo;
      const reachable = repo.git("log", "--all", "--format=%H", "-S", "Diese Datei entstand NACH dem Verwerfen", "--", "notizen/nach-dem-verwerfen.txt");
      note(`after another commit: redo = ${JSON.stringify(redo)}, backup refs before ${refsBefore.length}, now ${undoRefs(repo).length}, file reachable via refs: ${reachable ? "yes" : "no"}`);
      check(Boolean(reachable) || exists(repo, "notizen/nach-dem-verwerfen.txt"), "after the next recorded action the file deleted by undo can still be recovered via a ref (redo/backup)");
    }
  });

  await section("C04 BUG L1-02 Discard → undo with core.autocrlf=true: line endings byte for byte", async () => {
    // BUG L1-02
    const { repo, repoId } = await fresh();
    repo.git("config", "core.autocrlf", "true");
    const lf = Buffer.from("#!/bin/sh\necho eins\necho zwei\n");
    const mixed = Buffer.from("eins\r\nzwei\ndrei\r\nvier\n");
    put(repo, "skripte/lauf.sh", lf);
    put(repo, "notizen/gemischt.txt", mixed);
    await core("discard_paths", { repoId, paths: ["skripte/lauf.sh", "notizen/gemischt.txt"] });
    check(!exists(repo, "skripte/lauf.sh"), "the untracked file is discarded");
    await UNDO(repoId);
    const a = equal(exists(repo, "skripte/lauf.sh") ? bytes(repo, "skripte/lauf.sh").toString("hex") : null, lf.toString("hex"), "skripte/lauf.sh (LF only) comes back byte for byte");
    const b = equal(exists(repo, "notizen/gemischt.txt") ? bytes(repo, "notizen/gemischt.txt").toString("hex") : null, mixed.toString("hex"), "notizen/gemischt.txt (mixed line endings) comes back byte for byte");
    if (!a || !b) await shot(`${BUGS}/L1-02.png`);
  });

  await section("C05 Discard all → restart app → undo restores everything", async () => {
    const { repo } = await fresh();
    let { repoId } = { repoId: (await core("repo_list")).find((entry) => path.resolve(entry.path).toLowerCase() === path.resolve(repo.path).toLowerCase())?.id };
    dirty(repo);
    const before = state(repo);
    await core("discard_paths", { repoId, paths: null });
    await restart();
    ({ repoId } = await openRepo(repo.path));
    check((await peek(repoId)).undo?.action === "discard", "after the restart undo still offers the discard");
    await UNDO(repoId);
    equal(state(repo), before, "undo after restart restores the state byte for byte");
  });

  await section("C06 Discard hunk (discard_patch) → undo byte for byte, also CRLF and without final newline", async () => {
    const { repo, repoId } = await fresh();
    const original = Buffer.from(Array.from({ length: 40 }, (_, index) => `Zeile ${index + 1}`).join("\r\n"));
    put(repo, "daten/crlf.txt", original);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "CRLF-Datei ohne Zeilenende");
    const changed = Buffer.from(original.toString().replace("Zeile 3\r\n", "Zeile 3 geändert\r\n").replace("Zeile 40", "Zeile 40 geändert"));
    put(repo, "daten/crlf.txt", changed);
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const diff = await core("diff_file", { repoId, path: "daten/crlf.txt", source: { kind: "unstaged" } });
    const text = diff.text ?? diff;
    check(Array.isArray(text.hunks) && text.hunks.length === 2, `the diff has two hunks (got ${text.hunks?.length})`);
    await core("discard_patch", { repoId, selection: { path: "daten/crlf.txt", hunks: [{ index: 1, lines: null }], expect: text.token } });
    const half = bytes(repo, "daten/crlf.txt");
    check(half.toString().includes("Zeile 3 geändert\r\n") && half.toString().endsWith("Zeile 40"), "only the second hunk is discarded, CRLF and missing final newline stay");
    await UNDO(repoId);
    equal(bytes(repo, "daten/crlf.txt").toString("hex"), changed.toString("hex"), "undo brings the discarded hunk back byte for byte");
  });

  await section("C07 Discard all with a foreign index.lock: error, nothing lost, no orphaned undo step", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    fs.writeFileSync(path.join(repo.path, ".git", "index.lock"), "");
    const result = await tryCore("discard_paths", { repoId, paths: null });
    fs.rmSync(path.join(repo.path, ".git", "index.lock"), { force: true });
    check(!result.ok && result.code === "locked", `discard reports "locked" (got ${JSON.stringify(result.code ?? "ok")})`);
    equal(state(repo), before, "nothing is discarded");
    equal((await peek(repoId)).undo, null, "there is no undo step for the failed action");
  });

  await section("C08 Discard all while a program holds a file open: nothing is lost without a way back", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    // Another program (editor, virus scanner) holds stationen.csv open exclusively.
    const holder = spawn("powershell", ["-NoProfile", "-Command", `$f=[System.IO.File]::Open('${abs(repo, "stationen.csv").replaceAll("'", "''")}','Open','ReadWrite','None'); Write-Output offen; Start-Sleep -Seconds 60`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    const result = await tryCore("discard_paths", { repoId, paths: null });
    holder.kill();
    spawnSync("taskkill", ["/PID", String(holder.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await sleep(500);
    note(`discard with locked file: ${result.ok ? "ok" : `${result.code}: ${result.message}`}`);
    if (JSON.stringify(state(repo)) !== JSON.stringify(before)) {
      // It was (partly) discarded: then undo must bring everything back.
      check((await peek(repoId)).undo?.action === "discard", "after a partial discard undo offers to revert it");
      await tryCore("undo", { repoId });
      equal(state(repo), before, "undo restores everything byte for byte after the partial discard");
    }
    check(noLock(repo), "no index.lock is left behind");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  // ===== Reset ===================================================================================

  await section("C10 Hard reset with uncommitted changes → undo → redo → undo byte for byte", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    const target = repo.git("rev-parse", "HEAD~1");
    await core("reset_branch", { repoId, sha: target, mode: "hard" });
    equal(repo.git("rev-parse", "HEAD"), target, "main is at the target commit");
    await UNDO(repoId);
    equal(state(repo), before, "undo restores branch, index and working tree byte for byte");
    await REDO(repoId);
    equal(repo.git("rev-parse", "HEAD"), target, "redo resets again");
    await UNDO(repoId);
    equal(state(repo), before, "undo after redo restores everything again");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C11 BUG L1-01 Hard reset → keep working → undo: new work must not disappear", async () => {
    // BUG L1-01 (second form)
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "vor dem Reset geändert\n");
    await core("reset_branch", { repoId, sha: repo.git("rev-parse", "HEAD~1"), mode: "hard" });
    put(repo, "notizen/nach-dem-reset.txt", "Diese Datei entstand NACH dem Reset.\n");
    await UNDO(repoId);
    equal(bytes(repo, "README.md").toString(), "vor dem Reset geändert\n", "undo brings back the change discarded by the reset");
    check(exists(repo, "notizen/nach-dem-reset.txt"), "the file created after the reset is still there after undo");
  });

  await section("C12 Hard reset → restart app → undo", async () => {
    const { repo } = await fresh();
    let repoId = (await core("repo_list")).find((entry) => path.resolve(entry.path).toLowerCase() === path.resolve(repo.path).toLowerCase())?.id;
    dirty(repo);
    const before = state(repo);
    await core("reset_branch", { repoId, sha: repo.git("rev-parse", "HEAD~2"), mode: "hard" });
    await restart();
    ({ repoId } = await openRepo(repo.path));
    await UNDO(repoId);
    equal(state(repo), before, "undo after restart restores everything byte for byte");
  });

  await section("C13 Mixed and soft reset → undo: index and files as before", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    await core("reset_branch", { repoId, sha: repo.git("rev-parse", "HEAD~1"), mode: "mixed" });
    equal(files(repo), before.files, "mixed reset touches no file");
    await UNDO(repoId);
    equal(state(repo), before, "undo of the mixed reset also restores the index");
    await core("reset_branch", { repoId, sha: repo.git("rev-parse", "HEAD~1"), mode: "soft" });
    equal(files(repo), before.files, "soft reset touches no file");
    await UNDO(repoId);
    equal(state(repo), before, "undo of the soft reset restores the state");
  });

  // ===== Checkout ================================================================================

  await section("C15 Checkout with local changes: never overwrite", async () => {
    const { repo, repoId } = await fresh();
    // feature/export brings src/export.py: an untracked file of the same name is in the way.
    put(repo, "src/export.py", "meine eigene, unverfolgte Fassung\n");
    put(repo, "README.md", "lokal geändert, kollidiert nicht\n");
    const before = state(repo);
    const blocked = await tryCore("branch_checkout", { repoId, target: "feature/export" });
    check(!blocked.ok && blocked.code === "dirty_worktree", `checkout is refused (got ${blocked.ok ? "ok" : blocked.code})`);
    check(!blocked.ok && /export\.py/.test(blocked.message), "the message names the file in the way");
    equal(state(repo), before, "nothing is changed");
    fs.rmSync(abs(repo, "src/export.py"));
    await core("branch_checkout", { repoId, target: "feature/export" });
    equal(bytes(repo, "README.md").toString(), "lokal geändert, kollidiert nicht\n", "a non-colliding change moves along to the other branch");
    await UNDO(repoId);
    equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "undo of the checkout goes back to main");
    equal(bytes(repo, "README.md").toString(), "lokal geändert, kollidiert nicht\n", "the change is still there after the undo");
  });

  // ===== Stash ===================================================================================

  await section("C20 Stash (with untracked) → pop → state byte for byte; stash → undo → redo → undo", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: "Zwischenstand", paths: null, includeUntracked: true });
    equal(statusText(repo), "", "after the stash the working tree is clean");
    check(exists(repo, "ausgabe/bericht.txt"), "the ignored file stays");
    await core("stash_pop", { repoId, index: 0 });
    equal(state(repo), before, "pop restores files and index (staged stays staged) byte for byte");
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: "Zwischenstand 2", paths: null, includeUntracked: true });
    await UNDO(repoId);
    equal(state(repo), before, "undo of the stash restores everything, the stash is gone");
    await REDO(repoId);
    equal(statusText(repo), "", "redo stashes again");
    equal(lines(repo.git("stash", "list")).length, 1, "one stash in the list");
    await UNDO(repoId);
    equal(state(repo), before, "undo after redo restores everything again");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C21 BUG L1-01 Stash pop → keep working → undo: new work must not disappear", async () => {
    // BUG L1-01 (third form)
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "im Stash geparkt\n");
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: "geparkt", paths: null, includeUntracked: true });
    await core("stash_pop", { repoId, index: 0 });
    put(repo, "notizen/nach-dem-pop.txt", "Diese Datei entstand NACH dem Pop.\n");
    put(repo, "stationen.csv", "nach dem Pop geändert\n");
    await UNDO(repoId);
    equal(lines(repo.git("stash", "list")).length, 1, "undo puts the stash back into the list");
    const fileKept = check(exists(repo, "notizen/nach-dem-pop.txt"), "the file created after the pop is still there after undo");
    const editKept = check(bytes(repo, "stationen.csv").toString() === "nach dem Pop geändert\n", "the change to stationen.csv made after the pop is still there after undo");
    if (!fileKept || !editKept) note(`status after undo: ${JSON.stringify(statusText(repo))}`);
  });

  await section("C22 Stash pop with conflict: stash stays, nothing is lost, way out without loss", async () => {
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "# Messnetz\n\nFassung aus dem Stash.\n");
    put(repo, "notizen/aus-dem-stash.txt", "unverfolgt im Stash\n");
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: "kollidiert", paths: null, includeUntracked: true });
    const stashSha = repo.git("rev-parse", "stash@{0}");
    put(repo, "README.md", "# Messnetz\n\nInzwischen committete Fassung.\n");
    repo.git("commit", "-q", "-am", "README umgeschrieben");
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const result = await core("stash_pop", { repoId, index: 0 });
    equal(result.status, "conflict", "pop reports the conflict");
    equal(repo.git("rev-parse", "stash@{0}"), stashSha, "the stash stays unchanged in the list");
    check(bytes(repo, "README.md").toString().includes("<<<<<<<"), "README.md has conflict markers");
    check(exists(repo, "notizen/aus-dem-stash.txt"), "the untracked file from the stash is created");
    // Way out: taking "our" side brings back the state before the pop.
    await core("conflict_resolve", { repoId, path: "README.md", content: null, side: "ours" });
    equal(bytes(repo, "README.md").toString(), "# Messnetz\n\nInzwischen committete Fassung.\n", "\"ours\" restores the committed version");
    equal(repo.git("rev-parse", "stash@{0}"), stashSha, "the stash is still there");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C23 Stash pop/apply when an untracked file of the stash already exists: refused, nothing touched", async () => {
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "geändert im Stash\n");
    put(repo, "notizen/plan.txt", "Fassung im Stash\n");
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: null, paths: null, includeUntracked: true });
    put(repo, "notizen/plan.txt", "NEUE Fassung, nach dem Stash geschrieben\n");
    const before = state(repo);
    for (const command of ["stash_pop", "stash_apply"]) {
      const result = await tryCore(command, { repoId, index: 0 });
      check(!result.ok && result.code === "dirty_worktree", `${command} is refused (got ${result.ok ? JSON.stringify(result.value) : result.code})`);
      check(!result.ok && /plan\.txt/.test(result.message), `${command}: the message names the file`);
      equal(state(repo), before, `${command}: nothing is changed, the stash stays`);
    }
  });

  await section("C24 Stash pop onto local changes to the same file: refused, nothing touched", async () => {
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "Fassung im Stash\n");
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: null, paths: null, includeUntracked: false });
    put(repo, "README.md", "lokal weitergearbeitet, nicht committet\n");
    const before = state(repo);
    const result = await tryCore("stash_pop", { repoId, index: 0 });
    check(!result.ok || result.value.status === "conflict", `pop does not overwrite silently (got ${JSON.stringify(result.ok ? result.value : result.code)})`);
    if (!result.ok) equal(state(repo), before, "nothing is changed, the stash stays");
    else check(bytes(repo, "README.md").toString().includes("lokal weitergearbeitet"), "the local version is still in the file");
    equal(lines(repo.git("stash", "list")).length, 1, "the stash stays in the list");
  });

  await section("C25 Double click: stash_create twice with the same opId, stash_pop twice at once", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    const opId = crypto.randomUUID();
    const args = { repoId, opId, message: "doppelt", paths: null, includeUntracked: true };
    const both = await Promise.all([tryCore("stash_create", args), tryCore("stash_create", args)]);
    equal(lines(repo.git("stash", "list")).length, 1, "two simultaneous calls with the same opId yield exactly one stash");
    check(both.filter((result) => result.ok).length >= 1 && both.every((result) => result.ok || result.code === "duplicate"), `one call succeeds, the other succeeds too or ends with "duplicate" (${both.map((result) => (result.ok ? "ok" : result.code)).join(" | ")})`);
    const pops = await Promise.all([tryCore("stash_pop", { repoId, index: 0 }), tryCore("stash_pop", { repoId, index: 0 })]);
    equal(pops.filter((result) => result.ok && result.value.status === "done").length, 1, "of two simultaneous pops exactly one succeeds");
    equal(state(repo), before, "afterwards everything is byte for byte as before the stash");
    equal(lines(repo.git("stash", "list")).length, 0, "the stash list is empty");
  });

  await section("C26 Rename stash and undo pop with three stashes: order and contents stay", async () => {
    const { repo, repoId } = await fresh();
    for (const name of ["eins", "zwei", "drei"]) {
      put(repo, `notizen/${name}.txt`, `Stash ${name}\n`);
      put(repo, "README.md", `README im Stash ${name}\n`);
      await core("stash_create", { repoId, opId: crypto.randomUUID(), message: name, paths: null, includeUntracked: true });
    }
    const shas = lines(repo.git("stash", "list", "--format=%H"));
    await core("stash_rename", { repoId, index: 1, message: "zwei, umbenannt" });
    equal(lines(repo.git("stash", "list", "--format=%H")), shas, "after renaming the middle stash the same three commits are listed in the same order");
    equal(lines(repo.git("stash", "list", "--format=%gs"))[1], "On main: zwei, umbenannt", "the middle one has the new text");
    await core("stash_pop", { repoId, index: 1 });
    equal(lines(repo.git("stash", "list", "--format=%H")), [shas[0], shas[2]], "popping the middle one leaves the other two");
    await UNDO(repoId);
    equal(lines(repo.git("stash", "list", "--format=%H")), shas, "undo puts the stash back in its old place");
    equal(statusText(repo), "", "and the working tree is clean again");
    equal(undoRefs(repo).filter((name) => name.includes("stash-rebuild")), [], "no holding refs of the rebuild are left behind");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  // ===== Undo/redo chains ========================================================================

  await section("C30 Commit → undo → redo → undo; amend → undo: contents stay staged", async () => {
    const { repo, repoId } = await fresh();
    const head0 = repo.git("rev-parse", "HEAD");
    put(repo, "README.md", "erste Änderung\n");
    put(repo, "notizen/bleibt-unverfolgt.txt", "nie gestaged\n");
    repo.git("add", "README.md");
    const commit = (summary, amend = false) => core("commit_create", { repoId, opId: crypto.randomUUID(), summary, description: "", amend, skipHooks: false, pushAfter: false, stageAll: false });
    await commit("Erste Änderung");
    const head1 = repo.git("rev-parse", "HEAD");
    await UNDO(repoId);
    equal(repo.git("rev-parse", "HEAD"), head0, "undo reverts the commit");
    equal(repo.git("diff", "--cached", "--name-only"), "README.md", "the change is staged again");
    await REDO(repoId);
    equal(repo.git("rev-parse", "HEAD"), head1, "redo restores the same commit");
    put(repo, "README.md", "zweite Änderung\n");
    repo.git("add", "README.md");
    await commit("Erste Änderung, nachgebessert", true);
    const head2 = repo.git("rev-parse", "HEAD");
    await UNDO(repoId);
    equal(repo.git("rev-parse", "HEAD"), head1, "undo of the amend goes to the commit before");
    equal(bytes(repo, "README.md").toString(), "zweite Änderung\n", "the amended version is still in the file");
    equal(repo.git("diff", "--cached", "--name-only"), "README.md", "and is staged");
    await REDO(repoId);
    equal(repo.git("rev-parse", "HEAD"), head2, "redo restores the amend commit");
    await UNDO(repoId);
    await UNDO(repoId);
    equal(repo.git("rev-parse", "HEAD"), head0, "two undos go back to the start");
    equal(bytes(repo, "notizen/bleibt-unverfolgt.txt").toString(), "nie gestaged\n", "the untracked file was never touched");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C31 Undo after an outside change: a foreign commit is never reverted", async () => {
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "über die App committet\n");
    await core("commit_create", { repoId, opId: crypto.randomUUID(), summary: "Aus der App", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: true });
    // Another commit is added in a terminal.
    put(repo, "stationen.csv", "im Terminal committet\n");
    repo.git("commit", "-q", "-am", "Aus dem Terminal");
    const outside = repo.git("rev-parse", "HEAD");
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const step = (await peek(repoId)).undo;
    const result = await tryCore("undo", { repoId });
    equal(repo.git("rev-parse", "HEAD"), outside, "the commit from the terminal is still there");
    check(step === null && !result.ok, `undo offers nothing and does nothing (peek: ${JSON.stringify(step)}, result: ${result.ok ? "ok" : result.code})`);
  });

  await section("C32 Two undos at once (double click): exactly two steps, nothing damaged", async () => {
    const { repo, repoId } = await fresh();
    const head0 = repo.git("rev-parse", "HEAD");
    for (const text of ["eins", "zwei"]) {
      put(repo, "README.md", `${text}\n`);
      await core("commit_create", { repoId, opId: crypto.randomUUID(), summary: `Commit ${text}`, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: true });
    }
    const both = await Promise.all([tryCore("undo", { repoId }), tryCore("undo", { repoId })]);
    check(both.every((result) => result.ok), `both undos end without error (${both.map((result) => (result.ok ? "ok" : result.code)).join(", ")})`);
    equal(repo.git("rev-parse", "HEAD"), head0, "two undos revert exactly the two commits");
    equal(bytes(repo, "README.md").toString(), "zwei\n", "the content of the last commit is still in the file");
    check(noLock(repo), "no index.lock is left behind");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C33 Delete a branch with unmerged commits: only with force, undo brings it back – even after restart", async () => {
    const { repo } = await fresh();
    let repoId = (await core("repo_list")).find((entry) => path.resolve(entry.path).toLowerCase() === path.resolve(repo.path).toLowerCase())?.id;
    repo.git("checkout", "-q", "-b", "experiment/lokal");
    put(repo, "notizen/experiment.txt", "nur auf diesem Branch\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Experiment, nie gepusht");
    const tip = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "main");
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const soft = await tryCore("branch_delete", { repoId, names: ["experiment/lokal"], force: false });
    check(!soft.ok && soft.code === "not_merged", `without force the deletion is refused (got ${soft.ok ? "ok" : soft.code})`);
    await core("branch_delete", { repoId, names: ["experiment/lokal"], force: true });
    equal(repo.git("branch", "--list", "experiment/lokal"), "", "the branch is deleted");
    check(repo.git("for-each-ref", "--contains", tip, "--format=%(refname)").includes("refs/forkyard/undo/"), "a backup ref holds the commits");
    repo.git("gc", "--prune=now", "-q");
    await restart();
    ({ repoId } = await openRepo(repo.path));
    await UNDO(repoId);
    equal(repo.git("rev-parse", "experiment/lokal"), tip, "undo (after gc and restart) recreates the branch at the old commit");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C34 Revert merge, rebase, cherry-pick with uncommitted changes: refused or lossless", async () => {
    const { repo, repoId } = await fresh();
    const head0 = repo.git("rev-parse", "HEAD");
    await core("merge_start", { repoId, source: "feature/export", mode: "no_ff" });
    check(repo.git("rev-parse", "HEAD") !== head0, "the merge is there");
    put(repo, "README.md", "nach dem Merge lokal geändert\n");
    put(repo, "notizen/nach-dem-merge.txt", "unverfolgt\n");
    const before = state(repo);
    const result = await tryCore("undo", { repoId });
    if (result.ok) {
      equal(repo.git("rev-parse", "HEAD"), head0, "undo reverted the merge");
      equal(bytes(repo, "README.md").toString(), "nach dem Merge lokal geändert\n", "the local change was kept");
      check(exists(repo, "notizen/nach-dem-merge.txt"), "the untracked file was kept");
    } else {
      equal(result.code, "dirty_worktree", "undo refuses with \"dirty_worktree\"");
      equal(state(repo), before, "and touches nothing");
    }
  });

  // ===== Aborting merge / rebase / cherry-pick ==================================================

  /** Creates one commit each on main and feature/export that collide in stationen.csv. */
  function makeCollision(repo) {
    repo.git("checkout", "-q", "feature/export");
    put(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord (Feature);41\nS;Schule Süd;37\nH;Hafen;3\n");
    put(repo, "src/export.py", `${bytes(repo, "src/export.py").toString()}\n# vom Feature ergänzt\n`);
    repo.git("commit", "-q", "-am", "Feature: Nord umbenannt");
    repo.git("checkout", "-q", "main");
    put(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord (Main);41\nS;Schule Süd;37\nH;Hafen;3\n");
    repo.git("commit", "-q", "-am", "Main: Nord umbenannt");
  }

  await section("C40 Merge with conflict + extra unstaged work → abort: extra work stays", async () => {
    const { repo, repoId } = await fresh();
    makeCollision(repo);
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const merge = await core("merge_start", { repoId, source: "feature/export", mode: "default" });
    equal(merge.status, "conflict", "the merge stops with a conflict");
    put(repo, "README.md", "während des Merges zusätzlich geändert (nicht gestaged)\n");
    put(repo, "notizen/waehrend-merge.txt", "während des Merges neu angelegt\n");
    await core("operation_abort", { repoId });
    equal(bytes(repo, "README.md").toString(), "während des Merges zusätzlich geändert (nicht gestaged)\n", "the unstaged change to an uninvolved file survives the abort");
    check(exists(repo, "notizen/waehrend-merge.txt"), "the newly created file survives the abort");
    equal(repo.git("status", "--porcelain=v1", "--untracked-files=no"), " M README.md", "otherwise everything is as before the merge");
  });

  await section("C41 BUG L1-03 Merge with conflict + extra STAGED work → abort: must not disappear without a way back", async () => {
    // BUG L1-03
    const { repo, repoId } = await fresh();
    makeCollision(repo);
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await core("merge_start", { repoId, source: "feature/export", mode: "default" });
    // During the conflict the user keeps working on an uninvolved file and stages it
    // (or presses "Stage all").
    const extra = "während des Merges zusätzlich geändert UND gestaged\n";
    put(repo, "README.md", extra);
    await core("stage_paths", { repoId, paths: ["README.md"] });
    await core("operation_abort", { repoId });
    const kept = exists(repo, "README.md") && bytes(repo, "README.md").toString() === extra;
    const undo = (await peek(repoId)).undo;
    const reachable = undoRefs(repo).length > 0;
    note(`after the abort: README.md ${kept ? "kept" : "reset to HEAD"}, undo: ${JSON.stringify(undo)}, backup refs: ${undoRefs(repo).length}`);
    check(kept || undo !== null || reachable, "the extra staged work is still there after the abort OR can be recovered via undo/backup");
    if (!(kept || undo !== null || reachable)) await shot(`${BUGS}/L1-03.png`);
  });

  await section("C42 BUG L1-03 Rebase with conflict + extra work on an uninvolved file → abort: must not disappear without a way back", async () => {
    // BUG L1-03 (rebase: git rebase --abort resets hard)
    const { repo, repoId } = await fresh();
    makeCollision(repo);
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const rebase = await core("rebase_start", { repoId, onto: "feature/export", branch: null });
    equal(rebase.status, "conflict", "the rebase stops with a conflict");
    const extra = "während des Rebase zusätzlich geändert (nicht gestaged)\n";
    put(repo, "README.md", extra);
    put(repo, "notizen/waehrend-rebase.txt", "während des Rebase neu angelegt\n");
    await core("operation_abort", { repoId });
    check(exists(repo, "notizen/waehrend-rebase.txt"), "the newly created (untracked) file survives the abort");
    const kept = bytes(repo, "README.md").toString() === extra;
    const undo = (await peek(repoId)).undo;
    note(`after the abort: README.md ${kept ? "kept" : "reset to HEAD"}, undo: ${JSON.stringify(undo)}, backup refs: ${undoRefs(repo).length}`);
    check(kept || undo !== null || undoRefs(repo).length > 0, "the extra work on README.md is still there after the abort OR can be recovered via undo/backup");
  });

  await section("C43 Cherry-pick with conflict + extra unstaged work → abort: extra work stays", async () => {
    const { repo, repoId } = await fresh();
    makeCollision(repo);
    await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const pick = await core("cherry_pick", { repoId, shas: [repo.git("rev-parse", "feature/export")] });
    equal(pick.status, "conflict", "the cherry-pick stops with a conflict");
    const extra = "während des Cherry-Picks zusätzlich geändert (nicht gestaged)\n";
    put(repo, "README.md", extra);
    await core("operation_abort", { repoId });
    equal(bytes(repo, "README.md").toString(), extra, "the unstaged change to an uninvolved file survives the abort");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  // ===== File editor (file-view) =======================================================================

  const fileViewScreen = '[data-screen="file-view"]';
  const page = () => app.page;
  async function openInEditor(tabId, file) {
    await page().evaluate(([tab, rel]) => window.__gc.store.getState().openFile(tab, rel, null, "edit"), [tabId, file]);
    await page().waitForFunction(
      (label) => {
        const root = document.querySelector('[data-screen="file-view"]');
        return root?.getAttribute("aria-label") === label && !root.querySelector("[data-loading]") && Boolean(root.querySelector(".cm-content"));
      },
      `File ${file}`,
      { timeout: 30_000 },
    );
    await app.settle();
  }
  const dirtyState = () => page().locator(fileViewScreen).getAttribute("data-dirty-state", { timeout: 2000 }).catch(() => null);
  async function typeAtStart(text) {
    await page().locator(`${fileViewScreen} .cm-content`).click();
    await page().keyboard.press("Control+Home");
    await page().keyboard.type(text);
    await eventually(dirtyState, (value) => value === "dirty", "after typing the editor shows \"unsaved\"");
  }
  const dialogTitles = () => page().locator('[role="dialog"], [role="alertdialog"]').evaluateAll((list) => list.map((dialog) => dialog.querySelector("h2")?.textContent ?? dialog.getAttribute("aria-label") ?? ""));
  const dialogText = () => page().locator('[role="dialog"], [role="alertdialog"]').first().innerText({ timeout: 3000 }).catch(() => "");
  const refocus = async () => {
    await page().evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
  };
  /**
   * Closes the main window the way the window's × button would: WM_CLOSE to the app's window
   * (invisible in the test – `taskkill` without /F does not reach it). Returns the window class.
   */
  function closeMainWindow(pid) {
    const script = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class GcWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Close(uint want) {
    string hit = "";
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == want) { var c = new StringBuilder(256); GetClassName(h, c, 256); if (c.ToString() == "Tauri Window") { hit = c.ToString(); PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); } } return true; }, IntPtr.Zero);
    return hit;
  }
}
"@
[GcWin]::Close(${pid})
`;
    return (spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout ?? "").trim() || "no window found";
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  };

  await section("C50 Editor: insert a character and save – encoding, BOM, line endings and end of file byte for byte", async () => {
    const { repo, tabId } = await fresh();
    const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const samples = [
      { file: "probe/lf.txt", original: Buffer.from("eins\nzwei\n"), expected: Buffer.from("Xeins\nzwei\n") },
      { file: "probe/crlf.txt", original: Buffer.from("eins\r\nzwei\r\n"), expected: Buffer.from("Xeins\r\nzwei\r\n") },
      { file: "probe/ohne-ende.txt", original: Buffer.from("eins\r\nzwei"), expected: Buffer.from("Xeins\r\nzwei") },
      { file: "probe/bom.txt", original: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("größe\nmaß\n")]), expected: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Xgröße\nmaß\n")]) },
      { file: "probe/utf16.txt", original: utf16("größe\r\nmaß\r\n"), expected: utf16("Xgröße\r\nmaß\r\n") },
      { file: "probe/latin1.txt", original: Buffer.from("Größe;Maß\n°C;µm\n", "latin1"), expected: Buffer.from("XGröße;Maß\n°C;µm\n", "latin1") },
      { file: "probe/leerraum.txt", original: Buffer.from("a\t \n  b  \n\n\n\tc"), expected: Buffer.from("Xa\t \n  b  \n\n\n\tc") },
      { file: "probe/sonderzeichen.txt", original: Buffer.from("a b c​d﻿e\n𝄞 \u0001 ende\n"), expected: Buffer.from("Xa b c​d﻿e\n𝄞 \u0001 ende\n") },
      { file: "probe/kaputtes-utf8.txt", original: Buffer.concat([Buffer.from("gültig äöü\n"), Buffer.from([0xff, 0x81, 0x0a])]), expected: Buffer.concat([Buffer.from("Xgültig äöü\n"), Buffer.from([0xff, 0x81, 0x0a])]) },
    ];
    for (const sample of samples) put(repo, sample.file, sample.original);
    await refocus();
    for (const sample of samples) {
      await openInEditor(tabId, sample.file);
      await typeAtStart("X");
      await page().keyboard.press("Control+s");
      await eventually(dirtyState, (value) => value === "clean", `${sample.file}: after Ctrl+S nothing is unsaved`);
      const now = bytes(repo, sample.file);
      check(now.equals(sample.expected), `${sample.file}: byte for byte (expected ${sample.expected.toString("hex")}, got ${now.toString("hex")})`);
    }
  });

  await section("C51 BUG L1-06 Editor: lone carriage returns (CR) in a file survive saving", async () => {
    // BUG L1-06
    const { repo, tabId } = await fresh();
    const original = Buffer.from("spalte;wert\nfortschritt: 10%\r20%\r30%;ok\nende\n");
    put(repo, "probe/cr.csv", original);
    await refocus();
    await openInEditor(tabId, "probe/cr.csv");
    const footer = await page().locator(`${fileViewScreen} [data-footer-menu="eol"]`).innerText().catch(() => "");
    await typeAtStart("X");
    await page().keyboard.press("Control+s");
    await eventually(dirtyState, (value) => value === "clean", "after Ctrl+S nothing is unsaved");
    const now = bytes(repo, "probe/cr.csv");
    const expected = Buffer.concat([Buffer.from("X"), original]);
    note(`footer line endings: "${footer}"; saved: ${JSON.stringify(now.toString())}`);
    if (!check(now.equals(expected), `lone CRs are kept (expected ${JSON.stringify(expected.toString())}, got ${JSON.stringify(now.toString())})`)) await shot(`${BUGS}/L1-06.png`);
  });

  await section("C52 Editor: mixed line endings – saving normalizes only with a visible hint", async () => {
    const { repo, tabId } = await fresh();
    const original = Buffer.from("eins\r\nzwei\ndrei\r\nvier\r\n");
    put(repo, "probe/gemischt.txt", original);
    await refocus();
    await openInEditor(tabId, "probe/gemischt.txt");
    const footer = await page().locator(`${fileViewScreen} [data-footer-menu="eol"]`).innerText().catch(() => "");
    await typeAtStart("X");
    await page().keyboard.press("Control+s");
    await eventually(dirtyState, (value) => value === "clean", "after Ctrl+S nothing is unsaved");
    const now = bytes(repo, "probe/gemischt.txt");
    const exact = now.equals(Buffer.concat([Buffer.from("X"), original]));
    note(`footer: "${footer}"; saved ${exact ? "byte for byte" : `normalized: ${JSON.stringify(now.toString())}`}`);
    check(exact || /Mixed\s*→/.test(footer), "either byte for byte, or the footer announces the normalization (\"Mixed → …\")");
    check(now.toString().replace(/\r\n/g, "\n") === "Xeins\nzwei\ndrei\nvier\n", "the text itself is unchanged");
  });

  await section("C53 BUG L1-04 Editor: unsaved text – closing the tab and quitting the app only after a confirmation", async () => {
    // BUG L1-04
    const { repo, tabId } = await fresh();
    const original = bytes(repo, "README.md");
    await openInEditor(tabId, "README.md");
    await typeAtStart("EINE STUNDE ARBEIT, NICHT GESPEICHERT ");
    await shot(`${BUGS}/L1-04-before.png`);
    // 1. Close the tab (× button on the tab).
    await page().getByRole("button", { name: "Close messnetz" }).first().click();
    await sleep(1200);
    const asked = await dialogTitles();
    const tabGone = (await page().locator(`[data-tab-id="${tabId}"]`).count()) === 0;
    const promptOnTab = check(asked.length > 0 && !tabGone, `closing the tab with unsaved text asks first (dialogs: ${JSON.stringify(asked)}, tab ${tabGone ? "is closed" : "is still there"})`);
    if (!promptOnTab) await shot(`${BUGS}/L1-04.png`);
    check(bytes(repo, "README.md").equals(original), "the file on disk is unchanged (nothing was saved silently)");
    // 2. Quit the app (close the window, like the window's × button): only after a confirmation.
    for (let round = 0; round < 3 && (await dialogTitles()).length > 0; round++) await page().keyboard.press("Escape");
    if (tabGone) {
      const again = await openRepo(repo.path);
      await openInEditor(again.tabId, "README.md");
      const restored = (await page().locator(`${fileViewScreen} .cm-content`).innerText()).includes("EINE STUNDE ARBEIT");
      note(`after reopening the repository the draft is ${restored ? "back in the editor (only in the running app's memory)" : "NO longer in the editor"}`);
      if (!restored) await typeAtStart("EINE STUNDE ARBEIT, NICHT GESPEICHERT ");
    }
    const pid = app.pid;
    const windows = closeMainWindow(pid);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && alive(pid)) await sleep(200);
    const exited = !alive(pid);
    note(`close window (WM_CLOSE to "${windows}") → app ${exited ? "quit without asking" : "is still running"}`);
    if (exited) {
      check(false, "quitting the app with unsaved text asks first – the app quit immediately");
    } else {
      const titles = await dialogTitles().catch(() => []);
      check(titles.length > 0, `the app is still running and shows a confirmation (dialogs: ${JSON.stringify(titles)})`);
      // Answer the confirmation like a user who wants to keep their text: "Save and quit".
      // Then the app quits on its own and the text is in the file.
      if (titles.length > 0) {
        await page().getByRole("button", { name: /Save and quit/ }).first().click();
        const until = Date.now() + 20_000;
        while (Date.now() < until && alive(pid)) await sleep(200);
        check(!alive(pid), "after \"Save and quit\" the app has quit");
      }
    }
    await restart();
    const after = await openRepo(repo.path);
    await openInEditor(after.tabId, "README.md");
    const text = await page().locator(`${fileViewScreen} .cm-content`).innerText();
    check(text.includes("EINE STUNDE ARBEIT") || bytes(repo, "README.md").toString().includes("EINE STUNDE ARBEIT"), "after the restart the typed text is still there (in the editor as a draft or in the file)");
  });

  await section("C54 Editor: leave a draft, file changes outside, reopen → warning before overwriting", async () => {
    const { repo, tabId } = await fresh();
    await openInEditor(tabId, "README.md");
    await typeAtStart("ENTWURF ");
    await page().evaluate((tab) => window.__gc.store.getState().closeCenter(tab), tabId);
    await app.settle();
    equal(await dialogTitles(), [], "leaving the view does not ask (the draft stays in memory)");
    put(repo, "README.md", "Von außen komplett neu geschrieben (z. B. durch einen Pull).\n");
    await refocus();
    await openInEditor(tabId, "README.md");
    const body = await page().locator(fileViewScreen).innerText();
    check(body.includes("Unsaved changes from earlier"), "the hint about the restored draft is shown");
    await eventually(() => page().locator(fileViewScreen).innerText(), (value) => typeof value === "string" && value.includes("changed outside the app"), "the warning \"The file was changed outside the app\" is shown");
    equal(bytes(repo, "README.md").toString(), "Von außen komplett neu geschrieben (z. B. durch einen Pull).\n", "the outside version is still on disk");
    // Cleanup: discard the draft so the next section does not inherit it.
    await page().locator(fileViewScreen).getByRole("button", { name: "Reload" }).click();
  });

  // ===== Submodule, worktree, tag =================================================================

  const gitConfigFile = path.join(workDir, "gitconfig");
  fs.writeFileSync(gitConfigFile, globalGitConfig());
  const rawGit = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env: { ...process.env, ...gitIsolationEnv(gitConfigFile) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      .toString("utf8")
      .replace(/\r?\n$/, "");
  const rawGitOk = (cwd, ...args) => {
    try {
      rawGit(cwd, ...args);
      return true;
    } catch {
      return false;
    }
  };
  /** Runs a UI action (app module, as a menu entry would) – without waiting for it to finish. */
  const uiAction = (module, name, ...args) =>
    page().evaluate(
      ([file, fn, list]) => {
        void import(file).then((loaded) => loaded[fn](...list));
      },
      [`/src/app/actions/${module}.ts`, name, args],
    );
  async function waitDialog(pattern, timeout = 20_000) {
    const dialog = page().locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: pattern }).first();
    await dialog.waitFor({ timeout });
    return dialog;
  }

  /** Main project with submodule libs/werkzeug (own bare remote). Returns paths. */
  function addSubmodule(repo) {
    const bare = path.join(repo.root, "werkzeug.git");
    const seed = path.join(repo.root, "werkzeug-seed");
    rawGit(repo.root, "init", "-q", "--bare", "-b", "main", bare);
    rawGit(repo.root, "init", "-q", "-b", "main", seed);
    put(seed, "werkzeug.py", "def hilf():\n    return 1\n");
    rawGit(seed, "add", "-A");
    rawGit(seed, "commit", "-q", "-m", "Werkzeug angelegt");
    rawGit(seed, "push", "-q", bare, "main");
    repo.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", bare, "libs/werkzeug");
    repo.git("commit", "-q", "-m", "Submodul libs/werkzeug");
    return { bare, sub: path.join(repo.path, "libs", "werkzeug") };
  }

  await section("C60 BUG L1-05 Remove submodule: unpushed commits of the submodule must not disappear without a warning", async () => {
    // BUG L1-05
    const repo = makeCleanRepoWithRemote();
    repos.push(repo);
    const { bare, sub } = addSubmodule(repo);
    // Work is committed in the submodule – never pushed. The main project records the new commit.
    put(sub, "auswertung.py", "# drei Tage Arbeit, nur lokal im Submodul committet\n");
    rawGit(sub, "add", "-A");
    rawGit(sub, "commit", "-q", "-m", "Auswertung – nur lokal, nie gepusht");
    const localSha = rawGit(sub, "rev-parse", "HEAD");
    repo.git("add", "libs/werkzeug");
    repo.git("commit", "-q", "-m", "Submodul auf den neuen Stand");
    check(!rawGitOk(bare, "cat-file", "-e", `${localSha}^{commit}`), "setup: the submodule's remote does not know the commit");
    const { repoId } = await openRepo(repo.path);
    const listed = (await core("submodule_list", { repoId })).find((item) => item.path === "libs/werkzeug");
    note(`state according to the app: ${listed?.state}`);
    // Remove through the UI: confirm the first dialog.
    await uiAction("submodules", "removeSubmodule", repoId, listed);
    const first = await waitDialog(/Remove submodule “libs\/werkzeug”\?/);
    const firstText = (await first.innerText()).replace(/\s+/g, " ");
    await first.getByRole("button", { name: "Remove submodule" }).click();
    await sleep(1500);
    const second = await dialogTitles();
    note(`first confirmation: "${firstText.slice(0, 260)}"; second confirmation: ${JSON.stringify(second)}`);
    const warned = /not pushed|unpushed|are lost|lost for good/i.test(firstText) || second.length > 0;
    if (second.length > 0) {
      await shot(`${BUGS}/L1-05-warning.png`);
      await page().keyboard.press("Escape");
    }
    await eventually(async () => (await core("submodule_list", { repoId })).length, (count) => count === 0 || second.length > 0, "the submodule is removed (or a warning stops it)");
    const stillSomewhere =
      (fs.existsSync(sub) && rawGitOk(sub, "cat-file", "-e", `${localSha}^{commit}`)) ||
      rawGitOk(repo.path, "cat-file", "-e", `${localSha}^{commit}`) ||
      fs.existsSync(path.join(repo.path, ".git", "modules", "libs", "werkzeug")) ||
      rawGitOk(bare, "cat-file", "-e", `${localSha}^{commit}`);
    note(`after removing: commit ${localSha.slice(0, 7)} ${stillSomewhere ? "still present" : "present nowhere"}; undo: ${JSON.stringify((await peek(repoId)).undo)}`);
    if (!check(warned || stillSomewhere, "unpushed commits in the submodule: the app warns explicitly OR the commits are kept")) await shot(`${BUGS}/L1-05.png`);
  });

  await section("C61 Submodule with an untracked file or its own change: removing without force is refused", async () => {
    const repo = makeCleanRepoWithRemote();
    repos.push(repo);
    const { sub } = addSubmodule(repo);
    put(sub, "notiz-unverfolgt.txt", "liegt nur im Submodul\n");
    const { repoId } = await openRepo(repo.path);
    const result = await tryCore("submodule_remove", { repoId, path: "libs/werkzeug" });
    check(!result.ok && result.code === "dirty_worktree", `removing is refused (got ${result.ok ? "ok" : result.code})`);
    check(fs.existsSync(path.join(sub, "notiz-unverfolgt.txt")), "the file in the submodule is still there");
  });

  await section("C62 Remove worktree: with changes or untracked files only with force", async () => {
    const { repo, repoId } = await fresh();
    const dirtyTree = path.join(repo.root, "wt-geändert");
    const untrackedTree = path.join(repo.root, "wt-unverfolgt");
    await core("worktree_add", { repoId, path: dirtyTree, branch: "wt/eins", newBranch: true, start: null });
    await core("worktree_add", { repoId, path: untrackedTree, branch: "wt/zwei", newBranch: true, start: null });
    put(dirtyTree, "README.md", "im Worktree geändert\n");
    put(untrackedTree, "neu.txt", "im Worktree neu\n");
    for (const tree of [dirtyTree, untrackedTree]) {
      const result = await tryCore("worktree_remove", { repoId, path: tree, force: false });
      check(!result.ok && result.code === "dirty_worktree", `${path.basename(tree)}: removing without force is refused (got ${result.ok ? "ok" : result.code})`);
      check(fs.existsSync(tree), `${path.basename(tree)}: the folder is still there`);
    }
    // Detached worktree with its own commit: the UI confirmation names the risk ("can then only be reached by their SHA").
    const detached = path.join(repo.root, "wt-losgelöst");
    await core("worktree_add", { repoId, path: detached, branch: "origin/feature/export", newBranch: false, start: null });
    put(detached, "nur-hier.txt", "Commit auf losgelöstem HEAD\n");
    rawGit(detached, "add", "-A");
    rawGit(detached, "commit", "-q", "-m", "Nur im losgelösten Worktree");
    const sha = rawGit(detached, "rev-parse", "HEAD");
    const removed = await tryCore("worktree_remove", { repoId, path: detached, force: false });
    const refsWith = repo.git("for-each-ref", "--contains", sha, "--format=%(refname)");
    note(`detached worktree with commit ${sha.slice(0, 7)}: removing ${removed.ok ? "succeeds without force" : `refused (${removed.code})`}; reachable from refs afterwards: ${refsWith || "no"}; object present: ${rawGitOk(repo.path, "cat-file", "-e", sha)}`);
    check(!removed.ok || rawGitOk(repo.path, "cat-file", "-e", sha), "after removing, the commit is at least still present as an object");
  });

  await section("C63 BUG L1-07 Delete tag: the confirmation promises \"commits are kept\" – not true if only the tag holds them", async () => {
    // BUG L1-07
    const { repo, repoId } = await fresh();
    repo.git("checkout", "-q", "-b", "versuch");
    put(repo, "versuch.txt", "nur über den Tag erreichbar\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Versuch, der nur am Tag hängt");
    const sha = repo.git("rev-parse", "HEAD");
    repo.git("tag", "-a", "versuch-1", "-m", "Ausführliche Notiz zum Versuch, drei Absätze lang.");
    repo.git("checkout", "-q", "main");
    repo.git("branch", "-q", "-D", "versuch");
    await refocus();
    equal(repo.git("for-each-ref", "--contains", sha, "--format=%(refname)"), "refs/tags/versuch-1", "setup: only the tag holds the commit");
    await uiAction("tags", "deleteTag", repoId, "versuch-1", null);
    const dialog = await waitDialog(/Delete tag “versuch-1”\?/);
    const text = (await dialog.innerText()).replace(/\s+/g, " ");
    await shot(`${BUGS}/L1-07.png`);
    await dialog.getByRole("button", { name: "Delete tag" }).click();
    await eventually(() => repo.git("tag", "--list", "versuch-1"), (value) => value === "", "the tag is deleted");
    const holders = repo.git("for-each-ref", "--contains", sha, "--format=%(refname)");
    note(`confirmation: "${text.slice(0, 220)}"; refs holding the commit afterwards: ${holders || "none"}; undo: ${JSON.stringify((await peek(repoId)).undo)}`);
    check(!/are kept/.test(text) || holders !== "", "the confirmation only promises that commits \"are kept\" if a ref still holds them afterwards");
  });

  // ===== Force Push ===============================================================================

  async function runCommand(text, commandId) {
    await page().keyboard.press("Control+p");
    const input = page().locator('[data-screen="command-palette"] input[role="combobox"]');
    await input.waitFor({ timeout: 10_000 });
    await page().keyboard.type(`>${text}`, { delay: 5 });
    const keys = () => page().locator('[data-screen="command-palette"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.dataset.key));
    await eventually(keys, (list) => Array.isArray(list) && list.includes(`command:${commandId}`), `the palette finds "${text}"`);
    const index = (await keys()).indexOf(`command:${commandId}`);
    for (let step = 0; step < index; step++) await page().keyboard.press("ArrowDown");
    await page().keyboard.press("Enter");
  }
  const commit = (repoId, summary, extra = {}) => core("commit_create", { repoId, opId: crypto.randomUUID(), summary, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: true, ...extra });
  const remoteHead = (repo, branch = "main") => rawGit(repo.remotePath, "rev-parse", branch);
  const isAncestor = (repo, ancestor, descendant) => rawGitOk(repo.remotePath, "merge-base", "--is-ancestor", ancestor, descendant);

  /** Local and remote diverged: A is pushed, locally it became A' (amend). */
  async function diverge(repo, repoId) {
    put(repo, "README.md", "Fassung A\n");
    await commit(repoId, "A");
    await core("push", { repoId, jobId: crypto.randomUUID(), branch: null, remote: null, remoteBranch: null, force: false });
    put(repo, "README.md", "Fassung A, nachgebessert\n");
    await commit(repoId, "A (nachgebessert)", { amend: true });
  }

  await section("C64 Force push (core): if the remote moved since the last fetch, nothing is overwritten", async () => {
    const { repo, repoId } = await fresh();
    await diverge(repo, repoId);
    const foreign = repo.commitOnRemote({ message: "Kollegin: wichtiger Fix" });
    const result = await tryCore("push", { repoId, jobId: crypto.randomUUID(), branch: null, remote: null, remoteBranch: null, force: true });
    equal(remoteHead(repo), foreign, "the colleague's commit is still on the remote");
    check((result.ok && result.value.status === "rejected") || (!result.ok && result.code === "push_rejected"), `the force push is refused (got ${JSON.stringify(result.ok ? result.value : result.code)})`);
  });

  await section("C65 BUG L1-08 Force push: what the confirmation lists as lost is everything that is lost – even if a fetch happens meanwhile", async () => {
    // BUG L1-08
    const { repo, repoId } = await fresh();
    await diverge(repo, repoId);
    await refocus();
    await runCommand("Force push", "sync.push.force");
    const dialog = await waitDialog(/Force push to origin\/main\?/, 60_000);
    const text = (await dialog.innerText()).replace(/\s+/g, " ");
    check(/1 commit/.test(text), `the confirmation names exactly one commit that is lost (text: "${text.slice(0, 200)}")`);
    // While the confirmation is open, a colleague pushes – and the app fetches (auto-fetch runs every minute by default).
    const foreign = repo.commitOnRemote({ message: "Kollegin: wichtiger Fix, während die Rückfrage offen steht" });
    await core("fetch", { repoId, jobId: crypto.randomUUID(), remote: null, prune: false });
    equal(repo.git("rev-parse", "origin/main"), foreign, "the fetch moved origin/main to the colleague's commit");
    const stillOpen = await page().locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /Force push to origin\/main\?/ }).count();
    const shownNow = stillOpen ? (await dialogText()).replace(/\s+/g, " ") : "";
    await shot(`${BUGS}/L1-08.png`);
    if (stillOpen) await page().getByRole("button", { name: "Force push" }).click();
    await sleep(500);
    await eventually(() => app.settle().then(() => true), Boolean, "the push is done");
    await sleep(1500);
    const second = await dialogTitles();
    const lost = !isAncestor(repo, foreign, remoteHead(repo));
    note(`confirmation after the fetch: "${shownNow.slice(0, 160)}"; further confirmation: ${JSON.stringify(second)}; colleague's commit on the remote: ${lost ? "OVERWRITTEN" : "kept"}`);
    check(!lost || /Kollegin|2 commits/.test(shownNow) || second.length > 0, "a commit the confirmation did not name is not overwritten");
  });

  // ===== Apply patch ==============================================================================

  await section("C70 Apply patch: if one place does not fit, nothing changes; existing files are not overwritten", async () => {
    const { repo, repoId } = await fresh();
    const readme = bytes(repo, "README.md").toString();
    put(repo, "README.md", readme.replace("Gemeinsame Auswertung", "Gemeinsame, geprüfte Auswertung"));
    put(repo, "stationen.csv", `${bytes(repo, "stationen.csv").toString()}W;Wald;212\n`);
    put(repo, "notizen/aus-dem-patch.txt", "Fassung aus dem Patch\n");
    repo.git("add", "-A");
    const patch = `${repo.git("diff", "--cached")}\n`;
    repo.git("reset", "-q", "--hard", "HEAD");
    // README.md was meanwhile changed differently at the same place; the new file already exists.
    put(repo, "README.md", readme.replace("Gemeinsame Auswertung", "Ganz andere Auswertung"));
    put(repo, "notizen/aus-dem-patch.txt", "MEINE Fassung, darf nicht überschrieben werden\n");
    const before = state(repo);
    const result = await tryCore("patch_apply", { repoId, text: patch, checkOnly: false });
    check(!result.ok, `the patch is refused (got ${result.ok ? "ok" : result.code})`);
    equal(state(repo), before, "no file is touched – not even stationen.csv, where the patch would have fit");
  });

  // ===== Races ===================================================================================

  await section("C71 \"Stage all\" while a foreign process writes: no torn file, index and repository intact", async () => {
    const { repo, repoId } = await fresh();
    const writer = path.join(workDir, "schreiber.mjs");
    fs.writeFileSync(
      writer,
      `import fs from "node:fs"; import path from "node:path";
const [dir, ms] = [process.argv[2], Number(process.argv[3])]; const end = Date.now() + ms; let round = 0;
fs.mkdirSync(dir, { recursive: true });
while (Date.now() < end) { round++; for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(dir, "datei-" + i + ".txt"), ("Runde " + round + " Datei " + i + "\\n").repeat(200) + "ENDE\\n"); }
`,
    );
    const child = spawn(process.execPath, [writer, abs(repo, "laufend"), "5000"], { stdio: "ignore", windowsHide: true });
    const done = new Promise((resolve) => child.once("exit", resolve));
    await sleep(400);
    const outcomes = [];
    for (let round = 0; round < 6; round++) {
      const staged = await tryCore("stage_paths", { repoId, paths: null });
      outcomes.push(staged.ok ? "ok" : staged.code);
      if (round % 2 === 1) outcomes.push((await tryCore("unstage_paths", { repoId, paths: null })).ok ? "ok" : "error");
    }
    await done;
    note(`results while writing: ${outcomes.join(", ")}`);
    const torn = fs.readdirSync(abs(repo, "laufend")).filter((name) => !bytes(repo, `laufend/${name}`).toString().endsWith("ENDE\n"));
    equal(torn, [], "no file of the foreign process is truncated or changed");
    check(noLock(repo), "no index.lock is left behind");
    const staged = await tryCore("stage_paths", { repoId, paths: null });
    check(staged.ok, `afterwards everything can be staged (${staged.ok ? "ok" : staged.message})`);
    const mismatch = lines(repo.git("ls-files", "laufend")).filter((rel) => !rawGit(repo.path, "cat-file", "blob", `:${rel}`).endsWith("ENDE"));
    equal(mismatch, [], "every staged blob is a complete version");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C72 Two actions at once (discard all + stash; commit + checkout): no state is lost", async () => {
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    const both = await Promise.all([tryCore("discard_paths", { repoId, paths: null }), tryCore("stash_create", { repoId, opId: crypto.randomUUID(), message: "gleichzeitig", paths: null, includeUntracked: true })]);
    note(`discard: ${both[0].ok ? "ok" : both[0].code}, stash: ${both[1].ok ? "ok" : both[1].code}; stashes: ${lines(repo.git("stash", "list")).length}, undo: ${(await peek(repoId)).undo?.action}`);
    equal(statusText(repo), "", "afterwards the working tree is clean");
    await UNDO(repoId);
    equal(state(repo), before, "one undo restores the whole state byte for byte – no matter which action came first");
    // Commit and checkout at once.
    const text = bytes(repo, "README.md").toString();
    const pair = await Promise.all([tryCore("commit_create", { repoId, opId: crypto.randomUUID(), summary: "Gleichzeitig mit Checkout", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: true }), tryCore("branch_checkout", { repoId, target: "feature/export" })]);
    note(`commit: ${pair[0].ok ? "ok" : pair[0].code}, checkout: ${pair[1].ok ? "ok" : pair[1].code}; HEAD: ${repo.git("rev-parse", "--abbrev-ref", "HEAD")}`);
    const committed = [rawGitOk(repo.path, "rev-parse", "main:README.md") ? rawGit(repo.path, "show", "main:README.md") : "", rawGit(repo.path, "show", "HEAD:README.md")].some((content) => `${content}\n` === text || content === text.replace(/\n$/, ""));
    check(committed || bytes(repo, "README.md").toString() === text, "the change to README.md is in a commit or still in the working tree");
    check(noLock(repo), "no index.lock is left behind");
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  // ===== Addenda: places nobody else looks at ==================================================

  await section("C09 Delete file and restore file from commit → undo brings the local version back byte for byte", async () => {
    const { repo, repoId } = await fresh();
    const mine = Buffer.from("lokal geändert, nie committet\r\nohne Zeilenende");
    put(repo, "README.md", mine);
    put(repo, "notizen/unverfolgt.txt", "unverfolgt\n");
    await core("file_delete", { repoId, path: "README.md" });
    await core("file_delete", { repoId, path: "notizen/unverfolgt.txt" });
    check(!exists(repo, "README.md") && !exists(repo, "notizen/unverfolgt.txt"), "both files are deleted");
    await UNDO(repoId);
    await UNDO(repoId);
    equal(bytes(repo, "README.md").toString("hex"), mine.toString("hex"), "undo brings the modified file back byte for byte");
    equal(bytes(repo, "notizen/unverfolgt.txt").toString(), "unverfolgt\n", "and the untracked file");
    await core("file_restore", { repoId, sha: repo.git("rev-parse", "HEAD"), paths: ["README.md"] });
    check(!bytes(repo, "README.md").equals(mine), "\"restore from commit\" overwrites the local version");
    await UNDO(repoId);
    equal(bytes(repo, "README.md").toString("hex"), mine.toString("hex"), "undo brings the overwritten local version back byte for byte");
    const ignored = await tryCore("file_delete", { repoId, path: "ausgabe/x.txt" });
    check(!ignored.ok, "a file that does not exist is not \"deleted\"");
  });

  await section("C14 BUG L1-10 Hard reset to a commit in which a now-ignored file was still tracked → undo brings the local file back", async () => {
    // BUG L1-10
    const { repo, repoId } = await fresh();
    put(repo, "config/lokal.env", "ALT=aus-der-historie\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Konfiguration (versehentlich) eingecheckt");
    const old = repo.git("rev-parse", "HEAD");
    repo.git("rm", "-q", "--cached", "config/lokal.env");
    put(repo, ".gitignore", `${bytes(repo, ".gitignore").toString()}config/lokal.env\n`);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Lokale Konfiguration nicht mehr verfolgen");
    const mine = "GEHEIM=nur-auf-diesem-rechner\nTOKEN=nicht-wiederbeschaffbar\n";
    put(repo, "config/lokal.env", mine);
    await refocus();
    equal(statusText(repo), "", "setup: the file is ignored, the working tree clean");
    await core("reset_branch", { repoId, sha: old, mode: "hard" });
    note(`after the hard reset config/lokal.env contains: ${JSON.stringify(bytes(repo, "config/lokal.env").toString())}`);
    await UNDO(repoId);
    const now = exists(repo, "config/lokal.env") ? bytes(repo, "config/lokal.env").toString() : null;
    if (!equal(now, mine, "after undo config/lokal.env contains the local version again")) await shot(`${BUGS}/L1-10.png`);
    // Second form: checkout of the old commit and back.
    put(repo, "config/lokal.env", mine);
    await refocus();
    // Either the checkout refuses and names the file (since the fix of BUG-010), or it succeeds and
    // undo brings the local version back – it must never stay overwritten.
    const checkout = await tryCore("branch_checkout", { repoId, target: old });
    if (checkout.ok) await UNDO(repoId);
    else check(checkout.code === "dirty_worktree" && /lokal\.env/.test(checkout.message), `the refused checkout names the file (${checkout.code}: ${checkout.message})`);
    equal(exists(repo, "config/lokal.env") ? bytes(repo, "config/lokal.env").toString() : null, mine, "after the attempted checkout of the old commit (and undo, if it succeeded) the local version is still there");
  });

  await section("C19 Discard all in a repository without commits (everything is \"new\") → undo brings the whole project back", async () => {
    const repo = makeEmptyRepo();
    repos.push(repo);
    put(repo, "src/haupt.py", "print('alles, was es gibt')\n");
    put(repo, "notiz.txt", "noch nie committet\r\n");
    put(repo, "daten/binär.dat", Buffer.from([0, 255, 13, 10, 0]));
    repo.git("add", "notiz.txt");
    const { repoId } = await openRepo(repo.path);
    const before = { files: files(repo), status: statusText(repo) };
    check(Object.keys(before.files).length >= 4, "setup: four files, no commit");
    await core("discard_paths", { repoId, paths: null });
    equal(Object.keys(files(repo)).length, 0, "after \"Discard all\" the folder is empty");
    check((await peek(repoId)).undo?.action === "discard", "undo offers to revert");
    await UNDO(repoId);
    equal({ files: files(repo), status: statusText(repo) }, before, "undo brings every file back byte for byte, and the index");
  });

  await section("C18 BUG L1-01 Discard hunk → keep editing the same file → undo: the new edit must not disappear", async () => {
    // BUG L1-01 (fifth form: the same file)
    const { repo, repoId } = await fresh();
    const original = Array.from({ length: 40 }, (_, index) => `Zeile ${index + 1}`).join("\n") + "\n";
    put(repo, "daten/reihe.txt", original);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Reihe");
    put(repo, "daten/reihe.txt", original.replace("Zeile 38\n", "Zeile 38 – verworfene Änderung\n"));
    await refocus();
    const diff = await core("diff_file", { repoId, path: "daten/reihe.txt", source: { kind: "unstaged" } });
    const text = diff.text ?? diff;
    await core("discard_patch", { repoId, selection: { path: "daten/reihe.txt", hunks: [{ index: 0, lines: null }], expect: text.token } });
    equal(bytes(repo, "daten/reihe.txt").toString(), original, "the hunk is discarded");
    // Keep working on the same file, far away from the discarded place.
    put(repo, "daten/reihe.txt", original.replace("Zeile 2\n", "Zeile 2 – NEU, nach dem Verwerfen geschrieben\n"));
    await UNDO(repoId);
    const now = bytes(repo, "daten/reihe.txt").toString();
    check(now.includes("Zeile 38 – verworfene Änderung"), "undo brings the discarded hunk back");
    check(now.includes("Zeile 2 – NEU, nach dem Verwerfen geschrieben"), "line 2 written afterwards is still in the file after undo");
  });

  await section("C17 BUG L1-14 Discard all when .gitignore itself is modified: newly ignored files stay or come back with undo", async () => {
    // BUG L1-14
    const { repo, repoId } = await fresh();
    const secret = "TOKEN=nicht-wiederbeschaffbar\n";
    // The user creates a local file and adds it to .gitignore – neither committed yet.
    put(repo, "geheim.env", secret);
    put(repo, ".gitignore", `${bytes(repo, ".gitignore").toString()}geheim.env\n`);
    put(repo, "README.md", "irgendeine Änderung, die verworfen werden soll\n");
    await refocus();
    equal(lines(statusText(repo)).sort(), [" M .gitignore", " M README.md"], "setup: geheim.env is ignored and shows up nowhere");
    await core("discard_paths", { repoId, paths: null });
    const afterDiscard = exists(repo, "geheim.env");
    await UNDO(repoId);
    const afterUndo = exists(repo, "geheim.env") && bytes(repo, "geheim.env").toString() === secret;
    note(`geheim.env after "Discard all": ${afterDiscard ? "still there" : "DELETED"}; after undo: ${afterUndo ? "there" : "gone"}`);
    equal(bytes(repo, ".gitignore").toString().includes("geheim.env"), true, "undo brings back the modified .gitignore");
    if (!check(afterUndo, "the ignored file geheim.env is still there after \"Discard all\" + undo")) await shot(`${BUGS}/L1-14.png`);
  });

  await section("C67 BUG L1-15 Adding a submodule fails: an existing Git directory under .git/modules is not deleted", async () => {
    // BUG L1-15
    const repo = makeCleanRepoWithRemote();
    repos.push(repo);
    const { sub } = addSubmodule(repo);
    put(sub, "auswertung.py", "# nur lokal im Submodul committet\n");
    rawGit(sub, "add", "-A");
    rawGit(sub, "commit", "-q", "-m", "Nur lokal, nie gepusht");
    const localSha = rawGit(sub, "rev-parse", "HEAD");
    // The submodule is removed with Git itself (terminal, another program): Git leaves .git/modules/… on purpose.
    repo.git("submodule", "deinit", "-q", "-f", "libs/werkzeug");
    repo.git("rm", "-q", "-f", "libs/werkzeug");
    repo.git("commit", "-q", "-m", "Submodul entfernt (mit Git)");
    const moduleDir = path.join(repo.path, ".git", "modules", "libs", "werkzeug");
    const has = () => fs.existsSync(moduleDir) && rawGitOk(repo.path, `--git-dir=${moduleDir}`, "cat-file", "-e", `${localSha}^{commit}`);
    check(has(), "setup: .git/modules/libs/werkzeug is still there and contains the unpushed commit");
    const { repoId } = await openRepo(repo.path);
    // Add again (here with an address that does not answer; Git already refuses because of the existing directory).
    const result = await tryCore("submodule_add", { repoId, jobId: crypto.randomUUID(), url: "http://127.0.0.1:9/werkzeug.git", path: "libs/werkzeug" });
    note(`submodule_add: ${result.ok ? "ok" : `${result.code}: ${result.message.split("\n")[0]}`} ${result.gitOutput ? `– Git: ${String(result.gitOutput).replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
    if (!check(result.ok || has(), "after the failed add, .git/modules/libs/werkzeug with the unpushed commit is still there")) await shot(`${BUGS}/L1-15.png`);
  });

  await section("C16 BUG L1-11 Detached HEAD with its own commits: when switching to a branch the app warns about the commits left behind", async () => {
    // BUG L1-11
    const { repo, repoId, tabId } = await fresh();
    await core("branch_checkout", { repoId, target: repo.git("rev-parse", "HEAD~1") });
    put(repo, "notizen/ohne-branch.txt", "Commit auf losgelöstem HEAD\n");
    await commit(repoId, "Arbeit ohne Branch");
    const orphan = repo.git("rev-parse", "HEAD");
    await refocus();
    await uiAction("branches", "checkout", repoId, "main", { tabId });
    await eventually(() => repo.git("rev-parse", "--abbrev-ref", "HEAD"), (value) => value === "main" || value === "HEAD", "the checkout runs");
    await sleep(1500);
    const asked = await dialogTitles();
    const toasts = (await page().locator("[data-toast]").allInnerTexts()).map((text) => text.replace(/\s+/g, " "));
    const onMain = repo.git("rev-parse", "--abbrev-ref", "HEAD") === "main";
    const holders = repo.git("for-each-ref", "--contains", orphan, "--format=%(refname)");
    note(`dialogs: ${JSON.stringify(asked)}; toasts: ${JSON.stringify(toasts)}; HEAD on main: ${onMain}; refs holding the commit: ${holders || "none"}; undo: ${JSON.stringify((await peek(repoId)).undo)}`);
    const warned = [...asked, ...toasts].some((text) => /(no branch|left behind|orphaned|no longer reachable|without a branch)/i.test(text));
    if (!check(!onMain || warned || holders !== "", "the app warns about leaving the commits behind (or holds them with a ref)")) await shot(`${BUGS}/L1-11.png`);
  });

  await section("C27 BUG L1-13 Stash only selected files (staged + unstaged mixed) → undo: files AND staging as before", async () => {
    // BUG L1-13
    const { repo, repoId } = await fresh();
    dirty(repo);
    const before = state(repo);
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: "nur zwei", paths: ["README.md", "stationen.csv"], includeUntracked: false });
    note(`git stash show lists: ${lines(repo.git("stash", "show", "--name-only", "stash@{0}")).sort().join(", ")}`);
    check(exists(repo, "notizen/binär.dat") && exists(repo, "src/neu.py") && !exists(repo, "src/vergleich.py"), "all other changes are untouched");
    await UNDO(repoId);
    equal(files(repo), before.files, "undo brings the files back byte for byte");
    equal(lines(repo.git("stash", "list")).length, 0, "the stash is gone again");
    const after = state(repo);
    if (!equal(lines(after.status), lines(before.status), "git status is as before the stash (what was staged is staged again)")) await shot(`${BUGS}/L1-13.png`);
    equal(repo.git("diff", "--cached", "--", "stationen.csv").includes("+W;Waldrand;212"), true, "the previously staged part of stationen.csv is back in the index");
  });

  await section("C28 BUG L1-13 Stash only selected files: a staged file OUTSIDE the selection does not belong in the stash", async () => {
    // BUG L1-13 (second form: the stash takes staged content nobody selected)
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "im Teil-Stash\n");
    put(repo, "neu.txt", "gestagte neue Datei, NICHT für den Stash gewählt\n");
    repo.git("add", "neu.txt");
    await refocus();
    await core("stash_create", { repoId, opId: crypto.randomUUID(), message: "nur README", paths: ["README.md"], includeUntracked: false });
    const inStash = lines(repo.git("stash", "show", "--name-only", "stash@{0}")).sort();
    equal(inStash, ["README.md"], "the stash contains exactly the selected file");
    // The user keeps working on the other file and commits it; then they bring the stash back.
    const committed = "gestagte neue Datei, NICHT für den Stash gewählt\nund weiterbearbeitet\n";
    put(repo, "neu.txt", committed);
    repo.git("add", "neu.txt");
    repo.git("commit", "-q", "-m", "neu.txt committet");
    await refocus();
    const pop = await tryCore("stash_pop", { repoId, index: 0 });
    note(`Pop: ${JSON.stringify(pop.ok ? pop.value.status : pop.code)}; git status: ${JSON.stringify(statusText(repo))}`);
    equal(bytes(repo, "neu.txt").toString(), committed, "neu.txt (never selected for the stash) is unchanged after the pop – no conflict markers");
    check(pop.ok && pop.value.status === "done", "popping the partial stash succeeds without conflict");
  });

  await section("C35 BUG L1-01 Squash merge → keep working → undo: new work must not disappear", async () => {
    // BUG L1-01 (fourth form)
    const { repo, repoId } = await fresh();
    await core("merge_start", { repoId, source: "feature/export", mode: "squash" });
    check(repo.git("diff", "--cached", "--name-only").includes("src/export.py"), "the squash merge is staged and ready");
    put(repo, "notizen/nach-dem-squash.txt", "Diese Datei entstand NACH dem Squash-Merge.\n");
    const step = (await peek(repoId)).undo;
    await UNDO(repoId);
    equal(repo.git("diff", "--cached", "--name-only"), "", `undo ("${step?.label}") reverts the squash merge`);
    check(exists(repo, "notizen/nach-dem-squash.txt"), "the file created after the squash merge is still there after undo");
  });

  await section("C44 BUG L1-12 Resolve conflict: the user's own untracked \".orig\" file next to it must not be deleted silently", async () => {
    // BUG L1-12
    const repo = makeConflictRepo();
    repos.push(repo);
    const mine = "MEINE eigene Sicherung von letzter Woche – kein Merge-Tool hat sie angelegt.\n";
    put(repo, "docs/aufbau.md.orig", mine);
    const { repoId } = await openRepo(repo.path);
    const setting = (await core("settings_get")).deleteOrigFiles;
    await core("conflict_resolve", { repoId, path: "docs/aufbau.md", content: null, side: "ours" });
    const kept = exists(repo, "docs/aufbau.md.orig") && bytes(repo, "docs/aufbau.md.orig").toString() === mine;
    note(`setting "delete .orig files after resolving" by default: ${setting}; file afterwards: ${kept ? "kept" : "deleted"}; undo: ${JSON.stringify((await peek(repoId)).undo)}`);
    if (!check(kept, "docs/aufbau.md.orig (created by the user, never by a merge tool) is still there after resolving the conflict")) await shot(`${BUGS}/L1-12.png`);
  });

  await section("C66 BUG L1-08 Force push with real auto-fetch (1 minute, default setting): leave the confirmation open, a colleague pushes", async () => {
    // BUG L1-08 (without a simulated fetch: only the app's default setting)
    await core("settings_set", { patch: { autoFetchMinutes: 1 } });
    try {
      const { repo, repoId } = await fresh();
      await diverge(repo, repoId);
      await refocus();
      await runCommand("Force push", "sync.push.force");
      const dialog = await waitDialog(/Force push to origin\/main\?/, 60_000);
      const text = (await dialog.innerText()).replace(/\s+/g, " ");
      const foreign = repo.commitOnRemote({ message: "Kollegin: wichtiger Fix, während die Rückfrage offen steht" });
      // Do nothing, just wait: the app's auto-fetch gets the new state on its own.
      const fetched = await eventually(() => repo.git("rev-parse", "origin/main"), (value) => value === foreign, "the auto-fetch moved origin/main within two minutes", 130_000);
      if (!fetched) return;
      const open = await page().locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /Force push to origin\/main\?/ }).count();
      const shownNow = open ? (await dialogText()).replace(/\s+/g, " ") : "";
      if (open) await page().getByRole("button", { name: "Force push" }).click();
      await sleep(4000);
      await app.settle().catch(() => undefined);
      const lost = !isAncestor(repo, foreign, remoteHead(repo));
      note(`confirmation before: "${text.slice(0, 120)}…"; confirmation after the auto-fetch ${shownNow === text ? "unchanged" : "changed"}; colleague's commit: ${lost ? "OVERWRITTEN" : "kept"}`);
      check(!lost || /Kollegin|2 commits/.test(shownNow), "a commit the confirmation did not name is not overwritten");
    } finally {
      await core("settings_set", { patch: { autoFetchMinutes: 0 } }).catch(() => undefined);
    }
  });

  await section("C73 Generate SSH key: an existing key of the same name is never overwritten or deleted", async () => {
    const sshDir = path.join(workDir, "ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "id_ed25519"), "MEIN VORHANDENER PRIVATER SCHLÜSSEL\n");
    fs.writeFileSync(path.join(sshDir, "id_ed25519.pub"), "ssh-ed25519 AAAA vorhanden\n");
    fs.writeFileSync(path.join(sshDir, "nur-oeffentlich.pub"), "ssh-ed25519 AAAA nur der öffentliche Teil\n");
    for (const fileName of ["id_ed25519", "nur-oeffentlich"]) {
      const result = await tryCore("ssh_key_generate", { label: "Neu", fileName, passphrase: null });
      check(!result.ok && result.code === "path_exists", `${fileName}: generating is refused (got ${result.ok ? "ok" : result.code})`);
    }
    equal(fs.readFileSync(path.join(sshDir, "id_ed25519"), "utf8"), "MEIN VORHANDENER PRIVATER SCHLÜSSEL\n", "the existing private key is unchanged");
    equal(fs.readFileSync(path.join(sshDir, "id_ed25519.pub"), "utf8"), "ssh-ed25519 AAAA vorhanden\n", "the existing public key is unchanged");
    check(fs.existsSync(path.join(sshDir, "nur-oeffentlich.pub")), "the lone .pub file is still there");
  });

  // ===== Crash in the middle of a write ===========================================================

  const killApp = () => spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });

  await section("C80 App is killed during a commit (pre-commit hook running): repository intact, staged content stays", async () => {
    const { repo, repoId } = await fresh();
    put(repo, "README.md", "kurz vor dem Absturz gestaged\n");
    put(repo, "notizen/ungestaged.txt", "nicht gestaged, muss bleiben\n");
    repo.git("add", "README.md");
    const head = repo.git("rev-parse", "HEAD");
    fs.mkdirSync(path.join(repo.path, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(repo.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 40\n");
    void tryCore("commit_create", { repoId, opId: crypto.randomUUID(), summary: "Wird nie fertig", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
    await sleep(3500);
    killApp();
    await sleep(1500);
    fs.rmSync(path.join(repo.path, ".git", "hooks", "pre-commit"), { force: true });
    equal(repo.git("rev-parse", "HEAD"), head, "no half commit: HEAD is unchanged");
    equal(repo.git("diff", "--cached", "--name-only"), "README.md", "the staged change is still in the index");
    equal(bytes(repo, "README.md").toString(), "kurz vor dem Absturz gestaged\n", "the file is unchanged");
    check(exists(repo, "notizen/ungestaged.txt"), "the unstaged file is still there");
    const lockLeft = !noLock(repo);
    note(`index.lock after the crash: ${lockLeft ? "left behind" : "none"}`);
    equal(fsck(repo), "", "git fsck reports nothing");
    await restart();
    const again = await openRepo(repo.path);
    const status = await tryCore("status_get", { repoId: again.repoId });
    check(status.ok && status.value.staged.some((file) => file.path === "README.md"), "after the restart the app shows the staged file");
    if (lockLeft) fs.rmSync(path.join(repo.path, ".git", "index.lock"), { force: true });
    const retry = await tryCore("commit_create", { repoId: again.repoId, opId: crypto.randomUUID(), summary: "Nach dem Absturz", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
    check(retry.ok, `the commit succeeds afterwards (${retry.ok ? "ok" : `${retry.code}: ${retry.message}`})`);
  });

  await section("C81 BUG L1-09 App is killed during \"Discard all\": after the restart undo offers the discarded work", async () => {
    // BUG L1-09
    const { repo, repoId } = await fresh();
    const COUNT = 12_000;
    fs.mkdirSync(abs(repo, "viele"), { recursive: true });
    for (let index = 0; index < COUNT; index++) fs.writeFileSync(abs(repo, `viele/messung-${String(index).padStart(5, "0")}.txt`), `Messung ${index}\n`);
    put(repo, "README.md", "ungesicherte Änderung vor dem Verwerfen\n");
    const count = () => (fs.existsSync(abs(repo, "viele")) ? fs.readdirSync(abs(repo, "viele")).length : 0);
    void tryCore("discard_paths", { repoId, paths: null });
    // Wait until the backup exists (its ref is in the repository) – deletion starts from there – and kill in the middle.
    const backupDir = path.join(repo.path, ".git", "refs", "forkyard", "undo");
    const backedUp = () => fs.existsSync(backupDir) && fs.readdirSync(backupDir).some((id) => fs.existsSync(path.join(backupDir, id, "worktree")));
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !backedUp() && count() === COUNT) await sleep(5);
    killApp();
    await sleep(1500);
    const left = count();
    const readmeGone = !bytes(repo, "README.md").toString().startsWith("ungesicherte");
    note(`at the crash: ${COUNT - left} of ${COUNT} files deleted, README.md ${readmeGone ? "reset" : "still modified"}; backup refs: ${undoRefs(repo).length}; index.lock: ${noLock(repo) ? "none" : "present"}`);
    fs.rmSync(path.join(repo.path, ".git", "index.lock"), { force: true });
    await restart();
    const again = await openRepo(repo.path);
    const step = (await peek(again.repoId)).undo;
    note(`after the restart: undo = ${JSON.stringify(step)}`);
    if (left === COUNT && !readmeGone) {
      note("the crash came before anything was discarded – no finding in this run");
    } else {
      const offered = check(step?.action === "discard", "after the restart undo offers to revert the (partial) discard");
      if (offered) {
        await UNDO(again.repoId);
        equal(count(), COUNT, "undo brings all files back");
        equal(bytes(repo, "README.md").toString(), "ungesicherte Änderung vor dem Verwerfen\n", "and the change to README.md");
      } else {
        await shot(`${BUGS}/L1-09.png`);
        note(`the backup lies orphaned in the repository (${undoRefs(repo).length} refs under refs/forkyard/undo/), the app does not offer it`);
      }
    }
    equal(fsck(repo), "", "git fsck reports nothing");
  });

  await section("C82 App is killed during a rebase: state explained, abort goes back without loss", async () => {
    const { repo, repoId } = await fresh();
    repo.git("checkout", "-q", "-b", "lang", "HEAD~1");
    for (let index = 0; index < 40; index++) {
      put(repo, `serie/teil-${index}.txt`, `Teil ${index}\n`);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", `Teil ${index}`);
    }
    const tip = repo.git("rev-parse", "HEAD");
    put(repo, "notizen/unverfolgt.txt", "lag schon vor dem Rebase hier\n");
    await refocus();
    void tryCore("rebase_start", { repoId, onto: "main", branch: null });
    const doneFile = path.join(repo.path, ".git", "rebase-merge", "done");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(fs.existsSync(doneFile) && lines(fs.readFileSync(doneFile, "utf8")).length >= 8)) await sleep(10);
    killApp();
    await sleep(1500);
    const midway = fs.existsSync(path.join(repo.path, ".git", "rebase-merge"));
    const lockLeft = !noLock(repo);
    note(`at the crash: rebase ${midway ? "is midway" : "not open (anymore)"}, index.lock ${lockLeft ? "left behind" : "none"}, HEAD ${repo.git("rev-parse", "--short", "HEAD")}`);
    equal(fsck(repo), "", "git fsck reports nothing right after the crash");
    await restart();
    const again = await openRepo(repo.path);
    const status = await tryCore("status_get", { repoId: again.repoId });
    if (midway) {
      check(status.ok && status.value.operation?.kind === "rebase", `the app shows the open rebase (operation: ${JSON.stringify(status.ok ? status.value.operation : status.code)})`);
      let abort = await tryCore("operation_abort", { repoId: again.repoId });
      if (!abort.ok && abort.code === "locked") {
        note(`abort with a leftover lock: "${abort.message}"`);
        fs.rmSync(path.join(repo.path, ".git", "index.lock"), { force: true });
        abort = await tryCore("operation_abort", { repoId: again.repoId });
      }
      check(abort.ok, `abort succeeds (${abort.ok ? "ok" : `${abort.code}: ${abort.message}`})`);
      equal(repo.git("rev-parse", "lang"), tip, "the branch is back at its old commit");
      equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "lang", "HEAD is attached to the branch again");
    } else {
      check(repo.git("rev-list", "--count", "main..lang") === "40", "the rebase was already done (or never started): all 40 commits are there");
    }
    equal(bytes(repo, "notizen/unverfolgt.txt").toString(), "lag schon vor dem Rebase hier\n", "the untracked file is untouched");
    equal(fsck(repo), "", "git fsck reports nothing");
  });
} catch (error) {
  console.log(`\nAborted outside a section: ${error?.stack ?? error}`);
  results.push({ title: "Script (frame)", failures: [String(error?.message ?? error)], notes: [], seconds: 0 });
} finally {
  const consoleErrors = app?.consoleErrors ?? [];
  await app?.close().catch(() => undefined);
  for (const repo of repos) repo.cleanup();
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

  const green = results.filter((result) => result.failures.length === 0);
  const red = results.filter((result) => result.failures.length > 0);
  console.log(`\n===== dataloss: ${results.length} sections, ${green.length} green, ${red.length} red =====`);
  console.log("\nGREEN");
  for (const result of green) console.log(`  ✓ ${result.title}`);
  console.log("\nRED");
  for (const result of red) {
    console.log(`  ✗ ${result.title}`);
    for (const failure of result.failures) console.log(`      - ${failure.split("\n")[0]}`);
    for (const text of result.notes) console.log(`      · ${text}`);
  }
  if (consoleErrors.length) console.log(`\nApp console errors (${consoleErrors.length}):\n${consoleErrors.slice(0, 10).map((line) => `  ${line.split("\n")[0]}`).join("\n")}`);
  process.exit(red.length ? 1 : 0);
}
