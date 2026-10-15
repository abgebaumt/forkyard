/**
 * Interactive rebase, conflict tool (1.0) and rebase with --update-refs and undo (1.1) in the real
 * app over WebDriver, against real Git repositories in temp folders. Every flow is verified in the
 * UI and in the repository (git log, refs, files, .git/rebase-merge).
 *
 *   node scripts/e2e-wd/features/rebase.mjs
 *   E2E_WD_ONLY="update-refs" node scripts/e2e-wd/features/rebase.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { makeRebaseRepo, REBASE_FILE, rebaseParts, resultLines, toText } from "../../e2e/screens/conflict-lib.mjs";
import { center, closeToasts, nudge, parkMouse, planRepo, rebaseRows, rightClick, selection, stackRepo, toasts, waitToast } from "../fixtures/rebase.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const REBASE = '[data-screen="rebase"]';
const GRAPH = '[data-screen="commit-graph"]';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };

/** JSON with sorted object keys (key order from the page is not stable). */
const stable = (value) => JSON.stringify(value, (key, inner) => (inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));

/** Waits until `read()` deep-equals `expected` (or the predicate holds); returns the value. */
async function eventually(app, read, expected, message, timeout = 15_000) {
  const matches = (value) => (typeof expected === "function" ? expected(value) : stable(value) === stable(expected));
  let last;
  try {
    return await app.waitFor(async () => {
      last = await read();
      return matches(last) ? { value: last } : null;
    }, timeout, { message });
  } catch {
    throw new Error(`${message}: expected ${typeof expected === "function" ? "condition" : JSON.stringify(expected)}, got ${JSON.stringify(last)?.slice(0, 400)}`);
  }
}

const shasInList = async (app) => (await rebaseRows(app)).map((row) => row.sha);
const actionsInList = async (app) => (await rebaseRows(app)).map((row) => row.action);
const listFocused = (app) => app.exec((root) => document.activeElement?.getAttribute("role") === "listbox" && Boolean(document.activeElement.closest(root)), REBASE);
const startDisabled = (app) => app.exec((root) => document.querySelector(`${root} button[data-action="start"]`)?.getAttribute("aria-disabled") === "true", REBASE);
const footer = (app) => app.exec((root) => document.querySelector(`${root} [data-plan-summary]`)?.innerText ?? "", REBASE);
const dialogTitle = (app) => app.exec(() => document.querySelector('[role="dialog"], [role="alertdialog"]')?.querySelector("h1, h2, h3, [data-dialog-title]")?.innerText?.trim() ?? null);
const dialogCount = (app) => app.exec(() => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length);
const focusedText = (app) => app.exec(() => document.activeElement?.textContent?.trim() ?? null);
const previewState = (app) => app.exec((root) => document.querySelector(`${root} [data-conflict-preview]`)?.getAttribute("data-conflict-preview") ?? null, REBASE);
const undoButton = (app) => app.exec(() => [...document.querySelectorAll('[role="toolbar"][aria-label="Repository actions"] button')].find((button) => /^Undo/.test(button.getAttribute("aria-label") ?? button.innerText)) ?? null);

async function openGraph(app, repo) {
  const opened = await app.openRepo(repo.path);
  await app.waitFor(`${GRAPH}[data-state="ready"]`, 60_000);
  return opened;
}

/** Right-click on the graph row of `sha`, then the menu entry with this label (prefix). */
async function graphMenu(app, sha, label) {
  const row = await app.waitFor(`${GRAPH} [data-row-id="${sha}"]`, 20_000);
  await rightClick(app, row);
  const item = await app.waitFor(() => app.exec((text) => [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.innerText.trim().startsWith(text)) ?? null, label), 10_000, { message: `menu entry "${label}"` });
  await app.click(item);
}

async function waitList(app, count) {
  await app.waitFor(`${REBASE} [role="listbox"]`, 30_000);
  await eventually(app, async () => (await rebaseRows(app)).length, count, `the list shows ${count} commits`);
}

async function clickUndo(app) {
  await closeToasts(app);
  const button = await app.waitFor(async () => {
    const found = await undoButton(app);
    return found && (await found.attr("aria-disabled")) !== "true" ? found : null;
  }, 15_000, { message: "undo available" });
  await app.click(button);
}

// ---------------------------------------------------------------------------
// Interactive rebase (1.0)
// ---------------------------------------------------------------------------

