/**
 * F13 – transfer commits (cherry-pick) or squash them. Real app, real fixture repositories, checked
 * in the repository itself with git.
 *
 *   node scripts/e2e/flows/D-F13.mjs                    everything
 *   node scripts/e2e/flows/D-F13.mjs --only F13-E3      only sections whose ID or title contains this (comma separates several)
 *   node scripts/e2e/flows/D-F13.mjs --show             visible window
 *
 * At the end comes the list of green and red sections. A red section with "BUG D-xx" is the test the
 * reported bug is fixed against.
 */
import { makeCleanRepoWithRemote, makeEmptyRepo } from "../fixtures.mjs";
import { branchOf, commit, createFlow, exists, gitDirHas, gitTry, head, parentsOf, porcelain, readFile, sleep, subjects } from "./D-lib.mjs";

const t = createFlow("D-F13");
const { check, equal, eventually } = t;
const rebaseScreen = '[data-screen="rebase"]';
const JONAS = { GIT_AUTHOR_NAME: "Jonas Albrecht", GIT_AUTHOR_EMAIL: "jonas.albrecht@wetterstation.example" };

/** "thema/quelle" with k1 (x.txt), k2 (README, conflicts with main), k3 (y.txt); main changed README differently. */
function pickRepo(name) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  repo.git("checkout", "-q", "-b", "thema/quelle");
  repo.k1 = commit(repo, "x.txt", "x\n", "Datei x angelegt");
  repo.k2 = commit(repo, "README.md", "# Messnetz\n\nAuswertung der Stationen aus dem Thema-Branch.\n", "README aus dem Thema");
  repo.k3 = commit(repo, "y.txt", "y\n", "Datei y angelegt");
  repo.git("checkout", "-q", "main");
  repo.mainBefore = commit(repo, "README.md", "# Messnetz\n\nAuswertung der Stationen, Fassung main.\n", "README auf main");
  return repo;
}
/** main with four local commits s1, s2, s3 (all on auswertung.md) and "Notiz danach". */
function squashRepo(name, { push = false } = {}) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  repo.base = head(repo);
  repo.s1 = commit(repo, "auswertung.md", "# Auswertung\n", "Auswertung begonnen");
  repo.s2 = commit(repo, "auswertung.md", "# Auswertung\n\nTagesmittel\n", "Tagesmittel ergänzt");
  repo.s3 = commit(repo, "auswertung.md", "# Auswertung\n\nTagesmittel\nMonatsmittel\n", "Monatsmittel ergänzt");
  repo.later = commit(repo, "notiz.txt", "danach\n", "Notiz danach");
  if (push) repo.git("push", "-q", "origin", "main");
  return repo;
}

await t.launch();
let page = t.page;
const press = (key) => page.keyboard.press(key);
const undoButton = () => t.toolButton("Undo");
const opBanner = (word) => page.locator('[data-screen="commit-panel"]').locator('[role="alert"], [role="status"]').filter({ hasText: new RegExp(word) }).first();
const startButton = () => page.locator(`${rebaseScreen} button[data-action="start"]`);
const listRows = () =>
  page.locator(`${rebaseScreen} [role="option"]`).evaluateAll((list) => list.map((row) => ({ index: Number(row.dataset.index), sha: row.dataset.rowSha, summary: row.querySelector("[data-summary]")?.textContent ?? "" })).sort((a, b) => a.index - b.index));
const waitList = async (count) => {
  await page.locator(`${rebaseScreen} [role="listbox"]`).waitFor({ timeout: 30_000 });
  await eventually(async () => (await listRows()).length, count, `the list shows ${count} commits`);
};
const statePanel = () => page.locator(`${rebaseScreen} [data-state-panel]`).getAttribute("data-state-panel", { timeout: 2000 }).catch(() => null);
const centerKind = async (repo) => (await t.view(repo.tabId)).center.kind;
const focusCommitByKeyboard = async (sha) => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await press("Alt+2");
  await press("Home");
  for (let step = 0; step < 40 && (await t.focused()).rowId !== sha; step++) await press("ArrowDown");
  return equal((await t.focused()).rowId, sha, "arrow keys reach the commit in the graph");
};
/** Select three commits in the graph (click, Ctrl+click) and open the tool through the context menu. */
const openPickTool = async (repo) => {
  await t.store("revealCommit", repo.tabId, repo.k1);
  await t.graphRow(repo.k1).click();
  await t.graphRow(repo.k2).click({ modifiers: ["Control"] });
  await t.graphRow(repo.k3).click({ modifiers: ["Control"] });
  await t.graphRow(repo.k3).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Cherry-pick 3 commits/ }).click();
  await waitList(3);
};
const openSquashTool = async (repo, shas) => {
  await t.store("openRebase", repo.tabId, "", "squash", shas);
  await waitList(shas.length);
};

