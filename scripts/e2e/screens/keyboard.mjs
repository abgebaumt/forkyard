/**
 * The core loop with the keyboard ONLY – in the real app against a real repository with a remote.
 *
 *   node scripts/e2e/screens/keyboard.mjs            everything, images to target/e2e/shots/keyboard-*.png
 *   node scripts/e2e/screens/keyboard.mjs --show     window visible
 *   node scripts/e2e/screens/keyboard.mjs --no-shots without images
 *
 * Rule of this script: the UI only receives keys (page.keyboard). No click, no element.focus(),
 * no reaching into the store to trigger anything. Reading goes through the DOM, the store and –
 * for every result – git in the repository itself. The script changes files from outside (like an
 * editor); the system folder dialog cannot be remote-controlled and gets its answer via app.pick().
 *
 * Flow: start → open repository → graph, select commit, details, diff, back → stage and commit →
 * create branch → push → check out and merge → stash and pop → undo and redo → search. Plus:
 * switching areas (F6, Shift+F6, Alt+1/2/3 – also from text fields and with collapsed panels),
 * focus return after dialogs, Esc despite a toast, segmented controls with arrow keys, tabs.
 * After EVERY step: focus is visibly on an element – never on <body>.
 * Fails on console errors.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { assertNoConsoleErrors, createChecks, lines, storeApi } from "./commit-panel-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";
const show = process.argv.includes("--show");
const shots = !process.argv.includes("--no-shots");
const { failures, check, equal, eventually, section } = createChecks();
const SHOT_DIR = "target/e2e/shots";

const repo = makeCleanRepoWithRemote();
const git = (...args) => repo.git(...args);
/** Like git, but null instead of an exception (e.g. while a config value is still missing). */
const tryGit = (...args) => {
  try {
    return repo.git(...args);
  } catch {
    return null;
  }
};
const write = (file, content) => fs.writeFileSync(path.join(repo.path, file), content);
let app = null;

