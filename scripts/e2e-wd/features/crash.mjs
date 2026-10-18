/**
 * Crash reports in the real app (v1.1 pre-release): a run that ends hard (SIGKILL, SIGABRT) leaves
 * the crash marker, the next start makes an "unexpected exit" report from that run's log and offers
 * it (View / Save… / Discard, also "Show crash reports" in the palette). Panic reports in the panic
 * hook's format are offered the same way. SIGTERM, SIGINT and SIGHUP end the app like quitting:
 * marker removed, no report, no dialog on the next start.
 *
 *   node scripts/e2e-wd/features/crash.mjs
 *
 * Every scenario uses its own data directory that survives the restart (launchApp's `dataDir`).
 * Note: `app.close()` ends a still running app cleanly (SIGTERM) before it ends the WebDriver
 * session; scenarios that want an unexpected exit kill the app themselves first (SIGKILL/SIGABRT).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRichRepo } from "../../e2e/fixtures.mjs";
import { openApps } from "../driver.mjs";
import { SHOTS_DIR, assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";
import { appPid, crashDir, crashFiles, logText, makeDataDir, markerPath, readMarker, reportFiles, waitForExit, writeReport } from "../fixtures/crash.mjs";

/** The version the built app reports (the workspace version, same as package.json). */
const APP_VERSION = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

const TITLE = "Forkyard closed unexpectedly last time";
const titleOf = (index, count) => `Forkyard closed unexpectedly (${index} of ${count})`;

// ---- UI helpers -------------------------------------------------------------

/** The top dialog: { title, text } or null. */
const topDialog = (app) =>
  app.exec(() => {
    const all = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
    const box = all.pop();
    if (!box) return null;
    const heading = box.querySelector("h1, h2, h3, [data-dialog-title]");
    return { title: (heading?.innerText ?? "").trim(), text: box.innerText };
  });

async function waitDialog(app, title, timeout = 20_000) {
  return app.waitFor(async () => {
    const box = await topDialog(app);
    return box && box.title === title ? box : null;
  }, timeout, { message: `dialog "${title}"` });
}

const noDialog = (app, timeout = 8000) => app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), timeout, { message: "no dialog open" });

/** Clicks the option/button with this label in the top dialog. */
async function clickInDialog(app, label) {
  const button = await app.waitFor(
    () =>
      app.exec((wanted) => {
        const box = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
        if (!box) return null;
        return [...box.querySelectorAll("button")].find((b) => {
          const first = b.querySelector("span")?.innerText.trim() ?? b.innerText.split("\n")[0].trim();
          return first === wanted || b.innerText.trim() === wanted;
        }) ?? null;
      }, label),
    8000,
    { message: `button "${label}" in the dialog` },
  );
  await app.click(button);
}

const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.getAttribute("data-toast"), text: el.innerText.replace(/\s+/g, " ").trim() })));

async function waitToast(app, text, timeout = 8000) {
  return app.waitFor(async () => (await toasts(app)).find((toast) => toast.text.includes(text)) ?? null, timeout, { message: `toast "${text}"` });
}

/** "Show crash reports" from the command palette. */
async function paletteCrashReports(app) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, ">crash");
  const sel = '[data-screen="command-palette"] [role="option"][data-key="command:app.crashReports"]';
  // The list re-renders while filtering: read the title and click inside the page (no stale node).
  const title = await app.waitFor(() => app.exec((s) => document.querySelector(s)?.innerText ?? null, sel), 10_000, { message: "palette entry app.crashReports" });
  assertIncludes(title, "Show crash reports", "palette entry title");
  await app.settle();
  await app.click(sel);
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** Waits a while and makes sure no crash dialog shows up. */
async function expectNoCrashDialog(app, ms = 4000) {
  await app.settle(5000);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const box = await topDialog(app);
    assert(!box || !/closed unexpectedly|unerwartet beendet/.test(box.title), `unexpected crash dialog: ${box?.title}`);
    await sleep(250);
  }
}

// ---- process helpers --------------------------------------------------------

