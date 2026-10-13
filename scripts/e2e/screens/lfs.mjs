/**
 * Git LFS in the real app against real repositories (Git LFS must be installed): add and remove
 * patterns, LFS files in the file list and the diff, "Fetch LFS files" against a local bare
 * repository, "Clean up" with confirmation, the section in the repository settings, the states
 * loading/error/not installed.
 *
 *   node scripts/e2e/screens/lfs.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/lfs.mjs --only pattern   only sections whose title contains "pattern"
 *   node scripts/e2e/screens/lfs.mjs --show           visible window
 *
 * Checks happen in the repository itself (.gitattributes, `git lfs ls-files`, files under .git/lfs,
 * contents of the files in the working directory). "Not installed" cannot really be produced on this
 * machine (Git for Windows ships Git LFS): for that the response of lfsStatus is replaced in the UI –
 * the core itself stays unchanged.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { tamper } from "./commit-panel-lib.mjs";
import { createRun } from "./mustfix-lib.mjs";
import { git, sideHelpers } from "./submodules-lib.mjs";

const show = process.argv.includes("--show");
const t = createRun("lfs");
const { check, equal, eventually, section } = t;

const fx = makeCleanRepoWithRemote({ name: "messnetz" });
const attributes = () => (fs.existsSync(path.join(fx.path, ".gitattributes")) ? fs.readFileSync(path.join(fx.path, ".gitattributes"), "utf8").split(/\r?\n/).filter(Boolean) : []);
const tracked = () => attributes().filter((line) => /filter=lfs/.test(line)).map((line) => line.split(/\s+/)[0]);
/** Fixed "random" bytes with NUL – a binary file of `size` bytes. */
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
const lfsObjects = (repoPath) => {
  const root = path.join(repoPath, ".git", "lfs", "objects");
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (/^[0-9a-f]{64}$/.test(entry.name)) found.push(entry.name);
    }
  };
  walk(root);
  return found.sort();
};

