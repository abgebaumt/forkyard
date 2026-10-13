/**
 * F18 – set up SSH and clone over SSH: the cases no script under scripts/e2e/screens/ checks yet.
 * Real app against a REAL but local SSH server: the system's sshd as a user process on 127.0.0.1
 * (scripts/e2e/git-ssh-server.mjs). Without sshd only the sections that need no server run; the
 * others are listed as "not run".
 *
 *   node scripts/e2e/flows/A-F18.mjs [--show] [--only <part>[,<part>]]
 *
 * Already covered elsewhere and NOT repeated here: generating a key with field checks, adding an
 * existing one, file missing, removing, clipboard (settings.mjs); clone/fetch/push over SSH, rejecting/
 * accepting an unknown host, agent switch, wrong/right/remembered passphrase, revoked access,
 * closed port (mustfix-ssh.mjs).
 *
 * Isolation as there: own SSH folder (FORKYARD_SSH_DIR), own known_hosts, no ~/.ssh/config.
 *
 * Every section carries the number of its case. A red section marked "BUG A-…" is the test that
 * verifies the fix of the reported bug. At the end comes the list: green / red.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { findSshd, startGitSshServer } from "../git-ssh-server.mjs";
import { makeWorkspace } from "../screens/repo-entry-lib.mjs";
import { activeTab, checkA11y, closeRepoTabs, createFlowRun, denyWrite, showManagement, sleep, startSlowProxy } from "./A-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createFlowRun("A-F18", { argv });
const { check, equal, eventually, note, section } = t;

const PASSPHRASE = "Wölkchen über 🌧 Zürich";
const repoManagementScreen = '[data-screen="repo-management"]';
const ws = makeWorkspace("a-f18");
const sshDir = ws.dir("ssh-ordner");
const knownHosts = ws.at("known_hosts");
const target = ws.dir("Klone");
const source = makeCleanRepoWithRemote({ name: "messnetz-quelle" });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-a-f18-data-"));
const undo = [];
const proxies = [];

let server = null;
let serverProblem = null;
if (findSshd()) {
  try {
    server = await startGitSshServer();
    server.createBare("messnetz.git", { from: source.path });
  } catch (error) {
    serverProblem = String(error?.message ?? error).split("\n")[0];
  }
} else {
  serverProblem = "there is no sshd on this computer";
}
const needsServer = server ? null : `no local SSH server (${serverProblem})`;

let app = null;
let page = null;
const slash = (file) => path.resolve(file).replaceAll("\\", "/");
const start = async () => {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir, env: { FORKYARD_SSH_DIR: sshDir } });
  page = app.page;
  t.attach(app);
  // Own known_hosts, no ~/.ssh/config: the run does not touch the computer's SSH files.
  fs.appendFileSync(app.gitConfigPath, `[core]\n\tsshCommand = ssh -F none -o UserKnownHostsFile='${slash(knownHosts)}' -o GlobalKnownHostsFile=/dev/null\n`);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  await page.evaluate(() => {
    window.__afRequests = [];
    window.__gc.core.on("credential:request", (request) => window.__afRequests.push({ kind: request.kind, host: request.host }));
  });
};

const prefs = () => page.locator('[data-screen="settings"]');
const sshKeys = () => app.invoke("ssh_key_list");
const requests = () => page.evaluate(() => window.__afRequests.slice());
const knownHostsText = () => (fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, "utf8") : "");
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const agentSwitch = () => prefs().getByRole("switch", { name: "Use the system SSH agent" });
const openSshPrefs = async () => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("Control+Comma");
  await prefs().waitFor();
  await prefs().getByRole("tab", { name: "SSH keys" }).click();
  await prefs().getByRole("heading", { name: "SSH keys" }).waitFor();
  await app.settle();
};
const closePrefs = async () => {
  await t.closeToasts();
  for (let round = 0; round < 3 && (await prefs().count()); round++) {
    await page.keyboard.press("Escape");
    await sleep(200);
  }
  await prefs().waitFor({ state: "detached" });
};
const generateDialog = () => page.getByRole("dialog", { name: "Generate SSH key" });
const form = () => page.locator('[data-screen="clone"]');
const field = (label) => form().getByLabel(label, { exact: true });
const invalid = (label) => field(label).getAttribute("aria-invalid");
const errorOf = (label) => field(label).evaluate((input) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
const banner = () => form().locator("[data-clone-error]");
const bannerCode = async () => ((await banner().count()) ? banner().getAttribute("data-clone-error") : null);
const bannerText = async () => ((await banner().count()) ? (await banner().innerText()).replace(/\s+/g, " ") : "");
const openCloneDialog = async () => {
  await showManagement(app);
  await page.locator(repoManagementScreen).getByRole("button", { name: "Clone …" }).click();
  await form().waitFor();
};
const cloned = async (dir) => {
  const tab = await activeTab(app);
  return tab?.kind === "repo" && samePath(tab.path, dir);
};
const toolButton = (label) => page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: new RegExp(`^${label}`) }).first();
/** Presses Tab (or Shift+Tab) until the focused element satisfies `matches`. Keys only. */
const tabTo = async (matches, what, { max = 60, back = false } = {}) => {
  for (let step = 0; step <= max; step++) {
    if (await page.evaluate((source) => Boolean(new Function("el", `return (${source})(el)`)(document.activeElement)), matches.toString())) return true;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    await sleep(30);
  }
  return check(false, `${what}: not reached with ${max}× Tab (focus: ${JSON.stringify(await t.focused())})`);
};
const focusVisible = async (where) => check((await t.focused()).visible, `${where}: focus is visible (${JSON.stringify(await t.focused())})`);