/** Starts the app on `dataDir`, opens `repo` (Git calls for the activity log), returns app + pid. */
async function startWithRepo(t, dataDir, repo, options = {}) {
  const app = await t.launch({ dataDir, lang: "en", theme: "light", ...options });
  const repoId = repo ? (await app.openRepo(repo.path)).repoId : null;
  const { pid, marker } = await appPid(dataDir);
  return { app, pid, marker, repoId };
}

/** Ends the app with a signal and waits until the process is gone. */
async function endWith(app, pid, signal) {
  process.kill(pid, signal);
  assert(await waitForExit(pid, 20_000), `the app (PID ${pid}) did not end after ${signal}`);
  await app.close();
}

/** A data directory whose last run ended hard (SIGKILL) after opening `repo`. */
async function crashedRun(t, dataDir, repo, signal = "SIGKILL") {
  const { app, pid, marker } = await startWithRepo(t, dataDir, repo);
  await app.settle(5000);
  await endWith(app, pid, signal);
  t.step(`run ${marker.runId} (PID ${pid}) ended with ${signal}`);
  return marker;
}

const slugOf = (text) => String(text ?? "scenario").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "scenario";

function withSetup(fn) {
  return async (t) => {
    const data = makeDataDir();
    const repo = makeRichRepo({ dirty: false });
    try {
      await fn(t, data.path, repo);
    } catch (error) {
      // The data directory goes away below: photograph the apps first (lib.mjs would be too late).
      let index = 0;
      for (const app of openApps()) {
        index += 1;
        await app.screenshot(path.join(SHOTS_DIR, `FAIL-${slugOf(t.currentName)}${index > 1 ? `-${index}` : ""}.png`)).catch(() => undefined);
      }
      throw error;
    } finally {
      for (const app of openApps()) await app.close().catch(() => undefined);
      repo.cleanup();
      data.cleanup();
    }
  };
}

const reportText = async (app) => {
  const box = await waitDialog(app, "Crash report");
  return app.exec(() => [...document.querySelectorAll('[role="dialog"]')].pop()?.querySelector("pre")?.textContent ?? "") .then((text) => ({ box, text }));
};

// ---- scenarios --------------------------------------------------------------

/** `scenario` that tells withSetup its name (for the FAIL screenshot). */
const sc = (name, kind, fn) => scenario(name, kind, (t) => { t.currentName = name; return fn(t); });

sc("unexpected exit: SIGKILL leaves the marker, the next start offers a report", "main", withSetup(async (t, dataDir, repo) => {
  const head = git(repo.path, ["rev-parse", "HEAD"]);
  const before = await crashedRun(t, dataDir, repo);
  const marker = readMarker(dataDir);
  assert(marker, "the crash marker must survive a SIGKILL");
  assertEqual(marker.runId, before.runId, "marker names the killed run");
  assertEqual(crashFiles(dataDir).length, 0, "no report before the next start");
  // Git state untouched by the hard end.
  assertEqual(git(repo.path, ["rev-parse", "HEAD"]), head, "HEAD unchanged");
  assert(!fs.existsSync(path.join(repo.path, ".git", "index.lock")), "no index.lock left behind");

  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  const box = await waitDialog(app, TITLE);
  assertIncludes(box.text, "Unexpected exit", "kind in the dialog");
  assertIncludes(box.text, `Forkyard ${APP_VERSION}`, "version in the dialog");
  assertIncludes(box.text, "ended without shutting down", "message in the dialog");
  assertIncludes(box.text, "Nothing is sent anywhere", "privacy note");
  for (const label of ["View", "Save…", "Discard", "Cancel"]) assertIncludes(box.text, label, "options");
  const reports = reportFiles(dataDir);
  assertEqual(reports.length, 1, "one report on disk");
  assertEqual(reports[0].kind, "unexpected_exit", "report kind");
  assertEqual(reports[0].runId, before.runId, "report is about the killed run");
  assertIncludes(reports[0].log[0], `started (run ${before.runId})`, "report log starts with that run's header");
  assert(reports[0].log.length >= 2, "report carries the run's log lines");
  const listed = await app.invoke("crash_reports_list", {});
  assertEqual(listed.map((r) => [r.id, r.kind]), [[reports[0].file.replace(/\.json$/, ""), "unexpected_exit"]], "crash_reports_list");
  const now = readMarker(dataDir);
  assert(now && now.runId !== before.runId, "the new run took over the marker");
  await t.shot("unexpected-exit-dialog");
  await t.noConsoleErrors(app);
}));

