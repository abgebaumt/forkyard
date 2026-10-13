/**
 * E2E driver: starts the built debug app as a separate process and drives its WebView2 over the
 * Chrome DevTools Protocol (Playwright, `chromium.connectOverCDP`). No Playwright browsers are
 * needed or installed.
 *
 *   import { launchApp } from "./driver.mjs";
 *   const app = await launchApp({ width: 1440, height: 900 });
 *   await app.openRepo(repo.path);                       // open a repository and wait for its tab
 *   await app.page.getByRole("button", { name: "Fetch" }).click();
 *   await app.screenshot("target/e2e/shots/shell.png");
 *   if (app.consoleErrors.length) throw new Error(app.consoleErrors.join("\n"));
 *   await app.close();
 *
 * What `launchApp` does:
 * - checks that `target/debug/forkyard(.exe)` is built (`cargo build`),
 * - makes sure there is ONE shared Vite server for this checkout (see `ensureDevServer`),
 * - starts the app with its own data directory, WebView2 profile, CDP port and global gitconfig –
 *   any number of instances run side by side (the app has no single-instance lock),
 * - the window is invisible and takes no focus (`show: true` shows it),
 * - the REAL window gets the requested size, no emulated viewport: the WebView runs at scale 1,
 *   and the app sets the inner window size in physical pixels (FORKYARD_WINDOW_SIZE, read in
 *   src-tauri/src/lib.rs). So 1440×900 is 1440×900 CSS pixels on every screen, and a screenshot
 *   has exactly that many pixels,
 * - connects, reloads the page once (so console errors are captured from the first moment) and
 *   waits for the shell.
 *
 * Measured: a start takes 1 to 3 seconds when the Vite server is already running and 4 to 5 when
 * it has to start first (the very first start also bundles the dependencies). With builds running
 * at the same time (several cargo runs), 20 to 30 seconds were measured too – hence the generous
 * time limits. `GC_E2E_TRACE=1` shows where the time goes.
 *
 * The Vite server: the debug app loads the UI from a dev server. `tauri dev` uses port 1420 with
 * HMR. The driver deliberately uses a DIFFERENT server (from port 1421, without HMR): with HMR,
 * every file saved by anyone reloads the pages of all running test instances. Without HMR an
 * instance keeps the state it started with; to see a change, start a new instance (or
 * `app.reload()`). Port 1420 may also be served by ANOTHER checkout – so the driver asks every
 * server under `/__gc_root` which directory it serves and only takes its own.
 * PID and port are stored in `target/e2e/vite.json` (outside of git).
 *   node scripts/e2e/driver.mjs --status      shows the server
 *   node scripts/e2e/driver.mjs --stop-vite   stops it
 *
 * Platforms: Windows only (WebView2 is Chromium and speaks CDP). On Linux Tauri uses WebKitGTK,
 * on macOS WKWebView – neither has CDP, `launchApp` aborts there with a clear message. The only
 * E2E option there would be WebDriver via `tauri-driver` (Linux), which is not set up here.
 *
 * Limits:
 * - Keys sent via `page.keyboard` arrive as DOM events but do not trigger shortcuts of the
 *   WebView itself (print, find in page): those cannot be tested over CDP. `page.keyboard` only
 *   knows the US layout; for "Ctrl+/" on a German keyboard dispatch a KeyboardEvent with key "/"
 *   and shiftKey yourself (example in shell.mjs).
 * - A user cannot drag the window smaller than 960×600; the driver can (the minimum size does not
 *   apply to sizes that are set). Larger than the screen does not always work – if the window
 *   does not take the size, `launchApp` and `setSize` report it as an error.
 * - The invisible window has no real focus. Playwright makes the page behave as if it had it
 *   (document.hasFocus() is true, :focus-visible applies); trigger a window focus change with
 *   `window.dispatchEvent(new Event("focus"))`.
 * - The system folder dialog cannot be remote-controlled: `app.pick(path)` provides the answer
 *   for the next `pickFolder`/`pickFile` of the UI.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { TEST_IDENTITY, gitIsolationEnv, globalGitConfig, isAlive } from "./fixtures.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Runtime files live under target/ (ignored by git).
const STATE_DIR = path.join(ROOT, "target", "e2e");
const VITE_STATE = path.join(STATE_DIR, "vite.json");
const VITE_LOCK = path.join(STATE_DIR, "vite.lock");
const VITE_LOG = path.join(STATE_DIR, "vite.log");
// Every checkout (worktree) has its own server.
const VITE_PORTS = Array.from({ length: 29 }, (_, index) => 1421 + index);
const TEMP_PREFIX = "gc-e2e-";
const TRACE = Boolean(process.env.GC_E2E_TRACE);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).replaceAll("\\", "/").toLowerCase() === path.resolve(b).replaceAll("\\", "/").toLowerCase();

async function getJson(url, timeoutMs = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// Vite server
// ---------------------------------------------------------------------------

/** "ours" = server of this checkout, "foreign" = something else holds the port, "free" = nobody answers. */
async function probePort(port) {
  try {
    const info = await getJson(`http://127.0.0.1:${port}/__gc_root`);
    return info?.root && samePath(info.root, ROOT) ? { state: "ours", pid: info.pid ?? null } : { state: "foreign", pid: null };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (code === "ECONNREFUSED") return { state: "free", pid: null };
    // Answers, but not with our identifier (HTML, 404, timeout): leave it alone.
    return { state: "foreign", pid: null };
  }
}

