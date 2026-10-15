/**
 * Ticket links (v1.1) in the real app: references in commit messages (#42, !7, OPS-17, own
 * patterns) become link buttons in the graph and in the commit details. Four sources: the detected
 * host (GitHub/GitLab from the remote URL, never contacted), tracker presets (Jira, Linear,
 * YouTrack, Redmine), own regular expressions with an address template (Settings › Project ›
 * Ticket links) and the repository file `.forkyard/links.json`.
 *
 * A click never starts a browser: `window.__gcTestOpened` (debug builds) records the address
 * instead. Every scenario checks the UI and the state behind it (repo settings through the core,
 * the repository through git).
 *
 *   node scripts/e2e-wd/features/ticket-links.mjs
 *   E2E_WD_ONLY=Jira node scripts/e2e-wd/features/ticket-links.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { linksFile, makeLinksRepo } from "../fixtures/ticket-links.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const W = 1440;
const H = 900;
const GITHUB = "https://github.com/acme/wetterstation";
const GITLAB = "https://gitlab.com/acme/wetterstation";
// The remotes only name a public host; nothing may ever reach it. A dead proxy makes sure of that.
const NO_NETWORK = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(t, extra = {}) {
  const app = await t.launch({ width: W, height: H, theme: "light", lang: "en", env: NO_NETWORK, ...extra });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  // Links record their address here instead of opening a browser.
  await app.exec(() => {
    window.__gcTestOpened = [];
  });
  return app;
}

/** Waits until fn() deep-equals expected (JSON); throws with the last value. */
async function eventually(fn, expected, message, timeout = 15_000) {
  let last;
  const deadline = Date.now() + timeout;
  for (;;) {
    last = await fn();
    if (JSON.stringify(last) === JSON.stringify(expected)) return last;
    if (Date.now() > deadline) throw new Error(`${message}: expected ${JSON.stringify(expected)}, last ${JSON.stringify(last)}`);
    await sleep(150);
  }
}

const opened = (app) => app.exec(() => window.__gcTestOpened.slice());
const clearOpened = (app) => app.exec(() => void window.__gcTestOpened.splice(0));

/** Ticket links inside `scope` (CSS): [{ text, rule, title, tabIndex }]. */
const linksIn = (app, scope) =>
  app.exec(
    (css) =>
      [...document.querySelectorAll(`${css} [data-ticket-link]`)].map((link) => ({
        text: link.textContent,
        rule: link.dataset.ticketLink,
        title: link.getAttribute("title"),
        tabIndex: link.tabIndex,
      })),
    scope,
  );

/** Rendered text via innerText: WebDriver's element text skips `truncate` (overflow hidden) spans. */
const innerText = (app, el) => app.exec((node) => node.innerText.replace(/\s+/g, " ").trim(), el);

const rowCss = (sha) => `[data-row-id="${sha}"]`;
const SUMMARY = '[data-screen="commit-details"] [data-testid="commit-summary"]';
const DESCRIPTION = '[data-screen="commit-details"] [data-testid="commit-description"]';

const selection = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.selection ?? null, tabId);

/** Selects a commit with a real click on its date cell (the message cell may hold link buttons). */
async function selectCommit(app, sha) {
  const cell = await app.waitFor(`${rowCss(sha)} [data-cell="date"]`, 15_000);
  await app.click(cell);
  await app.waitFor(() => app.exec((full) => document.querySelector('[data-screen="commit-details"]')?.innerText.includes(full.slice(0, 7)) ?? false, sha), 10_000, { message: `details of ${sha.slice(0, 7)}` });
  await app.waitFor(SUMMARY, 10_000);
}

/** Opens Settings › Project › Ticket links (dialog, then the section tab). */
async function openLinkSettings(app) {
  await app.exec(() => window.__gc.store.getState().openOverlay({ kind: "preferences", section: "repo" }));
  await app.waitFor('[data-screen="settings"]', 10_000, { message: "settings open" });
  await app.click(await app.waitFor('[role="tab"][id$="-trigger-p-links"]', 10_000, { message: "Ticket links section" }));
  await app.waitFor('[data-screen="settings"] [data-link-file]', 10_000, { message: "Ticket links section shown" });
  await app.settle();
}

async function closeSettings(app) {
  await app.press("Escape");
  await app.waitFor(async () => !(await app.$('[data-screen="settings"]')), 10_000, { message: "settings closed" });
}

/** The input/trigger that a <label> with exactly this text points to, within the settings. */
const field = (app, label) =>
  app.waitFor(
    () =>
      app.exec((text) => {
        const found = [...document.querySelectorAll('[data-screen="settings"] label')].find((el) => el.textContent.trim() === text);
        return found ? document.getElementById(found.htmlFor) : null;
      }, label),
    10_000,
    { message: `field “${label}”` },
  );

