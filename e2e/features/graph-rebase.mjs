/**
 * Editing the branch history in the graph (1.3) in the real app over WebDriver, against real Git
 * repositories in temp folders: a graph-row drag handed over to the edit list, squash by dropping
 * onto a row, the keyboard path, inline reword, blocked entries and a blocked Apply, the branch
 * moving under the edit, hidden commits of other branches and the hand-over to the rebase tool.
 * Every flow is verified in the UI and in the repository (git log, git rev-parse).
 *
 *   node e2e/features/graph-rebase.mjs
 *   E2E_WD_ONLY="reword" node e2e/features/graph-rebase.mjs
 */
import { closeToasts, makeRepo, nudge, parkMouse, planRepo, rebaseRows, rightClick, waitToast } from "../fixtures/rebase.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const GRAPH = '[data-screen="commit-graph"]';
const EDIT = '[data-screen="graph-edit"]';
const REBASE = '[data-screen="rebase"]';
const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };

const pointer = (actions) => ({ actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });

/** Viewport point inside the element: `fx` of its width, `fy` of its height. */
async function pointOf(app, css, { fx = 0.5, fy = 0.5 } = {}) {
  return app.waitFor(
    () =>
      app.exec(
        (selector, x, y) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const box = el.getBoundingClientRect();
          if (box.width === 0) return null;
          return { x: Math.round(box.left + box.width * x), y: Math.round(box.top + box.height * y) };
        },
        css,
        fx,
        fy,
      ),
    10_000,
    { message: `element ${css}` },
  );
}

/** Pointer moves with the button held (input state is kept between calls until `release`). */
const moveHeld = (app, to, duration = 200) =>
  app.webdriver("POST", "/actions", pointer([{ type: "pointerMove", origin: "viewport", x: to.x, y: to.y, duration }]));
async function release(app) {
  await app.webdriver("POST", "/actions", pointer([{ type: "pointerUp", button: 0 }]));
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}
/** Presses on `at` and moves past the drag threshold; the button stays down. */
const pressAndPull = (app, at) =>
  app.webdriver(
    "POST",
    "/actions",
    pointer([
      { type: "pointerMove", origin: "viewport", x: at.x, y: at.y },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", origin: "viewport", x: at.x + 2, y: at.y + 8, duration: 80 },
      { type: "pointerMove", origin: "viewport", x: at.x + 4, y: at.y + 16, duration: 80 },
    ]),
  );

async function openGraph(app, repo) {
  const opened = await app.openRepo(repo.path);
  await app.waitFor(`${GRAPH}[data-state="ready"]`, 60_000);
  return opened;
}

const graphRow = (sha) => `${GRAPH} [data-row-id="${sha}"]`;
const editRow = (sha) => `${EDIT} [data-row-sha="${sha}"]`;
/** Edit list in DOM order: [{ sha, chip, summary, struck }]. */
const editRows = (app) =>
  app.exec(
    (root) =>
      [...document.querySelectorAll(`${root} [role="option"]`)]
        .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
        .map((row) => {
          const summary = row.querySelector("[data-edit-row] span.truncate[title]");
          return {
            sha: row.dataset.rowSha,
            chip: row.querySelector("[data-chip]")?.textContent ?? null,
            summary: summary?.textContent ?? null,
            struck: summary ? getComputedStyle(summary).textDecorationLine.includes("line-through") : false,
          };
        }),
    EDIT,
  );
const chipOf = async (app, sha) => (await editRows(app)).find((row) => row.sha === sha)?.chip ?? null;
const textOf = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.trim() ?? null, css);
const editListFocused = (app) =>
  app.exec((root) => document.activeElement?.getAttribute("role") === "listbox" && Boolean(document.activeElement.closest(root)), EDIT);
const activeSha = (app) => app.exec((root) => document.querySelector(`${root} [role="option"][data-active]`)?.dataset.rowSha ?? null, EDIT);
const dialogTitle = (app) =>
  app.exec(
    () =>
      document
        .querySelector('[role="dialog"], [role="alertdialog"]')
        ?.querySelector("h1, h2, h3, [data-dialog-title]")
        ?.innerText?.trim() ?? null,
  );
