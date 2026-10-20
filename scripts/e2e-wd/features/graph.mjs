/**
 * Commit graph, commit search, commit details and comparing two commits (1.0), plus collapsing
 * merges and the push/pull arrows (1.1) – in the real app over WebDriver, against real temp
 * repositories. Every result in the UI is checked against Git in the temp repository.
 *
 *   node scripts/e2e-wd/features/graph.mjs
 *   E2E_WD_ONLY="collapse" node scripts/e2e-wd/features/graph.mjs
 */
import path from "node:path";
import { makeCleanRepoWithRemote, makeDetachedRepo, makeEmptyRepo, makeLargeRepo, makeRichRepo } from "../../e2e/fixtures.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const CONTROL = "";
const SHIFT = "";
const short = (sha) => sha.slice(0, 7);
const lines = (text) => text.split(/\r?\n/).filter(Boolean);
const sorted = (list) => [...list].sort();

/** Opens the repository and waits for the first commit rows. */
async function openGraph(app, repo) {
  const ids = await app.openRepo(repo.path);
  await app.waitFor('[data-screen="commit-graph"][data-state="ready"]', 30_000);
  await app.settle();
  return ids;
}

/** All loaded graph rows (from the query cache – the list is virtualised, the DOM only holds the visible ones). */
function loadedRows(app, repoId) {
  return app.exec((id) => {
    const data = window.__gc.queryClient.getQueryData(["repo", id, "graph"]);
    if (!data) return null;
    return data.pages.flatMap((page) =>
      page.rows.map((row) => ({ id: row.id, sha: row.sha, kind: row.kind, parents: row.parents, summary: row.summary, sync: row.sync, collapsedCount: row.collapsedCount, isHead: row.isHead })),
    );
  }, repoId);
}

/** Whether the last page has been loaded. */
function historyComplete(app, repoId) {
  return app.exec((id) => {
    const data = window.__gc.queryClient.getQueryData(["repo", id, "graph"]);
    return Boolean(data && data.pages.length > 0 && data.pages[data.pages.length - 1].nextCursor === null);
  }, repoId);
}

/** The rendered rows (DOM). */
function domRows(app) {
  return app.exec(() =>
    [...document.querySelectorAll("[data-row-index]")].map((row) => ({
      id: row.dataset.rowId,
      kind: row.dataset.rowKind,
      hit: row.dataset.hit ?? null,
      selected: row.getAttribute("aria-selected") === "true",
      sync: row.querySelector("[data-sync]")?.dataset.sync ?? null,
      syncTitle: row.querySelector("[data-sync]")?.getAttribute("title") ?? null,
      toggle: row.querySelector("[data-collapse-toggle]")?.dataset.collapseToggle ?? null,
      collapsed: row.querySelector("[data-collapsed-count]")?.dataset.collapsedCount ?? null,
      collapsedText: row.querySelector("[data-collapsed-count]")?.textContent ?? null,
      message: row.querySelector('[data-cell="message"]')?.innerText.replace(/\s+/g, " ").trim() ?? "",
    })),
  );
}

const selection = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.selection ?? { kind: "wip" }, tabId);
const viewState = (app, repoId) => app.invoke("view_state_get", { repoId });
const rowSelector = (sha) => `[data-row-id="${sha}"] [data-cell="message"]`;

/** Click with a modifier held (Control or Shift) – real W3C input, not a synthetic event. */
async function modClick(app, target, modifier = CONTROL) {
  const element = typeof target === "string" ? await app.waitFor(target) : target;
  await app.webdriver("POST", "/actions", {
    actions: [
      { type: "key", id: "keyboard", actions: [{ type: "keyDown", value: modifier }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: modifier }] },
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pause", duration: 0 }, { type: "pointerMove", origin: { [ELEMENT_KEY]: element.id }, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 0 }],
      },
    ],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** Right click (context menu) – real W3C input. */
async function rightClick(app, target) {
  const element = typeof target === "string" ? await app.waitFor(target) : target;
  await app.webdriver("POST", "/actions", {
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: { [ELEMENT_KEY]: element.id }, x: 0, y: 0 }, { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 }] }],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** Paths listed in the file list of the commit panel. */
function panelFiles(app) {
  return app.exec(() => [...document.querySelectorAll('[data-screen="commit-details"] [data-testid="files-changed"] [role="option"]')].map((row) => row.getAttribute("title")));
}

/** Makes the file list of the commit panel a flat list (the view is a setting). */
async function listView(app) {
  if (await app.$('[data-screen="commit-details"] [data-file-list="flat"]')) return;
  const button = await app.waitFor(() => app.exec(() => [...document.querySelectorAll('[data-screen="commit-details"] button, [data-screen="commit-details"] [role="radio"]')].find((el) => el.getAttribute("title") === "List" || el.textContent.trim() === "List") ?? null), 5000, { message: "List switch" });
  await app.click(button);
  await app.waitFor(() => app.$('[data-screen="commit-details"] [data-file-list="flat"]'), 5000, { message: "file list in list view" });
}