sc("view: the full report with the run's log and its last Git calls", "main", withSetup(async (t, dataDir, repo) => {
  const before = await crashedRun(t, dataDir, repo);
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  await waitDialog(app, TITLE);
  await clickInDialog(app, "View");
  const { text } = await reportText(app);
  assertMatch(text, /^Forkyard crash report\n/, "report header");
  assertIncludes(text, "Kind:     unexpected exit", "kind line");
  assertIncludes(text, `Run:      ${before.runId}`, "run line");
  assertIncludes(text, "Platform: linux", "platform");
  assertIncludes(text, "Started:  ", "start time of the run");
  assertMatch(text, new RegExp(String.raw`Log \(\d+ lines\):\n.*=== Forkyard ${APP_VERSION.replaceAll(".", "\\.")} started \(run `), "log section");
  const calls = text.match(/Last Git calls \((\d+), newest first\):/);
  assert(calls, "section with the last Git calls");
  assert(Number(calls[1]) > 0, `the killed run made Git calls, the report lists ${calls[1]}`);
  assertMatch(text, /exit 0\s+\d+ ms\s+git /, "a Git call line");
  t.step(`report lists ${calls[1]} Git calls`);
  await t.shot("view-report");
  // Close the text: the choice comes back (the report is still pending).
  await clickInDialog(app, "Close");
  await waitDialog(app, TITLE);
  await clickInDialog(app, "Cancel");
  await noDialog(app);
  assertEqual(reportFiles(dataDir).length, 1, "closing keeps the report");
  await t.noConsoleErrors(app);
}));

