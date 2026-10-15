/**
 * Commit panel over WebDriver, in the real app against real Git repositories: stage files,
 * hunks and single lines (CRLF, Latin-1, missing final newline – index checked byte by byte),
 * amend, commit and push, commit templates, co-author trailers and signed commits.
 *
 *   node scripts/e2e-wd/features/commit.mjs
 *   E2E_WD_ONLY="amend" node scripts/e2e-wd/features/commit.mjs
 *
 * Every scenario checks the UI and the repository (git log / diff --cached / cat-file).
 */
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { commitUi, eventually, indexBlob, lines, readText, until, writeBytes } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };

/** Launches the app, opens a fresh copy of the "messnetz" fixture (with origin) and returns everything. */
async function setup(t, prepare, { launch = {}, name, beforeOpen } = {}) {
  const repo = makeCleanRepoWithRemote(name ? { name } : {});
  t.cleanup = () => repo.cleanup();
  await prepare?.(repo);
  const app = await t.launch({ ...LAUNCH, ...(typeof launch === "function" ? launch(repo) : launch) });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  await beforeOpen?.(app, repo);
  const ui = commitUi(app);
  const { repoId, tabId } = await app.openRepo(repo.path);
  t.step("repository opened");
  return { repo, app, ui, repoId, tabId };
}

/** Wraps a scenario body so the fixture is always removed. */
const withRepo = (fn) => async (t) => {
  try {
    await fn(t);
  } finally {
    t.cleanup?.();
  }
};

// =============================================================================================
// Stage files
// =============================================================================================

scenario("stage files with S and the row click, then commit with Ctrl+Enter", "main", withRepo(async (t) => {
  const { repo, app, ui, repoId, tabId } = await setup(t, (r) => {
    r.write("README.md", `${readText(r, "README.md")}\nStand: Auswertung für März begonnen.\n`);
    r.write("notizen/plan.md", "# Plan\n\n- Station Hafen nachmessen\n");
  });
  const before = repo.git("rev-parse", "HEAD");
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "two changed files");
  assertEqual(await ui.rows("unstaged"), ["README.md", "notizen/plan.md"], "list Unstaged");
  assert(await ui.commitBlocked(), "commit is blocked while nothing is staged");

  // Click on a row opens its diff and focuses the row; S stages it.
  await ui.openDiff("unstaged", "README.md");
  await app.click(await ui.row("unstaged", "README.md"));
  await app.press("s");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "after S");
  assertEqual(lines(repo.git("diff", "--cached", "--name-only")), ["README.md"], "git: README.md staged");
  await eventually(ui.focusedKey, "notizen/plan.md", "focus moves on to the next file");
  await app.press("s");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 2, conflicted: 0 }, "after the second S");
  await eventually(ui.commitLabel, "Commit 2 files", "button names the count");
  t.step("both files staged");

  await ui.fill(await ui.summary(), "Plan für die März-Auswertung notiert");
  await app.press("Enter");
  assertEqual(await ui.focusedLabel(), "Description", "Enter jumps into the description");
  await app.type(await ui.description(), "Die Station Hafen wird nachgemessen.");
  await t.shot("stage-files-ready");
  await app.press("Control+Enter");
  const toast = await ui.waitToast("success", /Commit created/);
  const head = repo.git("rev-parse", "HEAD");
  assert(head !== before, "git: HEAD moved");
  assertIncludes(toast, head.slice(0, 7), "toast names the new commit");
  assertEqual(repo.git("log", "-1", "--format=%s"), "Plan für die März-Auswertung notiert", "git: summary");
  assertEqual(repo.git("log", "-1", "--format=%b").trim(), "Die Station Hafen wird nachgemessen.", "git: description");
  assertEqual(lines(repo.git("show", "--name-only", "--format=", "HEAD")).sort(), ["README.md", "notizen/plan.md"], "git: files in the commit");
  assertEqual(repo.git("status", "--porcelain"), "", "git: clean");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 }, "lists empty");
  await eventually(ui.fields, { summary: "", description: "" }, "form is empty after the commit");
  assertEqual((await ui.view(tabId))?.selection ?? { kind: "wip" }, { kind: "wip" }, "selection stays on local changes");
  await until(() => app.byText("Nothing to commit"), "empty state Nothing to commit");
  await t.shot("stage-files-committed");
  await t.noConsoleErrors(app);
}));

