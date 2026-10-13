/**
 * rebase – interactive rebase, squash and cherry-pick in the real app against real Git repositories.
 *
 *   node scripts/e2e/screens/rebase.mjs                 everything
 *   node scripts/e2e/screens/rebase.mjs --only squash   only sections whose title contains "squash"
 *   node scripts/e2e/screens/rebase.mjs --show          window visible
 *
 * The repository itself is checked too: `git log`, messages, file contents, undo via the toolbar.
 * The first section does without the mouse entirely.
 * Screenshots: target/e2e/shots/rebase*.png
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { gitIsolationEnv, makeCleanRepoWithRemote, TEST_IDENTITY } from "../fixtures.mjs";
import { createChecks, lines } from "./_wip.mjs";

// The checks read the repository with git while the app writes; without this git would briefly hold index.lock.
process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots";
const checks = createChecks("rebase");
const { check, equal, finish } = checks;
const rebaseScreen = '[data-screen="rebase"]';
const commitGraphScreen = '[data-screen="commit-graph"]';

let app = null;
let page = null;
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `read()` matches (value or condition); errors while reading count as "not yet". */
const eventually = async (read, expected, message, timeoutMs = 15_000) => {
  const matches = (value) => (typeof expected === "function" ? expected(value) : JSON.stringify(value) === JSON.stringify(expected));
  const attempt = async () => {
    try {
      return await read();
    } catch (error) {
      return `Error: ${String(error?.message ?? error).split("\n")[0]}`;
    }
  };
  const deadline = Date.now() + timeoutMs;
  let actual = await attempt();
  while (!matches(actual) && Date.now() < deadline) {
    await sleep(80);
    actual = await attempt();
  }
  if (matches(actual)) return true;
  const shown = page ? await toasts().catch(() => []) : [];
  // For diagnosis: where is focus, is anything open on top?
  const where = page
    ? await page
        .evaluate(() => {
          const active = document.activeElement;
          const name = active ? `${active.tagName.toLowerCase()}${active.getAttribute("role") ? `[${active.getAttribute("role")}]` : ""} "${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 40)}"` : "nothing";
          const open = [...document.querySelectorAll('[role="tooltip"], [role="dialog"], [role="alertdialog"], [role="menu"]')].map((item) => `${item.getAttribute("role")}: ${(item.textContent ?? "").trim().slice(0, 40)}`);
          return `focus: ${name}${open.length ? `; open: ${open.join(" | ")}` : ""}`;
        })
        .catch(() => "")
    : "";
  return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${JSON.stringify(expected)}`}, got ${JSON.stringify(actual)}${shown.length ? ` – toasts: ${JSON.stringify(shown)}` : ""}${where ? ` – ${where}` : ""}`);
};

