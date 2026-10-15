/**
 * A local "forge" for the GitHub/GitLab WebDriver features: ONE address on 127.0.0.1 that answers
 * the host APIs (forwarded to scripts/e2e/host-mock.mjs) and serves real Git over HTTP (forwarded
 * to scripts/e2e/git-http-server.mjs). The app gets this address as a self-hosted instance and the
 * test repository's remote points to the same address – so the core detects the host AND fetch and
 * push really run (against bare repositories on the local Git server). Nothing goes to a real service.
 *
 *   const forge = await startForge();
 *   const repo = forge.makeRepo("github");     // clone of makeCleanRepoWithRemote, origin -> forge
 *   forge.url / forge.token / forge.weakToken / forge.badToken
 *   forge.mock                                  // the host-mock handle (requests, state, fail, delay …)
 *   forge.bareGit("github", "rev-parse", "main") // git in the bare repository on the server
 *   await forge.close()
 *
 * `forge.appEnv` points the app at a PRIVATE Secret Service (own dbus-daemon + gnome-keyring-daemon
 * with a throw-away, unlocked keyring in a temp folder): tokens of the tests never reach the
 * user's keychain, and a locked login keyring of the desktop session does not break the tests.
 *
 * The Git server needs Basic auth; the proxy adds it (user "lena"), so Git never asks for
 * credentials. The host mock builds its links from the Host header, which stays the proxy's.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { startGitHttpServer } from "../../e2e/git-http-server.mjs";
import { startHostMock } from "../../e2e/host-mock.mjs";

export const REPO_PATHS = { github: "octo/demo", gitlab: "gruppe/unter/demo" };
const GIT_USER = "lena";
const GIT_PASSWORD = "geheim";

/**
 * Own session bus with gnome-keyring's Secret Service and an unlocked "login" keyring (password
 * "e2e") in a temp folder. Returns { env, close }; `env` goes into launchApp({ env }).
 * Without dbus-daemon/gnome-keyring-daemon: { env: {}, close() {} } (the session's keychain is used).
 */
export async function startPrivateKeyring() {
  const has = (program) => {
    try {
      execFileSync("which", [program], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (process.platform !== "linux" || !has("dbus-daemon") || !has("gnome-keyring-daemon")) return { env: {}, private: false, close: async () => undefined };
  // Short path: the keyring's control socket must fit into sun_path (108 bytes).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-kr-"));
  fs.mkdirSync(path.join(dir, "run"), { mode: 0o700 });
  const bus = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dbus-daemon did not print its address")), 5000);
    bus.stdout.once("data", (data) => {
      clearTimeout(timer);
      resolve(data.toString().trim().split("\n")[0]);
    });
    bus.once("error", reject);
  });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, XDG_DATA_HOME: path.join(dir, "data"), XDG_RUNTIME_DIR: path.join(dir, "run"), DBUS_SESSION_BUS_ADDRESS: address };
  const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], { env, stdio: ["pipe", "ignore", "ignore"] });
  keyring.stdin.end("e2e");
  const unlocked = () => {
    try {
      return execFileSync("busctl", ["--user", "call", "org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default", "org.freedesktop.DBus.Properties", "Get", "ss", "org.freedesktop.Secret.Collection", "Locked"], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address }, stdio: ["ignore", "pipe", "ignore"] }).toString().includes("false");
    } catch {
      return false;
    }
  };
  for (let round = 0; round < 50 && !unlocked(); round++) await new Promise((resolve) => setTimeout(resolve, 100));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    keyring.kill();
    bus.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  process.on("exit", () => {
    if (!closed) {
      keyring.kill();
      bus.kill();
    }
  });
  return { env: { DBUS_SESSION_BUS_ADDRESS: address }, private: true, close };
}

export async function startForge() {
  const keyring = await startPrivateKeyring();
  const mock = await startHostMock();
  const git = await startGitHttpServer({ users: { [GIT_USER]: GIT_PASSWORD } });
  const mockPort = mock.port;
  const gitPort = git.port;
  const auth = `Basic ${Buffer.from(`${GIT_USER}:${GIT_PASSWORD}`).toString("base64")}`;
  const gitRequests = [];

  const server = http.createServer((request, response) => {
    const isGit = /\.git(\/|$)/.test(new URL(request.url, "http://x").pathname);
    if (isGit) gitRequests.push({ method: request.method, path: request.url });
    const headers = { ...request.headers };
    if (isGit) headers.authorization = auth;
    const upstream = http.request(
      { host: "127.0.0.1", port: isGit ? gitPort : mockPort, method: request.method, path: request.url, headers },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(`forge proxy: ${error.message}\n`);
    });
    request.pipe(upstream);
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const repos = [];

  return {
    url,
    /** Environment for launchApp({ env }): the private keychain. */
    appEnv: keyring.env,
    privateKeyring: keyring.private,
    token: mock.token,
    weakToken: mock.weakToken,
    /** Rejected by the mock (401). */
    badToken: "ghp_FalschesTestToken00000000000000000000",
    mock,
    git,
    gitRequests,
    remoteUrl: (kind) => `${url}/${REPO_PATHS[kind]}.git`,
    /**
     * A fresh repository (main + feature/export, both pushed) whose origin is the forge's
     * repository for `kind`. The bare repository on the server is a copy of the fixture's remote.
     */
    makeRepo(kind = "github", { name = `demo-${kind}` } = {}) {
      const repo = makeCleanRepoWithRemote({ name });
      git.createBare(`${REPO_PATHS[kind]}.git`, { from: repo.remotePath });
      repo.git("remote", "set-url", "origin", `${url}/${REPO_PATHS[kind]}.git`);
      repos.push(repo);
      return repo;
    },
    /** git in the bare repository of `kind` on the server (filesystem, no HTTP – never blocks). */
    bareGit: (kind, ...args) => git.git(`${REPO_PATHS[kind]}.git`, ...args),
    /** Does the bare repository of `kind` have this branch? Returns its SHA or null. */
    bareBranch(kind, branch) {
      try {
        return git.git(`${REPO_PATHS[kind]}.git`, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      } catch {
        return null;
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await mock.close();
      await git.close();
      await keyring.close();
      for (const repo of repos) {
        try {
          repo.cleanup();
        } catch {
          // temp folder – the fixtures sweep it later
        }
      }
    },
  };
}
