/**
 * F07 – Merge with conflict: cases not covered by other scripts.
 * Real app, real fixture repositories, checked in the repository itself with git.
 *
 *   node scripts/e2e/flows/D-F07.mjs                    everything
 *   node scripts/e2e/flows/D-F07.mjs --only F07-H1      only sections whose ID or title contains this (comma separates several)
 *   node scripts/e2e/flows/D-F07.mjs --show             visible window
 *
 * At the end there is the list of green and red sections. A red section with "BUG D-xx" is the test
 * that the reported bug is fixed against.
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { branchOf, commit, createFlow, exists, gitDirHas, gitTry, head, lockFileExclusive, parentsOf, porcelain, readFile, sleep, writeHook } from "./D-lib.mjs";

const t = createFlow("D-F07");
const { check, equal, eventually } = t;

const OURS = "# Messnetz\n\nFassung von main.\n";
const THEIRS = "# Messnetz\n\nFassung des Thema-Branches.\n";

/**
 * main and "thema/konflikt" change README.md differently (conflict); the topic branch also brings
 * thema.txt. `second`: stationen.csv collides too.
 */
function conflictRepo(name, { second = false, branch = "thema/konflikt", file = "README.md" } = {}) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  repo.git("checkout", "-q", "-b", branch);
  commit(repo, file, THEIRS, "README im Thema-Branch");
  if (second) commit(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen (Thema);3\n", "Hafen im Thema-Branch");
  commit(repo, "thema.txt", "neu im Thema\n", "Datei aus dem Thema");
  repo.git("checkout", "-q", "main");
  commit(repo, file, OURS, "README auf main");
  if (second) commit(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen (main);3\n", "Hafen auf main");
  repo.side = head(repo, branch);
  repo.mainBefore = head(repo);
  repo.branch = branch;
  return repo;
}
/** Start a merge from outside (as in a terminal): it stops with a conflict. `resolve`: resolve and stage the conflicts right away. */
function startMergeOutside(repo, { resolve = null } = {}) {
  const merged = gitTry(repo, ["merge", "--no-ff", repo.branch]);
  if (merged.ok) throw new Error("The merge should have produced a conflict.");
  if (resolve) {
    for (const file of repo.git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean)) {
      repo.git("checkout", `--${resolve}`, "--", file);
      repo.git("add", "--", file);
    }
  }
}
/** Two branches that merge without conflict (no fast-forward). */
function cleanMergeRepo(name) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  repo.git("checkout", "-q", "-b", "thema/sauber");
  commit(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen;3\nW;Wald;212\n", "Station Wald");
  repo.git("checkout", "-q", "main");
  commit(repo, "haupt.txt", "auf main\n", "Arbeit auf main");
  repo.side = head(repo, "thema/sauber");
  repo.mainBefore = head(repo);
  repo.branch = "thema/sauber";
  return repo;
}

await t.launch();
let page = t.page;
const commitPanelScreen = () => page.locator('[data-screen="commit-panel"]');
const conflictScreen = () => page.locator('[data-screen="conflict"]');
const conflictRow = (file) => page.locator(`[data-section="conflicts"] [data-row-key=${JSON.stringify(file)}]`);
const conflictRows = () => page.locator('[data-section="conflicts"] [data-row-key]').evaluateAll((rows) => rows.map((row) => row.dataset.rowKey));
const commitButton = () => page.locator('form[aria-label="Commit"] button[data-action]');
const summary = () => page.locator("[data-commit-summary]");
const description = () => page.getByRole("textbox", { name: "Description" });
const toolReady = async (file) => {
  await page.waitForFunction(
    (label) => {
      const root = document.querySelector('[data-screen="conflict"]');
      return root?.getAttribute("aria-label") === label && root.getAttribute("data-conflict-state") !== "loading";
    },
    `Resolve conflict: ${file}`,
    { timeout: 60_000 },
  );
  await t.app.settle();
};
const sideBox = (conflict, side) => conflictScreen().locator(`[data-sides] [data-conflict-head="${conflict}"][data-side="${side}"]`);
const saveButton = () => conflictScreen().locator('button[data-action="save"]');
const mergeBanner = () => commitPanelScreen().locator('[role="alert"], [role="status"]').filter({ hasText: /Merge of/ }).first();
/** Waits until the app shows the merge with `count` open conflicts. */
const appSeesMerge = async (repo, count, message) => {
  await eventually(
    async () => {
      await t.comeBack();
      return [await t.operationKind(repo.repoId), await t.conflictedCount(repo.repoId)];
    },
    ["merge", count],
    message,
    30_000,
  );
};

