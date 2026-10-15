/**
 * GitHub and GitLab in the real app: connect an account (Settings › Hosts), create, view, merge,
 * close and comment pull/merge requests, and the issues (list, details, filter, branch from an
 * issue). Hosts: only scripts/e2e/host-mock.mjs, reached through a local proxy that also serves
 * real Git over HTTP (scripts/e2e-wd/fixtures/github-gitlab-host.mjs), so push and fetch run for real.
 *
 *   node scripts/e2e-wd/features/github-gitlab.mjs
 *   E2E_WD_ONLY=merge node scripts/e2e-wd/features/github-gitlab.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { startForge } from "../fixtures/github-gitlab-host.mjs";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const W = 1440;
const H = 900;
/** Every launch uses the forge's private keychain (see fixtures/github-gitlab-host.mjs). */
const launch = (t, forge, extra = {}) => t.launch({ width: W, height: H, theme: "light", lang: "en", ...extra, env: { ...forge.appEnv, ...(extra.env ?? {}) } });

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a command through the command palette (Ctrl+P, ">" + text, pick the entry with this id). */
async function palette(app, text, commandId) {
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const optionCss = `[data-screen="command-palette"] [role="option"][data-key="command:${commandId}"]`;
  for (let attempt = 0; ; attempt++) {
    try {
      // The list re-renders while the filter settles: find the entry again if it went stale.
      await app.click(await app.waitFor(optionCss, 10_000, { message: `palette entry ${commandId}` }));
      break;
    } catch (error) {
      if (attempt < 3 && /stale element|not interactable/.test(error.message)) {
        await sleep(200);
        continue;
      }
      throw error;
    }
  }
  await app.waitFor(async () => !(await app.$('[data-screen="command-palette"]')), 10_000, { message: "palette closed" });
}

const toasts = (app) =>
  app.exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));

async function waitToast(app, tone, pattern, timeout = 20_000) {
  return app.waitFor(async () => (await toasts(app)).find((toast) => toast.tone === tone && pattern.test(toast.text)), timeout, { message: `${tone} toast ${pattern}` });
}

const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
const attr = (app, css, name) => app.exec((selector, key) => document.querySelector(selector)?.getAttribute(key) ?? null, css, name);
const count = (app, css) => app.exec((selector) => document.querySelectorAll(selector).length, css);

