/**
 * commit-graph – commit graph in the real app, against real Git repositories.
 *
 *   node scripts/e2e/screens/commit-graph.mjs                 everything
 *   node scripts/e2e/screens/commit-graph.mjs --only large    only sections whose name contains the text
 *   node scripts/e2e/screens/commit-graph.mjs --no-shots      no screenshots to target/e2e/shots/
 *   node scripts/e2e/screens/commit-graph.mjs --show          visible window
 *
 * Checks: rows, labels and lanes against the repository (git itself as reference), the
 * drawing on the canvas pixel by pixel where lines and nodes must be, selection with mouse
 * and keyboard (one pass keyboard ONLY), columns including an app restart, checkout by
 * double-click (result in the repository), dragging labels, search hits, "show this commit",
 * hide/solo, empty repository, loading errors, 50,000 commits (time to the first row, frame
 * times while scrolling), 960×600, light theme. Plus: detached HEAD (notice, HEAD marker,
 * create branch here keyboard only), branch highlighting (pointer over a label and the sidebar,
 * keyboard focus, key B), ghost label, pinning a branch to the left (including a restart),
 * "only current branch, upstream and target", and the drop menu after a real drag (merge and
 * push verified in the repository or remote, pull request disabled).
 * Any console error fails the run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeEmptyRepo, makeLargeRepo, makeRichRepo } from "../fixtures.mjs";

const args = process.argv.slice(2);
const show = args.includes("--show");
const shots = !args.includes("--no-shots");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].toLowerCase() : null;
const SHOTS = "target/e2e/shots";

const failures = [];
const notes = [];
const numbers = {};
let current = "";
const check = (condition, message) => {
  if (!condition) {
    failures.push(`${current}: ${message}`);
    console.log(`  ✗ ${message}`);
  }
  return Boolean(condition);
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const note = (text) => {
  notes.push(`${current}: ${text}`);
  console.log(`  · ${text}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits up to `timeoutMs` for `read()` to return the expected value. */
const eventually = async (read, expected, message, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let actual = await read();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(60);
    actual = await read();
  }
  return equal(actual, expected, message);
};
const until = async (read, message, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!value && Date.now() < deadline) {
    await sleep(60);
    value = await read();
  }
  check(value, message);
  return value;
};

const apps = new Set();
const cleanups = [];
const section = async (name, run) => {
  if (only && !name.toLowerCase().includes(only)) return;
  current = name;
  const before = failures.length;
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    check(false, `aborted: ${error?.stack ?? error}`);
  }
  // Do not leave windows of an aborted section open.
  for (const app of [...apps]) await closeApp(app);
  console.log(`${failures.length === before ? "✓" : "✗"} ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};

async function open(options = {}) {
  const app = await launchApp({ show, ...options });
  apps.add(app);
  return app;
}
async function closeApp(app) {
  if (!apps.has(app)) return;
  apps.delete(app);
  for (const line of app.consoleErrors) check(false, `Console error: ${line}`);
  await app.close();
}
const shot = async (app, name) => {
  if (!shots) return;
  await app.settle().catch(() => undefined);
  await app.screenshot(`${SHOTS}/${name}.png`);
};

// ---------------------------------------------------------------------------
// Helpers in the page
// ---------------------------------------------------------------------------

const commitGraphScreen = '[data-screen="commit-graph"]';
const rowSel = (id) => `${commitGraphScreen} [data-row-id="${id}"]`;

/** Waits until the graph shows rows and nothing is loading anymore. */
async function graphReady(app) {
  await app.page.waitForSelector(`${commitGraphScreen} [data-row-kind="commit"], ${commitGraphScreen} [data-row-kind="merge"]`, { state: "attached", timeout: 60_000 });
  await app.settle(30_000);
}

/** What the list currently shows (only the rows in the DOM). */
const domRows = (app) =>
  app.page.evaluate((root) =>
    [...document.querySelectorAll(`${root} [role="row"][data-row-index]`)]
      .map((row) => ({
        index: Number(row.dataset.rowIndex),
        id: row.dataset.rowId,
        kind: row.dataset.rowKind,
        selected: row.getAttribute("aria-selected") === "true",
        active: row.dataset.active === "true",
        tabindex: row.tabIndex,
        hit: row.dataset.hit ?? null,
        refs: [...row.querySelectorAll("[data-ref-full]")].map((label) => label.dataset.refFull),
        text: (row.querySelector('[data-cell="message"]')?.innerText ?? "").replace(/\s+/g, " ").trim(),
      }))
      .sort((a, b) => a.index - b.index),
  commitGraphScreen);

/** All loaded rows from the query cache, in display order (index 0 = local changes). */
const loadedRows = (app, repoId) =>
  app.page.evaluate((id) => {
    const data = window.__gc.queryClient.getQueryData(["repo", id, "graph"]);
    if (!data) return null;
    const rows = [];
    let wip = null;
    for (const page of data.pages) for (const row of page.rows) row.kind === "wip" ? (wip = row) : rows.push(row);
    return [wip ?? { id: "wip", kind: "wip", sha: null, lane: -1, color: 0, edges: [], refs: [] }, ...rows].map((row) => ({ id: row.id, kind: row.kind, sha: row.sha, lane: row.lane, refs: row.refs.map((ref) => ref.fullName), isHead: row.isHead, summary: row.summary }));
  }, repoId);

const selection = (app, tabId) => app.page.evaluate((id) => window.__gc.store.getState().views[id]?.selection ?? { kind: "wip" }, tabId);
const focusedRow = (app) => app.page.evaluate(() => document.activeElement?.closest("[data-row-index]")?.getAttribute("data-row-id") ?? null);
const stats = (app) => app.page.evaluate(() => ({ ...window.__gcGraphStats }));
const menuItems = (app) => app.page.locator('[role="menu"] [role="menuitem"]').allInnerTexts();
const columnBoxes = (app) =>
  app.page.evaluate((root) => Object.fromEntries([...document.querySelectorAll(`${root} [role="columnheader"]`)].map((cell) => [cell.dataset.column, Math.round(cell.getBoundingClientRect().width)])), commitGraphScreen);
const columnOrder = (app) => app.page.evaluate((root) => [...document.querySelectorAll(`${root} [role="columnheader"]`)].map((cell) => cell.dataset.column), commitGraphScreen);
const storedColumns = async (app, repoId) => (await app.invoke("view_state_get", { repoId })).columns;

/**
 * Compares the drawing with the data: at every row boundary an edge crosses and in the
 * middle of every node the lane colour must be present. Checks the part of the list that
 * currently lies on the canvas.
 */
const checkCanvas = (app, repoId) =>
  app.page.evaluate((id) => {
    const data = window.__gc.queryClient.getQueryData(["repo", id, "graph"]);
    const rows = [];
    let wip = null;
    for (const page of data.pages) for (const row of page.rows) row.kind === "wip" ? (wip = row) : rows.push(row);
    rows.unshift(wip ?? { kind: "wip", lane: -1, color: 0, edges: [] });
    const canvas = document.querySelector("[data-graph-canvas]");
    const ctx = canvas.getContext("2d");
    const cssWidth = Number.parseFloat(canvas.style.width);
    const cssHeight = Number.parseFloat(canvas.style.height);
    const top = Number(/translateY\(([-\d.]+)px\)/.exec(canvas.style.transform)?.[1] ?? 0);
    const scale = canvas.width / cssWidth;
    const style = getComputedStyle(document.documentElement);
    const rowHeight = Number.parseFloat(style.getPropertyValue("--gc-size-graph-row"));
    const lane = Number.parseFloat(style.getPropertyValue("--gc-size-lane"));
    const node = Number.parseFloat(style.getPropertyValue("--gc-size-node"));
    const pad = 8;
    const toHex = (value) => {
      const probe = document.createElement("canvas").getContext("2d");
      probe.fillStyle = value;
      return probe.fillStyle;
    };
    const colors = Array.from({ length: 8 }, (_, index) => toHex(style.getPropertyValue(`--gc-lane-${index + 1}`).trim()));
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixel = (cssX, cssY) => {
      const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(cssX * scale)));
      const py = Math.min(canvas.height - 1, Math.max(0, Math.floor((cssY - top) * scale)));
      const at = (py * canvas.width + px) * 4;
      const [r, g, b, a] = image.data.slice(at, at + 4);
      return { a, color: `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}` };
    };
    const x = (index) => pad + index * lane + lane / 2;
    const problems = [];
    let edges = 0;
    let nodes = 0;
    let painted = 0;
    for (let index = 3; index < image.data.length; index += 4) if (image.data[index] > 0) painted++;
    const first = Math.ceil(top / rowHeight);
    const last = Math.min(rows.length - 1, Math.floor((top + cssHeight) / rowHeight) - 1);
    for (let index = first; index <= last; index++) {
      const row = rows[index];
      const y = index * rowHeight;
      for (const edge of row.edges) {
        if (x(Math.max(edge.top ?? 0, edge.bottom ?? 0)) + 2 > cssWidth) continue;
        const want = colors[((edge.color % 8) + 8) % 8];
        const points = [];
        if (edge.top !== null) points.push(["top", x(edge.top), y + 1]);
        if (edge.bottom !== null) points.push(["bottom", x(edge.bottom), y + rowHeight - 1.5]);
        if (edge.top !== null && edge.top === edge.bottom) points.push(["middle", x(edge.top), y + rowHeight / 2]);
        for (const [where, cssX, cssY] of points) {
          edges++;
          if (edge.dashed) {
            // Dashed: there must be a dash somewhere near the point.
            let found = false;
            for (let offset = -6; offset <= 6 && !found; offset++) found = pixel(cssX, Math.min(y + rowHeight - 0.5, Math.max(y, cssY + offset))).color === want && pixel(cssX, Math.min(y + rowHeight - 0.5, Math.max(y, cssY + offset))).a === 255;
            if (!found) problems.push(`row ${index}: dashed edge ${where} in lane ${edge.top ?? edge.bottom} missing`);
          } else {
            const got = pixel(cssX, cssY);
            if (got.a !== 255 || got.color !== want) problems.push(`row ${index}: edge ${where} (${edge.top}→${edge.bottom}) expected ${want}, got ${got.color} (α ${got.a})`);
          }
        }
      }
      if (row.lane < 0 || x(row.lane) + node / 2 > cssWidth) continue;
      nodes++;
      const want = colors[((row.color % 8) + 8) % 8];
      const centre = pixel(x(row.lane), y + rowHeight / 2);
      if (row.kind === "wip" || row.kind === "stash") {
        if (centre.a !== 0) problems.push(`row ${index}: ${row.kind} node must be empty inside`);
        const rim = pixel(x(row.lane) - node / 2 + 1, y + rowHeight / 2);
        if (row.kind === "stash" && rim.color !== want) problems.push(`row ${index}: stash node rim expected ${want}, got ${rim.color}`);
      } else if (centre.a !== 255 || centre.color !== want) {
        problems.push(`row ${index}: node expected ${want}, got ${centre.color} (α ${centre.a})`);
      }
    }
    return { edges, nodes, painted, problems, scale, backing: [canvas.width, canvas.height], css: [cssWidth, cssHeight], rows: [first, last] };
  }, repoId);

/** Presses Tab (or Shift+Tab) until `test` holds in the page. */
async function tabUntil(app, test, { shift = false, max = 150 } = {}) {
  for (let count = 0; count < max; count++) {
    if (await app.page.evaluate(test)) return count;
    await app.page.keyboard.press(shift ? "Shift+Tab" : "Tab");
  }
  return (await app.page.evaluate(test)) ? max : -1;
}
const inGraphRow = () => Boolean(document.activeElement?.closest('[data-screen="commit-graph"] [data-row-index]'));
// The column header itself – not the "only current branch …" toggle that sits in the Refs column.
const inGraphHeader = () => document.activeElement?.getAttribute("role") === "columnheader" && Boolean(document.activeElement.closest('[data-screen="commit-graph"]'));

const center = async (locator) => {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

/** IDs of the dimmed and non-dimmed commit rows in the DOM. */
const dimState = (app) =>
  app.page.evaluate((root) => {
    const rows = [...document.querySelectorAll(`${root} [role="row"][data-row-index]`)].filter((row) => row.dataset.rowKind === "commit" || row.dataset.rowKind === "merge");
    return { dim: rows.filter((row) => row.dataset.dim === "true").map((row) => row.dataset.rowId).sort(), bright: rows.filter((row) => row.dataset.dim !== "true").map((row) => row.dataset.rowId).sort() };
  }, commitGraphScreen);

/** All loaded rows with parents and colour (for chains and the drawing). */
const graphRows = (app, repoId) =>
  app.page.evaluate((id) => {
    const data = window.__gc.queryClient.getQueryData(["repo", id, "graph"]);
    const rows = [];
    let wip = null;
    for (const page of data.pages) for (const row of page.rows) row.kind === "wip" ? (wip = row) : rows.push(row);
    return [wip ?? { id: "wip", kind: "wip", sha: null, lane: -1, color: 0, parents: [] }, ...rows].map((row) => ({ sha: row.sha, kind: row.kind, lane: row.lane, color: row.color, parents: row.parents }));
  }, repoId);

/** Opacity and colour at the centre of the node of row `index`, if drawn in lane `lane`. */
const nodePixel = (app, index, lane) =>
  app.page.evaluate(
    ([row, at]) => {
      const canvas = document.querySelector("[data-graph-canvas]");
      const ctx = canvas.getContext("2d");
      const cssWidth = Number.parseFloat(canvas.style.width);
      const top = Number(/translateY\(([-\d.]+)px\)/.exec(canvas.style.transform)?.[1] ?? 0);
      const scale = canvas.width / cssWidth;
      const style = getComputedStyle(document.documentElement);
      const rowHeight = Number.parseFloat(style.getPropertyValue("--gc-size-graph-row"));
      const laneWidth = Number.parseFloat(style.getPropertyValue("--gc-size-lane"));
      const x = Math.floor((8 + at * laneWidth + laneWidth / 2) * scale);
      const y = Math.floor((row * rowHeight + rowHeight / 2 - top) * scale);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
      const data = ctx.getImageData(x, y, 1, 1).data;
      const toHex = (value) => {
        const probe = document.createElement("canvas").getContext("2d");
        probe.fillStyle = value;
        return probe.fillStyle;
      };
      const colors = Array.from({ length: 8 }, (_, lane) => toHex(style.getPropertyValue(`--gc-lane-${lane + 1}`).trim()));
      return { alpha: data[3], color: `#${[data[0], data[1], data[2]].map((part) => part.toString(16).padStart(2, "0")).join("")}`, colors };
    },
    [index, lane],
  );

