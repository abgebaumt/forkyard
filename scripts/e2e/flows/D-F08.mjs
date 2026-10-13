/**
 * F08 – Rebase and interactive rebase: edge cases not covered by other scripts.
 * Real app, real fixture repositories, checked in the repository itself with git.
 *
 *   node scripts/e2e/flows/D-F08.mjs                    everything
 *   node scripts/e2e/flows/D-F08.mjs --only F08-H3      only sections whose ID or title contains this (comma separates several)
 *   node scripts/e2e/flows/D-F08.mjs --show             visible window
 *
 * At the end comes the list of green and red sections. A red section with "BUG D-xx" is the test the
 * reported bug is fixed against.
 */
import { execFileSync } from "node:child_process";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { branchOf, commit, createFlow, exists, gitDirHas, gitTry, head, porcelain, readFile, sleep, subjects } from "./D-lib.mjs";

const t = createFlow("D-F08");
const { check, equal, eventually } = t;
const rebaseScreen = '[data-screen="rebase"]';

/** Branch "thema/plan" with five commits on main (as in rebase.mjs): c3 creates export.txt, c4 changes it. */
function planRepo(name, { push = false, branch = "thema/plan" } = {}) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  repo.base = head(repo, "main");
  repo.git("checkout", "-q", "-b", branch);
  repo.c = {
    c1: commit(repo, "sensoren.txt", "Nord\nSüd\nHafen\n", "Sensorliste ergänzt"),
    c2: commit(repo, "README.md", readFile(repo, "README.md").replace("Schulstationen", "Schul-Stationen"), "Tippfehler im README"),
    c3: commit(repo, "export.txt", "Zwischenstand\n", "Zwischenstand Export"),
    c4: commit(repo, "export.txt", "fertig\n", "Export fertig"),
    c5: commit(repo, "debug.txt", "print(werte)\n", "Debug-Ausgabe"),
  };
  repo.branch = branch;
  if (push) repo.git("push", "-q", "-u", "origin", branch);
  return repo;
}
/** thema/plan (two commits) hangs off an older main; main is one commit ahead. `conflict`: both change README.md. */
function behindRepo(name, { conflict = false, push = false, branch = "thema/plan" } = {}) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  repo.git("checkout", "-q", "-b", branch);
  repo.first = commit(repo, conflict ? "README.md" : "sensoren.txt", conflict ? "# Messnetz\n\nFassung des Thema-Branches.\n" : "Nord\nSüd\n", "Erster Schritt im Thema");
  repo.oldTip = commit(repo, "notiz.txt", "zweiter Schritt\n", "Zweiter Schritt im Thema");
  if (push) repo.git("push", "-q", "-u", "origin", branch);
  repo.git("checkout", "-q", "main");
  repo.mainTip = commit(repo, conflict ? "README.md" : "haupt.txt", conflict ? "# Messnetz\n\nFassung von main.\n" : "auf main\n", "Arbeit auf main");
  repo.git("checkout", "-q", branch);
  repo.branch = branch;
  return repo;
}
const remoteGit = (repo, ...args) => execFileSync("git", ["--git-dir", repo.remotePath, ...args], { windowsHide: true }).toString("utf8").trim();
const rebasing = (repo) => gitDirHas(repo, "rebase-merge") || gitDirHas(repo, "rebase-apply");

await t.launch();
let page = t.page;
const press = (key) => page.keyboard.press(key);
const listRows = () =>
  page.locator(`${rebaseScreen} [role="option"]`).evaluateAll((list) =>
    list
      .map((row) => ({ index: Number(row.dataset.index), sha: row.dataset.rowSha, action: row.querySelector("[data-action]")?.getAttribute("data-action") ?? null, summary: row.querySelector("[data-summary]")?.textContent ?? "", active: row.hasAttribute("data-active") }))
      .sort((a, b) => a.index - b.index),
  );
