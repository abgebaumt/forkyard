/**
 * Custom commands and the command line in the real app over WebDriver (1.1):
 * global commands (Settings → Custom commands: editor, edit, delete, import/export), the
 * repository file `.forkyard/commands.json` with its hash-bound approval, the three kinds
 * (program, Git, web address), the input form, the confirmation before a run, failing and
 * cancelled runs – and the `forkyard` command line (`--help`, `--version`, handing a folder to
 * the running instance, "Install command-line command" for the AppImage).
 * Every result is checked in the UI and in Git / on disk.
 *
 *   node scripts/e2e-wd/features/custom-commands.mjs
 *   E2E_WD_ONLY="approval" node scripts/e2e-wd/features/custom-commands.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { def, makeCommandsRepo, writeCommandFile } from "../fixtures/custom-commands.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const commitRow = (sha) => `[data-row-id="${sha}"]`;
const commitCell = (sha) => `[data-row-id="${sha}"] [data-cell="message"]`;
const branchRow = (name) => `[data-row-id="refs/heads/${name}"]`;

async function start(t, repo, options = {}) {
  const app = await t.launch({ ...LAUNCH, ...options });
  const ids = await app.openRepo(repo.path);
  await app.waitFor(commitRow(repo.head()), 20_000, { message: "HEAD commit row" });
  return { app, ...ids };
}

const pointerActions = (actions) => ({ actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
async function perform(app, body) {
  await app.webdriver("POST", "/actions", body);
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** Moves the mouse out of the way (no hover tooltip in screenshots), then shoots. */
async function shot(t, name, app = t.app) {
  await perform(app, pointerActions([{ type: "pointerMove", origin: "viewport", x: 5, y: 450 }]));
  await sleep(250);
  return t.shot(name, app);
}

async function pointOf(app, css) {
  return app.waitFor(
    () =>
      app.exec((selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        el.scrollIntoView({ block: "nearest" });
        const box = el.getBoundingClientRect();
        if (box.width === 0) return null;
        return { x: Math.round(box.left + Math.min(60, box.width / 2)), y: Math.round(box.top + box.height / 2) };
      }, css),
    10_000,
    { message: `element ${css}` },
  );
}

/** Right-click on the element and wait for the context menu. */
async function contextMenu(app, css) {
  const { x, y } = await pointOf(app, css);
  await perform(app, pointerActions([{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 }]));
  await app.waitFor('[role="menu"]', 5000, { message: "context menu open" });
}

/** Items of the open menus: [{ text, title, disabled }]. */
const menuItems = (app) =>
  app.exec(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => ({
      text: item.innerText.replace(/\s+/g, " ").trim(),
      title: item.getAttribute("title") ?? "",
      disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
    })),
  );

async function menuElement(app, pattern) {
  return app.waitFor(
    async () => {
      const items = await menuItems(app);
      const index = items.findIndex((item) => pattern.test(item.text));
      if (index < 0) return null;
      return (await app.$$('[role="menu"] [role^="menuitem"]'))[index] ?? null;
    },
    8000,
    { message: `menu item ${pattern}` },
  ).catch(async (error) => {
    throw new Error(`${error.message}; menu: ${(await menuItems(app)).map((item) => item.text).join(" | ")}`);
  });
}

/** Opens the submenu "Custom commands" of the open context menu (hover + ArrowRight). */
async function openCustomSubmenu(app) {
  const trigger = await menuElement(app, /^Custom commands/);
  const menusBefore = (await app.$$('[role="menu"]')).length;
  const box = await trigger.rect();
  await perform(app, pointerActions([{ type: "pointerMove", origin: "viewport", x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) }]));
  const opened = () => app.waitFor(async () => (await app.$$('[role="menu"]')).length > menusBefore, 3000, { message: "submenu open" });
  await opened().catch(async () => {
    await app.press("ArrowRight");
    await opened().catch(async () => {
      await app.click(trigger);
      await opened();
    });
  });
}

/** Items of the last (innermost) open menu. */
const submenuItems = (app) =>
  app.exec(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const last = menus[menus.length - 1];
    return [...(last?.querySelectorAll('[role^="menuitem"]') ?? [])].map((item) => ({
      text: item.innerText.replace(/\s+/g, " ").trim(),
      title: item.getAttribute("title") ?? "",
      disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
    }));
  });

async function chooseSubmenu(app, pattern) {
  const items = await submenuItems(app);
  const index = items.findIndex((item) => pattern.test(item.text));
  assert(index >= 0, `submenu item ${pattern} missing; submenu: ${items.map((item) => item.text).join(" | ")}`);
  assert(!items[index].disabled, `submenu item ${pattern} is disabled`);
  const element = await app.exec((position) => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    return menus[menus.length - 1].querySelectorAll('[role^="menuitem"]')[position];
  }, index);
  await app.click(element);
}

const noMenu = (app) => app.waitFor(async () => (await app.$$('[role="menu"]')).length === 0, 5000, { message: "menu closed" });

/** The open dialog: { title, text, buttons[] }. */
const dialogInfo = (app) =>
  app.exec(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
    if (!dialog) return null;
    return {
      title: dialog.querySelector("h2")?.innerText.trim() ?? "",
      text: dialog.innerText.replace(/\s+/g, " ").trim(),
      buttons: [...dialog.querySelectorAll("button")].map((button) => button.innerText.trim()).filter(Boolean),
    };
  });

const waitDialog = (app, pattern, timeout = 10_000) =>
  app.waitFor(async () => {
    const info = await dialogInfo(app);
    return info && pattern.test(info.title) ? info : null;
  }, timeout, { message: `dialog ${pattern}` }).catch(async (error) => {
    throw new Error(`${error.message}; open: ${JSON.stringify(await dialogInfo(app))}`);
  });

const dialogCount = (app) => app.exec(() => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length);

/** Clicks a button of the last open dialog by its exact text. */
async function dialogButton(app, text) {
  const button = await app.waitFor(
    () =>
      app.exec((wanted) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
        return [...(dialog?.querySelectorAll("button") ?? [])].find((el) => el.innerText.trim() === wanted && !el.disabled) ?? null;
      }, text),
    8000,
    { message: `dialog button “${text}”` },
  );
  await app.click(button);
}

/** The input/textarea of the last open dialog (or `root`) whose label is exactly `label`. */
const fieldByLabel = (app, label, index = 0) =>
  app.waitFor(
    () =>
      app.exec((wanted, position) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop() ?? document;
        const labels = [...dialog.querySelectorAll("label[for]")].filter((node) => node.textContent.trim() === wanted);
        const found = labels[position];
        return found ? document.getElementById(found.htmlFor) : null;
      }, label, index),
    8000,
    { message: `field “${label}”` },
  );

