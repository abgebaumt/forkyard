/**
 * hosts – host accounts (Settings › Hosts): connect, check, replace token, disconnect –
 * in the real app, against a LOCAL host (scripts/e2e/screens/host-lib.mjs, 127.0.0.1) in GitHub
 * and GitLab shape and against the core's test server (scripts/e2e/host-mock.mjs).
 * No call ever goes to a real service.
 *
 *   node scripts/e2e/screens/hosts.mjs                    everything (checks and screenshots)
 *   node scripts/e2e/screens/hosts.mjs --only disconnect  only sections whose title contains the word
 *   node scripts/e2e/screens/hosts.mjs --show             visible window
 *
 * Checked throughout: the token is in no screenshot (the field is a password field and is cleared
 * after submitting), not in the document, the query cache, the store, localStorage, the console or
 * any file in the app's data directory. The "keyboard only" section doesn't use the mouse.
 */
import { launchApp } from "../driver.mjs";
import { startHostMock } from "../host-mock.mjs";
import { finish, makeChecks } from "./files-lib.mjs";
import { SHOTS, escaping, filesContaining, focusedName, keychainEntries, keyringName, recordConsole, startHost, sweepKeychain, tabTo, tokenLeaks } from "./host-lib.mjs";
import { pageHelpers } from "./prefs-lib.mjs";

const show = process.argv.includes("--show");
const checks = makeChecks("hosts");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const github = await startHost({ kind: "github" });
const gitlab = await startHost({ kind: "gitlab", owner: "landesnetz/schulen" });
const coreMock = await startHostMock();
const TOKENS = [github.token, github.badToken, github.narrowToken, github.secondToken, gitlab.token, gitlab.badToken, coreMock.token, coreMock.weakToken];

sweepKeychain();
const KEYRING = keyringName("hosts");
const PREFS = '[data-screen="settings"]';
const HOSTS = '[data-screen="hosts"]';
const CONNECT = '[data-screen="hosts-connect"]';

