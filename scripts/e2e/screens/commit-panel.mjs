/**
 * commit-panel – commit panel "Local changes" in the real app, against real Git repositories.
 *
 *   node scripts/e2e/screens/commit-panel.mjs                 everything (checks and screenshots)
 *   node scripts/e2e/screens/commit-panel.mjs --only hook     only sections whose title contains "hook" (comma separates several)
 *   node scripts/e2e/screens/commit-panel.mjs --show          window visible
 *
 * Every check also looks at the repository itself (git log, git status, file contents), not just the UI.
 * The section "F03 keyboard only" never uses the mouse.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeConflictRepo, makeDetachedRepo, makeEmptyRepo, makeRichRepo } from "../fixtures.mjs";
import { createChecks, exists, lines, readFile, wipDriver, writeFile } from "./_wip.mjs";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots";
const checks = createChecks("commit-panel");
const { check, equal, eventually, section, finish } = checks;

const repos = [];
const keep = (repo) => (repos.push(repo), repo);
/**
 * Fixtures come from a cache shared by all test scripts. If another script is rebuilding it right
 * now, copying can fail once – then wait briefly and try again.
 */
const fixture = async (make, ...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return keep(make(...args));
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
};
const tempDirs = [];
let app = null;
let ui = null;

const start = async (options = {}) => {
  app = await launchApp({ show, ...options });
  ui = wipDriver(app, checks);
  return app;
};
const stop = async () => {
  if (!app) return;
  equal(app.consoleErrors, [], "console errors");
  await app.close();
  app = null;
  ui = null;
};
const onError = async (title) => {
  if (app) await app.screenshot(`target/e2e/commit-panel-failed-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
};
const run = (title, body) => section(title, body, onError);
const press = async (keys) => {
  await ui.page.keyboard.press(keys);
};
const dialogTitle = () => ui.page.locator('[role="dialog"] h2').first().textContent().catch(() => null);
const closeTab = async () => {
  await ui.closeToasts();
  await ui.page.evaluate(() => window.__gc.store.getState().closeOverlay());
};

try {
  await start();

  // -------------------------------------------------------------------------------------------
  await run("F03 keyboard only: stage, message, commit", async () => {
    const repo = await fixture(makeCleanRepoWithRemote);
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nStand: Auswertung für März begonnen.\n`);
    writeFile(repo, "notizen/plan.md", "# Plan\n\n- Station Hafen nachmessen\n");
    const before = repo.git("rev-parse", "HEAD");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "two changed files");
    equal(await ui.rows("unstaged"), ["README.md", "notizen/plan.md"], "list “Unstaged”");
    equal((await ui.commitButton.getAttribute("aria-disabled")) ?? null, "true", "Commit is disabled while nothing is staged");

    // Tab into the list, S stages the focused file, focus moves on.
    await ui.tabToList("Unstaged files");
    equal(await ui.focusedKey(), "README.md", "Tab lands on the first file");
    await press("s");
    await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "after the first S");
    equal(lines(repo.git("diff", "--cached", "--name-only")), ["README.md"], "git: README.md is staged");
    await eventually(ui.focusedKey, "notizen/plan.md", "focus moves to the next file");
    await press("s");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 2, conflicted: 0 }, "after the second S");
    equal(lines(repo.git("diff", "--cached", "--name-only")).sort(), ["README.md", "notizen/plan.md"], "git: both files staged");
    await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Commit 2 files", "label of the primary button");

    // Message: summary, Enter jumps to the description, Ctrl+Enter commits from inside the text field.
    await ui.tabToField("Summary");
    await ui.page.keyboard.type("Plan für die März-Auswertung notiert");
    await press("Enter");
    equal(await ui.focusedLabel(), "Description", "Enter jumps to the description");
    await ui.page.keyboard.type("Die Station Hafen wird nachgemessen.\nGrößen stehen in der README.");
    await press("Control+Enter");
    const toast = await ui.waitToast("success", /Commit created/);
    const head = repo.git("rev-parse", "HEAD");
    check(head !== before, "git: HEAD has moved");
    check(toast?.includes(head.slice(0, 7)), `the message names the new commit (${toast})`);
    equal(repo.git("log", "-1", "--format=%s"), "Plan für die März-Auswertung notiert", "git: summary");
    equal(repo.git("log", "-1", "--format=%b").trim(), "Die Station Hafen wird nachgemessen.\nGrößen stehen in der README.", "git: description");
    equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")).sort(), ["README.md", "notizen/plan.md"], "git: files in the commit");
    equal(repo.git("log", "-1", "--format=%an <%ae>"), "Lena Hartmann <lena.hartmann@wetterstation.example>", "git: author");
    equal(repo.git("status", "--porcelain"), "", "git: working directory clean");

    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 }, "lists empty");
    await eventually(() => ui.summary.inputValue(), "", "summary is empty after the commit");
    equal(await ui.description.inputValue(), "", "description is empty after the commit");
    equal(await app.invoke("draft_get", { repoId }), { summary: "", description: "", amend: false }, "draft in the core is empty");
    equal((await ui.view(tabId)).selection, { kind: "wip" }, "selection stays on the local changes");
    check((await ui.page.getByText("Nothing to commit").count()) === 1, "empty state “Nothing to commit”");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Stage and unstage: single, several, all; three clicks plus message", async () => {
    const repo = await fixture(makeCleanRepoWithRemote);
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}W;Wald;212\n`);
    writeFile(repo, "src/vergleich.py", `${readFile(repo, "src/vergleich.py")}\n\ndef mittel(a, b):\n    return (a + b) / 2\n`);
    writeFile(repo, "notizen/neu.txt", "neu\n");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 4, staged: 0, conflicted: 0 });
    const cached = () => lines(repo.git("diff", "--cached", "--name-only")).sort();

    // A click opens the diff in the center; the button in the row stages.
    await ui.row("unstaged", "README.md").click();
    await eventually(async () => (await ui.view(tabId)).center, { kind: "diff", path: "README.md", source: { kind: "unstaged" } }, "click opens the diff (unstaged)");
    await ui.row("unstaged", "README.md").hover();
    await ui.row("unstaged", "README.md").getByRole("button", { name: "Stage" }).click();
    await ui.waitCounts(repoId, { unstaged: 3, staged: 1, conflicted: 0 }, "the button in the row stages");
    equal(cached(), ["README.md"], "git: README.md staged");
    await eventually(async () => (await ui.view(tabId)).center, { kind: "diff", path: "notizen/neu.txt", source: { kind: "unstaged" } }, "the open diff moves on to the next file");

    // Staged file: Enter opens the diff (staged), U unstages.
    await ui.row("staged", "README.md").click();
    await eventually(async () => (await ui.view(tabId)).center, { kind: "diff", path: "README.md", source: { kind: "staged" } }, "click in “Staged” opens the staged diff");
    await press("u");
    await ui.waitCounts(repoId, { unstaged: 4, staged: 0, conflicted: 0 }, "U unstages");
    equal(cached(), [], "git: nothing staged any more");
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);

    // Multi-selection: click, Shift+click, then S for all selected.
    await ui.row("unstaged", "README.md").click();
    await ui.row("unstaged", "src/vergleich.py").click({ modifiers: ["Shift"] });
    equal(await ui.section("unstaged").locator('[aria-selected="true"]').count(), 3, "Shift+click selects the range");
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await press("s");
    await ui.waitCounts(repoId, { unstaged: 1, staged: 3, conflicted: 0 }, "S stages all selected files");
    equal(cached(), ["README.md", "notizen/neu.txt", "src/vergleich.py"], "git: three files staged");

    // Ctrl+click adds single files; context menu via Shift+F10
    await ui.row("staged", "README.md").click();
    await ui.row("staged", "src/vergleich.py").click({ modifiers: ["Control"] });
    equal(await ui.section("staged").locator('[aria-selected="true"]').count(), 2, "Ctrl+click selects a second file");
    await press("Shift+F10");
    const menu = ui.page.getByRole("menu");
    await menu.waitFor({ timeout: 5000 });
    check((await menu.getByRole("menuitem").count()) > 0, "Shift+F10 opens the context menu of the selected files");
    await press("Escape");
    await menu.waitFor({ state: "detached", timeout: 5000 });

    // Unstage all / stage all: shortcuts and buttons in the section header.
    await press("Control+Shift+U");
    await ui.waitCounts(repoId, { unstaged: 4, staged: 0, conflicted: 0 }, "Ctrl+Shift+U unstages everything");
    equal(cached(), [], "git: nothing staged");
    await press("Control+Shift+S");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 4, conflicted: 0 }, "Ctrl+Shift+S stages everything");
    equal(cached().length, 4, "git: four files staged");
    equal(lines(repo.git("stash", "list")), [], "Ctrl+Shift+S does not create a stash");
    await ui.page.getByRole("button", { name: "Unstage all" }).click();
    await ui.waitCounts(repoId, { unstaged: 4, staged: 0, conflicted: 0 }, "button “Unstage all”");
    check(await ui.page.getByRole("button", { name: "Unstage all" }).isDisabled(), "“Unstage all” is disabled when nothing is staged");

    // Core loop with the mouse: Stage all (1), click into the field (2), Commit (3) – plus message.
    await ui.page.getByRole("button", { name: "Stage all" }).click();
    await ui.waitCounts(repoId, { unstaged: 0, staged: 4, conflicted: 0 }, "button “Stage all”");
    await ui.summary.click();
    await ui.page.keyboard.type("Station Wald aufgenommen");
    await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Commit 4 files", "label names the count");
    await ui.commitButton.click();
    await ui.waitToast("success", /Commit created/);
    equal(repo.git("log", "-1", "--format=%s"), "Station Wald aufgenommen", "git: commit with three clicks");
    equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")).length, 4, "git: four files in the commit");
    await ui.closeToasts();

    // Ctrl+Shift+Enter: stage everything and commit, without staging first.
    writeFile(repo, "notizen/neu.txt", "neu\nzweite Zeile\n");
    writeFile(repo, "notizen/noch-eine.txt", "x\n");
    await ui.refresh();
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await ui.page.keyboard.down("Shift");
    await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Stage all and commit", "with Shift the button offers “Stage all and commit”");
    await ui.page.keyboard.up("Shift");
    await ui.summary.click();
    await ui.page.keyboard.type("Notizen ergänzt");
    await press("Control+Shift+Enter");
    await ui.waitToast("success", /Commit created/);
    equal(repo.git("log", "-1", "--format=%s"), "Notizen ergänzt", "git: Ctrl+Shift+Enter committed");
    equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")).sort(), ["notizen/neu.txt", "notizen/noch-eine.txt"], "git: both files in the commit");
    equal(repo.git("status", "--porcelain"), "", "git: clean");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Commit errors: empty message, nothing staged", async () => {
    const repo = await fixture(makeCleanRepoWithRemote);
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    const count = repo.git("rev-list", "--count", "HEAD");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });

    // Nothing staged: disabled, with a reason – the shortcut does nothing either.
    await ui.commitButton.focus();
    check(await ui.commitButton.evaluate((button) => button === document.activeElement), "the disabled button stays focusable");
    await ui.commitButton.hover();
    await ui.page.getByRole("tooltip").filter({ hasText: /Nothing staged/ }).first().waitFor({ timeout: 5000 });
    await ui.summary.fill("Sollte nicht entstehen");
    await press("Control+Enter");
    await ui.waitToast("info", /Nothing staged/);
    equal(repo.git("rev-list", "--count", "HEAD"), count, "git: no commit without staged files");
    await ui.closeToasts();

    // Empty message: error at the field, focus in the field, no commit.
    await ui.summary.fill("");
    await press("Control+Shift+S");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
    await ui.commitButton.click();
    await ui.page.getByRole("alert").filter({ hasText: /summary is missing/ }).waitFor({ timeout: 5000 });
    equal(await ui.summary.getAttribute("aria-invalid"), "true", "field is marked invalid");
    equal(await ui.focusedLabel(), "Summary", "focus is in the field");
    equal(repo.git("rev-list", "--count", "HEAD"), count, "git: no commit without a message");
    await ui.page.keyboard.type("Jetzt mit Message");
    equal(await ui.page.getByRole("alert").filter({ hasText: /summary is missing/ }).count(), 0, "the error disappears while typing");

    // Counter from 50 characters, warning colour from 72; a very long summary breaks nothing.
    const long = "Auswertung der Messreihe Nord ".repeat(7).trim().slice(0, 200);
    await ui.summary.fill(long.slice(0, 49));
    equal(await ui.page.locator("form span[aria-hidden]", { hasText: "/72" }).count(), 0, "no counter below 50 characters");
    await ui.summary.fill(long.slice(0, 60));
    equal(await ui.page.locator("form span[aria-hidden]", { hasText: "/72" }).textContent(), "60/72", "counter from 50 characters");
    await ui.summary.fill(long);
    const counter = ui.page.locator("form span[aria-hidden]", { hasText: "/72" });
    equal(await counter.textContent(), "200/72", "counter at 200 characters");
    check((await counter.evaluate((node) => node.parentElement.className)).includes("text-warning"), "counter in warning colour from 72");
    equal(await ui.overflow(), { page: 0, panel: 0 }, "200 characters do not break the layout");
    await ui.description.fill(Array.from({ length: 30 }, (_, index) => `Zeile ${index + 1} der Beschreibung`).join("\n"));
    const area = await ui.description.evaluate((node) => ({ height: node.offsetHeight, scroll: node.scrollHeight }));
    check(area.height <= 162 && area.scroll > area.height, `the description only grows up to the limit (${JSON.stringify(area)})`);
    await app.screenshot(`${SHOTS}/commit-panel-long.png`);
    await ui.commitButton.click();
    await ui.waitToast("success", /Commit created/);
    equal(repo.git("log", "-1", "--format=%s"), long, "git: long summary taken over unchanged");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Amend: load last message, hint for a pushed commit, amend", async () => {
    const repo = await fixture(makeCleanRepoWithRemote);
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    check((await ui.page.getByText("Nothing to commit").count()) === 1, "empty state – amend stays possible");
    const last = repo.git("log", "-1", "--format=%s");

    // Check it with the keyboard: the fields get the last message, the commit is pushed → hint.
    await ui.tabToCheckbox("Amend last commit");
    await press("Space");
    await eventually(() => ui.summary.inputValue(), last, "amend loads the summary of the last commit");
    await ui.page.getByText(/already been pushed/).waitFor({ timeout: 5000 });
    await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Amend commit", "button reads “Amend commit”");
    equal((await ui.commitButton.getAttribute("aria-disabled")) ?? null, null, "amend works without staged files too");
    // Uncheck again: the loaded text disappears because it was not changed.
    await press("Space");
    await eventually(() => ui.summary.inputValue(), "", "unchecking clears the unchanged fields again");

    // Local commit, then change its message and content.
    writeFile(repo, "notiz.md", "erste Fassung\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Notiz angeleg");
    writeFile(repo, "notiz.md", "erste Fassung\nNachtrag\n");
    await ui.refresh();
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    const count = repo.git("rev-list", "--count", "HEAD");
    const old = repo.git("rev-parse", "HEAD");
    await ui.checkbox("Amend last commit").click();
    await eventually(() => ui.summary.inputValue(), "Notiz angeleg", "amend loads the message of the local commit");
    equal(await ui.page.getByText(/already been pushed/).count(), 0, "no hint for a commit that only exists locally");
    await ui.summary.fill("Notiz angelegt");
    await press("Control+Shift+S");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
    await press("Control+Enter");
    await ui.waitToast("success", /Commit amended/);
    equal(repo.git("rev-list", "--count", "HEAD"), count, "git: no additional commit");
    check(repo.git("rev-parse", "HEAD") !== old, "git: the commit was replaced");
    equal(repo.git("log", "-1", "--format=%s"), "Notiz angelegt", "git: message changed");
    equal(repo.git("show", "HEAD:notiz.md"), "erste Fassung\nNachtrag", "git: the addition is in the amended commit");
    await eventually(() => ui.checkbox("Amend last commit").getAttribute("aria-checked"), "false", "amend is off again afterwards");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Hook fails: message with output, fields stay, skip hooks", async () => {
    const repo = await fixture(makeCleanRepoWithRemote);
    fs.mkdirSync(path.join(repo.path, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(repo.path, ".git", "hooks", "pre-commit"), '#!/bin/sh\necho "Lint: Zeile 3 ist zu lang (Hook der Fixture)" >&2\nexit 1\n', { mode: 0o755 });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    const count = repo.git("rev-list", "--count", "HEAD");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await press("Control+Shift+S");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
    await ui.summary.fill("Wird vom Hook abgelehnt");
    await ui.description.fill("Bleibt stehen.");
    await press("Control+Enter");
    const toast = await ui.waitToast("danger", /hook/);
    check(/pre-commit/.test(toast ?? ""), `the message names the hook (${toast})`);
    check(/Show output/.test(toast ?? ""), `the message offers “Show output” (${toast})`);
    await ui.page.waitForTimeout(700);
    equal(await ui.page.locator('[data-toast="danger"]').count(), 1, "exactly one error message about the hook");
    equal(repo.git("rev-list", "--count", "HEAD"), count, "git: no commit");
    equal(await ui.summary.inputValue(), "Wird vom Hook abgelehnt", "summary is kept");
    equal(await ui.description.inputValue(), "Bleibt stehen.", "description is kept");
    equal(lines(repo.git("diff", "--cached", "--name-only")), ["README.md"], "git: file stays staged");
    await ui.page.locator('[data-toast="danger"]').getByRole("button", { name: "Show output" }).first().click();
    const output = ui.page.locator('[role="dialog"] pre');
    await output.waitFor({ timeout: 5000 });
    check((await output.textContent())?.includes("Lint: Zeile 3 ist zu lang"), "the dialog shows the hook output");
    await ui.page.locator('[role="dialog"]').getByRole("button", { name: "Close" }).last().click();
    await ui.closeToasts();

    await ui.checkbox("Skip Git hooks").click();
    await ui.commitButton.click();
    await ui.waitToast("success", /Commit created/);
    equal(repo.git("log", "-1", "--format=%s"), "Wird vom Hook abgelehnt", "git: with “Skip Git hooks” the commit is created");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Push after commit: pushed, and rejected with a hint", async () => {
    const repo = await fixture(makeCleanRepoWithRemote);
    writeFile(repo, "notiz.md", "eins\n");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    equal(await ui.checkbox("Push after commit").getAttribute("aria-checked"), "false", "default from the settings: off");
    await ui.checkbox("Push after commit").click();
    await ui.summary.fill("Notiz eins");
    await press("Control+Shift+Enter");
    await ui.waitToast("success", /pushed/);
    equal(lines(repo.git("ls-remote", "origin", "refs/heads/main"))[0]?.split(/\s+/)[0], repo.git("rev-parse", "HEAD"), "git: the remote has the new commit");
    await ui.closeToasts();

    // The remote is ahead: the commit is created, the push is rejected.
    repo.commitOnRemote({ message: "Kollegin war schneller" });
    writeFile(repo, "notiz.md", "eins\nzwei\n");
    await ui.refresh();
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await ui.summary.fill("Notiz zwei");
    await press("Control+Shift+Enter");
    const toast = await ui.waitToast("warning", /not pushed/);
    check(/Retry push/.test(toast ?? ""), "the message offers “Retry push”");
    equal(repo.git("log", "-1", "--format=%s"), "Notiz zwei", "git: the commit exists anyway");
    check(lines(repo.git("ls-remote", "origin", "refs/heads/main"))[0]?.split(/\s+/)[0] !== repo.git("rev-parse", "HEAD"), "git: the remote does not have it");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Conflict: banner, take ours/theirs, finish merge", async () => {
    const repo = await fixture(makeConflictRepo);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 2 });
    const banner = ui.panel.getByRole("alert");
    await banner.getByText("Merge of feature/einheiten into main").waitFor({ timeout: 5000 });
    check(/0 of 2 conflicts resolved/.test((await banner.textContent()) ?? ""), "banner counts “0 of 2 conflicts resolved”");
    equal(await ui.rows("conflicts"), ["docs/aufbau.md", "src/auswertung.py"], "section “Conflicts”");
    check(/both modified/.test((await ui.row("conflicts", "docs/aufbau.md").textContent()) ?? ""), "the kind of conflict is shown as text in the row");
    equal((await ui.commitButton.textContent())?.trim(), "Finish merge", "primary button reads “Finish merge”");
    equal(await ui.commitButton.getAttribute("aria-disabled"), "true", "finishing is disabled while conflicts are open");
    await app.screenshot(`${SHOTS}/commit-panel-conflict.png`);
    await ui.commitButton.hover();
    await ui.page.getByRole("tooltip").filter({ hasText: /open conflicts first/ }).first().waitFor({ timeout: 5000 });
    equal(await ui.summary.inputValue(), "Merge branch 'feature/einheiten'", "the prepared merge message is in the field");
    await ui.page.mouse.move(700, 600);

    // A click opens the conflict tool.
    await ui.row("conflicts", "docs/aufbau.md").click();
    await eventually(async () => (await ui.view(tabId)).center, { kind: "conflict", path: "docs/aufbau.md" }, "click opens the conflict tool");
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);

    // Keyboard: context menu with Shift+F10, "Take current (main)".
    await ui.row("conflicts", "docs/aufbau.md").focus();
    await press("Shift+F10");
    const menu = ui.page.getByRole("menu");
    await menu.waitFor({ timeout: 5000 });
    equal(await menu.getByRole("menuitem").allInnerTexts(), ["Open in conflict tool", "Open in external merge tool", "Take current (main)", "Take incoming (feature/einheiten)"], "menu spells out both branches");
    await ui.menuChoose("Take current (main)");
    // The main version is the HEAD version: the file is resolved but does not show up as a change.
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 1 }, "one file resolved");
    equal(lines(repo.git("diff", "--name-only", "--diff-filter=U")), ["src/auswertung.py"], "git: only one file left in conflict");
    const aufbau = readFile(repo, "docs/aufbau.md");
    check(aufbau.includes("| Temperatur | 2,5 m | 10 Minuten |") && !aufbau.includes("<<<<<<<"), "file: main version, without conflict markers");
    await eventually(async () => /1 of 2 conflicts resolved/.test((await banner.textContent()) ?? ""), true, "banner counts “1 of 2 conflicts resolved”");

    // Mouse: "Resolve" button in the row, "Take incoming (feature/einheiten)".
    await ui.row("conflicts", "src/auswertung.py").getByRole("button", { name: /resolve conflict/ }).click();
    await ui.page.getByRole("menuitem", { name: "Take incoming (feature/einheiten)" }).click();
    await ui.waitCounts(repoId, { unstaged: 0, staged: 2, conflicted: 0 }, "all conflicts resolved");
    equal(lines(repo.git("diff", "--name-only", "--diff-filter=U")), [], "git: no conflict open any more");
    check(readFile(repo, "src/auswertung.py").includes("Temperatur im Mittel"), "file: version from feature/einheiten");
    await ui.panel.getByText("All 2 conflicts resolved.").waitFor({ timeout: 5000 });
    equal((await ui.commitButton.getAttribute("aria-disabled")) ?? null, null, "finishing is possible now");
    equal(await ui.section("conflicts").count(), 0, "the section “Conflicts” is gone");

    // Finish with a custom message from the form.
    await ui.summary.fill("Einheiten zusammengeführt");
    await ui.description.fill("Messintervall bleibt bei 10 Minuten.");
    await press("Control+Enter");
    await ui.waitToast("success", /complete/);
    equal(repo.git("log", "-1", "--format=%s"), "Einheiten zusammengeführt", "git: merge commit with the message from the form");
    equal(repo.git("log", "-1", "--format=%b").trim(), "Messintervall bleibt bei 10 Minuten.", "git: description of the merge commit");
    equal(repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "git: two parents");
    check(!exists(repo, ".git/MERGE_HEAD"), "git: no merge open any more");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 }, "everything is clean after the merge");
    // After finishing, the shell shows the new merge commit; back at the local changes the form is empty.
    equal(await app.invoke("draft_get", { repoId }), { summary: "", description: "", amend: false }, "the draft is empty after the merge");
    await ui.page.evaluate((id) => window.__gc.store.getState().selectWip(id), tabId);
    await eventually(() => ui.summary.inputValue(), "", "form is empty after the merge");
    equal(await ui.panel.getByRole("alert").count(), 0, "no banner any more");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Conflict: abort merge with confirmation", async () => {
    const repo = await fixture(makeConflictRepo, { name: "konflikt-abbruch" });
    // The fixture is a copy: the stat data in the index does not match the copied files, and
    // `git merge --abort` then fails with "Entry not uptodate". The core does not refresh the index
    // itself (reported as a core issue); here a `git status` does it, as any terminal would on the side.
    repo.git("status");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 2 });
    check(exists(repo, ".git/MERGE_HEAD"), "git: merge is open");
    const trash = ui.page.getByRole("button", { name: /can.t discard/ });
    equal(await trash.getAttribute("aria-disabled"), "true", "“Discard all changes” is disabled during the merge and says why");

    await ui.panel.getByRole("button", { name: "Abort merge" }).click();
    equal(await dialogTitle(), "Abort merge?", "confirmation");
    equal(await ui.focusedLabel(), "Cancel", "focus is on “Cancel”");
    await press("Enter");
    await ui.page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 5000 });
    check(exists(repo, ".git/MERGE_HEAD"), "git: Enter in the confirmation aborts nothing");

    await ui.panel.getByRole("button", { name: "Abort merge" }).click();
    await ui.page.locator('[role="dialog"]').getByRole("button", { name: "Abort merge" }).click();
    await ui.waitToast("success", /Aborted the merge/);
    check(!exists(repo, ".git/MERGE_HEAD"), "git: merge is aborted");
    equal(repo.git("status", "--porcelain"), "", "git: working directory as before the merge");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    equal(await ui.panel.getByRole("alert").count(), 0, "the banner is gone");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Detached HEAD: banner and “Create branch here”", async () => {
    const repo = await fixture(makeDetachedRepo);
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nIm Detached HEAD geändert.\n`);
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await ui.panel.getByText("No branch checked out (detached HEAD)").waitFor({ timeout: 5000 });
    check(await ui.checkbox("Push after commit").isDisabled(), "push after commit is disabled without a branch");
    await app.screenshot(`${SHOTS}/commit-panel-detached.png`);
    await ui.panel.getByRole("button", { name: "Create branch here" }).click();
    await ui.page.locator('[role="dialog"] input').waitFor({ timeout: 5000 });
    await ui.page.keyboard.type("rettung/alter stand");
    await press("Enter");
    await eventually(() => repo.git("rev-parse", "--abbrev-ref", "HEAD"), "rettung/alter-stand", "git: the new branch is checked out");
    await eventually(() => ui.panel.getByText("No branch checked out (detached HEAD)").count(), 0, "the banner disappears");
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "the change is still there");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Empty repository: first commit", async () => {
    const repo = await fixture(makeEmptyRepo);
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    check(await ui.checkbox("Amend last commit").isDisabled(), "amend is disabled without a commit");
    await ui.page.getByText("There is no commit yet that could be amended.").waitFor({ timeout: 5000 });
    await ui.summary.fill("Erster Commit");
    await press("Control+Shift+Enter");
    await ui.waitToast("success", /Commit created/);
    equal(repo.git("rev-list", "--count", "HEAD"), "1", "git: exactly one commit");
    equal(repo.git("log", "-1", "--format=%s"), "Erster Commit", "git: message");
    equal(lines(repo.git("ls-tree", "--name-only", "HEAD")), ["LIESMICH.txt"], "git: file in the first commit");
    await eventually(() => ui.checkbox("Amend last commit").isDisabled(), false, "amend is possible now");
    await closeTab();

    const bare = await fixture(makeEmptyRepo, { name: "ganz-leer", withFile: false });
    await app.openRepo(bare.path);
    await ui.page.getByText("No files yet").waitFor({ timeout: 5000 });
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Discard with confirmation, then undo via the toolbar", async () => {
    const repo = await fixture(makeCleanRepoWithRemote);
    const original = readFile(repo, "README.md");
    writeFile(repo, "README.md", `${original}\nDas geht gleich verloren.\n`);
    writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}X;Test;1\n`);
    writeFile(repo, "notizen/weg.txt", "nicht verfolgt\n");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 });

    // One file: select, Del, confirmation – cancel first, then discard.
    await ui.row("unstaged", "stationen.csv").click();
    await press("Delete");
    equal(await dialogTitle(), "Discard changes to “stationen.csv”?", "confirmation names the file");
    equal(await ui.focusedLabel(), "Cancel", "focus is on “Cancel”");
    await press("Enter");
    await ui.page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 5000 });
    check(readFile(repo, "stationen.csv").includes("X;Test;1"), "file: Cancel keeps the change");
    await ui.row("unstaged", "stationen.csv").focus();
    await press("Delete");
    await ui.page.locator('[role="dialog"]').getByRole("button", { name: "Discard", exact: true }).click();
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "one file discarded");
    check(!readFile(repo, "stationen.csv").includes("X;Test;1"), "file: the change to stationen.csv is gone");

    // Everything: trash can in the header.
    await ui.page.getByRole("button", { name: "Discard all changes …" }).click();
    equal(await dialogTitle(), "Discard all changes?", "confirmation for everything");
    const body = (await ui.page.locator('[role="dialog"]').textContent()) ?? "";
    check(/new files are deleted/.test(body) && /Undo/.test(body),`the confirmation says what is lost and that Undo brings it back (${body})`);
    equal(await ui.focusedLabel(), "Cancel", "focus is on “Cancel”");
    await ui.page.locator('[role="dialog"]').getByRole("button", { name: "Discard all" }).click();
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 }, "everything discarded");
    equal(readFile(repo, "README.md"), original, "file: README.md as in the last commit");
    check(!exists(repo, "notizen/weg.txt"), "file: the untracked file is deleted");
    equal(repo.git("status", "--porcelain"), "", "git: clean");

    // Undo via the toolbar brings everything back.
    const undo = ui.page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Undo/ });
    await eventually(async () => (await undo.getAttribute("aria-disabled")) ?? "false", "false", "Undo is available in the toolbar");
    await undo.click();
    await ui.waitToast("success", /Undone/);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "the discarded changes are back");
    check(readFile(repo, "README.md").includes("Das geht gleich verloren."), "file: README.md has the change again");
    check(exists(repo, "notizen/weg.txt"), "file: the untracked file is back");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Tree view, adjustable height, long names, narrow window", async () => {
    const repo = await fixture(makeRichRepo);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 12, staged: 5, conflicted: 0 });
    equal(await ui.overflow(), { page: 0, panel: 0 }, "no overflow");
    const long = ui.row("unstaged", repo.info.longFile);
    check(await long.locator("span.truncate").evaluate((node) => node.scrollWidth > node.clientWidth), "the 61-character file name is truncated");
    equal(await long.getAttribute("title"), repo.info.longFile, "the full path is in the tooltip");
    check(/untracked/.test((await ui.row("unstaged", "notizen/offene-fragen.md").textContent()) ?? ""), "the status is shown as text in the row (not just colour)");

    // Arrow keys, Home/End, Space, Ctrl+A
    await ui.row("unstaged", repo.info.changes.unstaged[0]).click();
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await press("ArrowDown");
    equal(await ui.focusedKey(), repo.info.changes.unstaged[1], "arrow down moves focus and selection");
    equal((await ui.view(tabId)).center.kind, "graph", "arrow keys open no diff while none is open");
    await press("End");
    equal(await ui.focusedKey(), repo.info.changes.unstaged.at(-1), "End jumps to the last file");
    await press("Shift+Home");
    equal(await ui.section("unstaged").locator('[aria-selected="true"]').count(), 12, "Shift+Home selects up to the start");
    await press("Control+a");
    equal(await ui.section("unstaged").locator('[aria-selected="true"]').count(), 12, "Ctrl+A selects all");
    equal(await ui.section("unstaged").locator('[tabindex="0"][data-row-key]').count(), 1, "exactly one row is reachable with Tab");
    await press("Enter");
    await eventually(async () => (await ui.view(tabId)).center.kind, "diff", "Enter opens the diff");
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);

    // Tree
    await ui.page.getByRole("button", { name: "Show as folder tree" }).click();
    await ui.section("unstaged").getByRole("tree").waitFor({ timeout: 5000 });
    const folders = await ui.section("unstaged").locator('[role="treeitem"][aria-expanded]').evaluateAll((list) => list.map((item) => item.textContent.replace(/\d+$/, "").trim()));
    equal(folders, ["daten", "docs", "notizen", "src"], "folders as rows");
    await app.screenshot(`${SHOTS}/commit-panel-tree.png`);
    const notizen = ui.section("unstaged").locator('[data-row-key="dir:notizen"]');
    await notizen.focus();
    await press("ArrowLeft");
    equal(await notizen.getAttribute("aria-expanded"), "false", "arrow left collapses the folder");
    await press("ArrowRight");
    equal(await notizen.getAttribute("aria-expanded"), "true", "arrow right expands it");
    await press("s");
    await ui.waitCounts(repoId, { unstaged: 10, staged: 7, conflicted: 0 }, "S on the folder stages all files below it");
    equal(
      lines(repo.git("-c", "core.quotepath=false", "diff", "--cached", "--name-only")).filter((file) => file.startsWith("notizen/")),
      ["notizen/offene-fragen.md", "notizen/Übersicht März.txt"],
      "git: both files from notizen/ staged (including the one with umlaut and space)",
    );
    await ui.page.getByRole("button", { name: "Show as flat list" }).click();
    await ui.section("unstaged").getByRole("listbox").waitFor({ timeout: 5000 });

    // Narrow window: both lists no longer fit → grip in between, each section scrolls.
    await app.setSize(960, 600);
    await eventually(ui.overflow, { page: 0, panel: 0 }, "no overflow at 960×600");
    const grip = ui.page.getByRole("separator", { name: /Height of the/ });
    await grip.waitFor({ timeout: 5000 });
    const heights = () => ui.page.evaluate(() => ["unstaged", "staged"].map((name) => Math.round(document.querySelector(`[data-section="${name}"]`).getBoundingClientRect().height)));
    const [first, second] = await heights();
    check(first >= 56 && second >= 56, `both sections stay visible (${first}, ${second})`);
    check(await ui.section("unstaged").locator("[data-section-content]").evaluate((node) => node.parentElement.scrollHeight > node.parentElement.clientHeight), "“Unstaged” scrolls on its own");
    await grip.focus();
    const value = Number(await grip.getAttribute("aria-valuenow"));
    await press("ArrowUp");
    await press("ArrowUp");
    await eventually(async () => Number(await grip.getAttribute("aria-valuenow")), value - 10, "arrow up reduces the share by 5 percent each");
    const [smaller] = await heights();
    check(smaller < first, `the upper list gets shorter (${first} → ${smaller})`);
    await press("End");
    const [largest] = await heights();
    check(largest > first, `End gives the upper list the largest share (${largest})`);
    await grip.dblclick();
    await eventually(async () => Number(await grip.getAttribute("aria-valuenow")), 50, "double-click restores the middle");
    const form = await ui.page.locator('form[aria-label="Commit"]').boundingBox();
    check(form && form.y + form.height <= 600 - 24 + 1, "the form stays fully visible");
    await app.setSize(1440, 900);
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Very many files: 2000 untracked, smooth, “Stage all” does not block", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "viele-dateien" });
    for (let index = 1; index <= 2000; index++) writeFile(repo, `massen/reihe-${String(index).padStart(4, "0")}.csv`, `datum;wert\n2026-03-01;${index}\n`);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2000, staged: 0, conflicted: 0 }, "2000 files in the status");
    const rendered = await ui.section("unstaged").locator("[data-row-key]").count();
    check(rendered > 5 && rendered < 120, `the list is virtualized (${rendered} rows in the DOM)`);
    equal(await ui.section("unstaged").locator("[data-file-list]").getAttribute("data-virtual"), "true", "virtualization marker");
    equal(await ui.overflow(), { page: 0, panel: 0 }, "no overflow");

    // Keyboard across the list: End, PgUp, Home – focus stays in the list.
    await ui.row("unstaged", "massen/reihe-0001.csv").click();
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await press("End");
    await eventually(ui.focusedKey, "massen/reihe-2000.csv", "End jumps to the last of 2000 files");
    check(await ui.row("unstaged", "massen/reihe-2000.csv").isVisible(), "the last row is visible");
    await press("PageUp");
    check((await ui.focusedKey()) !== "massen/reihe-2000.csv", "PgUp moves the focus");
    await press("Home");
    await eventually(ui.focusedKey, "massen/reihe-0001.csv", "Home jumps back");
    await app.screenshot(`${SHOTS}/commit-panel-many.png`);

    // "Stage all": while the core works, frames keep running.
    await ui.page.evaluate(() => {
      const probe = { last: performance.now(), worst: 0, frames: 0, running: true };
      const tick = (now) => {
        probe.worst = Math.max(probe.worst, now - probe.last);
        probe.last = now;
        probe.frames++;
        if (probe.running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__gcProbe = probe;
    });
    const started = Date.now();
    await press("Control+Shift+S");
    // While the core works, the button shows that something is running.
    await eventually(() => ui.page.getByRole("button", { name: "Stage all" }).getAttribute("aria-busy"), "true", "“Stage all” shows the running operation");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 2000, conflicted: 0 }, "all 2000 staged", 120000);
    const took = Date.now() - started;
    const probe = await ui.page.evaluate(() => {
      window.__gcProbe.running = false;
      return { worst: Math.round(window.__gcProbe.worst), frames: window.__gcProbe.frames };
    });
    console.log(`  “Stage all” for 2000 files: ${took} ms, longest frame ${probe.worst} ms, ${probe.frames} frames`);
    check(probe.worst < 400, `the UI stays responsive (longest frame ${probe.worst} ms)`);
    equal(lines(repo.git("diff", "--cached", "--name-only")).length, 2000, "git: 2000 files staged");
    const stagedRendered = await ui.section("staged").locator("[data-row-key]").count();
    check(stagedRendered < 120, `“Staged” is virtualized too (${stagedRendered} rows in the DOM)`);
    await ui.summary.fill("Messreihen als Einzeldateien abgelegt");
    await press("Control+Enter");
    await ui.waitToast("success", /Commit created/, 60000);
    equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")).length, 2000, "git: 2000 files in the commit");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Commit template as starting value", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "mit-vorlage" });
    writeFile(repo, ".gitmessage", "# Zeilen mit # sind Hinweise und kommen nicht in die Message\nThema: \n\nWarum:\n");
    repo.git("config", "commit.template", ".gitmessage");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await eventually(() => ui.summary.inputValue(), "Thema:", "the template fills the summary");
    equal(await ui.description.inputValue(), "Warum:", "the template fills the description");
    equal(await app.invoke("draft_get", { repoId }), { summary: "", description: "", amend: false }, "the template alone is not a saved draft yet");
    await ui.summary.fill("Thema: Vorlage eingecheckt");
    await press("Control+Shift+Enter");
    await ui.waitToast("success", /Commit created/);
    equal(repo.git("log", "-1", "--format=%B").trim(), "Thema: Vorlage eingecheckt\n\nWarum:", "git: message from template and input");
    await eventually(() => ui.summary.inputValue(), "Thema:", "after the commit the template is back");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Error reading the state: message and “Try again”", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "kaputter-index" });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    const index = path.join(repo.path, ".git", "index");
    const saved = fs.readFileSync(index);
    fs.writeFileSync(index, "kein gültiger Index");
    try {
      // Reset the query so the error state shows without old data (as when opening such a repository).
      await ui.page.evaluate((id) => {
        void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "status"] });
      }, repoId);
      await ui.panel.getByText("Could not read the repository state").waitFor({ timeout: 15000 });
      check(/index file smaller than expected/.test((await ui.panel.getByRole("alert").textContent()) ?? ""), "the message shows the Git output");
      check((await ui.panel.getByRole("button", { name: "Try again" }).count()) === 1, "button “Try again”");
      equal(await ui.commitButton.getAttribute("aria-disabled"), "true", "Commit is disabled while the state is unknown");
      await app.screenshot(`${SHOTS}/commit-panel-error.png`);
      // While the index is broken, "Try again" asks again – and shows the error again.
      const requests = () => ui.page.evaluate((id) => window.__gc.queryClient.getQueryState(["repo", id, "status"])?.errorUpdateCount ?? 0, repoId);
      const before = await requests();
      await ui.panel.getByRole("button", { name: "Try again" }).click();
      await eventually(async () => (await requests()) > before, true, "“Try again” asks the core again");
      await ui.panel.getByText("Could not read the repository state").waitFor({ timeout: 10000 });
      // Repair the index and "Try again": the view comes back. (The file watcher can be faster
      // than the click – then the button is already gone, and that is correct.)
      fs.writeFileSync(index, saved);
      await ui.panel.getByRole("button", { name: "Try again" }).click({ timeout: 2000 }).catch(() => undefined);
    } finally {
      fs.writeFileSync(index, saved);
    }
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "after the repair the state is back");
    equal(await ui.rows("unstaged"), ["README.md"], "the list is filled again");
    await ui.closeToasts();
    // Messages from other areas about the broken index (graph, status bar) are not part of this check.
    app.consoleErrors.length = 0;
    await closeTab();
  });

  await stop();

  // -------------------------------------------------------------------------------------------
  await run("No author set: banner, commit disabled, way to the profile", async () => {
    await start({ gitIdentity: null });
    const repo = await fixture(makeCleanRepoWithRemote, { name: "ohne-autor" });
    repo.git("config", "--unset", "user.name");
    repo.git("config", "--unset", "user.email");
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    const count = repo.git("rev-list", "--count", "HEAD");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await ui.panel.getByText("No author set").first().waitFor({ timeout: 5000 });
    await press("Control+Shift+S");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "staging works without an author too");
    equal(await ui.commitButton.getAttribute("aria-disabled"), "true", "Commit is disabled");
    await ui.summary.fill("Ohne Autor");
    await press("Control+Enter");
    await ui.waitToast("info", /No author set/);
    equal(repo.git("rev-list", "--count", "HEAD"), count, "git: no commit without an author");
    await app.screenshot(`${SHOTS}/commit-panel-identity.png`);
    await ui.closeToasts();
    await ui.panel.getByRole("button", { name: "Open profile" }).click();
    await eventually(() => ui.page.evaluate(() => window.__gc.store.getState().overlay), { kind: "preferences", section: "profiles" }, "“Open profile” opens the preferences in the Profiles section");
    await ui.page.evaluate(() => window.__gc.store.getState().closeOverlay());
    await stop();
  });

  // -------------------------------------------------------------------------------------------
  await run("Draft survives tab switch and restart", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-e2e-s07-data-"));
    tempDirs.push(dataDir);
    const repo = await fixture(makeCleanRepoWithRemote, { name: "entwurf" });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nNeu.\n`);
    await start({ dataDir });
    let { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await ui.summary.click();
    await ui.page.keyboard.type("Halbfertige Message");
    await ui.description.click();
    await ui.page.keyboard.type("Wird morgen fertig.\nZweite Zeile.");
    await eventually(() => app.invoke("draft_get", { repoId }), { summary: "Halbfertige Message", description: "Wird morgen fertig.\nZweite Zeile.", amend: false }, "the draft is saved in the core while typing");

    // Tab switch: open the management, back to the repository.
    await press("Control+t");
    await eventually(() => ui.page.locator('[data-screen="commit-panel"]').count(), 0, "other tab: the panel is gone");
    await press("Control+1");
    await ui.page.locator('[data-screen="commit-panel"]').waitFor({ timeout: 5000 });
    equal(await ui.summary.inputValue(), "Halbfertige Message", "after the tab switch the summary is still there");
    equal(await ui.description.inputValue(), "Wird morgen fertig.\nZweite Zeile.", "after the tab switch the description is still there");
    await stop();

    // Restart with the same data directory.
    await start({ dataDir });
    ({ repoId } = await app.openRepo(repo.path));
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await eventually(() => ui.summary.inputValue(), "Halbfertige Message", "after the restart the summary is still there");
    equal(await ui.description.inputValue(), "Wird morgen fertig.\nZweite Zeile.", "after the restart the description is still there");
    await press("Control+Shift+S");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 });
    await press("Control+Enter");
    await ui.waitToast("success", /Commit created/);
    equal(repo.git("log", "-1", "--format=%s"), "Halbfertige Message", "git: the draft became the commit");
    equal(await app.invoke("draft_get", { repoId }), { summary: "", description: "", amend: false }, "afterwards the draft is empty");
    await stop();
  });

  // -------------------------------------------------------------------------------------------
  await run("Screenshots: dark, light, 960×600, empty", async () => {
    await start({ theme: "dark" });
    const repo = await fixture(makeRichRepo);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 12, staged: 5, conflicted: 0 });
    await ui.row("unstaged", "src/auswertung.py").click();
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await ui.summary.fill("Stationsaufbau umbenannt, Export ergänzt");
    await ui.description.fill("Die Testläufe sind entfernt; der Export schreibt jetzt UTF-8.");
    await ui.row("unstaged", "src/auswertung.py").hover();
    await ui.page.evaluate(() => document.activeElement?.blur());
    await app.settle();
    await app.screenshot(`${SHOTS}/commit-panel.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/commit-panel-light.png`);
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await eventually(ui.overflow, { page: 0, panel: 0 }, "no overflow at 960×600");
    await app.screenshot(`${SHOTS}/commit-panel-min.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/commit-panel-min-light.png`);
    await app.setTheme("dark");
    await app.setSize(1440, 900);
    await ui.checkbox("Amend last commit").click();
    await ui.page.getByText(/Amend commit/).first().waitFor();
    await app.settle();
    await app.screenshot(`${SHOTS}/commit-panel-amend.png`);
    await ui.checkbox("Amend last commit").click();
    await ui.summary.fill("");
    await ui.description.fill("");
    await closeTab();

    const clean = await fixture(makeRichRepo, { dirty: false, name: "wetterstation-sauber" });
    const opened = await app.openRepo(clean.path);
    await ui.waitCounts(opened.repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await ui.page.getByText("Nothing to commit").waitFor({ timeout: 5000 });
    await app.screenshot(`${SHOTS}/commit-panel-empty.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/commit-panel-empty-light.png`);
    await stop();
  });
} catch (error) {
  checks.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  await app?.close().catch(() => undefined);
  for (const repo of repos) repo.cleanup();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(finish());