scenario("stage all / unstage all; nothing staged and empty summary do not commit", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => {
    r.write("README.md", `${readText(r, "README.md")}\nNeu.\n`);
    r.write("stationen.csv", `${readText(r, "stationen.csv")}W;Wald;212\n`);
    r.write("notizen/neu.txt", "neu\n");
  });
  const count = repo.git("rev-list", "--count", "HEAD");
  const cached = () => lines(repo.git("diff", "--cached", "--name-only")).sort();
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 }, "three changed files");

  // Nothing staged: the button is blocked and Ctrl+Enter only explains why.
  await ui.fill(await ui.summary(), "Sollte nicht entstehen");
  assert(await ui.commitBlocked(), "commit button blocked without staged files");
  await app.press("Control+Enter");
  await ui.waitToast("info", /Nothing staged/);
  assertEqual(repo.git("rev-list", "--count", "HEAD"), count, "git: no commit without staged files");
  await ui.closeToasts();

  // Stage all / Unstage all in the section headers.
  await app.click({ text: "Stage all", within: '[data-section="unstaged"]' });
  await ui.waitCounts(repoId, { unstaged: 0, staged: 3, conflicted: 0 }, "Stage all");
  assertEqual(cached(), ["README.md", "notizen/neu.txt", "stationen.csv"], "git: all three staged");
  assertEqual(lines(repo.git("stash", "list")), [], "Stage all creates no stash");
  await app.click({ text: "Unstage all", within: '[data-section="staged"]' });
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 }, "Unstage all");
  assertEqual(cached(), [], "git: nothing staged");
  // Keyboard shortcut for "stage everything".
  await app.click(await ui.summary());
  await app.press("Control+Shift+s");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 3, conflicted: 0 }, "Ctrl+Shift+S stages everything");

  // Empty summary: error at the field, focus there, no commit.
  await ui.fill(await ui.summary(), "");
  await app.click(await ui.commitButton());
  await eventually(async () => /summary is missing/.test((await ui.formAlert()) ?? ""), true, "alert: summary missing");
  assertEqual(await (await ui.summary()).attr("aria-invalid"), "true", "summary marked invalid");
  assertEqual(await ui.focusedLabel(), "Summary", "focus jumps into the summary");
  assertEqual(repo.git("rev-list", "--count", "HEAD"), count, "git: no commit without a summary");
  await t.shot("commit-empty-summary");
  await app.type(await ui.summary(), "Jetzt mit Message");
  await eventually(ui.formAlert, null, "the error disappears while typing");
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  assertEqual(repo.git("log", "-1", "--format=%s"), "Jetzt mit Message", "git: commit after fixing the summary");
  assertEqual(Number(repo.git("rev-list", "--count", "HEAD")), Number(count) + 1, "git: exactly one new commit");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Hunks
// =============================================================================================

const HUNK_FILE = "daten/reihe.csv";
const hunkOld = Array.from({ length: 30 }, (_, index) => `2026-01-${String(index + 1).padStart(2, "0")};${(index * 7) % 23}`);
const hunkNew = hunkOld.map((line, index) => (index === 2 ? `${line};korrigiert` : index === 24 ? "2026-01-25;-999" : line));

/** Commits the 30-line series, then changes line 3 and line 25 (two hunks). */
const twoHunks = (r) => {
  writeBytes(r, HUNK_FILE, `${hunkOld.join("\n")}\n`);
  r.git("add", "--", HUNK_FILE);
  r.git("commit", "-q", "-m", "Messreihe Januar");
  writeBytes(r, HUNK_FILE, `${hunkNew.join("\n")}\n`);
};

scenario("stage exactly one hunk of a file with two hunks", "main", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, twoHunks);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one changed file");
  await ui.openDiff("unstaged", HUNK_FILE);
  const heads = await ui.hunkHeads();
  assertEqual(heads.length, 2, "two hunks");
  assertMatch(heads[0], /^Hunk 1 of 2/, "hunk header readable");
  const before = await ui.diffToken();
  await app.click(await ui.hunkButton(1, "Stage hunk"));
  await ui.diffChanged(before, HUNK_FILE);
  const staged = repo.git("diff", "--cached", "--", HUNK_FILE);
  assertEqual((staged.match(/^@@/gm) ?? []).length, 1, "git diff --cached: one hunk");
  assertIncludes(staged, "+2026-01-25;-999", "git: the second hunk is staged");
  assert(!staged.includes("korrigiert"), "git: the first hunk is not staged");
  assertIncludes(repo.git("diff", "--", HUNK_FILE), "+2026-01-03;14;korrigiert", "git: the first hunk stays in the working tree diff");
  await eventually(async () => (await ui.hunkHeads()).length, 1, "the view shows the remaining hunk");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "file in both lists");
  await t.shot("hunk-staged");
  await t.noConsoleErrors(app);
}));

