/**
 * WebDriver E2E driver: starts the REAL debug app through `tauri-driver` and drives its WebView
 * over W3C WebDriver. On Linux the native driver is WebKitWebDriver (WebKitGTK), each app runs on
 * its own Xvfb display; on Windows it would be msedgedriver (WebView2, no Xvfb).
 *
 *   import { launchApp } from "./driver.mjs";
 *   const app = await launchApp({ width: 1440, height: 900 });
 *   await app.openRepo(repo.path);
 *   await app.click(await app.byText("Fetch"));
 *   await app.screenshot("target/e2e-wd/shots/demo/fetch.png");
 *   if ((await app.errors()).length) throw new Error(app.consoleErrors.join("\n"));
 *   await app.close();   // ends the app cleanly (SIGTERM), then the session
 *
 * Every launch is isolated: own Xvfb display (picked by Xvfb itself via -displayfd), own
 * tauri-driver port and native port, own data directory, own global gitconfig
 * (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM), own XDG folders (WebKit storage, caches) and its own
 * keychain service name (FORKYARD_KEYRING_SERVICE), so the user's data and a running Forkyard
 * stay untouched. Any number of launches run side by side.
 *
 * The UI comes from ONE Vite server per checkout (ports 1431 to 1460, no HMR) that also puts a
 * small error hook in front of the app (FORKYARD_E2E_ERROR_HOOK, see vite.config.ts): WebDriver
 * cannot hook into a page before its scripts run. State in target/e2e-wd/vite.json.
 *
 * The app binary is a COPY of target/debug/forkyard (target/e2e-wd/bin/<mtime>/), so a rebuild
 * during a test run does not pull the binary away from running sessions. `prepare.mjs` builds and
 * copies; `run.mjs` passes the copy to its features via E2E_WD_APP.
 *
 *   node scripts/e2e-wd/driver.mjs --status | --start-vite | --stop-vite
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_IDENTITY, globalGitConfig, isAlive } from "../e2e/fixtures.mjs";
import { startPrivateKeyring } from "./fixtures/gitea-keyring.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const STATE_DIR = path.join(ROOT, "target", "e2e-wd");
const VITE_STATE = path.join(STATE_DIR, "vite.json");
const VITE_LOCK = path.join(STATE_DIR, "vite.lock");
const VITE_LOG = path.join(STATE_DIR, "vite.log");
const VITE_PORTS = Array.from({ length: 30 }, (_, index) => 1431 + index);
const BIN_DIR = path.join(STATE_DIR, "bin");
const TEMP_PREFIX = "fy-e2e-wd-";
const OWNER_FILE = "owner.json";
const KEYRING_PREFIX = "forkyard-test-wd-";
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const HELPERS = ["forkyard", "forkyard-askpass", "forkyard-editor"];
/** Local tool root (Xvfb, WebKitWebDriver and their libraries) for machines without root access. */
export const TOOLS_ROOT = process.env.E2E_TOOLS_ROOT || path.join(ROOT, "target", "e2e-tools", "root");
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).replaceAll("\\", "/").toLowerCase() === path.resolve(b).replaceAll("\\", "/").toLowerCase();

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function getJson(url, timeoutMs = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function onPath(name) {
  const result = spawnSync(IS_WIN ? "where" : "which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() || null : null;
}

/** Finds Xvfb, the native WebDriver and tauri-driver. PATH first, then E2E_TOOLS_ROOT. */
export function findTools() {
  const local = (name) => {
    const file = path.join(TOOLS_ROOT, "usr", "bin", name);
    return fs.existsSync(file) ? file : null;
  };
  const cargoBin = path.join(os.homedir(), ".cargo", "bin", `tauri-driver${EXE}`);
  const tauriDriver = process.env.E2E_TAURI_DRIVER || onPath("tauri-driver") || (fs.existsSync(cargoBin) ? cargoBin : null);
  if (IS_WIN) {
    const native = process.env.E2E_NATIVE_DRIVER || onPath("msedgedriver");
    return { xvfb: null, native, tauriDriver, libPath: null };
  }
  const pathXvfb = onPath("Xvfb");
  const pathNative = onPath("WebKitWebDriver");
  const xvfb = process.env.E2E_XVFB || pathXvfb || local("Xvfb");
  const native = process.env.E2E_NATIVE_DRIVER || pathNative || local("WebKitWebDriver");
  // The local tools need their libraries; tools from PATH come with the system's.
  const libDir = path.join(TOOLS_ROOT, "usr", "lib", "x86_64-linux-gnu");
  const usesLocal = (xvfb && !pathXvfb) || (native && !pathNative);
  return { xvfb, native, tauriDriver, libPath: usesLocal && fs.existsSync(libDir) ? libDir : null };
}

function requireTools() {
  const tools = findTools();
  const missing = [];
  if (!tools.tauriDriver) missing.push("tauri-driver (cargo install tauri-driver --locked)");
  if (!tools.native) missing.push(IS_WIN ? "msedgedriver matching the WebView2 version (PATH or E2E_NATIVE_DRIVER)" : "WebKitWebDriver (apt install webkit2gtk-driver, or E2E_TOOLS_ROOT)");
  if (!IS_WIN && !tools.xvfb) missing.push("Xvfb (apt install xvfb, or E2E_TOOLS_ROOT)");
  if (process.platform === "darwin") throw new Error("E2E WebDriver driver: macOS has no WebDriver for WKWebView; only Linux and Windows are supported.");
  if (missing.length) throw new Error(`E2E WebDriver driver: missing tools:\n- ${missing.join("\n- ")}`);
  return tools;
}

// ---------------------------------------------------------------------------
// App binary copy
// ---------------------------------------------------------------------------

export function builtBinary() {
  return path.join(ROOT, "target", "debug", `forkyard${EXE}`);
}

/**
 * Returns the copy of the debug app for the current build (target/e2e-wd/bin/<mtime>/forkyard),
 * creating it once if needed. E2E_WD_APP overrides (run.mjs sets it for the whole suite).
 */
export async function ensureAppCopy() {
  if (process.env.E2E_WD_APP) {
    if (!fs.existsSync(process.env.E2E_WD_APP)) throw new Error(`E2E_WD_APP does not exist: ${process.env.E2E_WD_APP}`);
    return process.env.E2E_WD_APP;
  }
  const source = builtBinary();
  const stat = fs.statSync(source, { throwIfNoEntry: false });
  if (!stat) throw new Error(`The debug app is missing: ${source}\nBuild it first: node scripts/e2e-wd/prepare.mjs`);
  const dir = path.join(BIN_DIR, String(Math.floor(stat.mtimeMs)));
  const target = path.join(dir, `forkyard${EXE}`);
  const done = path.join(dir, ".complete");
  if (fs.existsSync(done)) return target;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const lock = path.join(BIN_DIR, ".copy.lock");
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (fs.existsSync(done)) return target;
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 120_000) fs.rmSync(lock, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error("Timed out waiting for another process copying the app binary.");
      await sleep(250);
    }
  }
  try {
    if (fs.existsSync(done)) return target;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // The core looks for its helper programs next to its own executable.
    for (const name of HELPERS) {
      const file = path.join(path.dirname(source), `${name}${EXE}`);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, `${name}${EXE}`), fs.constants.COPYFILE_FICLONE);
    }
    fs.writeFileSync(done, new Date().toISOString());
    pruneCopies(dir);
    return target;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Keeps the three newest copies. Removing a binary that still runs is harmless on Linux. */
