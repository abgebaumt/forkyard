/**
 * blame – blame in the real app, against a real Git repository.
 *
 *   node scripts/e2e/screens/blame.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/blame.mjs --only parent    only sections whose title contains "parent" (comma separates several)
 *   node scripts/e2e/screens/blame.mjs --show           visible window
 *
 * Blocks, authors and single lines are compared with "git blame --porcelain" – for the working
 * directory, for a chosen state and for the parent state. The sections "keyboard only" and
 * "color by author or by age" never use the mouse (the card with the full commit opens there with
 * the I key). At the end the script fails on console errors.
 */
import { launchApp } from "../driver.mjs";
import { FILES, PEOPLE, SHOTS, closeToasts, finish, formatMeasure, makeChecks, makeDriver, makeFilesRepo, measureScroll } from "./files-lib.mjs";

const show = process.argv.includes("--show");
const checks = makeChecks("blame");
const { check, equal, eventually, until, section, measurements, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const fx = makeFilesRepo();
const { git, gitRaw, read, write, shas } = fx;
const short = (sha) => sha.slice(0, 7);
const EMPTY = "text/leer.txt";
const UNTRACKED = "notizen/frisch.txt";
const ZERO = "0".repeat(40);

write(EMPTY, "");
gitRaw(["add", "-A"]);
gitRaw(["commit", "-q", "-m", "Leere Datei für später"]);
write(UNTRACKED, "erste Zeile\nzweite Zeile\n");

/** git blame --porcelain as a list: per line SHA, author, summary, text. */
const porcelain = (rev, file) => {
  const output = gitRaw(["blame", "--porcelain", ...(rev ? [rev] : []), "--", file]).toString("utf8").split("\n");
  const commits = new Map();
  const lines = [];
  let current = null;
  for (const line of output) {
    if (line.startsWith("\t")) {
      lines.push({ sha: current, text: line.slice(1), author: commits.get(current).author, summary: commits.get(current).summary });
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header) {
      current = header[1];
      if (!commits.has(current)) commits.set(current, {});
    } else if (line.startsWith("author ")) commits.get(current).author = line.slice(7);
    else if (line.startsWith("summary ")) commits.get(current).summary = line.slice(8);
  }
  return lines;
};
/** Blocks of consecutive lines from the same commit. */
const blocksOf = (lines) => {
  const blocks = [];
  lines.forEach((line, index) => {
    const last = blocks[blocks.length - 1];
    if (last && last.sha === line.sha) last.end = index + 1;
    else blocks.push({ sha: line.sha, start: index + 1, end: index + 1, author: line.author, summary: line.summary });
  });
  return blocks;
};
const sorted = (object) => Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1));
const countBy = (lines, key) => {
  const counts = {};
  for (const line of lines) counts[key(line)] = (counts[key(line)] ?? 0) + 1;
  return counts;
};

