/**
 * F20 – Create pull request: edge cases not covered by other scripts.
 * Real app against a LOCAL host (scripts/e2e/screens/host-lib.mjs, shaped like GitHub) with a real
 * Git server on 127.0.0.1 behind it. There are no calls to real services.
 *
 *   node scripts/e2e/flows/D-F20.mjs                    everything
 *   node scripts/e2e/flows/D-F20.mjs --only F20-E3      only sections whose ID or title contains this (comma separates several)
 *   node scripts/e2e/flows/D-F20.mjs --show             visible window
 *
 * Checks what arrives at the host, and in the repository on the server that the branch is there.
 * At the end comes the list of green and red sections. A red section with "BUG D-xx" is the test the
 * reported bug is fixed against.
 */
import { connectDirect, keychainEntries, keyringName, makeHostRepo, runCommand, startHost, sweepKeychain, tokenLeaks } from "../screens/host-lib.mjs";
import { createFlow, gitAsync, sleep } from "./D-lib.mjs";

const t = createFlow("D-F20");
const { check, equal, eventually } = t;

sweepKeychain();
const KEYRING = keyringName("dflow20");
const github = await startHost({ kind: "github" });
const gh = makeHostRepo(github);
t.made(gh.repo);

const VIEW = '[data-screen="pr-create"]';
const PR_VIEW = '[data-screen="pr-view"]';
const sorted = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

await t.launch({ env: { FORKYARD_KEYRING_SERVICE: KEYRING } });
const page = t.page;
const repo = await t.open(gh.repo);
await connectDirect(t.app, github);
const { repoId, tabId } = repo;

