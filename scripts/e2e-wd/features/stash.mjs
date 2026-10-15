/**
 * Stashes in the real app: named stashes (stash form), apply single files from a stash, patches
 * from a stash and applying them (1.0), and the partial stash of files, hunks and lines (1.1).
 * Every result is checked in the UI and in Git (stash list, stash contents, index, working tree).
 *
 *   node scripts/e2e-wd/features/stash.mjs
 *   E2E_WD_ONLY="partial" node scripts/e2e-wd/features/stash.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";
import { CRLF_LINES, MEASUREMENTS, makeStashRepo, measurementsWithTwoChanges } from "../fixtures/stash.mjs";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** innerText of an element (WebKitWebDriver's element text comes back empty for some nodes). */
const textOf = (app, element) => app.exec((node) => node.innerText.replace(/\s+/g, " ").trim(), element);

const launch = (t, options = {}) => t.launch({ width: 1440, height: 900, lang: "en", theme: "light", ...options });

/** Waits for a toast of `tone` whose text matches; returns its text. */
async function waitToast(app, tone, pattern, timeout = 15_000) {
  return app.waitFor(
    async () => {
      const texts = await app.exec((wanted) => [...document.querySelectorAll(`[data-toast="${wanted}"]`)].map((node) => node.innerText.replace(/\s+/g, " ").trim()), tone);
      return texts.find((text) => pattern.test(text)) ?? null;
    },
    timeout,
    { message: `toast (${tone}) matching ${pattern}` },
  );
}

/** Closes all toasts (they would cover the lower right corner in screenshots). */
async function closeToasts(app) {
  await app.exec(() => {
    for (const button of document.querySelectorAll('[data-toast] button[aria-label="Close message"]')) button.click();
  });
  await app.waitFor(() => app.exec(() => document.querySelectorAll("[data-toast]").length === 0), 5000, { message: "toasts closed" }).catch(() => undefined);
}

/** The checkbox (role=checkbox) whose label starts with `label`, or null. */
const checkbox = (app, label) =>
  app.exec((wanted) => {
    const found = [...document.querySelectorAll("label[for]")].find((node) => node.textContent.trim().startsWith(wanted));
    return found ? document.getElementById(found.htmlFor) : null;
  }, label);
const checked = async (app, label) => (await (await checkbox(app, label))?.attr("aria-checked")) === "true";

/** Switches the right panel to the stash form ("Commit | Stash" toggle). */
async function openStashForm(app) {
  const toggle = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[role="radio"]')].find((node) => node.textContent.trim() === "Stash") ?? null), 10_000, { message: "Stash toggle" });
  await app.click(toggle);
  await app.waitFor('[data-screen="stash-form"]', 10_000);
}

const nameField = (app) => app.waitFor(() => app.exec(() => {
  const label = [...document.querySelectorAll("label[for]")].find((node) => node.textContent.trim() === "Stash name");
  return label ? document.getElementById(label.htmlFor) : null;
}), 10_000, { message: "stash name field" });
const stashButton = (app) => app.waitFor('button[data-action="stash"]', 10_000);
const buttonText = async (app) => textOf(app, await stashButton(app));

/** Rows of a file list section ("unstaged", "staged") in the WIP panel. */
const listRows = (app, section) => app.exec((name) => [...document.querySelectorAll(`[data-section="${name}"] [data-row-key]`)].map((row) => row.dataset.rowKey), section);
const fileRow = (app, section, file) => app.waitFor(() => app.exec((name, key) => [...document.querySelectorAll(`[data-section="${name}"] [data-row-key]`)].find((row) => row.dataset.rowKey === key) ?? null, section, file), 10_000, { message: `${file} in ${section}` });

/** Status counts from the query cache (what the UI shows). */
const counts = (app, repoId) =>
  app.exec((id) => {
    const data = window.__gc.queryClient.getQueryData(["repo", id, "status"]);
    return data ? { unstaged: data.unstaged.length, staged: data.staged.length } : null;
  }, repoId);
async function waitCounts(app, repoId, expected, timeout = 20_000) {
  await app.exec(() => window.dispatchEvent(new Event("focus")));
  await app.waitFor(async () => {
    const now = await counts(app, repoId);
    return now !== null && now.unstaged === expected.unstaged && now.staged === expected.staged;
  }, timeout, { message: `status ${JSON.stringify(expected)}` }).catch(async (error) => {
    throw new Error(`${error.message}; is ${JSON.stringify(await counts(app, repoId))}`);
  });
}

/** Right panel mode of the tab ("details", "stash_form"). */
const rightPanel = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.rightPanel ?? "details", tabId);

/** Graph row of a stash by its message. */
const stashRow = (app, message) =>
  app.waitFor(() => app.exec((text) => [...document.querySelectorAll('[data-row-kind="stash"]')].find((row) => row.innerText.includes(text)) ?? null, message), 15_000, { message: `stash row "${message}"` });

/** Selects a stash in the graph; waits until the details show it. */
async function selectStash(app, message) {
  await app.click(await stashRow(app, message));
  await app.waitFor(() => app.exec((text) => document.querySelector('[data-testid="stash-message"]')?.textContent.trim() === text, message), 10_000, { message: `details of "${message}"` });
  await app.settle();
}

/** The menu item (role=menuitem) whose text starts with `label`. */
const menuItem = (app, label) =>
  app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim().startsWith(wanted)) ?? null, label), 8000, { message: `menu item "${label}"` });