const dialogCount = (app) => app.exec(() => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length);
const dialogButton = (app, label) =>
  app.waitFor(
    () =>
      app.exec(
        (text) =>
          [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((b) => b.innerText.trim() === text) ??
          null,
        label,
      ),
    10_000,
    { message: `dialog button "${label}"` },
  );

/** Waits until `read()` equals `expected` (JSON) or the predicate holds. */
async function eventually(app, read, expected, message, timeout = 15_000) {
  const matches = (value) => (typeof expected === "function" ? expected(value) : JSON.stringify(value) === JSON.stringify(expected));
  let last;
  try {
    return await app.waitFor(
      async () => {
        last = await read();
        return matches(last) ? { value: last } : null;
      },
      timeout,
      { message },
    );
  } catch {
    throw new Error(
      `${message}: expected ${typeof expected === "function" ? "condition" : JSON.stringify(expected)}, got ${JSON.stringify(last)}`,
    );
  }
}

/** Clicks a graph row (selects it, focus in the graph). */
async function selectGraphRow(app, sha) {
  await app.exec((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), graphRow(sha));
  const at = await pointOf(app, graphRow(sha), { fx: 0.6 });
  await app.webdriver(
    "POST",
    "/actions",
    pointer([
      { type: "pointerMove", origin: "viewport", x: at.x, y: at.y },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ]),
  );
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
  await eventually(app, () => app.exec((root) => Boolean(document.activeElement?.closest(root)), GRAPH), true, "focus in the graph");
}

/** Enters the mode with E on the row of `sha`; waits for the focused edit list. */
async function enterWithE(app, sha) {
  await selectGraphRow(app, sha);
  await app.press("e");
  await app.waitFor(EDIT, 15_000);
  await eventually(app, () => editListFocused(app), true, "focus in the edit list");
}

async function graphMenuItems(app, sha) {
  const row = await app.waitFor(graphRow(sha), 20_000);
  await rightClick(app, row);
  await app.waitFor('[role="menu"]', 10_000);
  return app.exec(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => ({
      text: item.innerText.replace(/\s+/g, " ").trim(),
      disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
    })),
  );
}

const leftEdit = (app) => app.exec((root) => document.querySelector(root) === null, EDIT);

// ---------------------------------------------------------------------------

