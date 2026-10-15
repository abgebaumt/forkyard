/**
 * Statistics view in the real app (1.1, new design): it takes the whole window (no Left Panel,
 * no Commit Panel), opens through the toolbar button or the palette and closes only through the
 * button (back to the view it replaced), recomputes by itself when the branch moves, and shows
 * every card – activity heatmap, commits over time, records, treemap, hotspots, authors,
 * knowledge per folder and code age – with the numbers of a real temp repository. The expected
 * numbers come from the fixture (what was committed when, by whom) and from git itself
 * (numstat, blame, `log --follow`); the core's own result (`stats_compute`) is only a cross-check.
 *
 *   node scripts/e2e-wd/features/stats.mjs
 *   E2E_WD_ONLY="recompute" node scripts/e2e-wd/features/stats.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { makeLargeRepo } from "../../e2e/fixtures.mjs";
import {
  PEOPLE,
  authorTotals,
  codeAgeFromBlame,
  dateOf,
  dayRangeText,
  dayText,
  knowledgeFromGit,
  makeBareStatsRepo,
  makeCrowdStatsRepo,
  makeOldStatsRepo,
  makeStatsRepo,
  textLinesAt,
} from "../fixtures/stats.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const VIEW = '[data-screen="stats"]';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Objects with sorted keys (values from the page come back in another key order). */
const canon = (value) =>
  Array.isArray(value) ? value.map(canon) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])])) : value;
const same = (actual, expected, message) => assertEqual(canon(actual), canon(expected), message);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The Statistics button of the repository toolbar: { el, pressed, hint, disabled } or null. */
const FIND_STATS_BUTTON = `
    const bar = [...document.querySelectorAll('[role="toolbar"]')].find((item) => item.getAttribute("aria-label") === "Repository actions");
    return [...(bar?.querySelectorAll("button") ?? [])].find((el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria === "Statistics";
      return (el.innerText ?? "").split("\\n").map((line) => line.trim()).includes("Statistics");
    }) ?? null;`;
async function statsButton(app) {
  return app.exec(() => {
    const bar = [...document.querySelectorAll('[role="toolbar"]')].find((item) => item.getAttribute("aria-label") === "Repository actions");
    const button = [...(bar?.querySelectorAll("button") ?? [])].find((el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria === "Statistics";
      return (el.innerText ?? "").split("\n").map((line) => line.trim()).includes("Statistics");
    });
    if (!button) return null;
    const hintId = button.getAttribute("aria-describedby");
    return {
      pressed: button.getAttribute("aria-pressed"),
      hint: hintId ? (document.getElementById(hintId)?.textContent ?? "") : "",
      disabled: button.getAttribute("aria-disabled") === "true",
    };
  });
}

/** Finds an element and clicks it; looks it up again when React replaced it in between. */
async function clickFresh(app, find, tries = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await (await find()).click();
    } catch (error) {
      if (attempt >= tries || !/stale element/i.test(String(error?.message))) throw error;
      await sleep(100);
    }
  }
}

async function clickStats(app) {
  await clickFresh(app, () => app.waitFor(() => app.exec(FIND_STATS_BUTTON), 15_000, { message: "toolbar button Statistics" }));
}

/** The tab's view state (the store's default until the tab changed anything). */
const view = (app, tabId) =>
  app.exec((id) => window.__gc.store.getState().views[id] ?? { center: { kind: "graph" }, selection: { kind: "wip" }, leftCollapsed: false, rightCollapsed: false }, tabId);
const centerKind = async (app, tabId) => (await view(app, tabId))?.center.kind ?? null;
const waitCenter = (app, tabId, kind, timeout = 10_000) =>
  app.waitFor(async () => ((await centerKind(app, tabId)) === kind ? kind : null), timeout, { message: `centre shows ${kind}` });