scenario("unstage a hunk from the staged diff; staged diff offers no stage/discard", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => {
    twoHunks(r);
    r.git("add", "--", HUNK_FILE);
  });
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "file fully staged");
  await ui.openDiff("staged", HUNK_FILE);
  assertEqual((await ui.hunkHeads()).length, 2, "two staged hunks");
  const buttons = await app.exec(() => [...document.querySelectorAll('[data-screen="diff"] [data-hunk] button')].map((b) => (b.getAttribute("aria-label") ?? b.textContent).trim()));
  assert(buttons.includes("Unstage hunk") && !buttons.some((b) => /^(Stage|Discard) hunk$/.test(b)), `staged diff offers only Unstage hunk (${JSON.stringify(buttons)})`);
  const before = await ui.diffToken();
  await app.click(await ui.hunkButton(0, "Unstage hunk"));
  await ui.diffChanged(before, HUNK_FILE);
  const staged = repo.git("diff", "--cached", "--", HUNK_FILE);
  assert(!staged.includes("korrigiert") && staged.includes("+2026-01-25;-999"), "git: only the second hunk stays staged");
  assertIncludes(repo.git("diff", "--", HUNK_FILE), "korrigiert", "git: the first hunk is back in the working tree diff");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "file in both lists");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Lines: CRLF, missing final newline, Latin-1
// =============================================================================================

const CRLF = "text/crlf.txt";
const NO_EOL = "text/ohne-ende.txt";
const LATIN1 = "text/latin1.txt";
const latin = (text) => Buffer.from(text, "latin1");

const oddFiles = (r) => {
  writeBytes(r, CRLF, "eins\r\nzwei\r\ndrei\r\nvier\r\nfünf\r\nsechs\r\n");
  writeBytes(r, NO_EOL, "eins\nzwei\ndrei");
  writeBytes(r, LATIN1, latin("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nDruck;hPa\n"));
  r.git("add", "--", CRLF, NO_EOL, LATIN1);
  r.git("commit", "-q", "-m", "Testdateien mit besonderen Zeilenenden");
  writeBytes(r, CRLF, "eins\r\nZWEI\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n");
  writeBytes(r, NO_EOL, "eins\nzwei\ndrei\nvier\nfünf");
  writeBytes(r, LATIN1, latin("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nDruck;hPa\nLuftfeuchte;%\nNiederschlag;mm\n"));
};

scenario("stage two selected lines of a CRLF file – index byte-exact, CRLF kept", "main", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, oddFiles);
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 }, "three changed files");
  await ui.openDiff("unstaged", CRLF);
  assertEqual(await ui.changedRows(), ["-zwei", "+ZWEI", "-fünf", "+FÜNF"], "changed lines");
  // Click into the line-number column selects, Shift+click extends.
  await app.click(await ui.gutter("remove", "fünf"));
  await ui.shiftClick(await ui.gutter("add", "FÜNF"));
  await eventually(ui.selectedRows, ["-fünf", "+FÜNF"], "click + Shift+click select the range");
  const button = await ui.selectionButton("Stage 2 lines");
  assert(await app.byText("Discard 2 lines", { within: "[data-selection-bar]" }), "bar also offers Discard 2 lines");
  await t.shot("lines-crlf-selected");
  const before = await ui.diffToken();
  await app.click(button);
  await ui.diffChanged(before, CRLF);
  const index = indexBlob(repo, CRLF);
  assertEqual(index.toString("hex"), Buffer.from("eins\r\nzwei\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n").toString("hex"), "index: only FÜNF taken over, CRLF kept");
  assertEqual(readText(repo, CRLF), "eins\r\nZWEI\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n", "working tree unchanged");
  await eventually(ui.changedRows, ["-zwei", "+ZWEI"], "the view shows the rest");
  assertEqual(await ui.selectedRows(), [], "selection cleared");
  await t.noConsoleErrors(app);
}));

scenario("file without final newline: stage lines with the keyboard, then the rest", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, oddFiles);
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 }, "three changed files");
  await ui.openDiff("unstaged", NO_EOL);
  assertEqual(await ui.changedRows(), ["-drei", "+drei", "+vier", "+fünf"], "lines of the hunk");
  await until(async () => (await app.exec(() => document.querySelector('[data-screen="diff"]')?.innerText ?? "")).split("No newline at end of file").length - 1 === 2, "notice on both versions");
  // Keyboard only: F7 to the first change, Space selects, Shift+Down extends, Enter stages.
  await app.press("F7");
  await eventually(() => app.exec(() => document.activeElement?.closest("[data-row]")?.dataset.kind ?? null), "remove", "F7 focuses the first change");
  await app.press("Space", "Shift+ArrowDown", "Shift+ArrowDown");
  await eventually(ui.selectedRows, ["-drei", "+drei", "+vier"], "Space + Shift+Down select three lines");
  await ui.selectionButton("Stage 3 lines");
  const before = await ui.diffToken();
  await app.press("Enter");
  await ui.diffChanged(before, NO_EOL);
  assertEqual(indexBlob(repo, NO_EOL).toString("utf8"), "eins\nzwei\ndrei\nvier\n", "index: drei and vier with line ending, fünf still missing");
  // The rest as a hunk: index equals the working tree, still without final newline.
  const second = await ui.diffToken();
  await app.click(await ui.hunkButton(0, "Stage hunk"));
  await ui.diffChanged(second, NO_EOL);
  assertEqual(indexBlob(repo, NO_EOL).toString("hex"), Buffer.from("eins\nzwei\ndrei\nvier\nfünf").toString("hex"), "index equals working tree (no final newline)");
  const status = await app.invoke("status_get", { repoId });
  assert(!status.unstaged.some((file) => file.path === NO_EOL), "file no longer under Unstaged");
  await t.noConsoleErrors(app);
}));

