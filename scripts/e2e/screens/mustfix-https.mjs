/**
 * Proof of "Clone over HTTPS" and "HTTPS sign-in with remembered credentials and Forget all" in the
 * real app, against a real Git server (git http-backend behind a local HTTPS server with basic auth,
 * scripts/e2e/git-http-server.mjs).
 *
 *   node scripts/e2e/screens/mustfix-https.mjs [--show] [--no-shots] [--only <part>]
 *
 * Flows:
 * - Isolation: the machine's credential helper (credential.helper=manager in the system config of
 *   Git for Windows) has no effect on the app.
 * - Clone over https://127.0.0.1:<port>/… → username prompt → Cancel → "cancelled",
 *   no folder, no error message.
 * - Wrong password → auth_failed, understandable in the dialog, no folder.
 * - Correct password with "remember", keyboard only → clone succeeds, entry in the list.
 * - Second clone, fetch and push over HTTPS no longer ask (keychain).
 * - Server changes the password → the remembered entry is rejected (auth_failed) and forgotten.
 * - Preferences → Credentials shows the entry, "Forget all" removes it; afterwards the app asks again.
 * - At the end credentials_forget_all cleans up the keychain (even if something went wrong);
 *   `cmdkey /list` then shows no entry of this run any more.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../fixtures.mjs";
import { startGitHttpServer } from "../git-http-server.mjs";
import { appendAppGitConfig, createRun, slash } from "./mustfix-lib.mjs";
import { makeWorkspace } from "./repo-entry-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("mustfix-https", { argv });
const { check, equal, eventually, section, waitDialog, waitToast, noErrorToast, shot } = t;

const USER = "lena";
const PASSWORD = "Sonnen-Sensor-42";
const NEW_PASSWORD = "Regen-Messer-17";

const server = await startGitHttpServer({ users: { [USER]: PASSWORD }, tls: true });
const source = makeCleanRepoWithRemote({ name: "messnetz-quelle" });
const bare = server.createBare("messnetz.git", { from: source.path });
const ws = makeWorkspace("https");
const target = ws.dir("Klone");
const httpsUrl = server.url("messnetz.git");
const hostPort = `127.0.0.1:${server.port}`;

let app = null;
let page = null;

/** Entries in the Windows Credential Manager that belong to this run (host with port). */
const keychainEntries = () => {
  if (process.platform !== "win32") return [];
  const out = execFileSync("cmdkey", ["/list"], { windowsHide: true }).toString("utf8");
  return out.split(/\r?\n/).filter((line) => line.includes(hostPort));
};

