/**
 * "Clean up repository" in the real app over WebDriver (Paket 10): opening it from the command
 * palette and from the repository list, the preview against `git count-objects -v`, a Normal run
 * with its result line, the warnings, closing the dialog while it runs, cancelling a Thorough run on
 * a large generated repository, and the German texts.
 *
 *   node scripts/e2e-wd/features/cleanup.mjs
 *   E2E_WD_ONLY=cancel node scripts/e2e-wd/features/cleanup.mjs
 *
 * Every check also asks Git: `git count-objects -v`, `git fsck`, `git for-each-ref`.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { assert, assertEqual, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------------------------

const envFor = (fx) => ({ ...process.env, ...gitIsolationEnv(path.join(fx.root, "gitconfig")) });
const git = (fx, ...args) => execFileSync("git", args, { cwd: fx.path, env: envFor(fx), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }).trim();
/** `git count-objects -v` as numbers (KiB values, as Git prints them). */
const countObjects = (fx) =>
  Object.fromEntries(
    git(fx, "count-objects", "-v")
      .split("\n")
      .map((line) => line.split(": "))
      .map(([key, value]) => [key, Number(value)]),
  );

/**
 * Branch "archiv" with `files` random blobs of `size` bytes each (git fast-import) and one pack
 * thread: `git gc --aggressive` then needs well over ten seconds, long enough to cancel it.
 */
function addRandomArchive(fx, { files = 200, size = 512 * 1024 } = {}) {
  const parts = [];
  for (let n = 1; n <= files; n++) {
    const data = crypto.randomBytes(size);
    parts.push(Buffer.from(`blob\nmark :${n}\ndata ${data.length}\n`), data, Buffer.from("\n"));
  }
  const message = "Rohdaten-Archiv der Stationen";
  parts.push(Buffer.from(`commit refs/heads/archiv\nmark :${files + 1}\ncommitter Lena Hartmann <lena.hartmann@wetterstation.example> 1772434800 +0100\ndata ${Buffer.byteLength(message)}\n${message}\n`));
  for (let n = 1; n <= files; n++) parts.push(Buffer.from(`M 100644 :${n} archiv/rohdaten-${String(n).padStart(4, "0")}.bin\n`));
  parts.push(Buffer.from("\n"));
  execFileSync("git", ["fast-import", "--quiet"], { cwd: fx.path, env: envFor(fx), input: Buffer.concat(parts), maxBuffer: 1 << 26 });
  git(fx, "config", "pack.threads", "1");
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

/** Runs a command via the palette, keyboard only (F1, type, Enter). */
async function palette(app, text) {
  await app.press("F1");
  const input = await app.waitFor('input[role="combobox"]', 5000);
  await app.type(input, text);
  await app.waitFor(
    () => app.exec((wanted) => (document.querySelector('[data-screen="command-palette"] [role="option"][aria-selected="true"]')?.textContent ?? "").toLowerCase().includes(wanted.toLowerCase()), text),
    5000,
    { message: `palette entry "${text}" selected` },
  );
  await app.press("Enter");
}

const cleanupState = (app) => app.exec(() => document.querySelector('[data-screen="repo-cleanup"]')?.getAttribute("data-cleanup") ?? null);
async function waitState(app, wanted, timeout = 30_000) {
  await app.waitFor(async () => (await cleanupState(app)) === wanted, timeout, { message: `clean-up dialog in state "${wanted}"` }).catch(async (error) => {
    throw new Error(`${error.message}; now "${await cleanupState(app)}": ${await dialogText(app)}`);
  });
}
const figure = (app, name) => app.exec((wanted) => document.querySelector(`[data-screen="repo-cleanup"] [data-figure="${wanted}"]`)?.getAttribute("data-value") ?? null, name);
const dialogText = (app) => app.exec(() => [...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText.replace(/\s+/g, " ") ?? "");
const dialogCount = (app) => app.exec(() => document.querySelectorAll('[role="dialog"]').length);
const inDialog = (app, text) => app.waitFor(() => app.byText(text, { within: '[role="dialog"]' }), 10_000, { message: `"${text}" in the dialog` });
const stepStatus = (app, step) => app.exec((wanted) => document.querySelector(`[data-screen="repo-cleanup"] [data-step="${wanted}"]`)?.getAttribute("data-status") ?? null, step);
const checked = (app, option) => app.exec((wanted) => document.querySelector(`[data-option="${wanted}"] [role="checkbox"]`)?.getAttribute("aria-checked") ?? null, option);
const toasts = (app) => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
const runningJobs = (app) => app.exec(() => Object.values(window.__gc.store.getState().jobs).map((job) => job.title));

/** Opens the dialog from the palette; it may show a form, a running clean-up or a result. */
async function openDialog(app, title = "Clean up repository") {
  await palette(app, title);
  await app.waitFor('[role="dialog"] [data-screen="repo-cleanup"]', 15_000);
}
/** Opens the dialog and waits for its form (the preview has loaded). */
async function openFromPalette(app, title = "Clean up repository") {
  await openDialog(app, title);
  await waitState(app, "form");
  await app.settle();
}

/** Right-click on an element; returns the labels of the menu entries. */
async function contextMenu(app, element) {
  await app.exec((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: box.left + 40, clientY: box.top + box.height / 2 }));
  }, element);
  return app.waitFor(
    async () => {
      const items = await app.exec(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent.replace(/\s+/g, " ").trim()));
      return items.length ? items : null;
    },
    5000,
    { message: "context menu open" },
  );
}
async function chooseMenu(app, label) {
  const item = await app.waitFor(
    () => app.exec((text) => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((entry) => entry.textContent.replace(/\s+/g, " ").trim().startsWith(text)) ?? null, label),
    5000,
    { message: `menu entry "${label}"` },
  );
  await app.click(item);
}

