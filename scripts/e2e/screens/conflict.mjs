/**
 * conflict – conflict tool in the real app, against real Git repositories.
 *
 *   node scripts/e2e/screens/conflict.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/conflict.mjs --only keyboard  only sections whose title contains "keyboard" (comma separates several)
 *   node scripts/e2e/screens/conflict.mjs --show           window visible
 *
 * Every saved solution is verified in the repository: working-directory file byte-exact, staged
 * blob byte-exact, `git ls-files -u` empty. The "keyboard only" section never uses the mouse –
 * from opening the conflict file to the merge commit.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeConflictRepo } from "../fixtures.mjs";
import { tamper } from "./commit-panel-lib.mjs";
import {
  BINARY,
  BOTH_ADDED,
  CRLF,
  DELETED_BY_THEM,
  DELETED_BY_US,
  HUGE,
  LAB,
  LAB_CONFLICTS,
  LATIN1,
  MANY,
  MIXED,
  NO_EOL,
  REBASE_FILE,
  RENAMED,
  STATION,
  binaryBlob,
  bothAdded,
  crlfParts,
  deletedByThemOurs,
  deletedByUsTheirs,
  gitRaw,
  hugeText,
  latin1Parts,
  makeLabRepo,
  makeRebaseRepo,
  manyParts,
  mixedParts,
  noEolParts,
  rebaseParts,
  resultLines,
  stationParts,
  toText,
} from "./conflict-lib.mjs";

const show = process.argv.includes("--show");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const SHOTS = "target/e2e/shots";

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

const failures = [];
const measurements = [];
/** What could only be checked partially. */
const notes = [];
let current = "";
const check = (condition, message) => {
  if (!condition) {
    failures.push(`${current}: ${message}`);
    console.log(`  ✗ ${message}`);
  }
  return Boolean(condition);
};
const show80 = (value) => {
  const text = JSON.stringify(value);
  return text && text.length > 600 ? `${text.slice(0, 600)}… (${text.length} chars)` : text;
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${show80(expected)}, got ${show80(actual)}`);
const eventually = async (read, expected, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let actual = await read();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    actual = await read();
  }
  return equal(actual, expected, message);
};
const until = async (read, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let actual = await read();
  while (!actual && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    actual = await read();
  }
  return check(actual, message);
};
/** Compare bytes, with a readable message. */
const sameBytes = (actual, expected, message) => {
  const a = actual === null ? null : Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a !== null && a.equals(b)) return true;
  return check(false, `${message}: expected ${show80(b.toString("latin1").slice(0, 300))} (${b.length} bytes), got ${a === null ? "no file" : `${show80(a.toString("latin1").slice(0, 300))} (${a.length} bytes)`}`);
};

let app = null;
const repos = [];
const section = async (title, run) => {
  if (only && !only.some((part) => title.toLowerCase().includes(part.toLowerCase()))) return;
  current = title;
  const before = failures.length;
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    check(false, `aborted: ${error?.stack ?? error}`);
    if (app) await app.screenshot(`target/e2e/conflict-error-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
  }
  // A failed section must not drag the next ones down: close open dialogs and toasts.
  if (app) await cleanUp().catch(() => undefined);
  console.log(`${failures.length === before ? "✓" : "✗"} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};
let cleanUp = async () => undefined;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  app = await launchApp({ show });
  const { page } = app;
  const press = (key) => page.keyboard.press(key);

  const screen = page.locator('[data-screen="conflict"]');
  const sides = screen.locator("[data-sides]");
  const counter = screen.locator("[data-conflict-counter]");
  const saveButton = screen.locator('button[data-action="save"]');
  const toasts = () => page.locator("[data-toast]").allInnerTexts();
  const closeToasts = async () => {
    for (let round = 0; round < 12 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click();
      await page.waitForTimeout(120);
    }
  };
  const waitToast = async (tone, pattern, timeout = 20_000) => until(async () => (await page.locator(`[data-toast="${tone}"]`).allInnerTexts()).some((text) => pattern.test(text)), `toast (${tone}) matching ${pattern}`, timeout);
  const closeTab = async () => {
    await press("Control+w");
    await page.waitForTimeout(150);
    // If the tool asks about an unsaved solution: discard it.
    const discard = page.getByRole("dialog").getByRole("button", { name: /Discard solution/ });
    if (await discard.count()) await discard.click();
    await app.settle();
  };
  cleanUp = async () => {
    for (let round = 0; round < 4 && (await page.getByRole("dialog").count()) > 0; round++) {
      await press("Escape");
      await page.waitForTimeout(150);
    }
    await closeToasts();
  };

  const center = (tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.center ?? { kind: "graph" }, tabId);
  const status = (repoId) => app.invoke("status_get", { repoId });
  /** Waits until the tool for `file` is ready. */
  const ready = async (file) => {
    await page.waitForFunction(
      (label) => {
        const root = document.querySelector('[data-screen="conflict"]');
        return root?.getAttribute("aria-label") === label && root.getAttribute("data-conflict-state") !== "loading";
      },
      `Resolve conflict: ${file}`,
      { timeout: 60_000 },
    );
    await app.settle();
  };
  const openConflict = async (tabId, file) => {
    await page.evaluate(([tab, target]) => window.__gc.store.getState().openConflict(tab, target), [tabId, file]);
    await ready(file);
  };
  const clickConflictFile = async (file) => {
    const row = page.locator(`[data-section="conflicts"] [data-row-key=${JSON.stringify(file)}]`);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await ready(file);
  };
  const state = () => screen.getAttribute("data-conflict-state");
  /** Text of the result (editor content). */
  const result = () => page.evaluate(() => document.querySelector("[data-result-editor]")?.__gcView?.state.doc.toString() ?? null);
  const counts = () => counter.evaluate((element) => ({ resolved: Number(element.dataset.resolved), total: Number(element.dataset.total), text: element.querySelector("span")?.textContent ?? "" }));
  const resolved = async () => (await counts()).resolved;
  const saveBlocked = () => saveButton.getAttribute("aria-disabled").then((value) => value === "true");
  const saveReason = () => screen.locator("[data-save-reason]").innerText();
  /** Head checkbox of a conflict (0-based) on one side. */
  const head = (conflict, side) => sides.locator(`[data-conflict-head="${conflict}"][data-side="${side}"]`);
  /** Line checkbox: line number in that side's version. */
  const lineBox = (side, line) => sides.locator(`[role="checkbox"][data-side="${side}"][data-line="${line}"]`);
  const blockState = (conflict, side = "ours") => head(conflict, side).locator("[data-block-state]").getAttribute("data-block-state");
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!element) return null;
      return {
        label: element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
        checked: element.getAttribute("aria-checked"),
        head: element.getAttribute("data-conflict-head"),
        side: element.getAttribute("data-side"),
        line: element.getAttribute("data-line"),
        action: element.getAttribute("data-action"),
        inEditor: Boolean(element.closest("[data-result-editor]")),
        inPanel: Boolean(element.closest('[data-area="right"]')),
        text: (element.textContent ?? "").trim().slice(0, 60),
      };
    });
  /** Verifies a saved solution in the repository: file, staged blob, no conflict left. */
  const verifySaved = (repo, file, expected, what) => {
    sameBytes(repo.read(file), expected, `${what} – file in the working directory`);
    equal(repo.unmerged(file), "", `${what} – git ls-files -u is empty for the file`);
    sameBytes(repo.stage(0, file), expected, `${what} – staged blob`);
  };
  const waitConflicts = (repoId, expected, message) => eventually(async () => (await status(repoId)).conflicted.map((item) => item.path), expected, message, 20_000);
  /**
   * Save via the button. On Windows, writing large files occasionally fails with "os error 1224"
   * while a Git process (the app's status refresh) has the file mapped – the core reports an
   * error and the tool stays open with the result. Then try again.
   */
  const saveWithRetry = async (repoId, file) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await saveButton.click();
      const deadline = Date.now() + 30_000;
      let failed = false;
      while (Date.now() < deadline) {
        if (!(await status(repoId)).conflicted.some((item) => item.path === file)) return true;
        if ((await page.locator('[data-toast="danger"]').allInnerTexts()).some((text) => /Resolve conflict failed/.test(text))) {
          failed = true;
          break;
        }
        await page.waitForTimeout(80);
      }
      if (!failed) break;
      const text = (await page.locator('[data-toast="danger"]').allInnerTexts()).join(" ").replace(/\s+/g, " ");
      notes.push(`Saving ${file} failed in the core (attempt ${attempt}): ${text.slice(0, 160)} – the tool stayed open, saving again worked.`);
      check(/os error 1224/.test(text), `only the known Windows write error is retried (${text.slice(0, 200)})`);
      equal(await state(), "lines", "after the error the tool is still open with the result");
      await closeToasts();
    }
    return check(!(await status(repoId)).conflicted.some((item) => item.path === file), `${file} could be saved`);
  };
  const lab = () => {
    const repo = makeLabRepo();
    repos.push(repo);
    return repo;
  };
  const overflow = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const tool = document.querySelector('[data-screen="conflict"]');
      return { page: root.scrollWidth - root.clientWidth, tool: tool ? tool.scrollWidth - tool.clientWidth : 0 };
    });

  // -------------------------------------------------------------------------------------------
  await section("Layout and states", async () => {
    const repo = lab();
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, LAB_CONFLICTS, "14 conflict files in the status");

    // Loading: skeleton while the core delivers the versions.
    const slow = await tamper(page, "conflictGet", { delayMs: 2500 });
    await page.evaluate(([tab, target]) => window.__gc.store.getState().openConflict(tab, target), [tabId, STATION]);
    await screen.locator("[data-conflict-loading]").waitFor({ timeout: 10_000 });
    equal(await state(), "loading", "loading state");
    await app.screenshot(`${SHOTS}/conflict-loading.png`);
    await slow.restore();
    await ready(STATION);

    // Layout: three areas with their names as headings.
    equal(await state(), "lines", "a text conflict opens the workbench");
    equal(await screen.getByRole("heading", { level: 3 }).allInnerTexts().then((list) => list.map((text) => text.replace(/\s+/g, " ").trim())), [`Current (${LAB.ours})`, `Incoming (${LAB.theirs})`, "Result editable – this is how the file will be saved"], "headings of the three areas");
    equal(await counts(), { resolved: 0, total: 3, text: "0 of 3 conflicts resolved" }, "counter");
    equal(await sides.locator('[data-kind="auto-head"]').count(), 2, "two automatically taken spots are marked");
    check((await sides.locator('[data-kind="auto-head"]').first().innerText()).includes("Taken automatically"), "text \"Taken automatically\"");
    equal(await saveBlocked(), true, "saving is blocked");
    check(/3 conflicts still open/.test(await saveReason()), `the reason is shown (${await saveReason()})`);
    const initial = await result();
    check(initial.includes(`<<<<<<< ${LAB.ours}\nSCHWELLE_FROST = -0.5\n=======\nSCHWELLE_FROST = 0.5  # Bodenfrost früher melden\n>>>>>>> ${LAB.theirs}\n`), "result starts with conflict markers and both versions");
    check(initial.includes('encoding="utf-8"') && initial.includes("Messtage"), "one-sided changes of both sides are already in the result");
    await until(() => sides.locator(".gc-tok-keyword").count().then((count) => count > 0), "syntax colours in the side-by-side view");
    await until(() => screen.locator("[data-result-editor] .gc-tok-keyword").count().then((count) => count > 0), "syntax colours in the result");
    equal(await overflow(), { page: 0, tool: 0 }, "no horizontal overflow (1440×900)");

    // One conflict resolved, one edited by hand – so the screenshot shows all states.
    await head(0, "ours").click();
    await eventually(resolved, 1, "one conflict resolved");
    await app.screenshot(`${SHOTS}/conflict.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/conflict-light.png`);
    await app.setTheme("dark");

    // Minimum window: one side with a toggle.
    await app.setSize(960, 600);
    await until(() => sides.getAttribute("data-single").then((value) => value === "ours"), "960×600: only one side");
    const toggle = screen.getByRole("radiogroup", { name: "Shown side" });
    equal(await toggle.getByRole("radio").allInnerTexts(), ["Current", "Incoming"], "side toggle");
    equal(await overflow(), { page: 0, tool: 0 }, "no horizontal overflow (960×600)");
    await app.screenshot(`${SHOTS}/conflict-min.png`);
    await toggle.getByRole("radio", { name: "Incoming" }).click();
    await until(() => sides.getAttribute("data-single").then((value) => value === "theirs"), "the toggle shows the incoming side");
    check((await screen.locator("[data-side-heading]").innerText()).includes(LAB.theirs), "the heading names the incoming branch");
    await head(1, "theirs").click();
    await eventually(resolved, 2, "choosing also works in the single view");
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/conflict-min-light.png`);
    await app.setTheme("dark");
    await app.setSize(1440, 900);
    await until(() => sides.getAttribute("data-single").then((value) => value === null), "1440×900: side by side again");

    // Error: the core does not answer.
    const broken = await tamper(page, "conflictGet", { fail: { code: "unknown", message: "The file could not be read.", gitOutput: null } });
    await page.evaluate((id) => window.__gc.queryClient.removeQueries({ queryKey: ["repo", id, "conflict"] }), repoId);
    await page.evaluate(([tab, target]) => window.__gc.store.getState().openConflict(tab, target), [tabId, CRLF]);
    const leave = page.getByRole("dialog").getByRole("button", { name: /Discard solution/ });
    await leave.click();
    await screen.locator('[data-notice="error"]').waitFor({ timeout: 10_000 });
    equal(await state(), "error", "error state");
    await app.screenshot(`${SHOTS}/conflict-error.png`);
    // Restore and press in one go – a core event in between would reload the file by itself.
    check(await broken.restoreAndPress('[data-screen="conflict"]', "Try again"), "there is \"Try again\"");
    await ready(CRLF);
    equal(await state(), "lines", "\"Try again\" loads the file");

    // No longer in conflict (resolved in the terminal).
    repo.git("checkout", "--ours", "--", CRLF);
    repo.git("add", "--", CRLF);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await screen.locator('[data-notice="gone"]').waitFor({ timeout: 20_000 });
    await app.screenshot(`${SHOTS}/conflict-gone.png`);
    await screen.getByRole("button", { name: "Back to changes" }).click();
    await eventually(async () => (await center(tabId)).kind, "graph", "\"Back to changes\" closes the tool");
    await closeTab();
  });

  /** First line (1-based) of a part in one side's version. */
  const lineOf = (parts, partIndex, side) => {
    let line = 1;
    for (const part of parts.slice(0, partIndex)) {
      if (part.kind === "same") line += part.lines.length;
      else if (part.kind === "conflict") line += part[side].length;
      else line += (part.kind === side ? part.changed : part.base).length;
    }
    return line;
  };
  const noHandEditedNotice = async (file) => equal(await screen.locator('[data-strip="hand-edited"]').count(), 0, `${file}: the comparison matches Git's working-directory file (no "edited by hand" notice)`);
  const editorLine = (text) => screen.locator("[data-result-editor] .cm-line", { hasText: text }).first();

  // -------------------------------------------------------------------------------------------
  await section("Blocks: left, right, both, single lines, by hand – save and stage", async () => {
    const repo = lab();
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, LAB_CONFLICTS, "14 conflict files");
    await clickConflictFile(STATION);
    await noHandEditedNotice(STATION);
    const [c1, c2, c3] = stationParts.filter((part) => part.kind === "conflict");

    // Conflict 1: take left, deselect, take again.
    await head(0, "ours").click();
    await eventually(() => blockState(0), "ours", "conflict 1: left chosen");
    equal(await head(0, "ours").getAttribute("aria-checked"), "true", "left checkbox is on");
    equal(await head(0, "theirs").getAttribute("aria-checked"), "false", "right checkbox is off");
    let text = await result();
    check(text.includes("\nSCHWELLE_FROST = -0.5\nSCHWELLE_HITZE") && !text.includes("Bodenfrost"), "result: line of the current side, without markers");
    equal(await resolved(), 1, "counter 1 of 3");
    await head(0, "ours").click();
    await eventually(() => blockState(0), "open", "deselected: open again");
    check((await result()).includes(`<<<<<<< ${LAB.ours}\nSCHWELLE_FROST = -0.5\n=======`), "the markers are back");
    await head(0, "ours").click();
    await eventually(resolved, 1, "resolved again");

    // Conflict 2: right, then left as well – both in the chosen order.
    await head(1, "theirs").click();
    await eventually(() => blockState(1), "theirs", "conflict 2: right chosen");
    await head(1, "ours").click();
    await eventually(() => blockState(1), "both", "conflict 2: both");
    check((await result()).includes(`${[...c2.theirs, ...c2.ours].join("\n")}\n`), "result: incoming first, then current (order of choice)");
    equal(await head(1, "theirs").locator("[data-order]").getAttribute("data-order"), "1", "right shows \"first\"");
    equal(await head(1, "ours").locator("[data-order]").getAttribute("data-order"), "2", "left shows \"then\"");
    await sides.getByRole("button", { name: "Swap order" }).click();
    await until(async () => (await result()).includes(`${[...c2.ours, ...c2.theirs].join("\n")}\n`), "order swapped: current first, then incoming");

    // Single lines: deselect two lines of the current side.
    const c2Line = lineOf(stationParts, stationParts.indexOf(c2), "ours");
    await lineBox("ours", c2Line + 1).click();
    await lineBox("ours", c2Line + 2).click();
    const c2Result = [c2.ours[0], c2.ours[3], ...c2.theirs];
    await until(async () => (await result()).includes(`def mittel(zeilen, spalte):\n${c2Result.join("\n")}\n\n`), "result: only the chosen lines");
    equal(await head(1, "ours").getAttribute("aria-checked"), "mixed", "left block checkbox shows \"partly\"");
    equal(await lineBox("ours", c2Line + 1).getAttribute("aria-checked"), "false", "deselected line");
    equal(await resolved(), 2, "counter 2 of 3");
    equal(await saveBlocked(), true, "saving still blocked");

    // F7 / Shift+F7 and the buttons jump between conflicts.
    await head(0, "ours").focus();
    await press("F7");
    await until(async () => (await focused())?.head === "1", "F7: focus on conflict 2");
    await press("F7");
    await until(async () => (await focused())?.head === "2", "F7: focus on conflict 3");
    equal(await screen.locator("[data-conflict-position]").innerText(), "3/3", "position 3/3");
    await press("Shift+F7");
    await until(async () => (await focused())?.head === "1", "Shift+F7: back to conflict 2");
    await screen.getByRole("button", { name: "Next conflict" }).click();
    await until(() => screen.locator("[data-conflict-position]").innerText().then((value) => value === "3/3"), "\"Next conflict\" button");

    // Conflict 3: only the single line of the incoming side.
    await lineBox("theirs", lineOf(stationParts, stationParts.indexOf(c3), "theirs")).click();
    await eventually(() => blockState(2), "theirs", "conflict 3: chosen via the line");
    await eventually(resolved, 3, "counter 3 of 3");
    equal(await saveBlocked(), false, "saving is possible");
    check(!/<<<<<<<|>>>>>>>/.test(await result()), "no conflict marker left in the result");

    // By hand: keep typing in the result.
    await editorLine("Grad Celsius").click();
    await press("End");
    await page.keyboard.type("  # geprüft");
    await eventually(() => blockState(2), "manual", "conflict 3: edited by hand");
    check((await screen.locator('[data-tag="manual"]').innerText()).includes("1 block edited by hand"), "notice \"1 block edited by hand\" on the result");
    equal(await resolved(), 3, "edited by hand counts as resolved (no marker in the block)");
    // A typed conflict marker blocks saving – with a reason.
    await press("Control+End");
    await page.keyboard.type("=======");
    await until(saveBlocked, "a typed marker blocks saving");
    check(/conflict marker in the result \(line \d+\)/.test(await saveReason()), `the reason names the line (${await saveReason()})`);
    for (let count = 0; count < 7; count++) await press("Backspace");
    await until(async () => !(await saveBlocked()), "marker removed: saving possible again");

    // Search in the result with Ctrl+F – even when focus is above; the commit search stays closed.
    await head(0, "ours").focus();
    await press("Control+f");
    const search = screen.locator("[data-result-editor] .cm-search");
    await search.waitFor({ timeout: 5000 });
    equal(await page.evaluate((id) => window.__gc.store.getState().views[id]?.searchOpen ?? false, tabId), false, "the window's commit search stays closed");
    await page.keyboard.type("Messtage");
    await press("Enter");
    await until(() => page.evaluate(() => document.querySelector("[data-result-editor]").__gcView.state.sliceDoc(document.querySelector("[data-result-editor]").__gcView.state.selection.main.from, document.querySelector("[data-result-editor]").__gcView.state.selection.main.to) === "Messtage"), "search selects the match");
    await press("Escape");
    await until(() => search.count().then((count) => count === 0), "Esc closes the search (not the tool)");
    equal(await state(), "lines", "the tool is still open");

    // Save: file byte-exact, staged, next conflict file.
    const expected = toText(resultLines(stationParts, (index, part) => (index === 0 ? part.ours : index === 1 ? c2Result : [`${part.theirs[0]}  # geprüft`])));
    equal(await result(), expected, "result in the editor before saving");
    await saveButton.click();
    await waitToast("success", /station\.py.*resolved and staged/s);
    verifySaved(repo, STATION, expected, STATION);
    check(repo.stagedNames().includes(STATION), "git diff --cached lists the file");
    await waitConflicts(repoId, LAB_CONFLICTS.filter((file) => file !== STATION), "status: one conflict file fewer");
    await eventually(() => center(tabId), { kind: "conflict", path: LATIN1 }, "the next conflict file is open");
    await ready(LATIN1);
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("Keyboard only: resolve two files, finish the merge", async () => {
    const repo = makeConflictRepo();
    repos.push(repo);
    const [first, second] = repo.info.conflicted;
    const oursFirst = gitRaw(repo.path, ["cat-file", "blob", `:2:${first}`]).toString("utf8");
    const theirsSecond = gitRaw(repo.path, ["cat-file", "blob", `:3:${second}`]).toString("utf8");
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, [first, second], "two conflict files");
    await closeToasts();
    const tabTo = async (matches, what, { back = false, max = 60 } = {}) => {
      for (let step = 0; step < max; step++) {
        if (await page.evaluate(matches)) return true;
        await press(back ? "Shift+Tab" : "Tab");
      }
      return check(await page.evaluate(matches), `Tab reaches ${what} (focus: ${JSON.stringify(await focused())})`);
    };

    // Commit panel → conflict list → Enter opens the tool.
    await press("Alt+3");
    await tabTo(() => document.activeElement?.closest('[data-section="conflicts"]') !== null && document.activeElement?.hasAttribute("data-row-key"), "the conflict list");
    await eventually(() => page.evaluate(() => document.activeElement?.dataset.rowKey ?? null), first, "focus on the first conflict file");
    await press("Enter");
    await ready(first);
    equal(await counts(), { resolved: 0, total: 1, text: "0 of 1 conflict resolved" }, "one conflict");

    // Alt+2: into the view – focus lands on the first conflict.
    await press("Alt+2");
    await until(async () => {
      const at = await focused();
      return at?.head === "0" && at.side === "ours" && at.role === "checkbox";
    }, "Alt+2 puts focus on the block checkbox of the current side");
    check(/Conflict 1: take Current \(main\)/.test((await focused()).label ?? ""), `the checkbox names side and branch (${(await focused()).label})`);
    await press("Space");
    await eventually(resolved, 1, "Space takes the current side");
    await press("ArrowRight");
    await until(async () => (await focused())?.side === "theirs", "→ switches to the incoming side");
    await press("Space");
    await eventually(() => blockState(0), "both", "both sides chosen");
    check((await result()).includes("| Temperatur | 2,5 m | 10 Minuten |\n| Temperatur | 2,0 m | 5 Minuten |\n"), "order: current first, then incoming");
    await press("t");
    await until(async () => (await result()).includes("| Temperatur | 2,0 m | 5 Minuten |\n| Temperatur | 2,5 m | 10 Minuten |\n"), "T swaps the order");
    await press("ArrowDown");
    await until(async () => (await focused())?.line !== null && (await focused())?.side === "theirs", "↓ moves to the line");
    await press("Space");
    await eventually(() => blockState(0), "ours", "line deselected: only the current side remains");

    // By hand: into the result, find the match, overwrite it.
    await tabTo(() => document.activeElement?.closest("[data-result-editor]") !== null, "the result");
    await press("Control+f");
    await screen.locator("[data-result-editor] .cm-search").waitFor({ timeout: 5000 });
    await page.keyboard.type("2,5 m");
    await press("Enter");
    await press("Escape");
    await page.keyboard.type("2,7 m");
    await eventually(() => blockState(0), "manual", "edited by hand");
    const expectedFirst = oursFirst.replace("| 2,5 m |", "| 2,7 m |");
    check(expectedFirst !== oursFirst, "fixture contains the line with 2,5 m");
    equal(await result(), expectedFirst, "result in the editor");

    // Ctrl+S saves; the second file opens, focus is on the first conflict again.
    await press("Control+s");
    await ready(second);
    verifySaved({ read: (file) => fs.readFileSync(path.join(repo.path, file)), unmerged: (file) => repo.git("ls-files", "-u", "--", file), stage: (stage, file) => gitRaw(repo.path, ["cat-file", "blob", `:${stage}:${file}`]) }, first, expectedFirst, first);
    await until(async () => {
      const at = await focused();
      return at?.head === "0" && at.side === "ours";
    }, "after saving, focus is on the first conflict of the next file");
    await press("ArrowRight");
    await press("Enter");
    await eventually(() => blockState(0, "theirs"), "theirs", "Enter takes the incoming side");
    equal(await result(), theirsSecond, "result is the incoming version");
    await press("Control+s");
    await eventually(() => center(tabId), { kind: "graph" }, "after the last file the tool closes");
    verifySaved({ read: (file) => fs.readFileSync(path.join(repo.path, file)), unmerged: (file) => repo.git("ls-files", "-u", "--", file), stage: (stage, file) => gitRaw(repo.path, ["cat-file", "blob", `:${stage}:${file}`]) }, second, theirsSecond, second);
    equal(repo.git("ls-files", "-u"), "", "git ls-files -u is empty");
    await waitConflicts(repoId, [], "no conflict file left");
    await until(async () => (await focused())?.inPanel === true, "focus is in the commit panel");
    check((await toasts()).some((text) => /All conflicts resolved/.test(text)), "toast: all conflicts resolved");

    // Finish the merge (commit-panel), still without the mouse.
    await press("Control+Enter");
    await waitToast("success", /complete/);
    equal(repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "git: the merge commit has two parents");
    check(!fs.existsSync(path.join(repo.path, ".git/MERGE_HEAD")), "git: no merge open any more");
    equal(repo.git("status", "--porcelain"), "", "git: working directory clean");
    equal(repo.git("show", `HEAD:${first}`) + "\n", expectedFirst, "git: the commit contains the hand-edited version");
    equal(repo.git("show", `HEAD:${second}`) + "\n", theirsSecond, "git: the commit contains the incoming version");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("Line endings and encoding: CRLF, no final newline, windows-1252", async () => {
    const repo = lab();
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, LAB_CONFLICTS, "14 conflict files");

    // CRLF stays CRLF.
    await clickConflictFile(CRLF);
    await noHandEditedNotice(CRLF);
    equal(await screen.locator('[data-tag="eol"]').innerText(), "CRLF", "CRLF tag on the result");
    equal(await counts().then((value) => value.total), 1, "one conflict");
    check(!(await result()).includes("\r"), "no carriage returns in the editor");
    await head(0, "theirs").click();
    await eventually(resolved, 1, "incoming side chosen");
    await saveButton.click();
    const crlfExpected = toText(resultLines(crlfParts, (_, part) => part.theirs), { eol: "\r\n" });
    await waitConflicts(repoId, LAB_CONFLICTS.filter((file) => file !== CRLF), "CRLF file resolved");
    verifySaved(repo, CRLF, crlfExpected, "CRLF");
    check(repo.read(CRLF).includes(Buffer.from("fünf\r\n")), "the file ends with CRLF");

    // One side CRLF, the other LF: Git reports the whole file, here no contradiction is left.
    await eventually(() => center(tabId), { kind: "conflict", path: MIXED }, "continues with the next file");
    await ready(MIXED);
    equal(await screen.locator('[data-strip="mixed-eol"]').count(), 1, "notice about different line endings");
    check(/Current: CRLF, Incoming: LF/.test(await screen.locator('[data-strip="mixed-eol"]').innerText()), "the notice names both line endings");
    equal(await screen.locator('[data-strip="hand-edited"]').count(), 0, "no \"edited by hand\" notice");
    equal(await counts(), { resolved: 0, total: 0, text: "No conflicting lines" }, "compared without line endings, no conflict remains");
    equal(await saveBlocked(), false, "saving is possible right away");
    await closeToasts();
    await page.mouse.move(700, 600);
    await app.screenshot(`${SHOTS}/conflict-mixed-eol.png`);
    await saveButton.click();
    await waitConflicts(repoId, LAB_CONFLICTS.filter((file) => file !== CRLF && file !== MIXED), "file with mixed line endings resolved");
    verifySaved(repo, MIXED, toText(resultLines(mixedParts, () => []), { eol: "\r\n" }), "mixed line endings: both changes, CRLF of the current side");

    // No newline at the end stays that way – even if the last block was a conflict.
    await eventually(() => center(tabId), { kind: "conflict", path: NO_EOL }, "continues with the next file");
    await ready(NO_EOL);
    await noHandEditedNotice(NO_EOL);
    check((await screen.locator('[data-tag="no-final-newline"]').count()) === 1, "\"no newline at the end\" tag");
    await head(0, "ours").click();
    await head(0, "theirs").click();
    await head(1, "theirs").click();
    await eventually(resolved, 2, "both conflicts resolved");
    await press("Control+s");
    const noEolExpected = toText(resultLines(noEolParts, (index, part) => (index === 0 ? [...part.ours, ...part.theirs] : part.theirs)), { finalNewline: false });
    await waitConflicts(repoId, LAB_CONFLICTS.filter((file) => ![CRLF, MIXED, NO_EOL].includes(file)), "file without final newline resolved");
    verifySaved(repo, NO_EOL, noEolExpected, "no final newline");
    check(!repo.read(NO_EOL).toString("utf8").endsWith("\n"), "the file still ends without a newline");

    // windows-1252: shown with umlauts, saved in the same encoding.
    await openConflict(tabId, LATIN1);
    await noHandEditedNotice(LATIN1);
    equal(await screen.locator('[data-tag="encoding"]').innerText(), "windows-1252", "encoding shown in the header");
    check((await result()).startsWith("Größe;Einheit\n"), "umlauts are readable");
    await head(0, "ours").click();
    await editorLine("Druck;hPa").click();
    await press("End");
    await page.keyboard.type(" (geprüft)");
    await until(() => screen.locator('[data-tag="manual"]').count().then((count) => count === 1), "editing outside the conflicts is noted");
    await saveButton.click();
    const latinLines = resultLines(latin1Parts, (_, part) => part.ours);
    latinLines[latinLines.length - 1] += " (geprüft)";
    const latinExpected = Buffer.from(toText(latinLines), "latin1");
    await waitConflicts(repoId, LAB_CONFLICTS.filter((file) => ![CRLF, MIXED, NO_EOL, LATIN1].includes(file)), "Latin-1 file resolved");
    verifySaved(repo, LATIN1, latinExpected, "windows-1252");
    check(repo.read(LATIN1).includes(Buffer.from([0xfc])) && !repo.read(LATIN1).includes(Buffer.from("ü", "utf8")), "ü is stored as one byte (0xFC), not as UTF-8");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("Whole file: binary, deleted vs. modified, renamed on both sides", async () => {
    const repo = lab();
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, LAB_CONFLICTS, "14 conflict files");
    const whole = screen.locator("[data-whole]");
    const wholeButtons = () => whole.locator("button[data-whole-side]").evaluateAll((list) => list.map((button) => `${button.textContent.trim()}|${button.dataset.wholeSide}`));
    const tracked = (file) => repo.git("ls-files", "--", file);
    let open = [...LAB_CONFLICTS];
    const done = async (file, what) => {
      open = open.filter((item) => item !== file);
      await waitConflicts(repoId, open, what);
      equal(repo.unmerged(file), "", `${what} – git ls-files -u is empty for the file`);
    };

    // Binary file: whole sides only.
    await clickConflictFile(BINARY);
    equal(await state(), "binary", "binary file: choice of the whole version");
    equal(await wholeButtons(), ["Keep current version|ours", "Take incoming version|theirs"], "two buttons, in words");
    check((await whole.innerText()).includes(`Current (${LAB.ours})`) && (await whole.innerText()).includes(`Incoming (${LAB.theirs})`), "both sides are named with their branch");
    equal(await screen.locator("[data-result-editor]").count(), 0, "no editor for binary files");
    equal(await screen.locator('[data-tag="encoding"]').count(), 0, "no encoding tag for binary files");
    await app.screenshot(`${SHOTS}/conflict-binary.png`);
    await whole.locator('button[data-whole-side="theirs"]').click();
    await done(BINARY, "binary file resolved");
    sameBytes(repo.read(BINARY), binaryBlob(3), "binary file: incoming version in the working directory");
    sameBytes(repo.stage(0, BINARY), binaryBlob(3), "binary file: incoming version staged");
    await eventually(() => center(tabId), { kind: "conflict", path: CRLF }, "continues with the next conflict file");

    // Deleted in main, modified in feature: keep.
    await clickConflictFile(DELETED_BY_US);
    equal(await screen.getAttribute("data-conflict-kind"), "deleted_by_us", "kind of conflict");
    equal(await wholeButtons(), ["Keep file|theirs", "Delete file|ours"], "keep or delete");
    check(/The file no longer exists in/.test(await whole.innerText()), "explanation in words");
    await until(async () => (await whole.locator("[data-whole-preview] .cm-content").innerText()).includes("überarbeitet für den zweiten Standort"), "preview shows the version that would stay");
    await closeToasts();
    await page.mouse.move(700, 600);
    await app.screenshot(`${SHOTS}/conflict-deleted.png`);
    await app.setSize(960, 600);
    await page.waitForTimeout(300);
    equal(await overflow(), { page: 0, tool: 0 }, "no horizontal overflow (960×600, whole file)");
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/conflict-deleted-min-light.png`);
    await app.setTheme("dark");
    await app.setSize(1440, 900);
    await whole.locator('button[data-whole-side="theirs"]').click();
    await done(DELETED_BY_US, "deleted/modified: keep");
    sameBytes(repo.read(DELETED_BY_US), deletedByUsTheirs, "the file exists, with the incoming version");
    sameBytes(repo.stage(0, DELETED_BY_US), deletedByUsTheirs, "and is staged like that");

    // Modified in main, deleted in feature: delete.
    await openConflict(tabId, DELETED_BY_THEM);
    equal(await wholeButtons(), ["Keep file|ours", "Delete file|theirs"], "keep or delete (the other way round)");
    await until(async () => (await whole.locator("[data-whole-preview] .cm-content").innerText()).includes("Nordhang"), "preview shows the current version");
    check(deletedByThemOurs.includes("Nordhang"), "Fixture");
    await whole.locator('button[data-whole-side="theirs"]').click();
    await done(DELETED_BY_THEM, "modified/deleted: delete");
    equal(repo.read(DELETED_BY_THEM), null, "the file is gone from the working directory");
    equal(tracked(DELETED_BY_THEM), "", "and no longer in the index");

    // Renamed on both sides: old name gone, one of the new ones stays.
    await openConflict(tabId, RENAMED.old);
    equal(await screen.getAttribute("data-conflict-kind"), "both_deleted", "old name: deleted on both sides");
    equal(await wholeButtons(), ["Confirm deletion|ours"], "only one decision");
    await app.screenshot(`${SHOTS}/conflict-renamed.png`);
    await whole.locator("button[data-whole-side]").click();
    await done(RENAMED.old, "old name confirmed");
    equal(tracked(RENAMED.old), "", "old name is no longer in the index");

    await openConflict(tabId, RENAMED.ours);
    equal(await screen.getAttribute("data-conflict-kind"), "added_by_us", "name from main: only present there");
    equal(await wholeButtons(), ["Keep file|ours", "Delete file|theirs"], "keep or delete");
    await whole.locator('button[data-whole-side="ours"]').click();
    await done(RENAMED.ours, "name from main kept");
    check(repo.read(RENAMED.ours) !== null && tracked(RENAMED.ours) === RENAMED.ours, "the file stays under the name from main");

    await openConflict(tabId, RENAMED.theirs);
    equal(await screen.getAttribute("data-conflict-kind"), "added_by_them", "name from feature: only present there");
    equal(await wholeButtons(), ["Keep file|theirs", "Delete file|ours"], "keep or delete");
    await whole.locator('button[data-whole-side="ours"]').click();
    await done(RENAMED.theirs, "name from feature deleted");
    equal(repo.read(RENAMED.theirs), null, "the file with the name from feature is gone");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("Both added, very many lines, very large file", async () => {
    const repo = lab();
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, LAB_CONFLICTS, "14 conflict files");
    let open = [...LAB_CONFLICTS];
    const done = async (file, what) => {
      open = open.filter((item) => item !== file);
      await waitConflicts(repoId, open, what);
    };

    // Both added: no common ancestor.
    await clickConflictFile(BOTH_ADDED);
    await noHandEditedNotice(BOTH_ADDED);
    equal(await screen.getAttribute("data-conflict-kind"), "both_added", "kind of conflict");
    equal(await screen.locator('[data-strip="no-base"]').count(), 1, "notice: no common ancestor");
    equal(await counts().then((value) => value.total), 2, "two conflicts, the common lines stay");
    await app.screenshot(`${SHOTS}/conflict-both-added.png`);
    await screen.locator('button[data-take-all="theirs"]').click();
    await eventually(resolved, 2, "\"All incoming\" resolves both");
    await saveButton.click();
    await done(BOTH_ADDED, "both added: resolved");
    verifySaved(repo, BOTH_ADDED, toText(bothAdded.theirs), "both added");

    // 20,000 lines: only the visible slice is in the DOM, jumping and synchronized scrolling.
    let started = Date.now();
    await openConflict(tabId, MANY);
    measurements.push(`open 20,000 lines: ${Date.now() - started} ms`);
    await noHandEditedNotice(MANY);
    equal(await counts().then((value) => value.total), 2, "two conflicts in 20,000 lines");
    const domRows = await sides.locator("[data-row]").count();
    const cmLines = await screen.locator("[data-result-editor] .cm-line").count();
    check(domRows > 0 && domRows < 250, `side-by-side view virtualized (${domRows} rows in the DOM)`);
    check(cmLines > 0 && cmLines < 400, `result renders only the visible slice (${cmLines} lines in the DOM)`);
    await head(0, "ours").focus();
    await press("F7");
    await until(async () => (await focused())?.head === "1", "F7 jumps 15,000 lines ahead to conflict 2");
    const visible = () =>
      page.evaluate(() => {
        const top = (element) => element.getBoundingClientRect().top;
        const pane = document.querySelector("[data-sides]");
        const paneTop = top(pane);
        const row = [...pane.querySelectorAll("[data-line][data-side='ours']")].find((item) => top(item) >= paneTop - 1);
        const editor = document.querySelector("[data-result-editor]").__gcView;
        const block = editor.lineBlockAtHeight(editor.scrollDOM.scrollTop);
        return { sides: row ? Number(row.dataset.line) : null, result: editor.state.doc.lineAt(block.from).number };
      });
    await until(async () => {
      const at = await visible();
      return at.sides !== null && at.sides > 14_900 && at.result > 14_900;
    }, "both areas are at the second conflict");
    // Synchronized: scroll the top, the bottom follows. (Right after a jump the sync pauses briefly – a
    // single scrollTop assignment would get lost in it; a mouse wheel keeps sending events.)
    await page.waitForTimeout(600);
    await sides.evaluate((element) => (element.scrollTop = element.scrollHeight * 0.4));
    await until(async () => {
      const at = await visible();
      return at.sides !== null && at.sides > 7000 && at.sides < 9000 && Math.abs(at.result - at.sides) < 60;
    }, "scrolled the top: the result follows");
    // … and the other way round.
    await page.evaluate(() => {
      const editor = document.querySelector("[data-result-editor]").__gcView;
      editor.scrollDOM.scrollTop = editor.scrollDOM.scrollHeight * 0.1;
    });
    await until(async () => {
      const at = await visible();
      return at.sides !== null && at.result > 1500 && at.result < 2500 && Math.abs(at.result - at.sides) < 60;
    }, "scrolled the bottom: the sides follow");
    measurements.push(`synchronized scrolling, first visible line top/bottom: ${JSON.stringify(await visible())}`);
    await closeToasts();
    await page.mouse.move(700, 500);
    await app.screenshot(`${SHOTS}/conflict-many.png`);
    // Switched off: the bottom stays put.
    await screen.getByRole("button", { name: /Synchronized scrolling/ }).click();
    const before = (await visible()).result;
    await sides.evaluate((element) => (element.scrollTop = element.scrollHeight * 0.8));
    await page.waitForTimeout(400);
    equal((await visible()).result, before, "unsynchronized: the result stays put");
    await screen.getByRole("button", { name: /Synchronized scrolling/ }).click();
    await screen.locator('button[data-take-all="ours"]').click();
    await eventually(resolved, 2, "\"All current\" resolves both");
    started = Date.now();
    await saveWithRetry(repoId, MANY);
    await done(MANY, "20,000 lines: resolved");
    measurements.push(`save and stage 20,000 lines: ${Date.now() - started} ms`);
    verifySaved(repo, MANY, toText(resultLines(manyParts, (_, part) => part.ours)), "20,000 lines");

    // 130,000 lines: first the choice of a whole side, line by line anyway on request.
    started = Date.now();
    await openConflict(tabId, HUGE);
    equal(await state(), "large", "very large file: choice of the whole version");
    check(/130,000 lines/.test(await screen.locator("[data-whole]").innerText()), "the line count is shown");
    await closeToasts();
    await page.mouse.move(700, 600);
    await app.screenshot(`${SHOTS}/conflict-large.png`);
    started = Date.now();
    await screen.locator('button[data-action="force"]').click();
    await until(async () => (await state()) === "lines" && (await counter.count()) === 1, "\"Compare line by line anyway\" opens the workbench", 60_000);
    measurements.push(`compare and show 130,000 lines: ${Date.now() - started} ms`);
    equal(await counts().then((value) => value.total), 2, "two conflicts in 130,000 lines");
    await screen.locator('button[data-take-all="theirs"]').click();
    await eventually(resolved, 2, "both resolved", 30_000);
    started = Date.now();
    await saveWithRetry(repoId, HUGE);
    await done(HUGE, "130,000 lines: resolved");
    measurements.push(`save and stage 130,000 lines: ${Date.now() - started} ms`);
    verifySaved(repo, HUGE, hugeText("feature"), "130,000 lines");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("Leaving with an unsaved solution, reset, all current / all incoming", async () => {
    const repo = lab();
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, LAB_CONFLICTS, "14 conflict files");
    await clickConflictFile(STATION);
    const initial = await result();
    const dialog = page.getByRole("dialog");
    equal(await screen.locator('button[data-action="reset"]').isDisabled(), true, "reset is disabled without changes");

    // Without changes, Esc closes right away.
    await head(0, "ours").focus();
    await press("Escape");
    await eventually(async () => (await center(tabId)).kind, "graph", "Esc closes without asking as long as nothing is decided");

    // With changes: confirmation; cancel stays.
    await clickConflictFile(STATION);
    await head(0, "ours").click();
    await eventually(resolved, 1, "one conflict resolved");
    await press("Escape");
    await dialog.getByText(/without saving\?/).waitFor({ timeout: 5000 });
    await app.screenshot(`${SHOTS}/conflict-leave.png`);
    await press("Escape");
    await until(() => dialog.count().then((count) => count === 0), "confirmation closed");
    equal((await center(tabId)).kind, "conflict", "cancel: the tool stays open");
    equal(await resolved(), 1, "the solution is still there");

    // Click another file: confirmation; "Continue later" keeps the solution.
    await page.locator(`[data-section="conflicts"] [data-row-key=${JSON.stringify(CRLF)}]`).click();
    await dialog.getByRole("button", { name: /Continue later/ }).click();
    await ready(CRLF);
    await clickConflictFile(STATION);
    await screen.locator('[data-strip="restored"]').waitFor({ timeout: 5000 });
    equal(await resolved(), 1, "the started solution is back");
    equal(await blockState(0), "ours", "with the earlier choice");

    // Reset asks first and restores the initial state.
    await screen.locator('button[data-action="reset"]').click();
    await dialog.getByRole("button", { name: "Reset" }).click();
    await eventually(resolved, 0, "reset");
    equal(await result(), initial, "result as at the start");
    equal(await screen.locator('[data-strip="restored"]').count(), 0, "notice is gone");

    // All current.
    await screen.locator('button[data-take-all="ours"]').click();
    await eventually(resolved, 3, "\"All current\" resolves all three");
    equal(await result(), toText(resultLines(stationParts, (_, part) => part.ours)), "result: the current side everywhere, one-sided changes of both sides stay");
    equal(await saveBlocked(), false, "saving possible");
    // Edit by hand, then "All incoming": asks, because typed text would be lost.
    await editorLine("SCHWELLE_FROST").click();
    await press("End");
    await page.keyboard.type("  # own addition");
    await eventually(() => blockState(0), "manual", "conflict 1 edited by hand");
    // A click on the checkbox restores the choice (the typed text goes away).
    await head(0, "ours").click();
    await eventually(() => blockState(0), "ours", "click on the checkbox: the current side again");
    equal(await result(), toText(resultLines(stationParts, (_, part) => part.ours)), "the typed addition is gone");
    await editorLine("SCHWELLE_FROST").click();
    await press("End");
    await page.keyboard.type("  # second addition");
    await eventually(() => blockState(0), "manual", "edited by hand again");
    await screen.locator('button[data-take-all="theirs"]').click();
    await dialog.getByText(/overwrite edited blocks\?/).waitFor({ timeout: 5000 });
    await dialog.getByRole("button", { name: "All incoming" }).click();
    await until(async () => (await result()) === toText(resultLines(stationParts, (_, part) => part.theirs)), "\"All incoming\" also replaces the edited block");
    equal(await blockState(0, "theirs"), "theirs", "conflict 1 now belongs to the incoming side");

    // Discard when leaving.
    await press("Escape");
    await dialog.getByRole("button", { name: /Discard solution/ }).click();
    await eventually(async () => (await center(tabId)).kind, "graph", "discarded: the tool is closed");
    await clickConflictFile(STATION);
    equal(await resolved(), 0, "nothing is chosen when reopening");
    equal(await screen.locator('[data-strip="restored"]').count(), 0, "no restored solution");
    equal(repo.unmerged(STATION) !== "", true, "git: the file is still in conflict");

    // File was already edited elsewhere: notice.
    repo.write(STATION, "# von Hand zusammengeführt\nSCHWELLE_FROST = 0.25\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await screen.locator('[data-strip="hand-edited"]').waitFor({ timeout: 20_000 });
    await app.screenshot(`${SHOTS}/conflict-hand-edited.png`);
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("External merge tool: button only with the setting, take the file as it is", async () => {
    const repo = lab();
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, LAB_CONFLICTS, "14 conflict files");
    await clickConflictFile(STATION);
    const button = screen.locator('button[data-action="external"]');
    equal(await button.count(), 0, "without a configured merge tool there is no button");
    const setSettings = async (patch) => {
      await app.invoke("settings_set", { patch });
      await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
      await app.settle();
    };
    // A "merge tool" that writes the incoming version over the file (and does not stage).
    const tool = path.join(repo.root, "merge-tool.mjs");
    fs.writeFileSync(tool, 'import fs from "node:fs";\nconst [merged, remote] = process.argv.slice(2);\nfs.copyFileSync(remote, merged);\n');
    try {
      await setSettings({ externalMergeTool: `"${process.execPath}" "${tool}" {merged} {remote}` });
      await button.waitFor({ timeout: 5000 });
      equal(await button.getAttribute("aria-label"), "Open in external tool", "\"Open in external tool\" button");
      const theirs = repo.stage(3, STATION);
      // The debug app is rebuilt all the time; if it does not know the target "merge_tool" yet, the test writes the file itself.
      const supported = await app.invoke("open_external", { repoId, target: "merge_tool", path: "does-not-exist.txt", source: null }).then(
        () => true,
        (error) => !/unknown variant/.test(String(error?.message ?? error)),
      );
      if (supported) {
        await button.click();
        await until(() => repo.read(STATION)?.equals(theirs) ?? false, "the external tool wrote the file in the working directory", 20_000);
        notes.push("External merge tool: started via the core (open_external, merge_tool).");
      } else {
        notes.push("External merge tool: NOT started via the core – the built debug app does not know the target \"merge_tool\" yet. Checked are the button and \"Take file as it is\"; the test wrote the file itself.");
        repo.write(STATION, theirs);
      }
      equal(repo.unmerged(STATION) !== "", true, "git: the file is still in conflict (the tool does not stage)");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const take = screen.locator('button[data-action="take-worktree"]');
      await take.waitFor({ timeout: 20_000 });
      check(/no longer contains conflict markers/.test(await screen.locator('[data-strip="hand-edited"]').innerText()), "notice: edited elsewhere, without markers");
      await closeToasts();
      await page.mouse.move(700, 600);
      await app.screenshot(`${SHOTS}/conflict-external.png`);
      await take.click();
      await waitConflicts(repoId, LAB_CONFLICTS.filter((file) => file !== STATION), "\"Take file as it is\" resolves the file");
      verifySaved(repo, STATION, theirs, "external tool");
      await eventually(() => center(tabId), { kind: "conflict", path: LATIN1 }, "continues with the next conflict file");
    } finally {
      await setSettings({ externalMergeTool: null });
    }
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("Rebase conflict: sides are called \"Target\" and \"Your commit\"", async () => {
    const repo = makeRebaseRepo();
    repos.push(repo);
    const { repoId, tabId } = await app.openRepo(repo.path);
    await waitConflicts(repoId, [REBASE_FILE], "one conflict file");
    await clickConflictFile(REBASE_FILE);
    const headings = await screen.getByRole("heading", { level: 3 }).allInnerTexts().then((list) => list.map((text) => text.replace(/\s+/g, " ").trim()));
    equal(headings.slice(0, 2), ["Target (main)", "Your commit (feature/nachtmodus)"], "headings during a rebase");
    check((await screen.locator('[data-tag="operation"]').innerText()).startsWith("Rebase"), "the header names the rebase");
    equal(await screen.locator("button[data-take-all]").allInnerTexts(), ["All from target", "All from your commit"], "buttons for everything from one side");
    const [part] = rebaseParts.filter((item) => item.kind === "conflict");
    check((await sides.locator('[data-side="ours"][data-line="3"]').innerText()).includes(part.ours[0]), "left shows the state of main");
    check((await sides.locator('[data-side="theirs"][data-line="3"]').innerText()).includes(part.theirs[0]), "right shows the own commit");
    check(/Current|Incoming/.test(headings.join(" ")) === false, "nowhere \"Current\" or \"Incoming\"");
    await head(0, "theirs").hover();
    await app.screenshot(`${SHOTS}/conflict-rebase.png`);
    await screen.locator('button[data-take-all="theirs"]').click();
    await eventually(resolved, 1, "own commit chosen");
    await saveButton.click();
    await eventually(() => center(tabId), { kind: "graph" }, "after saving, back in the WIP view");
    const expected = toText(resultLines(rebaseParts, (_, item) => item.theirs));
    verifySaved(repo, REBASE_FILE, expected, "Rebase");
    check((await toasts()).some((text) => /Continue the rebase in the commit panel/.test(text)), "toast names the next step");
    // Continue via the commit panel.
    await page.locator('[data-area="right"]').getByRole("button", { name: "Continue rebase" }).first().click();
    await until(() => !fs.existsSync(path.join(repo.path, ".git/rebase-merge")) && !fs.existsSync(path.join(repo.path, ".git/rebase-apply")), "git: the rebase is finished", 20_000);
    equal(repo.git("log", "--format=%s", "-n", "2"), "Nachts seltener messen\nTemperatur alle 5 Minuten", "git: the own commit sits on main");
    sameBytes(repo.read(REBASE_FILE), expected, "git: the file has the chosen version");
    equal(repo.git("status", "--porcelain"), "", "git: clean");
    await closeTab();
  });

  // -------------------------------------------------------------------------------------------
  await section("Console", async () => {
    equal(app.consoleErrors, [], "console errors");
  });
} catch (error) {
  failures.push(`Aborted: ${error?.stack ?? error}`);
} finally {
  const errors = app?.consoleErrors ?? [];
  if (app) await app.close();
  for (const repo of repos) repo.cleanup();
  if (measurements.length) console.log(`\nMeasurements\n${measurements.map((line) => `- ${line}`).join("\n")}`);
  if (notes.length) console.log(`\nNotes\n${notes.map((line) => `- ${line}`).join("\n")}`);
  if (errors.length && !failures.some((line) => line.includes("console errors"))) failures.push(`console errors: ${errors.join(" | ")}`);
  console.log(failures.length ? `\nS13: ${failures.length} failures\n${failures.map((line) => `- ${line}`).join("\n")}` : "\nS13: green.");
  process.exit(failures.length ? 1 : 0);
}