/** Sets a controlled text field to `value` (select all, then type). */
async function fill(app, label, value) {
  const input = await field(app, label);
  await app.click(input);
  await app.press("Control+a", "Backspace");
  if (value) await app.type(input, value);
  await eventually(() => input.prop("value"), value, `value of “${label}”`, 5000);
}

/** Picks an option of a Radix select by its label. */
async function choose(app, label, option) {
  await app.click(await field(app, label));
  const item = await app.waitFor(() => app.exec((text) => [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.trim() === text) ?? null, option), 5000, { message: `option ${option}` });
  await app.click(item);
  await eventually(async () => (await field(app, label)).text(), option, `select ${label}`, 5000);
}

/** A button inside the settings by its visible text or label. */
const settingsButton = (app, text) =>
  app.waitFor(
    () => app.exec((name) => [...document.querySelectorAll('[data-screen="settings"] button')].find((el) => el.textContent.trim() === name || el.getAttribute("aria-label") === name) ?? null, text),
    10_000,
    { message: `button “${text}”` },
  );

const alerts = (app) => app.exec(() => [...document.querySelectorAll('[data-screen="settings"] [role="alert"]')].map((el) => el.textContent.trim()));
const linkConfig = async (app, repoId) => (await app.invoke("repo_settings_get", { repoId })).linkRules;
const effective = async (app, repoId) => (await app.invoke("link_rules_get", { repoId })).rules.map((rule) => [rule.id, rule.source, rule.url]);

/** The host-rules switch in the section. */
const hostSwitch = (app) => app.waitFor('[data-screen="settings"] [role="switch"]', 10_000, { message: "host switch" });

/** Reads the file card: { origin, rules: [pattern, url][], problems: string[] }. */
const fileCard = (app) =>
  app.exec(() => {
    const card = document.querySelector("[data-link-file]");
    if (!card) return null;
    return {
      origin: card.dataset.linkFile,
      rules: [...card.querySelectorAll("[data-link-file-rule]")].map((rule) => rule.innerText.split("\n").map((line) => line.trim()).filter(Boolean)),
      problems: [...card.querySelectorAll("ul li")].map((item) => item.textContent.trim()),
      text: card.innerText.replace(/\s+/g, " ").trim(),
    };
  });

// =============================================================================================
// 1. Host automatically
// =============================================================================================

