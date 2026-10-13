/**
 * clone – clone dialog in the real app, against real repositories (local bare repositories,
 * as a path and as a file:// URL – no network).
 *
 *   node scripts/e2e/screens/clone.mjs            everything, screenshots to target/e2e/shots/
 *   node scripts/e2e/screens/clone.mjs --show     visible window
 *
 * Checks: address detection (https, ssh://, git@host:path, file://, local path, host provider),
 * name suggestion, validation while typing and on submit, cloning with the keyboard only, result on
 * disk, shallow (depth and date), branch, sparse checkout, progress and cancelling on a large
 * repository, errors (target taken, source missing, target folder missing, server not reachable),
 * remembered target folder. Console errors fail the run.
 *
 * Not testable without a server: sign-in (auth_failed), unknown SSH host, timeout,
 * credential prompts, submodules.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeLargeRepo } from "../fixtures.mjs";
import { addRepo, closeToasts, createChecks, dialogTitle, fileUrl, findRepo, finish, makeWorkspace, overflow, tabUntil, toasts } from "./repo-entry-lib.mjs";

const show = process.argv.includes("--show");
const { failures, check, equal, eventually, section } = createChecks();
const SHOTS = "target/e2e/shots";

const ws = makeWorkspace("s02");
const large = makeLargeRepo();

// Source: five commits with fixed dates, two folders, a second branch.
const work = ws.repo("wetterdaten", { "README.md": "# Wetterdaten\n\nMesswerte der Station.\n", "src/lesen.py": "print('lesen')\n", "docs/aufbau.md": "# Aufbau\n" });
ws.commit(work, "src/lesen.py", "print('lesen, Fassung 2')\n", "Lesen überarbeitet", "2026-01-10T12:00:00+01:00");
ws.commit(work, "docs/aufbau.md", "# Aufbau\n\nMast und Logger.\n", "Aufbau beschrieben", "2026-02-10T12:00:00+01:00");
ws.commit(work, "src/pruefen.py", "print('prüfen')\n", "Prüfung ergänzt", "2026-03-10T12:00:00+01:00");
ws.git(work, "checkout", "-q", "-b", "entwicklung");
ws.commit(work, "src/entwurf.py", "print('entwurf')\n", "Entwurf", "2026-03-20T12:00:00+01:00");
ws.git(work, "checkout", "-q", "main");
const source = ws.at("wetterdaten.git");
ws.git(ws.root, "clone", "-q", "--bare", work, source);
const sourceCommits = Number(ws.git(source, "rev-list", "--count", "main"));
const target = ws.dir("Ziel");

let app = null;
let step = "Start";

try {
  app = await launchApp({ show });
  const { page } = app;
  const press = async (keys) => {
    await page.keyboard.press(keys);
    await page.waitForTimeout(80);
  };
  const form = page.locator('[data-screen="clone"]');
  const field = (label) => form.getByLabel(label, { exact: true });
  const invalid = (label) => field(label).getAttribute("aria-invalid");
  const errorOf = (label) => field(label).evaluate((input) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
  const startButton = page.getByRole("button", { name: "Clone", exact: true });
  const activeTab = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null);
  const noErrors = (where) => check(app.consoleErrors.length === 0, `Console errors (${where}):\n${app.consoleErrors.join("\n")}`);
  const openDialog = async () => {
    await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Clone …" }).click();
    await form.waitFor();
  };
  const backToManagement = async () => {
    await press("Control+t");
    await page.locator('[data-screen="repo-management"]').waitFor();
    await app.settle();
  };
  const badge = () => form.locator("[data-url-kind]").count().then((count) => (count ? form.locator("[data-url-kind]").innerText() : null));

  await section("Open dialog (keyboard), autofocus, address detection", async () => {
    step = "Detection";
    const steps = await tabUntil(page, () => document.activeElement?.textContent?.trim() === "Clone …");
    check(steps >= 0, "“Clone …” is reachable with Tab");
    await press("Enter");
    await form.waitFor();
    equal(await dialogTitle(page), "Clone repository", "dialog title");
    equal(await page.evaluate(() => document.activeElement?.id === document.querySelector('[data-screen="clone"] input')?.id), true, "focus is in the “Address” field");
    check(await field("Address").evaluate((input) => getComputedStyle(input).fontFamily.includes("JetBrains")), "the address uses the code font");

    const cases = [
      ["https://github.com/beispiel/wetter-daten.git", "GitHub · HTTPS", "wetter-daten", "https"],
      ["git@gitlab.com:gruppe/unter/projekt.git", "GitLab · SSH", "projekt", "ssh"],
      ["ssh://git@bitbucket.org:7999/team/app-server.git/", "Bitbucket · SSH", "app-server", "ssh"],
      ["https://dev.azure.com/firma/projekt/_git/dienst", "Azure DevOps · HTTPS", "dienst", "https"],
      ["https://git.example.com/a/b", "git.example.com · HTTPS", "b", "https"],
      ["http://intern.example/x/y.git", "intern.example · HTTP, unencrypted", "y", "http"],
      ["C:\\Daten\\Archiv\\quelle.git", "Local folder", "quelle", "local"],
      ["/srv/git/projekt.git", "Local folder", "projekt", "local"],
      ["file:///C:/Daten/noch%20eins.git", "Local folder", "noch eins", "file"],
    ];
    for (const [url, mark, name, kind] of cases) {
      await field("Address").fill(url);
      equal([await badge(), await field("Folder name").inputValue(), await form.locator("[data-url-kind]").getAttribute("data-url-kind"), await invalid("Address")], [mark, name, kind, null], `detection of ${url}`);
    }
    const bad = [
      ["github.com/beispiel/projekt", /isn't a complete address/],
      ["ftp://host/pfad.git", /“ftp:\/\/” isn't supported here/],
      ["ext::sh -c boese", /“::” aren't supported/],
      ["https://", /rest of the address is missing/],
      ["https://github.com", /path to the repository is missing/],
      ["https://host/mit leerzeichen.git", /doesn't contain spaces/],
      ["-upload-pack=boese", /doesn't start with “-”/],
    ];
    for (const [url, reason] of bad) {
      await field("Address").fill(url);
      equal(await invalid("Address"), "true", `invalid: ${url}`);
      check(reason.test((await errorOf("Address")) ?? ""), `reason for ${url}: ${await errorOf("Address")}`);
      equal(await badge(), null, `no badge for ${url}`);
    }
  });

  await section("Name suggestion, target preview, Browse", async () => {
    step = "Suggestion";
    await field("Address").fill("https://github.com/beispiel/wetter-daten.git");
    equal(await field("Folder name").inputValue(), "wetter-daten", "name from the address");
    await app.pick(target);
    await form.getByRole("button", { name: "Browse …" }).click();
    await eventually(() => field("Target folder").inputValue(), target, "“Browse …” fills in the chosen folder");
    equal((await form.locator("[data-clone-target]").innerText()).replace(/\s+/g, " "), `Will be cloned to: ${path.join(target, "wetter-daten")}`, "target preview");
    // A name set by hand is kept; an emptied field gets suggestions again.
    await field("Folder name").fill("mein-name");
    await field("Address").fill("https://github.com/beispiel/anderes.git");
    equal(await field("Folder name").inputValue(), "mein-name", "a custom name stays when the address changes");
    await field("Folder name").fill("");
    await field("Address").fill("https://github.com/beispiel/drittes.git");
    equal(await field("Folder name").inputValue(), "drittes", "an emptied field gets the suggestion again");

    await field("Address").fill("git@github.com:beispiel/wetterdaten.git");
    await page.waitForTimeout(150);
    equal(await overflow(page), { x: 0, y: 0 }, "no overflow");
    await app.screenshot(`${SHOTS}/clone.png`);
    await app.setTheme("light");
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/clone-light.png`);
    await app.setTheme("dark");
  });

  await section("Validation while typing and on submit", async () => {
    step = "Validation";
    await field("Address").fill("");
    await field("Target folder").fill("");
    await field("Folder name").fill("");
    equal([await invalid("Address"), await invalid("Target folder"), await invalid("Folder name")], [null, null, null], "empty fields are not red before submitting");
    await startButton.click();
    await eventually(async () => [await invalid("Address"), await invalid("Target folder"), await invalid("Folder name")], ["true", "true", "true"], "after submitting, all three required fields are marked");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-invalid")), "true", "focus jumps to the first invalid field");
    equal(await form.getAttribute("data-state"), "form", "nothing was started");

    await field("Address").fill(source);
    await field("Target folder").fill("Projekte\\relativ");
    check(/full path/.test((await errorOf("Target folder")) ?? ""), `relative target folder: ${await errorOf("Target folder")}`);
    await field("Target folder").fill(target);
    for (const [name, reason] of [
      ["a:b", /“:”/],
      ["unter/ordner", /“\/”/],
      ["frage?", /“\?”/],
      ["ende.", /period or a space/],
      ["CON", /reserves/],
      ["..", /aren't folder names/],
    ]) {
      await field("Folder name").fill(name);
      check(reason.test((await errorOf("Folder name")) ?? ""), `name “${name}”: ${await errorOf("Folder name")}`);
    }
    await field("Folder name").fill("wetterdaten");
    equal(await invalid("Folder name"), null, "a valid name is not marked");

    // Advanced options
    await form.getByRole("button", { name: /Advanced options/ }).click();
    await form.getByRole("checkbox", { name: /Shallow clone/ }).click();
    equal(await field("Depth (commits per branch)").inputValue(), "1", "default depth is 1");
    for (const value of ["0", "-3", "zwei", "1.5", ""]) {
      await field("Depth (commits per branch)").fill(value);
      equal(await invalid("Depth (commits per branch)"), "true", `depth “${value}” is rejected`);
    }
    await field("Depth (commits per branch)").fill("3");
    equal(await invalid("Depth (commits per branch)"), null, "depth 3 is valid");
    await form.locator('[aria-label="Limit history by"]').getByText("Date", { exact: true }).click();
    await field("Commits since").fill("2026-13-40");
    check(/year-month-day/.test((await errorOf("Commits since")) ?? ""), `invalid date: ${await errorOf("Commits since")}`);
    await field("Commits since").fill("31.01.2026");
    equal(await invalid("Commits since"), "true", "German date notation is rejected, with a hint about the format");
    await field("Commits since").fill("2026-02-01");
    equal(await invalid("Commits since"), null, "2026-02-01 is valid");
    await field("Branch").fill("mein branch");
    check(/spaces/.test((await errorOf("Branch")) ?? ""), "a branch with spaces is rejected");
    await field("Branch").fill("");
    await form.getByRole("checkbox", { name: /Sparse checkout/ }).click();
    await startButton.click();
    await eventually(() => invalid("Folders, one per line"), "true", "sparse checkout without folders is rejected on submit");
    await page.waitForTimeout(150);
    await app.screenshot(`${SHOTS}/clone-advanced.png`);
    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    equal(await overflow(page), { x: 0, y: 0 }, "960×600: no page overflow");
    const box = await page.locator('[role="dialog"]').boundingBox();
    check(box.y >= 0 && box.y + box.height <= 600 && box.x >= 0 && box.x + box.width <= 960, `960×600: the dialog lies fully inside the window (${JSON.stringify(box)})`);
    check(await startButton.isVisible(), "960×600: “Clone” stays reachable");
    await app.screenshot(`${SHOTS}/clone-min.png`);
    await app.setSize(1440, 900);
    equal(await form.getAttribute("data-state"), "form", "nothing was started");
    // Esc closes; focus returns to the button that opened the dialog.
    await press("Escape");
    await form.waitFor({ state: "detached" });
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Clone …", "after Esc, focus is back on “Clone …”");
    noErrors("validation");
  });

  await section("Clone with the keyboard only (local path), result on disk", async () => {
    step = "Clone";
    await press("Enter");
    await form.waitFor();
    await page.keyboard.type(source);
    equal(await badge(), "Local folder", "badge");
    await press("Tab");
    equal(await page.evaluate(() => document.activeElement?.labels?.[0]?.textContent), "Target folder", "Tab goes to the target folder");
    await press("Control+a");
    await page.keyboard.type(target);
    await press("Tab");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Browse …", "Tab goes to “Browse …”");
    await press("Tab");
    equal(await page.evaluate(() => [document.activeElement?.labels?.[0]?.textContent, document.activeElement?.value]), ["Folder name", "wetterdaten"], "Tab goes to the folder name, the suggestion is filled in");
    await press("Enter");
    await page.getByRole("tab", { name: /wetterdaten/ }).waitFor({ timeout: 60_000 });
    await form.waitFor({ state: "detached" });
    await eventually(() => activeTab().then((text) => /^wetterdaten/.test(text ?? "")), true, "the new tab is active");
    const cloned = path.join(target, "wetterdaten");
    check(fs.existsSync(path.join(cloned, ".git")), "the clone is on disk");
    equal(Number(ws.git(cloned, "rev-list", "--count", "HEAD")), sourceCommits, "all commits are there");
    equal(ws.git(cloned, "rev-parse", "--abbrev-ref", "HEAD"), "main", "main is checked out");
    equal(path.resolve(ws.git(cloned, "remote", "get-url", "origin")).toLowerCase(), source.toLowerCase(), "origin points to the source");
    check(fs.existsSync(path.join(cloned, "src", "pruefen.py")), "the files are checked out");
    check((await findRepo(app, cloned)) !== null, "the core lists the clone");
    check((await toasts(page)).some((text) => text.includes("“wetterdaten” has been cloned")), "success message");
    equal(await page.evaluate(() => localStorage.getItem("gc.repoParent")), target, "the target folder is remembered");
    equal(await page.evaluate(() => Object.keys(window.__gc.store.getState().jobs).length), 0, "no job is left hanging in the status bar");
    await closeToasts(page);
    noErrors("clone");
  });

  const cloneWith = async ({ url, name, advanced }) => {
    await backToManagement();
    await openDialog();
    equal(await field("Target folder").inputValue(), target, "the remembered target folder is prefilled");
    await field("Address").fill(url);
    await field("Folder name").fill(name);
    if (advanced) {
      await form.getByRole("button", { name: /Advanced options/ }).click();
      await advanced();
    }
    await startButton.click();
    await page.getByRole("tab", { name: new RegExp(name) }).waitFor({ timeout: 60_000 });
    await form.waitFor({ state: "detached" });
    await closeToasts(page);
    return path.join(target, name);
  };

  await section("Shallow clone with depth 1 (file:// URL)", async () => {
    step = "Depth 1";
    const dir = await cloneWith({
      url: fileUrl(source),
      name: "flach",
      advanced: async () => {
        await form.getByRole("checkbox", { name: /Shallow clone/ }).click();
        equal(await field("Depth (commits per branch)").inputValue(), "1", "depth 1 is prefilled");
      },
    });
    equal(ws.git(dir, "rev-list", "--count", "HEAD"), "1", "exactly one commit in the history");
    equal(ws.git(dir, "rev-parse", "--is-shallow-repository"), "true", "Git reports a shallow clone");
    check(fs.existsSync(path.join(dir, "src", "pruefen.py")), "the working tree is still fully checked out");
  });

  await section("Shallow clone since a date, with a local path", async () => {
    step = "since date";
    const dir = await cloneWith({
      url: source,
      name: "seit-februar",
      advanced: async () => {
        await form.getByRole("checkbox", { name: /Shallow clone/ }).click();
        await form.locator('[aria-label="Limit history by"]').getByText("Date", { exact: true }).click();
        await field("Commits since").fill("2026-02-01");
      },
    });
    equal(ws.git(dir, "rev-list", "--count", "HEAD"), "2", "only the two commits since February 1 (with a local path too)");
  });

  await section("Specific branch and sparse checkout", async () => {
    step = "Branch/Sparse";
    const dir = await cloneWith({
      url: fileUrl(source),
      name: "nur-docs",
      advanced: async () => {
        await field("Branch").fill("entwicklung");
        await form.getByRole("checkbox", { name: /Sparse checkout/ }).click();
        await field("Folders, one per line").fill("docs\n\n  ./docs/  \n");
      },
    });
    equal(ws.git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "entwicklung", "the chosen branch is checked out");
    equal(ws.git(dir, "sparse-checkout", "list"), "docs", "sparse checkout knows exactly the docs folder");
    equal([fs.existsSync(path.join(dir, "docs", "aufbau.md")), fs.existsSync(path.join(dir, "src")), fs.existsSync(path.join(dir, "README.md"))], [true, false, true], "docs is there, src is not, root files are");
    noErrors("variants");
  });

  await section("Progress and cancel (large repository)", async () => {
    step = "Cancel";
    await backToManagement();
    await openDialog();
    await field("Address").fill(fileUrl(large.path));
    await field("Folder name").fill("archiv-kopie");
    const dir = path.join(target, "archiv-kopie");
    await startButton.click();
    const progress = form.locator("[data-clone-progress]");
    await progress.waitFor();
    equal(await form.getAttribute("data-state"), "running", "the dialog shows the running operation");
    check((await progress.innerText()).includes(dir) || (await progress.innerText()).replace(/\s/g, "").includes(dir.replace(/\s/g, "")), "source and target are shown");
    const bar = form.getByRole("progressbar", { name: "Clone progress" });
    await page.waitForFunction(() => /\d+ %/.test(document.querySelector("[data-clone-percent]")?.textContent ?? ""), null, { timeout: 60_000 });
    const seen = await progress.evaluate((root) => ({
      percent: root.querySelector("[data-clone-percent]").textContent,
      line: root.querySelector("[data-clone-line]").textContent,
      phase: root.querySelector("p[aria-live]").textContent,
    }));
    check(/^\d+ %$/.test(seen.percent), `percentage: ${seen.percent}`);
    check(Number(await bar.getAttribute("aria-valuenow")) >= 0, "the bar carries the value");
    check(/^(The server is gathering the data|The server is compressing the data|Transferring data|Assembling the history|Checking out files) …$/.test(seen.phase), `phase in plain words: ${seen.phase}`);
    check(/objects|deltas|files/i.test(seen.line), `last line from Git, muted: ${seen.line}`);
    check((await page.locator("footer.h-statusbar").innerText()).includes("Clone: archiv-kopie"), "the status bar shows the job");
    equal(await page.getByRole("button", { name: "Cloning …" }).getAttribute("aria-busy"), "true", "the main button is busy");
    await app.screenshot(`${SHOTS}/clone-progress.png`);

    // Esc does not just close: a confirmation in the dialog, “Keep cloning” has focus.
    await press("Escape");
    await form.getByText("The clone is still running").waitFor();
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Keep cloning", "the confirmation focuses “Keep cloning”");
    check((await form.innerText()).includes("incomplete folder is removed again"), "the confirmation says the half-finished folder is removed");
    await app.screenshot(`${SHOTS}/clone-cancel-ask.png`);
    await press("Enter");
    await form.getByText("The clone is still running").waitFor({ state: "detached" });
    equal(await form.getAttribute("data-state"), "running", "“Keep cloning” keeps the operation running");

    // Cancel: back to the form, input kept, folder gone.
    await page.getByRole("button", { name: "Cancel clone" }).click();
    await form.locator("[data-clone-cancelled]").waitFor({ timeout: 30_000 });
    check((await form.locator("[data-clone-cancelled]").innerText()).includes("The incomplete folder was removed again"), "the message says the half-finished folder is gone");
    equal([await field("Address").inputValue(), await field("Target folder").inputValue(), await field("Folder name").inputValue()], [fileUrl(large.path), target, "archiv-kopie"], "the input is still there");
    await eventually(() => fs.existsSync(dir), false, "no half-finished folder is left on disk");
    check((await findRepo(app, dir)) === null, "the core has not added anything");
    equal(await toasts(page), [], "a cancel is not an error message");
    equal(await page.evaluate(() => Object.keys(window.__gc.store.getState().jobs).length), 0, "the job has disappeared from the status bar");
    await app.screenshot(`${SHOTS}/clone-cancelled.png`);

    // Second way: Esc, then cancel in the confirmation – the dialog closes.
    await startButton.click();
    await progress.waitFor();
    await press("Escape");
    await form.getByText("The clone is still running").waitFor();
    await press("Tab");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel clone", "Tab goes to “Cancel clone”");
    await press("Enter");
    await form.waitFor({ state: "detached", timeout: 30_000 });
    await eventually(() => fs.existsSync(dir), false, "no folder is left here either");
    check((await page.locator('[data-screen="repo-management"]').count()) === 1, "repository management is back, no new tab");
    noErrors("cancel");
  });

  await section("Errors stay in the dialog: target taken, source missing, target folder missing, branch missing, server not reachable", async () => {
    step = "Errors";
    await openDialog();
    const banner = form.locator("[data-clone-error]");

    // Target exists and is not empty
    const taken = path.join(target, "belegt");
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, "notiz.txt"), "bleibt liegen\n");
    await field("Address").fill(source);
    await field("Folder name").fill("belegt");
    await startButton.click();
    await banner.waitFor();
    equal(await banner.getAttribute("data-clone-error"), "path_exists", "Code path_exists");
    check((await banner.innerText()).includes("The target is already taken"), `understandable sentence: ${(await banner.innerText()).replaceAll("\n", " | ")}`);
    equal(await invalid("Folder name"), "true", "the error is shown at the folder name");
    equal(await page.evaluate(() => document.activeElement?.labels?.[0]?.textContent), "Folder name", "focus is in the field that needs changing");
    equal([await field("Address").inputValue(), await field("Target folder").inputValue()], [source, target], "the input stays");
    equal(fs.readdirSync(taken), ["notiz.txt"], "the taken folder is untouched");
    equal(await toasts(page), [], "no toast – the error is shown in the dialog");
    await app.screenshot(`${SHOTS}/clone-error.png`);
    // Typing in the name removes the mark; a free name works
    await field("Folder name").fill("belegt-2");
    equal(await invalid("Folder name"), null, "after the change the field is no longer marked");

    // Known repository at the target: reported while typing
    await field("Folder name").fill("wetterdaten");
    check(/The repository “wetterdaten” is already there/.test((await errorOf("Folder name")) ?? ""), `known repository at the target: ${await errorOf("Folder name")}`);

    // Source does not exist
    await field("Address").fill(ws.at("gibt-es-nicht.git"));
    await field("Folder name").fill("aus-dem-nichts");
    await startButton.click();
    await eventually(() => banner.getAttribute("data-clone-error"), "not_found", "code not_found when the source is missing", 30_000);
    check((await banner.innerText()).includes("There is no repository at this address"), "understandable sentence");
    equal(await invalid("Address"), "true", "the error is shown at the address");
    check(!fs.existsSync(path.join(target, "aus-dem-nichts")), "no folder was created");
    await banner.getByRole("button", { name: "Show output" }).click();
    await eventually(() => dialogTitle(page), "Clone: Git output", "“Show output” opens the Git output");
    check(/gibt-es-nicht\.git/.test(await page.locator('[role="dialog"] pre').last().innerText()), "the output names the address");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await eventually(() => dialogTitle(page), "Clone repository", "the clone dialog is back afterwards");

    // Target folder does not exist
    await field("Address").fill(source);
    await field("Target folder").fill(ws.at("kein", "solcher", "ordner"));
    await startButton.click();
    await eventually(() => banner.getAttribute("data-clone-error"), "path_not_found", "code path_not_found when the target folder is missing");
    equal(await invalid("Target folder"), "true", "the error is shown at the target folder");
    await field("Target folder").fill(target);

    // Branch does not exist
    await form.getByRole("button", { name: /Advanced options/ }).click();
    await field("Branch").fill("gibt-es-nicht");
    await startButton.click();
    await eventually(() => banner.getAttribute("data-clone-error"), "not_found", "code not_found when the branch is missing", 30_000);
    console.log(`  (core message for a missing branch: ${JSON.stringify((await banner.innerText()).replaceAll("\n", " | "))}; marked at the Branch field: ${await invalid("Branch")})`);
    check(!fs.existsSync(path.join(target, "aus-dem-nichts")), "no folder was created");
    await field("Branch").fill("");

    // Server not reachable (closed local port, no network needed)
    await field("Address").fill("http://127.0.0.1:9/kein-server.git");
    await startButton.click();
    await eventually(() => banner.getAttribute("data-clone-error"), "offline", "code offline for a closed port", 60_000);
    check((await banner.innerText()).includes("Server not reachable"), "understandable sentence");
    check((await banner.innerText()).includes("No half-finished folder"), "the message says nothing was left behind");
    await press("Escape");
    await form.waitFor({ state: "detached" });
    noErrors("errors");
  });

  await section("Target folder next to the last opened repository when nothing is remembered", async () => {
    step = "Target folder suggestion";
    await page.evaluate(() => localStorage.removeItem("gc.repoParent"));
    const other = ws.repo("anderswo/unterwegs");
    await addRepo(app, other);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }));
    await app.settle();
    await openDialog();
    await eventually(() => field("Target folder").inputValue(), path.dirname(other), "the parent folder of the last opened repository is suggested");
    await press("Escape");
  });

  noErrors("overall");
} catch (error) {
  failures.push(`aborted at “${step}”: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/clone-failure.png").catch(() => undefined);
  await app?.close();
  large.cleanup();
  ws.cleanup();
}
finish("clone", failures, "target/e2e/clone-failure.png");
