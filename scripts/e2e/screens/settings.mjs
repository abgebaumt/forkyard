/**
 * settings Settings (with profiles profile and ssh-keys SSH) in the real app against the real core.
 *
 *   node scripts/e2e/screens/settings.mjs            everything
 *   node scripts/e2e/screens/settings.mjs --show     visible window
 *
 * Flow: change every setting once (Git behavior and Appearance keyboard only) and check it via
 * settings_get or its visible effect, restart the app, edit/create/switch/delete profiles
 * (checking the global test gitconfig), generate/add/copy/remove SSH keys in a redirected folder,
 * project settings (checking git config in the fixture), states and screenshots.
 *
 * Never the real ~/.ssh: the app runs with FORKYARD_SSH_DIR pointing to a temp folder.
 * Not testable for real and therefore shown with injected data: a filled credentials list
 * (would need a server with sign-in), a missing keychain, loading and error states of the queries.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { createChecks, finish, gitIn, gitWithGlobal, pageHelpers } from "./prefs-lib.mjs";

const show = process.argv.includes("--show");
const { failures, check, equal, eventually, until, section, setCurrent } = createChecks();

const repo = makeCleanRepoWithRemote();
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-s19-")));
const dataDir = path.join(work, "data");
const sshDir = path.join(work, "ssh");
const externDir = path.join(work, "extern");
fs.mkdirSync(sshDir);
fs.mkdirSync(externDir);

const SHOTS = "target/e2e/shots";
const LONG_NAME = "Arbeit-Kundenprojekt-Messnetz-Nord-und-Hafen-2026-Zweitkonto-X1"; // 60 characters
const LONG_AUTHOR = "Maximiliane-Friederike von Hohenstaufen-Wetterstation zu Nord"; // 60 characters

let app = null;
let h = null;

async function start(options = {}) {
  app = await launchApp({ show, dataDir, env: { FORKYARD_SSH_DIR: sshDir }, ...options });
  h = pageHelpers(app);
  return app.page;
}

const settings = () => app.invoke("settings_get");
const dialog = () => app.page.locator('[data-screen="settings"]');
const row = (title) => dialog().locator(`[data-setting="${title}"]`);
const openPrefs = async () => {
  await app.page.keyboard.press("Control+,");
  await dialog().waitFor();
};
const goto = async (name) => {
  await app.page.getByRole("tab", { name, exact: true }).click();
  await app.settle();
};
const toggle = async (title) => {
  await row(title).getByRole("switch").click();
};
/** Project rows inherit from the profile until "Override" gives them their own value. */
const override = async (title) => {
  await dialog().getByRole("button", { name: `${title}: override` }).click();
};

