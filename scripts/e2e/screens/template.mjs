/**
 * Commit template from the Git configuration (commit.template) in the commit panel – in the real app,
 * against real repositories.
 *
 *   node scripts/e2e/screens/template.mjs                 everything (checks and screenshots)
 *   node scripts/e2e/screens/template.mjs --only global   only sections whose title contains “global”
 *   node scripts/e2e/screens/template.mjs --show          visible window
 *
 * Checks run against the repository itself (git log), not only the UI. The first section never
 * touches the mouse.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { createChecks, lines, readFile, wipDriver, writeFile } from "./_wip.mjs";
import { appendAppGitConfig, slash } from "./mustfix-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots";
const checks = createChecks("template");
const { check, equal, eventually, section, finish } = checks;

const GLOBAL_TEMPLATE = [
  "# Erste Zeile: in einem Satz, was sich ändert (höchstens 72 Zeichen).",
  "Thema: ",
  "",
  "# Darunter: warum die Änderung nötig ist.",
  "Warum: ",
  "Ticket: #",
  "# Zeilen mit # am Anfang landen nicht im Commit.",
  "",
].join("\n");
const REPO_TEMPLATE = "# Vorlage dieses Repositories\nMessnetz: \n\nStation: \n";
/** How the global template appears in the fields: without comment lines; the space after “Warum:” stays for typing on. */
const PREFILLED = { summary: "Thema:", description: "Warum: \nTicket: #" };
const LONG_SUMMARY = "Auswertung der Messreihen aller Stationen für das erste Quartal mit Korrekturfaktoren";