// ---------------------------------------------------------------------------------------------
await t.section("F13-H3", "Happy path keyboard only: single cherry-pick through the graph context menu, then Ctrl+Z", async () => {
  const repo = await t.open(pickRepo("f13-h3"));
  await focusCommitByKeyboard(repo.k1);
  await press("Shift+F10");
  await t.pickByKeyboard(/^Cherry-pick/);
  await t.waitToast(/Cherry-pick complete/, "success");
  equal(repo.git("log", "-1", "--format=%s"), "Datei x angelegt", "git: the commit is transferred");
  equal(parentsOf(repo), [repo.mainBefore], "git: on the previous tip of main");
  check(exists(repo, "x.txt"), "file: x.txt is there");
  equal(head(repo, "thema/quelle"), repo.k3, "git: the source branch is unchanged");
  equal(porcelain(repo), "", "git: clean");
  await eventually(() => t.view(repo.tabId).then((view) => view.selection), { kind: "commits", shas: [head(repo)] }, "the new commit is selected in the graph");
  await t.closeToasts();
  await page.evaluate(() => document.activeElement?.blur?.());
  await press("Control+z");
  await eventually(() => head(repo), repo.mainBefore, "Ctrl+Z undoes the cherry-pick (git)");
  check(!exists(repo, "x.txt"), "file: x.txt is gone again");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-H4", "Happy path keyboard only: select three commits (Shift+↓), squash, type message, start, Ctrl+Z", async () => {
  const repo = await t.open(squashRepo("f13-h4"));
  await focusCommitByKeyboard(repo.s3);
  await press("Shift+ArrowDown");
  await press("Shift+ArrowDown");
  await eventually(() => t.view(repo.tabId).then((view) => (view.selection.shas ?? []).length), 3, "Shift+↓ selects three commits");
  await press("Shift+F10");
  await t.pickByKeyboard(/Squash 3 commits/);
  await waitList(3);
  equal((await listRows()).map((row) => row.sha), [repo.s1, repo.s2, repo.s3], "preview: oldest at the top");
  await t.pressUntil("Tab", (el) => (el?.labels?.[0]?.textContent ?? el?.getAttribute("aria-label") ?? "").trim() === "Summary", "Tab to the summary", 30);
  check((await t.focused()).visible, "the focus in the field is visible");
  await press("Control+a");
  await page.keyboard.type("Auswertung mit Mittelwerten");
  await t.pressUntil("Tab", (el) => el?.getAttribute("data-action") === "start", "Tab to \"Squash\"", 30);
  await press("Enter");
  await t.waitToast(/Squash complete/, "success");
  await eventually(() => centerKind(repo), "graph", "back in the graph");
  equal(subjects(repo, `${repo.base}..HEAD`), ["Auswertung mit Mittelwerten", "Notiz danach"], "git log: three became one, the later one stays on top");
  equal(repo.git("diff", repo.later, "HEAD"), "", "git: the end state is the same as before");
  equal(porcelain(repo), "", "git: clean");
  const where = await t.focused();
  check(where.tag !== "BODY" && where.tag !== null, `after the squash the focus is on an element (${JSON.stringify(where)})`);
  await t.closeToasts();
  await page.evaluate(() => document.activeElement?.blur?.());
  await press("Control+z");
  await eventually(() => head(repo), repo.later, "Ctrl+Z undoes the squash (git)");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E2b", "Single cherry-pick with conflict: conflict tool, \"Continue cherry-pick\", author stays, undo", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f13-e2b" }));
  repo.git("checkout", "-q", "-b", "thema/quelle");
  repo.write("README.md", "# Messnetz\n\nFassung des Thema-Branches.\n");
  repo.git("add", "-A");
  repo.git("-c", `user.name=${JONAS.GIT_AUTHOR_NAME}`, "commit", "-q", "--author", `${JONAS.GIT_AUTHOR_NAME} <${JONAS.GIT_AUTHOR_EMAIL}>`, "-m", "README aus dem Thema");
  const k = head(repo);
  repo.git("checkout", "-q", "main");
  const mainBefore = commit(repo, "README.md", "# Messnetz\n\nFassung von main.\n", "README auf main");
  await t.open(repo);
  await t.commitMenu(repo, k);
  await t.pick(/^Cherry-pick/);
  const toast = await t.waitToast(/Cherry-pick: conflict in one file/, "warning");
  check(/then continue the cherry-pick – or abort it/.test(toast?.text ?? ""), `the toast says how to go on (${toast?.text})`);
  check(gitDirHas(repo, "CHERRY_PICK_HEAD"), "git: the cherry-pick is in progress");
  await opBanner("Cherry-pick").waitFor({ timeout: 15_000 });
  await eventually(t.footer, (value) => /cherry-pick in progress/.test(value), "status bar: \"cherry-pick in progress\"");
  await t.closeToasts();
  await page.locator('[data-section="conflicts"] [data-row-key="README.md"]').click();
  await page.waitForFunction(() => document.querySelector('[data-screen="conflict"]')?.getAttribute("aria-label") === "Resolve conflict: README.md" && document.querySelector('[data-screen="conflict"]')?.getAttribute("data-conflict-state") !== "loading", null, { timeout: 60_000 });
  const ours = page.locator('[data-screen="conflict"] [data-sides] [data-conflict-head="0"][data-side="ours"]');
  const theirs = page.locator('[data-screen="conflict"] [data-sides] [data-conflict-head="0"][data-side="theirs"]');
  const labels = [await ours.getAttribute("aria-label"), await theirs.getAttribute("aria-label")];
  check(/main/.test(labels[0] ?? "") && labels[0] !== labels[1] && !/undefined|null/.test(labels.join(" ")), `the sides have meaningful names; the current one names main (${JSON.stringify(labels)})`);
  await theirs.click();
  await page.locator('[data-screen="conflict"] button[data-action="save"]').click();
  await eventually(() => t.conflictedCount(repo.repoId), 0, "the conflict is resolved");
  await opBanner("Cherry-pick").getByRole("button", { name: "Continue cherry-pick" }).click();
  await eventually(() => gitDirHas(repo, "CHERRY_PICK_HEAD"), false, "git: the cherry-pick is done", 30_000);
  await t.waitToast(/complete/, "success");
  equal(repo.git("log", "-1", "--format=%s|%an"), "README aus dem Thema|Jonas Albrecht", "git: message and author of the original stay");
  equal(parentsOf(repo), [mainBefore], "git: on the previous tip");
  equal(readFile(repo, "README.md"), "# Messnetz\n\nFassung des Thema-Branches.\n", "file: the chosen version");
  equal(porcelain(repo), "", "git: clean");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available");
  await undoButton().click();
  await eventually(() => head(repo), mainBefore, "Undo takes back the cherry-pick");
  equal(readFile(repo, "README.md"), "# Messnetz\n\nFassung von main.\n", "file as before");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E3", "Abort a cherry-pick sequence midway: the already transferred commit is gone too", async () => {
  const repo = await t.open(pickRepo("f13-e3"));
  await openPickTool(repo);
  equal((await listRows()).map((row) => row.sha), [repo.k1, repo.k2, repo.k3], "order as in the history");
  await startButton().click();
  await t.waitToast(/conflict in one file/, "warning");
  await opBanner("Cherry-pick").waitFor({ timeout: 15_000 });
  await eventually(async () => /step 2 of 3/.test(await opBanner("Cherry-pick").innerText()), true, "commit-panel shows \"step 2 of 3\"");
  equal(subjects(repo, `${repo.mainBefore}..HEAD`), ["Datei x angelegt"], "git: the first commit is already transferred");
  await t.closeToasts();
  await opBanner("Cherry-pick").getByRole("button", { name: "Abort cherry-pick" }).click();
  const ask = await t.waitDialog(/^Abort cherry-pick\?$/);
  equal(await t.focusedText(), "Cancel", "confirmation: focus on \"Cancel\"");
  await ask.getByRole("button", { name: "Abort cherry-pick" }).click();
  await t.waitToast(/Aborted the cherry-pick/, "success");
  equal(head(repo), repo.mainBefore, "git: main is back before the whole sequence");
  check(!exists(repo, "x.txt"), "file: x.txt from the first step is gone again");
  check(!gitDirHas(repo, "CHERRY_PICK_HEAD") && !gitDirHas(repo, "sequencer"), "git: no running sequence anymore");
  equal(porcelain(repo), "", "git: clean");
  await eventually(t.footer, (value) => !/cherry-pick in progress/.test(value), "status bar: no cherry-pick anymore");
  await t.closeToasts();
  // The aborted cherry-pick is not an undoable action.
  await t.refresh(repo.repoId);
  const label = (await undoButton().getAttribute("aria-label")) ?? "";
  check(!/Cherry-pick/i.test(label) || (await undoButton().getAttribute("aria-disabled")) === "true", `Undo does not offer the aborted cherry-pick (${label})`);
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E4", "Cherry-pick of a merge commit: transfers the merged-in changes (against the first parent)", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f13-e4" }));
  repo.git("checkout", "-q", "-b", "thema/sammel");
  commit(repo, "a.txt", "a\n", "Erster Schritt");
  repo.git("checkout", "-q", "-b", "nebenzweig");
  commit(repo, "b.txt", "b\n", "Nebenzweig");
  repo.git("checkout", "-q", "thema/sammel");
  commit(repo, "c.txt", "c\n", "Parallel zum Nebenzweig");
  repo.git("merge", "-q", "--no-ff", "-m", "Nebenzweig hereingeholt", "nebenzweig");
  const merge = head(repo);
  repo.git("checkout", "-q", "main");
  const mainBefore = head(repo);
  await t.open(repo);
  await t.commitMenu(repo, merge);
  const item = (await t.menuItems()).find((entry) => entry.text.startsWith("Cherry-pick"));
  if (item?.disabled) {
    check(/merge commit/i.test(item.text), `disabled – then with the reason \"merge commit\" (${item.text})`);
    await t.closeMenu();
    return;
  }
  await t.pick(/^Cherry-pick/);
  await t.waitToast(/Cherry-pick complete/, "success");
  equal(repo.git("log", "-1", "--format=%s"), "Nebenzweig hereingeholt", "git: commit with the merge's message");
  equal(parentsOf(repo), [mainBefore], "git: an ordinary commit (one parent)");
  check(exists(repo, "b.txt"), "file: the merged-in change (b.txt) is there");
  check(!exists(repo, "a.txt") && !exists(repo, "c.txt"), "files: the topic branch's own work does not come along");
  equal(porcelain(repo), "", "git: clean");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E5", "Cherry-pick of an already contained change: notice \"Nothing to apply\", no empty commit", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f13-e5" }));
  repo.git("checkout", "-q", "-b", "thema/doppelt");
  const k = commit(repo, "gleich.txt", "derselbe Inhalt\n", "Datei im Thema angelegt");
  repo.git("checkout", "-q", "main");
  const mainBefore = commit(repo, "gleich.txt", "derselbe Inhalt\n", "Dieselbe Datei auf main angelegt");
  await t.open(repo);
  await t.commitMenu(repo, k);
  await t.pick(/^Cherry-pick/);
  const toast = await t.anyToast(30_000);
  check(toast?.tone === "info" && /Nothing to apply/.test(toast.text), `notice \"Nothing to apply\" (${JSON.stringify(toast)})`);
  equal(head(repo), mainBefore, "git: no new commit");
  check(!gitDirHas(repo, "CHERRY_PICK_HEAD"), "git: no dangling cherry-pick");
  equal(porcelain(repo), "", "git: clean");
  await t.comeBack();
  equal(await t.operationKind(repo.repoId), null, "the app shows no running operation");
});

