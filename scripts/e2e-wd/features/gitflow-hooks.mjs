/**
 * Git Flow (set up, start and finish feature/release/hotfix) and Git hooks (rejecting hooks with
 * their output, "Skip Git hooks", notices for hooks that print something, core.hooksPath from the
 * preferences, pre-push, a hook stopping a Git Flow finish) in the real app over WebDriver.
 *
 *   node scripts/e2e-wd/features/gitflow-hooks.mjs
 *   E2E_WD_ONLY="hooks" node scripts/e2e-wd/features/gitflow-hooks.mjs
 *
 * Every scenario checks the UI and the repository (git config gitflow.*, branches, merge commits,
 * tags, HEAD, the remote, hook side effects).
 */
import fs from "node:fs";
import path from "node:path";
import { commitUi } from "../fixtures/commit-ui.mjs";
import { eventually, flowUi, makeFlowRepo, until } from "../fixtures/gitflow-hooks.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const FLOW_KEYS = ["gitflow.branch.master", "gitflow.branch.develop", "gitflow.prefix.feature", "gitflow.prefix.release", "gitflow.prefix.hotfix", "gitflow.prefix.versiontag"];

/** Git Flow set up directly in Git (the same keys the app writes), develop created from main. */
function initFlowInGit(repo, { tag = "v" } = {}) {
  repo.git("config", "gitflow.branch.master", "main");
  repo.git("config", "gitflow.branch.develop", "develop");
  repo.git("config", "gitflow.prefix.feature", "feature/");
  repo.git("config", "gitflow.prefix.release", "release/");
  repo.git("config", "gitflow.prefix.hotfix", "hotfix/");
  repo.git("config", "gitflow.prefix.versiontag", tag);
  repo.git("branch", "develop", "main");
}

/** Launches the app, opens the repository and returns the drivers. */
async function open(t, repo, launch = {}) {
  const app = await t.launch({ ...LAUNCH, ...launch });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const ids = await app.openRepo(repo.path);
  const ui = flowUi(app);
  await app.waitFor('[data-row-id="refs/heads/main"]', 20_000, { message: "main in the sidebar" });
  await app.settle();
  return { app, ui, commit: commitUi(app), ...ids };
}

