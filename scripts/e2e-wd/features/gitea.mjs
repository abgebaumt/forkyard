/**
 * Gitea/Forgejo (v1.1) in the real app: connect an account, pull requests (list, view, comment,
 * merge, close/reopen, check out, create) and issues (list, details, filter, branch) – against a
 * local Gitea instance (scripts/e2e-wd/fixtures/gitea.mjs: API from scripts/e2e/host-mock.mjs plus
 * the repository `octo/demo` over Git smart HTTP on the same address). Nothing calls a real service.
 *
 *   node scripts/e2e-wd/features/gitea.mjs
 *   node scripts/e2e-wd/run.mjs gitea --only "merge"
 *
 * Every scenario checks the UI, what reached the host (mock requests) and – where Git is involved –
 * the repository itself. Every app gets a private Secret Service (fixtures/gitea-keyring.mjs), so
 * test tokens never reach the user's keychain.
 */
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { startGitea } from "../fixtures/gitea.mjs";
import { startPrivateKeyring } from "../fixtures/gitea-keyring.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const CONNECT = '[data-screen="hosts-connect"]';
const HOSTS = '[data-screen="hosts"]';
const PR_SECTION = '[data-extra-section="pull-requests"]';
const PR_VIEW = '[data-screen="pr-view"]';
const PR_CREATE = '[data-screen="pr-create"]';
const ISSUES = '[data-screen="issues"]';
const OPEN_PRS = 36; // 45 in the mock, minus 4 merged (…0) and 5 closed (…5)

// --- helpers ---------------------------------------------------------------------------------

/**
 * Repository `demo` with origin = the local Gitea instance; app started (English, light, 1440x900),
 * auto-fetch off, optionally connected (through the core – the dialog has its own scenarios) and
 * the repository opened. `prepare(repo)` runs before the server copies the repository.
 */
async function setup(t, { connect = true, open = true, prepare = null } = {}) {
  const repo = makeCleanRepoWithRemote({ name: "demo" });
  if (prepare) prepare(repo);
  const gitea = await startGitea(repo);
  // Own Secret Service per app: tokens never reach the user's keychain, and a locked desktop
  // keyring (overnight runs) does not break the scenarios.
  const keyring = await startPrivateKeyring();
  // The app itself is closed by lib.mjs after the scenario (after a FAIL screenshot); the private
  // keyring with the test token disappears here.
  const cleanup = async () => {
    await gitea.close();
    await keyring?.close();
    repo.cleanup();
  };
  try {
    const app = await t.launch({ lang: "en", theme: "light", width: 1440, height: 900, env: keyring?.env ?? {} });
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    if (connect) await app.invoke("host_connect", { kind: "gitea", baseUrl: gitea.base, token: gitea.token, username: null });
    const ids = open ? await app.openRepo(repo.path) : null;
    if (open) await app.settle();
    return { repo, gitea, app, ids, cleanup };
  } catch (error) {
    // The scenario never gets the cleanup: left running, the servers and the bus keep this
    // feature process alive after its last scenario and the whole run waits for it.
    await cleanup().catch(() => undefined);
    throw error;
  }
}

/** JSON with sorted keys – request bodies are compared independent of key order. */
const sorted = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value);
const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText ?? null, css).then((value) => (value === null ? null : clean(value)));

/** Runs a command through the palette like a user: Ctrl+P, ">" + title, Enter. */
async function palette(app, title) {
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input');
  await input.type(`>${title}`);
  await app.waitFor(
    () => app.exec((wanted) => (document.querySelector('[data-screen="command-palette"] [role="option"][aria-selected="true"]')?.innerText ?? "").replace(/\s+/g, " ").trim().startsWith(wanted), title),
    10_000,
    { message: `palette offers "${title}" first` },
  ).catch(async (error) => {
    throw new Error(`${error.message}; options: ${await app.exec(() => [...document.querySelectorAll('[data-screen="command-palette"] [role="option"]')].map((o) => o.innerText.replace(/\s+/g, " ")).join(" | "))}`);
  });
  await app.press("Enter");
}

const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
async function waitToast(app, pattern, tone = null) {
  return app.waitFor(async () => (await toasts(app)).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone)) ?? null, 20_000, { message: `toast ${pattern}` });
}
async function closeToasts(app) {
  await app.exec(() => document.querySelectorAll("[data-toast] button[aria-label]").forEach((button) => button.click()));
}

/** Where the token appears in the document (markup and field values). */
const tokenInDocument = (app, token) =>
  app.exec((secret) => document.documentElement.outerHTML.includes(secret) || [...document.querySelectorAll("input, textarea")].some((field) => field.value.includes(secret)), token);

/** Expands the "Pull requests" section and loads every page. Returns the PR numbers shown. */
async function allPrRows(app) {
  const header = await app.waitFor(`${PR_SECTION} [data-section-header] button`);
  if ((await header.attr("aria-expanded")) !== "true") await header.click();
  const rows = () => app.exec((section) => [...document.querySelectorAll(`${section} [data-kind="pull-request"]`)].map((row) => Number(row.dataset.pr)), PR_SECTION);
  await app.waitFor(async () => (await rows()).length > 0, 30_000, { message: "pull request rows" });
  for (let round = 0; round < 5; round++) {
    const more = await app.byText("Load more", { within: PR_SECTION });
    if (!more) break;
    const before = (await rows()).length;
    await more.click();
    await app.waitFor(async () => (await rows()).length > before, 20_000, { message: "next page of pull requests" });
  }
  return rows();
}

