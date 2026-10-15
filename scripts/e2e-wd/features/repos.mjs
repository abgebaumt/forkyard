/**
 * Repositories in the real app over WebDriver: open, clone, create, tabs, groups (local
 * workspaces), profiles and repository trust. Real Git repositories in temp folders; remotes are
 * local bare repositories or scripts/e2e/git-http-server.mjs. Results are checked in the UI AND
 * with git in the temp repositories.
 *
 *   node scripts/e2e-wd/features/repos.mjs
 *   E2E_WD_ONLY="clone:" node scripts/e2e-wd/features/repos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { TEST_IDENTITY, makeCleanRepoWithRemote, makeNotARepo } from "../../e2e/fixtures.mjs";
import { startGitHttpServer } from "../../e2e/git-http-server.mjs";
import { FSMONITOR_MARKER, HOOK_MARKER, PROXY_PASSWORD, makeCloneSource, makeDataDir, makeForeignRepo, makeWorkspace, ran, startHoldingProxy } from "../fixtures/repos.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };

// ---------------------------------------------------------------------------------------------
// Page helpers (WebDriver has no locators; everything goes through small functions in the page).

/** The form control whose <label> (or aria-label) is exactly `label`, inside `scope`. */
function field(app, scope, label) {
  return app.waitFor(
    () =>
      app.exec(
        (css, wanted) => {
          const root = document.querySelector(css);
          if (!root) return null;
          const norm = (value) => (value ?? "").replace(/\s+/g, " ").trim();
          for (const element of root.querySelectorAll("label")) {
            // A label may carry a hint after its text (checkboxes): compare its first text node too.
            if (norm(element.textContent) !== wanted && norm(element.firstChild?.textContent) !== wanted) continue;
            const control = element.control ?? (element.htmlFor ? document.getElementById(element.htmlFor) : null);
            if (control) return control;
          }
          return [...root.querySelectorAll("input, textarea, button, [role=combobox]")].find((element) => norm(element.getAttribute("aria-label")) === wanted) ?? null;
        },
        scope,
        label,
      ),
    10_000,
    { message: `field “${label}” in ${scope}` },
  );
}

/** Sets an input's value the way React notices (native setter + input event). */
function fill(app, element, value) {
  return app.exec(
    (input, text) => {
      input.focus();
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    element,
    value,
  );
}

const valueOf = (app, element) => app.exec((input) => input.value, element);
const invalidOf = (app, element) => app.exec((input) => input.getAttribute("aria-invalid"), element);
const errorOf = (app, element) => app.exec((input) => document.getElementById(input.getAttribute("aria-describedby")?.split(" ")[0] ?? "")?.textContent ?? null, element);
const dialogTitle = (app) => app.exec(() => [...document.querySelectorAll('[role="dialog"]')].at(-1)?.querySelector("h2")?.textContent ?? null);
const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((toast) => toast.innerText.replace(/\s+/g, " ").trim()));
const focusedText = (app) => app.exec(() => document.activeElement?.textContent?.replace(/\s+/g, " ").trim() ?? null);
/** Tabs as the strip shows them, in order. */
const uiTabs = (app) =>
  app.exec(() =>
    [...document.querySelectorAll("[data-tab-id]")].map((item) => {
      const tab = item.querySelector('[role="tab"]');
      return { id: item.getAttribute("data-tab-id"), title: tab?.querySelector(".truncate")?.textContent ?? "", active: tab?.getAttribute("aria-selected") === "true" };
    }),
  );
/** Tabs as the core keeps them, in order (management tab titled "Repositories"). */
const coreTabs = async (app) =>
  (await app.invoke("tabs_list")).sort((a, b) => a.position - b.position).map((tab) => ({ title: tab.kind === "management" ? "Repositories" : tab.title, active: tab.isActive }));
const strip = async (app) => (await uiTabs(app)).map((tab) => `${tab.active ? "*" : ""}${tab.title}`);
const core = async (app) => (await coreTabs(app)).map((tab) => `${tab.active ? "*" : ""}${tab.title}`);
/** Waits until strip and core both show this order (`*` marks the active tab). */
async function expectTabs(app, wanted, message) {
  await app.waitFor(async () => JSON.stringify(await strip(app)) === JSON.stringify(wanted), 15_000, { message: `${message}: strip ${JSON.stringify(wanted)}` }).catch(async (error) => {
    throw new Error(`${error.message}; got ${JSON.stringify(await strip(app))}`);
  });
  assertEqual(await core(app), wanted, `${message} (tabs_list)`);
}

const management = (app) => app.waitFor('[data-screen="repo-management"]', 15_000);
/** Button inside repository management by its visible text. */
const mgmtButton = (app, text) => app.waitFor(() => app.byText(text, { within: '[data-screen="repo-management"]' }), 10_000, { message: `button “${text}”` });
const repoList = (app) => app.invoke("repo_list");
const findRepo = async (app, repoPath) => (await repoList(app)).find((repo) => path.resolve(repo.path) === path.resolve(repoPath)) ?? null;
const exists = (...parts) => fs.existsSync(path.join(...parts));
/** Opens the context menu of an element (as a right click does). */
const contextMenu = (app, element) =>
  app.exec((target) => {
    const box = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + box.height / 2, button: 2 }));
    return true;
  }, element);
/** A menu item in any open menu (submenus included) whose text starts with `text` (or equals it). */
const menuItem = (app, text, exact = false) =>
  app.waitFor(
    () =>
      app.exec(
        (wanted, isExact) => {
          const norm = (value) => (value ?? "").replace(/\s+/g, " ").trim();
          const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')].filter((item) => item.getBoundingClientRect().width > 0);
          return items.find((item) => (isExact ? norm(item.innerText) === wanted : norm(item.innerText).startsWith(wanted))) ?? null;
        },
        text,
        exact,
      ),
    10_000,
    { message: `menu item “${text}”` },
  );
async function closeToasts(app) {
  for (let round = 0; round < 10; round++) {
    const button = await app.byText("Close message");
    if (!button) return;
    await app.click(button).catch(() => undefined);
    await sleep(120);
  }
}
/** Shows a management tab (Ctrl+T if the active tab is a repository). */
async function toManagement(app) {
  if (!(await app.$('[data-screen="repo-management"]'))) {
    await app.press("Control+t");
    await management(app);
  }
  await app.settle();
}
const refreshRepos = (app) => app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] }).then(() => true));
const git = (ws, cwd, ...args) => ws.git(cwd, ...args);
const gitOr = (ws, cwd, fallback, ...args) => {
  try {
    return ws.git(cwd, ...args);
  } catch {
    return fallback;
  }
};

/**
 * Starts the app again on an existing data directory. `app.close()` ends the previous run cleanly
 * (SIGTERM, the app's quit path), so there is no crash report and no crash prompt to dismiss.
 */
async function relaunch(t, options) {
  const app = await t.launch(options);
  assertEqual(await app.invoke("crash_reports_list"), [], "the previous run ended cleanly: no crash report");
  return app;
}

// =============================================================================================
// Open
// =============================================================================================