/** Where is the focus? Area, role, label – and whether it is visible. */
const focusInfo = (page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { area: "body", role: null, label: "", visible: false, rowId: null, tag: "BODY" };
    const area = element.closest('[role="dialog"], [role="alertdialog"]')
      ? "dialog"
      : element.closest('[role="menu"]')
        ? "menu"
        : element.closest('[data-area="left"], [data-rail="left"]')
          ? "left"
          : element.closest('[data-area="center"], [data-area="manage"]')
            ? "center"
            : element.closest('[data-area="right"], [data-rail="right"]')
              ? "right"
              : element.closest('[data-shell] > [role="toolbar"]')
                ? "toolbar"
                : "other";
    const style = getComputedStyle(element);
    // Visible: an outline or a shadow ring on the element itself or on its frame (text fields).
    const ring = (target) => {
      const computed = getComputedStyle(target);
      return (computed.outlineStyle !== "none" && parseFloat(computed.outlineWidth) > 0) || (computed.boxShadow !== "none" && computed.boxShadow !== "");
    };
    const framed = element.closest("label, [data-field]");
    return {
      area,
      role: element.getAttribute("role"),
      label: (element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
      visible: element.matches(":focus-visible") && (ring(element) || (framed ? ring(framed) : false) || style.caretColor !== "transparent"),
      rowId: element.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null,
      tag: element.tagName,
    };
  });

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  const { page } = app;
  const kb = page.keyboard;
  const focus = () => focusInfo(page);
  const area = async () => (await focus()).area;
  const describe = async () => {
    const info = await focus();
    return `${info.area}: ${info.tag.toLowerCase()}${info.role ? `[${info.role}]` : ""} "${info.label}"`;
  };
  /** Focus is somewhere sensible – never on <body> – and visible. */
  const focused = async (where, wanted = null) => {
    const ok = await eventually(async () => {
      const info = await focus();
      return info.area !== "body" && info.area !== "other" && (wanted === null || [].concat(wanted).includes(info.area));
    }, true, `${where}: focus is ${wanted ? `in "${[].concat(wanted).join('" or "')}"` : "on an element"} (is: ${await describe()})`, 4000);
    if (ok) check((await focus()).visible, `${where}: focus is visible (${await describe()})`);
    return ok;
  };
  const shot = async (name) => {
    if (!shots) return;
    await app.settle();
    await page.waitForTimeout(150);
    await app.screenshot(`${SHOT_DIR}/${name}.png`);
  };
  const tabs = () => app.invoke("tabs_list");
  const activeTab = async () => (await tabs()).find((tab) => tab.isActive) ?? null;
  const head = () => git("rev-parse", "HEAD");
  const branch = () => git("rev-parse", "--abbrev-ref", "HEAD");
  const status = () => lines(git("status", "--porcelain", "--untracked-files=all")).sort();
  const dialogCount = () => page.locator('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]').count();
  /** Waits until the app has noticed the change in the working directory. */
  const appSees = async (repoId, count, message) => {
    await eventually(async () => {
      const state = await page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"]) ?? null, repoId);
      return state ? state.unstaged.length + state.staged.length : null;
    }, count, message, 15_000);
    await app.settle();
  };
  /** Presses `key` until `matches` (runs in the page) holds for the focused element. */
  const pressUntil = async (key, matches, what, max = 40) => {
    const way = [];
    for (let count = 0; count <= max; count++) {
      if (await page.evaluate((source) => Boolean(new Function("el", `return (${source})(el)`)(document.activeElement)), matches.toString())) return true;
      way.push(await describe());
      await kb.press(key);
      await page.waitForTimeout(30);
    }
    console.log(`    path with ${key}: ${way.join("  →  ")}`);
    return check(false, `${what}: not reached with ${max}× ${key} (focus: ${await describe()})`);
  };
  /** Write the commit message: Alt+M into the field, type. */
  const writeMessage = async (summary, description = null) => {
    await kb.press("Alt+m");
    await eventually(async () => (await focus()).label.startsWith("Summary"), true, "Alt+M moves focus into the summary");
    await kb.press("Control+a");
    await kb.type(summary, { delay: 3 });
    if (description !== null) {
      await kb.press("Enter");
      await eventually(async () => (await focus()).tag, "TEXTAREA", "Enter jumps into the description");
      await kb.type(description, { delay: 3 });
    }
  };

  /** Esc until the diff is closed (the first Esc clears a line selection). */
  const closeDiff = async () => {
    for (let round = 0; round < 3 && (await store.center())?.kind !== "graph"; round++) {
      await kb.press("Escape");
      await page.waitForTimeout(200);
    }
    return eventually(async () => (await store.center())?.kind, "graph", "Esc closes the diff (the second one at the latest)");
  };

  let repoId = null;
  let tabId = null;
  let store = null;
  const mainStart = git("rev-parse", "main");

  // ---------------------------------------------------------------------------------------------
  await section("Start: Tab reaches the first element; Alt+O opens the repository, focus goes into the graph", async () => {
    equal((await activeTab())?.kind, "management", "the app starts with repository management");
    await kb.press("Tab");
    // The first element is the tab in the tab bar (it belongs to none of the four areas).
    const first = await focus();
    check(first.area !== "body" && first.visible, `the first Tab lands visibly on an element (${await describe()})`);
    await app.pick(repo.path);
    await kb.press("Alt+o");
    await eventually(async () => (await activeTab())?.kind, "repo", "Alt+O opens the repository in this tab", 15_000);
    const tab = await activeTab();
    repoId = tab.repoId;
    tabId = tab.id;
    store = storeApi(app, tabId);
    await app.settle();
    // While the graph loads, the area itself holds focus and then hands it to the row –
    // checked is the state in which the user continues: the row, visibly focused.
    await eventually(async () => (await focus()).role, "row", "focus is on a row of the graph");
    await focused("after opening", "center");
    await shot("keyboard-graph");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Graph: J/K and arrows select commits; Enter → details; file → diff; Esc back", async () => {
    await kb.press("Home");
    await eventually(store.selection, { kind: "wip" }, "Home: the local changes are selected");
    await kb.press("j");
    await kb.press("j");
    await eventually(store.selection, { kind: "commits", shas: [mainStart] }, "J twice: the commit of main is selected");
    equal((await focus()).rowId, mainStart, "focus is on this row");
    await kb.press("ArrowDown");
    const parent = git("rev-parse", "main~1");
    await eventually(store.selection, { kind: "commits", shas: [parent] }, "↓: the parent commit");
    // H and L follow the line: to the parent commit and back to the child.
    const grandparent = git("rev-parse", "main~2");
    await kb.press("h");
    await eventually(store.selection, { kind: "commits", shas: [grandparent] }, "H: to the parent commit");
    equal((await focus()).rowId, grandparent, "focus moves along");
    await kb.press("l");
    await eventually(store.selection, { kind: "commits", shas: [parent] }, "L: back to the child");
    await kb.press("l");
    await eventually(store.selection, { kind: "commits", shas: [mainStart] }, "L: one more child further");
    await kb.press("h");
    await eventually(store.selection, { kind: "commits", shas: [parent] }, "H: back to the parent commit");
    await kb.press("Shift+ArrowUp");
    await eventually(async () => (await store.selection())?.shas?.length, 2, "Shift+↑ extends the selection");
    await kb.press("k");
    await kb.press("j");
    await eventually(store.selection, { kind: "commits", shas: [mainStart] }, "K and J: exactly the commit of main again");
    await focused("in the graph", "center");

    await kb.press("Enter");
    await focused("Enter on the commit", "right");
    // To the commit's file list and open the file
    await pressUntil("Tab", (el) => el?.getAttribute("role") === "option" || el?.getAttribute("role") === "treeitem", "file list of the commit details");
    const file = (await focus()).label;
    await kb.press("Enter");
    await eventually(async () => (await store.center())?.kind, "diff", "Enter on the file opens the diff");
    const expected = lines(git("show", "--name-only", "--format=", mainStart));
    check(expected.includes((await store.center()).path), `the diff shows a file of this commit (${(await store.center()).path}; row: ${file})`);
    await kb.press("Alt+2");
    await focused("Alt+2 with an open diff", "center");
    check(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-screen="diff"]'))), "focus is in the diff");
    await kb.press("F7");
    await focused("F7 in the diff", "center");
    await shot("keyboard-diff");
    // In the diff, Esc first clears a selection and then closes.
    await closeDiff();
    await focused("after closing the diff");
    await kb.press("Alt+2");
    await focused("Alt+2", "center");
    equal((await focus()).rowId, mainStart, "back in the graph, focus is on the selected commit");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Stage and commit: S, U, Alt+M, Enter, Ctrl+Enter", async () => {
    write("notiz.txt", "Erste Zeile\n");
    write("zweite.txt", "Zwei\n");
    await appSees(repoId, 2, "the app notices two new files");
    await kb.press("Home");
    await eventually(store.selection, { kind: "wip" }, "Home: local changes");
    await kb.press("Enter");
    await focused("Enter on the local changes", "right");
    equal((await focus()).role, "option", "focus is on a file – not on a button in the panel header");
    await shot("keyboard-wip");

    /** Waits until the app itself shows this state (unstaged / staged) – only then is the list rebuilt. */
    const shown = async (unstaged, staged, message) => {
      await eventually(async () => {
        const state = await page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"]) ?? null, repoId);
        return state ? [state.unstaged.length, state.staged.length] : null;
      }, [unstaged, staged], message, 15_000);
      await app.settle();
    };
    await kb.press("s");
    await eventually(() => lines(git("diff", "--cached", "--name-only")), ["notiz.txt"], "S stages the file (git diff --cached)");
    await shown(1, 1, "the list shows: one unstaged, one staged");
    // The row moved to the other list; focus must not get lost.
    await focused("after S", "right");
    equal((await focus()).role, "option", "after S, focus is on a file");
    check((await focus()).label.includes("zweite.txt"), `… on the next one: zweite.txt (${(await focus()).label})`);
    await kb.press("s");
    await eventually(() => lines(git("diff", "--cached", "--name-only")), ["notiz.txt", "zweite.txt"], "S once more: both staged");
    await shown(0, 2, "the list shows: everything staged");
    await focused("after the second S", "right");
    equal((await focus()).role, "option", "when the list is empty, focus goes to the staged files");
    await kb.press("u");
    await eventually(async () => lines(git("diff", "--cached", "--name-only")).length, 1, "U unstages a file");
    await shown(1, 1, "the list shows an unstaged file again");
    await focused("after U", "right");
    equal((await focus()).role, "option", "after U, focus is on a file again");
    const staged = lines(git("diff", "--cached", "--name-only"))[0];

    // Empty message: no commit, focus goes into the field.
    const before = head();
    await kb.press("Control+Enter");
    await eventually(async () => (await focus()).label.startsWith("Summary"), true, "Ctrl+Enter without a message: focus jumps into the summary");
    equal(head(), before, "… and there is no commit");
    check((await page.locator('[data-area="right"] [role="alert"], [data-area="right"] [aria-invalid="true"]').count()) > 0, "the field reports the error");

    await writeMessage("Notiz per Tastatur angelegt", "Nur mit Tasten: S, Alt+M, Ctrl+Enter.");
    await kb.press("Control+Enter");
    await eventually(() => git("log", "-1", "--format=%s"), "Notiz per Tastatur angelegt", "Ctrl+Enter commits (git log)", 15_000);
    equal(git("log", "-1", "--format=%b").trim(), "Nur mit Tasten: S, Alt+M, Ctrl+Enter.", "the description is in the commit");
    equal(lines(git("show", "--name-only", "--format=", "HEAD")), [staged], "the commit contains exactly the staged file");
    equal(status().length, 1, "the other file is still unstaged");
    await app.settle();
    await focused("after the commit");
    // The rest in one go: stage everything and commit.
    await writeMessage("Zweite Datei");
    await kb.press("Control+Shift+Enter");
    await eventually(() => git("log", "-1", "--format=%s"), "Zweite Datei", "Ctrl+Shift+Enter stages everything and commits", 15_000);
    equal(status(), [], "the working directory is clean");
    await app.settle();
    await focused("after Ctrl+Shift+Enter");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Create branch: Ctrl+B, name, Enter – focus comes back", async () => {
    await kb.press("Alt+2");
    await focused("Alt+2", "center");
    const before = await focus();
    // Name already exists: error in the dialog, nothing happens.
    await kb.press("Control+b");
    await eventually(dialogCount, 1, "Ctrl+B opens the dialog");
    await eventually(async () => (await focus()).tag, "INPUT", "focus is in the name field");
    await kb.type("main", { delay: 3 });
    await kb.press("Enter");
    await page.waitForTimeout(400);
    equal(await dialogCount(), 1, "existing name: the dialog stays open");
    equal(branch(), "main", "… and nothing happened");
    await kb.press("Escape");
    await eventually(dialogCount, 0, "Esc closes the dialog");
    await eventually(async () => (await focus()).rowId, before.rowId, "focus is back on the row in the graph");

    await kb.press("Control+b");
    await eventually(dialogCount, 1, "Ctrl+B");
    await eventually(async () => (await focus()).tag, "INPUT", "name field");
    await kb.type("tastatur/zweig", { delay: 3 });
    await kb.press("Enter");
    await eventually(branch, "tastatur/zweig", "git: the new branch is checked out", 15_000);
    await eventually(dialogCount, 0, "the dialog is closed");
    await app.settle();
    await focused("after creating", "center");

    write("zweig.txt", "Auf dem Zweig\n");
    await appSees(repoId, 1, "new file on the branch");
    await writeMessage("Arbeit auf dem Zweig");
    await kb.press("Control+Shift+Enter");
    await eventually(() => git("log", "-1", "--format=%s"), "Arbeit auf dem Zweig", "commit on the branch", 15_000);
    await app.settle();
  });

  // ---------------------------------------------------------------------------------------------
  await section("Push: Ctrl+Shift+P – without an upstream the app asks for the remote branch", async () => {
    await kb.press("Control+Shift+P");
    await eventually(dialogCount, 1, "without an upstream: asks for the remote branch");
    await focused("in the prompt", "dialog");
    await kb.press("Enter");
    await eventually(() => lines(git("ls-remote", "--heads", "origin", "tastatur/zweig")).map((line) => line.split(/\s+/)[0]), [head()], "git ls-remote: the branch is on origin with this commit", 30_000);
    await eventually(() => tryGit("config", "--get", "branch.tastatur/zweig.merge"), "refs/heads/tastatur/zweig", "the upstream is set (git config)", 15_000);
    equal(tryGit("config", "--get", "branch.tastatur/zweig.remote"), "origin", "… to origin");
    await eventually(dialogCount, 0, "the dialog is closed");
    await app.settle();
    await focused("after the push");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Left panel: check out a branch with Enter; merge via the context menu", async () => {
    await kb.press("Alt+1");
    await focused("Alt+1", "left");
    equal((await focus()).role, "treeitem", "focus is on a row in the tree");
    await pressUntil("m", (el) => /^Local branch main\b/.test(el?.getAttribute("aria-label") ?? ""), "typing \"m\" jumps to main", 6);
    await shot("keyboard-left");
    await kb.press("Enter");
    await eventually(branch, "main", "Enter checks out main (git)", 15_000);
    await app.settle();
    await focused("after the checkout", "left");

    // main gets an own commit so that the merge is not a fast-forward.
    write("haupt.txt", "Auf main\n");
    await appSees(repoId, 1, "new file on main");
    await writeMessage("Arbeit auf main");
    await kb.press("Control+Shift+Enter");
    await eventually(() => git("log", "-1", "--format=%s"), "Arbeit auf main", "commit on main", 15_000);
    await app.settle();
    const mainBefore = head();
    const side = git("rev-parse", "tastatur/zweig");

    await kb.press("Alt+1");
    await focused("Alt+1", "left");
    await pressUntil("z", (el) => /^Local branch tastatur\/zweig\b/.test(el?.getAttribute("aria-label") ?? ""), "typing \"z\" jumps to tastatur/zweig", 6);
    await kb.press("Shift+F10");
    await eventually(async () => (await focus()).area, "menu", "Shift+F10 opens the context menu, focus is in it");
    const items = await page.locator('[role="menu"] [role="menuitem"]').allTextContents();
    check(items.some((text) => /Merge/.test(text)), `the menu offers the merge (${items.join(" | ")})`);
    await pressUntil("ArrowDown", (el) => /Merge .*tastatur\/zweig.* into .*main/.test(el?.textContent ?? ""), "entry \"Merge tastatur/zweig into main\"", 30);
    await shot("keyboard-menu");
    await kb.press("Enter");
    await eventually(() => git("rev-list", "--parents", "-1", "main").split(" ").slice(1).sort(), [mainBefore, side].sort(), "git: main has a merge commit with both parents", 20_000);
    equal(status(), [], "clean after the merge");
    await app.settle();
    await focused("after the merge");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Stash and pop: Alt+S, Alt+P – also from the text field", async () => {
    write("zwischenstand.txt", "Noch nicht fertig\n");
    await appSees(repoId, 1, "a new file");
    // From the message field: Alt shortcuts apply there too.
    await kb.press("Alt+m");
    await eventually(async () => (await focus()).tag, "INPUT", "focus in the text field");
    await kb.press("Alt+s");
    // While the app writes or removes the stash ref, `git stash list` fails for a moment
    // ("bad revision 'refs/stash'") – that counts as "not yet", not as an error.
    const stashCount = () => {
      const output = tryGit("stash", "list");
      return output === null ? -1 : lines(output).length;
    };
    await eventually(stashCount, 1, "Alt+S creates a stash (git stash list)", 15_000);
    equal(status(), [], "the working directory is clean");
    await app.settle();
    await focused("after the stash");
    // Pop is available once the app knows the stash (left panel, toolbar).
    const known = Date.now();
    await eventually(() => page.evaluate(() => window.__gcUi.commands().find((command) => command.id === "stash.pop")?.available ?? false), true, "the app knows the new stash");
    console.log(`    stash visible in the app after ${Date.now() - known} ms`);
    await kb.press("Alt+p");
    await eventually(stashCount, 0, "Alt+P brings it back", 15_000);
    equal(status(), ["?? zwischenstand.txt"], "the file is back");
    await app.settle();
    await focused("after the pop");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Undo and redo: Ctrl+Z, Ctrl+Y", async () => {
    await writeMessage("Zwischenstand festgehalten");
    await kb.press("Control+Shift+Enter");
    await eventually(() => git("log", "-1", "--format=%s"), "Zwischenstand festgehalten", "commit created", 15_000);
    await app.settle();
    const committed = head();
    const parent = git("rev-parse", "HEAD~1");

    // In the text field, Ctrl+Z belongs to the text.
    await kb.press("Alt+m");
    await kb.type("abc", { delay: 3 });
    await kb.press("Control+z");
    await page.waitForTimeout(400);
    equal(head(), committed, "Ctrl+Z in the text field only undoes the typing");
    await kb.press("Control+a");
    await kb.press("Backspace");

    await kb.press("Alt+2");
    await focused("Alt+2", "center");
    await kb.press("Control+z");
    // Some actions ask before undoing.
    await page.waitForTimeout(500);
    if ((await dialogCount()) > 0) {
      await pressUntil("Tab", (el) => /Undo/.test(el?.textContent ?? ""), "confirm in the prompt", 6);
      await kb.press("Enter");
    }
    await eventually(head, parent, "Ctrl+Z takes the commit back (git rev-parse HEAD)", 15_000);
    check(status().some((line) => line.endsWith("zwischenstand.txt")), "its changes are back in the working directory");
    await app.settle();
    await focused("after undo");
    await kb.press("Alt+2");
    await kb.press("Control+y");
    await eventually(head, committed, "Ctrl+Y restores it", 15_000);
    equal(status(), [], "clean");
    await app.settle();
    await focused("after redo");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Search: Ctrl+F, type, Enter jumps, Esc hands focus to the hit", async () => {
    await kb.press("Alt+2");
    await kb.press("Control+f");
    await eventually(store.searchOpen, true, "Ctrl+F opens the search");
    await eventually(async () => (await focus()).label, "Search commits", "focus is in the search field");
    await kb.type("Stationen", { delay: 3 });
    const want = lines(git("log", "--all", "--format=%H", "-i", "-F", "--grep=Stationen"));
    check(want.length >= 2, `git knows ${want.length} commits with "Stationen"`);
    await eventually(async () => ((await store.search())?.hits ?? []).length, want.length, "the search finds the same commits", 15_000);
    await kb.press("Enter");
    const first = (await store.search()).hits[0];
    await eventually(store.selection, { kind: "commits", shas: [first] }, "Enter jumps to the first hit and selects it");
    await kb.press("Enter");
    const second = (await store.search()).hits[1];
    await eventually(store.selection, { kind: "commits", shas: [second] }, "Enter: next hit");
    await shot("keyboard-search");
    await kb.press("Escape");
    await eventually(store.searchOpen, false, "Esc closes the search");
    await focused("after the search", "center");
    await eventually(async () => (await focus()).rowId, second, "focus is on the hit");
    await kb.press("ArrowDown");
    await eventually(async () => (await store.selection())?.shas?.[0] !== second && (await store.selection())?.kind === "commits", true, "↓ continues from the hit");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Areas: F6, Shift+F6, Alt+1/2/3 – from text fields, with collapsed panels, in the smallest window", async () => {
    await kb.press("Alt+2");
    await eventually(area, "center", "Alt+2 → view");
    await app.settle();
    const order = [];
    const trace = [await describe()];
    for (let count = 0; count < 4; count++) {
      await kb.press("F6");
      await page.waitForTimeout(60);
      order.push(await area());
      trace.push(await describe());
    }
    if (!equal(order, ["right", "toolbar", "left", "center"], "F6 cycles: commit panel → toolbar → left panel → view")) console.log(`    path: ${trace.join("  →  ")}`);
    const back = [];
    for (let count = 0; count < 4; count++) {
      await kb.press("Shift+F6");
      await page.waitForTimeout(60);
      back.push(await area());
    }
    equal(back, ["left", "toolbar", "right", "center"], "Shift+F6 cycles backwards");
    for (const info of [await focus()]) check(info.visible, "focus is visible after the switch");

    // From the text field
    await kb.press("Alt+m");
    await eventually(async () => (await focus()).tag, "INPUT", "in the text field");
    await kb.press("F6");
    await eventually(area, "toolbar", "F6 also works in the text field");
    await kb.press("Alt+m");
    await kb.press("Alt+1");
    await eventually(area, "left", "Alt+1 also works in the text field");
    await kb.press("Alt+3");
    await eventually(area, "right", "Alt+3 → commit panel");
    await eventually(async () => (await focus()).tag, "INPUT", "… namely where focus was last there");

    // Collapsed panels
    await kb.press("Alt+1");
    await kb.press("Control+j");
    await eventually(() => page.locator('[data-area="left"]').count(), 0, "Ctrl+J collapses the left panel");
    await focused("after collapsing the panel that had focus");
    await kb.press("Alt+1");
    await eventually(() => page.locator('[data-area="left"]').count(), 1, "Alt+1 expands it again");
    await eventually(area, "left", "… and moves focus into it");
    await kb.press("Alt+3");
    await kb.press("Control+k");
    await eventually(() => page.locator('[data-area="right"]').count(), 0, "Ctrl+K collapses the commit panel");
    await focused("after collapsing the commit panel");
    await kb.press("Alt+3");
    await eventually(() => page.locator('[data-area="right"]').count(), 1, "Alt+3 expands it again");
    await eventually(area, "right", "… and moves focus into it");

    // Smallest window: the left panel is collapsed on its own
    await app.setSize(960, 600);
    await page.waitForTimeout(400);
    await kb.press("Alt+2");
    await eventually(area, "center", "960×600: Alt+2");
    const seen = new Set();
    for (let count = 0; count < 5; count++) {
      await kb.press("F6");
      await page.waitForTimeout(60);
      const info = await focus();
      seen.add(info.area);
      check(info.area !== "body" && info.visible, `960×600: F6 no. ${count + 1} lands visibly (${info.area})`);
    }
    check(seen.has("center") && seen.has("toolbar") && seen.has("right"), `960×600: F6 reaches toolbar, view and commit panel (${[...seen].join(", ")})`);
    await kb.press("Alt+1");
    await eventually(area, "left", "960×600: Alt+1 opens the left panel and moves focus into it");
    await shot("keyboard-min");
    await kb.press("Alt+2");
    await eventually(area, "center", "960×600: back to the view");
    await app.setSize(1440, 900);
    await page.waitForTimeout(400);
    await focused("after enlarging");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Dialogs return focus; Esc reaches the dialog despite a toast", async () => {
    await kb.press("Alt+2");
    await eventually(area, "center", "in the graph");
    const before = await focus();
    for (const [keys, name] of [
      ["Control+,", "Preferences"],
      ["Control+p", "Command Palette"],
      ["Control+/", "Keyboard shortcuts"],
      ["Control+b", "New branch"],
    ]) {
      await kb.press(keys);
      await eventually(dialogCount, 1, `${name} opens`);
      await eventually(area, "dialog", `${name}: focus is in the dialog`);
      await kb.press("Escape");
      await eventually(dialogCount, 0, `${name}: Esc closes`);
      await eventually(async () => (await focus()).rowId, before.rowId, `${name}: focus is back on the row in the graph`);
      check((await focus()).visible, `${name}: … and visible`);
    }

    // A success toast appears while the dialog is open: one Esc is still enough.
    const raise = (tone, title) => page.evaluate(async ([kind, text]) => void (await import("/src/ui/Feedback.tsx")).toast({ tone: kind, title: text }), [tone, title]);
    await kb.press("Control+,");
    await eventually(dialogCount, 1, "preferences open");
    await raise("success", "Toast above the dialog");
    await eventually(() => page.locator("[data-toast]").count(), 1, "the toast is shown");
    await kb.press("Escape");
    await eventually(dialogCount, 0, "ONE Esc closes the dialog even though a toast lies above it");
    await eventually(() => page.locator("[data-toast]").count(), 0, "the toast is gone too");
    await eventually(async () => (await focus()).rowId, before.rowId, "focus is back");

    // The palette also closes with one Esc under an error toast; the error toast does not stay in the way.
    await kb.press("Control+p");
    await eventually(dialogCount, 1, "palette open");
    await raise("danger", "Error above the palette");
    await eventually(() => page.locator("[data-toast]").count(), 1, "the error toast is shown");
    await kb.press("Escape");
    await eventually(dialogCount, 0, "one Esc closes the palette");
    await kb.press("Escape");
    await eventually(async () => (await focus()).rowId, before.rowId, "focus is back in the graph");
    // Closing the error toast by keyboard: F8? No – it disappears with Esc when it has focus; the click-free way via the palette is not enough here.
    await page.evaluate(async () => void (await import("/src/ui/Feedback.tsx")).dismissTransientToasts());
  });

  // ---------------------------------------------------------------------------------------------
  await section("Segmented controls: arrow keys select (Commit ↔ Stash, diff views)", async () => {
    // Change a tracked file – only then does the diff have several views.
    write("notiz.txt", "Erste Zeile\nZweite Zeile\n");
    await appSees(repoId, 1, "a changed file");
    await kb.press("Alt+m");
    await eventually(async () => (await focus()).tag, "INPUT", "in the commit form");
    await pressUntil("Shift+Tab", (el) => el?.getAttribute("role") === "radio" && /Commit/.test(el?.textContent ?? ""), "Commit/Stash switch", 12);
    equal((await store.view())?.rightPanel ?? "details", "details", "before: commit form");
    await kb.press("ArrowRight");
    await eventually(async () => (await store.view())?.rightPanel, "stash_form", "→ selects \"Stash\" (not just focus)");
    await eventually(async () => (await focus()).label, "Stash", "focus follows the selection");
    equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-checked") ?? document.activeElement?.getAttribute("data-state")), "true", "\"Stash\" is marked as selected");
    await kb.press("ArrowLeft");
    await eventually(async () => (await store.view())?.rightPanel, "details", "← selects \"Commit\" again");
    await eventually(async () => (await focus()).label, "Commit", "focus on \"Commit\"");

    // Diff header: Hunks / Whole file / Side by side
    await kb.press("Alt+3");
    await pressUntil("Tab", (el) => el?.getAttribute("role") === "option", "file list", 12);
    await kb.press("Enter");
    await eventually(async () => (await store.center())?.kind, "diff", "Enter opens the file's diff");
    await app.settle();
    await kb.press("Alt+2");
    await eventually(async () => (await focus()).role, "row", "Alt+2: focus is on a row of the diff");
    await pressUntil("Shift+Tab", (el) => el?.getAttribute("role") === "radio", "diff view switch", 20);
    const startLabel = (await focus()).label;
    await kb.press("Home");
    await eventually(async () => (await focus()).label, "Hunks", "Home selects the first view");
    await kb.press("ArrowRight");
    await eventually(async () => (await focus()).label, "Whole file", "→ selects \"Whole file\"");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-state")), "on", "… and it is selected, not just focused");
    await eventually(() => page.evaluate(() => window.__gc.queryClient.getQueryData(["app", "settings"])?.diffMode ?? null), "inline", "the choice is in the settings");
    await kb.press("End");
    await eventually(async () => (await focus()).label, "Side by side", "End selects the last one");
    // In quick succession, without waiting for the save:
    await kb.press("ArrowRight");
    await eventually(async () => (await focus()).label, "Hunks", "→ at the end wraps around");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-state")), "on", "\"Hunks\" is selected");
    check(Boolean(startLabel), "the switch was reachable");
    await kb.press("Alt+2");
    await closeDiff();
    await focused("after the diff");
  });

  // ---------------------------------------------------------------------------------------------
  await section("Tabs: Ctrl+T, Ctrl+W, Ctrl+1 – focus moves along", async () => {
    await kb.press("Alt+2");
    await eventually(area, "center", "in the graph");
    await kb.press("Control+t");
    await eventually(async () => (await activeTab())?.kind, "management", "Ctrl+T: new tab with repository management");
    await app.settle();
    await focused("in the new tab", "center");
    await kb.press("Control+1");
    await eventually(async () => (await activeTab())?.id, tabId, "Ctrl+1: back to the repository");
    await app.settle();
    await focused("after Ctrl+1", "center");
    await kb.press("Control+2");
    await eventually(async () => (await activeTab())?.kind, "management", "Ctrl+2");
    await kb.press("Control+w");
    await eventually(async () => (await tabs()).length, 1, "Ctrl+W closes the tab");
    await app.settle();
    await focused("after Ctrl+W", "center");
    equal((await focus()).role, "row", "focus is on a row in the graph again");
  });

  assertNoConsoleErrors(app, "core loop by keyboard");
} catch (error) {
  failures.push(`aborted: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  await app?.close().catch(() => undefined);
  repo.cleanup();
}

if (failures.length > 0) {
  console.error(`\nkeyboard: ${failures.length} failures`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nkeyboard: all green");