/** Runs a command through the palette (Ctrl+P, ">text", Enter on the entry with that id). */
async function runCommand(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const find = () => app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` });
  // The result list re-renders while the deferred filter settles: an entry found a moment ago can be
  // replaced by an identical node. Look it up again instead of failing on the stale reference.
  for (let attempt = 0; ; attempt++) {
    try {
      await app.click(await find());
      break;
    } catch (error) {
      if (attempt >= 3 || !/stale element/i.test(String(error.message))) throw error;
      await app.settle(200);
    }
  }
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** The open dialog (role=dialog/alertdialog) with this accessible name or title text. */
const dialog = (app, title) =>
  app.waitFor(
    () =>
      app.exec((wanted) => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((node) => {
        const label = node.getAttribute("aria-labelledby");
        const name = (label ? document.getElementById(label)?.textContent : node.getAttribute("aria-label")) ?? "";
        return name.trim().startsWith(wanted);
      }) ?? null, title),
    10_000,
    { message: `dialog "${title}"` },
  );
const noDialog = (app) => app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), 8000, { message: "dialog closed" });
/** Button inside an element by its visible text. */
const buttonIn = (app, root, text) => app.waitFor(() => app.exec((scope, wanted) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === wanted) ?? null, root, text), 8000, { message: `button "${text}"` });

/** Stash subjects ("On main: name") from Git. */
const stashSubjects = (repo) => repo.lines("stash", "list", "--format=%gs");

// ---------------------------------------------------------------------------------------------
// Diff view: line selection
// ---------------------------------------------------------------------------------------------

/** Opens the diff of a WIP file (click in the file list) and waits until it is loaded. */
/** Opens the diff of a file; `contains` waits for a row with that text (an older diff of the same file may still be shown). */
async function openDiff(app, section, file, { contains = null } = {}) {
  await app.click(await fileRow(app, section, file));
  await app.waitFor(
    () => app.exec((label, text) => {
      const root = document.querySelector('[data-screen="diff"]');
      if (root?.getAttribute("aria-label") !== label || root.querySelector("[data-diff-loading]")) return false;
      const rows = [...root.querySelectorAll('[data-row][role="row"]')];
      return rows.length > 0 && (text === null || rows.some((row) => row.textContent.replace(/\u200b/g, "").includes(text)));
    }, `Diff of ${file}`, contains),
    20_000,
    { message: `diff of ${file}${contains ? ` containing "${contains}"` : ""}` },
  );
  await app.settle();
}

/** Changed rows of the diff grid in DOM order: { hunk, kind, text, selected }. */
const diffRows = (app) =>
  app.exec(() => {
    let hunk = -1;
    const out = [];
    for (const row of document.querySelectorAll('[data-diff-grid] [data-row][role="row"]')) {
      if (row.dataset.hunk !== undefined) {
        hunk += 1;
        continue;
      }
      const kind = row.dataset.kind;
      if (kind !== "add" && kind !== "remove") continue;
      out.push({ hunk, kind, text: (row.querySelector(".selectable")?.textContent ?? "").replace(/​/g, ""), selected: row.getAttribute("aria-selected") === "true" });
    }
    return out;
  });

/** Clicks the line-number gutter of the changed rows matching `pick({hunk, kind, text})` (toggles them). */
async function toggleLines(app, pick) {
  const rows = await app.exec(() => {
    let hunk = -1;
    const out = [];
    for (const row of document.querySelectorAll('[data-diff-grid] [data-row][role="row"]')) {
      if (row.dataset.hunk !== undefined) {
        hunk += 1;
        continue;
      }
      const kind = row.dataset.kind;
      if (kind !== "add" && kind !== "remove") continue;
      // Elements are only passed back at the top level of an array: [meta, gutter] pairs.
      out.push([{ hunk, kind, text: (row.querySelector(".selectable")?.textContent ?? "").replace(/\u200b/g, "") }, row.querySelector("[data-gutter]")]);
    }
    return out;
  });
  const gutters = rows.filter(([meta], index) => pick(meta, index)).map(([, gutter]) => gutter);
  assert(gutters.length > 0, "no diff rows matched the selection");
  for (const gutter of gutters) await app.click(gutter);
  return gutters.length;
}
const selectedLines = async (app) => (await diffRows(app)).filter((row) => row.selected).map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`);

// ---------------------------------------------------------------------------------------------
// 1.0 – Named stashes
// ---------------------------------------------------------------------------------------------

