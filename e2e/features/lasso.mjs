/**
 * Partial commits by lasso in the real app: lines selected in the unstaged diff stay selected across
 * files; "Commit only this" commits exactly those lines, "Move to new branch …" puts them on a new
 * branch and takes them out of the working copy (one Undo brings everything back). Every check also
 * asks Git (git show, git diff --cached, git rev-parse, file bytes).
 *
 *   node e2e/features/lasso.mjs
 *   E2E_WD_ONLY="branch" node e2e/features/lasso.mjs
 */
import { commitUi, gitRaw, readBytes, writeBytes } from "../fixtures/commit-ui.mjs";
import { makeRepo, rightClick } from "../fixtures/rebase.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

const SESSION = "session.ts";
const EXPORT = "export ü.ts";
const NOTES = "notizen.txt";
const CRLF = "crlf.txt";

const range = (n) => Array.from({ length: n }, (_, index) => index + 1);
const SESSION_BASE = range(20).map((n) => `export const wert${n} = ${n};`);
const EXPORT_BASE = range(20).map((n) => `export const feld${n} = "${n}";`);
const CRLF_BASE = ["eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn"];
const text = (lines) => `${lines.join("\n")}\n`;

/** session.ts: line 3 changed (hunk 0), a line added after line 16 (hunk 1). */
const sessionChanged = ({ wert3 = true, neu = true } = {}) => {
  const lines = [...SESSION_BASE];
  if (wert3) lines[2] = "export const wert3 = 300;";
  if (neu) lines.splice(16, 0, 'export const neu = "Sitzung";');
  return lines;
};
/** export ü.ts: a line added after line 2 (hunk 0), line 17 changed (hunk 1). */
const exportChanged = ({ umlaut = true, feld17 = true } = {}) => {
  const lines = [...EXPORT_BASE];
  if (feld17) lines[16] = 'export const feld17 = "siebzehn";';
  if (umlaut) lines.splice(2, 0, 'export const umlaut = "äöü";');
  return lines;
};