/** Command via the command palette, keyboard only. */
async function runCommand(app, text, commandId) {
  const { page } = app;
  await page.keyboard.press("Control+p");
  await page.locator('[data-screen="command-palette"] input[role="combobox"]').waitFor({ timeout: 10_000 });
  await page.keyboard.type(`>${text}`, { delay: 5 });
  const keys = () => page.locator('[data-screen="command-palette"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.dataset.key));
  await until(async () => (await keys()).includes(`command:${commandId}`), `the palette finds "${text}"`);
  const at = (await keys()).indexOf(`command:${commandId}`);
  for (let step = 0; step < at; step++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await eventually(() => page.locator('[data-screen="command-palette"]').count(), 0, "the palette is closed again");
}

const closeToasts = async (app) => {
  for (let round = 0; round < 10 && (await app.page.locator("[data-toast]").count()) > 0; round++) {
    await app.page.getByRole("button", { name: "Close message" }).first().click();
    await sleep(120);
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Fixtures come from a cache shared by several processes; if another process is building it,
 * copying can fail once. Then wait briefly and try again.
 */
function fixture(make) {
  for (let attempt = 1; ; attempt++) {
    try {
      return make();
    } catch (error) {
      if (attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    }
  }
}

const rich = fixture(() => makeRichRepo());
const clean = fixture(() => makeRichRepo({ dirty: false }));
cleanups.push(() => rich.cleanup(), () => clean.cleanup());
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-s06-data-"));
cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const gitLines = (repo, ...gitArgs) => repo.git(...gitArgs).split(/\r?\n/).filter(Boolean);
const refsOf = (repo) => gitLines(repo, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags").filter((name) => !name.endsWith("/HEAD"));
const commitsOf = (repo) => gitLines(repo, "rev-list", "--topo-order", "HEAD", "--branches", "--remotes", "--tags");

try {
  // =========================================================================================
  await section("Populated: rows, labels, lanes, local changes, stashes", async () => {
    const app = await open({ width: 1440, height: 900, theme: "dark" });
    const { repoId, tabId } = await app.openRepo(rich.path);
    await graphReady(app);
    const { page } = app;

    // Rows against git
    const rows = await loadedRows(app, repoId);
    const commits = commitsOf(rich);
    const shown = rows.filter((row) => row.kind === "commit" || row.kind === "merge").map((row) => row.sha);
    equal(shown.length, commits.length, "number of commits as git rev-list");
    equal([...shown].sort(), [...commits].sort(), "same commits as git rev-list");
    equal(rows[0].kind, "wip", "the local changes row is at the top");
    equal(rows.filter((row) => row.kind === "stash").length, gitLines(rich, "stash", "list").length, "one row per stash");
    const merges = gitLines(rich, "rev-list", "--merges", "HEAD", "--branches", "--remotes", "--tags");
    equal(rows.filter((row) => row.kind === "merge").map((row) => row.sha).sort(), [...merges].sort(), "merge commits as git rev-list --merges");
    // Every commit is above its parents.
    const position = new Map(rows.map((row, index) => [row.sha, index]));
    for (const line of gitLines(rich, "rev-list", "--parents", "HEAD", "--branches", "--remotes", "--tags")) {
      const [sha, ...parents] = line.split(" ");
      for (const parent of parents) if (!(position.get(sha) < position.get(parent))) check(false, `commit ${sha.slice(0, 7)} is not above its parent ${parent.slice(0, 7)}`);
    }

    // DOM: roles, all rows (23 fit in the window), footer
    const dom = await domRows(app);
    equal(dom.length, rows.length, "all rows are in the DOM");
    equal(await page.locator(`${commitGraphScreen} [role="grid"]`).getAttribute("aria-label"), "Commit graph", "role=grid with a name");
    check((await page.locator(`${commitGraphScreen} [role="row"] [role="gridcell"]`).count()) >= rows.length * 5, "cells are role=gridcell");
    equal(await page.locator(`${commitGraphScreen} canvas`).getAttribute("aria-hidden"), "true", "canvas is aria-hidden");
    equal(await page.locator(`${commitGraphScreen} [data-graph-footer]`).innerText(), `End of history · ${commits.length} commits`, "footer");
    equal(dom.filter((row) => row.tabindex === 0).length, 1, "exactly one row is reachable by Tab");

    // Labels against git for-each-ref
    const labels = dom.flatMap((row) => row.refs).sort();
    equal(labels, refsOf(rich).sort(), "labels as git for-each-ref");
    for (const ref of refsOf(rich)) {
      const sha = rich.git("rev-parse", `${ref}^{commit}`);
      const row = dom.find((candidate) => candidate.refs.includes(ref));
      if (!check(row?.id === sha, `label ${ref} is on commit ${sha.slice(0, 7)}`)) break;
    }
    const head = rich.git("rev-parse", "HEAD");
    check((await page.locator(`${rowSel(head)} [data-ref-full="refs/heads/main"] span[title]`).getAttribute("title")).includes("checked out"), "the checked-out branch is labelled as such");
    check((await page.locator(`${rowSel(head)} [data-ref-full="refs/heads/main"] svg`).first().getAttribute("class")).includes("lucide-check"), "the checked-out branch carries the check mark");
    // Local branch and its remote branch on the same commit: merged (cloud instead of a second label)
    const wind = rich.git("rev-parse", "feature/wind-diagramm");
    equal(await page.locator(`${rowSel(wind)} [data-ref-full="refs/remotes/origin/feature/wind-diagramm"] svg`).count(), 1, "remote twin shows only the icon");
    check((await page.locator(`${rowSel(wind)} [data-ref-full="refs/remotes/origin/feature/wind-diagramm"]`).getAttribute("title")).includes("origin/feature/wind-diagramm"), "remote twin names itself in the tooltip");

    // Local changes: count from the status, own wording
    const changed = new Set(rich.git("status", "--porcelain", "-uall").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).split(" -> ").pop().replace(/^"|"$/g, "")));
    const staged = gitLines(rich, "diff", "--cached", "--name-only").length;
    check(dom[0].text.startsWith(`${changed.size} changed files`), `local changes: "${dom[0].text}" starts with "${changed.size} changed files"`);
    check(dom[0].text.includes(`${staged} staged`), `local changes mention ${staged} staged`);
    equal(dom[0].selected, true, "local changes are selected at the start");
    // Stash rows: text without the Git prefix
    const stashRows = dom.filter((row) => row.kind === "stash");
    equal(stashRows.map((row) => row.text.replace(/ Lena.*$/, "")), rich.info.stashes.map((name) => `${name} on main`), "stash rows");

    // Drawing
    const drawn = await checkCanvas(app, repoId);
    equal(drawn.problems, [], "canvas: edges and nodes lie where the data requires");
    check(drawn.edges >= 60 && drawn.nodes === rows.length, `canvas: ${drawn.edges} edge points and ${drawn.nodes} nodes checked`);
    equal(drawn.scale, await page.evaluate(() => window.devicePixelRatio), "canvas: one pixel per device pixel");
    numbers.richCanvas = `${drawn.edges} edge points, ${drawn.nodes} nodes`;

    // Long summary: truncated, full text in the tooltip, nothing overflows
    const long = rich.info.shas.longSummary;
    const cut = await page.locator(`${rowSel(long)} [data-cell="message"] span[title]`).evaluate((span) => ({ title: span.title, clipped: span.scrollWidth > span.clientWidth }));
    equal(cut.title, rich.git("log", "-1", "--format=%s", long), "long summary is complete in the tooltip");
    check(cut.clipped, "long summary is truncated");
    equal(await page.evaluate(() => { const s = document.querySelector("[data-graph-scroller]"); return s.scrollWidth - s.clientWidth; }), 0, "the list does not overflow horizontally");

    // Date: relative, exact time in the tooltip
    const date = page.locator(`${rowSel(head)} [data-cell="date"]`);
    check(/^\d+ (months|days|weeks|years) ago|yesterday|last/.test(await date.innerText()), `date relative: "${await date.innerText()}"`);
    // Local time and UTC, both readable (BUG-089): "Mar 2, 2026, 8:50 PM (Mar 2, 2026, 7:50 PM UTC)".
    check(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M \([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M UTC\)/.test(await date.getAttribute("title")), `date: exact time in the tooltip (${await date.getAttribute("title")})`);

    await shot(app, "commit-graph");

    // Hover highlights
    await page.locator(rowSel(commits[5])).hover();
    const hover = await page.locator(rowSel(commits[5])).evaluate((row) => getComputedStyle(row).backgroundColor);
    check(hover !== "rgba(0, 0, 0, 0)", "hover colours the row");

    // Light theme: the canvas redraws in the theme's colours
    await app.setTheme("light");
    await until(async () => (await checkCanvas(app, repoId)).problems.length === 0, "canvas follows the theme change");
    await shot(app, "commit-graph-light");
    await app.setTheme("dark");
    await until(async () => (await checkCanvas(app, repoId)).problems.length === 0, "canvas follows the theme change back");

    // App zoom: the canvas gets more pixels, the lines stay on the rows
    await page.evaluate(() => document.documentElement.style.setProperty("zoom", "1.25"));
    await until(async () => (await checkCanvas(app, repoId)).scale === 1.25, "canvas accounts for the zoom (1.25 pixels per CSS pixel)");
    equal((await checkCanvas(app, repoId)).problems, [], "canvas at 125 % zoom");
    if (shots) await app.screenshot("target/e2e/s06/zoom-125.png");
    await page.evaluate(() => document.documentElement.style.setProperty("zoom", "1"));
    await until(async () => (await checkCanvas(app, repoId)).scale === 1, "canvas back at 100 % zoom");

    // 960×600
    await app.setSize(960, 600);
    await app.settle();
    const narrow = await columnBoxes(app);
    check(narrow.message >= 160, `960×600: Message is ${narrow.message} px (at least 160)`);
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "960×600: no page overflow");
    equal((await checkCanvas(app, repoId)).problems, [], "960×600: canvas is correct");
    await shot(app, "commit-graph-min");
    await app.setSize(1440, 900);
    void tabId;
    await closeApp(app);
  });

  // =========================================================================================
  await section("Mouse selection: click, Ctrl, Shift, no redraw of all rows", async () => {
    const app = await open({ width: 1440, height: 900, theme: "dark" });
    const { repoId, tabId } = await app.openRepo(rich.path);
    await graphReady(app);
    const { page } = app;
    const rows = await loadedRows(app, repoId);
    const commitRows = rows.filter((row) => row.kind === "commit" || row.kind === "merge");
    const [a, b, c, d, e] = commitRows.map((row) => row.sha);

    await page.locator(rowSel(a)).click();
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [a] }, "click selects the commit");
    equal((await domRows(app)).filter((row) => row.selected).map((row) => row.id), [a], "aria-selected follows");

    // Row renders on a selection change
    await app.settle();
    const before = await stats(app);
    await page.locator(rowSel(c)).click();
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [c] }, "second click replaces the selection");
    await app.settle();
    const after = await stats(app);
    numbers.rowRendersPerSelection = after.rowRenders - before.rowRenders;
    check(after.rowRenders - before.rowRenders <= 4, `selection change re-renders ${after.rowRenders - before.rowRenders} rows (at most 4 of ${rows.length})`);
    equal(after.paints, before.paints, "selection change does not redraw the canvas");

    await page.locator(rowSel(e)).click({ modifiers: ["Control"] });
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [c, e] }, "Ctrl+click adds");
    await page.locator(rowSel(c)).click({ modifiers: ["Control"] });
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [e] }, "Ctrl+click removes again");
    await page.locator(rowSel(b)).click();
    await page.locator(rowSel(e)).click({ modifiers: ["Shift"] });
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [b, c, d, e] }, "Shift+click selects the range, the clicked commit is the active one");
    equal((await domRows(app)).filter((row) => row.active).map((row) => row.id), [e], "the active row is the last selected");
    await shot(app, "commit-graph-multiselect");
    await page.locator(rowSel(a)).click({ modifiers: ["Shift"] });
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [b, a] }, "Shift+click upwards starts from the same anchor");

    // Stash and local changes
    const stash = rows.find((row) => row.kind === "stash");
    await page.locator(rowSel(stash.id)).click();
    await eventually(async () => (await selection(app, tabId)).kind, "stash", "clicking a stash row selects the stash");
    await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).click();
    await eventually(() => selection(app, tabId), { kind: "wip" }, "click on the local changes");

    // Right-clicking an unselected row selects it; the menu appears once it has entries
    await page.locator(rowSel(d)).click({ button: "right" });
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [d] }, "right-click selects the row");
    await sleep(300);
    if ((await page.locator('[role="menu"]').count()) > 0) {
      check((await menuItems(app)).length > 0, "commit context menu has entries");
      equal(await page.locator('[role="menu"]').getAttribute("aria-label"), `Actions for commit ${d.slice(0, 7)}`, "context menu names the commit");
      await page.keyboard.press("Escape");
      await eventually(() => page.locator('[role="menu"]').count(), 0, "Esc closes the context menu");
      await eventually(() => focusedRow(app), d, "after the menu, focus is back on the row");
    } else {
      note("commitMenu has no entries yet – opening the commit menu is not checked");
    }
    // Right-click on a label: branch menu
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/feature/luftdruck"]`).click({ button: "right" });
    await sleep(300);
    if ((await page.locator('[role="menu"]').count()) > 0) {
      const label = await page.locator('[role="menu"]').getAttribute("aria-label");
      check(/feature\/luftdruck|Commit/.test(label ?? ""), `right-clicking a label opens a menu (${label})`);
      await page.keyboard.press("Escape");
    } else {
      note("branchMenu has no entries yet – opening the branch menu is not checked");
    }
    await closeApp(app);
  });

  // =========================================================================================
  await section("Keyboard only: navigation, range, details, columns – and columns after a restart", async () => {
    let app = await open({ width: 1440, height: 900, theme: "dark", dataDir });
    let { repoId, tabId } = await app.openRepo(rich.path);
    await graphReady(app);
    let { page } = app;
    const rows = await loadedRows(app, repoId);
    const headBefore = rich.git("rev-parse", "HEAD");
    const statusBefore = rich.git("status", "--porcelain");

    // Into the list: Tab only
    await page.evaluate(() => document.activeElement?.blur());
    const tabs = await tabUntil(app, inGraphRow);
    check(tabs >= 0, "the list is reachable with Tab");
    numbers.tabStopsToGraph = tabs;
    equal(await focusedRow(app), "wip", "Tab lands on the active row (local changes)");
    check(await page.evaluate(() => document.activeElement.matches(":focus-visible")), "focus is visible");

    // Arrows, J/K
    await page.keyboard.press("ArrowDown");
    await eventually(async () => (await selection(app, tabId)).kind, "stash", "arrow down: first stash row");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[3].sha] }, "three times arrow down: the topmost commit");
    await eventually(() => focusedRow(app), rows[3].id, "focus moves along");
    await page.keyboard.press("j");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[4].sha] }, "J moves one row down");
    await page.keyboard.press("k");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[3].sha] }, "K moves one row up");
    // Shift extends
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[3].sha, rows[4].sha, rows[5].sha] }, "Shift+arrow extends the range");
    await eventually(() => focusedRow(app), rows[5].id, "focus at the end of the range");
    await page.keyboard.press("Shift+ArrowUp");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[3].sha, rows[4].sha] }, "Shift+arrow up shrinks it");
    await page.keyboard.press("Shift+J");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[3].sha, rows[4].sha, rows[5].sha] }, "Shift+J extends likewise");
    // Home, End, PgUp/PgDn
    await page.keyboard.press("End");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows.at(-1).sha] }, "End: last row");
    await eventually(() => focusedRow(app), rows.at(-1).id, "focus on the last row");
    await page.keyboard.press("Home");
    await eventually(() => selection(app, tabId), { kind: "wip" }, "Home: first row");
    await page.keyboard.press("PageDown");
    const afterPage = await selection(app, tabId);
    check(afterPage.kind === "commits" && rows.findIndex((row) => row.sha === afterPage.shas[0]) >= 10, "PgDn jumps by one window height");
    await page.keyboard.press("PageUp");
    await eventually(() => selection(app, tabId), { kind: "wip" }, "PgUp jumps back");
    // Ctrl+J belongs to the shell (sidebar), not the list
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[4].sha] }, "back on a commit");

    // Enter opens the details: commit panel visible, focus inside
    await page.evaluate((id) => window.__gc.store.getState().setRightCollapsed(id, true), tabId);
    await eventually(() => page.locator('[data-area="right"]').count(), 0, "commit panel is collapsed");
    await tabUntil(app, inGraphRow, { shift: true });
    await page.keyboard.press("Enter");
    await eventually(() => page.locator('[data-area="right"]').count(), 1, "Enter expands the commit panel");
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [rows[4].sha] }, "Enter keeps the selection");
    await until(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="right"]'))), "Enter: focus goes into the commit panel");

    // Back into the list, menu key
    check((await tabUntil(app, inGraphRow, { shift: true })) >= 0, "back into the list with Shift+Tab");
    equal(await focusedRow(app), rows[4].id, "the list's tab stop is the active row");
    await page.keyboard.press("Shift+F10");
    await sleep(300);
    if ((await page.locator('[role="menu"]').count()) > 0) {
      check((await menuItems(app)).length > 0, "Shift+F10 opens the context menu");
      await page.keyboard.press("Escape");
      await eventually(() => focusedRow(app), rows[4].id, "Esc returns focus to the row");
    } else {
      note("commitMenu has no entries yet – Shift+F10 on a row is not checked");
    }

    // Column header: Shift+Tab, width, order, menu
    check((await tabUntil(app, inGraphHeader, { shift: true, max: 6 })) >= 0, "Shift+Tab from the list lands in the column header");
    const widths = await columnBoxes(app);
    equal(await columnOrder(app), ["refs", "graph", "message", "author", "date"], "columns at the start");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await eventually(async () => (await columnBoxes(app)).refs, widths.refs + 16, "Shift+→ makes the column wider");
    await page.keyboard.press("Shift+ArrowLeft");
    await eventually(async () => (await columnBoxes(app)).refs, widths.refs + 8, "Shift+← makes it narrower");
    await page.keyboard.press("End");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-column")), "date", "End: last column");
    await page.keyboard.press("ArrowLeft");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-column")), "author", "arrow switches the column");
    await page.keyboard.press("Control+ArrowRight");
    await eventually(() => columnOrder(app), ["refs", "graph", "message", "date", "author"], "Ctrl+→ moves the column to the right");
    // The rows follow the order
    equal(
      await page.locator(`${rowSel(rows[4].id)} [role="gridcell"]`).evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width))),
      Object.values(await columnBoxes(app)),
      "cells sit under their column headers",
    );
    await page.keyboard.press("Enter");
    await eventually(() => page.locator('[role="menu"]').count(), 1, "Enter opens the column menu");
    const entries = await menuItems(app);
    check(entries.includes("SHA") && entries.includes("Reset all columns"), `column menu: ${entries.join(" | ")}`);
    if (shots) await shot(app, "commit-graph-columns");
    await page.keyboard.press("s");
    // Selecting by first letter moves focus a moment later.
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "SHA", "first letter jumps to the \"SHA\" entry");
    await page.keyboard.press("Enter");
    await eventually(() => columnOrder(app), ["refs", "graph", "message", "date", "author", "sha"], "SHA column shown");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("data-column")), "author", "after the menu, focus is back on the column header");
    check(/^[0-9a-f]{7}$/.test(await page.locator(`${rowSel(rows[4].id)} [data-cell="sha"]`).innerText()), "SHA column shows the short SHA");

    // Stored in the core
    const expected = [
      { id: "refs", visible: true, width: widths.refs + 8 },
      { id: "graph", visible: true, width: null },
      { id: "message", visible: true, width: null },
      { id: "date", visible: true, width: null },
      { id: "author", visible: true, width: null },
      { id: "sha", visible: true, width: null },
    ];
    await eventually(() => storedColumns(app, repoId), expected, "columns are in the repository's view state");

    // None of this touched the repository
    equal(rich.git("rev-parse", "HEAD"), headBefore, "HEAD unchanged");
    equal(rich.git("status", "--porcelain"), statusBefore, "working tree unchanged");
    await closeApp(app);

    // Restart with the same data directory
    app = await open({ width: 1440, height: 900, theme: "dark", dataDir });
    ({ repoId, tabId } = await app.openRepo(rich.path));
    await graphReady(app);
    ({ page } = app);
    await eventually(() => columnOrder(app), ["refs", "graph", "message", "date", "author", "sha"], "after a restart: order and SHA column are back");
    equal((await columnBoxes(app)).refs, widths.refs + 8, "after a restart: width of the Refs column");

    // Mouse: drag the width, double-click resets
    const handle = page.locator(`${commitGraphScreen} [data-resize="graph"]`);
    const grip = await center(handle);
    const graphBefore = (await columnBoxes(app)).graph;
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 30, grip.y, { steps: 4 });
    await eventually(async () => (await columnBoxes(app)).graph, graphBefore + 30, "dragging the grip changes the width immediately");
    equal((await checkCanvas(app, repoId)).css[0], graphBefore + 30, "the canvas follows the width");
    await page.mouse.up();
    await eventually(async () => (await storedColumns(app, repoId)).find((column) => column.id === "graph").width, graphBefore + 30, "the dragged width is stored");
    await handle.dblclick();
    await eventually(async () => (await storedColumns(app, repoId)).find((column) => column.id === "graph").width, null, "double-clicking the grip resets the width");
    equal((await columnBoxes(app)).graph, graphBefore, "graph column fits the lanes again");

    // Mouse: drag a column header
    const author = await center(page.locator(`${commitGraphScreen} [data-column="author"]`));
    const dateBox = await center(page.locator(`${commitGraphScreen} [data-column="date"]`));
    await page.mouse.move(author.x, author.y);
    await page.mouse.down();
    await page.mouse.move(author.x - 20, author.y, { steps: 3 });
    await page.mouse.move(dateBox.x - 10, dateBox.y, { steps: 5 });
    await eventually(() => columnOrder(app), ["refs", "graph", "message", "author", "date", "sha"], "dragging a column header reorders");
    await page.mouse.up();
    await eventually(async () => (await storedColumns(app, repoId)).map((column) => column.id), ["refs", "graph", "message", "author", "date", "sha"], "the dragged order is stored");

    // Right-click on the header: reset everything
    await page.locator(`${commitGraphScreen} [data-column="message"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reset all columns" }).click();
    await eventually(() => storedColumns(app, repoId), [
      { id: "refs", visible: true, width: null },
      { id: "graph", visible: true, width: null },
      { id: "message", visible: true, width: null },
      { id: "author", visible: true, width: null },
      { id: "date", visible: true, width: null },
      { id: "sha", visible: false, width: null },
    ], "\"Reset all columns\" restores the default");
    await eventually(() => columnOrder(app), ["refs", "graph", "message", "author", "date"], "header shows the default again");
    await closeApp(app);
  });

  // =========================================================================================
  await section("Clean repository: double-click checks out, local changes come and go", async () => {
    const app = await open({ width: 1440, height: 900, theme: "dark" });
    const { repoId, tabId } = await app.openRepo(clean.path);
    await graphReady(app);
    const { page } = app;
    const wipText = () => page.locator(`${commitGraphScreen} [data-row-kind="wip"] [data-cell="message"]`).innerText();
    equal(await wipText(), "No changes", "without changes there is a calm row");
    equal((await loadedRows(app, repoId))[0].lane, -1, "without changes the row has no node");

    // Double-click on a branch label
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/feature/wind-diagramm"]`).dblclick();
    await eventually(() => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/wind-diagramm", "double-clicking a branch label checks out the branch (in the repository)");
    await until(async () => (await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/feature/wind-diagramm"] span[title]`).getAttribute("title"))?.includes("checked out"), "the label then carries the check mark");
    await app.settle();
    // Double-click on a row with a branch
    const luftdruck = clean.git("rev-parse", "feature/luftdruck");
    await page.locator(`${rowSel(luftdruck)} [data-cell="message"]`).dblclick();
    await eventually(() => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/luftdruck", "double-clicking a row with a branch label checks out that branch");
    // Git has already moved HEAD while the checkout is still running in the app (the core reads the
    // status afterwards). A double-click during that time counts as "already running" and is dropped
    // silently – seen in one of three runs. Only continue once the action is done (no lock left).
    await eventually(() => page.evaluate(() => Object.keys(window.__gc.store.getState().busy).length), 0, "the checkout has finished in the app");
    await app.settle();
    // Double-click on a row with a remote branch creates the local one
    const karte = clean.git("rev-parse", "origin/feature/temperatur-karte");
    await page.locator(`${rowSel(karte)} [data-cell="message"]`).dblclick();
    await eventually(() => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/temperatur-karte", "double-clicking a row with a remote branch creates the local branch and checks it out");
    equal(clean.git("rev-parse", "--abbrev-ref", "feature/temperatur-karte@{upstream}"), "origin/feature/temperatur-karte", "the new branch tracks the remote branch");
    await app.settle();

    // Double-click on a commit without a branch: confirmation, focus on "Cancel"
    const plain = clean.info.shas.csv;
    await page.locator(`${rowSel(plain)} [data-cell="message"]`).dblclick();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await dialog.waitFor();
    check((await dialog.innerText()).includes(`Check out commit ${plain.slice(0, 7)}?`), "confirmation names the commit");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on \"Cancel\"");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    equal(clean.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/temperatur-karte", "Cancel leaves HEAD as it was");
    await page.locator(`${rowSel(plain)} [data-cell="message"]`).dblclick();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Check out commit" }).click();
    await eventually(() => clean.git("rev-parse", "HEAD"), plain, "after confirming, HEAD points to the commit");
    equal(clean.git("rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "… detached (detached HEAD)");
    await app.settle();
    await until(async () => (await loadedRows(app, repoId)).find((row) => row.sha === plain)?.isHead, "the graph marks the checked-out commit");
    equal((await checkCanvas(app, repoId)).problems, [], "canvas after the checkout");

    // Detached HEAD: notice above the graph, "HEAD" marker on the commit, banner in the commit panel, way out "Create branch here".
    await closeToasts(app);
    const detachedBar = page.locator(`${commitGraphScreen} [data-graph-detached]`);
    await detachedBar.waitFor();
    const barText = (await detachedBar.innerText()).replace(/\s+/g, " ");
    check(barText.includes("No branch checked out (detached HEAD)") && barText.includes(plain.slice(0, 7)) && barText.includes("Create branch here"), `notice above the graph: ${barText}`);
    equal(await detachedBar.getAttribute("role"), "status", "the notice is a status for screen readers");
    equal(await detachedBar.locator("svg").count(), 1, "with an icon, not just colour");
    equal(await page.locator(`${rowSel(plain)} [data-head-detached]`).innerText().then((text) => text.replace(/\s+/g, " ").trim()), "HEAD (no branch checked out)", "the checked-out commit carries the \"HEAD\" marker");
    equal(await page.locator(`${commitGraphScreen} [data-head-detached]`).count(), 1, "only this one");
    const smartToggle = page.locator(`${commitGraphScreen} [data-smart-toggle]`);
    equal(await smartToggle.getAttribute("aria-disabled"), "true", "\"only current branch …\" is disabled without a branch");
    check((await smartToggle.getAttribute("aria-label")).includes("No branch checked out"), "… and says why");
    check((await page.locator("[data-shell] footer").last().innerText()).includes(`HEAD detached at ${plain.slice(0, 7)}`), "the status bar names the detached HEAD");
    await shot(app, "commit-graph-detached");
    await app.setTheme("light");
    await shot(app, "commit-graph-detached-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "960×600 with the notice: nothing overflows");
    check(await detachedBar.getByRole("button", { name: "Create branch here …" }).isVisible(), "960×600: the way out stays visible");
    await shot(app, "commit-graph-detached-min");
    await app.setSize(1440, 900);
    await sleep(300);
    // Select local changes: the commit panel warns as well.
    await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).click();
    await page.locator('[data-area="right"]').getByText("No branch checked out (detached HEAD)").waitFor({ timeout: 5000 });
    check(true, "the commit panel shows the banner for the local changes");
    // Keyboard only: to the button in the notice, Enter, type a name, Enter.
    await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).focus();
    const steps = await tabUntil(app, () => document.activeElement?.closest("[data-graph-detached]") !== null && document.activeElement?.tagName === "BUTTON", { shift: true, max: 40 });
    check(steps >= 0, "Shift+Tab reaches \"Create branch here …\" in the notice");
    await page.keyboard.press("Enter");
    const branchDialog = page.getByRole("dialog", { name: "New branch" });
    await branchDialog.waitFor();
    check((await branchDialog.innerText()).includes("at the current commit"), "the dialog says where the branch starts");
    await page.keyboard.type("rettung/aus dem nichts");
    await page.keyboard.press("Enter");
    await eventually(() => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "rettung/aus-dem-nichts", "the new branch is checked out (spaces became \"-\")");
    equal(clean.git("rev-parse", "rettung/aus-dem-nichts"), plain, "… and starts at the detached commit");
    await eventually(() => detachedBar.count(), 0, "the notice disappears");
    await eventually(() => page.locator(`${commitGraphScreen} [data-head-detached]`).count(), 0, "the \"HEAD\" marker too");
    await until(async () => (await page.locator(`${rowSel(plain)} [data-ref-full="refs/heads/rettung/aus-dem-nichts"] span[title]`).getAttribute("title").catch(() => ""))?.includes("checked out"), "instead the commit carries the new branch's label with the check mark");
    await closeToasts(app);
    await app.settle();

    // back to main
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/main"]`).dblclick();
    await eventually(() => clean.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "back to main");
    // Otherwise the pointer rests on the label and highlights main (the rest would be dimmed).
    await page.mouse.move(900, 700);
    await eventually(async () => (await dimState(app)).dim, [], "pointer away from the label: nothing is dimmed");
    await app.settle();

    // Change a file (from outside): row and lane appear without anyone reloading
    const selectedBefore = await selection(app, tabId);
    clean.write("notizen/neu.txt", "Neue Notiz.\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(wipText, "1 changed file", "a new file: \"1 changed file\"", 20_000);
    await until(async () => (await loadedRows(app, repoId))[0].lane >= 0, "the graph reloads the row with a lane", 20_000);
    await app.settle();
    equal((await checkCanvas(app, repoId)).problems, [], "canvas with the new dashed lane");
    equal(await selection(app, tabId), selectedBefore, "the selection stays put");
    fs.rmSync(path.join(clean.path, "notizen"), { recursive: true });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(wipText, "No changes", "file gone again: \"No changes\"", 20_000);
    await until(async () => (await loadedRows(app, repoId))[0].lane === -1, "the lane disappears again", 20_000);

    // Blocked checkout: the checkout action's confirmation says what is in the way; Cancel changes nothing
    clean.write("README.md", "lokal überschrieben\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await eventually(wipText, "1 changed file", "changed README", 20_000);
    await page.locator(`${rowSel(clean.info.shas.first)} [data-cell="message"]`).dblclick();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Check out commit" }).click();
    const blocked = await until(async () => {
      const texts = await page.locator('[role="dialog"], [role="alertdialog"], [data-toast="danger"]').allInnerTexts();
      return texts.find((text) => /blocking|failed/.test(text)) ?? null;
    }, "a blocked checkout reports itself");
    check(/README\.md|overwrite/.test(blocked ?? ""), `message names the reason: ${String(blocked).replace(/\s+/g, " ").slice(0, 160)}`);
    await page.keyboard.press("Escape");
    await sleep(300);
    equal(clean.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "HEAD stays on main");
    equal(clean.git("status", "--porcelain"), " M README.md", "the change is still there");
    clean.git("checkout", "--", "README.md");
    await closeApp(app);
  });

  // =========================================================================================
  await section("Dragging labels, search hits, show commit, hide/solo, many labels", async () => {
    // Extra refs: a 60-character branch name and so many labels on one commit that "+N" is needed.
    const extra = fixture(() => makeRichRepo({ dirty: false }));
    cleanups.push(() => extra.cleanup());
    const crowded = extra.info.shas.secondMerge;
    const longName = "release/fruehjahr-2026-auswertung-station-nord-mit-plausibilitaet";
    extra.git("branch", longName, crowded);
    for (const tag of ["kandidat-1", "kandidat-2", "kandidat-3", "abnahme-kollegium"]) extra.git("tag", tag, crowded);

    const app = await open({ width: 1440, height: 900, theme: "dark" });
    const { repoId, tabId } = await app.openRepo(extra.path);
    await graphReady(app);
    const { page } = app;
    const rows = await loadedRows(app, repoId);

    // "+N"
    const more = page.locator(`${rowSel(crowded)} [data-more-refs]`);
    equal(await more.count(), 1, "too many labels: \"+N\" appears");
    const visibleLabels = await page.locator(`${rowSel(crowded)} [data-ref-full]`).count();
    const all = rows.find((row) => row.sha === crowded).refs.length;
    equal(await more.innerText(), `+${all - visibleLabels}`, "\"+N\" counts the remaining labels");
    check((await more.getAttribute("title")).split("\n").length === all - visibleLabels, "\"+N\" names the remaining ones in the tooltip");
    equal(await page.locator(`${rowSel(crowded)} [data-cell="refs"]`).evaluate((cell) => cell.scrollWidth - cell.clientWidth), 0, "the labels do not burst the column");
    await more.click();
    await eventually(() => page.locator('[role="dialog"] [data-ref-full]').count(), all - visibleLabels, "clicking \"+N\" shows the remaining labels");
    await shot(app, "commit-graph-long");
    await page.keyboard.press("Escape");
    // 60-character name in a narrow column: truncated with a tooltip
    check(rows.find((row) => row.sha === crowded).refs.includes(`refs/heads/${longName}`), "the long branch name is loaded");

    // Drag: label onto a row with a branch
    const source = page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/feature/wind-diagramm"]`);
    const from = await center(source);
    const targetRow = page.locator(rowSel(extra.git("rev-parse", "main")));
    const to = await center(targetRow.locator('[data-cell="message"]'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
    await eventually(() => page.locator("[data-ref-ghost]").count(), 1, "while dragging, an image of the label follows the pointer");
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await eventually(() => targetRow.getAttribute("data-drop"), "true", "the row under the pointer is marked as target");
    equal(await source.getAttribute("data-dragging"), "true", "the source is marked as dragged");
    await shot(app, "commit-graph-drag");
    // Esc cancels
    await page.keyboard.press("Escape");
    await eventually(() => page.locator("[data-ref-ghost]").count(), 0, "Esc ends the drag");
    equal(await targetRow.getAttribute("data-drop"), null, "the target marker is gone");
    await page.mouse.up();
    await sleep(200);
    equal(await page.locator('[role="menu"]').count(), 0, "no menu appears after Esc");
    // Drag onto another label and release
    const targetLabel = page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/bugfix/sensor-ausfall"]`);
    const onto = await center(targetLabel);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
    await page.mouse.move(onto.x, onto.y, { steps: 6 });
    await eventually(() => targetLabel.getAttribute("data-drop"), "true", "a label under the pointer is marked as target");
    // A tag is not a target
    const tag = await center(page.locator(`${commitGraphScreen} [data-ref-full="refs/tags/messreihe-januar"]`));
    await page.mouse.move(tag.x, tag.y, { steps: 4 });
    await eventually(() => page.locator(`${commitGraphScreen} [data-drop="true"]`).count(), 0, "a row with only a tag is not a target");
    await page.mouse.move(onto.x, onto.y, { steps: 4 });
    await page.mouse.up();
    await eventually(() => page.locator("[data-ref-ghost]").count(), 0, "releasing ends the drag");
    await sleep(300);
    if ((await page.locator('[role="menu"]').count()) > 0) {
      const label = await page.locator('[role="menu"]').getAttribute("aria-label");
      equal(label, "feature/wind-diagramm dragged onto bugfix/sensor-ausfall", "the menu at the drop point names both branches");
      const texts = (await menuItems(app)).join(" | ");
      check(texts.includes("feature/wind-diagramm") && texts.includes("bugfix/sensor-ausfall"), `entries name both names: ${texts}`);
      const menuBox = await page.locator('[role="menu"]').boundingBox();
      check(Math.abs(menuBox.x - onto.x) < 40 && Math.abs(menuBox.y - onto.y) < 40, "the menu sits at the drop point");
      // Pull request: listed but disabled, and says why (no host connection yet).
      const pr = page.locator('[role="menu"] [role="menuitem"]', { hasText: "Create pull request" });
      equal(await pr.count(), 1, "the drop menu has an entry for the pull request");
      equal(await pr.getAttribute("aria-disabled"), "true", "… it is disabled");
      check((await pr.innerText()).includes("needs a host connection"), `… with the reason (${(await pr.innerText()).replace(/\s+/g, " ")})`);
      await shot(app, "commit-graph-drop-menu");
      await page.keyboard.press("Escape");
      await eventually(() => page.locator('[role="menu"]').count(), 0, "Esc closes the menu, nothing happens");
    } else {
      note("dropMenu has no entries yet – the menu at the drop point is not checked");
    }
    equal(extra.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "dragging alone changes nothing in the repository");

    // Search hits
    const hits = [extra.info.shas.csv, extra.info.shas.longSummary, extra.info.shas.first];
    await page.evaluate(([id, shas]) => window.__gc.store.getState().setSearch(id, { query: "mess", hits: shas, active: 1 }), [tabId, hits]);
    await eventually(async () => (await domRows(app)).filter((row) => row.hit).map((row) => [row.id, row.hit]).sort(), hits.map((sha) => [sha, sha === hits[1] ? "active" : "true"]).sort(), "search hits are marked, the active one more strongly");
    check((await page.locator(`${rowSel(hits[0])} .sr-only`).allInnerTexts()).includes("Search result:"), "search hits are recognisable without colour too (icon and text)");
    await shot(app, "commit-graph-search");
    await page.evaluate((id) => window.__gc.store.getState().setSearch(id, { query: "", hits: [], active: -1 }), tabId);
    await eventually(async () => (await domRows(app)).filter((row) => row.hit).length, 0, "no marking without a search");

    // Show this commit
    await page.evaluate(([id, sha]) => window.__gc.store.getState().revealCommit(id, sha), [tabId, extra.info.shas.first]);
    await eventually(() => selection(app, tabId), { kind: "commits", shas: [extra.info.shas.first] }, "\"show this commit\" selects it");
    check(await page.locator(rowSel(extra.info.shas.first)).isVisible(), "… and it is in view");
    // Unknown commit: notice instead of an endless loop
    await page.evaluate((id) => window.__gc.store.getState().revealCommit(id, "0123456789abcdef0123456789abcdef01234567"), tabId);
    const info = await until(async () => (await page.locator('[data-toast="info"]').allInnerTexts())[0], "unknown commit: notice");
    check(/Commit 0123456 is not in this view/.test(info ?? ""), `notice: ${String(info).replace(/\s+/g, " ")}`);
    await page.getByRole("button", { name: "Close message" }).first().click();

    // Hide: notice row, graph without the branch, "Show all"
    const experiment = extra.git("rev-parse", "experiment/alte-auswertung");
    await app.invoke("view_state_set", { repoId, patch: { hiddenRefs: ["refs/heads/experiment/alte-auswertung"] } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "viewState"] }), repoId);
    await page.locator(`${commitGraphScreen} [data-graph-filter]`).waitFor();
    equal((await page.locator(`${commitGraphScreen} [data-graph-filter]`).innerText()).replace(/\s+/g, " "), "View filtered · experiment/alte-auswertung hidden Show all", "notice row names the filter");
    await until(async () => !(await loadedRows(app, repoId)).some((row) => row.sha === experiment), "the hidden branch is missing from the graph");
    await app.settle();
    equal((await checkCanvas(app, repoId)).problems, [], "canvas of the filtered view");
    await shot(app, "commit-graph-filtered");
    await page.locator(`${commitGraphScreen} [data-graph-filter]`).getByRole("button", { name: "Show all" }).click();
    await eventually(() => page.locator(`${commitGraphScreen} [data-graph-filter]`).count(), 0, "\"Show all\" removes the notice row");
    await until(async () => (await loadedRows(app, repoId)).some((row) => row.sha === experiment), "the branch is back in the graph");
    equal((await app.invoke("view_state_get", { repoId })).hiddenRefs, [], "the filter is cleared in the core");
    // Solo
    await app.invoke("view_state_set", { repoId, patch: { soloRefs: ["refs/heads/feature/wind-diagramm"] } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "viewState"] }), repoId);
    await page.locator(`${commitGraphScreen} [data-graph-filter]`).waitFor();
    check((await page.locator(`${commitGraphScreen} [data-graph-filter]`).innerText()).includes("only feature/wind-diagramm (solo)"), "solo is in the notice row");
    await until(async () => (await loadedRows(app, repoId)).filter((row) => row.kind !== "wip").length === Number(extra.git("rev-list", "--count", "feature/wind-diagramm")), "solo shows only this branch's history");
    await page.locator(`${commitGraphScreen} [data-graph-filter]`).getByRole("button", { name: "Show all" }).click();
    await eventually(() => page.locator(`${commitGraphScreen} [data-graph-filter]`).count(), 0, "solo cleared");
    await closeApp(app);
  });

  // =========================================================================================
  await section("Drop menu after a real drag: merge and push (verified in the repository and the remote)", async () => {
    const repo = fixture(() => makeRichRepo({ dirty: false }));
    cleanups.push(() => repo.cleanup());
    // A local branch one commit ahead of origin/feature/temperatur-karte – dragged onto its label it is pushed there.
    repo.git("checkout", "-q", "--no-track", "-b", "thema/nachschub", "origin/feature/temperatur-karte");
    repo.write("notizen/nachschub.md", "Nachschub für die Karte.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Nachschub für die Temperaturkarte");
    repo.git("checkout", "-q", "main");
    const nachschub = repo.git("rev-parse", "thema/nachschub");

    const app = await open({ width: 1440, height: 900, theme: "dark" });
    const { repoId } = await app.openRepo(repo.path);
    await graphReady(app);
    const { page } = app;
    const drag = async (fromLabel, toLabel) => {
      const from = await center(page.locator(`${commitGraphScreen} [data-ref-full="${fromLabel}"]`).first());
      const to = await center(page.locator(`${commitGraphScreen} [data-ref-full="${toLabel}"]`).first());
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await eventually(() => page.locator(`${commitGraphScreen} [data-ref-full="${toLabel}"]`).first().getAttribute("data-drop"), "true", `target ${toLabel} is marked`);
      await page.mouse.up();
      await page.locator('[role="menu"]').waitFor({ timeout: 5000 });
    };
    const entries = () =>
      page.locator('[role="menu"] [role="menuitem"]').evaluateAll((items) => items.map((item) => ({ text: item.innerText.replace(/\s+/g, " ").trim(), title: item.getAttribute("title") ?? "", disabled: item.getAttribute("aria-disabled") === "true" })));

    // 1. Local branch onto a remote branch: push is in the menu and is executed.
    await drag("refs/heads/thema/nachschub", "refs/remotes/origin/feature/temperatur-karte");
    let list = await entries();
    const pushEntry = list.find((entry) => entry.text.includes("Push"));
    check(pushEntry && !pushEntry.disabled && pushEntry.text.includes("“thema/nachschub” to “origin/feature/"), `push is in the menu and enabled: ${JSON.stringify(list.map((entry) => entry.text))}`);
    check(pushEntry?.title.includes("Push “thema/nachschub” to “origin/feature/temperatur-karte”"), `the tooltip names both names in full (${pushEntry?.title})`);
    check(pushEntry?.text.includes("becomes the upstream"), "… with the note that the target becomes the upstream");
    const mergeEntry = list.find((entry) => entry.text.includes("Merge "));
    check(mergeEntry?.disabled && mergeEntry.text.includes("the target must be a local branch"), `merging into a remote branch is disabled and says why (${mergeEntry?.text})`);
    const prEntry = list.find((entry) => entry.text.startsWith("Create pull request"));
    check(prEntry?.disabled && prEntry.text.includes("needs a host connection"), `pull request: disabled with a reason (${prEntry?.text})`);
    equal(repo.git("--git-dir", repo.remotePath, "rev-parse", "refs/heads/feature/temperatur-karte") === nachschub, false, "before the push the remote does not know the commit");
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: "Push" }).click();
    await eventually(() => repo.git("--git-dir", repo.remotePath, "rev-parse", "refs/heads/feature/temperatur-karte"), nachschub, "after the push the branch in the remote points to the commit", 20_000);
    const upstreamOf = (branch) => {
      try {
        return repo.git("rev-parse", "--abbrev-ref", `${branch}@{upstream}`);
      } catch {
        return null;
      }
    };
    await eventually(() => upstreamOf("thema/nachschub"), "origin/feature/temperatur-karte", "the target is now the upstream", 10_000);
    await app.settle();
    await closeToasts(app);

    // 2. Branch onto the checked-out branch: merge.
    const windTip = repo.git("rev-parse", "feature/wind-diagramm");
    const mainBefore = repo.git("rev-parse", "main");
    await drag("refs/heads/feature/wind-diagramm", "refs/heads/main");
    list = await entries();
    equal(await page.locator('[role="menu"]').getAttribute("aria-label"), "feature/wind-diagramm dragged onto main", "the menu names both branches");
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: "into “main”" }).click();
    await eventually(() => repo.git("rev-parse", "main") !== mainBefore, true, "main has a new commit", 20_000);
    equal(repo.git("rev-list", "--parents", "-n", "1", "main").split(" ").slice(1), [mainBefore, windTip], "a merge commit with main and feature/wind-diagramm as parents");
    equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "main is still checked out");
    await app.settle();
    await until(async () => (await loadedRows(app, repoId)).some((row) => row.sha === repo.git("rev-parse", "main") && row.kind === "merge"), "the graph shows the merge commit");
    equal((await checkCanvas(app, repoId)).problems, [], "canvas after the merge");
    await closeApp(app);
  });

  // =========================================================================================
  await section("Highlight, ghost label, pin, current branch only", async () => {
    const repo = fixture(() => makeRichRepo({ dirty: false }));
    cleanups.push(() => repo.cleanup());
    const pinData = fs.mkdtempSync(path.join(os.tmpdir(), "gc-s06-pin-"));
    cleanups.push(() => fs.rmSync(pinData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    let app = await open({ width: 1440, height: 900, theme: "dark", dataDir: pinData });
    let { repoId, tabId } = await app.openRepo(repo.path);
    await graphReady(app);
    let { page } = app;
    const revList = (...refs) => gitLines(repo, "rev-list", ...refs).sort();
    const allCommits = commitsOf(repo).sort();
    const WIND = "refs/heads/feature/wind-diagramm";
    const windLabel = () => page.locator(`${commitGraphScreen} [data-ref-full="${WIND}"]`).first();
    /** The nodes on the canvas: highlighted ones opaque, the others dimmed. */
    const canvasMatches = async (members, laneOf = (row) => row.lane) => {
      const rows = await graphRows(app, repoId);
      const problems = [];
      for (const [index, row] of rows.entries()) {
        if (row.kind !== "commit" && row.kind !== "merge") continue;
        const pixel = await nodePixel(app, index, laneOf(row, index));
        if (!pixel) continue;
        const member = members.includes(row.sha);
        if (member && pixel.alpha !== 255) problems.push(`${row.sha.slice(0, 7)}: node should be opaque, α ${pixel.alpha}`);
        if (!member && !(pixel.alpha > 80 && pixel.alpha < 125)) problems.push(`${row.sha.slice(0, 7)}: node should be dimmed (α about 102), α ${pixel.alpha}`);
      }
      return problems;
    };

    // --- Highlight: pointer over a label -----------------------------------------------------------
    equal((await dimState(app)).dim, [], "without the pointer nothing is dimmed");
    await windLabel().hover();
    const windCommits = revList("feature/wind-diagramm");
    await eventually(async () => (await dimState(app)).bright, windCommits, "pointer over the label: exactly the branch's commits are not dimmed (git rev-list)");
    equal((await dimState(app)).dim, allCommits.filter((sha) => !windCommits.includes(sha)), "… all others are dimmed");
    equal(await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).getAttribute("data-dim"), "true", "the local changes row too (the branch is not checked out)");
    equal(await canvasMatches(windCommits), [], "canvas: the branch's nodes opaque, the others dimmed");
    const dimmedRow = allCommits.find((sha) => !windCommits.includes(sha));
    await sleep(250);
    equal(await page.locator(rowSel(dimmedRow)).evaluate((row) => getComputedStyle(row).opacity), "0.4", "dimmed rows are faded but stay");
    check(await page.locator(rowSel(dimmedRow)).isEnabled(), "… and usable");
    await shot(app, "commit-graph-highlight");
    await app.setTheme("light");
    await shot(app, "commit-graph-highlight-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    await windLabel().hover();
    await eventually(async () => (await dimState(app)).bright.every((sha) => windCommits.includes(sha)) && (await dimState(app)).dim.length > 0, true, "960×600: the highlight works in the small window too");
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "960×600: nothing overflows");
    await shot(app, "commit-graph-highlight-min");
    await app.setSize(1440, 900);
    await sleep(300);
    await windLabel().hover();
    await eventually(async () => (await dimState(app)).bright, windCommits, "back at 1440×900");
    await page.mouse.move(900, 700);
    await eventually(async () => (await dimState(app)).dim, [], "pointer away: nothing dimmed anymore");
    equal((await checkCanvas(app, repoId)).problems, [], "canvas as before again");
    // The checked-out branch: the local changes belong to it.
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/heads/main"]`).first().hover();
    await eventually(async () => (await dimState(app)).bright, revList("main"), "pointer over main: main's commits");
    equal(await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).getAttribute("data-dim"), null, "the local changes row belongs to the checked-out branch");
    // A tag highlights nothing.
    await page.locator(`${commitGraphScreen} [data-ref-full="refs/tags/v0.1.0"]`).first().hover();
    await eventually(async () => (await dimState(app)).dim, [], "a tag highlights nothing");

    // --- Highlight from the sidebar: pointer and keyboard focus -------------------------------------
    await page.locator('[data-area="left"] [data-ref-hover="refs/heads/bugfix/sensor-ausfall"]').hover();
    await eventually(async () => (await dimState(app)).bright, revList("bugfix/sensor-ausfall"), "pointer over a branch in the sidebar highlights its commits");
    await page.mouse.move(900, 700);
    await eventually(async () => (await dimState(app)).dim, [], "pointer away: cleared");
    await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).click();
    await page.keyboard.press("Alt+1");
    await until(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-area="left"]'))), "Alt+1: focus in the sidebar");
    let focusedRef = null;
    for (let step = 0; step < 20; step++) {
      focusedRef = await page.evaluate(() => document.activeElement?.getAttribute("data-ref-hover") ?? null);
      if (focusedRef && focusedRef !== "refs/heads/main") break;
      await page.keyboard.press("ArrowDown");
    }
    check(focusedRef, `with the arrow keys focus is on a branch (${focusedRef})`);
    await eventually(async () => (await dimState(app)).bright, revList(focusedRef), `keyboard focus in the sidebar highlights ${focusedRef}`);
    await shot(app, "commit-graph-highlight-leftpanel");
    await page.keyboard.press("Alt+2");
    await eventually(async () => (await dimState(app)).dim, [], "when focus leaves the sidebar, the highlight ends");

    // --- Key B: sticky highlight with a notice row; Esc clears -------------------------------------
    const below = repo.git("rev-parse", "feature/wind-diagramm~1");
    await until(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-screen="commit-graph"] [data-row-index]'))), "Alt+2: focus on a row in the graph");
    for (let step = 0; step < 40 && (await focusedRow(app)) !== below; step++) await page.keyboard.press("ArrowDown");
    equal(await focusedRow(app), below, "with the arrow keys on the commit below the branch tip");
    await page.keyboard.press("b");
    const bar = page.locator(`${commitGraphScreen} [data-graph-highlight]`);
    await bar.waitFor();
    const barText = (await bar.innerText()).replace(/\s+/g, " ");
    check(barText.includes("Highlighted: feature/wind-diagramm") && barText.includes(`${windCommits.length} commits`) && barText.includes("Clear"), `notice row names the branch and number of commits: ${barText}`);
    equal(await bar.getAttribute("role"), "status", "… as a status for screen readers");
    equal((await dimState(app)).bright, windCommits, "B: the nearest branch containing the row is highlighted");
    await page.mouse.move(900, 700);
    await sleep(250);
    equal((await dimState(app)).bright, windCommits, "the sticky highlight stays even when the pointer moves");
    await shot(app, "commit-graph-highlight-sticky");
    await page.keyboard.press("Escape");
    await eventually(() => bar.count(), 0, "Esc clears the sticky highlight");
    equal((await dimState(app)).dim, [], "nothing dimmed anymore");
    equal(await focusedRow(app), below, "focus stays on the row");
    await page.keyboard.press("b");
    await bar.waitFor();
    await page.keyboard.press("b");
    await eventually(() => bar.count(), 0, "B again clears as well");

    // --- Ghost label -------------------------------------------------------------------------------
    const ghostOf = (sha) => page.locator(`${rowSel(sha)} [data-ghost-ref]`).getAttribute("data-ghost-ref", { timeout: 1500 }).catch(() => null);
    await eventually(() => ghostOf(below), WIND, "the selected row without its own label shows its branch's ghost label");
    const ghostBox = page.locator(`${rowSel(below)} [data-ghost-ref]`);
    equal(await ghostBox.evaluate((label) => getComputedStyle(label).borderTopStyle), "dashed", "pale and dashed – recognisable by shape, not just colour");
    check((await ghostBox.getAttribute("title")).includes("Contained in branch feature/wind-diagramm"), "the tooltip says what it means");
    equal(await ghostOf(repo.git("rev-parse", "feature/wind-diagramm")), null, "a row with its own branch label has no ghost label");
    // Samples: the ghost label always names a branch that really contains the commit (git for-each-ref --contains).
    const rowsNow = await loadedRows(app, repoId);
    const unlabeled = rowsNow.filter((row) => (row.kind === "commit" || row.kind === "merge") && !row.refs.some((ref) => ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/")));
    let sampled = 0;
    for (const row of unlabeled.filter((_, index) => index % 2 === 0).slice(0, 7)) {
      await page.locator(`${rowSel(row.sha)} [data-cell="message"]`).click();
      const containing = gitLines(repo, "for-each-ref", "--format=%(refname)", "--contains", row.sha, "refs/heads", "refs/remotes").filter((name) => !name.endsWith("/HEAD"));
      const ghost = await until(() => ghostOf(row.sha), `ghost label on ${row.sha.slice(0, 7)}`);
      check(containing.includes(ghost), `ghost label on ${row.sha.slice(0, 7)} (${ghost}) is a branch that contains the commit (${containing.length} contain it)`);
      sampled++;
    }
    check(sampled >= 5, `ghost label checked on ${sampled} rows`);
    // Hovering shows it too – on the row under the pointer.
    const hovered = unlabeled.find((row) => row.sha !== below && row.sha !== (unlabeled.filter((_, index) => index % 2 === 0).slice(0, 7).at(-1)?.sha));
    await page.locator(`${rowSel(below)} [data-cell="message"]`).click();
    await page.locator(`${rowSel(hovered.sha)} [data-cell="message"]`).hover();
    await until(() => ghostOf(hovered.sha), "the hovered row shows its ghost label");
    equal(await page.locator(`${commitGraphScreen} [data-ghost-ref]`).count(), 2, "two ghost labels: selected and hovered row");
    await shot(app, "commit-graph-ghost");
    await app.setTheme("light");
    await shot(app, "commit-graph-ghost-light");
    await app.setTheme("dark");
    // Pointer over the ghost label highlights its branch.
    await ghostBox.hover();
    await eventually(async () => (await dimState(app)).bright, windCommits, "pointer over the ghost label highlights the branch");
    await page.mouse.move(900, 700);
    await eventually(async () => (await dimState(app)).dim, [], "… and releases it again");

    // --- Pinning -----------------------------------------------------------------------------------
    const chainOf = async (tip) => {
      const rows = await graphRows(app, repoId);
      const at = new Map(rows.map((row, index) => [row.sha, index]));
      const chain = [];
      for (let index = at.get(tip); index !== undefined; index = at.get(rows[index].parents[0])) chain.push({ index, ...rows[index] });
      return chain;
    };
    const pinnedProblems = async (tip) => {
      const problems = [];
      for (const row of await chainOf(tip)) {
        const pixel = await nodePixel(app, row.index, 0);
        if (!pixel) continue;
        if (pixel.alpha !== 255 || pixel.color !== pixel.colors[row.color % 8]) problems.push(`${row.sha.slice(0, 7)}: node in lane 0 expected ${pixel.colors[row.color % 8]}, got ${pixel.color} (α ${pixel.alpha})`);
      }
      return problems;
    };
    const windTip = repo.git("rev-parse", "feature/wind-diagramm");
    const before = await chainOf(windTip);
    check(before[0].lane > 0, `starting point: the branch is not in lane 0 (lane ${before[0].lane})`);
    check((await pinnedProblems(windTip)).length > 0, "… so its nodes are not all the way left");
    await windLabel().click({ button: "right" });
    await page.locator('[role="menu"]').waitFor();
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: "Pin to the left in graph" }).click();
    await eventually(() => app.invoke("view_state_get", { repoId }).then((view) => view.pinnedRefs), [WIND], "context menu: the branch is in the repository's pinned refs");
    await until(async () => (await pinnedProblems(windTip)).length === 0, "the nodes of the branch and its ancestors (first parents) are now in lane 0");
    equal(await pinnedProblems(windTip), [], "canvas: chain in lane 0, in the colours of its lanes");
    equal(await page.locator(`${rowSel(windTip)} [data-pinned-mark]`).count(), 1, "the label carries the pin – as a sign, not just by position");
    check((await page.locator(`${rowSel(windTip)} [data-pinned-mark]`).innerText()).includes("pinned"), "… with text for screen readers");
    // The displaced line (main) continues alongside: in lane 1 there is a line at the height of the tip.
    const beside = await nodePixel(app, before[1].index, 1);
    check(beside && beside.alpha === 255, `next to the pinned chain the displaced line continues in lane 1 (α ${beside?.alpha})`);
    const toast = await until(async () => (await page.locator('[data-toast="success"]').allInnerTexts())[0], "feedback");
    check(/pinned to the left of the graph/.test(toast ?? ""), `message: ${String(toast).replace(/\s+/g, " ")}`);
    await closeToasts(app);
    await page.mouse.move(900, 700);
    await shot(app, "commit-graph-pinned");
    await app.setTheme("light");
    await until(async () => (await pinnedProblems(windTip)).length === 0, "light theme: the pinned chain is in lane 0, in the light lane colours");
    await shot(app, "commit-graph-pinned-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await sleep(300);
    await until(async () => (await pinnedProblems(windTip)).length === 0, "960×600: the pinned chain is in lane 0");
    await shot(app, "commit-graph-pinned-min");
    await app.setSize(1440, 900);
    await sleep(300);
    equal((await app.invoke("view_state_get", { repoId })).soloRefs, [], "pinning filters nothing");
    equal((await loadedRows(app, repoId)).filter((row) => row.kind !== "wip").length, allCommits.length, "all commits are still there");
    // Highlight and pin together
    await windLabel().hover();
    await eventually(async () => (await dimState(app)).bright, windCommits, "pinned and highlighted");
    equal(await pinnedProblems(windTip), [], "the pinned chain is drawn opaque in lane 0, also when highlighted");
    await page.mouse.move(900, 700);
    await eventually(async () => (await dimState(app)).dim, [], "pointer away");

    // Restart: remembered per repository
    await closeApp(app);
    app = await open({ width: 1440, height: 900, theme: "dark", dataDir: pinData });
    ({ repoId, tabId } = await app.openRepo(repo.path));
    await graphReady(app);
    ({ page } = app);
    equal((await app.invoke("view_state_get", { repoId })).pinnedRefs, [WIND], "after restarting the app the branch is still pinned");
    await until(async () => (await pinnedProblems(windTip)).length === 0, "… and is drawn in lane 0 again");
    equal(await page.locator(`${rowSel(windTip)} [data-pinned-mark]`).count(), 1, "… with the pin on the label");
    // Unpin via the context menu
    await windLabel().click({ button: "right" });
    await page.locator('[role="menu"]').waitFor();
    equal(await page.locator('[role="menu"] [role="menuitem"]', { hasText: "Pin to the left in graph" }).count(), 0, "pinned: the entry is now called \"Unpin in graph\"");
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: "Unpin in graph" }).click();
    await eventually(() => app.invoke("view_state_get", { repoId }).then((view) => view.pinnedRefs), [], "unpinned");
    await until(async () => (await checkCanvas(app, repoId)).problems.length === 0, "the drawing matches the core's layout again");
    equal(await page.locator(`${commitGraphScreen} [data-pinned-mark]`).count(), 0, "no pin anymore");
    await closeToasts(app);
    // By command (keyboard only): pin the checked-out branch and unpin it again
    await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).focus();
    await runCommand(app, "pin checked-out branch", "graph.pinCurrentBranch");
    await eventually(() => app.invoke("view_state_get", { repoId }).then((view) => view.pinnedRefs), ["refs/heads/main"], "command \"pin checked-out branch to the left\"");
    await closeToasts(app);
    await runCommand(app, "pin checked-out branch", "graph.pinCurrentBranch");
    await eventually(() => app.invoke("view_state_get", { repoId }).then((view) => view.pinnedRefs), [], "the same command unpins again");
    await closeToasts(app);

    // --- Current branch, upstream and target only ---------------------------------------------------
    const toggle = page.locator(`${commitGraphScreen} [data-smart-toggle]`);
    equal(await toggle.getAttribute("aria-pressed"), "false", "the toggle is off");
    check((await toggle.getAttribute("aria-label")).startsWith("Show only the current branch, upstream and target"), "… and is named after what it does");
    // Keyboard only: into the header row, to the toggle, Space
    await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).focus();
    check((await tabUntil(app, () => document.activeElement?.hasAttribute("data-smart-toggle") === true, { shift: true, max: 20 })) >= 0, "Shift+Tab reaches the toggle in the header row");
    await page.keyboard.press("Space");
    await eventually(() => app.invoke("view_state_get", { repoId }).then((view) => [...view.soloRefs].sort()), ["refs/heads/main", "refs/remotes/origin/main"], "main checked out: main and its upstream are shown (there is no other target)");
    equal(await toggle.getAttribute("aria-pressed"), "true", "the toggle is on");
    await until(async () => JSON.stringify((await loadedRows(app, repoId)).filter((row) => row.kind !== "wip").map((row) => row.sha).sort()) === JSON.stringify(revList("main", "origin/main")), "the graph shows exactly the commits of main and origin/main");
    const filterBar = page.locator(`${commitGraphScreen} [data-graph-filter]`);
    equal((await filterBar.innerText()).replace(/\s+/g, " "), "View filtered · only main and origin/main (current branch, upstream) Show all", "the notice row says what is shown");
    await app.settle();
    equal((await checkCanvas(app, repoId)).problems, [], "canvas of the restricted view");
    // Checking out another branch: the selection follows – current branch, its upstream, target main.
    await app.invoke("branch_checkout", { repoId, target: "feature/wind-diagramm" });
    await eventually(
      () => app.invoke("view_state_get", { repoId }).then((view) => [...view.soloRefs].sort()),
      ["refs/heads/feature/wind-diagramm", "refs/heads/main", "refs/remotes/origin/feature/wind-diagramm"],
      "after the checkout: the new branch, its upstream and the target main",
      15_000,
    );
    await until(async () => JSON.stringify((await loadedRows(app, repoId)).filter((row) => row.kind !== "wip").map((row) => row.sha).sort()) === JSON.stringify(revList("feature/wind-diagramm", "origin/feature/wind-diagramm", "main")), "the graph shows the commits of these three");
    check((await filterBar.innerText()).includes("only feature/wind-diagramm, origin/feature/wind-diagramm and main (current branch, upstream, target)"), `notice row after the checkout: ${(await filterBar.innerText()).replace(/\s+/g, " ")}`);
    await app.settle();
    await shot(app, "commit-graph-smart");
    await app.setSize(960, 600);
    await sleep(300);
    equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "960×600: nothing overflows");
    await shot(app, "commit-graph-smart-min");
    await app.setSize(1440, 900);
    await sleep(300);
    // Off: the previous filter (none) comes back.
    await toggle.click();
    await eventually(() => app.invoke("view_state_get", { repoId }).then((view) => view.soloRefs), [], "off: the solo filter is empty again");
    equal(await toggle.getAttribute("aria-pressed"), "false", "the toggle is off");
    await until(async () => (await loadedRows(app, repoId)).filter((row) => row.kind !== "wip").length === allCommits.length, "all commits are back");
    // On, then set a solo by hand: the manual choice wins, the toggle turns off and resets nothing.
    await toggle.click();
    await eventually(() => toggle.getAttribute("aria-pressed"), "true", "on again");
    await app.invoke("view_state_set", { repoId, patch: { soloRefs: ["refs/heads/bugfix/sensor-ausfall"] } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "viewState"] }), repoId);
    await eventually(() => toggle.getAttribute("aria-pressed"), "false", "solo changed by hand: the toggle turns off");
    equal((await app.invoke("view_state_get", { repoId })).soloRefs, ["refs/heads/bugfix/sensor-ausfall"], "… and keeps the manual choice");
    await filterBar.getByRole("button", { name: "Show all" }).click();
    await eventually(() => filterBar.count(), 0, "Show all");
    // By command (keyboard)
    await page.locator(`${commitGraphScreen} [data-row-kind="wip"]`).focus();
    await runCommand(app, "show only current branch", "graph.smartVisibility");
    await eventually(() => toggle.getAttribute("aria-pressed"), "true", "command from the palette turns it on");
    await filterBar.getByRole("button", { name: "Show all" }).click();
    await eventually(() => toggle.getAttribute("aria-pressed"), "false", "\"Show all\" also turns the toggle off");
    equal((await app.invoke("view_state_get", { repoId })).soloRefs, [], "no filter anymore");
    repo.git("checkout", "-q", "main");
    void tabId;
    await closeApp(app);
  });

  // =========================================================================================
  await section("Empty repository and loading errors", async () => {
    const empty = fixture(() => makeEmptyRepo());
    cleanups.push(() => empty.cleanup());
    const app = await open({ width: 1440, height: 900, theme: "dark" });
    const opened = await app.openRepo(empty.path);
    const { page } = app;
    await page.locator(`${commitGraphScreen}[data-state="empty"]`).waitFor();
    const text = (await page.locator(commitGraphScreen).innerText()).replace(/\s+/g, " ");
    check(text.includes("No commits yet") && text.includes("commit panel on the right"), `empty repository: ${text}`);
    equal(await page.locator(`${commitGraphScreen} [role="row"]`).count(), 0, "empty repository: no rows");
    await page.evaluate((id) => window.__gc.store.getState().clearSelection(id), opened.tabId);
    await page.locator(commitGraphScreen).getByRole("button", { name: "View changes" }).click();
    await eventually(() => selection(app, opened.tabId), { kind: "wip" }, "\"View changes\" selects the local changes");
    await shot(app, "commit-graph-empty");
    // First commit from outside: the graph appears on its own
    empty.git("add", "-A");
    empty.git("commit", "-q", "-m", "Erster Commit");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator(`${commitGraphScreen}[data-state="ready"] [data-row-kind="commit"]`).waitFor({ timeout: 20_000 });
    equal((await loadedRows(app, opened.repoId)).filter((row) => row.kind === "commit").map((row) => row.sha), [empty.git("rev-parse", "HEAD")], "after the first commit the graph shows it");
    await closeApp(app);

    // A branch points to an object that does not exist. The whole history used to end up in the
    // error state; since BUG-014 the app skips the one damaged ref: the other branches and their
    // commits are visible, and the branch list loads (it used to hang because `git for-each-ref`
    // did not exit after "fatal: missing object").
    const broken = fixture(() => makeRichRepo({ dirty: false }));
    cleanups.push(() => broken.cleanup());
    const lost = "experiment/alte-auswertung";
    const tip = broken.git("rev-parse", lost);
    const object = path.join(broken.path, ".git", "objects", tip.slice(0, 2), tip.slice(2));
    if (!check(fs.existsSync(object), "fixture: the commit object is stored loose")) return;
    const aside = `${object}.weg`;
    fs.renameSync(object, aside);
    const second = await open({ width: 1440, height: 900, theme: "dark" });
    try {
      const failing = await second.openRepo(broken.path).catch((error) => ({ error }));
      check(!failing.error, `the repository opens and the app settles (${failing.error ? String(failing.error.message).split(/\r?\n/)[0] : "opened"})`);
      const brokenRepoId = failing.repoId ?? (await second.page.evaluate(() => window.__gc.queryClient.getQueryData(["app", "tabs"])?.find((tab) => tab.isActive)?.repoId ?? null));
      await second.page.locator(`${commitGraphScreen}[data-state="ready"] [data-row-kind="commit"]`).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
      const state = await second.page.locator(commitGraphScreen).getAttribute("data-state", { timeout: 15_000 }).catch(() => null);
      equal(state, "ready", "a missing commit object does not break the history");
      const reachable = Number(broken.git("rev-list", "--count", `--exclude=refs/heads/${lost}`, "--all"));
      equal((await loadedRows(second, brokenRepoId)).filter((row) => row.kind === "commit" || row.kind === "merge").length, reachable, "the graph shows the commits of all other refs");
      const refs = await second.invoke("refs_list", { repoId: brokenRepoId });
      check(refs.locals.some((ref) => ref.name === "main") && !refs.locals.some((ref) => ref.name === lost), `the branch list loads without the damaged branch (${refs.locals.map((ref) => ref.name).join(", ")})`);
      await shot(second, "commit-graph-error");
      // The object is back: after reloading the graph shows the whole history.
      fs.renameSync(aside, object);
      await second.page.evaluate(() => window.__gc.queryClient.invalidateQueries());
      await eventually(async () => (await loadedRows(second, brokenRepoId)).filter((row) => row.kind === "commit" || row.kind === "merge").length, commitsOf(broken).length, "with the object the whole history is back", 20_000);
    } finally {
      if (fs.existsSync(aside)) fs.renameSync(aside, object);
    }
    // The failed core calls are intentional here.
    second.consoleErrors.length = 0;
    await closeApp(second);
  });

  // =========================================================================================
  await section("Large repository: 50,000 commits", async () => {
    const large = fixture(() => makeLargeRepo(50000));
    cleanups.push(() => large.cleanup());
    const app = await open({ width: 1440, height: 900, theme: "dark" });
    const { page } = app;
    await app.settle();

    // Time from opening to the first row
    const timing = await page.evaluate(async (repoPath) => {
      const started = performance.now();
      const opened = await window.__TAURI_INTERNALS__.invoke("repo_open", { path: repoPath });
      const openedAt = performance.now();
      await new Promise((resolve) => {
        const look = () => (document.querySelector('[data-screen="commit-graph"] [data-row-kind="commit"], [data-screen="commit-graph"] [data-row-kind="merge"]') ? resolve() : requestAnimationFrame(look));
        look();
      });
      return { total: performance.now() - started, open: openedAt - started, repoId: opened.repo.id, tabId: opened.tab.id };
    }, large.path);
    const { repoId, tabId } = timing;
    numbers.firstRowMs = Math.round(timing.total);
    numbers.repoOpenMs = Math.round(timing.open);
    check(timing.total < 2000, `first row after ${Math.round(timing.total)} ms (limit 2000 ms; of which repo_open ${Math.round(timing.open)} ms)`);
    await graphReady(app);

    const loaded = (await loadedRows(app, repoId)).length;
    const inDom = await page.locator(`${commitGraphScreen} [role="row"][data-row-index]`).count();
    check(loaded >= 2000, `first page: ${loaded} rows loaded`);
    check(inDom < 120, `virtualized: ${inDom} rows in the DOM with ${loaded} loaded`);
    numbers.domRows = inDom;
    equal((await checkCanvas(app, repoId)).problems, [], "canvas at the start of the list");
    await shot(app, "commit-graph-large");

    // Frame times while scrolling fast within the loaded rows
    const measure = (stepPx, frames) =>
      page.evaluate(
        async ([step, count]) => {
          const scroller = document.querySelector("[data-graph-scroller]");
          scroller.scrollTop = 0;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const before = { ...window.__gcGraphStats };
          const times = [];
          let last = performance.now();
          await new Promise((resolve) => {
            let done = 0;
            const tick = () => {
              const now = performance.now();
              times.push(now - last);
              last = now;
              scroller.scrollTop += step;
              if (++done < count) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          });
          times.shift();
          const sorted = [...times].sort((a, b) => a - b);
          const after = { ...window.__gcGraphStats };
          return {
            frames: times.length,
            avg: times.reduce((sum, value) => sum + value, 0) / times.length,
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: sorted.at(-1),
            over33: times.filter((value) => value > 33.4).length,
            paints: after.paints - before.paints,
            rowRenders: after.rowRenders - before.rowRenders,
            lastPaintMs: after.lastPaintMs,
            scrolled: scroller.scrollTop,
          };
        },
        [stepPx, frames],
      );
    const round = (value) => Math.round(value * 10) / 10;
    const fast = await measure(420, 120);
    numbers.scrollFast = `15 rows per frame, ${fast.frames} frames: avg ${round(fast.avg)} ms, p95 ${round(fast.p95)} ms, max ${round(fast.max)} ms, ${fast.over33} frames over 33 ms, ${fast.paints} canvas paints (last ${round(fast.lastPaintMs)} ms), ${fast.rowRenders} rows rendered`;
    console.log(`  · fast: ${numbers.scrollFast}`);
    check(fast.p95 < 34, `fast scrolling: p95 ${round(fast.p95)} ms (below 34 ms)`);
    check(fast.avg < 20, `fast scrolling: avg ${round(fast.avg)} ms (below 20 ms)`);
    const wheel = await measure(100, 120);
    numbers.scrollWheel = `100 px per frame, ${wheel.frames} frames: avg ${round(wheel.avg)} ms, p95 ${round(wheel.p95)} ms, max ${round(wheel.max)} ms, ${wheel.over33} frames over 33 ms, ${wheel.paints} canvas paints`;
    console.log(`  · mouse wheel: ${numbers.scrollWheel}`);
    check(wheel.p95 < 34, `scrolling like a mouse wheel: p95 ${round(wheel.p95)} ms (below 34 ms)`);
    equal((await checkCanvas(app, repoId)).problems, [], "canvas in the middle of the list");
    await shot(app, "commit-graph-large-scrolled");

    // Highlighting and pinning must not make this worse.
    // The youngest open side branch: its tip lies a few hundred rows below the start.
    const sideName = large.info.branches.at(-1);
    const sideRef = `refs/heads/${sideName}`;
    const sideTip = large.git("rev-parse", sideName);
    const loadedNow = (await loadedRows(app, repoId)).length;
    await page.evaluate(([id, sha]) => window.__gc.store.getState().revealCommit(id, sha), [tabId, sideTip]);
    const sideLabel = page.locator(`${commitGraphScreen} [data-ref-full="${sideRef}"]`).first();
    await sideLabel.waitFor({ timeout: 20_000 });
    await app.settle(30_000);
    // Time until the highlight is in place (pointer over the label; includes a 100 ms delay against flicker)
    const hoverStarted = Date.now();
    await sideLabel.hover();
    await page.waitForFunction((root) => document.querySelectorAll(`${root} [data-dim="true"]`).length > 0, commitGraphScreen, { timeout: 5000 });
    const hoverMs = Date.now() - hoverStarted;
    numbers.highlightHoverMs = `${hoverMs} ms from pointer to dimmed list with ${loadedNow} loaded rows (includes 100 ms delay)`;
    check(hoverMs < 600, `highlighting by pointer is in place after ${hoverMs} ms`);
    // Sample: above the tip everything is dimmed, the tip and what lies below it in its lane is not.
    const sideRows = await graphRows(app, repoId);
    const sideIndex = sideRows.findIndex((row) => row.sha === sideTip);
    const sideMembers = new Set(large.git("rev-list", "-n", "400", sideName).split(/\r?\n/));
    const state = await page.evaluate((root) => [...document.querySelectorAll(`${root} [role="row"][data-row-index]`)].filter((row) => row.dataset.rowKind !== "wip").map((row) => [row.dataset.rowId, row.dataset.dim === "true"]), commitGraphScreen);
    check(state.length > 20 && state.every(([sha, dim]) => dim === !sideMembers.has(sha)), `50,000 commits: exactly what does not belong to the branch is dimmed (${state.filter(([sha, dim]) => dim !== !sideMembers.has(sha)).length} deviations among ${state.length} rows in view)`);
    equal((await nodePixel(app, sideIndex, sideRows[sideIndex].lane))?.alpha, 255, "the tip's node is drawn opaque");
    equal((await nodePixel(app, sideIndex - 1, sideRows[sideIndex - 1].lane))?.alpha, 102, "the node above (not part of it) is dimmed");
    await shot(app, "commit-graph-large-highlight");
    await page.mouse.move(900, 700);
    await page.waitForFunction((root) => document.querySelectorAll(`${root} [data-dim="true"]`).length === 0, commitGraphScreen, { timeout: 5000 });
    // Sticky highlight (key B on the tip's row) while scrolling
    await page.locator(`${rowSel(sideTip)} [data-cell="message"]`).click();
    await page.keyboard.press("b");
    await page.locator(`${commitGraphScreen} [data-graph-highlight]`).waitFor();
    const lit = await measure(420, 120);
    numbers.scrollHighlighted = `with highlight (${sideName}, ${loadedNow} rows): avg ${round(lit.avg)} ms, p95 ${round(lit.p95)} ms, max ${round(lit.max)} ms, ${lit.over33} frames over 33 ms, ${lit.paints} canvas paints (last ${round(lit.lastPaintMs)} ms)`;
    console.log(`  · ${numbers.scrollHighlighted}`);
    check(lit.p95 < 34 && lit.avg < 20, `scrolling with highlight: avg ${round(lit.avg)} ms, p95 ${round(lit.p95)} ms`);
    // Toggling the highlight, measured frame by frame: 60 times on and off (at the tip, where dimmed and bright rows are in view)
    await page.evaluate(([id, sha]) => window.__gc.store.getState().revealCommit(id, sha), [tabId, sideTip]);
    await page.locator(rowSel(sideTip)).waitFor();
    await app.settle(30_000);
    const flipTimes = (target) => page.evaluate(async (sha) => {
      const row = document.querySelector(`[data-screen="commit-graph"] [data-row-id="${sha}"]`);
      row.focus();
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      await frame();
      const times = [];
      const dims = new Set();
      let last = performance.now();
      for (let round = 0; round < 60; round++) {
        row.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true }));
        await frame();
        const now = performance.now();
        times.push(now - last);
        last = now;
        dims.add(document.querySelectorAll('[data-screen="commit-graph"] [data-dim="true"]').length > 0);
      }
      const sorted = [...times].sort((a, b) => a - b);
      return { avg: times.reduce((sum, value) => sum + value, 0) / times.length, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), both: dims.size === 2 };
    }, target);
    const flip = await flipTimes(sideTip);
    numbers.highlightToggle = `highlight toggled 60 times: avg ${round(flip.avg)} ms, p95 ${round(flip.p95)} ms, max ${round(flip.max)} ms per frame`;
    console.log(`  · ${numbers.highlightToggle}`);
    check(flip.both, "while toggling, the list was alternately dimmed and not dimmed");
    check(flip.p95 < 34, `toggling the highlight: p95 ${round(flip.p95)} ms (below 34 ms)`);
    await page.evaluate(() => document.querySelector('[data-screen="commit-graph"] [data-graph-highlight] button')?.click());
    await eventually(() => page.locator(`${commitGraphScreen} [data-graph-highlight]`).count(), 0, "highlight cleared");
    // Pinning: the side branch and main – the side branch's line moves left, main next to it
    const pinStarted = Date.now();
    await app.invoke("view_state_set", { repoId, patch: { pinnedRefs: [sideRef, "refs/heads/main"] } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "viewState"] }), repoId);
    await page.locator(`${rowSel(sideTip)} [data-pinned-mark]`).first().waitFor({ timeout: 10_000 });
    numbers.pinMs = `${Date.now() - pinStarted} ms from pinning to the pin on the label (${loadedNow} rows)`;
    await until(async () => {
      const pixel = await nodePixel(app, sideIndex, 0);
      return pixel?.alpha === 255 && pixel.color === pixel.colors[sideRows[sideIndex].color % 8];
    }, "the tip of the pinned side branch is in lane 0");
    check(sideRows[sideIndex].lane > 0, `… before it was in lane ${sideRows[sideIndex].lane}`);
    await shot(app, "commit-graph-large-pinned");
    const pinnedScroll = await measure(420, 120);
    numbers.scrollPinned = `with two pinned branches: avg ${round(pinnedScroll.avg)} ms, p95 ${round(pinnedScroll.p95)} ms, max ${round(pinnedScroll.max)} ms, ${pinnedScroll.over33} frames over 33 ms, ${pinnedScroll.paints} canvas paints (last ${round(pinnedScroll.lastPaintMs)} ms)`;
    console.log(`  · ${numbers.scrollPinned}`);
    check(pinnedScroll.p95 < 34 && pinnedScroll.avg < 20, `scrolling with pinned branches: avg ${round(pinnedScroll.avg)} ms, p95 ${round(pinnedScroll.p95)} ms`);
    await app.invoke("view_state_set", { repoId, patch: { pinnedRefs: [] } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "viewState"] }), repoId);
    await eventually(() => page.locator(`${commitGraphScreen} [data-pinned-mark]`).count(), 0, "unpinned again");
    await page.evaluate((id) => window.__gc.store.getState().selectWip(id), tabId);
    await page.evaluate(() => (document.querySelector("[data-graph-scroller]").scrollTop = 0));
    await app.settle(30_000);
    equal((await checkCanvas(app, repoId)).problems, [], "canvas after highlighting and pinning matches the core again");

    // Loading more at the end
    await page.evaluate(() => {
      const scroller = document.querySelector("[data-graph-scroller]");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await until(async () => (await loadedRows(app, repoId)).length >= loaded + 500, "the next page loads at the end", 20_000);
    await app.settle(30_000);
    equal((await checkCanvas(app, repoId)).problems, [], "canvas at the seam of two pages");

    // Unreadable cursor (as after a change of the refs): reload from the start silently, no message
    await page.evaluate((id) => {
      window.__gc.queryClient.setQueryData(["repo", id, "graph"], (data) => ({ ...data, pages: data.pages.map((page, index) => (index === data.pages.length - 1 ? { ...page, nextCursor: "veraltet" } : page)) }));
    }, repoId);
    await page.evaluate(() => {
      const scroller = document.querySelector("[data-graph-scroller]");
      scroller.scrollTop = scroller.scrollHeight;
    });
    const beforeStale = (await loadedRows(app, repoId)).length;
    await until(async () => (await loadedRows(app, repoId)).length > beforeStale, "after stale_state the graph silently reloads and continues", 30_000);
    await app.settle(30_000);
    equal(await page.locator("[data-toast]").count(), 0, "stale_state produces no message");
    equal(await page.locator(`${commitGraphScreen} [role="alert"]`).count(), 0, "stale_state shows no error");

    // Keyboard in the long list: End jumps to the end of what is loaded, focus stays in the list
    await page.locator(`${commitGraphScreen} [role="row"][data-row-index]`).nth(5).click();
    await page.keyboard.press("End");
    await until(() => page.evaluate(() => Number(document.activeElement?.getAttribute("data-row-index") ?? -1) > 2000), "End: focus on the last loaded row");
    await page.keyboard.press("Home");
    await eventually(() => focusedRow(app), "wip", "Home: focus back on the first row");
    await app.settle(30_000);

    // Show a commit that is not loaded yet
    const all = large.git("rev-list", "--topo-order", "--branches", "--tags").split(/\r?\n/);
    const far = all[6200];
    const before = (await loadedRows(app, repoId)).length;
    await page.evaluate(([id, sha]) => window.__gc.store.getState().revealCommit(id, sha), [tabId, far]);
    await page.locator(rowSel(far)).waitFor({ timeout: 60_000 });
    await app.settle(30_000);
    check(await page.locator(rowSel(far)).isVisible(), "\"show this commit\" loads more until it is there, and scrolls to it");
    equal(await page.locator(rowSel(far)).getAttribute("aria-selected"), "true", "… and it is selected");
    numbers.revealLoaded = `${before} → ${(await loadedRows(app, repoId)).length} rows`;
    // Too far back: notice with "Keep searching"
    await page.evaluate(([id, sha]) => window.__gc.store.getState().revealCommit(id, sha), [tabId, all.at(-1)]);
    const hint = await until(async () => (await page.locator('[data-toast="info"]').allInnerTexts())[0], "very old commit: notice after a limit", 120_000);
    check(/is further back/.test(hint ?? "") && /Keep searching/.test(hint ?? ""), `notice: ${String(hint).replace(/\s+/g, " ")}`);
    const total = (await loadedRows(app, repoId)).length;
    numbers.revealLimit = `${total} rows loaded when the search stopped`;
    check(total < 30000, `the search stops at a limit (${total} rows loaded)`);
    await app.settle(60_000);
    const deep = await page.locator(`${commitGraphScreen} [role="row"][data-row-index]`).count();
    check(deep < 140, `even with ${total} loaded rows only ${deep} are in the DOM`);
    const deepScroll = await measure(420, 120);
    numbers.scrollFastDeep = `with ${total} loaded rows: avg ${round(deepScroll.avg)} ms, p95 ${round(deepScroll.p95)} ms, max ${round(deepScroll.max)} ms`;
    console.log(`  · ${numbers.scrollFastDeep}`);

    // The same with over 20,000 loaded rows: highlighting (membership across all rows) and pinning (chain across all rows).
    await closeToasts(app);
    await page.evaluate(([id, sha]) => window.__gc.store.getState().revealCommit(id, sha), [tabId, sideTip]);
    await page.locator(rowSel(sideTip)).waitFor({ timeout: 20_000 });
    await app.settle(30_000);
    const deepFlip = await flipTimes(sideTip);
    numbers.highlightToggleDeep = `highlight toggled 60 times with ${total} rows: avg ${round(deepFlip.avg)} ms, p95 ${round(deepFlip.p95)} ms, max ${round(deepFlip.max)} ms per frame`;
    console.log(`  · ${numbers.highlightToggleDeep}`);
    check(deepFlip.both, "deeply loaded too: alternately dimmed and not dimmed");
    check(deepFlip.p95 < 50, `toggling the highlight with ${total} rows: p95 ${round(deepFlip.p95)} ms (below 50 ms – every toggle recomputes membership across all rows)`);
    await page.locator(`${rowSel(sideTip)} [data-cell="message"]`).click();
    await page.keyboard.press("b");
    await page.locator(`${commitGraphScreen} [data-graph-highlight]`).waitFor();
    await app.invoke("view_state_set", { repoId, patch: { pinnedRefs: [sideRef, "refs/heads/main"] } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "viewState"] }), repoId);
    await page.locator(`${rowSel(sideTip)} [data-pinned-mark]`).first().waitFor({ timeout: 10_000 });
    const deepBoth = await measure(420, 120);
    numbers.scrollDeepBoth = `with ${total} rows, highlight and two pinned branches: avg ${round(deepBoth.avg)} ms, p95 ${round(deepBoth.p95)} ms, max ${round(deepBoth.max)} ms, ${deepBoth.over33} frames over 33 ms`;
    console.log(`  · ${numbers.scrollDeepBoth}`);
    check(deepBoth.p95 < 34 && deepBoth.avg < 20, `scrolling with highlight and pinning with ${total} rows: avg ${round(deepBoth.avg)} ms, p95 ${round(deepBoth.p95)} ms`);
    await app.invoke("view_state_set", { repoId, patch: { pinnedRefs: [] } });
    await page.evaluate(() => document.querySelector('[data-screen="commit-graph"] [data-graph-highlight] button')?.click());
    await closeApp(app);
  });
} finally {
  for (const app of [...apps]) await closeApp(app).catch(() => undefined);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Temp folders stay behind if necessary.
    }
  }
}

console.log("\nNumbers:");
for (const [key, value] of Object.entries(numbers)) console.log(`  ${key}: ${value}`);
if (notes.length) {
  console.log("\nNot checked:");
  for (const line of notes) console.log(`  ${line}`);
}
if (failures.length) {
  console.log(`\n${failures.length} failures:`);
  for (const line of failures) console.log(`  ${line}`);
  process.exit(1);
}
console.log("\nS06: all green.");
process.exit(0);
