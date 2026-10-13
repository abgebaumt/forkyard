/**
 * F11 – revert a commit and reset a branch. Real app, real fixture repositories, checked in the
 * repository itself with git.
 *
 *   node scripts/e2e/flows/D-F11.mjs                    everything
 *   node scripts/e2e/flows/D-F11.mjs --only F11-E3      only sections whose ID or title contains this (comma separates several)
 *   node scripts/e2e/flows/D-F11.mjs --show             visible window
 *
 * At the end comes the list of green and red sections. A red section with "BUG D-xx" is the test the
 * reported bug is fixed against.
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { branchOf, commit, createFlow, exists, gitDirHas, gitTry, head, parentsOf, porcelain, readFile, sleep } from "./D-lib.mjs";

const t = createFlow("D-F11");
const { check, equal, eventually } = t;

/** main with three local commits a, b, c on top of the pushed state. */
function historyRepo(name) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  repo.pushed = head(repo);
  repo.a = commit(repo, "a.txt", "a\n", "Erster lokaler Commit");
  repo.b = commit(repo, "b.txt", "b\n", "Zweiter lokaler Commit");
  repo.c = commit(repo, "c.txt", "c\n", "Dritter lokaler Commit");
  return repo;
}
/** X sets the line to "B", Y later to "C": a revert of X conflicts. */
function revertConflictRepo(name) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  commit(repo, "wert.txt", "Kopf\nWert: A\nFuß\n", "Wert angelegt");
  repo.x = commit(repo, "wert.txt", "Kopf\nWert: B\nFuß\n", "Wert auf B gesetzt");
  repo.y = commit(repo, "wert.txt", "Kopf\nWert: C\nFuß\n", "Wert auf C gesetzt");
  return repo;
}

await t.launch();
let page = t.page;
const press = (key) => page.keyboard.press(key);
const undoButton = () => t.toolButton("Undo");
const opBanner = (word) => page.locator('[data-screen="commit-panel"]').locator('[role="alert"], [role="status"]').filter({ hasText: new RegExp(word) }).first();
/** Keyboard focus on a commit's row in the graph: Alt+2, then arrow keys. */
const focusCommitByKeyboard = async (sha) => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await press("Alt+2");
  await press("Home");
  for (let step = 0; step < 40 && (await t.focused()).rowId !== sha; step++) await press("ArrowDown");
  return equal((await t.focused()).rowId, sha, "arrow keys reach the commit in the graph");
};
const waitHardDialog = () => t.waitDialog(/^Hard reset .+ to [0-9a-f]{7}\?$/);

