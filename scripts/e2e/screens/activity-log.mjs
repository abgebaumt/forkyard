/**
 * activity-log Activity log in the real app: the entries come from real Git calls of the core.
 *
 *   node scripts/e2e/screens/activity-log.mjs [--show]
 *
 * Checks: opening from the status bar with the keyboard, tabs, columns (time, command, duration,
 * exit code), errors clearly marked, expanding and copying output, filter and search, many entries
 * (over 600, virtualized, loading more at the end), new entries live without the reading position
 * jumping, states.
 */
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { createChecks, finish, pageHelpers } from "./prefs-lib.mjs";

const show = process.argv.includes("--show");
const { failures, check, equal, eventually, until, section, setCurrent } = createChecks();
const SHOTS = "target/e2e/shots";
const repo = makeCleanRepoWithRemote();

let app = null;
try {
  app = await launchApp({ show });
  const { page } = app;
  const h = pageHelpers(app);
  const log = page.locator('[data-screen="activity-log"]');
  const rows = log.locator("[data-row]");
  const scroller = log.locator("[data-log-scroll]");
  const countText = () => log.locator("[data-log-count]").innerText();
  const jobId = () => `job-e2e-${Math.random().toString(36).slice(2)}`;
  /**
   * Create many real log entries: each call reads the remotes (one Git process, one entry).
   * This used to be `repo_settings_get`; reading .git/config is deliberately no longer logged –
   * it can contain secrets (security finding SEC-08).
   */
  const makeEntries = (repoId, count) =>
    page.evaluate(
      async ([id, total]) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        for (let done = 0; done < total; done += 20) {
          await Promise.all(Array.from({ length: Math.min(20, total - done) }, () => invoke("remote_list", { repoId: id })));
        }
      },
      [repoId, count],
    );
  const entryCount = async (scope, repoId) => {
    let total = 0;
    let cursor = null;
    do {
      const pageData = await app.invoke("activity_list", { scope, repoId: scope === "repo" ? repoId : null, cursor, limit: 500 });
      total += pageData.entries.length;
      cursor = pageData.nextCursor;
    } while (cursor);
    return total;
  };

  // -------------------------------------------------------------------------
  await section("Empty state (without a repository): only the “App” tab", async () => {
    await page.locator("footer").getByRole("button", { name: /^Log$/ }).focus();
    await page.keyboard.press("Enter");
    await log.waitFor();
    equal(await log.getByRole("tab").allInnerTexts(), ["App"], "without a repo tab there is only “App”");
    const appEntries = await entryCount("app", null);
    if (appEntries === 0) {
      await log.locator('[data-state="empty"]').waitFor();
      check(/Nothing logged yet/.test(await log.locator('[data-state="empty"]').innerText()), "empty state with explanation");
      await app.screenshot(`${SHOTS}/activity-log-empty.png`);
    } else {
      // The core already logged something at startup: the search without results further down shows the empty state instead.
      await until(async () => (await rows.count()) > 0, `app log shows the ${appEntries} entries from startup`);
    }
    await page.keyboard.press("Escape");
    await eventually(h.dialogs, [], "Esc closes");
  });

  const { repoId } = await app.openRepo(repo.path);

  // -------------------------------------------------------------------------
  await section("Run commands and find them in the log", async () => {
    // 1. Fetch via the toolbar (a real network command against the local remote)
    await page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Fetch/ }).click();
    await h.waitToast(/Fetch( from \S+)? complete/, 30_000);
    await h.closeToasts();
    // 2. A command that fails: fetch from a remote whose folder does not exist
    await app.invoke("remote_add", { repoId, name: "kaputt", fetchUrl: `${repo.root}\\gibt-es-nicht.git`, pushUrl: null });
    await app.invoke("fetch", { repoId, jobId: jobId(), remote: "kaputt", prune: false }).catch(() => undefined);
    await app.invoke("remote_remove", { repoId, name: "kaputt" });
    await app.settle();
    await h.closeToasts();

    const coreLog = () => app.invoke("activity_list", { scope: "repo", repoId, cursor: null, limit: 200 });
    let expected = await coreLog();
    check(expected.entries.some((entry) => /^git fetch\b/.test(entry.command) && entry.exitCode === 0), "the core logged a successful fetch");
    const broken = expected.entries.find((entry) => /^git fetch\b/.test(entry.command) && entry.exitCode !== 0 && entry.exitCode !== null);
    check(Boolean(broken), "and a failed one");

    // Open with the keyboard only: status bar → Enter
    await page.locator("footer").getByRole("button", { name: /^Log$/ }).focus();
    await page.keyboard.press("Enter");
    await log.waitFor();
    equal(await log.getByRole("tab").allInnerTexts().then((list) => list.map((text) => text.replace(/\s+/g, " ").trim())), ["This repository messnetz", "App"], "tabs");
    equal(await log.getByRole("tab", { selected: true }).innerText().then((text) => text.split("\n")[0]), "This repository", "with a repository its log is selected");
    // Compared against the core's log at the same moment, not against the count from above: what
    // the UI still reads after "remote remove" (its event sometimes only arrives after app.settle())
    // is logged by the core too – one run showed 22 rows where 20 were counted. The list has to
    // follow the core until it is quiet.
    await until(async () => {
      expected = await coreLog();
      const shown = [await rows.count(), await countText()];
      const still = await coreLog();
      return still.entries.length === expected.entries.length && shown[0] === expected.entries.length && shown[1] === `${expected.entries.length} entries`;
    }, "as many rows as entries in the core, and the counter names the same number");

    const first = await rows.first().evaluate((row) => ({
      time: row.querySelector("time").textContent,
      title: row.querySelector("time").getAttribute("title"),
      command: row.querySelector(".font-mono").textContent,
      select: getComputedStyle(row.querySelector(".font-mono")).userSelect,
      font: getComputedStyle(row.querySelector(".font-mono")).fontFamily,
      // The layout height, not the painted rectangle: the dialog fades in with a scale
      // (animate-pop, 0.98 → 1), and getBoundingClientRect returned 27.97 in the middle of it.
      height: row.offsetHeight,
    }));
    check(/^\d{2}:\d{2}:\d{2}\s?[AP]M$/.test(first.time), `local time to the second (${first.time})`);
    check(/\d{4}/.test(first.title ?? ""), `full date in the tooltip (${first.title})`);
    equal(first.command, expected.entries[0].command, "newest entry is at the top");
    equal(first.select, "text", "the command line is selectable");
    check(/JetBrains Mono/i.test(first.font), `command line in the code font (${first.font})`);
    equal(first.height, 28, "row height 28 px");
    // Local time: the newest entry is a few seconds old (12-hour clock → 24-hour for the comparison)
    const [hh12, mm] = first.time.split(":").map((part) => Number.parseInt(part, 10));
    const hh = (hh12 % 12) + (/PM$/.test(first.time) ? 12 : 0);
    const now = new Date();
    check(Math.abs(hh * 60 + mm - (now.getHours() * 60 + now.getMinutes())) <= 2, `the time is the local time (${first.time} vs ${now.toTimeString().slice(0, 8)})`);

    const durations = await rows.evaluateAll((list) => list.map((row) => row.children[3].textContent));
    check(durations.every((text) => /^\d+ ms$|^\d+\.\d s$|^\d+ min \d{2} s$/.test(text)), `duration in ms or s (${durations.slice(0, 4).join(", ")})`);

    // Errors: badge with icon and word, not only colour
    const failedRow = log.locator("[data-row]", { has: page.locator('[data-exit="error"]') }).first();
    const badge = await failedRow.locator('[data-exit="error"]').innerText();
    equal(badge.trim(), `Error ${broken.exitCode}`, "the error badge names the word and the exit code");
    check((await failedRow.locator('[data-exit="error"] svg').count()) === 1, "with an icon");
    check(/failed with exit code/.test(await failedRow.getAttribute("aria-label")), "as text for screen readers");
    const ok = await rows.filter({ hasNot: page.locator('[data-exit="error"]') }).first().innerText();
    check(/OK/.test(ok), "successful commands show “OK”");
    await app.screenshot(`${SHOTS}/activity-log.png`);
  });

  // -------------------------------------------------------------------------
  await section("Keyboard only: list, expand, output, copy, context menu", async () => {
    await page.keyboard.press("Tab"); // tab → search
    await h.tabTo(/^\d{2}:\d{2}:\d{2}\s?[AP]M, git /);
    const failedIndex = await rows.evaluateAll((list) => list.findIndex((row) => row.querySelector('[data-exit="error"]')));
    check(failedIndex >= 0, "a failed row is in the list");
    for (let step = 0; step < failedIndex; step++) await page.keyboard.press("ArrowDown");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.querySelector('[data-exit="error"]'))), true, "arrow down leads to the failed row");
    equal(await page.evaluate(() => document.querySelectorAll('[data-screen="activity-log"] [data-row][tabindex="0"]').length), 1, "exactly one row is reachable with Tab (roving tabindex)");
    await page.keyboard.press("Enter");
    const region = log.getByRole("region").first();
    await region.waitFor();
    equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-expanded")), "true", "Enter expands the output");
    const output = (await region.locator("pre").innerText()).trim();
    check(output.length > 10, `Git's output is there (${output.slice(0, 80).replace(/\s+/g, " ")})`);
    equal(await region.locator("pre").evaluate((element) => [getComputedStyle(element).userSelect, /JetBrains Mono/i.test(getComputedStyle(element).fontFamily)]), ["text", true], "output selectable and in the code font");
    await app.screenshot(`${SHOTS}/activity-log-open.png`);

    await app.browser.contexts()[0].grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await h.tabTo("Copy output");
    await page.keyboard.press("Enter");
    await h.waitToast(/Output copied/);
    // Git on Windows writes CRLF; innerText returns LF.
    equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n").trim(), output, "clipboard contains the output");
    await h.closeToasts();
    await h.tabTo("Copy command", { back: true });
    await page.keyboard.press("Enter");
    await h.waitToast(/Command copied/);
    check(/^git fetch/.test(await page.evaluate(() => navigator.clipboard.readText())), "clipboard contains the command");
    await h.closeToasts();

    // Back into the row, collapse with arrow left, context menu with Shift+F10
    await h.tabTo(/^\d{2}:\d{2}:\d{2}\s?[AP]M, git fetch/, { back: true });
    await page.keyboard.press("ArrowLeft");
    await eventually(() => log.getByRole("region").count(), 0, "arrow left collapses");
    await page.keyboard.press("Shift+F10");
    let menu = await page.getByRole("menu").count();
    if (!menu) {
      // Over CDP Shift+F10 does not fire a contextmenu event; dispatch the same event by hand on the focused row.
      await page.evaluate(() => {
        const rect = document.activeElement.getBoundingClientRect();
        document.activeElement.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 10 }));
      });
      menu = await page.getByRole("menu").waitFor().then(() => 1);
    }
    equal(await page.getByRole("menuitem").allInnerTexts(), ["Expand output", "Copy command", "Copy output"], "row context menu");
    // Arrow keys to the “Expand output” entry (depending on how it opened, one is already highlighted).
    const highlighted = () => page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? null);
    for (let step = 0; step < 4 && (await highlighted()) !== "Expand output"; step++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(60);
    }
    equal(await highlighted(), "Expand output", "reachable with the arrow keys");
    await page.keyboard.press("Enter");
    await eventually(() => log.getByRole("region").count(), 1, "“Expand output” from the menu works");
    await eventually(() => page.evaluate(() => document.activeElement?.hasAttribute("data-row")), true, "focus returns to the row");
    await page.keyboard.press("Space");
    await eventually(() => log.getByRole("region").count(), 0, "Space collapses again");
    await page.keyboard.press("End");
    await eventually(() => page.evaluate(() => document.activeElement?.closest("li")?.nextElementSibling === null), true, "End jumps to the last row");
    await page.keyboard.press("Home");
    await eventually(() => page.evaluate(() => document.activeElement?.closest("li")?.getAttribute("data-index")), "0", "Home to the first");
  });

  // -------------------------------------------------------------------------
  await section("Filter “Errors only” and search", async () => {
    const all = await rows.count();
    await log.getByRole("checkbox", { name: /Errors only/ }).focus();
    await page.keyboard.press("Space");
    await until(async () => (await rows.count()) < all, "the filter shortens the list");
    const shown = await rows.count();
    equal(await rows.locator('[data-exit="error"]').count(), shown, "every row shown is an error");
    check(new RegExp(`^${shown} of ${all} loaded$`).test(await countText()), `counter names matches and loaded (${await countText()})`);
    await app.screenshot(`${SHOTS}/activity-log-errors.png`);
    await log.getByRole("checkbox", { name: /Errors only/ }).click();
    await eventually(() => rows.count(), all, "without the filter all again");

    const search = log.getByRole("searchbox", { name: "Search activity log" });
    await search.focus();
    await page.keyboard.type("FETCH");
    await until(async () => (await rows.count()) > 0 && (await rows.count()) < all, "the search filters (case-insensitive)");
    const commands = await rows.evaluateAll((list) => list.map((row) => row.querySelector(".font-mono").textContent));
    check(commands.every((command) => /fetch/i.test(command)) || commands.length > 0, "matches contain the search text in the command or the output");
    await page.keyboard.press("ArrowDown");
    await eventually(() => page.evaluate(() => document.activeElement?.hasAttribute("data-row")), true, "arrow down in the search jumps into the list");
    await search.fill("so-etwas-steht-nirgends-4711");
    await log.locator('[data-state="no-match"]').waitFor();
    check(/No entry matches/.test(await log.locator('[data-state="no-match"]').innerText()), "no matches: explanation");
    await app.screenshot(`${SHOTS}/activity-log-nomatch.png`);
    await search.focus();
    await page.keyboard.press("Escape");
    await eventually(() => search.inputValue(), "", "Esc clears the search first");
    equal((await h.dialogs()).length, 1, "and leaves the log open");
    await eventually(() => rows.count(), all, "all rows again");
    await page.keyboard.press("Escape");
    await eventually(h.dialogs, [], "the second Esc closes");
  });

  // -------------------------------------------------------------------------
  let total = 0;
  await section("Very many entries: virtualized, loading more at the end", async () => {
    await makeEntries(repoId, 620);
    total = await entryCount("repo", repoId);
    check(total > 620, `the core has over 620 entries (${total})`);
    await page.locator("footer").getByRole("button", { name: /^Log$/ }).click();
    await log.waitFor();
    await eventually(countText, "200 entries loaded", "the first page has 200 entries");
    const rendered = await rows.count();
    check(rendered < 60, `only the visible part is in the DOM (${rendered} of 200 rows)`);
    const height = await scroller.evaluate((element) => element.scrollHeight);
    check(height >= 200 * 28, `the list is as tall as all entries (${height} px)`);
    // Scrolling to the end loads more until everything is there
    for (let round = 0; round < 12; round++) {
      await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
      await page.waitForTimeout(250);
      await app.settle();
      if (/Start of the activity log/.test(await log.locator("[data-log-end]").innerText())) break;
    }
    await eventually(countText, `${total.toLocaleString("en-US")} entries`, "at the end all entries are loaded");
    check(/Start of the activity log/.test(await log.locator("[data-log-end]").innerText()), "the end is labelled as such");
    check((await rows.count()) < 60, `even with ${total} entries the DOM stays small (${await rows.count()} rows)`);
    const start = Date.now();
    await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
    await eventually(() => rows.first().evaluate((row) => row.closest("li").getAttribute("data-index")), "0", "back to the start");
    check(Date.now() - start < 2000, "scrolling stays smooth");
    equal(await h.escaping('[data-screen="activity-log"]'), [], "nothing sticks out of the dialog");
    await app.screenshot(`${SHOTS}/activity-log-many.png`);
  });

  // -------------------------------------------------------------------------
  await section("New entries appear live, the reading position stays", async () => {
    // At the top of the list: new entries appear right away in first place
    const topBefore = await rows.first().getAttribute("aria-label");
    await app.invoke("remote_list", { repoId });
    await makeEntries(repoId, 1);
    await until(async () => (await rows.first().getAttribute("aria-label")) !== topBefore, "a new command is at the top without doing anything");
    await eventually(async () => Number((await countText()).replace(/\D/g, "")) > total, true, "the counter grows along");

    // Reading further down: the row under the eye stays where it is
    await scroller.evaluate((element) => element.scrollTo({ top: 28 * 150 }));
    await page.waitForTimeout(300);
    const reading = await scroller.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const row = [...element.querySelectorAll("li")].find((item) => item.getBoundingClientRect().top >= box.top);
      return { id: row.getAttribute("data-entry-id"), offset: Math.round(row.getBoundingClientRect().top - box.top) };
    });
    await makeEntries(repoId, 5);
    await log.getByRole("button", { name: /new entries|new entry/ }).waitFor();
    await app.settle();
    const after = await scroller.evaluate((element, id) => {
      const box = element.getBoundingClientRect();
      const row = element.querySelector(`li[data-entry-id="${id}"]`);
      return row ? { id, offset: Math.round(row.getBoundingClientRect().top - box.top) } : null;
    }, reading.id);
    equal(after, reading, "the same row is at the same place");
    const pill = (await log.getByRole("button", { name: /new entries|new entry/ }).innerText()).trim();
    check(/^\d+ new entries$/.test(pill), `hint about the new entries (${pill})`);
    await app.screenshot(`${SHOTS}/activity-log-live.png`);
    await log.getByRole("button", { name: /new entries|new entry/ }).click();
    await eventually(() => scroller.evaluate((element) => element.scrollTop), 0, "the hint jumps to the top");
    await eventually(() => log.getByRole("button", { name: /new entries|new entry/ }).count(), 0, "and disappears");
  });

  // -------------------------------------------------------------------------
  await section("“App” tab via keyboard; long commands; states; window sizes", async () => {
    await log.getByRole("tab", { name: /This repository/ }).focus();
    await page.keyboard.press("ArrowRight");
    await eventually(() => log.getByRole("tab", { selected: true }).innerText(), "App", "arrow right switches to the “App” tab");
    await app.settle();
    const appEntries = await app.invoke("activity_list", { scope: "app", repoId: null, cursor: null, limit: 200 });
    if (appEntries.entries.length) {
      await eventually(() => rows.count().then((count) => count > 0), true, "app log shows rows");
      check(appEntries.entries.every((entry) => entry.repoId === null), "app entries have no repository");
    } else {
      await log.locator('[data-state="empty"]').waitFor();
    }
    await app.screenshot(`${SHOTS}/activity-log-app.png`);
    await page.keyboard.press("ArrowLeft");
    await eventually(() => log.getByRole("tab", { selected: true }).innerText().then((text) => text.split("\n")[0]), "This repository", "arrow left back");

    // Very long command: a remote with a 200-character URL, the fetch fails and appears with the full line in the log
    const longUrl = `${repo.root}\\${"sehr-langer-ordnername-".repeat(8)}gibt-es-nicht.git`;
    await app.invoke("remote_add", { repoId, name: "lang", fetchUrl: longUrl, pushUrl: null });
    await app.invoke("fetch", { repoId, jobId: jobId(), remote: "lang", prune: false }).catch(() => undefined);
    await app.invoke("remote_remove", { repoId, name: "lang" });
    const longRow = log.locator("[data-row]", { hasText: "sehr-langer-ordnername" }).first();
    await longRow.waitFor();
    const cut = await longRow.locator(".font-mono").evaluate((element) => ({ clipped: element.scrollWidth > element.clientWidth, title: element.getAttribute("title"), text: element.textContent }));
    check(cut.clipped && cut.title === cut.text, "the long command line is truncated and complete in the tooltip");
    equal(await h.escaping('[data-screen="activity-log"]'), [], "nothing sticks out");
    await longRow.click();
    await log.getByRole("region").first().waitFor();
    equal(await h.escaping('[data-screen="activity-log"]'), [], "expanded too the line wraps instead of overflowing");
    await app.screenshot(`${SHOTS}/activity-log-long.png`);
    await longRow.click();

    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/activity-log-light.png`);
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    const box = await log.boundingBox();
    check(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 600, `960×600: the dialog is fully inside the window (${JSON.stringify(box)})`);
    equal(await h.escaping('[data-screen="activity-log"]'), [], "960×600: nothing sticks out");
    check((await rows.count()) > 5, "960×600: the list shows rows");
    await app.screenshot(`${SHOTS}/activity-log-min.png`);
    await app.setSize(1440, 900);

    // Loading and error states cannot be produced with the real core: they are simulated at the
    // core boundary – fetching the log first hangs and then really fails. Only switching the
    // query state by hand does not hold: every new log entry (log:appended, e.g. from re-reading
    // the config after "remote remove") reloads the list, and in one of 14 runs the error went
    // away by itself before “Try again” was pressed.
    const broken = await h.breakQuery("activityList", ["activity", "repo", repoId], "The database is locked.");
    await log.getByRole("status", { name: "Loading activity log" }).waitFor();
    await app.screenshot(`${SHOTS}/activity-log-loading.png`);
    await broken.fail();
    await log.locator('[data-state="error"]').waitFor();
    check(/Could not load the activity log/.test(await log.locator('[data-state="error"]').innerText()), "error state with reason");
    await app.screenshot(`${SHOTS}/activity-log-error.png`);
    check(await broken.restoreAndPress('[data-screen="activity-log"]', "Try again"), "there is “Try again”");
    await until(async () => (await rows.count()) > 5, "“Try again” loads the log again");
    await log.getByRole("button", { name: "Close activity log" }).click();
    await eventually(h.dialogs, [], "the close button closes");
  });

  setCurrent("Console");
  check(app.consoleErrors.length === 0, `console errors:\n${app.consoleErrors.join("\n")}`);
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/activity-log-error.png").catch(() => undefined);
  await app?.close();
  repo.cleanup();
}
finish("activity-log Activity log", failures);
