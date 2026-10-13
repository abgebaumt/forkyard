/**
 * Checks the interaction layer in the real app against real Git repositories: context menus,
 * actions, commands, toolbar, status bar, credential prompts.
 *
 * Menus and actions are triggered through the command registry (shortcuts, runCommand), the toolbar
 * and directly called menu functions (`window.__gcUi`, debug builds only); the effect is verified
 * in the repository itself (git in the fixture folder).
 *
 *   node scripts/e2e/screens/interaction.mjs                everything
 *   node scripts/e2e/screens/interaction.mjs --only sync     only sections whose name contains "sync"
 *   node scripts/e2e/screens/interaction.mjs --show          visible window
 *   node scripts/e2e/screens/interaction.mjs --no-shots      without screenshots
 *
 * Screenshots: target/e2e/shots/shell-toolbar-*.png, menus-*.png, credential-*.png, dialog-*.png
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { gitIsolationEnv, makeCleanRepoWithRemote, makeConflictRepo, makeEmptyRepo, makeRichRepo } from "../fixtures.mjs";

// The checks keep reading the repository with `git status` etc. Without this variable git briefly
// takes index.lock and writes the index back – that collides with the app's write actions
// ("locked" errors) and after an undo can even write back an old index. The core reads the same way.
process.env.GIT_OPTIONAL_LOCKS = "0";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const shots = !argv.includes("--no-shots");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const SHOTS = "target/e2e/shots";

const failures = [];
let current = "";
const check = (condition, message) => {
  if (!condition) {
    failures.push(`${current}: ${message}`);
    console.log(`  ✗ ${message}`);
  }
  return Boolean(condition);
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `read()` returns the expected value (the UI answers asynchronously, slowly under load). */
const eventually = async (read, expected, message, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  const matches = (value) => (typeof expected === "function" ? expected(value) : JSON.stringify(value) === JSON.stringify(expected));
  // A git call can fail while the app is writing (lock); that counts as "not yet".
  const attempt = async () => {
    try {
      return await read();
    } catch (error) {
      return `Error: ${String(error?.message ?? error).split("\n")[0]}`;
    }
  };
  let actual = await attempt();
  while (!matches(actual) && Date.now() < deadline) {
    await sleep(80);
    actual = await attempt();
  }
  if (matches(actual)) return true;
  // What the app reported belongs in the failure message (locks, core errors).
  const shown = page ? await toasts().catch(() => []) : [];
  return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${JSON.stringify(expected)}`}, got ${JSON.stringify(actual)}${shown.length ? ` – messages: ${JSON.stringify(shown)}` : ""}`);
};

const cleanups = [];
const made = (repo) => {
  cleanups.push(() => repo.cleanup());
  return repo;
};

