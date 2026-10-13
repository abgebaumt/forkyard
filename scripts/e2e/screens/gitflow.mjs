/**
 * Git Flow: set up, start and finish feature/release/hotfix – in the real app, against a real
 * repository with a remote.
 *
 *   node scripts/e2e/screens/gitflow.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/gitflow.mjs --only Release   only sections whose title contains “Release” (comma separates several)
 *   node scripts/e2e/screens/gitflow.mjs --show           visible window
 *
 * Every step is verified in the repository: git config (gitflow.*), branches, merge commits, tags,
 * HEAD, the remote. The sections build on each other (one flow from setup to hotfix); “keyboard
 * only” means: no mouse. Fails on console errors.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { tamper } from "./commit-panel-lib.mjs";
import { SHOTS, closeToasts, finish, makeChecks, makeDriver } from "./files-lib.mjs";
import { gitIn } from "./mustfix-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const checks = makeChecks("gitflow");
const { check, equal, eventually, until, section, state } = checks;

const repo = makeCleanRepoWithRemote({ name: "ablauf" });
const config = (key) => {
  try {
    return repo.git("config", "--local", "--get", key);
  } catch {
    return null;
  }
};
const branches = () => repo.git("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
const headBranch = () => repo.git("rev-parse", "--abbrev-ref", "HEAD");
const sha = (rev) => repo.git("rev-parse", rev);
const isAncestor = (a, b) => {
  try {
    repo.git("merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};
const commitFile = (file, content, message) => {
  fs.mkdirSync(path.dirname(path.join(repo.path, file)), { recursive: true });
  fs.writeFileSync(path.join(repo.path, file), content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return sha("HEAD");
};

const DIALOG = '[data-screen="gitflow"]';
const FINISH = '[data-screen="gitflow-finish"]';

let app = null;
try {
  app = await launchApp({ show });
  state.app = app;
  const { page } = app;
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const { repoId, tabId } = await app.openRepo(repo.path);
  const ui = makeDriver(app, tabId, checks);
  const flowState = () => page.locator(DIALOG).getAttribute("data-gitflow-state", { timeout: 2000 }).catch(() => null);
  const dialog = (name) => page.getByRole("dialog", { name });
  const note = () => page.locator("[data-gitflow-note]").innerText();
  const active = () => page.locator(`${DIALOG} [data-gitflow-branch]`).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-gitflow-branch")));
  const focusedLabel = () => page.evaluate(() => document.activeElement?.labels?.[0]?.textContent?.trim() ?? document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? null);
  const tabToLabel = async (wanted, max = 20) => {
    for (let step = 0; step < max; step++) {
      if ((await focusedLabel()) === wanted) return true;
      await page.keyboard.press("Tab");
    }
    return check((await focusedLabel()) === wanted, `Tab reaches “${wanted}” (focus is on “${await focusedLabel()}”)`);
  };
  const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
  const waitToast = (pattern, tone) => until(async () => (await toasts()).some((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone)), `toast ${pattern}`, 30_000);
  const refresh = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
  };
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  const openFlow = async (commandText = "gitflow", id = "gitflow.open") => {
    await ui.runCommand(commandText, id);
    await dialog("Git Flow").waitFor();
    await until(async () => ["setup", "ready"].includes(await flowState()), "the Git Flow dialog is loaded");
  };
  /** Starts via the open dialog (mouse): choose the type, type the name, start. */
  const start = async (kindLabel, name) => {
    await page.locator(`${DIALOG} [aria-label="Type"] button`, { hasText: kindLabel }).click();
    await page.locator(`${DIALOG} form[data-gitflow-form="start"] input`).fill(name);
    await eventually(() => page.locator('[data-action="gitflow-start"]').getAttribute("aria-disabled"), null, "“Start” is enabled");
    await page.locator('[data-action="gitflow-start"]').click();
    await eventually(() => dialog("Git Flow").count(), 0, "after starting the dialog closes");
  };
  state.resetView = async () => {
    for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await closeToasts(page);
    await app.settle();
  };

  // -------------------------------------------------------------------------------------------
  await section("Not set up: Start disabled with a reason; set up – keyboard only", async () => {
    equal([config("gitflow.branch.master"), config("gitflow.branch.develop")], [null, null], "starting point: no gitflow entries in .git/config");
    await openFlow();
    equal(await flowState(), "setup", "state: not set up yet");
    check((await page.locator(DIALOG).innerText()).includes("Git Flow isn't set up here yet"), "the dialog says so");
    // Start is disabled and says why.
    check((await page.locator("[data-gitflow-locked]").innerText()).startsWith("Locked: Git Flow isn't set up in this repository yet."), "Start: disabled, with the reason as text");
    equal(await page.locator(`${DIALOG} form[data-gitflow-form="start"] input`).isDisabled(), true, "the name field is disabled");
    equal(await page.locator('[data-action="gitflow-start"]').getAttribute("aria-disabled"), "true", "the “Start Feature” button is disabled");
    check((await page.locator('[data-action="gitflow-start"]').getAttribute("title")).startsWith("Set up Git Flow first"), "and names the reason");
    // The core's suggestions are in the fields.
    equal(await focusedLabel(), "Development branch", "focus is in the “Development branch” field");
    equal(await page.evaluate(() => document.activeElement.value), "develop", "suggestion: develop");
    check((await page.locator(DIALOG).innerText()).includes("Will be created from main."), "note: the branch will be created");
    await shot("gitflow-setup");

    // Same name as the main branch: rejected at the field.
    await page.keyboard.press("Control+a");
    await page.keyboard.type("main");
    await until(async () => (await page.locator(`${DIALOG} [role="alert"]`).allInnerTexts()).join(" ").includes("must be different"), "main and development branch equal: error at the field");
    equal(await page.locator('[data-action="gitflow-init"]').getAttribute("aria-disabled"), "true", "Set up is disabled");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("develop");

    await tabToLabel("Version tag");
    await page.keyboard.type("v");
    check((await page.locator(DIALOG).innerText()).includes("v1.2.0"), "the example shows the tag with the prefix");
    await page.keyboard.press("Enter");
    await eventually(flowState, "ready", "after setup the dialog shows “Start” and the active branches");
    equal(
      ["gitflow.branch.master", "gitflow.branch.develop", "gitflow.prefix.feature", "gitflow.prefix.release", "gitflow.prefix.hotfix", "gitflow.prefix.versiontag"].map(config),
      ["main", "develop", "feature/", "release/", "hotfix/", "v"],
      "git config: the gitflow entries are in .git/config",
    );
    check(branches().includes("develop"), "git: the branch develop is created");
    equal(sha("develop"), sha("main"), "develop points at main's state");
    equal(headBranch(), "main", "HEAD is unchanged");
    await waitToast(/Git Flow set up/, "success");
    const summary = (await page.locator("[data-gitflow-summary]").innerText()).replace(/\s+/g, " ");
    check(summary.includes("Main branch main, development on develop") && summary.includes("tags with “v”"), `setup summary (${summary})`);
    equal(await active(), ["feature/export"], "an existing branch with the prefix counts as an active feature");
    await eventually(focusedLabel, "Name", "focus is now in the name field of “Start”");
  });

  // -------------------------------------------------------------------------------------------
  await section("Start Feature – keyboard only; the name is checked while typing", async () => {
    if ((await dialog("Git Flow").count()) === 0) await openFlow("git flow: start feature", "gitflow.start.feature");
    await eventually(focusedLabel, "Name", "focus is in the name field");
    check((await note()).includes("Several features can run side by side"), "empty: note on what a feature is for");
    await page.keyboard.type("export");
    await until(async () => /exists|already|taken/.test(await note()), "an existing name is rejected at the field");
    equal(await page.locator('[data-action="gitflow-start"]').getAttribute("aria-disabled"), "true", "Start is then disabled");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("wind karte");
    equal(await page.evaluate(() => document.activeElement.value), "wind-karte", "spaces become “-” while typing");
    await eventually(note, "Created as feature/wind-karte and checked out.", "the note names the full branch name");
    await shot("gitflow-start");
    const developBefore = sha("develop");
    await page.keyboard.press("Enter");
    await eventually(() => dialog("Git Flow").count(), 0, "after starting the dialog closes");
    await eventually(headBranch, "feature/wind-karte", "git: the branch is created and checked out");
    equal(sha("feature/wind-karte"), developBefore, "it branches off develop");
    await waitToast(/Feature started/, "success");
    await eventually(async () => (await app.invoke("status_get", { repoId })).head.branch, "feature/wind-karte", "the app shows the new branch as checked out");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Finish Feature – keyboard only: disabled with changes, then merge into develop; Undo", async () => {
    if (headBranch() !== "feature/wind-karte") repo.git("checkout", "-q", "feature/wind-karte");
    // Uncommitted change: finishing is disabled and says why.
    fs.writeFileSync(path.join(repo.path, "karte.md"), "# Windkarte\n");
    await refresh();
    await until(async () => (await app.invoke("status_get", { repoId })).unstaged.length === 1, "the change is in the working directory");
    await app.settle();
    await ui.runCommand("git flow: finish checked", "gitflow.finish");
    await dialog("Finish Feature “wind-karte”?").waitFor();
    check((await page.locator("[data-gitflow-blocked]").innerText()).includes("1 uncommitted change"), "with uncommitted changes: note in the dialog");
    equal(await page.locator('[data-action="gitflow-finish"]').getAttribute("aria-disabled"), "true", "“Finish Feature” is disabled");
    await shot("gitflow-finish-blocked");
    await page.keyboard.press("Escape");
    await eventually(() => dialog("Finish Feature “wind-karte”?").count(), 0, "Esc closes");

    const featureTip = commitFile("karte.md", "# Windkarte\n\nRichtung und Stärke je Station.\n", "Windkarte angelegt");
    const developBefore = sha("develop");
    await refresh();
    await until(async () => (await app.invoke("status_get", { repoId })).unstaged.length === 0, "the working directory is clean");
    await app.settle();
    await ui.runCommand("git flow: finish checked", "gitflow.finish");
    await dialog("Finish Feature “wind-karte”?").waitFor();
    equal(await page.locator("[data-gitflow-blocked]").count(), 0, "clean: no note anymore");
    check((await dialog("Finish Feature “wind-karte”?").innerText()).replace(/\s+/g, " ").includes("feature/wind-karte is merged into develop with a merge commit"), "the dialog says what happens");
    equal(await focusedLabel(), "Cancel", "focus is on “Cancel”");
    equal(await page.getByRole("checkbox", { name: /^Delete branch afterwards/ }).getAttribute("aria-checked"), "true", "default: delete branch afterwards");
    await shot("gitflow-finish-feature");
    await tabToLabel("Finish Feature");
    await page.keyboard.press("Enter");
    await waitToast(/Feature “wind-karte” finished/, "success");
    await eventually(headBranch, "develop", "git: develop is checked out afterwards");
    equal(repo.git("log", "-1", "--format=%s", "develop"), "Merge branch 'feature/wind-karte' into develop", "git: merge commit on develop");
    equal(repo.git("log", "-1", "--format=%P", "develop").split(" "), [developBefore, featureTip], "with develop and the feature as parents");
    check(!branches().includes("feature/wind-karte"), "git: the feature branch is deleted");
    check((await toasts()).some((toast) => toast.text.includes("merged into develop")), "the toast summarises what happened");
    await closeToasts(page);

    // Undo reverts the whole finish, Redo restores it.
    const merged = sha("develop");
    await page.locator('[data-area="center"]').click({ position: { x: 300, y: 400 } }).catch(() => undefined);
    await page.keyboard.press("Control+z");
    await eventually(() => branches().includes("feature/wind-karte") && sha("develop") === developBefore, true, "Ctrl+Z: the feature branch is back, develop is as before");
    // Only press the next key once the app has finished the undo (the “Redo” button is enabled).
    await eventually(async () => (await app.invoke("undo_peek", { repoId })).redo?.action ?? null, "merge", "the core offers “Redo”");
    await app.settle();
    await eventually(() => page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Redo/ }).first().getAttribute("aria-disabled"), null, "the “Redo” button is enabled");
    await closeToasts(page);
    await page.keyboard.press("Control+Shift+z");
    await eventually(() => sha("develop") === merged && !branches().includes("feature/wind-karte"), true, "Redo: the finish is back");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Release: only one at a time; finish with a tag and a custom message", async () => {
    await openFlow();
    await start("Release", "1.2.0");
    await eventually(headBranch, "release/1.2.0", "git: release/1.2.0 is checked out");
    equal(sha("release/1.2.0"), sha("develop"), "it branches off develop");
    await closeToasts(page);

    // A second release is blocked – with the name of the active one.
    await openFlow("git flow: start release", "gitflow.start.release");
    equal(await page.locator(`${DIALOG} [aria-label="Type"] button[data-state="on"]`).innerText(), "Release", "the command opens the dialog with “Release”");
    check((await note()).includes("The Release “1.2.0” (release/1.2.0) is already in progress. Finish it first."), "a second release is blocked, with a reason");
    equal(await page.locator('[data-action="gitflow-start"]').getAttribute("aria-disabled"), "true", "Start is disabled");
    equal(await active(), ["feature/export", "release/1.2.0"], "the list shows feature and release");
    // The badge depends on the repository status, which the app only reloads after the release start
    // on the core's event. The list itself (Git Flow state) is often already there by then.
    await until(async () => (await page.locator(`${DIALOG} [data-gitflow-branch="release/1.2.0"]`).innerText()).includes("checked out"), "the checked-out branch is marked with a word");
    await shot("gitflow-ready");
    await page.keyboard.press("Escape");

    const releaseTip = commitFile("VERSION", "1.2.0\n", "Version 1.2.0");
    const mainBefore = sha("main");
    await refresh();
    await openFlow();
    await page.locator(`${DIALOG} [data-gitflow-branch="release/1.2.0"]`).getByRole("button", { name: "Finish Release “1.2.0” …" }).click();
    const finishDialog = dialog("Finish Release “1.2.0”?");
    await finishDialog.waitFor();
    check((await finishDialog.innerText()).replace(/\s+/g, " ").includes("release/1.2.0 is merged into main, marked there as a version, and merged back into develop"), "the dialog says what happens");
    equal(await finishDialog.getByRole("textbox", { name: "Tag name" }).inputValue(), "v1.2.0", "default for the tag: prefix + name");
    equal(await finishDialog.getByRole("textbox", { name: "Tag message" }).inputValue(), "Release 1.2.0", "default for the message");
    // An invalid tag name is rejected at the field.
    await finishDialog.getByRole("textbox", { name: "Tag name" }).fill("v1..2");
    await until(async () => (await finishDialog.getByRole("alert").allInnerTexts()).join(" ").includes("Two dots"), "invalid tag name: reason at the field");
    equal(await page.locator('[data-action="gitflow-finish"]').getAttribute("aria-disabled"), "true", "Finish is then disabled");
    await finishDialog.getByRole("textbox", { name: "Tag name" }).fill("v1.2.0");
    await finishDialog.getByRole("textbox", { name: "Tag message" }).fill("Release 1.2.0 – Frühjahrsmessung");
    await shot("gitflow-finish-release");
    await page.locator('[data-action="gitflow-finish"]').click();
    await waitToast(/Release “1\.2\.0” finished/, "success");
    await eventually(headBranch, "develop", "git: develop is checked out afterwards");
    equal(repo.git("log", "-1", "--format=%s", "main"), "Merge branch 'release/1.2.0'", "git: merge commit on main");
    equal(repo.git("log", "-1", "--format=%P", "main").split(" "), [mainBefore, releaseTip], "with main and the release as parents");
    equal(repo.git("cat-file", "-t", "v1.2.0"), "tag", "git: v1.2.0 is an annotated tag");
    equal(repo.git("tag", "-l", "--format=%(contents:subject)", "v1.2.0"), "Release 1.2.0 – Frühjahrsmessung", "with the entered message");
    equal(sha("v1.2.0^{commit}"), sha("main"), "the tag points at the merge in main");
    check(isAncestor(releaseTip, "develop"), "the release is also in develop");
    check(!branches().includes("release/1.2.0"), "git: the release branch is deleted");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Hotfix: conflict when merging back – resolve, finish again", async () => {
    // develop and the hotfix change the same line.
    if (headBranch() !== "develop") repo.git("checkout", "-q", "develop");
    const readme = fs.readFileSync(path.join(repo.path, "README.md"), "utf8");
    const firstLine = readme.split("\n")[0];
    commitFile("README.md", readme.replace(firstLine, `${firstLine} (Entwicklung)`), "README: Titel in der Entwicklung");
    await refresh();
    await openFlow();
    await start("Hotfix", "1.2.1");
    await eventually(headBranch, "hotfix/1.2.1", "git: hotfix/1.2.1 is checked out");
    equal(sha("hotfix/1.2.1"), sha("main"), "a hotfix branches off the main branch");
    const mainReadme = fs.readFileSync(path.join(repo.path, "README.md"), "utf8");
    const hotfixTip = commitFile("README.md", mainReadme.replace(firstLine, `${firstLine} (Korrektur)`), "README: Titel korrigiert");
    await refresh();
    await closeToasts(page);

    await ui.runCommand("git flow: finish checked", "gitflow.finish");
    await dialog("Finish Hotfix “1.2.1”?").waitFor();
    await page.locator('[data-action="gitflow-finish"]').click();
    await waitToast(/Finish Hotfix: conflict in one file/, "warning");
    check((await toasts()).some((toast) => toast.text.includes("again")), "the toast says how to continue");
    await eventually(async () => (await app.invoke("status_get", { repoId })).conflicted.map((item) => item.path), ["README.md"], "the app shows the conflicted file");
    equal(await page.evaluate((id) => window.__gc.store.getState().views[id]?.selection ?? { kind: "wip" }, tabId), { kind: "wip" }, "the view is on the local changes");
    check(isAncestor(hotfixTip, "main"), "git: the hotfix is already merged into main");
    equal(repo.git("tag", "-l", "v1.2.1"), "v1.2.1", "git: the tag v1.2.1 is created");
    check(branches().includes("hotfix/1.2.1"), "the hotfix branch still exists");
    await shot("gitflow-conflict");
    await closeToasts(page);

    // Resolve the conflict (incoming version) and complete the merge – as in the commit panel.
    await app.invoke("conflict_resolve", { repoId, path: "README.md", content: null, side: "theirs" });
    await app.invoke("operation_continue", { repoId, message: null });
    await refresh();
    await eventually(async () => (await app.invoke("status_get", { repoId })).operation, null, "the merge is complete");
    check(branches().includes("hotfix/1.2.1"), "the hotfix branch is still there – the finish is not done yet");

    await openFlow();
    equal((await active()).includes("hotfix/1.2.1"), true, "the dialog still lists the hotfix as active");
    await page.locator(`${DIALOG} [data-gitflow-branch="hotfix/1.2.1"]`).getByRole("button", { name: "Finish Hotfix “1.2.1” …" }).click();
    await dialog("Finish Hotfix “1.2.1”?").waitFor();
    await page.locator('[data-action="gitflow-finish"]').click();
    await until(async () => (await toasts()).some((toast) => /Hotfix “1\.2\.1” finished|Nothing left to do/.test(toast.text)), "the second run finishes", 30_000);
    await eventually(() => branches().includes("hotfix/1.2.1"), false, "git: the hotfix branch is now deleted");
    check(isAncestor(hotfixTip, "develop"), "git: the hotfix is in develop");
    equal(headBranch(), "develop", "HEAD is develop");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Finish with “Push afterwards”: the remote gets the state", async () => {
    const remoteConfig = path.join(repo.root, "gitconfig");
    await openFlow();
    await start("Feature", "push-probe");
    await eventually(headBranch, "feature/push-probe", "feature started");
    commitFile("probe.md", "# Probe\n", "Probe für den Push");
    await refresh();
    await closeToasts(page);
    await ui.runCommand("git flow: finish checked", "gitflow.finish");
    const finishDialog = dialog("Finish Feature “push-probe”?");
    await finishDialog.waitFor();
    const push = finishDialog.getByRole("checkbox", { name: /^Push afterwards/ });
    equal(await push.getAttribute("aria-checked"), "false", "default: no push");
    check((await finishDialog.innerText()).includes("Pushes develop."), "the note says what would be pushed");
    await push.click();
    await page.locator('[data-action="gitflow-finish"]').click();
    await waitToast(/Feature “push-probe” finished/, "success");
    await eventually(() => gitIn(repo.remotePath, remoteConfig, "rev-parse", "refs/heads/develop"), sha("develop"), "git in the remote: develop is at the local state");
    equal(gitIn(repo.remotePath, remoteConfig, "log", "-1", "--format=%s", "develop"), "Merge branch 'feature/push-probe' into develop", "with the merge commit");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("States: loading, error; many and very long branches; change setup; light and minimum window", async () => {
    const tip = sha("develop");
    const longName = `feature/${"sehr-langer-name-fuer-ein-feature-".repeat(4)}ende`;
    for (let index = 0; index < 30; index++) repo.git("branch", `feature/station-${String(index).padStart(2, "0")}`, tip);
    repo.git("branch", longName, tip);
    await refresh();

    // Hold first, then forget the state: the request waits until the test releases it. A fixed 2.5 s
    // delay was not enough – going through the palette took longer under load, and the dialog then
    // opened with the finished state right away.
    const slow = await tamper(page, "gitflowStatus", { hold: true });
    await page.evaluate((id) => window.__gc.queryClient.removeQueries({ queryKey: ["repo", id, "gitflow"] }), repoId);
    await ui.runCommand("gitflow", "gitflow.open");
    await dialog("Git Flow").waitFor();
    await eventually(flowState, "loading", "while the state loads, a skeleton is shown");
    equal(await page.locator(`${DIALOG} [role="status"]`).count(), 1, "skeleton with role=status");
    await slow.release();
    await eventually(flowState, "ready", "then the dialog");
    await slow.restore();
    equal((await active()).length, 32, "32 active branches are in the list (30 new, the long one, feature/export)");
    const list = page.locator(`${DIALOG} ul[aria-label="Active Git Flow branches"]`);
    const box = await list.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight, wide: element.scrollWidth - element.clientWidth }));
    check(box.scroll > box.client && box.wide === 0, `the list scrolls vertically, not horizontally (${JSON.stringify(box)})`);
    equal(await page.evaluate(() => {
      const root = document.documentElement;
      const frame = document.querySelector('[role="dialog"]').getBoundingClientRect();
      return [root.scrollWidth - root.clientWidth, frame.right <= window.innerWidth && frame.bottom <= window.innerHeight];
    }), [0, true], "even with the very long name everything stays inside the dialog");
    await shot("gitflow-many");
    await app.setTheme("light");
    await shot("gitflow-many-light");
    await app.setTheme("dark");

    // Change setup: the tag prefix is dropped.
    await page.getByRole("button", { name: "Change setup" }).click();
    await eventually(flowState, "editing", "the setup form opens with the values");
    const prefix = page.locator(`${DIALOG} form[data-gitflow-form="setup"]`).getByRole("textbox", { name: "Version tag" });
    equal(await prefix.inputValue(), "v", "the saved prefix is in the field");
    await prefix.fill("");
    await page.locator('[data-action="gitflow-init"]').click();
    await eventually(flowState, "ready", "after saving the overview again");
    await eventually(() => config("gitflow.prefix.versiontag") ?? "", "", "git config: no prefix for version tags anymore");
    await page.keyboard.press("Escape");
    await closeToasts(page);

    const broken = await tamper(page, "gitflowStatus", { fail: { code: "io", message: "The configuration could not be read (probe).", gitOutput: null } });
    await page.evaluate((id) => window.__gc.queryClient.removeQueries({ queryKey: ["repo", id, "gitflow"] }), repoId);
    await ui.runCommand("gitflow", "gitflow.open");
    await dialog("Git Flow").waitFor();
    await eventually(flowState, "error", "if reading fails, the error state is shown");
    check((await page.locator(`${DIALOG} [role="alert"]`).innerText()).includes("The configuration could not be read (probe)."), "with the reason");
    await shot("gitflow-error");
    // Restore and press in one go: a core event in between reloads the state by itself, and the
    // button would be gone before the click hits it (that made a run time out).
    check(await broken.restoreAndPress(DIALOG, "Try again"), "there is “Try again”");
    await eventually(flowState, "ready", "“Try again” loads the state");

    await app.setSize(960, 600);
    equal(await page.evaluate(() => {
      const root = document.documentElement;
      const frame = document.querySelector('[role="dialog"]').getBoundingClientRect();
      return [root.scrollWidth - root.clientWidth, frame.left >= 0 && frame.top >= 0 && frame.right <= window.innerWidth && frame.bottom <= window.innerHeight];
    }), [0, true], "960×600: the dialog fits the window");
    await shot("gitflow-min");
    await app.setSize(1440, 900);
    await page.keyboard.press("Escape");
  });
} catch (error) {
  check(false, `script aborted: ${error?.stack ?? error}`);
}
await finish("gitflow", checks, app, () => repo.cleanup());