/** Runs a command through the palette (Ctrl+P, ">text", click on the entry with that id). */
async function runCommand(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  // The list re-renders while the filter settles: a node found a moment ago can be replaced.
  await clickFresh(app, () => app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` }));
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** Palette entries for a text ({ id, disabled, text }), the palette is closed again. */
async function paletteIds(app, text) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  await sleep(400);
  const ids = await app.exec(() =>
    [...document.querySelectorAll('[data-screen="command-palette"] [role="option"]')].map((el) => ({ id: el.getAttribute("data-key") ?? "", disabled: el.getAttribute("aria-disabled") === "true", text: el.innerText.replace(/\s+/g, " ").trim() })),
  );
  await app.press("Escape");
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
  return ids;
}

/** Everything the view shows, read from the DOM. */
function readStats(app) {
  return app.exec((selector) => {
    const root = document.querySelector(selector);
    if (!root) return null;
    const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const num = (value) => Number(String(value).replace(/[^\d]/g, ""));
    const status = root.querySelector("[data-stats-status]");
    const heat = {};
    for (const cell of root.querySelectorAll("[data-stats-heatmap] [data-cell]")) heat[cell.getAttribute("data-cell")] = text(cell.querySelector("title"));
    const records = {};
    for (const dt of root.querySelectorAll("[data-stats-records] dt")) {
      const values = [];
      for (let next = dt.nextElementSibling; next && next.tagName === "DD"; next = next.nextElementSibling) values.push(text(next));
      records[text(dt)] = values;
    }
    return {
      state: root.getAttribute("data-stats"),
      status: status ? { kind: status.getAttribute("data-stats-status"), text: text(status) } : null,
      sections: [...root.querySelectorAll("[data-stats-section]")].map((el) => el.getAttribute("data-stats-section")),
      banner: text(root.querySelector('[role="alert"]')) || null,
      heat,
      bars: [...root.querySelectorAll("[data-stats-time] [data-period]")].map((el) => ({ period: el.getAttribute("data-period"), title: text(el.querySelector("title")) })),
      timeHint: text(root.querySelector('[data-stats-section="time"] h2 + span')),
      records,
      biggest: root.querySelector("[data-record-commit]") ? { sha: root.querySelector("[data-record-commit]").getAttribute("data-record-commit"), text: text(root.querySelector("[data-record-commit]")) } : null,
      folder: root.querySelector("[data-stats-folder]")?.getAttribute("data-stats-folder") ?? null,
      tiles: [...root.querySelectorAll("[data-stats-treemap] [data-tile]")].map((el) => ({ path: el.getAttribute("data-tile"), kind: el.getAttribute("data-kind"), label: el.getAttribute("aria-label") })),
      treemapNote: text(root.querySelector('[data-stats-section="treemap"] p')) || null,
      hotspots: [...root.querySelectorAll("[data-stats-hotspots] tbody tr")].map((row) => {
        const cells = row.querySelectorAll("td");
        return { path: row.querySelector("[data-hotspot]")?.getAttribute("data-hotspot"), commits: num(text(cells[1])), authors: num(text(cells[2])), severity: row.getAttribute("data-severity") };
      }),
      hotspotsNote: text(root.querySelector('[data-stats-section="hotspots"] p')) || null,
      authors: [...root.querySelectorAll("[data-stats-authors] [data-author]")].map((row) => {
        const spans = [...row.children];
        return { email: row.getAttribute("data-author"), name: text(spans[1]), commits: num(text(spans[2])), added: num(text(spans[3])), removed: num(text(spans[4])) };
      }),
      authorsHint: text(root.querySelector('[data-stats-section="authors"] h2 + span')),
      moreAuthors: text(root.querySelector('[data-stats-section="authors"] p')) || null,
      knowledge: [...root.querySelectorAll("[data-stats-knowledge] tbody tr")].map((row) => ({
        folder: row.getAttribute("data-folder"),
        label: text(row.querySelector("button")),
        bus: num(text(row.querySelectorAll("td")[2])),
        shares: [...row.querySelectorAll("[data-share]")].map((el) => ({ who: el.getAttribute("data-share"), title: el.getAttribute("title") })),
      })),
      age: [...root.querySelectorAll("[data-stats-age] [data-age]")].map((el) => ({ key: el.getAttribute("data-age"), title: el.getAttribute("title") })),
      ageHint: text(root.querySelector('[data-stats-section="age"] h2 + span')),
      ageNote: text(root.querySelector('[data-stats-section="age"] p')) || null,
      text: text(root),
    };
  }, VIEW);
}

/** Waits until the view is ready (no run going) and `check(stats)` holds. */
async function waitStats(app, check = () => true, message = "statistics ready", timeout = 30_000) {
  let last = null;
  try {
    return await app.waitFor(
      async () => {
        last = await readStats(app);
        if (!last || last.state !== "ready" || last.status?.kind === "updating") return null;
        return check(last) ? last : null;
      },
      timeout,
      { message },
    );
  } catch (error) {
    throw new Error(`${error.message}; last: ${JSON.stringify(last && { state: last.state, status: last.status, banner: last.banner, authors: last.authors, text: last.text.slice(0, 300) })}`);
  }
}

/** Sum of the commit counts in the bar titles of the time chart ("Jun 2026: 3 commits"). */
const barTotal = (stats) => stats.bars.reduce((sum, bar) => sum + Number(/: (\d+) commits?$/.exec(bar.title)?.[1] ?? NaN), 0);
/** Commits per heatmap cell from the cell titles ("Mon 9:00 – 1 commit"). */
const heatCount = (title) => Number(/– (\d+) commits?$/.exec(title)?.[1] ?? NaN);
const commitsHint = (stats) => Number(/^([\d,]+) commits?/.exec(stats.timeHint)?.[1].replace(/,/g, "") ?? NaN);

/** The core's own numbers for a range (cross-check; fills the core's cache). */
let jobCounter = 0;
const compute = (app, repoId, range) => app.invoke("stats_compute", { repoId, jobId: `e2e-stats-${Date.now()}-${(jobCounter += 1)}`, range });

/** Picks an entry of one of the view's selects (aria-label "Range" or "Branch"). */
async function choose(app, label, option) {
  const trigger = await app.waitFor(() => app.exec((wanted, selector) => document.querySelector(`${selector} [aria-label="${wanted}"]`), label, VIEW), 10_000, { message: `select ${label}` });
  await trigger.click();
  const item = await app.waitFor(
    () => app.exec((wanted) => [...document.querySelectorAll('[role="listbox"] [role="option"]')].find((el) => el.innerText.trim() === wanted) ?? null, option),
    5000,
    { message: `option ${option}` },
  );
  await item.click();
  await app.waitFor(() => app.exec(() => !document.querySelector('[role="listbox"]')), 5000, { message: "select closed" });
}
const selectText = (app, label) => app.exec((wanted, selector) => document.querySelector(`${selector} [aria-label="${wanted}"]`)?.innerText.replace(/\s+/g, " ").trim() ?? null, label, VIEW);

/** Records every statistics job the UI starts (store.jobs) in window.__statsJobs. */
function trackJobs(app) {
  return app.exec(() => {
    window.__statsJobs = [];
    const known = new Set(Object.keys(window.__gc.store.getState().jobs));
    const seen = (state) => {
      for (const job of Object.values(state.jobs)) if (job.title === "Statistics" && !known.has(job.id) && !window.__statsJobs.includes(job.id)) window.__statsJobs.push(job.id);
    };
    window.__gc.store.subscribe(seen);
    return true;
  });
}
const statsJobs = (app) => app.exec(() => window.__statsJobs.length);

const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.getAttribute("data-toast"), text: el.innerText.replace(/\s+/g, " ").trim() })));
async function noDangerToasts(app) {
  assertEqual((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error message");
}

/** Side panels and rails present in the workspace. */
const panels = (app) =>
  app.exec(() => ({
    left: Boolean(document.querySelector('[data-area="left"]')),
    right: Boolean(document.querySelector('[data-area="right"]')),
    leftRail: Boolean(document.querySelector('[data-rail="left"]')),
    rightRail: Boolean(document.querySelector('[data-rail="right"]')),
    leftWidth: Math.round(document.querySelector('[data-area="left"]')?.getBoundingClientRect().width ?? 0),
    rightWidth: Math.round(document.querySelector('[data-area="right"]')?.getBoundingClientRect().width ?? 0),
  }));

async function openStatsRepo(t, repo, launch = {}) {
  const app = await t.launch({ ...LAUNCH, ...launch });
  const { repoId, tabId } = await app.openRepo(repo.path);
  await app.waitFor(() => statsButton(app), 20_000, { message: "repository toolbar" });
  return { app, repoId, tabId };
}

// ---------------------------------------------------------------------------------------------
// Opening and closing: only the Stats button
// ---------------------------------------------------------------------------------------------

scenario("Stats button opens the statistics and closes them again", "main", async (t) => {
  const repo = makeStatsRepo();
  const { app, tabId } = await openStatsRepo(t, repo);
  assertEqual(await centerKind(app, tabId), "graph", "starts on the graph");
  let button = await statsButton(app);
  assertEqual(button.pressed, "false", "button not pressed while closed");
  assertMatch(button.hint, /Commits, authors, hotspots and code age/, "hint while closed");

  await clickStats(app);
  await waitCenter(app, tabId, "stats");
  const stats = await waitStats(app, (s) => s.authors.length > 0);
  t.step(`statistics open: ${stats.sections.join(", ")}`);
  button = await statsButton(app);
  assertEqual(button.pressed, "true", "button pressed while open");
  assertMatch(button.hint, /Close the statistics and go back to the previous view/, "hint while open");
  same(stats.status, { kind: "fresh", text: "Up to date with HEAD" }, "status line of the header");
  assertEqual(await selectText(app, "Branch"), "Branch main (HEAD)", "branch select");
  assertEqual(await selectText(app, "Range"), "Range All time", "range select");
  await t.shot("stats-button-opens");

  await clickStats(app);
  await waitCenter(app, tabId, "graph");
  await app.waitFor(() => app.exec((selector) => !document.querySelector(selector), VIEW), 5000, { message: "statistics gone" });
  assertEqual((await statsButton(app)).pressed, "false", "button released after closing");
  assert(await app.waitFor('[data-row-kind="commit"]', 10_000), "graph rows are back");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
});

scenario("Escape, the palette and other centre changes do not close the statistics", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app, tabId } = await openStatsRepo(t, repo);
  await runCommand(app, "Show statistics", "stats.show");
  await waitCenter(app, tabId, "stats");
  await waitStats(app);
  assertEqual((await statsButton(app)).pressed, "true", "opened from the palette: button pressed");

  // Escape with focus in the view and on the body.
  const tile = await app.waitFor(`${VIEW} [data-tile]`, 10_000);
  await app.exec((el) => el.focus(), tile);
  await app.press("Escape");
  await app.exec(() => document.activeElement?.blur());
  await app.press("Escape", "Escape");
  await sleep(400);
  assertEqual(await centerKind(app, tabId), "stats", "Escape keeps the statistics");

  // The palette entry again does not toggle them away.
  await runCommand(app, "Show statistics", "stats.show");
  await sleep(300);
  assertEqual(await centerKind(app, tabId), "stats", "palette entry while open keeps them");

  // A plain centre change (what a diff from a side panel or "back to the graph" does) is refused.
  await app.exec((id) => window.__gc.store.getState().setCenter(id, { kind: "graph" }), tabId);
  await app.exec((id) => window.__gc.store.getState().openHistory(id, "README.md"), tabId);
  await sleep(300);
  assertEqual(await centerKind(app, tabId), "stats", "setCenter/openHistory from outside are refused");
  assert(await app.$(VIEW), "view still mounted");

  await clickStats(app);
  await waitCenter(app, tabId, "graph");
  await t.noConsoleErrors(app);
});

scenario("closing goes back to the view the statistics replaced", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app, tabId } = await openStatsRepo(t, repo);
  await app.exec((id) => window.__gc.store.getState().openHistory(id, "README.md"), tabId);
  await waitCenter(app, tabId, "history");
  await app.waitFor('[data-screen="file-history"]', 15_000);
  await clickStats(app);
  await waitCenter(app, tabId, "stats");
  await waitStats(app);
  await clickStats(app);
  await waitCenter(app, tabId, "history");
  same((await view(app, tabId)).center, { kind: "history", path: "README.md" }, "file history of README.md is back");
  assert(await app.waitFor('[data-screen="file-history"][aria-label="History of README.md"]', 10_000), "history view visible");
  await t.noConsoleErrors(app);
});

scenario("the view's own links leave it: hotspot opens the history, the largest commit the graph", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app, tabId } = await openStatsRepo(t, repo);
  await clickStats(app);
  await trackJobs(app);
  const first = await waitStats(app, (s) => s.hotspots.length > 0 && s.biggest !== null);
  assertEqual(await statsJobs(app), 0, "tracking started after the first run");

  await app.click(`${VIEW} [data-hotspot="${repo.expected.topHotspot}"]`);
  await waitCenter(app, tabId, "history");
  assert(await app.waitFor(`[data-screen="file-history"][aria-label="History of ${repo.expected.topHotspot}"]`, 15_000), "file history of the hotspot");
  assertEqual((await statsButton(app)).pressed, "false", "button released after leaving through a link");
  const panelState = await panels(app);
  assert(panelState.left && panelState.right, `side panels are back: ${JSON.stringify(panelState)}`);

  // Back through the button: the session's last result is shown at once, without a new job.
  await clickStats(app);
  await waitCenter(app, tabId, "stats");
  const again = await waitStats(app, (s) => s.biggest !== null, "result shown again", 5000);
  assertEqual(again.authors, first.authors, "same numbers as before");
  await sleep(500);
  assertEqual(await statsJobs(app), 0, "no recomputation when nothing changed");

  await app.click(`${VIEW} [data-record-commit]`);
  await waitCenter(app, tabId, "graph");
  const selection = await app.waitFor(async () => {
    const value = (await view(app, tabId)).selection;
    return value?.kind === "commits" ? value.shas : null;
  }, 10_000, { message: "commit selected" });
  assertEqual(selection, [repo.biggest], "the largest commit is selected in the graph");
  await t.noConsoleErrors(app);
});

scenario("statistics stay per tab: the other repository keeps its graph and panels", "edge", async (t) => {
  const repo = makeStatsRepo();
  const other = makeOldStatsRepo();
  const { app, tabId } = await openStatsRepo(t, repo);
  await clickStats(app);
  await waitStats(app);
  const second = await app.openRepo(other.path);
  await waitCenter(app, second.tabId, "graph");
  const state = await panels(app);
  assert(state.left && state.right, `other tab shows both panels: ${JSON.stringify(state)}`);
  assertEqual((await statsButton(app)).pressed, "false", "button released in the other tab");
  assertEqual(await centerKind(app, tabId), "stats", "first tab still on the statistics");
  await app.click(`[data-tab-id="${tabId}"] [role="tab"]`);
  await app.waitFor(VIEW, 10_000);
  await waitStats(app);
  assertEqual((await statsButton(app)).pressed, "true", "button pressed again in the first tab");
  await t.noConsoleErrors(app);
});

// ---------------------------------------------------------------------------------------------
// Whole width
// ---------------------------------------------------------------------------------------------

scenario("statistics take the whole width, the panels come back unchanged", "main", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  const before = await panels(app);
  assert(before.left && before.right, `both panels shown before: ${JSON.stringify(before)}`);
  await clickStats(app);
  await waitStats(app);
  const during = await panels(app);
  same({ ...during, leftWidth: 0, rightWidth: 0 }, { left: false, right: false, leftRail: false, rightRail: false, leftWidth: 0, rightWidth: 0 }, "no panel, no rail");
  const widths = await app.exec((selector) => ({ view: Math.round(document.querySelector(selector).getBoundingClientRect().width), window: window.innerWidth }), VIEW);
  assert(Math.abs(widths.view - widths.window) <= 2, `view as wide as the window: ${JSON.stringify(widths)}`);
  // At 1440 px the cards sit three in a row.
  const rows = await app.exec((selector) => {
    const tops = [...document.querySelectorAll(`${selector} [data-stats-section]`)].map((el) => Math.round(el.getBoundingClientRect().top));
    return tops.filter((top) => top === tops[0]).length;
  }, VIEW);
  assertEqual(rows, 3, "three cards in the first row");
  await t.shot("stats-full-width");
  await clickStats(app);
  await app.waitFor(async () => (await panels(app)).left, 10_000, { message: "panels back" });
  const after = await panels(app);
  same(after, before, "panels as before (shown, same widths)");
  await t.noConsoleErrors(app);
});

scenario("panel toggles are unavailable while open; collapsed state and widths survive", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app, tabId } = await openStatsRepo(t, repo);
  // Collapse the left panel, make the commit panel wider.
  await app.exec((id) => {
    const store = window.__gc.store.getState();
    store.setLeftCollapsed?.(id, true);
    store.setRightWidth(store.rightWidth + 40);
  }, tabId);
  await app.waitFor(async () => (await panels(app)).leftRail, 5000, { message: "left panel collapsed" });
  const before = await panels(app);
  const stored = await app.exec(() => ({ right: window.__gc.store.getState().rightWidth }));
  await clickStats(app);
  await waitStats(app);
  // The titles are "Show or hide sidebar" and "Show or hide commit panel": search both words.
  const panelToggles = async () => [...(await paletteIds(app, "sidebar")), ...(await paletteIds(app, "commit panel"))].filter((entry) => /toggleLeftPanel|toggleCommitPanel/.test(entry.id));
  const toggles = await panelToggles();
  assert(toggles.every((entry) => entry.disabled), `panel toggles in the palette are unavailable: ${JSON.stringify(toggles)}`);
  t.step(`palette while open: ${toggles.map((entry) => entry.text).join(" | ") || "no panel toggles"}`);
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+j");
  await app.press("Control+k");
  await sleep(400);
  const viewState = await view(app, tabId);
  assertEqual([viewState.leftCollapsed, viewState.rightCollapsed], [true, false], "Ctrl+J / Ctrl+K changed nothing");
  assertEqual(await centerKind(app, tabId), "stats", "still on the statistics");
  const during = await panels(app);
  assert(!during.left && !during.right && !during.leftRail && !during.rightRail, `nothing shown: ${JSON.stringify(during)}`);
  await clickStats(app);
  await app.waitFor(async () => (await panels(app)).right, 10_000, { message: "panels back" });
  same(await panels(app), before, "left still collapsed, commit panel as wide as before");
  assertEqual(await app.exec(() => ({ right: window.__gc.store.getState().rightWidth })), stored, "stored width unchanged");
  // The toggles work again.
  const again = await panelToggles();
  assert(["toggleLeftPanel", "toggleCommitPanel"].every((name) => again.some((entry) => entry.id.includes(name) && !entry.disabled)), `panel toggles available again: ${JSON.stringify(again)}`);
  await t.noConsoleErrors(app);
});

scenario("narrow window: cards in two columns, nothing overflows", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo, { width: 1000, height: 800 });
  await clickStats(app);
  await waitStats(app);
  const layout = await app.exec((selector) => {
    const root = document.querySelector(selector);
    const tops = [...root.querySelectorAll("[data-stats-section]")].map((el) => Math.round(el.getBoundingClientRect().top));
    const scroller = root.querySelector(".overflow-auto");
    return { firstRow: tops.filter((top) => top === tops[0]).length, horizontal: scroller.scrollWidth - scroller.clientWidth, width: Math.round(root.getBoundingClientRect().width), window: window.innerWidth };
  }, VIEW);
  assertEqual(layout.firstRow, 2, "two cards in a row");
  assert(layout.horizontal <= 1, `no horizontal scrolling: ${JSON.stringify(layout)}`);
  assert(Math.abs(layout.width - layout.window) <= 2, `whole width: ${JSON.stringify(layout)}`);
  await t.shot("stats-narrow");
  await t.noConsoleErrors(app);
});

// ---------------------------------------------------------------------------------------------
// Automatic recomputation
// ---------------------------------------------------------------------------------------------

scenario("a new commit on the branch recomputes the open statistics by themselves", "main", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  const first = await waitStats(app, (s) => commitsHint(s) === repo.expected.commits);
  const aylin = first.authors.find((author) => author.email === PEOPLE.aylin.email);
  const aylinCommits = repo.counted.filter((item) => item.person === PEOPLE.aylin).length;
  assertEqual(aylin.commits, aylinCommits, "Aylin before");
  await trackJobs(app);

  // Commit outside the app (another terminal): the watcher reports it, the view follows.
  repo.write("src/station/wetter.rs", "// Wetter\n// Regen\n// Wind\n");
  const sha = repo.commit(PEOPLE.aylin, 0, 9, "Wettermodul");
  assertEqual(Number(repo.git("rev-list", "--count", "--no-merges", "HEAD")), repo.expected.commits + 1, "git: one more commit");
  const after = await waitStats(app, (s) => commitsHint(s) === repo.expected.commits + 1, "recomputed with the new commit", 30_000);
  assert((await statsJobs(app)) >= 1, "a statistics job ran");
  assertEqual(after.authors.find((author) => author.email === PEOPLE.aylin.email).commits, aylinCommits + 1, "Aylin after");
  same(after.status, { kind: "fresh", text: "Up to date with HEAD" }, "status after the recomputation");
  assert(after.tiles.some((tile) => tile.path === "src"), "treemap still there");
  assertEqual(barTotal(after), repo.expected.commits + 1, "time chart counts the new commit");
  const core = await compute(app, (await app.invoke("repo_open", { path: repo.path })).repo.id, { from: null, to: null, ref: "HEAD" });
  assertEqual(core.tip, sha, "core: tip is the new commit");
  await t.shot("stats-recomputed");
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
});

scenario("recompute: unchanged branch shows the last result without a job, a moved one recomputes on reopening", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  await waitStats(app, (s) => commitsHint(s) === repo.expected.commits);
  await trackJobs(app);
  await clickStats(app);
  await clickStats(app);
  await waitStats(app, (s) => commitsHint(s) === repo.expected.commits, "shown again", 5000);
  await sleep(600);
  assertEqual(await statsJobs(app), 0, "reopened without changes: no job");

  await clickStats(app); // closed
  repo.write("notiz.txt", "Wartung\n");
  repo.commit(PEOPLE.jonas, 0, 8, "Wartungsnotiz");
  // Wait until the app knows the new tip (graph shows it), then reopen.
  const tip = repo.head();
  await app.waitFor(() => app.exec((sha) => [...document.querySelectorAll('[data-row-kind="commit"]')].some((row) => row.getAttribute("data-sha") === sha || row.innerText.includes("Wartungsnotiz")), tip), 20_000, { message: "graph shows the new commit" });
  await clickStats(app);
  await waitStats(app, (s) => commitsHint(s) === repo.expected.commits + 1, "recomputed on reopening");
  assert((await statsJobs(app)) >= 1, "a job ran for the moved branch");
  await t.noConsoleErrors(app);
});

scenario("periods: every range counts the commits of its days", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app, repoId } = await openStatsRepo(t, repo);
  await clickStats(app);
  await waitStats(app, (s) => commitsHint(s) === repo.expected.presets.all);
  const cases = [
    ["Last 30 days", "month"],
    ["Last 90 days", "quarter"],
    ["Last 12 months", "year"],
    ["All time", "all"],
  ];
  for (const [label, key] of cases) {
    await choose(app, "Range", label);
    const expected = repo.expected.presets[key];
    const stats = await waitStats(app, (s) => commitsHint(s) === expected, `${label}: ${expected} commits`);
    assertEqual(barTotal(stats), expected, `${label}: time chart`);
    const heat = Object.values(stats.heat).reduce((sum, title) => sum + heatCount(title), 0);
    assertEqual(heat, expected, `${label}: heatmap`);
    assertEqual(await selectText(app, "Range"), `Range ${label}`, `${label}: select shows it`);
    t.step(`${label}: ${expected} commits, ${stats.authors.length} authors`);
  }
  // Cross-check with git: author time within the last 30 days (midnight UTC).
  const since = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 30 * 86_400_000).toISOString();
  assertEqual(Number(repo.git("log", "--no-merges", "--format=%H", "HEAD").split("\n").filter((sha) => Number(repo.git("log", "-1", "--format=%at", sha)) * 1000 >= Date.parse(since)).length), repo.expected.presets.month, "git agrees on the last 30 days");
  const core = await compute(app, repoId, { from: since, to: null, ref: "HEAD" });
  assertEqual(core.commits, repo.expected.presets.month, "core agrees on the last 30 days");
  // The rebased commit: committed within the last 30 days, written before – the period is the author time.
  const [authored, committed] = repo.git("log", "-1", "--format=%at %ct", repo.rebased).split(" ").map((value) => Number(value) * 1000);
  assert(authored < Date.parse(since) && committed >= Date.parse(since), `fixture: written before, committed within the last 30 days (${new Date(authored).toISOString()}, ${new Date(committed).toISOString()})`);
  const byCommitTime = repo.git("log", "--no-merges", "--format=%ct", "HEAD").split("\n").filter((value) => Number(value) * 1000 >= Date.parse(since)).length;
  assertEqual(byCommitTime, repo.expected.presets.month + 1, "by commit time it would be one more");
  await t.noConsoleErrors(app);
});

scenario("branch choice: another branch is counted and follows when it moves", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  await waitStats(app, (s) => commitsHint(s) === repo.expected.commits);
  await choose(app, "Branch", "experiment/funk");
  let stats = await waitStats(app, (s) => commitsHint(s) === repo.expected.commits + 1, "experiment/funk counted");
  const mehmetOnMain = repo.counted.filter((item) => item.person === PEOPLE.mehmet).length;
  assertEqual(stats.authors.find((author) => author.email === PEOPLE.mehmet.email)?.commits, mehmetOnMain + 1, "Mehmet with the branch's commit");
  same(stats.status, { kind: "fresh", text: "Up to date with experiment/funk" }, "status names the branch");
  assertEqual(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "git: HEAD stays on main");

  // Move experiment/funk without checking it out.
  const parent = repo.git("rev-parse", "experiment/funk");
  const tree = repo.git("rev-parse", "experiment/funk^{tree}");
  const moved = repo.gitAt(PEOPLE.mehmet, 0, 7, "commit-tree", tree, "-p", parent, "-m", "Funkmodul nachjustieren");
  repo.git("update-ref", "refs/heads/experiment/funk", moved, parent);
  stats = await waitStats(app, (s) => commitsHint(s) === repo.expected.commits + 2, "follows the moved branch", 30_000);
  assertEqual(stats.authors.find((author) => author.email === PEOPLE.mehmet.email)?.commits, mehmetOnMain + 2, "Mehmet after the move");

  // Commits on main do not concern the chosen branch.
  repo.write("main-only.txt", "x\n");
  repo.commit(PEOPLE.lena, 0, 6, "Nur auf main");
  await sleep(2500);
  stats = await waitStats(app);
  assertEqual(commitsHint(stats), repo.expected.commits + 2, "a commit on main does not change experiment/funk");
  await t.noConsoleErrors(app);
});

scenario("the core's cache answers after a restart: status says cached", "edge", async (t) => {
  const repo = makeStatsRepo();
  const dataDir = path.join(repo.root, "app-data");
  fs.mkdirSync(dataDir, { recursive: true });
  {
    const { app } = await openStatsRepo(t, repo, { dataDir });
    await clickStats(app);
    const first = await waitStats(app, (s) => commitsHint(s) === repo.expected.commits);
    assertEqual(first.status.kind, "fresh", "first run computes");
    await t.noConsoleErrors(app);
    await app.close();
  }
  const { app, tabId } = await openStatsRepo(t, repo, { dataDir });
  // The harness ends the first app hard, so the second start offers a crash report: dismiss it.
  const crash = await app.waitFor(() => app.exec(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((el) => /closed unexpectedly/.test(el.innerText));
    return dialog ? [...dialog.querySelectorAll("button")].find((button) => button.innerText.trim() === "Cancel") ?? null : null;
  }), 3000).catch(() => null);
  if (crash) {
    await crash.click();
    await app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), 5000, { message: "crash dialog closed" });
  }
  if ((await centerKind(app, tabId)) !== "stats") await clickStats(app);
  const again = await waitStats(app, (s) => commitsHint(s) === repo.expected.commits);
  same(again.status, { kind: "cached", text: "Cached · up to date with HEAD" }, "second start comes from the cache");
  await t.noConsoleErrors(app);
});

scenario("errors stay in the view: a branch that disappears, then Try again", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  await waitStats(app);
  await choose(app, "Branch", "experiment/funk");
  await waitStats(app, (s) => commitsHint(s) === repo.expected.commits + 1);
  const tip = repo.git("rev-parse", "experiment/funk");
  repo.git("update-ref", "-d", "refs/heads/experiment/funk");
  await sleep(2000);
  // A new period for the gone branch: the core reports not_found, the view keeps it as state.
  await choose(app, "Range", "Last 12 months");
  const failed = await app.waitFor(async () => {
    const stats = await readStats(app);
    return stats?.state === "failed" ? stats : null;
  }, 20_000, { message: "failed state" });
  assertMatch(failed.text, /The statistics could not be computed/, "banner title");
  assertEqual((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error toast (state in the view)");
  await t.shot("stats-error");
  repo.git("update-ref", "refs/heads/experiment/funk", tip);
  await sleep(1500);
  const retry = await app.waitFor(() => app.exec((selector) => [...document.querySelectorAll(`${selector} button`)].find((el) => el.innerText.trim() === "Try again") ?? null, VIEW), 5000, { message: "Try again" });
  await retry.click();
  const back = await waitStats(app, (s) => s.authors.length > 0, "computed again");
  assert(!back.text.includes("could not be computed"), "banner gone");
  await t.noConsoleErrors(app);
});

scenario("a running computation is shown and can be cancelled in the status bar", "edge", async (t) => {
  const repo = makeLargeRepo(50000);
  try {
    const { app } = await openStatsRepo(t, { path: repo.path });
    await clickStats(app);
    const running = await app.waitFor(() => app.exec((selector) => {
      const root = document.querySelector(selector);
      return root?.getAttribute("data-stats") === "running" ? root.querySelector("[data-stats-status]")?.textContent ?? "" : null;
    }, VIEW), 15_000, { message: "statistics running" });
    assertMatch(running, /^Updating …/, "header says updating");
    // Click in the page right away: a WebDriver round trip later the job may be done.
    const clicked = await app.waitFor(() => app.exec(() => {
      const button = document.querySelector('button[aria-label="Cancel Statistics"]');
      if (!button) return null;
      button.click();
      return true;
    }), 10_000, { message: "cancel button of the job" });
    assert(clicked, "cancel clicked");
    await app.waitFor(async () => (await toasts(app)).some((toast) => /cancel/i.test(toast.text)), 10_000, { message: "cancelled toast" });
    let after = null;
    await app
      .waitFor(async () => {
        after = await app.exec((selector) => ({ state: document.querySelector(selector)?.getAttribute("data-stats"), status: document.querySelector(`${selector} [data-stats-status]`)?.textContent ?? null, jobs: Object.values(window.__gc.store.getState().jobs).map((job) => job.title) }), VIEW);
        return after.state !== "running";
      }, 30_000)
      .catch(() => undefined);
    t.step(`30 s after cancelling: ${JSON.stringify(after)}`);
    await t.shot("stats-cancelled");
    assert(after.state !== "running", `after "Statistics cancelled" the view still says running: ${JSON.stringify(after)}`);
    await sleep(500);
    const jobs = await app.exec(() => Object.values(window.__gc.store.getState().jobs).filter((job) => job.title === "Statistics").length);
    assertEqual(jobs, 0, "job gone from the status bar");
    const shown = await readStats(app);
    t.step(`after cancel: state=${shown.state}, text="${shown.text.slice(0, 200)}"`);
    await noDangerToasts(app);
    // After cancelling the first run there is nothing to show; the view must offer a way on.
    const hasWayOn = await app.exec((selector) => [...document.querySelectorAll(`${selector} button`)].some((el) => /try again|recalculate|compute/i.test(el.innerText)), VIEW);
    const blank = !(shown.sections.length > 0 || hasWayOn || /cancel/i.test(shown.text));
    // Closing and reopening through the button starts a new run (the only way back).
    await clickStats(app);
    await clickStats(app);
    const restarted = await app.waitFor(() => app.exec((selector) => {
      const value = document.querySelector(selector)?.getAttribute("data-stats");
      return value === "running" || value === "ready" ? value : null;
    }, VIEW), 15_000, { message: "reopening computes again" });
    t.step(`reopened: ${restarted}`);
    assert(!blank, `after cancelling the first run the view is blank: no message and no button to compute again (only another branch/range or closing and reopening helps) (state ${shown.state}): "${shown.text.slice(0, 160)}"`);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// All cards
// ---------------------------------------------------------------------------------------------

/**
 * Every knowledge row against git (fixtures/stats.mjs `knowledgeFromGit`, the core's definition
 * implemented independently): bus factor, main author and their share.
 */
function checkKnowledge(s, repo) {
  const truth = knowledgeFromGit(repo);
  assert(s.knowledge.length > 0 && s.knowledge.length <= 6, `knowledge rows: ${s.knowledge.length}`);
  for (const row of s.knowledge) {
    const folder = truth[row.folder];
    assert(folder, `folder ${row.folder} known to git: ${Object.keys(truth).join(", ")}`);
    assertEqual(row.bus, folder.bus, `bus factor ${row.folder}`);
    const main = row.shares[0];
    assert(main, `shares of ${row.folder}`);
    assertEqual(main.who.toLowerCase(), folder.main, `main author of ${row.folder}`);
    assertEqual(Number(/: (\d+)\s?%$/.exec(main.title)?.[1] ?? NaN), folder.mainShare, `main share of ${row.folder} (${main.title})`);
  }
}

scenario("knowledge per folder: bus factor, main author and share from git", "main", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  const s = await waitStats(app, (x) => commitsHint(x) === repo.expected.commits && x.knowledge.length > 0);
  checkKnowledge(s, repo);
  t.step(`knowledge rows: ${s.knowledge.map((row) => `${row.folder} bus ${row.bus}`).join(", ")}`);
  await t.noConsoleErrors(app);
});

scenario("all cards show the repository's numbers", "main", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  const s = await waitStats(app, (x) => commitsHint(x) === repo.expected.commits && x.biggest?.text.includes("·"));
  assertEqual(s.sections, ["heatmap", "time", "records", "treemap", "hotspots", "authors", "knowledge", "age"], "every card, in order");

  // Activity: 7 × 24 cells, counts per weekday and local hour as committed.
  assertEqual(Object.keys(s.heat).length, 168, "heatmap cells");
  for (let day = 0; day < 7; day += 1)
    for (let hour = 0; hour < 24; hour += 1) assertEqual(heatCount(s.heat[`${day}-${hour}`]), repo.expected.heatmap[day][hour], `heatmap ${day}-${hour} (${s.heat[`${day}-${hour}`]})`);

  // Commits over time.
  assertEqual(barTotal(s), repo.expected.commits, "time chart total");
  assertEqual(commitsHint(s), repo.expected.commits, "time hint");

  // Records.
  // By the author's clock: two commits late in the evening at −0700 are already the next day in UTC.
  const { streak, busiest } = repo.expected;
  same(s.records["Longest streak"], [`${streak.days} days`, dayRangeText(streak.start, streak.end)], "longest streak and its days");
  same(s.records["Busiest day"], [`${busiest.commits} commits`, dayText(busiest.date)], "busiest day and its date");
  const west = repo.git("log", "--no-merges", "--format=%ad", "--date=format:%z %H:%M", "HEAD").split("\n").filter((line) => line.startsWith("-0700"));
  same(west, ["-0700 23:45", "-0700 23:30"], "fixture: two late commits at −0700");
  assertEqual(s.biggest.sha, repo.biggest, "largest commit is the CSV import");
  assertEqual(s.records["Largest commit"]?.[0], "+500 −0", "largest commit lines");
  assertEqual(s.biggest.text, "Messwerte Januar importieren · Jonas Becker", "largest commit message and author");

  // Treemap: top level of the repository.
  assertEqual(s.folder, "", "treemap at the root");
  const kinds = Object.fromEntries(s.tiles.map((tile) => [tile.path, tile.kind]));
  for (const folder of ["src", "docs", "daten"]) assertEqual(kinds[folder], "folder", `tile ${folder}`);
  assertEqual(kinds["README.md"], "file", "tile README.md");
  assert(!("funk" in kinds), "unmerged branch's folder not counted");
  assertMatch(s.tiles.find((tile) => tile.path === "src").label, /^src\/ – \d+ changes\. Open folder$/, "folder tile label");

  // Hotspots: commits × authors, from git – following renames, like `git log --follow`. (--follow
  // also follows copies; no file of this fixture resembles another, see fixtures `pathLineage`.)
  const gitCommits = (file) => repo.git("log", "--no-merges", "--follow", "--format=%ae", "HEAD", "--", file).split("\n").filter(Boolean);
  const top = gitCommits(repo.expected.topHotspot);
  same(s.hotspots[0], { path: repo.expected.topHotspot, commits: top.length, authors: new Set(top.map((mail) => mail.toLowerCase())).size, severity: s.hotspots[0].severity }, "top hotspot");
  for (const spot of s.hotspots) {
    const mails = gitCommits(spot.path);
    same({ commits: spot.commits, authors: spot.authors }, { commits: mails.length, authors: new Set(mails.map((mail) => mail.toLowerCase())).size }, `hotspot ${spot.path}`);
  }
  const { renamed } = repo.expected;
  const sinceRename = repo.git("log", "--no-merges", "--format=%H", "HEAD", "--", renamed.path).split("\n").filter(Boolean).length;
  const renamedSpot = s.hotspots.find((spot) => spot.path === renamed.path);
  assert(renamedSpot, `renamed file among the hotspots: ${s.hotspots.map((spot) => spot.path).join(", ")}`);
  assert(renamedSpot.commits > sinceRename, `commits from before the rename count: ${renamedSpot.commits} shown, ${sinceRename} since the rename`);
  assert(!s.hotspots.some((spot) => spot.path === renamed.from), "the old path is not listed");
  assert(!s.hotspots.some((spot) => spot.path === "funk/modul.rs"), "no file of the unmerged branch");

  // Authors: one row per person (address case folded), numbers from git numstat.
  const totals = authorTotals(repo);
  assertEqual(s.authors.length, Object.keys(totals).length, "author rows");
  assertEqual(s.authorsHint, `${Object.keys(totals).length} people`, "author count");
  for (const author of s.authors) {
    const expected = totals[author.email.toLowerCase()];
    assert(expected, `author ${author.email} known to git`);
    same({ commits: author.commits, added: author.added, removed: author.removed }, expected, `author ${author.email}`);
  }
  assertEqual(s.authors[0].email, PEOPLE.lena.email, "most active first");
  assertEqual(s.authors.filter((author) => author.name === "Jonas Becker").length, 1, "Jonas once despite two spellings of the address");
  assert(s.authors.some((author) => author.name === "Mehmet Yılmaz"), "name with dotless i");

  // Knowledge per folder: the weight is lines changed over the history, and the card says so.
  const knowledgeTexts = await app.exec((selector) => ({
    hint: document.querySelector(`${selector} [data-stats-section="knowledge"] h2 + span`)?.textContent.trim() ?? null,
    columns: [...document.querySelectorAll(`${selector} [data-stats-knowledge] thead th`)].map((el) => el.textContent.trim()),
  }), VIEW);
  same(knowledgeTexts, { hint: "share of changed lines per person · bus factor", columns: ["Folder", "Share of changed lines per person", "Bus factor"] }, "knowledge card names its weight honestly");
  checkKnowledge(s, repo);
  const station = s.knowledge.find((row) => row.folder === "src/station");
  if (station) assertEqual(station.label, "src/station/", "folder label");

  // Code age: buckets from git blame, binary files left out.
  const ages = codeAgeFromBlame(repo);
  const shown = Object.fromEntries(s.age.map((share) => [share.key, Number(/: ([\d,]+) lines?$/.exec(share.title)?.[1].replace(/,/g, "") ?? NaN)]));
  same(shown, ages, "code age buckets");
  const text = textLinesAt(repo);
  assertEqual(Object.values(shown).reduce((a, b) => a + b, 0), text.lines, "every line of every text file");
  assertEqual(s.ageHint, `lines in HEAD · ${text.files} largest text files`, "code age hint (bild.png left out)");
  await t.shot("stats-all-cards");
  await t.noConsoleErrors(app);
});

scenario("code age is measured against today: lines of a repository untouched for years count as older than two years", "edge", async (t) => {
  const repo = makeBareStatsRepo("ruhendes-archiv");
  repo.write("chronik.md", "Anfang\nMitte\nEnde\n");
  repo.commit(PEOPLE.lena, 1200, 10, "Chronik beginnen");
  repo.write("notizen.md", "Erste Notiz\nZweite Notiz\n");
  repo.commit(PEOPLE.aylin, 1100, 14, "Notizen");
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  const s = await waitStats(app, (stats) => stats.age.length > 0, "code age");
  const shown = Object.fromEntries(s.age.map((share) => [share.key, Number(/: ([\d,]+) lines?$/.exec(share.title)?.[1].replace(/,/g, "") ?? 0)]));
  same(shown, { month: 0, halfYear: 0, year: 0, twoYears: 0, older: 5 }, "every line is over two years old today, not measured against the last commit");
  same(shown, codeAgeFromBlame(repo), "code age buckets from git blame against now");
  await t.shot("stats-code-age-old-repo");
  await t.noConsoleErrors(app);
});

scenario("treemap: zoom into folders by click and keyboard, Up, a file opens its history", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app, tabId } = await openStatsRepo(t, repo);
  await clickStats(app);
  await waitStats(app, (s) => s.tiles.length > 0);
  await app.click(`${VIEW} [data-tile="src"]`);
  let s = await waitStats(app, (x) => x.folder === "src");
  assertEqual(s.tiles.map((tile) => tile.path).sort(), ["src/kalibrierung", "src/station"], "folders in src");
  const station = await app.$(`${VIEW} [data-tile="src/station"]`);
  await app.exec((el) => el.focus(), station);
  await app.press("Enter");
  s = await waitStats(app, (x) => x.folder === "src/station");
  assertEqual(s.tiles.map((tile) => `${tile.path}:${tile.kind}`).sort(), ["src/station/export.rs:file", "src/station/sensor.rs:file"], "files in src/station");
  const sensorChanges = repo.git("log", "--no-merges", "--follow", "--format=%H", "HEAD", "--", "src/station/sensor.rs").split("\n").filter(Boolean).length;
  assertEqual(s.tiles.find((tile) => tile.path === "src/station/sensor.rs").label, `src/station/sensor.rs – ${sensorChanges} changes. Show history`, "file tile label with git's count");
  await t.shot("stats-treemap-folder");
  const up = await app.waitFor(() => app.exec((selector) => [...document.querySelectorAll(`${selector} button`)].find((el) => el.innerText.trim() === "Up to src") ?? null, VIEW), 5000, { message: "Up to src" });
  await up.click();
  s = await waitStats(app, (x) => x.folder === "src");
  const root = await app.waitFor(() => app.exec((selector) => [...document.querySelectorAll(`${selector} button`)].find((el) => el.innerText.trim() === "Up to Repository") ?? null, VIEW), 5000, { message: "Up to Repository" });
  await root.click();
  await waitStats(app, (x) => x.folder === "");
  // Knowledge row opens its folder in the treemap.
  const knowledgeButton = await app.waitFor(() => app.exec((selector) => document.querySelector(`${selector} [data-stats-knowledge] tr[data-folder="src/station"] button`), VIEW), 5000, { message: "knowledge row src/station" }).catch(() => null);
  if (knowledgeButton) {
    await knowledgeButton.click();
    await waitStats(app, (x) => x.folder === "src/station", "knowledge row opens the folder");
  }
  // Back to the root, then a file tile with an odd name opens its history.
  await app.waitFor(async () => {
    if ((await readStats(app))?.folder === "") return true;
    const up = await app.exec((selector) => [...document.querySelectorAll(`${selector} [data-stats-section="treemap"] button`)].find((el) => /^Up to /.test(el.innerText.trim())) ?? null, VIEW);
    if (up) await up.click();
    return false;
  }, 10_000, { message: "treemap back at the root" });
  await app.click(`${VIEW} [data-tile="docs"]`);
  const docs = await waitStats(app, (x) => x.folder === "docs");
  const { renamed } = repo.expected;
  const renamedChanges = repo.git("log", "--no-merges", "--follow", "--format=%H", "HEAD", "--", renamed.path).split("\n").filter(Boolean).length;
  assertEqual(docs.tiles.find((tile) => tile.path === renamed.path)?.label, `${renamed.path} – ${renamedChanges} changes. Show history`, "renamed file: changes from before the rename count");
  assert(!docs.tiles.some((tile) => tile.path === renamed.from), "no tile for the old path");
  await app.click(`${VIEW} [data-tile="docs/Größen und Einheiten.md"]`);
  await waitCenter(app, tabId, "history");
  same((await view(app, tabId)).center, { kind: "history", path: "docs/Größen und Einheiten.md" }, "history of the umlaut file");
  await app.waitFor('[data-screen="file-history"]', 15_000);
  await t.noConsoleErrors(app);
});

scenario("commits over time: weeks and months", "edge", async (t) => {
  const repo = makeStatsRepo();
  const { app } = await openStatsRepo(t, repo);
  await clickStats(app);
  // About 800 days of history: more than 104 weeks, so months by default.
  const initial = await waitStats(app, (s) => s.bars.length > 0);
  assertMatch(initial.timeHint, /per month$/, "months by default for a history over two years");
  t.step(`default: ${initial.timeHint}, ${initial.bars.length} bars`);
  await app.click(`${VIEW} [data-value="months"]`);
  const months = await waitStats(app, (s) => /per month$/.test(s.timeHint));
  assertEqual(barTotal(months), repo.expected.commits, "months add up");
  const first = repo.counted[0];
  assertEqual(months.bars[0].period.slice(0, 7), dateOf(first.days).slice(0, 7), "first month is the first commit's");
  assert(months.bars.length >= 26 && months.bars.length <= 28, `one bar per month over ~800 days: ${months.bars.length}`);
  await app.click(`${VIEW} [data-value="weeks"]`);
  const weeks = await waitStats(app, (s) => /per week$/.test(s.timeHint));
  assertEqual(barTotal(weeks), repo.expected.commits, "weeks add up");
  assert(weeks.bars.length > 104, `one bar per week: ${weeks.bars.length}`);
  await t.noConsoleErrors(app);
});

scenario("empty states: no commits in the period, a repository without commits", "edge", async (t) => {
  const old = makeOldStatsRepo();
  const empty = makeBareStatsRepo("noch-leer");
  const { app } = await openStatsRepo(t, old);
  await clickStats(app);
  await waitStats(app, (s) => commitsHint(s) === 2);
  await choose(app, "Range", "Last 30 days");
  const none = await app.waitFor(async () => {
    const s = await readStats(app);
    return s && s.state === "ready" && s.sections.length === 0 && /No commits in this period/.test(s.text) ? s : null;
  }, 20_000, { message: "empty period" });
  assertIncludes(none.text, "Choose a longer period or another branch.", "hint of the empty state");
  await t.shot("stats-empty-period");
  await clickStats(app);

  const second = await app.openRepo(empty.path);
  await app.waitFor(() => statsButton(app), 15_000);
  await clickStats(app);
  await waitCenter(app, second.tabId, "stats");
  const unborn = await app.waitFor(async () => {
    const s = await readStats(app);
    return s && s.state !== "running" && /No commits yet/.test(s.text) ? s : null;
  }, 20_000, { message: "repository without commits" });
  assertIncludes(unborn.text, "The statistics appear after the first commit.", "hint of the unborn state");
  assert(!/No commits in this period|Choose a longer period/.test(unborn.text), `no period hint without any commit: ${unborn.text}`);
  assertEqual(unborn.status, null, "no 'up to date' claim without a commit");
  assertEqual(await selectText(app, "Branch"), "Branch main (HEAD)", "branch select for an unborn branch");
  // The first commit arrives: the view follows.
  empty.write("start.md", "Los geht's\n");
  empty.commit(PEOPLE.lena, 0, 10, "Erster Commit");
  await waitStats(app, (s) => commitsHint(s) === 1, "first commit counted", 30_000);
  await noDangerToasts(app);
  await t.noConsoleErrors(app);
});

scenario("many authors and odd file names", "edge", async (t) => {
  const repo = makeCrowdStatsRepo(14);
  const { app, tabId } = await openStatsRepo(t, repo);
  await clickStats(app);
  const s = await waitStats(app, (x) => commitsHint(x) === 14);
  assertEqual(s.authors.length, 8, "eight author rows");
  assertEqual(s.moreAuthors, "and 6 more authors", "the rest is counted");
  assertEqual(s.authorsHint, "14 people", "author count");
  checkKnowledge(s, repo);
  assert(s.knowledge.some((row) => row.bus > 1), `a folder with a bus factor above 1: ${JSON.stringify(s.knowledge.map((row) => [row.folder, row.bus]))}`);
  assertEqual(s.tiles.map((tile) => tile.path), ["tief"], "one top folder");
  await app.click(`${VIEW} [data-tile="tief"]`);
  await waitStats(app, (x) => x.folder === "tief");
  await app.click(`${VIEW} [data-tile="tief/ebene 0"]`);
  await waitStats(app, (x) => x.folder === "tief/ebene 0");
  await app.click(`${VIEW} [data-tile="tief/ebene 0/unter ordner"]`);
  await waitStats(app, (x) => x.folder === "tief/ebene 0/unter ordner");
  await app.click(`${VIEW} [data-tile="tief/ebene 0/unter ordner/ä ö ü"]`);
  const deep = await waitStats(app, (x) => x.folder === "tief/ebene 0/unter ordner/ä ö ü");
  const file = "tief/ebene 0/unter ordner/ä ö ü/datei #0 (kopie).txt";
  assert(deep.tiles.some((tile) => tile.path === file), `file with # and brackets: ${deep.tiles.map((tile) => tile.path).join(" | ")}`);
  await t.shot("stats-many-authors");
  const hotspot = await app.exec((selector, wanted) => [...document.querySelectorAll(`${selector} [data-hotspot]`)].find((el) => el.getAttribute("data-hotspot") === wanted) ?? null, VIEW, file);
  assert(hotspot, "odd file among the hotspots");
  await hotspot.click();
  await waitCenter(app, tabId, "history");
  assertEqual((await view(app, tabId)).center.path, file, "history of the odd file");
  await t.noConsoleErrors(app);
});