try {
  await start();

  // -------------------------------------------------------------------------------------------
  await section("F18-E16a Screen reader: \"SSH keys\" section empty – names, roles, switch", async () => {
    await openSshPrefs();
    await prefs().locator('[data-state="empty"]').waitFor();
    await checkA11y(t, '[data-screen="settings"]', "SSH keys, empty");
    const sw = await agentSwitch().evaluate((node) => ({ role: node.getAttribute("role"), checked: node.getAttribute("aria-checked"), described: (node.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") }));
    equal([sw.role, sw.checked], ["switch", "true"], "the agent switch is a switch with state");
    check(/default key/.test(sw.described), "its explanation is linked via aria-describedby");
    await closePrefs();
  });

  // -------------------------------------------------------------------------------------------
  let firstKey = null;
  const cloneDir = path.join(target, "messnetz");
  await section("F18-H2 Whole flow with the keyboard only: generate key, default, agent off, copy, add to server, clone over SSH", async () => {
    const kb = page.keyboard;
    // 1. Preferences → SSH keys (Ctrl+Comma, arrow keys in the section list)
    await kb.press("Control+Comma");
    await prefs().waitFor();
    for (let step = 0; step < 16; step++) {
      const selected = await page.evaluate(() => document.querySelector('[data-screen="settings"] [role="tab"][aria-selected="true"]')?.textContent?.trim());
      if (selected === "SSH keys") break;
      await kb.press("ArrowDown");
      await sleep(120);
    }
    equal(await page.evaluate(() => document.querySelector('[data-screen="settings"] [role="tab"][aria-selected="true"]')?.textContent?.trim()), "SSH keys", "arrow keys select the \"SSH keys\" section");
    await prefs().locator('[data-state="empty"]').waitFor();
    // 2. Generate key
    await tabTo((el) => el?.textContent?.trim() === "Generate key", "\"Generate key\" button");
    await focusVisible("\"Generate key\"");
    await kb.press("Enter");
    await generateDialog().waitFor();
    await eventually(async () => (await t.focused()).label, "Label", "focus is in the \"Label\" field");
    await kb.type("Laptop Küche");
    await kb.press("Enter");
    await t.waitToast(/Key “Laptop Küche” generated/, "success", 60_000);
    firstKey = (await sshKeys())[0];
    check(Boolean(firstKey) && firstKey.hasPassphrase === false, "a key without passphrase was created");
    check(fs.existsSync(path.join(sshDir, "id_ed25519")) && fs.existsSync(path.join(sshDir, "id_ed25519.pub")), "both files are in the SSH folder");
    await eventually(async () => (await t.focused()).tag !== "BODY", true, "after the dialog focus is not lost", 4000);
    // 3. Use as default
    await tabTo((el) => el?.textContent?.trim() === "Use as default", "\"Use as default\" button");
    await focusVisible("\"Use as default\"");
    await kb.press("Enter");
    await eventually(async () => (await sshKeys())[0]?.isDefault, true, "the key is the default");
    // 4. Agent off (switch with Space). The "Use as default" button is gone after pressing it;
    // focus falls on the preferences frame – from there continue with Tab (wrapping around) to the switch.
    await eventually(async () => (await t.focused()).tag !== "BODY", true, "after \"Use as default\" focus is not lost", 4000);
    await tabTo((el) => el?.getAttribute("role") === "switch", "\"Use the system SSH agent\" switch");
    await focusVisible("agent switch");
    await kb.press("Space");
    await eventually(async () => (await app.invoke("settings_get")).sshUseAgent, false, "the agent is off (saved)");
    // 5. Copy the public key – and add exactly what was copied to the server
    await app.browser.contexts()[0].grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await tabTo((el) => el?.textContent?.trim() === "Copy public key", "\"Copy public key\" button");
    await kb.press("Enter");
    await t.waitToast(/Public key copied/, "success");
    const clipboard = await page.evaluate(() => Promise.race([navigator.clipboard.readText().catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), 2000))]));
    if (clipboard === null) note("clipboard not readable – adding the key from ssh_key_list");
    else equal(clipboard.trim(), firstKey.publicKey.trim(), "the clipboard holds the public key");
    server.authorize(clipboard ?? firstKey.publicKey);
    // 6. Close preferences (Esc; an open toast must not prevent this)
    for (let round = 0; round < 4 && (await prefs().count()); round++) {
      await kb.press("Escape");
      await sleep(250);
    }
    equal(await prefs().count(), 0, "Esc closes preferences");
    await eventually(async () => (await t.focused()).tag !== "BODY", true, "after closing focus is not lost", 4000);
    // 7. Clone over SSH
    await tabTo((el) => el?.textContent?.trim() === "Clone …", "\"Clone …\" button");
    await kb.press("Enter");
    await form().waitFor();
    await kb.type(server.url("messnetz.git"));
    equal(await form().locator("[data-url-kind]").getAttribute("data-url-kind"), "ssh", "the address is detected as SSH");
    await kb.press("Tab");
    await kb.press("Control+a");
    await kb.type(target);
    await server.ready();
    await kb.press("Enter");
    await t.waitDialog(/^Unknown SSH host$/, 60_000);
    equal((await t.focused()).text, "Cancel", "the prompt puts focus on \"Cancel\"");
    check((await page.locator('[role="dialog"], [role="alertdialog"]').last().innerText()).includes(server.hostFingerprint), "the prompt shows the server's fingerprint");
    await kb.press("Tab");
    equal((await t.focused()).text, "Trust host and connect", "Tab goes to \"Trust host and connect\"");
    await focusVisible("\"Trust host and connect\"");
    await kb.press("Enter");
    await eventually(() => cloned(cloneDir), true, "the clone opens in a tab", 90_000);
    equal(ws.git(cloneDir, "rev-parse", "HEAD"), server.git("messnetz.git", "rev-parse", "main"), "HEAD of the clone = main on the server");
    equal(ws.git(cloneDir, "remote", "get-url", "origin"), server.url("messnetz.git"), "origin is the SSH address");
    equal(server.accepted().at(-1), firstKey.fingerprint, "the server accepted the sign-in with exactly the generated key");
    check(knownHostsText().includes(`[127.0.0.1]:${server.port}`), "the host is in the (own) known_hosts file");
    await t.waitToast(/“messnetz” has been cloned/, "success");
  }, { skip: needsServer });

  // -------------------------------------------------------------------------------------------
  await section("F18-E15 Keyboard: with focus on the preferences frame, Tab AND Shift+Tab move on", async () => {
    // BUG A-12: after "Use as default" (the button disappears) focus is on the dialog frame;
    // Shift+Tab no longer moves it away from there.
    await openSshPrefs();
    await prefs().getByRole("button", { name: "Generate key" }).click();
    await generateDialog().waitFor();
    await generateDialog().getByLabel("Label").fill("Zweitschlüssel");
    await page.keyboard.press("Enter");
    await t.waitToast(/Key “Zweitschlüssel” generated/, "success", 60_000);
    await t.closeToasts();
    const button = prefs().locator('[data-key="Zweitschlüssel"]').getByRole("button", { name: "Use as default" });
    await button.focus();
    await page.keyboard.press("Enter");
    await eventually(async () => (await sshKeys()).find((key) => key.label === "Zweitschlüssel")?.isDefault, true, "\"Zweitschlüssel\" is the default");
    await sleep(400);
    const after = await t.focused();
    note(`focus after "Use as default": ${after.tag}${after.role ? `[${after.role}]` : ""} "${(after.label ?? after.text).slice(0, 40)}"`);
    check(after.tag !== "BODY", "focus is not lost");
    const inCard = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-key="Zweitschlüssel"]')));
    note(`focus stays in the key's card: ${inCard}`);
    // Forward
    await page.keyboard.press("Tab");
    const forward = await t.focused();
    check(forward.role !== "dialog" && forward.tag !== "BODY", `Tab moves from the frame to a control (${forward.tag} "${(forward.label ?? forward.text).slice(0, 30)}")`);
    // Back to the starting point: recreate the same state (first key default again, then back).
    if (after.role === "dialog") {
      await prefs().evaluate((node) => node.focus());
      const start = await t.focused();
      equal(start.role, "dialog", "starting point: focus is on the preferences frame");
      const way = [];
      for (let step = 0; step < 3; step++) {
        await page.keyboard.press("Shift+Tab");
        await sleep(60);
        const focus = await t.focused();
        way.push(`${focus.tag}${focus.role ? `[${focus.role}]` : ""}`);
      }
      const stuck = way.every((stop) => stop === "DIV[dialog]");
      if (stuck) await t.bugShot("A-12");
      check(!stuck, `Shift+Tab moves from the frame to the last control – after three Shift+Tab focus is on: ${way.join(" → ")}`);
    }
    // Make the first key the default again (the following sections rely on it).
    if (firstKey) await app.invoke("ssh_key_set_default", { id: firstKey.id });
    await closePrefs();
  }, { bug: "A-12" });

  // -------------------------------------------------------------------------------------------
  await section("F18-E3 Wrong SSH address format: detected and explained at the field", async () => {
    // BUG A-09: "ssh://git@host:gruppe/projekt.git", "ssh:/…" and port 99999 count as valid.
    await openCloneDialog();
    const wrong = [
      ["git@gc-test.invalid/gruppe/projekt.git", "slash instead of colon"],
      ["ssh://git@gc-test.invalid", "ssh:// without path"],
      ["git@gc-test.invalid:", "nothing after the colon"],
      ["git@:gruppe/projekt.git", "no server name"],
      ["ssh://git@gc test.invalid/projekt.git", "space in the server name"],
      ["ssh://git@gc-test.invalid:gruppe/projekt.git", "scp colon in an ssh:// address (instead of port or slash)"],
      ["ssh:/git@gc-test.invalid/gruppe/projekt.git", "only one slash after ssh:"],
      ["ssh://git@gc-test.invalid:99999/projekt.git", "port outside 1–65535"],
    ];
    const accepted = [];
    for (const [url, why] of wrong) {
      await field("Address").fill(url);
      const state = await invalid("Address");
      const badge = (await form().locator("[data-url-kind]").count()) ? await form().locator("[data-url-kind]").innerText() : null;
      if (state !== "true") accepted.push(`${url} (${why}) → counts as valid, badge "${badge}"`);
      else check(((await errorOf("Address")) ?? "").length > 10, `${url}: the reason is shown at the field (${await errorOf("Address")})`);
    }
    if (accepted.length) {
      await field("Address").fill("ssh://git@gc-test.invalid:gruppe/projekt.git");
      await t.bugShot("A-09");
    }
    equal(accepted, [], "every misspelled SSH address is rejected at the field");
    // Correctly written forms stay valid.
    for (const url of ["git@gc-test.invalid:gruppe/projekt.git", "ssh://git@gc-test.invalid/gruppe/projekt.git", "ssh://git@gc-test.invalid:2222/gruppe/projekt.git", "ssh://[::1]:2222/projekt.git"]) {
      await field("Address").fill(url);
      equal([await invalid("Address"), await form().locator("[data-url-kind]").getAttribute("data-url-kind")], [null, "ssh"], `valid: ${url}`);
    }
    await page.keyboard.press("Escape");
  }, { bug: "A-09" });

  await section("F18-E3b Wrong SSH address submitted: the refusal names the address as the cause, not the network", async () => {
    // Belongs to BUG A-09: because the field lets the address through, only ssh fails – with a message about the network.
    await openCloneDialog();
    await field("Address").fill("ssh://git@gc-test.invalid:gruppe/projekt.git");
    if ((await invalid("Address")) === "true") {
      check(true, "the field already rejects the address – nothing is submitted");
      await page.keyboard.press("Escape");
      return;
    }
    await field("Target folder").fill(target);
    await field("Folder name").fill("falsches-format");
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await eventually(async () => (await bannerCode()) !== null, true, "the app answers", 90_000);
    const text = await bannerText();
    note(`refusal [${await bannerCode()}]: ${text}`);
    check(/address|port|format|spelling/i.test(text) && !/^Server not reachable Check the network connection/.test(text), `the refusal points to the address (port/format), not the network connection: "${text}"`);
    check(!fs.existsSync(path.join(target, "falsches-format")), "no folder was created");
    await page.keyboard.press("Escape");
    app.consoleErrors.length = 0;
  }, { bug: "A-09" });

  // -------------------------------------------------------------------------------------------
  await section("F18-E7 Double Enter when generating: exactly one key, no error in the dialog", async () => {
    await openSshPrefs();
    const before = (await sshKeys()).length;
    const filesBefore = fs.readdirSync(sshDir).length;
    await prefs().getByRole("button", { name: "Generate key" }).click();
    await generateDialog().waitFor();
    await generateDialog().getByLabel("Label").fill("Doppelt");
    await generateDialog().getByLabel("Label").focus();
    await Promise.all([page.keyboard.press("Enter"), page.keyboard.press("Enter")]);
    await t.waitToast(/Key “Doppelt” generated/, "success", 60_000);
    await sleep(800);
    equal((await sshKeys()).filter((key) => key.label === "Doppelt").length, 1, "exactly one key \"Doppelt\"");
    equal((await sshKeys()).length, before + 1, "the list grew by exactly one entry");
    equal(fs.readdirSync(sshDir).length, filesBefore + 2, "exactly one pair of files was created");
    equal(await generateDialog().count(), 0, "the dialog is closed");
    equal((await t.toasts()).filter((toast) => toast.tone !== "success"), [], "no error toast");
    await closePrefs();
  });

  // -------------------------------------------------------------------------------------------
  await section("F18-E8 Esc while generating: nothing is created, preferences stay open", async () => {
    await openSshPrefs();
    const files = fs.readdirSync(sshDir).sort();
    const keys = (await sshKeys()).length;
    await prefs().getByRole("button", { name: "Generate key" }).click();
    await generateDialog().waitFor();
    await generateDialog().getByLabel("Label").fill("Verworfen");
    await generateDialog().getByLabel("Passphrase (optional)").fill("geheim-123");
    await page.keyboard.press("Escape");
    await generateDialog().waitFor({ state: "detached" });
    equal(await prefs().count(), 1, "Esc closes only the dialog, not preferences");
    equal(fs.readdirSync(sshDir).sort(), files, "nothing was created in the SSH folder");
    equal((await sshKeys()).length, keys, "the list is unchanged");
    await eventually(async () => (await t.focused()).text, "Generate key", "focus is back on \"Generate key\"", 4000);
    // Reopened, the dialog is empty – the passphrase too.
    await page.keyboard.press("Enter");
    await generateDialog().waitFor();
    equal([await generateDialog().getByLabel("Label").inputValue(), await generateDialog().getByLabel("Passphrase (optional)").inputValue()], ["", ""], "a new dialog starts empty");
    await page.keyboard.press("Escape");
    await generateDialog().waitFor({ state: "detached" });
    await closePrefs();
  });

  // -------------------------------------------------------------------------------------------
  let vault = null;
  await section("F18-E6 Emoji, umlauts and spaces in label, file name and passphrase; 100- and 500-character label", async () => {
    await openSshPrefs();
    const label = "Schlüssel für Zürich 🔑 – Büro";
    await prefs().getByRole("button", { name: "Generate key" }).click();
    await generateDialog().waitFor();
    await generateDialog().getByLabel("Label").fill(label);
    await generateDialog().getByLabel("File name").fill("id büro ü");
    await generateDialog().getByLabel("Passphrase (optional)").fill(PASSPHRASE);
    await generateDialog().getByLabel("Repeat passphrase").fill(PASSPHRASE);
    await generateDialog().getByRole("button", { name: "Generate key" }).click();
    await t.waitToast(/Key “Schlüssel für Zürich 🔑 – Büro” generated/, "success", 60_000);
    vault = (await sshKeys()).find((key) => key.label === label) ?? null;
    check(Boolean(vault) && vault.hasPassphrase === true, "the key with passphrase is in the list");
    check(fs.existsSync(path.join(sshDir, "id büro ü")) && fs.existsSync(path.join(sshDir, "id büro ü.pub")), "the files with a space and umlaut in the name are in the SSH folder");
    check((await prefs().locator(`[data-key="${label}"]`).innerText()).includes("With passphrase"), "the card shows \"With passphrase\"");
    await t.closeToasts();

    // Very long labels
    for (const length of [100, 500]) {
      const long = `B${"ä".repeat(length - 1)}`;
      await prefs().getByRole("button", { name: "Generate key" }).click();
      await generateDialog().waitFor();
      await generateDialog().getByLabel("Label").fill(long);
      await generateDialog().getByRole("button", { name: "Generate key" }).click();
      await eventually(async () => (await generateDialog().count()) === 0 || (await generateDialog().getByRole("alert").count()) > 0, true, `${length} characters: the app answers`, 60_000);
      if (await generateDialog().count()) {
        const text = (await generateDialog().getByRole("alert").allInnerTexts()).join(" ");
        note(`${length}-character label: rejected with "${text}"`);
        check(/too long|at most|characters/i.test(text), `${length} characters: the refusal names the length`);
        equal(await generateDialog().getByLabel("Label").getAttribute("aria-invalid"), "true", `${length} characters: the error is shown at the "Label" field`);
        const box = await generateDialog().boundingBox();
        check(box.x >= 0 && box.x + box.width <= 1440, `${length} characters: the dialog stays inside the window`);
        await page.keyboard.press("Escape");
        await generateDialog().waitFor({ state: "detached" });
      } else {
        note(`${length}-character label: accepted`);
        await t.closeToasts();
        const card = prefs().locator("[data-key]").filter({ hasText: long.slice(0, 40) }).first();
        const fit = await card.evaluate((node) => ({ inside: node.getBoundingClientRect().right <= node.closest('[data-screen="settings"]').getBoundingClientRect().right + 1, wide: Array.from(node.querySelectorAll("*")).filter((item) => item.getBoundingClientRect().right > node.getBoundingClientRect().right + 1).length }));
        equal(fit, { inside: true, wide: 0 }, `${length} characters: the card does not overflow`);
      }
    }
    equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    await closePrefs();
  });

  // -------------------------------------------------------------------------------------------
  await section("F18-E6b If the dialog says the label goes \"as a comment in the public key\", it is there", async () => {
    // BUG A-11: the profile's email is written as the comment, not the label.
    if (!check(Boolean(vault), "precondition: the key from F18-E6 was created")) return;
    await openSshPrefs();
    await prefs().getByRole("button", { name: "Generate key" }).click();
    await generateDialog().waitFor();
    const hint = (await generateDialog().innerText()).replace(/\s+/g, " ");
    const promised = /as a comment in the public key/.test(hint);
    note(`hint at the "Label" field: ${promised ? "\"… as a comment in the public key.\"" : "other text"}`);
    await page.keyboard.press("Escape");
    await generateDialog().waitFor({ state: "detached" });
    const comment = fs.readFileSync(path.join(sshDir, "id büro ü.pub"), "utf8").trim().split(/\s+/).slice(2).join(" ");
    note(`comment in the .pub file: "${comment}" – label: "${vault.label}"`);
    if (promised && comment !== vault.label) {
      await prefs().locator(`[data-key="${vault.label}"] pre`).scrollIntoViewIfNeeded();
      await t.bugShot("A-11");
    }
    check(!promised || comment === vault.label, `the comment in the public key is the label (got: "${comment}")`);
    await closePrefs();
  }, { bug: "A-11" });

  // -------------------------------------------------------------------------------------------
  await section("F18-E1b Passphrase with umlauts, spaces and emoji: the prompt accepts it, the clone succeeds", async () => {
    if (!check(Boolean(vault), "precondition: the key from F18-E6 was created")) return;
    await openSshPrefs();
    await prefs().locator(`[data-key="${vault.label}"]`).getByRole("button", { name: "Use as default" }).click();
    await eventually(async () => (await sshKeys()).find((key) => key.label === vault.label)?.isDefault, true, "the passphrase key is the default");
    if ((await app.invoke("settings_get")).sshUseAgent) await agentSwitch().click();
    await eventually(async () => (await app.invoke("settings_get")).sshUseAgent, false, "the agent is off");
    await closePrefs();
    server.authorize(vault.publicKey);
    await openCloneDialog();
    await field("Address").fill(server.url("messnetz.git"));
    await field("Target folder").fill(target);
    await field("Folder name").fill("mit-passphrase");
    const dir = path.join(target, "mit-passphrase");
    await server.ready();
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    // The host is known since F18-H2; only the passphrase is asked for.
    const pass = await t.waitDialog(/^(Passphrase for the SSH key|Unknown SSH host)$/, 60_000);
    if ((await t.dialogTitle()) === "Unknown SSH host") {
      await pass.getByRole("button", { name: "Trust host and connect" }).click();
      await t.waitDialog(/^Passphrase for the SSH key$/, 60_000);
    }
    check((await page.locator('[role="dialog"], [role="alertdialog"]').last().innerText()).includes("id büro ü"), "the prompt names the key file with umlaut and space");
    equal((await t.focused()).label, "Passphrase", "focus is in the \"Passphrase\" field");
    await page.keyboard.insertText(PASSPHRASE);
    await page.keyboard.press("Enter");
    await eventually(async () => (await cloned(dir)) || (await bannerCode()) !== null || (await t.dialogTitle()) === "Passphrase for the SSH key", true, "the app answers the passphrase", 90_000);
    if (!(await cloned(dir))) note(`after the passphrase: dialog "${await t.dialogTitle()}", banner [${await bannerCode()}] ${await bannerText()}`);
    await eventually(() => cloned(dir), true, "with the right passphrase (umlauts, emoji) the clone succeeds", 60_000);
    equal(server.accepted().at(-1), vault.fingerprint, "the server accepted the sign-in with the passphrase key");
    equal(ws.git(dir, "rev-parse", "HEAD"), server.git("messnetz.git", "rev-parse", "main"), "the clone is complete");
    const log = JSON.stringify(await app.invoke("activity_list", { scope: "app", repoId: null, cursor: null, limit: 200 }));
    check(!log.includes(PASSPHRASE), "the passphrase is not in the activity log");
    check(!(await page.content()).includes(PASSPHRASE), "nor anywhere in the page");
  }, { skip: needsServer });

  // -------------------------------------------------------------------------------------------
  await section("F18-E16b Screen reader: key list, \"Generate SSH key\" dialog with errors, prompts", async () => {
    await openSshPrefs();
    await prefs().locator("[data-key]").first().waitFor();
    await checkA11y(t, '[data-screen="settings"]', "SSH keys with entries");
    const list = await prefs().locator("ul[aria-labelledby]").evaluate((node) => (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim());
    check(/^Keys \(\d+\)$/.test(list), `the list has its name with count (${list})`);
    const pre = await prefs().locator("[data-key] pre").first().evaluate((node) => ({ label: node.getAttribute("aria-label"), tabindex: node.getAttribute("tabindex") }));
    check(/^Public key /.test(pre.label ?? "") && pre.tabindex === "0", "the key text is named and reachable by keyboard");
    await prefs().getByRole("button", { name: "Generate key" }).click();
    await generateDialog().waitFor();
    await generateDialog().evaluate((node) => node.setAttribute("data-a11y-scope", "generate"));
    await checkA11y(t, '[data-a11y-scope="generate"]', "\"Generate SSH key\" dialog");
    await generateDialog().getByLabel("Passphrase (optional)").fill("abc");
    await generateDialog().getByRole("button", { name: "Generate key" }).click();
    await eventually(() => generateDialog().getByLabel("Label").getAttribute("aria-invalid"), "true", "empty label is marked invalid");
    const linked = await generateDialog().getByLabel("Label").evaluate((input) => (input.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
    check(/label/.test(linked), `the error text is linked to the field (${linked})`);
    check((await generateDialog().getByRole("alert").count()) >= 1, "errors are announced as role=alert");
    equal(await generateDialog().getByLabel("Passphrase (optional)").getAttribute("type"), "password", "the passphrase is a password field");
    await page.keyboard.press("Escape");
    await generateDialog().waitFor({ state: "detached" });
    await closePrefs();
  });

  // -------------------------------------------------------------------------------------------
  await section("F18-E12 The server's host key has changed (fetch): no sign-in, no invitation to trust, the toast says so", async () => {
    if (!check(await cloned(path.join(target, "mit-passphrase")) || fs.existsSync(cloneDir), "precondition: there is a clone over SSH")) return;
    const repoDir = fs.existsSync(path.join(target, "mit-passphrase", ".git")) ? path.join(target, "mit-passphrase") : cloneDir;
    await app.openRepo(repoDir);
    // Put a foreign key under the same host name into known_hosts (this is what it looks like when someone intercepts).
    const other = ws.at("anderer-host-schluessel");
    const besideSshd = path.join(path.dirname(findSshd()), process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen");
    execFileSync(fs.existsSync(besideSshd) ? besideSshd : "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fremd", "-f", other], { stdio: "ignore", windowsHide: true });
    const otherKey = fs.readFileSync(`${other}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
    const original = knownHostsText();
    check(original.includes(`[127.0.0.1]:${server.port}`), "starting point: the host is known");
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${server.port} ${otherKey}\n`);
    const accepted = server.accepted().length;
    const asked = (await requests()).length;
    try {
      await server.ready();
      await toolButton("Fetch").click();
      const failed = await t.waitToast(/Fetch from “origin” failed/, "danger", 90_000);
      const text = failed?.text ?? "";
      note(`toast: ${text}`);
      equal(server.accepted().length, accepted, "the app did NOT sign in (ssh refused)");
      equal(fs.readFileSync(knownHosts, "utf8"), `[127.0.0.1]:${server.port} ${otherKey}\n`, "known_hosts is unchanged – nothing was silently replaced");
      equal((await requests()).slice(asked).filter((request) => request.kind === "host_key"), [], "no prompt inviting to trust");
      const says = /changed|(no longer|does not|doesn't) match|different key/i.test(text);
      check(says, `the toast says the server's key may have changed: "${text}"`);
      check(!/confirm it on the next attempt/.test(text), "it does not promise a prompt \"on the next attempt\" (that never comes for a changed key)");
    } finally {
      fs.writeFileSync(knownHosts, original);
    }
    await t.closeToasts();
    // Cross-check: with the right entry the fetch works again.
    await server.ready();
    await toolButton("Fetch").click();
    await eventually(async () => (await t.dialogTitle()) === "Passphrase for the SSH key" || (await t.toasts()).some((toast) => /Fetch complete/.test(toast.text)), true, "with the right entry the app connects again", 60_000);
    if ((await t.dialogTitle()) === "Passphrase for the SSH key") {
      await page.keyboard.insertText(PASSPHRASE);
      await page.keyboard.press("Enter");
      await t.waitToast(/Fetch complete/, "success", 60_000);
    }
    app.consoleErrors.length = 0;
  }, { skip: needsServer });

  await section("F18-E12b The host key has changed (clone): the dialog warns about the CHANGED key and says how to proceed", async () => {
    // BUG A-10: the clone dialog shows "SSH server not confirmed … confirm it on the next attempt" –
    // with a changed key a prompt never comes; the user goes round in circles.
    await closeRepoTabs(app);
    const other = ws.at("anderer-host-schluessel-2");
    const besideSshd = path.join(path.dirname(findSshd()), process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen");
    execFileSync(fs.existsSync(besideSshd) ? besideSshd : "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fremd", "-f", other], { stdio: "ignore", windowsHide: true });
    const otherKey = fs.readFileSync(`${other}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
    const original = knownHostsText();
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${server.port} ${otherKey}\n`);
    const accepted = server.accepted().length;
    try {
      await openCloneDialog();
      await field("Address").fill(server.url("messnetz.git"));
      await field("Target folder").fill(target);
      await field("Folder name").fill("host-geaendert");
      const texts = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const asked = (await requests()).length;
        await server.ready();
        await page.getByRole("button", { name: "Clone", exact: true }).click();
        await eventually(async () => (await bannerCode()) !== null || (await t.dialogTitle()) === "Unknown SSH host", true, `attempt ${attempt}: the app answers`, 90_000);
        equal((await requests()).slice(asked).filter((request) => request.kind === "host_key"), [], `attempt ${attempt}: no prompt inviting to trust`);
        texts.push(`[${await bannerCode()}] ${await bannerText()}`);
      }
      note(`refusal in the dialog (the same twice): ${texts[0]}`);
      equal(server.accepted().length, accepted, "the app did not sign in");
      check(!fs.existsSync(path.join(target, "host-geaendert")), "no folder was created");
      equal(fs.readFileSync(knownHosts, "utf8"), `[127.0.0.1]:${server.port} ${otherKey}\n`, "known_hosts is unchanged");
      const says = /changed|(no longer|does not|doesn't) match|different key/i.test(texts[0]);
      if (!says) await t.bugShot("A-10");
      check(says, `the dialog says the server's key has CHANGED: "${texts[0]}"`);
      check(!/confirm it on the next attempt/.test(texts[1]), "it does not promise a prompt \"on the next attempt\" – none came on the second attempt");
    } finally {
      fs.writeFileSync(knownHosts, original);
    }
    await page.keyboard.press("Escape");
    app.consoleErrors.length = 0;
  }, { bug: "A-10", skip: needsServer });

  // -------------------------------------------------------------------------------------------
  await section("F18-N1 Clone with a key without access: \"Sign-in rejected\" in the dialog, no folder", async () => {
    await closeRepoTabs(app);
    // The first key (without passphrase) becomes the default; afterwards the server knows none.
    await app.invoke("ssh_key_set_default", { id: firstKey.id });
    server.revokeAll();
    await openCloneDialog();
    await field("Address").fill(server.url("messnetz.git"));
    await field("Target folder").fill(target);
    await field("Folder name").fill("ohne-zugang");
    await server.ready();
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await eventually(bannerCode, "auth_failed", "the dialog shows auth_failed", 90_000);
    const text = await bannerText();
    check(/Sign-in rejected/.test(text) && /SSH key/.test(text), `clear sentence that names the SSH key: ${text}`);
    check(!fs.existsSync(path.join(target, "ohne-zugang")), "no folder was created");
    equal([await field("Address").inputValue(), await field("Folder name").inputValue()], [server.url("messnetz.git"), "ohne-zugang"], "the input is still there");
    // Access back: the same dialog, once more.
    server.authorize(firstKey.publicKey);
    await server.ready();
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await eventually(() => cloned(path.join(target, "ohne-zugang")), true, "with the key added the same clone succeeds", 90_000);
    app.consoleErrors.length = 0;
  }, { skip: needsServer });

  // -------------------------------------------------------------------------------------------
  await section("F18-E14 Slow network over SSH: 1.5 s connect, throttled – host prompt, clone complete", async () => {
    await closeRepoTabs(app);
    const slow = await startSlowProxy(server.port, { connectDelayMs: 1500, bytesPerSecond: 16_000 });
    proxies.push(slow);
    const url = `ssh://${server.user}@127.0.0.1:${slow.port}/messnetz.git`;
    await openCloneDialog();
    await field("Address").fill(url);
    await field("Target folder").fill(target);
    await field("Folder name").fill("langsam-ssh");
    const dir = path.join(target, "langsam-ssh");
    await server.ready();
    const started = Date.now();
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await form().locator("[data-clone-progress]").waitFor();
    check(await page.getByRole("button", { name: "Cancel clone" }).isEnabled(), "while waiting \"Cancel clone\" is usable");
    // The proxy has a different port: an unknown host for ssh.
    const ask = await t.waitDialog(/^Unknown SSH host$/, 60_000);
    check((await ask.innerText()).includes(server.hostFingerprint), "the prompt shows the real server's fingerprint");
    await ask.getByRole("button", { name: "Trust host and connect" }).click();
    await eventually(() => cloned(dir), true, "the clone over the slow line succeeds", 180_000);
    note(`clone over SSH through the slow proxy in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    check(Date.now() - started >= 2500, "the proxy really slowed things down");
    equal(ws.git(dir, "rev-parse", "HEAD"), server.git("messnetz.git", "rev-parse", "main"), "the clone is complete");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
  }, { skip: needsServer });

  // -------------------------------------------------------------------------------------------
  await section("F18-N3 No write access to the SSH folder: clear refusal in the dialog, no entry", async () => {
    await closeRepoTabs(app);
    await openSshPrefs();
    const keys = (await sshKeys()).length;
    const restore = denyWrite(sshDir);
    undo.push(restore);
    try {
      await prefs().getByRole("button", { name: "Generate key" }).click();
      await generateDialog().waitFor();
      await generateDialog().getByLabel("Label").fill("Darf nicht");
      await generateDialog().getByLabel("File name").fill("id_gesperrt");
      await generateDialog().getByRole("button", { name: "Generate key" }).click();
      await eventually(async () => (await generateDialog().getByRole("alert").count()) > 0 || (await generateDialog().count()) === 0 || (await t.toasts()).length > 0, true, "the app answers", 60_000);
      const text = `${(await generateDialog().count()) ? (await generateDialog().innerText()).replace(/\s+/g, " ") : ""} ${JSON.stringify(await t.toasts())}`;
      note(`answer without write access: ${text.slice(0, 400)}`);
      equal((await sshKeys()).length, keys, "no entry was created");
      check(!fs.existsSync(path.join(sshDir, "id_gesperrt")), "no key file was created");
      // BUG A-05: "ssh-keygen could not create the key." – without a reason, without "Show output".
      const explained = /access|permission|denied|read-only|not writable/i.test(text);
      if (!explained) await t.shot("target/e2e/bugs/A-05-ssh.png");
      check(explained, "the refusal names the missing access (or at least shows the output of ssh-keygen)");
      equal(await generateDialog().count(), 1, "the dialog stays open, the input is still there");
    } finally {
      restore();
      undo.splice(undo.indexOf(restore), 1);
    }
    if (await generateDialog().count()) {
      await generateDialog().getByRole("button", { name: "Generate key" }).click();
      await t.waitToast(/Key “Darf nicht” generated/, "success", 60_000);
    }
    await closePrefs();
    app.consoleErrors.length = 0;
  }, { bug: "A-05" });

  // -------------------------------------------------------------------------------------------
  await section("F18-E9 Restart: keys, default and agent switch are back", async () => {
    const before = (await sshKeys()).map((key) => [key.label, key.isDefault, key.hasPassphrase, key.fingerprint]);
    const agent = (await app.invoke("settings_get")).sshUseAgent;
    await app.close();
    await start();
    equal((await sshKeys()).map((key) => [key.label, key.isDefault, key.hasPassphrase, key.fingerprint]), before, "ssh_key_list unchanged after the restart");
    equal((await app.invoke("settings_get")).sshUseAgent, agent, "the agent switch is as before");
    await openSshPrefs();
    equal(await prefs().locator("[data-key]").count(), before.length, "the list shows all keys");
    equal(await agentSwitch().getAttribute("aria-checked"), String(agent), "the switch shows the saved state");
    const marked = await prefs().locator("[data-key]").evaluateAll((cards) => cards.filter((card) => /Default/.test(card.querySelector("div")?.textContent ?? "")).map((card) => card.getAttribute("data-key")));
    equal(marked, before.filter((key) => key[1]).map((key) => key[0]), "exactly the default key carries the badge");
    await closePrefs();
  });
} catch (error) {
  t.check(false, `aborted: ${error?.stack ?? error}`);
} finally {
  for (const restore of undo) {
    try {
      restore();
    } catch {
      // rights were already restored
    }
  }
  if (app) {
    await app.invoke("credentials_forget_all").catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  for (const proxy of proxies) await proxy.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  source.cleanup();
  ws.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
t.finish();
