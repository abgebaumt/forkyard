/**
 * F01 – open a repository and browse its history: the cases no script under scripts/e2e/screens/
 * checks yet. Real app, real repositories in temp folders.
 *
 *   node scripts/e2e/flows/A-F01.mjs [--show] [--only <part>[,<part>]]
 *
 * Already covered elsewhere and NOT repeated here: keyboard only (keyboard.mjs), no repository / path missing /
 * moved / many entries / 960×600 (repo-management.mjs), empty repository and 50,000 commits (commit-graph.mjs),
 * same folder twice and restart (mustfix-tabs.mjs), launch from outside (shell.mjs), foreign
 * repository (trust.mjs), date format (prefs-effects.mjs).
 *
 * Every section carries the number of its case. A red section marked "BUG A-…" is the test that
 * verifies the fix of the reported bug. At the end comes the list: green / red.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { makeWorkspace } from "../screens/repo-entry-lib.mjs";
import { activeTab, checkA11y, closeRepoTabs, createFlowRun, denyRead, fileUrl, loadedRows, showManagement, sleep, windowFocus } from "./A-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createFlowRun("A-F01", { argv });
const { check, equal, eventually, note, section } = t;

const repoManagementScreen = '[data-screen="repo-management"]';
const commitGraphScreen = '[data-screen="commit-graph"]';
const commitDetailsScreen = '[data-screen="commit-details"]';
const diffScreen = '[data-screen="diff"]';
const rowSel = (sha) => `${commitGraphScreen} [data-row-id="${sha}"]`;

const ws = makeWorkspace("a-f01");
const clean = makeCleanRepoWithRemote();
const undo = [];
let app = null;
let page = null;

const lines = (text) => text.split(/\r?\n/).filter(Boolean);
const tabs = () => app.invoke("tabs_list");
const center = (tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.center ?? null, tabId);
/** Title of a tab as shown in the tab bar (the text is split into two spans for middle truncation). */
const tabTitle = (tabId) => page.locator(`[data-tab-id="${tabId}"] [role="tab"]`).evaluate((tab) => tab.textContent.trim());
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** "Open …" in repository management; the system folder dialog answers with `folder` (null = cancelled). */
const openViaUi = async (folder) => {
  await showManagement(app);
  await app.pick(folder);
  await page.locator(repoManagementScreen).getByRole("button", { name: "Open …" }).click();
};
/** Waits until the repository's tab is active and the graph is ready. */
const waitRepoTab = async (repoPath, what) => {
  await eventually(async () => {
    const tab = await activeTab(app);
    return tab?.kind === "repo" && samePath(tab.path, repoPath);
  }, true, `${what}: the repository's tab is active`, 30_000);
  await page.locator(`${commitGraphScreen}[data-state="ready"], ${commitGraphScreen}[data-state="empty"]`).first().waitFor({ timeout: 30_000 });
  await app.settle();
  return activeTab(app);
};
const commitRows = async (repoId) => (await loadedRows(app, repoId)).filter((row) => row.kind === "commit" || row.kind === "merge").map((row) => row.sha);
const setDateFormat = async (dateFormat) => {
  await app.invoke("settings_set", { patch: { dateFormat } });
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
  await app.settle();
};
const dateCell = (sha) => page.locator(`${rowSel(sha)} [data-cell="date"]`).innerText().then((text) => text.trim());
const pad = (value) => String(value).padStart(2, "0");
const isoLocal = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
/** Date in the notation Git understands as GIT_AUTHOR_DATE, in this computer's time zone. */
const gitLocal = (date) => {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  page = app.page;
  t.attach(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });

  // -------------------------------------------------------------------------------------------
  await section("F01-E16a Screen reader: empty management – names, roles, visible focus", async () => {
    await page.locator(`${repoManagementScreen}[data-state="empty"]`).waitFor();
    await checkA11y(t, repoManagementScreen, "empty management");
    equal(await page.locator(repoManagementScreen).getByRole("button").evaluateAll((list) => list.map((button) => button.textContent.trim())), ["Open …", "Clone …", "Create new …"], "the three entry points are named buttons");
    // Keyboard focus: each of the three buttons shows it visibly.
    for (const name of ["Open …", "Clone …", "Create new …"]) {
      for (let step = 0; step < 12 && (await t.focused()).text !== name; step++) await page.keyboard.press("Tab");
      const focus = await t.focused();
      equal(focus.text, name, `Tab reaches "${name}"`);
      check(focus.visible, `focus on "${name}" is visible`);
    }
  });

  // -------------------------------------------------------------------------------------------
  let cleanTab = null;
  await section("F01-H1 Happy path with the mouse: Open … → commit → file → diff, compared with git", async () => {
    await openViaUi(clean.path);
    cleanTab = await waitRepoTab(clean.path, "Open");
    equal(await tabTitle(cleanTab.id), "messnetz", "the tab is named after the folder");
    equal((await commitRows(cleanTab.repoId)).slice().sort(), lines(clean.git("rev-list", "--all")).sort(), "the graph shows exactly the commits from git rev-list --all");
    const sha = clean.git("rev-parse", "main~1");
    await page.locator(rowSel(sha)).click();
    await page.locator(`${commitDetailsScreen} code[title="${sha}"]`).waitFor();
    equal(await page.locator(`${commitDetailsScreen} [data-testid="commit-summary"]`).innerText(), clean.git("log", "-1", "--format=%s", sha), "commit details show the message from git log");
    check((await page.locator(`${commitDetailsScreen} [data-testid="commit-meta"]`).innerText()).includes(clean.git("log", "-1", "--format=%an", sha)), "and the author");
    const files = page.locator(`${commitDetailsScreen} [role="listbox"][aria-label="Changed files of this commit"] [role="option"]`);
    equal(await files.count(), lines(clean.git("show", "--name-only", "--format=", sha)).length, "as many files as git show --name-only");
    await files.first().click();
    await eventually(async () => (await center(cleanTab.id))?.kind, "diff", "clicking the file opens the diff");
    equal((await center(cleanTab.id))?.path, lines(clean.git("show", "--name-only", "--format=", sha))[0], "it is this commit's file");
    await page.locator(diffScreen).waitFor();
    await eventually(async () => (await page.locator(diffScreen).innerText()).includes("Schule Nord"), true, "the diff shows the file's content (line \"Schule Nord\")");
    equal(await t.toasts(), [], "no toast");
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E5 Empty input: folder dialog cancelled – nothing happens", async () => {
    await showManagement(app);
    const before = (await tabs()).length;
    await openViaUi(null);
    await sleep(600);
    equal((await tabs()).length, before, "no new tab");
    equal(await page.locator("[data-notice]").count(), 0, "no notice");
    equal(await t.toasts(), [], "no toast");
    equal((await t.focused()).text, "Open …", "focus stays on \"Open …\"");
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E6 Very long input: 500-character path, deep folder (190 characters)", async () => {
    // 1. A 500-character path that does not exist: notice without overflow, even in the smallest window.
    const long = path.join(ws.root, "x".repeat(500 - ws.root.length - 1));
    equal(long.length, 500, "path length");
    await openViaUi(long);
    const notice = page.locator('[data-notice="path_not_found"]');
    await notice.waitFor();
    check((await notice.innerText()).replace(/\s+/g, "").includes(long.replace(/\s+/g, "")), "the notice names the whole path");
    await app.setSize(960, 600);
    await sleep(250);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no page overflow");
    const box = await notice.boundingBox();
    check(box.x >= 0 && box.x + box.width <= 960, `960×600: the notice lies inside the window (${JSON.stringify(box)})`);
    check(await notice.getByRole("button", { name: "Dismiss notice" }).isVisible(), "960×600: \"Dismiss notice\" stays reachable");
    await app.setSize(1440, 900);
    await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await notice.waitFor({ state: "detached" });

    // 2. A repository deep inside long folder names (below Windows' 260-character limit).
    const longName = "messreihen-archiv-der-wetterstation-nord-mit-allen-rohdaten-und-protokollen"; // 74 characters
    const deep = ws.repo(path.join("a".repeat(30), "b".repeat(30), longName));
    check(deep.length > 150, `deep path: ${deep.length} characters`);
    await openViaUi(deep);
    const tab = await waitRepoTab(deep, "deep path");
    equal((await commitRows(tab.repoId)).length, 1, "the graph shows the one commit");
    const tabBox = await page.locator(`[data-tab-id="${tab.id}"]`).boundingBox();
    check(tabBox.width < 400, `the tab with a ${longName.length}-character name stays narrow (${Math.round(tabBox.width)} px)`);
    equal(await t.overflow(), { x: 0, y: 0 }, "no overflow");
    await app.invoke("tab_close", { tabId: tab.id });
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E7 Emoji, umlauts and spaces in path, file and message", async () => {
    const parent = "Größe & Maße 🌦 2026";
    const name = "wetter daten (Süd) 🚀";
    const repo = ws.repo(path.join(parent, name), { "README.md": "# Wetter Süd\n" });
    const file = "Größen 🌡 Übersicht.md";
    const message = "Übersicht ergänzt 🌧️ – „Größe“ & <Maße>";
    const sha = ws.commit(repo, file, "| Größe | Einheit |\n| --- | --- |\n| Temperatur | °C |\n", message);
    await openViaUi(repo);
    const tab = await waitRepoTab(repo, "path with emoji");
    equal(await tabTitle(tab.id), name, "the tab shows the folder name with umlauts, spaces and emoji");
    const listed = (await app.invoke("repo_list")).find((entry) => entry.id === tab.repoId);
    equal([listed?.name, samePath(listed?.path ?? "", repo)], [name, true], "the core keeps name and path intact");
    equal(await page.locator(`${rowSel(sha)} [data-cell="message"]`).innerText().then((text) => text.trim()), message, "the message appears intact in the graph");
    await page.locator(rowSel(sha)).click();
    await page.locator(`${commitDetailsScreen} code[title="${sha}"]`).waitFor();
    equal(await page.locator(`${commitDetailsScreen} [data-testid="commit-summary"]`).innerText(), message, "and in the commit details");
    const files = page.locator(`${commitDetailsScreen} [role="listbox"][aria-label="Changed files of this commit"] [role="option"]`);
    check((await files.first().innerText()).includes(file), `the file list shows "${file}" (${JSON.stringify(await files.first().innerText())})`);
    await files.first().click();
    await eventually(async () => (await center(tab.id))?.path, file, "the diff opens the file with an emoji in its name");
    await eventually(async () => (await page.locator(diffScreen).innerText()).includes("Temperatur"), true, "the diff shows its content");
    // In the management list
    await showManagement(app);
    const row = page.locator(`[data-repo-id="${tab.repoId}"]`);
    check((await row.innerText()).includes(name), "the row in management shows the name");
    check(await row.locator("[title]").evaluateAll((list, wanted) => list.some((item) => item.getAttribute("title") === wanted), repo), "the full path is in the tooltip");
    equal(await t.toasts(), [], "no toast");
    await app.invoke("tab_close", { tabId: tab.id });
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E8 Open a subfolder of a repository: the root is opened, no second tab", async () => {
    const before = await tabs();
    await openViaUi(path.join(clean.path, "src"));
    const tab = await waitRepoTab(clean.path, "subfolder");
    equal(tab.id, cleanTab?.id, "the existing tab of \"messnetz\" becomes active");
    equal((await tabs()).filter((item) => item.kind === "repo").length, before.filter((item) => item.kind === "repo").length, "no additional repository tab");
    equal((await app.invoke("repo_list")).filter((entry) => entry.name === "messnetz" || entry.name === "src").map((entry) => entry.name), ["messnetz"], "the list contains the root, not the subfolder");
    equal(await t.toasts(), [], "no toast");
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E9 Changed from outside while the app is open: commit, branch, checkout, branch deleted", async () => {
    await app.invoke("tab_activate", { tabId: cleanTab.id });
    await page.locator(`${commitGraphScreen}[data-state="ready"]`).waitFor();
    await app.settle();
    // Commit from outside
    fs.writeFileSync(path.join(clean.path, "von-aussen.md"), "Im Terminal geschrieben.\n");
    clean.git("add", "-A");
    clean.git("commit", "-q", "-m", "Commit aus dem Terminal");
    const outside = clean.git("rev-parse", "HEAD");
    // First on its own (file watcher), then with window focus.
    let bySelf = true;
    try {
      await page.locator(rowSel(outside)).waitFor({ timeout: 12_000 });
    } catch {
      bySelf = false;
      await windowFocus(app);
      await page.locator(rowSel(outside)).waitFor({ timeout: 20_000 }).catch(() => undefined);
    }
    check((await page.locator(rowSel(outside)).count()) === 1, "the commit from outside appears in the graph");
    check(bySelf, "… and on its own, without the window having to change focus");
    await eventually(() => page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Push/ }).first().getAttribute("aria-label"), "Push, 1 commit to push", "the toolbar counts the new commit to push");

    // Create and check out a branch from outside
    clean.git("checkout", "-q", "-b", "extern/neuer-zweig");
    await windowFocus(app);
    const left = page.locator('[data-area="left"]');
    await eventually(async () => (await left.innerText()).includes("neuer-zweig"), true, "the sidebar shows the branch from outside", 20_000);
    await eventually(() => page.locator(`${rowSel(outside)} [data-ref-full="refs/heads/extern/neuer-zweig"]`).count(), 1, "the graph shows the label on the commit", 20_000);
    await eventually(async () => (await page.locator("footer").innerText()).includes("extern/neuer-zweig"), true, "the status bar names the checked-out branch", 20_000);

    // Back to main, delete the branch from outside
    clean.git("checkout", "-q", "main");
    clean.git("branch", "-q", "-D", "extern/neuer-zweig");
    await windowFocus(app);
    await eventually(async () => (await left.innerText()).includes("neuer-zweig"), false, "the deleted branch disappears from the sidebar", 20_000);
    await eventually(() => page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/extern/neuer-zweig"]`).count(), 0, "and from the graph", 20_000);
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E11 Double click and double Enter on a list entry: exactly one tab", async () => {
    const one = ws.repo("doppelt-eins");
    const two = ws.repo("doppelt-zwei");
    for (const repo of [one, two]) {
      const opened = await app.invoke("repo_open", { path: repo });
      await app.invoke("tab_close", { tabId: opened.tab.id });
    }
    await showManagement(app);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
    await app.settle();
    const idOf = async (repo) => (await app.invoke("repo_list")).find((entry) => samePath(entry.path, repo)).id;
    // Double Enter, without a pause in between
    const row = page.locator(`[data-repo-id="${await idOf(one)}"]`);
    await row.focus();
    await Promise.all([page.keyboard.press("Enter"), page.keyboard.press("Enter")]);
    await waitRepoTab(one, "double Enter");
    await sleep(500);
    equal((await tabs()).filter((tab) => tab.kind === "repo" && samePath(tab.path, one)).length, 1, "double Enter: exactly one tab for the repository");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger" || toast.tone === "warning"), [], "double Enter: no error toast");
    // Double click
    await showManagement(app);
    await page.locator(`[data-repo-id="${await idOf(two)}"]`).dblclick();
    await waitRepoTab(two, "double click");
    await sleep(500);
    equal((await tabs()).filter((tab) => tab.kind === "repo" && samePath(tab.path, two)).length, 1, "double click: exactly one tab for the repository");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger" || toast.tone === "warning"), [], "double click: no error toast");
    for (const tab of await tabs()) if (tab.kind === "repo" && (samePath(tab.path, one) || samePath(tab.path, two))) await app.invoke("tab_close", { tabId: tab.id });
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E4 Open a shallow clone: the graph shows exactly the existing history, the boundary commit can be viewed", async () => {
    const source = ws.repo("quelle-tief", { "README.md": "# Quelle\n" });
    for (let index = 1; index <= 6; index++) ws.commit(source, `daten/reihe-${index}.csv`, `wert;${index}\n`, `Messreihe ${index}`, `2026-0${index}-10T12:00:00+01:00`);
    const shallow = ws.at("flacher-klon");
    ws.git(ws.root, "clone", "-q", "--depth", "3", fileUrl(source), shallow);
    equal(ws.git(shallow, "rev-parse", "--is-shallow-repository"), "true", "fixture: Git reports a shallow clone");
    await openViaUi(shallow);
    const tab = await waitRepoTab(shallow, "shallow clone");
    const expected = lines(ws.git(shallow, "rev-list", "HEAD"));
    equal(expected.length, 3, "fixture: three commits present");
    equal(await commitRows(tab.repoId), expected, "the graph shows exactly the three existing commits, newest first");
    const boundary = expected.at(-1);
    await page.locator(rowSel(boundary)).click();
    await page.locator(`${commitDetailsScreen} code[title="${boundary}"]`).waitFor();
    equal(await page.locator(`${commitDetailsScreen} [data-testid="commit-summary"]`).innerText(), "Messreihe 4", "the details of the oldest existing commit load");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
    const hint = /shallow|truncated|incomplete|grafted/i.test(`${await page.locator(commitGraphScreen).innerText()} ${await page.locator(commitDetailsScreen).innerText()} ${await page.locator("footer").innerText()}`);
    note(`hint that the history is truncated: ${hint ? "present" : "none"}`);
    await app.invoke("tab_close", { tabId: tab.id });
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E14a Time zones and DST: ISO and local display match the instant from git", async () => {
    const repo = ws.repo("zeitzonen", { "README.md": "# Zeiten\n" });
    const dates = [
      ["Kurz vor Mitternacht", "2026-03-28T23:59:30+01:00"],
      ["Kurz nach Mitternacht", "2026-03-29T00:00:30+01:00"],
      ["Nach der Umstellung auf Sommerzeit", "2026-03-29T03:30:00+02:00"],
      ["Doppelte Stunde, Sommerzeit", "2025-10-26T02:30:00+02:00"],
      ["Doppelte Stunde, Winterzeit", "2025-10-26T02:30:00+01:00"],
      ["Aus Tokio", "2026-06-01T08:00:00+09:00"],
      ["Aus Seattle", "2026-06-01T20:00:00-08:00"],
      ["Jahreswechsel in Indien", "2026-01-01T00:30:00+05:30"],
    ];
    const made = dates.map(([message, date], index) => ({ message, date, sha: ws.commit(repo, `zeit-${index}.txt`, `${date}\n`, message, date) }));
    await setDateFormat("iso");
    await openViaUi(repo);
    const tab = await waitRepoTab(repo, "time zones");
    for (const commit of made) {
      const instant = new Date(ws.git(repo, "log", "-1", "--format=%aI", commit.sha));
      equal(instant.getTime(), new Date(commit.date).getTime(), `fixture "${commit.message}": git knows the instant`);
      equal(await dateCell(commit.sha), isoLocal(instant), `ISO in the graph – ${commit.message} (${commit.date})`);
    }
    // Commit details: exact instant and the author's time zone in the tooltip
    const tokyo = made.find((commit) => commit.message === "Aus Tokio");
    await page.locator(rowSel(tokyo.sha)).click();
    await page.locator(`${commitDetailsScreen} code[title="${tokyo.sha}"]`).waitFor();
    const time = page.locator(`${commitDetailsScreen} time[data-original]`).first();
    equal(new Date(await time.getAttribute("datetime")).getTime(), new Date(tokyo.date).getTime(), "commit details: datetime is exactly the commit's instant");
    const original = (await time.getAttribute("data-original")) ?? "";
    check(/UTC\+09:00/.test(original) && /08:00/.test(original), `the tooltip names the author's local time with time zone (${original})`);
    equal(await time.innerText(), isoLocal(new Date(tokyo.date)), "commit details show the local time here");
    // Local format
    await setDateFormat("local");
    const local = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
    for (const commit of made) equal(await dateCell(commit.sha), local.format(new Date(commit.date)), `local format in the graph – ${commit.message}`);
    await setDateFormat("relative");
    await app.invoke("tab_close", { tabId: tab.id });
  });

  // -------------------------------------------------------------------------------------------
  await section(
    "F01-E14b Relative date at the day boundary: \"2 days ago\" means two calendar days ago, \"yesterday\" means yesterday",
    async () => {
      // BUG A-01: the relative date rounds hours to days instead of counting calendar days.
      const now = new Date();
      const hour = now.getHours() + now.getMinutes() / 60;
      const at = (daysAgo, hours, minutes) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hours, minutes, 0);
      const repo = ws.repo("relativ", { "README.md": "# Relativ\n" });
      const cases = [];
      const add = (message, date, expected) => cases.push({ message, date, expected, sha: ws.commit(repo, `r-${cases.length}.txt`, `${message}\n`, message, gitLocal(date)) });
      // Depending on the time of the run, the deviation shows up in a different place.
      if (hour < 11.5) add("Vorgestern spät abends", at(2, 23, 55), "2 days ago");
      if (hour >= 12.25) add("Vorgestern früh morgens", at(2, 0, 5), "2 days ago");
      if (hour >= 12.25) add("Gestern früh morgens", at(1, 0, 5), "yesterday");
      if (hour >= 22.25) add("Heute kurz nach Mitternacht", at(0, 0, 5), /^\d+ hours ago$/);
      add("Vor zehn Minuten", new Date(now.getTime() - 10 * 60_000), /^(10|11) minutes ago$/);
      add("Gerade eben", new Date(now.getTime() - 5_000), /^(just now|1 minute ago)$/);
      if (!cases.some((entry) => entry.expected === "2 days ago")) note("Between 11:30 and 12:15 the day boundary cannot be checked – run again later.");
      await setDateFormat("relative");
      await openViaUi(repo);
      const tab = await waitRepoTab(repo, "relative");
      for (const entry of cases) {
        const shown = await dateCell(entry.sha);
        const ok = typeof entry.expected === "string" ? shown === entry.expected : entry.expected.test(shown);
        if (!ok && typeof entry.expected === "string") {
          await page.locator(rowSel(entry.sha)).scrollIntoViewIfNeeded();
          await t.bugShot("A-01");
        }
        check(ok, `"${entry.message}" (commit from ${isoLocal(entry.date)}, now ${isoLocal(now)}): expected ${entry.expected}, shown "${shown}"`);
      }
      await app.invoke("tab_close", { tabId: tab.id });
    },
    { bug: "A-01" },
  );

  // -------------------------------------------------------------------------------------------
  await section("F01-E14c Date in the future (author's clock off): readable, no \"Invalid Date\"", async () => {
    const repo = ws.repo("zukunft", { "README.md": "# Zukunft\n" });
    const future = new Date(Date.now() + 3 * 3600_000);
    const sha = ws.commit(repo, "morgen.txt", "x\n", "Commit aus der Zukunft", gitLocal(future));
    await setDateFormat("relative");
    await openViaUi(repo);
    const tab = await waitRepoTab(repo, "future");
    const shown = await dateCell(sha);
    check(/^in \d+ hours$/.test(shown), `relative date for a commit three hours ahead: "${shown}"`);
    check(!/NaN|Invalid|undefined/.test(await page.locator(commitGraphScreen).innerText()), "no \"NaN\" or \"Invalid Date\" anywhere");
    await app.invoke("tab_close", { tabId: tab.id });
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-E16b Screen reader: filled list – axe finds no serious violations", async () => {
    // BUG A-04: rows (role=option) contain buttons; their name leaves out visible text.
    await showManagement(app);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
    await app.settle();
    await page.locator(`${repoManagementScreen}[data-state="ready"]`).waitFor();
    const audit = await checkA11y(t, repoManagementScreen, "filled management");
    if (audit.serious.length) {
      const detail = await page.locator(`${repoManagementScreen} [role="option"]`).first().evaluate((row) => ({ name: row.getAttribute("aria-label"), visible: row.innerText.replace(/\s+/g, " ").trim(), buttons: Array.from(row.querySelectorAll("button")).map((button) => button.getAttribute("aria-label") ?? button.textContent.trim()) }));
      note(`first row: name "${detail.name}", visible text "${detail.visible}", buttons in the row: ${JSON.stringify(detail.buttons)}`);
      await t.bugShot("A-04");
    }
  }, { bug: "A-04" });

  await section("F01-E16c Screen reader: named listbox, rows with position, \"not a repository\" notice as live region", async () => {
    await showManagement(app);
    await page.locator(`${repoManagementScreen}[data-state="ready"]`).waitFor();
    const list = await page.locator(`${repoManagementScreen} [role="listbox"]`).evaluateAll((nodes) => nodes.map((node) => ({ label: node.getAttribute("aria-label") ?? node.getAttribute("aria-labelledby"), options: node.querySelectorAll('[role="option"]').length })));
    check(list.length >= 1 && list.every((entry) => entry.label && entry.options > 0), `the list is a named listbox with options (${JSON.stringify(list)})`);
    const rows = await page.locator(`${repoManagementScreen} [role="option"]`).evaluateAll((nodes) => nodes.map((node) => ({ label: node.getAttribute("aria-label"), selected: node.getAttribute("aria-selected"), pos: node.getAttribute("aria-posinset"), size: node.getAttribute("aria-setsize") })));
    check(rows.every((row) => row.label && row.selected !== null && row.pos && row.size), `every row has a name, selection state and position (${JSON.stringify(rows[0])})`);
    // "Not a repository" notice: is it announced?
    const plain = ws.dir("nur-ein-ordner");
    fs.writeFileSync(path.join(plain, "notiz.txt"), "kein Repository\n");
    await openViaUi(plain);
    const notice = page.locator('[data-notice="not_a_repo"]');
    await notice.waitFor();
    const live = await notice.evaluate((node) => {
      const region = node.querySelector('[role="alert"], [role="status"], [aria-live]') ?? node.closest('[role="alert"], [role="status"], [aria-live]');
      return region ? (region.getAttribute("role") ?? region.getAttribute("aria-live")) : null;
    });
    check(live !== null, `the notice is a live region (role=alert/status or aria-live) so a screen reader announces it (got: ${live})`);
    await checkA11y(t, '[data-notice="not_a_repo"]', "\"not a repository\" notice");
    await notice.getByRole("button", { name: "Dismiss notice" }).click();
  });

  // -------------------------------------------------------------------------------------------
  await section("F01-N5 Open a bare repository: clear refusal, no offer to create a repository inside it", async () => {
    // BUG A-02: a bare repository is reported as "not a Git repository", with the offer to create one inside it.
    const bare = clean.remotePath ?? path.join(clean.root, "origin.git");
    check(fs.existsSync(path.join(bare, "HEAD")) && !fs.existsSync(path.join(bare, ".git")), `fixture: ${bare} is a bare repository`);
    const before = (await tabs()).length;
    await openViaUi(bare);
    await eventually(async () => (await page.locator("[data-notice]").count()) + (await t.toasts()).length > 0, true, "the app answers with a notice or a toast", 20_000);
    const noticeKind = (await page.locator("[data-notice]").count()) ? await page.locator("[data-notice]").getAttribute("data-notice") : null;
    const text = noticeKind ? (await page.locator("[data-notice]").innerText()).replace(/\s+/g, " ") : JSON.stringify(await t.toasts());
    note(`answer to the bare repository: [${noticeKind ?? "toast"}] ${text}`);
    equal((await tabs()).length, before, "no tab opens");
    check(/bare|without (a )?working (directory|tree)|no working (directory|tree)/i.test(text), `the refusal explains that it is a repository without a working directory (bare): "${text}"`);
    check((await page.locator("[data-notice]").getByRole("button", { name: "Create a repository here" }).count()) === 0, "no \"Create a repository here\" offer inside an existing repository");
    if (!/bare|without (a )?working (directory|tree)|no working (directory|tree)/i.test(text)) await t.bugShot("A-02");
    if (await page.locator("[data-notice]").count()) await page.locator("[data-notice]").getByRole("button", { name: "Dismiss notice" }).click();
  }, { bug: "A-02" });

  // -------------------------------------------------------------------------------------------
  await section("F01-N2 No read access to the .git folder: the refusal names the access, not \"not a repository\"", async () => {
    // BUG A-03: without read access to the .git folder the app reports "not a Git repository" and offers to create one there.
    const repo = ws.repo("gesperrt");
    const restore = denyRead(path.join(repo, ".git"));
    undo.push(restore);
    try {
      const before = (await tabs()).length;
      await openViaUi(repo);
      await eventually(async () => (await page.locator("[data-notice]").count()) + (await t.toasts()).length > 0 || (await tabs()).length !== before, true, "the app answers", 20_000);
      const noticeKind = (await page.locator("[data-notice]").count()) ? await page.locator("[data-notice]").getAttribute("data-notice") : null;
      const text = noticeKind ? (await page.locator("[data-notice]").innerText()).replace(/\s+/g, " ") : JSON.stringify(await t.toasts());
      note(`answer without read access: [${noticeKind ?? "toast"}] ${text}`);
      equal((await tabs()).length, before, "no tab opens");
      check(/access|permission|denied|cannot read|can't read|readable/i.test(text), `the refusal names the missing access: "${text}"`);
      if (!/access|permission|denied|cannot read|can't read|readable/i.test(text)) await t.bugShot("A-03");
      if (await page.locator("[data-notice]").count()) await page.locator("[data-notice]").getByRole("button", { name: "Dismiss notice" }).click();
    } finally {
      restore();
      undo.splice(undo.indexOf(restore), 1);
    }
    // The failed core calls are intended here.
    app.consoleErrors.length = 0;
  }, { bug: "A-03" });

  // -------------------------------------------------------------------------------------------
  await section("F01-N3 Folder is renamed while its tab is open: clear state, app stays usable", async () => {
    const repo = ws.repo("verschwindet");
    ws.commit(repo, "a.txt", "a\n", "Zweiter Commit");
    await openViaUi(repo);
    const tab = await waitRepoTab(repo, "open");
    const moved = `${repo}-umbenannt`;
    let gone = false;
    for (let attempt = 0; attempt < 20 && !gone; attempt++) {
      try {
        fs.renameSync(repo, moved);
        gone = true;
      } catch (error) {
        if (attempt === 19) note(`renaming fails while the app has the folder open: ${error.code}`);
        await sleep(250);
      }
    }
    if (!check(gone, "the folder can be renamed while the app shows it (the app does not lock it)")) {
      await app.invoke("tab_close", { tabId: tab.id });
      return;
    }
    await windowFocus(app);
    await sleep(4000);
    await app.settle().catch(() => undefined);
    const full = page.locator('[data-shell="fullpage"]');
    const shell = (await full.count()) ? (await full.innerText()).replace(/\s+/g, " ") : (await page.locator('[data-shell="app"]').innerText()).replace(/\s+/g, " ").slice(0, 400);
    const seen = `${JSON.stringify(await t.toasts())} ${shell}`;
    note(`after renaming: toasts ${JSON.stringify(await t.toasts())}; full-page notice: ${(await full.count()) ? shell : "none"}`);
    check(/not found|does not exist|doesn't exist|moved|missing/i.test(seen), "the app says that the folder is missing");
    check(!/undefined|NaN|\[object/.test(seen), "no raw error texts");
    // The app stays usable: management shows the entry as missing.
    await showManagement(app);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
    await app.settle();
    await eventually(() => page.locator(`[data-repo-id="${tab.repoId}"]`).getAttribute("data-missing"), "true", "management marks the entry as missing");
    // Rename back: the tab works again.
    fs.renameSync(moved, repo);
    await app.invoke("tab_activate", { tabId: tab.id });
    await windowFocus(app);
    await page.locator(`${commitGraphScreen}[data-state="ready"] [data-row-kind="commit"]`).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    // A stuck error state has a retry button.
    if ((await page.locator(`${commitGraphScreen}[data-state="ready"]`).count()) === 0 && (await page.getByRole("button", { name: "Try again" }).count())) {
      await page.getByRole("button", { name: "Try again" }).first().click();
      await page.locator(`${commitGraphScreen}[data-state="ready"] [data-row-kind="commit"]`).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    }
    equal((await commitRows(tab.repoId)).length, 2, "after renaming back the tab shows the history again");
    await app.invoke("tab_close", { tabId: tab.id });
    // The failed core calls are intended here.
    app.consoleErrors.length = 0;
  });

  await closeRepoTabs(app).catch(() => undefined);
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
  clean.cleanup();
  ws.cleanup();
}
t.finish();