/**
 * WebKitWebDriver drops the Shift of "send keys" once a pointer action with the right button ran in
 * the session (">" arrives as ".", "A" as "a"). Key actions with an explicit Shift still work.
 */
const SHIFTED = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:\"<>?"]);
async function typeKeys(app, text) {
  const actions = [];
  for (const char of text) {
    if (SHIFTED.has(char)) actions.push({ type: "keyDown", value: "\uE008" }, { type: "keyDown", value: char }, { type: "keyUp", value: char }, { type: "keyUp", value: "\uE008" });
    else actions.push({ type: "keyDown", value: char }, { type: "keyUp", value: char });
  }
  await app.webdriver("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions }] });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** Types into a focused field; falls back to key actions if "send keys" lost the Shift. */
async function typeInto(app, field, text, expected) {
  await app.type(field, text);
  if ((await field.prop("value")) === expected) return;
  await app.click(field);
  await app.press("Control+a", "Backspace");
  await typeKeys(app, text);
  assertEqual(await field.prop("value"), expected, "typed value");
}

/** Replaces the value of a text field (select all, then type). */
async function fill(app, label, text, index = 0) {
  const field = await fieldByLabel(app, label, index);
  await app.click(field);
  await app.press("Control+a", "Backspace");
  if (text) await typeInto(app, field, text, text);
  return field;
}

/** Ticks/unticks a checkbox (role=checkbox) of the last dialog by its label. */
async function setCheckbox(app, label, on) {
  const box = await fieldByLabel(app, label);
  if (((await box.attr("aria-checked")) === "true") !== on) await app.click(box);
}

/** Chooses a segment (role=radio) of the last dialog by its text. */
async function chooseSegment(app, text) {
  const radio = await app.waitFor(
    () => app.exec((wanted) => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
      return [...(dialog?.querySelectorAll('[role="radio"]') ?? [])].find((node) => node.textContent.trim() === wanted) ?? null;
    }, text),
    5000,
    { message: `segment “${text}”` },
  );
  await app.click(radio);
}

/** Opens a Radix select (combobox with this label) and picks the option with this text. */
async function chooseSelect(app, label, option, index = 0) {
  const trigger = await fieldByLabel(app, label, index);
  await app.click(trigger);
  const item = await app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent.trim() === wanted) ?? null, option), 5000, { message: `option “${option}”` });
  await app.click(item);
  await app.waitFor(() => app.exec(() => !document.querySelector('[role="listbox"]')), 5000, { message: "select closed" });
}

/** Toasts shown now: [{ tone, text }]. */
const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.getAttribute("data-toast"), text: el.innerText.replace(/\s+/g, " ").trim() })));

const waitToast = (app, tone, pattern, timeout = 15_000) =>
  app.waitFor(async () => (await toasts(app)).find((toast) => toast.tone === tone && pattern.test(toast.text)) ?? null, timeout, { message: `${tone} toast ${pattern}` }).catch(async (error) => {
    throw new Error(`${error.message}; toasts: ${JSON.stringify(await toasts(app))}`);
  });

async function noDangerToasts(app) {
  assertEqual((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error message");
}

async function closeToasts(app) {
  await app.exec(() => {
    for (const button of document.querySelectorAll('[data-toast] button[aria-label="Close message"]')) button.click();
  });
  await app.waitFor(() => app.exec(() => document.querySelectorAll("[data-toast]").length === 0), 5000, { message: "toasts closed" }).catch(() => undefined);
}

/** Clicks the action button of a toast (e.g. "Show output"). */
async function toastAction(app, text) {
  const button = await app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll("[data-toast] button")].find((node) => node.innerText.trim() === wanted) ?? null, text), 8000, { message: `toast button “${text}”` });
  await app.click(button);
}

/** Opens the command palette with ">text"; returns the data-keys of the command entries. */
async function paletteKeys(app, text) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await typeInto(app, input, `>${text}`, `>${text}`);
  await app.settle();
  await sleep(200);
  return app.exec(() => [...document.querySelectorAll('[data-screen="command-palette"] [role="option"]')].map((node) => node.dataset.key));
}

async function closePalette(app) {
  await app.press("Escape");
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** Runs a command through the palette (Ctrl+P, ">text", click on the entry with that id). */
async function runFromPalette(app, text, id) {
  await paletteKeys(app, text);
  const option = await app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` }).catch(async (error) => {
    const keys = await app.exec(() => [...document.querySelectorAll('[data-screen="command-palette"] [role="option"]')].map((node) => node.dataset.key));
    throw new Error(`${error.message}; entries: ${keys.join(", ")}`);
  });
  await app.click(option);
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** Settings → "Custom commands" (via the palette's "Settings" entry and the section tab). */
async function openCommandSettings(app) {
  await runFromPalette(app, "Settings", "app.preferences");
  const tab = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.trim() === "Custom commands") ?? null), 10_000, { message: "settings tab Custom commands" });
  await app.click(tab);
  await app.waitFor('[data-section="custom-commands"]', 10_000);
  await app.settle();
}

async function closeSettings(app) {
  await app.press("Escape");
  await app.waitFor(async () => (await dialogCount(app)) === 0, 8000, { message: "settings closed" });
}

/** Button of the custom commands section by text (`within`: a CSS selector inside the section). */
async function sectionButton(app, text, within = '[data-section="custom-commands"]') {
  const button = await app.waitFor(() => app.exec((scope, wanted) => [...(document.querySelector(scope)?.querySelectorAll("button") ?? [])].find((node) => node.innerText.trim() === wanted && !node.disabled) ?? null, within, text), 8000, { message: `button “${text}” in ${within}` });
  await app.click(button);
}

/** Titles of the commands listed in the "Your commands" card (global) – data-custom-command ids. */
const globalRows = (app) =>
  app.exec(() => {
    const cards = [...document.querySelectorAll('[data-section="custom-commands"] section')];
    const own = cards.find((card) => card.querySelector("h3")?.textContent.trim() === "Your commands");
    return [...(own?.querySelectorAll("[data-custom-command]") ?? [])].map((row) => row.dataset.customCommand);
  });

const repoState = (app) => app.exec(() => document.querySelector("[data-repo-commands]")?.dataset.repoCommands ?? null);
const repoCardText = (app) => app.exec(() => document.querySelector("[data-repo-commands]")?.innerText.replace(/\s+/g, " ").trim() ?? "");

/** Polls until `read()` returns `expected` (JSON comparison). */
async function eventually(read, expected, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return last;
    if (Date.now() > deadline) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`);
    await sleep(150);
  }
}

