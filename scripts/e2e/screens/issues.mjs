/**
 * issues – Issues of the connected host (GitHub Issues, GitLab Issues) in the real app.
 *
 *   node scripts/e2e/screens/issues.mjs [--show] [--no-shots] [--only <part>]
 *
 * There are NO calls to real services: the host is a local server the app knows as a "self-hosted
 * instance", and the test repository's remote points there. The token is made up and stored under a
 * separate service name in the keychain, which is emptied at the end.
 *
 * Two local servers: host-lib.mjs (freely populated – long titles, malicious text, 82 issues,
 * assignees) for the flows, and finally the core's test server (host-mock.mjs, fixed data set, ETag
 * and 304 like the real services) as a cross-check.
 *
 * Sections: not connected → connected; keyboard only from the left panel to the issue and to the
 * branch (checked with git); search and filters; many entries and loading more; states (loading,
 * rate limit, token expired, no permission, not found, unreachable, no host); GitLab; appearance
 * (1440×900 dark/light, 960×600).
 */
import { launchApp } from "../driver.mjs";
import { startHostMock } from "../host-mock.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { EVIL_BODY, LONG_TITLE, PEOPLE, connectDirect, escaping, focusedName, makeHostRepo, recordConsole, refreshHostQueries, runCommand, startHost, tabTo, tokenLeaks } from "./host-lib.mjs";
import { createRun, sleep } from "./mustfix-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("issues", { argv });
const { check, equal, eventually, section, shot, waitToast } = t;

const VIEW = '[data-screen="issues"]';
const SECTION = '[data-extra-section="issues"]';
const KEYRING = `forkyard-e2e-s31-${process.pid}`;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const cleanups = [];
let app = null;
let page = null;

async function start() {
  app = await launchApp({ show, env: { FORKYARD_KEYRING_SERVICE: KEYRING } });
  page = app.page;
  t.attach(app);
  recordConsole(app);
  await page.evaluate(() => (window.__gcTestOpened = []));
}
async function stop() {
  if (!app) return;
  // Remove the made-up tokens from the keychain again.
  for (const account of await app.invoke("host_accounts").catch(() => [])) await app.invoke("host_disconnect", { accountId: account.id }).catch(() => undefined);
  await app.close().catch(() => undefined);
  app = null;
  page = null;
  t.attach(null);
}

const press = (keys) => page.keyboard.press(keys);
const blur = () => page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
const view = () => page.locator(VIEW);
const viewState = () => view().getAttribute("data-state", { timeout: 2000 }).catch(() => null);
const rowNumbers = () => page.locator(`${VIEW} [data-issue-row]`).evaluateAll((rows) => rows.map((row) => Number(row.dataset.issueRow)));
const sectionNumbers = () => page.locator(`${SECTION} [data-kind="issue"]`).evaluateAll((rows) => rows.map((row) => Number(row.dataset.issue)));
const sectionText = () => page.locator(SECTION).innerText({ timeout: 2000 }).then((text) => text.replace(/\s+/g, " ").trim()).catch(() => null);
const opened = () => page.evaluate(() => window.__gcTestOpened.slice());
const center = (tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.center ?? null, tabId);
const openView = (tabId, number = null) => page.evaluate(([id, issue]) => window.__gc.store.getState().setCenter(id, { kind: "issues", number: issue }), [tabId, number]);
const closeView = (tabId) => page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
/** Reload everything about issues – like the "Reload issues" button. */
const reload = async () => {
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" && ["issues", "issue", "hostRepo"].includes(String(query.queryKey[2])) }));
  await app.settle();
};