// ---------------------------------------------------------------------------------------------
await t.section("F07-H1", "Happy path with the mouse: branch menu → merge → conflict → conflict tool → save → finish merge", async () => {
  const repo = await t.open(conflictRepo("f07-h1"));
  await t.branchMenu("thema/konflikt");
  const items = await t.menuItems();
  check(items.some((item) => /Merge “thema\/konflikt” into “main”/.test(item.text) && !item.disabled), `the branch menu offers the merge (${JSON.stringify(items.map((item) => item.text))})`);
  await t.pick(/Merge “thema\/konflikt” into “main”/);
  const toast = await t.waitToast(/Merge: conflict in one file/, "warning");
  check(/commit panel/i.test(toast?.text ?? ""), "the toast says where to continue");
  check(porcelain(repo).includes("UU README.md"), "git: README.md is in conflict");
  check(gitDirHas(repo, "MERGE_HEAD"), "git: the merge is running (MERGE_HEAD)");
  await eventually(() => t.view(repo.tabId).then((view) => view.selection.kind), "wip", "the view jumps to the local changes");
  await mergeBanner().waitFor({ timeout: 15_000 });
  check(/Merge of thema\/konflikt into main/.test(await mergeBanner().innerText()), `the banner names both branches (${(await mergeBanner().innerText()).replace(/\s+/g, " ")})`);
  await eventually(t.footer, (value) => /merge in progress/i.test(value), "the status bar shows \"merge in progress\"");
  equal(await conflictRows(), ["README.md"], "the \"Conflicts\" section names the file");
  equal((await commitButton().innerText()).trim(), "Finish merge", "the primary button is called \"Finish merge\"");
  equal(await commitButton().getAttribute("aria-disabled"), "true", "it is disabled while the conflict is open");
  await t.closeToasts();

  // Conflict tool: take the incoming side, save.
  await conflictRow("README.md").click();
  await toolReady("README.md");
  await sideBox(0, "theirs").click();
  await eventually(() => saveButton().getAttribute("aria-disabled"), null, "after the choice, saving is possible");
  await saveButton().click();
  await eventually(() => t.conflictedCount(repo.repoId), 0, "the conflict is resolved");
  equal(repo.git("ls-files", "-u"), "", "git ls-files -u is empty");
  equal(readFile(repo, "README.md"), THEIRS, "file: the topic branch version, without markers");
  await eventually(() => t.view(repo.tabId).then((view) => view.center.kind), "graph", "after the last file the tool closes");

  // Finish the merge.
  await eventually(() => commitButton().getAttribute("aria-disabled"), null, "\"Finish merge\" is possible now");
  await commitButton().click();
  await t.waitToast(/complete/, "success");
  equal(parentsOf(repo), [repo.mainBefore, repo.side], "git: merge commit with both parents (main first)");
  equal(repo.git("show", "HEAD:README.md") + "\n", THEIRS, "git: the merge commit contains the chosen version");
  check(exists(repo, "thema.txt"), "file from the topic branch is there");
  check(!gitDirHas(repo, "MERGE_HEAD"), "git: no merge open anymore");
  equal(porcelain(repo), "", "git: working tree clean");
  await eventually(t.footer, (value) => !/merge in progress/i.test(value), "the status bar shows no merge anymore");
  await eventually(() => t.view(repo.tabId).then((view) => view.selection), { kind: "commits", shas: [head(repo)] }, "the new merge commit is selected in the graph");
  check((await t.graphRow(head(repo)).count()) === 1, "and is a row in the graph");
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-H2", "Happy path keyboard only: from the left panel to the merge commit", async () => {
  const repo = await t.open(conflictRepo("f07-h2"));
  const kb = page.keyboard;
  await page.evaluate(() => document.activeElement?.blur?.());
  await kb.press("Alt+1");
  await t.pressUntil("ArrowDown", (el) => /^Local branch thema\/konflikt(,|$)/.test(el?.getAttribute("aria-label") ?? ""), "arrow down to \"thema/konflikt\" in the left panel", 40);
  check((await t.focused()).visible, "the focus on the branch row is visible");
  await kb.press("Shift+F10");
  await t.pickByKeyboard(/Merge .*thema\/konflikt.* into .*main/);
  await t.waitToast(/Merge: conflict in one file/, "warning");
  await eventually(() => t.conflictedCount(repo.repoId), 1, "one conflict");

  // Commit panel → conflict list → Enter opens the tool.
  await kb.press("Alt+3");
  await t.pressUntil("Tab", (el) => Boolean(el?.closest('[data-section="conflicts"]')) && el.hasAttribute("data-row-key"), "Tab to the conflict list", 60);
  equal(await page.evaluate(() => document.activeElement?.dataset.rowKey ?? null), "README.md", "focus on the conflict file");
  check((await t.focused()).visible, "the focus in the conflict list is visible");
  await kb.press("Enter");
  await toolReady("README.md");
  // Alt+2: into the view; focus is on the checkbox of the current side. Space takes it.
  await kb.press("Alt+2");
  await eventually(() => page.evaluate(() => [document.activeElement?.getAttribute("data-conflict-head"), document.activeElement?.getAttribute("data-side")]), ["0", "ours"], "Alt+2 puts the focus on the first conflict");
  await kb.press("Space");
  await eventually(() => saveButton().getAttribute("aria-disabled"), null, "Space takes the current side; saving is possible");
  await kb.press("Control+s");
  await eventually(() => t.view(repo.tabId).then((view) => view.center.kind), "graph", "Ctrl+S saves, the tool closes");
  equal(repo.git("ls-files", "-u"), "", "git ls-files -u is empty");
  equal(readFile(repo, "README.md"), OURS, "file: the main version");
  await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="right"]'))), true, "the focus is in the commit panel afterwards");
  await kb.press("Control+Enter");
  await t.waitToast(/complete/, "success");
  equal(parentsOf(repo), [repo.mainBefore, repo.side], "git: merge commit with both parents");
  equal(porcelain(repo), "", "git: clean");
  check(!gitDirHas(repo, "MERGE_HEAD"), "git: no merge open anymore");
  const where = await t.focused();
  check(where.tag !== "BODY" && where.tag !== null, `after finishing, the focus is on an element, not nowhere (${JSON.stringify(where)})`);
});

