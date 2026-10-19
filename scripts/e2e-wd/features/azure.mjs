/**
 * Azure DevOps in the real app: connect an account through the dialog, pull requests (list, view,
 * create, comment, merge, abandon/reactivate, check out) and work items shown as issues (list,
 * details, search, filters, create, branch from a work item).
 *
 * Nothing calls a real service. The app talks to `https://dev.azure.com/firma` as a user would –
 * through a local proxy (app setting `proxyUrl` + `sslCaFile`) that terminates TLS with its own
 * test CA and hands every request to scripts/e2e/host-mock.mjs (fixtures/azure-proxy.mjs). Git
 * itself never leaves the machine: the remote URL `https://dev.azure.com/firma/projekt/_git/demo`
 * is rewritten with `url.<bare>.insteadOf` to a local bare repository, so fetch, push and checkout
 * run for real and can be asserted with git. Every app gets its own D-Bus session with a private,
 * unlocked gnome-keyring (fixtures/azure-keyring.mjs): tokens never reach the user's keychain.
 *
 *   node scripts/e2e-wd/features/azure.mjs
 *   E2E_WD_ONLY=merge node scripts/e2e-wd/features/azure.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startHostMock } from "../../e2e/host-mock.mjs";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { startPrivateKeyring } from "../fixtures/azure-keyring.mjs";
import { startAzureProxy } from "../fixtures/azure-proxy.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const ORG_URL = "https://dev.azure.com/firma";
const REMOTE_URL = `${ORG_URL}/projekt/_git/demo`;
const CONNECT_DIALOG = '[role="dialog"]:has([data-screen="hosts-connect"])';
const CONNECT_FORM = '[data-screen="hosts-connect"]';
const PR_SECTION = '[data-extra-section="pull-requests"]';
const PR_VIEW = '[data-screen="pr-view"]';
const PR_CREATE = '[data-screen="pr-create"]';
const ISSUES = '[data-screen="issues"]';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Objects with their keys sorted, recursively – for comparing JSON bodies regardless of key order. */
const sorted = (value) =>
  Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a command through the command palette (Ctrl+P, ">" + text, pick the entry with this id). */
async function palette(app, text, commandId) {
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const optionCss = `[data-screen="command-palette"] [role="option"][data-key="command:${commandId}"]`;
  // The list filters while typing: wait until it no longer changes, then pick the entry.
  const keys = () => app.exec(() => [...document.querySelectorAll('[data-screen="command-palette"] [role="option"]')].map((option) => option.dataset.key).join("|"));
  let previous = null;
  await app.waitFor(
    async () => {
      const current = await keys();
      const stable = current === previous && current.includes(`command:${commandId}`);
      previous = current;
      return stable;
    },
    10_000,
    { interval: 150, message: `palette entry ${commandId}` },
  );
  await app.click(await app.waitFor(optionCss, 5000));
  await app.waitFor(async () => !(await app.$('[data-screen="command-palette"]')), 10_000, { message: "palette closed" });
}

const toasts = (app) =>
  app.exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
const waitToast = (app, tone, pattern, timeout = 20_000) =>
  app.waitFor(async () => (await toasts(app)).find((toast) => toast.tone === tone && pattern.test(toast.text)), timeout, { message: `${tone} toast ${pattern}` });

const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
const attr = (app, css, name) => app.exec((selector, key) => document.querySelector(selector)?.getAttribute(key) ?? null, css, name);
const count = (app, css) => app.exec((selector) => document.querySelectorAll(selector).length, css);

/** Waits until fn() JSON-equals expected; throws with the last value. */
async function eventually(fn, expected, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (JSON.stringify(last) === JSON.stringify(expected)) return last;
    if (Date.now() > deadline) throw new Error(`${message}: expected ${JSON.stringify(expected)}, last ${JSON.stringify(last)}`);
    await sleep(120);
  }
}

/** Sets a field's value like typing would (React sees an input event) – for replacing existing text. */
const fill = (app, css, value) =>
  app.exec(
    (selector, next) => {
      const field = document.querySelector(selector);
      if (!field) throw new Error(`no field ${selector}`);
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, next);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return true;
    },
    css,
    value,
  );

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } }).trim();

/**
 * A repository whose origin is `https://dev.azure.com/firma/projekt/_git/demo` – rewritten by
 * `insteadOf` to the local bare repository of the fixture.
 */
function makeAzureRepo(name = "azure-demo") {
  const repo = makeCleanRepoWithRemote({ name });
  repo.git("config", `url.${repo.remotePath}.insteadOf`, REMOTE_URL);
  repo.git("remote", "set-url", "origin", REMOTE_URL);
  return repo;
}

/** Token must not appear in the page (DOM incl. attributes and field values, storage, query cache) or the data folder. */
async function assertNoTokenLeak(app, token, where) {
  const inPage = await app.exec((secret) => {
    const hits = [];
    if (document.documentElement.outerHTML.includes(secret)) hits.push("dom");
    for (const field of document.querySelectorAll("input, textarea")) if (field.value.includes(secret)) hits.push(`field ${field.name}`);
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) if ((store.getItem(store.key(i)) ?? "").includes(secret)) hits.push("storage");
    try {
      if (JSON.stringify(window.__gc.queryClient.getQueryCache().getAll().map((query) => query.state.data ?? null)).includes(secret)) hits.push("query cache");
    } catch {
      // cyclic data – not a leak
    }
    return hits;
  }, token);
  assertEqual(inPage, [], `token leaks in the page (${where})`);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full).includes(token)) files.push(full);
    }
  };
  walk(app.dataDir);
  assertEqual(files, [], `token in files of the data folder (${where})`);
}

async function refreshHostQueries(app) {
  await app.exec(() =>
    Promise.all([
      window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "hostAccounts"] }),
      window.__gc.queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" }),
    ]).then(() => true),
  );
  await app.settle();
}

/** Removes every account again – this also deletes the tokens from the system keychain. */
async function disconnectAll(app) {
  if (!app) return;
  try {
    for (const account of await app.invoke("host_accounts")) await app.invoke("host_disconnect", { accountId: account.id });
  } catch {
    // app already gone
  }
}

const setCenter = (app, tabId, center) => app.exec((id, next) => window.__gc.store.getState().setCenter(id, next), tabId, center);

/** Requests the mock received for Azure (method + path, query left out). */
const azureCalls = (mock, method, pattern) => mock.requests.filter((entry) => entry.path.startsWith("/firma/") && (!method || entry.method === method) && (!pattern || pattern.test(entry.path)));

/**
 * Host mock + proxy + repository + app (light, English, 1440×900). `connect`: account through the
 * core (fast path for scenarios that are not about connecting). `open`: open the repository.
 * Everything is cleaned up afterwards – accounts first, so the keychain entries go away.
 */
