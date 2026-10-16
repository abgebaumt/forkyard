/**
 * Settings, themes, language, undo/redo and the activity log in the real app (1.0):
 *
 * - settings on three levels: global (the same in every profile), per profile, per project
 *   (inherits from the profile; own values are written to the repository's .git/config),
 *   search, keyboard, validation at the field, persistence across a restart;
 * - light and dark theme (and "System"), persisted;
 * - UI language English/German (stored in the WebView, the window reloads);
 * - undo/redo from the toolbar and with Ctrl+Z / Ctrl+Y, including the refusals (nothing to undo,
 *   repository changed in between, commit already pushed, newer work in the same file);
 * - the activity log: entries of the repository and of the app, search, "Errors only",
 *   expanded output, keyboard, empty states and redacted credentials.
 *
 * Every result is checked in the UI and in the core / in Git (git in the temp repository).
 *
 *   node scripts/e2e-wd/features/settings.mjs
 *   E2E_WD_ONLY="undo" node scripts/e2e-wd/features/settings.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { commitUi, eventually, until } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Runs a scenario body and always removes the fixtures registered in `t.cleanups`. */
const withCleanup = (fn) => async (t) => {
  t.cleanups = [];
  try {
    await fn(t);
  } finally {
    for (const cleanup of t.cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // best effort
      }
    }
  }
};

/** A fresh copy of the "messnetz" fixture (main + feature/export, origin as a local bare repo). */
function repoFor(t, { localIdentity = true } = {}) {
  const repo = makeCleanRepoWithRemote();
  if (!localIdentity) {
    for (const key of ["user.name", "user.email"]) {
      try {
        repo.git("config", "--local", "--unset", key);
      } catch {
        // not set
      }
    }
  }
  t.cleanups.push(() => repo.cleanup());
  return repo;
}

