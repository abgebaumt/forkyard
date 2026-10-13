/**
 * Flow F19 – discarding changes: single files (context menu, Del), everything (trash button), hunks and
 * lines – each with confirmation and undo. The cases not yet covered by a script under
 * scripts/e2e/screens.
 *
 *   node scripts/e2e/flows/B-F19.mjs                 everything
 *   node scripts/e2e/flows/B-F19.mjs --only E10,N6   only sections whose title contains "E10" or "N6"
 *   node scripts/e2e/flows/B-F19.mjs --show          visible window
 *
 * Already covered: Del with confirmation (cancel with Enter), trash button for everything including an
 * untracked file, undo via the toolbar (commit-panel.mjs); discard via the file menu with undo
 * (interaction.mjs); discard hunk and line with undo (diff.mjs); trash button disabled during a merge
 * (commit-panel.mjs).
 *
 * Checks run against the repository itself: file content byte for byte, git status, index.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../fixtures.mjs";
import { axeViolations, createFlow, dialogOf, dialogTitle, diffDriver, diffReady, exists, focusVisible, lines, noDialog, readFile, sleep, tidy, toastsOf, writeFile } from "./B-lib.mjs";

const flow = createFlow("B-F19");
const { check, equal, eventually, until, section } = flow;
const press = (keys) => flow.page.keyboard.press(keys);
const gitRaw = (repo, ...args) =>
  execFileSync("git", args, { cwd: repo.path, env: { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")) }, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const hex = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")).toString("hex");
const headBlob = (repo, file) => gitRaw(repo, "cat-file", "blob", `HEAD:${file}`);
const worktree = (repo, file) => fs.readFileSync(path.join(repo.path, file));
const writeBytes = (repo, file, content) => {
  const target = path.join(repo.path, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const status = (repo) => lines(repo.git("-c", "core.quotepath=false", "status", "--porcelain")).sort();
const toolbar = (name) => flow.page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: new RegExp(`^${name}`) }).first();
const closeCenter = (tabId) => flow.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
/** Undo via the toolbar as soon as it is available. */
const undo = async () => {
  const button = toolbar("Undo");
  await eventually(async () => (await button.getAttribute("aria-disabled")) ?? "false", "false", "Undo is available in the toolbar");
  await flow.app.settle();
  await button.click();
};
const README_EXTRA = "\nDas geht gleich verloren.\n";