// ---------------------------------------------------------------------------------------------
// BUG D-01: The prepared merge message cannot be cleared and rewritten – as soon as the field is
// empty it comes back, and the typed text is appended.
await t.section(
  "F07-E5",
  "Empty input: delete the merge message and type a new one (Ctrl+A, Del, text)",
  async () => {
    const repo = conflictRepo("f07-e5");
    startMergeOutside(repo, { resolve: "ours" });
    await t.open(repo);
    await eventually(() => t.operationKind(repo.repoId), "merge", "the app shows the running merge");
    await eventually(() => summary().inputValue(), "Merge branch 'thema/konflikt'", "the prepared merge message is in the field");
    await summary().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await sleep(400);
    await page.keyboard.type("Eigene Message");
    await sleep(300);
    const typed = await summary().inputValue();
    if (typed !== "Eigene Message") await t.bugShot("D-01");
    equal(typed, "Eigene Message", "after Ctrl+A, Del and typing, exactly the typed text is in the field");
    await page.keyboard.press("Control+Enter");
    await t.waitToast(/complete/, "success");
    equal(repo.git("log", "-1", "--format=%s"), "Eigene Message", "git: the merge commit has the typed message");
  },
  { bug: "D-01" },
);

await t.section("F07-E5b", "Empty input: without a message there is never a merge commit with an empty message", async () => {
  const repo = conflictRepo("f07-e5b");
  startMergeOutside(repo, { resolve: "theirs" });
  await t.open(repo);
  await eventually(() => t.operationKind(repo.repoId), "merge", "the app shows the running merge");
  await summary().fill("");
  await description().fill("");
  await sleep(300);
  await commitButton().click();
  // Either a message appears at the field, or the prepared message is used – never an empty one.
  const done = await t.waitFor(() => !gitDirHas(repo, "MERGE_HEAD"), (value) => value === true, 8000);
  if (done) {
    check(repo.git("log", "-1", "--format=%s").trim().length > 0, "git: the merge commit message is not empty");
    equal(repo.git("log", "-1", "--format=%s"), "Merge branch 'thema/konflikt'", "git: the prepared merge message is used");
    equal(parentsOf(repo), [repo.mainBefore, repo.side], "git: two parents");
  } else {
    check((await page.locator('form[aria-label="Commit"] [role="alert"]').count()) > 0, "no commit – then the reason is at the field");
  }
});