function readViteState() {
  try {
    return JSON.parse(fs.readFileSync(VITE_STATE, "utf8"));
  } catch {
    return null;
  }
}

async function findOurServer() {
  const known = readViteState()?.port;
  const ports = known ? [known, ...VITE_PORTS.filter((port) => port !== known)] : VITE_PORTS;
  let free = null;
  for (const port of ports) {
    const probe = await probePort(port);
    if (probe.state === "ours") return { url: `http://127.0.0.1:${port}`, port, pid: probe.pid, free };
    if (probe.state === "free" && free === null && VITE_PORTS.includes(port)) free = port;
  }
  return { url: null, port: null, pid: null, free };
}

/**
 * Returns the address of the shared Vite server for tests and starts it if none is running.
 * A running server is never touched. Several processes may call this at the same time.
 */
export async function ensureDevServer({ timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // The usual case first and cheaply: the remembered port answers.
  const known = readViteState()?.port;
  if (known && (await probePort(known)).state === "ours") return `http://127.0.0.1:${known}`;
  for (;;) {
    const found = await findOurServer();
    if (found.url) return found.url;
    if (Date.now() > deadline) {
      throw new Error(`The Vite server for tests did not start. Log: ${VITE_LOG}\n${tail(VITE_LOG)}`);
    }
    if (found.free === null) throw new Error(`Ports ${VITE_PORTS[0]} to ${VITE_PORTS.at(-1)} are all taken by other programs.`);

    // Only one process starts the server; the others wait until it answers.
    fs.mkdirSync(STATE_DIR, { recursive: true });
    let lock = null;
    try {
      lock = fs.openSync(VITE_LOCK, "wx");
    } catch {
      const age = Date.now() - (fs.statSync(VITE_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 90_000) fs.rmSync(VITE_LOCK, { force: true });
      await sleep(300);
      continue;
    }
    try {
      const again = await findOurServer();
      if (again.url) return again.url;
      const port = again.free ?? found.free;
      const log = fs.openSync(VITE_LOG, "w");
      const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(port), "--strictPort"], {
        cwd: ROOT,
        env: { ...process.env, FORKYARD_E2E_PORT: String(port) },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      });
      child.unref();
      fs.closeSync(log);
      fs.writeFileSync(VITE_STATE, JSON.stringify({ pid: child.pid, port, root: ROOT, startedAt: new Date().toISOString() }, null, 2));
      const url = `http://127.0.0.1:${port}`;
      while ((await probePort(port)).state !== "ours") {
        if (Date.now() > deadline) throw new Error(`The Vite server does not answer on port ${port}. Log: ${VITE_LOG}\n${tail(VITE_LOG)}`);
        await sleep(150);
      }
      // Warm up once: the first request triggers bundling of the dependencies.
      await fetch(`${url}/src/main.tsx`, { signal: AbortSignal.timeout(60_000) }).then((response) => response.text()).catch(() => undefined);
      return url;
    } finally {
      fs.closeSync(lock);
      fs.rmSync(VITE_LOCK, { force: true });
    }
  }
}

