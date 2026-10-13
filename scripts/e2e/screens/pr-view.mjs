/**
 * pr-view – Pull request view and the "Pull requests" section in the sidebar: in the real app,
 * against a LOCAL host (host-lib.mjs) shaped like GitHub and GitLab, and against the core's
 * test server (scripts/e2e/host-mock.mjs). Behind the remote is a real Git server on
 * 127.0.0.1 – "Fetch" and "Check out branch" really run. Nothing calls real services.
 *
 *   node scripts/e2e/screens/pr-view.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/pr-view.mjs --only merge     only sections whose title contains the word
 *   node scripts/e2e/screens/pr-view.mjs --show           visible window
 *
 * Checks what arrives at the host (comment, merge method, deleted branch, closing), what
 * happens in the repository (fetch, checked-out branch), and that texts from the host run
 * nothing and load nothing from the network.
 */
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { startHostMock } from "../host-mock.mjs";
import { finish, makeChecks } from "./files-lib.mjs";
import { LONG_BRANCH, LONG_TITLE, PEOPLE, SHOTS, connectDirect, escaping, focusedName, keychainEntries, keyringName, makeHostRepo, recordConsole, refreshHostQueries, seedMany, seedPrs, startHost, sweepKeychain, tabTo, tokenLeaks } from "./host-lib.mjs";
import { pageHelpers } from "./prefs-lib.mjs";

const show = process.argv.includes("--show");
const checks = makeChecks("pr-view");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

sweepKeychain();
const KEYRING = keyringName("s24");
const github = await startHost({ kind: "github" });
const gitlab = await startHost({ kind: "gitlab", owner: "landesnetz/schulen" });
const coreMock = await startHostMock();
const gh = makeHostRepo(github);
const gl = makeHostRepo(gitlab);
seedPrs(github, gh.sha);
seedPrs(gitlab, gl.sha);

const sorted = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const VIEW = '[data-screen="pr-view"]';
const SECTION = '[data-extra-section="pull-requests"]';

