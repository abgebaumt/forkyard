/**
 * Small SSH Git server for E2E tests: starts the system's OpenSSH sshd as an ordinary user process
 * (no admin rights, no service) on 127.0.0.1 and a free port, with its own configuration, host key
 * and authorized_keys file in a temp folder. Only git-upload-pack and git-receive-pack over bare
 * repositories in this folder are served.
 *
 *   import { startGitSshServer } from "./git-ssh-server.mjs";
 *   const server = await startGitSshServer();
 *   server.createBare("messnetz.git", { from: repo.path });
 *   server.authorize(publicKeyText);                 // line from <key>.pub
 *   server.url("messnetz.git")                       // ssh://<user>@127.0.0.1:<port>/messnetz.git
 *   server.hostFingerprint                           // "SHA256:…" of the host key
 *   server.accepted()                                // key fingerprints of all successful logins
 *   await server.ready()                             // before every Git call: sshd accepts (again)
 *   await server.close();
 *
 * How it works without admin rights: sshd runs in debug mode (`-d`). It then skips switching the
 * user and logs in exactly the user it runs as. In debug mode sshd serves ONE connection and exits;
 * this server therefore restarts it after every connection (one Git call = one connection). Two
 * connections at the same time do not work.
 *
 * On Windows sshd runs commands through cmd.exe, which does not understand the single quotes of
 * `git-upload-pack '/path'`. `ForceCommand` therefore routes every command to a small shell script
 * (sh of Git for Windows) that only allows the two Git services.
 *
 * `findSshd()` returns null if there is no sshd – then no SSH round trip is possible.
 *
 * Called directly (to try it out):
 *   node scripts/e2e/git-ssh-server.mjs [--repo <path>] [--key <path-to-.pub>]
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitIsolationEnv, globalGitConfig } from "./fixtures.mjs";

const TEMP_PREFIX = "gc-fix-sshgit-";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (file) => path.resolve(file).replaceAll("\\", "/");

/** Path of sshd or null. */
export function findSshd() {
  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "sshd.exe"), "C:\\Program Files\\OpenSSH\\sshd.exe"]
      : ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