scenario("Drag reorders, drag onto squashes, apply, Undo restores", "main", async (t) => {
  const { repo, c } = planRepo("graph-edit-drag");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    const before = repo.tip("thema/plan");

    // Press on c5's graph row and pull: the mode opens and the same drag goes on in the edit list.
    await pressAndPull(app, await pointOf(app, graphRow(c.c5), { fx: 0.6 }));
    await app.waitFor(EDIT, 15_000);
    await app.waitFor(`${EDIT} [data-drag-ghost]`, 10_000, { message: "the graph drag continues in the edit list" });
    assertEqual(
      (await editRows(app)).map((row) => row.sha),
      [c.c5, c.c4, c.c3, c.c2, c.c1],
      "newest on top, like the graph",
    );
    // Release between c2 and c1: just inside the top quarter of c1 inserts before it.
    await moveHeld(app, await pointOf(app, editRow(c.c1), { fy: 0.1 }));
    await app.waitFor(`${EDIT} [data-drop-line]`, 5000, { message: "insertion line" });
    await release(app);
    await eventually(app, () => chipOf(app, c.c5), "moved", "c5 carries the chip moved");
    assertEqual(
      (await editRows(app)).map((row) => row.sha),
      [c.c4, c.c3, c.c2, c.c5, c.c1],
      "c5 between c2 and c1",
    );
    await eventually(app, () => editListFocused(app), true, "focus in the edit list");
    t.step("graph drag handed over and dropped");

    // c4 onto the middle of c3: squash.
    const from = await pointOf(app, editRow(c.c4));
    await pressAndPull(app, from);
    await moveHeld(app, await pointOf(app, editRow(c.c3)));
    await app.waitFor(`${EDIT} [data-drop-target]`, 5000, { message: "c3 marked as drop target" });
    await release(app);
    await eventually(app, () => chipOf(app, c.c4), "squash", "c4 carries the chip squash");
    await eventually(app, () => textOf(app, `${EDIT} [data-edit-count]`), "2 changes", "change count");
    await eventually(app, () => textOf(app, `${EDIT} [data-edit-preview]`), "No conflicts", "conflict preview", 30_000);
    assertEqual(await app.$(`${EDIT} [data-edit-hidden]`), null, "no other branch: nothing hidden");
    await parkMouse(app);
    await t.shot("edit-plan");

    await app.click(`${EDIT} [data-edit-apply]`);
    await eventually(app, () => leftEdit(app), true, "the graph is normal again");
    await app.waitFor(`${GRAPH}[data-state="ready"]`, 30_000);
    assertEqual(
      repo.subjects("main..thema/plan"),
      ["Sensorliste ergänzt", "Debug-Ausgabe", "Tippfehler im README", "Zwischenstand Export"],
      "git log: moved and squashed",
    );
    assertEqual(repo.git("show", "thema/plan:export.txt"), "fertig", "git: the squash has c4's content");
    t.step("applied");

    await closeToasts(app);
    await app.exec(() => document.activeElement?.blur());
    await app.press("Control+z");
    await eventually(app, () => repo.tip("thema/plan"), before, "undo restores the old tip", 30_000);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("A flicked graph drag ends without a drop once the pointer moves released", "edge", async (t) => {
  const { repo, c } = planRepo("graph-edit-flick");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    // A logic test with synthetic events, not a device test: it checks that a handed-over drag whose
    // button is already up ends on the next move without dropping (ReorderList's early end).
    // Down, past the threshold and up in one script: the button is up before the edit list mounts.
    // Dispatched in the page because WebDriver actions cannot promise that order.
    await app.exec((selector) => {
      const row = document.querySelector(selector);
      const box = row.getBoundingClientRect();
      const x = box.left + box.width * 0.6;
      const y = box.top + box.height / 2;
      const at = (type, dy, buttons) =>
        new PointerEvent(type, {
          bubbles: true,
          composed: true,
          clientX: x,
          clientY: y + dy,
          button: 0,
          buttons,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        });
      row.dispatchEvent(at("pointerdown", 0, 1));
      window.dispatchEvent(at("pointermove", 40, 1));
      window.dispatchEvent(at("pointerup", 40, 0));
    }, graphRow(c.c4));
    await app.waitFor(`${EDIT} [data-drag-ghost]`, 15_000, { message: "the handed-over drag is shown" });
    // The next move has no button down: the drag ends without a drop.
    await app.exec(() =>
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 700, clientY: 400, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }),
      ),
    );
    await eventually(
      app,
      () => app.exec((root) => document.querySelector(`${root} [data-drag-ghost]`) === null, EDIT),
      true,
      "no drag left over",
    );
    assertEqual(
      (await editRows(app)).map((row) => row.sha),
      [c.c5, c.c4, c.c3, c.c2, c.c1],
      "nothing moved",
    );
    assertEqual(await textOf(app, `${EDIT} [data-edit-count]`), "0 changes", "no change");
    assertEqual(repo.tip("thema/plan"), c.c5, "git: untouched");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Keyboard only: E, Alt+Down, S, Del, Ctrl+Enter", "edge", async (t) => {
  const { repo, c } = planRepo("graph-edit-keys");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await enterWithE(app, c.c3);
    await eventually(app, () => activeSha(app), c.c3, "the row E was pressed on is active");
    await app.press("Alt+ArrowDown");
    await eventually(app, async () => (await editRows(app)).map((row) => row.sha), [c.c5, c.c4, c.c2, c.c3, c.c1], "Alt+Down moves c3");
    await app.press("ArrowUp", "s");
    await eventually(app, () => chipOf(app, c.c2), "squash", "S squashes c2");
    await app.press("Home", "Delete");
    await eventually(app, () => chipOf(app, c.c5), "drop", "Del drops c5");
    assert((await editRows(app)).find((row) => row.sha === c.c5).struck, "the dropped summary is struck through");
    await parkMouse(app);
    await t.shot("edit-keyboard");

    await app.press("Control+Enter");
    await eventually(app, () => dialogTitle(app), "Drop 1 commit and start the rebase?", "drop confirmation");
    const text = await app.exec(() => document.querySelector('[role="dialog"], [role="alertdialog"]').innerText);
    assertIncludes(text, "Debug-Ausgabe", "the confirmation names the dropped commit");
    await app.click(await dialogButton(app, "Start rebase"));
    await eventually(app, () => leftEdit(app), true, "mode ends after apply", 30_000);
    assertEqual(repo.subjects("main..thema/plan"), ["Sensorliste ergänzt", "Zwischenstand Export", "Export fertig"], "git: 3 commits");
    assert(!repo.git("log", "--format=%s", "thema/plan").includes("Debug-Ausgabe"), "git: Debug-Ausgabe gone");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Inline reword: Enter applies, Escape keeps, Ctrl+Enter applies the plan", "edge", async (t) => {
  const { repo, c } = planRepo("graph-edit-reword");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await enterWithE(app, c.c5);

    // Double click on c2's summary opens the field.
    const at = await pointOf(app, `${editRow(c.c2)} [data-edit-row] span.truncate[title]`, { fx: 0.2 });
    await app.webdriver(
      "POST",
      "/actions",
      pointer([
        { type: "pointerMove", origin: "viewport", x: at.x, y: at.y },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ]),
    );
    await app.webdriver("DELETE", "/actions").catch(() => undefined);
    await app.waitFor(`${EDIT} [data-edit-reword]`, 5000, { message: "inline field" });
    await eventually(app, () => app.exec(() => document.activeElement?.hasAttribute("data-edit-reword") ?? false), true, "field focused");
    await app.press("Control+a", ..."README: Schulstationen".split(""), "Enter");
    await eventually(app, () => chipOf(app, c.c2), "reword", "c2 carries the chip reword");
    assertEqual((await editRows(app)).find((row) => row.sha === c.c2).summary, "README: Schulstationen", "c2 shows the new summary");
    await eventually(app, () => editListFocused(app), true, "focus back in the list");

    // Escape on c4's field keeps its summary.
    await app.press("Home", "ArrowDown", "Enter");
    await app.waitFor(`${EDIT} [data-edit-reword]`, 5000, { message: "field on c4" });
    await app.press("Control+a", ..."verworfen".split(""), "Escape");
    await eventually(
      app,
      () => app.exec((root) => document.querySelector(`${root} [data-edit-reword]`) === null, EDIT),
      true,
      "field closed",
    );
    const c4 = (await editRows(app)).find((row) => row.sha === c.c4);
    assertEqual([c4.summary, c4.chip], ["Export fertig", null], "Escape keeps c4's summary");
    await eventually(app, () => editListFocused(app), true, "focus back in the list after Escape");

    // c1: type in the field and Ctrl+Enter applies the plan with this text too.
    await app.press("End", "r");
    await app.waitFor(`${EDIT} [data-edit-reword]`, 5000, { message: "field on c1" });
    await app.press("Control+a", ..."Sensorliste: Hafen dazu".split(""), "Control+Enter");
    await eventually(app, () => leftEdit(app), true, "Ctrl+Enter in the field applies", 30_000);

    const shas = repo.git("rev-list", "--reverse", "main..thema/plan").split("\n");
    assertEqual(shas.length, 5, "still five commits");
    assertEqual(repo.git("log", "-1", "--format=%B", shas[1]), "README: Schulstationen\n", "git: c2's new message");
    assertEqual(repo.git("log", "-1", "--format=%s", shas[0]), "Sensorliste: Hafen dazu", "git: c1's message from the field");
    assertEqual(repo.git("log", "-1", "--format=%s", shas[3]), "Export fertig", "git: c4 unchanged");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Blocked with reason: dirty worktree, foreign commit, root commit, blocked Apply", "edge", async (t) => {
  const { repo, base, c } = planRepo("graph-edit-blocked");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);

    // A dirty tracked file (untracked ones do not block a rebase): the drag stops with a toast that
    // offers to stash. Entering asks the core afresh, so no app-side refresh needs to be awaited.
    repo.write("README.md", "# Messnetz\n\nEntwurf.\n");
    await pressAndPull(app, await pointOf(app, graphRow(c.c4), { fx: 0.6 }));
    await release(app);
    await waitToast(app, /Stash changes/);
    assert(!(await app.$(EDIT)), "the mode stays closed");
    await parkMouse(app);
    await t.shot("blocked-dirty");
    const stash = await app.waitFor(
      () =>
        app.exec(() => [...document.querySelectorAll("[data-toast] button")].find((b) => b.innerText.trim() === "Stash changes") ?? null),
      5000,
    );
    await app.click(stash);
    await eventually(app, () => repo.git("status", "--porcelain"), "", "git: stashed", 20_000);
    await closeToasts(app);
    await enterWithE(app, c.c4);

    // A blocked plan: squash on the oldest row. Apply is aria-disabled, never natively disabled.
    await app.press("End", "s");
    const apply = `${EDIT} [data-edit-apply]`;
    await eventually(app, () => app.exec((css) => document.querySelector(css)?.hasAttribute("data-blocked"), apply), true, "Apply blocked");
    const state = await app.exec((css) => {
      const button = document.querySelector(css);
      return { aria: button.getAttribute("aria-disabled"), disabled: button.disabled, why: button.getAttribute("aria-description") };
    }, apply);
    assertEqual([state.aria, state.disabled], ["true", false], "aria-disabled, never natively disabled");
    assertIncludes(state.why ?? "", "topmost", "the reason is described");
    // Ctrl+Enter from the list, then ArrowUp through the same key queue: once the active row moved,
    // Ctrl+Enter has been handled – and opened nothing.
    await app.press("Control+Enter", "ArrowUp");
    await eventually(app, () => activeSha(app), c.c2, "ArrowUp after Ctrl+Enter handled");
    assertEqual(await dialogCount(app), 0, "Ctrl+Enter: no confirmation for a blocked plan");
    // A click on the blocked Apply, then Escape on the button: the only dialog is the leave question.
    await app.click(apply);
    await app.press("Escape");
    await eventually(app, () => dialogTitle(app), "Discard your history edits?", "Escape on the bar asks; the click opened nothing");
    assertEqual(await dialogCount(app), 1, "no confirmation from the click");
    assertEqual(repo.tip("thema/plan"), c.c5, "git: nothing rewritten");
    await app.click(await dialogButton(app, "Discard"));
    await eventually(app, () => leftEdit(app), true, "left the mode");

    // A commit of main: E explains the branch's own commits.
    await selectGraphRow(app, base);
    await app.press("e");
    await waitToast(app, /This commit isn't part of the branch's own commits/);
    assert(!(await app.$(EDIT)), "the mode stays closed for main's commit");
    await closeToasts(app);

    // main's first commit cannot be the start.
    const items = await graphMenuItems(app, base);
    const here = items.find((item) => item.text.startsWith("Edit history from here"));
    assert(here, `menu entry missing: ${items.map((item) => item.text).join(" | ")}`);
    assert(here.disabled, "Edit history from here is disabled on the root commit");
    assertIncludes(here.text, "The first commit can't be the start", "with the reason");
    await app.press("Escape");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("External commit ends the mode; Escape asks only with changes", "edge", async (t) => {
  const { repo, c } = planRepo("graph-edit-extern");
  try {
    const app = await t.launch(LAUNCH);
    await openGraph(app, repo);
    await enterWithE(app, c.c4);
    await app.press("s");
    await eventually(app, () => chipOf(app, c.c4), "squash", "a change");
    repo.commit("extern.txt", "aus dem Terminal\n", "Im Terminal committet");
    await nudge(app);
    await waitToast(app, /The branch changed – history editing ended\. Nothing was applied\./);
    await eventually(app, () => leftEdit(app), true, "the mode ended");
    assertEqual(repo.subjects("main..thema/plan").length, 6, "git: nothing applied, the new commit on top");
    await closeToasts(app);

    // Without changes Escape leaves at once.
    await enterWithE(app, c.c4);
    await app.press("Escape");
    await eventually(app, () => leftEdit(app), true, "Escape leaves without changes");
    assertEqual(await dialogCount(app), 0, "no question");

    // With a change it asks; Cancel stays, Discard leaves.
    await enterWithE(app, c.c4);
    await app.press("d");
    await eventually(app, () => chipOf(app, c.c4), "drop", "a change");
    await app.press("Escape");
    await eventually(app, () => dialogTitle(app), "Discard your history edits?", "Escape asks");
    await parkMouse(app);
    await t.shot("leave-question");
    await app.click(await dialogButton(app, "Cancel"));
    await eventually(app, () => dialogCount(app), 0, "question closed");
    assert(await app.$(EDIT), "Cancel keeps the edit");
    assertEqual(await chipOf(app, c.c4), "drop", "and its change");
    await app.click(`${EDIT} [data-edit-discard]`);
    await app.click(await dialogButton(app, "Discard"));
    await eventually(app, () => leftEdit(app), true, "Discard leaves");
    assertEqual(repo.subjects("main..thema/plan").length, 6, "git: nothing rewritten");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Other branches are hidden; Open in rebase tool carries the plan and the update-refs tick", "edge", async (t) => {
  const repo = makeRepo("graph-edit-tool");
  try {
    repo.git("checkout", "-q", "-b", "thema/plan");
    const c1 = repo.commit("sensoren.txt", "Nord\nSüd\n", "Sensorliste ergänzt");
    const c2 = repo.commit("README.md", "# Messnetz\n\nSchul-Stationen.\n", "Tippfehler im README");
    // A commit of another branch, dated between c2 and c3.
    repo.git("checkout", "-q", "-b", "neben/übung", "main");
    repo.commit("neben.txt", "neben\n", "Nebenarbeit");
    repo.git("checkout", "-q", "thema/plan");
    const c3 = repo.commit("export.txt", "Zwischenstand\n", "Zwischenstand Export");
    const c4 = repo.commit("export.txt", "fertig\n", "Export fertig");
    // A branch inside the range: the edit offers to move it along.
    repo.git("branch", "thema/teil", c2);

    const app = await t.launch(LAUNCH);
    const { tabId } = await openGraph(app, repo);
    await enterWithE(app, c4);
    assertEqual(
      await textOf(app, `${EDIT} [data-edit-hidden]`),
      "1 more commit hidden while you edit",
      "the other branch's commit is hidden",
    );
    assertEqual(
      (await editRows(app)).map((row) => row.sha),
      [c4, c3, c2, c1],
      "only the branch's commits",
    );
    await app.press("s");
    await eventually(app, () => chipOf(app, c4), "squash", "S squashes c4");
    await app.click(`${EDIT} [data-edit-bar] [role="checkbox"]`);
    await eventually(
      app,
      () => app.exec((root) => document.querySelector(`${root} [data-edit-bar] [role="checkbox"]`)?.getAttribute("aria-checked"), EDIT),
      "true",
      "update refs ticked",
    );

    await app.click(`${EDIT} [data-edit-open-tool]`);
    await app.waitFor(`${REBASE} [role="listbox"]`, 30_000);
    // The tool only mounts once the centre changed; a discard question would have held that up, so it is checked now.
    assertEqual(await dialogCount(app), 0, "no discard question");
    assertEqual(await app.exec((id) => window.__gc.store.getState().views[id]?.center?.kind, tabId), "rebase", "the tool is open");
    await eventually(
      app,
      async () => (await rebaseRows(app)).map((row) => [row.sha, row.action]),
      [
        [c1, "pick"],
        [c2, "pick"],
        [c3, "pick"],
        [c4, "squash"],
      ],
      "the rows arrive in the tool, c4 as squash",
    );
    assertEqual(
      await app.exec((root) => document.querySelector(`${root} [role="checkbox"]`)?.getAttribute("aria-checked"), REBASE),
      "true",
      "the update-refs tick came along",
    );
    await parkMouse(app);
    await t.shot("handed-to-tool");
    assertEqual(repo.tip("thema/plan"), c4, "git: nothing rewritten yet");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("German texts", "edge", async (t) => {
  const { repo, c } = planRepo("graph-edit-de");
  try {
    const app = await t.launch({ ...LAUNCH, lang: "de" });
    await openGraph(app, repo);
    const items = await graphMenuItems(app, c.c3);
    assert(
      items.some((item) => item.text.startsWith("Verlauf bearbeiten")),
      `"Verlauf bearbeiten" in the row menu: ${items.map((item) => item.text).join(" | ")}`,
    );
    await app.press("Escape");
    await enterWithE(app, c.c3);
    await app.press("Alt+ArrowDown");
    await eventually(app, () => chipOf(app, c.c3), "verschoben", "chip verschoben");
    await eventually(app, () => textOf(app, `${EDIT} [data-edit-preview]`), "Keine Konflikte", "Keine Konflikte", 30_000);
    assertEqual(await textOf(app, `${EDIT} [data-edit-apply]`), "Anwenden", "Anwenden");
    await parkMouse(app);
    await t.shot("deutsch");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
