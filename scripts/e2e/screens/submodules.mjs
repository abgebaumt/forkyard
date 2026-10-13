/**
 * submodules Submodules in the real app against real repositories (local bare repositories as source):
 * left panel section with the four states, "Add submodule" (validation, progress, cancel, errors),
 * Initialize, Update, Update all, open as repository, copy URL, Remove (second confirmation when
 * there are changes), offer after cloning.
 *
 *   node scripts/e2e/screens/submodules.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/submodules.mjs --only remove    only sections whose title contains "remove"
 *   node scripts/e2e/screens/submodules.mjs --show           visible window
 *
 * Checks are made in the repository itself (.gitmodules, `git submodule status`, index, .git/modules).
 * Git only accepts local folders as a source with protocol.file.allow=always: the script first checks
 * the understandable refusal and then adds the permission to the app's global gitconfig, as a user
 * would. The "keyboard only" sections never use the mouse.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { captureClipboard, tamper } from "./commit-panel-lib.mjs";
import { createRun } from "./mustfix-lib.mjs";
import { LIBS, allowFileProtocol, git, gitFile, makeSubmoduleRepo, readGitmodules, sideHelpers, startSilentServer } from "./submodules-lib.mjs";

const show = process.argv.includes("--show");
const t = createRun("submodules");
const { check, equal, eventually, section } = t;

const { fx, libs, clonePath } = makeSubmoduleRepo();
const plain = makeCleanRepoWithRemote({ name: "messnetz" });
const silent = await startSilentServer();

/** `git submodule status` as { path: { flag, sha } }; flag: " " ok, "-" not initialized, "+" differs. */
const subStatus = (repoPath) =>
  Object.fromEntries(
    gitFile(fx, repoPath, "submodule", "status")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const match = /^([ +\-U]?)([0-9a-f]{40}) (\S+)/.exec(line);
        return match ? [match[3], { flag: match[1] || " ", sha: match[2] }] : [line, { flag: "?", sha: "" }];
      }),
  );
const staged = (repoPath) => git(fx, repoPath, "diff", "--cached", "--name-status").split(/\r?\n/).filter(Boolean).map((line) => line.replace(/\s+/g, " "));
const modulePaths = (repoPath) => readGitmodules(repoPath).map((item) => item.path).sort();