const shasInList = async () => (await listRows()).map((row) => row.sha);
const listFocused = () => page.evaluate((root) => document.activeElement?.getAttribute("role") === "listbox" && Boolean(document.activeElement.closest(root)), rebaseScreen);
const startButton = () => page.locator(`${rebaseScreen} button[data-action="start"]`);
const waitList = async (count) => {
  await page.locator(`${rebaseScreen} [role="listbox"]`).waitFor({ timeout: 30_000 });
  await eventually(async () => (await listRows()).length, count, `the list shows ${count} commits`);
  await eventually(listFocused, true, "focus is in the list");
};
const openPlan = async (repo) => {
  await t.store("openRebase", repo.tabId, repo.base, "interactive", []);
  await waitList(5);
};
const rebaseBanner = () => page.locator('[data-screen="commit-panel"]').locator('[role="alert"], [role="status"]').filter({ hasText: /Rebase of/ }).first();
const undoButton = () => t.toolButton("Undo");
const centerKind = async (repo) => (await t.view(repo.tabId)).center.kind;
/** Move c4 before c3 and start: c4 changes a file that does not exist yet → conflict at step 3. */
const swapAndStart = async (repo) => {
  await openPlan(repo);
  await press("End");
  await press("ArrowUp");
  await press("Alt+ArrowUp");
  await eventually(shasInList, [repo.c.c1, repo.c.c2, repo.c.c4, repo.c.c3, repo.c.c5], "c4 is before c3");
  await press("Control+Enter");
  await t.waitToast(/Interactive rebase: conflict in one file/, "warning");
  await rebaseBanner().waitFor({ timeout: 15_000 });
  await t.closeToasts();
};

// ---------------------------------------------------------------------------------------------
await t.section("F08-H3", "Happy path keyboard only: plain rebase from the left panel, then Ctrl+Z", async () => {
  const repo = await t.open(behindRepo("f08-h3"));
  await page.evaluate(() => document.activeElement?.blur?.());
  await press("Alt+1");
  await t.pressUntil("ArrowDown", (el) => /^Local branch main(,|$)/.test(el?.getAttribute("aria-label") ?? ""), "arrow down to \"main\" in the left panel", 40);
  await press("Shift+F10");
  await t.pickByKeyboard(/Rebase “thema\/plan” onto “main”/);
  const toast = await t.waitToast(/Rebase complete/, "success");
  check(/2 commits/.test(toast?.text ?? ""), `the toast names the number of rebased commits (${toast?.text})`);
  equal(repo.git("merge-base", "thema/plan", "main"), repo.mainTip, "git: thema/plan sits on main");
  equal(subjects(repo, "main..thema/plan"), ["Erster Schritt im Thema", "Zweiter Schritt im Thema"], "git: both commits are there, in the same order");
  check(head(repo, "thema/plan") !== repo.oldTip, "git: the commits were rewritten");
  equal(branchOf(repo), "thema/plan", "git: the branch stays checked out");
  equal(porcelain(repo), "", "git: clean");
  const where = await t.focused();
  check(where.tag !== "BODY" && where.tag !== null, `after the rebase, focus is on an element (${JSON.stringify(where)})`);
  await t.closeToasts();
  await press("Control+z");
  await eventually(() => head(repo, "thema/plan"), repo.oldTip, "Ctrl+Z undoes the rebase (git)");
  await t.waitToast(/Undone/, "success");
});

// ---------------------------------------------------------------------------------------------
// BUG D-04: A plain rebase silently flattens merge commits of the source branch (expected: "not allowed";
// the rebase tool rebase rejects the same range with an explanation).
await t.section(
  "F08-E1b",
  "Merge commit on the source branch in a plain rebase: rejected or explicitly announced – never silently flattened",
  async () => {
    const repo = t.made(makeCleanRepoWithRemote({ name: "f08-e1b" }));
    repo.git("checkout", "-q", "-b", "thema/merge");
    commit(repo, "a.txt", "a\n", "Erster Schritt");
    repo.git("checkout", "-q", "-b", "nebenzweig");
    commit(repo, "b.txt", "b\n", "Nebenzweig");
    repo.git("checkout", "-q", "thema/merge");
    commit(repo, "c.txt", "c\n", "Parallel zum Nebenzweig");
    repo.git("merge", "-q", "--no-ff", "-m", "Nebenzweig hereingeholt", "nebenzweig");
    const oldTip = head(repo);
    repo.git("checkout", "-q", "main");
    commit(repo, "haupt.txt", "auf main\n", "Arbeit auf main");
    repo.git("checkout", "-q", "thema/merge");
    await t.open(repo);
    equal(repo.git("rev-list", "--count", "--min-parents=2", "main..thema/merge"), "1", "starting point: one merge commit on the source branch");
    await t.branchMenu("main");
    const item = (await t.menuItems()).find((entry) => /Rebase “thema\/merge” onto “main”/.test(entry.text));
    if (item?.disabled) {
      check(/merge commit/i.test(item.text), `disabled – with the reason "merge commit" (${item.text})`);
      await t.closeMenu();
      return;
    }
    await t.pick(/Rebase “thema\/merge” onto “main”/);
    // Allowed: a confirmation first, a rejection, or a success that says what happened to the merge commit.
    await sleep(800);
    const title = await t.dialogTitle();
    if (title) {
      const body = (await t.dialog().last().innerText()).replace(/\s+/g, " ");
      check(/merge commit/i.test(body), `the dialog explains that a merge commit is affected (${body})`);
      await press("Escape");
      equal(head(repo), oldTip, "git: after Esc nothing is rewritten");
      return;
    }
    const toast = await t.anyToast(30_000);
    const merges = repo.git("rev-list", "--count", "--min-parents=2", "main..thema/merge");
    if (head(repo) === oldTip) {
      check(/merge commit/i.test(toast?.text ?? ""), `rejected – the toast names the merge commit (${toast?.text})`);
      return;
    }
    if (merges === "0" && !/merge commit/i.test(toast?.text ?? "")) await t.bugShot("D-04");
    check(merges !== "0" || /merge commit/i.test(toast?.text ?? ""), `the merge commit "Nebenzweig hereingeholt" is gone after the rebase (${merges} merge commits instead of 1), and the toast says nothing about it (${toast?.text})`);
  },
  { bug: "D-04" },
);

