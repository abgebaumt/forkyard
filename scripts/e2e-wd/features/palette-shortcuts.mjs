/**
 * Command palette (Ctrl+P, F1), keyboard shortcuts, focus handling with dialogs and the built-in
 * terminal (all 1.0) in the real app. Every action is checked in the UI and, where it changes
 * something, in Git (branches, HEAD, commits of the temp repository).
 *
 *   node scripts/e2e-wd/features/palette-shortcuts.mjs
 *   E2E_WD_ONLY="terminal" node scripts/e2e-wd/features/palette-shortcuts.mjs
 *
 * The terminal scenarios start the app with SHELL=/bin/bash and a throw-away HOME (prompt "fy$ ",
 * no history file), so the user's shell profile and history are never touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";
import { makeBranchRepo } from "../fixtures/branches.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const PALETTE = '[data-screen="command-palette"]';
const PALETTE_INPUT = `${PALETTE} input[role="combobox"]`;
const branchRow = (name) => `[data-row-id="refs/heads/${name}"]`;
const commitRow = (sha) => `[data-row-id="${sha}"]`;

/** Polls a synchronous read (Git state) until it equals `expected`. */
async function eventually(read, expected, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return last;
    if (Date.now() > deadline) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`);
    await sleep(150);
  }
}

async function start(t, repo, options = {}) {
  const app = await t.launch({ ...LAUNCH, ...options });
  const ids = await app.openRepo(repo.path);
  await app.waitFor(commitRow(repo.head()), 20_000, { message: "HEAD commit row" });
  await app.waitFor(branchRow("main"), 10_000, { message: "main in the sidebar" });
  return { app, ...ids };
}

/** Where the focus is: { area, tag, label, inDialog, id } (area from data-area). */
const focusInfo = (app) =>
  app.exec(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { area: null, tag: "BODY", label: null, inDialog: false };
    return {
      area: element.closest("[data-area]")?.getAttribute("data-area") ?? (element.closest('[data-shell] > [role="toolbar"]') ? "toolbar" : null),
      tag: element.tagName,
      label: element.getAttribute("aria-label") ?? element.getAttribute("data-row-id") ?? element.textContent?.trim().slice(0, 40) ?? null,
      inDialog: Boolean(element.closest('[role="dialog"], [role="alertdialog"]')),
      rowId: element.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null,
    };
  });

/** Options of the palette: [{ kind, key, selected, disabled, text }]. */
const paletteOptions = (app) =>
  app.exec((root) =>
    [...document.querySelectorAll(`${root} [role="option"]`)].map((option) => ({
      kind: option.dataset.kind,
      key: option.dataset.key,
      selected: option.getAttribute("aria-selected") === "true",
      disabled: option.getAttribute("aria-disabled") === "true",
      text: option.innerText.replace(/\s+/g, " ").trim(),
    })),
  PALETTE);
const paletteHeaders = (app) =>
  app.exec((root) => [...document.querySelectorAll(`${root} [role="listbox"] [role="presentation"]`)].map((node) => node.textContent.trim()), PALETTE);
const paletteText = (app) => app.exec((root) => document.querySelector(root)?.innerText.replace(/\s+/g, " ").trim() ?? null, PALETTE);
const paletteValue = (app) => app.exec((selector) => document.querySelector(selector)?.value ?? null, PALETTE_INPUT);

async function openPalette(app, combo = "Control+p") {
  await app.press(combo);
  await app.waitFor(PALETTE_INPUT, 5000, { message: `palette opened with ${combo}` });
  await app.waitFor(async () => (await focusInfo(app)).tag === "INPUT", 5000, { message: "focus in the palette input" });
}

/** Types into the palette (appends) and waits until the first option matches. */
async function paletteSearch(app, text, firstMatches = null) {
  await app.type(PALETTE_INPUT, text);
  if (!firstMatches) return;
  await app.waitFor(
    async () => {
      const options = await paletteOptions(app);
      const selected = options.find((option) => option.selected);
      return selected && firstMatches(selected) ? options : null;
    },
    10_000,
    { message: `palette: selected option for “${text}”` },
  );
}

/** Replaces the palette text (select all + backspace, then type). */
async function paletteReplace(app, text) {
  await app.press("Control+a", "Backspace");
  if (text) await app.type(PALETTE_INPUT, text);
}

const paletteClosed = (app) => app.waitFor(async () => (await app.$$(PALETTE)).length === 0, 5000, { message: "palette closed" });

/** The open dialog (not the palette): { title, text, buttons[] }. */
function dialogInfo(app) {
  return app.exec((palette) => {
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((node) => !node.matches(palette)).pop();
    if (!dialog) return null;
    return {
      title: dialog.querySelector("h2")?.innerText.trim() ?? "",
      text: dialog.innerText.replace(/\s+/g, " ").trim(),
      buttons: [...dialog.querySelectorAll("footer button, button[data-action]")].map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })),
    };
  }, PALETTE);
}

async function waitDialog(app, titlePattern, timeout = 10_000) {
  return app.waitFor(
    async () => {
      const info = await dialogInfo(app);
      return info && titlePattern.test(info.title) ? info : null;
    },
    timeout,
    { message: `dialog ${titlePattern}` },
  );
}

const noDialog = (app) => app.waitFor(async () => (await app.$$('[role="dialog"], [role="alertdialog"]')).length === 0, 8000, { message: "dialog closed" });

async function dialogButton(app, text) {
  const button = await app.waitFor(
    () =>
      app.exec((wanted) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
        return [...(dialog?.querySelectorAll("footer button") ?? [])].find((el) => el.innerText.trim() === wanted && !el.disabled) ?? null;
      }, text),
    8000,
    { message: `dialog button “${text}”` },
  );
  await button.click();
}

const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.getAttribute("data-toast"), text: el.innerText.replace(/\s+/g, " ").trim() })));
async function noDangerToasts(app) {
  assertEqual((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error message");
}
async function dismissToasts(app) {
  await app.exec(() => {
    for (const el of document.querySelectorAll("[data-toast] button[aria-label]")) if (/close|dismiss/i.test(el.getAttribute("aria-label"))) el.click();
  });
}

/** The tab view from the store (panels, selection, terminal). */
const view = (app, tabId) =>
  app.exec((id) => {
    // A tab whose view was never changed has no entry yet: the defaults apply.
    const value = window.__gc.store.getState().views[id] ?? { leftCollapsed: false, rightCollapsed: false, terminalOpen: false, selection: { kind: "wip" } };
    return { leftCollapsed: value.leftCollapsed, rightCollapsed: value.rightCollapsed, terminalOpen: value.terminalOpen, selection: value.selection };
  }, tabId);
const tabs = (app) => app.exec(() => (window.__gc.queryClient.getQueryData(["app", "tabs"]) ?? []).map((tab) => ({ id: tab.id, active: tab.isActive, kind: tab.kind })));
const visibleArea = (app, area) =>
  app.exec((name) => {
    const element = document.querySelector(`[data-area="${name}"]`);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, area);

// --- Terminal --------------------------------------------------------------------------------

const TERMINAL = '[data-screen="terminal"]';
const TERMINAL_INPUT = `${TERMINAL} .xterm-helper-textarea`;

/** HOME for the shell: prompt "fy$ ", no history. Removed at process exit. */
function shellHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-shell-home-"));
  fs.writeFileSync(path.join(home, ".bash_profile"), "export PS1='fy$ '\nunset HISTFILE\nexport HISTSIZE=0\n");
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const shellEnv = () => ({ SHELL: "/bin/bash", HOME: shellHome(), HISTFILE: "/dev/null" });

const term = {
  status: (app, tabId) => app.exec((id) => window.__gcTerminal?.status(id)?.kind ?? null, tabId),
  text: (app, tabId) => app.exec((id) => window.__gcTerminal?.text(id) ?? "", tabId),
  focused: (app) => app.exec((selector) => Boolean(document.activeElement?.closest(`${selector} .xterm`)), TERMINAL),
  async waitStatus(app, tabId, kind, timeout = 20_000) {
    return app.waitFor(async () => (await term.status(app, tabId)) === kind, timeout, { message: `terminal status ${kind}` });
  },
  async waitText(app, tabId, pattern, timeout = 20_000) {
    try {
      return await app.waitFor(async () => (await term.text(app, tabId)).match(pattern), timeout, { message: `terminal shows ${pattern}` });
    } catch (error) {
      const text = await term.text(app, tabId);
      throw new Error(`${error.message}\nLast lines:\n${text.split("\n").slice(-12).join("\n")}`);
    }
  },
  /** Types a line into the shell (focus must be in the terminal) and presses Enter. */
  async run(app, line) {
    await app.type(TERMINAL_INPUT, line);
    await app.press("Enter");
  },
};

/** Opens the terminal with Ctrl+` and waits for the prompt. */
async function openTerminal(app, tabId) {
  await app.press("Control+`");
  await app.waitFor(TERMINAL, 10_000, { message: "terminal panel" });
  await term.waitStatus(app, tabId, "running");
  await term.waitText(app, tabId, /fy\$/);
  await app.waitFor(() => term.focused(app), 10_000, { message: "focus in the terminal" });
}

// ---------------------------------------------------------------------------------------------
// Command palette (1.0)
// ---------------------------------------------------------------------------------------------

scenario("palette: Ctrl+P finds a branch and checks it out with Enter", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await openPalette(app, "Control+p");
    assertEqual(await paletteValue(app), "", "Ctrl+P starts without a prefix");
    const headers = await paletteHeaders(app);
    assertIncludes(headers, "Commands", "empty palette lists the commands");
    await paletteSearch(app, "luftdr", (option) => option.key === "ref:refs/heads/feature/luftdruck");
    const options = await paletteOptions(app);
    assertEqual(options[0].kind, "branch", "best match is the branch");
    assertMatch(options[0].text, /feature\/luftdruck .*Branch/, "row shows name and kind");
    await t.shot("palette-ctrl-p-branch-search");
    await app.press("Enter");
    await paletteClosed(app);
    await eventually(() => repo.branch(), "feature/luftdruck", "branch checked out (git)");
    assertEqual(repo.status(), "", "working tree clean");
    await app.waitFor(async () => (await (await app.$(branchRow("feature/luftdruck")))?.attr("aria-current")) === "true", 10_000, { message: "sidebar marks feature/luftdruck as checked out" });
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("palette: F1 lists the commands and runs “New branch …” into its dialog", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await openPalette(app, "F1");
    assertEqual(await paletteValue(app), ">", "F1 opens with the command prefix");
    const headers = await paletteHeaders(app);
    assertIncludes(headers, "All available commands", "command scope header");
    const all = await paletteOptions(app);
    assert(all.length > 20 && all.every((option) => option.kind === "command" && !option.disabled), `only available commands (${all.length})`);
    await paletteSearch(app, "new branch", (option) => option.key === "command:branch.create");
    await t.shot("palette-f1-command-search");
    await app.press("Enter");
    await paletteClosed(app);
    const info = await waitDialog(app, /^New branch$/);
    assert(info, "New branch dialog");
    await app.waitFor(async () => {
      const focus = await focusInfo(app);
      return focus.inDialog && focus.tag === "INPUT";
    }, 5000, { message: "the dialog opened by the palette has the focus in its name field" });
    await app.type('[role="dialog"] input', "aus-der-palette");
    await app.waitFor(async () => (await dialogInfo(app))?.buttons.some((button) => button.text === "Create branch" && !button.disabled), 5000, { message: "Create branch enabled" });
    await app.press("Enter");
    await noDialog(app);
    await eventually(() => repo.branch(), "aus-der-palette", "new branch checked out (git)");
    assertEqual(repo.sha("aus-der-palette"), repo.shas.c3, "starts at HEAD");
    await app.waitFor(branchRow("aus-der-palette"), 10_000, { message: "sidebar shows the new branch" });

    // The command is now listed under "Recently used".
    await dismissToasts(app);
    await openPalette(app, "Control+p");
    const recent = await app.waitFor(async () => {
      const list = await paletteHeaders(app);
      return list[0] === "Recently used" ? list : null;
    }, 5000, { message: "“Recently used” header first" });
    assertEqual(recent.slice(0, 2), ["Recently used", "Commands"], "headers");
    assertEqual((await paletteOptions(app))[0].key, "command:branch.create", "the command just used comes first");
    await app.press("Escape");
    await paletteClosed(app);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("palette: second level (Tab) – Esc goes back, “Delete …” deletes after confirmation", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await openPalette(app);
    await paletteSearch(app, "@erledigt", (option) => option.key === "ref:refs/heads/erledigt");
    await app.press("Tab");
    await app.waitFor(`${PALETTE} [data-stage]`, 5000, { message: "second level chip" });
    const actions = await paletteOptions(app);
    assert(actions.every((option) => option.kind === "action"), "second level lists actions");
    const titles = actions.map((option) => option.text.replace(/ Action$/, ""));
    for (const wanted of ["Check out", "Merge into “main”", "Show in graph", "Copy name", "Delete …"]) assert(titles.some((title) => title.startsWith(wanted)), `action “${wanted}” in ${titles.join(" | ")}`);
    assertEqual(await paletteValue(app), "", "input empty in the second level");

    // Esc: back to the first level with the previous text, the branch stays selected.
    await app.press("Escape");
    await app.waitFor(async () => (await app.$$(`${PALETTE} [data-stage]`)).length === 0, 5000, { message: "back on the first level" });
    assertEqual(await paletteValue(app), "@erledigt", "previous text restored");
    assertEqual((await paletteOptions(app)).find((option) => option.selected)?.key, "ref:refs/heads/erledigt", "branch still selected");

    // Again into the second level, filter for "delete".
    await app.press("Tab");
    await app.waitFor(`${PALETTE} [data-stage]`, 5000);
    await paletteSearch(app, "delete", (option) => option.key === "action:refs/heads/erledigt:delete");
    await t.shot("palette-second-level-delete");
    await app.press("Enter");
    await paletteClosed(app);
    const info = await waitDialog(app, /erledigt|Delete/i);
    assertIncludes(info.text, "erledigt", "confirmation names the branch");
    await app.waitFor(async () => (await focusInfo(app)).inDialog, 5000, { message: "focus in the confirmation" });
    const confirm = info.buttons.find((button) => /^Delete/.test(button.text));
    assert(confirm, `delete button in ${JSON.stringify(info.buttons)}`);
    await dialogButton(app, confirm.text);
    await noDialog(app);
    await eventually(() => repo.branches(), ["feature/luftdruck", "konflikt", "main"], "erledigt deleted (git)");
    await app.waitFor(async () => !(await app.$(branchRow("erledigt"))), 10_000, { message: "erledigt gone from the sidebar" });
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("palette: commits (#) reveal in the graph, files (/) open the file view", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openPalette(app);
    await paletteSearch(app, "#");
    await app.waitFor(async () => /Search commits/.test((await paletteText(app)) ?? ""), 5000, { message: "commit scope empty state" });
    await paletteSearch(app, "kalibrieren", (option) => option.kind === "commit" && option.key === `commit:${repo.shas.f2}`);
    await app.press("Enter");
    await paletteClosed(app);
    await app.waitFor(async () => {
      const selection = (await view(app, tabId))?.selection;
      return selection?.kind === "commits" && selection.shas[0] === repo.shas.f2;
    }, 10_000, { message: "commit f2 selected in the graph" });

    await openPalette(app);
    // luftdruck.txt only exists on feature/luftdruck: the file list is the working tree (main).
    await paletteSearch(app, "/luftdruck.txt");
    await app.waitFor(async () => /Nothing found for “luftdruck.txt”/.test((await paletteText(app)) ?? ""), 5000, { message: "file of another branch not offered" });
    await paletteReplace(app, "/werte");
    await app.waitFor(async () => (await paletteOptions(app)).find((option) => option.selected)?.key === "file:werte.txt", 10_000, { message: "werte.txt found" });
    await app.press("Enter");
    await paletteClosed(app);
    const fileView = await app.waitFor('[data-screen="file-view"]', 10_000, { message: "file view" });
    assertIncludes(await fileView.attr("aria-label"), "werte.txt", "file view shows werte.txt");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("palette: no match, special characters and a very long input", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await openPalette(app);
    await paletteSearch(app, "zzqx(*[\\?");
    await app.waitFor(async () => /Nothing found for “zzqx\(\*\[\\\?”/.test((await paletteText(app)) ?? ""), 5000, { message: "“Nothing found” empty state" });
    assertEqual((await paletteOptions(app)).length, 0, "no options");
    assertIncludes(await paletteText(app), "narrow it down with a prefix", "hint about the prefixes");
    await t.shot("palette-nothing-found");
    // Enter on an empty list does nothing (palette stays open, no error).
    await app.press("Enter");
    await sleep(300);
    assertEqual((await app.$$(PALETTE)).length, 1, "palette stays open on Enter without a match");

    await paletteReplace(app, `${"Ä€😀".repeat(40)}${"x".repeat(400)}`);
    await app.waitFor(async () => /Nothing found/.test((await paletteText(app)) ?? ""), 5000, { message: "long input: empty state" });
    await paletteReplace(app, "");
    await app.waitFor(async () => (await paletteOptions(app)).length > 20, 5000, { message: "list back after clearing" });
    await app.press("Escape");
    await paletteClosed(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("palette: without a repository – scopes explain, disabled commands give the reason", "edge", async (t) => {
  const app = await t.launch(LAUNCH);
  await openPalette(app);
  await paletteSearch(app, "@");
  await app.waitFor(async () => /No repository open/.test((await paletteText(app)) ?? ""), 5000, { message: "“No repository open”" });
  assertIncludes(await paletteText(app), "Branches and tags are only available in a repository tab", "scope explanation");
  await paletteReplace(app, "/");
  await app.waitFor(async () => /Files are only available in a repository tab/.test((await paletteText(app)) ?? ""), 5000, { message: "files scope explanation" });

  await paletteReplace(app, ">find file");
  const options = await app.waitFor(async () => {
    const list = await paletteOptions(app);
    // The list follows the text through useDeferredValue: wait for the final result (only this
    // command) – a late list update after Enter clears the notice again.
    return list.length === 1 && list[0].key === "command:palette.files" && list[0].selected ? list : null;
  }, 5000, { message: "“Find file …” listed as the only result" });
  await app.settle(400);
  const findFile = options.find((option) => option.key === "command:palette.files");
  assert(findFile.disabled, "“Find file …” is disabled without a repository");
  assertIncludes(findFile.text, "Only in a repository tab", "reason in the row");
  await app.press("Enter");
  const notice = await app.waitFor(() => app.exec((root) => document.querySelector(`${root} [data-notice]`)?.innerText ?? null, PALETTE), 5000, { message: "notice after Enter" });
  assertMatch(notice, /“Find file …” is not available right now: Only in a repository tab/, "notice text");
  assertEqual((await app.$$(PALETTE)).length, 1, "palette stays open");
  await t.shot("palette-disabled-command-notice");
  await app.press("Escape");
  await paletteClosed(app);
  await t.noConsoleErrors(app);
});

scenario("palette: arrows and Ctrl+P move the selection, Esc returns the focus", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    // Focus into the sidebar onto the "konflikt" row.
    await app.press("Alt+1");
    await app.waitFor(async () => (await focusInfo(app)).area === "left", 5000, { message: "focus in the sidebar" });
    await app.click(branchRow("konflikt"));
    await app.waitFor(async () => (await focusInfo(app)).rowId === "refs/heads/konflikt", 5000, { message: "focus on konflikt" });

    await openPalette(app);
    const selectedIndex = async () => (await paletteOptions(app)).findIndex((option) => option.selected);
    assertEqual(await selectedIndex(), 0, "first option selected");
    await app.press("ArrowDown", "ArrowDown");
    assertEqual(await selectedIndex(), 2, "two down");
    await app.press("Control+p");
    assertEqual(await selectedIndex(), 3, "Ctrl+P inside the palette moves down");
    await app.press("Control+Shift+p");
    assertEqual(await selectedIndex(), 2, "Ctrl+Shift+P moves up");
    await app.press("ArrowUp", "ArrowUp", "ArrowUp");
    // Wraps around at the top onto the last option (the list is virtualized and scrolls there).
    const afterWrap = await app.waitFor(async () => {
      const list = await paletteOptions(app);
      return list.length && list[list.length - 1].selected ? list : null;
    }, 5000, { message: "ArrowUp on the first option wraps to the last one" });
    assert(afterWrap.filter((option) => option.selected).length === 1, "exactly one option selected");
    await app.press("Escape");
    await paletteClosed(app);
    await app.waitFor(async () => (await focusInfo(app)).rowId === "refs/heads/konflikt", 5000, { message: "focus back on the konflikt row" });
    assertEqual(repo.branch(), "main", "nothing checked out");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("palette: shortcuts read as Ctrl/Strg text on Linux, never as macOS glyphs", "main", async (t) => {
  const MAC_GLYPHS = /[⌘⌥⇧⌃↩]/;
  for (const [lang, ctrl] of [["en", "Ctrl"], ["de", "Strg"]]) {
    const app = await t.launch({ ...LAUNCH, lang });
    await openPalette(app, "F1");
    const settingsKeys = await app.waitFor(
      () => app.exec((root) => {
        const row = document.querySelector(`${root} [role="option"][data-key="command:app.preferences"]`);
        return row ? [...row.querySelectorAll("kbd")].map((kbd) => kbd.textContent) : null;
      }, PALETTE),
      5000,
      { message: `settings command listed (${lang})` },
    );
    assertEqual(settingsKeys, [ctrl, ","], `settings shortcut as key caps (${lang})`);
    const caps = await app.exec((root) => [...document.querySelectorAll(`${root} kbd`)].map((kbd) => kbd.textContent), PALETTE);
    assert(caps.includes(ctrl), `palette shows ${ctrl} (${lang}): ${caps.join(" ")}`);
    await app.type(PALETTE_INPUT, lang === "de" ? "Voriger Bereich" : "Previous area");
    const shiftKeys = await app.waitFor(
      () => app.exec((root) => {
        const row = document.querySelector(`${root} [role="option"][data-key="command:focus.previous"]`);
        return row ? [...row.querySelectorAll("kbd")].map((kbd) => kbd.textContent) : null;
      }, PALETTE),
      5000,
      { message: `previous-area command listed (${lang})` },
    );
    assertEqual(shiftKeys, ["Shift", "F6"], `Shift shortcut as key caps (${lang})`);
    const glyphs = caps.filter((cap) => MAC_GLYPHS.test(cap));
    assertEqual(glyphs, [], `no macOS glyph among the key caps (${lang})`);
    assert(!MAC_GLYPHS.test(await paletteText(app)), `no macOS glyph in the palette text (${lang})`);
    await t.shot(`palette-linux-keys-${lang}`);
    await app.press("Escape");
    await paletteClosed(app);

    // The shortcut overview names the same keys the same way.
    await app.press("Control+/");
    await app.waitFor('[data-screen="shortcuts"]', 5000, { message: `shortcut overlay (${lang})` });
    const overview = await app.exec(() => document.querySelector('[data-screen="shortcuts"]')?.innerText ?? "");
    assertIncludes(overview, ctrl, `overview shows ${ctrl} (${lang})`);
    assert(!MAC_GLYPHS.test(overview), `no macOS glyph in the shortcut overview (${lang})`);
    await app.press("Control+/");
    await t.noConsoleErrors(app);
    await app.close();
  }
});

scenario("palette: on Linux the palette button and the commands settings carry no ⌘ icon", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    const commandIcons = () => app.exec(() => document.querySelectorAll("svg.lucide-command").length);

    // Toolbar: the palette button ("Commands") draws the neutral prompt icon.
    const paletteButton = await app.waitFor(
      () => app.exec(() => {
        // The toolbar button holds its label and, for screen readers, the hint ("Command palette").
        const button = [...document.querySelectorAll("button")].find((node) => node.textContent.trim().startsWith("Commands"));
        return button ? [...button.querySelectorAll("svg")].map((svg) => svg.getAttribute("class")) : null;
      }),
      5000,
      { message: "palette button in the toolbar" },
    );
    assert(paletteButton.some((cls) => /lucide-square-chevron-right/.test(cls)), `palette button icon: ${paletteButton.join(" | ")}`);
    assert(!paletteButton.some((cls) => /lucide-command/.test(cls)), "no lucide-command icon on the palette button");
    assertEqual(await commandIcons(), 0, "no lucide-command icon in the window");
    assertEqual(await app.exec(() => document.querySelector("[data-left-filter]")?.getAttribute("aria-keyshortcuts")), "Control+Alt+F", "sidebar filter announces standard key names");

    // Settings: the “Custom commands” nav entry.
    await app.press("Control+,");
    const navIcon = await app.waitFor(
      () => app.exec(() => {
        const tab = document.querySelector('[role="tab"][id$="-trigger-commands"]');
        return tab ? [...tab.querySelectorAll("svg")].map((svg) => svg.getAttribute("class")).join(" ") : null;
      }),
      5000,
      { message: "commands entry in the settings navigation" },
    );
    assertMatch(navIcon, /lucide-square-chevron-right/, "commands nav icon");
    assert(!/lucide-command/.test(navIcon), "no lucide-command icon on the commands nav entry");
    assertEqual(await commandIcons(), 0, "no lucide-command icon with the settings open");
    await t.shot("settings-commands-icon-linux");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[role="tab"][id$="-trigger-commands"]')), 5000, { message: "settings closed" });

    // Shortcut overview: the “open palette” button.
    await app.press("Control+/");
    await app.waitFor('[data-screen="shortcuts"]', 5000, { message: "shortcut overlay" });
    assertEqual(await commandIcons(), 0, "no lucide-command icon in the shortcut overview");
    await app.press("Control+/");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Keyboard shortcuts (1.0)
// ---------------------------------------------------------------------------------------------

scenario("shortcuts: Ctrl+/ shows every shortcut, the filter finds keys", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await app.press("Control+/");
    const overlay = await app.waitFor('[data-screen="shortcuts"]', 5000, { message: "shortcut overlay" });
    const entries = await app.exec(() => [...document.querySelectorAll('[data-screen="shortcuts"] [data-entry]')].map((node) => node.dataset.entry));
    for (const id of ["app.palette", "palette.commands", "focus.next", "terminal.focus", "view.terminal", "app.shortcuts"]) assertIncludes(entries, id, "entry listed");
    const paletteEntry = await app.exec(() => document.querySelector('[data-screen="shortcuts"] [data-entry="palette.commands"]')?.innerText.replace(/\s+/g, " "));
    assertMatch(paletteEntry, /F1/, "F1 shown for “Run command”");
    await app.waitFor(async () => (await focusInfo(app)).tag === "INPUT", 5000, { message: "focus in the filter field" });
    await app.type('[data-screen="shortcuts"] input', "terminal");
    await app.waitFor(async () => {
      const visible = await app.exec(() => [...document.querySelectorAll('[data-screen="shortcuts"] [data-entry]')].map((node) => node.dataset.entry));
      return visible.includes("terminal.focus") && !visible.includes("app.palette") ? visible : null;
    }, 5000, { message: "filter keeps only terminal entries" });
    await t.shot("shortcuts-overlay-filter-terminal");
    await app.press("Control+a", "Backspace");
    await app.type('[data-screen="shortcuts"] input', "qqqzz");
    await app.waitFor(async () => /No shortcut matches “qqqzz”/.test(await overlay.text().catch(() => "")) || /No shortcut matches/.test(await app.exec(() => document.querySelector('[data-screen="shortcuts"]')?.innerText ?? "")), 5000, { message: "empty state" });
    // Ctrl+/ again closes it.
    await app.press("Control+/");
    await app.waitFor(async () => !(await app.$('[data-screen="shortcuts"]')), 5000, { message: "overlay closed with Ctrl+/" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("shortcuts: panels, tabs, zoom and settings react to their keys", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app, tabId } = await start(t, repo);
    // Ctrl+J / Ctrl+K: sidebar and commit panel.
    await app.press("Control+j");
    await app.waitFor(async () => (await view(app, tabId)).leftCollapsed === true && !(await visibleArea(app, "left")), 5000, { message: "sidebar hidden" });
    await app.press("Control+k");
    await app.waitFor(async () => (await view(app, tabId)).rightCollapsed === true && !(await visibleArea(app, "right")), 5000, { message: "commit panel hidden" });
    await t.shot("shortcuts-panels-hidden");
    await app.press("Control+j", "Control+k");
    await app.waitFor(async () => (await visibleArea(app, "left")) && (await visibleArea(app, "right")), 5000, { message: "both panels back" });

    // Ctrl+T new tab, Ctrl+Tab switches, Ctrl+1 goes back, Ctrl+W closes.
    await app.press("Control+t");
    await app.waitFor(async () => (await tabs(app)).length === 2, 5000, { message: "second tab" });
    const [first, second] = await tabs(app);
    assertEqual([first.active, second.active], [false, true], "new tab is active");
    await app.press("Control+Tab");
    await app.waitFor(async () => (await tabs(app))[0].active, 5000, { message: "Ctrl+Tab back to the first tab" });
    await app.press("Control+2");
    await app.waitFor(async () => (await tabs(app))[1].active, 5000, { message: "Ctrl+2 to the second tab" });
    await app.press("Control+w");
    await app.waitFor(async () => {
      const list = await tabs(app);
      return list.length === 1 && list[0].id === first.id && list[0].active;
    }, 5000, { message: "Ctrl+W closed the new tab" });

    // Zoom: Ctrl+= in, Ctrl+- out, Ctrl+0 reset – stored in the core settings.
    const zoom = async () => (await app.invoke("settings_get", {})).zoom;
    const before = await zoom();
    assertEqual(before, 1, "zoom starts at 100 %");
    await app.press("Control+=");
    await app.waitFor(async () => (await zoom()) > 1, 5000, { message: "zoom in stored" });
    await app.waitFor(async () => /11\d %|1[1-9]0 %/.test(await app.exec(() => document.body.innerText.match(/\d+ %/)?.[0] ?? "")), 5000, { message: "status bar shows the zoom" }).catch(() => undefined);
    await app.press("Control+-", "Control+-");
    await app.waitFor(async () => (await zoom()) < 1, 5000, { message: "zoom out stored" });
    await app.press("Control+0");
    await app.waitFor(async () => (await zoom()) === 1, 5000, { message: "zoom reset" });

    // Ctrl+, opens the settings, Esc closes them.
    await app.press("Control+,");
    await app.waitFor('[data-screen="settings"]', 5000, { message: "settings open" });
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="settings"]')), 5000, { message: "settings closed" });
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("shortcuts: while a dialog is open or a field has the focus, global keys stay off", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app, tabId } = await start(t, repo);
    // Dialog open: Ctrl+J, Ctrl+T and Ctrl+P do nothing.
    const button = await app.waitFor(() => app.byText("Branch", { within: '[data-shell] > [role="toolbar"]' }), 10_000, { message: "toolbar button Branch" });
    await button.click();
    await waitDialog(app, /^New branch$/);
    await app.press("Control+j", "Control+t", "Control+p", "F1");
    await sleep(500);
    assertEqual((await view(app, tabId)).leftCollapsed, false, "Ctrl+J ignored while the dialog is open");
    assertEqual((await tabs(app)).length, 1, "Ctrl+T ignored while the dialog is open");
    assertEqual((await app.$$(PALETTE)).length, 0, "no palette over the dialog");
    assert((await focusInfo(app)).inDialog, "focus stays in the dialog");
    await app.press("Escape");
    await noDialog(app);
    assertEqual(repo.branches(), ["erledigt", "feature/luftdruck", "konflikt", "main"], "no branch created (git)");

    // Commit message field: plain letters are text, not shortcuts; Ctrl shortcuts still work.
    await app.press("Alt+m");
    await app.waitFor(async () => (await app.exec(() => document.activeElement?.hasAttribute("data-commit-summary"))) === true, 5000, { message: "Alt+M: focus in the summary" });
    await app.type("[data-commit-summary]", "s u j ?");
    assertEqual(await app.exec(() => document.querySelector("[data-commit-summary]").value), "s u j ?", "letters land in the field");
    assertEqual((await app.$$('[data-screen="shortcuts"]')).length, 0, "“?” typed, no overlay");
    await openPalette(app, "Control+p");
    await app.press("Escape");
    await paletteClosed(app);
    await app.waitFor(async () => (await app.exec(() => document.activeElement?.hasAttribute("data-commit-summary"))) === true, 5000, { message: "focus back in the summary after the palette" });
    assertEqual(await app.exec(() => document.querySelector("[data-commit-summary]").value), "s u j ?", "text kept");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Focus with dialogs (1.0)
// ---------------------------------------------------------------------------------------------

scenario("focus: F6 / Shift+F6 cycle the areas, Alt+1/2/3 jump", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await app.press("Alt+2");
    await app.waitFor(async () => (await focusInfo(app)).area === "center", 5000, { message: "Alt+2: view" });
    const order = [];
    for (let step = 0; step < 4; step++) {
      await app.press("F6");
      await sleep(150);
      order.push((await focusInfo(app)).area);
    }
    assertEqual(order, ["right", "toolbar", "left", "center"], "F6 order");
    await app.press("Shift+F6");
    await app.waitFor(async () => (await focusInfo(app)).area === "left", 5000, { message: "Shift+F6 back to the sidebar" });
    await app.press("Alt+3");
    await app.waitFor(async () => (await focusInfo(app)).area === "right", 5000, { message: "Alt+3: commit panel" });
    await app.press("Alt+1");
    await app.waitFor(async () => (await focusInfo(app)).area === "left", 5000, { message: "Alt+1: sidebar" });
    // Remembered position: arrow down in the sidebar, away and back.
    await app.press("ArrowDown");
    const remembered = (await focusInfo(app)).label;
    await app.press("Alt+2", "Alt+1");
    await app.waitFor(async () => (await focusInfo(app)).label === remembered, 5000, { message: "Alt+1 returns to the last position in the sidebar" });
    await t.shot("focus-sidebar-row");
    // Alt+1 on a hidden sidebar shows it again.
    await app.press("Control+j");
    await app.waitFor(async () => !(await visibleArea(app, "left")), 5000, { message: "sidebar hidden" });
    await app.press("Alt+1");
    await app.waitFor(async () => (await visibleArea(app, "left")) && (await focusInfo(app)).area === "left", 5000, { message: "Alt+1 expands the sidebar and focuses it" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("focus: a dialog keeps the focus and gives it back when it closes", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    // Focus on a commit row in the graph.
    await app.click(`${commitRow(repo.shas.c2)} [data-cell="message"]`);
    await app.waitFor(async () => (await focusInfo(app)).rowId === repo.shas.c2, 5000, { message: "focus on commit c2" });

    // Palette → "Create branch at selected commit …" opens a dialog that gets the focus.
    await openPalette(app);
    await paletteSearch(app, "create branch at selected", (option) => option.key === "command:commit.branchHere");
    await app.press("Enter");
    await waitDialog(app, /branch/i);
    await app.waitFor(async () => {
      const focus = await focusInfo(app);
      return focus.inDialog && focus.tag === "INPUT";
    }, 5000, { message: "dialog input has the focus" });
    // F6, Alt+1, Tab cycling: the focus never leaves the dialog.
    await app.press("F6");
    assert((await focusInfo(app)).inDialog, "F6 does not leave the dialog");
    await app.press("Alt+1");
    assert((await focusInfo(app)).inDialog, "Alt+1 does not leave the dialog");
    for (let step = 0; step < 8; step++) {
      await app.press("Tab");
      assert((await focusInfo(app)).inDialog, `Tab ${step + 1} stays in the dialog`);
    }
    await t.shot("focus-dialog-trap");
    await app.press("Escape");
    await noDialog(app);
    await app.waitFor(async () => (await focusInfo(app)).rowId === repo.shas.c2, 5000, { message: "focus back on commit c2 after the dialog" });
    assertEqual(repo.branches(), ["erledigt", "feature/luftdruck", "konflikt", "main"], "nothing created (git)");

    // Confirmation dialog on top of the focus in the sidebar: Cancel returns the focus to the row.
    await app.press("Alt+1");
    await app.click(branchRow("konflikt"));
    await app.waitFor(async () => (await focusInfo(app)).rowId === "refs/heads/konflikt", 5000);
    await openPalette(app);
    await paletteSearch(app, "@konflikt", (option) => option.key === "ref:refs/heads/konflikt");
    await app.press("Tab");
    await paletteSearch(app, "delete", (option) => option.key === "action:refs/heads/konflikt:delete");
    await app.press("Enter");
    const info = await waitDialog(app, /konflikt|Delete/i);
    await app.waitFor(async () => (await focusInfo(app)).inDialog, 5000, { message: "focus in the confirmation" });
    const cancel = info.buttons.find((button) => button.text === "Cancel");
    assert(cancel, `Cancel button in ${JSON.stringify(info.buttons)}`);
    await dialogButton(app, "Cancel");
    await noDialog(app);
    await app.waitFor(async () => (await focusInfo(app)).rowId === "refs/heads/konflikt", 5000, { message: "focus back on the konflikt row" });
    assertIncludes(repo.branches(), "konflikt", "konflikt still exists (git)");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Terminal (1.0)
// ---------------------------------------------------------------------------------------------

scenario("terminal: Ctrl+` opens a shell in the repository, Git commands there update the app", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app, tabId } = await start(t, repo, { env: shellEnv() });
    await openTerminal(app, tabId);
    const header = await app.exec((selector) => document.querySelector(`${selector} header`)?.innerText ?? "", TERMINAL);
    assertIncludes(header, repo.path, "header shows the repository path");
    await term.run(app, "pwd");
    await term.waitText(app, tabId, new RegExp(`\\n${fs.realpathSync(repo.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`));

    await term.run(app, "git switch -q -c aus-dem-terminal && echo 'Notiz aus dem Terminal' > notiz.txt && git add notiz.txt && git commit -q -m 'Notiz aus dem Terminal' && echo DONE-$((40+2))");
    await term.waitText(app, tabId, /DONE-42/);
    assertEqual(repo.branch(), "aus-dem-terminal", "branch switched (git)");
    assertEqual(repo.subject(), "Notiz aus dem Terminal", "commit created (git)");
    const head = repo.head();
    await app.waitFor(commitRow(head), 15_000, { message: "graph shows the commit from the terminal" });
    await app.waitFor(async () => (await (await app.$(branchRow("aus-dem-terminal")))?.attr("aria-current")) === "true", 15_000, { message: "sidebar: new branch checked out" });
    assert(await term.focused(app), "focus stays in the terminal");
    await t.shot("terminal-git-commands");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("terminal: hiding keeps the shell, Alt+4 goes in, F6 goes out", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app, tabId } = await start(t, repo, { env: shellEnv() });
    await openTerminal(app, tabId);
    await term.run(app, "MARKE=behalten-$((6*7)); echo $MARKE");
    await term.waitText(app, tabId, /behalten-42/);
    // Tab goes to the shell, not to the next control.
    await app.press("Tab");
    assert(await term.focused(app), "Tab stays in the terminal");
    // Ctrl+` from inside hides it; the shell keeps running.
    await app.press("Control+`");
    await app.waitFor(async () => !(await app.$(TERMINAL)), 5000, { message: "terminal hidden" });
    assertEqual((await view(app, tabId)).terminalOpen, false, "store: terminal closed");
    assertEqual(await term.status(app, tabId), "running", "shell keeps running while hidden");
    assert((await focusInfo(app)).area !== null, "focus moved somewhere sensible after hiding");
    // Alt+4 shows it again and puts the focus in; the variable is still set (same shell).
    await app.press("Alt+4");
    await app.waitFor(async () => (await app.$(TERMINAL)) && (await term.focused(app)), 10_000, { message: "Alt+4: terminal visible and focused" });
    await term.run(app, "echo noch-da-$MARKE");
    await term.waitText(app, tabId, /noch-da-behalten-42/);
    // F6 leaves the terminal, Shift+F6 comes back.
    await app.press("F6");
    await app.waitFor(async () => (await focusInfo(app)).area === "right", 5000, { message: "F6 from the terminal to the commit panel" });
    await app.press("Shift+F6");
    await app.waitFor(() => term.focused(app), 5000, { message: "Shift+F6 back into the terminal" });
    await app.press("Alt+2");
    await app.waitFor(async () => (await focusInfo(app)).area === "center", 5000, { message: "Alt+2 from the terminal into the view" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("terminal: shell ends with exit, restart, ending asks first (cancel keeps it)", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app, tabId } = await start(t, repo, { env: shellEnv() });
    await openTerminal(app, tabId);
    await term.run(app, "exit 3");
    await term.waitStatus(app, tabId, "exited");
    const footer = await app.waitFor(() => app.exec((selector) => document.querySelector(`${selector} footer`)?.innerText.replace(/\s+/g, " ") ?? null, TERMINAL), 5000, { message: "exit footer" });
    assertMatch(footer, /3/, "exit code shown");
    await app.waitFor(async () => (await app.exec(() => document.activeElement?.getAttribute("data-action"))) === "restart-shell", 5000, { message: "focus on Restart after the shell ended" });
    await t.shot("terminal-exited");
    await app.press("Enter");
    await term.waitStatus(app, tabId, "running");
    await app.waitFor(() => term.focused(app), 10_000, { message: "focus back in the restarted shell" });
    await term.run(app, "echo neu-$((1+1))");
    await term.waitText(app, tabId, /neu-2/);

    // End session while the shell runs: confirmation; Cancel keeps everything.
    await app.click(`${TERMINAL} button[data-action="end"]`);
    const info = await waitDialog(app, /terminal|session/i);
    assert(info.buttons.some((button) => button.text === "Cancel"), "Cancel offered");
    await dialogButton(app, "Cancel");
    await noDialog(app);
    assertEqual(await term.status(app, tabId), "running", "Cancel: shell still running");
    assert(await app.$(TERMINAL), "Cancel: panel still shown");

    // End via the palette command, confirmed: panel gone, session gone.
    await openPalette(app);
    await paletteSearch(app, "end terminal", (option) => option.key === "command:terminal.end");
    await app.press("Enter");
    const again = await waitDialog(app, /terminal|session/i);
    const confirm = again.buttons.find((button) => button.text !== "Cancel" && !button.disabled);
    await dialogButton(app, confirm.text);
    await noDialog(app);
    await app.waitFor(async () => !(await app.$(TERMINAL)), 5000, { message: "terminal panel gone" });
    await app.waitFor(async () => (await term.status(app, tabId)) === null, 5000, { message: "session disposed" });
    // Now the session commands explain themselves in the palette.
    await openPalette(app);
    await paletteSearch(app, ">restart terminal");
    const restart = await app.waitFor(async () => (await paletteOptions(app)).find((option) => option.key === "command:terminal.restart"), 5000, { message: "Restart terminal listed" });
    assert(restart.disabled, "Restart terminal disabled without a session");
    assertIncludes(restart.text, "No terminal is running in this tab", "reason");
    await app.press("Escape");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