/** Opens a pull request from the sidebar (all pages loaded) and waits for its header. */
async function openPrFromSidebar(app, number) {
  await allPrRows(app);
  await app.exec((css) => document.querySelector(css)?.scrollIntoView({ block: "center" }), `${PR_SECTION} [data-pr="${number}"]`);
  await app.click(`${PR_SECTION} [data-pr="${number}"]`);
  await app.waitFor(`${PR_VIEW}[data-pr-number="${number}"] [data-pr-head]`, 30_000);
  await app.settle();
}

const phase = (app) => app.exec((view) => document.querySelector(`${view} [data-pr-head] [data-pr-phase]`)?.getAttribute("data-pr-phase") ?? null, PR_VIEW);

async function refreshPr(app) {
  await app.click({ text: "Refresh", within: PR_VIEW });
  await app.settle();
}

// =============================================================================================
// Account
// =============================================================================================

scenario("Konto verbinden: Gitea/Forgejo mit eigener Instanz über den Dialog", "main", async (t) => {
  const { repo, gitea, app, ids, cleanup } = await setup(t, { connect: false });
  try {
    await palette(app, "Connect host account");
    await app.waitFor(CONNECT);
    await app.click({ text: "Gitea/Forgejo", within: CONNECT });
    await app.waitFor(() => app.exec(() => document.querySelector("[data-token-guide]")?.getAttribute("data-token-guide") === "gitea"), 5000, { message: "guide for Gitea" });
    const radios = await app.exec((dialog) => [...document.querySelectorAll(`${dialog} [role="radio"]`)].map((radio) => `${radio.textContent.trim()}${radio.getAttribute("data-state") === "on" ? "*" : ""}`), CONNECT);
    assertEqual(radios, ["GitHub", "GitLab", "Gitea/Forgejo*", "Bitbucket", "Azure DevOps", "codeberg.org*", "Self-hosted"], "Gitea chosen, public instance = codeberg.org");
    const guide = await text(app, "[data-token-guide]");
    for (const permission of ["write:repository", "write:issue", "read:user", "Settings › Applications"]) assertIncludes(guide, permission, `guide names "${permission}"`);
    assertIncludes(guide, "Forgejo and Codeberg use the same page", "guide mentions Forgejo/Codeberg");
    t.step("dialog: Gitea chosen, guide with permissions");

    await app.click({ text: "Self-hosted", within: CONNECT });
    await app.type(`${CONNECT} input[name="baseUrl"]`, gitea.base);
    await app.type(`${CONNECT} input[name="token"]`, gitea.token);
    assertEqual(await app.exec((dialog) => document.querySelector(`${dialog} input[name="token"]`).type, CONNECT), "password", "token in a password field");
    const before = gitea.mock.requests.length;
    await app.click({ text: "Connect", within: '[role="dialog"]' });
    await app.waitFor(async () => !(await app.$(CONNECT)), 20_000, { message: "dialog closes after connecting" });
    await waitToast(app, /Connected to Gitea\/Forgejo as Lena Hartmann/, "success");
    t.step("connected");

    const probe = gitea.api(before).find((entry) => entry.path === "/api/v1/user");
    assert(probe, "the core checked the token with GET /api/v1/user");
    assertEqual(probe.headers.authorization, `token ${gitea.token}`, "Gitea authorization header form");
    const [account] = await app.invoke("host_accounts");
    assertEqual([account?.kind, account?.baseUrl, account?.user?.login, account?.tokenHint], ["gitea", gitea.base, "lena", "…abcd"], "account in the core");
    assert(!JSON.stringify(account).includes(gitea.token), "core answer does not contain the token");
    const info = await app.invoke("host_repo_info", { repoId: ids.repoId });
    assertEqual([info?.kind, info?.owner, info?.name, info?.remote, info?.account?.id], ["gitea", "octo", "demo", "origin", account.id], "repository detected on the instance");

    await palette(app, "Open integrations");
    const row = await app.waitFor(`${HOSTS} [data-account][data-kind="gitea"]`);
    assertEqual(await row.attr("data-state"), "ok", "account row: connected");
    const rowText = await text(app, `${HOSTS} [data-account][data-kind="gitea"]`);
    for (const part of ["Gitea/Forgejo", gitea.base.replace("http://", ""), "Connected as Lena Hartmann", "User: lena", "Token ends in abcd"]) assertIncludes(rowText, part, `account row shows "${part}"`);
    assert(!(await tokenInDocument(app, gitea.token)), "token appears nowhere in the document");
    // Git state: the token went to the keychain, not into the repository configuration.
    assert(!repo.git("config", "--list", "--show-origin").includes(gitea.token), "token not in the Git configuration");
    assertEqual(repo.git("remote", "get-url", "origin"), gitea.remoteUrl, "remote unchanged");
    await closeToasts(app);
    await app.settle();
    await t.shot("konto-verbinden");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Konto verbinden: falscher Token wird abgewiesen, Feld geleert", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t, { connect: false, open: false });
  try {
    await palette(app, "Connect host account");
    await app.waitFor(CONNECT);
    await app.click({ text: "Gitea/Forgejo", within: CONNECT });
    await app.click({ text: "Self-hosted", within: CONNECT });
    await app.type(`${CONNECT} input[name="baseUrl"]`, gitea.base);
    await app.type(`${CONNECT} input[name="token"]`, "gitea_GanzFalscherToken000000000000000000");
    await app.press("Enter");
    const error = await app.waitFor(`${CONNECT} [data-connect-error]`, 20_000);
    assertEqual(await error.attr("data-connect-error"), "auth", "error kind auth");
    assertIncludes(clean(await error.text()), "rejected the token", "clear text");
    assertEqual(await app.exec((dialog) => document.querySelector(`${dialog} input[name="token"]`).value, CONNECT), "", "token field is empty again");
    assertEqual(await app.invoke("host_accounts"), [], "no account created");
    assert(gitea.api().some((entry) => entry.path === "/api/v1/user" && entry.status === 401), "host answered 401");
    await t.shot("konto-falscher-token");
    // Cancel with Escape closes the dialog without an account.
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$(CONNECT)), 5000, { message: "Escape closes the dialog" });
    assertEqual(await app.invoke("host_accounts"), [], "still no account");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Konto verbinden: eigene Instanz ohne Adresse wird vor dem Senden abgefangen", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t, { connect: false, open: false });
  try {
    await palette(app, "Connect host account");
    await app.waitFor(CONNECT);
    await app.click({ text: "Gitea/Forgejo", within: CONNECT });
    await app.click({ text: "Self-hosted", within: CONNECT });
    await app.type(`${CONNECT} input[name="token"]`, gitea.token);
    const before = gitea.mock.requests.length;
    await app.click({ text: "Connect", within: '[role="dialog"]' });
    await app.waitFor(() => app.exec((dialog) => document.querySelector(`${dialog} input[name="baseUrl"]`)?.getAttribute("aria-invalid") === "true" || document.activeElement?.getAttribute("name") === "baseUrl", CONNECT), 5000, { message: "address field marked" });
    assertEqual(await app.exec(() => document.activeElement?.getAttribute("name")), "baseUrl", "focus goes to the address field");
    assertEqual(gitea.mock.requests.length, before, "nothing was sent");
    assertEqual(await app.invoke("host_accounts"), [], "no account");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Konto verbinden: Adresse mit /api/v1 wird auf die Instanz gekürzt", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t, { connect: false, open: false });
  try {
    await palette(app, "Connect host account");
    await app.waitFor(CONNECT);
    await app.click({ text: "Gitea/Forgejo", within: CONNECT });
    await app.click({ text: "Self-hosted", within: CONNECT });
    await app.type(`${CONNECT} input[name="baseUrl"]`, `${gitea.base}/api/v1/`);
    await app.type(`${CONNECT} input[name="token"]`, gitea.token);
    await app.press("Enter");
    await app.waitFor(async () => !(await app.$(CONNECT)), 20_000, { message: "connected" });
    const [account] = await app.invoke("host_accounts");
    assertEqual(account?.baseUrl, gitea.base, "stored as the instance address");
    assert(!gitea.api().some((entry) => entry.path.startsWith("/api/v1/api/v1")), "no doubled API path");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Konto verbinden: Serverfehler, dann zweiter Versuch klappt", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t, { connect: false, open: false });
  try {
    gitea.mock.fail("server_error", { times: 1, match: "/api/v1/user" });
    await palette(app, "Connect host account");
    await app.waitFor(CONNECT);
    await app.click({ text: "Gitea/Forgejo", within: CONNECT });
    await app.click({ text: "Self-hosted", within: CONNECT });
    await app.type(`${CONNECT} input[name="baseUrl"]`, gitea.base);
    await app.type(`${CONNECT} input[name="token"]`, gitea.token);
    await app.press("Enter");
    const error = await app.waitFor(`${CONNECT} [data-connect-error]`, 20_000);
    assert((await error.attr("data-connect-error")) !== "auth", "500 is not reported as a wrong token");
    t.step(`error shown: ${clean(await error.text())}`);
    assertEqual(await app.invoke("host_accounts"), [], "no account after the failure");
    await app.type(`${CONNECT} input[name="token"]`, gitea.token);
    await app.press("Enter");
    await app.waitFor(async () => !(await app.$(CONNECT)), 20_000, { message: "second attempt connects" });
    assertEqual((await app.invoke("host_accounts")).map((account) => account.kind), ["gitea"], "account after the second attempt");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Konto prüfen: abgelaufener Token wird in den Integrationen markiert", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t, { open: false });
  try {
    await palette(app, "Open integrations");
    const row = await app.waitFor(`${HOSTS} [data-account][data-kind="gitea"]`);
    assertEqual(await row.attr("data-state"), "ok", "connected at first");
    gitea.mock.fail("unauthorized");
    await app.click({ text: "Check", within: `${HOSTS} [data-account]` });
    await app.waitFor(async () => (await app.$(`${HOSTS} [data-account][data-kind="gitea"]`))?.attr("data-state").then((state) => state === "expired"), 20_000, { message: "row state expired" });
    assertIncludes(clean(await text(app, `${HOSTS} [data-account]`)), "Replace token", "offers to replace the token");
    await t.noConsoleErrors(app);
  } finally {
    gitea.mock.recover();
    await cleanup();
  }
});

scenario("Konto trennen: Token weg, eigene Instanz wird nicht mehr erkannt", "edge", async (t) => {
  const { repo, gitea, app, cleanup } = await setup(t);
  try {
    await app.waitFor(`${PR_SECTION}`, 20_000);
    await palette(app, "Open integrations");
    await app.waitFor(`${HOSTS} [data-account][data-kind="gitea"]`);
    await app.click({ text: "Disconnect …", within: HOSTS });
    await app.waitFor(() => app.byText("Disconnect Gitea/Forgejo account?"), 10_000, { message: "confirmation names the host" });
    await app.click({ text: "Disconnect account" });
    await waitToast(app, /Gitea\/Forgejo account disconnected/, "success");
    assertEqual(await app.invoke("host_accounts"), [], "account removed in the core");
    await app.waitFor(() => app.exec((hosts) => document.querySelectorAll(`${hosts} [data-account]`).length === 0, HOSTS), 10_000, { message: "list is empty" });
    await app.waitFor(async () => {
      if (!(await app.$('[data-screen="settings"]'))) return true;
      await app.press("Escape");
      return false;
    }, 10_000, { interval: 500, message: "settings closed" });
    // A self-hosted instance is only known through its account: without it the sections disappear.
    await app.waitFor(async () => !(await app.$(PR_SECTION)) && !(await app.$('[data-extra-section="issues"]')), 20_000, { message: "PR and issue sections gone" });
    const show = await app.exec(() => window.__gcUi.commands().find((command) => command.id === "issues.show"));
    assertEqual(show?.available, false, "“Show issues” is no longer available");
    const before = gitea.mock.requests.length;
    await app.settle(1500);
    assertEqual(gitea.mock.requests.length, before, "no more API calls without an account");
    assertEqual(repo.git("remote", "get-url", "origin"), gitea.remoteUrl, "remote untouched");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Codeberg ohne Konto: Issues zeigen „nicht verbunden“ und führen zu den Integrationen", "edge", async (t) => {
  // codeberg.org is detected without an account (public Forgejo instance). Without an account the
  // core makes no request there; the dialog is only opened and cancelled, never submitted.
  const { repo, app, cleanup } = await setup(t, {
    connect: false,
    prepare: (r) => r.git("remote", "add", "codeberg", "https://codeberg.org/octo/demo.git"),
  });
  try {
    await palette(app, "Show issues");
    await app.waitFor(ISSUES, 20_000);
    await app.waitFor(async () => (await text(app, ISSUES))?.includes("Not connected to Gitea/Forgejo"), 20_000, { message: "issues: not connected" });
    assertIncludes(await text(app, ISSUES), "octo/demo", "names the repository");
    await t.shot("codeberg-nicht-verbunden");
    // "Connect account …" leads to the integrations, where the account is added.
    await app.click({ text: "Connect account …", within: ISSUES });
    await app.waitFor(HOSTS, 10_000);
    assertEqual(await app.exec((hosts) => document.querySelectorAll(`${hosts} [data-account]`).length, HOSTS), 0, "integrations: no account yet");
    assertEqual(await app.invoke("host_accounts"), [], "no account");
    assertEqual(repo.git("remote"), "codeberg\norigin", "remotes untouched");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

// =============================================================================================
// Pull requests
// =============================================================================================

scenario("Pull Requests: Liste, Ansicht und Kommentar", "main", async (t) => {
  const { gitea, app, cleanup } = await setup(t);
  try {
    const header = await app.waitFor(`${PR_SECTION} [data-section-header] button`);
    await header.click();
    await app.waitFor(async () => (await app.$$(`${PR_SECTION} [data-kind="pull-request"]`)).length === 20, 30_000, { message: "first page: 20 rows" });
    assertMatch(await app.exec((section) => document.querySelector(`${section} [data-section-header] button`).textContent, PR_SECTION), /20\+/, "header count says there are more");
    const rows = await allPrRows(app);
    assertEqual(rows.length, OPEN_PRS, "all open pull requests after “Load more”");
    assert(!rows.some((n) => n % 5 === 0), "merged (…0) and closed (…5) are not listed");
    assertEqual(await app.exec((section) => document.querySelector(`${section} [data-pr="3"]`)?.dataset.prPhase, PR_SECTION), "draft", "“WIP:” title → draft");
    t.step(`${rows.length} pull requests in the sidebar`);

    await openPrFromSidebar(app, 1);
    const head = await text(app, `${PR_VIEW} [data-pr-head]`);
    for (const part of ["Thema 1 umsetzen #1", "feature/thema-1", "main", "1 check passed", "Approved"]) assertIncludes(head, part, `header shows "${part}"`);
    assertEqual(await app.exec((view) => document.querySelector(`${view} [data-pr-head] [data-checks]`)?.getAttribute("data-checks"), PR_VIEW), "passing", "checks passing");
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-labels]`), "bug", "label bug");
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-reviewers]`), "mira", "reviewer mira");
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-body]`), "Beschreibung zu Thema 1", "description rendered");
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-comments]`), "Danke fürs Ansehen!", "existing comment");
    assertIncludes(clean(await app.exec(() => document.querySelector('[data-screen="pr-view"] header')?.innerText)), "octo/demo", "repository in the header");

    const comment = "Sieht gut aus – danke für **die Prüfung**!";
    await app.type(`${PR_VIEW} textarea[name="comment"]`, comment);
    const before = gitea.mock.requests.length;
    await app.click({ text: "Comment", within: `${PR_VIEW} [data-comment-form]` });
    await waitToast(app, /Comment sent/, "success");
    const posted = gitea.api(before).find((entry) => entry.method === "POST" && entry.path === "/api/v1/repos/octo/demo/issues/1/comments");
    assert(posted, "comment sent as an issue comment of #1");
    assertEqual(posted.body, { body: comment }, "comment body unchanged (umlauts, Markdown)");
    assertEqual(await app.exec((view) => document.querySelector(`${view} textarea[name="comment"]`).value, PR_VIEW), "", "field cleared");
    await closeToasts(app);
    await app.settle();
    await t.shot("pr-ansicht");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request zusammenführen: Squash und Branch löschen", "main", async (t) => {
  const { repo, gitea, app, cleanup } = await setup(t);
  try {
    const localMain = repo.git("rev-parse", "main");
    await openPrFromSidebar(app, 6);
    await app.click({ text: "Merge …", within: `${PR_VIEW} [data-pr-actions]` });
    await app.waitFor('[data-screen="pr-merge"]');
    await app.click('[role="dialog"] [role="combobox"]');
    const options = await app.waitFor(async () => {
      const list = await app.exec(() => [...document.querySelectorAll('[role="option"]')].map((option) => option.innerText.trim()));
      return list.length ? list : null;
    });
    assertEqual(options, ["Merge commit", "Squash", "Rebase"], "Gitea offers three methods");
    await app.click({ text: "Squash", within: '[role="listbox"]' });
    await app.click('[role="dialog"] [role="checkbox"]');
    assertEqual(await app.exec(() => document.querySelector('[role="dialog"] [role="checkbox"]').getAttribute("aria-checked")), "true", "delete branch checked");
    await t.shot("pr-zusammenfuehren-dialog");
    const before = gitea.mock.requests.length;
    await app.click({ text: "Merge", within: '[role="dialog"] footer, [role="dialog"]' });
    await app.waitFor(async () => (await phase(app)) === "merged", 20_000, { message: "view shows merged" });
    const merge = gitea.api(before).find((entry) => entry.method === "POST" && entry.path === "/api/v1/repos/octo/demo/pulls/6/merge");
    assertEqual(sorted(merge?.body), sorted({ Do: "squash", delete_branch_after_merge: true }), "Gitea gets Do=squash and delete_branch_after_merge");
    assertEqual([...gitea.mock.state.merged], [6], "host merged #6");
    await waitToast(app, /Pull request #6 merged/, "success");
    assert(!(await app.byText("Merge …", { within: `${PR_VIEW} [data-pr-actions]` })), "no merge button any more");
    // Git state: nothing changes locally until the next fetch.
    assertEqual(repo.git("rev-parse", "main"), localMain, "local main unchanged");
    assertEqual(repo.git("status", "--porcelain"), "", "working tree clean");
    await app.settle();
    await t.shot("pr-zusammengefuehrt");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request zusammenführen: gesperrt mit Grund (Konflikt, Entwurf, Checks)", "edge", async (t) => {
  const { app, cleanup } = await setup(t);
  try {
    const mergeDisabled = () => app.exec((view) => [...document.querySelectorAll(`${view} [data-pr-actions] button`)].find((button) => button.innerText.trim() === "Merge …")?.disabled ?? null, PR_VIEW);
    await openPrFromSidebar(app, 13);
    assertIncludes(await text(app, `${PR_VIEW} [data-merge-blocked]`), "conflicts", "#13: conflicts");
    assertEqual(await mergeDisabled(), true, "#13: merge disabled");
    await openPrFromSidebar(app, 3);
    assertEqual(await phase(app), "draft", "#3 is a draft");
    assertIncludes(await text(app, `${PR_VIEW} [data-merge-blocked]`), "draft", "#3: draft");
    assertEqual(await mergeDisabled(), true, "#3: merge disabled");
    await openPrFromSidebar(app, 4);
    assertIncludes(await text(app, `${PR_VIEW} [data-merge-blocked]`), "check failed", "#4: failed check");
    assertEqual(await app.exec((view) => document.querySelector(`${view} [data-pr-head] [data-review]`)?.innerText.trim(), PR_VIEW), "Changes requested", "#4: review state");
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-comments]`), "Bitte die Tests ergänzen.", "#4: review text in the conversation");
    await openPrFromSidebar(app, 2);
    assertIncludes(await text(app, `${PR_VIEW} [data-merge-blocked]`), "still running", "#2: pending check");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request schließen (mit Rückfrage) und wieder öffnen", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t);
  try {
    await openPrFromSidebar(app, 9);
    // Cancel first: nothing is sent.
    await app.click({ text: "Close …", within: `${PR_VIEW} [data-pr-actions]` });
    let ask = await app.waitFor('[role="alertdialog"], [role="dialog"]');
    assertIncludes(clean(await ask.text()), "Close pull request #9?", "confirmation");
    const before = gitea.mock.requests.length;
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[role="alertdialog"]')) && !(await app.$('[role="dialog"]')), 5000, { message: "confirmation closed" });
    assert(!gitea.api(before).some((entry) => entry.method === "PATCH"), "Escape sends nothing");
    assertEqual(await phase(app), "open", "still open");

    await app.click({ text: "Close …", within: `${PR_VIEW} [data-pr-actions]` });
    ask = await app.waitFor('[role="alertdialog"], [role="dialog"]');
    await app.click({ text: "Close pull request", within: '[role="alertdialog"], [role="dialog"]' });
    await app.waitFor(async () => (await phase(app)) === "closed", 20_000, { message: "closed" });
    assertEqual(gitea.api(before).filter((entry) => entry.method === "PATCH").map((entry) => [entry.path, entry.body]), [["/api/v1/repos/octo/demo/pulls/9", { state: "closed" }]], "PATCH state=closed");
    await app.click({ text: "Reopen", within: `${PR_VIEW} [data-pr-actions]` });
    await app.waitFor(async () => (await phase(app)) === "open", 20_000, { message: "reopened" });
    assertEqual(gitea.api(before).filter((entry) => entry.method === "PATCH").map((entry) => entry.body.state), ["closed", "open"], "PATCH state=open");
    assert(!gitea.mock.state.closed.has(9), "host has #9 open again");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request auschecken: Branch aus demselben Repository", "main", async (t) => {
  const { repo, gitea, app, cleanup } = await setup(t);
  try {
    assertEqual(repo.git("branch", "--list", "feature/login"), "", "no local feature/login before");
    await openPrFromSidebar(app, 7);
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-head]`), "feature/login", "source branch feature/login");
    await app.click({ text: "Check out branch", within: `${PR_VIEW} [data-pr-actions]` });
    await waitToast(app, /pull request #7 has been fetched and checked out/, "success");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/login", "feature/login checked out");
    assertEqual(repo.git("rev-parse", "HEAD"), gitea.sha.login, "at the server's commit");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "feature/login@{upstream}"), "origin/feature/login", "tracks origin/feature/login");
    assert(gitea.git.requests.some((entry) => entry.path.includes("git-upload-pack")), "fetched over HTTP from the instance");
    await app.waitFor(async () => (await text(app, "[data-statusbar], footer"))?.includes("feature/login") || (await app.exec(() => document.body.innerText.includes("feature/login"))), 10_000, { message: "UI shows the branch" });
    await t.shot("pr-auschecken");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request auschecken: aus einem Fork über refs/pull", "edge", async (t) => {
  const { repo, gitea, app, cleanup } = await setup(t);
  try {
    await openPrFromSidebar(app, 8);
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-head]`), "fork", "marked as from a fork");
    await app.click({ text: "Check out branch", within: `${PR_VIEW} [data-pr-actions]` });
    await waitToast(app, /pull request #8 has been fetched and checked out/, "success");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "pr-8", "local branch pr-8");
    assertEqual(repo.git("rev-parse", "HEAD"), gitea.sha.fork, "at refs/pull/8/head of the server");
    assertEqual(repo.git("for-each-ref", "refs/forkyard/pull"), "", "helper ref removed again");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request erstellen: pushen, Entwurf, Labels, Reviewer, Vorlage aus .gitea", "main", async (t) => {
  const { repo, gitea, app, cleanup } = await setup(t, {
    prepare: (r) => {
      r.write(".gitea/pull_request_template.md", "## Was ändert sich?\n\n## Wie prüfen?\n");
      r.git("add", "-A");
      r.git("commit", "-q", "-m", "Vorlage für Pull Requests");
      r.git("push", "-q", "origin", "main");
    },
  });
  try {
    repo.git("checkout", "-q", "-b", "thema/auswertung", "main");
    repo.write("auswertung.md", "# Auswertung\n\nMonatsmittel je Station.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Auswertung der Monatsmittel");
    const head = repo.git("rev-parse", "HEAD");
    await app.settle();
    await palette(app, "Create pull request");
    await app.waitFor(PR_CREATE, 20_000);
    await app.waitFor(() => app.exec((form) => document.querySelector(`${form} textarea[name="body"]`)?.value.includes("Was ändert sich?"), PR_CREATE), 20_000, { message: "template from .gitea prefilled" });
    assertIncludes(await text(app, PR_CREATE), "does not exist on the remote yet", "says the branch must be pushed");
    assertEqual(await app.exec((form) => document.querySelector(`${form} input[name="title"]`).value, PR_CREATE), "Auswertung der Monatsmittel", "title from the only commit");
    await app.exec((form) => document.querySelector(`${form} [role="checkbox"]`)?.scrollIntoView({ block: "center" }), PR_CREATE);
    await app.click({ text: "Create as draft", exact: false, within: PR_CREATE });
    await app.waitFor(() => app.exec((form) => document.querySelector(`${form} [role="checkbox"]`)?.getAttribute("aria-checked") === "true", PR_CREATE), 5000, { message: "draft checked" });
    await app.type(`${PR_CREATE} input[name="reviewers"]`, "mira");
    await app.type(`${PR_CREATE} input[name="labels"]`, "bug, UI");
    await t.shot("pr-erstellen-formular");
    const before = gitea.mock.requests.length;
    await app.click({ text: "Push and create", within: PR_CREATE });
    await app.waitFor(`${PR_VIEW}[data-pr-number="101"] [data-pr-head]`, 60_000);
    await app.settle();
    t.step("pull request #101 opened");

    assertEqual(gitea.serverGit("rev-parse", "refs/heads/thema/auswertung"), head, "branch pushed to the instance first");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "thema/auswertung@{upstream}"), "origin/thema/auswertung", "upstream set");
    const sent = gitea.api(before);
    const created = sent.find((entry) => entry.method === "POST" && entry.path === "/api/v1/repos/octo/demo/pulls");
    assertEqual(sorted(created?.body), sorted({ title: "WIP: Auswertung der Monatsmittel", body: "## Was ändert sich?\n\n## Wie prüfen?\n", head: "thema/auswertung", base: "main", labels: [11, 13] }), "POST pulls: WIP prefix, template, label IDs");
    const reviewers = sent.find((entry) => entry.method === "POST" && entry.path === "/api/v1/repos/octo/demo/pulls/101/requested_reviewers");
    assertEqual(reviewers?.body, { reviewers: ["mira"] }, "reviewer requested separately");
    assertEqual(await phase(app), "draft", "new pull request shown as draft");
    await t.shot("pr-erstellt");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request erstellen: Duplikat wird verständlich abgelehnt", "edge", async (t) => {
  const { repo, gitea, app, cleanup } = await setup(t, {
    prepare: (r) => {
      r.git("checkout", "-q", "-b", "schon-da", "main");
      r.write("docs/schon-da.md", "# Schon da\n");
      r.git("add", "-A");
      r.git("commit", "-q", "-m", "Schon da");
    },
  });
  try {
    // The server copy already has the branch (it was copied from the repository): set the upstream
    // without a network fetch (the Git server runs in this process – a synchronous fetch would hang).
    assertEqual(gitea.serverGit("rev-parse", "refs/heads/schon-da"), repo.git("rev-parse", "schon-da"), "server has schon-da");
    repo.git("checkout", "-q", "schon-da");
    repo.git("update-ref", "refs/remotes/origin/schon-da", repo.git("rev-parse", "schon-da"));
    repo.git("branch", "-q", "--set-upstream-to", "origin/schon-da", "schon-da");
    await app.settle();
    await palette(app, "Create pull request");
    await app.waitFor(PR_CREATE, 20_000);
    await app.waitFor(() => app.exec((form) => document.querySelector(`${form} input[name="title"]`)?.value === "Schon da", PR_CREATE), 20_000, { message: "title prefilled" });
    await app.exec((form) => {
      const field = document.querySelector(`${form} input[name="title"]`);
      field.select();
    }, PR_CREATE);
    await app.type(`${PR_CREATE} input[name="title"]`, "Noch einmal");
    await app.waitFor(async () => (await app.byText("Create pull request", { within: `${PR_CREATE} footer` })) !== null, 20_000, { message: "submit without push" });
    await app.click({ text: "Create pull request", within: `${PR_CREATE} footer` });
    const failure = await app.waitFor(`${PR_CREATE} [data-pr-error]`, 30_000);
    assertIncludes(clean(await failure.text()), "already an open pull request", "duplicate: understandable text");
    assertEqual(await app.exec((form) => document.querySelector(`${form} input[name="title"]`).value, PR_CREATE), "Noch einmal", "title stays");
    assertEqual(gitea.mock.state.created, [], "nothing created at the host");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request erstellen: unbekanntes Label bricht vor dem Anlegen ab", "edge", async (t) => {
  const { repo, gitea, app, cleanup } = await setup(t);
  try {
    repo.git("checkout", "-q", "feature/export");
    await app.settle();
    await palette(app, "Create pull request");
    await app.waitFor(PR_CREATE, 20_000);
    await app.waitFor(() => app.exec((form) => document.querySelector(`${form} input[name="title"]`)?.value.length > 0, PR_CREATE), 20_000, { message: "title prefilled" });
    await app.type(`${PR_CREATE} input[name="labels"]`, "gibtsnicht");
    const before = gitea.mock.requests.length;
    await app.waitFor(async () => (await app.byText("Create pull request", { within: `${PR_CREATE} footer` })) !== null, 20_000, { message: "submit without push" });
    await app.click({ text: "Create pull request", within: `${PR_CREATE} footer` });
    const failure = await app.waitFor(`${PR_CREATE} [data-pr-error]`, 30_000);
    assertIncludes(clean(await failure.text()), "has no label “gibtsnicht”", "names the unknown label");
    assert(!gitea.api(before).some((entry) => entry.method === "POST" && entry.path.endsWith("/pulls")), "no POST pulls");
    assertEqual(gitea.mock.state.created, [], "nothing created");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Pull Request: Ratenlimit, abgelaufener Token und unbekannte Nummer", "edge", async (t) => {
  const { gitea, app, ids, cleanup } = await setup(t);
  try {
    await openPrFromSidebar(app, 1);
    gitea.mock.fail("rate_limit");
    await refreshPr(app);
    await app.waitFor(`${PR_VIEW} [data-pr-stale="rate_limit"]`, 20_000);
    assertIncludes(await text(app, `${PR_VIEW} [data-pr-head]`), "Thema 1 umsetzen", "content stays visible");
    gitea.mock.recover();
    gitea.mock.fail("unauthorized");
    await refreshPr(app);
    await app.waitFor(`${PR_VIEW} [data-pr-stale="auth"]`, 20_000);
    assert(await app.byText("Open integrations", { within: `${PR_VIEW} [data-pr-stale]` }), "offers the integrations");
    await t.shot("pr-token-abgelehnt");
    gitea.mock.recover();
    await refreshPr(app);
    await app.waitFor(async () => !(await app.$(`${PR_VIEW} [data-pr-stale]`)), 20_000, { message: "notice gone after recovery" });
    // A number the host does not know (no UI path leads there except an old link: set via the store).
    await app.exec((tabId) => window.__gc.store.getState().setCenter(tabId, { kind: "pr", number: 999 }), ids.tabId);
    await app.waitFor(() => app.exec((view) => document.querySelector(`${view} [data-pr-state]`)?.getAttribute("data-pr-state") === "error-not_found", PR_VIEW), 20_000, { message: "not-found state" });
    assertIncludes(await text(app, PR_VIEW), "#999", "names the number");
    await t.noConsoleErrors(app);
  } finally {
    gitea.mock.recover();
    await cleanup();
  }
});

// =============================================================================================
// Issues
// =============================================================================================

const issueRows = (app) => app.exec((view) => [...document.querySelectorAll(`${view} [data-issue-row]`)].map((row) => Number(row.dataset.issueRow)), ISSUES);

/** Waits for the filled issue list; a timeout names the state and text the view showed instead. */
async function waitIssuesFilled(app, timeout = 30_000) {
  try {
    return await app.waitFor(`${ISSUES}[data-state="filled"]`, timeout);
  } catch (error) {
    const seen = await app.exec((view) => { const el = document.querySelector(view); return el ? `${el.getAttribute("data-state")}: ${el.innerText.replace(/\s+/g, " ").slice(0, 300)}` : "no issues view"; }, ISSUES).catch(() => "?");
    throw new Error(`${error.message}; view showed ${seen}`);
  }
}

scenario("Issues: Liste, Details und Statusfilter", "main", async (t) => {
  const { gitea, app, cleanup } = await setup(t);
  try {
    await palette(app, "Show issues");
    await waitIssuesFilled(app);
    assertEqual(await issueRows(app), [11, 10, 9, 7, 6, 5, 3, 2, 1], "open issues (closed: divisible by 4)");
    assertIncludes(await text(app, ISSUES), "9 issues loaded – that is all", "footer");
    assertIncludes(await text(app, `${ISSUES} header`), "octo/demo", "repository in the header");
    assert(!(await app.$(`${ISSUES} [data-action="issues-create"]`)), "no “create issue” for Gitea (capability issueCreate=false)");
    const list = gitea.api().find((entry) => entry.method === "GET" && entry.path === "/api/v1/repos/octo/demo/issues");
    assertEqual(list?.query.type, "issues", "asks Gitea for issues only (no pull requests)");

    await app.click(`${ISSUES} [data-issue-row="2"]`);
    await app.waitFor(`${ISSUES} article[data-issue="2"][data-state="filled"]`, 20_000);
    assertMatch(await text(app, `${ISSUES} [data-issue-title]`), /^Problem 2\b/, "title");
    assertIncludes(await text(app, `${ISSUES} [data-issue-body]`), "Text zu Problem 2", "description");
    assertIncludes(await text(app, `${ISSUES} [data-issue-assignees]`), "lena", "assignee");
    assertIncludes(await text(app, `${ISSUES} [data-issue-comments]`), "Danke fürs Ansehen!", "comment");
    await app.settle();
    await t.shot("issues-details");

    await app.click({ text: "Closed", within: `${ISSUES} [role="search"]` });
    await app.waitFor(async () => JSON.stringify(await issueRows(app)) === JSON.stringify([12, 8, 4]), 20_000, { message: "closed issues 12, 8, 4" });
    assert(gitea.api().some((entry) => entry.path === "/api/v1/repos/octo/demo/issues" && entry.query.state === "closed"), "state=closed sent");
    await app.click({ text: "All", within: `${ISSUES} [role="search"]` });
    await app.waitFor(async () => (await issueRows(app)).length === 12, 20_000, { message: "all 12 issues" });
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Issues: Suche und „mir zugewiesen“", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t);
  try {
    await palette(app, "Show issues");
    await waitIssuesFilled(app);
    await app.click({ text: "Assigned to me", exact: false, within: `${ISSUES} [role="search"]` });
    await app.waitFor(async () => JSON.stringify(await issueRows(app)) === JSON.stringify([2]), 20_000, { message: "only #2 (assigned to lena)" });
    await app.click({ text: "Assigned to me", exact: false, within: `${ISSUES} [role="search"]` });
    await app.waitFor(async () => (await issueRows(app)).length === 9, 20_000, { message: "all open again" });
    await app.type(`${ISSUES} input[type="search"]`, "Problem");
    await app.press("Enter");
    await app.waitFor(async () => JSON.stringify(await issueRows(app)) === JSON.stringify([2, 1]), 20_000, { message: "search result 2, 1" });
    assert(gitea.api().some((entry) => entry.path === "/api/v1/repos/octo/demo/issues" && entry.query.q === "Problem"), "search sent as q");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Issues: Branch für ein Issue anlegen", "main", async (t) => {
  const { repo, app, cleanup } = await setup(t);
  try {
    const main = repo.git("rev-parse", "main");
    await palette(app, "Show issues");
    await waitIssuesFilled(app);
    await app.click(`${ISSUES} [data-issue-row="7"]`);
    await app.waitFor(`${ISSUES} article[data-issue="7"][data-state="filled"]`, 20_000);
    await app.click(`${ISSUES} [data-action="issue-branch"]`);
    const dialog = await app.waitFor('[role="dialog"]');
    assertIncludes(clean(await dialog.text()), "Branch for issue", "branch dialog");
    const name = await app.exec(() => document.querySelector('[role="dialog"] input')?.value);
    assertMatch(name, /7/, "suggested name contains the number");
    assertMatch(name, /problem/i, "and the title");
    await t.shot("issue-branch-dialog");
    await app.press("Enter");
    await app.waitFor(() => Promise.resolve(repo.git("rev-parse", "--abbrev-ref", "HEAD") === name), 20_000, { message: `branch ${name} checked out` });
    assertEqual(repo.git("rev-parse", "HEAD"), main, "starts at the current commit");
    await t.noConsoleErrors(app);
  } finally {
    await cleanup();
  }
});

scenario("Issues: Serverfehler mit „Erneut versuchen“", "edge", async (t) => {
  const { gitea, app, cleanup } = await setup(t);
  try {
    gitea.mock.fail("server_error", { match: "/issues" });
    await palette(app, "Show issues");
    await app.waitFor(ISSUES, 20_000);
    await app.waitFor(() => app.exec((view) => /could not be loaded|Server Error/i.test(document.querySelector(view)?.innerText ?? ""), ISSUES), 30_000, { message: "error shown" });
    await t.shot("issues-fehler");
    gitea.mock.recover();
    await app.click({ text: "Try again", within: ISSUES });
    await waitIssuesFilled(app);
    assertEqual((await issueRows(app)).length, 9, "list after retry");
    await t.noConsoleErrors(app);
  } finally {
    gitea.mock.recover();
    await cleanup();
  }
});