function pruneCopies(keep) {
  try {
    const dirs = fs.readdirSync(BIN_DIR).filter((entry) => /^\d+$/.test(entry)).sort((a, b) => Number(b) - Number(a));
    for (const entry of dirs.slice(3)) {
      const dir = path.join(BIN_DIR, entry);
      if (!samePath(dir, keep)) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // not important
  }
}

// ---------------------------------------------------------------------------
// Vite server (shared by all launches of this checkout)
// ---------------------------------------------------------------------------

async function probePort(port) {
  try {
    const info = await getJson(`http://127.0.0.1:${port}/__gc_root`);
    const ours = info?.root && samePath(info.root, ROOT) && info.errorHook === true && info.hmr === false;
    return { state: ours ? "ours" : "foreign", pid: ours ? info.pid ?? null : null };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    return { state: code === "ECONNREFUSED" ? "free" : "foreign", pid: null };
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

/** Address of the shared Vite server for WebDriver tests; starts it if none runs. Safe to call concurrently. */
export async function ensureDevServer({ timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const known = readViteState()?.port;
  if (known && (await probePort(known)).state === "ours") return `http://127.0.0.1:${known}`;
  for (;;) {
    const found = await findOurServer();
    if (found.url) return found.url;
    if (Date.now() > deadline) throw new Error(`The Vite server for WebDriver tests did not start. Log: ${VITE_LOG}\n${tail(VITE_LOG)}`);
    if (found.free === null) throw new Error(`Ports ${VITE_PORTS[0]} to ${VITE_PORTS.at(-1)} are all taken.`);
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
        env: { ...process.env, FORKYARD_E2E_PORT: String(port), FORKYARD_E2E_ERROR_HOOK: "1" },
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
      // Warm up: the first request bundles the dependencies.
      await fetch(`${url}/src/main.tsx`, { signal: AbortSignal.timeout(90_000) }).then((response) => response.text()).catch(() => undefined);
      return url;
    } finally {
      fs.closeSync(lock);
      fs.rmSync(VITE_LOCK, { force: true });
    }
  }
}

/** Stops the Vite server of this harness (only the one that identifies itself as ours). */
export async function stopDevServer() {
  const found = await findOurServer();
  if (found.url && found.pid) killGroup(found.pid);
  fs.rmSync(VITE_STATE, { force: true });
  return Boolean(found.url && found.pid);
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function killGroup(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

/** Command line of a process (Linux), to make sure a PID from an owner file is still one of ours. */
function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

/**
 * The app processes of one launch (Linux): processes running `binary` whose environment carries
 * this launch's unique keychain service name. WebKitWebDriver starts the app, so its PID is not
 * known to us otherwise.
 */
function appProcesses(binary, keyringService) {
  if (IS_WIN) return [];
  const wanted = `FORKYARD_KEYRING_SERVICE=${keyringService}`;
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (!samePath(fs.readlinkSync(`/proc/${entry}/exe`), binary)) continue;
      if (!fs.readFileSync(`/proc/${entry}/environ`, "latin1").split("\0").includes(wanted)) continue;
      if (/^State:\s+Z/m.test(fs.readFileSync(`/proc/${entry}/status`, "utf8"))) continue;
      found.push(Number(entry));
    } catch {
      // Gone or not ours to read.
    }
  }
  return found;
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

const running = new Set();
let hooksInstalled = false;
function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = () => {
    for (const instance of running) instance.killSync();
    running.clear();
  };
  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      killAll();
      process.exit(130);
    });
  }
}

