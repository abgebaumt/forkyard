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
 * Installing (Linux, AppImage): the updater plugin asks a local manifest (`FORKYARD_UPDATER_URL`) and
 * checks the download against a key made per run (`FORKYARD_UPDATER_PUBKEY`); `APPIMAGE` is a temp file
 * that the install replaces, the app does not restart (`FORKYARD_UPDATER_NO_RESTART`).
 *
 * - main: install from the toast: notes as Markdown, progress to 100 %, "Restart now" replaces the file;
 * - edge: a download signed with another key is refused, the file stays;
 * - edge: a package build (no AppImage) offers "View release" only and never asks for the manifest;
 * - edge: the manifest names another version than the notice → stale_state, the file stays;
 * - edge: "Restart now" asks about unsaved work in another window first; Cancel installs nothing;
 * - main/edge: "What's new" shows once per version, and not at all without highlights.
 *
 *   node e2e/features/updates.mjs
 *   E2E_WD_ONLY=skipped node e2e/features/updates.mjs
 */
import { execFileSync } from "node:child_process";
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
  body: {
    tag_name: `v${version}`,
    name: `Forkyard ${version}`,
    html_url: PAGE(version),
    body: notes,
    published_at: "2026-11-02T09:30:00Z",
    draft: false,
    prerelease: false,
  },
});
const notFound = {
  status: 404,
  body: { message: "Not Found", documentation_url: "https://docs.github.com/rest/releases/releases#get-the-latest-release" },
};

/** Local stand-in for api.github.com: records every request, answers with `answer()`. */
async function startMock(answer, extra = null) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    // `extra(req, res)`: the update manifest and the download; true = answered.
    if (extra?.(req, res)) return;
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
    countOf: (url) => requests.filter((request) => request.url === url).length,
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

const dialogTitle = (app) =>
  app.exec(() => document.querySelector('[role="dialog"] h2, [role="alertdialog"] h2')?.textContent?.trim() ?? null);

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
  app.exec(
    (which) =>
      [...document.querySelectorAll(which ? `[data-toast="${which}"]` : "[data-toast]")].map((el) =>
        el.innerText.replace(/\s+/g, " ").trim(),
      ),
    tone,
  );
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
  const find = () =>
    app.waitFor(
      () => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id),
      10_000,
      { message: `palette entry ${id}` },
    );
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
  await app.click(
    await app.waitFor(() => app.byText("About", { within: '[data-screen="settings"] [role="tablist"]' }), 10_000, { message: "About tab" }),
  );
  await app.waitFor("[data-update-status]", 10_000, { message: "updates card" });
  await app.settle();
}

// ---------------------------------------------------------------------------------------------

scenario(
  "a newer release shows a hint and one toast; the toast opens the release page",
  "main",
  withCleanup(async (t) => {
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
    const opened = await app.waitFor(() => app.exec(() => (window.__gcTestOpened?.length ? window.__gcTestOpened : null)), 10_000, {
      message: "release page opened",
    });
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
  }),
);

scenario(
  "a manual check reports up to date",
  "edge",
  withCleanup(async (t) => {
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
  }),
);