// =============================================================================================
// Scenarios
// =============================================================================================

scenario("palette: the preview matches git count-objects and Normal shows the result", "main", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const before = countObjects(fx);
    assert(before.count > 0, `fixture has loose objects: ${JSON.stringify(before)}`);
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openFromPalette(app);
    assertEqual(Number(await figure(app, "loose")), before.count, "loose objects as Git counts them");
    assertEqual(Number(await figure(app, "packs")), before.packs, "packs as Git counts them");
    assertEqual(Number(await figure(app, "objects")), (before.size + before["size-pack"] + before["size-garbage"]) * 1024, "Git objects in total, in bytes");
    const text = await dialogText(app);
    assertMatch(text, /Clean-up can’t be undone\./, "irreversible note above the buttons");
    assertMatch(text, /Frees: packs loose objects/, "Normal says what it frees");
    assertEqual(await checked(app, "reflog"), "false", "Shorten the reflog starts unticked");
    await t.shot("form");
    await app.click(await inDialog(app, "Clean up"));
    await waitState(app, "result", 120_000);
    const result = await dialogText(app);
    assertMatch(result, /Clean-up finished\./, "outcome");
    assertMatch(result, /Git objects: \S+ (B|KB|MB) → \S+ (B|KB|MB)/, "result line with both sizes");
    assertEqual(await stepStatus(app, "gc"), "done", "gc done");
    assertEqual(await stepStatus(app, "reflog"), "skipped", "unticked step skipped");
    assertEqual(countObjects(fx).count, 0, "git count-objects: no loose objects left");
    await t.shot("result");
    await app.click(await inDialog(app, "Close"));
    await app.waitFor(async () => (await dialogCount(app)) === 0, 5000, { message: "dialog closed" });
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("repository list: entry above “Show in file manager”, warnings for Thorough, undo backups and the reflog", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const before = git(fx, "count-objects", "-v");
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await app.press("Control+t");
    await app.waitFor('[data-screen="repo-management"]', 15_000);
    await app.settle();
    const row = await app.waitFor(
      () => app.exec((name) => [...document.querySelectorAll('[data-screen="repo-management"] [role="option"]')].find((item) => item.innerText.includes(name)) ?? null, "messnetz"),
      10_000,
      { message: "repository row" },
    );
    const labels = await contextMenu(app, row);
    const cleanup = labels.findIndex((label) => label.startsWith("Clean up repository"));
    const reveal = labels.findIndex((label) => label.startsWith("Show in file manager"));
    assert(cleanup >= 0 && cleanup === reveal - 1, `“Clean up repository …” right above “Show in file manager”: ${JSON.stringify(labels)}`);
    await chooseMenu(app, "Clean up repository");
    await app.waitFor('[role="dialog"] [data-screen="repo-cleanup"]', 15_000);
    await waitState(app, "form");
    await app.click(await inDialog(app, "Thorough"));
    const text = await dialogText(app);
    assertMatch(text, /Can take a long time on large repositories \(minutes to hours\)/, "Thorough warns about time and space");
    assertMatch(text, /Undo is no longer possible for these actions afterwards\./, "undo backups warn");
    assertMatch(text, /Destructive: Commits that are only in the reflog are lost for good afterwards/, "reflog warning with its word");
    const reflogWarning = await app.exec(() => {
      const warning = document.querySelector('[data-option="reflog"] [data-warning="reflog"]');
      return warning ? { word: warning.querySelector("strong")?.textContent ?? "", danger: warning.classList.contains("text-danger") } : null;
    });
    assertEqual(reflogWarning, { word: "Destructive:", danger: true }, "red reflog warning that also says it in a word");
    await t.shot("warnings");
    await app.click(await inDialog(app, "Cancel"));
    await app.waitFor(async () => (await dialogCount(app)) === 0, 5000, { message: "dialog closed" });
    assertEqual(git(fx, "count-objects", "-v"), before, "Cancel changes nothing");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("closing the dialog during a run: the job stays in the status bar, reopening shows the result", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    addRandomArchive(fx, { files: 120, size: 512 * 1024 });
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openFromPalette(app);
    await app.click(await inDialog(app, "Thorough"));
    await app.click(await inDialog(app, "Clean up"));
    await waitState(app, "running");
    await app.click(await inDialog(app, "Continue in background"));
    await app.waitFor(async () => (await dialogCount(app)) === 0, 5000, { message: "dialog closed while running" });
    assert((await runningJobs(app)).includes("Clean up repository"), "the job shows in the status bar");
    await app.waitFor(async () => !(await runningJobs(app)).includes("Clean up repository"), 180_000, { message: "clean-up finished" });
    await app.waitFor(async () => (await toasts(app)).some((toast) => toast.tone === "success" && /Repository cleaned up – .+ → .+/.test(toast.text)), 10_000, { message: "success message" });
    await openDialog(app);
    await waitState(app, "result");
    assertEqual(await stepStatus(app, "gc"), "done");
    await app.click(await inDialog(app, "Close"));
    await openFromPalette(app);
    assert((await cleanupState(app)) === "form", "after seeing the result the next opening starts fresh");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("cancel during Thorough on a large generated repository leaves it valid", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    addRandomArchive(fx);
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openFromPalette(app);
    await app.click(await inDialog(app, "Thorough"));
    await app.click(await inDialog(app, "Clean up"));
    await app.waitFor(
      async () => /Step 1 of 1 – Git packs objects …/.test(await dialogText(app)),
      30_000,
      { message: "progress “Step 1 of 1 – Git packs objects …”" },
    );
    await sleep(500);
    await t.shot("running");
    await app.click(await inDialog(app, "Cancel"));
    await waitState(app, "result", 60_000);
    assertMatch(await dialogText(app), /Clean-up cancelled\. Finished steps stay; the repository is valid\./, "cancelled outcome");
    assertEqual(await stepStatus(app, "gc"), "cancelled", "gc step cancelled");
    git(fx, "fsck", "--no-progress");
    assertEqual(git(fx, "for-each-ref", "refs/forkyard/keep/"), "", "no keep refs left");
    assertEqual(git(fx, "rev-parse", "--verify", "archiv^{commit}").length, 40, "the archive branch is intact");
    await t.shot("cancelled");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("German texts", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const app = await t.launch({ ...LAUNCH, lang: "de" });
    await app.openRepo(fx.path);
    await openFromPalette(app, "Repository aufräumen");
    const text = await dialogText(app);
    for (const wanted of [/Git-Objekte gesamt/, /Davon lose Objekte/, /Gründlich/, /Aufräumen lässt sich nicht rückgängig machen\./, /Rückgängig ist für diese Aktionen danach nicht mehr möglich\./, /Zerstörerisch: Commits, die nur noch im Reflog stehen/]) {
      assertMatch(text, wanted, `German: ${wanted}`);
    }
    await app.click(await inDialog(app, "Aufräumen"));
    await waitState(app, "result", 120_000);
    const result = await dialogText(app);
    assertMatch(result, /Aufräumen abgeschlossen\./, "German outcome");
    assertMatch(result, /Git-Objekte: \S+ (B|KB|MB) → \S+ (B|KB|MB)/, "German result line");
    await t.shot("deutsch");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});