sc("save: the report goes to the chosen text file and stays pending", "main", withSetup(async (t, dataDir, repo) => {
  const before = await crashedRun(t, dataDir, repo);
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  await waitDialog(app, TITLE);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-crash-save-"));
  try {
    const target = path.join(outDir, "forkyard-crash.txt");
    await app.exec((p) => { window.__gcTestSaves = [p]; }, target);
    await clickInDialog(app, "Save…");
    const toast = await waitToast(app, "Crash report saved");
    assertEqual(toast.tone, "success", "toast tone");
    assertIncludes(toast.text, target, "toast names the path");
    await t.shot("save-report");
    assert(fs.existsSync(target), "file written");
    const saved = fs.readFileSync(target, "utf8");
    assertMatch(saved, /^Forkyard crash report\n/, "saved text header");
    assertIncludes(saved, `Run:      ${before.runId}`, "saved run");
    assertIncludes(saved, "Last Git calls (", "saved Git calls");
    // The same text as "View".
    const viewed = await app.invoke("crash_report_get", { id: reportFiles(dataDir)[0].file.replace(/\.json$/, "") });
    assertEqual(saved, viewed, "saved file equals the viewed report");
    // Still pending: the dialog is back, the file still in the crash folder.
    await waitDialog(app, TITLE);
    assertEqual(reportFiles(dataDir).length, 1, "report kept after saving");
    await t.noConsoleErrors(app);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}));

sc("discard: report deleted, palette says there are none, a clean restart offers nothing", "main", withSetup(async (t, dataDir, repo) => {
  await crashedRun(t, dataDir, repo);
  const { app, pid } = await startWithRepo(t, dataDir, null);
  await waitDialog(app, TITLE);
  assertEqual(reportFiles(dataDir).length, 1, "one report before discarding");
  await clickInDialog(app, "Discard");
  const toast = await waitToast(app, "Crash report deleted");
  assertEqual(toast.tone, "info", "toast tone");
  await noDialog(app);
  assertEqual(crashFiles(dataDir), [], "crash folder empty");
  assertEqual(await app.invoke("crash_reports_list", {}), [], "crash_reports_list empty");
  await t.shot("discard-report");
  await paletteCrashReports(app);
  await waitToast(app, "There are no crash reports.");
  await t.noConsoleErrors(app);
  // A clean end (SIGTERM) and a new start: nothing is offered again.
  await endWith(app, pid, "SIGTERM");
  const again = await t.launch({ dataDir, lang: "en", theme: "light" });
  await expectNoCrashDialog(again);
  assertEqual(crashFiles(dataDir), [], "still no report");
  await t.noConsoleErrors(again);
}));

sc("panic report: offered on start with message, thread, location and backtrace", "main", withSetup(async (t, dataDir) => {
  // A real panic cannot be provoked from outside the app; the report is written in the panic
  // hook's own format (ReportFile), which is what the next start reads.
  const report = writeReport(dataDir, { kind: "panic" });
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  const box = await waitDialog(app, TITLE);
  assertIncludes(box.text, "Internal error", "kind in the dialog");
  assertIncludes(box.text, "index out of bounds: the len is 3 but the index is 7", "panic message in the dialog");
  await t.shot("panic-report-dialog");
  await clickInDialog(app, "View");
  const { text } = await reportText(app);
  assertIncludes(text, "Kind:     panic", "kind line");
  assertIncludes(text, "Thread:   tokio-runtime-worker", "thread");
  assertIncludes(text, "Location: crates/core/src/commands/graph/layout.rs:212:17", "location");
  assertIncludes(text, "Backtrace:\n   0: std::backtrace::Backtrace::force_capture", "backtrace");
  assertIncludes(text, `=== Forkyard 1.0.0 started (run ${report.runId}) ===`, "log of the run");
  assertMatch(text, /Last Git calls \(0, newest first\):/, "no Git calls of this app in that old window");
  await t.shot("panic-report-view");
  await clickInDialog(app, "Close");
  await waitDialog(app, TITLE);
  await clickInDialog(app, "Discard");
  await noDialog(app);
  assertEqual(crashFiles(dataDir), [], "panic report discarded");
  await t.noConsoleErrors(app);
}));

sc("SIGTERM ends the app cleanly: marker removed, no report, no dialog on the next start", "main", withSetup(async (t, dataDir, repo) => {
  const { app, pid, marker } = await startWithRepo(t, dataDir, repo);
  await app.settle(5000);
  assert(fs.existsSync(markerPath(dataDir)), "marker while running");
  const started = Date.now();
  await endWith(app, pid, "SIGTERM");
  t.step(`ended ${Date.now() - started} ms after SIGTERM`);
  assert(!fs.existsSync(markerPath(dataDir)), `marker removed on SIGTERM (content: ${JSON.stringify(readMarker(dataDir))})`);
  const log = logText(dataDir);
  assertIncludes(log, `started (run ${marker.runId})`, "run header in the log");
  assertIncludes(log, "Termination requested (SIGTERM); ending like quitting", "SIGTERM logged");
  assertIncludes(log, "=== Forkyard exited cleanly ===", "clean exit logged");
  assertEqual(crashFiles(dataDir), [], "no report");
  assert(!fs.existsSync(path.join(repo.path, ".git", "index.lock")), "no index.lock left behind");

  const again = await t.launch({ dataDir, lang: "en", theme: "light" });
  await again.openRepo(repo.path);
  await expectNoCrashDialog(again);
  assertEqual(await again.invoke("crash_reports_list", {}), [], "crash_reports_list empty after a clean end");
  await t.shot("sigterm-clean-restart");
  await t.noConsoleErrors(again);
}));

sc("SIGINT and SIGHUP end cleanly too; SIGABRT counts as a crash", "edge", withSetup(async (t, dataDir, repo) => {
  for (const signal of ["SIGINT", "SIGHUP"]) {
    const { app, pid } = await startWithRepo(t, dataDir, signal === "SIGINT" ? repo : null);
    if (signal === "SIGHUP") await expectNoCrashDialog(app, 1500);
    await endWith(app, pid, signal);
    assert(!fs.existsSync(markerPath(dataDir)), `marker removed on ${signal}`);
    assertIncludes(logText(dataDir), `Termination requested (${signal})`, `${signal} logged`);
    assertEqual(crashFiles(dataDir), [], `no report after ${signal}`);
  }
  const aborted = await crashedRun(t, dataDir, null, "SIGABRT");
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  const box = await waitDialog(app, TITLE);
  assertIncludes(box.text, "Unexpected exit", "SIGABRT reported as unexpected exit");
  assertEqual(reportFiles(dataDir).map((r) => r.runId), [aborted.runId], "one report, for the aborted run");
  await t.noConsoleErrors(app);
}));

sc("several reports: newest first with \"n of m\", Escape keeps the rest, palette reopens", "edge", withSetup(async (t, dataDir, repo) => {
  const older = writeReport(dataDir, { kind: "panic", timeMs: Date.now() - 3_600_000, message: "older panic: called `Option::unwrap()` on a `None` value" });
  const killed = await crashedRun(t, dataDir, repo);
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  // Newest first: the unexpected exit of the killed run, then the older panic.
  let box = await waitDialog(app, titleOf(1, 2));
  assertIncludes(box.text, "Unexpected exit", "first: newest report");
  // Keyboard: the focus starts on "View"; Enter opens it, Escape goes back.
  const focused = await app.exec(() => document.activeElement?.innerText.split("\n")[0].trim());
  assertEqual(focused, "View", "focus on the first safe option");
  await app.press("Enter");
  const { text } = await reportText(app);
  assertIncludes(text, `Run:      ${killed.runId}`, "Enter opened the newest report");
  await app.press("Escape");
  await waitDialog(app, titleOf(1, 2));
  await clickInDialog(app, "Discard");
  box = await waitDialog(app, titleOf(2, 2));
  assertIncludes(box.text, "older panic", "second: the older panic");
  await t.shot("several-reports");
  await app.press("Escape");
  await noDialog(app);
  assertEqual(reportFiles(dataDir).map((r) => r.runId), [older.runId], "the panic stays pending after Escape");
  // The palette offers what is left – now a single report.
  await paletteCrashReports(app);
  box = await waitDialog(app, TITLE);
  assertIncludes(box.text, "older panic", "palette shows the remaining report");
  await clickInDialog(app, "Cancel");
  await noDialog(app);
  assertEqual(reportFiles(dataDir).length, 1, "Cancel keeps it");
  await t.noConsoleErrors(app);
}));

sc("at most 10 reports are kept; the oldest are deleted on start", "edge", withSetup(async (t, dataDir) => {
  const base = Date.now() - 24 * 3_600_000;
  const written = Array.from({ length: 12 }, (_, i) => writeReport(dataDir, { kind: i % 2 ? "panic" : "unexpected_exit", timeMs: base + i * 60_000, message: `report number ${i + 1}` }));
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  const box = await waitDialog(app, titleOf(1, 10));
  assertIncludes(box.text, "report number 12", "newest first");
  const kept = reportFiles(dataDir).map((r) => r.id);
  assertEqual(kept.length, 10, "10 reports kept");
  assert(!kept.includes(written[0].id) && !kept.includes(written[1].id), "the two oldest were removed");
  assertEqual((await app.invoke("crash_reports_list", {})).length, 10, "list has 10");
  await clickInDialog(app, "Cancel");
  await noDialog(app);
  await t.noConsoleErrors(app);
}));

sc("unreadable files in the crash folder are ignored: no dialog, palette says none", "edge", withSetup(async (t, dataDir) => {
  fs.mkdirSync(crashDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(crashDir(dataDir), "20261014T120000123Z-deadbeef.json"), "{ not json");
  fs.writeFileSync(path.join(crashDir(dataDir), "bad id!.json"), JSON.stringify({ kind: "panic" }));
  fs.writeFileSync(path.join(crashDir(dataDir), "notes.txt"), "hello");
  const before = crashFiles(dataDir);
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  await expectNoCrashDialog(app);
  assertEqual(await app.invoke("crash_reports_list", {}), [], "nothing listed");
  await paletteCrashReports(app);
  await waitToast(app, "There are no crash reports.");
  assertEqual(crashFiles(dataDir), before, "foreign files are left alone");
  // A crafted id cannot leave the crash folder.
  const error = await app.invoke("crash_report_get", { id: "../forkyard.db" }).then(() => null, (e) => e);
  assert(error, "path-like id refused");
  assertEqual(error.code, "not_allowed", "error code for a path-like id");
  await t.noConsoleErrors(app);
}));

sc("save: cancelled, missing folder and a folder as target", "edge", withSetup(async (t, dataDir) => {
  writeReport(dataDir, { kind: "panic" });
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  await waitDialog(app, TITLE);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-crash-save-"));
  try {
    // Cancelled: nothing written, no toast, the choice is still there.
    await app.exec(() => { window.__gcTestSaves = [null]; });
    await clickInDialog(app, "Save…");
    await waitDialog(app, TITLE);
    await sleep(500);
    assertEqual((await toasts(app)).filter((x) => /saved|save/i.test(x.text)), [], "no toast after cancel");
    assertEqual(fs.readdirSync(outDir), [], "nothing written");
    // A folder that does not exist.
    await app.exec((p) => { window.__gcTestSaves = [p]; }, path.join(outDir, "missing", "report.txt"));
    await clickInDialog(app, "Save…");
    let toast = await waitToast(app, "Couldn’t save the crash report");
    assertEqual(toast.tone, "danger", "error tone");
    assertIncludes(toast.text, "doesn’t exist", "reason");
    await t.shot("save-missing-folder");
    // A folder as target.
    await waitDialog(app, TITLE);
    await app.exec((p) => { window.__gcTestSaves = [p]; }, outDir);
    await clickInDialog(app, "Save…");
    toast = await app.waitFor(async () => (await toasts(app)).find((x) => x.text.includes("is a folder")) ?? null, 8000, { message: "toast 'is a folder'" });
    assertEqual(fs.readdirSync(outDir), [], "still nothing written");
    await waitDialog(app, TITLE);
    assertEqual(reportFiles(dataDir).length, 1, "report kept");
    await t.noConsoleErrors(app);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}));

sc("report deleted on disk while the dialog is open: View says so, Discard still works", "edge", withSetup(async (t, dataDir) => {
  const report = writeReport(dataDir, { kind: "panic" });
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  await waitDialog(app, TITLE);
  fs.rmSync(path.join(crashDir(dataDir), `${report.id}.json`));
  await clickInDialog(app, "View");
  const toast = await waitToast(app, "Couldn’t read the crash reports");
  assertIncludes(toast.text, "no longer exists", "reason");
  await waitDialog(app, TITLE);
  await clickInDialog(app, "Discard");
  await waitToast(app, "Crash report deleted");
  await noDialog(app);
  await t.noConsoleErrors(app);
}));

sc("redaction: a password in a remote URL does not end up in the report", "edge", withSetup(async (t, dataDir, repo) => {
  const secret = "S3cretPassw0rd-e2e";
  git(repo.path, ["remote", "add", "leaky", `http://e2euser:${secret}@127.0.0.1:9/never.git`]);
  const { app, pid, repoId } = await startWithRepo(t, dataDir, repo);
  const fetchError = await app.invoke("fetch", { repoId, jobId: `e2e-${Date.now()}`, remote: "leaky", prune: false }).then(() => null, (e) => e);
  assert(fetchError, "fetch from an unreachable remote fails");
  assert(!JSON.stringify({ m: fetchError.message, g: fetchError.gitOutput }).includes(secret), "password in the fetch error");
  await app.settle(5000);
  await endWith(app, pid, "SIGKILL");
  // A panic report whose time window covers the killed run: its "Last Git calls" then hold the
  // fetch and the remote config with the URL (the unexpected-exit report would not – see the
  // scenario about Git calls after the last log line).
  const panic = writeReport(dataDir, { kind: "panic", timeMs: Date.now(), message: `panic while talking to http://e2euser:${secret}@127.0.0.1:9/never.git` });
  const again = await t.launch({ dataDir, lang: "en", theme: "light" });
  await waitDialog(again, titleOf(1, 2));
  const text = await again.invoke("crash_report_get", { id: panic.id });
  assertIncludes(text, "git fetch --progress -- leaky", "the fetch is among the last Git calls");
  assertMatch(text, /remote\.leaky\.url/, "the remote config (with the URL) is among the last Git calls");
  assert(!text.slice(text.indexOf("Last Git calls")).includes(secret), "password in the Git calls of the report");
  const unexpected = reportFiles(dataDir).find((r) => r.kind === "unexpected_exit");
  assert(unexpected, "unexpected-exit report of the killed run");
  const text2 = await again.invoke("crash_report_get", { id: unexpected.file.replace(/\.json$/, "") });
  assert(!text2.includes(secret), "password in the unexpected-exit report");
  assert(!fs.readFileSync(path.join(crashDir(dataDir), unexpected.file), "utf8").includes(secret), "password in the report file");
  assert(!logText(dataDir).includes(secret), "password in the log file");
  t.step("no password in the reports, the report file or the log");
  await t.noConsoleErrors(again);
}));

sc("unexpected exit: the report lists the Git calls made after the run's last log line", "edge", withSetup(async (t, dataDir, repo) => {
  // The killed run opens a repository (Git calls, few or no log lines) and then dies.
  const { app, pid, repoId } = await startWithRepo(t, dataDir, repo);
  await app.invoke("fetch", { repoId, jobId: `e2e-${Date.now()}`, remote: "origin", prune: false }).catch(() => undefined);
  await app.settle(5000);
  await endWith(app, pid, "SIGKILL");
  const again = await t.launch({ dataDir, lang: "en", theme: "light" });
  await waitDialog(again, TITLE);
  await clickInDialog(again, "View");
  const { text } = await reportText(again);
  await t.shot("unexpected-exit-git-calls");
  const calls = text.slice(text.indexOf("Last Git calls"));
  t.step(calls.split("\n").slice(0, 4).join(" | "));
  assertIncludes(calls, "git rev-parse --show-toplevel", "opening the repository is among the last Git calls");
  assertIncludes(calls, "git fetch --progress -- origin", "the fetch right before the crash is among the last Git calls");
}));

sc("German: the dialog and its options in German", "edge", withSetup(async (t, dataDir) => {
  writeReport(dataDir, { kind: "unexpected_exit", message: "Forkyard 1.0.0 ended without shutting down (run started 2026-10-14T10:00:00.000Z, last log line 2026-10-14T10:05:00.000Z)." });
  const app = await t.launch({ dataDir, lang: "de", theme: "light" });
  const box = await waitDialog(app, "Forkyard wurde beim letzten Mal unerwartet beendet");
  for (const label of ["Unerwartet beendet", "Ansehen", "Speichern…", "Verwerfen", "Es wird nichts verschickt"]) assertIncludes(box.text, label, "German text");
  await t.shot("german-dialog");
  await clickInDialog(app, "Ansehen");
  await waitDialog(app, "Absturzbericht");
  await t.noConsoleErrors(app);
}));

sc("dialog text: the report line is not followed by a doubled period", "edge", withSetup(async (t, dataDir) => {
  // The core's unexpected-exit message ends with "." and the dialog sentence adds another one.
  await crashedRun(t, dataDir, null);
  const app = await t.launch({ dataDir, lang: "en", theme: "light" });
  const box = await waitDialog(app, TITLE);
  await t.shot("dialog-double-period");
  assert(!/\)\.\. It contains/.test(box.text), `doubled period in the dialog: ${JSON.stringify(box.text.match(/.{40}\.\. It contains/)?.[0])}`);
}));
