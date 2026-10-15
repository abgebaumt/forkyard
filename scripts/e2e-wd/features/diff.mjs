/**
 * Diff views (hunks, whole file, side by side, word highlighting), file view and editor with
 * Markdown preview, file history, blame (1.0) and the image diff with its four modes (1.1) –
 * in the real app against real temp repositories. Every result is checked in the UI and, where
 * something is written, in Git itself.
 *
 *   node scripts/e2e-wd/features/diff.mjs
 *   E2E_WD_ONLY="Bild" node scripts/e2e-wd/features/diff.mjs
 */
import { EVIL_MD } from "../../e2e/screens/files-lib.mjs";
import { assert, assertEqual as rawEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";
import { PEOPLE, blameBlocks, blamePorcelain, followLog, landscape, makeDiffRepo, pngFrom } from "../fixtures/diff-repo.mjs";

/** Plain data with object keys sorted – the WebView does not keep key order. */
const canon = (value) => (Array.isArray(value) ? value.map(canon) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])])) : value);
const assertEqual = (actual, expected, message) => rawEqual(canon(actual), canon(expected), message);

const LIGHT = { width: 1440, height: 900, theme: "light", lang: "en" };
const short = (sha) => sha.slice(0, 7);
const ZERO = "0".repeat(40);

// ---------------------------------------------------------------------------------------------
// Helpers around a running app
// ---------------------------------------------------------------------------------------------

const store = (app, method, ...args) => app.exec((name, list) => window.__gc.store.getState()[name](...list), method, args);
const center = (app, tabId) => app.exec((tab) => window.__gc.store.getState().views[tab]?.center ?? null, tabId);
const attr = (app, selector, name) => app.exec((sel, n) => document.querySelector(sel)?.getAttribute(n) ?? null, selector, name);
const textOf = (app, selector) => app.exec((sel) => document.querySelector(sel)?.innerText ?? null, selector);
const count = (app, selector) => app.exec((sel) => document.querySelectorAll(sel).length, selector);

/** Button in `scope` whose aria-label, title or text is `label` (waits for it). */
const button = (app, scope, label) =>
  app.waitFor(
    () =>
      app.exec(
        (sel, wanted) =>
          [...(document.querySelector(sel)?.querySelectorAll("button, [role=button]") ?? [])].find(
            (element) => element.getAttribute("aria-label") === wanted || element.getAttribute("title") === wanted || element.textContent.replace(/\s+/g, " ").trim() === wanted,
          ) ?? null,
        scope,
        label,
      ),
    10_000,
    { message: `button “${label}” in ${scope}` },
  );

/** Waits until `[data-screen=<screen>]` shows `label` and nothing is loading any more. */
async function ready(app, screen, label, extra = null) {
  await app.waitFor(
    () =>
      app.exec(
        (sel, wanted, more) => {
          const root = document.querySelector(sel);
          if (!root || root.getAttribute("aria-label") !== wanted) return false;
          if (root.querySelector("[data-loading], [data-diff-loading]")) return false;
          return more ? Boolean(root.querySelector(more)) : true;
        },
        `[data-screen="${screen}"]`,
        label,
        extra,
      ),
    30_000,
    { message: `${screen} shows "${label}"` },
  );
  await app.settle();
}

/** Waits until `read()` deep-equals `expected` (JSON); returns the last value. */
async function eventually(app, read, expected, message, timeout = 15_000) {
  let last;
  try {
    return await app.waitFor(
      async () => {
        last = await read();
        return JSON.stringify(canon(last)) === JSON.stringify(canon(expected)) ? { value: last } : null;
      },
      timeout,
      { message },
    ).then((box) => box.value);
  } catch {
    assertEqual(last, expected, message);
  }
}

/** The status of the app reflects the working directory (after writing files from outside). */
async function refresh(app) {
  await app.exec(() => {
    window.dispatchEvent(new Event("focus"));
    return window.__gc.queryClient.invalidateQueries();
  });
  await app.settle();
}

const diffReady = (app, file, extra) => ready(app, "diff", `Diff of ${file}`, extra);
const DIFF = '[data-screen="diff"]';
const GRID = `${DIFF} [data-diff-grid]`;

/** The rendered line rows of the diff grid: kind, text and the highlighted words. */
const gridRows = (app) =>
  app.exec((sel) =>
    [...document.querySelectorAll(`${sel} [data-row][role="row"]`)]
      .filter((row) => ["context", "add", "remove"].includes(row.dataset.kind))
      .map((row) => ({
        kind: row.dataset.kind,
        text: (row.querySelector(".selectable")?.textContent ?? "").replace(/​/g, ""),
        marks: [...row.querySelectorAll("mark")].map((mark) => mark.textContent),
      })),
    GRID,
  );

/** Changed lines of `git diff` for one file: hunks, added and removed lines. */
function gitDiff(repo, file, ...extra) {
  const text = repo.git("-c", "core.quotepath=false", "diff", "--no-color", ...extra, "--", file);
  const lines = text.split("\n");
  return {
    hunks: lines.filter((line) => line.startsWith("@@")).length,
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)),
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)),
  };
}

/** Opens the diff of an unstaged file the way a user does: click in the commit panel list. */
async function clickUnstaged(app, file) {
  const row = await app.waitFor(`[data-section="unstaged"] [data-row-key=${JSON.stringify(file)}]`, 20_000, { message: `unstaged row ${file}` });
  await app.exec((element) => element.scrollIntoView({ block: "center" }), row);
  await row.click();
  await diffReady(app, file);
}

// ---------------------------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------------------------

const REPORT_LINES = Array.from({ length: 30 }, (_, index) => `Zeile ${String(index + 1).padStart(2, "0")}: Messwert ${index * 3} Grad`);
REPORT_LINES[1] = "Die Station misst die Temperatur jede Stunde am Mast.";
REPORT_LINES[24] = "Der Logger schreibt alle Werte in eine Datei.";