scenario("Latin-1 file: stage one added line, the other bytes stay Latin-1", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, oddFiles);
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 }, "three changed files");
  await ui.openDiff("unstaged", LATIN1);
  assertEqual(await ui.changedRows(), ["+Luftfeuchte;%", "+Niederschlag;mm"], "two added lines");
  const text = await app.exec(() => document.querySelector('[data-screen="diff"] [data-diff-grid]')?.innerText ?? "");
  assert(!text.includes("�"), "no replacement characters in the rendered Latin-1 file");
  await app.click(await ui.gutter("add", "Niederschlag;mm"));
  await eventually(ui.selectedRows, ["+Niederschlag;mm"], "one line selected");
  const before = await ui.diffToken();
  await app.click(await ui.selectionButton("Stage 1 line"));
  await ui.diffChanged(before, LATIN1);
  assertEqual(indexBlob(repo, LATIN1).toString("hex"), latin("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nDruck;hPa\nNiederschlag;mm\n").toString("hex"), "index: Latin-1 bytes kept, only Niederschlag added");
  assertEqual(repo.git("diff", "--", LATIN1).split("\n").filter((line) => /^[+-][^+-]/.test(line)), ["+Luftfeuchte;%"], "git: Luftfeuchte remains unstaged");
  await t.shot("lines-latin1-staged");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Amend
// =============================================================================================

scenario("amend the last local commit: message loaded, corrected, new content included", "main", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => {
    r.write("notiz.md", "erste Fassung\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "Notiz angeleg");
    r.write("notiz.md", "erste Fassung\nNachtrag\n");
  });
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one change");
  const count = repo.git("rev-list", "--count", "HEAD");
  const old = repo.git("rev-parse", "HEAD");
  await app.click(await ui.checkbox("Amend last commit"));
  await eventually(async () => (await ui.fields()).summary, "Notiz angeleg", "amend loads the last summary");
  assert(!(await app.byText("already been pushed", { exact: false })), "no pushed hint for a local commit");
  await eventually(ui.commitLabel, "Amend commit", "button reads Amend commit");
  await ui.fill(await ui.summary(), "Notiz angelegt");
  await app.press("Control+Shift+s");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "change staged");
  await t.shot("amend-ready");
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit amended/);
  assertEqual(repo.git("rev-list", "--count", "HEAD"), count, "git: no additional commit");
  assert(repo.git("rev-parse", "HEAD") !== old, "git: the commit was replaced");
  assertEqual(repo.git("log", "-1", "--format=%s"), "Notiz angelegt", "git: message corrected");
  assertEqual(repo.git("show", "HEAD:notiz.md"), "erste Fassung\nNachtrag", "git: the addition is in the amended commit");
  assertIncludes(repo.git("reflog", "-1", "--format=%gs"), "amend", "git reflog: commit (amend)");
  await eventually(() => ui.checked("Amend last commit"), false, "amend is unchecked afterwards");
  await eventually(ui.fields, { summary: "", description: "" }, "form empty afterwards");
  await t.noConsoleErrors(app);
}));

