/**
 * Git LFS in the real app over WebDriver: track and untrack patterns, fetch LFS files against a
 * local bare repository, clean up local storage (1.0), and LFS file locks against a local stand-in
 * for the LFS locking API (scripts/e2e-wd/fixtures/lfs-lock-server.mjs): lock list with filter,
 * lock/unlock from the file context menu, lock symbol with owner tooltip, force unlock with prompt,
 * commit warning, server without locking (1.1).
 *
 *   node scripts/e2e-wd/features/lfs.mjs
 *   E2E_WD_ONLY=lock node scripts/e2e-wd/features/lfs.mjs
 *
 * Every check also looks at Git itself: .gitattributes, `git lfs ls-files`, .git/lfs/objects, the
 * working directory, and the lock server's state. Needs Git LFS installed; without it every
 * scenario but "without Git LFS" is reported as skipped.
 *
 * The lock server runs in this process: Git commands that reach it must run asynchronously
 * (`gitAsync`), or the event loop blocks and Git LFS waits forever.
 */
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { startLockServer } from "../fixtures/lfs-lock-server.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LFS_VERSION = (() => {
  try {
    return execFileSync("git", ["lfs", "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
})();
const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
/** Who "we" are for the lock server – the identity the harness gives the app. */
const ME = "Lena Hartmann";
const OTHER = "Jonas Berg";

// ---------------------------------------------------------------------------------------------
// Git and file helpers
// ---------------------------------------------------------------------------------------------

const envFor = (fx) => ({ ...process.env, ...gitIsolationEnv(path.join(fx.root, "gitconfig")) });
const git = (fx, cwd, ...args) => execFileSync("git", args, { cwd, env: envFor(fx), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** For commands that reach the lock server in this process. */
const gitAsync = async (fx, cwd, ...args) => (await execFileAsync("git", args, { cwd, env: envFor(fx), encoding: "utf8" })).stdout.trim();

const attributes = (repo) => {
  const file = path.join(repo, ".gitattributes");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
};
const tracked = (repo) => attributes(repo).filter((line) => /filter=lfs/.test(line)).map((line) => line.split(/\s+/)[0]);

/** Fixed "random" binary bytes (starts with NUL). */
const blob = (seed, size) => {
  const out = Buffer.alloc(size);
  let block = crypto.createHash("sha256").update(String(seed)).digest();
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(out, offset, 0, Math.min(block.length, size - offset));
    block = crypto.createHash("sha256").update(block).digest();
  }
  out[0] = 0;
  return out;
};
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const lfsObjects = (repo) => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (/^[0-9a-f]{64}$/.test(entry.name)) found.push(entry.name);
    }
  };
  walk(path.join(repo, ".git", "lfs", "objects"));
  return found.sort();
};
const writeFile = (repo, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};

/**
 * Repository "messnetz" (with bare origin) where `*.psd` goes through LFS and two PSD files are
 * committed. `lockUrl`: LFS endpoint for the locking API (`lfs.url`).
 */
function makeLfsRepo({ lockUrl = null } = {}) {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  git(fx, fx.path, "lfs", "install", "--local");
  git(fx, fx.path, "lfs", "track", "*.psd");
  writeFile(fx.path, "daten/karte.psd", blob("karte", 4096));
  writeFile(fx.path, "daten/plan.psd", blob("plan", 4096));
  writeFile(fx.path, "daten/logo.psd", blob("logo", 2048));
  git(fx, fx.path, "add", ".gitattributes", "daten");
  git(fx, fx.path, "commit", "-q", "-m", "Karten über LFS abgelegt");
  if (lockUrl) git(fx, fx.path, "config", "lfs.url", lockUrl);
  return fx;
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
async function waitToast(app, pattern, tone = null, timeout = 30_000) {
  return app.waitFor(async () => (await toasts(app)).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone)) ?? null, timeout, {
    message: `toast ${pattern}${tone ? ` (${tone})` : ""}`,
  }).catch(async (error) => {
    throw new Error(`${error.message}; present: ${JSON.stringify(await toasts(app))}`);
  });
}
const closeToasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast] button[aria-label='Close message']")].forEach((button) => button.click()));

/** Runs a command via the palette, keyboard only (F1, type, Enter). */
async function palette(app, text) {
  await app.press("F1");
  const input = await app.waitFor('input[role="combobox"]', 5000);
  await app.type(input, text);
  // File rows are options too: look only inside the palette.
  await app.waitFor(
    () => app.exec((wanted) => (document.querySelector('[data-screen="command-palette"] [role="option"][aria-selected="true"]')?.textContent ?? "").toLowerCase().includes(wanted.toLowerCase()), text),
    5000,
    { message: `palette entry "${text}" selected` },
  );
  await app.press("Enter");
}

const lfsDialog = (app) => app.waitFor('[role="dialog"] [data-screen="lfs"]', 10_000);
const panelState = (app) => app.exec(() => [...document.querySelectorAll("[data-lfs]")].at(-1)?.getAttribute("data-lfs") ?? null);
const shownPatterns = (app) => app.exec(() => [...document.querySelectorAll('[role="dialog"] [data-lfs-patterns] [data-pattern]')].map((item) => item.dataset.pattern));
const fieldError = (app) => app.exec(() => [...document.querySelectorAll('[role="dialog"] [role="alert"]')].map((item) => item.innerText.trim()).join(" | "));
const dialogTitle = () => [...document.querySelectorAll('[role="dialog"]')].at(-1)?.querySelector("h2")?.textContent?.trim() ?? null;
const dialogCount = (app) => app.exec(() => document.querySelectorAll('[role="dialog"]').length);

