/**
 * External diff and merge tool: settings, launching from the diff, the file menu and the conflict
 * tool – in the real app, against real Git repositories.
 *
 *   node scripts/e2e/screens/tools.mjs                 everything (checks and screenshots)
 *   node scripts/e2e/screens/tools.mjs --only merge    only sections whose title contains "merge" (comma separates several)
 *   node scripts/e2e/screens/tools.mjs --show          window visible
 *
 * The "tool" is a small Node script that writes its arguments and the content of the files it was
 * given to a JSON file. This checks that the core really starts the program and which versions it
 * gets – compared with `git show`. The "keyboard only" sections do not use the mouse.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeConflictRepo, makeRichRepo } from "../fixtures.mjs";
import { SHOTS, closeToasts, finish, makeChecks, makeDriver } from "./files-lib.mjs";
import { appendAppGitConfig, slash } from "./mustfix-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const checks = makeChecks("tools");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const rich = makeRichRepo({ dirty: true });
const conflict = makeConflictRepo();
const repos = [rich, conflict];

// The stand-in program: writes what it was started with.
const tool = path.join(rich.root, "werkzeug", "zeig mir.mjs");
fs.mkdirSync(path.dirname(tool), { recursive: true });
fs.writeFileSync(
  tool,
  [
    'import fs from "node:fs";',
    "const [out, ...args] = process.argv.slice(2);",
    'const read = (file) => { try { return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null; } catch { return null; } };',
    'fs.writeFileSync(`${out}.tmp`, JSON.stringify({ args, contents: args.map(read), cwd: process.cwd() }));',
    "fs.renameSync(`${out}.tmp`, out);",
    "",
  ].join("\n"),
);
let outCount = 0;
const nextOut = () => path.join(rich.root, "werkzeug", `aufruf-${++outCount}.json`);
const command = (out, placeholders) => `"${process.execPath}" "${tool}" "${out}" ${placeholders}`;
const samePath = (a, b) => path.resolve(a).replaceAll("\\", "/").toLowerCase() === path.resolve(b).replaceAll("\\", "/").toLowerCase();
/** Content of a version according to git, without the final line ending (as the fixture helper returns it). */
const trimEnd = (text) => (text ?? "").replace(/\r?\n$/, "");

const diffScreen = '[data-screen="diff"]';
const conflictScreen = '[data-screen="conflict"]';

