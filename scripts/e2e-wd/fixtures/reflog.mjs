/**
 * Real Git repositories for scripts/e2e-wd/features/reflog.mjs. Built fresh per scenario (a handful
 * of commits); the reflog is written by Git itself, apart from the deliberately odd variants
 * (missing objects, many entries, secrets in a message).
 *
 *   const repo = makeReflogRepo();   // { path, git(...), shas, head(), branch(), reflog(ref), cleanup() }
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

/** An empty repository (branch main) with helpers. `logRefs: false` turns the reflog off. */
export function makeEmptyReflogRepo(name = "protokoll", { logRefs = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-reflog-")));
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
  const git = (...args) => execFileSync("git", args, { cwd: repoPath, env: env(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString().replace(/\n$/, "");
  const write = (rel, text) => {
    const target = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const read = (rel) => fs.readFileSync(path.join(repoPath, rel), "utf8");
  const commit = (message, ...extra) => {
    git("add", "-A");
    git("commit", "-q", ...extra, "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", TEST_IDENTITY.name);
  git("config", "user.email", TEST_IDENTITY.email);
  if (!logRefs) git("config", "core.logAllRefUpdates", "false");
  return {
    root,
    path: repoPath,
    gitDir: path.join(repoPath, ".git"),
    git,
    write,
    read,
    commit,
    head: () => git("rev-parse", "HEAD"),
    /** Branch name, or "HEAD" when detached. */
    branch: () => git("rev-parse", "--abbrev-ref", "HEAD"),
    sha: (rev) => git("rev-parse", rev),
    branches: () => git("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort(),
    status: () => git("status", "--porcelain"),
    /** Reflog subjects of `ref`, newest first. */
    reflog: (ref = "HEAD") => {
      const out = git("reflog", "show", "--format=%H %gs", ref, "--");
      return out ? out.split("\n").map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) })) : [];
    },
    undoRefs: () => git("for-each-ref", "--format=%(refname)", "refs/forkyard/undo/").split("\n").filter(Boolean),
    // The app may still be running when the scenario ends: remove the folder when the process ends.
    cleanup: () => leftovers.add(root),
  };
}

/**
 * The standard story (main checked out, clean). HEAD reflog, newest first:
 *
 *   HEAD@{0} reset: moving to HEAD~1                 -> c3a
 *   HEAD@{1} commit: Verworfener Versuch             -> lost   (reachable only through the reflog)
 *   HEAD@{2} checkout: moving from feature/wind to main -> c3a
 *   HEAD@{3} commit: Wind erfassen                   -> f1
 *   HEAD@{4} checkout: moving from main to feature/wind -> c3a
 *   HEAD@{5} commit (amend): Werte gerundet (korrigiert) -> c3a
 *   HEAD@{6} commit: Werte gerundet                  -> c3     (replaced by the amend)
 *   HEAD@{7} commit: Messreihe ergänzt               -> c2
 *   HEAD@{8} commit (initial): Grundgerüst           -> c1
 */
export function makeReflogRepo(name = "protokoll") {
  const repo = makeEmptyReflogRepo(name);
  const shas = {};
  repo.write("README.md", "# Protokoll\n\nTestdaten der Wetterstation.\n");
  repo.write("werte.txt", "Zeile 1: 1013 hPa\nZeile 2: 1011 hPa\nZeile 3: 1009,6 hPa\n");
  shas.c1 = repo.commit("Grundgerüst");
  repo.write("daten.csv", "zeit;druck\n08:00;1013\n");
  shas.c2 = repo.commit("Messreihe ergänzt");
  repo.write("werte.txt", "Zeile 1: 1013 hPa\nZeile 2: 1011 hPa\nZeile 3: 1010 hPa\n");
  shas.c3 = repo.commit("Werte gerundet");
  repo.write("werte.txt", "Zeile 1: 1013 hPa\nZeile 2: 1011 hPa\nZeile 3: 1010 hPa (gerundet)\n");
  shas.c3a = repo.commit("Werte gerundet (korrigiert)", "--amend");
  repo.git("checkout", "-q", "-b", "feature/wind");
  repo.write("wind.txt", "Wind: 12 km/h aus West\n");
  shas.f1 = repo.commit("Wind erfassen");
  repo.git("checkout", "-q", "main");
  repo.write("versuch.txt", "Ein Versuch, der verworfen wird.\n");
  shas.lost = repo.commit("Verworfener Versuch");
  repo.git("reset", "-q", "--hard", "HEAD~1");
  return { ...repo, shas };
}

/** Removes the loose object file of a commit: the reflog still names it, Git no longer has it. */
export function dropObject(repo, sha) {
  const file = path.join(repo.gitDir, "objects", sha.slice(0, 2), sha.slice(2));
  fs.rmSync(file);
}

/**
 * Rewrites the HEAD reflog to `count` entries alternating between the existing commits
 * (`shas`, oldest first); entry n's message is "checkout: Eintrag <n>". Returns the messages, newest first.
 */
export function writeLongReflog(repo, shas, count) {
  const lines = [];
  let old = "0".repeat(40);
  for (let n = 0; n < count; n += 1) {
    const sha = shas[n % shas.length];
    lines.push(`${old} ${sha} ${TEST_IDENTITY.name} <${TEST_IDENTITY.email}> ${EPOCH + n * 60} +0100\tcheckout: Eintrag ${n}`);
    old = sha;
  }
  fs.writeFileSync(path.join(repo.gitDir, "logs", "HEAD"), `${lines.join("\n")}\n`);
  return lines.map((_, n) => `checkout: Eintrag ${n}`).reverse();
}
