/**
 * Small real Git repositories for the branch feature (scripts/e2e-wd/features/branches.mjs):
 * create/rename/delete branches, drag and drop merge/rebase, cherry-pick, revert, reset and the
 * conflict preflight. Built fresh per scenario (a handful of commits, well under a second).
 *
 *   const repo = makeBranchRepo();   // { path, git(...args), write(rel, text), commit(message), head(), cleanup() }
 *
 * Fixed identity and timestamps, isolated from the machine's Git configuration (own global
 * gitconfig, GIT_CONFIG_NOSYSTEM). Content is made-up German test data on purpose.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEST_IDENTITY, gitIsolationEnv, globalGitConfig } from "../../e2e/fixtures.mjs";

const EPOCH = 1772434800;

const leftovers = new Set();
process.on("exit", () => {
  for (const dir of leftovers) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // still locked: stays in the temp folder
    }
  }
});
function removeAtExit(dir) {
  leftovers.add(dir);
}

/** Ten numbered lines; `changes` replaces single lines: { 3: "…" }. */
export function werte(changes = {}) {
  const lines = [];
  for (let n = 1; n <= 10; n += 1) lines.push(changes[n] ?? `Zeile ${n}: Messwert ${n * 7} hPa`);
  return `${lines.join("\n")}\n`;
}

/** An empty repository with helpers. */
export function makeEmptyBranchRepo(name = "zweige") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-branches-"));
  const globalConfig = path.join(root, "gitconfig");
  fs.writeFileSync(globalConfig, globalGitConfig());
  const repoPath = path.join(root, name);
  fs.mkdirSync(repoPath);
  let tick = 0;
  const env = () => {
    tick += 1;
    const date = `${EPOCH + tick * 3600} +0100`;
    return {
      ...process.env,
      ...gitIsolationEnv(globalConfig),
      GIT_AUTHOR_NAME: TEST_IDENTITY.name,
      GIT_AUTHOR_EMAIL: TEST_IDENTITY.email,
      GIT_COMMITTER_NAME: TEST_IDENTITY.name,
      GIT_COMMITTER_EMAIL: TEST_IDENTITY.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
  };
  const git = (...args) => execFileSync("git", args, { cwd: repoPath, env: env(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString().replace(/\n$/, "");
  /** Like git(), but returns { ok, out } instead of throwing. */
  const tryGit = (...args) => {
    try {
      return { ok: true, out: git(...args) };
    } catch (error) {
      return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };
  const write = (rel, text) => {
    const target = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const read = (rel) => fs.readFileSync(path.join(repoPath, rel), "utf8");
  const exists = (rel) => fs.existsSync(path.join(repoPath, rel));
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", TEST_IDENTITY.name);
  git("config", "user.email", TEST_IDENTITY.email);
  return {
    root,
    path: repoPath,
    git,
    tryGit,
    write,
    read,
    exists,
    commit,
    head: () => git("rev-parse", "HEAD"),
    branch: () => git("rev-parse", "--abbrev-ref", "HEAD"),
    branches: () => git("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort(),
    sha: (rev) => git("rev-parse", rev),
    subject: (rev = "HEAD") => git("log", "-1", "--format=%s", rev),
    status: () => git("status", "--porcelain"),
    /** merge/rebase/cherry-pick/revert currently running according to .git */
    operation: () => {
      const dir = path.join(repoPath, ".git");
      if (fs.existsSync(path.join(dir, "MERGE_HEAD"))) return "merge";
      if (fs.existsSync(path.join(dir, "CHERRY_PICK_HEAD"))) return "cherry_pick";
      if (fs.existsSync(path.join(dir, "REVERT_HEAD"))) return "revert";
      if (fs.existsSync(path.join(dir, "rebase-merge")) || fs.existsSync(path.join(dir, "rebase-apply"))) return "rebase";
      return null;
    },
    // The app of the scenario may still be running (it is closed after the scenario, and a failing
    // scenario is screenshotted first): remove the folder when the process ends.
    cleanup: () => removeAtExit(root),
  };
}

/**
 * The standard layout (main checked out, clean):
 *
 *   main:              c1 "Grundgerüst" – c2 "Messreihe ergänzt" – c3 "Werte gerundet" (line 3 of werte.txt)
 *   erledigt:          at c2 (merged into main)
 *   feature/luftdruck: c2 – f1 "Luftdruck erfassen" (luftdruck.txt) – f2 "Luftdruck kalibrieren"
 *   konflikt:          c2 – k1 "Zeile drei anders" (line 3 of werte.txt, conflicts with c3)
 *   tag v0.1:          c1
 */
export function makeBranchRepo(name = "zweige") {
  const repo = makeEmptyBranchRepo(name);
  const shas = {};
  repo.write("README.md", "# Zweige\n\nTestdaten der Wetterstation.\n");
  repo.write("werte.txt", werte());
  shas.c1 = repo.commit("Grundgerüst");
  repo.git("tag", "v0.1");
  repo.write("daten.csv", "zeit;druck\n08:00;1013\n");
  shas.c2 = repo.commit("Messreihe ergänzt");
  repo.git("branch", "erledigt");
  repo.git("checkout", "-q", "-b", "feature/luftdruck");
  repo.write("luftdruck.txt", "Luftdruck: 1013 hPa\n");
  shas.f1 = repo.commit("Luftdruck erfassen");
  repo.write("luftdruck.txt", "Luftdruck: 1013 hPa\nKalibriert: ja\n");
  shas.f2 = repo.commit("Luftdruck kalibrieren");
  repo.git("checkout", "-q", "-b", "konflikt", shas.c2);
  repo.write("werte.txt", werte({ 3: "Zeile 3: Messwert 21 hPa (Sensor B)" }));
  shas.k1 = repo.commit("Zeile drei anders");
  repo.git("checkout", "-q", "main");
  repo.write("werte.txt", werte({ 3: "Zeile 3: Messwert 21,0 hPa (gerundet)" }));
  shas.c3 = repo.commit("Werte gerundet");
  return { ...repo, shas };
}
