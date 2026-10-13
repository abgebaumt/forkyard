/**
 * pr-create – Create pull request: in the real app, against a LOCAL host (host-lib.mjs) shaped like
 * GitHub and GitLab, and against the core's test server (scripts/e2e/host-mock.mjs).
 * Behind the test repository's remote is a real Git server on 127.0.0.1 – the "Push first" step
 * really pushes. Nothing calls real services.
 *
 *   node scripts/e2e/screens/pr-create.mjs                   everything (checks and screenshots)
 *   node scripts/e2e/screens/pr-create.mjs --only keyboard   only sections whose title contains the word
 *   node scripts/e2e/screens/pr-create.mjs --show            visible window
 *
 * Checks what arrives at the host (title, description, source, target, draft, reviewers,
 * labels), and in the repository on the server that the branch is there.
 */
import { launchApp } from "../driver.mjs";
import { startHostMock } from "../host-mock.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { finish, makeChecks } from "./files-lib.mjs";
import { SHOTS, TEMPLATE, connectDirect, escaping, focusedName, keychainEntries, keyringName, makeHostRepo, recordConsole, refreshHostQueries, runCommand, seedPrs, startHost, sweepKeychain, tabTo, tokenLeaks } from "./host-lib.mjs";
import { pageHelpers } from "./prefs-lib.mjs";

const show = process.argv.includes("--show");
const checks = makeChecks("pr-create");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

sweepKeychain();
const KEYRING = keyringName("s23");
const github = await startHost({ kind: "github" });
const gitlab = await startHost({ kind: "gitlab", owner: "landesnetz/schulen" });
const coreMock = await startHostMock();
const gh = makeHostRepo(github);
const gl = makeHostRepo(gitlab);
seedPrs(github, gh.sha);

/** For comparing objects: key order does not matter (the core sends them sorted). */
const sorted = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

const VIEW = '[data-screen="pr-create"]';
const PR_VIEW = '[data-screen="pr-view"]';

