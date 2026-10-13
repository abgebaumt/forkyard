/**
 * Flow F12 – fixing the last commit: “Edit message” in the commit details (commit-details) and
 * “Amend last commit” in the commit panel (commit-panel). The cases not yet covered by a script under
 * scripts/e2e/screens.
 *
 *   node scripts/e2e/flows/B-F12.mjs                 everything
 *   node scripts/e2e/flows/B-F12.mjs --only E4,E5    only sections whose title contains "E4" or "E5"
 *   node scripts/e2e/flows/B-F12.mjs --show          visible window
 *
 * Already covered: edit message keyboard-only including Esc and empty summary, hint for a pushed
 * commit, no editing during a merge (commit-details.mjs); amend loads the last message, hint for a pushed
 * commit, amend with an addition, disabled without a commit (commit-panel.mjs).
 *
 * Checks run against the repository itself: SHA, message, tree, author, dates, parents, reflog.
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote, makeConflictRepo, makeDetachedRepo, makeEmptyRepo } from "../fixtures.mjs";
import { axeViolations, createFlow, dialogOf, dialogTitle, lines, noDialog, readFile, sleep, tidy, toastsOf, unnamedControls, writeFile, writeHook } from "./B-lib.mjs";

const flow = createFlow("B-F12");
const { check, equal, eventually, until, section } = flow;
const press = (keys) => flow.page.keyboard.press(keys);
const PANEL = '[data-screen="commit-details"]';
const count = (repo) => Number(repo.git("rev-list", "--count", "HEAD"));
const head = (repo) => repo.git("rev-parse", "HEAD");
const subject = (repo) => repo.git("log", "-1", "--format=%s");
const body = (repo) => repo.git("log", "-1", "--format=%b").replace(/\n+$/, "");
const amends = (repo) => lines(repo.git("reflog", "--format=%gs")).filter((line) => /amend/.test(line)).length;
const selectWip = (tabId) => flow.page.evaluate((id) => window.__gc.store.getState().selectWip(id), tabId);
const selectCommit = async (tabId, sha) => {
  await flow.page.evaluate(([id, commit]) => window.__gc.store.getState().selectCommits(id, [commit]), [tabId, sha]);
  await flow.page.locator(`${PANEL} [data-testid="commit-summary"]`).waitFor({ timeout: 10_000 });
  await flow.app.settle();
};
const selection = (tabId) => flow.page.evaluate((id) => window.__gc.store.getState().views[id]?.selection ?? null, tabId);
const editor = () => {
  const panel = flow.page.locator(PANEL);
  return { panel, summary: panel.getByRole("textbox", { name: "Summary" }), description: panel.getByRole("textbox", { name: "Description" }), save: panel.getByRole("button", { name: "Save" }), open: panel.getByRole("button", { name: "Edit message" }) };
};
const toolbar = (name) => flow.page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: new RegExp(`^${name}`) }).first();
/** Creates a local, unpushed commit from outside. */
const localCommit = (repo, { file = "notiz.md", content = "erste Fassung\n", message = "Notiz angeleg", extra = [] } = {}) => {
  writeFile(repo, file, content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message, ...extra);
  return head(repo);
};