/** Stops the Vite server for tests – only the one that identifies itself as this checkout's server. */
export async function stopDevServer() {
  const found = await findOurServer();
  if (found.url && found.pid) killTree(found.pid);
  fs.rmSync(VITE_STATE, { force: true });
  return Boolean(found.url && found.pid);
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function tail(file, lines = 30) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Kills a process with its child processes (WebView2 starts several). */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      killPid(pid);
    }
  }
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function removeDir(dir, retries = 10) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/** Running instances of this Node process; none is left behind when the process exits. */
const running = new Map();
let hooksInstalled = false;
function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = () => {
    for (const [pid, instance] of running) {
      killTree(pid);
      for (const child of instance.pids) killPid(child);
      for (const dir of instance.dirs) removeInstanceDir(dir, 3);
    }
    running.clear();
  };
  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.on(signal, () => {
      killAll();
      process.exit(130);
    });
  }
}

const OWNER_FILE = ".owner.json";
let reaped = false;

/** Is our app (still) running under this PID? Protects against killing a reused PID. */
function isOurApp(pid) {
  if (!isAlive(pid)) return false;
  if (process.platform !== "win32") return true;
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return (result.stdout ?? "").toLowerCase().includes(path.basename(appBinary()).toLowerCase());
}

/**
 * If a test script is killed hard (caller's time limit, crash), the exit hooks do not run: the app
 * would stay invisible in the background. So every start removes instances whose driver process
 * is gone, including their temp folders. This never delays the start: whatever cannot be deleted
 * right away is removed by a detached background process.
 */
function reapOrphans() {
  if (reaped) return;
  reaped = true;
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(TEMP_PREFIX));
  } catch {
    return;
  }
  const locked = [];
  for (const entry of entries) {
    const dir = path.join(os.tmpdir(), entry);
    try {
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8"));
      } catch {
        // No owner file: either being created right now or the remains of a half-deleted folder.
        if (Date.now() - fs.statSync(dir).mtimeMs < 120_000) continue;
      }
      if (owner && isAlive(owner.driver)) continue;
      if (owner && isOurApp(owner.app)) killTree(owner.app);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      locked.push(entry);
    }
  }
  // Orphaned WebView2 processes keep the profile open: have them killed right away.
  cleanupLater(locked.map((entry) => path.join(os.tmpdir(), entry)), { killNow: true });
}

/** Prefix of the service names under which test instances store their secrets in the keychain. */
const KEYRING_TEST_PREFIX = "forkyard-test-";

/**
 * The entries of a test service in the OS keychain, as a list of accounts (e.g. `hoster:<id>`).
 * Windows only (Credential Manager via `cmdkey`); empty elsewhere.
 */
export function keyringEntries(service) {
  if (process.platform !== "win32" || !service?.startsWith(KEYRING_TEST_PREFIX)) return [];
  const listing = spawnSync("cmdkey", ["/list"], { encoding: "latin1", windowsHide: true, timeout: 15_000 }).stdout ?? "";
  const suffix = `.${service}`;
  return [...listing.matchAll(/target=(\S+)/g)].map((match) => match[1]).filter((target) => target.endsWith(suffix)).map((target) => target.slice(0, -suffix.length));
}

/** Deletes all entries of a test service from the keychain. Only touches services with the test prefix. */
export function removeKeyringEntries(service) {
  try {
    for (const account of keyringEntries(service)) {
      spawnSync("cmdkey", [`/delete:${account}.${service}`], { stdio: "ignore", windowsHide: true, timeout: 15_000 });
    }
  } catch {
    // Cleaning up is not important enough to fail over.
  }
}

/**
 * Removes instance folders that cannot be deleted right now in the background (see cleanup.mjs):
 * under load the WebView2 processes need a few seconds after exit before they release their
 * profile. The background process is detached and outlives the test script; nobody waits for it.
 */