// ---------------------------------------------------------------------------------------------
const LONG_BRANCH = "thema/größen-änderung-🚀-mit-einem-sehr-langen-namen-der-über-sechzig-zeichen-geht";
const ODD_FILE = "docs/Größen & Maße 🚀 Übersicht.md";
const LONG_SUMMARY = `Größen & Maße 🚀 zusammengeführt – ${"ÄÖÜ äöü ß € „Anführung“ 测试 ".repeat(18)}Ende`;
await t.section("F07-E6", "Emoji, umlauts, spaces and 500 characters: branch name (over 60 characters), path and merge message", async () => {
  check([...LONG_SUMMARY].length >= 500, `the message has at least 500 characters (${[...LONG_SUMMARY].length})`);
  const repo = await t.open(conflictRepo("f07-e6", { branch: LONG_BRANCH, file: ODD_FILE }));
  const row = t.branchRow(LONG_BRANCH);
  equal(await row.count(), 1, "left panel: the row's accessible name contains the full branch name");
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: "right" });
  await t.waitMenu();
  const item = (await t.menuItems()).find((entry) => /into “main”/.test(entry.text));
  check(Boolean(item) && item.title.includes(LONG_BRANCH), `the menu entry shortens the name, the tooltip shows it in full (${JSON.stringify(item)})`);
  equal(await t.overflow().then((value) => value.x), 0, "the menu with the long name does not overflow the window");
  await t.pick(/into “main”/);
  await t.waitToast(/Merge: conflict in one file/, "warning");
  await eventually(conflictRows, [ODD_FILE], "the conflict list names the path with umlaut, spaces, & and emoji");
  const banner = (await mergeBanner().innerText()).replace(/\s+/g, " ");
  check(banner.includes("größen-änderung-🚀"), `the banner shows the branch name with umlaut and emoji (${banner})`);
  await t.closeToasts();
  await conflictRow(ODD_FILE).click();
  await toolReady(ODD_FILE);
  await sideBox(0, "ours").click();
  await saveButton().click();
  await eventually(() => t.conflictedCount(repo.repoId), 0, "resolved and staged");
  equal(readFile(repo, ODD_FILE), OURS, "file with the special name: main version");
  equal(repo.git("ls-files", "-u"), "", "git ls-files -u is empty");

  await summary().fill(LONG_SUMMARY);
  await description().fill("Zeile mit Emoji 🎉 und Umlauten äöüß.\n\n\tEingerückt bleibt eingerückt.");
  equal(await t.overflow().then((value) => value.x), 0, "500 characters in the summary: no horizontal overflow");
  equal(await commitPanelScreen().evaluate((panel) => panel.scrollWidth - panel.clientWidth), 0, "the commit panel does not overflow either");
  await page.keyboard.press("Control+Enter");
  await t.waitToast(/complete/, "success");
  equal(repo.git("log", "-1", "--format=%B").replace(/\s+$/, ""), `${LONG_SUMMARY}\n\nZeile mit Emoji 🎉 und Umlauten äöüß.\n\n\tEingerückt bleibt eingerückt.`, "git: message exact to the character, with emoji and umlauts");
  equal(parentsOf(repo), [repo.mainBefore, repo.side], "git: two parents");
  equal(await t.overflow().then((value) => value.x), 0, "afterwards (graph with the long message): no overflow");
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-E7", "Changed from outside: merge started, resolved and aborted in the terminal while the app is open", async () => {
  const repo = await t.open(conflictRepo("f07-e7"));
  equal(await t.operationKind(repo.repoId), null, "initial state: no merge");
  startMergeOutside(repo);
  await appSeesMerge(repo, 1, "the app notices the merge started in the terminal with one conflict");
  await eventually(t.footer, (value) => /merge in progress/i.test(value), "status bar: \"merge in progress\"");
  await t.store("selectWip", repo.tabId);
  await mergeBanner().waitFor({ timeout: 15_000 });
  equal(await conflictRows(), ["README.md"], "the conflict list shows the file");

  // Resolved in the terminal.
  repo.git("checkout", "--theirs", "--", "README.md");
  repo.git("add", "--", "README.md");
  await appSeesMerge(repo, 0, "the app notices the conflict was resolved in the terminal");
  await eventually(() => commitButton().getAttribute("aria-disabled"), null, "\"Finish merge\" is enabled");
  equal(await page.locator('[data-section="conflicts"]').count(), 0, "the \"Conflicts\" section is gone");

  // Aborted in the terminal.
  repo.git("merge", "--abort");
  await eventually(
    async () => {
      await t.comeBack();
      return t.operationKind(repo.repoId);
    },
    null,
    "the app notices the abort in the terminal",
    30_000,
  );
  await eventually(t.footer, (value) => !/merge in progress/i.test(value), "status bar: no merge anymore");
  equal(await mergeBanner().count(), 0, "the banner is gone");
  await eventually(async () => ((await commitButton().innerText()).trim() === "Finish merge" ? "Finish merge" : "other"), "other", "the primary button is no longer called \"Finish merge\"");
  equal(head(repo), repo.mainBefore, "git: main unchanged");
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-E8", "Double click and double Ctrl+Enter on \"Finish merge\": exactly one merge commit, no error toast", async () => {
  for (const how of ["double click", "double Ctrl+Enter"]) {
    const repo = conflictRepo(`f07-e8-${how === "double click" ? "klick" : "enter"}`);
    startMergeOutside(repo, { resolve: "theirs" });
    await t.open(repo);
    await eventually(() => t.operationKind(repo.repoId), "merge", `${how}: the app shows the merge`);
    await eventually(() => commitButton().getAttribute("aria-disabled"), null, `${how}: finishing is enabled`);
    if (how === "double click") await commitButton().dblclick();
    else {
      await summary().focus();
      await page.keyboard.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
    }
    await t.waitToast(/complete/, "success");
    await sleep(1200);
    equal(parentsOf(repo), [repo.mainBefore, repo.side], `${how}: git – merge commit with both parents`);
    equal(repo.git("rev-list", "--first-parent", "--count", `${repo.mainBefore}..HEAD`), "1", `${how}: git – exactly one new commit on main`);
    equal(porcelain(repo), "", `${how}: git – clean`);
    equal(await t.dangerToasts(), [], `${how}: no error toast from the second trigger`);
    await t.closeToasts();
  }
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-E9", "Cancel midway: Esc in the confirmation aborts nothing; Esc in the conflict tool with a choice asks first", async () => {
  const repo = await t.open(conflictRepo("f07-e9"));
  await t.branchMenu("thema/konflikt");
  await t.pick(/Merge “thema\/konflikt” into “main”/);
  await t.waitToast(/Merge: conflict in one file/, "warning");
  await t.closeToasts();
  await mergeBanner().waitFor({ timeout: 15_000 });
  await commitPanelScreen().getByRole("button", { name: "Abort merge" }).click();
  await t.waitDialog(/^Abort merge\?$/);
  equal(await t.focusedText(), "Cancel", "confirmation: focus on \"Cancel\"");
  await page.keyboard.press("Escape");
  await t.noDialog("Esc closes the confirmation");
  check(gitDirHas(repo, "MERGE_HEAD"), "git: Esc did not abort the merge");

  // In the conflict tool pick a side, do not save, Esc: confirmation instead of silent loss.
  await conflictRow("README.md").click();
  await toolReady("README.md");
  await sideBox(0, "theirs").click();
  await eventually(() => saveButton().getAttribute("aria-disabled"), null, "a side is chosen");
  await sideBox(0, "theirs").focus();
  await page.keyboard.press("Escape");
  const asked = await t.waitFor(() => t.dialogTitle(), (title) => typeof title === "string" && title.length > 0, 4000);
  check(asked, "Esc with an unsaved solution: the app asks");
  if (asked) {
    const title = await t.dialogTitle();
    check(/without saving\?/.test(title ?? ""), `the confirmation names the file (${title})`);
    // The preselected answer is the one where nothing is lost – never "Discard solution".
    check(!/discard/i.test(await t.focusedText()), `the focus is not on "Discard solution" (${await t.focusedText()})`);
    await page.keyboard.press("Escape");
    await t.noDialog("Esc only closes the confirmation");
    equal((await t.view(repo.tabId)).center.kind, "conflict", "the tool is still open");
    equal(await sideBox(0, "theirs").getAttribute("aria-checked"), "true", "the choice is still there");
  }
  check(porcelain(repo).includes("UU README.md"), "git: the file is still in conflict, nothing was written");
  // Now really abort.
  await t.store("closeCenter", repo.tabId);
  const leave = page.getByRole("dialog").getByRole("button", { name: /Discard solution/ });
  if (await leave.count()) await leave.click();
  await commitPanelScreen().getByRole("button", { name: "Abort merge" }).click();
  await (await t.waitDialog(/^Abort merge\?$/)).getByRole("button", { name: "Abort merge" }).click();
  await t.waitToast(/Aborted the merge/, "success");
  equal(porcelain(repo), "", "git: clean after the abort");
  equal(head(repo), repo.mainBefore, "git: main unchanged");
  check(!gitDirHas(repo, "MERGE_HEAD"), "git: no merge open anymore");
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-E11", "Minimum window 960×600: banner, conflict list, \"Finish merge\" and conflict tool stay usable", async () => {
  const repo = conflictRepo("f07-e11", { second: true });
  startMergeOutside(repo);
  await t.open(repo);
  await eventually(() => t.conflictedCount(repo.repoId), 2, "two conflicts");
  await t.app.setSize(960, 600);
  try {
    await sleep(300);
    equal(await t.overflow().then((value) => value.x), 0, "960×600: no horizontal overflow");
    equal(await commitPanelScreen().evaluate((panel) => panel.scrollWidth - panel.clientWidth), 0, "960×600: the commit panel does not overflow");
    check(await t.inViewport(commitPanelScreen().getByRole("button", { name: "Abort merge" })), "960×600: \"Abort merge\" is visible");
    check(await t.inViewport(commitButton()), "960×600: \"Finish merge\" is visible");
    await conflictRow("README.md").scrollIntoViewIfNeeded();
    check(await t.inViewport(conflictRow("README.md")), "960×600: the conflict file is reachable");
    await conflictRow("README.md").click();
    await toolReady("README.md");
    equal(await t.overflow().then((value) => value.x), 0, "960×600 with conflict tool: no horizontal overflow");
    check(await t.inViewport(saveButton()), "960×600: \"Save\" in the conflict tool is visible");
    check(await t.inViewport(sideBox(0, "ours")), "960×600: the checkbox of the first conflict is visible");
    await sideBox(0, "ours").click();
    await saveButton().click();
    await eventually(() => t.conflictedCount(repo.repoId), 1, "960×600: saving resolves the file");
  } finally {
    await t.store("closeCenter", repo.tabId).catch(() => undefined);
    const leave = page.getByRole("dialog").getByRole("button", { name: /Discard solution/ });
    if (await leave.count().catch(() => 0)) await leave.click();
    await t.app.setSize(1440, 900);
  }
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-E12", "Screen reader: roles and names in the conflict state (banner, list, buttons, conflict tool), focus visible", async () => {
  const repo = conflictRepo("f07-e12");
  startMergeOutside(repo);
  await t.open(repo);
  await eventually(() => t.conflictedCount(repo.repoId), 1, "one conflict");
  equal(await commitPanelScreen().getByRole("alert").filter({ hasText: /Merge of/ }).count(), 1, "the banner with open conflicts has the role \"alert\"");
  equal(await commitPanelScreen().getAttribute("aria-label"), "Local changes", "the panel has a name");
  equal(await t.unnamedControls('[data-screen="commit-panel"]'), [], "commit panel: every control has an accessible name");
  const rowName = await conflictRow("README.md").evaluate((row) => `${row.getAttribute("role")}|${row.getAttribute("aria-label") ?? row.textContent}`);
  check(/README\.md/.test(rowName) && /both modified|conflict/i.test(rowName), `the conflict row names file and kind (${rowName})`);
  check(/^(option|treeitem|row|listitem)\|/.test(rowName), `the conflict row has a list role (${rowName})`);
  // Focus visible: only checked via keyboard (focus set by script shows no ring).
  // First a key without Alt/Ctrl so the browser assumes keyboard use (see F07-E12b).
  await page.keyboard.press("Tab");
  await page.keyboard.press("Alt+3");
  await t.pressUntil("Tab", (el) => Boolean(el?.closest('[data-section="conflicts"]')) && el.hasAttribute("data-row-key"), "Tab to the conflict list", 60);
  check((await t.focused()).visible, `focus on the conflict row is visible (${JSON.stringify(await t.focused())})`);
  await page.keyboard.press("Enter");
  await toolReady("README.md");
  equal(await conflictScreen().getAttribute("aria-label"), "Resolve conflict: README.md", "the conflict tool has the file name in its name");
  equal(await t.unnamedControls('[data-screen="conflict"]'), [], "conflict tool: every control has an accessible name");
  const boxLabel = await sideBox(0, "ours").getAttribute("aria-label");
  check(/Current \(main\)/.test(boxLabel ?? ""), `the checkbox names side and branch (${boxLabel})`);
  equal(await sideBox(0, "ours").getAttribute("role"), "checkbox", "it has the role \"checkbox\"");
  await page.keyboard.press("Alt+2");
  await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-conflict-head")), "0", "Alt+2 puts the focus on the checkbox of the first conflict");
  check((await t.focused()).visible, "focus on the checkbox is visible");
  equal(await saveButton().getAttribute("aria-disabled"), "true", "Save is disabled while the conflict is open – as aria-disabled, not only as a colour");
  await t.store("closeCenter", repo.tabId);
});