/** Committed: session.ts, export ü.ts, notizen.txt, crlf.txt (CRLF). Nothing changed yet. */
function lassoRepo(name) {
  const repo = makeRepo(name);
  repo.write(SESSION, text(SESSION_BASE));
  repo.write(EXPORT, text(EXPORT_BASE));
  repo.write(NOTES, "Notizen\n");
  repo.write(CRLF, `${CRLF_BASE.join("\r\n")}\r\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Sitzung und Export");
  return repo;
}

/** Two changes in each source file and a staged note. */
function changeAll(repo) {
  repo.write(SESSION, text(sessionChanged()));
  repo.write(EXPORT, text(exportChanged()));
  repo.write(NOTES, "Notizen\nGestaged\n");
  repo.git("add", NOTES);
}

const showBytes = (repo, spec) => gitRaw(repo, ["show", spec]);
const undoRefs = (repo) => repo.git("for-each-ref", "--format=%(refname)", "refs/forkyard/undo/");
const branchExists = (repo, name) => repo.gitMay("rev-parse", "--verify", "-q", `refs/heads/${name}`).trim() !== "";

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

const launch = (t, options = {}) => t.launch({ width: 1440, height: 900, lang: "en", theme: "light", ...options });

/** Opens the repository with the commit panel on the right. */
async function open(t, repo, options) {
  const app = await launch(t, options);
  const ui = commitUi(app);
  const { repoId, tabId } = await app.openRepo(repo.path);
  await ui.selectWip(tabId);
  await app.waitFor('[data-screen="commit-panel"]', 15_000);
  return { app, ui, repoId, tabId };
}

/** Drags in the line-number column from one gutter to another (pointer down, move, up). */
async function drag(app, from, to) {
  await app.webdriver("POST", "/actions", {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: { [ELEMENT_KEY]: from.id }, x: 0, y: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 150, origin: { [ELEMENT_KEY]: to.id }, x: 0, y: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** The lasso count on the bar: { text, live } or null when there is none. */
const lassoCount = (app) =>
  app.exec(() => {
    const node = document.querySelector("[data-lasso-count]");
    return node ? { text: node.innerText.trim(), live: node.getAttribute("aria-live") } : null;
  });
const waitCount = (app, expected) =>
  app.waitFor(async () => (await lassoCount(app))?.text === expected, 10_000, { message: `lasso count "${expected}"` });
const waitNoBar = (app) =>
  app.waitFor(() => app.exec(() => !document.querySelector("[data-lasso-count]")), 10_000, { message: "lasso bar gone" });

/** "N selected" next to the file in the unstaged list, or null. */
const fileDetail = (app, file) =>
  app.exec(
    (key) =>
      [...document.querySelectorAll('[data-section="unstaged"] [data-row-key]')]
        .find((row) => row.dataset.rowKey === key)
        ?.querySelector("[data-lasso-detail]")
        ?.textContent.trim() ?? null,
    file,
  );

/** ui.openDiff for the German UI (its readiness check reads the English aria-label). */
async function openDiffDe(app, ui, file) {
  await app.click(await ui.row("unstaged", file));
  await app.waitFor(
    () =>
      app.exec((label) => {
        const root = document.querySelector('[data-screen="diff"]');
        return root?.getAttribute("aria-label") === label && !root.querySelector("[data-diff-loading]");
      }, `Diff von ${file}`),
    30_000,
    { message: `diff of ${file} loaded` },
  );
  await app.settle();
}

const lassoButton = (app, action) => app.waitFor(`[data-selection-bar] [data-action="${action}"]`, 10_000);

/** Types the commit summary into the commit field. */
async function setSummary(app, ui, summary) {
  await ui.fill(await ui.summary(), summary);
  await app.exec(() => document.activeElement?.blur());
}

/** Answers the "Move to new branch" dialog. `summary: null` keeps the prefilled message. */
async function answerBranchDialog(app, branch, summary = null) {
  const field = await app.waitFor("[role='dialog'] input[data-lasso-branch-name]", 10_000);
  await app.type(field, branch);
  if (summary !== null) {
    const summaryField = await app.exec(() =>
      [...document.querySelectorAll("[role='dialog'] input")].find((input) => !input.hasAttribute("data-lasso-branch-name")),
    );
    await app.click(summaryField);
    await app.press("Control+a", "Backspace");
    await app.type(summaryField, summary);
  }
  const confirm = await app.waitFor(
    () =>
      app.exec(
        () =>
          [...document.querySelectorAll("[role='dialog'] button")].find(
            (button) => /^(Create branch|Branch anlegen)$/.test(button.textContent.trim()) && !button.disabled,
          ) ?? null,
      ),
    10_000,
    { message: "enabled confirm button" },
  );
  await app.click(confirm);
  await app.waitFor(() => app.exec(() => !document.querySelector("[role='dialog']")), 10_000, { message: "dialog closed" });
}

/** Clicks the action button of the toast whose text matches. */
async function clickToastAction(app, pattern, label) {
  const button = await app.waitFor(
    () =>
      app.exec(
        (source, wanted) => {
          const toast = [...document.querySelectorAll("[data-toast]")].find((node) => new RegExp(source).test(node.innerText));
          return toast ? ([...toast.querySelectorAll("button")].find((node) => node.textContent.trim() === wanted) ?? null) : null;
        },
        pattern.source,
        label,
      ),
    10_000,
    { message: `toast action "${label}"` },
  );
  await app.click(button);
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

scenario("select lines in two files, commit only these", "main", async (t) => {
  const repo = lassoRepo("lasso-commit");
  try {
    changeAll(repo);
    const headBefore = repo.tip();
    const { app, ui, repoId } = await open(t, repo);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 1, conflicted: 0 });

    // session.ts: drag over the two line numbers of the first change.
    await ui.openDiff("unstaged", SESSION);
    await drag(app, await ui.gutter("remove", "export const wert3 = 3;"), await ui.gutter("add", "export const wert3 = 300;"));
    assertEqual(await ui.selectedRows(), ["-export const wert3 = 3;", "+export const wert3 = 300;"], "drag selects both rows");
    await waitCount(app, "2 lines in 1 file");

    // export ü.ts: one click on a line number; the lasso spans both files.
    await ui.openDiff("unstaged", EXPORT);
    assertEqual(await ui.selectedRows(), [], "the other file starts without a selection");
    await app.click(await ui.gutter("add", 'export const umlaut = "äöü";'));
    await waitCount(app, "3 lines in 2 files");
    assertEqual((await lassoCount(app)).live, "polite", "the count is announced (aria-live)");

    // Back to session.ts: its two lines are still selected.
    await ui.openDiff("unstaged", SESSION);
    assertEqual(await ui.selectedRows(), ["-export const wert3 = 3;", "+export const wert3 = 300;"], "selection kept across files");
    assertEqual(await fileDetail(app, SESSION), "2 selected", "file list: session.ts");
    assertEqual(await fileDetail(app, EXPORT), "1 selected", "file list: export ü.ts");
    await t.shot("lasso-two-files");
    const fits = await app.exec(() => {
      const bar = document.querySelector("[data-selection-bar]").getBoundingClientRect();
      const pane = document.querySelector('[data-screen="diff"]').getBoundingClientRect();
      return bar.left >= pane.left && bar.right <= pane.right;
    });
    assert(fits, "the selection bar with lasso and line buttons fits inside the diff");

    // Empty commit field: the button sends nothing and focuses the summary.
    await app.click(await lassoButton(app, "lasso-commit"));
    await app.waitFor(() => app.exec(() => document.activeElement?.hasAttribute("data-commit-summary") ?? false), 10_000, {
      message: "summary field focused",
    });
    assertEqual(repo.tip(), headBefore, "git: nothing committed without a message");

    await setSummary(app, ui, "Nur die Sitzung");
    await app.click(await lassoButton(app, "lasso-commit"));
    await ui.waitToast("success", /Commit created/);

    assertEqual(repo.tip("HEAD~1"), headBefore, "git: one new commit on HEAD");
    assertEqual(repo.git("log", "-1", "--format=%s"), "Nur die Sitzung", "git: message");
    const expectSession = [...SESSION_BASE];
    expectSession[2] = "export const wert3 = 300;";
    assertEqual(repo.git("show", `HEAD:${SESSION}`), expectSession.join("\n"), "git: HEAD has exactly the two session.ts lines");
    assertEqual(
      repo.git("show", `HEAD:${EXPORT}`),
      exportChanged({ feld17: false }).join("\n"),
      "git: HEAD has exactly the one export ü.ts line",
    );
    assertEqual(repo.git("show", `HEAD:${NOTES}`), "Notizen", "git: the staged note is not in the commit");
    assertEqual(repo.git("diff", "--cached", "--name-only"), NOTES, "git: the staged change stays staged");
    assertEqual(repo.git("show", `:${NOTES}`), "Notizen\nGestaged", "git: staged content unchanged");
    assertEqual(repo.read(SESSION), text(sessionChanged()), "file: session.ts unchanged on disk");
    assertEqual(repo.read(EXPORT), text(exportChanged()), "file: export ü.ts unchanged on disk");
    await waitNoBar(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("move to a new branch, Undo, switch to it", "edge", async (t) => {
  const repo = lassoRepo("lasso-branch");
  try {
    repo.write(SESSION, text(sessionChanged({ wert3: false })));
    repo.write(EXPORT, text(exportChanged()));
    const headBefore = repo.tip();
    const { app, ui, repoId } = await open(t, repo);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await setSummary(app, ui, "Entwurf bleibt");

    await ui.openDiff("unstaged", SESSION);
    await app.click(await ui.gutter("add", 'export const neu = "Sitzung";'));
    await waitCount(app, "1 line in 1 file");
    await app.click(await lassoButton(app, "lasso-branch"));
    await answerBranchDialog(app, "auslagerung/ä", "Konstante ausgelagert");
    await ui.waitToast("success", /Moved to auslagerung\/ä/);

    assertEqual(repo.tip(), headBefore, "git: HEAD unchanged");
    assertEqual(repo.git("symbolic-ref", "--short", "HEAD"), "main", "git: still on main");
    assertEqual(repo.tip("auslagerung/ä~1"), headBefore, "git: the branch starts at HEAD");
    assertEqual(repo.git("log", "-1", "--format=%s", "auslagerung/ä"), "Konstante ausgelagert", "git: message from the dialog");
    assertEqual(repo.git("show", `auslagerung/ä:${SESSION}`), sessionChanged({ wert3: false }).join("\n"), "git: the branch has the line");
    assertEqual(repo.read(SESSION), text(SESSION_BASE), "file: the line left the working copy");
    assertEqual(repo.read(EXPORT), text(exportChanged()), "file: the other file is untouched");
    assertEqual((await ui.fields()).summary, "Entwurf bleibt", "the commit draft stays");
    await waitNoBar(app);

    // One Undo: branch gone, the line back.
    await ui.closeToasts();
    await app.exec(() => document.activeElement?.blur());
    await app.press("Control+z");
    await app.waitFor(() => !branchExists(repo, "auslagerung/ä"), 20_000, { message: "undo removes the branch" });
    await app.waitFor(() => repo.read(SESSION) === text(sessionChanged({ wert3: false })), 20_000, {
      message: "undo brings the line back",
    });
    assertEqual(repo.tip(), headBefore, "git: HEAD unchanged after undo");
    assertEqual(repo.read(EXPORT), text(exportChanged()), "file: export ü.ts unchanged after undo");

    // Again, then "Switch to branch".
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });
    await ui.openDiff("unstaged", SESSION);
    await app.click(await ui.gutter("add", 'export const neu = "Sitzung";'));
    await waitCount(app, "1 line in 1 file");
    await app.click(await lassoButton(app, "lasso-branch"));
    await answerBranchDialog(app, "auslagerung/ä");
    await clickToastAction(app, /Moved to auslagerung\/ä/, "Switch to branch");
    await app.waitFor(() => repo.git("symbolic-ref", "--short", "HEAD") === "auslagerung/ä", 20_000, { message: "switched" });
    assertEqual(repo.git("log", "-1", "--format=%s"), "Entwurf bleibt", "git: the prefilled draft became the message");
    assertEqual(repo.read(SESSION), text(sessionChanged({ wert3: false })), "file: the branch's version is checked out");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("staged changes in the same place are refused with the file name", "edge", async (t) => {
  const repo = lassoRepo("lasso-kollision");
  try {
    const staged = [...SESSION_BASE];
    staged[2] = "export const wert3 = 300;";
    repo.write(SESSION, text(staged));
    repo.git("add", SESSION);
    const worktree = [...staged];
    worktree[2] = "export const wert3 = 3000;";
    repo.write(SESSION, text(worktree));
    const headBefore = repo.tip();
    const refsBefore = undoRefs(repo);
    const { app, ui, repoId } = await open(t, repo);
    await ui.waitCounts(repoId, { unstaged: 1, staged: 1, conflicted: 0 });

    await ui.openDiff("unstaged", SESSION);
    await drag(app, await ui.gutter("remove", "export const wert3 = 300;"), await ui.gutter("add", "export const wert3 = 3000;"));
    await waitCount(app, "2 lines in 1 file");
    await setSummary(app, ui, "Darf nicht entstehen");
    await app.click(await lassoButton(app, "lasso-commit"));
    const refusal = await ui.waitToast("danger", /session\.ts/);
    t.step(`refused: ${refusal}`);

    assertEqual(repo.tip(), headBefore, "git: HEAD unchanged");
    assertEqual(repo.git("show", `:${SESSION}`), staged.join("\n"), "git: index unchanged");
    assertEqual(repo.read(SESSION), text(worktree), "file: unchanged");
    assertEqual(undoRefs(repo), refsBefore, "git: no backup refs");
    await waitCount(app, "2 lines in 1 file");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("a file changed on disk loses only its selection, also while the right panel shows something else", "edge", async (t) => {
  const repo = lassoRepo("lasso-aussen");
  try {
    changeAll(repo);
    const { app, ui, repoId, tabId } = await open(t, repo);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 1, conflicted: 0 });
    await ui.openDiff("unstaged", SESSION);
    await app.click(await ui.gutter("add", 'export const neu = "Sitzung";'));
    await ui.openDiff("unstaged", EXPORT);
    await app.click(await ui.gutter("add", 'export const umlaut = "äöü";'));
    await waitCount(app, "2 lines in 2 files");

    // An editor saves session.ts: only its selection goes, with a notice.
    repo.write(SESSION, text([...sessionChanged(), "// gespeichert"]));
    await ui.waitToast("info", /Selection in session\.ts cleared – the file has changed/);
    await waitCount(app, "1 line in 1 file");
    assertEqual(await fileDetail(app, SESSION), null, "file list: session.ts has no selection");
    assertEqual(await fileDetail(app, EXPORT), "1 selected", "file list: export ü.ts keeps its selection");
    assertEqual(await ui.selectedRows(), ['+export const umlaut = "äöü";'], "the open diff keeps its line");
    await ui.closeToasts();

    // The right panel shows a commit instead of the commit form: the guard still acts, the bar keeps counting.
    await ui.openDiff("unstaged", SESSION);
    await app.click(await ui.gutter("add", 'export const neu = "Sitzung";'));
    await waitCount(app, "2 lines in 2 files");
    await ui.selectCommit(tabId, repo.tip());
    await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="commit-panel"]')), 10_000, {
      message: "commit panel gone",
    });
    repo.write(EXPORT, text([...exportChanged(), "// gespeichert"]));
    await ui.waitToast("info", /Selection in export ü\.ts cleared – the file has changed/);
    await waitCount(app, "1 line in 1 file");
    assert(await app.exec(() => !document.querySelector('[data-screen="commit-panel"]')), "the notice came without the commit panel");
    await ui.closeToasts();

    // "Commit only this" with an empty message brings the commit form up and focuses its summary.
    const headBefore = repo.tip();
    await app.click(await lassoButton(app, "lasso-commit"));
    await app.waitFor(() => app.exec(() => document.activeElement?.hasAttribute("data-commit-summary") ?? false), 10_000, {
      message: "commit form up, summary field focused",
    });
    assertEqual(repo.tip(), headBefore, "git: nothing committed without a message");
    await waitCount(app, "1 line in 1 file");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("a commit from the terminal or a checked Amend writes nothing and keeps the lasso", "edge", async (t) => {
  const repo = lassoRepo("lasso-veraltet");
  try {
    changeAll(repo);
    const { app, ui, repoId } = await open(t, repo);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 1, conflicted: 0 });
    await ui.openDiff("unstaged", SESSION);
    await app.click(await ui.gutter("add", 'export const neu = "Sitzung";'));
    await waitCount(app, "1 line in 1 file");

    // Amend checked: blocked with the hint, nothing sent.
    const headBefore = repo.tip();
    await app.click(await ui.checkbox("Amend"));
    await app.waitFor(() => ui.checked("Amend"), 5000, { message: "Amend checked" });
    await setSummary(app, ui, "Nur die neue Konstante");
    await app.click(await lassoButton(app, "lasso-commit"));
    await app.waitFor(async () => (await ui.formAlert())?.includes("Uncheck “Amend” first"), 10_000, { message: "amend hint" });
    assertEqual(repo.tip(), headBefore, "git: nothing amended");
    assert(await ui.checked("Amend"), "Amend stays checked");
    await waitCount(app, "1 line in 1 file");
    await app.click(await ui.checkbox("Amend"));
    await app.waitFor(async () => !(await ui.checked("Amend")), 5000, { message: "Amend unchecked" });
    await setSummary(app, ui, "Nur die neue Konstante");

    // A commit from the terminal the app has not seen yet when the button is clicked: stale_state.
    repo.write("README.md", "# Messnetz\n\nVom Terminal.\n");
    repo.git("commit", "-q", "-m", "Vom Terminal", "--", "README.md");
    const terminal = repo.tip();
    const before = { index: repo.git("diff", "--cached"), session: readBytes(repo, SESSION), refs: undoRefs(repo) };
    // The window between the outside commit and the app noticing it, made deterministic: the cached
    // status still names the old HEAD at the moment of the click.
    await app.exec(
      (id, old) => {
        const key = ["repo", id, "status"];
        const status = window.__gc.queryClient.getQueryData(key);
        window.__gc.queryClient.setQueryData(key, { ...status, head: { ...status.head, sha: old } });
        document.querySelector('[data-selection-bar] [data-action="lasso-commit"]').click();
      },
      repoId,
      headBefore,
    );
    const refusal = await ui.waitToast("danger", /changed in the meantime/);
    t.step(`refused: ${refusal}`);
    assertEqual(repo.tip(), terminal, "git: no commit on top of the terminal commit");
    assertEqual(repo.git("diff", "--cached"), before.index, "git: index unchanged");
    assert(readBytes(repo, SESSION).equals(before.session), "file: session.ts unchanged");
    assertEqual(undoRefs(repo), before.refs, "git: no backup refs");
    await ui.closeToasts();
    await waitCount(app, "1 line in 1 file");

    // Once the app has the new HEAD, the same lasso commits on top of it.
    await app.waitFor(
      () =>
        app.exec((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"])?.head.sha, repoId).then((sha) => sha === terminal),
      15_000,
      { message: "status has the terminal commit" },
    );
    await app.click(await lassoButton(app, "lasso-commit"));
    await ui.waitToast("success", /Commit created/);
    assertEqual(repo.tip("HEAD~1"), terminal, "git: the lasso commit follows the terminal commit");
    assertEqual(repo.git("show", "--name-only", "--format=", "HEAD").trim(), SESSION, "git: only session.ts");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Escape clears the whole lasso; a CRLF file keeps its line endings", "edge", async (t) => {
  const repo = lassoRepo("lasso-crlf");
  try {
    const crlf = [...CRLF_BASE];
    crlf[1] = "ZWEI";
    crlf[8] = "NEUN";
    writeBytes(repo, CRLF, `${crlf.join("\r\n")}\r\n`);
    repo.write(SESSION, text(sessionChanged()));
    const { app, ui, repoId } = await open(t, repo);
    await ui.waitCounts(repoId, { unstaged: 2, staged: 0, conflicted: 0 });

    await ui.openDiff("unstaged", CRLF);
    await drag(app, await ui.gutter("remove", "zwei"), await ui.gutter("add", "ZWEI"));
    await waitCount(app, "2 lines in 1 file");
    await setSummary(app, ui, "Nur ZWEI");
    await app.click(await lassoButton(app, "lasso-commit"));
    await ui.waitToast("success", /Commit created/);
    const committed = [...CRLF_BASE];
    committed[1] = "ZWEI";
    assertEqual(
      showBytes(repo, `HEAD:${CRLF}`).toString("hex"),
      Buffer.from(`${committed.join("\r\n")}\r\n`).toString("hex"),
      "git: HEAD has ZWEI and every CRLF",
    );
    assertEqual(readBytes(repo, CRLF).toString("hex"), Buffer.from(`${crlf.join("\r\n")}\r\n`).toString("hex"), "file: bytes unchanged");
    await ui.closeToasts();

    // A lasso over two files; Escape in the diff clears both.
    await ui.openDiff("unstaged", SESSION);
    await app.click(await ui.gutter("add", 'export const neu = "Sitzung";'));
    await ui.openDiff("unstaged", CRLF);
    await app.click(await ui.gutter("add", "NEUN"));
    await waitCount(app, "2 lines in 2 files");

    // With a menu open, Escape only closes the menu.
    await rightClick(app, await ui.gutter("add", "NEUN"));
    await app.waitFor('[role="menu"]', 10_000);
    await app.press("Escape");
    await app.waitFor(() => app.exec(() => !document.querySelector('[role="menu"]')), 5000, { message: "menu closed" });
    await waitCount(app, "2 lines in 2 files");

    await app.press("Escape");
    await waitNoBar(app);
    assertEqual(await fileDetail(app, SESSION), null, "file list: session.ts cleared");
    assertEqual(await fileDetail(app, CRLF), null, "file list: crlf.txt cleared");
    assertEqual(await ui.selectedRows(), [], "no row selected");
    assertEqual(repo.git("rev-list", "--count", "HEAD"), "3", "git: nothing else committed");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("German texts", "edge", async (t) => {
  const repo = lassoRepo("lasso-deutsch");
  try {
    changeAll(repo);
    const { app, ui, repoId } = await open(t, repo, { lang: "de" });
    await ui.waitCounts(repoId, { unstaged: 2, staged: 1, conflicted: 0 });
    await openDiffDe(app, ui, SESSION);
    await drag(app, await ui.gutter("remove", "export const wert3 = 3;"), await ui.gutter("add", "export const wert3 = 300;"));
    await openDiffDe(app, ui, EXPORT);
    await app.click(await ui.gutter("add", 'export const umlaut = "äöü";'));
    await waitCount(app, "3 Zeilen in 2 Dateien");
    assertEqual(await fileDetail(app, SESSION), "2 ausgewählt", "file list detail");
    const label = (action) => lassoButton(app, action).then((button) => app.exec((node) => node.textContent.trim(), button));
    assertEqual(await label("lasso-commit"), "Nur das committen", "commit button");
    assertEqual(await label("lasso-branch"), "In neuen Branch …", "branch button");
    await t.shot("lasso-german");

    await app.click(await lassoButton(app, "lasso-branch"));
    await answerBranchDialog(app, "auslagerung/ä", "Ausgelagert");
    const toastText = await ui.waitToast("success", /In auslagerung\/ä ausgelagert/);
    assertIncludes(toastText, "Zum Branch wechseln", "toast offers the switch");
    assert(branchExists(repo, "auslagerung/ä"), "git: branch created");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
