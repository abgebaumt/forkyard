/**
 * network – signing commits: settings (global and per repository) and the signature badge in the
 * commit details, in the real app with real SSH signatures.
 *
 *   node scripts/e2e/screens/signing.mjs                 everything (checks and screenshots)
 *   node scripts/e2e/screens/signing.mjs --only global   only sections whose title contains "global" (comma separates several)
 *   node scripts/e2e/screens/signing.mjs --show          visible window
 *
 * The key is created in the app (redirected SSH folder, never ~/.ssh). Every setting is read back
 * from the Git config, every commit from the repository (gpgsig header, git log %G?). The
 * "keyboard only" sections don't use the mouse. Aborts on console errors.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { TEST_IDENTITY, makeCleanRepoWithRemote } from "../fixtures.mjs";
import { gitIn as gitRaw, tamper } from "./commit-panel-lib.mjs";
import { SHOTS, closeToasts, finish, makeChecks } from "./files-lib.mjs";
import { gitIn } from "./mustfix-lib.mjs";
import { pageHelpers } from "./prefs-lib.mjs";
import { wipDriver } from "./_wip.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const checks = makeChecks("signing");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const repo = makeCleanRepoWithRemote({ name: "signiert" });
const sshDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-e2e-sign-")));
const slash = (file) => file.replaceAll("\\", "/");
const samePath = (a, b) => slash(a ?? "").toLowerCase() === slash(b ?? "").toLowerCase();

const PREFS = '[data-screen="settings"]';
const commitDetailsScreen = '[data-screen="commit-details"]';

let app = null;
try {
  app = await launchApp({ show, env: { FORKYARD_SSH_DIR: sshDir } });
  state.app = app;
  const { page } = app;
  const h = pageHelpers(app);
  const wip = wipDriver(app, checks);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const { repoId, tabId } = await app.openRepo(repo.path);

  /** The app's global Git config (a separate file per run). */
  const globalConfig = (key) => {
    try {
      return gitIn(repo.path, app.gitConfigPath, "config", "--global", "--get", key);
    } catch {
      return null;
    }
  };
  const localConfig = (key) => {
    try {
      return gitIn(repo.path, app.gitConfigPath, "config", "--local", "--get", key);
    } catch {
      return null;
    }
  };
  /** How Git sees the commit with the app's config. */
  const gitSays = (sha) => gitIn(repo.path, app.gitConfigPath, "log", "-1", "--format=%G?", sha);
  const signed = (sha) => /^gpgsig -----BEGIN SSH SIGNATURE-----/m.test(repo.git("cat-file", "commit", sha));
  const store = (method, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [method, args]);
  const prefs = page.locator(PREFS);
  const scope = (name) => prefs.locator(`[data-signing="${name}"]`);
  const row = (name, title) => scope(name).locator(`[data-setting="${title}"]`);
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  /** Opens the settings (Ctrl+comma) at section `tab` – with `keyboard` only via the arrow keys of the section list. */
  const openPrefs = async (tab, { keyboard = false } = {}) => {
    await page.keyboard.press("Control+,");
    await prefs.waitFor();
    const selected = () => page.getByRole("tab", { selected: true }).innerText();
    if (keyboard) {
      for (let step = 0; step < 14; step++) {
        const now = await selected();
        if (now === tab) break;
        await page.keyboard.press("ArrowDown");
        // Radix moves focus and selection a moment after the key press.
        await page.waitForFunction((before) => document.querySelector('[data-screen="settings"] [role="tab"][aria-selected="true"]')?.textContent?.trim() !== before, now, { timeout: 5000 }).catch(() => undefined);
      }
    } else {
      await page.getByRole("tab", { name: tab, exact: true }).click();
    }
    await eventually(selected, tab, `section "${tab}" is open`);
    await app.settle();
  };
  /** Open the select: arrow keys to the entry, Enter. */
  const choose = async (wanted) => {
    await page.keyboard.press("Enter");
    await page.locator('[role="listbox"]').waitFor();
    for (let step = 0; step < 12; step++) {
      const name = await page.evaluate(() => (document.activeElement?.getAttribute("role") === "option" ? document.activeElement.textContent?.trim() : null));
      if (name !== null && (wanted instanceof RegExp ? wanted.test(name) : name === wanted)) break;
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(60);
    }
    await page.keyboard.press("Enter");
    await eventually(() => page.locator('[role="listbox"]').count(), 0, "the list is closed again");
  };
  /**
   * Makes a change and commits it in the app – with `keyboard` via the commit panel, keys only
   * (S stages, Ctrl+Enter commits), otherwise via the core command. Returns the new SHA.
   */
  const commitInApp = async (file, message, { keyboard = false } = {}) => {
    const before = repo.git("rev-parse", "HEAD");
    fs.appendFileSync(path.join(repo.path, file), `
${message}
`);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(async () => (await app.invoke("status_get", { repoId })).unstaged.length, 1, "the change is in the working directory");
    await app.settle();
    await store("selectWip", tabId);
    if (keyboard) {
      await wip.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "the list shows the change");
      await wip.tabToList("Unstaged files");
      await page.keyboard.press("s");
      await wip.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "S stages the file");
      await wip.tabToField("Summary");
      await page.keyboard.type(message);
      await page.keyboard.press("Control+Enter");
      await wip.waitToast("success", /Commit created/);
      await closeToasts(page);
    } else {
      await app.invoke("commit_create", { repoId, opId: `op-sign-${Date.now()}`, summary: message, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: true });
    }
    const sha = repo.git("rev-parse", "HEAD");
    check(sha !== before, "a new commit was created");
    equal(repo.git("log", "-1", "--format=%s"), message, "git: message of the new commit");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    return sha;
  };
  const badge = async (sha) => {
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "commit"] }), repoId);
    await store("selectCommits", tabId, [sha]);
    await page.locator(`${commitDetailsScreen}[data-selection="1"]`).waitFor();
    await page.waitForFunction((short) => document.querySelector('[data-screen="commit-details"]')?.textContent?.includes(short), sha.slice(0, 7));
    await app.settle();
    const mark = page.locator(`${commitDetailsScreen} [data-signature]`);
    return (await mark.count()) > 0 ? mark.getAttribute("data-signature") : "none";
  };
  state.resetView = async () => {
    for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await closeToasts(page);
    await app.settle();
  };

  // The key is created in the app (as in the settings under "SSH keys").
  const keys = await app.invoke("ssh_key_generate", { label: "Signier-Schlüssel", fileName: "id_signieren", passphrase: null });
  const key = keys.find((item) => item.label === "Signier-Schlüssel");
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "sshKeys"] }));
  let firstSigned = null;

  // -------------------------------------------------------------------------------------------
  await section("Global – keyboard only: format SSH, choose key, switch on", async () => {
    check(Boolean(key) && samePath(path.dirname(key.publicKeyPath), sshDir), "initial state: a key in the redirected SSH folder");
    equal([globalConfig("commit.gpgsign"), globalConfig("gpg.format"), globalConfig("user.signingkey")], [null, null, null], "initial state: Git config without signing entries");
    await openPrefs("Git behavior", { keyboard: true });
    await scope("global").waitFor();
    await eventually(() => scope("global").getAttribute("data-signing-state"), "ready", "the \"Sign commits\" block is loaded");
    check((await scope("global").innerText()).includes("Signing off"), "badge: Signing off (as a word)");
    equal(await row("global", "Program").locator("[data-signing-program]").innerText(), "gpg (Git default)", "program: default for OpenPGP");

    await h.tabTo("Format");
    await choose("SSH");
    await eventually(() => globalConfig("gpg.format"), "ssh", "git config --global gpg.format");
    await eventually(() => h.focusedName(), "Format", "focus returns to the select");
    // Without a key the switch stays disabled and says why.
    const toggle = row("global", "Sign commits").getByRole("switch");
    await eventually(() => toggle.isDisabled(), true, "without an SSH key \"Sign commits\" is disabled");
    check((await row("global", "Sign commits").innerText()).includes("Choose an SSH key first"), "with a reason");
    equal(await row("global", "Program").locator("[data-signing-program]").innerText(), "ssh-keygen (Git default)", "program: default for SSH");
    await shot("signing-needs-key");

    await h.tabTo("SSH key");
    await choose(/^Signier-Schlüssel/);
    await eventually(() => samePath(globalConfig("user.signingkey"), key.publicKeyPath), true, "git config --global user.signingKey is the public key");
    await eventually(() => toggle.isDisabled(), false, "with a key the switch is enabled");
    await h.tabTo("Sign commits");
    await page.keyboard.press("Space");
    await eventually(() => globalConfig("commit.gpgsign"), "true", "git config --global commit.gpgSign");
    await until(async () => (await scope("global").innerText()).includes("Signing on"), "badge: Signing on");
    equal(await toggle.getAttribute("aria-checked"), "true", "the switch is on");
    check((await row("global", "Sign commits").innerText()).includes("gpg.ssh.allowedSignersFile"), "hint: \"valid\" needs gpg.ssh.allowedSignersFile");
    equal(await app.invoke("signing_status", { repoId: null }).then((status) => [status.enabled, status.format]), [true, "ssh"], "core: signing_status reports on, ssh");
    await row("global", "Format").scrollIntoViewIfNeeded();
    await shot("signing-global");
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "Esc closes the settings");
  });

  // -------------------------------------------------------------------------------------------
  await section("Commit from the commit panel (keyboard only) is signed; the badge follows git log %G?", async () => {
    if (globalConfig("commit.gpgsign") !== "true") await app.invoke("signing_set", { repoId: null, enabled: true, format: "ssh", key: slash(key.publicKeyPath) });
    firstSigned = await commitInApp("README.md", "Signiert aus der App", { keyboard: true });
    check(signed(firstSigned), "git cat-file: the commit carries an SSH signature (gpgsig)");
    // Without gpg.ssh.allowedSignersFile Git cannot verify the signature (git log %G? then reports "N").
    const mapping = (letter) => (letter === "G" ? "good" : letter === "B" || letter === "R" ? "bad" : letter === "N" ? "none" : "unknown");
    const mark = page.locator(`${commitDetailsScreen} [data-signature]`);
    const letter = gitSays(firstSigned);
    const shown = await badge(firstSigned);
    equal(shown === "unknown" || shown === mapping(letter), true, `without allowedSignersFile: "can't be verified" or like git (%G? = "${letter}"), got "${shown}"`);
    if (shown !== "unknown") {
      checks.measurements.push(`CORE (not worked around): an SSH-signed commit without gpg.ssh.allowedSignersFile comes out of commit_details as signature "${shown}" (git log %G? = "${letter}"), although it has a gpgsig header – expected "unknown" (can't be verified).`);
      console.log(`  ! core: signed commit without allowedSignersFile → signature "${shown}" instead of "unknown"`);
    }

    // With the allowed signers file: valid.
    const allowed = path.join(repo.root, "allowed_signers");
    fs.writeFileSync(allowed, `${TEST_IDENTITY.email} ${key.publicKey.trim()}\n`);
    repo.git("config", "gpg.ssh.allowedSignersFile", slash(allowed));
    equal(gitSays(firstSigned), "G", "git log %G?: with allowedSignersFile the signature is valid");
    equal(await badge(firstSigned), "good", "the badge shows \"valid\"");
    equal(await mark.getAttribute("aria-label"), "Signature valid", "name of the badge");
    await mark.focus();
    await page.getByRole("tooltip").waitFor();
    await shot("signing-badge-good");
    await page.keyboard.press("Escape");

    // Signed with a key the file doesn't know: can't be verified.
    const strangerFile = path.join(repo.root, "fremder-schluessel");
    const keygen = path.resolve(repo.git("--exec-path"), "../../../usr/bin", process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen");
    execFileSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "fremd", "-f", strangerFile], { stdio: "pipe", windowsHide: true });
    repo.git("-c", "gpg.format=ssh", "-c", `user.signingkey=${slash(strangerFile)}.pub`, "commit", "-q", "-S", "--allow-empty", "-m", "Mit fremdem Schlüssel signiert");
    const stranger = repo.git("rev-parse", "HEAD");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    const strangerLetter = gitSays(stranger);
    equal(await badge(stranger), mapping(strangerLetter), `foreign key: the badge follows git (%G? = "${strangerLetter}")`);
    check(mapping(strangerLetter) === "unknown", `Git reports the foreign key as unverifiable (%G? = "${strangerLetter}")`);
    if (mapping(strangerLetter) === "unknown") {
      equal(await mark.getAttribute("aria-label"), "Signature can’t be verified", "name of the badge for an unknown key");
      await mark.focus();
      await page.getByRole("tooltip").waitFor();
      check((await page.getByRole("tooltip").innerText()).includes("Signature can’t be verified"), "the tooltip explains the state");
      await shot("signing-badge-unknown");
      await page.keyboard.press("Escape");
    }

    // An outside commit without signature shows nothing.
    fs.appendFileSync(path.join(repo.path, "README.md"), "\nOhne Signatur.\n");
    repo.git("-c", "commit.gpgsign=false", "commit", "-q", "-am", "Ohne Signatur von außen");
    const plain = repo.git("rev-parse", "HEAD");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    equal(gitSays(plain), "N", "git log %G?: no signature");
    equal(await badge(plain), "none", "without a signature there is no badge");

    // Forged: signature stays, content changes.
    const raw = repo.git("cat-file", "commit", firstSigned).replace("Signiert aus der App", "Nachträglich verfälscht");
    const forged = gitRaw(repo.path, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: `${raw}\n` });
    const forgedLetter = gitSays(forged);
    const expected = mapping(forgedLetter);
    equal(await badge(forged), expected, `forged commit: the badge follows git (%G? = "${forgedLetter}")`);
    check(expected === "bad", `Git reports the forged signature as invalid (%G? = "${forgedLetter}")`);
    if (expected === "bad") {
      equal(await mark.getAttribute("aria-label"), "Signature invalid", "name of the badge for an invalid signature");
      await mark.focus();
      await page.getByRole("tooltip").waitFor();
      await shot("signing-badge-bad");
      await page.keyboard.press("Escape");
    }
  });

  // -------------------------------------------------------------------------------------------
  await section("Per repository: switch off, own state, \"Like global\"", async () => {
    await store("selectWip", tabId);
    await openPrefs("Identity and access");
    await scope("repo").waitFor();
    await eventually(() => scope("repo").getAttribute("data-signing-state"), "ready", "repository block loaded");
    await scope("repo").scrollIntoViewIfNeeded();
    const text = async () => (await scope("repo").innerText()).replace(/\s+/g, " ");
    check((await text()).includes("Currently the same as the global setting applies here."), "without own entries: says the global setting applies");
    check((await text()).includes("Signing on"), "shows the effective state: on");
    equal(await scope("repo").locator('[data-action="signing-like-global"]').count(), 0, "no \"Like global\" as long as nothing differs");

    const toggle = row("repo", "Sign commits").getByRole("switch");
    await toggle.click();
    await eventually(() => localConfig("commit.gpgsign"), "false", "git config --local commit.gpgSign = false");
    equal(globalConfig("commit.gpgsign"), "true", "globally it stays on");
    equal([localConfig("gpg.format"), localConfig("user.signingkey")], [null, null], "the repository only holds what differs: format and key stay inherited");
    await until(async () => (await text()).includes("Signing off"), "badge in the repository: Signing off");
    check((await text()).includes("Global setting: Signing on, SSH"), "names the global setting");
    await row("repo", "Format").scrollIntoViewIfNeeded();
    await shot("signing-repo");
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "settings closed");

    const unsigned = await commitInApp("README.md", "Im Repository abgeschaltet");
    check(!signed(unsigned), "git cat-file: this commit carries no signature");
    equal(await badge(unsigned), "none", "and shows no badge");

    await store("selectWip", tabId);
    await openPrefs("Identity and access");
    await scope("repo").locator('[data-action="signing-like-global"]').click();
    await eventually(() => localConfig("commit.gpgsign"), "true", "\"Like global\" sets commit.gpgSign in the repository back to on");
    await eventually(() => [localConfig("gpg.format"), localConfig("user.signingkey")], [null, null], "and no own entries for format and key remain");
    await until(async () => (await text()).includes("Currently the same as the global setting applies here."), "the block reports again: like global");
    await page.keyboard.press("Escape");
    const again = await commitInApp("README.md", "Wieder signiert");
    check(signed(again), "git cat-file: the next commit is signed again");
    equal(await badge(again), "good", "and shows \"valid\"");
  });

  // -------------------------------------------------------------------------------------------
  await section("OpenPGP: key ID as a field; changing format drops the key; program from the Git config", async () => {
    await store("selectWip", tabId);
    await openPrefs("Git behavior");
    await scope("global").waitFor();
    await row("global", "Format").getByRole("combobox").click();
    await page.getByRole("option", { name: "OpenPGP (GPG)" }).click();
    await eventually(() => globalConfig("gpg.format"), "openpgp", "git config --global gpg.format = openpgp");
    equal(globalConfig("user.signingkey"), null, "the SSH key is removed as signing key");
    equal(globalConfig("commit.gpgsign"), "true", "the switch stays as it was");
    const field = row("global", "Key ID").locator("input");
    await field.fill("3AA5 C343");
    await field.press("Enter");
    await until(async () => (await row("global", "Key ID").getByRole("alert").allInnerTexts()).join(" ").includes("contains no spaces"), "an identifier with spaces is rejected at the field");
    equal(globalConfig("user.signingkey"), null, "and not saved");
    await field.fill("3AA5C34371567BD2");
    await field.press("Enter");
    await eventually(() => globalConfig("user.signingkey"), "3AA5C34371567BD2", "git config --global user.signingKey");
    await shot("signing-openpgp");

    // Back to SSH: signing turns off until a key is chosen again.
    await row("global", "Format").getByRole("combobox").click();
    await page.getByRole("option", { name: "SSH", exact: true }).click();
    await eventually(() => [globalConfig("gpg.format"), globalConfig("commit.gpgsign"), globalConfig("user.signingkey")], ["ssh", "false", null], "switch to SSH: without a key signing turns off");
    await row("global", "SSH key").getByRole("combobox").click();
    await page.getByRole("option", { name: /^Signier-Schlüssel/ }).click();
    await eventually(() => samePath(globalConfig("user.signingkey"), key.publicKeyPath), true, "key chosen again");
    await row("global", "Sign commits").getByRole("switch").click();
    await eventually(() => globalConfig("commit.gpgsign"), "true", "signing on again");
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "settings closed");

    // A custom program is in the Git config – the app shows it.
    const program = slash(path.join(repo.root, "werkzeuge", "mein-ssh-keygen.exe"));
    fs.appendFileSync(app.gitConfigPath, `[gpg "ssh"]\n\tprogram = ${program}\n`);
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "signing"] }));
    await openPrefs("Git behavior");
    await eventually(() => row("global", "Program").locator("[data-signing-program]").innerText(), program, "program from gpg.ssh.program is shown");
    await page.keyboard.press("Escape");
    // Remove it again so the following commits are signed with the real ssh-keygen.
    gitIn(repo.path, app.gitConfigPath, "config", "--global", "--unset", "gpg.ssh.program");
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "signing"] }));
  });

  // -------------------------------------------------------------------------------------------
  await section("States: loading, error with \"Try again\", no SSH key, long key name", async () => {
    await page.evaluate(() => window.__gc.queryClient.removeQueries({ queryKey: ["app", "signing"] }));
    const slow = await tamper(page, "signingStatus", { delayMs: 2500 });
    await page.keyboard.press("Control+,");
    await prefs.waitFor();
    await page.getByRole("tab", { name: "Git behavior", exact: true }).click();
    await eventually(() => scope("global").getAttribute("data-signing-state"), "loading", "while the setting loads, a skeleton is shown");
    equal(await scope("global").locator('[role="status"]').count(), 1, "skeleton with role=status");
    await eventually(() => scope("global").getAttribute("data-signing-state"), "ready", "then the fields");
    await slow.restore();
    await page.keyboard.press("Escape");

    await page.evaluate(() => window.__gc.queryClient.removeQueries({ queryKey: ["app", "signing"] }));
    const broken = await tamper(page, "signingStatus", { fail: { code: "io", message: "Could not read the Git configuration (probe).", gitOutput: null } });
    await openPrefs("Git behavior");
    await eventually(() => scope("global").getAttribute("data-signing-state"), "error", "if reading fails, the error state is shown");
    check((await scope("global").getByRole("alert").innerText()).includes("Could not read the Git configuration (probe)."), "with the reason");
    await shot("signing-error");
    await broken.restore();
    await scope("global").getByRole("button", { name: "Try again" }).click();
    await eventually(() => scope("global").getAttribute("data-signing-state"), "ready", "\"Try again\" loads the setting");
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "settings closed");

    // Very long name and a second key: the list stays within bounds.
    const longLabel = "Sehr langer Name für den Schlüssel des Messnetz-Rechners im Keller der Schule Nord, zweite Reihe";
    await app.invoke("ssh_key_generate", { label: longLabel, fileName: "id_lang", passphrase: null });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "sshKeys"] }));
    await openPrefs("Git behavior");
    await row("global", "SSH key").getByRole("combobox").click();
    equal(await page.getByRole("option").count(), 2, "both keys can be chosen");
    equal(await h.escaping(PREFS), [], "even with a long name nothing overflows the dialog");
    await shot("signing-keys");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "settings closed");
  });

  // -------------------------------------------------------------------------------------------
  await section("Screenshots: light and minimum window", async () => {
    await openPrefs("Git behavior");
    await row("global", "Program").scrollIntoViewIfNeeded();
    await app.setTheme("light");
    await shot("signing-global-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await row("global", "Sign commits").scrollIntoViewIfNeeded();
    equal(await h.escaping(PREFS), [], "960×600: nothing overflows the dialog");
    await shot("signing-global-min");
    await app.setSize(1440, 900);
    await page.keyboard.press("Escape");
  });
} catch (error) {
  check(false, `script aborted: ${error?.stack ?? error}`);
}
await finish("signing", checks, app, () => {
  repo.cleanup();
  fs.rmSync(sshDir, { recursive: true, force: true });
});
