/**
 * Branches in the real app over WebDriver: create, rename, delete, drag and drop merge/rebase,
 * cherry-pick, revert, reset (1.0) and the conflict preflight before merge, rebase, cherry-pick
 * and revert (1.1). Every scenario works on a fresh real repository (fixtures/branches.mjs) and
 * checks the result in the UI and with git in the repository.
 *
 *   node scripts/e2e-wd/features/branches.mjs
 *   node scripts/e2e-wd/run.mjs branches --only preflight
 */
import { makeBranchRepo, werte } from "../fixtures/branches.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (sha) => sha.slice(0, 7);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A point inside the element (CSS selector), in viewport coordinates. */
async function pointOf(app, css, { dx = null } = {}) {
  const point = await app.waitFor(
    () =>
      app.exec(
        (selector, offset) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          el.scrollIntoView({ block: "nearest" });
          const box = el.getBoundingClientRect();
          if (box.width === 0) return null;
          return { x: Math.round(box.left + (offset ?? Math.min(60, box.width / 2))), y: Math.round(box.top + box.height / 2) };
        },
        css,
        dx,
      ),
    10_000,
    { message: `element ${css}` },
  );
  return point;
}

const pointerActions = (actions) => ({ actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });

async function perform(app, body) {
  await app.webdriver("POST", "/actions", body);
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** Moves the mouse to an empty spot (right panel) so no hover tooltip covers a screenshot, then shoots. */
async function shot(t, name) {
  await perform(t.app, pointerActions([{ type: "pointerMove", origin: "viewport", x: 1250, y: 560 }]));
  await sleep(250);
  return t.shot(name);
}

/** Right-click on the element and wait for the context menu. */
async function contextMenu(app, css) {
  const { x, y } = await pointOf(app, css);
  await perform(app, pointerActions([{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 }]));
  await app.waitFor('[role="menu"]', 5000, { message: "context menu open" });
}

/** Ctrl+click (adds to the selection). */
async function ctrlClick(app, css) {
  const { x, y } = await pointOf(app, css);
  await app.webdriver("POST", "/actions", {
    actions: [
      { type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "" }, { type: "pause" }, { type: "pause" }, { type: "pause" }, { type: "keyUp", value: "" }] },
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pause" }, { type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause" }],
      },
    ],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/**
 * Drags `from` onto `to` with the mouse (pointer events, as the sidebar expects). `escape` presses
 * Esc while still over the target, before releasing.
 */
async function drag(app, from, to, { escape = false, beforeRelease = null } = {}) {
  const a = await pointOf(app, from);
  const b = await pointOf(app, to);
  await app.webdriver("POST", "/actions", pointerActions([
    { type: "pointerMove", origin: "viewport", x: a.x, y: a.y },
    { type: "pointerDown", button: 0 },
    { type: "pointerMove", origin: "viewport", x: a.x + 6, y: a.y + 10, duration: 80 },
    { type: "pointerMove", origin: "viewport", x: b.x, y: b.y, duration: 250 },
    { type: "pause", duration: 150 },
  ]));
  if (beforeRelease) await beforeRelease();
  if (escape) await app.press("Escape");
  await perform(app, pointerActions([{ type: "pointerUp", button: 0 }]));
}

/** Menu items of the open menus: [{ text, disabled }]. */
function menuItems(app) {
  return app.exec(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => ({
      text: item.innerText.replace(/\s+/g, " ").trim(),
      title: item.getAttribute("title") ?? "",
      disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
    })),
  );
}

/** Clicks the (enabled) menu item whose text matches. */
async function chooseMenu(app, pattern) {
  const items = await menuItems(app);
  const index = items.findIndex((item) => pattern.test(item.text));
  assert(index >= 0, `menu item ${pattern} missing; menu: ${items.map((item) => item.text).join(" | ")}`);
  assert(!items[index].disabled, `menu item ${pattern} is disabled: ${items[index].text}`);
  const elements = await app.$$('[role="menu"] [role^="menuitem"]');
  await elements[index].click();
}

async function noMenu(app) {
  await app.waitFor(async () => (await app.$$('[role="menu"]')).length === 0, 5000, { message: "menu closed" });
}

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

async function noDialog(app) {
  await app.waitFor(async () => (await app.$$('[role="dialog"], [role="alertdialog"]')).length === 0, 8000, { message: "dialog closed" });
}

/** Clicks a footer button of the open dialog by its text. */
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

/** Toasts currently shown: [{ tone, text }]. */
function toasts(app) {
  return app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.getAttribute("data-toast"), text: el.innerText.replace(/\s+/g, " ").trim() })));
}

