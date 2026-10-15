/**
 * Helpers for the crash report feature (scripts/e2e-wd/features/crash.mjs):
 * data directories that survive a restart, the app's process from the crash marker, and report
 * files in exactly the format the core's panic hook writes (`crates/core/src/crash.rs`,
 * `ReportFile`, camelCase JSON in `<data_dir>/crash/<id>.json`).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A data directory of our own (launchApp only removes the ones it creates itself). */
export function makeDataDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-crash-data-")));
  return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

export const markerPath = (dataDir) => path.join(dataDir, "running");

/** The crash marker (`{ runId, pid, startedMs, appVersion }`), or null when there is none / it is empty. */
export function readMarker(dataDir) {
  try {
    const text = fs.readFileSync(markerPath(dataDir), "utf8");
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Whether the process runs (a zombie counts as ended). */
export function processRuns(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    return !/^State:\s+Z/m.test(status);
  } catch {
    return false;
  }
}

export function processName(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return null;
  }
}

export async function waitForExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processRuns(pid)) return true;
    await sleep(100);
  }
  return false;
}

/** The app process of a data directory, from the marker it holds (checked against /proc). */
export async function appPid(dataDir, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marker = readMarker(dataDir);
    if (marker?.pid && processRuns(marker.pid) && (processName(marker.pid) ?? "").startsWith("forkyard")) return { pid: marker.pid, marker };
    await sleep(100);
  }
  throw new Error(`No running app holds the crash marker in ${dataDir}`);
}

export const crashDir = (dataDir) => path.join(dataDir, "crash");

/** All files in the crash folder (names). */
export function crashFiles(dataDir) {
  try {
    return fs.readdirSync(crashDir(dataDir)).sort();
  } catch {
    return [];
  }
}

/** Parsed reports in the crash folder (unreadable ones skipped), newest first. */
export function reportFiles(dataDir) {
  const out = [];
  for (const name of crashFiles(dataDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push({ file: name, ...JSON.parse(fs.readFileSync(path.join(crashDir(dataDir), name), "utf8")) });
    } catch {
      /* not a report */
    }
  }
  return out.sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0));
}

/** All lines of the app's log (all rotated files, oldest first). */
export function logText(dataDir) {
  const dir = path.join(dataDir, "logs");
  return ["forkyard.2.log", "forkyard.1.log", "forkyard.log"]
    .map((name) => {
      try {
        return fs.readFileSync(path.join(dir, name), "utf8");
      } catch {
        return "";
      }
    })
    .join("");
}

/** `20261014T120000123Z-1a2b3c4d`, as `report_id` in the core makes it. */
export function reportId(ms) {
  const stamp = new Date(ms).toISOString().replace(/[-:]/g, "").replace(".", "");
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Writes a report as the core's panic hook does (already scrubbed texts). Returns the report.
 * `kind`: "panic" | "unexpected_exit".
 */
export function writeReport(dataDir, {
  kind = "panic",
  timeMs = Date.now() - 60_000,
  appVersion = "1.0.0",
  message = "index out of bounds: the len is 3 but the index is 7",
  thread = "tokio-runtime-worker",
  location = "crates/core/src/commands/graph/layout.rs:212:17",
  backtrace = "   0: std::backtrace::Backtrace::force_capture\n   1: gitcore::crash::CrashLog::on_panic\n   2: gitcore::commands::graph::layout::assign_lanes\n   3: tokio::runtime::task::harness::poll",
  log = null,
  id = null,
} = {}) {
  const runId = crypto.randomUUID();
  const runStartedMs = timeMs - 5 * 60_000;
  const report = {
    id: id ?? reportId(timeMs),
    kind,
    timeMs,
    appVersion,
    os: "linux",
    arch: "x86_64",
    runId,
    runStartedMs,
    thread: kind === "panic" ? thread : null,
    message,
    location: kind === "panic" ? location : null,
    backtrace: kind === "panic" ? backtrace : null,
    log: log ?? [
      `${iso(runStartedMs)} === Forkyard ${appVersion} started (run ${runId}) ===`,
      `${iso(runStartedMs + 5)} INFO  forkyard_lib: Forkyard ${appVersion} on linux x86_64`,
      `${iso(timeMs - 10)} INFO  gitcore::commands::graph: graph page for 1 repository`,
    ],
  };
  fs.mkdirSync(crashDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(crashDir(dataDir), `${report.id}.json`), JSON.stringify(report, null, 2));
  return report;
}
