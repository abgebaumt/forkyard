/**
 * terminal – built-in terminal, in the real app with a real shell in real repositories.
 * Also: open the repository in an external editor, terminal and file manager (with harmless stand-in programs).
 *
 *   node scripts/e2e/screens/terminal.mjs                    everything
 *   node scripts/e2e/screens/terminal.mjs --only Keyboard    only sections whose title contains the word
 *   node scripts/e2e/screens/terminal.mjs --show             window visible
 *
 * The first section does without the mouse. Checks also happen outside the app: `git log`,
 * `git status` in the repository, and whether the shell process is really gone after closing.
 *
 * Requirement: PowerShell (pwsh or powershell.exe) – the core starts it as the shell on Windows.
 * The typed commands are PowerShell; the shell history is switched off for the session so that
 * none of it ends up in the machine's history.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { isAlive, makeCleanRepoWithRemote, makeRichRepo } from "../fixtures.mjs";
import { createChecks, lines, wipDriver } from "./_wip.mjs";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots";
const checks = createChecks("terminal");
const { check, equal, eventually, section, finish } = checks;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const notes = [];
/** Cleanup that must run even after an aborted section. */
const cleanups = [];
const repos = [];
const temps = [];
const fixture = async (make, ...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const repo = make(...args);
      repos.push(repo);
      return repo;
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(1500 * attempt);
    }
  }
};

let app = null;
let ui = null;
let page = null;

const PANEL = '[data-screen="terminal"]';
const panel = () => page.locator(PANEL);
const press = (keys) => page.keyboard.press(keys);
/** The "Terminal" toggle in the window toolbar. */
const toolbarButton = () => page.locator('[data-shell] > [role="toolbar"] button[aria-pressed]').filter({ hasText: "Terminal" });

const term = {
  status: (tabId) => page.evaluate((id) => window.__gcTerminal?.status(id) ?? null, tabId),
  kind: (tabId) => page.evaluate((id) => window.__gcTerminal?.status(id)?.kind ?? null, tabId),
  text: (tabId) => page.evaluate((id) => window.__gcTerminal?.text(id) ?? "", tabId),
  size: (tabId) => page.evaluate((id) => window.__gcTerminal?.size(id) ?? null, tabId),
  options: (tabId) => page.evaluate((id) => window.__gcTerminal?.options(id) ?? null, tabId),
  selection: (tabId) => page.evaluate((id) => window.__gcTerminal?.selection(id) ?? "", tabId),
  openIds: () => page.evaluate(() => window.__gcTerminal?.openIds() ?? []),
  tabs: () => page.evaluate(() => window.__gcTerminal?.tabs() ?? []),
  /** Is focus in the terminal's input field? */
  focused: () => page.evaluate((selector) => Boolean(document.activeElement?.closest(`${selector} .xterm`)), PANEL),
  async waitKind(tabId, kind, message, timeoutMs = 30000) {
    return eventually(() => term.kind(tabId), kind, message, timeoutMs);
  },
  /** Waits until the buffer matches the pattern; returns the match. */
  async waitText(tabId, pattern, message, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = await term.text(tabId);
      const hit = text.match(pattern);
      if (hit) return hit;
      if (Date.now() > deadline) {
        check(false, `${message}: ${pattern} not in the terminal. Last lines:\n${text.split("\n").slice(-12).join("\n")}`);
        return null;
      }
      await sleep(80);
    }
  },
  /** Shows the end of the buffer (when something is wrong). */
  async dump(tabId, count = 14) {
    console.log(`  --- Terminal ---\n${(await term.text(tabId)).split("\n").slice(-count).join("\n")}\n  ----------------`);
  },
  /** Types a line and presses Enter – like at the keyboard. */
  async run(line) {
    await page.keyboard.type(line);
    await press("Enter");
  },
};

/**
 * Waits for the prompt and switches off the PowerShell history for this session. The line
 * contains "token": PSReadLine does not write such lines to its history file.
 */
async function shellReady(tabId, label = "") {
  await term.waitKind(tabId, "running", `${label}shell is running`);
  await eventually(term.focused, true, `${label}focus is in the terminal`);
  await term.run('try { Set-PSReadLineOption -HistorySaveStyle SaveNothing; Set-PSReadLineOption -PredictionSource None } catch {} ; echo ("REA" + "DY-" + (1+1)) # token');
  return Boolean(await term.waitText(tabId, /READY-2/, `${label}the shell answers`, 60000));
}

const view = (tabId) => page.evaluate((id) => window.__gc.store.getState().views[id] ?? null, tabId);
const tabsOf = () => page.evaluate(() => (window.__gc.queryClient.getQueryData(["app", "tabs"]) ?? []).map((tab) => ({ id: tab.id, active: tab.isActive, kind: tab.kind })));
const overflow = () => page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));
const activeInfo = () =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "body";
    const area = element.closest('[data-area="terminal"]') ? "terminal" : element.closest('[data-area="center"]') ? "center" : element.closest('[data-area="right"]') ? "right" : element.closest('[data-area="left"]') ? "left" : "other";
    return `${area}:${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? element.tagName}`;
  });
const token = (name) => page.evaluate((variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), `--gc-${name}`);
const dialogOpen = () => page.locator('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]').count();
/** Puts text on the machine's clipboard (via the WebView, like the app itself). */
const setClipboard = (text) =>
  page.evaluate(async (value) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      document.body.appendChild(area);
      const previous = document.activeElement;
      area.select();
      document.execCommand("copy");
      area.remove();
      if (previous instanceof HTMLElement) previous.focus();
    }
  }, text);
const graphHas = (text) => page.locator('[data-area="center"] [role="row"]').filter({ hasText: text }).count();