scenario("amend a pushed commit: warning, unchecking restores empty fields, message-only amend", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 }, "clean working tree");
  const last = repo.git("log", "-1", "--format=%s");
  const count = repo.git("rev-list", "--count", "HEAD");
  // Keyboard: Space on the focused checkbox.
  await app.exec((el) => el.focus(), await ui.checkbox("Amend last commit"));
  await app.press("Space");
  await eventually(async () => (await ui.fields()).summary, last, "amend loads the pushed commit's summary");
  await until(() => app.byText("already been pushed", { exact: false }), "hint: already pushed, needs force push");
  assert(!(await ui.commitBlocked()), "amend works without staged files");
  await t.shot("amend-pushed-hint");
  await app.press("Space");
  await eventually(ui.fields, { summary: "", description: "" }, "unchecking clears the untouched fields");
  // Message-only amend.
  await app.press("Space");
  await eventually(async () => (await ui.fields()).summary, last, "loaded again");
  await ui.fill(await ui.summary(), `${last} (umformuliert)`);
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit amended/);
  assertEqual(repo.git("rev-list", "--count", "HEAD"), count, "git: same number of commits");
  assertEqual(repo.git("log", "-1", "--format=%s"), `${last} (umformuliert)`, "git: message changed");
  assert(repo.git("rev-parse", "HEAD") !== repo.git("rev-parse", "origin/main"), "git: local main now differs from origin/main");
  assertEqual(repo.git("status", "--porcelain"), "", "git: tree unchanged");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Commit and push
// =============================================================================================

const remoteHead = (repo) => repo.git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];

scenario("commit and push in one step (Push after commit, Ctrl+Shift+Enter)", "main", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => r.write("notiz.md", "eins\n"));
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one new file");
  assertEqual(await ui.checked("Push after commit"), false, "default: off");
  await app.click(await ui.checkbox("Push after commit"));
  await eventually(() => ui.checked("Push after commit"), true, "checked");
  await ui.fill(await ui.summary(), "Notiz eins");
  await t.shot("push-after-commit-ready");
  await app.press("Control+Shift+Enter");
  const toast = await ui.waitToast("success", /pushed/, 30_000);
  assertMatch(toast, /origin\/main/, "toast names origin/main");
  assertEqual(repo.git("log", "-1", "--format=%s"), "Notiz eins", "git: commit created");
  assertEqual(remoteHead(repo), repo.git("rev-parse", "HEAD"), "git: the remote has the new commit");
  assertEqual(repo.git("status", "--porcelain"), "", "git: clean");
  await t.shot("push-after-commit-done");
  await t.noConsoleErrors(app);
}));

scenario("commit and push rejected because the remote is ahead: commit stays, Retry push offered", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => {
    r.commitOnRemote({ message: "Kollegin war schneller" });
    r.write("notiz.md", "zwei\n");
  });
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one new file");
  const remoteBefore = remoteHead(repo);
  await app.click(await ui.checkbox("Push after commit"));
  await ui.fill(await ui.summary(), "Notiz zwei");
  await app.press("Control+Shift+Enter");
  const toast = await ui.waitToast("warning", /not pushed/, 30_000);
  assertMatch(toast, /Retry push/, "toast offers Retry push");
  assertEqual(repo.git("log", "-1", "--format=%s"), "Notiz zwei", "git: the commit exists anyway");
  assertEqual(remoteHead(repo), remoteBefore, "git: the remote is unchanged");
  await t.shot("push-rejected");
  await t.noConsoleErrors(app);
}));

scenario("Push after commit is disabled without a remote", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => {
    r.git("remote", "remove", "origin");
    r.write("notiz.md", "drei\n");
  });
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one new file");
  const box = await ui.checkbox("Push after commit");
  assertEqual(await box.prop("disabled"), true, "checkbox disabled");
  await until(() => app.byText("No remote set up.", { exact: false }), "hint: no remote");
  await ui.fill(await ui.summary(), "Ohne Remote");
  await app.press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/);
  assert(!(await ui.toasts()).some((text) => /push/i.test(text)), "no push attempted");
  assertEqual(repo.git("log", "-1", "--format=%s"), "Ohne Remote", "git: commit created");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Commit templates
// =============================================================================================

const TEMPLATE = ["# Erste Zeile: was sich ändert.", "Thema: ", "", "Warum: ", "Ticket: #", "# Kommentare landen nicht im Commit.", ""].join("\n");
const PREFILLED = { summary: "Thema:", description: "Warum: \nTicket: #" };
/** Writes `text` as commit.template into the app's global gitconfig (outside the repository). */
const globalTemplate = (text) => async (app, repo) => {
  const file = `${repo.root}/vorlagen/commit-vorlage.txt`;
  writeBytes({ path: repo.root }, "vorlagen/commit-vorlage.txt", text);
  const fs = await import("node:fs");
  fs.appendFileSync(app.gitConfigPath, `[commit]\n\ttemplate = ${file}\n`);
};