// ---------------------------------------------------------------------------------------------
await section("F12-H1 Edit the last commit's message with the mouse: select the commit in the graph, “Edit message”, “Save”", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h1-reword" });
  const old = localCommit(repo);
  const tree = repo.git("rev-parse", "HEAD^{tree}");
  const author = repo.git("log", "-1", "--format=%an|%ae|%aI");
  const parent = repo.git("rev-parse", "HEAD~1");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await page.locator('[data-screen="commit-graph"]').getByText("Notiz angeleg", { exact: true }).first().click(); // click 1
  await eventually(() => selection(tabId), { kind: "commits", shas: [old] }, "a click in the graph selects the last commit");
  const e = editor();
  await e.open.click(); // click 2
  await e.summary.waitFor({ timeout: 5000 });
  equal(await e.summary.inputValue(), "Notiz angeleg", "the field contains the previous summary");
  await e.summary.fill("Notiz angelegt");
  await e.description.fill("Tippfehler in der Message behoben.");
  await e.save.click(); // click 3
  await ui.waitToast("success", /Message changed/);
  const now = head(repo);
  check(now !== old, "git: new SHA");
  equal([subject(repo), body(repo)], ["Notiz angelegt", "Tippfehler in der Message behoben."], "git: new message");
  equal(repo.git("rev-parse", "HEAD^{tree}"), tree, "git: content (tree) unchanged");
  equal(repo.git("log", "-1", "--format=%an|%ae|%aI"), author, "git: author and author date unchanged");
  equal(repo.git("rev-parse", "HEAD~1"), parent, "git: same parent");
  equal(count(repo), 4, "git: no additional commit");
  await eventually(() => selection(tabId), { kind: "commits", shas: [now] }, "the selection moves to the new SHA");
  await eventually(() => page.locator(`${PANEL} [data-testid="commit-summary"]`).innerText(), "Notiz angelegt", "the panel shows the new summary");
  await eventually(() => page.locator('[data-screen="commit-graph"]').getByText("Notiz angelegt", { exact: true }).count().then((n) => n > 0), true, "the graph shows the new message");
  equal(await page.locator('[data-screen="commit-graph"]').getByText("Notiz angeleg", { exact: true }).count(), 0, "the old message is no longer in the graph");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-H2 Amend keyboard-only: tick the box, fix the message, stage all and amend commit", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h2-amend" });
  const old = localCommit(repo);
  writeFile(repo, "notiz.md", "erste Fassung\nNachtrag\n");
  writeFile(repo, "anhang.md", "gehört dazu\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  // No mouse from here on.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await ui.tabToCheckbox("Amend last commit");
  await press("Space");
  await eventually(() => ui.summary.inputValue(), "Notiz angeleg", "amend loads the last commit's message");
  equal(await page.getByRole("form", { name: "Amend last commit", exact: true }).count(), 1, "the form is now called “Amend last commit”");
  await ui.tabUntil((name) => document.activeElement?.getAttribute("aria-label") === name, "Summary", { back: true });
  await press("End");
  await page.keyboard.type("t");
  await press("Tab");
  await page.keyboard.type("Mit Nachtrag und Anhang.");
  await page.keyboard.down("Shift");
  await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Stage all and amend commit", "with Shift the button reads “Stage all and amend commit”");
  await page.keyboard.up("Shift");
  await press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit amended/);
  equal(count(repo), 4, "git: no additional commit");
  check(head(repo) !== old, "git: the commit was replaced");
  equal([subject(repo), body(repo)], ["Notiz angelegt", "Mit Nachtrag und Anhang."], "git: message");
  equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")).sort(), ["anhang.md", "notiz.md"], "git: both files in the amended commit");
  equal(repo.git("show", "HEAD:notiz.md"), "erste Fassung\nNachtrag", "git: the addition is in the commit");
  equal(repo.git("status", "--porcelain"), "", "git: clean");
  await eventually(() => ui.checkbox("Amend last commit").getAttribute("aria-checked"), "false", "amend is off again afterwards");
  await eventually(() => ui.summary.inputValue(), "", "the form is empty");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-H3 Amend content only; commit by another author from another time zone just before midnight: author and date stay (F12-E10, F12-E11)", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h3-autor" });
  // Author Aylin, 15 January 23:59:30 in UTC−8 – in Central Europe it is already 16 January.
  writeFile(repo, "messung.md", "Messung 1\n");
  repo.git("add", "-A");
  repo.git("-c", "user.name=Lena Hartmann", "commit", "-q", "-m", "Messung von Aylin", "--author=Aylin Demir <aylin.demir@wetterstation.example>", "--date=2026-01-15T23:59:30-08:00");
  const old = head(repo);
  equal(repo.git("log", "-1", "--format=%an|%aI"), "Aylin Demir|2026-01-15T23:59:30-08:00", "initial state: other author, other time zone");
  writeFile(repo, "messung.md", "Messung 1\nMessung 2\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.summary.inputValue(), "Messung von Aylin", "the message is loaded");
  await ui.commitButton.click({ modifiers: ["Shift"] });
  await ui.waitToast("success", /Commit amended/);
  check(head(repo) !== old, "git: the commit was replaced");
  equal(subject(repo), "Messung von Aylin", "git: the message is unchanged");
  equal(repo.git("show", "HEAD:messung.md"), "Messung 1\nMessung 2", "git: the content has been added");
  equal(repo.git("log", "-1", "--format=%an|%ae|%aI"), "Aylin Demir|aylin.demir@wetterstation.example|2026-01-15T23:59:30-08:00", "git: author, author date and time zone offset stay");
  equal(repo.git("log", "-1", "--format=%cn|%ce"), "Lena Hartmann|lena.hartmann@wetterstation.example", "git: committer is the own identity");
  await ui.closeToasts();
  // Display: the viewer's local time, not the author's – and both people are named.
  await app.invoke("settings_set", { patch: { dateFormat: "iso" } });
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
  await selectCommit(tabId, head(repo));
  const date = new Date("2026-01-15T23:59:30-08:00");
  const pad = (n) => String(n).padStart(2, "0");
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const meta = (await page.locator(`${PANEL} [data-testid="commit-meta"]`).innerText()).replace(/\s+/g, " ");
  check(meta.includes(local), `the details show the author date in local time (${local}): ${meta.slice(0, 260)}`);
  check(meta.includes("Aylin Demir"), "the details name the author");
  check(meta.includes("Lena Hartmann"), `the details also name who committed (${meta.slice(0, 260)})`);
  await app.invoke("settings_set", { patch: { dateFormat: "relative" } });
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
  await selectWip(tabId);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E1 Already pushed commit: hint, after amending the branch diverges, push is rejected and can be forced", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e1-gepusht" });
  const old = head(repo);
  const remoteHead = () => lines(repo.git("ls-remote", "origin", "refs/heads/main"))[0]?.split(/\s+/)[0];
  equal(remoteHead(), old, "initial state: the last commit is pushed");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await ui.checkbox("Amend last commit").click();
  await ui.page.getByText(/already been pushed/).waitFor({ timeout: 5000 });
  check(/force push/.test(await page.locator('form[aria-label="Amend last commit"]').innerText()), "the hint mentions the required force push");
  await ui.checkbox("Push after commit").click();
  await ui.summary.fill("Vergleich der Tagesmittel (korrigiert)");
  await ui.commitButton.click();
  const toast = await ui.waitToast("warning", /Commit amended, but not pushed/, 60_000);
  check(/Retry push/.test(toast ?? ""), "the toast offers “Retry push”");
  check(head(repo) !== old, "git: the commit was replaced");
  equal(remoteHead(), old, "git: the remote still has the old commit");
  equal(repo.git("rev-list", "--left-right", "--count", "origin/main...HEAD").split(/\s+/), ["1", "1"], "git: one commit ahead and one behind");
  await ui.closeToasts();
  await eventually(
    () => page.locator("footer").evaluate((footer) => [footer.querySelector('[aria-label$="ahead"]')?.getAttribute("aria-label") ?? null, footer.querySelector('[aria-label$="behind"]')?.getAttribute("aria-label") ?? null]),
    ["1 commit ahead", "1 commit behind"],
    "the status bar shows: 1 commit ahead, 1 commit behind",
  );
  // Push via the toolbar: rejected, with the offer to force.
  await toolbar("Push").click();
  await until(async () => (await dialogTitle(page)) === "Push rejected", "dialog “Push rejected”", 60_000);
  const rejected = (await dialogOf(page).innerText()).replace(/\s+/g, " ");
  check(/Pull first/.test(rejected) && /Force push/.test(rejected), `the dialog offers “Pull first” and “Force push” (${rejected})`);
  await dialogOf(page).getByRole("button", { name: /^Force push/ }).click();
  await until(async () => /^Force push.*\?$/.test((await dialogTitle(page)) ?? ""), "confirmation before forcing", 60_000);
  const force = (await dialogOf(page).innerText()).replace(/\s+/g, " ");
  check(force.includes(old.slice(0, 7)) || /Vergleich der Tagesmittel zweier Stationen/.test(force), `the confirmation names the commit that will be overwritten on the remote (${force})`);
  await dialogOf(page).getByRole("button", { name: "Force push" }).click();
  await eventually(remoteHead, head(repo), "git: after forcing the remote has the amended commit", 60_000);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E2 Amend with a cleared summary is rejected; unticking changes nothing", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e2-leer" });
  const old = localCommit(repo);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.summary.inputValue(), "Notiz angeleg", "the message is loaded");
  await ui.summary.fill("   ");
  await ui.summary.focus();
  await press("Control+Enter");
  await ui.page.getByRole("alert").filter({ hasText: /summary is missing/ }).waitFor({ timeout: 5000 });
  equal(head(repo), old, "git: the commit is unchanged");
  // Message loaded unchanged, box unticked again: no commit, fields empty.
  await ui.summary.fill("Notiz angeleg");
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.checkbox("Amend last commit").getAttribute("aria-checked"), "false", "amend is unticked");
  equal(head(repo), old, "git: still unchanged");
  equal(amends(repo), 0, "git: no amend in the reflog");
  await ui.summary.fill("");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E3 Edit message with 500 characters, emoji, umlauts and several paragraphs", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e3-zeichen" });
  localCommit(repo);
  const tree = repo.git("rev-parse", "HEAD^{tree}");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await selectCommit(tabId, head(repo));
  const e = editor();
  await e.open.click();
  const long = `Größenänderung 🌦️ „Übersicht“ – ${"Plausibilitätsprüfung der Messreihe Süd überarbeitet, ".repeat(12)}`.slice(0, 500);
  const text = "Erster Absatz mit ÄÖÜ äöü ß und 👨‍👩‍👧.\n\nZweiter Absatz:\n- Punkt eins\n- Punkt zwei mit `Code` und <b>HTML</b>\n\n# Raute bleibt";
  await e.summary.fill(long);
  await e.description.fill(text);
  equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "500 characters in the editor do not break the page");
  await press("Control+Enter");
  await ui.waitToast("success", /Message changed/);
  equal(subject(repo), long, "git: 500 characters with emoji and umlauts exact to the character");
  equal(body(repo), text, "git: description exact to the character");
  equal(repo.git("rev-parse", "HEAD^{tree}"), tree, "git: content unchanged");
  await eventually(() => page.locator(`${PANEL} [data-testid="commit-summary"]`).innerText(), long, "the panel shows the whole new summary");
  equal(await page.locator(`${PANEL} [data-testid="commit-description"] b`).count(), 0, "HTML in the description is not rendered as HTML");
  equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no page overflow");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E4a HEAD moves from outside while the message editor is open: the editor closes, nothing is rewritten", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e4a-aussen" });
  const a = localCommit(repo, { message: "Commit A" });
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await selectCommit(tabId, a);
  const e = editor();
  await e.open.click();
  await e.summary.fill("Commit A, neu formuliert");
  // Someone commits in the terminal; the app notices (file watcher) without a window switch.
  writeFile(repo, "b.md", "von außen\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Commit B von außen");
  const b = head(repo);
  await eventually(() => e.summary.count(), 0, "the editor closes as soon as the commit is no longer the last one", 20_000);
  equal(await e.open.count(), 0, "“Edit message” is no longer offered for commit A");
  equal([head(repo), subject(repo)], [b, "Commit B von außen"], "git: commit B is unchanged");
  equal(repo.git("log", "-1", "--format=%s", "HEAD~1"), "Commit A", "git: commit A is unchanged");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
