/**
 * Update check in the real app: the core asks a local mock of the GitHub releases API instead of
 * api.github.com (FORKYARD_UPDATE_URL, debug builds only), the UI shows the result.
 *
 * - main: a newer release → hint in the status bar and one toast with version and notes;
 *   "View release" opens the release page (recorded, no browser starts);
 * - edge: manual check reports "You are up to date (<version>)";
 * - edge: setting off → not a single request on start; switching it on in Settings › About asks;
 * - edge: server error / offline → no toast on the automatic check, an error on the manual one;
 * - edge: a skipped version does not come back after a restart;
 * - edge: only a draft or prerelease exists (/releases/latest answers 404) → nothing reported.
 *
 *   node scripts/e2e-wd/features/updates.mjs
 *   E2E_WD_ONLY=skipped node scripts/e2e-wd/features/updates.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../driver.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const ROUTE = "/repos/abgebaumt/forkyard/releases/latest";
const CURRENT = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const NEWER = (() => {
  const [major, minor] = CURRENT.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
})();
const PAGE = (version) => `https://github.com/abgebaumt/forkyard/releases/tag/v${version}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `/releases/latest` as GitHub sends it. */
const release = (version, notes = "## Highlights\n\n- **Faster** commit graph\n- Update check in the status bar") => ({
  status: 200,
  body: { tag_name: `v${version}`, name: `Forkyard ${version}`, html_url: PAGE(version), body: notes, published_at: "2026-11-02T09:30:00Z", draft: false, prerelease: false },
});
const notFound = { status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com/rest/releases/releases#get-the-latest-release" } };

/** Local stand-in for api.github.com: records every request, answers with `answer()`. */
async function startMock(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const { status, body } = req.url === ROUTE ? answer() : notFound;
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    count: () => requests.filter((request) => request.url === ROUTE).length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A port nobody listens on. */
async function deadUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** Runs a scenario body and always runs the registered cleanups. */
const withCleanup = (fn) => async (t) => {
  t.cleanups = [];
  try {
    await fn(t);
  } finally {
    for (const cleanup of t.cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // best effort
      }
    }
  }
};

function persistentDataDir(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-updates-data-")));
  t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

const dialogTitle = (app) => app.exec(() => document.querySelector('[role="dialog"] h2, [role="alertdialog"] h2')?.textContent?.trim() ?? null);

/** Starts the app against `updateUrl`; on a restart the crash prompt (if the harness ended hard) is closed. */
async function launch(t, updateUrl, { restart = false, ...options } = {}) {
  const app = await t.launch({ ...LAUNCH, ...options, env: { FORKYARD_UPDATE_URL: updateUrl, ...(options.env ?? {}) } });
  if (restart) {
    const title = "Forkyard closed unexpectedly last time";
    if (await app.waitFor(async () => (await dialogTitle(app)) === title, 4000).catch(() => false)) {
      await app.click(await app.waitFor(() => app.byText("Cancel", { within: '[role="dialog"]' })));
    }
    for (const report of await app.invoke("crash_reports_list")) await app.invoke("crash_report_discard", { id: report.id });
  }
  // Links are recorded instead of opening a browser.
  await app.exec(() => {
    window.__gcTestOpened = [];
  });
  return app;
}

const toasts = (app, tone = null) =>
  app.exec((which) => [...document.querySelectorAll(which ? `[data-toast="${which}"]` : "[data-toast]")].map((el) => el.innerText.replace(/\s+/g, " ").trim()), tone);
async function waitToast(app, tone, pattern, timeout = 20_000) {
  return app.waitFor(async () => (await toasts(app, tone)).find((text) => pattern.test(text)) ?? null, timeout, {
    message: `${tone} toast ${pattern}; present: ${JSON.stringify(await toasts(app).catch(() => []))}`,
  });
}
const hint = (app) => app.exec(() => document.querySelector("[data-update-hint]")?.innerText.trim() ?? null);
const updateToasts = async (app) => (await toasts(app)).filter((text) => /is available/.test(text));

/** Waits until the mock saw `n` requests, then a little longer for the UI to react. */
async function waitRequests(app, mock, n) {
  await app.waitFor(async () => mock.count() >= n, 20_000, { message: `${n} request(s) at the mock, got ${mock.count()}` });
  await app.settle();
  await sleep(800);
}

/** Runs a command through the palette (Ctrl+P, ">text", click on the entry with that id). */
async function runCommand(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const find = () => app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` });
  for (let attempt = 0; ; attempt++) {
    try {
      await app.click(await find());
      break;
    } catch (error) {
      if (attempt >= 3 || !/stale element/i.test(String(error.message))) throw error;
      await app.settle(200);
    }
  }
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** Clicks the button with this text inside the toast that matches `pattern`. */
async function clickInToast(app, pattern, label) {
  const button = await app.waitFor(
    () =>
      app.exec(
        (source, wanted) => {
          const toast = [...document.querySelectorAll("[data-toast]")].find((el) => new RegExp(source).test(el.innerText));
          return [...(toast?.querySelectorAll("button") ?? [])].find((el) => el.innerText.trim() === wanted) ?? null;
        },
        pattern.source,
        label,
      ),
    10_000,
    { message: `button ${label} in toast ${pattern}` },
  );
  await app.click(button);
}

async function openAbout(app) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+,");
  await app.waitFor('[data-screen="settings"]', 10_000, { message: "settings dialog" });
  await app.click(await app.waitFor(() => app.byText("About", { within: '[data-screen="settings"] [role="tablist"]' }), 10_000, { message: "About tab" }));
  await app.waitFor("[data-update-status]", 10_000, { message: "updates card" });
  await app.settle();
}

// ---------------------------------------------------------------------------------------------

scenario("a newer release shows a hint and one toast; the toast opens the release page", "main", withCleanup(async (t) => {
  const mock = await startMock(() => release(NEWER));
  t.cleanups.push(() => mock.close());
  const app = await launch(t, mock.url);

  const text = await waitToast(app, "info", new RegExp(`Forkyard ${NEWER.replace(/\./g, "\\.")} is available`));
  assertIncludes(text, "Highlights · Faster commit graph · Update check in the status bar", "notes as plain text");
  assert(!/[#*]/.test(text), `no Markdown syntax in the toast: ${text}`);
  assertIncludes(text, "View release");
  assertIncludes(text, "Skip this version");
  await app.waitFor(async () => (await hint(app)) === `Forkyard ${NEWER} is available`, 10_000, { message: "status bar hint" });
  t.step("hint and toast shown");

  const [request] = mock.requests;
  assertEqual(mock.count(), 1, "one request on start");
  assertEqual(request.headers["user-agent"], `Forkyard/${CURRENT}`, "user agent");
  assertEqual(request.headers.accept, "application/vnd.github+json");
  assertEqual(request.headers.authorization, undefined, "no token");
  assertEqual(request.headers.cookie, undefined, "no cookie");
  await t.shot("update-available");

  await clickInToast(app, /is available/, "View release");
  const opened = await app.waitFor(() => app.exec(() => (window.__gcTestOpened?.length ? window.__gcTestOpened : null)), 10_000, { message: "release page opened" });
  assertEqual(opened, [PAGE(NEWER)], "the release page from the core");
  await app.waitFor(async () => (await updateToasts(app)).length === 0, 5000, { message: "toast closed after the click" });
  t.step("release page opened from the toast");

  // The hint stays and opens the page too.
  await app.click("[data-update-hint]");
  await app.waitFor(() => app.exec(() => window.__gcTestOpened.length === 2), 5000, { message: "opened from the hint" });
  assertEqual(await app.exec(() => window.__gcTestOpened[1]), PAGE(NEWER));
  assertEqual((await app.invoke("update_check", { manual: false })).notifiedVersion, NEWER, "seen once");
  assertEqual(mock.count(), 1, "the automatic check does not ask again the same day");
  await t.noConsoleErrors(app);
}));

scenario("a manual check reports up to date", "edge", withCleanup(async (t) => {
  const mock = await startMock(() => release(CURRENT));
  t.cleanups.push(() => mock.close());
  const app = await launch(t, mock.url);
  await waitRequests(app, mock, 1);
  assertEqual(await updateToasts(app), [], "nothing to report on start");
  assertEqual(await hint(app), null);

  await runCommand(app, "Check for updates", "app.checkForUpdates");
  await waitToast(app, "success", new RegExp(`You are up to date \\(${CURRENT.replace(/\./g, "\\.")}\\)`));
  assertEqual(mock.count(), 2, "the manual check always asks");
  await t.shot("up-to-date");

  // Also from Settings › About.
  await openAbout(app);
  const status = await app.exec(() => document.querySelector("[data-update-status]").innerText);
  assertMatch(status, /Last checked/);
  await app.click(await app.waitFor(() => app.byText("Check now", { within: "[data-update-status]" })));
  await app.waitFor(async () => mock.count() === 3, 10_000, { message: "check from the About section" });
  await t.noConsoleErrors(app);
}));

scenario("with the setting off no request is made on start", "edge", withCleanup(async (t) => {
  const mock = await startMock(() => release(NEWER));
  t.cleanups.push(() => mock.close());
  const dataDir = persistentDataDir(t);

  // First start without any update address: switch the setting off.
  let app = await launch(t, "off", { dataDir });
  await app.invoke("settings_set", { patch: { checkForUpdates: false } });
  await app.close();

  app = await launch(t, mock.url, { dataDir, restart: true });
  await app.settle();
  await sleep(4000);
  assertEqual(mock.count(), 0, "no request with the setting off");
  assertEqual(await hint(app), null);
  assertEqual(await updateToasts(app), []);
  t.step("no request on start");

  // Switching it on in Settings › About checks at once.
  await openAbout(app);
  const toggle = await app.waitFor(() => app.exec(() => document.querySelector("[data-update-status]")?.closest("section")?.querySelector('[role="switch"]') ?? null), 10_000, { message: "switch" });
  assertEqual(await toggle.attr("aria-checked"), "false");
  await t.shot("setting-off");
  await app.click(toggle);
  await app.waitFor(async () => mock.count() === 1, 15_000, { message: "a request after switching on" });
  assertEqual((await app.invoke("settings_get")).checkForUpdates, true);
  await app.waitFor(async () => (await hint(app)) === `Forkyard ${NEWER} is available`, 10_000, { message: "hint after switching on" });
  await t.noConsoleErrors(app);
}));

scenario("server error and offline stay quiet automatically and are shown on a manual check", "edge", withCleanup(async (t) => {
  const mock = await startMock(() => ({ status: 500, body: { message: "Server Error" } }));
  t.cleanups.push(() => mock.close());
  let app = await launch(t, mock.url, { ignoreErrors: [/update/i] });
  await waitRequests(app, mock, 1);
  assertEqual(await toasts(app), [], "no message after the automatic check");
  assertEqual(await hint(app), null);
  await runCommand(app, "Check for updates", "app.checkForUpdates");
  const error = await waitToast(app, "danger", /HTTP 500/);
  assertMatch(error, /Check for updates/);
  await t.shot("server-error");
  await app.close();

  app = await launch(t, await deadUrl(), { ignoreErrors: [/update/i] });
  await app.settle();
  await sleep(3000);
  assertEqual(await toasts(app), [], "offline: no message after the automatic check");
  await runCommand(app, "Check for updates", "app.checkForUpdates");
  await waitToast(app, "danger", /not reachable/);
  await t.shot("offline");
}));

scenario("a skipped version does not come back after a restart", "edge", withCleanup(async (t) => {
  const mock = await startMock(() => release(NEWER));
  t.cleanups.push(() => mock.close());
  const dataDir = persistentDataDir(t);

  let app = await launch(t, mock.url, { dataDir });
  await waitToast(app, "info", /is available/);
  await clickInToast(app, /is available/, "Skip this version");
  await app.waitFor(async () => (await hint(app)) === null, 10_000, { message: "hint gone after skipping" });
  assertEqual(await updateToasts(app), [], "toast closed");
  assertEqual((await app.invoke("update_check", { manual: false })).skippedVersion, NEWER);
  await app.close();

  app = await launch(t, mock.url, { dataDir, restart: true });
  await app.settle();
  await sleep(3000);
  assertEqual(await updateToasts(app), [], "no toast for the skipped version");
  assertEqual(await hint(app), null, "no hint for the skipped version");
  await t.shot("skipped-after-restart");
  await t.noConsoleErrors(app);
}));

scenario("only a draft or prerelease exists: nothing is reported", "edge", withCleanup(async (t) => {
  // GitHub's /releases/latest skips drafts and prereleases: with nothing else it answers 404.
  const mock = await startMock(() => notFound);
  t.cleanups.push(() => mock.close());
  const app = await launch(t, mock.url);
  await waitRequests(app, mock, 1);
  assertEqual(await toasts(app), [], "nothing on start");
  assertEqual(await hint(app), null);
  await runCommand(app, "Check for updates", "app.checkForUpdates");
  await waitToast(app, "success", /You are up to date/);
  await t.noConsoleErrors(app);
}));
