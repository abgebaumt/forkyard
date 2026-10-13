/**
 * Runs E2E scripts in batches and writes one log per script.
 *
 *   node scripts/e2e/run-all.mjs                       all scripts (scripts/e2e, screens, flows)
 *   node scripts/e2e/run-all.mjs --set flows           only scripts/e2e/flows
 *   node scripts/e2e/run-all.mjs --set screens         only scripts/e2e/screens
 *   node scripts/e2e/run-all.mjs --set base            only scripts/e2e (smoke, contract, shell)
 *   node scripts/e2e/run-all.mjs --scripts B-F19,commit-panel   only these (file name without .mjs)
 *   node scripts/e2e/run-all.mjs --jobs 3 --log target/e2e/run-logs/<name>
 *   node scripts/e2e/run-all.mjs --scripts B-F19 -- --only F19-N6     everything after "--" goes to the scripts
 *
 * Rules: at most three scripts at a time; commit-graph and scripts that use the system clipboard run alone
 * (there is only one clipboard, and the frame-time limits of commit-graph depend on load). Libraries
 * (*-lib.mjs, _wip.mjs) and helper programs are not run.
 * End: table with exit code and duration; exit code 1 if any script was red.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split === -1 ? argv : argv.slice(0, split);
const passThrough = split === -1 ? [] : argv.slice(split + 1);
const option = (name, fallback) => (own.includes(name) ? own[own.indexOf(name) + 1] : fallback);

const NOT_A_TEST = new Set(["cleanup", "driver", "fixtures", "git-http-server", "git-ssh-server", "host-mock", "shot", "run-all", "_wip"]);
/** Alone: commit-graph (frame time) and everything that reads or writes the system clipboard. */
const ALONE = new Set(["commit-graph", "A-F18", "mustfix-ssh", "patches", "commit-details", "terminal", "settings", "activity-log", "submodules", "contract"]);
const TIMEOUT_MS = Number(option("--timeout-min", "60")) * 60_000;

function scriptsIn(dir, set) {
  return fs
    .readdirSync(path.join(ROOT, dir))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith("-lib.mjs"))
    .map((file) => ({ name: file.replace(/\.mjs$/, ""), file: path.join(dir, file), set }))
    .filter((script) => !NOT_A_TEST.has(script.name));
}

const all = [...scriptsIn("scripts/e2e", "base"), ...scriptsIn("scripts/e2e/screens", "screens"), ...scriptsIn("scripts/e2e/flows", "flows")];
const wantedSet = option("--set", "all");
const wantedNames = option("--scripts", null)?.split(",") ?? null;
const selected = all.filter((script) => (wantedNames ? wantedNames.includes(script.name) : wantedSet === "all" || script.set === wantedSet));
if (wantedNames) for (const name of wantedNames) if (!all.some((script) => script.name === name)) console.log(`Unknown script: ${name}`);

const jobs = Math.min(3, Math.max(1, Number(option("--jobs", "3"))));
const logDir = path.resolve(ROOT, option("--log", `target/e2e/run-logs/${new Date().toISOString().replace(/[:.]/g, "-")}`));
fs.mkdirSync(logDir, { recursive: true });

const results = [];

function run(script) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logFile = path.join(logDir, `${script.name}.log`);
    const out = fs.openSync(logFile, "w");
    const child = spawn(process.execPath, [script.file, ...passThrough], { cwd: ROOT, stdio: ["ignore", out, out], windowsHide: true });
    const timer = setTimeout(() => {
      fs.appendFileSync(logFile, `\n[run-all] time limit of ${TIMEOUT_MS / 60_000} min exceeded – process killed\n`);
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fs.closeSync(out);
      const seconds = Math.round((Date.now() - started) / 1000);
      results.push({ name: script.name, code, seconds });
      console.log(`${code === 0 ? "green" : "RED  "}  ${script.name.padEnd(24)} ${String(seconds).padStart(5)} s  (Exit ${code})`);
      resolve();
    });
  });
}

async function pool(list, size) {
  const queue = [...list];
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) await run(queue.shift());
    }),
  );
}

console.log(`${selected.length} scripts, at most ${jobs} at a time, logs: ${path.relative(ROOT, logDir)}`);
await pool(selected.filter((script) => !ALONE.has(script.name)), jobs);
await pool(selected.filter((script) => ALONE.has(script.name)), 1);

results.sort((a, b) => a.name.localeCompare(b.name));
const red = results.filter((result) => result.code !== 0);
const summary = [`${results.length} scripts: ${results.length - red.length} green, ${red.length} red`, ...results.map((result) => `${result.code === 0 ? "green" : "RED  "}  ${result.name}  ${result.seconds} s`)].join("\n");
fs.writeFileSync(path.join(logDir, "summary.txt"), `${summary}\n`);
console.log(`\n${summary}`);
process.exit(red.length ? 1 : 0);