// BUG D-06: After a mouse click, Alt+3 (likewise Alt+1/Alt+2) puts the focus into the area but does not
// show it – the browser does not treat Alt keys as keyboard use, and the app does not force the ring.
await t.section(
  "F07-E12b",
  "Focus visible after mouse use: click in the graph, then Alt+3 – the conflict row shows the focus",
  async () => {
    const repo = conflictRepo("f07-e12b");
    startMergeOutside(repo);
    await t.open(repo);
    await eventually(() => t.conflictedCount(repo.repoId), 1, "one conflict");
    // Work with the mouse: click a commit, then back to the local changes (click the WIP row).
    await t.graphRow(repo.mainBefore).click();
    await page.locator('[data-screen="commit-graph"] [data-row-kind="wip"], [data-screen="commit-graph"] [data-row-id="wip"]').first().click().catch(() => t.store("selectWip", repo.tabId));
    await eventually(() => t.view(repo.tabId).then((view) => view.selection.kind), "wip", "the local changes are selected again");
    await conflictRow("README.md").waitFor({ timeout: 15_000 });
    await page.keyboard.press("Alt+3");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="right"]'))), true, "Alt+3 puts the focus into the commit panel");
    const where = await t.focused();
    if (!where.visible) await t.bugShot("D-06");
    check(where.visible, `after mouse click and Alt+3 the focus in the commit panel is visible (${JSON.stringify(where)})`);
    // Cross-check: the same row shows the ring once a key without Alt came first.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    check((await t.focused()).visible, `cross-check: after Tab and Shift+Tab the focus is visible (${JSON.stringify(await t.focused())})`);
  },
  { bug: "D-06" },
);

