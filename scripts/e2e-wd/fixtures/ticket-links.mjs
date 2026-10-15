/**
 * Real Git repositories for scripts/e2e-wd/features/ticket-links.mjs: a small history whose commit
 * messages carry ticket references (#42, !7, OPS-17, CVE-2024-1234 …), optionally with a remote
 * URL on a public host (never contacted: the remote only names the host for the link rules) and a
 * `.forkyard/links.json`.
 *
 *   const repo = makeLinksRepo({ remote: "https://github.com/acme/wetterstation.git" });
 *   repo.commit("Fix #42", "body"); repo.write(".forkyard/links.json", {...}); repo.git("status");
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

/**
 * A repository (branch main) with one base commit. `remote`: URL for "origin" (only written to the
 * config, never fetched). Returns { root, path, git, write, read, commit, head, cleanup }.
 */
export function makeLinksRepo({ name = "wetterstation", remote = null } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-links-")));
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
  const git = (...args) =>
    execFileSync("git", args, { cwd: repoPath, env: env(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
      .toString()
      .replace(/\n$/, "");
  /** Writes a file; objects are written as JSON. */
  const write = (rel, content) => {
    const target = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  const read = (rel) => fs.readFileSync(path.join(repoPath, rel), "utf8");
  let counter = 0;
  /** Commits everything (or, without changes, a small file change) with summary and optional body. */
  const commit = (summary, body = null) => {
    counter += 1;
    write(`protokoll/eintrag-${counter}.txt`, `Eintrag ${counter}: ${summary}\n`);
    git("add", "-A");
    const args = ["commit", "-q", "-m", summary];
    if (body) args.push("-m", body);
    git(...args);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", TEST_IDENTITY.name);
  git("config", "user.email", TEST_IDENTITY.email);
  if (remote) git("remote", "add", "origin", remote);
  write("README.md", "# Wetterstation\n\nMesswerte der Station Nord.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Grundgerüst der Messwerte");
  return {
    root,
    path: repoPath,
    git,
    write,
    read,
    commit,
    head: () => git("rev-parse", "HEAD"),
    /** The app may still be running when the scenario ends: remove the folder when the process ends. */
    cleanup: () => leftovers.add(root),
  };
}

/** A valid `.forkyard/links.json` with the given rules. */
export const linksFile = (rules, version = 1) => ({ version, rules });
