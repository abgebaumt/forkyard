/**
 * Visual and text review: takes fresh screenshots of every screen and state from the real app and
 * automatically checks what can be checked without looking.
 *
 *   node scripts/e2e/flows/visual.mjs                    everything (about 8 minutes, one app instance at a time)
 *   node scripts/e2e/flows/visual.mjs --group Z          one group only (several separated by commas: A,A2,B,C,D,Z)
 *   node scripts/e2e/flows/visual.mjs --only start,settings   only sections whose title contains one of the parts
 *   node scripts/e2e/flows/visual.mjs --list             print the candidates of the automatic check one by one
 *   node scripts/e2e/flows/visual.mjs --show             visible window
 *
 * Groups (each with a fresh app instance):
 *   A   without a repository: repo-management, clone, init, settings, shortcuts, activity-log, command-palette    A2  start without Git
 *   B   rich repository: shell–blame, stash-form, commit-search, terminal, remote-dialog, submodules, network and about 40 dialogs opened from commands
 *   C   empty, detached HEAD, merge conflict (conflict), rebase plan (rebase), singular, very long names, zoom
 *   D   error messages: branches, network, history, hosts – only against local test servers
 *   Z   the reported bugs L4-01 … L4-20, one section each (red until the bug is fixed)
 *
 * Screenshots: target/e2e/shots/visual/<state>-d.png (1440×900 dark), -l.png (1440×900 light), -m.png (960×600 dark).
 * Automatically per screenshot (visual-lib.mjs › auditPage): no horizontal overflow, nothing floating
 * outside the window, no button without a name, no "undefined"/"null"/"NaN"/"[object"; plus
 * candidate lists (cut text, ASCII umlauts, plurals, English leftovers, raw technical output,
 * date formats) that are written to `target/e2e/visual-findings.json`.
 *
 * Red sections carry "BUG L4-xx" in their title: they show a reported bug and stay red until it
 * is fixed.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp, ROOT } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeConflictRepo, makeDetachedRepo, makeEmptyRepo, makeLargeRepo, makeNotARepo, makeRichRepo } from "../fixtures.mjs";
import { createChecks } from "../screens/_wip.mjs";
import { auditPage, CATEGORIES, visibleMessages } from "./visual-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots/visual";
const checks = createChecks("visual");
const { check, equal, eventually, section, finish, failures } = checks;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** All candidates of the automatic check: { shot, category, text }. */
const findings = [];
/** Messages the core or the UI showed for provoked errors: { fall, texte }. */
const messages = [];
const sectionResults = [];

/**
 * Allow list: candidates that are NOT a bug after review (with a reason). Per category, patterns
 * on the candidate's text.
 */
const ALLOW = {
  offscreen: [],
  clipped: [],
  unnamed: [],
  // Patch preview: "--- /dev/null" is content, not app text.
  badText: [/\/dev\/null/],
  cutText: [],
};

const allowed = (category, text) => (ALLOW[category] ?? []).some((pattern) => pattern.test(text));

let app = null;
const repos = [];
const keep = (repo) => {
  repos.push(repo);
  return repo;
};

async function quiet() {
  await app.settle(15_000).catch(() => undefined);
  await app.page.waitForTimeout(250);
}

/** One screenshot plus the automatic check. `variant`: d | l | m. */
async function snap(name, variant, { audit = true } = {}) {
  await quiet();
  const file = `${SHOTS}/${name}-${variant}.png`;
  await app.screenshot(file);
  if (!audit) return;
  const result = await auditPage(app.page);
  const shot = `${name}-${variant}`;
  if (result.overflowX > 0) findings.push({ shot, category: "overflowX", text: `${result.overflowX}px` });
  if (result.lang !== "en") findings.push({ shot, category: "lang", text: `html lang="${result.lang}"` });
  for (const category of CATEGORIES) for (const text of result[category]) findings.push({ shot, category, text });
  // Hard checks: overflow, outside the window, button without a name, undefined/null/NaN/[object.
  check(result.overflowX <= 0, `${shot}: horizontal overflow ${result.overflowX}px`);
  for (const category of ["offscreen", "unnamed", "badText"]) {
    for (const text of result[category]) if (!allowed(category, text)) check(false, `${shot}: ${category}: ${text}`);
  }
}

/**
 * One state in three screenshots. `open` sets it up, `close` cleans up.
 * `inPlace: false`: for the narrow window it is closed, resized and opened again
 * (menus and popovers close when the window size changes).
 */
async function state(name, { open, close, inPlace = true, variants = "dlm" } = {}) {
  if (open) await open();
  if (variants.includes("d")) await snap(name, "d");
  if (variants.includes("l")) {
    await app.setTheme("light");
    await snap(name, "l");
    await app.setTheme("dark");
  }
  if (variants.includes("m")) {
    if (!inPlace) {
      if (close) await close();
      await app.setSize(960, 600);
      if (open) await open();
    } else {
      await app.setSize(960, 600);
    }
    await snap(name, "m");
    if (!inPlace) {
      if (close) await close();
      await app.setSize(1440, 900);
    } else {
      await app.setSize(1440, 900);
      if (close) await close();
    }
  } else if (close) await close();
}

const ui = {
  store: (fn, arg) => app.page.evaluate(new Function("arg", `return (${fn})(window.__gc.store.getState(), arg)`), arg),
  overlay: (overlay) => app.page.evaluate((value) => window.__gc.store.getState().openOverlay(value), overlay),
  closeOverlay: () => app.page.evaluate(() => window.__gc.store.getState().closeOverlay()),
  // Do not wait for the end: a command with a confirmation only ends once the dialog is closed.
  command: (id) => app.page.evaluate((value) => void window.__gcUi.runCommand(value), id),
  /**
   * Like `command`, but first waits until the command is available: after an outside change
   * (git in the test) the UI only knows the new state after the next refresh – an unavailable
   * command would silently do nothing.
   */
  async commandWhenReady(id, timeoutMs = 10_000) {
    await app.page.waitForFunction((value) => window.__gcUi.commands().find((command) => command.id === value)?.available === true, id, { timeout: timeoutMs }).catch(() => undefined);
    const available = await app.page.evaluate((value) => window.__gcUi.commands().find((command) => command.id === value)?.available === true, id);
    check(available, `command ${id} is available`);
    await ui.command(id);
  },
  toasts: () => app.page.locator("[data-toast]").allInnerTexts(),
  async closeToasts() {
    for (let round = 0; round < 12 && (await app.page.locator("[data-toast]").count()) > 0; round++) {
      await app.page.getByRole("button", { name: "Close message" }).first().click({ timeout: 2000 }).catch(() => undefined);
      await app.page.waitForTimeout(120);
    }
  },
  async escape(times = 1) {
    for (let index = 0; index < times; index++) {
      await app.page.keyboard.press("Escape");
      await app.page.waitForTimeout(150);
    }
  },
  dialogs: () => app.page.locator('[role="dialog"], [role="alertdialog"]').evaluateAll((list) => list.map((dialog) => dialog.getAttribute("aria-label") ?? dialog.querySelector("h2")?.textContent ?? "")),
  async closeAll() {
    for (let round = 0; round < 6; round++) {
      const open = await app.page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count();
      if (!open) break;
      await app.page.keyboard.press("Escape");
      await app.page.waitForTimeout(200);
    }
    await ui.closeOverlay().catch(() => undefined);
    await app.page.evaluate(() => window.__gcUi?.closeMenu?.()).catch(() => undefined);
  },
  /** Records what could be read after a provoked misuse. */
  async readMessages(fall) {
    await app.page.waitForTimeout(350);
    const texte = await visibleMessages(app.page);
    messages.push({ fall, texte });
    return texte;
  },
};

const slug = (text) => text.trim().toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Scrolls the largest scrollable area of the open dialog to the end; returns the scroll distance in px. */
const scrollDialogToEnd = () =>
  app.page.evaluate(() => {
    const panel = [...document.querySelectorAll('[role="dialog"] *')]
      .filter((el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY))
      .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
    if (!panel) return 0;
    panel.scrollTop = panel.scrollHeight;
    return panel.scrollHeight - panel.clientHeight;
  });