scenario("open: “Open …” with the folder dialog opens the repository in the tab", "main", async (t) => {
  const ws = makeWorkspace("wd-open");
  try {
    const repo = ws.repo("wetterstation", { "README.md": "# Wetterstation\n", "src/messung.py": "print(1)\n" });
    ws.commit(repo, "src/messung.py", "print(2)\n", "Messung angepasst");
    const app = await t.launch(LAUNCH);
    await app.waitFor('[data-screen="repo-management"][data-state="empty"]');
    t.step("empty start: repository management with three entry points");
    await app.pick(repo);
    await app.click(await mgmtButton(app, "Open …"));
    await expectTabs(app, ["*wetterstation"], "the management tab became the repository tab");
    await app.waitFor(async () => (await app.$$('[data-row-kind="commit"]')).length >= 2, 20_000, { message: "two commit rows" });
    await app.settle();
    const entry = await findRepo(app, repo);
    assert(entry && entry.lastOpenedAt, "the core lists the repository with a timestamp");
    assertEqual(entry.trusted, true, "an ordinary repository is trusted right away");
    assert(!(await app.$('[data-shell="untrusted"]')), "no trust prompt");
    const summary = await app.exec(() => document.querySelector('[data-row-kind="commit"]')?.innerText ?? "");
    assertIncludes(summary, git(ws, repo, "log", "-1", "--format=%s"), "the newest commit (git log) is the first row");
    assertEqual(await toasts(app), [], "no toast");
    await t.shot("open-repository");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("open: a folder without repository offers “Create a repository here”", "edge", async (t) => {
  const ws = makeWorkspace("wd-open-init");
  const plain = makeNotARepo();
  try {
    const app = await t.launch(LAUNCH);
    // 1. Non-empty folder: the offer appears, but the core refuses to create a repository there.
    await app.pick(plain.path);
    await app.click(await mgmtButton(app, "Open …"));
    const notice = await app.waitFor('[data-notice="not_a_repo"]');
    assertIncludes(await notice.text(), "“kein-repository” is not a Git repository", "notice names the folder");
    assertIncludes(await notice.text(), plain.path, "notice shows the full path");
    await t.shot("open-not-a-repository");
    await app.click(await app.waitFor(() => app.byText("Create a repository here", { within: '[data-notice="not_a_repo"]' })));
    await app.waitFor('[data-screen="init"]');
    const name = await field(app, '[data-screen="init"]', "Name");
    assertEqual(await valueOf(app, name), "kein-repository", "name is prefilled");
    assertEqual(await valueOf(app, await field(app, '[data-screen="init"]', "Location")), plain.root, "location is prefilled");
    await app.click(await app.waitFor(() => app.byText("Create repository", { within: '[role="dialog"]' })));
    await app.waitFor(async () => (await invalidOf(app, name)) === "true", 15_000, { message: "a non-empty folder is rejected at the name" });
    assertMatch(await errorOf(app, name), /non-empty folder/, "the message explains it");
    assert(!exists(plain.path, ".git"), "no .git was created");
    assert(exists(plain.path, "einkaufsliste.txt"), "the existing files are untouched");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="init"]')), 5000, { message: "init dialog closed" });

    // 2. Empty folder: offer → init → created exactly there and opened.
    const empty = ws.dir("neues-vorhaben");
    await app.pick(empty);
    await app.click(await mgmtButton(app, "Open …"));
    await app.click(await app.waitFor(() => app.byText("Create a repository here", { within: '[data-notice="not_a_repo"]' })));
    await app.waitFor('[data-screen="init"]');
    assertEqual(await valueOf(app, await field(app, '[data-screen="init"]', "Name")), "neues-vorhaben", "name of the empty folder");
    await app.press("Enter");
    await expectTabs(app, ["*neues-vorhaben"], "the new repository is open");
    assert(exists(empty, ".git"), ".git is in the chosen folder");
    assertEqual(git(ws, empty, "rev-list", "--count", "HEAD"), "1", "git: one first commit");
    assertEqual(git(ws, empty, "ls-files"), "README.md", "git: README.md is committed");
    await t.noConsoleErrors(app);
  } finally {
    plain.cleanup();
    ws.cleanup();
  }
});

scenario("open: a missing folder shows a notice, a cancelled folder dialog does nothing", "edge", async (t) => {
  const ws = makeWorkspace("wd-open-missing");
  try {
    const app = await t.launch(LAUNCH);
    const missing = ws.at("gibt-es-nicht");
    await app.pick(missing);
    await app.click(await mgmtButton(app, "Open …"));
    const notice = await app.waitFor('[data-notice="path_not_found"]');
    assertIncludes(await notice.text(), missing, "the notice names the path");
    assert(await app.byText("Choose another folder …", { within: '[data-notice="path_not_found"]' }), "offer “Choose another folder …”");
    assertEqual(await toasts(app), [], "no toast");
    await app.click(await app.waitFor(() => app.byText("Dismiss notice", { within: '[data-notice="path_not_found"]' })));
    await app.waitFor(async () => !(await app.$('[data-notice="path_not_found"]')), 5000, { message: "notice dismissed" });
    // Folder dialog cancelled (null): nothing happens.
    await app.pick(null);
    await app.click(await mgmtButton(app, "Open …"));
    await sleep(500);
    await app.settle();
    assertEqual(await core(app), ["*Repositories"], "still only repository management");
    assertEqual(await repoList(app), [], "nothing was added");
    assert(!(await app.$("[data-notice]")), "no notice");
    // Keyboard: Alt+O opens the folder dialog too.
    const repo = ws.repo("tastatur");
    await app.pick(repo);
    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Alt+o");
    await expectTabs(app, ["*tastatur"], "Alt+O opens the repository");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

// =============================================================================================
// Clone
// =============================================================================================

const CLONE = '[data-screen="clone"]';
async function openClone(app) {
  await toManagement(app);
  await app.click(await mgmtButton(app, "Clone …"));
  await app.waitFor(CLONE);
  await app.settle();
}
const cloneButton = (app) => app.waitFor(() => app.byText("Clone", { within: '[role="dialog"]' }), 10_000, { message: "button “Clone”" });

scenario("clone: a local bare repository through the dialog", "main", async (t) => {
  const ws = makeWorkspace("wd-clone");
  try {
    const src = makeCloneSource(ws);
    const target = ws.dir("Ziel");
    const app = await t.launch(LAUNCH);
    await openClone(app);
    assertEqual(await dialogTitle(app), "Clone repository", "dialog title");
    const address = await field(app, CLONE, "Address");
    assertEqual(await app.exec(() => document.activeElement?.closest('[data-screen="clone"]') !== null && document.activeElement?.tagName === "INPUT"), true, "focus is in the address");
    await app.type(address, src.source);
    await app.waitFor(async () => (await app.exec(() => document.querySelector("[data-url-kind]")?.getAttribute("data-url-kind"))) === "local", 5000, { message: "address detected as local folder" });
    assertEqual(await valueOf(app, await field(app, CLONE, "Folder name")), "wetterdaten", "folder name suggested from the address");
    await fill(app, await field(app, CLONE, "Target folder"), target);
    await app.waitFor(async () => (await app.exec(() => document.querySelector("[data-clone-target]")?.innerText.replace(/\s+/g, " ") ?? "")).includes(path.join(target, "wetterdaten")), 5000, { message: "target preview" });
    await t.shot("clone-dialog");
    // Enter in the folder name submits.
    await app.click(await field(app, CLONE, "Folder name"));
    await app.press("End", "Enter");
    await expectTabs(app, ["*wetterdaten"], "the clone opens in the tab");
    await app.waitFor(async () => !(await app.$(CLONE)), 10_000, { message: "dialog closed" });
    const cloned = path.join(target, "wetterdaten");
    assertEqual(Number(git(ws, cloned, "rev-list", "--count", "HEAD")), src.count, "git: all commits are there");
    assertEqual(git(ws, cloned, "rev-parse", "HEAD"), src.head, "git: HEAD = main of the source");
    assertEqual(git(ws, cloned, "rev-parse", "--abbrev-ref", "HEAD"), "main", "git: main is checked out");
    assertEqual(path.resolve(git(ws, cloned, "remote", "get-url", "origin")), path.resolve(src.source), "git: origin points to the source");
    assertIncludes(git(ws, cloned, "branch", "-r"), "origin/entwicklung", "git: the second branch is known as remote branch");
    assert(exists(cloned, "src", "pruefen.py"), "the files are checked out");
    const entry = await findRepo(app, cloned);
    assert(entry, "the core lists the clone");
    assertEqual(entry.trusted, true, "a clone made by the app is trusted");
    await app.waitFor(async () => (await toasts(app)).some((text) => text.includes("“wetterdaten” has been cloned")), 10_000, { message: "success message" });
    await app.waitFor(async () => (await app.$$('[data-row-kind="commit"]')).length >= 4, 20_000, { message: "graph of the clone" });
    await t.shot("clone-done");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("clone: validation and errors stay in the dialog, nothing is left on disk", "edge", async (t) => {
  const ws = makeWorkspace("wd-clone-err");
  try {
    const src = makeCloneSource(ws);
    const target = ws.dir("Ziel");
    const app = await t.launch(LAUNCH);
    await openClone(app);
    // Empty submit: three required fields marked, nothing started.
    await app.click(await cloneButton(app));
    // The form re-renders its fields; look them up each time.
    const F = { address: () => field(app, CLONE, "Address"), folder: () => field(app, CLONE, "Target folder"), name: () => field(app, CLONE, "Folder name") };
    const inv = async (key) => invalidOf(app, await F[key]());
    const err = async (key) => errorOf(app, await F[key]());
    const set = async (key, value) => fill(app, await F[key](), value);
    await app.waitFor(async () => (await inv("address")) === "true" && (await inv("folder")) === "true" && (await inv("name")) === "true", 5000, { message: "all three required fields marked" });
    assertEqual(await app.exec(() => document.querySelector('[data-screen="clone"]').getAttribute("data-state")), "form", "nothing was started");
    // Odd inputs while typing.
    for (const [url, reason] of [
      ["ext::sh -c boese", /“::” aren't supported/],
      ["-upload-pack=boese", /doesn't start with “-”/],
      ["https://host/mit leerzeichen.git", /doesn't contain spaces/],
    ]) {
      await set("address", url);
      assertEqual(await inv("address"), "true", `invalid address ${url}`);
      assertMatch(await err("address"), reason, `reason for ${url}`);
    }
    // Target taken.
    const taken = path.join(target, "belegt");
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, "notiz.txt"), "bleibt liegen\n");
    await set("address", src.source);
    await set("folder", target);
    await set("name", "belegt");
    await app.click(await cloneButton(app));
    const banner = await app.waitFor("[data-clone-error]", 30_000);
    assertEqual(await banner.attr("data-clone-error"), "path_exists", "code path_exists");
    assertIncludes(await banner.text(), "The target is already taken", "understandable sentence");
    assertEqual(await inv("name"), "true", "the error is shown at the folder name");
    assertEqual(fs.readdirSync(taken), ["notiz.txt"], "the taken folder is untouched");
    assertEqual(await toasts(app), [], "no toast – the error is in the dialog");
    await t.shot("clone-error-target-taken");
    // Source missing.
    await set("address", ws.at("gibt-es-nicht.git"));
    await set("name", "aus-dem-nichts");
    await app.click(await cloneButton(app));
    await app.waitFor(async () => (await app.exec(() => document.querySelector("[data-clone-error]")?.getAttribute("data-clone-error"))) === "not_found", 30_000, { message: "code not_found" });
    assertIncludes(await app.exec(() => document.querySelector("[data-clone-error]").innerText), "There is no repository at this address", "understandable sentence");
    assert(!exists(target, "aus-dem-nichts"), "no folder was created");
    // Server not reachable (closed local port).
    await set("address", "http://127.0.0.1:9/kein-server.git");
    await app.click(await cloneButton(app));
    await app.waitFor(async () => (await app.exec(() => document.querySelector("[data-clone-error]")?.getAttribute("data-clone-error"))) === "offline", 60_000, { message: "code offline" });
    assert(!exists(target, "aus-dem-nichts"), "no folder after the failed connection");
    // Esc closes, nothing was added.
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$(CLONE)), 5000, { message: "dialog closed with Esc" });
    assertEqual(await repoList(app), [], "the core added nothing");
    assertEqual(fs.readdirSync(target).sort(), ["belegt"], "only the folder that was there before");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("clone: over HTTP with sign-in (cancel, then username and password)", "main", async (t) => {
  const ws = makeWorkspace("wd-clone-http");
  const server = await startGitHttpServer({ users: { lena: "geheim-123" } });
  try {
    const src = makeCloneSource(ws, "messnetz");
    server.createBare("messnetz.git", { from: src.work });
    const url = server.url("messnetz.git");
    const target = ws.dir("Ziel");
    const app = await t.launch(LAUNCH);
    await openClone(app);
    await fill(app, await field(app, CLONE, "Address"), url);
    await fill(app, await field(app, CLONE, "Target folder"), target);
    await fill(app, await field(app, CLONE, "Folder name"), "messnetz");
    await app.click(await cloneButton(app));
    await app.waitFor(async () => (await dialogTitle(app)) === "Username for the remote", 60_000, { message: "username prompt" });
    t.step("username prompt appeared");
    // Focus lands in the prompt before Radix makes it the top layer (a frame later the dialog below
    // gets pointer-events: none); a key sent in between goes to the clone dialog. Wait for both.
    const inPrompt = () =>
      app.waitFor(
        () =>
          app.exec(() => {
            const dialogs = [...document.querySelectorAll('[role="dialog"]')];
            const prompt = dialogs.at(-1);
            const below = dialogs.slice(0, -1);
            return Boolean(prompt?.contains(document.activeElement) && document.activeElement?.tagName === "INPUT" && prompt.style.pointerEvents !== "none" && below.every((dialog) => dialog.style.pointerEvents === "none"));
          }),
        10_000,
        { message: "focus in the prompt's input, prompt on top" },
      );
    await inPrompt();
    // Cancel at the prompt: the clone stops, no folder, the inputs stay.
    await app.press("Escape");
    await app.waitFor("[data-clone-cancelled]", 30_000);
    assert(!exists(target, "messnetz"), "no folder after the cancelled sign-in");
    assertEqual(await valueOf(app, await field(app, CLONE, "Address")), url, "the address is still there");
    // Now sign in.
    await app.click(await cloneButton(app));
    await app.waitFor(async () => (await dialogTitle(app)) === "Username for the remote", 60_000, { message: "username prompt again" });
    await inPrompt();
    await app.press(..."lena".split(""), "Enter");
    await app.waitFor(async () => (await dialogTitle(app)) === "Sign in to the remote", 60_000, { message: "password prompt" });
    await inPrompt();
    await app.press(..."geheim-123".split(""));
    await t.shot("clone-http-sign-in");
    await app.press("Enter");
    await expectTabs(app, ["*messnetz"], "the clone over HTTP opens");
    const cloned = path.join(target, "messnetz");
    assertEqual(git(ws, cloned, "rev-parse", "HEAD"), src.head, "git: HEAD = main on the server");
    assertEqual(git(ws, cloned, "remote", "get-url", "origin"), url, "git: origin is the address without credentials");
    assert(!fs.readFileSync(path.join(cloned, ".git", "config"), "utf8").includes("geheim-123"), "the password is not in .git/config");
    assert(server.requests.some((entry) => entry.user === "lena"), "the server saw the sign-in");
    await t.noConsoleErrors(app);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

scenario("clone: cancelling a running clone removes the half-finished folder", "edge", async (t) => {
  const ws = makeWorkspace("wd-clone-cancel");
  const server = await startGitHttpServer({ users: { lena: "geheim-123" } });
  // Signs in by itself and holds the pack transfer, so the clone keeps running until cancelled.
  const proxy = await startHoldingProxy(server.url(""), { user: "lena", password: "geheim-123", holdMs: 60_000 });
  try {
    const src = makeCloneSource(ws, "langsam");
    server.createBare("langsam.git", { from: src.work });
    const target = ws.dir("Ziel");
    const app = await t.launch(LAUNCH);
    await openClone(app);
    await fill(app, await field(app, CLONE, "Address"), proxy.url("langsam.git"));
    await fill(app, await field(app, CLONE, "Target folder"), target);
    await fill(app, await field(app, CLONE, "Folder name"), "langsam-kopie");
    await app.click(await cloneButton(app));
    await app.waitFor("[data-clone-progress]", 30_000);
    await app.waitFor(async () => proxy.held > 0, 30_000, { message: "the transfer reached the proxy" });
    assertEqual(await app.exec(() => document.querySelector('[data-screen="clone"]').getAttribute("data-state")), "running", "the dialog shows the running clone");
    const dir = path.join(target, "langsam-kopie");
    assert(fs.existsSync(dir), "git has created the target folder already");
    await t.shot("clone-progress");
    // Esc asks first; "Keep cloning" has focus and keeps it running.
    await app.press("Escape");
    await app.waitFor(() => app.byText("The clone is still running", { exact: false, within: '[role="dialog"]' }), 10_000, { message: "confirmation" });
    await app.waitFor(async () => (await focusedText(app)) === "Keep cloning", 5000, { message: "focus on “Keep cloning”" });
    await t.shot("clone-cancel-question");
    await app.press("Enter");
    await app.waitFor(async () => !(await app.byText("The clone is still running", { exact: false, within: '[role="dialog"]' })), 5000, { message: "confirmation closed" });
    assertEqual(await app.exec(() => document.querySelector('[data-screen="clone"]').getAttribute("data-state")), "running", "“Keep cloning” keeps it running");
    // Cancel: back to the form, inputs kept, folder gone.
    await app.click(await app.waitFor(() => app.byText("Cancel clone", { within: '[role="dialog"]' })));
    await app.waitFor("[data-clone-cancelled]", 30_000);
    assertIncludes(await app.exec(() => document.querySelector("[data-clone-cancelled]").innerText), "The incomplete folder was removed again", "the message says so");
    await app.waitFor(async () => !fs.existsSync(dir), 15_000, { message: "half-finished folder removed" });
    assertEqual(await valueOf(app, await field(app, CLONE, "Folder name")), "langsam-kopie", "the inputs stay");
    assertEqual(await findRepo(app, dir), null, "the core added nothing");
    assertEqual(await toasts(app), [], "a cancel is not an error message");
    assertEqual(await app.exec(() => Object.keys(window.__gc.store.getState().jobs).length), 0, "no job left in the status bar");
    await t.noConsoleErrors(app);
  } finally {
    await proxy.close();
    await server.close();
    ws.cleanup();
  }
});

// =============================================================================================
// Create (init)
// =============================================================================================

const INIT = '[data-screen="init"]';
async function openInit(app) {
  await toManagement(app);
  await app.click(await mgmtButton(app, "Create new …"));
  await app.waitFor(INIT);
  await app.settle();
}
async function chooseOption(app, combobox, option) {
  await app.click(combobox);
  await app.waitFor('[role="listbox"]', 5000);
  await app.click(await app.waitFor(() => app.byText(option, { within: '[role="listbox"]' }), 5000, { message: `option ${option}` }));
  await app.waitFor(async () => (await app.exec((box) => box.innerText.trim(), combobox)) === option, 5000, { message: `${option} selected` });
}

scenario("init: create a repository with .gitignore template, license and README", "main", async (t) => {
  const ws = makeWorkspace("wd-init");
  try {
    const place = ws.dir("Neu");
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { defaultBranchName: "trunk" } });
    await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }).then(() => true));
    await openInit(app);
    assertEqual(await dialogTitle(app), "Create new repository", "title");
    await app.waitFor(async () => (await valueOf(app, await field(app, INIT, "Default branch"))) === "trunk", 5000, { message: "default branch from the settings" });
    await app.type(await field(app, INIT, "Name"), "wetter-auswertung");
    await fill(app, await field(app, INIT, "Location"), place);
    await chooseOption(app, await field(app, INIT, ".gitignore template"), "Python");
    await chooseOption(app, await field(app, INIT, "License"), "MIT License");
    assertEqual((await app.exec(() => document.querySelector("[data-init-target]")?.innerText ?? "")).replace(/\s+/g, " "), `Will be created in: ${path.join(place, "wetter-auswertung")}`, "path preview");
    await t.shot("init-dialog");
    await app.click(await app.waitFor(() => app.byText("Create repository", { within: '[role="dialog"]' })));
    await expectTabs(app, ["*wetter-auswertung"], "the new repository opens");
    const repo = path.join(place, "wetter-auswertung");
    assertEqual(fs.readdirSync(repo).sort(), [".git", ".gitignore", "LICENSE", "README.md"], "exactly these files");
    assertEqual(git(ws, repo, "rev-parse", "--abbrev-ref", "HEAD"), "trunk", "git: branch from the settings");
    assertEqual(git(ws, repo, "log", "--format=%s|%an", "HEAD"), "Initial commit|Lena Hartmann", "git: one first commit by the profile's author");
    assertEqual(git(ws, repo, "ls-files").split("\n").sort(), [".gitignore", "LICENSE", "README.md"], "git: all three files committed");
    assertEqual(git(ws, repo, "status", "--porcelain"), "", "git: nothing uncommitted");
    assertMatch(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /__pycache__/, ".gitignore is the Python template");
    assertMatch(fs.readFileSync(path.join(repo, "LICENSE"), "utf8"), /MIT License[\s\S]*Lena Hartmann/, "MIT license with the author");
    assertEqual((await findRepo(app, repo))?.trusted, true, "a repository created by the app is trusted");
    await app.waitFor(async () => (await app.$$('[data-row-kind="commit"]')).length >= 1, 20_000, { message: "graph shows the first commit" });
    await t.shot("init-done");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("init: without README no commit; taken target, invalid names and branch are rejected", "edge", async (t) => {
  const ws = makeWorkspace("wd-init-err");
  try {
    const place = ws.dir("Neu");
    const app = await t.launch(LAUNCH);
    await openInit(app);
    const name = await field(app, INIT, "Name");
    await fill(app, name, "ganz-leer");
    await fill(app, await field(app, INIT, "Location"), place);
    await app.click(await field(app, INIT, "Create README.md"));
    assertIncludes(await app.exec(() => document.querySelector("[data-init-note]")?.innerText ?? ""), "with no first commit", "the dialog says beforehand that there is no commit");
    await app.click(await app.waitFor(() => app.byText("Create repository", { within: '[role="dialog"]' })));
    await expectTabs(app, ["*ganz-leer"], "the empty repository opens");
    const empty = path.join(place, "ganz-leer");
    assertEqual(fs.readdirSync(empty), [".git"], "only .git");
    assertEqual(gitOr(ws, empty, "0", "rev-list", "--count", "--all"), "0", "git: no commit");
    assertEqual(git(ws, empty, "symbolic-ref", "--short", "HEAD"), "main", "git: unborn main");
    await closeToasts(app);

    await openInit(app);
    const name2 = await field(app, INIT, "Name");
    assertEqual(await valueOf(app, await field(app, INIT, "Location")), place, "the location is remembered");
    // Taken target.
    const taken = ws.dir("Neu", "belegt");
    fs.writeFileSync(path.join(taken, "notiz.txt"), "bleibt\n");
    await fill(app, name2, "belegt");
    await app.click(await app.waitFor(() => app.byText("Create repository", { within: '[role="dialog"]' })));
    await app.waitFor(async () => (await invalidOf(app, name2)) === "true", 15_000, { message: "target taken: error at the name" });
    assertMatch(await errorOf(app, name2), /non-empty folder/, "understandable sentence");
    assertEqual(fs.readdirSync(taken), ["notiz.txt"], "the folder is untouched");
    // Known repository at the target, odd names.
    await fill(app, name2, "ganz-leer");
    assertMatch(await errorOf(app, name2), /is already there/, "a known repository is reported while typing");
    for (const [value, reason] of [
      ["a|b", /“\|”/],
      ["ende ", /period or a space/],
      ["..", /aren't folder names|folder name/],
    ]) {
      await fill(app, name2, value);
      assertMatch(await errorOf(app, name2), reason, `name “${value}”`);
    }
    // Branch names.
    await fill(app, name2, "irgendwas");
    const branch = await field(app, INIT, "Default branch");
    await fill(app, branch, "a..b");
    assertMatch(await errorOf(app, branch), /“\.\.”/, "branch “a..b”");
    await fill(app, branch, "ok/aber.lock/x");
    await app.click(await app.waitFor(() => app.byText("Create repository", { within: '[role="dialog"]' })));
    await app.waitFor(async () => (await invalidOf(app, branch)) === "true", 15_000, { message: "the core rejects “ok/aber.lock/x”" });
    await t.shot("init-error-branch");
    assert(!exists(place, "irgendwas"), "no half-finished folder");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$(INIT)), 5000, { message: "dialog closed" });
    assertEqual((await repoList(app)).map((repo) => repo.name), ["ganz-leer"], "only the one created repository is listed");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

// =============================================================================================
// Tabs
// =============================================================================================

scenario("tabs: Ctrl+T, switch with Ctrl+1…9 / Ctrl+Tab / click, close with Ctrl+W", "main", async (t) => {
  const ws = makeWorkspace("wd-tabs");
  try {
    const [nord, sued, hafen] = ["station-nord", "station-sued", "station-hafen"].map((name) => ws.repo(name));
    fs.writeFileSync(path.join(nord, "offen.txt"), "nicht committet\n");
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    await app.pick(nord);
    await app.click(await mgmtButton(app, "Open …"));
    await expectTabs(app, ["*station-nord"], "first repository in the management tab");
    await app.press("Control+t");
    await expectTabs(app, ["station-nord", "*Repositories"], "Ctrl+T opens repository management in a new tab");
    await app.pick(sued);
    await app.click(await mgmtButton(app, "Open …"));
    await app.click(await app.waitFor(() => app.byText("New tab")));
    await expectTabs(app, ["station-nord", "station-sued", "*Repositories"], "the plus button opens a new tab");
    await app.pick(hafen);
    await app.press("Alt+o");
    await expectTabs(app, ["station-nord", "station-sued", "*station-hafen"], "three repositories in three tabs");
    const title = await app.exec(() => document.querySelector('[role="tab"][title]')?.getAttribute("title"));
    assertEqual(title, nord, "the tooltip of a tab is the full path");
    await app.waitFor(() => app.exec(() => document.querySelector('[role="tab"]')?.textContent?.includes("uncommitted changes") ?? false), 15_000, { message: "the tab of the dirty repository carries the marker" });
    await t.shot("tabs-three-repositories");

    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Control+1");
    await expectTabs(app, ["*station-nord", "station-sued", "station-hafen"], "Ctrl+1");
    await app.press("Control+9");
    await expectTabs(app, ["station-nord", "station-sued", "*station-hafen"], "Ctrl+9 = last tab");
    await app.press("Control+Tab");
    await expectTabs(app, ["*station-nord", "station-sued", "station-hafen"], "Ctrl+Tab wraps around");
    // Ctrl+Shift+Tab is not checked here: WebKitWebDriver delivers Shift+Tab as key "Unidentified"
    // (ISO_Left_Tab), so the shortcut never sees "Tab" – a limitation of the synthetic keyboard.
    await app.press("Control+Tab");
    await expectTabs(app, ["station-nord", "*station-sued", "station-hafen"], "Ctrl+Tab again: next tab");
    await app.press("Control+3");
    await expectTabs(app, ["station-nord", "station-sued", "*station-hafen"], "Ctrl+3");
    await app.click(await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes("station-sued")))));
    await expectTabs(app, ["station-nord", "*station-sued", "station-hafen"], "click activates");
    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Control+w");
    await expectTabs(app, ["station-nord", "*station-hafen"], "Ctrl+W closes the active tab");
    assert(await findRepo(app, sued), "a closed tab keeps the repository in the list");
    await app.press("Control+w");
    await app.press("Control+w");
    await expectTabs(app, ["*Repositories"], "closing the last tab leaves repository management");
    assertEqual((await repoList(app)).length, 3, "all three repositories stay in the list");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("tabs: the same repository again activates its tab; tabs come back after a restart", "edge", async (t) => {
  const ws = makeWorkspace("wd-tabs-restart");
  const dataDir = makeDataDir();
  try {
    const [nord, sued] = ["station-nord", "station-sued"].map((name) => ws.repo(name));
    let app = await t.launch({ ...LAUNCH, dataDir });
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    await app.openRepo(nord);
    await app.press("Control+t");
    await management(app);
    await app.openRepo(sued);
    await expectTabs(app, ["station-nord", "*station-sued"], "two tabs");
    // Opening the first one again: no second tab.
    await app.press("Control+t");
    await management(app);
    await app.pick(nord);
    await app.click(await mgmtButton(app, "Open …"));
    // The existing tab becomes active; the management tab it was opened from stays (as on Windows).
    await expectTabs(app, ["*station-nord", "station-sued", "Repositories"], "no duplicate, the existing tab is active");
    const repoTabs = (await app.invoke("tabs_list")).filter((tab) => tab.repoId).map((tab) => tab.repoId);
    assertEqual(new Set(repoTabs).size, repoTabs.length, "no repository sits in two tabs");
    await app.press("Control+3");
    await app.press("Control+w");
    await expectTabs(app, ["station-nord", "*station-sued"], "management tab closed, its neighbour is active");
    await app.close();

    app = await relaunch(t, { ...LAUNCH, dataDir });
    await expectTabs(app, ["station-nord", "*station-sued"], "after the restart tabs, order and active tab are back");
    await app.waitFor(async () => (await app.$$('[data-row-kind="commit"]')).length >= 1, 20_000, { message: "the active tab shows its graph" });
    // Without "Remember tabs" the app starts with repository management.
    await app.invoke("settings_set", { patch: { rememberTabs: false } });
    await app.close();
    app = await relaunch(t, { ...LAUNCH, dataDir });
    await expectTabs(app, ["*Repositories"], "without “Remember tabs” only repository management");
    assertEqual((await repoList(app)).map((repo) => repo.name).sort(), ["station-nord", "station-sued"], "the repositories stay in the list");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// =============================================================================================
// Groups (local workspaces)
// =============================================================================================

async function addRepos(app, paths) {
  const ids = [];
  for (const repoPath of paths) {
    const opened = await app.invoke("repo_open", { path: repoPath });
    await app.invoke("tab_close", { tabId: opened.tab.id });
    ids.push(opened.repo.id);
  }
  const tabs = await app.invoke("tabs_list");
  if (!tabs.some((tab) => tab.kind === "management")) await app.invoke("tab_open", { repoId: null });
  await management(app);
  await refreshRepos(app);
  await app.settle();
  return ids;
}
const syncRows = (app) =>
  app.exec(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-group-sync] li")].map((item) => {
        const [name, text] = [...item.querySelectorAll(":scope > span:nth-child(2) > span")].map((part) => part.textContent.trim());
        return [name, { status: item.getAttribute("data-status"), text }];
      }),
    ),
  );

scenario("groups: assign a group, arrange by groups, “Fetch group” updates every repository", "main", async (t) => {
  const repos = ["station-nord", "station-sued", "station-hafen"].map((name) => makeCleanRepoWithRemote({ name }));
  try {
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    const ids = await addRepos(app, repos.map((repo) => repo.path));
    // Assign via the context menu of the row.
    const row = await app.waitFor(`[data-repo-scroll] [data-repo-id="${ids[0]}"]`);
    await contextMenu(app, row);
    await app.click(await menuItem(app, "Assign group …"));
    await app.waitFor(async () => (await dialogTitle(app)) === "Group for “station-nord”", 5000, { message: "group dialog" });
    await app.press(..."Messnetz".split(""), "Enter");
    await app.waitFor(async () => (await repoList(app)).find((repo) => repo.id === ids[0])?.groupName === "Messnetz", 5000, { message: "group in the core" });
    // The second one picks the existing group in the same dialog.
    await contextMenu(app, await app.waitFor(`[data-repo-scroll] [data-repo-id="${ids[1]}"]`));
    await app.click(await menuItem(app, "Assign group …"));
    await app.waitFor(async () => (await dialogTitle(app)) === "Group for “station-sued”", 5000, { message: "group dialog 2" });
    await app.press(..."Messnetz".split(""), "Enter");
    await app.invoke("repo_update", { repoId: ids[2], groupName: "Messnetz" });
    await refreshRepos(app);
    await app.click(await app.waitFor(() => app.byText("Groups", { within: '[aria-label="List arrangement"]' })));
    await app.waitFor(async () => JSON.stringify(await app.exec(() => [...document.querySelectorAll("[data-repo-section]")].map((item) => item.textContent.trim()))) === JSON.stringify(["Messnetz3"]), 5000, { message: "one group with three repositories" });
    await t.shot("groups-arranged");

    // New commits on two remotes.
    const nordSha = repos[0].commitOnRemote({ message: "Nord: neuer Sensor", file: "docs/sensor.md" });
    const hafenSha = repos[2].commitOnRemote({ message: "Hafen: Pegel", file: "docs/pegel.md" });
    const heads = repos.map((repo) => repo.git("rev-parse", "HEAD"));
    await app.click(await app.waitFor(() => app.byText("Fetch group “Messnetz”")));
    await app.waitFor("[data-group-sync]", 10_000);
    await app.waitFor(async () => (await app.exec(() => document.querySelector("[data-group-sync]")?.getAttribute("data-running"))) === null, 60_000, { message: "the run is over" });
    const rows = await syncRows(app);
    assertEqual(rows["station-nord"]?.status, "done", "nord: fetched");
    assertEqual(rows["station-hafen"]?.status, "done", "hafen: fetched");
    assertEqual(rows["station-sued"]?.status, "unchanged", "sued: nothing new");
    assertEqual(await app.exec(() => document.querySelector("[data-group-sync-summary]")?.innerText.trim()), "2 with new changes · 1 unchanged", "summary");
    assertEqual(repos[0].git("rev-parse", "origin/main"), nordSha, "git: origin/main of nord is up to date");
    assertEqual(repos[2].git("rev-parse", "origin/main"), hafenSha, "git: origin/main of hafen is up to date");
    assertEqual(repos.map((repo) => repo.git("rev-parse", "HEAD")), heads, "git: fetch changed no HEAD");
    await t.shot("groups-fetch-result");
    await app.click(await app.waitFor("[data-group-sync-close]"));
    await app.waitFor(async () => !(await app.$("[data-group-sync]")), 5000, { message: "dialog closed" });
    await t.noConsoleErrors(app);
  } finally {
    for (const repo of repos) repo.cleanup();
  }
});

scenario("groups: an unreachable remote and a missing folder fail per row, the rest goes on", "edge", async (t) => {
  const ws = makeWorkspace("wd-groups-err");
  const repos = ["station-ost", "station-west"].map((name) => makeCleanRepoWithRemote({ name }));
  try {
    const verzogen = ws.repo("verzogen");
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    const ids = await addRepos(app, [...repos.map((repo) => repo.path), verzogen]);
    for (const id of ids) await app.invoke("repo_update", { repoId: id, groupName: "Feld" });
    repos[1].git("remote", "set-url", "origin", "http://127.0.0.1:9/west.git");
    fs.renameSync(verzogen, `${verzogen}-woanders`);
    const ostSha = repos[0].commitOnRemote({ message: "Ost: Logger", file: "docs/logger.md" });
    await refreshRepos(app);
    await app.click(await app.waitFor(() => app.byText("Groups", { within: '[aria-label="List arrangement"]' })));
    await app.click(await app.waitFor(() => app.byText("Fetch group “Feld”")));
    await app.waitFor("[data-group-sync]", 10_000);
    await app.waitFor(async () => (await app.exec(() => document.querySelector("[data-group-sync]")?.getAttribute("data-running"))) === null, 60_000, { message: "the run is over" });
    const rows = await syncRows(app);
    assertEqual(rows["station-ost"]?.status, "done", "ost: fetched despite the failures");
    assertEqual(rows["station-west"]?.status, "failed", "west: failed");
    assertMatch(rows["station-west"]?.text, /can’t be reached|reach/, "west: reason in plain words");
    assertEqual(rows["verzogen"]?.status, "failed", "missing folder: failed");
    assertMatch(rows["verzogen"]?.text, /Folder not found/, "missing folder: reason");
    assertEqual(repos[0].git("rev-parse", "origin/main"), ostSha, "git: ost is up to date");
    assert(await app.byText(/^Retry 2 repositories$/.source, { regex: true, within: '[role="dialog"]' }), "“Retry” for the two failed ones");
    await t.shot("groups-fetch-failures");
    await app.click(await app.waitFor("[data-group-sync-close]"));
    // Dissolve the group via the context menu: the repositories stay, without group.
    await contextMenu(app, await app.waitFor(`[data-repo-scroll] [data-repo-id="${ids[0]}"]`));
    await app.click(await menuItem(app, "Group “Feld”"));
    await app.click(await menuItem(app, "Dissolve group"));
    if (await app.waitFor(async () => (await dialogTitle(app)) !== null, 3000).catch(() => false)) {
      await app.click(await app.waitFor(() => app.byText(/^Dissolve/.source, { regex: true, within: '[role="dialog"] footer, [role="dialog"]' })));
    }
    await app.waitFor(async () => (await repoList(app)).every((repo) => repo.groupName === null), 10_000, { message: "group dissolved in the core" });
    assertEqual((await repoList(app)).length, 3, "all repositories stay in the list");
    await t.noConsoleErrors(app);
  } finally {
    for (const repo of repos) repo.cleanup();
    ws.cleanup();
  }
});

// =============================================================================================
// Profiles
// =============================================================================================

const PREFS = '[role="dialog"]';
async function openProfiles(app) {
  await app.click(await app.waitFor("[data-profile-chip]"));
  await app.click(await menuItem(app, "Manage profiles …", true));
  await app.waitFor(() => app.byText("Profile and identity"), 10_000, { message: "profiles section" });
}
async function createProfile(app, { name, author, email }) {
  await app.click(await app.waitFor(() => app.byText("New profile", { within: PREFS })));
  await app.waitFor(async () => (await dialogTitle(app)) === "New profile", 5000, { message: "new profile dialog" });
  const scope = '[role="dialog"]:last-of-type';
  await fill(app, await field(app, scope, "Profile name"), name);
  await fill(app, await field(app, scope, "Author name"), author);
  await fill(app, await field(app, scope, "Email"), email);
  await app.click(await app.waitFor(() => app.byText("Create profile", { within: scope })));
}
async function switchViaChip(app, name) {
  await app.click(await app.waitFor("[data-profile-chip]"));
  await app.click(await menuItem(app, name));
  await app.waitFor(async () => (await app.invoke("profile_list")).find((profile) => profile.isActive)?.name === name, 10_000, { message: `profile ${name} active` });
  await app.waitFor(async () => (await app.exec(() => document.querySelector("[data-profile-chip]")?.innerText.trim())) === name, 10_000, { message: "chip shows the profile" });
}

scenario("profiles: create a profile in the settings, switch with the chip, each profile keeps its tabs", "main", async (t) => {
  const ws = makeWorkspace("wd-profiles");
  try {
    const privat = ws.repo("privat-notizen");
    const arbeit = ws.repo("firmen-projekt");
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    await app.openRepo(privat);
    await openProfiles(app);
    await createProfile(app, { name: "Arbeit", author: "Lena Hartmann (Firma)", email: "lena@firma.example" });
    await app.waitFor(async () => (await app.invoke("profile_list")).some((profile) => profile.name === "Arbeit"), 10_000, { message: "profile created" });
    await app.waitFor('[data-profile="Arbeit"]', 5000);
    const created = (await app.invoke("profile_list")).find((profile) => profile.name === "Arbeit");
    assertEqual([created.authorName, created.authorEmail, created.isActive], ["Lena Hartmann (Firma)", "lena@firma.example", false], "profile_list: identity stored, not active yet");
    await t.shot("profiles-list");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[role="dialog"]')), 5000, { message: "settings closed" });

    await switchViaChip(app, "Arbeit");
    await app.waitFor(async () => (await toasts(app)).some((text) => text.includes("Profile “Arbeit” is active")), 5000, { message: "switch confirmed by a toast" });
    await expectTabs(app, ["*Repositories"], "the new profile starts with its own (empty) tabs");
    assertEqual(await repoList(app), [], "the new profile lists no repositories");
    await app.pick(arbeit);
    await app.click(await mgmtButton(app, "Open …"));
    await expectTabs(app, ["*firmen-projekt"], "repository opened in profile Arbeit");
    await t.shot("profiles-switched");

    // Back: the old profile's tab is back, each profile lists only its own repository.
    await switchViaChip(app, "Default");
    await expectTabs(app, ["*privat-notizen"], "switching back restores the tabs of Default");
    assertEqual((await repoList(app)).map((repo) => repo.name), ["privat-notizen"], "Default lists only its repository");
    await switchViaChip(app, "Arbeit");
    await expectTabs(app, ["*firmen-projekt"], "and Arbeit gets its tab back");
    // Command palette: “New profile …” leads to the same dialog.
    await app.press("Control+p");
    await app.waitFor('[role="dialog"] input', 5000);
    await app.press(..."new profile".split(""));
    await app.waitFor(() => app.byText(/^New profile/.source, { regex: true, within: '[role="dialog"] [role="listbox"], [role="dialog"]' }), 5000, { message: "palette entry" });
    await app.press("Enter");
    await app.waitFor(async () => (await dialogTitle(app)) === "New profile", 10_000, { message: "palette opens the new-profile dialog" });
    await app.press("Escape");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

/** Repository without a local user.name/user.email, so the global identity (or the profile's) applies. */
function repoWithoutIdentity(ws, name) {
  const dir = ws.repo(name);
  ws.git(dir, "config", "--unset", "user.name");
  ws.git(dir, "config", "--unset", "user.email");
  return dir;
}
const commitAll = (app, repoId, summary) =>
  app.invoke("commit_create", { repoId, opId: `wd-${Date.now()}`, summary, description: "", amend: false, skipHooks: true, pushAfter: false, stageAll: true, expectedHead: null });

scenario("profiles: with “Write name and email to the global gitconfig” commits get the profile identity", "edge", async (t) => {
  const ws = makeWorkspace("wd-profiles-sync");
  try {
    const repo = repoWithoutIdentity(ws, "firmen-projekt");
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    await app.invoke("profile_save", { id: null, name: "Arbeit", authorName: "Lena Firma", authorEmail: "lena@firma.example", syncGitconfig: false, color: null });
    await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "profiles"] }).then(() => true));
    await switchViaChip(app, "Arbeit");
    await openProfiles(app);
    const toggle = await field(app, '[role="dialog"]', "Write name and email to the global gitconfig");
    assertEqual(await toggle.attr("aria-checked"), "false", "off for a new profile");
    await app.click(toggle);
    await app.waitFor(async () => (await app.invoke("profile_list")).find((profile) => profile.name === "Arbeit")?.syncGitconfig === true, 10_000, { message: "sync stored" });
    const globalValue = (key) => gitOr(ws, ws.root, "", "config", "--file", app.gitConfigPath, "--get", key);
    await app.waitFor(async () => globalValue("user.email") === "lena@firma.example", 10_000, { message: "the global gitconfig gets the profile identity" });
    assertEqual(globalValue("user.name"), "Lena Firma", "git config --global user.name");
    await t.shot("profiles-sync-gitconfig");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[role="dialog"]')), 5000, { message: "settings closed" });
    const { repoId } = await app.openRepo(repo);
    fs.writeFileSync(path.join(repo, "plan.md"), "# Plan\n");
    await commitAll(app, repoId, "Plan angelegt");
    assertEqual(git(ws, repo, "log", "-1", "--format=%an <%ae>|%s"), "Lena Firma <lena@firma.example>|Plan angelegt", "git: the commit carries the identity of profile Arbeit");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("profiles: after a switch commits are authored by the profile the toast names", "edge", async (t) => {
  // Without gitconfig sync Git keeps its own identity: the switch toast must not promise the
  // profile's author, and the commit carries the global gitconfig identity. With sync on the
  // toast names the profile's author and the commit carries it. A new profile created in the
  // dialog takes over the active profile's sync setting.
  const ws = makeWorkspace("wd-profiles-author");
  try {
    const repo = repoWithoutIdentity(ws, "firmen-projekt");
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    await app.invoke("profile_save", { id: null, name: "Arbeit", authorName: "Lena Firma", authorEmail: "lena@firma.example", syncGitconfig: false, color: null });
    await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "profiles"] }).then(() => true));
    await switchViaChip(app, "Arbeit");
    const toast = await app.waitFor(async () => (await toasts(app)).find((text) => text.includes("Profile “Arbeit” is active")), 5000, { message: "switch toast" });
    t.step(`toast: ${toast}`);
    assert(!toast.includes("Commits are now authored by"), `without sync the toast promises no author: ${toast}`);
    await t.shot("profiles-switch-toast");
    const { repoId } = await app.openRepo(repo);
    fs.writeFileSync(path.join(repo, "plan.md"), "# Plan\n");
    await commitAll(app, repoId, "Plan angelegt");
    const author = git(ws, repo, "log", "-1", "--format=%an <%ae>");
    t.step(`git log author: ${author}`);
    assertEqual(author, `${TEST_IDENTITY.name} <${TEST_IDENTITY.email}>`, "git: without sync the commit carries the global gitconfig identity");

    // Sync on: a new profile from the dialog inherits it, and its switch toast names the author.
    const arbeit = (await app.invoke("profile_list")).find((profile) => profile.name === "Arbeit");
    await app.invoke("profile_save", { id: arbeit.id, name: "Arbeit", authorName: "Lena Firma", authorEmail: "lena@firma.example", syncGitconfig: true, color: null });
    await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "profiles"] }).then(() => true));
    await openProfiles(app);
    await createProfile(app, { name: "Kunde", author: "Lena Kunde", email: "lena@kunde.example" });
    await app.waitFor(async () => (await app.invoke("profile_list")).some((profile) => profile.name === "Kunde"), 10_000, { message: "profile Kunde created" });
    const kunde = (await app.invoke("profile_list")).find((profile) => profile.name === "Kunde");
    assertEqual(kunde.syncGitconfig, true, "the new profile takes over the active profile's gitconfig sync");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[role="dialog"]')), 5000, { message: "settings closed" });
    await switchViaChip(app, "Kunde");
    const synced = await app.waitFor(async () => (await toasts(app)).find((text) => text.includes("Profile “Kunde” is active")), 5000, { message: "switch toast Kunde" });
    assertIncludes(synced, "Commits are now authored by Lena Kunde", "with sync the toast names the profile's author");
    // Each profile has its own repo list: Kunde gets its own repository.
    const kundenRepo = repoWithoutIdentity(ws, "kunden-projekt");
    const { repoId: again } = await app.openRepo(kundenRepo);
    fs.writeFileSync(path.join(kundenRepo, "plan.md"), "# Plan\n\nmehr\n");
    await commitAll(app, again, "Plan erweitert");
    assertEqual(git(ws, kundenRepo, "log", "-1", "--format=%an <%ae>"), "Lena Kunde <lena@kunde.example>", "git: with sync the commit carries the profile named in the toast");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("profiles: a repository of another profile asks “Also open in …” or “Switch to …”", "edge", async (t) => {
  const ws = makeWorkspace("wd-profiles-other");
  try {
    const eins = ws.repo("gemeinsam-eins");
    const zwei = ws.repo("gemeinsam-zwei");
    const app = await t.launch(LAUNCH);
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    await app.openRepo(eins);
    await app.press("Control+t");
    await management(app);
    await app.openRepo(zwei);
    await app.invoke("profile_save", { id: null, name: "Arbeit", authorName: "Lena Firma", authorEmail: "lena@firma.example", syncGitconfig: false, color: null });
    await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "profiles"] }).then(() => true));
    await switchViaChip(app, "Arbeit");
    await expectTabs(app, ["*Repositories"], "profile Arbeit starts empty");

    // 1. “Also open in “Arbeit””: listed in both profiles.
    await app.pick(eins);
    await app.click(await mgmtButton(app, "Open …"));
    await app.waitFor(async () => (await dialogTitle(app)) === "“gemeinsam-eins” belongs to the profile “Default”", 10_000, { message: "question about the other profile" });
    assertEqual(await focusedText(app).then((text) => text?.startsWith("Switch to “Default”")), true, "focus on the first option");
    await t.shot("profiles-other-profile-question");
    await app.click(await app.waitFor(() => app.byText("Also open in “Arbeit”", { within: '[role="dialog"]' })));
    await expectTabs(app, ["*gemeinsam-eins"], "opened in profile Arbeit");
    assertEqual((await repoList(app)).map((repo) => repo.name), ["gemeinsam-eins"], "now listed in Arbeit");
    assertEqual((await app.invoke("repo_profiles", { path: eins })).map((profile) => profile.name), ["Default"], "and still in Default");

    // 2. Cancel: nothing happens.
    await app.press("Control+t");
    await management(app);
    await app.pick(zwei);
    await app.click(await mgmtButton(app, "Open …"));
    await app.waitFor(async () => (await dialogTitle(app))?.includes("gemeinsam-zwei"), 10_000, { message: "question for zwei" });
    await app.press("Escape");
    await app.waitFor(async () => (await dialogTitle(app)) === null, 5000, { message: "question closed" });
    assertEqual((await repoList(app)).map((repo) => repo.name), ["gemeinsam-eins"], "cancel adds nothing");
    assertEqual((await app.invoke("profile_list")).find((profile) => profile.isActive).name, "Arbeit", "cancel stays in the profile");
    assertEqual(await toasts(app), [], "cancel shows no error");

    // 3. “Switch to “Default””: the profile changes and the repository opens there.
    await app.pick(zwei);
    await app.click(await mgmtButton(app, "Open …"));
    await app.waitFor(async () => (await dialogTitle(app))?.includes("gemeinsam-zwei"), 10_000, { message: "question for zwei again" });
    await app.click(await app.waitFor(() => app.byText(/^Switch to “Default”/.source, { regex: true, within: '[role="dialog"]' })));
    await app.waitFor(async () => (await app.invoke("profile_list")).find((profile) => profile.isActive)?.name === "Default", 10_000, { message: "switched to Default" });
    await app.waitFor(async () => (await core(app)).includes("*gemeinsam-zwei"), 10_000, { message: "zwei active in Default" });
    assertEqual((await repoList(app)).map((repo) => repo.name).sort(), ["gemeinsam-eins", "gemeinsam-zwei"], "Default lists both");
    await t.noConsoleErrors(app);
  } finally {
    ws.cleanup();
  }
});

scenario("profiles: empty name and invalid email are rejected; the active profile cannot be deleted", "edge", async (t) => {
  const app = await t.launch(LAUNCH);
  await openProfiles(app);
  await app.click(await app.waitFor(() => app.byText("New profile", { within: PREFS })));
  await app.waitFor(async () => (await dialogTitle(app)) === "New profile", 5000, { message: "new profile dialog" });
  const scope = '[role="dialog"]:last-of-type';
  await app.click(await app.waitFor(() => app.byText("Create profile", { within: scope })));
  const name = await field(app, scope, "Profile name");
  await app.waitFor(async () => (await invalidOf(app, name)) === "true", 5000, { message: "empty name marked" });
  assertEqual(await errorOf(app, name), "Give the profile a name.", "message for the empty name");
  await fill(app, name, "Default");
  const email = await field(app, scope, "Email");
  await fill(app, email, "kein-at-zeichen");
  await app.click(await app.waitFor(() => app.byText("Create profile", { within: scope })));
  await app.waitFor(async () => (await invalidOf(app, email)) === "true", 5000, { message: "invalid email marked" });
  await fill(app, email, "lena@zweit.example");
  await app.click(await app.waitFor(() => app.byText("Create profile", { within: scope })));
  await app.waitFor(async () => (await invalidOf(app, name)) === "true", 10_000, { message: "a duplicate name is rejected by the core" });
  t.step(`duplicate name: ${await errorOf(app, name)}`);
  await t.shot("profiles-new-errors");
  await fill(app, name, "Zweitprofil");
  await app.click(await app.waitFor(() => app.byText("Create profile", { within: scope })));
  await app.waitFor('[data-profile="Zweitprofil"]', 10_000);
  assertEqual((await app.invoke("profile_list")).map((profile) => profile.name).sort(), ["Default", "Zweitprofil"], "two profiles");
  // The active profile cannot be deleted.
  const blocked = await app.exec(() => {
    const button = document.querySelector('[data-profile="Default"] button[aria-label="Delete profile Default"]');
    return button ? { disabled: button.disabled || button.getAttribute("aria-disabled") === "true" } : null;
  });
  assert(blocked, "delete button of the active profile exists");
  await app.click(await app.$('[data-profile="Default"] button[aria-label="Delete profile Default"]'));
  await sleep(400);
  assert((await dialogTitle(app)) !== "Delete profile “Default”?", "no delete confirmation for the active profile");
  assertEqual((await app.invoke("profile_list")).length, 2, "nothing deleted");
  // Delete the other one, with confirmation.
  await app.click(await app.$('[data-profile="Zweitprofil"] button[aria-label="Delete profile Zweitprofil"]'));
  await app.waitFor(async () => (await dialogTitle(app)) === "Delete profile “Zweitprofil”?", 5000, { message: "delete confirmation" });
  await app.click(await app.waitFor(() => app.byText("Delete profile", { within: '[role="dialog"]:last-of-type' })));
  await app.waitFor(async () => (await app.invoke("profile_list")).length === 1, 10_000, { message: "profile deleted" });
  await t.noConsoleErrors(app);
});

// =============================================================================================
// Repository trust
// =============================================================================================

const GATE = '[data-shell="untrusted"]';

scenario("trust: a foreign repository stays locked until “Trust and open”", "main", async (t) => {
  const foreign = makeForeignRepo("fremdes-archiv");
  try {
    const app = await t.launch({ ...LAUNCH, trustOpened: false });
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    assert(!ran(foreign, FSMONITOR_MARKER), "precondition: nothing ran");
    await app.pick(foreign.path);
    await app.click(await mgmtButton(app, "Open …"));
    const gate = await app.waitFor(GATE, 15_000);
    await app.settle();
    assertEqual(await app.exec(() => document.querySelector('[data-shell="untrusted"] h1')?.textContent), "“fremdes-archiv” brings its own commands", "the prompt names the repository");
    await app.waitFor(async () => (await gate.$$("li")).length === 4, 10_000, { message: "four findings" });
    const text = await gate.text();
    for (const expected of ["core.fsmonitor", `touch ${FSMONITOR_MARKER};:`, "http.proxy", "http.sslverify", "Hook post-checkout", "None of it has run so far"]) assertIncludes(text, expected, "the prompt lists");
    assert(!(await app.exec(() => document.documentElement.outerHTML)).includes(PROXY_PASSWORD), "the proxy password appears nowhere in the page");
    assertEqual(await app.exec(() => document.querySelectorAll('[data-area="left"], [data-area="center"], [data-area="right"]').length), 0, "no repository view behind the prompt");
    await app.waitFor(async () => (await focusedText(app)) === "Close tab", 5000, { message: "focus on the safe choice “Close tab”" });
    const repoId = (await findRepo(app, foreign.path)).id;
    const codeOf = (command, args) => app.invoke(command, args).then(() => null, (error) => error.code);
    assertEqual(await codeOf("status_get", { repoId }), "repo_untrusted", "the core refuses status_get");
    assertEqual(await codeOf("fetch", { repoId, jobId: "wd-trust-1", remote: null, prune: false }), "repo_untrusted", "the core refuses fetch");
    await sleep(2500);
    assert(!ran(foreign, FSMONITOR_MARKER), "core.fsmonitor did NOT run");
    assert(!ran(foreign, HOOK_MARKER), "the hook did not run");
    await t.shot("trust-gate");

    await app.click(await app.waitFor(() => app.byText("Trust and open", { within: GATE })));
    await app.waitFor('[data-area="left"]', 15_000);
    await app.settle();
    assert(!(await app.$(GATE)), "the prompt is gone");
    assertEqual((await findRepo(app, foreign.path)).trusted, true, "repo_list: trusted");
    await app.waitFor(async () => ran(foreign, FSMONITOR_MARKER), 15_000, { message: "after agreeing Git runs the configured command (proof the lock held it back)" });
    const trust = await app.invoke("repo_trust_get", { repoId });
    assert(!JSON.stringify(trust).includes(PROXY_PASSWORD), "repo_trust_get does not reveal the password");
    await t.shot("trust-agreed");
    await t.noConsoleErrors(app);
  } finally {
    foreign.cleanup();
  }
});

scenario("trust: Enter closes the tab, the lock survives reopen and restart, “Check again” updates", "edge", async (t) => {
  const foreign = makeForeignRepo("zweites-archiv");
  const dataDir = makeDataDir();
  try {
    let app = await t.launch({ ...LAUNCH, trustOpened: false, dataDir });
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    const opened = await app.openRepo(foreign.path);
    await app.waitFor(GATE, 15_000);
    await app.waitFor(async () => (await focusedText(app)) === "Close tab", 5000, { message: "focus on “Close tab”" });
    await app.press("Enter");
    await app.waitFor(async () => !(await app.$(`[data-tab-id="${opened.tabId}"]`)), 5000, { message: "Enter closed the tab" });
    assertEqual((await findRepo(app, foreign.path))?.trusted, false, "still listed, still untrusted");
    // Reopen from the list: the same prompt.
    await app.invoke("tab_open", { repoId: opened.repoId });
    await app.waitFor(GATE, 15_000);
    await app.close();

    app = await relaunch(t, { ...LAUNCH, trustOpened: false, dataDir });
    await app.waitFor(GATE, 15_000);
    await sleep(2000);
    assert(!ran(foreign, FSMONITOR_MARKER) && !ran(foreign, HOOK_MARKER), "a remembered tab runs nothing at start");
    // Check again after removing one entry by hand.
    await app.waitFor(async () => (await app.$$(`${GATE} li`)).length === 4, 10_000, { message: "four findings" });
    foreign.git("config", "--unset", "http.sslVerify");
    await app.click(await app.waitFor(() => app.byText("Check again", { within: GATE })));
    await app.waitFor(async () => (await app.$$(`${GATE} li`)).length === 3, 10_000, { message: "“Check again” drops the removed entry" });
    assert(!ran(foreign, FSMONITOR_MARKER), "the check itself runs nothing");
    await t.shot("trust-recheck");
    // Remove from list.
    await app.click(await app.waitFor(() => app.byText("Remove from list", { within: GATE })));
    await app.waitFor(async () => (await dialogTitle(app)) !== null, 5000, { message: "remove confirmation" });
    await app.click(await app.waitFor(() => app.byText("Remove from list", { within: '[role="dialog"]' })));
    await app.waitFor(async () => (await findRepo(app, foreign.path)) === null, 10_000, { message: "removed from the list" });
    assert(fs.existsSync(path.join(foreign.path, ".git")), "the folder stays on disk");
    assert(!ran(foreign, FSMONITOR_MARKER), "nothing ran at any point");
    await t.noConsoleErrors(app);
  } finally {
    foreign.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