const credentialRequests = async () => page.evaluate(() => window.__mfCredentialCount ?? 0);
const listCredentials = () => app.invoke("credentials_list");

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  page = app.page;
  t.attach(app);
  // The server has a self-signed certificate: the app (its Git) trusts exactly this one.
  appendAppGitConfig(app, `[http]\n\tsslCAInfo = ${slash(server.caFile)}\n\tsslBackend = openssl\n`);
  // Count every prompt from the core (regardless of whether a dialog becomes visible).
  await page.evaluate(() => {
    window.__mfCredentialCount = 0;
    window.__gc.core.on("credential:request", () => {
      window.__mfCredentialCount += 1;
    });
  });

  // Auto-fetch (default: every minute) would otherwise use up or discard remembered credentials mid-run;
  // it is checked separately in mustfix-sync.mjs.
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });

  const keyring = (await app.invoke("app_keyring_available")) === true;
  check(keyring, "the system keychain is available (otherwise \"remember\" cannot be checked)");

  const form = page.locator('[data-screen="clone"]');
  const field = (label) => form.getByLabel(label, { exact: true });
  const banner = () => form.locator("[data-clone-error]");
  const openCloneDialog = async () => {
    const tabs = await app.invoke("tabs_list");
    const management = tabs.find((tab) => tab.kind === "management");
    if (management) await app.invoke("tab_activate", { tabId: management.id });
    else await app.invoke("tab_open", { repoId: null });
    await page.locator('[data-screen="repo-management"]').waitFor();
    await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Clone …" }).click();
    await form.waitFor();
  };

  await section("Isolation: no credential helper from the machine", async () => {
    // Exactly the environment the driver starts the app with.
    let helper = "";
    try {
      helper = execFileSync("git", ["config", "--show-origin", "--get-all", "credential.helper"], {
        cwd: ws.root,
        env: { ...process.env, ...gitIsolationEnv(app.gitConfigPath) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
        .toString("utf8")
        .trim();
    } catch (error) {
      // Exit 1 = no value set: that is how it should be.
      check(error.status === 1, `git config failed unexpectedly: ${error.message}`);
    }
    equal(helper, "", "credential.helper is not set in the app's environment (the system config stays out)");
    equal(await listCredentials(), [], "nothing is remembered at the start");
  });

  await section("Clone over HTTPS: cancel the prompt", async () => {
    await openCloneDialog();
    await field("Address").fill(httpsUrl);
    equal(await form.locator("[data-url-kind]").getAttribute("data-url-kind"), "https", "the address is recognised as HTTPS");
    await field("Target folder").fill(target);
    await field("Folder name").fill("messnetz");
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    const user = await waitDialog(/^Username for the remote$/, 60_000);
    check((await user.innerText()).includes(hostPort), "the prompt names host and port");
    await shot("mustfix-https-username");
    await page.keyboard.press("Escape");
    await form.locator("[data-clone-cancelled]").waitFor({ timeout: 30_000 });
    check(!fs.existsSync(path.join(target, "messnetz")), "no folder was created");
    await noErrorToast("a cancelled sign-in is not an error message");
    equal(await field("Address").inputValue(), httpsUrl, "the inputs are still there");
  }, { keep: true });

  await section("Clone over HTTPS: wrong password → auth_failed", async () => {
    const before = server.requests.length;
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await waitDialog(/^Username for the remote$/, 60_000);
    await page.keyboard.type(USER);
    await page.keyboard.press("Enter");
    const password = await waitDialog(/^Sign in to the remote$/, 60_000);
    check((await password.innerText()).includes(`password for ${USER}`) || (await password.innerText()).includes(USER), "the prompt names the user");
    check((await password.getByText("Remember in the system keychain").count()) === (keyring ? 1 : 0), "\"remember\" exists exactly when there is a keychain");
    await shot("mustfix-https-password");
    await page.keyboard.type("falsch-geraten");
    await page.keyboard.press("Enter");
    await eventually(() => banner().getAttribute("data-clone-error"), "auth_failed", "the dialog shows auth_failed", 60_000);
    const text = (await banner().innerText()).replace(/\s+/g, " ");
    check(/Sign-in rejected/.test(text) && /credentials/.test(text), `understandable sentence: ${text}`);
    check(server.requests.slice(before).some((entry) => entry.rejected === USER), "the server rejected the wrong sign-in");
    check(!fs.existsSync(path.join(target, "messnetz")), "no folder was created");
    equal(await listCredentials(), [], "a rejected password is not remembered");
    await shot("mustfix-https-auth-failed");
  }, { keep: true });

  await section("Clone over HTTPS: correct password, \"remember\", keyboard only", async () => {
    const before = server.requests.length;
    // Focus in the address, Enter submits the form.
    await field("Address").focus();
    await page.keyboard.press("Enter");
    await waitDialog(/^Username for the remote$/, 60_000);
    await page.keyboard.type(USER);
    await page.keyboard.press("Enter");
    const password = await waitDialog(/^Sign in to the remote$/, 60_000);
    await page.keyboard.type(PASSWORD);
    if (keyring) {
      // Tab → "Show input" → Tab → "remember", Space ticks it; Tab → Cancel, Tab → Sign in.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      equal((await t.focused()).role, "checkbox", "Tab reaches the \"remember\" checkbox");
      await page.keyboard.press("Space");
      equal(await password.getByRole("checkbox", { name: /Remember/ }).getAttribute("aria-checked"), "true", "\"remember\" is ticked");
      await shot("mustfix-https-remember");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
    }
    await page.keyboard.press("Enter");
    await page.getByRole("tab", { name: /messnetz/ }).waitFor({ timeout: 90_000 });
    await form.waitFor({ state: "detached" });
    const cloned = path.join(target, "messnetz");
    check(fs.existsSync(path.join(cloned, ".git")), "the clone is on disk");
    equal(ws.git(cloned, "rev-parse", "HEAD"), ws.git(bare, "rev-parse", "main"), "HEAD of the clone = main on the server (git)");
    equal(ws.git(cloned, "remote", "get-url", "origin"), httpsUrl, "origin is the HTTPS address, without credentials in it");
    check(!fs.readFileSync(path.join(cloned, ".git", "config"), "utf8").includes(PASSWORD), "the password appears nowhere in .git/config");
    check(server.requests.slice(before).some((entry) => entry.user === USER && entry.status === 200), "the server accepted the sign-in");
    await waitToast(/“messnetz” has been cloned/, "success");
    if (keyring) {
      await eventually(async () => (await listCredentials()).map((entry) => ({ user: entry.username, kind: entry.kind, host: entry.host.includes(hostPort) })), [{ user: USER, kind: "password", host: true }], "the entry is remembered (credentials_list)");
      check(keychainEntries().length >= 1, `the system keychain has an entry for ${hostPort} (cmdkey)`);
    }
  });

  await section("Second clone, fetch and push over HTTPS no longer ask", async () => {
    if (!keyring) return check(false, "cannot be checked without a keychain");
    const askedBefore = await credentialRequests();
    // Second clone
    await openCloneDialog();
    await field("Address").fill(httpsUrl);
    await field("Target folder").fill(target);
    await field("Folder name").fill("messnetz-zwei");
    const before = server.requests.length;
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await page.getByRole("tab", { name: /messnetz-zwei/ }).waitFor({ timeout: 90_000 });
    equal(await credentialRequests(), askedBefore, "the second clone does not ask (user and password from the keychain)");
    check(server.requests.slice(before).some((entry) => entry.user === USER && entry.status === 200), "the server saw the remembered sign-in");
    check(fs.existsSync(path.join(target, "messnetz-zwei", ".git")), "the second clone is on disk");
    await t.closeToasts();

    // Fetch: there is a new commit on the server (pushed directly into the bare repo, without HTTP).
    ws.git(source.path, "checkout", "-q", "main");
    fs.writeFileSync(path.join(source.path, "neu-vom-server.md"), "Nachtrag auf dem Server.\n");
    ws.git(source.path, "add", "-A");
    ws.git(source.path, "commit", "-q", "-m", "Nachtrag auf dem Server");
    ws.git(source.path, "push", "-q", bare, "main");
    const serverHead = ws.git(bare, "rev-parse", "main");
    const repos = await app.invoke("repo_list");
    const second = repos.find((repo) => repo.path.toLowerCase().endsWith("messnetz-zwei"));
    await t.refresh(second.id);
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch complete/, "success", 60_000);
    equal(ws.git(path.join(target, "messnetz-zwei"), "rev-parse", "origin/main"), serverHead, "origin/main is up to date after the fetch over HTTPS (git)");
    equal(await credentialRequests(), askedBefore, "the fetch does not ask");
    await t.closeToasts();

    // Push over HTTPS
    const clone = path.join(target, "messnetz-zwei");
    ws.git(clone, "merge", "-q", "--ff-only", "origin/main");
    fs.writeFileSync(path.join(clone, "lokal.md"), "Vom Laptop gepusht.\n");
    ws.git(clone, "add", "-A");
    ws.git(clone, "commit", "-q", "-m", "Lokaler Commit über HTTPS");
    const local = ws.git(clone, "rev-parse", "HEAD");
    await t.refresh(second.id);
    await eventually(() => t.toolState("Push").then((state) => state.label), "Push, 1 commit to push", "Push shows the counter");
    await t.toolButton("Push").click();
    await waitToast(/Pushed to origin\/main/, "success", 60_000);
    equal(ws.git(bare, "rev-parse", "main"), local, "the commit is on the server (git in the bare repo)");
    equal(await credentialRequests(), askedBefore, "the push does not ask");
    check(server.requests.some((entry) => entry.path.endsWith("/git-receive-pack") && entry.method === "POST" && entry.user === USER && entry.status === 200), "the server accepted the push over HTTPS");
  });

  await section("Server changes the password: remembered entry is rejected and forgotten", async () => {
    if (!keyring) return check(false, "cannot be checked without a keychain");
    server.setPassword(USER, NEW_PASSWORD);
    const askedBefore = await credentialRequests();
    await t.toolButton("Fetch").click();
    const failed = await waitToast(/Fetch from “origin” failed/, "danger", 60_000);
    check(/Signing in|credentials|password/i.test(failed?.text ?? ""), `the message explains the rejected sign-in: ${failed?.text}`);
    equal(await credentialRequests(), askedBefore, "no prompt came up (data from the keychain)");
    await eventually(listCredentials, [], "the rejected entry is forgotten");
    await eventually(() => keychainEntries().length, 0, "and deleted from the system keychain (cmdkey)");
    await shot("mustfix-https-rejected");
    await t.closeToasts();

    // Sign in again, remember again.
    await t.toolButton("Fetch").click();
    await waitDialog(/^Username for the remote$/, 60_000);
    await page.keyboard.type(USER);
    await page.keyboard.press("Enter");
    const password = await waitDialog(/^Sign in to the remote$/, 60_000);
    await page.keyboard.type(NEW_PASSWORD);
    await password.getByRole("checkbox", { name: /Remember/ }).click();
    await password.getByRole("button", { name: "Sign in" }).click();
    await waitToast(/Fetch complete/, "success", 60_000);
    await eventually(async () => (await listCredentials()).length, 1, "the new entry is remembered");
  });

  await section("Preferences → Credentials: entry visible, \"Forget all\", afterwards the app asks again", async () => {
    if (!keyring) return check(false, "cannot be checked without a keychain");
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Control+Comma");
    const prefs = page.locator('[data-screen="settings"]');
    await prefs.waitFor();
    await prefs.getByRole("tab", { name: "Credentials" }).click();
    const table = prefs.getByRole("table");
    await table.waitFor();
    const rows = await table.locator("tbody tr").evaluateAll((list) => list.map((row) => Array.from(row.cells).map((cell) => cell.innerText.trim())));
    equal(rows.length, 1, "exactly one entry in the table");
    check(rows[0]?.[0]?.includes(hostPort) && rows[0]?.[1] === USER && /Password or token/.test(rows[0]?.[2] ?? ""), `host, user and type match: ${JSON.stringify(rows)}`);
    check(!(await prefs.innerText()).includes(NEW_PASSWORD), "the secret itself appears nowhere");
    await shot("mustfix-https-prefs");
    await app.setTheme("light");
    await shot("mustfix-https-prefs-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await shot("mustfix-https-prefs-min");
    equal(await t.overflow(), { x: 0, y: 0 }, "960x600: no overflow");
    await app.setSize(1440, 900);

    await prefs.getByRole("button", { name: "Forget all" }).click();
    const ask = await waitDialog(/^Forget the saved entry\?$/);
    equal((await t.focused()).text, "Cancel", "the confirmation puts focus on \"Cancel\"");
    await ask.getByRole("button", { name: "Forget all" }).click();
    await waitToast(/1 entry forgotten/, "success");
    await prefs.locator('[data-state="empty"]').waitFor();
    equal(await listCredentials(), [], "credentials_list is empty");
    await eventually(() => keychainEntries().length, 0, "the system keychain has no entry any more (cmdkey)");
    await shot("mustfix-https-prefs-empty");
    await t.closeToasts();
    await page.keyboard.press("Escape");
    await prefs.waitFor({ state: "detached" });

    const askedBefore = await credentialRequests();
    await t.toolButton("Fetch").click();
    await waitDialog(/^Username for the remote$/, 60_000);
    check((await credentialRequests()) > askedBefore, "after \"Forget all\" the app asks again");
    await page.keyboard.press("Escape");
    await eventually(() => page.locator('footer [role="progressbar"]').count(), 0, "cancelling the prompt ends the fetch");
    await noErrorToast("a cancelled prompt is not an error");

    // The activity log (activity-log) knows all calls of this run – but no password.
    const repos = await app.invoke("repo_list");
    const logs = [await app.invoke("activity_list", { scope: "app", repoId: null, cursor: null, limit: 200 })];
    for (const repo of repos) logs.push(await app.invoke("activity_list", { scope: "repo", repoId: repo.id, cursor: null, limit: 200 }));
    const everything = JSON.stringify(logs);
    check(/git (clone|fetch|push)/.test(everything), "the log contains the network calls");
    check(![PASSWORD, NEW_PASSWORD, "falsch-geraten"].some((secret) => everything.includes(secret)), "no password appears in the log");
  });
} catch (error) {
  t.check(false, `Aborted: ${error?.stack ?? error}`);
} finally {
  // Leave the machine's keychain clean – even after an error.
  if (app) {
    await app.invoke("credentials_forget_all").catch((error) => t.check(false, `credentials_forget_all: ${error.message}`));
    t.equal(keychainEntries(), [], "after the run nothing is left in the system keychain");
    await app.close();
  }
  await server.close();
  source.cleanup();
  ws.cleanup();
}
t.finish();
