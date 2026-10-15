/**
 * Bitbucket Cloud (v1.1): connect an account (e-mail + API token), pull requests (list, view,
 * comment, merge, decline, check out, create) and issues (list, read, filter, search, switched-off
 * tracker) – in the real app over WebDriver, against the core's host test server
 * (scripts/e2e/host-mock.mjs, 127.0.0.1). Nothing calls bitbucket.org.
 *
 *   node scripts/e2e-wd/features/bitbucket.mjs
 *   E2E_WD_ONLY=merge node scripts/e2e-wd/features/bitbucket.mjs
 *
 * The repositories are real: `origin` carries the test server's address (that is how the core finds
 * team/demo on "Bitbucket"), Git's transfers go to a local bare repository (url.<bare>.insteadOf,
 * scripts/e2e-wd/fixtures/bitbucket.mjs) – push, fetch and "check out pull request" really run.
 *
 * The connect dialog offers Bitbucket only as bitbucket.org (Cloud), so the core then calls
 * https://api.bitbucket.org/2.0. For the dialog scenarios the app's own network settings (proxy +
 * CA file) point at a local stand-in (startBitbucketCloudFront): it answers api.bitbucket.org with
 * a certificate of a test CA and forwards to the host mock, every other target gets 403. The test
 * checks that the settings took effect before anything is sent.
 *
 * Tokens land in a private, unlocked Secret Service of this test process (own D-Bus session bus +
 * gnome-keyring-daemon in a temp folder, fixtures/bitbucket.mjs) – never in the user's keyring;
 * every scenario still removes what is left there.
 */
import fs from "node:fs";
import path from "node:path";
import { startHostMock } from "../../e2e/host-mock.mjs";
import { ROOT } from "../driver.mjs";
import { clearKeychain, keychainItems, makeBitbucketRepo, startBitbucketCloudFront, startIssuesOffProxy, startPrivateSecretService } from "../fixtures/bitbucket.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const USER = "lena@example.org";
const PR_VIEW = '[data-screen="pr-view"]';
const CONNECT = '[data-screen="hosts-connect"]';
const HOSTS = '[data-screen="hosts"]';
const CONNECT_DIALOG = '[role="dialog"]:has([data-screen="hosts-connect"])';
const ISSUES = '[data-screen="issues"]';

// ---------------------------------------------------------------------------
// English UI texts straight from the locale files (no copies in the test)
// ---------------------------------------------------------------------------