/** A data directory that outlives one launch (restart scenarios). */
function persistentDataDir(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-settings-data-")));
  t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/**
 * Starts the app. `restart: true` starts it again on an existing data directory: the harness ends a
 * session hard (WebDriver kills the app), so the app rightly reports an unexpected exit on the next
 * start; that prompt is closed and the report discarded – it is not what these scenarios test.
 */
async function launch(t, { restart = false, ...options } = {}) {
  const app = await t.launch({ ...LAUNCH, ...options });
  if (restart) {
    const title = "Forkyard closed unexpectedly last time";
    if (await app.waitFor(async () => (await dialogTitle(app)) === title, 6000).catch(() => false)) {
      await app.click(await app.waitFor(() => app.byText("Cancel", { within: '[role="dialog"]' })));
      await app.waitFor(async () => (await dialogTitle(app)) !== title, 5000, { message: "crash prompt closed" });
    }
    for (const report of await app.invoke("crash_reports_list")) await app.invoke("crash_report_discard", { id: report.id });
  }
  // No background fetch: it would add log entries and network noise at random moments.
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  return app;
}

const toasts = (app, tone = null) =>
  app.exec((which) => [...document.querySelectorAll(which ? `[data-toast="${which}"]` : "[data-toast]")].map((el) => el.innerText.replace(/\s+/g, " ").trim()), tone);
async function waitToast(app, tone, pattern, timeout = 20_000) {
  return app.waitFor(async () => (await toasts(app, tone)).find((text) => pattern.test(text)) ?? null, timeout, {
    message: `${tone} toast ${pattern}; present: ${JSON.stringify(await toasts(app).catch(() => []))}`,
  });
}
async function closeToasts(app) {
  for (let round = 0; round < 12; round++) {
    const closed = await app.exec(() => {
      const button = document.querySelector('[data-toast] button[aria-label="Close message"]');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!closed) return;
    await sleep(120);
  }
}
async function noDangerToasts(app) {
  assertEqual(await toasts(app, "danger"), [], "no error message");
}

/** Runs a command through the palette (Ctrl+P, ">text", click on the entry with that id). */
async function runCommand(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const find = () => app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` });
  // The result list re-renders while the deferred filter settles: an entry found a moment ago can be
  // replaced by an identical node. Look it up again instead of failing on the stale reference.
  for (let attempt = 0; ; attempt++) {
    try {
      await app.click(await find());
      break;
    } catch (error) {
      if (attempt >= 3 || !/stale element/i.test(String(error.message))) throw error;
      await app.settle(200);
    }
  }
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** A button of the status line at the bottom by its visible text ("Settings", "Log"). */
function statusButton(app, label) {
  return app.waitFor(
    () =>
      app.exec((wanted) => {
        const buttons = [...document.querySelectorAll("button")].filter((button) => !button.closest('[role="dialog"]'));
        // The status line is the last row of the shell: its buttons are the lowest on the screen.
        const hits = buttons.filter((button) => button.innerText.trim() === wanted && button.getBoundingClientRect().top > window.innerHeight - 60);
        return hits[0] ?? null;
      }, label),
    10_000,
    { message: `status line button ${label}` },
  );
}

// ---- toolbar (undo / redo) --------------------------------------------------------------------

/** The toolbar button with this visible label: { el, disabled, hint }. */
async function toolbarButton(app, label) {
  const found = await app.waitFor(
    () =>
      app.exec((wanted) => {
        for (const button of document.querySelectorAll("button")) {
          const spans = [...button.children].filter((child) => child.tagName === "SPAN");
          if (spans.some((span) => !span.id && span.textContent.trim() === wanted)) {
            const hint = spans.find((span) => span.id)?.textContent.trim() ?? "";
            return [button, button.getAttribute("aria-disabled") === "true", button.getAttribute("aria-busy") === "true", hint];
          }
        }
        return null;
      }, label),
    15_000,
    { message: `toolbar button ${label}` },
  );
  const [el, disabled, busy, hint] = found;
  return { el, disabled, busy, hint };
}
/** Waits until the toolbar button is enabled (or disabled) with a matching hint. */
async function waitToolbar(app, label, { disabled, hint }) {
  let last = null;
  try {
    return await app.waitFor(async () => {
      last = await toolbarButton(app, label);
      if (last.busy) return null;
      if (disabled !== undefined && last.disabled !== disabled) return null;
      if (hint && !hint.test(last.hint)) return null;
      return last;
    }, 20_000);
  } catch {
    throw new Error(`toolbar ${label}: expected disabled=${disabled} hint=${hint}; got ${JSON.stringify(last && { disabled: last.disabled, hint: last.hint })}`);
  }
}

// ---- settings dialog --------------------------------------------------------------------------

const SETTINGS = '[data-screen="settings"]';

async function openSettings(app, { via = "toolbar" } = {}) {
  if (via === "toolbar") await app.click((await toolbarButton(app, "Settings")).el);
  else if (via === "shortcut") {
    await app.exec(() => document.activeElement?.blur());
    await app.press("Control+,");
  } else await runCommand(app, "Settings", "app.preferences");
  await app.waitFor(SETTINGS, 10_000, { message: "settings dialog" });
  await app.settle();
}

async function closeSettings(app) {
  await app.click(`${SETTINGS} button[aria-label="Close settings"]`);
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), SETTINGS), 5000, { message: "settings closed" });
}

/** Navigation of the dialog: group heads and the section tabs below them. */
const settingsNav = (app) =>
  app.exec((css) => {
    const list = document.querySelector(`${css} [role="tablist"]`);
    if (!list) return null;
    return [...list.children].map((group) => ({
      head: group.firstElementChild?.matches('[role="tab"]') ? null : group.firstElementChild?.innerText.trim() ?? null,
      tabs: [...group.querySelectorAll('[role="tab"]')].map((tab) => ({ label: tab.innerText.replace(/\s+/g, " ").trim(), active: tab.dataset.state === "active" })),
    }));
  }, SETTINGS);

async function openSection(app, label) {
  const tab = await app.waitFor(
    () => app.exec((css, wanted) => [...document.querySelectorAll(`${css} [role="tab"]`)].find((el) => el.querySelector("span")?.textContent.trim() === wanted) ?? null, SETTINGS, label),
    10_000,
    { message: `settings section ${label}` },
  );
  await app.click(tab);
  await app.waitFor(() => app.exec((el) => el.dataset.state === "active", tab), 5000, { message: `section ${label} active` });
  await app.settle();
}

/** The active section: { scope, heading, label }. */
const activeSection = (app) =>
  app.exec((css) => {
    const panel = document.querySelector(`${css} [role="tabpanel"][data-state="active"]`);
    const tab = document.querySelector(`${css} [role="tab"][data-state="active"]`);
    return {
      label: tab?.querySelector("span")?.textContent.trim() ?? null,
      scope: panel?.querySelector("[data-scope]")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      heading: panel?.querySelector("h2")?.innerText.trim() ?? null,
    };
  }, SETTINGS);

const rowCss = (title) => `${SETTINGS} [role="tabpanel"][data-state="active"] [data-setting=${JSON.stringify(title)}]`;

/** State of a setting row: { changed, own, text, error, input }. */
const rowState = (app, title) =>
  app.exec((css) => {
    const row = document.querySelector(css);
    if (!row) return null;
    const input = row.querySelector("input");
    return {
      text: row.innerText.replace(/\s+/g, " ").trim(),
      changed: /Changed · Reset/.test(row.innerText),
      own: row.hasAttribute("data-own"),
      error: row.querySelector('[role="alert"]')?.innerText.trim() ?? null,
      input: input ? input.value : null,
      invalid: input?.getAttribute("aria-invalid") === "true",
    };
  }, rowCss(title));

/** Clicks an option of a segmented control (Radix toggle group) in the dialog. */
/** Selector of a radio group by its aria-label; a label starting with "[" is used as a raw selector. */
const groupCss = (groupLabel) => (groupLabel.startsWith("[") ? `${SETTINGS} ${groupLabel}` : `${SETTINGS} [role="radiogroup"][aria-label=${JSON.stringify(groupLabel)}]`);
/** The language switch: "Language / Sprache" in English, "Sprache / Language" in German. */
const LANGUAGE = '[role="radiogroup"][aria-label*="Sprache"]';
async function chooseSegment(app, groupLabel, value) {
  const item = await app.waitFor(`${groupCss(groupLabel)} [data-value=${JSON.stringify(value)}]`, 10_000);
  await app.click(item);
  return item;
}
const segmentValue = (app, groupLabel) =>
  app.exec((css) => document.querySelector(css)?.querySelector('[data-state="on"]')?.dataset.value ?? null, groupCss(groupLabel));

/** Replaces the text of the row's text field and commits it with Enter. */
async function commitField(app, title, text) {
  const input = await app.waitFor(`${rowCss(title)} input`, 10_000);
  await app.click(input);
  await app.press("Control+a", "Backspace");
  if (text) await app.type(input, text);
  await app.press("Enter");
  return input;
}

/** A button inside a setting row by its text. */
async function rowButton(app, title, pattern) {
  const button = await app.waitFor(
    () =>
      app.exec((css, source) => {
        const wanted = new RegExp(source);
        return [...(document.querySelector(css)?.querySelectorAll("button") ?? [])].find((el) => wanted.test(el.innerText.trim()) || wanted.test(el.getAttribute("aria-label") ?? "")) ?? null;
      }, rowCss(title), pattern.source),
    10_000,
    { message: `button ${pattern} in row ${title}` },
  );
  await app.click(button);
}

const settings = (app) => app.invoke("settings_get", {});
const profiles = (app) => app.invoke("profile_list", {});
const activeProfile = async (app) => (await profiles(app)).find((profile) => profile.isActive);
const settingsQuery = (app) => app.exec(() => window.__gc.queryClient.getQueryData(["settings"]) ?? null);

async function waitSetting(app, key, expected, message = `setting ${key}`) {
  return eventually(async () => (await settings(app))[key], expected, message, 15_000);
}

const dialogTitle = (app) => app.exec(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop()?.querySelector("h2")?.innerText.trim() ?? null);
async function dialogButton(app, pattern) {
  const button = await app.waitFor(
    () =>
      app.exec((source) => {
        const wanted = new RegExp(source);
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
        return [...(dialog?.querySelectorAll("button") ?? [])].find((el) => wanted.test(el.innerText.trim()) && !el.disabled) ?? null;
      }, pattern.source),
    8000,
    { message: `dialog button ${pattern}` },
  );
  await app.click(button);
}

// ---- Git helpers ------------------------------------------------------------------------------

/** `git config --local <key>` or null when unset. */
function localConfig(repo, key) {
  try {
    return repo.git("config", "--local", "--get", key);
  } catch {
    return null;
  }
}
function globalConfigValue(app, key) {
  const text = fs.readFileSync(app.gitConfigPath, "utf8");
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m").exec(text);
  return match ? match[1].trim() : null;
}

/** Commits a new file through the commit panel (stage all, summary, Ctrl+Enter). Returns the new HEAD. */
async function commitInApp(app, repo, repoId, { file, content, summary }) {
  const ui = commitUi(app);
  repo.write(file, content);
  await ui.refresh();
  await until(async () => ((await ui.counts(repoId))?.unstaged ?? 0) > 0, "change shows up in the panel", 20_000);
  await app.click({ text: "Stage all", within: '[data-section="unstaged"]' });
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "staged");
  await ui.fill(await ui.summary(), summary);
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  await closeToasts(app);
  return repo.git("rev-parse", "HEAD");
}

// ---- activity log -----------------------------------------------------------------------------

const LOG = '[data-screen="activity-log"]';

async function openLog(app, { via = "status" } = {}) {
  if (via === "status") await app.click(await statusButton(app, "Log"));
  else await runCommand(app, "Activity log", "app.activity");
  await app.waitFor(LOG, 10_000, { message: "activity log open" });
  await app.waitFor(() => app.exec((css) => !/Loading/.test(document.querySelector(`${css} [data-log-count]`)?.textContent ?? "Loading"), LOG), 15_000, { message: "log loaded" });
}

/** Everything the log dialog shows. */
const logState = (app) =>
  app.exec((css) => {
    const root = document.querySelector(css);
    if (!root) return null;
    const rows = [...root.querySelectorAll("[data-entry-id]")]
      .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
      .map((li) => {
        const row = li.querySelector("[data-row]");
        return {
          id: li.dataset.entryId,
          command: row?.querySelector("span[title]")?.getAttribute("title") ?? "",
          exit: row?.querySelector("[data-exit]") ? "error" : row?.innerText.includes("OK") ? "ok" : "none",
          badge: row?.querySelector("span.flex.w-24")?.innerText.trim() ?? "",
          expanded: row?.getAttribute("aria-expanded") === "true",
          output: li.querySelector("pre")?.innerText ?? null,
        };
      });
    const STATE_CSS = '[data-state="empty"], [data-state="no-match"], [data-state="error"]';
    return {
      tabs: [...root.querySelectorAll('[role="tab"]')].map((tab) => ({ label: tab.innerText.replace(/\s+/g, " ").trim(), active: tab.dataset.state === "active" })),
      count: root.querySelector("[data-log-count]")?.innerText.trim() ?? "",
      state: root.querySelector(STATE_CSS)?.getAttribute("data-state") ?? null,
      stateText: root.querySelector(STATE_CSS)?.innerText.replace(/\s+/g, " ").trim() ?? null,
      onlyErrors: [...root.querySelectorAll("label")].map((label) => label.innerText.trim()).find((text) => /^Errors only/.test(text)) ?? null,
      search: root.querySelector('input[type="search"]')?.value ?? null,
      rows,
    };
  }, LOG);

async function logSearch(app, text) {
  const input = await app.waitFor(`${LOG} input[type="search"]`);
  await app.click(input);
  await app.press("Control+a", "Backspace");
  if (text) await app.type(input, text);
  await sleep(150);
}

const focused = (app) =>
  app.exec(() => {
    const el = document.activeElement;
    return { tag: el?.tagName ?? null, label: el?.getAttribute("aria-label") ?? null, row: Boolean(el?.hasAttribute("data-row")), entry: el?.closest("[data-entry-id]")?.dataset.entryId ?? null, expanded: el?.getAttribute("aria-expanded") ?? null };
  });

// =============================================================================================
// Settings: levels
// =============================================================================================

scenario("settings levels: a global value applies in every profile, a profile value only in its own profile", "main", withCleanup(async (t) => {
  const app = await launch(t);
  const first = await activeProfile(app);
  await openSettings(app);
  const nav = await settingsNav(app);
  const heads = nav.map((group) => group.head);
  assertEqual(heads.map((head) => head?.toLowerCase()), ["global", `profile · ${first.name}`.toLowerCase(), "help"], "group heads without a repository");
  assertEqual(nav[0].tabs.map((tab) => tab.label), ["Appearance", "Diff and editor", "External programs", "Custom commands", "Notifications", "AI"], "global sections");
  assertIncludes(nav[1].tabs.map((tab) => tab.label).join("|"), "Git behavior", "profile sections");
  t.step("dialog shows the levels Global and Profile, no project level without a repository");

  // Global: diff view "Side by side".
  await openSection(app, "Diff and editor");
  assertEqual((await activeSection(app)).scope, "Global · in all profiles", "scope pill of a global section");
  await chooseSegment(app, "Diff view", "split");
  await waitSetting(app, "diffMode", "split", "core: diffMode split");
  await eventually(async () => (await rowState(app, "Diff view"))?.changed, true, "row marked Changed · Reset");
  // Profile: default branch name.
  await openSection(app, "Git behavior");
  assertEqual((await activeSection(app)).scope, `Only in profile ${first.name}`, "scope pill of a profile section");
  await commitField(app, "Default branch name", "trunk");
  await waitSetting(app, "defaultBranchName", "trunk", "core: defaultBranchName trunk");
  t.step("global diff view and profile branch name changed");

  // Second profile, created in the dialog, then switched to.
  await openSection(app, "Profile and identity");
  await app.click({ text: "New profile", within: SETTINGS });
  await app.waitFor(async () => (await dialogTitle(app)) === "New profile", 8000, { message: "New profile dialog" });
  const nameField = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[role="dialog"]')].pop()?.querySelector("input") ?? null), 5000);
  await app.type(nameField, "Arbeit");
  await dialogButton(app, /^Create profile$/);
  await waitToast(app, "success", /Profile “Arbeit” created/);
  await app.click(`${SETTINGS} button[aria-label="Switch to profile Arbeit"]`);
  await waitToast(app, "success", /Arbeit/);
  await eventually(async () => (await activeProfile(app))?.name, "Arbeit", "core: profile Arbeit active");
  t.step("switched to the new profile Arbeit");

  // Global value stays, profile value is the default of the new profile.
  assertEqual((await settings(app)).diffMode, "split", "core: diffMode is global");
  assertEqual((await settings(app)).defaultBranchName, "main", "core: Arbeit has the default branch name");
  await openSection(app, "Git behavior");
  assertEqual((await activeSection(app)).scope, "Only in profile Arbeit", "scope pill names the new profile");
  await eventually(async () => (await rowState(app, "Default branch name"))?.input, "main", "UI: branch name field of Arbeit");
  await openSection(app, "Diff and editor");
  assertEqual(await segmentValue(app, "Diff view"), "split", "UI: diff view still Side by side");
  await openSection(app, "Git behavior");
  await closeToasts(app);
  await app.exec((css) => document.querySelector(css)?.scrollIntoView({ block: "center" }), rowCss("Default branch name"));
  await t.shot("settings-levels-profile");

  // And back: the first profile still has its own value.
  const back = (await profiles(app)).find((profile) => profile.name === first.name);
  await app.invoke("profile_activate", { id: back.id });
  await app.exec(() => window.__gc.queryClient.invalidateQueries());
  await eventually(async () => (await settings(app)).defaultBranchName, "trunk", "core: first profile keeps trunk");
  await eventually(async () => (await rowState(app, "Default branch name"))?.input, "trunk", "UI: field shows trunk again");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("profile identity is written to the global gitconfig only with the switch on", "edge", withCleanup(async (t) => {
  const app = await launch(t);
  const before = globalConfigValue(app, "name");
  await openSettings(app);
  await openSection(app, "Profile and identity");
  assertEqual((await activeSection(app)).scope?.startsWith("Only in profile"), true, "identity is a profile section");
  // Switch off: name changes in the profile, the gitconfig stays.
  const sync = await app.waitFor(`${rowCss("Write name and email to the global gitconfig")} button[role="switch"]`);
  if ((await sync.attr("aria-checked")) === "true") {
    await app.click(sync);
    await eventually(async () => (await activeProfile(app)).syncGitconfig, false, "core: sync off");
  }
  await commitField(app, "Author name", "Mira Feldmann");
  await eventually(async () => (await activeProfile(app)).authorName, "Mira Feldmann", "core: profile author name");
  assertEqual(globalConfigValue(app, "name"), before, "gitconfig untouched while the switch is off");
  // Switch on: name and email land in the global gitconfig.
  await app.click(sync);
  await eventually(async () => (await activeProfile(app)).syncGitconfig, true, "core: sync on");
  await eventually(() => globalConfigValue(app, "name"), "Mira Feldmann", "gitconfig user.name");
  await commitField(app, "Email", "mira@wetterstation.example");
  await eventually(() => globalConfigValue(app, "email"), "mira@wetterstation.example", "gitconfig user.email");
  // An invalid address is refused at the field and nothing is written.
  await commitField(app, "Email", "mira-ohne-at");
  await eventually(async () => (await rowState(app, "Email"))?.error, "This is not an email address – the @ or a part before or after it is missing.", "field error for the email");
  assertEqual((await activeProfile(app)).authorEmail, "mira@wetterstation.example", "core: email unchanged");
  assertEqual(globalConfigValue(app, "email"), "mira@wetterstation.example", "gitconfig email unchanged");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("project overrides the profile: author in .git/config, used by a commit; pull mode; reset inherits again", "main", withCleanup(async (t) => {
  const repo = repoFor(t, { localIdentity: false });
  const app = await launch(t);
  const profile = await activeProfile(app);
  const { repoId } = await app.openRepo(repo.path);
  await app.settle();
  assertEqual(localConfig(repo, "user.name"), null, "git: no local user.name at the start");

  await openSettings(app);
  const nav = await settingsNav(app);
  assertEqual(nav.map((group) => group.head)[2]?.toLowerCase(), "project · messnetz", "project group head names the repository");
  assertEqual(nav[2].tabs.map((tab) => tab.label), ["Identity and access", "Pull and fetch", "Files and hooks", "Ticket links", "AI and agents"], "project sections");
  await openSection(app, "Identity and access");
  assertEqual((await activeSection(app)).scope, `Only in messnetz · overrides ${profile.name}`, "project scope pill");
  const inherited = await rowState(app, "Author name");
  assertEqual(inherited.own, false, "author name inherited at first");
  assertIncludes(inherited.text, `From ${profile.name}:`, "inherited value names the profile");

  await app.click(`${rowCss("Author name")} [data-override]`);
  await eventually(async () => (await rowState(app, "Author name"))?.own, true, "row switches to own value");
  await commitField(app, "Author name", "Projekt Person");
  await eventually(() => localConfig(repo, "user.name"), "Projekt Person", "git: user.name in .git/config");
  await eventually(async () => (await settingsNav(app))[2].tabs[0].label, "Identity and access 1 overridden", "nav counts the override");
  t.step("author name overridden for the project");

  // Pull mode per project.
  await openSection(app, "Pull and fetch");
  await app.click(`${rowCss("Pull mode")} [data-override]`);
  await eventually(async () => (await app.invoke("repo_settings_get", { repoId })).defaultPullMode, profile ? (await settings(app)).defaultPullMode : "ff", "core: pull mode taken over from the profile");
  const select = await app.waitFor(`${rowCss("Pull mode")} button[role="combobox"]`);
  await app.click(select);
  const option = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[role="option"]')].find((el) => el.innerText.trim() === "Rebase") ?? null), 5000, { message: "option Rebase" });
  await app.click(option);
  await eventually(async () => (await app.invoke("repo_settings_get", { repoId })).defaultPullMode, "rebase", "core: project pull mode rebase");
  assertEqual((await settings(app)).defaultPullMode, "ff", "core: profile pull mode unchanged");
  await t.shot("settings-project-override");
  await closeSettings(app);

  // A commit from the app now carries the project author.
  const head = await commitInApp(app, repo, repoId, { file: "notizen/projekt.md", content: "Projektnotiz\n", summary: "Notiz mit Projektautor" });
  assertEqual(repo.git("log", "-1", "--format=%an", head), "Projekt Person", "git: commit author from the project setting");

  // Reset: inherited again, .git/config clean.
  await openSettings(app);
  await openSection(app, "Identity and access");
  await rowButton(app, "Author name", new RegExp(`^Reset to ${profile.name}$`));
  await eventually(() => localConfig(repo, "user.name"), null, "git: local user.name removed");
  await eventually(async () => (await rowState(app, "Author name"))?.own, false, "row inherits again");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("invalid values are refused at the field: project email, default branch name; nothing is written", "edge", withCleanup(async (t) => {
  const repo = repoFor(t, { localIdentity: false });
  const app = await launch(t);
  await app.openRepo(repo.path);
  await openSettings(app);
  await openSection(app, "Identity and access");
  await app.click(`${rowCss("Email")} [data-override]`);
  await eventually(async () => (await rowState(app, "Email"))?.own, true, "email row switches to an own value");
  // Overriding takes the profile's value over into .git/config; the invalid text must not replace it.
  const takenOver = await until(() => localConfig(repo, "user.email"), "git: the profile email is taken over into .git/config", 10_000);
  await commitField(app, "Email", "kein-at-zeichen");
  await eventually(async () => (await rowState(app, "Email"))?.error, "This is not an email address – the @ or a part before or after it is missing.", "field error at the project email");
  assertEqual((await rowState(app, "Email")).input, "kein-at-zeichen", "typed text stays in the field");
  assertEqual(localConfig(repo, "user.email"), takenOver, "git: user.email still the taken-over value");

  await openSection(app, "Git behavior");
  for (const [value, message] of [
    ["neuer zweig", "Branch names cannot contain spaces."],
    ["-start", "The name cannot start with “-”, “/” or “.” and cannot end with “/”, “.” or “.lock”."],
    ["a..b", "Not allowed: “..”, “@{” and the characters ~ ^ : ? * [ \\."],
    ["", "The name must not be empty."],
  ]) {
    await commitField(app, "Default branch name", value);
    await eventually(async () => (await rowState(app, "Default branch name"))?.error, message, `field error for "${value}"`);
  }
  assertEqual((await settings(app)).defaultBranchName, "main", "core: default branch name unchanged");
  await t.shot("settings-invalid-input");
  // Esc closes the dialog; the stored value is still valid afterwards.
  await app.press("Escape");
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), SETTINGS), 5000, { message: "Esc closes the settings" });
  assertEqual((await settings(app)).defaultBranchName, "main", "core: still main");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("settings search and keyboard: hits per section, no match, Ctrl+F, arrows, Esc clears then closes", "edge", withCleanup(async (t) => {
  const app = await launch(t);
  await openSettings(app, { via: "shortcut" });
  t.step("Ctrl+, opens the settings");
  const activeTab = () => app.exec(() => document.activeElement?.getAttribute("role") === "tab" ? document.activeElement.querySelector("span")?.textContent.trim() : null);
  await eventually(activeTab, "Git behavior", "focus on the active section (Git behavior via Ctrl+,)");
  await app.press("ArrowDown");
  await eventually(async () => (await activeSection(app)).label, "SSH keys", "ArrowDown selects the next section");
  await app.press("ArrowUp", "ArrowUp");
  await eventually(async () => (await activeSection(app)).label, "Profile and identity", "ArrowUp twice");

  await app.press("Control+f");
  await eventually(() => app.exec(() => document.activeElement?.getAttribute("aria-label")), "Search settings", "Ctrl+F focuses the search");
  await app.type(`${SETTINGS} input[type="search"]`, "font");
  await eventually(async () => (await activeSection(app)).label, "Diff and editor", "search jumps to the section with hits");
  const tails = await app.exec((css) => [...document.querySelectorAll(`${css} [role="tab"]`)].filter((tab) => tab.querySelector("span.text-accent")).map((tab) => tab.querySelector("span")?.textContent.trim()), SETTINGS);
  assertIncludes(tails, "Diff and editor", "hit counter at Diff and editor");
  assert(await app.exec((css) => Boolean(document.querySelector(`${css} [data-match]`)), SETTINGS), "matching row highlighted");
  await t.shot("settings-search");

  await app.press("Control+a");
  await app.type(`${SETTINGS} input[type="search"]`, "xyzzy-gibt-es-nicht");
  await sleep(200);
  const dimmed = await app.exec((css) => [...document.querySelectorAll(`${css} [role="tab"]`)].every((tab) => tab.className.includes("opacity-60")), SETTINGS);
  assert(dimmed, "every section dimmed when nothing matches");
  await app.press("Escape");
  await eventually(() => app.exec((css) => document.querySelector(`${css} input[type="search"]`)?.value ?? null, SETTINGS), "", "first Esc clears the search");
  assert(await app.$(SETTINGS), "dialog still open after the first Esc");
  await app.press("Escape");
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), SETTINGS), 5000, { message: "second Esc closes" });
  await t.noConsoleErrors(app);
}));

scenario("settings survive a restart; Reset returns a changed value to its default", "edge", withCleanup(async (t) => {
  const dataDir = persistentDataDir(t);
  const first = await launch(t, { dataDir });
  await openSettings(first);
  await openSection(first, "Diff and editor");
  await chooseSegment(first, "Diff view", "inline");
  await commitField(first, "Tab width", "8");
  await waitSetting(first, "diffMode", "inline");
  await waitSetting(first, "editorTabSize", 8);
  await openSection(first, "Git behavior");
  await commitField(first, "Default branch name", "entwicklung");
  await waitSetting(first, "defaultBranchName", "entwicklung");
  await first.close();
  t.step("values changed, app closed");

  const second = await launch(t, { dataDir, restart: true });
  const after = await settings(second);
  assertEqual([after.diffMode, after.editorTabSize, after.defaultBranchName], ["inline", 8, "entwicklung"], "core: values after the restart");
  await openSettings(second);
  await openSection(second, "Diff and editor");
  assertEqual(await segmentValue(second, "Diff view"), "inline", "UI: diff view after the restart");
  assertEqual((await rowState(second, "Tab width")).input, "8", "UI: tab width after the restart");
  // "Changed · Reset" brings back the default.
  assert((await rowState(second, "Tab width")).changed, "tab width marked as changed");
  await rowButton(second, "Tab width", /^Reset$/);
  await waitSetting(second, "editorTabSize", 4, "core: tab width back to 4");
  await eventually(async () => (await rowState(second, "Tab width"))?.changed, false, "Changed marker gone");
  await t.noConsoleErrors(second);
}));

// =============================================================================================
// Theme
// =============================================================================================

const rootTheme = (app) => app.exec(() => document.documentElement.dataset.theme ?? null);
const bodyBackground = (app) => app.exec(() => getComputedStyle(document.body).backgroundColor);
/** Relative luminance of a CSS rgb() colour, 0..1. */
function luminance(css) {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

scenario("theme light and dark in Appearance: applied at once, persisted across a restart", "main", withCleanup(async (t) => {
  const dataDir = persistentDataDir(t);
  // No ?theme= parameter: it would take precedence over the setting.
  const app = await launch(t, { theme: undefined, dataDir });
  await app.invoke("settings_set", { patch: { theme: "dark" } });
  await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["settings"] }));
  await eventually(() => rootTheme(app), "dark", "starts dark");
  const darkBg = await bodyBackground(app);
  await openSettings(app);
  await openSection(app, "Appearance");
  assertEqual((await activeSection(app)).scope, "Global · in all profiles", "theme is global");
  await chooseSegment(app, "Theme", "light");
  await eventually(() => rootTheme(app), "light", "html data-theme light");
  await waitSetting(app, "theme", "light", "core: theme light");
  const lightBg = await app.waitFor(async () => {
    const value = await bodyBackground(app);
    return value !== darkBg ? value : null;
  }, 5000, { message: "background changes" });
  assert(luminance(lightBg) > 0.8 && luminance(darkBg) < 0.3, `light background bright, dark background dark (${lightBg} / ${darkBg})`);
  await t.shot("theme-light");
  await chooseSegment(app, "Theme", "dark");
  await eventually(() => rootTheme(app), "dark", "back to dark");
  await waitSetting(app, "theme", "dark");
  await t.shot("theme-dark");
  await chooseSegment(app, "Theme", "light");
  await waitSetting(app, "theme", "light");
  await t.noConsoleErrors(app);
  await app.close();

  const again = await launch(t, { theme: undefined, dataDir, restart: true });
  await eventually(() => rootTheme(again), "light", "light after the restart");
  assert(luminance(await bodyBackground(again)) > 0.8, "light background after the restart");
  await t.noConsoleErrors(again);
}));

scenario("theme by keyboard and System: arrow keys switch, System follows the OS colour scheme", "edge", withCleanup(async (t) => {
  const app = await launch(t, { theme: undefined });
  await app.invoke("settings_set", { patch: { theme: "dark" } });
  await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["settings"] }));
  await openSettings(app);
  await openSection(app, "Appearance");
  const dark = await app.waitFor(`${SETTINGS} [role="radiogroup"][aria-label="Theme"] [data-value="dark"]`);
  await app.exec((el) => el.focus(), dark);
  await app.press("ArrowRight");
  await waitSetting(app, "theme", "light", "ArrowRight: Light");
  await eventually(() => rootTheme(app), "light", "applied light");
  await app.press("ArrowRight");
  await waitSetting(app, "theme", "system", "ArrowRight: System");
  await eventually(() => app.exec(() => document.activeElement?.dataset.value), "system", "focus follows the selection");
  // System: the theme is whatever the WebView reports as the OS colour scheme.
  const osLight = await app.exec(() => matchMedia("(prefers-color-scheme: light)").matches);
  await eventually(() => rootTheme(app), osLight ? "light" : "dark", "System follows prefers-color-scheme");
  t.step(`OS colour scheme on this display: ${osLight ? "light" : "dark"}`);
  await app.press("Home");
  await waitSetting(app, "theme", "dark", "Home: first option Dark");
  await app.press("End");
  await waitSetting(app, "theme", "system", "End: last option System");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Language
// =============================================================================================

const storedLanguage = (app) => app.exec(() => localStorage.getItem("forkyard.language"));
const statusTexts = (app) =>
  app.exec(() => [...document.querySelectorAll("button")].filter((b) => !b.closest('[role="dialog"]')).map((b) => b.innerText.trim()).filter(Boolean));

scenario("language: switch to Deutsch reloads the window in German, and back to English", "main", withCleanup(async (t) => {
  // No ?lang= parameter: it would force a language. The OS language is English.
  const app = await launch(t, { lang: undefined, env: { LANG: "en_US.UTF-8", LANGUAGE: "" } });
  assertIncludes(await statusTexts(app), "Settings", "English toolbar");
  await openSettings(app);
  await openSection(app, "Appearance");
  assertEqual(await segmentValue(app, LANGUAGE), "system", "language follows the system");
  await app.exec(() => (window.__beforeReload = true));
  await chooseSegment(app, LANGUAGE, "de");
  await app.waitFor(() => app.exec(() => !window.__beforeReload && document.querySelector("[data-shell]") !== null), 20_000, { message: "window reloaded" });
  await app.waitForShell();
  assertEqual(await storedLanguage(app), "de", "choice stored in the WebView");
  assertEqual(await app.exec(() => document.documentElement.lang || null) ?? "de", "de", "document language");
  await until(async () => (await statusTexts(app)).includes("Einstellungen"), "German toolbar");
  await openSettings(app, { via: "shortcut" }).catch(() => undefined);
  await app.waitFor(SETTINGS, 10_000);
  assertEqual(await app.exec((css) => document.querySelector(`${css} h2`)?.innerText.trim(), SETTINGS), "Einstellungen", "dialog title in German");
  await app.click(await app.waitFor(() => app.exec((css) => [...document.querySelectorAll(`${css} [role="tab"]`)].find((tab) => tab.querySelector("span")?.textContent.trim() === "Darstellung") ?? null, SETTINGS), 10_000, { message: "section Darstellung" }));
  await app.settle();
  assertEqual(await segmentValue(app, LANGUAGE), "de", "Deutsch selected");
  assertEqual((await activeSection(app)).scope, "Global · in allen Profilen", "scope pill in German");
  await t.shot("language-german");
  await t.noConsoleErrors(app);

  await app.exec(() => (window.__beforeReload = true));
  await chooseSegment(app, LANGUAGE, "en");
  await app.waitFor(() => app.exec(() => !window.__beforeReload && document.querySelector("[data-shell]") !== null), 20_000, { message: "window reloaded" });
  await app.waitForShell();
  assertEqual(await storedLanguage(app), "en", "English stored");
  await until(async () => (await statusTexts(app)).includes("Settings"), "English status line again");
  await t.noConsoleErrors(app);
}));

scenario("language System follows the OS (German), an explicit choice wins; choosing the same one does not reload", "edge", withCleanup(async (t) => {
  const app = await launch(t, { lang: undefined, env: { LANG: "de_DE.UTF-8", LANGUAGE: "" } });
  assertEqual(await app.exec(() => navigator.language), "de-DE", "WebView reports German");
  await until(async () => (await statusTexts(app)).includes("Einstellungen"), "German UI from the OS language");
  await openSettings(app, { via: "shortcut" });
  await app.click(await app.waitFor(() => app.exec((css) => [...document.querySelectorAll(`${css} [role="tab"]`)].find((tab) => tab.querySelector("span")?.textContent.trim() === "Darstellung") ?? null, SETTINGS), 10_000));
  await app.settle();
  assertEqual(await segmentValue(app, LANGUAGE), "system", "System selected");
  // Clicking the selected option again does nothing (no reload).
  await app.exec(() => (window.__beforeReload = true));
  await chooseSegment(app, LANGUAGE, "system");
  await sleep(800);
  assertEqual(await app.exec(() => window.__beforeReload === true), true, "no reload for the same choice");
  // English explicitly, although the OS is German.
  await chooseSegment(app, LANGUAGE, "en");
  await app.waitFor(() => app.exec(() => !window.__beforeReload && document.querySelector("[data-shell]") !== null), 20_000, { message: "window reloaded" });
  await app.waitForShell();
  await until(async () => (await statusTexts(app)).includes("Settings"), "English despite the German OS");
  assertEqual(await storedLanguage(app), "en", "explicit choice stored");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Undo / Redo
// =============================================================================================

scenario("undo and redo a commit from the toolbar: HEAD goes back and forward, the change stays staged", "main", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  const { repoId } = await app.openRepo(repo.path);
  await app.settle();
  const before = repo.git("rev-parse", "HEAD");
  await waitToolbar(app, "Undo", { disabled: true, hint: /^Nothing to undo$/ });
  await waitToolbar(app, "Redo", { disabled: true, hint: /^Nothing to redo$/ });

  const commit = await commitInApp(app, repo, repoId, { file: "notizen/messung.md", content: "Messung Nord: 12,4 °C\n", summary: "Messung Nord notiert" });
  assert(commit !== before, "git: commit created");
  const ready = await waitToolbar(app, "Undo", { disabled: false, hint: /^Undo: / });
  assertIncludes(ready.hint, "Messung Nord notiert", "undo hint names the commit");
  await app.click(ready.el);
  await waitToast(app, "success", /^Undone/);
  await eventually(() => repo.git("rev-parse", "HEAD"), before, "git: HEAD back at the parent");
  assertEqual(repo.git("status", "--porcelain"), "A  notizen/messung.md", "git: the change is staged again");
  assert(fs.existsSync(path.join(repo.path, "notizen/messung.md")), "file still in the working directory");
  const redo = await waitToolbar(app, "Redo", { disabled: false, hint: /^Redo: / });
  await t.shot("undo-commit-undone");
  await closeToasts(app);

  await app.click(redo.el);
  await waitToast(app, "success", /^Redone/);
  await eventually(() => repo.git("rev-parse", "HEAD"), commit, "git: HEAD on the same commit again");
  assertEqual(repo.git("status", "--porcelain"), "", "git: clean after redo");
  await waitToolbar(app, "Redo", { disabled: true, hint: /^Nothing to redo$/ });
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("Ctrl+Z / Ctrl+Y undo and redo a branch delete; the backup ref restores the same commit", "edge", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  const { repoId } = await app.openRepo(repo.path);
  await app.settle();
  const featureSha = repo.git("rev-parse", "feature/export");
  await app.invoke("branch_delete", { repoId, names: ["feature/export"], force: true });
  assertEqual(repo.git("branch", "--list", "feature/export"), "", "git: branch deleted");
  const backups = repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/forkyard/undo/");
  assertIncludes(backups, featureSha, "git: backup ref under refs/forkyard/undo/ points at the branch");
  await app.exec(() => window.__gc.queryClient.invalidateQueries());
  await waitToolbar(app, "Undo", { disabled: false, hint: /^Undo: / });

  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+z");
  await waitToast(app, "success", /^Undone/);
  await eventually(() => repo.git("rev-parse", "--verify", "-q", "feature/export"), featureSha, "git: branch back on the same commit");
  await closeToasts(app);
  await waitToolbar(app, "Redo", { disabled: false });
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+y");
  await waitToast(app, "success", /^Redone/);
  await eventually(() => repo.git("branch", "--list", "feature/export"), "", "git: deleted again by redo");
  await closeToasts(app);
  // Ctrl+Shift+Z is the alias for redo; the first Ctrl+Z restores it once more.
  await app.press("Control+z");
  await waitToast(app, "success", /^Undone/);
  await closeToasts(app);
  await app.press("Control+Shift+z");
  await waitToast(app, "success", /^Redone/);
  await eventually(() => repo.git("branch", "--list", "feature/export"), "", "git: Ctrl+Shift+Z redoes");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("nothing to undo: buttons disabled with the reason, Ctrl+Z only reports it, Git untouched", "edge", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  await app.openRepo(repo.path);
  await app.settle();
  const head = repo.git("rev-parse", "HEAD");
  const undo = await waitToolbar(app, "Undo", { disabled: true, hint: /^Nothing to undo$/ });
  await app.click(undo.el);
  await sleep(400);
  assertEqual(await toasts(app), [], "click on the disabled button does nothing");
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+z");
  await waitToast(app, "info", /^Nothing to undo/);
  await app.press("Control+y");
  await waitToast(app, "info", /^Nothing to redo/);
  assertEqual(repo.git("rev-parse", "HEAD"), head, "git: HEAD unchanged");
  assertEqual(repo.git("status", "--porcelain"), "", "git: clean");
  await t.noConsoleErrors(app);
}));

scenario("undo after a commit in the terminal: the stale entry is skipped (Nothing to undo), applies again once the repository is back", "edge", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  const { repoId } = await app.openRepo(repo.path);
  await app.settle();
  const appCommit = await commitInApp(app, repo, repoId, { file: "notizen/a.md", content: "A\n", summary: "Notiz A" });
  await waitToolbar(app, "Undo", { disabled: false, hint: /Notiz A/ });
  // Outside the app: another commit moves HEAD, the undo entry no longer fits.
  repo.write("notizen/b.md", "B aus dem Terminal\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Notiz B im Terminal");
  const external = repo.git("rev-parse", "HEAD");
  const blocked = await waitToolbar(app, "Undo", { disabled: true, hint: /^Nothing to undo$/ });
  t.step(`after the terminal commit: disabled, hint "${blocked.hint}"`);
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+z");
  await waitToast(app, "info", /^Nothing to undo/);
  await t.shot("undo-stale-skipped");
  assertEqual(repo.git("rev-parse", "HEAD"), external, "git: HEAD still on the terminal commit");
  assertEqual(repo.git("status", "--porcelain"), "", "git: nothing changed in the working directory");
  await closeToasts(app);
  // Back to the state of the entry (terminal again): the entry applies again.
  repo.git("reset", "-q", "--keep", appCommit);
  const again = await waitToolbar(app, "Undo", { disabled: false, hint: /Notiz A/ });
  await app.click(again.el);
  await waitToast(app, "success", /^Undone/);
  await eventually(() => repo.git("rev-parse", "HEAD"), repo.git("rev-parse", `${appCommit}~1`), "git: HEAD on the parent of the app commit");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("undo of a commit that is already pushed is blocked with the reason; HEAD stays", "edge", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  const { repoId } = await app.openRepo(repo.path);
  await app.settle();
  const commit = await commitInApp(app, repo, repoId, { file: "notizen/geteilt.md", content: "geteilt\n", summary: "Geteilte Notiz" });
  repo.git("push", "-q", "origin", "main");
  await app.exec(() => window.__gc.queryClient.invalidateQueries());
  await app.settle();
  const button = await toolbarButton(app, "Undo");
  t.step(`undo button after push: disabled=${button.disabled} hint=${button.hint}`);
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+z");
  const toast = await waitToast(app, null, /Cannot be undone locally|already on the remote|pushed/i);
  t.step(`refused: ${toast}`);
  assertEqual(repo.git("rev-parse", "HEAD"), commit, "git: HEAD unchanged");
  assertEqual(repo.git("rev-parse", "origin/main"), commit, "git: remote branch unchanged");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("undo of a discard would overwrite newer work: refused, then Stash and undo keeps both", "edge", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  const { repoId } = await app.openRepo(repo.path);
  await app.settle();
  const original = fs.readFileSync(path.join(repo.path, "README.md"), "utf8");
  repo.write("README.md", `${original}Verworfene Zeile\n`);
  await app.invoke("discard_paths", { repoId, paths: ["README.md"] });
  assertEqual(fs.readFileSync(path.join(repo.path, "README.md"), "utf8"), original, "discarded");
  repo.write("README.md", `${original}Neue Arbeit danach\n`);
  await app.exec(() => window.dispatchEvent(new Event("focus")));
  await app.exec(() => window.__gc.queryClient.invalidateQueries());
  await waitToolbar(app, "Undo", { disabled: false });
  await app.click((await toolbarButton(app, "Undo")).el);
  const toast = await waitToast(app, "warning", /Undo would overwrite newer work/);
  assertIncludes(toast, "README.md", "the warning names the file");
  assertEqual(fs.readFileSync(path.join(repo.path, "README.md"), "utf8"), `${original}Neue Arbeit danach\n`, "the newer work is untouched");
  await t.shot("undo-overwrite-refused");
  const action = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[data-toast="warning"] button')].find((el) => el.innerText.trim() === "Stash and undo") ?? null), 5000, { message: "Stash and undo" });
  await app.click(action);
  await waitToast(app, "success", /^Undone/);
  await eventually(() => fs.readFileSync(path.join(repo.path, "README.md"), "utf8"), `${original}Verworfene Zeile\n`, "the discarded change is back");
  const stashes = repo.git("stash", "list", "--format=%s");
  assertEqual(stashes.split("\n").filter(Boolean).length, 1, "git: exactly one stash");
  assertIncludes(repo.git("stash", "show", "-p", "stash@{0}"), "Neue Arbeit danach", "git: the newer work is in the stash");
  await t.noConsoleErrors(app);
}));

// =============================================================================================
// Activity log
// =============================================================================================

scenario("activity log: the commit of the app shows up in This repository, expands to its output, search finds it", "main", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  const { repoId } = await app.openRepo(repo.path);
  await app.settle();
  const head = await commitInApp(app, repo, repoId, { file: "notizen/log.md", content: "Logtest\n", summary: "Eintrag für das Protokoll" });
  await openLog(app);
  let state = await logState(app);
  assertEqual(state.tabs.map((tab) => tab.label), ["This repository messnetz", "App"], "tabs");
  assertEqual(state.tabs[0].active, true, "the repository tab is active");
  assert(state.rows.length > 0, "entries present");
  assertMatch(state.count, /^\d+ entr(y|ies)$/, "count line");
  const commitRow = state.rows.find((row) => /^git (-c \S+ )*commit\b/.test(row.command));
  assert(commitRow, `a git commit entry; commands: ${state.rows.slice(0, 15).map((row) => row.command).join(" | ")}`);
  assertEqual(commitRow.exit, "ok", "commit ended with exit code 0");

  const total = state.rows.length;
  // The search looks into command and output: the commit summary is only in the output.
  await logSearch(app, "Protokoll");
  state = await logState(app);
  assert(state.rows.some((row) => row.id === commitRow.id), `search keeps the commit entry; hits: ${state.rows.map((row) => row.command).join(" | ")}`);
  assert(state.rows.length < total, `search narrows the list (${state.rows.length} of ${total})`);
  assertMatch(state.count, /^\d+ of \d+ loaded$/, "filtered count");
  const row = await app.waitFor(`${LOG} [data-entry-id="${commitRow.id}"] [data-row]`);
  await app.click(row);
  await eventually(async () => (await logState(app)).rows.find((entry) => entry.id === commitRow.id)?.expanded, true, "row expanded");
  const output = (await logState(app)).rows.find((entry) => entry.id === commitRow.id).output;
  assertIncludes(output, head.slice(0, 7), "output contains the new commit's SHA");
  assertIncludes(output, "Eintrag für das Protokoll", "output contains the summary");
  await t.shot("activity-log-commit");

  // App tab: commands without a repository.
  await app.click(`${LOG} [role="tab"]:last-of-type`);
  await eventually(async () => (await logState(app)).tabs.find((tab) => tab.label === "App")?.active, true, "App tab active");
  assertEqual((await logState(app)).search, "", "switching tabs resets the search");
  await app.press("Escape");
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), LOG), 5000, { message: "Esc closes the log" });
  await t.noConsoleErrors(app);
}));

scenario("activity log: a failed fetch is listed with its exit code, Errors only filters, credentials are redacted", "edge", withCleanup(async (t) => {
  const repo = repoFor(t);
  const secret = "geheim-Passwort-4711";
  repo.git("remote", "set-url", "origin", `https://messnetz:${secret}@127.0.0.1:9/nirgendwo.git`);
  const app = await launch(t);
  await app.openRepo(repo.path);
  await app.settle();
  await runCommand(app, "Fetch", "sync.fetch");
  await waitToast(app, "danger", /./, 60_000);
  await closeToasts(app);
  await openLog(app, { via: "palette" });
  let state = await logState(app);
  const failed = state.rows.find((row) => /fetch/.test(row.command) && row.exit === "error");
  assert(failed, `a failed fetch entry; rows: ${state.rows.slice(0, 10).map((row) => `${row.command} [${row.badge}]`).join(" | ")}`);
  assertMatch(failed.badge, /^Error \d+$/, "exit code badge");
  assertMatch(state.onlyErrors, /^Errors only \(\d+\)$/, "Errors only names the count");

  await app.click({ text: state.onlyErrors, within: LOG });
  await eventually(async () => (await logState(app)).rows.every((row) => row.exit === "error"), true, "only failed entries");
  state = await logState(app);
  assert(state.rows.length >= 1, "at least the fetch remains");
  await app.click(`${LOG} [data-entry-id="${failed.id}"] [data-row]`);
  await eventually(async () => (await logState(app)).rows.find((row) => row.id === failed.id)?.expanded, true, "failed entry expanded");
  await t.shot("activity-log-errors");
  const text = await app.exec((css) => document.querySelector(css).innerText, LOG);
  assert(!text.includes(secret), "the password never appears in the log");
  const entries = await app.invoke("activity_list", { scope: "repo", repoId: (await app.exec(() => window.__gc.store.getState().activeTabId)) && (await app.invoke("repo_list", {}).catch(() => null))?.[0]?.id, cursor: null, limit: 500 }).catch(() => null);
  if (entries) assert(!JSON.stringify(entries).includes(secret), "core: no password in the stored entries");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("activity log without a repository and with no match: only the App tab, empty and no-match states, Reset filter", "edge", withCleanup(async (t) => {
  const app = await launch(t);
  await openLog(app);
  let state = await logState(app);
  assertEqual(state.tabs.map((tab) => tab.label), ["App"], "only the App tab without a repository");
  if (state.rows.length === 0) {
    assertEqual(state.state, "empty", "empty state");
    assertIncludes(state.stateText, "Nothing logged yet", "empty text");
    t.step("App log empty");
  } else t.step(`App log has ${state.rows.length} entries`);
  await logSearch(app, "zzz-nichts-passt");
  state = await logState(app);
  assertEqual(state.state, "no-match", "no-match state");
  assertEqual(state.rows.length, 0, "no rows while nothing matches");
  assertIncludes(state.stateText, "No entry matches", "no-match title");
  await t.shot("activity-log-no-match");
  await app.click({ text: "Reset filter", within: LOG });
  await eventually(async () => (await logState(app)).search, "", "Reset filter clears the search");
  // Esc in a non-empty search only clears it; the next Esc closes the log.
  await logSearch(app, "abc");
  await app.press("Escape");
  await eventually(async () => (await logState(app))?.search, "", "first Esc clears the search");
  await app.press("Escape");
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), LOG), 5000, { message: "second Esc closes" });
  await t.noConsoleErrors(app);
}));