// ---------------------------------------------------------------------------------------------
await t.section("F08-E2b", "Conflict in the middle of a plain rebase: resolve in the conflict tool, \"Continue rebase\", undo", async () => {
  const repo = await t.open(behindRepo("f08-e2b", { conflict: true }));
  await t.branchMenu("main");
  await t.pick(/Rebase “thema\/plan” onto “main”/);
  const toast = await t.waitToast(/Rebase: conflict in one file/, "warning");
  check(/then continue the rebase – or abort it/.test(toast?.text ?? ""), "the toast says how to go on");
  check(rebasing(repo), "git: the rebase is running");
  await rebaseBanner().waitFor({ timeout: 15_000 });
  check(/step 1 of 2/.test(await rebaseBanner().innerText()), `the banner shows the step (${(await rebaseBanner().innerText()).replace(/\s+/g, " ")})`);
  await eventually(t.footer, (value) => /rebase in progress/i.test(value), "status bar: \"rebase in progress\"");
  await t.closeToasts();
  await page.locator('[data-section="conflicts"] [data-row-key="README.md"]').click();
  await page.waitForFunction(() => document.querySelector('[data-screen="conflict"]')?.getAttribute("data-conflict-state") !== "loading" && document.querySelector('[data-screen="conflict"]')?.getAttribute("aria-label") === "Resolve conflict: README.md", null, { timeout: 60_000 });
  const theirs = page.locator('[data-screen="conflict"] [data-sides] [data-conflict-head="0"][data-side="theirs"]');
  check(/Your commit/.test((await theirs.getAttribute("aria-label")) ?? ""), `in a rebase the incoming side is called "Your commit" (${await theirs.getAttribute("aria-label")})`);
  await theirs.click();
  await page.locator('[data-screen="conflict"] button[data-action="save"]').click();
  await eventually(() => t.conflictedCount(repo.repoId), 0, "the conflict is resolved");
  await rebaseBanner().getByRole("button", { name: "Continue rebase" }).click();
  await eventually(() => rebasing(repo), false, "git: the rebase is done", 30_000);
  await t.waitToast(/complete/, "success");
  equal(repo.git("merge-base", "thema/plan", "main"), repo.mainTip, "git: thema/plan sits on main");
  equal(subjects(repo, "main..thema/plan"), ["Erster Schritt im Thema", "Zweiter Schritt im Thema"], "git: both commits are there");
  equal(readFile(repo, "README.md"), "# Messnetz\n\nFassung des Thema-Branches.\n", "file: the chosen version (\"Your commit\")");
  equal(branchOf(repo), "thema/plan", "git: the branch is checked out again");
  equal(porcelain(repo), "", "git: clean");
  await eventually(t.footer, (value) => !/rebase in progress/i.test(value), "status bar: no rebase anymore");
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "undo is available");
  await undoButton().click();
  await eventually(() => head(repo, "thema/plan"), repo.oldTip, "undo: thema/plan is back on the old tip");
  equal(porcelain(repo), "", "git: clean after undo");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-E3b", "Already pushed commits: after the plain rebase the push is rejected, \"Force push\" (force-with-lease) gets it through", async () => {
  const repo = await t.open(behindRepo("f08-e3b", { push: true }));
  equal(remoteGit(repo, "rev-parse", "refs/heads/thema/plan"), repo.oldTip, "starting point: the branch is on the remote");
  await t.branchMenu("main");
  await t.pick(/Rebase “thema\/plan” onto “main”/);
  await sleep(600);
  const before = await t.dialogTitle();
  if (before) {
    // A confirmation before rewriting pushed commits is fine: confirm it.
    console.log(`    (confirmation before the rebase: "${before}")`);
    await press("Tab");
    await press("Enter");
  }
  await t.waitToast(/Rebase complete/, "success");
  const newTip = head(repo, "thema/plan");
  check(newTip !== repo.oldTip, "git: the branch is rewritten");
  await t.closeToasts();
  await t.refresh(repo.repoId);
  await t.toolButton("Push").click();
  const rejected = await t.waitDialog(/^Push rejected$/, 40_000);
  const text = (await rejected.innerText()).replace(/\s+/g, " ");
  check(/Force push/.test(text), `the dialog offers "Force push" (${text})`);
  await rejected.getByRole("button", { name: /^Force push/ }).click();
  const force = await t.waitDialog(/^Force push to origin\/thema\/plan\?$/, 30_000);
  check(/--force-with-lease/.test(await force.innerText()), "the dialog mentions --force-with-lease");
  equal(await t.focusedText(), "Cancel", "focus on \"Cancel\"");
  await force.getByRole("button", { name: "Force push" }).click();
  await t.waitToast(/Force-pushed/, "success", 40_000);
  equal(remoteGit(repo, "rev-parse", "refs/heads/thema/plan"), newTip, "git: the remote is on the rewritten branch");
  equal(remoteGit(repo, "merge-base", "--is-ancestor", repo.mainTip, "refs/heads/thema/plan") === "", true, "git (remote): the branch contains the commit from main");
});