async function withAzure(t, { connect = true, open = true, repoName, before, secrets = true } = {}, body) {
  const mock = await startHostMock();
  const proxy = await startAzureProxy(mock);
  const repo = makeAzureRepo(repoName);
  // Own Secret Service: the tokens never reach the user's keychain, and a locked one does not matter.
  const keyring = await startPrivateKeyring({ secrets });
  let app = null;
  try {
    if (before) await before({ repo, mock });
    app = await t.launch({ width: 1440, height: 900, theme: "light", lang: "en", env: keyring?.env ?? {} });
    await app.invoke("settings_set", { patch: { proxyUrl: proxy.url, sslCaFile: proxy.caFile, autoFetchMinutes: 0 } });
    if (connect) await app.invoke("host_connect", { kind: "azure_devops", baseUrl: ORG_URL, token: mock.token });
    let ids = null;
    if (open) {
      ids = await app.openRepo(repo.path);
      await refreshHostQueries(app);
    }
    await body({ app, mock, proxy, repo, ...(ids ?? {}) });
    assertEqual(proxy.refused, [], "the proxy refused nothing (no call to any other address)");
  } finally {
    await disconnectAll(app);
    await keyring?.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
    repo.cleanup();
  }
}

/** Opens the connect dialog through the palette and picks Azure DevOps. */
async function openAzureConnect(app) {
  await palette(app, "Connect host account", "hosts.connect");
  await app.waitFor(CONNECT_FORM, 10_000);
  await app.click({ text: "Azure DevOps", within: CONNECT_FORM });
  await app.waitFor(`${CONNECT_FORM} input[name="organization"]`, 5000, { message: "organization field" });
  await app.waitFor(`${CONNECT_FORM} [data-token-guide="azure_devops"]`, 5000, { message: "Azure token guide" });
}

/** Opens a collapsed sidebar section (sections start collapsed). */
async function expandSection(app, css) {
  const trigger = await app.waitFor(`${css} [data-section-header] > button`, 20_000, { message: `section header ${css}` });
  if ((await trigger.attr("data-state")) !== "open") await app.click(trigger);
  await app.waitFor(async () => (await attr(app, `${css} [data-section-header] > button`, "data-state")) === "open", 5000, { message: `section ${css} open` });
}

const prRows = (app) => app.exec((css) => [...document.querySelectorAll(`${css} [data-kind="pull-request"]`)].map((row) => Number(row.dataset.pr)), PR_SECTION);

/** Text of the open dialog whose text matches, or null. */
const dialogText = (app, pattern) =>
  app.exec((source) => {
    const wanted = new RegExp(source);
    const found = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].map((node) => node.innerText.replace(/\s+/g, " ").trim()).filter((value) => wanted.test(value));
    return found.length ? found[found.length - 1] : null;
  }, pattern.source);

/** The checkbox (Radix button) whose label starts with the text – the label also holds the hint. */
const checkbox = (app, within, label) =>
  app.waitFor(
    () =>
      app.exec(
        (scope, wanted) => {
          for (const node of document.querySelectorAll(`${scope} label[for]`)) {
            if ((node.firstChild?.textContent ?? "").trim() === wanted) return document.getElementById(node.htmlFor);
          }
          return null;
        },
        within,
        label,
      ),
    10_000,
    { message: `checkbox "${label}"` },
  );

const dialogOpen = (app) => app.exec((css) => Boolean(document.querySelector(css)), CONNECT_DIALOG);

// =============================================================================================
// Connect account
// =============================================================================================

scenario("connect: Azure DevOps account through the dialog with organization and token", "main", async (t) => {
  await withAzure(t, { connect: false }, async ({ app, mock, proxy, repo }) => {
    // Without an account the PR section names Azure DevOps and offers to connect.
    await expandSection(app, PR_SECTION);
    await app.waitFor(async () => /Azure DevOps/.test((await text(app, PR_SECTION)) ?? ""), 20_000, { message: "PR section names Azure DevOps without an account" });
    t.step(`sidebar without account: ${await text(app, PR_SECTION)}`);

    await openAzureConnect(app);
    const guide = await text(app, `${CONNECT_FORM} [data-token-guide="azure_devops"]`);
    assertMatch(guide, /Azure DevOps/, "the guide names the host");
    assertMatch(guide, /Code/i, "the guide lists the Code permission");
    assertMatch(guide, /Work Items/i, "the guide lists the Work Items permission");
    // Only organization and token – no instance or address choice for Azure DevOps.
    assertEqual(await count(app, `${CONNECT_FORM} input[name="baseUrl"]`), 0, "no address field for Azure DevOps");
    await app.type(`${CONNECT_FORM} input[name="organization"]`, "firma");
    await app.type(`${CONNECT_FORM} input[name="token"]`, mock.token);
    const tokenAttr = await attr(app, `${CONNECT_FORM} input[name="token"]`, "type");
    assertEqual(tokenAttr, "password", "token field is a password field");
    await t.shot("connect-dialog-azure");
    await app.click({ text: "Connect", within: CONNECT_DIALOG });
    await app.waitFor(async () => !(await dialogOpen(app)), 20_000, { message: "dialog closes after connecting" });
    t.step("dialog closed");

    const accounts = await app.invoke("host_accounts");
    assertEqual(accounts.map((account) => [account.kind, account.baseUrl, account.user?.login, account.tokenHint]), [["azure_devops", ORG_URL, "lena@example.org", "…abcd"]], "one Azure DevOps account for the organization");
    // The core signed in the Azure way: Basic with an empty user name and the token.
    const first = azureCalls(mock, "GET", /_apis\/connectionData$/)[0];
    assert(first, "connectionData was requested");
    assertEqual(Buffer.from(String(first.headers.authorization).replace(/^Basic /, ""), "base64").toString(), `:${mock.token}`, "Basic auth with empty user name");
    assert(proxy.seen.every((entry) => entry.host === "dev.azure.com"), "every API call went to dev.azure.com (through the test proxy)");

    // The sidebar now loads the pull requests of the repository.
    await app.waitFor(async () => (await count(app, `${PR_SECTION} [data-kind="pull-request"]`)) > 0, 20_000, { message: "PR rows after connecting" });
    t.step(`${await count(app, `${PR_SECTION} [data-kind="pull-request"]`)} PR rows in the sidebar`);

    // Settings › Hosts lists the account with name and the last four characters only.
    await palette(app, "Open integrations", "hosts.open");
    const row = await app.waitFor('[data-screen="hosts"] li[data-kind="azure_devops"]', 15_000, { message: "account row in Settings › Hosts" });
    const rowText = await row.text();
    assertMatch(rowText, /Lena Hartmann/, "account row shows the display name");
    assertMatch(rowText, /abcd/, "account row shows the last four characters");
    await t.shot("connect-account-listed");
    await assertNoTokenLeak(app, mock.token, "after connecting");
    assertEqual(git(repo.path, "status", "--porcelain"), "", "the repository is untouched");
    await t.noConsoleErrors(app);
  });
});