let app = null;
try {
  app = await launchApp({ show });
  t.attach(app);
  const { page } = app;
  const h = sideHelpers(app);
  const S = "submodules";
  const dialog = () => page.getByRole("dialog", { name: "Add submodule" });
  const alerts = async (scope) => (await scope.getByRole("alert").allInnerTexts()).join(" | ");
  const state = (key) => h.row(S, key).getAttribute("data-state");
  const rowText = (key) => h.row(S, key).innerText().then((text) => text.replace(/\s+/g, " ").trim());
  // Via the filter bar into the panel, ArrowDown through ref rows and worktrees to the submodule.
  const focusRowByKeyboard = (key) => h.focusRowByKeyboard(S, key);

  const { repoId, tabId } = await app.openRepo(fx.path);
  await h.section(S).waitFor();

  // -------------------------------------------------------------------------------------------
  await section("Layout: four states as word and icon, hint about unfetched submodules", async () => {
    await eventually(() => h.headerText(S), "SUBMODULES 4", "header with count");
    equal(await h.rows(S).evaluateAll((list) => list.map((el) => [el.dataset.sideRow, el.dataset.state])), [
      [LIBS.fresh, "uninitialized"],
      [LIBS.edited, "modified"],
      [LIBS.drifted, "out_of_sync"],
      [LIBS.ready, "initialized"],
    ], "four submodules in four states (as reported by the core)");
    check(/^protokoll ?extern\/ not initialized$/.test(await rowText(LIBS.fresh)), `not initialized: as a word (${await rowText(LIBS.fresh)})`);
    check(/^auswertung-kern ?libs\/ modified · [0-9a-f]{7}/.test(await rowText(LIBS.edited)), `modified: as a word with commit (${await rowText(LIBS.edited)})`);
    check(/^karten-kacheln ?libs\/ differs · [0-9a-f]{7} instead of [0-9a-f]{7}$/.test(await rowText(LIBS.drifted)), `differs: checked-out instead of recorded commit (${await rowText(LIBS.drifted)})`);
    check(/^sensor-treiber ?libs\/ initialized · [0-9a-f]{7}/.test(await rowText(LIBS.ready)), `initialized: as a word with commit (${await rowText(LIBS.ready)})`);
    const icons = await h.rows(S).evaluateAll((list) => list.map((el) => el.querySelector("svg.lucide")?.getAttribute("class")?.match(/lucide-([a-z0-9-]+)/)?.[1] ?? null));
    equal(new Set(icons).size, 4, `each state has its own icon (${icons.join(", ")})`);
    equal(await h.rowLabels(S), [
      "Submodule extern/protokoll, not initialized",
      "Submodule libs/auswertung-kern, modified, branch main",
      `Submodule libs/karten-kacheln, differs, checked out ${libs.drifted.shas[0].slice(0, 7)}, recorded ${libs.drifted.shas[2].slice(0, 7)}`,
      "Submodule libs/sensor-treiber, initialized, branch main",
    ], "screen reader text names path and state");
    check(/1 not initialized/.test((await h.section(S).locator('[role="tree"]').getAttribute("aria-label")) ?? ""), "the list summarizes the states in its name");

    const hint = h.section(S).locator("[data-submodule-hint]");
    equal((await hint.innerText()).replace(/\s+/g, " ").trim(), "1 not fetched yet Initialize", "hint in the section with offer");
    const offer = await t.waitToast(/One submodule has not been fetched yet/, "info");
    check(/extern\/protokoll/.test(offer?.text ?? "") && /Initialize now/.test(offer?.text ?? ""), `one-time message names the submodule and offers to initialize (${offer?.text})`);
    equal(await page.locator('[data-screen="sidebar"] [data-section]').count(), 4, "the panel's four ref sections are unchanged");
    await page.waitForTimeout(300);
    await t.shot("submodules-section");
    await app.setTheme("light");
    await t.shot("submodules-section-light");
    await app.setTheme("dark");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Add – keyboard only; local source only after permission", async () => {
    const before = { modules: modulePaths(fx.path), status: git(fx, fx.path, "status", "--short") };
    await h.palette("Add submodule");
    await dialog().waitFor();
    await eventually(async () => (await t.focused()).label, "Address", "focus in the \"Address\" field");
    await t.shot("submodules");

    // Submit empty
    await page.keyboard.press("Enter");
    await eventually(async () => /Enter the address of the repository/.test(await alerts(dialog())), true, "without address: error at the field");
    check(/Enter the folder/.test(await alerts(dialog())), "without folder: error at the field");

    // Address that does not work
    await page.keyboard.type("ftp://server.example/bibliothek.git");
    await eventually(async () => /“ftp:\/\/” isn't supported here/.test(await alerts(dialog())), true, "unsupported protocol: reason at the field");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("git@git.schulserver.example:werkzeuge/wetter-symbole.git");
    await eventually(() => dialog().getByLabel("Folder in the repository").inputValue(), "wetter-symbole", "folder is suggested from the address");
    equal((await dialog().locator("[data-url-kind]").innerText()).trim(), "git.schulserver.example · SSH", "badge names server and kind");
    await page.keyboard.press("Control+a");
    await page.keyboard.type(libs.extra.path);
    await eventually(() => dialog().locator("[data-url-kind]").getAttribute("data-url-kind"), "local", "a folder counts as a local source");
    check(/protocol\.file\.allow/.test(await dialog().innerText()), "with a local source the protocol.file.allow hint is already at the field");
    equal(await dialog().getByLabel("Folder in the repository").inputValue(), "wetter-symbole", "suggestion stays at the name of the source");

    // Validate the folder
    await page.keyboard.press("Tab");
    equal((await t.focused()).label, "Folder in the repository", "Tab leads to the folder");
    for (const [value, pattern, what] of [
      ["../draussen", /leads out of the repository/, "\"..\""],
      ["C:\\anderswo\\lib", /no drive/, "drive"],
      [".git/haken", /belongs to Git itself/, "\".git\""],
      [LIBS.ready, /already a submodule at this path/, "path already taken"],
      [`${LIBS.ready}/unter`, /inside another submodule/, "path inside another submodule"],
    ]) {
      await page.keyboard.press("Control+a");
      await page.keyboard.type(value);
      await eventually(async () => pattern.test(await alerts(dialog())), true, `folder ${what}: reason at the field`);
    }
    await page.keyboard.press("Control+a");
    await page.keyboard.type("libs\\wetter-symbole");
    await eventually(() => alerts(dialog()), "", "valid folder: no error");
    await eventually(async () => (await dialog().locator("[data-submodule-target]").innerText()).replace(/\s+/g, ""), `Willbeembeddedat:${path.join(fx.path, "libs", "wetter-symbole")}`.replace(/\s+/g, ""), "preview of the target folder (backslashes become slashes)");

    // Without the permission the core refuses the local source – understandably, and nothing is left behind
    await page.keyboard.press("Enter");
    await eventually(() => dialog().locator("[data-submodule-error]").getAttribute("data-submodule-error"), "not_allowed", "local source without permission: refusal in the dialog");
    const refusal = (await dialog().locator("[data-submodule-error]").innerText()).replace(/\s+/g, " ");
    check(/protocol\.file\.allow/.test(refusal) && /Nothing was left behind in the repository/.test(refusal), `the refusal names the setting and that nothing is left behind (${refusal})`);
    equal(await t.toasts(), [], "no toast for an error in the dialog");
    equal({ modules: modulePaths(fx.path), status: git(fx, fx.path, "status", "--short") }, before, "git: .gitmodules and status unchanged");
    check(!fs.existsSync(path.join(fx.path, "libs", "wetter-symbole")), "no folder left behind");
    await t.shot("submodules-error");

    // With the permission in the gitconfig the same attempt succeeds
    allowFileProtocol(app);
    await page.keyboard.press("Enter");
    await eventually(() => dialog().count(), 0, "the dialog closes after adding", 60_000);
    await t.waitToast(/Submodule “libs\/wetter-symbole” added/, "success");
    const entry = readGitmodules(fx.path).find((item) => item.path === "libs/wetter-symbole");
    equal([entry?.path, entry?.url && path.resolve(entry.url)], ["libs/wetter-symbole", path.resolve(libs.extra.path)], ".gitmodules: path and URL recorded");
    equal(subStatus(fx.path)["libs/wetter-symbole"], { flag: " ", sha: libs.extra.shas[1] }, "git submodule status: checked out at the newest commit of the source");
    check(fs.existsSync(path.join(fx.path, "libs", "wetter-symbole", "symbole", "sonne.svg")), "the submodule's files are in the folder");
    equal(staged(fx.path), ["M .gitmodules", "A libs/wetter-symbole"], "git: the entry is staged");
    await eventually(() => h.headerText(S), "SUBMODULES 5", "header counts five");
    await eventually(() => state("libs/wetter-symbole"), "initialized", "the new row is \"initialized\"");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Add: occupied folder, source without repository", async () => {
    await h.section(S).locator("[data-section-header]").hover();
    await h.section(S).locator('[data-action="add"]').click();
    await dialog().waitFor();
    await dialog().getByLabel("Address").fill(libs.extra.path);
    await dialog().getByLabel("Folder in the repository").fill("src");
    await dialog().getByRole("button", { name: "Add submodule" }).click();
    await eventually(async () => /Something is already there/.test(await alerts(dialog())), true, "occupied folder: message at the field", 30_000);
    equal(await dialog().locator("[data-submodule-error]").getAttribute("data-submodule-error"), "path_exists", "and as a refusal with explanation");
    check(!modulePaths(fx.path).includes("src"), "git: nothing recorded");

    await dialog().getByLabel("Address").fill(path.join(fx.root, "gibt-es-nicht.git"));
    await dialog().getByLabel("Folder in the repository").fill("libs/fehlt");
    await dialog().getByRole("button", { name: "Add submodule" }).click();
    await eventually(() => dialog().locator("[data-submodule-error]").count(), 1, "missing source: refusal in the dialog", 30_000);
    await eventually(() => dialog().locator("form").getAttribute("data-state"), "error", "state \"error\"");
    const failure = (await dialog().locator("[data-submodule-error]").innerText()).replace(/\s+/g, " ");
    check(failure.length > 40 && /Nothing was left behind/.test(failure), `the refusal is a full sentence (${failure})`);
    check(!modulePaths(fx.path).includes("libs/fehlt") && !fs.existsSync(path.join(fx.path, "libs", "fehlt")), "git: nothing recorded, no folder");
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes");
  });

  // -------------------------------------------------------------------------------------------
  await section("Progress and cancel while fetching", async () => {
    const before = { modules: modulePaths(fx.path), status: git(fx, fx.path, "status", "--short") };
    await page.evaluate(() => window.__gc.store.getState().openOverlay({ kind: "add_submodule" }));
    await dialog().waitFor();
    await dialog().getByLabel("Address").fill(silent.url("langsam/kartenmaterial.git"));
    await eventually(() => dialog().getByLabel("Folder in the repository").inputValue(), "kartenmaterial", "suggestion from the address");
    await dialog().getByRole("button", { name: "Add submodule" }).click();
    await eventually(() => dialog().locator("form").getAttribute("data-state"), "running", "the dialog shows the progress");
    await dialog().getByRole("progressbar").waitFor();
    check(/From/.test(await dialog().innerText()) && (await dialog().innerText()).includes("kartenmaterial"), "progress names source and target");
    await eventually(async () => (await page.locator('[role="status"], footer, [data-statusbar]').allInnerTexts()).join(" ").includes("Fetch submodule: kartenmaterial"), true, "the job also shows in the status bar");
    await eventually(() => silent.connections() > 0, true, "Git has opened the connection");
    await t.shot("submodules-progress");

    // Esc does not simply close: ask first
    await page.keyboard.press("Escape");
    await eventually(async () => /The submodule is still being fetched/.test(await dialog().innerText()), true, "Esc while fetching asks first");
    await eventually(async () => (await t.focused()).text, "Keep fetching", "focus on \"Keep fetching\"");
    await page.keyboard.press("Enter");
    await eventually(async () => /The submodule is still being fetched/.test(await dialog().innerText()), false, "\"Keep fetching\" keeps the job running");
    equal(await dialog().locator("form").getAttribute("data-state"), "running", "it is still running");

    await dialog().getByRole("button", { name: "Cancel fetch" }).click();
    await eventually(() => dialog().locator("[data-submodule-cancelled]").count(), 1, "after cancelling the notice is shown in the dialog", 30_000);
    equal(await dialog().getByLabel("Address").inputValue(), silent.url("langsam/kartenmaterial.git"), "the inputs are still there");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "a cancel is not an error");
    equal({ modules: modulePaths(fx.path), status: git(fx, fx.path, "status", "--short") }, before, "git: .gitmodules and status unchanged");
    check(!fs.existsSync(path.join(fx.path, "kartenmaterial")), "no half folder");
    check(!fs.existsSync(path.join(fx.path, ".git", "modules", "kartenmaterial")), "no leftovers under .git/modules");
    await t.shot("submodules-cancelled");
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes");
  });

  // -------------------------------------------------------------------------------------------
  await section("Initialize and update – keyboard only", async () => {
    equal(subStatus(fx.path)[LIBS.fresh]?.flag, "-", "starting point: extern/protokoll is not initialized");
    check(await focusRowByKeyboard(LIBS.fresh), "Tab and arrow keys reach the row");
    await page.keyboard.press("Enter");
    const info = await t.waitToast(/“extern\/protokoll” has not been fetched yet/, "info");
    check(/can only be opened once it is initialized/.test(info?.text ?? ""), "Enter on an unfetched submodule explains why it cannot be opened");
    await page.keyboard.press("Shift+F10");
    await h.menu().first().waitFor();
    const items = await h.menuItems();
    check(items.find((item) => /Open as repository/.test(item.text))?.disabled, "menu: \"Open as repository\" blocked while not initialized");
    check(await h.chooseByKeyboard(/^Initialize/), "Shift+F10, then \"Initialize\" with arrow keys and Enter");
    await t.waitToast(/Submodule “extern\/protokoll” is at the recorded commit/, "success");
    equal(subStatus(fx.path)[LIBS.fresh], { flag: " ", sha: libs.fresh.shas[0] }, "git submodule status: initialized at the recorded commit");
    check(fs.existsSync(path.join(fx.path, LIBS.fresh, "LIESMICH.md")), "the files are there");
    await eventually(() => state(LIBS.fresh), "initialized", "the row is \"initialized\"");
    await eventually(() => h.section(S).locator("[data-submodule-hint]").count(), 0, "the \"not fetched yet\" hint is gone");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-side-row")), LIBS.fresh, "focus is back on the row");
    await t.closeToasts();

    // Differing commit: Update checks out the recorded one
    equal(subStatus(fx.path)[LIBS.drifted]?.flag, "+", "starting point: libs/karten-kacheln differs");
    check(await focusRowByKeyboard(LIBS.drifted), "row reached by keyboard");
    await page.keyboard.press("Shift+F10");
    check(await h.chooseByKeyboard(/^Update/), "\"Update\" by keyboard");
    await t.waitToast(/Submodule “libs\/karten-kacheln” is at the recorded commit/, "success");
    equal(subStatus(fx.path)[LIBS.drifted], { flag: " ", sha: libs.drifted.shas[2] }, "git submodule status: back at the recorded commit");
    await eventually(() => state(LIBS.drifted), "initialized", "the row is \"initialized\"");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Update fails because of own changes – understandably", async () => {
    // In the submodule: older commit checked out AND the same file changed that the recorded commit changes.
    const sub = path.join(fx.path, LIBS.ready);
    git(fx, sub, "checkout", "-q", libs.ready.shas[0]);
    fs.writeFileSync(path.join(sub, "LIESMICH.md"), "# sensor-treiber\n\nEigener Entwurf, nicht committet.\n");
    await h.windowFocus();
    await eventually(() => state(LIBS.ready), (value) => value === "modified" || value === "out_of_sync", "the row shows that something differs in the submodule");
    await h.row(S, LIBS.ready).hover();
    await h.row(S, LIBS.ready).locator('[data-action="update"]').click();
    const toast = await t.waitToast(/Update submodule failed/, "danger");
    check(/Open the submodule as a repository/.test(toast?.text ?? ""), `the message says what to do (${toast?.text})`);
    equal(fs.readFileSync(path.join(sub, "LIESMICH.md"), "utf8").includes("Eigener Entwurf"), true, "git: the own change is untouched");
    equal(git(fx, sub, "rev-parse", "HEAD"), libs.ready.shas[0], "git: nothing was checked out in the submodule");
    await t.shot("submodules-update-error");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Open as repository, copy URL", async () => {
    const clipboard = await captureClipboard(page);
    await h.row(S, LIBS.drifted).click({ button: "right" });
    await h.menu().first().waitFor();
    equal(await page.locator('[role="menu"]').count(), 1, "only one menu open (not also the panel's)");
    await t.shot("submodules-menu");
    await page.getByRole("menuitem", { name: /Copy URL/ }).click();
    await t.waitToast(/Submodule URL copied/, "success");
    equal((await clipboard.copied()).map((text) => path.resolve(text)), [path.resolve(libs.drifted.path)], "the clipboard holds the URL from .gitmodules");
    await t.closeToasts();

    await h.row(S, LIBS.drifted).dblclick();
    await eventually(async () => (await h.tabs()).find((tab) => tab.active)?.title, "karten-kacheln", "double-click opens the submodule as a repository in a tab");
    await app.settle();
    const opened = (await app.invoke("repo_list")).find((repo) => repo.path.replaceAll("\\", "/").toLowerCase().endsWith("station/libs/karten-kacheln"));
    check(Boolean(opened), "core: the submodule is in the repository list");
    await eventually(async () => (await page.locator('[data-screen="commit-graph"], [role="grid"]').first().innerText()).includes("karten-kacheln: Stand 3"), true, "the tab shows the submodule's history");
    await page.keyboard.press("Control+w");
    await eventually(async () => (await h.tabs()).length, 1, "tab closed again");
    await h.activateTab(tabId).catch(() => undefined);
  });

  // -------------------------------------------------------------------------------------------
  await section("Remove: confirmation, cancel; with changes only after the second confirmation", async () => {
    // Clean submodule, keyboard only
    check(await focusRowByKeyboard(LIBS.fresh), "row reached by keyboard");
    await page.keyboard.press("Delete");
    const ask = await t.waitDialog(/Remove submodule “extern\/protokoll”\?/);
    await eventually(async () => (await t.focused()).text, "Cancel", "confirmation: focus on \"Cancel\"");
    const text = await ask.innerText();
    check(/taken out of \.gitmodules/.test(text) && /staged/.test(text) && text.includes("extern/protokoll"), "the confirmation says what happens and that it only takes effect with the commit");
    await t.shot("submodules-remove");
    await page.keyboard.press("Enter");
    await eventually(() => t.dialog().count(), 0, "Enter on \"Cancel\" closes");
    check(modulePaths(fx.path).includes(LIBS.fresh), "Cancel removes nothing");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-side-row")), LIBS.fresh, "after the confirmation focus is back on the row");

    await page.keyboard.press("Delete");
    await t.waitDialog(/Remove submodule “extern\/protokoll”\?/);
    await page.keyboard.press("Tab");
    await eventually(async () => (await t.focused()).text, "Remove submodule", "Tab to the red button");
    await page.keyboard.press("Enter");
    await t.waitToast(/Submodule “extern\/protokoll” removed/, "success");
    check(!modulePaths(fx.path).includes(LIBS.fresh), ".gitmodules: the entry is gone");
    check(!fs.existsSync(path.join(fx.path, LIBS.fresh)), "the folder is deleted");
    check(!fs.existsSync(path.join(fx.path, ".git", "modules", "extern", "protokoll")), "the Git directory under .git/modules is deleted");
    check(staged(fx.path).includes("D extern/protokoll"), `git: the removal is staged (${staged(fx.path).join(", ")})`);
    await eventually(() => h.row(S, LIBS.fresh).count(), 0, "the row is gone");
    await eventually(async () => Boolean(await page.evaluate(() => document.activeElement?.closest('[data-extra-section="submodules"]'))), true, "focus stays in the section");
    await t.closeToasts();

    // Modified (untracked file in the submodule): second confirmation
    equal(await state(LIBS.edited), "modified", "starting point: libs/auswertung-kern is \"modified\"");
    await h.row(S, LIBS.edited).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Remove submodule/ }).click();
    await (await t.waitDialog(/Remove submodule “libs\/auswertung-kern”\?/)).getByRole("button", { name: "Remove submodule" }).click();
    const warn = await t.waitDialog(/Remove “libs\/auswertung-kern” including its own changes\?/);
    await eventually(async () => (await t.focused()).text, "Cancel", "second confirmation: focus on \"Cancel\"");
    check(/uncommitted changes/.test(await warn.innerText()) && /cannot be recovered/.test(await warn.innerText()), "the second confirmation says what will be lost");
    await t.shot("submodules-force");
    await page.keyboard.press("Enter");
    await eventually(() => t.dialog().count(), 0, "Cancel closes");
    check(modulePaths(fx.path).includes(LIBS.edited) && fs.existsSync(path.join(fx.path, LIBS.edited, "NOTIZ.md")), "after cancelling the submodule and the own file are still there");

    await h.row(S, LIBS.edited).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Remove submodule/ }).click();
    await (await t.waitDialog(/Remove submodule “libs\/auswertung-kern”\?/)).getByRole("button", { name: "Remove submodule" }).click();
    await (await t.waitDialog(/including its own changes\?/)).getByRole("button", { name: "Remove anyway" }).click();
    await t.waitToast(/Submodule “libs\/auswertung-kern” removed/, "success");
    check(!modulePaths(fx.path).includes(LIBS.edited) && !fs.existsSync(path.join(fx.path, LIBS.edited)), "git: entry and folder are gone");
    await t.closeToasts();

    // Differing commit: dedicated wording of the second confirmation
    const sub = path.join(fx.path, LIBS.drifted);
    git(fx, sub, "checkout", "-q", libs.drifted.shas[1]);
    await h.windowFocus();
    await eventually(() => state(LIBS.drifted), "out_of_sync", "libs/karten-kacheln differs again");
    await h.row(S, LIBS.drifted).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Remove submodule/ }).click();
    await (await t.waitDialog(/Remove submodule “libs\/karten-kacheln”\?/)).getByRole("button", { name: "Remove submodule" }).click();
    const drift = await t.waitDialog(/Remove “libs\/karten-kacheln” despite the differing commit\?/);
    check((await drift.innerText()).includes(libs.drifted.shas[1].slice(0, 7)) && (await drift.innerText()).includes(libs.drifted.shas[2].slice(0, 7)), "the confirmation names both commits");
    await drift.getByRole("button", { name: "Remove anyway" }).click();
    await t.waitToast(/Submodule “libs\/karten-kacheln” removed/, "success");
    check(!modulePaths(fx.path).includes(LIBS.drifted), ".gitmodules: the entry is gone");
    await t.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("After cloning: offer to initialize, \"Update all\"", async () => {
    equal(Object.values(subStatus(clonePath)).map((item) => item.flag), ["-", "-", "-", "-"], "starting point: no submodule fetched in the fresh clone");
    const cloned = await app.openRepo(clonePath);
    await h.section(S).waitFor();
    const offer = await t.waitToast(/4 submodules have not been fetched yet/, "info");
    check(/Initialize now/.test(offer?.text ?? ""), "message after opening the clone offers to initialize");
    await eventually(async () => (await h.section(S).locator("[data-submodule-hint]").innerText()).replace(/\s+/g, " ").trim(), "4 not fetched yet Initialize", "hint in the section");
    await t.shot("submodules-offer");
    await page.locator("[data-toast]").getByRole("button", { name: "Initialize now" }).click();
    await eventually(() => h.section(S).locator("[data-submodule-busy]").count(), 1, "the section header shows a spinner while fetching").catch(() => undefined);
    await t.waitToast(/4 submodules are at the recorded commit/, "success", 90_000);
    equal(Object.values(subStatus(clonePath)).map((item) => item.flag), [" ", " ", " ", " "], "git submodule status: all four initialized");
    await eventually(() => h.rows(S).evaluateAll((list) => list.map((el) => el.dataset.state)), ["initialized", "initialized", "initialized", "initialized"], "all rows are \"initialized\"");
    await eventually(() => h.section(S).locator("[data-submodule-hint]").count(), 0, "the hint is gone");
    await t.closeToasts();

    // Two differ: "Update all" via the command palette
    git(fx, path.join(clonePath, LIBS.drifted), "checkout", "-q", libs.drifted.shas[0]);
    git(fx, path.join(clonePath, LIBS.ready), "checkout", "-q", libs.ready.shas[0]);
    await h.windowFocus();
    await eventually(() => h.rows(S).evaluateAll((list) => list.filter((el) => el.dataset.state === "out_of_sync").length), 2, "two submodules differ");
    await h.palette("Update all submodules");
    await t.waitToast(/4 submodules are at the recorded commit/, "success", 90_000);
    equal(Object.values(subStatus(clonePath)).map((item) => item.flag), [" ", " ", " ", " "], "git submodule status: all back at the recorded commit");
    await t.closeToasts();

    // The message appears only once per repository
    git(fx, clonePath, "-c", "protocol.file.allow=always", "submodule", "deinit", "-q", "-f", LIBS.fresh);
    await h.windowFocus();
    await eventually(() => h.section(S).locator("[data-submodule-hint]").count(), 1, "the hint in the section comes back");
    await page.waitForTimeout(400);
    equal((await t.toasts()).filter((toast) => /not been fetched yet/.test(toast.text)), [], "the message does not appear a second time");
    // Update all via the button in the header
    await h.section(S).locator("[data-section-header]").hover();
    await h.section(S).locator('[data-action="update-all"]').click();
    await t.waitToast(/4 submodules are at the recorded commit/, "success", 90_000);
    equal(subStatus(clonePath)[LIBS.fresh]?.flag, " ", "git: \"Update all\" also fetches the uninitialized one");
    await t.closeToasts();
    check(Boolean(cloned.repoId), "clone opened");
  });

  // -------------------------------------------------------------------------------------------
  await section("States: empty, filter, collapsed, hidden, loading, error", async () => {
    const opened = await app.openRepo(plain.path);
    await h.section(S).waitFor();
    await eventually(() => h.headerText(S), "SUBMODULES 0", "repository without submodules: header with 0");
    equal((await h.section(S).locator("[data-empty]").innerText()).replace(/\s+/g, " ").trim(), "No submodules Add", "empty state with an action");
    await t.shot("submodules-empty");
    await h.section(S).getByRole("button", { name: "Add", exact: true }).click();
    await dialog().waitFor();
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "\"Add\" opens the dialog, Esc closes it");
    check(Boolean(opened.repoId), "opened");

    await h.activateTab((await page.evaluate(() => window.__gc.queryClient.getQueryData(["app", "tabs"]).find((tab) => tab.title === "station-klon")?.id)) ?? tabId);
    await h.section(S).waitFor();
    const cloneRepoId = await page.evaluate(() => window.__gc.queryClient.getQueryData(["app", "tabs"]).find((tab) => tab.isActive).repoId);
    const filter = page.locator("[data-left-filter]");
    await filter.fill("kacheln");
    await eventually(() => h.headerText(S), "SUBMODULES 1/4", "filter: only the match, with \"1/4\" in the header");
    equal(await h.row(S, LIBS.drifted).locator("mark").innerText(), "kacheln", "the match is highlighted");
    await filter.fill("protokoll.git");
    await eventually(() => h.rows(S).evaluateAll((list) => list.map((el) => el.dataset.sideRow)), [LIBS.fresh], "the filter also searches the URL");
    await filter.fill("gibt-es-nicht");
    await eventually(() => h.section(S).count(), 0, "without matches the section disappears");
    await filter.fill("");
    await eventually(() => h.headerText(S), "SUBMODULES 4", "without filter all again");

    await h.header(S).click();
    await eventually(() => h.rows(S).count(), 0, "clicking the header collapses");
    await eventually(async () => (await app.invoke("view_state_get", { repoId: cloneRepoId })).sections.find((item) => item.id === "submodules")?.collapsed, true, "remembered in the core: submodules collapsed");
    await h.header(S).click();
    await eventually(() => h.rows(S).count(), 4, "another click expands");
    await h.header(S).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Hide section/ }).click();
    await eventually(() => h.section(S).count(), 0, "hidden via the header menu");
    await page.locator('[data-screen="sidebar"] [data-section="tags"] [data-section-header]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Submodules" }).click();
    await eventually(() => h.section(S).count(), 1, "it comes back via another section's menu");

    const slow = await tamper(page, "submoduleList", { delayMs: 1500 });
    await page.evaluate((id) => void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "submodules"] }), cloneRepoId);
    await eventually(() => h.section(S).locator("[data-skeleton]").count(), 1, "skeleton while the list loads");
    equal(await h.headerText(S), "SUBMODULES", "no number in the header");
    await t.shot("submodules-loading");
    await slow.restore();
    await eventually(() => h.rows(S).count(), 4, "afterwards the rows are there");

    const broken = await tamper(page, "submoduleList", { fail: { code: "io", message: ".gitmodules is not readable.", gitOutput: null } });
    await page.evaluate((id) => void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "submodules"] }), cloneRepoId);
    await eventually(async () => (await h.section(S).locator("[data-load-error]").innerText().catch(() => "")).includes(".gitmodules is not readable."), true, "error is shown in the section");
    await t.shot("submodules-load-error");
    // Restore and press in one go – a core event in between would reload the list by itself.
    check(await broken.restoreAndPress(`[data-extra-section="${S}"]`, "Try again"), "there is \"Try again\"");
    await eventually(() => h.rows(S).count(), 4, "\"Try again\" loads the list");
  });

  // -------------------------------------------------------------------------------------------
  await section("Many submodules, very long names, 960×600", async () => {
    // 40 more entries directly in the index and .gitmodules (not fetched), plus a very long path with a long URL.
    const sha = libs.fresh.shas[0];
    const longPath = "extern/drittanbieter/kartenmaterial/hoehenmodelle-und-gelaendeschummerung-fuer-das-einzugsgebiet-der-stationen";
    const entries = [[longPath, `https://git.schulserver-nord.example/${"archiv-und-auswertung/".repeat(6)}hoehenmodelle.git`]];
    for (let index = 1; index <= 40; index++) entries.push([`module/baustein-${String(index).padStart(2, "0")}`, libs.fresh.path]);
    let modules = fs.readFileSync(path.join(clonePath, ".gitmodules"), "utf8");
    for (const [subPath, url] of entries) {
      git(fx, clonePath, "update-index", "--add", "--cacheinfo", `160000,${sha},${subPath}`);
      modules += `[submodule "${subPath}"]\n\tpath = ${subPath}\n\turl = ${url.replaceAll("\\", "/")}\n`;
    }
    fs.writeFileSync(path.join(clonePath, ".gitmodules"), modules);
    await h.windowFocus();
    await eventually(() => h.headerText(S), "SUBMODULES 45", "45 submodules in the list", 30_000);
    equal(await h.rows(S).count(), 45, "all rows are there");
    await eventually(async () => (await h.section(S).locator("[data-submodule-hint]").innerText()).replace(/\s+/g, " ").trim(), "41 not fetched yet Initialize", "hint counts the unfetched ones");
    equal(await h.panelOverflow(), { page: 0, panel: 0 }, "nothing scrolls horizontally – long paths are truncated");
    await h.row(S, longPath).scrollIntoViewIfNeeded();
    await t.closeToasts();
    await t.shot("submodules-many");

    await app.setSize(960, 600);
    // Below 1100 px the left panel collapses. Only once the app has processed the new width is it certain
    // whether it is closed – otherwise the check would still see it open and it would collapse right after.
    await page.waitForFunction(() => window.__gc.store.getState().narrow === true, null, { timeout: 10_000 });
    await app.settle();
    if ((await h.section(S).count()) === 0) await page.keyboard.press("Control+j");
    await h.section(S).waitFor();
    await h.row(S, LIBS.ready).scrollIntoViewIfNeeded();
    equal(await h.panelOverflow(), { page: 0, panel: 0 }, "960×600: nothing scrolls horizontally");
    await t.shot("submodules-section-min");
    await h.palette("Add submodule");
    await dialog().waitFor();
    await dialog().getByLabel("Address").fill(`https://git.schulserver-nord.example/${"archiv-und-auswertung/".repeat(8)}hoehenmodelle-und-gelaendeschummerung.git`);
    const box = await dialog().boundingBox();
    check(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `960×600: the dialog lies fully inside the window (${JSON.stringify(box)})`);
    equal(await h.escaping('[role="dialog"]'), [], "960×600: nothing sticks out of the dialog, not even with a 200 character address");
    await t.shot("submodules-min");
    await app.setTheme("light");
    await t.shot("submodules-light");
    await app.setTheme("dark");
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes the dialog");
    await app.setSize(1440, 900);
  });

  check(Boolean(repoId), "repository opened");
  equal(app.consoleErrors, [], "console errors");
} catch (error) {
  t.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (app) await app.close().catch(() => undefined);
  await silent.close().catch(() => undefined);
  fx.cleanup();
  plain.cleanup();
}
t.finish();