// BUG D-05: A plain rebase of pushed commits runs without any hint – neither before nor after does it say
// that a force push is needed afterwards (the rebase tool rebase asks in the same situation).
await t.section(
  "F08-E3c",
  "Already pushed commits: the plain rebase points out that a force push is needed afterwards",
  async () => {
    const repo = await t.open(behindRepo("f08-e3c", { push: true }));
    await t.branchMenu("main");
    const item = (await t.menuItems()).find((entry) => /Rebase “thema\/plan” onto “main”/.test(entry.text));
    await t.pick(/Rebase “thema\/plan” onto “main”/);
    await sleep(800);
    const title = await t.dialogTitle();
    const dialogText = title ? (await t.dialog().last().innerText()).replace(/\s+/g, " ") : "";
    if (title) {
      await press("Tab");
      await press("Enter");
    }
    const toast = await t.waitToast(/Rebase complete/, "success");
    const hint = /remote|pushed|forc/i;
    const told = hint.test(item?.text ?? "") || hint.test(dialogText) || hint.test(toast?.text ?? "");
    if (!told) await t.bugShot("D-05");
    check(told, `neither menu entry ("${item?.text}") nor dialog ("${dialogText}") nor toast ("${toast?.text}") say that the branch is already on the remote`);
  },
  { bug: "D-05" },
);