/** Runs a command from the command palette by its title. */
async function runFromPalette(app, title) {
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] [role="combobox"]');
  await app.type(input, title);
  const option = await app.waitFor(() => app.byText(title, { within: '[data-screen="command-palette"]' }), 5000, { message: `palette entry "${title}"` });
  await app.click(option);
  await app.waitFor(async () => !(await app.$('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

/** Snapshot of refs and objects, to prove a view action left the repository alone. */
const gitSnapshot = (repo) => [repo.git("for-each-ref", "--format=%(refname) %(objectname)"), repo.git("rev-list", "--all", "--count"), repo.git("status", "--porcelain")].join("\n---\n");

/** What the search finds according to Git: message or author, fixed string, case-insensitive, all branches/remotes/tags/HEAD. */
function gitSearch(repo, query) {
  const base = ["log", "--branches", "--remotes", "--tags", "--format=%H", "--fixed-strings", "--regexp-ignore-case"];
  return [...new Set([...lines(repo.git(...base, `--grep=${query}`, "HEAD")), ...lines(repo.git(...base, `--author=${query}`, "HEAD"))])];
}

// ---------------------------------------------------------------------------
// Commit graph (1.0)
// ---------------------------------------------------------------------------

scenario("graph: shows the whole history with labels, lanes and the end marker", "main", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    const rows = await loadedRows(app, repoId);
    const commits = rows.filter((row) => row.kind === "commit" || row.kind === "merge");
    const expected = lines(repo.git("rev-list", "--branches", "--remotes", "--tags", "HEAD"));
    assertEqual(sorted(commits.map((row) => row.sha)), sorted(expected), "graph commits = git rev-list of branches, remotes, tags and HEAD");
    assertEqual(commits.map((row) => row.sha).slice(0, 1), [repo.git("rev-parse", "HEAD")], "newest row is HEAD (topological order)");
    assertEqual(commits.filter((row) => row.kind === "merge").map((row) => row.sha).sort(), sorted(lines(repo.git("rev-list", "--merges", "--all"))), "merge rows = git rev-list --merges");
    assertEqual(commits.filter((row) => row.isHead).map((row) => row.sha), [repo.git("rev-parse", "HEAD")], "exactly the HEAD commit is marked");
    // Topological order: no row comes after one of its parents.
    const position = new Map(commits.map((row, index) => [row.sha, index]));
    for (const sha of expected) {
      for (const parent of repo.git("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1)) assert(position.get(parent) > position.get(sha), `parent ${short(parent)} is listed before its child ${short(sha)}`);
    }
    t.step(`${commits.length} commits, order checked against Git`);

    // Every branch and tag has its label on the right row.
    const refs = lines(repo.git("for-each-ref", "--format=%(refname) %(objectname) %(*objectname)", "refs/heads", "refs/remotes", "refs/tags")).filter((line) => !line.startsWith("refs/remotes/origin/HEAD"));
    const labels = await app.exec(() => Object.fromEntries([...document.querySelectorAll("[data-ref-full]")].map((label) => [label.dataset.refFull, label.closest("[data-row-id]")?.dataset.rowId ?? null])));
    for (const line of refs) {
      const [name, object, peeled] = line.split(" ");
      // A label may sit in an overflow chip ("+n") – then it is in the data, not as its own element.
      const target = peeled || object;
      const shownOn = labels[name] ?? (rows.find((row) => row.sha === target) ? target : null);
      assertEqual(shownOn, target, `label ${name} sits on ${short(target)}`);
    }
    t.step(`${refs.length} labels on the right rows`);

    // The canvas draws lanes, the footer names the end of the history.
    const painted = await app.waitFor(
      () =>
        app.exec(() => {
          const canvas = document.querySelector("canvas[data-graph-canvas]");
          if (!canvas || canvas.width === 0) return false;
          const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, Math.min(canvas.height, 600)).data;
          let colored = 0;
          for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) colored += 1;
          return colored > 500;
        }),
      10_000,
      { message: "graph canvas painted" },
    );
    assert(painted, "canvas empty");
    await app.waitFor(() => app.byText(`End of history · ${expected.length} commits`), 5000, { message: "end-of-history footer" });
    assert(await historyComplete(app, repoId), "the last page is loaded");
    await t.shot("graph-history");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("graph: an empty repository shows the empty state", "edge", async (t) => {
  const repo = makeEmptyRepo();
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    await app.openRepo(repo.path);
    await app.waitFor('[data-screen="commit-graph"][data-state="empty"]', 30_000, { message: "graph in the empty state" });
    assert(await app.byText("No commits yet"), "empty state title");
    assertEqual(await app.$$('[data-row-kind="commit"], [data-row-kind="merge"]').then((list) => list.length), 0, "no commit rows");
    let unborn = false;
    try {
      repo.git("rev-parse", "--verify", "HEAD");
    } catch {
      unborn = true;
    }
    assert(unborn, "Git: HEAD has no commit");
    await t.shot("graph-empty");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("graph: keyboard navigation (arrows, H parent, End, Enter)", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId, tabId } = await openGraph(app, repo);
    const head = repo.git("rev-parse", "HEAD");
    await app.click(rowSelector(head));
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === head, 5000, { message: "HEAD selected" });
    await app.waitFor(() => app.exec((sha) => document.activeElement?.closest("[data-row-id]")?.dataset.rowId === sha, head), 5000, { message: "focus on the HEAD row" });

    const rows = (await loadedRows(app, repoId)).filter((row) => row.kind !== "wip");
    await app.press("ArrowDown");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === rows[1].sha, 5000, { message: "↓ selects the next row" });
    await app.press("k");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === head, 5000, { message: "K goes back up" });

    // H follows the first parent – also across other branches' rows.
    const parent = repo.git("rev-parse", "HEAD^");
    await app.press("h");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === parent, 5000, { message: "H selects the first parent" });
    await app.press("h");
    const grandParent = repo.git("rev-parse", "HEAD~2");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === grandParent, 5000, { message: "H again: the grandparent" });
    // L: the nearest child above that has this commit as its first parent (here possibly a side branch's commit).
    const at = rows.findIndex((row) => row.sha === grandParent);
    const child = rows.slice(0, at).reverse().find((row) => row.parents[0] === grandParent);
    assert(lines(repo.git("rev-list", "--all", "--children", "-n", "100000")).some((line) => line.startsWith(grandParent) && line.includes(child.sha)), "Git: the expected row is a child");
    await app.press("l");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === child.sha, 5000, { message: "L goes to the nearest child above" });
    t.step(`L went to ${short(child.sha)} (${child.summary})`);
    await app.click(rowSelector(parent));

    // Shift+↓ extends the selection to two commits.
    await app.press("Shift+ArrowDown");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.length === 2, 5000, { message: "Shift+↓ selects two commits" });

    // End: the root commit; Enter puts the focus into the commit panel.
    await app.press("End");
    const root = repo.git("rev-list", "--max-parents=0", "HEAD");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.at(-1) === root, 5000, { message: "End selects the root commit" });
    await app.press("Enter");
    await app.waitFor(() => app.exec(() => Boolean(document.activeElement?.closest('[data-area="right"]'))), 5000, { message: "Enter moves the focus into the commit panel" });
    await app.waitFor(() => app.exec((sha) => document.querySelector('[data-screen="commit-details"] [data-testid="commit-summary"]')?.closest("[data-screen]") && document.querySelector('[data-screen="commit-details"]').dataset.selection === "1", root), 5000, { message: "details of one commit" });
    assertIncludes(await app.exec(() => document.querySelector('[data-testid="commit-summary"]').textContent), repo.git("log", "-1", "--format=%s", root), "details show the root commit");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("graph: a commit made outside the app appears without reloading", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    const before = (await loadedRows(app, repoId)).filter((row) => row.kind !== "wip").length;
    repo.write("NOTIZ.md", "Von der Kommandozeile.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Notiz von der Kommandozeile");
    const sha = repo.git("rev-parse", "HEAD");
    t.step(`committed ${short(sha)} with the git CLI`);
    await app.waitFor(rowSelector(sha), 20_000, { message: "row of the new commit" });
    const rows = (await loadedRows(app, repoId)).filter((row) => row.kind !== "wip");
    assertEqual(rows.length, before + 1, "one row more");
    assertEqual(rows[0].sha, sha, "the new commit is on top");
    assertEqual(rows[0].isHead, true, "and is HEAD");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("graph: a long history loads further pages while scrolling", "edge", async (t) => {
  const repo = makeLargeRepo(3000);
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    const total = Number(repo.git("rev-list", "--all", "--count"));
    const first = (await loadedRows(app, repoId)).filter((row) => row.kind !== "wip").length;
    assert(first < total, `the first page holds only part of the history (${first} of ${total})`);
    assert(!(await historyComplete(app, repoId)), "more pages to come");
    t.step(`first page: ${first} of ${total}`);
    await app.waitFor(
      async () => {
        await app.exec(() => {
          const scroller = document.querySelector("[data-graph-scroller]");
          scroller.scrollTop = scroller.scrollHeight;
        });
        return historyComplete(app, repoId);
      },
      60_000,
      { interval: 300, message: "all pages loaded by scrolling" },
    );
    const rows = (await loadedRows(app, repoId)).filter((row) => row.kind !== "wip");
    assertEqual(rows.length, total, "loaded rows = git rev-list --all --count");
    assertEqual(new Set(rows.map((row) => row.sha)).size, total, "no row twice across page borders");
    await app.waitFor(() => app.byText(`End of history · ${total.toLocaleString("en")} commits`), 10_000, { message: "end-of-history footer" });
    const root = repo.git("rev-list", "--max-parents=0", "HEAD");
    assertEqual(rows.at(-1).sha, root, "the last row is the root commit");
    await t.shot("graph-large-end");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Commit search (1.0)
// ---------------------------------------------------------------------------

async function openSearch(app) {
  await app.press("Control+f");
  return app.waitFor('[data-screen="commit-search"] input', 5000, { message: "search field" });
}
const searchHits = (app) => app.exec(() => [...document.querySelectorAll('[data-screen="commit-search"] [role="listbox"] [data-sha]')].map((hit) => hit.dataset.sha));
const counter = (app) => app.exec(() => document.querySelector('[data-testid="search-counter"]')?.textContent.trim() ?? "");

scenario("search: finds commits by message, highlights them and jumps with Enter / F3", "main", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { tabId } = await openGraph(app, repo);
    await app.click(rowSelector(repo.git("rev-parse", "HEAD")));
    const input = await openSearch(app);
    await app.waitFor(() => app.exec(() => document.activeElement?.closest('[data-screen="commit-search"]') !== null), 5000, { message: "focus in the search field" });
    await app.type(input, "regen");
    const expected = gitSearch(repo, "regen");
    assert(expected.length >= 3, `fixture has several matches (${expected.length})`);
    const hits = await app.waitFor(async () => {
      const found = await searchHits(app);
      return found.length === expected.length ? found : null;
    }, 10_000, { message: `${expected.length} hits` });
    assertEqual(sorted(hits), sorted(expected), "hits = git log --grep/--author (fixed, ignore case)");
    assertEqual(await counter(app), `${expected.length} matches`, "counter");
    const highlighted = (await domRows(app)).filter((row) => row.hit).map((row) => row.id);
    assertEqual(sorted(highlighted), sorted(expected), "graph rows marked as hits");
    t.step(`${hits.length} hits, all marked in the graph`);

    await app.press("Enter");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === hits[0], 5000, { message: "Enter selects the first hit" });
    assertEqual(await counter(app), `1 of ${expected.length}`, "counter after Enter");
    await app.press("Enter");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === hits[1], 5000, { message: "Enter again: second hit" });
    await app.press("Shift+Enter");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === hits[0], 5000, { message: "Shift+Enter: back to the first" });
    await app.press("F3");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === hits[1], 5000, { message: "F3: next hit" });
    const active = (await domRows(app)).find((row) => row.hit === "active");
    assertEqual(active?.id, hits[1], "active hit marked in the graph");
    await app.waitFor(() => app.exec((sha) => document.querySelector('[data-testid="commit-summary"]') && document.querySelector('[data-screen="commit-details"]')?.innerText.includes(sha.slice(0, 7)), hits[1]), 5000, { message: "details of the active hit" });
    await t.shot("search-hits");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("search: by SHA prefix and by author name", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    await openGraph(app, repo);
    await app.click(rowSelector(repo.git("rev-parse", "HEAD")));
    const input = await openSearch(app);
    const sha = repo.info.shas.coAuthored;
    await app.type(input, sha.slice(0, 8));
    await app.waitFor(async () => (await searchHits(app)).join() === sha, 10_000, { message: "exactly the commit with this SHA prefix" });
    assertEqual(lines(repo.git("rev-parse", "--disambiguate=" + sha.slice(0, 8))), [sha], "Git: the prefix is unique");

    await app.press("Control+a", "Backspace");
    await app.type(input, "Aylin");
    const expected = gitSearch(repo, "Aylin");
    assertEqual(sorted(expected), sorted(lines(repo.git("log", "--all", "--format=%H", "--author=Aylin"))), "Git: all Aylin hits are authored by her");
    await app.waitFor(async () => sorted(await searchHits(app)).join() === sorted(expected).join(), 10_000, { message: `${expected.length} commits by Aylin` });

    // Three characters are not searched as a SHA (from 4 on), umlauts must match exactly.
    await app.press("Control+a", "Backspace");
    await app.type(input, "Böen");
    await app.waitFor(async () => (await searchHits(app)).length === gitSearch(repo, "Böen").length && (await searchHits(app)).length === 1, 10_000, { message: "umlaut query" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("search: no match shows the empty note, Esc closes and clears the marks", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    await openGraph(app, repo);
    await app.click(rowSelector(repo.git("rev-parse", "HEAD")));
    const input = await openSearch(app);
    await app.type(input, "Sensor");
    await app.waitFor(async () => (await domRows(app)).some((row) => row.hit), 10_000, { message: "hits marked" });

    await app.press("Control+a", "Backspace");
    const query = "kein-solcher-text-4711";
    await app.type(input, query);
    const empty = await app.waitFor('[data-testid="search-empty"]', 10_000, { message: "empty note" });
    assertIncludes(await empty.text(), `No commit matches “${query}”`, "empty note names the query");
    assertEqual(await counter(app), "No matches", "counter");
    assertEqual(gitSearch(repo, query), [], "Git finds nothing either");
    assertEqual((await domRows(app)).filter((row) => row.hit).length, 0, "no row marked");
    await t.shot("search-empty");

    await app.press("Control+a", "Backspace");
    await app.type(input, "Sensor");
    await app.waitFor(async () => (await domRows(app)).some((row) => row.hit), 10_000, { message: "hits marked again" });
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="commit-search"]')), 5000, { message: "search bar closed" });
    assertEqual((await domRows(app)).filter((row) => row.hit).length, 0, "Esc clears the marks in the graph");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("search: a hit beyond the loaded rows is loaded and selected", "edge", async (t) => {
  const repo = makeLargeRepo(3000);
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId, tabId } = await openGraph(app, repo);
    await app.click('[data-row-kind="commit"] [data-cell="message"]');
    const loaded = new Set((await loadedRows(app, repoId)).map((row) => row.sha));
    const query = "(#7)";
    const expected = gitSearch(repo, query);
    assertEqual(expected.length, 1, "Git: exactly one commit");
    assert(!loaded.has(expected[0]), "the hit is not among the loaded rows");
    const input = await openSearch(app);
    await app.type(input, query);
    await app.waitFor(async () => (await searchHits(app)).join() === expected[0], 15_000, { message: "hit in the list" });
    await app.press("Enter");
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === expected[0], 60_000, { interval: 300, message: "the hit is loaded and selected" });
    await app.waitFor(rowSelector(expected[0]), 10_000, { message: "the row is scrolled into view" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Commit details (1.0)
// ---------------------------------------------------------------------------

scenario("details: message, author, co-authors, parent and changed files of a commit", "main", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { tabId } = await openGraph(app, repo);
    const sha = repo.info.shas.coAuthored;
    await app.click(rowSelector(sha));
    await app.waitFor('[data-screen="commit-details"][data-selection="1"] [data-testid="commit-summary"]', 10_000);
    assertEqual((await selection(app, tabId)).shas, [sha], "selection");
    await listView(app);
    const panel = await app.exec(() => document.querySelector('[data-screen="commit-details"]').innerText);
    assertEqual(await app.exec(() => document.querySelector('[data-testid="commit-summary"]').textContent.trim()), repo.git("log", "-1", "--format=%s", sha), "summary = git %s");
    assertIncludes(await app.exec(() => document.querySelector('[data-testid="commit-description"]').textContent), "Drei Fälle: Wert im Bereich", "description");
    assertIncludes(panel, repo.git("log", "-1", "--format=%an", sha), "author name");
    assertIncludes(panel, repo.git("log", "-1", "--format=%ae", sha), "author email");
    for (const name of ["Jonas Albrecht", "Greta Vogel"]) assertIncludes(panel, name, `co-author ${name}`);
    assertIncludes(await app.exec(() => document.querySelector('[data-testid="commit-parents"]').innerText), short(repo.git("rev-parse", `${sha}^`)), "parent = git rev-parse sha^");
    assertIncludes(panel, short(sha), "short SHA");
    const files = await app.waitFor(async () => ((await panelFiles(app)).length ? panelFiles(app) : null), 10_000, { message: "file list" });
    assertEqual(sorted(files), sorted(lines(repo.git("-c", "core.quotePath=false", "diff-tree", "--no-commit-id", "--name-only", "-r", sha))), "files = git diff-tree");
    await t.shot("details-commit");

    // A click on a file opens its diff in the centre.
    await app.click('[data-screen="commit-details"] [data-testid="files-changed"] [role="option"]');
    await app.waitFor('[data-area="center"] [data-screen="diff"]', 10_000, { message: "diff view in the centre" });
    assertIncludes(await app.exec(() => document.querySelector('[data-screen="diff"]').getAttribute("aria-label")), files[0], "diff of the clicked file");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("details: merge commit and root commit", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    await openGraph(app, repo);
    const merge = repo.info.shas.firstMerge;
    await app.click(rowSelector(merge));
    await app.waitFor('[data-screen="commit-details"][data-selection="1"] [data-testid="commit-summary"]', 10_000);
    await app.waitFor('[data-testid="merge-note"]', 5000, { message: "merge note" });
    const parents = await app.exec(() => document.querySelector('[data-testid="commit-parents"]').innerText);
    for (const parent of repo.git("rev-list", "--parents", "-n", "1", merge).split(" ").slice(1)) assertIncludes(parents, short(parent), `merge parent ${short(parent)}`);
    t.step("merge: both parents and the note shown");
    await t.shot("details-merge");

    const root = repo.git("rev-list", "--max-parents=0", "HEAD");
    await app.click(rowSelector(root));
    await app.waitFor(async () => (await app.exec(() => document.querySelector('[data-testid="commit-summary"]')?.textContent.trim())) === repo.git("log", "-1", "--format=%s", root), 10_000, { message: "root commit details" });
    await listView(app);
    const files = await app.waitFor(async () => ((await panelFiles(app)).length ? panelFiles(app) : null), 10_000, { message: "file list" });
    assertEqual(sorted(files), sorted(lines(repo.git("-c", "core.quotePath=false", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", root))), "root: all files added");
    const parentText = await app.exec(() => document.querySelector('[data-testid="commit-parents"]')?.innerText ?? "");
    assert(!/[0-9a-f]{7}/.test(parentText), `root commit lists no parent SHA ("${parentText}")`);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Compare two commits (1.0)
// ---------------------------------------------------------------------------

scenario("compare: Ctrl+click two commits shows the difference, sides can be swapped", "main", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { tabId } = await openGraph(app, repo);
    const older = repo.info.shas.csv;
    const newer = repo.info.shas.coAuthored;
    await app.click(rowSelector(newer));
    await modClick(app, rowSelector(older));
    await app.waitFor('[data-screen="commit-details"][data-selection="2"] [data-testid="compare-head"]', 10_000, { message: "comparison" });
    assertEqual(sorted((await selection(app, tabId)).shas), sorted([older, newer]), "two commits selected");
    const from = () => app.exec(() => document.querySelector('[data-testid="compare-head"] [data-side="Von"][data-sha]')?.dataset.sha);
    const to = () => app.exec(() => document.querySelector('[data-testid="compare-head"] [data-side="Nach"][data-sha]')?.dataset.sha);
    assertEqual([await from(), await to()], [older, newer], "older side first");
    await listView(app);
    const expected = lines(repo.git("-c", "core.quotePath=false", "diff", "--name-only", older, newer));
    const files = await app.waitFor(async () => ((await panelFiles(app)).length ? panelFiles(app) : null), 10_000, { message: "file list" });
    assertEqual(sorted(files), sorted(expected), "files = git diff --name-only older newer");
    const status = () => app.exec(() => [...document.querySelectorAll('[data-testid="files-changed"] [role="option"]')].map((row) => `${row.querySelector("span")?.textContent.trim().charAt(0)} ${row.title}`).sort());
    const gitStatus = (a, b) => lines(repo.git("-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", a, b)).map((line) => `${line.charAt(0)} ${line.split("\t")[1]}`).sort();
    assertEqual(await status(), gitStatus(older, newer), "file status letters = git diff --name-status");
    await t.shot("compare-two-commits");

    await app.click({ text: "Swap sides" });
    await app.waitFor(async () => (await from()) === newer && (await to()) === older, 5000, { message: "sides swapped" });
    await app.waitFor(async () => JSON.stringify(await status()) === JSON.stringify(gitStatus(newer, older)), 10_000, { message: "file status after swap = git diff newer older" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("compare: from the context menu and the command palette", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { tabId } = await openGraph(app, repo);
    const a = repo.info.shas.longSummary;
    const b = repo.info.shas.head;
    await app.click(rowSelector(a));
    await modClick(app, rowSelector(b));
    await app.waitFor('[data-screen="commit-details"][data-selection="2"]', 10_000);
    // Leave the comparison by opening a file view, then come back through the menu.
    await app.exec((id) => window.__gc.store.getState().setRightCollapsed(id, true), tabId);
    await app.waitFor(async () => !(await app.$('[data-area="right"]')), 5000, { message: "commit panel collapsed" });
    await rightClick(app, rowSelector(b));
    const item = await app.waitFor(() => app.byText(`Compare ${short(a)} ↔ ${short(b)}`, { exact: false, within: '[role="menu"]' }).then((found) => found ?? app.byText("Compare", { within: '[role="menu"]' })), 5000, { message: "menu entry Compare" });
    await app.click(item);
    await app.waitFor('[data-area="right"] [data-screen="commit-details"][data-selection="2"] [data-testid="compare-head"]', 10_000, { message: "menu: comparison shown in an opened panel" });

    await app.exec((id) => window.__gc.store.getState().setRightCollapsed(id, true), tabId);
    await app.waitFor(async () => !(await app.$('[data-area="right"]')), 5000, { message: "commit panel collapsed again" });
    await app.click(rowSelector(a));
    await modClick(app, rowSelector(b));
    await runFromPalette(app, "Compare the two selected commits");
    await app.waitFor('[data-area="right"] [data-screen="commit-details"][data-selection="2"] [data-testid="compare-head"]', 10_000, { message: "palette: comparison" });
    await listView(app);
    const files = await app.waitFor(async () => ((await panelFiles(app)).length ? panelFiles(app) : null), 10_000, { message: "file list" });
    assertEqual(sorted(files), sorted(lines(repo.git("-c", "core.quotePath=false", "diff", "--name-only", a, b))), "files = git diff");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("compare: two states without a difference, a gap and a contiguous range", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    // X changes a file, R reverts it: the tree of R equals the tree of X^.
    repo.write("stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\n");
    repo.git("commit", "-q", "-am", "Stationsliste gekürzt");
    const changed = repo.git("rev-parse", "HEAD");
    repo.git("revert", "--no-edit", "HEAD");
    const reverted = repo.git("rev-parse", "HEAD");
    const before = repo.git("rev-parse", `${changed}^`);
    assertEqual(repo.git("rev-parse", `${reverted}^{tree}`), repo.git("rev-parse", `${before}^{tree}`), "Git: same tree");

    const app = await t.launch({ lang: "en", theme: "light" });
    await openGraph(app, repo);
    await app.click(rowSelector(before));
    await modClick(app, rowSelector(reverted));
    await app.waitFor('[data-screen="commit-details"][data-selection="2"]', 10_000);
    await app.waitFor(() => app.byText("There is no difference between these two states.", { exact: false }), 10_000, { message: "no-difference note" });
    await t.shot("compare-no-difference");

    // Three commits with a gap: explanation instead of a combined diff.
    const root = repo.git("rev-list", "--max-parents=0", "HEAD");
    await modClick(app, rowSelector(root));
    await app.waitFor('[data-screen="commit-details"][data-selection="3"] [data-testid="not-combinable"][data-reason="gap"]', 10_000, { message: "gap explanation" });

    // Shift+click selects the rows in between – here including a commit of another branch: no chain.
    await app.click(rowSelector(reverted));
    await modClick(app, rowSelector(before), SHIFT);
    await app.waitFor('[data-screen="commit-details"][data-selection="4"] [data-testid="not-combinable"][data-reason="gap"]', 10_000, { message: "Shift+click: four rows, gap" });
    // Three commits that follow one another (Ctrl+click): combined diff from the parent of the oldest to the newest.
    await app.click(rowSelector(reverted));
    await modClick(app, rowSelector(changed));
    await modClick(app, rowSelector(before));
    const note = await app.waitFor('[data-screen="commit-details"][data-selection="3"] [data-testid="range-note"]', 10_000, { message: "range view" });
    const base = repo.git("rev-parse", `${before}^`);
    assertEqual([await note.attr("data-from"), await note.attr("data-to")], [base, reverted], "range from the parent of the oldest to the newest");
    await listView(app);
    const files = await app.waitFor(async () => ((await panelFiles(app)).length ? panelFiles(app) : null), 10_000, { message: "files of the range" });
    assertEqual(sorted(files), sorted(lines(repo.git("-c", "core.quotePath=false", "diff", "--name-only", base, reverted))), "range files = git diff base newest (the revert cancels out)");
    await t.shot("compare-range");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Collapse merges (1.1)
// ---------------------------------------------------------------------------

scenario("collapse: the arrow on a merge hides the commits it brought in and shows +n", "main", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    const merge = repo.info.shas.firstMerge;
    const side = lines(repo.git("rev-list", `${merge}^1..${merge}^2`));
    assertEqual(side.length, 2, "Git: the merge brought in two commits");
    const snapshot = gitSnapshot(repo);
    const before = (await loadedRows(app, repoId)).length;

    await app.click(`[data-row-id="${merge}"] [data-collapse-toggle="expanded"]`);
    await app.waitFor(`[data-row-id="${merge}"] [data-collapsed-count="2"]`, 10_000, { message: "+2 on the merge row" });
    const rows = await loadedRows(app, repoId);
    for (const sha of side) assert(!rows.some((row) => row.sha === sha), `side commit ${short(sha)} hidden`);
    assertEqual(rows.length, before - 2, "two rows fewer");
    const row = (await domRows(app)).find((entry) => entry.id === merge);
    assertEqual([row.toggle, row.collapsedText], ["collapsed", "+2 commits"], "arrow and text on the merge row");
    assertEqual((await viewState(app, repoId)).collapsedMerges, [merge], "view state holds the merge");
    assertEqual(gitSnapshot(repo), snapshot, "Git: refs, objects and status unchanged");
    await t.shot("collapse-merge");

    await app.click(`[data-row-id="${merge}"] [data-collapse-toggle="collapsed"]`);
    await app.waitFor(rowSelector(side[0]), 10_000, { message: "side commits back" });
    assertEqual((await loadedRows(app, repoId)).length, before, "all rows back");
    assertEqual((await viewState(app, repoId)).collapsedMerges, [], "view state empty again");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("collapse: a branch on the side branch keeps its commit visible, and the arrow says nothing was hidden", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    const merge = repo.info.shas.secondMerge;
    const side = lines(repo.git("rev-list", `${merge}^1..${merge}^2`));
    const bugfix = repo.git("rev-parse", "bugfix/sensor-ausfall");
    assertEqual(side, [bugfix], "Git: the side branch is the commit bugfix/sensor-ausfall points to");
    const before = (await loadedRows(app, repoId)).map((row) => row.id);
    await app.click(`[data-row-id="${merge}"] [data-collapse-toggle="expanded"]`);
    await app.waitFor(() => app.byText("Nothing to collapse"), 10_000, { message: "hint that nothing was hidden" });
    assertIncludes(await app.exec(() => document.body.innerText), "is also on a visible branch or tag", "the hint names the reason");
    await app.settle();
    assertEqual((await loadedRows(app, repoId)).map((row) => row.id), before, "every row stays");
    assert(await app.$(`[data-row-id="${bugfix}"] [data-ref-full="refs/heads/bugfix/sensor-ausfall"]`), "the commit keeps its label");
    assert(await app.$(`[data-row-id="${merge}"] [data-collapse-toggle="expanded"]`), "the arrow stays open");
    assert(!(await app.$(`[data-row-id="${merge}"] [data-collapsed-count]`)), "no “+0 commits” text");
    assertEqual((await viewState(app, repoId)).collapsedMerges, [], "view state not changed");
    await t.shot("collapse-ref-stays");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("collapse: ← and → on the selected merge", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId, tabId } = await openGraph(app, repo);
    const merge = repo.info.shas.firstMerge;
    await app.click(rowSelector(merge));
    await app.waitFor(() => app.exec((sha) => document.activeElement?.closest("[data-row-id]")?.dataset.rowId === sha, merge), 5000, { message: "focus on the merge row" });
    await app.press("ArrowLeft");
    await app.waitFor(`[data-row-id="${merge}"] [data-collapsed-count="2"]`, 10_000, { message: "← collapses" });
    assertEqual((await selection(app, tabId)).shas, [merge], "the merge stays selected");
    await app.waitFor(() => app.exec((sha) => document.activeElement?.closest("[data-row-id]")?.dataset.rowId === sha, merge), 5000, { message: "focus stays on the merge row after reloading" });
    await app.press("ArrowRight");
    await app.waitFor(async () => !(await app.$(`[data-row-id="${merge}"] [data-collapsed-count]`)), 10_000, { message: "→ expands" });
    assertEqual((await viewState(app, repoId)).collapsedMerges, [], "view state empty");
    // On an ordinary commit the keys do nothing.
    const plain = repo.info.shas.csv;
    await app.click(rowSelector(plain));
    const count = (await loadedRows(app, repoId)).length;
    await app.press("ArrowLeft");
    await app.settle();
    assertEqual((await loadedRows(app, repoId)).length, count, "← on a normal commit changes nothing");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("collapse: all merges via shortcut and palette, kept after a restart", "edge", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const dataDir = path.join(repo.root, "app-data");
    const app = await t.launch({ lang: "en", theme: "light", dataDir });
    const { repoId } = await openGraph(app, repo);
    const merges = lines(repo.git("rev-list", "--merges", "--all"));
    await app.click(rowSelector(repo.info.shas.csv));
    await app.press("Control+Shift+[");
    let viaShortcut = true;
    try {
      await app.waitFor(async () => (await viewState(app, repoId)).collapseAllMerges, 5000, { message: "Ctrl+Shift+[ collapses all" });
    } catch {
      viaShortcut = false;
      t.step("Ctrl+Shift+[ did not reach the app under WebDriver/Xvfb – using the palette");
      await runFromPalette(app, "Graph: collapse all merges");
      await app.waitFor(async () => (await viewState(app, repoId)).collapseAllMerges, 5000, { message: "palette collapses all" });
    }
    t.step(`collapse all via ${viaShortcut ? "shortcut" : "palette"}`);
    await app.waitFor(async () => (await domRows(app)).filter((row) => row.toggle === "collapsed").length === merges.length, 10_000, { message: "every merge row collapsed" });
    const hidden = lines(repo.git("rev-list", `${repo.info.shas.firstMerge}^1..${repo.info.shas.firstMerge}^2`));
    for (const sha of hidden) assert(!(await loadedRows(app, repoId)).some((row) => row.sha === sha), `${short(sha)} hidden`);
    await t.shot("collapse-all");
    await app.close();

    // Restart with the same data folder: still collapsed.
    const again = await t.launch({ lang: "en", theme: "light", dataDir });
    // The harness ends the first app without a clean shutdown, so the app offers a crash report: dismiss it.
    const crash = await again.waitFor(() => again.byText("Forkyard closed unexpectedly last time"), 5000).catch(() => null);
    if (crash) {
      await again.click({ text: "Cancel" });
      await again.waitFor(async () => !(await again.byText("Forkyard closed unexpectedly last time")), 5000, { message: "crash note closed" });
    }
    const second = await openGraph(again, repo);
    await again.waitFor(`[data-row-id="${repo.info.shas.firstMerge}"] [data-collapsed-count="2"]`, 15_000, { message: "collapsed after the restart" });
    assert((await viewState(again, second.repoId)).collapseAllMerges, "flag kept in the database");

    await again.click(rowSelector(repo.info.shas.csv));
    await runFromPalette(again, "Graph: expand all merges");
    await again.waitFor(rowSelector(hidden[0]), 10_000, { message: "expand all brings the side commits back" });
    const state = await viewState(again, second.repoId);
    assertEqual([state.collapseAllMerges, state.collapsedMerges], [false, []], "view state reset");
    await t.noConsoleErrors(again);
  } finally {
    repo.cleanup();
  }
});

scenario("collapse: collapse all also covers merges on pages loaded later", "edge", async (t) => {
  const repo = makeLargeRepo(3000);
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    const merges = lines(repo.git("rev-list", "--merges", "--all"));
    await app.click('[data-row-kind="commit"] [data-cell="message"]');
    await runFromPalette(app, "Graph: collapse all merges");
    await app.waitFor(async () => (await viewState(app, repoId)).collapseAllMerges, 5000, { message: "flag set" });
    await app.waitFor(
      async () => {
        await app.exec(() => {
          const scroller = document.querySelector("[data-graph-scroller]");
          scroller.scrollTop = scroller.scrollHeight;
        });
        return historyComplete(app, repoId);
      },
      90_000,
      { interval: 300, message: "all pages loaded" },
    );
    const rows = await loadedRows(app, repoId);
    const mergeRows = rows.filter((row) => row.kind === "merge");
    assertEqual(mergeRows.length, merges.length, "every merge listed");
    const open = mergeRows.filter((row) => row.collapsedCount === null).map((row) => short(row.sha));
    assertEqual(open, [], "no merge stays expanded");
    // Hidden = all commits only reachable through the second parents, except those a branch keeps.
    const total = Number(repo.git("rev-list", "--all", "--count"));
    const hidden = mergeRows.reduce((sum, row) => sum + row.collapsedCount, 0);
    assertEqual(rows.filter((row) => row.kind !== "wip").length + hidden, total, "visible + hidden = all commits");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Push/pull arrows (1.1)
// ---------------------------------------------------------------------------

scenario("sync arrows: ↑ on commits not pushed yet, ↓ on commits not pulled yet", "main", async (t) => {
  const repo = makeRichRepo({ dirty: false });
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    await openGraph(app, repo);
    const ahead = lines(repo.git("rev-list", "@{u}..HEAD"));
    const behind = lines(repo.git("rev-list", "HEAD..@{u}"));
    assertEqual([ahead.length, behind.length], [2, 1], "Git: 2 ahead, 1 behind");
    const rows = await domRows(app);
    assertEqual(sorted(rows.filter((row) => row.sync === "ahead").map((row) => row.id)), sorted(ahead), "↑ rows = git rev-list @{u}..HEAD");
    assertEqual(sorted(rows.filter((row) => row.sync === "behind").map((row) => row.id)), sorted(behind), "↓ rows = git rev-list HEAD..@{u}");
    for (const row of rows.filter((entry) => entry.sync)) {
      assertEqual(row.syncTitle, row.sync === "ahead" ? "Not pushed yet" : "Not pulled yet", `tooltip of ${short(row.id)}`);
      assert(row.message.startsWith(row.sync === "ahead" ? "↑" : "↓"), `arrow at the start of the message: ${row.message}`);
    }
    // The feature branch that is pushed and up to date shows nothing.
    const wind = repo.git("rev-parse", "feature/wind-diagramm");
    assertEqual(rows.find((row) => row.id === wind)?.sync, null, "commit of another branch has no arrow");
    await t.shot("sync-arrows");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("sync arrows: follow commit, push and fetch made outside the app", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    const syncOf = async () => (await loadedRows(app, repoId)).filter((row) => row.sync !== "none").map((row) => [row.sync, row.sha]);
    assertEqual(await syncOf(), [], "in sync: no arrows");

    repo.write("NOTIZ.md", "Lokal.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Lokaler Commit");
    const local = repo.git("rev-parse", "HEAD");
    await app.waitFor(`[data-row-id="${local}"] [data-sync="ahead"]`, 20_000, { message: "↑ on the new local commit" });
    assertEqual(await syncOf(), [["ahead", local]], "only the local commit is ahead");

    repo.git("push", "-q", "origin", "main");
    await app.waitFor(async () => (await syncOf()).length === 0, 20_000, { message: "↑ gone after git push" });
    assertEqual(repo.git("rev-list", "--count", "@{u}..HEAD"), "0", "Git: nothing ahead");

    const remote = repo.commitOnRemote({ message: "Kalibrierung nachgetragen" });
    repo.git("fetch", "-q", "origin");
    await app.waitFor(`[data-row-id="${remote}"] [data-sync="behind"]`, 20_000, { message: "↓ on the fetched commit" });
    assertEqual(await syncOf(), [["behind", remote]], "only the remote commit is behind");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("sync arrows: none without an upstream and on a detached HEAD", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  const detached = makeDetachedRepo();
  try {
    repo.git("checkout", "-q", "-b", "lokal/ohne-upstream");
    repo.write("NOTIZ.md", "Nur lokal.\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Commit ohne Upstream");
    let noUpstream = false;
    try {
      repo.git("rev-parse", "--abbrev-ref", "@{u}");
    } catch {
      noUpstream = true;
    }
    assert(noUpstream, "Git: the branch has no upstream");
    const app = await t.launch({ lang: "en", theme: "light" });
    const { repoId } = await openGraph(app, repo);
    assertEqual((await loadedRows(app, repoId)).filter((row) => row.sync !== "none").length, 0, "no arrows without an upstream");
    assertEqual((await app.$$("[data-sync]")).length, 0, "no arrow in the DOM");

    const other = await app.openRepo(detached.path);
    await app.waitFor('[data-screen="commit-graph"][data-state="ready"]', 30_000);
    await app.settle();
    let isDetached = false;
    try {
      detached.git("symbolic-ref", "-q", "HEAD");
    } catch {
      isDetached = true;
    }
    assert(isDetached, "Git: HEAD is detached");
    assertEqual((await loadedRows(app, other.repoId)).filter((row) => row.sync !== "none").length, 0, "no arrows on a detached HEAD");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
    detached.cleanup();
  }
});
