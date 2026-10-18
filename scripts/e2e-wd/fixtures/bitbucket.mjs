/**
 * Fixtures for the Bitbucket WebDriver feature (scripts/e2e-wd/features/bitbucket.mjs).
 *
 *   const mock = await startHostMock();
 *   const repo = makeBitbucketRepo(mock.remoteUrl("bitbucket"));  // real repo, origin = the mock's address
 *   const off = await startIssuesOffProxy(mock);                   // the same API, issue tracker switched off
 *   const cloud = await startBitbucketCloudFront(mock);            // "bitbucket.org" on this computer (proxy + own CA)
 *   const keyring = await startPrivateSecretService();             // own unlocked Secret Service: launchApp({ env: keyring.env })
 *   keychainItems(app.keyringService)                               // object paths in that Secret Service
 *
 * The repository's `origin` carries the test server's address (that is how the core finds the
 * Bitbucket repository team/demo), while `url.<bare>.insteadOf` sends Git's own transfers to a local
 * bare repository – fetch, push and "check out pull request" really run, and the host mock never has
 * to speak Git. The core reads the remote URL raw from the config (`git config --get-regexp`), so the
 * rewrite does not change what it detects.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { opensslPath } from "../../e2e/git-http-server.mjs";

/** Git in a fixture repository, isolated from the machine's configuration like the fixtures. */
function gitIn(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
    windowsHide: true,
  })
    .toString("utf8")
    .trim();
}

/**
 * A real repository whose `origin` points at the Bitbucket test server (`remoteUrl`) and whose
 * transfers go to a local bare repository. Branches on the remote: main, feature/export,
 * feature/login (source of the mock's pull request #7) and schon-da (rejected as a duplicate).
 */