// ---------------------------------------------------------------------------------------------
const LONG_SUMMARY = `Sensorliste 🚀 überarbeitet – ${"Größen, Maße, Übergänge äöüß „Zitat“ 测试 ".repeat(13)}Ende`;
await t.section("F08-E5", "Reword: empty summary is rejected; 500 characters with emoji and umlauts arrive character-exact", async () => {
  check([...LONG_SUMMARY].length >= 500, `the message has at least 500 characters (${[...LONG_SUMMARY].length})`);
  const repo = await t.open(planRepo("f08-e5"));
  await openPlan(repo);
  await press("r");
  const reword = await t.waitDialog(/^Reword commit$/);
  equal(await reword.getByLabel("Summary").inputValue(), "Sensorliste ergänzt", "prefilled with the old message");
  await reword.getByLabel("Summary").fill("   ");
  await press("Control+Enter");
  await sleep(400);
  equal(await t.dialogTitle(), "Reword commit", "empty summary: the dialog stays open");
  const confirm = reword.getByRole("button", { name: "Apply message" });
  const alerts = (await reword.getByRole("alert").allInnerTexts()).join(" ");
  check(alerts.length > 0 || (await confirm.isDisabled()), `the reason is shown at the field or "Apply message" is disabled (messages: "${alerts}")`);
  await reword.getByLabel("Summary").fill(LONG_SUMMARY);
  await reword.getByLabel("Description").fill("Erste Zeile 🎉\n\nDritte Zeile mit Tab\tund Umlauten: äöüß.");
  await press("Control+Enter");
  await t.noDialog("the dialog closes");
  await eventually(async () => (await listRows())[0]?.action, "reword", "the row is \"Reword\"");
  equal((await listRows())[0].summary, LONG_SUMMARY, "the row shows the new summary in full (truncated by CSS only)");
  equal(await t.overflow().then((value) => value.x), 0, "500 characters do not break the tool");
  await eventually(listFocused, true, "focus is back in the list");
  await press("Control+Enter");
  await t.waitToast(/Interactive rebase complete/, "success");
  const first = repo.git("rev-list", "--reverse", "main..HEAD").split("\n")[0];
  equal(repo.git("log", "-1", "--format=%B", first).replace(/\s+$/, ""), `${LONG_SUMMARY}\n\nErste Zeile 🎉\n\nDritte Zeile mit Tab\tund Umlauten: äöüß.`, "git: message character-exact, with emoji, umlauts, blank line and tab");
  equal(subjects(repo, "main..HEAD").slice(1), ["Tippfehler im README", "Zwischenstand Export", "Export fertig", "Debug-Ausgabe"], "git: the other commits unchanged");
  equal(await t.overflow().then((value) => value.x), 0, "the graph with the long message does not overflow");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-E6", "Double Ctrl+Enter and double-click on \"Start rebase\": the rebase runs exactly once", async () => {
  for (const how of ["double Ctrl+Enter", "double-click"]) {
    const repo = await t.open(planRepo(`f08-e6-${how === "double-click" ? "klick" : "enter"}`));
    await openPlan(repo);
    await press("ArrowDown");
    await press("Alt+ArrowUp");
    await eventually(shasInList, [repo.c.c2, repo.c.c1, repo.c.c3, repo.c.c4, repo.c.c5], `${how}: c2 is at the top`);
    if (how === "double-click") await startButton().dblclick();
    else {
      await press("Control+Enter");
      await press("Control+Enter");
    }
    await t.waitToast(/Interactive rebase complete/, "success");
    await sleep(1500);
    equal(subjects(repo, "main..HEAD"), ["Tippfehler im README", "Sensorliste ergänzt", "Zwischenstand Export", "Export fertig", "Debug-Ausgabe"], `${how}: git log – reordered once`);
    equal(await t.dangerToasts(), [], `${how}: no error toast from the second trigger`);
    equal((await t.toasts()).filter((toast) => /Interactive rebase complete/.test(toast.text)).length, 1, `${how}: exactly one success toast`);
    equal(await page.locator('[role="dialog"], [role="alertdialog"]').count(), 0, `${how}: no dialog stays open`);
    await eventually(() => centerKind(repo), "graph", `${how}: back in the graph`);
    await t.closeToasts();
    await eventually(() => undoButton().getAttribute("aria-disabled"), null, `${how}: undo is available`);
    await undoButton().click();
    await eventually(() => head(repo, "thema/plan"), repo.c.c5, `${how}: a single undo restores the old tip`);
    await t.closeToasts();
  }
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-E8", "Changed from outside: rebase aborted or continued in the terminal while the app shows the banner", async () => {
  const repo = await t.open(planRepo("f08-e8"));
  await swapAndStart(repo);
  check(rebasing(repo), "git: the rebase is running");
  repo.git("rebase", "--abort");
  await eventually(
    async () => {
      await t.comeBack();
      return t.operationKind(repo.repoId);
    },
    null,
    "the app notices the abort in the terminal",
    30_000,
  );
  equal(await rebaseBanner().count(), 0, "the banner is gone");
  await eventually(t.footer, (value) => !/rebase in progress/i.test(value), "status bar: no rebase anymore");
  equal(head(repo, "thema/plan"), repo.c.c5, "git: the branch is unchanged");

  // Second run: resolve and continue in the terminal (two conflicts in a row).
  await t.refresh(repo.repoId);
  await swapAndStart(repo);
  repo.write("export.txt", "fertig\n");
  repo.git("add", "export.txt");
  const second = gitTry(repo, ["rebase", "--continue"]);
  check(!second.ok && rebasing(repo), "terminal: after continuing, the rebase stops at the next conflict");
  await eventually(
    async () => {
      await t.comeBack();
      return rebaseBanner().innerText().then((text) => /step 4 of 5/.test(text)).catch(() => false);
    },
    true,
    "the app shows the new state: \"step 4 of 5\"",
    30_000,
  );
  await eventually(() => t.conflictedCount(repo.repoId), 1, "with the new conflict");
  repo.write("export.txt", "Zwischenstand, dann fertig\n");
  repo.git("add", "export.txt");
  repo.git("rebase", "--continue");
  await eventually(
    async () => {
      await t.comeBack();
      return t.operationKind(repo.repoId);
    },
    null,
    "the app notices the end of the rebase in the terminal",
    30_000,
  );
  equal(subjects(repo, "main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README", "Export fertig", "Zwischenstand Export", "Debug-Ausgabe"], "git log: the chosen order");
  await t.refresh(repo.repoId);
  await eventually(async () => (await t.graphRow(head(repo)).count()) === 1, true, "the graph shows the new tip");
  // Undo after a rebase finished in the terminal: either disabled or it restores exactly the old tip.
  await t.closeToasts();
  if ((await undoButton().getAttribute("aria-disabled")) !== "true") {
    const label = await undoButton().getAttribute("aria-label");
    await undoButton().click();
    await sleep(1500);
    const now = head(repo, "thema/plan");
    check(now === repo.c.c5, `undo ("${label}") after the rebase finished in the terminal restores the old tip (is ${now.slice(0, 7)}, old ${repo.c.c5.slice(0, 7)})`);
    equal(porcelain(repo), "", "git: clean afterwards");
  } else console.log("    (undo is disabled after the rebase finished in the terminal)");
});

// ---------------------------------------------------------------------------------------------
const ODD_BRANCH = "thema/überarbeitung-🚀-größen-und-maße-mit-einem-namen-über-sechzig-zeichen";
await t.section("F08-E9", "Branch name with umlauts, emoji and over 60 characters: menu, rebase, toast", async () => {
  const repo = await t.open(behindRepo("f08-e9", { branch: ODD_BRANCH }));
  await t.branchMenu("main");
  const item = (await t.menuItems()).find((entry) => /onto “main”/.test(entry.text) && !/Interactively/.test(entry.text));
  check(Boolean(item) && item.title.includes(ODD_BRANCH), `the menu entry shortens the name, the tooltip shows it in full (${JSON.stringify(item)})`);
  equal(await t.overflow().then((value) => value.x), 0, "the menu does not break the window");
  await page.getByRole("menuitem", { name: /onto “main”/ }).filter({ hasNotText: /Interactively/ }).first().click();
  const toast = await t.waitToast(/Rebase complete/, "success");
  check((toast?.text ?? "").includes("überarbeitung-🚀"), `the toast names the branch with umlaut and emoji (${toast?.text})`);
  equal(repo.git("merge-base", ODD_BRANCH, "main"), repo.mainTip, "git: the branch sits on main");
  equal(branchOf(repo), ODD_BRANCH, "git: the branch stays checked out");
  equal(await t.overflow().then((value) => value.x), 0, "afterwards: no overflow");
  await eventually(t.footer, (value) => value.includes("überarbeitung-🚀"), "the status bar shows the name");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-E10", "Screen reader: roles and names in the rebase tool, visible focus, disabled start with reason", async () => {
  const repo = await t.open(planRepo("f08-e10"));
  await openPlan(repo);
  const list = page.locator(`${rebaseScreen} [role="listbox"]`);
  check(((await list.getAttribute("aria-label")) ?? "").length > 5, `the list has a name (${await list.getAttribute("aria-label")})`);
  const options = await page.locator(`${rebaseScreen} [role="option"]`).evaluateAll((rows) => rows.map((row) => ({ label: row.getAttribute("aria-label") ?? row.textContent?.replace(/\s+/g, " ").trim() ?? "", setsize: row.getAttribute("aria-setsize"), posinset: row.getAttribute("aria-posinset"), selected: row.getAttribute("aria-selected") })));
  equal(options.map((option) => option.setsize), ["5", "5", "5", "5", "5"], "every row states the list size (aria-setsize)");
  check(options.every((option) => /Sensorliste|Tippfehler|Zwischenstand|Export fertig|Debug/.test(option.label)), `every row names its commit (${JSON.stringify(options.map((option) => option.label.slice(0, 60)))})`);
  check(options.every((option) => /Pick/i.test(option.label)), `every row names its action as text (${JSON.stringify(options.map((option) => option.label.slice(0, 80)))})`);
  equal(await t.unnamedControls(rebaseScreen), [], "every control in the tool has an accessible name");
  // Visible focus matters with keyboard use: one arrow key there and back, then check.
  await press("ArrowDown");
  await press("ArrowUp");
  check((await t.focused()).visible, `focus in the list is visible with keyboard use (${JSON.stringify(await t.focused())})`);
  equal(await startButton().getAttribute("aria-disabled"), "true", "start is disabled without a change (aria-disabled)");
  const reason = await startButton().evaluate((button) => {
    const id = button.getAttribute("aria-describedby");
    return (id ? document.getElementById(id)?.textContent : "")?.trim() || button.getAttribute("title") || "";
  });
  const summaryText = await page.locator(`${rebaseScreen} [data-plan-summary]`).innerText();
  check(reason.length > 0 || /nothing|unchanged|no change/i.test(summaryText), `the reason for the disabled start is reachable as text (description: "${reason}", footer: "${summaryText}")`);
  await press("Escape");
  await eventually(() => centerKind(repo), "graph", "Esc closes the tool");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-E11", "Abort mid-flow: Esc in \"Abort rebase?\" aborts nothing; then the button aborts", async () => {
  const repo = await t.open(planRepo("f08-e11"));
  await swapAndStart(repo);
  await rebaseBanner().getByRole("button", { name: "Abort rebase" }).click();
  await t.waitDialog(/^Abort rebase\?$/);
  equal(await t.focusedText(), "Cancel", "dialog: focus on \"Cancel\"");
  await press("Escape");
  await t.noDialog("Esc closes the dialog");
  check(rebasing(repo), "git: Esc did not abort the rebase");
  await rebaseBanner().getByRole("button", { name: "Abort rebase" }).click();
  await (await t.waitDialog(/^Abort rebase\?$/)).getByRole("button", { name: "Abort rebase" }).click();
  await t.waitToast(/Aborted the rebase/, "success");
  check(!rebasing(repo), "git: no rebase running anymore");
  equal(head(repo, "thema/plan"), repo.c.c5, "git: the branch is unchanged");
  equal(porcelain(repo), "", "git: clean");
  check(exists(repo, "debug.txt") && readFile(repo, "export.txt") === "fertig\n", "files as before the rebase");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-N2", "Changes in the way: plain rebase with an uncommitted change is rejected, the change stays", async () => {
  const repo = behindRepo("f08-n2");
  repo.write("notiz.txt", "zweiter Schritt\nlokal weitergeschrieben\n");
  await t.open(repo);
  await t.branchMenu("main");
  await t.pick(/Rebase “thema\/plan” onto “main”/);
  await sleep(500);
  const title = await t.dialogTitle();
  const body = title ? (await t.dialog().last().innerText()).replace(/\s+/g, " ") : "";
  const toast = title ? null : await t.anyToast(30_000);
  const text = `${title ?? ""} ${body} ${toast?.text ?? ""}`;
  check(/commit or stash|stash|changes/i.test(text), `the app says uncommitted changes are in the way (${text})`);
  check(!/complete/.test(text), "no success is reported");
  if (title) await press("Escape");
  equal(head(repo, "thema/plan"), repo.oldTip, "git: the branch is unchanged");
  check(!rebasing(repo), "git: no rebase open");
  equal(readFile(repo, "notiz.txt"), "zweiter Schritt\nlokal weitergeschrieben\n", "file: the local change is untouched");
  equal(repo.git("stash", "list"), "", "git: nothing was stashed without asking");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-N3", "Deleted ref: the target disappears while its menu is open – clear message, nothing changed", async () => {
  const repo = behindRepo("f08-n3");
  repo.git("branch", "ziel/weg", "main");
  await t.open(repo);
  await t.branchMenu("ziel/weg");
  repo.git("branch", "-D", "ziel/weg");
  await t.pick(/Rebase “thema\/plan” onto “ziel\/weg”/);
  const toast = await t.anyToast(30_000);
  check(Boolean(toast) && toast.tone !== "success", `the rebase onto a deleted branch is not reported as success (${JSON.stringify(toast)})`);
  check(/ziel\/weg|does not exist|doesn't exist|not found/i.test(toast?.text ?? ""), `the toast says the target does not exist (anymore) (${toast?.text})`);
  equal(head(repo, "thema/plan"), repo.oldTip, "git: the branch is unchanged");
  check(!rebasing(repo), "git: no rebase open");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-N5", "Remote rejects: between the dialog and \"Force push\" someone else pushes – their commit is not overwritten", async () => {
  const repo = await t.open(behindRepo("f08-n5", { push: true }));
  await t.branchMenu("main");
  await t.pick(/Rebase “thema\/plan” onto “main”/);
  await t.waitToast(/Rebase complete/, "success");
  const newTip = head(repo, "thema/plan");
  await t.closeToasts();
  await t.refresh(repo.repoId);
  await t.toolButton("Push").click();
  const rejected = await t.waitDialog(/^Push rejected$/, 40_000);
  await rejected.getByRole("button", { name: /^Force push/ }).click();
  const force = await t.waitDialog(/^Force push to origin\/thema\/plan\?$/, 30_000);
  // Right now a colleague pushes another commit onto the same branch.
  const foreign = repo.commitOnRemote({ branch: "thema/plan", file: "docs/fremd.md", message: "Fremder Commit, kam dazwischen" });
  equal(remoteGit(repo, "rev-parse", "refs/heads/thema/plan"), foreign, "starting point: the remote has the foreign commit");
  await force.getByRole("button", { name: "Force push" }).click();
  await sleep(1500);
  const shown = async () => `${(await page.locator('[role="dialog"]').count()) ? (await page.locator('[role="dialog"]').last().innerText()).replace(/\s+/g, " ") : ""} ${(await t.toasts()).map((toast) => `${toast.tone}: ${toast.text}`).join(" ")}`.trim();
  await eventually(async () => (await shown()).length > 0, true, "the app reports something", 40_000);
  const text = await shown();
  equal(remoteGit(repo, "rev-parse", "refs/heads/thema/plan"), foreign, "git (remote): the foreign commit is NOT overwritten (force-with-lease applies)");
  check(!/Force-pushed/.test(text) || /\bnot\b/.test(text), `no force push is reported as success (${text})`);
  check(/rejected|since|changed|newer|state/i.test(text), `the message explains that the remote has changed in the meantime (${text})`);
  equal(head(repo, "thema/plan"), newTip, "git: the local branch is unchanged");
  for (let round = 0; round < 3 && (await page.locator('[role="dialog"]').count()) > 0; round++) await press("Escape");
  equal(remoteGit(repo, "rev-parse", "refs/heads/thema/plan"), foreign, "git (remote): not overwritten after Esc either");
});

// ---------------------------------------------------------------------------------------------
await t.section("F08-E7", "Restart the app mid-rebase: \"rebase in progress\" and \"step 3 of 5\" are back; continue and undo work", async () => {
  const dataDir = t.makeDataDir();
  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const repo = await t.open(planRepo("f08-e7"));
  await swapAndStart(repo);
  check(/step 3 of 5/.test(await rebaseBanner().innerText()), "before the restart: \"step 3 of 5\"");
  await sleep(500);

  await t.close();
  await t.launch({ dataDir });
  page = t.page;
  const tabs = await t.app.invoke("tabs_list");
  check(tabs.some((tab) => tab.kind === "repo" && tab.repoId === repo.repoId), "the repository tab is back after the restart");
  await t.open(repo);
  await eventually(() => t.operationKind(repo.repoId), "rebase", "after the restart: the app shows the running rebase");
  await eventually(t.footer, (value) => /rebase in progress/i.test(value), "status bar: \"rebase in progress\"");
  await t.store("selectWip", repo.tabId);
  await rebaseBanner().waitFor({ timeout: 15_000 });
  await eventually(async () => /step 3 of 5/.test(await rebaseBanner().innerText()), true, "the banner shows \"step 3 of 5\" again");
  equal(await t.conflictedCount(repo.repoId), 1, "with the open conflict");
  for (const name of ["Pull", "Push", "Branch"]) check((await t.toolButton(name).getAttribute("aria-disabled")) === "true", `${name} is disabled during the rebase`);

  repo.write("export.txt", "fertig\n");
  repo.git("add", "export.txt");
  await eventually(
    async () => {
      await t.comeBack();
      return t.conflictedCount(repo.repoId);
    },
    0,
    "first conflict resolved",
  );
  await rebaseBanner().getByRole("button", { name: "Continue rebase" }).click();
  await eventually(async () => /step 4 of 5/.test(await rebaseBanner().innerText().catch(() => "")), true, "after continuing: \"step 4 of 5\"");
  await t.closeToasts();
  repo.write("export.txt", "Zwischenstand, dann fertig\n");
  repo.git("add", "export.txt");
  await eventually(
    async () => {
      await t.comeBack();
      return t.conflictedCount(repo.repoId);
    },
    0,
    "second conflict resolved",
  );
  await rebaseBanner().getByRole("button", { name: "Continue rebase" }).click();
  await eventually(() => rebasing(repo), false, "git: the rebase is done", 30_000);
  equal(subjects(repo, "main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README", "Export fertig", "Zwischenstand Export", "Debug-Ausgabe"], "git log: the chosen order");
  equal(branchOf(repo), "thema/plan", "git: the branch is checked out again");
  // Undo survives the restart: the state before the rebase.
  await t.closeToasts();
  await eventually(() => undoButton().getAttribute("aria-disabled"), null, "undo is available after the restart too");
  await undoButton().click();
  await eventually(() => head(repo, "thema/plan"), repo.c.c5, "undo: thema/plan is back on the tip from before the rebase");
  equal(porcelain(repo), "", "git: clean");
});

await t.finish();