async function openLfs(app) {
  await palette(app, "Git LFS: manage patterns");
  await lfsDialog(app);
  await app.waitFor(async () => (await panelState(app)) === "ready", 20_000, { message: "LFS section ready" });
  // The lock section changes its height once the locks are read: wait, so clicks do not miss.
  await app.waitFor(async () => (await locksState(app)) !== "loading", 30_000, { message: "lock section settled" });
  await app.settle();
}
async function closeDialogs(app) {
  for (let round = 0; round < 4 && (await dialogCount(app)) > 0; round++) {
    await app.press("Escape");
    await sleep(150);
  }
  await app.waitFor(async () => (await dialogCount(app)) === 0, 5000, { message: "dialogs closed" });
}
/** Clicks a button by its visible text inside the last dialog. */
async function clickInDialog(app, text) {
  const button = await app.waitFor(
    () => app.exec((label) => [...([...document.querySelectorAll('[role="dialog"]')].at(-1)?.querySelectorAll("button") ?? [])].find((item) => item.textContent.replace(/\s+/g, " ").trim() === label && !item.disabled) ?? null, text),
    10_000,
    { message: `button "${text}" in the dialog` },
  );
  await app.click(button);
}

/** The lock rows of the LFS panel: [{ path, ours, owner }]. */
const lockRows = (app) =>
  app.exec(() =>
    [...document.querySelectorAll('[role="dialog"] [data-lfs-locks] [data-lock-path]')].map((row) => ({
      path: row.getAttribute("data-lock-path"),
      ours: row.hasAttribute("data-lock-ours"),
      owner: row.querySelector("span.shrink-0")?.textContent.split("·")[0].trim() ?? null,
    })),
  );
const locksState = (app) => app.exec(() => document.querySelector('[role="dialog"] [data-lfs-locks] [data-lfs-locks-state]')?.getAttribute("data-lfs-locks-state") ?? "list");

/** A file row in the commit panel (section "unstaged" or "staged"). */
const fileRow = (app, section, file) =>
  app.waitFor(
    () => app.exec((name, rel) => [...document.querySelectorAll(`[data-screen="commit-panel"] [data-section="${name}"] [role="option"], [data-screen="commit-panel"] [data-section="${name}"] [role="treeitem"]`)].find((row) => (row.getAttribute("title") ?? "").split(" – ")[0] === rel) ?? null, section, file),
    15_000,
    { message: `row ${file} in "${section}"` },
  );
const rowLock = (app, section, file) =>
  app.exec((name, rel) => {
    const row = [...document.querySelectorAll(`[data-screen="commit-panel"] [data-section="${name}"] [role="option"], [data-screen="commit-panel"] [data-section="${name}"] [role="treeitem"]`)].find((item) => (item.getAttribute("title") ?? "").split(" – ")[0] === rel);
    const lock = row?.querySelector("[data-lfs-lock]");
    return lock ? { kind: lock.getAttribute("data-lfs-lock"), title: lock.getAttribute("title") } : null;
  }, section, file);

/** Right-click on an element; returns the labels of the menu entries. */
async function contextMenu(app, element) {
  await app.exec((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: box.left + 40, clientY: box.top + box.height / 2 }));
  }, element);
  return app.waitFor(
    async () => {
      const items = await app.exec(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent.replace(/\s+/g, " ").trim()));
      return items.length ? items : null;
    },
    5000,
    { message: "context menu open" },
  );
}
async function chooseMenu(app, label) {
  const item = await app.waitFor(
    () => app.exec((text) => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((entry) => entry.textContent.replace(/\s+/g, " ").trim().startsWith(text)) ?? null, label),
    5000,
    { message: `menu entry "${label}"` },
  );
  await app.click(item);
}
const focusEvent = (app) => app.exec(() => void window.dispatchEvent(new Event("focus")));

function needLfs(t) {
  if (LFS_VERSION) return false;
  t.step("SKIPPED: Git LFS is not installed on this machine");
  return true;
}

// =============================================================================================
// 1.0 – patterns
// =============================================================================================