// BUG B-04: “Edit message” calls the core without the SHA of the commit the editor shows. If a commit
// from outside arrives between opening and saving and the user saves before the file watcher closes
// the editor, the FOREIGN new commit gets the message written for commit A.
await section(
  "F12-E4b Saving right after a commit from outside: the message does not land on the wrong commit",
  async () => {
    const { app, ui, page } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e4b-wettlauf" });
    const a = localCommit(repo, { message: "Commit A" });
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await selectCommit(tabId, a);
    const e = editor();
    await e.open.click();
    await e.summary.fill("Commit A, neu formuliert");
    await e.summary.focus();
    writeFile(repo, "b.md", "von außen\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Commit B von außen");
    await press("Control+Enter"); // right away, before the app has noticed the new commit
    await sleep(2500);
    await app.settle();
    const subjects = lines(repo.git("log", "-2", "--format=%s"));
    const failed = !equal(subjects[0], "Commit B von außen", `git: the commit created from outside keeps its message (history: ${JSON.stringify(subjects)})`);
    await flow.bugShot("B-04", failed);
    check(subjects[1] === "Commit A" || subjects[1] === "Commit A, neu formuliert", `git: commit A lies below it (${JSON.stringify(subjects)})`);
    equal(count(repo), 5, "git: five commits – none lost, none duplicated");
    const texts = (await toastsOf(page)).join(" | ");
    console.log(`  toasts: ${texts || "(none)"}`);
    await tidy(flow);
  },
  { bug: "B-04" },
);