/** Instances whose driver process died without cleaning up (hard kill): stop their processes, remove their folders. */
let reaped = false;
function reapOrphans() {
  if (reaped) return;
  reaped = true;
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(TEMP_PREFIX));
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = path.join(os.tmpdir(), entry);
    try {
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8"));
      } catch {
        if (Date.now() - fs.statSync(dir).mtimeMs < 120_000) continue;
      }
      if (owner && isAlive(owner.driver)) continue;
      for (const group of owner?.groups ?? []) {
        // Only processes that still look like what we started (PIDs get reused).
        if (isAlive(group.pid) && (IS_WIN || cmdline(group.pid).includes(group.match))) killGroup(group.pid);
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      // try again next time
    }
  }
}

/** Starts Xvfb on a free display; Xvfb picks the number itself and reports it (-displayfd). */
async function startXvfb(tools, env, width, height, logPath) {
  const log = fs.openSync(logPath, "a");
  const child = spawn(tools.xvfb, ["-displayfd", "3", "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-noreset"], {
    env,
    detached: true,
    stdio: ["ignore", log, log, "pipe"],
  });
  fs.closeSync(log);
  const display = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`Xvfb did not report a display.\n${tail(logPath)}`)), 15_000);
    child.stdio[3].on("data", (chunk) => {
      text += chunk.toString();
      const match = text.match(/(\d+)\s*\n/);
      if (match) {
        clearTimeout(timer);
        resolve(`:${match[1]}`);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited (${code}).\n${tail(logPath)}`));
    });
  });
  child.stdio[3].destroy();
  return { child, display };
}

// ---------------------------------------------------------------------------
// WebDriver client
// ---------------------------------------------------------------------------

class WebDriverError extends Error {
  constructor(command, value) {
    super(`${command}: ${value?.error ?? "error"} – ${String(value?.message ?? "").split("\n")[0]}`);
    this.code = value?.error ?? "unknown";
  }
}

/** Minimal W3C WebDriver client; `base` and `sessionId` are filled in once the driver runs. */
function client() {
  const wd = {
    base: "",
    sessionId: null,
    async call(method, route, body, timeoutMs = 60_000) {
      const url = `${wd.base}${route === "/session" ? route : `/session/${wd.sessionId}${route}`}`;
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${route}: HTTP ${response.status} ${text.slice(0, 200)}`);
      }
      if (!response.ok || (json?.value && typeof json.value === "object" && typeof json.value.error === "string" && "message" in json.value)) throw new WebDriverError(`${method} ${route}`, json?.value);
      return json?.value;
    },
  };
  return wd;
}