scenario("connect: organization is checked before anything is sent", "edge", async (t) => {
  await withAzure(t, { connect: false, open: false }, async ({ app, mock }) => {
    await openAzureConnect(app);
    // Empty organization.
    await app.type(`${CONNECT_FORM} input[name="token"]`, mock.token);
    await app.click({ text: "Connect", within: CONNECT_DIALOG });
    await app.waitFor(async () => /organization/i.test((await text(app, CONNECT_FORM)) ?? "") && (await app.exec(() => document.activeElement?.getAttribute("name"))) === "organization", 5000, {
      message: "error at the organization field, focus there",
    });
    t.step(`empty: ${await app.exec(() => document.querySelector('[data-screen="hosts-connect"] input[name="organization"]')?.getAttribute("aria-invalid"))}`);
    // Spaces are not an organization.
    await app.type(`${CONNECT_FORM} input[name="organization"]`, "meine firma");
    await app.click({ text: "Connect", within: CONNECT_DIALOG });
    await sleep(400);
    assert(await dialogOpen(app), "dialog stays open for an invalid organization");
    await t.shot("connect-invalid-organization");
    assertEqual(azureCalls(mock).length, 0, "no request went out for an empty or invalid organization");
    assertEqual(await app.invoke("host_accounts"), [], "no account stored");

    // A pasted project address is accepted and reduced to the organization (lower case).
    await fill(app, `${CONNECT_FORM} input[name="organization"]`, "https://dev.azure.com/Firma/projekt");
    const token = await app.$(`${CONNECT_FORM} input[name="token"]`);
    if (!(await token.prop("value"))) await app.type(token, mock.token);
    await app.click({ text: "Connect", within: CONNECT_DIALOG });
    await app.waitFor(async () => !(await dialogOpen(app)), 20_000, { message: "dialog closes with a pasted address" });
    assertEqual((await app.invoke("host_accounts")).map((account) => account.baseUrl), [ORG_URL], "stored as https://dev.azure.com/firma");
    await t.noConsoleErrors(app);
  });
});

scenario("connect: rejected token shows the reason, stores nothing and clears the field", "edge", async (t) => {
  await withAzure(t, { connect: false, open: false }, async ({ app, mock }) => {
    await openAzureConnect(app);
    await app.type(`${CONNECT_FORM} input[name="organization"]`, "firma");
    const wrong = "azdo-ungueltig-0000000000000000000000000000";
    await app.type(`${CONNECT_FORM} input[name="token"]`, wrong);
    await app.click({ text: "Connect", within: CONNECT_DIALOG });
    const failure = await app.waitFor(`${CONNECT_FORM} [data-connect-error]`, 20_000, { message: "error box in the dialog" });
    assertEqual(await failure.attr("data-connect-error"), "auth", "error kind auth");
    t.step(`error: ${await failure.text()}`);
    assertEqual(await app.$(`${CONNECT_FORM} input[name="token"]`).then((field) => field.prop("value")), "", "token field cleared");
    assertEqual(await app.invoke("host_accounts"), [], "nothing stored");
    await t.shot("connect-token-rejected");
    await assertNoTokenLeak(app, wrong, "after a rejected token");
    // Cancel with Escape: dialog closes, still no account.
    await app.press("Escape");
    await app.waitFor(async () => !(await dialogOpen(app)), 5000, { message: "Escape closes the dialog" });
    assertEqual(await app.invoke("host_accounts"), [], "still no account after cancelling");
    // A 401 is what the app reported – not a console error.
    await t.noConsoleErrors(app);
    assert(azureCalls(mock).length >= 1, "the token was checked at the host");
  });
});

scenario("connect: without a keychain the dialog warns and nothing is stored", "edge", async (t) => {
  await withAzure(t, { connect: false, open: false, secrets: false }, async ({ app, mock }) => {
    assertEqual(await app.invoke("app_keyring_available"), false, "the app sees no keychain");
    await openAzureConnect(app);
    const warning = await app.waitFor(`${CONNECT_FORM} [data-state="no-keyring"]`, 10_000, { message: "no-keyring banner in the dialog" });
    assertMatch(await warning.text(), /keychain/i, "banner explains the keychain");
    await app.type(`${CONNECT_FORM} input[name="organization"]`, "firma");
    await app.type(`${CONNECT_FORM} input[name="token"]`, mock.token);
    await app.click({ text: "Connect", within: CONNECT_DIALOG });
    const failure = await app.waitFor(`${CONNECT_FORM} [data-connect-error]`, 20_000, { message: "error box" });
    t.step(`error: ${await failure.text()}`);
    assertMatch(await failure.text(), /keychain/i, "the error names the keychain");
    assertEqual(await app.invoke("host_accounts"), [], "nothing stored");
    assertEqual(await app.$(`${CONNECT_FORM} input[name="token"]`).then((field) => field.prop("value")), "", "token field cleared");
    await t.shot("connect-no-keyring");
    await assertNoTokenLeak(app, mock.token, "without a keychain");
    await t.noConsoleErrors(app);
  });
});

scenario("connect: disconnecting in Settings › Hosts removes the account and the PR list", "edge", async (t) => {
  await withAzure(t, {}, async ({ app }) => {
    await expandSection(app, PR_SECTION);
    await app.waitFor(async () => (await count(app, `${PR_SECTION} [data-kind="pull-request"]`)) > 0, 20_000, { message: "PR rows with an account" });
    await palette(app, "Open integrations", "hosts.open");
    await app.waitFor('[data-screen="hosts"] li[data-kind="azure_devops"]', 15_000);
    await app.click('[data-screen="hosts"] li[data-kind="azure_devops"] button[aria-label^="Disconnect"]');
    // The confirmation names host, organization and account.
    const confirmText = await app.waitFor(async () => dialogText(app, /Disconnect Azure DevOps account\?/), 10_000, { message: "confirmation" });
    assertMatch(confirmText, /dev\.azure\.com\/firma/, "confirmation names the organization");
    await t.shot("connect-disconnect-confirm");
    await app.click({ text: "Disconnect account" });
    await eventually(async () => (await app.invoke("host_accounts")).length, 0, "account removed");
    await app.waitFor('[data-screen="hosts"][data-state="empty"]', 10_000, { message: "hosts list empty" });
    await app.press("Escape");
    await app.waitFor(async () => (await count(app, `${PR_SECTION} [data-kind="pull-request"]`)) === 0, 15_000, { message: "no PR rows without an account" });
    t.step(`sidebar: ${await text(app, PR_SECTION)}`);
    await t.noConsoleErrors(app);
  });
});

// =============================================================================================
// Pull requests
// =============================================================================================

const prHead = (number) => `${PR_VIEW}[data-pr-number="${number}"] [data-pr-head]`;
const phase = (app) => attr(app, `${PR_VIEW} [data-pr-head] [data-pr-phase]`, "data-pr-phase");