const view = page.locator(VIEW);
const form = view.locator('form[data-pr-state="form"]');
const title = view.locator('input[name="title"]');
const body = view.locator('textarea[name="body"]');
const submit = view.locator('button[type="submit"]');
const failure = view.locator("[data-pr-error]");
const center = () => page.evaluate((id) => window.__gc.store.getState().views[id]?.center ?? null, tabId);
const setCenter = (value) => page.evaluate(([id, next]) => window.__gc.store.getState().setCenter(id, next), [tabId, value]);
const posted = (from) => github.sent("POST", /\/pulls$/, from);
/** New local branch with one commit off main; the app learns about it as after a switch in the terminal. */
const newBranch = async (name, message, { checkout = true } = {}) => {
  gh.repo.git("checkout", "-q", "-b", name, "main");
  gh.repo.write(`docs/${name.replace(/[^a-z0-9]+/gi, "-")}.md`, `# ${message}\n`);
  gh.repo.git("add", "-A");
  gh.repo.git("commit", "-q", "-m", message);
  const sha = gh.repo.git("rev-parse", "HEAD");
  if (!checkout) gh.repo.git("checkout", "-q", "main");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await eventually(async () => (await t.app.invoke("status_get", { repoId })).head.branch, checkout ? name : "main", `"${checkout ? name : "main"}" is checked out`);
  await page.evaluate((key) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", key] }), repoId);
  await t.refresh(repoId);
  return sha;
};
/** Back to the graph, without confirmation. */
const leave = async () => {
  for (let round = 0; round < 3 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) await page.keyboard.press("Escape");
  await setCenter({ kind: "graph" });
  const ask = page.getByRole("dialog", { name: "Discard pull request?" });
  if ((await ask.count()) > 0) await ask.getByRole("button", { name: "Discard", exact: true }).click();
  await eventually(async () => (await center())?.kind, "graph", "back in the graph");
  await t.closeToasts();
};
const openForm = async (source) => {
  await setCenter({ kind: "pr_create", source });
  await form.waitFor({ timeout: 30_000 });
};

// ---------------------------------------------------------------------------------------------
await t.section("F20-H1", "Happy path with the mouse: branch menu in the left panel → form → \"Push and create\" → pull request view", async () => {
  const sha = await newBranch("thema/maus-weg", "Mit der Maus angelegt");
  const info = await t.app.invoke("host_repo_info", { repoId });
  equal([info?.kind, info?.owner, info?.name, info?.defaultBranch], ["github", "schule", "messnetz", "main"], "precondition: the core recognises the repository at the (local) host");
  equal(github.serverGit("branch", "--list", "thema/maus-weg"), "", "precondition: the branch is not on the server yet");
  await t.branchMenu("thema/maus-weg");
  const item = (await t.menuItems()).find((entry) => entry.text.startsWith("Create pull request"));
  check(Boolean(item) && !item.disabled && /to main/.test(item.text), `the branch menu offers "Create pull request … to main" (${JSON.stringify(item)})`);
  await t.pick(/^Create pull request/);
  await form.waitFor({ timeout: 30_000 });
  await eventually(() => title.inputValue(), "Mit der Maus angelegt", "title = first line of the only commit");
  equal((await view.locator('[role="combobox"]').allInnerTexts()).map((text) => text.trim()), ["thema/maus-weg", "main (default)"], "source and target are prefilled");
  equal((await submit.innerText()).trim(), "Push and create", "the button says it pushes first");
  await body.fill("Beschreibung aus dem Maus-Durchlauf.");
  const before = github.requests.length;
  await submit.click();
  await page.locator(PR_VIEW).waitFor({ timeout: 60_000 });
  const created = posted(before);
  equal(created.length, 1, "exactly one pull request was created");
  equal(sorted(created[0]?.body), sorted({ title: "Mit der Maus angelegt", body: "Beschreibung aus dem Maus-Durchlauf.", head: "thema/maus-weg", base: "main", draft: false }), "content at the host: title, description, source, target");
  equal(github.serverGit("rev-parse", "refs/heads/thema/maus-weg"), sha, "git (server): the branch is there now, on the local commit");
  equal(gh.repo.git("rev-parse", "--abbrev-ref", "thema/maus-weg@{upstream}"), "origin/thema/maus-weg", "git: the branch has its upstream");
  const number = github.state.prs.find((pr) => pr.source === "thema/maus-weg")?.number ?? null;
  equal(await center(), { kind: "pr", number }, "afterwards the center shows the new pull request");
  await eventually(async () => (await page.locator(`${PR_VIEW} [data-pr-title]`).innerText()).includes("Mit der Maus angelegt"), true, "with its title");
  check((await t.toasts()).some((toast) => toast.tone === "success" && toast.text.includes(`Pull request #${number} created`)), "success toast");
  // Dates in the view: relative, with the exact local time in the tooltip.
  const times = await page.locator(`${PR_VIEW} time[datetime]`).evaluateAll((list) => list.map((item) => ({ datetime: item.getAttribute("datetime"), title: item.getAttribute("title"), text: item.textContent })));
  const enDateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
  check(times.length > 0 && times.every((entry) => entry.title === enDateTime.format(new Date(entry.datetime))), `times: tooltip = local time of the moment (${JSON.stringify(times.slice(0, 3))})`);
  await leave();
  // The branch menu now leads to the existing pull request.
  await t.refresh(repoId);
  await eventually(
    async () => {
      await t.branchMenu("thema/maus-weg");
      const texts = (await t.menuItems()).map((entry) => entry.text);
      await t.closeMenu();
      return texts.some((text) => text.startsWith(`Open pull request #${number}`));
    },
    true,
    "the branch menu then offers \"Open pull request #n\"",
    30_000,
  );
});

// ---------------------------------------------------------------------------------------------
const LONG_TITLE = `Größen & Maße 🚀 – ${"Auswertung für Ämter, Öfen, Übergänge äöüß „Zitat“ 测试 ".repeat(10)}Ende`;
let titleLimit = null;
await t.section("F20-E2", "500 characters, emoji and umlauts in title, description, labels: the host receives exactly what the form shows", async () => {
  check([...LONG_TITLE].length >= 500, `the title has at least 500 characters (${[...LONG_TITLE].length})`);
  await newBranch("thema/langer-titel", "Kurzer Commit");
  await openForm("thema/langer-titel");
  await eventually(() => title.inputValue(), "Kurzer Commit", "title prefilled");
  // An emoji exactly on the field's length limit must not be split in half.
  const max = Number(await title.getAttribute("maxlength")) || 0;
  if (max > 0) {
    await title.fill(`${"a".repeat(max - 1)}🚀b`);
    const cut = await title.inputValue();
    check(!/[\uD800-\uDBFF]$/.test(cut), `an emoji on the limit of ${max} characters is not split (end: ${JSON.stringify(cut.slice(-3))})`);
  }
  await title.fill(LONG_TITLE);
  const shownTitle = await title.inputValue();
  const hints = `${(await view.getByRole("alert").allInnerTexts()).join(" ")} ${(await view.getByRole("status").allInnerTexts()).join(" ")} ${await title.evaluate((input) => (input.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "))}`.replace(/\s+/g, " ").trim();
  titleLimit = { max, typed: LONG_TITLE.length, shown: shownTitle.length, hints };
  const text = "Zeile mit Emoji 🎉 und Umlauten äöüß.\n\n- [ ] Aufgabe mit „Anführung“\n\n<b>kein HTML</b> & Co.";
  await body.fill(text);
  await view.locator('input[name="labels"]').fill("größen, 🚀 start");
  equal(await t.overflow().then((value) => value.x), 0, "500 characters in the title: no horizontal overflow");
  equal(await form.locator("> div").first().evaluate((scroller) => scroller.scrollWidth - scroller.clientWidth), 0, "the form does not scroll horizontally");
  const before = github.requests.length;
  await submit.click();
  const outcome = await Promise.race([page.locator(PR_VIEW).waitFor({ timeout: 60_000 }).then(() => "created"), view.getByRole("alert").first().waitFor({ timeout: 60_000 }).then(() => "alert")]).catch(() => "nothing");
  if (outcome === "created") {
    const sent = posted(before)[0];
    equal(sent?.body?.title, shownTitle.trim(), "title at the host: exactly the text from the field (trimmed), with emoji and umlauts");
    check(LONG_TITLE.startsWith(shownTitle) && shownTitle.length >= 250, `the field keeps the start of the pasted title (${shownTitle.length} of ${LONG_TITLE.length} characters)`);
    equal(sent?.body?.body, text, "description at the host: character-exact");
    equal(github.sent("POST", /\/issues\/\d+\/labels$/, before).map((entry) => entry.body), [{ labels: ["größen", "🚀 start"] }], "labels with umlaut, emoji and spaces");
    await eventually(async () => (await page.locator(`${PR_VIEW} [data-pr-title]`).innerText()).includes("Größen & Maße 🚀"), true, "the view shows the title");
    equal(await t.overflow().then((value) => value.x), 0, "the view with a 500-character title does not overflow");
    equal(await page.locator(PR_VIEW).evaluate((element) => element.scrollWidth - element.clientWidth), 0, "nor does the view itself");
  } else {
    const alerts = (await view.getByRole("alert").allInnerTexts()).join(" ");
    check(/title|character|long/i.test(alerts), `not created – then with the reason at the field (${outcome}: ${alerts})`);
    equal(posted(before).length, 0, "and nothing went to the host");
  }
  await leave();
});

// BUG D-08: A pasted title above the field's length limit is silently cut off – no counter, no hint;
// the pull request is created with the shortened title.
await t.section(
  "F20-E2b",
  "Title above the length limit: the form says it was shortened (counter or hint)",
  async () => {
    check(titleLimit !== null, "section F20-E2 got as far as the title");
    if (!titleLimit) return;
    console.log(`    (field limit: ${titleLimit.max}; pasted ${titleLimit.typed}, in the field ${titleLimit.shown} characters; hints: "${titleLimit.hints}")`);
    if (titleLimit.shown < titleLimit.typed) {
      await newBranch("thema/titel-grenze", "Kurzer Commit");
      await openForm("thema/titel-grenze");
      await title.fill(LONG_TITLE);
      const hints = `${(await view.getByRole("alert").allInnerTexts()).join(" ")} ${(await view.getByRole("status").allInnerTexts()).join(" ")} ${await title.evaluate((input) => `${(input.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")} ${input.closest("label, [data-field], div")?.textContent ?? ""}`)}`.replace(/\s+/g, " ");
      const told = /\d+\s*\/\s*\d+|characters?|truncated|cut off|too long|at most/i.test(hints);
      if (!told) await t.bugShot("D-08");
      check(told, `pasted ${titleLimit.typed} characters, the field holds ${titleLimit.shown} – without counter or hint (the field shows: "${hints.trim().slice(0, 160)}")`);
      await leave();
    }
  },
  { bug: "D-08" },
);

// ---------------------------------------------------------------------------------------------
await t.section("F20-E3", "Double-click and double Ctrl+Enter on \"Create\" (slow host): exactly one pull request", async () => {
  for (const how of ["double-click", "double Ctrl+Enter"]) {
    const name = how === "double-click" ? "thema/doppelt-klick" : "thema/doppelt-enter";
    await newBranch(name, `Doppelt: ${how}`);
    await openForm(name);
    await eventually(() => title.inputValue(), `Doppelt: ${how}`, `${how}: title prefilled`);
    github.set({ delayMs: 900 });
    const before = github.requests.length;
    try {
      if (how === "double-click") await submit.dblclick();
      else {
        await title.focus();
        await page.keyboard.press("Control+Enter");
        await page.keyboard.press("Control+Enter");
      }
      await page.locator(PR_VIEW).waitFor({ timeout: 90_000 });
      await sleep(2500);
    } finally {
      github.set({ delayMs: 0 });
    }
    equal(posted(before).length, 1, `${how}: exactly one create call at the host`);
    equal(github.state.prs.filter((pr) => pr.source === name).length, 1, `${how}: exactly one pull request for the branch`);
    equal(await t.dangerToasts(), [], `${how}: no error toast from the second trigger`);
    await leave();
  }
});

// ---------------------------------------------------------------------------------------------
await t.section("F20-E4", "Slow network: the button shows it is busy and cannot be triggered again; afterwards the pull request exists", async () => {
  await newBranch("thema/langsam", "Langsamer Hoster");
  await openForm("thema/langsam");
  await eventually(() => title.inputValue(), "Langsamer Hoster", "title prefilled");
  await body.fill("Text bleibt während des Wartens stehen.");
  github.set({ delayMs: 3000 });
  const before = github.requests.length;
  try {
    await submit.click();
    const busy = await t.waitFor(
      () => submit.evaluate((button) => button.getAttribute("aria-busy") === "true" || button.disabled || button.getAttribute("aria-disabled") === "true"),
      (value) => value === true,
      3000,
    );
    check(busy, "while waiting, the button is marked busy or disabled");
    const label = (await submit.innerText().catch(() => "")).trim();
    console.log(`    (button while waiting: "${label}")`);
    equal([await title.inputValue(), await body.inputValue()], ["Langsamer Hoster", "Text bleibt während des Wartens stehen."], "title and description stay while waiting");
    // The UI stays usable: the command palette opens and closes again.
    await page.keyboard.press("Control+p");
    const palette = page.locator('[data-screen="command-palette"] input[role="combobox"]');
    const opened = await palette.waitFor({ timeout: 2500 }).then(() => true, () => false);
    check(opened, "while waiting, Ctrl+P opens the command palette (the UI does not hang)");
    if (opened) await page.keyboard.press("Escape");
    await page.locator(PR_VIEW).waitFor({ timeout: 90_000 });
  } finally {
    github.set({ delayMs: 0 });
  }
  equal(posted(before).length, 1, "exactly one pull request was created");
  equal(sorted(posted(before)[0]?.body), sorted({ title: "Langsamer Hoster", body: "Text bleibt während des Wartens stehen.", head: "thema/langsam", base: "main", draft: false }), "with the content from the form");
  await leave();
});

// ---------------------------------------------------------------------------------------------
const ODD_BRANCH = "thema/größen-🚀-übersicht";
await t.section("F20-E6", "Branch name with umlauts and emoji: push and create – the name arrives correctly at the host and on the server", async () => {
  const sha = await newBranch(ODD_BRANCH, "Größen-Übersicht 🚀");
  await openForm(ODD_BRANCH);
  await eventually(() => title.inputValue(), "Größen-Übersicht 🚀", "title from the commit, with umlaut and emoji");
  equal((await view.locator('[role="combobox"]').allInnerTexts()).map((text) => text.trim())[0], ODD_BRANCH, "source: the branch name is shown correctly");
  const before = github.requests.length;
  await submit.click();
  await page.locator(PR_VIEW).waitFor({ timeout: 60_000 });
  equal(posted(before)[0]?.body?.head, ODD_BRANCH, "host: source with umlaut and emoji");
  equal(github.serverGit("rev-parse", `refs/heads/${ODD_BRANCH}`), sha, "git (server): the branch is there under its name");
  equal(await t.overflow().then((value) => value.x), 0, "no horizontal overflow");
  await leave();
});

// ---------------------------------------------------------------------------------------------
await t.section("F20-E7", "Changed from outside: the source branch is deleted in the terminal while the form is open – rejected with a clear message", async () => {
  await newBranch("thema/gleich-weg", "Gleich weg", { checkout: false });
  await openForm("thema/gleich-weg");
  await eventually(() => title.inputValue(), "Gleich weg", "title prefilled");
  await body.fill("Text, der nicht verloren gehen darf.");
  gh.repo.git("branch", "-D", "thema/gleich-weg");
  const before = github.requests.length;
  await submit.click();
  await sleep(1500);
  const shown = async () => `${(await failure.count()) ? (await failure.innerText()).replace(/\s+/g, " ") : ""} ${(await view.getByRole("alert").allInnerTexts()).join(" ")} ${(await view.locator("[data-pr-steps]").innerText().catch(() => "")).replace(/\s+/g, " ")} ${(await t.toasts()).map((toast) => toast.text).join(" ")}`.trim();
  await eventually(async () => /gleich-weg|does not exist|doesn't exist|not found|failed/i.test(await shown()), true, "the app explains that the branch does not exist (anymore)", 30_000);
  equal(posted(before).length, 0, "no pull request was created");
  equal(github.serverGit("branch", "--list", "thema/gleich-weg"), "", "git (server): nothing pushed");
  check((await center())?.kind === "pr_create" || (await center())?.kind === "graph", "the view stays usable");
  if ((await center())?.kind === "pr_create") equal(await body.inputValue(), "Text, der nicht verloren gehen darf.", "the text is still in the form");
  await leave();
});

// ---------------------------------------------------------------------------------------------
await t.section("F20-N3", "Remote rejects: the server already has a different state under that name – push rejected, no pull request, text stays", async () => {
  const local = await newBranch("thema/abgelehnt", "Lokaler Stand");
  // On the server the same name points to a foreign commit (someone else was faster).
  github.serverGit("update-ref", "refs/heads/thema/abgelehnt", gh.sha.hafen);
  await openForm("thema/abgelehnt");
  await eventually(() => title.inputValue(), "Lokaler Stand", "title prefilled");
  await body.fill("Text, der nicht verloren gehen darf.");
  const before = github.requests.length;
  await submit.click();
  await sleep(1500);
  const shown = async () => `${(await page.locator('[role="dialog"]').count()) ? (await page.locator('[role="dialog"]').last().innerText()).replace(/\s+/g, " ") : ""} ${(await failure.count()) ? (await failure.innerText()).replace(/\s+/g, " ") : ""} ${(await t.toasts()).map((toast) => toast.text).join(" ")}`.trim();
  await eventually(async () => /rejected|Push/i.test(await shown()), true, "the app reports the rejected push", 40_000);
  const text = await shown();
  check(!/Pull request #\d+ created/.test(text), `no success reported (${text})`);
  equal(posted(before).length, 0, "no pull request was created");
  equal(github.serverGit("rev-parse", "refs/heads/thema/abgelehnt"), gh.sha.hafen, "git (server): the foreign state is not overwritten");
  check(gh.repo.git("rev-parse", "thema/abgelehnt") === local, "git: the local branch is unchanged");
  // Close a dialog (e.g. "Push rejected") without forcing.
  for (let round = 0; round < 3 && (await page.locator('[role="dialog"]').count()) > 0; round++) await page.keyboard.press("Escape");
  if ((await center())?.kind === "pr_create") equal([await title.inputValue(), await body.inputValue()], ["Lokaler Stand", "Text, der nicht verloren gehen darf."], "title and description are still in the form");
  equal(github.serverGit("rev-parse", "refs/heads/thema/abgelehnt"), gh.sha.hafen, "git (server): not overwritten after Esc either");
  await leave();
});

// ---------------------------------------------------------------------------------------------
await t.section("F20-E9", "Screen reader and minimum window: named fields, errors as \"alert\", visible focus, 960×600", async () => {
  await newBranch("thema/zugang", "Zugänglichkeit prüfen");
  await runCommand(t.app, "Create pull request", "pr.create");
  await form.waitFor({ timeout: 30_000 });
  await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("name")), "title", "after opening by keyboard, focus is in the title");
  check((await t.focused()).visible, `the focus in the title is visible (${JSON.stringify(await t.focused())})`);
  equal(await view.getByRole("textbox", { name: "Title" }).count(), 1, "the \"Title\" field is reachable by its name");
  equal(await view.getByRole("textbox", { name: /^Description/ }).count(), 1, "so is the \"Description\" field");
  equal(await t.unnamedControls(VIEW), [], "every control of the form has an accessible name");
  const combos = await view.locator('[role="combobox"]').evaluateAll((list) => list.map((item) => item.getAttribute("aria-label") ?? (item.getAttribute("aria-labelledby") ? document.getElementById(item.getAttribute("aria-labelledby").split(" ")[0])?.textContent : null) ?? (item.id ? document.querySelector(`label[for="${item.id}"]`)?.textContent : null) ?? ""));
  check(combos.length === 2 && combos.every((name) => /Source|Target|Branch|From|\bTo\b/i.test(name ?? "")), `both selects are named after their purpose, not just their value (${JSON.stringify(combos)})`);
  await title.fill("   ");
  await submit.click();
  await eventually(async () => (await view.getByRole("alert").allInnerTexts()).join(" ").includes("Enter a title"), true, "empty title: the error is shown as \"alert\" at the field");
  await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("name")), "title", "and focus jumps into the field");
  await title.fill("Zugänglichkeit prüfen");
  await t.app.setSize(960, 600);
  try {
    await sleep(300);
    equal(await t.overflow().then((value) => value.x), 0, "960×600: no horizontal overflow");
    check(await t.inViewport(submit), "960×600: the create button is visible");
    check(await t.inViewport(title), "960×600: the title is visible");
  } finally {
    await t.app.setSize(1440, 900);
  }
  await leave();
});

// ---------------------------------------------------------------------------------------------
await t.section("F20-E5", "Offline: the host is unreachable – error in the form, the text stays, no hang", async () => {
  // An already pushed branch, so only the call to the host is left.
  await newBranch("thema/offline", "Ohne Netz");
  // Asynchronous: the Git server runs in this process, a synchronous push would block it.
  await gitAsync(gh.repo, ["push", "-q", "-u", "origin", "thema/offline"]);
  await t.refresh(repoId);
  await openForm("thema/offline");
  await eventually(() => title.inputValue(), "Ohne Netz", "title prefilled");
  await body.fill("Text, der nicht verloren gehen darf.");
  await eventually(async () => (await submit.innerText()).trim(), "Create pull request", "the branch is already on the remote: the button no longer pushes");
  const before = github.requests.length;
  await github.close();
  const started = Date.now();
  await submit.click();
  await failure.waitFor({ timeout: 90_000 }).catch(() => undefined);
  const seconds = Math.round((Date.now() - started) / 1000);
  const text = (await failure.count()) ? (await failure.innerText()).replace(/\s+/g, " ") : (await t.toasts()).map((toast) => toast.text).join(" ");
  check(/not reachable|cannot be reached|offline|connection|network|reach/i.test(text), `the app says the host is unreachable (${text})`);
  check(seconds <= 75, `the message comes in reasonable time (${seconds} s)`);
  console.log(`    (message after ${seconds} s: ${text.slice(0, 200)})`);
  equal(github.requests.length, before, "nothing arrived at the host");
  equal([await title.inputValue(), await body.inputValue()], ["Ohne Netz", "Text, der nicht verloren gehen darf."], "title and description are still there");
  equal((await center())?.kind, "pr_create", "the view stays open");
  check(!(await submit.isDisabled()), "the button is free again for a retry");
  for (const token of [github.token]) equal(await tokenLeaks(t.app, token), [], "the token appears nowhere in UI or storage");
  await leave();
});

for (const account of await t.app.invoke("host_accounts").catch(() => [])) await t.app.invoke("host_disconnect", { accountId: account.id }).catch(() => undefined);
await t.close();
if (process.platform === "win32" && keychainEntries(KEYRING).length) console.log(`Note: the keychain still holds entries of this run (${KEYRING}).`);
await github.close().catch(() => undefined);
await t.finish();
