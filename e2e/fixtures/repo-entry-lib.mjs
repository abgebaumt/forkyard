/**
 * Git in temp folders for the repository features (used through repos.mjs).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitIsolationEnv, globalGitConfig, TEST_IDENTITY } from "./fixtures.mjs";

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
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .replace(/\r?\n$/, "");
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

/** file:// URL of a local folder (three slashes for Git on Windows). */
export function fileUrl(dir) {
  const normal = dir.replaceAll("\\", "/");
  return normal.startsWith("/") ? `file://${normal}` : `file:///${normal}`;
}