/** git with input (e.g. `update-ref --stdin`), in the fixture's isolated environment. */
function gitRaw(repo, args, input) {
  return execFileSync("git", args, {
    cwd: repo.path,
    input,
    env: { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
    .toString("utf8")
    .trim();
}
const commit = (repo, file, content, message) => {
  repo.write(file, content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return repo.git("rev-parse", "HEAD");
};
/** git in the fixture repository; a failure because of a lock that is held right now is retried briefly. */
const gitTry = (repo, ...args) => {
  for (let round = 0; ; round++) {
    try {
      return repo.git(...args);
    } catch (error) {
      if (round >= 5) throw error;
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 150)"]);
    }
  }
};
const head = (repo) => repo.git("rev-parse", "HEAD");
const branch = (repo) => repo.git("rev-parse", "--abbrev-ref", "HEAD");
const branches = (repo) => repo.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
const read = (repo, file) => fs.readFileSync(path.join(repo.path, file), "utf8");
const exists = (repo, file) => fs.existsSync(path.join(repo.path, file));
const remoteGit = (repo, ...args) => execFileSync("git", ["--git-dir", repo.remotePath, ...args], { windowsHide: true }).toString("utf8").trim();

let app = null;
let page = null;

// ---------------------------------------------------------------------------
// Helpers in the page
// ---------------------------------------------------------------------------

/** Reloads everything menus and actions read from the cache (status, refs, remotes, stashes, graph, undo). */
const refresh = async (repoId) => {
  await page.evaluate(async (id) => {
    const { core, queryClient: client } = window.__gc;
    const key = (part) => ["repo", id, part];
    // A core event can cancel and restart a running query; then simply try again.
    const settle = async (load) => {
      for (let round = 0; ; round++) {
        try {
          return await load();
        } catch (error) {
          if (round > 4 || !String(error).includes("CancelledError")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    // Whatever is in flight does not count: fetchQuery attaches to a running query instead of
    // asking again – and that one may still have read the state from BEFORE the test's last step
    // (seen: refs already on main, status still on the old branch; the branch menu then said
    // "Merge … into “thema/rebase”"). Cancel first, then load.
    await Promise.all(["status", "refs", "remotes", "stashes", "undo", "viewState", "graph"].map((part) => client.cancelQueries({ queryKey: key(part), exact: true })));
    await Promise.all([
      settle(() => client.fetchQuery({ queryKey: key("status"), queryFn: () => core.statusGet({ repoId: id }), staleTime: 0 })),
      settle(() => client.fetchQuery({ queryKey: key("refs"), queryFn: () => core.refsList({ repoId: id }), staleTime: 0 })),
      settle(() => client.fetchQuery({ queryKey: key("remotes"), queryFn: () => core.remoteList({ repoId: id }), staleTime: 0 })),
      settle(() => client.fetchQuery({ queryKey: key("stashes"), queryFn: () => core.stashList({ repoId: id }), staleTime: 0 })),
      settle(() => client.fetchQuery({ queryKey: key("undo"), queryFn: () => core.undoPeek({ repoId: id }), staleTime: 0 })),
      settle(() => client.fetchQuery({ queryKey: key("viewState"), queryFn: () => core.viewStateGet({ repoId: id }), staleTime: 0 })),
      settle(() => client.fetchInfiniteQuery({ queryKey: key("graph"), queryFn: ({ pageParam }) => core.graphPage({ repoId: id, cursor: pageParam, limit: 2000 }), initialPageParam: null, staleTime: 0 })),
    ]);
  }, repoId);
  await app.settle();
};

const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
const closeToasts = async () => {
  for (let round = 0; round < 12 && (await page.locator("[data-toast]").count()) > 0; round++) {
    await page.getByRole("button", { name: "Close message" }).first().click({ timeout: 2000 }).catch(() => undefined);
    await sleep(80);
  }
};
/** Waits for a message whose text matches; returns it. */
const waitToast = async (pattern, tone = null, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await toasts()).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone));
    if (hit) return hit;
    if (Date.now() > deadline) {
      check(false, `message ${pattern}${tone ? ` (${tone})` : ""} missing; present: ${JSON.stringify(await toasts())}`);
      return null;
    }
    await sleep(80);
  }
};
const noErrorToast = async (message) => equal((await toasts()).filter((toast) => toast.tone === "danger"), [], message);

const dialog = () => page.getByRole("dialog");
const dialogTitle = async () => ((await dialog().count()) ? (await dialog().first().getByRole("heading").first().innerText()).trim() : null);
const waitDialog = async (pattern, timeoutMs = 15_000) => {
  await eventually(dialogTitle, (title) => title !== null && pattern.test(title), `Dialog ${pattern}`, timeoutMs);
  return dialog().first();
};
const noDialog = (message = "no dialog open any more") => eventually(() => dialog().count(), 0, message);
const focusedText = () => page.evaluate(() => (document.activeElement?.textContent ?? "").trim() || document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName);
const overflow = () => page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));

/** Triggers a command without waiting for it to finish (it often waits for a dialog itself). */
const command = (id) =>
  page.evaluate((commandId) => {
    void window.__gcUi.runCommand(commandId, "palette");
  }, id);
const available = (id) => page.evaluate((commandId) => window.__gcUi.commands().find((item) => item.id === commandId)?.available ?? null, id);

/** Opens a context menu through the menu function (the way the graph and the sidebar attach it). */
const openMenu = async (repo, kind, args = {}) => {
  for (let round = 0; round < 6; round++) {
    const count = await openMenuOnce(repo, kind, args);
    if (count > 0) return count;
    // An older query may briefly have overwritten the fresh state in the cache: reload, try again.
    await sleep(250);
    await refresh(repo.repoId);
  }
  return 0;
};
const openMenuOnce = async (repo, kind, args = {}) => {
  const count = await page.evaluate(
    ([kindName, input, repoId, tabId]) => {
      const ui = window.__gcUi;
      const client = window.__gc.queryClient;
      const data = (part) => client.getQueryData(["repo", repoId, part]);
      const refs = data("refs");
      const all = [...refs.locals, ...refs.remotes, ...refs.tags];
      const ref = (name) => all.find((item) => item.name === name || item.fullName === name);
      const base = { repoId, tabId };
      const status = data("status");
      let entries = [];
      if (kindName === "commit") entries = ui.menus.commitMenu({ ...base, shas: input.shas });
      else if (kindName === "wip") entries = ui.menus.wipMenu(base);
      else if (kindName === "branch") entries = ui.menus.branchMenu({ ...base, ref: ref(input.name) });
      else if (kindName === "branches") entries = ui.menus.branchesMenu({ ...base, refs: input.names.map(ref) });
      else if (kindName === "tag") entries = ui.menus.tagMenu({ ...base, ref: ref(input.name) });
      else if (kindName === "stash") entries = ui.menus.stashMenu({ ...base, stash: data("stashes")[input.index ?? 0] });
      else if (kindName === "remote") entries = ui.menus.remoteMenu({ ...base, remote: data("remotes").find((item) => item.name === input.name) });
      else if (kindName === "file") {
        const pool = input.source.kind === "staged" ? status.staged : input.source.kind === "unstaged" ? [...status.conflicted, ...status.unstaged] : null;
        const files = pool ? pool.filter((file) => input.paths.includes(file.path)) : input.paths.map((file) => ({ path: file, oldPath: null, status: "modified", area: "commit", isBinary: false, isLfs: false, added: 1, removed: 0, conflict: null }));
        entries = ui.menus.fileMenu({ ...base, files, source: input.source });
      } else if (kindName === "drop") entries = ui.menus.dropMenu({ ...base, source: ref(input.source), target: ref(input.target) });
      ui.openMenuAt({ x: input.x ?? 420, y: input.y ?? 96 }, entries, "E2E");
      return entries.length;
    },
    [kind, args, repo.repoId, repo.tabId],
  );
  if (count > 0) await page.locator('[role="menu"]').first().waitFor();
  return count;
};
const menuItems = () =>
  page.locator('[role="menu"]').first().locator('[role="menuitem"]').evaluateAll((list) =>
    list.map((item) => {
      const parts = item.querySelectorAll(":scope > span");
      return {
        text: item.innerText.replace(/\s+/g, " ").trim(),
        label: (parts[1]?.textContent ?? "").trim(),
        hint: (parts[2]?.textContent ?? "").trim(),
        disabled: item.hasAttribute("data-disabled"),
        title: item.getAttribute("title") ?? "",
      };
    }),
  );
const menuItem = (name) => page.getByRole("menuitem", { name });
const closeMenu = async () => {
  if (await page.locator('[role="menu"]').count()) await page.keyboard.press("Escape");
  await eventually(() => page.locator('[role="menu"]').count(), 0, "menu closed");
};
/** Picks an entry; `sub` opens the submenu first. */
const pick = async (name, sub = null) => {
  if (sub) {
    await menuItem(sub).click();
    await page.locator('[role="menu"]').nth(1).waitFor();
  }
  await menuItem(name).click();
  await eventually(() => page.locator('[role="menu"]').count(), 0, "menu closes after the choice");
};
const shot = async (name) => {
  if (!shots) return;
  await page.waitForTimeout(150);
  await app.screenshot(`${SHOTS}/${name}.png`);
};
const toolbar = () => page.getByRole("toolbar", { name: "Repository actions" });
const toolButton = (name) => toolbar().getByRole("button", { name: new RegExp(`^${name}`) }).first();
const toolState = (name) => toolButton(name).evaluate((button) => ({ disabled: button.getAttribute("aria-disabled") === "true", busy: button.getAttribute("aria-busy") === "true" }));
/** The reason is in the tooltip and – for screen readers – in the button's description (aria-describedby). */
const toolHint = (name) =>
  toolButton(name).evaluate((button) => {
    const id = button.getAttribute("aria-describedby");
    return (id ? document.getElementById(id)?.textContent : "")?.trim() ?? "";
  });
const footer = () => page.locator("footer").innerText().then((text) => text.replace(/\s+/g, " ").trim());
const storeView = (repo) => page.evaluate((tabId) => window.__gc.store.getState().views[tabId] ?? null, repo.tabId);

const open = async (fixture) => {
  const ids = await app.openRepo(fixture.path);
  Object.assign(fixture, ids);
  // Only this fixture's tab stays open: calm screenshots, and old repositories don't interfere.
  const tabs = await app.invoke("tabs_list");
  for (const tab of tabs) if (tab.id !== ids.tabId) await app.invoke("tab_close", { tabId: tab.id });
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
  await refresh(fixture.repoId);
  return fixture;
};

const section = async (name, run) => {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  current = name;
  const before = failures.length;
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    check(false, `aborted: ${error?.stack ?? error}`);
    if (app) await app.screenshot(`target/e2e/interaction-error-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`).catch(() => undefined);
  }
  // Clean up so the next section starts clean.
  try {
    for (let round = 0; round < 4 && (await dialog().count()) > 0; round++) await page.keyboard.press("Escape");
    await closeMenu();
    await closeToasts();
    await page.evaluate(() => window.__gc.store.getState().closeOverlay());
  } catch {
    // the app is already closed
  }
  console.log(`${failures.length === before ? "✓" : "✗"} ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  page = app.page;
  check(await page.evaluate(() => Boolean(window.__gcUi && window.__gc)), "The developer interfaces __gc and __gcUi are missing.");

  // -------------------------------------------------------------------------
  await section("Keyboard: branch, stash, pop, menu, push, undo – without a mouse", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "tastatur" })));
    await page.evaluate(() => document.activeElement?.blur?.());

    // Ctrl+B: create a branch. Spaces become "-", Enter confirms.
    await page.keyboard.press("Control+b");
    await waitDialog(/^New branch$/);
    await page.keyboard.type("feature/neue idee");
    equal(await dialog().getByLabel("Name").inputValue(), "feature/neue-idee", "spaces in the branch name become \"-\"");
    await page.keyboard.press("Enter");
    await noDialog();
    await eventually(() => branch(repo), "feature/neue-idee", "Ctrl+B creates the branch and checks it out (git)");
    await waitToast(/Branch “feature\/neue-idee” created and checked out/, "success");
    await closeToasts();

    // An existing name is rejected while typing; Enter creates nothing; Esc discards.
    await page.keyboard.press("Control+b");
    await waitDialog(/^New branch$/);
    await page.keyboard.type("main");
    await eventually(() => dialog().getByRole("alert").count(), 1, "an existing name shows an error at the field");
    check(/already exists/i.test(await dialog().getByRole("alert").innerText()), `the error states the reason: ${await dialog().getByRole("alert").innerText()}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    check((await dialogTitle()) === "New branch", "Enter with an invalid name does not close the dialog");
    await page.keyboard.press("Escape");
    await noDialog();
    equal(branches(repo).sort(), ["feature/export", "feature/neue-idee", "main"], "no further branch was created");

    // Alt+S: stash; Alt+P: pop.
    repo.write("README.md", `${read(repo, "README.md")}\nNeue Zeile aus dem Tastatur-Test.\n`);
    repo.write("notiz.txt", "unverfolgt\n");
    await refresh(repo.repoId);
    await page.keyboard.press("Alt+s");
    await eventually(() => repo.git("stash", "list").split("\n").filter(Boolean).length, 1, "Alt+S creates a stash (git stash list)");
    await eventually(() => repo.git("status", "--porcelain"), "", "after the stash the working directory is clean – the untracked file is included too");
    await waitToast(/Changes stashed/, "success");
    await closeToasts();
    await refresh(repo.repoId);
    await page.keyboard.press("Alt+p");
    await eventually(() => repo.git("stash", "list"), "", "Alt+P applies the stash and removes it");
    check(read(repo, "README.md").includes("Tastatur-Test") && exists(repo, "notiz.txt"), "the changes are back in the working directory");
    await waitToast(/Stash pop complete/, "success");
    await closeToasts();
    await refresh(repo.repoId);

    // Ctrl+.: open the selection's menu (WIP), pick "Stage all" with the arrow keys.
    await page.evaluate((tabId) => window.__gc.store.getState().selectWip(tabId), repo.tabId);
    await page.keyboard.press("Control+.");
    await page.locator('[role="menu"]').first().waitFor();
    const wip = await menuItems();
    equal(wip.map((item) => item.text.replace(/ Ctrl.*$| Alt.*$/, "")), ["Stage all", "Unstage all nothing staged", "Create stash", "Stash with description …", "Create patch from changes …", "Apply patch …", "Discard all changes …"], "WIP menu via Ctrl+.");
    check(wip[1]?.disabled === true, "\"Unstage all\" is disabled while nothing is staged");
    await page.keyboard.press("ArrowDown");
    equal(await focusedText().then((text) => text.startsWith("Stage all")), true, "arrow down lands on \"Stage all\"");
    await page.keyboard.press("Enter");
    await eventually(() => repo.git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort(), ["README.md", "notiz.txt"], "Enter in the menu stages everything (git diff --cached)");
    repo.git("commit", "-q", "-m", "Tastatur-Test: README ergänzt");
    await refresh(repo.repoId);

    // Ctrl+Shift+P: push without upstream → "Where to push?" → Enter.
    await page.keyboard.press("Control+Shift+P");
    const target = await waitDialog(/^Where to push\?$/);
    equal(await target.getByLabel("Branch name on the remote").inputValue(), "feature/neue-idee", "the remote branch name is prefilled");
    check((await target.innerText()).includes("origin/feature/neue-idee"), "the dialog says what will be created (origin/feature/neue-idee)");
    await shot("dialog-push-target");
    await page.keyboard.press("Enter");
    await noDialog();
    await waitToast(/Pushed to origin\/feature\/neue-idee/, "success");
    equal(remoteGit(repo, "rev-parse", "refs/heads/feature/neue-idee"), head(repo), "the branch is on the remote (git in the bare repository)");
    equal(repo.git("rev-parse", "--abbrev-ref", "feature/neue-idee@{upstream}"), "origin/feature/neue-idee", "the upstream is set");
    await closeToasts();
    await refresh(repo.repoId);

    // Toolbar by keyboard: focus on "Fetch", Enter.
    await toolButton("Fetch").focus();
    await page.keyboard.press("Enter");
    await waitToast(/Fetch complete/, "success");
    await closeToasts();

    // Hard reset via the command: confirmation with focus on "Cancel"; Tab + Enter confirms.
    const before = head(repo);
    const parent = repo.git("rev-parse", "HEAD~1");
    repo.write("README.md", `${read(repo, "README.md")}Ungesicherte Zeile.\n`);
    await refresh(repo.repoId);
    await page.evaluate(([tabId, sha]) => window.__gc.store.getState().selectCommits(tabId, [sha]), [repo.tabId, parent]);
    await command("commit.reset.hard");
    const reset = await waitDialog(/Hard reset .+ to [0-9a-f]{7}\?$/);
    equal(await focusedText(), "Cancel", "in the confirmation the focus is on \"Cancel\"");
    const resetText = (await reset.innerText()).replace(/\s+/g, " ");
    check(/1 commit disappears/.test(resetText), `the confirmation states the number of commits: ${resetText}`);
    check(/Uncommitted changes to 1 file/.test(resetText) && resetText.includes("README.md"), "it names the uncommitted changes including the file");
    check(/Undo \(Ctrl\+Z\)/.test(resetText), "it says that Undo brings it back");
    await shot("dialog-reset-hard");
    await page.keyboard.press("Enter");
    await noDialog("Enter on \"Cancel\" closes the confirmation");
    equal(head(repo), before, "Enter in the confirmation does NOT trigger the hard reset");
    await command("commit.reset.hard");
    await waitDialog(/Hard reset/);
    await page.keyboard.press("Tab");
    equal(await focusedText(), "Hard reset", "Tab moves to the dangerous button");
    await page.keyboard.press("Enter");
    await noDialog();
    await eventually(() => head(repo), parent, "hard reset moves the branch back (git rev-parse HEAD)");
    check(!read(repo, "README.md").includes("Ungesicherte Zeile"), "the uncommitted change is discarded");
    await waitToast(/is now at/, "success");
    await closeToasts();

    // Ctrl+Z brings back the branch state AND the uncommitted change; Ctrl+Y redoes.
    await page.evaluate(() => document.activeElement?.blur?.());
    await refresh(repo.repoId);
    await page.keyboard.press("Control+z");
    await eventually(() => head(repo), before, "Ctrl+Z undoes the hard reset");
    check(read(repo, "README.md").includes("Ungesicherte Zeile"), "the uncommitted change is back as well");
    await waitToast(/Undone/, "success");
    await closeToasts();
    await refresh(repo.repoId);
    await page.keyboard.press("Control+y");
    await eventually(() => head(repo), parent, "Ctrl+Y redoes the hard reset");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors in the keyboard run");
  });

  // -------------------------------------------------------------------------
  await section("Branch: rename, delete (merged, unmerged, several), undo", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "branches" })));
    repo.git("branch", "thema/gemergt");
    repo.git("checkout", "-q", "-b", "thema/offen");
    commit(repo, "offen.txt", "eins\n", "Offener Commit eins");
    commit(repo, "offen.txt", "eins\nzwei\n", "Offener Commit zwei");
    repo.git("checkout", "-q", "main");
    repo.git("branch", "thema/alt-a");
    repo.git("branch", "thema/alt-b");
    await refresh(repo.repoId);

    // Menu of the checked-out branch: check out and delete are disabled, with a reason.
    await openMenu(repo, "branch", { name: "main" });
    const own = await menuItems();
    check(own.find((item) => item.text.startsWith("Check out"))?.disabled === true && /is checked out/.test(own.find((item) => item.text.startsWith("Check out"))?.text ?? ""), "\"Check out\" is disabled for the checked-out branch, with a reason");
    const del = own.find((item) => /Delete/.test(item.text));
    check(del?.disabled === true && /can’t be deleted/.test(del?.text ?? ""), `"Delete" is disabled for the checked-out branch, with a reason: ${del?.text}`);
    check(own[own.length - 1] === del, "the dangerous entry is last");
    check(own.some((item) => /^Push/.test(item.text) && item.disabled && /nothing to push/.test(item.text)), "\"Push\" is disabled: nothing to push");
    await shot("menus-branch-current");
    await closeMenu();

    // Rename
    await openMenu(repo, "branch", { name: "thema/gemergt" });
    await shot("menus-branch");
    await pick(/^Rename/);
    const rename = await waitDialog(/^Rename branch/);
    equal(await rename.getByLabel("New name").inputValue(), "thema/gemergt", "the old name is prefilled");
    await rename.getByLabel("New name").fill("thema/erledigt");
    await page.keyboard.press("Enter");
    await noDialog();
    await eventually(() => branches(repo).includes("thema/erledigt") && !branches(repo).includes("thema/gemergt"), true, "the branch is now called thema/erledigt (git)");
    await closeToasts();
    await refresh(repo.repoId);

    // Deleting a merged branch: the confirmation names it and its state.
    await openMenu(repo, "branch", { name: "thema/erledigt" });
    await pick(/^Delete .+ …$/);
    const confirmMerged = await waitDialog(/^Delete branch “thema\/erledigt”\?$/);
    const mergedText = (await confirmMerged.innerText()).replace(/\s+/g, " ");
    check(/points to the same commit as “main”/.test(mergedText) && /no commits are lost/.test(mergedText), `the confirmation says it is merged: ${mergedText}`);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await shot("dialog-branch-delete");
    await confirmMerged.getByRole("button", { name: "Delete branch" }).click();
    await eventually(() => branches(repo).includes("thema/erledigt"), false, "the branch is deleted (git)");
    await waitToast(/Branch “thema\/erledigt” deleted/, "success");
    await closeToasts();

    // Undo brings it back, redo deletes it again.
    await refresh(repo.repoId);
    const undoHint = await toolHint("Undo");
    check(/Undo: .*thema\/erledigt/.test(undoHint), `the "Undo" tooltip names the action: ${undoHint}`);
    // Click only once the UI has stopped loading – the way a human would.
    await app.settle();
    await toolButton("Undo").click();
    await eventually(() => branches(repo).includes("thema/erledigt"), true, "Undo restores the branch");
    await closeToasts();
    await refresh(repo.repoId);
    check(/Redo: /.test(await toolHint("Redo")), "the \"Redo\" tooltip names the action");
    await toolButton("Redo").click();
    await eventually(() => branches(repo).includes("thema/erledigt"), false, "Redo deletes it again");
    await closeToasts();
    await refresh(repo.repoId);

    // Unmerged: stronger confirmation that counts the commits; "Delete anyway".
    const offen = repo.git("rev-parse", "thema/offen");
    await openMenu(repo, "branch", { name: "thema/offen" });
    await pick(/^Delete .+ …$/);
    const confirmOpen = await waitDialog(/^Delete unmerged branch “thema\/offen”\?$/);
    const openText = (await confirmOpen.innerText()).replace(/\s+/g, " ");
    check(/is not merged: 2 commits can only be reached through it/.test(openText), `the confirmation counts the commits: ${openText}`);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await shot("dialog-branch-delete-unmerged");
    await page.keyboard.press("Escape");
    await noDialog();
    equal(repo.git("rev-parse", "thema/offen"), offen, "Cancel leaves the branch in place");
    await openMenu(repo, "branch", { name: "thema/offen" });
    await pick(/^Delete .+ …$/);
    await (await waitDialog(/^Delete unmerged/)).getByRole("button", { name: "Delete anyway" }).click();
    await eventually(() => branches(repo).includes("thema/offen"), false, "\"Delete anyway\" deletes the unmerged branch");
    await noErrorToast("no error on forced delete");
    await closeToasts();
    await refresh(repo.repoId);

    // Several: the checked-out one is left out.
    await openMenu(repo, "branches", { names: ["main", "thema/alt-a", "thema/alt-b"] });
    const many = await menuItems();
    check(many.some((item) => /^Delete 2 branches …/.test(item.text) && /without the checked-out one/.test(item.text)), `"Delete 2 branches" leaves out the checked-out one: ${JSON.stringify(many.map((item) => item.text))}`);
    await pick(/^Delete 2 branches/);
    const confirmMany = await waitDialog(/^Delete 2 branches\?$/);
    check((await confirmMany.innerText()).includes("thema/alt-a") && (await confirmMany.innerText()).includes("thema/alt-b"), "the confirmation lists both names");
    await confirmMany.getByRole("button", { name: "Delete branches" }).click();
    await eventually(() => branches(repo).sort(), ["feature/export", "main"], "both branches are deleted, main remains");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Checkout: blocking changes (stash offer), remote branch, commit (detached)", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "checkout" })));
    // feature/export has src/export.py; an untracked file of the same name on main blocks the switch.
    repo.write("src/export.py", "# lokal angelegt, steht dem Wechsel im Weg\n");
    repo.write("README.md", `${read(repo, "README.md")}\nLokale Notiz.\n`);
    await refresh(repo.repoId);

    await openMenu(repo, "branch", { name: "feature/export" });
    await pick(/^Check out/);
    const blocked = await waitDialog(/^Uncommitted changes are blocking the switch$/);
    const text = (await blocked.innerText()).replace(/\s+/g, " ");
    check(text.includes("src/export.py"), `the dialog names the affected file: ${text}`);
    check(/Stash changes and switch/.test(text) && /Cancel/.test(text), "it offers \"Stash changes and switch\" and \"Cancel\"");
    await shot("dialog-checkout-blocked");
    await page.keyboard.press("Escape");
    await noDialog();
    equal(branch(repo), "main", "Cancel: main stays checked out");
    equal(repo.git("stash", "list"), "", "Cancel: no stash created");
    await noErrorToast("Cancel shows no error message");

    await openMenu(repo, "branch", { name: "feature/export" });
    await pick(/^Check out/);
    await (await waitDialog(/blocking the switch$/)).getByRole("button", { name: /Stash changes and switch/ }).click();
    await eventually(() => branch(repo), "feature/export", "after \"stash and switch\" feature/export is checked out (git)");
    check(/Saved before switching to feature\/export/.test(repo.git("stash", "list")), `the stash has a meaningful name: ${repo.git("stash", "list")}`);
    check(read(repo, "src/export.py").includes("Schreibt den Vergleich"), "the file from the branch is there, not the local one");
    await waitToast(/“feature\/export” checked out/, "success");
    await waitToast(/Your changes are in the stash/, "info");
    await closeToasts();
    await refresh(repo.repoId);

    // Checking out a remote branch creates the local tracking branch.
    repo.git("checkout", "-q", "main");
    repo.git("branch", "-q", "-D", "feature/export");
    await refresh(repo.repoId);
    await openMenu(repo, "branch", { name: "origin/feature/export" });
    const remoteItems = await menuItems();
    check(remoteItems.some((item) => /^Check out/.test(item.text) && /creates “feature\/export”/.test(item.text)), `remote branch: "Check out" says that a local branch is created: ${JSON.stringify(remoteItems.map((item) => item.text))}`);
    check(!remoteItems.some((item) => /delete on the remote/i.test(item.text)), "\"Delete on the remote\" is missing (no core command)");
    await shot("menus-branch-remote");
    await pick(/^Check out/);
    await eventually(() => branch(repo), "feature/export", "the local branch is created and checked out");
    equal(repo.git("rev-parse", "--abbrev-ref", "feature/export@{upstream}"), "origin/feature/export", "it tracks origin/feature/export");
    await closeToasts();
    await refresh(repo.repoId);

    // Checking out a commit: HEAD is detached; status bar and message explain it.
    const first = repo.git("rev-list", "--max-parents=0", "HEAD");
    await openMenu(repo, "commit", { shas: [first] });
    const commitItems = await menuItems();
    check(commitItems.some((item) => /^Check out commit/.test(item.text) && /no branch is checked out/.test(item.text)), "\"Check out commit\" explains what applies afterwards");
    await pick(/^Check out commit/);
    await eventually(() => branch(repo), "HEAD", "HEAD is detached (git)");
    equal(head(repo), first, "the chosen commit is checked out");
    const detached = await waitToast(/HEAD detached at/, "info");
    check(/No branch is checked out/.test(detached?.text ?? "") && /Create branch here/.test(detached?.text ?? ""), "the message explains the state and offers \"Create branch here\"");
    await eventually(footer, (value) => value.includes(`HEAD detached at ${first.slice(0, 7)}`), "the status bar shows \"HEAD detached at <sha>\"");
    await refresh(repo.repoId);
    check((await toolState("Pull")).disabled && /No branch checked out/.test(await toolHint("Pull")), "Pull is disabled with a detached HEAD, with a reason");
    await shot("shell-toolbar-detached");
    await closeToasts();

    // Error state: a target that does not exist.
    await page.evaluate((repoId) => void window.__gcUi.actions.branches.checkout(repoId, "gibt/es/nicht"), repo.repoId);
    const failed = await waitToast(/Checkout failed/, "danger");
    check((failed?.text ?? "").length > 30, `the error message explains something: ${failed?.text}`);
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Merge: fast-forward, conflict, abort, squash setting; rebase; drop menu", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "merge" })));
    const base = head(repo);
    repo.git("checkout", "-q", "-b", "thema/ff");
    const ff = commit(repo, "ff.txt", "vorgespult\n", "Für den Fast-forward");
    repo.git("checkout", "-q", "-b", "thema/konflikt", base);
    commit(repo, "README.md", "# Messnetz (Fassung Konflikt-Branch)\n\nGemeinsame Auswertung.\n", "README im Konflikt-Branch");
    repo.git("checkout", "-q", "-b", "thema/rebase", base);
    const rebaseTip = commit(repo, "rebase.txt", "umgesetzt\n", "Für den Rebase");
    repo.git("checkout", "-q", "main");
    await refresh(repo.repoId);

    // Fast-forward
    await openMenu(repo, "branch", { name: "thema/ff" });
    const items = await menuItems();
    const mergeItem = items.find((item) => /Merge “thema\/ff” into “main”/.test(item.text));
    check(Boolean(mergeItem) && /via fast-forward/.test(mergeItem?.text ?? ""), `the entry names both branches and "via fast-forward": ${JSON.stringify(items.map((item) => item.text))}`);
    await pick(/Merge “thema\/ff” into “main”/);
    await eventually(() => head(repo), ff, "fast-forward: main points to the commit of thema/ff, without a merge commit (git)");
    await waitToast(/Merge complete/, "success");
    await closeToasts();
    await refresh(repo.repoId);
    await openMenu(repo, "branch", { name: "thema/ff" });
    check((await menuItems()).some((item) => /into “main”/.test(item.text) && item.disabled && /point to the same commit/.test(item.text)), "afterwards \"Merge\" is disabled: point to the same commit");
    await closeMenu();

    // Conflict: change README differently on main, then merge.
    commit(repo, "README.md", "# Messnetz (Fassung main)\n\nGemeinsame Auswertung.\n", "README auf main");
    await refresh(repo.repoId);
    await page.evaluate((tabId) => window.__gc.store.getState().selectCommits(tabId, []), repo.tabId);
    await openMenu(repo, "drop", { source: "thema/konflikt", target: "main" });
    const drop = await menuItems();
    equal(drop.map((item) => item.text.split(" checks out")[0]).slice(0, 3).map((value) => value.replace(/ …$/, "")), ["Merge “thema/konflikt” into “main”", "Rebase “thema/konflikt” onto “main”", "Interactively rebase “thema/konflikt” onto “main”"], "the drop menu always spells out both names");
    await shot("menus-drop");
    await pick(/Merge “thema\/konflikt” into “main”/);
    const conflict = await waitToast(/Merge: conflict in one file/, "warning");
    check(/then continue the merge – or abort it/.test(conflict?.text ?? ""), "the message says how to go on");
    check(repo.git("status", "--porcelain").includes("UU README.md"), "git reports the conflict in README.md");
    await eventually(() => storeView(repo).then((view) => view?.selection?.kind), "wip", "the view jumps to the WIP row");
    await eventually(footer, (value) => /merge in progress/i.test(value), "the status bar shows \"merge in progress\"");
    await refresh(repo.repoId);
    const during = await toolState("Pull");
    check(during.disabled && /Finish the running merge first/.test(await toolHint("Pull")), "Pull is disabled during the merge, with a reason");
    await shot("shell-toolbar-operation");
    await openMenu(repo, "branch", { name: "thema/rebase" });
    check((await menuItems()).filter((item) => /Merge|[Rr]ebase|Check out/.test(item.text)).every((item) => item.disabled && /finish the running merge first/.test(item.text)), "in the branch menu check out, merge and rebase are disabled, with a reason");
    await closeMenu();
    await closeToasts();

    // Abort (command) with confirmation
    await command("operation.abort");
    const abort = await waitDialog(/^Abort merge\?$/);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await abort.getByRole("button", { name: "Abort merge" }).click();
    await eventually(() => repo.git("status", "--porcelain"), "", "after the abort the working directory is clean");
    await waitToast(/Aborted the merge/, "success");
    await closeToasts();
    await refresh(repo.repoId);

    // Rebase via the drop menu: the source branch is checked out first.
    await openMenu(repo, "drop", { source: "thema/rebase", target: "main" });
    const dropRebase = await menuItems();
    check(dropRebase.some((item) => /Rebase “thema\/rebase” onto “main”/.test(item.text) && /checks out thema\/rebase first/.test(item.text)), `"Rebase" says that it checks out first: ${JSON.stringify(dropRebase.map((item) => item.text))}`);
    await pick(/Rebase “thema\/rebase” onto “main”/);
    await waitToast(/Rebase complete/, "success");
    equal(repo.git("merge-base", "thema/rebase", "main"), repo.git("rev-parse", "main"), "thema/rebase now sits on main (git merge-base)");
    check(repo.git("rev-parse", "thema/rebase") !== rebaseTip, "the commit was rewritten");
    equal(branch(repo), "thema/rebase", "the rebased branch is checked out");
    await closeToasts();
    await refresh(repo.repoId);

    // Rebase with undo
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Control+z");
    await eventually(() => repo.git("rev-parse", "thema/rebase"), rebaseTip, "Ctrl+Z undoes the rebase");
    await closeToasts();
    await refresh(repo.repoId);

    // Interactive rebase opens the rebase tool with base and mode.
    await openMenu(repo, "drop", { source: "thema/rebase", target: "main" });
    await pick(/^Interactively rebase .* onto “main”/);
    await eventually(() => storeView(repo).then((view) => view?.center), { kind: "rebase", base: "main", mode: "interactive", shas: [] }, "\"Interactively rebase\" opens the rebase tool with base main");
    await page.evaluate((tabId) => window.__gc.store.getState().closeCenter(tabId), repo.tabId);

    // Squash setting: merging creates no commit, the changes are staged.
    repo.git("checkout", "-q", "main");
    await app.invoke("settings_set", { patch: { squashOnMerge: true } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    // The switch came from outside: wait until the app sees it (file watcher → repo:changed).
    await eventually(
      async () => {
        await refresh(repo.repoId);
        return page.evaluate((repoId) => window.__gc.queryClient.getQueryData(["repo", repoId, "refs"])?.head?.branch ?? null, repo.repoId);
      },
      "main",
      "the app sees the switch to main",
    );
    const mainBefore = head(repo);
    await openMenu(repo, "branch", { name: "thema/rebase" });
    await pick(/Merge “thema\/rebase” into “main”/);
    await waitToast(/Changes from thema\/rebase are staged/, "success");
    equal(head(repo), mainBefore, "squash merge: no new commit");
    equal(repo.git("diff", "--cached", "--name-only"), "rebase.txt", "the changes are staged");
    await app.invoke("settings_set", { patch: { squashOnMerge: false } });
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Commit menu: revert, cherry-pick, reset soft/mixed, squash, edit message, copy", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "commits" })));
    const pushed = head(repo);
    const a = commit(repo, "a.txt", "a\n", "Erster lokaler Commit");
    const b = commit(repo, "b.txt", "b\n", "Zweiter lokaler Commit");
    const c = commit(repo, "c.txt", "c\n", "Dritter lokaler Commit");
    const featureTip = repo.git("rev-parse", "feature/export");
    await refresh(repo.repoId);

    // Menu of the HEAD commit
    await openMenu(repo, "commit", { shas: [c] });
    const headItems = await menuItems();
    equal(
      headItems.map((item) => item.label),
      ["Create branch here …", "Create tag here …", "Check out commit", "Cherry-pick", "Revert", "Reset “main” to here", "Rebase “main” onto this commit", "Interactive rebase from here …", "Edit message …", "Copy SHA", "Copy message", "Create patch …"],
      "entries of the commit menu at the HEAD commit",
    );
    check(headItems.find((item) => item.text.startsWith("Cherry-pick"))?.disabled === true, "Cherry-pick is disabled for a commit of the own branch (already contained)");
    await shot("menus-commit-head");

    // Reset submenu: three modes with a short phrase, Hard red and last.
    await menuItem(/to here/).click();
    await page.locator('[role="menu"]').nth(1).waitFor();
    const sub = await page.locator('[role="menu"]').nth(1).locator('[role="menuitem"]').evaluateAll((list) => list.map((item) => ({ text: item.innerText.replace(/\s+/g, " ").trim(), danger: item.className.includes("text-danger") })));
    equal(sub.map((item) => item.text), ["Soft changes stay staged", "Mixed changes stay, unstaged", "Hard … changes are discarded"], "Reset: three modes with a short phrase each");
    check(sub[2]?.danger === true && !sub[0]?.danger, "Hard is red and last");
    await shot("menus-commit-reset");
    await closeMenu();
    await closeMenu();

    // Copy SHA and message
    await openMenu(repo, "commit", { shas: [c] });
    await pick(/^Copy SHA/);
    await waitToast(/SHA copied/, "success");
    await eventually(() => page.evaluate(() => window.__gcUi.lastCopiedText()), c, "the full SHA is copied");
    await openMenu(repo, "commit", { shas: [c] });
    await pick(/^Copy message/);
    await waitToast(/Message copied/, "success");
    await eventually(() => page.evaluate(() => window.__gcUi.lastCopiedText()), "Dritter lokaler Commit", "the message is copied");
    await closeToasts();

    // Edit message (HEAD)
    await openMenu(repo, "commit", { shas: [c] });
    await pick(/^Edit message/);
    const reword = await waitDialog(/^Edit message of the last commit$/);
    equal(await reword.getByLabel("Summary").inputValue(), "Dritter lokaler Commit", "the old summary is prefilled");
    check(!/is already on the remote/.test(await reword.innerText()), "no \"already pushed\" note for a local commit");
    await reword.getByLabel("Summary").fill("Dritter Commit, umformuliert");
    await reword.getByLabel("Description").fill("Mit Beschreibung.");
    await page.keyboard.press("Control+Enter");
    await noDialog();
    await eventually(() => repo.git("log", "-1", "--format=%s|%b").replace(/\s+$/, ""), "Dritter Commit, umformuliert|Mit Beschreibung.", "the message is changed (git log)");
    await closeToasts();
    await refresh(repo.repoId);
    const c2 = head(repo);

    // Revert of the second commit
    await openMenu(repo, "commit", { shas: [b] });
    await pick(/^Revert/);
    await waitToast(/Revert complete/, "success");
    check(/^Revert "Zweiter lokaler Commit"/.test(repo.git("log", "-1", "--format=%s")), `a revert commit was created: ${repo.git("log", "-1", "--format=%s")}`);
    check(!exists(repo, "b.txt"), "the commit's change is reverted (b.txt is gone)");
    await closeToasts();
    await refresh(repo.repoId);
    const afterRevert = head(repo);

    // Soft reset to c2: the revert is staged afterwards. Undo. Mixed reset: unstaged. Undo.
    await openMenu(repo, "commit", { shas: [c2] });
    await pick(/^Soft/, /to here/);
    await eventually(() => head(repo), c2, "soft reset: HEAD is at the chosen commit");
    equal(repo.git("diff", "--cached", "--name-only"), "b.txt", "soft: the change is staged");
    await waitToast(/“main” is now at/, "success");
    await closeToasts();
    await refresh(repo.repoId);
    // Click only once the UI has stopped loading – the way a human would.
    await app.settle();
    await toolButton("Undo").click();
    await eventually(() => head(repo), afterRevert, "undo after soft reset restores the old state");
    await closeToasts();
    await refresh(repo.repoId);
    await openMenu(repo, "commit", { shas: [c2] });
    await pick(/^Mixed/, /to here/);
    await eventually(() => head(repo), c2, "mixed reset: HEAD is at the chosen commit");
    equal(repo.git("diff", "--cached", "--name-only"), "", "mixed: nothing staged");
    check(repo.git("status", "--porcelain").includes("D b.txt"), "mixed: the change is in the working directory");
    await closeToasts();
    await refresh(repo.repoId);
    // Click only once the UI has stopped loading – the way a human would.
    await app.settle();
    await toolButton("Undo").click();
    await eventually(() => head(repo), afterRevert, "undo after mixed reset restores the old state");
    await eventually(() => repo.git("status", "--porcelain"), "", "and the working directory is clean again");
    await closeToasts();
    await refresh(repo.repoId);

    // Cherry-pick from the other branch
    await openMenu(repo, "commit", { shas: [featureTip] });
    const foreign = await menuItems();
    check(foreign.find((item) => item.text.startsWith("Revert"))?.disabled === true, "Revert is disabled for a foreign commit (not in main)");
    check(foreign.find((item) => item.text.startsWith("Interactive rebase"))?.disabled === true, "\"Interactive rebase from here\" is disabled for a foreign commit");
    await shot("menus-commit");
    await pick(/^Cherry-pick/);
    await waitToast(/Cherry-pick complete/, "success");
    equal(repo.git("log", "-1", "--format=%s"), "CSV-Export für den Vergleich", "the commit is applied (git log)");
    check(exists(repo, "src/export.py"), "its file is there");
    await closeToasts();
    await refresh(repo.repoId);

    // Multi-selection: squash only for consecutive commits; compare for exactly two.
    await openMenu(repo, "commit", { shas: [a, c2] });
    const apart = await menuItems();
    const squashApart = apart.find((item) => /Squash/.test(item.text));
    check(squashApart?.disabled === true && /consecutive commits only/.test(squashApart?.text ?? ""), `squash is disabled for non-consecutive commits, with a reason: ${squashApart?.text}`);
    check(apart.some((item) => /^Compare/.test(item.text)), "with exactly two commits there is \"Compare\"");
    await shot("menus-commits-apart");
    await pick(/^Compare/);
    await eventually(() => storeView(repo).then((view) => view?.selection), { kind: "commits", shas: [a, c2] }, "\"Compare\" selects both commits");

    await openMenu(repo, "commit", { shas: [a, b] });
    const adjacent = await menuItems();
    check(adjacent.find((item) => /Squash/.test(item.text))?.disabled === false, "squash is possible for two consecutive commits");
    check(adjacent.some((item) => /^Cherry-pick 2 commits/.test(item.text) && item.disabled && /already in “main”/.test(item.text)), "cherry-picking several own commits is disabled, with a reason");
    await shot("menus-commits");
    await pick(/Squash 2 commits/);
    // The entry opens the rebase tool in squash mode: preview of the commits, the message below.
    await eventually(() => storeView(repo).then((view) => view?.center), { kind: "rebase", base: "", mode: "squash", shas: [a, b] }, "\"Squash 2 commits\" opens the rebase tool in squash mode");
    const squash = page.locator('[data-screen="rebase"]');
    await squash.locator('[role="listbox"]').waitFor({ timeout: 30_000 });
    await eventually(() => squash.locator('[role="option"] [data-summary]').allInnerTexts(), ["Erster lokaler Commit", "Zweiter lokaler Commit"], "the preview shows both commits, oldest on top");
    const squashForm = squash.locator("form");
    await eventually(() => squashForm.getByLabel("Summary").inputValue(), "Erster lokaler Commit", "the summary of the oldest is prefilled");
    check((await squashForm.getByLabel("Description").inputValue()).includes("Zweiter lokaler Commit"), "the description contains the message of the second");
    equal(await squash.getByText("is already on a remote").count(), 0, "local commits: no \"already pushed\" note");
    await squashForm.getByLabel("Summary").fill("Erster und zweiter Commit zusammen");
    await shot("dialog-squash");
    await squash.locator('button[data-action="start"]').click();
    equal(await dialog().count(), 0, "local commits: squashing starts without a confirmation");
    await waitToast(/Squash complete/, "success");
    await eventually(() => storeView(repo).then((view) => view?.center?.kind), "graph", "afterwards it goes back to the graph");
    const log = repo.git("log", "--format=%s", `${pushed}..HEAD`).split("\n");
    check(log.includes("Erster und zweiter Commit zusammen") && !log.includes("Zweiter lokaler Commit") && !log.includes("Erster lokaler Commit"), `two commits became one: ${JSON.stringify(log)}`);
    check(exists(repo, "a.txt"), "the content is preserved");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Tags: create (lightweight, annotated), push, delete locally and on the remote", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "tags" })));
    const sha = head(repo);
    await openMenu(repo, "commit", { shas: [sha] });
    await pick(/^Create tag here/);
    const create = await waitDialog(/^Create tag$/);
    await create.getByLabel("Name").fill("v1.0.0");
    check(/lightweight tag/.test(await create.innerText()), "without annotation: note about the lightweight tag");
    await create.getByLabel(/Annotation/).fill("Erste Fassung für das Messnetz");
    await eventually(() => create.innerText().then((value) => /Annotated tag/.test(value)), true, "with text: note about the annotated tag");
    await shot("dialog-tag");
    await create.getByRole("button", { name: "Create tag" }).click();
    await waitToast(/Annotated tag “v1\.0\.0” created/, "success");
    equal(repo.git("cat-file", "-t", "v1.0.0"), "tag", "v1.0.0 is an annotated tag (git cat-file -t)");
    check(repo.git("tag", "-l", "--format=%(contents)", "v1.0.0").includes("Erste Fassung"), "the annotation is in the tag");
    await closeToasts();

    await command("tag.create");
    const light = await waitDialog(/^Create tag$/);
    await light.getByLabel("Name").fill("v1.0.0");
    await eventually(() => light.getByRole("alert").count(), 1, "an existing tag name is rejected");
    await light.getByLabel("Name").fill("zwischenstand");
    await eventually(() => light.getByRole("alert").count(), 0, "a free name is valid");
    await page.keyboard.press("Enter");
    await waitToast(/Tag “zwischenstand” created/, "success");
    equal(repo.git("cat-file", "-t", "zwischenstand"), "commit", "zwischenstand is a lightweight tag");
    await closeToasts();
    await refresh(repo.repoId);

    await openMenu(repo, "tag", { name: "v1.0.0" });
    const items = await menuItems();
    equal(items.map((item) => item.text.replace(/ no branch.*$/, "")), ["Check out", "Create branch here …", "Push to origin", "Copy name", "Delete locally …", "Also delete on the remote …"], "entries of the tag menu");
    await shot("menus-tag");
    await pick(/^Push to origin/);
    await waitToast(/Tag “v1\.0\.0” pushed to origin/, "success");
    equal(remoteGit(repo, "tag", "-l"), "v1.0.0", "the tag is on the remote");
    await closeToasts();

    await openMenu(repo, "tag", { name: "zwischenstand" });
    await pick(/^Delete locally/);
    const local = await waitDialog(/^Delete tag “zwischenstand”\?$/);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await local.getByRole("button", { name: "Delete tag" }).click();
    await eventually(() => repo.git("tag", "-l"), "v1.0.0", "the local tag is deleted");
    await closeToasts();
    await refresh(repo.repoId);

    await openMenu(repo, "tag", { name: "v1.0.0" });
    await pick(/^Also delete on the remote/);
    const both = await waitDialog(/^Delete tag “v1\.0\.0” locally and on origin\?$/);
    await both.getByRole("button", { name: "Delete locally and on remote" }).click();
    await waitToast(/deleted locally and on origin/, "success");
    equal(repo.git("tag", "-l"), "", "no tag left locally");
    equal(remoteGit(repo, "tag", "-l"), "", "none on the remote either");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Stash: create, rename, apply, pop, delete, conflict on pop, single files only", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "stash" })));
    const stashList = () => gitTry(repo, "stash", "list", "--format=%gs").split("\n").filter(Boolean);
    check((await toolState("Stash")).disabled && /No changes to stash/.test(await toolHint("Stash")), "Stash is disabled without changes, with a reason");
    check((await toolState("Pop")).disabled && /No stash available/.test(await toolHint("Pop")), "Pop is disabled without a stash, with a reason");
    await shot("shell-toolbar-clean");

    repo.write("stationen.csv", `${read(repo, "stationen.csv")}W;Wetterturm;88\n`);
    await refresh(repo.repoId);
    await toolButton("Stash").click();
    await eventually(() => stashList().length, 1, "toolbar \"Stash\" creates a stash");
    await closeToasts();
    await refresh(repo.repoId);

    await openMenu(repo, "stash", { index: 0 });
    equal((await menuItems()).map((item) => item.text.replace(/ (the|Alt).*$/, "")), ["Apply", "Pop", "Rename …", "Create patch …", "Delete …"], "entries of the stash menu");
    await shot("menus-stash");
    await pick(/^Rename/);
    const rename = await waitDialog(/^Rename stash$/);
    await rename.getByLabel("Description").fill("Wetterturm nachtragen");
    await page.keyboard.press("Enter");
    await eventually(() => stashList()[0] ?? "", (value) => value.includes("Wetterturm nachtragen"), "the stash has the new description (git stash list)");
    await closeToasts();
    await refresh(repo.repoId);

    await openMenu(repo, "stash", { index: 0 });
    await pick(/^Apply/);
    await waitToast(/Apply stash complete/, "success");
    check(read(repo, "stationen.csv").includes("Wetterturm"), "Apply brings the change back");
    equal(stashList().length, 1, "and keeps the stash");
    await closeToasts();
    await refresh(repo.repoId);

    // Discard (confirmation), then pop.
    await openMenu(repo, "wip");
    await shot("menus-wip");
    await pick(/^Discard all changes/);
    const discard = await waitDialog(/^Discard all changes\?$/);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await discard.getByRole("button", { name: "Discard all" }).click();
    await eventually(() => repo.git("status", "--porcelain"), "", "everything discarded");
    await closeToasts();
    await refresh(repo.repoId);
    await toolButton("Pop").click();
    await eventually(() => stashList().length, 0, "Pop removes the stash");
    check(read(repo, "stationen.csv").includes("Wetterturm"), "Pop brings the change back");
    await closeToasts();

    // Stash only one file
    repo.write("README.md", `${read(repo, "README.md")}\nZweite Änderung.\n`);
    await refresh(repo.repoId);
    await openMenu(repo, "file", { paths: ["README.md"], source: { kind: "unstaged" } });
    const fileItems = await menuItems();
    equal(
      fileItems.map((item) => item.text.replace(/ (S|U|who changed.*)$/, "")),
      ["Stage", "Stash only this file", "Ignore", "Discard changes …", "History", "Blame", "View file", "Edit file", "Create new file …", "Delete file …", "Open in external diff tool", "Open in editor", "Show in Explorer", "Copy path", "Create patch from this file …"],
      "entries of the file menu (unstaged)",
    );
    await shot("menus-file");
    await pick(/^Stash only this file/);
    await eventually(() => stashList().length, 1, "\"Stash only this file\" creates a stash");
    await eventually(() => repo.git("status", "--porcelain").trim(), "M stationen.csv", "the other change stays in the working directory");
    equal(repo.git("stash", "show", "--name-only", "stash@{0}"), "README.md", "only README.md is in the stash");
    await closeToasts();
    await refresh(repo.repoId);

    // Delete with confirmation
    await openMenu(repo, "stash", { index: 0 });
    await pick(/^Delete/);
    const drop = await waitDialog(/^Delete stash “.*”\?$/);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await drop.getByRole("button", { name: "Delete stash" }).click();
    await eventually(() => stashList().length, 0, "the stash is deleted");
    await closeToasts();

    // Pop with conflict: the stash stays, no operation is running.
    repo.git("checkout", "-q", "--", ".");
    repo.write("README.md", "# Messnetz (aus dem Stash)\n\nGemeinsame Auswertung.\n");
    repo.git("stash", "push", "-q", "-m", "Titel ändern");
    commit(repo, "README.md", "# Messnetz (inzwischen committet)\n\nGemeinsame Auswertung.\n", "Titel anders geändert");
    await refresh(repo.repoId);
    await toolButton("Pop").click();
    const conflict = await waitToast(/Stash pop: conflict in one file/, "warning");
    check(/The stash is kept/.test(conflict?.text ?? "") && /no operation is running/.test(conflict?.text ?? ""), `dedicated text for stash conflicts: ${conflict?.text}`);
    equal(stashList().length, 1, "the stash is still there (git stash list)");
    check(repo.git("status", "--porcelain").includes("UU README.md"), "README.md is in conflict");
    await eventually(() => storeView(repo).then((view) => view?.selection?.kind), "wip", "the view jumps to the WIP row");
    await refresh(repo.repoId);
    await openMenu(repo, "file", { paths: ["README.md"], source: { kind: "unstaged" } });
    equal((await menuItems()).slice(0, 4).map((item) => item.text), ["Resolve conflict …", "Open in external merge tool", "Take current version", "Take incoming version"], "conflict file: dedicated entries");
    await pick(/^Take current version/);
    await waitToast(/“README\.md” resolved/, "success");
    check(read(repo, "README.md").includes("inzwischen committet"), "the current version is in the file");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Files: stage, unstage, discard, ignore, restore, copy path", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "dateien" })));
    repo.write("README.md", `${read(repo, "README.md")}\nÄnderung.\n`);
    repo.write("ausgabe-lokal/bericht.log", "lauf 1\n");
    repo.write("zwischen/werte.tmp", "1;2;3\n");
    await refresh(repo.repoId);

    await openMenu(repo, "file", { paths: ["README.md"], source: { kind: "unstaged" } });
    await pick(/^Stage/);
    await eventually(() => repo.git("diff", "--cached", "--name-only"), "README.md", "\"Stage\" stages the file");
    await refresh(repo.repoId);
    await openMenu(repo, "file", { paths: ["README.md"], source: { kind: "staged" } });
    check((await menuItems())[0]?.text.startsWith("Unstage"), "staged file: first entry \"Unstage\"");
    await shot("menus-file-staged");
    await pick(/^Unstage/);
    await eventually(() => repo.git("diff", "--cached", "--name-only"), "", "\"Unstage\" takes it out of the index");
    await refresh(repo.repoId);

    // Ignore: submenu, dialog with an editable pattern and a preview of the line.
    await openMenu(repo, "file", { paths: ["zwischen/werte.tmp"], source: { kind: "unstaged" } });
    await menuItem(/^Ignore/).click();
    await page.locator('[role="menu"]').nth(1).waitFor();
    const ignoreItems = await page.locator('[role="menu"]').nth(1).locator('[role="menuitem"]').evaluateAll((list) => list.map((item) => item.innerText.replace(/\s+/g, " ").trim()));
    equal(ignoreItems, ["Only this file … /zwischen/werte.tmp", "All files with the extension .tmp … *.tmp", "The folder zwischen/ … /zwischen/"], "Ignore: file, extension, folder – each with its pattern");
    await shot("menus-file-ignore");
    await menuItem(/^All files with the extension/).click();
    const ignore = await waitDialog(/^Ignore$/);
    equal(await ignore.getByLabel("Pattern", { exact: true }).inputValue(), "*.tmp", "the chosen pattern is prefilled");
    equal(await ignore.locator("[data-ignore-preview]").innerText(), "*.tmp", "the preview shows the new line");
    await ignore.getByRole("radio", { name: /The folder/ }).click();
    equal(await ignore.getByLabel("Pattern", { exact: true }).inputValue(), "/zwischen/", "the choice changes the pattern");
    await ignore.getByLabel("Pattern", { exact: true }).fill("zwischen/*.tmp");
    equal(await ignore.locator("[data-ignore-preview]").innerText(), "zwischen/*.tmp", "the pattern is editable, the preview follows");
    check((await ignore.getByRole("checkbox").count()) === 1 && /stop tracking/.test(await ignore.innerText()), "there is \"Also stop tracking\"");
    await shot("dialog-ignore");
    await ignore.getByRole("button", { name: "Ignore" }).click();
    await waitToast(/is now in \.gitignore/, "success");
    check(read(repo, ".gitignore").split("\n").includes("zwischen/*.tmp"), "the line is in .gitignore");
    check(!repo.git("status", "--porcelain").includes("werte.tmp"), "the file now counts as ignored");
    await closeToasts();
    await refresh(repo.repoId);

    // Ignore and stop tracking (tracked file)
    await openMenu(repo, "file", { paths: ["README.md"], source: { kind: "unstaged" } });
    await menuItem(/^Ignore/).click();
    await menuItem(/^Only this file …/).click();
    const tracked = await waitDialog(/^Ignore$/);
    equal(await tracked.getByRole("checkbox").getAttribute("aria-checked"), "true", "for a tracked file \"stop tracking\" is preselected");
    await tracked.getByRole("button", { name: "Ignore" }).click();
    await waitToast(/no longer tracked/, "success");
    check(repo.git("status", "--porcelain").includes("D  README.md"), `README.md leaves the index (staged deletion): ${repo.git("status", "--porcelain")}`);
    check(exists(repo, "README.md"), "the file stays on disk");
    repo.git("reset", "-q", "--hard");
    await closeToasts();
    await refresh(repo.repoId);

    // Discarding a file: the confirmation names it; undo brings it back.
    repo.write("stationen.csv", "überschrieben\n");
    await refresh(repo.repoId);
    await openMenu(repo, "file", { paths: ["stationen.csv"], source: { kind: "unstaged" } });
    const items = await menuItems();
    const discardIndex = items.findIndex((item) => /Discard/.test(item.text));
    check(discardIndex === 3 && !/Discard/.test(items[4]?.text ?? ""), "\"Discard changes\" is last in its group");
    await pick(/^Discard changes/);
    const discard = await waitDialog(/^Discard changes to “stationen\.csv”\?$/);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await discard.getByRole("button", { name: "Discard" }).click();
    await eventually(() => read(repo, "stationen.csv").includes("Schule Nord"), true, "the change is discarded");
    await closeToasts();
    // The undo state reloads on its own after discarding (repo:changed worktree → undo).
    await eventually(() => page.evaluate((repoId) => window.__gc.queryClient.getQueryData(["repo", repoId, "undo"])?.undo?.action ?? null, repo.repoId), "discard", "the undo state knows the discard without anyone reloading");
    // Click only once the UI has stopped loading – the way a human would.
    await app.settle();
    await toolButton("Undo").click();
    await eventually(() => read(repo, "stationen.csv"), "überschrieben\n", "Undo brings back the discarded change");
    await closeToasts();
    await refresh(repo.repoId);

    // Restore a version from a commit: asks, because the file is changed locally.
    const first = repo.git("rev-list", "--max-parents=0", "HEAD");
    await openMenu(repo, "file", { paths: ["stationen.csv"], source: { kind: "commit", sha: head(repo) } });
    const commitItems = await menuItems();
    equal(commitItems.slice(0, 2).map((item) => item.text.replace(/ from.*$/, "")), ["Restore this version …", "Compare with working directory"], "file from a commit: restore and compare");
    await shot("menus-file-commit");
    await pick(/^Restore this version/);
    const restore = await waitDialog(/^Overwrite “stationen\.csv” with the version from [0-9a-f]{7}\?$/);
    check(/uncommitted changes/.test(await restore.innerText()), "the confirmation warns about overwriting local changes");
    await restore.getByRole("button", { name: "Overwrite" }).click();
    await waitToast(/restored from .+ – it is staged/, "success");
    check(read(repo, "stationen.csv").includes("Schule Nord"), "the version from the commit is in the file");
    await closeToasts();
    void first;

    await openMenu(repo, "file", { paths: ["README.md"], source: { kind: "commit", sha: head(repo) } });
    await pick(/^Compare with working directory/);
    await eventually(() => storeView(repo).then((view) => view?.center), { kind: "diff", path: "README.md", source: { kind: "range", from: head(repo), to: null } }, "\"Compare with working directory\" opens the diff commit → working directory");
    await page.evaluate((tabId) => window.__gc.store.getState().closeCenter(tabId), repo.tabId);
    await openMenu(repo, "file", { paths: ["README.md"], source: { kind: "commit", sha: head(repo) } });
    await pick(/^Copy path/);
    await waitToast(/Path copied/, "success");
    await eventually(() => page.evaluate(() => window.__gcUi.lastCopiedText()), "README.md", "the path is copied");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Sync: fetch, pull, push, rejected → pull first, rejected → force, pull with conflict, pull with changes in the way", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "sync" })));
    // A longer file so that changes at the start and the end don't touch.
    commit(repo, "protokoll.md", `${Array.from({ length: 14 }, (_, index) => `Zeile ${index + 1}`).join("\n")}\n`, "Protokoll angelegt");
    repo.git("push", "-q", "origin", "main");
    await refresh(repo.repoId);
    await eventually(
      async () => (await toolState("Push")).disabled && /Nothing to push – origin\/main is up to date/.test(await toolHint("Push")),
      true,
      "Push is disabled: nothing to push",
    );

    // Fetch
    const remoteOne = repo.commitOnRemote({ message: "Nachtrag eins aus dem Remote" });
    await toolButton("Fetch").click();
    const fetched = await waitToast(/Fetch complete/, "success");
    check(/1 ref updated/.test(fetched?.text ?? ""), `Fetch reports what arrived: ${fetched?.text}`);
    equal(repo.git("rev-parse", "origin/main"), remoteOne, "origin/main is current after the fetch (git)");
    await eventually(() => toolButton("Pull").getAttribute("aria-label"), "Pull, 1 commit to pull", "Pull shows the counter \"1 commit to pull\"");
    await eventually(footer, (value) => /Fetch just now/.test(value), "the status bar shows the last fetch as relative time");
    await shot("shell-toolbar-behind");
    await closeToasts();

    // Pull by shortcut
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Control+Shift+D");
    const pulled = await waitToast(/Pull complete/, "success");
    check(/Fast-forward/.test(pulled?.text ?? ""), `Pull reports the fast-forward: ${pulled?.text}`);
    equal(head(repo), remoteOne, "after the pull main is at the remote's commit");
    await closeToasts();

    // Push
    const local = commit(repo, "lokal.txt", "eins\n", "Lokaler Commit eins");
    await refresh(repo.repoId);
    await eventually(() => toolButton("Push").getAttribute("aria-label"), "Push, 1 commit to push", "Push shows the counter");
    await toolButton("Push").click();
    await waitToast(/Pushed to origin\/main/, "success");
    equal(remoteGit(repo, "rev-parse", "refs/heads/main"), local, "the commit is on the remote");
    await closeToasts();

    // Rejected → "Pull first" → afterwards it pushes on its own.
    const remoteTwo = repo.commitOnRemote({ file: "docs/zwei.md", message: "Nachtrag zwei aus dem Remote" });
    commit(repo, "lokal.txt", "eins\nzwei\n", "Lokaler Commit zwei");
    await refresh(repo.repoId);
    await toolButton("Push").click();
    const rejected = await waitDialog(/^Push rejected$/);
    const rejectedText = (await rejected.innerText()).replace(/\s+/g, " ");
    check(/Pull first/.test(rejectedText) && /Force push/.test(rejectedText), `the dialog offers "Pull first" and "Force push": ${rejectedText}`);
    equal(await focusedText().then((text) => text.startsWith("Pull first")), true, "the focus is on the safe option");
    await shot("dialog-push-rejected");
    await rejected.getByRole("button", { name: /^Pull first/ }).click();
    await waitToast(/Pushed to origin\/main/, "success", 40_000);
    equal(remoteGit(repo, "rev-parse", "refs/heads/main"), head(repo), "after \"Pull first\" it is pushed");
    check(repo.git("merge-base", "--is-ancestor", remoteTwo, "HEAD") === "", "the remote's commit is included");
    await closeToasts();
    await refresh(repo.repoId);

    // Rejected → "Force push": the confirmation explains --force-with-lease and names what gets overwritten.
    const remoteThree = repo.commitOnRemote({ file: "docs/drei.md", message: "Nachtrag drei, wird überschrieben" });
    const localThree = commit(repo, "lokal.txt", "eins\nzwei\ndrei\n", "Lokaler Commit drei");
    await refresh(repo.repoId);
    await toolButton("Push").click();
    await (await waitDialog(/^Push rejected$/)).getByRole("button", { name: /^Force push/ }).click();
    const force = await waitDialog(/^Force push to origin\/main\?$/, 30_000);
    const forceText = (await force.innerText()).replace(/\s+/g, " ");
    check(/--force-with-lease/.test(forceText) && /only overwrites the remote branch if it still has the state/.test(forceText), `the confirmation explains --force-with-lease in one sentence: ${forceText}`);
    check(/has 1 commit that is missing locally/.test(forceText) && forceText.includes("Nachtrag drei, wird überschrieben"), "it names what is overwritten on the remote");
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await shot("dialog-push-force");
    await force.getByRole("button", { name: "Force push" }).click();
    await waitToast(/Force-pushed to origin\/main/, "success");
    equal(remoteGit(repo, "rev-parse", "refs/heads/main"), localThree, "the remote is at the local commit");
    check(remoteGit(repo, "branch", "--contains", remoteThree) === "", "the overwritten commit no longer hangs on any branch of the remote");
    await closeToasts();
    await refresh(repo.repoId);

    // Pull with changes in the way → "Stash first, then pull" → the changes come back.
    repo.commitOnRemote({ file: "protokoll.md", content: `${read(repo, "protokoll.md")}Zeile 15 aus dem Remote\n`, message: "Protokoll fortgeführt" });
    repo.write("protokoll.md", read(repo, "protokoll.md").replace("Zeile 1\n", "Zeile 1 (lokal ergänzt)\n"));
    await refresh(repo.repoId);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Control+Shift+D");
    const dirty = await waitDialog(/^Uncommitted changes are in the way of the pull$/, 30_000);
    check((await dirty.innerText()).includes("protokoll.md"), "the dialog names the affected file");
    await shot("dialog-pull-dirty");
    await dirty.getByRole("button", { name: /^Stash first, then pull/ }).click();
    await waitToast(/Pull complete/, "success", 40_000);
    await eventually(() => repo.git("stash", "list"), "", "the stash is applied again after the pull");
    const merged = read(repo, "protokoll.md");
    check(merged.includes("Zeile 1 (lokal ergänzt)") && merged.includes("Zeile 15 aus dem Remote"), "the local change and the remote state are both in the file");
    await noErrorToast("no error in the flow \"stash, pull, bring back\"");
    repo.git("checkout", "-q", "--", ".");
    await closeToasts();
    await refresh(repo.repoId);

    // Pull with conflict → WIP view.
    repo.commitOnRemote({ file: "stationen.csv", content: "kürzel;name;höhe_m\nN;Schule Nord (Remote);41\n", message: "Stationen vom Remote geändert" });
    commit(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord (lokal);41\n", "Stationen lokal geändert");
    await refresh(repo.repoId);
    await page.evaluate((tabId) => window.__gc.store.getState().clearSelection(tabId), repo.tabId);
    await command("sync.pull");
    await waitToast(/Pull: conflict in one file/, "warning", 40_000);
    check(repo.git("status", "--porcelain").includes("UU stationen.csv"), "git reports the conflict");
    await eventually(() => storeView(repo).then((view) => view?.selection?.kind), "wip", "the view jumps to the WIP row");
    repo.git("merge", "--abort");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Sync: no remote, unreachable, cancelling a running fetch", async () => {
    // No remote: toolbar disabled with a reason; the action offers "Add remote".
    const empty = await open(made(makeEmptyRepo({ name: "ohne-remote" })));
    for (const name of ["Pull", "Push", "Fetch"]) {
      check((await toolState(name)).disabled && /No remote set up/.test(await toolHint(name)), `${name} is disabled without a remote, with a reason`);
    }
    check((await toolState("Branch")).disabled && /No commit yet/.test(await toolHint("Branch")), "Branch is disabled without a commit, with a reason");
    check((await toolState("Undo")).disabled && /Nothing to undo/.test(await toolHint("Undo")), "Undo is disabled when empty, with a reason");
    equal(await available("sync.push"), false, "the \"Push\" command is not available without a remote");
    equal(await available("branch.create"), false, "\"New branch\" is not available without a commit");
    await shot("shell-toolbar-empty");
    await page.evaluate((repoId) => void window.__gcUi.actions.sync.fetchAll(repoId), empty.repoId);
    const none = await waitToast(/Fetch: no remote set up/, "warning");
    check(/Add remote/.test(none?.text ?? ""), "the message offers \"Add remote\"");
    await page.locator("[data-toast]").getByRole("button", { name: "Add remote" }).click();
    await eventually(() => page.evaluate(() => window.__gc.store.getState().overlay?.kind ?? null), "add_remote", "\"Add remote\" opens the remote dialog");
    await page.evaluate(() => window.__gc.store.getState().closeOverlay());
    await closeToasts();

    // Unreachable: a remote on a closed port.
    const repo = await open(made(makeCleanRepoWithRemote({ name: "netz" })));
    repo.git("remote", "add", "abseits", "http://127.0.0.1:9/nichts.git");
    await refresh(repo.repoId);
    await openMenu(repo, "remote", { name: "abseits" });
    equal((await menuItems()).map((item) => item.text), ["Fetch from “abseits”", "Edit …", "Copy URL", "Remove …"], "entries of the remote menu");
    await shot("menus-remote");
    await pick(/^Fetch from/);
    const offline = await waitToast(/Fetch from abseits failed/, "danger", 60_000);
    check(/cannot be reached|can’t be reached|connection|network/i.test(offline?.text ?? ""), `the message explains that the remote cannot be reached: ${offline?.text}`);
    await shot("shell-toast-offline");
    await closeToasts();

    // "Edit" opens the remote dialog in edit mode; "Remove" asks first.
    await openMenu(repo, "remote", { name: "abseits" });
    await pick(/^Edit/);
    await eventually(() => page.evaluate(() => window.__gc.store.getState().overlay), { kind: "add_remote", edit: "abseits" }, "\"Edit\" opens the remote dialog for this remote");
    await page.evaluate(() => window.__gc.store.getState().closeOverlay());
    await openMenu(repo, "remote", { name: "abseits" });
    await pick(/^Copy URL/);
    await eventually(() => page.evaluate(() => window.__gcUi.lastCopiedText()), "http://127.0.0.1:9/nichts.git", "\"Copy URL\" copies the address");
    await closeToasts();
    await openMenu(repo, "remote", { name: "abseits" });
    await pick(/^Remove/);
    const remove = await waitDialog(/^Remove remote “abseits”\?$/);
    equal(await focusedText(), "Cancel", "focus on \"Cancel\"");
    await remove.getByRole("button", { name: "Remove remote" }).click();
    await eventually(() => repo.git("remote"), "origin", "the remote is removed (git remote)");
    await closeToasts();
    await refresh(repo.repoId);

    // Running fetch: busy in the toolbar, progress in the status bar, cancel.
    repo.git("config", "remote.origin.uploadpack", "sleep 30; git-upload-pack");
    await toolButton("Fetch").click();
    await eventually(() => toolState("Fetch").then((state) => state.busy), true, "Fetch is \"busy\" during the job");
    await eventually(() => page.locator('footer [role="progressbar"]').count(), 1, "the status bar shows the job with progress");
    check((await toolState("Pull")).disabled && /Fetch is running/.test(await toolHint("Pull")), "Pull is disabled meanwhile: \"Fetch is running\"");
    await toolButton("Fetch").click({ force: true });
    await page.waitForTimeout(200);
    equal(await page.evaluate(() => Object.keys(window.__gc.store.getState().jobs).length), 1, "a second click does not start a second fetch");
    await shot("shell-toolbar-busy");
    const started = Date.now();
    await page.locator("footer").getByRole("button", { name: "Cancel Fetch" }).click();
    await eventually(() => page.locator('footer [role="progressbar"]').count(), 0, "after \"Cancel\" the job disappears");
    check(Date.now() - started < 15_000, `the cancellation takes effect at once (${Date.now() - started} ms), not only after 30 s`);
    await waitToast(/Fetch cancelled/, "info");
    await noErrorToast("a cancelled fetch is not an error");
    await eventually(() => toolState("Fetch").then((state) => state.busy), false, "Fetch is free again");
    repo.git("config", "--unset", "remote.origin.uploadpack");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Credentials: real prompt from Git over HTTP (username, password, rejected, cancelled)", async () => {
    const seen = [];
    const server = http.createServer((request, response) => {
      seen.push(request.headers.authorization ?? null);
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Messnetz"' });
      response.end("Authentication required");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const port = server.address().port;
    const repo = await open(made(makeCleanRepoWithRemote({ name: "anmeldung" })));
    repo.git("remote", "add", "geschuetzt", `http://127.0.0.1:${port}/messnetz.git`);
    await refresh(repo.repoId);

    // Cancel: no error.
    await openMenu(repo, "remote", { name: "geschuetzt" });
    await pick(/^Fetch from/);
    const user = await waitDialog(/^Username for the remote$/, 30_000);
    check((await user.innerText()).includes(`127.0.0.1:${port}`), "the dialog names the host");
    const userField = user.getByLabel("Username");
    equal(await userField.getAttribute("type"), "text", "the username is an ordinary field");
    equal(await userField.getAttribute("autocomplete"), "off", "without autocomplete");
    await eventually(() => page.locator('footer [role="progressbar"]').count(), 1, "while Git waits, the job runs in the status bar");
    await page.keyboard.press("Escape");
    await noDialog();
    await eventually(() => page.locator('footer [role="progressbar"]').count(), 0, "cancelling the prompt ends the job");
    await noErrorToast("a cancelled prompt is not an error");

    // Enter username and password (keyboard only); the server rejects → understandable error.
    await openMenu(repo, "remote", { name: "geschuetzt" });
    await pick(/^Fetch from/);
    await waitDialog(/^Username for the remote$/, 30_000);
    await page.keyboard.type("lena");
    await page.keyboard.press("Enter");
    const password = await waitDialog(/^Sign in to the remote$/, 30_000);
    const passwordText = (await password.innerText()).replace(/\s+/g, " ");
    check(/asks for the password for lena/.test(passwordText) && /access token/.test(passwordText), `the dialog names host and user and mentions tokens: ${passwordText}`);
    const secret = password.getByLabel("Password or token");
    equal(await secret.getAttribute("type"), "password", "the password is entered masked");
    equal(await secret.getAttribute("autocomplete"), "new-password", "password field without autocomplete");
    const canRemember = await page.evaluate(() => window.__gc.store.getState().credentialQueue[0]?.canRemember ?? null);
    equal((await password.getByText("Remember in the system keychain").count()) === 1, canRemember === true, "\"Remember\" exists exactly when the keychain is reachable");
    await shot("credential-real-password");
    await page.keyboard.type("falsch-geraten");
    await page.keyboard.press("Enter");
    const failed = await waitToast(/Fetch from geschuetzt failed/, "danger", 60_000);
    check(/signing in|sign in|credentials|username|password/i.test(failed?.text ?? ""), `the message explains the failed sign-in: ${failed?.text}`);
    check(seen.some((value) => value === `Basic ${Buffer.from("lena:falsch-geraten").toString("base64")}`), "Git sent exactly the entered credentials to the server");
    await noDialog("after the answer no prompt is open any more");
    equal(await page.evaluate(() => window.__gc.store.getState().credentialQueue.length), 0, "the queue is empty");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Edge cases: long names, very many branches, set and unset upstream", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "grenzen" })));
    const long = "feature/sehr-langer-name-fuer-die-auswertung-der-station-nord-2026";
    equal(long.length >= 60, true, "the long name has at least 60 characters");
    repo.git("branch", long);
    const tip = head(repo);
    gitRaw(repo, ["update-ref", "--stdin"], `${Array.from({ length: 600 }, (_, index) => `create refs/heads/viele/zweig-${String(index + 1).padStart(3, "0")} ${tip}`).join("\n")}\n`);
    repo.git("checkout", "-q", "-b", "lokal/ohne-upstream");
    commit(repo, "x.txt", "x\n", "Ein sehr langer Commit-Titel, der weit über jede vernünftige Länge hinausgeht und trotzdem weder das Menü noch die Rückfrage noch die Meldung sprengen darf – ".repeat(2).slice(0, 200));
    await refresh(repo.repoId);

    // Long names: the menu keeps its width, the full name is in the tooltip.
    await openMenu(repo, "drop", { source: long, target: "origin/main" });
    const box = await page.locator('[role="menu"]').first().boundingBox();
    check(box.width <= 480 && box.x + box.width <= 1440, `the menu stays at most 480 px wide (${Math.round(box.width)} px)`);
    const items = await menuItems();
    check(items.every((item) => !item.text.includes(long)) && items[0].title.includes(long), "long names are shortened in the middle, the full name is in the tooltip");
    check(items.some((item) => /Push/.test(item.text)), "the target is a remote branch: \"Push\" is offered");
    check(items.some((item) => /into “origin\/main”/.test(item.text) && item.disabled && /the target must be a local branch/.test(item.text)), "\"Merge\" into a remote branch is disabled, with a reason");
    equal(await overflow(), { x: 0, y: 0 }, "no page overflow");
    await shot("menus-drop-long");
    await closeMenu();

    await openMenu(repo, "branch", { name: long });
    await pick(/^Delete .+ …$/);
    const confirm = await waitDialog(/^Delete .*\?$/);
    const dialogBox = await confirm.boundingBox();
    check(dialogBox.width <= 400 && (await confirm.evaluate((node) => node.scrollWidth <= node.clientWidth)), "the confirmation with a long name keeps its width");
    await shot("dialog-long-name");
    await page.keyboard.press("Escape");
    await noDialog();

    // Very long commit title in the copy toast.
    await openMenu(repo, "commit", { shas: [head(repo)] });
    await pick(/^Copy message/);
    await waitToast(/Message copied/, "success");
    const toastBox = await page.locator("[data-toast]").first().boundingBox();
    check(toastBox.width <= 340, `the message stays narrow (${Math.round(toastBox.width)} px)`);
    await closeToasts();

    // Very many entries: the pick list renders at most 200 and narrows down by filter.
    await command("branch.checkout");
    const picker = await waitDialog(/^Check out branch$/);
    await eventually(() => picker.getByRole("option").count(), 200, "of more than 600 branches, 200 are in the list");
    // The rest hint is still hardcoded German in src/app/dialogs.tsx.
    check(/more – type to narrow down/.test(await picker.innerText()), "a hint names the rest");
    await page.keyboard.type("zweig-417");
    await eventually(() => picker.getByRole("option").count(), 1, "the filter narrows down to one match");
    await shot("dialog-pick-branch");
    await page.keyboard.type("x");
    await eventually(() => picker.innerText().then((value) => /No match for “zweig-417x”/.test(value)), true, "no match: the list says so");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await eventually(() => branch(repo), "viele/zweig-417", "Enter checks out the filtered branch (git)");
    await closeToasts();
    repo.git("checkout", "-q", "lokal/ohne-upstream");
    await refresh(repo.repoId);

    // No upstream: Pull disabled with a reason, Push asks; set the upstream via the list, then unset it.
    check((await toolState("Pull")).disabled && /no upstream/.test(await toolHint("Pull")), "Pull is disabled without an upstream, with a reason");
    check(!(await toolState("Push")).disabled && /asks where to/.test(await toolHint("Push")), "Push stays possible and says it asks for the target");
    await eventually(footer, (value) => /no upstream/.test(value), "the status bar shows \"no upstream\"");
    await shot("shell-toolbar-no-upstream");
    await openMenu(repo, "branch", { name: "lokal/ohne-upstream" });
    await pick(/^Set upstream/);
    const upstream = await waitDialog(/^Set upstream for “lokal\/ohne-upstream”$/);
    equal(await upstream.getByRole("option").count(), 2, "the remote branches are offered");
    await page.keyboard.type("export");
    await page.keyboard.press("Enter");
    await eventually(() => repo.git("rev-parse", "--abbrev-ref", "lokal/ohne-upstream@{upstream}"), "origin/feature/export", "the upstream is set (git)");
    await closeToasts();
    await refresh(repo.repoId);
    await openMenu(repo, "branch", { name: "lokal/ohne-upstream" });
    const withUpstream = await menuItems();
    check(withUpstream.some((item) => /^Change upstream …/.test(item.text) && /origin\/feature\/export/.test(item.text)), "with an upstream the entry is called \"Change upstream\" and names it");
    await pick(/^Unset upstream/);
    // Without a match `git config --get-regexp` exits with 1 – here that means: no upstream configured any more.
    const upstreamConfig = () => {
      try {
        return repo.git("config", "--get-regexp", "^branch\\.lokal/ohne-upstream\\.");
      } catch {
        return "";
      }
    };
    await eventually(upstreamConfig, "", "the upstream is unset (git config)");
    await closeToasts();
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Commands: unique shortcuts, open in …, hide and solo", async () => {
    const repo = await open(made(makeCleanRepoWithRemote({ name: "befehle" })));
    const list = await page.evaluate(() => window.__gcUi.commands());
    const byShortcut = new Map();
    for (const item of list) {
      if (!item.shortcut) continue;
      check(!byShortcut.has(item.shortcut), `shortcut ${item.shortcut} is used twice: ${item.id} and ${byShortcut.get(item.shortcut)}`);
      byShortcut.set(item.shortcut, item.id);
    }
    const expected = { "branch.create": "Mod+B", "sync.pull": "Mod+Shift+D", "sync.push": "Mod+Shift+P", "sync.fetch": "Mod+Shift+L", "stash.create": "Alt+S", "stash.pop": "Alt+P", "repo.undo": "Mod+Z", "repo.redo": "Mod+Y", "repo.openEditor": "Alt+E", "repo.openTerminal": "Alt+T", "repo.openFileManager": "Alt+D", "selection.menu": "Mod+." };
    for (const [id, shortcut] of Object.entries(expected)) equal(list.find((item) => item.id === id)?.shortcut ?? null, shortcut, `shortcut of ${id}`);
    for (const id of ["branch.checkout", "branch.merge", "branch.rebase", "branch.delete", "branch.rename", "tag.create", "tag.push", "tag.delete", "commit.reword", "sync.push.force", "stash.apply", "stash.drop", "commit.reset.hard", "commit.revert", "commit.cherryPick"]) {
      check(list.some((item) => item.id === id), `the command ${id} is in the registry`);
    }
    equal(await available("stash.create"), false, "\"Stash changes\" is not available without changes");
    equal(await available("commit.revert"), false, "\"Revert\" is not available without a selected commit");

    // Open in …: the core starts the program from the settings – here a harmless one (cmd /c exit).
    await app.invoke("settings_set", { patch: { externalEditor: "cmd /c exit", externalTerminal: "cmd /c exit" } });
    await page.evaluate(() => document.activeElement?.blur?.());
    const events = await app.recordEvents(["log:appended"]);
    await page.keyboard.press("Alt+e");
    await page.waitForTimeout(600);
    await noErrorToast("Alt+E (open in editor) reports no error");
    await page.keyboard.press("Alt+t");
    await page.waitForTimeout(600);
    await noErrorToast("Alt+T (open in terminal) reports no error");
    await events.stop();
    await app.invoke("settings_set", { patch: { externalEditor: "gibt-es-nicht-programm {path}" } });
    await page.keyboard.press("Alt+e");
    const missing = await waitToast(/Open in editor failed/, "danger");
    check(/gibt-es-nicht-programm/.test(missing?.text ?? ""), `the message names the missing program: ${missing?.text}`);
    await app.invoke("settings_set", { patch: { externalEditor: null, externalTerminal: null } });
    await closeToasts();

    // Hide and solo only change the view.
    const before = repo.git("for-each-ref");
    await openMenu(repo, "branch", { name: "feature/export" });
    await pick(/^Hide in graph/);
    await eventually(() => app.invoke("view_state_get", { repoId: repo.repoId }).then((view) => view.hiddenRefs), ["refs/heads/feature/export"], "\"Hide\" is in the core's view state");
    await refresh(repo.repoId);
    await openMenu(repo, "branch", { name: "feature/export" });
    check((await menuItems()).some((item) => /^Show in graph again/.test(item.text)), "afterwards the entry is called \"Show in graph again\"");
    await pick(/^Solo/);
    await eventually(() => app.invoke("view_state_get", { repoId: repo.repoId }).then((view) => [view.hiddenRefs, view.soloRefs]), [[], ["refs/heads/feature/export"]], "Solo cancels the hiding and sets the ref solo");
    await refresh(repo.repoId);
    await openMenu(repo, "branch", { name: "feature/export" });
    await pick(/^End solo/);
    await eventually(() => app.invoke("view_state_get", { repoId: repo.repoId }).then((view) => view.soloRefs), [], "\"End solo\" empties the list");
    equal(repo.git("for-each-ref"), before, "nothing changed in the repository");
    equal(app.consoleErrors, [], "console errors");
  });

  // -------------------------------------------------------------------------
  await section("Screenshots: toolbar and menus in the rich repository, light and 960×600", async () => {
    const repo = await open(made(makeRichRepo()));
    await refresh(repo.repoId);
    equal(await toolButton("Pull").getAttribute("aria-label"), "Pull, 1 commit to pull", "Pull counter in the rich repository");
    equal(await toolButton("Push").getAttribute("aria-label"), "Push, 2 commits to push", "Push counter in the rich repository");
    await shot("shell-toolbar");
    // The main screenshot of the repo view. No script wrote it any more; what was left was an image
    // from the time when the sidebar, graph and commit panel were still placeholders.
    await shot("shell");
    await toolbar().getByRole("button", { name: "Pull: options" }).click();
    await page.locator('[role="menu"]').first().waitFor();
    check((await menuItems()).length >= 4, "the pull menu shows the modes and fetch");
    await shot("shell-toolbar-pull-menu");
    await closeMenu();
    await openMenu(repo, "tag", { name: "v0.1.0" });
    await closeMenu();
    await openMenu(repo, "drop", { source: "main", target: "origin/feature/wind-diagramm" });
    await shot("menus-drop-remote");
    await closeMenu();
    await openMenu(repo, "branches", { names: ["bugfix/sensor-ausfall", "experiment/alte-auswertung", "feature/luftdruck"] });
    await shot("menus-branches");
    await closeMenu();

    await app.setTheme("light");
    await openMenu(repo, "branch", { name: "feature/wind-diagramm" });
    await shot("menus-branch-light");
    await closeMenu();
    await shot("shell-toolbar-light");
    await app.setTheme("dark");

    await app.setSize(960, 600);
    await page.waitForTimeout(300);
    equal(await overflow(), { x: 0, y: 0 }, "960×600: no overflow");
    const clipped = await toolbar().evaluate((bar) => bar.scrollWidth - bar.clientWidth);
    check(clipped <= 0, `960×600: the toolbar fits (${clipped} px too wide)`);
    await shot("shell-toolbar-min");
    await openMenu(repo, "commit", { shas: [repo.info.shas.head], x: 700, y: 300 });
    const box = await page.locator('[role="menu"]').first().boundingBox();
    check(box.x >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `960×600: the menu stays inside the window (${JSON.stringify(box)})`);
    await shot("menus-commit-min");
    await closeMenu();
    await app.setSize(1440, 900);
    equal(app.consoleErrors, [], "console errors");
  });

  await app.close();
  app = null;

  // -------------------------------------------------------------------------
  await section("Credential dialog: all four kinds via the scenario, orphaned prompt", async () => {
    app = await launchApp({ show, width: 1440, height: 900, theme: "dark", scenario: "Shell.credential", params: { kind: "password" } });
    page = app.page;
    const password = await waitDialog(/^Sign in to the remote$/);
    check((await password.getByText("Remember in the system keychain").count()) === 1, "canRemember: \"Remember\" is offered");
    check((await password.getByText("Show input").count()) === 1, "there is \"Show input\"");
    equal(await password.getByLabel("Password or token").evaluate((input) => document.activeElement === input), true, "the focus is in the field");
    await page.keyboard.type("geheim-123");
    await shot("credential-password");
    // Orphaned: the core does not know this prompt (not_found) – the dialog closes silently.
    await page.keyboard.press("Enter");
    await noDialog("the orphaned prompt closes");
    await page.waitForTimeout(400);
    equal(await toasts(), [], "without an error message");

    for (const [kind, title, file] of [
      ["username", /^Username for the remote$/, "credential-username"],
      ["passphrase", /^Passphrase for the SSH key$/, "credential-passphrase"],
    ]) {
      await app.runScenario("Shell.credential", { kind });
      const box = await waitDialog(title);
      if (kind === "username") {
        check((await box.getByText("Remember in the system keychain").count()) === 0, "without canRemember there is no \"Remember\"");
        check((await box.getByText("Show input").count()) === 0, "the username is not masked");
      } else {
        check((await box.innerText()).includes("id_ed25519_messnetz"), "the passphrase prompt names the key");
        equal(await box.getByLabel("Passphrase").getAttribute("type"), "password", "the passphrase is entered masked");
      }
      await shot(file);
      await page.keyboard.press("Escape");
      await noDialog();
    }

    await app.runScenario("Shell.credential", { kind: "host_key" });
    const host = await waitDialog(/^Unknown SSH host$/);
    equal(await focusedText(), "Cancel", "host fingerprint: focus on \"Cancel\"");
    const hostText = (await host.innerText()).replace(/\s+/g, " ");
    check(/Compare first, then trust/.test(hostText) && /someone could be reading the connection/.test(hostText), "clear warning before trusting");
    equal(await host.locator("[data-fingerprint]").innerText(), "SHA256:Wq7mK2xk0c1dYtH3nV9fJ5uRz8aLpE4sBvT6gQoXyZc", "the fingerprint is shown");
    equal(await host.locator("[data-fingerprint]").evaluate((node) => getComputedStyle(node).userSelect), "text", "the fingerprint is selectable");
    check((await host.getByRole("button", { name: "Trust host and connect" }).count()) === 1, "the button says what it does");
    await shot("credential-host-key");
    await app.setTheme("light");
    await shot("credential-host-key-light");
    await app.setTheme("dark");
    await page.keyboard.press("Enter");
    await noDialog("Enter (on \"Cancel\") rejects and closes");

    await app.runScenario("Shell.credential", { kind: "password", queue: 1 });
    const queued = await waitDialog(/^Sign in to the remote$/);
    check(/3 more requests are waiting/.test(await queued.innerText()), "several prompts: the dialog says how many are still waiting");
    await app.setSize(960, 600);
    await shot("credential-password-min");
    for (const title of [/^Username/, /^Passphrase/, /^Unknown SSH host$/]) {
      await page.keyboard.press("Escape");
      await waitDialog(title);
    }
    await page.keyboard.press("Escape");
    await noDialog("the prompts come one after another and are gone at the end");
    equal(app.consoleErrors, [], "console errors");
    await app.close();
    app = null;
  });

  // -------------------------------------------------------------------------
  await section("Running operation at start: conflict repository", async () => {
    app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
    page = app.page;
    const repo = await open(made(makeConflictRepo()));
    await eventually(footer, (value) => /merge in progress/i.test(value), "the status bar shows the running merge, even if it was not started in the app");
    for (const name of ["Pull", "Push", "Branch"]) check((await toolState(name)).disabled, `${name} is disabled during the merge`);
    equal(await available("operation.abort"), true, "\"Abort running action\" is available");
    equal(await available("operation.continue"), false, "\"Continue\" is not available while conflicts are open");
    await openMenu(repo, "wip");
    check((await menuItems()).some((item) => /^Create stash/.test(item.text) && item.disabled && /resolve the conflicts first/.test(item.text)), "WIP menu: stash is disabled while conflicts are open");
    await closeMenu();
    // Discarding everything is not possible in the middle of a merge: the message offers the abort.
    await page.evaluate((repoId) => void window.__gcUi.actions.files.discardPaths(repoId, null), repo.repoId);
    await (await waitDialog(/^Discard all changes\?$/)).getByRole("button", { name: "Discard all" }).click();
    const refused = await waitToast(/Discarding is not possible right now/, "warning");
    check(/Abort merge/.test(refused?.text ?? ""), `the message offers "Abort merge": ${refused?.text}`);
    await page.locator("[data-toast]").getByRole("button", { name: /Abort merge/ }).click();
    await (await waitDialog(/^Abort merge\?$/)).getByRole("button", { name: "Abort merge" }).click();
    await eventually(() => repo.git("status", "--porcelain"), "", "the merge is aborted, the working directory clean");
    await eventually(footer, (value) => !/merge in progress/i.test(value), "the status bar no longer shows a merge");
    equal(app.consoleErrors, [], "console errors");
  });

  current = "Console";
  if (app) check(app.consoleErrors.length === 0, `Console errors:\n${app.consoleErrors.join("\n")}`);
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/interaction-error.png").catch(() => undefined);
  await app?.close().catch(() => undefined);
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // Cleaning up must not hide the report.
    }
  }
}
console.log(failures.length ? `\nInteraction check failed: ${failures.length} deviations.\n${failures.map((item) => ` - ${item}`).join("\n")}` : "\nInteraction check green.");
process.exit(failures.length ? 1 : 0);