scenario("global commit template prefills the form; untouched template is refused; filled one commits", "main", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => r.write("README.md", `${readText(r, "README.md")}\nVorlage ausprobiert.\n`), { beforeOpen: globalTemplate(TEMPLATE) });
  const before = repo.git("rev-parse", "HEAD");
  await eventually(ui.fields, PREFILLED, "template fills the fields without comment lines");
  const draft = await app.invoke("draft_get", { repoId });
  assertEqual([draft.summary, draft.description, draft.amend], ["", "", false], "the template alone is no draft");
  await t.shot("template-prefilled");
  await app.press("Control+Shift+s");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "staged");
  await app.click(await ui.commitButton());
  await eventually(ui.formAlert, "This is still the unchanged commit template. Add what changes.", "untouched template refused");
  assertEqual(repo.git("rev-parse", "HEAD"), before, "git: no commit");
  // Fill in: summary at the end, description lines.
  await app.click(await ui.summary());
  await app.press("End");
  await app.type(await ui.summary(), " Regenmesser neu geeicht");
  await app.press("Enter");
  await app.press("Control+Home", "End");
  await app.type(await ui.description(), "Die Werte lagen zu hoch.");
  await app.press("Control+End");
  await app.type(await ui.description(), "412");
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  const message = repo.git("log", "-1", "--format=%B").trim();
  assertEqual(message, "Thema: Regenmesser neu geeicht\n\nWarum: Die Werte lagen zu hoch.\nTicket: #412", "git: message from template and input, no comments");
  await eventually(ui.fields, PREFILLED, "after the commit the template is back");
  await t.noConsoleErrors(app);
}));