let app = null;
try {
  app = await launchApp({ show, env: { FORKYARD_KEYRING_SERVICE: KEYRING } });
  state.app = app;
  const { page } = app;
  const h = pageHelpers(app);
  const consoleLines = recordConsole(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const { repoId, tabId } = await app.openRepo(gh.repo.path);

  const view = page.locator(VIEW);
  const form = view.locator('form[data-pr-state="form"]');
  const steps = view.locator("[data-pr-steps]");
  const title = view.locator('input[name="title"]');
  const body = view.locator('textarea[name="body"]');
  const submit = view.locator('button[type="submit"]');
  const center = (tab = tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.center ?? null, tab);
  const setCenter = (value, tab = tabId) => page.evaluate(([id, next]) => window.__gc.store.getState().setCenter(id, next), [tab, value]);
  const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
  const stepTexts = () => steps.locator("li").evaluateAll((items) => items.map((item) => `${item.getAttribute("data-step-state")}: ${item.querySelector("p")?.textContent ?? ""}`));
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  /** Switches the checked-out branch from outside and waits until the app knows. */
  const checkout = async (repo, branch, id = repoId) => {
    repo.git("checkout", "-q", branch);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(async () => (await app.invoke("status_get", { repoId: id })).head.branch, branch, `“${branch}” is checked out`);
    await page.evaluate((key) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", key] }), id);
    await app.settle();
  };
  /** Back to the graph without a confirmation (for the start of a section). */
  const leave = async () => {
    for (let round = 0; round < 3 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) await page.keyboard.press("Escape");
    await setCenter({ kind: "graph" });
    const ask = page.getByRole("dialog", { name: "Discard pull request?" });
    if ((await ask.count()) > 0) await ask.getByRole("button", { name: "Discard", exact: true }).click();
    await eventually(async () => (await center())?.kind, "graph", "back in the graph");
    await h.closeToasts();
  };
  state.resetView = leave;

  // -------------------------------------------------------------------------------------------
  await section("Not connected: no host detected, menus blocked, connecting leads to the form", async () => {
    equal(await app.invoke("host_repo_info", { repoId }), null, "without an account the core does not detect the self-hosted instance");
    const menus = await page.evaluate(
      ([repo, tab]) => {
        const refs = window.__gc.queryClient.getQueryData(["repo", repo, "refs"]);
        const local = refs.locals.find((ref) => ref.name === "feature/export");
        const main = refs.locals.find((ref) => ref.name === "main");
        const flat = (entries) => entries.filter((entry) => entry.label).map((entry) => ({ label: entry.label, disabled: Boolean(entry.disabled), hint: entry.hint ?? null }));
        return { branch: flat(window.__gcUi.menus.branchMenu({ repoId: repo, tabId: tab, ref: local })), drop: flat(window.__gcUi.menus.dropMenu({ repoId: repo, tabId: tab, source: local, target: main })) };
      },
      [repoId, tabId],
    );
    equal(menus.branch.filter((entry) => /pull request/i.test(entry.label)), [], "branch menu: without a detected host no pull request entry");
    equal(menus.drop.find((entry) => /pull request/i.test(entry.label)), { label: "Create pull request …", disabled: true, hint: "needs a host connection" }, "drop menu: the entry is there, blocked, with a reason");
    equal(await page.locator('[data-extra-section="pull-requests"]').count(), 0, "sidebar: no “Pull requests” section");

    await setCenter({ kind: "pr_create" });
    await view.waitFor();
    await eventually(() => view.locator("[data-pr-state]").getAttribute("data-pr-state"), "no-host", "the view says: no host detected");
    check((await view.innerText()).includes("self-hosted instance"), "and points to self-hosted instances");
    await shot("pr-create-no-host");

    // Connecting from within the view: afterwards the form is there without reopening the view.
    await view.getByRole("button", { name: "Connect account …" }).click();
    const dialog = page.locator('[data-screen="hosts-connect"]');
    await dialog.waitFor();
    await dialog.getByRole("radio", { name: "Self-hosted" }).click();
    await dialog.locator('input[name="baseUrl"]').fill(github.base);
    await dialog.locator('input[name="token"]').fill(github.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await form.waitFor({ timeout: 30_000 });
    const info = await app.invoke("host_repo_info", { repoId });
    equal([info?.kind, info?.owner, info?.name, info?.defaultBranch, info?.account?.user?.login], ["github", "schule", "messnetz", "main", "lena-hartmann"], "now the core detects the repository at the host");
    await eventually(() => page.locator('[data-extra-section="pull-requests"]').count(), 1, "and the sidebar shows the “Pull requests” section");
  });

  // -------------------------------------------------------------------------------------------
  await section("Prefill: title from the only commit, template, target = default branch, “Push first”, preview", async () => {
    await checkout(gh.repo, "thema/neue-auswertung");
    await runCommand(app, "Create pull request", "pr.create");
    await form.waitFor();
    await eventually(() => title.inputValue(), "Auswertung als eigenes Dokument", "title = first line of the only commit");
    await eventually(() => focusedName(page), "Title", "focus is in the title");
    await eventually(() => body.inputValue(), TEMPLATE, "description = template from the repository");
    check((await view.innerText()).includes("Prefilled with the repository’s template"), "and says so");
    const selects = await view.locator('[role="combobox"]').allInnerTexts();
    equal(selects.map((text) => text.trim()), ["thema/neue-auswertung", "main (default)"], "source = checked-out branch, target = default branch");
    equal(await stepTexts(), ["todo: Push first"], "step: push first");
    equal((await submit.innerText()).trim(), "Push and create", "the button says it does both");
    check((await view.locator("footer").innerText()).includes("on behalf of lena-hartmann"), "the footer names the account");
    await shot("pr-create");

    // Preview: sanitized Markdown, no text field.
    await view.getByRole("radio", { name: "Preview" }).click();
    const preview = view.locator("[data-pr-preview]");
    await preview.waitFor();
    equal(await preview.locator("h2").allInnerTexts(), ["Was ändert sich?", "Wie getestet?"], "the preview renders the headings");
    equal(await preview.locator("[data-readme-task]").count(), 1, "and the task list");
    await shot("pr-create-preview");
    await view.getByRole("radio", { name: "Write" }).click();
    await body.waitFor();
    equal(await body.inputValue(), TEMPLATE, "back in write mode the text is unchanged");
  });

  // -------------------------------------------------------------------------------------------
  await section("Keyboard only: fill in, push and create – the host gets exactly that, then pr-view", async () => {
    await runCommand(app, "Create pull request", "pr.create");
    await form.waitFor();
    await eventually(() => title.inputValue(), "Auswertung als eigenes Dokument", "title prefilled");
    const before = github.requests.length;
    equal(github.serverGit("branch", "--list", "thema/neue-auswertung"), "", "starting point: the branch is not on the server yet");

    await eventually(() => focusedName(page), "Title", "focus in the title");
    await page.keyboard.press("End");
    await page.keyboard.type(" (Monatsmittel)");
    await tabTo(page, "Description (Markdown)");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Monatsmittel je Station – mit Umlauten: äöüß.");
    await tabTo(page, /^Create as draft/);
    await page.keyboard.press("Space");
    await tabTo(page, "Reviewers (optional)");
    await page.keyboard.type("@jonas, aylin");
    await tabTo(page, "Labels (optional)");
    await page.keyboard.type("daten, auswertung");
    equal((await submit.innerText()).trim(), "Push and create", "button: Push and create");
    await page.keyboard.press("Control+Enter");

    await page.locator(PR_VIEW).waitFor({ timeout: 60_000 });
    const created = github.sent("POST", /\/pulls$/, before);
    equal(created.length, 1, "exactly one pull request was created");
    equal(sorted(created[0]?.body), sorted({ title: "Auswertung als eigenes Dokument (Monatsmittel)", body: "Monatsmittel je Station – mit Umlauten: äöüß.", head: "thema/neue-auswertung", base: "main", draft: true }), "content at the host: title, description, source, target, draft");
    equal(github.sent("POST", /\/requested_reviewers$/, before).map((entry) => entry.body), [{ reviewers: ["jonas", "aylin"] }], "reviewers (without @)");
    equal(github.sent("POST", /\/issues\/\d+\/labels$/, before).map((entry) => entry.body), [{ labels: ["daten", "auswertung"] }], "labels");
    equal(github.serverGit("rev-parse", "refs/heads/thema/neue-auswertung"), gh.sha.auswertung, "the branch is now on the server – on the local commit");
    equal(gh.repo.git("rev-parse", "--abbrev-ref", "thema/neue-auswertung@{upstream}"), "origin/thema/neue-auswertung", "and has its upstream locally");
    const number = created.length ? github.state.prs[0].number : null;
    equal(await center(), { kind: "pr", number }, "afterwards the center shows the new pull request (pr-view)");
    await eventually(async () => (await page.locator(`${PR_VIEW} [data-pr-title]`).innerText()).includes("Auswertung als eigenes Dokument (Monatsmittel)"), true, "with its title");
    equal(await page.locator(`${PR_VIEW} [data-pr-phase]`).getAttribute("data-pr-phase"), "draft", "as a draft");
    check((await toasts()).some((toast) => toast.tone === "success" && toast.text.includes(`Pull request #${number} created`)), "success message");
    equal(await page.getByRole("dialog").count(), 0, "no “discard?” confirmation when switching to pr-view");
    await shot("pr-create-created");
  });

  // -------------------------------------------------------------------------------------------
  await section("One already exists: the hint leads there – in the form, via the command, in the branch menu", async () => {
    await refreshHostQueries(app);
    await setCenter({ kind: "pr_create", source: "feature/export" });
    await form.waitFor();
    await until(async () => (await stepTexts()).some((text) => text.startsWith("problem: There is already pull request #12 for “feature/export”")), "step: there is already #12 for the branch");
    check(await submit.isDisabled(), "creating is blocked");
    check((await view.locator("[data-pr-blocked]").innerText()).includes("There is already pull request #12"), "with the reason in the footer");
    await shot("pr-create-existing");
    await steps.getByRole("button", { name: "Open pull request #12" }).click();
    await eventually(center, { kind: "pr", number: 12 }, "the button opens pull request #12");
    await leave();

    // Same path via the command: if the checked-out branch already has a pull request, it goes straight there.
    await checkout(gh.repo, "feature/export");
    await runCommand(app, "Create pull request", "pr.create");
    await eventually(center, { kind: "pr", number: 12 }, "“Create pull request” on feature/export leads to #12");
    check((await toasts()).some((toast) => toast.text.includes("Pull request #12 already exists")), "with a hint why");
    const labels = await page.evaluate(
      ([repo, tab]) => {
        const refs = window.__gc.queryClient.getQueryData(["repo", repo, "refs"]);
        const names = (name) => window.__gcUi.menus.branchMenu({ repoId: repo, tabId: tab, ref: refs.locals.find((ref) => ref.name === name) }).filter((entry) => /pull request/i.test(entry.label ?? "")).map((entry) => `${entry.label}${entry.disabled ? ` [${entry.hint}]` : ""}`);
        return { export: names("feature/export"), zwei: names("thema/zwei-schritte"), main: names("main") };
      },
      [repoId, tabId],
    );
    equal(labels, { export: ["Open pull request #12"], zwei: ["Create pull request …"], main: ["Create pull request … [this is the default branch]"] }, "branch menu: open, create, blocked on the default branch");
  });

  // -------------------------------------------------------------------------------------------
  await section("Several commits: title from the branch name; same branches and nothing to compare are blocked", async () => {
    await setCenter({ kind: "pr_create", source: "thema/zwei-schritte" });
    await form.waitFor();
    await eventually(() => title.inputValue(), "Zwei schritte", "two commits: the title comes from the branch name");
    // Change the source: open the select with the keyboard, choose “main”.
    await view.locator('[role="combobox"]').first().focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "main", exact: true }).click();
    await until(async () => (await stepTexts()).some((text) => text.startsWith("problem: Source and target are the same branch")), "source = target is reported");
    check(await submit.isDisabled(), "and blocks creating");
    await eventually(() => title.inputValue(), "Main", "the suggested title follows the source as long as nobody has typed");
    await shot("pr-create-same-branch");
  });

  // -------------------------------------------------------------------------------------------
  await section("Errors from the host: rate limit, no permission, rejected, token expired – the form stays", async () => {
    await setCenter({ kind: "pr_create", source: "thema/zwei-schritte" });
    await form.waitFor();
    await eventually(() => title.inputValue(), "Zwei schritte", "title prefilled");
    await title.fill("Zwei Schritte zur Auswertung");
    await body.fill("Text, der nicht verloren gehen darf.");
    const failure = view.locator("[data-pr-error]");
    const kept = async (what) => equal([await title.inputValue(), await body.inputValue()], ["Zwei Schritte zur Auswertung", "Text, der nicht verloren gehen darf."], `${what}: title and description are still there`);

    // Rate limit: the push happens first (that works), then the host refuses.
    github.set({ rateLimited: true });
    await submit.click();
    await failure.waitFor({ timeout: 60_000 });
    equal(await failure.getAttribute("data-pr-error"), "rate_limit", "rate limit: its own error in the form");
    check(/rate limit/i.test(await failure.innerText()) && /\d{1,2}:\d{2}\s?[AP]M/.test(await failure.innerText()), `with the time in local time (${(await failure.innerText()).replace(/\s+/g, " ")})`);
    equal((await view.locator('[role="combobox"]').allInnerTexts()).map((text) => text.trim()), ["thema/zwei-schritte", "main (default)"], "the target stays the default branch even while the host is not answering");
    await kept("Rate limit");
    equal(await center(), { kind: "pr_create", source: "thema/zwei-schritte" }, "the view stays open");
    equal(github.serverGit("rev-parse", "refs/heads/thema/zwei-schritte"), gh.repo.git("rev-parse", "thema/zwei-schritte"), "the push before it went through");
    await until(async () => (await stepTexts()).includes("done: The branch is on the remote"), "the “Push first” step is done");
    equal((await submit.innerText()).trim(), "Create pull request", "the button no longer pushes");
    await shot("pr-create-rate-limit");
    github.set({ rateLimited: false });

    // No permission (403 on write).
    github.set({ readOnly: true });
    await submit.click();
    await until(async () => (await failure.getAttribute("data-pr-error")) === "permission", "no permission: its own error");
    check((await failure.innerText()).includes("No permission"), "as the heading");
    await kept("No permission");
    github.set({ readOnly: false });

    // Content the host would reject: an empty title never gets there.
    await title.fill("   ");
    await submit.click();
    await until(async () => (await view.getByRole("alert").allInnerTexts()).join(" ").includes("Enter a title"), "empty title: error at the field");
    await title.fill("Zwei Schritte zur Auswertung");

    // The token expires mid-session.
    github.revoke(github.token);
    await submit.click();
    await until(async () => (await failure.getAttribute("data-pr-error")) === "auth", "expired token: its own error", 20_000);
    check((await failure.innerText()).includes("rejects the token"), `says that the host rejects the token (${(await failure.innerText()).replace(/\s+/g, " ")})`);
    equal(await failure.getByRole("button", { name: "Open integrations" }).count(), 1, "with the way to the integrations");
    await kept("Expired token");
    await eventually(async () => Boolean((await app.invoke("host_accounts"))[0]?.lastError), true, "the core remembers the error on the account");
    await shot("pr-create-auth");

    // New token, same attempt: now it works – with the text from before.
    await connectDirect(app, github, github.secondToken);
    const before = github.requests.length;
    await submit.click();
    await page.locator(PR_VIEW).waitFor({ timeout: 30_000 });
    equal(sorted(github.sent("POST", /\/pulls$/, before)[0]?.body), sorted({ title: "Zwei Schritte zur Auswertung", body: "Text, der nicht verloren gehen darf.", head: "thema/zwei-schritte", base: "main", draft: false }), "after replacing the token the pull request arrives with the unchanged text");
  });

  // -------------------------------------------------------------------------------------------
  await section("Leaving with unsent text asks first; Esc closes; drop menu prefills source and target", async () => {
    await checkout(gh.repo, "main");
    gh.repo.git("checkout", "-q", "-b", "thema/entwurf", "main");
    gh.repo.write("docs/entwurf.md", "# Entwurf\n");
    gh.repo.git("add", "-A");
    gh.repo.git("commit", "-q", "-m", "Entwurf angelegt");
    await checkout(gh.repo, "thema/entwurf");

    // Drop menu: with an account the entry is active and opens pr-create with both branches.
    const entry = await page.evaluate(
      ([repo, tab]) => {
        const refs = window.__gc.queryClient.getQueryData(["repo", repo, "refs"]);
        const source = refs.locals.find((ref) => ref.name === "thema/entwurf");
        const target = refs.remotes.find((ref) => ref.name === "origin/feature/export");
        const entries = window.__gcUi.menus.dropMenu({ repoId: repo, tabId: tab, source, target });
        const item = entries.find((candidate) => /pull request/i.test(candidate.label ?? ""));
        if (!item.disabled) item.onSelect();
        return { label: item.label, disabled: Boolean(item.disabled), tooltip: item.tooltip };
      },
      [repoId, tabId],
    );
    equal([entry.label, entry.disabled], ["Create pull request …", false], "drop menu: with a connected account the entry is active");
    check(entry.tooltip.includes("“thema/entwurf”") && entry.tooltip.includes("“feature/export”"), "the tooltip names both branches");
    await form.waitFor();
    await eventually(center, { kind: "pr_create", source: "thema/entwurf", target: "feature/export" }, "pr-create opens with source and target from the menu");
    await eventually(async () => (await view.locator('[role="combobox"]').allInnerTexts()).map((text) => text.trim()), ["thema/entwurf", "feature/export"], "both are in the form");

    // Without input Esc closes right away (from the close button – in text fields Esc belongs to the field).
    // Against feature/export there are two commits: the title comes from the branch name.
    await eventually(() => title.inputValue(), "Entwurf", "title prefilled");
    await view.locator("[data-back]").focus();
    await page.keyboard.press("Escape");
    await eventually(async () => (await center())?.kind, "graph", "Esc closes the view");

    // With input the app asks first.
    await setCenter({ kind: "pr_create", source: "thema/entwurf" });
    await form.waitFor();
    await title.fill("Mein eigener Titel");
    await view.locator("[data-back]").focus();
    await page.keyboard.press("Escape");
    const ask = page.getByRole("dialog", { name: "Discard pull request?" });
    await ask.waitFor();
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "confirmation, focus on “Cancel”");
    await shot("pr-create-leave");
    await page.keyboard.press("Enter");
    await eventually(() => ask.count(), 0, "Cancel only closes the confirmation");
    equal([(await center())?.kind, await title.inputValue()], ["pr_create", "Mein eigener Titel"], "the view and the text stay");
    await view.getByRole("button", { name: "Cancel", exact: true }).click();
    await ask.getByRole("button", { name: "Discard", exact: true }).click();
    await eventually(async () => (await center())?.kind, "graph", "“Discard” closes the view");
  });

  // -------------------------------------------------------------------------------------------
  await section("GitLab shape: merge request from the same view – content checked at the host", async () => {
    const second = await app.openRepo(gl.repo.path);
    await connectDirect(app, gitlab);
    equal((await app.invoke("host_repo_info", { repoId: second.repoId }))?.kind, "gitlab", "the core detects GitLab (group with subgroup)");
    await checkout(gl.repo, "thema/neue-auswertung", second.repoId);
    await setCenter({ kind: "pr_create" }, second.tabId);
    await form.waitFor();
    await eventually(() => title.inputValue(), "Auswertung als eigenes Dokument", "title from the commit");
    await eventually(() => body.inputValue(), TEMPLATE, "template from .gitlab/merge_request_templates");
    check((await view.locator("footer").innerText()).includes("merge request on GitLab"), "the footer uses the host's name for it");
    check((await view.locator("header").innerText()).includes("landesnetz/schulen/messnetz"), "project with group and subgroup");
    await view.getByRole("checkbox", { name: /Create as draft/ }).click();
    await view.locator('input[name="reviewers"]').fill("jonas");
    await view.locator('input[name="labels"]').fill("daten, auswertung");
    const before = gitlab.requests.length;
    await submit.click();
    await page.locator(PR_VIEW).waitFor({ timeout: 60_000 });
    const sent = gitlab.sent("POST", /\/merge_requests$/, before)[0];
    equal(sorted(sent?.body), sorted({ source_branch: "thema/neue-auswertung", target_branch: "main", title: "Draft: Auswertung als eigenes Dokument", description: TEMPLATE, labels: "daten,auswertung", reviewer_ids: [102] }), "content at GitLab: branches, draft in the title, description, labels, reviewers as IDs");
    check(sent?.path === "/api/v4/projects/landesnetz/schulen/messnetz/merge_requests", `via the project's API v4 (${sent?.path})`);
    equal(gitlab.serverGit("rev-parse", "refs/heads/thema/neue-auswertung"), gl.sha.auswertung, "here too it pushed first");
    equal(await page.locator(`${PR_VIEW} [data-pr-phase]`).getAttribute("data-pr-phase"), "draft", "pr-view shows the new merge request as a draft");
    await shot("pr-create-gitlab-created");
    await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), second.tabId);
    await app.invoke("tab_activate", { tabId });
    await app.settle();
  });

  // -------------------------------------------------------------------------------------------
  await section("Against the core's test server (host-mock.mjs): create, duplicate, fork hint", async () => {
    const repo = makeCleanRepoWithRemote({ name: "demo" });
    repo.git("remote", "add", "hoster", coreMock.remoteUrl("github"));
    // "schon-da": one commit, pushed to origin – the test server rejects this branch as a duplicate.
    repo.git("checkout", "-q", "-b", "schon-da", "main");
    repo.write("docs/schon-da.md", "# Schon da\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Schon da");
    repo.git("push", "-q", "-u", "origin", "schon-da");
    await app.invoke("host_connect", { kind: "github", baseUrl: coreMock.url, token: coreMock.token });
    const third = await app.openRepo(repo.path);
    await refreshHostQueries(app);
    const info = await app.invoke("host_repo_info", { repoId: third.repoId });
    equal([info?.remote, info?.owner, info?.name, info?.forkParent?.owner], ["hoster", "octo", "demo", "ursprung"], "the core detects octo/demo at the remote “hoster” (a fork of ursprung/demo)");

    await setCenter({ kind: "pr_create", source: "feature/export" }, third.tabId);
    await form.waitFor();
    check((await view.locator("[data-pr-fork]").innerText()).includes("fork of ursprung/demo"), "fork: hint how a pull request goes to the original");
    await eventually(() => title.inputValue(), "CSV-Export für den Vergleich", "title from the only commit");
    await title.fill("Export als CSV");
    const before = coreMock.requests.length;
    await submit.click();
    await page.locator(PR_VIEW).waitFor({ timeout: 30_000 });
    const posted = coreMock.requests.slice(before).find((entry) => entry.method === "POST" && entry.path.endsWith("/pulls"));
    equal(sorted(posted?.body), sorted({ title: "Export als CSV", body: "", head: "feature/export", base: "main", draft: false }), "the core's test server receives the pull request");
    equal(coreMock.state.created.map((entry) => [entry.title, entry.source, entry.target]), [["Export als CSV", "feature/export", "main"]], "and keeps it in its records");
    check(posted?.headers.authorization === `Bearer ${coreMock.token}`, "with the token in the Authorization header");

    // The branch "schon-da" is rejected there as a duplicate: the app says so at the form.
    await setCenter({ kind: "pr_create", source: "schon-da" }, third.tabId);
    await form.waitFor();
    await title.fill("Noch einmal");
    await submit.click();
    const failure = view.locator("[data-pr-error]");
    await failure.waitFor({ timeout: 30_000 });
    check((await failure.innerText()).includes("already an open pull request"), `duplicate: understandable rejection (${(await failure.innerText()).replace(/\s+/g, " ")})`);
    equal(await title.inputValue(), "Noch einmal", "the title stays");
    await page.evaluate((id) => window.__gc.store.getState().setCenter(id, { kind: "graph" }), third.tabId);
    const ask = page.getByRole("dialog", { name: "Discard pull request?" });
    if ((await ask.count()) > 0) await ask.getByRole("button", { name: "Discard", exact: true }).click();
    await app.invoke("tab_activate", { tabId });
    await app.settle();
    repo.cleanup();
  });

  // -------------------------------------------------------------------------------------------
  await section("Screenshots and states: loading, light, 960×600, very long names", async () => {
    const long = "thema/ein-sehr-langer-branch-name-der-in-keine-zeile-passt-und-trotzdem-lesbar-bleiben-soll-2026";
    gh.repo.git("checkout", "-q", "-b", long, "main");
    gh.repo.write("docs/lang.md", "# Lang\n");
    gh.repo.git("add", "-A");
    gh.repo.git("commit", "-q", "-m", "Ein Commit mit einer sehr langen ersten Zeile, die zeigt, dass der Titel eines Pull Requests auch dann vollständig im Feld steht, wenn er über die Breite der Ansicht hinausgeht");
    await checkout(gh.repo, long);

    // Loading: the repository's host is not determined yet.
    const broken = await h.breakQuery("hostRepoInfo", ["repo", repoId, "hostRepo"], "The host could not be determined.");
    await setCenter({ kind: "pr_create" });
    await view.waitFor();
    equal(await view.getByRole("status", { name: "Detecting host" }).count(), 1, "skeleton while the host is being determined");
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/pr-create-loading.png`);
    await broken.fail();
    await eventually(() => view.locator("[data-pr-state]").getAttribute("data-pr-state"), "error-other", "error while determining: its own state");
    await shot("pr-create-error");
    await broken.restoreAndPress(VIEW, "Try again");
    await form.waitFor();

    await eventually(async () => (await title.inputValue()).startsWith("Ein Commit mit einer sehr langen ersten Zeile"), true, "long title is complete in the field");
    equal(await escaping(page, VIEW), [], "1440×900: nothing sticks out of the view");
    await shot("pr-create-long");
    await app.setTheme("light");
    await shot("pr-create-long-light");
    await app.setSize(960, 600);
    equal(await escaping(page, VIEW), [], "960×600: nothing sticks out of the view");
    equal(await form.locator("> div").first().evaluate((scroller) => scroller.scrollWidth - scroller.clientWidth), 0, "960×600: the form does not scroll horizontally (long branch names are truncated)");
    check(await submit.isVisible(), "960×600: the create button stays visible (the footer is fixed)");
    await shot("pr-create-min-light");
    await app.setTheme("dark");
    await shot("pr-create-min");
    await app.setSize(1440, 900);
  });

  // -------------------------------------------------------------------------------------------
  await section("The token appears nowhere", async () => {
    await leave();
    for (const token of [github.token, github.secondToken, gitlab.token, coreMock.token]) {
      equal(await tokenLeaks(app, token), [], `UI and storage: ${token.slice(0, 8)}…`);
      check(!consoleLines.some((line) => line.includes(token)), `console: ${token.slice(0, 8)}…`);
    }
  });
} catch (error) {
  check(false, `aborted: ${error?.stack ?? error}`);
  if (app) await app.screenshot("target/e2e/pr-create-error.png").catch(() => undefined);
} finally {
  if (app) {
    for (const account of await app.invoke("host_accounts").catch(() => [])) await app.invoke("host_disconnect", { accountId: account.id }).catch(() => undefined);
  }
}
if (process.platform === "win32") equal(keychainEntries(KEYRING), [], "at the end no entry from this run is left in the system keychain");
if (app) await app.close().catch(() => undefined);
await Promise.all([github.close(), gitlab.close(), coreMock.close()]).catch(() => undefined);
await finish("pr-create", checks, app, () => {
  gh.repo.cleanup();
  gl.repo.cleanup();
});