scenario("Interaktiver Rebase: aus dem Graph öffnen, verschieben, squashen, droppen, starten, Undo", "main", async (t) => {
  const { repo, base, c } = planRepo("rebase-haupt");
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);

    await graphMenu(app, base, "Interactive rebase from here");
    await eventually(app, () => center(app, tabId), { kind: "rebase", base, mode: "interactive", shas: [] }, "context menu opens the rebase tool with this base");
    await waitList(app, 5);
    assertEqual(await shasInList(app), [c.c1, c.c2, c.c3, c.c4, c.c5], "oldest commit at the top");
    await eventually(app, () => listFocused(app), true, "focus in the list");
    assert(await startDisabled(app), "unchanged plan: start disabled");
    t.step("tool open with 5 commits, focus in the list");

    // c4 squashed into c3, c5 dropped, c2 moved to the top.
    await app.press("ArrowDown", "ArrowDown", "ArrowDown", "s");
    await eventually(app, () => actionsInList(app), ["pick", "pick", "pick", "squash", "pick"], "S squashes c4");
    await app.press("End", "d");
    await eventually(app, () => actionsInList(app), ["pick", "pick", "pick", "squash", "drop"], "D drops c5");
    await app.press("Home", "ArrowDown", "Alt+ArrowUp");
    await eventually(app, () => shasInList(app), [c.c2, c.c1, c.c3, c.c4, c.c5], "Alt+Up moves c2 up");
    assertMatch(await footer(app), /5 commits → 3 commits/, "footer names the result");
    assert(!(await startDisabled(app)), "changed plan: start enabled");
    await eventually(app, () => previewState(app), "clean", "live conflict preview: no conflicts expected", 20_000);
    await parkMouse(app);
    await t.shot("interaktiver-rebase-plan");

    // Ctrl+Enter starts; dropping asks first, focus on Cancel; Tab to the red button, Enter.
    await app.press("Control+Enter");
    await eventually(app, () => dialogTitle(app), "Drop 1 commit and start the rebase?", "confirmation for the dropped commit");
    assertEqual(await focusedText(app), "Cancel", "focus on Cancel");
    await app.press("Tab");
    assertEqual(await focusedText(app), "Start rebase", "Tab reaches Start rebase");
    await app.press("Enter");
    await waitToast(app, /Interactive rebase complete/, "success");
    await eventually(app, () => center(app, tabId).then((v) => v.kind), "graph", "back to the graph");

    assertEqual(repo.subjects("main..HEAD"), ["Tippfehler im README", "Sensorliste ergänzt", "Zwischenstand Export"], "git log: reordered, squashed, dropped");
    assertEqual(repo.git("show", "HEAD:export.txt"), "fertig", "git: squashed commit has the state of c4");
    assert(!repo.exists("debug.txt"), "debug.txt gone with c5");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "thema/plan", "branch stays checked out");
    assertEqual(repo.git("status", "--porcelain"), "", "clean");
    assertMatch(repo.git("for-each-ref", "--format=%(refname)", "refs/forkyard/undo/"), /refs\/forkyard\/undo\//, "backup ref under refs/forkyard/undo/");
    t.step("git: order, squash, drop verified");

    await clickUndo(app);
    await eventually(app, () => repo.tip("thema/plan"), c.c5, "undo restores the old tip");
    assertEqual(repo.subjects("main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README", "Zwischenstand Export", "Export fertig", "Debug-Ausgabe"], "git log after undo");
    await eventually(app, async () => repo.exists("debug.txt"), true, "debug.txt is back");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

/** Opens the command palette, runs the entry with this title and picks `branch` in the branch picker. */
async function paletteRebase(app, title, branch) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[role="dialog"] input', 10_000);
  await app.type(input, title);
  await app.waitFor(() => app.exec((text) => [...document.querySelectorAll('[role="dialog"] [role="option"]')].find((option) => option.innerText.includes(text)) ?? null, title), 10_000, { message: `palette entry "${title}"` });
  const option = await app.exec((text) => [...document.querySelectorAll('[role="dialog"] [role="option"]')].find((entry) => entry.innerText.includes(text)), title);
  await app.click(option);
  // Branch picker (list dialog): choose the branch by its row.
  const row = await app.waitFor(
    () => app.exec((name) => [...document.querySelectorAll('[role="dialog"] [role="option"]')].find((entry) => entry.innerText.split("\n")[0].trim() === name) ?? null, branch),
    10_000,
    { message: `branch "${branch}" in the picker` },
  );
  await app.click(row);
  const confirm = await app.exec(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog ? [...dialog.querySelectorAll("footer button, button")].reverse().find((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true" && /Rebase|Next/.test(button.innerText)) ?? null : null;
  });
  if (confirm) await app.click(confirm);
}

scenario("Interaktiver Rebase: Bestätigung abbrechen, Plan bleibt, Esc schließt ohne Änderung (Tastatur, über die Palette)", "edge", async (t) => {
  const { repo, c } = planRepo("rebase-abbruch");
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await paletteRebase(app, "Interactively rebase current branch onto", "main");
    await eventually(app, () => center(app, tabId).then((v) => [v.kind, v.base, v.mode]), ["rebase", "main", "interactive"], "palette opens the rebase tool onto main");
    await waitList(app, 5);
    await eventually(app, () => listFocused(app), true, "focus in the list");
    await app.press("End", "d");
    await eventually(app, () => actionsInList(app), ["pick", "pick", "pick", "pick", "drop"], "D drops c5");
    await app.press("Control+Enter");
    await eventually(app, () => dialogTitle(app), "Drop 1 commit and start the rebase?", "confirmation");
    const text = await app.exec(() => document.querySelector('[role="dialog"], [role="alertdialog"]').innerText.replace(/\s+/g, " "));
    assertIncludes(text, "Debug-Ausgabe", "confirmation names the dropped commit");
    assertIncludes(text, c.c5.slice(0, 7), "confirmation names its sha");
    assertEqual(await focusedText(app), "Cancel", "focus on Cancel");
    await parkMouse(app);
    await t.shot("bestaetigung-drop");
    await app.press("Enter");
    await eventually(app, () => dialogCount(app), 0, "Enter on Cancel closes the confirmation");
    await sleep(400);
    assertEqual(repo.tip(), c.c5, "git: nothing rewritten after Cancel");
    assertEqual((await center(app, tabId)).kind, "rebase", "tool stays open");
    assertEqual(await actionsInList(app), ["pick", "pick", "pick", "pick", "drop"], "edited plan is kept");
    // Esc closes the tool, nothing changes.
    await app.exec((root) => document.querySelector(`${root} [role="listbox"]`)?.focus(), REBASE);
    await app.press("Escape");
    await eventually(app, () => center(app, tabId).then((v) => v.kind), "graph", "Esc closes the tool");
    assertEqual(repo.tip(), c.c5, "git: nothing changed after Esc");
    assert(!repo.rebaseRunning(), "no rebase running");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Interaktiver Rebase: ungültige Pläne sperren Start mit Grund, Zurücksetzen stellt her", "edge", async (t) => {
  const { repo, base, c } = planRepo("rebase-ungueltig");
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await graphMenu(app, base, "Interactive rebase from here");
    await waitList(app, 5);
    await eventually(app, () => listFocused(app), true, "focus in the list");
    // Squash on the topmost row: no commit to squash into.
    await app.press("Home", "s");
    await eventually(app, () => startDisabled(app), true, "first row squash: start disabled");
    assertMatch(await footer(app), /topmost remaining commit/, "footer gives the reason");
    assertEqual(await app.exec((root) => document.querySelectorAll(`${root} [role="option"][data-index="0"] [data-row-problem]`).length, REBASE), 1, "the row carries a notice");
    await parkMouse(app);
    await t.shot("ungueltiger-plan");
    // Drop everything.
    for (let i = 0; i < 5; i++) await app.press(i === 0 ? "Home" : "ArrowDown", "d");
    await eventually(app, () => actionsInList(app), ["drop", "drop", "drop", "drop", "drop"], "all dropped");
    await eventually(app, () => footer(app), (value) => /At least one commit must stay/.test(value), "all dropped: reason");
    assert(await startDisabled(app), "all dropped: start disabled");
    // Ctrl+Enter must not start anything.
    await app.press("Control+Enter");
    await sleep(500);
    assertEqual(await dialogCount(app), 0, "no confirmation for an invalid plan");
    assertEqual(repo.tip(), c.c5, "git: nothing rewritten");
    // Reset.
    await app.click(`${REBASE} button[data-action="reset"]`);
    await eventually(app, () => actionsInList(app), ["pick", "pick", "pick", "pick", "pick"], "reset restores the actions");
    assertEqual(await shasInList(app), [c.c1, c.c2, c.c3, c.c4, c.c5], "and the order");
    assertEqual(await app.exec((root) => document.querySelector(`${root} button[data-action="reset"]`)?.getAttribute("aria-disabled"), REBASE), "true", "reset disabled afterwards");
    void tabId;
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Interaktiver Rebase: Umformulieren mit mehrzeiliger Nachricht und Umlauten", "edge", async (t) => {
  const { repo, base, c } = planRepo("rebase-reword");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await graphMenu(app, base, "Interactive rebase from here");
    await waitList(app, 5);
    await eventually(app, () => listFocused(app), true, "focus in the list");
    await app.press("ArrowDown", "r");
    await eventually(app, () => dialogTitle(app), "Reword commit", "reword dialog");
    const summary = await app.waitFor('[role="dialog"] input', 5000);
    assertEqual(await summary.prop("value"), "Tippfehler im README", "prefilled with the old summary");
    await app.press("Control+a", ..."README: Tippfehler korrigiert – Größenangaben".split(""));
    const description = await app.waitFor('[role="dialog"] textarea', 5000);
    await app.click(description);
    await app.press(..."Zeile eins mit Ümläuten".split(""), "Enter", ..."Zweite Zeile: äöüß".split(""));
    await app.press("Control+Enter");
    await eventually(app, () => dialogCount(app), 0, "dialog closes");
    await eventually(app, () => actionsInList(app), ["pick", "reword", "pick", "pick", "pick"], "c2 is reword");
    assertEqual((await rebaseRows(app))[1].summary, "README: Tippfehler korrigiert – Größenangaben", "row shows the new summary");
    await eventually(app, () => listFocused(app), true, "focus back in the list");
    await app.press("Control+Enter");
    await waitToast(app, /Interactive rebase complete/, "success");
    const [, second] = repo.git("rev-list", "--reverse", "main..HEAD").split("\n");
    assertEqual(repo.git("log", "-1", "--format=%B", second).replace(/\s+$/, ""), "README: Tippfehler korrigiert – Größenangaben\n\nZeile eins mit Ümläuten\nZweite Zeile: äöüß", "git: message byte-exact");
    assertEqual(repo.subjects("main..HEAD").length, 5, "still five commits");
    assert(repo.tip() !== c.c5, "branch rewritten");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

const banner = (app) =>
  app.exec(() => [...document.querySelectorAll('[data-screen="commit-panel"] [role="alert"], [data-screen="commit-panel"] [role="status"]')].find((item) => /Rebase of/.test(item.innerText)) ?? null);
const bannerText = async (app) => {
  const found = await banner(app);
  return found ? (await app.exec((el) => el.innerText, found)).replace(/\s+/g, " ") : "";
};
async function bannerButton(app, label) {
  return app.waitFor(async () => {
    const found = await banner(app);
    if (!found) return null;
    return app.exec((root, text) => [...root.querySelectorAll("button")].find((button) => button.innerText.trim() === text && button.getAttribute("aria-disabled") !== "true" && !button.disabled) ?? null, found, label);
  }, 15_000, { message: `banner button "${label}"` });
}

scenario("Interaktiver Rebase mit Konflikt: Schritt n von m im Commit-Panel, Rebase abbrechen", "edge", async (t) => {
  const { repo, base, c } = planRepo("rebase-konflikt");
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await graphMenu(app, base, "Interactive rebase from here");
    await waitList(app, 5);
    await eventually(app, () => listFocused(app), true, "focus in the list");
    // c4 before c3: c4 changes a file that does not exist yet.
    await app.press("End", "ArrowUp", "Alt+ArrowUp");
    await eventually(app, () => shasInList(app), [c.c1, c.c2, c.c4, c.c3, c.c5], "c4 before c3");
    await eventually(app, () => previewState(app), "conflicts", "live preview predicts the conflict", 20_000);
    await app.press("Control+Enter");
    await waitToast(app, /Interactive rebase: conflict in one file/, "warning");
    await eventually(app, () => center(app, tabId).then((v) => v.kind), "graph", "tool closes on conflict");
    await eventually(app, () => selection(app, tabId).then((v) => v.kind), "wip", "local changes selected");
    await eventually(app, () => bannerText(app), (text) => /step 3 of 5/.test(text), "commit panel: step 3 of 5");
    assert(repo.rebaseRunning(), "git: rebase-merge exists");
    assertEqual(repo.subjects("main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README"], "git: first two steps applied");
    await closeToasts(app);
    await parkMouse(app);
    await t.shot("rebase-konflikt-schritt");
    await app.click(await bannerButton(app, "Abort rebase"));
    await eventually(app, () => dialogTitle(app), "Abort rebase?", "abort confirmation");
    const confirm = await app.exec(() => [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((button) => button.innerText.trim() === "Abort rebase"));
    await app.click(confirm);
    await waitToast(app, /Aborted the rebase/, "success");
    await eventually(app, async () => repo.rebaseRunning(), false, "git: no rebase running");
    assertEqual(repo.tip("thema/plan"), c.c5, "git: branch unchanged");
    assertEqual(repo.git("status", "--porcelain"), "", "git: clean");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Interaktiver Rebase abgelehnt: lokale Änderungen, Stashen öffnet den Plan", "edge", async (t) => {
  const { repo, base } = planRepo("rebase-dirty");
  try {
    repo.write("export.txt", "lokal geändert\n");
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await graphMenu(app, base, "Interactive rebase from here");
    await eventually(app, () => app.exec((root) => document.querySelector(`${root} [data-state-panel]`)?.getAttribute("data-state-panel") ?? null, REBASE), "refused-dirty_worktree", "dirty worktree: refused");
    assertEqual(await app.$(`${REBASE} [role="listbox"]`), null, "no list while refused");
    await parkMouse(app);
    await t.shot("abgelehnt-lokale-aenderungen");
    await app.click({ text: "Stash changes", within: REBASE });
    await waitList(app, 5);
    assertEqual(repo.git("stash", "list").split("\n").filter(Boolean).length, 1, "git: changes in the stash");
    assertEqual(repo.git("status", "--porcelain"), "", "git: clean after the stash");
    await app.press("Escape");
    await eventually(app, () => center(app, tabId).then((v) => v.kind), "graph", "Esc closes");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Conflict tool (1.0)
// ---------------------------------------------------------------------------

const CONFLICT = '[data-screen="conflict"]';
const resultText = (app) => app.exec(() => document.querySelector("[data-result-editor]")?.__gcView?.state.doc.toString() ?? null);
const counter = (app) => app.exec((root) => {
  const element = document.querySelector(`${root} [data-conflict-counter]`);
  return element ? { resolved: Number(element.dataset.resolved), total: Number(element.dataset.total) } : null;
}, CONFLICT);
const saveBlocked = (app) => app.exec((root) => document.querySelector(`${root} button[data-action="save"]`)?.getAttribute("aria-disabled") === "true", CONFLICT);
const saveReason = (app) => app.exec((root) => document.querySelector(`${root} [data-save-reason]`)?.innerText ?? "", CONFLICT);
const head = (app, conflict, side) => app.waitFor(`${CONFLICT} [data-sides] [data-conflict-head="${conflict}"][data-side="${side}"]`, 10_000);
const blockState = (app, conflict, side = "ours") =>
  app.exec((root, index, which) => document.querySelector(`${root} [data-sides] [data-conflict-head="${index}"][data-side="${which}"] [data-block-state]`)?.getAttribute("data-block-state") ?? null, CONFLICT, conflict, side);

async function openConflictFromList(app, file) {
  const row = await app.waitFor(`[data-section="conflicts"] [data-row-key="${file}"]`, 20_000);
  await app.click(row);
  await app.waitFor(() => app.exec((root, label) => {
    const el = document.querySelector(root);
    return el?.getAttribute("aria-label") === label && el.getAttribute("data-conflict-state") !== "loading";
  }, CONFLICT, `Resolve conflict: ${file}`), 60_000, { message: `conflict tool for ${file}` });
  await app.settle();
}

async function verifySaved(repo, file, expected, what) {
  assertEqual(String(repo.read(file)), expected, `${what}: file in the working directory`);
  assertEqual(repo.git("ls-files", "-u", "--", file), "", `${what}: git ls-files -u empty`);
  assertEqual(repo.git("cat-file", "blob", `:0:${file}`) + "\n", expected, `${what}: staged blob`);
}

scenario("Konflikt-Tool beim Rebase: Seite wählen, speichern und stagen, Rebase fortsetzen", "main", async (t) => {
  const fixture = makeRebaseRepo();
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, fixture);
    await openConflictFromList(app, REBASE_FILE);
    assertEqual((await center(app, tabId)).kind, "conflict", "the tool opens in the center");
    assertEqual(await counter(app), { resolved: 0, total: 1 }, "counter 0 of 1");
    assert(await saveBlocked(app), "save blocked while a conflict is open");
    assertMatch(await saveReason(app), /1 conflict still open/, "reason shown");
    const headings = await app.exec((root) => [...document.querySelectorAll(`${root} h3`)].map((h) => h.innerText.replace(/\s+/g, " ").trim()), CONFLICT);
    assert(headings.some((h) => /Target/.test(h) && h.includes("main")), `heading names the target: ${JSON.stringify(headings)}`);
    assert(headings.some((h) => /Your commit/.test(h)), `heading names "your commit": ${JSON.stringify(headings)}`);
    assertMatch(await resultText(app), /<<<<<<< /, "result starts with markers");

    // Take "your commit" (theirs in a rebase).
    await app.click(await head(app, 0, "theirs"));
    await eventually(app, () => blockState(app, 0), "theirs", "conflict: your commit chosen");
    await eventually(app, () => counter(app), { resolved: 1, total: 1 }, "counter 1 of 1");
    assert(!(await saveBlocked(app)), "save possible");
    const expected = toText(resultLines(rebaseParts, (_, part) => part.theirs));
    assertEqual(await resultText(app), expected, "result: lines of your commit, no markers");
    await parkMouse(app);
    await t.shot("konflikt-tool-rebase");

    await app.click(`${CONFLICT} button[data-action="save"]`);
    await waitToast(app, /resolved and staged/, "success");
    await verifySaved(fixture, REBASE_FILE, expected, "saved");
    t.step("saved: file, staged blob, ls-files -u verified");

    await closeToasts(app);
    await app.click(await bannerButton(app, "Continue rebase"));
    await eventually(app, async () => rebaseRunningAt(fixture.path), false, "git: rebase finished", 30_000);
    assertEqual(fixture.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/nachtmodus", "branch checked out again");
    assertEqual(fixture.git("log", "--format=%s", "-2").split("\n"), ["Nachts seltener messen", "Temperatur alle 5 Minuten"], "git log: commit replayed onto main");
    assertEqual(fixture.read(REBASE_FILE).toString("utf8"), expected, "file after the rebase");
    assertEqual(fixture.git("status", "--porcelain"), "", "clean");
    await t.noConsoleErrors(app);
  } finally {
    fixture.cleanup();
  }
});

const rebaseRunningAt = (repoPath) => ["rebase-merge", "rebase-apply"].some((name) => fs.existsSync(path.join(repoPath, ".git", name)));

scenario("Konflikt-Tool: beide Seiten in Reihenfolge, Handänderung im Ergebnis, Schließen ohne Speichern fragt nach", "edge", async (t) => {
  const fixture = makeRebaseRepo();
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, fixture);
    await openConflictFromList(app, REBASE_FILE);
    const [part] = rebaseParts.filter((item) => item.kind === "conflict");
    // Your commit first, then the target: both, in the order of choice.
    await app.click(await head(app, 0, "theirs"));
    await app.click(await head(app, 0, "ours"));
    await eventually(app, () => blockState(app, 0), "both", "both sides chosen");
    assertIncludes(await resultText(app), `${[...part.theirs, ...part.ours].join("\n")}\n`, "result: your commit first, then the target");
    // Deselect again: markers come back, saving blocked.
    await app.click(await head(app, 0, "theirs"));
    await app.click(await head(app, 0, "ours"));
    await eventually(app, () => blockState(app, 0), "open", "deselected: open again");
    assert(await saveBlocked(app), "save blocked again");
    // Choose the target, then type in the result by hand.
    await app.click(await head(app, 0, "ours"));
    await eventually(app, () => blockState(app, 0), "ours", "target chosen");
    const line = await app.waitFor(() => app.exec(() => [...document.querySelectorAll("[data-result-editor] .cm-line")].find((el) => el.innerText.includes("alle 5 Minuten")) ?? null), 5000, { message: "result line" });
    await app.click(line);
    await app.press("End");
    await app.press(..."  (geprüft)".split(""));
    await eventually(app, () => blockState(app, 0), "manual", "edited by hand");
    const expected = toText(resultLines(rebaseParts, () => ["- Temperatur: alle 5 Minuten  (geprüft)"]));
    await eventually(app, () => resultText(app), expected, "result contains the hand edit");
    await parkMouse(app);
    await t.shot("konflikt-tool-handaenderung");

    // Closing with an unsaved solution asks: "Continue later" keeps it, "Discard" drops it.
    await app.click(`${CONFLICT} [data-conflict-header] button[aria-label="Close conflict tool"]`);
    await eventually(app, () => dialogTitle(app), "Leave “messplan.md” without saving?", "leave dialog");
    await app.click({ text: "Continue later", within: '[role="dialog"], [role="alertdialog"]' });
    await eventually(app, () => center(app, tabId).then((v) => v.kind), (kind) => kind !== "conflict", "tool closes, solution kept");
    assertEqual(fixture.git("ls-files", "-u", "--", REBASE_FILE).length > 0, true, "git: still in conflict (nothing saved)");
    await openConflictFromList(app, REBASE_FILE);
    await eventually(app, () => resultText(app), expected, "reopened: the started solution is restored");
    // Save with Ctrl+S.
    await app.exec(() => document.querySelector("[data-result-editor] .cm-content")?.focus());
    await app.press("Control+s");
    await waitToast(app, /resolved and staged/, "success");
    await verifySaved(fixture, REBASE_FILE, expected, "Ctrl+S saved the hand edit");
    await t.noConsoleErrors(app);
  } finally {
    fixture.cleanup();
  }
});

scenario("Konflikt-Tool: Datei im Terminal gelöst – Hinweis und zurück zu den Änderungen", "edge", async (t) => {
  const fixture = makeRebaseRepo();
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, fixture);
    await openConflictFromList(app, REBASE_FILE);
    fixture.git("checkout", "--theirs", "--", REBASE_FILE);
    fixture.git("add", "--", REBASE_FILE);
    await nudge(app);
    await app.waitFor(`${CONFLICT} [data-notice="gone"]`, 20_000);
    await parkMouse(app);
    await t.shot("konflikt-geloest-im-terminal");
    await app.click({ text: "Back to changes", within: CONFLICT });
    await eventually(app, () => center(app, tabId).then((v) => v.kind), "graph", "back to the graph");
    await eventually(app, () => bannerText(app), (text) => /Rebase of/.test(text), "banner still offers to continue");
    await t.noConsoleErrors(app);
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// --update-refs with undo (1.1)
// ---------------------------------------------------------------------------

/** Right-click on a branch in the sidebar, then the entry. */
async function sidebarMenu(app, branch, label) {
  const row = await app.waitFor(
    () => app.exec((name) => [...document.querySelectorAll('[data-screen="sidebar"] [data-row-id]')].find((el) => el.innerText.split("\n")[0].trim() === name) ?? null, branch),
    15_000,
    { message: `sidebar row ${branch}` },
  );
  await rightClick(app, row);
  const item = await app.waitFor(() => app.exec((text) => [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.innerText.trim().startsWith(text)) ?? null, label), 10_000, { message: `menu entry "${label}"` });
  await app.click(item);
}

const preflightCheckbox = () => '[role="dialog"] [data-screen="preflight"] button[role="checkbox"]';
const dialogText = (app) => app.exec(() => (document.querySelector('[role="dialog"], [role="alertdialog"]')?.innerText ?? "").replace(/\s+/g, " "));
/** Commits of `ref` since main, oldest first, as subjects. */
const ancestry = (repo, ref) => repo.subjects(`main..${ref}`);

scenario("--update-refs: Rebase über das Branch-Menü zieht den abhängigen Branch mit, ein Undo setzt beide zurück", "main", async (t) => {
  const { repo, t2, t3, m1 } = stackRepo("update-refs-menue");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await sidebarMenu(app, "main", "Rebase “thema” onto “main”");
    await eventually(app, () => dialogTitle(app), "Rebase thema onto main?", "preflight dialog");
    const box = await app.waitFor(preflightCheckbox(), 10_000);
    assertEqual(await box.attr("data-state"), "unchecked", "checkbox off by default");
    assertIncludes(await dialogText(app), "Move dependent branches along", "label");
    assertIncludes(await dialogText(app), "Also rebases: teil. Undo resets them together.", "hint names the dependent branch");
    await app.click(box);
    assertEqual(await box.attr("data-state"), "checked", "checkbox on");
    await parkMouse(app);
    await t.shot("update-refs-dialog");
    await app.click('[role="dialog"] button[data-action="preflight-run"]');
    await waitToast(app, /Rebase complete/, "success");

    assertEqual(repo.git("merge-base", "teil", "main"), m1, "git: teil now sits on main");
    assertEqual(repo.tip("thema~1"), repo.tip("teil"), "git: thema still stacked on teil");
    assertEqual(ancestry(repo, "thema"), ["Teil A angelegt", "Teil B angelegt", "Thema C auf Teil"], "git: thema has all three commits on main");
    assertEqual(ancestry(repo, "teil"), ["Teil A angelegt", "Teil B angelegt"], "git: teil has its two commits");
    assert(repo.tip("teil") !== t2, "teil was rewritten");
    const backups = repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/forkyard/undo/").split("\n");
    assert(backups.some((line) => line.endsWith(` ${t2}`)), `undo backup of teil (${t2}) under refs/forkyard/undo/: ${backups.join(" | ")}`);
    assert(backups.some((line) => line.endsWith(` ${t3}`)), "undo backup of thema");
    t.step("git: both branches rebased, backups present");

    await clickUndo(app);
    await eventually(app, async () => [repo.tip("thema"), repo.tip("teil")], [t3, t2], "one undo resets thema and teil");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "thema", "thema checked out");
    assertEqual(repo.git("status", "--porcelain"), "", "clean");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("--update-refs: Checkbox aus (Standard) – abhängiger Branch bleibt stehen", "edge", async (t) => {
  const { repo, t2, t3, m1 } = stackRepo("update-refs-aus");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await paletteRebase(app, "Rebase current branch onto", "main");
    await eventually(app, () => dialogTitle(app), "Rebase thema onto main?", "preflight dialog");
    await app.waitFor(preflightCheckbox(), 10_000);
    await app.click('[role="dialog"] button[data-action="preflight-run"]');
    await waitToast(app, /Rebase complete/, "success");
    assertEqual(repo.tip("teil"), t2, "git: teil unchanged");
    assertEqual(repo.git("merge-base", "thema", "main"), m1, "git: thema on main");
    assert(repo.tip("thema") !== t3, "thema rewritten");
    await clickUndo(app);
    await eventually(app, async () => repo.tip("thema"), t3, "undo resets thema");
    assertEqual(repo.tip("teil"), t2, "teil still unchanged");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("--update-refs: Abbrechen im Dialog (Esc) ändert nichts", "edge", async (t) => {
  const { repo, t2, t3 } = stackRepo("update-refs-esc");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await sidebarMenu(app, "main", "Rebase “thema” onto “main”");
    await app.waitFor(preflightCheckbox(), 10_000);
    await app.click(preflightCheckbox());
    await app.press("Escape");
    await eventually(app, () => dialogCount(app), 0, "Esc closes the dialog");
    await sleep(600);
    assertEqual([repo.tip("thema"), repo.tip("teil")], [t3, t2], "git: nothing moved");
    assert(!repo.rebaseRunning(), "no rebase running");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("--update-refs: ohne abhängige Branches kein Dialog, keine Checkbox im Rebase-Tool", "edge", async (t) => {
  const { repo, base } = stackRepo("update-refs-ohne");
  try {
    repo.git("branch", "-D", "teil");
    const before = repo.tip("thema");
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await graphMenu(app, base, "Interactive rebase from here");
    await waitList(app, 3);
    await eventually(app, () => previewState(app), "clean", "preview done", 20_000);
    assertEqual(await app.$(`${REBASE} [data-rebase-checks] button[role="checkbox"]`), null, "no update-refs checkbox without dependents");
    await app.press("Escape");
    await eventually(app, () => center(app, tabId).then((v) => v.kind), "graph", "closed");
    await sidebarMenu(app, "main", "Rebase “thema” onto “main”");
    await waitToast(app, /Rebase complete/, "success");
    assertEqual(await dialogCount(app), 0, "no preflight dialog appeared");
    assert(repo.tip("thema") !== before, "git: thema rebased directly");
    assertEqual(repo.git("merge-base", "thema", "main"), repo.tip("main"), "git: on main");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("--update-refs: Branch in einem anderen Worktree wird nicht angeboten und nicht bewegt", "edge", async (t) => {
  const { repo, t2 } = stackRepo("update-refs-worktree");
  try {
    const wt = `${repo.root}/teil-wt`;
    repo.git("worktree", "add", "-q", wt, "teil");
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await sidebarMenu(app, "main", "Rebase “thema” onto “main”");
    await waitToast(app, /Rebase complete/, "success");
    assertEqual(await dialogCount(app), 0, "no dialog: the only candidate is checked out elsewhere");
    assertEqual(repo.tip("teil"), t2, "git: teil (other worktree) not moved");
    assertEqual(repo.gitIn(wt, "status", "--porcelain"), "", "the other worktree stays clean");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("--update-refs im interaktiven Rebase: Checkbox listet Branches, Drop – abhängiger Branch folgt, Undo setzt alle zurück", "main", async (t) => {
  const { repo, base, t2, t3 } = stackRepo("update-refs-interaktiv");
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await graphMenu(app, base, "Interactive rebase from here");
    await waitList(app, 3);
    const box = await app.waitFor(`${REBASE} [data-rebase-checks] button[role="checkbox"]`, 10_000);
    const checks = await app.exec((root) => document.querySelector(`${root} [data-rebase-checks]`).innerText.replace(/\s+/g, " "), REBASE);
    assertIncludes(checks, "Move dependent branches along", "checkbox label");
    assertIncludes(checks, "Also rebases: teil.", "hint lists teil");
    assertEqual(await box.attr("data-state"), "unchecked", "off by default");
    await app.click(box);
    assertEqual(await box.attr("data-state"), "checked", "on");
    // Drop t1 ("Teil A angelegt").
    await app.exec((root) => document.querySelector(`${root} [role="listbox"]`)?.focus(), REBASE);
    await app.press("Home", "d");
    await eventually(app, () => actionsInList(app), ["drop", "pick", "pick"], "t1 dropped");
    await eventually(app, () => previewState(app), "clean", "preview done", 20_000);
    await parkMouse(app);
    await t.shot("update-refs-interaktiv");
    await app.click(`${REBASE} button[data-action="start"]`);
    await eventually(app, () => dialogTitle(app), "Drop 1 commit and start the rebase?", "drop confirmation");
    await app.click({ text: "Start rebase", within: '[role="dialog"], [role="alertdialog"]' });
    await waitToast(app, /Interactive rebase complete/, "success");
    await eventually(app, () => center(app, tabId).then((v) => v.kind), "graph", "back to the graph");

    assertEqual(repo.subjects(`${base}..thema`), ["Teil B angelegt", "Thema C auf Teil"], "git: thema without t1");
    assertEqual(repo.subjects(`${base}..teil`), ["Teil B angelegt"], "git: teil followed (rewritten t2, without t1)");
    assertEqual(repo.tip("thema~1"), repo.tip("teil"), "git: teil is the parent of thema");
    assert(!repo.git("ls-tree", "-r", "--name-only", "teil").includes("teil/a.txt"), "git: teil has no a.txt");

    await clickUndo(app);
    await eventually(app, async () => [repo.tip("thema"), repo.tip("teil")], [t3, t2], "undo resets thema and teil together");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("--update-refs mit Konflikt: im Konflikt-Tool lösen, fortsetzen, abhängiger Branch wird nachgezogen, Undo", "edge", async (t) => {
  const { repo, t2, t3 } = stackRepo("update-refs-konflikt");
  try {
    // main also creates thema/c.txt: the third step (t3) conflicts (both added).
    repo.git("checkout", "-q", "main");
    const m2 = repo.commit("thema/c.txt", "c von main\n", "Main legt c an");
    repo.git("checkout", "-q", "thema");
    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await sidebarMenu(app, "main", "Rebase “thema” onto “main”");
    await eventually(app, () => dialogTitle(app), "Rebase thema onto main?", "preflight dialog");
    await app.waitFor(preflightCheckbox(), 10_000);
    await eventually(app, () => dialogText(app), (text) => /Expected conflicts in 1 file/.test(text) && text.includes("thema/c.txt"), "dialog names the expected conflict");
    await app.click(preflightCheckbox());
    await parkMouse(app);
    await t.shot("update-refs-konflikt-dialog");
    await app.click('[role="dialog"] button[data-action="preflight-run"]');
    await waitToast(app, /Rebase: conflict in one file/, "warning");
    assert(repo.rebaseRunning(), "git: rebase stopped");
    // Three commits, Git stops at the third. The update-ref line in Git's todo must not count as a step.
    const stepText = (await eventually(app, () => bannerText(app), (text) => /step \d+ of \d+/.test(text), "banner shows the step")).value.match(/step \d+ of \d+/)[0];
    t.step(`banner: ${stepText}`);
    await closeToasts(app);
    await parkMouse(app);
    await t.shot("update-refs-konflikt-schritt");

    await openConflictFromList(app, "thema/c.txt");
    await app.click(await head(app, 0, "theirs"));
    await eventually(app, () => counter(app).then((value) => value && value.resolved === value.total), true, "conflict resolved");
    await app.click(`${CONFLICT} button[data-action="save"]`);
    await waitToast(app, /resolved and staged/, "success");
    assertEqual(repo.read("thema/c.txt"), "c\n", "file: your commit's version");
    await closeToasts(app);
    await app.click(await bannerButton(app, "Continue rebase"));
    await eventually(app, async () => repo.rebaseRunning(), false, "git: rebase finished", 30_000);
    void tabId;

    assertEqual(repo.git("merge-base", "teil", "main"), m2, "git: teil was moved onto main when the rebase finished");
    assertEqual(repo.tip("thema~1"), repo.tip("teil"), "git: thema stacked on teil");
    assertEqual(repo.git("show", "thema:thema/c.txt"), "c", "git: resolution committed");

    await clickUndo(app);
    await eventually(app, async () => [repo.tip("thema"), repo.tip("teil")], [t3, t2], "undo resets thema and teil");
    await t.noConsoleErrors(app);
    // Checked last so that the rest of the flow is still verified.
    assertEqual(stepText, "step 3 of 3", "commit panel step counter for 3 commits (counts Git's update-ref todo line as a step)");
  } finally {
    repo.cleanup();
  }
});