scenario(
  "with the setting off no request is made on start",
  "edge",
  withCleanup(async (t) => {
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
    const toggle = await app.waitFor(
      () => app.exec(() => document.querySelector("[data-update-status]")?.closest("section")?.querySelector('[role="switch"]') ?? null),
      10_000,
      { message: "switch" },
    );
    assertEqual(await toggle.attr("aria-checked"), "false");
    await t.shot("setting-off");
    await app.click(toggle);
    await app.waitFor(async () => mock.count() === 1, 15_000, { message: "a request after switching on" });
    assertEqual((await app.invoke("settings_get")).checkForUpdates, true);
    await app.waitFor(async () => (await hint(app)) === `Forkyard ${NEWER} is available`, 10_000, { message: "hint after switching on" });
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "server error and offline stay quiet automatically and are shown on a manual check",
  "edge",
  withCleanup(async (t) => {
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
  }),
);

scenario(
  "a skipped version does not come back after a restart",
  "edge",
  withCleanup(async (t) => {
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
  }),
);

scenario(
  "only a draft or prerelease exists: nothing is reported",
  "edge",
  withCleanup(async (t) => {
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
  }),
);

// --- Installing ------------------------------------------------------------------------------

const OLD_BYTES = Buffer.from("old AppImage, not yet replaced\n");
const eq = (a, b) => Buffer.compare(a, b) === 0;

/**
 * Per run, in a temp dir that is removed afterwards: a good and a bad signing key, the payload (a copy of
 * /bin/true) signed with `signWith`, and the file `APPIMAGE` points at. Keys never leave the temp dir.
 */
function makeUpdateFixture(t, { signWith = "good" } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-updater-")));
  t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const tauri = (...args) =>
    execFileSync("npx", ["tauri", ...args], { cwd: ROOT, stdio: "pipe", env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" } });
  for (const name of ["good", "bad"]) tauri("signer", "generate", "--ci", "-p", "", "-w", path.join(dir, `${name}.key`));
  const payloadPath = path.join(dir, `Forkyard_${NEWER}_amd64.AppImage`);
  fs.copyFileSync("/bin/true", payloadPath);
  tauri("signer", "sign", "-f", path.join(dir, `${signWith}.key`), "-p", "", payloadPath);
  const installDir = path.join(dir, "install");
  fs.mkdirSync(installDir);
  const appImage = path.join(installDir, "Forkyard.AppImage");
  fs.writeFileSync(appImage, OLD_BYTES, { mode: 0o755 });
  return {
    pubkey: fs.readFileSync(path.join(dir, "good.key.pub"), "utf8").trim(),
    signature: fs.readFileSync(`${payloadPath}.sig`, "utf8").trim(),
    payload: fs.readFileSync(payloadPath),
    appImage,
    unchanged: () => eq(fs.readFileSync(appImage), OLD_BYTES),
  };
}

/**
 * Mock of the updater endpoint: `/latest.json` (announcing `version`) and the download. With `hold`, the
 * download stops half way until `hold.open()` is called, so the progress can be watched.
 */
function updaterRoutes(fixture, { version = NEWER, hold = null } = {}) {
  let origin = "";
  const handler = (req, res) => {
    if (req.url === "/latest.json") {
      const text = JSON.stringify({
        version,
        notes: "Signed update.",
        pub_date: "2026-11-02T09:30:00Z",
        platforms: { "linux-x86_64": { signature: fixture.signature, url: `${origin}/Forkyard.AppImage` } },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
      return true;
    }
    if (req.url === "/Forkyard.AppImage") {
      const half = Math.floor(fixture.payload.length / 2);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fixture.payload.length });
      if (!hold) return (res.end(fixture.payload), true);
      res.write(fixture.payload.subarray(0, half));
      void hold.promise.then(() => res.end(fixture.payload.subarray(half)));
      return true;
    }
    return false;
  };
  return { handler, setOrigin: (url) => (origin = url) };
}

const gate = () => {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** Starts mock + app for an install scenario; `appImage: false` = a package build (no APPIMAGE). */
async function launchInstaller(t, fixture, { release: notice = release(NEWER), version, hold, appImage = true, ...options } = {}) {
  const routes = updaterRoutes(fixture, { version, hold });
  const mock = await startMock(() => notice, routes.handler);
  routes.setOrigin(mock.url);
  t.cleanups.push(() => mock.close());
  const env = {
    FORKYARD_UPDATER_URL: `${mock.url}/latest.json`,
    FORKYARD_UPDATER_PUBKEY: fixture.pubkey,
    FORKYARD_UPDATER_NO_RESTART: "1",
    APPIMAGE: appImage ? fixture.appImage : "",
    ...(options.env ?? {}),
  };
  const app = await launch(t, mock.url, { ...options, env, ignoreErrors: [/update/i, /signature/i] });
  return { app, mock };
}

const updateDialogPhase = (app) =>
  app.exec(() => document.querySelector("[data-update-dialog]")?.getAttribute("data-update-dialog") ?? null);
const waitPhase = (app, phase, timeout = 20_000) =>
  app.waitFor(async () => (await updateDialogPhase(app)) === phase, timeout, { message: `update dialog phase ${phase}` });
const dialogButton = (app, text) =>
  app.waitFor(() => app.byText(text, { within: '[role="dialog"]' }), 10_000, { message: `dialog button ${text}` });
const dialogText = (app) => app.exec(() => document.querySelector('[role="dialog"]')?.innerText.replace(/\s+/g, " ").trim() ?? "");
const opened = (app) => app.exec(() => window.__gcTestOpened ?? []);

/** Toast "Install…" → the dialog in its ready phase. */
async function openInstallDialog(app) {
  await waitToast(app, "info", /is available/);
  await clickInToast(app, /is available/, "Install…");
  await waitPhase(app, "ready");
}

scenario(
  "install an update from the toast: notes, progress, restart replaces the file",
  "main",
  withCleanup(async (t) => {
    const fixture = makeUpdateFixture(t);
    const hold = gate();
    const { app, mock } = await launchInstaller(t, fixture, {
      hold,
      release: release(NEWER, "## Highlights\n\n- **Faster** commit graph\n- Signed updates"),
    });
    await openInstallDialog(app);
    assertEqual(await dialogTitle(app), `Forkyard ${NEWER}`);
    const rendered = await app.exec(() => {
      const root = document.querySelector("[data-update-dialog]");
      return {
        heading: [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((el) => el.innerText.trim()),
        strong: [...root.querySelectorAll("strong,b")].map((el) => el.innerText.trim()),
        text: root.innerText,
      };
    });
    assertIncludes(rendered.heading, "Highlights", "heading rendered");
    assertIncludes(rendered.strong, "Faster", "bold rendered");
    assert(!rendered.text.includes("**") && !rendered.text.includes("##"), `no raw Markdown: ${rendered.text}`);
    assertEqual(mock.countOf("/latest.json"), 0, "nothing is downloaded before the click");
    await t.shot("update-dialog-notes");

    await app.exec(() => {
      window.__fyPercent = [];
      new MutationObserver(() => {
        const bar = document.querySelector('[role="progressbar"]');
        if (bar) window.__fyPercent.push(Number(bar.getAttribute("aria-valuenow")));
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    await app.click(await dialogButton(app, "Install"));
    await waitPhase(app, "downloading");
    await app.waitFor(
      () => app.exec(() => (Number(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")) || 0) > 0),
      15_000,
      { message: "progress while the download is held half way" },
    );
    assertEqual(await updateDialogPhase(app), "downloading", "still downloading while held");
    assert(fixture.unchanged(), "nothing replaced during the download");
    hold.open();
    await waitPhase(app, "downloaded");
    assertEqual(Math.max(...(await app.exec(() => window.__fyPercent))), 100, "progress reached 100 %");
    assert(fixture.unchanged(), "nothing replaced before 'Restart now'");
    assertIncludes(await dialogText(app), "Downloaded and checked");
    await t.shot("update-downloaded");

    await app.click(await dialogButton(app, "Restart now"));
    await app.waitFor(async () => eq(fs.readFileSync(fixture.appImage), fixture.payload), 20_000, {
      message: "APPIMAGE replaced by the payload",
    });
    t.step("file replaced, app kept running (no restart in the test)");
  }),
);

scenario(
  "an update signed with another key is refused and nothing is replaced",
  "edge",
  withCleanup(async (t) => {
    const fixture = makeUpdateFixture(t, { signWith: "bad" });
    const { app } = await launchInstaller(t, fixture);
    await openInstallDialog(app);
    await app.click(await dialogButton(app, "Install"));
    await waitPhase(app, "error");
    // The plugin's own message, then the hint of `update_signature_invalid`.
    const text = await dialogText(app);
    assertIncludes(text, "The update could not be installed");
    assertIncludes(text, "signature");
    assertIncludes(text, "Download the release from the release page instead.");
    await app.click(await dialogButton(app, "Open release page"));
    assertEqual(await app.waitFor(async () => ((await opened(app)).length ? opened(app) : null), 10_000), [PAGE(NEWER)]);
    assert(fixture.unchanged(), "APPIMAGE untouched");
    await t.shot("update-wrong-key");
  }),
);

scenario(
  "a package build offers only the release page and never asks for the manifest",
  "edge",
  withCleanup(async (t) => {
    const fixture = makeUpdateFixture(t);
    const { app, mock } = await launchInstaller(t, fixture, { appImage: false });
    const toast = await waitToast(app, "info", /is available/);
    assertIncludes(toast, "View release");
    assert(!toast.includes("Install"), `no Install in the toast: ${toast}`);
    await app.waitFor(async () => (await hint(app)) === `Forkyard ${NEWER} is available`, 10_000, { message: "status bar hint" });
    await app.click("[data-update-hint]");
    assertEqual(
      await app.waitFor(async () => ((await opened(app)).length ? opened(app) : null), 10_000),
      [PAGE(NEWER)],
      "hint opens the page",
    );
    assertEqual(await dialogTitle(app), null, "no install dialog");
    assertEqual(mock.countOf("/latest.json"), 0, "the manifest is not requested");
    assert(fixture.unchanged());
  }),
);

scenario(
  "the manifest names another version than the notice: stale state, nothing replaced",
  "edge",
  withCleanup(async (t) => {
    const fixture = makeUpdateFixture(t);
    const { app } = await launchInstaller(t, fixture, { version: NEWER.replace(/\d+$/, "1") });
    await openInstallDialog(app);
    await app.click(await dialogButton(app, "Install"));
    await waitPhase(app, "error");
    assertIncludes(await dialogText(app), "The release changed since the last check.");
    assert(fixture.unchanged(), "APPIMAGE untouched");
  }),
);

scenario(
  "Restart now asks about unsaved work in another window first",
  "edge",
  withCleanup(async (t) => {
    const fixture = makeUpdateFixture(t);
    const { app } = await launchInstaller(t, fixture);
    await openInstallDialog(app);
    await app.click(await dialogButton(app, "Install"));
    await waitPhase(app, "downloaded");

    // The second window has something to lose (as unsaved text reports it).
    const main = await app.exec(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
    const second = await app.invoke("window_new");
    const into = (wanted) =>
      app.waitFor(
        async () => {
          for (const handle of await app.windowHandles()) {
            await app.switchToWindow(handle);
            if ((await app.exec(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label).catch(() => null)) === wanted) return true;
          }
          return null;
        },
        15_000,
        { message: `window ${wanted}` },
      );
    await into(second);
    await app.waitForShell(30_000);
    await app.exec(() => window.__TAURI_INTERNALS__.invoke("app_close_guard", { active: true }));
    await into(main);
    await app.waitForShell(30_000);

    await app.click(await dialogButton(app, "Restart now"));
    const prompt = await app.waitFor(
      () =>
        app.exec(
          () =>
            [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((el) => /other window/.test(el.innerText)) ?? null,
        ),
      10_000,
      { message: "the close guard names the other window" },
    );
    assertIncludes(await app.exec((el) => el.innerText, prompt), "1 other window has unsaved work");
    await app.click(
      await app.waitFor(
        () => app.exec((el) => [...el.querySelectorAll("button")].find((button) => button.innerText.trim() === "Cancel") ?? null, prompt),
        10_000,
        { message: "Cancel in the close guard" },
      ),
    );
    await app.waitFor(() => app.exec(() => !/other window/.test(document.body.innerText)), 10_000, { message: "prompt closed" });
    assert(fixture.unchanged(), "APPIMAGE unchanged after Cancel");
    // The guard's question needs the stage to itself, so the dialog comes back where it was.
    await waitPhase(app, "downloaded");
    await dialogButton(app, "Restart now");
  }),
);

// --- What's new --------------------------------------------------------------------------------

const whatsNewTitle = async (app) => {
  const title = await dialogTitle(app);
  return title?.startsWith("What's new") ? title : null;
};

scenario(
  "What's new shows once per version",
  "main",
  withCleanup(async (t) => {
    const dataDir = persistentDataDir(t);
    const version = (v) => ({ dataDir, env: { FORKYARD_APP_VERSION: v } });

    let app = await launch(t, "off", version("1.2.9"));
    await app.settle();
    assertEqual(await whatsNewTitle(app), null, "a fresh installation shows nothing");
    await app.close();

    app = await launch(t, "off", { ...version("1.3.0"), restart: true });
    await app.waitFor(async () => (await whatsNewTitle(app)) === "What's new in Forkyard 1.3.0", 20_000, {
      message: "the What's new dialog",
    });
    assertEqual(await app.exec(() => [...document.querySelectorAll('[role="dialog"] li')].length), 6, "the 1.3.0 highlights");
    await t.shot("whats-new");
    await app.click(await dialogButton(app, "Let's go"));
    await app.waitFor(async () => (await dialogTitle(app)) === null, 10_000, { message: "dialog closed" });
    await app.close();

    app = await launch(t, "off", { ...version("1.3.0"), restart: true });
    await app.settle();
    assertEqual(await whatsNewTitle(app), null, "not shown a second time");
  }),
);

scenario(
  "What's new stays away for a version without highlights",
  "edge",
  withCleanup(async (t) => {
    const dataDir = persistentDataDir(t);
    let app = await launch(t, "off", { dataDir, env: { FORKYARD_APP_VERSION: "1.2.9" } });
    await app.settle();
    await app.close();
    app = await launch(t, "off", { dataDir, restart: true, env: { FORKYARD_APP_VERSION: "1.3.7" } });
    await app.settle();
    assertEqual(await whatsNewTitle(app), null, "no highlights for 1.3.7, no dialog");
  }),
);