let app = null;
try {
  app = await launchApp({ show });
  t.attach(app);
  const { page } = app;
  const h = sideHelpers(app);
  const { repoId, tabId } = await app.openRepo(fx.path);
  const dialog = () => page.getByRole("dialog", { name: "Git LFS" });
  const panel = (scope = page) => scope.locator("[data-lfs]").last();
  const patterns = (scope = page) => scope.locator("[data-lfs-patterns] [data-pattern]").evaluateAll((list) => list.map((item) => item.dataset.pattern));
  const alerts = async (scope) => (await scope.getByRole("alert").allInnerTexts()).join(" | ");

  // -------------------------------------------------------------------------------------------
  await section("Add and remove patterns – keyboard only", async () => {
    equal(tracked(), [], "starting point: no pattern in .gitattributes");
    await h.palette("Git LFS: manage patterns");
    await dialog().waitFor();
    await eventually(() => panel().getAttribute("data-lfs"), "ready", "Git LFS is installed: the section is usable");
    check(/^Git LFS \d+\.\d+/.test((await dialog().locator("[data-lfs-version]").innerText()).trim()), `the version is shown (${(await dialog().locator("[data-lfs-version]").innerText()).trim()})`);
    check(/No pattern goes through LFS yet/.test(await dialog().locator("[data-lfs-empty]").innerText()), "empty state says what is missing");
    await eventually(async () => (await t.focused()).label, "New pattern", "focus in the \"New pattern\" field");
    await t.shot("lfs");

    // Validation at the field
    await page.keyboard.press("Enter");
    await eventually(async () => /Enter a pattern/.test(await alerts(dialog())), true, "empty: error at the field");
    for (const [value, pattern, what] of [
      ["*", /would match every file/, "\"*\""],
      ["#notiz", /comment/, "\"#…\""],
      ["!ausnahme.bin", /exceptions/, "\"!…\""],
    ]) {
      await page.keyboard.press("Control+a");
      await page.keyboard.type(value);
      await page.keyboard.press("Enter");
      await eventually(async () => pattern.test(await alerts(dialog())), true, `pattern ${what}: reason at the field`);
    }
    equal(tracked(), [], "git: nothing added");

    await page.keyboard.press("Control+a");
    await page.keyboard.type("*.bin");
    await page.keyboard.press("Enter");
    await t.waitToast(/“\*\.bin” now goes through LFS/, "success");
    equal(tracked(), ["*.bin"], ".gitattributes: *.bin with filter=lfs");
    check(attributes().some((line) => line === "*.bin filter=lfs diff=lfs merge=lfs -text"), `the line is what Git LFS writes (${attributes().join(" | ")})`);
    equal(git(fx, fx.path, "config", "--local", "--get", "filter.lfs.clean"), "git-lfs clean -- %f", "git config: LFS is set up in the repository");
    await eventually(() => patterns(dialog()), ["*.bin"], "the pattern is in the list");
    equal(await dialog().getByLabel("New pattern").inputValue(), "", "the field is empty again");
    equal((await t.focused()).label, "New pattern", "focus stays in the field – the next pattern can follow");
    equal((await app.invoke("lfs_status", { repoId })).patterns, ["*.bin"], "core: lfs_status lists the pattern");

    await page.keyboard.type("*.bin");
    await page.keyboard.press("Enter");
    await eventually(async () => /is already tracked by LFS/.test(await alerts(dialog())), true, "duplicate pattern: reason at the field");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("karten/**");
    await page.keyboard.press("Enter");
    await eventually(() => tracked(), ["*.bin", "karten/**"], ".gitattributes: second pattern");
    await t.closeToasts();
    await t.shot("lfs-patterns");

    // Removing: Shift+Tab to the button on the pattern
    await dialog().getByLabel("New pattern").focus();
    check(await h.tabUntil(() => document.activeElement?.getAttribute("aria-label") === "Remove pattern “karten/**”", null, { back: true }), "Shift+Tab reaches \"Remove pattern\"");
    await page.keyboard.press("Enter");
    await t.waitToast(/“karten\/\*\*” no longer goes through LFS/, "success");
    equal(tracked(), ["*.bin"], ".gitattributes: the pattern is gone again");
    await eventually(() => patterns(dialog()), ["*.bin"], "the list only shows *.bin");
    await eventually(async () => (await t.focused()).label, "New pattern", "afterwards focus is back in the field");
    await t.closeToasts();
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes the dialog");
  });

  // -------------------------------------------------------------------------------------------
  const first = blob("modell-1", 48_000);
  const second = blob("modell-2", 52_000);
  await section("LFS files are recognisable in the file list and the diff", async () => {
    fs.mkdirSync(path.join(fx.path, "daten"), { recursive: true });
    fs.writeFileSync(path.join(fx.path, "daten", "modell.bin"), first);
    await h.windowFocus();
    const status = await eventually(async () => (await app.invoke("status_get", { repoId })).unstaged.find((file) => file.path === "daten/modell.bin")?.isLfs, true, "core: the new file counts as an LFS file (attribute from .gitattributes)");
    check(status, "isLfs");
    const wip = page.locator('[data-screen="commit-panel"]');
    const row = wip.locator('[role="option"], [role="treeitem"]').filter({ hasText: "modell.bin" }).first();
    await row.waitFor();
    check(/LFS/.test(await row.innerText()), `file list: the row carries the "LFS" badge (${(await row.innerText()).replace(/\s+/g, " ")})`);
    await t.shot("lfs-filelist");

    // Commit (via Git, the repository's filters apply) and push: the repository only holds the pointer.
    git(fx, fx.path, "add", ".gitattributes", "daten/modell.bin");
    git(fx, fx.path, "commit", "-q", "-m", "Modell über LFS abgelegt");
    equal(git(fx, fx.path, "lfs", "ls-files", "--name-only"), "daten/modell.bin", "git lfs ls-files: the file is in LFS storage");
    check(/^version https:\/\/git-lfs\.github\.com\/spec\/v1/.test(git(fx, fx.path, "cat-file", "-p", "HEAD:daten/modell.bin")), "git: the commit holds the pointer");
    git(fx, fx.path, "push", "-q", "origin", "main");

    fs.writeFileSync(path.join(fx.path, "daten", "modell.bin"), second);
    await h.windowFocus();
    await eventually(async () => (await app.invoke("status_get", { repoId })).unstaged.find((file) => file.path === "daten/modell.bin")?.status, "modified", "the changed LFS file is among the local changes");
    const changed = wip.locator('[role="option"], [role="treeitem"]').filter({ hasText: "modell.bin" }).first();
    await changed.click();
    await eventually(() => page.locator('[data-notice="lfs"]').count(), 1, "diff: instead of a text diff the notice \"Git LFS file\"");
    const notice = (await page.locator('[data-notice="lfs"]').innerText()).replace(/\s+/g, " ");
    check(/Git LFS file/.test(notice) && /pointer/.test(notice), `the notice explains the pointer (${notice.slice(0, 160)})`);
    await t.shot("lfs-diff");
    await page.keyboard.press("Escape");
    git(fx, fx.path, "add", "daten/modell.bin");
    git(fx, fx.path, "commit", "-q", "-m", "Modell neu berechnet");
    git(fx, fx.path, "push", "-q", "origin", "main");
    equal(lfsObjects(fx.path), [sha256(first), sha256(second)].sort(), "local LFS storage: both versions");
    await h.windowFocus();
  });

  // -------------------------------------------------------------------------------------------
  const clone = path.join(fx.root, "messnetz-klon");
  await section("Fetch LFS files: the pointer becomes the real file", async () => {
    // Fresh clone without LFS filter: the working directory holds the pointer. Then set up LFS the way a user with Git LFS would have it.
    git(fx, fx.root, "clone", "-q", fx.remotePath, clone);
    git(fx, clone, "config", "user.name", "Lena Hartmann");
    git(fx, clone, "config", "user.email", "lena.hartmann@wetterstation.example");
    git(fx, clone, "lfs", "install", "--local", "--skip-smudge");
    const file = path.join(clone, "daten", "modell.bin");
    check(fs.statSync(file).size < 200 && fs.readFileSync(file, "utf8").startsWith("version https://git-lfs"), `starting point: the clone only holds the pointer (${fs.statSync(file).size} bytes)`);
    equal(lfsObjects(clone), [], "and the clone's LFS storage is empty");

    const opened = await app.openRepo(clone);
    await page.evaluate(() => void window.__gcUi.runCommand("lfs.manage"));
    await dialog().waitFor();
    await eventually(() => patterns(dialog()), ["*.bin"], "the clone knows the pattern from .gitattributes");
    await dialog().getByRole("button", { name: "Fetch LFS files" }).click();
    await t.waitToast(/LFS files fetched/, "success", 60_000);
    await eventually(() => fs.statSync(file).size, second.length, "the file in the working directory now has its real size");
    equal(sha256(fs.readFileSync(file)), sha256(second), "and exactly the content of the pushed version");
    equal(lfsObjects(clone), [sha256(second)], "clone's LFS storage: the fetched version");
    equal(git(fx, clone, "status", "--short"), "", "git status in the clone is clean");
    equal(await dialog().locator("[data-lfs-progress]").count(), 0, "the progress display is gone again");
    await t.closeToasts();

    // The same via the command palette when everything is already there
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes");
    await h.palette("Git LFS: fetch files");
    await t.waitToast(/LFS files fetched/, "success", 60_000);
    await t.closeToasts();
    check(Boolean(opened.repoId), "clone opened");
    await h.activateTab(tabId);
  });

  // -------------------------------------------------------------------------------------------
  await section("Clean up: confirmation, cancel, then for real", async () => {
    equal(lfsObjects(fx.path).length, 2, "starting point: two versions in local LFS storage");
    await page.evaluate(() => void window.__gcUi.runCommand("lfs.manage"));
    await dialog().waitFor();
    await dialog().getByRole("button", { name: "Clean up …" }).focus();
    await page.keyboard.press("Enter");
    const ask = await t.waitDialog(/Clean up the local LFS storage\?/);
    await eventually(async () => (await t.focused()).text, "Cancel", "confirmation: focus on \"Cancel\"");
    check(/working directory stay/.test(await ask.innerText()) && /from the remote/.test(await ask.innerText()), "the confirmation says what gets deleted and how it comes back");
    await t.shot("lfs-prune");
    await page.keyboard.press("Enter");
    await eventually(() => page.getByRole("dialog", { name: /LFS storage\?/ }).count(), 0, "Cancel closes the confirmation");
    equal(lfsObjects(fx.path).length, 2, "Cancel deletes nothing");

    await dialog().getByRole("button", { name: "Clean up …" }).click();
    await (await t.waitDialog(/Clean up the local LFS storage\?/)).getByRole("button", { name: "Clean up" }).click();
    const done = await t.waitToast(/LFS cleaned up/, "success", 60_000);
    check(/LFS cleaned up/.test(done?.text ?? ""), `message with the summary from Git LFS (${done?.text})`);
    equal(lfsObjects(fx.path), [sha256(second)], "LFS storage: the old, pushed version is gone, the current one stays");
    equal(sha256(fs.readFileSync(path.join(fx.path, "daten", "modell.bin"))), sha256(second), "the file in the working directory is untouched");
    await t.closeToasts();
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes");
  });

  // -------------------------------------------------------------------------------------------
  await section("In the preferences under \"This repository\"; suggestions", async () => {
    await page.evaluate(() => window.__gc.store.getState().openOverlay({ kind: "preferences", section: "repo" }));
    const prefs = page.locator('[data-screen="settings"]');
    await prefs.waitFor();
    const area = prefs.locator("[data-lfs]");
    await area.scrollIntoViewIfNeeded();
    await eventually(() => area.getAttribute("data-lfs"), "ready", "the LFS section is in the repository settings");
    check((await prefs.getByRole("heading", { name: "Git LFS" }).count()) === 1, "with its own subheading");
    await eventually(() => patterns(prefs), ["*.bin"], "the repository's patterns");
    await prefs.getByRole("button", { name: "Add pattern *.psd" }).click();
    await t.waitToast(/“\*\.psd” now goes through LFS/, "success");
    equal(tracked(), ["*.bin", "*.psd"], ".gitattributes: the suggestion is added");
    await eventually(() => prefs.getByRole("button", { name: "Add pattern *.psd" }).count(), 0, "the suggestion disappears as soon as it is tracked");
    await t.closeToasts();
    await prefs.locator('[data-pattern="*.psd"]').hover();
    await t.shot("lfs-prefs");
    await prefs.getByRole("button", { name: "Remove pattern “*.psd”" }).click();
    await eventually(() => tracked(), ["*.bin"], ".gitattributes: removed again");
    // The file changes before the core's response reaches the UI (it then still reads the LFS state,
    // about 600 ms). Only with the toast is the state in the cache too – whoever continues earlier gets
    // the emulated state of the next section overwritten by this response.
    await t.waitToast(/“\*\.psd” no longer goes through LFS/, "success");
    await t.closeToasts();
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "Esc closes the preferences");
  });

  // -------------------------------------------------------------------------------------------
  await section("States: not installed, loading, error, many and long patterns, 960x600", async () => {
    // Not installed: lfsStatus response replaced in the UI (cannot really be produced on this machine).
    await page.evaluate(() => {
      const core = window.__gc.core;
      delete core.lfsStatus;
      core.lfsStatus = async () => ({ installed: false, version: null, patterns: ["*.bin", "karten/**"] });
    });
    await page.evaluate((id) => void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "lfs"] }), repoId);
    await page.evaluate(() => void window.__gcUi.runCommand("lfs.manage"));
    await dialog().waitFor();
    await eventually(() => panel(dialog()).getAttribute("data-lfs"), "missing", "without Git LFS: explanation instead of controls");
    const text = (await dialog().innerText()).replace(/\s+/g, " ");
    check(/Git LFS isn't installed on this computer/.test(text) && /git-lfs\.com/.test(text), "the explanation says what is missing and where to get it");
    check(/uses LFS for 2 patterns/.test(text), "and that this repository already uses LFS");
    equal(await patterns(dialog()), ["*.bin", "karten/**"], "the patterns are there to read");
    equal(await dialog().getByLabel("New pattern").count(), 0, "no field for adding");
    equal(await dialog().getByRole("button", { name: /Remove|Fetch LFS files|Clean up/ }).count(), 0, "no actions that need Git LFS");
    const commands = await page.evaluate(() => window.__gcUi.commands().filter((command) => command.id.startsWith("lfs.")).map((command) => [command.id, command.available]));
    equal(commands, [["lfs.manage", true], ["lfs.pull", false], ["lfs.prune", false]], "commands \"fetch\" and \"clean up\" are disabled without Git LFS");
    await t.shot("lfs-missing");
    await app.setTheme("light");
    await t.shot("lfs-missing-light");
    await app.setTheme("dark");
    // Undo the replacement and press "Check again" in the same step (a core event could otherwise get there first).
    const pressed = await page.evaluate(() => {
      delete window.__gc.core.lfsStatus;
      const buttons = Array.from(document.querySelectorAll('[role="dialog"] button'));
      const button = buttons.find((item) => /Check\s+again/.test(item.textContent ?? ""));
      button?.click();
      return button ? "ok" : buttons.map((item) => item.textContent ?? item.getAttribute("aria-label")).join(" | ");
    });
    equal(pressed, "ok", "there is \"Check again\"");
    await eventually(() => panel(dialog()).getAttribute("data-lfs"), "ready", "\"Check again\" detects Git LFS without a restart");
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes");

    // Loading
    const slow = await tamper(page, "lfsStatus", { delayMs: 1500 });
    await page.evaluate((id) => void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "lfs"] }), repoId);
    await page.evaluate(() => void window.__gcUi.runCommand("lfs.manage"));
    await dialog().waitFor();
    await eventually(() => panel(dialog()).getAttribute("data-lfs"), "loading", "skeleton while the state is being checked");
    await t.shot("lfs-loading");
    await slow.restore();
    await eventually(() => panel(dialog()).getAttribute("data-lfs"), "ready", "then the section");

    // Error while loading
    const broken = await tamper(page, "lfsStatus", { fail: { code: "io", message: "The .gitattributes file is not readable.", gitOutput: null } });
    await page.evaluate((id) => void window.__gc.queryClient.resetQueries({ queryKey: ["repo", id, "lfs"] }), repoId);
    await eventually(() => panel(dialog()).getAttribute("data-lfs"), "error", "the loading error is shown in the section");
    check((await dialog().innerText()).includes("The .gitattributes file is not readable."), "with the reason");
    await t.shot("lfs-error");
    // Undo and press in one step – a core event in between would reload the state by itself.
    check(await broken.restoreAndPress('[role="dialog"]', "Try again"), "there is \"Try again\"");
    await eventually(() => panel(dialog()).getAttribute("data-lfs"), "ready", "\"Try again\" loads the state");
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes");

    // Many and very long patterns (written into .gitattributes from outside)
    const long = `archiv/${"messreihen-und-rohdaten-der-stationen/".repeat(4)}**/*.rohdaten`; // a good 170 characters
    const many = Array.from({ length: 60 }, (_, index) => `*.typ${String(index + 1).padStart(2, "0")}`);
    fs.appendFileSync(path.join(fx.path, ".gitattributes"), [long, ...many].map((pattern) => `${pattern} filter=lfs diff=lfs merge=lfs -text\n`).join(""));
    await page.evaluate(() => void window.__gcUi.runCommand("lfs.manage"));
    await dialog().waitFor();
    await eventually(async () => (await patterns(dialog())).length, 62, "62 patterns in the list", 20_000);
    const listBox = await dialog().locator("[data-lfs-patterns]").boundingBox();
    check(listBox.height <= 200, `the list does not grow, it scrolls (${Math.round(listBox.height)} px high)`);
    equal(await h.escaping('[role="dialog"]'), [], "even a 170-character pattern does not break the dialog");
    await t.shot("lfs-many");
    await app.setSize(960, 600);
    await page.waitForTimeout(200);
    const box = await dialog().boundingBox();
    check(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `960x600: the dialog lies entirely in the window (${JSON.stringify(box)})`);
    equal(await h.escaping('[role="dialog"]'), [], "960x600: nothing sticks out of the dialog");
    await t.shot("lfs-min");
    await app.setTheme("light");
    await t.shot("lfs-light");
    await app.setTheme("dark");
    await app.setSize(1440, 900);
    await page.keyboard.press("Escape");
    await eventually(() => dialog().count(), 0, "Esc closes");
  });

  equal(app.consoleErrors, [], "console errors");
} catch (error) {
  t.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (app) await app.close().catch(() => undefined);
  fx.cleanup();
}
t.finish();