/** Twelve open and three closed issues, as in a small project. */
function seedIssues(host) {
  host.addIssue({
    number: 7,
    title: "Regenmesser Nord liefert doppelte Werte",
    body: EVIL_BODY,
    author: PEOPLE.jonas,
    assignees: [PEOPLE.lena],
    labels: ["bug", "station-nord", "dringend"],
    updatedAt: minutesAgo(5),
    comments: [
      { author: PEOPLE.aylin, body: "Bei mir auch. Der Logger schreibt nach dem Neustart **beide** Kanäle.", createdAt: minutesAgo(50) },
      { author: PEOPLE.mats, body: "Ich sehe mir das morgen an.\n\n<img src=x onerror=\"window.__pwned = 1\">", createdAt: minutesAgo(20) },
    ],
  });
  host.addIssue({ number: 8, title: LONG_TITLE, body: "Ohne Leerzeichen: " + "x".repeat(400), author: PEOPLE.aylin, labels: ["frage"], updatedAt: minutesAgo(15) });
  host.addIssue({ number: 9, title: "Größe der Diagramme für kleine Bildschirme ändern", body: "", author: PEOPLE.mats, assignees: [PEOPLE.jonas, PEOPLE.aylin], updatedAt: minutesAgo(30) });
  for (let index = 0; index < 9; index++) {
    host.addIssue({ number: 20 + index, title: `Messlauf ${index + 1}: Zeitstempel prüfen`, body: `Lauf ${index + 1}`, author: index % 2 ? PEOPLE.jonas : PEOPLE.aylin, assignees: index % 4 === 0 ? [PEOPLE.lena] : [], labels: index % 3 === 0 ? ["doku"] : [], updatedAt: minutesAgo(60 + index * 10) });
  }
  host.addIssue({ number: 3, title: "Hafen: Zeitstempel in UTC statt Ortszeit", state: "closed", author: PEOPLE.lena, updatedAt: minutesAgo(900) });
  host.addIssue({ number: 4, title: "Dokumentation für neue Stationen", state: "closed", author: PEOPLE.jonas, updatedAt: minutesAgo(1000) });
  host.addIssue({ number: 5, title: "Windrichtung fehlt in der CSV-Ausgabe", state: "closed", author: PEOPLE.aylin, assignees: [PEOPLE.lena], updatedAt: minutesAgo(1100) });
}
const OPEN = [7, 8, 9, 20, 21, 22, 23, 24, 25, 26, 27, 28];
/** "You can continue at 02:32 PM" – local time, with or without a date before it; never the host's UTC timestamp. */
const LOCAL_TIME = /You can continue at (?:[A-Z][a-z]+ \d{1,2}(?:,| at) )?\d{2}:\d{2}\s?[AP]M/;
/**
 * Discards what is loaded about issues and loads from scratch – so the view shows the state without
 * an old list (loading, full-area error). Does not wait for the response.
 */
const startOver = () =>
  page.evaluate(() => {
    void window.__gc.queryClient.resetQueries({ predicate: (query) => query.queryKey[0] === "repo" && ["issues", "issue"].includes(String(query.queryKey[2])) });
  });

