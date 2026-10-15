/**
 * Runs the WebDriver features (scripts/e2e-wd/features/*.mjs), at most 4 at a time.
 *
 *   node scripts/e2e-wd/run.mjs                 all features
 *   node scripts/e2e-wd/run.mjs smoke graph     only features whose file name contains one of the words
 *   node scripts/e2e-wd/run.mjs --jobs 2        other parallelism (default 4)
 *   node scripts/e2e-wd/run.mjs --only "text"   only scenarios whose name contains the text
 *   node scripts/e2e-wd/run.mjs --repeat 4 smoke  the same feature 4 times at once (isolation check)
 *
 * All features of one run use the same copy of the app binary (E2E_WD_APP). Per feature:
 * target/e2e-wd/results/<name>.json, target/e2e-wd/shots/<name>/, log target/e2e-wd/logs/<name>.log.
 * Exits with 1 if a feature failed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE_DIR, ensureAppCopy, ensureDevServer } from "./driver.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const [value] = argv.splice(index, 2).slice(1);
  return value;
};
const jobs = Math.max(1, Number(option("--jobs", 4)) || 4);
const only = option("--only", null);
const repeat = Math.max(1, Number(option("--repeat", 1)) || 1);
const filters = argv.filter((arg) => !arg.startsWith("--"));

const featuresDir = path.join(ROOT, "scripts", "e2e-wd", "features");
const features = fs
  .readdirSync(featuresDir)
  .filter((file) => file.endsWith(".mjs") && !file.startsWith("_"))
  .map((file) => file.slice(0, -4))
  .filter((name) => !filters.length || filters.some((filter) => name.includes(filter)))
  .sort();
if (!features.length) {
  console.error(`No feature matches ${filters.join(", ")}.`);
  process.exit(1);
}
const queue = features.flatMap((name) => Array.from({ length: repeat }, (_, index) => ({ file: name, name: repeat > 1 ? `${name}-${index + 1}` : name })));

const app = await ensureAppCopy();
await ensureDevServer();
const logsDir = path.join(STATE_DIR, "logs");
const resultsDir = path.join(STATE_DIR, "results");
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });
console.log(`${queue.length} feature run(s), ${Math.min(jobs, queue.length)} at a time, app ${path.relative(ROOT, app)}`);

const started = Date.now();
const outcomes = [];
async function runFeature({ file, name }) {
  const resultFile = path.join(resultsDir, `${name}.json`);
  fs.rmSync(resultFile, { force: true });
  fs.rmSync(path.join(STATE_DIR, "shots", name), { recursive: true, force: true });
  const logFile = path.join(logsDir, `${name}.log`);
  const log = fs.openSync(logFile, "w");
  const begin = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(featuresDir, `${file}.mjs`)], {
      cwd: ROOT,
      env: { ...process.env, E2E_WD_APP: app, E2E_WD_FEATURE: name, ...(only ? { E2E_WD_ONLY: only } : {}) },
      stdio: ["ignore", log, log],
    });
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  fs.closeSync(log);
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch {
    // crashed before writing results
  }
  const ok = code === 0 && summary && summary.failed === 0;
  outcomes.push({ name, ok, code, summary, ms: Date.now() - begin, logFile });
  console.log(`${ok ? "✓" : "✗"} ${name} ${summary ? `${summary.passed}/${summary.ran}` : "(no results)"} ${Date.now() - begin} ms${ok ? "" : ` – log: ${path.relative(ROOT, logFile)}`}`);
  if (!ok && summary) for (const failed of summary.scenarios.filter((entry) => entry.status === "failed")) console.log(`    ✗ ${failed.name}: ${String(failed.error).split("\n")[0]}`);
}

const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) await runFeature(queue.shift());
});
await Promise.all(workers);
const failed = outcomes.filter((outcome) => !outcome.ok);
console.log(`${failed.length ? "FAILED" : "PASSED"}: ${outcomes.length - failed.length}/${outcomes.length} features in ${Date.now() - started} ms`);
process.exit(failed.length ? 1 : 0);
