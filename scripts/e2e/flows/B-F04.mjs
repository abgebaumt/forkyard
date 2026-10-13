/**
 * Flow F04 – committing only part of a file (staging hunks and lines): the cases not yet covered
 * by a script under scripts/e2e/screens.
 *
 *   node scripts/e2e/flows/B-F04.mjs                 everything
 *   node scripts/e2e/flows/B-F04.mjs --only E1,E2    only sections whose title contains "E1" or "E2"
 *   node scripts/e2e/flows/B-F04.mjs --show          visible window
 *
 * Already covered (scripts/e2e/screens/diff.mjs): stage hunk (index), stage lines by keyboard in a
 * CRLF file, file without final newline, dragging in the line-number column, discarding hunk and
 * line with undo, unstage, stale state (simulated), image/binary/LFS display.
 * There every case ends at the index – here the path goes on to the commit, plus the edge cases.
 *
 * Checks run against the repository itself: blob in the index and in the commit byte for byte, git diff --cached.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../fixtures.mjs";
import { axeViolations, createFlow, diffDriver, diffReady, lines, sleep, tidy, toastsOf, unnamedControls } from "./B-lib.mjs";

const flow = createFlow("B-F04");
const { check, equal, eventually, until, section } = flow;
const press = (keys) => flow.page.keyboard.press(keys);

/** stdout as a Buffer – no decoding, no truncation. */
const gitRaw = (repo, ...args) =>
  execFileSync("git", args, { cwd: repo.path, env: { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")) }, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const hex = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")).toString("hex");
const indexBlob = (repo, file) => gitRaw(repo, "cat-file", "blob", `:${file}`);
const headBlob = (repo, file) => gitRaw(repo, "cat-file", "blob", `HEAD:${file}`);
const worktree = (repo, file) => fs.readFileSync(path.join(repo.path, file));
const writeBytes = (repo, file, content) => {
  const target = path.join(repo.path, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const commitAll = (repo, message) => {
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
};
const cachedDiff = (repo, file) => gitRaw(repo, "-c", "core.quotepath=false", "diff", "--cached", "--no-color", "--", file).toString("utf8");
const parse = (text) => {
  const all = text.split(/\r?\n/);
  return {
    hunks: all.filter((line) => line.startsWith("@@")).length,
    added: all.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)),
    removed: all.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)),
  };
};
const count = (repo) => Number(repo.git("rev-list", "--count", "HEAD"));

/** 60 lines; `changed` replaces single lines (1-based). */
const SERIES = Array.from({ length: 60 }, (_, index) => `2026-04-${String((index % 30) + 1).padStart(2, "0")};station-${String(index + 1).padStart(2, "0")};${(index * 7) % 23},${index % 10}`);
const series = (changed = {}) => `${SERIES.map((line, index) => changed[index + 1] ?? line).join("\n")}\n`;
const THREE = { 3: "2026-04-03;station-03;GEÄNDERT-OBEN", 30: "2026-04-30;station-30;GEÄNDERT-MITTE", 57: "2026-04-27;station-57;GEÄNDERT-UNTEN" };
const FILE = "daten/reihe.csv";

/** Repository with one file changed at three places far apart (three hunks). */
async function threeHunkRepo(name) {
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name });
  writeBytes(repo, FILE, series());
  commitAll(repo, "Messreihe angelegt");
  writeBytes(repo, FILE, series(THREE));
  return repo;
}