scenario("GitHub remote: #42 in graph and details opens the issue on GitHub", "main", async (t) => {
  const repo = makeLinksRepo({ remote: `${GITHUB}.git` });
  try {
    const c1 = repo.commit("Luftdruck auf hPa umgestellt (#42)", "Behebt #7 und den Rundungsfehler aus #1234.\nKein Link: #42abc, Version 1.2");
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    assertEqual(repo.git("remote", "get-url", "origin"), `${GITHUB}.git`, "git: origin points to GitHub");

    const graphLinks = await app.waitFor(async () => {
      const found = await linksIn(app, rowCss(c1));
      return found.length ? found : null;
    }, 15_000, { message: "link in the graph row" });
    assertEqual(graphLinks.map((link) => [link.text, link.rule, link.tabIndex]), [["#42", "host:issue", -1]], "graph: #42 is a host link and no tab stop");
    assertEqual(graphLinks[0].title, `Open ${GITHUB}/issues/42 in the browser`, "graph: tooltip names the address");

    // Clicking the link in the graph opens it and does not select the row.
    const before = await selection(app, tabId);
    await app.click(await app.waitFor(`${rowCss(c1)} [data-ticket-link]`));
    await eventually(() => opened(app), [`${GITHUB}/issues/42`], "opened from the graph");
    assertEqual(await selection(app, tabId), before, "the row click handler ignored the link");

    await selectCommit(app, c1);
    assertEqual((await linksIn(app, SUMMARY)).map((link) => [link.text, link.rule, link.tabIndex]), [["#42", "host:issue", 0]], "details: summary link (focusable)");
    assertEqual((await linksIn(app, DESCRIPTION)).map((link) => link.text), ["#7", "#1234"], "details: description links, not #42abc");
    const description = await (await app.$(DESCRIPTION)).text();
    assertIncludes(description, "#42abc", "#42abc stays plain text");
    await clearOpened(app);
    await app.click(await app.waitFor(() => app.byText("#1234", { within: DESCRIPTION })));
    await eventually(() => opened(app), [`${GITHUB}/issues/1234`], "opened from the description");
    assertEqual(await effective(app, repoId), [["host:issue", "host", `${GITHUB}/issues/$1`]], "core: one host rule");
    await t.shot("github-host-links");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("GitLab remote: #3 opens the issue, !7 the merge request", "edge", async (t) => {
  const repo = makeLinksRepo({ remote: "git@gitlab.com:acme/wetterstation.git" });
  try {
    const c1 = repo.commit("Merge-Request !7 übernommen, schließt #3");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    const links = await app.waitFor(async () => {
      const found = await linksIn(app, rowCss(c1));
      return found.length === 2 ? found : null;
    }, 15_000, { message: "two links in the graph row" });
    assertEqual(links.map((link) => [link.text, link.rule]), [["!7", "host:merge_request"], ["#3", "host:issue"]], "graph: !7 and #3");
    await selectCommit(app, c1);
    await app.click(await app.waitFor(() => app.byText("!7", { within: SUMMARY })));
    await app.click(await app.waitFor(() => app.byText("#3", { within: SUMMARY })));
    await eventually(() => opened(app), [`${GITLAB}/-/merge_requests/7`, `${GITLAB}/-/issues/3`], "GitLab addresses (SSH remote → https web address)");
    assertEqual((await effective(app, repoId)).map(([id]) => id), ["host:issue", "host:merge_request"], "core: two GitLab host rules");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("No remote on a known host: no links, the section explains why", "edge", async (t) => {
  const repo = makeLinksRepo({ remote: "https://git.intern.example/acme/wetterstation.git" });
  try {
    const c1 = repo.commit("Sensor getauscht, siehe #42 und OPS-17");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await selectCommit(app, c1);
    assertEqual(await linksIn(app, "body"), [], "no ticket link anywhere");
    assertEqual(await (await app.$(SUMMARY)).text(), "Sensor getauscht, siehe #42 und OPS-17", "summary as plain text");
    const none = await app.invoke("link_rules_get", { repoId });
    assertEqual([none.rules, none.file, none.problems], [[], null, []], "core: no rules");
    await openLinkSettings(app);
    assert(await app.byText(/No remote of this repository is on GitHub, GitLab or a connected instance/, { regex: true }), "hint: nothing to link to");
    assertEqual(await (await hostSwitch(app)).attr("aria-checked"), "true", "host links stay switched on");
    assertEqual((await fileCard(app)).origin, "none", "no repository file");
    assertIncludes((await fileCard(app)).text, "The repository has no .forkyard/links.json.", "file card text");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Switching host links off removes them, on again brings them back", "edge", async (t) => {
  const repo = makeLinksRepo({ remote: `${GITHUB}.git` });
  try {
    const c1 = repo.commit("Kalibrierung korrigiert (#42)");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await app.waitFor(`${rowCss(c1)} [data-ticket-link]`, 15_000, { message: "host link in the graph" });
    await openLinkSettings(app);
    const toggle = await hostSwitch(app);
    assertEqual(await toggle.attr("aria-checked"), "true", "on by default");
    await app.click(toggle);
    await eventually(() => toggle.attr("aria-checked"), "false", "switch off");
    await eventually(async () => (await linkConfig(app, repoId)).hostRules, false, "core: hostRules saved as false");
    await eventually(() => effective(app, repoId), [], "core: no effective rules");
    await t.shot("host-links-off");
    await closeSettings(app);
    await eventually(async () => (await linksIn(app, rowCss(c1))).length, 0, "graph: link gone");
    // The setting lives in the app database, not in the repository.
    assertEqual(repo.git("config", "--local", "--list").includes("link"), false, "git: nothing written to .git/config");
    assertEqual(repo.git("status", "--porcelain"), "", "git: working tree untouched");

    await openLinkSettings(app);
    await app.click(await hostSwitch(app));
    await eventually(async () => (await linkConfig(app, repoId)).hostRules, true, "core: hostRules on again");
    await closeSettings(app);
    await eventually(async () => (await linksIn(app, rowCss(c1))).map((link) => link.rule), ["host:issue"], "graph: link back");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Keyboard: Tab reaches the links in the details, Enter opens; graph links are no tab stops", "edge", async (t) => {
  const repo = makeLinksRepo({ remote: `${GITHUB}.git` });
  try {
    const c1 = repo.commit("Windmesser ergänzt (#5)", "Siehe auch #6.");
    const app = await launch(t);
    await app.openRepo(repo.path);
    await selectCommit(app, c1);
    assert((await linksIn(app, rowCss(c1))).every((link) => link.tabIndex === -1), "graph links have tabindex -1");
    // Focus the summary link, then Tab to the description link, Enter opens it.
    await app.exec((css) => document.querySelector(`${css} [data-ticket-link]`).focus(), SUMMARY);
    assertEqual(await app.exec(() => document.activeElement?.textContent), "#5", "focus on #5");
    await app.press("Enter");
    await eventually(() => opened(app), [`${GITHUB}/issues/5`], "Enter opens #5");
    await app.press("Tab");
    assertEqual(await app.exec(() => document.activeElement?.textContent), "#6", "Tab moves to #6");
    await app.press("Space");
    await eventually(() => opened(app), [`${GITHUB}/issues/5`, `${GITHUB}/issues/6`], "Space opens #6");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// =============================================================================================
// 2. Presets (Jira, Linear, YouTrack, Redmine)
// =============================================================================================

scenario("Jira preset with project keys: OPS-17 and WEB-3 open Jira, UTF-8 stays text", "main", async (t) => {
  const repo = makeLinksRepo();
  try {
    const c1 = repo.commit("OPS-17: Sensor kalibriert", "Folgt aus WEB-3. Datei bleibt UTF-8, Prüfsumme SHA-256.");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await openLinkSettings(app);
    assertEqual(await (await settingsButton(app, "Add")).prop("disabled"), true, "Add is disabled without an address");
    await choose(app, "Tracker", "Jira");
    await fill(app, "Address", "https://acme.atlassian.net/");
    await fill(app, "Project keys", "ops, web");
    await app.click(await settingsButton(app, "Add"));
    const card = await app.waitFor('[data-link-preset="jira"]', 10_000, { message: "Jira card" });
    assertMatch(await innerText(app, card), /Jira[\s\S]*https:\/\/acme\.atlassian\.net[\s\S]*Keys: OPS, WEB/, "card: name, address without slash, keys in capitals");
    assertEqual(await alerts(app), [], "no error");
    assertEqual((await field(app, "Address").then((input) => input.prop("value"))), "", "address field cleared after adding");
    assertEqual((await linkConfig(app, repoId)).presets.map(({ kind, baseUrl, keys }) => ({ kind, baseUrl, keys })), [{ kind: "jira", baseUrl: "https://acme.atlassian.net", keys: ["OPS", "WEB"] }], "core: preset stored normalized");
    assertEqual(await effective(app, repoId), [["preset:jira:0", "preset", "https://acme.atlassian.net/browse/$0"]], "core: effective rule");
    await t.shot("jira-preset-settings");
    await closeSettings(app);

    await selectCommit(app, c1);
    await eventually(async () => (await linksIn(app, SUMMARY)).map((link) => link.text), ["OPS-17"], "summary: OPS-17");
    assertEqual((await linksIn(app, DESCRIPTION)).map((link) => link.text), ["WEB-3"], "description: WEB-3 only, not UTF-8 / SHA-256");
    assertEqual((await linksIn(app, rowCss(c1))).map((link) => link.text), ["OPS-17"], "graph: OPS-17");
    await app.click(await app.waitFor(() => app.byText("OPS-17", { within: SUMMARY })));
    await app.click(await app.waitFor(() => app.byText("WEB-3", { within: DESCRIPTION })));
    await eventually(() => opened(app), ["https://acme.atlassian.net/browse/OPS-17", "https://acme.atlassian.net/browse/WEB-3"], "Jira addresses");
    await t.shot("jira-preset-links");
    assertEqual(repo.git("status", "--porcelain"), "", "git: repository untouched");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Preset input errors: no http(s) address, bad key – shown at the form, nothing saved", "edge", async (t) => {
  const repo = makeLinksRepo();
  try {
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await openLinkSettings(app);
    await choose(app, "Tracker", "YouTrack");
    await fill(app, "Address", "ftp://tracker.example");
    await app.click(await settingsButton(app, "Add"));
    const first = await app.waitFor(async () => (await alerts(app))[0], 10_000, { message: "error at the form" });
    assertMatch(first, /YouTrack: The address must start with http:\/\/ or https:\/\//, "address error");
    await fill(app, "Address", "https://lena@tracker.example");
    await app.click(await settingsButton(app, "Add"));
    await eventually(async () => (await alerts(app)).some((text) => /without a user name/.test(text)), true, "user name refused");
    await fill(app, "Address", "https://acme.youtrack.cloud");
    await fill(app, "Project keys", "1AB");
    await app.click(await settingsButton(app, "Add"));
    await eventually(async () => (await alerts(app)).some((text) => /“1AB” is not a project key/.test(text)), true, "key error");
    await t.shot("preset-input-error");
    assertEqual((await linkConfig(app, repoId)).presets, [], "core: nothing saved");
    assertEqual(await app.$$("[data-link-preset]"), [], "no preset card");
    // Fixing the key saves it and clears the error.
    await fill(app, "Project keys", "AB1");
    await app.click(await settingsButton(app, "Add"));
    await app.waitFor('[data-link-preset="youtrack"]', 10_000, { message: "YouTrack card" });
    await eventually(() => alerts(app), [], "error gone");
    assertEqual(await effective(app, repoId), [["preset:youtrack:0", "preset", "https://acme.youtrack.cloud/issue/$0"]], "core: YouTrack rule");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Redmine beats the host at #12; removing it gives #12 back to GitHub", "edge", async (t) => {
  const repo = makeLinksRepo({ remote: `${GITHUB}.git` });
  try {
    const c1 = repo.commit("Messintervall angepasst (#12)");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await app.waitFor(`${rowCss(c1)} [data-ticket-link="host:issue"]`, 15_000, { message: "host link first" });
    await openLinkSettings(app);
    await choose(app, "Tracker", "Redmine");
    assertEqual(await app.exec(() => [...document.querySelectorAll('[data-screen="settings"] label')].some((el) => el.textContent.trim() === "Project keys")), false, "Redmine has no key field");
    assert(await app.byText(/if the host links are on as well, your tracker wins/, { regex: true }), "Redmine hint");
    await fill(app, "Address", "https://redmine.example.com");
    await app.click(await settingsButton(app, "Add"));
    await app.waitFor('[data-link-preset="redmine"]', 10_000);
    assertEqual((await effective(app, repoId)).map(([id]) => id), ["preset:redmine:0", "host:issue"], "core: preset before host");
    await closeSettings(app);
    await eventually(async () => (await linksIn(app, rowCss(c1))).map((link) => link.rule), ["preset:redmine:0"], "graph: Redmine wins");
    await selectCommit(app, c1);
    await app.click(await app.waitFor(() => app.byText("#12", { within: SUMMARY })));
    await eventually(() => opened(app), ["https://redmine.example.com/issues/12"], "Redmine address");

    await openLinkSettings(app);
    await app.click(await settingsButton(app, "Remove Redmine"));
    await app.waitFor(async () => (await app.$$("[data-link-preset]")).length === 0, 10_000, { message: "card removed" });
    assertEqual((await linkConfig(app, repoId)).presets, [], "core: preset removed");
    await closeSettings(app);
    await eventually(async () => (await linksIn(app, rowCss(c1))).map((link) => link.rule), ["host:issue"], "graph: host link again");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Linear without keys links every KEY-1 form (also UTF-8, as documented)", "edge", async (t) => {
  const repo = makeLinksRepo();
  try {
    const c1 = repo.commit("ENG-204 umgesetzt, Kodierung UTF-8");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await openLinkSettings(app);
    await choose(app, "Tracker", "Linear");
    await fill(app, "Address", "https://linear.app/acme");
    await app.click(await settingsButton(app, "Add"));
    await app.waitFor('[data-link-preset="linear"]', 10_000);
    assertEqual((await linkConfig(app, repoId)).presets[0].keys, [], "core: no keys");
    await closeSettings(app);
    await selectCommit(app, c1);
    await eventually(async () => (await linksIn(app, SUMMARY)).map((link) => link.text), ["ENG-204", "UTF-8"], "both forms linked");
    await app.click(await app.waitFor(() => app.byText("ENG-204", { within: SUMMARY })));
    await eventually(() => opened(app), ["https://linear.app/acme/issue/ENG-204"], "Linear address");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// =============================================================================================
// 3. Own rules (regular expression + address template)
// =============================================================================================

scenario("Own rule with test field: CVE-2024-1234 opens the vulnerability page", "main", async (t) => {
  const repo = makeLinksRepo();
  try {
    const c1 = repo.commit("Abhängigkeit aktualisiert", "Schließt CVE-2024-1234 und CVE-2023-99.");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await openLinkSettings(app);
    assertEqual(await (await settingsButton(app, "Add rule")).prop("disabled"), true, "Add rule disabled while empty");
    await fill(app, "Pattern", "CVE-(\\d{4}-\\d+)");
    await fill(app, "Address template", "https://nvd.example/vuln/$1");
    await fill(app, "Try it", "Fixes CVE-2024-1234, not CVE-12");
    const tested = await app.waitFor('[data-screen="settings"] ul[aria-label="Links in the sample"]', 5000, { message: "test result" });
    assertEqual(await innerText(app, tested), "CVE-2024-1234 → https://nvd.example/vuln/2024-1234", "test field shows the match and the address");
    await app.exec((el) => el.scrollIntoView({ block: "center" }), tested);
    await app.settle();
    await t.shot("custom-rule-test-field");
    await app.click(await settingsButton(app, "Add rule"));
    const rule = await app.waitFor('[data-link-rule="rule-1"]', 10_000, { message: "rule row" });
    assertMatch(await innerText(app, rule), /CVE-\(\\d\{4\}-\\d\+\)[\s\S]*https:\/\/nvd\.example\/vuln\/\$1/, "rule row shows pattern and template");
    assertEqual((await field(app, "Pattern").then((input) => input.prop("value"))), "", "form cleared");
    assertEqual((await linkConfig(app, repoId)).custom.map(({ id, pattern, url }) => ({ id, pattern, url })), [{ id: "rule-1", pattern: "CVE-(\\d{4}-\\d+)", url: "https://nvd.example/vuln/$1" }], "core: rule stored");
    await closeSettings(app);

    await selectCommit(app, c1);
    await eventually(async () => (await linksIn(app, DESCRIPTION)).map((link) => [link.text, link.rule]), [["CVE-2024-1234", "custom:rule-1"], ["CVE-2023-99", "custom:rule-1"]], "description links");
    await app.click(await app.waitFor(() => app.byText("CVE-2024-1234", { within: DESCRIPTION })));
    await eventually(() => opened(app), ["https://nvd.example/vuln/2024-1234"], "address from group 1");
    await t.shot("custom-rule-link");
    assertEqual(repo.git("status", "--porcelain"), "", "git: repository untouched");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Own rule refused: lookahead, nested repetition, unknown group, placeholder host, 200 chars", "edge", async (t) => {
  const repo = makeLinksRepo();
  try {
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await openLinkSettings(app);
    const result = () => app.exec(() => [...document.querySelectorAll('[data-screen="settings"] p.text-sm')].map((el) => el.textContent.trim()));
    const tryAdd = async (pattern, url, expected, label) => {
      await fill(app, "Pattern", pattern);
      await fill(app, "Address template", url);
      await app.click(await settingsButton(app, "Add rule"));
      await eventually(async () => (await alerts(app)).some((text) => expected.test(text)), true, `${label}: refused (${expected})`);
    };

    await fill(app, "Try it", "aaaa OPS-1");
    await fill(app, "Pattern", "(a+)+");
    await eventually(async () => (await result()).includes("A repeated group must not contain a repetition itself, e.g. (a+)+."), true, "test field warns about nesting");
    await tryAdd("(a+)+", "https://tracker.example/$1", /^Rule 1: /, "nested repetition");
    await tryAdd("(?=OPS)OPS-\\d+", "https://tracker.example/$0", /^Rule 1: .*look/i, "lookahead");
    await tryAdd("OPS-(\\d+)", "https://tracker.example/t/$2", /uses \$2, but the pattern has only 1 group/, "unknown group");
    await tryAdd("OPS-(\\w+)", "https://$1.example/t", /fixed host before the first placeholder/, "placeholder in the host");
    await tryAdd("OPS-(\\d+)", "javascript:alert(1)//$1", /must start with http:\/\/ or https:\/\//, "javascript: address");
    await t.shot("custom-rule-refused");

    // The pattern field stops at 200 characters (the core's limit).
    await fill(app, "Pattern", "");
    const input = await field(app, "Pattern");
    await app.type(input, "x".repeat(205));
    assertEqual((await input.prop("value")).length, 200, "pattern field holds at most 200 characters");
    assertEqual((await linkConfig(app, repoId)).custom, [], "core: nothing saved");
    assertEqual(await app.$$("[data-link-rule]"), [], "no rule row");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Inserted text is URL-encoded: a match cannot change the path or query", "edge", async (t) => {
  const repo = makeLinksRepo();
  try {
    const c1 = repo.commit("Siehe REF-a/../b?x=1&y=#2 im Wiki");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await app.invoke("repo_settings_set", { repoId, patch: { linkRules: { hostRules: true, presets: [], custom: [{ id: "wiki", pattern: "REF-(\\S+)", url: "https://wiki.example/ref/$1" }] } } });
    await app.exec(() => window.__gc.queryClient.invalidateQueries());
    await selectCommit(app, c1);
    const link = await app.waitFor(() => app.byText("REF-a/../b?x=1&y=#2", { within: SUMMARY }), 10_000, { message: "REF link" });
    await app.click(link);
    await eventually(() => opened(app), ["https://wiki.example/ref/a%2F..%2Fb%3Fx%3D1%26y%3D%232"], "encoded address");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Own rule beats the host at the same place; deleting it restores the host link", "edge", async (t) => {
  const repo = makeLinksRepo({ remote: `${GITHUB}.git` });
  try {
    const c1 = repo.commit("Störung #77 behoben");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await openLinkSettings(app);
    await fill(app, "Pattern", "#(\\d+)");
    await fill(app, "Address template", "https://support.example/ticket/$1");
    await app.click(await settingsButton(app, "Add rule"));
    await app.waitFor('[data-link-rule="rule-1"]', 10_000);
    assertEqual((await effective(app, repoId)).map(([id]) => id), ["custom:rule-1", "host:issue"], "core: own rule first");
    await closeSettings(app);
    await eventually(async () => (await linksIn(app, rowCss(c1))).map((link) => link.rule), ["custom:rule-1"], "graph: own rule wins");
    await app.click(await app.waitFor(`${rowCss(c1)} [data-ticket-link]`));
    await eventually(() => opened(app), ["https://support.example/ticket/77"], "own address");

    await openLinkSettings(app);
    await app.click(await settingsButton(app, "Remove rule #(\\d+)"));
    await app.waitFor(async () => (await app.$$("[data-link-rule]")).length === 0, 10_000, { message: "rule removed" });
    assertEqual((await linkConfig(app, repoId)).custom, [], "core: rule deleted");
    await closeSettings(app);
    await eventually(async () => (await linksIn(app, rowCss(c1))).map((link) => link.rule), ["host:issue"], "graph: host link again");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// =============================================================================================
// 4. Repository file .forkyard/links.json
// =============================================================================================

scenario("Committed .forkyard/links.json: rules shown read-only, links work, no trust needed", "main", async (t) => {
  const repo = makeLinksRepo();
  try {
    repo.write(".forkyard/links.json", linksFile([{ id: "ops", pattern: "OPS-(\\d+)", url: "https://ops.example/ticket/$1" }]));
    const c1 = repo.commit("OPS-88: Regelwerk für Ticket-Links");
    assertEqual(repo.git("ls-files", ".forkyard"), ".forkyard/links.json", "git: file is committed");
    const app = await launch(t, { trustOpened: false });
    const openedRepo = await app.invoke("repo_open", { path: repo.path });
    assertEqual(openedRepo.repo.trusted, true, "core: the links file does not lock the repository");
    const repoId = openedRepo.repo.id;
    await app.waitFor(`${rowCss(c1)} [data-ticket-link="file:ops"]`, 20_000, { message: "file rule link in the graph" });
    await selectCommit(app, c1);
    await app.click(await app.waitFor(() => app.byText("OPS-88", { within: SUMMARY })));
    await eventually(() => opened(app), ["https://ops.example/ticket/88"], "file rule address");
    const rules = await app.invoke("link_rules_get", { repoId });
    assertEqual([rules.file, rules.problems, rules.rules.map((rule) => [rule.id, rule.source])], ["worktree", [], [["file:ops", "repo_file"]]], "core: from the worktree");

    await openLinkSettings(app);
    const card = await fileCard(app);
    assertEqual(card.origin, "worktree", "card: from the working directory");
    assertIncludes(card.text, "Read from the working directory.", "card text");
    assertEqual(card.rules, [["OPS-(\\d+)", "https://ops.example/ticket/$1"]], "card: the rule, read-only");
    assertEqual(await app.exec(() => document.querySelectorAll("[data-link-file] input, [data-link-file] button").length), 0, "card has no inputs or buttons");
    assertEqual((await linkConfig(app, repoId)).custom, [], "core: not copied into the own rules");
    await t.shot("links-json-settings");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("links.json deleted only in the working directory: read from HEAD", "edge", async (t) => {
  const repo = makeLinksRepo();
  try {
    repo.write(".forkyard/links.json", linksFile([{ pattern: "WS-(\\d+)", url: "https://tickets.example/ws/$1" }]));
    const c1 = repo.commit("WS-5 Regeln eingecheckt");
    fs.rmSync(path.join(repo.path, ".forkyard", "links.json"));
    assertEqual(repo.git("status", "--porcelain"), " D .forkyard/links.json", "git: deleted in the worktree only");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    const rules = await app.invoke("link_rules_get", { repoId });
    assertEqual([rules.file, rules.rules.map((rule) => rule.id)], ["head", ["file:1"]], "core: from HEAD, id from position");
    await selectCommit(app, c1);
    await app.click(await app.waitFor(() => app.byText("WS-5", { within: SUMMARY }), 10_000, { message: "WS-5 link" }));
    await eventually(() => opened(app), ["https://tickets.example/ws/5"], "address from the HEAD file");
    await openLinkSettings(app);
    const card = await fileCard(app);
    assertEqual(card.origin, "head", "card: from HEAD");
    assertIncludes(card.text, "Read from the last commit (HEAD)", "card text");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Faulty links.json entries are listed and skipped; edits apply live", "edge", async (t) => {
  const repo = makeLinksRepo();
  try {
    repo.write(
      ".forkyard/links.json",
      linksFile([
        { id: "ok", pattern: "OK-(\\d+)", url: "https://ok.example/$1" },
        { id: "back", pattern: "(?<=x)BAD-\\d+", url: "https://bad.example/$0" },
        { id: "host", pattern: "EVIL-(\\w+)", url: "https://$1.evil.example/" },
        { id: "extra", pattern: "X-\\d+", url: "https://x.example/$0", run: "rm -rf /" },
      ]),
    );
    const c1 = repo.commit("OK-1 und EVIL-attacker und BAD-2");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await selectCommit(app, c1);
    await eventually(async () => (await linksIn(app, SUMMARY)).map((link) => link.text), ["OK-1"], "only the valid rule links");
    await openLinkSettings(app);
    const card = await fileCard(app);
    assertEqual(card.rules, [["OK-(\\d+)", "https://ok.example/$1"]], "card: the valid rule");
    assertEqual(card.problems.length, 3, `three ignored entries: ${JSON.stringify(card.problems)}`);
    assertMatch(card.problems[0], /^Entry 2: /, "entry 2 named");
    assertMatch(card.problems[1], /^Entry 3: .*fixed host/, "entry 3: host placeholder");
    assertMatch(card.problems[2], /^Entry 4: Not a rule .*run/, "entry 4: unknown field");
    await t.shot("links-json-problems");

    // Broken JSON while the app is open: the whole file is reported, own rules keep working.
    await app.invoke("repo_settings_set", { repoId, patch: { linkRules: { hostRules: true, presets: [], custom: [{ id: "own", pattern: "OK-(\\d+)", url: "https://own.example/$1" }] } } });
    repo.write(".forkyard/links.json", '{ "version": 1, "rules": [ ');
    await eventually(async () => {
      const rules = await app.invoke("link_rules_get", { repoId });
      return [rules.rules.map((rule) => rule.id), rules.problems.length];
    }, [["custom:own"], 1], "core: own rule, one problem");
    await eventually(async () => (await fileCard(app))?.problems.some((text) => /links\.json cannot be read/.test(text)), true, "card shows the parse error (live)");

    // Unknown version.
    repo.write(".forkyard/links.json", linksFile([{ pattern: "V-(\\d+)", url: "https://v.example/$1" }], 2));
    await eventually(async () => (await fileCard(app))?.problems.some((text) => /has version 2; this version of Forkyard reads version 1/.test(text)), true, "version 2 reported");

    // Too large.
    repo.write(".forkyard/links.json", JSON.stringify({ version: 1, rules: [], pad: "x".repeat(70 * 1024) }));
    await eventually(async () => (await fileCard(app))?.problems.some((text) => /larger than 64 KiB/.test(text)), true, "large file reported");

    // Fixed again: a new rule appears without reopening anything.
    repo.write(".forkyard/links.json", linksFile([{ id: "neu", pattern: "BAD-(\\d+)", url: "https://neu.example/$1" }]));
    await eventually(async () => (await fileCard(app))?.rules, [["BAD-(\\d+)", "https://neu.example/$1"]], "new rule shown (live)");
    await eventually(async () => (await fileCard(app))?.problems, [], "no problems left");
    await closeSettings(app);
    await eventually(async () => (await linksIn(app, SUMMARY)).map((link) => [link.text, link.rule]), [["OK-1", "custom:own"], ["BAD-2", "file:neu"]], "details follow the file");
    assertEqual(repo.git("status", "--porcelain"), " M .forkyard/links.json", "git: only the file the test changed");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("links.json as a symlink to a file outside the repository is ignored", "edge", async (t) => {
  const repo = makeLinksRepo();
  try {
    const outside = path.join(repo.root, "fremd.json");
    fs.writeFileSync(outside, JSON.stringify(linksFile([{ pattern: "OPS-(\\d+)", url: "https://outside.example/$1" }])));
    fs.mkdirSync(path.join(repo.path, ".forkyard"), { recursive: true });
    fs.symlinkSync(outside, path.join(repo.path, ".forkyard", "links.json"));
    const c1 = repo.commit("OPS-3 mit Verweis nach außen");
    assertEqual(repo.git("cat-file", "-t", `HEAD:.forkyard/links.json`), "blob", "git: the symlink is committed");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    const rules = await app.invoke("link_rules_get", { repoId });
    assertEqual(rules.rules, [], "core: no rule from outside");
    assertMatch(rules.problems[0]?.message ?? "", /points outside the repository and is ignored/, "core: reported");
    await selectCommit(app, c1);
    assertEqual(await linksIn(app, "body"), [], "no link");
    await openLinkSettings(app);
    assertEqual((await fileCard(app)).problems.length, 1, "card lists the problem");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