const run = async (title, body) => {
  const before = failures.length;
  await section(title, body, async () => {
    if (app) await app.screenshot(`target/e2e/visual-failed-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
  });
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
  if (only && !only.some((part) => title.toLowerCase().includes(part.toLowerCase()))) return;
  sectionResults.push({ title, green: failures.length === before });
};

async function start(options = {}) {
  if (app) await app.close().catch(() => undefined);
  app = null;
  // Under load a start occasionally hits the time limit: retry.
  for (let attempt = 0; ; attempt++) {
    try {
      app = await launchApp({ show, timeoutMs: 120_000, ...options });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      console.log(`  (start retried: ${String(error?.message ?? error).split("\n")[0]})`);
      await sleep(3000);
    }
  }
  return app;
}

const groups = {};
const group = (name, body) => {
  groups[name] = body;
};

// =============================================================================================
// Group A: start, repository management, dialogs without a repository, preferences
// =============================================================================================
group("A", async () => {
  await start();
  const { page } = app;

  await run("A01 start – repo-management empty, command list", async () => {
    await state("A01-repo-management-leer");
    const commands = await page.evaluate(() => window.__gcUi.commands());
    fs.mkdirSync(path.join(ROOT, "target/e2e"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "target/e2e/visual-commands.json"), JSON.stringify(commands, null, 2));
    check(commands.length > 50, `command list read (${commands.length})`);
    const noTitle = commands.filter((command) => !command.title || /undefined|null/.test(command.title));
    equal(noTitle, [], "no command without a title");
  });

  const rich = keep(makeRichRepo());
  const clean = keep(makeCleanRepoWithRemote());
  const empty = keep(makeEmptyRepo());
  const longName = keep(makeEmptyRepo({ name: "auswertung-der-niederschlagsmessungen-aller-schulstationen-im-landkreis-2019-bis-2026-archiv" }));
  const gone = keep(makeEmptyRepo({ name: "verschwundenes-projekt" }));
  const plain = keep(makeNotARepo());

  await run("A02 repo-management – filled, selection, filter, menu, missing folder", async () => {
    for (const repo of [rich, clean, empty, longName, gone]) await app.invoke("repo_open", { path: repo.path });
    await app.settle();
    fs.rmSync(gone.path, { recursive: true, force: true });
    // Close all repo tabs so that repository management remains.
    for (let round = 0; round < 8; round++) {
      const tabs = await app.invoke("tabs_list");
      const repoTab = tabs.find((tab) => tab.repoId);
      if (!repoTab) break;
      await app.invoke("tab_close", { tabId: repoTab.id }).catch(() => undefined);
    }
    await app.reload();
    await quiet();
    await state("A02-repo-management-liste");
    const rows = page.locator('[aria-label="Known repositories"] [role="option"]');
    const count = await rows.count();
    check(count >= 5, `five repositories in the list (found ${count})`);
    // A click opens the repository; selection happens through focus (arrow keys).
    const select = async (pattern) => {
      await rows.filter({ hasText: pattern }).first().focus();
      await quiet();
    };
    await select(/^wetterstation/);
    await state("A02-repo-management-readme");
    await select(/^auswertung-der-niederschlags/);
    await state("A02-repo-management-langer-name", { variants: "dm" });
    await select(/^leeres-projekt/);
    await state("A02-repo-management-keine-readme", { variants: "d" });
    // Context menu
    await state("A02-repo-management-menue", {
      inPlace: false,
      variants: "dm",
      open: async () => {
        await rows.filter({ hasText: /^messnetz/ }).first().click({ button: "right" });
        await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
      },
      close: () => ui.escape(),
    });
    await state("A02-repo-management-menue-fehlt", {
      inPlace: false,
      variants: "d",
      open: async () => {
        await rows.filter({ hasText: /^verschwundenes-projekt/ }).first().click({ button: "right" });
        await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
      },
      close: () => ui.escape(),
    });
  });

  await run("A03 repo-management – errors when opening: not a repository, missing path", async () => {
    await app.pick(plain.path);
    await page.keyboard.press("Alt+o");
    await ui.readMessages("Open: folder without a repository");
    await state("A03-oeffnen-kein-repo", { variants: "dm" });
    await ui.closeToasts();
    await ui.closeAll();
    await app.pick(path.join(plain.root, "gibt", "es", "nicht"));
    await page.keyboard.press("Alt+o");
    await ui.readMessages("Open: path missing");
    await state("A03-oeffnen-pfad-fehlt", { variants: "d" });
    await ui.closeToasts();
    await ui.closeAll();
  });

  await run("A04 clone – clone: empty, input errors, advanced, core errors", async () => {
    await ui.command("repo.clone");
    await page.getByRole("dialog", { name: "Clone repository" }).waitFor();
    await state("A04-clone-leer");
    const url = page.getByRole("textbox", { name: /Address|URL/ }).first();
    await url.fill("das ist keine adresse");
    await page.keyboard.press("Tab");
    await state("A04-clone-ungueltig", { variants: "dm" });
    await url.fill("https://git.example.invalid/eine-sehr-lange-gruppe-mit-vielen-untergruppen/noch-eine-ebene/und-noch-eine/projekt-mit-einem-wirklich-sehr-langen-namen-der-kaum-in-das-feld-passt.git");
    await page.getByRole("button", { name: /Advanced options/ }).click().catch(() => undefined);
    await quiet();
    await state("A04-clone-erweitert-lang");
    // Core error: server not reachable (127.0.0.1:9 accepts nothing)
    await url.fill("http://127.0.0.1:9/kein/server.git");
    const target = page.getByRole("textbox", { name: "Target folder" });
    if (await target.count()) await target.fill(path.join(plain.root, "klonziel"));
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await page.waitForTimeout(4000);
    await quiet();
    await ui.readMessages("Clone: server not reachable (http://127.0.0.1:9)");
    await state("A04-clone-fehler-offline", { variants: "dm" });
    // local path that does not exist
    await url.fill(path.join(plain.root, "kein-remote.git"));
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await page.waitForTimeout(2500);
    await quiet();
    await ui.readMessages("Clone: local path missing");
    await state("A04-clone-fehler-pfad", { variants: "d" });
    // target already exists (not empty)
    await url.fill(rich.remotePath);
    if (await target.count()) await target.fill(plain.root);
    const folder = page.getByRole("textbox", { name: "Folder name" });
    if (await folder.count()) await folder.fill("kein-repository");
    await page.waitForTimeout(600);
    await state("A04-clone-ziel-existiert", { variants: "d" });
    await ui.readMessages("Clone: target exists (before the click)");
    await ui.closeAll();
    await ui.closeToasts();
  });

  await run("A05 init – create new: empty, input errors", async () => {
    await ui.command("repo.init");
    await page.getByRole("dialog", { name: "Create new repository" }).waitFor();
    await state("A05-init-leer");
    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("mein projekt: entwurf?");
    await page.keyboard.press("Tab");
    await state("A05-init-ungueltig", { variants: "dm" });
    await name.fill("kein-repository");
    const ort = page.getByRole("textbox", { name: "Location" });
    if (await ort.count()) await ort.fill(plain.root);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);
    await state("A05-init-existiert", { variants: "d" });
    await ui.readMessages("Init: folder exists");
    await ui.closeAll();
  });

  await run("A06 settings – preferences without a repository: all sections", async () => {
    await ui.command("app.preferences");
    const dialog = page.getByRole("dialog").first();
    await dialog.waitFor();
    const tabs = (await dialog.getByRole("tab").allInnerTexts()).map((tab) => tab.trim());
    check(tabs.length >= 12, `preference sections: ${tabs.join(", ")}`);
    for (const [index, tab] of tabs.entries()) {
      await dialog.getByRole("tab", { name: tab, exact: true }).click();
      await quiet();
      const name = `A06-settings-${String(index + 1).padStart(2, "0")}-${slug(tab)}`;
      await state(name, { variants: index % 3 === 0 ? "dlm" : "dm" });
      // Scroll to the end of the section in case it is longer than the window.
      const scrolled = await scrollDialogToEnd();
      if (scrolled > 0) await state(`${name}-unten`, { variants: "d" });
    }
    await ui.closeAll();
  });

  await run("A07 overlays without a repository: keyboard shortcuts, activity log, command palette", async () => {
    await ui.command("app.shortcuts");
    await page.getByRole("dialog").first().waitFor();
    await state("A07-shortcuts-kuerzel");
    await page.getByRole("dialog").first().locator("input").first().fill("zzzz").catch(() => undefined);
    await state("A07-shortcuts-kein-treffer", { variants: "d" });
    await ui.closeAll();
    await ui.command("app.activity");
    await page.getByRole("dialog").first().waitFor();
    await state("A07-activity-log-protokoll");
    await ui.closeAll();
    await ui.command("app.palette");
    await page.getByRole("dialog").first().waitFor();
    await state("A07-command-palette-palette");
    await page.keyboard.type("discard");
    await state("A07-command-palette-palette-verwerfen", { variants: "d" });
    await page.keyboard.press("Control+a");
    await page.keyboard.type("qqqqzzzz");
    await state("A07-command-palette-keine-treffer", { variants: "d" });
    await ui.closeAll();
  });
});

group("A2", async () => {
  // Start without Git: full-page message
  const plain = keep(makeNotARepo());
  await start({ gitPath: path.join(plain.root, "kein-git", "git.exe"), waitForShell: false });
  await run("A08 start without Git", async () => {
    equal(await app.waitForShell(), "fullpage", "full-page message instead of the shell");
    await state("A08-kein-git");
  });
});

/** Context menu on an element: right-click, screenshot(s), Esc. */
async function menuState(name, locator, { variants = "dm", submenu = null, position } = {}) {
  await state(name, {
    inPlace: false,
    variants,
    open: async () => {
      await locator.first().scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.first().click({ button: "right", position });
      await app.page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
      if (submenu) {
        await app.page.getByRole("menuitem", { name: submenu }).first().hover();
        await app.page.waitForTimeout(500);
      }
    },
    close: async () => {
      await ui.escape(submenu ? 2 : 1);
      await app.page.evaluate(() => window.__gcUi?.closeMenu?.());
    },
  });
}

/** A sub-step that does not abort the section when it fails (it is counted as a deviation). */
async function attempt(label, body) {
  try {
    await body();
  } catch (error) {
    check(false, `${label}: not reached – ${String(error?.message ?? error).split("\n")[0]}`);
    await ui.closeAll().catch(() => undefined);
    await app.setTheme("dark").catch(() => undefined);
    await app.setSize(1440, 900).catch(() => undefined);
  }
}

// =============================================================================================
// Group B: repository view with the rich repository
// =============================================================================================
group("B", async () => {
  await start();
  const { page } = app;
  const rich = keep(makeRichRepo());
  const { repoId, tabId } = await app.openRepo(rich.path);
  const left = page.locator('[data-area="left"]');
  const graph = page.locator('[data-screen="commit-graph"]');
  const panel = page.locator('[data-area="right"]');
  const row = (text) => graph.locator("[data-row-id]").filter({ hasText: text }).first();
  const toGraph = async () => {
    await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    await quiet();
  };
  const selectWip = async () => {
    await page.evaluate((id) => window.__gc.store.getState().selectWip(id), tabId);
    await quiet();
  };

  await run("B01 shell – repo view, toolbar menus, tab menu", async () => {
    await state("B01-shell-repo");
    await attempt("pull menu", async () => {
      await state("B01-shell-pull-menue", {
        inPlace: false,
        variants: "dm",
        open: async () => {
          await page.getByRole("button", { name: /^Pull: Option(s|en)$/ }).click();
          await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
        },
        close: () => ui.escape(),
      });
    });
    await attempt("tab menu", () => menuState("B01-shell-tab-menue", page.locator("[data-tab-id]").first(), { variants: "d" }));
    await attempt("status bar", async () => {
      await page.locator("footer").hover();
      await state("B01-shell-statusleiste", { variants: "d" });
    });
  });

  await run("B02 sidebar – left panel: menus per kind, filter", async () => {
    await attempt("branch menu (checked out)", () => menuState("B02-sidebar-menue-branch-main", left.locator("[data-row-id][data-kind]").filter({ hasText: /^main/ }).first(), { variants: "d" }));
    await attempt("branch menu (other)", () => menuState("B02-sidebar-menue-branch-anderer", left.getByText("wind-diagramm", { exact: true }).first(), { variants: "d" }));
    await attempt("remote branch menu", () => menuState("B02-sidebar-menue-remote-branch", left.getByText("temperatur-karte", { exact: true }).first(), { variants: "d" }));
    await attempt("remote menu", () => menuState("B02-sidebar-menue-remote", left.getByText("origin", { exact: true }).first(), { variants: "d" }));
    await attempt("tag menu", () => menuState("B02-sidebar-menue-tag", left.getByText("v0.2.0", { exact: true }).first(), { variants: "d" }));
    await attempt("stash menu", () => menuState("B02-sidebar-menue-stash", left.getByText("Ideen für das README", { exact: true }).first(), { variants: "d" }));
    await attempt("section menu", () => menuState("B02-sidebar-menue-sektion", left.locator("[data-section-header]").first(), { variants: "d" }));
    await attempt("worktree menu", () => menuState("B02-sidebar-menue-worktree", left.locator('[data-side-row]').first(), { variants: "d" }));
    await attempt("filter without results", async () => {
      const filter = left.getByRole("searchbox").first();
      await filter.fill("gibtesnicht");
      await state("B02-sidebar-filter-kein-treffer", { variants: "d" });
      await filter.fill("wind");
      await state("B02-sidebar-filter-treffer", { variants: "d" });
      await filter.fill("");
    });
  });

  await run("B03 commit-graph – graph: menus, multi-selection, column header, search", async () => {
    await attempt("commit menu", () => menuState("B03-commit-graph-menue-commit", row("Windsensor in die Sensorliste"), { variants: "dm", position: { x: 500, y: 10 } }));
    await attempt("commit menu reset", () => menuState("B03-commit-graph-menue-commit-reset", row("Aufbau der Station"), { variants: "d", submenu: /Reset/, position: { x: 500, y: 10 } }));
    await attempt("merge commit menu", () => menuState("B03-commit-graph-menue-merge", row("Merge branch 'bugfix"), { variants: "d", position: { x: 500, y: 10 } }));
    await attempt("WIP menu", () => menuState("B03-commit-graph-menue-wip", row("changed files"), { variants: "d", position: { x: 500, y: 10 } }));
    await attempt("stash row menu", () => menuState("B03-commit-graph-menue-stash", row("Ideen für das README"), { variants: "d", position: { x: 500, y: 10 } }));
    await attempt("ref label menu", () => menuState("B03-commit-graph-menue-label", graph.locator('[data-ref-full="refs/heads/feature/luftdruck"]'), { variants: "d" }));
    await attempt("column header menu", () => menuState("B03-commit-graph-menue-spalten", graph.getByRole("columnheader", { name: /^Author/ }), { variants: "d" }));
    await attempt("multi-selection", async () => {
      await row("Windsensor in die Sensorliste").click({ position: { x: 500, y: 10 } });
      await row("Tests für die Plausibilitätsprüfung").click({ position: { x: 500, y: 10 }, modifiers: ["Control"] });
      await row("Aufbau der Station").click({ position: { x: 500, y: 10 }, modifiers: ["Control"] });
      await state("B03-commit-graph-mehrfach-nicht-kombinierbar", { variants: "dm" });
      await menuState("B03-commit-graph-menue-mehrfach", row("Aufbau der Station"), { variants: "d", position: { x: 500, y: 10 } });
    });
    await attempt("search", async () => {
      await ui.command("view.search");
      await page.keyboard.type("Regen");
      await page.waitForTimeout(800);
      await state("B03-commit-search-suche-treffer", { variants: "dm" });
      await page.keyboard.press("Control+a");
      await page.keyboard.type("gibtesnichtxyz");
      await page.waitForTimeout(800);
      await state("B03-commit-search-suche-keine-treffer", { variants: "d" });
      await page.keyboard.press("Control+a");
      await page.keyboard.type("Jonas");
      await page.waitForTimeout(800);
      await state("B03-commit-search-suche-autor", { variants: "d" });
      await page.evaluate((id) => window.__gc.store.getState().setSearchOpen(id, false), tabId);
    });
    await selectWip();
  });

  await run("B04 commit-details – commit details: normal, long, merge, co-authors, stash, all files", async () => {
    const pick = async (sha) => {
      await page.evaluate(([id, value]) => window.__gc.store.getState().revealCommit(id, value), [tabId, sha]);
      await quiet();
    };
    await pick(rich.info.shas.longSummary);
    await state("B04-commit-details-lange-message");
    await pick(rich.info.shas.coAuthored);
    await state("B04-commit-details-co-autoren", { variants: "dm" });
    await pick(rich.info.shas.secondMerge);
    await state("B04-commit-details-merge", { variants: "d" });
    await pick(rich.info.shas.first);
    await state("B04-commit-details-root", { variants: "d" });
    await pick(rich.info.shas.head);
    await state("B04-commit-details-head", { variants: "dm" });
    await attempt("all files", async () => {
      await panel.getByRole("radio", { name: /All files/ }).or(panel.getByRole("button", { name: /All files/ })).first().click();
      await state("B04-commit-details-alle-dateien", { variants: "d" });
    });
    await attempt("stash details", async () => {
      await page.evaluate((id) => window.__gc.store.getState().selectStash(id, 0), tabId);
      await quiet();
      await state("B04-commit-details-stash", { variants: "dm" });
    });
    await selectWip();
  });

  await run("B05 commit-panel/stash-form – commit panel: states, menus, stash form, input errors", async () => {
    await state("B05-commit-panel-wip");
    await attempt("file menu", () => menuState("B05-commit-panel-menue-datei", panel.locator('[data-row-key="src/auswertung.py"]').first(), { variants: "dm" }));
    await attempt("file menu ignore", () => menuState("B05-commit-panel-menue-datei-ignorieren", panel.locator('[data-row-key="notizen/offene-fragen.md"]').first(), { variants: "d", submenu: /Ignore/ }));
    await attempt("tree view", async () => {
      await panel.getByRole("button", { name: "Show as folder tree" }).click();
      await state("B05-commit-panel-baum", { variants: "dm" });
      await panel.getByRole("button", { name: "Show as flat list" }).click();
    });
    await attempt("commit an empty message", async () => {
      await panel.locator("[data-commit-summary]").focus();
      await page.keyboard.press("Control+Enter");
      await ui.readMessages("Commit: empty message");
      await state("B05-commit-panel-leere-message", { variants: "d" });
    });
    await attempt("very long summary", async () => {
      await panel.locator("[data-commit-summary]").fill("Plausibilitätsprüfung für alle Sensoren eingeführt, damit Ausreißer des Datenloggers bei Frost nicht länger unbemerkt bleiben und die Monatsberichte stimmen");
      await panel.getByRole("textbox", { name: "Description" }).fill("Erste Zeile der Beschreibung.\n\n- Punkt eins\n- Punkt zwei\n- Punkt drei\n- Punkt vier\n- Punkt fünf\n- Punkt sechs\n- Punkt sieben");
      await panel.getByRole("checkbox", { name: /Amend last commit/ }).click();
      await state("B05-commit-panel-lang-amend", { variants: "dm" });
      await panel.getByRole("checkbox", { name: /Amend last commit/ }).click();
      await panel.locator("[data-commit-summary]").fill("");
      await panel.getByRole("textbox", { name: "Description" }).fill("");
    });
    await attempt("stash form", async () => {
      await panel.getByRole("radio", { name: "Stash" }).or(panel.getByRole("tab", { name: "Stash" })).first().click();
      await state("B05-stash-form-stash-maske");
      await panel.getByRole("radio", { name: "Commit" }).or(panel.getByRole("tab", { name: "Commit" })).first().click();
    });
    await attempt("discard all – confirmation", async () => {
      await ui.command("wip.discardAll");
      await page.locator('[role="dialog"], [role="alertdialog"]').first().waitFor({ timeout: 5000 });
      await state("B05-commit-panel-rueckfrage-verwerfen");
      await ui.escape();
    });
  });

  const center = page.locator('[data-area="center"]');
  const openDiff = async (file, source = { kind: "unstaged" }) => {
    await page.evaluate(([id, pathName, from]) => window.__gc.store.getState().openDiff(id, pathName, from), [tabId, file, source]);
    await quiet();
  };

  await run("B06 diff – diff: hunks, whole file, side by side, binary, image, deleted, new, long names", async () => {
    await openDiff(rich.info.multiHunkFile);
    await state("B06-diff-hunks");
    for (const [mode, name] of [["Whole file", "ganze-datei"], ["Side by side", "nebeneinander"]]) {
      await attempt(`view mode ${mode}`, async () => {
        await center.getByRole("radio", { name: mode }).click();
        await state(`B06-diff-${name}`, { variants: "dm" });
      });
    }
    await attempt("back to hunks", () => center.getByRole("radio", { name: "Hunks" }).click());
    await attempt("line menu", () => menuState("B06-diff-menue-zeile", center.locator("[role='row']").nth(4), { variants: "d" }));
    for (const [file, name, source] of [
      [rich.info.binaryFile, "binaer"],
      [rich.info.imageFile, "bild"],
      ["docs/alt-konzept.md", "geloescht"],
      ["notizen/offene-fragen.md", "neu"],
      ["docs/standort.png", "bild-neu"],
      [rich.info.longFile, "langer-name"],
      [rich.info.umlautFile, "umlaut"],
      ["docs/stationsaufbau.md", "umbenannt", { kind: "staged" }],
      ["daten/testlauf.csv", "staged-geloescht", { kind: "staged" }],
    ]) {
      await attempt(`Diff ${name}`, async () => {
        await openDiff(file, source ?? { kind: "unstaged" });
        await state(`B06-diff-${name}`, { variants: name === "langer-name" || name === "bild" ? "dm" : "d" });
      });
    }
    await attempt("diff of a commit", async () => {
      await openDiff("src/pruefung.py", { kind: "commit", sha: rich.info.shas.longSummary });
      await state("B06-diff-commit", { variants: "d" });
    });
    await attempt("diff of a file that does not exist", async () => {
      await openDiff("gibt/es/nicht.txt");
      await ui.readMessages("Diff: file without changes");
      await state("B06-diff-keine-aenderung", { variants: "d" });
    });
    await toGraph();
  });

  await run("B07 file-view/file-history/blame – file, editor, history, blame", async () => {
    const st = (fn, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [fn, args]);
    await attempt("view file", async () => {
      await st("openFile", tabId, "src/auswertung.py", null, "view");
      await state("B07-file-view-ansehen");
    });
    await attempt("edit file", async () => {
      await st("openFile", tabId, "README.md", null, "edit");
      await quiet();
      await state("B07-file-view-bearbeiten", { variants: "dm" });
    });
    await attempt("view binary file", async () => {
      await st("openFile", tabId, "daten/kalibrierung.bin", null, "view");
      await state("B07-file-view-binaer", { variants: "d" });
    });
    await attempt("file missing", async () => {
      await st("openFile", tabId, "gibt/es/nicht.txt", null, "view");
      await ui.readMessages("View file: missing");
      await state("B07-file-view-fehlt", { variants: "d" });
    });
    await attempt("history", async () => {
      await st("openHistory", tabId, "src/auswertung.py");
      await state("B07-file-history-historie");
    });
    await attempt("history of a new file", async () => {
      await st("openHistory", tabId, "notizen/offene-fragen.md");
      await state("B07-file-history-historie-leer", { variants: "d" });
    });
    await attempt("blame", async () => {
      await st("openBlame", tabId, "src/auswertung.py", null);
      await state("B07-blame-blame");
    });
    await attempt("blame of a binary file", async () => {
      await st("openBlame", tabId, "daten/kalibrierung.bin", null);
      await state("B07-blame-blame-binaer", { variants: "d" });
    });
    await toGraph();
  });

  await run("B08 dialogs from commands: branch, tag, remote, submodule, LFS, Gitflow, worktree, patch, file", async () => {
    const dialog = page.locator('[role="dialog"], [role="alertdialog"]').last();
    const viaCommand = async (id, name, { variants = "d", fill } = {}) =>
      attempt(`command ${id}`, async () => {
        await ui.command(id);
        // Some commands act without a dialog (message, form in the panel, inline input): then screenshot that.
        await dialog.waitFor({ timeout: 3000 }).catch(() => undefined);
        await quiet();
        if (fill && (await dialog.count())) await fill();
        await ui.readMessages(`command ${id}`);
        await state(`B08-${name}`, { variants });
        await ui.closeAll();
        await ui.closeToasts();
      });
    await viaCommand("branch.create", "branch-neu", { variants: "dlm" });
    await viaCommand("branch.create", "branch-neu-ungueltig", {
      fill: async () => {
        await dialog.getByRole("textbox").first().fill("mein neuer branch..entwurf");
        await page.waitForTimeout(300);
      },
    });
    await viaCommand("branch.create", "branch-neu-vorhanden", {
      fill: async () => {
        await dialog.getByRole("textbox").first().fill("main");
        await page.waitForTimeout(300);
      },
    });
    await viaCommand("branch.create", "branch-neu-lang", {
      variants: "dm",
      fill: async () => {
        await dialog.getByRole("textbox").first().fill("feature/auswertung-der-niederschlagsmessungen-aller-schulstationen-im-landkreis-fuer-den-jahresbericht-2026");
        await page.waitForTimeout(300);
      },
    });
    await viaCommand("tag.create", "tag-neu");
    await viaCommand("tag.createAnnotated", "tag-annotiert", { variants: "dm" });
    await viaCommand("tag.create", "tag-vorhanden", {
      fill: async () => {
        await dialog.getByRole("textbox").first().fill("v0.1.0");
        await page.waitForTimeout(300);
      },
    });
    await viaCommand("tag.delete", "tag-loeschen");
    await viaCommand("tag.push", "tag-pushen");
    await viaCommand("branch.rename", "branch-umbenennen");
    await viaCommand("branch.delete", "branch-loeschen-auswahl");
    await viaCommand("branch.checkout", "branch-auschecken-auswahl");
    await viaCommand("branch.merge", "branch-mergen-auswahl", { variants: "dm" });
    await viaCommand("branch.rebase", "branch-rebasen-auswahl");
    await viaCommand("branch.setUpstream", "upstream-setzen");
    await viaCommand("remote.add", "remote-dialog-remote-neu", { variants: "dlm" });
    await viaCommand("remote.add", "remote-dialog-remote-ungueltig", {
      fill: async () => {
        const boxes = dialog.getByRole("textbox");
        await boxes.nth(0).fill("mein remote");
        await boxes.nth(1).fill("keine adresse");
        await page.keyboard.press("Tab");
        await page.waitForTimeout(300);
      },
    });
    await viaCommand("remote.edit", "remote-dialog-remote-bearbeiten");
    await viaCommand("remote.remove", "remote-dialog-remote-entfernen");
    await viaCommand("remote.fetchOne", "fetch-von-remote");
    await viaCommand("submodule.add", "submodules-submodul", { variants: "dm" });
    await viaCommand("lfs.manage", "lfs", { variants: "dm" });
    await viaCommand("gitflow.open", "gitflow", { variants: "dm" });
    await viaCommand("gitflow.start.feature", "gitflow-feature");
    await viaCommand("worktree.add", "worktree", { variants: "dm" });
    await viaCommand("worktree.prune", "worktree-aufraeumen");
    await viaCommand("patch.create.wip", "network-patch-erzeugen", { variants: "dm" });
    await viaCommand("patch.apply", "network-patch-anwenden", { variants: "dm" });
    await viaCommand("patch.apply", "network-patch-anwenden-unsinn", {
      fill: async () => {
        await dialog.getByRole("textbox").first().fill("das ist kein patch\nnur text\n");
        await page.waitForTimeout(1200);
        await ui.readMessages("Apply patch: not a patch");
      },
    });
    await viaCommand("file.new", "datei-neu");
    await viaCommand("file.new", "datei-neu-ungueltig", {
      fill: async () => {
        await dialog.getByRole("textbox").first().fill("../ausserhalb/datei?.txt");
        await page.waitForTimeout(300);
      },
    });
    await viaCommand("stash.createNamed", "stash-benannt");
    await viaCommand("stash.rename", "stash-umbenennen");
    await viaCommand("stash.drop", "stash-loeschen");
    await viaCommand("sync.push.force", "push-erzwingen", { variants: "dm" });
    await viaCommand("tab.rename", "tab-umbenennen");
    await viaCommand("repo.forget", "repo-vergessen");
    await viaCommand("palette.files", "command-palette-dateien");
    await viaCommand("palette.branches", "command-palette-branches");
    await viaCommand("pr.pick", "pr-auswahl");
    // Hard reset with a selected commit
    await attempt("hard reset – confirmation", async () => {
      await page.evaluate(([id, sha]) => window.__gc.store.getState().selectCommits(id, [sha]), [tabId, rich.info.shas.secondMerge]);
      await quiet();
      await ui.command("commit.reset.hard");
      await dialog.waitFor({ timeout: 6000 });
      await state("B08-reset-hard", { variants: "dm" });
      await ui.closeAll();
      await ui.command("commit.checkout");
      await dialog.waitFor({ timeout: 6000 });
      await state("B08-commit-auschecken", { variants: "d" });
      await ui.closeAll();
      await ui.command("commit.squash");
      await page.waitForTimeout(800);
      await ui.readMessages("Squash: a single commit selected");
      await state("B08-squash-einer", { variants: "d" });
      await ui.closeAll();
      await ui.closeToasts();
      await selectWip();
    });
  });

  await run("B09 settings – preferences: this repository", async () => {
    await page.evaluate(() => window.__gc.store.getState().openOverlay({ kind: "preferences", section: "repo" }));
    const dialog = page.getByRole("dialog").first();
    await dialog.waitFor();
    await quiet();
    await state("B09-settings-repo");
    for (let step = 1; step <= 6; step++) {
      const moved = await page.evaluate(() => {
        const panel = [...document.querySelectorAll('[role="dialog"] *')]
          .filter((el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY))
          .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
        if (!panel) return false;
        const before = panel.scrollTop;
        panel.scrollTop = before + panel.clientHeight - 60;
        return panel.scrollTop > before;
      });
      if (!moved) break;
      await state(`B09-settings-repo-teil-${step + 1}`, { variants: "d" });
    }
    await ui.closeAll();
  });

  await run("B10 terminal terminal, pr-create/issues without a host account", async () => {
    await attempt("terminal", async () => {
      await ui.command("view.terminal");
      await page.waitForTimeout(2500);
      await state("B10-terminal-terminal", { variants: "dlm" });
      await ui.command("view.terminal");
    });
    await attempt("issues without an account", async () => {
      await page.evaluate((id) => window.__gc.store.getState().setCenter(id, { kind: "issues", number: null }), tabId);
      await state("B10-issues-issues-ohne-konto", { variants: "dm" });
    });
    await attempt("create pull request without an account", async () => {
      await page.evaluate((id) => window.__gc.store.getState().setCenter(id, { kind: "pr_create" }), tabId);
      await state("B10-pr-create-pr-ohne-konto", { variants: "dm" });
    });
    await attempt("view pull request without an account", async () => {
      await page.evaluate((id) => window.__gc.store.getState().setCenter(id, { kind: "pr", number: 7 }), tabId);
      await state("B10-pr-view-pr-ohne-konto", { variants: "d" });
    });
    await toGraph();
  });
});

// =============================================================================================
// Group C: special repositories – empty, detached, conflict, rebase plan, "one of everything"
// (singular), very long names and many entries, zoom 150%
// =============================================================================================
const LONG_BRANCH = "feature/auswertung-der-niederschlagsmessungen-aller-schulstationen-im-landkreis-jahresbericht-2026";
const LONG_TAG = "messreihe-niederschlag-schulstationen-landkreis-2019-bis-2026-bereinigt-und-geprueft-fassung-3";
const LONG_WORD = "Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichenherstellerverbandsvorsitzendenstellvertreterwahlordnung";
const LONG_PATH = "daten/stationen/nord/2026/januar/rohdaten/messwerte-station-nord-januar-2026-rohdaten-unbereinigt.csv";

function makeLongRepo() {
  const repo = makeCleanRepoWithRemote({ name: "messnetz-mit-langem-ordnernamen" });
  const commitAs = (message, name, email) => {
    repo.git("add", "-A");
    repo.git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", message, `--author=${name} <${email}>`);
  };
  repo.write("docs/lang.md", "Lange Namen.\n");
  commitAs(`${LONG_WORD} ohne Leerzeichen in der Zusammenfassung`, "Dr. Maximiliane Alexandra Freifrau von Hohenstein-Wittgenstein zu Sayn", "maximiliane.alexandra.von.hohenstein-wittgenstein@meteorologisches-institut-der-schulstationen.example");
  repo.write(LONG_PATH, "datum;wert\n2026-01-01;1\n");
  commitAs("Rohdaten 🌧️ der Station Nord – مرحبا – 日本語のコミット – Ünïcödé", "山田 太郎", "yamada@example.jp");
  for (let index = 1; index <= 45; index++) repo.git("branch", `thema/zweig-${String(index).padStart(2, "0")}-auswertung`, index % 3 === 0 ? "HEAD~1" : "HEAD");
  repo.git("branch", LONG_BRANCH);
  repo.git("tag", LONG_TAG);
  for (let index = 1; index <= 30; index++) repo.git("tag", `v0.${index}.0`, index % 2 ? "HEAD~1" : "HEAD~2");
  repo.git("remote", "add", "sicherung-auf-dem-schulserver-im-keller-raum-012", "https://git.schulserver.example/eine-sehr-lange-gruppe/mit-untergruppen/und-noch-einer-ebene/messnetz-sicherung.git");
  repo.git("checkout", "-q", LONG_BRANCH);
  // local changes with long paths
  repo.write(LONG_PATH, "datum;wert\n2026-01-01;1\n2026-01-02;2\n");
  repo.write(`notizen/${LONG_WORD}.txt`, "ein Wort\n");
  repo.git("stash", "push", "-q", "--include-untracked", "-m", `${LONG_WORD} als Stash-Name und dahinter noch ein paar Wörter`);
  repo.write(LONG_PATH, "datum;wert\n2026-01-01;1\n2026-01-03;3\n");
  repo.write(`notizen/${LONG_WORD}.txt`, "ein Wort\n");
  return repo;
}

function makeOneOfEachRepo() {
  const repo = makeEmptyRepo({ name: "einzahl", withFile: false });
  repo.write("notiz.txt", "Eine Zeile.\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Einziger Commit");
  repo.git("tag", "v1");
  repo.write("notiz.txt", "Eine Zeile.\nZweite Zeile.\n");
  repo.git("stash", "push", "-q", "-m", "Ein Stash");
  repo.write("notiz.txt", "Eine Zeile.\nNoch eine.\n");
  return repo;
}

group("C", async () => {
  await start();
  const { page } = app;
  const st = (fn, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [fn, args]);
  const panel = page.locator('[data-area="right"]');
  const center = page.locator('[data-area="center"]');

  await run("C01 empty repository (no commit)", async () => {
    const repo = keep(makeEmptyRepo());
    const { tabId } = await app.openRepo(repo.path);
    await state("C01-leer");
    await attempt("toolbar menu/push without a remote", async () => {
      await ui.command("sync.push");
      await ui.readMessages("Push: repository without a commit and without a remote");
      await state("C01-leer-push", { variants: "d" });
      await ui.closeAll();
      await ui.closeToasts();
    });
    await attempt("search in the empty repository", async () => {
      await ui.command("view.search");
      await page.keyboard.type("etwas");
      await page.waitForTimeout(700);
      await state("C01-leer-suche", { variants: "d" });
      await st("setSearchOpen", tabId, false);
    });
  });

  await run("C02 Detached HEAD", async () => {
    const repo = keep(makeDetachedRepo());
    await app.openRepo(repo.path);
    await state("C02-detached");
  });

  await run("C03 merge conflict: commit panel, conflict tool, abort", async () => {
    const repo = keep(makeConflictRepo());
    const { tabId } = await app.openRepo(repo.path);
    await state("C03-konflikt");
    await attempt("conflict menu", () => menuState("C03-konflikt-menue", panel.locator('[data-row-key="src/auswertung.py"]').first(), { variants: "d" }));
    await attempt("conflict tool", async () => {
      await st("openConflict", tabId, "src/auswertung.py");
      await quiet();
      await page.waitForTimeout(800);
      await state("C03-conflict-konflikt-tool");
    });
    await attempt("leave/abort", async () => {
      await st("closeCenter", tabId);
      await quiet();
      await ui.command("operation.abort");
      await page.locator('[role="dialog"], [role="alertdialog"]').first().waitFor({ timeout: 6000 });
      await state("C03-merge-abbrechen", { variants: "dm" });
      await ui.closeAll();
    });
    await attempt("actions that are blocked during the merge", async () => {
      await ui.command("sync.pull");
      await ui.readMessages("Pull during a running merge");
      await state("C03-pull-waehrend-merge", { variants: "d" });
      await ui.closeAll();
      await ui.closeToasts();
    });
  });

  await run("C04 rebase plan (rebase) and squash", async () => {
    const repo = keep(makeRichRepo({ dirty: false }));
    const { tabId } = await app.openRepo(repo.path);
    await attempt("interactive rebase", async () => {
      await st("openRebase", tabId, repo.info.shas.longSummary, "interactive", []);
      await quiet();
      await state("C04-rebase-plan");
    });
    await attempt("squash", async () => {
      await st("selectCommits", tabId, [repo.info.shas.head, repo.info.shas.coAuthored]);
      await ui.command("commit.squash");
      await page.waitForTimeout(1000);
      await state("C04-rebase-squash", { variants: "dm" });
      await ui.readMessages("Squash of two commits (with a gap)");
      await ui.closeAll();
    });
    await st("closeCenter", tabId);
    await ui.closeToasts();
  });

  await run("C05 singular: exactly one of everything", async () => {
    const repo = keep(makeOneOfEachRepo());
    const { tabId } = await app.openRepo(repo.path);
    await state("C05-einzahl");
    await attempt("diff", async () => {
      await st("openDiff", tabId, "notiz.txt", { kind: "unstaged" });
      await state("C05-einzahl-diff", { variants: "d" });
    });
    await attempt("file", async () => {
      await st("openFile", tabId, "notiz.txt", null, "view");
      await state("C05-einzahl-datei", { variants: "d" });
    });
    await attempt("history", async () => {
      await st("openHistory", tabId, "notiz.txt");
      await state("C05-einzahl-historie", { variants: "d" });
    });
    await attempt("blame", async () => {
      await st("openBlame", tabId, "notiz.txt", null);
      await state("C05-einzahl-blame", { variants: "d" });
    });
    await st("closeCenter", tabId);
    await attempt("commit details", async () => {
      const head = repo.git("rev-parse", "HEAD");
      await st("selectCommits", tabId, [head]);
      await state("C05-einzahl-commit", { variants: "d" });
      await st("selectStash", tabId, 0);
      await state("C05-einzahl-stash", { variants: "d" });
      await st("selectWip", tabId);
    });
    await attempt("stage: commit 1 file", async () => {
      await app.invoke("stage_paths", { repoId: (await app.invoke("tabs_list")).find((tab) => tab.isActive).repoId, paths: ["notiz.txt"] }).catch(() => undefined);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await state("C05-einzahl-gestaged", { variants: "d" });
    });
    await attempt("patch from one file", async () => {
      await ui.command("patch.create.wip");
      await page.locator('[role="dialog"]').first().waitFor({ timeout: 6000 });
      await state("C05-einzahl-patch", { variants: "d" });
      await ui.closeAll();
    });
    await attempt("search with one result", async () => {
      await ui.command("view.search");
      await page.keyboard.type("Einziger");
      await page.waitForTimeout(800);
      await state("C05-einzahl-suche", { variants: "d" });
      await st("setSearchOpen", tabId, false);
    });
    await attempt("keyboard shortcuts with one result", async () => {
      await ui.command("app.shortcuts");
      await page.getByRole("dialog").first().waitFor();
      await page.getByRole("dialog").first().locator("input").first().fill("Reset zoom");
      await state("C05-einzahl-kuerzel", { variants: "d" });
      await ui.closeAll();
    });
    await attempt("activity log with one result", async () => {
      await ui.command("app.activity");
      await page.getByRole("dialog").first().waitFor();
      await page.getByRole("dialog").first().locator("input").first().fill("stash list");
      await page.waitForTimeout(600);
      await state("C05-einzahl-protokoll", { variants: "d" });
      await ui.closeAll();
    });
    await attempt("palette with one result", async () => {
      await ui.command("app.palette");
      await page.getByRole("dialog").first().waitFor();
      await page.keyboard.type("Show keyboard shortcuts");
      await state("C05-einzahl-palette", { variants: "d" });
      await ui.closeAll();
    });
  });

  await run("C06 very long names, many entries", async () => {
    const repo = keep(makeLongRepo());
    const { tabId } = await app.openRepo(repo.path);
    const left = page.locator('[data-area="left"]');
    await state("C06-lang");
    await attempt("left panel to the end", async () => {
      await left.locator("[data-left-scroll]").evaluate((el) => (el.scrollTop = el.scrollHeight)).catch(() => undefined);
      await state("C06-lang-leftpanel-unten", { variants: "d" });
      await left.locator("[data-left-scroll]").evaluate((el) => (el.scrollTop = 0)).catch(() => undefined);
    });
    await attempt("branch menu with a long name", () => menuState("C06-lang-menue-branch", left.locator("[data-row-id][data-kind]").filter({ hasText: /auswertung-der-niederschlags/ }).first(), { variants: "d" }));
    await attempt("commit with a long word", async () => {
      const sha = repo.git("rev-parse", "HEAD~1");
      await st("revealCommit", tabId, sha);
      await state("C06-lang-commit-wort", { variants: "dm" });
      await st("revealCommit", tabId, repo.git("rev-parse", "HEAD"));
      await state("C06-lang-commit-unicode", { variants: "d" });
      await st("selectStash", tabId, 0);
      await state("C06-lang-stash", { variants: "d" });
      await st("selectWip", tabId);
    });
    await attempt("diff with a long path", async () => {
      await st("openDiff", tabId, LONG_PATH, { kind: "unstaged" });
      await state("C06-lang-diff", { variants: "dm" });
      await st("openHistory", tabId, LONG_PATH);
      await state("C06-lang-historie", { variants: "d" });
      await st("openBlame", tabId, LONG_PATH, null);
      await state("C06-lang-blame", { variants: "d" });
      await st("openFile", tabId, LONG_PATH, null, "view");
      await state("C06-lang-datei", { variants: "dm" });
      await st("closeCenter", tabId);
    });
    await attempt("dialogs with long names", async () => {
      const dialog = page.locator('[role="dialog"], [role="alertdialog"]').last();
      for (const [id, name] of [["branch.rename", "umbenennen"], ["sync.push", "push-wohin"], ["branch.setUpstream", "upstream"], ["tag.delete", "tag-loeschen"], ["remote.remove", "remote-entfernen"], ["stash.drop", "stash-loeschen"], ["branch.delete", "branch-loeschen"], ["palette.branches", "palette-branches"]]) {
        await ui.command(id);
        await dialog.waitFor({ timeout: 6000 }).catch(() => undefined);
        await quiet();
        await state(`C06-lang-dialog-${name}`, { variants: name === "push-wohin" ? "dm" : "d" });
        await ui.closeAll();
        await ui.closeToasts();
      }
    });
    await attempt("delete branch – confirmation with a long name", async () => {
      // `void`: the action only ends once the confirmation is answered.
      await page.evaluate((id) => void window.__gcUi.actions.branches.deleteBranches(id, ["thema/zweig-01-auswertung", "thema/zweig-02-auswertung", "thema/zweig-04-auswertung"]), (await app.invoke("tabs_list")).find((tab) => tab.isActive).repoId);
      await page.locator('[role="dialog"], [role="alertdialog"]').first().waitFor({ timeout: 6000 });
      await state("C06-lang-rueckfrage-branches-loeschen", { variants: "d" });
      await ui.closeAll();
    });
  });

  await run("C07 zoom 150% and 80% (red because of BUG L4-01: overflow and dialogs at 150% in the minimum window)", async () => {
    const repo = keep(makeRichRepo());
    const { tabId } = await app.openRepo(repo.path);
    const setZoom = async (zoom) => {
      await app.invoke("settings_set", { patch: { zoom } });
      await page.evaluate(() => window.__gc.queryClient.invalidateQueries());
      await quiet();
      await page.waitForFunction((value) => Math.abs(Number(document.documentElement.style.zoom || 1) - value) < 0.01, zoom, { timeout: 5000 }).catch(() => undefined);
    };
    await setZoom(1.5);
    await state("C07-zoom150-repo", { variants: "dm" });
    await attempt("diff at 150%", async () => {
      await st("openDiff", tabId, repo.info.multiHunkFile, { kind: "unstaged" });
      await state("C07-zoom150-diff", { variants: "m" });
      await st("closeCenter", tabId);
    });
    await attempt("commit details at 150%", async () => {
      await st("revealCommit", tabId, repo.info.shas.longSummary);
      await state("C07-zoom150-commit", { variants: "m" });
      await st("selectWip", tabId);
    });
    for (const [id, name] of [["app.preferences", "einstellungen"], ["repo.clone", "klonen"], ["repo.init", "anlegen"], ["app.shortcuts", "kuerzel"], ["app.palette", "palette"], ["app.activity", "protokoll"], ["branch.create", "branch"], ["gitflow.open", "gitflow"], ["worktree.add", "worktree"], ["patch.create.wip", "patch"], ["lfs.manage", "lfs"], ["remote.add", "remote"]]) {
      await attempt(`zoom 150%: ${id}`, async () => {
        await app.setSize(960, 600);
        await ui.command(id);
        await page.locator('[role="dialog"]').first().waitFor({ timeout: 6000 });
        await snap(`C07-zoom150-${name}`, "m");
        await ui.closeAll();
        await app.setSize(1440, 900);
      });
    }
    await attempt("menu at 150%", async () => {
      await app.setSize(960, 600);
      await page.locator('[data-screen="commit-graph"] [data-row-id]').filter({ hasText: "Windsensor" }).first().click({ button: "right", position: { x: 300, y: 10 } });
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
      await snap("C07-zoom150-menue", "m");
      await ui.escape();
      await app.setSize(1440, 900);
    });
    await setZoom(0.8);
    await state("C07-zoom80-repo", { variants: "d" });
    await setZoom(1);
  });
});

// =============================================================================================
// Group D: error messages – provoke as many different ones as possible and read them as a user
// =============================================================================================
group("D", async () => {
  await start();
  const { page } = app;
  const act = (module, fn, ...args) => page.evaluate(([m, f, list]) => void window.__gcUi.actions[m][f](...list), [module, fn, args]);
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').last();
  let shotIndex = 0;
  /** Reads the messages, takes a screenshot, cleans up. */
  const capture = async (fall, { wait = 900, keep: keepOpen = false } = {}) => {
    // Wait up to `wait` + 8 s for a message, a notice or a confirmation.
    const deadline = Date.now() + wait + 8000;
    await page.waitForTimeout(Math.min(wait, 600));
    while (Date.now() < deadline && (await page.locator('[data-toast], [role="alertdialog"], [role="dialog"], [role="alert"]').count()) === 0) await page.waitForTimeout(150);
    await page.waitForTimeout(400);
    await app.settle(20_000).catch(() => undefined);
    const texte = await ui.readMessages(fall);
    const dialogs = await page.locator('[role="dialog"], [role="alertdialog"]').evaluateAll((list) => list.map((el) => (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 600)));
    if (dialogs.length) messages.push({ fall: `${fall} [Dialog]`, texte: dialogs.map((text) => ({ kind: "dialog", text })) });
    shotIndex += 1;
    await snap(`D-${String(shotIndex).padStart(2, "0")}-${slug(fall).slice(0, 48)}`, "d");
    check(texte.length + dialogs.length > 0, `${fall}: a message or confirmation appears`);
    if (!keepOpen) {
      await ui.closeAll();
      await ui.closeToasts();
    }
    return [...texte.map((entry) => entry.text), ...dialogs];
  };

  await run("D01 errors: branches, checkout, stash, commit, lock", async () => {
    const repo = keep(makeCleanRepoWithRemote());
    const { repoId, tabId } = await app.openRepo(repo.path);
    const panel = page.locator('[data-area="right"]');
    const refresh = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await app.settle(15_000).catch(() => undefined);
    };

    await attempt("checkout: untracked file in the way", async () => {
      repo.write("src/export.py", "lokal, nicht verfolgt\n");
      await refresh();
      await act("branches", "checkout", repoId, "feature/export");
      await capture("Checkout: untracked file would be overwritten");
      fs.rmSync(path.join(repo.path, "src/export.py"), { force: true });
    });
    await attempt("checkout: change in the way", async () => {
      repo.git("checkout", "-q", "feature/export");
      repo.write("src/export.py", '"""Geändert auf feature/export."""\n');
      repo.git("commit", "-q", "-am", "Export umgeschrieben");
      repo.git("checkout", "-q", "main");
      repo.git("checkout", "-q", "-b", "thema/kollision");
      repo.write("src/export.py", "anderer Inhalt\n");
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "Kollision vorbereitet");
      repo.write("src/export.py", "anderer Inhalt, lokal geändert\n");
      await refresh();
      await act("branches", "checkout", repoId, "feature/export");
      await capture("Checkout: local change would be overwritten");
      await act("merge", "mergeBranch", repoId, "feature/export");
      await capture("Merge: local change in the way", { wait: 1500 });
      repo.git("checkout", "-q", "--", "src/export.py");
    });
    await attempt("delete branch: not merged", async () => {
      repo.git("checkout", "-q", "main");
      await refresh();
      await act("branches", "deleteBranches", repoId, ["thema/kollision"]);
      await dialog.waitFor({ timeout: 6000 });
      await capture("Delete branch: confirmation", { keep: true });
      await dialog.getByRole("button", { name: /delete/i }).last().click();
      await capture("Delete branch: not merged");
    });
    await attempt("stash pop: change in the way", async () => {
      repo.write("README.md", "# Messnetz\n\nGestashte Fassung.\n");
      repo.git("stash", "push", "-q", "-m", "README umgeschrieben");
      repo.write("README.md", "# Messnetz\n\nLokale Fassung, die dem Stash im Weg ist.\n");
      await refresh();
      await ui.commandWhenReady("stash.pop");
      await capture("Stash pop: local change in the way", { wait: 1500 });
      repo.git("checkout", "-q", "--", "README.md");
      repo.write("README.md", "# Messnetz\n\nCommittete Fassung, die mit dem Stash kollidiert.\n");
      repo.git("commit", "-q", "-am", "README anders umgeschrieben");
      await refresh();
      await ui.commandWhenReady("stash.pop");
      await capture("Stash pop: conflict", { wait: 2000 });
      repo.git("reset", "-q", "--hard");
      repo.git("stash", "drop", "-q");
      await refresh();
    });
    await attempt("commit: nothing staged, empty message", async () => {
      repo.write("NOTIZ.md", "Eine Notiz.\n");
      await refresh();
      await page.evaluate((id) => window.__gc.store.getState().selectWip(id), tabId);
      await panel.locator("[data-commit-summary]").fill("Nur eine Message, nichts gestaged");
      await page.keyboard.press("Control+Enter");
      await capture("Commit: nothing staged");
      await panel.locator("[data-commit-summary]").fill("");
      await page.keyboard.press("Control+Shift+Enter");
      await capture("Commit: empty message (stage all and commit)");
    });
    await attempt("lock: index.lock", async () => {
      fs.writeFileSync(path.join(repo.path, ".git", "index.lock"), "");
      await act("files", "stagePaths", repoId, ["NOTIZ.md"]);
      await capture("Stage: locked by index.lock", { wait: 2500 });
      await panel.locator("[data-commit-summary]").fill("Commit gegen die Sperre");
      await page.keyboard.press("Control+Shift+Enter");
      await capture("Commit: locked by index.lock", { wait: 2500 });
      fs.rmSync(path.join(repo.path, ".git", "index.lock"), { force: true });
      await panel.locator("[data-commit-summary]").fill("");
    });
    await attempt("hook rejects", async () => {
      fs.mkdirSync(path.join(repo.path, ".git", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(repo.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'Stil-Prüfung: Zeile 3 ist zu lang (131 > 120).' >&2\nexit 1\n");
      await refresh();
      await panel.locator("[data-commit-summary]").fill("Commit, den der Hook ablehnt");
      await page.keyboard.press("Control+Shift+Enter");
      await capture("Commit: hook rejects", { wait: 2500 });
      fs.rmSync(path.join(repo.path, ".git", "hooks", "pre-commit"), { force: true });
      await panel.locator("[data-commit-summary]").fill("");
    });
  });

  await run("D02 errors: network – fetch, pull, push, remote, submodule, clone", async () => {
    const repo = keep(makeCleanRepoWithRemote({ name: "messnetz-netz" }));
    const { repoId } = await app.openRepo(repo.path);
    const refresh = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await app.settle(15_000).catch(() => undefined);
    };
    await attempt("push rejected", async () => {
      repo.commitOnRemote({ message: "Kollegin war schneller" });
      repo.write("LOKAL.md", "lokal\n");
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "Lokaler Commit");
      await refresh();
      await ui.command("sync.push");
      await capture("Push: rejected by the remote", { wait: 3000 });
    });
    await attempt("pull with conflict", async () => {
      repo.commitOnRemote({ file: "LOKAL.md", content: "vom Remote\n", message: "Dieselbe Datei im Remote" });
      await ui.command("sync.pull");
      await capture("Pull: conflict", { wait: 4000 });
      repo.git("merge", "--abort");
      await refresh();
    });
    await attempt("remote not reachable", async () => {
      repo.git("remote", "set-url", "origin", "http://127.0.0.1:9/kein/server.git");
      await refresh();
      await ui.command("sync.fetch");
      await capture("Fetch: server not reachable (http://127.0.0.1:9)", { wait: 6000 });
      await ui.command("sync.pull");
      await capture("Pull: server not reachable", { wait: 6000 });
      await ui.command("sync.push");
      await capture("Push: server not reachable", { wait: 6000 });
    });
    await attempt("remote: folder missing", async () => {
      repo.git("remote", "set-url", "origin", path.join(repo.root, "gibt-es-nicht.git"));
      await refresh();
      await ui.command("sync.fetch");
      await capture("Fetch: folder of the remote missing", { wait: 4000 });
    });
    await attempt("remote: unknown host", async () => {
      repo.git("remote", "set-url", "origin", "https://git.gibt-es-nicht.invalid/gruppe/projekt.git");
      await refresh();
      await ui.command("sync.fetch");
      await capture("Fetch: host name cannot be resolved", { wait: 9000 });
    });
    await attempt("add remote: no address", async () => {
      await ui.command("remote.add");
      await dialog.waitFor({ timeout: 6000 });
      const boxes = dialog.getByRole("textbox");
      await boxes.nth(0).fill("zweites");
      await boxes.nth(1).fill("keine adresse");
      await dialog.getByRole("button", { name: "Add remote" }).click();
      await capture("Add remote: \"keine adresse\"", { wait: 4000 });
    });
    await attempt("add submodule: not reachable", async () => {
      await ui.command("submodule.add");
      await dialog.waitFor({ timeout: 6000 });
      await dialog.getByRole("textbox").first().fill("http://127.0.0.1:9/kein/submodul.git");
      await page.waitForTimeout(400);
      await dialog.getByRole("button", { name: "Add submodule" }).click();
      await capture("Add submodule: server not reachable", { wait: 7000 });
    });
    await attempt("clone: errors", async () => {
      const target = fs.mkdtempSync(path.join(repo.root, "klonziel-"));
      const cloneWith = async (url, folder) => {
        await ui.command("repo.clone");
        await page.getByRole("dialog", { name: "Clone repository" }).waitFor();
        await page.getByRole("textbox", { name: /Address/ }).first().fill(url);
        await page.getByRole("textbox", { name: "Target folder" }).fill(target);
        if (folder) await page.getByRole("textbox", { name: "Folder name" }).fill(folder);
        await page.waitForTimeout(300);
        await page.getByRole("button", { name: "Clone", exact: true }).click();
      };
      await cloneWith("http://127.0.0.1:9/kein/server.git");
      await capture("Clone: server not reachable", { wait: 7000 });
      await cloneWith(path.join(repo.root, "kein-remote.git"));
      await capture("Clone: local path missing", { wait: 4000 });
      fs.mkdirSync(path.join(target, "belegt"));
      fs.writeFileSync(path.join(target, "belegt", "datei.txt"), "schon da\n");
      await cloneWith(repo.remotePath, "belegt");
      await capture("Clone: target folder is not empty", { wait: 4000 });
    });
    await attempt("create new: folder is already a repository", async () => {
      await ui.command("repo.init");
      await page.getByRole("dialog", { name: "Create new repository" }).waitFor();
      await page.getByRole("textbox", { name: "Name" }).fill(path.basename(repo.path));
      await page.getByRole("textbox", { name: "Location" }).fill(repo.root);
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Create repository" }).click();
      await capture("Create new: folder is already a repository", { wait: 3000 });
    });
  });

  await run("D03 errors: history – revert of a merge commit, cherry-pick conflict, patch, Gitflow, worktree, file", async () => {
    const repo = keep(makeRichRepo({ dirty: false }));
    const { repoId, tabId } = await app.openRepo(repo.path);
    const refresh = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await app.settle(15_000).catch(() => undefined);
    };
    await attempt("revert of a merge commit", async () => {
      await act("history", "revertCommit", repoId, repo.info.shas.secondMerge, tabId);
      await capture("Revert: merge commit", { wait: 2500 });
    });
    await attempt("cherry-pick with conflict", async () => {
      const windSha = repo.git("rev-parse", "feature/wind-diagramm");
      repo.write("src/diagramm.py", "ganz anderer Inhalt auf main\n");
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "Diagramm auf main anders angelegt");
      await refresh();
      await act("history", "cherryPick", repoId, [windSha], tabId);
      await capture("Cherry-pick: conflict", { wait: 3000 });
      await ui.command("sync.pull");
      await capture("Pull during cherry-pick", { wait: 2500 });
      await ui.command("branch.create");
      await capture("New branch during cherry-pick", { wait: 1200 });
      repo.git("cherry-pick", "--abort");
      await refresh();
    });
    await attempt("patch does not apply", async () => {
      await ui.command("patch.apply");
      await dialog.waitFor({ timeout: 6000 });
      await dialog.getByRole("textbox").first().fill(["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1,3 +1,3 @@", "-# Ganz andere Überschrift", "+# Neue Überschrift", " ", " Text, den es dort nicht gibt.", ""].join("\n"));
      await page.waitForTimeout(1500);
      await dialog.getByRole("button", { name: "Apply" }).click().catch(() => undefined);
      await capture("Apply patch: does not fit the file", { wait: 2500 });
    });
    await attempt("prune worktrees without orphans", async () => {
      await ui.command("worktree.prune");
      await capture("Prune worktrees: nothing orphaned", { wait: 1500 });
    });
    await attempt("file read-only", async () => {
      fs.chmodSync(path.join(repo.path, "README.md"), 0o444);
      await page.evaluate((id) => window.__gc.store.getState().openFile(id, "README.md", null, "edit"), tabId);
      await quiet();
      await page.locator(".cm-content").first().click();
      await page.keyboard.type("Zusatz ");
      await page.keyboard.press("Control+s");
      await capture("Editor: file is read-only", { wait: 2000 });
      fs.chmodSync(path.join(repo.path, "README.md"), 0o666);
      await page.getByRole("button", { name: /^(Back|Close)/ }).first().click().catch(() => undefined);
      await capture("Editor: close with unsaved text", { wait: 800 });
      await page.getByRole("button", { name: /Don’t save|Discard/ }).first().click().catch(() => undefined);
      await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
      await ui.closeAll();
    });
    await attempt("squash/rebase blocked", async () => {
      await page.evaluate(([id, sha]) => window.__gc.store.getState().selectCommits(id, [sha]), [tabId, repo.info.shas.firstMerge]);
      await ui.command("commit.cherryPick");
      await capture("Cherry-pick of a commit that is already contained", { wait: 1500 });
      await page.evaluate((id) => window.__gc.store.getState().closeCenter(id), tabId);
    });
    await attempt("repository damaged", async () => {
      const broken = keep(makeCleanRepoWithRemote({ name: "messnetz-kaputt" }));
      fs.writeFileSync(path.join(broken.path, ".git", "HEAD"), "das ist kein gültiger HEAD\n");
      await app.pick(broken.path);
      await page.keyboard.press("Alt+o");
      await capture("Open: .git/HEAD is damaged", { wait: 3000 });
    });
  });

  await run("D04 errors: host (local test server) – wrong token, no server at the address", async () => {
    const { startHostMock } = await import("../host-mock.mjs");
    const mock = await startHostMock();
    /** Always "Self-hosted" with an address on 127.0.0.1 – github.com is never contacted. */
    const connect = async (address, token) => {
      if (!/^http:\/\/127\.0\.0\.1:/.test(address)) throw new Error("Local test servers only.");
      await page.evaluate(() => window.__gc.store.getState().openOverlay({ kind: "preferences", section: "integrations" }));
      await page.getByRole("dialog").first().waitFor();
      await quiet();
      await page.getByRole("button", { name: "Connect account …" }).first().click();
      const form = page.getByRole("dialog", { name: "Connect host account" });
      await form.waitFor();
      await form.getByRole("radio", { name: "Self-hosted" }).click();
      await page.waitForTimeout(300);
      const inputs = form.locator("input:not([type=hidden])");
      const count = await inputs.count();
      let addressFilled = false;
      for (let index = 0; index < count; index++) {
        const box = inputs.nth(index);
        const hint = `${(await box.getAttribute("aria-label")) ?? ""} ${(await box.getAttribute("placeholder")) ?? ""} ${await box.evaluate((el) => el.labels?.[0]?.textContent ?? "")}`.toLowerCase();
        if ((await box.getAttribute("type")) === "password" || /token/.test(hint)) await box.fill(token);
        else {
          await box.fill(address);
          addressFilled = true;
        }
      }
      if (!addressFilled) throw new Error("No field found for the self-hosted instance address – not connecting.");
      await form.getByRole("button", { name: /^Connect/ }).click();
    };
    try {
      await connect(mock.url, "ghp_FalschesTokenFalschesTokenFalsches0000");
      await capture("Connect host: wrong token", { wait: 3000 });
      await connect("http://127.0.0.1:9", mock.token);
      await capture("Connect host: no server at the address", { wait: 4000 });
    } finally {
      await mock.close();
      await ui.closeAll();
    }
  });
});

// =============================================================================================
// Group Z: the reported bugs, one section each. They are RED until the bug is fixed.
// Screenshots: target/e2e/bugs/<ID>.png
// =============================================================================================
const BUGS = "target/e2e/bugs";
const bugShot = async (id) => {
  await quiet();
  await app.screenshot(`${BUGS}/${id}.png`);
};
/** Visible part of an element (after clipping by ancestors with overflow ≠ visible), evaluated in the page. */
const VISIBLE_RECT = `(el) => {
  const b = el.getBoundingClientRect();
  const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const pr = p.getBoundingClientRect();
    if (s.overflowX !== "visible") { r.left = Math.max(r.left, pr.left); r.right = Math.min(r.right, pr.right); }
    if (s.overflowY !== "visible") { r.top = Math.max(r.top, pr.top); r.bottom = Math.min(r.bottom, pr.bottom); }
  }
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: Math.max(0, r.right - r.left), height: Math.max(0, r.bottom - r.top) };
}`;
/** File rows of the commit panel that visibly reach into the form (summary to description). */
const rowsUnderForm = () =>
  app.page.evaluate((visibleSource) => {
    const visible = new Function(`return ${visibleSource}`)();
    const summary = document.querySelector("[data-commit-summary]");
    const description = document.querySelector('[data-area="right"] [aria-label="Description"]');
    if (!summary || !description) return ["form not found"];
    const top = summary.getBoundingClientRect().top;
    const bottom = description.getBoundingClientRect().bottom;
    const hits = [];
    for (const row of document.querySelectorAll('[data-area="right"] [data-row-key]')) {
      const rect = visible(row);
      const overlap = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
      if (rect.width > 0 && overlap > 3) hits.push(`${row.getAttribute("data-row-key")} (${Math.round(overlap)} px inside the form)`);
    }
    return hits;
  }, VISIBLE_RECT);
const setZoom = async (zoom) => {
  await app.invoke("settings_set", { patch: { zoom } });
  await app.page.evaluate(() => window.__gc.queryClient.invalidateQueries());
  await quiet();
  await app.page.waitForFunction((value) => Math.abs(Number(document.documentElement.style.zoom || 1) - value) < 0.01, zoom, { timeout: 5000 }).catch(() => undefined);
};
const refreshRepo = async () => {
  await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await app.settle(15_000).catch(() => undefined);
};
const toastTexts = async (wait = 1500) => {
  await app.page.waitForTimeout(wait);
  await app.settle(20_000).catch(() => undefined);
  // The title is in the tree twice for screen readers; read the visible part.
  return app.page.locator("[data-toast]").evaluateAll((list) => list.map((toast) => [...toast.querySelectorAll("p, span, div")].filter((el) => el.children.length === 0 && !el.closest(".sr-only") && el.checkVisibility()).map((el) => el.textContent.trim()).filter(Boolean).join(" | ")));
};

group("Z", async () => {
  await start();
  const { page } = app;
  const st = (fn, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [fn, args]);
  const act = (module, fn, ...args) => page.evaluate(([m, f, list]) => void window.__gcUi.actions[m][f](...list), [module, fn, args]);
  const panel = page.locator('[data-area="right"]');
  const left = page.locator('[data-area="left"]');
  const graph = page.locator('[data-screen="commit-graph"]');

  // BUG L4-01
  await run("Z01 BUG L4-01 – zoom 150% in the minimum window 960×600: dialogs larger than the window, toolbar overlaps", async () => {
    const repo = keep(makeRichRepo());
    await app.openRepo(repo.path);
    await app.setSize(960, 600);
    await setZoom(1.5);
    await bugShot("L4-01");
    const toolbar = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[role="toolbar"] button, header button')].filter((el) => el.checkVisibility() && (el.textContent ?? "").trim());
      const out = { spill: [], outside: [] };
      for (const button of buttons) {
        if (button.scrollWidth > button.clientWidth + 1) out.spill.push(`${button.textContent.trim()} (${button.scrollWidth - button.clientWidth} px)`);
        const rect = button.getBoundingClientRect();
        if (rect.right > window.innerWidth + 1 && rect.left < window.innerWidth) out.outside.push(`${button.textContent.trim()} (up to x=${Math.round(rect.right)}, window ${window.innerWidth})`);
      }
      return out;
    });
    equal(toolbar.spill, [], "toolbar: no label sticks out of its button (overlapping the neighbour)");
    equal(toolbar.outside, [], "toolbar: no button sticks out over the window edge");
    equal(await rowsUnderForm(), [], "commit panel: no file row lies under the commit form");
    await ui.command("repo.init");
    await page.getByRole("dialog", { name: "Create new repository" }).waitFor();
    await quiet();
    await bugShot("L4-01-dialog");
    const reach = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const inside = (el) => {
        if (!el) return "missing";
        const r = el.getBoundingClientRect();
        return r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1 ? "in window" : `outside (${Math.round(r.left)},${Math.round(r.top)} – ${Math.round(r.right)},${Math.round(r.bottom)}; window ${window.innerWidth}×${window.innerHeight})`;
      };
      const buttons = [...dialog.querySelectorAll("button")];
      return {
        title: inside(dialog.querySelector("h2")),
        close: inside(buttons.find((button) => button.getAttribute("aria-label") === "Close")),
        create: inside(buttons.find((button) => button.textContent.trim() === "Create repository")),
        cancel: inside(buttons.find((button) => button.textContent.trim() === "Cancel")),
      };
    });
    equal(reach, { title: "in window", close: "in window", create: "in window", cancel: "in window" }, "dialog \"Create new repository\": title and buttons can be reached inside the window");
    await ui.closeAll();
    await setZoom(1);
    await app.setSize(1440, 900);
  });

  // BUG L4-02
  await run("Z02 BUG L4-02 – commit panel at 960×600 with a merge conflict: file list lies under the form", async () => {
    const repo = keep(makeConflictRepo());
    await app.openRepo(repo.path);
    equal(await rowsUnderForm(), [], "at 1440×900: no file row under the form");
    await app.setSize(960, 600);
    await quiet();
    await bugShot("L4-02");
    equal(await rowsUnderForm(), [], "at 960×600: no file row under the form");
    const sections = await page.evaluate(() => [...document.querySelectorAll('[data-area="right"] [data-section-header], [data-area="right"] [data-section] > :first-child')].map((el) => (el.textContent ?? "").trim().slice(0, 24)));
    check(sections.length > 0, `section headers found (${sections.join(" / ")})`);
    await app.setSize(1440, 900);
  });

  // BUG L4-03
  await run("Z03 BUG L4-03 – pull with merge: commit message names \"refs/remotes/origin/main\"", async () => {
    const repo = keep(makeCleanRepoWithRemote({ name: "messnetz-pull" }));
    repo.commitOnRemote({ message: "Kalibrierung nachgetragen" });
    repo.write("NOTIZ.md", "Lokale Notiz.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Lokale Notiz");
    await app.openRepo(repo.path);
    const before = repo.git("rev-parse", "HEAD");
    await ui.command("sync.pull");
    await eventually(() => repo.git("rev-parse", "HEAD") !== before, true, "pull created a merge commit", 20_000);
    await quiet();
    const subject = repo.git("log", "-1", "--format=%s");
    await bugShot("L4-03");
    check(!subject.includes("refs/remotes/"), `git log: merge commit message without a raw ref path (is: ${subject})`);
    equal(subject, "Merge remote-tracking branch 'origin/main'", "git log: message as with a manual git pull");
    await ui.closeToasts();
  });

  // BUG L4-04 and L4-05
  await run("Z04 BUG L4-04 – saving to a read-only file: \"Access denied: access denied (os error 5)\"", async () => {
    const repo = keep(makeRichRepo({ dirty: false }));
    const { tabId } = await app.openRepo(repo.path);
    fs.chmodSync(path.join(repo.path, "README.md"), 0o444);
    try {
      await st("openFile", tabId, "README.md", null, "edit");
      await quiet();
      await page.locator(".cm-content").first().click();
      await page.keyboard.type("Zusatz ");
      await page.keyboard.press("Control+s");
      const texts = (await toastTexts(2000)).join(" || ");
      await bugShot("L4-04");
      check(/save/i.test(texts), `a message about saving appears (${texts})`);
      check(!/os error|\(os |errno/i.test(texts), `no operating system error code in the UI (${texts})`);
      check(!/(access denied).*\1/i.test(texts), `the reason is not shown twice (${texts})`);
    } finally {
      fs.chmodSync(path.join(repo.path, "README.md"), 0o666);
    }
    await ui.closeToasts();
    await page.keyboard.press("Control+z");
    await st("closeCenter", tabId);
    await ui.closeAll();
  });

  await run("Z05 BUG L4-05 – core error messages give the same advice twice", async () => {
    const repo = keep(makeCleanRepoWithRemote({ name: "messnetz-rat" }));
    const { repoId } = await app.openRepo(repo.path);
    repo.git("remote", "set-url", "origin", "http://127.0.0.1:9/kein/server.git");
    await refreshRepo();
    await ui.command("sync.pull");
    const offline = (await toastTexts(6000)).join(" || ");
    await bugShot("L4-05");
    check(/can’t be reached|cannot be reached|not reachable/.test(offline), `pull without a server reports "can’t be reached" (${offline})`);
    check(!(/Please check the network connection/.test(offline) && /Check your network connection/.test(offline)), `pull without a server: the advice "check the network connection" appears only once (${offline})`);
    await ui.closeToasts();
    fs.writeFileSync(path.join(repo.path, ".git", "index.lock"), "");
    try {
      repo.write("NOTIZ.md", "Notiz.\n");
      await refreshRepo();
      await act("files", "stagePaths", repoId, ["NOTIZ.md"]);
      const locked = (await toastTexts(3000)).join(" || ");
      await bugShot("L4-05-sperre");
      check(/[Ll]ock|index\.lock/.test(locked), `staging against the lock reports the lock (${locked})`);
      check(!(/Please wait or close the other program/.test(locked) && /Wait until it is done/.test(locked)), `lock: the advice "wait or close" appears only once (${locked})`);
    } finally {
      fs.rmSync(path.join(repo.path, ".git", "index.lock"), { force: true });
    }
    await ui.closeToasts();
  });

  // BUG L4-06, L4-09, L4-13, L4-14
  await run("Z06 BUG L4-06 – singular: \"1 lines added\" (name of the counters in the diff header)", async () => {
    const repo = keep(makeOneOfEachRepo());
    const { tabId } = await app.openRepo(repo.path);
    await st("openDiff", tabId, "notiz.txt", { kind: "unstaged" });
    await quiet();
    const label = await page.locator("[data-diff-counts]").first().getAttribute("aria-label");
    await bugShot("L4-06");
    check(!/^1 lines\b/.test(label ?? ""), `diff header: counter reads "1 line …" (is: ${label})`);
    await st("closeCenter", tabId);
    const head = repo.git("rev-parse", "HEAD");
    await st("selectCommits", tabId, [head]);
    await quiet();
    const hidden = await panel.locator(".sr-only").allInnerTexts();
    const wrong = hidden.filter((text) => /^1 lines\b/.test(text.trim()));
    equal(wrong, [], "commit details: counters read aloud in the singular");
    await st("selectWip", tabId);
  });

  await run("Z07 BUG L4-09 – tooltip of the stash row in the graph shows Git's raw text \"On main: …\"", async () => {
    const titles = await graph.locator("[data-row-id] span[title]").evaluateAll((list) => list.map((el) => el.getAttribute("title")));
    const raw = titles.filter((title) => /^(On|WIP on) /.test(title ?? ""));
    await graph.locator('span[title^="On "]').first().hover().catch(() => undefined);
    await page.waitForTimeout(900);
    await bugShot("L4-09");
    equal(raw, [], "no tooltip with \"On <branch>: …\"");
  });

  await run("Z08 BUG L4-14 – tooltip of the date column shows the raw ISO timestamp", async () => {
    const titles = await graph.locator('[role="gridcell"][title]').evaluateAll((list) => list.map((el) => el.getAttribute("title")));
    const raw = titles.filter((title) => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(title ?? ""));
    check(titles.length > 0, "date cells with a tooltip found");
    equal(raw.slice(0, 2), [], "no tooltip with \"2026-…T…Z\"");
  });

  await run("Z09 BUG L4-13 – worktree row truncates its details with \"…\" although there is free space next to it", async () => {
    const detail = left.locator("[data-worktree-detail]").first();
    await detail.waitFor();
    const measure = await detail.evaluate((el) => {
      // The row: the nearest ancestor that spans the full width of the panel.
      let row = el.parentElement;
      while (row.parentElement && row.getBoundingClientRect().width < 200) row = row.parentElement;
      const range = document.createRange();
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let nameRight = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (el.contains(node) || !node.nodeValue.trim() || node.parentElement.closest(".sr-only")) continue;
        range.selectNodeContents(node);
        nameRight = Math.max(nameRight, range.getBoundingClientRect().right);
      }
      return { text: el.textContent.trim(), missing: el.scrollWidth - el.clientWidth, free: Math.round(el.getBoundingClientRect().left - nameRight), ellipsis: getComputedStyle(el).textOverflow };
    });
    await bugShot("L4-13");
    check(!(measure.missing > 1 && measure.free >= 24), `"${measure.text}" is not truncated while ${measure.free} px are free to its left (${measure.missing} px missing)`);
  });

  // BUG L4-07
  await run("Z10 BUG L4-07 – menus name keys differently from the shortcut overview and repo-management (raw names like \"Delete\"/\"Escape\")", async () => {
    const repo = keep(makeRichRepo());
    const { tabId } = await app.openRepo(repo.path);
    const kbds = async () => page.locator('[role="menu"] kbd').allInnerTexts();
    const names = new Set();
    const openMenu = async (locator) => {
      await locator.first().click({ button: "right" });
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
      for (const key of await kbds()) names.add(key.trim());
    };
    await openMenu(left.locator("[data-side-row]"));
    await bugShot("L4-07");
    await ui.escape();
    await openMenu(left.getByText("luftdruck", { exact: true }));
    await ui.escape();
    await openMenu(panel.locator('[data-row-key="src/auswertung.py"]'));
    await ui.escape();
    await st("openDiff", tabId, repo.info.multiHunkFile, { kind: "unstaged" });
    await quiet();
    await openMenu(page.locator('[data-area="center"] [role="row"]').nth(4)).catch(() => undefined);
    await ui.escape();
    await st("closeCenter", tabId);
    const english = [...names].filter((name) => ["Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Insert"].includes(name));
    equal(english, [], `menus name keys like the shortcut overview (Del, Space, Esc …); seen: ${[...names].join(", ")}`);
  });

  // BUG L4-08, L4-11, L4-12
  let longRepo = null;
  await run("Z11 BUG L4-08 – stash row in the graph: with a long branch name the stash name disappears", async () => {
    longRepo = keep(makeLongRepo());
    await app.openRepo(longRepo.path);
    const row = graph.locator("[data-row-id]").filter({ hasText: "on feature/auswertung" }).first();
    await row.waitFor();
    const measure = await row.evaluate((el) => {
      const name = el.querySelector("span.truncate[title]");
      const suffix = [...el.querySelectorAll("span")].find((span) => (span.textContent ?? "").startsWith("on "));
      const cell = suffix?.parentElement;
      return {
        name: name ? Math.round(name.getBoundingClientRect().width) : null,
        suffixCut: suffix && cell ? Math.round(suffix.getBoundingClientRect().right - cell.getBoundingClientRect().right) : null,
        suffixEllipsis: suffix ? getComputedStyle(suffix).textOverflow : null,
      };
    });
    await bugShot("L4-08");
    check(measure.name !== null && measure.name >= 40, `the stash name stays readable (width ${measure.name} px)`);
    check(!(measure.suffixCut > 1 && measure.suffixEllipsis !== "ellipsis"), `"on <branch>" is not cut without "…" (sticks out ${measure.suffixCut} px)`);
  });

  await run("Z12 BUG L4-11 – branch menu: the delete entry loses its verb with a long name", async () => {
    await left.locator("[data-row-id][data-kind]").filter({ hasText: /auswertung-der-niederschlags/ }).first().click({ button: "right" });
    await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
    const items = await page.locator('[role="menu"] [role="menuitem"]').evaluateAll((list) =>
      list.map((item) => {
        const label = item.querySelector("span.truncate");
        return { text: (label?.textContent ?? "").trim(), cut: label ? label.scrollWidth - label.clientWidth : 0 };
      }),
    );
    await bugShot("L4-11");
    const del = items.find((item) => /Delete/.test(item.text));
    check(Boolean(del), `delete entry found (${items.map((item) => item.text).join(" | ")})`);
    check(!del || del.cut <= 1, `the entry "${del?.text}" can be read in full (cut: ${del?.cut} px)`);
    await ui.escape();
  });

  await run("Z13 BUG L4-12 – commit details: many branches and tags on the commit push out message and author", async () => {
    const tabId = await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-tab-id]")?.getAttribute("data-tab-id"));
    const sha = longRepo.git("rev-parse", "HEAD~1");
    await st("revealCommit", tabId, sha);
    await quiet();
    const seen = await page.evaluate((visibleSource) => {
      const visible = new Function(`return ${visibleSource}`)();
      const aside = document.querySelector('[data-area="right"]');
      const heading = [...aside.querySelectorAll("h1, h2, h3, p, div")].find((el) => el.children.length === 0 && (el.textContent ?? "").startsWith("Donaudampf"));
      const author = [...aside.querySelectorAll("*")].find((el) => el.children.length === 0 && (el.textContent ?? "").startsWith("Dr. Maximiliane"));
      const chips = aside.querySelectorAll("[data-ref-full], [data-ref-kind]").length;
      return { message: heading ? Math.round(visible(heading).height) : null, author: author ? Math.round(visible(author).height) : null, chips };
    }, VISIBLE_RECT);
    await bugShot("L4-12");
    check(seen.message !== null && seen.message >= 12, `the commit summary is visible without scrolling (visible height ${seen.message} px)`);
    check(seen.author !== null && seen.author >= 10, `the author is visible without scrolling (visible height ${seen.author} px)`);
    await st("selectWip", tabId);
  });

  // BUG L4-16
  await run("Z14 BUG L4-16 – damaged repository: message advises to \"create a new repository there\"", async () => {
    const broken = keep(makeCleanRepoWithRemote({ name: "messnetz-kaputt" }));
    fs.writeFileSync(path.join(broken.path, ".git", "HEAD"), "das ist kein gültiger HEAD\n");
    await app.pick(broken.path);
    await page.keyboard.press("Alt+o");
    const texts = (await toastTexts(3000)).join(" || ");
    await bugShot("L4-16");
    check(texts.length > 0, "a message appears");
    check(!/create a new repository there/.test(texts), `no advice to create a new repository inside the damaged one (${texts})`);
    check(/damaged|corrupt|HEAD/.test(texts), `the message says that the repository is damaged (${texts})`);
    await ui.closeAll();
    await ui.closeToasts();
  });

  // BUG L4-10, L4-15
  await run("Z15 BUG L4-10 / L4-15 – connect host with a wrong token: inconsistent grammatical gender of \"Token\" (German UI); message outside the visible area", async () => {
    const { startHostMock } = await import("../host-mock.mjs");
    const mock = await startHostMock();
    try {
      await app.setSize(960, 600);
      await page.evaluate(() => window.__gc.store.getState().openOverlay({ kind: "preferences", section: "integrations" }));
      await page.getByRole("dialog").first().waitFor();
      await quiet();
      await page.getByRole("button", { name: "Connect account …" }).first().click();
      const form = page.getByRole("dialog", { name: "Connect host account" });
      await form.waitFor();
      await form.getByRole("radio", { name: "Self-hosted" }).click();
      await page.waitForTimeout(300);
      const inputs = form.locator("input:not([type=hidden])");
      const count = await inputs.count();
      let addressFilled = false;
      for (let index = 0; index < count; index++) {
        const box = inputs.nth(index);
        const hint = `${(await box.getAttribute("aria-label")) ?? ""} ${(await box.getAttribute("placeholder")) ?? ""} ${await box.evaluate((el) => el.labels?.[0]?.textContent ?? "")}`.toLowerCase();
        if ((await box.getAttribute("type")) === "password" || /token/.test(hint)) await box.fill("ghp_FalschesTokenFalschesTokenFalsches0000");
        else {
          await box.fill(mock.url);
          addressFilled = true;
        }
      }
      // Without a self-hosted address the request would go to github.com – do not connect then.
      if (!addressFilled) throw new Error("No field found for the self-hosted instance address – not connecting.");
      await form.getByRole("button", { name: /^Connect/ }).click();
      const alert = form.getByRole("alert").first();
      await alert.waitFor({ timeout: 15_000 });
      await quiet();
      check(mock.requests.length > 0, `the request went to the local test server (${mock.requests.length} requests there)`);
      await bugShot("L4-15");
      const text = (await alert.innerText()).replace(/\s+/g, " ");
      const visible = await alert.evaluate((el, source) => new Function(`return ${source}`)()(el), VISIBLE_RECT);
      const full = await alert.evaluate((el) => el.getBoundingClientRect().height);
      check(visible.height >= full - 2, `L4-15: the error message is fully visible after the click (visible ${Math.round(visible.height)} of ${Math.round(full)} px)`);
      const der = /\b(der|den|dem) Token\b/.test(text);
      const das = /\b(das|dieses) Token\b/.test(text);
      check(!(der && das), `L4-10: one message, one grammatical gender for "Token" (German UI only) (${text})`);
    } finally {
      await mock.close();
      await ui.closeAll();
      await app.setSize(1440, 900);
    }
  });

  // BUG L4-17
  await run("Z16 BUG L4-17 – zoom ≠ 100%: context menus open away from the pointer, at 150% to the right outside the window", async () => {
    const repo = keep(makeRichRepo());
    await app.openRepo(repo.path);
    const row = panel.locator('[data-row-key="README.md"]').first();
    const measure = async (zoom) => {
      await setZoom(zoom);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      const point = { x: Math.round(box.x + 40), y: Math.round(box.y + box.height / 2) };
      await page.mouse.click(point.x, point.y, { button: "right" });
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
      await quiet();
      if (zoom === 1.5) await bugShot("L4-17");
      const out = await page.evaluate(() => {
        const menu = document.querySelector('[role="menu"]');
        const r = menu.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: window.innerWidth, height: window.innerHeight };
      });
      await ui.escape();
      return { zoom, point, ...out };
    };
    const normal = await measure(1);
    check(normal.right <= normal.width + 1 && normal.left >= 0, `at 100% the menu lies inside the window (${JSON.stringify(normal)})`);
    for (const zoom of [1.25, 1.5]) {
      const seen = await measure(zoom);
      check(seen.left <= seen.width && seen.right <= seen.width + 1 && seen.bottom <= seen.height + 1, `at ${zoom * 100}% the menu lies fully inside the window (${JSON.stringify(seen)})`);
      // "At the pointer": the pointer lies on an edge of the menu – the menu opens to its right when there is room,
      // otherwise (near the right window edge; with zoom the menu is up to 600 px wide) it flips left and ends at the pointer.
      check(seen.left <= seen.point.x + 12 && seen.right >= seen.point.x - 12, `at ${zoom * 100}% the menu opens at the pointer (pointer x=${seen.point.x}, menu from x=${seen.left} to x=${seen.right})`);
    }
    await setZoom(1);
  });

  // BUG L4-18
  await run("Z17 BUG L4-18 – ahead/behind: left panel shows \"↓1 ↑2\", the status bar \"↑2 ↓1\"", async () => {
    // The rich repository: main is 2 ahead and 1 behind. The order of the numbers gives the order of the indicators.
    const name = (digit) => (digit === "2" ? "ahead" : digit === "1" ? "behind" : "?");
    const order = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-area="left"] [data-row-id][data-kind]')].find((el) => /^main\s*\d/.test((el.innerText ?? "").trim()));
      const footer = document.querySelector("footer");
      const labelled = [...(footer?.querySelectorAll("[aria-label]") ?? [])].filter((el) => /commits? (ahead|behind)$/.test(el.getAttribute("aria-label") ?? ""));
      return {
        leftPanel: ((row?.innerText ?? "").match(/\d+/g) ?? []).join(","),
        statusBar: labelled.map((el) => (el.textContent ?? "").trim()).join(","),
      };
    });
    const seen = { leftPanel: order.leftPanel.split(",").map(name).join(","), statusBar: order.statusBar.split(",").map(name).join(",") };
    await bugShot("L4-18");
    check(/ahead/.test(seen.leftPanel) && /behind/.test(seen.leftPanel) && /ahead/.test(seen.statusBar) && /behind/.test(seen.statusBar), `both indicators found (${JSON.stringify(order)})`);
    equal(seen.leftPanel, seen.statusBar, "the same order of ahead and behind in both places");
  });

  // BUG L4-19
  await run("Z18 BUG L4-19 – \"Zoom in\" shows the shortcut \"Ctrl =\", the preferences say \"Ctrl and Plus\"", async () => {
    await ui.command("app.palette");
    await page.getByRole("dialog").first().waitFor();
    await page.keyboard.type("Zoom in");
    await quiet();
    const keys = await page.locator('[role="dialog"] [role="option"]').filter({ hasText: "Zoom in" }).first().locator("kbd").allInnerTexts();
    await bugShot("L4-19");
    await ui.closeAll();
    check(keys.length > 0, "shortcut for \"Zoom in\" is shown in the command palette");
    check(!keys.includes("="), `the shortcut is named as described in the preferences (Ctrl and +), not after the US keyboard (is: ${keys.join(" ")})`);
  });

  // BUG L4-20
  await run("Z19 BUG L4-20 – ligatures of the code font: \"--\" in commands (activity log) and patches looks like a dash", async () => {
    /** Elements in the code font whose text contains "--" and whose ligatures are not switched off. */
    const withLigatures = () =>
      page.evaluate(() => {
        const out = [];
        const walker = document.createTreeWalker(document.querySelector('[role="dialog"]') ?? document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!/--\S/.test(node.nodeValue ?? "")) continue;
          const el = node.parentElement;
          const style = getComputedStyle(el);
          if (!/mono|consol|courier/i.test(style.fontFamily)) continue;
          const off = style.fontVariantLigatures === "none" || /"(liga|calt)" 0/.test(style.fontFeatureSettings);
          if (!off) out.push(`${node.nodeValue.trim().slice(0, 50)} (font-variant-ligatures: ${style.fontVariantLigatures})`);
        }
        return out.slice(0, 3);
      });
    await ui.command("app.activity");
    await page.getByRole("dialog").first().waitFor();
    await quiet();
    await bugShot("L4-20");
    equal(await withLigatures(), [], "activity log: commands with \"--\" are shown without ligatures");
    await ui.closeAll();
    await ui.command("patch.create.wip");
    await page.getByRole("dialog").first().waitFor();
    await quiet();
    await scrollDialogToEnd();
    await bugShot("L4-20-patch");
    equal(await withLigatures(), [], "patch preview: \"diff --git\" and \"---\" are shown without ligatures");
    await ui.closeAll();
  });
});

// =============================================================================================
const wanted = process.argv.includes("--group") ? process.argv[process.argv.indexOf("--group") + 1].split(",") : Object.keys(groups);
try {
  for (const name of wanted) {
    if (!groups[name]) throw new Error(`group ${name} does not exist (${Object.keys(groups).join(", ")}).`);
    try {
      await groups[name]();
      if (app) equal(app.consoleErrors, [], `group ${name}: console errors`);
    } catch (error) {
      check(false, `group ${name} aborted: ${error?.stack ?? error}`);
    }
  }
} finally {
  if (app) await app.close().catch(() => undefined);
  for (const repo of repos) repo.cleanup();
}

// --- Evaluation ------------------------------------------------------------------------------
fs.mkdirSync(path.join(ROOT, "target/e2e"), { recursive: true });
const findingsFile = path.join(ROOT, "target/e2e", `visual-findings${wanted.length === Object.keys(groups).length ? "" : `-${wanted.join("")}`}.json`);
fs.writeFileSync(findingsFile, JSON.stringify({ findings, messages }, null, 2));
const byCategory = new Map();
for (const finding of findings) {
  // Drop coordinates: the same candidate in three screenshots counts once.
  const key = finding.text.replace(/@\{[^}]*\}/g, "").replace(/visible up to \{[^}]*\}/g, "").replace(/window \d+×\d+/g, "").replace(/\d+/g, "#");
  const list = byCategory.get(finding.category) ?? new Map();
  const entry = list.get(key) ?? { shots: [], sample: finding.text };
  entry.shots.push(finding.shot);
  list.set(key, entry);
  byCategory.set(finding.category, list);
}
console.log("\nCandidates of the automatic check (for review, not all are bugs):");
for (const [category, list] of byCategory) {
  console.log(`  ${category}: ${list.size}`);
  if (process.argv.includes("--list")) for (const [, entry] of list) console.log(`    - ${entry.sample}   [${entry.shots.slice(0, 4).join(", ")}${entry.shots.length > 4 ? ` +${entry.shots.length - 4}` : ""}]`);
}
console.log(`  → ${findingsFile}`);
console.log(`\nGreen sections (${sectionResults.filter((entry) => entry.green).length}):`);
for (const entry of sectionResults.filter((item) => item.green)) console.log(`  ✓ ${entry.title}`);
console.log(`Red sections (${sectionResults.filter((entry) => !entry.green).length}):`);
for (const entry of sectionResults.filter((item) => !item.green)) console.log(`  ✗ ${entry.title}`);
process.exit(finish());