/** Line-number cell of the row with exactly this text. */
const gutterOf = (d, kind, text) =>
  d.grid
    .locator(`[data-kind="${kind}"]`)
    .filter({ has: flow.page.locator(".selectable", { hasText: new RegExp(`^\\u200b?${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }) })
    .first()
    .locator("[data-gutter]");

// ---------------------------------------------------------------------------------------------
await section("F04-H1 Stage hunk and commit (mouse): the commit contains exactly this hunk, the rest stays open", async () => {
  const { app, ui, page } = flow;
  const repo = await threeHunkRepo("h1-hunk");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", FILE); // click 1
  equal(await d.hunkCount(), 3, "three hunks");
  const before = await d.token();
  await d.grid.locator('[data-hunk="1"]').getByRole("button", { name: "Stage hunk" }).click(); // click 2
  await d.changedSince(before, FILE);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "the file is now in both lists");
  const staged = parse(cachedDiff(repo, FILE));
  equal([staged.hunks, staged.added, staged.removed], [1, [THREE[30]], [SERIES[29]]], "git diff --cached: exactly the middle hunk");
  equal(await d.hunkCount(), 2, "the view shows the two remaining hunks");
  await eventually(async () => (await ui.commitButton.textContent())?.trim(), "Commit 1 file", "the primary button names one file");
  await ui.summary.click(); // click 3
  await page.keyboard.type("Nur die Korrektur in der Mitte");
  await ui.commitButton.click(); // click 4
  await ui.waitToast("success", /Commit created/);
  const committed = parse(repo.git("show", "--format=", "--no-color", "HEAD", "--", FILE));
  equal([committed.hunks, committed.added, committed.removed], [1, [THREE[30]], [SERIES[29]]], "git show HEAD: the commit contains exactly this hunk");
  equal(hex(headBlob(repo, FILE)), hex(series({ 30: THREE[30] })), "git: blob in the commit byte for byte");
  const rest = parse(repo.git("diff", "--no-color", "--", FILE));
  equal([rest.hunks, rest.added], [2, [THREE[3], THREE[57]]], "git diff: the two other changes are still open");
  equal(hex(worktree(repo, FILE)), hex(series(THREE)), "working tree unchanged");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "after the commit: file only under “Unstaged”");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-H2 Select lines, right-click “Stage 2 lines”, commit", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h2-zeilen" });
  writeBytes(repo, "liste.txt", "eins\nzwei\ndrei\nvier\nfünf\n");
  commitAll(repo, "Liste angelegt");
  writeBytes(repo, "liste.txt", "eins\nZWEI\ndrei\nVIER\nfünf\nsechs\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", "liste.txt");
  await gutterOf(d, "remove", "vier").click();
  await gutterOf(d, "add", "VIER").click({ modifiers: ["Shift"] });
  equal(await d.selected(), ["-vier", "+VIER"], "two lines selected");
  const before = await d.token();
  await d.grid.locator('[data-kind="add"][aria-selected="true"] .selectable').first().click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor({ timeout: 5000 });
  const entries = (await menu.getByRole("menuitem").allInnerTexts()).map((entry) => entry.split("\n")[0]);
  equal(entries.slice(0, 3), ["Stage 2 lines", "Discard 2 lines", "Clear selection"], "the context menu starts with the actions for the selected lines");
  await menu.getByRole("menuitem", { name: /^Stage 2 lines/ }).click();
  await d.changedSince(before, "liste.txt");
  equal(hex(indexBlob(repo, "liste.txt")), hex("eins\nzwei\ndrei\nVIER\nfünf\n"), "index: only “VIER” taken over");
  equal(await d.selected(), [], "the selection is empty afterwards");
  await ui.summary.click();
  await page.keyboard.type("VIER groß geschrieben");
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(hex(headBlob(repo, "liste.txt")), hex("eins\nzwei\ndrei\nVIER\nfünf\n"), "git: the commit contains only the selected lines");
  equal(hex(worktree(repo, "liste.txt")), hex("eins\nZWEI\ndrei\nVIER\nfünf\nsechs\n"), "working tree unchanged");
  equal(parse(repo.git("diff", "--no-color", "--", "liste.txt")).added, ["ZWEI", "sechs"], "git diff: “ZWEI” and “sechs” are still open");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-H3 Keyboard only: open file, select lines, stage, type message, commit", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "h3-tastatur" });
  writeBytes(repo, "liste.txt", "eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\nelf\nzwölf\n");
  commitAll(repo, "Liste angelegt");
  writeBytes(repo, "liste.txt", "eins\nZWEI\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\nELF\nzwölf\n");
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  // No mouse from here on.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await ui.tabToList("Unstaged files");
  equal(await ui.focusedKey(), "liste.txt", "Tab reaches the file");
  await press("Enter");
  await diffReady(app, "liste.txt");
  const d = diffDriver(app);
  await press("F7");
  await press("F7");
  const focused = () => page.evaluate(() => document.activeElement?.closest("[data-row]")?.querySelector(".selectable")?.textContent?.replace(/​/g, "") ?? null);
  equal(await focused(), "elf", "F7 twice: focus on the second change");
  await press("Space");
  await press("Shift+ArrowDown");
  equal(await d.selected(), ["-elf", "+ELF"], "Space and Shift+↓ select the line pair");
  const before = await d.token();
  await press("Enter");
  await d.changedSince(before, "liste.txt");
  equal(hex(indexBlob(repo, "liste.txt")), hex("eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\nELF\nzwölf\n"), "index: only “ELF” taken over");
  await press("Escape");
  await eventually(async () => (await ui.view(tabId)).center.kind, "graph", "Esc closes the diff");
  await until(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-screen="commit-panel"]'))), "focus is back in the commit panel");
  await ui.tabToField("Summary");
  await page.keyboard.type("ELF per Tastatur gestaged");
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(repo.git("log", "-1", "--format=%s"), "ELF per Tastatur gestaged", "git: commit");
  equal(hex(headBlob(repo, "liste.txt")), hex("eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\nneun\nzehn\nELF\nzwölf\n"), "git: the commit contains only the selected line");
  equal(parse(repo.git("diff", "--no-color", "--", "liste.txt")).added, ["ZWEI"], "git diff: “ZWEI” is still open");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-E1 New (untracked) file: stage single lines, commit, then the rest as a hunk", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e1-neu" });
  writeBytes(repo, "neu/notiz.txt", "eins\nzwei\ndrei\nvier\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", "neu/notiz.txt");
  equal(await d.changed(), ["+eins", "+zwei", "+drei", "+vier"], "the new file shows all lines as added");
  await gutterOf(d, "add", "zwei").click();
  await gutterOf(d, "add", "drei").click({ modifiers: ["Shift"] });
  equal(await d.selected(), ["+zwei", "+drei"], "two lines of the new file selected");
  const before = await d.token();
  await d.bar.getByRole("button", { name: "Stage 2 lines" }).click();
  await d.changedSince(before, "neu/notiz.txt");
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "the new file is in both lists");
  equal(hex(indexBlob(repo, "neu/notiz.txt")), hex("zwei\ndrei\n"), "index: only the two selected lines");
  equal(hex(worktree(repo, "neu/notiz.txt")), hex("eins\nzwei\ndrei\nvier\n"), "working tree unchanged");
  equal(lines(repo.git("status", "--porcelain")), ["AM neu/notiz.txt"], "git status: new in the index, still modified in the working tree");
  equal(await d.changed(), ["+eins", "+vier"], "the view shows the rest");
  equal(await toastsOf(page, "danger"), [], "no error message");
  await ui.summary.fill("Zwei Zeilen einer neuen Datei");
  await ui.summary.focus();
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(hex(headBlob(repo, "neu/notiz.txt")), hex("zwei\ndrei\n"), "git: the commit contains the file with exactly two lines");
  await ui.closeToasts();
  // The rest as a whole hunk.
  await d.open("unstaged", "neu/notiz.txt");
  const second = await d.token();
  await d.grid.getByRole("button", { name: "Stage hunk" }).first().click();
  await d.changedSince(second, "neu/notiz.txt");
  await eventually(() => hex(indexBlob(repo, "neu/notiz.txt")), hex("eins\nzwei\ndrei\nvier\n"), "index: after “Stage hunk” the whole file");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-E2 Line endings: file switched from LF to CRLF, and mixed line endings – index byte for byte", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e2-zeilenenden" });
  writeBytes(repo, "umgestellt.txt", "eins\nzwei\ndrei\n");
  writeBytes(repo, "gemischt.txt", "a\r\nb\nc\r\n");
  commitAll(repo, "Dateien mit verschiedenen Zeilenenden");
  // Switched entirely to CRLF, plus a content change.
  writeBytes(repo, "umgestellt.txt", "eins\r\nZWEI\r\ndrei\r\n");
  writeBytes(repo, "gemischt.txt", "a\r\nB\nc\r\nd\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  const d = diffDriver(app);

  await d.open("unstaged", "umgestellt.txt");
  const shown = await d.changed();
  check(shown.includes("+ZWEI") && shown.includes("-zwei"), `the diff shows the content change (${JSON.stringify(shown)})`);
  // The last line of the block: only its line ending changes. (A pair from the middle of a block is checked by F04-E18.)
  await gutterOf(d, "remove", "drei").click();
  await gutterOf(d, "add", "drei").click({ modifiers: ["Control"] });
  equal((await d.selected()).map((line) => line.trimEnd()), ["-drei", "+drei"], "only the line pair “drei” selected");
  let before = await d.token();
  await d.bar.getByRole("button", { name: "Stage 2 lines" }).click();
  await d.changedSince(before, "umgestellt.txt");
  equal(hex(indexBlob(repo, "umgestellt.txt")), hex("eins\nzwei\ndrei\r\n"), "index: only the selected line with CRLF, the others keep LF");
  equal(hex(worktree(repo, "umgestellt.txt")), hex("eins\r\nZWEI\r\ndrei\r\n"), "working tree unchanged");

  await d.open("unstaged", "gemischt.txt");
  await gutterOf(d, "add", "d").click();
  equal(await d.selected(), ["+d"], "only the new line selected");
  before = await d.token();
  await d.bar.getByRole("button", { name: "Stage 1 line" }).click();
  await d.changedSince(before, "gemischt.txt");
  equal(hex(indexBlob(repo, "gemischt.txt")), hex("a\r\nb\nc\r\nd\n"), "index: new line appended with LF, mixed line endings before it unchanged");
  equal(hex(worktree(repo, "gemischt.txt")), hex("a\r\nB\nc\r\nd\n"), "working tree unchanged");

  await ui.summary.fill("Teile zweier Dateien mit besonderen Zeilenenden");
  await ui.summary.focus();
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(hex(headBlob(repo, "umgestellt.txt")), hex("eins\nzwei\ndrei\r\n"), "git: commit byte for byte (umgestellt.txt)");
  equal(hex(headBlob(repo, "gemischt.txt")), hex("a\r\nb\nc\r\nd\n"), "git: commit byte for byte (gemischt.txt)");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
// BUG B-03: If several consecutive lines are changed (one block: −eins −zwei −drei +EINS +ZWEI +DREI) and
// only a line pair from the middle is staged (−zwei, +ZWEI), the new line ends up in the index AFTER the
// remaining old lines of the block: “eins, drei, ZWEI” instead of “eins, ZWEI, drei”. The commit would
// contain lines in an order that never existed in the file.
await section(
  "F04-E18 Line pair from the middle of a block of changed lines: the order in the index is right",
  async () => {
    const { app, ui } = flow;
    const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e18-block" });
    writeBytes(repo, "block.txt", "kopf\neins\nzwei\ndrei\nfuss\n");
    commitAll(repo, "Block angelegt");
    writeBytes(repo, "block.txt", "kopf\nEINS\nZWEI\nDREI\nfuss\n");
    const { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    const d = diffDriver(app);
    await d.open("unstaged", "block.txt");
    equal(await d.changed(), ["-eins", "-zwei", "-drei", "+EINS", "+ZWEI", "+DREI"], "the diff shows one block: three removed, three added");
    await gutterOf(d, "remove", "zwei").click();
    await gutterOf(d, "add", "ZWEI").click({ modifiers: ["Control"] });
    equal(await d.selected(), ["-zwei", "+ZWEI"], "the line pair from the middle is selected");
    const before = await d.token();
    await d.bar.getByRole("button", { name: "Stage 2 lines" }).click();
    await d.changedSince(before, "block.txt");
    const index = indexBlob(repo, "block.txt").toString("utf8");
    const failed = !equal(index, "kopf\neins\nZWEI\ndrei\nfuss\n", "index: “ZWEI” is in the place of “zwei”");
    if (failed) await d.open("staged", "block.txt");
    await flow.bugShot("B-03", failed);
    equal(worktree(repo, "block.txt").toString("utf8"), "kopf\nEINS\nZWEI\nDREI\nfuss\n", "working tree unchanged");
    await tidy(flow);
  },
  { bug: "B-03" },
);

// ---------------------------------------------------------------------------------------------
await section("F04-E3 Binary file: no hunk or line actions, only as a whole file – commit byte for byte", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e3-binaer" });
  const oldBytes = Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 37) % 256));
  const newBytes = Buffer.from(Array.from({ length: 3072 }, (_, index) => (index * 91 + 5) % 256));
  writeBytes(repo, "daten/logger.bin", oldBytes);
  writeBytes(repo, "text.txt", "eins\n");
  commitAll(repo, "Binärdatei angelegt");
  writeBytes(repo, "daten/logger.bin", newBytes);
  writeBytes(repo, "text.txt", "eins\nzwei\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", "daten/logger.bin");
  equal(await d.notice(), "binary", "the view says: binary file");
  equal(await d.screen.getByRole("button", { name: /(Stage|Discard) hunk/ }).count(), 0, "no hunk actions for a binary file");
  equal(await d.grid.count(), 0, "no line grid, so no line selection");
  equal(await d.bar.count(), 0, "no selection bar");
  // Stage as a whole file (button in the row) and commit.
  await ui.row("unstaged", "daten/logger.bin").hover();
  await ui.row("unstaged", "daten/logger.bin").getByRole("button", { name: "Stage" }).click();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 });
  equal(hex(indexBlob(repo, "daten/logger.bin")), hex(newBytes), "index: the binary file byte for byte");
  await ui.summary.fill("Neue Logger-Daten");
  await ui.summary.focus();
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(hex(headBlob(repo, "daten/logger.bin")), hex(newBytes), "git: commit byte for byte");
  equal(lines(repo.git("show", "--name-only", "--format=", "HEAD")), ["daten/logger.bin"], "git: only the binary file in the commit");
  equal(lines(repo.git("status", "--porcelain")), [" M text.txt"], "git: the text file is still open");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-E4 Path with umlaut, emoji and spaces; Latin-1 file; 600-character line – stage lines byte for byte", async () => {
  const { app, ui } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e4-zeichen" });
  const special = "notizen/Größen 🌡 Übersicht.md";
  const longOld = `Messpunkt: ${"Temperatur Luftfeuchte Regen Wind ".repeat(18)}`.slice(0, 600);
  const longNew = longOld.replace("Wind", "Böen 🌬");
  writeBytes(repo, special, "# Größen\n\nTemperatur in °C\nLuftfeuchte in %\n");
  writeBytes(repo, "latin1.txt", Buffer.from("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\n", "latin1"));
  writeBytes(repo, "lang.txt", `oben\n${longOld}\nunten\n`);
  commitAll(repo, "Dateien mit besonderen Zeichen");
  writeBytes(repo, special, "# Größen\n\nTemperatur in °C 🌡\nLuftfeuchte in %\nRegen in mm – „Liter je m²“\n");
  writeBytes(repo, "latin1.txt", Buffer.from("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nLuftfeuchte;%\nK\xe4lte;\xb0C\n", "latin1"));
  writeBytes(repo, "lang.txt", `OBEN\n${longNew}\nunten\n`);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 3, staged: 0, conflicted: 0 });
  const d = diffDriver(app);

  await d.open("unstaged", special);
  await gutterOf(d, "add", "Regen in mm – „Liter je m²“").click();
  let before = await d.token();
  await d.bar.getByRole("button", { name: "Stage 1 line" }).click();
  await d.changedSince(before, special);
  equal(hex(indexBlob(repo, special)), hex("# Größen\n\nTemperatur in °C\nLuftfeuchte in %\nRegen in mm – „Liter je m²“\n"), "index: only the new line, UTF-8 unchanged (path with emoji)");

  await d.open("unstaged", "latin1.txt");
  check((await d.changed()).includes("+Kälte;°C"), `the Latin-1 file is shown readably (${JSON.stringify(await d.changed())})`);
  await gutterOf(d, "add", "Kälte;°C").click();
  before = await d.token();
  await d.bar.getByRole("button", { name: "Stage 1 line" }).click();
  await d.changedSince(before, "latin1.txt");
  equal(hex(indexBlob(repo, "latin1.txt")), hex(Buffer.from("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nK\xe4lte;\xb0C\n", "latin1")), "index: Latin-1 stays Latin-1, only the selected line");
  equal(hex(worktree(repo, "latin1.txt")), hex(Buffer.from("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nLuftfeuchte;%\nK\xe4lte;\xb0C\n", "latin1")), "working tree unchanged");

  await d.open("unstaged", "lang.txt");
  const rows = await d.rows();
  const longRemove = rows.findIndex((row) => row.kind === "remove" && row.text.length >= 600);
  const longAdd = rows.findIndex((row) => row.kind === "add" && row.text.length >= 600);
  check(longRemove >= 0 && longAdd >= 0, "the 600-character line shows as removed and added");
  equal(await flow.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "the long line does not break the page");
  await d.grid.locator('[data-kind="remove"]').nth(1).locator("[data-gutter]").click();
  await d.grid.locator('[data-kind="add"]').nth(1).locator("[data-gutter]").click({ modifiers: ["Control"] });
  equal((await d.selected()).map((line) => line.slice(0, 12)), ["-Messpunkt: ", "+Messpunkt: "], "only the long line selected");
  before = await d.token();
  await d.bar.getByRole("button", { name: "Stage 2 lines" }).click();
  await d.changedSince(before, "lang.txt");
  equal(hex(indexBlob(repo, "lang.txt")), hex(`oben\n${longNew}\nunten\n`), "index: only the long line taken over");

  await ui.summary.fill("Teile aus drei Dateien");
  await ui.summary.focus();
  await press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  equal(lines(repo.git("-c", "core.quotepath=false", "show", "--name-only", "--format=", "HEAD")).sort(), ["lang.txt", "latin1.txt", special].sort(), "git: three files in the commit");
  equal(hex(headBlob(repo, "latin1.txt")), hex(Buffer.from("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nK\xe4lte;\xb0C\n", "latin1")), "git: Latin-1 blob in the commit byte for byte");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-E6 File changed from outside while the diff is open: nothing stale ends up in the index", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "e6-aussen" });
  writeBytes(repo, "liste.txt", "eins\nzwei\ndrei\n");
  commitAll(repo, "Liste angelegt");
  const first = "eins\nZWEI\ndrei\n";
  const second = "eins\nZWEI\ndrei\nvier\n";
  writeBytes(repo, "liste.txt", first);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", "liste.txt");
  equal(await d.changed(), ["-zwei", "+ZWEI"], "initial state in the diff");
  // Change from outside and click right away – before the watcher could reload the diff.
  writeBytes(repo, "liste.txt", second);
  await d.grid.getByRole("button", { name: "Stage hunk" }).first().click();
  await until(async () => (await toastsOf(page, "info")).some((text) => text.includes("The file has changed in the meantime")) || repo.git("diff", "--cached", "--name-only") !== "", "the app reports the stale state – or stages the reloaded one", 15_000);
  const staleReported = (await toastsOf(page, "info")).some((text) => text.includes("The file has changed in the meantime"));
  const index = indexBlob(repo, "liste.txt").toString("utf8");
  if (staleReported) equal(index, "eins\nzwei\ndrei\n", "stale state reported: nothing changed in the index");
  else equal(index, second, "without a message: the current file content is staged, not the stale one");
  console.log(`  outcome: ${staleReported ? "message “The file has changed in the meantime”" : "reloaded hunk staged"}`);
  equal(await toastsOf(page, "danger"), [], "no error message");
  await ui.closeToasts();
  // Afterwards the diff shows the current state, and staging works.
  if (staleReported) {
    await eventually(() => d.changed(), ["-zwei", "+ZWEI", "+vier"], "the reloaded diff also shows the line from outside");
    const before = await d.token();
    await d.grid.getByRole("button", { name: "Stage hunk" }).first().click();
    await d.changedSince(before, "liste.txt");
    await eventually(() => indexBlob(repo, "liste.txt").toString("utf8"), second, "second attempt: the current state is staged");
  }
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-N3 File deleted from outside while the diff is open: no broken view, state matches git", async () => {
  const { app, ui, page } = flow;
  const repo = await flow.fixture(makeCleanRepoWithRemote, { name: "n3-geloescht" });
  writeBytes(repo, "liste.txt", "eins\nzwei\ndrei\n");
  writeBytes(repo, "bleibt.txt", "bleibt\n");
  commitAll(repo, "Liste angelegt");
  writeBytes(repo, "liste.txt", "eins\nZWEI\ndrei\n");
  writeBytes(repo, "bleibt.txt", "bleibt\nund wächst\n");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", "liste.txt");
  fs.rmSync(path.join(repo.path, "liste.txt"));
  await d.grid.getByRole("button", { name: "Stage hunk" }).first().click({ timeout: 5000 }).catch(() => undefined);
  await sleep(1500);
  await app.settle();
  const danger = await toastsOf(page, "danger");
  check(danger.every((text) => !/undefined|null|\[object|panicked|stack/i.test(text)), `no raw error message (${JSON.stringify(danger)})`);
  await ui.closeToasts();
  // The view now shows the deletion; the app state matches git.
  await eventually(async () => (await ui.status(repoId))?.unstaged.find((file) => file.path === "liste.txt")?.status ?? null, "deleted", "the file shows as deleted under “Unstaged”", 20_000);
  const cachedNames = lines(repo.git("diff", "--cached", "--name-only"));
  equal((await ui.status(repoId)).staged.map((file) => file.path), cachedNames, "the app's “Staged” matches git diff --cached");
  await d.open("unstaged", "liste.txt");
  const rows = (await d.changed()).filter((line) => line.startsWith("-"));
  equal(rows, ["-eins", "-zwei", "-drei"], "the diff of the deleted file shows all lines as removed");
  // Staging the deletion as a whole still works.
  const before = await d.token();
  await d.grid.getByRole("button", { name: "Stage hunk" }).first().click();
  await d.changedSince(before, "liste.txt");
  await eventually(() => lines(repo.git("status", "--porcelain")).sort(), [" M bleibt.txt", "D  liste.txt"], "git status: deletion staged");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-E8 Double click on “Stage hunk” and double Enter on the line selection: exactly one step", async () => {
  const { app, ui, page } = flow;
  const repo = await threeHunkRepo("e8-doppelt");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", FILE);
  // Double click on the first hunk: after the redraw the second click would hit the next hunk at the same place.
  await d.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Stage hunk" }).dblclick();
  await eventually(() => parse(cachedDiff(repo, FILE)).hunks >= 1, true, "the hunk is staged");
  await sleep(1500);
  await app.settle();
  const staged = parse(cachedDiff(repo, FILE));
  equal([staged.hunks, staged.added], [1, [THREE[3]]], "git diff --cached: double click stages exactly one hunk");
  equal(await toastsOf(page, "danger"), [], "no error message after the double click");
  equal(await d.hunkCount(), 2, "two hunks are still open");

  // Lines: double Enter on the selection.
  await gutterOf(d, "remove", SERIES[29]).click();
  await gutterOf(d, "add", THREE[30]).click({ modifiers: ["Control"] });
  equal((await d.selected()).length, 2, "one line pair selected");
  await press("Enter");
  await press("Enter");
  await eventually(() => parse(cachedDiff(repo, FILE)).hunks, 2, "the line pair is staged");
  await sleep(1500);
  await app.settle();
  const after = parse(cachedDiff(repo, FILE));
  equal([after.hunks, after.added], [2, [THREE[3], THREE[30]]], "git diff --cached: double Enter stages only the selected lines");
  equal(parse(repo.git("diff", "--no-color", "--", FILE)).added, [THREE[57]], "git diff: the third hunk is still open");
  equal(await toastsOf(page, "danger"), [], "no error message after the double Enter");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section(
  "F04-E10 Restart the app with a partially staged file: both parts are right, unstaging works",
  async () => {
    const dataDir = flow.tempDir("gc-e2e-b-f04-data-");
    const repo = await threeHunkRepo("e10-neustart");
    await flow.start({ dataDir });
    let { app, ui } = flow;
    let { repoId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    let d = diffDriver(app);
    await d.open("unstaged", FILE);
    const before = await d.token();
    await d.grid.locator('[data-hunk="2"]').getByRole("button", { name: "Stage hunk" }).click();
    await d.changedSince(before, FILE);
    equal(parse(cachedDiff(repo, FILE)).added, [THREE[57]], "before the restart: the third hunk is staged");
    equal(app.consoleErrors, [], "console errors before the restart");
    await flow.stop();

    await flow.start({ dataDir });
    ({ app, ui } = flow);
    ({ repoId } = await app.openRepo(repo.path));
    await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "after the restart the file is in both lists");
    d = diffDriver(app);
    await d.open("staged", FILE);
    equal(await d.hunkCount(), 1, "staged: one hunk");
    equal((await d.changed()).filter((line) => line.startsWith("+")), [`+${THREE[57]}`], "staged: the third hunk");
    await d.open("unstaged", FILE);
    equal(await d.hunkCount(), 2, "unstaged: two hunks");
    await d.open("staged", FILE);
    const second = await d.token();
    await d.grid.getByRole("button", { name: "Unstage hunk" }).click();
    await d.changedSince(second, FILE);
    await eventually(() => cachedDiff(repo, FILE), "", "git diff --cached is empty after unstaging");
    equal(hex(worktree(repo, FILE)), hex(series(THREE)), "working tree unchanged");
    await tidy(flow);
  },
  { launch: false },
);
await flow.stop();

// ---------------------------------------------------------------------------------------------
await section("F04-E12 Minimum window 960×600: hunk buttons and selection bar lie inside the window and work", async () => {
  const { app, ui, page } = flow;
  const repo = await threeHunkRepo("e12-klein");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  await app.setSize(960, 600);
  const d = diffDriver(app);
  await d.open("unstaged", FILE);
  const inside = async (locator, what) => {
    const box = await locator.boundingBox();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960.5 && box.y + box.height <= 600.5, `${what} lies fully inside the window (${JSON.stringify(box)})`);
  };
  await inside(d.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Stage hunk" }), "“Stage hunk”");
  await inside(d.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Discard hunk" }), "“Discard hunk”");
  await gutterOf(d, "add", THREE[3]).click();
  await d.bar.waitFor({ timeout: 5000 });
  await inside(d.bar, "the selection bar");
  await inside(d.bar.getByRole("button", { name: "Stage 1 line" }), "“Stage 1 line”");
  await inside(d.bar.getByRole("button", { name: "Discard 1 line" }), "“Discard 1 line”");
  equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no horizontal overflow at 960×600");
  const before = await d.token();
  await d.bar.getByRole("button", { name: "Stage 1 line" }).click();
  await d.changedSince(before, FILE);
  equal(parse(cachedDiff(repo, FILE)).added, [THREE[3]], "git diff --cached: the line is staged");
  await app.setSize(1440, 900);
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-E14 Screen reader: named grid, rows with a word for +/−, selection is announced, buttons named", async () => {
  const { app, ui, page } = flow;
  const repo = await threeHunkRepo("e14-a11y");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", FILE);
  equal(await d.grid.getAttribute("role"), "grid", "the rows are in a grid");
  equal(await d.grid.getAttribute("aria-label"), `Changes in ${FILE}`, "the grid names the file");
  equal(await d.grid.getAttribute("aria-multiselectable"), "true", "multi-selection is marked up");
  const words = await d.grid.locator('[data-kind="add"], [data-kind="remove"]').evaluateAll((list) => [...new Set(list.map((row) => row.querySelector("[data-gutter]").textContent.replace(/[\d\s]/g, "")))].sort());
  equal(words, ["+added", "−removed"], "added/removed are shown as words, not only as colour");
  equal(await unnamedControls(page, '[data-screen="diff"]'), [], "every control of the diff view has a name");
  equal(await page.getByRole("region", { name: `Diff of ${FILE}` }).count() + (await page.locator(`[data-screen="diff"][aria-label="Diff of ${FILE}"]`).count()) > 0, true, "the view is named “Diff of …”");
  await gutterOf(d, "add", THREE[3]).click();
  equal(await d.grid.locator('[aria-selected="true"]').count(), 1, "the selected row has aria-selected");
  equal(await d.bar.getAttribute("role"), "toolbar", "the selection bar is a toolbar");
  equal(await d.bar.getAttribute("aria-label"), "Selected lines", "… with a name");
  equal(await d.bar.locator("[aria-live]").innerText(), "1 line selected", "the number of selected lines is announced (aria-live)");
  equal(await axeViolations(page, '[data-screen="diff"]'), [], "axe: no violations in the diff view");
  await press("Escape");
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-E16 Two windows: partial staging in A reloads the open diff in B – and vice versa", async () => {
  const { app, ui } = flow;
  const repo = await threeHunkRepo("e16-zwei");
  const a = await app.openRepo(repo.path);
  await ui.waitCounts(a.repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const other = await flow.second();
  try {
    const b = await other.app.openRepo(repo.path);
    await other.ui.waitCounts(b.repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    const da = diffDriver(app);
    const db = diffDriver(other.app);
    await db.open("unstaged", FILE);
    equal(await db.hunkCount(), 3, "B: three hunks open");
    await da.open("unstaged", FILE);
    const before = await da.token();
    await da.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Stage hunk" }).click();
    await da.changedSince(before, FILE);
    await other.ui.waitCounts(b.repoId, { unstaged: 1, staged: 1, conflicted: 0 }, "B: the file is now also under “Staged”", 20_000);
    await eventually(() => db.hunkCount(), 2, "B: the open diff has reloaded and shows two hunks", 20_000);
    // B stages the next hunk with the reloaded state.
    const second = await db.token();
    await db.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Stage hunk" }).click();
    await db.changedSince(second, FILE);
    equal(parse(cachedDiff(repo, FILE)).added, [THREE[3], THREE[30]], "git diff --cached: both hunks, one from each window");
    await eventually(() => da.hunkCount(), 1, "A: the open diff shows only one hunk", 20_000);
    equal(await toastsOf(other.app.page, "danger"), [], "B: no error message");
    equal(other.app.consoleErrors, [], "B: console errors");
  } finally {
    await other.app.close();
  }
  await tidy(flow);
});

// ---------------------------------------------------------------------------------------------
await section("F04-N2 Repository locked (.git/index.lock) when staging a hunk: understandable message, index unchanged", async () => {
  const { app, ui, page } = flow;
  const repo = await threeHunkRepo("n2-sperre");
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });
  const d = diffDriver(app);
  await d.open("unstaged", FILE);
  const lock = path.join(repo.path, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  try {
    await d.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Stage hunk" }).click();
    const toast = await ui.waitToast("danger", /Stage failed/, 30_000);
    check(/index\.lock|locked|another program/i.test(toast ?? ""), `the toast explains the lock (${toast})`);
  } finally {
    fs.rmSync(lock, { force: true });
  }
  equal(cachedDiff(repo, FILE), "", "git diff --cached: nothing staged");
  equal(await d.hunkCount(), 3, "the view still shows three hunks");
  await ui.closeToasts();
  const before = await d.token();
  await d.grid.locator('[data-hunk="0"]').getByRole("button", { name: "Stage hunk" }).click();
  await d.changedSince(before, FILE);
  equal(parse(cachedDiff(repo, FILE)).added, [THREE[3]], "without the lock staging works");
  equal(await toastsOf(page, "danger"), [], "no error message anymore");
  void count;
  await tidy(flow);
});

process.exit(await flow.finish());
