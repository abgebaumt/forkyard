/**
 * Proof of "SSH keys: generate, default, copy public key, agent" and "Clone over SSH" in the real
 * app – with a REAL SSH server: the system's OpenSSH sshd, started as a user process on 127.0.0.1
 * (scripts/e2e/git-ssh-server.mjs). Without sshd only the parts that need no server run, and the
 * script says so.
 *
 *   node scripts/e2e/screens/mustfix-ssh.mjs [--show] [--no-shots] [--only <part>]
 *
 * Flows:
 * - Generate a key in the preferences (keyboard only), in the redirected SSH folder (FORKYARD_SSH_DIR);
 *   set it as default, turn off "Use the system SSH agent", copy the public key.
 * - Fetch against ssh:// on a closed port: understandable error, entry in the activity log (activity-log) without secrets.
 * - Clone over SSH: the unknown-host prompt shows the server's fingerprint; reject = cancelled,
 *   no folder, no entry in known_hosts; accept → clone succeeds, signed in with exactly the default key.
 * - Fetch and push over SSH, without further prompts.
 * - "Use the system SSH agent" on: the default key is no longer forced → sign-in rejected,
 *   understandably; off: it works again.
 * - Key with passphrase: prompt, wrong passphrase → rejected, correct one (remembered) → fetch succeeds,
 *   the next fetch does not ask again.
 * - Key without access on the server → auth_failed, understandably.
 *
 * Isolation: own SSH folder, own known_hosts file (core.sshCommand in the app's global gitconfig),
 * no ~/.ssh/config. The keychain is cleared at the end with credentials_forget_all.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { findSshd, startGitSshServer } from "../git-ssh-server.mjs";
import { appendAppGitConfig, createRun, slash, sleep } from "./mustfix-lib.mjs";
import { makeWorkspace } from "./repo-entry-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("mustfix-ssh", { argv });
const { check, equal, eventually, section, waitDialog, waitToast, noErrorToast, shot } = t;

const PASSPHRASE = "Wolken-Zug-Nordwest";

const ws = makeWorkspace("ssh");
const sshDir = ws.dir("ssh-ordner");
const knownHosts = ws.at("known_hosts");
const target = ws.dir("Klone");
const source = makeCleanRepoWithRemote({ name: "messnetz-quelle" });

/** A port nobody is listening on right now. */
const closedPort = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

let server = null;
let serverProblem = null;
if (findSshd()) {
  try {
    server = await startGitSshServer();
    server.createBare("messnetz.git", { from: source.path });
  } catch (error) {
    serverProblem = String(error?.message ?? error);
  }
} else {
  serverProblem = "There is no sshd on this machine.";
}

let app = null;
let page = null;

