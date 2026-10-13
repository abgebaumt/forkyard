/**
 * remote-dialog remote dialog in the real app against real repositories.
 *
 *   node scripts/e2e/screens/remote-dialog.mjs [--show]
 *
 * Add (keyboard only), field errors, separate push URL, fetch afterwards, edit, remove with
 * confirmation and undo – each verified with `git remote -v` in the fixture.
 * The dialog is opened via the store (`openOverlay({ kind: "add_remote" })`), just like the
 * "+" in the left panel does; everything after that goes through the UI.
 */
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeEmptyRepo } from "../fixtures.mjs";
import { createChecks, finish, gitIn, pageHelpers } from "./prefs-lib.mjs";

const show = process.argv.includes("--show");
const { failures, check, equal, eventually, until, section, setCurrent } = createChecks();
const SHOTS = "target/e2e/shots";

const fresh = makeEmptyRepo({ name: "station-sued" });
const shared = makeCleanRepoWithRemote();
const LONG_NAME = "spiegel-des-messnetzes-auf-dem-schulserver-nord-fuer-notfaelle"; // 60 characters
const LONG_URL = `https://git.schulserver-nord.example/${"auswertung-und-archiv/".repeat(7)}messnetz-wetterstationen.git`; // a little over 200 characters

let app = null;
try {
  app = await launchApp({ show });
  const { page } = app;
  const h = pageHelpers(app);
  const openDialog = (edit) => page.evaluate((name) => window.__gc.store.getState().openOverlay(name ? { kind: "add_remote", edit: name } : { kind: "add_remote" }), edit ?? null);
  const add = page.getByRole("dialog", { name: "Add remote" });
  const remotes = (repoPath) => gitIn(repoPath, ["remote", "-v"]).split(/\r?\n/).filter(Boolean).map((line) => line.replace(/\s+/g, " "));
  const alerts = async (dialog) => (await dialog.getByRole("alert").allInnerTexts()).join(" | ");

  const { repoId: freshId } = await app.openRepo(fresh.path);

  // -------------------------------------------------------------------------
  await section("Add – keyboard only, then fetch right away", async () => {
    equal(remotes(fresh.path), [], "the repository has no remote yet");
    await openDialog();
    await add.waitFor();
    await eventually(h.focusedName, "Name", "focus in the \"Name\" field");
    equal(await add.getByLabel("Name").inputValue(), "origin", "default \"origin\" because there is no remote yet");
    equal(await add.getByRole("checkbox", { name: /Fetch right away/ }).getAttribute("aria-checked"), "true", "\"Fetch right away\" is preselected");

    // Submit empty: field error, nothing happens
    await page.keyboard.press("Enter");
    await until(async () => /The URL is missing/.test(await alerts(add)), "without URL: field error");
    equal(remotes(fresh.path), [], "nothing added");

    await h.tabTo("Fetch URL");
    await page.keyboard.type("https://github.com/wetterstation/messnetz.git");
    await eventually(() => add.locator("[data-host]").getAttribute("data-host"), "github", "detected host as a badge");
    equal((await add.locator("[data-host]").innerText()).trim(), "GitHub", "the badge names the host as text");
    await app.screenshot(`${SHOTS}/remote-dialog.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/remote-dialog-light.png`);
    await app.setTheme("dark");
    for (const [url, kind, label] of [
      ["git@gitlab.com:group/project.git", "gitlab", "GitLab"],
      ["ssh://git@bitbucket.org/team/project.git", "bitbucket", "Bitbucket"],
      ["https://dev.azure.com/company/project/_git/repo", "azure", "Azure DevOps"],
      ["git@git.schulserver.example:class/weather.git", "other", "git.schulserver.example"],
    ]) {
      await h.retype(url);
      await eventually(async () => [await add.locator("[data-host]").getAttribute("data-host"), (await add.locator("[data-host]").innerText()).trim()], [kind, label], `badge for ${url}`);
    }

    // Protocol the core rejects: its message is shown at the URL field
    await h.retype("svn://server.example/project");
    await page.keyboard.press("Enter");
    await until(async () => /The protocol “svn” is not supported/.test(await alerts(add)), "rejected URL: core message at the field");
    equal(await h.toasts(), [], "no toast for a field error");
    equal(remotes(fresh.path), [], "nothing added");

    await h.retype(shared.remotePath);
    await eventually(() => add.locator("[data-host]").getAttribute("data-host"), "local", "a folder counts as a local path");
    await page.keyboard.press("Enter");
    await eventually(h.dialogs, [], "the dialog closes after adding");
    await eventually(() => remotes(fresh.path), [`origin ${shared.remotePath} (fetch)`, `origin ${shared.remotePath} (push)`], "git remote -v shows the new remote");
    await h.waitToast(/Remote “origin” added/);
    await h.waitToast(/Fetch( from origin)? complete/, 30_000);
    // %(refname) instead of :short – origin/HEAD would be just "origin" in short form.
    await eventually(
      () => gitIn(fresh.path, ["branch", "-r", "--format=%(refname)"]).split(/\r?\n/).filter((ref) => ref && !ref.endsWith("/HEAD")).sort(),
      ["refs/remotes/origin/feature/export", "refs/remotes/origin/main"],
      "the fetch got the remote branches",
    );
    equal((await app.invoke("remote_list", { repoId: freshId })).map((remote) => remote.name), ["origin"], "remote_list in the core");
    await h.closeToasts();
  });

  // -------------------------------------------------------------------------
  await section("Field errors: name taken, invalid; separate push URL; without fetch", async () => {
    await openDialog();
    await add.waitFor();
    equal(await add.getByLabel("Name").inputValue(), "", "\"origin\" is taken: no suggestion anymore");
    await add.getByLabel("Fetch URL").fill(shared.remotePath);
    await add.getByLabel("Name").fill("origin");
    await add.getByRole("button", { name: "Add remote" }).click();
    await until(async () => /A remote named “origin” already exists/.test(await alerts(add)), "taken name: field error");
    equal(await add.getByLabel("Name").getAttribute("aria-invalid"), "true", "the field is marked invalid");
    await add.getByLabel("Name").fill("two..dots");
    await add.getByRole("button", { name: "Add remote" }).click();
    await until(async () => /aren't allowed/.test(await alerts(add)), "invalid name: field error");
    // "HEAD" passes the pre-check; the core rejects it and its message lands at the field.
    await add.getByLabel("Name").fill("HEAD");
    await add.getByRole("button", { name: "Add remote" }).click();
    await until(async () => /reserved/.test(await alerts(add)), "name rejected by the core: message at the field");
    equal(await h.toasts(), [], "no toast");
    await add.getByLabel("Name").fill("with some spaces");
    equal(await add.getByLabel("Name").inputValue(), "with-some-spaces", "spaces become \"-\" while typing");
    await app.screenshot(`${SHOTS}/remote-dialog-error.png`);

    // Separate push URL
    await add.getByLabel("Name").fill("upstream");
    equal(await add.getByLabel("Push URL", { exact: true }).count(), 0, "the push URL is collapsed");
    await add.getByRole("checkbox", { name: /Separate push URL/ }).focus();
    await page.keyboard.press("Space");
    await add.getByLabel("Push URL", { exact: true }).waitFor();
    await add.getByRole("button", { name: "Add remote" }).click();
    await until(async () => /Enter the push URL/.test(await alerts(add)), "an empty push URL must be filled in or switched off");
    await add.getByLabel("Push URL", { exact: true }).fill(fresh.path);
    await app.screenshot(`${SHOTS}/remote-dialog-push.png`);
    await add.getByRole("checkbox", { name: /Fetch right away/ }).click();
    await add.getByRole("button", { name: "Add remote" }).click();
    await eventually(h.dialogs, [], "dialog closed");
    await eventually(() => remotes(fresh.path).filter((line) => line.startsWith("upstream")), [`upstream ${shared.remotePath} (fetch)`, `upstream ${fresh.path} (push)`], "git remote -v: separate push URL");
    await h.waitToast(/Remote “upstream” added/);
    await page.waitForTimeout(600);
    check(!(await h.toasts()).some((text) => /Fetch/.test(text)), "without the checkbox there is no fetch");
    equal(gitIn(fresh.path, ["branch", "-r", "--list", "upstream/*"]), "", "no remote branches from upstream");
    await h.closeToasts();
  });

  // -------------------------------------------------------------------------
  await section("Edit: rename, change URL, remove push URL", async () => {
    await openDialog("upstream");
    const edit = page.getByRole("dialog", { name: "Edit remote “upstream”" });
    await edit.waitFor();
    equal(
      [await edit.getByLabel("Name").inputValue(), await edit.getByLabel("Fetch URL").inputValue(), await edit.getByLabel("Push URL", { exact: true }).inputValue()],
      ["upstream", shared.remotePath, fresh.path],
      "the fields are filled with the remote's values",
    );
    equal(await edit.getByRole("checkbox", { name: /Fetch after saving/ }).getAttribute("aria-checked"), "false", "fetching is not preselected when editing");
    check((await edit.getByRole("button", { name: "Remove remote" }).count()) === 1, "there is \"Remove remote\"");
    await app.screenshot(`${SHOTS}/remote-dialog-edit.png`);

    await edit.getByLabel("Name").fill("origin");
    await edit.getByRole("button", { name: "Save" }).click();
    await until(async () => /already exists/.test(await alerts(edit)), "renaming to a taken name: field error");

    // Very long values
    await edit.getByLabel("Name").fill(LONG_NAME);
    await edit.getByLabel("Fetch URL").fill(LONG_URL);
    equal(await h.escaping('[role="dialog"]'), [], "a 60-character name and a 200-character URL do not break the dialog");
    await app.screenshot(`${SHOTS}/remote-dialog-long.png`);
    await edit.getByRole("checkbox", { name: /Separate push URL/ }).click();
    await edit.getByRole("button", { name: "Save" }).click();
    await eventually(h.dialogs, [], "dialog closed");
    await eventually(() => remotes(fresh.path).filter((line) => !line.startsWith("origin")), [`${LONG_NAME} ${LONG_URL} (fetch)`, `${LONG_NAME} ${LONG_URL} (push)`], "git remote -v: renamed, new URL, no separate push URL anymore");
    equal(gitIn(fresh.path, ["config", "--get", `remote.${LONG_NAME}.pushurl`]), "", "pushurl is removed from the configuration");
    await h.waitToast(/saved/);
    await h.closeToasts();

    await openDialog("does-not-exist");
    const gone = page.getByRole("dialog", { name: "Edit remote “does-not-exist”" });
    await gone.waitFor();
    await until(async () => /no longer exists/.test(await gone.innerText()), "unknown remote: notice instead of form");
    check(await gone.getByRole("button", { name: "Save" }).isDisabled(), "Save is disabled");
    await page.keyboard.press("Escape");
    await eventually(h.dialogs, [], "Esc closes");
  });

  // -------------------------------------------------------------------------
  await section("Remove with confirmation; Undo brings the remote back", async () => {
    const { repoId } = await app.openRepo(shared.path);
    const before = remotes(shared.path);
    equal(before.length, 2, "messnetz has origin");
    check(gitIn(shared.path, ["branch", "-r"]).includes("origin/main"), "and remote branches");
    await openDialog("origin");
    const edit = page.getByRole("dialog", { name: "Edit remote “origin”" });
    await edit.waitFor();
    await edit.getByRole("button", { name: "Remove remote" }).focus();
    await page.keyboard.press("Enter");
    const ask = page.getByRole("dialog", { name: "Remove remote “origin”?" });
    await ask.waitFor();
    await eventually(h.focusedName, "Cancel", "confirmation: focus on \"Cancel\"");
    check(/remote branches origin\/…/.test(await ask.innerText()) && /Undo/.test(await ask.innerText()), "the confirmation says what disappears and that it can be brought back");
    await app.screenshot(`${SHOTS}/remote-dialog-remove.png`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    equal(remotes(shared.path), before, "Cancel removes nothing");
    await edit.getByRole("button", { name: "Remove remote" }).click();
    await page.getByRole("dialog", { name: "Remove remote “origin”?" }).getByRole("button", { name: "Remove remote" }).click();
    await eventually(() => remotes(shared.path), [], "git remote -v is empty");
    await eventually(h.dialogs, [], "both dialogs are closed");
    equal(gitIn(shared.path, ["branch", "-r"]), "", "the remote branches are gone");
    equal(await app.invoke("remote_list", { repoId }), [], "remote_list in the core");
    await h.waitToast(/Remote “origin” removed/);

    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).click();
    await eventually(() => remotes(shared.path), before, "Undo restores name and URLs");
    await h.closeToasts();
  });

  // -------------------------------------------------------------------------
  await section("States: load error, 960×600", async () => {
    await openDialog();
    await add.waitFor();
    // Cannot be caused with the real core: simulated at the core boundary (remote_list really
    // fails). The test used to only flip the query state; a core event (file watcher) then
    // sometimes reloaded it, and the button vanished under the click.
    const repoId = await page.evaluate(() => window.__gc.queryClient.getQueryData(["app", "tabs"]).find((tab) => tab.isActive).repoId);
    const broken = await h.breakQuery("remoteList", ["repo", repoId, "remotes"], "The configuration is not readable.");
    await broken.fail();
    await until(async () => /The remotes couldn't be loaded/.test(await alerts(add)), "the load error is shown in the dialog");
    check(await add.getByRole("button", { name: "Add remote" }).isDisabled(), "Add is disabled meanwhile");
    await app.screenshot(`${SHOTS}/remote-dialog-loaderror.png`);
    check(await broken.restoreAndPress('[role="dialog"]', "Try again"), "there is \"Try again\"");
    await add.getByLabel("Name").waitFor();
    await add.getByLabel("Fetch URL").fill("git@github.com:wetterstation/messnetz.git");
    await app.setSize(960, 600);
    await page.waitForTimeout(200);
    const box = await add.boundingBox();
    check(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `960×600: the dialog lies fully inside the window (${JSON.stringify(box)})`);
    equal(await h.escaping('[role="dialog"]'), [], "960×600: nothing sticks out");
    await app.screenshot(`${SHOTS}/remote-dialog-min.png`);
    await app.setSize(1440, 900);
    await add.getByRole("button", { name: "Cancel" }).click();
    await eventually(h.dialogs, [], "Cancel closes");
    equal(remotes(shared.path).length, 2, "Cancel changed nothing");
  });

  setCurrent("Console");
  check(app.consoleErrors.length === 0, `console errors:\n${app.consoleErrors.join("\n")}`);
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/remote-dialog-error.png").catch(() => undefined);
  await app?.close();
  fresh.cleanup();
  shared.cleanup();
}
finish("remote-dialog remote dialog", failures);