const run = async (title, body) => {
  await section(title, body, async (name) => {
    if (app) await app.screenshot(`target/e2e/terminal-error-${name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
  });
  // Carry nothing into the next section: open confirmations, terminals, changed settings.
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  if (!app) return;
  if (await dialogOpen().catch(() => 0)) await press("Escape").catch(() => undefined);
  await page
    .evaluate(async () => {
      // Close tabs: this also ends their terminal sessions.
      for (const tab of window.__gc.queryClient.getQueryData(["app", "tabs"]) ?? []) {
        if (tab.kind === "repo") await window.__gc.core.tabClose({ tabId: tab.id }).catch(() => undefined);
      }
      await window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] });
    })
    .catch(() => undefined);
  await ui?.closeToasts().catch(() => undefined);
};

async function start(options = {}) {
  app = await launchApp({ show, ...options });
  page = app.page;
  ui = wipDriver(app, checks);
}

async function stop() {
  if (!app) return;
  equal(app.consoleErrors, [], "console errors");
  await app.close().catch(() => undefined);
  app = null;
}

try {
  // ===========================================================================================
  await start();

  await run("Keyboard: open, type, commit, size, exit, tab switch, close tab", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "terminal-keyboard" });
    const { repoId, tabId } = await app.openRepo(repo.path);
    await eventually(async () => (await ui.status(repoId))?.head?.kind ?? null, "branch", "status loaded");

    // --- Open: Ctrl+` shows it and puts focus inside -----------------------------------------
    await press("Alt+2");
    await press("Control+`");
    await panel().waitFor({ timeout: 10000 });
    equal((await view(tabId))?.terminalOpen, true, "Ctrl+` shows the terminal");
    if (!(await shellReady(tabId))) return;
    equal(await toolbarButton().getAttribute("aria-pressed"), "true", "toolbar button shows \"shown\"");

    // --- git status and umlauts ------------------------------------------------------------
    await term.run("git status");
    await term.waitText(tabId, /(On branch|Auf Branch) main/, "git status shows the branch");
    await term.waitText(tabId, /(nothing to commit|nichts zu committen)/, "git status: clean");
    await term.run('echo ("Grü" + "ße aus Köln – größer, schöner, weiß")');
    await term.waitText(tabId, /^Grüße aus Köln – größer, schöner, weiß$/m, "echo with umlauts comes back unchanged");
    // The working directory is the repository folder.
    await term.run('echo ("DIR=" + (Get-Location).Path)');
    const where = await term.waitText(tabId, /^DIR=(.+)$/m, "working directory");
    equal(path.resolve(where?.[1] ?? "").toLowerCase(), path.resolve(repo.path).toLowerCase(), "the shell is in the repository folder");

    // --- Tab belongs to the shell; app shortcuts do not fire --------------------------------
    await press("Tab");
    check(await term.focused(), "Tab does not leave the terminal (goes to the shell)");
    const tabsBefore = (await tabsOf()).length;
    await press("Control+p");
    await press("Control+t");
    await press("Control+1");
    await press("Control+,");
    await sleep(300);
    equal(await dialogOpen(), 0, "Ctrl+P and Ctrl+, open nothing from inside the terminal");
    equal((await tabsOf()).length, tabsBefore, "Ctrl+T creates no tab from inside the terminal");
    check(await term.focused(), "focus stays in the terminal");
    // Discard whatever landed in the input line (the shell received Ctrl+P and Ctrl+T).
    await sleep(250);
    await press("Control+c");
    await sleep(400);
    await term.run('echo ("CLE" + "AN-" + (3*3))');
    await term.waitText(tabId, /^CLEAN-9$/m, "after Ctrl+C the input line is empty again");

    // --- Out and back in -------------------------------------------------------------------
    await press("F6");
    await eventually(async () => (await activeInfo()).split(":")[0], "right", "F6 leads from the terminal to the commit panel");
    await press("Shift+F6");
    await eventually(term.focused, true, "Shift+F6 leads back into the terminal");
    await press("Shift+F6");
    await eventually(async () => (await activeInfo()).split(":")[0], "center", "Shift+F6 leads from the terminal to the view");
    await press("Alt+4");
    await eventually(term.focused, true, "Alt+4 puts focus into the terminal");
    await press("Alt+1");
    await eventually(async () => (await activeInfo()).split(":")[0], "left", "Alt+1 leaves the terminal to the left panel");
    await press("Alt+4");
    await eventually(term.focused, true, "Alt+4 leads back in");

    // Ctrl+` hides it from inside the terminal – focus does not get lost – and shows it again.
    await press("Control+`");
    await eventually(() => panel().count(), 0, "Ctrl+` in the terminal hides it");
    equal(await term.kind(tabId), "running", "the shell keeps running while hidden");
    await eventually(async () => (await activeInfo()).split(":")[0], "center", "after hiding, focus is in the view");
    await press("Control+`");
    await panel().waitFor({ timeout: 10000 });
    await eventually(term.focused, true, "Ctrl+` shows it again and puts focus inside");
    check(/^CLEAN-9$/m.test(await term.text(tabId)), "the output is still there after hiding and showing");

    // --- Commit in the terminal: graph and status follow by themselves ---------------------
    const subject = "Terminal: Prüfgröße für die Station Süd geändert";
    equal(await graphHas(subject), 0, "the commit is not in the graph yet");
    await term.run(`git commit --allow-empty -m "${subject}"`);
    if (!(await eventually(() => repo.git("log", "-1", "--format=%s").trim(), subject, "git: the commit exists", 20000))) await term.dump(tabId);
    await eventually(async () => (await graphHas(subject)) > 0, true, "the graph shows the commit from the terminal – without any action", 20000);
    equal(repo.git("log", "-1", "--format=%an <%ae>").trim(), "Lena Hartmann <lena.hartmann@wetterstation.example>", "git: author as in the app");
    await eventually(async () => (await ui.status(repoId))?.upstream?.ahead ?? null, 1, "status: one commit ahead of the remote", 20000);

    await term.run("git checkout -b from-the-terminal");
    await eventually(async () => (await ui.status(repoId))?.head?.branch ?? null, "from-the-terminal", "status follows the checkout in the terminal", 20000);
    await eventually(() => page.locator('[data-area="left"]').getByText("from-the-terminal").count().then((count) => count > 0), true, "left panel shows the new branch");
    await term.run('Set-Content -Path note.txt -Value "from the terminal"');
    await eventually(async () => ((await ui.status(repoId))?.unstaged ?? []).map((file) => file.path), ["note.txt"], "the new file appears among the local changes", 20000);
    equal(lines(repo.git("status", "--porcelain")), ["?? note.txt"], "git: file exists");

    // --- Copy and paste --------------------------------------------------------------------
    await press("Shift+F10");
    await page.getByRole("menu", { name: "Terminal" }).waitFor({ timeout: 5000 });
    equal(
      await page.getByRole("menu", { name: "Terminal" }).getByRole("menuitem").evaluateAll((items) => items.map((item) => [...item.querySelectorAll("span")].find((span) => span.className.includes("flex-auto"))?.textContent ?? "")),
      ["Copy", "Paste", "Select all", "Clear scrollback", "Restart …", "End session …"],
      "context menu entries",
    );
    await ui.menuChoose("Select all");
    await eventually(async () => (await term.selection(tabId)).includes("Grüße aus Köln"), true, "\"Select all\" selects the output");
    await eventually(term.focused, true, "after the menu, focus is back in the terminal");
    await press("Control+Shift+C");
    await ui.waitToast("success", /Selection copied/);
    check((await page.evaluate(() => window.__gcUi.lastCopiedText() ?? "")).includes("Grüße aus Köln – größer, schöner, weiß"), "Ctrl+Shift+C copies the selection");
    await ui.closeToasts();
    await setClipboard('echo ("PAS" + "TED-" + (2+3))');
    await press("Alt+4");
    await eventually(term.focused, true, "focus in the terminal");
    await press("Control+Shift+V");
    await term.waitText(tabId, /"PAS" \+ "TED-"/, "Ctrl+Shift+V pastes the text");
    await press("Enter");
    await term.waitText(tabId, /^PASTED-5$/m, "the pasted command runs");
    // Ctrl+C stays the interrupt signal: a running sleep ends at once. The test run inherits
    // "ignore Ctrl+C" from its environment (a process property on Windows, inherited by child
    // processes); the core resets it before starting the shell (terminal.rs, restore_ctrl_c).
    // So nothing is switched on by hand here – the interrupt must work as is.
    await term.run('Start-Sleep -Seconds 30; echo ("NOT" + "-INTERRUPTED")');
    await sleep(800);
    await press("Control+c");
    // The shell redraws its prompt; whatever is typed at that moment is discarded.
    await sleep(800);
    await term.run('echo ("AFTER" + "-CTRL-C")');
    await term.waitText(tabId, /^AFTER-CTRL-C$/m, "Ctrl+C interrupts the running command", 10000);
    check(!/^NOT-INTERRUPTED$/m.test(await term.text(tabId)), "the interrupted command did not finish");

    // --- Size: handle via keyboard, the shell gets the new size -----------------------------
    const before = await term.size(tabId);
    const heightBefore = Math.round((await panel().boundingBox()).height);
    await press("Alt+2");
    await ui.tabUntil(() => document.activeElement?.getAttribute("role") === "separator" && document.activeElement?.getAttribute("aria-label") === "Terminal height");
    for (let step = 0; step < 4; step++) await press("ArrowUp");
    await eventually(async () => Math.round((await panel().boundingBox()).height), heightBefore + 64, "arrow up on the handle makes the terminal taller");
    equal(await page.getByRole("separator", { name: "Terminal height" }).getAttribute("aria-valuenow"), String(heightBefore + 64), "the handle reports the height");
    await eventually(async () => ((await term.size(tabId))?.rows ?? 0) > before.rows, true, "more rows in the terminal");
    const after = await term.size(tabId);
    await press("Alt+4");
    await sleep(400);
    await term.run('echo ("SIZE=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)');
    const reported = await term.waitText(tabId, /^SIZE=(\d+)x(\d+)$/m, "the shell reports its size");
    equal(reported ? [Number(reported[1]), Number(reported[2])] : null, [after.cols, after.rows], "the shell has exactly the terminal's size");
    equal(await page.evaluate(() => localStorage.getItem("gc.terminalHeight")), String(heightBefore + 64), "the height is remembered");

    // --- exit → ended → restart ------------------------------------------------------------
    await term.run("exit 3");
    await term.waitKind(tabId, "exited", "after exit the shell has ended");
    equal((await term.status(tabId))?.code, 3, "the exit code arrives");
    await eventually(() => panel().getAttribute("data-state"), "exited", "the panel shows the state");
    check((await panel().locator("footer").innerText()).includes("exit code 3"), "the exit code is shown");
    equal(await term.openIds(), [], "no terminal registered with the core anymore");
    check((await term.text(tabId)).includes("PASTED-5"), "the output stays readable after the end");
    await eventually(activeInfo, "terminal:Restart", "focus is on \"Restart\"");
    await app.screenshot(`${SHOTS}/terminal-exited.png`);
    await press("Enter");
    if (!(await shellReady(tabId, "restart: "))) return;
    check(!(await term.text(tabId)).includes("PASTED-5"), "the restart begins with an empty screen");
    equal(await panel().locator("footer").count(), 0, "the \"ended\" bar is gone");

    // --- Switch tab and back: output keeps flowing and stays ------------------------------
    await term.run('echo ("PID=" + $PID)');
    const pidHit = await term.waitText(tabId, /^PID=(\d+)$/m, "PID of the shell");
    const pid = Number(pidHit?.[1] ?? 0);
    check(pid > 0 && isAlive(pid), `the shell process is running (PID ${pid})`);
    await term.run('Start-Sleep -Seconds 3; echo ("LA" + "TER-" + (40+2))');
    const other = await fixture(makeCleanRepoWithRemote, { name: "terminal-second-tab" });
    const second = await app.openRepo(other.path);
    equal(await panel().count(), 0, "no terminal is shown in the second tab");
    equal(await term.kind(tabId), "running", "the first tab's shell keeps running");
    await sleep(3500);
    await press("Alt+2");
    await press("Control+Shift+Tab");
    await eventually(async () => (await tabsOf()).find((tab) => tab.active)?.id ?? null, tabId, "Ctrl+Shift+Tab switches back");
    await panel().waitFor({ timeout: 10000 });
    const kept = await term.text(tabId);
    check(/^PID=\d+$/m.test(kept), "the output from before the switch is still there");
    check(/^LATER-42$/m.test(kept), "what was printed during the switch has arrived");
    await eventually(async () => (await page.locator(`${PANEL} .xterm-rows`).innerText()).includes("LATER-42"), true, "and it is drawn too");

    // The second tab gets its own terminal in its own folder. Ctrl+Tab also works from inside the terminal.
    await press("Alt+4");
    await eventually(term.focused, true, "focus in the first tab's terminal");
    await press("Control+Tab");
    await eventually(async () => (await tabsOf()).find((tab) => tab.active)?.id ?? null, second.tabId, "Ctrl+Tab switches to the second tab");
    await press("Alt+4");
    await panel().waitFor({ timeout: 10000 });
    if (!(await shellReady(second.tabId, "second tab: "))) {
      console.log("  sessions:", await term.tabs(), "active:", (await tabsOf()).find((tab) => tab.active)?.id, "second:", second.tabId, "focus:", await activeInfo());
      await app.screenshot("target/e2e/terminal-second-tab.png").catch(() => undefined);
      return;
    }
    await term.run('echo ("DIR=" + (Get-Location).Path)');
    const whereSecond = await term.waitText(second.tabId, /^DIR=(.+)$/m, "working directory in the second tab");
    equal(path.resolve(whereSecond?.[1] ?? "").toLowerCase(), path.resolve(other.path).toLowerCase(), "the second tab has its own shell in its own folder");
    equal((await term.openIds()).length, 2, "two terminals in the core");
    await term.run('echo ("PID=" + $PID)');
    const pidSecond = Number((await term.waitText(second.tabId, /^PID=(\d+)$/m, "PID of the second shell"))?.[1] ?? 0);
    check(pidSecond > 0 && pidSecond !== pid, "separate process");

    // --- Close tab: the process is gone ----------------------------------------------------
    // Ctrl+W means something else in the shell: leave first (F6), then close.
    await press("Control+w");
    await sleep(300);
    equal((await tabsOf()).length, 2, "Ctrl+W in the terminal does not close the tab");
    await press("F6");
    await eventually(term.focused, false, "F6 leaves the terminal");
    // This shell was used: the tab asks before ending it along with itself.
    const closeQuestion = page.getByRole("dialog", { name: /and end the terminal\?/ });
    await press("Control+w");
    await closeQuestion.waitFor({ timeout: 10000 });
    equal(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim()), "Cancel", "close confirmation: focus is on \"Cancel\"");
    await press("Escape");
    await closeQuestion.waitFor({ state: "detached", timeout: 10000 });
    await sleep(300);
    check((await tabsOf()).some((tab) => tab.id === second.tabId) && isAlive(pidSecond), "Esc: tab and shell stay");
    await press("Control+w");
    await closeQuestion.waitFor({ timeout: 10000 });
    await press("Tab");
    equal(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim()), "Close tab", "Tab leads to \"Close tab\"");
    await press("Enter");
    await eventually(async () => (await tabsOf()).some((tab) => tab.id === second.tabId), false, "Ctrl+W closes the tab – after confirming");
    await eventually(() => isAlive(pidSecond), false, "the closed tab's shell has ended", 15000);
    equal(await term.tabs(), [tabId], "only the first tab's session remains");
    check(isAlive(pid), "the other tab's shell keeps running");
    await eventually(async () => (await tabsOf()).find((tab) => tab.active)?.id ?? null, tabId, "the first tab is in front again");
    await panel().waitFor({ timeout: 10000 });
    await press("Alt+2");
    await press("Control+w");
    await closeQuestion.waitFor({ timeout: 10000 });
    await press("Tab");
    await press("Enter");
    await eventually(async () => (await tabsOf()).some((tab) => tab.id === tabId), false, "the first tab is closed too");
    await eventually(() => isAlive(pid), false, "no orphaned shell", 15000);
    equal(await term.openIds(), [], "no terminal is open in the core anymore");
    equal(await term.tabs(), [], "no session left");
  });

  // ===========================================================================================
  await run("Mouse: toolbar, drag handle, context menu, hide, end session, forget repository", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "terminal-mouse" });
    const { repoId, tabId } = await app.openRepo(repo.path);
    await toolbarButton().click();
    await panel().waitFor({ timeout: 10000 });
    if (!(await shellReady(tabId))) return;
    // The previous section changed the height; double-clicking the handle restores the default.
    await page.getByRole("separator", { name: "Terminal height" }).dblclick();
    await page.mouse.move(700, 300);

    // Structure and names
    equal(await panel().getAttribute("aria-label"), "Terminal", "the region is called \"Terminal\"");
    check((await panel().locator("header").innerText()).toLowerCase().includes(path.basename(repo.path).toLowerCase()), "the header names the folder");
    equal(
      await panel().locator("header button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
      ["Clear scrollback – the output scrolled out of view", "Restart …", "Open in external terminal", "End session …", "Hide terminal – the shell keeps running"],
      "header actions, all named",
    );
    equal(await page.locator(`${PANEL} textarea`).getAttribute("aria-label"), "Terminal input", "the input field has a name");

    // Drag the handle: 80 px up
    const handle = page.getByRole("separator", { name: "Terminal height" });
    const box = await handle.boundingBox();
    const startHeight = Math.round((await panel().boundingBox()).height);
    equal(startHeight, 256, "default height");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 80, { steps: 4 });
    await page.mouse.up();
    await eventually(async () => Math.round((await panel().boundingBox()).height), 336, "dragging the handle changes the height");
    const tall = await term.size(tabId);
    // Drag very far: the view above keeps its space.
    const again = await handle.boundingBox();
    await page.mouse.move(again.x + 200, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x + 200, 0, { steps: 6 });
    await page.mouse.up();
    const centerHeight = async () => Math.round((await page.locator('[data-area="center"]').boundingBox()).height);
    await eventually(async () => (await centerHeight()) >= 140, true, "the view keeps at least 140 px");
    check((await centerHeight()) <= 141 || Math.round((await panel().boundingBox()).height) === 720, "the terminal takes the rest (or its maximum)");
    await handle.dblclick();
    await eventually(async () => Math.round((await panel().boundingBox()).height), 256, "double-click restores the default height");
    await eventually(async () => (await term.size(tabId)).rows < tall.rows, true, "the row count follows the height");

    // Many lines, long line, scrollback
    await page.locator(`${PANEL} .xterm-screen`).click();
    await eventually(term.focused, true, "click puts focus into the terminal");
    await term.run('1..3000 | ForEach-Object { "Line $_ of the long output" }; echo ("DO" + "NE-3000")');
    await term.waitText(tabId, /^DONE-3000$/m, "3000 lines are through", 60000);
    const many = await term.size(tabId);
    check(many.lines > 3000, `scrollback holds the output (${many.lines} lines)`);
    check((await term.text(tabId)).includes("Line 1 of the long output") && (await term.text(tabId)).includes("Line 3000 of the long output"), "first and last line are in the buffer");
    equal((await term.options(tabId)).scrollback, 5000, "scrollback: 5000 lines");
    await press("Shift+PageUp");
    await press("Shift+PageUp");
    await eventually(async () => {
      const size = await term.size(tabId);
      return size.viewportY < size.baseY;
    }, true, "Shift+PgUp scrolls back");
    await app.screenshot(`${SHOTS}/terminal-many.png`);
    await page.locator(`${PANEL} .xterm-screen`).hover();
    const scrolledUp = (await term.size(tabId)).viewportY;
    await page.mouse.wheel(0, -300);
    await eventually(async () => (await term.size(tabId)).viewportY < scrolledUp, true, "the mouse wheel scrolls further back");
    for (let notch = 0; notch < 60; notch++) {
      const size = await term.size(tabId);
      if (size.viewportY === size.baseY) break;
      await page.mouse.wheel(0, 2000);
      await sleep(50);
    }
    await eventually(async () => {
      const size = await term.size(tabId);
      return size.viewportY === size.baseY;
    }, true, "the mouse wheel scrolls back to the end");
    await term.run('echo ("LONG:" + ("x" * 700) + ":END")');
    await term.waitText(tabId, /LONG:x{700}:END/, "a very long line is wrapped, not cut off");
    equal(await overflow(), { x: 0, y: 0 }, "nothing overflows");

    // Selecting with the mouse, context menu
    await panel().locator('[data-action="clear"]').click();
    await eventually(async () => (await term.size(tabId)).lines <= (await term.size(tabId)).rows, true, "\"Clear scrollback\" discards the scrolled-out output");
    check(!(await term.text(tabId)).includes("Line 1 of the long output"), "the old lines are no longer in the buffer");
    check((await term.text(tabId)).includes(":END"), "what was visible stays");
    await page.locator(`${PANEL} .xterm-screen`).click();
    await term.run('echo ("MARK-" + (7*6))');
    await term.waitText(tabId, /^MARK-42$/m, "output after clearing");
    const prompts = (await term.text(tabId)).split("\n");
    check(!prompts.slice(prompts.findIndex((line) => line.includes(":END"))).some((line) => line.trim() === ""), "afterwards the shell continues without gaps (no shifted prompt)");
    const rowBox = await page.locator(`${PANEL} .xterm-rows > div`).filter({ hasText: /^MARK-42/ }).first().boundingBox();
    await page.mouse.dblclick(rowBox.x + 20, rowBox.y + rowBox.height / 2);
    await eventually(() => term.selection(tabId), "MARK-42", "double-click selects the word under the mouse");
    await page.mouse.click(rowBox.x + 20, rowBox.y + rowBox.height / 2, { button: "right" });
    const menu = page.getByRole("menu", { name: "Terminal" });
    await menu.waitFor({ timeout: 5000 });
    await app.screenshot(`${SHOTS}/terminal-menu.png`);
    await menu.getByRole("menuitem", { name: /Copy/ }).click();
    await ui.waitToast("success", /Selection copied/);
    equal(await page.evaluate(() => window.__gcUi.lastCopiedText()), "MARK-42", "copy from the menu");
    await ui.closeToasts();
    // Paste from the menu: the WebView asks for permission on the first clipboard read;
    // nobody can answer in the invisible test window, so it is granted here in advance.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: app.devUrl }).catch((error) => notes.push(`Clipboard permission could not be granted: ${error?.message ?? error}`));
    await setClipboard('echo ("MENU" + "-PASTE")');
    await page.locator(`${PANEL} .xterm-screen`).click({ button: "right" });
    await menu.waitFor({ timeout: 5000 });
    await menu.getByRole("menuitem", { name: /Paste/ }).click();
    const pasted = await term.waitText(tabId, /"MENU" \+ "-PASTE"/, "paste from the menu", 8000);
    if (pasted) {
      await eventually(term.focused, true, "afterwards focus is in the terminal");
      await press("Enter");
      await term.waitText(tabId, /^MENU-PASTE$/m, "the pasted command runs");
    }

    // Hide: the shell keeps running, the output stays
    await term.run('echo ("PID=" + $PID)');
    const pid = Number((await term.waitText(tabId, /^PID=(\d+)$/m, "PID"))?.[1] ?? 0);
    await panel().locator('[data-action="hide"]').click();
    await eventually(() => panel().count(), 0, "hidden");
    equal(await term.kind(tabId), "running", "the shell keeps running while hidden");
    check(isAlive(pid), "the process is alive");
    await toolbarButton().click();
    await panel().waitFor({ timeout: 10000 });
    check(/^MARK-42$/m.test(await term.text(tabId)), "after showing, the output is still there");
    if (!(await eventually(term.focused, true, "showing puts focus into the terminal"))) console.log("  focus is on:", await activeInfo());

    // End session: asks first
    await page.getByRole("button", { name: "End session …" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await dialog.getByText("End terminal session?").waitFor({ timeout: 5000 });
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on \"Cancel\"");
    await page.mouse.move(760, 58);
    await app.screenshot(`${SHOTS}/terminal-confirm.png`);
    await press("Enter");
    await eventually(dialogOpen, 0, "confirmation closed");
    equal(await term.kind(tabId), "running", "Cancel leaves the shell running");
    await page.getByRole("button", { name: "End session …" }).click();
    await dialog.getByRole("button", { name: "End session" }).click();
    await eventually(() => panel().count(), 0, "after ending, the terminal is hidden");
    await eventually(() => isAlive(pid), false, "the shell has ended", 15000);
    equal(await term.tabs(), [], "no session left");
    equal((await view(tabId))?.terminalOpen, false, "the region is closed");

    // Open again: fresh shell; restart with confirmation
    await toolbarButton().click();
    await panel().waitFor({ timeout: 10000 });
    if (!(await shellReady(tabId, "new session: "))) return;
    check(!/MARK-42/.test(await term.text(tabId)), "the new session starts empty");
    await term.run('echo ("PID=" + $PID)');
    const pidNew = Number((await term.waitText(tabId, /^PID=(\d+)$/m, "PID"))?.[1] ?? 0);
    await page.getByRole("button", { name: "Restart …" }).click();
    await dialog.getByText("Restart terminal?").waitFor({ timeout: 5000 });
    await dialog.getByRole("button", { name: "Restart" }).click();
    await eventually(() => isAlive(pidNew), false, "the old shell has ended", 15000);
    if (!(await shellReady(tabId, "after restart: "))) return;
    await term.run('echo ("PID=" + $PID)');
    const pidRestarted = Number((await term.waitText(tabId, /^PID=(\d+)$/m, "PID"))?.[1] ?? 0);
    check(pidRestarted > 0 && pidRestarted !== pidNew, "a new shell is running");
    equal((await term.openIds()).length, 1, "exactly one terminal in the core");

    // Commands in the registry
    const commands = await page.evaluate(() => window.__gcUi.commands().filter((command) => command.id.startsWith("terminal.") || command.id === "view.terminal"));
    equal(
      commands.map((command) => `${command.id}|${command.shortcut ?? ""}|${command.available}`).sort(),
      ["terminal.clear||true", "terminal.end||true", "terminal.focus|Alt+4|true", "terminal.restart||true", "view.terminal|Mod+`|true"],
      "terminal commands in the registry",
    );

    // Forget repository: the core closes the tab, the UI ends the shell
    await app.invoke("repo_forget", { repoId });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await eventually(async () => (await tabsOf()).some((tab) => tab.id === tabId), false, "the forgotten repository's tab is gone");
    await eventually(() => isAlive(pidRestarted), false, "its shell has ended", 15000);
    equal(await term.openIds(), [], "no terminal is open in the core anymore");
  });

  // ===========================================================================================
  await run("States: starting, start error (16 terminals), folder missing", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "terminal-states" });
    const { repoId, tabId } = await app.openRepo(repo.path);

    // Open 16 terminals behind the UI's back: the 17th is refused.
    const blockers = [];
    const closeBlockers = async () => {
      for (const terminalId of blockers.splice(0)) await app.invoke("terminal_close", { terminalId }).catch(() => undefined);
    };
    cleanups.push(closeBlockers);
    for (let index = 0; index < 16; index++) blockers.push(await app.invoke("terminal_open", { repoId, cols: 80, rows: 24 }));
    await eventually(() => app.invoke("terminal_open", { repoId, cols: 80, rows: 24 }).then((id) => (blockers.push(id), "open")).catch((error) => error.code), "not_allowed", "the core refuses the 17th terminal");
    await press("Alt+4");
    await panel().waitFor({ timeout: 10000 });
    await term.waitKind(tabId, "failed", "the 17th terminal does not start");
    equal((await term.status(tabId))?.code, "not_allowed", "error code from the core");
    const alert = panel().getByRole("alert");
    await alert.waitFor({ timeout: 5000 });
    const alertText = await alert.innerText();
    check(alertText.includes("No further terminal can be opened right now") && alertText.includes("16 terminals"), `the message names the reason (${alertText.replace(/\s+/g, " ")})`);
    await eventually(activeInfo, "terminal:Try again", "focus is on \"Try again\"");
    await page.mouse.move(760, 58);
    await app.screenshot(`${SHOTS}/terminal-error.png`);
    await press("Enter");
    await sleep(400);
    equal(await term.kind(tabId), "failed", "while 16 are open, the second attempt fails too");
    await closeBlockers();
    await sleep(500);
    await eventually(activeInfo, "terminal:Try again", "focus still on \"Try again\"");
    await press("Enter");
    if (!(await shellReady(tabId, "after the error: "))) return;
    equal(await panel().getByRole("alert").count(), 0, "the error message is gone");

    // The "starting" state is short; it can be caught during a restart.
    await page.evaluate(() => {
      void window.__gcUi.runCommand("terminal.restart");
    });
    await page.getByText("Restart terminal?").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    const seenStarting = await page
      .waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-state") === "starting" && document.querySelector(`${selector} [role="status"]`)?.textContent?.includes("Shell is starting"), PANEL, { timeout: 5000, polling: 10 })
      .then(() => true)
      .catch(() => false);
    check(seenStarting, "while starting, \"Shell is starting …\" is shown");
    if (seenStarting) {
      await app.screenshot(`${SHOTS}/terminal-starting.png`).catch(() => undefined);
      // Only keep it if the state still held while capturing.
      if ((await panel().getAttribute("data-state")) !== "starting") notes.push("terminal-starting.png: the shell was faster than the capture; the image already shows the running state.");
    }
    if (!(await shellReady(tabId, "after restart: "))) return;

    // Folder missing: end the shell (it holds the folder), move the folder away, restart.
    await term.run("exit");
    await term.waitKind(tabId, "exited", "shell ended");
    equal((await term.status(tabId))?.code, 0, "exit code 0");
    check((await panel().locator("footer").innerText()).includes("exit code 0"), "exit code 0 is shown");
    const away = `${repo.path}-gone`;
    let moved = false;
    for (let attempt = 0; attempt < 20 && !moved; attempt++) {
      try {
        fs.renameSync(repo.path, away);
        moved = true;
      } catch {
        await sleep(250);
      }
    }
    if (!check(moved, "the repository folder can be moved away (the shell no longer holds it)")) return;
    try {
      await eventually(activeInfo, "terminal:Restart", "focus on \"Restart\"");
      await press("Enter");
      await term.waitKind(tabId, "failed", "without the folder the shell does not start");
      equal((await term.status(tabId))?.code, "path_not_found", "error code: folder missing");
    } finally {
      fs.renameSync(away, repo.path);
    }
    // The app may have noticed the folder missing; with the folder back, the view returns.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const recheck = page.getByRole("button", { name: "Check again" });
    if (await recheck.count()) await recheck.click();
    await page.evaluate((id) => {
      void window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "repos"] });
      void window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id] });
    }, repoId);
    await panel().waitFor({ timeout: 15000 });
    const missing = await panel().getByRole("alert").innerText();
    check(missing.includes("The repository's folder is missing"), `the message says the folder is missing (${missing.replace(/\s+/g, " ")})`);
    await page.mouse.move(760, 58);
    await app.screenshot(`${SHOTS}/terminal-missing.png`);
    await panel().getByRole("button", { name: "Try again" }).click();
    if (!(await shellReady(tabId, "folder back: "))) return;
    await page.evaluate(() => {
      void window.__gcUi.runCommand("terminal.end");
    });
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await eventually(term.tabs, [], "session ended");
  });

  // ===========================================================================================
  await run("Appearance: tokens, theme switch, font, zoom, 960×600, screenshots", async () => {
    const repo = await fixture(makeRichRepo, { name: "wetterstation" });
    const { tabId } = await app.openRepo(repo.path);
    await press("Alt+4");
    await panel().waitFor({ timeout: 10000 });
    if (!(await shellReady(tabId))) return;
    await page.locator(`${PANEL} .xterm-screen`).click();
    await term.run("clear");
    await sleep(500);
    await panel().locator('[data-action="clear"]').click();
    await page.locator(`${PANEL} .xterm-screen`).click();
    // Short prompt so that command and output fit in the region.
    await term.run('function prompt { "wetterstation> " }');
    await term.run("clear");
    await sleep(400);
    await panel().locator('[data-action="clear"]').click();
    await page.locator(`${PANEL} .xterm-screen`).click();
    await term.run("git --no-pager -c color.ui=always log --oneline --decorate -3");
    await term.waitText(tabId, /^[0-9a-f]{7} .*HEAD -> main/m, "git log in the terminal");
    await term.run("git -c color.ui=always status --short --branch | Select-Object -First 3");
    await term.waitText(tabId, /^## main\.\.\.origin\/main/m, "git status in the terminal");
    await sleep(300);

    // Colors and font come from the tokens
    const options = await term.options(tabId);
    equal(options.theme.background, await token("surface-sunken"), "background = surface-sunken");
    equal(options.theme.foreground, await token("text"), "Text = text");
    equal(options.theme.cursor, await token("accent"), "Cursor = accent");
    equal(options.theme.red, await token("term-red"), "red = term-red");
    equal(options.theme.brightBlue, await token("term-bright-blue"), "bright blue = term-bright-blue");
    equal(options.fontFamily, await token("font-mono"), "font = font-mono");
    const settings = await app.invoke("settings_get");
    equal(options.fontSize, settings.editorFontSize, "font size as in the editor");
    const rowFont = await page.locator(`${PANEL} .xterm-rows`).evaluate((rows) => getComputedStyle(rows).fontFamily);
    check(rowFont.includes("JetBrains Mono"), `drawn in the mono font (${rowFont})`);
    const colored = await page.locator(`${PANEL} .xterm-rows span[class*="xterm-fg-"], ${PANEL} .xterm-rows span[style*="color"]`).count();
    check(colored > 0, "colored Git output is drawn in color");

    await page.mouse.move(760, 58);
    await app.settle();
    await app.screenshot(`${SHOTS}/terminal.png`);

    // Theme switch takes effect immediately
    await app.setTheme("light");
    await eventually(async () => (await term.options(tabId)).theme.background, await token("surface-sunken"), "after switching to light: new background");
    equal((await term.options(tabId)).theme.red, await token("term-red"), "light red");
    check((await term.options(tabId)).theme.background !== options.theme.background, "light and dark differ");
    await eventually(
      () =>
        page.evaluate((selector) => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue("--gc-surface-sunken");
          document.body.appendChild(probe);
          const wanted = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return [...document.querySelectorAll(`${selector} .xterm, ${selector} .xterm *`)].some((element) => getComputedStyle(element).backgroundColor === wanted);
        }, PANEL),
      true,
      "the drawn background is light",
    );
    await app.screenshot(`${SHOTS}/terminal-light.png`);
    await app.setTheme("dark");
    await eventually(async () => (await term.options(tabId)).theme.background, options.theme.background, "back to dark");

    // Font size follows the setting
    const colsBefore = (await term.size(tabId)).cols;
    await app.invoke("settings_set", { patch: { editorFontSize: settings.editorFontSize + 4 } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await eventually(async () => (await term.options(tabId)).fontSize, settings.editorFontSize + 4, "larger font arrives");
    await eventually(async () => (await term.size(tabId)).cols < colsBefore, true, "with a larger font fewer columns fit");
    await app.invoke("settings_set", { patch: { editorFontSize: settings.editorFontSize } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await eventually(async () => (await term.size(tabId)).cols, colsBefore, "back to the old size");

    // Zoom 120 %: the grid stays correct, mouse selection hits
    await app.invoke("settings_set", { patch: { zoom: 1.2 } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await eventually(() => page.evaluate(() => document.documentElement.style.getPropertyValue("zoom")), "1.2", "Zoom 120 %");
    await sleep(400);
    const fits = await page.evaluate((selector) => {
      const screen = document.querySelector(`${selector} .xterm-screen`).getBoundingClientRect();
      const body = document.querySelector(`${selector} [data-terminal-body]`).getBoundingClientRect();
      return { inside: screen.right <= body.right + 1 && screen.bottom <= body.bottom + 1, slackX: Math.round(body.right - screen.right), slackY: Math.round(body.bottom - screen.bottom) };
    }, PANEL);
    check(fits.inside, `at 120 % the grid stays inside the region (${JSON.stringify(fits)})`);
    check(fits.slackX <= 40 && fits.slackY <= 30, `at 120 % the grid fills the region (${JSON.stringify(fits)})`);
    await page.locator(`${PANEL} .xterm-screen`).click();
    await term.run('echo ("ZOOM-" + (60+60))');
    await term.waitText(tabId, /^ZOOM-120$/m, "output at 120 %");
    const zoomRow = await page.locator(`${PANEL} .xterm-rows > div`).filter({ hasText: /^ZOOM-120/ }).first().boundingBox();
    await page.mouse.dblclick(zoomRow.x + 24, zoomRow.y + zoomRow.height / 2);
    await eventually(() => term.selection(tabId), "ZOOM-120", "at 120 % the mouse hits the right row and column");
    await term.run('echo ("SIZE=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)');
    const zoomed = await term.waitText(tabId, /^SIZE=(\d+)x(\d+)$/m, "size at 120 %");
    const zoomSize = await term.size(tabId);
    equal(zoomed ? [Number(zoomed[1]), Number(zoomed[2])] : null, [zoomSize.cols, zoomSize.rows], "at 120 % the shell knows the size");
    await page.mouse.move(760, 58);
    await app.screenshot(`${SHOTS}/terminal-zoom.png`);
    await app.invoke("settings_set", { patch: { zoom: 1 } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await eventually(() => page.evaluate(() => document.documentElement.style.getPropertyValue("zoom")), "1", "zoom back");
    await term.run("clear");
    await sleep(400);
    await term.run("git --no-pager -c color.ui=always log --oneline --decorate -3");
    await term.run('git -c color.ui=always status --short --branch | Select-Object -First 2; echo ("SMALL" + "-OK")');
    await term.waitText(tabId, /^SMALL-OK$/m, "output done");

    // Minimum window
    await app.setSize(960, 600);
    await eventually(overflow, { x: 0, y: 0 }, "no overflow at 960×600");
    const small = await panel().boundingBox();
    check(small.y + small.height <= 600 - 24 + 1, "the terminal ends above the status bar");
    check(Math.round((await page.locator('[data-area="center"]').boundingBox()).height) >= 140, "the view above keeps its space");
    const headerButtons = await panel().locator("header button").evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().right <= document.documentElement.clientWidth && button.getBoundingClientRect().width >= 24));
    check(headerButtons, "all header actions stay visible");
    await term.run('echo ("SIZE=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)');
    const reported = await term.waitText(tabId, /^SIZE=(\d+)x(\d+)$/m, "size in the small window");
    const size = await term.size(tabId);
    equal(reported ? [Number(reported[1]), Number(reported[2])] : null, [size.cols, size.rows], "after shrinking the window the shell knows the new size");
    await page.mouse.move(640, 58);
    await app.screenshot(`${SHOTS}/terminal-min.png`);
    await app.setTheme("light");
    await sleep(200);
    await app.screenshot(`${SHOTS}/terminal-min-light.png`);
    await app.setTheme("dark");
    await app.setSize(1440, 900);

    // The remembered height survives a UI restart; the old window's shell does not linger.
    await term.run('echo ("PID=" + $PID)');
    const pid = Number((await term.waitText(tabId, /^PID=(\d+)$/m, "PID"))?.[1] ?? 0);
    await page.getByRole("separator", { name: "Terminal height" }).focus();
    await press("Shift+ArrowUp");
    await eventually(() => page.evaluate(() => localStorage.getItem("gc.terminalHeight")), "320", "Shift+↑ on the handle: 64 px taller, remembered");
    await app.reload();
    await eventually(() => isAlive(pid), false, "after reloading, the old window's shell has ended", 15000);
    await page.evaluate((id) => window.__gc.store.getState().toggleTerminal(id), tabId);
    await panel().waitFor({ timeout: 10000 });
    await eventually(async () => Math.round((await panel().boundingBox()).height), 320, "the remembered height applies again");
    await term.waitKind(tabId, "running", "new shell after reloading");
    await page.getByRole("separator", { name: "Terminal height" }).focus();
    await press("Home");
    await eventually(async () => Math.round((await panel().boundingBox()).height), 112, "Home: smallest height");
    await press("End");
    await eventually(async () => Math.round((await page.locator('[data-area="center"]').boundingBox()).height) >= 140, true, "End: largest height, the view keeps its space");
    await press("Enter");
    await eventually(() => panel().count(), 0, "Enter on the handle hides the terminal");
    await page.evaluate(() => localStorage.removeItem("gc.terminalHeight"));
    await page.evaluate(() => {
      void window.__gcUi.runCommand("terminal.end");
    });
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await eventually(term.tabs, [], "session ended");
  });

  await stop();

  // ===========================================================================================
  // Open externally: editor, terminal, file manager – with harmless stand-in programs that only note
  // what they were started with.
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "gc-s18-tools-"));
  temps.push(tools);
  const note = path.join(tools, "note.cjs");
  fs.writeFileSync(note, `const fs = require("node:fs");\nconst path = require("node:path");\nconst name = path.basename(process.execPath, ".exe").toLowerCase() === "explorer" ? "explorer" : process.argv[2];\nfs.writeFileSync(path.join(__dirname, name + ".json"), JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }));\n`);
  // Stand-in for explorer.exe: Node under another name that only writes the note on start.
  const fakeBin = path.join(tools, "bin");
  fs.mkdirSync(fakeBin);
  let fakeExplorer = true;
  try {
    try {
      fs.linkSync(process.execPath, path.join(fakeBin, "explorer.exe"));
    } catch {
      fs.copyFileSync(process.execPath, path.join(fakeBin, "explorer.exe"));
    }
  } catch {
    fakeExplorer = false;
  }
  const noted = async (name, timeoutMs = 15000) => {
    const file = path.join(tools, `${name}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        await sleep(100);
      }
    }
    return null;
  };
  const forget = (name) => fs.rmSync(path.join(tools, `${name}.json`), { force: true });
  const same = (a, b) => path.resolve(a ?? "").toLowerCase() === path.resolve(b ?? "").toLowerCase();

  await start({
    env: fakeExplorer ? { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`, Path: undefined, NODE_OPTIONS: `--require "${note.replaceAll("\\", "/")}"` } : {},
  });

  await run("Open externally: editor, terminal and file manager really start", async () => {
    const repo = await fixture(makeCleanRepoWithRemote, { name: "open external" });
    const { repoId } = await app.openRepo(repo.path);
    const noErrors = async (message) => equal(await page.locator('[data-toast="danger"]').count(), 0, message);
    const node = process.execPath;

    // Editor: command from the settings, {path} is replaced – also with spaces in the path.
    // The stand-in terminal is a batch script: the core starts it without its own console window.
    const fakeTerminal = path.join(tools, "terminal.cmd");
    fs.writeFileSync(fakeTerminal, `@echo off\r\n"${node}" "${note}" terminal %*\r\n`);
    await app.invoke("settings_set", { patch: { externalEditor: `"${node}" "${note}" editor --target {path}`, externalTerminal: `"${fakeTerminal}" {path}` } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await press("Alt+2");
    await press("Alt+e");
    const editor = await noted("editor");
    check(editor !== null, "Alt+E starts the configured editor");
    if (editor) {
      equal(editor.argv.slice(1, 3), ["editor", "--target"], "editor: command arguments");
      check(same(editor.argv[3], repo.path), `editor: {path} is the repository folder (${editor.argv[3]})`);
      check(same(editor.cwd, repo.path), "editor: working directory is the repository");
    }
    await noErrors("Alt+E reports no error");
    forget("editor");
    // A single file
    await page.evaluate((id) => window.__gcUi.actions.files.openExternal(id, "editor", "src/vergleich.py"), repoId);
    const editorFile = await noted("editor");
    check(editorFile && same(editorFile.argv[3], path.join(repo.path, "src", "vergleich.py")), `editor: a file is passed with its full path (${editorFile?.argv[3]})`);
    forget("editor");

    // Terminal: command from the settings, working directory is the folder.
    await press("Alt+t");
    const external = await noted("terminal");
    check(external !== null, "Alt+T starts the configured terminal");
    if (external) {
      check(same(external.argv[2], repo.path), `terminal: {path} is the folder (${external.argv[2]})`);
      check(same(external.cwd, repo.path), "terminal: starts in the repository folder");
    }
    await noErrors("Alt+T reports no error");
    forget("terminal");

    // The same path via the button in the built-in terminal's header.
    await press("Alt+4");
    await panel().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Open in external terminal" }).click();
    const fromPanel = await noted("terminal");
    check(fromPanel && same(fromPanel.cwd, repo.path), "the \"Open in external terminal\" button in the terminal header starts it");
    forget("terminal");
    await panel().locator('[data-action="hide"]').click();

    // File manager: the core calls explorer.exe; a stand-in is placed before it in PATH.
    if (!check(fakeExplorer, "stand-in for explorer.exe could be created")) return;
    await press("Alt+2");
    await press("Alt+d");
    const explorer = await noted("explorer");
    check(explorer !== null, "Alt+D starts the file manager");
    if (explorer) {
      check(same(explorer.argv[0], repo.path), `file manager: gets the repository folder (${explorer.argv[0]})`);
      check(same(explorer.cwd, repo.path), "file manager: working directory is the repository");
    }
    await noErrors("Alt+D reports no error");
    forget("explorer");
    await page.evaluate((id) => window.__gcUi.actions.files.openExternal(id, "file_manager", "src/vergleich.py"), repoId);
    const selected = await noted("explorer");
    const raw = selected?.argv[0] ?? "";
    check(/select,/i.test(raw) && raw.toLowerCase().replaceAll("/", "\\").endsWith(path.join(repo.path, "src", "vergleich.py").toLowerCase()), `file manager: a file is selected (/select,…) (${raw})`);
    forget("explorer");

    // Without a configured editor the system default program opens – via Explorer on Windows.
    await app.invoke("settings_set", { patch: { externalEditor: null } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await press("Alt+2");
    await press("Alt+e");
    const byDefault = await noted("explorer");
    check(byDefault && same(byDefault.argv[0], repo.path), `without a setting "Open in editor" goes to the default program (${byDefault?.argv[0]})`);
    await noErrors("Alt+E without a setting reports no error");
    forget("explorer");

    // If the program is missing, the message says so.
    await app.invoke("settings_set", { patch: { externalTerminal: "no-such-terminal {path}" } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await press("Alt+t");
    const missing = await ui.waitToast("danger", /no-such-terminal/);
    check(missing?.includes("not found"), "missing program: understandable message");
    await ui.closeToasts();
    await app.invoke("settings_set", { patch: { externalEditor: null, externalTerminal: null } });
  });

  await stop();
} catch (error) {
  checks.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  await app?.close().catch(() => undefined);
  for (const repo of repos) repo.cleanup();
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
if (notes.length) console.log(`\nNotes:\n${notes.map((line) => `- ${line}`).join("\n")}`);
process.exit(finish());