scenario("templates: comment-only prefills nothing, missing file is silent, repository template wins", "edge", withRepo(async (t) => {
  const { repo, app, ui, repoId } = await setup(t, (r) => r.write("README.md", `${readText(r, "README.md")}\nx\n`), { beforeOpen: globalTemplate("# Nur Hinweise.\n# Nichts davon gehört in die Message.\n") });
  await app.settle();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assertEqual(await ui.fields(), { summary: "", description: "" }, "comment-only template prefills nothing");
  // Repository template (commit.template in .git/config) takes precedence.
  repo.write(".gitmessage", "# Vorlage des Repositories\nMessnetz: \n\nStation: \n");
  const saved = await app.invoke("repo_settings_set", { repoId, patch: { commitTemplate: ".gitmessage" } });
  assertIncludes(saved.commitTemplateText ?? "", "Messnetz:", "core reads the repository template");
  assertEqual(repo.git("config", "--local", "commit.template"), ".gitmessage", "git config: commit.template in the repository");
  await eventually(ui.fields, { summary: "Messnetz:", description: "Station:" }, "the repository template fills the form");
  // A template file that does not exist: empty fields and no error message.
  await app.invoke("repo_settings_set", { repoId, patch: { commitTemplate: "fehlt/gibt-es-nicht.txt" } });
  await app.reload();
  await app.settle();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assertEqual(await ui.fields(), { summary: "", description: "" }, "missing template file: fields stay empty");
  assertEqual(await ui.toasts("danger"), [], "no error message for a missing template");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Co-authors
// =============================================================================================

const JONAS = "Jonas Albrecht <jonas.albrecht@wetterstation.example>";
const GRETA = "Greta Vogel <greta.vogel@wetterstation.example>";

scenario("co-author trailers in the description end up in the commit and in the commit details", "main", withRepo(async (t) => {
  const { repo, app, ui, repoId, tabId } = await setup(t, (r) => r.write("tests/test_pruefung.py", "def test_bereich():\n    assert True\n"));
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one new file");
  await app.press("Control+Shift+s");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "staged");
  await ui.fill(await ui.summary(), "Tests für die Plausibilitätsprüfung");
  await app.click(await ui.description());
  await ui.typeLines(await ui.description(), `Drei Fälle geprüft.\n\nCo-authored-by: ${JONAS}\nCo-authored-by: ${GRETA}`);
  await eventually(async () => (await ui.fields()).description, `Drei Fälle geprüft.\n\nCo-authored-by: ${JONAS}\nCo-authored-by: ${GRETA}`, "description with trailers");
  await t.shot("co-authors-form");
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  const sha = repo.git("rev-parse", "HEAD");
  assertEqual(lines(repo.git("log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)")), [JONAS, GRETA], "git: both Co-authored-by trailers");
  assertEqual(repo.git("log", "-1", "--format=%an"), "Lena Hartmann", "git: author is the profile identity");
  // Commit details show both as co-authors and do not repeat the trailer lines in the text.
  await ui.selectCommit(tabId, sha);
  const panel = '[data-screen="commit-details"]';
  await app.waitFor(() => app.exec((css, short) => document.querySelector(css)?.innerText.includes(short), panel, sha.slice(0, 7)), 15_000, { message: "details of the new commit" });
  await app.settle();
  const text = await app.exec((css) => document.querySelector(css).innerText, panel);
  for (const expected of ["Jonas Albrecht", "Greta Vogel", "Co-author", "Lena Hartmann"]) assertIncludes(text, expected, "commit details");
  assert(!/co-authored-by/i.test(text), "trailer lines are not repeated in the description");
  await t.shot("co-authors-details");
  await t.noConsoleErrors(app);
}));

scenario("co-authors: case-insensitive key, name without email, duplicates once; amend keeps trailers", "edge", withRepo(async (t) => {
  const { repo, app, ui, tabId } = await setup(t, (r) => {
    r.write("a.txt", "a\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", `Erster Teil\n\nCo-authored-by: ${JONAS}\nco-AUTHORED-by:  ${GRETA} \nCo-authored-by: Nur Name\nCo-authored-by: ${JONAS}\nCo-authored-by:`);
  });
  const sha = repo.git("rev-parse", "HEAD");
  await ui.selectCommit(tabId, sha);
  const panel = '[data-screen="commit-details"]';
  await app.waitFor(() => app.exec((css, short) => document.querySelector(css)?.innerText.includes(short), panel, sha.slice(0, 7)), 15_000, { message: "details" });
  await app.settle();
  const text = await app.exec((css) => document.querySelector(css).innerText, panel);
  assertEqual(text.split("Jonas Albrecht").length - 1, 1, "duplicate co-author listed once");
  assertIncludes(text, "Greta Vogel", "lower/upper-case trailer key recognised");
  assertIncludes(text, "Nur Name", "a co-author without email is listed by name");
  const roles = await app.exec((css) => [...document.querySelectorAll(`${css} span[aria-hidden]`)].filter((node) => node.textContent.trim() === "Co-author").length, panel);
  assertEqual(roles, 3, "three co-authors (empty trailer ignored)");
  assert(!/co-authored-by/i.test(text), "trailer lines are not repeated in the description");
  await t.shot("co-authors-edge-details");
  // Amend keeps the trailers that are in the loaded description.
  await ui.selectWip(tabId);
  await app.click(await ui.checkbox("Amend last commit"));
  await eventually(async () => (await ui.fields()).summary, "Erster Teil", "amend loads the message");
  assertIncludes((await ui.fields()).description, `Co-authored-by: ${JONAS}`, "trailers are in the loaded description");
  await ui.fill(await ui.summary(), "Erster Teil, überarbeitet");
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit amended/);
  assertEqual(repo.git("log", "-1", "--format=%s"), "Erster Teil, überarbeitet", "git: summary amended");
  assertIncludes(repo.git("log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)"), JONAS, "git: trailer kept after amend");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Signing
// =============================================================================================

/** Selects an option of a Radix select inside `scope` with the mouse. */
async function chooseOption(app, trigger, option) {
  await app.click(trigger);
  // The option of THIS select's popup (the commit panel lists are listboxes with options too).
  const item = await app.waitFor(
    () =>
      app.exec((button, wanted) => {
        const list = document.getElementById(button.getAttribute("aria-controls") ?? "");
        return [...(list?.querySelectorAll('[role="option"]') ?? [])].find((node) => node.textContent.trim().startsWith(wanted)) ?? null;
      }, trigger, option),
    10_000,
    { message: `option "${option}"` },
  );
  await app.click(item);
  await app.waitFor(async () => (await trigger.attr("aria-expanded")) === "false", 5000, { message: "select closed" });
}

scenario("sign commits with an SSH key set up in Settings; the commit carries a valid signature", "main", withRepo(async (t) => {
  const fs = await import("node:fs");
  let sshDir = null;
  const { repo, app, ui, repoId, tabId } = await setup(
    t,
    (r) => {
      sshDir = `${r.root}/ssh`;
      fs.mkdirSync(sshDir, { recursive: true });
      r.write("README.md", `${readText(r, "README.md")}\nSigniert.\n`);
    },
    { launch: () => ({ env: { FORKYARD_SSH_DIR: sshDir } }) },
  );
  // The key is generated by the app into the redirected SSH folder (never ~/.ssh).
  const keys = await app.invoke("ssh_key_generate", { label: "Signier-Schlüssel", fileName: "id_signieren", passphrase: null });
  const key = keys.find((item) => item.label === "Signier-Schlüssel");
  assert(key && key.publicKeyPath.startsWith(sshDir), `key in the redirected SSH folder (${key?.publicKeyPath})`);
  await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "sshKeys"] }));
  const globalConfig = (name) => {
    try {
      return repo.git("config", "--file", app.gitConfigPath, "--get", name);
    } catch {
      return null;
    }
  };

  // Settings › Git behavior › Sign commits.
  await app.press("Control+,");
  const prefs = '[data-screen="settings"]';
  await app.waitFor(prefs);
  await app.click({ text: "Git behavior", within: prefs });
  await app.waitFor('[data-signing="global"][data-signing-state="ready"]', 15_000);
  const scope = '[data-signing="global"]';
  await chooseOption(app, await app.waitFor(`${scope} [data-setting="Format"] [role="combobox"]`), "SSH");
  await eventually(() => globalConfig("gpg.format"), "ssh", "git config --global gpg.format");
  await chooseOption(app, await app.waitFor(`${scope} [data-setting="SSH key"] [role="combobox"]`), "Signier-Schlüssel");
  await eventually(() => globalConfig("user.signingkey"), key.publicKeyPath, "git config --global user.signingKey");
  const toggle = await app.waitFor(`${scope} [data-setting="Sign commits"] [role="switch"]`);
  await eventually(() => toggle.prop("disabled"), false, "switch enabled once a key is chosen");
  await app.click(toggle);
  await eventually(() => globalConfig("commit.gpgsign"), "true", "git config --global commit.gpgSign");
  await until(async () => (await app.exec((css) => document.querySelector(css)?.innerText ?? "", scope)).includes("Signing on"), "badge Signing on");
  await app.exec((css) => document.querySelector(css)?.scrollIntoView({ block: "center" }), scope);
  await t.shot("signing-settings");
  await app.press("Escape");
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), prefs), 5000, { message: "settings closed" });

  // Commit from the panel.
  await ui.selectWip(tabId);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one change");
  await ui.fill(await ui.summary(), "Signiert aus der App");
  await app.press("Control+Shift+Enter");
  await ui.waitToast("success", /Commit created/, 30_000);
  const sha = repo.git("rev-parse", "HEAD");
  assertMatch(repo.git("cat-file", "commit", sha), /^gpgsig -----BEGIN SSH SIGNATURE-----/m, "git: the commit carries an SSH signature");
  // With an allowed-signers file Git verifies it as good, and so does the badge.
  const allowed = `${repo.root}/allowed_signers`;
  fs.writeFileSync(allowed, `lena.hartmann@wetterstation.example ${key.publicKey.trim()}\n`);
  repo.git("config", "gpg.ssh.allowedSignersFile", allowed);
  assertEqual(repo.git("log", "-1", "--format=%G?", sha), "G", "git log %G?: good signature");
  await app.exec((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "commit"] }), repoId);
  await ui.selectCommit(tabId, sha);
  const mark = await app.waitFor('[data-screen="commit-details"] [data-signature]', 15_000);
  await eventually(() => mark.attr("data-signature"), "good", "badge: signature valid");
  assertEqual(await mark.attr("aria-label"), "Signature valid", "badge label");
  await t.shot("signing-commit-valid");
  await t.noConsoleErrors(app);
}));

