/**
 * commit-search – commit search in the real app against real Git repositories.
 *
 *   node scripts/e2e/screens/commit-search.mjs            everything, writes the images to target/e2e/shots/
 *   node scripts/e2e/screens/commit-search.mjs --show     window visible
 *   node scripts/e2e/screens/commit-search.mjs --no-shots without images
 *
 * The whole flow runs over the keyboard (Ctrl+F, typing, Enter, Shift+Enter, F3, Shift+F3,
 * arrow keys, Esc); the mouse only where the click itself is checked. Matches are compared with
 * `git log` in the same repository. Aborts on console errors.
 */
import { launchApp } from "../driver.mjs";
import { makeLargeRepo, makeRichRepo } from "../fixtures.mjs";
import { assertNoConsoleErrors, createChecks, lines, overflowX, storeApi, tamper, toasts } from "./commit-panel-lib.mjs";

const show = process.argv.includes("--show");
const shots = !process.argv.includes("--no-shots");
const { failures, check, equal, eventually, section } = createChecks();
const SHOT_DIR = "target/e2e/shots";
const BAR = '[data-screen="commit-search"]';
const short = (sha) => sha.slice(0, 7);

const cleanups = [];
const apps = [];
const shot = async (app, name) => {
  if (!shots) return;
  await app.settle();
  await app.page.waitForTimeout(150);
  await app.screenshot(`${SHOT_DIR}/${name}.png`);
};