scenario("named stash from the stash form", "main", async (t) => {
  const repo = makeStashRepo({ name: "stash-benannt" });
  try {
    repo.write("README.md", `${repo.read("README.md")}\nHalbfertig: Auswertung März.\n`);
    repo.write("notizen/entwurf.md", "nicht verfolgt\n");
    repo.write("stationen.csv", `${repo.read("stationen.csv")}W;Wald;212\n`);
    repo.git("add", "stationen.csv");
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 2, staged: 1 });

    await openStashForm(app);
    assertEqual(await rightPanel(app, tabId), "stash_form", "right panel mode");
    assertEqual(await listRows(app, "unstaged"), ["README.md", "notizen/entwurf.md"], "the file lists stay in the stash form");
    assert(await checked(app, "Include untracked files"), "“Include untracked files” is preselected");
    assertEqual(await (await checkbox(app, "Only the marked files")).attr("data-disabled"), "", "“Only the marked files” is disabled without marked files");
    assertEqual(await buttonText(app), "Create stash", "button caption");

    const name = "Auswertung März – halbfertig";
    await app.type(await nameField(app), name);
    await app.exec(() => document.activeElement?.blur());
    await app.settle();
    await t.shot("named-stash-form");
    t.step("stash form filled");

    // Enter in the name field submits the form.
    await app.click(await nameField(app));
    await app.press("Enter");
    await waitToast(app, "success", /^Changes stashed/);
    assertEqual(stashSubjects(repo), [`On main: ${name}`], "git: stash with the name");
    assertEqual(repo.lines("show", "--name-only", "--format=", "stash@{0}^3"), ["notizen/entwurf.md"], "git: the untracked file is in the stash");
    assertEqual(repo.lines("diff", "--name-only", "stash@{0}^1", "stash@{0}^2"), ["stationen.csv"], "git: the staged change is in the stash's index commit");
    assertEqual(repo.git("status", "--porcelain", "--untracked-files=all"), "", "git: working tree clean");
    await waitCounts(app, repoId, { unstaged: 0, staged: 0 });
    await app.waitFor(async () => (await rightPanel(app, tabId)) === "details", 8000, { message: "back to the commit form" });

    // The stash shows up in the graph and in the details with its name.
    await selectStash(app, name);
    assertEqual(await app.exec(() => document.querySelector('[data-testid="stash-branch"]')?.textContent.trim()), "main", "details: branch");
    const files = await app.exec(() => [...document.querySelectorAll('[data-screen="commit-details"] [data-row-key]')].map((row) => row.dataset.rowKey).sort());
    assertEqual(files, ["README.md", "notizen/entwurf.md", "stationen.csv"], "details: files of the stash incl. the untracked one");
    await closeToasts(app);
    await app.settle();
    await t.shot("named-stash-details");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("stash form: blocked states and stashing only marked files", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-gesperrt" });
  try {
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 0, staged: 0 });

    // Nothing to stash: the button is disabled and a click creates nothing.
    await app.exec((id) => window.__gc.store.getState().setRightPanel(id, "stash_form"), tabId);
    await app.waitFor('[data-screen="stash-form"]');
    assertEqual(await (await stashButton(app)).attr("aria-disabled"), "true", "disabled without changes");
    await app.click(await stashButton(app));
    await app.settle();
    assertEqual(stashSubjects(repo), [], "git: no stash from a disabled button");

    // Only an untracked file and "Include untracked files" off: disabled as well.
    repo.write("notizen/neu.txt", "nicht verfolgt\n");
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await app.click(await checkbox(app, "Include untracked files"));
    await app.waitFor(async () => !(await checked(app, "Include untracked files")), 5000, { message: "untracked off" });
    assertEqual(await (await stashButton(app)).attr("aria-disabled"), "true", "only untracked files and the option off: disabled");
    await app.click(await stashButton(app));
    await app.settle();
    assertEqual(stashSubjects(repo), [], "git: still no stash");
    await app.click(await checkbox(app, "Include untracked files"));

    // Mark two of three files; only those go into the stash.
    repo.write("README.md", `${repo.read("README.md")}\nBleibt im Arbeitsverzeichnis.\n`);
    repo.write("stationen.csv", `${repo.read("stationen.csv")}W;Wald;212\n`);
    await waitCounts(app, repoId, { unstaged: 3, staged: 0 });
    await app.click(await fileRow(app, "unstaged", "stationen.csv"));
    await app.exec((id) => window.__gc.store.getState().closeCenter(id), tabId);
    // Ctrl+click adds the second file to the marking.
    const second = await fileRow(app, "unstaged", "notizen/neu.txt");
    const box = await second.rect();
    await app.webdriver("POST", "/actions", {
      actions: [
        { type: "key", id: "kb", actions: [{ type: "keyDown", value: "" }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: "" }] },
        { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 0 }] },
      ],
    });
    await app.webdriver("DELETE", "/actions").catch(() => undefined);
    await app.exec((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await app.waitFor(async () => (await checkbox(app, "Only the marked files (2)")) !== null, 5000, { message: "label counts two marked files" });
    await app.click(await checkbox(app, "Only the marked files"));
    await app.waitFor(async () => (await buttonText(app)) === "Stash 2 files", 5000, { message: "caption “Stash 2 files”" });
    await app.click(await stashButton(app));
    await waitToast(app, "success", /2 files stashed/);
    assertEqual(repo.lines("stash", "show", "--name-only", "--include-untracked", "stash@{0}").sort(), ["notizen/neu.txt", "stationen.csv"], "git: exactly the marked files in the stash");
    assertEqual(repo.lines("status", "--porcelain", "--untracked-files=all"), [" M README.md"], "git: the unmarked file stays");
    assertMatch(stashSubjects(repo)[0], /^WIP on main: [0-9a-f]{7,} /, "git: without a name the stash gets Git's usual name");
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("rename, delete (cancel and confirm) and undo a stash", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-umbenennen" });
  try {
    repo.write("README.md", `${repo.read("README.md")}\nErster Stand.\n`);
    repo.git("stash", "push", "-m", "Alter Name");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await stashRow(app, "Alter Name");

    // Rename via the palette: the dialog prefills the old name.
    await runCommand(app, "rename stash", "stash.rename");
    const rename = await dialog(app, "Rename stash");
    const field = await rename.$("input");
    assertEqual(await field.prop("value"), "Alter Name", "prefilled with the old name");
    await app.press("Control+a");
    await app.type(field, "Neuer Name mit Ümlaut");
    await app.press("Enter");
    await waitToast(app, "success", /Stash is now called “Neuer Name mit Ümlaut”/);
    assertEqual(stashSubjects(repo), ["On main: Neuer Name mit Ümlaut"], "git: renamed");
    await stashRow(app, "Neuer Name mit Ümlaut");

    // Delete: cancel keeps it, confirm removes it.
    await selectStash(app, "Neuer Name mit Ümlaut");
    const details = await app.waitFor('[data-screen="commit-details"]');
    await app.click(await buttonIn(app, details, "Delete"));
    const confirmDelete = await dialog(app, "Delete stash");
    assertIncludes(await textOf(app, confirmDelete), "cannot be brought back", "the confirmation warns");
    await app.press("Escape");
    await noDialog(app);
    assertEqual(stashSubjects(repo).length, 1, "git: Esc keeps the stash");
    await app.click(await buttonIn(app, details, "Delete"));
    await app.click(await buttonIn(app, await dialog(app, "Delete stash"), "Delete stash"));
    await waitToast(app, "success", /Stash deleted/);
    assertEqual(stashSubjects(repo), [], "git: stash deleted");
    await closeToasts(app);

    // Undo of a stash creation brings the changes back and removes the stash.
    repo.write("stationen.csv", `${repo.read("stationen.csv")}W;Wald;212\n`);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await runCommand(app, "stash", "stash.create");
    await waitToast(app, "success", /^Changes stashed/);
    assertEqual(stashSubjects(repo).length, 1, "git: stash created");
    assert(!repo.read("stationen.csv").includes("Wald"), "file reset after stashing");
    await waitCounts(app, repoId, { unstaged: 0, staged: 0 });
    await runCommand(app, "undo", "repo.undo");
    await app.waitFor(() => repo.read("stationen.csv").includes("Wald"), 15_000, { message: "undo restores the change" });
    assertEqual(stashSubjects(repo), [], "git: undo dropped the stash");
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 – Apply single files from a stash
// ---------------------------------------------------------------------------------------------

/** Clicks a file row in the stash details and opens its context menu with Shift+F10. */
async function stashFileMenu(app, file) {
  const row = await app.waitFor(() => app.exec((key) => [...document.querySelectorAll('[data-screen="commit-details"] [data-row-key]')].find((node) => node.dataset.rowKey === key) ?? null, file), 10_000, { message: `${file} in the stash details` });
  await app.click(row);
  await app.press("Shift+F10");
  await app.waitFor('[role="menu"]', 8000);
}

/** Marks a second file row with Ctrl+click (W3C actions: Control held while clicking). */
async function ctrlClick(app, element) {
  const box = await element.rect();
  await app.webdriver("POST", "/actions", {
    actions: [
      { type: "key", id: "kb", actions: [{ type: "keyDown", value: "" }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: "" }] },
      { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 0 }] },
    ],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

scenario("apply only one file from a stash", "main", async (t) => {
  const repo = makeStashRepo({ name: "stash-datei" });
  try {
    const readme = repo.read("README.md");
    const stations = repo.read("stationen.csv");
    repo.write("README.md", `${readme}\nAus dem Stash.\n`);
    repo.write("stationen.csv", `${stations}W;Wald;212\n`);
    repo.git("stash", "push", "-m", "Zwei Dateien");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await selectStash(app, "Zwei Dateien");

    await stashFileMenu(app, "README.md");
    const item = await menuItem(app, "Apply only this file from the stash");
    assertIncludes(await textOf(app, item), "version from the stash, ends up staged", "the entry says what happens");
    await t.shot("apply-one-file-menu");
    await app.click(item);
    await waitToast(app, "success", /“README\.md” restored from [0-9a-f]{7}/);
    assertEqual(repo.read("README.md"), `${readme}\nAus dem Stash.\n`, "file: README.md has the stash version");
    assertEqual(repo.read("stationen.csv"), stations, "file: the other file of the stash stays untouched");
    assertEqual(repo.lines("status", "--porcelain"), ["M  README.md"], "git: the applied file is staged, nothing else changed");
    assertEqual(stashSubjects(repo), ["On main: Zwei Dateien"], "git: the stash is kept");
    await waitCounts(app, repoId, { unstaged: 0, staged: 1 });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("apply files from a stash: overwrite prompt, several files, deleted file", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-dateien" });
  try {
    const readme = repo.read("README.md");
    const stations = repo.read("stationen.csv");
    repo.write("README.md", `${readme}\nAus dem Stash.\n`);
    repo.write("stationen.csv", `${stations}W;Wald;212\n`);
    repo.remove("ohne-ende.txt");
    repo.write("notizen/neu.txt", "neu im Stash\n");
    repo.git("stash", "push", "--include-untracked", "-m", "Gemischt");
    // Local change in the way of README.md.
    repo.write("README.md", `${readme}\nLokal geändert.\n`);
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await selectStash(app, "Gemischt");

    // Overwriting a local change asks first; Esc changes nothing.
    await stashFileMenu(app, "README.md");
    await app.click(await menuItem(app, "Apply only this file from the stash"));
    const ask = await dialog(app, "Overwrite “README.md”");
    assertIncludes(await textOf(app, ask), "cannot be recovered", "the prompt warns about the local change");
    await app.press("Escape");
    await noDialog(app);
    assertEqual(repo.read("README.md"), `${readme}\nLokal geändert.\n`, "file: Esc keeps the local change");
    await stashFileMenu(app, "README.md");
    await app.click(await menuItem(app, "Apply only this file from the stash"));
    await app.click(await buttonIn(app, await dialog(app, "Overwrite “README.md”"), "Overwrite"));
    await waitToast(app, "success", /“README\.md” restored/);
    assertEqual(repo.read("README.md"), `${readme}\nAus dem Stash.\n`, "file: confirmed – the stash version wins");
    await closeToasts(app);

    // A file deleted in the stash cannot be applied on its own: the entry is disabled with a reason.
    await stashFileMenu(app, "ohne-ende.txt");
    const gone = await menuItem(app, "Apply only this file from the stash");
    assertEqual(await gone.attr("aria-disabled"), "true", "deleted in the stash: entry disabled");
    assertIncludes(`${await textOf(app, gone)} ${(await gone.attr("title")) ?? ""}`, "no longer exists in the stash", "with a reason");
    await app.press("Escape");

    // Two files at once (Ctrl+click): both come back, the stash stays.
    const rowOf = (file) => app.waitFor(() => app.exec((key) => [...document.querySelectorAll('[data-screen="commit-details"] [data-row-key]')].find((node) => node.dataset.rowKey === key) ?? null, file));
    await app.click(await rowOf("stationen.csv"));
    await ctrlClick(app, await rowOf("README.md"));
    await app.press("Shift+F10");
    await app.click(await menuItem(app, "Apply only these 2 files from the stash"));
    // README.md is changed locally by now (staged from above): the prompt lists it.
    const many = await dialog(app, "Overwrite 2 files");
    assertIncludes(await textOf(app, many), "README.md", "the prompt names the locally changed file");
    await app.click(await buttonIn(app, many, "Overwrite"));
    await waitToast(app, "success", /2 files restored from [0-9a-f]{7}/);
    assertEqual(repo.read("stationen.csv"), `${stations}W;Wald;212\n`, "file: stationen.csv from the stash");
    assertEqual(repo.lines("status", "--porcelain").sort(), ["M  README.md", "M  stationen.csv"], "git: both files staged");
    assert(repo.exists("ohne-ende.txt"), "file: the file deleted in the stash stays");
    assert(!repo.exists("notizen/neu.txt"), "file: the untracked file of the stash was not applied");
    assertEqual(stashSubjects(repo), ["On main: Gemischt"], "git: the stash is kept");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("apply an untracked file from a stash on its own", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-unverfolgt" });
  try {
    repo.write("README.md", `${repo.read("README.md")}\nAus dem Stash.\n`);
    repo.write("notizen/neu.txt", "neu im Stash\n");
    repo.git("stash", "push", "--include-untracked", "-m", "Mit neuer Datei");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await selectStash(app, "Mit neuer Datei");
    // The details list the untracked file of the stash (status U) and offer the same entry.
    await stashFileMenu(app, "notizen/neu.txt");
    const item = await menuItem(app, "Apply only this file from the stash");
    assertEqual(await item.attr("aria-disabled"), null, "the entry is offered for the untracked file");
    await app.click(item);
    const outcome = await app.waitFor(
      () => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((node) => `${node.dataset.toast}: ${node.innerText.replace(/\s+/g, " ").trim()}`).find((text) => /restored|failed/.test(text)) ?? null),
      15_000,
      { message: "result toast" },
    );
    t.step(`result: ${outcome}`);
    await t.shot("apply-untracked-file-from-stash");
    // For comparison: the core's dedicated command applies exactly this file.
    let core = "ok";
    try {
      await app.invoke("stash_apply_paths", { repoId, index: 0, paths: ["notizen/neu.txt"] });
    } catch (error) {
      core = `${error.code}: ${error.message}`;
    }
    t.step(`core stash_apply_paths for the same file: ${core}`);
    if (core === "ok") repo.remove("notizen/neu.txt");
    assertMatch(outcome, /^success: “notizen\/neu\.txt” restored/, "applying the untracked file of a stash succeeds");
    assertEqual(repo.read("notizen/neu.txt"), "neu im Stash\n", "file: the untracked file from the stash");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 – Patches from a stash, applying patches
// ---------------------------------------------------------------------------------------------

const patchCreateState = (app) => app.exec(() => document.querySelector('[data-screen="patch-create"]')?.dataset.patchState ?? null);
const patchApplyState = (app) => app.exec(() => document.querySelector('[data-screen="patch-apply"]')?.dataset.checkState ?? null);
const waitState = (app, read, state, what, timeout = 20_000) =>
  app.waitFor(async () => (await read(app)) === state, timeout, { message: `${what}: ${state}` }).catch(async (error) => {
    throw new Error(`${error.message} (is ${await read(app)})`);
  });
const patchFiles = (app, scope) => app.exec((root) => [...document.querySelectorAll(`${root} [data-patch-file]`)].map((row) => row.getAttribute("data-patch-file")), scope);

scenario("patch from a stash: save as file and apply it from the file", "main", async (t) => {
  const repo = makeStashRepo({ name: "stash-patch" });
  try {
    const readme = repo.read("README.md");
    const stations = repo.read("stationen.csv");
    repo.write("README.md", `${readme}\nFür die Kollegen.\n`);
    repo.write("stationen.csv", `${stations}W;Wald;212\n`);
    repo.git("stash", "push", "-m", "Für Kollegen");
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await selectStash(app, "Für Kollegen");

    await runCommand(app, "patch from selected stash", "patch.create.stash");
    const create = await dialog(app, "Create patch");
    await waitState(app, patchCreateState, "ready", "create dialog");
    assertIncludes(await textOf(app, create), "Stash “Für Kollegen”", "the dialog names the stash");
    assertEqual((await patchFiles(app, '[data-screen="patch-create"]')).sort(), ["README.md", "stationen.csv"], "files in the patch");
    await closeToasts(app);
    await t.shot("patch-from-stash");

    // Save inside the repository (the system dialog is answered via __gcTestSaves).
    const target = path.join(repo.path, "export", "fuer-kollegen.patch");
    await app.exec((file) => {
      window.__gcTestSaves = [file];
    }, target);
    await app.click('[data-action="patch-save"]');
    await waitToast(app, "success", /Patch saved/);
    await noDialog(app);
    const expected = await app.invoke("patch_create", { repoId, source: { kind: "stash", index: 0 }, paths: null });
    assertEqual(fs.readFileSync(target, "utf8"), expected.text, "the file contains exactly the stash patch");
    repo.git("apply", "--check", target);
    t.step("git apply --check accepts the saved patch");
    // Move the file out of the working tree so that applying it only changes the two files.
    const outside = path.join(repo.root, "fuer-kollegen.patch");
    fs.renameSync(target, outside);
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    await closeToasts(app);

    // Apply from the file: the check runs without changing anything, then "Apply".
    await runCommand(app, "apply patch", "patch.apply");
    await dialog(app, "Apply patch");
    const input = await app.waitFor("input[data-patch-file-input]");
    await app.type(input, outside);
    await waitState(app, patchApplyState, "ok", "apply check");
    assertEqual(repo.git("status", "--porcelain"), "", "git: the check changed nothing");
    assertEqual(await app.exec(() => document.querySelector("[data-patch-file-name]")?.innerText.trim()), "fuer-kollegen.patch", "the chosen file name is shown");
    assertMatch(await app.exec(() => document.querySelector("[data-patch-result]")?.innerText ?? ""), /Fits: 2 files will be changed/, "result: fits");
    await t.shot("patch-apply-from-file");
    await app.click('[data-action="patch-apply"]');
    await waitToast(app, "success", /Patch applied/);
    await noDialog(app);
    assertEqual(repo.read("README.md"), `${readme}\nFür die Kollegen.\n`, "file: README.md changed by the patch");
    assertEqual(repo.read("stationen.csv"), `${stations}W;Wald;212\n`, "file: stationen.csv changed by the patch");
    assertEqual(repo.git("diff", "--cached", "--name-only"), "", "git: nothing staged");
    assertEqual(stashSubjects(repo), ["On main: Für Kollegen"], "git: the stash is untouched");
    await waitCounts(app, repoId, { unstaged: 2, staged: 0 });
    assertEqual(await app.exec((id) => window.__gc.store.getState().views[id]?.selection?.kind ?? "wip", tabId), "wip", "the selection moves to the local changes");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("patches: cancelled save, patch that does not fit, no patch text", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-patch-rand" });
  try {
    const readme = repo.read("README.md");
    repo.write("README.md", `${readme}\nIm Stash.\n`);
    repo.write("notizen/neu.txt", "nur im Stash\n");
    repo.git("stash", "push", "--include-untracked", "-m", "Mit neuer Datei");
    const app = await launch(t);
    const { repoId } = await app.openRepo(repo.path);
    await selectStash(app, "Mit neuer Datei");

    await runCommand(app, "patch from selected stash", "patch.create.stash");
    const create = await dialog(app, "Create patch");
    await waitState(app, patchCreateState, "ready", "create dialog");
    assertIncludes(await textOf(app, create), "Stash “Mit neuer Datei”", "the dialog names the stash");
    // Cancelling the save dialog keeps everything as it is.
    await app.exec(() => {
      window.__gcTestSaves = [null];
    });
    await app.click('[data-action="patch-save"]');
    await app.settle();
    await dialog(app, "Create patch");
    assertEqual(await app.exec(() => document.querySelector("[data-patch-note]")), null, "no message after cancelling");
    await app.press("Escape");
    await noDialog(app);

    // A patch that does not fit: the stash patch on a README.md that already has the change.
    const text = (await app.invoke("patch_create", { repoId, source: { kind: "stash", index: 0 }, paths: ["README.md"] })).text;
    repo.write("README.md", `${readme}\nIm Stash.\n`);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await runCommand(app, "apply patch", "patch.apply");
    const apply = await dialog(app, "Apply patch");
    assertEqual(await patchApplyState(app), "idle", "empty: no check yet");
    assertEqual(await (await app.$('[data-action="patch-apply"]')).attr("title"), "Paste a patch or choose a file first.", "empty: Apply disabled with a reason");
    const area = await apply.$("textarea");
    await app.exec((field, value) => {
      // Like a paste: React's onChange via the native setter.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, area, text);
    await waitState(app, patchApplyState, "failed", "apply check");
    const alert = await app.exec(() => document.querySelector('[data-screen="patch-apply"] [role="alert"]')?.innerText ?? "");
    assertMatch(alert, /Does not fit: 1 of 1 file/, "the dialog says which part does not fit");
    assertIncludes(alert, "Nothing was changed.", "and that nothing changed");
    assertEqual(await (await app.$('[data-action="patch-apply"]')).attr("title"), "The patch does not fit the working directory.", "Apply disabled with a reason");
    await app.click('[data-action="patch-apply"]');
    await app.settle();
    await dialog(app, "Apply patch");
    assertEqual(repo.lines("status", "--porcelain"), [" M README.md"], "git: a click on the disabled button changes nothing");
    await t.shot("patch-apply-does-not-fit");

    // Text that is not a patch.
    await app.exec((field) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(field, "das ist kein Patch\n");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, area);
    await waitState(app, patchApplyState, "failed", "apply check of plain text");
    assertEqual(repo.lines("status", "--porcelain"), [" M README.md"], "git: still unchanged");
    await app.press("Escape");
    await noDialog(app);

    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("patch from a stash that contains an untracked file", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-patch-neu" });
  try {
    repo.write("README.md", `${repo.read("README.md")}\nIm Stash.\n`);
    repo.write("notizen/neu.txt", "nur im Stash\n");
    repo.git("stash", "push", "--include-untracked", "-m", "Mit neuer Datei");
    const app = await launch(t);
    await app.openRepo(repo.path);
    await selectStash(app, "Mit neuer Datei");
    const listed = await app.exec(() => [...document.querySelectorAll('[data-screen="commit-details"] [data-row-key]')].map((row) => row.dataset.rowKey).sort());
    assertEqual(listed, ["README.md", "notizen/neu.txt"], "the stash details list both files");
    await runCommand(app, "patch from selected stash", "patch.create.stash");
    const create = await dialog(app, "Create patch");
    await waitState(app, patchCreateState, "ready", "create dialog");
    const inPatch = await patchFiles(app, '[data-screen="patch-create"]');
    const text = await textOf(app, create);
    t.step(`files in the stash patch: ${inPatch.join(", ")}`);
    await closeToasts(app);
    await t.shot("patch-from-stash-with-untracked-file");
    // In the patch, or at least named as missing (like the "Without n new, untracked files" note for local changes).
    assert(inPatch.includes("notizen/neu.txt") || text.includes("notizen/neu.txt") || /untracked/i.test(text), `the patch drops the stash's untracked file notizen/neu.txt without a word (files: ${inPatch.join(", ")})`);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.1 – Partial stash: lines, hunks, files
// ---------------------------------------------------------------------------------------------

const stashSelectionButton = (app) => app.waitFor('[data-selection-bar] button[data-action="stash-selection"]', 8000);

/** From the diff view's selection bar into the stash form; returns the "Only the selection" label. */
async function queueSelection(app, tabId, expectedButton) {
  const button = await stashSelectionButton(app);
  assertEqual(await textOf(app, button), expectedButton, "selection bar button");
  await app.click(button);
  await app.waitFor('[data-screen="stash-form"]', 8000);
  assertEqual(await rightPanel(app, tabId), "stash_form", "the stash form opens");
  return app.waitFor(() => app.exec(() => [...document.querySelectorAll("label[for]")].map((node) => node.textContent.trim()).map((text) => text.match(/^Only the selection \([^)]*\)/)?.[0]).find(Boolean) ?? null), 8000, { message: "“Only the selection” checkbox" });
}

/** The stash's worktree diff against its base (what `stash show -p` prints), as +/- lines. */
const stashChanges = (repo, ref = "stash@{0}") =>
  repo
    .git("diff", "--no-color", `${ref}^1`, ref)
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));

scenario("partial stash of selected lines", "main", async (t) => {
  const repo = makeStashRepo({ name: "stash-zeilen" });
  try {
    const changed = measurementsWithTwoChanges();
    repo.write("messwerte.csv", changed);
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await openDiff(app, "unstaged", "messwerte.csv");
    assertEqual((await diffRows(app)).map((row) => row.hunk), [0, 0, 1, 1], "two hunks with one changed line each");

    // Select only the two lines of the first change in the line-number column.
    await toggleLines(app, (row) => row.hunk === 0);
    assertEqual(await selectedLines(app), ["-2026-03-03;4.2", "+2026-03-03;9.9"], "selected lines");
    await t.shot("partial-lines-selection-bar");
    const label = await queueSelection(app, tabId, "Stash selection (2 lines) …");
    assertEqual(label, "Only the selection (1 file, 2 lines)", "the stash form shows the selection");
    assert(await checked(app, "Only the selection"), "“Only the selection” is checked");
    assertEqual(await (await checkbox(app, "Only the marked files")).attr("data-disabled"), "", "“Only the marked files” is off while a selection is pending");
    assertEqual(await buttonText(app), "Stash selection", "button caption");
    await app.type(await nameField(app), "Nur der Ausreißer am 3.");
    await app.exec(() => document.activeElement?.blur());
    await app.settle();
    await t.shot("partial-lines-stash-form");
    await app.click(await stashButton(app));
    await waitToast(app, "success", /Selected lines stashed/);

    assertEqual(stashSubjects(repo), ["On main: Nur der Ausreißer am 3."], "git: stash with the name");
    assertEqual(stashChanges(repo), ["-2026-03-03;4.2", "+2026-03-03;9.9"], "git: the stash holds exactly the selected lines");
    const rest = [...MEASUREMENTS];
    rest[26] = "2026-03-27;0.1";
    assertEqual(repo.read("messwerte.csv"), `${rest.join("\n")}\n`, "file: the other change stays in the working tree");
    assertEqual(repo.git("diff", "--cached", "--name-only"), "", "git: index untouched");
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await app.waitFor(async () => (await rightPanel(app, tabId)) === "details", 8000, { message: "back to the commit form" });

    // Commit the rest, then pop: the stashed lines come back on top of it.
    repo.git("commit", "-qam", "Messwert vom 27. korrigiert");
    await waitCounts(app, repoId, { unstaged: 0, staged: 0 });
    await runCommand(app, "pop", "stash.pop");
    await app.waitFor(() => repo.read("messwerte.csv") === changed, 15_000, { message: "pop brings the lines back" });
    await app.waitFor(() => repo.git("for-each-ref", "refs/stash") === "", 10_000, { message: "popped stash is gone" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("partial stash of whole hunks from staged and unstaged changes", "main", async (t) => {
  const repo = makeStashRepo({ name: "stash-hunks" });
  try {
    repo.write("messwerte.csv", measurementsWithTwoChanges());
    repo.git("add", "messwerte.csv");
    repo.write("README.md", `${repo.read("README.md")}\nZeile A\nZeile B\n`);
    const headBefore = repo.git("rev-parse", "HEAD");
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 1, staged: 1 });

    // Staged: the whole second hunk of messwerte.csv.
    await openDiff(app, "staged", "messwerte.csv");
    await toggleLines(app, (row) => row.hunk === 1);
    assertEqual(await selectedLines(app), ["-2026-03-27;6.6", "+2026-03-27;0.1"], "staged: the second hunk selected");
    await queueSelection(app, tabId, "Stash selection (2 lines) …");
    // Unstaged: the whole (only) hunk of README.md – the selection grows.
    await openDiff(app, "unstaged", "README.md");
    await toggleLines(app, () => true);
    const label = await queueSelection(app, tabId, "Stash selection (3 lines) …");
    assertEqual(label, "Only the selection (2 files, 5 lines)", "the stash form sums up both files");
    await app.exec((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await app.settle();
    await t.shot("partial-hunks-stash-form");
    await app.click(await stashButton(app));
    await waitToast(app, "success", /Selected lines stashed/);

    assertEqual(repo.git("rev-parse", "HEAD"), headBefore, "git: HEAD unchanged");
    assertEqual(repo.lines("diff", "--name-only", "stash@{0}^1", "stash@{0}").sort(), ["README.md", "messwerte.csv"], "git: both files in the stash");
    assertEqual(repo.lines("diff", "--name-only", "stash@{0}^1", "stash@{0}^2"), ["messwerte.csv"], "git: the staged hunk is in the stash's index commit");
    assertEqual(stashChanges(repo).filter((line) => line.includes("2026-03")), ["-2026-03-27;6.6", "+2026-03-27;0.1"], "git: only the second hunk of messwerte.csv");
    // What stays: the first hunk is still staged, README.md is clean.
    const staged = [...MEASUREMENTS];
    staged[2] = "2026-03-03;9.9";
    assertEqual(repo.git("show", ":messwerte.csv"), staged.join("\n"), "git: the first hunk stays staged");
    assertEqual(repo.lines("status", "--porcelain"), ["M  messwerte.csv"], "git: README.md clean, messwerte.csv staged only");
    await waitCounts(app, repoId, { unstaged: 0, staged: 1 });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("partial stash of whole files selected in the diff (Ctrl+A)", "main", async (t) => {
  const repo = makeStashRepo({ name: "stash-dateien-auswahl" });
  try {
    repo.write("README.md", `${repo.read("README.md")}\nIn den Stash.\n`);
    repo.write("stationen.csv", `${repo.read("stationen.csv")}W;Wald;212\n`);
    repo.write("messwerte.csv", measurementsWithTwoChanges());
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 3, staged: 0 });
    for (const [file, lines] of [["README.md", 2], ["stationen.csv", 1]]) {
      await openDiff(app, "unstaged", file);
      // Ctrl+A in the diff selects all changed lines of the file.
      // Focus into the grid with one line, then Ctrl+A extends to every changed line.
      await toggleLines(app, (row, index) => index === 0);
      await app.press("Control+a");
      await app.waitFor(async () => (await selectedLines(app)).length === lines, 5000, { message: `${file}: all lines selected` });
      await queueSelection(app, tabId, `Stash selection (${lines} line${lines === 1 ? "" : "s"}) …`);
    }
    assertEqual(await app.exec(() => [...document.querySelectorAll("label[for]")].map((node) => node.textContent.trim().match(/^Only the selection \([^)]*\)/)?.[0]).find(Boolean)), "Only the selection (2 files, 3 lines)", "two whole files");
    await app.exec((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await app.type(await nameField(app), "Zwei ganze Dateien");
    await app.exec(() => document.activeElement?.blur());
    await app.settle();
    await t.shot("partial-files-stash-form");
    await app.click(await stashButton(app));
    await waitToast(app, "success", /Selected lines stashed/);
    assertEqual(repo.lines("diff", "--name-only", "stash@{0}^1", "stash@{0}").sort(), ["README.md", "stationen.csv"], "git: exactly the two files in the stash");
    assertEqual(repo.lines("status", "--porcelain"), [" M messwerte.csv"], "git: the third file stays");
    assertEqual(repo.read("messwerte.csv"), measurementsWithTwoChanges(), "file: messwerte.csv untouched");
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("partial stash: undo and redo", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-teil-undo" });
  try {
    const changed = measurementsWithTwoChanges();
    repo.write("messwerte.csv", changed);
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await openDiff(app, "unstaged", "messwerte.csv");
    await toggleLines(app, (row) => row.hunk === 1 && row.kind === "add");
    await queueSelection(app, tabId, "Stash selection (1 line) …");
    await app.click(await stashButton(app));
    await waitToast(app, "success", /Selected lines stashed/);
    assertEqual(stashChanges(repo), ["+2026-03-27;0.1"], "git: only the added line in the stash");
    const afterStash = repo.read("messwerte.csv");
    assert(!afterStash.includes("2026-03-27;0.1") && afterStash.includes("2026-03-27;6.6") === false, "file: the added line is gone, the removed line stays removed");
    await closeToasts(app);

    await runCommand(app, "undo", "repo.undo");
    await app.waitFor(() => repo.read("messwerte.csv") === changed, 15_000, { message: "undo brings the line back" });
    // The files come back first, then the stash is dropped: wait for both.
    await app.waitFor(() => repo.git("for-each-ref", "refs/stash") === "", 15_000, { message: "undo drops the stash" });
    assertEqual(stashSubjects(repo), [], "git: undo dropped the stash");
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });

    await runCommand(app, "redo", "repo.redo");
    await app.waitFor(() => repo.read("messwerte.csv") === afterStash, 15_000, { message: "redo takes the line out again" });
    await app.waitFor(() => repo.git("for-each-ref", "refs/stash") !== "", 15_000, { message: "redo puts the stash back" });
    assertEqual(stashChanges(repo), ["+2026-03-27;0.1"], "git: redo puts the same stash back");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("partial stash keeps CRLF line endings byte for byte", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-crlf" });
  try {
    const crlf = [...CRLF_LINES];
    crlf[1] = "ZWEI";
    crlf[8] = "NEUN";
    repo.write("crlf.txt", `${crlf.join("\r\n")}\r\n`);
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await openDiff(app, "unstaged", "crlf.txt");
    await toggleLines(app, (row) => row.text === "zwei" || row.text === "ZWEI");
    await queueSelection(app, tabId, "Stash selection (2 lines) …");
    await app.click(await stashButton(app));
    await waitToast(app, "success", /Selected lines stashed/);

    const kept = [...CRLF_LINES];
    kept[8] = "NEUN";
    assertEqual(repo.bytes("crlf.txt").toString("hex"), Buffer.from(`${kept.join("\r\n")}\r\n`).toString("hex"), "file: crlf.txt keeps the second change and every CRLF");
    const stashed = [...CRLF_LINES];
    stashed[1] = "ZWEI";
    assertEqual(Buffer.from(repo.git("cat-file", "blob", "stash@{0}:crlf.txt")).toString("hex"), Buffer.from(stashed.join("\r\n")).toString("hex"), "git: the stash has ZWEI with CRLF (the fixture git drops the final line ending)");
    // Commit the rest, pop: the exact bytes come back.
    repo.git("commit", "-qam", "NEUN");
    await waitCounts(app, repoId, { unstaged: 0, staged: 0 });
    await runCommand(app, "pop", "stash.pop");
    await app.waitFor(() => repo.bytes("crlf.txt").equals(Buffer.from(`${crlf.join("\r\n")}\r\n`)), 15_000, { message: "pop restores crlf.txt byte for byte" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("partial stash at a missing final newline keeps the rest of the file", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-ohne-ende" });
  try {
    // HEAD: "alpha\nbeta\ngamma" (no final newline). Working tree: beta -> BETA, delta appended.
    repo.write("ohne-ende.txt", "alpha\nBETA\ngamma\ndelta");
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });
    await openDiff(app, "unstaged", "ohne-ende.txt");
    assertEqual((await diffRows(app)).map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`), ["-beta", "-gamma", "+BETA", "+gamma", "+delta"], "diff rows");
    // Stash only the appended line (with the newline gamma gets): -gamma, +gamma, +delta. BETA stays.
    await toggleLines(app, (row) => row.text === "gamma" || row.text === "delta");
    await queueSelection(app, tabId, "Stash selection (3 lines) …");
    await app.click(await stashButton(app));
    await waitToast(app, "success", /Selected lines stashed/);
    assertEqual(repo.git("cat-file", "blob", "stash@{0}:ohne-ende.txt"), "alpha\nbeta\ngamma\ndelta", "git: the stash holds HEAD plus the selected lines");
    await openDiff(app, "unstaged", "ohne-ende.txt");
    await t.shot("partial-missing-final-newline");
    assertEqual(JSON.stringify(repo.bytes("ohne-ende.txt").toString("utf8")), JSON.stringify("alpha\nBETA\ngamma"), "file: only BETA stays, line order and the missing final newline are kept");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("partial stash: unchecking the selection, a moved HEAD and lines that build on unselected staged lines", "edge", async (t) => {
  const repo = makeStashRepo({ name: "stash-teil-rand" });
  try {
    repo.write("messwerte.csv", measurementsWithTwoChanges());
    const app = await launch(t);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitCounts(app, repoId, { unstaged: 1, staged: 0 });

    // Unchecking "Only the selection" falls back to a normal stash of everything.
    await openDiff(app, "unstaged", "messwerte.csv");
    await toggleLines(app, (row) => row.hunk === 0);
    await queueSelection(app, tabId, "Stash selection (2 lines) …");
    await app.click(await checkbox(app, "Only the selection"));
    await app.waitFor(async () => (await checkbox(app, "Only the selection")) === null, 5000, { message: "selection dropped" });
    assertEqual(await buttonText(app), "Create stash", "back to a stash of everything");

    // A selection made before HEAD moved does not count any more.
    await openDiff(app, "unstaged", "messwerte.csv");
    await toggleLines(app, (row) => row.hunk === 0);
    await queueSelection(app, tabId, "Stash selection (2 lines) …");
    repo.write("neu.txt", "ein Commit von außen\n");
    repo.git("add", "neu.txt");
    repo.git("commit", "-q", "-m", "Commit von außen");
    await app.exec(() => window.dispatchEvent(new Event("focus")));
    await app.waitFor(async () => (await checkbox(app, "Only the selection")) === null, 15_000, { message: "the selection disappears after HEAD moved" });
    assertEqual(await buttonText(app), "Create stash", "after HEAD moved: a normal stash");
    assertEqual(stashSubjects(repo), [], "git: nothing stashed so far");

    // Unstaged lines that build on staged lines which are not selected are refused, nothing changes.
    const staged = [...MEASUREMENTS];
    staged[2] = "2026-03-03;STAGED";
    repo.write("messwerte.csv", `${staged.join("\n")}\n`);
    repo.git("add", "messwerte.csv");
    const worktree = [...staged];
    worktree[2] = "2026-03-03;WORKTREE";
    repo.write("messwerte.csv", `${worktree.join("\n")}\n`);
    await waitCounts(app, repoId, { unstaged: 1, staged: 1 });
    await openDiff(app, "unstaged", "messwerte.csv", { contains: "2026-03-03;WORKTREE" });
    await toggleLines(app, () => true);
    await queueSelection(app, tabId, "Stash selection (2 lines) …");
    const backupsBefore = repo.git("for-each-ref", "refs/forkyard/undo/");
    await app.click(await stashButton(app));
    const refusal = await waitToast(app, "danger", /build on staged changes/);
    t.step(`refused: ${refusal}`);
    await closeToasts(app);
    await app.settle();
    await t.shot("partial-refused-dependent-lines");
    assertEqual(stashSubjects(repo), [], "git: no stash after the refusal");
    assertEqual(repo.read("messwerte.csv"), `${worktree.join("\n")}\n`, "file: working tree unchanged");
    assertEqual(repo.git("show", ":messwerte.csv"), staged.join("\n"), "git: index unchanged");
    assertEqual(repo.git("for-each-ref", "refs/forkyard/undo/"), backupsBefore, "git: no leftover backup refs");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