scenario("track and untrack a pattern with the keyboard", "main", async (t) => {
  if (needLfs(t)) return;
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    assertEqual(tracked(fx.path), [], "starting point: no LFS pattern");
    await openLfs(app);
    const version = await app.exec(() => document.querySelector("[data-lfs-version]")?.innerText.trim());
    assertMatch(version, /^Git LFS \d+\.\d+/, "installed version shown");
    assert(await app.$('[role="dialog"] [data-lfs-empty]'), "empty state for patterns");
    assertEqual(await app.exec(() => document.activeElement?.labels?.[0]?.textContent ?? null), "New pattern", "focus starts in the pattern field");

    await app.type(await app.exec(() => document.activeElement), "*.bin");
    await app.press("Enter");
    await waitToast(app, /“\*\.bin” now goes through LFS/, "success");
    assertEqual(tracked(fx.path), ["*.bin"], ".gitattributes: *.bin");
    assertIncludes(attributes(fx.path), "*.bin filter=lfs diff=lfs merge=lfs -text", "the line Git LFS writes");
    assertEqual(git(fx, fx.path, "config", "--local", "--get", "filter.lfs.clean"), "git-lfs clean -- %f", "LFS filter set up in the repository");
    await app.waitFor(async () => JSON.stringify(await shownPatterns(app)) === '["*.bin"]', 5000, { message: "pattern listed" });
    assertEqual(await app.exec(() => document.activeElement?.value ?? null), "", "field empty again and still focused");

    await app.type(await app.exec(() => document.activeElement), "karten/**");
    await app.press("Enter");
    await app.waitFor(async () => JSON.stringify(tracked(fx.path)) === '["*.bin","karten/**"]', 10_000, { message: "second pattern in .gitattributes" });
    await app.waitFor(async () => (await shownPatterns(app)).length === 2, 5000, { message: "two patterns listed" });
    await closeToasts(app);
    t.step("two patterns tracked");
    await t.shot("track-and-untrack-a-pattern");

    // Untrack: the remove button of the pattern (shown on hover/focus).
    await app.click('[role="dialog"] [data-pattern="karten/**"] button');
    await waitToast(app, /“karten\/\*\*” no longer goes through LFS/, "success");
    assertEqual(tracked(fx.path), ["*.bin"], ".gitattributes: karten/** removed");
    await app.waitFor(async () => JSON.stringify(await shownPatterns(app)) === '["*.bin"]', 5000, { message: "only *.bin listed" });
    // The .gitattributes change shows up among the local changes.
    const status = await app.invoke("status_get", { repoId: (await app.invoke("repo_open", { path: fx.path })).repo.id });
    assert([...status.unstaged, ...status.untracked ?? []].some((file) => file.path === ".gitattributes"), ".gitattributes among the local changes");
    await closeDialogs(app);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("invalid patterns are refused at the field", "edge", async (t) => {
  if (needLfs(t)) return;
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openLfs(app);
    const field = await app.exec(() => document.activeElement);
    await app.press("Enter");
    await app.waitFor(async () => /Enter a pattern/.test(await fieldError(app)), 5000, { message: "empty: error at the field" });
    for (const [value, reason] of [
      ["*", /would match every file/],
      ["#notiz", /comment/],
      ["!ausnahme.bin", /exceptions/],
    ]) {
      await app.press("Control+a", "Backspace");
      await app.type(field, value);
      await app.press("Enter");
      await app.waitFor(async () => reason.test(await fieldError(app)), 5000, { message: `pattern "${value}": reason at the field` });
    }
    assertEqual(tracked(fx.path), [], "nothing written to .gitattributes");
    await t.shot("invalid-pattern");

    // Duplicate (the suggestion button tracks *.psd, typing it again is refused).
    await app.click('[role="dialog"] [data-lfs-suggestions] button[aria-label="Add pattern *.psd"]');
    await waitToast(app, /“\*\.psd” now goes through LFS/, "success");
    await app.waitFor(async () => !(await app.$('[role="dialog"] button[aria-label="Add pattern *.psd"]')), 5000, { message: "suggestion disappears once tracked" });
    await app.click(field);
    await app.press("Control+a", "Backspace");
    await app.type(field, "*.psd");
    await app.press("Enter");
    await app.waitFor(async () => /already tracked/.test(await fieldError(app)), 5000, { message: "duplicate: reason at the field" });
    assertEqual(tracked(fx.path), ["*.psd"], ".gitattributes keeps one *.psd");

    // Pattern removed by hand behind the app's back: untrack reloads instead of failing loudly.
    fs.writeFileSync(path.join(fx.path, ".gitattributes"), "");
    await app.click('[role="dialog"] [data-pattern="*.psd"] button');
    await app.waitFor(async () => (await shownPatterns(app)).length === 0, 10_000, { message: "list follows the file" });
    assert(!(await toasts(app)).some((toast) => toast.tone === "danger"), `no error toast: ${JSON.stringify(await toasts(app))}`);
    await closeDialogs(app);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

// =============================================================================================
// 1.0 – pull and prune
// =============================================================================================

/** Source repo with two pushed versions of an LFS file and a clone that only holds the pointer. */
function makePullSetup() {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  const first = blob("modell-1", 48_000);
  const second = blob("modell-2", 52_000);
  git(fx, fx.path, "lfs", "install", "--local");
  git(fx, fx.path, "lfs", "track", "*.bin");
  writeFile(fx.path, "daten/modell.bin", first);
  git(fx, fx.path, "add", ".gitattributes", "daten/modell.bin");
  git(fx, fx.path, "commit", "-q", "-m", "Modell über LFS abgelegt");
  git(fx, fx.path, "push", "-q", "origin", "main");
  writeFile(fx.path, "daten/modell.bin", second);
  git(fx, fx.path, "add", "daten/modell.bin");
  git(fx, fx.path, "commit", "-q", "-m", "Modell neu berechnet");
  git(fx, fx.path, "push", "-q", "origin", "main");
  const clone = path.join(fx.root, "messnetz-klon");
  git(fx, fx.root, "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", "clone", "-q", fx.remotePath, clone);
  git(fx, clone, "lfs", "install", "--local", "--skip-smudge");
  return { fx, clone, first, second };
}

scenario("fetch LFS files replaces the pointer with the real file", "main", async (t) => {
  if (needLfs(t)) return;
  const { fx, clone, second } = makePullSetup();
  try {
    const file = path.join(clone, "daten", "modell.bin");
    assert(fs.statSync(file).size < 200 && fs.readFileSync(file, "utf8").startsWith("version https://git-lfs"), "starting point: only the pointer in the clone");
    assertEqual(lfsObjects(clone), [], "clone's LFS storage empty");

    const app = await t.launch(LAUNCH);
    await app.openRepo(clone);
    await openLfs(app);
    assertEqual(await shownPatterns(app), ["*.bin"], "pattern from .gitattributes");
    await clickInDialog(app, "Fetch LFS files");
    await waitToast(app, /LFS files fetched/, "success", 60_000);
    await app.waitFor(async () => fs.statSync(file).size === second.length, 10_000, { message: "file has its real size" });
    assertEqual(sha256(fs.readFileSync(file)), sha256(second), "content of the pushed version");
    assertEqual(lfsObjects(clone), [sha256(second)], "clone's LFS storage holds the fetched version");
    assertEqual(git(fx, clone, "status", "--short"), "", "git status clean");
    assert(!(await app.$("[data-lfs-progress]")), "progress display gone");
    await t.shot("fetch-lfs-files");
    await closeDialogs(app);

    // Again from the palette when everything is there already.
    await closeToasts(app);
    await palette(app, "Git LFS: fetch files");
    await waitToast(app, /LFS files fetched/, "success", 60_000);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("fetch LFS files with an unreachable remote reports the error", "edge", async (t) => {
  if (needLfs(t)) return;
  const { fx, clone } = makePullSetup();
  try {
    git(fx, clone, "remote", "set-url", "origin", path.join(fx.root, "gibt-es-nicht.git"));
    const app = await t.launch(LAUNCH);
    await app.openRepo(clone);
    await openLfs(app);
    await clickInDialog(app, "Fetch LFS files");
    const toast = await waitToast(app, /./, "danger", 60_000);
    t.step(`error toast: ${toast.text.slice(0, 160)}`);
    assert(!/LFS files fetched/.test(toast.text), "no success message");
    await app.waitFor(async () => !(await app.$("[data-lfs-progress]")), 10_000, { message: "progress display gone after the error" });
    assert(await app.byText("Fetch LFS files", { within: '[role="dialog"]' }), "the button is usable again");
    assert(fs.readFileSync(path.join(clone, "daten", "modell.bin"), "utf8").startsWith("version https://git-lfs"), "the pointer stays");
    await t.shot("fetch-error");
    await closeDialogs(app);
    // The error toast is expected; the console must not have more than the action's error.
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("clean up asks first, cancel keeps everything, confirm prunes", "main", async (t) => {
  if (needLfs(t)) return;
  const { fx, first, second } = makePullSetup();
  try {
    assertEqual(lfsObjects(fx.path), [sha256(first), sha256(second)].sort(), "starting point: two versions locally");
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openLfs(app);
    await clickInDialog(app, "Clean up …");
    await app.waitFor(async () => /Clean up the local LFS storage\?/.test((await app.exec(dialogTitle)) ?? ""), 10_000, { message: "confirmation" });
    const text = await app.exec(() => [...document.querySelectorAll('[role="dialog"]')].at(-1).innerText);
    assertMatch(text, /working directory stay/, "confirmation says the working directory stays");
    await t.shot("clean-up-confirmation");
    await clickInDialog(app, "Cancel");
    await app.waitFor(async () => !/LFS storage\?/.test((await app.exec(dialogTitle)) ?? ""), 5000, { message: "confirmation closed" });
    assertEqual(lfsObjects(fx.path).length, 2, "cancel deletes nothing");

    await clickInDialog(app, "Clean up …");
    await app.waitFor(async () => /Clean up the local LFS storage\?/.test((await app.exec(dialogTitle)) ?? ""), 10_000, { message: "confirmation again" });
    await clickInDialog(app, "Clean up");
    await waitToast(app, /LFS cleaned up/, "success", 60_000);
    assertEqual(lfsObjects(fx.path), [sha256(second)], "old pushed version pruned, current one stays");
    assertEqual(sha256(fs.readFileSync(path.join(fx.path, "daten", "modell.bin"))), sha256(second), "working file untouched");
    await t.shot("clean-up-done");
    await closeDialogs(app);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("without Git LFS the section explains what is missing", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    fs.writeFileSync(path.join(fx.path, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    // A PATH with git but without git-lfs: copy the git binary's folder content is not needed –
    // only the folders that contain git-lfs are dropped.
    const lfsDirs = new Set((process.env.PATH ?? "").split(":").filter((dir) => dir && fs.existsSync(path.join(dir, "git-lfs"))));
    const pathWithout = (process.env.PATH ?? "").split(":").filter((dir) => dir && !lfsDirs.has(dir)).join(":");
    t.step(`PATH without ${[...lfsDirs].join(", ") || "(git-lfs not on PATH)"}`);
    const app = await t.launch({ ...LAUNCH, env: { PATH: pathWithout } });
    await app.openRepo(fx.path);
    await palette(app, "Git LFS: manage patterns");
    await lfsDialog(app);
    await app.waitFor(async () => (await panelState(app)) === "missing", 20_000, { message: "state 'missing'" });
    const text = await app.exec(() => [...document.querySelectorAll('[role="dialog"]')].at(-1).innerText.replace(/\s+/g, " "));
    assertMatch(text, /Git LFS isn't installed on this computer/, "says what is missing");
    assertMatch(text, /uses LFS for 1 pattern/, "says the repository uses LFS");
    assertEqual(await shownPatterns(app), ["*.bin"], "patterns readable");
    assert(!(await app.byText("New pattern", { within: '[role="dialog"]' })), "no field for adding");
    const commands = await app.exec(() => window.__gcUi.commands().filter((command) => command.id.startsWith("lfs.")).map((command) => [command.id, command.available]));
    assertEqual(commands, [["lfs.manage", true], ["lfs.pull", false], ["lfs.prune", false]], "fetch and clean up disabled");
    await t.shot("without-git-lfs");
    let code = null;
    try {
      await app.invoke("lfs_track", { repoId: (await app.invoke("repo_open", { path: fx.path })).repo.id, pattern: "*.psd" });
    } catch (error) {
      code = error.code;
    }
    assertEqual(code, "unsupported", "core refuses tracking without Git LFS");
    await closeDialogs(app);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

// =============================================================================================
// 1.1 – locks
// =============================================================================================

scenario("lock list shows own and other people's locks and filters them", "main", async (t) => {
  if (needLfs(t)) return;
  const server = await startLockServer({ me: ME });
  const fx = makeLfsRepo({ lockUrl: server.url });
  try {
    server.seed("daten/karte.psd", OTHER);
    server.seed("daten/logo.psd", ME);
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openLfs(app);
    await app.waitFor(async () => (await lockRows(app)).length === 2, 20_000, { message: "two locks listed" });
    assertEqual(await lockRows(app), [
      { path: "daten/karte.psd", ours: false, owner: OTHER },
      { path: "daten/logo.psd", ours: true, owner: "you" },
    ], "lock rows");
    // Also in Git LFS itself.
    const verified = JSON.parse(await gitAsync(fx, fx.path, "lfs", "locks", "--verify", "--json"));
    assertEqual([verified.ours.map((lock) => lock.path), verified.theirs.map((lock) => lock.path)], [["daten/logo.psd"], ["daten/karte.psd"]], "git lfs locks --verify");
    await app.exec(() => [...document.querySelectorAll('[role="dialog"] [data-lfs-locks]')].at(-1).scrollIntoView({ block: "center" }));
    await t.shot("lock-list");

    const filter = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[role="dialog"] [data-lfs-locks] input')].find((input) => input.labels?.[0]?.textContent === "Filter by path or owner") ?? null), 5000, { message: "filter field" });
    await app.type(filter, "berg");
    await app.waitFor(async () => JSON.stringify((await lockRows(app)).map((row) => row.path)) === '["daten/karte.psd"]', 5000, { message: "filter by owner" });
    await app.press("Control+a", "Backspace");
    await app.type(filter, "LOGO");
    await app.waitFor(async () => JSON.stringify((await lockRows(app)).map((row) => row.path)) === '["daten/logo.psd"]', 5000, { message: "filter by path, case-insensitive" });
    await app.press("Control+a", "Backspace");
    await app.type(filter, "gibtsnicht");
    await app.waitFor(async () => (await locksState(app)) === "empty", 5000, { message: "empty filtered list" });
    assertIncludes(await app.exec(() => document.querySelector('[role="dialog"] [data-lfs-locks-state="empty"]').innerText), "No lock matches “gibtsnicht”", "empty filter message");
    assertEqual(await app.exec(() => document.activeElement?.labels?.[0]?.textContent ?? null), "Filter by path or owner", "the filter keeps focus while the list reloads");

    // Refresh picks up a lock someone else added on the server.
    await app.press("Control+a", "Backspace");
    server.seed("daten/plan.psd", "Aylin Demir");
    await app.waitFor(async () => (await lockRows(app)).length === 2, 5000, { message: "unfiltered list back (cached)" });
    await clickInDialog(app, "Refresh");
    await app.waitFor(async () => (await lockRows(app)).length === 3, 15_000, { message: "Refresh reads the new lock" });
    await closeDialogs(app);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
    await server.close();
  }
});

scenario("lock and unlock a file from its context menu", "main", async (t) => {
  if (needLfs(t)) return;
  const server = await startLockServer({ me: ME });
  const fx = makeLfsRepo({ lockUrl: server.url });
  try {
    server.seed("daten/karte.psd", OTHER);
    // A changed and a new LFS file appear in the commit panel.
    writeFile(fx.path, "daten/plan.psd", blob("plan-2", 4096));
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    const row = await fileRow(app, "unstaged", "daten/plan.psd");
    // The menu offers lock entries once the lock list is known (read in the background).
    await app.waitFor(async () => (await rowLock(app, "unstaged", "daten/karte.psd")) !== undefined && server.count("POST /locks/verify") > 0, 15_000, { message: "locks read" });
    await app.settle();
    const items = await contextMenu(app, row);
    t.step(`menu: ${items.join(" | ")}`);
    assert(items.some((item) => item.startsWith("Lock")), `"Lock" in the menu: ${items.join(" | ")}`);
    assert(!items.some((item) => item.startsWith("Unlock")), "no \"Unlock\" for an unlocked file");
    await chooseMenu(app, "Lock");
    await waitToast(app, /File locked/, "success", 30_000);
    assertEqual(server.owners()["daten/plan.psd"], ME, "server: the file is locked by us");
    const verified = JSON.parse(await gitAsync(fx, fx.path, "lfs", "locks", "--verify", "--json"));
    assertEqual(verified.ours.map((lock) => lock.path), ["daten/plan.psd"], "git lfs locks --verify: ours");
    await app.waitFor(async () => (await rowLock(app, "unstaged", "daten/plan.psd"))?.kind === "ours", 10_000, { message: "lock symbol on the row" });
    assertEqual((await rowLock(app, "unstaged", "daten/plan.psd")).title, "Locked by you", "tooltip of the own lock");
    await closeToasts(app);
    await t.shot("lock-from-context-menu");

    // Unlock while the file still has uncommitted changes: Git LFS refuses that without force;
    // the app reports the reason as a warning and the lock stays.
    const again = await contextMenu(app, await fileRow(app, "unstaged", "daten/plan.psd"));
    assert(again.some((item) => item.startsWith("Unlock")), `"Unlock" offered: ${again.join(" | ")}`);
    assert(!again.some((item) => item === "Lock"), "no \"Lock\" for an own lock");
    await chooseMenu(app, "Unlock");
    const refused = await waitToast(app, /Unlock files: 1 file failed/, "warning", 30_000);
    assertIncludes(refused.text, "Cannot unlock file with uncommitted changes", "warning names the reason");
    assertEqual(server.owners()["daten/plan.psd"], ME, "server: the lock stays");
    await closeToasts(app);
    // Close the diff the right-click opened, so the graph is visible again.
    await app.click('button[aria-label="Close diff"]').catch(() => app.press("Escape"));

    // The usual order: commit, then unlock – from the file list of the commit.
    git(fx, fx.path, "add", "daten/plan.psd");
    git(fx, fx.path, "commit", "-q", "-m", "Plan überarbeitet");
    await focusEvent(app);
    const head = await app.waitFor(
      () => app.exec(() => [...document.querySelectorAll('[data-row-kind="commit"]')].find((row) => row.innerText.includes("Plan überarbeitet")) ?? null),
      15_000,
      { message: "new commit in the graph" },
    );
    await app.click(head);
    const committed = await app.waitFor(
      () => app.exec(() => [...document.querySelectorAll('[data-screen="commit-details"] [role="option"], [data-screen="commit-details"] [role="treeitem"]')].find((row) => (row.getAttribute("title") ?? "").split(" – ")[0] === "daten/plan.psd") ?? null),
      15_000,
      { message: "file row in the commit details" },
    );
    // "All files" (the tree of the commit) shows the lock symbol.
    await app.click({ text: "All files", within: '[data-screen="commit-details"]' });
    const treeLock = await app.waitFor(
      () => app.exec(() => {
        const span = document.querySelector('[data-screen="commit-details"] [data-testid="files-all"] span[title="daten/plan.psd"]');
        const lock = span?.parentElement?.querySelector("[data-lfs-lock]");
        return lock ? { kind: lock.getAttribute("data-lfs-lock"), title: lock.getAttribute("title") } : null;
      }),
      10_000,
      { message: "lock symbol in the commit's file tree" },
    );
    assertEqual([treeLock.kind, treeLock.title], ["ours", "Locked by you"], "tree row lock");
    await t.shot("lock-in-commit-tree");
    await app.click({ text: "Changed", within: '[data-screen="commit-details"]' });
    const fromCommit = await contextMenu(app, await app.waitFor(
      () => app.exec(() => [...document.querySelectorAll('[data-screen="commit-details"] [role="option"], [data-screen="commit-details"] [role="treeitem"]')].find((row) => (row.getAttribute("title") ?? "").split(" – ")[0] === "daten/plan.psd") ?? null),
      10_000,
      { message: "file row in the commit details again" },
    ));
    assert(fromCommit.some((item) => item.startsWith("Unlock")), `"Unlock" in the commit file menu: ${fromCommit.join(" | ")}`);
    await chooseMenu(app, "Unlock");
    await waitToast(app, /File unlocked/, "success", 30_000);
    assertEqual(server.paths(), ["daten/karte.psd"], "server: our lock is gone, the other one stays");
    const verifiedAfter = JSON.parse(await gitAsync(fx, fx.path, "lfs", "locks", "--verify", "--json"));
    assertEqual(verifiedAfter.ours, [], "git lfs locks --verify: no own lock left");
    await app.click({ text: "All files", within: '[data-screen="commit-details"]' });
    const treeLocks = () =>
      app.exec(() => Object.fromEntries(["daten/plan.psd", "daten/karte.psd"].map((file) => [file, document.querySelector(`[data-testid="files-all"] span[title="${file}"]`)?.parentElement?.querySelector("[data-lfs-lock]")?.getAttribute("data-lfs-lock") ?? "none"])));
    await app.waitFor(async () => {
      const shown = await treeLocks();
      return shown["daten/plan.psd"] === "none" && shown["daten/karte.psd"] === "theirs";
    }, 10_000, { message: "tree: plan.psd without lock, karte.psd still locked by someone else" });
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
    await server.close();
  }
});

scenario("other people's locks show a symbol with the owner, force unlock asks first", "edge", async (t) => {
  if (needLfs(t)) return;
  const server = await startLockServer({ me: ME });
  const fx = makeLfsRepo({ lockUrl: server.url });
  try {
    server.seed("daten/karte.psd", OTHER);
    writeFile(fx.path, "daten/karte.psd", blob("karte-2", 4096));
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await fileRow(app, "unstaged", "daten/karte.psd");
    await app.waitFor(async () => (await rowLock(app, "unstaged", "daten/karte.psd"))?.kind === "theirs", 15_000, { message: "foreign lock symbol" });
    assertEqual((await rowLock(app, "unstaged", "daten/karte.psd")).title, `Locked by ${OTHER}`, "tooltip names the owner");
    await t.shot("foreign-lock-symbol");

    const items = await contextMenu(app, await fileRow(app, "unstaged", "daten/karte.psd"));
    assert(items.some((item) => item.startsWith("Force unlock")), `"Force unlock …" offered: ${items.join(" | ")}`);
    assert(!items.some((item) => item === "Lock" || item === "Unlock"), `neither Lock nor Unlock: ${items.join(" | ")}`);
    await chooseMenu(app, "Force unlock");
    await app.waitFor(async () => /Remove the lock held by Jonas Berg\?/.test((await app.exec(dialogTitle)) ?? ""), 10_000, { message: "force prompt names the owner" });
    const body = await app.exec(() => [...document.querySelectorAll('[role="dialog"]')].at(-1).innerText);
    assertIncludes(body, `daten/karte.psd – ${OTHER}`, "prompt lists file and owner");
    await t.shot("force-unlock-prompt");
    await clickInDialog(app, "Cancel");
    await app.waitFor(async () => (await dialogCount(app)) === 0, 5000, { message: "prompt closed" });
    assertEqual(server.paths(), ["daten/karte.psd"], "cancel: the lock stays");

    // In the panel: select the foreign lock, "Unlock" stays disabled, "Force unlock …" asks.
    await openLfs(app);
    await app.waitFor(async () => (await lockRows(app)).length === 1, 15_000, { message: "lock in the panel" });
    await app.click('[role="dialog"] [data-lock-path="daten/karte.psd"] button[role="checkbox"]');
    const disabled = await app.exec(() => {
      const buttons = [...document.querySelectorAll('[role="dialog"] [data-lfs-locks] button')];
      const find = (label) => buttons.find((button) => button.textContent.trim() === label);
      return { unlock: find("Unlock")?.disabled ?? null, force: find("Force unlock …")?.disabled ?? null };
    });
    assertEqual(disabled, { unlock: true, force: false }, "only force is possible for a foreign lock");
    await clickInDialog(app, "Force unlock …");
    await app.waitFor(async () => /Remove the lock held by Jonas Berg\?/.test((await app.exec(dialogTitle)) ?? ""), 10_000, { message: "force prompt from the panel" });
    await clickInDialog(app, "Force unlock");
    await waitToast(app, /File unlocked/, "success", 30_000);
    assertEqual(server.paths(), [], "server: the foreign lock is removed");
    await app.waitFor(async () => (await locksState(app)) === "empty", 10_000, { message: "panel: no lock left" });
    await closeDialogs(app);
    await app.waitFor(async () => (await rowLock(app, "unstaged", "daten/karte.psd")) === null, 10_000, { message: "row symbol gone" });
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
    await server.close();
  }
});

scenario("the changed-files list of a commit shows the lock symbol", "edge", async (t) => {
  if (needLfs(t)) return;
  const server = await startLockServer({ me: ME });
  const fx = makeLfsRepo({ lockUrl: server.url });
  try {
    // HEAD ("Karten über LFS abgelegt") changes the three PSD files; two of them are locked.
    server.seed("daten/karte.psd", OTHER);
    server.seed("daten/logo.psd", ME);
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    // The lock list is read on its own because the repository uses LFS.
    await app.waitFor(async () => server.count("POST /locks/verify") > 0, 15_000, { message: "locks read" });
    const head = await app.waitFor(
      () => app.exec(() => [...document.querySelectorAll('[data-row-kind="commit"]')].find((row) => row.innerText.includes("Karten über LFS abgelegt")) ?? null),
      15_000,
      { message: "commit row" },
    );
    await app.click(head);
    const rows = () =>
      app.exec(() =>
        Object.fromEntries(
          [...document.querySelectorAll('[data-screen="commit-details"] [data-testid="files-changed"] [role="option"], [data-screen="commit-details"] [data-testid="files-changed"] [role="treeitem"]')]
            .map((row) => [(row.getAttribute("title") ?? "").split(" – ")[0], row.querySelector("[data-lfs-lock]")?.getAttribute("title") ?? null])
            .filter(([file]) => file.endsWith(".psd")),
        ),
      );
    await app.waitFor(async () => Object.keys(await rows()).length === 3, 10_000, { message: "three PSD rows in the commit" });
    // The menu knows the locks (it offers "Force unlock …" for karte.psd) …
    const items = await contextMenu(app, await app.exec(() => [...document.querySelectorAll('[data-testid="files-changed"] [role="option"], [data-testid="files-changed"] [role="treeitem"]')].find((row) => (row.getAttribute("title") ?? "").startsWith("daten/karte.psd"))));
    assert(items.some((item) => item.startsWith("Force unlock")), `menu knows the lock: ${items.join(" | ")}`);
    await app.press("Escape");
    await sleep(500);
    await t.shot("commit-changed-list-locks");
    // … and the row should show it, as the CHANGELOG promises ("the file list of a commit show a lock symbol").
    const shown = await rows();
    assertEqual(["daten/karte.psd", "daten/logo.psd", "daten/plan.psd"].map((file) => shown[file]), [`Locked by ${OTHER}`, "Locked by you", null], "lock symbols in the commit's changed-files list (karte, logo, plan)");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
    await server.close();
  }
});

scenario("commit panel warns about staged files locked by others, commit still works", "main", async (t) => {
  if (needLfs(t)) return;
  const server = await startLockServer({ me: ME });
  const fx = makeLfsRepo({ lockUrl: server.url });
  try {
    server.seed("daten/karte.psd", OTHER);
    writeFile(fx.path, "daten/karte.psd", blob("karte-3", 4096));
    writeFile(fx.path, "daten/plan.psd", blob("plan-3", 4096));
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await fileRow(app, "unstaged", "daten/karte.psd");
    await app.waitFor(async () => (await rowLock(app, "unstaged", "daten/karte.psd"))?.kind === "theirs", 15_000, { message: "lock known" });
    assert(!(await app.$("[data-commit-lock-warning]")), "no warning while nothing locked is staged");

    // Stage only plan.psd: still no warning.
    git(fx, fx.path, "add", "daten/plan.psd");
    await focusEvent(app);
    await fileRow(app, "staged", "daten/plan.psd");
    await sleep(300);
    assert(!(await app.$("[data-commit-lock-warning]")), "no warning for an unlocked staged file");

    git(fx, fx.path, "add", "daten/karte.psd");
    await focusEvent(app);
    await fileRow(app, "staged", "daten/karte.psd");
    const warning = await app.waitFor("[data-commit-lock-warning]", 10_000);
    assertEqual(await warning.text(), `“daten/karte.psd” is locked by ${OTHER}. You can commit, but the push may be refused.`, "warning text");
    await app.type("[data-commit-summary]", "Karte trotz Sperre angepasst");
    await t.shot("commit-lock-warning");
    const before = git(fx, fx.path, "rev-parse", "HEAD");
    const button = await app.$('[data-action="commit"]');
    assert(!(await button.attr("data-blocked")), "commit is not blocked");
    await app.click(button);
    await app.waitFor(async () => git(fx, fx.path, "rev-parse", "HEAD") !== before, 20_000, { message: "commit created" });
    assertEqual(git(fx, fx.path, "log", "-1", "--format=%s"), "Karte trotz Sperre angepasst", "commit message");
    assertEqual(git(fx, fx.path, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["daten/karte.psd", "daten/plan.psd"], "both files committed");
    assertMatch(git(fx, fx.path, "cat-file", "-p", "HEAD:daten/karte.psd"), /^version https:\/\/git-lfs/, "committed as LFS pointer");
    await app.waitFor(async () => !(await app.$("[data-commit-lock-warning]")), 10_000, { message: "warning gone after the commit" });
    assertEqual(server.paths(), ["daten/karte.psd"], "the lock is untouched");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
    await server.close();
  }
});

scenario("a server without locking says so instead of an error", "edge", async (t) => {
  if (needLfs(t)) return;
  const server = await startLockServer({ me: ME, unsupported: true });
  const fx = makeLfsRepo({ lockUrl: server.url });
  try {
    writeFile(fx.path, "daten/plan.psd", blob("plan-4", 4096));
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openLfs(app);
    await app.waitFor(async () => (await locksState(app)) === "unsupported", 20_000, { message: "state 'unsupported'" });
    assertIncludes(await app.exec(() => document.querySelector('[role="dialog"] [data-lfs-locks-state="unsupported"]').innerText), "doesn’t offer file locking", "explanation");
    assert(server.count("POST /locks/verify") >= 1, "the server was asked");
    await t.shot("locks-unsupported");
    await closeDialogs(app);
    // File menu: without a lock list there are no lock entries.
    const items = await contextMenu(app, await fileRow(app, "unstaged", "daten/plan.psd"));
    assert(!items.some((item) => /^(Lock|Unlock|Force unlock)/.test(item)), `no lock entries without locking: ${items.join(" | ")}`);
    await app.press("Escape");
    assert(!(await toasts(app)).some((toast) => toast.tone === "danger"), "no error toast");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
    await server.close();
  }
});

scenario("a local file remote has no locking: the lock section says so", "edge", async (t) => {
  if (needLfs(t)) return;
  // The usual setup of this file: LFS objects go to a bare repository on disk (file:// remote).
  const { fx } = makePullSetup();
  try {
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openLfs(app);
    const state = await locksState(app);
    const text = await app.exec(() => document.querySelector('[role="dialog"] [data-lfs-locks]')?.innerText.replace(/\s+/g, " ") ?? "");
    t.step(`lock section: ${state} – ${text.slice(0, 240)}`);
    await app.exec(() => [...document.querySelectorAll('[role="dialog"] [data-lfs-locks]')].at(-1).scrollIntoView({ block: "center" }));
    await t.shot("locks-file-remote");
    // Git LFS answers "missing protocol: file://…" – a remote without the locking API.
    assertEqual(state, "unsupported", `a file:// remote counts as "no file locking" (shown: ${text.slice(0, 200)})`);
    await closeDialogs(app);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("lock server unreachable shows the reading error", "edge", async (t) => {
  if (needLfs(t)) return;
  const server = await startLockServer({ me: ME });
  const url = server.url;
  await server.close();
  const fx = makeLfsRepo({ lockUrl: url });
  try {
    const app = await t.launch({ ...LAUNCH, ignoreErrors: [] });
    await app.openRepo(fx.path);
    await openLfs(app);
    await app.waitFor(async () => (await locksState(app)) === "error", 30_000, { message: "state 'error'" });
    const text = await app.exec(() => document.querySelector('[role="dialog"] [data-lfs-locks-state="error"]').innerText);
    assertIncludes(text, "The locks couldn’t be read", "error heading");
    assert(!/geheim|token/i.test(text), "no secrets in the message");
    await t.shot("locks-unreachable");
    await closeDialogs(app);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});