/** ssh-keygen from the same folder as sshd (same key formats), otherwise from PATH. */
function keygenFor(sshd) {
  const beside = path.join(path.dirname(sshd), process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen");
  return fs.existsSync(beside) ? beside : "ssh-keygen";
}

/** sh of Git for Windows (runs the Git services with POSIX quoting). */
function gitShell() {
  if (process.platform !== "win32") return "/bin/sh";
  const execPath = execFileSync("git", ["--exec-path"], { windowsHide: true }).toString("utf8").trim();
  const root = path.resolve(execPath, "..", "..", "..");
  for (const candidate of [path.join(root, "bin", "sh.exe"), path.join(root, "usr", "bin", "sh.exe")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("sh.exe of Git for Windows not found.");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Only the own user may access the file (sshd refuses keys that others can read). */
function restrict(file) {
  if (process.platform === "win32") {
    const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.replace(/^\\/, "");
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
  } else {
    fs.chmodSync(file, 0o600);
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.user] user name in the URL. Default: the logged-in user (another one does not work without admin rights).
 */
export async function startGitSshServer({ user = os.userInfo().username } = {}) {
  const sshd = findSshd();
  if (!sshd) throw new Error("There is no sshd on this machine.");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  const reposDir = path.join(root, "repos");
  fs.mkdirSync(reposDir);
  const gitConfig = path.join(root, "gitconfig");
  fs.writeFileSync(gitConfig, globalGitConfig());
  const isolation = gitIsolationEnv(gitConfig);
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env: { ...process.env, ...isolation }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString("utf8").trim();

  // Host key
  const hostKey = path.join(root, "host_ed25519");
  const keygen = keygenFor(sshd);
  execFileSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "gc-e2e-host", "-f", hostKey], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  restrict(hostKey);
  const hostFingerprint = execFileSync(keygen, ["-l", "-E", "sha256", "-f", `${hostKey}.pub`], { windowsHide: true }).toString("utf8").trim().split(/\s+/)[1];
  const hostPublicKey = fs.readFileSync(`${hostKey}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");

  const authorizedKeys = path.join(root, "authorized_keys");
  fs.writeFileSync(authorizedKeys, "");
  restrict(authorizedKeys);

  // Only the two Git services, path relative to the repositories folder.
  const serve = path.join(root, "serve.sh");
  fs.writeFileSync(
    serve,
    [
      "#!/bin/sh",
      `root='${slash(reposDir)}'`,
      'set -f',
      'service=${SSH_ORIGINAL_COMMAND%% *}',
      'target=${SSH_ORIGINAL_COMMAND#* }',
      "target=$(printf '%s' \"$target\" | tr -d \"'\")",
      'case "$service" in',
      '  git-upload-pack|git-receive-pack) ;;',
      '  *) echo "Git services only: $service" >&2; exit 1 ;;',
      'esac',
      'case "$target" in',
      '  *..*) echo "Invalid path" >&2; exit 1 ;;',
      'esac',
      `export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL='${slash(gitConfig)}'`,
      'exec "$service" "$root/${target#/}"',
      "",
    ].join("\n"),
  );
  const shell = gitShell();
  const wrapper = path.join(root, "serve.cmd");
  fs.writeFileSync(wrapper, `@"${shell}" "${slash(serve)}"\r\n`);

  const port = await freePort();
  const config = path.join(root, "sshd_config");
  const pidFile = path.join(root, "sshd.pid");
  fs.writeFileSync(
    config,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${slash(hostKey)}`,
      `PidFile ${slash(pidFile)}`,
      `AuthorizedKeysFile ${slash(authorizedKeys)}`,
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "StrictModes no",
      "UseDNS no",
      "LogLevel VERBOSE",
      process.platform === "win32" ? `ForceCommand "${wrapper}"` : `ForceCommand /bin/sh ${serve}`,
      "",
    ].join("\n"),
  );

  const logPath = path.join(root, "sshd.log");
  const state = { child: null, closed: false, listening: false, starts: 0, lastExit: null };
  let log = "";

  const startOnce = () =>
    new Promise((resolve) => {
      state.starts += 1;
      // -d: debug mode (no user switch, one connection), -e: log to stderr.
      const child = spawn(sshd, ["-f", config, "-d", "-e"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      state.child = child;
      let own = "";
      const onData = (chunk) => {
        const text = chunk.toString("utf8");
        own += text;
        log += text;
        fs.appendFileSync(logPath, text);
        // sshd is free between "Server listening" and the first connection.
        if (state.child === child) state.listening = /Server listening on/.test(own) && !/Connection from /.test(own);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", (code) => {
        state.lastExit = code;
        if (state.child === child) {
          state.child = null;
          state.listening = false;
        }
        resolve(code);
      });
    });

  // Endless loop: restart after every connection.
  const loop = (async () => {
    let quickFailures = 0;
    while (!state.closed) {
      const started = Date.now();
      await startOnce();
      if (state.closed) break;
      quickFailures = Date.now() - started < 300 ? quickFailures + 1 : 0;
      if (quickFailures > 5) break;
    }
  })();

  const waitListening = async (timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (state.listening && state.child) return true;
      if (Date.now() > deadline) return false;
      await sleep(40);
    }
  };

  const handle = {
    port,
    root,
    reposDir,
    user,
    hostFingerprint,
    hostPublicKey,
    logPath,
    /** Fingerprints of the keys someone logged in with (in login order). */
    accepted() {
      return Array.from(log.matchAll(/Accepted publickey for \S+ from \S+ port \d+ ssh2: \S+ (SHA256:\S+)/g), (match) => match[1]);
    },
    /** Number of connections that failed to authenticate. */
    rejected() {
      return (log.match(/Connection (?:closed|reset) by authenticating user|Too many authentication failures/g) ?? []).length;
    },
    get connections() {
      return handle.accepted().length;
    },
    get log() {
      return log;
    },
    url(name) {
      return `ssh://${user}@127.0.0.1:${port}/${name}`;
    },
    createBare(name, { from = null } = {}) {
      const dir = path.join(reposDir, name);
      if (from) git(reposDir, "clone", "-q", "--bare", from, dir);
      else {
        fs.mkdirSync(dir, { recursive: true });
        git(dir, "init", "-q", "--bare", "-b", "main");
      }
      return dir;
    },
    git: (name, ...args) => git(path.join(reposDir, name), ...args),
    /** Authorizes a public key (text of the .pub file). */
    authorize(publicKey) {
      fs.appendFileSync(authorizedKeys, `${publicKey.trim()}\n`);
    },
    /** Revokes all keys. */
    revokeAll() {
      fs.writeFileSync(authorizedKeys, "");
    },
    /** Waits until sshd accepts connections (again) – it restarts after every connection. */
    ready: () => waitListening(),
    async close() {
      if (state.closed) return;
      state.closed = true;
      try {
        state.child?.kill();
      } catch {
        // already gone
      }
      await Promise.race([loop, sleep(3000)]);
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // On Windows a process that just exited sometimes holds the folder for a moment.
      }
    },
  };
  process.on("exit", () => {
    if (!state.closed) {
      try {
        state.child?.kill();
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // leave it
      }
    }
  });

  if (!(await waitListening())) {
    const tail = log.split(/\r?\n/).slice(-25).join("\n");
    await handle.close();
    throw new Error(`sshd could not be started as a user process (${sshd}).\n${tail}`);
  }
  return handle;
}

// Called directly: start the server and keep it running.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const server = await startGitSshServer();
  const repoIndex = argv.indexOf("--repo");
  const name = repoIndex >= 0 ? `${path.basename(argv[repoIndex + 1]).replace(/\.git$/, "")}.git` : "projekt.git";
  server.createBare(name, { from: repoIndex >= 0 ? argv[repoIndex + 1] : null });
  const keyIndex = argv.indexOf("--key");
  if (keyIndex >= 0) server.authorize(fs.readFileSync(argv[keyIndex + 1], "utf8"));
  console.log(`SSH Git server running: ${server.url(name)}`);
  console.log(`Host key: ${server.hostFingerprint}`);
  console.log(`Log: ${server.logPath}`);
  console.log("Stop with Ctrl+C.");
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}