/** Opens the pull request view (as a click in the sidebar or the palette would) and waits for its head. */
async function openPr(app, tabId, number) {
  await setCenter(app, tabId, { kind: "pr", number });
  await app.waitFor(prHead(number), 30_000, { message: `PR #${number} view` });
  await app.settle();
}

const prActionButton = (app, label) => app.byText(label, { within: `${PR_VIEW} [data-pr-actions]` });
const lastBody = (mock, method, pattern) => azureCalls(mock, method, pattern).at(-1)?.body ?? null;

scenario("pull requests: sidebar lists the active ones, a click opens the view with checks, review, labels and conversation", "main", async (t) => {
  await withAzure(t, {}, async ({ app, mock }) => {
    await expandSection(app, PR_SECTION);
    await app.waitFor(async () => (await prRows(app)).length >= 20, 20_000, { message: "first page of PR rows" });
    const rows = await prRows(app);
    // Mock: 45 PRs, number ending in 0 = completed, in 5 = abandoned → active ones, newest first.
    assertEqual(rows.slice(0, 6), [44, 43, 42, 41, 39, 38], "active pull requests, newest first, completed and abandoned left out");
    assert(!rows.some((number) => number % 5 === 0), "no completed or abandoned PR in the list");
    const list = azureCalls(mock, "GET", /\/pullrequests$/).at(-1);
    assertEqual(list?.query["searchCriteria.status"], "active", "the list asks Azure for status=active");
    assertMatch(await text(app, `${PR_SECTION} [data-section-header]`), /20\+/, "counter shows that there are more");

    // Load the rest and open #1 with a click.
    await app.click({ text: "Load more", within: PR_SECTION });
    await app.waitFor(async () => (await prRows(app)).includes(1), 20_000, { message: "second page with #1" });
    assertEqual((await prRows(app)).length, 36, "all 36 active pull requests after loading more");
    await app.click(`${PR_SECTION} [data-kind="pull-request"][data-pr="1"]`);
    await app.waitFor(prHead(1), 30_000, { message: "PR #1 view" });
    await app.settle();
    const head = await text(app, `${PR_VIEW} [data-pr-head]`);
    t.step(`head: ${head}`);
    assertMatch(head, /Thema 1 umsetzen #1/, "title and number");
    assertMatch(head, /feature\/thema-1/, "source branch");
    assertMatch(head, /\bmain\b/, "target branch");
    assertEqual(await phase(app), "open", "phase open");
    assertEqual(await attr(app, `${PR_VIEW} [data-pr-head] [data-checks]`, "data-checks"), "passing", "the succeeded build status counts as passed checks");
    assertMatch(await text(app, `${PR_VIEW} [data-pr-reviewers]`), /mira/i, "reviewer from Azure");
    assertMatch(await text(app, `${PR_VIEW} [data-pr-labels]`), /bug/, "label from Azure");
    const body = await app.waitFor(`${PR_VIEW} [data-pr-body]`, 10_000);
    assertMatch(await body.text(), /Beschreibung zu Thema 1/, "description rendered");
    assertEqual(await app.exec(() => document.querySelector('[data-screen="pr-view"] [data-pr-body] strong')?.textContent ?? null), "Thema 1", "Markdown bold rendered");
    assertMatch(await text(app, `${PR_VIEW} [data-pr-comments]`), /Sieht gut aus\./, "thread comment in the conversation");
    await t.shot("pr-view-azure");

    // Commits tab: the commit of the pull request.
    await app.click({ text: "Commits", within: PR_VIEW, exact: false });
    await app.waitFor(async () => /Meldung übersetzt/.test((await text(app, `${PR_VIEW} [data-pr-commits]`)) ?? ""), 10_000, { message: "PR commit listed" });
    await t.noConsoleErrors(app);
  });
});

scenario("pull requests: create from a pushed branch as draft with a label", "main", async (t) => {
  await withAzure(t, { before: ({ repo }) => repo.git("checkout", "-q", "feature/export") }, async ({ app, mock, repo }) => {
    await palette(app, "Create pull request", "pr.create");
    await app.waitFor(`${PR_CREATE} [data-pr-state="form"]`, 30_000, { message: "create form" });
    const title = await app.waitFor(async () => {
      const value = await app.$(`${PR_CREATE} input[name="title"]`).then((field) => field?.prop("value"));
      return value ? value : null;
    }, 15_000, { message: "title prefilled" });
    assertEqual(title, "CSV-Export für den Vergleich", "title prefilled from the only commit");
    assertEqual(await count(app, `${PR_CREATE} input[name="reviewers"]`), 0, "no reviewers field (Azure needs identity IDs)");
    assertMatch(await text(app, `${PR_CREATE} [data-pr-steps]`), /feature\/export/, "steps name the source branch");
    // WebDriver key "Enter" (U+E007) for the line breaks – a bare "\n" is dropped by WebKitWebDriver.
    await app.type(`${PR_CREATE} textarea[name="body"]`, "Schreibt den Vergleich als CSV.\uE007\uE007Bitte mit den Daten von Nord prüfen.");
    const draft = await checkbox(app, PR_CREATE, "Create as draft");
    await app.click(draft);
    assertEqual(await draft.attr("aria-checked"), "true", "draft checked");
    await app.type(`${PR_CREATE} input[name="labels"]`, "doku");
    await app.waitFor(async () => /Create draft/.test((await text(app, `${PR_CREATE} footer`)) ?? ""), 5000, { message: "button says Create draft" });
    await t.shot("pr-create-azure");
    await app.click(`${PR_CREATE} footer button[type="submit"]`);

    await app.waitFor(prHead(101), 30_000, { message: "the new PR #101 opens" });
    const created = mock.state.created.map(({ number, title: name, source, target, draft }) => ({ number, name, source, target, draft }));
    assertEqual(created, [{ number: 101, name: "CSV-Export für den Vergleich", source: "feature/export", target: "main", draft: true }], "created at the host");
    const sent = lastBody(mock, "POST", /\/pullrequests$/);
    assertEqual([sent.sourceRefName, sent.targetRefName, sent.isDraft, sent.labels], ["refs/heads/feature/export", "refs/heads/main", true, [{ name: "doku" }]], "request: full ref names, draft, label by name");
    assertEqual(sent.description, "Schreibt den Vergleich als CSV.\n\nBitte mit den Daten von Nord prüfen.", "description sent with its line breaks");
    await app.waitFor(async () => (await phase(app)) === "draft", 10_000, { message: "view shows draft" });
    // Git: nothing had to be pushed, the branch is unchanged on the remote.
    assertEqual(git(repo.remotePath, "rev-parse", "refs/heads/feature/export"), git(repo.path, "rev-parse", "feature/export"), "remote branch unchanged");
    await t.shot("pr-created-draft");
    await t.noConsoleErrors(app);
  });
});

scenario("pull requests: branch not on the remote yet – push and create in one step", "edge", async (t) => {
  await withAzure(
    t,
    {
      before: ({ repo }) => {
        repo.git("checkout", "-q", "-b", "thema/neue-station", "main");
        repo.write("stationen/west.md", "# West\n\nVierte Station.\n");
        repo.git("add", "-A");
        repo.git("commit", "-q", "-m", "Station West ergänzt");
      },
    },
    async ({ app, mock, repo }) => {
      assertEqual(execFileSync("git", ["-C", repo.remotePath, "branch", "--list", "thema/neue-station"], { encoding: "utf8" }).trim(), "", "branch is not on the remote before");
      await palette(app, "Create pull request", "pr.create");
      await app.waitFor(`${PR_CREATE} [data-pr-state="form"]`, 30_000);
      await app.waitFor(async () => /Push first/.test((await text(app, `${PR_CREATE} [data-pr-steps]`)) ?? ""), 15_000, { message: "step: push first" });
      await app.waitFor(async () => /Push and create/.test((await text(app, `${PR_CREATE} footer`)) ?? ""), 5000, { message: "button: Push and create" });
      await t.shot("pr-create-push-first");
      await app.click(`${PR_CREATE} footer button[type="submit"]`);
      await app.waitFor(prHead(101), 60_000, { message: "PR #101 after push" });
      assertEqual(git(repo.remotePath, "rev-parse", "refs/heads/thema/neue-station"), git(repo.path, "rev-parse", "thema/neue-station"), "branch pushed to the remote");
      assertEqual(git(repo.path, "rev-parse", "--abbrev-ref", "thema/neue-station@{upstream}"), "origin/thema/neue-station", "upstream set");
      assertEqual(mock.state.created.map((entry) => [entry.source, entry.target, entry.title]), [["thema/neue-station", "main", "Station West ergänzt"]], "created for the pushed branch");
      await t.noConsoleErrors(app);
    },
  );
});

scenario("pull requests: an existing PR for the branch is refused with the host's reason", "edge", async (t) => {
  await withAzure(
    t,
    {
      before: ({ repo }) => {
        repo.git("checkout", "-q", "-b", "schon-da", "main");
        repo.write("notiz.md", "Schon da.\n");
        repo.git("add", "-A");
        repo.git("commit", "-q", "-m", "Notiz");
        repo.git("push", "-q", "-u", "origin", "schon-da");
      },
    },
    async ({ app, mock }) => {
      await palette(app, "Create pull request", "pr.create");
      await app.waitFor(`${PR_CREATE} [data-pr-state="form"]`, 30_000);
      await app.waitFor(async () => (await app.$(`${PR_CREATE} footer button[type="submit"]:not([disabled])`)) !== null, 15_000, { message: "submit enabled" });
      await app.click(`${PR_CREATE} footer button[type="submit"]`);
      const failure = await app.waitFor(`${PR_CREATE} [data-pr-error]`, 20_000, { message: "error in the form" });
      const message = await failure.text();
      t.step(`error: ${message}`);
      assertMatch(message, /already an open pull request.*schon-da/s, "names the reason and the branch");
      assertEqual(mock.state.created, [], "nothing created");
      assert(await app.$(`${PR_CREATE} [data-pr-state="form"]`), "form stays open with the input");
      await t.shot("pr-create-duplicate");
      await t.noConsoleErrors(app);
    },
  );
});

scenario("pull requests: comment in the conversation", "main", async (t) => {
  await withAzure(t, {}, async ({ app, mock, proxy, tabId }) => {
    // The mock's thread list is fixed; once a thread was posted, list it as Azure would.
    proxy.route(({ method, path: route }) =>
      method === "GET" && /pullrequests\/2\/threads$/.test(route) && mock.state.comments.length
        ? { json: { count: 1 + mock.state.comments.length, value: [{ id: 2, comments: [{ id: 1, author: { displayName: "mira (Name)", uniqueName: "mira@example.org" }, content: "Sieht gut aus.", publishedDate: "2026-09-02T09:00:00Z", commentType: "text" }] }, ...mock.state.comments] } }
        : null,
    );
    await openPr(app, tabId, 2);
    const box = await app.waitFor(`${PR_VIEW} [data-comment-form] textarea`, 10_000, { message: "comment field" });
    await app.type(box, "Bitte noch die **Einheiten** prüfen.");
    await app.click({ text: "Comment", within: `${PR_VIEW} [data-comment-form]` });
    await eventually(() => mock.state.comments.map((thread) => thread.comments[0].content), ["Bitte noch die **Einheiten** prüfen."], "thread created at the host", 20_000);
    assertMatch(azureCalls(mock, "POST", /pullrequests\/2\/threads$/)[0]?.path ?? "", /pullrequests\/2\/threads$/, "posted as a thread of #2");
    await waitToast(app, "success", /Comment sent/);
    // The view reloads the conversation from the host afterwards (the mock's thread list is fixed).
    const post = mock.requests.findIndex((entry) => entry.method === "POST" && /pullrequests\/2\/threads$/.test(entry.path));
    await app.waitFor(async () => mock.requests.slice(post + 1).some((entry) => entry.method === "GET" && /pullrequests\/2$/.test(entry.path)), 10_000, { message: "PR reloaded after commenting" });
    await app.waitFor(async () => /Einheiten/.test((await text(app, `${PR_VIEW} [data-pr-comments]`)) ?? ""), 15_000, { message: "new comment shown after the reload" });
    assertEqual(await app.exec(() => [...document.querySelectorAll('[data-screen="pr-view"] [data-pr-comments] strong')].map((node) => node.textContent)), ["Einheiten"], "comment Markdown rendered");
    assertEqual(await app.$(`${PR_VIEW} [data-comment-form] textarea`).then((field) => field.prop("value")), "", "field cleared");
    await t.shot("pr-comment-azure");
    await t.noConsoleErrors(app);
  });
});

scenario("pull requests: merge with squash and delete the source branch", "main", async (t) => {
  await withAzure(t, {}, async ({ app, mock, tabId }) => {
    await openPr(app, tabId, 6);
    await app.click(await app.waitFor(() => prActionButton(app, "Merge …"), 10_000));
    await app.waitFor('[data-screen="pr-merge"]', 10_000, { message: "merge dialog" });
    assertMatch(await dialogText(app, /Merge pull request #6/), /feature\/thema-6.*main/, "dialog names source and target");
    await app.click('[data-screen="pr-merge"] button[role="combobox"]');
    const methods = await app.waitFor(async () => {
      const names = await app.exec(() => [...document.querySelectorAll('[role="option"]')].map((option) => option.innerText.trim()));
      return names.length ? names : null;
    }, 5000, { message: "merge methods" });
    assertEqual(methods, ["Merge commit", "Squash", "Rebase"], "Azure offers merge commit, squash and rebase");
    await app.click({ text: "Squash", within: '[role="listbox"]' });
    const deleteBranch = await checkbox(app, '[data-screen="pr-merge"]', "Delete branch “feature/thema-6” on the host");
    if ((await deleteBranch.attr("aria-checked")) !== "true") await app.click(deleteBranch);
    await t.shot("pr-merge-dialog-azure");
    await app.click({ text: "Merge", within: '[role="dialog"]:has([data-screen="pr-merge"]) footer' }).catch(async () => app.click({ text: "Merge", within: '[role="dialog"]:has([data-screen="pr-merge"])' }));
    await eventually(() => [...mock.state.merged], [6], "completed at the host", 20_000);
    const sent = lastBody(mock, "PATCH", /pullrequests\/6$/);
    assertEqual(sorted(sent), sorted({ status: "completed", lastMergeSourceCommit: { commitId: (6).toString(16).padStart(40, "0") }, completionOptions: { mergeStrategy: "squash", deleteSourceBranch: true } }), "PATCH with strategy, branch deletion and the last source commit");
    await app.waitFor(async () => (await phase(app)) === "merged", 15_000, { message: "view shows merged" });
    await waitToast(app, "success", /Pull request #6 merged/);
    await t.noConsoleErrors(app);
  });
});

scenario("pull requests: conflicts block merging", "edge", async (t) => {
  await withAzure(t, {}, async ({ app, mock, tabId }) => {
    await openPr(app, tabId, 13);
    const blocked = await app.waitFor(`${PR_VIEW} [data-merge-blocked]`, 10_000, { message: "merge blocked notice" });
    assertMatch(await blocked.text(), /conflict/i, "names the conflicts");
    const merge = await prActionButton(app, "Merge …");
    assert(merge, "merge button present");
    assertEqual(await merge.prop("disabled"), true, "merge button disabled");
    await t.shot("pr-merge-blocked-conflicts");
    assertEqual(azureCalls(mock, "PATCH").length, 0, "nothing sent");
    await t.noConsoleErrors(app);
  });
});

scenario("pull requests: abandon and reactivate", "main", async (t) => {
  await withAzure(t, {}, async ({ app, mock, tabId }) => {
    await openPr(app, tabId, 9);
    await app.click(await app.waitFor(() => prActionButton(app, "Close …"), 10_000));
    await app.waitFor(() => dialogText(app, /Close pull request #9\?/), 10_000, { message: "confirmation" });
    await app.click({ text: "Close pull request" });
    await eventually(() => [...mock.state.closed], [9], "abandoned at the host", 20_000);
    assertEqual(lastBody(mock, "PATCH", /pullrequests\/9$/), { status: "abandoned" }, "PATCH status abandoned");
    await app.waitFor(async () => (await phase(app)) === "closed", 15_000, { message: "view shows closed" });
    await t.shot("pr-abandoned-azure");
    await app.click(await app.waitFor(() => prActionButton(app, "Reopen"), 10_000, { message: "Reopen button" }));
    await eventually(() => [...mock.state.closed], [], "reactivated at the host", 20_000);
    assertEqual(lastBody(mock, "PATCH", /pullrequests\/9$/), { status: "active" }, "PATCH status active");
    await app.waitFor(async () => (await phase(app)) === "open", 15_000, { message: "view shows open again" });
    await t.noConsoleErrors(app);
  });
});

scenario("pull requests: check out the branch of a pull request", "main", async (t) => {
  let remoteSha = null;
  await withAzure(
    t,
    {
      before: ({ repo }) => {
        // Someone else pushed feature/login (PR #7); locally there is neither the branch nor the commit.
        repo.git("push", "-q", "origin", "main:refs/heads/feature/login");
        repo.git("update-ref", "-d", "refs/remotes/origin/feature/login");
        remoteSha = repo.commitOnRemote({ branch: "feature/login", file: "login.md", content: "# Anmeldung\n", message: "Anmeldung vorbereitet" });
      },
    },
    async ({ app, repo, tabId }) => {
      assertEqual(git(repo.path, "branch", "--list", "feature/login"), "", "no local branch before");
      await openPr(app, tabId, 7);
      await app.click(await app.waitFor(() => prActionButton(app, "Check out branch"), 10_000));
      await eventually(() => git(repo.path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/login", "branch checked out", 30_000);
      assertEqual(git(repo.path, "rev-parse", "HEAD"), remoteSha, "at the commit from the remote");
      assertEqual(git(repo.path, "rev-parse", "--abbrev-ref", "feature/login@{upstream}"), "origin/feature/login", "tracks origin/feature/login");
      // The UI follows: status line on the new branch, the fetch job finished.
      await app.waitFor(
        () => app.exec(() => !document.querySelector('[role="progressbar"]') && [...document.querySelectorAll('[role="status"][aria-live="polite"]')].some((node) => /feature\/login/.test(node.innerText))),
        20_000,
        { message: "status line shows feature/login" },
      );
      await app.settle();
      await t.shot("pr-checkout-azure");
      await t.noConsoleErrors(app);
    },
  );
});

scenario("pull requests: rate limit and rejected token keep the last state with a notice", "edge", async (t) => {
  await withAzure(t, {}, async ({ app, mock, tabId }) => {
    await openPr(app, tabId, 1);
    const refresh = async () => {
      await app.click({ text: "Refresh", within: PR_VIEW });
      await app.settle();
    };
    mock.fail("rate_limit");
    await refresh();
    await app.waitFor(async () => (await attr(app, `${PR_VIEW} [data-pr-stale]`, "data-pr-stale")) === "rate_limit", 20_000, { message: "rate limit notice" });
    assertMatch(await text(app, `${PR_VIEW} [data-pr-head]`), /Thema 1 umsetzen/, "last state stays visible");
    await t.shot("pr-stale-rate-limit");
    mock.recover();
    mock.fail("unauthorized");
    await refresh();
    await app.waitFor(async () => (await attr(app, `${PR_VIEW} [data-pr-stale]`, "data-pr-stale")) === "auth", 20_000, { message: "token rejected notice" });
    assert(await app.byText("Open integrations", { within: `${PR_VIEW} [data-pr-stale]` }), "offers to open the integrations");
    mock.recover();
    await refresh();
    await app.waitFor(async () => (await count(app, `${PR_VIEW} [data-pr-stale]`)) === 0, 20_000, { message: "notice gone after recovery" });
    await t.noConsoleErrors(app);
  });
});

scenario("pull requests: a pull request from a fork cannot be checked out", "edge", async (t) => {
  await withAzure(t, {}, async ({ app, repo, tabId }) => {
    const before = git(repo.path, "rev-parse", "--abbrev-ref", "HEAD");
    await openPr(app, tabId, 8);
    assertMatch(await text(app, `${PR_VIEW} [data-pr-head]`), /fork/i, "the head says it comes from a fork");
    const checkout = await prActionButton(app, "Check out branch");
    assert(checkout, "check out button present");
    assertEqual(await checkout.prop("disabled"), true, "check out disabled for a fork");
    assertMatch(await checkout.attr("title"), /Azure DevOps/, "the tooltip names the host");
    assertEqual(git(repo.path, "rev-parse", "--abbrev-ref", "HEAD"), before, "nothing checked out");
    await t.noConsoleErrors(app);
  });
});

// =============================================================================================
// Work items as issues
// =============================================================================================

const issueRows = (app) => app.exec(() => [...document.querySelectorAll('[data-screen="issues"] [data-issue-row]')].map((row) => Number(row.dataset.issueRow)));
const wiqlQueries = (mock) => azureCalls(mock, "POST", /_apis\/wit\/wiql$/).map((entry) => String(entry.body?.query ?? ""));

async function openIssues(app) {
  await palette(app, "Show issues", "issues.show");
  await app.waitFor(ISSUES, 15_000, { message: "issues view" });
}

/** Waits until the list shows exactly these work items. */
const rowsAre = (app, expected, message) => eventually(() => issueRows(app), expected, message, 20_000);

/** Created work items: the mock knows only #1–#12, so the proxy answers for the new ones. */
function serveCreatedWorkItems(proxy, mock) {
  proxy.route(({ method, path: route }) => {
    const match = /^\/firma\/projekt\/_apis\/wit\/workitems\/(\d+)$/i.exec(route);
    const comments = /^\/firma\/projekt\/_apis\/wit\/workItems\/(\d+)\/comments$/.exec(route);
    const id = Number(match?.[1] ?? comments?.[1] ?? 0);
    const created = method === "GET" ? mock.state.workItems.find((item) => item.id === id) : null;
    if (!created) return null;
    if (comments) return { json: { totalCount: 0, count: 0, comments: [] } };
    const patch = azureCalls(mock, "POST", /_apis\/wit\/workitems\/\$/).find((entry) => entry.body?.find?.((op) => op.path === "/fields/System.Title")?.value === created.title)?.body ?? [];
    const description = patch.find((op) => op.path === "/fields/System.Description")?.value ?? "";
    return {
      json: {
        id,
        fields: {
          "System.Title": created.title,
          "System.State": "New",
          "System.CreatedBy": { displayName: "Lena Hartmann", uniqueName: "lena@example.org" },
          "System.ChangedDate": new Date().toISOString(),
          "System.WorkItemType": "Issue",
          "System.Description": description,
        },
      },
    };
  });
}

scenario("work items: open ones listed as issues, details with description, tags and comments", "main", async (t) => {
  await withAzure(t, {}, async ({ app, mock }) => {
    await openIssues(app);
    // Mock: 12 work items, every 4th Closed.
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "open work items, most recently changed first");
    const query = wiqlQueries(mock).at(-1);
    assertMatch(query, /\[System\.TeamProject\] = @project/, "WIQL limited to the project");
    assertMatch(query, /\[System\.State\] NOT IN \('Closed', 'Done', 'Removed', 'Resolved', 'Completed'\)/, "WIQL excludes the closed states of every process");
    assertMatch(query, /ORDER BY \[System\.ChangedDate\] DESC$/, "newest change first");
    assertMatch(azureCalls(mock, "GET", /_apis\/wit\/workitems$/).at(-1)?.query.ids ?? "", /^\d+(,\d+)*$/, "items fetched in one batch by id");
    assertMatch(await text(app, `${ISSUES} [data-issues-footer]`), /9 issues loaded – that is all/, "footer counts the loaded items");

    await app.click(`${ISSUES} [data-issue-row="1"]`);
    const details = await app.waitFor(`${ISSUES} article[data-issue="1"][data-state="filled"]`, 20_000, { message: "details of #1" });
    const detailText = (await details.text()).replace(/\s+/g, " ");
    t.step(`details: ${detailText.slice(0, 240)}`);
    assertMatch(detailText, /Problem 1 #1/, "title and key");
    assertMatch(await text(app, `${ISSUES} article[data-issue="1"] [data-issue-body]`), /Text zu Problem 1/, "HTML description shown as text");
    assertEqual(await app.exec(() => document.querySelector('[data-screen="issues"] [data-issue-body] p') !== null), true, "description HTML rendered as a paragraph");
    const labels = await app.exec(() => {
      const rows = [...document.querySelectorAll('[data-screen="issues"] article[data-issue="1"] dt')].find((dt) => dt.textContent.trim() === "Labels");
      return rows ? rows.nextElementSibling.innerText.split(/\s+/).filter(Boolean) : null;
    });
    assertEqual(labels, ["Issue", "frage", "ui"], "work item type first, then the tags");
    assertMatch(await text(app, `${ISSUES} article[data-issue="1"] [data-issue-comments]`), /Danke fürs Ansehen!/, "work item comment");
    const comments = azureCalls(mock, "GET", /workItems\/1\/comments$/).at(-1);
    assertEqual(comments?.query["api-version"], "7.1-preview.4", "comments through the preview API");
    await t.shot("issues-azure-details");
    await t.noConsoleErrors(app);
  });
});

scenario("work items: state filter and search run as WIQL at the host, quotes are escaped", "edge", async (t) => {
  await withAzure(t, {}, async ({ app, mock }) => {
    await openIssues(app);
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "open list first");
    await app.click({ text: "Closed", within: `${ISSUES} [role="search"]` });
    await rowsAre(app, [12, 8, 4], "closed work items");
    assertMatch(wiqlQueries(mock).at(-1), /\[System\.State\] IN \(/, "WIQL for closed states");
    await app.click({ text: "All", within: `${ISSUES} [role="search"]` });
    await rowsAre(app, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], "all work items");
    assert(!/System\.State/.test(wiqlQueries(mock).at(-1)), "WIQL without state condition for all");

    await app.click({ text: "Open", within: `${ISSUES} [role="search"]` });
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "open again");
    const search = `${ISSUES} input[type="search"]`;
    await app.type(search, "Lena's Station");
    await app.press("Enter");
    await rowsAre(app, [2, 1], "search result");
    const searched = wiqlQueries(mock).at(-1);
    assertIncludes(searched, "[System.Title] CONTAINS 'Lena''s Station'", "title search with the quote doubled");
    assertIncludes(searched, "[System.Description] CONTAINS WORDS 'Lena''s Station'", "description search with the quote doubled");

    // Closed + search: nothing matches → empty state that names the search.
    await app.click({ text: "Closed", within: `${ISSUES} [role="search"]` });
    await app.waitFor(async () => (await issueRows(app)).length === 0 && /No issue matches “Lena's Station”/.test((await text(app, ISSUES)) ?? ""), 20_000, { message: "empty state names the search" });
    await t.shot("issues-search-empty");
    await app.click({ text: "Reset filters", within: ISSUES });
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "filters reset");
    assertEqual(await app.$(search).then((field) => field.prop("value")), "", "search field emptied");
    await t.noConsoleErrors(app);
  });
});

scenario("work items: “Assigned to me” keeps only the ones assigned to the account", "edge", async (t) => {
  await withAzure(t, {}, async ({ app }) => {
    await openIssues(app);
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "open list");
    await app.click(await checkbox(app, ISSUES, "Assigned to me"));
    await rowsAre(app, [2], "only #2 is assigned to lena@example.org");
    assertMatch(await text(app, `${ISSUES} [data-issues-footer]`), /1 of 9 loaded issues/, "footer: shown of loaded");
    await t.noConsoleErrors(app);
  });
});

scenario("work items: create a work item with a multi-line description", "main", async (t) => {
  await withAzure(t, {}, async ({ app, mock, proxy, tabId }) => {
    serveCreatedWorkItems(proxy, mock);
    await openIssues(app);
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "open list");
    await app.click(`${ISSUES} [data-action="issues-create"]`);
    await app.waitFor('[data-screen="issue-create"]', 10_000, { message: "create dialog" });
    assertMatch(await dialogText(app, /New work item/), /projekt\/demo/, "dialog says where it is created");
    const title = "Messwerte von Station West fehlen";
    await app.type('[data-screen="issue-create"] input[name="title"]', title);
    await app.type('[data-screen="issue-create"] textarea[name="body"]', "Seit Montag fehlen die Werte.Zeile <b>2</b> & mehr");
    await t.shot("issues-create-dialog-azure");
    await app.click({ text: "Create", within: '[role="dialog"]:has([data-screen="issue-create"])' });
    await waitToast(app, "success", /Work item #501 created/);
    assertEqual(mock.state.workItems, [{ id: 501, title }], "created at the host");
    const call = azureCalls(mock, "POST", /_apis\/wit\/workitems\/\$Issue$/)[0];
    assert(call, "POST …/workitems/$Issue");
    assertMatch(String(call.headers["content-type"]), /application\/json-patch\+json/, "sent as JSON Patch");
    assertEqual(call.body, [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: "/fields/System.Description", value: "Seit Montag fehlen die Werte.<br>Zeile &lt;b&gt;2&lt;/b&gt; &amp; mehr" },
    ], "title and the description as escaped HTML with <br>");
    // The new work item opens.
    await app.waitFor(`${ISSUES} article[data-issue="501"][data-state="filled"]`, 20_000, { message: "details of #501" });
    const body = await text(app, `${ISSUES} article[data-issue="501"] [data-issue-body]`);
    assertMatch(body, /Seit Montag fehlen die Werte\.\s*Zeile <b>2<\/b> & mehr/, "description shown as plain text, markup not interpreted");
    assertEqual(await app.exec(() => document.querySelectorAll('[data-screen="issues"] article[data-issue="501"] [data-issue-body] b').length), 0, "no <b> element from the text");
    assertEqual(await app.exec((tab) => window.__gc.store.getState().views[tab]?.center ?? null, tabId).then((center) => center?.number), 501, "view shows #501");
    await t.shot("issues-created-azure");
    await t.noConsoleErrors(app);
  });
});

scenario("work items: create dialog checks the title and Escape cancels without sending", "edge", async (t) => {
  await withAzure(t, {}, async ({ app, mock }) => {
    await openIssues(app);
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "open list");
    await app.click(`${ISSUES} [data-action="issues-create"]`);
    await app.waitFor('[data-screen="issue-create"]', 10_000);
    await app.click({ text: "Create", within: '[role="dialog"]:has([data-screen="issue-create"])' });
    await app.waitFor(async () => /The title must not be empty\./.test((await text(app, '[data-screen="issue-create"]')) ?? ""), 5000, { message: "empty title error" });
    await fill(app, '[data-screen="issue-create"] input[name="title"]', "x".repeat(256));
    await app.click({ text: "Create", within: '[role="dialog"]:has([data-screen="issue-create"])' });
    await app.waitFor(async () => /at most 255 characters/.test((await text(app, '[data-screen="issue-create"]')) ?? ""), 5000, { message: "too long error" });
    await t.shot("issues-create-validation");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="issue-create"]')), 5000, { message: "Escape closes the dialog" });
    assertEqual(azureCalls(mock, "POST", /_apis\/wit\/workitems\//).length, 0, "nothing sent to the host");
    assertEqual(mock.state.workItems, [], "nothing created");
    assert(await app.$(ISSUES), "issues view stays open");
    await t.noConsoleErrors(app);
  });
});

scenario("work items: branch for a work item, named from number and title, checked out", "main", async (t) => {
  await withAzure(t, {}, async ({ app, repo }) => {
    await openIssues(app);
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "open list");
    await app.click(`${ISSUES} [data-issue-row="2"]`);
    await app.waitFor(`${ISSUES} article[data-issue="2"][data-state="filled"]`, 20_000);
    await app.click(`${ISSUES} [data-action="issue-branch"]`);
    const input = await app.waitFor('[role="dialog"] input', 10_000, { message: "branch name dialog" });
    assertEqual(await input.prop("value"), "2-problem-2", "name suggested from number and title");
    assertMatch(await dialogText(app, /Branch for issue #2/), /starts at the current commit \(main\)/, "dialog says where the branch starts");
    await t.shot("issues-branch-dialog");
    await app.click({ text: "Create branch", within: '[role="dialog"]' });
    await eventually(() => git(repo.path, "rev-parse", "--abbrev-ref", "HEAD"), "2-problem-2", "branch created and checked out", 20_000);
    assertEqual(git(repo.path, "rev-parse", "2-problem-2"), git(repo.path, "rev-parse", "main"), "branch starts at main");
    await waitToast(app, "success", /Branch “2-problem-2” created and checked out/);
    await t.noConsoleErrors(app);
  });
});

scenario("work items: rejected token shows the problem with the way to the integrations, retry loads", "edge", async (t) => {
  await withAzure(t, {}, async ({ app, mock }) => {
    mock.fail("unauthorized", { match: "/wit/" });
    await openIssues(app);
    const problem = await app.waitFor(`${ISSUES} [data-issues-state="auth"]`, 20_000, { message: "auth problem state" });
    assertMatch(await problem.text(), /Open integrations/, "offers the integrations");
    await t.shot("issues-token-rejected");
    mock.recover();
    await app.click({ text: "Try again", within: ISSUES });
    await rowsAre(app, [11, 10, 9, 7, 6, 5, 3, 2, 1], "list after retrying");
    await t.noConsoleErrors(app);
  });
});

scenario("work items: not connected – the view says so and leads to the integrations", "edge", async (t) => {
  await withAzure(t, { connect: false }, async ({ app, mock }) => {
    await openIssues(app);
    const state = await app.waitFor(`${ISSUES} [data-issues-state="not_connected"]`, 20_000, { message: "not connected state" });
    assertMatch(await state.text(), /Not connected to Azure DevOps/, "names the host");
    assertMatch(await state.text(), /projekt\/demo/, "names project and repository");
    assertEqual(azureCalls(mock).length, 0, "without an account nothing goes to the host");
    await app.click({ text: "Connect account …", within: ISSUES });
    await app.waitFor('[data-screen="hosts"]', 10_000, { message: "Settings › Hosts" });
    await t.noConsoleErrors(app);
  });
});