const saveGlobal = (app, commands) => app.invoke("custom_commands_save", { commands });
const listCommands = (app, repoId) => app.invoke("custom_commands_list", { repoId });

/** Waits until the UI's query for the command list knows these keys (palette and menus read it). */
async function waitCommandKeys(app, repoId, keys) {
  await app.exec(() => window.dispatchEvent(new Event("focus")));
  await eventually(
    () => app.exec((id) => (window.__gc.queryClient.getQueryData(["repo", id, "customCommands"])?.commands ?? []).map((entry) => `${entry.key}:${entry.runnable}`), repoId),
    keys,
    "custom command list in the UI",
  );
}

// ---------------------------------------------------------------------------------------------
// Global commands (Settings → Custom commands)
// ---------------------------------------------------------------------------------------------

scenario("create a global program command in the editor and run it from the palette", "main", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await openCommandSettings(app);
    assertIncludes(await app.exec(() => document.querySelector('[data-section="custom-commands"]').innerText), "No custom commands yet.", "empty state");

    t.step("New command: title, id, kind Program, command line, palette");
    await sectionButton(app, "New command");
    await waitDialog(app, /^New custom command$/);
    await fill(app, "Title", "Messprotokoll anlegen");
    await fill(app, "ID", "protokoll");
    await chooseSegment(app, "Program");
    await fill(app, "Program and arguments", "touch protokoll-${branch}.txt");
    await setCheckbox(app, "Command palette", true);
    await dialogButton(app, "Save");
    await waitToast(app, "success", /“Messprotokoll anlegen” saved\./);
    await app.waitFor(async () => (await dialogCount(app)) === 1, 8000, { message: "editor closed" });
    assertEqual(await globalRows(app), ["protokoll"], "the command is listed");
    const rowText = await app.exec(() => document.querySelector('[data-custom-command="protokoll"]').innerText.replace(/\s+/g, " "));
    assertIncludes(rowText, "touch protokoll-${branch}.txt", "row shows the command line");
    assertIncludes(rowText, "Program", "row shows the kind");
    await shot(t, "global-command-created");

    t.step("stored in the core (global)");
    const stored = await listCommands(app, null);
    assertEqual(stored.commands.map((entry) => [entry.key, entry.source, entry.runnable]), [["global:protokoll", "global", true]], "core list");
    assertEqual(stored.commands[0].command.run, "touch protokoll-${branch}.txt", "stored command line");

    t.step("run from the palette");
    await closeSettings(app);
    await closeToasts(app);
    await waitCommandKeys(app, repoId, ["global:protokoll:true"]);
    await runFromPalette(app, "Messprotokoll", "custom.global:protokoll");
    await waitToast(app, "success", /“Messprotokoll anlegen” finished\./);
    assert(repo.exists("protokoll-main.txt"), "the program ran in the repository with ${branch} = main");
    await shot(t, "global-command-ran");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("editor rejects invalid definitions and Cancel saves nothing", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app } = await start(t, repo);
    await openCommandSettings(app);
    await sectionButton(app, "New command");
    await waitDialog(app, /^New custom command$/);

    t.step("empty title and command");
    await fill(app, "Title", "");
    await fill(app, "Program and arguments", "");
    await dialogButton(app, "Save");
    await sleep(300);
    let text = (await dialogInfo(app)).text;
    assertIncludes(text, "Enter a title.", "title error");
    assertIncludes(text, "Enter the command.", "command error");

    t.step("Git kind: leading git, unknown placeholder; bad id");
    await fill(app, "Title", "Kaputt");
    await fill(app, "ID", "Gross Buchstaben");
    await chooseSegment(app, "Git");
    await fill(app, "Git arguments (without “git”)", "git log ${nirgends}");
    await dialogButton(app, "Save");
    await sleep(300);
    text = (await dialogInfo(app)).text;
    assertMatch(text, /Use lowercase letters, digits, “\.”, “_” and “-”/, "id error");
    assertMatch(text, /Leave out “git” at the start|Unknown placeholder/, "git prefix / placeholder error");
    await fill(app, "Git arguments (without “git”)", "log ${nirgends}");
    await dialogButton(app, "Save");
    await sleep(300);
    assertIncludes((await dialogInfo(app)).text, "Unknown placeholder: ${nirgends}", "placeholder error");

    t.step("web address must be http(s)");
    await chooseSegment(app, "Web address");
    await fill(app, "Web address", "file:///etc/passwd");
    await dialogButton(app, "Save");
    await sleep(300);
    assertIncludes((await dialogInfo(app)).text, "A web address starts with http:// or https://.", "url error");
    await shot(t, "editor-validation");

    t.step("Cancel");
    await dialogButton(app, "Cancel");
    await app.waitFor(async () => (await dialogCount(app)) === 1, 8000, { message: "editor closed" });
    assertEqual(await globalRows(app), [], "nothing saved (UI)");
    assertEqual((await listCommands(app, null)).commands, [], "nothing saved (core)");

    t.step("the core rejects what the UI would let through, too");
    const error = await saveGlobal(app, [def({ id: "boese", title: "Böse", kind: "url", run: "javascript:alert(1)" })]).then(() => null, (e) => e);
    assert(error, "saving a javascript: address must fail");
    assertEqual((await listCommands(app, null)).commands, [], "still nothing saved");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("edit and delete a global command", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [def({ id: "notiz", title: "Notiz schreiben", kind: "shell", run: "touch notiz.txt" })]);
    await openCommandSettings(app);
    await app.waitFor('[data-custom-command="notiz"]', 8000);

    t.step("edit: new title and command line");
    await sectionButton(app, "Edit", '[data-custom-command="notiz"]');
    await waitDialog(app, /^Edit “Notiz schreiben”$/);
    await fill(app, "Title", "Notiz ablegen");
    await fill(app, "Program and arguments", "touch abgelegt.txt");
    await dialogButton(app, "Save");
    await waitToast(app, "success", /“Notiz ablegen” saved\./);
    const stored = (await listCommands(app, null)).commands;
    assertEqual(stored.map((entry) => [entry.command.id, entry.command.title, entry.command.run]), [["notiz", "Notiz ablegen", "touch abgelegt.txt"]], "changed in the core");
    await closeSettings(app);
    await waitCommandKeys(app, repoId, ["global:notiz:true"]);
    await runFromPalette(app, "Notiz ablegen", "custom.global:notiz");
    await waitToast(app, "success", /“Notiz ablegen” finished\./);
    assert(repo.exists("abgelegt.txt") && !repo.exists("notiz.txt"), "the edited command line ran");

    t.step("delete with confirmation: Cancel keeps it, Delete removes it");
    await closeToasts(app);
    await openCommandSettings(app);
    await sectionButton(app, "Delete", '[data-custom-command="notiz"]');
    await waitDialog(app, /^Delete “Notiz ablegen”\?$/);
    await dialogButton(app, "Cancel");
    await sleep(300);
    assertEqual(await globalRows(app), ["notiz"], "kept after Cancel");
    await sectionButton(app, "Delete", '[data-custom-command="notiz"]');
    await waitDialog(app, /^Delete “Notiz ablegen”\?$/);
    await dialogButton(app, "Delete command");
    await waitToast(app, "success", /“Notiz ablegen” deleted\./);
    await eventually(() => globalRows(app), [], "row removed");
    assertEqual((await listCommands(app, null)).commands, [], "removed in the core");
    await closeSettings(app);
    await waitCommandKeys(app, repoId, []);
    const keys = await paletteKeys(app, "Notiz ablegen");
    assert(!keys.includes("command:custom.global:notiz"), `no palette entry any more: ${keys.join(", ")}`);
    await closePalette(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("export and import custom commands as JSON", "main", async (t) => {
  const repo = makeCommandsRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-cc-io-"));
  try {
    const { app } = await start(t, repo);
    await saveGlobal(app, [
      def({ id: "ci", title: "CI öffnen", kind: "url", run: "https://ci.example.com/builds?branch=${branch}", scope: ["branch"] }),
      def({ id: "notiz", title: "Notiz", kind: "shell", run: "touch notiz.txt" }),
    ]);
    await openCommandSettings(app);

    t.step("export");
    const exportPath = path.join(dir, "forkyard-commands.json");
    await app.exec((target) => {
      window.__gcTestSaves = [target];
    }, exportPath);
    await sectionButton(app, "Export…");
    await waitToast(app, "success", /^Saved to /);
    const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    assertEqual(exported.version, 1, "format version");
    assertEqual(exported.commands.map((command) => command.id), ["ci", "notiz"], "exported ids");
    assertEqual(exported.commands[0].run, "https://ci.example.com/builds?branch=${branch}", "exported command line");

    t.step("import: one replaced, one new");
    const importPath = writeCommandFile(dir, [
      def({ id: "notiz", title: "Notiz (neu)", kind: "shell", run: "touch notiz-neu.txt" }),
      def({ id: "tag-heute", title: "Tag setzen", kind: "git", run: "tag heute ${sha}", confirm: true, scope: ["commit"] }),
    ]);
    await app.pick(importPath);
    await sectionButton(app, "Import…");
    await waitToast(app, "success", /Imported: 1 new, 1 replaced\./);
    await eventually(() => globalRows(app), ["ci", "notiz", "tag-heute"], "rows after import");
    const stored = (await listCommands(app, null)).commands.map((entry) => [entry.command.id, entry.command.title]);
    assertEqual(stored, [["ci", "CI öffnen"], ["notiz", "Notiz (neu)"], ["tag-heute", "Tag setzen"]], "core list after import");
    assertIncludes(await app.exec(() => document.querySelector('[data-custom-command="tag-heute"]').innerText), "Asks first", "confirm badge");
    await shot(t, "export-import");

    t.step("import an invalid file: error, nothing changes");
    await closeToasts(app);
    const broken = path.join(dir, "kaputt.json");
    fs.writeFileSync(broken, "{ \"version\": 1, \"commands\": [ { \"id\": ");
    await app.pick(broken);
    await sectionButton(app, "Import…");
    await waitToast(app, "danger", /Import custom commands|couldn|invalid|JSON/i);
    assertEqual((await listCommands(app, null)).commands.length, 3, "nothing changed after a broken import");

    t.step("import cancelled in the file dialog: nothing happens");
    await closeToasts(app);
    await app.pick(null);
    await sectionButton(app, "Import…");
    await sleep(500);
    assertEqual((await toasts(app)).length, 0, "no message after cancel");
    await app.errors();
    // The deliberately broken import logs its error; only that one is accepted.
    const unexpected = app.consoleErrors.filter((entry) => !/Import custom commands|json|JSON|EOF/i.test(JSON.stringify(entry)));
    assertEqual(unexpected, [], "no unexpected console errors");
  } finally {
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Repository file .forkyard/commands.json with approval
// ---------------------------------------------------------------------------------------------

scenario("repository commands need approval of exactly this file version", "main", async (t) => {
  const repo = makeCommandsRepo();
  try {
    repo.writeCommands([
      def({ id: "bericht", title: "Bericht erzeugen", kind: "shell", run: "touch bericht-${branch}.txt", scope: ["repo", "commit"] }),
    ]);
    repo.commit("Befehle für das Repository");
    const { app, repoId } = await start(t, repo);

    t.step("not approved: no palette entry, menu entry blocked, the core refuses");
    await waitCommandKeys(app, repoId, ["repo:bericht:false"]);
    await paletteKeys(app, "Bericht erzeugen");
    const option = await app.waitFor('[data-screen="command-palette"] [role="option"][data-key="command:custom.repo:bericht"]', 8000);
    assertEqual(await option.attr("aria-disabled"), "true", "palette entry is disabled before approval");
    assertIncludes(await app.exec((node) => node.innerText, option), "Not approved for this repository", "palette names the reason");
    await app.click(option);
    await app.waitFor(() => app.exec(() => document.querySelector('[data-screen="command-palette"]')?.innerText.includes("Not approved for this repository") ?? false), 5000, { message: "palette notice" });
    await closePalette(app);
    await contextMenu(app, commitCell(repo.head()));
    await openCustomSubmenu(app);
    const items = await submenuItems(app);
    const entry = items.find((item) => item.text.startsWith("Bericht erzeugen"));
    assert(entry, `menu entry missing: ${JSON.stringify(items)}`);
    assert(entry.disabled || /not approved/.test(entry.text + entry.title), `menu entry is blocked: ${JSON.stringify(entry)}`);
    await app.press("Escape", "Escape");
    await noMenu(app).catch(() => app.press("Escape"));
    const refused = await app.invoke("custom_command_run", { repoId, id: "repo:bericht", context: {}, inputs: {}, jobId: "probe-1", confirmed: true }).then(() => null, (e) => e);
    assertEqual(refused?.code, "command_untrusted", "the core refuses the unapproved command");
    assert(!repo.exists("bericht-main.txt"), "nothing ran");

    t.step("approve in the settings");
    await openCommandSettings(app);
    assertEqual(await repoState(app), "untrusted", "state untrusted");
    assertIncludes(await repoCardText(app), "Not approved", "banner");
    assertIncludes(await repoCardText(app), "touch bericht-${branch}.txt", "the command line is shown before approval");
    await shot(t, "repo-commands-untrusted");
    await sectionButton(app, "Approve commands");
    await waitToast(app, "success", /Repository commands approved\./);
    await eventually(() => repoState(app), "trusted", "state trusted");
    const hash = (await listCommands(app, repoId)).repo.hash;
    assertMatch(hash, /^[0-9a-f]{64}$/, "SHA-256 of the file");
    await closeSettings(app);
    await closeToasts(app);

    t.step("approved: runs from the palette");
    await waitCommandKeys(app, repoId, ["repo:bericht:true"]);
    await runFromPalette(app, "Bericht erzeugen", "custom.repo:bericht");
    await waitToast(app, "success", /“Bericht erzeugen” finished\./);
    assert(repo.exists("bericht-main.txt"), "the repository command ran");

    t.step("the file changes: approval is gone, the changes are listed");
    await closeToasts(app);
    repo.writeCommands([
      def({ id: "bericht", title: "Bericht erzeugen", kind: "shell", run: "touch bericht-geaendert.txt", scope: ["repo", "commit"] }),
      def({ id: "aufraeumen", title: "Aufräumen", kind: "git", run: "gc --auto" }),
    ]);
    await waitCommandKeys(app, repoId, ["repo:bericht:false", "repo:aufraeumen:false"]);
    const again = await app.invoke("custom_command_run", { repoId, id: "repo:bericht", context: {}, inputs: {}, jobId: "probe-2", confirmed: true }).then(() => null, (e) => e);
    assertEqual(again?.code, "command_untrusted", "changed file is not approved");
    assert(!repo.exists("bericht-geaendert.txt"), "nothing ran after the change");
    await openCommandSettings(app);
    await eventually(() => repoState(app), "changed", "state changed");
    const card = await repoCardText(app);
    assertIncludes(card, "Changed since your approval", "banner names the change");
    assertIncludes(card, "Changed: Bericht erzeugen", "changed command listed");
    assertIncludes(card, "− touch bericht-${branch}.txt", "old line");
    assertIncludes(card, "+ touch bericht-geaendert.txt", "new line");
    assertIncludes(card, "New: Aufräumen", "added command listed");
    await shot(t, "repo-commands-changed");

    t.step("approve again, then withdraw");
    await sectionButton(app, "Approve commands");
    await eventually(() => repoState(app), "trusted", "trusted again");
    assert((await listCommands(app, repoId)).repo.hash !== hash, "new hash approved");
    await sectionButton(app, "Withdraw approval");
    await waitToast(app, "success", /Approval withdrawn\./);
    await eventually(() => repoState(app), "untrusted", "untrusted after withdrawing");
    await closeSettings(app);
    await waitCommandKeys(app, repoId, ["repo:bericht:false", "repo:aufraeumen:false"]);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("repository file problems: shell true, invalid JSON, link", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    repo.writeCommands([
      def({ id: "gut", title: "Gut", kind: "shell", run: "touch gut.txt" }),
      def({ id: "boese", title: "Böse Shell", kind: "shell", run: "echo hallo | tee boese.txt", shell: true }),
    ]);
    const { app, repoId } = await start(t, repo);

    t.step("shell: true is rejected in a repository file");
    const list = await listCommands(app, repoId);
    assertEqual(list.commands.map((entry) => entry.key), ["repo:gut"], "only the valid command is listed");
    assert(list.repo.problems.length >= 1, `a problem is reported: ${JSON.stringify(list.repo)}`);
    await openCommandSettings(app);
    const text = await repoCardText(app);
    assertMatch(text, /shell/i, "the problem names shell");
    await shot(t, "repo-file-problems");
    await closeSettings(app);

    t.step("invalid JSON");
    repo.writeCommands("{ \"version\": 1, \"commands\": [ ");
    await eventually(async () => (await listCommands(app, repoId)).commands.length, 0, "no commands from a broken file");
    const broken = (await listCommands(app, repoId)).repo;
    assert(broken.problems.length >= 1, `broken file reported: ${JSON.stringify(broken)}`);
    const error = await app.invoke("custom_commands_trust", { repoId, hash: "0".repeat(64) }).then(() => null, (e) => e);
    assert(error, "approving a hash that is not the file's must fail");

    t.step("a symlinked file is not followed");
    fs.rmSync(repo.commandsFile);
    const outside = path.join(repo.root, "fremd.json");
    fs.writeFileSync(outside, JSON.stringify({ version: 1, commands: [def({ id: "fremd", title: "Fremd", kind: "shell", run: "touch fremd.txt" })] }));
    fs.symlinkSync(outside, repo.commandsFile);
    await eventually(async () => (await listCommands(app, repoId)).commands.map((entry) => entry.key), [], "link not followed");
    const linked = (await listCommands(app, repoId)).repo;
    assert(linked.hash === null, `no hash for a link: ${JSON.stringify(linked)}`);
    await app.errors();
    const unexpected = app.consoleErrors.filter((entry) => !/custom_commands_trust|hash|approv/i.test(JSON.stringify(entry)));
    assertEqual(unexpected, [], "no unexpected console errors");
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Kinds, inputs, confirmation
// ---------------------------------------------------------------------------------------------

const TAG_COMMAND = def({
  id: "tag-release",
  title: "Release markieren",
  kind: "git",
  run: "tag -a ${input:name} -m ${input:name} ${sha}",
  confirm: true,
  inputs: [{ id: "name", label: "Tag name", type: "text", default: null, options: [] }],
  scope: ["commit"],
});

scenario("Git command from the commit menu with input form and confirmation", "main", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [TAG_COMMAND]);
    await waitCommandKeys(app, repoId, ["global:tag-release:true"]);
    const target = repo.shas.c2;

    t.step("Cancel in the confirmation: nothing happens");
    await contextMenu(app, commitCell(target));
    await openCustomSubmenu(app);
    await chooseSubmenu(app, /^Release markieren/);
    await waitDialog(app, /^Release markieren$/);
    await fill(app, "Tag name", "v1.0-mess");
    await dialogButton(app, "Run");
    const confirmInfo = await waitDialog(app, /^Run “Release markieren”\?$/);
    assertIncludes(confirmInfo.text, `tag -a v1.0-mess -m v1.0-mess ${target}`, "the finished command with the selected commit");
    assertIncludes(confirmInfo.text, repo.path, "the working directory");
    await shot(t, "git-command-confirm");
    await dialogButton(app, "Cancel");
    await app.waitFor(async () => (await dialogCount(app)) === 0, 8000, { message: "dialogs closed" });
    assertEqual(repo.tags(), ["v0.1"], "no tag after Cancel");

    t.step("Run in the confirmation: the tag points to the selected commit");
    await contextMenu(app, commitCell(target));
    await openCustomSubmenu(app);
    await chooseSubmenu(app, /^Release markieren/);
    await waitDialog(app, /^Release markieren$/);
    await fill(app, "Tag name", "v1.0-mess");
    await dialogButton(app, "Run");
    await waitDialog(app, /^Run “Release markieren”\?$/);
    await dialogButton(app, "Run");
    await waitToast(app, "success", /“Release markieren” finished\./);
    assertEqual(repo.tags(), ["v0.1", "v1.0-mess"], "tag created (git)");
    assertEqual(repo.git("rev-parse", "v1.0-mess^{commit}"), target, "tag at the selected commit");
    assertEqual(repo.git("cat-file", "-t", "v1.0-mess"), "tag", "annotated tag");
    await app.waitFor(() => app.exec(() => document.body.innerText.includes("v1.0-mess")), 15_000, { message: "graph shows the new tag" });
    await shot(t, "git-command-done");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("confirmation shows the complete finished command line", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [{ ...TAG_COMMAND, scope: ["repo"] }]);
    await waitCommandKeys(app, repoId, ["global:tag-release:true"]);
    await runFromPalette(app, "Release markieren", "custom.global:tag-release");
    await waitDialog(app, /^Release markieren$/);
    await fill(app, "Tag name", "v2.0");
    await dialogButton(app, "Run");
    await waitDialog(app, /^Run “Release markieren”\?$/);
    const line = await app.waitFor(() => app.exec(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
      const item = [...(dialog?.querySelectorAll('[role="listitem"]') ?? [])].find((node) => node.textContent.startsWith("git tag"));
      return item ? { text: item.textContent, scroll: item.scrollWidth, client: item.clientWidth } : null;
    }), 5000, { message: "command line in the confirmation" });
    assertEqual(line.text, `git tag -a v2.0 -m v2.0 ${repo.head()}`, "the finished command");
    await t.shot("confirm-command-truncated");
    // What the user is asked to approve must be readable without hovering: the commit at the end
    // of the line (or any argument after it) is cut off with an ellipsis today.
    assert(line.scroll <= line.client + 1, `the command line is cut off in the confirmation (scrollWidth ${line.scroll} > clientWidth ${line.client}); only a tooltip shows the rest`);
    await dialogButton(app, "Cancel");
    assertEqual(repo.tags(), ["v0.1"], "nothing ran");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Git command: a value starting with - never becomes an option; cancel the form", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [{ ...TAG_COMMAND, confirm: false, scope: ["repo"] }]);
    await waitCommandKeys(app, repoId, ["global:tag-release:true"]);

    t.step("Cancel in the input form: nothing runs");
    await runFromPalette(app, "Release markieren", "custom.global:tag-release");
    await waitDialog(app, /^Release markieren$/);
    await dialogButton(app, "Cancel");
    await app.waitFor(async () => (await dialogCount(app)) === 0, 8000, { message: "form closed" });
    await sleep(300);
    assertEqual(repo.tags(), ["v0.1"], "nothing ran");

    t.step("Escape in the input form: nothing runs");
    await runFromPalette(app, "Release markieren", "custom.global:tag-release");
    await waitDialog(app, /^Release markieren$/);
    await app.press("Escape");
    await app.waitFor(async () => (await dialogCount(app)) === 0, 8000, { message: "form closed by Escape" });
    assertEqual(repo.tags(), ["v0.1"], "nothing ran after Escape");

    t.step("value -d (would delete a tag as option)");
    await runFromPalette(app, "Release markieren", "custom.global:tag-release");
    await waitDialog(app, /^Release markieren$/);
    await fill(app, "Tag name", "-d");
    await dialogButton(app, "Run");
    await waitToast(app, "danger", /./);
    assertEqual(repo.tags(), ["v0.1"], "no tag changed or deleted");
    await shot(t, "git-option-rejected");
    await app.errors();
    const unexpected = app.consoleErrors.filter((entry) => !/custom_command_run|option|-d|Release markieren/i.test(JSON.stringify(entry)));
    assertEqual(unexpected, [], "no unexpected console errors");
  } finally {
    repo.cleanup();
  }
});

scenario("web address command from the branch menu opens the encoded address", "main", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [def({ id: "ci", title: "CI-Lauf öffnen", kind: "url", run: "https://ci.example.com/builds?branch=${branch}&sha=${sha}", scope: ["branch"] })]);
    await waitCommandKeys(app, repoId, ["global:ci:true"]);
    await app.exec(() => {
      window.__gcTestOpened = [];
    });
    await app.waitFor(branchRow("feature/luftdruck"), 10_000, { message: "branch in the sidebar" });
    await contextMenu(app, branchRow("feature/luftdruck"));
    await openCustomSubmenu(app);
    await t.shot("url-command-menu");
    await chooseSubmenu(app, /^CI-Lauf öffnen/);
    const opened = await app.waitFor(() => app.exec(() => (window.__gcTestOpened?.length ? window.__gcTestOpened : null)), 10_000, { message: "address opened" });
    // Documented: ${sha} is the selected commit, otherwise HEAD – the branch menu selects no commit.
    const head = repo.head();
    assertEqual(opened, [`https://ci.example.com/builds?branch=feature%2Fluftdruck&sha=${head}`], "branch percent-encoded, sha falls back to HEAD");
    assertEqual(repo.branch(), "main", "nothing checked out");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("input form with text, choice and checkbox; every value stays one argument", "main", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [
      def({
        id: "dateien",
        title: "Messdateien anlegen",
        kind: "shell",
        run: "touch ${input:station}.txt ${input:name} ${input:extra}",
        inputs: [
          { id: "station", label: "Station", type: "choice", default: "nord", options: ["nord", "sued", "hafen"] },
          { id: "name", label: "Dateiname", type: "text", default: "bericht.txt", options: [] },
          { id: "extra", label: "Zusatzdatei anlegen", type: "checkbox", default: "false", options: ["zusatz.txt"] },
        ],
      }),
    ]);
    await waitCommandKeys(app, repoId, ["global:dateien:true"]);

    t.step("form shows defaults");
    await runFromPalette(app, "Messdateien", "custom.global:dateien");
    await waitDialog(app, /^Messdateien anlegen$/);
    assertEqual(await (await fieldByLabel(app, "Dateiname")).prop("value"), "bericht.txt", "text default");
    assertEqual(await (await fieldByLabel(app, "Zusatzdatei anlegen")).attr("aria-checked"), "false", "checkbox default");

    t.step("choose hafen, a name with spaces and ; rm, tick the checkbox");
    await chooseSelect(app, "Station", "hafen");
    await fill(app, "Dateiname", "Bericht März; rm -rf werte.txt");
    await setCheckbox(app, "Zusatzdatei anlegen", true);
    await shot(t, "input-form");
    await dialogButton(app, "Run");
    await waitToast(app, "success", /“Messdateien anlegen” finished\./);
    assert(repo.exists("hafen.txt"), "choice inside an argument");
    assert(repo.exists("Bericht März; rm -rf werte.txt"), "the text became exactly one file name");
    assert(repo.exists("werte.txt"), "no shell: werte.txt still exists");
    assert(repo.exists("zusatz.txt"), "ticked checkbox passes its value");
    const untracked = repo.git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort();
    assertEqual(untracked, ["Bericht März; rm -rf werte.txt", "hafen.txt", "zusatz.txt"], "exactly these files (git)");

    t.step("unticked checkbox is left out");
    fs.rmSync(path.join(repo.path, "zusatz.txt"));
    await closeToasts(app);
    await runFromPalette(app, "Messdateien", "custom.global:dateien");
    await waitDialog(app, /^Messdateien anlegen$/);
    await dialogButton(app, "Run");
    await waitToast(app, "success", /“Messdateien anlegen” finished\./);
    assert(repo.exists("nord.txt") && repo.exists("bericht.txt"), "defaults used");
    assert(!repo.exists("zusatz.txt") && !repo.exists("false"), "unticked: no extra argument");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("failing program reports the exit code and its output", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [def({ id: "kaputt", title: "Revision prüfen", kind: "shell", run: "git rev-parse --verify gibt-es-nicht" })]);
    await waitCommandKeys(app, repoId, ["global:kaputt:true"]);
    await runFromPalette(app, "Revision prüfen", "custom.global:kaputt");
    const toast = await waitToast(app, "danger", /“Revision prüfen” ended with exit code 128\./);
    assertIncludes(toast.text, "Show output", "output can be shown");
    await toastAction(app, "Show output");
    const output = await waitDialog(app, /^Revision prüfen$/);
    assertMatch(output.text, /Needed a single revision|fatal/, "Git's message is shown");
    await shot(t, "failed-command-output");
    await app.press("Escape");
    await app.waitFor(async () => (await dialogCount(app)) === 0, 8000, { message: "output closed" });

    t.step("a program that does not exist");
    await closeToasts(app);
    await saveGlobal(app, [def({ id: "fehlt", title: "Fehlt", kind: "shell", run: "gibt-es-nicht-programm-xyz --hilfe" })]);
    await waitCommandKeys(app, repoId, ["global:fehlt:true"]);
    await runFromPalette(app, "Fehlt", "custom.global:fehlt");
    await waitToast(app, "danger", /Fehlt|not found|could/i);
    await app.errors();
    const unexpected = app.consoleErrors.filter((entry) => !/Fehlt|gibt-es-nicht|custom_command_run|not found/i.test(JSON.stringify(entry)));
    assertEqual(unexpected, [], "no unexpected console errors");
  } finally {
    repo.cleanup();
  }
});

scenario("a long-running program can be cancelled from the status bar", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app, repoId } = await start(t, repo);
    await saveGlobal(app, [def({ id: "warten", title: "Lange Auswertung", kind: "shell", run: "sh -c 'sleep 30; touch fertig.txt'" })]);
    await waitCommandKeys(app, repoId, ["global:warten:true"]);
    const started = Date.now();
    await runFromPalette(app, "Lange Auswertung", "custom.global:warten");
    const cancel = await app.waitFor('button[aria-label^="Cancel"][aria-label*="Lange Auswertung"]', 10_000).catch(async () =>
      app.waitFor(() => app.exec(() => [...document.querySelectorAll("button[aria-label]")].find((node) => /Lange Auswertung/.test(node.getAttribute("aria-label")) && /cancel|stop/i.test(node.getAttribute("aria-label"))) ?? null), 10_000, { message: "cancel button of the job" }),
    );
    await shot(t, "long-command-running");
    await app.click(cancel);
    await waitToast(app, "info", /Lange Auswertung/);
    await app.waitFor(() => app.exec(() => !document.querySelector('[role="progressbar"][aria-label="Lange Auswertung"]')), 15_000, { message: "job gone from the status bar" });
    assert(Date.now() - started < 25_000, "ended well before the program would have");
    await sleep(500);
    assert(!repo.exists("fertig.txt"), "the program did not finish");
    const success = (await toasts(app)).filter((toast) => toast.tone === "success");
    assertEqual(success, [], "no success message after cancelling");
    await app.errors();
    const unexpected = app.consoleErrors.filter((entry) => !/cancel|Lange Auswertung|custom_command_run/i.test(JSON.stringify(entry)));
    assertEqual(unexpected, [], "no unexpected console errors");
  } finally {
    repo.cleanup();
  }
});

