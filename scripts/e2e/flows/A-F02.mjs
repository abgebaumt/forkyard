/**
 * F02 – clone a repository: the cases no script under scripts/e2e/screens/ checks yet. Real app;
 * sources are local bare repositories (path, file://) and a local Git server over HTTP
 * (scripts/e2e/git-http-server.mjs), optionally behind a slow or silent proxy. No external service
 * is contacted.
 *
 *   node scripts/e2e/flows/A-F02.mjs [--show] [--only <part>[,<part>]] [--quick]
 *
 * --quick skips the section that waits two minutes for the timeout (F02-E13b).
 *
 * Already covered elsewhere and NOT repeated here: address detection and validation, cloning with the
 * keyboard only, shallow/branch/sparse, progress and cancel, target taken, source/branch/target folder
 * missing, closed port, 960×600 (clone.mjs); HTTPS with sign-in, wrong and changed password, remember
 * (mustfix-https.mjs); SSH with host key (mustfix-ssh.mjs); offer to initialize submodules after
 * cloning (submodules.mjs).
 *
 * Every section carries the number of its case. A red section marked "BUG A-…" is the test that
 * verifies the fix of the reported bug. At the end comes the list: green / red.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeLargeRepo } from "../fixtures.mjs";
import { startGitHttpServer } from "../git-http-server.mjs";
import { makeWorkspace } from "../screens/repo-entry-lib.mjs";
import { activeTab, checkA11y, closeRepoTabs, createFlowRun, denyWrite, fileUrl, gitProcessesWith, killProcesses, requestWindowClose, showManagement, sleep, startBlackHole, startSlowProxy } from "./A-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const quick = argv.includes("--quick");
const t = createFlowRun("A-F02", { argv });
const { check, equal, eventually, note, section } = t;

const USER = "lena";
const PASSWORD = "Sonnen-Sensor-42";

const repoManagementScreen = '[data-screen="repo-management"]';
const ws = makeWorkspace("a-f02");
const large = makeLargeRepo();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-a-f02-data-"));
const undo = [];

// Source: five commits, two folders, one file with an umlaut in its name.
const work = ws.repo("wetterdaten", { "README.md": "# Wetterdaten\n\nMesswerte der Station.\n", "src/lesen.py": "print('lesen')\n", "docs/Größen.md": "# Größen\n" });
ws.commit(work, "src/lesen.py", "print('lesen, Fassung 2')\n", "Lesen überarbeitet", "2026-01-10T12:00:00+01:00");
ws.commit(work, "docs/aufbau.md", "# Aufbau\n\nMast und Logger.\n", "Aufbau beschrieben", "2026-02-10T12:00:00+01:00");
ws.commit(work, "src/pruefen.py", "print('prüfen')\n", "Prüfung ergänzt", "2026-03-10T12:00:00+01:00");
const source = ws.at("wetterdaten.git");
ws.git(ws.root, "clone", "-q", "--bare", work, source);
const sourceHead = ws.git(source, "rev-parse", "main");
const sourceCommits = Number(ws.git(source, "rev-list", "--count", "main"));
const target = ws.dir("Ziel");

const server = await startGitHttpServer({ users: { [USER]: PASSWORD } });
server.createBare("wetterdaten.git", { from: work });
server.createBare("gross.git", { from: large.path });

let app = null;
let page = null;
const proxies = [];

const form = () => page.locator('[data-screen="clone"]');
const field = (label) => form().getByLabel(label, { exact: true });
const invalid = (label) => field(label).getAttribute("aria-invalid");
const errorOf = (label) => field(label).evaluate((input) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
const startButton = () => page.getByRole("button", { name: "Clone", exact: true });
const banner = () => form().locator("[data-clone-error]");
const bannerCode = async () => ((await banner().count()) ? banner().getAttribute("data-clone-error") : null);
const bannerText = async () => ((await banner().count()) ? (await banner().innerText()).replace(/\s+/g, " ") : "");
const tabs = () => app.invoke("tabs_list");
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const openDialog = async () => {
  await showManagement(app);
  await page.locator(repoManagementScreen).getByRole("button", { name: "Clone …" }).click();
  await form().waitFor();
};
const cloned = async (dir) => {
  const tab = await activeTab(app);
  return tab?.kind === "repo" && samePath(tab.path, dir);
};
const waitCloned = async (dir, what, timeoutMs = 90_000) => {
  await eventually(() => cloned(dir), true, `${what}: the clone's tab is active`, timeoutMs);
  await form().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  await app.settle().catch(() => undefined);
  return activeTab(app);
};
/** Answers the username and password prompts until `done()` is true. Returns the number of prompts. */
const answerCredentials = async (done, { user = USER, password = PASSWORD, timeoutMs = 120_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let asked = 0;
  while (Date.now() < deadline) {
    if (await done()) return asked;
    const title = await t.dialogTitle();
    if (title === "Username for the remote" || title === "Sign in to the remote") {
      asked += 1;
      await page.keyboard.type(title === "Username for the remote" ? user : password);
      await page.keyboard.press("Enter");
      const gone = Date.now() + 8000;
      while (Date.now() < gone && (await t.dialogTitle()) === title) await sleep(80);
    }
    await sleep(120);
  }
  check(false, "timeout while waiting for the clone to finish (prompts answered)");
  return asked;
};
const activity = async () => {
  const logs = [await app.invoke("activity_list", { scope: "app", repoId: null, cursor: null, limit: 200 })];
  for (const repo of await app.invoke("repo_list")) logs.push(await app.invoke("activity_list", { scope: "repo", repoId: repo.id, cursor: null, limit: 200 }));
  return logs.flatMap((log) => log.entries ?? []);
};
const jobs = () => page.evaluate(() => Object.keys(window.__gc.store.getState().jobs).length);
const slowUrl = (proxy, name, { user = null } = {}) => `http://${user ? `${user}@` : ""}127.0.0.1:${proxy.port}/${name}`;

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir });
  page = app.page;
  t.attach(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });

  // -------------------------------------------------------------------------------------------
  await section("F02-H1 Happy path with the mouse (file://): address, browse, clone – result checked with git", async () => {
    await openDialog();
    await field("Address").fill(fileUrl(source));
    await app.pick(target);
    await form().getByRole("button", { name: "Browse …" }).click();
    await eventually(() => field("Target folder").inputValue(), target, "\"Browse …\" fills in the target folder");
    equal(await field("Folder name").inputValue(), "wetterdaten", "the folder name is suggested from the address");
    await startButton().click();
    const dir = path.join(target, "wetterdaten");
    await waitCloned(dir, "clone");
    equal(ws.git(dir, "rev-parse", "HEAD"), sourceHead, "HEAD of the clone = main of the source");
    equal(Number(ws.git(dir, "rev-list", "--count", "HEAD")), sourceCommits, "all commits are there");
    equal(ws.git(dir, "remote", "get-url", "origin"), fileUrl(source), "origin is the address entered");
    equal(ws.git(dir, "status", "--porcelain"), "", "the working directory is clean");
    equal(fs.readFileSync(path.join(dir, "docs", "Größen.md"), "utf8"), "# Größen\n", "the file with an umlaut in its name is checked out");
    await page.locator('[data-screen="commit-graph"][data-state="ready"] [data-row-kind="commit"]').first().waitFor({ timeout: 20_000 });
    equal(await page.locator('[data-screen="commit-graph"] [data-row-kind="commit"]').count(), sourceCommits, "the graph shows the clone's commits");
    await t.waitToast(/“wetterdaten” has been cloned/, "success");
    equal(await jobs(), 0, "no job is left hanging");
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E3b Target folder exists and is empty: the clone is created inside it", async () => {
    const dir = path.join(target, "schon-da");
    fs.mkdirSync(dir);
    await openDialog();
    await field("Address").fill(source);
    await field("Target folder").fill(target);
    await field("Folder name").fill("schon-da");
    equal(await invalid("Folder name"), null, "an empty existing folder is not an error");
    await startButton().click();
    await waitCloned(dir, "empty folder");
    equal(ws.git(dir, "rev-parse", "HEAD"), sourceHead, "the clone is in the existing folder");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E8 Emoji, umlauts and spaces in source, target folder and folder name", async () => {
    const odd = ws.dir("Quelle Süd 🌍 & Co");
    const oddSource = path.join(odd, "wetter daten (Süd).git");
    ws.git(ws.root, "clone", "-q", "--bare", work, oddSource);
    const oddTarget = ws.dir("Ziel Größe 🚀");
    const name = "Klon Maße 🌦";
    // 1. as a local path
    await openDialog();
    await field("Address").fill(oddSource);
    equal([await invalid("Address"), await form().locator("[data-url-kind]").getAttribute("data-url-kind"), await field("Folder name").inputValue()], [null, "local", "wetter daten (Süd)"], "path with spaces, umlauts and emoji is detected as a local folder, name suggested");
    await field("Target folder").fill(oddTarget);
    await field("Folder name").fill(name);
    equal(await invalid("Folder name"), null, "the folder name with emoji is valid");
    equal((await form().locator("[data-clone-target]").innerText()).replace(/\s+/g, " "), `Will be cloned to: ${path.join(oddTarget, name)}`, "the preview shows the target intact");
    await startButton().click();
    const dir = path.join(oddTarget, name);
    const tab = await waitCloned(dir, "emoji path");
    equal(ws.git(dir, "rev-parse", "HEAD"), sourceHead, "the clone is complete");
    equal(path.resolve(ws.git(dir, "remote", "get-url", "origin")).toLowerCase(), oddSource.toLowerCase(), "origin points to the source with special characters");
    equal(await page.locator(`[data-tab-id="${tab.id}"] [role="tab"]`).evaluate((node) => node.textContent.trim()), name, "the tab shows the name");
    await t.closeToasts();
    // 2. as a file:// URL with %20
    await openDialog();
    const encoded = `file:///${oddSource.replaceAll("\\", "/").split("/").map((part, index) => (index === 0 ? part : encodeURIComponent(part))).join("/")}`;
    await field("Address").fill(encoded);
    equal(await field("Folder name").inputValue(), "wetter daten (Süd)", "the readable name is suggested from the encoded address");
    await field("Target folder").fill(oddTarget);
    await startButton().click();
    const second = path.join(oddTarget, "wetter daten (Süd)");
    await waitCloned(second, "encoded file:// URL");
    equal(ws.git(second, "rev-parse", "HEAD"), sourceHead, "this clone is complete too");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E7a Long input: 64-character folder name, 500-character address – nothing overflows", async () => {
    const name = "messreihen-archiv-der-wetterstation-nord-mit-allen-rohdaten-2026";
    equal(name.length, 64, "name length");
    await openDialog();
    await field("Address").fill(source);
    await field("Target folder").fill(target);
    await field("Folder name").fill(name);
    await app.setSize(960, 600);
    await sleep(250);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no page overflow");
    const fit = await form().locator("[data-clone-target]").evaluate((node) => ({ inside: node.getBoundingClientRect().right <= node.closest('[role="dialog"]').getBoundingClientRect().right, overflow: node.scrollWidth - node.clientWidth }));
    check(fit.inside && fit.overflow <= 1, `the target preview stays inside the dialog (${JSON.stringify(fit)})`);
    await app.setSize(1440, 900);
    await startButton().click();
    const dir = path.join(target, name);
    await waitCloned(dir, "long name");
    equal(ws.git(dir, "rev-parse", "HEAD"), sourceHead, "the clone with a long name is complete");
    await t.closeToasts();

    // 500-character address to a closed port: badge, progress and error stay inside the dialog.
    const longUrl = `http://127.0.0.1:9/${"abteilung-messtechnik/".repeat(30)}`.slice(0, 496) + ".git";
    equal(longUrl.length, 500, "address length");
    await openDialog();
    await field("Address").fill(longUrl);
    equal(await invalid("Address"), null, "the long address is valid");
    await field("Target folder").fill(target);
    await field("Folder name").fill("lange-adresse");
    await app.setSize(960, 600);
    await sleep(250);
    const inDialog = async (where) => {
      equal(await t.overflow(), { x: 0, y: 0 }, `${where}: no page overflow`);
      const box = await page.locator('[role="dialog"]').last().boundingBox();
      check(box.x >= 0 && box.x + box.width <= 960 && box.y >= 0 && box.y + box.height <= 600, `${where}: the dialog lies inside the window (${JSON.stringify(box)})`);
      const wide = await page.locator('[role="dialog"]').last().evaluate((dialog) => Array.from(dialog.querySelectorAll("*")).filter((node) => node.getBoundingClientRect().right > dialog.getBoundingClientRect().right + 1).length);
      equal(wide, 0, `${where}: no element sticks out of the dialog`);
    };
    await inDialog("form with a 500-character address");
    await startButton().click();
    await eventually(bannerCode, "offline", "closed port: error in the dialog", 60_000);
    await inDialog("error with a 500-character address");
    equal(await field("Address").inputValue(), longUrl, "the address is unchanged");
    await app.setSize(1440, 900);
    await page.keyboard.press("Escape");
    await form().waitFor({ state: "detached" });
    app.consoleErrors.length = 0;
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E7b Very long folder name (255 and 500 characters): clear refusal, nothing left behind", async () => {
    // BUG A-05: the refusal is a raw system error that does not mention the length.
    for (const length of [255, 500]) {
      const name = `lang-${"x".repeat(length - 5)}`;
      const before = fs.readdirSync(target).length;
      await openDialog();
      await field("Address").fill(source);
      await field("Target folder").fill(target);
      await field("Folder name").fill(name);
      const typed = await invalid("Folder name");
      await startButton().click();
      await eventually(async () => (await bannerCode()) !== null || (await invalid("Folder name")) === "true" || (await cloned(path.join(target, name))), true, `${length} characters: the app answers`, 60_000);
      const text = `${(await invalid("Folder name")) === "true" ? ((await errorOf("Folder name")) ?? "") : ""} ${await bannerText()}`.trim();
      note(`${length} characters: marked while typing: ${typed}; after submitting [${await bannerCode()}]: ${text}`);
      if (await cloned(path.join(target, name))) {
        equal(ws.git(path.join(target, name), "rev-parse", "HEAD"), sourceHead, `${length} characters: the clone is complete`);
        continue;
      }
      check(/too long|length|at most \d+ characters/i.test(text), `${length} characters: the refusal gives the length as the reason: "${text}"`);
      check(!/os error|\(code \d+\)/i.test(text), `${length} characters: no raw system error in the text`);
      equal(fs.readdirSync(target).length, before, `${length} characters: nothing was left in the target folder`);
      equal(await t.overflow(), { x: 0, y: 0 }, `${length} characters: no page overflow`);
      await page.keyboard.press("Escape");
      await form().waitFor({ state: "detached" });
    }
    app.consoleErrors.length = 0;
  }, { bug: "A-05" });

  // -------------------------------------------------------------------------------------------
  await section("F02-E9 Double Enter and double click on \"Clone\": exactly one clone, no error", async () => {
    const countClones = async (dir) => (await activity()).filter((entry) => /^git clone/.test(entry.command) && entry.command.toLowerCase().includes(path.basename(dir).toLowerCase())).length;
    // Double Enter, without a pause
    await openDialog();
    await field("Target folder").fill(target);
    await field("Address").fill(fileUrl(large.path));
    await field("Folder name").fill("doppelt-enter");
    await field("Address").focus();
    await Promise.all([page.keyboard.press("Enter"), page.keyboard.press("Enter")]);
    const first = path.join(target, "doppelt-enter");
    await waitCloned(first, "double Enter", 180_000);
    await sleep(800);
    equal(await countClones(first), 1, "double Enter: exactly one git clone in the log");
    equal(ws.git(first, "rev-parse", "HEAD"), ws.git(large.path, "rev-parse", "HEAD"), "double Enter: the clone is complete");
    equal(ws.git(first, "status", "--porcelain"), "", "double Enter: the working directory is clean");
    equal((await t.toasts()).filter((toast) => toast.tone !== "success"), [], "double Enter: no error toast");
    equal(await page.locator('[role="dialog"]').count(), 0, "double Enter: no dialog stays open");
    equal(await jobs(), 0, "double Enter: no job is left hanging");
    await t.closeToasts();
    // Double click on the button
    await openDialog();
    await field("Address").fill(fileUrl(large.path));
    await field("Folder name").fill("doppelt-klick");
    await startButton().dblclick();
    const second = path.join(target, "doppelt-klick");
    await waitCloned(second, "double click", 180_000);
    await sleep(800);
    equal(await countClones(second), 1, "double click: exactly one git clone in the log");
    equal(ws.git(second, "rev-parse", "HEAD"), ws.git(large.path, "rev-parse", "HEAD"), "double click: the clone is complete (the second click did not cancel it)");
    equal((await t.toasts()).filter((toast) => toast.tone !== "success"), [], "double click: no error toast");
    equal(await jobs(), 0, "double click: no job is left hanging");
    await closeRepoTabs(app);
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E5b \"Clone submodules too\": the submodules are fetched after cloning", async () => {
    // Git accepts local sources for submodules only with protocol.file.allow=always – as a user with local mirrors would set it.
    const original = fs.readFileSync(app.gitConfigPath, "utf8");
    fs.writeFileSync(app.gitConfigPath, `${original}[protocol "file"]\n\tallow = always\n`);
    try {
      const lib = ws.repo("bibliothek", { "lib.py": "def wert():\n    return 42\n" });
      const libBare = ws.at("bibliothek.git");
      ws.git(ws.root, "clone", "-q", "--bare", lib, libBare);
      const main = ws.repo("hauptprojekt", { "README.md": "# Hauptprojekt\n" });
      ws.git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", fileUrl(libBare), "libs/bibliothek");
      ws.git(main, "commit", "-q", "-m", "Bibliothek als Submodul");
      const mainBare = ws.at("hauptprojekt.git");
      ws.git(ws.root, "clone", "-q", "--bare", main, mainBare);
      await openDialog();
      await field("Address").fill(fileUrl(mainBare));
      await field("Target folder").fill(target);
      await form().getByRole("button", { name: /Advanced options/ }).click();
      const box = form().getByRole("checkbox", { name: "Clone submodules too" });
      equal(await box.getAttribute("aria-checked"), "false", "\"Clone submodules too\" is off initially");
      await box.click();
      await startButton().click();
      const dir = path.join(target, "hauptprojekt");
      await waitCloned(dir, "with submodules");
      const status = ws.git(dir, "submodule", "status");
      check(/^ [0-9a-f]{40} libs\/bibliothek/.test(` ${status.trimStart()}`) && !status.trimStart().startsWith("-"), `git submodule status: the submodule is fetched (${JSON.stringify(status)})`);
      equal(fs.readFileSync(path.join(dir, "libs", "bibliothek", "lib.py"), "utf8"), "def wert():\n    return 42\n", "the submodule's file is checked out");
      await sleep(1500);
      equal((await t.toasts()).filter((toast) => /not been fetched yet/.test(toast.text)), [], "no offer to initialize submodules – they are already there");
      equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
    } finally {
      fs.writeFileSync(app.gitConfigPath, original);
    }
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E21 \"Commits since\" at the day boundary: all commits of the cut-off day are included", async () => {
    // BUG A-07: Git completes a date without time with the CURRENT time – commits of the cut-off day before "now" are missing.
    const dated = ws.repo("stichtag", { "README.md": "# Stichtag\n" });
    const offset = (date) => {
      const minutes = -date.getTimezoneOffset();
      const pad = (value) => String(Math.abs(value)).padStart(2, "0");
      return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
    };
    const local = (iso) => `${iso}${offset(new Date(iso))}`;
    ws.commit(dated, "a.txt", "a\n", "Vortag, 23:59", local("2026-01-31T23:59:00"));
    ws.commit(dated, "b.txt", "b\n", "Stichtag, 00:00:30", local("2026-02-01T00:00:30"));
    ws.commit(dated, "c.txt", "c\n", "Stichtag, 12:00", local("2026-02-01T12:00:00"));
    ws.commit(dated, "d.txt", "d\n", "Stichtag, 23:59", local("2026-02-01T23:59:00"));
    ws.commit(dated, "e.txt", "e\n", "Folgetag", local("2026-02-02T08:00:00"));
    const datedBare = ws.at("stichtag.git");
    ws.git(ws.root, "clone", "-q", "--bare", dated, datedBare);
    await openDialog();
    await field("Address").fill(fileUrl(datedBare));
    await field("Target folder").fill(target);
    await form().getByRole("button", { name: /Advanced options/ }).click();
    await form().getByRole("checkbox", { name: /Shallow clone/ }).click();
    await form().locator('[aria-label="Limit history by"]').getByText("Date", { exact: true }).click();
    await field("Commits since").fill("2026-02-01");
    await startButton().click();
    const dir = path.join(target, "stichtag");
    await waitCloned(dir, "since date");
    const subjects = ws.git(dir, "log", "--format=%s").split("\n");
    note(`fetched at ${new Date().toTimeString().slice(0, 5)}: ${JSON.stringify(subjects)}`);
    if (subjects.length !== 4) {
      await page.locator('[data-screen="commit-graph"][data-state="ready"]').waitFor({ timeout: 15_000 }).catch(() => undefined);
      await t.bugShot("A-07");
    }
    equal(subjects, ["Folgetag", "Stichtag, 23:59", "Stichtag, 12:00", "Stichtag, 00:00:30"], "\"since 2026-02-01\" fetches all commits from 00:00 of the cut-off day, regardless of the time of cloning");
  }, { bug: "A-07" });

  // -------------------------------------------------------------------------------------------
  await section("F02-E16 Credentials in the address (user:password@): the password appears nowhere in the UI or the log", async () => {
    await closeRepoTabs(app);
    const url = `http://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:${server.port}/wetterdaten.git`;
    await openDialog();
    await field("Address").fill(url);
    equal(await invalid("Address"), null, "the address with credentials is valid");
    await field("Target folder").fill(target);
    await field("Folder name").fill("mit-passwort");
    await startButton().click();
    const dir = path.join(target, "mit-passwort");
    const asked = await answerCredentials(() => cloned(dir));
    await waitCloned(dir, "address with credentials");
    equal(asked, 0, "with credentials in the address the app does not prompt");
    equal(ws.git(dir, "rev-parse", "HEAD"), sourceHead, "the clone is complete");
    await page.locator('[data-screen="commit-graph"][data-state="ready"]').waitFor({ timeout: 20_000 });
    await app.settle();
    const where = [];
    if ((await page.content()).includes(PASSWORD)) where.push("in the page DOM");
    if (JSON.stringify(await t.toasts()).includes(PASSWORD)) where.push("in a toast");
    const log = await activity();
    if (JSON.stringify(log).includes(PASSWORD)) where.push(`in the activity log (${log.filter((entry) => JSON.stringify(entry).includes(PASSWORD)).map((entry) => entry.command.slice(0, 60)).join(" | ")})`);
    if (JSON.stringify(await app.invoke("repo_list")).includes(PASSWORD)) where.push("in repo_list");
    const remotes = await app.invoke("remote_list", { repoId: (await activeTab(app)).repoId }).catch((error) => `remote_list: ${error.message}`);
    if (JSON.stringify(remotes).includes(PASSWORD)) where.push("in remote_list (the core's answer to the UI)");
    // Sidebar: check the remote's tooltip/text
    const left = page.locator('[data-area="left"]');
    if (((await left.innerText()) + (await left.evaluate((node) => Array.from(node.querySelectorAll("[title]")).map((item) => item.getAttribute("title")).join(" ")))).includes(PASSWORD)) where.push("in the sidebar");
    equal(where, [], "the password from the address cannot be read anywhere");
    note(`.git/config has origin as: ${ws.git(dir, "remote", "get-url", "origin").replace(PASSWORD, "<PASSWORD>").replace(encodeURIComponent(PASSWORD), "<PASSWORD>")}`);
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E12 Slow network: 1.5 s connect and throttled line – progress, usable, clone complete", async () => {
    await closeRepoTabs(app);
    const slow = await startSlowProxy(server.port, { connectDelayMs: 1500, bytesPerSecond: 24_000 });
    proxies.push(slow);
    await openDialog();
    await field("Address").fill(slowUrl(slow, "wetterdaten.git"));
    await field("Target folder").fill(target);
    await field("Folder name").fill("langsam");
    const started = Date.now();
    await startButton().click();
    const progress = form().locator("[data-clone-progress]");
    await progress.waitFor();
    equal(await form().getAttribute("data-state"), "running", "the dialog shows the running operation");
    const phase = await progress.locator("p[aria-live]").innerText();
    check(/…$/.test(phase), `a phase in plain words is shown while connecting (${phase})`);
    check(await page.getByRole("button", { name: "Cancel clone" }).isEnabled(), "\"Cancel clone\" is usable");
    check((await page.locator("footer.h-statusbar").innerText()).includes("Clone: langsam"), "the status bar shows the job");
    const dir = path.join(target, "langsam");
    const asked = await answerCredentials(() => cloned(dir));
    await waitCloned(dir, "slow network", 180_000);
    note(`clone over the slow line in ${((Date.now() - started) / 1000).toFixed(1)} s, ${asked} prompts, ${slow.connections()} connections`);
    check(Date.now() - started >= 3000, "the proxy really slowed things down");
    equal(ws.git(dir, "rev-parse", "HEAD"), sourceHead, "the clone is complete");
    equal(ws.git(dir, "status", "--porcelain"), "", "the working directory is clean");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
    equal(await jobs(), 0, "no job is left hanging");
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E12b Slow network, large repository: percentage grows, cancel cleans up", async () => {
    await closeRepoTabs(app);
    const slow = await startSlowProxy(server.port, { bytesPerSecond: 200_000 });
    proxies.push(slow);
    await openDialog();
    await field("Address").fill(slowUrl(slow, "gross.git", { user: USER }));
    await field("Target folder").fill(target);
    await field("Folder name").fill("gross-langsam");
    const dir = path.join(target, "gross-langsam");
    await startButton().click();
    // The user is in the address: only the password is asked for.
    const percent = () => page.evaluate(() => Number((document.querySelector("[data-clone-percent]")?.textContent ?? "").replace(/\D/g, "")) || 0);
    const seen = [];
    await answerCredentials(async () => {
      if (await form().locator("[data-clone-progress]").count()) seen.push(await percent());
      return seen.filter((value) => value > 0).length >= 6 || (await cloned(dir));
    }, { timeoutMs: 120_000 });
    const values = [...new Set(seen.filter((value) => value > 0))];
    note(`percentages over time: ${values.join(", ")}`);
    check(values.length >= 1, "the dialog shows percentages while the data trickles in");
    check(!(await cloned(dir)), "the clone is still running (the throttle works)");
    equal(await page.getByRole("progressbar", { name: "Clone progress" }).count(), 1, "the progress bar has a name");
    await page.getByRole("button", { name: "Cancel clone" }).click();
    await form().locator("[data-clone-cancelled]").waitFor({ timeout: 30_000 });
    await eventually(() => fs.existsSync(dir), false, "after cancelling no half-finished folder is left", 20_000);
    equal(await jobs(), 0, "the job is gone");
    await eventually(() => gitProcessesWith("gross-langsam").length, 0, "no git process of this clone keeps running", 20_000);
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "a cancel is not an error toast");
    await page.keyboard.press("Escape");
  });

  // -------------------------------------------------------------------------------------------
  let hole = null;
  await section("F02-E13a Server accepts and never answers: the dialog visibly waits, cancel works at once", async () => {
    hole = await startBlackHole();
    proxies.push(hole);
    await openDialog();
    await field("Address").fill(`http://127.0.0.1:${hole.port}/stumm.git`);
    await field("Target folder").fill(target);
    await field("Folder name").fill("stumm");
    const dir = path.join(target, "stumm");
    await startButton().click();
    const progress = form().locator("[data-clone-progress]");
    await progress.waitFor();
    await eventually(() => hole.connections() > 0, true, "Git has connected", 30_000);
    await sleep(4000);
    equal(await form().getAttribute("data-state"), "running", "after four seconds of silence the operation is still running");
    const text = (await progress.innerText()).replace(/\s+/g, " ");
    check(/Connecting|Waiting for the server to respond/.test(text), `the dialog says it is waiting for the server (${text})`);
    const stopAt = Date.now();
    await page.getByRole("button", { name: "Cancel clone" }).click();
    await form().locator("[data-clone-cancelled]").waitFor({ timeout: 20_000 });
    check(Date.now() - stopAt < 10_000, `the cancel takes effect within seconds (${Date.now() - stopAt} ms)`);
    await eventually(() => fs.existsSync(dir), false, "no folder was left behind");
    await eventually(() => gitProcessesWith(`:${hole.port}/`).length, 0, "no git process keeps hanging on the silent server", 20_000);
    equal(await jobs(), 0, "the job is gone");
    await page.keyboard.press("Escape");
  });

  await section("F02-E13b Server never answers, nobody cancels: after the timeout (2 min) \"No response from the server\" is shown", async () => {
    if (!hole) {
      hole = await startBlackHole();
      proxies.push(hole);
    }
    await openDialog();
    await field("Address").fill(`http://127.0.0.1:${hole.port}/stumm.git`);
    await field("Target folder").fill(target);
    await field("Folder name").fill("stumm-zeitlimit");
    const dir = path.join(target, "stumm-zeitlimit");
    const started = Date.now();
    await startButton().click();
    await eventually(bannerCode, "timeout", "the dialog reports the timeout", 200_000);
    const seconds = Math.round((Date.now() - started) / 1000);
    note(`timeout after ${seconds} s: ${await bannerText()}`);
    check((await bannerText()).includes("No response from the server"), "clear sentence");
    check(seconds >= 100 && seconds <= 180, `the timeout kicks in after about two minutes (${seconds} s)`);
    check(!fs.existsSync(dir), "no folder was left behind");
    equal(await jobs(), 0, "the job is gone");
    await eventually(() => gitProcessesWith(`:${hole.port}/`).length, 0, "no git process keeps hanging", 20_000);
    await page.keyboard.press("Escape");
    app.consoleErrors.length = 0;
  }, { skip: quick ? "--quick" : null });

  // -------------------------------------------------------------------------------------------
  await section("F02-E18 Screen reader: dialog, error, progress and cancel – names, roles, announcements, visible focus", async () => {
    await openDialog();
    const dialog = page.locator('[role="dialog"]').last();
    const named = await dialog.evaluate((node) => (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim() || node.getAttribute("aria-label"));
    equal(named, "Clone repository", "the dialog uses its title as its name");
    await form().getByRole("button", { name: /Advanced options/ }).click();
    await form().getByRole("checkbox", { name: /Shallow clone/ }).click();
    await form().getByRole("checkbox", { name: /Sparse checkout/ }).click();
    await checkA11y(t, '[role="dialog"]', "clone dialog with all options");
    // Focus visible at every stop, focus stays inside the dialog
    await field("Address").focus();
    const stops = [];
    for (let step = 0; step < 16; step++) {
      await page.keyboard.press("Tab");
      const focus = await t.focused();
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
      stops.push(`${(focus.label ?? focus.text).slice(0, 30)}${focus.visible ? "" : " (INVISIBLE)"}${inside ? "" : " (OUTSIDE)"}`);
    }
    check(stops.every((stop) => !stop.includes("INVISIBLE")), `focus is visible at every stop: ${stops.join(" → ")}`);
    check(stops.every((stop) => !stop.includes("OUTSIDE")), "focus stays inside the dialog (focus trap)");
    // Error state: error linked to the field, banner is announced
    await form().getByRole("checkbox", { name: /Shallow clone/ }).click();
    await form().getByRole("checkbox", { name: /Sparse checkout/ }).click();
    await field("Address").fill(ws.at("gibt-es-nicht.git"));
    await field("Target folder").fill(target);
    await field("Folder name").fill("a11y-fehler");
    await startButton().click();
    await eventually(bannerCode, "not_found", "error in the dialog", 30_000);
    equal(await invalid("Address"), "true", "the address is marked invalid (aria-invalid)");
    check(((await errorOf("Address")) ?? "").length > 0, "the error text is linked to the field via aria-describedby");
    const live = await banner().evaluate((node) => {
      const region = node.querySelector('[role="alert"], [role="status"], [aria-live]') ?? node.closest('[role="alert"], [role="status"], [aria-live]');
      return region ? (region.getAttribute("role") ?? region.getAttribute("aria-live")) : null;
    });
    check(live !== null, `the error banner is a live region (got: ${live})`);
    await checkA11y(t, '[role="dialog"]', "clone dialog with error");
    // Running state
    await field("Address").fill(fileUrl(large.path));
    await startButton().click();
    await form().locator("[data-clone-progress]").waitFor();
    const bar = page.getByRole("progressbar", { name: "Clone progress" });
    equal(await bar.count(), 1, "the progress is a named progressbar");
    check((await bar.getAttribute("aria-valuetext")) !== null, "with aria-valuetext (phase and percent)");
    equal(await form().locator("[data-clone-progress] p[aria-live]").getAttribute("aria-live"), "polite", "the phase is announced (aria-live=polite)");
    await checkA11y(t, '[role="dialog"]', "clone dialog while running");
    await page.getByRole("button", { name: "Cancel clone" }).click();
    const cancelled = form().locator("[data-clone-cancelled]");
    await cancelled.waitFor({ timeout: 30_000 });
    const cancelLive = await cancelled.evaluate((node) => {
      const region = node.querySelector('[role="alert"], [role="status"], [aria-live]') ?? node.closest('[role="alert"], [role="status"], [aria-live]');
      return region ? (region.getAttribute("role") ?? region.getAttribute("aria-live")) : null;
    });
    check(cancelLive !== null, `the "clone cancelled" notice is a live region (got: ${cancelLive})`);
    await eventually(() => fs.existsSync(path.join(target, "a11y-fehler")), false, "no folder remains after cancelling");
    await page.keyboard.press("Escape");
    await form().waitFor({ state: "detached" });
    app.consoleErrors.length = 0;
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-N2 No write access to the target folder: clear refusal, input stays, nothing is created", async () => {
    const locked = ws.dir("nur-lesen");
    const restore = denyWrite(locked);
    undo.push(restore);
    try {
      await openDialog();
      await field("Address").fill(source);
      await field("Target folder").fill(locked);
      await field("Folder name").fill("darf-nicht");
      await startButton().click();
      await eventually(async () => (await bannerCode()) !== null || (await cloned(path.join(locked, "darf-nicht"))), true, "the app answers", 60_000);
      const text = await bannerText();
      note(`answer without write access [${await bannerCode()}]: ${text}`);
      check(!(await cloned(path.join(locked, "darf-nicht"))), "no tab opens");
      // BUG A-05: instead of the reason only "Git command “git clone” failed (exit code 128)" is shown;
      // that the folder is not writable only appears behind "Show output" – in Git's raw output.
      const explained = /access|permission|denied|read-only|cannot write|can't write|not writable/i.test(text);
      if (!explained) await t.shot("target/e2e/bugs/A-05-clone.png");
      check(explained, `the refusal names the missing access: "${text}"`);
      check(!/exit code \d+/i.test(text), "no bare exit code as the explanation");
      equal(fs.readdirSync(locked), [], "nothing was created in the folder");
      equal([await field("Address").inputValue(), await field("Target folder").inputValue(), await field("Folder name").inputValue()], [source, locked, "darf-nicht"], "the input is still there");
      equal(await t.toasts(), [], "no toast – the error is shown in the dialog");
    } finally {
      restore();
      undo.splice(undo.indexOf(restore), 1);
    }
    await page.keyboard.press("Escape");
    app.consoleErrors.length = 0;
  }, { bug: "A-05" });

  // -------------------------------------------------------------------------------------------
  await section("F02-N4 Source is a folder without a repository: clear refusal at the address", async () => {
    const plain = ws.dir("nur-ein-ordner");
    fs.writeFileSync(path.join(plain, "notiz.txt"), "kein Repository\n");
    await openDialog();
    await field("Address").fill(plain);
    await field("Target folder").fill(target);
    await field("Folder name").fill("aus-ordner");
    await startButton().click();
    await eventually(bannerCode, "not_found", "Code not_found", 30_000);
    check((await bannerText()).includes("There is no repository at this address"), `clear sentence: ${await bannerText()}`);
    equal(await invalid("Address"), "true", "the error is shown at the address");
    check(!fs.existsSync(path.join(target, "aus-ordner")), "no folder was created");
    await page.keyboard.press("Escape");
    app.consoleErrors.length = 0;
  });

  // -------------------------------------------------------------------------------------------
  await section("F02-E11 Window is closed in the middle of cloning: confirmation or cleanup – no half-finished folder blocking the next attempt", async () => {
    // BUG A-08: the close button quits the app without asking; the half-finished folder stays and
    // the same clone then fails with "The target is already taken".
    await closeRepoTabs(app);
    const slow = await startSlowProxy(server.port, { bytesPerSecond: 150_000 });
    proxies.push(slow);
    await openDialog();
    await field("Address").fill(slowUrl(slow, "gross.git", { user: USER }));
    await field("Target folder").fill(target);
    await field("Folder name").fill("beim-schliessen");
    const dir = path.join(target, "beim-schliessen");
    await startButton().click();
    await answerCredentials(async () => (await page.evaluate(() => /\d+ %/.test(document.querySelector("[data-clone-percent]")?.textContent ?? ""))) || (await cloned(dir)), { timeoutMs: 120_000 });
    check(!(await cloned(dir)), "starting point: the clone is still running");
    check(fs.existsSync(dir), "starting point: the target folder is being created");
    // Close the window like a user (WM_CLOSE)
    const pid = app.pid;
    const sent = requestWindowClose(pid);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let asks = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && alive()) {
      asks = await page.locator('[role="dialog"], [role="alertdialog"]').evaluateAll((list) => list.some((node) => /still running|Quit Forkyard|really (close|quit)|Cancel clone/.test(node.textContent ?? "") && !node.querySelector('[data-screen="clone"]'))).catch(() => false);
      if (asks) break;
      await sleep(200);
    }
    const closedByItself = !alive();
    note(`close requested (WM_CLOSE like the close button): ${sent}; app quit afterwards: ${closedByItself}; confirmation seen: ${asks}`);
    check(sent, "the app window received the close request");
    if (asks) {
      // The app asks for confirmation: that is one of the two correct answers.
      await t.shot("target/e2e/A-F02-close-confirmation.png");
      await app.close();
    } else {
      check(closedByItself, "without confirmation the app quit (otherwise: neither confirmation nor quit)");
      await app.close();
      await sleep(1500);
      const left = fs.existsSync(dir);
      const running = gitProcessesWith("beim-schliessen");
      await sleep(5000);
      const later = gitProcessesWith("beim-schliessen");
      note(`after the app quit: half-finished folder present: ${left}; git processes of this clone after 1.5 s: ${running.length}, after 6.5 s: ${later.length}${later.length ? ` (${later.map((line) => line.split("\t")[1]?.slice(0, 90)).join(" | ")})` : ""}`);
      // Leave the machine clean: kill orphaned processes of this test.
      const killed = killProcesses(later);
      if (killed) await sleep(1000);
      equal(later.length, 0, "no git process of this clone keeps running without the app");
      // Restart: no ghost entry, and the same clone can be repeated.
      app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir });
      page = app.page;
      t.attach(app);
      await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
      check(!(await app.invoke("repo_list")).some((entry) => samePath(entry.path, dir)), "after the restart the cancelled clone is not in the list");
      check(!(await tabs()).some((tab) => tab.kind === "repo" && samePath(tab.path ?? "", dir)), "and has no tab");
      await openDialog();
      await field("Address").fill(source);
      await field("Target folder").fill(target);
      await field("Folder name").fill("beim-schliessen");
      await startButton().click();
      await eventually(async () => (await bannerCode()) !== null || (await cloned(dir)), true, "second attempt: the app answers", 60_000);
      const code = await bannerCode();
      if (code) {
        note(`second attempt fails [${code}]: ${await bannerText()}`);
        await t.bugShot("A-08");
      }
      check(!left, "after closing without confirmation no half-finished folder was left behind");
      equal(code, null, "the same clone can be repeated after the restart without manual cleanup");
      if (code) check(!/No half-finished folder was left behind/.test(await bannerText()), "the refusal does not claim \"No half-finished folder was left behind\" while exactly that folder is in the way");
    }
    app.consoleErrors.length = 0;
  }, { bug: "A-08" });
} catch (error) {
  t.check(false, `aborted: ${error?.stack ?? error}`);
} finally {
  for (const restore of undo) {
    try {
      restore();
    } catch {
      // rights were already restored
    }
  }
  await app?.close().catch(() => undefined);
  for (const proxy of proxies) await proxy.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  large.cleanup();
  ws.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
t.finish();
