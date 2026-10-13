/**
 * file-history – file history in the real app, against a real Git repository.
 *
 *   node scripts/e2e/screens/file-history.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/file-history.mjs --only renamed   only sections whose title contains "renamed" (comma separates several)
 *   node scripts/e2e/screens/file-history.mjs --show           visible window
 *
 * The list is compared with git log --follow; restore and undo are verified in the working
 * directory and the index. The "keyboard only" section never uses the mouse. At the end the
 * script fails on console errors.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { FILES, SHOTS, addManyCommits, closeToasts, editorText, finish, makeChecks, makeDriver, makeFilesRepo } from "./files-lib.mjs";

const show = process.argv.includes("--show");
const checks = makeChecks("file-history");
const { check, equal, eventually, until, section, measurements, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const fx = makeFilesRepo();
const { git, gitRaw, read, write, shas } = fx;
const exists = (file) => fs.existsSync(path.join(fx.repo.path, file));
const short = (sha) => sha.slice(0, 7);
const MANY = "daten/viele.log";
const LONG = "text/lang.txt";
const FRESH = "notizen/frisch.txt";
const LONG_SUMMARY = `Auswertung der Niederschlagsmessung überarbeitet: ${"Tageswerte, Monatswerte und Jahreswerte werden jetzt getrennt gerechnet; ".repeat(4)}Ende`;
const LONG_AUTHOR = { name: "Maximiliane-Alexandra von Hohenstein-Wetterau zu Niederbayern-Oberpfalz", email: "maximiliane.alexandra@wetterstation.example" };

const manyShas = addManyCommits(fx, MANY, 450);
write(LONG, "eins\n");
gitRaw(["add", "-A"]);
gitRaw(["commit", "-q", "-m", LONG_SUMMARY], { person: LONG_AUTHOR });
write(FRESH, "noch nie committet\n");

/** git log --follow as a list: SHA, author, summary, +/−. */
const followLog = (file) => {
  const entries = [];
  for (const line of git("-c", "core.quotepath=false", "log", "--follow", "--numstat", "--format=%H%x09%an%x09%s", "--", file).split("\n")) {
    const parts = line.split("\t");
    if (/^[0-9a-f]{40}$/.test(parts[0] ?? "")) entries.push({ sha: parts[0], author: parts[1], summary: parts[2], added: null, removed: null });
    else if (parts.length >= 3 && entries.length) Object.assign(entries[entries.length - 1], { added: parts[0], removed: parts[1] });
  }
  return entries;
};