export function makeBitbucketRepo(remoteUrl) {
  const repo = makeCleanRepoWithRemote({ name: "demo" });
  const git = (...args) => gitIn(repo.path, args);
  const bare = (...args) => gitIn(repo.remotePath, args);
  // feature/login only on the remote: the pull request's branch the app has to fetch.
  git("checkout", "-q", "-b", "feature/login", "main");
  fs.mkdirSync(path.join(repo.path, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo.path, "src", "anmeldung.py"), '"""Anmeldung mit Fehlermeldung bei leerem Passwort."""\n');
  git("add", "-A");
  git("commit", "-q", "-m", "Anmeldung: Fehlermeldung bei leerem Passwort");
  const loginHead = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "feature/login");
  git("checkout", "-q", "main");
  git("branch", "-q", "-D", "feature/login");
  git("update-ref", "-d", "refs/remotes/origin/feature/login");
  // Address of the host, transfers to the bare repository.
  git("remote", "set-url", "origin", remoteUrl);
  git("config", `url.${repo.remotePath}.insteadOf`, remoteUrl);
  return {
    path: repo.path,
    remotePath: repo.remotePath,
    loginHead,
    git,
    bare,
    write: (rel, text) => {
      const file = path.join(repo.path, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    cleanup: repo.cleanup,
  };
}

/**
 * A front for the host mock that answers like a Bitbucket repository with the issue tracker
 * switched off: `has_issues: false` on the repository and 404 on `/issues` – everything else is
 * passed through unchanged (including the Authorization header, so the mock checks the token).
 */
export async function startIssuesOffProxy(mock) {
  const target = new URL(mock.url);
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1");
      seen.push({ method: request.method, path: url.pathname });
      const repoPath = "/2.0/repositories/team/demo";
      if (url.pathname.startsWith(`${repoPath}/issues`)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { message: "Repository has no issue tracker." } }));
        return;
      }
      const headers = { ...request.headers, host: target.host };
      delete headers["if-none-match"];
      const forward = http.request({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers }, (answer) => {
        const parts = [];
        answer.on("data", (chunk) => parts.push(chunk));
        answer.on("end", () => {
          let body = Buffer.concat(parts);
          const out = { ...answer.headers };
          delete out.etag;
          if (url.pathname === repoPath && answer.statusCode === 200) {
            const value = JSON.parse(body.toString("utf8"));
            value.has_issues = false;
            body = Buffer.from(JSON.stringify(value));
          }
          out["content-length"] = String(body.length);
          response.writeHead(answer.statusCode ?? 500, out);
          response.end(body);
        });
      });
      forward.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      forward.end(Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    seen,
    remoteUrl: () => `${url}/team/demo.git`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Stand-in for Bitbucket Cloud: the connect dialog only offers bitbucket.org, and the core then
 * calls https://api.bitbucket.org/2.0. This is an HTTP proxy on 127.0.0.1 for the app's network
 * settings (`proxyUrl` + `sslCaFile`): a CONNECT to api.bitbucket.org:443 / bitbucket.org:443 is
 * answered with TLS of an own test CA and forwarded as plain HTTP to the host mock (same paths,
 * /2.0/…). Every other target is refused with 403 – nothing leaves this computer.
 *
 *   const cloud = await startBitbucketCloudFront(mock);
 *   await app.invoke("settings_set", { patch: { proxyUrl: cloud.proxyUrl, sslCaFile: cloud.caFile } });
 *   cloud.connects   [{ host, allowed }] every CONNECT the app made
 */
export async function startBitbucketCloudFront(mock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-wd-bbcloud-"));
  const file = (name) => path.join(dir, name);
  const run = (args) => execFileSync(opensslPath(), args, { stdio: "ignore", windowsHide: true });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("ca-key.pem"), "-out", file("ca.pem"), "-days", "2", "-subj", "/CN=forkyard E2E Test-CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", file("server-key.pem"), "-out", file("server.csr"), "-subj", "/CN=api.bitbucket.org"]);
  fs.writeFileSync(file("server.ext"), "subjectAltName=DNS:api.bitbucket.org,DNS:bitbucket.org\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  run(["x509", "-req", "-in", file("server.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca-key.pem"), "-CAcreateserial", "-out", file("server-cert.pem"), "-days", "2", "-extfile", file("server.ext")]);
  const key = fs.readFileSync(file("server-key.pem"));
  const cert = fs.readFileSync(file("server-cert.pem"));
  const target = new URL(mock.url);
  const allowed = new Set(["api.bitbucket.org:443", "bitbucket.org:443"]);
  const connects = [];
  const sockets = new Set();

  // Behind the TLS: plain forwarding to the mock.
  const inner = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const forward = http.request({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers: { ...request.headers, host: target.host } }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      forward.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      forward.end(Buffer.concat(chunks));
    });
  });
  const proxy = http.createServer((request, response) => {
    // Plain-HTTP proxy requests are not part of the plan: refuse.
    connects.push({ host: request.headers.host ?? request.url, allowed: false });
    response.writeHead(403);
    response.end();
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, socket, head) => {
    const ok = allowed.has(request.url);
    connects.push({ host: request.url, allowed: ok });
    if (!ok) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
    secure.on("error", () => socket.destroy());
    inner.emit("connection", secure);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    caFile: file("ca.pem"),
    connects,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(() => resolve()));
      inner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A private, unlocked Secret Service (own D-Bus session bus + gnome-keyring-daemon with a throw-away
 * "login" keyring in a temp folder) for the app under test – so tests neither depend on the state of
 * the user's keyring (it may be locked) nor leave items in it. Linux only; returns null when the
 * tools are missing. Pass `env` to launchApp. Stopped at process exit at the latest.
 *
 *   const keyring = await startPrivateSecretService();
 *   const app = await launchApp({ env: keyring.env });
 */
let privateService = null;

/** True when the Secret Service on `address` answers with an unlocked default collection. */
function secretServiceUnlocked(address) {
  try {
    const out = execFileSync(
      "gdbus",
      ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets/aliases/default", "--method", "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Collection", "Locked"],
      { timeout: 5000, env: busEnv(address), stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf8");
    return out.includes("false");
  } catch {
    return false;
  }
}

export async function startPrivateSecretService() {
  // gnome-keyring-daemon can abort (seen with 50.0: g_variant_new on a vanished caller, such as
  // the app of the previous scenario that quit during a call), even after a check that it still
  // works. Every scenario therefore gets a fresh service; the previous app is closed by now.
  if (privateService) privateService.stop();
  if (process.platform !== "linux") return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-wd-keyring-"));
  const env = { ...process.env, XDG_DATA_HOME: path.join(dir, "data"), XDG_RUNTIME_DIR: path.join(dir, "run") };
  fs.mkdirSync(env.XDG_DATA_HOME, { recursive: true });
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const control = path.join(dir, "control");
  fs.mkdirSync(control, { recursive: true, mode: 0o700 });
  // Own bus configuration without service directories: the system session config would D-Bus-activate
  // a fresh, locked gnome-keyring-daemon (outside this folder's control) after a crash.
  const config = path.join(dir, "bus.conf");
  fs.writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${path.join(dir, "bus")}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
`,
  );
  const bus = spawn("dbus-daemon", ["--config-file", config, "--nofork", "--print-address=1"], { env, stdio: ["ignore", "pipe", "ignore"] });
  const address = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("dbus-daemon did not start")), 10_000);
    bus.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    bus.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      if (out.includes("\n")) {
        clearTimeout(timer);
        resolve(out.trim());
      }
    });
  }).catch(() => null);
  if (!address) {
    bus.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  env.DBUS_SESSION_BUS_ADDRESS = address;
  // The bus must not keep the test process alive (lib.mjs writes results when the loop runs dry).
  bus.stdout.destroy();
  bus.unref();
  try {
    execFileSync("gnome-keyring-daemon", ["--unlock", "--components=secrets", `--control-directory=${control}`], { env, input: "test", stdio: ["pipe", "ignore", "ignore"], timeout: 15_000 });
    execFileSync("gnome-keyring-daemon", ["--start", "--components=secrets", `--control-directory=${control}`], { env, stdio: ["ignore", "ignore", "ignore"], timeout: 15_000 });
  } catch {
    bus.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Only the keyring daemons started for this folder (command line or environment names it).
    for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmd.includes("gnome-keyring-daemon")) continue;
        const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
        if (cmd.includes(control) || environ.includes(`XDG_DATA_HOME=${env.XDG_DATA_HOME}\0`)) process.kill(Number(pid), "SIGTERM");
      } catch {
        // gone
      }
    }
    try {
      bus.kill();
    } catch {
      // gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (privateService?.stop === stop) privateService = null;
  };
  process.once("exit", stop);
  // Ready once the default collection answers unlocked (the daemon registers asynchronously).
  const deadline = Date.now() + 10_000;
  while (!secretServiceUnlocked(address)) {
    if (Date.now() > deadline) {
      stop();
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  privateService = { address, env: { DBUS_SESSION_BUS_ADDRESS: address }, stop };
  return privateService;
}

function busEnv(address) {
  return address ? { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } : process.env;
}

/** Object paths of the Secret Service items stored under `service` (Linux; [] elsewhere or without the bus). */
export function keychainItems(service, address = privateService?.address) {
  if (process.platform !== "linux") return [];
  try {
    const out = execFileSync(
      "gdbus",
      ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.SearchItems", `{'service': '${service}'}`],
      { timeout: 10_000, env: busEnv(address) },
    ).toString("utf8");
    return [...out.matchAll(/'(\/org\/freedesktop\/secrets\/[^']+)'/g)].map((match) => match[1]);
  } catch {
    return [];
  }
}

/** Removes every Secret Service item of `service` (only test services: forkyard-test-*). */
export function clearKeychain(service, address = privateService?.address) {
  if (!/^forkyard-test-/.test(service ?? "")) return;
  for (const item of keychainItems(service, address)) {
    try {
      execFileSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", item, "--method", "org.freedesktop.Secret.Item.Delete"], { timeout: 10_000, stdio: "ignore", env: busEnv(address) });
    } catch {
      // gone already
    }
  }
}
