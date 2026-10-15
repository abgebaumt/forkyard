/**
 * A private Secret Service for tests that remember credentials: an own D-Bus session bus plus a
 * gnome-keyring-daemon with an unlocked, throwaway "login" keyring in a temp folder. The app gets
 * its address as DBUS_SESSION_BUS_ADDRESS, so nothing reaches (or depends on) the user's keychain –
 * which may be locked while nobody is at the machine.
 *
 *   const keyring = await startPrivateKeyring();   // null if dbus-daemon/gnome-keyring-daemon are missing
 *   const app = await t.launch({ env: keyring.env });
 *   await keyring.close();
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const onPath = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || null;

function killGroup(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

export async function startPrivateKeyring() {
  const dbusDaemon = onPath("dbus-daemon");
  const keyringDaemon = onPath("gnome-keyring-daemon");
  if (!dbusDaemon || !keyringDaemon) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-keyring-"));
  const runtime = path.join(root, "runtime");
  const data = path.join(root, "data");
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.mkdirSync(data);
  const config = path.join(root, "bus.conf");
  fs.writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${runtime}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
`,
  );
  const bus = spawn(dbusDaemon, ["--config-file", config, "--nofork", "--print-address=1"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const address = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`dbus-daemon gave no address: ${text}`)), 10_000);
    bus.stdout.on("data", (chunk) => {
      text += chunk;
      const line = text.split("\n")[0];
      if (text.includes("\n") && line) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    bus.on("exit", (code) => reject(new Error(`dbus-daemon exited (${code})`)));
  });
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: data };
  const daemon = spawn(keyringDaemon, ["--foreground", "--unlock", "--components=secrets"], { env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
  daemon.stdin.end("e2e-keyring-password");
  // Ready once the service answers on the bus with an unlocked default collection.
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    const probe = spawnSync(
      "gdbus",
      ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets/aliases/default", "--method", "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Collection", "Locked"],
      { env, encoding: "utf8", timeout: 3000 },
    );
    ready = probe.status === 0 && probe.stdout.includes("false");
    if (!ready) await sleep(100);
  }
  const close = async () => {
    killGroup(daemon);
    killGroup(bus);
    await sleep(100);
    fs.rmSync(root, { recursive: true, force: true });
  };
  if (!ready) {
    await close();
    return null;
  }
  return { address, env: { DBUS_SESSION_BUS_ADDRESS: address }, root, close };
}