/** W3C key codes for press(): "Enter", "Escape", "Control+k", "Shift+Tab", "F5" … */
const KEYS = {
  Backspace: "", Tab: "", Enter: "", Return: "", Shift: "", Control: "", Ctrl: "",
  Alt: "", Pause: "", Escape: "", Esc: "", Space: " ", PageUp: "", PageDown: "", End: "",
  Home: "", ArrowLeft: "", ArrowUp: "", ArrowRight: "", ArrowDown: "", Insert: "",
  Delete: "", Meta: "", Cmd: "",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, String.fromCharCode(0xe031 + index)])),
};
const MODIFIERS = new Set(["Shift", "Control", "Ctrl", "Alt", "Meta", "Cmd"]);

function keyValue(name) {
  if (KEYS[name]) return KEYS[name];
  if ([...name].length === 1) return name;
  throw new Error(`press: unknown key "${name}"`);
}

// ---------------------------------------------------------------------------
// launchApp
// ---------------------------------------------------------------------------

const liveApps = new Set();
/** The apps of this process that are open right now (lib.mjs screenshots them on failure). */
export function openApps() {
  return [...liveApps];
}

/**
 * @param {object} [options]
 * @param {number} [options.width=1440]   inner window size in CSS pixels (FORKYARD_WINDOW_SIZE)
 * @param {number} [options.height=900]
 * @param {"dark"|"light"} [options.theme] URL parameter ?theme=
 * @param {string} [options.lang]          URL parameter ?lang= (debug builds); default: the app default (English)
 * @param {object} [options.params]        more URL parameters (e.g. { scenario: "Folder.name" })
 * @param {object} [options.env]           more environment variables for the app
 * @param {string} [options.dataDir]       data directory; default a fresh temp folder removed on close()
 * @param {object|null} [options.gitIdentity] user of the app's global gitconfig; null = none
 * @param {boolean} [options.trustOpened=true] openRepo()/invoke("repo_open") trust the repo right away
 * @param {RegExp[]} [options.ignoreErrors] console errors that are not counted
 * @param {boolean} [options.waitForShell=true]
 * @param {number} [options.timeoutMs=90000]
 */