scenario("dark theme and German texts", "edge", async (t) => {
  const repo = makeStatsRepo();
  const app = await t.launch({ ...LAUNCH, theme: "dark", lang: "de" });
  const { tabId } = await app.openRepo(repo.path);
  const button = await app.waitFor(() => app.exec(() => {
    return [...document.querySelectorAll('[role="toolbar"] button')].find((el) => (el.innerText ?? "").split("\n").map((l) => l.trim()).includes("Statistik")) ?? null;
  }), 20_000, { message: "toolbar button Statistik" });
  await button.click();
  await waitCenter(app, tabId, "stats");
  const s = await app.waitFor(async () => {
    const x = await readStats(app);
    return x && x.state === "ready" && x.status?.kind !== "updating" && x.authors.length > 0 ? x : null;
  }, 30_000, { message: "Statistik bereit" });
  const titles = await app.exec((selector) => [...document.querySelectorAll(`${selector} [data-stats-section] h2`)].map((el) => el.textContent.trim()), VIEW);
  assertIncludes(titles, "Aktivität", "German card title");
  assertIncludes(titles, "Autoren", "German card title");
  assertIncludes(titles, "Wo sich etwas ändert", "German card title");
  const knowledgeColumns = await app.exec((selector) => [...document.querySelectorAll(`${selector} [data-stats-knowledge] thead th`)].map((el) => el.textContent.trim()), VIEW);
  assertIncludes(knowledgeColumns, "Anteil der geänderten Zeilen pro Person", "German knowledge column");
  assertMatch(s.status.text, /HEAD/, "status in German");
  assert(!/Up to date|Largest commit|Longest streak/.test(s.text), `no English left: ${s.text.slice(0, 200)}`);
  const dark = await app.exec(() => document.documentElement.getAttribute("data-theme") ?? (document.documentElement.classList.contains("dark") ? "dark" : null));
  t.step(`theme marker: ${dark}`);
  await t.shot("stats-dark-de");
  await t.noConsoleErrors(app);
});