// ---------------------------------------------------------------------------------------------
const LONG_SUMMARY = `Auswertung 🚀 zusammengefasst – ${"Größen, Maße, Übergänge äöüß „Zitat“ 测试 ".repeat(13)}Ende`;
await t.section("F13-E6", "Squash message: empty is blocked; 500 characters with emoji and umlauts arrive exactly", async () => {
  check([...LONG_SUMMARY].length >= 500, `the message has at least 500 characters (${[...LONG_SUMMARY].length})`);
  const repo = await t.open(squashRepo("f13-e6"));
  await openSquashTool(repo, [repo.s1, repo.s2, repo.s3]);
  const form = page.locator(`${rebaseScreen} form`);
  await form.getByLabel("Summary").fill("   ");
  await eventually(() => startButton().getAttribute("aria-disabled"), "true", "only spaces in the summary block the start");
  await form.getByLabel("Summary").fill(LONG_SUMMARY);
  await form.getByLabel("Description").fill("Erste Zeile 🎉\n\nDritte Zeile mit Tab\tund Umlauten: äöüß.");
  await eventually(() => startButton().getAttribute("aria-disabled"), null, "with text the start is enabled");
  equal(await t.overflow().then((value) => value.x), 0, "500 characters do not break the tool");
  equal(await page.locator(rebaseScreen).evaluate((element) => element.scrollWidth - element.clientWidth), 0, "the tool itself does not overflow either");
  await startButton().click();
  await t.waitToast(/Squash complete/, "success");
  const squashed = repo.git("rev-list", "--reverse", `${repo.base}..HEAD`).split("\n")[0];
  equal(repo.git("log", "-1", "--format=%B", squashed).replace(/\s+$/, ""), `${LONG_SUMMARY}\n\nErste Zeile 🎉\n\nDritte Zeile mit Tab\tund Umlauten: äöüß.`, "git: message exact to the character");
  equal(subjects(repo, `${repo.base}..HEAD`).length, 2, "git: three became one");
  equal(await t.overflow().then((value) => value.x), 0, "the graph with the long message does not overflow");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E7", "Double-click on start (squash and cherry-pick): the action runs exactly once", async () => {
  const squash = await t.open(squashRepo("f13-e7-squash"));
  await openSquashTool(squash, [squash.s1, squash.s2]);
  await startButton().dblclick();
  await t.waitToast(/Squash complete/, "success");
  await sleep(1500);
  equal(subjects(squash, `${squash.base}..HEAD`), ["Auswertung begonnen", "Monatsmittel ergänzt", "Notiz danach"], "squash: git log – squashed once");
  equal(await t.dangerToasts(), [], "squash: no error toast from the second click");
  equal(await page.locator('[role="dialog"], [role="alertdialog"]').count(), 0, "squash: no dialog stays open");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "squash: Undo is available");
  await undoButton().click();
  await eventually(() => head(squash), squash.later, "squash: a single undo restores the old tip");
  await t.closeToasts();

  const pick = pickRepo("f13-e7-pick");
  // Without conflict: main does not change README differently here – the topic state transfers cleanly.
  pick.git("reset", "-q", "--hard", "HEAD~1");
  pick.mainBefore = head(pick);
  await t.open(pick);
  await openPickTool(pick);
  await startButton().dblclick();
  await t.waitToast(/complete/, "success");
  await sleep(1500);
  equal(subjects(pick, `${pick.mainBefore}..HEAD`), ["Datei x angelegt", "README aus dem Thema", "Datei y angelegt"], "cherry-pick: git log – every commit exactly once");
  equal(await t.dangerToasts(), [], "cherry-pick: no error toast from the second click");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "cherry-pick: Undo is available");
  await undoButton().click();
  await eventually(() => head(pick), pick.mainBefore, "cherry-pick: a single undo takes back all three");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E9", "Changed from outside: a selected commit is rewritten in the terminal before the squash starts – nothing is squashed wrongly", async () => {
  const repo = await t.open(squashRepo("f13-e9"));
  await openSquashTool(repo, [repo.s3, repo.later]);
  repo.git("commit", "-q", "--amend", "-m", "Notiz danach (im Terminal umformuliert)");
  const amended = head(repo);
  await startButton().click({ force: true });
  await sleep(2500);
  const toasts = await t.toasts();
  const panel = await statePanel();
  const text = `${toasts.map((toast) => toast.text).join(" ")} ${(await page.locator(rebaseScreen).innerText().catch(() => "")).replace(/\s+/g, " ")}`;
  if (head(repo) === amended) {
    check(!toasts.some((toast) => toast.tone === "success"), `nothing rewritten – then no success toast either (${JSON.stringify(toasts)})`);
    check(/changed|reload|no longer|does not exist|consecutive|not found|not all of the selected commits are on the checked-out branch/i.test(text) || panel !== null, `the app explains why nothing happens (state: ${panel}; text: ${text.slice(0, 300)})`);
  } else {
    // Squashed despite the change: then the result must contain the state from the terminal.
    equal(repo.git("diff", amended, "HEAD"), "", "git: the end state matches the state from the terminal");
    check(repo.git("log", "-1", "--format=%B").includes("im Terminal umformuliert") || subjects(repo, `${repo.base}..HEAD`).length === 3, "git: the message from the terminal is not silently lost");
  }
  equal(porcelain(repo), "", "git: clean");
  check(!gitDirHas(repo, "rebase-merge"), "git: no dangling rebase");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E10", "Squash of a repository's first two commits (with root commit): succeeds or is disabled with a reason", async () => {
  const repo = t.made(makeEmptyRepo({ name: "f13-e10", withFile: false }));
  const r1 = commit(repo, "eins.txt", "eins\n", "Erster Commit überhaupt");
  const r2 = commit(repo, "zwei.txt", "zwei\n", "Zweiter Commit");
  const r3 = commit(repo, "drei.txt", "drei\n", "Dritter Commit");
  await t.open(repo);
  await t.commitMenu(repo, r2);
  await t.closeMenu();
  await t.graphRow(r2).click();
  await t.graphRow(r1).click({ modifiers: ["Shift"] });
  await t.graphRow(r1).click({ button: "right" });
  await t.waitMenu();
  const item = (await t.menuItems()).find((entry) => /Squash 2 commits/.test(entry.text));
  if (item?.disabled) {
    check(item.text.length > "Squash 2 commits …".length + 5, `disabled – with a reason (${item.text})`);
    await t.closeMenu();
    return;
  }
  await page.getByRole("menuitem", { name: /Squash 2 commits/ }).click();
  await sleep(500);
  const refused = await t.waitFor(statePanel, (value) => typeof value === "string" && value.startsWith("refused"), 3000);
  if (refused) {
    check((await page.locator(rebaseScreen).innerText()).replace(/\s+/g, " ").length > 40, "refused – the tool explains it");
    await press("Escape");
    equal(head(repo), r3, "git: nothing changed");
    return;
  }
  await waitList(2);
  await page.locator(`${rebaseScreen} form`).getByLabel("Summary").fill("Die ersten beiden zusammen");
  await startButton().click();
  const toast = await t.anyToast(40_000);
  if (toast?.tone === "success") {
    equal(subjects(repo, "HEAD"), ["Die ersten beiden zusammen", "Dritter Commit"], "git log: the first two became one");
    equal(repo.git("diff", r3, "HEAD"), "", "git: the end state is the same");
    equal(repo.git("rev-list", "--max-parents=0", "HEAD").split("\n").length, 1, "git: there is still exactly one root commit");
  } else {
    check((toast?.text ?? "").length > 40, `refused – the toast explains it (${JSON.stringify(toast)})`);
    equal(head(repo), r3, "git: nothing changed");
  }
  equal(porcelain(repo), "", "git: clean");
  // `git rebase --root` itself creates a loose helper commit on the empty tree without writing the
  // tree; `git fsck` reports "missing tree 4b825dc…" for it. That is Git, not the app – everything else counts.
  const fsck = gitTry(repo, ["fsck", "--no-dangling", "--no-progress"]);
  const complaints = fsck.ok ? [] : fsck.out.split(/\r?\n/).filter((line) => line.trim() && line.trim() !== "missing tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  equal(complaints, [], "git fsck: the repository is fine");
  check(!gitDirHas(repo, "rebase-merge"), "git: no dangling rebase");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E11", "Screen reader and 960×600: roles and names in the cherry-pick and squash tools", async () => {
  const repo = await t.open(pickRepo("f13-e11"));
  await openPickTool(repo);
  equal(await page.locator(rebaseScreen).getAttribute("aria-label"), "Cherry-pick", "the tool has a name");
  check(((await page.locator(`${rebaseScreen} [role="listbox"]`).getAttribute("aria-label")) ?? "").length > 5, "the list has a name");
  equal(await t.unnamedControls(rebaseScreen), [], "cherry-pick: every control has an accessible name");
  const boxes = await page.locator(`${rebaseScreen} [role="option"] [role="checkbox"]`).evaluateAll((list) => list.map((box) => `${box.getAttribute("aria-checked")}|${box.getAttribute("aria-label")}`));
  equal(boxes, ["true|Skip", "true|Skip", "true|Skip"], "every row has a checkbox with state and name");
  await page.locator(`${rebaseScreen} [role="listbox"]`).focus();
  await press("ArrowDown");
  await press(" ");
  await eventually(() => page.locator(`${rebaseScreen} [role="option"] [role="checkbox"]`).nth(1).getAttribute("aria-checked"), "false", "Space: the checkbox state changes (aria-checked)");
  const status = (await page.locator(`${rebaseScreen} [role="status"]`).allInnerTexts()).join(" ").replace(/\s+/g, " ");
  check(/2/.test(status), `a status line says how many commits are transferred (${status})`);
  check((await t.focused()).visible, "the focus in the list is visible with keyboard use");
  await t.app.setSize(960, 600);
  try {
    await sleep(300);
    equal(await t.overflow().then((value) => value.x), 0, "960×600: no horizontal overflow");
    check(await t.inViewport(startButton()), "960×600: the start button is visible");
  } finally {
    await t.app.setSize(1440, 900);
  }
  await press("Escape");
  await eventually(() => centerKind(repo), "graph", "Esc closes the tool, nothing is transferred");
  equal(head(repo), repo.mainBefore, "git: main unchanged");

  const squash = await t.open(squashRepo("f13-e11-squash"));
  await openSquashTool(squash, [squash.s1, squash.s2]);
  equal(await page.locator(rebaseScreen).getAttribute("aria-label"), "Squash commits", "squash: the tool has a name");
  equal(await page.locator(`${rebaseScreen} form`).getAttribute("aria-label"), "Message of the new commit", "squash: the form has a name");
  equal(await t.unnamedControls(rebaseScreen), [], "squash: every control has an accessible name");
  equal(await page.locator(`${rebaseScreen} form`).getByLabel("Summary").count(), 1, "squash: the \"Summary\" field is reachable by its label");
  await press("Escape");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-N2", "Changes in the way: cherry-pick whose file has uncommitted changes – rejected, change stays", async () => {
  const repo = pickRepo("f13-n2");
  repo.write("README.md", "# Messnetz\n\nAuswertung der Stationen, Fassung main.\nlokal weitergeschrieben\n");
  await t.open(repo);
  await t.commitMenu(repo, repo.k2);
  await t.pick(/^Cherry-pick/);
  await sleep(500);
  const title = await t.dialogTitle();
  const body = title ? (await t.dialog().last().innerText()).replace(/\s+/g, " ") : "";
  const toast = title ? null : await t.anyToast(30_000);
  const text = `${title ?? ""} ${body} ${toast?.text ?? ""}`;
  check(/commit or stash|stash|changes/i.test(text), `the app says that uncommitted changes are in the way (${text})`);
  check(!/complete/.test(text), "no success is reported");
  if (title) await press("Escape");
  equal(head(repo), repo.mainBefore, "git: main unchanged");
  check(!gitDirHas(repo, "CHERRY_PICK_HEAD"), "git: no cherry-pick open");
  check(readFile(repo, "README.md").includes("lokal weitergeschrieben"), "file: the local change is untouched");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-N3", "Detached HEAD: squash is disabled with a reason; a single cherry-pick lands on the detached HEAD", async () => {
  const repo = squashRepo("f13-n3");
  repo.git("checkout", "-q", "-b", "thema/extra", repo.base);
  const extra = commit(repo, "extra.txt", "extra\n", "Extra aus dem Thema");
  repo.git("checkout", "-q", "--detach", repo.later);
  await t.open(repo);
  await t.store("revealCommit", repo.tabId, repo.s2);
  await t.graphRow(repo.s2).click();
  await t.graphRow(repo.s1).click({ modifiers: ["Shift"] });
  await t.graphRow(repo.s1).click({ button: "right" });
  await t.waitMenu();
  const squash = (await t.menuItems()).find((entry) => /Squash 2 commits/.test(entry.text));
  check(squash?.disabled === true && /no branch checked out/.test(squash.text), `squash is disabled: \"no branch checked out\" (${JSON.stringify(squash)})`);
  await t.closeMenu();
  await t.commitMenu(repo, extra);
  const pick = (await t.menuItems()).find((entry) => entry.text.startsWith("Cherry-pick"));
  check(/onto HEAD/.test(pick?.text ?? ""), `the entry names the target \"HEAD\" (${pick?.text})`);
  await t.pick(/^Cherry-pick/);
  await t.waitToast(/Cherry-pick complete/, "success");
  equal(parentsOf(repo), [repo.later], "git: the commit sits on the detached HEAD");
  check(!gitTry(repo, ["symbolic-ref", "-q", "HEAD"]).ok, "git: HEAD is still detached");
  equal(head(repo, "main"), repo.later, "git: main is unchanged");
  check(exists(repo, "extra.txt"), "file: extra.txt is there");
});