// ---------------------------------------------------------------------------------------------
// BUG B-05: If “Amend last commit” is ticked and the last commit changes (commit in the terminal, pull), the
// form keeps the message of the OLD last commit. “Amend commit” then writes it over the new last commit –
// whose own message is lost without the user having typed anything.
await section(
  "F12-E5 Amend ticked, HEAD moves from outside: “Amend commit” does not overwrite the new last commit's message",
  async () => {
    const { app, ui, page } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e5-amend-aussen" });
    localCommit(repo, { message: "Commit A" });
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await ui.checkbox("Amend last commit").click();
    await eventually(() => ui.summary.inputValue(), "Commit A", "amend loads the message of commit A");
    writeFile(repo, "b.md", "von außen\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Commit B von außen", "-m", "Mit eigener Beschreibung.");
    const b = head(repo);
    await eventually(async () => (await ui.status(repoId))?.head?.sha ?? null, b, "the app knows the new last commit", 20_000);
    await app.settle();
    await sleep(800);
    const shown = { summary: await ui.summary.inputValue(), amend: await ui.checkbox("Amend last commit").getAttribute("aria-checked") };
    // Expected: the untouched default follows the new last commit – or the box gets unticked.
    const sane = shown.amend === "false" || shown.summary === "Commit B von außen";
    const failed = !check(sane, `after the commit from outside the form no longer shows commit A's message as default for the new last commit (got: ${JSON.stringify(shown)})`);
    await flow.bugShot("B-05", failed);
    // What the user now triggers with one click:
    if (shown.amend === "true") {
      await ui.commitButton.click();
      await ui.waitToast("success", /Commit amended/);
      equal([subject(repo), body(repo)], ["Commit B von außen", "Mit eigener Beschreibung."], "git: “Amend commit” without own input leaves commit B's message unchanged");
      equal(repo.git("log", "-1", "--format=%s", "HEAD~1"), "Commit A", "git: commit A lies unchanged below it");
    }
    void page;
    await tidy(flow);
  },
  { bug: "B-05" },
);