const run = (title, body) =>
  checks.section(title, body, async (name) => {
    if (app) await app.screenshot(`target/e2e/rebase-error-${name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
  });

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

const made = (repo) => {
  cleanups.push(() => repo.cleanup());
  return repo;
};
const read = (repo, file) => fs.readFileSync(path.join(repo.path, file), "utf8");
const exists = (repo, file) => fs.existsSync(path.join(repo.path, file));
const commit = (repo, file, content, message) => {
  repo.write(file, content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return repo.git("rev-parse", "HEAD");
};
const subjects = (repo, range) => lines(repo.git("log", "--reverse", "--format=%s", range));
const body = (repo, sha) => repo.git("log", "-1", "--format=%B", sha).replace(/\s+$/, "");
const tip = (repo, ref = "HEAD") => repo.git("rev-parse", ref);

/** Branch "thema/plan" with five commits on main – the basis for reordering and editing. */
function planRepo(name, { push = false } = {}) {
  const repo = made(makeCleanRepoWithRemote({ name }));
  const base = tip(repo, "main");
  repo.git("checkout", "-q", "-b", "thema/plan");
  const c = {
    c1: commit(repo, "sensoren.txt", "Nord\nSüd\nHafen\n", "Sensorliste ergänzt"),
    c2: commit(repo, "README.md", read(repo, "README.md").replace("Schulstationen", "Schul-Stationen"), "Tippfehler im README"),
    c3: commit(repo, "export.txt", "Zwischenstand\n", "Zwischenstand Export"),
    c4: commit(repo, "export.txt", "fertig\n", "Export fertig"),
    c5: commit(repo, "debug.txt", "print(werte)\n", "Debug-Ausgabe"),
  };
  if (push) repo.git("push", "-q", "-u", "origin", "thema/plan");
  return { repo, base, c };
}

/** Many commits at once via fast-import (300 separate `git commit` calls took too long). */
function fastImport(repo, branch, from, count, summaryAt = () => null) {
  const chunks = [];
  const at = 1780000000;
  const who = `${TEST_IDENTITY.name} <${TEST_IDENTITY.email}>`;
  for (let i = 1; i <= count; i++) {
    const message = `${summaryAt(i) ?? `Messreihe ${String(i).padStart(3, "0")} eingelesen`}\n`;
    const content = `Wert ${i}\n`;
    chunks.push(
      `commit refs/heads/${branch}\nmark :${i}\nauthor ${who} ${at + i * 60} +0100\ncommitter ${who} ${at + i * 60} +0100\ndata ${Buffer.byteLength(message)}\n${message}`,
      i === 1 ? `from ${from}\n` : `from :${i - 1}\n`,
      `M 100644 inline reihen/reihe-${i}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`,
    );
  }
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repo.path,
    input: chunks.join(""),
    env: { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers in the app
// ---------------------------------------------------------------------------

const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
const closeToasts = async () => {
  for (let round = 0; round < 12 && (await page.locator("[data-toast]").count()) > 0; round++) {
    await page.getByRole("button", { name: "Close message" }).first().click({ timeout: 2000 }).catch(() => undefined);
    await sleep(80);
  }
};
const waitToast = async (pattern, tone = null, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await toasts()).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone));
    if (hit) return hit;
    if (Date.now() > deadline) {
      check(false, `toast ${pattern}${tone ? ` (${tone})` : ""} missing; present: ${JSON.stringify(await toasts())}`);
      return null;
    }
    await sleep(80);
  }
};

const view = (tabId) =>
  page.evaluate((id) => {
    const state = window.__gc.store.getState().views[id] ?? {};
    return { selection: state.selection ?? { kind: "wip" }, center: state.center ?? { kind: "graph" } };
  }, tabId);
const centerKind = async (tabId) => (await view(tabId)).center.kind;
const openRebase = (tabId, base, mode, shas = []) => page.evaluate(([id, b, m, s]) => window.__gc.store.getState().openRebase(id, b, m, s), [tabId, base, mode, shas]);

/** Rows of the rebase list as they are in the DOM. */
const listRows = () =>
  page.locator(`${rebaseScreen} [role="option"]`).evaluateAll((list) =>
    list
      .map((row) => ({
        index: Number(row.dataset.index),
        sha: row.dataset.rowSha,
        action: row.querySelector("[data-action]")?.getAttribute("data-action") ?? null,
        summary: row.querySelector("[data-summary]")?.textContent ?? "",
        included: row.querySelector("[data-included]")?.getAttribute("data-included") ?? null,
        active: row.hasAttribute("data-active"),
      }))
      .sort((a, b) => a.index - b.index),
  );
const shasInList = async () => (await listRows()).map((row) => row.sha);
const actionsInList = async () => (await listRows()).map((row) => row.action);
const listFocused = () => page.evaluate((root) => document.activeElement?.getAttribute("role") === "listbox" && Boolean(document.activeElement.closest(root)), rebaseScreen);
const startButton = () => page.locator(`${rebaseScreen} button[data-action="start"]`);
const footerText = () => page.locator(`${rebaseScreen} [data-plan-summary]`).innerText();
const statePanel = () => page.locator(`${rebaseScreen} [data-state-panel]`).getAttribute("data-state-panel", { timeout: 2000 }).catch(() => null);
const press = (key) => page.keyboard.press(key);
const focusedRowId = () => page.evaluate(() => document.activeElement?.closest("[data-row-index]")?.getAttribute("data-row-id") ?? null);
const overflow = () =>
  page.evaluate((root) => {
    const html = document.documentElement;
    const screen = document.querySelector(root);
    return { page: html.scrollWidth - html.clientWidth, screen: screen ? screen.scrollWidth - screen.clientWidth : -1 };
  }, rebaseScreen);

/** Presses Tab until `predicate` (runs in the page) matches. Keyboard only. */
const tabUntil = async (predicate, arg, { max = 60, back = false } = {}) => {
  for (let step = 0; step < max; step++) {
    if (await page.evaluate(predicate, arg)) return true;
    await press(back ? "Shift+Tab" : "Tab");
  }
  return check(await page.evaluate(predicate, arg), "Tab does not reach the target");
};
/** In the open menu, use arrow keys to reach the entry whose label starts like this, then Enter. */
const menuChoose = async (label) => {
  await page.locator('[role="menu"]').first().waitFor({ timeout: 10_000 });
  for (let step = 0; step < 24; step++) {
    const highlighted = await page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted]')?.textContent?.trim() ?? null);
    if (highlighted?.startsWith(label)) {
      await press("Enter");
      await eventually(() => page.locator('[role="menu"]').count(), 0, "menu closes after the choice");
      return true;
    }
    await press("ArrowDown");
    await sleep(40);
  }
  return check(false, `menu entry "${label}" not reached with arrow keys`);
};
const dialog = () => page.getByRole("dialog").first();
const waitDialog = async (title) => {
  await eventually(() => dialog().getByRole("heading").first().innerText().catch(() => null), title, `dialog "${title}"`);
  return dialog();
};

async function open(repo) {
  await closeToasts();
  const opened = await app.openRepo(repo.path);
  Object.assign(repo, opened);
  await page.locator(`${commitGraphScreen}[data-state="ready"]`).waitFor({ timeout: 60_000 });
  return opened;
}
async function closeRepoTab() {
  await closeToasts();
  await page.keyboard.press("Control+w").catch(() => undefined);
  await sleep(300);
}
/** Waits until rebase shows the plan (list in the DOM, focus in it). */
async function waitList(count) {
  await page.locator(`${rebaseScreen} [role="listbox"]`).waitFor({ timeout: 30_000 });
  await eventually(async () => (await page.locator(`${rebaseScreen} [role="listbox"]`).getAttribute("aria-label")) !== null && (await listRows()).length, (value) => value === count || (count > 40 && value > 0), `the list shows ${count} commits`);
}
async function shot(name) {
  await page.mouse.move(2, 2);
  await sleep(150);
  await app.screenshot(`${SHOTS}/${name}.png`);
}

// ---------------------------------------------------------------------------

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  page = app.page;

  // -------------------------------------------------------------------------
  await run("Keyboard: open from the graph, reorder, reword, squash, drop, start, undo", async () => {
    const { repo, base, c } = planRepo("rebase-tastatur");
    const { tabId } = await open(repo);

    // Graph: Tab into it, arrows to the base commit (main), Shift+F10 opens the context menu.
    await page.evaluate(() => document.activeElement?.blur());
    await tabUntil(() => Boolean(document.activeElement?.closest('[data-screen="commit-graph"] [data-row-index]')));
    for (let step = 0; step < 20 && (await focusedRowId()) !== base; step++) await press("ArrowDown");
    equal(await focusedRowId(), base, "arrow keys reach the main commit");
    await press("Shift+F10");
    await menuChoose("Interactive rebase from here");
    await eventually(() => view(tabId).then((v) => v.center), { kind: "rebase", base, mode: "interactive", shas: [] }, "the menu opens rebase with this base");
    await waitList(5);
    equal(await shasInList(), [c.c1, c.c2, c.c3, c.c4, c.c5], "oldest commit at the top, as in Git");
    await eventually(listFocused, true, "focus is in the list right away");
    equal(await startButton().getAttribute("aria-disabled"), "true", "unchanged: start disabled");
    check(/commits → 5 commits/.test(await footerText()), "footer: 5 commits → 5 commits");

    // Reword c2: R opens the dialog, multi-line with umlauts, Ctrl+Enter applies.
    await press("ArrowDown");
    await press("r");
    const reword = await waitDialog("Reword commit");
    equal(await reword.getByLabel("Summary").inputValue(), "Tippfehler im README", "the dialog is prefilled with the old message");
    await press("Control+a");
    await page.keyboard.type("README: Tippfehler korrigiert – Größenangaben");
    await press("Tab");
    await page.keyboard.type("Zeile eins mit Ümläuten");
    await press("Enter");
    await page.keyboard.type("Zweite Zeile: äöüß");
    await shot("rebase-reword");
    await press("Control+Enter");
    await eventually(() => page.getByRole("dialog").count(), 0, "the dialog closes");
    await eventually(listFocused, true, "afterwards focus is back in the list");
    await eventually(actionsInList, ["pick", "reword", "pick", "pick", "pick"], "c2 is \"Reword\"");
    equal((await listRows())[1].summary, "README: Tippfehler korrigiert – Größenangaben", "the row shows the new summary");

    // Squash c4 into c3 (S), then the message of the result (Enter on c3).
    await press("ArrowDown");
    await press("ArrowDown");
    await press("s");
    await eventually(actionsInList, ["pick", "reword", "pick", "squash", "pick"], "S squashes c4");
    await press("ArrowUp");
    await press("Enter");
    const result = await waitDialog("Message of the squashed commit");
    equal(await result.getByLabel("Summary").inputValue(), "Zwischenstand Export", "result prefilled with the target's message …");
    check((await result.getByLabel("Description").inputValue()).includes("Export fertig"), "… and below it the squashed one's");
    await press("Control+a");
    await page.keyboard.type("CSV-Export fertiggestellt");
    await press("Control+Enter");
    await eventually(() => page.getByRole("dialog").count(), 0, "the dialog closes");

    // Drop c5 (D), move c2 up (Alt+↑).
    await press("End");
    await press("d");
    await eventually(actionsInList, ["pick", "reword", "pick", "squash", "drop"], "D drops c5");
    await press("Home");
    await press("ArrowDown");
    await press("Alt+ArrowUp");
    await eventually(shasInList, [c.c2, c.c1, c.c3, c.c4, c.c5], "Alt+↑ moves c2 up");
    equal((await listRows()).find((row) => row.active)?.sha, c.c2, "the active row moves along");
    check(/5 commits → 3 commits/.test(await footerText()), `footer names the result: ${await footerText()}`);
    equal(await startButton().getAttribute("aria-disabled"), null, "now start is enabled");

    // Tab to the start button, Enter. The plan drops a commit: a confirmation comes first.
    const beforeStart = tip(repo);
    await tabUntil(() => document.activeElement?.getAttribute("data-action") === "start");
    await press("Enter");
    const ask = await waitDialog("Drop 1 commit and start the rebase?");
    const askText = (await ask.innerText()).replace(/\s+/g, " ");
    check(askText.includes("Debug-Ausgabe") && askText.includes(c.c5.slice(0, 7)), `the confirmation names the dropped commit: ${askText}`);
    check(/leaves “thema\/plan”/.test(askText) && /Undo/.test(askText), "it says what gets lost and that it can be brought back");
    check(!/already on a remote/.test(askText), "local commits: no notice about the remote");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on \"Cancel\"");
    await shot("rebase-confirm-drop");
    // Enter never triggers the dangerous action: it cancels, nothing changes, the plan is still there.
    await press("Enter");
    await eventually(() => page.getByRole("dialog").count(), 0, "Enter on \"Cancel\" closes the confirmation");
    await sleep(300);
    equal(tip(repo), beforeStart, "git: after \"Cancel\" nothing is rewritten");
    equal(await centerKind(tabId), "rebase", "rebase stays open");
    equal(await actionsInList(), ["reword", "pick", "pick", "squash", "drop"], "the edited plan is still there");
    // Second attempt: focus is back on the start button; Enter, in the confirmation Tab to the red button, Enter.
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-action")), "start", "after cancelling, focus is back on \"Start rebase\"");
    await press("Enter");
    await waitDialog("Drop 1 commit and start the rebase?");
    await press("Tab");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Start rebase", "Tab leads to the \"Start rebase\" button");
    await press("Enter");
    await waitToast(/Interactive rebase complete/, "success");
    await eventually(() => centerKind(tabId), "graph", "afterwards it goes back to the graph");
    const newTip = tip(repo);
    await eventually(() => view(tabId).then((v) => v.selection), { kind: "commits", shas: [newTip] }, "the new tip is selected");

    // In the repository: order, messages, contents.
    equal(subjects(repo, "main..HEAD"), ["README: Tippfehler korrigiert – Größenangaben", "Sensorliste ergänzt", "CSV-Export fertiggestellt"], "git log: new order, reworded, squashed, dropped");
    const [first] = lines(repo.git("rev-list", "--reverse", "main..HEAD"));
    equal(body(repo, first), "README: Tippfehler korrigiert – Größenangaben\n\nZeile eins mit Ümläuten\nZweite Zeile: äöüß", "git: multi-line message with umlauts unchanged");
    equal(repo.git("show", "HEAD:export.txt"), "fertig", "git: the squashed commit contains the state of c4");
    check(!lines(repo.git("ls-tree", "-r", "--name-only", "HEAD")).includes("debug.txt"), "git: debug.txt is gone with c5");
    check(!exists(repo, "debug.txt"), "file: debug.txt is also gone from the working directory");
    equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "thema/plan", "the branch stays checked out");
    equal(repo.git("status", "--porcelain"), "", "working directory clean");

    // Undo via the toolbar: old state.
    await closeToasts();
    const undo = page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Undo/ });
    await eventually(() => undo.getAttribute("aria-disabled"), null, "undo is available");
    await undo.click();
    await eventually(() => tip(repo, "thema/plan"), c.c5, "undo via the toolbar restores the old tip");
    equal(subjects(repo, "main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README", "Zwischenstand Export", "Export fertig", "Debug-Ausgabe"], "git log: the five old commits again");
    await eventually(() => exists(repo, "debug.txt"), true, "file: debug.txt is back");
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });

  // -------------------------------------------------------------------------
  await run("Mouse: drop menu opens rebase, drag, choice, reset, checks, Esc", async () => {
    const { repo, c } = planRepo("rebase-maus", { push: true });
    // main moves on: "thema/plan interactively onto main" then needs a normal rebase first.
    repo.git("checkout", "-q", "main");
    const mainTip = commit(repo, "stationen.csv", `${read(repo, "stationen.csv")}W;Wald;212\n`, "Station Wald ergänzt");
    repo.git("checkout", "-q", "thema/plan");
    const { repoId, tabId } = await open(repo);

    // Drop menu (as after dragging thema/plan onto main).
    await page.evaluate(
      ([id, tab]) => {
        const refs = window.__gc.queryClient.getQueryData(["repo", id, "refs"]);
        const ref = (name) => refs.locals.find((item) => item.name === name);
        window.__gcUi.openMenuAt({ x: 500, y: 200 }, window.__gcUi.menus.dropMenu({ repoId: id, tabId: tab, source: ref("thema/plan"), target: ref("main") }), "E2E");
      },
      [repoId, tabId],
    );
    await page.getByRole("menuitem", { name: /Interactively rebase .* onto “main”/ }).click();
    await eventually(() => view(tabId).then((v) => v.center), { kind: "rebase", base: "main", mode: "interactive", shas: [] }, "drop menu opens rebase with base main");
    await eventually(statePanel, "refused-no_common_ancestor", "main has moved on: refused with a reason");
    check(await page.getByText("isn't an ancestor", { exact: false }).isVisible(), "the core's reason is shown");
    await shot("rebase-refused-onto");
    await page.getByRole("button", { name: "Rebase onto “main” first" }).click();
    await waitToast(/Rebase complete/, "success");
    await waitList(5);
    equal(repo.git("merge-base", "HEAD", "main"), mainTip, "git: thema/plan now sits on main");
    const rebased = lines(repo.git("rev-list", "--reverse", "main..HEAD"));
    equal(await shasInList(), rebased, "afterwards rebase shows the rebased commits");
    // The rebased commits do not exist on the remote yet – so no warning about rewriting.
    equal(await page.locator(rebaseScreen).getByText("These commits are already on a remote").count(), 0, "freshly rebased commits: no \"already pushed\" warning");
    await closeToasts();

    // Drag: the bottom row to the very top. A screenshot with the insertion line midway.
    const rowBox = (i) => page.locator(`${rebaseScreen} [role="option"][data-index="${i}"]`).boundingBox();
    const from = await rowBox(4);
    const to = await rowBox(0);
    await page.mouse.move(from.x + from.width * 0.5, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width * 0.5, from.y + from.height / 2 - 12, { steps: 3 });
    const mid = await rowBox(2);
    await page.mouse.move(mid.x + mid.width * 0.5, mid.y + 2, { steps: 10 });
    await eventually(() => page.locator(`${rebaseScreen} [data-drop-line]`).count(), 1, "while dragging, a line shows the insertion point");
    const line = await page.locator(`${rebaseScreen} [data-drop-line]`).boundingBox();
    check(line && Math.abs(line.y - mid.y) <= 3, "the line lies between the rows under the pointer");
    check((await page.locator(`${rebaseScreen} [data-dragged]`).count()) === 1, "the dragged row is marked");
    const ghost = await page.locator(`${rebaseScreen} [data-drag-ghost]`).boundingBox();
    check(ghost && line && ghost.y >= line.y + line.height && ghost.y - mid.y <= 2 * mid.height, "a ghost with the row hangs below the pointer and does not cover the line");
    equal(await page.locator(`${rebaseScreen} [data-drag-ghost]`).innerText(), "Debug-Ausgabe", "the ghost names the dragged commit");
    await app.screenshot(`${SHOTS}/rebase-drag.png`);
    await page.mouse.move(to.x + to.width * 0.5, to.y + 3, { steps: 6 });
    await page.mouse.up();
    await eventually(shasInList, [rebased[4], rebased[0], rebased[1], rebased[2], rebased[3]], "dragging up reorders");
    check(/Order changed/.test(await footerText()), "footer: order changed");

    // Cancel dragging with Esc: nothing changes, rebase stays open.
    const again = await rowBox(1);
    await page.mouse.move(again.x + again.width * 0.5, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x + again.width * 0.5, again.y + again.height * 3, { steps: 6 });
    await press("Escape");
    await page.mouse.up();
    await eventually(shasInList, [rebased[4], rebased[0], rebased[1], rebased[2], rebased[3]], "Esc while dragging only cancels the drag");
    equal(await centerKind(tabId), "rebase", "rebase stays open meanwhile");

    // Action by clicking the picker.
    await page.locator(`${rebaseScreen} [role="option"][data-index="2"] [data-action-pill]`).click();
    await shot("rebase-menu");
    await page.getByRole("menuitem", { name: /^Drop/ }).click();
    await eventually(actionsInList, ["pick", "pick", "drop", "pick", "pick"], "click on \"Drop\"");

    // Checks: top row "Squash" – disabled with a reason, notice on the row.
    await page.locator(`${rebaseScreen} [role="option"][data-index="0"] [data-action-pill]`).click();
    await page.getByRole("menuitem", { name: /^Squash/ }).click();
    await eventually(() => startButton().getAttribute("aria-disabled"), "true", "first row \"Squash\": start disabled");
    check(/topmost remaining commit/.test(await footerText()), `the footer says why: ${await footerText()}`);
    equal(await page.locator(`${rebaseScreen} [role="option"][data-index="0"] [data-row-problem]`).count(), 1, "the row carries a notice");
    await startButton().hover();
    await page.getByRole("tooltip").filter({ hasText: /topmost remaining commit/ }).first().waitFor({ timeout: 5000 });
    await startButton().click({ force: true });
    await sleep(300);
    equal(await centerKind(tabId), "rebase", "a disabled click starts nothing");
    await shot("rebase-invalid");

    // Drop everything: disabled.
    for (let i = 0; i < 5; i++) {
      await page.locator(`${rebaseScreen} [role="option"][data-index="${i}"] [data-action-pill]`).click();
      await page.getByRole("menuitem", { name: /^Drop/ }).click();
    }
    await eventually(() => footerText(), (text) => /At least one commit must stay/.test(text), "everything dropped: disabled with a reason");

    // Reset: the loaded plan.
    const reset = page.locator(`${rebaseScreen} button[data-action="reset"]`);
    equal(await reset.innerText(), "Reset", "the button is called \"Reset\"");
    await reset.click();
    await eventually(shasInList, rebased, "reset restores the order");
    equal(await actionsInList(), ["pick", "pick", "pick", "pick", "pick"], "… and the actions");
    equal(await reset.getAttribute("aria-disabled"), "true", "afterwards \"Reset\" is disabled");

    // Esc closes without changes.
    const before = tip(repo);
    await page.locator(`${rebaseScreen} [role="listbox"]`).focus();
    await press("Escape");
    await eventually(() => centerKind(tabId), "graph", "Esc closes rebase");
    equal(tip(repo), before, "git: nothing changed");
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });

  // -------------------------------------------------------------------------
  await run("Interactive rebase with conflicts: WIP view with \"step n of m\", continue twice, undo; then abort", async () => {
    const { repo, base, c } = planRepo("rebase-konflikt");
    const { repoId, tabId } = await open(repo);
    const rebaseDir = () => fs.existsSync(path.join(repo.path, ".git", "rebase-merge"));
    const conflicted = () => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"])?.conflicted.length ?? -1, repoId);
    // The banner in commit-panel: role=alert with open conflicts, role=status afterwards.
    const banner = () => page.locator('[data-screen="commit-panel"]').locator('[role="alert"], [role="status"]').filter({ hasText: /Rebase of/ }).first();

    // c4 ("Export fertig") before c3 ("Zwischenstand Export"): c4 changes a file that does not exist yet then.
    const swapAndStart = async () => {
      await openRebase(tabId, base, "interactive");
      await waitList(5);
      await eventually(listFocused, true, "focus in the list");
      await press("End");
      await press("ArrowUp");
      await press("Alt+ArrowUp");
      await eventually(shasInList, [c.c1, c.c2, c.c4, c.c3, c.c5], "c4 is now before c3");
      // Ctrl+Enter starts directly from the list.
      await press("Control+Enter");
      await waitToast(/Interactive rebase: conflict in one file/, "warning");
      await eventually(() => centerKind(tabId), "graph", "on conflict rebase closes …");
      await eventually(() => view(tabId).then((v) => v.selection), { kind: "wip" }, "… and the local changes are selected");
      await banner().waitFor({ timeout: 15_000 });
      await eventually(async () => /step 3 of 5/.test(await banner().innerText()), true, "commit-panel shows \"Rebase … step 3 of 5\"");
      check(rebaseDir(), "git: the rebase is running (rebase-merge)");
      equal(subjects(repo, "main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README"], "git: the first two steps are applied");
      await closeToasts();
    };
    await swapAndStart();
    await shot("rebase-rebase-conflict");

    // Resolve step 3 and continue → step 4 conflicts too (both create export.txt).
    repo.write("export.txt", "fertig\n");
    repo.git("add", "export.txt");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(conflicted, 0, "first conflict resolved");
    await banner().getByRole("button", { name: "Continue rebase" }).click();
    await eventually(async () => /step 4 of 5/.test(await banner().innerText().catch(() => "")), true, "after continuing, the rebase stops at step 4 of 5");
    await eventually(conflicted, 1, "the next conflict is in the list");
    equal(subjects(repo, "main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README", "Export fertig"], "git: step 3 is committed");
    await closeToasts();
    repo.write("export.txt", "Zwischenstand, dann fertig\n");
    repo.git("add", "export.txt");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(conflicted, 0, "second conflict resolved");
    await banner().getByRole("button", { name: "Continue rebase" }).click();
    await eventually(rebaseDir, false, "git: the rebase is done", 30_000);
    equal(subjects(repo, "main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README", "Export fertig", "Zwischenstand Export", "Debug-Ausgabe"], "git log: the chosen order");
    equal(read(repo, "export.txt"), "Zwischenstand, dann fertig\n", "file: the solution of the second conflict");
    equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "thema/plan", "git: the branch is checked out again");
    equal(repo.git("status", "--porcelain"), "", "git: clean");

    // Undo via the toolbar: the state before the rebase.
    await closeToasts();
    const undo = page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Undo/ });
    await eventually(() => undo.getAttribute("aria-disabled"), null, "undo is available");
    await undo.click();
    await eventually(() => tip(repo, "thema/plan"), c.c5, "undo: thema/plan is back on the old tip");
    await eventually(() => read(repo, "export.txt"), "fertig\n", "file: export.txt as before the rebase");
    await closeToasts();

    // Second attempt, this time abort midway: everything as before.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    await swapAndStart();
    await banner().getByRole("button", { name: "Abort rebase" }).click();
    const ask = await waitDialog("Abort rebase?");
    await ask.getByRole("button", { name: "Abort rebase" }).click();
    await waitToast(/Aborted the rebase/, "success");
    await eventually(rebaseDir, false, "git: no running rebase any more");
    equal(tip(repo, "thema/plan"), c.c5, "git: the branch is unchanged");
    equal(repo.git("status", "--porcelain"), "", "git: clean");
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });

  // -------------------------------------------------------------------------
  await run("Squash: three commits from the multi-selection in the graph", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "squash-drei" }));
    const s1 = commit(repo, "auswertung.md", "# Auswertung\n", "Auswertung begonnen");
    const s2 = commit(repo, "auswertung.md", "# Auswertung\n\nTagesmittel\n", "Tagesmittel ergänzt");
    const s3 = commit(repo, "auswertung.md", "# Auswertung\n\nTagesmittel\nMonatsmittel\n", "Monatsmittel ergänzt");
    const later = commit(repo, "notiz.txt", "danach\n", "Notiz danach");
    const { tabId } = await open(repo);

    // Multi-selection with click and Shift-click, right-click opens the menu.
    await page.locator(`${commitGraphScreen} [data-row-id="${s3}"]`).click();
    await page.locator(`${commitGraphScreen} [data-row-id="${s1}"]`).click({ modifiers: ["Shift"] });
    await eventually(() => view(tabId).then((v) => v.selection.shas?.length ?? 0), 3, "three commits selected");
    await page.locator(`${commitGraphScreen} [data-row-id="${s2}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Squash 3 commits/ }).click();
    await eventually(() => view(tabId).then((v) => v.center.mode), "squash", "\"Squash 3 commits\" opens rebase in squash mode");
    await waitList(3);
    equal(await shasInList(), [s1, s2, s3], "preview: oldest at the top");
    const summary = page.locator(`${rebaseScreen} form`).getByLabel("Summary");
    const description = page.locator(`${rebaseScreen} form`).getByLabel("Description");
    equal(await summary.inputValue(), "Auswertung begonnen", "summary prefilled with the oldest one's");
    equal(await description.inputValue(), "Tagesmittel ergänzt\n\nMonatsmittel ergänzt", "description prefilled with the other messages");
    await shot("rebase-squash");
    await app.setTheme("light");
    await shot("rebase-squash-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await overflow(), { page: 0, screen: 0 }, "squash at 960×600: no overflow");
    const squashStart = await startButton().boundingBox();
    check(squashStart && squashStart.y + squashStart.height <= 600 && (await listRows()).length === 3, "squash at 960×600: list, fields and start stay visible");
    await shot("rebase-squash-min");
    await app.setSize(1440, 900);
    await sleep(300);

    // An empty summary disables.
    await summary.fill("");
    await eventually(() => startButton().getAttribute("aria-disabled"), "true", "empty summary disables");
    await summary.fill("Auswertung mit Tages- und Monatsmitteln");
    await description.fill("Drei Schritte zusammengefasst.\nÄnderungen: Mittelwerte für Tag und Monat.");
    await startButton().click();
    await waitToast(/Squash complete/, "success");
    await eventually(() => centerKind(tabId), "graph", "back to the graph");
    equal(subjects(repo, "origin/main..HEAD"), ["Auswertung mit Tages- und Monatsmitteln", "Notiz danach"], "git log: three became one, the later commit stays on top");
    const squashed = lines(repo.git("rev-list", "--reverse", "origin/main..HEAD"))[0];
    equal(body(repo, squashed), "Auswertung mit Tages- und Monatsmitteln\n\nDrei Schritte zusammengefasst.\nÄnderungen: Mittelwerte für Tag und Monat.", "git: message of the result");
    equal(repo.git("show", `${squashed}:auswertung.md`), "# Auswertung\n\nTagesmittel\nMonatsmittel", "git: content is that of s3");
    equal(repo.git("diff", later, "HEAD"), "", "git: the final state is the same as before");
    await eventually(() => view(tabId).then((v) => v.selection), { kind: "commits", shas: [squashed] }, "the new commit is selected");

    // Not consecutive: explained, with an offer for an interactive rebase.
    const [n1, , n3] = lines(repo.git("rev-list", "--reverse", "origin/main..HEAD")).concat([null]);
    await openRebase(tabId, "", "squash", [n1, tip(repo, "origin/main~1")].filter(Boolean));
    await eventually(statePanel, "refused-gap", "gap in the selection: explained");
    await shot("rebase-squash-gap");
    void n3;
    await page.getByRole("button", { name: "Interactive rebase instead" }).click();
    await eventually(() => view(tabId).then((v) => v.center.mode), "interactive", "\"Interactive rebase instead\" switches the mode");
    await press("Escape");
    await eventually(() => centerKind(tabId), "graph", "Esc closes");
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });

  // -------------------------------------------------------------------------
  await run("Cherry-pick: three commits reordered, one with a conflict, continue via commit-panel", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "cherry-drei" }));
    repo.git("checkout", "-q", "-b", "thema/quelle");
    const k1 = commit(repo, "x.txt", "x\n", "Datei x angelegt");
    const k2 = commit(repo, "README.md", "# Messnetz\n\nAuswertung der Stationen aus dem Thema-Branch.\n", "README aus dem Thema");
    const k3 = commit(repo, "y.txt", "y\n", "Datei y angelegt");
    repo.git("checkout", "-q", "main");
    const mainBefore = commit(repo, "README.md", "# Messnetz\n\nAuswertung der Stationen, Fassung main.\n", "README auf main");
    const { repoId, tabId } = await open(repo);

    await page.locator(`${commitGraphScreen} [data-row-id="${k1}"]`).click();
    await page.locator(`${commitGraphScreen} [data-row-id="${k2}"]`).click({ modifiers: ["Control"] });
    await page.locator(`${commitGraphScreen} [data-row-id="${k3}"]`).click({ modifiers: ["Control"] });
    await page.locator(`${commitGraphScreen} [data-row-id="${k3}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Cherry-pick 3 commits/ }).click();
    await eventually(() => view(tabId).then((v) => v.center.mode), "cherry_pick", "\"Cherry-pick 3 commits\" opens rebase in cherry-pick mode");
    await waitList(3);
    equal(await shasInList(), [k1, k2, k3], "order as in the history, oldest first");
    check(await page.locator(`${rebaseScreen} header`).getByText("main").isVisible(), "the target is the checked-out branch, named in the header");
    await eventually(listFocused, true, "focus in the list");

    // Keyboard: Space deselects and reselects, Alt+↑ moves k3 up.
    await press("ArrowDown");
    await press(" ");
    await eventually(() => startButton().innerText(), "Cherry-pick 2 commits", "Space skips one");
    equal((await listRows()).map((row) => row.included), ["true", "false", "true"], "the row is deselected");
    await press(" ");
    await eventually(() => startButton().innerText(), "Cherry-pick 3 commits", "and includes it again");
    await press("End");
    await press("Alt+ArrowUp");
    await press("Alt+ArrowUp");
    await eventually(shasInList, [k3, k1, k2], "Alt+↑ changes the order");
    await shot("rebase-cherry");
    await app.setTheme("light");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await overflow(), { page: 0, screen: 0 }, "cherry-pick at 960×600: no overflow");
    await shot("rebase-cherry-min-light");
    await app.setTheme("dark");
    await app.setSize(1440, 900);
    await sleep(300);
    await eventually(listFocused, true, "after resizing, focus is still in the list");

    await tabUntil(() => document.activeElement?.getAttribute("data-action") === "start");
    await press("Enter");
    await waitToast(/conflict in one file/, "warning");
    await eventually(() => centerKind(tabId), "graph", "on conflict back to the graph …");
    await eventually(() => view(tabId).then((v) => v.selection), { kind: "wip" }, "… with the local changes selected");
    await page.getByText(/Cherry-pick of .* – step 3 of 3/).first().waitFor({ timeout: 15_000 });
    check(true, "commit-panel shows \"step 3 of 3\"");
    equal(subjects(repo, `${mainBefore}..HEAD`), ["Datei y angelegt", "Datei x angelegt"], "git: the first two are already transferred, in the chosen order");
    await shot("rebase-cherry-conflict");

    // Resolve the conflict (write the file, stage it), then continue in commit-panel.
    repo.write("README.md", "# Messnetz\n\nAuswertung der Stationen, Fassung main und Thema.\n");
    repo.git("add", "README.md");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(() => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"])?.conflicted.length ?? -1, repoId), 0, "the conflict is resolved");
    await page.getByRole("status").getByRole("button", { name: "Continue cherry-pick" }).click();
    await waitToast(/Continue complete/, "success");
    equal(subjects(repo, `${mainBefore}..HEAD`), ["Datei y angelegt", "Datei x angelegt", "README aus dem Thema"], "git: all three transferred, in the chosen order");
    equal(read(repo, "README.md"), "# Messnetz\n\nAuswertung der Stationen, Fassung main und Thema.\n", "file: the solution is committed");
    equal(repo.git("status", "--porcelain"), "", "git: clean, no operation any more");
    check(!fs.existsSync(path.join(repo.path, ".git", "CHERRY_PICK_HEAD")), "git: no CHERRY_PICK_HEAD");

    // Undo via the toolbar reverts the whole cherry-pick.
    await closeToasts();
    const undo = page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Undo/ });
    await eventually(() => undo.getAttribute("aria-disabled"), null, "undo is available");
    await undo.click();
    await eventually(() => tip(repo, "main"), mainBefore, "undo: main is back before the cherry-pick");
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });

  // -------------------------------------------------------------------------
  await run("Refused: merge commit in the range, changes in the way, unknown base, branch changed", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "rebase-abgelehnt" }));
    const base = tip(repo, "main");
    repo.git("checkout", "-q", "-b", "thema/merge");
    commit(repo, "a.txt", "a\n", "Erster Schritt");
    repo.git("checkout", "-q", "-b", "nebenzweig");
    commit(repo, "b.txt", "b\n", "Nebenzweig");
    repo.git("checkout", "-q", "thema/merge");
    repo.git("merge", "-q", "--no-ff", "-m", "Nebenzweig hereingeholt", "nebenzweig");
    commit(repo, "c.txt", "c\n", "Nach dem Merge");
    const { tabId } = await open(repo);

    // Via the context menu in the graph (right-click on main).
    await page.locator(`${commitGraphScreen} [data-row-id="${base}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Interactive rebase from here/ }).click();
    await eventually(statePanel, "refused-merge_commits", "merge commit in the range: refused");
    check(await page.locator(rebaseScreen).getByText(/merge commit \(.Nebenzweig hereingeholt.\)/).isVisible(), "the reason names the merge commit");
    equal(await page.locator(`${rebaseScreen} [role="listbox"]`).count(), 0, "refused: no list, no start");
    await shot("rebase-refused");
    // Focus is on the main action: Enter is enough.
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null), "Back to graph", "refused: focus is on \"Back to graph\"");
    await press("Enter");
    await eventually(() => centerKind(tabId), "graph", "Enter on \"Back to graph\" closes");

    // Uncommitted changes: refused, "Stash changes" clears them away, then the plan appears.
    repo.git("checkout", "-q", "-b", "thema/sauber", base);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    commit(repo, "d.txt", "d\n", "Sauberer Schritt 1");
    commit(repo, "e.txt", "e\n", "Sauberer Schritt 2");
    repo.write("d.txt", "d geändert\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    await openRebase(tabId, base, "interactive");
    await eventually(statePanel, "refused-dirty_worktree", "changes in the working directory: refused");
    await shot("rebase-dirty");
    await page.locator(rebaseScreen).getByRole("button", { name: "Stash changes" }).click();
    await waitList(2);
    equal(lines(repo.git("stash", "list")).length, 1, "git: the changes are in the stash");

    // The branch changes while the plan is open: reload with an explanation.
    await page.locator(`${rebaseScreen} [role="option"][data-index="0"] [data-action-pill]`).click();
    await page.getByRole("menuitem", { name: /^Drop/ }).click();
    commit(repo, "f.txt", "f\n", "Im Terminal committet");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(async () => (await listRows()).length, 3, "the plan shows the new commit", 30_000);
    check(await page.getByText(/Plan reloaded|The branch has changed in the meantime/).first().isVisible(), "a notice explains the reload");
    equal(await actionsInList(), ["pick", "pick", "pick"], "the old edit is discarded");
    await shot("rebase-reloaded");

    // The same at the worst moment: commit in the terminal and immediately "Start rebase". Either the
    // core refuses (stale_state) or the plan was already reloaded – in both cases nothing is
    // rewritten, rebase stays open and explains it.
    await page.locator(rebaseScreen).getByRole("button", { name: "Dismiss" }).click();
    await page.locator(`${rebaseScreen} [role="option"][data-index="0"] [data-action-pill]`).click();
    await page.getByRole("menuitem", { name: /^Drop/ }).click();
    await eventually(() => startButton().getAttribute("aria-disabled"), null, "plan changed: start enabled");
    const terminal = commit(repo, "g.txt", "g\n", "Noch ein Commit im Terminal");
    await startButton().click({ force: true });
    // The plan drops a commit: if it is still there (not reloaded yet), rebase asks first.
    const asked = await page.getByRole("dialog").first().waitFor({ timeout: 2500 }).then(() => true, () => false);
    if (asked) await page.getByRole("dialog").getByRole("button", { name: "Start rebase" }).click();
    await eventually(async () => (await listRows()).length, 4, "the plan also shows this commit", 30_000);
    const notice = await page.locator(rebaseScreen).getByText(/Plan reloaded|The branch has changed in the meantime/).first().innerText();
    console.log(`    (path: ${/in the meantime/.test(notice) ? "stale_state from the core" : "plan reloaded before the click"})`);
    equal(await centerKind(tabId), "rebase", "rebase stays open");
    equal(tip(repo), terminal, "git: nothing rewritten, the terminal commit is the tip");
    equal(await actionsInList(), ["pick", "pick", "pick", "pick"], "the reloaded plan is unedited");

    // The base is the tip itself: nothing to rebase.
    await openRebase(tabId, terminal, "interactive");
    await eventually(statePanel, "refused-nothing_to_rebase", "base = tip: nothing to rebase, explained");
    await shot("rebase-nothing");

    // Empty selection in the two other modes.
    await openRebase(tabId, "", "squash", [terminal]);
    await eventually(statePanel, "empty", "squash with a single commit: empty state with an explanation");
    await openRebase(tabId, "HEAD", "cherry_pick", []);
    await eventually(statePanel, "empty", "cherry-pick without commits: empty state with an explanation");
    await shot("rebase-cherry-empty");

    // Detached HEAD: an interactive rebase needs a branch.
    repo.git("checkout", "-q", "--detach");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    await openRebase(tabId, base, "interactive");
    await eventually(statePanel, "refused-detached", "detached HEAD: refused with a reason");
    repo.git("checkout", "-q", "thema/sauber");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();

    // Unknown base: error state with "Try again".
    await openRebase(tabId, "does-not-exist", "interactive");
    await eventually(statePanel, "error", "unknown base: error state");
    await page.getByRole("button", { name: "Try again" }).click();
    await eventually(statePanel, "error", "tried again, still an error");
    await shot("rebase-error");
    await page.getByRole("button", { name: "Back to graph" }).click();
    await eventually(() => centerKind(tabId), "graph", "back");
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });

  // -------------------------------------------------------------------------
  await run("Confirmation: rewrite pushed commits (rebase and squash), cancel, confirm, undo", async () => {
    const { repo, base, c } = planRepo("rebase-gepusht", { push: true });
    const { tabId } = await open(repo);
    const undo = page.getByRole("toolbar", { name: "Repository actions" }).getByRole("button", { name: /^Undo/ });

    // Only reorder, drop nothing – but the commits are on origin: confirmation.
    await openRebase(tabId, base, "interactive");
    await waitList(5);
    await eventually(listFocused, true, "focus in the list");
    await press("ArrowDown");
    await press("Alt+ArrowUp");
    await eventually(shasInList, [c.c2, c.c1, c.c3, c.c4, c.c5], "c2 is at the top");
    await press("Control+Enter");
    const ask = await waitDialog("Rewrite pushed commits of “thema/plan”?");
    const askText = (await ask.innerText()).replace(/\s+/g, " ");
    check(/already on a remote/.test(askText) && /must be forced/.test(askText) && /Undo/.test(askText), `the confirmation says what it costs: ${askText}`);
    check(!/leaves “|leave “/.test(askText), "without dropped commits there is nothing about \"leaves the branch\"");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on \"Cancel\"");
    equal(await ask.getByRole("button", { name: "Start rebase" }).evaluate((button) => button.className.includes("bg-danger")), true, "the \"Start rebase\" button is red");
    await shot("rebase-confirm-pushed");
    await app.setTheme("light");
    await shot("rebase-confirm-pushed-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await overflow().then((value) => value.page), 0, "confirmation at 960×600: no overflow");
    await shot("rebase-confirm-pushed-min");
    await app.setSize(1440, 900);
    await press("Escape");
    await eventually(() => page.getByRole("dialog").count(), 0, "Esc closes the confirmation");
    await sleep(300);
    equal(tip(repo), c.c5, "git: after Esc nothing is rewritten");
    equal(tip(repo, "origin/thema/plan"), c.c5, "git: local and remote are equal");
    equal(await centerKind(tabId), "rebase", "rebase stays open");
    await eventually(listFocused, true, "focus is back in the list");

    // Confirm: the rebase runs, the branch then differs from the remote; undo restores equality.
    await press("Control+Enter");
    await waitDialog("Rewrite pushed commits of “thema/plan”?");
    await press("Tab");
    await press("Enter");
    await waitToast(/Interactive rebase complete/, "success");
    equal(subjects(repo, "main..HEAD"), ["Tippfehler im README", "Sensorliste ergänzt", "Zwischenstand Export", "Export fertig", "Debug-Ausgabe"], "git log: reordered");
    check(tip(repo) !== c.c5 && tip(repo, "origin/thema/plan") === c.c5, "git: the branch now differs from the remote");
    await closeToasts();
    await eventually(() => undo.getAttribute("aria-disabled"), null, "undo is available");
    await undo.click();
    await eventually(() => tip(repo, "thema/plan"), c.c5, "undo: the branch is back at the remote's state");
    await closeToasts();

    // Squash of pushed commits: the same rule.
    await openRebase(tabId, "", "squash", [c.c3, c.c4]);
    await waitList(2);
    check(await page.locator(rebaseScreen).getByText("At least one of these commits is already on a remote").isVisible(), "squash: notice in the tool");
    await startButton().click();
    const squashAsk = await waitDialog("Squash 2 pushed commits?");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "squash confirmation: focus on \"Cancel\"");
    await shot("rebase-confirm-squash");
    await press("Enter");
    await eventually(() => page.getByRole("dialog").count(), 0, "\"Cancel\" closes");
    await sleep(300);
    equal(tip(repo), c.c5, "git: nothing squashed");
    equal(await centerKind(tabId), "rebase", "the tool stays open, the inputs are still there");
    await startButton().click();
    await waitDialog("Squash 2 pushed commits?");
    await squashAsk.getByRole("button", { name: "Squash" }).click();
    await waitToast(/Squash complete/, "success");
    equal(subjects(repo, "main..HEAD"), ["Sensorliste ergänzt", "Tippfehler im README", "Zwischenstand Export", "Debug-Ausgabe"], "git log: c3 and c4 became one");
    await closeToasts();
    await eventually(() => undo.getAttribute("aria-disabled"), null, "undo is available");
    await undo.click();
    await eventually(() => tip(repo, "thema/plan"), c.c5, "undo after the squash: old state");
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });

  // -------------------------------------------------------------------------
  await run("States: loading, many commits, long summary, sizes and themes", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "rebase-viele" }));
    const base = tip(repo, "main");
    const long = "Plausibilitätsprüfung der Messreihen für alle Stationen überarbeitet, damit Ausreißer bei Frost, Sturm und Ausfall des Datenloggers nicht länger in die Monatsberichte gelangen und die Grafiken verfälschen";
    fastImport(repo, "thema/viele", base, 300, (i) => (i === 2 ? long : null));
    repo.git("checkout", "-q", "thema/viele");
    const { repoId, tabId } = await open(repo);

    // Loading: a query that never finishes shows the skeleton.
    await page.evaluate(([id, b]) => void window.__gc.queryClient.prefetchQuery({ queryKey: ["repo", id, "rebasePlan", b], queryFn: () => new Promise(() => {}) }), [repoId, "skelett"]);
    await openRebase(tabId, "skelett", "interactive");
    await page.locator(`${rebaseScreen} [data-skeleton]`).waitFor({ timeout: 10_000 });
    await shot("rebase-loading");
    await page.evaluate((id) => window.__gc.queryClient.removeQueries({ queryKey: ["repo", id, "rebasePlan", "skelett"] }), repoId);

    await openRebase(tabId, base, "interactive");
    await waitList(300);
    equal(await page.locator(`${rebaseScreen} [role="option"]`).first().getAttribute("aria-setsize"), "300", "300 commits in the plan");
    const inDom = await page.locator(`${rebaseScreen} [role="option"]`).count();
    check(inDom < 90, `virtualized: only ${inDom} rows in the DOM`);
    const longRow = (await listRows()).find((row) => row.index === 1);
    equal(longRow?.summary, long, "long summary is complete in the row (truncated via CSS)");
    equal(await overflow(), { page: 0, screen: 0 }, "long summary breaks nothing");
    await shot("rebase-long");
    await page.locator(`${rebaseScreen} [role="listbox"]`).focus();
    await press("End");
    await eventually(async () => (await listRows()).find((row) => row.active)?.index, 299, "End jumps to the last row (loaded on demand)");
    await press("Alt+ArrowUp");
    await eventually(async () => (await listRows()).find((row) => row.active)?.index, 298, "Alt+↑ also at the very bottom");
    await press("d");
    await shot("rebase-many");
    await press("Escape");
    await eventually(() => centerKind(tabId), "graph", "Esc closes");
    await closeRepoTab();

    // Main screenshot: pushed branch with edits, dark 1440×900, light, 960×600.
    const { repo: main, c } = planRepo("rebase-bild", { push: true });
    const opened = await open(main);
    await openRebase(opened.tabId, tip(main, "main"), "interactive");
    await waitList(5);
    check(await page.locator(rebaseScreen).getByText("These commits are already on a remote").isVisible(), "pushed branch: warning that a force push is needed afterwards");
    check((await page.locator(rebaseScreen).getByText(/force push/).count()) > 0, "the warning mentions the force push");
    await page.locator(`${rebaseScreen} [role="listbox"]`).focus();
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("s");
    await press("End");
    await press("d");
    await press("Home");
    await press("Alt+ArrowDown");
    await page.evaluate(() => document.activeElement?.blur());
    equal(await shasInList(), [c.c2, c.c1, c.c3, c.c4, c.c5], "screenshot: reordered");
    await shot("rebase");
    await app.setTheme("light");
    await shot("rebase-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await overflow(), { page: 0, screen: 0 }, "no overflow at 960×600");
    const footer = await page.locator(`${rebaseScreen} footer`).boundingBox();
    check(footer && footer.y + footer.height <= 600, "the footer with \"Start rebase\" stays visible");
    await shot("rebase-min");
    await app.setTheme("light");
    await shot("rebase-min-light");
    await app.setTheme("dark");
    await app.setSize(1440, 900);
    equal(app.consoleErrors, [], "console errors");
    await closeRepoTab();
  });
} catch (error) {
  checks.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  await app?.close().catch(() => undefined);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Cleanup is secondary.
    }
  }
}
process.exit(finish());
