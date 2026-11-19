// Benchmark on a large repository: builds target/bench/large-repo (120 000 commits, big.txt with
// 5 000 lines changed by 5 000 commits) once, then runs forkyard-bench 3 times and prints a table.
// Report only: a missed target does not fail the run.
//
//   node scripts/bench/large-repo.mjs [--release]

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1";
const TOTAL = 120_000;
const BIG_LINES = 5_000;
const BIG_CHANGES = 5_000;
const BASE = 1_600_000_000;
const RUNS = 3;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const benchDir = path.join(root, "target", "bench");
const repo = path.join(benchDir, "large-repo");
const versionFile = path.join(repo, ".bench-version");
const release = process.argv.includes("--release");

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, LC_ALL: "C" };
const git = (...args) => execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();

/** Writes the fast-import stream: a main line with a feature branch merged every 7 commits and 3 long-lived release branches. */
async function build() {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  // No template: no sample hooks.
  git("init", "-q", "--template=", "-b", "main");
  const child = spawn("git", ["fast-import", "--quiet"], { cwd: repo, env: gitEnv, stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) =>
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`fast-import: ${code}`)))),
  );
  const write = (text) => (child.stdin.write(text) ? undefined : new Promise((resolve) => child.stdin.once("drain", resolve)));

  let count = 0;
  const tips = { main: 0, feature: 0, "release/1": 0, "release/2": 0, "release/3": 0 };
  const big = Array.from({ length: BIG_LINES }, (_, i) => `line ${i}`);
  let bigChanges = 0;
  let mainCommits = 0;

  // One commit on `branch` (parent: its tip, or `from`), optionally a merge of `merge`; returns its mark.
  const commit = async (branch, { from, merge, files }) => {
    count++;
    const time = `${BASE + count * 60} +0000`;
    const message = `${branch} ${count}\n`;
    let text = `commit refs/heads/${branch}\nmark :${count}\n`;
    text += `author Bench Author <author@bench.example> ${time}\ncommitter Bench Committer <committer@bench.example> ${time}\n`;
    text += `data ${Buffer.byteLength(message)}\n${message}`;
    const parent = from ?? tips[branch];
    if (parent) text += `from :${parent}\n`;
    if (merge) text += `merge :${merge}\n`;
    for (const [file, content] of files) text += `M 100644 inline ${file}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    tips[branch] = count;
    await write(text);
    return count;
  };
  const small = (dir) => [[`${dir}/f${count % 500}.txt`, `${count}\n`]];
  const mainCommit = async () => {
    const files = small("src");
    // The root commit adds big.txt; then every 12th main commit changes line i % 5000 for the i-th change.
    if (count === 0 || (++mainCommits % 12 === 0 && bigChanges < BIG_CHANGES)) {
      if (count > 0) {
        const i = bigChanges++;
        big[i % BIG_LINES] = `line ${i % BIG_LINES} changed by change ${i}`;
      }
      files.push(["big.txt", `${big.join("\n")}\n`]);
    }
    await commit("main", { files });
  };

  for (let cycle = 0; count < TOTAL; cycle++) {
    if (TOTAL - count < 8) {
      await mainCommit();
      continue;
    }
    // 4 main commits, 2 on a feature branch, 1 merge: a merge every 7 commits.
    for (let n = 0; n < 4; n++) await mainCommit();
    await commit("feature", { from: tips.main, files: small("feature") });
    await commit("feature", { files: small("feature") });
    await commit("main", { merge: tips.feature, files: [] });
    // Every third cycle one commit on a release branch, in turn; they start from main and never merge back.
    if (cycle % 3 === 0) {
      const branch = `release/${((cycle / 3) % 3) + 1}`;
      await commit(branch, { from: tips[branch] || tips.main, files: small("release") });
    }
  }
  child.stdin.end();
  await done;
  if (bigChanges !== BIG_CHANGES) throw new Error(`big.txt changed ${bigChanges} times, expected ${BIG_CHANGES}`);
  git("reset", "-q", "--hard");
  fs.writeFileSync(versionFile, VERSION);
}

const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : null;
if (current !== VERSION) {
  console.log(`Building ${repo} (${TOTAL} commits) …`);
  const start = Date.now();
  await build();
  console.log(`Built in ${((Date.now() - start) / 1000).toFixed(1)} s, ${git("rev-list", "--all", "--count")} commits.`);
} else {
  console.log(`Reusing ${repo}.`);
}

execFileSync("cargo", ["build", "-p", "gitcore", "--bin", "forkyard-bench", ...(release ? ["--release"] : [])], {
  cwd: root,
  stdio: "inherit",
});
const exe = path.join(root, "target", release ? "release" : "debug", `forkyard-bench${process.platform === "win32" ? ".exe" : ""}`);
const runs = [];
for (let n = 0; n < RUNS; n++) {
  runs.push(JSON.parse(execFileSync(exe, ["--repo", repo, "--file", "big.txt"], { cwd: root, encoding: "utf8" })));
}

const values = (key) => runs.map((r) => r[key]);
const fmt = (v) => (v == null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(1));
const rows = [
  ["commits", values("commits"), "", null],
  ["firstPageMs", values("firstPageMs"), "< 300", runs.every((r) => r.firstPageMs < 300)],
  [
    `deepPageMs (depth ${runs[0].depth})`,
    values("deepPageMs"),
    "≤ 2× first page",
    runs.every((r) => r.deepPageMs != null && r.deepPageMs <= 2 * r.firstPageMs),
  ],
  ["blameFirstLinesMs", values("blameFirstLinesMs"), "< 500", runs.every((r) => r.blameFirstLinesMs != null && r.blameFirstLinesMs < 500)],
  ["blameDoneMs", values("blameDoneMs"), "", null],
  ["blameLines", values("blameLines"), "", null],
];
const table = rows.map(([metric, vs, target, ok]) => {
  const known = vs.filter((v) => v != null);
  const min = known.length ? Math.min(...known) : null;
  const max = known.length ? Math.max(...known) : null;
  return [metric, fmt(min), fmt(max), target, ok == null ? "" : ok ? "yes" : "NO"];
});
const header = ["metric", "min", "max", "target", "ok?"];
const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
for (const row of [header, ...table]) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));

const resultFile = path.join(benchDir, "result.json");
fs.writeFileSync(resultFile, `${JSON.stringify({ build: release ? "release" : "debug", runs }, null, 2)}\n`);
console.log(`\n${resultFile}`);
