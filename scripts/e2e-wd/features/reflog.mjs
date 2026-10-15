/**
 * Reflog view in the real app (1.1): opened from the command palette and from a branch's menu,
 * the HEAD/branch filter, details of the selected entry, the entry menu (create branch here,
 * check out detached, reset the current branch with undo, copy SHA), entries whose commit is gone,
 * the empty state, paging through a long reflog, redacted messages, keyboard use and live updates.
 * Every result is checked in the UI and with git in the temp repository.
 *
 *   node scripts/e2e-wd/features/reflog.mjs
 *   E2E_WD_ONLY="keyboard" node scripts/e2e-wd/features/reflog.mjs
 */
import { dropObject, makeEmptyReflogRepo, makeReflogRepo, writeLongReflog } from "../fixtures/reflog.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (sha) => sha.slice(0, 7);

/** Actions of the standard fixture's HEAD reflog, newest first. */
const STORY_ACTIONS = ["reset", "commit", "checkout", "commit", "checkout", "amend", "commit", "commit", "commit"];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const pointerActions = (actions) => ({ actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });

async function perform(app, body) {
  await app.webdriver("POST", "/actions", body);
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** Centre point of the element (CSS selector), scrolled into view. */
function pointOf(app, css) {
  return app.waitFor(
    () =>
      app.exec((selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        el.scrollIntoView({ block: "nearest" });
        const box = el.getBoundingClientRect();
        if (box.width === 0) return null;
        return { x: Math.round(box.left + Math.min(120, box.width / 2)), y: Math.round(box.top + box.height / 2) };
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

/** Menu items of the open menus: [{ text, disabled, title }]. */
function menuItems(app) {
  return app.exec(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => ({
      text: item.innerText.replace(/\s+/g, " ").trim(),
      title: item.getAttribute("title") ?? "",
      disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
    })),
  );
}

/** Clicks the enabled menu item whose text matches. */
async function chooseMenu(app, pattern) {
  const items = await menuItems(app);
  const index = items.findIndex((item) => pattern.test(item.text));
  assert(index >= 0, `menu item ${pattern} missing; menu: ${items.map((item) => item.text).join(" | ")}`);
  assert(!items[index].disabled, `menu item ${pattern} is disabled: ${items[index].text}`);
  const elements = await app.$$('[role="menu"] [role^="menuitem"]');
  await elements[index].click();
}

const noMenu = (app) => app.waitFor(async () => (await app.$$('[role="menu"]')).length === 0, 5000, { message: "menu closed" });

/** The open dialog: { title, text, buttons[] }. */
function dialogInfo(app) {
  return app.exec(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
    if (!dialog) return null;
    return {
      title: dialog.querySelector("h2")?.innerText.trim() ?? "",
      text: dialog.innerText.replace(/\s+/g, " ").trim(),
      buttons: [...dialog.querySelectorAll("footer button, button[data-action]")].map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })),
    };
  });
}
const waitDialog = (app, titlePattern) =>
  app.waitFor(
    async () => {
      const info = await dialogInfo(app);
      return info && titlePattern.test(info.title) ? info : null;
    },
    10_000,
    { message: `dialog ${titlePattern}` },
  );
const noDialog = (app) => app.waitFor(async () => (await app.$$('[role="dialog"], [role="alertdialog"]')).length === 0, 8000, { message: "dialog closed" });

async function dialogButton(app, pattern) {
  const button = await app.waitFor(
    () =>
      app.exec((source) => {
        const wanted = new RegExp(source);
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
        return [...(dialog?.querySelectorAll("footer button") ?? [])].find((el) => wanted.test(el.innerText.trim()) && !el.disabled) ?? null;
      }, pattern.source),
    8000,
    { message: `dialog button ${pattern}` },
  );
  await button.click();
}

const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.getAttribute("data-toast"), text: el.innerText.replace(/\s+/g, " ").trim() })));
const waitToast = (app, tone, pattern, timeout = 15_000) =>
  app.waitFor(async () => (await toasts(app)).find((toast) => toast.tone === tone && pattern.test(toast.text)) ?? null, timeout, { message: `${tone} toast ${pattern}` });