let app = null;
try {
  app = await launchApp({ show });
  state.app = app;
  const { page } = app;
  const { tabId } = await app.openRepo(fx.repo.path);
  const ui = makeDriver(app, tabId, checks);
  const screen = page.locator('[data-screen="blame"]');
  const info = screen.locator("[data-blame-info]");
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  const ready = async (file, stand = "worktree") => {
    await page.waitForFunction(
      ([label, expected]) => {
        const root = document.querySelector('[data-screen="blame"]');
        return root?.getAttribute("aria-label") === label && root.getAttribute("data-stand") === expected && !root.querySelector("[data-loading]") && Boolean(root.querySelector(".cm-content, [data-notice]"));
      },
      [`Blame of ${file}`, stand],
      { timeout: 30_000 },
    );
    await app.settle();
  };
  const openBlame = async (file, sha = null) => {
    await ui.store("openBlame", tabId, file, sha);
    await ready(file, sha ?? "worktree");
  };
  /** Blocks as shown in the gutter (all of them for small files). */
  const shownBlocks = () =>
    screen.locator(".gc-blame-cell[data-start]").evaluateAll((cells) =>
      cells.map((cell) => ({
        sha: cell.dataset.sha,
        uncommitted: cell.hasAttribute("data-uncommitted"),
        avatar: cell.querySelector(".gc-blame-avatar")?.textContent ?? "",
        summary: cell.querySelector(".gc-blame-summary")?.textContent ?? "",
        date: cell.querySelector(".gc-blame-date")?.textContent ?? "",
      })),
    );
  const legend = () =>
    screen.locator("[data-blame-legend] [data-legend-author]").evaluateAll((items) => Object.fromEntries(items.map((item) => [item.getAttribute("data-legend-author"), Number((item.lastElementChild?.textContent ?? "").replace(/,/g, ""))])));
  /** Line and commit of the current line from the bar at the bottom. */
  const currentInfo = async () => ({
    line: Number(await info.locator("[data-blame-line]").getAttribute("data-blame-line")),
    sha: (await info.locator("[data-blame-sha]").count()) ? await info.locator("[data-blame-sha]").getAttribute("data-blame-sha") : ZERO,
  });
  /** Move the cursor to line n with the keyboard. */
  const goToLine = async (number) => {
    await page.keyboard.press("Control+Home");
    for (let step = 1; step < number; step++) await page.keyboard.press("ArrowDown");
    await eventually(async () => (await currentInfo()).line, number, `the cursor is on line ${number}`);
  };
  const selection = () => page.evaluate((tab) => JSON.stringify(window.__gc.store.getState().views[tab].selection), tabId);
  const initials = (name) => {
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  };
  /** Compares the shown blocks and single lines with git blame --porcelain. */
  const compareWithGit = async (rev, file, samples, label) => {
    const expected = porcelain(rev, file);
    const blocks = blocksOf(expected);
    const shown = await shownBlocks();
    equal(shown.map((block) => block.sha), blocks.map((block) => block.sha), `${label}: blocks like git blame`);
    for (const [index, block] of blocks.entries()) {
      const cell = shown[index];
      if (!cell) continue;
      if (block.sha === ZERO) check(cell.uncommitted && cell.summary === "Not committed yet", `${label}: block ${index + 1} shows as "Not committed yet"`);
      else check(cell.summary === block.summary && cell.avatar === initials(block.author) && / ago$/.test(cell.date), `${label}: block ${index + 1} shows summary, initials and age (${JSON.stringify(cell)})`);
    }
    for (const number of samples) {
      await goToLine(number);
      equal((await currentInfo()).sha, expected[number - 1].sha, `${label}: line ${number} belongs to ${short(expected[number - 1].sha)}`);
    }
    return expected;
  };
  state.resetView = () => ui.reset();

  // -------------------------------------------------------------------------------------------
  await section("Filled: blocks, authors, legend – like git blame --porcelain", async () => {
    const sawSkeleton = await page.evaluate(
      async ([tab, file]) => {
        window.__gc.store.getState().openBlame(tab, file, null);
        for (let frame = 0; frame < 30; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const root = document.querySelector('[data-screen="blame"]');
          if (root?.querySelector('[data-loading][role="status"]')) return true;
          if (root?.querySelector(".cm-content")) return false;
        }
        return false;
      },
      [tabId, FILES.station],
    );
    check(sawSkeleton, "while blame is computing, a skeleton is shown");
    await ready(FILES.station);
    await until(async () => (await ui.focused())?.inEditor, "the text has focus");
    const expected = await compareWithGit(null, FILES.station, [1, 3, 9, 12, 18], "working directory");
    equal(new Set(expected.map((line) => line.author)).size, 4, "precondition: four authors");
    equal(sorted(await legend()), sorted(countBy(expected, (line) => line.author)), "legend: authors with their lines");
    check((await screen.locator("[data-blame-legend]").innerText()).includes("18 lines · 4 commits"), "legend: lines and commits");
    equal(await screen.locator('[data-blame-legend] [data-state="on"]').innerText(), "Author", "legend says what the color means: default \"Color by Author\"");
    check((await screen.locator("[data-blame-legend]").innerText()).includes("Color by"), "… with the caption \"Color by\"");
    equal(await screen.getAttribute("data-blame-color"), "author", "the view colors by author");
    equal(await screen.locator(".cm-content .cm-line").evaluateAll((lines) => lines.map((line) => line.textContent).join("\n")), read(FILES.station).toString("utf8").replace(/\n$/, ""), "the text matches the file");
    check((await screen.locator(".cm-content [class*='tok-']").count()) > 0, "syntax highlighting");
    const second = await screen.locator(".gc-blame-author").first().innerText();
    equal(second, PEOPLE.lena.name, "the second line of a block shows the full author name");
    const order = await screen.evaluate((root) => {
      const blame = root.querySelector(".gc-blame-gutter").getBoundingClientRect();
      const numbers = root.querySelector(".cm-lineNumbers").getBoundingClientRect();
      const content = root.querySelector(".cm-content").getBoundingClientRect();
      return blame.left < numbers.left && numbers.left < content.left;
    });
    check(order, "from the left: blame gutter, line numbers, text");
    // Color is never the only cue: every block has initials and text, different authors different colors.
    const colors = await screen.locator(".gc-blame-cell[data-start]").evaluateAll((cells) => cells.map((cell) => [cell.querySelector(".gc-blame-avatar").textContent, getComputedStyle(cell).borderLeftColor]));
    equal(new Set(colors.map(([name]) => name)).size, new Set(colors.map(([, color]) => color)).size, "one color per author");
    equal(await screen.locator("[data-stand-picker]").innerText().then((value) => value.replace(/\s+/g, " ").trim()), "State Working directory", "the header names the state");
    await shot("blame");
  });

  // -------------------------------------------------------------------------------------------
  await section("Card on hover, click shows the commit in the graph", async () => {
    await openBlame(FILES.station);
    const expected = porcelain(null, FILES.station);
    const blocks = blocksOf(expected);
    const cell = screen.locator(".gc-blame-cell[data-start]").nth(1);
    await cell.hover();
    const card = screen.locator("[data-blame-card]");
    await card.waitFor();
    const text = await card.innerText();
    check(text.includes(blocks[1].sha) && text.includes(blocks[1].summary) && text.includes(blocks[1].author), "the card shows full SHA, summary and author");
    check(text.includes("@wetterstation.example") && /\d{4}/.test(text), "plus email and date");
    await shot("blame-card");
    await cell.click();
    await eventually(async () => (await ui.center())?.kind, "graph", "click closes blame and shows the graph");
    await until(async () => (await selection()).includes(blocks[1].sha), "the commit of the block is selected");
  });

  // -------------------------------------------------------------------------------------------
  await section("Keyboard only: open, lines, Enter, parent state, Esc", async () => {
    await ui.runCommand("edit file", "file.edit");
    await page.getByRole("dialog", { name: "Edit file" }).waitFor();
    await page.keyboard.type("src/station.py");
    await page.keyboard.press("Enter");
    await page.locator('[data-screen="file-view"] .cm-content').waitFor();
    await ui.runCommand("blame file", "file.blame");
    await ready(FILES.station);
    await until(async () => (await ui.focused())?.inEditor, "blame is open, focus is in the text");
    const expected = porcelain(null, FILES.station);

    await goToLine(3);
    equal((await currentInfo()).sha, shas.stationInterval, "line 3: the bar at the bottom names the interval commit");
    check((await info.innerText()).includes("Messintervall auf fünf Minuten"), "with summary");
    await page.keyboard.press("ArrowDown");
    await eventually(async () => (await currentInfo()).sha, expected[3].sha, "↓: the bar follows the line");

    // I: the card with the full commit – the same one the mouse gets on hover.
    const keyCard = screen.locator('[data-blame-card="keyboard"]');
    const blocks = blocksOf(expected);
    const blockAt = (line) => blocks.find((block) => block.start <= line && line <= block.end);
    await goToLine(3);
    equal(await keyCard.count(), 0, "no card is open without the key");
    await page.keyboard.press("i");
    await keyCard.waitFor();
    let cardText = await keyCard.innerText();
    check(cardText.includes(shas.stationInterval) && cardText.includes("Messintervall auf fünf Minuten") && cardText.includes(blockAt(3).author), `I shows full SHA, summary and author (${JSON.stringify(cardText)})`);
    check(cardText.includes("@wetterstation.example") && /\d{4}/.test(cardText), "plus email and date");
    check(/Enter shows the commit in the graph/.test(cardText), "the card names the keys, not the mouse");
    equal(await info.getByRole("button", { name: "Show commit of this line" }).getAttribute("aria-expanded"), "true", "the button in the bar shows that the card is open");
    const cardBox = await keyCard.boundingBox();
    const lineBox = await screen.locator(".cm-content .cm-line").nth(2).boundingBox();
    check(cardBox && lineBox && cardBox.y >= lineBox.y + lineBox.height - 8 && cardBox.x + cardBox.width <= 1440 && cardBox.y + cardBox.height <= 900, `the card is below the current line and inside the window (${JSON.stringify(cardBox)})`);
    await shot("blame-card-keyboard");
    // The card follows the cursor.
    const other = blocks.find((block) => block.sha !== shas.stationInterval && block.sha !== ZERO);
    await goToLine(other.start);
    await eventually(async () => (await keyCard.innerText()).includes(other.sha), true, "with the cursor the card switches to the commit of the new line");
    equal(Number(await keyCard.getAttribute("data-block")), blocks.indexOf(other), "… to the block of this line");
    // Esc first closes only the card.
    await page.keyboard.press("Escape");
    await eventually(() => keyCard.count(), 0, "Esc closes the card");
    equal((await ui.center())?.kind, "blame", "… and blame stays open");
    check((await ui.focused())?.inEditor, "focus stays in the text");
    // Also via the button in the bar (Tab), and I closes again.
    await ui.tabTo((now) => now.label === "Show commit of this line", "Tab reaches the \"Show commit of this line\" button");
    await page.keyboard.press("Enter");
    await keyCard.waitFor();
    check((await keyCard.innerText()).includes(other.sha), "Enter on the button opens the card of the current line");
    await ui.tabTo((now) => now.inEditor, "Shift+Tab returns to the text", { back: true });
    await page.keyboard.press("i");
    await eventually(() => keyCard.count(), 0, "I closes the card again");

    // P: what was here before?
    await goToLine(3);
    await page.keyboard.press("p");
    await ready(FILES.station, `${shas.stationInterval}^`);
    check((await screen.locator("[data-stand-picker]").innerText()).includes(`before ${short(shas.stationInterval)}`), "the header names the parent state");
    const parent = porcelain(`${shas.stationInterval}^`, FILES.station);
    await eventually(async () => (await currentInfo()).line, 3, "the cursor stays on line 3");
    equal((await currentInfo()).sha, parent[2].sha, "in the parent state line 3 belongs to the first commit");
    equal(await screen.locator(".cm-content .cm-line").nth(2).innerText(), "INTERVALL_MINUTEN = 10", "the old value was there");
    equal(await screen.getByRole("button", { name: "What was here before?" }).isDisabled(), true, "nothing before: the file was created in this commit");

    await page.keyboard.press("Escape");
    await ready(FILES.station);
    await page.keyboard.press("Escape");
    await eventually(async () => (await ui.center())?.kind, "file", "Esc goes back step by step: blame, then the file");

    await ui.runCommand("blame file", "file.blame");
    await ready(FILES.station);
    await goToLine(12);
    await page.keyboard.press("Enter");
    await eventually(async () => (await ui.center())?.kind, "graph", "Enter shows the commit of the line in the graph");
    await until(async () => (await selection()).includes(expected[11].sha), "the commit is selected");
  });

  // -------------------------------------------------------------------------------------------
  await section("Color by author or by age (keyboard only)", async () => {
    await ui.store("openBlame", tabId, FILES.station, null);
    await ready(FILES.station);
    await until(async () => (await ui.focused())?.inEditor, "the text has focus");
    const expected = porcelain(null, FILES.station);
    const blocks = blocksOf(expected);
    const cells = () =>
      screen.locator(".gc-blame-cell[data-start]").evaluateAll((list) =>
        list.map((cell) => ({
          sha: cell.dataset.sha,
          age: cell.dataset.age === undefined ? null : Number(cell.dataset.age),
          bar: getComputedStyle(cell).borderLeftColor,
          avatar: getComputedStyle(cell.querySelector(".gc-blame-avatar")).backgroundColor,
          date: cell.querySelector(".gc-blame-date")?.textContent ?? "",
        })),
      );
    const byAuthor = await cells();

    // To the toggle with the keyboard, arrow right picks "Age".
    await ui.tabTo((now) => now.text === "Author", "Shift+Tab reaches the color toggle", { back: true });
    await page.keyboard.press("ArrowRight");
    await eventually(() => screen.getAttribute("data-blame-color"), "age", "arrow right: color by age");
    equal(await screen.locator('[data-blame-legend] [data-state="on"]').innerText(), "Age", "the toggle shows the choice");
    equal((await ui.focused())?.text, "Age", "focus follows the choice");

    // Expected age step per commit: the time between the oldest and newest commit of the file split into five equal parts.
    const times = new Map();
    for (const block of blocks) if (block.sha !== ZERO && !times.has(block.sha)) times.set(block.sha, Number(gitRaw(["show", "-s", "--format=%at", block.sha]).toString("utf8").trim()));
    const newest = Math.max(...times.values());
    const oldest = Math.min(...times.values());
    const stepOf = (sha) => Math.min(4, Math.floor(((newest - times.get(sha)) / (newest - oldest)) * 5));
    const byAge = await cells();
    equal(byAge.map((cell) => cell.age), blocks.map((block) => (block.sha === ZERO ? null : stepOf(block.sha))), "age step per block as computed from the commit times");
    check(new Set(byAge.map((cell) => cell.age)).size >= 3, `the file has commits in several age steps (${JSON.stringify(byAge.map((cell) => cell.age))})`);
    // The bar has the color of the step: same step → same color, other step → other color.
    const scale = await screen.locator("[data-age-scale] [data-age-step]").evaluateAll((list) => list.map((step) => getComputedStyle(step).backgroundColor));
    equal(scale.length, 5, "the legend shows five steps");
    equal(new Set(scale).size, 5, "five different colors");
    for (const cell of byAge) if (cell.age !== null) equal(cell.bar, scale[cell.age], `block ${cell.sha.slice(0, 7)} has the color of step ${cell.age}`);
    check(byAge.some((cell, index) => cell.bar !== byAuthor[index].bar), "the bars differ from \"Author\"");
    equal(byAge.map((cell) => cell.avatar), byAuthor.map((cell) => cell.avatar), "the avatar keeps the color of the person");
    // Not just color: every block states its age as text, the legend says "new" and "old".
    check(byAge.every((cell) => cell.age === null || / ago$/.test(cell.date)), "every block states its age as text");
    const legendText = (await screen.locator("[data-blame-legend]").innerText()).replace(/\s+/g, " ");
    check(/new .*ago .*old .*ago/.test(legendText), `legend: "new … old …" with the times (${legendText})`);
    check((await screen.locator("[data-age-scale]").getAttribute("aria-label")).includes("strong is new"), "the scale is labelled for screen readers");
    equal(await screen.locator("[data-blame-legend] [data-legend-author]").count(), 0, "the author list makes room for the scale");
    // The bar at the bottom follows: line of the newest commit → strongest color.
    const newestSha = [...times.entries()].find(([, time]) => time === newest)[0];
    await ui.tabTo((now) => now.inEditor, "Tab returns to the text");
    await goToLine(blocks.find((block) => block.sha === newestSha).start);
    await eventually(() => info.locator("[data-blame-swatch]").evaluate((swatch) => getComputedStyle(swatch).backgroundColor), scale[0], "the bar at the bottom shows the color of the newest step");
    await shot("blame-age");

    // The choice persists: other file, and after reloading the UI.
    await openBlame(FILES.readme);
    equal(await screen.getAttribute("data-blame-color"), "age", "other file: still by age");
    await app.reload();
    await page.waitForFunction((tab) => Boolean(window.__gc?.store.getState().views[tab]) || document.querySelector("[data-shell]"), tabId);
    await app.settle();
    await openBlame(FILES.station);
    equal(await screen.getAttribute("data-blame-color"), "age", "after reloading: the choice is remembered");
    await app.setTheme("light");
    await shot("blame-age-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await page.waitForTimeout(300);
    equal(await screen.evaluate((root) => root.scrollWidth <= root.clientWidth), true, "960×600 with the scale: nothing sticks out");
    await shot("blame-age-min");
    await app.setSize(1440, 900);
    await page.waitForTimeout(250);

    // Back to "Author" – with the keyboard.
    await until(async () => (await ui.focused())?.inEditor, "the text has focus");
    await ui.tabTo((now) => now.text === "Age", "Shift+Tab reaches the toggle again", { back: true });
    await page.keyboard.press("ArrowLeft");
    await eventually(() => screen.getAttribute("data-blame-color"), "author", "arrow left: by author again");
    equal((await cells()).map((cell) => cell.bar), byAuthor.map((cell) => cell.bar), "the bars have the author colors again");
    check((await screen.locator("[data-blame-legend] [data-legend-author]").count()) > 0, "the author list is back");
  });

  // -------------------------------------------------------------------------------------------
  await section("Choose a state to blame", async () => {
    await openBlame(FILES.station);
    await screen.locator("[data-stand-picker]").click();
    const menu = page.locator('[role="menu"]');
    const entries = await menu.locator('[role="menuitem"]').evaluateAll((items) => items.map((item) => item.querySelector("span.truncate")?.textContent ?? ""));
    equal(entries.length, 5, "working directory and the four commits of the file");
    check(entries[0] === "Working directory" && entries[2].startsWith(short(shas.stationCheck)), `the entries show short SHA and summary (${JSON.stringify(entries)})`);
    await shot("blame-stand");
    await menu.locator('[role="menuitem"]', { hasText: short(shas.stationCheck) }).click();
    await ready(FILES.station, shas.stationCheck);
    check((await screen.locator("[data-stand-picker]").innerText()).includes(short(shas.stationCheck)), "the header names the chosen state");
    await compareWithGit(shas.stationCheck, FILES.station, [3, 11, 17], `state ${short(shas.stationCheck)}`);
    equal(await screen.locator("[data-legend-author='uncommitted']").count(), 0, "a commit has no uncommitted lines");

    // Renamed file: the parent state uses the old path.
    await openBlame(FILES.renamed);
    const renamed = await compareWithGit(null, FILES.renamed, [1, 3, 9], "renamed file");
    const line = renamed.findIndex((entry) => entry.sha === shas.planChanged) + 1;
    check(line > 0, "precondition: a line dates from before the rename");
    await goToLine(line);
    await screen.getByRole("button", { name: "What was here before?" }).click();
    await ready(FILES.renamedOld, `${shas.planChanged}^`);
    equal(await screen.locator("[data-notice]").count(), 0, "the parent state finds the file under its old name");
    await compareWithGit(`${shas.planChanged}^`, FILES.renamedOld, [1, 3], "parent state under old path");
  });

  // -------------------------------------------------------------------------------------------
  await section("Uncommitted lines", async () => {
    const head = read(FILES.station).toString("utf8");
    write(FILES.station, head.replace("INTERVALL_MINUTEN = 5", "INTERVALL_MINUTEN = 2\nNEU = True"));
    await openBlame(FILES.station);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(async () => (await shownBlocks()).some((block) => block.uncommitted), "the local change appears");
    const expected = await compareWithGit(null, FILES.station, [2, 3, 4, 5], "with local changes");
    equal(expected.filter((line) => line.sha === ZERO).length, 2, "precondition: two uncommitted lines");
    equal((await legend()).uncommitted, 2, "legend: \"Not committed yet\" with two lines");
    await goToLine(3);
    check((await info.innerText()).includes("Not committed yet"), "the bar at the bottom says so too");
    const style = await screen.locator(".gc-blame-cell[data-uncommitted]").first().evaluate((cell) => [getComputedStyle(cell).borderLeftStyle, getComputedStyle(cell).fontStyle]);
    equal(style, ["dashed", "italic"], "dashed and italic – not only by color");
    await shot("blame-uncommitted");

    // P on an uncommitted line: blame of the last commit.
    await page.keyboard.press("p");
    await ready(FILES.station, "HEAD");
    check((await screen.locator("[data-stand-picker]").innerText()).includes("HEAD"), "\"What was here before?\" leads to the last commit");
    equal(await screen.locator(".cm-content .cm-line").nth(2).innerText(), "INTERVALL_MINUTEN = 5", "the committed value is there");
    await page.keyboard.press("Escape");
    await ready(FILES.station);

    // Click on the uncommitted block: the local changes.
    await screen.locator(".gc-blame-cell[data-uncommitted][data-start]").first().click();
    await eventually(async () => (await ui.center())?.kind, "graph", "click leads to the graph");
    await until(async () => (await selection()).includes("wip"), "the local changes row is selected");
    gitRaw(["checkout", "HEAD", "--", FILES.station]);

    // Never committed: everything uncommitted.
    await openBlame(UNTRACKED);
    equal(await shownBlocks().then((blocks) => blocks.map((block) => block.uncommitted)), [true], "new file: one block, not committed yet");
    equal(await legend(), { uncommitted: 2 }, "legend: two lines, no author");
    await until(() => screen.getByRole("button", { name: "What was here before?" }).isDisabled(), "\"What was here before?\" is disabled – the file has never been committed");
  });

  // -------------------------------------------------------------------------------------------
  await section("States: missing, binary, empty, not in the commit", async () => {
    await openBlame("gibt/es/nicht.txt");
    await screen.locator('[data-notice="gone"]').waitFor();
    check((await screen.locator('[data-notice="gone"]').innerText()).includes("does not exist in the working directory"), "missing file: clear notice");
    await shot("blame-missing");

    await openBlame(FILES.binary);
    await screen.locator('[data-notice="unsupported"]').waitFor();
    check((await screen.locator('[data-notice="unsupported"]').innerText()).includes("binary file"), "binary file: no blame, with a reason");
    await shot("blame-binary");

    await openBlame(EMPTY);
    await screen.locator('[data-notice="empty"]').waitFor();
    check((await screen.locator('[data-notice="empty"]').innerText()).includes("Empty file"), "empty file: its own notice");

    await openBlame(FILES.deleted, shas.exportDeleted);
    await screen.locator('[data-notice="gone"]').waitFor();
    check((await screen.locator('[data-notice="gone"]').innerText()).includes(short(shas.exportDeleted)), "the file does not exist in the deleting commit – the notice names the state");
    await screen.locator("[data-notice]").getByRole("button", { name: "Show history" }).click();
    await page.locator('[data-screen="file-history"]').waitFor();
    equal((await ui.center())?.kind, "history", "\"Show history\" leads to the history");
  });

  // -------------------------------------------------------------------------------------------
  await section("Large file: 20,000 lines", async () => {
    const started = Date.now();
    await openBlame(FILES.big);
    measurements.push(`blame over 20,000 lines until the view is ready: ${Date.now() - started} ms`);
    const expected = porcelain(null, FILES.big);
    equal(expected.length, 20_000, "precondition: 20,000 lines");
    equal(sorted(await legend()), sorted(countBy(expected, (line) => line.author)), "legend: lines per author like git blame");
    check((await screen.locator("[data-blame-legend]").innerText()).includes("20,000 lines · 3 commits"), "legend: lines and commits");
    const result = await measureScroll(page, '[data-screen="blame"] .cm-scroller');
    measurements.push(`scrolling blame over 20,000 lines: ${formatMeasure(result)}`);
    check(result.avg < 34 && result.p95 < 67, `scrolls smoothly – ${formatMeasure(result)}`);
    check(result.maxRows < 400 && !result.blank, `CodeMirror draws only the visible part (${result.maxRows} rows), never blank`);

    // Samples across the file: click the line, compare the commit with git.
    for (const target of [1, 5001, 9999, 10_001, 15_250, 20_000]) {
      await screen.locator(".cm-scroller").evaluate((element, number) => {
        const lineHeight = element.querySelector(".cm-line").getBoundingClientRect().height;
        element.scrollTop = Math.max(0, (number - 5) * lineHeight);
      }, target);
      const line = screen.locator(".cm-content .cm-line", { hasText: `Messwert ${String(target).padStart(5, "0")}:` });
      await line.waitFor();
      await line.click();
      await eventually(async () => (await currentInfo()).line, target, `line ${target} selected`);
      equal((await currentInfo()).sha, expected[target - 1].sha, `line ${target}: commit like git blame`);
    }
    // A block whose start is far above still shows who it belongs to when scrolled into (bar at the bottom).
    check((await info.innerText()).includes(expected[19_999].summary), "the bar names the commit even in the middle of a long block");
    const repeated = await screen.locator(".gc-blame-cell[data-repeat]").evaluateAll((cells) => cells.map((cell) => cell.querySelector(".gc-blame-summary")?.textContent ?? ""));
    check(repeated.length > 0 && repeated.every((summary) => summary === expected[19_999].summary), `in the middle of the long block the gutter repeats the label (${repeated.length} times in view)`);
    equal(await screen.locator(".gc-blame-cell[data-start]").count(), 0, "the repetition does not count as a block start");
    await shot("blame-big");
  });

  // -------------------------------------------------------------------------------------------
  await section("Minimum size and light theme", async () => {
    await openBlame(FILES.station);
    await app.setSize(960, 600);
    await page.waitForTimeout(300);
    equal(await screen.evaluate((root) => root.scrollWidth <= root.clientWidth), true, "at 960×600 nothing sticks out");
    const widths = await screen.evaluate((root) => [root.querySelector(".gc-blame-gutter").getBoundingClientRect().width, root.querySelector(".cm-content").getBoundingClientRect().left, root.querySelector(".cm-scroller").getBoundingClientRect().right]);
    check(widths[2] - widths[1] > 200, `next to the blame gutter there is room for the text (${Math.round(widths[2] - widths[1])} px)`);
    check(await screen.getByRole("button", { name: "What was here before?" }).isVisible(), "the actions of the bar stay visible");
    // The legend is cut off here – on focus (keyboard) the tooltip shows the full list.
    await screen.locator("[data-blame-legend] ul").focus();
    const tip = page.getByRole("tooltip").first();
    await tip.waitFor();
    const listed = await tip.innerText();
    check(Object.values(PEOPLE).every((person) => listed.includes(person.name)), `the legend tooltip names all authors (${listed.replace(/\s+/g, " ")})`);
    await screen.locator(".cm-content").focus();
    await shot("blame-min");
    await app.setTheme("light");
    await shot("blame-min-light");
    await app.setSize(1440, 900);
    await shot("blame-light");
    await app.setTheme("dark");
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Console", async () => {
    equal(app.consoleErrors, [], "console errors");
  });
} catch (error) {
  checks.failures.push(`Aborted: ${error?.stack ?? error}`);
} finally {
  await finish("blame", checks, app, () => fx.repo.cleanup());
}
