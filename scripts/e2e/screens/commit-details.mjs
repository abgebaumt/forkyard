/**
 * commit-details – commit panel (commit details) in the real app against real Git repositories.
 *
 *   node scripts/e2e/screens/commit-details.mjs            everything, writes the images to target/e2e/shots/
 *   node scripts/e2e/screens/commit-details.mjs --show     window visible
 *   node scripts/e2e/screens/commit-details.mjs --no-shots without images
 *
 * Checked: a normal, a merge and the root commit; long summary; copying; opening a file;
 * comparing two commits with swap; comparing with the working directory; range; non-contiguous
 * selection; stash (apply, pop, delete with confirmation); all files with filter;
 * editing the message of the last commit – keyboard only, verified in the repository;
 * states loading, error, empty, 600 changed and 20,000 files. Aborts on console errors.
 *
 * The script sets the graph selection through the app store (`selectCommits`) so it does not
 * depend on the state of the graph (commit-graph); the keyboard run selects via the commit search.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeConflictRepo, makeEmptyRepo, makeRichRepo, TEST_IDENTITY } from "../fixtures.mjs";
import { assertNoConsoleErrors, captureClipboard, closeToasts, createChecks, gitIn, lines, makeManyFilesRepo, overflowX, storeApi, tabUntil, tamper, toasts } from "./commit-panel-lib.mjs";

const show = process.argv.includes("--show");
const shots = !process.argv.includes("--no-shots");
const { failures, check, equal, eventually, section } = createChecks();
const SHOT_DIR = "target/e2e/shots";
const PANEL = '[data-screen="commit-details"]';
const short = (sha) => sha.slice(0, 7);

const cleanups = [];
const apps = [];
const fixture = (made) => {
  cleanups.push(() => made.cleanup());
  return made;
};
const launch = async (options = {}) => {
  const app = await launchApp({ show, ...options });
  apps.push(app);
  return app;
};
const shot = async (app, name) => {
  if (!shots) return;
  await app.settle();
  await app.page.waitForTimeout(150);
  await app.screenshot(`${SHOT_DIR}/${name}.png`);
};

/** Waits until the panel fully shows a single commit and returns its summary. */
const waitSingle = async (page, sha) => {
  await page.locator(`${PANEL} code[title="${sha}"]`).waitFor();
  return page.locator(`${PANEL} [data-testid="commit-summary"]`).innerText();
};
const fileRows = (page, label) => page.locator(`${PANEL} [role="listbox"][aria-label="${label}"] [role="option"]`);
const filesSummary = (page) => page.locator(`${PANEL} [data-testid="files-summary"]`).innerText();