/** Waits until fn() deep-equals expected (JSON); throws with the last value. */
async function eventually(fn, expected, message, timeout = 15_000) {
  let last;
  try {
    return await waitForValue(async () => {
      last = await fn();
      return JSON.stringify(last) === JSON.stringify(expected);
    }, timeout);
  } catch {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, last ${JSON.stringify(last)}`);
  }
}
async function waitForValue(fn, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error("timeout");
    await sleep(120);
  }
}

/** The token must not appear in the DOM (incl. attributes and field values), storage or the data folder. */
async function assertNoTokenLeak(app, token, where) {
  const inPage = await app.exec((secret) => {
    const hits = [];
    if (document.documentElement.outerHTML.includes(secret)) hits.push("dom");
    for (const field of document.querySelectorAll("input, textarea")) if (field.value.includes(secret)) hits.push(`field ${field.name}`);
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) if ((store.getItem(store.key(i)) ?? "").includes(secret)) hits.push("storage");
    try {
      const cache = JSON.stringify(window.__gc.queryClient.getQueryCache().getAll().map((query) => query.state.data ?? null));
      if (cache.includes(secret)) hits.push("query cache");
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

/** Connects an account through the core (fast path for scenarios that are not about connecting). */
async function connect(app, forge, kind, token = forge.token) {
  const account = await app.invoke("host_connect", { kind, baseUrl: forge.url, token });
  await app.exec(() =>
    Promise.all([
      window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "hostAccounts"] }),
      window.__gc.queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" }),
    ]).then(() => true),
  );
  await app.settle();
  return account;
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
const center = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.center ?? null, tabId);

/** Opens Settings › Hosts. */
async function openHosts(app) {
  await palette(app, "Open integrations", "hosts.open");
  await app.waitFor('[data-screen="hosts"]', 15_000);
  await app.waitFor(async () => (await attr(app, '[data-screen="hosts"]', "data-state")) !== "loading", 15_000);
}

const CONNECT_DIALOG = '[role="dialog"]:has([data-screen="hosts-connect"])';

/** Fills the connect dialog: host, self-hosted address, token, then submit. */
async function fillConnectDialog(app, { kind, url, token }) {
  const dialog = '[data-screen="hosts-connect"]';
  await app.waitFor(dialog, 10_000);
  await press(app, kind === "gitlab" ? "GitLab" : "GitHub", dialog);
  await press(app, "Self-hosted", dialog);
  const base = await app.waitFor(`${dialog} input[name="baseUrl"]`, 5000);
  await app.type(base, url);
  await app.type(`${dialog} input[name="token"]`, token);
  await press(app, "Connect", CONNECT_DIALOG);
}

/** Topmost open dialog (confirmations stack on top of e.g. the settings dialog). */
const TOP_DIALOG = "top-dialog";

/**
 * Finds a clickable control (button, radio, tab, option) whose text is `label` (an ending " …" is
 * ignored) inside the LAST element matching `scope`, scrolls it into view and returns it.
 */
async function control(app, label, scope = "body", timeout = 10_000) {
  return app.waitFor(
    () =>
      app.exec((wanted, css, top) => {
        const norm = (v) => (v ?? "").replace(/\s+/g, " ").trim().replace(/\s*…$/, "");
        wanted = norm(wanted);
        const roots = css === top ? [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')] : [...document.querySelectorAll(css)];
        const root = roots[roots.length - 1];
        if (!root) return null;
        const found = [...root.querySelectorAll('button, [role="radio"], [role="tab"], [role="option"], [role="checkbox"]')].find(
          (el) => norm(el.innerText) === wanted || norm(el.getAttribute("aria-label")) === wanted,
        );
        if (!found) return null;
        found.scrollIntoView({ block: "center" });
        return found;
      }, label, scope, TOP_DIALOG),
    timeout,
    { message: `control "${label}" in ${scope}` },
  );
}
async function press(app, label, scope) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await app.click(await control(app, label, scope));
    } catch (error) {
      // Re-rendered between finding and clicking: find it again.
      if (attempt < 3 && /stale element|not interactable/.test(error.message)) {
        await sleep(200);
        continue;
      }
      throw error;
    }
  }
}

/** Focuses a field (scrolled into view) and empties it with the keyboard. */
async function clearField(app, css) {
  await app.exec((selector) => {
    const el = document.querySelector(selector);
    el.scrollIntoView({ block: "center" });
    el.focus();
    el.select?.();
    return true;
  }, css);
  await app.press("Control+a", "Backspace");
}

// ---------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------

scenario("connect github account in settings and disconnect it again", "main", async (t) => {
  const forge = await startForge();
  let app = null;
  try {
    app = await launch(t, forge);
    await openHosts(app);
    assertEqual(await attr(app, '[data-screen="hosts"]', "data-state"), "empty", "no account yet");
    t.step("Settings › Hosts is empty");
    await press(app, "Connect account …", '[data-screen="hosts"]');
    await fillConnectDialog(app, { kind: "github", url: forge.url, token: forge.token });
    await app.waitFor(async () => !(await app.$('[data-screen="hosts-connect"]')), 20_000, { message: "dialog closes after connecting" });
    const row = '[data-screen="hosts"] [data-account][data-kind="github"]';
    await app.waitFor(row, 10_000);
    assertEqual(await attr(app, row, "data-state"), "ok", "account state");
    const rowText = await text(app, row);
    assertIncludes(rowText, "Connected as Lena Hartmann", "row names the user");
    assertIncludes(rowText, `Token ends in ${forge.token.slice(-4)}`, "only the last four characters");
    await waitToast(app, "success", /Connected to GitHub as Lena Hartmann/);
    const accounts = await app.invoke("host_accounts");
    assertEqual(accounts.map((a) => [a.kind, a.baseUrl, a.user?.login]), [["github", forge.url, "lena-hartmann"]], "core keeps the account");
    assert(forge.mock.requests.some((r) => r.path === "/api/v3/user" && r.status === 200), "token was checked against GET /user");
    await assertNoTokenLeak(app, forge.token, "after connecting");
    await t.shot("connect-github-account", app);

    await app.click(`${row} button[aria-label^="Disconnect"]`);
    // The app asks first.
    await press(app, "Disconnect account", TOP_DIALOG);
    await eventually(() => attr(app, '[data-screen="hosts"]', "data-state"), "empty", "list empty after disconnecting", 15_000);
    assertEqual(await app.invoke("host_accounts"), [], "core has no account any more");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("connect dialog: wrong token is rejected and nothing is stored", "edge", async (t) => {
  const forge = await startForge();
  let app = null;
  try {
    app = await launch(t, forge);
    await openHosts(app);
    await press(app, "Connect account …", '[data-screen="hosts"]');
    await fillConnectDialog(app, { kind: "github", url: forge.url, token: forge.badToken });
    const error = await app.waitFor('[data-screen="hosts-connect"] [data-connect-error]', 20_000, { message: "error in the dialog" });
    assertEqual(await error.attr("data-connect-error"), "auth", "kind of error");
    assertMatch(await error.text(), /rejected the token/i, "error text");
    assertEqual(await app.exec(() => document.querySelector('[data-screen="hosts-connect"] input[name="token"]').value), "", "token field cleared");
    assertEqual(await app.invoke("host_accounts"), [], "no account stored");
    assert(forge.mock.requests.some((r) => r.path === "/api/v3/user" && r.status === 401), "the core asked GET /user and got 401");
    await assertNoTokenLeak(app, forge.badToken, "after the rejected attempt");
    await t.shot("connect-wrong-token", app);
    // Escape closes the dialog without an account.
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="hosts-connect"]')), 5000, { message: "Escape closes the dialog" });
    assertEqual(await attr(app, '[data-screen="hosts"]', "data-state"), "empty", "list still empty");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("gitlab token without api scope is marked as missing permissions", "edge", async (t) => {
  const forge = await startForge();
  let app = null;
  try {
    app = await launch(t, forge);
    await openHosts(app);
    await press(app, "Connect account …", '[data-screen="hosts"]');
    await fillConnectDialog(app, { kind: "gitlab", url: forge.url, token: forge.weakToken });
    const row = '[data-screen="hosts"] [data-account][data-kind="gitlab"]';
    await app.waitFor(row, 20_000, { message: "gitlab account row" });
    await eventually(() => attr(app, row, "data-state"), "scopes", "state: missing permissions");
    const [account] = await app.invoke("host_accounts");
    assertEqual([account.kind, account.scopesOk], ["gitlab", false], "core: scopes not ok");
    assert(forge.mock.requests.some((r) => r.path === "/api/v4/personal_access_tokens/self"), "the core checked the token scopes");
    await t.shot("gitlab-weak-token", app);
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Pull requests: create
// ---------------------------------------------------------------------------------------------

const PRC = '[data-screen="pr-create"]';

/** A local branch with one commit that is not pushed yet, checked out. */
function localTopicBranch(repo, branch, message) {
  repo.git("checkout", "-q", "-b", branch, "main");
  repo.write("auswertung.md", "# Auswertung\n\nMonatsmittel je Station.\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

async function openCreateForm(app) {
  await palette(app, "Create pull request", "pr.create");
  await app.waitFor(`${PRC} form[data-pr-state="form"]`, 30_000, { message: "pull request form" });
}

const fieldValue = (app, css) => app.exec((selector) => document.querySelector(selector)?.value ?? null, css);

scenario("create github pull request from an unpushed branch (push first, then create)", "main", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  const branch = "thema/neue-auswertung";
  const sha = localTopicBranch(repo, branch, "Auswertung als eigenes Dokument");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    assertEqual(forge.bareBranch("github", branch), null, "branch is not on the server yet");
    await openCreateForm(app);
    await eventually(() => fieldValue(app, `${PRC} input[name="title"]`), "Auswertung als eigenes Dokument", "title = the only commit");
    const steps = await text(app, `${PRC} [data-pr-steps]`);
    assertMatch(steps, /push/i, "the form says the branch is pushed first");
    await app.type(`${PRC} textarea[name="body"]`, "Neue Auswertung je Station.");
    await app.press("Enter", "Enter");
    await app.type(`${PRC} textarea[name="body"]`, "- [x] Tests");
    await t.shot("create-github-pull-request", app);
    await app.click(`${PRC} button[type="submit"]`);
    await app.waitFor('[data-screen="pr-view"][data-pr-number="101"] [data-pr-head]', 40_000, { message: "view of the new pull request" });
    await waitToast(app, "success", /Pull request #101 created/);
    // Host side
    const created = forge.mock.state.created;
    assertEqual(created.map((c) => [c.number, c.title, c.source, c.target, c.draft]), [[101, "Auswertung als eigenes Dokument", branch, "main", false]], "the host got the pull request");
    assertEqual(created[0].body, "Neue Auswertung je Station.\n\n- [x] Tests", "description sent with its line breaks");
    // Git side: really pushed, upstream set
    assertEqual(forge.bareBranch("github", branch), sha, "branch pushed to the server with the local commit");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", `${branch}@{upstream}`), `origin/${branch}`, "upstream set locally");
    assertIncludes(await text(app, '[data-screen="pr-view"] [data-pr-title]'), "Auswertung als eigenes Dokument #101", "view title");
    assertEqual((await center(app, tabId))?.kind, "pr", "centre shows the pull request");
    await t.shot("create-github-pull-request-done", app);
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("create pull request: empty title, existing pull request at the host, leave with unsent text", "edge", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  // The mock rejects a new pull request from "schon-da" as a duplicate (422).
  localTopicBranch(repo, "schon-da", "Doppelte Auswertung");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await openCreateForm(app);
    await eventually(() => fieldValue(app, `${PRC} input[name="title"]`), "Doppelte Auswertung", "prefilled title");

    // 1. Empty title: nothing is sent.
    const before = forge.mock.requests.filter((r) => r.method === "POST").length;
    await clearField(app, `${PRC} input[name="title"]`);
    await app.click(`${PRC} button[type="submit"]`);
    await app.waitFor(async () => /title/i.test((await text(app, PRC)) ?? "") && (await app.exec(() => document.activeElement?.getAttribute("name"))) === "title", 5000, { message: "title error, focus in the title" });
    assertMatch(await text(app, PRC), /title (is required|must not be empty)|enter a title/i, "error names the title");
    assertEqual(forge.mock.requests.filter((r) => r.method === "POST").length, before, "no request to the host");
    assertEqual(forge.bareBranch("github", "schon-da"), null, "nothing pushed either");

    // 2. Host rejects as duplicate: the error stays in the form.
    await app.type(`${PRC} input[name="title"]`, "Doppelte Auswertung");
    await app.click(`${PRC} button[type="submit"]`);
    const error = await app.waitFor(`${PRC} [data-pr-error]`, 40_000, { message: "error in the form" });
    const errorText = await error.text();
    assertMatch(errorText, /already (exists|an open pull request)/i, "the host's reason is shown");
    assertEqual(forge.mock.state.created, [], "nothing created at the host");
    assert(forge.mock.requests.some((r) => r.method === "POST" && r.path === "/api/v3/repos/octo/demo/pulls" && r.status === 422), "POST /pulls answered 422");
    assert(forge.bareBranch("github", "schon-da"), "the branch was pushed before");
    assertEqual((await center(app, tabId))?.kind, "pr_create", "form stays open");
    await t.shot("create-pull-request-duplicate", app);

    // 3. Leaving with typed text asks first; "Cancel" keeps the form.
    await app.type(`${PRC} textarea[name="body"]`, "Noch nicht fertig");
    await app.click(`${PRC} [data-back]`);
    const ask = await app.waitFor('[role="alertdialog"]:not(:has([data-screen])), [role="dialog"]:not(:has([data-screen]))', 5000, { message: "leave confirmation" });
    assertMatch(await ask.text(), /Discard/i, "asks to discard");
    await press(app, "Cancel", TOP_DIALOG);
    await app.waitFor(async () => !(await app.$('[role="alertdialog"]:not(:has([data-screen])), [role="dialog"]:not(:has([data-screen]))')), 5000);
    assertEqual((await center(app, tabId))?.kind, "pr_create", "still in the form after cancel");
    assertEqual(await fieldValue(app, `${PRC} textarea[name="body"]`), "Noch nicht fertig", "text kept");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("create gitlab merge request from a pushed branch", "main", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("gitlab");
  let app = null;
  try {
    // feature/export is already pushed (fixture) – no push step needed.
    repo.git("checkout", "-q", "feature/export");
    app = await launch(t, forge);
    await app.openRepo(repo.path);
    await connect(app, forge, "gitlab");
    const pushesBefore = forge.gitRequests.filter((r) => r.path.includes("git-receive-pack")).length;
    await openCreateForm(app);
    await eventually(() => fieldValue(app, `${PRC} input[name="title"]`), "CSV-Export für den Vergleich", "title = the only commit");
    assertMatch(await text(app, PRC), /merge request/i, "GitLab wording: merge request");
    await clearField(app, `${PRC} input[name="title"]`);
    await app.type(`${PRC} input[name="title"]`, "CSV-Export: Vergleich als Datei");
    await t.shot("create-gitlab-merge-request", app);
    await app.exec((css) => document.querySelector(css).focus() ?? true, `${PRC} input[name="title"]`);
    await app.press("Control+Enter");
    await app.waitFor('[data-screen="pr-view"][data-pr-number="101"] [data-pr-head]', 40_000, { message: "view of the new merge request" });
    const post = forge.mock.requests.find((r) => r.method === "POST" && r.path === "/api/v4/projects/gruppe%2Funter%2Fdemo/merge_requests");
    assert(post, "POST merge_requests sent");
    assertEqual([post.body.title, post.body.source_branch, post.body.target_branch], ["CSV-Export: Vergleich als Datei", "feature/export", "main"], "merge request body");
    assertEqual(forge.gitRequests.filter((r) => r.path.includes("git-receive-pack")).length, pushesBefore, "no push for an already pushed branch");
    assertEqual(forge.bareBranch("gitlab", "feature/export"), repo.git("rev-parse", "feature/export"), "server branch = local branch");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Pull requests: view, comment, merge, close
// ---------------------------------------------------------------------------------------------

const PRV = '[data-screen="pr-view"]';
const SECTION = '[data-extra-section="pull-requests"]';

async function openPrView(app, tabId, number) {
  await setCenter(app, tabId, { kind: "pr", number });
  await app.waitFor(`${PRV}[data-pr-number="${number}"] [data-pr-head]`, 30_000, { message: `view of #${number}` });
  await app.settle();
}

/** Expands the "Pull requests" section of the sidebar (collapsed by default) and waits for rows. */
async function expandPrSection(app) {
  await app.waitFor(SECTION, 20_000, { message: "Pull requests section in the sidebar" });
  const header = `${SECTION} [data-section-header] button`;
  if ((await attr(app, header, "aria-expanded")) !== "true") await app.click(header);
  await eventually(() => attr(app, header, "aria-expanded"), "true", "section expanded", 5000);
}

const sectionRows = (app) => app.exec((css) => [...document.querySelectorAll(`${css} [data-kind="pull-request"]`)].map((row) => Number(row.dataset.pr)), SECTION);

scenario("view github pull request from the sidebar: header, checks, review, comments, commits", "main", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await expandPrSection(app);
    const rows = await app.waitFor(async () => {
      const list = await sectionRows(app);
      return list.length > 0 ? list : null;
    }, 20_000, { message: "rows in the section" });
    // Mock: open = number not ending in 0 or 5; the section shows a page of them.
    assert(rows.every((n) => n % 5 !== 0), `only open pull requests (${rows})`);
    assertEqual(rows.length, 20, "first page: 20 rows (more via “Load more”)");
    // The panel filter narrows the loaded rows (title, author, branch).
    await app.type('input[placeholder^="Filter"]', "Thema 44");
    await eventually(() => sectionRows(app), [44], "panel filter: only #44");
    await app.click(`${SECTION} [data-pr="44"]`);
    await app.waitFor(`${PRV}[data-pr-number="44"] [data-pr-head]`, 30_000, { message: "view opens on click" });
    assertEqual(await center(app, tabId), { kind: "pr", number: 44 }, "centre: pull request 44");
    assertEqual(await attr(app, `${SECTION} [data-pr="44"]`, "aria-current"), "true", "row marked as current");
    assertIncludes(await text(app, `${PRV} [data-pr-head]`), "Thema 44 umsetzen #44", "title of the clicked row");
    await clearField(app, 'input[placeholder^="Filter"]');
    // #1 (checks, approval, labels, review comment) is not on the first page: open it directly.
    await openPrView(app, tabId, 1);
    const head = await text(app, `${PRV} [data-pr-head]`);
    assertIncludes(head, "Anmeldung: Fehlermeldung bei leerem Passwort #1", "title and number");
    assertIncludes(head, "feature/thema-1", "source branch");
    assertMatch(head, /Open/, "state open");
    assertEqual(await attr(app, `${PRV} [data-pr-phase]`, "data-pr-phase"), "open", "phase");
    assertMatch(await text(app, `${PRV} [data-review]`), /Approved/i, "review state approved");
    const body = await text(app, `${PRV} [data-pr-body]`);
    assertIncludes(body, "Beschreibung zu Thema 1", "markdown description rendered");
    assertEqual(await count(app, `${PRV} [data-pr-body] strong`), 1, "bold rendered as <strong>");
    const comments = await text(app, `${PRV} [data-pr-comments]`);
    assertIncludes(comments, "Hier fehlt die Prüfung auf leer.", "review comment shown");
    assertIncludes(await text(app, `${PRV} [data-pr-labels]`), "bug", "label shown");
    await t.shot("view-github-pull-request", app);
    // Commits tab
    await app.click(await app.waitFor(() => app.byText("^Commits", { regex: true, within: `${PRV} [role="tablist"]` })));
    await app.waitFor(`${PRV} [data-pr-commits] [data-commit]`, 10_000, { message: "commit list" });
    const commits = await app.exec((css) => [...document.querySelectorAll(`${css} [data-pr-commits] [data-commit]`)].map((el) => el.innerText.replace(/\s+/g, " ")), PRV);
    assertEqual(commits.length, 2, "two commits");
    assert(commits.some((c) => c.includes("Prüfung ergänzt")), `commit summary shown (${commits})`);
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("sidebar: load more pull requests, the button sits below the list", "edge", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await expandPrSection(app);
    await app.waitFor(async () => (await sectionRows(app)).length === 20, 20_000, { message: "first page of 20" });
    assertMatch(await text(app, `${SECTION} [data-section-header]`), /20\+/, "header count says there are more");
    const more = await control(app, "Load more", SECTION);
    // Where is the button compared with the rows it extends? (measured before it disappears)
    const layout = await app.exec((css, button) => {
      const rowsEls = document.querySelectorAll(`${css} [data-kind="pull-request"]`);
      return { button: Math.round(button.getBoundingClientRect().top), firstRow: Math.round(rowsEls[0].getBoundingClientRect().top), lastRow: Math.round(rowsEls[rowsEls.length - 1].getBoundingClientRect().top) };
    }, SECTION, more);
    await t.shot("pull-requests-load-more", app);
    await app.click(more);
    // Mock: 36 open pull requests -> page 2 brings the last 16.
    await app.waitFor(async () => (await sectionRows(app)).length === 36, 20_000, { message: "second page loaded (36 rows)" });
    assert(forge.mock.requests.some((r) => r.path === "/api/v3/repos/octo/demo/pulls" && r.query.page === "2"), "page 2 asked at the host");
    assertIncludes(await sectionRows(app), 1, "#1 is listed now");
    assertEqual(await control(app, "Load more", SECTION, 1000).catch(() => null), null, "no further “Load more” at the end");
    assertMatch(await text(app, `${SECTION} [data-section-header]`), /36(?!\+)/, "header count without “+”");
    // The button belongs below the rows it extends; it is rendered above them.
    assert(layout.button > layout.lastRow, `“Load more” is above the list (button y=${layout.button}, first row y=${layout.firstRow}, last row y=${layout.lastRow})`);
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("pull request view: unknown number and host throttling", "edge", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await setCenter(app, tabId, { kind: "pr", number: 999 });
    await app.waitFor(`${PRV} [data-pr-state="error-not_found"]`, 20_000, { message: "not-found state" });
    assertMatch(await text(app, PRV), /999/, "names the number");
    await t.shot("pull-request-not-found", app);
    // Throttled list: the section says so instead of an empty list.
    await expandPrSection(app);
    forge.mock.fail("rate_limit", { match: "/pulls" });
    await palette(app, "Refresh pull requests", "pr.refresh");
    await app.waitFor(`${SECTION} [data-pr-section^="error-"], ${SECTION} [data-pr-section="stale"]`, 20_000, { message: "section reports the limit" });
    assertMatch(await text(app, SECTION), /limit|throttl|rate/i, `section text names the limit`);
    forge.mock.recover();
    await t.shot("pull-requests-rate-limited", app);
    // Errors from the host are shown in the UI, not as console errors.
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("comment on a github pull request with ctrl+enter", "main", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await openPrView(app, tabId, 1);
    const field = `${PRV} [data-comment-form] textarea[name="comment"]`;
    const submit = `${PRV} [data-comment-form] button[type="submit"]`;
    assertEqual(await app.exec((css) => document.querySelector(css).disabled, submit), true, "send is disabled while empty");
    await app.type(field, "   ");
    assertEqual(await app.exec((css) => document.querySelector(css).disabled, submit), true, "only spaces: still disabled");
    await clearField(app, field);
    await app.type(field, "Getestet mit **leerem** Passwort – passt.");
    await t.shot("comment-github-pull-request", app);
    await app.press("Control+Enter");
    await waitToast(app, "success", /Comment sent/);
    await eventually(() => fieldValue(app, field), "", "field emptied after sending");
    assertEqual(forge.mock.state.comments.map((c) => [c.number, c.body]), [[1, "Getestet mit **leerem** Passwort – passt."]], "the host got the comment");
    await app.waitFor(async () => /Getestet mit leerem Passwort/.test((await text(app, `${PRV} [data-pr-comments]`)) ?? ""), 15_000, { message: "comment in the list" });
    await t.shot("comment-github-pull-request-done", app);
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("comment fails at the host: text stays, error is shown", "edge", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await openPrView(app, tabId, 2);
    const field = `${PRV} [data-comment-form] textarea[name="comment"]`;
    forge.mock.fail("server_error", { match: "/comments", times: 1 });
    // Only the POST should fail; reads of comments already ran.
    await app.type(field, "Bitte noch einmal ansehen.");
    await app.click(`${PRV} [data-comment-form] button[type="submit"]`);
    await waitToast(app, "danger", /./);
    assertEqual(await fieldValue(app, field), "Bitte noch einmal ansehen.", "text kept for another try");
    assertEqual(forge.mock.state.comments, [], "nothing stored at the host");
    await t.shot("comment-fails", app);
    // Second try works.
    await app.click(`${PRV} [data-comment-form] button[type="submit"]`);
    await waitToast(app, "success", /Comment sent/);
    assertEqual(forge.mock.state.comments.map((c) => c.number), [2], "second try reaches the host");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

/** Simulates what the host does on merge: a new commit on main in the bare repository (filesystem push). */
function hostMergeCommit(forge, repo, kind, message) {
  const bare = path.join(forge.git.reposDir, `${{ github: "octo/demo", gitlab: "gruppe/unter/demo" }[kind]}.git`);
  const tree = repo.git("rev-parse", "origin/main^{tree}");
  const sha = repo.git("commit-tree", tree, "-p", "origin/main", "-m", message);
  repo.git("push", "-q", bare, `${sha}:refs/heads/main`);
  return sha;
}

scenario("merge github pull request with squash and delete the branch, then fetch", "main", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    const localMain = repo.git("rev-parse", "main");
    await openPrView(app, tabId, 1);
    assertEqual(await count(app, `${PRV} [data-merge-blocked]`), 0, "#1 is not blocked");
    await press(app, "Merge", `${PRV} [data-pr-actions]`);
    await app.waitFor('[data-screen="pr-merge"]', 10_000, { message: "merge dialog" });
    await app.click('[data-screen="pr-merge"] [role="combobox"]');
    await app.click(await app.waitFor(() => app.byText("Squash", { within: '[role="listbox"]' }), 5000, { message: "squash option" }));
    await app.waitFor(async () => /squashed into a single one/.test((await text(app, '[data-screen="pr-merge"]')) ?? ""), 5000, { message: "hint for squash" });
    await app.click('[data-screen="pr-merge"] [role="checkbox"]');
    await t.shot("merge-github-pull-request", app);
    await press(app, "Merge", TOP_DIALOG);
    await waitToast(app, "success", /Pull request #1 merged/);
    const merge = forge.mock.requests.find((r) => r.method === "PUT" && r.path === "/api/v3/repos/octo/demo/pulls/1/merge");
    assert(merge, "PUT /pulls/1/merge sent");
    assertEqual(merge.body?.merge_method, "squash", "merge method squash");
    assert(forge.mock.requests.some((r) => r.method === "DELETE" && r.path.startsWith("/api/v3/repos/octo/demo/git/refs/heads/")), "source branch deleted at the host");
    assert(forge.mock.state.merged.has(1), "host: merged");
    await eventually(() => attr(app, `${PRV} [data-pr-phase]`, "data-pr-phase"), "merged", "view shows merged");
    assertEqual(await control(app, "Merge", `${PRV} [data-pr-actions]`, 1000).catch(() => null), null, "no merge button any more");
    // Nothing changed locally yet.
    assertEqual(repo.git("rev-parse", "main"), localMain, "local main untouched by the merge");
    // The host's merge commit arrives with "Fetch now".
    const merged = hostMergeCommit(forge, repo, "github", "Merge pull request #1");
    assert(repo.git("rev-parse", "origin/main") !== merged, "origin/main not yet updated");
    const fetchesBefore = forge.gitRequests.filter((r) => r.path.includes("git-upload-pack")).length;
    await press(app, "Fetch now", '[data-toast]');
    await app.waitFor(async () => repo.git("rev-parse", "origin/main") === merged, 30_000, { message: "origin/main = host's merge commit after fetch" });
    assert(forge.gitRequests.filter((r) => r.path.includes("git-upload-pack")).length > fetchesBefore, "a real fetch ran against the server");
    await t.shot("merge-github-pull-request-done", app);
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("merge blocked: draft, conflicts, failing checks; failed merge keeps the dialog", "edge", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    const blocked = async (number) => {
      await openPrView(app, tabId, number);
      const merge = await control(app, "Merge", `${PRV} [data-pr-actions]`, 3000).catch(() => null);
      const disabled = merge ? await app.exec((el) => el.disabled, merge) : null;
      return { disabled, reason: await text(app, `${PRV} [data-merge-blocked]`) };
    };
    const draft = await blocked(3);
    assertEqual(draft.disabled, true, "#3 draft: merge disabled");
    assertMatch(draft.reason, /draft/i, "#3 reason");
    const failing = await blocked(4);
    assertEqual(failing.disabled, true, "#4 failing check: merge disabled");
    assertMatch(failing.reason, /check failed/i, "#4 reason");
    const conflict = await blocked(13);
    assertEqual(conflict.disabled, true, "#13 not mergeable: merge disabled");
    assertMatch(conflict.reason, /conflict/i, "#13 reason");
    await t.shot("merge-blocked-conflicts", app);

    // #11: mergeable, but the host fails the merge once – the dialog stays open, nothing merged.
    await openPrView(app, tabId, 11);
    forge.mock.fail("server_error", { match: "/merge", times: 1 });
    await press(app, "Merge", `${PRV} [data-pr-actions]`);
    await app.waitFor('[data-screen="pr-merge"]', 10_000);
    await press(app, "Merge", TOP_DIALOG);
    await waitToast(app, "danger", /./);
    assert(await app.$('[data-screen="pr-merge"]'), "dialog stays open after the error");
    assert(!forge.mock.state.merged.has(11), "not merged at the host");
    // Cancel with Escape.
    // By design (escapeGuard.ts) an error toast on top closes first, the second Esc closes the dialog.
    await app.press("Escape");
    await eventually(async () => (await toasts(app)).length, 0, "1st Escape closes the error toast");
    assert(await app.$('[data-screen="pr-merge"]'), "dialog still open after the 1st Escape");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="pr-merge"]')), 5000, { message: "Escape closes the dialog" });
    assertEqual(await attr(app, `${PRV} [data-pr-phase]`, "data-pr-phase"), "open", "still open");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("close and reopen a github pull request", "edge", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await openPrView(app, tabId, 6);
    await press(app, "Close", `${PRV} [data-pr-actions]`);
    const ask = await app.waitFor('[role="alertdialog"]:not(:has([data-screen])), [role="dialog"]:not(:has([data-screen]))', 5000, { message: "close confirmation" });
    assertMatch(await ask.text(), /Close pull request #6\?/, "asks first");
    await press(app, "Close pull request", TOP_DIALOG);
    await waitToast(app, "success", /Pull request #6 closed/);
    assert(forge.mock.state.closed.has(6), "host: closed");
    await eventually(() => attr(app, `${PRV} [data-pr-phase]`, "data-pr-phase"), "closed", "view shows closed");
    await press(app, "Reopen", `${PRV} [data-pr-actions]`);
    await waitToast(app, "success", /Pull request #6 reopened/);
    assert(!forge.mock.state.closed.has(6), "host: open again");
    await eventually(() => attr(app, `${PRV} [data-pr-phase]`, "data-pr-phase"), "open", "view shows open again");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("gitlab merge request: view pipeline and approval, comment, merge", "main", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("gitlab");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "gitlab");
    await expandPrSection(app);
    assert((await sectionRows(app)).length > 0, "merge requests listed in the sidebar");
    await openPrView(app, tabId, 1);
    const head = await text(app, `${PRV} [data-pr-head]`);
    assertIncludes(head, "Thema 1 umsetzen", "title");
    assertMatch(await text(app, `${PRV} [data-review]`), /Approved/i, "approved by mira");
    assertIncludes(await text(app, `${PRV} [data-pr-comments]`), "Sieht gut aus.", "notes shown");
    assert(!/changed title from A to B/.test(await text(app, `${PRV} [data-pr-comments]`)), "system notes hidden");
    // comment
    const field = `${PRV} [data-comment-form] textarea[name="comment"]`;
    await app.type(field, "Pipeline grün, danke!");
    await app.press("Control+Enter");
    await waitToast(app, "success", /Comment sent/);
    assertEqual(forge.mock.state.comments.map((c) => [c.number, c.body]), [[1, "Pipeline grün, danke!"]], "note stored at the host");
    await t.shot("gitlab-merge-request", app);
    // merge (merge commit, keep the branch)
    await press(app, "Merge", `${PRV} [data-pr-actions]`);
    await app.waitFor('[data-screen="pr-merge"]', 10_000);
    await press(app, "Merge", TOP_DIALOG);
    await waitToast(app, "success", /#1 merged/);
    const merge = forge.mock.requests.find((r) => r.method === "PUT" && r.path === "/api/v4/projects/gruppe%2Funter%2Fdemo/merge_requests/1/merge");
    assert(merge, "PUT merge_requests/1/merge sent");
    assert(!merge.body?.should_remove_source_branch, "branch kept");
    await eventually(() => attr(app, `${PRV} [data-pr-phase]`, "data-pr-phase"), "merged", "view shows merged");
    assertEqual(forge.bareBranch("gitlab", "main"), repo.git("rev-parse", "origin/main"), "server main unchanged by the mock merge (Git untouched)");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

const ISSUES = '[data-screen="issues"]';
const issueRows = (app) => app.exec((css) => [...document.querySelectorAll(`${css} [data-issue-row]`)].map((row) => Number(row.dataset.issueRow)), ISSUES);

scenario("github issues: list, details with comments, branch for the issue", "main", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("github");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "github");
    await palette(app, "Show issues", "issues.show");
    await app.waitFor(`${ISSUES} [data-issue-row]`, 20_000, { message: "issue rows" });
    const rows = await issueRows(app);
    // Mock: 12 issues, divisible by 4 closed, divisible by 3 are pull requests (GitHub lists them as issues).
    assertEqual([...rows].sort((a, b) => a - b), [1, 2, 5, 7, 10, 11], "open issues without pull requests");
    assertEqual(forge.mock.requests.filter((r) => r.path === "/api/v3/repos/octo/demo/issues").length > 0, true, "issues loaded from the host");
    assert(!(await app.$(`${ISSUES} [data-action="issues-create"]`)), "GitHub: no create button (only Azure DevOps can create)");
    await app.click(`${ISSUES} [data-issue-row="2"]`);
    await app.waitFor(`${ISSUES} article[data-issue="2"][data-state="filled"]`, 20_000, { message: "details of #2" });
    const details = await text(app, `${ISSUES} article[data-issue="2"]`);
    assertIncludes(details, "Problem 2", "title");
    assertIncludes(details, "Text zu Problem 2", "description");
    assertIncludes(details, "Danke fürs Ansehen!", "comment");
    assertIncludes(details, "lena-hartmann", "assignee");
    assertEqual(await center(app, tabId), { kind: "issues", number: 2 }, "centre remembers the issue");
    await t.shot("github-issues", app);

    // Branch for the issue.
    await app.click(`${ISSUES} [data-action="issue-branch"]`);
    const dialog = await app.waitFor('[role="dialog"]:has(input)', 5000, { message: "branch dialog" });
    assertMatch(await dialog.text(), /Branch for issue #2/, "dialog names the issue");
    const name = await app.exec(() => document.querySelector('[role="dialog"] input').value);
    assertEqual(name, "2-problem-2", "suggested name from number and title");
    await app.press("Enter");
    await waitToast(app, "success", /2-problem-2.*checked out/);
    assertEqual(repo.git("symbolic-ref", "--short", "HEAD"), "2-problem-2", "branch created and checked out");
    assertEqual(repo.git("rev-parse", "2-problem-2"), repo.git("rev-parse", "main"), "starts at the previous commit");
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("issues: search, closed state, gitlab list and keyboard", "edge", async (t) => {
  const forge = await startForge();
  const repo = forge.makeRepo("gitlab");
  let app = null;
  try {
    app = await launch(t, forge);
    const { tabId } = await app.openRepo(repo.path);
    await connect(app, forge, "gitlab");
    await palette(app, "Show issues", "issues.show");
    await app.waitFor(`${ISSUES} [data-issue-row]`, 20_000, { message: "gitlab issue rows" });
    assertEqual([...(await issueRows(app))].sort((a, b) => a - b), [1, 2, 3, 5, 6, 7, 9, 10, 11], "gitlab: open issues");
    // Closed
    await press(app, "Closed", `${ISSUES} [role="search"]`);
    await eventually(async () => [...(await issueRows(app))].sort((a, b) => a - b), [4, 8, 12], "closed issues");
    assert(forge.mock.requests.some((r) => r.path.endsWith("/issues") && r.query.state === "closed"), "state=closed asked at the host");
    // Search runs at the host (mock: only 1 and 2 match).
    await press(app, "All", `${ISSUES} [role="search"]`);
    await app.type(`${ISSUES} input[type="search"]`, "Problem");
    await app.press("Enter");
    await eventually(async () => [...(await issueRows(app))].sort((a, b) => a - b), [1, 2], "search result");
    assert(forge.mock.requests.some((r) => r.path.endsWith("/issues") && r.query.search === "Problem"), "search sent to the host");
    // Keyboard: arrow down from the search field into the list, Enter opens.
    await app.click(`${ISSUES} input[type="search"]`);
    await app.press("ArrowDown");
    await app.waitFor(async () => (await app.exec(() => document.activeElement?.getAttribute("data-issue-row"))) !== null, 5000, { message: "focus in the list" });
    await app.press("Enter");
    await app.waitFor(`${ISSUES} article[data-issue][data-state="filled"]`, 15_000, { message: "details by keyboard" });
    await t.shot("issues-search-gitlab", app);
    // Escape closes the view (back to the graph).
    await app.click(`${ISSUES} [data-back]`);
    await app.waitFor(async () => (await center(app, tabId))?.kind !== "issues", 5000, { message: "view closed" });
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    await forge.close();
  }
});

scenario("issues without host or without account: clear empty states", "edge", async (t) => {
  const forge = await startForge();
  const hosted = forge.makeRepo("github");
  const plain = makeCleanRepoWithRemote({ name: "ohne-host" });
  let app = null;
  try {
    app = await launch(t, forge);
    // A remote on a local path: no host at all.
    const first = await app.openRepo(plain.path);
    await setCenter(app, first.tabId, { kind: "issues", number: null });
    await app.waitFor(`${ISSUES} [data-issues-state="no_host"]`, 15_000, { message: "no-host state" });
    assertMatch(await text(app, ISSUES), /No host detected/, "says no host");
    await t.shot("issues-no-host", app);
    // A forge remote, but no account: the self-hosted instance is unknown without an account, so
    // also "no host"; after connecting, the list appears without reopening the view.
    const second = await app.openRepo(hosted.path);
    await setCenter(app, second.tabId, { kind: "issues", number: null });
    await app.waitFor(`${ISSUES} [data-issues-state]`, 15_000);
    await connect(app, forge, "github");
    await app.waitFor(`${ISSUES} [data-issue-row]`, 20_000, { message: "list after connecting" });
    await t.noConsoleErrors(app);
  } finally {
    await disconnectAll(app);
    plain.cleanup();
    await forge.close();
  }
});