const sshKeys = () => app.invoke("ssh_key_list");
const credentialRequests = () => page.evaluate(() => window.__mfRequests.slice());
const knownHostsText = () => (fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, "utf8") : "");

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark", env: { FORKYARD_SSH_DIR: sshDir } });
  page = app.page;
  t.attach(app);
  // Own known_hosts, no ~/.ssh/config: the run does not touch the machine's SSH files.
  appendAppGitConfig(app, `[core]\n\tsshCommand = ssh -F none -o UserKnownHostsFile='${slash(knownHosts)}' -o GlobalKnownHostsFile=/dev/null\n`);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  await page.evaluate(() => {
    window.__mfRequests = [];
    window.__gc.core.on("credential:request", (request) => window.__mfRequests.push({ kind: request.kind, host: request.host, detail: request.detail ?? null, canRemember: request.canRemember }));
  });

  const prefs = page.locator('[data-screen="settings"]');
  const openSshPrefs = async () => {
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Control+Comma");
    await prefs.waitFor();
    await prefs.getByRole("tab", { name: "SSH keys" }).click();
    await prefs.getByRole("heading", { name: "SSH keys" }).waitFor();
  };
  const closePrefs = async () => {
    await t.closeToasts();
    await page.keyboard.press("Escape");
    await prefs.waitFor({ state: "detached" });
  };
  const agentSwitch = () => prefs.getByRole("switch", { name: "Use the system SSH agent" });

  const form = page.locator('[data-screen="clone"]');
  const field = (label) => form.getByLabel(label, { exact: true });
  const openCloneDialog = async () => {
    const tabs = await app.invoke("tabs_list");
    const management = tabs.find((tab) => tab.kind === "management");
    if (management) await app.invoke("tab_activate", { tabId: management.id });
    else await app.invoke("tab_open", { repoId: null });
    await page.locator('[data-screen="repo-management"]').waitFor();
    await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Clone …" }).click();
    await form.waitFor();
  };
  const activity = async (repoId) => (await app.invoke("activity_list", { scope: repoId ? "repo" : "app", repoId: repoId ?? null, cursor: null, limit: 50 })).entries ?? [];

  let firstKey = null;

  await section("Generate key (keyboard only), default, copy public key", async () => {
    equal(await sshKeys(), [], "at the start the app knows no key (the SSH folder is redirected and empty)");
    await openSshPrefs();
    await prefs.locator('[data-state="empty"]').waitFor();
    equal(await agentSwitch().getAttribute("aria-checked"), "true", "\"Use the system SSH agent\" is on initially (agent and SSH config decide)");
    await shot("mustfix-ssh-empty");
    // Keyboard only: focus the button, Enter, fill in the fields, Enter.
    await prefs.getByRole("button", { name: "Generate key" }).focus();
    await page.keyboard.press("Enter");
    await waitDialog(/^Generate SSH key$/);
    equal((await t.focused()).label, "Label", "focus is in the \"Label\" field");
    await page.keyboard.type("Messrechner");
    await page.keyboard.press("Enter");
    await waitToast(/Key “Messrechner” generated/, "success", 60_000);
    const keys = await sshKeys();
    equal(keys.length, 1, "one key in the list");
    firstKey = keys[0];
    check(firstKey?.hasPassphrase === false, "without passphrase");
    check(path.dirname(firstKey?.privateKeyPath ?? "").toLowerCase() === sshDir.toLowerCase(), `the file is in the redirected folder: ${firstKey?.privateKeyPath}`);
    check(fs.existsSync(path.join(sshDir, "id_ed25519")) && fs.existsSync(path.join(sshDir, "id_ed25519.pub")), "both key files are on disk");
    check(/^SHA256:/.test(firstKey?.fingerprint ?? ""), `fingerprint is there: ${firstKey?.fingerprint}`);
    const card = prefs.locator('[data-key="Messrechner"]');
    check((await card.innerText()).includes(firstKey.fingerprint), "the card shows the fingerprint");
    await t.closeToasts();

    // Set as default (keyboard): while the agent is on, the message says when the key takes effect.
    await card.getByRole("button", { name: "Use as default" }).focus();
    await page.keyboard.press("Enter");
    const made = await waitToast(/“Messrechner” is now the default key/, "success");
    check(/Use the system SSH agent/.test(made?.text ?? ""), `the message explains that the agent still decides: ${made?.text}`);
    await eventually(async () => (await sshKeys())[0]?.isDefault, true, "the key is the default (ssh_key_list)");
    await eventually(async () => (await card.innerText()).includes("Default"), true, "the card shows \"Default\"");
    await t.closeToasts();

    // Agent off (keyboard): from now on the app forces the default key.
    await agentSwitch().focus();
    await page.keyboard.press("Space");
    await eventually(() => agentSwitch().getAttribute("aria-checked"), "false", "the switch is off");
    await eventually(async () => (await app.invoke("settings_get")).sshUseAgent, false, "the setting is saved");

    await card.getByRole("button", { name: "Copy public key" }).click();
    await waitToast(/Public key copied/, "success");
    // The WebView may refuse to read the clipboard; then only the success toast remains as evidence.
    const clipboard = await page.evaluate(() => Promise.race([navigator.clipboard.readText().catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), 2000))]));
    if (clipboard === null) console.log("  (clipboard not readable – content not checked)");
    else equal(clipboard.trim(), firstKey.publicKey.trim(), "the clipboard holds exactly the public key");
    await shot("mustfix-ssh-key");
    await app.setTheme("light");
    await shot("mustfix-ssh-key-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await shot("mustfix-ssh-key-min");
    equal(await t.overflow(), { x: 0, y: 0 }, "960x600: no overflow");
    await app.setSize(1440, 900);
    await closePrefs();
  });

  await section("Fetch against a closed SSH port: understandable error, log without secrets", async () => {
    const offline = makeCleanRepoWithRemote({ name: "funkloch" });
    try {
      const url = `ssh://${os.userInfo().username}@127.0.0.1:${closedPort}/funkloch.git`;
      offline.git("remote", "set-url", "origin", url);
      const { repoId } = await app.openRepo(offline.path);
      await t.toolButton("Fetch").click();
      const failed = await waitToast(/Fetch from “origin” failed/, "danger", 90_000);
      check(/can.t be reached/i.test(failed?.text ?? ""), `the message says the server cannot be reached: ${failed?.text}`);
      equal(await credentialRequests(), [], "no prompt came up");
      await shot("mustfix-ssh-offline");
      await t.closeToasts();
      // Activity log (activity-log): the call is listed with address and error output.
      await page.locator("footer").getByRole("button", { name: "Log" }).click();
      const log = page.locator('[data-screen="activity-log"]');
      await log.waitFor();
      const row = log.locator("[data-row]").filter({ hasText: /^.*git fetch/ }).first();
      await row.waitFor();
      check(/failed with exit code/.test((await row.getAttribute("aria-label")) ?? ""), "the fetch row is marked as failed");
      await row.focus();
      await page.keyboard.press("Enter");
      await eventually(async () => (await log.innerText()).includes(`port ${closedPort}`), true, "expanded, the log shows the ssh output with host and port");
      const entries = await activity(repoId);
      const fetchEntry = entries.find((entry) => /^git fetch/.test(entry.command));
      check(Boolean(fetchEntry) && fetchEntry.exitCode !== 0, `log entry of the fetch with exit code != 0: ${JSON.stringify(fetchEntry?.command)}`);
      check(/Connection refused|connect to host/i.test(fetchEntry?.output ?? ""), `the ssh output is in the log: ${fetchEntry?.output?.slice(0, 160)}`);
      const everything = JSON.stringify(entries);
      check(!everything.includes("PRIVATE KEY") && !everything.includes(PASSPHRASE), "the log contains no secret");
      await shot("mustfix-ssh-log");
      await page.keyboard.press("Escape");
      await log.waitFor({ state: "detached" });
      const tabs = await app.invoke("tabs_list");
      await app.invoke("tab_close", { tabId: tabs.find((tab) => tab.repoId === repoId).id });
    } finally {
      offline.cleanup();
    }
  });

  if (!server) {
    await section("Real SSH server", async () => {
      check(false, `no SSH round trip possible: ${serverProblem}`);
    });
  } else {
    const sshUrl = server.url("messnetz.git");
    const hostPort = `127.0.0.1:${server.port}`;
    const cloned = path.join(target, "messnetz");
    let repoId = null;

    await section("Clone over SSH: unknown host – reject", async () => {
      server.authorize(firstKey.publicKey);
      await server.ready();
      await openCloneDialog();
      await field("Address").fill(sshUrl);
      equal(await form.locator("[data-url-kind]").getAttribute("data-url-kind"), "ssh", "the address is recognised as SSH");
      await field("Target folder").fill(target);
      await field("Folder name").fill("messnetz");
      await page.getByRole("button", { name: "Clone", exact: true }).click();
      const ask = await waitDialog(/^Unknown SSH host$/, 60_000);
      const text = (await ask.innerText()).replace(/\s+/g, " ");
      check(text.includes(server.hostFingerprint), `the prompt shows the server's fingerprint (${server.hostFingerprint}): ${text.slice(0, 300)}`);
      check(text.includes("127.0.0.1"), "and names the host");
      equal((await t.focused()).text, "Cancel", "focus is on \"Cancel\" – Enter never trusts by accident");
      equal((await credentialRequests()).at(-1)?.kind, "host_key", "the core asked about the host key");
      await shot("mustfix-ssh-hostkey");
      await app.setTheme("light");
      await shot("mustfix-ssh-hostkey-light");
      await app.setTheme("dark");
      await app.setSize(960, 600);
      await shot("mustfix-ssh-hostkey-min");
      equal(await t.overflow(), { x: 0, y: 0 }, "960x600: no overflow");
      await app.setSize(1440, 900);
      await page.keyboard.press("Enter");
      await form.locator("[data-clone-cancelled]").waitFor({ timeout: 30_000 });
      check(!fs.existsSync(cloned), "no folder was created");
      check(!knownHostsText().includes(hostPort), "the host is not in known_hosts");
      await noErrorToast("rejecting is not an error");
    }, { keep: true });

    await section("Clone over SSH: accept host → clone with the default key", async () => {
      await server.ready();
      const before = server.accepted().length;
      await page.getByRole("button", { name: "Clone", exact: true }).click();
      const ask = await waitDialog(/^Unknown SSH host$/, 60_000);
      await ask.getByRole("button", { name: "Trust host and connect" }).click();
      await page.getByRole("tab", { name: /messnetz/ }).waitFor({ timeout: 90_000 });
      await form.waitFor({ state: "detached" });
      check(fs.existsSync(path.join(cloned, ".git")), "the clone is on disk");
      equal(ws.git(cloned, "rev-parse", "HEAD"), server.git("messnetz.git", "rev-parse", "main"), "HEAD of the clone = main on the server (git)");
      equal(ws.git(cloned, "remote", "get-url", "origin"), sshUrl, "origin is the SSH address");
      equal(server.accepted().slice(before), [firstKey.fingerprint], "the server saw exactly one sign-in – with the app's default key (fingerprint in the sshd log)");
      check(knownHostsText().includes(`[127.0.0.1]:${server.port}`), "the host is now in the (own) known_hosts file");
      await waitToast(/“messnetz” has been cloned/, "success");
      repoId = (await app.invoke("repo_list")).find((repo) => repo.path.toLowerCase() === cloned.toLowerCase())?.id ?? null;
      check(Boolean(repoId), "the repository is in the list");
    });

    await section("Fetch and push over SSH, without further prompts", async () => {
      const asked = (await credentialRequests()).length;
      // New commit on the server (directly into the bare repo).
      ws.git(source.path, "checkout", "-q", "main");
      fs.writeFileSync(path.join(source.path, "neu-vom-server.md"), "Nachtrag auf dem Server.\n");
      ws.git(source.path, "add", "-A");
      ws.git(source.path, "commit", "-q", "-m", "Nachtrag auf dem Server");
      ws.git(source.path, "push", "-q", path.join(server.reposDir, "messnetz.git"), "main");
      const serverHead = server.git("messnetz.git", "rev-parse", "main");
      await server.ready();
      await t.toolButton("Fetch").click();
      await waitToast(/Fetch complete/, "success", 60_000);
      equal(ws.git(cloned, "rev-parse", "origin/main"), serverHead, "origin/main is up to date after the fetch over SSH (git)");
      await eventually(() => t.toolState("Pull").then((state) => state.label), "Pull, 1 commit to pull", "the toolbar shows ↓1");
      await t.closeToasts();

      ws.git(cloned, "merge", "-q", "--ff-only", "origin/main");
      fs.writeFileSync(path.join(cloned, "lokal.md"), "Über SSH gepusht.\n");
      ws.git(cloned, "add", "-A");
      ws.git(cloned, "commit", "-q", "-m", "Lokaler Commit über SSH");
      const local = ws.git(cloned, "rev-parse", "HEAD");
      await t.refresh(repoId);
      await eventually(() => t.toolState("Push").then((state) => state.label), "Push, 1 commit to push", "Push shows the counter");
      await server.ready();
      await t.toolButton("Push").click();
      await waitToast(/Pushed to origin\/main/, "success", 60_000);
      equal(server.git("messnetz.git", "rev-parse", "main"), local, "the commit is on the server (git in the bare repo)");
      equal((await credentialRequests()).length, asked, "neither fetch nor push asked anything");
      check(server.accepted().every((fingerprint) => fingerprint === firstKey.fingerprint), "all sign-ins used the default key");
    });

    await section("\"Use the system SSH agent\" turns off the forced key", async () => {
      await openSshPrefs();
      await agentSwitch().focus();
      await page.keyboard.press("Space");
      await eventually(() => agentSwitch().getAttribute("aria-checked"), "true", "the switch is on");
      await eventually(async () => (await app.invoke("settings_get")).sshUseAgent, true, "the setting is saved");
      await shot("mustfix-ssh-agent-on");
      await closePrefs();
      // The key is in the redirected folder; without "-i" ssh does not offer it.
      const before = server.accepted().length;
      await server.ready();
      await t.toolButton("Fetch").click();
      const failed = await waitToast(/Fetch from “origin” failed/, "danger", 90_000);
      check(/Signing in/.test(failed?.text ?? ""), `understandable: the sign-in was rejected: ${failed?.text}`);
      equal(server.accepted().length, before, "the server saw no sign-in with the app's key");
      await shot("mustfix-ssh-agent-denied");
      await t.closeToasts();

      await openSshPrefs();
      await agentSwitch().click();
      await eventually(async () => (await app.invoke("settings_get")).sshUseAgent, false, "off again");
      await closePrefs();
      await server.ready();
      await t.toolButton("Fetch").click();
      await waitToast(/Fetch complete/, "success", 60_000);
      equal(server.accepted().at(-1), firstKey.fingerprint, "with the agent off the app signs in with the default key again");
      await t.closeToasts();
    });

    await section("Key with passphrase: prompt, wrong, right and remembered", async () => {
      await openSshPrefs();
      await prefs.getByRole("button", { name: "Generate key" }).click();
      const dialog = await waitDialog(/^Generate SSH key$/);
      await dialog.getByLabel("Label").fill("Tresor");
      equal(await dialog.getByLabel("File name").inputValue(), "id_ed25519_2", "the file name avoids the existing one");
      await dialog.getByLabel("Passphrase (optional)").fill(PASSPHRASE);
      await dialog.getByLabel("Repeat passphrase").fill(`${PASSPHRASE}x`);
      await dialog.getByRole("button", { name: "Generate key" }).click();
      await dialog.getByText("The two entries do not match.").waitFor();
      await dialog.getByLabel("Repeat passphrase").fill(PASSPHRASE);
      await dialog.getByRole("button", { name: "Generate key" }).click();
      await waitToast(/Key “Tresor” generated/, "success", 60_000);
      await t.closeToasts();
      const card = prefs.locator('[data-key="Tresor"]');
      check((await card.innerText()).includes("With passphrase"), "the card shows \"With passphrase\"");
      await card.getByRole("button", { name: "Use as default" }).click();
      await waitToast(/“Tresor” is now the default key/, "success");
      const keys = await sshKeys();
      const vault = keys.find((key) => key.label === "Tresor");
      check(vault?.isDefault === true && keys.find((key) => key.label === "Messrechner")?.isDefault === false, "\"Tresor\" is default, \"Messrechner\" no longer");
      await shot("mustfix-ssh-two-keys");
      await closePrefs();

      // The server does not know the new key yet: ssh only offers the public part, the server rejects –
      // so the passphrase is never even asked for.
      const asked = (await credentialRequests()).length;
      await server.ready();
      await t.toolButton("Fetch").click();
      const unknown = await waitToast(/Fetch from “origin” failed/, "danger", 90_000);
      check(/Signing in/.test(unknown?.text ?? ""), `key without access: rejected understandably: ${unknown?.text}`);
      equal((await credentialRequests()).length, asked, "without access nobody asks for the passphrase");
      await t.closeToasts();

      // Authorised: now ssh needs the private key and asks for the passphrase.
      server.authorize(vault.publicKey);
      await server.ready();
      await t.toolButton("Fetch").click();
      const pass = await waitDialog(/^Passphrase for the SSH key$/, 60_000);
      equal((await t.focused()).label, "Passphrase", "focus is in the \"Passphrase\" field");
      check((await pass.innerText()).includes("id_ed25519_2"), "the prompt names the key file");
      equal((await credentialRequests()).at(-1)?.kind, "passphrase", "the core asked for the passphrase");
      await shot("mustfix-ssh-passphrase");
      // Wrong passphrase: ssh asks once more.
      await page.keyboard.type("falsch-geraten");
      await page.keyboard.press("Enter");
      await eventually(async () => (await credentialRequests()).length, asked + 2, "after the wrong passphrase ssh asks once more", 30_000);
      await waitDialog(/^Passphrase for the SSH key$/, 30_000);
      await eventually(() => t.focused().then((focus) => focus.label), "Passphrase", "focus is back in the field");
      // Cancel: the fetch ends without an error message.
      await page.keyboard.press("Escape");
      await eventually(() => page.locator('footer [role="progressbar"]').count(), 0, "cancelling the prompt ends the fetch", 30_000);
      await noErrorToast("a cancelled prompt is not an error");
      await t.closeToasts();

      // Correct passphrase, remember it.
      await server.ready();
      await t.toolButton("Fetch").click();
      const again = await waitDialog(/^Passphrase for the SSH key$/, 60_000);
      await page.keyboard.type(PASSPHRASE);
      const remember = again.getByRole("checkbox", { name: /Remember/ });
      const canRemember = (await remember.count()) === 1;
      check(canRemember, "\"Remember in the system keychain\" is offered");
      if (canRemember) await remember.click();
      await again.getByRole("button", { name: "Sign in" }).click();
      await waitToast(/Fetch complete/, "success", 60_000);
      equal(server.accepted().at(-1), vault.fingerprint, "the server accepted the sign-in with the passphrase key");
      await t.closeToasts();
      if (canRemember) {
        await eventually(async () => (await app.invoke("credentials_list")).map((entry) => entry.kind), ["passphrase"], "the passphrase is remembered (credentials_list, kind \"passphrase\")");
        const before = (await credentialRequests()).length;
        await server.ready();
        await t.toolButton("Fetch").click();
        await waitToast(/Fetch complete/, "success", 60_000);
        equal((await credentialRequests()).length, before, "the next fetch no longer asks for the passphrase");
        await t.closeToasts();
      }
      const log = JSON.stringify(await activity(repoId));
      check(!log.includes(PASSPHRASE) && !log.includes("falsch-geraten"), "the passphrase appears nowhere in the log");
    });

    await section("The server revokes access: auth_failed, understandably", async () => {
      server.revokeAll();
      await server.ready();
      await t.toolButton("Pull").waitFor();
      await t.toolButton("Fetch").click();
      const denied = await waitToast(/Fetch from “origin” failed/, "danger", 90_000);
      check(/Signing in to the server failed/.test(denied?.text ?? ""), `message: ${denied?.text}`);
      await sleep(200);
    });
  }
} catch (error) {
  t.check(false, `Aborted: ${error?.stack ?? error}`);
} finally {
  if (app) {
    await app.invoke("credentials_forget_all").catch((error) => t.check(false, `credentials_forget_all: ${error.message}`));
    await app.close();
  }
  await server?.close();
  source.cleanup();
  ws.cleanup();
}
t.finish();
