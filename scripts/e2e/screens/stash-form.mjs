/**
 * stash-form – stash form in the commit panel, in the real app against real Git repositories.
 *
 *   node scripts/e2e/screens/stash-form.mjs            everything
 *   node scripts/e2e/screens/stash-form.mjs --show     visible window
 *
 * Also checked in the repository: `git stash list`, stash contents, what stays in the working tree.
 * The first section works without the mouse.
 */
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeEmptyRepo, makeRichRepo } from "../fixtures.mjs";
import { createChecks, exists, lines, readFile, wipDriver, writeFile } from "./_wip.mjs";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots";
const checks = createChecks("stash-form");
const { check, equal, eventually, section, finish } = checks;

const repos = [];
const fixture = async (make, ...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const repo = make(...args);
      repos.push(repo);
      return repo;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
};
let app = null;
let ui = null;

const panelMode = (tabId) => ui.view(tabId).then((view) => view.rightPanel);
const stashButton = () => ui.page.locator('button[data-action="stash"]');
const nameField = () => ui.page.getByRole("textbox", { name: "Stash name" });
const press = (keys) => ui.page.keyboard.press(keys);
const closeTab = async () => {
  await ui.closeToasts();
};
const run = (title, body) =>
  section(title, body, async (name) => {
    if (app) await app.screenshot(`target/e2e/stash-form-error-${name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
  });

try {
  app = await launchApp({ show });
  ui = wipDriver(app, checks);

  // -------------------------------------------------------------------------------------------
  await run("Named stash with the keyboard only", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "stash-tastatur" });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nHalbfertig.\n`);
    writeFile(repo, "notizen/entwurf.md", "nicht verfolgt\n");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });

    // Tab to the "Commit | Stash" toggle, arrow right moves to "Stash", space selects.
    await ui.tabUntil(() => document.activeElement?.closest('[aria-label="Form"]') !== null);
    await press("ArrowRight");
    await eventually(() => panelMode(tabId), "stash_form", "arrow right in the toggle opens the stash form");
    await eventually(() => ui.page.evaluate(() => document.activeElement?.textContent), "Stash", "focus stays in the toggle");
    await ui.page.locator('[data-screen="stash-form"]').waitFor({ timeout: 5000 });
    equal(await ui.rows("unstaged"), ["README.md", "notizen/entwurf.md"], "the file lists stay");

    await ui.tabToField("Stash name");
    await ui.page.keyboard.type("Auswertung März, halbfertig");
    equal(await ui.checkbox("Include untracked files").getAttribute("aria-checked"), "true", "\"Include untracked files\" is preselected");
    check(await ui.checkbox("Only the marked files").isDisabled(), "\"Only the marked files\" is disabled without marked files");
    // Enter in the name field creates the stash.
    await press("Enter");
    await ui.waitToast("success", /stashed/);
    equal(lines(repo.git("stash", "list", "--format=%gs")), ["On main: Auswertung März, halbfertig"], "git: stash with the name");
    equal(lines(repo.git("show", "--name-only", "--format=", "stash@{0}^3")), ["notizen/entwurf.md"], "git: the untracked file is in the stash");
    equal(repo.git("status", "--porcelain"), "", "git: working tree clean");
    await eventually(() => panelMode(tabId), "details", "afterwards it returns to the commit form");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("Partial stash: only marked files, without untracked", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "stash-teil" });
    writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nBleibt.\n`);
    writeFile(repo, "stationen.csv", `${readFile(repo, "stationen.csv")}W;Wald;212\n`);
    writeFile(repo, "src/vergleich.py", `${readFile(repo, "src/vergleich.py")}\n# geht in den Stash\n`);
    writeFile(repo, "notizen/neu.txt", "nicht verfolgt\n");
    repo.git("add", "src/vergleich.py");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await ui.waitCounts(repoId, { unstaged: 3, staged: 1, conflicted: 0 });
    await ui.page.getByRole("radio", { name: "Stash" }).click();
    await ui.page.locator('[data-screen="stash-form"]').waitFor({ timeout: 5000 });

    // Mark one file from each list.
    await ui.row("unstaged", "stationen.csv").click();
    await ui.row("staged", "src/vergleich.py").click({ modifiers: ["Control"] });
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await ui.checkbox("Only the marked files").click();
    equal(await ui.checkbox("Only the marked files").textContent().catch(() => null), "", "checkbox without text (the caption is in the label)");
    check((await ui.page.getByText("Only the marked files (2)").count()) === 1, "the label shows the number of marked files");
    await eventually(async () => (await stashButton().textContent())?.trim(), "Stash 2 files", "caption \"Stash 2 files\"");
    await nameField().fill("Nur Stationen und Vergleich");
    await app.screenshot(`${SHOTS}/stash-form-partial.png`);
    await stashButton().click();
    await ui.waitToast("success", /stashed/);
    equal(lines(repo.git("stash", "list", "--format=%gs")), ["On main: Nur Stationen und Vergleich"], "git: stash created");
    equal(lines(repo.git("stash", "show", "--name-only", "stash@{0}")).sort(), ["src/vergleich.py", "stationen.csv"], "git: exactly the marked files in the stash");
    equal(lines(repo.git("status", "--porcelain", "--untracked-files=all")).sort(), [" M README.md", "?? notizen/neu.txt"], "git: the rest stays in the working tree");
    check(!readFile(repo, "stationen.csv").includes("Wald"), "file: stationen.csv is reset");
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });

    // Without untracked files: only the tracked README goes into the stash.
    await ui.page.getByRole("radio", { name: "Stash" }).click();
    await ui.checkbox("Include untracked files").click();
    await stashButton().click();
    await ui.waitToast("success", /stashed/);
    equal(lines(repo.git("stash", "list")).length, 2, "git: second stash");
    equal(lines(repo.git("stash", "show", "--name-only", "stash@{0}")), ["README.md"], "git: only the tracked file in the stash");
    check(exists(repo, "notizen/neu.txt"), "file: the untracked file stays");
    const unnamed = lines(repo.git("stash", "list", "--format=%gs"))[0] ?? "";
    check(/^WIP on main: [0-9a-f]{7,} /.test(unnamed), `git: without a name the stash gets the usual Git name (${unnamed})`);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 });

    // Only one untracked file left, option off: disabled with a reason.
    await ui.page.getByRole("radio", { name: "Stash" }).click();
    await eventually(() => ui.checkbox("Include untracked files").getAttribute("aria-checked"), "false", "the option stays off");
    equal(await stashButton().getAttribute("aria-disabled"), "true", "only untracked files and option off: disabled");
    await stashButton().hover();
    await ui.page.getByRole("tooltip").filter({ hasText: /only untracked files/ }).first().waitFor({ timeout: 5000 });
    await stashButton().click({ force: true });
    equal(lines(repo.git("stash", "list")).length, 2, "git: a click while disabled creates nothing");
    await ui.checkbox("Include untracked files").click();
    await ui.page.mouse.move(700, 500);
    await ui.page.getByRole("button", { name: "Back to commit" }).click();
    await eventually(() => panelMode(tabId), "details", "\"Back to commit\"");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await run("States: nothing to stash, empty repository, long names, screenshots", async () => {
    const empty = await fixture(makeEmptyRepo, { name: "stash-ohne-commit" });
    const opened = await app.openRepo(empty.path);
    await ui.waitCounts(opened.repoId, { unstaged: 1, staged: 0, conflicted: 0 });
    await ui.page.evaluate((id) => window.__gc.store.getState().openStashForm(id), opened.tabId);
    await ui.page.locator('[data-screen="stash-form"]').waitFor({ timeout: 5000 });
    equal(await stashButton().getAttribute("aria-disabled"), "true", "disabled without a commit");
    await stashButton().hover();
    await ui.page.getByRole("tooltip").filter({ hasText: /needs a commit/ }).first().waitFor({ timeout: 5000 });
    await ui.page.mouse.move(700, 500);
    await closeTab();

    const rich = await fixture(makeRichRepo);
    const { repoId, tabId } = await app.openRepo(rich.path);
    await ui.waitCounts(repoId, { unstaged: 12, staged: 5, conflicted: 0 });
    await ui.page.getByRole("radio", { name: "Stash" }).click();
    await ui.page.locator('[data-screen="stash-form"]').waitFor({ timeout: 5000 });
    const longName = "Kalibrierung der Station Nord mit bereinigter Messreihe von Januar bis März, noch ungeprüft";
    await nameField().fill(longName);
    equal(await ui.overflow(), { page: 0, panel: 0 }, "a long name breaks nothing");
    await ui.row("unstaged", "src/auswertung.py").click();
    await ui.page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await ui.page.evaluate(() => document.activeElement?.blur());
    await ui.page.mouse.move(700, 500);
    await app.settle();
    await app.screenshot(`${SHOTS}/stash-form.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/stash-form-light.png`);
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await eventually(ui.overflow, { page: 0, panel: 0 }, "no overflow at 960×600");
    const form = await ui.page.locator('form[aria-label="Create stash"]').boundingBox();
    check(form && form.y + form.height <= 600 - 24 + 1, "the stash form stays fully visible");
    await app.screenshot(`${SHOTS}/stash-form-min.png`);
    await app.setSize(1440, 900);

    // With everything: the stash also contains the staged files and the images.
    await stashButton().click();
    await ui.waitToast("success", /stashed/);
    equal(lines(rich.git("stash", "list", "--format=%gs"))[0], `On main: ${longName}`, "git: stash with long name");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 0, conflicted: 0 });
    equal(rich.git("status", "--porcelain"), "", "git: everything put aside");
    await ui.page.evaluate((id) => window.__gc.store.getState().openStashForm(id), tabId);
    await ui.page.locator('[data-screen="stash-form"]').waitFor({ timeout: 5000 });
    await ui.page.getByText("Nothing to commit").waitFor({ timeout: 5000 });
    equal(await stashButton().getAttribute("aria-disabled"), "true", "disabled without changes");
    await ui.page.mouse.move(700, 500);
    await app.screenshot(`${SHOTS}/stash-form-empty.png`);
    await closeTab();
  });

  equal(app.consoleErrors, [], "console errors");
} catch (error) {
  checks.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  await app?.close().catch(() => undefined);
  for (const repo of repos) repo.cleanup();
}
process.exit(finish());