let app = null;
try {
  app = await launchApp({ show });
  state.app = app;
  const { page } = app;
  const richTab = await app.openRepo(rich.path);
  const conflictTab = await app.openRepo(conflict.path);
  const use = async (tab) => {
    await app.invoke("tab_activate", { tabId: tab.tabId });
    await page.waitForFunction((id) => document.querySelector(`[data-tab-id="${id}"] [role="tab"]`)?.getAttribute("aria-selected") === "true", tab.tabId);
    await app.settle();
    return makeDriver(app, tab.tabId, checks);
  };
  let ui = await use(richTab);
  const store = (method, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [method, args]);
  const settings = () => app.invoke("settings_get");
  const setSettings = async (patch) => {
    await app.invoke("settings_set", { patch });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await app.settle();
  };
  const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
  const waitCall = async (out, message) => {
    await until(() => fs.existsSync(out), message, 20_000);
    return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { args: [], contents: [] };
  };
  const prefs = page.locator('[data-screen="settings"]');
  const prefRow = (title) => prefs.locator(`[data-setting="${title}"]`);
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  state.resetView = async () => {
    for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await closeToasts(page);
    await app.settle();
  };
  const openDiff = async (tab, file, source) => {
    await store("openDiff", tab.tabId, file, source);
    await page.locator(`${diffScreen} [data-diff-title]`).filter({ hasText: file.slice(file.lastIndexOf("/") + 1) }).waitFor();
    await app.settle();
  };
  const diffButton = page.locator(`${diffScreen} button[data-action="external-diff"]`);

  // -------------------------------------------------------------------------------------------
  await section("Nothing set up: the toast explains it and leads to the settings", async () => {
    ui = await use(richTab);
    equal([(await settings()).externalDiffTool, (await settings()).externalMergeTool], [null, null], "initial state: no diff and no merge tool set");
    await openDiff(richTab, "src/auswertung.py", { kind: "unstaged" });
    equal(await diffButton.getAttribute("aria-label"), "Open in external diff tool", "button in the diff header");
    await diffButton.click();
    await until(async () => (await toasts()).some((toast) => toast.tone === "danger" && toast.text.startsWith("The diff tool could not be started")), "toast: the diff tool could not be started");
    const toast = (await toasts()).find((item) => item.text.startsWith("The diff tool"));
    check(/diff tool/.test(toast?.text ?? "") && /Settings|difftool|diff\.tool/.test(toast?.text ?? ""), `the toast says where to set up the tool (${toast?.text})`);
    await shot("tools-not-configured");
    await page.locator("[data-toast]").getByRole("button", { name: "Set up external programs" }).click();
    await prefs.waitFor();
    equal(await page.getByRole("tab", { selected: true }).innerText(), "External programs", "the settings open in the \"External programs\" section");
    await page.keyboard.press("Escape");
    await store("closeCenter", richTab.tabId);
  });

  // -------------------------------------------------------------------------------------------
  const diffOut = nextOut();
  const diffCommand = command(diffOut, "{local} {remote} {path} {repo}");
  await section("Settings – keyboard only: placeholders explained, enter the command", async () => {
    ui = await use(richTab);
    await page.keyboard.press("Control+,");
    await prefs.waitFor();
    // Section list: arrow down to "External programs".
    for (let step = 0; step < 12 && (await page.evaluate(() => document.activeElement?.textContent?.trim())) !== "External programs"; step++) {
      const previous = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      await page.keyboard.press("ArrowDown");
      // Radix moves focus and selection a moment after the key. Wait until the NEXT section has focus
      // and selection – otherwise the next key would come before this one took effect, and both
      // together would only move one step.
      await page
        .waitForFunction(
          (before) => {
            const element = document.activeElement;
            return element?.getAttribute("role") === "tab" && element.getAttribute("aria-selected") === "true" && (element.textContent ?? "").trim() !== before;
          },
          previous,
          { timeout: 5000 },
        )
        .catch(() => undefined);
    }
    await eventually(() => page.getByRole("tab", { selected: true }).innerText(), "External programs", "arrow keys select the section");
    const diffText = (await prefRow("Diff tool").innerText()).replace(/\s+/g, " ");
    check(diffText.includes("{local} is the old version, {remote} the new one"), "diff tool: {local} and {remote} are explained");
    check(diffText.includes("Empty: git difftool with the tool from your Git configuration"), "diff tool: says what an empty field means");
    check(diffText.includes("Example: meld {local} {remote}"), "diff tool: example with both placeholders");
    const mergeText = (await prefRow("Merge tool").innerText()).replace(/\s+/g, " ");
    for (const part of ["{base} is the common ancestor", "{local} your version", "{remote} the incoming one", "{merged} the file the result goes into", "Example: kdiff3 {base} {local} {remote} -o {merged}"]) {
      check(mergeText.includes(part), `merge tool: explains "${part}"`);
    }
    equal(await prefRow("Diff tool").locator("input").getAttribute("placeholder"), "git difftool (diff.tool from your Git configuration)", "empty field: placeholder text names the default");
    await shot("tools-settings");

    // Tab into the "Diff tool" field (the field gets its label through <label for>).
    for (let step = 0; step < 30; step++) {
      const label = await page.evaluate(() => document.activeElement?.labels?.[0]?.textContent ?? null);
      if (label === "Diff tool") break;
      await page.keyboard.press("Tab");
    }
    equal(await page.evaluate(() => document.activeElement?.labels?.[0]?.textContent ?? null), "Diff tool", "Tab reaches the \"Diff tool\" field");
    await page.keyboard.insertText(diffCommand);
    await page.keyboard.press("Enter");
    await eventually(async () => (await settings()).externalDiffTool, diffCommand, "the command is saved (settings_get)");
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "Esc closes the settings");
  });

  // -------------------------------------------------------------------------------------------
  await section("Start the diff tool – keyboard only: unstaged change", async () => {
    ui = await use(richTab);
    if ((await settings()).externalDiffTool !== diffCommand) await setSettings({ externalDiffTool: diffCommand });
    fs.rmSync(diffOut, { force: true });
    const file = "src/sensoren.py";
    await store("openDiff", richTab.tabId, file, { kind: "unstaged" });
    await page.locator(`${diffScreen} [data-diff-title]`).filter({ hasText: "sensoren.py" }).waitFor();
    await ui.runCommand("diff in external", "file.externalDiff");
    const call = await waitCall(diffOut, "the diff tool started and wrote its arguments");
    equal(call.args.length, 4, "four arguments: {local} {remote} {path} {repo}");
    equal(trimEnd(call.contents[0]), rich.git("show", `:${file}`), "{local} is a file with the version from the index");
    check(!samePath(call.args[0], path.join(rich.path, file)) && call.args[0].endsWith(".py"), `{local} is a separate file with the same extension (${call.args[0]})`);
    check(samePath(call.args[1], path.join(rich.path, file)), `{remote} is the real file in the working tree (${call.args[1]})`);
    check(samePath(call.args[2], path.join(rich.path, file)), `{path} is the same file (${call.args[2]})`);
    check(samePath(call.args[3], rich.path), `{repo} is the repository (${call.args[3]})`);
    await until(async () => (await toasts()).some((toast) => toast.tone === "info" && toast.text.startsWith("Diff tool started")), "toast \"Diff tool started\"");
    equal((await toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
    await shot("tools-diff-started");
  });

  // -------------------------------------------------------------------------------------------
  await section("Diff tool: staged change, commit through the file menu, new file", async () => {
    ui = await use(richTab);
    const { repoId, tabId } = richTab;
    // Staged: HEAD against index, both as files.
    const stagedOut = nextOut();
    await setSettings({ externalDiffTool: command(stagedOut, "{local} {remote}") });
    await openDiff(richTab, "README.md", { kind: "staged" });
    await diffButton.click();
    let call = await waitCall(stagedOut, "diff tool started (staged)");
    equal(trimEnd(call.contents[0]), rich.git("show", "HEAD:README.md"), "staged: {local} is the version from HEAD");
    equal(trimEnd(call.contents[1]), rich.git("show", ":README.md"), "staged: {remote} is the version from the index");
    check(!samePath(call.args[1], path.join(rich.path, "README.md")), "staged: {remote} is not the file in the working tree");
    await closeToasts(page);

    // Without placeholders: both versions are appended.
    const bareOut = nextOut();
    await setSettings({ externalDiffTool: `"${process.execPath}" "${tool}" "${bareOut}"` });
    await diffButton.click();
    call = await waitCall(bareOut, "diff tool started (without placeholders)");
    equal(call.args.length, 2, "without placeholders the core appends two files");
    equal([trimEnd(call.contents[0]), trimEnd(call.contents[1])], [rich.git("show", "HEAD:README.md"), rich.git("show", ":README.md")], "namely old and new");
    await closeToasts(page);
    await store("closeCenter", tabId);

    // Commit: through the menu of a file in the commit details.
    const head = rich.git("rev-parse", "HEAD");
    const details = await app.invoke("commit_details", { repoId, source: { kind: "commit", sha: head } });
    const added = details.files.find((item) => item.status === "added");
    const commitOut = nextOut();
    await setSettings({ externalDiffTool: command(commitOut, "{local} {remote}") });
    await store("selectCommits", tabId, [head]);
    const row = page.locator(`[data-screen="commit-details"] [data-row-key=${JSON.stringify(added.path)}]`).first();
    await row.waitFor();
    await row.click({ button: "right" });
    await ui.menuItem("Open in external diff tool").click();
    call = await waitCall(commitOut, "diff tool started (commit, new file)");
    equal(trimEnd(call.contents[1]), rich.git("show", `${head}:${added.path}`), "commit: {remote} is the version of the commit");
    equal(call.contents[0] ?? "", "", "new file: {local} is empty");
    await store("selectWip", tabId);
    await closeToasts(page);
  });

  // -------------------------------------------------------------------------------------------
  await section("Diff tool: program missing; unchanged file; several files selected", async () => {
    ui = await use(richTab);
    const { tabId } = richTab;
    await setSettings({ externalDiffTool: `"${slash(path.join(rich.root, "gibt-es-nicht", "vergleich.exe"))}" {local} {remote}` });
    await openDiff(richTab, "src/auswertung.py", { kind: "unstaged" });
    await diffButton.click();
    await until(async () => (await toasts()).some((toast) => toast.tone === "danger" && toast.text.startsWith("The diff tool could not be started")), "missing program: toast instead of a silent failure");
    const text = (await toasts()).find((toast) => toast.tone === "danger")?.text ?? "";
    check(text.includes("vergleich.exe") || /not found|missing|start/.test(text), `the toast names the program or the reason (${text})`);
    await closeToasts(page);
    await store("closeCenter", tabId);

    // Several files: the entry is disabled and says why.
    const fileRow = (file) => page.locator(`[data-section="unstaged"] [data-row-key=${JSON.stringify(file)}]`);
    await fileRow("src/auswertung.py").click();
    await fileRow("notizen/offene-fragen.md").click({ modifiers: ["Control"] });
    await fileRow("notizen/offene-fragen.md").click({ button: "right" });
    const entry = ui.menuItem("Open in external diff tool");
    await entry.waitFor();
    equal(await entry.getAttribute("aria-disabled"), "true", "with several files the entry is disabled");
    check((await entry.getAttribute("title")).includes("only for one file"), "with a reason");
    await page.keyboard.press("Escape");
    await store("closeCenter", tabId);
  });

  // -------------------------------------------------------------------------------------------
  await section("Without a setting: git difftool with diff.tool from the Git configuration", async () => {
    ui = await use(richTab);
    await setSettings({ externalDiffTool: null });
    const gitOut = nextOut();
    // This is how a custom tool is registered in Git: difftool.<name>.cmd with $LOCAL and $REMOTE.
    appendAppGitConfig(app, `[diff]\n\ttool = probe\n[difftool "probe"]\n\tcmd = \\"${slash(process.execPath)}\\" \\"${slash(tool)}\\" \\"${slash(gitOut)}\\" \\"$LOCAL\\" \\"$REMOTE\\"\n`);
    await openDiff(richTab, "src/auswertung.py", { kind: "unstaged" });
    await diffButton.click();
    const call = await waitCall(gitOut, "git difftool started the tool from the Git configuration");
    equal(call.args.length, 2, "two arguments: $LOCAL and $REMOTE");
    equal(trimEnd(call.contents[0]), rich.git("show", ":src/auswertung.py"), "$LOCAL is the version from the index");
    equal(trimEnd(call.contents[1]), trimEnd(fs.readFileSync(path.join(rich.path, "src/auswertung.py"), "utf8")), "$REMOTE is the file in the working tree");
    equal((await toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
    await store("closeCenter", richTab.tabId);
  });

  // -------------------------------------------------------------------------------------------
  await section("Merge tool: all four versions, start from conflict tool, menu and command", async () => {
    ui = await use(conflictTab);
    const { tabId } = conflictTab;
    const file = "src/auswertung.py";
    const sides = { base: conflict.git("show", `:1:${file}`), ours: conflict.git("show", `:2:${file}`), theirs: conflict.git("show", `:3:${file}`) };
    const merged = fs.readFileSync(path.join(conflict.path, file), "utf8");
    check(merged.includes("<<<<<<<"), "initial state: the file has conflict markers");
    await store("selectWip", tabId);
    await store("openConflict", tabId, file);
    await page.locator(conflictScreen).waitFor();
    await app.settle();

    // Without a setting and without merge.tool: the command via the palette (keyboard only) explains what is missing.
    await ui.runCommand("conflict file in external", "file.externalMerge");
    await until(async () => (await toasts()).some((toast) => toast.tone === "danger" && toast.text.startsWith("The merge tool could not be started")), "without a tool: toast with explanation");
    equal(await page.locator("[data-toast]").getByRole("button", { name: "Set up external programs" }).count(), 1, "with the way to the settings");
    await closeToasts(page);

    const mergeOut = nextOut();
    await setSettings({ externalMergeTool: command(mergeOut, "{base} {local} {remote} {merged}") });
    const button = page.locator(`${conflictScreen} button[data-action="external"]`);
    await button.waitFor({ timeout: 10_000 });
    await button.click();
    let call = await waitCall(mergeOut, "the merge tool started");
    equal(call.args.length, 4, "four arguments: {base} {local} {remote} {merged}");
    equal(trimEnd(call.contents[0]), sides.base, "{base} is the common ancestor");
    equal(trimEnd(call.contents[1]), sides.ours, "{local} is the current version (main)");
    equal(trimEnd(call.contents[2]), sides.theirs, "{remote} is the incoming version (feature/einheiten)");
    check(samePath(call.args[3], path.join(conflict.path, file)), `{merged} is the real file in the working tree (${call.args[3]})`);
    equal(call.contents[3], merged, "with the conflict markers");
    await shot("tools-merge-started");
    await closeToasts(page);

    // Without placeholders the program only gets the file itself.
    const bareOut = nextOut();
    await setSettings({ externalMergeTool: `"${process.execPath}" "${tool}" "${bareOut}"` });
    await ui.runCommand("conflict file in external", "file.externalMerge");
    call = await waitCall(bareOut, "merge tool started (without placeholders, via command)");
    equal(call.args.length, 1, "without placeholders: one argument");
    check(samePath(call.args[0], path.join(conflict.path, file)), "namely the conflict file");
    await until(async () => (await toasts()).some((toast) => toast.tone === "info" && toast.text.startsWith("Merge tool started")), "toast \"Merge tool started\"");
    await closeToasts(page);

    // File menu of the conflict list.
    const menuOut = nextOut();
    await setSettings({ externalMergeTool: command(menuOut, "{merged}") });
    const conflictRow = page.locator(`[data-section="conflicts"] [data-row-key=${JSON.stringify("docs/aufbau.md")}]`);
    await conflictRow.click({ button: "right" });
    await ui.menuItem("Open in external merge tool").click();
    call = await waitCall(menuOut, "merge tool started (file menu)");
    check(samePath(call.args[0], path.join(conflict.path, "docs/aufbau.md")), "the menu starts the tool for the clicked file");
    equal(conflict.git("diff", "--name-only", "--diff-filter=U").split("\n").sort(), ["docs/aufbau.md", "src/auswertung.py"], "git: both files are still in conflict (the tool resolved nothing)");
    await setSettings({ externalMergeTool: null });
  });

  // -------------------------------------------------------------------------------------------
  await section("Screenshots: settings in light theme and minimum window", async () => {
    ui = await use(richTab);
    await setSettings({ externalDiffTool: "meld {local} {remote}", externalMergeTool: "kdiff3 {base} {local} {remote} -o {merged}" });
    await page.keyboard.press("Control+,");
    await prefs.waitFor();
    await page.getByRole("tab", { name: "External programs", exact: true }).click();
    await prefRow("Merge tool").scrollIntoViewIfNeeded();
    await app.setTheme("light");
    await shot("tools-settings-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await prefRow("Diff tool").scrollIntoViewIfNeeded();
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "960×600: no horizontal overflow");
    equal(await prefs.evaluate((element) => element.scrollWidth - element.clientWidth), 0, "960×600: the settings do not overflow");
    await shot("tools-settings-min");
    await app.setSize(1440, 900);
    await page.keyboard.press("Escape");
    await setSettings({ externalDiffTool: null, externalMergeTool: null });
  });
} catch (error) {
  check(false, `script aborted: ${error?.stack ?? error}`);
}
await finish("tools", checks, app, () => repos.forEach((repo) => repo.cleanup()));