const locales = new Map();
function str(key, vars = {}) {
  const [area, ...rest] = key.split(".");
  if (!locales.has(area)) locales.set(area, JSON.parse(fs.readFileSync(path.join(ROOT, "src", "i18n", "locales", "en", `${area}.json`), "utf8")));
  let value = locales.get(area);
  for (const part of rest) value = value?.[part];
  if (typeof value !== "string") throw new Error(`no English text for ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const basic = (user, token) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

/** Launch in English and light theme, without auto-fetch. */
async function start(t, options = {}) {
  const keyring = await startPrivateSecretService();
  if (!keyring) throw new Error("no private Secret Service (dbus-daemon + gnome-keyring-daemon needed)");
  const app = await t.launch({ width: 1440, height: 900, theme: "light", lang: "en", ...options, env: { ...keyring.env, ...(options.env ?? {}) } });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  return app;
}

/** Account at the test server, directly through the core (the dialog has its own scenarios). */
async function connectDirect(app, mock, { token = mock.token, baseUrl = mock.baseUrl("bitbucket") } = {}) {
  return app.invoke("host_connect", { kind: "bitbucket", baseUrl, token, username: USER });
}

/** Reload accounts, host info and pull requests as after a core event. */
async function refreshHost(app) {
  await app.exec(() => {
    const client = window.__gc.queryClient;
    return Promise.all([
      client.invalidateQueries({ queryKey: ["app", "hostAccounts"] }),
      client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" && ["hostRepo", "prs", "pr", "prTemplate", "issues", "issue"].includes(String(query.queryKey[2])) }),
    ]).then(() => true);
  });
  await app.settle();
}

/**
 * The connect dialog sends Bitbucket to bitbucket.org (api.bitbucket.org): route the app's network
 * through the local stand-in (proxy + own CA, fixtures/bitbucket.mjs) and make sure the settings
 * took effect before anything is sent – otherwise the call would leave the computer.
 */
async function useCloudFront(app, mock) {
  const cloud = await startBitbucketCloudFront(mock);
  const settings = await app
    .invoke("settings_set", { patch: { proxyUrl: cloud.proxyUrl, sslCaFile: cloud.caFile } })
    .then(() => app.invoke("settings_get"))
    .catch(async (error) => {
      await cloud.close();
      throw error;
    });
  const applied = settings?.proxyUrl === cloud.proxyUrl && settings?.sslCaFile === cloud.caFile;
  if (!applied) {
    await cloud.close();
    throw new Error(`proxy/CA settings not applied (${JSON.stringify({ proxyUrl: settings?.proxyUrl, sslCaFile: settings?.sslCaFile })}) – refusing to continue`);
  }
  return cloud;
}

/** A visible button (or element with role) by its text or aria-label, optionally inside `within`. */
async function button(app, label, { within = null, role = null, exact = true } = {}) {
  return app.exec(
    (wanted, scope, roleName, isExact) => {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      const norm = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const selector = roleName ? `[role="${roleName}"]` : 'button, [role="button"], [role="radio"], [role="tab"], [role="option"], [role="menuitem"]';
      for (const el of root.querySelectorAll(selector)) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const texts = [norm(el.innerText), norm(el.getAttribute("aria-label"))];
        if (texts.some((text) => (isExact ? text === wanted : text.includes(wanted)))) return el;
      }
      return null;
    },
    label,
    within,
    role,
    exact,
  );
}

/** The checkbox whose label starts with `label`. */
async function checkbox(app, label, within = null) {
  return app.exec(
    (wanted, scope) => {
      const root = scope ? document.querySelector(scope) : document;
      for (const el of root?.querySelectorAll("label[for]") ?? []) {
        if ((el.innerText ?? "").replace(/\s+/g, " ").trim().startsWith(wanted)) {
          const box = document.getElementById(el.htmlFor);
          if (box && box.getAttribute("role") === "checkbox") return box;
        }
      }
      return null;
    },
    label,
    within,
  );
}

async function clickButton(app, label, options = {}) {
  const el = await app.waitFor(() => button(app, label, options), options.timeout ?? 15_000, { message: `button "${label}"` });
  await app.click(el);
  return el;
}

/** Waits for an open dialog whose text contains `contains`, marks it `[data-e2e-top]` and returns it. */
const TOP = "[data-e2e-top]";
async function topDialog(app, contains, timeout = 10_000) {
  return app.waitFor(
    () =>
      app.exec((wanted) => {
        for (const el of document.querySelectorAll("[data-e2e-top]")) el.removeAttribute("data-e2e-top");
        const all = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((el) => (el.innerText ?? "").replace(/\s+/g, " ").includes(wanted));
        const top = all.at(-1);
        if (!top) return null;
        top.setAttribute("data-e2e-top", "1");
        return top;
      }, contains),
    timeout,
    { message: `dialog with "${contains}"` },
  );
}
const noDialogWith = (app, contains) =>
  app.exec((wanted) => ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((el) => (el.innerText ?? "").replace(/\s+/g, " ").includes(wanted)), contains);

/** Runs a palette command by its title (F1 opens the command palette). */
async function runCommand(app, title) {
  await app.press("F1");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, title);
  await app.waitFor(() => button(app, title, { within: '[data-screen="command-palette"]', role: "option", exact: false }), 10_000, { message: `palette entry "${title}"` });
  await app.press("Enter");
  await app.waitFor(async () => !(await app.$('[data-screen="command-palette"]')), 10_000, { message: "palette closed" });
}

async function toasts(app) {
  return app.exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
}

/** innerText of an element, spaces collapsed (WebDriver's element text skips some nodes). */
async function inner(app, el) {
  return app.exec((node) => (node?.innerText ?? "").replace(/\s+/g, " ").trim(), el);
}

/** Empties a field so that React sees it (native setter + input event). */
async function clearField(app, css) {
  await app.exec((selector) => {
    const field = document.querySelector(selector);
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(field, "");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, css);
}

async function text(app, css) {
  return app.exec((selector) => (document.querySelector(selector)?.innerText ?? "").replace(/\s+/g, " ").trim(), css);
}

async function setCenter(app, tabId, center) {
  await app.exec((id, next) => window.__gc.store.getState().setCenter(id, next), tabId, center);
}

async function openPr(app, tabId, number) {
  await setCenter(app, tabId, { kind: "pr", number });
  await app.waitFor(`${PR_VIEW}[data-pr-number="${number}"] [data-pr-head]`, 30_000);
  await app.settle();
}

async function phase(app) {
  return app.exec((view) => document.querySelector(`${view} [data-pr-head] [data-pr-phase]`)?.getAttribute("data-pr-phase") ?? null, PR_VIEW);
}

/** Polls `fn` until it returns `expected` (JSON comparison); returns the last value. */
async function eventually(app, fn, expected, message, timeout = 20_000) {
  let last;
  try {
    await app.waitFor(async () => {
      last = await fn();
      return JSON.stringify(last) === JSON.stringify(expected);
    }, timeout);
  } catch {
    assertEqual(last, expected, message);
  }
  return last;
}

/** Where does the token appear in the page? Document (incl. attributes and field values), storage. */
async function tokenInPage(app, token) {
  return app.exec((secret) => {
    const found = [];
    if (document.documentElement.outerHTML.includes(secret)) found.push("document");
    for (const field of document.querySelectorAll("input, textarea")) if (field.value.includes(secret)) found.push(`field ${field.name}`);
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) if ((store.getItem(store.key(i)) ?? "").includes(secret)) found.push(`storage ${store.key(i)}`);
    try {
      if (JSON.stringify(window.__gc.queryClient.getQueryCache().getAll().map((q) => q.state.data)).includes(secret)) found.push("query cache");
    } catch {
      // circular data: skip
    }
    return found;
  }, token);
}

function filesContaining(dir, needle) {
  const hits = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && fs.statSync(file).size < 50_000_000 && fs.readFileSync(file).includes(needle)) hits.push(path.relative(dir, file));
    }
  };
  walk(dir);
  return hits;
}

const prRows = (app) => app.exec(() => [...document.querySelectorAll('[data-extra-section="pull-requests"] [data-kind="pull-request"]')].map((row) => Number(row.dataset.pr)));
const issueRows = (app) => app.exec((view) => [...document.querySelectorAll(`${view} [data-issue-row]`)].map((row) => Number(row.getAttribute("data-issue-row"))), ISSUES);

/** Mock, repository, app with account and opened repository. */
async function setupRepo(t, { connect = true, remote = null, account = null } = {}) {
  const mock = await startHostMock();
  const repo = makeBitbucketRepo(remote ?? mock.remoteUrl("bitbucket"));
  let app = null;
  const cleanup = async () => {
    if (app) clearKeychain(app.keyringService);
    await mock.close().catch(() => undefined);
    repo.cleanup();
  };
  try {
    app = await start(t);
    if (connect) await connectDirect(app, mock, account ?? {});
    const opened = await app.openRepo(repo.path);
    await refreshHost(app);
    return { mock, repo, app, ...opened, cleanup };
  } catch (error) {
    // The scenario never gets the context: close the mock here, or its server keeps the process alive.
    await cleanup();
    throw error;
  }
}

// ===========================================================================
// Account
// ===========================================================================

scenario("connect a Bitbucket account in the dialog with account e-mail and API token", "main", async (t) => {
  const mock = await startHostMock();
  let app = null;
  let cloud = null;
  try {
    app = await start(t);
    cloud = await useCloudFront(app, mock);
    await runCommand(app, str("commands.hosts.connect.title"));
    await app.waitFor(CONNECT);
    t.step("connect dialog open (palette)");

    const radios = await app.exec((dialog) => [...document.querySelectorAll(`${dialog} [role="radio"]`)].map((el) => el.innerText.trim()), CONNECT);
    assertEqual(radios.slice(0, 5), ["GitHub", "GitLab", "Gitea/Forgejo", "Bitbucket", "Azure DevOps"], "host choice");
    await clickButton(app, "Bitbucket", { within: CONNECT, role: "radio" });
    await app.waitFor(`${CONNECT} [data-token-guide="bitbucket"]`);
    const radiosAfter = await app.exec((dialog) => [...document.querySelectorAll(`${dialog} [role="radio"]`)].map((el) => el.innerText.trim()), CONNECT);
    assertEqual(radiosAfter, ["GitHub", "GitLab", "Gitea/Forgejo", "Bitbucket", "Azure DevOps"], "Bitbucket: no instance choice (Cloud only)");
    assert(!(await app.$(`${CONNECT} input[name="baseUrl"]`)), "Bitbucket: no address field");
    assert(!(await app.$(`${CONNECT} [data-connect-gh]`)), "Bitbucket: no gh sign-in");
    const guide = await text(app, `${CONNECT} [data-token-guide]`);
    for (const piece of [str("hosts.guide.bitbucket.personal"), "write:pullrequest:bitbucket", "read:issue:bitbucket", "read:repository:bitbucket", str("hosts.guide.bitbucket.email")]) assertIncludes(guide, piece, "token guide");
    t.step("guide names API token, scopes and the e-mail");

    await app.type(`${CONNECT} input[name="username"]`, USER);
    const token = await app.waitFor(`${CONNECT} input[name="token"]`);
    assertEqual(await token.attr("type"), "password", "token field is a password field");
    await app.type(token, mock.token);
    const before = mock.requests.length;
    await clickButton(app, str("hosts.connect.submit"), { within: CONNECT_DIALOG });
    await app.waitFor(async () => !(await app.$(CONNECT)), 20_000, { message: "dialog closes after connecting" });
    t.step("connected");

    const probe = mock.requests.slice(before).find((entry) => entry.path === "/2.0/user");
    assert(probe, "the core checked the token at GET /2.0/user");
    assertEqual(probe.headers.authorization, basic(USER, mock.token), "Basic auth with e-mail and token");
    assert(cloud.connects.length > 0 && cloud.connects.every((entry) => entry.allowed), `only api.bitbucket.org was contacted, through the local stand-in (${JSON.stringify(cloud.connects)})`);
    assertIncludes(cloud.connects.map((entry) => entry.host), "api.bitbucket.org:443", "the core called Bitbucket Cloud's API");
    const [account, ...more] = await app.invoke("host_accounts");
    assertEqual(more.length, 0, "one account");
    assertEqual(account.baseUrl, "https://bitbucket.org", "account for Bitbucket Cloud");
    assertEqual([account.kind, account.username, account.user?.login, account.user?.name, account.scopesOk, account.tokenHint], ["bitbucket", USER, "lena", "Lena Hartmann", true, "…abcd"], "account in the core");
    assert(!JSON.stringify(account).includes(mock.token), "the account carries no token");
    const success = (await toasts(app)).find((toast) => toast.tone === "success");
    assert(success && success.text.includes("Bitbucket") && success.text.includes("Lena Hartmann"), `success toast (${JSON.stringify(await toasts(app))})`);
    assertEqual(keychainItems(app.keyringService).length, 1, "token stored in the Secret Service (one item)");

    await runCommand(app, str("commands.hosts.open.title"));
    const row = await app.waitFor(`${HOSTS} [data-account][data-kind="bitbucket"]`, 15_000);
    assertEqual(await row.attr("data-state"), "ok", "row state");
    const rowText = await inner(app, row);
    assertIncludes(rowText, str("hosts.state.connectedAs", { person: "Lena Hartmann" }), "row");
    assertIncludes(rowText, str("hosts.account.signIn", { name: USER }), "row shows the sign-in e-mail");
    assertIncludes(rowText, str("hosts.account.tokenEnds", { hint: "abcd" }), "only the last four characters");
    assertEqual(await tokenInPage(app, mock.token), [], "token nowhere in the page");
    assertEqual(filesContaining(app.dataDir, mock.token), [], "token in no file of the data directory");
    await t.shot("connect-account");
    await t.noConsoleErrors(app);
  } finally {
    if (app) clearKeychain(app.keyringService);
    await cloud?.close();
    await mock.close();
  }
});

scenario("connect dialog: missing or invalid e-mail and a rejected token create no account", "edge", async (t) => {
  const mock = await startHostMock();
  let app = null;
  let cloud = null;
  try {
    app = await start(t);
    cloud = await useCloudFront(app, mock);
    await runCommand(app, str("commands.hosts.connect.title"));
    await clickButton(app, "Bitbucket", { within: CONNECT, role: "radio" });
    await app.waitFor(`${CONNECT} input[name="username"]`);

    // No e-mail: the field says so, nothing goes out.
    await app.type(`${CONNECT} input[name="token"]`, mock.token);
    await clickButton(app, str("hosts.connect.submit"), { within: CONNECT_DIALOG });
    await app.waitFor(async () => (await text(app, CONNECT)).includes(str("actions.hosts.url.username")), 5_000, { message: "e-mail required" });
    assertEqual(await app.exec(() => document.activeElement?.getAttribute("name")), "username", "focus in the e-mail field");
    t.step("empty e-mail refused");

    // A colon would break Basic auth.
    await app.type(`${CONNECT} input[name="username"]`, "lena:hartmann");
    await clickButton(app, str("hosts.connect.submit"), { within: CONNECT_DIALOG });
    await app.waitFor(async () => (await text(app, CONNECT)).includes(str("actions.hosts.url.usernameInvalid")), 5_000, { message: "colon refused" });
    assertEqual(mock.requests.length, 0, "no request to the host for invalid input");
    assertEqual(cloud.connects.length, 0, "nothing sent towards Bitbucket");
    t.step("colon refused before any request");

    // Valid e-mail, wrong token.
    await clearField(app, `${CONNECT} input[name="username"]`);
    await clearField(app, `${CONNECT} input[name="token"]`);
    await app.type(`${CONNECT} input[name="username"]`, USER);
    const wrong = "ATATT3xFfGF0FalschesToken0000wxyz";
    await app.type(`${CONNECT} input[name="token"]`, wrong);
    await clickButton(app, str("hosts.connect.submit"), { within: CONNECT_DIALOG });
    const error = await app.waitFor(`${CONNECT} [data-connect-error]`, 20_000);
    assertEqual(await error.attr("data-connect-error"), "auth", "error kind");
    const probe = mock.requests.find((entry) => entry.path === "/2.0/user");
    assertEqual([probe?.headers.authorization, probe?.status], [basic(USER, wrong), 401], "the host saw the wrong token and refused it");
    assertEqual(await app.exec((dialog) => document.querySelector(`${dialog} input[name="token"]`).value, CONNECT), "", "token field cleared");
    assertEqual(await app.invoke("host_accounts"), [], "no account");
    assertEqual(keychainItems(app.keyringService), [], "nothing in the keychain");
    assertEqual(await tokenInPage(app, wrong), [], "the rejected token is nowhere in the page");
    await t.shot("connect-rejected-token");

    // Cancel with Escape: still nothing.
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$(CONNECT)), 5_000, { message: "Escape closes the dialog" });
    assertEqual(await app.invoke("host_accounts"), [], "still no account after cancelling");
    assert(cloud.connects.every((entry) => entry.allowed), "nothing but the stand-in was contacted");
    await t.noConsoleErrors(app);
  } finally {
    if (app) clearKeychain(app.keyringService);
    await cloud?.close();
    await mock.close();
  }
});

scenario("account: Data Center address refused, token without pull request scope flagged, disconnect deletes the token", "edge", async (t) => {
  const mock = await startHostMock();
  let app = null;
  try {
    app = await start(t);
    // Anything but bitbucket.org (or this computer) is refused before a request.
    const refused = await app.invoke("host_connect", { kind: "bitbucket", baseUrl: "https://bitbucket.firma.example", token: mock.token, username: USER }).then(
      () => null,
      (error) => error,
    );
    assert(refused, "a Data Center address must be refused");
    assertEqual(refused.code, "not_allowed", "error code");
    assertMatch(refused.message, /Bitbucket Cloud/, "message names Bitbucket Cloud");
    const missing = await app.invoke("host_connect", { kind: "bitbucket", baseUrl: mock.baseUrl("bitbucket"), token: mock.token, username: null }).then(
      () => null,
      (error) => error,
    );
    assert(missing, "no user name must be refused");
    assertEqual(mock.requests.length, 0, "no request for refused input");
    t.step(`refused: ${refused.code}, without user name: ${missing.code}`);

    // Token without pullrequest:write.
    const weak = await connectDirect(app, mock, { token: mock.weakToken });
    assertEqual([weak.scopesOk, weak.missingScopes], [false, ["pullrequest:write"]], "missing scope reported");
    await runCommand(app, str("commands.hosts.open.title"));
    const row = await app.waitFor(`${HOSTS} [data-account][data-kind="bitbucket"]`, 15_000);
    await app.waitFor(async () => (await row.attr("data-state")) === "scopes", 10_000, { message: "row shows missing permissions" });
    assertIncludes(await inner(app, row), str("hosts.state.scopes"), "row text");
    t.step("weak token flagged");

    // Replace the token with a good one through the UI.
    await clickButton(app, str("hosts.account.replace"), { within: `${HOSTS} [data-account][data-kind="bitbucket"]` });
    await app.waitFor(`${CONNECT} input[name="token"]`);
    assert(!(await app.$(`${CONNECT} input[name="username"]`)), "replacing keeps the e-mail (no field)");
    await app.type(`${CONNECT} input[name="token"]`, mock.token);
    const before = mock.requests.length;
    await clickButton(app, str("hosts.connect.replace"), { within: CONNECT_DIALOG });
    await app.waitFor(async () => !(await app.$(CONNECT)), 20_000, { message: "replace dialog closes" });
    await app.waitFor(async () => (await (await app.$(`${HOSTS} [data-account][data-kind="bitbucket"]`))?.attr("data-state")) === "ok", 10_000, { message: "row ok after replacing" });
    assertEqual(mock.requests.slice(before).find((entry) => entry.path === "/2.0/user")?.headers.authorization, basic(USER, mock.token), "new token sent with the kept e-mail");
    assertEqual(keychainItems(app.keyringService).length, 1, "still exactly one keychain item");
    t.step("token replaced");

    // Disconnect: confirm dialog, then the token is gone from the keychain.
    await clickButton(app, str("hosts.account.disconnect"), { within: `${HOSTS} [data-account][data-kind="bitbucket"]` });
    const confirm = await topDialog(app, str("actions.hosts.disconnect.title", { host: "Bitbucket" }));
    assertIncludes(await inner(app, confirm), str("actions.hosts.disconnect.body", { address: `127.0.0.1:${mock.port} (Lena Hartmann)` }).slice(0, 60), "confirmation names the account");
    await t.shot("disconnect-confirm");
    await clickButton(app, str("actions.hosts.disconnect.action"), { within: TOP });
    await app.waitFor(async () => (await app.exec((hosts) => document.querySelector(hosts)?.getAttribute("data-state"), HOSTS)) === "empty", 10_000, { message: "list empty after disconnecting" });
    assertEqual(await app.invoke("host_accounts"), [], "no account");
    assertEqual(keychainItems(app.keyringService), [], "token deleted from the keychain");
    await t.noConsoleErrors(app);
  } finally {
    if (app) clearKeychain(app.keyringService);
    await mock.close();
  }
});

// ===========================================================================
// Pull requests
// ===========================================================================

scenario("pull requests: sidebar list, view with checks and approval, comment reaches Bitbucket", "main", async (t) => {
  const ctx = await setupRepo(t);
  const { app, mock, tabId } = ctx;
  try {
    // Sidebar section (collapsed at first): open it.
    const header = await app.waitFor('[data-extra-section="pull-requests"] [data-section-header] button', 30_000);
    await app.waitFor(async () => /20\+/.test(await inner(app, header)), 20_000, { message: "counter 20+" });
    if ((await header.attr("aria-expanded")) !== "true") await app.click(header);
    const rows = await app.waitFor(async () => {
      const list = await prRows(app);
      return list.length === 20 ? list : null;
    }, 20_000, { message: "20 rows" });
    assertEqual(rows[0], 44, "most recently changed first");
    assert(rows.every((n) => n % 5 !== 0), `only open pull requests (${rows.join(",")})`);
    t.step(`sidebar: ${rows.length} open pull requests`);

    // A click opens the view.
    await app.click('[data-extra-section="pull-requests"] [data-pr="44"]');
    await app.waitFor(`${PR_VIEW}[data-pr-number="44"] [data-pr-head]`, 30_000);
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-title]`), "Thema 44 umsetzen", "title");

    // #1: passing check and approval.
    await openPr(app, tabId, 1);
    const head = await text(app, `${PR_VIEW} [data-pr-head]`);
    assertIncludes(head, "Thema 1 umsetzen #1", "title with number");
    assertEqual(await phase(app), "open", "phase");
    assertEqual(await app.exec((view) => document.querySelector(`${view} [data-checks]`)?.getAttribute("data-checks"), PR_VIEW), "passing", "checks passed (Bitbucket build status)");
    assertEqual(await text(app, `${PR_VIEW} [data-review]`), "Approved", "review state from the participants");
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-head]`), "feature/thema-1", "source branch");
    const conversation = await text(app, PR_VIEW);
    assertIncludes(conversation, "Sieht gut aus.", "comment from Bitbucket");
    assertIncludes(conversation, "Beschreibung zu Thema 1.", "description rendered (Markdown)");
    assert(!(await app.$(`${PR_VIEW} [data-pr-actions] button[disabled]`)), "all actions enabled on a mergeable, same-repository pull request");

    // Write a comment.
    const comment = "Danke – ich teste das morgen auf dem Messrechner.";
    await app.type(`${PR_VIEW} textarea[name="comment"]`, comment);
    await clickButton(app, str("pullRequest.view.commentSubmit"), { within: PR_VIEW });
    await app.waitFor(() => mock.state.comments.length === 1, 20_000, { message: "the test server has the comment" });
    assertEqual(mock.state.comments[0].content.raw, comment, "comment text as Bitbucket's content.raw");
    const posted = mock.requests.find((entry) => entry.method === "POST" && entry.path.endsWith("/pullrequests/1/comments"));
    assertEqual(posted?.body, { content: { raw: comment } }, "request body");
    assertEqual(posted?.headers.authorization, basic(USER, mock.token), "Basic auth");
    await app.waitFor(async () => (await app.exec((view) => document.querySelector(`${view} textarea[name="comment"]`)?.value, PR_VIEW)) === "", 10_000, { message: "comment field cleared" });
    await t.shot("pull-request-view");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("merge a pull request squashed and close its branch on Bitbucket", "main", async (t) => {
  const ctx = await setupRepo(t);
  const { app, mock, tabId } = ctx;
  try {
    await openPr(app, tabId, 6);
    await clickButton(app, str("pullRequest.view.mergeButton"), { within: PR_VIEW });
    const dialog = await topDialog(app, str("pullRequest.view.merge.title", { number: 6 }));
    // Bitbucket: merge commit and squash, no rebase.
    const combo = await app.waitFor(() => dialog.$('[role="combobox"]'), 5_000, { message: "method choice" });
    await app.click(combo);
    const options = await app.waitFor(async () => {
      const list = await app.exec(() => [...document.querySelectorAll('[role="option"]')].map((el) => el.innerText.trim()));
      return list.length ? list : null;
    }, 5_000, { message: "method options" });
    assertEqual(options, ["Merge commit", "Squash"], "methods on Bitbucket");
    await clickButton(app, "Squash", { role: "option" });
    const box = await app.waitFor(() => dialog.$('[role="checkbox"]'), 5_000, { message: "delete branch checkbox" });
    if ((await box.attr("aria-checked")) !== "true") await app.click(box);
    assertIncludes(await inner(app, dialog), str("pullRequest.view.merge.deleteBranch", { branch: "feature/thema-6" }), "delete branch option");
    await t.shot("merge-pull-request-squash");
    await clickButton(app, str("pullRequest.view.merge.submit"), { within: TOP });

    await app.waitFor(() => mock.state.merged.has(6), 20_000, { message: "the test server merged #6" });
    const merge = mock.requests.find((entry) => entry.method === "POST" && entry.path.endsWith("/pullrequests/6/merge"));
    assertEqual([merge?.body?.merge_strategy, merge?.body?.close_source_branch], ["squash", true], "merge request body (merge_strategy, close_source_branch)");
    await eventually(app, () => phase(app), "merged", "view shows merged");
    assert(!(await button(app, str("pullRequest.view.mergeButton"), { within: PR_VIEW })), "no merge button any more");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("decline a pull request (Bitbucket cannot reopen it)", "main", async (t) => {
  const ctx = await setupRepo(t);
  const { app, mock, tabId } = ctx;
  try {
    await openPr(app, tabId, 9);
    await clickButton(app, str("pullRequest.view.closeButton"), { within: PR_VIEW });
    await topDialog(app, str("actions.pullrequests.close.title", { number: 9 }));
    // Cancel first: nothing happens.
    await app.press("Escape");
    await app.waitFor(() => noDialogWith(app, str("actions.pullrequests.close.title", { number: 9 })), 5_000, { message: "Escape cancels" });
    assert(!mock.requests.some((entry) => entry.path.endsWith("/decline")), "cancel sends nothing");
    await clickButton(app, str("pullRequest.view.closeButton"), { within: PR_VIEW });
    await topDialog(app, str("actions.pullrequests.close.title", { number: 9 }));
    await clickButton(app, str("actions.pullrequests.close.action"), { within: TOP });
    await app.waitFor(() => mock.state.closed.has(9), 20_000, { message: "the test server declined #9" });
    assert(mock.requests.some((entry) => entry.method === "POST" && entry.path.endsWith("/pullrequests/9/decline")), "POST …/decline");
    await eventually(app, () => phase(app), "closed", "view shows closed");
    await app.settle();
    assert(!(await button(app, str("pullRequest.view.reopen"), { within: PR_VIEW })), "no Reopen on Bitbucket (prReopen: false)");
    assert(!(await button(app, str("pullRequest.view.closeButton"), { within: PR_VIEW })), "no Close any more");
    await t.shot("decline-pull-request");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("check out the branch of a pull request", "main", async (t) => {
  const ctx = await setupRepo(t);
  const { app, repo, tabId } = ctx;
  try {
    assertEqual(repo.git("branch", "--list", "feature/login"), "", "no local branch before");
    await openPr(app, tabId, 7);
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-head]`), "feature/login", "source branch feature/login");
    await clickButton(app, str("pullRequest.view.files.checkout"), { within: PR_VIEW });
    await app.waitFor(() => repo.git("branch", "--show-current") === "feature/login", 30_000, { message: "feature/login checked out" });
    assertEqual(repo.git("rev-parse", "HEAD"), repo.loginHead, "HEAD = the branch on the remote");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "feature/login@{upstream}"), "origin/feature/login", "tracks origin/feature/login");
    assertEqual(repo.git("status", "--porcelain"), "", "clean working tree");
    await app.waitFor(async () => (await text(app, "footer, [data-statusbar]")).includes("feature/login") || (await app.exec(() => document.body.innerText.includes("feature/login"))), 10_000);
    await app.settle();
    await t.shot("checkout-pull-request");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("create a pull request from a new local branch: push and create in one step", "main", async (t) => {
  const ctx = await setupRepo(t);
  const { app, mock, repo } = ctx;
  try {
    repo.git("checkout", "-q", "-b", "feature/bericht");
    repo.write("bericht.md", "# Monatsbericht\n\nMittelwerte der drei Stationen.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Monatsbericht als Markdown");
    const head = repo.git("rev-parse", "HEAD");
    await app.invoke("status_get", { repoId: ctx.repoId }).catch(() => undefined);
    await refreshHost(app);

    await runCommand(app, str("commands.pr.create.title"));
    const form = await app.waitFor('[data-screen="pr-create"] [data-pr-state="form"]', 30_000);
    await app.waitFor(async () => (await button(app, str("pullRequest.create.pushAndCreate"), { within: '[data-screen="pr-create"]' })) !== null, 15_000, { message: "button push and create" });
    assert(!(await form.$('input[name="reviewers"]')), "no reviewers field on Bitbucket");
    assert(!(await form.$('input[name="labels"]')), "no labels field on Bitbucket");
    assert(await checkbox(app, str("pullRequest.create.draft"), '[data-screen="pr-create"]'), "draft checkbox on Bitbucket");
    const title = await app.waitFor('[data-screen="pr-create"] input[name="title"]');
    await app.exec((el) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, title);
    await app.type(title, "Monatsbericht für das Messnetz");
    await app.type('[data-screen="pr-create"] textarea[name="body"]', "Fasst die **Mittelwerte** zusammen.");
    await t.shot("create-pull-request-form");
    await clickButton(app, str("pullRequest.create.pushAndCreate"), { within: '[data-screen="pr-create"]' });

    await app.waitFor(`${PR_VIEW}[data-pr-number="101"] [data-pr-head]`, 45_000);
    assertEqual(repo.bare("rev-parse", "refs/heads/feature/bericht"), head, "the branch was pushed to the remote");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "feature/bericht@{upstream}"), "origin/feature/bericht", "with upstream");
    const posted = mock.requests.find((entry) => entry.method === "POST" && entry.path.endsWith("/pullrequests"));
    assert(posted, "POST …/pullrequests");
    assertEqual(
      [posted.body.title, posted.body.description, posted.body.source?.branch?.name, posted.body.destination?.branch?.name, Boolean(posted.body.draft)],
      ["Monatsbericht für das Messnetz", "Fasst die **Mittelwerte** zusammen.", "feature/bericht", "main", false],
      "Bitbucket request body",
    );
    assert(!("reviewers" in posted.body) || (Array.isArray(posted.body.reviewers) && posted.body.reviewers.length === 0), "no reviewers sent");
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-title]`), "Monatsbericht für das Messnetz", "the view shows the new pull request");
    await app.settle();
    await t.shot("create-pull-request-created");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("pull requests: fork cannot be checked out, conflicts block merging, duplicate refused, 401 and rate limit", "edge", async (t) => {
  const ctx = await setupRepo(t);
  const { app, mock, repo, tabId } = ctx;
  try {
    // #8 comes from a fork: no branch Bitbucket offers for it.
    await openPr(app, tabId, 8);
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-head]`), str("pullRequest.view.fromFork"), "marked as fork");
    const checkout = await button(app, str("pullRequest.view.files.checkout"), { within: PR_VIEW });
    assert(checkout, "checkout button");
    assertEqual(await checkout.prop("disabled"), true, "checkout disabled for a fork");
    assertIncludes(await checkout.attr("title"), "Bitbucket offers no branch", "with the reason");
    const viaCore = await app.invoke("pr_checkout", { repoId: ctx.repoId, number: 8, remote: null }).then(() => null, (error) => error);
    assertEqual(viaCore?.code, "host_unsupported", "the core refuses as well");
    assertEqual(repo.git("branch", "--show-current"), "main", "still on main");
    t.step("fork: checkout blocked");

    // #13 has conflicts.
    await openPr(app, tabId, 13);
    await app.waitFor(`${PR_VIEW} [data-merge-blocked]`, 10_000);
    assertIncludes(await text(app, `${PR_VIEW} [data-merge-blocked]`), "conflict", "merge blocked with the reason");
    assertEqual(await (await button(app, str("pullRequest.view.mergeButton"), { within: PR_VIEW })).prop("disabled"), true, "merge disabled");
    await t.shot("merge-blocked-conflicts");

    // 401 and rate limit while viewing.
    await openPr(app, tabId, 1);
    mock.fail("unauthorized");
    await clickButton(app, "Refresh", { within: PR_VIEW });
    const stale = await app.waitFor(`${PR_VIEW} [data-pr-stale]`, 20_000);
    assertEqual(await stale.attr("data-pr-stale"), "auth", "401: token rejected notice");
    assertIncludes(await text(app, PR_VIEW), "Thema 1 umsetzen", "the last loaded state stays visible");
    mock.recover();
    mock.fail("rate_limit");
    await clickButton(app, "Refresh", { within: PR_VIEW });
    await app.waitFor(async () => (await (await app.$(`${PR_VIEW} [data-pr-stale]`))?.attr("data-pr-stale")) === "rate_limit", 20_000, { message: "429: rate limit notice" });
    mock.recover();
    // The account may have been marked as expired by the 401: a check repairs it.
    await app.invoke("host_check", { accountId: (await app.invoke("host_accounts"))[0].id });
    await refreshHost(app);
    await clickButton(app, "Refresh", { within: PR_VIEW });
    await app.waitFor(async () => !(await app.$(`${PR_VIEW} [data-pr-stale]`)), 20_000, { message: "notice gone after recovery" });
    t.step("401 and 429 shown, recovered");

    // Duplicate: Bitbucket refuses a second pull request for "schon-da".
    repo.git("checkout", "-q", "-b", "schon-da", "main");
    repo.write("schon-da.md", "# Schon da\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Schon da");
    repo.git("push", "-q", "-u", "origin", "schon-da");
    await setCenter(app, tabId, { kind: "pr_create", source: "schon-da" });
    await app.waitFor('[data-screen="pr-create"] input[name="title"]', 30_000);
    await app.waitFor(async () => (await button(app, str("pullRequest.create.title"), { within: '[data-screen="pr-create"] footer' })) !== null, 15_000, { message: "create button" });
    await clickButton(app, str("pullRequest.create.title"), { within: '[data-screen="pr-create"] footer' });
    const failure = await app.waitFor('[data-screen="pr-create"] [data-pr-error]', 20_000);
    const reason = await inner(app, failure);
    assertMatch(reason, /already an open pull request/i, "duplicate explained at the form");
    assertIncludes(reason, "schon-da", "names the branch");
    assert(mock.requests.some((entry) => entry.method === "POST" && entry.path.endsWith("/pullrequests") && entry.status === 400), "Bitbucket answered 400");
    assertEqual(mock.state.created.length, 0, "nothing created");
    assert(await app.$('[data-screen="pr-create"]'), "the form stays open");
    await t.shot("create-pull-request-duplicate");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("pull request view hides what Bitbucket cannot do (labels)", "edge", async (t) => {
  const ctx = await setupRepo(t);
  const { app, tabId } = ctx;
  try {
    const info = await app.invoke("host_repo_info", { repoId: ctx.repoId });
    assertEqual([info.kind, info.capabilities.prLabels, info.capabilities.prReviewers], ["bitbucket", false, false], "capabilities");
    await openPr(app, tabId, 2);
    const labels = await app.$(`${PR_VIEW} [data-pr-labels]`);
    await t.shot("pull-request-labels-section");
    assert(!labels, `the "Labels" block is shown although Bitbucket has no labels (capabilities.prLabels = false): "${labels ? await inner(app, labels) : ""}"`);
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

// ===========================================================================
// Issues
// ===========================================================================

scenario("issues: list, read an issue with comments, closed filter, search and a branch for the issue", "main", async (t) => {
  const ctx = await setupRepo(t);
  const { app, mock, repo } = ctx;
  try {
    await runCommand(app, str("commands.issues.show.title"));
    await app.waitFor(`${ISSUES}[data-state="filled"]`, 30_000);
    assertEqual(await issueRows(app), [11, 10, 9, 7, 6, 5, 3, 2, 1], "open issues (Bitbucket states new/open/on hold)");
    assert(!(await app.$(`${ISSUES} [data-action="issues-create"]`)), "no create button on Bitbucket (issueCreate: false)");
    const listRequest = mock.requests.find((entry) => entry.path.endsWith("/issues"));
    assertIncludes(listRequest?.query.q ?? "", 'state="open"', "BBQL state filter");

    // Read #2.
    await app.click(`${ISSUES} [data-issue-row="2"]`);
    await app.waitFor(`${ISSUES} [data-issue="2"]`, 20_000);
    await app.waitFor(async () => (await text(app, `${ISSUES} [data-issue-comments]`)).includes("Danke fürs Ansehen!"), 20_000, { message: "comment loaded" });
    assertIncludes(await text(app, `${ISSUES} [data-issue-title]`), "Problem 2", "title");
    assertIncludes(await text(app, `${ISSUES} [data-issue-body]`), "Text zu Problem 2", "body");
    assertIncludes(await text(app, `${ISSUES} [data-issue-assignees]`), "lena", "assignee");
    await app.settle();
    await t.shot("issues-list-and-details");

    // Branch for the issue.
    await clickButton(app, str("issues.branch.label"), { within: ISSUES });
    const prompt = await app.waitFor('[role="dialog"] input', 10_000);
    const suggested = await prompt.prop("value");
    assertEqual(suggested, "2-problem-2", "suggested branch name");
    await app.press("Enter");
    await app.waitFor(() => repo.git("branch", "--show-current") === "2-problem-2", 20_000, { message: "branch created and checked out" });
    assertEqual(repo.git("rev-parse", "2-problem-2"), repo.git("rev-parse", "main"), "starts at main");
    t.step("branch 2-problem-2 created");

    // Closed.
    await clickButton(app, str("issues.state.closed"), { within: ISSUES, role: "radio" });
    await eventually(app, () => issueRows(app), [12, 8, 4], "closed issues");
    assertIncludes(mock.requests.filter((entry) => entry.path.endsWith("/issues")).at(-1)?.query.q ?? "", 'state!="new"', "BBQL for closed");

    // Search (at the host).
    await clickButton(app, str("issues.state.open"), { within: ISSUES, role: "radio" });
    await app.type(`${ISSUES} input[type="search"]`, "Problem");
    await app.press("Enter");
    await eventually(app, () => issueRows(app), [2, 1], "search result");
    const searched = mock.requests.filter((entry) => entry.path.endsWith("/issues")).at(-1)?.query.q ?? "";
    assertIncludes(searched, 'title ~ "Problem"', "search text in BBQL");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("issues: quotes in the search stay text, 'assigned to me' and empty result with reset", "edge", async (t) => {
  const ctx = await setupRepo(t);
  const { app, mock } = ctx;
  try {
    await runCommand(app, str("commands.issues.show.title"));
    await app.waitFor(`${ISSUES}[data-state="filled"]`, 30_000);

    const tricky = 'x" OR state="new';
    await app.type(`${ISSUES} input[type="search"]`, tricky);
    await app.press("Enter");
    await app.waitFor(() => mock.requests.some((entry) => entry.path.endsWith("/issues") && (entry.query.q ?? "").includes("title ~")), 15_000, { message: "search sent" });
    const q = mock.requests.filter((entry) => entry.path.endsWith("/issues")).at(-1).query.q;
    assertIncludes(q, 'title ~ "x\\" OR state=\\"new"', "quotes escaped inside the BBQL string");
    t.step(`BBQL: ${q}`);

    // Reset the search, then only mine (#2 is assigned to lena).
    await app.exec((view) => {
      const field = document.querySelector(`${view} input[type="search"]`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(field, "");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, ISSUES);
    await app.click(`${ISSUES} input[type="search"]`);
    await app.press("Enter");
    await eventually(app, () => issueRows(app), [11, 10, 9, 7, 6, 5, 3, 2, 1], "all open again");
    await app.click(await app.waitFor(() => checkbox(app, str("issues.view.mine"), ISSUES), 5_000, { message: "checkbox assigned to me" }));
    await eventually(app, () => issueRows(app), [2], "assigned to me");

    // Closed + mine: nothing → empty state with reset.
    await clickButton(app, str("issues.state.closed"), { within: ISSUES, role: "radio" });
    await app.waitFor(`${ISSUES}[data-state="empty"]`, 15_000);
    assertIncludes(await text(app, ISSUES), str("issues.view.noResults"), "no results");
    await t.shot("issues-empty-filter");
    await clickButton(app, str("issues.view.resetFilters"), { within: ISSUES });
    await eventually(app, () => issueRows(app), [11, 10, 9, 7, 6, 5, 3, 2, 1], "reset: open issues of everyone");
    await t.noConsoleErrors(app);
  } finally {
    await ctx.cleanup();
  }
});

scenario("issues: tracker switched off in the Bitbucket repository", "edge", async (t) => {
  const mock = await startHostMock();
  const proxy = await startIssuesOffProxy(mock);
  const repo = makeBitbucketRepo(proxy.remoteUrl());
  let app = null;
  try {
    app = await start(t);
    await connectDirect(app, mock, { baseUrl: proxy.url });
    const { repoId, tabId } = await app.openRepo(repo.path);
    await refreshHost(app);
    const info = await app.invoke("host_repo_info", { repoId });
    assertEqual([info.kind, info.capabilities.issues], ["bitbucket", false], "has_issues: false switches issues off");
    await app.settle();
    assert(!(await app.$('[data-extra-section="issues"] [data-section-header]')), "no issues section in the sidebar");
    await setCenter(app, tabId, { kind: "issues", number: null });
    await app.waitFor(`${ISSUES}[data-state="disabled"]`, 20_000);
    assertIncludes(await text(app, ISSUES), str("issues.view.disabledTitle"), "explains the switched-off tracker");
    assert(!(await app.$(`${ISSUES} input[type="search"]`)), "no search without a tracker");
    const direct = await app.invoke("issue_list", { repoId, state: "open", query: null, page: 1 }).then(() => null, (error) => error);
    assertEqual(direct?.code, "host_unsupported", "the core names it as unsupported");
    assertMatch(direct?.message ?? "", /switched off/, "message");
    await t.shot("issues-tracker-switched-off");
    await t.noConsoleErrors(app);
  } finally {
    if (app) clearKeychain(app.keyringService);
    await proxy.close();
    await mock.close();
    repo.cleanup();
  }
});