async function noDangerToasts(app) {
  assertEqual((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error message");
}
async function closeToasts(app) {
  await app.exec(() => {
    for (const el of document.querySelectorAll("[data-toast] button[aria-label]")) if (/close|dismiss/i.test(el.getAttribute("aria-label"))) el.click();
  });
  await app.waitFor(() => app.exec(() => document.querySelectorAll("[data-toast]").length === 0), 5000, { message: "toasts closed" }).catch(() => undefined);
}

/** Polls a git check until it returns the expected value. */
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

/** Runs a command through the palette (Ctrl+P, ">text", click on the entry with that id). */
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

/** Rendered reflog rows: [{ index, sha, action, exists, selected, message, meta }]. */
const rows = (app) =>
  app.exec(() =>
    [...document.querySelectorAll('[data-reflog-list] [role="option"]')]
      .map((row) => {
        const [first, second] = row.children;
        return {
          index: Number(row.dataset.index),
          sha: row.dataset.sha,
          action: row.dataset.reflogAction,
          exists: row.dataset.exists === "true",
          selected: row.getAttribute("aria-selected") === "true",
          message: first?.children[1]?.textContent.trim() ?? "",
          label: first?.children[0]?.textContent.trim() ?? "",
          meta: second?.innerText.replace(/\s+/g, " ").trim() ?? "",
        };
      })
      .sort((a, b) => a.index - b.index),
  );

/** Waits until the reflog list shows `count` rows (or matches `check(rows)`). */
async function waitRows(app, check, message = "reflog rows") {
  let last = [];
  try {
    return await app.waitFor(async () => {
      last = await rows(app);
      return (typeof check === "number" ? last.length === check : check(last)) ? last : null;
    }, 20_000, { message });
  } catch (error) {
    throw new Error(`${error.message}; rows: ${JSON.stringify(last.map((row) => `${row.index}:${row.action}:${row.message}`))}`);
  }
}

const rowCss = (index) => `[data-reflog-list] [role="option"][data-index="${index}"]`;
const center = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.center ?? null, tabId);
/** SHAs of the commit selection, or the selection kind when it is no commit selection. */
const selection = (app, tabId) =>
  app.exec((id) => {
    const value = window.__gc.store.getState().views[id]?.selection ?? null;
    return value?.kind === "commits" ? value.shas : value?.kind ?? null;
  }, tabId);
const filterTrigger = (app) => app.waitFor('[data-screen="reflog"] button[aria-label="Show the reflog of"]', 10_000);
const filterText = async (app) => (await app.exec((el) => el.innerText.trim(), await filterTrigger(app)));

/** Options of the open filter list (not the reflog rows, which are options too). */
const filterOption = (app, label) =>
  app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[data-radix-select-viewport] [role="option"]')].find((el) => !el.closest("[data-reflog-list]") && el.innerText.trim() === wanted) ?? null, label), 5000, { message: `filter option ${label}` });
const filterOpen = (app) => app.exec(() => [...document.querySelectorAll('[data-radix-select-viewport] [role="option"]')].some((el) => !el.closest("[data-reflog-list]")));

/**
 * Picks a ref in the filter select. Mouse: click the trigger and the option. Keyboard: focus the
 * trigger, Enter opens, arrows move to the option, Enter picks it. (After a right-click through W3C
 * actions, WebKitWebDriver stops sending pointer events, which Radix Select needs – scenarios that
 * right-click first use the keyboard.)
 */
async function chooseFilter(app, label, { keyboard = false } = {}) {
  const trigger = await filterTrigger(app);
  if (keyboard) {
    await app.exec((el) => el.focus(), trigger);
    await app.press("Enter");
    await filterOption(app, label);
    const active = () => app.exec(() => document.activeElement?.innerText.trim() ?? "");
    const labels = await app.exec(() => [...document.querySelectorAll('[data-radix-select-viewport] [role="option"]')].filter((el) => !el.closest("[data-reflog-list]")).map((el) => el.innerText.trim()));
    for (let step = 0; step < labels.length && (await active()) !== label; step += 1) {
      await app.press(labels.indexOf(label) < labels.indexOf(await active()) ? "ArrowUp" : "ArrowDown");
      await sleep(80);
    }
    assertEqual(await active(), label, "keyboard reached the option");
    await app.press("Enter");
  } else {
    await app.click(trigger);
    await filterOption(app, label);
    // Radix ignores a release right after opening (it would select the item under the pointer).
    await sleep(300);
    await app.click(await filterOption(app, label));
  }
  await app.waitFor(async () => !(await filterOpen(app)), 5000, { message: "filter closed" });
  await app.waitFor(async () => (await filterText(app)) === label, 5000, { message: `filter shows ${label}` });
}

/** Waits until the commit details panel shows the commit with this subject. */
const detailsShow = (app, subject) =>
  app.waitFor(() => app.exec((text) => document.querySelector('[data-screen="commit-details"]')?.innerText.includes(text) ?? false, subject), 15_000, { message: `details show “${subject}”` });

async function start(t, repo, options = {}) {
  const app = await t.launch({ ...LAUNCH, ...options });
  const ids = await app.openRepo(repo.path);
  await app.waitFor(`[data-row-id="${repo.head()}"]`, 20_000, { message: "HEAD commit row" });
  return { app, ...ids };
}

/** Opens the HEAD reflog through the command palette and waits for the list. */
async function openFromPalette(app, tabId) {
  await runCommand(app, "Show reflog", "history.reflog");
  await app.waitFor('[data-screen="reflog"]', 10_000);
  assertEqual(await center(app, tabId), { kind: "reflog", ref: null }, "centre shows the HEAD reflog");
}

// ---------------------------------------------------------------------------------------------
// Main flows
// ---------------------------------------------------------------------------------------------

scenario("palette opens the HEAD reflog; a lost commit is recovered as a new branch", "main", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    assertEqual(await filterText(app), "HEAD", "filter shows HEAD");
    const list = await waitRows(app, STORY_ACTIONS.length);
    t.step("HEAD reflog with 9 entries, newest first");
    assertEqual(list.map((row) => row.action), STORY_ACTIONS, "actions as Git recorded them");
    assertEqual(list.map((row) => row.label), ["Reset", "Commit", "Checkout", "Commit", "Checkout", "Amend", "Commit", "Commit", "Commit"], "action labels");
    assertEqual(list.map((row) => row.sha), repo.reflog().map((entry) => entry.sha), "SHAs match git reflog");
    assertEqual(list[1].message, "commit: Verworfener Versuch", "message of the lost commit");
    assertIncludes(list[1].meta, short(repo.shas.lost), "short SHA in the second line");
    assertIncludes(list[1].meta, "HEAD@{1}", "selector in the second line");
    assert(list.every((row) => row.exists), "all commits still exist");
    assert(list[0].selected, "the newest entry is selected first");

    // Selecting the lost commit shows it in the details panel.
    await app.click(rowCss(1));
    await app.waitFor(async () => (await rows(app))[1]?.selected, 5000, { message: "row 1 selected" });
    assertEqual(await selection(app, tabId), [repo.shas.lost], "selection is the lost commit");
    await detailsShow(app, "Verworfener Versuch");
    await app.settle();

    await contextMenu(app, rowCss(1));
    const items = await menuItems(app);
    assertMatch(items[0]?.text ?? "", /^Create branch here/, "first menu entry");
    assert(items.some((item) => /^Check out commit/.test(item.text)), "check out entry");
    assert(items.some((item) => /^Reset .main. to here/.test(item.text)), "reset entry names the current branch");
    assert(items.some((item) => /^Copy SHA/.test(item.text)), "copy entry");
    assert(items.every((item) => !item.disabled), `nothing is disabled: ${JSON.stringify(items)}`);
    await chooseMenu(app, /^Create branch here/);
    const info = await waitDialog(app, /^New branch$/);
    assertIncludes(info.text, short(repo.shas.lost), "dialog names the start commit");
    const input = await app.waitFor('[role="dialog"] input');
    await app.type(input, "rettung/versuch");
    await app.waitFor(async () => !(await dialogInfo(app)).buttons.find((b) => b.text === "Create branch")?.disabled, 5000, { message: "Create branch enabled" });
    await t.shot("recover-lost-commit-dialog");
    await app.press("Enter");
    await noDialog(app);
    await eventually(() => repo.branch(), "rettung/versuch", "new branch is checked out (git)");
    assertEqual(repo.sha("rettung/versuch"), repo.shas.lost, "branch points at the lost commit");
    assertEqual(repo.read("versuch.txt"), "Ein Versuch, der verworfen wird.\n", "the lost file is back in the working tree");
    await waitToast(app, "success", /rettung\/versuch/);
    // The reflog follows: HEAD@{0} is now the checkout to the new branch.
    const after = await waitRows(app, (now) => now.length === STORY_ACTIONS.length + 1 && now[0].action === "checkout");
    assertMatch(after[0].message, /to rettung\/versuch/, "newest entry is the checkout");
    assertEqual(after[0].sha, repo.shas.lost, "and points at the recovered commit");
    await t.shot("recover-lost-commit");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("branch menu opens that branch's reflog; the filter switches to HEAD and to another branch", "main", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await app.waitFor('[data-row-id="refs/heads/feature/wind"]', 10_000, { message: "feature/wind in the sidebar" });
    await contextMenu(app, '[data-row-id="refs/heads/feature/wind"]');
    await chooseMenu(app, /^Show reflog$/);
    await noMenu(app);
    await app.waitFor('[data-screen="reflog"]', 10_000);
    assertEqual(await center(app, tabId), { kind: "reflog", ref: "refs/heads/feature/wind" }, "centre shows the branch reflog");
    const list = await waitRows(app, 2, "two branch entries");
    assertEqual(list.map((row) => row.message), ["commit: Wind erfassen", "branch: Created from HEAD"], "branch reflog as in git");
    assertEqual(list.map((row) => row.action), ["commit", "other"], "branch creation counts as other");
    assertEqual(list.map((row) => row.label), ["Commit", "Other"], "labels");
    assertIncludes(list[0].meta, "feature/wind@{0}", "selector names the branch");
    assertEqual(await filterText(app), "feature/wind", "filter shows the branch");
    await t.shot("branch-reflog");

    // Filter: HEAD (keyboard, see chooseFilter).
    await app.exec((el) => el.focus(), await filterTrigger(app));
    await app.press("Enter");
    const options = await app.waitFor(
      () => app.exec(() => {
        const found = [...document.querySelectorAll('[data-radix-select-viewport] [role="option"]')].filter((el) => !el.closest("[data-reflog-list]"));
        return found.length ? found.map((el) => el.innerText.trim()) : null;
      }),
      5000,
      { message: "filter options" },
    );
    assertEqual(options, ["HEAD", "feature/wind", "main"], "HEAD first, then the local branches");
    await app.press("Escape");
    await app.waitFor(async () => !(await filterOpen(app)), 5000, { message: "filter closed with Esc" });
    assertEqual((await center(app, tabId))?.ref, "refs/heads/feature/wind", "Esc in the filter keeps the branch (and the view)");
    await chooseFilter(app, "HEAD", { keyboard: true });
    await waitRows(app, STORY_ACTIONS.length, "HEAD reflog after switching");
    assertEqual(await center(app, tabId), { kind: "reflog", ref: null }, "filter switched to HEAD");

    // Filter: main.
    await chooseFilter(app, "main", { keyboard: true });
    const main = await waitRows(app, (now) => now.length === repo.reflog("refs/heads/main").length && now[0]?.message.startsWith("reset"), "main reflog");
    assertEqual(main.map((row) => row.sha), repo.reflog("refs/heads/main").map((entry) => entry.sha), "main reflog matches git");
    assertIncludes(main[0].meta, "main@{0}", "selector names main");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("check out a reflog entry detached; checking out the same commit again is blocked", "main", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    // HEAD@{6}: "Werte gerundet" before the amend – no branch reaches it any more.
    await contextMenu(app, rowCss(6));
    await chooseMenu(app, /^Check out commit/);
    await noMenu(app);
    await eventually(() => repo.branch(), "HEAD", "HEAD is detached (git)");
    assertEqual(repo.head(), repo.shas.c3, "at the commit from before the amend");
    assertEqual(repo.read("werte.txt"), "Zeile 1: 1013 hPa\nZeile 2: 1011 hPa\nZeile 3: 1010 hPa\n", "working tree has the old content");
    await waitToast(app, "info", new RegExp(short(repo.shas.c3)));
    const after = await waitRows(app, (now) => now.length === STORY_ACTIONS.length + 1);
    assertEqual(after[0].action, "checkout", "the checkout is recorded at the top");
    assertEqual(after[0].sha, repo.shas.c3, "pointing at the old commit");
    await t.shot("checkout-detached");

    // The same commit (now HEAD@{0} and HEAD@{7}) cannot be checked out again.
    await closeToasts(app);
    await contextMenu(app, rowCss(0));
    const checkout = (await menuItems(app)).find((item) => /^Check out commit/.test(item.text));
    assert(checkout?.disabled, `check out is disabled: ${JSON.stringify(checkout)}`);
    await app.press("Escape");
    await noMenu(app);
    assertEqual(repo.head(), repo.shas.c3, "nothing changed");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("hard reset of the current branch to a reflog entry asks first; undo restores it", "main", async (t) => {
  const repo = makeReflogRepo();
  try {
    repo.write("notiz.txt", "ungespeichert\n");
    repo.git("add", "notiz.txt");
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    // HEAD@{6}: the commit replaced by the amend.
    await contextMenu(app, rowCss(6));
    await chooseMenu(app, /^Reset .main. to here/);
    await app.waitFor(async () => (await app.$$('[role="menu"]')).length >= 2, 5000, { message: "reset submenu" });
    const modes = (await menuItems(app)).map((item) => item.text);
    assert(modes.some((text) => /^Soft/.test(text)) && modes.some((text) => /^Mixed/.test(text)) && modes.some((text) => /^Hard/.test(text)), `modes: ${modes.join(" | ")}`);
    await chooseMenu(app, /^Hard/);
    const info = await waitDialog(app, /^Hard reset .main. to /);
    assertIncludes(info.title, short(repo.shas.c3), "title names the target");
    assertMatch(info.text, /1 file are discarded|1 file is discarded|to 1 file/, "names the uncommitted change");
    assertIncludes(info.text, "notiz.txt", "lists the file");
    assertMatch(info.text, /Undo/, "mentions undo");
    await t.shot("reset-from-reflog-confirm");
    await dialogButton(app, /reset/i);
    await noDialog(app);
    await eventually(() => repo.head(), repo.shas.c3, "main is at the old commit (git)");
    assertEqual(repo.branch(), "main", "still on main");
    assertEqual(repo.status(), "", "the staged change is gone");
    assert(repo.undoRefs().length > 0, `undo backup ref exists: ${repo.undoRefs()}`);
    await waitToast(app, "success", /is now at/);
    const after = await waitRows(app, (now) => now.length === STORY_ACTIONS.length + 1 && now[0].action === "reset");
    assertEqual(after[0].sha, repo.shas.c3, "the reset is recorded");
    await t.shot("reset-from-reflog-done");

    await app.exec(() => document.activeElement?.blur());
    await app.press("Control+z");
    await eventually(() => repo.head(), repo.shas.c3a, "undo restores main (git)");
    await eventually(() => repo.git("diff", "--cached", "--name-only"), "notiz.txt", "undo restores the staged change");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("copy SHA from the reflog menu", "main", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    await contextMenu(app, rowCss(3));
    const copy = (await menuItems(app)).find((item) => /^Copy SHA/.test(item.text));
    assertIncludes(copy.text, short(repo.shas.f1), "hint shows the short SHA");
    await chooseMenu(app, /^Copy SHA/);
    await noMenu(app);
    const toast = await waitToast(app, "success", /SHA copied/i);
    assertIncludes(toast.text, repo.shas.f1, "the full SHA was copied");
    const clip = await app.exec(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });
    if (clip !== null) assertEqual(clip, repo.shas.f1, "clipboard holds the full SHA");
    t.step(`clipboard readable: ${clip !== null}`);
    await t.shot("copy-sha");
    assertEqual(repo.head(), repo.shas.c3a, "nothing changed in git");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------------------------

scenario("entries whose commit is gone stay visible, but only offer copying the SHA", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    dropObject(repo, repo.shas.lost);
    assert(!repo.git("cat-file", "--batch-check", "--batch-all-objects").includes(repo.shas.lost), "object removed from git");
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    const list = await waitRows(app, STORY_ACTIONS.length);
    assertEqual(list.map((row) => row.exists), [true, false, true, true, true, true, true, true, true], "only HEAD@{1} is gone");
    assertIncludes(list[1].meta, "commit no longer exists", "row says the commit is gone");
    const disabled = await app.exec(() => document.querySelector('[data-reflog-list] [data-index="1"]')?.getAttribute("aria-disabled"));
    assertEqual(disabled, "true", "row is aria-disabled");
    const before = await selection(app, tabId);
    await app.click(rowCss(1));
    await app.waitFor(async () => (await rows(app))[1]?.selected, 5000, { message: "row 1 selected" });
    assertEqual(await selection(app, tabId), before, "the details keep the previous commit");

    await contextMenu(app, rowCss(1));
    const items = await menuItems(app);
    for (const pattern of [/^Create branch here/, /^Check out commit/, /^Reset .main. to here/]) {
      const item = items.find((entry) => pattern.test(entry.text));
      assert(item?.disabled, `${pattern} is disabled: ${JSON.stringify(item)}`);
    }
    assert(!items.find((entry) => /^Copy SHA/.test(entry.text))?.disabled, "copy SHA stays enabled");
    await t.shot("gone-commit-menu");
    await chooseMenu(app, /^Copy SHA/);
    const toast = await waitToast(app, "success", /SHA copied/i);
    assertIncludes(toast.text, repo.shas.lost, "the SHA of the removed commit is copied");
    assertEqual(repo.branches(), ["feature/wind", "main"], "no branch created");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("reflog switched off: empty state with a hint", "edge", async (t) => {
  const repo = makeEmptyReflogRepo("ohne-protokoll", { logRefs: false });
  try {
    repo.write("a.txt", "eins\n");
    repo.commit("Erster Stand");
    repo.write("a.txt", "zwei\n");
    repo.commit("Zweiter Stand");
    assertEqual(repo.reflog(), [], "git has no HEAD reflog");
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    const empty = await app.waitFor('[data-screen="reflog"] [data-reflog-empty]', 15_000);
    const text = await app.exec((el) => el.innerText.replace(/\s+/g, " ").trim(), empty);
    assertIncludes(text, "No reflog entries", "empty title");
    assertIncludes(text, "core.logAllRefUpdates", "hint names the setting");
    assertEqual(await app.$('[data-reflog-list]'), null, "no list");
    await t.shot("reflog-empty");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("keyboard: arrows select, Enter shows details, Shift+F10 opens the menu, Esc goes back", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    await app.waitFor(() => app.exec(() => document.activeElement?.hasAttribute("data-reflog-list") ?? false), 5000, { message: "list has the focus" });
    await app.press("ArrowDown", "ArrowDown", "ArrowDown");
    await app.waitFor(async () => (await rows(app))[3]?.selected, 5000, { message: "row 3 selected" });
    assertEqual(await selection(app, tabId), [repo.shas.f1], "arrow selection updates the details");
    await app.press("ArrowUp");
    await app.waitFor(async () => (await rows(app))[2]?.selected, 5000, { message: "row 2 selected" });
    await app.press("End");
    await app.waitFor(async () => (await rows(app))[8]?.selected, 5000, { message: "last row selected" });
    assertEqual(await selection(app, tabId), [repo.shas.c1], "End selects the oldest");
    await app.press("Home");
    await app.waitFor(async () => (await rows(app))[0]?.selected, 5000, { message: "first row selected" });
    await app.press("ArrowUp");
    assert((await rows(app))[0].selected, "ArrowUp at the top stays there");
    await app.press("ArrowDown", "Enter");
    await detailsShow(app, "Verworfener Versuch");
    assertEqual(await app.exec((id) => window.__gc.store.getState().views[id]?.rightPanel, tabId), "details", "Enter opens the details panel");

    await app.press("Shift+F10");
    await app.waitFor('[role="menu"]', 5000, { message: "menu from Shift+F10" });
    assertMatch(await app.exec(() => document.querySelector('[role="menu"]')?.getAttribute("aria-label") ?? ""), /HEAD@\{1\}/, "menu is for the selected entry");
    // Esc closes only the menu; the reflog stays.
    await app.press("Escape");
    await noMenu(app);
    assertEqual((await center(app, tabId))?.kind, "reflog", "Esc on the menu keeps the reflog");
    await app.waitFor(() => app.exec(() => document.activeElement?.hasAttribute("data-reflog-list") ?? false), 5000, { message: "focus back on the list" });
    await app.press("Escape");
    await app.waitFor(async () => (await center(app, tabId))?.kind !== "reflog", 5000, { message: "Esc goes back" });
    assertEqual(await app.$('[data-screen="reflog"]'), null, "reflog closed");
    assertEqual(repo.head(), repo.shas.c3a, "nothing changed in git");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("a reflog of 1200 entries loads page by page", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const messages = writeLongReflog(repo, [repo.shas.c1, repo.shas.c2, repo.shas.c3a], 1200);
    const { app, tabId } = await start(t, repo);
    const started = Date.now();
    await openFromPalette(app, tabId);
    await waitRows(app, (now) => now.length > 0 && now[0].message === messages[0], "first page");
    t.step(`first page after ${Date.now() - started} ms`);
    const loaded = () => app.exec(() => window.__gc.queryClient.getQueriesData({ queryKey: ["repo"] }).filter(([key]) => key[2] === "reflog").map(([, data]) => data?.pages?.reduce((sum, page) => sum + page.entries.length, 0) ?? 0)[0] ?? 0);
    assertEqual(await loaded(), 500, "one page of 500 at first");
    // End selects the last loaded entry; near the end the next page is loaded.
    for (let round = 0; round < 6 && (await loaded()) < 1200; round += 1) {
      await app.press("End");
      await sleep(400);
      await app.settle();
    }
    assertEqual(await loaded(), 1200, "all pages loaded");
    await app.press("End");
    const last = await waitRows(app, (now) => now.some((row) => row.index === 1199 && row.selected), "oldest entry selected");
    const oldest = last.find((row) => row.index === 1199);
    assertEqual(oldest.message, "checkout: Eintrag 0", "oldest entry is the first line of the log");
    assertIncludes(oldest.meta, "HEAD@{1199}", "selector counts through");
    assert(last.length < 100, `the list is virtualised (${last.length} rows rendered)`);
    await t.shot("reflog-long");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("credentials in reflog messages are masked; unusual text is shown as is", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const secret = "ghp_R3fl0gGeheimToken0123456789abcdefABCD";
    repo.git("update-ref", "-m", `pull https://lena:${secret}@git.example.invalid/wetter.git: Fast-forward`, "HEAD", repo.shas.c3a);
    const long = `checkout: Ä Ö Ü ß – 🌧️ Regen ${"sehr lange Nachricht ".repeat(20)}Ende`;
    repo.git("update-ref", "-m", long, "HEAD", repo.shas.c3a);
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    const list = await waitRows(app, STORY_ACTIONS.length + 2);
    assertEqual(list[1].action, "pull", "pull recognised");
    assert(!list[1].message.includes(secret) && !list[1].message.includes("lena:"), `token masked: ${list[1].message}`);
    assertIncludes(list[1].message, "git.example.invalid/wetter.git", "host stays readable");
    const page = await app.exec(() => document.body.innerHTML);
    assert(!page.includes(secret), "the token appears nowhere in the page (also not in title attributes)");
    assertEqual(list[0].message, long.trim(), "umlauts, emoji and a long message are shown unchanged");
    assertEqual(list[0].action, "checkout", "action from the prefix");
    const overflow = await app.exec(() => {
      const row = document.querySelector('[data-reflog-list] [data-index="0"]');
      return row ? row.scrollWidth > row.clientWidth + 1 : null;
    });
    assertEqual(overflow, false, "the long message is truncated inside the row");
    await t.shot("reflog-masked");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("the reflog follows the repository: new commits appear, a deleted branch shows an error", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    repo.write("neu.txt", "von der Kommandozeile\n");
    const sha = repo.commit("Commit von der Kommandozeile");
    await app.exec(() => window.dispatchEvent(new Event("focus")));
    const after = await waitRows(app, (now) => now.length === STORY_ACTIONS.length + 1, "new entry appears");
    assertEqual(after[0].message, "commit: Commit von der Kommandozeile", "newest entry from the CLI");
    assertEqual(after[0].sha, sha, "with its SHA");

    // Reflog of feature/wind, then the branch is deleted outside the app.
    await chooseFilter(app, "feature/wind");
    await waitRows(app, 2, "branch reflog");
    repo.git("branch", "-D", "feature/wind");
    await app.exec(() => window.dispatchEvent(new Event("focus")));
    const errorText = await app.waitFor(() => app.exec(() => {
      const root = document.querySelector('[data-screen="reflog"]');
      const text = root?.innerText.replace(/\s+/g, " ") ?? "";
      return text.includes("could not be read") ? text : null;
    }), 20_000, { message: "error state" });
    assertMatch(errorText, /feature\/wind/, `error names the branch: ${errorText}`);
    assert(await app.byText("Try again", { within: '[data-screen="reflog"]' }), "retry button");
    await t.shot("reflog-branch-deleted");
    // Back to HEAD: the view recovers.
    await chooseFilter(app, "HEAD");
    await waitRows(app, STORY_ACTIONS.length + 1, "HEAD reflog again");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("cancel: the branch dialog and the hard reset prompt change nothing", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    const before = { head: repo.head(), branches: repo.branches(), reflog: repo.reflog().length };

    await contextMenu(app, rowCss(1));
    await chooseMenu(app, /^Create branch here/);
    await waitDialog(app, /^New branch$/);
    await app.type(await app.waitFor('[role="dialog"] input'), "wird-nicht-angelegt");
    await app.press("Escape");
    await noDialog(app);
    assertEqual((await center(app, tabId))?.kind, "reflog", "Esc in the dialog keeps the reflog open");

    await contextMenu(app, rowCss(7));
    await chooseMenu(app, /^Reset .main. to here/);
    await app.waitFor(async () => (await app.$$('[role="menu"]')).length >= 2, 5000, { message: "reset submenu" });
    await chooseMenu(app, /^Hard/);
    await waitDialog(app, /^Hard reset/);
    await dialogButton(app, /^Cancel$/);
    await noDialog(app);
    await sleep(500);
    assertEqual({ head: repo.head(), branches: repo.branches(), reflog: repo.reflog().length }, before, "git unchanged");
    assertEqual(repo.undoRefs(), [], "no undo backup was made");
    assertEqual((await rows(app)).length, STORY_ACTIONS.length, "list unchanged");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("the entry marked as selected when the reflog opens is the one the details show", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    const list = await waitRows(app, STORY_ACTIONS.length);
    assert(list[0].selected, "HEAD@{0} is marked as selected (aria-selected)");
    await app.settle();
    await t.shot("initial-selection");
    // The list says HEAD@{0} is selected; the right panel should show that commit, not the local changes.
    const shown = await selection(app, tabId);
    assertEqual(shown, [list[0].sha], "the details panel shows the selected entry");
  } finally {
    repo.cleanup();
  }
});

scenario("hard reset prompt from the reflog counts only the commits that really disappear", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    // main is at c3a; c3 (HEAD@{6}) is its sibling (both on c2), only reachable through the reflog.
    const dropped = repo.git("rev-list", "--count", `${repo.shas.c3}..main`);
    assertEqual(dropped, "1", "git: exactly one commit (the amended one) leaves main");
    await contextMenu(app, rowCss(6));
    await chooseMenu(app, /^Reset .main. to here/);
    await app.waitFor(async () => (await app.$$('[role="menu"]')).length >= 2, 5000, { message: "reset submenu" });
    await chooseMenu(app, /^Hard/);
    const info = await waitDialog(app, /^Hard reset .main. to /);
    await t.shot("reset-prompt-count");
    await dialogButton(app, /^Cancel$/);
    await noDialog(app);
    assertEqual(repo.head(), repo.shas.c3a, "cancelled, nothing changed");
    assert(!info.text.includes("Grundgerüst") && !info.text.includes("Messreihe ergänzt"), `the prompt must not list commits that stay on main: ${info.text}`);
    assertMatch(info.text, /1 commit disappears|commits after this point disappear/, `the prompt names one commit (or says it cannot tell): ${info.text}`);
  } finally {
    repo.cleanup();
  }
});

scenario("when a new entry arrives, the highlighted entry stays the one the details show", "edge", async (t) => {
  const repo = makeReflogRepo();
  try {
    const { app, tabId } = await start(t, repo);
    await openFromPalette(app, tabId);
    await waitRows(app, STORY_ACTIONS.length);
    await app.click(rowCss(3));
    await app.waitFor(async () => (await rows(app))[3]?.selected, 5000, { message: "row 3 selected" });
    await detailsShow(app, "Wind erfassen");
    // A commit from the command line adds HEAD@{0}; every other entry moves down by one.
    repo.write("neu.txt", "von der Kommandozeile\n");
    repo.commit("Commit von der Kommandozeile");
    await app.exec(() => window.dispatchEvent(new Event("focus")));
    const after = await waitRows(app, STORY_ACTIONS.length + 1, "new entry appears");
    await app.settle();
    await t.shot("selection-after-update");
    const highlighted = after.find((row) => row.selected);
    assertEqual(await selection(app, tabId), [repo.shas.f1], "details still show “Wind erfassen”");
    assertEqual(highlighted?.message, "commit: Wind erfassen", `the highlighted row matches the details (is: ${highlighted?.message})`);
  } finally {
    repo.cleanup();
  }
});