// ---------------------------------------------------------------------------------------------
await t.section("F07-N1", "Hook rejects: pre-merge-commit on a merge without conflict – one toast with the output, state is right", async () => {
  const repo = cleanMergeRepo("f07-n1");
  writeHook(repo, "pre-merge-commit", 'echo "Merge rejected: approval missing" >&2\nexit 1');
  await t.open(repo);
  await t.branchMenu("thema/sauber");
  await t.pick(/Merge “thema\/sauber” into “main”/);
  const toast = await t.anyToast(30_000);
  check(Boolean(toast) && toast.tone !== "success", `the rejected merge is not reported as success (${JSON.stringify(toast)})`);
  const all = (await t.toasts()).map((item) => item.text).join(" | ");
  check(/pre-merge-commit|Hook/i.test(all), `the toast names the hook (${all})`);
  const output = /approval missing/.test(all) || (await page.locator("[data-toast]").getByRole("button", { name: /Show output/ }).count()) > 0;
  check(output, "the hook output is shown or reachable via \"Show output\"");
  equal(head(repo), repo.mainBefore, "git: no merge commit was created");
  await t.comeBack();
  await t.refresh(repo.repoId);
  if (gitDirHas(repo, "MERGE_HEAD")) {
    // Git leaves the merge stopped: then the app must show it and offer to abort.
    equal(await t.operationKind(repo.repoId), "merge", "git stops the merge – the app shows \"merge in progress\"");
    await eventually(t.footer, (value) => /merge in progress/i.test(value), "status bar: \"merge in progress\"");
  } else {
    equal(await t.operationKind(repo.repoId), null, "no merge open – the app shows none either");
    equal(porcelain(repo), "", "git: working tree as before");
  }
});

await t.section("F07-N1b", "Hook rejects: commit-msg when finishing – one toast with the output, merge stays open, message stays", async () => {
  const repo = conflictRepo("f07-n1b");
  startMergeOutside(repo, { resolve: "theirs" });
  writeHook(repo, "commit-msg", 'echo "Message rejected: ticket number missing" >&2\nexit 1');
  await t.open(repo);
  await eventually(() => t.operationKind(repo.repoId), "merge", "the app shows the merge");
  await summary().fill("Thema zusammengeführt");
  await commitButton().click();
  const toast = await t.anyToast(30_000);
  check(Boolean(toast) && toast.tone !== "success", `the rejected finish is not reported as success (${JSON.stringify(toast)})`);
  const all = (await t.toasts()).map((item) => item.text).join(" | ");
  check(/commit-msg/.test(all), `the toast names the hook (${all})`);
  check(/ticket number missing/.test(all), "and its output");
  equal((await t.toasts()).length, 1, "there is exactly one toast");
  check(gitDirHas(repo, "MERGE_HEAD"), "git: the merge is still open");
  equal(head(repo), repo.mainBefore, "git: no commit was created");
  equal(await summary().inputValue(), "Thema zusammengeführt", "the message is still in the field");
  await eventually(() => t.operationKind(repo.repoId), "merge", "the app still shows the merge");
});

// BUG D-02: "Skip Git hooks" can be checked during a merge but has no effect when finishing –
// the hook still rejects, the merge cannot be finished in the app.
await t.section(
  "F07-N1c",
  "Hook rejects: with \"Skip Git hooks\" the merge can still be finished",
  async () => {
    const repo = conflictRepo("f07-n1c");
    startMergeOutside(repo, { resolve: "theirs" });
    writeHook(repo, "commit-msg", 'echo "Message rejected: ticket number missing" >&2\nexit 1');
    await t.open(repo);
    await eventually(() => t.operationKind(repo.repoId), "merge", "the app shows the merge");
    await summary().fill("Thema zusammengeführt");
    const skip = page.getByRole("checkbox", { name: /^Skip Git hooks/ });
    equal([await skip.isDisabled(), await skip.getAttribute("aria-checked")], [false, "false"], "the checkbox is usable and off during the merge");
    await skip.click();
    equal(await skip.getAttribute("aria-checked"), "true", "it is on now");
    try {
      await commitButton().click();
      const toast = await t.anyToast(30_000);
      if (toast?.tone !== "success") await t.bugShot("D-02");
      check(toast?.tone === "success" && /complete/.test(toast.text), `with "Skip Git hooks" the finish goes through (toast: ${JSON.stringify(toast)})`);
      equal(repo.git("log", "-1", "--format=%s"), "Thema zusammengeführt", "git: the merge commit was created");
      equal(parentsOf(repo), [repo.mainBefore, repo.side], "git: two parents");
    } finally {
      if ((await skip.getAttribute("aria-checked").catch(() => null)) === "true") await skip.click().catch(() => undefined);
    }
  },
  { bug: "D-02" },
);

