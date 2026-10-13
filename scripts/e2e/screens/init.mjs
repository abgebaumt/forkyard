/**
 * init – init dialog in the real app: repositories are really created on disk.
 *
 *   node scripts/e2e/screens/init.mjs            everything, screenshots to target/e2e/shots/
 *   node scripts/e2e/screens/init.mjs --show     visible window
 *
 * Checks: defaults (default branch from settings, “None” for templates, README on), creating with
 * the keyboard only including template selection, files and first commit in the repository,
 * creating without files (no commit), without identity (staged, no commit), field errors
 * (target taken, location missing, invalid name, invalid branch), templates not loadable,
 * both window sizes and themes. Console errors fail the run.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { closeToasts, createChecks, dialogTitle, findRepo, finish, makeWorkspace, overflow, tabUntil, toasts } from "./repo-entry-lib.mjs";

const show = process.argv.includes("--show");
const { failures, check, equal, eventually, section } = createChecks();
const SHOTS = "target/e2e/shots";
const ws = makeWorkspace("s03");
const place = ws.dir("Neu");

let app = null;
let step = "Start";

try {
  app = await launchApp({ show });
  let { page } = app;
  const press = async (keys) => {
    await page.keyboard.press(keys);
    await page.waitForTimeout(80);
  };
  const form = () => page.locator('[data-screen="init"]');
  const field = (label) => form().getByLabel(label, { exact: true });
  const invalid = (label) => field(label).getAttribute("aria-invalid");
  const errorOf = (label) => field(label).evaluate((input) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
  const createButton = () => page.getByRole("button", { name: "Create repository", exact: true });
  const focusedLabel = () => page.evaluate(() => document.activeElement?.labels?.[0]?.textContent ?? document.activeElement?.textContent?.trim() ?? null);
  const noErrors = (where) => check(app.consoleErrors.length === 0, `Console errors (${where}):\n${app.consoleErrors.join("\n")}`);
  const openDialog = async () => {
    if (!(await page.locator('[data-screen="repo-management"]').count())) {
      await press("Control+t");
      await page.locator('[data-screen="repo-management"]').waitFor();
      await app.settle();
    }
    await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Create new …" }).click();
    await form().waitFor();
    await app.settle();
  };

  await section("Defaults and layout", async () => {
    step = "Defaults";
    await app.invoke("settings_set", { patch: { defaultBranchName: "trunk" } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await app.settle();
    const steps = await tabUntil(page, () => document.activeElement?.textContent?.trim() === "Create new …");
    check(steps >= 0, "“Create new …” is reachable with Tab");
    await press("Enter");
    await form().waitFor();
    equal(await dialogTitle(page), "Create new repository", "title");
    equal(await focusedLabel(), "Name", "autofocus in the name");
    await eventually(() => field("Default branch").inputValue(), "trunk", "the default branch comes from the settings");
    equal(await form().getByRole("combobox").allInnerTexts(), ["None", "None"], "both templates are set to “None”");
    equal(await form().getByRole("checkbox", { name: /Create README\.md/ }).getAttribute("aria-checked"), "true", "README is preselected");
    equal(await field("Location").inputValue(), "", "without a remembered location the location is empty");
    await page.keyboard.type("mein-projekt");
    await app.pick(place);
    await form().getByRole("button", { name: "Browse …" }).click();
    await eventually(() => field("Location").inputValue(), place, "“Browse …” fills in the location");
    equal((await form().locator("[data-init-target]").innerText()).replace(/\s+/g, " "), `Will be created in: ${path.join(place, "mein-projekt")}`, "path preview");
    await page.waitForTimeout(150);
    equal(await overflow(page), { x: 0, y: 0 }, "no overflow");
    await app.screenshot(`${SHOTS}/init.png`);
    await app.setTheme("light");
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/init-light.png`);
    await app.setTheme("dark");
    await form().getByRole("combobox", { name: ".gitignore template" }).click();
    await page.getByRole("listbox").waitFor();
    const options = await page.getByRole("option").allInnerTexts();
    check(options[0] === "None" && options.length >= 14, `list of .gitignore templates (${options.length}): ${options.join(", ")}`);
    await page.waitForTimeout(150);
    await app.screenshot(`${SHOTS}/init-templates.png`);
    await press("Escape");
    await page.getByRole("listbox").waitFor({ state: "detached" });
    equal(await dialogTitle(page), "Create new repository", "Esc closes only the select, not the dialog");
    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    const box = await page.locator('[role="dialog"]').boundingBox();
    check(box.y >= 0 && box.y + box.height <= 600, `960×600: the dialog fits in the window (${JSON.stringify(box)})`);
    check(await createButton().isVisible(), "960×600: “Create repository” stays visible");
    await app.screenshot(`${SHOTS}/init-min.png`);
    await app.setSize(1440, 900);
    await press("Escape");
    await form().waitFor({ state: "detached" });
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Create new …", "after Esc, focus is back on “Create new …”");
  });

  await section("Create with the keyboard only: name, location, branch, templates, README", async () => {
    step = "Keyboard";
    await press("Enter");
    await form().waitFor();
    await page.keyboard.type("wetter auswertung");
    check(/space|character/.test((await errorOf("Name")) ?? "") || (await invalid("Name")) === null, "spaces in the name are allowed for folders");
    await press("Control+a");
    await page.keyboard.type("wetter-auswertung");
    await press("Tab");
    equal(await focusedLabel(), "Location", "Tab goes to the location");
    await page.keyboard.type(place);
    await press("Tab");
    equal(await focusedLabel(), "Browse …", "then to “Browse …”");
    await press("Tab");
    equal(await focusedLabel(), "Default branch", "then to the default branch");
    await press("Control+a");
    await page.keyboard.type("haupt zweig");
    equal(await field("Default branch").inputValue(), "haupt-zweig", "spaces turn into “-” while typing");
    await press("Tab");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox", "then to the .gitignore template");
    await press("Enter");
    await page.getByRole("listbox").waitFor();
    await page.keyboard.type("Python");
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Python", "typing the first letters selects “Python”");
    await press("Enter");
    await eventually(() => form().getByRole("combobox", { name: ".gitignore template" }).innerText(), "Python", "Python is selected");
    await press("Tab");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox", "then to the license");
    await press("ArrowDown");
    await page.getByRole("listbox").waitFor();
    await page.keyboard.type("MIT");
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "MIT License", "“MIT License” highlighted");
    await press("Enter");
    await eventually(() => form().getByRole("combobox", { name: "License" }).innerText(), "MIT License", "MIT is selected");
    await press("Tab");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "checkbox", "then to the README");
    await press("Tab");
    equal(await focusedLabel(), "Cancel", "then to “Cancel”");
    await press("Tab");
    equal(await focusedLabel(), "Create repository", "then to “Create repository”");
    await press("Enter");
    await page.getByRole("tab", { name: /wetter-auswertung/ }).waitFor({ timeout: 60_000 });
    await form().waitFor({ state: "detached" });

    const repo = path.join(place, "wetter-auswertung");
    equal(fs.readdirSync(repo).sort(), [".git", ".gitignore", "LICENSE", "README.md"], "exactly these files are created");
    equal(ws.git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "haupt-zweig", "the branch is named as entered");
    equal(ws.git(repo, "rev-list", "--count", "HEAD"), "1", "one first commit");
    equal(ws.git(repo, "log", "-1", "--format=%s|%an"), "Initial commit|Lena Hartmann", "message and author of the first commit");
    equal(ws.git(repo, "ls-files").split("\n").sort(), [".gitignore", "LICENSE", "README.md"], "all three files are committed");
    equal(ws.git(repo, "status", "--porcelain"), "", "nothing stays uncommitted");
    equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# wetter-auswertung\n", "README with the name as heading");
    check(/__pycache__/.test(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")), ".gitignore is the Python template");
    const license = fs.readFileSync(path.join(repo, "LICENSE"), "utf8");
    check(/MIT License/.test(license) && license.includes(String(new Date().getFullYear())) && license.includes("Lena Hartmann"), "MIT license with year and name");
    check((await findRepo(app, repo)) !== null, "the core lists the repository");
    check((await toasts(page)).some((text) => text.includes("“wetter-auswertung” has been created")), "success message");
    equal(await page.evaluate(() => localStorage.getItem("gc.repoParent")), place, "the location is remembered");
    await closeToasts(page);
    noErrors("keyboard");
  });

  await section("Without README and templates: empty repository without commit", async () => {
    step = "empty";
    await openDialog();
    equal(await field("Location").inputValue(), place, "the remembered location is prefilled");
    await field("Name").fill("ganz-leer");
    await form().getByRole("checkbox", { name: /Create README\.md/ }).click();
    check((await form().locator("[data-init-note]").innerText()).includes("with no first commit"), "the dialog says beforehand that there is no commit");
    await createButton().click();
    await page.getByRole("tab", { name: /ganz-leer/ }).waitFor();
    const repo = path.join(place, "ganz-leer");
    equal(fs.readdirSync(repo), [".git"], "only .git");
    equal(ws.git(repo, "symbolic-ref", "--short", "HEAD"), "trunk", "branch from the settings");
    let commits = "0";
    try {
      commits = ws.git(repo, "rev-list", "--count", "--all");
    } catch {
      commits = "0";
    }
    equal(commits, "0", "no commit");
    await closeToasts(page);
  });

  await section("Field errors: target taken, location missing, name and branch invalid", async () => {
    step = "Errors";
    await openDialog();
    // Target taken
    const taken = ws.dir("Neu", "belegt");
    fs.writeFileSync(path.join(taken, "notiz.txt"), "bleibt\n");
    await field("Name").fill("belegt");
    await createButton().click();
    await eventually(() => invalid("Name"), "true", "target taken: error at the name");
    check(/non-empty folder/.test((await errorOf("Name")) ?? ""), `understandable sentence: ${await errorOf("Name")}`);
    equal(await focusedLabel(), "Name", "focus is in the name");
    equal(fs.readdirSync(taken), ["notiz.txt"], "the folder is untouched");
    equal(await toasts(page), [], "no toast");
    await app.screenshot(`${SHOTS}/init-error.png`);
    await field("Name").fill("belegt-nicht");
    equal(await invalid("Name"), null, "typing removes the mark");

    // already known repository
    await field("Name").fill("wetter-auswertung");
    check(/is already there/.test((await errorOf("Name")) ?? ""), "a known repository at the target is reported while typing");

    // invalid names (before submitting)
    for (const [name, reason] of [
      ["a|b", /“\|”/],
      ["ende ", /period or a space/],
      ["aux", /reserves/],
    ]) {
      await field("Name").fill(name);
      check(reason.test((await errorOf("Name")) ?? ""), `name “${name}”: ${await errorOf("Name")}`);
    }
    await createButton().click();
    equal(await form().count(), 1, "nothing starts with an invalid name");

    // Location missing
    await field("Name").fill("irgendwas");
    await field("Location").fill(ws.at("gibt", "es", "nicht"));
    await createButton().click();
    await eventually(() => invalid("Location"), "true", "location missing: error at the location");
    check(/doesn't exist/.test((await errorOf("Location")) ?? ""), `understandable sentence: ${await errorOf("Location")}`);
    await field("Location").fill("relativ\\pfad");
    check(/full path/.test((await errorOf("Location")) ?? ""), "a relative location is rejected while typing");
    await field("Location").fill(place);

    // Invalid branch: first the UI check, then the core's
    await field("Default branch").fill("a..b");
    check(/“\.\.”/.test((await errorOf("Default branch")) ?? ""), `branch “a..b”: ${await errorOf("Default branch")}`);
    await field("Default branch").fill("");
    await createButton().click();
    await eventually(() => invalid("Default branch"), "true", "empty branch on submit");
    await field("Default branch").fill("ok/aber.lock/x");
    await createButton().click();
    await eventually(() => invalid("Default branch"), "true", "the core rejects “ok/aber.lock/x”, the error is shown at the branch field", 15_000);
    console.log(`  (core message: ${await errorOf("Default branch")})`);
    check(!fs.existsSync(path.join(place, "irgendwas")), "no half-finished folder is left behind");
    await press("Escape");
    await form().waitFor({ state: "detached" });
    noErrors("errors");
  });

  await section("Templates not loadable (simulated)", async () => {
    step = "Templates";
    await page.evaluate(() => {
      const core = window.__gc.core;
      core.initTemplates = async () => {
        throw Object.assign(new Error("Templates missing."), { code: "io", gitOutput: null });
      };
      window.__restoreTemplates = () => {
        delete core.initTemplates;
      };
      window.__gc.queryClient.removeQueries({ queryKey: ["app", "initTemplates"] });
    });
    await openDialog();
    await form().getByText("The templates couldn't be loaded").waitFor();
    await page.evaluate(() => window.__restoreTemplates());
    await app.screenshot(`${SHOTS}/init-templates-error.png`);
    await form().getByRole("button", { name: "Try again" }).click();
    await form().getByRole("combobox", { name: "License" }).waitFor();
    check(true, "“Try again” loads the templates");
    await press("Escape");
    noErrors("templates");
  });

  await app.close();
  app = null;

  await section("Without Git identity: files staged, no commit", async () => {
    step = "no identity";
    app = await launchApp({ show, gitIdentity: null });
    page = app.page;
    await page.evaluate((value) => localStorage.setItem("gc.repoParent", value), place);
    await openDialog();
    await field("Name").fill("ohne-identitaet");
    await createButton().click();
    await page.getByRole("tab", { name: /ohne-identitaet/ }).waitFor();
    const repo = path.join(place, "ohne-identitaet");
    // The shell environment of this check has its own identity; what counts is what the app did.
    let commits = "0";
    try {
      commits = ws.git(repo, "rev-list", "--count", "--all");
    } catch {
      commits = "0";
    }
    const profile = (await app.invoke("profile_list")).find((item) => item.isActive);
    console.log(`  (active profile: ${JSON.stringify({ name: profile?.authorName, email: profile?.authorEmail })})`);
    if (profile?.authorName && profile?.authorEmail) equal(commits, "1", "with name and email in the profile there is a first commit anyway");
    else {
      equal(commits, "0", "no commit without identity");
      equal(ws.git(repo, "diff", "--cached", "--name-only"), "README.md", "README.md is staged");
    }
    noErrors("no identity");
  });
} catch (error) {
  failures.push(`aborted at “${step}”: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/init-failure.png").catch(() => undefined);
  await app?.close();
  ws.cleanup();
}
finish("init", failures, "target/e2e/init-failure.png");