// ---------------------------------------------------------------------------------------------
await t.section("F13-E8", "Restart the app in the middle of a cherry-pick sequence: \"step 2 of 3\" is back; continue and undo succeed", async () => {
  const dataDir = t.makeDataDir();
  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const repo = await t.open(pickRepo("f13-e8"));
  await openPickTool(repo);
  await startButton().click();
  await t.waitToast(/conflict in one file/, "warning");
  await opBanner("Cherry-pick").waitFor({ timeout: 15_000 });
  await eventually(async () => /step 2 of 3/.test(await opBanner("Cherry-pick").innerText()), true, "before the restart: \"step 2 of 3\"");
  await sleep(500);

  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const tabs = await t.app.invoke("tabs_list");
  check(tabs.some((tab) => tab.kind === "repo" && tab.repoId === repo.repoId), "the repository's tab is back after the restart");
  await t.open(repo);
  await eventually(() => t.operationKind(repo.repoId), "cherry_pick", "after the restart: the app shows the running cherry-pick");
  await eventually(t.footer, (value) => /cherry-pick in progress/.test(value), "status bar: \"cherry-pick in progress\"");
  await t.store("selectWip", repo.tabId);
  await opBanner("Cherry-pick").waitFor({ timeout: 15_000 });
  await eventually(async () => /step 2 of 3/.test(await opBanner("Cherry-pick").innerText()), true, "the banner shows \"step 2 of 3\" again");
  repo.write("README.md", "# Messnetz\n\nAuswertung der Stationen, Fassung main und Thema.\n");
  repo.git("add", "README.md");
  await eventually(
    async () => {
      await t.comeBack();
      return t.conflictedCount(repo.repoId);
    },
    0,
    "the conflict is resolved",
  );
  await opBanner("Cherry-pick").getByRole("button", { name: "Continue cherry-pick" }).click();
  await eventually(() => gitDirHas(repo, "CHERRY_PICK_HEAD") || gitDirHas(repo, "sequencer"), false, "git: the sequence is done", 30_000);
  equal(subjects(repo, `${repo.mainBefore}..HEAD`), ["Datei x angelegt", "README aus dem Thema", "Datei y angelegt"], "git: all three transferred");
  equal(porcelain(repo), "", "git: clean");
  equal(branchOf(repo), "main", "git: main is checked out");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "Undo is available after the restart too");
  await undoButton().click();
  await eventually(() => head(repo), repo.mainBefore, "Undo takes back the whole sequence – even across the restart");
  equal(porcelain(repo), "", "git: clean");
});

await t.finish();