try {
  // =========================================================================
  // A. Rich repository
  // =========================================================================
  {
    const rich = makeRichRepo();
    cleanups.push(() => rich.cleanup());
    const { shas } = rich.info;
    /** What the search should find: message or author across all branches, remote branches, tags and HEAD – newest first. */
    const gitSearch = (text) => {
      const scope = ["--branches", "--remotes", "--tags", "HEAD"];
      const byMessage = lines(rich.git("log", "--format=%H", "-i", "-F", `--grep=${text}`, ...scope));
      const byAuthor = lines(rich.git("log", "--format=%H", "-i", "-F", `--author=${text}`, ...scope));
      return new Set([...byMessage, ...byAuthor]);
    };

    const app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
    apps.push(app);
    const { page } = app;
    const { tabId } = await app.openRepo(rich.path);
    const store = storeApi(app, tabId);
    const bar = page.locator(BAR);
    const input = page.getByRole("combobox", { name: "Search commits" });
    const options = bar.locator('[role="option"]');
    const counter = () => bar.locator('[data-testid="search-counter"]').innerText();
    const hitShas = () => options.evaluateAll((rows) => rows.map((row) => row.dataset.sha));
    const marks = (index) => options.nth(index).locator("mark").allInnerTexts();
    const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);
    const cursorSha = () => page.evaluate(() => {
      const field = document.querySelector('[data-screen="commit-search"] input');
      const id = field?.getAttribute("aria-activedescendant");
      return id ? document.getElementById(id)?.dataset.sha ?? null : null;
    });
    const activeSha = () => bar.locator('[role="option"][aria-current="true"]').evaluateAll((rows) => rows.map((row) => row.dataset.sha)[0] ?? null);
    /** Types a new search text via the keyboard (replaces the old one). */
    const search = async (text) => {
      await page.keyboard.press("Control+a");
      if (text) await page.keyboard.type(text);
      else await page.keyboard.press("Delete");
    };

    await section("Ctrl+F opens the search, focus is in the field, hint in the empty state", async () => {
      equal(await bar.count(), 0, "the bar is closed beforehand");
      await page.keyboard.press("Control+f");
      await input.waitFor();
      await eventually(focusedLabel, "Search commits", "focus in the search field");
      equal(await store.searchOpen(), true, "searchOpen in the store");
      const hint = await bar.locator('[data-testid="search-hint"]').innerText();
      for (const word of ["message", "author", "SHA"]) check(hint.includes(word), `the hint mentions "${word}"`);
      equal(await counter(), "", "no counter yet");
      equal(await bar.getByRole("button", { name: "Next match" }).isDisabled(), true, "\"Next match\" is disabled without matches");
      await shot(app, "commit-search-empty");
    });

    let regen = [];
    await section("Search in the message: matches like git log, highlighting, counter, store", async () => {
      await search("regen");
      await options.first().waitFor();
      regen = await hitShas();
      const expected = gitSearch("regen");
      equal([...regen].sort(), [...expected].sort(), "the same commits as git log --grep / --author");
      check(regen.length >= 3, `several matches (${regen.length})`);
      const order = lines(rich.git("log", "--format=%H", "--date-order", "--branches", "--remotes", "--tags", "HEAD")).filter((sha) => expected.has(sha));
      equal(regen[0], order[0], "the newest match is on top");
      equal(await counter(), `${regen.length} matches`, "counter before the first jump");
      const summaries = await options.evaluateAll((rows) => rows.map((row) => row.getAttribute("title").split("\n")[0]));
      const visible = summaries.findIndex((summary) => /regen/i.test(summary));
      check(visible >= 0, "at least one match has the word in the summary");
      check((await marks(visible)).every((text) => text.toLowerCase() === "regen") && (await marks(visible)).length > 0, `the match is highlighted in the summary (${JSON.stringify(await marks(visible))})`);
      const first = await options.first().innerText();
      check(first.includes(short(regen[0])), "the row shows the short SHA");
      await eventually(store.search, { query: "regen", hits: regen, active: -1 }, "matches are in the store for highlighting in the graph");
      equal(await store.selection(), { kind: "wip" }, "typing alone does not change the selection");
      await shot(app, "commit-search");
    });

    await section("Enter / Shift+Enter / F3 / Shift+F3 jump from match to match", async () => {
      const count = regen.length;
      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: [regen[0]] }, "Enter jumps to the first match");
      equal(await counter(), `1 of ${count}`, "counter");
      equal((await store.search()).active, 0, "active match in the store");
      equal((await store.view()).reveal?.sha, regen[0], "the graph is asked to scroll there");
      equal(await activeSha(), regen[0], "the active match is marked in the list (aria-current)");
      await eventually(focusedLabel, "Search commits", "focus stays in the search field");

      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: [regen[1]] }, "Enter: next");
      equal(await counter(), `2 of ${count}`, "counter");
      await page.keyboard.press("F3");
      await eventually(store.selection, { kind: "commits", shas: [regen[2]] }, "F3: next");
      await page.keyboard.press("Shift+F3");
      await eventually(store.selection, { kind: "commits", shas: [regen[1]] }, "Shift+F3: previous");
      await page.keyboard.press("Shift+Enter");
      await eventually(store.selection, { kind: "commits", shas: [regen[0]] }, "Shift+Enter: previous");
      await page.keyboard.press("Shift+Enter");
      await eventually(store.selection, { kind: "commits", shas: [regen[count - 1]] }, "before the first it wraps to the last");
      equal(await counter(), `${count} of ${count}`, "counter at the end");
      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: [regen[0]] }, "after the last it wraps to the first");
      // The commit panel shows the match
      await page.locator(`[data-screen="commit-details"] code[title="${regen[0]}"]`).waitFor();
    });

    await section("Arrow keys move the cursor in the list, Enter jumps there", async () => {
      equal(await cursorSha(), regen[0], "the cursor is on the active match");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await eventually(cursorSha, regen[2], "arrow down twice");
      equal(await store.selection(), { kind: "commits", shas: [regen[0]] }, "arrow keys alone do not jump");
      await page.keyboard.press("ArrowUp");
      await eventually(cursorSha, regen[1], "arrow up");
      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: [regen[1]] }, "Enter jumps to the marked match");
      equal((await store.search()).active, 1, "active match in the store");
      equal(await options.nth(1).getAttribute("aria-selected"), "true", "the marked row is aria-selected");
    });

    await section("F3 also works with focus outside the search field; Ctrl+F brings focus back", async () => {
      await bar.getByRole("button", { name: "Close search" }).focus();
      await page.keyboard.press("F3");
      await eventually(store.selection, { kind: "commits", shas: [regen[2]] }, "F3 from the close button");
      await page.keyboard.press("Control+f");
      await eventually(focusedLabel, "Search commits", "Ctrl+F puts focus back into the field");
      equal(await input.inputValue(), "regen", "the search text stays");
    });

    await section("Clicking a match jumps to the commit", async () => {
      await options.nth(0).click();
      await eventually(store.selection, { kind: "commits", shas: [regen[0]] }, "click selects the commit");
      equal(await counter(), `1 of ${regen.length}`, "counter follows");
      await eventually(focusedLabel, "Search commits", "focus stays in the search field");
      await bar.getByRole("button", { name: "Next match" }).click();
      await eventually(store.selection, { kind: "commits", shas: [regen[1]] }, "button \"Next match\"");
      await bar.getByRole("button", { name: "Previous match" }).click();
      await eventually(store.selection, { kind: "commits", shas: [regen[0]] }, "button \"Previous match\"");
    });

    await section("From a file view the jump leads back to the graph", async () => {
      await page.evaluate((tab) => window.__gc.store.getState().openFile(tab, "README.md", null), tabId);
      await eventually(async () => (await store.center())?.kind, "file", "center shows a file");
      await input.focus();
      await page.keyboard.press("Enter");
      await eventually(async () => (await store.center())?.kind, "graph", "after the jump the center shows the graph again");
    });

    await section("Search by author", async () => {
      await search("aylin");
      const expected = gitSearch("aylin");
      await eventually(async () => (await hitShas()).sort(), [...expected].sort(), "all commits by Aylin Demir");
      check(expected.size >= 3, `several commits (${expected.size})`);
      equal(await marks(0), ["Aylin"], "the name is highlighted in the author column");
      const authors = await options.evaluateAll((rows) => rows.map((row) => row.getAttribute("title").split("\n")[1]));
      check(authors.every((line) => line.startsWith("Aylin Demir <aylin.demir@wetterstation.example>")), "every row names the author");
      equal((await store.search()).active, -1, "a new search has no active match yet");
      await shot(app, "commit-search-author");
    });

    await section("Search by SHA prefix", async () => {
      const prefix = shas.longSummary.slice(0, 8);
      await search(prefix.toUpperCase());
      await eventually(hitShas, [shas.longSummary], "exactly the commit with this SHA");
      equal(await marks(0), [short(shas.longSummary)], "the short SHA is highlighted");
      equal(await overflowX(page, BAR), { page: 0, element: 0 }, "the 160-character summary does not break the row");
      const row = await options.first().boundingBox();
      check(row && row.height <= 28, `the row stays single-line (height ${row?.height})`);
      check((await options.first().getAttribute("title")).startsWith("Plausibilitätsprüfung für alle Sensoren eingeführt, damit Ausreißer"), "the full summary is in the tooltip");
      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: [shas.longSummary] }, "Enter jumps there");
      await shot(app, "commit-search-sha");

      await search(shas.longSummary.slice(0, 3));
      await bar.locator('[data-testid="search-empty"]').waitFor();
      check(true, "three hex characters are not a SHA search yet");
    });

    await section("Search with umlauts and special characters", async () => {
      await search("Plausibilitätsprüfung");
      const expected = gitSearch("Plausibilitätsprüfung");
      await eventually(async () => (await hitShas()).sort(), [...expected].sort(), "matches with umlauts");
      await search("-999");
      await eventually(async () => (await hitShas()).length, gitSearch("-999").size, "search text starting with a minus");
      await search("[regen");
      await bar.locator('[data-testid="search-empty"]').waitFor();
      check(true, "a bracket is searched literally, not as a pattern");
      equal(await toasts(page), [], "no error toast");
    });

    await section("No matches", async () => {
      await search("gibtesnichtxyz");
      const empty = bar.locator('[data-testid="search-empty"]');
      await empty.waitFor();
      check((await empty.innerText()).includes("“gibtesnichtxyz”"), "the text names the search term");
      equal(await counter(), "No matches", "counter");
      await eventually(store.search, { query: "gibtesnichtxyz", hits: [], active: -1 }, "store: no matches");
      const before = await store.selection();
      await page.keyboard.press("Enter");
      await page.keyboard.press("F3");
      equal(await store.selection(), before, "Enter and F3 without matches do nothing");
      await shot(app, "commit-search-no-results");
    });

    await section("Error: understandable message and \"Try again\"", async () => {
      const broken = await tamper(page, "commitSearch", { fail: { code: "io", message: "The history could not be read.", gitOutput: null } });
      await search("tagesmittel");
      const alert = bar.getByRole("alert");
      await alert.waitFor();
      const text = await alert.innerText();
      check(text.includes("The search failed") && text.includes("The history could not be read."), `error text (${JSON.stringify(text)})`);
      await eventually(async () => (await store.search()).hits, [], "after an error no old matches remain in the store");
      await shot(app, "commit-search-error");
      await broken.restore();
      await alert.getByRole("button", { name: "Try again" }).click();
      await eventually(async () => (await hitShas()).sort(), [...gitSearch("tagesmittel")].sort(), "after retrying the matches are listed");
      await eventually(focusedLabel, "Search commits", "focus is back in the search field afterwards");
    });

    await section("Loading state: skeleton rows", async () => {
      const slow = await tamper(page, "commitSearch", { delayMs: 1500 });
      await search("windmesser");
      await bar.locator('[data-testid="search-loading"]').waitFor({ timeout: 3000 });
      if (shots) await app.screenshot(`${SHOT_DIR}/commit-search-loading.png`);
      await slow.restore();
      await options.first().waitFor();
      equal((await hitShas()).length, gitSearch("windmesser").size, "then the matches");
    });

    await section("Esc closes the search and clears the highlighting", async () => {
      await search("regen");
      await options.first().waitFor();
      await page.keyboard.press("Enter");
      await eventually(async () => (await store.search()).active, 0, "a match is active");
      const selected = await store.selection();
      await page.keyboard.press("Escape");
      await eventually(() => bar.count(), 0, "the bar is closed");
      equal(await store.searchOpen(), false, "searchOpen in the store");
      equal(await store.search(), { query: "", hits: [], active: -1 }, "matches and active match are cleared");
      equal(await store.selection(), selected, "the selection stays");
      await page.keyboard.press("F3");
      equal(await store.selection(), selected, "F3 does nothing while the search is closed");

      await page.keyboard.press("Control+f");
      await input.waitFor();
      equal(await input.inputValue(), "", "the field is empty on the next open");
      await bar.getByRole("button", { name: "Close search" }).click();
      await eventually(() => bar.count(), 0, "the close button closes too");
    });

    await section("Window sizes and themes", async () => {
      await page.keyboard.press("Control+f");
      await input.waitFor();
      await search("regen");
      await options.first().waitFor();
      await page.keyboard.press("Enter");
      await app.setTheme("light");
      await shot(app, "commit-search-light");
      await app.setTheme("dark");
      await app.setSize(960, 600);
      await page.waitForTimeout(300);
      equal(await overflowX(page, BAR), { page: 0, element: 0 }, "960×600: no horizontal overflow");
      const box = await bar.boundingBox();
      const main = await page.locator('[data-area="center"]').boundingBox();
      check(box && main && main.height - box.height >= 160, `960×600: room for the graph remains below the search (${main ? main.height - (box?.height ?? 0) : "?"} px)`);
      await shot(app, "commit-search-min");
      await app.setSize(1440, 900);
      await page.keyboard.press("Escape");
    });

    assertNoConsoleErrors(app, "rich repository");
    await app.close();
  }

  // =========================================================================
  // B. Large repository: more matches than the limit, matches outside the loaded rows
  // =========================================================================
  {
    const large = makeLargeRepo();
    cleanups.push(() => large.cleanup());
    const app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
    apps.push(app);
    const { page } = app;
    const { tabId } = await app.openRepo(large.path);
    const store = storeApi(app, tabId);
    const bar = page.locator(BAR);
    const input = page.getByRole("combobox", { name: "Search commits" });
    const options = bar.locator('[role="option"]');

    await section("More matches than the limit: the first 200, with a note", async () => {
      await page.keyboard.press("Control+f");
      await input.waitFor();
      await page.keyboard.type("Auswertung");
      const started = Date.now();
      const note = bar.locator('[data-testid="search-limit"]');
      await note.waitFor({ timeout: 60_000 });
      const elapsed = Date.now() - started;
      check((await note.innerText()).includes("the first 200"), "the note names the limit");
      equal(await options.count(), 200, "200 rows in the list");
      equal(await bar.locator('[data-testid="search-counter"]').innerText(), "200+ matches", "counter shows \"200+\"");
      equal((await store.search()).hits.length, 200, "200 matches in the store");
      const total = Number(large.git("rev-list", "--count", "-i", "-F", "--grep=Auswertung", "--all"));
      check(total > 200, `the repository has more (${total})`);
      check(elapsed < 20_000, `answer in ${elapsed} ms with 50,000 commits`);
      await shot(app, "commit-search-limit");
      await page.keyboard.press("Shift+Enter");
      await eventually(() => bar.locator('[data-testid="search-counter"]').innerText(), "200 of 200+", "Shift+Enter jumps to the last of the 200");
    });

    await section("Match far back in history (outside the loaded rows)", async () => {
      await page.keyboard.press("Control+a");
      await page.keyboard.type("(#17)");
      const expected = lines(large.git("log", "--format=%H", "-F", "--grep=(#17)", "--all"));
      equal(expected.length, 1, "git knows exactly one such commit");
      await eventually(() => options.evaluateAll((rows) => rows.map((row) => row.dataset.sha)), expected, "the search finds it across the whole history", 30_000);
      await page.keyboard.press("Enter");
      await eventually(store.selection, { kind: "commits", shas: expected }, "Enter selects it");
      await page.locator(`[data-screen="commit-details"] code[title="${expected[0]}"]`).waitFor();
      check((await page.locator('[data-screen="commit-details"] [data-testid="commit-summary"]').innerText()).endsWith("(#17)"), "the commit panel shows its details");
    });

    assertNoConsoleErrors(app, "large repository");
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
  console.error(`\nS17: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nS17: all green");
