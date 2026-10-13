/**
 * Removes temp folders of finished app instances that could not be deleted right away. The driver
 * starts this script detached and does not wait for it:
 *
 *   node scripts/e2e/cleanup.mjs [--kill-now] <folder> …
 *
 * Under load the WebView2 processes need a few seconds after exit before they release their
 * profile. The script keeps trying to delete for up to 60 seconds. If something still holds the
 * folder after 10 seconds (immediately with --kill-now), it kills the WebView2 processes that carry
 * this profile folder on their command line – it leaves all others alone.
 *
 * A Node script, because a detached PowerShell (without a console) does not run anything.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const killNow = args.includes("--kill-now");
// Only folders the driver itself created in the temp directory.
const dirs = args.filter((arg) => !arg.startsWith("--")).filter((dir) => path.basename(dir).startsWith("gc-e2e-") && path.dirname(path.resolve(dir)).toLowerCase() === fs.realpathSync.native(os.tmpdir()).toLowerCase());

const started = Date.now();
let killed = false;

function killHolders(left) {
  if (process.platform !== "win32") return;
  const filter = left.map((dir) => `$_.CommandLine -like '*${path.basename(dir)}*'`).join(" -or ");
  spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { ${filter} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: "ignore", windowsHide: true, timeout: 30_000 },
  );
}

function attempt() {
  const left = dirs.filter((dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return false;
    } catch {
      return true;
    }
  });
  const elapsed = Date.now() - started;
  if (!left.length || elapsed > 60_000) return;
  if (!killed && (killNow || elapsed > 10_000)) {
    killed = true;
    killHolders(left);
  }
  setTimeout(attempt, 500);
}
attempt();