let app = null;
try {
  app = await launchApp({ show, env: { FORKYARD_KEYRING_SERVICE: KEYRING } });
  state.app = app;
  const { page } = app;
  const h = pageHelpers(app);
  const consoleLines = recordConsole(app);
  await page.evaluate(() => (window.__gcTestOpened = []));
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const { repoId, tabId } = await app.openRepo(gh.repo.path);
  await connectDirect(app, github);

  const view = page.locator(VIEW);
  const head = view.locator("[data-pr-head]");
  const panel = page.locator(SECTION);
  const center = (tab = tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.center ?? null, tab);
  const setCenter = (value, tab = tabId) => page.evaluate(([id, next]) => window.__gc.store.getState().setCenter(id, next), [tab, value]);
  const openPr = async (number, tab = tabId) => {
    await setCenter({ kind: "pr", number }, tab);
    await page.locator(`${VIEW}[data-pr-number="${number}"] [data-pr-head]`).waitFor({ timeout: 30_000 });
    await app.settle();
  };
  const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
  const opened = () => page.evaluate(() => window.__gcTestOpened.slice());
  const rows = () => panel.locator('[data-kind="pull-request"]').evaluateAll((list) => list.map((row) => Number(row.dataset.pr)));
  // textContent instead of innerText: the header is uppercased via CSS.
  const panelCount = () => panel.locator("[data-section-header] button").first().evaluate((button) => Array.from(button.querySelectorAll("span")).map((span) => span.textContent.trim()).join(" "));
  const groups = () =>
    panel.locator("[data-pr-groups] [role=radio]").evaluateAll((list) => list.map((item) => `${item.firstChild.textContent.trim()} ${item.querySelector("span").textContent.trim()}${item.getAttribute("aria-checked") === "true" ? " ✓" : ""}`));
  const phase = () => head.locator("[data-pr-phase]").getAttribute("data-pr-phase");
  const headText = () => head.innerText().then((text) => text.replace(/\s+/g, " ").trim());
  const tab = (name) => view.getByRole("tab", { name });
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  const refresh = async () => {
    await view.getByRole("button", { name: "Refresh" }).click();
    await app.settle();
  };
  state.resetView = async () => {
    for (let round = 0; round < 3 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) await page.keyboard.press("Escape");
    await h.closeToasts();
  };

  // -------------------------------------------------------------------------------------------
  await section("Sidebar: section with counter, groups and filter – a click opens the view", async () => {
    await panel.waitFor();
    await eventually(rows, [12, 14, 15, 9], "the open pull requests, most recently changed first");
    equal(await panelCount(), "Pull requests 4", "counter in the section header");
    equal(await groups(), ["Mine 2", "To review 1", "All 4 ✓"], "groups with counters: mine, to review, all");
    const first = panel.locator('[data-pr="12"]');
    const label = await first.getAttribute("aria-label");
    check(/Pull request 12: CSV-Export für den Vergleich, Open, by .*, feature\/export into main, .*Checks passed, Review pending/.test(label ?? ""), `the row says everything in its name (${label})`);
    equal(await first.locator("[data-pr-checks]").getAttribute("data-pr-checks"), "passing", "checks as an icon on the row");
    equal(await panel.locator('[data-pr="15"]').getAttribute("data-pr-phase"), "draft", "drafts are marked as such");

    await panel.getByRole("radio", { name: /^Mine/ }).click();
    await eventually(rows, [14, 15], "“Mine”: those of the connected account");
    await panel.getByRole("radio", { name: /^To review/ }).click();
    await eventually(rows, [12], "“To review”: by others, review requested and pending");
    // The group also switches with the arrow keys.
    await page.keyboard.press("ArrowRight");
    await eventually(groups, ["Mine 2", "To review 1", "All 4 ✓"], "arrow right switches to “All”");
    await eventually(() => focusedName(page), "All4", "focus follows");

    // The panel filter applies here too.
    const filter = page.getByRole("searchbox").or(page.getByPlaceholder(/Filter/)).first();
    await filter.fill("export");
    await eventually(rows, [12], "filter “export”: only the matching pull request");
    equal(await panelCount(), "Pull requests 1/4", "counter while filtering");
    await filter.fill("lena");
    await eventually(rows, [14, 15], "the filter also matches the author");
    await filter.fill("gibt-es-nicht");
    await eventually(() => panel.count(), 0, "without results the section disappears like the others");
    await filter.fill("");
    await eventually(rows, [12, 14, 15, 9], "without a filter all again");

    await first.click();
    await eventually(center, { kind: "pr", number: 12 }, "a click on the row opens the view");
    await head.waitFor();
    equal(await first.getAttribute("aria-current"), "true", "the row of the open pull request is marked");
    await shot("pr-view");
  });

  // -------------------------------------------------------------------------------------------
  await section("View: header, checks as text, description rendered safely, comments, commits, files", async () => {
    await openPr(12);
    const text = await headText();
    check(text.includes("CSV-Export für den Vergleich #12"), "title with number");
    equal(await phase(), "open", "state: open (as the word “Open”)");
    check(text.includes("Open") && /Jonas/i.test(text), `state and author (${text})`);
    equal(await head.locator('[title^="Source:"], [title^="Target:"]').allInnerTexts(), ["feature/export", "main"], "source and target");
    equal(await head.locator("[data-checks]").getAttribute("data-checks"), "passing", "checks: passed");
    check(/checks passed/i.test(await head.locator("[data-checks]").innerText()), "… as text, not only as an icon");
    equal(await head.locator("[data-review]").innerText(), "Review pending", "review state as text");
    equal(await focusedName(page), "Conversation2", "on opening the focus is on the active tab");

    // Description: nothing runs, nothing loads from the network.
    const body = view.locator("[data-pr-body]");
    equal(await page.evaluate(() => window.__evil ?? null), null, "no script and no event attribute from the description was run");
    equal(await view.locator("script, iframe, img, [onclick], [onerror]").count(), 0, "no script, iframe, img or event attribute in the view's document");
    equal(await body.locator("[data-readme-image]").allInnerTexts(), ["Image", "Image: Diagramm"], "images are placeholders with their alt text");
    check((await body.locator("[data-markdown-note]").innerText()).includes("2 images not loaded"), "and the note says that nothing is fetched from the network");
    equal(await body.locator("a[href]").count(), 0, "no link can navigate inside the app");
    equal(await body.locator("a[data-inert]").count(), 1, "the javascript: link is dead");
    equal(await body.locator("pre code").count(), 1, "code block stays code");
    equal(await body.locator("[data-readme-task]").count(), 2, "task list as characters, not as form fields");
    await body.locator('a[data-href="https://example.org/projekt"]').click();
    const ask = page.getByRole("dialog", { name: "Open link outside the app?" });
    await ask.waitFor();
    check((await ask.innerText()).includes("https://example.org/projekt"), "a link asks first and shows its target");
    await ask.getByRole("button", { name: "Open link", exact: true }).click();
    await eventually(opened, ["https://example.org/projekt"], "and then goes to the system browser (here: to the test instead of a browser)");

    // Reviewers, labels, checks, comments.
    const reviewers = (await view.locator("[data-pr-reviewers] li").allInnerTexts()).map((line) => line.replace(/\s+/g, " ").trim());
    check(reviewers.some((line) => /Aylin/i.test(line) && line.includes("Approved")) && reviewers.some((line) => /lena/i.test(line) && line.includes("requested")), `reviewers with state (${reviewers.join(" | ")})`);
    equal((await view.locator("[data-pr-labels] li").allInnerTexts()).sort(), ["daten", "export"], "labels");
    equal(await view.locator("[data-pr-checks] li").evaluateAll((list) => list.map((item) => `${item.dataset.check}: ${item.querySelector("span")?.textContent}`)), ["passing: build", "passing: test (windows)", "skipped: lint"], "the individual checks with state");
    const comments = view.locator("[data-comment]");
    equal(await comments.count(), 2, "two comments");
    check((await comments.nth(1).innerText()).includes("src/export.py:4"), "a comment on a line names file and line");
    equal(await comments.first().locator("strong").innerText(), "Kopf", "Markdown in comments is rendered");

    // Commits.
    await tab(/Commits/).click();
    const commit = view.locator(`[data-commit="${gh.sha.feature}"]`);
    await commit.waitFor();
    check((await commit.innerText()).includes(gh.sha.feature.slice(0, 7)) && (await commit.innerText()).includes("CSV-Export für den Vergleich"), "commit with short SHA and message");
    await shot("pr-view-commits");

    // Files: from the local repository, with the app's diff view.
    await tab(/Files/).click();
    const files = view.locator("[data-pr-files]");
    await eventually(() => files.getAttribute("data-pr-files"), "local", "the commits are available locally");
    await until(async () => (await files.innerText()).includes("1 file changed"), "summary: one file changed");
    check((await files.innerText()).includes("from the local repository"), "and where the diff comes from");
    await until(async () => (await files.locator('[data-screen="diff"]').innerText().catch(() => "")).includes("def zeile(station, wert):"), "the diff shows the file content from the pull request");
    await shot("pr-view-files");

    // A commit can be shown in the graph.
    await tab(/Commits/).click();
    await commit.click();
    await eventually(async () => (await center())?.kind, "graph", "a click on the commit leads to the graph");
    equal(await page.evaluate((id) => window.__gc.store.getState().views[id]?.selection, tabId), { kind: "commits", shas: [gh.sha.feature] }, "and selects it there");
  });

  // -------------------------------------------------------------------------------------------
  await section("Keyboard only: open from the sidebar, switch tabs, comment, close", async () => {
    const before = github.requests.length;
    await page.keyboard.press("Alt+1");
    // Arrow keys down to the pull request's row (the sections form one list).
    for (let step = 0; step < 60 && (await page.evaluate(() => document.activeElement?.getAttribute("data-pr"))) !== "12"; step++) await page.keyboard.press("ArrowDown");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("data-pr")), "12", "the row of #12 is reachable with the arrow keys");
    await page.keyboard.press("Enter");
    await head.waitFor();
    await eventually(() => focusedName(page), "Conversation2", "Enter opens the view, focus goes to the tab");
    await page.keyboard.press("ArrowRight");
    await eventually(() => view.getByRole("tab", { selected: true }).innerText(), "Commits\n1", "arrow right: Commits");
    await page.keyboard.press("ArrowRight");
    await eventually(async () => (await view.getByRole("tab", { selected: true }).innerText()).trim(), "Files", "arrow right: Files");
    await page.keyboard.press("Home");
    await eventually(async () => (await view.getByRole("tab", { selected: true }).innerText()).startsWith("Conversation"), true, "Home: back to the conversation");

    await tabTo(page, "Write a comment (Markdown)");
    await page.keyboard.type("Danke – **passt** so. Größe und Einheit stimmen.");
    await page.keyboard.press("Control+Enter");
    await eventually(() => view.locator("[data-comment]").count(), 3, "the comment appears in the conversation", 20_000);
    equal(github.sent("POST", /\/issues\/12\/comments$/, before).map((entry) => entry.body), [{ body: "Danke – **passt** so. Größe und Einheit stimmen." }], "the host got exactly this text");
    equal(await view.locator('textarea[name="comment"]').inputValue(), "", "the field is empty again");
    check((await view.locator("[data-comment]").last().innerText()).includes("Größe und Einheit stimmen"), "with umlauts, rendered as Markdown");
    check((await toasts()).some((toast) => toast.tone === "success" && toast.text.includes("Comment sent")), "success message");

    // In the text field Esc belongs to the field; from the tab it closes the view.
    await page.keyboard.press("Escape");
    equal((await center())?.kind, "pr", "Esc in the text field does not close the view");
    await tabTo(page, /^Conversation/, { back: true });
    await page.keyboard.press("Escape");
    await eventually(async () => (await center())?.kind, "graph", "Esc from the tab closes the view");
  });

  // -------------------------------------------------------------------------------------------
  await section("Merging is blocked – with a reason: conflicts, failed checks, draft, running checks", async () => {
    await openPr(14);
    const merge = view.getByRole("button", { name: "Merge …" });
    check(await merge.isDisabled(), "#14: “Merge …” is blocked");
    const reason = view.locator("[data-merge-blocked]");
    check((await reason.innerText()).includes("Merging is blocked:") && (await reason.innerText()).includes("conflicts with the target branch"), `the reason is shown next to it, not only in the tooltip (${(await reason.innerText()).replace(/\s+/g, " ")})`);
    equal(await merge.getAttribute("aria-describedby"), "s24-merge-blocked", "and is linked to the button for screen readers");
    equal(await head.locator("[data-checks]").innerText(), "1 of 2 checks failed", "checks as text");
    equal(await head.locator("[data-review]").innerText(), "Changes requested", "reviews as text");
    // Very long title, very long branch name.
    equal(await head.locator("[data-pr-title]").getAttribute("title"), LONG_TITLE, "the full title is in the tooltip");
    equal(await head.locator('[title^="Source:"]').getAttribute("title"), `Source: ${LONG_BRANCH}`, "so is the full branch name");
    equal(await escaping(page, VIEW), [], "nothing sticks out of the view");
    // A review with text appears as a comment in the conversation.
    check((await view.locator("[data-comment]").allInnerTexts()).join(" ").includes("Bitte die Grenzwerte belegen."), "the review's text is in the conversation");
    await shot("pr-view-blocked");

    // Files: this pull request's commits do not exist locally (nor on the server).
    await tab(/Files/).click();
    await eventually(() => view.locator("[data-pr-files]").getAttribute("data-pr-files"), "missing", "files: the commits are missing locally");
    check((await view.locator("[data-pr-files]").innerText()).includes("not available locally yet"), "with a hint and “Fetch”");
    await shot("pr-view-files-missing");

    await openPr(15);
    equal(await phase(), "draft", "#15: draft");
    check((await view.locator("[data-merge-blocked]").innerText()).includes("draft"), "draft: blocked with a reason");
    equal(await head.locator("[data-checks]").innerText(), "1 of 1 checks still running", "running checks as text");
  });

  // -------------------------------------------------------------------------------------------
  await section("Files missing locally: “Fetch” brings them; “Check out branch” fetches and checks out", async () => {
    await openPr(9);
    await tab(/Files/).click();
    const files = view.locator("[data-pr-files]");
    await eventually(() => files.getAttribute("data-pr-files"), "missing", "#9: the commits are only on the server");
    equal(gh.repo.git("branch", "--list", "station/hafen"), "", "the branch does not exist locally");
    await files.getByRole("button", { name: "Fetch", exact: true }).click();
    await eventually(() => files.getAttribute("data-pr-files"), "local", "after the fetch the files are there – without reopening anything", 60_000);
    await until(async () => (await files.innerText()).includes("hafen.md"), "the changed file");
    equal(gh.repo.git("rev-parse", "refs/remotes/origin/station/hafen"), gh.sha.hafen, "the fetch got the branch from the server");
    await h.closeToasts();

    await view.getByRole("button", { name: "Check out branch" }).click();
    await eventually(() => gh.repo.git("rev-parse", "--abbrev-ref", "HEAD"), "station/hafen", "“Check out branch” checks out the pull request's branch", 60_000);
    equal(gh.repo.git("rev-parse", "HEAD"), gh.sha.hafen, "on the pull request's commit");
    equal(gh.repo.git("rev-parse", "--abbrev-ref", "station/hafen@{upstream}"), "origin/station/hafen", "with upstream");
    await until(async () => (await toasts()).some((toast) => toast.tone === "success" && toast.text.includes("“station/hafen” checked out")), "success message");
    equal((await center())?.kind, "pr", "the view stays open");
  });

  // -------------------------------------------------------------------------------------------
  await section("Merge: choose method, delete branch – the host gets it, then “Merged”", async () => {
    await openPr(9);
    const before = github.requests.length;
    check((await view.locator("[data-merge-blocked]").count()) === 0, "#9 is mergeable: no blocking reason");
    await view.getByRole("button", { name: "Merge …" }).click();
    const dialog = page.getByRole("dialog", { name: "Merge pull request #9" });
    await dialog.waitFor();
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on “Cancel”");
    check((await dialog.innerText()).includes("Nothing changes locally until the next fetch"), "the dialog says where the merge happens");
    await dialog.getByRole("combobox").click();
    equal(await page.getByRole("option").allInnerTexts(), ["Merge commit", "Squash", "Rebase"], "GitHub: three methods");
    await page.getByRole("option", { name: "Squash" }).click();
    check((await dialog.innerText()).includes("squashed into a single one"), "the method is explained");
    await dialog.getByRole("checkbox").click();
    await shot("pr-merge");
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    await eventually(() => dialog.count(), 0, "the dialog closes", 20_000);
    equal(github.sent("PUT", /\/pulls\/9\/merge$/, before).map((entry) => entry.body), [{ merge_method: "squash" }], "the host gets the method");
    equal(github.sent("DELETE", /\/git\/refs\/heads\/station\/hafen$/, before).length, 1, "and deletes the branch there");
    await eventually(phase, "merged", "the view shows “Merged”");
    equal(await view.getByRole("button", { name: /^(Merge …|Close …|Reopen)$/ }).count(), 0, "a merged pull request offers neither merge nor close");
    const done = (await toasts()).find((toast) => toast.text.includes("Pull request #9 merged"));
    check(Boolean(done) && done.text.includes("Fetch now"), `message with the offer to fetch (${done?.text})`);
    await eventually(rows, [12, 14, 15], "in the sidebar it is no longer among the open ones");
    equal(await panelCount(), "Pull requests 3", "the counter follows");
    await shot("pr-view-merged");
  });

  // -------------------------------------------------------------------------------------------
  await section("Close (with confirmation) and reopen", async () => {
    await openPr(15);
    const before = github.requests.length;
    await view.getByRole("button", { name: "Close …" }).click();
    const ask = page.getByRole("dialog", { name: "Close pull request #15?" });
    await ask.waitFor();
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "confirmation, focus on “Cancel”");
    await page.keyboard.press("Enter");
    await eventually(() => ask.count(), 0, "Cancel closes nothing");
    equal(github.sent("PATCH", /\/pulls\/15$/, before).length, 0, "so far nothing went to the host");
    await view.getByRole("button", { name: "Close …" }).click();
    await ask.getByRole("button", { name: "Close pull request", exact: true }).click();
    await eventually(phase, "closed", "state: closed");
    equal(github.sent("PATCH", /\/pulls\/15$/, before).map((entry) => entry.body), [{ state: "closed" }], "the host closed it");
    await eventually(rows, [12, 14], "it is now missing from the sidebar");
    await view.getByRole("button", { name: "Reopen" }).click();
    await eventually(phase, "draft", "open again (as a draft, like before)");
    equal(github.sent("PATCH", /\/pulls\/15$/, before).map((entry) => entry.body), [{ state: "closed" }, { state: "open" }], "the host reopened it");
  });

  // -------------------------------------------------------------------------------------------
  await section("Open in browser; not found; no permission", async () => {
    await openPr(12);
    await page.evaluate(() => (window.__gcTestOpened.length = 0));
    await view.getByRole("button", { name: "Open in browser", exact: true }).click();
    await eventually(opened, [github.webUrlOf(12)], "“Open in browser” passes the pull request's address to the system");
    await view.getByRole("button", { name: "Open check “build” in browser" }).click();
    await eventually(opened, [github.webUrlOf(12), `${github.base}/ci/build`], "likewise a check's page");

    // No permission when commenting (403 from the host).
    github.set({ readOnly: true });
    await view.locator('textarea[name="comment"]').fill("Das darf ich hier nicht.");
    await view.getByRole("button", { name: "Comment", exact: true }).click();
    await until(async () => (await toasts()).some((toast) => toast.tone === "danger" && /Comment failed/.test(toast.text) && /permission/i.test(toast.text)), "no permission: the message names the reason");
    equal(await view.locator('textarea[name="comment"]').inputValue(), "Das darf ich hier nicht.", "the text stays in the field");
    await shot("pr-view-forbidden");
    github.set({ readOnly: false });
    await view.locator('textarea[name="comment"]').fill("");
    await h.closeToasts();

    await setCenter({ kind: "pr", number: 999 });
    await eventually(() => view.locator("[data-pr-state]").getAttribute("data-pr-state"), "error-not_found", "a number that does not exist: its own state");
    check((await view.innerText()).includes("Pull request #999 does not exist (anymore)"), "with a clear sentence");
    await shot("pr-view-not-found");
  });

  // -------------------------------------------------------------------------------------------
  await section("Rate limit and expired token mid-session", async () => {
    await openPr(12);
    github.set({ rateLimited: true });
    await refresh();
    const stale = view.locator("[data-pr-stale]");
    await stale.waitFor();
    equal(await stale.getAttribute("data-pr-stale"), "rate_limit", "rate limit on refresh: notice above the content");
    check(/last loaded state/.test(await stale.innerText()) && /\d{1,2}:\d{2}\s?[AP]M/.test(await stale.innerText()), `with the time in local time (${(await stale.innerText()).replace(/\s+/g, " ")})`);
    check((await headText()).includes("CSV-Export für den Vergleich"), "the last loaded state stays");
    await shot("pr-view-rate-limit-stale");
    // A pull request that was never loaded: full-area state with “Try again”.
    github.addPr({ number: 16, title: "Winddaten ergänzt", author: PEOPLE.mats, source: "thema/wind", headSha: "4".repeat(40), updatedAt: new Date().toISOString() });
    await setCenter({ kind: "pr", number: 16 });
    await eventually(() => view.locator("[data-pr-state]").getAttribute("data-pr-state"), "error-rate_limit", "not loaded: rate limit as a whole state");
    check((await view.innerText()).includes("The host is throttling requests"), "with a heading");
    await shot("pr-view-rate-limit");
    github.set({ rateLimited: false });
    await view.getByRole("button", { name: "Try again" }).click();
    await page.locator(`${VIEW}[data-pr-number="16"] [data-pr-head]`).waitFor({ timeout: 20_000 });
    check((await headText()).includes("Winddaten ergänzt"), "after the limit “Try again” loads the pull request");

    // The token is revoked at the host while the view is open.
    await openPr(12);
    github.revoke(github.token);
    await refresh();
    await eventually(() => stale.getAttribute("data-pr-stale"), "auth", "expired token: notice above the content", 20_000);
    check((await stale.innerText()).includes("rejects the token"), "says that the host rejects the token");
    await shot("pr-view-token-expired");
    await stale.getByRole("button", { name: "Open integrations" }).click();
    const hosts = page.locator('[data-screen="hosts"]');
    await hosts.waitFor();
    await eventually(() => hosts.locator("[data-account]").getAttribute("data-state"), "expired", "the integrations show the account as “token expired” – without anyone pressing “Check”");
    await hosts.getByRole("button", { name: /^Replace token for .*$/ }).click();
    const connect = page.locator('[data-screen="hosts-connect"]');
    await connect.waitFor();
    await connect.locator('input[name="token"]').fill(github.secondToken);
    await page.getByRole("button", { name: "Replace token", exact: true }).click();
    await eventually(() => hosts.locator("[data-account]").getAttribute("data-state"), "ok", "connected again with the new token", 20_000);
    await page.keyboard.press("Escape");
    await eventually(() => page.locator('[data-screen="settings"]').count(), 0, "settings closed");
    await eventually(() => stale.count(), 0, "the view then reloads by itself – the notice is gone", 20_000);
    await eventually(async () => (await rows()).sort((a, b) => a - b), [12, 14, 15, 16], "and the sidebar shows the list again");
  });

  // -------------------------------------------------------------------------------------------
  await section("Many entries: load more in the section, long conversation", async () => {
    seedMany(github, 45);
    const many = github.pr(12);
    for (let index = 0; index < 120; index++) many.comments.push({ id: 7000 + index, author: index % 2 ? PEOPLE.mats : PEOPLE.aylin, body: `Rückmeldung ${index + 1}: läuft bei mir.`, createdAt: new Date(Date.now() - (200 - index) * 1000).toISOString(), path: null, line: null });
    await page.getByRole("button", { name: "Refresh pull requests" }).click({ force: true });
    await eventually(async () => (await rows()).length, 20, "first page: 20 entries", 20_000);
    equal(await panelCount(), "Pull requests 20+", "the counter shows that there are more");
    await panel.getByRole("button", { name: "Load more" }).click();
    await eventually(async () => (await rows()).length, 40, "“Load more” gets the next page", 20_000);
    await panel.getByRole("button", { name: "Load more" }).click();
    await eventually(async () => (await rows()).length, 49, "up to the end", 20_000);
    equal(await panel.getByRole("button", { name: "Load more" }).count(), 0, "afterwards there is nothing more to load");
    equal(await panelCount(), "Pull requests 49", "counter without plus");
    equal(await groups(), ["Mine 17", "To review 1", "All 49 ✓"], "the groups count along");
    await shot("pr-view-many");

    await openPr(12);
    await refresh();
    await eventually(() => view.locator("[data-comment]").count(), 123, "123 comments in the conversation", 20_000);
    equal(await escaping(page, VIEW), [], "nothing sticks out of the view");
    await view.locator("[data-comment]").last().scrollIntoViewIfNeeded();
    check(await view.locator("[data-comment-form] textarea").isVisible(), "the comment field stays reachable at the end");
  });

  // -------------------------------------------------------------------------------------------
  await section("GitLab shape: view a merge request, pipeline as checks, merge without “Rebase”", async () => {
    const second = await app.openRepo(gl.repo.path);
    await connectDirect(app, gitlab);
    await eventually(rows, [12, 14, 15, 9], "sidebar: the GitLab project's merge requests");
    await openPr(12, second.tabId);
    const text = await headText();
    check(text.includes("CSV-Export für den Vergleich #12") && text.includes("Open"), `header (${text})`);
    equal(await head.locator("[data-checks]").getAttribute("data-checks"), "passing", "pipeline: passed");
    equal(await view.locator("[data-pr-checks] li").evaluateAll((list) => list.map((item) => `${item.dataset.check}: ${item.querySelector("span")?.textContent}`)), ["passing: build", "passing: test (windows)", "skipped: lint"], "the pipeline jobs as individual checks");
    equal(await view.locator("[data-comment]").count(), 2, "comments (notes)");
    check((await view.locator("[data-comment]").nth(1).innerText()).includes("src/export.py:4"), "here too with file and line");
    equal(await page.evaluate(() => window.__evil ?? null), null, "the GitLab description runs nothing either");
    await shot("pr-view-gitlab");

    await openPr(9, second.tabId);
    const before = gitlab.requests.length;
    await view.getByRole("button", { name: "Merge …" }).click();
    const dialog = page.getByRole("dialog", { name: "Merge pull request #9" });
    await dialog.waitFor();
    await dialog.getByRole("combobox").click();
    equal(await page.getByRole("option").allInnerTexts(), ["Merge commit", "Squash"], "GitLab: no “Rebase” to choose");
    await page.getByRole("option", { name: "Squash" }).click();
    await dialog.getByRole("checkbox").click();
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    await eventually(phase, "merged", "merged", 20_000);
    equal(gitlab.sent("PUT", /\/merge_requests\/9\/merge$/, before).map((entry) => sorted(entry.body)), [{ should_remove_source_branch: true, squash: true }], "GitLab gets squash and “remove source branch”");
    await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), second.tabId);
    await app.invoke("tab_activate", { tabId });
    await app.settle();
  });

  // -------------------------------------------------------------------------------------------
  await section("Against the core's test server (host-mock.mjs): list, view, comment, merge, limit, 401", async () => {
    const repo = makeCleanRepoWithRemote({ name: "demo" });
    repo.git("remote", "add", "hoster", coreMock.remoteUrl("github"));
    await app.invoke("host_connect", { kind: "github", baseUrl: coreMock.url, token: coreMock.token });
    const third = await app.openRepo(repo.path);
    await refreshHostQueries(app);
    await eventually(async () => (await rows()).length, 20, "sidebar: first page of the test server's pull requests", 30_000);
    equal(await panelCount(), "Pull requests 20+", "with the hint that there are more");
    check((await rows()).includes(1) === false && (await rows())[0] === 44, `most recently changed first, merged and closed ones are missing (${(await rows()).slice(0, 5).join(", ")} …)`);

    await openPr(1, third.tabId);
    check((await headText()).includes("Anmeldung: Fehlermeldung bei leerem Passwort #1"), "pull request #1 of the test server");
    equal(await head.locator("[data-checks]").getAttribute("data-checks"), "passing", "checks: passed (check runs and commit status combined)");
    equal(await head.locator("[data-review]").innerText(), "Approved", "review: approved");
    check((await view.locator("[data-comment]").allInnerTexts()).join(" ").includes("src/anmeldung.rs:42"), "comment on a line");
    await tab(/Files/).click();
    await eventually(() => view.locator("[data-pr-files]").getAttribute("data-pr-files"), "missing", "files: the made-up commits do not exist locally – a hint instead of an error");
    await tab(/Conversation/).click();

    await view.locator('textarea[name="comment"]').fill("Kommentar an den Test-Server.");
    await view.getByRole("button", { name: "Comment", exact: true }).click();
    await eventually(() => coreMock.state.comments.map((entry) => [entry.number, entry.body]), [[1, "Kommentar an den Test-Server."]], "the test server has the comment");

    await openPr(13, third.tabId);
    check((await view.locator("[data-merge-blocked]").innerText()).includes("conflicts"), "#13 cannot be merged: blocked with a reason");
    await openPr(6, third.tabId);
    await view.getByRole("button", { name: "Merge …" }).click();
    const dialog = page.getByRole("dialog", { name: "Merge pull request #6" });
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    await eventually(() => [...coreMock.state.merged], [6], "the test server merged #6", 20_000);
    await eventually(phase, "merged", "and the view shows it");
    await h.closeToasts();

    // Rate limit and 401 as the test server delivers them.
    await openPr(1, third.tabId);
    coreMock.fail("rate_limit");
    await refresh();
    await eventually(() => view.locator("[data-pr-stale]").getAttribute("data-pr-stale"), "rate_limit", "test server rate limit: notice above the content", 20_000);
    coreMock.recover();
    coreMock.fail("unauthorized");
    await refresh();
    await eventually(() => view.locator("[data-pr-stale]").getAttribute("data-pr-stale"), "auth", "test server 401: notice “token rejected”", 20_000);
    coreMock.recover();
    await refresh();
    await eventually(() => view.locator("[data-pr-stale]").count(), 0, "afterwards the view loads again", 20_000);
    await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), third.tabId);
    await app.invoke("tab_activate", { tabId });
    await app.settle();
    repo.cleanup();
  });

  // -------------------------------------------------------------------------------------------
  await section("States and screenshots: loading, light, 960×600; commands in the registry", async () => {
    const commands = await page.evaluate(() => window.__gcUi.commands().filter((command) => command.id.startsWith("pr.")).map((command) => command.id));
    equal(commands, ["pr.create", "pr.openCurrent", "pr.pick", "pr.refresh", "pr.openInBrowser", "pr.repoInBrowser"], "commands in the registry");
    const broken = await h.breakQuery("prGet", ["repo", repoId, "pr", 14], "not reachable");
    await setCenter({ kind: "pr", number: 14 });
    await eventually(() => view.locator("[data-pr-state]").getAttribute("data-pr-state"), "loading", "skeleton while the pull request loads");
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/pr-view-loading.png`);
    await broken.restore();
    await page.evaluate((id) => window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "pr", 14] }), repoId);
    await head.waitFor({ timeout: 20_000 });

    await app.setTheme("light");
    await shot("pr-view-blocked-light");
    await app.setSize(960, 600);
    equal(await escaping(page, VIEW), [], "960×600: nothing sticks out of the view");
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "960×600: the page does not scroll horizontally");
    check(await view.getByRole("button", { name: "Open in browser", exact: true }).isVisible(), "960×600: the header buttons stay reachable (icon only)");
    await shot("pr-view-min-light");
    await app.setTheme("dark");
    await openPr(12);
    await shot("pr-view-min");
    await app.setSize(1440, 900);
  });

  // -------------------------------------------------------------------------------------------
  await section("Disconnected: the view says so, the sidebar offers “Connect”; the token appears nowhere", async () => {
    for (const token of [github.token, github.secondToken, gitlab.token, coreMock.token]) {
      equal(await tokenLeaks(app, token), [], `UI and storage: ${token.slice(0, 8)}…`);
      check(!consoleLines.some((line) => line.includes(token)), `console: ${token.slice(0, 8)}…`);
    }
    // github.com without an account: the host is detected but not connected.
    await app.setSize(1440, 900);
    const lone = makeCleanRepoWithRemote({ name: "ohne-konto" });
    lone.git("remote", "set-url", "origin", "https://github.com/schule/ohne-konto.git");
    const fourth = await app.openRepo(lone.path);
    await panel.waitFor();
    check((await panel.innerText()).includes("Not connected to GitHub"), "sidebar: a row “Not connected to GitHub”");
    equal(await panel.getByRole("button", { name: "Connect" }).count(), 1, "with “Connect”");
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/pr-view-not-connected.png`);
    await panel.getByRole("button", { name: "Connect" }).click();
    const connect = page.locator('[data-screen="hosts-connect"]');
    await connect.waitFor();
    equal(await connect.getByRole("radio", { checked: true }).allInnerTexts(), ["GitHub", "github.com"], "“Connect” opens the dialog, GitHub is preselected");
    await page.keyboard.press("Escape");
    await setCenter({ kind: "pr", number: 3 }, fourth.tabId);
    await eventually(() => view.locator("[data-pr-state]").getAttribute("data-pr-state"), "error-not_connected", "the view: not connected");
    equal(await view.getByRole("button", { name: "Connect account …" }).count(), 1, "with “Connect account …”");
    // Without an account the core does not even ask the host: it refuses before anything goes to the network.
    equal(await app.invoke("pr_list", { repoId: fourth.repoId, state: "open" }).then(() => "ok", (error) => error.code), "host_not_connected", "the core reports host_not_connected");
    lone.cleanup();
  });
} catch (error) {
  check(false, `aborted: ${error?.stack ?? error}`);
  if (app) await app.screenshot("target/e2e/pr-view-error.png").catch(() => undefined);
} finally {
  if (app) {
    for (const account of await app.invoke("host_accounts").catch(() => [])) await app.invoke("host_disconnect", { accountId: account.id }).catch(() => undefined);
  }
}
if (process.platform === "win32") equal(keychainEntries(KEYRING), [], "at the end no entry from this run is left in the system keychain");
if (app) await app.close().catch(() => undefined);
await Promise.all([github.close(), gitlab.close(), coreMock.close()]).catch(() => undefined);
await finish("pr-view", checks, app, () => {
  gh.repo.cleanup();
  gl.repo.cleanup();
});