try {
  let page = await start();
  const { repoId } = await app.openRepo(repo.path);
  const initial = await settings();
  const changedOnce = new Set();
  /** Waits until the core has the value and remembers that the field was changed. */
  const expectSetting = async (key, value, message) => {
    if (await eventually(async () => (await settings())[key], value, message ?? `settings.${key}`)) changedOnce.add(key);
  };

  // -------------------------------------------------------------------------
  await section("Open with Ctrl+comma, focus in the section list", async () => {
    await openPrefs();
    await eventually(h.focusedName, "Git behavior", "focus is on the active section");
    equal(await page.getByRole("tab", { selected: true }).innerText(), "Git behavior", "selected section");
    const tabs = await page.getByRole("tab").allInnerTexts();
    equal(tabs, ["Appearance", "Diff and editor", "External programs", "Notifications", "Profile and identity", "Git behavior", "SSH keys", "Credentials", "Hosts", "Network", "Identity and access", "Pull and fetch", "Files and hooks", "About"], "sections");
    check((await dialog().getByRole("button", { name: /Save/ }).count()) === 0, "there is no Save button");
    const width = await dialog().locator('[role="tabpanel"] > div').first().evaluate((element) => element.getBoundingClientRect().width);
    check(width <= 640, `content is at most 640 px wide (is ${width})`);
  });

  // -------------------------------------------------------------------------
  await section("Git behavior – keyboard only", async () => {
    await h.tabTo("Default branch name");
    await h.retype("trunk");
    await page.keyboard.press("Enter");
    await expectSetting("defaultBranchName", "trunk");
    await until(() => row("Default branch name").getByRole("status").count(), "“Saved” check mark appears in the field");

    // Invalid: the UI catches it, the core stays unchanged.
    await h.retype("a..b");
    await page.keyboard.press("Enter");
    await until(async () => /Not allowed/i.test((await row("Default branch name").getByRole("alert").allInnerTexts()).join(" ")), "error at the field for “a..b”");
    equal((await settings()).defaultBranchName, "trunk", "invalid name is not saved");
    // Invalid according to the core (the rough pre-check lets “HEAD” through): core message at the field, no toast.
    await h.retype("HEAD");
    await page.keyboard.press("Enter");
    await until(async () => /reserved/.test((await row("Default branch name").getByRole("alert").allInnerTexts()).join(" ")), "core error is shown at the field");
    equal(await h.toasts(), [], "no toast for an error at the field");
    equal((await settings()).defaultBranchName, "trunk", "“HEAD” is not saved");
    equal(await row("Default branch name").locator("input").inputValue(), "HEAD", "the typed text stays for correcting");
    await h.retype("trunk");
    await page.keyboard.press("Enter");

    await h.tabTo("Auto-fetch");
    await h.retype("15");
    await page.keyboard.press("Enter");
    await expectSetting("autoFetchMinutes", 15);
    await page.keyboard.press("ArrowUp");
    await eventually(async () => (await settings()).autoFetchMinutes, 16, "arrow up increases by 1");
    await h.retype("99");
    await page.keyboard.press("Enter");
    await eventually(async () => (await settings()).autoFetchMinutes, 60, "99 is capped at 60");
    await until(async () => /0 to 60/.test((await row("Auto-fetch").getByRole("status").allInnerTexts()).join(" ")), "hint about the limits appears");
    await h.retype("abc");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    equal(await row("Auto-fetch").locator("input").inputValue(), "60", "nonsense jumps back to the last value");
    await page.keyboard.press("Home");
    await eventually(async () => (await settings()).autoFetchMinutes, 0, "Home sets the minimum (0 = off)");
    await h.retype("7");
    await page.keyboard.press("Enter");
    await eventually(async () => (await settings()).autoFetchMinutes, 7, "auto-fetch 7");

    await h.tabTo("Prune stale remote branches");
    await page.keyboard.press("Space");
    await expectSetting("autoPrune", !initial.autoPrune);

    await h.tabTo("Commits on first load");
    await h.retype("100");
    await page.keyboard.press("Enter");
    await eventually(async () => (await settings()).initialCommits, 500, "less than 500 is not possible");
    await h.retype("3000");
    await page.keyboard.press("Enter");
    await expectSetting("initialCommits", 3000);

    await h.tabTo("Load more while scrolling");
    await page.keyboard.press("Space");
    await expectSetting("lazyLoad", !initial.lazyLoad);

    await h.tabTo("Default pull mode");
    await page.keyboard.press("Enter");
    // Radix moves the focus a moment after the key press: wait each time until it has arrived.
    await eventually(h.focusedName, "Fast-forward if possible", "the list opens on the selected entry");
    await page.keyboard.press("ArrowDown");
    await eventually(h.focusedName, "Fast-forward only", "arrow down moves to the next entry");
    await page.keyboard.press("ArrowDown");
    await eventually(h.focusedName, "Rebase", "and on");
    await page.keyboard.press("Enter");
    await expectSetting("defaultPullMode", "rebase");
    await eventually(h.focusedName, "Default pull mode", "focus returns to the select");

    await h.tabTo("Remember tabs");
    await page.keyboard.press("Space");
    await expectSetting("rememberTabs", !initial.rememberTabs);
    // There is no “Check for updates” switch: the app never checks for updates, and a switch
    // without a function would promise something false.
    equal(await page.getByRole("switch", { name: "Check for updates" }).count(), 0, "no switch without a function");
    equal(await h.toasts(), [], "no messages");
  });

  // -------------------------------------------------------------------------
  await section("Appearance – keyboard only, immediate effect", async () => {
    await h.tabTo("Git behavior", { back: true });
    await page.keyboard.press("ArrowDown");
    await eventually(async () => page.getByRole("tab", { selected: true }).innerText(), "Appearance", "arrow down changes the section");

    await h.tabTo("Dark");
    const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.keyboard.press("ArrowRight");
    await eventually(h.focusedName, "Light", "arrow right moves to “Light”");
    await page.keyboard.press("Space");
    await expectSetting("theme", "light");
    await eventually(() => page.evaluate(() => document.documentElement.dataset.theme), "light", "the UI is light immediately");
    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(lightBackground !== darkBackground, `the background has changed (${darkBackground} → ${lightBackground})`);
    await page.keyboard.press("ArrowRight");
    await eventually(h.focusedName, "System", "on to “System”");
    await page.keyboard.press("Space");
    await eventually(async () => (await settings()).theme, "system", "theme “System”");
    await page.keyboard.press("ArrowLeft");
    await eventually(h.focusedName, "Light", "back to “Light”");
    await page.keyboard.press("Space");
    await eventually(async () => (await settings()).theme, "light", "back to “Light”");

    await h.tabTo("Zoom");
    await page.keyboard.press("ArrowUp");
    await expectSetting("zoom", 1.1);
    await eventually(() => page.evaluate(() => document.documentElement.style.zoom), "1.1", "the UI is larger immediately");
    await h.tabTo("Reset", { back: true });
    await page.keyboard.press("Enter");
    await eventually(async () => (await settings()).zoom, 1, "“Reset” restores 100 %");
    // The “Changed · Reset” link disappears at 100 %; the focus must stay inside the settings.
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true, "the focus stays in the settings");
    await h.tabTo("Zoom");
    await page.keyboard.press("ArrowUp");
    await eventually(async () => (await settings()).zoom, 1.1, "zoom 110 % again");

    await h.tabTo("Relative");
    await page.keyboard.press("ArrowRight");
    await eventually(h.focusedName, "Local", "arrow right moves to “Local”");
    await page.keyboard.press("ArrowRight");
    await eventually(h.focusedName, "ISO", "and to “ISO”");
    await page.keyboard.press("Space");
    await expectSetting("dateFormat", "iso");
    await until(async () => /Example: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(await row("Date format").innerText()), "the example shows the ISO format");

    await h.tabTo("Initials instead of avatars");
    await page.keyboard.press("Space");
    await expectSetting("showInitials", !initial.showInitials);

    const hiddenLabels = () => page.locator('[role="toolbar"][aria-label="Repository actions"] button > span.sr-only:not([id])').count();
    equal(await hiddenLabels(), 0, "before: the toolbar shows its labels");
    await h.tabTo("Toolbar labels");
    await page.keyboard.press("Space");
    await expectSetting("toolbarLabels", !initial.toolbarLabels);
    await until(async () => (await hiddenLabels()) > 5, "the toolbar shows only icons immediately");
  });

  // -------------------------------------------------------------------------
  await section("Commit and merge, diff and editor, notifications", async () => {
    await goto("Git behavior");
    for (const [title, key] of [
      ["Push after commit", "pushAfterCommit"],
      ["Squash on merge", "squashOnMerge"],
      ["Delete .orig files after resolving a conflict", "deleteOrigFiles"],
    ]) {
      await toggle(title);
      await expectSetting(key, !initial[key]);
      equal(await row(title).getByRole("switch").getAttribute("aria-checked"), String(!initial[key]), `switch “${title}” shows the new state`);
    }

    await goto("Diff and editor");
    await row("Diff view").getByRole("radio", { name: "Side by side" }).click();
    await expectSetting("diffMode", "split");
    await toggle("Word wrap");
    await expectSetting("diffWordWrap", !initial.diffWordWrap);
    await toggle("Ignore whitespace");
    await expectSetting("diffIgnoreWhitespace", !initial.diffIgnoreWhitespace);
    const size = initial.editorFontSize === 15 ? 16 : 15;
    await row("Font size").locator("input").fill(String(size));
    await row("Font size").locator("input").press("Enter");
    await expectSetting("editorFontSize", size);
    await row("Font size").getByRole("button", { name: "Increase" }).click();
    await eventually(async () => (await settings()).editorFontSize, size + 1, "plus button increases");
    await row("Font size").getByRole("button", { name: "Decrease" }).click();
    await eventually(async () => (await settings()).editorFontSize, size, "minus button decreases");
    const tab = initial.editorTabSize === 2 ? 8 : 2;
    await row("Tab width").locator("input").fill(String(tab));
    await row("Tab width").locator("input").blur();
    await expectSetting("editorTabSize", tab, "tab width applies when leaving the field");

    await goto("Notifications");
    await toggle("On fetch results");
    await expectSetting("notifyOnFetch", !initial.notifyOnFetch);
    await toggle("On background errors");
    await expectSetting("notifyOnError", !initial.notifyOnError);
  });

  // -------------------------------------------------------------------------
  await section("External programs: command line, browse, empty = default", async () => {
    await goto("External programs");
    const field = (title) => row(title).locator("input");
    await field("Editor").fill("code --goto {path}");
    await field("Editor").press("Enter");
    await expectSetting("externalEditor", "code --goto {path}");
    await field("Terminal").fill("wt -d {path}");
    await field("Terminal").blur();
    await expectSetting("externalTerminal", "wt -d {path}");

    const tool = path.join(work, "Mein Werkzeug", "vergleich.exe");
    await app.pick(tool);
    await row("Diff tool").getByRole("button", { name: /browse/i }).click();
    await expectSetting("externalDiffTool", `"${tool}" {local} {remote}`, "browse quotes the path and appends {local} {remote} for the diff tool");
    await eventually(() => field("Diff tool").inputValue(), `"${tool}" {local} {remote}`, "the field shows the chosen command");
    await app.pick(null);
    await row("Merge tool").getByRole("button", { name: /browse/i }).click();
    await page.waitForTimeout(200);
    equal((await settings()).externalMergeTool, initial.externalMergeTool, "a cancelled file dialog changes nothing");
    await field("Merge tool").fill('"C:\\Tools\\merge.exe {path}');
    await field("Merge tool").press("Enter");
    await until(async () => /quotation mark/.test((await row("Merge tool").getByRole("alert").allInnerTexts()).join(" ")), "an open quotation mark is reported at the field");
    equal((await settings()).externalMergeTool, initial.externalMergeTool, "and not saved");
    await field("Merge tool").fill("kdiff3 {path}");
    await field("Merge tool").press("Enter");
    await expectSetting("externalMergeTool", "kdiff3 {path}");

    // Empty = system default (null in the core)
    await field("Terminal").fill("");
    await field("Terminal").press("Enter");
    await eventually(async () => (await settings()).externalTerminal, null, "empty field saves null");
    await field("Terminal").fill("wt -d {path}");
    await field("Terminal").press("Enter");
    await eventually(async () => (await settings()).externalTerminal, "wt -d {path}", "terminal set again");

    // A very long command breaks nothing
    const long = `"${path.join(work, "x".repeat(120), "editor.exe")}" --neues-fenster --warten {path}`;
    await field("Editor").fill(long);
    await field("Editor").press("Enter");
    await eventually(async () => (await settings()).externalEditor, long, "long command saved");
    equal(await h.escaping('[data-screen="settings"]'), [], "nothing sticks out of the dialog");
    await field("Editor").fill("code --goto {path}");
    await field("Editor").press("Enter");
    await eventually(async () => (await settings()).externalEditor, "code --goto {path}", "editor reset");
  });

  // -------------------------------------------------------------------------
  await section("SSH agent switch and completeness: every Settings field changed once", async () => {
    await goto("SSH keys");
    await toggle("Use the system SSH agent");
    await expectSetting("sshUseAgent", !initial.sshUseAgent);
    const now = await settings();
    // The network settings (section “Network”) are tested by scripts/e2e/screens/proxy.mjs against a real server and proxy.
    const elsewhere = new Set(["proxyUrl", "proxyByHost", "sslCaFile", "sslNoVerifyHosts"]);
    const untouched = Object.keys(initial).filter((key) => !elsewhere.has(key) && (!changedOnce.has(key) || JSON.stringify(now[key]) === JSON.stringify(initial[key])));
    equal(untouched, [], "Settings fields the test did not change through the UI");
  });

  // -------------------------------------------------------------------------
  await section("Project sections: apply immediately, stored in .git/config", async () => {
    const repoSettings = () => app.invoke("repo_settings_get", { repoId });
    const before = await repoSettings();
    const profile = (await app.invoke("profile_list")).find((candidate) => candidate.isActive);

    // Files and hooks: plain project values, no inheritance.
    await goto("Files and hooks");
    equal(before.encoding, "utf-8", "encoding at the start");
    await row("Encoding").getByRole("combobox").click();
    await page.getByRole("option", { name: /Windows-1252/ }).click();
    await eventually(async () => (await repoSettings()).encoding, "windows-1252", "encoding");

    await row("Hooks folder").locator("input").fill(".githooks");
    await row("Hooks folder").locator("input").press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "core.hooksPath"]), ".githooks", "git config core.hooksPath in the repository");
    const picked = path.join(repo.path, "werkzeuge", "hooks");
    await app.pick(picked);
    await dialog().getByRole("button", { name: "Browse for hooks folder" }).click();
    await eventually(() => gitIn(repo.path, ["config", "--local", "core.hooksPath"]), picked, "browse sets the hooks folder");
    await row("Hooks folder").locator("input").fill("");
    await row("Hooks folder").locator("input").press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "core.hooksPath"]), "", "an empty field removes core.hooksPath");
    await row("Hooks folder").locator("input").fill(".githooks");
    await row("Hooks folder").locator("input").press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "core.hooksPath"]), ".githooks", "hooks folder set again");

    await row("Commit template").locator("input").fill(".gitmessage");
    await row("Commit template").locator("input").press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "commit.template"]), ".gitmessage", "git config commit.template");

    // Pull and fetch: inherited from the profile until overridden.
    await goto("Pull and fetch");
    equal(await row("Pull mode").getAttribute("data-own"), null, "pull mode is inherited at the start");
    await until(async () => /From Default: Rebase/.test(await row("Pull mode").innerText()), "the row names the profile and its mode");
    await override("Pull mode");
    await eventually(async () => (await repoSettings()).defaultPullMode, "rebase", "“Override” takes over the profile's mode");
    await row("Pull mode").getByRole("combobox").click();
    equal(await page.getByRole("option").allInnerTexts(), ["Fast-forward if possible", "Fast-forward only", "Rebase"], "pull modes");
    await page.getByRole("option", { name: "Fast-forward only" }).click();
    await eventually(async () => (await repoSettings()).defaultPullMode, "ff_only", "pull mode only for this repository");
    await row("Pull mode").getByRole("button", { name: "Reset to Default" }).click();
    await eventually(async () => (await repoSettings()).defaultPullMode, null, "“Reset to Default” saves null");
    await until(async () => /From Default: Rebase/.test(await row("Pull mode").innerText()), "the row names the profile's mode again");
    await override("Pull mode");
    await row("Pull mode").getByRole("combobox").click();
    await page.getByRole("option", { name: "Fast-forward only" }).click();
    await eventually(async () => (await repoSettings()).defaultPullMode, "ff_only", "pull mode set again");

    equal(before.autoFetch, true, "auto-fetch is inherited (on) at the start");
    await override("Auto-fetch");
    await eventually(async () => (await repoSettings()).autoFetch, false, "auto-fetch per repository");
    equal(await row("Auto-fetch").getByRole("switch").getAttribute("aria-checked"), "false", "the switch shows the own value");

    // Identity and access: “Override” copies the profile identity, then it can be edited.
    await goto("Identity and access");
    const name = dialog().locator('[data-setting="Author name"] input');
    const mail = dialog().locator('[data-setting="Email"] input');
    await until(async () => new RegExp(`From Default: ${profile.authorName}`).test(await row("Author name").innerText()), "author name is inherited from the profile");
    await override("Author name");
    await eventually(() => gitIn(repo.path, ["config", "--local", "user.name"]), profile.authorName, "“Override” writes the profile's name to .git/config");
    await name.fill("Jonas Albrecht");
    await name.press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "user.name"]), "Jonas Albrecht", "git config user.name in the repository");
    await override("Email");
    await mail.fill("kein-at");
    await mail.press("Enter");
    await until(async () => /not an email address/.test((await row("Email").getByRole("alert").allInnerTexts()).join(" ")), "an invalid email is reported at the field");
    await mail.fill("jonas@messnetz.example");
    await mail.press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "user.email"]), "jonas@messnetz.example", "git config user.email in the repository");
    await name.fill("");
    await name.press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "user.name"]), "", "an empty name removes user.name (then the profile identity applies)");
    await eventually(() => row("Author name").getAttribute("data-own"), null, "the row is inherited again");
    await override("Author name");
    await name.fill("Jonas Albrecht");
    await name.press("Enter");
    await eventually(() => gitIn(repo.path, ["config", "--local", "user.name"]), "Jonas Albrecht", "name set again");
    equal(await h.toasts(), [], "no messages");
    equal(await h.escaping('[data-screen="settings"]'), [], "nothing sticks out of the dialog");
    await app.screenshot(`${SHOTS}/settings-repo-light.png`);
  });

  // -------------------------------------------------------------------------
  const beforeRestart = await settings();
  await section("Esc closes; a restart keeps everything", async () => {
    await page.keyboard.press("Escape");
    await eventually(h.dialogs, [], "Esc closes the settings");
    equal(app.consoleErrors, [], "console errors before the restart");
    await app.close();
    page = await start();
    equal(await settings(), beforeRestart, "all settings after the restart");
    await eventually(() => page.evaluate(() => document.documentElement.dataset.theme), "light", "theme after the restart");
    await eventually(() => page.evaluate(() => document.documentElement.style.zoom), "1.1", "zoom after the restart");
    await app.openRepo(repo.path);
    await until(async () => (await page.locator('[role="toolbar"][aria-label="Repository actions"] button > span.sr-only:not([id])').count()) > 5, "toolbar without labels after the restart");
    const again = await app.invoke("repo_settings_get", { repoId });
    equal([again.encoding, again.defaultPullMode, again.hooksPath, again.commitTemplate, again.authorEmail], ["windows-1252", "ff_only", ".githooks", ".gitmessage", "jonas@messnetz.example"], "repository settings after the restart");

    // Back to dark, 100 % and with labels for the following sections and images – again through the UI.
    await openPrefs();
    await goto("Appearance");
    equal(await row("Theme").getByRole("radio", { name: "Light" }).getAttribute("aria-checked"), "true", "the toggle shows “Light”");
    equal(await row("Zoom").locator("input").inputValue(), "110", "the zoom field shows 110");
    await row("Theme").getByRole("radio", { name: "Dark" }).click();
    await eventually(() => page.evaluate(() => document.documentElement.dataset.theme), "dark", "dark again");
    await row("Zoom").getByRole("button", { name: "Reset" }).click();
    await eventually(() => page.evaluate(() => document.documentElement.style.zoom), "1", "100 % again");
    await toggle("Toolbar labels");
    await eventually(async () => (await settings()).toolbarLabels, true, "labels on again");
    await row("Date format").getByRole("radio", { name: "Relative" }).click();
    await eventually(async () => (await settings()).dateFormat, "relative", "date format relative again");
  });

  // -------------------------------------------------------------------------
  const profiles = () => app.invoke("profile_list");
  const activeProfile = async () => (await profiles()).find((profile) => profile.isActive);
  const globalConfig = (key) => gitWithGlobal(app.gitConfigPath, ["config", "--global", key]);

  await section("profiles profile: change identity, applies immediately, global gitconfig", async () => {
    await goto("Profile and identity");
    const start = await activeProfile();
    equal([start.name, start.authorName, start.syncGitconfig], ["Default", "Lena Hartmann", false], "profile at the start (from the global gitconfig)");
    equal(await dialog().locator('[data-state="no-author"]').count(), 0, "no “No author set” hint while there is one");

    // Keyboard only
    await h.tabTo("Author name");
    await h.retype("Lena H.");
    await page.keyboard.press("Enter");
    await eventually(async () => (await activeProfile()).authorName, "Lena H.", "author name in the core");
    await until(async () => /Lena H\./.test(await dialog().getByRole("group", { name: "Identity preview" }).innerText()), "the preview shows the new name");
    equal(globalConfig("user.name"), "Lena Hartmann", "without the switch the global gitconfig stays untouched");

    await h.tabTo("Email");
    await h.retype("lena-ohne-at");
    await page.keyboard.press("Enter");
    await until(async () => /not an email address/.test((await row("Email").getByRole("alert").allInnerTexts()).join(" ")), "an invalid email is reported at the field");
    equal((await activeProfile()).authorEmail, start.authorEmail, "and not saved");
    await h.retype("lena@messnetz.example");
    await page.keyboard.press("Enter");
    await eventually(async () => (await activeProfile()).authorEmail, "lena@messnetz.example", "email in the core");

    await h.tabTo("Write name and email to the global gitconfig");
    await page.keyboard.press("Space");
    await eventually(async () => (await activeProfile()).syncGitconfig, true, "switch in the core");
    await eventually(() => globalConfig("user.name"), "Lena H.", "git config --global user.name");
    await eventually(() => globalConfig("user.email"), "lena@messnetz.example", "git config --global user.email");

    await h.tabTo("Author name", { back: true });
    await h.retype("Lena Hartmann");
    await page.keyboard.press("Enter");
    await eventually(() => globalConfig("user.name"), "Lena Hartmann", "with the switch the gitconfig follows every change");
    equal(await h.toasts(), [], "no messages");
  });

  await section("profiles profile: no author, long names", async () => {
    const name = row("Author name").locator("input");
    await name.fill("");
    await name.press("Enter");
    await until(() => dialog().locator('[data-state="no-author"]').count(), "“No author set” hint appears");
    check(/The name is missing/.test(await dialog().locator('[data-state="no-author"]').innerText()), "the hint says what is missing");
    await app.screenshot(`${SHOTS}/profiles-noauthor.png`);
    await name.fill(LONG_AUTHOR);
    await name.press("Enter");
    await eventually(async () => (await activeProfile()).authorName, LONG_AUTHOR, "author name 60 characters long");
    const profileName = row("Profile name").locator("input");
    await profileName.fill(LONG_NAME);
    await profileName.press("Enter");
    await eventually(async () => (await activeProfile()).name, LONG_NAME, "profile name 60 characters long");
    equal(await h.escaping('[data-screen="settings"]'), [], "nothing sticks out of the dialog");
    const clipped = await dialog().locator(`[data-profile="${LONG_NAME}"] p`).first().evaluate((element) => ({ cut: element.scrollWidth > element.clientWidth, title: element.getAttribute("title") }));
    check(clipped.title === LONG_NAME, "the cut-off name is shown in full in the tooltip");
    await app.screenshot(`${SHOTS}/profiles-long.png`);
    await profileName.fill("");
    await profileName.press("Enter");
    await until(async () => /must not be empty/.test((await row("Profile name").getByRole("alert").allInnerTexts()).join(" ")), "an empty profile name is rejected");
    await profileName.fill("Default");
    await profileName.press("Enter");
    await name.fill("Lena Hartmann");
    await name.press("Enter");
    await eventually(async () => [(await activeProfile()).name, (await activeProfile()).authorName], ["Default", "Lena Hartmann"], "names restored");
  });

  await section("profiles profile: create a second profile, switch, back, delete", async () => {
    equal(await dialog().getByRole("button", { name: "Delete profile Default" }).getAttribute("aria-disabled"), "true", "the last profile cannot be deleted");
    await dialog().getByRole("button", { name: "New profile" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "New profile" }).waitFor();
    await eventually(h.focusedName, "Profile name", "focus in the first field");
    await page.keyboard.press("Enter");
    await until(() => page.getByRole("dialog", { name: "New profile" }).getByRole("alert").count(), "not possible without a name");
    await page.keyboard.type("default");
    await page.keyboard.press("Enter");
    await until(async () => /already exists/.test((await page.getByRole("dialog", { name: "New profile" }).getByRole("alert").allInnerTexts()).join(" ")), "duplicate name: core error at the field");
    await h.retype("Arbeit");
    await h.tabTo("Email");
    await page.keyboard.type("falsch");
    await page.keyboard.press("Enter");
    const newDialog = page.getByRole("dialog", { name: "New profile" });
    await until(
      async () => /not an email address/.test((await newDialog.getByRole("alert").allInnerTexts()).join(" ")),
      `invalid email in the dialog (fields: ${JSON.stringify(await newDialog.locator("input").evaluateAll((list) => list.map((input) => input.value)))})`,
    );
    await h.retype("");
    await page.keyboard.press("Enter");
    await h.waitToast(/Profile “Arbeit” created/);
    await eventually(async () => (await profiles()).map((profile) => `${profile.name}:${profile.isActive}`).sort(), ["Arbeit:false", "Default:true"], "two profiles, the new one is not active");
    await eventually(() => dialog().locator("[data-profile]").count(), 2, "the list shows both");
    await h.closeToasts();
    await app.screenshot(`${SHOTS}/profiles.png`);

    // Switch: without open work immediately, without a question (that only comes when something would be lost)
    await dialog().getByRole("button", { name: "Switch to profile Arbeit" }).focus();
    await page.keyboard.press("Enter");
    await eventually(async () => (await activeProfile()).name, "Arbeit", "Arbeit is active");
    equal(await page.getByRole("dialog", { name: /Switch to the profile “Arbeit”/ }).count(), 0, "no question");
    await until(() => dialog().locator('[data-state="no-author"]').count(), "the new profile has no author: hint appears");
    await eventually(async () => (await settings()).defaultBranchName, initial.defaultBranchName, "the new profile has its own (unchanged) settings");
    await eventually(async () => (await app.invoke("tabs_list")).map((tab) => tab.kind), ["management"], "and its own tabs");
    await eventually(() => page.getByRole("tab", { name: "Identity and access" }).count(), 0, "without a repo tab there are no project sections");
    equal(globalConfig("user.name"), "Lena Hartmann", "a profile without the switch does not touch the gitconfig");
    equal(await dialog().getByRole("button", { name: "Delete profile Arbeit" }).getAttribute("aria-disabled"), "true", "the active profile cannot be deleted");
    await h.closeToasts();

    // Back, then delete the second one
    await dialog().getByRole("button", { name: "Switch to profile Default" }).click();
    await eventually(async () => (await activeProfile()).name, "Default", "Default is active again");
    await eventually(async () => (await settings()).defaultBranchName, "trunk", "its settings are back");
    await eventually(async () => (await app.invoke("tabs_list")).some((tab) => tab.kind === "repo"), true, "and its tabs");
    await h.closeToasts();

    await dialog().getByRole("button", { name: "Delete profile Arbeit" }).click();
    const remove = page.getByRole("dialog", { name: /Delete profile “Arbeit”/ });
    await remove.waitFor();
    await eventually(h.focusedName, "Cancel", "question: focus on “Cancel”");
    check(/cannot be undone/.test(await remove.innerText()), "the question says what gets lost");
    await remove.getByRole("button", { name: "Delete profile" }).click();
    await eventually(async () => (await profiles()).map((profile) => profile.name), ["Default"], "only one profile left");
    await eventually(() => dialog().locator("[data-profile]").count(), 1, "the list shows one");
    await h.closeToasts();
  });

  // -------------------------------------------------------------------------
  const keys = () => app.invoke("ssh_key_list");
  await section("ssh-keys SSH: empty, generate a key (redirected folder)", async () => {
    await goto("SSH keys");
    equal(await keys(), [], "no key at the start");
    const empty = dialog().locator('[data-state="empty"]');
    await empty.waitFor();
    check(/No key yet/.test(await empty.innerText()), "empty state");
    equal(await empty.locator("ol > li").count(), 3, "instructions in three steps");
    await app.screenshot(`${SHOTS}/ssh-keys-empty.png`);

    // Keyboard only
    await dialog().getByRole("button", { name: "Generate key" }).focus();
    await page.keyboard.press("Enter");
    const create = page.getByRole("dialog", { name: "Generate SSH key" });
    await create.waitFor();
    await eventually(h.focusedName, "Label", "focus in the first field");
    await page.keyboard.press("Enter");
    await until(async () => /label/.test((await create.getByRole("alert").allInnerTexts()).join(" ")), "not possible without a label");
    await page.keyboard.type("Arbeitsrechner");
    await page.keyboard.press("Tab");
    equal(await create.getByLabel("File name").inputValue(), "id_ed25519", "suggested file name");
    await page.keyboard.press("Tab");
    await page.keyboard.type("abc");
    await page.keyboard.press("Enter");
    await until(async () => /At least 5 characters/.test((await create.getByRole("alert").allInnerTexts()).join(" ")), "passphrase too short");
    await h.retype("geheim-123");
    await page.keyboard.press("Tab");
    await page.keyboard.type("geheim-124");
    await page.keyboard.press("Enter");
    await until(async () => /do not match/.test((await create.getByRole("alert").allInnerTexts()).join(" ")), "repetition differs");
    equal(fs.readdirSync(sshDir), [], "nothing was created up to here");
    await h.retype("geheim-123");
    await page.keyboard.press("Enter");
    await h.waitToast(/Key “Arbeitsrechner” generated/, 60_000);
    await eventually(async () => (await keys()).map((key) => [key.label, key.hasPassphrase, key.isDefault, key.missing]), [["Arbeitsrechner", true, false, false]], "key in the core, with passphrase");
    equal(fs.readdirSync(sshDir).sort(), ["id_ed25519", "id_ed25519.pub"], "the files are in the redirected SSH folder");
    check(/ENCRYPTED|aes|bcrypt/i.test(fs.readFileSync(path.join(sshDir, "id_ed25519"), "utf8")) || fs.readFileSync(path.join(sshDir, "id_ed25519"), "utf8").includes("OPENSSH PRIVATE KEY"), "the private key file is an OpenSSH key");
    const card = dialog().locator('[data-key="Arbeitsrechner"]');
    await card.waitFor();
    const text = await card.innerText();
    check(/ED25519/.test(text) && /With passphrase/.test(text) && /SHA256:/.test(text), `card shows type, passphrase and fingerprint (${text.replace(/\s+/g, " ").slice(0, 160)})`);
    check(text.includes(path.join(sshDir, "id_ed25519")), "card shows the paths");
    await h.closeToasts();
  });

  await section("ssh-keys SSH: file exists, second key, copy, default", async () => {
    await dialog().getByRole("button", { name: "Generate key" }).click();
    const create = page.getByRole("dialog", { name: "Generate SSH key" });
    await create.waitFor();
    equal(await create.getByLabel("File name").inputValue(), "id_ed25519_2", "the suggestion avoids the existing name");
    await create.getByLabel("Label").fill("Zweitschlüssel");
    await create.getByLabel("File name").fill("id_ed25519");
    await create.getByRole("button", { name: "Generate key" }).click();
    await until(async () => /already exists/.test((await create.getByRole("alert").allInnerTexts()).join(" ")), "existing file: understandable error at the “File name” field");
    equal(await h.toasts(), [], "no toast for it");
    await create.getByLabel("File name").fill("a/b");
    await create.getByRole("button", { name: "Generate key" }).click();
    await until(async () => /not a path/.test((await create.getByRole("alert").allInnerTexts()).join(" ")), "path separator in the file name");
    await create.getByLabel("File name").fill("zweit-" + "x".repeat(54)); // 60 characters
    await create.getByRole("button", { name: "Generate key" }).click();
    await h.waitToast(/Key “Zweitschlüssel” generated/, 60_000);
    await eventually(async () => (await keys()).map((key) => `${key.label}:${key.hasPassphrase}`).sort(), ["Arbeitsrechner:true", "Zweitschlüssel:false"], "two keys, the second without passphrase");
    await h.closeToasts();
    equal(await h.escaping('[data-screen="settings"]'), [], "nothing sticks out even with a 60-character file name");

    // Copy the public key
    const publicKey = fs.readFileSync(path.join(sshDir, "id_ed25519.pub"), "utf8").trim();
    const card = dialog().locator('[data-key="Arbeitsrechner"]');
    equal((await card.locator("pre").innerText()).trim(), publicKey, "the key text is visible");
    equal(await card.locator("pre").evaluate((element) => getComputedStyle(element).userSelect), "text", "and selectable");
    await app.browser.contexts()[0].grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await card.getByRole("button", { name: "Copy public key" }).focus();
    await page.keyboard.press("Enter");
    await h.waitToast(/Public key copied/);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText()).catch((error) => `not readable: ${error.message}`);
    equal(clipboard, publicKey, "the clipboard contains the public key");
    await h.closeToasts();

    // Default
    await card.getByRole("button", { name: "Use as default" }).click();
    await eventually(async () => (await keys()).find((key) => key.label === "Arbeitsrechner")?.isDefault, true, "default key in the core");
    await until(async () => /Default/.test(await card.innerText()), "“Default” badge on the card");
    equal(await card.getByRole("button", { name: "Use as default" }).count(), 0, "the button disappears for the default key");
    await h.closeToasts();
    await app.screenshot(`${SHOTS}/ssh-keys.png`);
  });

  await section("ssh-keys SSH: add existing, file missing, remove", async () => {
    // A pair outside the SSH folder (copy of the second key)
    const second = (await keys()).find((key) => key.label === "Zweitschlüssel");
    const privatePath = path.join(externDir, "id_extern");
    fs.copyFileSync(second.privateKeyPath, privatePath);
    fs.copyFileSync(second.publicKeyPath, `${privatePath}.pub`);
    await app.pick(privatePath);
    await dialog().getByRole("button", { name: "Choose existing" }).click();
    const prompt = page.getByRole("dialog", { name: "Add key" });
    await prompt.waitFor();
    equal(await prompt.getByLabel("Label").inputValue(), "id_extern", "the label is prefilled with the file name");
    await prompt.getByLabel("Label").fill("Von außerhalb");
    await page.keyboard.press("Enter");
    await h.waitToast(/Key “Von außerhalb” added/);
    await eventually(async () => (await keys()).map((key) => key.label).sort(), ["Arbeitsrechner", "Von außerhalb", "Zweitschlüssel"], "three keys");
    await eventually(() => dialog().locator("[data-key]").count(), 3, "the list shows three");
    await h.closeToasts();

    // Without a .pub next to it: the app asks for the file
    const lonely = path.join(externDir, "nur-privat");
    fs.copyFileSync(second.privateKeyPath, lonely);
    await app.pick(lonely);
    await dialog().getByRole("button", { name: "Choose existing" }).click();
    await page.getByRole("dialog", { name: "Add key" }).waitFor();
    await page.keyboard.press("Enter");
    const ask = page.getByRole("dialog", { name: "Choose public key?" });
    await ask.waitFor();
    await app.pick(`${privatePath}.pub`);
    await ask.getByRole("button", { name: "Choose file" }).click();
    await h.waitToast(/Key “nur-privat” added/);
    await eventually(() => dialog().locator("[data-key]").count(), 4, "four entries");
    await h.closeToasts();

    // Not a key file
    const noKey = path.join(externDir, "notiz.txt");
    fs.writeFileSync(noKey, "kein Schlüssel\n");
    fs.writeFileSync(`${noKey}.pub`, "auch nicht\n");
    await app.pick(noKey);
    await dialog().getByRole("button", { name: "Choose existing" }).click();
    await page.getByRole("dialog", { name: "Add key" }).waitFor();
    await page.keyboard.press("Enter");
    const refused = await h.waitToast(/Add key failed/);
    check(/not a private SSH key/.test(refused), `the message says why (${refused.replace(/\s+/g, " ")})`);
    await h.closeToasts();

    // The file disappears outside the app: the next time the section opens it says “File missing”
    fs.rmSync(lonely);
    await goto("Credentials");
    await goto("SSH keys");
    await until(async () => /File missing/.test(await dialog().locator('[data-key="nur-privat"]').innerText()), "“File missing” badge");
    check(await dialog().locator('[data-key="nur-privat"]').getByRole("button", { name: "Use as default" }).isDisabled(), "a key without a file cannot become the default");
    await app.screenshot(`${SHOTS}/ssh-keys-missing.png`);

    // Remove: the question says that the files stay
    const card = dialog().locator('[data-key="Von außerhalb"]');
    await card.getByRole("button", { name: "Remove" }).focus();
    await page.keyboard.press("Enter");
    const remove = page.getByRole("dialog", { name: /Remove key “Von außerhalb”/ });
    await remove.waitFor();
    check(/The files stay where they are/.test(await remove.innerText()) && (await remove.innerText()).includes(privatePath), "question: only the entry disappears, with path");
    await eventually(h.focusedName, "Cancel", "focus on “Cancel”");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    equal((await keys()).length, 4, "Cancel removes nothing");
    await card.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("dialog", { name: /Remove key “Von außerhalb”/ }).getByRole("button", { name: "Remove entry" }).click();
    await eventually(async () => (await keys()).some((key) => key.label === "Von außerhalb"), false, "the entry is gone");
    check(fs.existsSync(privatePath) && fs.existsSync(`${privatePath}.pub`), "the files are still there");
    await h.closeToasts();
    for (const label of ["nur-privat", "Zweitschlüssel"]) {
      await dialog().locator(`[data-key="${label}"]`).getByRole("button", { name: "Remove" }).click();
      await page.getByRole("dialog", { name: new RegExp(`Remove key “${label}”`) }).getByRole("button", { name: "Remove entry" }).click();
      await eventually(async () => (await keys()).some((key) => key.label === label), false, `“${label}” removed`);
    }
    await h.closeToasts();
    check(fs.existsSync(second.privateKeyPath), "the generated file also stays when removing");
  });

  // -------------------------------------------------------------------------
  await section("Credentials: empty, list (injected data), forget all, no keychain", async () => {
    await goto("Credentials");
    await dialog().locator('[data-state="empty"]').waitFor();
    equal(await app.invoke("credentials_list"), [], "the core knows no saved entries");
    check(await dialog().getByRole("button", { name: "Forget all" }).isDisabled(), "without entries “Forget all” is disabled");
    await app.screenshot(`${SHOTS}/settings-credentials-empty.png`);

    // Filled list: real entries would need a server with sign-in – injected into the query cache here.
    const longHost = `git.${"sehr-langer-servername-".repeat(4)}example.org:8443/gruppe/untergruppe/projekt.git`;
    await page.evaluate(
      (host) =>
        window.__gc.queryClient.setQueryData(["app", "credentials"], [
          { id: "1", host: "github.com", username: "lena-hartmann", kind: "password", createdAt: "2026-09-30T08:15:00Z" },
          { id: "2", host, username: "lena.hartmann@wetterstation.example", kind: "password", createdAt: "2026-10-02T17:40:00Z" },
          { id: "3", host: "C:\\Users\\lena\\.ssh\\id_ed25519", username: "", kind: "passphrase", createdAt: "2026-10-09T06:05:00Z" },
        ]),
      longHost,
    );
    await eventually(() => dialog().locator("tbody tr").count(), 3, "three rows");
    const table = await dialog().locator("table").innerText();
    check(/Password or token/.test(table) && /Passphrase/.test(table) && /github\.com/.test(table), "host, user and type are shown");
    check(!/geheim|secret|token=/i.test(table), "no secret in the table");
    equal(await h.escaping('[data-screen="settings"]'), [], "the long host does not break the table");
    equal(await dialog().locator("tbody tr").nth(1).locator("td span").first().getAttribute("title"), longHost, "full host in the tooltip");
    await app.screenshot(`${SHOTS}/settings-credentials.png`);

    await dialog().getByRole("button", { name: "Forget all" }).click();
    const ask = page.getByRole("dialog", { name: /Forget all 3 saved entries/ });
    await ask.waitFor();
    await eventually(h.focusedName, "Cancel", "question: focus on “Cancel”");
    await ask.getByRole("button", { name: "Forget all" }).click();
    // The real core had saved nothing: it reports 0, and the list is reloaded.
    await h.waitToast(/There was nothing to forget/);
    await dialog().locator('[data-state="empty"]').waitFor();
    await h.closeToasts();

    await page.evaluate(() => {
      const client = window.__gc.queryClient;
      client.setQueryData(["app", "info"], { ...client.getQueryData(["app", "info"]), keyringAvailable: false });
    });
    await dialog().locator('[data-state="no-keyring"]').waitFor();
    check(/No keychain available/.test(await dialog().locator('[data-state="no-keyring"]').innerText()), "hint without a keychain");
    await app.screenshot(`${SHOTS}/settings-no-keyring.png`);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "info"] }));
    await eventually(() => dialog().locator('[data-state="no-keyring"]').count(), 0, "with a keychain no hint");
  });

  // -------------------------------------------------------------------------
  await section("About: versions, paths, platform", async () => {
    await goto("About");
    const info = await app.invoke("app_info");
    const fact = (name) => dialog().locator(`[data-fact="${name}"] dd`).innerText();
    equal(await fact("App version"), info.version, "app version");
    check((await fact("Git version")).startsWith(info.gitVersion), "Git version");
    equal(await fact("Git path"), info.gitPath, "Git path");
    equal(await fact("Platform"), "Windows", "platform");
    check((await fact("Data directory")).includes(dataDir), "the data directory is the instance's");
    equal(await dialog().getByRole("button", { name: "Show in Explorer" }).count(), 1, "“Show in Explorer” button (not clicked: it would open an Explorer window)");
    await dialog().getByRole("button", { name: "Copy information" }).click();
    await h.waitToast(/Information copied/);
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check(copied.includes(`forkyard ${info.version}`) && copied.includes(dataDir), "the copied information contains version and data directory");
    await h.closeToasts();
    await app.screenshot(`${SHOTS}/settings-about.png`);
  });

  // -------------------------------------------------------------------------
  await section("States: loading, error with “Try again”", async () => {
    await goto("Git behavior");
    // Cannot be caused with the real core: simulated at the core boundary – settings_get hangs
    // first (“loading”) and then really fails (“error”), see breakQuery in prefs-lib.mjs.
    const broken = await h.breakQuery("settingsGet", ["app", "settings"], "The database is locked.");
    await dialog().getByRole("status", { name: "Loading settings" }).waitFor();
    await app.screenshot(`${SHOTS}/settings-loading.png`);
    await broken.fail();
    const alert = dialog().getByRole("alert");
    await alert.waitFor();
    check(/The settings could not be loaded/.test(await alert.innerText()) && /The database is locked/.test(await alert.innerText()), "the error box names the reason");
    await app.screenshot(`${SHOTS}/settings-error.png`);
    check(await broken.restoreAndPress('[data-screen="settings"]', "Try again"), "there is “Try again”");
    await row("Default branch name").waitFor();
    equal(await row("Default branch name").locator("input").inputValue(), "trunk", "after “Try again” the real values are shown");
  });

  // -------------------------------------------------------------------------
  await section("Images: 1440×900 dark and light, 960×600", async () => {
    equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark", "dark");
    await app.screenshot(`${SHOTS}/settings.png`);
    await goto("Appearance");
    await app.screenshot(`${SHOTS}/settings-appearance.png`);
    await goto("External programs");
    await app.screenshot(`${SHOTS}/settings-external.png`);
    await goto("Files and hooks");
    await app.screenshot(`${SHOTS}/settings-repo.png`);
    await goto("Git behavior");
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/settings-light.png`);
    await goto("SSH keys");
    await app.screenshot(`${SHOTS}/ssh-keys-light.png`);
    await goto("Profile and identity");
    await app.screenshot(`${SHOTS}/profiles-light.png`);
    await app.setTheme("dark");

    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    for (const name of ["Git behavior", "Profile and identity", "SSH keys", "Identity and access", "Files and hooks"]) {
      await goto(name);
      const box = await dialog().boundingBox();
      check(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `960×600, ${name}: the dialog lies entirely inside the window (${JSON.stringify(box)})`);
      equal(await h.escaping('[data-screen="settings"]'), [], `960×600, ${name}: nothing sticks out`);
      const reachable = await dialog().locator("[data-prefs-scroll]").evaluate((element) => element.scrollHeight >= element.clientHeight && getComputedStyle(element).overflowY === "auto");
      check(reachable, `960×600, ${name}: the content scrolls inside the dialog`);
    }
    await goto("Git behavior");
    await app.screenshot(`${SHOTS}/settings-min.png`);
    await goto("Profile and identity");
    await app.screenshot(`${SHOTS}/profiles-min.png`);
    await goto("SSH keys");
    await app.screenshot(`${SHOTS}/ssh-keys-min.png`);
    // Tab to the last field: the focus scrolls it into view
    await goto("Git behavior");
    await page.getByRole("tab", { name: "Git behavior" }).focus();
    await h.tabTo("Remember tabs");
    const visible = await row("Remember tabs").getByRole("switch").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const box = element.closest("[data-prefs-scroll]").getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom;
    });
    check(visible, "960×600: the last field is reachable by Tab and visible");
    await app.setSize(1440, 900);
    const before = { focus: await h.focusedName(), layers: await page.locator("[data-radix-popper-content-wrapper]").count() };
    await page.keyboard.press("Escape");
    await eventually(h.dialogs, [], `Esc closes (focus before ${JSON.stringify(before.focus)}, open popups ${before.layers})`);
  });

  setCurrent("Console");
  check(app.consoleErrors.length === 0, `console errors:\n${app.consoleErrors.join("\n")}`);
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/settings-error.png").catch(() => undefined);
  await app?.close();
  repo.cleanup();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
finish("settings Settings (with profiles profile, ssh-keys SSH)", failures);