// ---------------------------------------------------------------------------------------------
await t.section("F11-H3", "Happy path keyboard only: revert through the graph context menu, then Ctrl+Z", async () => {
  const repo = await t.open(historyRepo("f11-h3"));
  await focusCommitByKeyboard(repo.b);
  check((await t.focused()).visible, "the focus on the row is visible");
  await press("Shift+F10");
  await t.pickByKeyboard(/^Revert/);
  const toast = await t.waitToast(/Revert abgeschlossen/, "success");
  check((toast?.text ?? "").includes(repo.b.slice(0, 7)), `the toast names the reverted commit (${toast?.text})`);
  equal(repo.git("log", "-1", "--format=%s"), 'Revert "Zweiter lokaler Commit"', "git: a revert commit was created");
  equal(parentsOf(repo), [repo.c], "git: it sits on the previous tip");
  check(!exists(repo, "b.txt") && exists(repo, "a.txt") && exists(repo, "c.txt"), "files: only the commit's change is reverted");
  equal(porcelain(repo), "", "git: clean");
  await eventually(() => t.view(repo.tabId).then((view) => view.selection), { kind: "commits", shas: [head(repo)] }, "the revert commit is selected in the graph");
  await t.closeToasts();
  await page.evaluate(() => document.activeElement?.blur?.());
  await press("Control+z");
  await eventually(() => head(repo), repo.c, "Ctrl+Z undoes the revert (git)");
  check(exists(repo, "b.txt"), "file: b.txt is back");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-H4", "Happy path keyboard only: reset (mixed) through the submenu, then Ctrl+Z", async () => {
  const repo = await t.open(historyRepo("f11-h4"));
  await focusCommitByKeyboard(repo.a);
  await press("Shift+F10");
  await t.pickByKeyboard(/^Reset .+ to here/, { open: "ArrowRight" });
  await page.locator('[role="menu"]').nth(1).waitFor({ timeout: 5000 });
  await t.pickByKeyboard(/^Mixed/);
  await eventually(() => head(repo), repo.a, "mixed reset: main is at the selected commit (git)");
  const toast = await t.waitToast(/“main” is now at/, "success");
  check(/2 commits/.test(toast?.text ?? "") && /unstaged/.test(toast?.text ?? ""), `the toast says where the changes are (${toast?.text})`);
  equal(repo.git("diff", "--cached", "--name-only"), "", "git: nothing staged");
  equal(porcelain(repo).split("\n").sort(), ["?? b.txt", "?? c.txt"], "git: the changes of both commits are in the working tree");
  equal(branchOf(repo), "main", "git: main stays checked out");
  await t.closeToasts();
  await page.evaluate(() => document.activeElement?.blur?.());
  await press("Control+z");
  await eventually(() => head(repo), repo.c, "Ctrl+Z undoes the reset (git)");
  await eventually(() => porcelain(repo), "", "and the working tree is clean again");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E2", "Revert of a merge commit: takes back the merged-in changes (first parent stays)", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f11-e2" }));
  repo.git("checkout", "-q", "-b", "thema/zusatz");
  commit(repo, "zusatz.txt", "aus dem Thema\n", "Zusatz im Thema");
  repo.git("checkout", "-q", "main");
  commit(repo, "haupt.txt", "auf main\n", "Arbeit auf main");
  repo.git("merge", "-q", "--no-ff", "-m", "Merge branch 'thema/zusatz'", "thema/zusatz");
  const merge = head(repo);
  const after = commit(repo, "danach.txt", "danach\n", "Arbeit nach dem Merge");
  await t.open(repo);
  await t.commitMenu(repo, merge);
  const item = (await t.menuItems()).find((entry) => entry.text.startsWith("Revert"));
  check(Boolean(item) && !item.disabled, `revert is possible for the merge commit (${JSON.stringify(item)})`);
  await t.pick(/^Revert/);
  await t.waitToast(/Revert abgeschlossen/, "success");
  equal(repo.git("log", "-1", "--format=%s"), "Revert \"Merge branch 'thema/zusatz'\"", "git: revert commit of the merge");
  equal(parentsOf(repo), [after], "git: an ordinary commit on the previous tip");
  check(!exists(repo, "zusatz.txt"), "file: the merged-in change is gone");
  check(exists(repo, "haupt.txt") && exists(repo, "danach.txt"), "files: the work on main and afterwards stays");
  equal(porcelain(repo), "", "git: clean");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available");
  await undoButton().click();
  await eventually(() => head(repo), after, "Undo takes back the revert of the merge");
  check(exists(repo, "zusatz.txt"), "file: zusatz.txt is back");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E3", "Revert with conflict: WIP view, conflict tool, \"Continue revert\"; second attempt: abort", async () => {
  const repo = await t.open(revertConflictRepo("f11-e3"));
  await t.commitMenu(repo, repo.x);
  await t.pick(/^Revert/);
  const toast = await t.waitToast(/Revert: conflict in one file/, "warning");
  check(/then continue the revert – or abort it/.test(toast?.text ?? ""), `the toast says how to go on (${toast?.text})`);
  check(gitDirHas(repo, "REVERT_HEAD"), "git: the revert is in progress (REVERT_HEAD)");
  await eventually(() => t.view(repo.tabId).then((view) => view.selection.kind), "wip", "the view jumps to the local changes");
  await opBanner("Revert").waitFor({ timeout: 15_000 });
  const banner = (await opBanner("Revert").innerText()).replace(/\s+/g, " ");
  check(/Wert auf B gesetzt|[0-9a-f]{7}/.test(banner), `the banner names the commit being reverted (${banner})`);
  await eventually(t.footer, (value) => /revert in progress/.test(value), "status bar: \"revert in progress\"");
  for (const name of ["Pull", "Push", "Branch"]) check((await t.toolButton(name).getAttribute("aria-disabled")) === "true", `${name} is locked during the revert`);
  await t.closeToasts();

  // In the conflict tool: keep the current side (Wert: C).
  await page.locator('[data-section="conflicts"] [data-row-key="wert.txt"]').click();
  await page.waitForFunction(() => document.querySelector('[data-screen="conflict"]')?.getAttribute("aria-label") === "Resolve conflict: wert.txt" && document.querySelector('[data-screen="conflict"]')?.getAttribute("data-conflict-state") !== "loading", null, { timeout: 60_000 });
  const ours = page.locator('[data-screen="conflict"] [data-sides] [data-conflict-head="0"][data-side="ours"]');
  const theirs = page.locator('[data-screen="conflict"] [data-sides] [data-conflict-head="0"][data-side="theirs"]');
  const labels = [await ours.getAttribute("aria-label"), await theirs.getAttribute("aria-label")];
  check(labels.every((label) => (label ?? "").length > 10) && labels[0] !== labels[1], `both sides have their own meaningful names (${JSON.stringify(labels)})`);
  check(!labels.some((label) => /undefined|null/.test(label ?? "")), "no \"undefined\" in the side names");
  await ours.click();
  await page.locator('[data-screen="conflict"] button[data-action="save"]').click();
  await eventually(() => t.conflictedCount(repo.repoId), 0, "the conflict is resolved");
  await opBanner("Revert").getByRole("button", { name: "Continue revert" }).click();
  await eventually(() => gitDirHas(repo, "REVERT_HEAD"), false, "git: the revert is done", 30_000);
  const done = await t.anyToast(15_000);
  check(done?.tone !== "danger", `no error toast when continuing (${JSON.stringify(done)})`);
  equal(readFile(repo, "wert.txt"), "Kopf\nWert: C\nFuß\n", "file: the chosen version");
  equal(porcelain(repo), "", "git: clean");
  // The "keep everything as is" resolution yields no content change: Git then creates no commit or an empty one.
  const subject = repo.git("log", "-1", "--format=%s");
  check(head(repo) === repo.y || /^Revert "Wert auf B gesetzt"/.test(subject), `git: HEAD is the old tip or the revert commit (${subject})`);
  await eventually(t.footer, (value) => !/revert in progress/.test(value), "status bar: no revert anymore");
  await t.closeToasts();

  // Second attempt in a fresh repository: aborting restores everything.
  const second = await t.open(revertConflictRepo("f11-e3-abbruch"));
  await t.commitMenu(second, second.x);
  await t.pick(/^Revert/);
  await t.waitToast(/Revert: conflict in one file/, "warning");
  await opBanner("Revert").waitFor({ timeout: 15_000 });
  await t.closeToasts();
  await opBanner("Revert").getByRole("button", { name: "Abort revert" }).click();
  await t.waitDialog(/^Abort revert\?$/);
  equal(await t.focusedText(), "Cancel", "confirmation: focus on \"Cancel\"");
  await press("Escape");
  await t.noDialog("Esc closes the confirmation");
  check(gitDirHas(second, "REVERT_HEAD"), "git: Esc did not abort the revert");
  await opBanner("Revert").getByRole("button", { name: "Abort revert" }).click();
  await (await t.waitDialog(/^Abort revert\?$/)).getByRole("button", { name: "Abort revert" }).click();
  await t.waitToast(/Aborted the revert/, "success");
  check(!gitDirHas(second, "REVERT_HEAD"), "git: no revert open anymore");
  equal(head(second), second.y, "git: HEAD unchanged");
  equal(porcelain(second), "", "git: clean");
  equal(readFile(second, "wert.txt"), "Kopf\nWert: C\nFuß\n", "file as before");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E3b", "Revert with conflict: taking the incoming side yields the revert commit with the old content", async () => {
  const repo = await t.open(revertConflictRepo("f11-e3b"));
  await t.commitMenu(repo, repo.x);
  await t.pick(/^Revert/);
  await t.waitToast(/Revert: conflict in one file/, "warning");
  await opBanner("Revert").waitFor({ timeout: 15_000 });
  await t.closeToasts();
  await page.locator('[data-section="conflicts"] [data-row-key="wert.txt"]').getByRole("button", { name: /resolve conflict/ }).click();
  const takeTheirs = page.getByRole("menuitem", { name: /^Take incoming/ });
  await takeTheirs.waitFor({ timeout: 5000 });
  await takeTheirs.click();
  await eventually(() => t.conflictedCount(repo.repoId), 0, "the conflict is resolved");
  equal(readFile(repo, "wert.txt"), "Kopf\nWert: A\nFuß\n", "file: the state before the reverted commit");
  await opBanner("Revert").getByRole("button", { name: "Continue revert" }).click();
  await eventually(() => gitDirHas(repo, "REVERT_HEAD"), false, "git: the revert is done", 30_000);
  await t.waitToast(/complete/, "success");
  equal(repo.git("log", "-1", "--format=%s"), 'Revert "Wert auf B gesetzt"', "git: the revert commit was created");
  equal(parentsOf(repo), [repo.y], "git: on the previous tip");
  equal(repo.git("show", "HEAD:wert.txt"), "Kopf\nWert: A\nFuß", "git: with the chosen content");
  equal(porcelain(repo), "", "git: clean");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available");
  await undoButton().click();
  await eventually(() => head(repo), repo.y, "Undo takes back the revert");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E4", "Nothing to revert: the commit's change is long gone – notice instead of an empty commit", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f11-e4" }));
  const x = commit(repo, "zusatz.txt", "kommt und geht\n", "Zusatz angelegt");
  fs.rmSync(path.join(repo.path, "zusatz.txt"));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Zusatz wieder entfernt");
  const tip = head(repo);
  await t.open(repo);
  await t.commitMenu(repo, x);
  await t.pick(/^Revert/);
  const toast = await t.anyToast(30_000);
  check(toast?.tone === "info" && /Nothing to revert/.test(toast.text), `notice "Nothing to revert" (${JSON.stringify(toast)})`);
  equal(head(repo), tip, "git: no new commit");
  check(!gitDirHas(repo, "REVERT_HEAD"), "git: no dangling revert");
  equal(porcelain(repo), "", "git: clean");
  await t.comeBack();
  equal(await t.operationKind(repo.repoId), null, "the app shows no running operation");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E5", "Double-click on \"Hard reset\": exactly one reset, one undo restores everything", async () => {
  const repo = historyRepo("f11-e5");
  repo.write("a.txt", "a\nungesichert\n");
  await t.open(repo);
  await t.commitMenu(repo, repo.a);
  await t.pick(/^Hard/, /^Reset .+ to here/);
  const dialog = await waitHardDialog();
  equal(await t.focusedText(), "Cancel", "confirmation: focus on \"Cancel\"");
  await dialog.getByRole("button", { name: "Hard reset" }).dblclick();
  await eventually(() => head(repo), repo.a, "hard reset: main is at the selected commit");
  await t.waitToast(/is now at/, "success");
  await sleep(1200);
  equal(await t.dangerToasts(), [], "no error toast from the second click");
  equal(await page.locator('[role="dialog"], [role="alertdialog"]').count(), 0, "no dialog stays open");
  equal(readFile(repo, "a.txt"), "a\n", "file: the uncommitted change is discarded");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available");
  await undoButton().click();
  await eventually(() => head(repo), repo.c, "a single undo restores the old tip");
  await eventually(() => readFile(repo, "a.txt"), "a\nungesichert\n", "and the uncommitted change");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E6", "Hard reset with staged, unstaged and untracked files: the confirmation names them, undo restores every state", async () => {
  const repo = historyRepo("f11-e6");
  repo.write("a.txt", "a\ngestaged geändert\n");
  repo.write("neu.txt", "neu und gestaged\n");
  repo.git("add", "a.txt", "neu.txt");
  repo.write("b.txt", "b\nnicht gestaged geändert\n");
  repo.write("frei.txt", "unverfolgt\n");
  const before = porcelain(repo);
  equal(before.split("\n").sort(), [" M b.txt", "?? frei.txt", "A  neu.txt", "M  a.txt"], "starting point: staged, unstaged, new, untracked");
  await t.open(repo);
  await t.commitMenu(repo, repo.a);
  await t.pick(/^Hard/, /^Reset .+ to here/);
  const dialog = await waitHardDialog();
  const text = (await dialog.innerText()).replace(/\s+/g, " ");
  check(/2 commits disappear/.test(text), `the confirmation names the number of commits (${text})`);
  check(/Uncommitted changes to 3 files/.test(text) && ["a.txt", "b.txt", "neu.txt"].every((file) => text.includes(file)), "it names the three files with uncommitted changes");
  check(/Untracked files stay where they are/.test(text), "and says that untracked files stay");
  await dialog.getByRole("button", { name: "Hard reset" }).click();
  await eventually(() => head(repo), repo.a, "hard reset: main is at the selected commit");
  await t.waitToast(/is now at/, "success");
  equal(porcelain(repo), "?? frei.txt", "git: only the untracked file is still there");
  equal(readFile(repo, "frei.txt"), "unverfolgt\n", "file: frei.txt untouched");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available");
  await undoButton().click();
  await eventually(() => head(repo), repo.c, "Undo: old tip");
  await eventually(() => porcelain(repo).split("\n").sort(), [" M b.txt", "?? frei.txt", "A  neu.txt", "M  a.txt"], "Undo: staged stays staged, unstaged stays unstaged, untracked stays untracked");
  equal([readFile(repo, "a.txt"), readFile(repo, "b.txt"), readFile(repo, "neu.txt"), readFile(repo, "frei.txt")], ["a\ngestaged geändert\n", "b\nnicht gestaged geändert\n", "neu und gestaged\n", "unverfolgt\n"], "files: contents as before the reset");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E7", "Changed from outside: while the confirmation is open, a commit is added in the terminal – it is not lost", async () => {
  const repo = await t.open(historyRepo("f11-e7"));
  // A late toast of the previous section ("Undone") must not count as the answer here.
  await sleep(600);
  await t.closeToasts();
  await t.commitMenu(repo, repo.b);
  await t.pick(/^Hard/, /^Reset .+ to here/);
  const dialog = await waitHardDialog();
  check(/1 commit disappears/.test((await dialog.innerText()).replace(/\s+/g, " ")), "the confirmation names one commit");
  const outside = commit(repo, "d.txt", "d\n", "Im Terminal dazugekommen");
  await dialog.getByRole("button", { name: "Hard reset" }).click();
  const toast = await t.anyToast(30_000);
  check(Boolean(toast), "the app reports back");
  await sleep(500);
  if (head(repo) === outside) {
    check(toast.tone !== "success", `rejected because the state changed – then without a success toast (${JSON.stringify(toast)})`);
  } else {
    equal(head(repo), repo.b, "git: reset to the selected commit");
    // The confirmation spoke of one commit, two disappeared: Undo must bring both back.
    await t.closeToasts();
    await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available");
    await undoButton().click();
    await eventually(() => head(repo), outside, "Undo also brings back the commit created in the terminal");
  }
  check(repo.git("branch", "--contains", outside).includes("main"), "git: the terminal commit ends up on main");
  check(exists(repo, "d.txt"), "file: d.txt is there");
});

