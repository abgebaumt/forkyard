/**
 * command-palette – command palette in the real app against real Git repositories.
 *
 *   node scripts/e2e/screens/command-palette.mjs            everything, writes the images to target/e2e/shots/
 *   node scripts/e2e/screens/command-palette.mjs --show     window visible
 *   node scripts/e2e/screens/command-palette.mjs --no-shots without images
 *
 * Everything runs over the keyboard (Ctrl+P, F1, Ctrl+Shift+O/B, typing, arrows, Enter, Tab, Esc).
 * Checked: every source (commands, branches/tags, files, repositories, commits), the prefixes,
 * fuzzy search with highlighting, disabled commands with a reason, second stage, "recently used",
 * no results, loading, error, 20,000 files (virtualized), long names, no repository,
 * 960×600 and light. Effects are verified in the repository itself with git. Aborts on
 * console errors.
 */
import { launchApp } from "../driver.mjs";
import { LONG_FILE_NAME, makeCleanRepoWithRemote, makeRichRepo } from "../fixtures.mjs";
import { assertNoConsoleErrors, closeToasts, createChecks, lines, makeManyFilesRepo, overflowX, storeApi, tamper } from "./commit-panel-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";
const show = process.argv.includes("--show");
const shots = !process.argv.includes("--no-shots");
const { failures, check, equal, eventually, section } = createChecks();
const SHOT_DIR = "target/e2e/shots";
const PALETTE = '[data-screen="command-palette"]';

const cleanups = [];
const apps = [];
const fixture = (made) => {
  cleanups.push(() => made.cleanup());
  return made;
};
const shot = async (app, name) => {
  if (!shots) return;
  await app.settle();
  await app.page.waitForTimeout(200);
  await app.screenshot(`${SHOT_DIR}/${name}.png`);
};

/** Drives the palette with the keyboard, reads it from the DOM. */
function paletteDriver(app) {
  const { page } = app;
  const root = page.locator(PALETTE);
  const input = root.locator('input[role="combobox"]');
  const options = root.locator('[role="option"]');
  const api = {
    root,
    input,
    options,
    isOpen: async () => (await root.count()) > 0,
    async open(keys = "Control+p") {
      // If the palette is still open after a failed section: close it first so the next one starts fresh.
      for (let round = 0; round < 3 && (await api.isOpen()); round++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
      }
      await page.keyboard.press(keys);
      await input.waitFor({ timeout: 5000 });
      await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox", "focus is in the input");
    },
    /** Replaces the input text via the keyboard. */
    async type(text) {
      await page.keyboard.press("Control+a");
      if (text) await page.keyboard.type(text, { delay: 5 });
      else await page.keyboard.press("Backspace");
      await page.waitForTimeout(80);
      await app.settle();
    },
    /** Esc, then wait until the palette is really closed (while it is open, global shortcuts do not apply). */
    async close() {
      await page.keyboard.press("Escape");
      await eventually(api.isOpen, false, "Esc closes the palette");
    },
    kinds: () => options.evaluateAll((rows) => rows.map((row) => row.dataset.kind)),
    /** The kinds present, sorted (a Set cannot be compared via JSON). */
    kindSet: async () => [...new Set(await api.kinds())].sort(),
    keys: () => options.evaluateAll((rows) => rows.map((row) => row.dataset.key)),
    activeKey: () =>
      page.evaluate((css) => {
        const field = document.querySelector(`${css} input[role="combobox"]`);
        const id = field?.getAttribute("aria-activedescendant");
        return id ? (document.getElementById(id)?.dataset.key ?? null) : null;
      }, PALETTE),
    marks: (index = 0) => options.nth(index).locator("mark").allInnerTexts(),
    // textContent: headers are uppercased via CSS, innerText would return that.
    headers: () => root.locator('[role="presentation"]').allTextContents(),
    count: () => root.locator("[data-count]").innerText(),
    async waitFirst(key, message) {
      await eventually(async () => (await api.keys())[0] ?? null, key, message);
    },
  };
  return api;
}

const focusedRole = (page) => page.evaluate(() => document.activeElement?.getAttribute("role") ?? document.activeElement?.tagName ?? null);

