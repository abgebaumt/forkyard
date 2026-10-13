/**
 * Status cache and small fixes – in the real app, against real repositories.
 *
 *   node scripts/e2e/screens/mustfix-status.mjs [--show] [--no-shots] [--only <part>]
 *
 * Sections:
 * - Success toast and toolbar agree: the moment "Pull complete" appears, the status has already
 *   been reloaded (no running operation, nothing behind).
 * - A late response does not overwrite anything newer: the response of "stage" is held back,
 *   meanwhile the repository changes from outside and the status reloads – afterwards the old
 *   response must not replace the newer state.
 * - Double-click in the graph during a running checkout: a quiet toast instead of nothing.
 * - Fast-forward in the second stage of the command palette (keyboard only), verified with git.
 * - Closing a tab with a shell that was used: confirmation; without input: none.
 * - A three-digit counter on Pull/Push does not cover the icon.
 */
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeRichRepo } from "../fixtures.mjs";
import { createRun, sleep } from "./mustfix-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("mustfix-status", { argv });
const { check, equal, eventually, section, shot, waitToast } = t;

const fixtures = [];
const made = (repo) => (fixtures.push(repo), repo);
let app = null;
let page = null;

async function start(options = {}) {
  app = await launchApp({ show, ...options });
  page = app.page;
  t.attach(app);
}
async function stop() {
  if (!app) return;
  await app.close().catch(() => undefined);
  app = null;
  page = null;
  t.attach(null);
}

const press = (keys) => page.keyboard.press(keys);
const blur = () => page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
const cachedStatus = (repoId) => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"]) ?? null, repoId);
const tabsOf = () => page.evaluate(() => (window.__gc.queryClient.getQueryData(["app", "tabs"]) ?? []).map((tab) => ({ id: tab.id, active: tab.isActive, kind: tab.kind })));
const activeTabId = async () => (await tabsOf()).find((tab) => tab.active)?.id ?? null;
const PALETTE = '[data-screen="command-palette"]';

