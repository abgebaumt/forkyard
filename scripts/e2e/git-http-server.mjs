/**
 * Small Git server for E2E tests: serves `git http-backend` via CGI, with Basic auth, on
 * 127.0.0.1 and a free port, over bare repositories in its own temp folder. Optionally with TLS
 * (self-signed certificate, created with the openssl of Git for Windows or of the system) – then
 * it is a real HTTPS round trip.
 *
 *   import { startGitHttpServer } from "./git-http-server.mjs";
 *   const server = await startGitHttpServer({ users: { lena: "geheim" }, tls: true });
 *   server.createBare("messnetz.git", { from: repo.path });   // create a bare repo (optionally from an existing one)
 *   server.url("messnetz.git")                               // https://127.0.0.1:<port>/messnetz.git
 *   server.caFile                                            // certificate for http.sslCAInfo (tls only)
 *   server.requests                                          // [{ method, path, user, status }]
 *   server.setPassword("lena", "neu");                       // change the password (remembered credentials become invalid)
 *   await server.close();                                    // stops and removes the temp folder
 *
 * Called directly (to try it out):
 *   node scripts/e2e/git-http-server.mjs --user lena:geheim [--tls] [--repo <path-to-a-repo>]
 *
 * Push is allowed (http.receivepack=true in every bare repo). Every request without valid
 * credentials gets 401 – reads too, so Git always asks for credentials.
 *
 * Caution: the server runs in the test script's process. An `execFileSync("git", …)` AGAINST this
 * server blocks the event loop and therefore hangs forever – make such calls asynchronous
 * (execFile + await). The app is a separate process, this does not apply to it.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitIsolationEnv, globalGitConfig } from "./fixtures.mjs";

const TEMP_PREFIX = "gc-fix-httpgit-";

function gitExecPath() {
  return execFileSync("git", ["--exec-path"], { windowsHide: true }).toString("utf8").trim();
}

/** Path of git-http-backend (with Git for Windows under mingw64/libexec/git-core). */
export function httpBackendPath() {
  const dir = gitExecPath();
  const name = process.platform === "win32" ? "git-http-backend.exe" : "git-http-backend";
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`git-http-backend not found: ${file}`);
  return file;
}