async function waitToast(app, tone, pattern, timeout = 15_000) {
  return app.waitFor(
    async () => (await toasts(app)).find((toast) => toast.tone === tone && pattern.test(toast.text)) ?? null,
    timeout,
    { message: `${tone} toast ${pattern}` },
  );
}

async function noDangerToasts(app) {
  const danger = (await toasts(app)).filter((toast) => toast.tone === "danger");
  assertEqual(danger, [], "no error message");
}

async function dismissToasts(app) {
  await app.exec(() => {
    for (const el of document.querySelectorAll("[data-toast] button[aria-label]")) if (/close|dismiss/i.test(el.getAttribute("aria-label"))) el.click();
  });
}

const branchRow = (name) => `[data-row-id="refs/heads/${name}"]`;
const commitRow = (sha) => `[data-row-id="${sha}"]`;
/** The message cell of a commit row: right-clicks there hit the commit, not a branch label. */
const commitCell = (sha) => `[data-row-id="${sha}"] [data-cell="message"]`;

/** Waits until the sidebar shows exactly these local branches (row ids). */
async function waitSidebarBranches(app, names) {
  const wanted = names.map((name) => `refs/heads/${name}`).sort();
  return app.waitFor(
    async () => {
      const ids = await app.exec(() => [...document.querySelectorAll('[data-row-id^="refs/heads/"]')].map((el) => el.dataset.rowId).sort());
      return JSON.stringify(ids) === JSON.stringify(wanted) ? ids : null;
    },
    10_000,
    { message: `sidebar branches ${wanted.join(", ")}` },
  );
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

async function start(t, repo) {
  const app = await t.launch(LAUNCH);
  const ids = await app.openRepo(repo.path);
  await app.waitFor(commitRow(repo.head()), 20_000, { message: "HEAD commit row" });
  await app.waitFor(branchRow("main"), 10_000, { message: "main in the sidebar" });
  return { app, ...ids };
}

const conflictedFiles = (repo) => repo.git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);

/** Rebase the two-commit series "serie" (s1 clean, s2 touches line 3) – conflicts at s2 against main. */
function addSeries(repo) {
  repo.git("checkout", "-q", "-b", "serie", repo.shas.c2);
  repo.write("notizen.txt", "Notiz eins\n");
  repo.shas.s1 = repo.commit("Notiz anlegen");
  repo.write("werte.txt", werte({ 3: "Zeile 3: Messwert 22 hPa (Serie)" }));
  repo.shas.s2 = repo.commit("Zeile drei in der Serie");
  repo.git("checkout", "-q", "main");
}

// ---------------------------------------------------------------------------------------------
// 1.0 Create branch
// ---------------------------------------------------------------------------------------------

