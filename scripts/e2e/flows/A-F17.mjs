/**
 * F17 – create a new repository: the cases no script under scripts/e2e/screens/ checks yet. Real
 * app; the repositories are really created on disk and checked there with git.
 *
 *   node scripts/e2e/flows/A-F17.mjs [--show] [--only <part>[,<part>]]
 *
 * Already covered elsewhere and NOT repeated here (init.mjs, repo-management.mjs): creating with the keyboard only
 * including templates, without files, without identity, target taken, known repository at the target,
 * invalid name and branch, location missing, templates not loadable, 960×600, existing empty folder.
 *
 * Every section carries the number of its case. A red section marked "BUG A-…" is the test that
 * verifies the fix of the reported bug. At the end comes the list: green / red.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeWorkspace } from "../screens/repo-entry-lib.mjs";
import { activeTab, checkA11y, closeRepoTabs, createFlowRun, denyWrite, showManagement, sleep } from "./A-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createFlowRun("A-F17", { argv });
const { check, equal, eventually, note, section } = t;

const repoManagementScreen = '[data-screen="repo-management"]';
const ws = makeWorkspace("a-f17");
const place = ws.dir("Neu");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-a-f17-data-"));
const undo = [];
let app = null;
let page = null;

const form = () => page.locator('[data-screen="init"]');
const field = (label) => form().getByLabel(label, { exact: true });
const invalid = (label) => field(label).getAttribute("aria-invalid");
const errorOf = (label) => field(label).evaluate((input) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
const createButton = () => page.getByRole("button", { name: "Create repository", exact: true });
const tabs = () => app.invoke("tabs_list");
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const tabTitle = (tabId) => page.locator(`[data-tab-id="${tabId}"] [role="tab"]`).evaluate((tab) => tab.textContent.trim());
const openDialog = async () => {
  await showManagement(app);
  await page.locator(repoManagementScreen).getByRole("button", { name: "Create new …" }).click();
  await form().waitFor();
  await app.settle();
};
const waitRepoTab = async (repoPath, what, timeoutMs = 60_000) => {
  await eventually(async () => {
    const tab = await activeTab(app);
    return tab?.kind === "repo" && samePath(tab.path, repoPath);
  }, true, `${what}: the new repository's tab is active`, timeoutMs);
  await form().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  await app.settle();
  return activeTab(app);
};
const commitCount = (repo) => {
  try {
    return ws.git(repo, "rev-list", "--count", "--all");
  } catch {
    return "0";
  }
};
/** What the dialog shows as errors: field errors and banner. */
const shownErrors = async () => ({
  name: (await invalid("Name")) === "true" ? await errorOf("Name") : null,
  location: (await invalid("Location")) === "true" ? await errorOf("Location") : null,
  banner: (await form().locator("[data-init-error]").count()) ? (await form().locator("[data-init-error]").innerText()).replace(/\s+/g, " ") : null,
  bannerCode: (await form().locator("[data-init-error]").count()) ? await form().locator("[data-init-error]").getAttribute("data-init-error") : null,
});

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir });
  page = app.page;
  t.attach(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });

  // -------------------------------------------------------------------------------------------
  await section("F17-E1 Empty input: name and location missing – both fields marked, nothing is created; Esc discards", async () => {
    await page.evaluate(() => localStorage.removeItem("gc.repoParent"));
    await openDialog();
    equal([await field("Name").inputValue(), await field("Location").inputValue()], ["", ""], "starting point: name and location empty");
    equal([await invalid("Name"), await invalid("Location")], [null, null], "nothing is red before submitting");
    await createButton().click();
    await eventually(async () => [await invalid("Name"), await invalid("Location")], ["true", "true"], "after submitting name and location are marked");
    check(/needs a name/.test((await errorOf("Name")) ?? ""), `error text at the name: ${await errorOf("Name")}`);
    check(/Choose the folder/.test((await errorOf("Location")) ?? ""), `error text at the location: ${await errorOf("Location")}`);
    equal((await t.focused()).label, "Name", "focus jumps to the first invalid field");
    // Spaces only are not a name either.
    await field("Name").fill("   ");
    equal(await invalid("Name"), "true", "a name made of spaces is rejected");
    await field("Location").fill(place);
    await createButton().click();
    await sleep(400);
    equal(await form().count(), 1, "the dialog stays open");
    equal(fs.readdirSync(place), [], "nothing was created on disk");
    // F17-E5: Esc in the middle of filling in discards everything.
    await field("Name").fill("halb-ausgefuellt");
    await page.keyboard.press("Escape");
    await form().waitFor({ state: "detached" });
    equal(fs.readdirSync(place), [], "Esc: nothing was created on disk");
    equal((await tabs()).filter((tab) => tab.kind === "repo").length, 0, "Esc: no tab");
    equal(await t.toasts(), [], "no toast");
  });

  // -------------------------------------------------------------------------------------------
  await section("F17-H1 Happy path with the mouse: name, browse, .gitignore, license – files and first commit in the repository", async () => {
    await openDialog();
    await field("Name").fill("maus-projekt");
    await app.pick(place);
    await form().getByRole("button", { name: "Browse …" }).click();
    await eventually(() => field("Location").inputValue(), place, "\"Browse …\" fills in the location");
    await form().getByRole("combobox", { name: ".gitignore template" }).click();
    await page.getByRole("option", { name: "Node.js", exact: true }).click();
    await form().getByRole("combobox", { name: "License" }).click();
    await page.getByRole("option", { name: "MIT License", exact: true }).click();
    await createButton().click();
    const repo = path.join(place, "maus-projekt");
    const tab = await waitRepoTab(repo, "mouse");
    equal(await tabTitle(tab.id), "maus-projekt", "the tab is named after the repository");
    equal(fs.readdirSync(repo).sort(), [".git", ".gitignore", "LICENSE", "README.md"], "exactly these files are created");
    equal(ws.git(repo, "ls-files").split("\n").sort(), [".gitignore", "LICENSE", "README.md"], "all three are committed");
    equal(ws.git(repo, "log", "-1", "--format=%s|%an|%ae"), "Initial commit|Lena Hartmann|lena.hartmann@wetterstation.example", "message and author of the first commit");
    equal(ws.git(repo, "status", "--porcelain"), "", "nothing stays uncommitted");
    check(/node_modules/.test(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")), ".gitignore is the Node template");
    // The UI shows what is in the repository: one commit in the graph.
    await page.locator(`[data-screen="commit-graph"][data-state="ready"] [data-row-kind="commit"]`).first().waitFor({ timeout: 20_000 });
    equal(await page.locator(`[data-screen="commit-graph"] [data-row-kind="commit"]`).count(), 1, "the graph shows the one commit");
    await t.waitToast(/“maus-projekt” has been created/, "success");
  });

  // -------------------------------------------------------------------------------------------
  await section("F17-E3 Emoji, umlauts and spaces in name and location", async () => {
    const parent = ws.dir("Projekte Süd 🌍 & Co");
    const name = "Wetter Größe 🌦 2026";
    await openDialog();
    await field("Name").fill(name);
    equal(await invalid("Name"), null, "the name with umlauts, spaces and emoji is valid");
    await field("Location").fill(parent);
    equal((await form().locator("[data-init-target]").innerText()).replace(/\s+/g, " "), `Will be created in: ${path.join(parent, name)}`, "the preview shows the path intact");
    await createButton().click();
    const repo = path.join(parent, name);
    const tab = await waitRepoTab(repo, "Emoji");
    check(fs.existsSync(path.join(repo, ".git")), "the repository is in the folder with emoji");
    equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), `# ${name}\n`, "the README has the name as its heading, as UTF-8");
    equal(commitCount(repo), "1", "a first commit");
    equal(await tabTitle(tab.id), name, "the tab shows the name");
    const listed = (await app.invoke("repo_list")).find((entry) => entry.id === tab.repoId);
    equal([listed?.name, samePath(listed?.path ?? "", repo)], [name, true], "the core keeps name and path intact");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error toast");
  });

  // -------------------------------------------------------------------------------------------
  await section("F17-E2a Long name (64 characters): is created, nothing overflows – also at 960×600", async () => {
    const name = "messreihen-archiv-der-wetterstation-nord-mit-allen-rohdaten-2026";
    equal(name.length, 64, "name length");
    await openDialog();
    await field("Name").fill(name);
    await field("Location").fill(place);
    await app.setSize(960, 600);
    await sleep(250);
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no page overflow");
    const box = await page.locator('[role="dialog"]').boundingBox();
    check(box.x >= 0 && box.x + box.width <= 960 && box.y >= 0 && box.y + box.height <= 600, `960×600: the dialog lies inside the window (${JSON.stringify(box)})`);
    const target = await form().locator("[data-init-target]").evaluate((node) => ({ inside: node.getBoundingClientRect().right <= node.closest('[role="dialog"]').getBoundingClientRect().right, overflow: node.scrollWidth - node.clientWidth }));
    check(target.inside && target.overflow <= 1, `the path preview stays inside the dialog (${JSON.stringify(target)})`);
    await app.setSize(1440, 900);
    await createButton().click();
    const repo = path.join(place, name);
    const tab = await waitRepoTab(repo, "long name");
    equal(commitCount(repo), "1", "a first commit");
    const tabBox = await page.locator(`[data-tab-id="${tab.id}"]`).boundingBox();
    check(tabBox.width < 400, `the tab stays narrow (${Math.round(tabBox.width)} px)`);
    equal(await t.overflow(), { x: 0, y: 0 }, "no overflow");
  });

  // -------------------------------------------------------------------------------------------
  await section("F17-E2b Very long name (255 and 500 characters): clear refusal, nothing left behind", async () => {
    // BUG A-05: instead of "name too long" a raw system error appears ("… (os error 267)" or "(os error 123)")
    // with the unsuitable advice to check permissions and disk space.
    for (const length of [255, 500]) {
      const name = `lang-${"x".repeat(length - 5)}`;
      equal(name.length, length, `name length (${length})`);
      const before = fs.readdirSync(place).length;
      await openDialog();
      await field("Name").fill(name);
      await field("Location").fill(place);
      const typed = await invalid("Name");
      await createButton().click();
      // Either the field rejects it while typing, or the core when creating.
      await eventually(async () => {
        const errors = await shownErrors();
        const tab = await activeTab(app);
        return Boolean(errors.name || errors.location || errors.banner) || tab?.kind === "repo";
      }, true, `${length} characters: the app answers`, 30_000);
      const errors = await shownErrors();
      const opened = (await activeTab(app))?.kind === "repo";
      note(`${length} characters: marked while typing: ${typed}; after submitting: ${JSON.stringify(errors)}; opened: ${opened}`);
      if (opened) {
        // If it worked, the repository must be fine.
        const repo = path.join(place, name);
        check(fs.existsSync(path.join(repo, ".git")), `${length} characters: the repository is on disk`);
        continue;
      }
      const text = errors.name ?? errors.location ?? errors.banner ?? "";
      check(/too long|length|characters|long/i.test(text), `${length} characters: the refusal gives the length as the reason: "${text}"`);
      check(!/os error|\(code|unknown|undefined/i.test(text), `${length} characters: no raw system error in the text: "${text}"`);
      if (!/too long|length|characters|long/i.test(text) || /os error/i.test(text)) await t.bugShot("A-05");
      equal(await t.overflow(), { x: 0, y: 0 }, `${length} characters: no page overflow`);
      const box = await page.locator('[role="dialog"]').boundingBox();
      check(box.x >= 0 && box.x + box.width <= 1440 && box.y >= 0 && box.y + box.height <= 900, `${length} characters: the dialog stays inside the window (${JSON.stringify(box)})`);
      equal(fs.readdirSync(place).length, before, `${length} characters: no half-finished folder was left on disk`);
      await page.keyboard.press("Escape");
      await form().waitFor({ state: "detached" });
    }
    // The failed core calls are intended here.
    app.consoleErrors.length = 0;
  }, { bug: "A-05" });

  // -------------------------------------------------------------------------------------------
  await section("F17-E4 Double Enter and double click on \"Create repository\": exactly one repository, no error toast", async () => {
    await closeRepoTabs(app);
    // Double Enter, without a pause
    await openDialog();
    await field("Location").fill(place);
    await field("Name").fill("doppelt-enter");
    await field("Name").focus();
    await Promise.all([page.keyboard.press("Enter"), page.keyboard.press("Enter")]);
    const first = path.join(place, "doppelt-enter");
    await waitRepoTab(first, "double Enter");
    await sleep(600);
    equal(commitCount(first), "1", "double Enter: exactly one commit");
    equal((await tabs()).filter((tab) => tab.kind === "repo" && samePath(tab.path, first)).length, 1, "double Enter: exactly one tab");
    equal((await t.toasts()).filter((toast) => toast.tone !== "success"), [], "double Enter: no error toast");
    equal((await t.toasts()).filter((toast) => /has been created/.test(toast.text)).length, 1, "double Enter: exactly one success toast");
    equal(await form().count(), 0, "the dialog is closed");
    await t.closeToasts();
    // Double click on the button
    await openDialog();
    await field("Name").fill("doppelt-klick");
    await createButton().dblclick();
    const second = path.join(place, "doppelt-klick");
    await waitRepoTab(second, "double click");
    await sleep(600);
    equal(commitCount(second), "1", "double click: exactly one commit");
    equal((await t.toasts()).filter((toast) => toast.tone !== "success"), [], "double click: no error toast");
    equal(await form().count(), 0, "the dialog is closed");
    equal(await page.locator('[role="dialog"]').count(), 0, "no other dialog opened (the second click hit nothing behind it)");
  });

  // -------------------------------------------------------------------------------------------
  await section("F17-E10 Screen reader: named dialog, labelled fields, errors linked to fields, focus visible", async () => {
    await openDialog();
    const dialog = page.locator('[role="dialog"]').last();
    const named = await dialog.evaluate((node) => ({
      modal: node.getAttribute("aria-modal"),
      name: (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim() || node.getAttribute("aria-label"),
      description: (node.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim(),
    }));
    equal(named.name, "Create new repository", "the dialog uses its title as its name");
    check(named.description.includes("empty Git repository"), `and its description (${named.description})`);
    await checkA11y(t, '[role="dialog"]', "init dialog");
    // Error state
    await createButton().click();
    await eventually(() => invalid("Name"), "true", "name is marked invalid (aria-invalid)");
    const error = await field("Name").evaluate((input) => {
      const id = input.getAttribute("aria-describedby") ?? "";
      const node = id.split(/\s+/).map((part) => document.getElementById(part)).find((item) => item && /needs a name/.test(item.textContent ?? ""));
      return node ? { text: node.textContent, role: node.getAttribute("role"), live: node.getAttribute("aria-live") } : null;
    });
    check(error !== null, "the error text is linked to the field via aria-describedby");
    await checkA11y(t, '[role="dialog"]', "init dialog with errors");
    // Focus visible at every stop of the tab order; focus stays inside the dialog.
    const stops = [];
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press("Tab");
      const focus = await t.focused();
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
      stops.push(`${focus.label ?? focus.text}${focus.visible ? "" : " (INVISIBLE)"}${inside ? "" : " (OUTSIDE)"}`);
    }
    check(stops.every((stop) => !stop.includes("INVISIBLE")), `focus is visible at every stop: ${stops.join(" → ")}`);
    check(stops.every((stop) => !stop.includes("OUTSIDE")), "focus stays inside the dialog (focus trap)");
    await page.keyboard.press("Escape");
    await form().waitFor({ state: "detached" });
    await eventually(async () => (await t.focused()).text, "Create new …", "after Esc focus is back on \"Create new …\"", 4000);
  });

  // -------------------------------------------------------------------------------------------
  await section("F17-N2 No write access at the location: clear refusal, input stays, then it works", async () => {
    const locked = ws.dir("nur-lesen");
    const restore = denyWrite(locked);
    undo.push(restore);
    let text = "";
    try {
      await openDialog();
      await field("Name").fill("darf-nicht");
      await field("Location").fill(locked);
      await createButton().click();
      await eventually(async () => {
        const errors = await shownErrors();
        return Boolean(errors.name || errors.location || errors.banner) || (await activeTab(app))?.kind === "repo";
      }, true, "the app answers", 30_000);
      const errors = await shownErrors();
      text = errors.location ?? errors.name ?? errors.banner ?? "";
      note(`answer without write access: ${JSON.stringify(errors)}`);
      check((await activeTab(app))?.kind !== "repo", "no tab opens");
      check(/access|permission|denied|read-only|cannot write|can't write|not writable/i.test(text), `the refusal names the missing access: "${text}"`);
      // BUG A-05: the same raw system error as with the overly long name ("… (os error 5)", sentence twice).
      check(!/os error|\(code \d+\)/i.test(text), `no raw system error in the text: "${text}"`);
      check(!/(Access is denied|Permission denied).*\1/.test(text), `the reason appears only once: "${text}"`);
      equal(fs.readdirSync(locked), [], "nothing was created in the folder");
      equal([await field("Name").inputValue(), await field("Location").inputValue()], ["darf-nicht", locked], "the input is still there");
      equal(await t.toasts(), [], "no toast – the error is shown in the dialog");
    } finally {
      restore();
      undo.splice(undo.indexOf(restore), 1);
    }
    // Rights are back: same dialog, submit again.
    if (await form().count()) {
      await createButton().click();
      const repo = path.join(locked, "darf-nicht");
      await waitRepoTab(repo, "after restoring the rights");
      equal(commitCount(repo), "1", "with write access the repository is created on the second attempt");
    }
    app.consoleErrors.length = 0;
  }, { bug: "A-05" });

  // -------------------------------------------------------------------------------------------
  await section("F17-N3 A hook rejects the first commit: the repository is created, and the app says the commit is missing", async () => {
    // BUG A-06: the dialog promises "The selected files go into a first commit"; if the commit fails,
    // the app still only reports "… has been created" – nobody sees the hook's output.
    const hooks = ws.dir("hooks-global");
    fs.writeFileSync(path.join(hooks, "pre-commit"), '#!/bin/sh\necho "Hook sagt nein: erst die Checkliste lesen" >&2\nexit 1\n', { mode: 0o755 });
    const original = fs.readFileSync(app.gitConfigPath, "utf8");
    fs.writeFileSync(app.gitConfigPath, `${original}[core]\n\thooksPath = ${hooks.replaceAll("\\", "/")}\n`);
    try {
      await openDialog();
      await field("Name").fill("mit-hook");
      await field("Location").fill(place);
      check((await form().locator("[data-init-note]").innerText()).includes("go into a first commit"), "the dialog announces the first commit");
      await createButton().click();
      const repo = path.join(place, "mit-hook");
      await waitRepoTab(repo, "with hook");
      await sleep(800);
      equal(commitCount(repo), "0", "starting point confirmed: the hook prevented the commit");
      equal(ws.git(repo, "diff", "--cached", "--name-only"), "README.md", "the README is staged and ready");
      const toasts = await t.toasts();
      note(`toasts after creating: ${JSON.stringify(toasts)}`);
      const told = toasts.some((toast) => /commit/i.test(toast.text) && /(not|no |missing|rejected|hook)/i.test(toast.text));
      if (!told) await t.bugShot("A-06");
      check(told, `a toast says that the first commit was not created (hook) – there is only: ${JSON.stringify(toasts.map((toast) => toast.text))}`);
      check(toasts.some((toast) => /Hook sagt nein|Show output/.test(toast.text)), "the hook's output is reachable (text or \"Show output\")");
    } finally {
      fs.writeFileSync(app.gitConfigPath, original);
    }
  }, { bug: "A-06" });

  // -------------------------------------------------------------------------------------------
  await section("F17-E6 Restart after creating: tab, list and repository are back", async () => {
    await closeRepoTabs(app);
    await openDialog();
    await field("Name").fill("bleibt-nach-neustart");
    await field("Location").fill(place);
    await createButton().click();
    const repo = path.join(place, "bleibt-nach-neustart");
    const tab = await waitRepoTab(repo, "create");
    await t.closeToasts();
    await app.close();
    app = await launchApp({ show, width: 1440, height: 900, theme: "dark", dataDir });
    page = app.page;
    t.attach(app);
    const again = await activeTab(app);
    equal([again?.kind, samePath(again?.path ?? "", repo), again?.id], ["repo", true, tab.id], "after the restart the same tab is active");
    await page.locator(`[data-screen="commit-graph"][data-state="ready"] [data-row-kind="commit"]`).first().waitFor({ timeout: 30_000 });
    equal(await page.locator(`[data-screen="commit-graph"] [data-row-kind="commit"]`).count(), 1, "the graph shows the first commit");
    check((await app.invoke("repo_list")).some((entry) => samePath(entry.path, repo)), "the repository is in the list");
    // The remembered location lives in the WebView's localStorage; the driver gives every instance a fresh profile – not checkable here.
    equal(await t.toasts(), [], "no toast at startup");
  });
} catch (error) {
  t.check(false, `aborted: ${error?.stack ?? error}`);
} finally {
  for (const restore of undo) {
    try {
      restore();
    } catch {
      // rights were already restored
    }
  }
  await app?.close().catch(() => undefined);
  ws.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
t.finish();