// ---------------------------------------------------------------------------------------------
await section("F12-E6 Double Ctrl+Enter when saving and double click on “Amend commit”: exactly one change", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e6-doppelt" });
  localCommit(repo);
  writeHook(repo, "commit-msg", "sleep 2\nexit 0");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await selectCommit(tabId, head(repo));
  const e = editor();
  await e.open.click();
  await e.summary.fill("Notiz angelegt");
  await e.summary.focus();
  await press("Control+Enter");
  await press("Control+Enter");
  await ui.waitToast("success", /Message changed/, 30_000);
  await sleep(1000);
  equal(amends(repo), 1, "git reflog: double Ctrl+Enter changes the message exactly once");
  equal(subject(repo), "Notiz angelegt", "git: new message");
  equal(await toastsOf(page, "danger"), [], "no error message");
  equal((await toastsOf(page, "success")).length, 1, "exactly one success toast");
  await ui.closeToasts();

  await selectWip(tabId);
  writeFile(repo, "notiz.md", "erste Fassung\nNachtrag\n");
  await ui.refresh();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.summary.inputValue(), "Notiz angelegt", "amend loads the message");
  await page.getByRole("button", { name: "Stage all", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
  await ui.commitButton.dblclick();
  await ui.waitToast("success", /Commit amended/, 30_000);
  await sleep(1000);
  equal(amends(repo), 2, "git reflog: double click on “Amend commit” amends exactly once");
  equal(count(repo), 4, "git: no additional commit");
  equal(await toastsOf(page, "danger"), [], "no error message");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section(
  "F12-E8 Restart the app with amend ticked: checkbox and started message are back",
  async () => {
    const dataDir = flow.tempDir("gc-e2e-b-f12-data-");
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e8-neustart" });
    const old = localCommit(repo);
    await flow.start({ dataDir });
    let { app, ui } = flow;
    let { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await ui.checkbox("Amend last commit").click();
    await eventually(() => ui.summary.inputValue(), "Notiz angeleg", "the message is loaded");
    await ui.summary.click();
    await flow.page.keyboard.press("End");
    await flow.page.keyboard.type("t (halb fertig)");
    await eventually(() => app.invoke("draft_get", { repoId }), { summary: "Notiz angelegt (halb fertig)", description: "", amend: true }, "the draft including the amend checkbox is saved in the core");
    equal(app.consoleErrors, [], "console errors before the restart");
    await flow.stop();

    await flow.start({ dataDir });
    ({ app, ui } = flow);
    ({ repoId } = await app.openRepo(repo.path));
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await eventually(() => ui.checkbox("Amend last commit").getAttribute("aria-checked"), "true", "after the restart the box is ticked");
    await eventually(() => ui.summary.inputValue(), "Notiz angelegt (halb fertig)", "the started message is back");
    await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Amend commit", "the button reads “Amend commit”");
    equal(head(repo), old, "git: nothing has changed so far");
    await ui.summary.fill("Notiz angelegt");
    await ui.commitButton.click();
    await ui.waitToast("success", /Commit amended/);
    equal([count(repo), subject(repo)], [4, "Notiz angelegt"], "git: the last commit is amended, no new one created");
    await tidy(flow);
  },
  { launch: false },
);
await flow.stop();

// ---------------------------------------------------------------------------------------------
await section("F12-E9 Two windows: message changed in A – B shows it and can then change the same commit itself", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e9-zwei" });
  const old = localCommit(repo);
  const a = await app.openRepo(repo.path);
  await ui.waitCounts(a.repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  const other = await flow.second();
  try {
    const b = await other.app.openRepo(repo.path);
    const pageB = other.app.page;
    await pageB.evaluate(([id, commit]) => window.__gc.store.getState().selectCommits(id, [commit]), [b.tabId, old]);
    await pageB.locator(`${PANEL} [data-testid="commit-summary"]`).waitFor({ timeout: 10_000 });
    await selectCommit(a.tabId, old);
    const e = editor();
    await e.open.click();
    await e.summary.fill("Notiz angelegt (aus A)");
    await e.save.click();
    await ui.waitToast("success", /Message changed/);
    const renamed = head(repo);
    // B: the graph shows the new message; the old commit is no longer offered for editing.
    await eventually(() => pageB.locator('[data-screen="commit-graph"]').getByText("Notiz angelegt (aus A)", { exact: true }).count().then((n) => n > 0), true, "B: the graph shows the new message", 20_000);
    await eventually(() => pageB.locator('[data-screen="commit-graph"]').getByText("Notiz angeleg", { exact: true }).count(), 0, "B: the old message is no longer in the graph", 20_000);
    await eventually(() => pageB.locator(PANEL).getByRole("button", { name: "Edit message" }).count(), 0, "B: there is no “Edit message” for the replaced commit anymore", 20_000);
    // B selects the new commit and changes it in turn.
    await pageB.evaluate(([id, commit]) => window.__gc.store.getState().selectCommits(id, [commit]), [b.tabId, renamed]);
    await pageB.locator(PANEL).getByRole("button", { name: "Edit message" }).click();
    await pageB.locator(PANEL).getByRole("textbox", { name: "Summary" }).fill("Notiz angelegt (aus B)");
    await pageB.locator(PANEL).getByRole("button", { name: "Save" }).click();
    await other.ui.waitToast("success", /Message changed/);
    equal(subject(repo), "Notiz angelegt (aus B)", "git: the message from B");
    equal(count(repo), 4, "git: no additional commit");
    await eventually(() => page.locator('[data-screen="commit-graph"]').getByText("Notiz angelegt (aus B)", { exact: true }).count().then((n) => n > 0), true, "A: the graph shows the message from B", 20_000);
    equal(other.app.consoleErrors, [], "B: console errors");
  } finally {
    await other.app.close();
  }
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E12 Undo after amend and after “Edit message”: the old commit is back, nothing is lost", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e12-undo" });
  const old = localCommit(repo);
  writeFile(repo, "notiz.md", "erste Fassung\nNachtrag\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.summary.inputValue(), "Notiz angeleg", "message loaded");
  await ui.summary.fill("Notiz angelegt");
  await ui.commitButton.click({ modifiers: ["Shift"] });
  await ui.waitToast("success", /Commit amended/);
  check(head(repo) !== old, "git: commit replaced");
  await ui.closeToasts();
  const undo = toolbar("Undo");
  await eventually(async () => (await undo.getAttribute("aria-disabled")) ?? "false", "false", "Undo is available");
  await undo.hover();
  await page.getByRole("tooltip").filter({ hasText: /amend of/ }).first().waitFor({ timeout: 5000 }).catch(() => check(false, "the Undo tooltip names the amend"));
  await undo.click();
  await ui.waitToast("success", /Undone/);
  equal(head(repo), old, "git: after undo the old commit is the last one again");
  equal(subject(repo), "Notiz angeleg", "git: with the old message");
  equal(readFile(repo, "notiz.md"), "erste Fassung\nNachtrag\n", "file: the addition is still in the working tree");
  check(repo.git("status", "--porcelain").includes("notiz.md"), `git status: the addition is an open change again (${repo.git("status", "--porcelain")})`);
  await ui.closeToasts();

  // Edit message, then undo.
  await selectCommit(tabId, old);
  const e = editor();
  await e.open.click();
  await e.summary.fill("Ganz anderer Text");
  await e.save.click();
  await ui.waitToast("success", /Message changed/);
  check(head(repo) !== old, "git: commit replaced");
  await ui.closeToasts();
  await eventually(async () => (await undo.getAttribute("aria-disabled")) ?? "false", "false", "Undo is available");
  await app.settle();
  await undo.click();
  await ui.waitToast("success", /Undone/);
  equal([head(repo), subject(repo)], [old, "Notiz angeleg"], "git: after undo the old commit with the old message is back");
  equal(readFile(repo, "notiz.md"), "erste Fassung\nNachtrag\n", "file: still with the addition");
  await selectWip(tabId);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E13 Minimum window 960×600: message editor with “already pushed” hint and amend form fully visible", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e13-klein" });
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await app.setSize(960, 600);
  await selectCommit(tabId, head(repo));
  const e = editor();
  await e.open.click();
  await e.panel.getByRole("status").filter({ hasText: "already been pushed" }).waitFor({ timeout: 5000 });
  await e.description.fill("Zeile 1\nZeile 2\nZeile 3\nZeile 4\nZeile 5\nZeile 6\nZeile 7\nZeile 8\nZeile 9\nZeile 10");
  const inside = async (locator, what) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960.5 && box.y + box.height <= 600.5, `${what} lies fully inside the window (${JSON.stringify(box)})`);
  };
  await inside(e.save, "“Save”");
  await inside(e.panel.getByRole("button", { name: "Cancel" }), "“Cancel”");
  await inside(e.summary, "summary");
  equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no horizontal overflow");
  equal(await e.panel.evaluate((panel) => panel.scrollWidth - panel.clientWidth), 0, "the panel does not overflow");
  await e.panel.getByRole("button", { name: "Cancel" }).click();
  await selectWip(tabId);
  await ui.checkbox("Amend last commit").click();
  await ui.page.getByText(/already been pushed/).waitFor({ timeout: 5000 });
  const box = await ui.commitButton.boundingBox();
  check(box && box.y + box.height <= 600.5 && box.x + box.width <= 960.5, `the “Amend commit” button lies inside the window with the hint (${JSON.stringify(box)})`);
  await eventually(ui.overflow, { page: 0, panel: 0 }, "no overflow in the amend form");
  await ui.checkbox("Amend last commit").click();
  await app.setSize(1440, 900);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E15 Screen reader: editor as a named form, labelled fields, linked hints", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e15-a11y" });
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await selectCommit(tabId, head(repo));
  const e = editor();
  await e.open.focus();
  await press("Enter");
  await e.summary.waitFor({ timeout: 5000 });
  equal(await page.getByRole("form", { name: "Edit message", exact: true }).count(), 1, "the editor is a form named “Edit message”");
  equal(await ui.focusedLabel().then((label) => label ?? ""), await e.summary.evaluate((input) => input.getAttribute("aria-label") ?? input.textContent?.trim().slice(0, 60) ?? input.tagName), "focus is in the “Summary” field");
  equal(await e.panel.getByRole("status").filter({ hasText: "already been pushed" }).count(), 1, "the “already pushed” hint is marked up as status");
  // Error on the field: linked and announced.
  await e.summary.fill("");
  await press("Control+Enter");
  const alert = e.panel.getByRole("alert").filter({ hasText: "The summary must not be empty." });
  await alert.waitFor({ timeout: 5000 });
  const describedBy = await e.summary.getAttribute("aria-describedby");
  equal(describedBy ? await page.locator(`[id="${describedBy}"]`).innerText() : null, "The summary must not be empty.", "the field's aria-describedby points to the error message");
  equal(await unnamedControls(page, PANEL), [], "every control of the commit details has a name");
  equal(await axeViolations(page, PANEL), [], "axe: no violations in the commit details with the editor open");
  await press("Escape");
  await eventually(() => e.summary.count(), 0, "Esc closes the editor");
  await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Edit message", "focus returns to “Edit message”");

  // Amend checkbox: the hint is attached to the checkbox for screen readers.
  await selectWip(tabId);
  const amend = ui.checkbox("Amend last commit");
  await amend.click();
  await ui.page.getByText(/already been pushed/).waitFor({ timeout: 5000 });
  // The hint is in the checkbox's <label> and thus part of its name (or attached via aria-describedby).
  const hint = await amend.evaluate((box) => {
    const described = (box.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "");
    return [document.querySelector(`label[for="${box.id}"]`)?.textContent ?? "", ...described].join(" ");
  });
  check(/Amend last commit/.test(hint) && /already been pushed/.test(hint), `screen readers hear the “already pushed” hint together with the checkbox (got: “${hint}”)`);
  equal(await page.getByRole("form", { name: "Amend last commit", exact: true }).count(), 1, "in amend mode the form is called “Amend last commit”");
  await amend.click();
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-E16 Special cases: merge commit as last commit, only commit (root), detached HEAD", async () => {
  const { app, ui } = flow;
  // Merge commit: both parents stay.
  const merged = await flow.fixture(makeCleanRepoWithRemote, { name: "e16-merge" });
  merged.git("merge", "-q", "--no-ff", "-m", "Merge von feature/export", "feature/export");
  const parents = merged.git("log", "-1", "--format=%P");
  const tree = merged.git("rev-parse", "HEAD^{tree}");
  equal(parents.split(" ").length, 2, "initial state: merge commit with two parents");
  let opened = await app.openRepo(merged.path);
  await ui.waitCounts(opened.repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await selectCommit(opened.tabId, head(merged));
  const e = editor();
  await e.open.click();
  await e.summary.fill("Export zusammengeführt");
  await e.save.click();
  await ui.waitToast("success", /Message changed/);
  equal([subject(merged), merged.git("log", "-1", "--format=%P"), merged.git("rev-parse", "HEAD^{tree}")], ["Export zusammengeführt", parents, tree], "git: new message, same two parents, same content");
  await ui.closeToasts();

  // The repository's only commit.
  const single = await flow.fixture(makeEmptyRepo, { name: "e16-root" });
  single.git("add", "-A");
  single.git("commit", "-q", "-m", "Erster Comit");
  opened = await app.openRepo(single.path);
  await ui.waitCounts(opened.repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.summary.inputValue(), "Erster Comit", "message of the only commit loaded");
  await ui.summary.fill("Erster Commit");
  await ui.commitButton.click();
  await ui.waitToast("success", /Commit amended/);
  equal([count(single), subject(single), single.git("log", "-1", "--format=%P")], [1, "Erster Commit", ""], "git: still one commit without parents, new message");
  await ui.closeToasts();

  // Detached HEAD.
  const detached = await flow.fixture(makeDetachedRepo, { name: "e16-detached" });
  const main = detached.git("rev-parse", "main");
  const tag = detached.git("rev-parse", "v0.1.0");
  opened = await app.openRepo(detached.path);
  await ui.waitCounts(opened.repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.summary.inputValue(), "Messwerte aus CSV-Dateien einlesen", "message of the checked-out commit loaded");
  await ui.summary.fill("Messwerte aus CSV-Dateien einlesen (losgelöst geändert)");
  await ui.commitButton.click();
  await ui.waitToast("success", /Commit amended/);
  equal(detached.git("rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "git: HEAD is still detached");
  equal([detached.git("rev-parse", "main"), detached.git("rev-parse", "v0.1.0")], [main, tag], "git: main and the tag still point to the old commits");
  equal(subject(detached), "Messwerte aus CSV-Dateien einlesen (losgelöst geändert)", "git: the amended commit is HEAD");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-N1 Hook rejects the change (commit-msg): the old commit stays, the input stays", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n1-hook" });
  const old = localCommit(repo);
  writeHook(repo, "commit-msg", 'echo "Message abgelehnt: Ticketnummer fehlt" >&2\nexit 1');
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await selectCommit(tabId, old);
  const e = editor();
  await e.open.click();
  await e.summary.fill("Wird abgelehnt");
  await e.save.click();
  const toast = await ui.waitToast("danger", /hook|commit-msg/i, 30_000);
  check(/commit-msg/.test(toast ?? ""), `the toast names the hook (${toast})`);
  equal(head(repo), old, "git: the commit is unchanged");
  equal(await e.summary.inputValue().catch(() => null), "Wird abgelehnt", "the editor stays open, the input is still there");
  await sleep(600);
  equal((await toastsOf(page, "danger")).length, 1, "exactly one error message");
  await ui.closeToasts();
  await e.panel.getByRole("button", { name: "Cancel" }).click();

  // The same via amend in the commit panel.
  await selectWip(tabId);
  await ui.checkbox("Amend last commit").click();
  await eventually(() => ui.summary.inputValue(), "Notiz angeleg", "message loaded");
  await ui.summary.fill("Wird auch abgelehnt");
  await ui.commitButton.click();
  const second = await ui.waitToast("danger", /hook|commit-msg/i, 30_000);
  check(/commit-msg/.test(second ?? ""), `amend: the toast names the hook (${second})`);
  equal(head(repo), old, "git: the commit is unchanged");
  equal(await ui.summary.inputValue(), "Wird auch abgelehnt", "amend: the input stays");
  equal(await ui.checkbox("Amend last commit").getAttribute("aria-checked"), "true", "amend: the box stays ticked");
  // With “Skip Git hooks” it works.
  await ui.closeToasts();
  await ui.checkbox("Skip Git hooks").click();
  await ui.commitButton.click();
  await ui.waitToast("success", /Commit amended/);
  equal(subject(repo), "Wird auch abgelehnt", "git: without hooks the message is changed");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-N2 Merge in progress: the amend checkbox is disabled and says why", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeConflictRepo, { name: "n2-merge" });
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 2 });
  const amend = ui.checkbox("Amend last commit");
  check(await amend.isDisabled(), "amend is disabled during the merge");
  await page.getByText("Not possible while an operation is running.").waitFor({ timeout: 5000 });
  equal(await amend.getAttribute("aria-checked"), "false", "the box is not ticked");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F12-N3 Repository locked (.git/index.lock) when editing the message: understandable message, nothing changed", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n3-sperre" });
  const old = localCommit(repo);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await selectCommit(tabId, old);
  const e = editor();
  await e.open.click();
  await e.summary.fill("Während der Sperre");
  const lock = path.join(repo.path, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  try {
    await e.save.click();
    const toast = await ui.waitToast("danger", /Edit message failed/, 30_000);
    check(/index\.lock|locked|another program/i.test(toast ?? ""), `the toast explains the lock (${toast})`);
  } finally {
    fs.rmSync(lock, { force: true });
  }
  equal(head(repo), old, "git: the commit is unchanged");
  equal(await e.summary.inputValue().catch(() => null), "Während der Sperre", "the editor stays open, the input is still there");
  await ui.closeToasts();
  await e.save.click();
  await ui.waitToast("success", /Message changed/);
  equal(subject(repo), "Während der Sperre", "git: without the lock editing works");
  equal(await toastsOf(page, "danger"), [], "no error message anymore");
  await tidy(flow);
});

void noDialog;
process.exit(await flow.finish());
