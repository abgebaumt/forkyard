/**
 * (Gitea feature) A private, unlocked Secret Service for one test app: its own D-Bus session bus plus a
 * gnome-keyring-daemon that keeps its keyring in a temp folder. The app gets
 * `DBUS_SESSION_BUS_ADDRESS` of that bus, so tokens never touch the user's real keychain – and a
 * locked user keychain (screen locked, overnight runs) does not break the tests.
 *
 *   const keyring = await startPrivateKeyring();   // null if dbus-daemon/gnome-keyring-daemon are missing
 *   await t.launch({ env: keyring.env });
 *   await keyring.close();
 *   startPrivateKeyring({ secrets: false })        // bus WITHOUT a Secret Service: "no keychain"
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const onPath = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;

const started = new Set();
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const child of started) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

/** Starts bus and keyring daemon; resolves once the Secret Service answers with an unlocked default collection. */
export async function startPrivateKeyring({ secrets = true } = {}) {
  if (process.platform !== "linux" || !onPath("dbus-daemon") || !onPath("gnome-keyring-daemon") || !onPath("gdbus")) return null;
  hookExit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-gtkr-"));
  const runtime = path.join(dir, "run");
  const data = path.join(dir, "data");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true });
  const address = `unix:path=${path.join(dir, "bus")}`;

  const bus = spawn("dbus-daemon", ["--session", "--nofork", "--nopidfile", `--address=${address}`], { stdio: "ignore" });
  started.add(bus);
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: data };
  const busUp = async () => spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.ListNames"], { env, encoding: "utf8", timeout: 3000 }).status === 0;
  for (let round = 0; round < 50 && !(await busUp()); round++) await sleep(100);

  if (!secrets) {
    return {
      env: { DBUS_SESSION_BUS_ADDRESS: address },
      address,
      async close() {
        started.delete(bus);
        bus.kill("SIGTERM");
        await sleep(100);
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      },
    };
  }

  const daemon = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], { env, stdio: ["pipe", "ignore", "ignore"] });
  started.add(daemon);
  daemon.stdin.end("forkyard-e2e\n");

  const locked = () =>
    spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets/aliases/default", "--method", "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Collection", "Locked"], { env, encoding: "utf8", timeout: 3000 }).stdout?.trim();
  let state = null;
  for (let round = 0; round < 80; round++) {
    state = locked();
    if (state === "(<false>,)") break;
    await sleep(100);
  }

  const close = async () => {
    for (const child of [daemon, bus]) {
      started.delete(child);
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  if (state !== "(<false>,)") {
    await close();
    throw new Error(`private keyring did not come up unlocked (default collection: ${state || "missing"})`);
  }
  return { env: { DBUS_SESSION_BUS_ADDRESS: address }, address, close };
}