function cleanupLater(dirs, { killNow = false } = {}) {
  if (!dirs.length) return;
  try {
    spawn(process.execPath, [path.join(ROOT, "scripts", "e2e", "cleanup.mjs"), ...(killNow ? ["--kill-now"] : []), ...dirs], {
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    }).unref();
  } catch {
    // Cleaning up is not important enough to fail over; the next start tries again.
  }
}

/**
 * Deletes the folder of an instance. The WebView2 profile first – if it stays locked, the owner
 * file is still there and the folder still counts as "belongs to a finished instance".
 */
function removeInstanceDir(base, retries = 3) {
  if (removeDir(path.join(base, "webview"), retries) && removeDir(base, retries)) return true;
  cleanupLater([base]);
  return false;
}

export function appBinary() {
  const name = process.platform === "win32" ? "forkyard.exe" : "forkyard";
  return path.join(ROOT, "target", "debug", name);
}

// ---------------------------------------------------------------------------
// launchApp
// ---------------------------------------------------------------------------

/**
 * @param {object}   [options]
 * @param {string}   [options.dataDir]     data directory of the app. Default: a fresh temp folder that disappears on close().
 *                                         A folder passed in stays (for "restart the app" tests).
 * @param {number}   [options.width=1440]  inner size of the real window in CSS pixels.
 * @param {number}   [options.height=900]
 * @param {string}   [options.scenario]    e.g. "RepoManagement.manage": runs after start (see src/screens/scenarios.ts).
 * @param {object}   [options.params]      more URL parameters, e.g. { fixture: repo.path } – available in the scenario as ctx.params.
 * @param {"dark"|"light"} [options.theme] forces the theme (URL parameter ?theme=).
 * @param {string}   [options.language="en"] UI language (URL parameter ?lang=, debug builds only).
 * @param {object|null} [options.gitIdentity] user.name/user.email of the app's global gitconfig; null = no identity.
 * @param {string}   [options.gitPath]     sets FORKYARD_GIT_PATH (a path that does not exist means "Git was not found").
 * @param {object}   [options.env]         additional environment variables for the app. Preset, among others:
 *                                         FORKYARD_KEYRING_SERVICE (own keychain service name, see below).
 * @param {boolean}  [options.show=false]  window visible on screen (to watch); invisible otherwise.
 * @param {RegExp[]} [options.ignoreErrors] console errors that are not counted.
 * @param {boolean}  [options.waitForShell=true] wait for the shell (false for own error page checks).
 * @param {string}   [options.devUrl]      address of an own Vite server instead of the shared test server.
 * @param {boolean}  [options.trustOpened=true] `invoke("repo_open")` and `openRepo` trust a repository with hooks or
 *                                         suspicious config right away (repo_trust_set); false leaves the prompt open.
 * @param {number}   [options.timeoutMs=60000]
 * @returns {Promise<AppHandle>} see the `handle` object below: page, consoleErrors, dataDir, close() and helpers.
 */