let app = null;
try {
  app = await launchApp({ show, env: { FORKYARD_KEYRING_SERVICE: KEYRING } });
  state.app = app;
  const { page } = app;
  const h = pageHelpers(app);
  const consoleLines = recordConsole(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });

  const accounts = () => app.invoke("host_accounts");
  const hosts = page.locator(HOSTS);
  const dialog = page.locator(CONNECT);
  const tokenField = dialog.locator('input[name="token"]');
  const rowOf = (kind) => hosts.locator(`[data-account][data-kind="${kind}"]`);
  const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  const noLeak = async (token, where, options) => equal(await tokenLeaks(app, token, options), [], `the token appears nowhere in the UI (${where})`);
  const openIntegrations = async ({ keyboard = false } = {}) => {
    if ((await page.locator(PREFS).count()) === 0) {
      await page.keyboard.press("Control+,");
      await page.locator(PREFS).waitFor();
    }
    const selected = () => page.locator(`${PREFS} [role="tab"][aria-selected="true"]`).innerText();
    if (keyboard) {
      for (let step = 0; step < 16 && (await selected()) !== "Hosts"; step++) {
        const now = await selected();
        await page.keyboard.press("ArrowDown");
        await page.waitForFunction((before) => document.querySelector('[data-screen="settings"] [role="tab"][aria-selected="true"]')?.textContent?.trim() !== before, now, { timeout: 5000 }).catch(() => undefined);
      }
    } else {
      await page.getByRole("tab", { name: "Hosts", exact: true }).click();
    }
    await eventually(selected, "Hosts", "section \"Hosts\" is open");
    await hosts.waitFor();
    await app.settle();
  };
  const closePrefs = async () => {
    for (let round = 0; round < 4 && (await page.locator(PREFS).count()) > 0; round++) await page.keyboard.press("Escape");
    await eventually(() => page.locator(PREFS).count(), 0, "settings closed");
  };
  /** Fill in and submit the "Connect host account" dialog with the mouse. */
  const connectWithMouse = async (host, token, { open = true } = {}) => {
    if (open) await hosts.getByRole("button", { name: "Connect account …" }).first().click();
    await dialog.waitFor();
    await dialog.getByRole("radio", { name: host.kind === "github" ? "GitHub" : "GitLab", exact: true }).click();
    await dialog.getByRole("radio", { name: "Self-hosted" }).click();
    await dialog.locator('input[name="baseUrl"]').fill(host.base);
    await tokenField.fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  };
  state.resetView = async () => {
    // A dialog left open by an aborted section would block the next one.
    for (let round = 0; round < 3 && (await page.locator(`${CONNECT}, [role="alertdialog"]`).count()) > 0; round++) await page.keyboard.press("Escape");
    await h.closeToasts();
  };
  /** Wait two frames – that's how long a segmented control needs to move focus to the new choice. */
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));

  // -------------------------------------------------------------------------------------------
  await section("Empty: integrations without an account – opened by keyboard", async () => {
    equal(await accounts(), [], "initial state: no account");
    await openIntegrations({ keyboard: true });
    equal(await hosts.getAttribute("data-state"), "empty", "empty state");
    const text = await hosts.innerText();
    check(text.includes("No account connected yet"), "says nothing is connected");
    check(text.includes("Fetch, pull and push don't need an account here"), "and what an account is needed for (not fetch/push)");
    check(text.includes("is never shown here"), "and that the token is never shown");
    check(/Bitbucket/.test(text) && /Azure DevOps/.test(text), "names every supported host");
    equal(await escaping(page, HOSTS), [], "nothing sticks out of the section");
    await shot("hosts-empty");
  });

  // -------------------------------------------------------------------------------------------
  await section("Connect – keyboard only: guide, wrong token, right token", async () => {
    await openIntegrations({ keyboard: true });
    const before = github.requests.length;
    await tabTo(page, "Connect account …");
    await page.keyboard.press("Enter");
    await dialog.waitFor();
    await eventually(() => focusedName(page), "GitHub", "focus starts at the host choice");
    equal(await dialog.getByRole("radio").allInnerTexts(), ["GitHub", "GitLab", "Gitea/Forgejo", "Bitbucket", "Azure DevOps", "github.com", "Self-hosted"], "choices: every host, then the instance");

    // The guide says where the token is created and what it must be allowed to do – per host.
    const guide = dialog.locator("[data-token-guide]");
    let text = await guide.innerText();
    check(text.includes("Settings › Developer settings › Personal access tokens"), "GitHub: path to the token page");
    for (const permission of ["Pull requests: Read and write", "Contents: Read and write", "Commit statuses: Read", "repo"]) check(text.includes(permission), `GitHub: names "${permission}"`);
    await page.keyboard.press("ArrowRight");
    await eventually(() => guide.getAttribute("data-token-guide"), "gitlab", "arrow right chooses GitLab");
    await frames();
    text = await guide.innerText();
    check(text.includes("Access tokens"), "GitLab: path to the token page");
    check(text.includes("api") && text.includes("read_api is only enough for viewing"), "GitLab: names the api scope and why read_api is not enough");
    await shot("hosts-connect-gitlab");
    await page.keyboard.press("ArrowLeft");
    await eventually(() => guide.getAttribute("data-token-guide"), "github", "arrow left chooses GitHub again");
    await eventually(() => focusedName(page), "GitHub", "focus follows the choice");
    await frames();

    // Self-hosted: the address of the local host.
    await page.keyboard.press("Tab");
    await eventually(() => focusedName(page), "github.com", "Tab leads to the instance choice");
    await page.keyboard.press("ArrowRight");
    await eventually(() => focusedName(page), "Self-hosted", "arrow right chooses \"Self-hosted\"");
    await dialog.locator('input[name="baseUrl"]').waitFor();
    await frames();
    await page.keyboard.press("Tab");
    await eventually(() => focusedName(page), "Instance address", "then the address field");
    await page.keyboard.type(github.base);
    await tabTo(page, "Token");
    equal(await tokenField.getAttribute("type"), "password", "the token is in a password field");
    equal(await tokenField.getAttribute("autocomplete"), "off", "without autocomplete");

    // Wrong token.
    await page.keyboard.type(github.badToken);
    await noLeak(github.badToken, "while it is in the field", { allowField: true });
    await page.keyboard.press("Enter");
    const error = dialog.locator("[data-connect-error]");
    await error.waitFor();
    equal(await error.getAttribute("data-connect-error"), "auth", "wrong token: error shown in the dialog");
    check((await error.innerText()).includes("The host rejected the token"), `… with a clear text (${(await error.innerText()).replace(/\s+/g, " ")})`);
    equal(await tokenField.inputValue(), "", "the field is empty afterwards – the token is never shown again");
    equal(await focusedName(page), "Token", "focus is back in the token field");
    equal(await accounts(), [], "no account was created");
    equal((await toasts()).filter((toast) => toast.tone === "danger"), [], "without an extra error toast");
    await noLeak(github.badToken, "after the rejected attempt");
    const probe = github.requests.slice(before).find((entry) => entry.path === "/api/v3/user");
    equal([probe?.token, probe?.status], [github.badToken, 401], "the core checked the token against the API (GET /user → 401)");
    await shot("hosts-connect-error");

    // Right token.
    await page.keyboard.type(github.token);
    await shot("hosts-connect-typed");
    await page.keyboard.press("Enter");
    await eventually(() => dialog.count(), 0, "with the right token the dialog closes", 20_000);
    await eventually(() => hosts.getAttribute("data-state"), "filled", "the list shows the account");
    const row = rowOf("github");
    equal(await row.getAttribute("data-state"), "ok", "state: connected");
    const rowText = (await row.innerText()).replace(/\s+/g, " ");
    check(rowText.includes("Connected as Lena Hartmann"), `"Connected as <name>" (${rowText})`);
    check(rowText.includes(`Token ends in ${github.token.slice(-4)}`), "only the last four characters of the token");
    check(rowText.includes(github.base.replace("http://", "")), "the instance address");
    const [account] = await accounts();
    equal([account?.kind, account?.baseUrl, account?.user?.login, account?.scopesOk], ["github", github.base, "lena-hartmann", true], "the core keeps the account");
    check(!JSON.stringify(account).includes(github.token), "what the core returns does not contain the token");
    check((await toasts()).some((toast) => toast.tone === "success" && toast.text.includes("Connected to GitHub as Lena Hartmann")), "success toast");
    await noLeak(github.token, "after connecting");
    equal(filesContaining(app.dataDir, github.token), [], "the token is in no file of the data directory (SQLite, log)");
    if (process.platform === "win32") equal(keychainEntries(KEYRING).length, 1, "it is in the system keychain (one entry of this run in cmdkey)");
    equal(await focusedName(page), "Connect account …", "focus is back on the button that opened the dialog");
    await shot("hosts-filled");
  });

  // -------------------------------------------------------------------------------------------
  await section("Check, expired token, replace token, missing permissions", async () => {
    await openIntegrations();
    const row = rowOf("github");
    await row.getByRole("button", { name: /^Check / }).click();
    await until(async () => (await toasts()).some((toast) => toast.tone === "success" && /connected as Lena Hartmann/.test(toast.text)), "\"Check\" reports: connected as …");
    await h.closeToasts();

    // The token is revoked at the host – the app learns it on check.
    github.revoke(github.token);
    await row.getByRole("button", { name: /^Check / }).click();
    await eventually(() => row.getAttribute("data-state"), "expired", "state: token expired");
    const expired = (await row.innerText()).replace(/\s+/g, " ");
    check(expired.includes("Token expired"), `as a word on the row (${expired})`);
    check(/expired|revoked|invalid/.test(await row.locator("[data-account-detail]").innerText()), "with the reason below");
    check((await toasts()).some((toast) => toast.tone === "danger"), "and a toast that stays");
    check(Boolean((await accounts())[0]?.lastError), "the core remembers the error on the account");
    await noLeak(github.token, "not in the error toast either");
    await shot("hosts-expired");
    await h.closeToasts();

    // Replace: host and address are fixed, only the token is new.
    await row.getByRole("button", { name: /^Replace token for .*$/ }).click();
    await dialog.waitFor();
    equal(await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"]')).at(-1)?.querySelector("h2")?.textContent), "Replace token", "dialog \"Replace token\"");
    equal(await dialog.getByRole("radio").count(), 0, "without a host choice");
    await eventually(() => focusedName(page), "Token", "focus is in the token field");
    await page.keyboard.type(github.secondToken);
    await page.keyboard.press("Enter");
    await eventually(() => dialog.count(), 0, "the new token is accepted", 20_000);
    await eventually(() => row.getAttribute("data-state"), "ok", "the account is connected again");
    check((await row.innerText()).includes(`Token ends in ${github.secondToken.slice(-4)}`), "the row shows the end of the new token");
    equal((await accounts()).length, 1, "there is still one account for this address");
    await noLeak(github.secondToken, "after replacing");

    // A token with too few permissions.
    await h.closeToasts();
    await row.getByRole("button", { name: /^Replace token for .*$/ }).click();
    await dialog.waitFor();
    await tokenField.fill(github.narrowToken);
    await page.getByRole("button", { name: "Replace token", exact: true }).click();
    await eventually(() => dialog.count(), 0, "a token with too few permissions is stored too", 20_000);
    await eventually(() => row.getAttribute("data-state"), "scopes", "state: missing permissions");
    check((await row.innerText()).includes("Missing permissions"), "as a word on the row");
    check((await toasts()).some((toast) => toast.tone === "warning" && /missing permissions/.test(toast.text)), "the toast warns instead of reporting success");
    equal((await accounts())[0]?.missingScopes, ["repo"], "the core names the missing permission");
    await shot("hosts-scopes");
    await h.closeToasts();
    await row.getByRole("button", { name: /^Replace token for .*$/ }).click();
    await dialog.waitFor();
    await tokenField.fill(github.secondToken);
    await page.getByRole("button", { name: "Replace token", exact: true }).click();
    await eventually(() => row.getAttribute("data-state"), "ok", "connected again with the full token", 20_000);
  });

  // -------------------------------------------------------------------------------------------
  await section("Errors on connect: address, no server, no host, rate limit, token with spaces", async () => {
    await openIntegrations();
    await hosts.getByRole("button", { name: "Connect account …" }).first().click();
    await dialog.waitFor();
    await dialog.getByRole("radio", { name: "GitLab" }).click();
    await dialog.getByRole("radio", { name: "Self-hosted" }).click();
    const address = dialog.locator('input[name="baseUrl"]');
    const submit = page.getByRole("button", { name: "Connect", exact: true });
    const fieldError = () => dialog.getByRole("alert").allInnerTexts();
    const failure = dialog.locator("[data-connect-error]");

    await tokenField.fill(gitlab.token);
    await submit.click();
    await until(async () => (await fieldError()).join(" ").includes("Enter the instance address"), "empty address is reported at the field");
    equal(await tokenField.inputValue(), gitlab.token, "the token stays in the field (nothing was sent)");
    await address.fill("ftp://git.firma.example");
    await submit.click();
    await until(async () => (await fieldError()).join(" ").includes("https://"), "another protocol is rejected");
    await address.fill("http://git.firma.example");
    await submit.click();
    await until(async () => (await fieldError()).join(" ").includes("Unencrypted"), "http:// to another machine is rejected – the token would travel in plain text");
    equal(gitlab.requests.length, 0, "nothing went over the network so far");

    // No server at the address.
    await address.fill("http://127.0.0.1:9");
    await submit.click();
    await failure.waitFor({ timeout: 60_000 });
    check(["offline", "other", "not_found"].includes(await failure.getAttribute("data-connect-error")), `no server: error in the dialog (${await failure.getAttribute("data-connect-error")}: ${(await failure.innerText()).replace(/\s+/g, " ")})`);
    equal(await tokenField.inputValue(), "", "the token field is empty again");
    await noLeak(gitlab.token, "after the failed attempt");

    // A server that is not GitLab (here: the GitHub API).
    await address.fill(github.base);
    await tokenField.fill(gitlab.token);
    await submit.click();
    await until(async () => /No GitLab API|Check the address/.test(await failure.innerText().catch(() => "")), "wrong kind of server: the core says no GitLab API responds there", 20_000);

    // Rate limit already on connect.
    gitlab.set({ rateLimited: true });
    await address.fill(gitlab.base);
    await tokenField.fill(gitlab.token);
    await submit.click();
    await until(async () => (await failure.getAttribute("data-connect-error").catch(() => null)) === "rate_limit", "rate limit: own error in the dialog", 20_000);
    check(/limit/i.test(await failure.innerText()) && /\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/.test(await failure.innerText()), `… with the time from which it continues (${(await failure.innerText()).replace(/\s+/g, " ")})`);
    await shot("hosts-connect-rate-limit");
    gitlab.set({ rateLimited: false });

    // Token with a space in the middle (copied wrong).
    await tokenField.fill("glpat-halb kopiert");
    await submit.click();
    await until(async () => /spaces/.test(await failure.innerText().catch(() => "")), "a token with spaces is rejected with a clear text", 20_000);
    equal((await accounts()).map((account) => account.kind), ["github"], "no second account was created by all this");
    await page.keyboard.press("Escape");
    await eventually(() => dialog.count(), 0, "Esc closes the dialog");
  });

  // -------------------------------------------------------------------------------------------
  await section("GitLab shape: connect self-hosted instance, two accounts side by side", async () => {
    await openIntegrations();
    const before = gitlab.requests.length;
    await connectWithMouse(gitlab, gitlab.token);
    await eventually(() => dialog.count(), 0, "the dialog closes", 20_000);
    const row = rowOf("gitlab");
    await eventually(() => row.getAttribute("data-state"), "ok", "GitLab account connected");
    check((await row.innerText()).includes("Connected as Lena Hartmann"), "with name");
    const seen = gitlab.requests.slice(before).map((entry) => `${entry.method} ${entry.path}`);
    check(seen.includes("GET /api/v4/user") && seen.includes("GET /api/v4/personal_access_tokens/self"), `the core checks user and permissions via API v4 (${seen.join(", ")})`);
    check(gitlab.requests.slice(before).every((entry) => entry.token === gitlab.token), "every call carries the token in the Authorization header – nowhere else");
    check(gitlab.requests.slice(before).every((entry) => !entry.query.includes(gitlab.token) && !entry.path.includes(gitlab.token)), "never in the URL");
    equal((await accounts()).map((account) => account.kind).sort(), ["github", "gitlab"], "two accounts");
    equal(await hosts.locator("[data-account]").count(), 2, "both are in the list");
    await noLeak(gitlab.token, "after connecting to GitLab");
    equal(await escaping(page, HOSTS), [], "nothing sticks out of the section");
    await h.closeToasts();
    await shot("hosts-two");
  });

  // -------------------------------------------------------------------------------------------
  await section("Disconnect: confirmation with focus on \"Cancel\", cancel, confirm", async () => {
    await openIntegrations();
    const row = rowOf("gitlab");
    await row.getByRole("button", { name: /^Disconnect / }).click();
    const ask = page.getByRole("dialog", { name: "Disconnect GitLab account?" });
    await ask.waitFor();
    const text = await ask.innerText();
    check(text.includes("from your system keychain") && text.includes("The token stays valid at the host"), "the confirmation says what is deleted and what is not");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on \"Cancel\"");
    await shot("hosts-disconnect");
    await page.keyboard.press("Enter");
    await eventually(() => ask.count(), 0, "Enter cancels");
    equal((await accounts()).length, 2, "after cancelling both accounts are still there");

    await row.getByRole("button", { name: /^Disconnect / }).click();
    await ask.getByRole("button", { name: "Disconnect account", exact: true }).click();
    await eventually(async () => (await accounts()).map((account) => account.kind), ["github"], "the GitLab account is disconnected");
    await eventually(() => rowOf("gitlab").count(), 0, "and gone from the list");
    check((await toasts()).some((toast) => toast.tone === "success" && toast.text.includes("disconnected")), "success toast");
    if (process.platform === "win32") equal(keychainEntries(KEYRING).length, 1, "the system keychain holds only the entry of the remaining account");
  });

  // -------------------------------------------------------------------------------------------
  await section("Against the core test server (host-mock.mjs): GitHub and GitLab shape, too few permissions, 401", async () => {
    await openIntegrations();
    const mock = { base: coreMock.url };
    const address = coreMock.url.replace("http://", "");
    const rowAt = (kind) => hosts.locator(`[data-account][data-kind="${kind}"]`).filter({ hasText: address });

    // GitHub shape with a token lacking the needed permission.
    await connectWithMouse({ kind: "github", ...mock }, coreMock.weakToken);
    await eventually(() => dialog.count(), 0, "the dialog closes", 20_000);
    await eventually(() => rowAt("github").getAttribute("data-state"), "scopes", "GitHub shape, weak token: missing permissions");
    await h.closeToasts();
    await rowAt("github").getByRole("button", { name: /^Replace token for .*$/ }).click();
    await dialog.waitFor();
    await tokenField.fill(coreMock.token);
    await page.getByRole("button", { name: "Replace token", exact: true }).click();
    await eventually(() => rowAt("github").getAttribute("data-state"), "ok", "connected with the full token", 20_000);
    check((await rowAt("github").innerText()).includes("Connected as Lena Hartmann"), "as Lena Hartmann");
    const seen = coreMock.requests.filter((entry) => entry.path === "/api/v3/user");
    check(seen.length >= 2 && seen.every((entry) => /^Bearer /.test(entry.headers.authorization ?? "")), "the test server saw the check via /api/v3/user, with bearer token");

    // GitLab shape against the same server.
    await h.closeToasts();
    await connectWithMouse({ kind: "gitlab", ...mock }, coreMock.token);
    await eventually(() => dialog.count(), 0, "the dialog closes", 20_000);
    await eventually(() => rowAt("gitlab").getAttribute("data-state"), "ok", "GitLab shape connected");
    check(coreMock.requests.some((entry) => entry.path === "/api/v4/user"), "via /api/v4/user");

    // 401 from the test server on check.
    await h.closeToasts();
    coreMock.fail("unauthorized");
    await rowAt("gitlab").getByRole("button", { name: /^Check / }).click();
    await eventually(() => rowAt("gitlab").getAttribute("data-state"), "expired", "401 on check: token expired");
    coreMock.recover();
    await rowAt("gitlab").getByRole("button", { name: /^Check / }).click();
    await eventually(() => rowAt("gitlab").getAttribute("data-state"), "ok", "connected again afterwards");
    await h.closeToasts();

    // Clean up: disconnect both test server accounts again.
    for (const kind of ["gitlab", "github"]) {
      await rowAt(kind).getByRole("button", { name: /^Disconnect / }).click();
      await page.getByRole("button", { name: "Disconnect account", exact: true }).click();
      await eventually(() => rowAt(kind).count(), 0, `${kind} account of the test server disconnected`);
    }
    equal((await accounts()).map((account) => account.baseUrl), [github.base], "the account at the local host remains");
    await h.closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("States: loading, error with \"Try again\", no keychain", async () => {
    await openIntegrations();
    const broken = await h.breakQuery("hostAccounts", ["app", "hostAccounts"], "The accounts could not be read.");
    await eventually(() => hosts.getAttribute("data-state"), "loading", "state: loading");
    equal(await hosts.getByRole("status", { name: "Loading accounts" }).count(), 1, "skeleton with a name for screen readers");
    // No settle(): the query is hanging on purpose.
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/hosts-loading.png`);
    await broken.fail();
    await eventually(() => hosts.getAttribute("data-state"), "error", "state: error");
    check((await hosts.getByRole("alert").innerText()).includes("The accounts could not be loaded"), "says what failed");
    await shot("hosts-error");
    await broken.restoreAndPress(HOSTS, "Try again");
    await eventually(() => hosts.getAttribute("data-state"), "filled", "\"Try again\" loads the list");

    // Without a keychain no token can be stored: the section and the dialog say so.
    await page.evaluate(() => {
      const client = window.__gc.queryClient;
      client.setQueryData(["app", "info"], { ...client.getQueryData(["app", "info"]), keyringAvailable: false });
    });
    await eventually(() => hosts.locator('[data-state="no-keyring"]').count(), 1, "notice in the section: no keychain");
    await hosts.getByRole("button", { name: "Connect account …" }).first().click();
    await dialog.waitFor();
    check((await dialog.locator('[data-state="no-keyring"]').innerText()).includes("Without it, no account can be connected"), "and in the dialog");
    await shot("hosts-no-keyring");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const client = window.__gc.queryClient;
      client.setQueryData(["app", "info"], { ...client.getQueryData(["app", "info"]), keyringAvailable: true });
    });
  });

  // -------------------------------------------------------------------------------------------
  await section("Screenshots: light, 960×600; commands in the palette", async () => {
    await closePrefs();
    const commands = await page.evaluate(() => window.__gcUi.commands().filter((command) => command.id.startsWith("hosts.")).map((command) => `${command.id}:${command.available}`));
    equal(commands, ["hosts.open:true", "hosts.connect:true", "hosts.check:true"], "commands in the registry: open integrations, connect account, check accounts");
    await app.setTheme("light");
    await openIntegrations();
    await h.closeToasts();
    await shot("hosts-light");
    await app.setSize(960, 600);
    equal(await escaping(page, HOSTS), [], "960×600: nothing sticks out of the section");
    await shot("hosts-min-light");
    await hosts.getByRole("button", { name: "Connect account …" }).first().click();
    await dialog.waitFor();
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "960×600: the dialog fits, the page does not scroll horizontally");
    await tokenField.scrollIntoViewIfNeeded();
    check(await tokenField.isVisible(), "the token field is reachable in the small window (the dialog content scrolls)");
    await app.setTheme("dark");
    await shot("hosts-connect-min");
    await page.keyboard.press("Escape");
    await app.setSize(1440, 900);
    await closePrefs();
  });

  // -------------------------------------------------------------------------------------------
  await section("The token appears nowhere: UI, console, app files", async () => {
    for (const token of TOKENS) {
      equal(await tokenLeaks(app, token), [], `UI and storage: ${token.slice(0, 8)}…`);
      check(!consoleLines.some((line) => line.includes(token)), `console (all levels): ${token.slice(0, 8)}…`);
      equal(filesContaining(app.dataDir, token), [], `files in the data directory: ${token.slice(0, 8)}…`);
    }
    const log = await app.invoke("activity_list", { scope: "app", repoId: null, cursor: null, limit: 200 });
    const entries = log.entries ?? [];
    check(entries.some((entry) => /\/user\b/.test(`${entry.command} ${entry.output}`)), `the host calls are in the activity log (${entries.length} entries)`);
    check(!TOKENS.some((token) => JSON.stringify(entries).includes(token)), "without token");
  });
} catch (error) {
  check(false, `aborted: ${error?.stack ?? error}`);
  if (app) await app.screenshot("target/e2e/hosts-error.png").catch(() => undefined);
} finally {
  // The tokens are in the system keychain: disconnect accounts so nothing is left there.
  if (app) {
    for (const account of await app.invoke("host_accounts").catch(() => [])) await app.invoke("host_disconnect", { accountId: account.id }).catch(() => undefined);
  }
}
if (process.platform === "win32") equal(keychainEntries(KEYRING), [], "at the end no entry of this run is left in the system keychain");
if (app) await app.close().catch(() => undefined);
await Promise.all([github.close(), gitlab.close(), coreMock.close()]).catch(() => undefined);
await finish("hosts", checks, app, () => undefined);
