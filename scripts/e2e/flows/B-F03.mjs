/**
 * Flow F03 – committing changes (the core loop): the cases not yet covered by a script under
 * scripts/e2e/screens. Real app, real repositories, local test servers.
 *
 *   node scripts/e2e/flows/B-F03.mjs                  everything
 *   node scripts/e2e/flows/B-F03.mjs --only E13,N3    only sections whose title contains "E13" or "N3"
 *   node scripts/e2e/flows/B-F03.mjs --show           visible window
 *
 * Already covered elsewhere: happy path with the mouse and keyboard only, nothing staged, empty
 * message, pre-commit hook, open conflict, no author, draft across a restart, push after commit
 * (pushed / rejected) – all in scripts/e2e/screens/commit-panel.mjs and keyboard.mjs.
 *
 * Every section checks the repository itself (git log, git status, file content) and ends with
 * "no console errors". At the end comes the list of green and red sections.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { makeCleanRepoWithRemote, makeDetachedRepo } from "../fixtures.mjs";
import { startGitHttpServer } from "../git-http-server.mjs";
import { axeViolations, createFlow, dialogOf, dialogTitle, diffReady, exists, focusVisible, lines, noDialog, readFile, sleep, tidy, toastsOf, unnamedControls, writeFile, writeHook } from "./B-lib.mjs";

const flow = createFlow("B-F03");
const { check, equal, eventually, until, section } = flow;
const press = (keys) => flow.page.keyboard.press(keys);
const count = (repo) => Number(repo.git("rev-list", "--count", "HEAD"));
const cached = (repo) => lines(repo.git("-c", "core.quotepath=false", "diff", "--cached", "--name-only")).sort();
const subject = (repo) => repo.git("log", "-1", "--format=%s");
const selectWip = (tabId) => flow.page.evaluate((id) => window.__gc.store.getState().selectWip(id), tabId);
const selectCommit = (tabId, sha) => flow.page.evaluate(([id, commit]) => window.__gc.store.getState().selectCommits(id, [commit]), [tabId, sha]);

/** TCP forwarder that only connects each new connection after `delayMs` – a slow network. */
async function startDelayProxy(targetPort, delayMs) {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((client) => {
    connections += 1;
    sockets.add(client);
    client.pause();
    let upstream = null;
    const end = () => {
      client.destroy();
      upstream?.destroy();
    };
    const timer = setTimeout(() => {
      upstream = net.connect(targetPort, "127.0.0.1");
      sockets.add(upstream);
      upstream.on("error", end);
      upstream.on("close", end);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    }, delayMs);
    client.on("error", end);
    client.on("close", () => {
      clearTimeout(timer);
      end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    connections: () => connections,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
await section("F03-H4 WIP row in the graph → view diff → Stage all → message → commit (mouse)", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h4-graph" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nStand: Auswertung für April begonnen.\n`);
  writeFile(repo, "notizen/april.md", "# April\n\n- Station Süd kalibrieren\n");
  const before = repo.git("rev-parse", "HEAD");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  // A commit is shown in the panel first – the path starts at the WIP row.
  await selectCommit(tabId, before);
  await page.locator('[data-screen="commit-details"]').waitFor({ timeout: 8000 });
  const wipRow = page.locator('[data-screen="commit-graph"] [data-row-kind="wip"]');
  check(/2 changed files/.test((await wipRow.innerText()).replace(/\s+/g, " ")), `the WIP row shows the number of changed files (${(await wipRow.innerText()).replace(/\s+/g, " ")})`);
  await wipRow.click(); // click 1
  await page.locator('[data-screen="commit-panel"]').waitFor({ timeout: 8000 });
  equal((await ui.view(tabId)).selection, { kind: "wip" }, "clicking the WIP row shows the local changes");
  // Optional: view the diff (does not count towards the three clicks).
  await ui.row("unstaged", "README.md").click();
  await diffReady(app, "README.md");
  check((await page.locator('[data-screen="diff"]').innerText()).includes("Auswertung für April begonnen"), "the diff shows the new line");
  await page.getByRole("button", { name: "Stage all", exact: true }).click(); // click 2
  await ui.waitCounts(repoId, { unstaged: 0, staged: 2, conflicted: 0 }, "“Stage all”");
  await ui.summary.click();
  await page.keyboard.type("April-Auswertung vorbereitet");
  await ui.commitButton.click(); // click 3
  const toast = await ui.waitToast("success", /Commit created/);
  const head = repo.git("rev-parse", "HEAD");
  check(head !== before, "git: HEAD has moved");
  check(toast?.includes(head.slice(0, 7)), `the toast names the new commit (${toast})`);
  equal(subject(repo), "April-Auswertung vorbereitet", "git: Summary");
  equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")).sort(), ["README.md", "notizen/april.md"], "git: both files in the commit");
  equal(repo.git("rev-parse", "HEAD~1"), before, "git: exactly one new commit on top of the old HEAD");
  equal(repo.git("status", "--porcelain"), "", "git: working tree clean");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  // The diff opened earlier is still in the center (see section F03-E23, BUG B-01) – close it by hand here.
  await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
  await eventually(async () => (await wipRow.locator('[data-cell="message"]').innerText({ timeout: 3000 }).catch(() => "")).replace(/\s+/g, " ").trim(), "No changes", "the WIP row shows “No changes” again");
  await eventually(() => page.locator('[data-screen="commit-graph"]').getByText("April-Auswertung vorbereitet").count().then((found) => found > 0), true, "the new commit is in the graph");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
// BUG B-01: After “Stage all” (and after the commit) the open diff of a file stays although nothing is
// left under “Unstaged”: header “M modified … Unstaged”, no content changes. The graph with the new
// commit stays hidden. When staging a single file (S, button in the row) the diff instead moves on to
// the next file or closes.
await section(
  "F03-E23 Open diff after “Stage all” and commit: the center shows no stale diff, the new commit is visible",
  async () => {
    const { app, ui, page } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e23-diff" });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    writeFile(repo, "zwei.txt", "zwei\n");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await ui.row("unstaged", "README.md").click();
    await diffReady(app, "README.md");
    await page.getByRole("button", { name: "Stage all", exact: true }).click();
    await ui.waitCounts(repoId, { unstaged: 0, staged: 2, conflicted: 0 });
    await app.settle();
    await sleep(600);
    const afterStage = (await ui.view(tabId)).center;
    const staleText = (await page.locator('[data-screen="diff"]').innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ");
    // Expected: the diff follows the file to “Staged” (as when staging a single file) or closes.
    const followed = afterStage.kind === "graph" || (afterStage.kind === "diff" && afterStage.source?.kind === "staged");
    check(followed, `after “Stage all” the center shows the staged diff or the graph – got: ${JSON.stringify(afterStage)}, text: “${staleText.slice(0, 160)}”`);
    await ui.summary.fill("Beide Dateien");
    await ui.commitButton.click();
    await ui.waitToast("success", /Commit created/);
    await app.settle();
    await sleep(600);
    const afterCommit = (await ui.view(tabId)).center;
    const failed = !check(afterCommit.kind === "graph", `after the commit the center shows the graph with the new commit again – got: ${JSON.stringify(afterCommit)}`);
    const header = (await page.locator('[data-screen="diff"]').innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ");
    check(!/modified README\.md/.test(header), `after the commit README.md is no longer shown as “modified … Unstaged” (got: “${header.slice(0, 160)}”)`);
    await flow.bugShot("B-01", failed);
    equal(repo.git("log", "-1", "--format=%s"), "Beide Dateien", "git: the commit itself is fine");
    await tidy(flow);
  },
  { bug: "B-01" },
);

// ---------------------------------------------------------------------------------------------
await section("F03-E4 Detached HEAD: commit is created without a branch, banner stays, main unchanged", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeDetachedRepo, { name: "e4-detached" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nIm Detached HEAD geändert.\n`);
  const main = repo.git("rev-parse", "main");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.panel.getByText("No branch checked out (detached HEAD)").waitFor({ timeout: 5000 });
  await ui.summary.fill("Commit ohne Branch");
  await press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(subject(repo), "Commit ohne Branch", "git: the commit exists");
  equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "git: HEAD is still detached");
  equal(repo.git("rev-parse", "HEAD~1"), repo.info.sha, "git: the commit sits on the checked-out commit");
  equal(repo.git("rev-parse", "main"), main, "git: main is unchanged");
  equal(await ui.panel.getByText("No branch checked out (detached HEAD)").count(), 1, "the banner stays");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E7 Empty input: only spaces, and description without summary", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e7-leer" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
  const before = count(repo);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await press("Control+Shift+S");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
  await ui.summary.fill("     ");
  await press("Control+Enter");
  await ui.page.getByRole("alert").filter({ hasText: /summary is missing/ }).waitFor({ timeout: 5000 });
  equal(count(repo), before, "git: no commit with a message of spaces");
  await ui.summary.fill("");
  await ui.description.fill("Nur eine Beschreibung, keine Zusammenfassung.");
  await ui.commitButton.click();
  await ui.page.getByRole("alert").filter({ hasText: /summary is missing/ }).waitFor({ timeout: 5000 });
  equal(await ui.summary.getAttribute("aria-invalid"), "true", "the field is marked invalid");
  equal(count(repo), before, "git: no commit without a summary");
  equal(await ui.description.inputValue(), "Nur eine Beschreibung, keine Zusammenfassung.", "the description stays");
  equal(cached(repo), ["README.md"], "git: the file stays staged");
  await ui.summary.fill("");
  await ui.description.fill("");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E8 Very long input: 500-character summary, 6000-character description", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e8-lang" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const long = "Plausibilitätsprüfung der Messreihe Süd überarbeitet, ".repeat(12).slice(0, 500);
  equal([...long].length, 500, "test data: 500 characters");
  const body = Array.from({ length: 100 }, (_, index) => `Zeile ${String(index + 1).padStart(3, "0")}: Messwerte der Station Süd geprüft, Ausreißer markiert.`).join("\n");
  check(body.length > 6000, "test data: description over 6000 characters");
  await ui.summary.fill(long);
  await ui.description.fill(body);
  equal(await page.locator("form span[aria-hidden]", { hasText: "/72" }).textContent(), "500/72", "counter shows 500/72");
  equal(await ui.overflow(), { page: 0, panel: 0 }, "500 characters do not break the layout");
  await press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(subject(repo), long, "git: 500 characters taken over unchanged");
  equal(repo.git("log", "-1", "--format=%b").trim(), body, "git: description taken over unchanged");
  // The success toast with 500 characters stays inside the window.
  const box = await page.locator('[data-toast="success"]').first().boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 1440 && box.height < 400, `the toast with the long summary stays inside the window and compact (${JSON.stringify(box)})`);
  equal(await ui.overflow(), { page: 0, panel: 0 }, "no overflow with the toast either");
  await ui.closeToasts();
  // The long commit in the details and the graph: no overflow.
  await selectCommit(tabId, repo.git("rev-parse", "HEAD"));
  await page.locator('[data-screen="commit-details"] [data-testid="commit-summary"]').waitFor({ timeout: 8000 });
  equal(await page.locator('[data-screen="commit-details"] [data-testid="commit-summary"]').innerText(), long, "the details show the whole summary");
  equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no horizontal page overflow");
  await selectWip(tabId);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E9 Emoji, umlauts and special characters in the message (typed and pasted)", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e9-zeichen" });
  writeFile(repo, "a.txt", "a\n");
  writeFile(repo, "b.txt", "b\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });

  // 1. Typed: umlauts, ß, emoji (including composed ones), typographic characters, backslashes, HTML.
  const summary = "Größenänderung 🌦️ „Übersicht“ – 100 % 'fertig' \\ \"ok\" <b>&amp; 👨‍👩‍👧 Straße";
  const description = "# Raute am Zeilenanfang bleibt stehen\n\tTab am Anfang\nÄÖÜ äöü ß · 日本語 · עברית\n\n- Liste mit --flag und $VAR und `Backticks`\n%s %H %%";
  await ui.row("unstaged", "a.txt").click();
  await press("s");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 });
  await ui.summary.click();
  await page.keyboard.insertText(summary);
  await ui.description.click();
  await page.keyboard.insertText(description);
  equal(await ui.summary.inputValue(), summary, "the field shows the characters unchanged");
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(subject(repo), summary, "git: summary exact to the character");
  equal(repo.git("log", "-1", "--format=%b").replace(/\n+$/, ""), description, "git: description exact to the character (including the line with #)");
  equal(repo.git("log", "-1", "--format=%e"), "", "git: no different encoding in the commit (UTF-8)");
  const toast = (await toastsOf(page, "success")).join(" ");
  check(toast.includes("🌦️") && toast.includes("„Übersicht“") && !toast.includes("&amp;amp;"), `the toast shows the characters correctly (${toast})`);
  check(!(await page.locator('[data-toast] b').count()), "HTML in the message is not rendered as HTML");
  await ui.closeToasts();

  // 2. Leading and trailing spaces, line break in the summary (pasted).
  await press("Control+Shift+S");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
  await ui.summary.fill("  Zwei Zeilen\nin einer Zusammenfassung  ");
  equal(await ui.summary.inputValue(), "  Zwei Zeilen in einer Zusammenfassung  ", "a pasted line break becomes a space in the summary");
  await ui.description.fill("\n\nBeschreibung mit Leerzeilen davor und danach\n\n\n");
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(subject(repo), "Zwei Zeilen in einer Zusammenfassung", "git: summary without surrounding spaces");
  equal(repo.git("log", "-1", "--format=%b").trim(), "Beschreibung mit Leerzeilen davor und danach", "git: description");
  equal(repo.git("status", "--porcelain"), "", "git: clean");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E10 File names with emoji, umlauts, spaces and 150 characters: stage, commit", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e10-namen" });
  const names = [
    "notizen/Übersicht 🌦 März.txt",
    "mit leerzeichen/a b  c.txt",
    "größe/ß-straße/ÄÖÜ.md",
    `lang/${"messreihe-station-nord-".repeat(6)}ende.csv`,
    "klammern [1] (kopie) & co #1 'x'.txt",
  ];
  check(names[3].length > 140, "test data: path over 140 characters");
  for (const name of names) writeFile(repo, name, `Inhalt von ${name}\n`);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: names.length, staged: 0, conflicted: 0 });
  equal((await ui.rows("unstaged")).sort(), [...names].sort(), "the list shows all names unchanged (no octal escaping)");
  equal(await ui.overflow(), { page: 0, panel: 0 }, "long and special names do not break the panel");
  // Stage one by one: button in the row, key S, context menu.
  await ui.row("unstaged", names[0]).hover();
  await ui.row("unstaged", names[0]).getByRole("button", { name: "Stage" }).click();
  await ui.waitCounts(repoId, { unstaged: names.length - 1, staged: 1, conflicted: 0 }, "the button stages the file with emoji");
  equal(cached(repo), [names[0]], "git: file with emoji, umlaut and spaces staged");
  await ui.row("unstaged", names[4]).click();
  await page.evaluate(() => window.__gc.store.getState().closeCenter(Object.keys(window.__gc.store.getState().views)[0]));
  await ui.row("unstaged", names[4]).focus();
  await press("s");
  await ui.waitCounts(repoId, { unstaged: names.length - 2, staged: 2, conflicted: 0 }, "S stages the file with brackets and hash");
  await ui.row("unstaged", names[3]).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Stage/ }).click();
  await ui.waitCounts(repoId, { unstaged: names.length - 3, staged: 3, conflicted: 0 }, "the context menu stages the file with the long path");
  equal(cached(repo), [names[0], names[3], names[4]].sort(), "git: three files staged");
  // Unstage and stage everything.
  await ui.row("staged", names[0]).focus();
  await press("u");
  await ui.waitCounts(repoId, { unstaged: names.length - 2, staged: 2, conflicted: 0 }, "U unstages the emoji file");
  await press("Control+Shift+S");
  await ui.waitCounts(repoId, { unstaged: 0, staged: names.length, conflicted: 0 });
  await ui.summary.fill("Dateien mit besonderen Namen");
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(lines(repo.git("-c", "core.quotepath=false", "show", "--name-only", "--format=", "HEAD")).sort(), [...names].sort(), "git: all files with their names in the commit");
  equal(repo.git("show", `HEAD:${names[0]}`), `Inhalt von ${names[0]}`, "git: content of the emoji file");
  equal(repo.git("status", "--porcelain"), "", "git: clean");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E11 Changed from outside while the app is open: new file, git add, git commit, git reset (no window switch)", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e11-aussen" });
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await ui.summary.fill("Entwurf während der Arbeit im Terminal");
  // No ui.refresh(): the file watcher alone has to notice.
  writeFile(repo, "extern.txt", "von außen\n");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "a new file from outside appears by itself", 20_000);
  repo.git("add", "extern.txt");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "git add from outside: the file moves to “Staged”", 20_000);
  await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Commit 1 file", "the primary button follows");
  repo.git("commit", "-q", "-m", "Commit aus dem Terminal");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 }, "git commit from outside: the lists are empty", 20_000);
  const head = repo.git("rev-parse", "HEAD");
  await eventually(async () => (await ui.status(repoId))?.head?.sha ?? null, head, "the app state knows the new HEAD", 20_000);
  equal(await ui.summary.inputValue(), "Entwurf während der Arbeit im Terminal", "the own draft stays");
  repo.git("reset", "-q", "--soft", "HEAD~1");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "git reset --soft from outside: the file is staged again", 20_000);
  // Now commit in the app: exactly one commit is created on the current HEAD.
  const before = count(repo);
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(count(repo), before + 1, "git: exactly one new commit");
  equal(subject(repo), "Entwurf während der Arbeit im Terminal", "git: with the draft as message");
  equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")), ["extern.txt"], "git: the file staged from outside is in the commit");
  void tabId;
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E12 Same repository in two windows: staging and committing in one shows up in the other", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e12-zwei" });
  writeFile(repo, "eins.txt", "eins\n");
  writeFile(repo, "zwei.txt", "zwei\n");
  const a = await app.openRepo(repo.path);
  await ui.waitCounts(a.repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  const other = await flow.second();
  try {
    const b = await other.app.openRepo(repo.path);
    await other.ui.waitCounts(b.repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "window B shows the same state");
    // A stages, B sees it.
    await ui.row("unstaged", "eins.txt").click();
    await press("s");
    await ui.waitCounts(a.repoId, { unstaged: 1, staged: 1, conflicted: 0 });
    await other.ui.waitCounts(b.repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "B: the file staged in A is under “Staged”", 20_000);
    // Both type a message; B commits.
    await ui.summary.fill("Message aus Fenster A");
    await other.ui.summary.fill("Commit aus Fenster B");
    const before = count(repo);
    await other.ui.commitButton.click();
    await other.ui.waitToast("success", /Commit created/);
    equal(count(repo), before + 1, "git: one commit");
    equal(subject(repo), "Commit aus Fenster B", "git: message from B");
    // A shows the new state by itself; its own draft stays.
    await ui.waitCounts(a.repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "A: after the commit in B nothing is staged anymore", 20_000);
    equal(await ui.summary.inputValue(), "Message aus Fenster A", "A: its own draft stays");
    await eventually(async () => (await ui.commitButton.getAttribute("aria-disabled")) ?? null, "true", "A: commit is disabled (nothing staged)");
    // A tries to commit anyway: no second commit, a calm explanation.
    await press("Control+Enter");
    await ui.waitToast("info", /Nothing staged/);
    equal(count(repo), before + 1, "git: no second commit");
    equal(await toastsOf(flow.page, "danger"), [], "A: no error message");
    equal(other.app.consoleErrors, [], "B: console errors");
  } finally {
    await other.app.close();
  }
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E13 Double click and double Ctrl+Enter on submit: exactly one commit", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e13-doppelt" });
  // A slow hook keeps the first commit open for two seconds – the second trigger arrives in that time.
  writeHook(repo, "pre-commit", "sleep 2\nexit 0");
  writeFile(repo, "eins.txt", "eins\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await press("Control+Shift+S");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
  let before = count(repo);
  await ui.summary.fill("Doppelklick auf Commit");
  await ui.commitButton.dblclick();
  await eventually(() => ui.commitButton.getAttribute("aria-busy"), "true", "while the hook runs, the button shows the running operation", 4000);
  await ui.waitToast("success", /Commit created/, 30_000);
  await sleep(800);
  equal(count(repo), before + 1, "git: double click creates exactly one commit");
  equal(await toastsOf(page, "danger"), [], "no error message after the double click");
  equal((await toastsOf(page, "success")).length, 1, "exactly one success toast");
  await ui.closeToasts();

  writeFile(repo, "zwei.txt", "zwei\n");
  await ui.refresh();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  before = count(repo);
  await ui.summary.fill("Doppeltes Ctrl+Shift+Enter");
  await ui.summary.focus();
  await press("Control+Shift+Enter");
  await press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/, 30_000);
  await sleep(800);
  equal(count(repo), before + 1, "git: double Ctrl+Shift+Enter creates exactly one commit");
  equal(await toastsOf(page, "danger"), [], "no error message after the double key press");
  await ui.closeToasts();

  // Without the slow hook: the second key press arrives after the finished commit.
  fs.rmSync(path.join(repo.path, ".git", "hooks", "pre-commit"));
  writeFile(repo, "drei.txt", "drei\n");
  await ui.refresh();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await press("Control+Shift+S");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
  before = count(repo);
  await ui.summary.fill("Schnelles doppeltes Ctrl+Enter");
  await ui.summary.focus();
  await press("Control+Enter");
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/, 30_000);
  await sleep(1200);
  equal(count(repo), before + 1, "git: fast double Ctrl+Enter creates exactly one commit");
  equal(await toastsOf(page, "danger"), [], "no error message");
  equal(await page.getByRole("alert").filter({ hasText: /summary is missing/ }).count(), 0, "the second key press leaves no “summary is missing” error on the empty field");
  equal(repo.git("status", "--porcelain"), "", "git: clean");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E14 Cancel halfway: Esc in the field, stash form, another commit – draft and staging stay", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e14-abbruch" });
  writeFile(repo, "eins.txt", "eins\n");
  writeFile(repo, "zwei.txt", "zwei\n");
  const before = count(repo);
  const head = repo.git("rev-parse", "HEAD");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "eins.txt").hover();
  await ui.row("unstaged", "eins.txt").getByRole("button", { name: "Stage" }).click();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 });
  await ui.summary.click();
  await page.keyboard.type("Halb getippt");
  await ui.description.click();
  await page.keyboard.type("Zweite Zeile");
  // Esc in the field: nothing is lost, no commit.
  await press("Escape");
  equal(await ui.summary.inputValue(), "Halb getippt", "Esc does not clear the summary");
  equal(await ui.description.inputValue(), "Zweite Zeile", "Esc does not clear the description");
  // To the stash form and back.
  await page.getByRole("radio", { name: "Stash" }).click();
  await page.locator('[data-screen="stash-form"]').waitFor({ timeout: 5000 });
  await page.getByRole("radio", { name: "Commit" }).click();
  await page.locator('[data-screen="commit-panel"]').waitFor({ timeout: 5000 });
  equal(await ui.summary.inputValue(), "Halb getippt", "after the detour via the stash form the summary is still there");
  equal(await ui.description.inputValue(), "Zweite Zeile", "… and the description");
  // View a commit and go back to the local changes.
  await selectCommit(tabId, head);
  await page.locator('[data-screen="commit-details"]').waitFor({ timeout: 8000 });
  await eventually(() => page.locator('[data-screen="commit-panel"]').count(), 0, "the commit form is gone while a commit is selected");
  await selectWip(tabId);
  await page.locator('[data-screen="commit-panel"]').waitFor({ timeout: 8000 });
  await eventually(() => ui.summary.inputValue(), "Halb getippt", "back at the local changes the summary is still there");
  equal(await ui.description.inputValue(), "Zweite Zeile", "… and the description");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "the staging is unchanged");
  equal(cached(repo), ["eins.txt"], "git: eins.txt is still staged");
  equal(count(repo), before, "git: no commit created");
  await eventually(() => app.invoke("draft_get", { repoId }), { summary: "Halb getippt", description: "Zweite Zeile", amend: false }, "the draft is saved in the core");
  await ui.summary.fill("");
  await ui.description.fill("");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section(
  "F03-E15 Restart the app halfway: tab, staged files and draft are back afterwards",
  async () => {
    const dataDir = flow.tempDir("gc-e2e-b-f03-data-");
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e15-neustart" });
    writeFile(repo, "eins.txt", "eins\n");
    writeFile(repo, "zwei.txt", "zwei\n");
    await flow.start({ dataDir });
    let { app, ui } = flow;
    let { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await ui.row("unstaged", "zwei.txt").click();
    await flow.page.keyboard.press("s");
    await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 });
    await ui.summary.click();
    await flow.page.keyboard.type("Vor dem Neustart getippt");
    await eventually(() => app.invoke("draft_get", { repoId }).then((draft) => draft.summary), "Vor dem Neustart getippt", "the draft is saved");
    equal(app.consoleErrors, [], "console errors before the restart");
    await flow.stop();

    await flow.start({ dataDir });
    ({ app, ui } = flow);
    // “Remember tabs” is the default: the repository tab is back by itself.
    await eventually(() => flow.page.locator("[data-tab-id]").count().then((tabs) => tabs >= 1), true, "after the restart the repository tab is open again", 15_000);
    ({ repoId } = await app.openRepo(repo.path));
    await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "after the restart: one file staged, one open");
    equal(await ui.rows("staged"), ["zwei.txt"], "the same file as before is staged");
    await eventually(() => ui.summary.inputValue(), "Vor dem Neustart getippt", "the summary is back");
    await flow.page.keyboard.press("Control+Enter");
    await ui.waitToast("success", /Commit created/);
    equal(subject(repo), "Vor dem Neustart getippt", "git: commit with the draft");
    equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")), ["zwei.txt"], "git: only the staged file");
    equal(lines(repo.git("status", "--porcelain")), ["?? eins.txt"], "git: the other file is still open");
    await tidy(flow);
  },
  { launch: false },
);
await flow.stop();

// ---------------------------------------------------------------------------------------------
await section("F03-E16 Slow network: “Push after commit” through a delaying server", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e16-langsam" });
  const server = await startGitHttpServer({ users: { lena: "geheim" } });
  flow.cleanups.push(() => server.close());
  server.createBare("messnetz.git", { from: repo.remotePath });
  const proxy = await startDelayProxy(server.port, 2500);
  flow.cleanups.push(() => proxy.close());
  repo.git("remote", "set-url", "origin", `http://lena:geheim@127.0.0.1:${proxy.port}/messnetz.git`);
  writeFile(repo, "langsam.txt", "über die langsame Leitung\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.checkbox("Push after commit").click();
  await ui.summary.fill("Über die langsame Leitung");
  const remoteBefore = server.git("messnetz.git", "rev-parse", "refs/heads/main");
  const started = Date.now();
  await press("Control+Shift+Enter");
  // The commit exists right away; the push is still running.
  await eventually(() => subject(repo), "Über die langsame Leitung", "git: the commit is created right away, not only after the push", 8000);
  const commitAfter = Date.now() - started;
  equal(server.git("messnetz.git", "rev-parse", "refs/heads/main"), remoteBefore, "the remote does not have the commit yet");
  await eventually(() => ui.commitButton.getAttribute("aria-busy"), "true", "the button shows the running operation");
  await eventually(() => page.locator('footer [role="progressbar"]').count(), 1, "the status bar shows “Commit and push” as a running job");
  check(/Commit and push/.test(await page.locator("footer").innerText()), "the job is called “Commit and push”");
  equal(await toastsOf(page, "success"), [], "while the push is running there is no success toast yet");
  // The UI stays usable: the file view toggle responds.
  await page.getByRole("button", { name: "Show as folder tree" }).click();
  await page.getByRole("button", { name: "Show as flat list" }).click();
  const toast = await ui.waitToast("success", /pushed/, 90_000);
  const took = Date.now() - started;
  console.log(`  commit after ${commitAfter} ms, push done after ${took} ms, ${proxy.connections()} connections over the slow line`);
  check(took > 2500, `the push really went over the slow line (${took} ms)`);
  check(/origin\/main/.test(toast ?? ""), `the toast names the target (${toast})`);
  check(!/geheim/.test(toast ?? "") && !/geheim/.test(await page.locator("body").innerText()), "the password from the URL appears nowhere in the UI");
  equal(server.git("messnetz.git", "rev-parse", "refs/heads/main"), repo.git("rev-parse", "HEAD"), "the remote has the commit");
  await eventually(() => page.locator('footer [role="progressbar"]').count(), 0, "the job has finished");
  await eventually(() => ui.summary.inputValue(), "", "the form is empty");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E17 Offline: push after commit fails understandably, the commit stays", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e17-offline" });
  repo.git("remote", "set-url", "origin", "http://127.0.0.1:9/messnetz.git");
  writeFile(repo, "offline.txt", "ohne Netz\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.checkbox("Push after commit").click();
  await ui.summary.fill("Ohne Netz committet");
  const before = count(repo);
  await press("Control+Shift+Enter");
  const toast = await ui.waitToast("warning", /not pushed/, 90_000);
  check(/Commit created, but not pushed/.test(toast ?? ""), `the toast says: Commit created, but not pushed (${toast})`);
  check(/cannot be reached|connection|network|offline/i.test(toast ?? ""), `the toast explains that the remote cannot be reached (${toast})`);
  check(/Retry push/.test(toast ?? ""), "the toast offers “Retry push”");
  equal(count(repo), before + 1, "git: the commit exists");
  equal(subject(repo), "Ohne Netz committet", "git: message");
  equal(repo.git("status", "--porcelain"), "", "git: clean");
  await eventually(() => ui.summary.inputValue(), "", "the form is empty – the commit is done");
  equal(await toastsOf(page, "danger"), [], "no additional error message (one toast is enough)");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E18 Wrong credentials on push after commit: commit stays, retrying with the right ones pushes", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e18-anmeldung" });
  const server = await startGitHttpServer({ users: { lena: "geheim" } });
  flow.cleanups.push(() => server.close());
  server.createBare("messnetz.git", { from: repo.remotePath });
  repo.git("remote", "set-url", "origin", server.url("messnetz.git"));
  writeFile(repo, "anmeldung.txt", "braucht ein Passwort\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.checkbox("Push after commit").click();
  await ui.summary.fill("Mit Anmeldung pushen");
  const before = count(repo);
  const remoteBefore = server.git("messnetz.git", "rev-parse", "refs/heads/main");
  await press("Control+Shift+Enter");
  // Git asks for username and password through the app.
  await until(async () => (await dialogTitle(page)) === "Username for the remote", "prompt for the username", 60_000);
  equal(count(repo), before + 1, "git: the commit already exists while the prompt is open");
  await page.keyboard.type("lena");
  await press("Enter");
  await until(async () => (await dialogTitle(page)) === "Sign in to the remote", "prompt for the password", 60_000);
  await page.keyboard.type("falsch-geraten");
  await press("Enter");
  const toast = await ui.waitToast("warning", /not pushed/, 90_000);
  check(/sign(ing)? in|credentials|username|password/i.test(toast ?? ""), `the toast explains the failed sign-in (${toast})`);
  check(!/falsch-geraten/.test(await page.locator("body").innerText()), "the entered password appears nowhere in the UI");
  equal(server.git("messnetz.git", "rev-parse", "refs/heads/main"), remoteBefore, "the remote is unchanged");
  equal(subject(repo), "Mit Anmeldung pushen", "git: the commit stays");
  await noDialog(page).catch(() => check(false, "after the answer no prompt is open anymore"));
  // “Retry push” with the right credentials.
  await page.locator('[data-toast="warning"]').getByRole("button", { name: "Retry push" }).click();
  await until(async () => (await dialogTitle(page)) === "Username for the remote", "prompt for the username again", 60_000);
  await page.keyboard.type("lena");
  await press("Enter");
  await until(async () => (await dialogTitle(page)) === "Sign in to the remote", "prompt for the password again", 60_000);
  await page.keyboard.type("geheim");
  await press("Enter");
  await eventually(() => server.git("messnetz.git", "rev-parse", "refs/heads/main"), repo.git("rev-parse", "HEAD"), "after the retry the remote has the commit", 90_000);
  equal(count(repo), before + 1, "git: it stays at one commit");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E19 Time zone: the new commit carries the local time with its offset; shown as “just now”", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e19-zeit" });
  writeFile(repo, "zeit.txt", "jetzt\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.summary.fill("Commit von jetzt");
  const startedAt = Math.floor(Date.now() / 1000);
  await press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/);
  const [seconds, offset] = repo.git("log", "-1", "--format=%ad", "--date=raw").split(" ");
  const minutes = -new Date().getTimezoneOffset();
  const expected = `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  equal(offset, expected, "git: author date with the offset of the local time zone");
  check(Math.abs(Number(seconds) - startedAt) <= 30, `git: author date is now (${seconds} vs ${startedAt})`);
  equal(repo.git("log", "-1", "--format=%cd", "--date=raw"), `${seconds} ${offset}`, "git: committer date equals author date");
  await selectCommit(tabId, repo.git("rev-parse", "HEAD"));
  const meta = page.locator('[data-screen="commit-details"] [data-testid="commit-meta"]');
  await meta.waitFor({ timeout: 8000 });
  await until(async () => /just now|1 minute ago/.test(await meta.innerText()), `the details show the date relatively (“just now”): ${(await meta.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
  await selectWip(tabId);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E20 Minimum window 960×600: stage, type, commit – everything visible and reachable", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e20-klein" });
  for (let index = 1; index <= 9; index++) writeFile(repo, `daten/reihe-${index}.csv`, `datum;wert\n2026-04-0${index};${index}\n`);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 9, staged: 0, conflicted: 0 });
  await app.setSize(960, 600);
  await eventually(ui.overflow, { page: 0, panel: 0 }, "no overflow at 960×600");
  const inside = async (locator, what) => {
    const box = await locator.boundingBox();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 + 0.5 && box.y + box.height <= 600 + 0.5, `${what} lies fully inside the window (${JSON.stringify(box)})`);
  };
  await inside(ui.summary, "summary");
  await inside(ui.description, "description");
  await inside(ui.commitButton, "commit button");
  for (const label of ["Amend last commit", "Push after commit", "Skip Git hooks"]) await inside(ui.checkbox(label), `checkbox “${label}”`);
  await inside(page.getByRole("button", { name: "Stage all", exact: true }), "“Stage all”");
  await page.getByRole("button", { name: "Stage all", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 9, conflicted: 0 });
  await ui.summary.click();
  await page.keyboard.type("Neun Messreihen im kleinsten Fenster committet");
  await ui.description.click();
  await page.keyboard.type("Zeile 1\nZeile 2\nZeile 3\nZeile 4\nZeile 5\nZeile 6\nZeile 7\nZeile 8");
  await inside(ui.commitButton, "commit button with an eight-line description");
  await eventually(ui.overflow, { page: 0, panel: 0 }, "no overflow with a filled form");
  await ui.commitButton.click();
  await ui.waitToast("success", /Commit created/);
  equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")).length, 9, "git: nine files in the commit");
  const toastBox = await page.locator('[data-toast="success"]').first().boundingBox();
  check(toastBox && toastBox.x >= 0 && toastBox.x + toastBox.width <= 960.5, `the success toast lies inside the window (${JSON.stringify(toastBox)})`);
  await app.setSize(1440, 900);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-E22 Screen reader: roles and names, error on the field, reason for disabling, visible focus", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e22-a11y" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
  writeFile(repo, "neu.txt", "neu\n");
  fs.rmSync(path.join(repo.path, "stationen.csv"));
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "neu.txt").hover();
  await ui.row("unstaged", "neu.txt").getByRole("button", { name: "Stage" }).click();
  await ui.waitCounts(repoId, { unstaged: 2, staged: 1, conflicted: 0 });
  await page.mouse.move(700, 450);

  equal(await unnamedControls(page, '[data-screen="commit-panel"]'), [], "every control in the panel has a name");
  // The nested-interactive rule is checked by its own section F03-E24 (BUG B-02).
  equal(await axeViolations(page, '[data-screen="commit-panel"]', { disable: ["color-contrast", "nested-interactive"] }), [], "axe: no further violations in the commit panel");
  equal(await page.locator('[data-screen="commit-panel"]').getAttribute("aria-label"), "Local changes", "the panel is a named region");
  equal(await page.getByRole("listbox", { name: "Unstaged files", exact: true }).count(), 1, "list “Unstaged files” as listbox");
  equal(await page.getByRole("listbox", { name: "Staged files", exact: true }).count(), 1, "list “Staged files” as listbox");
  equal(await page.getByRole("form", { name: "Commit", exact: true }).count(), 1, "the form is called “Commit”");
  // Each file's status is a word in the row's name, not only a colour or letter.
  const names = await page.getByRole("listbox", { name: "Unstaged files", exact: true }).getByRole("option").evaluateAll((list) => list.map((option) => option.textContent));
  check(names.some((name) => /modified/.test(name) && /README\.md/.test(name)), `“modified” is shown for README.md (${JSON.stringify(names)})`);
  check(names.some((name) => /deleted/.test(name) && /stationen\.csv/.test(name)), `“deleted” is shown for stationen.csv (${JSON.stringify(names)})`);
  const stagedNames = await page.getByRole("listbox", { name: "Staged files", exact: true }).getByRole("option").evaluateAll((list) => list.map((option) => option.textContent));
  check(stagedNames.some((name) => /new|added/.test(name) && /neu\.txt/.test(name)), `the status of the staged new file is shown as a word (${JSON.stringify(stagedNames)})`);
  for (const label of ["Amend last commit", "Push after commit", "Skip Git hooks"]) {
    equal(await page.getByRole("checkbox", { name: label, exact: true }).count(), 1, `checkbox named “${label}”`);
  }

  // Error on the field: as alert, linked to the field.
  await ui.summary.fill("");
  await ui.commitButton.click();
  const alert = page.getByRole("alert").filter({ hasText: /summary is missing/ });
  await alert.waitFor({ timeout: 5000 });
  equal(await ui.summary.getAttribute("aria-invalid"), "true", "aria-invalid on the field");
  const describedBy = await ui.summary.getAttribute("aria-describedby");
  equal(describedBy ? await page.locator(`[id="${describedBy}"]`).innerText() : null, await alert.innerText(), "the field's aria-describedby points to the error message");
  equal(await ui.focusedLabel(), "Summary", "focus is in the invalid field");
  // Counter: as a sentence for screen readers.
  await ui.summary.fill("x".repeat(80));
  check(/80 characters, more than the recommended 72/.test(await page.locator('form [role="status"]').first().innerText()), "the counter has a text for screen readers");
  await ui.summary.fill("");

  // Tab order through the form; focus is visible at every stop.
  await ui.summary.focus();
  const stops = [];
  for (let step = 0; step < 6; step++) {
    const visible = await focusVisible(page);
    stops.push((await ui.focusedLabel()) ?? "");
    check(visible.ok, `focus visible at stop ${step + 1}: ${visible.what}`);
    await press("Tab");
  }
  check(
    stops[0] === "Summary" && stops[1] === "Description" && stops.length === 6,
    `tab order starts with summary, description (${JSON.stringify(stops)})`,
  );
  const order = await page.evaluate(() => {
    const form = document.querySelector('form[aria-label="Commit"]');
    return [...form.querySelectorAll('input:not([type="hidden"]):not([aria-hidden="true"]), textarea, button')].filter((element) => element.tabIndex >= 0 && !element.closest("[aria-hidden='true']") && element.getAttribute("aria-hidden") !== "true").map((element) => {
      if (element.getAttribute("role") === "checkbox") return (document.querySelector(`label[for="${element.id}"]`)?.textContent ?? "").trim();
      return element.getAttribute("aria-label") ?? (element.dataset.action ? "commit-button" : element.textContent.trim());
    });
  });
  equal(order, ["Summary", "Description", "Amend last commit", "Push after commit", "Skip Git hooks", "commit-button"], "order of the fields in the form");

  // Disabled primary button: the reason is reachable for screen readers, not only via mouse tooltip.
  await page.getByRole("button", { name: "Unstage all" }).click();
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 });
  await ui.summary.focus();
  for (let step = 0; step < 12 && !(await page.evaluate(() => document.activeElement?.dataset?.action === "commit")); step++) await press("Tab");
  check(await page.evaluate(() => document.activeElement?.dataset?.action === "commit"), "the disabled button is reachable with Tab");
  equal(await ui.commitButton.getAttribute("aria-disabled"), "true", "aria-disabled on the disabled button");
  await page.getByRole("tooltip").filter({ hasText: /Nothing staged/ }).first().waitFor({ timeout: 5000 }).catch(() => check(false, "on keyboard focus the reason for disabling appears as a tooltip"));
  const reason = await page.evaluate(() => {
    const button = document.activeElement;
    const ids = (button?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  });
  check(/Nothing staged/.test(reason), `the reason for disabling is attached to the button via aria-describedby (got: “${reason}”)`);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
// BUG B-02: The selected row of a file list (role="option") contains a visible button (“Stage” or
// “Unstage”). A control inside another one is not reachable for screen readers; axe reports
// nested-interactive (serious). The keyboard path (S / U, context menu) works.
await section(
  "F03-E24 Screen reader: axe rule nested-interactive in the file lists (button in the selected row)",
  async () => {
    const { app, ui, page } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e24-axe" });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    writeFile(repo, "neu.txt", "neu\n");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    // Select a row (click), close the diff again, move the mouse away: the selected row keeps showing its button.
    await ui.row("unstaged", "README.md").click();
    await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await page.mouse.move(700, 450);
    await app.settle();
    const violations = await axeViolations(page, '[data-screen="commit-panel"]');
    const failed = !equal(violations, [], "axe: no violations in the commit panel with a selected file");
    await flow.bugShot("B-02", failed);
    await tidy(flow);
  },
  { bug: "B-02" },
);

// ---------------------------------------------------------------------------------------------
await section("F03-N1 Hooks: commit-msg rejects; prepare-commit-msg changes the message; pre-commit changes files", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n1-hooks" });
  writeHook(repo, "commit-msg", 'if grep -q "TICKET-" "$1"; then exit 0; fi\necho "Die Message braucht eine Ticketnummer (TICKET-123). Größe: äöü" >&2\nexit 1');
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
  const before = count(repo);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await press("Control+Shift+S");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
  await ui.summary.fill("Ohne Ticketnummer");
  await ui.description.fill("Bleibt stehen.");
  await press("Control+Enter");
  const toast = await ui.waitToast("danger", /hook/i);
  check(/commit-msg/.test(toast ?? ""), `the toast names the commit-msg hook (${toast})`);
  await page.waitForTimeout(700);
  equal((await toastsOf(page, "danger")).length, 1, "exactly one error message");
  equal(count(repo), before, "git: no commit");
  equal(await ui.summary.inputValue(), "Ohne Ticketnummer", "summary stays");
  equal(await ui.description.inputValue(), "Bleibt stehen.", "description stays");
  equal(cached(repo), ["README.md"], "git: file stays staged");
  await page.locator('[data-toast="danger"]').getByRole("button", { name: "Show output" }).first().click();
  const output = page.locator('[role="dialog"] pre');
  await output.waitFor({ timeout: 5000 });
  check((await output.textContent())?.includes("Die Message braucht eine Ticketnummer (TICKET-123). Größe: äöü"), `the dialog shows the hook output with umlauts (${await output.textContent()})`);
  await press("Escape");
  await noDialog(page);
  await ui.closeToasts();
  // Fix the message: now the hook accepts it.
  await ui.summary.fill("TICKET-7 Mit Ticketnummer");
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(subject(repo), "TICKET-7 Mit Ticketnummer", "git: with a ticket number the commit is created");
  await ui.closeToasts();

  // prepare-commit-msg appends a line; pre-commit reformats a file and stages it.
  fs.rmSync(path.join(repo.path, ".git", "hooks", "commit-msg"));
  writeHook(repo, "prepare-commit-msg", 'printf "\\n\\nGeprüft-von: Hook\\n" >> "$1"');
  writeHook(repo, "pre-commit", 'for f in $(git diff --cached --name-only -- "*.txt"); do tr "a-z" "A-Z" < "$f" > "$f.tmp" && mv "$f.tmp" "$f" && git add "$f"; done');
  writeFile(repo, "klein.txt", "kleinbuchstaben\n");
  await ui.refresh();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.summary.fill("Hook formatiert und ergänzt");
  await press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(subject(repo), "Hook formatiert und ergänzt", "git: summary");
  check(repo.git("log", "-1", "--format=%B").includes("Geprüft-von: Hook"), `git: the line from prepare-commit-msg is in the message (${JSON.stringify(repo.git("log", "-1", "--format=%B"))})`);
  equal(repo.git("show", "HEAD:klein.txt"), "KLEINBUCHSTABEN", "git: the commit contains the version changed by the hook");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 }, "after the commit nothing is open (the app shows no ghost change)");
  equal(repo.git("status", "--porcelain"), "", "git: clean");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-N3 Repository locked (.git/index.lock): understandable message, nothing lost, works afterwards", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n3-sperre" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
  writeFile(repo, "zwei.txt", "zwei\n");
  const before = count(repo);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "README.md").click();
  await press("s");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 });
  const lock = path.join(repo.path, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  try {
    // Staging fails because of the lock.
    await ui.row("unstaged", "zwei.txt").click();
    await press("s");
    const stageToast = await ui.waitToast("danger", /Stage failed/, 30_000);
    check(/index\.lock|locked|another program/i.test(stageToast ?? ""), `stage: the toast explains the lock (${stageToast})`);
    equal(cached(repo), ["README.md"], "git: nothing changed in the index");
    await ui.closeToasts();
    // Committing fails because of the lock; message and staging stay.
    await ui.summary.fill("Während der Sperre");
    await ui.summary.focus();
    await press("Control+Enter");
    const commitToast = await ui.waitToast("danger", /Commit failed/, 30_000);
    check(/index\.lock|locked|another program/i.test(commitToast ?? ""), `commit: the toast explains the lock (${commitToast})`);
    equal(count(repo), before, "git: no commit");
    equal(await ui.summary.inputValue(), "Während der Sperre", "the summary stays");
    await ui.closeToasts();
  } finally {
    fs.rmSync(lock, { force: true });
  }
  await ui.refresh();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "after the lock the app shows the unchanged state");
  await ui.summary.focus();
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(count(repo), before + 1, "git: without the lock the commit is created");
  equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")), ["README.md"], "git: only the staged file");
  equal(await toastsOf(page, "danger"), [], "no error message anymore");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-N4 Staged file deleted from outside; branch switched from outside", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n4-geloescht" });
  writeFile(repo, "kurzlebig.txt", "gleich weg\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await press("Control+Shift+S");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
  fs.rmSync(path.join(repo.path, "kurzlebig.txt"));
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "the file deleted from outside shows as staged (new) and unstaged (deleted)", 20_000);
  check(/deleted/.test((await ui.row("unstaged", "kurzlebig.txt").textContent()) ?? ""), "the row under “Unstaged” says “deleted”");
  await ui.summary.fill("Gestagte Fassung committen");
  await ui.summary.focus();
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(repo.git("show", "HEAD:kurzlebig.txt"), "gleich weg", "git: the commit contains the staged version");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "the deletion stays as an open change");
  equal(lines(repo.git("status", "--porcelain")), [" D kurzlebig.txt"], "git: deletion not staged");
  await ui.closeToasts();

  // Switch branch from outside, then commit in the app: the commit lands on the new branch.
  const main = repo.git("rev-parse", "main");
  repo.git("checkout", "-q", "-b", "extern/angelegt");
  await eventually(async () => (await ui.status(repoId))?.head?.branch ?? null, "extern/angelegt", "the app knows the branch switched from outside", 20_000);
  await ui.summary.fill("Löschung auf dem neuen Branch");
  await ui.summary.focus();
  await press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "extern/angelegt", "git: HEAD is the new branch");
  equal(repo.git("log", "-1", "--format=%s", "extern/angelegt"), "Löschung auf dem neuen Branch", "git: the commit is on the new branch");
  equal(repo.git("rev-parse", "main"), main, "git: main is unchanged");
  check(!exists(repo, "kurzlebig.txt"), "the file is gone");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F03-N7 pre-push hook rejects the push after commit: commit stays, toast names the hook", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n7-prepush" });
  writeHook(repo, "pre-push", 'echo "Push gesperrt: erst die Tests laufen lassen" >&2\nexit 1');
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
  const remoteBefore = lines(repo.git("ls-remote", "origin", "refs/heads/main"))[0]?.split(/\s+/)[0];
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.checkbox("Push after commit").click();
  await ui.summary.fill("Push scheitert am Hook");
  await press("Control+Shift+Enter");
  await until(async () => (await toastsOf(page)).some((text) => /not pushed|pre-push/.test(text)), "a toast says that nothing was pushed", 60_000);
  const all = (await toastsOf(page)).join(" | ");
  check(/pre-push/.test(all), `the toast names the pre-push hook (${all})`);
  check(/Tests laufen lassen/.test(all) || /Show output/.test(all), `the hook output is visible or can be opened (${all})`);
  equal(subject(repo), "Push scheitert am Hook", "git: the commit exists");
  equal(lines(repo.git("ls-remote", "origin", "refs/heads/main"))[0]?.split(/\s+/)[0], remoteBefore, "git: the remote is unchanged");
  await eventually(() => ui.summary.inputValue(), "", "the form is empty – the commit is done");
  // Hooks do not report via console.error here; the section checks console errors at the end.
  await tidy(flow);
});

process.exit(await flow.finish());
