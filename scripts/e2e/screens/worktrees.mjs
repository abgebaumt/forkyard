/**
 * Worktrees in the real app against real repositories: section in the left panel, “Create worktree”
 * (new branch, existing branch, detached), open in a new tab, lock with a reason, unlock,
 * remove (confirmation; with changes only after a clear warning), clean up orphaned entries.
 *
 *   node scripts/e2e/screens/worktrees.mjs              everything (checks and screenshots)
 *   node scripts/e2e/screens/worktrees.mjs --only lock  only sections whose title contains “lock”
 *   node scripts/e2e/screens/worktrees.mjs --show       visible window
 *
 * Checks are made in the repository itself (`git worktree list --porcelain`, folders on disk), not
 * only in the UI. The “keyboard only” sections never use the mouse.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { tamper } from "./commit-panel-lib.mjs";
import { createRun } from "./mustfix-lib.mjs";
import { git, samePath, sideHelpers, worktreeList } from "./submodules-lib.mjs";

const show = process.argv.includes("--show");
const t = createRun("worktrees");
const { check, equal, eventually, section } = t;

const fx = makeCleanRepoWithRemote({ name: "messnetz" });
const at = (name) => path.join(fx.root, name);
const listed = () => worktreeList(fx, fx.path);
const entry = (name) => listed().find((item) => samePath(item.path, at(name))) ?? null;
const branches = () => git(fx, fx.path, "branch", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean).sort();

let app = null;
try {
  app = await launchApp({ show });
  t.attach(app);
  const { page } = app;
  const h = sideHelpers(app);
  const W = "worktrees";
  const { repoId, tabId } = await app.openRepo(fx.path);
  await h.section(W).waitFor();

  const dialog = () => page.getByRole("dialog", { name: "Create worktree" });
  const alerts = async (scope) => (await scope.getByRole("alert").allInnerTexts()).join(" | ");
  const wtRow = (name) => h.rowEnding(W, name);
  /** Like wtRow, but with a message saying which rows are there instead. */
  const mustRow = async (name) => {
    const row = await wtRow(name);
    if (row) return row;
    const keys = await h.rows(W).evaluateAll((list) => list.map((el) => el.dataset.sideRow));
    throw new Error(`No worktree row whose path ends in “${name}”. Present: ${JSON.stringify(keys)}`);
  };
  const rowState = async (name) => {
    const row = await wtRow(name);
    if (!row) return null;
    return row.evaluate((el) => ({
      text: el.innerText.replace(/\s+/g, " ").trim(),
      main: el.hasAttribute("data-main"),
      current: el.getAttribute("aria-current") === "true",
      locked: el.hasAttribute("data-locked"),
      prunable: el.hasAttribute("data-prunable"),
      changed: el.hasAttribute("data-changed"),
      label: el.getAttribute("aria-label"),
    }));
  };
  // Via the filter bar into the panel, through the ref rows and on with arrow down into the worktrees.
  const focusRowByKeyboard = (name) => h.focusRowByKeyboard(W, name);

  // -------------------------------------------------------------------------------------------
  await section("Setup: only the main folder", async () => {
    equal(await h.headerText(W), "WORKTREES 1", "header with count");
    equal(listed().length, 1, "git: exactly one worktree");
    const main = await rowState("messnetz");
    check(main?.main && main.current, `the main folder is marked as such and as open (${JSON.stringify(main)})`);
    check(/main · main folder/.test(main?.text ?? ""), `the row names the branch and “main folder” as text (${main?.text})`);
    check(/main folder/.test(main?.label ?? "") && /open in this tab/.test(main?.label ?? ""), `screen reader text names both (${main?.label})`);
    equal(await h.section(W).locator('[role="tree"]').getAttribute("aria-label"), "Worktrees", "list with a name");
    equal(await page.locator('[data-screen="sidebar"] [data-section]').count(), 4, "the panel's four ref sections are unchanged");

    await (await wtRow("messnetz")).click({ button: "right" });
    await h.menu().first().waitFor();
    const items = await h.menuItems();
    const find = (pattern) => items.find((item) => pattern.test(item.text));
    check(find(/Remove worktree/)?.disabled && /the main folder stays/.test(find(/Remove worktree/)?.text ?? ""), `main folder: “Remove” disabled with a reason (${find(/Remove worktree/)?.text})`);
    check(find(/^Lock/)?.disabled, "main folder: “Lock” disabled");
    check(find(/Open in new tab/)?.disabled && /already open here/.test(find(/Open in new tab/)?.text ?? ""), "“Open” disabled: already open here");
    check(!find(/Create worktree/)?.disabled, "“Create worktree …” is in the menu");
    equal(await page.locator('[role="menu"]').count(), 1, "only one menu open (not the panel's as well)");
    await h.closeMenu();
  });

  // -------------------------------------------------------------------------------------------
  await section("Create with a new branch – keyboard only", async () => {
    fs.mkdirSync(at("belegt"));
    fs.writeFileSync(path.join(at("belegt"), "notiz.txt"), "hier liegt schon etwas\n");

    await h.palette("Create worktree");
    await dialog().waitFor();
    await eventually(async () => (await t.focused()).label, "Name of the new branch", "focus in the branch name field");
    equal(await dialog().getByLabel("Parent folder").inputValue(), fx.root, "suggestion: next to the main folder");
    equal(await dialog().getByLabel("Folder name").inputValue(), "", "no folder name without a branch yet");
    await t.shot("worktrees-dialog");

    // Submit empty: errors at the fields, nothing happens
    await page.keyboard.press("Enter");
    await eventually(async () => /The new branch needs a name/.test(await alerts(dialog())), true, "without a name: error at the field");
    equal(listed().length, 1, "git: nothing created");

    // Taken and invalid name
    await page.keyboard.type("main");
    await eventually(async () => /already exists/i.test(await alerts(dialog())), true, "taken branch name: reason at the field");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("feature..karte");
    await eventually(async () => (await alerts(dialog())).length > 0 && !/already exists/.test(await alerts(dialog())), true, "invalid name: reason at the field");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("feature/karte neu");
    equal(await dialog().getByLabel("Name of the new branch").inputValue(), "feature/karte-neu", "spaces become “-”");
    await eventually(() => dialog().getByLabel("Folder name").inputValue(), "messnetz-feature-karte-neu", "folder name follows the branch");
    await eventually(async () => (await dialog().locator("[data-worktree-target]").innerText()).replace(/\s+/g, ""), `Willbecreatedin:${at("messnetz-feature-karte-neu")}`.replace(/\s+/g, ""), "preview of the target folder");
    await eventually(() => alerts(dialog()), "", "no more errors");

    // Occupied folder: the core refuses, the message is at the field
    check(await h.tabUntil(() => document.activeElement?.labels?.[0]?.textContent === "Folder name"), "Tab reaches “Folder name”");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("belegt");
    await page.keyboard.press("Enter");
    await eventually(async () => /Something is already there/.test(await alerts(dialog())), true, "occupied folder: message at the field");
    equal(await t.toasts(), [], "no toast for an error at a field");
    equal(listed().length, 1, "git: nothing created");
    check(!branches().includes("feature/karte-neu"), "git: no branch left behind either");
    await t.shot("worktrees-dialog-error");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("messnetz-karte");

    // Do not open in a new tab, then create
    check(await h.tabUntil(() => document.activeElement?.getAttribute("role") === "checkbox"), "Tab reaches the checkbox");
    await page.keyboard.press("Space");
    equal(await dialog().getByRole("checkbox", { name: /Open in a new tab afterwards/ }).getAttribute("aria-checked"), "false", "Space turns “open in new tab” off");
    check(await h.tabUntil(() => document.activeElement?.textContent?.trim() === "Create worktree" && document.activeElement.tagName === "BUTTON"), "Tab reaches “Create worktree”");
    await page.keyboard.press("Enter");
    await eventually(() => dialog().count(), 0, "the dialog closes");
    await t.waitToast(/Worktree “messnetz-karte” created/, "success");

    const made = entry("messnetz-karte");
    equal([made?.branch, made?.locked, made?.detached], ["feature/karte-neu", false, false], "git worktree list: new worktree with a new branch");
    equal(git(fx, fx.path, "rev-parse", "feature/karte-neu"), git(fx, fx.path, "rev-parse", "main"), "git: the branch starts at the current commit");
    check(fs.existsSync(path.join(at("messnetz-karte"), "README.md")), "the folder is checked out");
    await eventually(() => h.headerText(W), "WORKTREES 2", "header counts two");
    const row = await rowState("messnetz-karte");
    check(/feature\/karte-neu/.test(row?.text ?? "") && !row?.main && !row?.current, `row of the new worktree (${JSON.stringify(row)})`);
    equal((await h.tabs()).length, 1, "without the checkbox no new tab opened");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  let exportTab = null;
  await section("Create with an existing branch, chosen folder, opens in a new tab", async () => {
    fs.mkdirSync(at("arbeitsordner"));
    await h.section(W).locator("[data-section-header]").hover();
    await h.section(W).locator('[data-action="add"]').click();
    await dialog().waitFor();
    await dialog().getByRole("radio", { name: "Existing branch" }).or(dialog().getByRole("button", { name: "Existing branch" })).first().click();
    const select = dialog().getByRole("combobox", { name: "Branch" });
    await select.waitFor();
    await eventually(async () => (await select.innerText()).trim(), "feature/export", "the first free branch is preselected");
    await select.click();
    await eventually(
      () => page.locator('[role="option"]').evaluateAll((list) => list.map((item) => ({ text: item.textContent.trim(), disabled: item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled") }))),
      [
        { text: "feature/export", disabled: false },
        { text: "feature/karte-neu – in another worktree", disabled: true },
        { text: "main – checked out here", disabled: true },
      ],
      "checked-out branches are disabled and say where they are",
    );
    await t.shot("worktrees-dialog-existing");
    await page.keyboard.press("Escape");

    await app.pick(at("arbeitsordner"));
    await dialog().getByRole("button", { name: "Browse …" }).click();
    await eventually(() => dialog().getByLabel("Parent folder").inputValue(), at("arbeitsordner"), "“Browse” sets the folder");
    equal(await dialog().getByLabel("Folder name").inputValue(), "messnetz-feature-export", "folder name from the branch");
    equal(await dialog().getByRole("checkbox", { name: /Open in a new tab afterwards/ }).getAttribute("aria-checked"), "true", "“open in new tab” is preselected");
    await dialog().getByRole("button", { name: "Create worktree" }).click();
    await eventually(() => dialog().count(), 0, "the dialog closes");
    await t.waitToast(/created and opened/, "success");

    const target = path.join(at("arbeitsordner"), "messnetz-feature-export");
    const made = listed().find((item) => samePath(item.path, target));
    equal(made?.branch, "feature/export", "git worktree list: worktree with the existing branch");
    await eventually(async () => (await h.tabs()).map((tab) => [tab.title.replace(/[•●\s]+$/, ""), tab.active]), [["messnetz", false], ["messnetz-feature-export", true]], "the worktree is open in a new tab");
    exportTab = await h.activeTabId();
    await app.settle();
    await eventually(() => h.headerText(W), "WORKTREES 3", "the worktree's tab lists all three as well");
    const here = await rowState("messnetz-feature-export");
    const main = await rowState("messnetz");
    check(here?.current && !here.main, `in the new tab the worktree itself is marked as open (${JSON.stringify(here)})`);
    check(main?.main && !main.current, `the main folder is marked as such but not as open (${JSON.stringify(main)})`);
    await t.shot("worktrees-in-tab");
    await h.activateTab(tabId);
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Detached on a remote branch; branch in another worktree is marked", async () => {
    const branchRow = page.locator('[data-screen="sidebar"] [data-row-id="refs/heads/feature/karte-neu"]');
    await eventually(() => branchRow.locator("[data-in-worktree]").count(), 1, "left panel: the branch carries the “in another worktree” mark");
    check(/checked out in another worktree/.test((await branchRow.getAttribute("aria-label")) ?? ""), "… also as text for screen readers");
    await branchRow.click({ button: "right" });
    await h.menu().first().waitFor();
    const items = await h.menuItems();
    const checkoutItem = items.find((item) => /^Check out/.test(item.text));
    check(checkoutItem?.disabled && /checked out in another worktree/.test(checkoutItem.text), `branch menu: “Check out” disabled with a reason (${checkoutItem?.text})`);
    check(items.some((item) => /Open this branch’s worktree/.test(item.text) && !item.disabled), "branch menu offers “Open this branch’s worktree”");
    await t.shot("worktrees-branch-menu");
    await h.closeMenu();

    // Checkout through the core fails with an understandable message (double-click in the left panel).
    await branchRow.dblclick();
    const toast = await t.waitToast(/Checkout failed/, "danger");
    check(/worktree/i.test(toast?.text ?? ""), `the error message names the worktree (${toast?.text})`);
    equal(git(fx, fx.path, "rev-parse", "--abbrev-ref", "HEAD"), "main", "git: nothing was checked out");
    await t.closeToasts();

    // From the menu of the checked-out branch: new branch from here
    await page.locator('[data-screen="sidebar"] [data-row-id="refs/heads/main"]').click({ button: "right" });
    await h.menu().first().waitFor();
    await page.getByRole("menuitem", { name: /Create worktree/ }).click();
    await dialog().waitFor();
    await eventually(async () => (await t.focused()).label, "Name of the new branch", "main is checked out: the dialog suggests a new branch");

    // Detached, by keyboard in the select
    await dialog().getByRole("radio", { name: "Detached" }).or(dialog().getByRole("button", { name: "Detached" })).first().click();
    const select = dialog().getByRole("combobox", { name: "Commit from" });
    await select.focus();
    await page.keyboard.press("Enter");
    await page.locator('[role="option"]').first().waitFor();
    const names = await page.locator('[role="option"]').allInnerTexts();
    check(names.some((name) => /Current commit \(main\)/.test(name)) && names.some((name) => name.trim() === "Remote branch origin/feature/export"), `the select names HEAD, branches and remote branches (${names.join(" | ")})`);
    await page.getByRole("option", { name: "Remote branch origin/feature/export" }).click();
    await eventually(() => dialog().getByLabel("Folder name").inputValue(), "messnetz-origin-feature-export", "folder name follows the target");
    await dialog().getByLabel("Folder name").fill("messnetz-ansehen");
    await dialog().getByRole("checkbox", { name: /Open in a new tab afterwards/ }).click();
    await dialog().getByRole("button", { name: "Create worktree" }).click();
    await eventually(() => dialog().count(), 0, "the dialog closes");
    const made = entry("messnetz-ansehen");
    equal([made?.detached, made?.branch, made?.head], [true, null, git(fx, fx.path, "rev-parse", "origin/feature/export")], "git worktree list: detached at the remote branch's commit");
    const row = await rowState("messnetz-ansehen");
    check(/detached · [0-9a-f]{7}/.test(row?.text ?? ""), `the row says “detached” with a short SHA (${row?.text})`);
    await t.closeToasts();
    await page.waitForTimeout(200);
    await t.shot("worktrees");
    await app.setTheme("light");
    await t.shot("worktrees-light");
    await app.setTheme("dark");
  });

  // -------------------------------------------------------------------------------------------
  await section("Lock with a reason, change the reason, unlock – keyboard only", async () => {
    check(await focusRowByKeyboard("messnetz-karte"), "Tab and arrow keys reach the worktree's row");
    await page.keyboard.press("Shift+F10");
    check(await h.chooseByKeyboard(/^Lock/), "Shift+F10 opens the menu; “Lock …” via arrow keys and Enter");
    const lock = await t.waitDialog(/Lock worktree “messnetz-karte”/);
    await eventually(async () => (await t.focused()).label, "Reason (optional)", "focus in the reason field");
    await page.keyboard.type("liegt auf der externen Platte");
    await t.shot("worktrees-lock");
    await page.keyboard.press("Enter");
    await eventually(() => lock.count(), 0, "Enter locks and closes");
    await t.waitToast(/Worktree “messnetz-karte” locked/, "success");
    equal([entry("messnetz-karte")?.locked, entry("messnetz-karte")?.lockReason], [true, "liegt auf der externen Platte"], "git worktree list: locked with a reason");
    await eventually(async () => (await rowState("messnetz-karte"))?.locked, true, "the row is marked as locked");
    const row = await rowState("messnetz-karte");
    check(/locked: liegt auf der externen Platte/.test(row?.text ?? ""), `the reason is in the row as text (${row?.text})`);
    check((await (await wtRow("messnetz-karte")).locator('[data-flag="locked"]').count()) === 1, "plus the lock as an icon");
    await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-side-row") ?? "")).endsWith("messnetz-karte"), true, "focus is back on the row");

    // Locked: removing is not possible – neither via Del nor via the menu
    await t.closeToasts();
    await page.keyboard.press("Delete");
    await t.waitToast(/cannot be removed/, "info");
    check(entry("messnetz-karte") !== null, "git: the locked worktree is still there");
    await t.closeToasts();
    await page.keyboard.press("ContextMenu");
    await h.menu().first().waitFor();
    const items = await h.menuItems();
    check(items.find((item) => /Remove worktree/.test(item.text))?.disabled && /unlock it first/.test(items.find((item) => /Remove worktree/.test(item.text))?.text ?? ""), "menu key opens the menu; “Remove” disabled – unlock it first");
    await h.closeMenu();
    await page.keyboard.press("Shift+F10");
    check(await h.chooseByKeyboard(/Change lock reason/), "“Change lock reason …” by keyboard");
    await t.waitDialog(/Change lock reason of “messnetz-karte”/);
    equal(await page.getByLabel("Reason (optional)").inputValue(), "liegt auf der externen Platte", "the previous reason is in the field and selected");
    await page.keyboard.type("Netzlaufwerk");
    await page.keyboard.press("Enter");
    await eventually(() => entry("messnetz-karte")?.lockReason, "Netzlaufwerk", "git worktree list: new reason");
    await t.closeToasts();

    await page.keyboard.press("Shift+F10");
    check(await h.chooseByKeyboard(/^Unlock/), "“Unlock” by keyboard");
    await eventually(() => entry("messnetz-karte")?.locked, false, "git worktree list: no longer locked");
    await t.waitToast(/unlocked/, "success");
    await eventually(async () => (await rowState("messnetz-karte"))?.locked, false, "the row is no longer marked as locked");
    await t.closeToasts();

    // Lock without a reason
    await page.keyboard.press("Shift+F10");
    check(await h.chooseByKeyboard(/^Lock/), "lock once more");
    await t.waitDialog(/Lock worktree/);
    await page.keyboard.press("Enter");
    await eventually(() => [entry("messnetz-karte")?.locked, entry("messnetz-karte")?.lockReason], [true, null], "git: locked without a reason");
    await eventually(async () => /· locked$/.test((await rowState("messnetz-karte"))?.text ?? ""), true, "row: “locked” without a reason");
    await page.keyboard.press("Shift+F10");
    await h.chooseByKeyboard(/^Unlock/);
    await eventually(() => entry("messnetz-karte")?.locked, false, "unlocked again");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Remove: confirmation, cancel; with changes only after the second warning", async () => {
    // Clean worktree, keyboard: Del → confirmation (focus on Cancel) → Enter cancels
    check(await focusRowByKeyboard("messnetz-ansehen"), "row reached by keyboard");
    await page.keyboard.press("Delete");
    const ask = await t.waitDialog(/Remove worktree “messnetz-ansehen”\?/);
    await eventually(async () => (await t.focused()).text, "Cancel", "confirmation: focus on “Cancel”");
    const text = await ask.innerText();
    check(text.includes(at("messnetz-ansehen")) && /folder is deleted with its contents/.test(text), "the confirmation names the folder and says it gets deleted");
    await t.shot("worktrees-remove");
    await page.keyboard.press("Enter");
    await eventually(() => ask.count(), 0, "Enter on “Cancel” closes");
    check(entry("messnetz-ansehen") !== null && fs.existsSync(at("messnetz-ansehen")), "Cancel removes nothing");
    await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-side-row") ?? "")).endsWith("messnetz-ansehen"), true, "after the confirmation focus is back on the row");

    await page.keyboard.press("Delete");
    await t.waitDialog(/Remove worktree “messnetz-ansehen”\?/);
    await page.keyboard.press("Tab");
    await eventually(async () => (await t.focused()).text, "Remove worktree", "Tab to the red button");
    await page.keyboard.press("Enter");
    await eventually(() => entry("messnetz-ansehen"), null, "git worktree list: the worktree is gone");
    await eventually(() => fs.existsSync(at("messnetz-ansehen")), false, "the folder is deleted");
    await t.waitToast(/Worktree “messnetz-ansehen” removed/, "success");
    await eventually(() => h.headerText(W), "WORKTREES 3", "header counts three");
    await eventually(async () => Boolean(await page.evaluate(() => document.activeElement?.closest('[data-extra-section="worktrees"]'))), true, "focus stays in the section (on a neighbouring row)");
    await t.closeToasts();

    // With changes: first the normal confirmation, then the clear warning
    fs.writeFileSync(path.join(at("messnetz-karte"), "skizze.md"), "Noch nicht committet.\n");
    await h.windowFocus();
    await eventually(async () => (await rowState("messnetz-karte"))?.changed, true, "the row shows “changed”");
    check(/changed/.test((await rowState("messnetz-karte"))?.text ?? ""), "… also as a word");
    await (await wtRow("messnetz-karte")).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Remove worktree/ }).click();
    const first = await t.waitDialog(/Remove worktree “messnetz-karte”\?/);
    await first.getByRole("button", { name: "Remove worktree" }).click();
    const warn = await t.waitDialog(/Delete “messnetz-karte” with its changes\?/);
    await eventually(async () => (await t.focused()).text, "Cancel", "warning: focus on “Cancel”");
    check(/uncommitted changes/.test(await warn.innerText()) && /cannot be recovered/.test(await warn.innerText()), "the warning says what gets lost and that it is final");
    await t.shot("worktrees-force");
    await page.keyboard.press("Enter");
    await eventually(() => t.dialog().count(), 0, "Cancel closes");
    check(entry("messnetz-karte") !== null && fs.existsSync(path.join(at("messnetz-karte"), "skizze.md")), "after cancelling the worktree and the file are still there");

    await (await wtRow("messnetz-karte")).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Remove worktree/ }).click();
    await (await t.waitDialog(/Remove worktree “messnetz-karte”\?/)).getByRole("button", { name: "Remove worktree" }).click();
    await (await t.waitDialog(/with its changes\?/)).getByRole("button", { name: "Delete with changes" }).click();
    await eventually(() => entry("messnetz-karte"), null, "git worktree list: removed");
    await eventually(() => fs.existsSync(at("messnetz-karte")), false, "the folder including the file is deleted");
    check(branches().includes("feature/karte-neu"), "git: the branch stayed");
    await t.closeToasts();

    // A worktree that is open in another tab: the tab closes too
    const target = path.join(at("arbeitsordner"), "messnetz-feature-export");
    await (await wtRow("arbeitsordner/messnetz-feature-export")).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Remove worktree/ }).click();
    const withTab = await t.waitDialog(/Remove worktree “messnetz-feature-export”\?/);
    check(/open tab for it is closed/.test(await withTab.innerText()), "the confirmation says the tab closes too");
    await withTab.getByRole("button", { name: "Remove worktree" }).click();
    await eventually(() => listed().some((item) => samePath(item.path, target)), false, "git worktree list: removed");
    await eventually(() => fs.existsSync(target), false, "the folder is deleted");
    await eventually(async () => (await h.tabs()).map((tab) => tab.title.replace(/[•●\s]+$/, "")), ["messnetz"], "the worktree's tab is closed");
    equal((await app.invoke("repo_list")).filter((repo) => samePath(repo.path, target)).length, 0, "and it is not listed as a missing repository");
    await eventually(() => h.headerText(W), "WORKTREES 1", "only the main folder is left");
    check(exportTab !== null, "the worktree's tab ID was known");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Orphaned: the folder is missing – notice and clean up", async () => {
    git(fx, fx.path, "worktree", "add", "-q", "-b", "versuch/eins", at("messnetz-versuch-eins"));
    git(fx, fx.path, "worktree", "add", "-q", "-b", "versuch/zwei", at("messnetz-versuch-zwei"));
    git(fx, fx.path, "worktree", "add", "-q", "-b", "versuch/drei", at("messnetz-versuch-drei"));
    git(fx, fx.path, "worktree", "lock", "--reason", "USB-Stick", at("messnetz-versuch-drei"));
    await h.windowFocus();
    await eventually(() => h.headerText(W), "WORKTREES 4", "worktrees created from outside appear when the window is in front again");
    for (const name of ["messnetz-versuch-eins", "messnetz-versuch-drei"]) fs.rmSync(at(name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await h.windowFocus();
    await eventually(async () => (await rowState("messnetz-versuch-eins"))?.prunable, true, "the row without a folder is marked as orphaned");
    const orphan = await rowState("messnetz-versuch-eins");
    check(/folder missing · orphaned/.test(orphan?.text ?? ""), `as text: “folder missing · orphaned” (${orphan?.text})`);
    check((await (await wtRow("messnetz-versuch-eins")).locator('[data-flag="orphan"]').count()) === 1, "and with a warning icon");
    // Git never reports a locked worktree as prunable – that is exactly what locking is for (removable media).
    const lockedOrphan = await rowState("messnetz-versuch-drei");
    check(lockedOrphan?.locked && !lockedOrphan.prunable && /locked: USB-Stick/.test(lockedOrphan.text), `locked and without a folder: still counts as locked, not orphaned (${lockedOrphan?.text})`);
    await t.shot("worktrees-orphan");

    // Opening is not possible – with an explanation
    await (await wtRow("messnetz-versuch-eins")).dblclick();
    await t.waitToast(/The folder of “messnetz-versuch-eins” is missing/, "warning");
    await t.closeToasts();

    const prune = h.section(W).locator('[data-action="prune"]');
    equal(await prune.getAttribute("aria-label"), "Clean up orphaned entry", "the header has the clean-up button (always visible)");
    await prune.click();
    const ask = await t.waitDialog(/Clean up orphaned worktree entry\?/);
    const text = await ask.innerText();
    check(text.includes(at("messnetz-versuch-eins")) && !text.includes(at("messnetz-versuch-zwei")), "the confirmation names exactly the entry without a folder");
    check(!text.includes(at("messnetz-versuch-drei")), "the locked worktree without a folder is not in the clean-up list");
    await t.shot("worktrees-prune");
    await ask.getByRole("button", { name: "Clean up" }).click();
    await eventually(() => entry("messnetz-versuch-eins"), null, "git worktree list: the orphaned entry is gone");
    check(entry("messnetz-versuch-zwei") !== null && entry("messnetz-versuch-drei") !== null, "git: the intact and the locked entry stayed");
    await t.waitToast(/1 orphaned entry cleaned up/, "success");
    await eventually(() => prune.count(), 0, "the button disappears – nothing left to clean up");
    await t.closeToasts();

    // The locked worktree without a folder only counts as orphaned after unlocking; clean up via the command palette
    await (await wtRow("messnetz-versuch-drei")).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Unlock/ }).click();
    await eventually(() => entry("messnetz-versuch-drei")?.locked, false, "git: unlocked");
    await t.waitToast(/unlocked/, "success");
    await eventually(async () => (await rowState("messnetz-versuch-drei"))?.prunable, true, "after unlocking the entry is marked as orphaned");
    await t.closeToasts();
    await h.palette("Clean up orphaned worktrees");
    await (await t.waitDialog(/Clean up orphaned worktree entry\?/)).getByRole("button", { name: "Clean up" }).click();
    await eventually(() => entry("messnetz-versuch-drei"), null, "git worktree list: this entry is gone too");
    await t.closeToasts();
    await h.palette("Clean up orphaned worktrees");
    await t.waitToast(/Nothing to clean up/, "info");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Command “Open worktree …” and Enter in the list", async () => {
    await h.palette("Open worktree");
    const pick = await t.waitDialog(/Open worktree/);
    check(/messnetz-versuch-zwei/.test(await pick.innerText()), "the list names the other worktree");
    await page.keyboard.press("Enter");
    await eventually(async () => (await h.tabs()).find((tab) => tab.active)?.title.replace(/[•●\s]+$/, ""), "messnetz-versuch-zwei", "Enter opens it in a tab");
    const second = await h.activeTabId();
    await page.keyboard.press("Control+w");
    await eventually(async () => (await h.tabs()).length, 1, "tab closed again");
    await h.activateTab(tabId).catch(() => undefined);
    check(await focusRowByKeyboard("messnetz-versuch-zwei"), "row reached by keyboard");
    await page.keyboard.press("Enter");
    await eventually(async () => (await h.tabs()).find((tab) => tab.active)?.title.replace(/[•●\s]+$/, ""), "messnetz-versuch-zwei", "Enter on the row opens the worktree in a tab");
    check(second !== null, "tab ID known");
    await page.keyboard.press("Control+w");
    await eventually(async () => (await h.tabs()).length, 1, "tab closed");
    await h.activateTab(tabId).catch(() => undefined);
  });

  // -------------------------------------------------------------------------------------------
  await section("States: filter, collapsed, hidden, loading, error", async () => {
    const filter = page.locator("[data-left-filter]");
    await filter.fill("zwei");
    await eventually(() => h.headerText(W), "WORKTREES 1/2", "filter: only the match, with “1/2” in the header");
    check((await (await wtRow("messnetz-versuch-zwei")).locator("mark").innerText()) === "zwei", "the match is highlighted");
    await t.shot("worktrees-filter");
    await filter.fill("gibt-es-nicht");
    await eventually(() => h.section(W).count(), 0, "without a match the section disappears");
    await filter.fill("");
    await eventually(() => h.headerText(W), "WORKTREES 2", "without a filter all again");

    await h.header(W).click();
    await eventually(() => h.rows(W).count(), 0, "clicking the header collapses");
    await eventually(async () => (await app.invoke("view_state_get", { repoId })).sections.find((item) => item.id === "worktrees")?.collapsed, true, "remembered in the core: worktrees collapsed");
    await h.header(W).focus();
    await page.keyboard.press("Enter");
    await eventually(() => h.rows(W).count(), 2, "Enter on the header expands again");
    await page.keyboard.press("ArrowDown");
    await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-side-row") ?? "")).length > 0, true, "arrow down leads from the header into the list");
    await page.keyboard.press("ArrowUp");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-id") ?? null), "refs/remotes/origin/main", "arrow up from the first row leads to the last ref row above");
    await page.keyboard.press("ArrowDown");
    await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-side-row") ?? "")).length > 0, true, "arrow down from there back into the worktrees");
    equal(await page.locator('[data-screen="sidebar"] [role="treeitem"][tabindex="0"]').count(), 1, "the panel still has exactly one row with a tab stop");
    await h.header(W).focus();

    // Hide via the header's menu, bring back via another section's menu
    await page.keyboard.press("Shift+F10");
    check(await h.chooseByKeyboard(/Hide section/), "header menu by keyboard: “Hide section”");
    await eventually(() => h.section(W).count(), 0, "the section is hidden");
    await page.locator('[data-screen="sidebar"] [data-section="tags"] [data-section-header]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Worktrees" }).click();
    await eventually(() => h.section(W).count(), 1, "another section's menu brings it back");

    // Loading: skeleton while the core has not answered yet
    const slow = await tamper(page, "worktreeList", { delayMs: 1500 });
    await page.evaluate((id) => void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "worktrees"] }), repoId);
    await eventually(() => h.section(W).locator("[data-skeleton]").count(), 1, "skeleton while the list loads");
    equal(await h.headerText(W), "WORKTREES", "no count in the header");
    await t.shot("worktrees-loading");
    await slow.restore();
    await eventually(() => h.rows(W).count(), 2, "then the rows are there");

    // Error while loading
    const broken = await tamper(page, "worktreeList", { fail: { code: "io", message: "The worktree list cannot be read.", gitOutput: null } });
    await page.evaluate((id) => void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "worktrees"] }), repoId);
    await eventually(async () => (await h.section(W).locator("[data-load-error]").innerText().catch(() => "")).includes("The worktree list cannot be read."), true, "the error is shown in the section");
    await t.shot("worktrees-error");
    await broken.restore();
    await h.section(W).getByRole("button", { name: "Try again" }).click();
    await eventually(() => h.rows(W).count(), 2, "“Try again” loads the list");
  });

  // -------------------------------------------------------------------------------------------
  await section("Many worktrees, very long names, 960×600", async () => {
    const long = "auswertung-der-messreihen-aller-stationen-im-winterhalbjahr-mit-korrekturfaktoren"; // 80 characters
    git(fx, fx.path, "worktree", "add", "-q", "-b", `team/${long}`, at(`messnetz-${long}`));
    git(fx, fx.path, "worktree", "lock", "--reason", "Dieser Ordner liegt auf dem Netzlaufwerk der Arbeitsgruppe und ist abends und am Wochenende nicht erreichbar", at(`messnetz-${long}`));
    for (let index = 1; index <= 24; index++) git(fx, fx.path, "worktree", "add", "-q", "--detach", at(`stand-${String(index).padStart(2, "0")}`));
    await h.windowFocus();
    await eventually(() => h.headerText(W), "WORKTREES 27", "27 worktrees in the list");
    equal(await h.rows(W).count(), 27, "all rows are there");
    equal(await h.panelOverflow(), { page: 0, panel: 0 }, "nothing scrolls horizontally – long names are truncated");
    await (await mustRow(`messnetz-${long}`)).scrollIntoViewIfNeeded();
    await t.shot("worktrees-many");

    await app.setSize(960, 600);
    // Below 1100 px the left panel collapses. Only once the app has processed the new width is it
    // settled whether it is closed – otherwise the check would still see it open and it would close right after.
    await eventually(() => page.evaluate(() => window.__gc.store.getState().narrow), true, "960×600 counts as a narrow window");
    await app.settle();
    // … then expand it with Ctrl+J
    if ((await h.section(W).count()) === 0) await page.keyboard.press("Control+j");
    await h.section(W).waitFor();
    // The freshly expanded left panel loads the list first: wait until the rows are back.
    await eventually(() => h.rows(W).count(), 27, "960×600: all rows are in the expanded left panel");
    await (await mustRow("messnetz-versuch-zwei")).scrollIntoViewIfNeeded();
    equal(await h.panelOverflow(), { page: 0, panel: 0 }, "960×600: nothing scrolls horizontally");
    await t.shot("worktrees-min");
    await h.palette("Create worktree");
    await dialog().waitFor();
    await dialog().getByLabel("Name of the new branch").fill(`team/${long}-zwei`);
    const box = await dialog().boundingBox();
    check(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `960×600: the dialog lies fully inside the window (${JSON.stringify(box)})`);
    equal(await h.escaping('[role="dialog"]'), [], "960×600: nothing sticks out of the dialog");
    await t.shot("worktrees-dialog-min");
    await app.setTheme("light");
    await t.shot("worktrees-dialog-light");
    await app.setTheme("dark");
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes the dialog");
    await app.setSize(1440, 900);
  });

  equal(app.consoleErrors, [], "console errors");
} catch (error) {
  t.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (app) await app.close().catch(() => undefined);
  fx.cleanup();
}
t.finish();