/** Status of the repository as the app sees it (query cache). */
const appStatus = (app, repoId) => app.exec((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"]) ?? null, repoId);
/** Opens Preferences on the project section "Files and hooks" (nav click) and returns the hooks folder field. */
async function openHooksFolder(app) {
  await app.exec(() => window.__gc.store.getState().openOverlay({ kind: "preferences", section: "repo" }));
  await app.click(await app.waitFor(() => app.byText("Files and hooks", { within: '[role="dialog"]' }), 10_000, { message: "nav entry Files and hooks" }));
  return app.waitFor(() => app.exec(() => document.querySelector('[role="dialog"] input[placeholder=".git/hooks"]')), 10_000, { message: "Hooks folder field" });
}

async function waitClean(app, ui, repoId) {
  await ui.refresh();
  await until(async () => {
    const status = await appStatus(app, repoId);
    return status && status.unstaged.length === 0 && status.staged.length === 0 && status.conflicted.length === 0 && !status.operation;
  }, "the app sees a clean working directory", 20_000);
}
async function waitHead(app, ui, repoId, branch) {
  await ui.refresh();
  await eventually(async () => (await appStatus(app, repoId))?.head?.branch ?? null, branch, `the app shows ${branch} as checked out`, 20_000);
}

/** Wraps a scenario so the fixture is always removed. */
const withRepo = (make, fn) => async (t) => {
  const repo = make();
  try {
    await fn(t, repo);
  } finally {
    repo.cleanup();
  }
};

// =============================================================================================
// Git Flow: set up
// =============================================================================================

scenario("git flow: set up with the keyboard – gitflow entries in .git/config, develop created", "main", withRepo(makeFlowRepo, async (t, repo) => {
  assertEqual(FLOW_KEYS.map(repo.config), FLOW_KEYS.map(() => null), "starting point: no gitflow entries");
  const { app, ui } = await open(t, repo);
  await ui.openFlow();
  assertEqual(await ui.flowState(), "setup", "state: not set up yet");
  assertIncludes(await ui.text(ui.DIALOG), "Git Flow isn't set up here yet", "the dialog says so");
  assertMatch(await ui.text("[data-gitflow-locked]"), /^Locked: Git Flow isn't set up in this repository yet\./, "Start is locked with a reason");
  assertEqual(await (await ui.startInput()).prop("disabled"), true, "the name field is disabled");
  assertEqual(await ui.startBlocked(), "true", "“Start Feature” is disabled");
  assertMatch(await ui.attr('[data-action="gitflow-start"]', "title"), /^Set up Git Flow first/, "and names the reason");

  // The core's suggestions are in the fields; focus is in "Development branch".
  await eventually(ui.focusedLabel, "Development branch", "focus is in “Development branch”");
  assertEqual(await ui.focusedValue(), "develop", "suggestion: develop");
  assertIncludes(await ui.text(ui.DIALOG), "Will be created from main.", "note: develop will be created");
  await ui.tabTo("Version tag");
  await app.type(await app.waitFor(() => app.exec(() => document.activeElement)), "v");
  await until(async () => (await ui.text(ui.DIALOG)).includes("v1.2.0"), "the example shows the tag with the prefix");
  await t.shot("setup");
  t.step("setup form filled with the keyboard");

  await app.press("Enter");
  await eventually(ui.flowState, "ready", "after setting up: Start and the running branches");
  assertEqual(FLOW_KEYS.map(repo.config), ["main", "develop", "feature/", "release/", "hotfix/", "v"], "git config: gitflow entries written");
  assert(repo.branches().includes("develop"), "git: develop created");
  assertEqual(repo.sha("develop"), repo.sha("main"), "develop starts at main");
  assertEqual(repo.head(), "main", "HEAD unchanged");
  await ui.waitToast("success", /Git Flow set up/);
  const summary = await ui.text("[data-gitflow-summary]");
  assertIncludes(summary, "Main branch main, development on develop", "summary of the branches");
  assertIncludes(summary, "tags with “v”", "summary of the tag prefix");
  assertEqual(await ui.active(), ["feature/export"], "an existing branch with the prefix counts as a running feature");
  await eventually(ui.focusedLabel, "Name", "focus moves to the name field of Start");
  await t.shot("setup-done");
  await t.noConsoleErrors(app);
}));

scenario("git flow: not set up – palette entries locked; same branch, empty/duplicate prefix and invalid name are refused", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  const { app, ui } = await open(t, repo);
  // The palette knows the state and explains why "start" and "finish" are not possible.
  await ui.openPalette("git flow");
  const entry = (id) =>
    app.exec((key) => {
      const node = document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`);
      return node ? { disabled: node.getAttribute("aria-disabled"), text: node.innerText.replace(/\s+/g, " ").trim() } : null;
    }, id);
  await eventually(async () => (await entry("gitflow.start.feature"))?.disabled ?? null, "true", "“Start feature” is disabled in the palette");
  await until(async () => (await entry("gitflow.start.feature"))?.text.includes("Git Flow is not set up here yet"), "with the reason");
  await eventually(async () => (await entry("gitflow.finish"))?.disabled ?? null, "true", "“Finish” is disabled in the palette");
  assertIncludes((await entry("gitflow.finish")).text, "Git Flow is not set up here yet", "with the reason");
  await ui.closePalette();

  await ui.openFlow();
  const develop = await ui.field("Development branch");
  await ui.fill(develop, "main");
  await until(async () => (await ui.text(`${ui.DIALOG} form[data-gitflow-form="setup"]`)).includes("The main and development branches must be different."), "same branch: error at the field");
  assertEqual(await ui.attr('[data-action="gitflow-init"]', "aria-disabled"), "true", "Set up is disabled");
  await ui.fill(develop, "");
  await eventually(() => ui.attr('[data-action="gitflow-init"]', "title"), "The development branch needs a name.", "empty name: reason on the button");
  await ui.fill(develop, "develop");

  const feature = await ui.field("Feature");
  await ui.fill(feature, "");
  await until(async () => (await ui.text(`${ui.DIALOG} fieldset [role="alert"]`)) === "The prefix for Feature is missing.", "empty prefix: reason");
  await ui.fill(feature, "release/");
  await until(async () => (await ui.text(`${ui.DIALOG} fieldset [role="alert"]`))?.startsWith("The three prefixes must differ"), "duplicate prefix: reason");
  await app.click('[data-action="gitflow-init"]');
  await ui.sleep(400);
  assertEqual(repo.config("gitflow.branch.develop"), null, "a blocked setup writes nothing");
  await ui.fill(feature, "feature/");

  // A name Git refuses comes back from the core and is shown in the form.
  await ui.fill(develop, "dev..elop");
  await app.click('[data-action="gitflow-init"]');
  const failure = await app.waitFor("[data-gitflow-failure]", 10_000);
  assertIncludes(await failure.text().then((text) => text || ui.text("[data-gitflow-failure]")), "Not set up", "the failure is shown in the dialog");
  assertEqual(await ui.flowState(), "setup", "the dialog stays in the setup state");
  assertEqual([repo.config("gitflow.branch.develop"), repo.branches().includes("dev..elop")], [null, false], "git: nothing written, no branch");
  await t.shot("setup-invalid");

  // Esc closes without writing.
  await app.press("Escape");
  await ui.noDialog();
  assertEqual(FLOW_KEYS.map(repo.config), FLOW_KEYS.map(() => null), "git config: still no gitflow entries after cancel");
  assertEqual(repo.branches(), ["feature/export", "main"], "git: no branch created");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Git Flow: feature
// =============================================================================================

scenario("git flow: start a feature with the keyboard and finish it into develop", "main", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  const { app, ui, repoId } = await open(t, repo);
  await ui.openFlow("git flow: start feature", "gitflow.start.feature");
  await eventually(ui.focusedLabel, "Name", "focus is in the name field");
  assertIncludes(await ui.note(), "Several features can run side by side", "empty: what a feature is for");
  await app.type(await app.waitFor(() => app.exec(() => document.activeElement)), "export");
  await until(async () => /exists|already|taken/i.test((await ui.note()) ?? ""), "an existing name is refused at the field");
  assertEqual(await ui.startBlocked(), "true", "Start is disabled");
  await app.press("Control+a");
  await app.type(await app.waitFor(() => app.exec(() => document.activeElement)), "wind karte");
  assertEqual(await ui.focusedValue(), "wind-karte", "spaces become “-” while typing");
  await eventually(ui.note, "Created as feature/wind-karte and checked out.", "the note names the full branch");
  const developBefore = repo.sha("develop");
  await app.press("Enter");
  await ui.noDialog();
  await eventually(repo.head, "feature/wind-karte", "git: feature created and checked out");
  assertEqual(repo.sha("feature/wind-karte"), developBefore, "it branches off develop");
  await ui.waitToast("success", /Feature started/);
  await waitHead(app, ui, repoId, "feature/wind-karte");
  await ui.closeToasts();
  t.step("feature started");

  const tip = repo.commitFile("karte.md", "# Windkarte\n\nRichtung und Stärke je Station.\n", "Windkarte angelegt");
  await waitClean(app, ui, repoId);
  await ui.finishChecked("Finish Feature “wind-karte”?");
  assertEqual(await app.$("[data-gitflow-blocked]"), null, "clean: nothing blocks");
  assertIncludes(await ui.dialogText(), "feature/wind-karte is merged into develop with a merge commit", "the dialog says what happens");
  await eventually(ui.focusedLabel, "Cancel", "focus starts on “Cancel”");
  assert(await ui.checked("Delete branch afterwards"), "default: delete branch afterwards");
  assert(!(await ui.checked("Push afterwards")), "default: no push");
  await t.shot("finish-feature");
  await ui.tabTo("Finish Feature");
  await app.press("Enter");
  const toast = await ui.waitToast("success", /Feature “wind-karte” finished/);
  assertIncludes(toast, "develop", "the toast summarises the merge");
  await eventually(repo.head, "develop", "git: develop checked out afterwards");
  assertEqual(repo.git("log", "-1", "--format=%s", "develop"), "Merge branch 'feature/wind-karte' into develop", "git: merge commit on develop");
  assertEqual(repo.git("log", "-1", "--format=%P", "develop").split(" "), [developBefore, tip], "with develop and the feature as parents");
  assert(!repo.branches().includes("feature/wind-karte"), "git: feature branch deleted");
  assertEqual(repo.sha("main"), repo.info.head, "main untouched");
  await ui.noDialog();
  await t.noConsoleErrors(app);
}));

scenario("git flow: finish is blocked by uncommitted changes; Undo reverts a finish, Redo restores it", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  repo.git("checkout", "-q", "-b", "feature/karte", "develop");
  const tip = repo.commitFile("karte.md", "# Karte\n", "Karte angelegt");
  const developBefore = repo.sha("develop");
  const { app, ui, repoId } = await open(t, repo);

  repo.write("notiz.md", "noch nicht committet\n");
  await ui.refresh();
  await until(async () => (await appStatus(app, repoId))?.unstaged.length === 1, "the app sees the change");
  await ui.finishChecked("Finish Feature “karte”?");
  assertIncludes(await ui.text("[data-gitflow-blocked]"), "1 uncommitted change", "the reason is in the dialog");
  assertEqual(await ui.attr('[data-action="gitflow-finish"]', "aria-disabled"), "true", "“Finish Feature” is disabled");
  await app.click('[data-action="gitflow-finish"]');
  await ui.sleep(500);
  assert(repo.branches().includes("feature/karte") && repo.sha("develop") === developBefore, "git: a click on the blocked button changes nothing");
  await t.shot("finish-blocked");
  await app.press("Escape");
  await ui.noDialog();

  fs.rmSync(path.join(repo.path, "notiz.md"));
  await waitClean(app, ui, repoId);
  await ui.finishChecked("Finish Feature “karte”?");
  await app.click('[data-action="gitflow-finish"]');
  await ui.waitToast("success", /Feature “karte” finished/);
  await eventually(() => repo.branches().includes("feature/karte"), false, "git: finished, branch deleted");
  const merged = repo.sha("develop");
  assertEqual(repo.git("log", "-1", "--format=%P", "develop").split(" "), [developBefore, tip], "git: merge commit");
  await ui.closeToasts();

  await app.click("[data-shell]").catch(() => undefined);
  await app.press("Control+z");
  await eventually(() => repo.branches().includes("feature/karte") && repo.sha("develop") === developBefore, true, "Ctrl+Z: feature branch back, develop as before", 20_000);
  assertEqual(repo.sha("feature/karte"), tip, "the feature branch points at its commit again");
  await eventually(async () => (await app.invoke("undo_peek", { repoId })).redo?.action ?? null, "merge", "the core offers Redo");
  await app.settle();
  await ui.closeToasts();
  await app.click("[data-shell]").catch(() => undefined);
  await app.press("Control+Shift+z");
  await eventually(() => repo.sha("develop") === merged && !repo.branches().includes("feature/karte"), true, "Redo: the finish is back", 20_000);
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Git Flow: release, hotfix
// =============================================================================================

scenario("git flow: release – only one at a time, finished with an annotated tag and a custom message", "main", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  const { app, ui, repoId } = await open(t, repo);
  await ui.openFlow();
  await ui.start("Release", "1.2.0");
  await eventually(repo.head, "release/1.2.0", "git: release/1.2.0 checked out");
  assertEqual(repo.sha("release/1.2.0"), repo.sha("develop"), "it branches off develop");
  await waitHead(app, ui, repoId, "release/1.2.0");
  await ui.closeToasts();

  // A second release is blocked – naming the running one.
  await ui.openFlow("git flow: start release", "gitflow.start.release");
  assertEqual(await ui.selectedKind(), "Release", "the command opens with “Release”");
  assertIncludes(await ui.note(), "The Release “1.2.0” (release/1.2.0) is already in progress. Finish it first.", "a second release is blocked with a reason");
  assertEqual(await ui.startBlocked(), "true", "Start is disabled");
  assertEqual(await ui.active(), ["feature/export", "release/1.2.0"], "the list shows feature and release");
  await until(async () => (await ui.text(`${ui.DIALOG} [data-gitflow-branch="release/1.2.0"]`))?.includes("checked out"), "the checked-out branch is marked");
  await t.shot("release-running");
  await app.press("Escape");
  await ui.noDialog();

  const releaseTip = repo.commitFile("VERSION", "1.2.0\n", "Version 1.2.0");
  const mainBefore = repo.sha("main");
  await waitClean(app, ui, repoId);
  await ui.openFlow();
  await app.click(`${ui.DIALOG} [data-gitflow-branch="release/1.2.0"] button[aria-label="Finish Release “1.2.0” …"]`);
  await ui.waitDialog("Finish Release “1.2.0”?");
  assertIncludes(await ui.dialogText(), "release/1.2.0 is merged into main, marked there as a version, and merged back into develop", "the dialog says what happens");
  assertEqual(await ui.fieldValue("Tag name"), "v1.2.0", "default tag: prefix + name");
  assertEqual(await ui.fieldValue("Tag message"), "Release 1.2.0", "default message");
  const tagField = await ui.field("Tag name");
  await ui.fill(tagField, "v1..2");
  await until(async () => /dots|\.\./i.test((await ui.text(`${ui.FINISH} [role="alert"]`)) ?? ""), "invalid tag name: reason at the field");
  assertEqual(await ui.attr('[data-action="gitflow-finish"]', "aria-disabled"), "true", "Finish is disabled");
  await ui.fill(tagField, "v1.2.0");
  await ui.fill(await ui.field("Tag message"), "Release 1.2.0 – Frühjahrsmessung");
  await eventually(() => ui.attr('[data-action="gitflow-finish"]', "aria-disabled"), null, "Finish is enabled again");
  await t.shot("finish-release");
  await app.click('[data-action="gitflow-finish"]');
  await ui.waitToast("success", /Release “1\.2\.0” finished/);
  await eventually(repo.head, "develop", "git: develop checked out afterwards");
  assertEqual(repo.git("log", "-1", "--format=%s", "main"), "Merge branch 'release/1.2.0'", "git: merge commit on main");
  assertEqual(repo.git("log", "-1", "--format=%P", "main").split(" "), [mainBefore, releaseTip], "with main and the release as parents");
  assertEqual(repo.git("cat-file", "-t", "v1.2.0"), "tag", "git: v1.2.0 is annotated");
  assertEqual(repo.git("tag", "-l", "--format=%(contents:subject)", "v1.2.0"), "Release 1.2.0 – Frühjahrsmessung", "with the entered message");
  assertEqual(repo.sha("v1.2.0^{commit}"), repo.sha("main"), "the tag points at the merge in main");
  assert(repo.isAncestor(releaseTip, "develop"), "the release is merged back into develop");
  assert(!repo.branches().includes("release/1.2.0"), "git: release branch deleted");
  await t.noConsoleErrors(app);
}));

scenario("git flow: hotfix conflicts when merging back – resolve, finish again skips what is done", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  const readme = repo.read("README.md");
  const first = readme.split("\n")[0];
  repo.git("checkout", "-q", "develop");
  repo.commitFile("README.md", readme.replace(first, `${first} (Entwicklung)`), "README: Titel in der Entwicklung");
  const { app, ui, repoId } = await open(t, repo);

  await ui.openFlow();
  await ui.start("Hotfix", "1.2.1");
  await eventually(repo.head, "hotfix/1.2.1", "git: hotfix checked out");
  assertEqual(repo.sha("hotfix/1.2.1"), repo.sha("main"), "a hotfix branches off main");
  const hotfixTip = repo.commitFile("README.md", readme.replace(first, `${first} (Korrektur)`), "README: Titel korrigiert");
  await waitClean(app, ui, repoId);
  await ui.closeToasts();

  await ui.finishChecked("Finish Hotfix “1.2.1”?");
  await app.click('[data-action="gitflow-finish"]');
  const warning = await ui.waitToast("warning", /Finish Hotfix: conflict in one file/);
  assertIncludes(warning, "again", "the toast says how to go on");
  await eventually(async () => (await appStatus(app, repoId))?.conflicted.map((item) => item.path) ?? null, ["README.md"], "the app shows the conflicted file", 20_000);
  assert(repo.isAncestor(hotfixTip, "main"), "git: hotfix already merged into main");
  assertEqual(repo.git("tag", "-l", "v1.2.1"), "v1.2.1", "git: tag v1.2.1 created");
  assert(repo.branches().includes("hotfix/1.2.1"), "the hotfix branch is kept");
  assertEqual(repo.head(), "develop", "git: the merge stopped on develop");
  await t.shot("hotfix-conflict");
  await ui.closeToasts();

  // Resolve with the hotfix's version and complete the merge in Git.
  repo.git("checkout", "--theirs", "--", "README.md");
  repo.git("add", "README.md");
  repo.git("commit", "-q", "--no-edit");
  await waitClean(app, ui, repoId);
  await ui.openFlow();
  assert((await ui.active()).includes("hotfix/1.2.1"), "the hotfix is still listed as running");
  await app.click(`${ui.DIALOG} [data-gitflow-branch="hotfix/1.2.1"] button[aria-label="Finish Hotfix “1.2.1” …"]`);
  await ui.waitDialog("Finish Hotfix “1.2.1”?");
  await app.click('[data-action="gitflow-finish"]');
  await until(async () => (await ui.toasts()).some((toast) => /Hotfix “1\.2\.1” finished|Nothing left to do/.test(toast.text)), "the second run finishes", 30_000);
  await eventually(() => repo.branches().includes("hotfix/1.2.1"), false, "git: hotfix branch deleted now");
  assert(repo.isAncestor(hotfixTip, "develop"), "git: hotfix in develop");
  assertEqual(repo.git("tag", "-l", "v1.2.*"), "v1.2.1", "git: no second tag");
  assertEqual(repo.head(), "develop", "HEAD is develop");
  await t.noConsoleErrors(app);
}));

scenario("git flow: “Push afterwards” brings develop to the remote; without a remote it is disabled", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  const { app, ui, repoId } = await open(t, repo);
  await ui.openFlow();
  await ui.start("Feature", "push-probe");
  await eventually(repo.head, "feature/push-probe", "feature started");
  repo.commitFile("probe.md", "# Probe\n", "Probe für den Push");
  await waitClean(app, ui, repoId);
  await ui.closeToasts();
  assertEqual(repo.remoteSha("refs/heads/develop"), null, "the remote has no develop yet");

  await ui.finishChecked("Finish Feature “push-probe”?");
  assertIncludes(await ui.dialogText(), "Pushes develop.", "the hint says what is pushed");
  await app.click(await ui.checkbox("Push afterwards"));
  assert(await ui.checked("Push afterwards"), "push checked");
  await app.click('[data-action="gitflow-finish"]');
  await ui.waitToast("success", /Feature “push-probe” finished/);
  await eventually(() => repo.remoteSha("refs/heads/develop"), repo.sha("develop"), "git in the remote: develop is at the local state", 30_000);
  assertEqual(repo.git("log", "-1", "--format=%s", "origin/develop"), "Merge branch 'feature/push-probe' into develop", "with the merge commit");
  await ui.closeToasts();

  // Without a remote the option is disabled and says why.
  repo.git("remote", "remove", "origin");
  repo.git("checkout", "-q", "-b", "feature/ohne-remote", "develop");
  repo.commitFile("lokal.md", "lokal\n", "Nur lokal");
  await waitHead(app, ui, repoId, "feature/ohne-remote");
  await until(async () => (await app.exec((id) => window.__gc.queryClient.getQueryData(["repo", id, "remotes"]), repoId))?.length === 0, "the app sees no remote", 20_000).catch(async () => {
    await app.exec((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "remotes"] }), repoId);
  });
  await ui.finishChecked("Finish Feature “ohne-remote”?");
  await until(async () => (await ui.dialogText()).includes("No remote set up."), "hint: no remote");
  const push = await ui.checkbox("Push afterwards");
  assert((await push.prop("disabled")) === true || (await push.attr("data-disabled")) !== null, "the push option is disabled");
  assertEqual(await push.attr("aria-checked"), "false", "and unchecked");
  await app.press("Escape");
  await ui.noDialog();
  await t.noConsoleErrors(app);
}));

scenario("git flow: change setup (drop the tag prefix), finish a release without tag from the branch menu", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  repo.git("checkout", "-q", "-b", "release/2.0.0", "develop");
  const tip = repo.commitFile("VERSION", "2.0.0\n", "Version 2.0.0");
  const tagsBefore = repo.git("tag", "-l");
  const { app, ui, repoId } = await open(t, repo);

  await ui.openFlow();
  await app.click(await ui.dialogButton("Change setup"));
  await eventually(ui.flowState, "editing", "the setup form opens with the values");
  const prefix = await ui.field("Version tag");
  assertEqual(await prefix.prop("value"), "v", "the saved prefix is in the field");
  await ui.fill(prefix, "");
  await app.click('[data-action="gitflow-init"]');
  await eventually(ui.flowState, "ready", "back to the overview after saving");
  await eventually(() => repo.config("gitflow.prefix.versiontag") ?? "", "", "git config: no tag prefix anymore");
  assertEqual(repo.config("gitflow.branch.develop"), "develop", "the rest of the setup stays");
  await app.press("Escape");
  await ui.noDialog();
  await ui.closeToasts();

  // The branch's context menu in the sidebar offers the finish.
  await ui.contextMenu('[data-row-id="refs/heads/release/2.0.0"]');
  await ui.chooseMenu(/^Git Flow: finish Release/);
  await ui.waitDialog("Finish Release “2.0.0”?");
  assertEqual(await ui.fieldValue("Tag name"), "2.0.0", "default tag without prefix");
  await app.click(await ui.checkbox("Mark version with a tag"));
  await eventually(async () => (await app.exec(() => [...document.querySelectorAll("label")].some((node) => node.textContent.trim() === "Tag name"))), false, "the tag fields disappear");
  await waitClean(app, ui, repoId);
  await app.click('[data-action="gitflow-finish"]');
  await ui.waitToast("success", /Release “2\.0\.0” finished/);
  assertEqual(repo.git("tag", "-l"), tagsBefore, "git: no tag created");
  assert(repo.isAncestor(tip, "main") && repo.isAncestor(tip, "develop"), "git: release merged into main and develop");
  assert(!repo.branches().includes("release/2.0.0"), "git: release branch deleted");
  await t.noConsoleErrors(app);
}));

scenario("git flow: 30 running features and a very long name stay inside the dialog", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  const longName = `feature/${"sehr-langer-name-fuer-ein-feature-".repeat(4)}ende`;
  for (let index = 0; index < 30; index++) repo.git("branch", `feature/station-${String(index).padStart(2, "0")}`, "develop");
  repo.git("branch", longName, "develop");
  const { app, ui } = await open(t, repo);
  await ui.openFlow();
  await eventually(async () => (await ui.active()).length, 32, "32 running features in the list (30, the long one, feature/export)");
  assertEqual(await app.exec(() => document.getElementById("gitflow-active-title")?.textContent.trim()), "In progress (32)", "the heading counts them");
  const box = await app.exec((root) => {
    const list = document.querySelector(`${root} ul[aria-label="Active Git Flow branches"]`);
    const frame = document.querySelector('[role="dialog"]').getBoundingClientRect();
    const result = {};
    result.scrolls = list.scrollHeight > list.clientHeight;
    result.wide = list.scrollWidth - list.clientWidth;
    result.page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    result.inside = frame.left >= 0 && frame.top >= 0 && frame.right <= window.innerWidth && frame.bottom <= window.innerHeight;
    return result;
  }, ui.DIALOG);
  assertEqual([box.scrolls, box.wide, box.page, box.inside], [true, 0, 0, true], `the list scrolls vertically only and the dialog fits the window (${JSON.stringify(box)})`);
  await t.shot("many-branches");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Hooks
// =============================================================================================

scenario("hooks: a failing pre-commit hook rejects the commit – one message with output, fields stay; Skip Git hooks commits", "main", withRepo(makeFlowRepo, async (t, repo) => {
  repo.hook("pre-commit", 'echo run >> "$(git rev-parse --git-dir)/hook-runs"\necho "Lint: Zeile 3 ist zu lang (Hook der Fixture)" >&2\nexit 1');
  repo.write("README.md", `${repo.read("README.md")}\nNeu.\n`);
  repo.git("add", "README.md");
  const before = repo.sha("HEAD");
  const runs = () => (fs.existsSync(path.join(repo.path, ".git", "hook-runs")) ? fs.readFileSync(path.join(repo.path, ".git", "hook-runs"), "utf8").split("\n").filter(Boolean).length : 0);
  assertEqual(runs(), 0, "the hook has not run");
  const { app, ui, commit, repoId } = await open(t, repo);
  await commit.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "README.md staged");

  await commit.fill(await commit.summary(), "Wird vom Hook abgelehnt");
  await commit.fill(await commit.description(), "Bleibt stehen.");
  await app.press("Control+Enter");
  const toast = await ui.waitToast("danger", /hook/i);
  assertIncludes(toast, "pre-commit", "the message names the hook");
  assertIncludes(toast, "Lint: Zeile 3 ist zu lang", "with the first line of the output");
  assertIncludes(toast, "Show output", "and offers “Show output”");
  await ui.sleep(800);
  assertEqual((await ui.toasts()).filter((item) => item.tone === "danger").length, 1, "exactly one error message for the incident");
  assertEqual(runs(), 1, "the hook ran once");
  assertEqual(repo.sha("HEAD"), before, "git: no commit");
  assertEqual(await commit.fields(), { summary: "Wird vom Hook abgelehnt", description: "Bleibt stehen." }, "message stays in the form");
  assertEqual(repo.git("diff", "--cached", "--name-only"), "README.md", "git: file stays staged");
  await t.shot("hook-rejected");

  await ui.toastButton(/hook/i, "Show output");
  const output = await app.waitFor('[role="dialog"] pre', 8000);
  assertIncludes(await app.exec((el) => el.textContent, output), "Lint: Zeile 3 ist zu lang (Hook der Fixture)", "the dialog shows the hook output");
  assertMatch(await ui.dialogTitle(), /pre-commit|Hook output/, "titled with the hook");
  await app.press("Escape");
  await ui.noDialog();
  await ui.closeToasts();

  await app.click(await commit.checkbox("Skip Git hooks"));
  assert(await commit.checked("Skip Git hooks"), "Skip Git hooks checked");
  await app.click(await commit.commitButton());
  await ui.waitToast("success", /Commit created/);
  assertEqual(repo.git("log", "-1", "--format=%s"), "Wird vom Hook abgelehnt", "git: with Skip Git hooks the commit is created");
  assertEqual(repo.git("log", "-1", "--format=%b").trim(), "Bleibt stehen.", "git: description");
  assertEqual(runs(), 1, "the hook did not run again");
  await t.noConsoleErrors(app);
}));

scenario("hooks: hooks that print something show a notice with “Show output”", "main", withRepo(makeFlowRepo, async (t, repo) => {
  repo.hook("pre-commit", 'echo "Prüfe 1 Datei"');
  repo.hook("post-commit", 'echo "Fertig: Grüße aus dem post-commit"\necho "zweite Zeile"');
  repo.hook("prepare-commit-msg", "exit 0");
  repo.write("notiz.md", "eins\n");
  repo.git("add", "notiz.md");
  const { app, ui, commit, repoId } = await open(t, repo);
  await commit.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "notiz.md staged");
  await commit.fill(await commit.summary(), "Notiz mit Hooks");
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  assertEqual(repo.git("log", "-1", "--format=%s"), "Notiz mit Hooks", "git: committed");
  const post = await ui.waitToast("info", /Hook “post-commit” printed something/);
  assertIncludes(post, "Fertig: Grüße aus dem post-commit", "first line of the output");
  assert(!post.includes("zweite Zeile"), "only the first line in the notice");
  const pre = await ui.waitToast("info", /Hook “pre-commit” printed something/);
  assertIncludes(pre, "Prüfe 1 Datei", "the pre-commit output too");
  await ui.sleep(600);
  assert(!(await ui.toasts()).some((item) => item.text.includes("prepare-commit-msg")), "a silent hook shows nothing");
  assertEqual((await ui.toasts()).filter((item) => item.tone === "danger").length, 0, "no error message");
  await t.shot("hook-printed");

  await ui.toastButton(/post-commit/, "Show output");
  const output = await app.waitFor('[role="dialog"] pre', 8000);
  assertEqual((await app.exec((el) => el.textContent, output)).trim(), "Fertig: Grüße aus dem post-commit\nzweite Zeile", "the full output, umlauts intact");
  assertEqual(await ui.dialogTitle(), "Output of post-commit", "dialog title names the hook");
  await app.press("Escape");
  await ui.noDialog();
  await t.noConsoleErrors(app);
}));

scenario("hooks: a commit-msg hook from a hooks folder set in Preferences (core.hooksPath)", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  repo.hook("commit-msg", "grep -q '^TICKET-' \"$1\" || { echo 'Ticket fehlt in der Nachricht'; exit 1; }", "meine hooks");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Hooks-Ordner angelegt");
  repo.write("notiz.md", "eins\n");
  repo.git("add", "notiz.md");
  const before = repo.sha("HEAD");
  const { app, ui, commit, repoId, tabId } = await open(t, repo);
  await commit.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "notiz.md staged");

  // Without core.hooksPath the hook is not used.
  const field = await openHooksFolder(app);
  assertEqual(await field.prop("value"), "", "empty = .git/hooks");
  await commit.fill(field, "meine hooks");
  await app.press("Enter");
  await eventually(() => repo.config("core.hooksPath"), "meine hooks", "git config: core.hooksPath written");
  await t.shot("hooks-path");
  await app.press("Escape");
  await ui.noDialog();
  await app.exec((id) => window.__gc.store.getState().selectWip?.(id), tabId);

  await commit.fill(await commit.summary(), "Ohne Ticket");
  await app.press("Control+Enter");
  const toast = await ui.waitToast("danger", /hook/i);
  assertIncludes(toast, "commit-msg", "the message names the hook");
  assertIncludes(toast, "Ticket fehlt in der Nachricht", "with its output");
  assertEqual(repo.sha("HEAD"), before, "git: no commit");
  await ui.closeToasts();

  await commit.fill(await commit.summary(), "TICKET-7 Notiz eins");
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  assertEqual(repo.git("log", "-1", "--format=%s"), "TICKET-7 Notiz eins", "git: committed with the ticket");
  assertEqual(repo.config("core.hooksPath"), "meine hooks", "the app left core.hooksPath alone");

  // Clearing the field removes the key again.
  const again = await openHooksFolder(app);
  await eventually(() => again.prop("value"), "meine hooks", "the field shows the saved folder");
  await commit.fill(again, "");
  await app.press("Enter");
  await eventually(() => repo.config("core.hooksPath"), null, "git config: core.hooksPath removed");
  await app.press("Escape");
  await t.noConsoleErrors(app);
}));

scenario("hooks: a failing pre-push hook rejects the push; the remote keeps its state", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  repo.hook("pre-push", 'echo "Push gesperrt: CI ist rot" >&2\nexit 1');
  repo.commitFile("notiz.md", "eins\n", "Lokale Notiz");
  const remoteBefore = repo.remoteSha("refs/heads/main");
  assert(remoteBefore !== repo.sha("main"), "main is ahead of origin");
  const { app, ui } = await open(t, repo);
  await ui.runCommand("push", "sync.push");
  const toast = await ui.waitToast("danger", /rejected by a Git hook|hook/i, 60_000);
  assertIncludes(toast, "pre-push", "the message names the hook");
  assertIncludes(toast, "Push gesperrt: CI ist rot", "with its output");
  await ui.sleep(800);
  assertEqual((await ui.toasts()).filter((item) => item.tone === "danger").length, 1, "one message for the incident");
  assertEqual(repo.remoteSha("refs/heads/main"), remoteBefore, "git: the remote is unchanged");
  await t.shot("pre-push-rejected");
  await t.noConsoleErrors(app);
}));

scenario("hooks: a pre-merge-commit hook stops a Git Flow finish – merge left pending, Skip Git hooks completes it, finish again", "edge", withRepo(makeFlowRepo, async (t, repo) => {
  initFlowInGit(repo);
  repo.git("checkout", "-q", "-b", "feature/gesperrt", "develop");
  const tip = repo.commitFile("gesperrt.md", "# Gesperrt\n", "Gesperrtes Feature");
  const developBefore = repo.sha("develop");
  repo.hook("pre-merge-commit", 'echo "Merge nur nach Review" >&2\nexit 1');
  const { app, ui, commit, repoId } = await open(t, repo);
  await waitClean(app, ui, repoId);

  await ui.finishChecked("Finish Feature “gesperrt”?");
  await app.click('[data-action="gitflow-finish"]');
  const toast = await ui.waitToast("danger", /hook/i, 30_000);
  assertIncludes(toast, "pre-merge-commit", "the message names the hook");
  assertIncludes(toast, "Merge nur nach Review", "with its output");
  await ui.sleep(800);
  assertEqual((await ui.toasts()).filter((item) => item.tone === "danger").length, 1, "one message for the incident");
  assertEqual(repo.sha("develop"), developBefore, "git: no merge commit on develop");
  assert(repo.branches().includes("feature/gesperrt"), "git: the feature branch is kept");
  // Git leaves the merge pending without a conflict (as with an ordinary merge).
  assertEqual(repo.sha("MERGE_HEAD"), tip, "git: the merge of the feature is pending");
  assertEqual(await ui.dialogTitle(), "Finish Feature “gesperrt”?", "the finish dialog stays open");
  await until(async () => (await ui.text("[data-gitflow-blocked]"))?.includes("in progress first"), "the dialog now names the merge in progress");
  await t.shot("finish-hook-rejected");
  // An error toast on top takes the first Esc (escapeGuard.ts); the second one closes the dialog.
  await app.press("Escape");
  await eventually(async () => (await ui.toasts()).length, 0, "the first Esc closes the error message");
  assertEqual(await ui.dialogTitle(), "Finish Feature “gesperrt”?", "the dialog is still open");
  await app.press("Escape");
  await ui.noDialog();

  // Complete the pending merge in the commit panel without hooks.
  await until(async () => (await appStatus(app, repoId))?.operation?.kind === "merge", "the app shows the merge in progress", 20_000);
  await app.click(await commit.checkbox("Skip Git hooks"));
  await app.click(await commit.commitButton());
  await eventually(() => repo.tryGit("rev-parse", "-q", "--verify", "MERGE_HEAD"), null, "git: merge completed", 20_000);
  assertEqual(repo.git("log", "-1", "--format=%P", "develop").split(" "), [developBefore, tip], "git: merge commit on develop despite the hook");
  await waitClean(app, ui, repoId);
  await ui.closeToasts();

  // Running the finish again only deletes the branch.
  await ui.openFlow();
  await app.click(`${ui.DIALOG} [data-gitflow-branch="feature/gesperrt"] button[aria-label="Finish Feature “gesperrt” …"]`);
  await ui.waitDialog("Finish Feature “gesperrt”?");
  await app.click('[data-action="gitflow-finish"]');
  await until(async () => (await ui.toasts()).some((item) => /Feature “gesperrt” finished|Nothing left to do/.test(item.text)), "the second run finishes", 30_000);
  await eventually(() => repo.branches().includes("feature/gesperrt"), false, "git: feature branch deleted");
  assertEqual(repo.git("log", "-1", "--format=%P", "develop").split(" "), [developBefore, tip], "git: no second merge commit");
  await t.noConsoleErrors(app);
}));