// ---------------------------------------------------------------------------------------------
const LONG_SUMMARY = `Messreihe 🚀 neu berechnet – ${"Größen, Maße, Übergänge äöüß „Zitat“ 测试 ".repeat(13)}Ende`;
await t.section("F11-E9", "Emoji, umlauts and 500 characters in the message: revert, hard reset confirmation at 960×600, roles and names", async () => {
  check([...LONG_SUMMARY].length >= 500, `the message has at least 500 characters (${[...LONG_SUMMARY].length})`);
  const repo = t.made(makeCleanRepoWithRemote({ name: "f11-e9" }));
  const base = head(repo);
  const long = commit(repo, "reihe 🚀 äöü.txt", "Werte\n", LONG_SUMMARY);
  commit(repo, "danach.txt", "danach\n", "Danach");
  await t.open(repo);
  await t.commitMenu(repo, long);
  await t.pick(/^Revert/);
  await t.waitToast(/Revert abgeschlossen/, "success");
  equal(repo.git("log", "-1", "--format=%s"), `Revert "${LONG_SUMMARY}"`, "git: revert commit with the complete message");
  check(!exists(repo, "reihe 🚀 äöü.txt"), "file with emoji and umlauts is reverted");
  equal(await t.overflow().then((value) => value.x), 0, "the long message does not break the graph");
  await t.closeToasts();

  await t.app.setSize(960, 600);
  try {
    repo.write("danach.txt", "danach\nungesichert\n");
    await t.comeBack();
    await t.refresh(repo.repoId);
    await t.commitMenu(repo, base);
    // At 960×600 the submenu opens to the left: menu and submenu must be fully inside the window.
    // Picked with arrow keys (a mouse pointer that jumps into the submenu without a path closes it).
    await t.pickByKeyboard(/^Reset .+ to here/, { open: "ArrowRight" });
    await page.locator('[role="menu"]').nth(1).waitFor({ timeout: 5000 });
    const menus = await page.locator('[role="menu"]').evaluateAll((list) => list.map((menu) => menu.getBoundingClientRect().toJSON()));
    check(menus.every((box) => box.left >= -4 && box.top >= 0 && box.right <= 964 && box.bottom <= 600), `960×600: menu and submenu are inside the window (${JSON.stringify(menus.map((box) => [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)]))})`);
    await t.pickByKeyboard(/^Hard/);
    const dialog = await waitHardDialog();
    equal(await page.getByRole("dialog", { name: /^Hard reset .+ to [0-9a-f]{7}\?/ }).count(), 1, "the confirmation is a dialog named by its title");
    check(/3 commits disappear/.test((await dialog.innerText()).replace(/\s+/g, " ")), "it names three commits");
    equal(await t.overflow().then((value) => value.x), 0, "960×600: no horizontal overflow");
    check(await t.inViewport(dialog), "960×600: the confirmation is fully inside the window");
    check(await t.inViewport(dialog.getByRole("button", { name: "Hard reset" })), "960×600: \"Hard reset\" is visible");
    check(await t.inViewport(dialog.getByRole("button", { name: "Cancel" })), "960×600: \"Cancel\" is visible");
    equal(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth), 0, "960×600: the confirmation does not overflow sideways");
    equal(await t.unnamedControls('[role="dialog"]'), [], "every control of the confirmation has a name");
    const focus = await t.focused();
    equal(focus.text, "Cancel", "focus on \"Cancel\"");
    await press("Tab");
    check((await t.focused()).visible, "the focus on \"Hard reset\" is visible");
    await press("Escape");
    await t.noDialog("Esc closes the confirmation");
    equal(readFile(repo, "danach.txt"), "danach\nungesichert\n", "Esc: nothing discarded");
  } finally {
    await t.app.setSize(1440, 900);
  }
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E11", "Detached HEAD: \"Reset HEAD to here\" (soft) moves only HEAD, the branch stays", async () => {
  const repo = historyRepo("f11-e11");
  repo.git("checkout", "-q", "--detach", repo.c);
  await t.open(repo);
  await t.commitMenu(repo, repo.a);
  const item = (await t.menuItems()).find((entry) => /^Reset .+ to here/.test(entry.text));
  check(/^Reset HEAD to here/.test(item?.text ?? ""), `with a detached HEAD the entry is called \"Reset HEAD to here\" (${item?.text})`);
  await t.pick(/^Soft/, /^Reset .+ to here/);
  await eventually(() => head(repo), repo.a, "soft reset: HEAD is at the selected commit");
  await t.waitToast(/HEAD is now at/, "success");
  check(!gitTry(repo, ["symbolic-ref", "-q", "HEAD"]).ok, "git: HEAD is still detached");
  equal(head(repo, "main"), repo.c, "git: main is unchanged");
  equal(repo.git("diff", "--cached", "--name-only").split("\n").sort(), ["b.txt", "c.txt"], "git: the changes are staged");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available");
  await undoButton().click();
  await eventually(() => head(repo), repo.c, "Undo: HEAD is back on the old commit");
  await eventually(() => porcelain(repo), "", "and nothing is staged anymore");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-N2", "Locked: index.lock of another Git process during reset – clear message, nothing changed", async () => {
  const repo = await t.open(historyRepo("f11-n2"));
  const lock = path.join(repo.path, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  try {
    await t.commitMenu(repo, repo.a);
    await t.pick(/^Mixed/, /^Reset .+ to here/);
    const toast = await t.anyToast(40_000);
    check(Boolean(toast) && (toast.tone === "danger" || toast.tone === "warning"), `an error toast appears (${JSON.stringify(toast)})`);
    check(/locked|lock|index\.lock|another (Git|program)|in progress/i.test(toast?.text ?? ""), `it explains the lock (${toast?.text})`);
    equal(head(repo), repo.c, "git: main unchanged");
  } finally {
    fs.rmSync(lock, { force: true });
  }
  equal(porcelain(repo), "", "git: clean");
  await t.closeToasts();
  await t.refresh(repo.repoId);
  equal(await undoButton().getAttribute("aria-label").then((label) => /Reset/.test(label ?? "")), false, "the failed reset is not offered as an undoable action");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-N3", "Deleted commit: the commit disappears (reset and gc in the terminal) while its menu is open", async () => {
  const repo = await t.open(historyRepo("f11-n3"));
  await t.commitMenu(repo, repo.c);
  repo.git("reset", "-q", "--hard", repo.b);
  repo.git("reflog", "expire", "--expire=now", "--all");
  repo.git("gc", "-q", "--prune=now");
  check(!gitTry(repo, ["cat-file", "-e", `${repo.c}^{commit}`]).ok, "starting point: the commit no longer exists in the repository");
  await t.pick(/^Revert/);
  const toast = await t.anyToast(30_000);
  check(Boolean(toast) && toast.tone !== "success", `no success for a commit that no longer exists (${JSON.stringify(toast)})`);
  check(/does not exist|no longer exists|not found|unknown/i.test(toast?.text ?? ""), `the toast says the commit does not exist (anymore) (${toast?.text})`);
  equal(head(repo), repo.b, "git: HEAD unchanged");
  check(!gitDirHas(repo, "REVERT_HEAD"), "git: no revert open");
  equal(porcelain(repo), "", "git: clean");
  // Afterwards the graph no longer shows the vanished commit.
  await t.closeToasts();
  await eventually(
    async () => {
      await t.comeBack();
      return t.graphRow(repo.c).count();
    },
    0,
    "the vanished commit is no longer in the graph",
    30_000,
  );
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-N4", "Changes in the way: revert of a commit whose file has uncommitted changes – rejected, change stays", async () => {
  const repo = historyRepo("f11-n4");
  repo.write("b.txt", "b\nlokal weitergeschrieben\n");
  await t.open(repo);
  await t.commitMenu(repo, repo.b);
  await t.pick(/^Revert/);
  await sleep(500);
  const title = await t.dialogTitle();
  const body = title ? (await t.dialog().last().innerText()).replace(/\s+/g, " ") : "";
  const toast = title ? null : await t.anyToast(30_000);
  const text = `${title ?? ""} ${body} ${toast?.text ?? ""}`;
  check(/commit or stash|stash|changes/i.test(text), `the app says that uncommitted changes are in the way (${text})`);
  check(!/complete/.test(text), "no success is reported");
  if (title) await press("Escape");
  equal(head(repo), repo.c, "git: HEAD unchanged");
  check(!gitDirHas(repo, "REVERT_HEAD"), "git: no revert open");
  equal(readFile(repo, "b.txt"), "b\nlokal weitergeschrieben\n", "file: the local change is untouched");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-E8", "Restart the app in the middle of a revert conflict: \"revert in progress\" is back, abort restores everything", async () => {
  const dataDir = t.makeDataDir();
  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const repo = await t.open(revertConflictRepo("f11-e8"));
  await t.commitMenu(repo, repo.x);
  await t.pick(/^Revert/);
  await t.waitToast(/Revert: conflict in one file/, "warning");
  await opBanner("Revert").waitFor({ timeout: 15_000 });
  const bannerBefore = (await opBanner("Revert").innerText()).replace(/\s+/g, " ");
  await sleep(500);

  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const tabs = await t.app.invoke("tabs_list");
  check(tabs.some((tab) => tab.kind === "repo" && tab.repoId === repo.repoId), "the repository's tab is back after the restart");
  await t.open(repo);
  await eventually(() => t.operationKind(repo.repoId), "revert", "after the restart: the app shows the running revert");
  await eventually(t.footer, (value) => /revert in progress/.test(value), "status bar: \"revert in progress\"");
  await t.store("selectWip", repo.tabId);
  await opBanner("Revert").waitFor({ timeout: 15_000 });
  const bannerAfter = (await opBanner("Revert").innerText()).replace(/\s+/g, " ");
  equal(bannerAfter.split(" conflict")[0].replace(/\d+ of \d+$/, "").trim(), bannerBefore.split(" conflict")[0].replace(/\d+ of \d+$/, "").trim(), "the banner names the same operation as before the restart");
  equal(await t.conflictedCount(repo.repoId), 1, "with the open conflict");
  await opBanner("Revert").getByRole("button", { name: "Abort revert" }).click();
  await (await t.waitDialog(/^Abort revert\?$/)).getByRole("button", { name: "Abort revert" }).click();
  await t.waitToast(/Aborted the revert/, "success");
  check(!gitDirHas(repo, "REVERT_HEAD"), "git: no revert open anymore");
  equal(head(repo), repo.y, "git: HEAD unchanged");
  equal(porcelain(repo), "", "git: clean");
});

// ---------------------------------------------------------------------------------------------
await t.section("F11-N5", "No author set: revert is rejected with the way to the profile, nothing is left half-done", async () => {
  await t.close();
  await t.launch({ gitIdentity: null });
  page = t.page;
  const repo = historyRepo("f11-n5");
  // The fixture stores the identity in .git/config; without it there is no author there nor globally.
  repo.git("config", "--unset", "user.name");
  repo.git("config", "--unset", "user.email");
  await t.open(repo);
  await t.commitMenu(repo, repo.b);
  await t.pick(/^Revert/);
  await sleep(500);
  const title = await t.dialogTitle();
  const body = title ? (await t.dialog().last().innerText()).replace(/\s+/g, " ") : "";
  const toast = title ? null : await t.anyToast(30_000);
  const text = `${title ?? ""} ${body} ${toast?.text ?? ""}`;
  check(/author|name|email|identity|profile/i.test(text), `the app says that name and email are missing (${text})`);
  check(!/complete/.test(text), "no success is reported");
  check(/Profile|Settings/i.test(text) || (await page.locator("[data-toast]").getByRole("button").count()) > 1, `it shows the way to the profile (${text})`);
  if (title) await press("Escape");
  equal(head(repo), repo.c, "git: HEAD unchanged");
  check(!gitDirHas(repo, "REVERT_HEAD"), "git: no revert open");
  equal(porcelain(repo), "", "git: nothing is left staged");
});

await t.finish();
