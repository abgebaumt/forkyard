/**
 * Startup time in the real app: a restart with a repository tab from the last session must show
 * the commit graph without waiting for outside programs. A fake `claude` that hangs for 30 s on
 * every call sits on PATH and in FORKYARD_AI_CLI_DIR (the AI tools' only search folder in debug
 * builds); the start must not run it at all (before the fix, the left panel's Agents section asked
 * for the agent templates and so ran `claude --version` and `claude auth status` on every start).
 *
 * - main: restart → first commit rows within the bound, the UI's startup report in the log, no
 *   call of the slow tool, no call slower than two seconds, the keychain not asked;
 *
 *   cargo build && node scripts/e2e-wd/features/startup.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRichRepo } from "../../e2e/fixtures.mjs";
import { ROOT } from "../driver.mjs";
import { logText, makeDataDir } from "../fixtures/crash.mjs";
import { assert, assertEqual, scenario } from "../lib.mjs";

const FAKE = path.join(ROOT, "target", "debug", process.platform === "win32" ? "forkyard-fake-cli.exe" : "forkyard-fake-cli");
/** From launching the process to the first commit row. A start takes 3 to 4 s here (README); a
 * start that waited for the hanging tool would take more than 30 s. */
const FIRST_ROWS_WITHIN_MS = 15_000;
const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };

/** A `claude` that records every call and then hangs for 30 s. */
function installSlowClaude(dir) {
  assert(fs.existsSync(FAKE), `${FAKE} is missing – run cargo build first`);
  const program = path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
  fs.copyFileSync(FAKE, program);
  fs.chmodSync(program, 0o755);
  const config = { rules: [], fallback: { exit: 0, stdout: "2.1.301 (Claude Code)\n", sleepMs: 30_000 } };
  fs.writeFileSync(path.join(dir, "claude.fake.json"), JSON.stringify(config));
  const log = path.join(dir, "claude.calls.jsonl");
  return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []) };
}

const firstRows = (app, timeout) =>
  app.waitFor(async () => ((await app.$$('[data-row-kind="commit"]')).length >= 3 ? true : null), timeout, { message: "first commit rows" });

scenario("restart with a repository tab: the graph comes without waiting for a slow AI tool", "main", async (t) => {
  const repo = makeRichRepo();
  const data = makeDataDir();
  const cli = fs.mkdtempSync(path.join(os.tmpdir(), "fy-slow-cli-"));
  try {
    const claude = installSlowClaude(cli);
    const env = { FORKYARD_AI_CLI_DIR: cli, PATH: `${cli}${path.delimiter}${process.env.PATH ?? ""}` };

    // First run: the repository gets its tab, then the app ends normally.
    const first = await t.launch({ ...LAUNCH, dataDir: data.path, env });
    await first.openRepo(repo.path);
    await firstRows(first, 20_000);
    await first.close();
    t.step("repository tab saved");
    const before = logText(data.path).length;

    const launched = Date.now();
    const app = await t.launch({ ...LAUNCH, dataDir: data.path, env });
    await firstRows(app, FIRST_ROWS_WITHIN_MS + 5_000);
    const elapsed = Date.now() - launched;
    t.step(`first commit rows ${elapsed} ms after launch (shell after ${app.startupMs} ms)`);
    assert(elapsed < FIRST_ROWS_WITHIN_MS, `the graph took ${elapsed} ms (bound ${FIRST_ROWS_WITHIN_MS} ms)`);

    // The UI's own measurement (development build: window.__gcStartup) and its line in the log.
    const trace = await app.waitFor(() => app.exec(() => (window.__gcStartup?.reported ? window.__gcStartup : null)), 10_000, { message: "startup report sent" });
    const marks = Object.fromEntries(trace.marks.map((mark) => [mark.name, Math.round(mark.at)]));
    t.step(`marks since page start: ${JSON.stringify(marks)}`);
    for (const name of ["script", "paint", "shell", "graph"]) assert(name in marks, `mark ${name} missing: ${JSON.stringify(marks)}`);
    const slow = trace.calls.filter((call) => call.ms >= 2000);
    assertEqual(slow, [], "no core call during the start took two seconds or more");
    const log = await app.waitFor(() => {
      const text = logText(data.path).slice(before);
      return text.includes("Startup (UI):") ? text : null;
    }, 10_000, { message: "startup line in the log" });
    assert(/Startup \(UI\): page started at \d+ ms, .*graph at \d+ ms/.test(log), "the log names the graph's time");
    assert(!log.includes("Startup: first keychain probe"), "the start asked the keychain");

    assertEqual(claude.calls().map((call) => call.args.join(" ")), [], "the start ran the AI tool");
    await t.shot("restarted");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
    data.cleanup();
    fs.rmSync(cli, { recursive: true, force: true });
  }
});