scenario("activity log by keyboard: ArrowDown from the search, Enter/arrows expand and collapse, End/Home jump", "edge", withCleanup(async (t) => {
  const repo = repoFor(t);
  const app = await launch(t);
  await app.openRepo(repo.path);
  await app.settle();
  await openLog(app);
  await eventually(async () => (await focused(app)).label, "Search activity log", "focus starts in the search");
  const rows = (await logState(app)).rows;
  assert(rows.length >= 2, `at least two entries (${rows.length})`);
  await app.press("ArrowDown");
  await eventually(async () => (await focused(app)).entry, rows[0].id, "ArrowDown focuses the first entry");
  await app.press("Enter");
  await eventually(async () => (await focused(app)).expanded, "true", "Enter expands");
  await app.press("ArrowLeft");
  await eventually(async () => (await focused(app)).expanded, "false", "ArrowLeft collapses");
  await app.press("ArrowRight");
  await eventually(async () => (await focused(app)).expanded, "true", "ArrowRight expands");
  await app.press(" ");
  await eventually(async () => (await focused(app)).expanded, "false", "Space toggles");
  await app.press("ArrowDown");
  await eventually(async () => (await focused(app)).entry, rows[1].id, "ArrowDown to the second entry");
  await app.press("End");
  const all = (await logState(app)).rows;
  await eventually(async () => (await focused(app)).entry, all[all.length - 1].id, "End jumps to the last entry");
  await app.press("Home");
  await eventually(async () => (await focused(app)).entry, rows[0].id, "Home jumps to the first entry");
  await app.press("Escape");
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), LOG), 5000, { message: "Esc closes" });
  await t.noConsoleErrors(app);
}));
