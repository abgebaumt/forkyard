/**
 * Submodule and worktree fixtures with local bare repositories as source (used through
 * worktrees-submodules.mjs).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "./fixtures.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const slashed = (file) => file.replaceAll("\\", "/");
export const samePath = (a, b) => slashed(a).replace(/\/+$/, "").toLowerCase() === slashed(b).replace(/\/+$/, "").toLowerCase();

/** git in `cwd` with an isolated configuration (`config` = path of a gitconfig). */
const gitIn = (cwd, config, ...args) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...gitIsolationEnv(config) }, stdio: ["ignore", "pipe", "pipe"] })
    .toString("utf8")
    .trim();
/** Appends lines to the app's global gitconfig (the app rereads it on every git call). */
const appendAppGitConfig = (app, text) => fs.appendFileSync(app.gitConfigPath, text.endsWith("\n") ? text : `${text}\n`);

/** git in `cwd` with the isolated configuration of fixture `fx`. */
export const git = (fx, cwd, ...args) => gitIn(cwd, path.join(fx.root, "gitconfig"), ...args);
/** Like `git`, with the file transport allowed (for submodules from local folders). */
export const gitFile = (fx, cwd, ...args) => git(fx, cwd, "-c", "protocol.file.allow=always", ...args);

/** Allows the app to use local folders as submodule sources, as a user would in their gitconfig. */
export function allowFileProtocol(app) {
  appendAppGitConfig(app, '[protocol "file"]\n\tallow = always\n');
}

/**
 * Creates a bare repository `<name>.git` next to the fixture, with `commits` commits in one file.
 * Returns { path, shas } (shas[0] is the oldest commit).
 */
export function makeLibrary(fx, name, { commits = 2, files = {} } = {}) {
  const work = path.join(fx.root, `_quelle-${name}`);
  fs.mkdirSync(work, { recursive: true });
  git(fx, work, "init", "-q", "-b", "main");
  git(fx, work, "config", "user.name", "Jonas Albrecht");
  git(fx, work, "config", "user.email", "jonas.albrecht@wetterstation.example");
  const shas = [];
  for (let index = 1; index <= commits; index++) {
    fs.writeFileSync(path.join(work, "LIESMICH.md"), `# ${name}\n\nStand ${index}.\n`);
    if (index === 1) {
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
        fs.writeFileSync(path.join(work, rel), content);
      }
    }
    git(fx, work, "add", "-A");
    git(fx, work, "commit", "-q", "-m", index === 1 ? `${name}: Grundgerüst` : `${name}: Stand ${index}`);
    shas.push(git(fx, work, "rev-parse", "HEAD"));
  }
  const bare = path.join(fx.root, `${name}.git`);
  git(fx, fx.root, "clone", "-q", "--bare", work, bare);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { path: bare, shas };
}

export const LIBS = {
  ready: "libs/sensor-treiber",
  drifted: "libs/karten-kacheln",
  edited: "libs/auswertung-kern",
  fresh: "extern/protokoll",
};

/**
 * Repository "station" with four submodules in four states:
 * initialized, drifted (other commit checked out), modified (own file), not initialized.
 * Plus `clonePath`: a fresh clone without submodules (all not initialized).
 */
export function makeSubmoduleRepo() {
  const fx = makeCleanRepoWithRemote({ name: "station" });
  const libs = {
    ready: makeLibrary(fx, "sensor-treiber", { commits: 2 }),
    drifted: makeLibrary(fx, "karten-kacheln", { commits: 3 }),
    edited: makeLibrary(fx, "auswertung-kern", { commits: 2 }),
    fresh: makeLibrary(fx, "protokoll", { commits: 1 }),
    extra: makeLibrary(fx, "wetter-symbole", { commits: 2, files: { "symbole/sonne.svg": "<svg/>\n" } }),
  };
  for (const key of ["ready", "drifted", "edited", "fresh"]) gitFile(fx, fx.path, "submodule", "add", "-q", libs[key].path, LIBS[key]);
  git(fx, fx.path, "commit", "-q", "-m", "Bibliotheken als Submodule eingebunden");
  git(fx, fx.path, "push", "-q", "origin", "main");

  const clonePath = path.join(fx.root, "station-klon");
  git(fx, fx.root, "clone", "-q", fx.remotePath, clonePath);
  git(fx, clonePath, "config", "user.name", "Lena Hartmann");
  git(fx, clonePath, "config", "user.email", "lena.hartmann@wetterstation.example");

  // Set up the states in the first repository.
  git(fx, path.join(fx.path, LIBS.drifted), "checkout", "-q", libs.drifted.shas[0]);
  fs.writeFileSync(path.join(fx.path, LIBS.edited, "NOTIZ.md"), "Lokaler Versuch, noch nicht committet.\n");
  gitFile(fx, fx.path, "submodule", "deinit", "-q", "-f", LIBS.fresh);
  return { fx, libs, clonePath };
}

/** Content of .gitmodules as a list of { name, path, url }. */
export function readGitmodules(repoPath) {
  const file = path.join(repoPath, ".gitmodules");
  if (!fs.existsSync(file)) return [];
  const entries = [];
  let current = null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const head = /^\[submodule "(.+)"\]$/.exec(line.trim());
    if (head) {
      current = { name: head[1], path: null, url: null };
      entries.push(current);
      continue;
    }
    const pair = /^\s*(path|url)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current[pair[1]] = pair[2].trim();
  }
  return entries;
}

/** `git worktree list --porcelain` as a list of { path, branch, head, locked, prunable, detached }. */
export function worktreeList(fx, repoPath) {
  const out = git(fx, repoPath, "worktree", "list", "--porcelain");
  return out
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const entry = { path: null, branch: null, head: null, locked: false, lockReason: null, prunable: false, detached: false };
      for (const line of block.split(/\r?\n/)) {
        const [key, ...rest] = line.split(" ");
        const value = rest.join(" ");
        if (key === "worktree") entry.path = value;
        else if (key === "HEAD") entry.head = value;
        else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "detached") entry.detached = true;
        else if (key === "locked") {
          entry.locked = true;
          entry.lockReason = value || null;
        } else if (key === "prunable") entry.prunable = true;
      }
      return entry;
    });
}

/** A server that accepts connections and never answers, so a clone reliably hangs "in flight". */
export function startSilentServer() {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: (name) => `http://127.0.0.1:${port}/${name}`,
        connections: () => sockets.size,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
