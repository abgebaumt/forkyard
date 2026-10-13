/**
 * diff – diff view in the real app, against real Git repositories.
 *
 *   node scripts/e2e/screens/diff.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/diff.mjs --only lines     only sections whose title contains “lines” (comma separates several)
 *   node scripts/e2e/screens/diff.mjs --show           visible window
 *
 * Every write action is verified in the repository itself (git diff --cached, index blob
 * byte-exact, file in the working directory). The section “Stage lines with the keyboard only”
 * never touches the mouse. At the end the script fails on console errors.
 *
 * Not testable over CDP: Shift+F10 and the context-menu key (here the context menu is opened by a
 * dispatched contextmenu event – the WebView takes the same path for these keys).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { gitIsolationEnv, makeRichRepo } from "../fixtures.mjs";

const show = process.argv.includes("--show");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const SHOTS = "target/e2e/shots";

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

const failures = [];
const measurements = [];
let current = "";
const check = (condition, message) => {
  if (!condition) {
    failures.push(`${current}: ${message}`);
    console.log(`  ✗ ${message}`);
  }
  return Boolean(condition);
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
/** Waits until `read()` returns the expected value – the UI answers asynchronously, slowly under load. */
const eventually = async (read, expected, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let actual = await read();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    actual = await read();
  }
  return equal(actual, expected, message);
};
/** Waits until `read()` returns something truthy. */
const until = async (read, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let actual = await read();
  while (!actual && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    actual = await read();
  }
  return check(actual, message);
};