scenario("a placeholder inside sh -c is rejected", "edge", async (t) => {
  const repo = makeCommandsRepo();
  try {
    const { app } = await start(t, repo);
    const error = await saveGlobal(app, [def({ id: "inj", title: "Injektion", kind: "shell", run: "sh -c 'touch ${branch}'" })]).then(() => null, (e) => e);
    assert(error, "saving a placeholder in a code argument must fail");
    assertMatch(error.message, /sh|code|placeholder|argument/i, "the reason names it");
    assertEqual((await listCommands(app, null)).commands, [], "nothing saved");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

/** Runs the app binary as the `forkyard` command; never opens a window (no DISPLAY). */
function runCli(binary, args, env = {}, timeout = 20_000) {
  const clean = { ...process.env, ...env };
  delete clean.DISPLAY;
  delete clean.WAYLAND_DISPLAY;
  const started = Date.now();
  const result = spawnSync(binary, args, { env: clean, encoding: "utf8", timeout });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms: Date.now() - started, error: result.error };
}

scenario("forkyard --help and --version answer without a window", "main", async (t) => {
  const app = await t.launch(LAUNCH);
  const binary = app.binary;
  const version = (await app.invoke("app_info")).version;
  await app.close();

  const help = runCli(binary, ["--help"]);
  assertEqual(help.status, 0, `--help exit code (stderr: ${help.stderr})`);
  assertIncludes(help.stdout, "Usage:", "help text");
  assertIncludes(help.stdout, "forkyard [<folder>] [--commit <sha>]", "usage line");
  assertIncludes(help.stdout, "--version", "names --version");
  assert(help.ms < 10_000, `answers quickly (${help.ms} ms)`);

  const short = runCli(binary, ["-h"]);
  assertEqual(short.stdout, help.stdout, "-h is the same");

  const ver = runCli(binary, ["--version"]);
  assertEqual(ver.status, 0, "--version exit code");
  assertEqual(ver.stdout, `forkyard ${version}\n`, "version line");
  assertEqual(runCli(binary, ["-V"]).stdout, ver.stdout, "-V is the same");

  t.step("installer switches are Windows-only");
  const register = runCli(binary, ["--register-path"]);
  assertEqual(register.status, 2, "--register-path on Linux");
  assertIncludes(register.stderr, "only used by the Windows installer", "explains why");
  fs.writeFileSync(path.join(t.shotsDir, "cli-help.txt"), `$ forkyard --help\n${help.stdout}\n$ forkyard --version\n${ver.stdout}`);
});

scenario("forkyard <folder> hands the folder to the running instance", "main", async (t) => {
  const repo = makeCommandsRepo("zweite-station");
  try {
    const app = await t.launch(LAUNCH);
    await app.settle();
    const before = await app.invoke("repo_list").catch(() => []);

    t.step("second process with the same data directory exits and the window opens the repository");
    const started = Date.now();
    const cli = runCli(app.binary, [repo.path, "--commit", repo.shas.c2.slice(0, 8)], { FORKYARD_DATA_DIR: app.dataDir });
    assertEqual(cli.status, 0, `second process exit code (stderr: ${cli.stderr.slice(-400)})`);
    assert(Date.now() - started < 10_000, `the second process ends quickly (${cli.ms} ms)`);
    await app.waitFor(commitRow(repo.head()), 20_000, { message: "graph of the handed-over repository" });
    await app.waitFor(() => app.exec((name) => [...document.querySelectorAll("[data-tab-id] [role=tab]")].some((node) => node.textContent.includes(name)), "zweite-station"), 10_000, { message: "tab of the repository" });
    t.step("--commit selects the commit");
    await app.waitFor(() => app.exec((sha) => document.querySelector(`[data-row-id="${sha}"]`)?.getAttribute("aria-selected") === "true", repo.shas.c2), 15_000, { message: "commit c2 selected" });
    const listed = await app.invoke("repo_list");
    assert(JSON.stringify(listed).includes("zweite-station"), "the repository is now known");
    assert(JSON.stringify(before).length <= JSON.stringify(listed).length, "list grew");
    await shot(t, "cli-forward");

    t.step("a folder that does not exist: warning in the running window");
    const missing = path.join(repo.root, "gibt-es-nicht");
    const second = runCli(app.binary, [missing], { FORKYARD_DATA_DIR: app.dataDir });
    assertEqual(second.status, 0, "handed over as well");
    await waitToast(app, "warning", /The folder was not found/);

    t.step("a folder that is no repository: offer to create one");
    await closeToasts(app);
    const plain = path.join(repo.root, "kein-repo");
    fs.mkdirSync(plain);
    assertEqual(runCli(app.binary, [plain], { FORKYARD_DATA_DIR: app.dataDir }).status, 0, "handed over");
    const toast = await waitToast(app, "warning", /“kein-repo” is not a Git repository/);
    assertIncludes(toast.text, "Create a repository here", "init offered");
    assert(!fs.existsSync(path.join(plain, ".git")), "nothing created by itself");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("install command-line command for the AppImage links ~/.local/bin/forkyard", "main", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-cc-home-")));
  try {
    const image = path.join(home, "Programme", "Forkyard-1.1.0.AppImage");
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, "#!/bin/sh\n");
    const bin = path.join(home, ".local", "bin");
    const app = await t.launch({ ...LAUNCH, env: { APPIMAGE: image, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    await app.settle();
    const status = await app.invoke("cli_status");
    assertEqual(status, { installable: true, installed: false, linkPath: path.join(bin, "forkyard"), onPath: true }, "status before");

    await runFromPalette(app, "Install command-line command", "app.installCli");
    const toast = await waitToast(app, "success", /forkyard/);
    assertIncludes(toast.text, path.join(bin, "forkyard"), "names the link");
    const link = path.join(bin, "forkyard");
    assert(fs.lstatSync(link).isSymbolicLink(), "a symlink");
    assertEqual(fs.readlinkSync(link), image, "points to the AppImage");
    assertEqual((await app.invoke("cli_status")).installed, true, "status after");
    await shot(t, "cli-install");

    t.step("again: stays, no error");
    await closeToasts(app);
    await runFromPalette(app, "Install command-line command", "app.installCli");
    await waitToast(app, "success", /forkyard/);
    assertEqual(fs.readlinkSync(link), image, "still the same link");

    t.step("a real file in the way is never replaced");
    await closeToasts(app);
    fs.rmSync(link);
    fs.writeFileSync(link, "mein eigenes Skript\n");
    await runFromPalette(app, "Install command-line command", "app.installCli");
    await waitToast(app, "danger", /./);
    assertEqual(fs.readFileSync(link, "utf8"), "mein eigenes Skript\n", "own file untouched");
    await app.errors();
    const unexpected = app.consoleErrors.filter((entry) => !/cli_install|exists|forkyard/i.test(JSON.stringify(entry)));
    assertEqual(unexpected, [], "no unexpected console errors");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

scenario("install command-line command where the package manages it: only a hint", "edge", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-cc-home-")));
  try {
    const env = { HOME: home };
    const app = await t.launch({ ...LAUNCH, env });
    await app.settle();
    assertEqual((await app.invoke("cli_status")).installable, false, "not installable without AppImage");
    await runFromPalette(app, "Install command-line command", "app.installCli");
    const toast = await waitToast(app, "info", /./);
    assert(toast.text.length > 0, "a hint");
    assert(!fs.existsSync(path.join(home, ".local", "bin", "forkyard")), "no link created");
    await shot(t, "cli-install-managed");
    await t.noConsoleErrors(app);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