try {
  // ===========================================================================================
  await section("Success toast and toolbar agree: pull with rebase", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "gleichstand" }));
    await start();
    const { repoId, tabId } = await app.openRepo(repo.path);

    // Records what the status cache and the Pull button show the moment a toast appears.
    await page.evaluate((id) => {
      window.__seen = [];
      const record = (node) => {
        if (!(node instanceof HTMLElement)) return;
        const toast = node.matches("[data-toast]") ? node : node.querySelector("[data-toast]");
        if (!toast) return;
        const status = window.__gc.queryClient.getQueryData(["repo", id, "status"]);
        const pull = [...document.querySelectorAll('[role="toolbar"][aria-label="Repository actions"] button')].find((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim().startsWith("Pull"));
        window.__seen.push({
          text: (toast.textContent ?? "").replace(/\s+/g, " ").trim(),
          operation: status?.operation?.kind ?? null,
          head: status?.head?.kind ?? null,
          ahead: status?.upstream?.ahead ?? null,
          behind: status?.upstream?.behind ?? null,
          pullDisabled: pull?.getAttribute("aria-disabled") === "true",
          pullBusy: pull?.getAttribute("aria-busy") === "true",
        });
      };
      new MutationObserver((changes) => changes.forEach((change) => change.addedNodes.forEach(record))).observe(document.body, { childList: true, subtree: true });
    }, repoId);

    for (let round = 1; round <= 4; round++) {
      repo.write(`notizen/lokal-${round}.md`, `Lokale Notiz ${round}\n`);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", `Lokale Notiz ${round}`);
      const remoteSha = repo.commitOnRemote({ message: `Nachtrag ${round} vom Remote`, file: `docs/remote-${round}.md` });
      await t.refresh(repoId);
      await page.evaluate(() => (window.__seen.length = 0));
      await page.evaluate(([id, tab]) => void window.__gcUi.actions.sync.pull(id, "rebase", tab), [repoId, tabId]);
      await waitToast(/Pull complete/, "success", 60_000);
      const seen = (await page.evaluate(() => window.__seen)).find((entry) => /Pull complete/.test(entry.text));
      equal(
        seen ? { operation: seen.operation, head: seen.head, ahead: seen.ahead, behind: seen.behind } : null,
        { operation: null, head: "branch", ahead: round, behind: 0 },
        `Round ${round}: when the toast appeared, the status already showed the state afterwards (no running rebase, nothing behind)`,
      );
      equal(repo.git("rev-parse", `HEAD~${round}`), remoteSha, `Round ${round}: git – the local commits sit on top of the remote state`);
      await eventually(async () => (await t.toolState("Pull")).disabled, false, `Round ${round}: Pull is available again right away`, 3000);
      await t.closeToasts();
    }
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("A late response does not overwrite a newer state", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "spaete-antwort" }));
    if (!app) await start();
    repo.write("a.txt", "erste Datei\n");
    repo.write("b.txt", "zweite Datei\n");
    const { repoId } = await app.openRepo(repo.path);
    await eventually(async () => (await cachedStatus(repoId))?.unstaged.length ?? -1, 2, "two untracked files are listed");

    // The RESPONSE of stagePaths is held back (the core has staged long before) – and the cache history is recorded.
    await page.evaluate((id) => {
      const core = window.__gc.core;
      delete core.stagePaths;
      const original = core.stagePaths;
      window.__late = { release: null, done: false };
      core.stagePaths = async (input) => {
        const value = await original(input);
        await new Promise((resolve) => (window.__late.release = resolve));
        window.__late.done = true;
        return value;
      };
      window.__history = [];
      window.__gc.queryClient.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey;
        if (event.type !== "updated" || event.action.type !== "success" || key[0] !== "repo" || key[1] !== id || key[2] !== "status") return;
        window.__history.push((event.query.state.data?.staged ?? []).map((file) => file.path).sort().join(","));
      });
    }, repoId);

    void page.evaluate((id) => void window.__gcUi.actions.files.stagePaths(id, ["a.txt"]), repoId);
    await eventually(() => page.evaluate(() => typeof window.__late.release === "function"), true, "the response of \"stage\" is on its way and held back");
    equal(repo.git("diff", "--cached", "--name-only"), "a.txt", "git: the core has already staged a.txt");
    // From outside (as in a terminal) b.txt is added; the window gets focus and reloads the status.
    repo.git("add", "b.txt");
    await page.evaluate(() => void window.dispatchEvent(new Event("focus")));
    await eventually(async () => ((await cachedStatus(repoId))?.staged ?? []).map((file) => file.path).sort(), ["a.txt", "b.txt"], "the reloaded status shows both files staged");

    await page.evaluate(() => (window.__history.length = 0));
    await page.evaluate(() => window.__late.release());
    await eventually(() => page.evaluate(() => window.__late.done), true, "the late response has arrived");
    await sleep(1200);
    const history = await page.evaluate(() => window.__history);
    check(!history.includes("a.txt"), `after the late response the old state (only a.txt) never returned to the cache – history: ${JSON.stringify(history)}`);
    equal(((await cachedStatus(repoId))?.staged ?? []).map((file) => file.path).sort(), ["a.txt", "b.txt"], "in the end the newer state holds");
    await page.evaluate(() => void delete window.__gc.core.stagePaths);
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("Double-click in the graph during a running checkout: quiet toast", async () => {
    const repo = made(makeRichRepo({ dirty: false, name: "doppelklick" }));
    if (!app) await start();
    const { repoId } = await app.openRepo(repo.path);
    const commitGraphScreen = '[data-screen="commit-graph"]';
    const first = "feature/wind-diagramm";
    const second = "feature/luftdruck";
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/${first}"]`).first().waitFor();

    // The first checkout is held back in the window so the second double-click surely lands during it.
    await page.evaluate(() => {
      const core = window.__gc.core;
      delete core.branchCheckout;
      const original = core.branchCheckout;
      window.__gate = {};
      const gate = new Promise((resolve) => (window.__gate.release = resolve));
      core.branchCheckout = async (input) => {
        await gate;
        return original(input);
      };
    });
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/${first}"]`).first().dblclick();
    await eventually(() => page.evaluate((id) => Boolean(window.__gc.store.getState().busy[`${id}:history`]), repoId), true, "the first checkout is running");
    equal(await t.toasts(), [], "no toast yet");

    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/${second}"]`).first().dblclick();
    const quiet = await waitToast(/was not checked out/, "info", 5000);
    check(quiet?.text.includes(`“${second}” was not checked out`) && quiet.text.includes(`The checkout of “${first}” is still running`), `the toast names both branches: ${quiet?.text}`);
    await shot("mustfix-status-doppelklick");

    // The same branch again: what was wanted is happening anyway – no second toast.
    await t.closeToasts();
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/${first}"]`).first().dblclick();
    await sleep(400);
    equal((await t.toasts()).filter((toast) => /not checked out/.test(toast.text)), [], "the same target again: no toast");

    await page.evaluate(() => window.__gate.release());
    await waitToast(new RegExp(`“${first}” checked out`), "success", 30_000);
    equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), first, "git: the first checkout won");
    await page.evaluate(() => void delete window.__gc.core.branchCheckout);
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("Command palette, second stage: fast-forward – keyboard only", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "palette-ff" }));
    if (!app) await start();
    // feature/export: the remote is one commit ahead; main stays checked out.
    const remoteSha = repo.commitOnRemote({ branch: "feature/export", message: "Export: Kopfzeile ergänzt", file: "docs/export.md" });
    repo.git("fetch", "-q", "origin");
    const before = { head: repo.git("rev-parse", "HEAD"), branch: repo.git("rev-parse", "--abbrev-ref", "HEAD"), feature: repo.git("rev-parse", "feature/export") };
    check(before.feature !== remoteSha, "initial state: feature/export is behind origin/feature/export");
    const { repoId } = await app.openRepo(repo.path);
    await t.refresh(repoId);

    const palette = page.locator(PALETTE);
    const option = (key) => palette.locator(`[role="option"][data-key="${key}"]`);
    const activeKey = () =>
      page.evaluate((css) => {
        const id = document.querySelector(`${css} input[role="combobox"]`)?.getAttribute("aria-activedescendant");
        return id ? (document.getElementById(id)?.dataset.key ?? null) : null;
      }, PALETTE);
    const openStage = async (branch) => {
      await blur();
      await press("Control+p");
      await palette.locator('input[role="combobox"]').waitFor();
      await page.keyboard.type(branch, { delay: 5 });
      await eventually(async () => (await palette.locator('[role="option"]').first().getAttribute("data-key")) ?? null, `ref:refs/heads/${branch}`, `"${branch}" is on top`);
      await press("Tab");
      await palette.locator("[data-stage]").waitFor();
    };
    const pick = async (key) => {
      for (let step = 0; step < 12 && (await activeKey()) !== key; step++) await press("ArrowDown");
      equal(await activeKey(), key, "the action is reached with the arrow keys");
    };

    await openStage("feature/export");
    const ffKey = "action:refs/heads/feature/export:ff";
    const row = option(ffKey);
    await row.waitFor();
    const text = (await row.innerText()).replace(/\s+/g, " ");
    check(text.includes("Fast-forward to “origin/feature/export”") && text.includes("1 commit") && text.includes("without checkout"), `the row says what happens: ${text}`);
    await shot("mustfix-status-palette-ff");
    await pick(ffKey);
    await press("Enter");
    const done = await waitToast(/Fast-forward complete/, "success", 30_000);
    check(/whatever was checked out stays checked out/.test(done?.text ?? ""), `the toast says that nothing was checked out: ${done?.text}`);
    equal(repo.git("rev-parse", "feature/export"), remoteSha, "git: feature/export now points at origin/feature/export");
    equal({ head: repo.git("rev-parse", "HEAD"), branch: repo.git("rev-parse", "--abbrev-ref", "HEAD") }, { head: before.head, branch: before.branch }, "git: HEAD and the checked-out branch are unchanged");
    equal(repo.git("status", "--porcelain"), "", "git: the working tree is untouched");
    await t.closeToasts();

    // Now level: the row is disabled and names the reason.
    await t.refresh(repoId);
    await openStage("feature/export");
    await option(ffKey).waitFor();
    check((await option(ffKey).innerText()).includes("already up to date with the upstream"), "level: the reason is in the row");
    equal(await option(ffKey).getAttribute("aria-disabled"), "true", "and the row is disabled");
    await press("Escape");
    await press("Escape");
    await eventually(() => palette.count(), 0, "Esc closes the palette");

    // Own commits in the way: disabled with a reason.
    repo.git("checkout", "-q", "feature/export");
    repo.write("notiz.md", "eigener Commit\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Eigener Commit auf feature/export");
    repo.git("checkout", "-q", "main");
    repo.commitOnRemote({ branch: "feature/export", message: "Export: Fußzeile", file: "docs/export-fuss.md" });
    repo.git("fetch", "-q", "origin");
    await t.refresh(repoId);
    await openStage("feature/export");
    await option(ffKey).waitFor();
    check((await option(ffKey).innerText()).includes("1 own commit in the way"), `own commits: the reason is in the row: ${await option(ffKey).innerText()}`);
    await press("Escape");
    await press("Escape");
    await eventually(() => palette.count(), 0, "Esc closes the palette");
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("Close tab: confirmation only if the shell was used", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "tab-mit-shell" }));
    const other = made(makeCleanRepoWithRemote({ name: "tab-daneben" }));
    if (!app) await start();
    await app.openRepo(other.path);
    const { tabId } = await app.openRepo(repo.path);
    const kind = () => page.evaluate((id) => window.__gcTerminal?.status(id)?.kind ?? null, tabId);
    const buffer = () => page.evaluate((id) => window.__gcTerminal?.text(id) ?? "", tabId);
    const question = page.getByRole("dialog", { name: /and end the terminal\?/ });

    // 1. Shell started, nothing typed: the tab closes without confirmation.
    await blur();
    await press("Control+Backquote");
    await eventually(kind, "running", "the shell is running", 60_000);
    await eventually(async () => (await buffer()).trim().length > 0, true, "the prompt is shown", 60_000);
    equal(await page.evaluate((id) => window.__gc.store.getState().views[id]?.terminalOpen ?? false, tabId), true, "the terminal is shown");
    await press("F6");
    await press("Control+w");
    await eventually(async () => (await tabsOf()).some((tab) => tab.id === tabId), false, "without input: Ctrl+W closes the tab right away");
    equal(await question.count(), 0, "no confirmation");

    // 2. The shell was used: confirmation, Esc cancels, confirming closes.
    const again = await app.openRepo(repo.path);
    const kind2 = () => page.evaluate((id) => window.__gcTerminal?.status(id)?.kind ?? null, again.tabId);
    const buffer2 = () => page.evaluate((id) => window.__gcTerminal?.text(id) ?? "", again.tabId);
    await blur();
    await press("Control+Backquote");
    await eventually(kind2, "running", "the new shell is running", 60_000);
    await eventually(async () => (await buffer2()).trim().length > 0, true, "its prompt is shown", 60_000);
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="terminal"] .xterm'))), true, "focus is in the terminal");
    await page.keyboard.type('echo ("HAL" + "LO-" + (20+22))');
    await press("Enter");
    await eventually(async () => /HALLO-42/.test(await buffer2()), true, "the shell has answered", 60_000);
    await press("F6");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="terminal"] .xterm'))), false, "F6 leaves the terminal");
    await press("Control+w");
    await question.waitFor({ timeout: 10_000 });
    const title = await t.dialogTitle();
    check(/Close tab “tab-mit-shell” and end the terminal\?/.test(title ?? ""), `the confirmation names the tab: ${title}`);
    equal((await t.focused()).text, "Cancel", "focus is on \"Cancel\"");
    await shot("mustfix-status-tab-terminal");
    await press("Escape");
    await question.waitFor({ state: "detached" });
    await sleep(300);
    check((await tabsOf()).some((tab) => tab.id === again.tabId), "Esc: the tab stays");
    equal(await kind2(), "running", "and the shell keeps running");

    // Through the tab's × button: the same confirmation.
    await page.locator(`[data-tab-id="${again.tabId}"] button[aria-label*="Close"]`).first().click();
    await question.waitFor({ timeout: 10_000 });
    await press("Tab");
    equal((await t.focused()).text, "Close tab", "Tab leads to \"Close tab\"");
    await press("Enter");
    await eventually(async () => (await tabsOf()).some((tab) => tab.id === again.tabId), false, "confirmed: the tab is closed");
    await eventually(() => page.evaluate(() => (window.__gcTerminal?.openIds() ?? []).length), 0, "no terminal is open in the core any more", 15_000);
    check((await activeTabId()) !== null, "another tab is in front");
    equal(app.consoleErrors, [], "console errors");
  });

  // ===========================================================================================
  await section("A three-digit counter on Push does not cover the icon", async () => {
    const repo = made(makeCleanRepoWithRemote({ name: "viele-commits" }));
    if (!app) await start();
    for (let index = 1; index <= 123; index++) repo.git("commit", "-q", "--allow-empty", "-m", `Leerer Commit ${index}`);
    const { repoId } = await app.openRepo(repo.path);
    await t.refresh(repoId);
    await eventually(async () => (await cachedStatus(repoId))?.upstream?.ahead ?? -1, 123, "123 commits ahead");
    const measure = () =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll('[role="toolbar"][aria-label="Repository actions"] button')].find((item) => (item.getAttribute("aria-label") ?? "").startsWith("Push"));
        const icon = button?.querySelector("svg");
        const badge = button?.querySelector("span.rounded-pill");
        if (!button || !icon || !badge) return null;
        const i = icon.getBoundingClientRect();
        const b = badge.getBoundingClientRect();
        const covered = Math.max(0, Math.min(i.right, b.right) - Math.max(i.left, b.left)) * Math.max(0, Math.min(i.bottom, b.bottom) - Math.max(i.top, b.top));
        return { text: badge.textContent, label: button.getAttribute("aria-label"), coveredShare: Math.round((covered / (i.width * i.height)) * 100) / 100, badgeLeftInIcon: Math.round(b.left - i.left), badgeWidth: Math.round(b.width), page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
    const wide = await measure();
    equal(wide?.text, "123", "the pill shows the number");
    check(/123 commits/.test(wide?.label ?? ""), `the button also names the number for screen readers: ${wide?.label}`);
    check((wide?.coveredShare ?? 1) <= 0.2, `the pill covers at most a fifth of the icon: ${JSON.stringify(wide)}`);
    equal(wide?.page, 0, "nothing overflows horizontally");
    await shot("mustfix-status-zaehler-dreistellig");

    await app.setSize(960, 600);
    await app.settle();
    const narrow = await measure();
    check((narrow?.coveredShare ?? 1) <= 0.2 && narrow?.page === 0, `also at 960×600: ${JSON.stringify(narrow)}`);
    await shot("mustfix-status-zaehler-dreistellig-min");
    await app.setSize(1440, 900);
    equal(app.consoleErrors, [], "console errors");
  });
} finally {
  await stop();
  for (const repo of fixtures) repo.cleanup?.();
}
t.finish();