const repos = [];
let app = null;
let ui = null;
const onError = async (title) => {
  if (app) await app.screenshot(`target/e2e/template-error-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
};
const run = (title, body) => section(title, body, onError);
const fields = async () => ({ summary: await ui.summary.inputValue(), description: await ui.description.inputValue() });
const draft = (repoId) => app.invoke("draft_get", { repoId });
const shot = async (name) => {
  await app.settle();
  await ui.page.waitForTimeout(250);
  await app.screenshot(`${SHOTS}/${name}.png`);
};

try {
  app = await launchApp({ show });
  ui = wipDriver(app, checks);
  const { page } = app;

  const repo = makeCleanRepoWithRemote({ name: "mit-vorlage" });
  repos.push(repo);
  // The template lives OUTSIDE the repository and is only set in the app's global gitconfig.
  const globalFile = path.join(repo.root, "vorlagen", "commit-vorlage.txt");
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  fs.writeFileSync(globalFile, GLOBAL_TEMPLATE);
  appendAppGitConfig(app, `[commit]\n\ttemplate = ${slash(globalFile)}\n`);

  writeFile(repo, "README.md", `${readFile(repo, "README.md")}\nStand: Vorlage ausprobiert.\n`);
  const { repoId } = await app.openRepo(repo.path);
  let before = repo.git("rev-parse", "HEAD");

  // -------------------------------------------------------------------------------------------
  await run("Global template outside the repository – keyboard only", async () => {
    equal((await app.invoke("repo_settings_get", { repoId })).commitTemplate, null, "initial state: no template configured in the repository itself");
    await eventually(fields, PREFILLED, "the template fills the fields, without its comment lines");
    equal(await draft(repoId), { summary: "", description: "", amend: false }, "the template alone is not a saved draft");
    await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "one changed file");
    await shot("template-prefilled");

    // Stage and try to commit the untouched template.
    await ui.tabToList("Unstaged files");
    await page.keyboard.press("s");
    await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "S stages the file");
    await ui.tabToField("Summary");
    await page.keyboard.press("Control+Enter");
    await eventually(() => page.locator('form[aria-label="Commit"] [role="alert"]').innerText().catch(() => ""), "This is still the unchanged commit template. Add what changes.", "the untouched template is not committed; the reason is shown at the field");
    equal(repo.git("rev-parse", "HEAD"), before, "git: no commit created");
    await shot("template-untouched");

    // Fill in and commit.
    await page.keyboard.press("End");
    await page.keyboard.type(" Regenmesser neu geeicht");
    await page.keyboard.press("Enter");
    equal(await ui.focusedLabel(), "Description", "Enter jumps to the description");
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    await page.keyboard.type("Die Werte lagen zu hoch.");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("412");
    await page.keyboard.press("Control+Enter");
    await ui.waitToast("success", /Commit created/);
    const head = repo.git("rev-parse", "HEAD");
    check(head !== before, "git: HEAD moved");
    const message = repo.git("log", "-1", "--format=%B").trim();
    equal(message, "Thema: Regenmesser neu geeicht\n\nWarum: Die Werte lagen zu hoch.\nTicket: #412", "git: message from template and input");
    equal(lines(message).filter((line) => line.startsWith("#")), [], "git: no template comment line in the commit");
    check(message.includes("Ticket: #412"), "a # in the middle of a line is kept");
    before = head;

    await eventually(fields, PREFILLED, "after the commit the template is back");
    equal(await draft(repoId), { summary: "", description: "", amend: false }, "and the draft in the core is empty");
    await ui.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await run("Only when the field is empty: an own draft stays", async () => {
    await ui.summary.fill("Eigener Entwurf ohne Vorlage");
    await ui.description.fill("");
    await eventually(() => draft(repoId), { summary: "Eigener Entwurf ohne Vorlage", description: "", amend: false }, "the draft is saved in the core");
    await app.reload();
    await app.settle();
    ui = wipDriver(app, checks);
    await eventually(fields, { summary: "Eigener Entwurf ohne Vorlage", description: "" }, "after reload the draft is shown, not the template");

    // If the user clears the field, the template does not push itself back in …
    await ui.summary.fill("");
    await eventually(() => draft(repoId), { summary: "", description: "", amend: false }, "cleared draft is saved");
    await ui.page.waitForTimeout(400);
    equal(await fields(), { summary: "", description: "" }, "a field cleared by hand stays empty");
    // … on the next open with an empty draft it is back.
    await app.reload();
    await app.settle();
    ui = wipDriver(app, checks);
    await eventually(fields, PREFILLED, "with an empty draft the template comes back on open");
  });

  // -------------------------------------------------------------------------------------------
  await run("Amend with untouched template: the last commit message replaces it", async () => {
    await ui.checkbox("Amend last commit").click();
    await eventually(fields, { summary: "Thema: Regenmesser neu geeicht", description: "Warum: Die Werte lagen zu hoch.\nTicket: #412" }, "amend loads the last commit message");
    await ui.checkbox("Amend last commit").click();
    await eventually(fields, PREFILLED, "without amend the template is back");
  });

  // -------------------------------------------------------------------------------------------
  await run("Repository template takes precedence over the global one", async () => {
    writeFile(repo, ".gitmessage", REPO_TEMPLATE);
    const saved = await app.invoke("repo_settings_set", { repoId, patch: { commitTemplate: ".gitmessage" } });
    equal(saved.commitTemplateText, REPO_TEMPLATE, "core: commitTemplateText is now the repository file");
    equal(repo.git("config", "--local", "commit.template"), ".gitmessage", "git config: commit.template in the repository");
    // The old template was untouched in the field: it is replaced by the new one.
    await eventually(fields, { summary: "Messnetz:", description: "Station:" }, "the untouched template in the field switches to the repository one");

    // Typed text stays when the template changes.
    await ui.summary.fill("Messnetz: Station Hafen ergänzt");
    await app.invoke("repo_settings_set", { repoId, patch: { commitTemplate: null } });
    await ui.page.waitForTimeout(500);
    equal(await fields(), { summary: "Messnetz: Station Hafen ergänzt", description: "Station:" }, "typed text stays even when the template changes");
    await ui.summary.fill("");
    await ui.description.fill("");
    await eventually(() => draft(repoId), { summary: "", description: "", amend: false }, "draft cleared");
  });

  // -------------------------------------------------------------------------------------------
  await run("Comment-only template, missing file, very long template", async () => {
    fs.writeFileSync(globalFile, "# Nur Hinweise.\n# Nichts davon gehört in die Message.\n");
    await app.reload();
    await app.settle();
    ui = wipDriver(app, checks);
    await ui.summary.waitFor();
    await ui.page.waitForTimeout(600);
    equal(await fields(), { summary: "", description: "" }, "a comment-only template prefills nothing");
    equal((await app.invoke("repo_settings_get", { repoId })).commitTemplateText, "# Nur Hinweise.\n# Nichts davon gehört in die Message.\n", "core returns the raw text with comments");

    fs.rmSync(globalFile);
    await app.reload();
    await app.settle();
    ui = wipDriver(app, checks);
    await ui.summary.waitFor();
    await ui.page.waitForTimeout(600);
    equal(await fields(), { summary: "", description: "" }, "if the file is missing, the fields stay empty");
    equal((await app.invoke("repo_settings_get", { repoId })).commitTemplateText, null, "core: no template");
    equal(await ui.page.locator('[data-toast="danger"]').count(), 0, "and there is no error message");

    // Very long template: 60 description lines, a summary over the 72-character limit.
    const long = `${LONG_SUMMARY}\n\n${Array.from({ length: 60 }, (_, index) => `- Punkt ${index + 1}: prüfen`).join("\n")}\n`;
    fs.writeFileSync(globalFile, long);
    await app.reload();
    await app.settle();
    ui = wipDriver(app, checks);
    await eventually(async () => (await fields()).summary, LONG_SUMMARY, "long summary is complete in the field");
    equal(lines((await fields()).description).length, 60, "all 60 description lines are there");
    const box = await ui.description.boundingBox();
    check(box && box.height <= 170, `the description grows only up to its limit and then scrolls (height ${box?.height})`);
    check((await page.locator('form[aria-label="Commit"]').innerText()).includes(`${LONG_SUMMARY.length}/72`), "the counter warns above 72 characters");
    equal(await ui.overflow(), { page: 0, panel: 0 }, "no horizontal overflow");
    await shot("template-long");
    fs.writeFileSync(globalFile, GLOBAL_TEMPLATE);
  });

  // -------------------------------------------------------------------------------------------
  await run("Screenshots: light theme and minimum window", async () => {
    await app.reload();
    await app.settle();
    ui = wipDriver(app, checks);
    await eventually(fields, PREFILLED, "template is shown");
    await app.setTheme("light");
    await shot("template-prefilled-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await eventually(fields, PREFILLED, "template is shown in the minimum window too");
    equal(await ui.overflow(), { page: 0, panel: 0 }, "no horizontal overflow at 960×600");
    await shot("template-prefilled-min");
    await app.setSize(1440, 900);
  });

  equal(app.consoleErrors, [], "console errors");
} finally {
  if (app) await app.close().catch(() => undefined);
  for (const repo of repos) repo.cleanup();
}
process.exit(finish());