export async function launchApp(options = {}) {
  if (process.platform !== "win32") {
    throw new Error(
      process.platform === "linux"
        ? "E2E driver: on Linux the app uses WebKitGTK, which does not offer the Chrome DevTools Protocol. This driver only runs on Windows (WebView2). The option for Linux would be WebDriver via tauri-driver, which is not set up here."
        : "E2E driver: on macOS the app uses WKWebView without the Chrome DevTools Protocol. This driver only runs on Windows (WebView2).",
    );
  }
  const exe = appBinary();
  if (!fs.existsSync(exe)) throw new Error(`The debug app is missing: ${exe}\nBuild it first: cargo build`);

  const { width = 1440, height = 900, timeoutMs = 60_000, waitForShell = true } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`launchApp: width and height must be integers (was: ${width}×${height}).`);
  const started = Date.now();
  const lap = (label) => {
    if (TRACE) console.error(`[e2e ${String(Date.now() - started).padStart(5)} ms] ${label}`);
  };
  // `options.devUrl`: an own server instead of the shared one (csp.mjs starts one with the policy as a header).
  // The scripts check English labels: the app starts in English (`?lang=`, debug builds only).
  const devUrl = withLanguage(options.devUrl ?? (await ensureDevServer()), options.language ?? "en");
  lap(`Vite server ${devUrl}`);

  installExitHooks();
  reapOrphans();
  lap("old instances cleaned up");

  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const webviewDir = path.join(base, "webview");
  const gitConfigPath = path.join(base, "gitconfig");
  const logPath = path.join(base, "app.log");
  fs.writeFileSync(gitConfigPath, globalGitConfig(options.gitIdentity === undefined ? TEST_IDENTITY : options.gitIdentity));

  const port = await freePort();
  const isolation = gitIsolationEnv(gitConfigPath);
  const env = {
    ...process.env,
    // The app and its Git see nothing of the machine's configuration – and write nothing there either.
    GIT_CONFIG_NOSYSTEM: isolation.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_GLOBAL: isolation.GIT_CONFIG_GLOBAL,
    FORKYARD_DATA_DIR: dataDir,
    FORKYARD_DEV_URL: devUrl,
    // Tests rufen keine echten Dienste auf: keine Avatare von GitHub.
    FORKYARD_AVATAR_URL: "off",
    FORKYARD_E2E_WINDOW: options.show ? "visible" : "hidden",
    FORKYARD_WINDOW_SIZE: `${width}x${height}`,
    // Tokens, keys and passwords of the test instance live under their own service name in the
    // keychain, not among the user's real entries. Same name per data directory: a restart with
    // the same `dataDir` finds its entries again.
    FORKYARD_KEYRING_SERVICE: `${KEYRING_TEST_PREFIX}e2e-${crypto.createHash("sha1").update(dataDir.toLowerCase()).digest("hex").slice(0, 12)}`,
    WEBVIEW2_USER_DATA_FOLDER: webviewDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      // Otherwise covered and invisible windows stop rendering (no requestAnimationFrame, hanging screenshots).
      "--disable-features=CalculateNativeWinOcclusion,msWebOOUI,msPdfOOUI,msSmartScreenProtection",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      // One physical pixel = one CSS pixel, regardless of the screen scaling.
      "--force-device-scale-factor=1",
    ].join(" "),
    ...(options.gitPath ? { FORKYARD_GIT_PATH: options.gitPath } : {}),
    ...(options.env ?? {}),
  };

  // Every instance runs from its own copy: a running exe is locked on Windows, and a parallel
  // `cargo build` could not replace it otherwise. The core looks for its helper programs next to
  // its own exe, so they are copied too.
  const binDir = path.join(base, "bin");
  fs.mkdirSync(binDir);
  for (const file of fs.readdirSync(path.dirname(exe))) {
    if (/^(forkyard|forkyard-askpass|forkyard-editor)(\.exe)?$/.test(file)) fs.copyFileSync(path.join(path.dirname(exe), file), path.join(binDir, file));
  }
  const runExe = path.join(binDir, path.basename(exe));

  const log = fs.openSync(logPath, "w");
  // `options.args`: start arguments of the app (external start: `<folder>`, `--commit <sha>`, `forkyard://…`).
  const child = spawn(runExe, Array.isArray(options.args) ? options.args.map(String) : [], { cwd: ROOT, env, stdio: ["ignore", log, log], windowsHide: false });
  fs.closeSync(log);
  fs.writeFileSync(path.join(base, OWNER_FILE), JSON.stringify({ app: child.pid, driver: process.pid }));
  const instance = { dirs: [base], pids: new Set() };
  running.set(child.pid, instance);
  let exited = false;
  const exit = new Promise((resolve) => child.once("exit", (code) => ((exited = true), resolve(code))));

  const consoleErrors = [];
  const ignore = options.ignoreErrors ?? [];
  const note = (text) => {
    if (!ignore.some((pattern) => pattern.test(text))) consoleErrors.push(text);
  };

  let browser = null;
  let session = null;
  /** The WebView2 processes (browser, renderer, GPU …) – they sometimes outlive the app for a moment. */
  const collectPids = async () => {
    try {
      const { processInfo } = await session.send("SystemInfo.getProcessInfo");
      for (const info of processInfo) instance.pids.add(info.id);
    } catch {
      // connection already gone
    }
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (session) await Promise.race([collectPids(), sleep(3000)]);
    try {
      await browser?.close();
    } catch {
      // connection was already gone
    }
    if (!exited) killTree(child.pid);
    for (const pid of instance.pids) killPid(pid);
    // Profile and database can only be deleted once all processes are really gone.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (!exited || [...instance.pids].some((pid) => isAlive(pid)))) await sleep(25);
    running.delete(child.pid);
    // With an own data directory (fresh temp folder) the keychain entries go away as well; with a
    // given `dataDir` they stay for the next start.
    if (!options.dataDir) removeKeyringEntries(env.FORKYARD_KEYRING_SERVICE);
    for (const dir of instance.dirs) removeInstanceDir(dir);
  };

  const fail = async (message) => {
    const appLog = tail(logPath);
    await close();
    return new Error(`${message}${appLog ? `\n--- app output ---\n${appLog}` : ""}`);
  };

  try {
    // 1. CDP endpoint of the WebView2
    const endpoint = `http://127.0.0.1:${port}`;
    for (;;) {
      if (exited) throw await fail("The app exited during start.");
      try {
        await getJson(`${endpoint}/json/version`, 1000);
        break;
      } catch {
        if (Date.now() - started > timeoutMs) throw await fail(`The app's WebView2 does not answer on CDP port ${port}.`);
        await sleep(50);
      }
    }
    lap(`CDP endpoint on port ${port}`);
    browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
    session = await browser.newBrowserCDPSession();
    lap("connected");

    // 2. The app's page (the WebView2 has exactly one context)
    let page = null;
    while (!page) {
      page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith(devUrl)) ?? null;
      if (page) break;
      if (Date.now() - started > timeoutMs) {
        const urls = browser.contexts().flatMap((context) => context.pages()).map((candidate) => candidate.url());
        throw await fail(`No page of the app found (expected ${devUrl}). Open: ${urls.join(", ") || "nothing"}`);
      }
      await sleep(50);
    }
    page.setDefaultTimeout(30_000);
    // Loading can take a while when the machine is building (several agents, cargo): more generous than for clicks.
    page.setDefaultNavigationTimeout(timeoutMs);
    lap("page found");

    // 3. Record errors
    page.on("console", (message) => {
      if (message.type() === "error") note(`[console] ${message.text()}`);
    });
    page.on("pageerror", (error) => note(`[pageerror] ${error.stack ?? error.message}`));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "";
      if (reason !== "net::ERR_ABORTED") note(`[request] ${request.method()} ${request.url()} – ${reason}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) note(`[http ${response.status()}] ${response.url()}`);
    });

    let currentParams = { ...(options.params ?? {}), ...(options.theme ? { theme: options.theme } : {}) };
    const readSize = () => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio }));
    const waitForSize = async (wantWidth, wantHeight) => {
      try {
        await page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [wantWidth, wantHeight], { timeout: 5000 });
      } catch {
        const actual = await readSize();
        throw new Error(
          `The window did not take the size ${wantWidth}×${wantHeight} (is ${actual.width}×${actual.height}, scale ${actual.scale}). ` +
            "Larger than the screen does not always work.",
        );
      }
    };

    const handle = {
      page,
      browser,
      consoleErrors,
      dataDir,
      devUrl,
      port,
      pid: child.pid,
      logPath,
      gitConfigPath,
      /** Time from launchApp() until the shell is ready, in milliseconds. */
      startupMs: 0,
      close,

      /** Address of the app with URL parameters. */
      url(params = {}) {
        const target = new URL(devUrl);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
        }
        return target.toString();
      },

      /** Waits until the shell is up ("app") or a full-page message ("fullpage") – returns which one. */
      async waitForShell() {
        try {
          await page.waitForFunction(() => {
            const state = document.querySelector("[data-shell]")?.getAttribute("data-shell");
            return state === "app" || state === "fullpage";
          }, null, { timeout: timeoutMs });
        } catch (error) {
          // Say where it hangs: a start that never finishes was just a bare timeout otherwise.
          const seen = await page
            .evaluate(() => ({
              shell: document.querySelector("[data-shell]")?.getAttribute("data-shell") ?? null,
              text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 160),
              tauri: Boolean(window.__TAURI_INTERNALS__),
              fetching: window.__gc?.queryClient.getQueryCache().getAll().filter((query) => query.state.fetchStatus === "fetching").map((query) => JSON.stringify(query.queryKey)) ?? null,
            }))
            .catch((inner) => ({ unreadable: String(inner?.message ?? inner).split("\n")[0] }));
          throw new Error(`${String(error?.message ?? error).split("\n")[0]} – the shell is not up. Page: ${JSON.stringify(seen)}. Console errors: ${consoleErrors.join(" | ") || "none"}`);
        }
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        return page.evaluate(() => document.querySelector("[data-shell]")?.getAttribute("data-shell"));
      },

      /** Reloads the page (picks up changed sources), optionally with other URL parameters. */
      async reload(params = currentParams) {
        currentParams = params;
        await page.goto(handle.url(params), { waitUntil: "load" });
        return handle.waitForShell();
      },

      /** Sets the inner size of the real window (CSS pixels) and waits until the page has it. */
      async setSize(nextWidth, nextHeight) {
        await handle.invoke("plugin:window|set_size", { label: "main", value: { Physical: { width: nextWidth, height: nextHeight } } });
        await waitForSize(nextWidth, nextHeight);
      },

      /** Title of the real window (not document.title). */
      async windowTitle() {
        return handle.invoke("plugin:window|title", { label: "main" });
      },

      /** Forces a theme without reloading. */
      async setTheme(theme) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
      },

      /**
       * Calls a core command directly, bypassing the UI: `await app.invoke("status_get", { repoId })`.
       * A CoreError arrives as an Error with `.code` and `.gitOutput`.
       */
      async invoke(command, args = {}) {
        const result = await page.evaluate(
          async ([name, input]) => {
            try {
              return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(name, input) };
            } catch (error) {
              return { ok: false, error: typeof error === "object" && error ? { ...error, message: error.message } : { message: String(error) } };
            }
          },
          [command, args],
        );
        if (!result.ok) {
          throw Object.assign(new Error(`${command}: ${result.error.message ?? "error"}`), { code: result.error.code ?? "unknown", gitOutput: result.error.gitOutput ?? null, raw: result.error });
        }
        // Test repositories belong to the test. If one brings hooks or suspicious entries (many
        // scripts set them up before opening), the core locks it until the user agrees – here the
        // driver agrees, as the user would in the prompt. Scripts that test exactly this prompt
        // start with `launchApp({ trustOpened: false })`.
        const opened = result.value;
        if (command === "repo_open" && options.trustOpened !== false && opened?.repo?.trusted === false) {
          await handle.invoke("repo_trust_set", { repoId: opened.repo.id, trusted: true });
          opened.repo.trusted = true;
        }
        return opened;
      },

      /**
       * Records core events: `const events = await app.recordEvents(["repo:changed"]);`
       * … `await events.take()` returns the ones received since as [{ name, payload }] and empties the list.
       */
      async recordEvents(names = ["app:changed", "repo:changed", "log:appended", "job:progress", "job:done", "credential:request", "hook:output"]) {
        const key = `__gcEvents${Math.random().toString(36).slice(2)}`;
        await page.evaluate(
          ([slot, list]) => {
            const store = { events: [], stops: [] };
            for (const name of list) store.stops.push(window.__gc.core.on(name, (payload) => store.events.push({ name, payload })));
            window[slot] = store;
          },
          [key, names],
        );
        // Subscribing starts asynchronously in the core; wait a moment before the caller triggers anything.
        await page.waitForTimeout(150);
        return {
          take: () => page.evaluate((slot) => window[slot].events.splice(0), key),
          /** Waits for the first event with this name. */
          waitFor: (name, timeout = 5000) => page.waitForFunction(([slot, wanted]) => window[slot].events.some((event) => event.name === wanted), [key, name], { timeout }),
          stop: () =>
            page.evaluate((slot) => {
              for (const stop of window[slot].stops) stop();
            }, key),
        };
      },

      /**
       * Opens a repository (without the folder dialog) and waits until its tab is active and the status is loaded.
       * Returns { repoId, tabId }.
       */
      async openRepo(repoPath) {
        const opened = await handle.invoke("repo_open", { path: repoPath });
        await page.waitForFunction(
          (tabId) => document.querySelector(`[data-tab-id="${tabId}"] [role="tab"]`)?.getAttribute("aria-selected") === "true",
          opened.tab.id,
        );
        await handle.settle();
        return { repoId: opened.repo.id, tabId: opened.tab.id };
      },

      /** For the system folder dialog: the next `pickFolder`/`pickFile` returns these paths (null = cancel). */
      async pick(...paths) {
        await page.evaluate((values) => {
          window.__gcTestPicks = [...(window.__gcTestPicks ?? []), ...values];
        }, paths);
      },

      /** Waits until no query to the core is running and the page has been quiet for two frames. */
      async settle(maxMs = 10_000) {
        await page.waitForFunction(() => !window.__gc || (window.__gc.queryClient.isFetching() === 0 && window.__gc.queryClient.isMutating() === 0), null, { timeout: maxMs });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));
      },

      /**
       * Runs a scenario (`src/screens/<Folder>/scenario.ts`): loads the page with ?scenario=… and
       * waits for the result. Throws if the scenario fails or is unknown.
       */
      async runScenario(id, params = {}) {
        await handle.reload({ ...currentParams, ...params, scenario: id });
        await handle.waitForScenario(id);
      },

      async waitForScenario(id) {
        await page.waitForFunction(() => ["done", "error", "unknown"].includes(document.documentElement.dataset.scenario ?? ""), null, { timeout: timeoutMs });
        const state = await page.evaluate(() => document.documentElement.dataset.scenario);
        if (state !== "done") {
          throw new Error(state === "unknown" ? `Scenario "${id}" does not exist.` : `Scenario "${id}" failed.\n${consoleErrors.join("\n")}`);
        }
        await handle.settle();
      },

      /** Screenshot of the window content (as many pixels as the window has CSS pixels); creates the target folder. */
      async screenshot(file, { fullPage = false } = {}) {
        const target = path.resolve(ROOT, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await page.screenshot({ path: target, fullPage, animations: "disabled", caret: "hide" });
        return target;
      },
    };

    // 4. Reload and wait for the shell
    if (options.scenario) currentParams = { ...currentParams, scenario: options.scenario };
    await page.goto(handle.url(currentParams), { waitUntil: "load" });
    lap("page loaded");
    await collectPids();
    const size = await readSize();
    if (size.width !== width || size.height !== height) {
      // The size from FORKYARD_WINDOW_SIZE did not apply (e.g. minimum size): try again via the window API.
      await handle.setSize(width, height);
    }
    lap(`window ${width}×${height}`);
    if (waitForShell) {
      await handle.waitForShell();
      handle.startupMs = Date.now() - started;
      lap("shell ready");
      if (options.scenario) {
        await handle.waitForScenario(options.scenario);
        lap(`scenario ${options.scenario} done`);
      }
    }
    return handle;
  } catch (error) {
    if (!closed) throw await fail(error?.message ?? String(error));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Called directly: managing the Vite server
// ---------------------------------------------------------------------------

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const command = process.argv[2] ?? "--status";
  if (command === "--stop-vite") {
    console.log((await stopDevServer()) ? "Vite server for tests stopped." : "No Vite server of this checkout was running.");
  } else if (command === "--start-vite") {
    console.log(`Vite server for tests: ${await ensureDevServer()}`);
  } else {
    const found = await findOurServer();
    console.log(found.url ? `Vite server for tests running: ${found.url} (PID ${found.pid})` : "No Vite server for tests started.");
    console.log(`Debug app: ${fs.existsSync(appBinary()) ? appBinary() : "missing – cargo build"}`);
  }
}

/** Appends `lang=<language>` to the address of the Vite server. */
function withLanguage(url, language) {
  const target = new URL(url);
  target.searchParams.set("lang", language);
  return target.toString();
}