try {
  // ===========================================================================================
  const github = await startHost({ kind: "github" });
  cleanups.push(Object.assign(() => github.close(), { host: github }));
  seedIssues(github);
  const { repo } = makeHostRepo(github);
  cleanups.push(() => repo.cleanup?.());
  repo.git("checkout", "-q", "main");
  await start();
  // No auto-fetch: the first section's repository has a remote on github.com, and the test never calls real services.
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });

  // ===========================================================================================
  await section("Not connected: section and view say so and lead to the integrations", async () => {
    // The core recognizes a remote on github.com even without an account – by the address, without a network call.
    const lonely = makeCleanRepoWithRemote({ name: "nicht-verbunden" });
    cleanups.push(() => lonely.cleanup?.());
    lonely.git("remote", "set-url", "origin", "https://github.com/schule/messnetz.git");
    const { tabId } = await app.openRepo(lonely.path);
    await eventually(sectionText, (text) => /Not connected to GitHub/.test(text ?? ""), "the \"Issues\" section in the left panel names the state");
    check((await page.locator(`${SECTION} button`, { hasText: "Connect" }).count()) === 1, "with a \"Connect\" button");
    await blur();
    await runCommand(app, "Show issues", "issues.show");
    await eventually(viewState, "not_connected", "the view: not connected");
    const text = (await view().innerText()).replace(/\s+/g, " ");
    check(text.includes("Not connected to GitHub") && text.includes("schule/messnetz"), `it names host and repository: ${text.slice(0, 200)}`);
    equal(github.sent("GET", /issues/).length, 0, "without an account no call goes to the host");
    await shot("issues-not-connected");
    await view().getByRole("button", { name: "Connect account …" }).click();
    await page.locator('[data-screen="settings"]').waitFor();
    equal(await page.getByRole("tab", { selected: true }).innerText(), "Hosts", "\"Connect account …\" opens Settings › Hosts");
    await press("Escape");
    await page.locator('[data-screen="settings"]').waitFor({ state: "detached" });
    await closeView(tabId);
    await page.evaluate((id) => window.__gc.core.tabClose({ tabId: id }).then(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] })), tabId);
    await app.settle();
    equal(app.consoleErrors, [], "console errors");
  });

  const { tabId } = await app.openRepo(repo.path);

  // ===========================================================================================
  await section("Keyboard: from the left panel to the issue, create a branch for the issue – no mouse", async () => {
    await connectDirect(app, github);
    await eventually(sectionNumbers, OPEN, "the section shows the open issues, most recently changed first", 20_000);
    check(/ISSUES\s*12/i.test((await sectionText()) ?? ""), `with their count in the header: ${await sectionText()}`);
    check(github.sent("GET", /\/issues$/).every((entry) => entry.token === github.token), "the calls carry the account's token");

    // Alt+1 into the left panel, arrow keys down into the section.
    await blur();
    await press("Alt+1");
    await press("End");
    let reached = false;
    for (let step = 0; step < 80 && !reached; step++) {
      reached = await page.evaluate((css) => Boolean(document.activeElement?.closest(css) && document.activeElement.matches('[data-kind="issue"]')), SECTION);
      if (!reached) await press("ArrowDown");
    }
    check(reached, "the arrow keys lead from the ref rows into the \"Issues\" section");
    for (let step = 0; step < 20 && (await page.evaluate(() => document.activeElement?.getAttribute("data-issue"))) !== "7"; step++) await press("ArrowUp");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("data-issue")), "7", "the first issue has focus");
    check(/Issue 7: Regenmesser Nord liefert doppelte Werte, open, assigned to lena-hartmann, Labels: bug, station-nord, dringend/.test(await focusedName(page)), `the row tells screen readers everything: ${await focusedName(page)}`);

    // Context menu by keyboard: the entries.
    await press("Shift+F10");
    await page.getByRole("menu").waitFor();
    const entries = (await page.getByRole("menuitem").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
    equal(entries.map((text) => text.replace(/ (Enter|7-regenmesser.*)$/, "")), ["Open issue", "Create branch for this issue …", "Open in browser", "Copy link", "Copy number"], "context menu of the row");
    check(entries[1].includes("7-regenmesser-nord-liefert-doppelte-werte"), `the entry names the suggested name: ${entries[1]}`);
    await shot("issues-section-menu");
    await press("Escape");
    await eventually(() => page.getByRole("menu").count(), 0, "Esc closes the menu");
    // The menu returns focus to the row a moment after closing; only then does Enter apply to it.
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-issue")), "7", "after the menu focus is back on the row");

    // Enter opens the issue in the center.
    await press("Enter");
    await eventually(() => center(tabId), { kind: "issues", number: 7 }, "Enter opens the issue in the view");
    const detail = page.locator(`${VIEW} article[data-issue="7"]`);
    await eventually(() => detail.getAttribute("data-state"), "filled", "the details are loaded");
    equal((await detail.locator("[data-issue-title]").innerText()).replace(/\s+/g, " "), "Regenmesser Nord liefert doppelte Werte #7", "title and number");
    const head = (await detail.locator("header").innerText()).replace(/\s+/g, " ");
    check(head.includes("Open") && head.includes("jonas") && head.includes("lena-hartmann") && ["bug", "station-nord", "dringend"].every((label) => head.includes(label)) && head.includes("2 comments"), `header: state, author, assignees, labels, comments: ${head}`);

    // The host's text is sanitized: no script runs, nothing is loaded from the network, links are defused.
    const safety = await detail.evaluate((element) => ({
      scripts: element.querySelectorAll("script, iframe, object, embed, form, style").length,
      handlers: [...element.querySelectorAll("*")].filter((node) => [...node.attributes].some((attribute) => attribute.name.startsWith("on"))).length,
      images: element.querySelectorAll("img").length,
      hrefs: [...element.querySelectorAll("a[href]")].map((link) => link.getAttribute("href")),
      pwned: window.__pwned ?? null,
    }));
    equal(safety, { scripts: 0, handlers: 0, images: 0, hrefs: [], pwned: null }, "description and comments: no scripts, no event attributes, no images from the network, no direct links");
    equal(await detail.locator("[data-comment]").count(), 2, "both comments are there");
    check((await detail.locator("[data-issue-comments]").innerText()).includes("Der Logger schreibt nach dem Neustart beide Kanäle."), "markdown in the comment is rendered");
    await shot("issues");

    // "Create branch for this issue": name suggested, editable; checked with git.
    const before = repo.git("rev-parse", "HEAD");
    await tabTo(page, "Create branch for this issue …");
    await press("Enter");
    const dialog = await t.waitDialog(/Branch for issue #7/);
    const field = dialog.getByRole("textbox");
    equal(await field.inputValue(), "7-regenmesser-nord-liefert-doppelte-werte", "the name is suggested from number and title");
    check((await dialog.innerText()).includes("starts at the current commit (main)"), "the dialog says where the branch starts");
    await shot("issues-branch-dialog");
    // The suggestion is editable: a prefix in front, by keyboard.
    await press("Home");
    await page.keyboard.type("fix/");
    equal(await field.inputValue(), "fix/7-regenmesser-nord-liefert-doppelte-werte", "the name can be changed");
    await press("Enter");
    await waitToast(/Branch “fix\/7-regenmesser-nord-liefert-doppelte-werte” created and checked out/, "success", 30_000);
    equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "fix/7-regenmesser-nord-liefert-doppelte-werte", "git: the new branch is checked out");
    equal(repo.git("rev-parse", "HEAD"), before, "git: it starts at the previous commit");
    await t.closeToasts();

    // "Open in browser": the issue's address at the host – no browser starts in the test.
    await tabTo(page, "Open in browser");
    await press("Enter");
    await eventually(opened, [github.issueWebUrlOf(7)], "\"Open in browser\" passes on the issue's address");

    // Esc closes the view; the graph is back.
    await press("Escape");
    await eventually(async () => (await center(tabId))?.kind, "graph", "Esc closes the view");
    repo.git("checkout", "-q", "main");
    repo.git("branch", "-q", "-D", "fix/7-regenmesser-nord-liefert-doppelte-werte");
    equal(await tokenLeaks(app, github.token), [], "the token appears nowhere in the UI");
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("Search and filters: searched at the host, state, \"Assigned to me\"", async () => {
    await blur();
    await runCommand(app, "Show issues", "issues.show");
    await eventually(viewState, "filled", "the list is there");
    equal(await rowNumbers(), OPEN, "open issues, most recently changed first");
    equal(await view().getAttribute("data-layout"), "two", "at 1440×900 list and issue are side by side");

    // "/" jumps into the search field; typing searches at the host.
    await press("/");
    equal(await focusedName(page), "Search issues", "\"/\" puts focus into the search field");
    const from = github.requests.length;
    await page.keyboard.type("Zeitstempel");
    await eventually(rowNumbers, [20, 21, 22, 23, 24, 25, 26, 27, 28], "the search shows only the matches", 15_000);
    const searches = github.sent("GET", /\/search\/issues$/, from);
    check(searches.length >= 1 && searches.length <= 3, `the search runs at the host, debounced (${searches.length} calls for 11 characters)`);
    check(/q=Zeitstempel(\+|%20)repo%3Aschule%2Fmessnetz(\+|%20)is%3Aissue(\+|%20)is%3Aopen/.test(searches.at(-1)?.query ?? ""), `with search text, repository and state: ${searches.at(-1)?.query}`);

    // ArrowDown leads into the list, Enter opens.
    await press("ArrowDown");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("data-issue-row")), "20", "ArrowDown: first row of the list");
    await press("ArrowDown");
    await press("Enter");
    await eventually(() => center(tabId), { kind: "issues", number: 21 }, "Enter opens the issue next to it");
    equal(await page.locator(`${VIEW} [data-issue-row="21"]`).getAttribute("aria-selected"), "true", "the row is marked as selected");

    // No match.
    await press("/");
    await page.keyboard.type("gibtesnicht");
    await eventually(viewState, "empty", "no match: empty state");
    check((await view().innerText()).includes("No issue matches “gibtesnicht”"), "with the search text in the sentence");
    await shot("issues-no-match");
    // Esc in the search field clears it (and does not close the view).
    await press("Escape");
    await eventually(rowNumbers, OPEN, "Esc in the search field clears the search");
    equal((await center(tabId))?.kind, "issues", "the view stays open");

    // State: closed, all.
    const states = view().locator('[aria-label="Issue state"]');
    await states.getByText("Closed", { exact: true }).click();
    await eventually(rowNumbers, [3, 4, 5], "\"Closed\" shows the closed ones");
    check(/state=closed/.test(github.sent("GET", /\/issues$/).at(-1)?.query ?? ""), "the state is sent to the host");
    await states.getByText("All", { exact: true }).focus();
    await press("Enter");
    await eventually(async () => (await rowNumbers()).length, 15, "\"All\" shows open and closed");

    // Assigned to me: issues of the connected account (lena-hartmann).
    await view().getByRole("checkbox", { name: "Assigned to me" }).click();
    await eventually(rowNumbers, [7, 20, 24, 28, 5], "\"Assigned to me\" keeps only your own");
    check(/5 of 15 loaded issues/.test(await view().locator("[data-issues-footer]").innerText()), "the footer says what was filtered from");
    await shot("issues-filter");
    await view().getByRole("checkbox", { name: "Assigned to me" }).click();
    await states.getByText("Open", { exact: true }).click();
    await eventually(rowNumbers, OPEN, "filters reset: the open ones again");
    await closeView(tabId);
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("Many entries: paged, load more by button", async () => {
    for (let index = 0; index < 70; index++) github.addIssue({ number: 200 + index, title: `Station ${String(index + 1).padStart(2, "0")}: Kalibrierung nachtragen`, author: PEOPLE.mats, updatedAt: minutesAgo(2000 + index) });
    await reload();
    await eventually(async () => (await sectionNumbers()).length, 30, "the section shows the first page");
    check(/ISSUES\s*30\+/i.test((await sectionText()) ?? "") && /The first 30 – all of them in the issue view/.test((await sectionText()) ?? ""), `and says there are more: ${(await sectionText())?.slice(0, 80)}`);
    await page.locator(`${SECTION} [data-issues-more] button`).click();
    await eventually(viewState, "filled", "\"issue view\" in the section opens the view");
    equal((await rowNumbers()).length, 30, "first page: 30 issues");
    const footer = view().locator("[data-issues-footer]");
    check(/30 issues loaded/.test(await footer.innerText()) && !/that is all/.test(await footer.innerText()), `footer: ${await footer.innerText()}`);
    // Load more by keyboard.
    await footer.getByRole("button", { name: "Load more" }).focus();
    await press("Enter");
    await eventually(async () => (await rowNumbers()).length, 60, "\"Load more\" appends the next page");
    await footer.getByRole("button", { name: "Load more" }).click();
    await eventually(async () => (await rowNumbers()).length, 82, "third page: all 82");
    check(/82 issues loaded – that is all/.test(await footer.innerText()), `at the end: ${await footer.innerText()}`);
    equal(await footer.getByRole("button", { name: "Load more" }).count(), 0, "no button anymore");
    check(github.sent("GET", /\/issues$/).some((entry) => /[?&]page=3\b/.test(entry.query) && /per_page=30/.test(entry.query)), "the third page was fetched from the host");
    // End and Home in the long list.
    await page.locator(`${VIEW} [data-issue-row="7"]`).focus();
    await press("End");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("data-issue-row")), "269", "End: last row");
    await press("Home");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("data-issue-row")), "7", "Home: first row");
    equal(await escaping(page, VIEW), [], "nothing sticks out of the view");
    await shot("issues-many");
    github.state.issues = github.state.issues.filter((item) => item.number < 200);
    await closeView(tabId);
    await reload();
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("States: loading, rate limit, no permission, not found, token expired", async () => {
    await openView(tabId, null);
    await eventually(viewState, "filled", "starting point: filled");

    // Loading: skeleton while the host does not answer.
    github.set({ delayMs: 2500 });
    await startOver();
    await eventually(viewState, "loading", "loading: the view shows the skeleton");
    equal(await view().locator('[role="status"][aria-label="Loading issues"]').count(), 1, "with a name for screen readers");
    await shot("issues-loading");
    github.set({ delayMs: 0 });
    await eventually(viewState, "filled", "filled afterwards", 15_000);

    // Rate limit exhausted while a list is already shown: it stays, with a note that it is not up to date.
    github.set({ rateLimited: true });
    await reload();
    const stale = view().locator("[data-issues-stale]");
    await eventually(() => stale.getAttribute("data-issues-stale", { timeout: 1000 }).catch(() => null), "rate_limit", "reload failed: the old list stays, with a note");
    equal((await rowNumbers()).length, 12, "the list is still there");
    const staleText = (await stale.innerText()).replace(/\s+/g, " ");
    check(/The list is not up to date/.test(staleText) && LOCAL_TIME.test(staleText), `the note names the reason and the time in local time: ${staleText}`);
    check(/Not up to date/.test((await sectionText()) ?? ""), `the left panel section says so too: ${(await sectionText())?.slice(0, 60)}`);
    await shot("issues-stale");

    // Without an old list: the full-area state – time in local time, "Try again".
    await startOver();
    await eventually(viewState, "rate_limit", "rate limit: its own state");
    const limited = (await view().locator('[data-issues-state="rate_limit"]').innerText()).replace(/\s+/g, " ");
    check(/The host is throttling requests/.test(limited) && LOCAL_TIME.test(limited) && !/\d{4}-\d{2}-\d{2}T/.test(limited), `with the time in local time instead of UTC: ${limited}`);
    equal(await view().locator('[data-issues-state="rate_limit"]').getAttribute("role"), "status", "as a notice, not as an alert");
    check(/The host is throttling requests|rate limit/.test((await sectionText()) ?? ""), `the left panel section shows the reason instead of a list: ${await sectionText()}`);
    await shot("issues-rate-limit");
    github.set({ rateLimited: false });
    await view().getByRole("button", { name: "Try again" }).click();
    await eventually(viewState, "filled", "\"Try again\" loads again");

    // No permission (403 without limit).
    github.set({ issuesForbidden: true });
    await startOver();
    await eventually(viewState, "permission", "403: no permission");
    check(/No permission for the issues/.test(await view().innerText()), "with a title that says so");
    await shot("issues-forbidden");
    github.set({ issuesForbidden: false });

    // Not found (repository gone, issues turned off).
    github.set({ issuesMissing: true });
    await startOver();
    await eventually(viewState, "not_found", "404: not found");
    check(/There are no issues to see here/.test(await view().innerText()), "with an explanation instead of a bare error");
    github.set({ issuesMissing: false });
    await reload();
    await eventually(viewState, "filled", "filled again");

    // Single issue that does not exist (anymore).
    await openView(tabId, 999);
    const missing = page.locator(`${VIEW} article[data-issue="999"]`);
    await eventually(() => missing.getAttribute("data-state"), "error", "unknown number: error in the detail view");
    check(/Issue #999 does not exist in schule\/messnetz/.test(await missing.innerText()), `with the core's message: ${(await missing.innerText()).replace(/\s+/g, " ").slice(0, 160)}`);
    await openView(tabId, null);

    // Token revoked: "token" state, way to the integrations; after replacing it the list reloads by itself.
    github.revoke(github.token);
    await startOver();
    await eventually(viewState, "auth", "token expired: its own state");
    check((await view().getByRole("button", { name: "Open integrations" }).count()) === 1, "with the way to the integrations");
    await shot("issues-token-expired");
    await connectDirect(app, github, github.secondToken);
    await eventually(viewState, "filled", "after replacing the token the list reloads by itself", 20_000);
    equal(await tokenLeaks(app, github.secondToken), [], "the new token appears nowhere either");
    await closeView(tabId);
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("Appearance: 1440×900 dark and light, 960×600 (one column), long content", async () => {
    await openView(tabId, 8);
    const detail = page.locator(`${VIEW} article[data-issue="8"]`);
    await eventually(() => detail.getAttribute("data-state"), "filled", "the issue with the long title is open");
    equal(await escaping(page, VIEW), [], "long title and a 400-character word: nothing sticks out");
    await shot("issues-long");
    await app.invoke("settings_set", { patch: { theme: "light" } });
    await openView(tabId, 7);
    await eventually(() => page.locator(`${VIEW} article[data-issue="7"]`).getAttribute("data-state"), "filled", "issue 7 open");
    await shot("issues-light");
    await app.invoke("settings_set", { patch: { theme: "dark" } });

    // Focus is in the list when the window gets narrow and the list gives way to the issue.
    await page.locator(`${VIEW} [data-issue-row="7"]`).click();
    await app.setSize(960, 600);
    await app.settle();
    await eventually(() => view().getAttribute("data-layout"), "one", "960×600: one column");
    equal(await page.locator(`${VIEW} [data-issues-pane="list"]`).count(), 0, "with an open issue only the issue is shown");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest("[data-issue-scroll]") || document.activeElement?.matches("[data-issue-scroll]"))), true, "focus is in the issue text");
    equal(await escaping(page, VIEW), [], "nothing sticks out (960×600)");
    await shot("issues-min");
    // Esc: first back to the list, then close the view.
    await press("Escape");
    await eventually(() => center(tabId), { kind: "issues", number: null }, "Esc goes back to the list");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-issue-row")), "7", "focus is back on the issue's row");
    await shot("issues-min-list");
    await page.locator(`${VIEW} [data-issue-row="9"]`).click();
    await eventually(() => center(tabId), { kind: "issues", number: 9 }, "click opens the issue");
    await view().getByRole("button", { name: "Back to list" }).click();
    await eventually(() => center(tabId), { kind: "issues", number: null }, "\"Back to list\" by mouse");
    await press("Escape");
    await eventually(async () => (await center(tabId))?.kind, "graph", "Esc once more closes the view");
    await app.setSize(1440, 900);
    await app.settle();
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("No host: no section, the command names the reason", async () => {
    const plain = makeCleanRepoWithRemote({ name: "ohne-hoster" });
    cleanups.push(() => plain.cleanup?.());
    const second = await app.openRepo(plain.path);
    await sleep(600);
    equal(await page.locator(SECTION).count(), 0, "without a remote on GitHub or GitLab there is no section");
    await blur();
    await press("Control+p");
    await page.locator('[data-screen="command-palette"] input[role="combobox"]').waitFor();
    await page.keyboard.type(">Show issues");
    const row = page.locator('[data-screen="command-palette"] [role="option"][data-key="command:issues.show"]');
    await row.waitFor();
    check((await row.innerText()).includes("no remote on a supported host"), `the palette names the reason: ${(await row.innerText()).replace(/\s+/g, " ")}`);
    await press("Escape");
    // Whoever reaches the view anyway (remembered state) gets the explanation.
    await openView(second.tabId, null);
    await eventually(viewState, "no_host", "the view: no host detected");
    await shot("issues-no-host");
    await closeView(second.tabId);
    // A remote on a host the app does not integrate counts the same.
    plain.git("remote", "set-url", "origin", "https://git.example.org/schule/messnetz.git");
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "hostRepo"] }), second.repoId);
    await sleep(600);
    equal(await page.locator(SECTION).count(), 0, "not for other hosts either");
    await page.evaluate((id) => window.__gc.core.tabClose({ tabId: id }).then(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] })), second.tabId);
    await app.settle();
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("Unreachable: the host does not answer", async () => {
    await openView(tabId, null);
    await eventually(viewState, "filled", "starting point: filled");
    await github.close();
    cleanups.splice(cleanups.findIndex((cleanup) => cleanup.host === github), 1);
    await startOver();
    await eventually(viewState, (state) => state === "offline" || state === "other", "without a server: error state instead of an empty list", 60_000);
    const state = await viewState();
    check((await view().getByRole("button", { name: "Try again" }).count()) === 1, `with "Try again" (state ${state})`);
    await shot("issues-offline");
    await closeView(tabId);
    app.consoleErrors.length = 0;
  });

  await stop();

  // ===========================================================================================
  await section("GitLab: list, search and issue of a project in a subgroup", async () => {
    const gitlab = await startHost({ kind: "gitlab", owner: "schule/wetter", name: "messnetz" });
    cleanups.push(() => gitlab.close());
    seedIssues(gitlab);
    const made = makeHostRepo(gitlab);
    cleanups.push(() => made.repo.cleanup?.());
    made.repo.git("checkout", "-q", "main");
    await start();
    const lab = await app.openRepo(made.repo.path);
    await connectDirect(app, gitlab);
    await eventually(sectionNumbers, OPEN, "the section shows the open issues of the GitLab project", 20_000);
    await openView(lab.tabId, null);
    await eventually(viewState, "filled", "the view is filled");
    check((await view().locator("header").first().innerText()).includes("schule/wetter/messnetz"), "the header names group, subgroup and project");
    check(gitlab.sent("GET", /\/issues$/).some((entry) => /state=opened/.test(entry.query) && entry.path.includes("/projects/schule/wetter/messnetz/")), "the project's GitLab API is queried");

    await press("/");
    await page.keyboard.type("Diagramme");
    await eventually(rowNumbers, [9], "the search runs via GitLab", 15_000);
    check(/search=Diagramme/.test(gitlab.sent("GET", /\/issues$/).at(-1)?.query ?? ""), "with `search`");
    await press("ArrowDown");
    await press("Enter");
    const detail = page.locator(`${VIEW} article[data-issue="9"]`);
    await eventually(() => detail.getAttribute("data-state"), "filled", "the issue is loaded");
    const head = (await detail.locator("header").innerText()).replace(/\s+/g, " ");
    check(head.includes("Größe der Diagramme für kleine Bildschirme ändern #9") && head.includes("jonas") && head.includes("aylin"), `title and both assignees: ${head}`);
    check((await detail.locator("[data-issue-body]").innerText()).includes("No description."), "without a description that is stated");
    await detail.locator('[data-action="issue-web"]').click();
    await eventually(opened, [gitlab.issueWebUrlOf(9)], "\"Open in browser\" uses the GitLab address (/-/issues/9)");
    await view().getByRole("button", { name: "Open issues in browser" }).click();
    await eventually(async () => (await opened()).at(-1), `${gitlab.webUrl}/-/issues`, "the list at the host");
    await shot("issues-gitlab");
    equal(await tokenLeaks(app, gitlab.token), [], "the token appears nowhere");
    equal(app.consoleErrors, [], "console errors");
  });
  await stop();

  // ===========================================================================================
  await section("Cross-check against the core's test server (host-mock.mjs): list, issue, 304, errors", async () => {
    const mock = await startHostMock();
    cleanups.push(() => mock.close());
    const plain = makeCleanRepoWithRemote({ name: "gegenprobe" });
    cleanups.push(() => plain.cleanup?.());
    // The remote points to the test server by address only (there is no Git behind it); nothing is fetched.
    plain.git("remote", "set-url", "origin", mock.remoteUrl("github"));
    await start();
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    const probe = await app.openRepo(plain.path);
    await app.invoke("host_connect", { kind: "github", baseUrl: mock.url, token: mock.token });
    await refreshHostQueries(app);
    // The data: 12 entries, divisible by 4 = closed, divisible by 3 = pull request (filtered out by the core).
    await eventually(sectionNumbers, [11, 10, 7, 5, 2, 1], "the section shows the open issues – without the pull requests from the same list", 20_000);
    await openView(probe.tabId, null);
    await eventually(viewState, "filled", "the view is filled");
    check((await view().locator("header").first().innerText()).includes("octo/demo"), "the header names the repository");
    await view().getByRole("checkbox", { name: "Assigned to me" }).click();
    await eventually(rowNumbers, [2], "\"Assigned to me\": the issue of the connected account (lena-hartmann)");
    await page.locator(`${VIEW} [data-issue-row="2"]`).click();
    const detail = page.locator(`${VIEW} article[data-issue="2"]`);
    await eventually(() => detail.getAttribute("data-state"), "filled", "the issue is loaded");
    check((await detail.locator("[data-issue-title]").innerText()).replace(/\s+/g, " ") === "Problem 2 #2", "title and number");
    check((await detail.locator("[data-issue-body]").innerText()).includes("Text zu Problem 2"), "description");
    check((await detail.locator("[data-issue-comments]").innerText()).includes("Danke fürs Ansehen!"), "comment");
    await view().getByRole("checkbox", { name: "Assigned to me" }).click();
    await eventually(rowNumbers, [11, 10, 7, 5, 2, 1], "without filter all open ones again");

    // Reload: the server answers "not modified" (304), the list stays as it is.
    const from = mock.requests.length;
    await reload();
    await eventually(() => mock.requests.slice(from).some((entry) => entry.path.endsWith("/issues") && entry.status === 304), true, "on reload the server answers 304 (not modified)");
    equal(await rowNumbers(), [11, 10, 7, 5, 2, 1], "the list is unchanged");

    // Server errors: rate limit, unreadable response, server error – each its own state, recovered afterwards.
    mock.fail("rate_limit", { match: "/issues" });
    await startOver();
    await eventually(viewState, "rate_limit", "rate limit exhausted");
    check(LOCAL_TIME.test(await view().innerText()), "with the time in local time");
    mock.recover();
    mock.fail("broken_json", { match: "/issues" });
    await startOver();
    await eventually(viewState, "other", "truncated response: error state instead of half a list");
    const listPane = view().locator('[data-issues-pane="list"]');
    check((await listPane.getByRole("button", { name: "Try again" }).count()) === 1, "with \"Try again\"");
    mock.recover();
    mock.fail("server_error", { match: "/issues" });
    await startOver();
    await eventually(viewState, "other", "server error");
    mock.recover();
    await listPane.getByRole("button", { name: "Try again" }).click();
    await eventually(viewState, "filled", "\"Try again\" loads again");
    equal(await tokenLeaks(app, mock.token), [], "the token appears nowhere in the UI");
    app.consoleErrors.length = 0;
  });
} finally {
  await stop();
  for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
}
t.finish();
