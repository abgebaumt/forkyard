/**
 * Worktrees (1.0), submodules add/update/remove (1.0), submodule move and automatic submodule
 * update after checkout (1.1) in the real app over WebDriver, against real Git repositories
 * (submodule sources are local bare repositories). Every result is checked in the UI and in Git.
 *
 *   node scripts/e2e-wd/features/worktrees-submodules.mjs
 *   E2E_WD_ONLY="move" node scripts/e2e-wd/features/worktrees-submodules.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { AssertionError, assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";
import {
  LIBS,
  SUB,
  allowFileProtocol,
  exists,
  git,
  makeAutoUpdateRepo,
  makeSubmoduleRepo,
  modulePaths,
  readGitmodules,
  repoSnapshot,
  staged,
  startSilentServer,
  subStatus,
  worktreeList,
} from "../fixtures/worktrees-submodules.mjs";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slashed = (file) => file.replaceAll("\\", "/");
const samePath = (a, b) => slashed(a).replace(/\/+$/, "") === slashed(b).replace(/\/+$/, "");
const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };

/** UI helpers on top of the driver API (everything goes through the real page). */
function ui(app) {
  const eventually = async (read, expected, message, timeout = 15_000) => {
    let last;
    const ok = (value) => (typeof expected === "function" ? expected(value) : JSON.stringify(value) === JSON.stringify(expected));
    try {
      await app.waitFor(
        async () => {
          last = await read();
          return ok(last);
        },
        timeout,
        { message, interval: 120 },
      );
    } catch {
      throw new AssertionError(`${message}: expected ${typeof expected === "function" ? expected.toString().slice(0, 80) : JSON.stringify(expected)}, last ${JSON.stringify(last)?.slice(0, 400)}`);
    }
    return last;
  };

  const toasts = () => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.dataset.toast, text: el.innerText.replace(/\s+/g, " ").trim() })));
  const waitToast = async (pattern, tone = null, timeout = 30_000) => {
    let seen = [];
    try {
      return await app.waitFor(
        async () => {
          seen = await toasts();
          return seen.find((item) => pattern.test(item.text) && (!tone || item.tone === tone)) ?? null;
        },
        timeout,
        { message: `toast ${pattern}` },
      );
    } catch {
      throw new AssertionError(`toast ${pattern}${tone ? ` (${tone})` : ""} missing; present: ${JSON.stringify(seen)}`);
    }
  };
  const closeToasts = () =>
    app.exec(() => {
      for (const button of document.querySelectorAll('[data-toast] button[aria-label="Close message"]')) button.click();
      return true;
    });

  const dialogTitle = () => app.exec(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1)?.querySelector("h2")?.textContent?.trim() ?? null);
  const dialogCount = () => app.exec(() => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length);
  const waitDialog = (pattern, timeout = 20_000) => eventually(dialogTitle, (title) => title !== null && pattern.test(title), `dialog ${pattern}`, timeout);
  const dialogText = () => app.exec(() => ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1)?.innerText ?? "").replace(/\s+/g, " ").trim());
  /** Button of the topmost dialog with exactly this text. */
  const dialogButton = (text) =>
    app.waitFor(
      () =>
        app.exec((wanted) => {
          const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1);
          return [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.innerText.replace(/\s+/g, " ").trim() === wanted) ?? null;
        }, text),
      10_000,
      { message: `dialog button “${text}”` },
    );
  const clickDialogButton = async (text) => app.click(await dialogButton(text));
  /** Input of the topmost dialog whose <label> has this text. */
  const field = (label) =>
    app.waitFor(
      () =>
        app.exec((wanted) => {
          const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1) ?? document;
          const hit = [...dialog.querySelectorAll("label")].find((item) => item.textContent.replace(/\s+/g, " ").trim() === wanted);
          return hit ? (hit.control ?? (hit.htmlFor ? document.getElementById(hit.htmlFor) : null)) : null;
        }, label),
      10_000,
      { message: `field “${label}”` },
    );
  const value = async (label) => (await field(label)).prop("value");
  /** Sets the value of a React input like typing would (input event through the native setter). */
  const fill = async (label, text) => {
    const el = typeof label === "string" ? await field(label) : label;
    await app.exec(
      (input, next) => {
        input.focus();
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(input, next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      },
      el,
      text,
    );
    return el;
  };
  const alerts = () => app.exec(() => [...([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1)?.querySelectorAll('[role="alert"]') ?? [])].map((el) => el.innerText.replace(/\s+/g, " ").trim()).join(" | "));
  const focusedLabel = () =>
    app.exec(() => {
      const el = document.activeElement;
      return el?.labels?.[0]?.textContent?.trim() ?? el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? null;
    });

  // ---- left panel sections ----------------------------------------------------------------------
  const rows = (id) =>
    app.exec(
      (section) =>
        [...document.querySelectorAll(`[data-extra-section="${section}"] [data-side-row]`)].map((el) => ({
          key: el.dataset.sideRow,
          state: el.dataset.state ?? null,
          text: el.innerText.replace(/\s+/g, " ").trim(),
          label: el.getAttribute("aria-label"),
          main: el.hasAttribute("data-main"),
          current: el.hasAttribute("data-current"),
          locked: el.hasAttribute("data-locked"),
          prunable: el.hasAttribute("data-prunable"),
          changed: el.hasAttribute("data-changed"),
        })),
      id,
    );
  const findRow = async (id, ending) => (await rows(id)).find((row) => slashed(row.key).endsWith(slashed(ending))) ?? null;
  const rowEl = (id, ending) =>
    app.waitFor(
      () => app.exec((section, end) => [...document.querySelectorAll(`[data-extra-section="${section}"] [data-side-row]`)].find((el) => el.dataset.sideRow.replaceAll("\\", "/").endsWith(end)) ?? null, id, slashed(ending)),
      15_000,
      { message: `row ${id} … ${ending}` },
    );
  /** Opens a collapsed section by clicking its header (as a user would). */
  const expand = async (id) => {
    const header = await app.waitFor(`[data-extra-section="${id}"] [data-section-header] button`, 15_000, { message: `header of ${id}` });
    if ((await header.attr("aria-expanded")) === "false") await app.click(header);
    await eventually(() => header.attr("aria-expanded"), "true", `section ${id} expanded`);
  };
  const headerText = (id) => app.exec((section) => document.querySelector(`[data-extra-section="${section}"] [data-section-header] button`)?.innerText.replace(/\s+/g, " ").trim() ?? null, id);
  /** Clicks a button that may only appear on hover (actions in the section header and rows). */
  const jsClick = (selector) =>
    app.exec((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.click();
      return true;
    }, selector);

  // ---- menus -----------------------------------------------------------------------------------
  const contextMenu = async (el) => {
    await app.exec((target) => {
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: box.left + Math.min(box.width / 2, 48), clientY: box.top + box.height / 2 }));
      return true;
    }, el);
    await app.waitFor('[role="menu"]', 10_000, { message: "context menu" });
  };
  const menuItems = () => app.exec(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => ({ text: item.innerText.replace(/\s+/g, " ").trim(), disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true" })));
  const chooseMenu = async (pattern) => {
    const item = await app.waitFor(
      () => app.exec((source) => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((el) => new RegExp(source).test(el.innerText.replace(/\s+/g, " ").trim())) ?? null, pattern.source),
      10_000,
      { message: `menu item ${pattern}` },
    );
    await app.click(item);
    await eventually(() => app.exec(() => document.querySelectorAll('[role="menu"]').length), 0, "menu closed");
  };

  // ---- pointer and keyboard ---------------------------------------------------------------------
  const dblclick = async (el) => {
    await app.webdriver("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", origin: { [ELEMENT_KEY]: el.id }, x: 0, y: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await app.webdriver("DELETE", "/actions").catch(() => undefined);
  };
  const palette = async (text) => {
    await app.exec(() => {
      document.activeElement?.blur?.();
      return true;
    });
    await app.press("Control+p");
    const input = await app.waitFor('input[role="combobox"]', 10_000, { message: "palette input" });
    await app.type(input, text);
    await eventually(() => app.exec(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? ""), (current) => current.toLowerCase().includes(text.toLowerCase()), `palette entry “${text}” selected`);
    await app.press("Enter");
  };
  const tabs = () => app.exec(() => [...document.querySelectorAll('[role="tablist"] [role="tab"]')].filter((tab) => tab.closest("[data-tab-id]")).map((tab) => ({ title: (tab.getAttribute("aria-label") ?? tab.innerText).replace(/[•●]/g, "").replace(/\s+/g, " ").trim(), active: tab.getAttribute("aria-selected") === "true" })));
  const activeTab = async () => (await tabs()).find((tab) => tab.active)?.title ?? null;
  const branchRow = (name) => app.waitFor(`[data-screen="sidebar"] [data-row-id="refs/heads/${name}"]`, 15_000, { message: `branch row ${name}` });
  /** Tells the page the window got focus (sections refetch their lists then). */
  const windowFocus = () => app.exec(() => void window.dispatchEvent(new Event("focus")));

  return {
    eventually,
    toasts,
    waitToast,
    closeToasts,
    dialogTitle,
    dialogCount,
    waitDialog,
    dialogText,
    dialogButton,
    clickDialogButton,
    field,
    value,
    fill,
    alerts,
    focusedLabel,
    rows,
    findRow,
    rowEl,
    headerText,
    expand,
    jsClick,
    contextMenu,
    menuItems,
    chooseMenu,
    dblclick,
    palette,
    tabs,
    activeTab,
    branchRow,
    windowFocus,
  };
}

const W = "worktrees";
const S = "submodules";

// =================================================================================================
// Worktrees (1.0)
// =================================================================================================

function worktreeFixture() {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  const at = (name) => path.join(fx.root, name);
  const listed = () => worktreeList(fx, fx.path);
  const entry = (name) => listed().find((item) => samePath(item.path, at(name))) ?? null;
  const branches = () => git(fx, fx.path, "branch", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean).sort();
  return { fx, at, listed, entry, branches };
}

scenario("Worktree with a new branch is created and opened in a new tab", "main", async (t) => {
  const { fx, at, entry, listed } = worktreeFixture();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.eventually(() => u.headerText(W), "WORKTREES 1", "worktree section with only the main folder");
    const main = await u.findRow(W, "messnetz");
    assert(main?.main && main.current, `main folder marked as main and open (${JSON.stringify(main)})`);

    await u.palette("Create worktree");
    await u.waitDialog(/^Create worktree$/);
    await u.eventually(u.focusedLabel, "Name of the new branch", "focus in the branch name field");
    assertEqual(await u.value("Parent folder"), fx.root, "parent folder suggested next to the main folder");
    await u.fill("Name of the new branch", "feature/karte neu");
    await u.eventually(() => u.value("Name of the new branch"), "feature/karte-neu", "spaces in the branch name become “-”");
    await u.eventually(() => u.value("Folder name"), "messnetz-feature-karte-neu", "folder name follows the branch");
    await u.eventually(async () => (await u.dialogText()).replace(/\s+/g, "").includes(`Willbecreatedin:${at("messnetz-feature-karte-neu")}`.replace(/\s+/g, "")), true, "target folder preview");
    t.step("dialog filled");
    await u.clickDialogButton("Create worktree");
    await u.eventually(u.dialogCount, 0, "dialog closes", 30_000);
    await u.waitToast(/Worktree “messnetz-feature-karte-neu” created and opened/, "success");

    const made = entry("messnetz-feature-karte-neu");
    assertEqual([made?.branch, made?.detached, made?.locked], ["feature/karte-neu", false, false], "git worktree list: new worktree on the new branch");
    assertEqual(git(fx, fx.path, "rev-parse", "feature/karte-neu"), git(fx, fx.path, "rev-parse", "main"), "git: the branch starts at the current commit");
    assert(exists(at("messnetz-feature-karte-neu"), "README.md"), "the new folder is checked out");
    assertEqual(listed().length, 2, "git: two worktrees");

    await u.eventually(u.activeTab, "messnetz-feature-karte-neu", "the worktree is open in a new active tab", 30_000);
    await app.settle();
    await u.eventually(() => u.headerText(W), "WORKTREES 2", "the new tab lists both worktrees");
    const here = await u.findRow(W, "messnetz-feature-karte-neu");
    const mainThere = await u.findRow(W, "/messnetz");
    assert(here?.current && !here.main, `in the new tab the worktree itself is marked as open (${JSON.stringify(here)})`);
    assert(mainThere?.main && !mainThere.current, `main folder marked as main, not open (${JSON.stringify(mainThere)})`);
    await sleep(300);
    await t.shot("worktree-new-branch-new-tab");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Worktree dialog: required fields, taken branch name, occupied folder, Escape", "edge", async (t) => {
  const { fx, at, listed, branches } = worktreeFixture();
  try {
    fs.mkdirSync(at("belegt"));
    fs.writeFileSync(path.join(at("belegt"), "notiz.txt"), "hier liegt schon etwas\n");
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.eventually(() => u.headerText(W), "WORKTREES 1", "worktree section");
    assert(await u.jsClick(`[data-extra-section="${W}"] [data-action="add"]`), "“+” in the section header");
    await u.waitDialog(/^Create worktree$/);
    const before = branches();

    await u.clickDialogButton("Create worktree");
    await u.eventually(u.alerts, (text) => /The new branch needs a name/.test(text), "empty submit: error at the name field");
    await u.fill("Name of the new branch", "main");
    await u.eventually(u.alerts, (text) => /already exists/i.test(text), "taken branch name: reason at the field");
    await u.fill("Name of the new branch", "feature..karte");
    await u.eventually(u.alerts, (text) => text.length > 0 && !/already exists/i.test(text), "invalid branch name: reason at the field");
    await u.fill("Name of the new branch", "feature/karte");
    await u.eventually(u.alerts, "", "valid name: no error");
    await u.fill("Folder name", "../draussen");
    await u.eventually(u.alerts, (text) => text.length > 0, "folder name with a path: reason at the field");
    await u.fill("Folder name", "belegt");
    await u.clickDialogButton("Create worktree");
    await u.eventually(u.alerts, (text) => /Something is already there/.test(text), "occupied folder: the core's refusal at the field", 30_000);
    assertEqual((await u.toasts()).filter((item) => item.tone === "danger"), [], "no error toast for an error at a field");
    await t.shot("worktree-dialog-occupied-folder");
    assertEqual(listed().length, 1, "git: no worktree created");
    assertEqual(branches(), before, "git: no branch left behind");
    assertEqual(fs.readdirSync(at("belegt")), ["notiz.txt"], "the occupied folder is untouched");

    await app.press("Escape");
    await u.eventually(u.dialogCount, 0, "Escape closes the dialog");
    assertEqual(listed().length, 1, "git: still only the main folder");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Worktree from an existing branch without opening; checked-out branches are disabled", "edge", async (t) => {
  const { fx, at, entry } = worktreeFixture();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.palette("Create worktree");
    await u.waitDialog(/^Create worktree$/);
    await app.click({ text: "Existing branch", within: '[role="dialog"]' });
    const select = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[role="dialog"] [role="combobox"]')].find((el) => /feature\/export/.test(el.innerText)) ?? null), 10_000, { message: "branch select with the first free branch" });
    await app.click(select);
    const options = await u.eventually(
      () => app.exec(() => [...document.querySelectorAll('[role="option"]')].map((item) => ({ text: item.textContent.trim(), disabled: item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled") }))),
      (list) => list.length >= 2,
      "options of the branch select",
    ).then((list) => list.map((item) => ({ text: item.text, disabled: item.disabled })));
    assertEqual(options, [{ text: "feature/export", disabled: false }, { text: "main – checked out here", disabled: true }], "the checked-out branch is disabled with a reason");
    await app.press("Escape");
    await u.eventually(() => app.exec(() => document.querySelectorAll('[role="option"]').length), 0, "select closed, dialog stays");
    assertEqual(await u.dialogTitle(), "Create worktree", "Escape only closed the list");
    assertEqual(await u.value("Folder name"), "messnetz-feature-export", "folder name from the branch");
    const checkbox = await app.waitFor(() => app.exec(() => document.querySelector('[role="dialog"] [role="checkbox"]')), 5000, { message: "checkbox" });
    assertEqual(await checkbox.attr("aria-checked"), "true", "“Open in a new tab afterwards” is preselected");
    await app.click(checkbox);
    await u.eventually(() => checkbox.attr("aria-checked"), "false", "checkbox turned off");
    await u.clickDialogButton("Create worktree");
    await u.eventually(u.dialogCount, 0, "dialog closes", 30_000);
    const toast = await u.waitToast(/Worktree “messnetz-feature-export” created$|Worktree “messnetz-feature-export” created Open in new tab/, "success");
    assertIncludes(toast.text, "Open in new tab", "toast offers to open it");
    assertEqual(entry("messnetz-feature-export")?.branch, "feature/export", "git worktree list: worktree on the existing branch");
    assertEqual((await u.tabs()).length, 1, "no new tab was opened");
    await u.eventually(() => u.headerText(W), "WORKTREES 2", "section counts two");
    const row = await u.findRow(W, "messnetz-feature-export");
    assertMatch(row?.text ?? "", /feature\/export/, "the row names the branch");
    assert(exists(at("messnetz-feature-export"), "src", "export.py"), "the branch's files are in the folder");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Worktree is locked with a reason, cannot be removed while locked, and unlocked", "main", async (t) => {
  const { fx, at, entry } = worktreeFixture();
  try {
    git(fx, fx.path, "worktree", "add", "-q", "-b", "pruefung", at("messnetz-pruefung"));
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.eventually(() => u.headerText(W), "WORKTREES 2", "two worktrees");

    await u.contextMenu(await u.rowEl(W, "messnetz-pruefung"));
    await u.chooseMenu(/^Lock/);
    await u.waitDialog(/Lock worktree “messnetz-pruefung”/);
    await u.eventually(u.focusedLabel, "Reason (optional)", "focus in the reason field");
    await app.type(await u.field("Reason (optional)"), "liegt auf der externen Platte");
    await app.press("Enter");
    await u.eventually(u.dialogCount, 0, "Enter locks and closes");
    await u.waitToast(/Worktree “messnetz-pruefung” locked/, "success");
    assertEqual([entry("messnetz-pruefung")?.locked, entry("messnetz-pruefung")?.lockReason], [true, "liegt auf der externen Platte"], "git worktree list: locked with the reason");
    const locked = await u.eventually(() => u.findRow(W, "messnetz-pruefung"), (row) => row?.locked === true, "row marked as locked");
    assertMatch(locked.text, /locked: liegt auf der externen Platte/, "the reason is in the row");
    assert(await app.exec(() => Boolean(document.querySelector('[data-extra-section="worktrees"] [data-locked] [data-flag="locked"]'))), "lock icon in the row");
    await u.closeToasts();
    await sleep(200);
    await t.shot("worktree-locked-with-reason");

    // Locked: Delete is refused with the reason, the menu entry is disabled.
    await app.click(await u.rowEl(W, "messnetz-pruefung"));
    await app.press("Delete");
    await u.waitToast(/“messnetz-pruefung” cannot be removed/, "info");
    assert(entry("messnetz-pruefung") !== null && exists(at("messnetz-pruefung")), "git: the locked worktree is still there");
    await u.contextMenu(await u.rowEl(W, "messnetz-pruefung"));
    const remove = (await u.menuItems()).find((item) => /Remove worktree/.test(item.text));
    assert(remove?.disabled && /unlock it first/.test(remove.text), `menu: “Remove worktree” disabled – unlock it first (${JSON.stringify(remove)})`);
    await app.press("Escape");
    await u.closeToasts();

    await u.contextMenu(await u.rowEl(W, "messnetz-pruefung"));
    await u.chooseMenu(/^Unlock/);
    await u.waitToast(/Worktree “messnetz-pruefung” unlocked/, "success");
    await u.eventually(() => entry("messnetz-pruefung")?.locked, false, "git worktree list: unlocked");
    await u.eventually(async () => (await u.findRow(W, "messnetz-pruefung"))?.locked, false, "row no longer locked");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Worktree removal asks first, cancel keeps it, changes need a second warning", "main", async (t) => {
  const { fx, at, entry, branches } = worktreeFixture();
  try {
    git(fx, fx.path, "worktree", "add", "-q", "-b", "sauber", at("messnetz-sauber"));
    git(fx, fx.path, "worktree", "add", "-q", "-b", "geaendert", at("messnetz-geaendert"));
    fs.writeFileSync(path.join(at("messnetz-geaendert"), "entwurf.md"), "Noch nicht committet.\n");
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.eventually(() => u.headerText(W), "WORKTREES 3", "three worktrees");

    // Clean worktree: Delete key, cancel, then confirm.
    await app.click(await u.rowEl(W, "messnetz-sauber"));
    await app.press("Delete");
    await u.waitDialog(/Remove worktree “messnetz-sauber”\?/);
    const text = await u.dialogText();
    assert(text.includes(at("messnetz-sauber")) && /folder is deleted with its contents/.test(text) && /branch “sauber” and its commits stay/.test(text), `confirmation names the folder and what stays (${text})`);
    await u.clickDialogButton("Cancel");
    await u.eventually(u.dialogCount, 0, "Cancel closes");
    assert(entry("messnetz-sauber") && exists(at("messnetz-sauber")), "Cancel removes nothing");
    await app.click(await u.rowEl(W, "messnetz-sauber"));
    await app.press("Delete");
    await u.waitDialog(/Remove worktree “messnetz-sauber”\?/);
    await u.clickDialogButton("Remove worktree");
    await u.waitToast(/Worktree “messnetz-sauber” removed/, "success", 30_000);
    assertEqual(entry("messnetz-sauber"), null, "git worktree list: entry gone");
    assert(!exists(at("messnetz-sauber")), "folder deleted");
    assert(branches().includes("sauber"), "the branch stays");
    await u.eventually(async () => Boolean(await u.findRow(W, "messnetz-sauber")), false, "row gone");
    await u.closeToasts();

    // Worktree with an untracked file: second warning, cancel, then delete with changes.
    const changed = await u.eventually(() => u.findRow(W, "messnetz-geaendert"), (row) => row?.changed === true, "row with changes is marked");
    assertMatch(changed.text, /changed/, "“changed” as a word");
    await u.contextMenu(await u.rowEl(W, "messnetz-geaendert"));
    await u.chooseMenu(/^Remove worktree/);
    await u.waitDialog(/Remove worktree “messnetz-geaendert”\?/);
    await u.clickDialogButton("Remove worktree");
    await u.waitDialog(/Delete “messnetz-geaendert” with its changes\?/);
    assertMatch(await u.dialogText(), /cannot be recovered/, "the second warning says the changes are lost");
    await t.shot("worktree-remove-with-changes-warning");
    await u.clickDialogButton("Cancel");
    await u.eventually(u.dialogCount, 0, "Cancel closes the warning");
    assert(entry("messnetz-geaendert") && exists(at("messnetz-geaendert"), "entwurf.md"), "after cancel worktree and file are still there");

    await u.contextMenu(await u.rowEl(W, "messnetz-geaendert"));
    await u.chooseMenu(/^Remove worktree/);
    await u.waitDialog(/Remove worktree “messnetz-geaendert”\?/);
    await u.clickDialogButton("Remove worktree");
    await u.waitDialog(/with its changes\?/);
    await u.clickDialogButton("Delete with changes");
    await u.waitToast(/Worktree “messnetz-geaendert” removed/, "success", 30_000);
    assertEqual(entry("messnetz-geaendert"), null, "git: entry gone");
    assert(!exists(at("messnetz-geaendert")), "folder with the change deleted");
    await u.eventually(() => u.headerText(W), "WORKTREES 1", "only the main folder is left");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Orphaned worktree entries are cleaned up after a prompt", "edge", async (t) => {
  const { fx, at, listed } = worktreeFixture();
  try {
    git(fx, fx.path, "worktree", "add", "-q", "-b", "weg", at("messnetz-weg"));
    fs.rmSync(at("messnetz-weg"), { recursive: true, force: true });
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    const orphan = await u.eventually(() => u.findRow(W, "messnetz-weg"), (row) => row?.prunable === true, "orphaned row is marked");
    assertMatch(orphan.text, /folder missing · orphaned/, "the row says the folder is missing");
    assert(listed().find((item) => samePath(item.path, at("messnetz-weg")))?.prunable, "git: the entry is prunable");

    // Opening it explains instead of failing.
    await u.dblclick(await u.rowEl(W, "messnetz-weg"));
    await u.waitToast(/The folder of “messnetz-weg” is missing/, "warning");
    await u.closeToasts();

    assert(await u.jsClick(`[data-extra-section="${W}"] [data-action="prune"]`), "clean-up button in the section header");
    await u.waitDialog(/Clean up orphaned worktree entry\?/);
    assertIncludes(await u.dialogText(), at("messnetz-weg"), "the prompt names the missing folder");
    await u.clickDialogButton("Clean up");
    await u.waitToast(/1 orphaned entry cleaned up/, "success");
    assertEqual(listed().length, 1, "git worktree list: only the main folder");
    assert(git(fx, fx.path, "branch", "--list", "weg").includes("weg"), "the branch stays");
    await u.eventually(() => u.headerText(W), "WORKTREES 1", "section counts one");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

// =================================================================================================
// Submodules (1.0)
// =================================================================================================

scenario("Adding a submodule from a local folder is refused without protocol.file.allow, field checks", "edge", async (t) => {
  const { fx, libs } = makeSubmoduleRepo();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(() => u.headerText(S), "SUBMODULES 4", "four submodules");
    const before = repoSnapshot(fx, fx.path);
    await u.palette("Add submodule");
    await u.waitDialog(/^Add submodule$/);
    await u.eventually(u.focusedLabel, "Address", "focus in the address field");

    await u.clickDialogButton("Add submodule");
    await u.eventually(u.alerts, (text) => /Enter the address of the repository/.test(text), "empty: error at the address");
    await u.fill("Address", "ftp://server.example/bibliothek.git");
    await u.eventually(u.alerts, (text) => /ftp:\/\/” isn't supported/.test(text), "ftp: unsupported protocol");
    await u.fill("Address", libs.extra.path);
    await u.eventually(() => u.value("Folder in the repository"), "wetter-symbole", "folder suggested from the address");
    assertMatch(await u.dialogText(), /protocol\.file\.allow/, "local source: hint at the field");
    for (const [input, pattern] of [
      ["../draussen", /leads out of the repository/],
      [".git/haken", /belongs to Git itself/],
      [LIBS.ready, /already a submodule at this path/],
      [`${LIBS.ready}/unter`, /inside another submodule/],
    ]) {
      await u.fill("Folder in the repository", input);
      await u.eventually(u.alerts, (text) => pattern.test(text), `folder “${input}”: reason at the field`);
    }
    await u.fill("Folder in the repository", "libs/wetter-symbole");
    await u.eventually(u.alerts, "", "valid folder: no error");
    await u.clickDialogButton("Add submodule");
    await u.eventually(() => app.exec(() => document.querySelector("[data-submodule-error]")?.getAttribute("data-submodule-error") ?? null), "not_allowed", "refusal in the dialog", 30_000);
    const refusal = await app.exec(() => document.querySelector("[data-submodule-error]").innerText.replace(/\s+/g, " "));
    assert(/protocol\.file\.allow/.test(refusal) && /Nothing was left behind in the repository/.test(refusal), `the refusal names the setting and that nothing is left behind (${refusal})`);
    await t.shot("submodule-add-refused-local-source");
    assertEqual(repoSnapshot(fx, fx.path), before, "git: .gitmodules and status unchanged");
    assert(!exists(fx.path, "libs", "wetter-symbole") && !exists(fx.path, ".git", "modules", "libs", "wetter-symbole"), "no folder left behind");
    await app.press("Escape");
    await u.eventually(u.dialogCount, 0, "Escape closes");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Submodule is added from a local source and the change is staged", "main", async (t) => {
  const { fx, libs } = makeSubmoduleRepo();
  try {
    const app = await t.launch(LAUNCH);
    allowFileProtocol(app);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(() => u.headerText(S), "SUBMODULES 4", "four submodules");
    assert(await u.jsClick(`[data-extra-section="${S}"] [data-action="add"]`), "“+” in the section header");
    await u.waitDialog(/^Add submodule$/);
    await u.fill("Address", libs.extra.path);
    await u.eventually(() => app.exec(() => document.querySelector("[data-url-kind]")?.getAttribute("data-url-kind")), "local", "the address counts as a local source");
    await u.fill("Folder in the repository", "libs\\wetter-symbole");
    await u.eventually(async () => (await u.dialogText()).replace(/\s+/g, "").includes(`Willbeembeddedat:${path.join(fx.path, "libs", "wetter-symbole")}`), true, "target preview with slashes");
    await u.clickDialogButton("Add submodule");
    await u.eventually(u.dialogCount, 0, "dialog closes after adding", 60_000);
    await u.waitToast(/Submodule “libs\/wetter-symbole” added – the change is staged/, "success");

    const recorded = readGitmodules(fx.path).find((item) => item.path === "libs/wetter-symbole");
    assertEqual(recorded && path.resolve(recorded.url), path.resolve(libs.extra.path), ".gitmodules: path and URL recorded");
    assertEqual(subStatus(fx, fx.path)["libs/wetter-symbole"], { flag: " ", sha: libs.extra.shas[1] }, "git submodule status: at the newest commit of the source");
    assert(exists(fx.path, "libs", "wetter-symbole", "symbole", "sonne.svg"), "the submodule's files are there");
    assertEqual(staged(fx, fx.path), ["M .gitmodules", "A libs/wetter-symbole"], "git: the addition is staged");
    await u.eventually(() => u.headerText(S), "SUBMODULES 5", "five submodules");
    await u.eventually(async () => (await u.findRow(S, "libs/wetter-symbole"))?.state, "initialized", "new row is “initialized”");
    await u.closeToasts();
    await app.exec(() => document.querySelector('[data-extra-section="submodules"]')?.scrollIntoView({ block: "center" }));
    await sleep(300);
    await t.shot("submodule-added");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Adding a submodule from a hanging server shows progress and can be cancelled cleanly", "edge", async (t) => {
  const { fx } = makeSubmoduleRepo();
  const silent = await startSilentServer();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(() => u.headerText(S), "SUBMODULES 4", "four submodules");
    const before = repoSnapshot(fx, fx.path);
    await u.palette("Add submodule");
    await u.waitDialog(/^Add submodule$/);
    const url = silent.url("langsam/kartenmaterial.git");
    await u.fill("Address", url);
    await u.eventually(() => u.value("Folder in the repository"), "kartenmaterial", "folder suggested");
    await u.clickDialogButton("Add submodule");
    await u.eventually(() => app.exec(() => document.querySelector('[data-screen="submodules"]')?.getAttribute("data-state")), "running", "progress is shown");
    await u.eventually(() => silent.connections() > 0, true, "Git connected to the server", 20_000);
    await t.shot("submodule-add-progress");

    await app.press("Escape");
    await u.eventually(u.dialogText, (text) => /still being fetched/.test(text), "Escape while fetching asks first");
    await u.clickDialogButton("Keep fetching");
    await u.eventually(u.dialogText, (text) => !/still being fetched/.test(text), "“Keep fetching” keeps it running");
    await u.clickDialogButton("Cancel fetch");
    await u.eventually(() => app.exec(() => Boolean(document.querySelector("[data-submodule-cancelled]"))), true, "cancelled notice in the dialog", 30_000);
    assertEqual(await u.value("Address"), url, "the inputs are kept");
    assertEqual((await u.toasts()).filter((item) => item.tone === "danger"), [], "a cancel is not an error");
    assertEqual(repoSnapshot(fx, fx.path), before, "git: .gitmodules and status unchanged");
    assert(!exists(fx.path, "kartenmaterial") && !exists(fx.path, ".git", "modules", "kartenmaterial"), "no half folder, nothing under .git/modules");
    await app.press("Escape");
    await u.eventually(u.dialogCount, 0, "Escape closes");
    await t.noConsoleErrors(app);
  } finally {
    await silent.close().catch(() => undefined);
    fx.cleanup();
  }
});

scenario("Submodules are initialized and updated to the recorded commit", "main", async (t) => {
  const { fx, libs } = makeSubmoduleRepo();
  try {
    const app = await t.launch(LAUNCH);
    allowFileProtocol(app);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(
      async () => (await u.rows(S)).map((row) => [row.key, row.state]),
      [
        [LIBS.fresh, "uninitialized"],
        [LIBS.edited, "modified"],
        [LIBS.drifted, "out_of_sync"],
        [LIBS.ready, "initialized"],
      ],
      "four submodules in four states",
    );
    assertMatch((await u.findRow(S, LIBS.drifted)).text, /differs · [0-9a-f]{7} instead of [0-9a-f]{7}/, "differs: checked-out instead of recorded commit");
    await u.eventually(() => app.exec(() => document.querySelector("[data-submodule-hint]")?.innerText.replace(/\s+/g, " ").trim() ?? ""), "1 not fetched yet Initialize", "hint about the unfetched submodule");
    await u.waitToast(/One submodule has not been fetched yet/, "info");
    await u.closeToasts();
    await sleep(200);
    await t.shot("submodule-states");

    assertEqual(subStatus(fx, fx.path)[LIBS.fresh]?.flag, "-", "git: extern/protokoll not initialized");
    await u.contextMenu(await u.rowEl(S, LIBS.fresh));
    assert((await u.menuItems()).find((item) => /Open as repository/.test(item.text))?.disabled, "menu: “Open as repository” blocked while not initialized");
    await u.chooseMenu(/^Initialize/);
    await u.waitToast(/Submodule “extern\/protokoll” is at the recorded commit/, "success", 60_000);
    assertEqual(subStatus(fx, fx.path)[LIBS.fresh], { flag: " ", sha: libs.fresh.shas[0] }, "git: initialized at the recorded commit");
    assert(exists(fx.path, LIBS.fresh, "LIESMICH.md"), "files are there");
    await u.eventually(async () => (await u.findRow(S, LIBS.fresh))?.state, "initialized", "row initialized");
    await u.eventually(() => app.exec(() => document.querySelectorAll("[data-submodule-hint]").length), 0, "hint gone");
    await u.closeToasts();

    assertEqual(subStatus(fx, fx.path)[LIBS.drifted]?.flag, "+", "git: karten-kacheln differs");
    await app.exec((key) => document.querySelector(`[data-side-row="${key}"] [data-action="update"]`)?.click(), LIBS.drifted);
    await u.waitToast(/Submodule “libs\/karten-kacheln” is at the recorded commit/, "success", 60_000);
    assertEqual(subStatus(fx, fx.path)[LIBS.drifted], { flag: " ", sha: libs.drifted.shas[2] }, "git: back at the recorded commit");
    await u.eventually(async () => (await u.findRow(S, LIBS.drifted))?.state, "initialized", "row initialized");
    await u.closeToasts();

    await u.palette("Update all submodules");
    await u.waitToast(/Submodules updated – 1 still differs|4 submodules are at the recorded commit/, "success", 60_000);
    assertEqual(subStatus(fx, fx.path)[LIBS.ready]?.flag, " ", "git: sensor-treiber still in sync");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Updating a submodule with conflicting own changes fails understandably and keeps the changes", "edge", async (t) => {
  const { fx, libs } = makeSubmoduleRepo();
  try {
    const sub = path.join(fx.path, LIBS.ready);
    git(fx, sub, "checkout", "-q", libs.ready.shas[0]);
    fs.writeFileSync(path.join(sub, "LIESMICH.md"), "# sensor-treiber\n\nEigener Entwurf, nicht committet.\n");
    const app = await t.launch(LAUNCH);
    allowFileProtocol(app);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(async () => (await u.findRow(S, LIBS.ready))?.state, (state) => state === "modified" || state === "out_of_sync", "row shows the difference");
    await app.exec((key) => document.querySelector(`[data-side-row="${key}"] [data-action="update"]`)?.click(), LIBS.ready);
    const toast = await u.waitToast(/Update submodule failed/, "danger", 60_000);
    assertMatch(toast.text, /Open the submodule as a repository/, "the message says what to do");
    await t.shot("submodule-update-blocked-by-changes");
    assertIncludes(fs.readFileSync(path.join(sub, "LIESMICH.md"), "utf8"), "Eigener Entwurf", "git: own change untouched");
    assertEqual(git(fx, sub, "rev-parse", "HEAD"), libs.ready.shas[0], "git: nothing checked out in the submodule");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Submodule is removed after confirmation; with own changes only after a second one", "main", async (t) => {
  const { fx } = makeSubmoduleRepo();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(() => u.headerText(S), "SUBMODULES 4", "four submodules");

    await app.click(await u.rowEl(S, LIBS.ready));
    await app.press("Delete");
    await u.waitDialog(/Remove submodule “libs\/sensor-treiber”\?/);
    assertMatch(await u.dialogText(), /taken out of \.gitmodules.*staged/, "the confirmation says what happens");
    await t.shot("submodule-remove-confirmation");
    await u.clickDialogButton("Cancel");
    await u.eventually(u.dialogCount, 0, "Cancel closes");
    assert(modulePaths(fx.path).includes(LIBS.ready) && exists(fx.path, LIBS.ready, "LIESMICH.md"), "Cancel removes nothing");

    await app.click(await u.rowEl(S, LIBS.ready));
    await app.press("Delete");
    await u.waitDialog(/Remove submodule “libs\/sensor-treiber”\?/);
    await u.clickDialogButton("Remove submodule");
    await u.waitToast(/Submodule “libs\/sensor-treiber” removed – the change is staged/, "success", 30_000);
    assert(!modulePaths(fx.path).includes(LIBS.ready), ".gitmodules: entry gone");
    assert(!exists(fx.path, LIBS.ready) && !exists(fx.path, ".git", "modules", "libs", "sensor-treiber"), "folder and .git/modules entry deleted");
    assertIncludes(staged(fx, fx.path), `D ${LIBS.ready}`, "git: removal staged");
    await u.eventually(async () => Boolean(await u.findRow(S, LIBS.ready)), false, "row gone");
    await u.closeToasts();

    // Modified (untracked file in it): second confirmation; cancel keeps everything, then remove anyway.
    await u.contextMenu(await u.rowEl(S, LIBS.edited));
    await u.chooseMenu(/^Remove submodule/);
    await u.waitDialog(/Remove submodule “libs\/auswertung-kern”\?/);
    await u.clickDialogButton("Remove submodule");
    await u.waitDialog(/Remove “libs\/auswertung-kern” including its own changes\?/);
    assertMatch(await u.dialogText(), /cannot be recovered/, "second confirmation says what is lost");
    await u.clickDialogButton("Cancel");
    await u.eventually(u.dialogCount, 0, "Cancel closes");
    assert(modulePaths(fx.path).includes(LIBS.edited) && exists(fx.path, LIBS.edited, "NOTIZ.md"), "after cancel the submodule and the own file are there");
    await u.contextMenu(await u.rowEl(S, LIBS.edited));
    await u.chooseMenu(/^Remove submodule/);
    await u.waitDialog(/Remove submodule “libs\/auswertung-kern”\?/);
    await u.clickDialogButton("Remove submodule");
    await u.waitDialog(/including its own changes\?/);
    await u.clickDialogButton("Remove anyway");
    await u.waitToast(/Submodule “libs\/auswertung-kern” removed/, "success", 30_000);
    assert(!modulePaths(fx.path).includes(LIBS.edited) && !exists(fx.path, LIBS.edited), "git: entry and folder gone");
    await u.eventually(() => u.headerText(S), "SUBMODULES 2", "two submodules left");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Repository without submodules shows the empty state with an add action", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(() => u.headerText(S), "SUBMODULES 0", "header with 0");
    assertEqual(await app.exec(() => document.querySelector('[data-extra-section="submodules"] [data-empty]')?.innerText.replace(/\s+/g, " ").trim() ?? null), "No submodules Add", "empty state with an action");
    await app.click(await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[data-extra-section="submodules"] [data-empty] button')].find((el) => el.innerText.trim() === "Add") ?? null), 5000, { message: "Add button" }));
    await u.waitDialog(/^Add submodule$/);
    await app.press("Escape");
    await u.eventually(u.dialogCount, 0, "Escape closes");
    assertEqual(modulePaths(fx.path), [], "git: no .gitmodules");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

// =================================================================================================
// Submodule move (1.1)
// =================================================================================================

scenario("Submodule is moved to another folder; .gitmodules and index follow", "main", async (t) => {
  const { fx, lib } = makeAutoUpdateRepo();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(async () => (await u.findRow(S, SUB))?.state, "initialized", "submodule initialized");
    await u.contextMenu(await u.rowEl(S, SUB));
    await u.chooseMenu(/^Move …/);
    await u.waitDialog(/Move submodule libs\/sensor-treiber/);
    assertEqual(await u.value("New path in the repository"), SUB, "the current path is prefilled");
    await u.eventually(u.alerts, (text) => /already there/.test(text), "unchanged path: “already there”");
    await u.fill("New path in the repository", "extern/treiber/sensor");
    await u.eventually(u.alerts, "", "new path: no error");
    await t.shot("submodule-move-dialog");
    await u.clickDialogButton("Move");
    await u.waitToast(/Submodule moved to extern\/treiber\/sensor/, "success", 30_000);

    assertEqual(readGitmodules(fx.path).map((item) => item.path), ["extern/treiber/sensor"], ".gitmodules: new path");
    assert(exists(fx.path, "extern", "treiber", "sensor", "LIESMICH.md") && !exists(fx.path, SUB), "the folder moved");
    assertEqual(subStatus(fx, fx.path)["extern/treiber/sensor"], { flag: " ", sha: lib.shas[2] }, "git submodule status: same commit at the new place");
    const changes = staged(fx, fx.path);
    assert(changes.includes("M .gitmodules") && changes.some((line) => /^R\d* libs\/sensor-treiber extern\/treiber\/sensor$/.test(line) || line === "A extern/treiber/sensor"), `git: the move is staged (${changes.join(", ")})`);
    assertEqual(git(fx, path.join(fx.path, "extern", "treiber", "sensor"), "rev-parse", "HEAD"), lib.shas[2], "the moved submodule still works as a repository");
    await u.eventually(async () => (await u.rows(S)).map((row) => [row.key, row.state]), [["extern/treiber/sensor", "initialized"]], "the row shows the new path");
    await u.closeToasts();
    await sleep(200);
    await t.shot("submodule-moved");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Moving a submodule: invalid targets, occupied folder and cancel change nothing", "edge", async (t) => {
  const { fx } = makeAutoUpdateRepo();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(async () => (await u.findRow(S, SUB))?.state, "initialized", "submodule initialized");
    const before = repoSnapshot(fx, fx.path);
    await u.contextMenu(await u.rowEl(S, SUB));
    await u.chooseMenu(/^Move …/);
    await u.waitDialog(/Move submodule/);
    for (const [input, pattern] of [
      ["../draussen", /leads out of the repository/],
      [".git/haken", /belongs to Git itself/],
      ["/tmp/absolut", /no drive and no leading slash/],
      [`${SUB}/innen`, /inside another submodule/],
    ]) {
      await u.fill("New path in the repository", input);
      await u.eventually(u.alerts, (text) => pattern.test(text), `target “${input}”: reason at the field`);
      await u.eventually(async () => (await u.dialogButton("Move")).prop("disabled"), true, `“Move” disabled for “${input}”`);
    }
    await u.clickDialogButton("Cancel");
    await u.eventually(u.dialogCount, 0, "Cancel closes");
    assertEqual(repoSnapshot(fx, fx.path), before, "git: nothing changed after cancel");

    // A folder that already exists (not a submodule): only the core knows – it refuses.
    await u.contextMenu(await u.rowEl(S, SUB));
    await u.chooseMenu(/^Move …/);
    await u.waitDialog(/Move submodule/);
    await u.fill("New path in the repository", "src");
    await u.eventually(u.alerts, "", "the UI cannot know the folder is taken");
    await u.clickDialogButton("Move");
    const toast = await u.waitToast(/Move submodule/, "danger", 30_000);
    t.step(`refusal: ${toast.text}`);
    await t.shot("submodule-move-target-exists");
    assertEqual(repoSnapshot(fx, fx.path), before, "git: .gitmodules and status unchanged");
    assert(exists(fx.path, SUB, "LIESMICH.md") && exists(fx.path, "src", "vergleich.py") && !exists(fx.path, "src", "sensor-treiber"), "both folders untouched");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

// =================================================================================================
// Automatic submodule update (1.1)
// =================================================================================================

/** Double-click on a local branch in the left panel checks it out; waits until Git has switched. */
async function checkoutByDoubleClick(app, u, fx, branch) {
  await u.dblclick(await u.branchRow(branch));
  await u.eventually(() => git(fx, fx.path, "rev-parse", "--abbrev-ref", "HEAD"), branch, `git: ${branch} checked out`, 30_000);
}

scenario("After a checkout the submodule follows the recorded commit; undo brings it back", "main", async (t) => {
  const { fx, lib, sub } = makeAutoUpdateRepo();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(async () => (await u.findRow(S, SUB))?.state, "initialized", "submodule in sync on main");
    assertEqual(git(fx, sub, "rev-parse", "HEAD"), lib.shas[2], "git: submodule at commit 3");

    await checkoutByDoubleClick(app, u, fx, "treiber-alt");
    await u.eventually(() => git(fx, sub, "rev-parse", "HEAD"), lib.shas[0], "git: the submodule followed to commit 1", 30_000);
    assertEqual(subStatus(fx, fx.path)[SUB].flag, " ", "git submodule status: in sync");
    assertIncludes(fs.readFileSync(path.join(sub, "LIESMICH.md"), "utf8"), "Stand 1", "the submodule's files are at commit 1");
    // The row refetches on repo:changed after the follow-up job; wait for the new commit, not just the state.
    await u.eventually(async () => (await u.findRow(S, SUB))?.text ?? "", (text) => text.includes(lib.shas[0].slice(0, 7)), "the row shows the new commit", 15_000);
    await u.eventually(async () => (await u.findRow(S, SUB))?.state, "initialized", "row stays “initialized”");
    assertEqual((await u.toasts()).filter((item) => item.tone === "warning" || item.tone === "danger"), [], "no warning");
    await sleep(300);
    await t.shot("submodule-auto-update-after-checkout");

    // Undo of the checkout: back on main, submodule back at commit 3.
    await u.closeToasts();
    await app.exec(() => {
      document.activeElement?.blur?.();
      return true;
    });
    await app.press("Control+z");
    await u.eventually(() => git(fx, fx.path, "rev-parse", "--abbrev-ref", "HEAD"), "main", "git: undo switched back to main", 30_000);
    await u.eventually(() => git(fx, sub, "rev-parse", "HEAD"), lib.shas[2], "git: the submodule followed back to commit 3", 30_000);
    await u.eventually(async () => (await u.findRow(S, SUB))?.state, "initialized", "row “initialized”");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("Auto-update switched off in project settings: the submodule stays where it is", "edge", async (t) => {
  const { fx, lib, sub } = makeAutoUpdateRepo();
  try {
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    const { repoId } = await app.openRepo(fx.path);
    await u.expand(S);
    assertEqual((await app.invoke("repo_settings_get", { repoId })).submodulesAutoUpdate, true, "core: on by default");

    await app.exec(() => window.__gc.store.getState().openOverlay({ kind: "preferences", section: "repo" }));
    await app.waitFor('[data-screen="settings"]', 10_000, { message: "settings open" });
    await app.click(await app.waitFor('[role="tab"][id$="-trigger-p-git"]', 10_000, { message: "project Git section" }));
    const toggle = await app.waitFor(
      () =>
        app.exec(() => {
          const title = [...document.querySelectorAll('[data-screen="settings"] *')].find((el) => el.childElementCount === 0 && el.textContent.trim() === "Update submodules after checkout and pull");
          let node = title;
          while (node && !node.querySelector('[role="switch"]')) node = node.parentElement;
          return node?.querySelector('[role="switch"]') ?? null;
        }),
      10_000,
      { message: "switch “Update submodules after checkout and pull”" },
    );
    assertEqual(await toggle.attr("aria-checked"), "true", "the switch is on");
    await app.click(toggle);
    await u.eventually(() => toggle.attr("aria-checked"), "false", "switch off");
    await u.eventually(async () => (await app.invoke("repo_settings_get", { repoId })).submodulesAutoUpdate, false, "core: setting saved per repository");
    await t.shot("submodule-auto-update-setting-off");
    await app.press("Escape");
    await u.eventually(() => app.exec(() => Boolean(document.querySelector('[data-screen="settings"]'))), false, "settings closed");

    await checkoutByDoubleClick(app, u, fx, "treiber-alt");
    await sleep(1500);
    assertEqual(git(fx, sub, "rev-parse", "HEAD"), lib.shas[2], "git: the submodule stayed at commit 3");
    assertEqual(subStatus(fx, fx.path)[SUB].flag, "+", "git submodule status: differs");
    await u.windowFocus();
    await u.eventually(async () => (await u.findRow(S, SUB))?.state, "out_of_sync", "row shows “differs”");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("A failed auto-update is a warning; the checkout itself goes through", "edge", async (t) => {
  const { fx, lib, sub } = makeAutoUpdateRepo();
  try {
    fs.writeFileSync(path.join(sub, "LIESMICH.md"), "# sensor-treiber\n\nLokale Kalibrierung, nicht committet.\n");
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await u.eventually(async () => (await u.findRow(S, SUB))?.state, "modified", "submodule with own change");
    await checkoutByDoubleClick(app, u, fx, "treiber-alt");
    const warning = await u.waitToast(/Submodules not updated/, "warning", 30_000);
    assertMatch(warning.text, /Affected: libs\/sensor-treiber/, "the warning names the submodule");
    assertEqual((await u.toasts()).filter((item) => item.tone === "danger"), [], "no error: the checkout succeeded");
    await sleep(200);
    await t.shot("submodule-auto-update-failed-warning");
    assertEqual(git(fx, sub, "rev-parse", "HEAD"), lib.shas[2], "git: the submodule stayed at commit 3");
    assertIncludes(fs.readFileSync(path.join(sub, "LIESMICH.md"), "utf8"), "Lokale Kalibrierung", "git: own change untouched");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("A submodule with a commit on no branch is left alone and named in the warning", "edge", async (t) => {
  const { fx, sub } = makeAutoUpdateRepo();
  try {
    fs.writeFileSync(path.join(sub, "eigen.txt"), "eigener Stand\n");
    git(fx, sub, "add", "eigen.txt");
    git(fx, sub, "commit", "-q", "-m", "Eigener Stand ohne Branch");
    const own = git(fx, sub, "rev-parse", "HEAD");
    assertEqual(git(fx, sub, "for-each-ref", "--contains", own, "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"), "", "precondition: the commit is on no branch");
    const app = await t.launch(LAUNCH);
    const u = ui(app);
    await app.openRepo(fx.path);
    await u.expand(S);
    await checkoutByDoubleClick(app, u, fx, "treiber-alt");
    const warning = await u.waitToast(/Submodules not updated/, "warning", 30_000);
    assertMatch(warning.text, /not on any branch/, "the warning says why");
    assertMatch(warning.text, /libs\/sensor-treiber/, "and names the submodule");
    assertEqual(git(fx, sub, "rev-parse", "HEAD"), own, "git: the own commit stays checked out");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});