// ---------------------------------------------------------------------------------------------
await section("F19-H1 Right-click the file → “Discard changes …” → confirm (mouse), then undo", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h1-maus" });
  const original = readFile(repo, "README.md");
  writeFile(repo, "README.md", `${original}${README_EXTRA}`);
  writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}X;Test;1\n`);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "README.md").click();
  await diffReady(app, "README.md");
  await ui.row("unstaged", "README.md").click({ button: "right" }); // click 1
  await page.getByRole("menuitem", { name: /^Discard changes/ }).click(); // click 2
  equal(await dialogTitle(page), "Discard changes to “README.md”?", "the confirmation names the file");
  const text = (await dialogOf(page).innerText()).replace(/\s+/g, " ");
  check(/Staged changes stay/.test(text) && /Undo/.test(text), `the confirmation says what happens and that undo helps (${text})`);
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click(); // confirm
  await ui.waitToast("success", /Changes to “README\.md” discarded/);
  equal(readFile(repo, "README.md"), original, "file: README.md as in the last commit");
  check(readFile(repo, "stationen.csv").includes("X;Test;1"), "file: the other change is untouched");
  equal(status(repo), [" M stationen.csv"], "git status: only the other file left");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  // What the open diff shows afterwards is checked by section F19-E16 (BUG B-01).
  await undo();
  await ui.waitToast("success", /Undone/);
  equal(readFile(repo, "README.md"), `${original}${README_EXTRA}`, "undo brings the change back");
  await closeCenter(tabId);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-H3 Keyboard only: select file, Del, tab to “Discard”, Enter; then Ctrl+Z", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h3-tastatur" });
  const original = readFile(repo, "README.md");
  writeFile(repo, "README.md", `${original}${README_EXTRA}`);
  writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}X;Test;1\n`);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  // No mouse from here on.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await ui.tabToList("Unstaged files");
  equal(await ui.focusedKey(), "README.md", "Tab lands on the first file");
  await press("Delete");
  equal(await dialogTitle(page), "Discard changes to “README.md”?", "Del opens the confirmation");
  equal(await ui.focusedLabel(), "Cancel", "focus is on “Cancel”");
  await press("Tab");
  equal(await ui.focusedLabel(), "Discard", "Tab moves to “Discard”");
  check((await focusVisible(page)).ok, "focus on “Discard” is visible");
  await press("Enter");
  await ui.waitToast("success", /discarded/);
  equal(readFile(repo, "README.md"), original, "file: README.md as in the last commit");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await eventually(ui.focusedKey, "stationen.csv", "focus is then on the next file in the list");
  await press("Control+z");
  await ui.waitToast("success", /Undone/);
  equal(readFile(repo, "README.md"), `${original}${README_EXTRA}`, "Ctrl+Z brings the change back");
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E1 Discard a single untracked file: confirmation says “will be deleted”, undo brings it back byte for byte", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e1-neu" });
  const bytes = Buffer.from(Array.from({ length: 700 }, (_, index) => (index * 53 + 7) % 256));
  writeBytes(repo, "neu/messung.bin", bytes);
  writeFile(repo, "neu/notiz.txt", "nicht verfolgt\r\nzweite Zeile ohne Ende");
  writeFile(repo, "bleibt.txt", "bleibt\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "neu/notiz.txt").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "neu/notiz.txt").focus();
  await press("Delete");
  equal(await dialogTitle(page), "Discard changes to “neu/notiz.txt”?", "confirmation");
  check(/The file is new and will be deleted\./.test(await dialogOf(page).innerText()), "the confirmation says: the file is new and will be deleted");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "one file fewer");
  check(!exists(repo, "neu/notiz.txt"), "file: the untracked file is deleted");
  check(exists(repo, "neu/messung.bin") && exists(repo, "bleibt.txt"), "file: the other untracked files are still there");
  await ui.closeToasts();
  // Two at once: binary file and text file.
  await ui.row("unstaged", "bleibt.txt").click();
  await ui.row("unstaged", "neu/messung.bin").click({ modifiers: ["Control"] });
  await closeCenter(tabId);
  await ui.row("unstaged", "neu/messung.bin").focus();
  await press("Delete");
  equal(await dialogTitle(page), "Discard changes to 2 files?", "confirmation for two files");
  check(/The files are new and will be deleted\./.test(await dialogOf(page).innerText()), "the confirmation says: the files are new and will be deleted");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  check(!exists(repo, "neu/messung.bin") && !exists(repo, "bleibt.txt"), "file: both are deleted");
  equal(status(repo), [], "git status: clean");
  await ui.closeToasts();
  await undo();
  await ui.waitToast("success", /Undone/);
  await until(() => exists(repo, "neu/messung.bin") && exists(repo, "bleibt.txt"), "undo brings both files back");
  equal(hex(worktree(repo, "neu/messung.bin")), hex(bytes), "file: the binary file is back byte for byte");
  equal(readFile(repo, "bleibt.txt"), "bleibt\n", "file: the text file is back");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E18 Discard lines keyboard-only (F7, Space, Del, Tab, Enter), then Ctrl+Z", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e2-zeile" });
  writeBytes(repo, "liste.txt", "eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\nelf\nzwölf\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Liste angelegt");
  const changed = "eins\nZWEI\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\nELF\nzwölf\n";
  writeBytes(repo, "liste.txt", changed);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await ui.tabToList("Unstaged files");
  await press("Enter");
  await diffReady(app, "liste.txt");
  const d = diffDriver(app);
  await press("F7");
  await press("Space");
  await press("Shift+ArrowDown");
  equal(await d.selected(), ["-zwei", "+ZWEI"], "the first line pair is selected");
  await press("Delete");
  equal(await dialogTitle(page), "Discard 2 lines in “liste.txt”?", "Del opens the confirmation for the selected lines");
  equal(await ui.focusedLabel(), "Cancel", "focus is on “Cancel”");
  await press("Tab");
  await press("Enter");
  await until(() => worktree(repo, "liste.txt").toString("utf8") === changed.replace("ZWEI", "zwei"), "file: only “ZWEI” is reset, “ELF” stays");
  await until(async () => (await toastsOf(page, "success")).some((text) => text.includes("2 lines discarded")), "toast “2 lines discarded”");
  equal(repo.git("diff", "--cached", "--name-only"), "", "git: the index is untouched");
  await press("Control+z");
  await until(() => worktree(repo, "liste.txt").toString("utf8") === changed, "Ctrl+Z brings the discarded lines back");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E3 Cancel halfway: Esc, “Cancel” and a click beside the confirmation – nothing is discarded, focus returns", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e3-abbruch" });
  const changed = `${readFile(repo, "README.md")}${README_EXTRA}`;
  writeFile(repo, "README.md", changed);
  writeFile(repo, "neu.txt", "neu\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "README.md").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "README.md").focus();
  await press("Delete");
  await dialogOf(page).waitFor({ timeout: 5000 });
  await press("Escape");
  await noDialog(page);
  equal(readFile(repo, "README.md"), changed, "Esc: the file is unchanged");
  await eventually(ui.focusedKey, "README.md", "Esc: focus returns to the file");
  // Trash button, then “Cancel”.
  await page.getByRole("button", { name: "Discard all changes …" }).click();
  equal(await dialogTitle(page), "Discard all changes?", "confirmation for everything");
  await dialogOf(page).getByRole("button", { name: "Cancel" }).click();
  await noDialog(page);
  equal(status(repo), [" M README.md", "?? neu.txt"], "“Cancel”: git status unchanged");
  await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Discard all changes …", "“Cancel”: focus returns to the trash button");
  // Click beside the dialog: closes at most – never discards.
  await page.getByRole("button", { name: "Discard all changes …" }).click();
  await dialogOf(page).waitFor({ timeout: 5000 });
  await page.mouse.click(8, 300);
  await sleep(500);
  equal(status(repo), [" M README.md", "?? neu.txt"], "click beside: git status unchanged");
  if (await dialogOf(page).count()) await press("Escape");
  await noDialog(page);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "the lists are unchanged");
  equal(await toastsOf(page), [], "no toast after cancelling");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E4 Double click and double Enter on “Discard”: discarded once, nothing else triggered", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e4-doppelt" });
  const original = readFile(repo, "README.md");
  writeFile(repo, "README.md", `${original}${README_EXTRA}`);
  writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}X;Test;1\n`);
  writeFile(repo, "src/vergleich.py", `${readFile(repo, "src/vergleich.py")}\n# Notiz\n`);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "README.md").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "README.md").focus();
  await press("Delete");
  await dialogOf(page).waitFor({ timeout: 5000 });
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).dblclick();
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 }, "after the double click exactly one file is discarded");
  await sleep(1000);
  equal(status(repo), [" M src/vergleich.py", " M stationen.csv"], "git status: the two other files are untouched");
  equal(await dialogOf(page).count(), 0, "no second dialog is open");
  equal(await toastsOf(page, "danger"), [], "no error message");
  await ui.closeToasts();
  // Keyboard: Del, Tab, Enter, Enter.
  await ui.row("unstaged", "src/vergleich.py").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "src/vergleich.py").focus();
  await press("Delete");
  await dialogOf(page).waitFor({ timeout: 5000 });
  await press("Tab");
  await press("Enter");
  await press("Enter");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "after the double Enter exactly one more file is discarded");
  await sleep(1000);
  equal(status(repo), [" M stationen.csv"], "git status: the last file is untouched");
  equal(await dialogOf(page).count(), 0, "the second Enter opens no new confirmation");
  equal(await toastsOf(page, "danger"), [], "no error message");
  await closeCenter(tabId);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E5 Names with emoji, umlauts, spaces and 150 characters: confirmation stays inside the window, files back byte for byte", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e5-namen" });
  const special = "notizen/Übersicht 🌦 März.txt";
  const long = `lang/${"messreihe-station-nord-".repeat(6)}ende.csv`;
  writeBytes(repo, special, "Größe: 12 °C 🌡\r\nzweite Zeile\r\n");
  writeBytes(repo, long, "datum;wert\n2026-04-01;1\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Dateien mit besonderen Namen");
  writeBytes(repo, special, "Größe: 14 °C 🌡\r\nzweite Zeile\r\ndritte\r\n");
  writeBytes(repo, long, "datum;wert\n2026-04-01;2\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  await ui.row("unstaged", long).click();
  await closeCenter(tabId);
  await ui.row("unstaged", long).focus();
  await press("Delete");
  await dialogOf(page).waitFor({ timeout: 5000 });
  const title = (await dialogTitle(page)) ?? "";
  check(title.length < 90 && title.includes("…"), `the long path is shortened in the title (${title})`);
  // Whether the confirmation shows the file name despite shortening is checked by section F19-E17 (BUG B-07).
  const box = await dialogOf(page).boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 1440 && box.y >= 0 && box.y + box.height <= 900, `the confirmation lies fully inside the window (${JSON.stringify(box)})`);
  equal(await dialogOf(page).evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth), 0, "the confirmation does not overflow");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  equal(hex(worktree(repo, long)), hex(headBlob(repo, long)), "file with long path: byte for byte as in the last commit");
  await ui.closeToasts();
  await ui.row("unstaged", special).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Discard changes/ }).click();
  equal(await dialogTitle(page), `Discard changes to “${special}”?`, "the confirmation names the file with emoji, umlaut and spaces");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  equal(hex(worktree(repo, special)), hex(headBlob(repo, special)), "file with emoji in the name: back byte for byte, CRLF kept");
  equal(status(repo), [], "git status: clean");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E6 Several selected files: the confirmation lists them, one undo brings all back", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e6-mehrere" });
  const before = { readme: readFile(repo, "README.md"), stations: readFile(repo, "stationen.csv"), compare: readFile(repo, "src/vergleich.py") };
  writeFile(repo, "README.md", `${before.readme}${README_EXTRA}`);
  writeFile(repo, "stationen.csv", `${before.stations}X;Test;1\n`);
  writeFile(repo, "src/vergleich.py", `${before.compare}\n# Notiz\n`);
  writeFile(repo, "zz-bleibt.txt", "bleibt\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 4, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "README.md").click();
  await ui.row("unstaged", "stationen.csv").click({ modifiers: ["Shift"] });
  await closeCenter(tabId);
  equal(await ui.section("unstaged").locator('[aria-selected="true"]').count(), 3, "three files selected");
  await ui.row("unstaged", "stationen.csv").focus();
  await press("Delete");
  equal(await dialogTitle(page), "Discard changes to 3 files?", "the confirmation names the number");
  const listed = await dialogOf(page).getByRole("listitem").allInnerTexts();
  equal(listed.sort(), ["README.md", "src/vergleich.py", "stationen.csv"], "the confirmation lists exactly the selected files");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitToast("success", /Changes to 3 files discarded/);
  equal(status(repo), ["?? zz-bleibt.txt"], "git status: only the unselected file is left");
  equal([readFile(repo, "README.md"), readFile(repo, "stationen.csv"), readFile(repo, "src/vergleich.py")], [before.readme, before.stations, before.compare], "files: all three as in the last commit");
  await ui.closeToasts();
  await undo();
  await ui.waitToast("success", /Undone/);
  equal(status(repo), [" M README.md", " M src/vergleich.py", " M stationen.csv", "?? zz-bleibt.txt"], "git status: one undo brings all three back");
  check(readFile(repo, "stationen.csv").endsWith("X;Test;1\n"), "file: the content is back");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E7 File with staged and unstaged part: only the unstaged part goes, staged changes stay", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e7-teils" });
  writeBytes(repo, "liste.txt", "eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Liste angelegt");
  const stagedContent = "eins\nZWEI\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\n";
  writeBytes(repo, "liste.txt", stagedContent);
  repo.git("add", "liste.txt");
  writeBytes(repo, "liste.txt", stagedContent.replace("neun", "NEUN"));
  const cachedBefore = repo.git("diff", "--cached");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 });
  await ui.row("unstaged", "liste.txt").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "liste.txt").focus();
  await press("Delete");
  check(/Staged changes stay/.test(await dialogOf(page).innerText()), "the confirmation says: staged changes stay");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "only the staged part left");
  equal(worktree(repo, "liste.txt").toString("utf8"), stagedContent, "file: equal to the staged state (ZWEI stays, NEUN is gone)");
  equal(repo.git("diff", "--cached"), cachedBefore, "git diff --cached: the index is unchanged");
  equal(status(repo), ["M  liste.txt"], "git status: only staged");
  await ui.closeToasts();
  await undo();
  await ui.waitToast("success", /Undone/);
  equal(worktree(repo, "liste.txt").toString("utf8"), stagedContent.replace("neun", "NEUN"), "undo brings the unstaged part back");
  equal(repo.git("diff", "--cached"), cachedBefore, "git diff --cached: still unchanged");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E8 Discarding a deleted file restores it (CRLF and binary byte for byte)", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e8-geloescht" });
  const bytes = Buffer.from(Array.from({ length: 1500 }, (_, index) => (index * 29 + 3) % 256));
  writeBytes(repo, "daten/logger.bin", bytes);
  writeBytes(repo, "crlf.txt", "eins\r\nzwei\r\ndrei");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Binär- und CRLF-Datei");
  fs.rmSync(path.join(repo.path, "daten"), { recursive: true });
  writeBytes(repo, "crlf.txt", "eins\nzwei\nDREI\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  check(/deleted/.test((await ui.row("unstaged", "daten/logger.bin").textContent()) ?? ""), "the row says “deleted”");
  await ui.row("unstaged", "crlf.txt").click();
  await ui.row("unstaged", "daten/logger.bin").click({ modifiers: ["Control"] });
  await closeCenter(tabId);
  await ui.row("unstaged", "daten/logger.bin").focus();
  await press("Delete");
  equal(await dialogTitle(page), "Discard changes to 2 files?", "confirmation");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  check(exists(repo, "daten/logger.bin"), "file: the deleted file is back (including its folder)");
  equal(hex(worktree(repo, "daten/logger.bin")), hex(bytes), "binary file restored byte for byte");
  equal(hex(worktree(repo, "crlf.txt")), hex("eins\r\nzwei\r\ndrei"), "CRLF file byte for byte as in the commit (CRLF, no final newline)");
  equal(status(repo), [], "git status: clean");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E9 File changes from outside while the confirmation is open: undo brings back the last existing content", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e9-aussen" });
  const original = readFile(repo, "README.md");
  writeFile(repo, "README.md", `${original}\nFassung 1\n`);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "README.md").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "README.md").focus();
  await press("Delete");
  await dialogOf(page).waitFor({ timeout: 5000 });
  writeFile(repo, "README.md", `${original}\nFassung 2 – im Editor weitergeschrieben\n`);
  await sleep(300);
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await until(() => readFile(repo, "README.md") === original, "file: as in the last commit");
  await ui.closeToasts();
  await undo();
  await ui.waitToast("success", /Undone/);
  equal(readFile(repo, "README.md"), `${original}\nFassung 2 – im Editor weitergeschrieben\n`, "undo brings back version 2 – the content that was really discarded");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E10 Discard everything with staged and unstaged changes; undo restores files AND index", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e10-alles" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\ngestaged\n`);
  writeFile(repo, "neu-gestaged.txt", "neu und gestaged\n");
  repo.git("add", "README.md", "neu-gestaged.txt");
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}und danach weiter geändert\n`);
  writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}X;Test;1\n`);
  writeFile(repo, "neu-offen.txt", "nicht verfolgt\n");
  fs.rmSync(path.join(repo.path, "src", "vergleich.py"));
  const before = status(repo);
  const cachedBefore = repo.git("diff", "--cached");
  const readmeBefore = readFile(repo, "README.md");
  equal(before, [" D src/vergleich.py", " M stationen.csv", "A  neu-gestaged.txt", "MM README.md", "?? neu-offen.txt"].sort(), "initial state");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 4, staged: 2, conflicted: 0 });
  await page.getByRole("button", { name: "Discard all changes …" }).click();
  equal(await dialogTitle(page), "Discard all changes?", "confirmation");
  const listed = await dialogOf(page).getByRole("listitem").allInnerTexts();
  check(listed.length >= 5 || listed.some((item) => /more/.test(item)), `the confirmation lists the affected files (${JSON.stringify(listed)})`);
  await dialogOf(page).getByRole("button", { name: "Discard all" }).click();
  await ui.waitToast("success", /All changes discarded/);
  equal(status(repo), [], "git status: clean");
  check(!exists(repo, "neu-gestaged.txt") && !exists(repo, "neu-offen.txt") && exists(repo, "src/vergleich.py"), "files: new ones deleted, deleted ones back");
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  await ui.closeToasts();
  await undo();
  await ui.waitToast("success", /Undone/);
  equal(readFile(repo, "README.md"), readmeBefore, "file: README.md back with both changes");
  check(exists(repo, "neu-gestaged.txt") && exists(repo, "neu-offen.txt") && !exists(repo, "src/vergleich.py"), "files: new ones back, deleted ones deleted again");
  equal(status(repo), before, "git status: as before discarding – staged changes are staged again");
  equal(repo.git("diff", "--cached"), cachedBefore, "git diff --cached: the index is as before");
  await ui.waitCounts(repoId, { unstaged: 4, staged: 2, conflicted: 0 }, "the lists show the old state");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E11 Two windows: discarding in A – B shows the new state and a reloaded diff", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e11-zwei" });
  const original = readFile(repo, "README.md");
  writeFile(repo, "README.md", `${original}${README_EXTRA}`);
  writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}X;Test;1\n`);
  const a = await app.openRepo(repo.path);
  await ui.waitCounts(a.repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  const other = await flow.second();
  try {
    const b = await other.app.openRepo(repo.path);
    await other.ui.waitCounts(b.repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await other.ui.row("unstaged", "README.md").click();
    await diffReady(other.app, "README.md");
    await ui.row("unstaged", "README.md").click();
    await closeCenter(a.tabId);
    await ui.row("unstaged", "README.md").focus();
    await press("Delete");
    await dialogOf(flow.page).getByRole("button", { name: "Discard", exact: true }).click();
    await ui.waitCounts(a.repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await other.ui.waitCounts(b.repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "B: the discarded file has disappeared from the list", 20_000);
    equal(await other.ui.rows("unstaged"), ["stationen.csv"], "B: only the other file left");
    const centerText = (await other.app.page.locator('[data-screen="diff"]').innerText({ timeout: 3000 }).catch(() => "")).replace(/\s+/g, " ");
    check(!centerText.includes("Das geht gleich verloren"), `B: the open diff no longer shows the discarded line (${centerText.slice(0, 200)})`);
    equal(await toastsOf(other.app.page, "danger"), [], "B: no error message");
    equal(other.app.consoleErrors, [], "B: console errors");
  } finally {
    await other.app.close();
  }
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section(
  "F19-E12 Restart the app after discarding: undo still brings the change back afterwards",
  async () => {
    const dataDir = flow.tempDir("gc-e2e-b-f19-data-");
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e12-neustart" });
    const original = readFile(repo, "README.md");
    writeFile(repo, "README.md", `${original}${README_EXTRA}`);
    writeFile(repo, "neu.txt", "nicht verfolgt\n");
    await flow.start({ dataDir });
    let { app, ui } = flow;
    let { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await flow.page.getByRole("button", { name: "Discard all changes …" }).click();
    await dialogOf(flow.page).getByRole("button", { name: "Discard all" }).click();
    await ui.waitToast("success", /All changes discarded/);
    equal(status(repo), [], "git status: clean");
    equal(app.consoleErrors, [], "console errors before the restart");
    await flow.stop();

    await flow.start({ dataDir });
    ({ app, ui } = flow);
    ({ repoId } = await app.openRepo(repo.path));
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    const button = toolbar("Undo");
    await eventually(async () => (await button.getAttribute("aria-disabled")) ?? "false", "false", "after the restart undo is still available", 15_000);
    await button.hover();
    await flow.page.getByRole("tooltip").filter({ hasText: /discarding/ }).first().waitFor({ timeout: 5000 }).catch(() => check(false, "the tooltip names what will be undone (discarding …)"));
    await app.settle();
    await button.click();
    await ui.waitToast("success", /Undone/);
    equal(readFile(repo, "README.md"), `${original}${README_EXTRA}`, "file: the change is back");
    equal(status(repo), [" M README.md", "?? neu.txt"], "git status: as before discarding");
    await tidy(flow);
  },
  { launch: false },
);
await flow.stop();

// ---------------------------------------------------------------------------------------------
await section("F19-E13 Minimum window 960×600: confirmation with 14 files fits the window, the list scrolls, buttons reachable", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e13-klein" });
  for (let index = 1; index <= 14; index++) writeFile(repo, `daten/station-nord-messreihe-${String(index).padStart(2, "0")}-bereinigt.csv`, `datum;wert\n2026-04-01;${index}\n`);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 14, staged: 0, conflicted: 0 });
  await app.setSize(960, 600);
  await ui.row("unstaged", "daten/station-nord-messreihe-01-bereinigt.csv").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "daten/station-nord-messreihe-01-bereinigt.csv").focus();
  await press("Control+a");
  await press("Delete");
  equal(await dialogTitle(page), "Discard changes to 14 files?", "confirmation for 14 files");
  const box = await dialogOf(page).boundingBox();
  check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960.5 && box.y + box.height <= 600.5, `the confirmation lies fully inside the window (${JSON.stringify(box)})`);
  for (const name of ["Cancel", "Discard"]) {
    const button = await dialogOf(page).getByRole("button", { name, exact: true }).boundingBox();
    check(button && button.y + button.height <= 600.5 && button.x + button.width <= 960.5, `“${name}” is visible (${JSON.stringify(button)})`);
  }
  equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no horizontal overflow");
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
  equal(status(repo), [], "git status: clean");
  await app.setSize(1440, 900);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-E14 Screen reader: confirmation as a dialog with title and description, focus stays in the dialog and returns", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e14-a11y" });
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}${README_EXTRA}`);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const trash = page.getByRole("button", { name: "Discard all changes …" });
  equal(await trash.count(), 1, "the trash button has a name that says what it does");
  await trash.focus();
  await press("Enter");
  const dialog = dialogOf(page);
  await dialog.waitFor({ timeout: 5000 });
  check(["dialog", "alertdialog"].includes(await dialog.getAttribute("role")), "the confirmation is a dialog");
  const labelled = await dialog.evaluate((element) => ({
    title: document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent ?? null,
    description: document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? null,
  }));
  equal(labelled.title, "Discard all changes?", "aria-labelledby points to the title");
  check(/Everything uncommitted is lost/.test(labelled.description ?? ""), `aria-describedby points to the explanation (${labelled.description})`);
  equal(await ui.focusedLabel(), "Cancel", "focus is on the safe choice “Cancel”");
  check((await focusVisible(page)).ok, "focus is visible");
  // Focus stays in the dialog.
  for (let step = 0; step < 5; step++) {
    await press("Tab");
    check(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]'))), `Tab ${step + 1}: focus stays in the confirmation`);
  }
  // The background is hidden from screen readers.
  check(await page.evaluate(() => Boolean(document.querySelector('[data-screen="commit-panel"]')?.closest('[aria-hidden="true"], [inert]'))), "the background is hidden during the confirmation (aria-hidden or inert)");
  equal(await axeViolations(page, '[role="dialog"], [role="alertdialog"]'), [], "axe: no violations in the confirmation");
  await press("Escape");
  await noDialog(page);
  await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Discard all changes …", "after Esc focus is back on the trash button");
  // Dangerous button: recognisable by its text, not only by colour.
  await press("Enter");
  await dialog.waitFor({ timeout: 5000 });
  const buttons = await dialog.getByRole("button").evaluateAll((list) => list.map((button) => button.getAttribute("aria-label") ?? button.textContent.trim()));
  check(buttons.every(Boolean) && buttons.includes("Cancel") && buttons.includes("Discard all"), `every button of the confirmation says in words what it does (${JSON.stringify(buttons)})`);
  await press("Escape");
  await noDialog(page);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-N2 Read-only file: discarding file and hunk works or fails understandably – never halfway", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n2-schreibschutz" });
  const lineList = Array.from({ length: 40 }, (_, index) => `Zeile ${index + 1}`);
  writeBytes(repo, "lang.txt", `${lineList.join("\n")}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Lange Datei");
  const original = readFile(repo, "README.md");
  const changedReadme = `${original}${README_EXTRA}`;
  const changedLong = `${lineList.map((line, index) => (index === 2 ? "OBEN GEÄNDERT" : index === 36 ? "UNTEN GEÄNDERT" : line)).join("\n")}\n`;
  writeFile(repo, "README.md", changedReadme);
  writeBytes(repo, "lang.txt", changedLong);
  const files = ["README.md", "lang.txt"].map((file) => path.join(repo.path, file));
  for (const file of files) fs.chmodSync(file, 0o444);
  try {
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    // Whole file.
    await ui.row("unstaged", "README.md").click();
    await closeCenter(tabId);
    await ui.row("unstaged", "README.md").focus();
    await press("Delete");
    await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
    await until(async () => readFile(repo, "README.md") === original || (await toastsOf(page, "danger")).length > 0, "discarding the read-only file ends: discarded or with an error message", 20_000);
    const afterFile = readFile(repo, "README.md");
    const fileErrors = await toastsOf(page, "danger");
    console.log(`  whole file: ${afterFile === original ? "discarded" : `refused – ${fileErrors.join(" | ").replace(/\s+/g, " ").slice(0, 200)}`}`);
    check(afterFile === original || afterFile === changedReadme, "file: either fully discarded or fully unchanged");
    if (afterFile !== original) check(fileErrors.some((text) => /read-only|permission|access|locked|cannot write/i.test(text)), `the error message explains the write protection (${JSON.stringify(fileErrors)})`);
    else equal(fileErrors, [], "no error if discarding worked");
    await ui.closeToasts();
    // One hunk.
    const d = diffDriver(app);
    await d.open("unstaged", "lang.txt");
    equal(await d.hunkCount(), 2, "two hunks");
    await d.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Discard hunk" }).click();
    await dialogOf(page).getByRole("button", { name: "Discard hunk" }).click();
    const oneReverted = changedLong.replace("OBEN GEÄNDERT", "Zeile 3");
    await until(async () => worktree(repo, "lang.txt").toString("utf8") === oneReverted || (await toastsOf(page, "danger")).length > 0, "discarding a hunk in the read-only file ends: discarded or with an error message", 20_000);
    const afterHunk = worktree(repo, "lang.txt").toString("utf8");
    const hunkErrors = await toastsOf(page, "danger");
    console.log(`  hunk: ${afterHunk === oneReverted ? "discarded" : `refused – ${hunkErrors.join(" | ").replace(/\s+/g, " ").slice(0, 200)}`}`);
    const intact = afterHunk === oneReverted || afterHunk === changedLong;
    check(intact, `file: either exactly the one hunk reset or fully unchanged – never half written (length ${afterHunk.length}, expected ${changedLong.length} or ${oneReverted.length})`);
    if (afterHunk !== oneReverted) check(hunkErrors.some((text) => /read-only|permission|access|locked|cannot write/i.test(text)), `the error message explains the write protection (${JSON.stringify(hunkErrors)})`);
    await closeCenter(tabId);
  } finally {
    for (const file of files) if (fs.existsSync(file)) fs.chmodSync(file, 0o666);
  }
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-N4 Repository locked (.git/index.lock): discarding fails understandably, nothing is discarded", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n4-sperre" });
  const changed = `${readFile(repo, "README.md")}${README_EXTRA}`;
  writeFile(repo, "README.md", changed);
  writeFile(repo, "neu.txt", "nicht verfolgt\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  const lock = path.join(repo.path, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  try {
    await page.getByRole("button", { name: "Discard all changes …" }).click();
    await dialogOf(page).getByRole("button", { name: "Discard all" }).click();
    const toast = await ui.waitToast("danger", /Discard failed/, 30_000);
    check(/index\.lock|locked|another program/i.test(toast ?? ""), `discard all: the toast explains the lock (${toast})`);
    equal(readFile(repo, "README.md"), changed, "file: README.md is unchanged");
    check(exists(repo, "neu.txt"), "file: the untracked file is still there");
    await ui.closeToasts();
    // A single file.
    await ui.row("unstaged", "README.md").click();
    await closeCenter(tabId);
    await ui.row("unstaged", "README.md").focus();
    await press("Delete");
    await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
    await until(async () => (await toastsOf(page, "danger")).length > 0 || readFile(repo, "README.md") !== changed, "single file: toast or result", 30_000);
    const single = await toastsOf(page, "danger");
    if (readFile(repo, "README.md") === changed) check(single.some((text) => /index\.lock|locked|another program/i.test(text)), `single file: the toast explains the lock (${JSON.stringify(single)})`);
    await ui.closeToasts();
  } finally {
    fs.rmSync(lock, { force: true });
  }
  // No undo entry for something that did not happen.
  await ui.refresh();
  if (readFile(repo, "README.md") === changed) {
    const label = await toolbar("Undo").evaluate((button) => `${button.getAttribute("aria-disabled") ?? "false"}|${document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? ""}`);
    check(!/discarding/.test(label), `undo offers no “discarding …” when nothing was discarded (${label})`);
  }
  // Without the lock it works.
  await page.getByRole("button", { name: "Discard all changes …" }).click();
  await dialogOf(page).getByRole("button", { name: "Discard all" }).click();
  await ui.waitToast("success", /All changes discarded/);
  equal(status(repo), [], "git status: without the lock everything is discarded");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F19-N5 File disappears from outside while the confirmation is open: no raw error, state is right", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n5-weg" });
  writeFile(repo, "kurzlebig.txt", "gleich weg\n");
  writeFile(repo, "README.md", `${readFile(repo, "README.md")}${README_EXTRA}`);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  await ui.row("unstaged", "kurzlebig.txt").click();
  await closeCenter(tabId);
  await ui.row("unstaged", "kurzlebig.txt").focus();
  await press("Delete");
  await dialogOf(page).waitFor({ timeout: 5000 });
  fs.rmSync(path.join(repo.path, "kurzlebig.txt"));
  await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
  await noDialog(page);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "the list shows only the other file", 20_000);
  const errors = await toastsOf(page, "danger");
  check(errors.every((text) => !/undefined|null|\[object|panicked|os error|No such file/i.test(text)), `no raw error message (${JSON.stringify(errors)})`);
  equal(status(repo), [" M README.md"], "git status: the other change is untouched");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
// BUG B-06: After discarding, the user keeps working on the same file. “Undo” then replaces the new work
// without warning with the old, discarded state and only reports “Undone”. The new work then lives only in
// “Redo” – the next action that replaces the undo entry makes it unreachable.
await section(
  "F19-N6 Undo after discarding when the file has been changed again since: the new work is not silently replaced",
  async () => {
    const { app, ui, page } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n6-undo" });
    const original = readFile(repo, "README.md");
    writeFile(repo, "README.md", `${original}\nAlte Änderung (wird verworfen)\n`);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await ui.row("unstaged", "README.md").click();
    await closeCenter(tabId);
    await ui.row("unstaged", "README.md").focus();
    await press("Delete");
    await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await ui.closeToasts();
    // The user keeps working: a new, different change to the same file.
    const fresh = `${original}\nNeue Arbeit nach dem Verwerfen\n`;
    writeFile(repo, "README.md", fresh);
    await ui.refresh();
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    const button = toolbar("Undo");
    const available = ((await button.getAttribute("aria-disabled")) ?? "false") === "false";
    let asked = false;
    if (available) {
      await app.settle();
      await button.click();
      await until(async () => (await toastsOf(page)).length > 0 || (await dialogOf(page).count()) > 0, "undo responds (toast or confirmation)", 20_000);
      if (await dialogOf(page).count()) {
        asked = true;
        console.log(`  confirmation: ${(await dialogOf(page).innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
        await press("Escape");
        await noDialog(page);
      }
    }
    await app.settle();
    const texts = (await toastsOf(page)).join(" | ").replace(/\s+/g, " ");
    console.log(`  undo ${available ? "was available" : "was disabled"}; toasts: ${texts || "(none)"}`);
    const now = readFile(repo, "README.md");
    // Expected: the new work stays (undo refuses or asks) – or the toast says explicitly that newer
    // changes were replaced and how to get them back.
    const warned = /newer|in the meantime|replaced|overwr|Redo/i.test(texts);
    const failed = !check(now.includes("Neue Arbeit nach dem Verwerfen") || warned || asked, `the new work stays or the user is warned (file ends with ${JSON.stringify(now.slice(-60))}; toasts: ${texts})`);
    await flow.bugShot("B-06", failed);
    // Record the way out: does “Redo” bring the new work back?
    if (!now.includes("Neue Arbeit nach dem Verwerfen")) {
      await ui.closeToasts();
      const redo = toolbar("Redo");
      if (((await redo.getAttribute("aria-disabled")) ?? "false") === "false") {
        await app.settle();
        await redo.click();
        await sleep(1500);
        await app.settle();
      }
      const afterRedo = readFile(repo, "README.md");
      console.log(`  after “Redo”: ${afterRedo === fresh ? "the new work is back" : `NOT back – file ends with ${JSON.stringify(afterRedo.slice(-60))}`}`);
      check(afterRedo === fresh, `“Redo” brings the new work back (file ends with ${JSON.stringify(afterRedo.slice(-60))})`);
      // And if the user does not notice the swap and keeps working? Undo once more (new work replaced),
      // then a commit – afterwards the toolbar shows whether the new work is still reachable via “Redo”.
      if (afterRedo === fresh) {
        await ui.closeToasts();
        await app.settle();
        await button.click();
        await until(() => readFile(repo, "README.md") !== fresh, "second undo replaces the new work again", 15_000);
        await ui.closeToasts();
        await ui.summary.fill("Commit nach dem unbemerkten Tausch");
        await ui.summary.focus();
        await press("Control+Shift+Enter");
        await ui.waitToast("success", /Commit created/);
        await app.settle();
        const redoState = await redo.evaluate((element) => `${element.getAttribute("aria-disabled") ?? "false"}|${document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? ""}`);
        const undoState = await button.evaluate((element) => `${element.getAttribute("aria-disabled") ?? "false"}|${document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? ""}`);
        console.log(`  after another commit: redo = ${redoState}; undo = ${undoState}; new work in the file: ${readFile(repo, "README.md").includes("Neue Arbeit")}`);
      }
    }
    await tidy(flow);
  },
  { bug: "B-06" },
);

// ---------------------------------------------------------------------------------------------
// BUG B-01 (second path): If a file is discarded via the context menu while its diff is open, the diff of the
// now unchanged file stays (“M modified … No content changes”). Via Del the diff instead moves on to the
// next file.
await section(
  "F19-E16 Open diff after discarding via the context menu: the center moves on to the next file or closes",
  async () => {
    const { app, ui, page } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e16-diff" });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}${README_EXTRA}`);
    writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}X;Test;1\n`);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    // Comparison: via Del the diff follows.
    await ui.row("unstaged", "stationen.csv").click();
    await diffReady(app, "stationen.csv");
    await ui.row("unstaged", "stationen.csv").focus();
    await press("Delete");
    await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await eventually(async () => (await ui.view(tabId)).center, { kind: "diff", path: "README.md", source: { kind: "unstaged" } }, "via Del: the open diff moves on to the next file");
    await ui.closeToasts();
    // Via the context menu.
    await ui.row("unstaged", "README.md").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Discard changes/ }).click();
    await dialogOf(page).getByRole("button", { name: "Discard", exact: true }).click();
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await app.settle();
    await sleep(600);
    const center = (await ui.view(tabId)).center;
    const shown = (await page.locator('[data-screen="diff"]').innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ");
    const failed = !check(center.kind === "graph", `via the context menu: after discarding the last file the center shows the graph again – got: ${JSON.stringify(center)}, text: “${shown.slice(0, 140)}”`);
    await flow.bugShot("B-01-verwerfen", failed);
    await closeCenter(tabId);
    await tidy(flow);
  },
  { bug: "B-01" },
);

// ---------------------------------------------------------------------------------------------
// BUG B-07: The confirmation cuts the path off at the END after 44 characters. With deep folders exactly the
// file name is missing – and for a single file it appears nowhere else in the dialog either.
await section(
  "F19-E17 Confirmation with a long path: the file name is readable before discarding",
  async () => {
    const { app, ui, page } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e17-titel" });
    const one = "src/auswertung/stationen/nord/tagesmittel_temperatur.py";
    const two = "src/auswertung/stationen/nord/tagesmittel_luftfeuchte.py";
    writeFile(repo, one, "a = 1\n");
    writeFile(repo, two, "b = 1\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Zwei Dateien in einem tiefen Ordner");
    writeFile(repo, one, "a = 2\n");
    writeFile(repo, two, "b = 2\n");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await ui.row("unstaged", one).click();
    await closeCenter(tabId);
    await ui.row("unstaged", one).focus();
    await press("Delete");
    await dialogOf(page).waitFor({ timeout: 5000 });
    const text = (await dialogOf(page).innerText()).replace(/\s+/g, " ");
    const titles = await dialogOf(page).locator("[title]").evaluateAll((list) => list.map((element) => element.getAttribute("title")));
    const failed = !check(text.includes("tagesmittel_temperatur.py") || titles.some((title) => title?.includes("tagesmittel_temperatur.py")), `the confirmation names the file (55-character path) – got: “${text.slice(0, 160)}”`);
    await flow.bugShot("B-07", failed);
    await press("Escape");
    await noDialog(page);
    equal(status(repo), [` M ${two}`, ` M ${one}`].sort(), "git status: nothing discarded");
    await tidy(flow);
  },
  { bug: "B-07" },
);

process.exit(await flow.finish());