/** One text file with two separate changes (each a single changed word) and a new last line. */
function makeTextRepo() {
  const repo = makeDiffRepo();
  repo.write("src/bericht.txt", `${REPORT_LINES.join("\n")}\n`);
  repo.write("src/leerraum.py", "def mittel(werte):\n    return sum(werte) / len(werte)\n");
  repo.write("daten/kalibrierung.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 9, 0, 7]));
  repo.commit("Messbericht angelegt");
  const changed = [...REPORT_LINES];
  changed[1] = "Die Station misst die Luftfeuchte jede Stunde am Mast.";
  changed[24] = "Der Logger schreibt alle Werte in eine Tabelle.";
  changed.push("Neue Schlusszeile.");
  repo.write("src/bericht.txt", `${changed.join("\n")}\n`);
  return repo;
}

// =============================================================================================
// Diff views (1.0)
// =============================================================================================

scenario("Diff in Hunks: aus der Dateiliste öffnen, Wörter hervorgehoben", "main", async (t) => {
  const repo = makeTextRepo();
  try {
    const app = await t.launch(LIGHT);
    await app.openRepo(repo.path);
    const file = "src/bericht.txt";
    await clickUnstaged(app, file);
    t.step("diff opened by clicking the file in “Unstaged”");
    assertEqual(await attr(app, DIFF, "data-diff-mode"), "hunks", "default display mode");

    const expected = gitDiff(repo, file);
    assertEqual(expected.hunks, 2, "precondition: git diff has two hunks");
    assertEqual(await count(app, `${GRID} [data-hunk]`), expected.hunks, "one hunk header per git hunk");
    const rows = await gridRows(app);
    assertEqual(rows.filter((row) => row.kind === "add").map((row) => row.text), expected.added, "added lines like git diff");
    assertEqual(rows.filter((row) => row.kind === "remove").map((row) => row.text), expected.removed, "removed lines like git diff");
    assertMatch(await textOf(app, `${DIFF} [data-diff-counts]`), /^\+3\s*−2\s*$/, "header counts (+3 −2 like git diff --numstat)");
    assertEqual(repo.git("diff", "--numstat", "--", file), `3\t2\t${file}`, "git diff --numstat");

    // Word highlighting: only the changed word is marked, on both sides.
    const byText = (needle) => rows.find((row) => row.text.includes(needle));
    assertEqual(byText("Temperatur").marks, ["Temperatur"], "old line: only “Temperatur” is marked");
    assertEqual(byText("Luftfeuchte").marks, ["Luftfeuchte"], "new line: only “Luftfeuchte” is marked");
    assertEqual(byText("eine Datei").marks, ["Datei"], "second hunk, old: “Datei”");
    assertEqual(byText("eine Tabelle").marks, ["Tabelle"], "second hunk, new: “Tabelle”");
    assertEqual(byText("Neue Schlusszeile").marks, [], "a purely added line has no word marks");
    assert(rows.filter((row) => row.kind === "context").every((row) => row.marks.length === 0), "context lines are never marked");
    // Highlight differs visibly from the line background.
    const colors = await app.exec((sel) => {
      const mark = document.querySelector(`${sel} [data-kind="add"] mark`);
      return [getComputedStyle(mark).backgroundColor, getComputedStyle(mark.closest("[data-row]")).backgroundColor];
    }, GRID);
    assert(colors[0] !== colors[1], `word mark has its own colour (${colors.join(" vs ")})`);
    await t.shot("diff-hunks-word-highlight");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Diff nebeneinander und ganze Datei, Modus bleibt gespeichert", "main", async (t) => {
  const repo = makeTextRepo();
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    const file = "src/bericht.txt";
    await clickUnstaged(app, file);

    // Whole file: no hunk headers, the unchanged middle (line 15) is there.
    await app.click(`${DIFF} [aria-label="Display"] [data-value="inline"]`);
    await eventually(app, () => attr(app, DIFF, "data-diff-mode"), "inline", "display mode “Whole file”");
    assertEqual(await count(app, `${GRID} [data-hunk]`), 0, "no hunk headers in “Whole file”");
    const whole = await gridRows(app);
    assert(whole.some((row) => row.text === REPORT_LINES[14]), "line 15 (far from every change) is shown");
    assertEqual(whole.filter((row) => row.kind !== "remove").length, 31, "all 31 lines of the new version");
    t.step("whole file shows all lines");

    // Side by side: two CodeMirror columns, old left, new right, changed words marked.
    await app.click(`${DIFF} [aria-label="Display"] [data-value="split"]`);
    await eventually(app, () => attr(app, DIFF, "data-diff-mode"), "split", "display mode “Side by side”");
    await app.waitFor(`${DIFF} .cm-mergeView`, 15_000);
    assertEqual(await count(app, `${DIFF} .cm-mergeView .cm-editor`), 2, "two columns");
    const sides = await app.waitFor(
      () =>
        app.exec((sel) => {
          const a = [...document.querySelectorAll(`${sel} .cm-merge-a .cm-changedText`)].map((node) => node.textContent);
          const b = [...document.querySelectorAll(`${sel} .cm-merge-b .cm-changedText`)].map((node) => node.textContent);
          return a.length && b.length ? { a, b } : null;
        }, DIFF),
      10_000,
      { message: "changed text marked side by side" },
    );
    assert(sides.a.join("|").includes("Temperatur"), `left column marks “Temperatur” (${JSON.stringify(sides.a)})`);
    assert(sides.b.join("|").includes("Luftfeuchte"), `right column marks “Luftfeuchte” (${JSON.stringify(sides.b)})`);
    assert(!sides.b.join("|").includes("Station"), "unchanged words are not marked");
    const captions = await textOf(app, `${DIFF} [data-split="both"]`);
    assertIncludes(captions, "Before", "caption “Before”");
    assertIncludes(captions, "After", "caption “After”");
    const settings = await app.invoke("settings_get");
    assertEqual(settings.diffMode, "split", "the mode is saved in the settings");
    await t.shot("diff-side-by-side");

    // Remembered: after a reload the next diff opens side by side again.
    await app.reload();
    await app.waitFor(() => app.exec((tab) => Boolean(document.querySelector(`[data-tab-id="${tab}"]`)), tabId), 30_000);
    await app.settle();
    await clickUnstaged(app, file);
    assertEqual(await attr(app, DIFF, "data-diff-mode"), "split", "after reloading the diff opens side by side");
    await app.click(`${DIFF} [aria-label="Display"] [data-value="hunks"]`);
    await eventually(app, () => attr(app, DIFF, "data-diff-mode"), "hunks", "back to “Hunks”");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Diff Sonderfälle: nur Leerraum, neue Datei, Binärdatei, Navigation, Schließen", "edge", async (t) => {
  const repo = makeTextRepo();
  repo.write("src/leerraum.py", "def mittel(werte):\n        return sum(werte) / len(werte)\n");
  repo.write("notizen/neu.md", "# Neu\n\nNoch nie committet.\n");
  repo.write("daten/kalibrierung.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 9, 0, 8, 0]));
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);

    // Only whitespace changed: with "Ignore whitespace" nothing is left – an explicit note.
    await clickUnstaged(app, "src/leerraum.py");
    assertEqual(await count(app, `${GRID} [data-hunk]`), 1, "whitespace change: one hunk");
    const toggle = `${DIFF} button[aria-label="Ignore whitespace changes"]`;
    await app.click(toggle);
    await eventually(app, () => attr(app, toggle, "aria-pressed"), "true", "toggle is pressed");
    await app.waitFor(() => app.exec((sel) => document.querySelector(sel)?.innerText.includes("Only whitespace changed"), DIFF), 10_000, { message: "note “Only whitespace changed”" });
    assertEqual(gitDiff(repo, "src/leerraum.py", "-w").hunks, 0, "git diff -w agrees: nothing left");
    t.step("ignore whitespace: note shown");
    // The toolbar is gone when nothing is left; the note offers the way back.
    await t.shot("diff-only-whitespace");
    await app.click(await button(app, DIFF, "Show whitespace"));
    await app.waitFor(() => count(app, `${GRID} [data-hunk]`), 10_000, { message: "“Show whitespace” brings the hunk back" });
    assertEqual(await attr(app, toggle, "aria-pressed"), "false", "whitespace no longer ignored");

    // New file side by side: one column with a heading.
    await app.click(`${DIFF} [aria-label="Display"] [data-value="split"]`);
    await eventually(app, () => attr(app, DIFF, "data-diff-mode"), "split", "side by side");
    await clickUnstaged(app, "notizen/neu.md");
    await app.waitFor(`${DIFF} [data-split="single"] .cm-editor`, 15_000);
    assertIncludes(await textOf(app, `${DIFF} [data-split="single"]`), "New file", "new file: one column “New file”");
    await app.click(`${DIFF} [aria-label="Display"] [data-value="hunks"]`);
    await eventually(app, () => attr(app, DIFF, "data-diff-mode"), "hunks", "back to hunks");

    // Binary file: a notice instead of lines.
    await clickUnstaged(app, "daten/kalibrierung.bin");
    await app.waitFor(`${DIFF} [data-notice]`, 10_000);
    assertIncludes(await textOf(app, `${DIFF} [data-notice]`), "Binary file – no text diff", "binary notice");
    assertEqual(await count(app, `${GRID} [data-row]`), 0, "no lines for a binary file");

    // Next/previous change and close.
    await clickUnstaged(app, "src/bericht.txt");
    const position = () => textOf(app, `${DIFF} [data-change-position]`);
    const first = await position();
    const total = Number(first.split("/")[1]);
    assertMatch(first, /^1\/[2-9]$/, "several changes, starting at the first");
    // The first press lands on the first change, every further one moves on.
    for (let step = 0; step < total; step++) await app.click(await button(app, DIFF, "Next change"));
    await eventually(app, position, `${total}/${total}`, "“Next change” reaches the last change");
    await app.click(await button(app, DIFF, "Previous change"));
    await eventually(app, position, `${total - 1}/${total}`, "“Previous change” goes back one");
    t.step(`change navigation over ${total} changes`);
    await app.click(await button(app, DIFF, "Close diff"));
    await eventually(app, async () => (await center(app, tabId))?.kind, "graph", "“Close diff” returns to the graph");
    assertEqual(repo.git("status", "--porcelain").split("\n").map((line) => line.trim()).sort(), ["?? notizen/", "M daten/kalibrierung.bin", "M src/bericht.txt", "M src/leerraum.py"], "viewing changes nothing in Git");
    assertEqual(repo.git("diff", "--cached", "--name-only"), "", "nothing staged by looking");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Wort-Hervorhebung: umgeschriebene Zeile ohne Markierung, Umlaute", "edge", async (t) => {
  const repo = makeDiffRepo();
  repo.write("text/einheiten.txt", "Größe der Anlage: klein\nKomplett alte Beschreibung hier\nTemperatur in Grad Celsius\n");
  repo.commit("Einheiten");
  repo.write("text/einheiten.txt", "Größe der Anlage: mittelgroß\nVöllig andere Worte stehen jetzt da drin\nTemperatur in Grad Fahrenheit\n");
  try {
    const app = await t.launch(LIGHT);
    await app.openRepo(repo.path);
    await clickUnstaged(app, "text/einheiten.txt");
    const rows = await gridRows(app);
    const row = (needle) => rows.find((entry) => entry.text.includes(needle));
    assertEqual(row("klein").marks, ["klein"], "old: “klein”");
    assertEqual(row("mittelgroß").marks, ["mittelgroß"], "new: the whole word with ß is one mark");
    assertEqual(row("Komplett").marks, [], "rewritten line (old): no word marks");
    assertEqual(row("Völlig").marks, [], "rewritten line (new): no word marks");
    assertEqual(row("Fahrenheit").marks, ["Fahrenheit"], "third pair still compared word by word");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// =============================================================================================
// File view and editor, Markdown preview (1.0)
// =============================================================================================

const FV = '[data-screen="file-view"]';
const fileReady = (app, file) => ready(app, "file-view", `File ${file}`, ".cm-content, article[data-md-preview], [data-notice]");
const editorText = (app) => app.exec((sel) => [...document.querySelectorAll(`${sel} .cm-content .cm-line`)].map((line) => line.textContent).join("\n"), FV);

/** Click into the text, jump to the end and type. */
async function typeAtEnd(app, text) {
  await app.click(`${FV} .cm-content`);
  await app.press("Control+End");
  await app.type(`${FV} .cm-content`, text);
}

scenario("Datei bearbeiten: aus dem Diff öffnen, speichern, speichern und stagen", "main", async (t) => {
  const repo = makeTextRepo();
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    const file = "src/bericht.txt";
    await clickUnstaged(app, file);
    await app.click(await button(app, DIFF, "Edit file"));
    await fileReady(app, file);
    assertEqual(await center(app, tabId), { kind: "file", path: file, sha: null, mode: "edit" }, "“Edit file” opens the editor");
    assertEqual(await attr(app, FV, "data-mode"), "edit", "edit mode");
    assertEqual(await textOf(app, `${FV} [data-editable]`), "editable", "badge “editable”");
    const before = repo.read(file).toString("utf8");
    assertEqual(`${await editorText(app)}`, before.replace(/\n$/, "\n").split("\n").join("\n"), "the editor shows the file");

    await typeAtEnd(app, "Nachtrag: Böen über 20 m/s");
    await eventually(app, () => attr(app, FV, "data-dirty-state"), "dirty", "unsaved after typing");
    assertEqual(repo.read(file).toString("utf8"), before, "nothing written before saving");
    await t.shot("file-edit-unsaved");
    await app.press("Control+s");
    await eventually(app, () => attr(app, FV, "data-dirty-state"), "clean", "clean after Ctrl+S");
    const saved = `${before}Nachtrag: Böen über 20 m/s`;
    assertEqual(repo.read(file).toString("utf8"), saved, "Ctrl+S writes the file byte-exact (UTF-8)");
    assertEqual(repo.git("status", "--porcelain", "--", file), "M src/bericht.txt", "git: modified, not staged");

    // Save and stage.
    await app.press("Enter");
    await app.type(`${FV} .cm-content`, "Zweiter Nachtrag");
    await eventually(app, () => attr(app, FV, "data-dirty-state"), "dirty", "unsaved again");
    await app.click(await button(app, FV, "Save and stage"));
    await eventually(app, () => repo.git("diff", "--cached", "--name-only"), file, "“Save and stage”: the file is staged");
    const staged = repo.gitRaw(["cat-file", "blob", `:${file}`]).toString("utf8");
    assertEqual(staged, `${saved}\nZweiter Nachtrag`, "index blob equals the saved text");
    assertEqual(repo.git("diff", "--name-only"), "", "nothing left unstaged");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

const REPORT_MD = [
  "# Messbericht März",
  "",
  "Die Station lief **ohne Ausfall**. Details auf der [Projektseite](https://example.org/projekt).",
  "",
  "## Sensoren",
  "",
  "- Temperatur",
  "- Luftfeuchte",
  "- Regen",
  "",
  "| Sensor | Wert |",
  "| --- | --- |",
  "| Temperatur | 4,2 °C |",
  "| Regen | 12 mm |",
  "",
  "```python",
  "print(\"hallo\")",
  "```",
  "",
].join("\n");

scenario("Markdown-Vorschau: Ansicht, Quelltext, Vorschau beim Bearbeiten", "main", async (t) => {
  const repo = makeDiffRepo();
  repo.write("docs/bericht.md", REPORT_MD);
  repo.commit("Bericht");
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    await store(app, "openFile", tabId, "docs/bericht.md", null, "view");
    await fileReady(app, "docs/bericht.md");
    const article = `${FV} article[data-md-preview]`;
    await app.waitFor(article, 10_000);
    assertEqual(await textOf(app, `${FV} [aria-label="Markdown"] [data-state="on"]`), "Preview", "viewing opens in the preview");
    const found = await app.exec((sel) => {
      const root = document.querySelector(sel);
      return {
        h1: root.querySelector("h1")?.textContent,
        h2: [...root.querySelectorAll("h2")].map((h) => h.textContent),
        items: [...root.querySelectorAll("li")].map((li) => li.textContent),
        strong: root.querySelector("strong")?.textContent,
        cells: [...root.querySelectorAll("table td")].map((td) => td.textContent),
        code: root.querySelector("pre code")?.textContent?.trim(),
      };
    }, article);
    assertEqual(found, { h1: "Messbericht März", h2: ["Sensoren"], items: ["Temperatur", "Luftfeuchte", "Regen"], strong: "ohne Ausfall", cells: ["Temperatur", "4,2 °C", "Regen", "12 mm"], code: 'print("hallo")' }, "the preview renders headings, list, bold text, table and code");
    await t.shot("markdown-preview");

    // Source: the file as text.
    await app.click(`${FV} [aria-label="Markdown"] [data-value="source"]`);
    await app.waitFor(`${FV} .cm-content`, 10_000);
    assertEqual(await editorText(app), REPORT_MD.replace(/\n$/, "\n").split("\n").join("\n"), "the source shows the file unchanged");
    assertEqual(await count(app, article), 0, "no preview in source mode");

    // Editing: the preview shows the unsaved text.
    await store(app, "openFile", tabId, "docs/bericht.md", null, "edit");
    await fileReady(app, "docs/bericht.md");
    assertEqual(await textOf(app, `${FV} [aria-label="Markdown"] [data-state="on"]`), "Source", "editing opens in the source");
    await typeAtEnd(app, "\n## Nachtrag\n");
    await app.click(`${FV} [aria-label="Markdown"] [data-value="preview"]`);
    await eventually(app, () => app.exec((sel) => [...(document.querySelector(sel)?.querySelectorAll("h2") ?? [])].map((h) => h.textContent), article), ["Sensoren", "Nachtrag"], "the preview shows the unsaved heading");
    assertEqual(await attr(app, FV, "data-dirty-state"), "dirty", "still unsaved");
    assertEqual(repo.read("docs/bericht.md").toString("utf8"), REPORT_MD, "the file on disk is unchanged");
    assertEqual(repo.git("status", "--porcelain"), "", "git status clean");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Markdown mit Schadinhalt: entschärft, Link nur nach Bestätigung", "edge", async (t) => {
  const repo = makeDiffRepo();
  repo.write("docs/boese.md", EVIL_MD);
  repo.commit("Bericht mit Fallen");
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    await app.exec(() => {
      window.__evil = undefined;
      window.__gcTestOpened = [];
    });
    await store(app, "openFile", tabId, "docs/boese.md", null, "view");
    await fileReady(app, "docs/boese.md");
    const article = `${FV} article[data-md-preview]`;
    await app.waitFor(article, 10_000);
    const found = await app.exec((sel) => {
      const root = document.querySelector(sel);
      return {
        scripts: root.querySelectorAll("script").length,
        frames: root.querySelectorAll("iframe, object, embed, form").length,
        images: root.querySelectorAll("img").length,
        styled: root.querySelectorAll("[style]").length,
        handlers: [...root.querySelectorAll("*")].filter((element) => [...element.attributes].some((attribute) => attribute.name.startsWith("on"))).length,
        hrefs: root.querySelectorAll("[href], [src]").length,
        evil: window.__evil ?? null,
      };
    }, article);
    assertEqual(found, { scripts: 0, frames: 0, images: 0, styled: 0, handlers: 0, hrefs: 0, evil: null }, "no scripts, frames, images, styles, handlers or targets");
    assertIncludes(await textOf(app, `${FV} [data-md-note]`), "2 images not loaded", "note about blocked images");

    const link = await app.waitFor(`${article} [data-href="https://example.org/projekt"]`, 5_000);
    await link.click();
    const dialog = await app.waitFor('[role="dialog"]', 5_000, { message: "confirmation dialog" });
    assertIncludes(await dialog.text(), "https://example.org/projekt", "the confirmation names the target");
    assertEqual(await app.exec(() => window.__gcTestOpened), [], "nothing opened before confirming");
    await t.shot("markdown-link-confirm");
    await app.press("Escape");
    await app.waitFor(async () => (await count(app, '[role="dialog"]')) === 0, 5_000, { message: "Esc closes the confirmation" });
    assertEqual(await app.exec(() => [window.__gcTestOpened, window.__evil ?? null]), [[], null], "cancelled: nothing opened, no script ran");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Editor: ungespeichert schließen fragt nach, Abbrechen und Nicht speichern", "edge", async (t) => {
  const repo = makeDiffRepo();
  repo.write("notizen/plan.txt", "erste Zeile\n");
  repo.commit("Plan");
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    await store(app, "openFile", tabId, "notizen/plan.txt", null, "edit");
    await fileReady(app, "notizen/plan.txt");
    await typeAtEnd(app, "nicht gespeichert");
    await eventually(app, () => attr(app, FV, "data-dirty-state"), "dirty", "unsaved");
    await app.click(`${FV} [data-back]`);
    const dialog = await app.waitFor('[role="dialog"], [role="alertdialog"]', 5_000, { message: "save question" });
    assertIncludes(await dialog.text(), "Save changes to “plan.txt”?", "the dialog asks about this file");
    await t.shot("editor-close-unsaved");
    await app.press("Escape");
    await app.waitFor(async () => (await count(app, '[role="dialog"], [role="alertdialog"]')) === 0, 5_000, { message: "Esc cancels" });
    assertEqual((await center(app, tabId))?.kind, "file", "cancel: the editor stays open");
    assertEqual(await attr(app, FV, "data-dirty-state"), "dirty", "the text is still unsaved");
    await app.click(`${FV} [data-back]`);
    await app.waitFor('[role="dialog"], [role="alertdialog"]', 5_000);
    await app.click({ text: "Don’t save", within: '[role="dialog"], [role="alertdialog"]' });
    await app.waitFor(async () => (await center(app, tabId))?.kind !== "file", 5_000, { message: "closed without saving" });
    assertEqual(repo.read("notizen/plan.txt").toString("utf8"), "erste Zeile\n", "the file is unchanged");
    assertEqual(repo.git("status", "--porcelain"), "", "git status clean");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// =============================================================================================
// File history (1.0)
// =============================================================================================

const STATION = [
  '"""Steuerung der Wetterstation."""',
  "",
  "INTERVALL_MINUTEN = 10",
  "",
  "def messen(sensor):",
  "    return sensor.lesen()",
  "",
  "def speichern(werte, pfad):",
  '    with open(pfad, "a") as datei:',
  "        for wert in werte:",
  '            datei.write(f"{wert}\\n")',
  "",
];

/** src/station.py over four commits by three authors, and a renamed file. */
function makeHistoryRepo() {
  const repo = makeDiffRepo("station");
  const shas = {};
  repo.write("src/station.py", STATION.join("\n"));
  shas.first = repo.commit("Steuerung der Station angelegt", PEOPLE.lena);
  const v2 = [...STATION];
  v2[2] = "INTERVALL_MINUTEN = 5";
  repo.write("src/station.py", v2.join("\n"));
  shas.interval = repo.commit("Messintervall auf fünf Minuten", PEOPLE.jonas);
  const v3 = [...v2];
  v3.splice(7, 0, "def pruefen(wert):", "    return wert is not None and wert > -999", "");
  repo.write("src/station.py", v3.join("\n"));
  shas.check = repo.commit("Ausfallwerte beim Messen verwerfen", PEOPLE.aylin);
  const v4 = [...v3];
  v4[v4.length - 2] = '            datei.write(f"{wert:.1f}\\n")';
  repo.write("src/station.py", v4.join("\n"));
  shas.format = repo.commit("Werte mit einer Nachkommastelle speichern", PEOPLE.lena);
  // Rename with history.
  repo.write("docs/messplan.md", "# Messplan\n\nDie Station misst alle zehn Minuten.\n\n- Temperatur\n- Luftfeuchte\n");
  shas.planCreated = repo.commit("Messplan entworfen", PEOPLE.aylin);
  repo.git("mv", "docs/messplan.md", "docs/messkonzept.md");
  repo.write("docs/messkonzept.md", "# Messkonzept\n\nDie Station misst alle zehn Minuten.\n\n- Temperatur\n- Luftfeuchte\n");
  shas.planRenamed = repo.commit("Messplan heißt jetzt Messkonzept", PEOPLE.jonas);
  repo.write("docs/messkonzept.md", "# Messkonzept\n\nDie Station misst alle fünf Minuten.\n\n- Temperatur\n- Luftfeuchte\n- Wind\n");
  shas.planAfter = repo.commit("Messkonzept: Wind ergänzt", PEOPLE.lena);
  return { repo, shas };
}

const FH = '[data-screen="file-history"]';
const historyReady = (app, file) => ready(app, "file-history", `History of ${file}`, "[data-history-list], [data-history-empty]");
const historyRows = (app) =>
  app.exec((sel) =>
    [...document.querySelectorAll(`${sel} [data-history-list] [role="option"]`)].map((item) => ({
      index: Number(item.dataset.index),
      sha: item.dataset.sha,
      status: item.dataset.status,
      added: item.dataset.added ?? null,
      removed: item.dataset.removed ?? null,
      selected: item.getAttribute("aria-selected") === "true",
      text: item.innerText.replace(/\s+/g, " ").trim(),
    })),
    FH,
  );
const selectedIndex = async (app) => (await historyRows(app)).find((row) => row.selected)?.index ?? null;
const historyDiffText = (app) => textOf(app, `${FH} [data-screen="diff"]`);

scenario("Dateiverlauf: mit Strg+Umschalt+H öffnen, Liste wie git log, Diff der Auswahl", "main", async (t) => {
  const { repo } = makeHistoryRepo();
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    const file = "src/station.py";
    await store(app, "openFile", tabId, file, null, "view");
    await fileReady(app, file);
    await app.click(`${FV} .cm-content`);
    await app.press("Control+Shift+H");
    await historyReady(app, file);
    t.step("Ctrl+Shift+H opened the history");
    const log = followLog(repo, file);
    const rows = await historyRows(app);
    assertEqual(rows.map((row) => row.sha), log.map((entry) => entry.sha), "commits and order like git log --follow");
    assertEqual(rows.map((row) => [row.added, row.removed]), log.map((entry) => [entry.added, entry.removed]), "+/- like git log --numstat");
    assertEqual(rows.map((row) => row.status), ["modified", "modified", "modified", "added"], "status per commit");
    for (const [index, entry] of log.entries()) {
      assert(rows[index].text.includes(entry.summary) && rows[index].text.includes(entry.author) && rows[index].text.includes(short(entry.sha)), `row ${index + 1} shows summary, author, short SHA (${rows[index].text})`);
    }
    assertEqual(await textOf(app, `${FH} [data-history-count]`), "4 commits", "counter");
    assertEqual(await selectedIndex(app), 0, "newest commit selected");
    await app.waitFor(async () => (await historyDiffText(app))?.includes('datei.write(f"{wert:.1f}\\n")'), 10_000, { message: "diff of the newest commit" });

    const second = (await app.$$(`${FH} [data-history-list] [role="option"]`))[1];
    await second.click();
    await eventually(app, () => selectedIndex(app), 1, "click selects the second commit");
    await app.waitFor(async () => (await historyDiffText(app))?.includes("def pruefen(wert):"), 10_000, { message: "the diff follows the selection" });
    assertIncludes(await textOf(app, `${FH} [data-history-actions]`), short(log[1].sha), "the bar above the diff names the commit");
    await t.shot("file-history");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Dateiverlauf: Umbenennung, Tastatur, Version ansehen, wiederherstellen und rückgängig", "edge", async (t) => {
  const { repo, shas } = makeHistoryRepo();
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);

    // Rename: the history goes back past the rename.
    await store(app, "openHistory", tabId, "docs/messkonzept.md");
    await historyReady(app, "docs/messkonzept.md");
    const renamed = await historyRows(app);
    assertEqual(renamed.map((row) => row.sha), followLog(repo, "docs/messkonzept.md").map((entry) => entry.sha), "follows the rename like git log --follow");
    assertEqual(renamed.length, 3, "three commits including the one before the rename");
    assertIncludes(renamed[1].status, "renamed", "the rename commit is marked");
    assertIncludes(await textOf(app, FH), "messplan.md", "the old name is shown");

    // Keyboard: arrows, Enter opens the version, Esc goes back.
    const file = "src/station.py";
    await store(app, "openHistory", tabId, file);
    await historyReady(app, file);
    await app.waitFor(() => app.exec((sel) => document.activeElement?.closest(sel) !== null && document.activeElement?.getAttribute("role") === "listbox", FH), 5_000, { message: "the list has focus" });
    await app.press("ArrowDown", "ArrowDown");
    await eventually(app, () => selectedIndex(app), 2, "↓ ↓ selects the third entry");
    await app.press("Enter");
    await fileReady(app, file);
    assertEqual(await center(app, tabId), { kind: "file", path: file, sha: shas.interval, mode: "view" }, "Enter opens this version for viewing");
    assertEqual(await editorText(app), repo.gitRaw(["show", `${shas.interval}:${file}`]).toString("utf8"), "the version equals git show");
    await app.press("Escape");
    await historyReady(app, file);
    assertEqual(await selectedIndex(app), 2, "Esc returns, the selection is kept");

    // Restore the oldest version and undo.
    const head = repo.read(file);
    const first = repo.gitRaw(["show", `${shas.first}:${file}`]);
    const rows = await app.$$(`${FH} [data-history-list] [role="option"]`);
    await rows[3].click();
    await eventually(app, () => selectedIndex(app), 3, "oldest commit selected");
    await app.click(`${FH} [data-history-actions] [data-action="restore"]`);
    await app.waitFor(() => repo.read(file).equals(first), 10_000, { message: "the file has the content of the first commit" });
    assertEqual(repo.git("diff", "--cached", "--name-only"), file, "the restored version is staged");
    assert(repo.gitRaw(["cat-file", "blob", `:${file}`]).equals(first), "index blob is the old version");
    const toast = await app.waitFor(() => app.byText(`to the state of ${short(shas.first)}`, { exact: false }), 10_000, { message: "message names the version" });
    assert(toast, "restore message");
    await t.shot("file-history-restored");
    await app.click({ text: "Undo", within: "[data-toast]" });
    await app.waitFor(() => repo.read(file).equals(head), 10_000, { message: "undo brings the previous content back" });
    await app.waitFor(() => repo.git("status", "--porcelain") === "", 10_000, { message: "git status clean after undo" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Dateiverlauf: neue Datei ohne Verlauf, unbekannter Pfad", "edge", async (t) => {
  const { repo } = makeHistoryRepo();
  repo.write("notizen/frisch.txt", "noch nie committet\n");
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    await store(app, "openHistory", tabId, "notizen/frisch.txt");
    await historyReady(app, "notizen/frisch.txt");
    const empty = await app.waitFor(`${FH} [data-history-empty="new"]`, 10_000);
    const text = await empty.text();
    assert(text.includes("No history yet") && text.includes("frisch.txt"), `new file: empty state (${text})`);
    assertEqual(await count(app, `${FH} [data-history-count]`), 0, "no counter");
    await app.click({ text: "View file", within: `${FH} [data-history-empty]` });
    await fileReady(app, "notizen/frisch.txt");
    assertEqual(await center(app, tabId), { kind: "file", path: "notizen/frisch.txt", sha: null, mode: "view" }, "“View file” opens the file");

    await store(app, "openHistory", tabId, "gibt/es/nicht.txt");
    await historyReady(app, "gibt/es/nicht.txt");
    assertIncludes(await textOf(app, `${FH} [data-history-empty="unknown"]`), "No commits for this file", "unknown path: own empty state");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// =============================================================================================
// Blame (1.0)
// =============================================================================================

const BL = '[data-screen="blame"]';
const blameReady = (app, file, stand = "worktree") =>
  app
    .waitFor(
      () =>
        app.exec(
          (sel, label, wanted) => {
            const root = document.querySelector(sel);
            return root?.getAttribute("aria-label") === label && root.getAttribute("data-stand") === wanted && !root.querySelector("[data-loading]") && Boolean(root.querySelector(".cm-content, [data-notice]"));
          },
          BL,
          `Blame of ${file}`,
          stand,
        ),
      30_000,
      { message: `blame of ${file} at ${stand}` },
    )
    .then(() => app.settle());
const shownBlocks = (app) =>
  app.exec((sel) =>
    [...document.querySelectorAll(`${sel} .gc-blame-cell[data-start]`)].map((cell) => ({
      sha: cell.dataset.sha,
      uncommitted: cell.hasAttribute("data-uncommitted"),
      avatar: cell.querySelector(".gc-blame-avatar")?.textContent ?? "",
      summary: cell.querySelector(".gc-blame-summary")?.textContent ?? "",
    })),
    BL,
  );
const initials = (name) => {
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
};

scenario("Blame: aus der Dateiansicht öffnen, Blöcke und Legende wie git blame", "main", async (t) => {
  const { repo } = makeHistoryRepo();
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    const file = "src/station.py";
    await store(app, "openFile", tabId, file, null, "view");
    await fileReady(app, file);
    await app.click(await button(app, FV, "Blame"));
    await blameReady(app, file);
    assertEqual(await center(app, tabId), { kind: "blame", path: file, sha: null }, "the header button opens blame");

    const expected = blamePorcelain(repo, file);
    const blocks = blameBlocks(expected);
    const shown = await shownBlocks(app);
    assertEqual(shown.map((block) => block.sha), blocks.map((block) => block.sha), "blocks like git blame --porcelain");
    for (const [index, block] of blocks.entries()) {
      assertEqual([shown[index].summary, shown[index].avatar], [block.summary, initials(block.author)], `block ${index + 1}: summary and initials`);
    }
    const text = await app.exec((sel) => [...document.querySelectorAll(`${sel} .cm-content .cm-line`)].map((line) => line.textContent).join("\n"), BL);
    assertEqual(text, repo.read(file).toString("utf8").replace(/\n$/, ""), "the text equals the file (without the empty last line)");
    const legend = await textOf(app, `${BL} [data-blame-legend]`);
    assertIncludes(legend, `${expected.length} lines · ${new Set(expected.map((line) => line.sha)).size} commits`, "legend: lines and commits");
    for (const person of [PEOPLE.lena, PEOPLE.jonas, PEOPLE.aylin]) assertIncludes(legend, person.name, `legend names ${person.name}`);
    await t.shot("blame");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Blame: nicht committete Zeilen, vorheriger Stand mit P, leere und binäre Datei", "edge", async (t) => {
  const { repo, shas } = makeHistoryRepo();
  repo.write("text/leer.txt", "");
  repo.write("daten/roh.bin", Buffer.from([0, 159, 146, 150, 0, 1, 2]));
  repo.commit("Leere und binäre Datei");
  const file = "src/station.py";
  repo.write(file, repo.read(file).toString("utf8").replace("INTERVALL_MINUTEN = 5", "INTERVALL_MINUTEN = 2\nNEU = True"));
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    await store(app, "openBlame", tabId, file, null);
    await blameReady(app, file);
    const expected = blamePorcelain(repo, file);
    assertEqual(expected.filter((line) => line.sha === ZERO).length, 2, "precondition: two uncommitted lines");
    const shown = await shownBlocks(app);
    assertEqual(shown.map((block) => (block.uncommitted ? ZERO : block.sha)), blameBlocks(expected).map((block) => block.sha), "blocks incl. the uncommitted one like git blame");
    assertEqual(shown.filter((block) => block.uncommitted).map((block) => block.summary), ["Not committed yet"], "uncommitted block is labelled");

    // P on line 3 (uncommitted): blame of HEAD; then Esc back.
    await app.click(`${BL} .cm-content`);
    await app.press("Control+Home", "ArrowDown", "ArrowDown");
    await app.waitFor(async () => Number(await attr(app, `${BL} [data-blame-info] [data-blame-line]`, "data-blame-line")) === 3, 5_000, { message: "cursor on line 3" });
    await app.press("p");
    await blameReady(app, file, "HEAD");
    const line3 = await app.exec((sel) => document.querySelectorAll(`${sel} .cm-content .cm-line`)[2]?.textContent, BL);
    assertEqual(line3, "INTERVALL_MINUTEN = 5", "P shows the committed state");
    // P again in HEAD on line 3: the parent of the interval commit.
    await app.press("p");
    await blameReady(app, file, `${shas.interval}^`);
    assertEqual(await app.exec((sel) => document.querySelectorAll(`${sel} .cm-content .cm-line`)[2]?.textContent, BL), "INTERVALL_MINUTEN = 10", "P again: the value before the interval commit");
    await t.shot("blame-parent-state");
    await app.press("Escape");
    await blameReady(app, file, "HEAD");
    await app.press("Escape");
    await blameReady(app, file);

    await store(app, "openBlame", tabId, "text/leer.txt", null);
    await blameReady(app, "text/leer.txt");
    assertIncludes(await textOf(app, `${BL} [data-notice="empty"]`), "Empty file", "empty file notice");
    await store(app, "openBlame", tabId, "daten/roh.bin", null);
    await blameReady(app, "daten/roh.bin");
    assertIncludes(await textOf(app, `${BL} [data-notice="unsupported"]`), "binary", "binary file: no blame, with reason");
    assertEqual(repo.git("diff", "--cached", "--name-only"), "", "blame changes nothing in Git");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// =============================================================================================
// Image diff, four modes (1.1)
// =============================================================================================

const IMG = `${DIFF} [data-diff-kind="image"]`;
const imageMode = (app) => attr(app, IMG, "data-image-mode");
const SUN = { x: 30, y: 10, w: 10, h: 6 };

/** Same changed-pixel rule as the app: opaque images aligned top left. */
function expectedChanged(before, after) {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  let changed = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = x < before.width && y < before.height ? before.pixel(x, y) : null;
      const b = x < after.width && y < after.height ? after.pixel(x, y) : null;
      if (!a || !b || a.join() !== b.join()) changed++;
    }
  return changed;
}
const scene = (width, height, sun = null) => ({
  width,
  height,
  pixel: (x, y) => (sun && x >= sun.x && x < sun.x + sun.w && y >= sun.y && y < sun.y + sun.h ? [250, 200, 40] : y < height * 0.6 ? [110, 170, 230] : [80, 150, 80]),
});

async function chooseImageMode(app, mode) {
  await app.click(`${IMG} [data-value="${mode}"]`);
  await eventually(app, () => imageMode(app), mode, `image mode ${mode}`);
}

scenario("Bild-Diff: nebeneinander, Wischen, Zwiebelschale, Differenz", "main", async (t) => {
  const repo = makeDiffRepo("bilder");
  repo.write("docs/station.png", landscape(120, 80));
  repo.commit("Bild der Station");
  repo.write("docs/station.png", landscape(120, 80, { sun: SUN }));
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    await clickUnstaged(app, "docs/station.png");
    await app.waitFor(IMG, 10_000);

    // Side by side (default).
    assertEqual(await imageMode(app), "side", "default: side by side");
    assertEqual(await count(app, `${IMG} [data-image-pane]`), 2, "two panes");
    await app.waitFor(() => app.exec((sel) => [...document.querySelectorAll(`${sel} [data-image-pane] img`)].every((img) => img.complete && img.naturalWidth === 120), IMG), 10_000, { message: "both versions loaded (120 px)" });
    const caption = await textOf(app, `${IMG} [data-image-pane="new"] figcaption`);
    assertIncludes(caption, "120 × 80 px", "caption shows the size");
    await t.shot("image-diff-side-by-side");

    // Swipe: slider moves with the keyboard.
    await chooseImageMode(app, "swipe");
    assertEqual(await count(app, `${IMG} [data-image-stack="swipe"]`), 1, "versions stacked");
    const slider = await app.waitFor(`${IMG} [role="slider"]`, 5_000);
    assertEqual(await slider.attr("aria-label"), "Position of the divider", "slider label");
    const start = Number(await slider.attr("aria-valuenow"));
    await app.exec((element) => element.focus(), slider);
    await app.press("ArrowRight", "ArrowRight");
    await app.waitFor(async () => Number(await slider.attr("aria-valuenow")) > start, 5_000, { message: "ArrowRight moves the divider" });
    assertEqual(await count(app, `${IMG} [data-image-size-note]`), 0, "same size: no note");
    await t.shot("image-diff-swipe");

    // Onion skin.
    await chooseImageMode(app, "onion");
    const opacity = await app.waitFor(`${IMG} [role="slider"]`, 5_000);
    assertEqual(await opacity.attr("aria-label"), "Opacity of the new version", "opacity slider");
    await app.exec((element) => element.focus(), opacity);
    const startOpacity = Number(await opacity.attr("aria-valuenow"));
    await app.press("ArrowLeft");
    await app.waitFor(async () => Number(await opacity.attr("aria-valuenow")) < startOpacity, 5_000, { message: "ArrowLeft lowers the opacity" });
    await t.shot("image-diff-onion");

    // Difference: exactly the sun's pixels changed.
    await chooseImageMode(app, "difference");
    await eventually(app, () => attr(app, `${IMG} [data-image-difference]`, "data-image-difference"), "ready", "pixels compared");
    const changed = expectedChanged(scene(120, 80), scene(120, 80, SUN));
    assertEqual(changed, 60, "precondition: 60 pixels differ");
    assertMatch(await textOf(app, `${IMG} [data-image-difference]`), /^60 pixels changed \(/, "the app counts 60 changed pixels");
    // The canvas: as large as the image, exactly the sun's pixels in the highlight colour.
    const painted = await app.exec((sel, sun) => {
      const canvas = document.querySelector(`${sel} canvas`);
      if (!canvas) return null;
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const at = (x, y) => [...data.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3)].join();
      const highlight = at(sun.x, sun.y);
      let same = 0;
      for (let index = 0; index < data.length; index += 4) if ([data[index], data[index + 1], data[index + 2]].join() === highlight) same++;
      return { width: canvas.width, height: canvas.height, highlighted: same, outside: at(0, 0) !== highlight };
    }, IMG, SUN);
    assertEqual(painted, { width: 120, height: 80, highlighted: 60, outside: true }, "difference canvas highlights exactly the 60 changed pixels");
    await t.shot("image-diff-difference");

    // Remembered across a reload.
    await app.reload();
    await app.waitFor(() => app.exec((tab) => Boolean(document.querySelector(`[data-tab-id="${tab}"]`)), tabId), 30_000);
    await app.settle();
    await clickUnstaged(app, "docs/station.png");
    await app.waitFor(IMG, 10_000);
    assertEqual(await imageMode(app), "difference", "the last mode is remembered");
    assertEqual(repo.git("diff", "--cached", "--name-only"), "", "nothing staged");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Bild-Diff: verschiedene Größen, gleiche Pixel, neues und gelöschtes Bild, SVG", "edge", async (t) => {
  const repo = makeDiffRepo("bilder");
  repo.write("docs/station.png", landscape(120, 80));
  repo.write("docs/gleich.png", landscape(40, 30));
  repo.write("docs/alt.png", landscape(32, 32));
  repo.commit("Bilder");
  repo.write("docs/station.png", landscape(140, 90));
  // Same pixels, other bytes (another compression level): Git sees a change, the pixels do not.
  const same = scene(40, 30);
  repo.write("docs/gleich.png", pngFrom(40, 30, same.pixel, { level: 1 }));
  repo.write("docs/neu.png", landscape(48, 48, { sun: { x: 5, y: 5, w: 4, h: 4 } }));
  repo.remove("docs/alt.png");
  repo.write("docs/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#3b82f6"/></svg>\n');
  try {
    const app = await t.launch(LIGHT);
    await app.openRepo(repo.path);

    // Different sizes: note and the difference over the union.
    await clickUnstaged(app, "docs/station.png");
    await app.waitFor(IMG, 10_000);
    await chooseImageMode(app, "swipe");
    const note = await app.waitFor(`${IMG} [data-image-size-note]`, 10_000, { message: "size note" });
    assertIncludes(await note.text(), "120 × 80 px → 140 × 90 px", "the note names both sizes");
    await chooseImageMode(app, "difference");
    await eventually(app, () => attr(app, `${IMG} [data-image-difference]`, "data-image-difference"), "ready", "pixels compared");
    const changed = expectedChanged(scene(120, 80), scene(140, 90));
    const shownCount = Number((await textOf(app, `${IMG} [data-image-difference]`)).match(/^([\d,]+) pixels? changed/)?.[1]?.replace(/,/g, ""));
    assertEqual(shownCount, changed, "changed pixels over both sizes");
    await t.shot("image-diff-size-differs");

    // Same pixels: "No pixel differs".
    await clickUnstaged(app, "docs/gleich.png");
    await app.waitFor(IMG, 10_000);
    assertEqual(await imageMode(app), "difference", "the chosen mode carries over to the next image");
    await eventually(app, () => attr(app, `${IMG} [data-image-difference]`, "data-image-difference"), "ready", "pixels compared");
    assertEqual(await textOf(app, `${IMG} [data-image-difference]`), "No pixel differs.", "identical pixels");
    assert(repo.git("status", "--porcelain", "--", "docs/gleich.png").startsWith("M"), "Git does see a byte change");

    // New image: only side by side; the other modes are disabled.
    await clickUnstaged(app, "docs/neu.png");
    await app.waitFor(IMG, 10_000);
    assertEqual(await imageMode(app), "side", "new image: side by side");
    const disabled = await app.exec((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} [data-value]`)].map((item) => [item.dataset.value, item.disabled || item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")])), IMG);
    assertEqual(disabled, { side: false, swipe: true, onion: true, difference: true }, "only side by side is offered");
    assertIncludes(await textOf(app, `${IMG} [data-image-pane="old"]`), "This image did not exist before.", "left: did not exist");

    // Deleted image: the new side says so.
    await clickUnstaged(app, "docs/alt.png");
    await app.waitFor(IMG, 10_000);
    assertIncludes(await textOf(app, `${IMG} [data-image-pane="new"]`), "The image was deleted.", "right: deleted");

    // SVG through <img>, never inline.
    await clickUnstaged(app, "docs/logo.svg");
    const svg = await app.waitFor(() => app.exec((sel) => {
      const img = document.querySelector(`${sel} [data-image-pane="new"] img`);
      return img ? { src: img.getAttribute("src").slice(0, 26), inline: document.querySelectorAll(`${sel} svg circle`).length } : null;
    }, IMG), 10_000, { message: "SVG shown as image diff" });
    assertEqual(svg, { src: "data:image/svg+xml;base64,", inline: 0 }, "SVG as data URL in <img>, not inline");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