scenario("signing with a missing key: commit fails with a message, nothing is committed, the form stays", "edge", withRepo(async (t) => {
  const fs = await import("node:fs");
  const { repo, app, ui, repoId } = await setup(t, (r) => r.write("README.md", `${readText(r, "README.md")}\nx\n`), {
    beforeOpen: (app, r) => fs.appendFileSync(app.gitConfigPath, `[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${r.root}/fehlt/id_weg.pub\n[commit]\n\tgpgsign = true\n`),
  });
  const count = repo.git("rev-list", "--count", "HEAD");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one change");
  await ui.fill(await ui.summary(), "Kann nicht signiert werden");
  await app.press("Control+Shift+Enter");
  const toast = await ui.waitToast("danger", /./, 30_000);
  t.step(`error toast: ${toast}`);
  assertEqual(repo.git("rev-list", "--count", "HEAD"), count, "git: no commit created");
  assertEqual((await ui.fields()).summary, "Kann nicht signiert werden", "summary kept");
  assertEqual(lines(repo.git("diff", "--cached", "--name-only")), ["README.md"], "git: the file stays staged");
  await t.shot("signing-missing-key");
  // What the core reports for the same call.
  let failure = null;
  try {
    await app.invoke("commit_create", { repoId, opId: `op-sign-${Date.now()}`, summary: "Direkt", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
  } catch (error) {
    failure = error;
  }
  t.step(`core: code=${failure?.code} message=${failure?.message} gitOutput=${JSON.stringify(failure?.gitOutput)?.slice(0, 300)}`);
  assert(failure, "core refuses the commit");
  assertMatch(failure.gitOutput ?? "", /sign|key/i, "git output names the signing problem");
  await ui.closeToasts();
  await t.noConsoleErrors(app);
  // The toast must point at the signing key – not claim the repository changed outside the app.
  assert(!/changed outside the app/i.test(toast), `misleading error toast for a missing signing key: "${toast}"`);
  assertMatch(toast, /sign|key/i, "toast names the signing problem");
}));