try {
  // =========================================================================
  // A. Rich repository with uncommitted changes and two stashes
  // =========================================================================
  const rich = fixture(makeRichRepo());
  const { shas } = rich.info;
  const parentsOf = (sha) => lines(rich.git("rev-list", "--parents", "-n", "1", sha))[0].split(" ").slice(1);
  const nameStatus = (...args) => lines(rich.git("diff", "--name-status", "--no-renames", ...args));

  {
    const app = await launch({ width: 1440, height: 900, theme: "dark" });
    const { page } = app;
    const { tabId } = await app.openRepo(rich.path);
    const store = storeApi(app, tabId);
    const panel = page.locator(PANEL);

    await section("A normal commit: message, author, co-authors, SHA, parents, files", async () => {
      await store.selectCommits([shas.coAuthored]);
      equal(await waitSingle(page, shas.coAuthored), "Tests für die Plausibilitätsprüfung", "summary");
      const description = await panel.locator('[data-testid="commit-description"]').innerText();
      check(description.includes("Drei Fälle: Wert im Bereich"), `description is there (${JSON.stringify(description)})`);
      check(!/co-authored-by/i.test(description), "the Co-authored-by lines are not repeated in the description");
      const meta = await panel.locator('[data-testid="commit-meta"]').innerText();
      for (const expected of ["Mats Öztürk", "mats.oeztuerk@wetterstation.example", "Jonas Albrecht", "Greta Vogel", "Co-author", "Author"]) check(meta.includes(expected), `header names “${expected}”`);
      check(!meta.includes("Committer"), "no committer, because it equals the author");
      equal(await panel.locator(`code[title="${shas.coAuthored}"]`).innerText(), short(shas.coAuthored), "short SHA");
      equal(await panel.locator('[data-testid="commit-parents"] button').evaluateAll((list) => list.map((item) => item.dataset.sha)), parentsOf(shas.coAuthored), "parents as links");
      equal(await panel.locator('[data-testid="not-pushed"]').count(), 0, "no “not pushed yet” hint (the commit is on origin/main)");
      equal(await panel.locator("[data-signature]").count(), 0, "no signature mark for an unsigned commit");
      equal(await panel.getByRole("button", { name: "Edit message" }).count(), 0, "no “Edit message” for an older commit");
      const rows = await fileRows(page, "Changed files of this commit").allInnerTexts().then((list) => list.map((row) => row.replace(/\s+/g, " ").trim()));
      equal(rows.length, 1, "one changed file");
      check(/^A ?new ?test_pruefung\.py ?tests\/ ?\+13$/.test(rows[0] ?? ""), `row with status, name, folder and line count (${JSON.stringify(rows[0])})`);
      const sum = (await filesSummary(page)).replace(/\s+/g, " ").trim();
      check(/^1 file ?\+13/.test(sum), `total in the list header (${JSON.stringify(sum)})`);
      // author's original time with time zone in the tooltip
      const original = await panel.locator("time[data-original]").first().getAttribute("data-original");
      check(/\(UTC\+01:00\)$/.test(original ?? ""), `tooltip names the author's time zone (${original})`);
      await shot(app, "commit-details");
    });

    await section("Date follows the “Date format” setting", async () => {
      const read = () => panel.locator("time[data-original]").first().innerText();
      const before = await read();
      check(/^(\d+ \w+ ago|just now|yesterday|last |in )/.test(before), `relative by default (${before})`);
      await app.invoke("settings_set", { patch: { dateFormat: "iso" } });
      await eventually(async () => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(await read()), true, "ISO format after changing the setting");
      await app.invoke("settings_set", { patch: { dateFormat: "relative" } });
      await eventually(read, before, "relative again");
    });

    await section("Copy SHA with feedback", async () => {
      // Recording instead of the real clipboard: the test does not touch the machine's clipboard.
      const clipboard = await captureClipboard(page);
      await panel.getByRole("button", { name: "Copy SHA" }).click();
      await eventually(() => panel.locator('button[data-copied="true"]').count(), 1, "the button shows “copied”");
      equal(await panel.getByRole("button", { name: "SHA copied" }).count(), 1, "the button name says “SHA copied”");
      equal(await clipboard.copied(), [shas.coAuthored], "the full SHA is copied");
      await eventually(() => panel.locator('button[data-copied="true"]').count(), 0, "the feedback disappears again", 5000);
    });

    await section("Clicking a file opens the diff of this commit", async () => {
      await fileRows(page, "Changed files of this commit").first().click();
      await eventually(store.center, { kind: "diff", path: "tests/test_pruefung.py", source: { kind: "commit", sha: shas.coAuthored } }, "center shows the diff");
      equal(await fileRows(page, "Changed files of this commit").first().getAttribute("aria-selected"), "true", "the row is selected");
      await store.closeCenter();
    });

    await section("File context menu: right-click and Shift+F10", async () => {
      const row = fileRows(page, "Changed files of this commit").first();
      const menu = page.getByRole("menu");
      await row.click({ button: "right" });
      await menu.waitFor();
      check((await menu.getByRole("menuitem").count()) > 0, "right-click opens a menu with entries");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await row.focus();
      await page.keyboard.press("Shift+F10");
      await menu.waitFor();
      check((await menu.getByRole("menuitem").count()) > 0, "Shift+F10 opens the same menu by keyboard");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      equal(await store.selection(), { kind: "commits", shas: [shas.coAuthored] }, "the graph selection stays");
    });

    await section("200-character summary and multi-line description", async () => {
      await store.selectCommits([shas.longSummary]);
      const summary = await waitSingle(page, shas.longSummary);
      const expected = rich.git("log", "-1", "--format=%s", shas.longSummary);
      check(expected.length > 150, "the fixture has a very long summary");
      equal(summary, expected, "summary shown in full, not truncated");
      const description = await panel.locator('[data-testid="commit-description"]').innerText();
      equal(description, rich.git("log", "-1", "--format=%b", shas.longSummary).trim(), "description with line breaks as in the commit");
      equal(await overflowX(page, `${PANEL} [data-testid="commit-meta"]`), { page: 0, element: 0 }, "no horizontal overflow");
      const box = await panel.locator('[data-testid="commit-summary"]').boundingBox();
      check(box && box.height > 60, `the summary wraps (height ${box?.height})`);
      check((await fileRows(page, "Changed files of this commit").count()) === 1, "the file list stays visible");
      await shot(app, "commit-details-long");
    });

    await section("Very long lines without spaces do not break the panel", async () => {
      // This commit only exists in the repository, on no branch – the panel shows the details anyway.
      const body = `${"x".repeat(400)}\n\nhttps://example.org/${"pfad/".repeat(60)}?frage=1\n<script>window.__gcInjected = true</script> <b>fett</b>`;
      const tree = rich.git("rev-parse", `${shas.head}^{tree}`);
      const sha = gitIn(rich.path, ["commit-tree", tree, "-p", shas.head, "-m", `${"Langeswortohneleerzeichen".repeat(8)}\n\n${body}`]);
      await store.selectCommits([sha]);
      await waitSingle(page, sha);
      equal(await overflowX(page, `${PANEL} [data-testid="commit-meta"]`), { page: 0, element: 0 }, "no horizontal overflow");
      const description = panel.locator('[data-testid="commit-description"]');
      check((await description.innerText()).includes("<script>window.__gcInjected = true</script> <b>fett</b>"), "HTML in the message is shown as plain text");
      equal(await description.locator("a, b, script").count(), 0, "no links and no HTML from the message");
      equal(await page.evaluate(() => window.__gcInjected ?? null), null, "nothing from the message was executed");
      equal(await panel.locator('[data-testid="files-empty"]').innerText(), "This commit doesn’t change any files.", "a commit without files says so");
    });

    await section("Merge commit: note about the first parent, both parents clickable", async () => {
      await store.selectCommits([shas.firstMerge]);
      equal(await waitSingle(page, shas.firstMerge), "Merge branch 'feature/regen-auswertung'", "summary");
      const parents = parentsOf(shas.firstMerge);
      equal(parents.length, 2, "the fixture has two parents");
      const note = await panel.locator('[data-testid="merge-note"]').innerText();
      check(note.includes(short(parents[0])) && /first parent/.test(note), `note names the first parent (${note})`);
      equal(await panel.locator('[data-testid="commit-parents"] button').evaluateAll((list) => list.map((item) => item.dataset.sha)), parents, "both parents");
      const expected = nameStatus(parents[0], shas.firstMerge).map((line) => line.split("\t")[1].split("/").pop());
      equal(await fileRows(page, "Changed files of this commit").evaluateAll((rows) => rows.map((row) => row.getAttribute("title").split("/").pop())), expected, "files as git diff against the first parent");
      await shot(app, "commit-details-merge");
      await panel.locator('[data-testid="commit-parents"] button').nth(1).click();
      await eventually(store.selection, { kind: "commits", shas: [parents[1]] }, "clicking the second parent selects it");
      await waitSingle(page, parents[1]);
      const reveal = (await store.view()).reveal;
      equal(reveal?.sha, parents[1], "the graph is asked to scroll there");
    });

    await section("Root commit: no parent, all files new", async () => {
      await store.selectCommits([shas.first]);
      equal(await waitSingle(page, shas.first), "Projektgerüst für die Wetterstation-Auswertung", "summary");
      equal(await panel.locator('[data-testid="commit-parents"]').innerText(), "The repository’s first commit – it has no parent.", "text instead of parents");
      const rows = await fileRows(page, "Changed files of this commit").allInnerTexts();
      equal(rows.length, 3, "three files");
      check(rows.every((row) => row.startsWith("A")), "all marked as new");
      await shot(app, "commit-details-root");
    });

    await section("Last commit: “not pushed yet” and “Edit message”", async () => {
      await store.selectCommits([shas.head]);
      await waitSingle(page, shas.head);
      equal(await panel.locator('[data-testid="not-pushed"]').innerText(), "Not pushed yet", "hint is there");
      equal(await panel.getByRole("button", { name: "Edit message" }).count(), 1, "“Edit message” for the last commit");
      const labels = await panel.locator('[data-testid="commit-meta"] [title^="Local branch"], [data-testid="commit-meta"] [title^="Tag"]').allInnerTexts();
      check(labels.includes("main"), `ref label main (${JSON.stringify(labels)})`);
    });

    await section("State “loading”: skeleton instead of spinner", async () => {
      const slow = await tamper(page, "commitDetails", { delayMs: 1500 });
      await store.selectCommits([shas.csv]);
      await page.locator(`${PANEL} [role="status"][aria-label="Loading commit"]`).waitFor({ timeout: 3000 });
      equal(await panel.locator('[role="status"][aria-label="Loading files"]').count(), 1, "skeleton rows for the files");
      if (shots) await app.screenshot(`${SHOT_DIR}/commit-details-loading.png`);
      await slow.restore();
      equal(await waitSingle(page, shas.csv), "Messwerte aus CSV-Dateien einlesen", "then the commit");
    });

    await section("Error: the commit does not exist (any more)", async () => {
      const gone = "0123456789abcdef0123456789abcdef01234567";
      await store.selectCommits([gone]);
      const alert = panel.getByRole("alert");
      await alert.waitFor();
      const text = await alert.innerText();
      check(text.includes("This commit no longer exists") && text.includes("rebase, amend or reset"), `explains what happened (${JSON.stringify(text)})`);
      check(text.includes("0123456"), "names the short SHA");
      equal(await toasts(page), [], "no additional toast");
      await shot(app, "commit-details-error");
      await alert.getByRole("button", { name: "Clear selection" }).click();
      await eventually(store.selection, null, "“Clear selection” clears the selection");
    });

    await section("Error while loading (not a missing commit): “Try again”", async () => {
      const broken = await tamper(page, "commitDetails", { fail: { code: "io", message: "The object database could not be read.", gitOutput: null } });
      await store.selectCommits([shas.secondMerge]);
      const alert = panel.getByRole("alert");
      await alert.waitFor();
      check((await alert.innerText()).includes("Could not load the commit"), "general error text");
      check((await alert.innerText()).includes("The object database could not be read."), "the core message is there");
      await broken.restore();
      await alert.getByRole("button", { name: "Try again" }).click();
      equal(await waitSingle(page, shas.secondMerge), "Merge branch 'bugfix/sensor-ausfall'", "after the retry the commit is shown");
    });

    await section("Two commits: comparison, older side first, swap", async () => {
      // Deliberately select the newer one first: the selection order must not matter.
      await store.selectCommits([shas.coAuthored, shas.csv]);
      const head = panel.locator('[data-testid="compare-head"]');
      await head.waitFor();
      const sides = () => head.locator("[data-side]").evaluateAll((list) => list.map((item) => [item.dataset.side, item.dataset.sha]));
      await eventually(sides, [["Von", shas.csv], ["Nach", shas.coAuthored]], "From = older, To = newer commit");
      const text = await head.innerText();
      check(text.includes("older") && text.includes("newer"), "the sides are labelled older and newer");
      check(text.includes("Messwerte aus CSV-Dateien einlesen") && text.includes("Tests für die Plausibilitätsprüfung"), "both summaries are there");
      const label = `Differences from ${short(shas.csv)} to ${short(shas.coAuthored)}`;
      const expected = nameStatus(shas.csv, shas.coAuthored);
      await eventually(() => fileRows(page, label).count(), expected.length, "as many files as git diff");
      const added = expected.filter((line) => line.startsWith("A")).length;
      equal(await fileRows(page, label).evaluateAll((rows) => rows.filter((row) => row.innerText.trim().startsWith("A")).length), added, "as many new files as git diff");
      await shot(app, "commit-details-compare");

      await fileRows(page, label).first().click();
      const path = expected[0].split("\t")[1];
      await eventually(store.center, { kind: "diff", path, source: { kind: "range", from: shas.csv, to: shas.coAuthored } }, "click opens the diff of the range");
      await store.closeCenter();

      await panel.getByRole("button", { name: "Swap sides" }).click();
      await eventually(sides, [["Von", shas.coAuthored], ["Nach", shas.csv]], "reversed after the swap");
      const swapped = `Differences from ${short(shas.coAuthored)} to ${short(shas.csv)}`;
      await eventually(() => fileRows(page, swapped).count(), expected.length, "same number of files");
      equal(await fileRows(page, swapped).evaluateAll((rows) => rows.filter((row) => row.innerText.trim().startsWith("D")).length), added, "what was new before is now deleted");

      await head.locator('[data-side="Nach"]').click();
      await eventually(store.selection, { kind: "commits", shas: [shas.csv] }, "clicking a side shows that commit on its own");
    });

    await section("One commit against the working directory", async () => {
      await store.selectCommits([shas.secondMerge]);
      await waitSingle(page, shas.secondMerge);
      await panel.getByRole("button", { name: "Compare with working directory" }).click();
      const head = panel.locator('[data-testid="compare-head"]');
      await head.waitFor();
      check((await head.innerText()).includes("Working directory"), "the second side is the working directory");
      equal(await panel.getByRole("button", { name: "Swap sides" }).count(), 0, "no swap (the working directory is always the target)");
      const label = `Differences from ${short(shas.secondMerge)} to the working directory`;
      await fileRows(page, label).first().waitFor();
      const titles = await fileRows(page, label).evaluateAll((rows) => rows.map((row) => row.getAttribute("title")));
      // tracked files that differ from the commit, plus untracked ones
      const tracked = lines(rich.git("diff", "--name-only", "--no-renames", shas.secondMerge));
      const untracked = lines(rich.git("ls-files", "--others", "--exclude-standard"));
      for (const file of ["notizen/offene-fragen.md", "src/pruefung.py", "daten/messwerte-2026-02.csv"]) check(titles.some((title) => title?.endsWith(file)), `contains ${file}`);
      check(titles.length >= Math.max(tracked.length, untracked.length), `at least as many files as git reports (${titles.length}; tracked ${tracked.length}, untracked ${untracked.length})`);
      await fileRows(page, label).first().click();
      const center = await store.center();
      equal(center?.source, { kind: "range", from: shas.secondMerge, to: null }, "the diff runs up to the working directory");
      await store.closeCenter();
      await shot(app, "commit-details-worktree");
      await panel.getByRole("button", { name: "To commit" }).click();
      equal(await waitSingle(page, shas.secondMerge), "Merge branch 'bugfix/sensor-ausfall'", "back to the commit details");
    });

    const windsensor = parentsOf(shas.head)[0];
    await section("Range: a contiguous sequence gives a combined diff", async () => {
      equal(parentsOf(windsensor)[0], shas.coAuthored, "the fixture has the expected sequence");
      // select in shuffled order
      await store.selectCommits([windsensor, shas.head, shas.coAuthored]);
      const note = panel.locator('[data-testid="range-note"]');
      await note.waitFor();
      equal(await note.getAttribute("data-from"), shas.longSummary, "compared from the parent of the oldest commit");
      equal(await note.getAttribute("data-to"), shas.head, "up to the newest commit");
      equal(await panel.locator('[data-testid="selection-count"]').innerText(), "3 commits", "number of commits");
      const listed = await panel.locator('[data-testid="selected-commits"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.querySelector("code")?.textContent));
      equal(listed, [short(shas.head), short(windsensor), short(shas.coAuthored)], "the commits are listed newest first");
      const expected = nameStatus(shas.longSummary, shas.head).map((line) => line.split("\t")[1]).sort();
      const label = "Changed files of the 3 commits";
      await eventually(() => fileRows(page, label).evaluateAll((rows) => rows.map((row) => row.getAttribute("title")).sort()), expected, "files as git diff over the whole range");
      await fileRows(page, label).first().click();
      equal((await store.center())?.source, { kind: "range", from: shas.longSummary, to: shas.head }, "click opens the diff of the range");
      await store.closeCenter();
      await shot(app, "commit-details-range");
    });

    await section("Non-contiguous selection: explanation and list of commits", async () => {
      await store.selectCommits([shas.head, shas.coAuthored, shas.csv]);
      const reason = panel.locator('[data-testid="not-combinable"]');
      await reason.waitFor();
      equal(await reason.getAttribute("data-reason"), "gap", "reason: gap");
      const text = await reason.innerText();
      check(text.includes("No combined diff") && text.includes("without gaps"), `explains the reason (${JSON.stringify(text)})`);
      equal(await panel.locator('[role="listbox"][aria-label^="Changed files"]').count(), 0, "no file list");
      const listed = await panel.locator('[data-testid="selected-commits"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.querySelector("code")?.textContent));
      equal(listed, [short(shas.head), short(shas.coAuthored), short(shas.csv)], "the selected commits, newest first");
      await shot(app, "commit-details-not-combinable");

      // Keyboard: into the list, second entry, Enter shows it on its own
      await panel.locator('[role="listbox"][aria-label="Selected commits"]').focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: [shas.coAuthored] }, "Enter shows the highlighted commit on its own");

      // merge side branch and main line mixed: not a sequence either
      const [mainParent, sideParent] = parentsOf(shas.firstMerge);
      await store.selectCommits([shas.firstMerge, mainParent, sideParent]);
      await reason.waitFor();
      equal(await reason.getAttribute("data-reason"), "gap", "a merge with both parents is not a simple sequence");
    });

    await section("Sequence from the root commit: combined diff against the empty tree", async () => {
      const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const chain = lines(rich.git("rev-list", "--reverse", "--first-parent", shas.head)).slice(0, 3);
      const third = chain[2];
      equal(chain[0], shas.first, "the fixture starts at the root commit");
      // selected in shuffled order
      await store.selectCommits([shas.csv, third, shas.first]);
      const note = panel.locator('[data-testid="range-note"]');
      await note.waitFor();
      equal(await panel.locator('[data-testid="not-combinable"]').count(), 0, "no rejection any more");
      equal(await note.getAttribute("data-from"), "root", "compared from the empty state");
      equal(await note.getAttribute("data-to"), third, "up to the newest of the three");
      check((await note.innerText()).includes("first commit"), `the text names the first commit (${JSON.stringify(await note.innerText())})`);
      check(!(await note.innerText()).includes(short(EMPTY_TREE)), "the SHA of the empty tree appears nowhere");
      equal(await panel.locator('[data-testid="selection-count"]').innerText(), "3 commits", "number of commits");
      const listed = await panel.locator('[data-testid="selected-commits"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.querySelector("code")?.textContent));
      equal(listed, [short(third), short(shas.csv), short(shas.first)], "newest first");

      // Files and line counts as git diff from the empty tree to the third commit: everything added.
      // With umlauts in the path: git must not quote the names.
      const expected = lines(rich.git("-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", EMPTY_TREE, third));
      check(expected.length > 0 && expected.every((line) => line.startsWith("A\t")), `git reports everything as added (${expected.length} files)`);
      const label = "Changed files of the 3 commits";
      await eventually(() => fileRows(page, label).evaluateAll((rows) => rows.map((row) => row.getAttribute("title")).sort()), expected.map((line) => line.split("\t")[1]).sort(), "files as git diff from the empty tree");
      const statuses = await fileRows(page, label).evaluateAll((rows) => [...new Set(rows.map((row) => row.innerText.trim()[0]))]);
      equal(statuses, ["A"], "every file has the status “new”");
      const stat = rich.git("diff", "--shortstat", EMPTY_TREE, third);
      const added = Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0);
      const sum = (await filesSummary(page)).replace(/\s+/g, " ").trim();
      check(sum.includes(`+${added}`) && !sum.includes("−"), `total as git diff --shortstat: +${added} (${JSON.stringify(sum)})`);
      await shot(app, "commit-details-range-root");

      // The diff of one file: the source is the range from the empty tree; the header says “Start”, all lines are new.
      await fileRows(page, label).first().click();
      const center = await store.center();
      equal(center?.source, { kind: "range", from: EMPTY_TREE, to: third }, "click opens the diff of the range from the empty tree");
      const diff = page.locator('[data-screen="diff"]');
      await diff.locator("[data-diff-grid], [data-notice]").first().waitFor();
      const head = await diff.locator("[data-diff-header]").innerText();
      check(head.includes(`Start … ${short(third)}`), `the header says “Start … ${short(third)}” (${JSON.stringify(head)})`);
      const fileLines = lines(rich.git("show", `${third}:${center.path}`));
      await eventually(() => diff.locator('[data-diff-grid] [data-kind="remove"]').count(), 0, "no removed lines");
      equal(await diff.locator("[data-diff-counts]").innerText().then((text) => text.replace(/\s+/g, "")), `+${fileLines.length}`, "as many lines added as the file has in the commit");
      await shot(app, "diff-range-root");
      await store.closeCenter();

      // Two commits, one of them the root commit: stays a comparison of two states.
      await store.selectCommits([shas.first, shas.csv]);
      await panel.locator('[data-testid="compare-head"]').waitFor();
      equal(await note.count(), 0, "two commits are a comparison, not a range");
    });

    await section("Stash: message, branch, date, files, actions", async () => {
      const list = lines(rich.git("stash", "list", "--format=%gs"));
      equal(list.length, 2, "the fixture has two stashes");
      await store.selectStash(0);
      const message = panel.locator('[data-testid="stash-message"]');
      await message.waitFor();
      equal(await message.innerText(), "Ideen für das README", "stash message");
      equal((await panel.locator('[data-testid="stash-branch"]').innerText()).trim(), "main", "branch");
      const rows = await fileRows(page, "Files in this stash").evaluateAll((items) => items.map((row) => `${row.innerText.trim()[0]} ${row.getAttribute("title")}`));
      equal(rows.sort(), ["M README.md", "U notizen/ideen.txt"], "stash files including untracked ones");
      for (const name of ["Apply", "Pop", "Delete"]) equal(await panel.getByRole("button", { name, exact: true }).count(), 1, `button “${name}”`);
      await fileRows(page, "Files in this stash").first().click();
      equal((await store.center())?.source, { kind: "stash", index: 0 }, "click opens the diff from the stash");
      await store.closeCenter();
      await shot(app, "commit-details-stash");
    });

    await section("Delete stash: confirmation with focus on “Cancel”", async () => {
      await panel.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      check((await dialog.innerText()).includes("Ideen für das README"), "the confirmation names the stash");
      await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on “Cancel”");
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "detached" });
      equal(lines(rich.git("stash", "list")).length, 2, "after “Cancel” both stashes are still there");

      await panel.getByRole("button", { name: "Delete", exact: true }).click();
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Delete stash" }).click();
      await eventually(() => lines(rich.git("stash", "list", "--format=%gs")), ["On main: Kalibrierung: engere Grenzen ausprobieren"], "only the other stash is left in the repository");
      await eventually(store.selection, { kind: "wip" }, "the selection jumps to the local changes");
      await closeToasts(page);
    });

    await section("Stash that does not exist: explained error", async () => {
      await store.selectStash(7);
      const alert = panel.getByRole("alert");
      await alert.waitFor();
      check((await alert.innerText()).includes("This stash no longer exists"), "error text");
      await alert.getByRole("button", { name: "Clear selection" }).click();
      await eventually(store.selection, null, "selection cleared");
    });

    await section("All files: toggle, filter, no matches, open file", async () => {
      await store.selectCommits([shas.head]);
      await waitSingle(page, shas.head);
      await panel.getByRole("radio", { name: "All files" }).click();
      const all = lines(rich.git("ls-tree", "-r", "--name-only", "-z", shas.head).replaceAll("\0", "\n"));
      const count = panel.locator('[data-testid="tree-count"]');
      await eventually(() => count.innerText(), `${all.length} files`, "number of all files as git ls-tree");
      const options = panel.locator('[role="listbox"][aria-label="All files of this commit"] [role="option"]');
      equal(await options.evaluateAll((rows) => rows.map((row) => row.querySelector("[title]").getAttribute("title"))), all, "all paths in Git's order");
      await shot(app, "commit-details-all-files");

      const filter = panel.getByRole("textbox", { name: "Filter files" });
      await filter.fill("CSV");
      const csvFiles = all.filter((file) => file.toLowerCase().includes("csv"));
      await eventually(() => count.innerText(), `${csvFiles.length} of ${all.length} files`, "filter as substring, case-insensitive");
      equal(await options.evaluateAll((rows) => rows.map((row) => row.querySelector("[title]").getAttribute("title"))), csvFiles, "only matching paths");

      await filter.fill("gibt-es-nicht-xyz");
      await panel.getByText("No file found").waitFor();
      check((await panel.locator('[data-testid="files-all"]').innerText()).includes("“gibt-es-nicht-xyz”"), "the empty state names the search text");
      await shot(app, "commit-details-all-files-empty");
      await filter.press("Escape");
      await eventually(() => filter.inputValue(), "", "Esc clears the filter");
      await eventually(() => count.innerText(), `${all.length} files`, "all files again");
      equal(await store.selection(), { kind: "commits", shas: [shas.head] }, "Esc in the filter does not change the selection");

      await filter.fill("größen");
      await eventually(() => options.count(), 1, "umlauts in the filter");
      await options.first().click();
      await eventually(store.center, { kind: "file", path: rich.info.umlautFile, sha: shas.head, mode: "view" }, "click opens the file at this state");
      await store.closeCenter();
      await panel.getByRole("radio", { name: "Changed" }).click();
      await fileRows(page, "Changed files of this commit").first().waitFor();
    });

    await section("Window sizes and themes", async () => {
      await store.selectCommits([shas.coAuthored]);
      await waitSingle(page, shas.coAuthored);
      await app.setTheme("light");
      await shot(app, "commit-details-light");
      await app.setTheme("dark");
      await app.setSize(960, 600);
      await page.waitForTimeout(300);
      equal(await overflowX(page, PANEL), { page: 0, element: 0 }, "960×600: no horizontal overflow");
      check((await fileRows(page, "Changed files of this commit").first().boundingBox()) !== null, "960×600: the file list is visible");
      await shot(app, "commit-details-min");
      await store.selectCommits([shas.longSummary]);
      await waitSingle(page, shas.longSummary);
      const list = await panel.locator('[data-testid="files-changed"]').boundingBox();
      check(list && list.height >= 48, `960×600 with a long message: the file list keeps its space (height ${list?.height})`);
      await shot(app, "commit-details-min-long");
      await app.setSize(1440, 900);
    });

    assertNoConsoleErrors(app, "rich repository");
    await app.close();
  }

  // =========================================================================
  // B. Clean repository: edit message – keyboard only – and stash apply / pop
  // =========================================================================
  {
    const clean = fixture(makeRichRepo({ dirty: false }));
    const head = clean.info.shas.head;
    // create two stashes before the app opens the repository
    clean.write("src/sensoren.py", `${clean.git("show", "HEAD:src/sensoren.py")}\n# Notiz eins\n`);
    clean.git("stash", "push", "-q", "-m", "Erste Notiz");
    clean.write("README.md", `${clean.git("show", "HEAD:README.md")}\nZweite Notiz\n`);
    clean.git("stash", "push", "-q", "-m", "Zweite Notiz");

    const app = await launch({ width: 1440, height: 900, theme: "dark" });
    const { page } = app;
    const { tabId } = await app.openRepo(clean.path);
    const store = storeApi(app, tabId);
    const panel = page.locator(PANEL);
    const tree = clean.git("rev-parse", "HEAD^{tree}");
    const authorDate = clean.git("log", "-1", "--format=%an|%aI");

    await section("Keyboard: select commit via search, edit message, Esc discards", async () => {
      await page.keyboard.press("Control+f");
      await page.getByRole("combobox", { name: "Search commits" }).waitFor();
      await page.keyboard.type("Februar");
      await page.locator('[data-screen="commit-search"] [role="option"]').first().waitFor();
      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: [head] }, "Enter in the search selects the last commit");
      await page.keyboard.press("Escape");
      await eventually(store.searchOpen, false, "Esc closes the search");
      await waitSingle(page, head);

      await tabUntil(page, (el) => el?.textContent?.trim() === "Edit message" && Boolean(el.closest('[data-screen="commit-details"]')));
      await page.keyboard.press("Enter");
      const summary = panel.getByRole("textbox", { name: "Summary" });
      await summary.waitFor();
      await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("id") === document.querySelector('[data-screen="commit-details"] form input')?.id), true, "focus is in the “Summary” field");
      equal(await summary.inputValue(), "Messwerte für Februar ergänzt", "the field contains the previous summary");
      equal(await panel.getByText("already been pushed").count(), 0, "no “already pushed” hint for a local commit");
      await page.keyboard.press("Control+a");
      await page.keyboard.type("Das wird verworfen");
      await page.keyboard.press("Escape");
      await eventually(() => panel.getByRole("textbox", { name: "Summary" }).count(), 0, "Esc closes the editor");
      equal(clean.git("log", "-1", "--format=%H %s"), `${head} Messwerte für Februar ergänzt`, "nothing changed in the repository");
      equal(await store.selection(), { kind: "commits", shas: [head] }, "the selection stays");
      await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Edit message", "focus returns to “Edit message”");
    });

    await section("Keyboard: empty summary is rejected", async () => {
      await page.keyboard.press("Enter");
      await panel.getByRole("textbox", { name: "Summary" }).waitFor();
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Delete");
      await page.keyboard.press("Control+Enter");
      await panel.getByText("The summary must not be empty.").waitFor();
      equal(await panel.getByRole("textbox", { name: "Summary" }).getAttribute("aria-invalid"), "true", "the field is marked invalid");
      equal(clean.git("rev-parse", "HEAD"), head, "no commit changed");
    });

    let reworded = null;
    await section("Keyboard: save message (Ctrl+Enter), verified in the repository", async () => {
      await page.keyboard.type("Messwerte für Februar nachgetragen");
      await page.keyboard.press("Tab");
      await page.keyboard.type("Station Nord, 28 Tage.\nQuelle: Datenlogger.");
      await shot(app, "commit-details-reword");
      await page.keyboard.press("Control+Enter");
      await eventually(() => clean.git("log", "-1", "--format=%B").trim(), "Messwerte für Februar nachgetragen\n\nStation Nord, 28 Tage.\nQuelle: Datenlogger.", "new message in the repository");
      reworded = clean.git("rev-parse", "HEAD");
      check(reworded !== head, "the commit has a new SHA");
      equal(clean.git("rev-parse", "HEAD^{tree}"), tree, "the content (tree) is unchanged");
      equal(clean.git("log", "-1", "--format=%an|%aI"), authorDate, "author and author date are unchanged");
      equal(clean.git("status", "--porcelain"), "", "working directory and index are untouched");
      await eventually(store.selection, { kind: "commits", shas: [reworded] }, "the selection moves to the new SHA");
      equal(await waitSingle(page, reworded), "Messwerte für Februar nachgetragen", "the panel shows the new summary");
      equal(await panel.locator('[data-testid="commit-description"]').innerText(), "Station Nord, 28 Tage.\nQuelle: Datenlogger.", "and the new description");
      await eventually(async () => (await toasts(page)).some((text) => text.includes("Message changed")), true, "success message");
      await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Edit message", "focus is back on “Edit message”");
      await closeToasts(page);
    });

    await section("Keyboard: file list, Enter opens the diff", async () => {
      await tabUntil(page, (el) => el?.getAttribute("role") === "option" && Boolean(el.closest('[data-screen="commit-details"] [role="listbox"]')));
      await page.keyboard.press("Enter");
      await eventually(store.center, { kind: "diff", path: "daten/messwerte-2026-02.csv", source: { kind: "commit", sha: reworded } }, "Enter opens the diff");
      await store.closeCenter();
    });

    await section("Keyboard: all files, filter, arrow into the list, Enter opens the file", async () => {
      await panel.locator('[role="listbox"] [role="option"]').first().focus();
      await tabUntil(page, (el) => el?.getAttribute("role") === "radio" && Boolean(el.closest('[data-screen="commit-details"]')), { back: true });
      // segmented toggle: arrow key moves, Space selects
      await page.keyboard.press("ArrowRight");
      await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "All files", "arrow right moves focus to “All files”");
      await page.keyboard.press("Space");
      const filter = panel.getByRole("textbox", { name: "Filter files" });
      await filter.waitFor();
      await tabUntil(page, (el) => el?.getAttribute("aria-label") === "Filter files");
      await page.keyboard.type("auswertung");
      equal(
        await page.evaluate(() => ({ focus: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null, text: document.activeElement?.value ?? null })),
        { focus: "Filter files", text: "auswertung" },
        "the typed text is in the focused filter field",
      );
      await eventually(() => panel.locator('[role="listbox"][aria-label="All files of this commit"] [role="option"]').count(), 1, "one match");
      await page.keyboard.press("ArrowDown");
      await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "All files of this commit", "arrow down moves into the list");
      await page.keyboard.press("Enter");
      await eventually(store.center, { kind: "file", path: "src/auswertung.py", sha: reworded, mode: "view" }, "Enter opens the file view");
      await store.closeCenter();
    });

    await section("Apply stash: changes arrive, the stash stays", async () => {
      await store.selectStash(0);
      await panel.locator('[data-testid="stash-message"]').waitFor();
      equal(await panel.locator('[data-testid="stash-message"]').innerText(), "Zweite Notiz", "newest stash");
      await panel.getByRole("button", { name: "Apply", exact: true }).click();
      await eventually(() => clean.git("status", "--porcelain"), " M README.md", "README.md is changed in the working directory");
      equal(lines(clean.git("stash", "list")).length, 2, "both stashes are still there");
      equal(await store.selection(), { kind: "stash", index: 0 }, "the selection stays on the stash");
      await closeToasts(page);
      clean.git("checkout", "--", "README.md");
    });

    await section("Stash pop: changes arrive, the stash is gone", async () => {
      await store.selectStash(1);
      await eventually(() => panel.locator('[data-testid="stash-message"]').innerText(), "Erste Notiz", "older stash");
      await panel.getByRole("button", { name: "Pop", exact: true }).click();
      await eventually(() => lines(clean.git("stash", "list", "--format=%gs")), ["On main: Zweite Notiz"], "only the other stash is left");
      equal(clean.git("status", "--porcelain"), " M src/sensoren.py", "the change is in the working directory");
      await eventually(store.selection, { kind: "wip" }, "the selection jumps to the local changes");
      await closeToasts(page);
    });

    assertNoConsoleErrors(app, "clean repository");
    await app.close();
  }

  // =========================================================================
  // C. Pushed last commit: warning in the editor
  // =========================================================================
  {
    const remote = fixture(makeCleanRepoWithRemote());
    const app = await launch({ width: 1440, height: 900, theme: "dark" });
    const { page } = app;
    const { tabId } = await app.openRepo(remote.path);
    const store = storeApi(app, tabId);
    const panel = page.locator(PANEL);
    const head = remote.info.head;

    await section("Last commit is already pushed: hint before editing", async () => {
      await store.selectCommits([head]);
      await waitSingle(page, head);
      equal(await panel.locator('[data-testid="not-pushed"]').count(), 0, "no “not pushed yet”");
      await panel.getByRole("button", { name: "Edit message" }).click();
      const banner = panel.getByRole("status").filter({ hasText: "already been pushed" });
      await banner.waitFor();
      check((await banner.innerText()).includes("forced"), "the hint says the next push has to be forced");
      await shot(app, "commit-details-reword-pushed");
      await panel.getByRole("button", { name: "Cancel" }).click();
      equal(remote.git("rev-parse", "HEAD"), head, "nothing changed");
    });

    await section("After a new commit the old one can no longer be edited", async () => {
      equal(await panel.getByRole("button", { name: "Edit message" }).count(), 1, "before: editable");
      remote.write("NOTIZ.md", "Nachtrag\n");
      remote.git("add", "-A");
      remote.git("commit", "-q", "-m", "Nachtrag von außen");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await eventually(() => panel.getByRole("button", { name: "Edit message" }).count(), 0, "after the commit in the terminal: no longer editable", 15000);
      const newHead = remote.git("rev-parse", "HEAD");
      await store.selectCommits([newHead]);
      await waitSingle(page, newHead);
      equal(await panel.locator('[data-testid="not-pushed"]').count(), 1, "the new commit is not pushed yet");
      equal(await panel.getByRole("button", { name: "Edit message" }).count(), 1, "and editable");
    });

    assertNoConsoleErrors(app, "repository with remote");
    await app.close();
  }

  // =========================================================================
  // D. Merge in progress: no message editing
  // =========================================================================
  {
    const conflict = fixture(makeConflictRepo());
    const app = await launch({ width: 1440, height: 900, theme: "dark" });
    const { page } = app;
    const { tabId } = await app.openRepo(conflict.path);
    const store = storeApi(app, tabId);
    const head = conflict.git("rev-parse", "HEAD");

    await section("Merge in progress: “Edit message” is not offered", async () => {
      await store.selectCommits([head]);
      await waitSingle(page, head);
      await app.settle();
      equal(await page.locator(PANEL).getByRole("button", { name: "Edit message" }).count(), 0, "no button during the operation");
    });

    assertNoConsoleErrors(app, "repository in a merge");
    await app.close();
  }

  // =========================================================================
  // E. Very many files
  // =========================================================================
  {
    const many = fixture(makeManyFilesRepo());
    const app = await launch({ width: 1440, height: 900, theme: "dark" });
    const { page } = app;
    const { tabId } = await app.openRepo(many.path);
    const store = storeApi(app, tabId);
    const panel = page.locator(PANEL);

    await section("600 changed files: list virtualized, total correct", async () => {
      await store.selectCommits([many.info.head]);
      await waitSingle(page, many.info.head);
      const sum = (await filesSummary(page)).replace(/\s+/g, " ").trim();
      check(/^600 files ?\+600/.test(sum), `total in the header (${JSON.stringify(sum)})`);
      const rendered = await fileRows(page, "Changed files of this commit").count();
      check(rendered > 0 && rendered < 150, `only the visible rows are in the DOM (${rendered} of 600)`);
      equal(await panel.locator('[data-testid="not-pushed"]').count(), 0, "without a remote no “not pushed yet” hint");
      await shot(app, "commit-details-many-files");
    });

    await section("20,000 files in the root commit: changed files and full tree stay smooth", async () => {
      const started = Date.now();
      await store.selectCommits([many.info.root]);
      await waitSingle(page, many.info.root);
      await eventually(async () => (await filesSummary(page)).replace(/\s+/g, " ").trim().startsWith("20,000 files"), true, "20,000 changed files counted", 30000);
      const changedMs = Date.now() - started;
      const rendered = await fileRows(page, "Changed files of this commit").count();
      check(rendered > 0 && rendered < 150, `changed files virtualized (${rendered} rows in the DOM)`);
      check(changedMs < 15000, `shown in ${changedMs} ms`);

      await panel.getByRole("radio", { name: "All files" }).click();
      const count = panel.locator('[data-testid="tree-count"]');
      await eventually(() => count.innerText(), "20,000 files", "full tree: 20,000 files", 30000);
      const list = panel.locator('[role="listbox"][aria-label="All files of this commit"]');
      const options = list.locator('[role="option"]');
      const inDom = await options.count();
      check(inDom > 0 && inDom < 150, `tree virtualized (${inDom} rows in the DOM)`);

      await list.focus();
      await page.keyboard.press("End");
      await eventually(() => list.locator('[role="option"][data-active="true"]').getAttribute("aria-posinset"), "20000", "End jumps to the last file");
      await page.keyboard.press("Home");
      await eventually(() => list.locator('[role="option"][data-active="true"]').getAttribute("aria-posinset"), "1", "Home to the first");

      const filter = panel.getByRole("textbox", { name: "Filter files" });
      await filter.fill("messreihe-12345");
      await eventually(() => count.innerText(), "1 of 20,000 files", "filter finds exactly one file", 15000);
      await shot(app, "commit-details-many-tree");
      await filter.press("Enter");
      await eventually(store.center, { kind: "file", path: many.info.sample, sha: many.info.root, mode: "view" }, "Enter in the filter opens the only match");
      await store.closeCenter();
    });

    assertNoConsoleErrors(app, "repository with 20,000 files");
    await app.close();
  }

  // =========================================================================
  // F. Signed commits (SSH signature): valid, unverifiable, invalid, none
  // =========================================================================
  {
    const signed = fixture(makeEmptyRepo({ name: "signiert" }));
    const keygen = path.resolve(signed.git("--exec-path"), "../../../usr/bin", process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen");
    const key = (name) => {
      const file = path.join(signed.root, name);
      execFileSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file], { stdio: "pipe", windowsHide: true });
      return `${file}.pub`;
    };
    let keys = null;
    try {
      keys = { trusted: key("schluessel-bekannt"), stranger: key("schluessel-fremd") };
    } catch (error) {
      console.log(`– signatures skipped: ssh-keygen could not be started (${keygen}): ${error?.message ?? error}`);
    }
    if (keys) {
      const allowed = path.join(signed.root, "allowed_signers");
      fs.writeFileSync(allowed, `${TEST_IDENTITY.email} ${fs.readFileSync(keys.trusted, "utf8").trim()}\n`);
      signed.git("config", "gpg.format", "ssh");
      signed.git("config", "gpg.ssh.allowedSignersFile", allowed);
      signed.git("config", "user.signingkey", keys.trusted);
      signed.git("add", "-A");
      signed.git("commit", "-q", "-S", "-m", "Mit bekanntem Schlüssel signiert");
      const good = signed.git("rev-parse", "HEAD");
      signed.git("-c", `user.signingkey=${keys.stranger}`, "commit", "-q", "-S", "--allow-empty", "-m", "Mit fremdem Schlüssel signiert");
      const stranger = signed.git("rev-parse", "HEAD");
      signed.git("commit", "-q", "--allow-empty", "-m", "Ohne Signatur");
      const plain = signed.git("rev-parse", "HEAD");
      // The signature stays, the content changes: the signature no longer matches.
      const raw = signed.git("cat-file", "commit", good).replace("Mit bekanntem Schlüssel signiert", "Nachträglich verfälscht");
      const forged = gitIn(signed.path, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: `${raw}\n` });
      const gitSays = (sha) => signed.git("log", "-1", "--format=%G?", sha);
      const expectedFor = (letter) => (letter === "G" ? "good" : letter === "B" || letter === "R" ? "bad" : letter === "N" ? "none" : "unknown");

      const app = await launch({ width: 1440, height: 900, theme: "dark" });
      const { page } = app;
      const { tabId } = await app.openRepo(signed.path);
      const store = storeApi(app, tabId);
      const panel = page.locator(PANEL);

      await section("Signature mark: valid, unverifiable, invalid, none – as git log %G?", async () => {
        const seen = {};
        for (const [name, sha] of Object.entries({ good, stranger, forged, plain })) {
          const letter = gitSays(sha);
          const expected = expectedFor(letter);
          await store.selectCommits([sha]);
          await waitSingle(page, sha);
          const mark = panel.locator("[data-signature]");
          const shown = (await mark.count()) > 0 ? await mark.getAttribute("data-signature") : "none";
          equal(shown, expected, `${name}: git reports “${letter}”`);
          seen[expected] = sha;
          if (expected !== "none") {
            const label = await mark.getAttribute("aria-label");
            check(/^Signature /.test(label ?? ""), `${name}: the mark has a name (${label})`);
            await mark.focus();
            const tip = page.getByRole("tooltip");
            await tip.waitFor();
            check((await tip.innerText()).includes(label), `${name}: tooltip explains the state`);
            await page.keyboard.press("Escape");
          }
        }
        check(Boolean(seen.good), "a commit with a valid signature was included");
        check(Boolean(seen.none), "a commit without a signature was included (shows nothing)");
        if (!seen.bad) console.log("  (note: Git did not report “B” for the forged commit – the “invalid” state is then not checked against Git)");
        if (!seen.unknown) console.log("  (note: Git did not report the unknown key as “unverifiable”)");
        if (seen.good) {
          await store.selectCommits([seen.good]);
          await waitSingle(page, seen.good);
          await shot(app, "commit-details-signed");
        }
      });

      assertNoConsoleErrors(app, "repository with signed commits");
      await app.close();
    }
  }
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  for (const app of apps) await app.close().catch(() => undefined);
  for (const cleanup of cleanups) cleanup();
}

if (failures.length > 0) {
  console.error(`\nS08: ${failures.length} failures`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nS08: all green");