export async function launchApp(options = {}) {
  const tools = requireTools();
  const { width = 1440, height = 900, timeoutMs = 90_000, waitForShell = true } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`launchApp: width/height must be positive integers (was ${width}×${height}).`);
  const started = Date.now();
  const binary = await ensureAppCopy();
  const devBase = await ensureDevServer();
  installExitHooks();
  reapOrphans();

  const params = { ...(options.params ?? {}), ...(options.theme ? { theme: options.theme } : {}), ...(options.lang ? { lang: options.lang } : {}) };
  const devUrl = new URL(devBase);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) devUrl.searchParams.set(key, String(value));

  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX)));
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const gitConfigPath = path.join(base, "gitconfig");
  fs.writeFileSync(gitConfigPath, globalGitConfig(options.gitIdentity === undefined ? TEST_IDENTITY : options.gitIdentity));
  const logPath = path.join(base, "app.log");
  const xdg = Object.fromEntries(["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"].map((key) => [key, path.join(base, key.toLowerCase())]));
  for (const dir of Object.values(xdg)) fs.mkdirSync(dir, { recursive: true });
  const keyringService = `${KEYRING_PREFIX}${crypto.createHash("sha1").update(`${dataDir}|${process.pid}|${Date.now()}`).digest("hex").slice(0, 12)}`;

  const groups = [];
  const writeOwner = () => fs.writeFileSync(path.join(base, OWNER_FILE), JSON.stringify({ driver: process.pid, groups }));
  writeOwner();

  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_TERMINAL_PROMPT: "0",
    FORKYARD_DATA_DIR: dataDir,
    FORKYARD_DEV_URL: devUrl.toString(),
    FORKYARD_AVATAR_URL: "off",
    FORKYARD_UPDATE_URL: "off",
    // Own display: the window may be visible there without disturbing anyone.
    FORKYARD_E2E_WINDOW: "visible",
    FORKYARD_WINDOW_SIZE: `${width}x${height}`,
    FORKYARD_KEYRING_SERVICE: keyringService,
    ...(IS_WIN ? {} : xdg),
    ...(options.env ?? {}),
  };
  if (!IS_WIN) {
    // One CSS pixel = one physical pixel.
    env.GDK_SCALE = "1";
    env.GDK_DPI_SCALE = "1";
    delete env.WAYLAND_DISPLAY;
    env.GDK_BACKEND = "x11";
    // No accessibility bus or GPU on Xvfb; avoid noise and stalls.
    env.NO_AT_BRIDGE = "1";
    env.WEBKIT_DISABLE_COMPOSITING_MODE = env.WEBKIT_DISABLE_COMPOSITING_MODE ?? "1";
    env.LIBGL_ALWAYS_SOFTWARE = "1";
    if (tools.libPath) env.LD_LIBRARY_PATH = [tools.libPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  // Own unlocked Secret Service unless the feature brings its own bus: the user's keychain may be
  // locked (after its daemon restarted, or overnight), and the app then fails wherever it touches
  // a secret. Without dbus-daemon/gnome-keyring-daemon the session bus is used as before.
  const keyring = !IS_WIN && !options.env?.DBUS_SESSION_BUS_ADDRESS && options.privateKeyring !== false ? await startPrivateKeyring() : null;
  if (keyring) env.DBUS_SESSION_BUS_ADDRESS = keyring.address;

  let xvfb = null;
  let driverChild = null;
  let closed = false;
  const consoleErrors = [];
  const ignore = options.ignoreErrors ?? [];
  const wd = client();

  const killSync = () => {
    if (driverChild) killGroup(driverChild.pid);
    if (xvfb) killGroup(xvfb.child.pid);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  const instance = { killSync };
  running.add(instance);

  const quitGracefully = async () => {
    if (!wd.sessionId) return;
    if (IS_WIN) {
      // No signals: cancel running work like quitting, then destroy the window (ends the event loop).
      await Promise.race([handle.invoke("app_quit").catch(() => undefined), sleep(10_000)]);
      await Promise.race([handle.invoke("plugin:window|destroy", { label: "main" }).catch(() => undefined), sleep(5000)]);
      return;
    }
    const pids = appProcesses(binary, keyringService);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    // The app's own fallback ends the process at the latest 3 s after the request (plus app_quit).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && appProcesses(binary, keyringService).length) await sleep(100);
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    liveApps.delete(handle);
    // End the app the way a user would before the session goes: deleting a WebDriver session
    // kills the app hard, which the next start on the same data directory rightly reports as an
    // unexpected exit. SIGTERM takes the app's quit path (crash marker removed). Scenarios that
    // want an unexpected exit kill the app themselves (SIGKILL) before calling close().
    await quitGracefully().catch(() => undefined);
    if (wd.sessionId) await Promise.race([wd.call("DELETE", "").catch(() => undefined), sleep(5000)]);
    if (driverChild) killGroup(driverChild.pid);
    if (xvfb) killGroup(xvfb.child.pid);
    running.delete(instance);
    if (keyring) await keyring.close().catch(() => undefined);
    else if (!IS_WIN && !options.keepKeyring) {
      // Entries the app stored under its test service name (Secret Service), if the tool is there.
      if (onPath("secret-tool")) spawnSync("secret-tool", ["clear", "service", keyringService], { stdio: "ignore", timeout: 5000 });
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  const fail = async (message) => {
    const appLog = tail(logPath);
    await close();
    return new Error(`${message}${appLog ? `\n--- app/driver output ---\n${appLog}` : ""}`);
  };

  // ---- element helpers ------------------------------------------------------
  const ref = (id) => ({ [ELEMENT_KEY]: id });
  const wrap = (value) => {
    if (value && typeof value === "object" && value[ELEMENT_KEY]) return element(value[ELEMENT_KEY]);
    if (Array.isArray(value)) return value.map(wrap);
    return value;
  };
  const unwrap = (value) => {
    if (value && typeof value === "object" && value.__element) return ref(value.id);
    if (Array.isArray(value)) return value.map(unwrap);
    return value;
  };
  function element(id) {
    return {
      __element: true,
      id,
      click: () => handle.click(element(id)),
      type: (text) => handle.type(element(id), text),
      text: () => wd.call("GET", `/element/${id}/text`),
      attr: (name) => handle.exec((el, key) => el.getAttribute(key), element(id), name),
      prop: (name) => handle.exec((el, key) => el[key], element(id), name),
      rect: () => wd.call("GET", `/element/${id}/rect`),
      visible: () => handle.exec((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }, element(id)),
      $: async (css) => {
        try {
          return wrap(await wd.call("POST", `/element/${id}/element`, { using: "css selector", value: css }));
        } catch (error) {
          if (error.code === "no such element") return null;
          throw error;
        }
      },
      $$: async (css) => wrap(await wd.call("POST", `/element/${id}/elements`, { using: "css selector", value: css })),
    };
  }
  const resolveTarget = async (target) => {
    if (target && target.__element) return target;
    if (typeof target === "string") {
      const found = await handle.waitFor(target);
      return found;
    }
    if (target && typeof target === "object" && typeof target.text === "string") return handle.waitFor(() => handle.byText(target.text, target));
    throw new Error(`Not an element: ${String(target)}`);
  };

  const handle = {
    consoleErrors,
    dataDir,
    devUrl: devUrl.toString(),
    logPath,
    gitConfigPath,
    keyringService,
    display: null,
    port: null,
    nativePort: null,
    binary,
    startupMs: 0,
    close,

    /**
     * Runs a function (or function body string) in the page and returns its (awaited) result.
     * Elements may be passed as arguments and come back as elements.
     *   await app.exec((a, b) => a + b, 1, 2)
     *   await app.exec("return document.title")
     */
    async exec(fn, ...args) {
      const body = typeof fn === "function" ? `return (${fn.toString()}).apply(null, arguments)` : String(fn);
      const script = `const done = arguments[arguments.length - 1];
        const args = Array.prototype.slice.call(arguments, 0, -1);
        Promise.resolve().then(() => (function () { ${body} }).apply(null, args))
          .then((value) => done({ ok: true, value: value === undefined ? null : value }),
                (error) => done({ ok: false, failure: { message: String((error && error.message) || error), code: error && error.code, gitOutput: error && error.gitOutput } }));`;
      const result = await wd.call("POST", "/execute/async", { script, args: unwrap(args) });
      if (!result?.ok) throw Object.assign(new Error(`exec: ${result?.failure?.message ?? "error"}`), { code: result?.failure?.code ?? "unknown", gitOutput: result?.failure?.gitOutput ?? null });
      return wrap(result.value);
    },

    /** First element matching the CSS selector, or null. */
    async $(css) {
      try {
        return wrap(await wd.call("POST", "/element", { using: "css selector", value: css }));
      } catch (error) {
        if (error.code === "no such element") return null;
        throw error;
      }
    },

    /** All elements matching the CSS selector. */
    async $$(css) {
      return wrap(await wd.call("POST", "/elements", { using: "css selector", value: css }));
    },

    /**
     * The innermost visible element whose text (or aria-label/title) matches. `text` is a string
     * (exact after trimming and collapsing spaces, or substring with { exact: false }) or a RegExp
     * source via { regex: true }. Optional { within: css }. Returns null if nothing matches.
     */
    async byText(text, { exact = true, regex = false, within = null } = {}) {
      return handle.exec(
        (wanted, isExact, isRegex, scope) => {
          const root = scope ? document.querySelector(scope) : document.body;
          if (!root) return null;
          const norm = (value) => (value ?? "").replace(/\s+/g, " ").trim();
          const pattern = isRegex ? new RegExp(wanted) : null;
          const hit = (value) => {
            const v = norm(value);
            if (!v) return false;
            if (pattern) return pattern.test(v);
            return isExact ? v === wanted : v.includes(wanted);
          };
          const visible = (el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
          };
          let best = null;
          for (const el of root.querySelectorAll("*")) {
            if (!visible(el)) continue;
            if (hit(el.innerText) || hit(el.getAttribute("aria-label")) || hit(el.getAttribute("title"))) best = el;
          }
          // querySelectorAll is in document order: the last match inside an earlier match is the innermost.
          return best;
        },
        text,
        exact,
        regex,
        within,
      );
    },

    /** Clicks an element (element, CSS selector or { text }); waits for selectors to appear. */
    async click(target) {
      // A selector or text names whatever the page shows now: when React replaced the node
      // between finding and clicking it (a refetch re-rendered the list), find it again – a
      // user's click would hit the new node. An element handle is clicked as it is.
      for (let attempt = 1; ; attempt++) {
        const el = await resolveTarget(target);
        try {
          await wd.call("POST", `/element/${el.id}/click`, {});
          return el;
        } catch (error) {
          if (target?.__element || attempt >= 3 || !/stale element reference/.test(error.message)) throw error;
        }
      }
    },

    /** Types text into an element (element, CSS selector or { text }). */
    async type(target, text) {
      const el = await resolveTarget(target);
      await wd.call("POST", `/element/${el.id}/value`, { text: String(text) });
      return el;
    },

    /** Presses a key combination on the focused element: "Enter", "Control+k", "Shift+Tab". Several: press("Tab", "Tab"). */
    async press(...combos) {
      const actions = [];
      for (const combo of combos) {
        const parts = combo === "+" ? ["+"] : combo.split("+").filter(Boolean);
        const mods = parts.filter((part) => MODIFIERS.has(part)).map(keyValue);
        const keys = parts.filter((part) => !MODIFIERS.has(part)).map(keyValue);
        for (const key of mods) actions.push({ type: "keyDown", value: key });
        for (const key of keys) actions.push({ type: "keyDown", value: key }, { type: "keyUp", value: key });
        for (const key of mods.reverse()) actions.push({ type: "keyUp", value: key });
      }
      await wd.call("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions }] });
      await wd.call("DELETE", "/actions").catch(() => undefined);
    },

    /**
     * Waits until `target` holds and returns its value: a CSS selector (resolves to the element),
     * or an async function polled until it returns something truthy. Throws after `timeout` ms.
     */
    async waitFor(target, timeout = 15_000, { interval = 100, message } = {}) {
      const deadline = Date.now() + timeout;
      let lastError = null;
      for (;;) {
        try {
          const value = typeof target === "string" ? await handle.$(target) : await target();
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        if (Date.now() > deadline) {
          await handle.errors().catch(() => undefined);
          const what = message ?? (typeof target === "string" ? `selector ${target}` : `condition ${target.toString().slice(0, 120)}`);
          throw new Error(`waitFor timed out after ${timeout} ms: ${what}${lastError ? ` (last error: ${lastError.message})` : ""}`);
        }
        await sleep(interval);
      }
    },

    /** Collects the errors the page recorded since the last call and returns ALL errors so far. */
    async errors() {
      const fresh = await handle.exec(() => (window.__gcE2E ? window.__gcE2E.errors.splice(0) : ["[driver] error hook missing"])).catch(() => []);
      for (const text of fresh ?? []) if (!ignore.some((pattern) => pattern.test(text))) consoleErrors.push(text);
      return consoleErrors;
    },

    /**
     * Calls a core command directly: `await app.invoke("status_get", { repoId })`. A CoreError
     * arrives as Error with .code and .gitOutput. repo_open trusts the repo unless trustOpened: false.
     */
    async invoke(command, args = {}) {
      const value = await handle.exec((name, input) => window.__TAURI_INTERNALS__.invoke(name, input), command, args).catch((error) => {
        throw Object.assign(new Error(`${command}: ${error.message.replace(/^exec: /, "")}`), { code: error.code, gitOutput: error.gitOutput });
      });
      if (command === "repo_open" && options.trustOpened !== false && value?.repo?.trusted === false) {
        await handle.invoke("repo_trust_set", { repoId: value.repo.id, trusted: true });
        value.repo.trusted = true;
      }
      return value;
    },

    /** Opens a repository without the folder dialog; waits for its tab to be active and the queries to settle. */
    async openRepo(repoPath) {
      const opened = await handle.invoke("repo_open", { path: repoPath });
      await handle.waitFor(
        () => handle.exec((tabId) => document.querySelector(`[data-tab-id="${tabId}"] [role="tab"]`)?.getAttribute("aria-selected") === "true", opened.tab.id),
        30_000,
        { message: `tab of ${repoPath} active` },
      );
      await handle.settle();
      return { repoId: opened.repo.id, tabId: opened.tab.id };
    },

    /** For the system file dialog: the next pickFolder/pickFile of the UI returns these paths (null = cancel). */
    async pick(...paths) {
      await handle.exec((values) => {
        window.__gcTestPicks = [...(window.__gcTestPicks ?? []), ...values];
      }, paths);
    },

    /** Waits until no query/mutation runs and two frames passed. */
    async settle(maxMs = 15_000) {
      await handle.waitFor(() => handle.exec(() => !window.__gc || (window.__gc.queryClient.isFetching() === 0 && window.__gc.queryClient.isMutating() === 0)), maxMs, { message: "queries settled" });
      await handle.exec(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
    },

    /** Waits for the shell ("app") or a full-page message ("fullpage"); returns which. */
    async waitForShell(timeout = timeoutMs) {
      const state = await handle.waitFor(
        () => handle.exec(() => {
          const value = document.querySelector("[data-shell]")?.getAttribute("data-shell");
          return value === "app" || value === "fullpage" ? value : null;
        }),
        timeout,
        { message: "shell up" },
      );
      await handle.exec(() => document.fonts.ready.then(() => true));
      return state;
    },

    /** Loads the page again with other URL parameters (collects errors first). */
    async reload(nextParams = params) {
      await handle.errors();
      const target = new URL(devBase);
      for (const [key, value] of Object.entries(nextParams)) if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
      await wd.call("POST", "/url", { url: target.toString() });
      return handle.waitForShell();
    },

    /** Forces a theme without reloading. */
    async setTheme(theme) {
      await handle.exec((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
    },

    /** Inner size of the page in CSS pixels. */
    async size() {
      return handle.exec(() => ({ width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio }));
    },

    /** PNG screenshot of the page (creates folders); returns the absolute path. */
    async screenshot(file) {
      const target = path.resolve(ROOT, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = await wd.call("GET", "/screenshot");
      fs.writeFileSync(target, Buffer.from(data, "base64"));
      await handle.errors().catch(() => undefined);
      return target;
    },

    /** Raw W3C WebDriver call relative to the session, e.g. app.webdriver("GET", "/title"). */
    webdriver: (method, route, body) => wd.call(method, route, body),
  };

  try {
    // 1. Display
    let xvfbEnv = env;
    if (!IS_WIN) {
      xvfb = await startXvfb(tools, env, Math.max(width, 640) + 64, Math.max(height, 480) + 64, logPath);
      groups.push({ pid: xvfb.child.pid, match: "Xvfb" });
      writeOwner();
      xvfbEnv = { ...env, DISPLAY: xvfb.display };
      handle.display = xvfb.display;
    }

    // 2. tauri-driver + native driver (they and the app inherit this environment)
    let started2 = false;
    for (let attempt = 0; attempt < 5 && !started2; attempt += 1) {
      const port = await freePort();
      let nativePort = await freePort();
      while (nativePort === port) nativePort = await freePort();
      const log = fs.openSync(logPath, "a");
      driverChild = spawn(tools.tauriDriver, ["--port", String(port), "--native-port", String(nativePort), "--native-driver", tools.native], {
        env: xvfbEnv,
        detached: !IS_WIN,
        windowsHide: true,
        stdio: ["ignore", log, log],
      });
      fs.closeSync(log);
      groups.push({ pid: driverChild.pid, match: "tauri-driver" });
      writeOwner();
      let exited = false;
      driverChild.once("exit", () => (exited = true));
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !exited) {
        try {
          await getJson(`http://127.0.0.1:${port}/status`, 1000);
          started2 = true;
          break;
        } catch {
          await sleep(100);
        }
      }
      if (started2) {
        handle.port = port;
        handle.nativePort = nativePort;
      } else {
        killGroup(driverChild.pid);
        driverChild = null;
      }
    }
    if (!started2) throw await fail("tauri-driver did not start (ports taken?).");

    // 3. Session = the app
    wd.base = `http://127.0.0.1:${handle.port}`;
    const session = await wd.call("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: binary } } } }, timeoutMs).catch(async (error) => {
      throw await fail(`Could not start the app over WebDriver: ${error.message}`);
    });
    wd.sessionId = session.sessionId;
    await wd.call("POST", "/timeouts", { script: 60_000, implicit: 0 }).catch(() => undefined);
    liveApps.add(handle);

    // 4. Shell and window size
    await handle.waitFor(() => handle.exec(() => location.href.startsWith("http") && document.readyState !== "loading"), timeoutMs, { message: "page loaded" }).catch(async (error) => {
      throw await fail(error.message);
    });
    const size = await handle.size();
    if (size.width !== width || size.height !== height) {
      await handle.invoke("plugin:window|set_size", { label: "main", value: { Physical: { width, height } } }).catch(() => undefined);
      await handle.waitFor(async () => {
        const now = await handle.size();
        return now.width === width && now.height === height;
      }, 5000, { message: `window ${width}×${height}` }).catch(async () => {
        const now = await handle.size();
        throw await fail(`The window did not take the size ${width}×${height} (is ${now.width}×${now.height}, scale ${now.scale}).`);
      });
    }
    if (waitForShell) {
      await handle.waitForShell().catch(async (error) => {
        throw await fail(`${error.message}. Errors: ${(await handle.errors().catch(() => [])).join(" | ") || "none"}`);
      });
    }
    handle.startupMs = Date.now() - started;
    return handle;
  } catch (error) {
    if (!closed) throw await fail(error?.message ?? String(error));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const command = process.argv[2] ?? "--status";
  if (command === "--stop-vite") {
    console.log((await stopDevServer()) ? "Vite server for WebDriver tests stopped." : "No Vite server of this harness was running.");
  } else if (command === "--start-vite") {
    console.log(`Vite server for WebDriver tests: ${await ensureDevServer()}`);
  } else {
    const found = await findOurServer();
    console.log(found.url ? `Vite server: ${found.url} (PID ${found.pid})` : "Vite server: not running");
    console.log(`Debug app: ${fs.existsSync(builtBinary()) ? builtBinary() : "missing – node scripts/e2e-wd/prepare.mjs"}`);
    console.log(`Tools: ${JSON.stringify(findTools(), null, 2)}`);
  }
}