let app = null;
try {
  app = await launchApp({ show });
  state.app = app;
  const { page } = app;
  const { tabId, repoId } = await app.openRepo(fx.repo.path);
  const ui = makeDriver(app, tabId, checks);
  const screen = page.locator('[data-screen="file-history"]');
  const list = screen.locator("[data-history-list]");
  const detail = screen.locator('[data-screen="diff"]');
  const action = (name) => screen.locator(`[data-history-actions] [data-action="${name}"]`);
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  const rows = () =>
    list.locator('[role="option"]').evaluateAll((items) =>
      items.map((item) => ({
        index: Number(item.dataset.index),
        sha: item.dataset.sha,
        status: item.dataset.status,
        path: item.dataset.path,
        added: item.dataset.added ?? null,
        removed: item.dataset.removed ?? null,
        selected: item.getAttribute("aria-selected") === "true",
        text: item.innerText.replace(/\s+/g, " ").trim(),
      })),
    );
  const selected = async () => (await rows()).find((row) => row.selected) ?? null;
  const selectedIndex = async () => (await selected())?.index ?? null;
  const ready = async (file) => {
    await page.waitForFunction(
      (label) => {
        const root = document.querySelector('[data-screen="file-history"]');
        return root?.getAttribute("aria-label") === label && !root.querySelector("[data-loading]");
      },
      `History of ${file}`,
      { timeout: 30_000 },
    );
    await app.settle();
  };
  const openHistory = async (file) => {
    await ui.store("openHistory", tabId, file);
    await ready(file);
  };
  /** Waits until the embedded diff shows the text. */
  const diffShows = (needle, message) => until(async () => (await detail.count()) > 0 && (await detail.innerText()).includes(needle), message);
  const undoFromToast = async () => {
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).first().click();
  };
  state.resetView = () => ui.reset();

  // -------------------------------------------------------------------------------------------
  await section("Filled: list like git log --follow, diff of the selection", async () => {
    const sawSkeleton = await page.evaluate(
      async ([tab, file]) => {
        window.__gc.store.getState().openHistory(tab, file);
        for (let frame = 0; frame < 30; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const root = document.querySelector('[data-screen="file-history"]');
          if (root?.querySelector('[data-loading][role="status"]')) return true;
          if (root?.querySelector("[data-history-list]")) return false;
        }
        return false;
      },
      [tabId, FILES.station],
    );
    check(sawSkeleton, "while the history loads, a skeleton is shown");
    await ready(FILES.station);
    const log = followLog(FILES.station);
    equal(log.length, 4, "precondition: four commits");
    const shown = await rows();
    equal(shown.map((row) => row.sha), log.map((entry) => entry.sha), "commits and order like git log");
    equal(shown.map((row) => [row.added, row.removed]), log.map((entry) => [entry.added, entry.removed]), "+/− like git log --numstat");
    equal(shown.map((row) => row.status), ["modified", "modified", "modified", "added"], "status per entry");
    for (const [index, entry] of log.entries()) {
      const row = shown[index];
      check(row.text.includes(entry.summary) && row.text.includes(entry.author) && row.text.includes(short(entry.sha)), `row ${index + 1} shows summary, author and short SHA (${row.text})`);
      check(/\d+ (day|week|month|year)s? ago/.test(row.text), `row ${index + 1} shows the date relative`);
    }
    equal(await screen.locator("[data-history-count]").innerText(), "4 commits", "counter in the header");
    equal(await selectedIndex(), 0, "the newest commit is selected");
    await diffShows('datei.write(f"{wert:.1f}\\n")', "on the right is the diff of this file in the selected commit");
    equal(await detail.getByRole("button", { name: "Close diff" }).count(), 0, "the embedded diff has no close button of its own");
    equal(await detail.getByRole("button", { name: /^(Stage|Stage hunk|Stage lines)/ }).count(), 0, "the embedded diff is read-only");
    equal(await screen.getAttribute("data-layout"), "wide", "at 1440 the list and diff are side by side");
    await until(async () => (await ui.focused())?.role === "listbox", "the list has focus");
    await shot("file-history");

    await list.locator('[role="option"]').nth(1).click();
    equal(await selectedIndex(), 1, "click selects");
    await diffShows("def pruefen(wert):", "the diff follows the selection");
    check((await screen.locator("[data-history-actions]").innerText()).includes(short(log[1].sha)), "the bar above the diff names the commit");
  });

  // -------------------------------------------------------------------------------------------
  await section("Keyboard only: open, arrows, Enter, B, G, Esc", async () => {
    const log = followLog(FILES.station);
    await ui.runCommand("edit file", "file.edit");
    await page.getByRole("dialog", { name: "Edit file" }).waitFor();
    await page.keyboard.type("src/station.py");
    await page.keyboard.press("Enter");
    await page.locator('[data-screen="file-view"] .cm-content').waitFor();
    await page.keyboard.press("Control+Shift+H");
    await ready(FILES.station);
    await until(async () => (await ui.focused())?.role === "listbox", "Ctrl+Shift+H opens the history, focus is in the list");

    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await eventually(selectedIndex, 2, "↓ ↓ selects the third entry");
    await diffShows("INTERVALL_MINUTEN = 5", "the diff follows");
    await page.keyboard.press("End");
    await eventually(selectedIndex, 3, "End selects the last");
    await page.keyboard.press("ArrowDown");
    equal(await selectedIndex(), 3, "↓ at the end stays put");
    await page.keyboard.press("Home");
    await eventually(selectedIndex, 0, "Home selects the first");
    await page.keyboard.press("ArrowDown");
    await eventually(selectedIndex, 1, "↓ selects the second");

    await page.keyboard.press("Enter");
    await page.locator('[data-screen="file-view"] .cm-content').waitFor();
    equal(await ui.center(), { kind: "file", path: FILES.station, sha: log[1].sha, mode: "view" }, "Enter opens this version for viewing");
    equal(await editorText(page, '[data-screen="file-view"]'), `${git("show", `${log[1].sha}:${FILES.station}`)}\n`, "the version matches git show");
    await until(async () => (await ui.focused())?.inEditor, "focus is in the text of the version");
    await page.keyboard.press("Escape");
    await ready(FILES.station);
    equal(await selectedIndex(), 1, "Esc returns to the history, the selection is kept");
    await until(async () => (await ui.focused())?.role === "listbox", "focus is back in the list");

    await page.keyboard.press("b");
    await page.locator('[data-screen="blame"] .cm-content').waitFor();
    equal(await ui.center(), { kind: "blame", path: FILES.station, sha: log[1].sha }, "B opens blame at this version");
    await page.keyboard.press("Escape");
    await ready(FILES.station);
    equal(await selectedIndex(), 1, "Esc returns");

    await page.keyboard.press("ContextMenu");
    const menu = page.locator('[role="menu"]');
    if (await menu.count()) {
      const labels = await menu.locator('[role="menuitem"]').evaluateAll((items) => items.map((item) => item.querySelector("span.truncate")?.textContent ?? ""));
      equal(labels, ["View this version", "Blame at this version", "Compare with working directory", "Show in graph", "Copy SHA", "Restore this version …"], "the menu key opens all actions");
      await shot("file-history-menu");
      await page.keyboard.press("Escape");
      await eventually(() => menu.count(), 0, "Esc closes the menu");
      equal((await ui.center())?.kind, "history", "the history stays open");
      await until(async () => (await ui.focused())?.role === "listbox", `after the menu focus is back in the list (is: ${JSON.stringify(await ui.focused())})`);
    } else {
      measurements.push("menu key: cannot be triggered over CDP, not checked");
    }

    await page.keyboard.press("g");
    await eventually(async () => (await ui.center())?.kind, "graph", "G shows the commit in the graph");
    await until(async () => JSON.stringify(await page.evaluate((tab) => window.__gc.store.getState().views[tab].selection, tabId)).includes(log[1].sha), "the commit is selected in the graph");
  });

  // -------------------------------------------------------------------------------------------
  await section("Renamed file: the history follows the rename", async () => {
    await openHistory(FILES.renamed);
    const log = followLog(FILES.renamed);
    equal(log.map((entry) => entry.sha), [shas.planAfter, shas.planRenamed, shas.planChanged, shas.planCreated], "precondition: git log --follow reaches past the rename");
    const shown = await rows();
    equal(shown.map((row) => row.sha), log.map((entry) => entry.sha), "all four commits, including those under the old name");
    equal(shown.map((row) => row.path), [FILES.renamed, FILES.renamed, FILES.renamedOld, FILES.renamedOld], "each row knows the path in its commit");
    equal(shown.map((row) => row.status), ["modified", "renamed", "modified", "added"], "the rename is detected as such");
    check(shown[1].text.includes("renamed from docs/messplan.md"), `the rename row names the old name (${shown[1].text})`);
    check(shown[2].text.includes("was then called docs/messplan.md") && shown[3].text.includes("was then called docs/messplan.md"), "older rows name the name at the time");
    equal(await list.locator("[data-former-name]").evaluateAll((parts) => parts.every((part) => part.scrollWidth <= part.clientWidth)), true, "the former path is not truncated");
    check((await screen.locator("[data-history-renamed]").innerText()).includes(FILES.renamedOld), "note: follows the rename, former path");
    await shot("file-history-renamed");

    await list.locator('[role="option"]').nth(1).click();
    await diffShows("Messkonzept", "the diff of the rename shows the change");
    await list.locator('[role="option"]').nth(2).click();
    await diffShows("- Regen", "the diff of an older commit uses the old path");
    check((await detail.innerText()).includes("messplan.md"), "and names the old name");
    await action("view").click();
    await page.locator('[data-screen="file-view"] article[data-md-preview]').waitFor();
    await page.locator('[data-screen="file-view"] [aria-label="Markdown"] [data-value="source"]').click();
    await page.locator('[data-screen="file-view"] .cm-content').waitFor();
    equal(await ui.center(), { kind: "file", path: FILES.renamedOld, sha: shas.planChanged, mode: "view" }, "\"View this version\" opens the old path in its commit");
    equal(await editorText(page, '[data-screen="file-view"]'), `${git("show", `${shas.planChanged}:${FILES.renamedOld}`)}\n`, "content like git show");
    await page.keyboard.press("Escape");
    await ready(FILES.renamed);
    equal(await selectedIndex(), 2, "back in the history of the renamed file");
  });

  // -------------------------------------------------------------------------------------------
  await section("Deleted file: history up to the deletion, restore and undo", async () => {
    check(!exists(FILES.deleted), "precondition: the file no longer exists");
    await openHistory(FILES.deleted);
    const shown = await rows();
    equal(shown.map((row) => row.sha), [shas.exportDeleted, shas.exportChanged, shas.exportCreated], "the list reaches up to the deletion");
    equal(shown.map((row) => row.status), ["deleted", "modified", "added"], "status: deleted, modified, added");
    check((await screen.innerText()).includes(`Deleted in ${short(shas.exportDeleted)}`), "note with the deleting commit");
    equal(await screen.locator("[data-file-title] .line-through").count(), 1, "the name in the header is struck through");
    equal(await screen.getByRole("button", { name: /Current version/ }).isDisabled(), true, "\"Current version\" is disabled");
    await diffShows("2026-01-02;2,0", "the diff of the deleting commit shows what was removed");
    await shot("file-history-deleted");

    equal(await action("view").getAttribute("aria-label"), "View version before deletion", "on the deleting commit \"View\" means the version before");
    await action("view").click();
    await page.locator('[data-screen="file-view"] .cm-content').waitFor();
    equal(await ui.center(), { kind: "file", path: FILES.deleted, sha: shas.exportChanged, mode: "view" }, "the state before the deletion is opened");
    equal(await editorText(page, '[data-screen="file-view"]'), "datum;wert\n2026-01-01;1,5\n2026-01-02;2,0\n", "with the last content");
    await page.keyboard.press("Escape");
    await ready(FILES.deleted);

    await action("restore").click();
    await eventually(() => exists(FILES.deleted), true, "restore creates the file again");
    equal(await ui.dialogs(), [], "no confirmation – there is nothing to overwrite");
    equal(read(FILES.deleted).toString("utf8"), "datum;wert\n2026-01-01;1,5\n2026-01-02;2,0\n", "with the content before the deletion");
    equal(git("status", "--porcelain", "--", FILES.deleted), "A  daten/alt-export.csv", "git status: new and staged");
    await until(async () => (await ui.toasts()).some((line) => line.includes(short(shas.exportChanged))), "the message names the version");
    await undoFromToast();
    await eventually(() => exists(FILES.deleted), false, "undo removes the file again");
    await eventually(() => git("status", "--porcelain", "--", FILES.deleted), "", "git status: clean again");
  });

  // -------------------------------------------------------------------------------------------
  await section("Restore an old version and undo", async () => {
    const head = read(FILES.station);
    const first = gitRaw(["show", `${shas.stationFirst}:${FILES.station}`]);
    await openHistory(FILES.station);
    await list.locator('[role="option"]').nth(3).click();
    await eventually(selectedIndex, 3, "oldest commit selected");
    await action("restore").click();
    await eventually(() => read(FILES.station).equals(first), true, "the file in the working directory has the state of the first commit (byte-exact)");
    equal(await ui.dialogs(), [], "no confirmation without local changes");
    equal(git("diff", "--cached", "--name-only"), FILES.station, "the version is staged (git diff --cached)");
    check(gitRaw(["cat-file", "blob", `:${FILES.station}`]).equals(first), "the blob in the index is the old version");
    await until(async () => (await ui.toasts()).some((line) => line.includes(`to the state of ${short(shas.stationFirst)}`)), "message with the version");
    await shot("file-history-restored");
    await undoFromToast();
    await eventually(() => read(FILES.station).equals(head), true, "undo brings the file back to the previous state");
    await eventually(() => git("status", "--porcelain", "--", FILES.station), "", "git status: clean, including the index");
    await closeToasts(page);

    // With local changes: confirmation, cancel, then replace and bring back.
    const local = Buffer.concat([head, Buffer.from("# lokale Änderung, nicht committet\n", "utf8")]);
    write(FILES.station, local);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(async () => (await app.invoke("status_get", { repoId })).unstaged.some((file) => file.path === FILES.station), "the core sees the local change");
    await action("restore").click();
    const ask = page.getByRole("dialog", { name: /Replace local changes to “station.py”/ });
    await ask.waitFor();
    check((await ask.innerText()).includes(short(shas.stationFirst)), "the confirmation names the version");
    await shot("file-history-confirm-restore");
    await page.keyboard.press("Escape");
    await eventually(() => ask.count(), 0, "Esc cancels");
    check(read(FILES.station).equals(local), "after cancelling the file is unchanged");
    await action("restore").click();
    await ask.waitFor();
    await ask.getByRole("button", { name: "Restore version" }).click();
    await eventually(() => read(FILES.station).equals(first), true, "after confirming the old version is in place");
    await undoFromToast();
    await eventually(() => read(FILES.station).equals(local), true, "undo brings the local change back byte-exact");
    // Undo writes the file first and then reverts the index: in between, "MM" shows briefly.
    // As with the first undo above, only the final state counts.
    await eventually(() => gitRaw(["status", "--porcelain", "--", FILES.station]).toString("utf8"), " M src/station.py\n", "git status: only locally modified again (not staged)");
    gitRaw(["checkout", "HEAD", "--", FILES.station]);
  });

  // -------------------------------------------------------------------------------------------
  await section("Context menu: compare with the working directory", async () => {
    await openHistory(FILES.station);
    await list.locator('[role="option"]').nth(2).click({ button: "right" });
    equal(await selectedIndex(), 2, "right click selects the row");
    await ui.menuItem("Compare with working directory").click();
    await eventually(ui.center, { kind: "diff", path: FILES.station, source: { kind: "range", from: shas.stationInterval, to: null } }, "opens the comparison of this version with the working directory");
    await page.locator('[data-screen="diff"]').waitFor();
  });

  // -------------------------------------------------------------------------------------------
  await section("No history: new file, unknown path", async () => {
    await openHistory(FRESH);
    const fresh = screen.locator('[data-history-empty="new"]');
    await fresh.waitFor();
    check((await fresh.innerText()).includes("No history yet") && (await fresh.innerText()).includes("frisch.txt"), "new file: clear empty state");
    equal(await screen.locator("[data-history-count]").count(), 0, "no counter");
    await shot("file-history-empty");
    await fresh.getByRole("button", { name: "View file" }).click();
    await page.locator('[data-screen="file-view"] .cm-content').waitFor();
    equal(await ui.center(), { kind: "file", path: FRESH, sha: null, mode: "view" }, "\"View file\" opens the file");

    await openHistory("gibt/es/nicht.txt");
    await screen.locator('[data-history-empty="unknown"]').waitFor();
    check((await screen.locator('[data-history-empty="unknown"]').innerText()).includes("No commits for this file"), "unknown path: its own empty state");
  });

  // -------------------------------------------------------------------------------------------
  await section("Very many entries: virtualized, loads more", async () => {
    equal(Number(git("rev-list", "--count", "HEAD", "--", MANY)), 450, "precondition: 450 commits on the file");
    const started = Date.now();
    await openHistory(MANY);
    measurements.push(`history with 450 commits, first 200 loaded: ${Date.now() - started} ms`);
    equal(await screen.locator("[data-history-count]").innerText(), "more than 200 commits", "only 200 loaded, the counter says \"more than\"");
    check((await list.locator('[role="option"]').count()) < 60, `only the visible part is in the DOM (${await list.locator('[role="option"]').count()} rows)`);
    equal((await rows())[0].sha, manyShas[449], "the newest commit is at the top");
    await list.focus();
    for (let round = 0; round < 6 && (await screen.locator("[data-history-count]").getAttribute("data-history-count")) !== "450"; round++) {
      await page.keyboard.press("End");
      await page.waitForTimeout(400);
      await app.settle();
    }
    equal(await screen.locator("[data-history-count]").innerText(), "450 commits", "End loads more until all are there");
    await page.keyboard.press("End");
    await eventually(async () => (await selected())?.sha, manyShas[0], "the last entry is the oldest commit");
    check((await list.locator('[role="option"]').count()) < 60, "at the end, too, only the visible part is in the DOM");
    await diffShows("Lauf 001", "the diff of the oldest commit");
    const scroll = await list.evaluate(async (element) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      element.scrollTop = 0;
      await frame();
      const times = [];
      let last = performance.now();
      let blank = false;
      for (let step = 0; step < 120; step++) {
        element.scrollTop += 180;
        await frame();
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (element.querySelectorAll('[role="option"]').length === 0) blank = true;
      }
      const sorted = [...times].sort((a, b) => a - b);
      return { avg: times.reduce((sum, value) => sum + value, 0) / times.length, p95: sorted[Math.floor(sorted.length * 0.95)], blank };
    });
    measurements.push(`scrolling the list with 450 entries: avg ${scroll.avg.toFixed(1)} ms, p95 ${scroll.p95.toFixed(1)} ms per frame`);
    check(scroll.avg < 34 && scroll.p95 < 67 && !scroll.blank, "the list scrolls smoothly and never blank");
    await shot("file-history-many");
  });

  // -------------------------------------------------------------------------------------------
  await section("Very long summary, very long name", async () => {
    await openHistory(LONG);
    const row = list.locator('[role="option"]').first();
    check((await row.innerText()).includes("Auswertung der Niederschlagsmessung"), "the row shows the start of the summary");
    equal(await list.evaluate((element) => element.scrollWidth <= element.clientWidth), true, "the list does not overflow horizontally");
    equal(await screen.evaluate((root) => root.scrollWidth <= root.clientWidth), true, "the view does not overflow horizontally");
    check(await row.evaluate((element) => Array.from(element.querySelectorAll(".truncate")).some((part) => part.scrollWidth > part.clientWidth)), "summary and name are truncated instead of wrapped");
    await shot("file-history-long");
  });

  // -------------------------------------------------------------------------------------------
  await section("Minimum size and light theme", async () => {
    await openHistory(FILES.station);
    await list.locator('[role="option"]').first().click();
    await app.setSize(960, 600);
    await eventually(() => screen.getAttribute("data-layout"), "stacked", "at 960×600 the list and diff are stacked");
    equal(await screen.evaluate((root) => root.scrollWidth <= root.clientWidth), true, "nothing sticks out");
    check(await action("restore").isVisible(), "the actions stay reachable");
    await diffShows("datei.write", "the diff is below the list");
    await shot("file-history-min");
    await app.setTheme("light");
    await shot("file-history-min-light");
    await app.setSize(1440, 900);
    await eventually(() => screen.getAttribute("data-layout"), "wide", "at 1440 side by side again");
    await shot("file-history-light");
    await app.setTheme("dark");
  });

  // -------------------------------------------------------------------------------------------
  await section("Console", async () => {
    equal(app.consoleErrors, [], "console errors");
  });
} catch (error) {
  checks.failures.push(`Aborted: ${error?.stack ?? error}`);
} finally {
  await finish("file-history", checks, app, () => fx.repo.cleanup());
}