// ---------------------------------------------------------------------------------------------
await t.section("F07-N2", "Locked: index.lock of another Git process – clear message, nothing changed, works afterwards", async () => {
  const repo = await t.open(cleanMergeRepo("f07-n2"));
  const lock = path.join(repo.path, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  await t.branchMenu("thema/sauber");
  await t.pick(/Merge “thema\/sauber” into “main”/);
  const toast = await t.anyToast(40_000);
  check(Boolean(toast) && (toast.tone === "danger" || toast.tone === "warning"), `an error toast appears (${JSON.stringify(toast)})`);
  check(/locked|lock|index\.lock|another git|another program|running/i.test(toast?.text ?? ""), `it explains the lock (${toast?.text})`);
  equal(head(repo), repo.mainBefore, "git: main unchanged");
  check(!gitDirHas(repo, "MERGE_HEAD"), "git: no half merge");
  fs.rmSync(lock, { force: true });
  await t.closeToasts();
  await t.refresh(repo.repoId);
  await t.branchMenu("thema/sauber");
  await t.pick(/Merge “thema\/sauber” into “main”/);
  await t.waitToast(/Merge complete/, "success");
  equal(parentsOf(repo), [repo.mainBefore, repo.side], "git: after removing the lock the merge goes through");
});

await t.section("F07-N2b", "No permission in the file system: a file the merge must write is locked exclusively", async () => {
  const repo = await t.open(cleanMergeRepo("f07-n2b"));
  const release = await lockFileExclusive(path.join(repo.path, "stationen.csv"));
  if (!release) {
    console.log("    (only testable on Windows – skipped)");
    return;
  }
  try {
    await t.branchMenu("thema/sauber");
    await t.pick(/Merge “thema\/sauber” into “main”/);
    const toast = await t.anyToast(90_000);
    check(Boolean(toast), "the app responds within 90 seconds (no hang)");
    check(toast?.tone !== "success" || head(repo) !== repo.mainBefore, `a failed merge is not reported as success (${JSON.stringify(toast)})`);
    if (toast?.tone !== "success") check((toast?.text ?? "").length > 40, `the toast explains something (${toast?.text})`);
  } finally {
    await release();
  }
  await t.closeToasts();
  // Afterwards the app must show what is really in the repository.
  await t.comeBack();
  await t.refresh(repo.repoId);
  const status = await t.cachedStatus(repo.repoId);
  const gitChanges = porcelain(repo).split("\n").filter(Boolean).length;
  equal(Boolean(status?.operation), gitDirHas(repo, "MERGE_HEAD"), "the app shows a running merge exactly when git has one");
  check(gitChanges === 0 || (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.conflicted.length ?? 0) > 0, `if git has changes (${gitChanges}), the app shows them too`);
  console.log(`    (state afterwards: HEAD ${head(repo) === repo.mainBefore ? "unchanged" : "moved"}, MERGE_HEAD ${gitDirHas(repo, "MERGE_HEAD")}, git status: ${JSON.stringify(porcelain(repo))})`);
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-N3", "Deleted ref: the branch disappears while its menu is open – clear message, nothing changed", async () => {
  const repo = await t.open(cleanMergeRepo("f07-n3"));
  await t.branchMenu("thema/sauber");
  repo.git("branch", "-D", "thema/sauber");
  await t.pick(/Merge “thema\/sauber” into “main”/);
  const toast = await t.anyToast(30_000);
  check(Boolean(toast) && toast.tone !== "success", `merging a deleted branch is not reported as success (${JSON.stringify(toast)})`);
  check(/thema\/sauber|does not exist|not found|no longer exists/i.test(toast?.text ?? ""), `the toast says the branch does not exist (anymore) (${toast?.text})`);
  check(!/fatal:|error:/.test(toast?.text ?? "") || (toast?.text ?? "").length > 60, "it is not just the raw Git output");
  equal(head(repo), repo.mainBefore, "git: main unchanged");
  check(!gitDirHas(repo, "MERGE_HEAD"), "git: no merge open");
  await t.closeToasts();
  // The left panel no longer shows the branch afterwards.
  await eventually(
    async () => {
      await t.comeBack();
      return t.branchRow("thema/sauber").count();
    },
    0,
    "the deleted branch disappears from the left panel",
    30_000,
  );
});

// ---------------------------------------------------------------------------------------------
await t.section("F07-N4", "Changes in the way: uncommitted change or untracked file that the merge would overwrite", async () => {
  const repo = cleanMergeRepo("f07-n4");
  const before = readFile(repo, "stationen.csv");
  repo.write("stationen.csv", `${before}X;Lokal geändert;1\n`);
  await t.open(repo);
  await t.branchMenu("thema/sauber");
  await t.pick(/Merge “thema\/sauber” into “main”/);
  // Either a toast or a dialog (e.g. offering a stash) – both explain which file is in the way.
  await sleep(500);
  const shown = async () => {
    const title = await t.dialogTitle();
    const body = title ? (await t.dialog().last().innerText()).replace(/\s+/g, " ") : "";
    return `${title ?? ""} ${body} ${(await t.toasts()).map((item) => item.text).join(" ")}`.trim();
  };
  /** The file is named in the toast – or at least behind "Show output". */
  const namesFile = async (text, file) => {
    if (text.includes(file)) return "toast";
    const more = page.locator("[data-toast]").getByRole("button", { name: /Show output/ });
    if (!(await more.count())) return null;
    await more.first().click();
    const found = await t.waitFor(async () => (await t.dialog().last().innerText()).includes(file), (value) => value === true, 5000);
    await page.keyboard.press("Escape");
    await t.noDialog("the output closes with Esc");
    return found ? "Show output" : null;
  };
  await eventually(async () => (await shown()).length > 0, true, "the app reacts with a toast or dialog", 30_000);
  const text = await shown();
  check(/commit or stash|stash/i.test(text), `the message says what to do (${text})`);
  check(!/complete/.test(text), "no success is reported");
  const where = await namesFile(text, "stationen.csv");
  check(where !== null, `the file in the way is named – in the toast or behind "Show output" (${text})`);
  console.log(`    (changed file in the way: named in "${where}")`);
  if (await t.dialogTitle()) await page.keyboard.press("Escape");
  equal(head(repo), repo.mainBefore, "git: main unchanged");
  check(!gitDirHas(repo, "MERGE_HEAD"), "git: no merge open");
  equal(readFile(repo, "stationen.csv"), `${before}X;Lokal geändert;1\n`, "file: the local change is untouched");
  await t.closeToasts();

  // Untracked file in the way: the topic branch creates the same file.
  repo.git("checkout", "--", "stationen.csv");
  repo.git("checkout", "-q", "thema/sauber");
  const side2 = commit(repo, "notiz.txt", "aus dem Thema\n", "Notiz im Thema");
  repo.git("checkout", "-q", "main");
  repo.write("notiz.txt", "lokal, unverfolgt\n");
  await t.comeBack();
  await t.refresh(repo.repoId);
  await t.branchMenu("thema/sauber");
  await t.pick(/Merge “thema\/sauber” into “main”/);
  await eventually(async () => (await shown()).length > 0, true, "untracked file: the app reacts", 30_000);
  const second = await shown();
  const whereSecond = await namesFile(second, "notiz.txt");
  check(whereSecond !== null, `untracked file: it is named – in the toast or behind "Show output" (${second})`);
  console.log(`    (untracked file in the way: named in "${whereSecond}")`);
  if (await t.dialogTitle()) await page.keyboard.press("Escape");
  equal(head(repo), repo.mainBefore, "untracked file: git – main unchanged");
  equal(readFile(repo, "notiz.txt"), "lokal, unverfolgt\n", "untracked file: it is untouched");
  check(head(repo, "thema/sauber") === side2, "the topic branch is unchanged");
});

// ---------------------------------------------------------------------------------------------
let restartBanner = null;
await t.section("F07-E10", "Restart the app mid-merge: tab, \"merge in progress\" and the half-resolved state are back; finishing works", async () => {
  const dataDir = t.makeDataDir();
  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const repo = await t.open(conflictRepo("f07-e10", { second: true }));
  await t.branchMenu("thema/konflikt");
  await t.pick(/Merge “thema\/konflikt” into “main”/);
  await t.waitToast(/Merge: conflict in 2 files/, "warning");
  await t.closeToasts();
  await conflictRow("README.md").click();
  await toolReady("README.md");
  await sideBox(0, "theirs").click();
  await saveButton().click();
  await eventually(() => t.conflictedCount(repo.repoId), 1, "one of two files is resolved");
  await sleep(500);

  // Restart with the same data directory.
  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const tabs = await t.app.invoke("tabs_list");
  const restored = tabs.find((tab) => tab.kind === "repo" && tab.repoId === repo.repoId);
  check(Boolean(restored), `the repository tab is back after the restart (${JSON.stringify(tabs.map((tab) => [tab.kind, tab.title ?? tab.repoId]))})`);
  await t.open(repo);
  await eventually(() => t.operationKind(repo.repoId), "merge", "after the restart: the app shows the running merge");
  await eventually(t.footer, (value) => /merge in progress/i.test(value), "status bar: \"merge in progress\"");
  await t.store("selectWip", repo.tabId);
  await mergeBanner().waitFor({ timeout: 15_000 });
  restartBanner = (await mergeBanner().innerText()).replace(/\s+/g, " ").trim();
  if (!/1 of 2 conflicts resolved/.test(restartBanner)) await t.bugShot("D-03");
  equal(await conflictRows(), ["stationen.csv"], "only the second file is still open");
  equal(readFile(repo, "README.md"), THEIRS, "the solution saved before the restart is there");
  await conflictRow("stationen.csv").getByRole("button", { name: /resolve conflict/i }).click();
  await page.getByRole("menuitem", { name: "Take current (main)" }).click();
  await eventually(() => t.conflictedCount(repo.repoId), 0, "second file resolved");
  await eventually(() => commitButton().getAttribute("aria-disabled"), null, "finishing is enabled");
  await commitButton().click();
  await t.waitToast(/complete/, "success");
  equal(parentsOf(repo), [repo.mainBefore, repo.side], "git: merge commit with both parents");
  equal(porcelain(repo), "", "git: clean");
  equal(branchOf(repo), "main", "git: main is checked out");
});

// BUG D-03: After the restart the banner no longer counts the already resolved conflicts
// ("0 of 1" instead of "1 of 2") – the number depends on session memory, not on the repository.
await t.section(
  "F07-E10b",
  "After the restart the banner still counts \"1 of 2 conflicts resolved\"",
  async () => {
    check(restartBanner !== null, "section F07-E10 ran up to the banner");
    check(/1 of 2 conflicts resolved/.test(restartBanner ?? ""), `banner after the restart: expected "1 of 2 conflicts resolved", got "${restartBanner}"`);
  },
  { bug: "D-03" },
);

await t.finish();