let app = null;
/** Before each section: display mode back to default, toasts closed – a failed section does not drag the next ones down. */
let resetView = null;
const section = async (title, run) => {
  if (only && !only.some((part) => title.toLowerCase().includes(part.toLowerCase()))) return;
  current = title;
  const before = failures.length;
  const started = Date.now();
  try {
    await resetView?.();
    await run();
  } catch (error) {
    check(false, `aborted: ${error?.stack ?? error}`);
    if (app) await app.screenshot(`target/e2e/diff-error-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
  }
  console.log(`${failures.length === before ? "✓" : "✗"} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};

// ---------------------------------------------------------------------------
// Git in the test repository (raw, so line endings and bytes arrive unchanged)
// ---------------------------------------------------------------------------

const repo = makeRichRepo();
const gitEnv = { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")) };
/** stdout as a Buffer – no decoding, no truncation. */
const gitRaw = (...args) => execFileSync("git", args, { cwd: repo.path, env: gitEnv, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, windowsHide: true });
const git = (...args) => gitRaw(...args).toString("utf8");
const indexBlob = (file) => gitRaw("cat-file", "blob", `:${file}`);
const cachedDiff = (file) => git("-c", "core.quotepath=false", "diff", "--cached", "--no-color", "--", file);
const worktree = (file) => fs.readFileSync(path.join(repo.path, file));
const writeBytes = (file, content) => {
  const target = path.join(repo.path, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
/** Number of hunks and the changed lines of a diff text. */
const parseDiff = (text) => {
  const lines = text.split(/\r?\n/);
  return {
    hunks: lines.filter((line) => line.startsWith("@@")).length,
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)),
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)),
  };
};

// --- Extra files for the special cases ------------------------------------------------------
const MULTI = repo.info.multiHunkFile;
const CRLF = "text/crlf.txt";
const NO_EOL = "text/ohne-ende.txt";
const MANY = "text/viele.js";
const WHITESPACE = "text/leerraum.py";
const LATIN1 = "text/latin1.txt";
const SCRIPT = "text/skript.sh";
const LONG_LINE = "text/lange-zeile.md";
const TOO_LARGE = "gross.txt";
const EMPTY = "leer.txt";
const LFS = "daten/archiv-2025.zip";
/** Only opened in the “States” section and sits at the end of the list – its diff is not cached beforehand (commit-panel loads diffs while paging through the list). */
const SLOW = "zz-ende/langsam geladen.md";
/** 900 lines with scattered changes – for the minimap. */
const SCATTERED = "text/verstreut.md";

const manyOld = Array.from({ length: 6000 }, (_, index) => `export const wert${index} = berechne(${index}, "alt"); // Messpunkt ${index}`);
const manyNew = manyOld.map((line, index) => (index < 5000 ? line.replace('"alt"', '"neu"').replace("Messpunkt", "Punkt") : line));
const scatteredOld = Array.from({ length: 900 }, (_, index) => `Messpunkt ${String(index + 1).padStart(3, "0")}: Temperatur ${(index * 7) % 31} °C, Luftfeuchte ${40 + ((index * 3) % 50)} %`);
/** Changed (replaced), deleted and inserted – each far apart. */
const scatteredNew = scatteredOld
  .map((line, index) => ([40, 41, 300, 620, 621, 622, 880].includes(index) ? line.replace("Temperatur", "Temp.") : line))
  .filter((_, index) => !(index >= 150 && index < 158) && index !== 700)
  .flatMap((line, index) => (index === 420 ? [line, "Nachtrag: Sensor getauscht", "Nachtrag: neu kalibriert", "Nachtrag: Werte geprüft"] : [line]));
const longOld = `# Lange Zeile\n\n${"Die Station misst Temperatur, Luftfeuchte, Regen und Wind im Abstand von zehn Minuten. ".repeat(4)}\n`;

writeBytes(CRLF, "eins\r\nzwei\r\ndrei\r\nvier\r\nfünf\r\nsechs\r\n");
writeBytes(NO_EOL, "eins\nzwei\ndrei");
writeBytes(MANY, `${manyOld.join("\n")}\n`);
writeBytes(WHITESPACE, "def mittel(werte):\n    return sum(werte) / len(werte)\n");
writeBytes(LATIN1, Buffer.from("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\n", "latin1"));
writeBytes(SCRIPT, "#!/bin/sh\necho Auswertung\n");
writeBytes(LONG_LINE, longOld);
writeBytes(SCATTERED, `${scatteredOld.join("\n")}\n`);
const extra = [CRLF, NO_EOL, MANY, WHITESPACE, LATIN1, SCRIPT, LONG_LINE, SCATTERED];
git("add", "--", ...extra);
// Commit only these paths; whatever the fixture staged stays staged.
repo.git("commit", "-q", "-m", "Testdateien für die Diff-Ansicht", "--", ...extra);

writeBytes(CRLF, "eins\r\nZWEI\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n");
writeBytes(NO_EOL, "eins\nzwei\ndrei\nvier\nfünf");
writeBytes(MANY, `${manyNew.join("\n")}\n`);
writeBytes(WHITESPACE, "def mittel(werte):\n        return sum(werte) / len(werte)\n");
writeBytes(LATIN1, Buffer.from("Gr\xf6\xdfe;Einheit\nTemperatur;\xb0C\nLuftfeuchte;%\n", "latin1"));
writeBytes(LONG_LINE, longOld.replace("im Abstand von zehn Minuten", "alle zehn Minuten"));
writeBytes(SCATTERED, `${scatteredNew.join("\n")}\n`);
git("update-index", "--chmod=+x", "--", SCRIPT);
writeBytes(TOO_LARGE, `${Array.from({ length: 30_000 }, (_, index) => `Messwert ${index}`).join("\n")}\n`);
writeBytes(EMPTY, "");
writeBytes(SLOW, "# Langsam\n\nDieser Diff kommt mit Verzögerung.\n");
writeBytes(LFS, `version https://git-lfs.github.com/spec/v1\noid sha256:${"4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"}\nsize 48211456\n`);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  app = await launchApp({ show });
  const { page } = app;
  const { tabId, repoId } = await app.openRepo(repo.path);

  const screen = page.locator('[data-screen="diff"]');
  const grid = screen.locator("[data-diff-grid]");
  const attr = (name) => screen.getAttribute(name).catch(() => null);
  const token = () => attr("data-diff-token");
  const toasts = () => page.locator("[data-toast]").allInnerTexts();
  const closeToasts = async () => {
    for (let round = 0; round < 10 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click();
      await page.waitForTimeout(120);
    }
  };
  const setSettings = async (patch) => {
    await app.invoke("settings_set", { patch });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await app.settle();
  };
  const settings = () => app.invoke("settings_get");
  resetView = async () => {
    await setSettings({ diffMode: "hunks", diffWordWrap: false, diffIgnoreWhitespace: false });
    await closeToasts();
  };
  /** Waits until the diff of `file` is fully loaded. */
  const ready = async (file) => {
    await page.waitForFunction(
      (label) => {
        const root = document.querySelector('[data-screen="diff"]');
        return root?.getAttribute("aria-label") === label && !root.querySelector("[data-diff-loading]");
      },
      `Diff of ${file}`,
      { timeout: 30_000 },
    );
    await app.settle();
  };
  /** Opens a diff through the store (for sources without a file list on screen). */
  const openDiff = async (file, source = { kind: "unstaged" }) => {
    await page.evaluate(([tab, target, from]) => window.__gc.store.getState().openDiff(tab, target, from), [tabId, file, source]);
    await ready(file);
  };
  /** Opens a diff by clicking into the commit-panel file list. */
  const clickFile = async (area, file) => {
    const row = page.locator(`[data-section="${area}"] [data-row-key=${JSON.stringify(file)}]`);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await ready(file);
  };
  /** The rendered rows of the grid. */
  const rows = () =>
    grid.locator('[data-row][role="row"]').evaluateAll((list) =>
      list.map((row) => ({
        index: Number(row.dataset.row),
        kind: row.dataset.kind ?? (row.dataset.hunk !== undefined ? "hunk" : "other"),
        selected: row.getAttribute("aria-selected") === "true",
        text: row.querySelector(".selectable")?.textContent?.replace(/​/g, "") ?? row.textContent,
      })),
    );
  const lineRows = async () => (await rows()).filter((row) => ["context", "add", "remove"].includes(row.kind));
  const selectedTexts = async () => (await rows()).filter((row) => row.selected).map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`);
  const hunkHeads = () => grid.locator("[data-hunk]").evaluateAll((list) => list.map((head) => head.innerText.replace(/\s+/g, " ").trim()));
  const focusedRow = () =>
    page.evaluate(() => {
      const row = document.activeElement?.closest("[data-row]");
      if (!row) return null;
      return { kind: row.dataset.kind ?? null, text: row.querySelector(".selectable")?.textContent?.replace(/​/g, "") ?? null };
    });
  const title = () => screen.locator("[data-diff-title]").innerText();
  const counts = () => screen.locator("[data-diff-counts]").innerText().then((text) => text.replace(/\s+/g, " ").trim());
  const changePosition = () => screen.locator("[data-change-position]").innerText();
  const notice = () => screen.locator("[data-notice]").getAttribute("data-notice").catch(() => null);
  const centerKind = () => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.center.kind, tabId);
  const press = async (keys) => {
    await page.keyboard.press(keys);
    await page.waitForTimeout(60);
  };
  const noOverflow = async (message) => {
    const result = await page.evaluate(() => {
      const root = document.querySelector('[data-screen="diff"]');
      const header = root.querySelector("[data-diff-header]");
      const rect = root.getBoundingClientRect();
      const clipped = [...header.querySelectorAll("button, [data-diff-title], [role=group]")].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > rect.right + 0.5 || box.left < rect.left - 0.5);
      }).length;
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, header: header.scrollWidth - header.clientWidth, clipped };
    });
    equal(result, { page: 0, header: 0, clipped: 0 }, message);
  };

  // -------------------------------------------------------------------------------------------
  await section("Open from the file list, header, three hunks", async () => {
    await clickFile("unstaged", MULTI);
    equal(await centerKind(), "diff", "center shows the diff");
    equal(await attr("data-diff-mode"), "hunks", "default display mode");
    check((await title()).includes("messwerte-2026-01.csv") && (await title()).includes("daten/"), `header names file and folder (was: ${await title()})`);
    equal(await counts(), "+3 −2", "line counts in the header");
    const heads = await hunkHeads();
    equal(heads.length, 3, "number of hunks");
    check(/^Hunk 1 of 3 Lines 1–7 .*\+1 −1 Stage hunk$/.test(heads[0] ?? ""), `hunk header readable: number, line range, section, counts (was: ${heads[0]})`);
    equal(await screen.getByRole("button", { name: "Stage hunk" }).count(), 3, "“Stage hunk” per hunk");
    equal(await screen.getByRole("button", { name: "Discard hunk" }).count(), 3, "“Discard hunk” per hunk");
    // Signs are shown as text, not only as colour; screen readers get a word.
    const signs = await grid.locator('[data-kind="add"], [data-kind="remove"]').evaluateAll((list) => list.map((row) => row.querySelector("[data-gutter]").textContent.replace(/\d/g, "")));
    equal([...new Set(signs)].sort(), ["+added", "−removed"], "sign and word for screen readers");
    // Word diff: in the changed pair only the number is marked.
    const marks = await grid.locator("mark").evaluateAll((list) => list.map((mark) => mark.textContent));
    check(marks.includes("41") && marks.includes("21"), `word diff marks the changed number (was: ${JSON.stringify(marks)})`);
    equal(await page.evaluate(() => getComputedStyle(document.querySelector("[data-diff-grid]")).fontSize), "13px", "font size from the settings");
    await noOverflow("no overflow at 1440×900");
    await app.screenshot(`${SHOTS}/diff.png`);
    await app.setTheme("light");
    await page.waitForTimeout(150);
    await app.screenshot(`${SHOTS}/diff-light.png`);
    await app.setTheme("dark");
  });

  // -------------------------------------------------------------------------------------------
  await section("Syntax highlighting and context menu", async () => {
    await clickFile("unstaged", "src/sensoren.py");
    await until(() => grid.locator(".gc-tok-keyword").count().then((count) => count > 0), "keywords are coloured (Python)");
    const colors = await page.evaluate(() => {
      const pick = (selector) => {
        const element = document.querySelector(`[data-diff-grid] ${selector}`);
        return element ? getComputedStyle(element).color : null;
      };
      return { keyword: pick(".gc-tok-keyword"), string: pick(".gc-tok-string"), plain: getComputedStyle(document.querySelector("[data-diff-grid] .selectable")).color };
    });
    check(colors.keyword && colors.keyword !== colors.plain && colors.string !== colors.keyword, `roles have their own colours (was: ${JSON.stringify(colors)})`);
    // Context menu on an added line
    await grid.locator('[data-kind="add"]').first().locator(".selectable").click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const entries = await menu.getByRole("menuitem").allInnerTexts();
    check(entries.some((entry) => entry.startsWith("Stage hunk 1")) && entries.some((entry) => entry.startsWith("Discard hunk 1")) && entries.some((entry) => entry.startsWith("Copy line")), `context menu offers hunk actions (was: ${JSON.stringify(entries)})`);
    await app.screenshot(`${SHOTS}/diff-menu.png`);
    await press("Escape");
    await menu.waitFor({ state: "detached" });
    equal(await centerKind(), "diff", "Esc in the menu closes only the menu");
  });

  // -------------------------------------------------------------------------------------------
  await section("Stage hunk: exactly this hunk is in the index", async () => {
    await clickFile("unstaged", MULTI);
    const before = await token();
    equal(cachedDiff(MULTI), "", "nothing staged before");
    await grid.locator('[data-hunk="1"]').getByRole("button", { name: "Stage hunk" }).click();
    await page.waitForFunction((old) => document.querySelector('[data-screen="diff"]')?.getAttribute("data-diff-token") !== old, before);
    await app.settle();
    const staged = parseDiff(cachedDiff(MULTI));
    equal(staged.hunks, 1, "git diff --cached: number of hunks");
    equal(staged.added, ["2026-01-16;-999;-999;0,0;0"], "git diff --cached: added line");
    equal(staged.removed.length, 1, "git diff --cached: one removed line");
    check(staged.removed[0]?.startsWith("2026-01-16;"), `the removed line is the one from the 16th (was: ${staged.removed[0]})`);
    // The view stays and shows the rest.
    equal(await centerKind(), "diff", "view stays open");
    check((await title()).includes("messwerte-2026-01.csv"), "same file");
    const heads = await hunkHeads();
    equal(heads.length, 2, "two hunks left");
    check(heads[0]?.startsWith("Hunk 1 of 2"), `renumbered (was: ${heads[0]})`);
    equal(await toasts(), [], "no toast needed");
  });

  // -------------------------------------------------------------------------------------------
  await section("Stage lines with the keyboard only (CRLF, index byte-exact)", async () => {
    // From here to the end of the section: no mouse.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    // Tab into the “Unstaged” list.
    let inList = false;
    for (let step = 0; step < 200 && !inList; step++) {
      await page.keyboard.press("Tab");
      inList = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-section="unstaged"] [role="option"], [data-section="unstaged"] [role="treeitem"]')));
    }
    check(inList, "Tab reaches the “Unstaged” list");
    // Arrow keys to the file, Enter opens the diff.
    await press("Home");
    let onFile = false;
    for (let step = 0; step < 60 && !onFile; step++) {
      onFile = await page.evaluate((file) => document.activeElement?.getAttribute("data-row-key") === file, CRLF);
      if (!onFile) await press("ArrowDown");
    }
    check(onFile, "arrow keys reach text/crlf.txt");
    await press("Enter");
    await ready(CRLF);
    equal(await hunkHeads().then((heads) => heads.length), 1, "one hunk with two change blocks");
    equal(await changePosition(), "1/2", "two changes");
    check(await page.evaluate(() => !document.activeElement?.closest("[data-diff-grid]")), "the diff does not steal focus when opening");

    // F7 focuses the first change, pressed again the second.
    await press("F7");
    equal(await focusedRow(), { kind: "remove", text: "zwei" }, "F7: focus on the first change");
    equal(await changePosition(), "1/2", "Position 1/2");
    await press("F7");
    equal(await focusedRow(), { kind: "remove", text: "fünf" }, "F7: focus on the second change");
    equal(await changePosition(), "2/2", "Position 2/2");
    await press("Shift+F7");
    equal(await focusedRow(), { kind: "remove", text: "zwei" }, "Shift+F7: back to the first");
    await press("Alt+ArrowDown");
    equal(await focusedRow(), { kind: "remove", text: "fünf" }, "Alt+↓: the second again");

    // Space selects the line, Shift+↓ extends to the next one.
    await press("Space");
    equal(await selectedTexts(), ["-fünf"], "Space selects the line");
    await press("Shift+ArrowDown");
    equal(await selectedTexts(), ["-fünf", "+FÜNF"], "Shift+↓ extends the selection");
    const bar = page.locator("[data-selection-bar]");
    equal(await bar.getByRole("button", { name: "Stage 2 lines" }).count(), 1, "bar offers “Stage 2 lines”");
    equal(await bar.getByRole("button", { name: "Discard 2 lines" }).count(), 1, "bar offers “Discard 2 lines”");
    // Arrow without Shift only moves the cursor, the selection stays.
    await press("ArrowUp");
    equal(await selectedTexts(), ["-fünf", "+FÜNF"], "arrow alone keeps the selection");
    await app.screenshot(`${SHOTS}/diff-selection.png`);

    const before = await token();
    await press("Enter");
    await page.waitForFunction((old) => document.querySelector('[data-screen="diff"]')?.getAttribute("data-diff-token") !== old, before);
    await app.settle();
    equal(indexBlob(CRLF).toString("hex"), Buffer.from("eins\r\nzwei\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n", "utf8").toString("hex"), "index: only “FÜNF” taken over, CRLF kept");
    equal(worktree(CRLF).toString("hex"), Buffer.from("eins\r\nZWEI\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n", "utf8").toString("hex"), "working directory unchanged");
    equal(await selectedTexts(), [], "selection is empty after staging");
    const rest = (await lineRows()).filter((row) => row.kind !== "context").map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`);
    equal(rest, ["-zwei", "+ZWEI"], "the view shows the rest");
    await until(() => page.evaluate(() => Boolean(document.activeElement?.closest("[data-diff-grid]"))), "focus stays in the diff");

    // Esc closes and returns focus to the file list.
    await press("Escape");
    await eventually(centerKind, "graph", "Esc closes the diff");
    await until(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="right"] [role="option"], [data-area="right"] [role="treeitem"], [data-area="right"] [role="listbox"]'))), "focus back in the file list");
  });

  // -------------------------------------------------------------------------------------------
  await section("File without trailing newline: stage lines, index byte-exact", async () => {
    await clickFile("unstaged", NO_EOL);
    const lines = await lineRows();
    equal(lines.map((row) => `${row.kind[0]}:${row.text}`), ["c:eins", "c:zwei", "r:drei", "a:drei", "a:vier", "a:fünf"], "lines of the hunk");
    equal(await grid.getByText("No newline at end of file").count(), 2, "notice on both versions");
    await app.screenshot(`${SHOTS}/diff-no-newline.png`);
    // Click into the line-number column selects, Shift+click extends.
    await grid.locator('[data-kind="remove"] [data-gutter]').click();
    await grid.locator('[data-kind="add"] [data-gutter]').nth(1).click({ modifiers: ["Shift"] });
    equal(await selectedTexts(), ["-drei", "+drei", "+vier"], "click and Shift+click select the range");
    const before = await token();
    await page.locator("[data-selection-bar]").getByRole("button", { name: "Stage 3 lines" }).click();
    await page.waitForFunction((old) => document.querySelector('[data-screen="diff"]')?.getAttribute("data-diff-token") !== old, before);
    await app.settle();
    equal(indexBlob(NO_EOL).toString("hex"), Buffer.from("eins\nzwei\ndrei\nvier\n", "utf8").toString("hex"), "index: drei and vier with line ending, fünf still missing");
    // The rest: whole hunk – afterwards the index equals the working directory, without line ending.
    const second = await token();
    await grid.getByRole("button", { name: "Stage hunk" }).click();
    await page.waitForFunction(([old, file]) => {
      const root = document.querySelector('[data-screen="diff"]');
      return !root || root.getAttribute("aria-label") !== `Diff of ${file}` || root.getAttribute("data-diff-token") !== old;
    }, [second, NO_EOL]);
    await app.settle();
    equal(indexBlob(NO_EOL).toString("hex"), worktree(NO_EOL).toString("hex"), "index equals working directory (no final line ending)");
    equal(worktree(NO_EOL).toString("utf8"), "eins\nzwei\ndrei\nvier\nfünf", "working directory unchanged");
    // Nothing left: the view moves on to the next file in the list.
    equal(await centerKind(), "diff", "view stays open");
    await until(async () => !(await attr("aria-label"))?.includes(NO_EOL), "moves on to the next file because nothing is left");
    const status = await app.invoke("status_get", { repoId });
    check(!status.unstaged.some((file) => file.path === NO_EOL), "file is no longer under “Unstaged”");
  });

  // -------------------------------------------------------------------------------------------
  await section("Drag in the line-number column, clear selection", async () => {
    await clickFile("unstaged", CRLF);
    const gutters = grid.locator('[data-kind="remove"] [data-gutter], [data-kind="add"] [data-gutter]');
    const first = await gutters.nth(0).boundingBox();
    const second = await gutters.nth(1).boundingBox();
    await page.mouse.move(first.x + 10, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(second.x + 10, second.y + second.height / 2, { steps: 4 });
    await page.mouse.up();
    equal(await selectedTexts(), ["-zwei", "+ZWEI"], "dragging selects both lines");
    // The accent bar on the left is its own element (not only the row colour).
    equal(await grid.locator('[aria-selected="true"] [data-gutter] > span[aria-hidden]:first-child').count(), 2, "accent bar on selected rows");
    await press("Escape");
    equal(await selectedTexts(), [], "Esc clears the selection");
    equal(await centerKind(), "diff", "the diff stays open");
    await press("Control+a");
    equal(await selectedTexts(), ["-zwei", "+ZWEI"], "Ctrl+A selects all changed lines");
    await page.locator("[data-selection-bar]").getByRole("button", { name: "Clear selection" }).click();
    equal(await selectedTexts(), [], "button clears the selection");

    // Discard selected lines: only the added line “ZWEI” – afterwards line 2 is gone entirely.
    await grid.locator('[data-kind="add"] [data-gutter]').click();
    equal(await selectedTexts(), ["+ZWEI"], "only the added line selected");
    await page.locator("[data-selection-bar]").getByRole("button", { name: "Discard 1 line" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await dialog.getByRole("button", { name: "Discard 1 line" }).click();
    await until(() => worktree(CRLF).toString("hex") === Buffer.from("eins\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n", "utf8").toString("hex"), "working directory: “ZWEI” is gone, CRLF kept");
    equal(indexBlob(CRLF).toString("hex"), Buffer.from("eins\r\nzwei\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n", "utf8").toString("hex"), "index untouched");
    await until(() => toasts().then((messages) => messages.some((message) => message.includes("1 line discarded"))), "toast “1 line discarded”");
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).click();
    await until(() => worktree(CRLF).toString("hex") === Buffer.from("eins\r\nZWEI\r\ndrei\r\nvier\r\nFÜNF\r\nsechs\r\n", "utf8").toString("hex"), "Undo brings “ZWEI” back");
  });

  // -------------------------------------------------------------------------------------------
  await section("Discard hunk with confirmation, then undo", async () => {
    await clickFile("unstaged", MULTI);
    const original = worktree(MULTI).toString("utf8");
    const indexBefore = git("ls-files", "--stage");
    const statusBefore = git("status", "--porcelain");
    check(original.includes(";41\n"), "initial state: the change “;41” is in the file");
    await grid.locator('[data-hunk="0"]').getByRole("button", { name: "Discard hunk" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await dialog.waitFor();
    check((await dialog.innerText()).includes("Discard hunk in “daten/messwerte-2026-01.csv”?"), "confirmation names the file");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on “Cancel”");
    await app.screenshot(`${SHOTS}/diff-confirm.png`);
    // Cancel changes nothing.
    await press("Enter");
    await dialog.waitFor({ state: "detached" });
    equal(worktree(MULTI).toString("utf8"), original, "Cancel leaves the file unchanged");

    const before = await token();
    await grid.locator('[data-hunk="0"]').getByRole("button", { name: "Discard hunk" }).click();
    await dialog.getByRole("button", { name: "Discard hunk" }).click();
    await page.waitForFunction((old) => document.querySelector('[data-screen="diff"]')?.getAttribute("data-diff-token") !== old, before);
    await app.settle();
    const discarded = worktree(MULTI).toString("utf8");
    check(!discarded.includes(";41\n") && discarded.includes("2026-01-28;3,9;74;0,0;12"), "working directory: only this hunk is gone");
    equal(await hunkHeads().then((heads) => heads.length), 1, "one hunk left (the second is staged)");
    await until(() => toasts().then((messages) => messages.some((message) => message.includes("Hunk discarded"))), "toast “Hunk discarded” with Undo");
    // Undo via the toast
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).click();
    await until(() => worktree(MULTI).toString("utf8") === original, "Undo restores the file");
    await until(() => hunkHeads().then((heads) => heads.length === 2), "the diff shows the hunk again");
    equal(git("ls-files", "--stage"), indexBefore, "discard and undo leave the index as it was");
    equal(git("status", "--porcelain"), statusBefore, "git status is back to before");
    await closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Staged: unstage lines and hunk", async () => {
    await clickFile("staged", MULTI);
    equal(await screen.getByRole("button", { name: "Unstage hunk" }).count(), 1, "“Unstage hunk” instead of staging");
    equal(await screen.getByRole("button", { name: /(Stage|Discard) hunk/ }).count(), 0, "no stage or discard in the staged diff");
    await app.screenshot(`${SHOTS}/diff-staged.png`);
    // Unstage only the added line.
    await grid.locator('[data-kind="add"] [data-gutter]').click();
    equal(await selectedTexts(), ["+2026-01-16;-999;-999;0,0;0"], "line selected");
    const before = await token();
    await page.locator("[data-selection-bar]").getByRole("button", { name: "Unstage 1 line" }).click();
    await page.waitForFunction((old) => document.querySelector('[data-screen="diff"]')?.getAttribute("data-diff-token") !== old, before);
    await app.settle();
    let staged = parseDiff(cachedDiff(MULTI));
    equal(staged.added, [], "git diff --cached: the added line is unstaged");
    equal(staged.removed.length, 1, "git diff --cached: the removed line stays staged");
    // Unstage the rest as a whole hunk: afterwards nothing is staged for the file.
    const second = await token();
    await grid.getByRole("button", { name: "Unstage hunk" }).click();
    await page.waitForFunction(([old, file]) => {
      const root = document.querySelector('[data-screen="diff"]');
      return !root || root.getAttribute("aria-label") !== `Diff of ${file}` || root.getAttribute("data-diff-token") !== old;
    }, [second, MULTI]);
    await app.settle();
    equal(cachedDiff(MULTI), "", "git diff --cached is empty");
    const status = await app.invoke("status_get", { repoId });
    check(!status.staged.some((file) => file.path === MULTI), "file is no longer under “Staged”");
    check(status.unstaged.some((file) => file.path === MULTI), "it is fully back under “Unstaged”");
  });

  // -------------------------------------------------------------------------------------------
  await section("Stale state: reload and say why", async () => {
    await clickFile("unstaged", MULTI);
    const real = await token();
    // Set the loaded diff to an old fingerprint – as if the file had changed since.
    await page.evaluate(() => {
      const client = window.__gc.queryClient;
      for (const query of client.getQueryCache().findAll({ predicate: (candidate) => candidate.queryKey[2] === "diff" && candidate.state.data?.kind === "text" })) {
        client.setQueryData(query.queryKey, { ...query.state.data, token: "veraltet" });
      }
    });
    await eventually(token, "veraltet", "stale fingerprint is set");
    const index = gitRaw("ls-files", "--stage").toString("hex");
    await grid.locator('[data-hunk="0"]').getByRole("button", { name: "Stage hunk" }).click();
    await until(() => toasts().then((messages) => messages.some((message) => message.includes("The file has changed in the meantime"))), "a sentence explains that the file has changed");
    await eventually(token, real, "the diff is reloaded");
    equal(gitRaw("ls-files", "--stage").toString("hex"), index, "nothing changed in the index");
    await closeToasts();
  });

  // -------------------------------------------------------------------------------------------
  await section("Three display modes: Hunks, Whole file, Side by side", async () => {
    await clickFile("unstaged", "src/sensoren.py");
    const modes = screen.getByRole("radiogroup", { name: "Display" });
    // Whole file
    await modes.getByRole("radio", { name: "Whole file" }).or(modes.getByRole("button", { name: "Whole file" })).click();
    await eventually(() => attr("data-diff-mode"), "inline", "display mode “Whole file”");
    equal((await settings()).diffMode, "inline", "setting remembered");
    const whole = await lineRows();
    check(whole.length >= 23 && whole[0].text.startsWith('"""Beschreibung der Sensoren'), `the whole file is shown (${whole.length} lines)`);
    equal(await grid.locator("[data-hunk]").count(), 0, "no hunk headers");
    const fold = grid.locator('[data-fold="0"]');
    check((await fold.innerText()).includes("16 lines unchanged"), "header of the unchanged region names the line count");
    equal(await fold.getAttribute("aria-expanded"), "true", "unchanged region is expanded");
    await app.screenshot(`${SHOTS}/diff-inline.png`);
    await fold.click();
    await eventually(() => fold.getAttribute("aria-expanded"), "false", "region collapsed");
    check((await lineRows()).length < whole.length, "collapsed lines are gone");
    // expand again with the keyboard
    await fold.focus();
    await press("Enter");
    await eventually(() => fold.getAttribute("aria-expanded"), "true", "Enter expands again");
    await screen.getByRole("button", { name: "Collapse unchanged regions" }).click();
    await eventually(() => grid.locator("[data-fold]").evaluateAll((list) => list.length > 0 && list.every((button) => button.getAttribute("aria-expanded") === "false")), true, "all regions collapsed");
    await app.screenshot(`${SHOTS}/diff-inline-folded.png`);
    // Line staging works here too: the bar appears.
    await grid.locator('[data-kind="add"] [data-gutter]').first().click();
    equal(await page.locator("[data-selection-bar]").getByRole("button", { name: "Stage 1 line" }).count(), 1, "line selection in “Whole file” too");
    await press("Escape");

    // Side by side
    await clickFile("unstaged", "src/auswertung.py");
    await modes.getByRole("radio", { name: "Side by side" }).or(modes.getByRole("button", { name: "Side by side" })).click();
    await eventually(() => attr("data-diff-mode"), "split", "display mode “Side by side”");
    await screen.locator(".cm-mergeView").waitFor();
    equal(await screen.locator(".cm-mergeView .cm-editor").count(), 2, "two columns");
    const sides = await screen.locator(".cm-mergeView .cm-editor").evaluateAll((list) => list.map((editor) => editor.querySelector(".cm-changedLine")?.textContent ?? ""));
    check(sides[0].includes("Messtage gelesen") && sides[1].includes("Messtage aus {pfad} gelesen"), `old on the left, new on the right (was: ${JSON.stringify(sides)})`);
    await until(() => screen.locator(".cm-mergeView .gc-tok-keyword").count().then((count) => count > 0), "syntax colours side by side too");
    const colors = await page.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      const root = getComputedStyle(document.documentElement);
      return {
        removed: css(".cm-merge-a .cm-changedLine", "backgroundColor"),
        added: css(".cm-merge-b .cm-changedLine", "backgroundColor"),
        editor: css(".cm-mergeView .cm-editor", "backgroundColor"),
        font: css(".cm-mergeView .cm-scroller", "fontFamily").includes("JetBrains Mono"),
        tokens: { removed: root.getPropertyValue("--gc-diff-removed").trim(), added: root.getPropertyValue("--gc-diff-added").trim(), sunken: root.getPropertyValue("--gc-surface-sunken").trim() },
      };
    });
    const hex = (rgb) => `#${rgb.match(/\d+/g).slice(0, 3).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
    equal({ removed: hex(colors.removed), added: hex(colors.added), sunken: hex(colors.editor), font: colors.font }, { ...colors.tokens, font: true }, "CodeMirror takes colours and font from the tokens");
    // Both columns live in one scroll area and have the same height: they scroll in sync.
    const heights = await screen.locator(".cm-mergeView .cm-editor").evaluateAll((list) => list.map((editor) => Math.round(editor.getBoundingClientRect().height)));
    equal(heights[0], heights[1], "both columns equally tall");
    equal(await screen.getByRole("button", { name: /Hunk (stagen|verwerfen)/ }).count(), 0, "no hunk actions side by side");
    await app.screenshot(`${SHOTS}/diff-split.png`);
    // Theme switches without rebuilding: same editor, new colours.
    await page.evaluate(() => (document.querySelector(".cm-mergeView .cm-editor").dataset.probe = "1"));
    await app.setTheme("light");
    const light = await page.evaluate(() => ({
      same: document.querySelector(".cm-mergeView .cm-editor").dataset.probe === "1",
      editor: getComputedStyle(document.querySelector(".cm-mergeView .cm-editor")).backgroundColor,
      token: getComputedStyle(document.documentElement).getPropertyValue("--gc-surface-sunken").trim(),
    }));
    equal({ same: light.same, editor: hex(light.editor) }, { same: true, editor: light.token }, "light: same editor, colours from the light theme");
    await app.screenshot(`${SHOTS}/diff-split-light.png`);
    await app.setTheme("dark");
    // F7 jumps to the change here too.
    await press("F7");
    await until(() => page.evaluate(() => Boolean(document.activeElement?.closest(".cm-merge-b"))), "F7 focuses the new version");

    // New file side by side: only one side
    await clickFile("unstaged", "notizen/offene-fragen.md");
    await screen.locator('[data-split="single"] .cm-editor').waitFor();
    check((await screen.locator('[data-split="single"]').innerText()).includes("New file"), "new file: one column with a heading");
    await app.screenshot(`${SHOTS}/diff-split-new.png`);

    await modes.getByRole("radio", { name: "Hunks" }).or(modes.getByRole("button", { name: "Hunks" })).click();
    await eventually(() => attr("data-diff-mode"), "hunks", "back to “Hunks”");
    equal((await settings()).diffMode, "hunks", "setting remembered");
  });

  // -------------------------------------------------------------------------------------------
  await section("Line wrapping and whitespace", async () => {
    await clickFile("unstaged", LONG_LINE);
    const widths = () => grid.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    let size = await widths();
    check(size.scroll > size.client, `without wrapping the long line scrolls sideways (${size.scroll} > ${size.client})`);
    await screen.getByRole("button", { name: "Wrap long lines" }).click();
    await until(async () => (await widths()).scroll <= (await widths()).client, "with wrapping no sideways scrolling");
    equal((await settings()).diffWordWrap, true, "setting remembered");
    equal(await screen.getByRole("button", { name: "Wrap long lines" }).getAttribute("aria-pressed"), "true", "toggle shows “on”");
    const marks = await grid.locator("mark").evaluateAll((list) => list.map((mark) => mark.textContent));
    equal(marks.map((mark) => mark.trim()), ["im Abstand von", "alle"], "word diff marks only the changed words of the long line");
    await app.screenshot(`${SHOTS}/diff-wrap.png`);
    await screen.getByRole("button", { name: "Wrap long lines" }).click();
    await eventually(() => settings().then((value) => value.diffWordWrap), false, "wrapping off again");

    // Pure indentation change
    await clickFile("unstaged", WHITESPACE);
    equal((await lineRows()).filter((row) => row.kind !== "context").length, 2, "with whitespace: one line removed, one added");
    await screen.getByRole("button", { name: "Ignore whitespace changes" }).click();
    await eventually(notice, "whitespace", "without whitespace nothing is left – notice");
    equal((await settings()).diffIgnoreWhitespace, true, "setting remembered");
    await app.screenshot(`${SHOTS}/diff-whitespace.png`);
    await screen.getByRole("button", { name: "Show whitespace" }).click();
    await until(() => lineRows().then((list) => list.length > 0), "“Show whitespace” shows the diff again");
    equal((await settings()).diffIgnoreWhitespace, false, "setting reset");
  });

  // -------------------------------------------------------------------------------------------
  await section("Image, binary file, LFS pointer", async () => {
    await clickFile("unstaged", repo.info.imageFile);
    equal(await attr("data-diff-kind"), "image", "kind: image");
    await until(() => screen.locator("[data-image-pane] img").evaluateAll((list) => list.length === 2 && list.every((image) => image.complete && image.naturalWidth === 96)), "both images loaded (96 px wide)");
    const captions = await screen.locator("[data-image-pane] figcaption").allInnerTexts();
    check(captions[0].startsWith("Before") && captions[0].includes("96 × 64 px") && captions[1].startsWith("After") && /KB|B/.test(captions[1]), `dimensions and size per side (was: ${JSON.stringify(captions)})`);
    check((await screen.locator("[data-image-pane] img").first().evaluate((image) => getComputedStyle(image).backgroundImage)).includes("conic-gradient"), "checkerboard behind the image");
    equal(await screen.getByRole("radiogroup", { name: "Display" }).count(), 0, "no text toggles for images");
    await app.screenshot(`${SHOTS}/diff-image.png`);
    // New image: only the right side
    await clickFile("unstaged", "docs/standort.png");
    await until(() => screen.locator("[data-image-pane] img").count().then((count) => count === 1), "new image: only one side has an image");
    check((await screen.locator('[data-image-pane="old"]').innerText()).includes("This image did not exist before."), "left side says the image did not exist");
    await app.screenshot(`${SHOTS}/diff-image-new.png`);

    await clickFile("unstaged", repo.info.binaryFile);
    equal(await notice(), "binary", "kind: binary");
    const binary = await screen.locator("[data-notice]").innerText();
    check(binary.includes("Binary file") && binary.includes("2 KB") && binary.includes("3 KB"), `sizes before and after (was: ${binary.replace(/\s+/g, " ")})`);
    await app.screenshot(`${SHOTS}/diff-binary.png`);

    await clickFile("unstaged", LFS);
    equal(await notice(), "lfs", "kind: LFS pointer");
    const lfs = await screen.locator("[data-notice]").innerText();
    check(lfs.includes("4d7a214614ab") && !lfs.includes("4d7a214614ab2") && lfs.includes("MB"), `OID shortened and size (was: ${lfs.replace(/\s+/g, " ")})`);
    await app.screenshot(`${SHOTS}/diff-lfs.png`);
  });

  // -------------------------------------------------------------------------------------------
  await section("Too large: notice and “Load anyway”", async () => {
    await clickFile("unstaged", TOO_LARGE);
    equal(await notice(), "too_large", "kind: too large");
    check((await screen.locator("[data-notice]").innerText()).includes("30,000 lines"), "notice names the line count");
    await app.screenshot(`${SHOTS}/diff-too-large.png`);
    await screen.getByRole("button", { name: "Load anyway" }).click();
    await grid.waitFor({ timeout: 30_000 });
    equal(await grid.getAttribute("aria-rowcount"), "30001", "all 30,000 lines plus hunk header");
    const drawn = await grid.locator("[data-row]").count();
    check(drawn < 200, `only the visible slice is in the DOM (${drawn} rows)`);
  });

  // -------------------------------------------------------------------------------------------
  await section("More cases: deleted, new, empty, rename only, mode only, encoding, long names", async () => {
    await clickFile("unstaged", "docs/alt-konzept.md");
    const deleted = await lineRows();
    check(deleted.length > 0 && deleted.every((row) => row.kind === "remove"), "deleted file: all lines removed");
    check((await screen.locator("[data-diff-title] .line-through").count()) === 1, "name struck through");

    await clickFile("unstaged", "notizen/offene-fragen.md");
    const added = await lineRows();
    check(added.length === 4 && added.every((row) => row.kind === "add"), "new file: all lines added");

    await clickFile("unstaged", EMPTY);
    equal(await notice(), "empty", "empty file: notice");

    await clickFile("staged", "docs/stationsaufbau.md");
    equal(await notice(), "renamed", "rename only: notice");
    check((await title()).includes("formerly docs/aufbau.md"), `header names the old path (was: ${await title()})`);
    await app.screenshot(`${SHOTS}/diff-renamed.png`);

    await clickFile("staged", SCRIPT);
    equal(await notice(), "unchanged", "mode change only: notice without hunks");

    await clickFile("unstaged", LATIN1);
    check((await screen.locator("[data-diff-header]").innerText()).includes("windows-1252"), "encoding is shown as a badge in the header");
    check((await lineRows()).some((row) => row.text === "Größe;Einheit"), "umlauts from windows-1252 shown correctly");
    await app.screenshot(`${SHOTS}/diff-encoding.png`);

    await clickFile("unstaged", repo.info.umlautFile);
    check((await title()).includes("Größen und Einheiten.md"), "file name with umlaut and space");

    await clickFile("unstaged", repo.info.longFile);
    await noOverflow("long file name does not break the header (1440×900)");
    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    await noOverflow("long file name does not break the header (960×600)");
    check(await screen.locator("[data-diff-title] span").first().evaluate((element) => element.scrollWidth > element.clientWidth), "at 960×600 the long name is truncated …");
    await screen.locator("[data-diff-title]").hover();
    await until(() => page.getByRole("tooltip").allInnerTexts().then((texts) => texts.some((text) => text.includes(repo.info.longFile))), "… and the tooltip shows the full path");
    await app.screenshot(`${SHOTS}/diff-long.png`);
    await page.mouse.move(5, 5);
    await clickFile("unstaged", MULTI);
    await noOverflow("no overflow at 960×600");
    await app.screenshot(`${SHOTS}/diff-min.png`);
    await app.setTheme("light");
    await page.waitForTimeout(150);
    await app.screenshot(`${SHOTS}/diff-min-light.png`);
    await app.setTheme("dark");
    await app.setSize(1440, 900);
    await page.waitForTimeout(250);
  });

  // -------------------------------------------------------------------------------------------
  await section("Commit as source: read-only", async () => {
    const details = await app.invoke("commit_details", { repoId, source: { kind: "commit", sha: repo.info.shas.coAuthored } });
    const file = details.files.find((candidate) => !candidate.isBinary) ?? details.files[0];
    await openDiff(file.path, { kind: "commit", sha: repo.info.shas.coAuthored });
    check((await screen.locator("[data-diff-header]").innerText()).includes(`Commit ${repo.info.shas.coAuthored.slice(0, 7)}`), "header names the commit");
    equal(await screen.getByRole("button", { name: /(Stage|Discard|Unstage) hunk/ }).count(), 0, "no hunk actions");
    equal(await screen.getByRole("button", { name: "Edit file" }).count(), 0, "“Edit” only in the working directory");
    // Clicking the line numbers selects nothing here.
    const gutter = grid.locator('[data-kind="add"] [data-gutter], [data-kind="remove"] [data-gutter]').first();
    if (await gutter.count()) await gutter.click();
    equal(await page.locator("[data-selection-bar]").count(), 0, "no line selection for commits");
    await app.screenshot(`${SHOTS}/diff-commit.png`);

    // Range: a commit against the working directory, and two commits against each other.
    await openDiff(MULTI, { kind: "range", from: repo.info.shas.csv, to: null });
    check((await screen.locator("[data-diff-header]").innerText()).includes("working directory"), "range up to the working directory in the header");
    check((await lineRows()).some((row) => row.kind === "add" && row.text === "2026-01-16;-999;-999;0,0;0"), "range shows the change in the working directory");
    equal(await screen.getByRole("button", { name: /(Stage|Discard|Unstage) hunk/ }).count(), 0, "range: no hunk actions");
    await openDiff("src/auswertung.py", { kind: "range", from: repo.info.shas.first, to: repo.info.shas.head });
    check((await lineRows()).length > 0, "range between two commits shows lines");
    // Stash
    await openDiff("src/sensoren.py", { kind: "stash", index: 1 });
    check((await screen.locator("[data-diff-header]").innerText()).includes("Stash 1"), "stash as source in the header");
    check((await lineRows()).some((row) => row.kind === "add" && row.text.includes("55.0")), "stash diff shows the stashed change");
    await press("Escape");
    await eventually(centerKind, "graph", "Esc closes");
  });

  // -------------------------------------------------------------------------------------------
  await section("Navigation: changes, files, history, blame, edit, close", async () => {
    await clickFile("unstaged", MULTI);
    equal(await changePosition(), "1/3", "three changes");
    await screen.getByRole("button", { name: "Next change" }).click();
    equal(await changePosition(), "1/3", "button: first change");
    await screen.getByRole("button", { name: "Next change" }).click();
    await screen.getByRole("button", { name: "Next change" }).click();
    equal(await changePosition(), "3/3", "third change");
    equal((await focusedRow())?.text, "2026-01-28;3,9;74;0,0;12", "focus on the third change");
    await screen.getByRole("button", { name: "Previous change" }).click();
    equal(await changePosition(), "2/3", "back to the second");
    await press("Alt+ArrowUp");
    equal(await changePosition(), "1/3", "Alt+↑: first change");

    // Files of the same list
    const status = await app.invoke("status_get", { repoId });
    const list = status.unstaged.map((file) => file.path);
    const at = list.indexOf(MULTI);
    check(at > 0 && at < list.length - 1, "test file is in the middle of the list");
    check((await screen.locator("[data-diff-header]").innerText()).includes(`${at + 1}/${list.length}`), "header shows the position in the list");
    await press("Alt+ArrowRight");
    await ready(list[at + 1]);
    await press("Alt+ArrowLeft");
    await ready(MULTI);
    await press("Alt+ArrowLeft");
    await ready(list[at - 1]);
    await screen.getByRole("button", { name: "Next file" }).click();
    await ready(MULTI);
    // At the start of the list “Previous file” is disabled.
    await clickFile("unstaged", list[0]);
    check(await screen.getByRole("button", { name: "Previous file" }).isDisabled(), "first file: “Previous file” disabled");

    await clickFile("unstaged", MULTI);
    await screen.getByRole("button", { name: "File history" }).click();
    equal(await page.evaluate((tab) => window.__gc.store.getState().views[tab].center, tabId), { kind: "history", path: MULTI }, "history opens File History");
    await openDiff(MULTI);
    await screen.getByRole("button", { name: "Blame" }).click();
    equal(await page.evaluate((tab) => window.__gc.store.getState().views[tab].center, tabId), { kind: "blame", path: MULTI, sha: null }, "Blame opens the blame view");
    await openDiff(MULTI);
    await screen.getByRole("button", { name: "Edit file" }).click();
    equal(await page.evaluate((tab) => window.__gc.store.getState().views[tab].center, tabId), { kind: "file", path: MULTI, sha: null, mode: "edit" }, "Edit opens the editor");
    await openDiff(MULTI);
    await screen.getByRole("button", { name: "Close diff" }).click();
    await eventually(centerKind, "graph", "close button leads to the graph");

    // Keyboard only: focus is on a header button whose tooltip is open. A single Esc closes the diff
    // (previously the first Esc only closed the tooltip).
    await openDiff(MULTI);
    await grid.locator('[data-row][tabindex="0"]').focus();
    for (let step = 0; step < 12 && (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) !== "Blame"; step++) await press("Shift+Tab");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Blame", "Shift+Tab leads out of the diff onto the header buttons");
    await page.locator('[role="tooltip"]').first().waitFor({ timeout: 5000 });
    await press("Escape");
    await eventually(centerKind, "graph", "a single Esc closes the diff, even with an open tooltip");
    await until(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="right"]'))), "focus goes back to the file list");
  });

  // -------------------------------------------------------------------------------------------
  await section("Minimap: marks, visible slice, click and drag", async () => {
    const minimap = screen.locator("[data-diff-minimap]");
    /** Reads the drawing: per pixel row, whether something is on the left (removed) or right (added), and in which colour. */
    const readMinimap = () =>
      page.evaluate(() => {
        const root = document.querySelector('[data-screen="diff"] [data-diff-minimap]');
        if (!root) return null;
        const canvas = root.querySelector("canvas");
        const thumb = root.querySelector("[data-minimap-thumb]");
        const ctx = canvas.getContext("2d");
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hex = (x, y) => {
          const at = (y * canvas.width + x) * 4;
          return image.data[at + 3] === 0 ? null : `#${[0, 1, 2].map((part) => image.data[at + part].toString(16).padStart(2, "0")).join("")}`;
        };
        const toHex = (value) => {
          const probe = document.createElement("canvas").getContext("2d");
          probe.fillStyle = value;
          return probe.fillStyle;
        };
        const style = getComputedStyle(document.documentElement);
        const left = Math.floor(canvas.width / 4);
        const right = Math.floor((canvas.width * 3) / 4);
        const runs = (x) => {
          const list = [];
          let start = -1;
          const colors = new Set();
          for (let y = 0; y <= canvas.height; y++) {
            const color = y < canvas.height ? hex(x, y) : null;
            if (color) colors.add(color);
            if (color && start < 0) start = y;
            else if (!color && start >= 0) {
              list.push([start, y]);
              start = -1;
            }
          }
          return { list, colors: [...colors] };
        };
        const scroller = document.querySelector('[data-screen="diff"] [data-diff-grid], [data-screen="diff"] .cm-mergeView');
        return {
          ariaHidden: root.getAttribute("aria-hidden"),
          tabbable: root.querySelectorAll('[tabindex]:not([tabindex="-1"]), button, a').length + (root.hasAttribute("tabindex") ? 1 : 0),
          width: Math.round(root.getBoundingClientRect().width),
          height: root.clientHeight,
          canvasHeight: canvas.height,
          added: Number(root.dataset.marksAdded),
          removed: Number(root.dataset.marksRemoved),
          draws: Number(root.dataset.draws),
          scale: Number(root.dataset.scale),
          removedRuns: runs(left),
          addedRuns: runs(right),
          success: toHex(style.getPropertyValue("--gc-success").trim()),
          danger: toHex(style.getPropertyValue("--gc-danger").trim()),
          thumbHidden: thumb.hidden,
          thumbTop: Number(/translateY\(([-\d.]+)px\)/.exec(thumb.style.transform)?.[1] ?? 0),
          thumbHeight: Number.parseFloat(thumb.style.height),
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        };
      });
    /** Contiguous runs of added or removed lines according to git – that many marks must exist. */
    const gitRuns = (file) => {
      let added = 0;
      let removed = 0;
      let last = " ";
      for (const line of git("-c", "core.quotepath=false", "diff", "--no-color", "--", file).split(/\r?\n/)) {
        const sign = line.startsWith("+++") || line.startsWith("---") ? "h" : (line[0] ?? " ");
        if (sign === "+" && last !== "+") added++;
        if (sign === "-" && last !== "-") removed++;
        last = sign;
      }
      return { added, removed };
    };

    // Short diff: everything fits – marks yes, but no frame for the visible slice.
    await clickFile("unstaged", MULTI);
    await minimap.waitFor();
    let map = await readMinimap();
    equal(map.ariaHidden, "true", "purely supplementary: aria-hidden");
    equal(map.tabbable, 0, "the minimap takes no keyboard focus");
    equal({ added: map.added, removed: map.removed }, gitRuns(MULTI), "as many marks as contiguous runs in git diff");
    check(map.thumbHidden, "if the whole diff fits, there is no frame for the visible slice");

    // Scattered changes in 900 lines
    await clickFile("unstaged", SCATTERED);
    await minimap.waitFor();
    await until(() => readMinimap().then((value) => value && value.added > 0), "minimap drawn");
    map = await readMinimap();
    equal({ added: map.added, removed: map.removed }, gitRuns(SCATTERED), "scattered changes: marks as in git diff");
    equal(map.addedRuns.colors, [map.success], "added is on the right, in the “success” colour from the tokens");
    equal(map.removedRuns.colors, [map.danger], "removed is on the left, in the “danger” colour from the tokens");
    check(map.addedRuns.list.length >= 4 && map.removedRuns.list.length >= 4, `several separate marks per side (${map.removedRuns.list.length} left, ${map.addedRuns.list.length} right)`);
    // Position is right: each grid row sits in the minimap where it sits in the diff.
    const rowCheck = await page.evaluate(() => {
      const gridElement = document.querySelector('[data-screen="diff"] [data-diff-grid]');
      const root = document.querySelector('[data-screen="diff"] [data-diff-minimap]');
      const scale = Number(root.dataset.scale);
      const ratio = root.querySelector("canvas").height / root.clientHeight;
      return [...gridElement.querySelectorAll('[data-kind="add"], [data-kind="remove"]')].slice(0, 6).map((row) => {
        const top = row.parentElement.getBoundingClientRect().top - gridElement.getBoundingClientRect().top + gridElement.scrollTop;
        return { kind: row.dataset.kind, y: Math.floor((top + 2) * scale * ratio) };
      });
    });
    for (const row of rowCheck) {
      const runs = row.kind === "add" ? map.addedRuns.list : map.removedRuns.list;
      check(runs.some(([from, to]) => row.y >= from - 1 && row.y < to + 1), `mark for an ${row.kind === "add" ? "added" : "removed"} line at y=${row.y} (${JSON.stringify(runs)})`);
    }
    check(!map.thumbHidden && map.thumbTop === 0, "the frame is at the top");
    check(Math.abs(map.thumbHeight - map.clientHeight * map.scale) < 1.5, `frame height matches the visible slice (${map.thumbHeight} / ${(map.clientHeight * map.scale).toFixed(1)})`);
    equal(map.width, 14, "narrow strip: 14 px (token size.minimap)");
    await app.screenshot(`${SHOTS}/diff-minimap.png`);

    // Scrolling moves the frame without redrawing.
    const drawsBefore = map.draws;
    await grid.evaluate((element) => (element.scrollTop = element.scrollHeight / 2));
    await until(() => readMinimap().then((value) => Math.abs(value.thumbTop - value.scrollTop * value.scale) < 1.5 && value.thumbTop > 10), "the frame follows scrolling");
    equal((await readMinimap()).draws, drawsBefore, "scrolling does not redraw the minimap");

    // Click jumps: the clicked spot moves to the middle of the visible slice.
    const box = await minimap.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
    map = await readMinimap();
    const expectTop = (fraction, value) => Math.min(value.scrollHeight - value.clientHeight, Math.max(0, (value.height * fraction) / value.scale - value.clientHeight / 2));
    check(Math.abs(map.scrollTop - expectTop(0.8, map)) < 3, `click at 80 % jumps there (scrollTop ${map.scrollTop}, expected ${expectTop(0.8, map).toFixed(0)})`);
    // Drag: the slice follows the pointer.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35, { steps: 4 });
    const mid = await readMinimap();
    check(Math.abs(mid.scrollTop - expectTop(0.35, mid)) < 3, `drag: at 35 % (scrollTop ${mid.scrollTop}, expected ${expectTop(0.35, mid).toFixed(0)})`);
    await page.mouse.move(box.x - 200, box.y + box.height * 0.6, { steps: 4 });
    const far = await readMinimap();
    check(Math.abs(far.scrollTop - expectTop(0.6, far)) < 3, "dragging follows even when the pointer leaves the strip sideways");
    await page.mouse.up();
    await page.mouse.move(box.x - 200, box.y + box.height * 0.1);
    equal((await readMinimap()).scrollTop, far.scrollTop, "after release nothing follows any more");
    // The keyboard stays the way between changes: F7 jumps on, the frame comes along.
    await press("F7");
    await until(() => focusedRow().then((row) => row !== null), "F7 focuses the diff");
    await until(() => readMinimap().then((value) => Math.abs(value.thumbTop - value.scrollTop * value.scale) < 1.5), "after F7 the frame is right again");

    // Light: colours fresh from the tokens
    await app.setTheme("light");
    await until(() => readMinimap().then((value) => value.addedRuns.colors.length === 1 && value.addedRuns.colors[0] === value.success && value.removedRuns.colors[0] === value.danger), "light theme: the minimap redraws with the light colours");
    check((await readMinimap()).success !== map.success, "the light theme colours are different");
    await app.screenshot(`${SHOTS}/diff-minimap-light.png`);
    await app.setTheme("dark");
    // 960×600
    await app.setSize(960, 600);
    await until(() => readMinimap().then((value) => value.canvasHeight > 0 && Math.abs(value.thumbHeight - value.clientHeight * value.scale) < 1.5), "960×600: redrawn, frame fits");
    await noOverflow("960×600 with minimap: nothing overflows");
    await app.screenshot(`${SHOTS}/diff-minimap-min.png`);
    await app.setSize(1440, 900);
    await page.waitForTimeout(250);

    // Whole file: collapsing unchanged regions changes positions – the minimap redraws.
    await setSettings({ diffMode: "inline" });
    await until(() => attr("data-diff-mode").then((value) => value === "inline"), "whole file");
    await until(() => readMinimap().then((value) => value && value.added === gitRuns(SCATTERED).added), "whole file: the same marks");
    const open = await readMinimap();
    await screen.getByRole("button", { name: "Collapse unchanged regions" }).click();
    await until(() => readMinimap().then((value) => value.scrollHeight < open.scrollHeight / 2 && value.scale > open.scale), "collapsed: shorter content, the marks spread apart");
    await screen.getByRole("button", { name: "Expand unchanged regions" }).click();

    // Side by side: minimap of the merge view
    await setSettings({ diffMode: "split" });
    await screen.locator(".cm-mergeView").waitFor({ timeout: 30_000 });
    await until(() => readMinimap().then((value) => value && value.added > 0 && value.removed > 0), "side by side: minimap with marks", 15_000);
    map = await readMinimap();
    // The merge view is exact: the same changed runs as git diff – not “the whole rest of the file”.
    equal({ added: map.added, removed: map.removed }, gitRuns(SCATTERED), "side by side: the same runs as git diff");
    equal(map.addedRuns.colors, [map.success], "side by side: added on the right");
    equal(map.removedRuns.colors, [map.danger], "side by side: removed on the left");
    const splitBox = await minimap.boundingBox();
    await page.mouse.click(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height * 0.9);
    await until(() => readMinimap().then((value) => value.scrollTop > 0 && Math.abs(value.thumbTop - value.scrollTop * value.scale) < 2), "side by side: click jumps, the frame follows");
    await app.screenshot(`${SHOTS}/diff-minimap-split.png`);
    await setSettings({ diffMode: "hunks" });
    await until(() => attr("data-diff-mode").then((value) => value === "hunks"), "back to hunks");

    // A commit as source (read-only) has the minimap too.
    const details = await app.invoke("commit_details", { repoId, source: { kind: "commit", sha: repo.info.shas.coAuthored } });
    await openDiff((details.files.find((candidate) => !candidate.isBinary) ?? details.files[0]).path, { kind: "commit", sha: repo.info.shas.coAuthored });
    await until(() => readMinimap().then((value) => value && value.added > 0), "commit as source: minimap with marks");
    await press("Escape");
    await eventually(centerKind, "graph", "Esc closes");
  });

  // -------------------------------------------------------------------------------------------
  await section("States: loading, error with “Try again”, file gone", async () => {
    // Delay or fail the core's answer artificially – only then are these states reliably visible.
    // `window.__TAURI_INTERNALS__.invoke` is not writable, so the method on the core object is replaced instead
    // (the proxy in src/core/index.ts prefers an own property over the generated call).
    const tamper = (delayMs, fail) =>
      page.evaluate(
        ([delay, error]) => {
          const core = window.__gc.core;
          delete core.diffFile;
          const original = core.diffFile;
          core.diffFile = async (input) => {
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            if (error) throw error;
            return original(input);
          };
        },
        [delayMs, fail],
      );
    const restore = () => page.evaluate(() => delete window.__gc.core.diffFile);

    await tamper(1500, null);
    await page.evaluate(([tab, file]) => window.__gc.store.getState().openDiff(tab, file, { kind: "unstaged" }), [tabId, SLOW]);
    await screen.locator("[data-diff-loading]").waitFor();
    equal(await screen.locator("[data-diff-loading]").getAttribute("role"), "status", "skeleton rows instead of a spinner");
    equal(await screen.locator(".animate-spin").count(), 0, "no spinner");
    await app.screenshot(`${SHOTS}/diff-loading.png`);
    await ready(SLOW);
    check((await lineRows()).length > 0, "then the diff is shown");

    await restore();
    await tamper(0, { code: "io", message: "The file could not be read.", gitOutput: null });
    await page.evaluate(([tab, file]) => window.__gc.store.getState().openDiff(tab, file, { kind: "unstaged" }), [tabId, "README.md"]);
    await eventually(notice, "error", "error state");
    check((await screen.locator("[data-notice]").innerText()).includes("The file could not be read."), "error text understandable");
    await app.screenshot(`${SHOTS}/diff-error.png`);
    await restore();
    await screen.getByRole("button", { name: "Try again" }).click();
    await until(() => notice().then((value) => value !== "error"), "“Try again” loads the diff");

    // A file that does not exist – a real error from the core (not_found).
    await page.evaluate(([tab]) => window.__gc.store.getState().openDiff(tab, "gibt/es/nicht.txt", { kind: "unstaged" }), [tabId]);
    await eventually(notice, "gone", "file gone");
    await app.screenshot(`${SHOTS}/diff-gone.png`);
    await screen.getByRole("button", { name: "Back to graph" }).click();
    await eventually(centerKind, "graph", "back to the graph");

    // File disappears while its diff is open.
    writeBytes("notizen/kurzlebig.txt", "gleich wieder weg\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(() => page.locator('[data-section="unstaged"] [data-row-key="notizen/kurzlebig.txt"]').count().then((count) => count === 1), "new file appears in the list");
    await clickFile("unstaged", "notizen/kurzlebig.txt");
    fs.rmSync(path.join(repo.path, "notizen/kurzlebig.txt"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(notice, "gone", "deleted file: notice instead of the old diff", 15_000);
    await press("Escape");
    await eventually(centerKind, "graph", "Esc closes here too");
  });

  // -------------------------------------------------------------------------------------------
  await section("Performance: 5000 changed lines scroll smoothly", async () => {
    const started = Date.now();
    await clickFile("unstaged", MANY);
    const loadMs = Date.now() - started;
    equal(await counts(), "+5000 −5000", "5000 lines removed and added");
    await until(() => grid.locator(".gc-tok-keyword").count().then((count) => count > 0), "syntax colours despite the size", 20_000);
    const measure = (selector) =>
      page.evaluate(async (target) => {
        const element = document.querySelector(target);
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        element.scrollTop = 0;
        await frame();
        const times = [];
        let last = performance.now();
        let maxRows = 0;
        for (let step = 0; step < 240; step++) {
          element.scrollTop += 400;
          await frame();
          const now = performance.now();
          times.push(now - last);
          last = now;
          maxRows = Math.max(maxRows, element.querySelectorAll("[data-row], .cm-line").length);
        }
        const sorted = [...times].sort((a, b) => a - b);
        const blank = element.querySelectorAll("[data-row], .cm-line").length === 0;
        return { avg: times.reduce((sum, value) => sum + value, 0) / times.length, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1], maxRows, scrolled: element.scrollTop, blank };
      }, selector);
    const format = (result) => `Ø ${result.avg.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, max ${result.max.toFixed(1)} ms per frame, at most ${result.maxRows} rows in the DOM`;

    const hunks = await measure("[data-diff-grid]");
    measurements.push(`Hunks, 10,000 diff lines (load ${loadMs} ms): ${format(hunks)}`);
    check(hunks.scrolled > 90_000, `scrolled 240 steps of 400 px (${hunks.scrolled})`);
    check(hunks.avg < 34 && hunks.p95 < 67, `Hunks scrolls smoothly – ${format(hunks)}`);
    check(hunks.maxRows < 250 && !hunks.blank, `virtualised: ${hunks.maxRows} rows in the DOM, never empty`);
    // The minimap of the large diff: drawn, but not on every scroll step.
    const mapState = () => screen.locator("[data-diff-minimap]").evaluate((root) => ({ draws: Number(root.dataset.draws), added: Number(root.dataset.marksAdded), removed: Number(root.dataset.marksRemoved) }));
    const bigMap = await mapState();
    check(bigMap.added > 0 && bigMap.removed > 0, `minimap of the large diff has marks (${bigMap.removed} removed, ${bigMap.added} added)`);
    const drawsBefore = bigMap.draws;
    const again = await measure("[data-diff-grid]");
    const drawsDuring = (await mapState()).draws - drawsBefore;
    measurements.push(`Hunks with minimap, second pass: ${format(again)}, ${drawsDuring} minimap draws in 240 frames`);
    check(drawsDuring <= 2, `scrolling does not redraw the minimap (${drawsDuring} draws in 240 frames)`);
    check(again.avg < 34 && again.p95 < 67, `still smooth with minimap – ${format(again)}`);
    await app.screenshot(`${SHOTS}/diff-many.png`);

    await setSettings({ diffMode: "inline" });
    await until(() => attr("data-diff-mode").then((value) => value === "inline"), "whole file");
    const inline = await measure("[data-diff-grid]");
    measurements.push(`Whole file, 11,000 lines: ${format(inline)}`);
    check(inline.avg < 34 && inline.p95 < 67, `Whole file scrolls smoothly – ${format(inline)}`);

    await setSettings({ diffMode: "split" });
    await screen.locator(".cm-mergeView").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const split = await measure(".cm-mergeView");
    measurements.push(`Side by side, 2 × 6000 lines: ${format(split)}`);
    check(split.avg < 50 && split.p95 < 100, `Side by side scrolls smoothly – ${format(split)}`);
    check(split.maxRows < 600, `CodeMirror renders only the visible slice (${split.maxRows} lines)`);
    await setSettings({ diffMode: "hunks" });

    // Keyboard in the large diff: End, Home, Page Down – focus comes along.
    await until(() => attr("data-diff-mode").then((value) => value === "hunks"), "back to hunks");
    await grid.waitFor();
    await press("F7");
    await press("Control+End");
    await press("End");
    await until(() => focusedRow().then((row) => row?.text?.includes("wert5002 ")), "End jumps to the last line of the diff (last context line)");
    await press("Home");
    await until(() => focusedRow().then((row) => row?.text?.includes("wert0 ")), "Home jumps to the first line");
  });

  // -------------------------------------------------------------------------------------------
  await section("Console", async () => {
    equal(app.consoleErrors, [], "console errors");
  });
} catch (error) {
  failures.push(`aborted: ${error?.stack ?? error}`);
} finally {
  const errors = app?.consoleErrors ?? [];
  if (app) await app.close();
  repo.cleanup();
  if (measurements.length) console.log(`\nMeasurements\n${measurements.map((line) => `- ${line}`).join("\n")}`);
  if (errors.length && !failures.some((line) => line.includes("console errors"))) failures.push(`console errors: ${errors.join(" | ")}`);
  console.log(failures.length ? `\nS09: ${failures.length} failures\n${failures.map((line) => `- ${line}`).join("\n")}` : "\nS09: green.");
  process.exit(failures.length ? 1 : 0);
}