scenario("create branch from the toolbar and check it out", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    const button = await app.waitFor(() => app.byText("Branch"), 10_000, { message: "toolbar button Branch" });
    await button.click();
    const info = await waitDialog(app, /^New branch$/);
    assertIncludes(info.text, "current commit", "dialog explains the start point");
    const input = await app.waitFor('[role="dialog"] input');
    await app.type(input, "feature/regen menge");
    assertEqual(await input.prop("value"), "feature/regen-menge", "spaces become -");
    await app.waitFor(async () => !(await dialogInfo(app)).buttons.find((b) => b.text === "Create branch")?.disabled, 5000, { message: "Create branch enabled" });
    await shot(t, "create-branch-dialog");
    await app.press("Enter");
    await noDialog(app);
    t.step("dialog confirmed with Enter");
    await eventually(() => repo.branch(), "feature/regen-menge", "new branch is checked out (git)");
    assertEqual(repo.sha("feature/regen-menge"), repo.shas.c3, "starts at the former HEAD");
    await waitToast(app, "success", /feature\/regen-menge/);
    await app.waitFor(async () => (await app.$(branchRow("feature/regen-menge")))?.attr("aria-current").then((v) => v === "true"), 10_000, { message: "sidebar marks the new branch as checked out" });
    await shot(t, "create-branch-done");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("create branch: existing and invalid names are refused, Esc cancels", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await app.press("Control+b");
    await waitDialog(app, /^New branch$/);
    const input = await app.waitFor('[role="dialog"] input');
    await app.type(input, "main");
    const exists = await app.waitFor(() => app.exec(() => document.querySelector('[role="dialog"] [role="alert"]')?.innerText ?? null), 5000, { message: "reason for an existing name" });
    assertMatch(exists, /already exists/, "existing name reason");
    assertEqual(await input.attr("aria-invalid"), "true", "input marked invalid");
    assert((await dialogInfo(app)).buttons.find((b) => b.text === "Create branch").disabled, "Create branch is disabled for an existing name");
    await app.press("Enter");
    await sleep(300);
    assert(await dialogInfo(app), "Enter with an existing name keeps the dialog open");

    await app.press("Control+a", "Backspace");
    await app.type(input, "kaputt..name");
    await app.waitFor(
      () => app.exec(() => { const text = document.querySelector('[role="dialog"] [role="alert"]')?.innerText ?? ""; return text && !/already exists/.test(text) ? text : null; }),
      5000,
      { message: "Git rule reason for an invalid name" },
    );
    assert((await dialogInfo(app)).buttons.find((b) => b.text === "Create branch").disabled, "Create branch is disabled for an invalid name");

    await app.press("Escape");
    await noDialog(app);
    assertEqual(repo.branches(), ["erledigt", "feature/luftdruck", "konflikt", "main"], "no branch was created (git)");
    assertEqual(repo.branch(), "main", "HEAD unchanged");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("create branch at a selected commit from the commit menu", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, commitCell(repo.shas.f1));
    await chooseMenu(app, /^Create branch here/);
    const info = await waitDialog(app, /^New branch$/);
    assertIncludes(info.text, short(repo.shas.f1), "the dialog names the start commit");
    const input = await app.waitFor('[role="dialog"] input');
    await app.type(input, "abzweig");
    await app.press("Enter");
    await noDialog(app);
    await eventually(() => repo.tryGit("rev-parse", "abzweig").out, repo.shas.f1, "branch starts at the chosen commit (git)");
    await eventually(() => repo.branch(), "abzweig", "and is checked out");
    await app.waitFor(branchRow("abzweig"), 10_000);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 Rename branch
// ---------------------------------------------------------------------------------------------

scenario("rename a branch inline in the sidebar with F2", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await app.click(branchRow("feature/luftdruck"));
    await app.press("F2");
    const input = await app.waitFor("[data-rename-input]", 5000, { message: "rename input" });
    assertEqual(await input.prop("value"), "feature/luftdruck", "input starts with the full name");
    await app.press("Control+a", "Backspace");
    await app.type(input, "feature/luft druck");
    assertEqual(await input.prop("value"), "feature/luft-druck", "spaces become -");
    await shot(t, "rename-branch-inline");
    await app.press("Enter");
    await eventually(() => repo.branches(), ["erledigt", "feature/luft-druck", "konflikt", "main"], "renamed in git");
    assertEqual(repo.sha("feature/luft-druck"), repo.shas.f2, "same commit");
    await waitSidebarBranches(app, ["erledigt", "feature/luft-druck", "konflikt", "main"]);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("rename: existing name shows the reason, Esc discards; rename via the menu", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await app.click(branchRow("konflikt"));
    await app.press("F2");
    const input = await app.waitFor("[data-rename-input]");
    await app.press("Control+a", "Backspace");
    await app.type(input, "main");
    const reason = await app.waitFor(() => app.exec(() => document.querySelector('[data-left-scroll] [role="alert"]')?.innerText ?? null), 5000, { message: "reason at the row" });
    assertMatch(reason, /main/, "reason names the existing branch");
    await app.press("Enter");
    await sleep(400);
    assert(await app.$("[data-rename-input]"), "Enter with an existing name does not rename");
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$("[data-rename-input]")), 5000, { message: "input closed" });
    assertEqual(repo.branches(), ["erledigt", "feature/luftdruck", "konflikt", "main"], "nothing renamed (git)");

    // Same input from the context menu
    await contextMenu(app, branchRow("konflikt"));
    await chooseMenu(app, /^Rename/);
    const again = await app.waitFor("[data-rename-input]", 5000, { message: "rename input from the menu" });
    await app.waitFor(() => app.exec(() => document.activeElement?.hasAttribute("data-rename-input") ?? false), 5000, { message: "input focused after the menu closed" });
    await app.press("Control+a", "Backspace");
    await app.type(again, "sensor-b");
    await app.press("Enter");
    await eventually(() => repo.branches(), ["erledigt", "feature/luftdruck", "main", "sensor-b"], "renamed via the menu (git)");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 Delete branch
// ---------------------------------------------------------------------------------------------

scenario("delete a merged branch from the context menu", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, branchRow("erledigt"));
    await chooseMenu(app, /^Delete .erledigt./);
    const info = await waitDialog(app, /erledigt/);
    assertMatch(info.text, /main/, "the prompt says where the commits are contained");
    assert(info.buttons.some((b) => b.text === "Delete branch"), `plain “Delete branch” for a merged branch (${info.buttons.map((b) => b.text).join(", ")})`);
    await shot(t, "delete-branch-confirm");
    await dialogButton(app, "Delete branch");
    await noDialog(app);
    await eventually(() => repo.branches(), ["feature/luftdruck", "konflikt", "main"], "deleted in git");
    await waitSidebarBranches(app, ["feature/luftdruck", "konflikt", "main"]);
    await waitToast(app, "success", /erledigt/);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("delete an unmerged branch: Delete anyway, cancel keeps it, undo brings it back", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, branchRow("konflikt"));
    await chooseMenu(app, /^Delete .konflikt./);
    let info = await waitDialog(app, /konflikt/);
    assert(info.buttons.some((b) => b.text === "Delete anyway"), `“Delete anyway” for an unmerged branch (${info.buttons.map((b) => b.text).join(", ")})`);
    assertMatch(info.text, /1 commit|not merged|not contained/i, "the prompt warns about the unmerged commit");
    await dialogButton(app, "Cancel");
    await noDialog(app);
    assertEqual(repo.tryGit("rev-parse", "konflikt").out, repo.shas.k1, "Cancel keeps the branch (git)");

    await contextMenu(app, branchRow("konflikt"));
    await chooseMenu(app, /^Delete .konflikt./);
    info = await waitDialog(app, /konflikt/);
    await dialogButton(app, "Delete anyway");
    await noDialog(app);
    await eventually(() => repo.branches(), ["erledigt", "feature/luftdruck", "main"], "deleted in git (forced)");
    await waitSidebarBranches(app, ["erledigt", "feature/luftdruck", "main"]);
    assert(repo.tryGit("show-ref").out.includes("refs/forkyard/undo/"), "an undo backup ref exists");

    await app.click("[data-shell]").catch(() => undefined);
    await app.press("Control+z");
    await eventually(() => repo.tryGit("rev-parse", "konflikt").out, repo.shas.k1, "Ctrl+Z restores the branch at its commit (git)");
    await waitSidebarBranches(app, ["erledigt", "feature/luftdruck", "konflikt", "main"]);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("the checked-out branch cannot be deleted", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, branchRow("main"));
    const items = await menuItems(app);
    const del = items.find((item) => /^Delete .main./.test(item.text));
    assert(del, `delete entry present: ${items.map((item) => item.text).join(" | ")}`);
    assert(del.disabled, "delete entry is disabled");
    assertMatch(del.text, /checked-out branch can.t be deleted/, "the reason is shown");
    await app.press("Escape");
    await noMenu(app);
    assertEqual(repo.branches(), ["erledigt", "feature/luftdruck", "konflikt", "main"], "nothing deleted");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 Drag and drop merge / rebase
// ---------------------------------------------------------------------------------------------

scenario("drag a branch onto main and merge it", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await drag(app, branchRow("feature/luftdruck"), branchRow("main"), {
      beforeRelease: async () => {
        await app.waitFor(async () => (await app.$(`${branchRow("main")}[data-drop-target]`)) !== null, 5000, { message: "main marked as drop target" });
        assert(await app.$("[data-drag-ghost]"), "a label follows the pointer");
      },
    });
    await app.waitFor('[role="menu"]', 5000, { message: "drop menu" });
    const text = await app.exec(() => document.querySelector('[role="menu"]').innerText.replace(/\s+/g, " "));
    assertIncludes(text, "feature/luftdruck → main", "the drop menu names source and target");
    await shot(t, "drag-drop-menu");
    await chooseMenu(app, /^Merge .feature\/luftdruck. into .main./);
    await eventually(() => repo.git("log", "-1", "--format=%P", "main").split(" ").length, 2, "merge commit with two parents (git)");
    assertEqual(repo.git("log", "-1", "--format=%P", "main").split(" "), [repo.shas.c3, repo.shas.f2], "parents are main and the branch");
    await waitToast(app, "success", /Merge/);
    assert(repo.exists("luftdruck.txt"), "the branch's file is in the worktree");
    assertEqual(repo.status(), "", "worktree clean");
    await eventually(() => repo.operation(), null, "no operation left running", 5000);
    await app.waitFor(commitRow(repo.head()), 10_000, { message: "merge commit in the graph" });
    await shot(t, "drag-drop-merged");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("drag a branch onto main and rebase it", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await drag(app, branchRow("feature/luftdruck"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000, { message: "drop menu" });
    await chooseMenu(app, /^Rebase .feature\/luftdruck. onto .main./);
    await eventually(() => repo.git("merge-base", "feature/luftdruck", "main"), repo.shas.c3, "the branch now sits on main (git)");
    assertEqual(repo.git("log", "--format=%s", "main..feature/luftdruck").split("\n"), ["Luftdruck kalibrieren", "Luftdruck erfassen"], "both commits replayed in order");
    assertEqual(repo.sha("main"), repo.shas.c3, "main itself unchanged");
    await eventually(() => repo.operation(), null, "no rebase left running", 5000);
    await waitToast(app, "success", /Rebase/);
    await app.waitFor(commitRow(repo.sha("feature/luftdruck")), 10_000, { message: "rebased commit in the graph" });
    await shot(t, "drag-drop-rebased");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("drag and drop: Esc cancels, a tag is no target, closing the menu changes nothing", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    const head = repo.head();
    await drag(app, branchRow("feature/luftdruck"), branchRow("main"), {
      escape: true,
      beforeRelease: () => app.waitFor(`${branchRow("main")}[data-drop-target]`, 5000, { message: "target marked" }),
    });
    await app.waitFor(async () => !(await app.$("[data-drag-ghost]")), 3000, { message: "Esc removes the drag label" });
    await sleep(300);
    assertEqual((await app.$$('[role="menu"]')).length, 0, "no menu after Esc");

    if (!(await app.$('[data-row-id="refs/tags/v0.1"]'))) {
      await app.click('[data-section="tags"] [data-section-header]');
      await app.waitFor('[data-row-id="refs/tags/v0.1"]', 5000, { message: "tag row after expanding Tags" });
    }
    await drag(app, branchRow("feature/luftdruck"), '[data-row-id="refs/tags/v0.1"]', {
      beforeRelease: async () => assertEqual(await app.$('[data-row-id="refs/tags/v0.1"][data-drop-target]'), null, "a tag is not marked as target"),
    });
    await sleep(300);
    assertEqual((await app.$$('[role="menu"]')).length, 0, "no menu after dropping on a tag");

    await drag(app, branchRow("feature/luftdruck"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000);
    await app.press("Escape");
    await noMenu(app);
    assertEqual(repo.head(), head, "HEAD unchanged");
    assertEqual(repo.branch(), "main", "still on main");
    assertEqual(repo.status(), "", "worktree clean");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("drag and drop: merging an already merged branch is blocked with a reason", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await drag(app, branchRow("erledigt"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000);
    const items = await menuItems(app);
    const merge = items.find((item) => /^Merge .erledigt. into .main./.test(item.text));
    assert(merge?.disabled, `merge entry disabled: ${JSON.stringify(merge)}`);
    assertMatch(merge.text, /already in/, "reason: already contained");
    const rebase = items.find((item) => /^Rebase .erledigt. onto .main./.test(item.text));
    assert(rebase && !rebase.disabled, "rebasing it onto main stays possible");
    await app.press("Escape");
    await noMenu(app);
    assertEqual(repo.head(), repo.shas.c3, "nothing happened");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 Cherry-pick
// ---------------------------------------------------------------------------------------------

scenario("cherry-pick a commit of another branch onto main", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, commitCell(repo.shas.f1));
    await chooseMenu(app, /^Cherry-pick onto .main./);
    await eventually(() => repo.subject("main"), "Luftdruck erfassen", "new commit on main (git)");
    assertEqual(repo.git("log", "-1", "--format=%P", "main"), repo.shas.c3, "on top of the former HEAD");
    assert(repo.head() !== repo.shas.f1, "a new commit, not the original");
    await waitToast(app, "success", /Cherry-pick/);
    assertEqual(repo.read("luftdruck.txt"), "Luftdruck: 1013 hPa\n", "content of the picked commit");
    await eventually(() => repo.operation(), null, "no cherry-pick left running", 5000);
    await app.waitFor(`${commitRow(repo.head())}`, 10_000, { message: "new commit in the graph" });
    await shot(t, "cherry-pick-done");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("cherry-pick several commits goes through the rebase tool with a clean preview", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await app.click(commitRow(repo.shas.f1));
    await ctrlClick(app, commitCell(repo.shas.f2));
    await contextMenu(app, commitCell(repo.shas.f2));
    await chooseMenu(app, /^Cherry-pick 2 commits/);
    await app.waitFor('[data-screen="rebase"][data-mode="cherry_pick"]', 10_000, { message: "rebase tool in cherry-pick mode" });
    await app.waitFor('[data-conflict-preview="clean"]', 15_000, { message: "preview: no conflicts expected" });
    assertIncludes(await app.exec(() => document.querySelector("[data-conflict-preview]").innerText), "No conflicts expected", "preview text");
    await shot(t, "cherry-pick-many-tool");
    await app.click({ text: "Cherry-pick 2 commits" });
    await eventually(() => repo.git("log", "--format=%s", `${repo.shas.c3}..main`).split("\n"), ["Luftdruck kalibrieren", "Luftdruck erfassen"], "both picked in history order (git)");
    await eventually(() => repo.operation(), null, "no operation left running", 5000);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 Revert
// ---------------------------------------------------------------------------------------------

scenario("revert a commit of main with a new commit", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, commitCell(repo.shas.c2));
    await chooseMenu(app, /^Revert/);
    await eventually(() => repo.subject("main"), 'Revert "Messreihe ergänzt"', "revert commit on main (git)");
    assertEqual(repo.git("log", "-1", "--format=%P"), repo.shas.c3, "on top of the former HEAD");
    assert(!repo.exists("daten.csv"), "the reverted file is gone");
    assertEqual(repo.status(), "", "worktree clean");
    await waitToast(app, "success", /Revert/);
    await app.waitFor(commitRow(repo.head()), 10_000, { message: "revert commit in the graph" });
    await shot(t, "revert-done");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("revert is blocked for a commit that is not in the checked-out branch", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, commitCell(repo.shas.f1));
    const revert = (await menuItems(app)).find((item) => /^Revert/.test(item.text));
    assert(revert?.disabled, `revert disabled: ${JSON.stringify(revert)}`);
    assertMatch(revert.text, /not in .main./, "reason names the branch");
    await app.press("Escape");
    await noMenu(app);
    assertEqual(repo.head(), repo.shas.c3, "nothing happened");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.0 Reset
// ---------------------------------------------------------------------------------------------

async function openResetMenu(app, sha) {
  await contextMenu(app, commitCell(sha));
  await chooseMenu(app, /^Reset .main. to here/);
  await app.waitFor(async () => (await app.$$('[role="menu"]')).length >= 2, 5000, { message: "reset submenu" });
}

scenario("reset hard asks first, discards commits and changes, undo brings both back", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    repo.write("werte.txt", werte({ 3: "Zeile 3: Messwert 21,0 hPa (gerundet)", 9: "Zeile 9: noch nicht gespeichert" }));
    const { app } = await start(t, repo);
    await openResetMenu(app, repo.shas.c2);
    await chooseMenu(app, /^Hard/);
    const info = await waitDialog(app, /reset/i);
    assertMatch(info.text, /1 commit/, "the prompt counts the dropped commit");
    assertIncludes(info.text, "werte.txt", "and names the changed file");
    assertMatch(info.text, /undo/i, "and mentions undo");
    await shot(t, "reset-hard-confirm");
    const confirmLabel = info.buttons.find((b) => /reset/i.test(b.text))?.text;
    assert(confirmLabel, `confirm button: ${info.buttons.map((b) => b.text).join(", ")}`);
    await dialogButton(app, confirmLabel);
    await noDialog(app);
    await eventually(() => repo.head(), repo.shas.c2, "HEAD reset to the chosen commit (git)");
    assertEqual(repo.status(), "", "uncommitted change discarded");
    await waitToast(app, "success", /is now at/);

    await app.press("Control+z");
    await eventually(() => repo.head(), repo.shas.c3, "undo restores the commit (git)");
    await eventually(() => repo.read("werte.txt").includes("noch nicht gespeichert"), true, "undo restores the uncommitted change");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("reset soft keeps the changes staged; cancelling a hard reset changes nothing", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await openResetMenu(app, repo.shas.c1);
    await chooseMenu(app, /^Hard/);
    await waitDialog(app, /reset/i);
    await dialogButton(app, "Cancel");
    await noDialog(app);
    assertEqual(repo.head(), repo.shas.c3, "cancel: HEAD unchanged");

    await openResetMenu(app, repo.shas.c2);
    await chooseMenu(app, /^Soft/);
    await eventually(() => repo.head(), repo.shas.c2, "soft reset moved HEAD (git)");
    assertEqual(repo.git("diff", "--cached", "--name-only"), "werte.txt", "the dropped commit's change is staged");
    assertEqual(repo.git("diff", "--name-only"), "", "nothing unstaged");
    await waitToast(app, "success", /is now at/);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 1.1 Conflict preflight
// ---------------------------------------------------------------------------------------------

async function waitPreflight(app) {
  await app.waitFor('[data-screen="preflight"]:not([aria-busy])', 15_000, { message: "preflight dialog with an answer" });
  return dialogInfo(app);
}

const preflightFiles = (app) => app.exec(() => [...document.querySelectorAll('[data-screen="preflight"] ul li')].map((li) => li.innerText.trim()));

scenario("preflight: a merge with conflicts names the files; going ahead stops in the conflict", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await drag(app, branchRow("konflikt"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000, { message: "drop menu" });
    await chooseMenu(app, /^Merge .konflikt. into .main./);
    const info = await waitPreflight(app);
    assertEqual(info.title, "Merge konflikt into main?", "dialog title");
    assertIncludes(info.text, "Expected conflicts in 1 file", "conflict count");
    assertEqual(await preflightFiles(app), ["werte.txt"], "the conflicting file is listed");
    assertEqual(repo.operation(), null, "nothing started while the dialog is open");
    await shot(t, "preflight-merge-conflict");
    await app.click('[data-action="preflight-run"]');
    await noDialog(app);
    await eventually(() => repo.operation(), "merge", "merge stopped in the conflict (git MERGE_HEAD)");
    await eventually(() => conflictedFiles(repo), ["werte.txt"], "werte.txt is conflicted (git)");
    await waitToast(app, "warning", /conflict/i);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("preflight: cancel starts nothing; a clean merge runs without a dialog", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await drag(app, branchRow("konflikt"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000);
    await chooseMenu(app, /^Merge .konflikt. into .main./);
    await waitPreflight(app);
    await dialogButton(app, "Cancel");
    await noDialog(app);
    await sleep(500);
    assertEqual(repo.operation(), null, "Cancel: no merge started");
    assertEqual(repo.head(), repo.shas.c3, "HEAD unchanged");
    assertEqual(repo.status(), "", "worktree clean");

    // Escape closes it the same way
    await drag(app, branchRow("konflikt"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000);
    await chooseMenu(app, /^Merge .konflikt. into .main./);
    await waitPreflight(app);
    await app.press("Escape");
    await noDialog(app);
    await sleep(300);
    assertEqual(repo.operation(), null, "Esc: no merge started");

    // Clean merge from the palette: no preflight dialog
    await app.press("Control+p");
    const input = await app.waitFor('[role="dialog"] input, [role="combobox"]', 5000, { message: "palette input" });
    await app.type(input, "Merge branch into current");
    await app.press("Enter");
    const pick = await app.waitFor('[role="dialog"] input', 5000, { message: "branch picker" });
    await app.waitFor(async () => /Merge into/.test((await dialogInfo(app))?.title ?? ""), 5000, { message: "pick dialog" });
    await app.type(pick, "feature/luftdruck");
    await app.press("Enter");
    await eventually(() => repo.git("log", "-1", "--format=%P", "main").split(" ").length, 2, "merge done without a dialog (git)");
    assertEqual((await app.$$('[data-screen="preflight"]')).length, 0, "no preflight dialog for a clean merge");
    await waitToast(app, "success", /Merge/);
    await eventually(() => repo.operation(), null, "no operation left running", 5000);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("preflight: cherry-pick of a conflicting commit asks first", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await contextMenu(app, commitCell(repo.shas.k1));
    await chooseMenu(app, /^Cherry-pick onto .main./);
    const info = await waitPreflight(app);
    assertEqual(info.title, "Cherry-pick 1 commit?", "dialog title");
    assertEqual(await preflightFiles(app), ["werte.txt"], "conflicting file listed");
    assert(info.buttons.some((b) => b.text === "Cherry-pick"), `confirm label is the action (${info.buttons.map((b) => b.text).join(", ")})`);
    await shot(t, "preflight-cherry-pick-conflict");
    await app.click('[data-action="preflight-run"]');
    await noDialog(app);
    await eventually(() => repo.operation(), "cherry_pick", "cherry-pick stopped in the conflict (git)");
    await eventually(() => conflictedFiles(repo), ["werte.txt"], "werte.txt conflicted (git)");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("preflight: revert with a conflict asks first, cancel leaves the repository alone", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    repo.write("werte.txt", werte({ 3: "Zeile 3: Messwert 21,04 hPa (nachgemessen)" }));
    repo.shas.c4 = repo.commit("Nachgemessen");
    const { app } = await start(t, repo);
    await contextMenu(app, commitCell(repo.shas.c3));
    await chooseMenu(app, /^Revert/);
    const info = await waitPreflight(app);
    assertEqual(info.title, `Revert commit ${short(repo.shas.c3)}?`, "dialog title names the commit");
    assertEqual(await preflightFiles(app), ["werte.txt"], "conflicting file listed");
    await dialogButton(app, "Cancel");
    await noDialog(app);
    await sleep(400);
    assertEqual(repo.operation(), null, "no revert started");
    assertEqual(repo.head(), repo.shas.c4, "HEAD unchanged");

    await contextMenu(app, commitCell(repo.shas.c3));
    await chooseMenu(app, /^Revert/);
    await waitPreflight(app);
    await app.click('[data-action="preflight-run"]');
    await noDialog(app);
    await eventually(() => repo.operation(), "revert", "revert stopped in the conflict (git)");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("preflight: rebase of a series names the first conflicting commit", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    addSeries(repo);
    const { app } = await start(t, repo);
    await drag(app, branchRow("serie"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000);
    await chooseMenu(app, /^Rebase .serie. onto .main./);
    const info = await waitPreflight(app);
    assertEqual(info.title, "Rebase serie onto main?", "dialog title");
    assertIncludes(info.text, `Commit ${short(repo.shas.s2)} is the first to conflict`, "names the first conflicting commit");
    assertEqual(await preflightFiles(app), ["werte.txt"], "conflicting file listed");
    await shot(t, "preflight-rebase-series");
    await app.click('[data-action="preflight-run"]');
    await noDialog(app);
    await eventually(() => conflictedFiles(repo), ["werte.txt"], "rebase stopped with werte.txt conflicted (git)");
    assertEqual(repo.operation(), "rebase", "rebase is running (git rebase-merge)");
    assert(repo.git("log", "--format=%s", "-1", "HEAD") === "Notiz anlegen", "s1 was applied before the stop");
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("preflight: rebase offers to move dependent branches along", "main", async (t) => {
  const repo = makeBranchRepo();
  try {
    repo.git("branch", "luftdruck-basis", repo.shas.f1);
    const { app } = await start(t, repo);
    await drag(app, branchRow("feature/luftdruck"), branchRow("main"));
    await app.waitFor('[role="menu"]', 5000);
    await chooseMenu(app, /^Rebase .feature\/luftdruck. onto .main./);
    const info = await waitPreflight(app);
    assertIncludes(info.text, "Move dependent branches along", "checkbox offered");
    assertIncludes(info.text, "luftdruck-basis", "the dependent branch is named");
    assert(!info.text.includes("Expected conflicts"), "no conflict expected");
    const box = await app.waitFor('[data-screen="preflight"] [role="checkbox"], [data-screen="preflight"] input[type="checkbox"]');
    assertEqual(await box.attr("aria-checked") ?? String(await box.prop("checked")), "false", "off by default");
    await box.click();
    await app.waitFor(async () => ((await box.attr("aria-checked")) ?? String(await box.prop("checked"))) === "true", 3000, { message: "checkbox on" });
    await shot(t, "preflight-rebase-update-refs");
    await app.click('[data-action="preflight-run"]');
    await noDialog(app);
    await eventually(() => repo.git("merge-base", "feature/luftdruck", "main"), repo.shas.c3, "branch rebased onto main (git)");
    assertEqual(repo.git("merge-base", "luftdruck-basis", "main"), repo.shas.c3, "the dependent branch moved along");
    assertEqual(repo.sha("luftdruck-basis"), repo.sha("feature/luftdruck~1"), "… onto the rebased copy of its commit");
    await eventually(() => repo.operation(), null, "no rebase left running", 5000);
    await noDangerToasts(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("preflight: rebase tool shows expected conflicts inline for several cherry-picks", "edge", async (t) => {
  const repo = makeBranchRepo();
  try {
    const { app } = await start(t, repo);
    await app.click(commitRow(repo.shas.f1));
    await ctrlClick(app, commitCell(repo.shas.k1));
    await contextMenu(app, commitCell(repo.shas.k1));
    await chooseMenu(app, /^Cherry-pick 2 commits/);
    await app.waitFor('[data-screen="rebase"][data-mode="cherry_pick"]', 10_000);
    const note = await app.waitFor('[data-conflict-preview="conflicts"]', 15_000, { message: "inline preview: conflicts" });
    const text = await app.exec((el) => el.innerText, note);
    assertMatch(text, /Conflicts in 1 file/, "count");
    assertIncludes(text, short(repo.shas.k1), "names the commit");
    await app.click('[data-conflict-preview="conflicts"] button');
    await app.waitFor('[data-conflict-preview="conflicts"] ul li', 3000, { message: "file list expands" });
    assertEqual(await app.exec(() => [...document.querySelectorAll('[data-conflict-preview] li')].map((li) => li.innerText.trim())), ["werte.txt"], "file list");
    await shot(t, "preflight-rebase-tool-inline");
    assertEqual(repo.operation(), null, "nothing started yet");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