try {
  // =========================================================================
  // A. Two repositories: "wetterstation" (busy, uncommitted) and "messnetz" (clean, with remote)
  // =========================================================================
  {
    const rich = fixture(makeRichRepo());
    const clean = fixture(makeCleanRepoWithRemote());
    const app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
    apps.push(app);
    const { page } = app;
    await page.evaluate(() => localStorage.removeItem("gc.palette.recent"));
    const cleanTab = await app.openRepo(clean.path);
    const richTab = await app.openRepo(rich.path);
    const store = storeApi(app, richTab.tabId);
    const palette = paletteDriver(app);

    await section("Ctrl+P opens the palette: focus in the input, empty state with prefix help", async () => {
      // Focus a graph row first so that returning focus can be checked.
      await page.locator('[data-screen="commit-graph"] [data-row-index][tabindex="0"]').first().focus();
      const before = await page.evaluate(() => document.activeElement?.getAttribute("data-row-index"));
      await palette.open();
      const help = await palette.root.locator("[data-prefix-help]").innerText();
      for (const word of [">", "@", "/", "#", "~", "Commands", "Branches", "Files", "Commits", "Repositories"]) check(help.includes(word), `the help mentions "${word}"`);
      equal(await palette.headers(), ["Commands"], "without history: only the commands");
      check((await palette.options.count()) > 10, "the available commands are listed for browsing");
      equal(await palette.kindSet(), ["command"], "only commands in the empty state");
      // offsetWidth instead of boundingBox: the surface is briefly scaled while opening.
      equal(await palette.root.evaluate((element) => element.offsetWidth), 600, "600 px wide");
      const box = await palette.root.boundingBox();
      check(box.y < 900 / 3, `starts in the upper third (y = ${Math.round(box.y)})`);
      const visibleRows = await palette.root.locator("[data-scroll]").evaluate((element) => Math.floor(element.clientHeight / 32));
      check(visibleRows <= 12, `at most 12 results visible (${visibleRows})`);
      await shot(app, "command-palette-empty");
      await page.keyboard.press("Escape");
      await eventually(palette.isOpen, false, "Esc closes");
      // The palette returns focus a moment AFTER closing (the dialog's focus scope does that in a
      // separate step while unmounting) – wait for it instead of checking immediately.
      await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-index") ?? null), before, "focus is back on the graph row");
    });

    await section("Fuzzy search across all sources: initials, case, highlighting, kind as a label", async () => {
      await palette.open();
      await palette.type("nbr");
      await palette.waitFirst("command:branch.create", "\"nbr\" finds \"New branch …\" first (word starts)");
      equal((await palette.marks(0)).join("|"), "N|br", "the matched letters are highlighted (N, then br contiguous)");
      check((await palette.options.first().innerText()).includes("Ctrl"), "the command shows its shortcut");
      await palette.type("UNDO");
      await palette.waitFirst("command:repo.undo", "\"UNDO\" finds \"Undo\" (case does not matter)");
      await palette.type("ausw");
      await eventually(async () => (await palette.kindSet()).length >= 2, true, "\"ausw\" matches several kinds");
      const kinds = await palette.kindSet();
      for (const kind of ["branch", "file"]) check(kinds.includes(kind), `"ausw": result of kind "${kind}"`);
      check((await palette.keys()).includes("file:src/auswertung.py") && (await palette.keys()).includes("ref:refs/heads/experiment/alte-auswertung"), "file and branch are listed side by side");
      await palette.type("wind");
      await eventually(palette.kindSet, ["branch", "remote"], "\"wind\" matches the local and the remote branch");
      const labels = await palette.options.evaluateAll((rows) => rows.map((row) => row.querySelector("[data-kind-label]")?.textContent));
      check(labels.includes("Branch") && labels.includes("Remote branch"), "every row names its kind");
      // Scattered letters across a long title are not a match.
      const texts = await palette.options.allTextContents();
      check(texts.every((text) => /wind/i.test(text)), `only real matches, no accidental hits (${texts.length})`);
      await palette.type("ausw");
      await eventually(async () => (await palette.keys()).includes("file:src/auswertung.py"), true, "for the image: mixed results");
      await shot(app, "command-palette");
    });

    await section("Arrow keys move the selection (wrapping), focus stays in the input", async () => {
      const keys = await palette.keys();
      equal(await palette.activeKey(), keys[0], "the first result is selected");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await eventually(palette.activeKey, keys[2], "↓ twice");
      equal(await palette.options.nth(2).getAttribute("aria-selected"), "true", "aria-selected follows");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await eventually(palette.activeKey, keys[keys.length - 1], "↑ past the start wraps to the end");
      equal(await focusedRole(page), "combobox", "focus stays in the input");
      await palette.close();
    });

    await section("Prefixes: > commands, @ branches and tags, / files, ~ repositories, # commits", async () => {
      await palette.open();
      await palette.type(">");
      equal(await palette.kindSet(), ["command"], "> only commands");
      await palette.type(">push");
      equal(await palette.kindSet(), ["command"], "> with search text: only commands");
      await palette.waitFirst("command:sync.push", "\">push\" → Push");

      await palette.type("@");
      equal(await palette.headers(), ["Local branches", "Remote branches", "Tags"], "@ groups branches, remote branches and tags");
      const refKeys = await palette.keys();
      for (const name of rich.info.localBranches) check(refKeys.includes(`ref:refs/heads/${name}`), `local branch ${name}`);
      for (const name of rich.info.tags) check(refKeys.includes(`ref:refs/tags/${name}`), `Tag ${name}`);
      check((await palette.options.first().innerText()).includes("checked out") || (await palette.root.innerText()).includes("checked out"), "the checked-out branch is marked");
      await palette.type("@v020");
      await palette.waitFirst("ref:refs/tags/v0.2.0", "\"@v020\" finds the tag v0.2.0");

      await palette.type("/");
      const headers = await palette.headers();
      equal(headers[0], "Changed files", "/ shows the changed files first");
      const fileKeys = await palette.keys();
      check(fileKeys.includes("file:src/auswertung.py"), "changed file included");
      const tracked = lines(rich.git("ls-files")).length;
      check(fileKeys.length >= 40 || fileKeys.length > 0, `files listed (${fileKeys.length}, git ls-files: ${tracked})`);
      equal(await palette.kindSet(), ["file"], "/ only files");

      await palette.type("~");
      equal(await palette.kindSet(), ["repo"], "~ only repositories");
      const repoTexts = await palette.options.allInnerTexts();
      check(repoTexts.some((text) => text.includes("wetterstation")) && repoTexts.some((text) => text.includes("messnetz")), "both repositories");
      check(repoTexts.some((text) => text.includes("open")), "the active one is marked");

      await palette.type("#");
      await palette.root.locator("[data-empty]").waitFor();
      check((await palette.root.locator("[data-empty]").innerText()).includes("message"), "# without text explains the commit search");
      await palette.type("#regen");
      const expected = lines(rich.git("log", "--format=%H", "-i", "-F", "--grep=regen", "--branches", "--remotes", "--tags", "HEAD"));
      const byAuthor = lines(rich.git("log", "--format=%H", "-i", "-F", "--author=regen", "--branches", "--remotes", "--tags", "HEAD"));
      const want = [...new Set([...expected, ...byAuthor])].sort();
      await eventually(async () => (await palette.keys()).map((key) => key.replace("commit:", "")).sort(), want, "#regen finds the same commits as git log", 15_000);
      equal(await palette.kindSet(), ["commit"], "# only commits");
      await shot(app, "command-palette-commits");
      // Enter jumps to the commit in the graph
      const first = (await palette.keys())[0].replace("commit:", "");
      await page.keyboard.press("Enter");
      await eventually(palette.isOpen, false, "Enter closes the palette");
      await eventually(store.selection, { kind: "commits", shas: [first] }, "the commit is selected in the graph");
      equal((await store.view()).reveal?.sha, first, "the graph is asked to scroll there");
    });

    await section("Files: changed ones open the diff, unchanged ones the file; second stage with history", async () => {
      await palette.open();
      await palette.type("/ausw");
      await palette.waitFirst("file:src/auswertung.py", "\"/ausw\" → src/auswertung.py");
      check((await palette.options.first().innerText()).includes("modified"), "the file is marked as modified");
      await page.keyboard.press("Enter");
      await eventually(store.center, { kind: "diff", path: "src/auswertung.py", source: { kind: "unstaged" } }, "Enter shows the diff of the local change");
      equal(await store.selection(), { kind: "wip" }, "the local changes are selected");

      await palette.open();
      await palette.type("/pruefung");
      await palette.waitFirst("file:src/pruefung.py", "\"/pruefung\" → src/pruefung.py");
      await page.keyboard.press("Tab");
      await palette.root.locator("[data-stage]").waitFor();
      const actions = await palette.options.allInnerTexts();
      check(actions.some((text) => text.includes("File history")), "second stage: history");
      check(actions.some((text) => text.includes("Blame")), "second stage: Blame");
      equal(await palette.kindSet(), ["action"], "only actions");
      await shot(app, "command-palette-actions");
      await palette.type("hist");
      await palette.waitFirst("action:file:src/pruefung.py:history", "\"hist\" filters the actions");
      await page.keyboard.press("Escape");
      await eventually(async () => palette.root.locator("[data-stage]").count(), 0, "Esc only leaves the second stage");
      equal(await palette.input.inputValue(), "/pruefung", "the previous input is back");
      await page.keyboard.press("Tab");
      await palette.type("hist");
      await page.keyboard.press("Enter");
      await eventually(store.center, { kind: "history", path: "src/pruefung.py" }, "\"File history\" opens the history");
      await palette.open();
      await palette.type("/pruefung");
      await palette.waitFirst("file:src/pruefung.py", "again");
      await page.keyboard.press("Enter");
      await eventually(store.center, { kind: "file", path: "src/pruefung.py", sha: null, mode: "view" }, "Enter on an unchanged file shows the file");
      await store.closeCenter();
    });

    await section("Long names: nothing overflows", async () => {
      await palette.open();
      await palette.type(`/${LONG_FILE_NAME.slice(0, 20)}`);
      await palette.waitFirst(`file:daten/${LONG_FILE_NAME}`, "the file with the long name");
      equal(await overflowX(page, `${PALETTE} [role="listbox"]`), { page: 0, element: 0 }, "no horizontal overflow");
      await palette.type("#Plausibilitätsprüfung für alle");
      await eventually(async () => (await palette.keys()).includes(`commit:${rich.info.shas.longSummary}`), true, "the commit with the long summary", 15_000);
      equal(await overflowX(page, `${PALETTE} [role="listbox"]`), { page: 0, element: 0 }, "long summary: no overflow");
      const height = await palette.options.first().evaluate((element) => element.getBoundingClientRect().height);
      equal(Math.round(height), 32, "the row stays single-line");
      await shot(app, "command-palette-long");
      await palette.close();
    });

    await section("No results", async () => {
      await palette.open();
      await palette.type("qqxyzzy");
      const empty = palette.root.locator("[data-empty]");
      await empty.waitFor();
      check((await empty.innerText()).includes("“qqxyzzy”"), "the text names the search term");
      check((await empty.innerText()).includes(">"), "the text names the prefixes");
      equal(await palette.options.count(), 0, "no rows");
      equal(await palette.count(), "0 results", "counter");
      await page.keyboard.press("Enter");
      equal(await palette.isOpen(), true, "Enter without results does nothing");
      await shot(app, "command-palette-no-results");
      await palette.close();
    });

    await section("Command with an effect in the repository: New branch – then listed under \"Recently used\"", async () => {
      await palette.open();
      await palette.type("new branch");
      await palette.waitFirst("command:branch.create", "\"new branch\"");
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "New branch" });
      await dialog.waitFor();
      equal(await focusedRole(page), "INPUT", "focus is in the dialog's name field");
      await page.keyboard.type("palette/from-the-palette");
      await page.keyboard.press("Enter");
      await eventually(() => rich.git("rev-parse", "--abbrev-ref", "HEAD"), "palette/from-the-palette", "git: the new branch is checked out");
      await eventually(async () => dialog.count(), 0, "the dialog is closed");
      await closeToasts(page);
      await app.settle();

      await palette.open();
      equal((await palette.headers())[0], "Recently used", "the history is at the top");
      equal((await palette.keys())[0], "command:branch.create", "\"New branch …\" first");
      await shot(app, "command-palette-recent");
      await palette.close();
    });

    await section("Disabled command: listed with a reason, Enter explains instead of running", async () => {
      // The clean repository has no stash.
      await page.keyboard.press("Control+1");
      await eventually(async () => (await app.invoke("tabs_list")).find((tab) => tab.isActive)?.id, cleanTab.tabId, "tab \"messnetz\" active");
      await app.settle();
      await palette.open();
      await palette.type(">stash pop");
      await palette.waitFirst("command:stash.pop", "\">stash pop\"");
      equal(await palette.options.first().getAttribute("aria-disabled"), "true", "aria-disabled");
      check((await palette.options.first().innerText()).includes("No stash available"), "the reason is shown in the row");
      await page.keyboard.press("Enter");
      const notice = palette.root.locator("[data-notice]");
      await notice.waitFor();
      check((await notice.innerText()).includes("No stash available"), "Enter names the reason");
      equal(await palette.isOpen(), true, "the palette stays open");
      await shot(app, "command-palette-disabled");
      await palette.close();
    });

    await section("Branches: Enter checks out, second stage merges – verified with git", async () => {
      await palette.open("Control+Shift+B");
      equal(await palette.input.inputValue(), "@", "Ctrl+Shift+B opens with \"@\"");
      await palette.type("@export");
      await palette.waitFirst("ref:refs/heads/feature/export", "\"@export\" → feature/export");
      await page.keyboard.press("Enter");
      await eventually(() => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/export", "git: feature/export is checked out");
      await closeToasts(page);
      await app.settle();

      await palette.open();
      await palette.type("@main");
      await palette.waitFirst("ref:refs/heads/main", "\"@main\"");
      await page.keyboard.press("Tab");
      await palette.root.locator("[data-stage]").waitFor();
      await palette.type("check out");
      await page.keyboard.press("Enter");
      await eventually(() => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "git: back on main (second stage \"Check out\")");
      await closeToasts(page);
      await app.settle();

      await palette.open();
      await palette.type("@export");
      await palette.waitFirst("ref:refs/heads/feature/export", "\"@export\"");
      await page.keyboard.press("ArrowRight");
      await palette.root.locator("[data-stage]").waitFor();
      const texts = await palette.options.allInnerTexts();
      check(texts.some((text) => text.includes("Merge into “main”")), "the action names the current branch");
      await palette.type("merge");
      await page.keyboard.press("Enter");
      await eventually(() => clean.git("rev-parse", "main"), clean.info.featureHead, "git: after the merge (fast-forward) main points at feature/export");
      await closeToasts(page);
      await app.settle();
    });

    await section("Repositories: ~ switches the tab", async () => {
      await palette.open();
      await palette.type("~wetter");
      await palette.waitFirst(`repo:${richTab.repoId}`, "\"~wetter\"");
      await page.keyboard.press("Enter");
      await eventually(async () => (await app.invoke("tabs_list")).find((tab) => tab.isActive)?.id, richTab.tabId, "the tab \"wetterstation\" is active");
    });

    await section("F1 and Ctrl+Shift+O open with a preselected scope", async () => {
      await palette.open("F1");
      equal(await palette.input.inputValue(), ">", "F1 → \">\"");
      equal(await palette.kindSet(), ["command"], "only commands");
      await palette.close();
      await palette.open("Control+Shift+O");
      equal(await palette.input.inputValue(), "/", "Ctrl+Shift+O → \"/\"");
      await palette.close();
    });

    await section("Loading and error (file list)", async () => {
      const slow = await tamper(page, "treeList", { delayMs: 2000 });
      await page.evaluate(() => window.__gc.queryClient.removeQueries({ queryKey: ["repo"], predicate: (query) => query.queryKey[2] === "tree" }));
      await palette.open();
      // Without palette.type: that waits until no query is running – i.e. until "loading" is over.
      await page.keyboard.type("/");
      await eventually(() => palette.root.evaluate((element) => element.hasAttribute("data-state-loading")), true, "the palette reports \"loading\"", 1500);
      check((await palette.root.locator('[role="status"]').count()) > 0, "spinner with text for screen readers");
      check((await palette.root.locator("[data-scroll] [aria-hidden]").count()) > 0, "skeleton rows instead of an empty list");
      equal(await palette.options.count(), 0, "no results yet");
      if (shots) await app.screenshot(`${SHOT_DIR}/command-palette-loading.png`);
      await slow.restore();
      await eventually(async () => (await palette.keys()).length > 0, true, "then the files");
      await palette.close();

      const broken = await tamper(page, "treeList", { fail: { code: "io", message: "The folder could not be read.", gitOutput: null } });
      await page.evaluate(() => window.__gc.queryClient.removeQueries({ queryKey: ["repo"], predicate: (query) => query.queryKey[2] === "tree" }));
      await palette.open();
      await palette.type("/");
      const alert = palette.root.locator("[data-failure]");
      await alert.waitFor();
      check((await alert.innerText()).includes("The file list could not be read"), "understandable message");
      await shot(app, "command-palette-error");
      await broken.restore();
      // "Try again" via keyboard: Tab moves from the input to the button.
      await page.keyboard.press("Tab");
      equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Try again", "Tab reaches \"Try again\"");
      await page.keyboard.press("Enter");
      await eventually(async () => (await palette.keys()).length > 0, true, "after retrying the files are listed");
      await eventually(() => focusedRole(page), "combobox", "focus is back in the input");
      await palette.close();
    });

    await section("Without a repository (management tab)", async () => {
      await page.keyboard.press("Control+t");
      await eventually(async () => (await app.invoke("tabs_list")).find((tab) => tab.isActive)?.kind, "management", "new management tab");
      await palette.open();
      await palette.type("@");
      const empty = palette.root.locator("[data-empty]");
      await empty.waitFor();
      check((await empty.innerText()).includes("No repository open"), "@ without a repository explains itself");
      await palette.type(">pull");
      await palette.waitFirst("command:sync.pull", "\">pull\" still finds Pull");
      check((await palette.options.first().innerText()).includes("Only in a repository tab"), "… disabled with a reason");
      await palette.close();
      await page.keyboard.press("Control+w");
      await eventually(async () => (await app.invoke("tabs_list")).find((tab) => tab.isActive)?.kind, "repo", "management tab closed again");
    });

    await section("Light and 960×600", async () => {
      await palette.open();
      await palette.type("stash");
      await app.setTheme("light");
      await shot(app, "command-palette-light");
      await app.setTheme("dark");
      await palette.close();
      await app.setSize(960, 600);
      await page.waitForTimeout(300);
      await palette.open();
      await palette.type("a");
      const box = await palette.root.boundingBox();
      check(box.y + box.height <= 600, `fits in the window (bottom at ${Math.round(box.y + box.height)})`);
      equal(await overflowX(page, PALETTE), { page: 0, element: 0 }, "no horizontal overflow");
      await shot(app, "command-palette-min");
      await palette.close();
      await app.setSize(1440, 900);
    });

    assertNoConsoleErrors(app, "two repositories");
    await app.close();
  }

  // =========================================================================
  // B. 20,000 files: virtualized list, search stays fast
  // =========================================================================
  {
    const many = fixture(makeManyFilesRepo());
    const app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
    apps.push(app);
    const { page } = app;
    await app.openRepo(many.path);
    const palette = paletteDriver(app);

    await section("20,000 files: virtualized, search finds the right one", async () => {
      await palette.open("Control+Shift+O");
      await eventually(async () => (await palette.count()).includes("result"), true, "counter is shown", 30_000);
      const total = Number((await palette.count()).replace(/\D+/g, ""));
      check(total >= 20_000, `all files counted (${total})`);
      const rendered = await palette.options.count();
      check(rendered < 80, `only a slice in the DOM (${rendered} rows)`);
      await page.keyboard.press("PageDown");
      await page.keyboard.press("PageDown");
      const active = await palette.activeKey();
      check(active !== null && (await palette.root.locator(`[data-key="${active}"]`).count()) === 1, "after PgDn the selected entry is rendered and visible");
      await shot(app, "command-palette-many");
      const started = Date.now();
      await palette.type(`/${many.info.sample.split("/").pop().replace(".csv", "")}`);
      await palette.waitFirst(`file:${many.info.sample}`, "the file name finds exactly this file first");
      const answered = Date.now() - started;
      check(answered < 5000, `answer in ${answered} ms`);
      console.log(`  (20,000 files: name typed and result on top after ${answered} ms)`);
      await palette.close();
    });

    assertNoConsoleErrors(app, "20,000 files");
    await app.close();
  }
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  for (const app of apps) await app.close().catch(() => undefined);
  for (const cleanup of cleanups) cleanup();
}

if (failures.length > 0) {
  console.error(`\nS16: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nS16: all green");