/** openssl: first the one of Git for Windows, then the one in PATH. */
export function opensslPath() {
  if (process.platform === "win32") {
    const gitRoot = path.resolve(gitExecPath(), "..", "..", "..");
    for (const candidate of [path.join(gitRoot, "usr", "bin", "openssl.exe"), path.join(gitRoot, "mingw64", "bin", "openssl.exe")]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "openssl";
}

/** Self-signed certificate for 127.0.0.1 (key and certificate as PEM files). */
function makeCertificate(dir) {
  const key = path.join(dir, "server-key.pem");
  const cert = path.join(dir, "server-cert.pem");
  execFileSync(
    opensslPath(),
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  return { key, cert };
}

/** Reads the CGI response: headers up to the empty line, then the body as a stream. */
function pipeCgiResponse(child, response, onStatus) {
  let head = Buffer.alloc(0);
  let headerDone = false;
  child.stdout.on("data", (chunk) => {
    if (headerDone) {
      response.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    let end = head.indexOf("\r\n\r\n");
    let sep = 4;
    if (end < 0) {
      end = head.indexOf("\n\n");
      sep = 2;
    }
    if (end < 0) return;
    headerDone = true;
    const lines = head.subarray(0, end).toString("latin1").split(/\r?\n/);
    let status = 200;
    const headers = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
      else headers[name] = value;
    }
    onStatus(status);
    response.writeHead(status, headers);
    const rest = head.subarray(end + sep);
    if (rest.length) response.write(rest);
  });
  child.stdout.on("end", () => {
    if (!headerDone) {
      onStatus(500);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
    }
    response.end();
  });
}

/**
 * @param {object} [options]
 * @param {Record<string,string>} [options.users]  user → password. Default: { lena: "geheim" }.
 * @param {boolean} [options.tls=false]           HTTPS with a self-signed certificate.
 * @param {string}  [options.realm]               text of the auth realm.
 */
export async function startGitHttpServer({ users = { lena: "geheim" }, tls = false, realm = "Messnetz-Server" } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  const reposDir = path.join(root, "repos");
  fs.mkdirSync(reposDir);
  const gitConfig = path.join(root, "gitconfig");
  fs.writeFileSync(gitConfig, globalGitConfig());
  const isolation = gitIsolationEnv(gitConfig);
  const backend = httpBackendPath();
  const accounts = new Map(Object.entries(users));
  const requests = [];

  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env: { ...process.env, ...isolation }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString("utf8").trim();

  const authorize = (header) => {
    const match = /^Basic\s+(.+)$/i.exec(header ?? "");
    if (!match) return null;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    const user = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    return accounts.has(user) && accounts.get(user) === password ? user : { rejected: user };
  };

  const handler = (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const entry = { method: request.method, path: url.pathname, query: url.search, user: null, rejected: null, status: 0, at: Date.now() };
    requests.push(entry);
    const auth = authorize(request.headers.authorization);
    if (typeof auth !== "string") {
      entry.status = 401;
      entry.rejected = auth?.rejected ?? null;
      request.resume();
      response.writeHead(401, { "WWW-Authenticate": `Basic realm="${realm}"`, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authentication required\n");
      return;
    }
    entry.user = auth;
    const env = {
      ...process.env,
      ...isolation,
      GIT_PROJECT_ROOT: reposDir,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ""),
      REQUEST_METHOD: request.method,
      REMOTE_USER: auth,
      REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
      SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
      GATEWAY_INTERFACE: "CGI/1.1",
    };
    if (request.headers["content-type"]) env.CONTENT_TYPE = request.headers["content-type"];
    if (request.headers["content-length"]) env.CONTENT_LENGTH = request.headers["content-length"];
    if (request.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = request.headers["content-encoding"];
    if (request.headers["git-protocol"]) env.GIT_PROTOCOL = request.headers["git-protocol"];
    const child = spawn(backend, [], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      entry.status = 500;
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(`git-http-backend: ${error.message}\n`);
    });
    child.on("close", () => {
      if (stderr.trim()) entry.stderr = stderr.trim();
    });
    request.pipe(child.stdin);
    child.stdin.on("error", () => undefined);
    pipeCgiResponse(child, response, (status) => {
      entry.status = status;
    });
  };

  let caFile = null;
  let server;
  if (tls) {
    const { key, cert } = makeCertificate(root);
    caFile = cert;
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
  } else {
    server = http.createServer(handler);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const scheme = tls ? "https" : "http";
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  let closed = false;
  const handle = {
    port,
    root,
    reposDir,
    caFile,
    scheme,
    requests,
    /** Address of a repository on the server; with `user` the user is part of the URL. */
    url(name, { user = null } = {}) {
      return `${scheme}://${user ? `${encodeURIComponent(user)}@` : ""}127.0.0.1:${port}/${name}`;
    },
    /** Creates a bare repository, empty or as a copy of `from`; push is allowed. */
    createBare(name, { from = null } = {}) {
      const dir = path.join(reposDir, name);
      if (from) git(reposDir, "clone", "-q", "--bare", from, dir);
      else {
        fs.mkdirSync(dir, { recursive: true });
        git(dir, "init", "-q", "--bare", "-b", "main");
      }
      git(dir, "config", "http.receivepack", "true");
      return dir;
    },
    /** git in the bare repository on the server. */
    git: (name, ...args) => git(path.join(reposDir, name), ...args),
    setPassword(user, password) {
      accounts.set(user, password);
    },
    /** Requests that carried credentials (accepted or rejected), from index `from`. */
    authenticated(from = 0) {
      return requests.slice(from).filter((entry) => entry.user || entry.rejected);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // On Windows a process that just exited sometimes holds the folder for a moment.
      }
    },
  };
  process.on("exit", () => {
    if (!closed) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // leave it
      }
    }
  });
  return handle;
}

// Called directly: start the server and keep it running.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const users = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--user") {
      const [user, ...rest] = argv[index + 1].split(":");
      users[user] = rest.join(":");
    }
  }
  const server = await startGitHttpServer({ users: Object.keys(users).length ? users : undefined, tls: argv.includes("--tls") });
  const repoIndex = argv.indexOf("--repo");
  const name = repoIndex >= 0 ? `${path.basename(argv[repoIndex + 1]).replace(/\.git$/, "")}.git` : "projekt.git";
  server.createBare(name, { from: repoIndex >= 0 ? argv[repoIndex + 1] : null });
  console.log(`Git server running: ${server.url(name)}`);
  if (server.caFile) console.log(`Certificate (for http.sslCAInfo): ${server.caFile}`);
  console.log("Stop with Ctrl+C.");
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}
