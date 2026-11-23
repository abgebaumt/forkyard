/**
 * "What's new" in the real app over WebDriver: a colleague (a second clone of the bare remote) pushes
 * commits, force-pushes, deletes a branch and pushes a tag; after the fetch the dialog opens by itself
 * with the last 24 hours, every row jumps (and closes it) and the palette opens it again. A fetch that
 * changes nothing opens nothing, neither does news older than 24 hours (the palette then shows the
 * empty state), and own pushes do not open it but their commits are listed. The German texts.
 *
 *   node e2e/features/digest.mjs
 *   E2E_WD_ONLY=German node e2e/features/digest.mjs
 *
 * The "last shown" state is `repo_seen` in the app's database; the scenarios only read it, to wait for
 * the snapshot the first open creates. Every check of a jump target asks Git: `git rev-parse` in the app's clone.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../fixtures/fixtures.mjs";
import { syncUi } from "../fixtures/sync-ui.mjs";
import { assert, assertEqual, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const DIGEST = '[data-screen="digest"]';
const TITLE = /^What's new/;
const MIRA = { name: "Mira Weber", email: "mira.weber@wetterstation.example" };

// ---------------------------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------------------------

const envFor = (fx) => ({ ...process.env, ...gitIsolationEnv(path.join(fx.root, "gitconfig")) });
const gitIn = (fx, cwd, args, env = {}) =>
  execFileSync("git", args, { cwd, env: { ...envFor(fx), ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (fx, ...args) => gitIn(fx, fx.path, args);

/** Mira's own clone of the bare remote: she commits and pushes, the app only sees it after a fetch. */
function colleague(fx) {
  const dir = path.join(fx.root, "mira");
  gitIn(fx, fx.root, ["clone", "-q", fx.remotePath, dir]);
  const env = {
    GIT_AUTHOR_NAME: MIRA.name,
    GIT_AUTHOR_EMAIL: MIRA.email,
    GIT_COMMITTER_NAME: MIRA.name,
    GIT_COMMITTER_EMAIL: MIRA.email,
  };
  const run = (...args) => gitIn(fx, dir, args, env);
  return {
    run,
    commit(file, content, message) {
      execFileSync("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"', "sh", file, content], { cwd: dir });
      run("add", "-A");
      run("commit", "-q", "-m", message);
      return run("rev-parse", "HEAD");
    },
  };
}

/**
 * Before the app starts: `feature/alt` and `feature/weg` on the remote (at `main`), the app's clone on
 * `feature/export` (so it can be behind `origin/main`) with `stationen.csv` changed locally.
 */
function prepare(fx) {
  git(fx, "push", "-q", "origin", "main:refs/heads/feature/alt", "main:refs/heads/feature/weg");
  git(fx, "checkout", "-q", "feature/export");
  fx.write("stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen;3\nW;Werft;5\n");
}

/** What Mira does: two commits on `main` (the second touches `stationen.csv`), a force push to an old commit, a delete, a tag. */
function miraWorks(fx) {
  const mira = colleague(fx);
  mira.commit("src/login.py", '"""Prüft die Anmeldung."""\n', "Login prüfen");
  mira.commit("stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafenkante;3\n", "Station Hafen umbenannt");
  mira.run("push", "-q", "origin", "main");
  // Back to an older commit: moved, but nothing in the last 24 hours to list.
  mira.run("push", "-q", "-f", "origin", "HEAD~3:refs/heads/feature/alt");
  mira.run("push", "-q", "origin", ":refs/heads/feature/weg");
  mira.run("tag", "v1.0");
  mira.run("push", "-q", "origin", "v1.0");
  return mira;
}

// ---------------------------------------------------------------------------------------------
// App helpers
// ---------------------------------------------------------------------------------------------

/** Starts the app with auto-fetch off and the toast recorder installed. */
async function start(t, options = {}) {
  const app = await t.launch({ ...LAUNCH, ...options });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const ui = syncUi(app);
  await ui.install();
  return { app, ui };
}

/** The rows of `repo_seen` in the app's database. */
async function snapshotCount(app) {
  // node:sqlite warns once that it is experimental; that line is noise in the feature log.
  const emit = process.emitWarning;
  process.emitWarning = () => undefined;
  const { DatabaseSync } = await import("node:sqlite");
  process.emitWarning = emit;
  const db = new DatabaseSync(path.join(app.dataDir, "forkyard.db"), { readOnly: true });
  try {
    db.exec("pragma busy_timeout = 5000");
    return db.prepare("select count(*) as n from repo_seen").get().n;
  } finally {
    db.close();
  }
}

/** Waits until the stored snapshot has `sha` for `ref`. */
async function waitSnapshotRef(app, ref, sha) {
  const emit = process.emitWarning;
  process.emitWarning = () => undefined;
  const { DatabaseSync } = await import("node:sqlite");
  process.emitWarning = emit;
  await app.waitFor(
    () => {
      const db = new DatabaseSync(path.join(app.dataDir, "forkyard.db"), { readOnly: true });
      try {
        db.exec("pragma busy_timeout = 5000");
        return JSON.parse(db.prepare("select refs from repo_seen").get().refs)[ref] === sha;
      } finally {
        db.close();
      }
    },
    15_000,
    { message: `the check stored ${ref} at ${sha.slice(0, 8)}` },
  );
}

/** Opens the repository and waits for the snapshot the first open creates: what a fetch is compared with. */
async function openAndWait(app, ui, fx) {
  const ids = await app.openRepo(fx.path);
  await app.waitFor(() => ui.toolButton("Fetch"), 20_000, { message: "repository toolbar" });
  await app.waitFor(async () => (await snapshotCount(app)) === 1, 20_000, { message: "the first open stored the refs" });
  return ids;
}

async function fetchNow(ui) {
  await ui.forgetToasts();
  await ui.clickTool("Fetch");
  await ui.waitToast(/Fetch complete/, "success", 60_000);
}

const textOf = (app, selector) =>
  app.exec((wanted) => document.querySelector(wanted)?.innerText.replace(/\s+/g, " ").trim() ?? null, selector);
const rowTexts = (app) =>
  app.exec(
    (root) => [...document.querySelectorAll(`${root} [data-digest-row]`)].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
    DIGEST,
  );
const rowByText = (app, text) =>
  app.waitFor(
    () =>
      app.exec(
        (root, wanted) =>
          [...document.querySelectorAll(`${root} [data-digest-row]`)].find((row) => row.innerText.replace(/\s+/g, " ").trim() === wanted) ??
          null,
        DIGEST,
        text,
      ),
    10_000,
    { message: `row “${text}”` },
  );
const waitCommits = (app, wanted) =>
  app.waitFor(async () => (await textOf(app, `${DIGEST} [data-digest-number="commits"]`)) === wanted, 10_000, {
    message: `dialog says “${wanted}”`,
  });
const closeDialog = async (app, ui) => {
  await app.click("[data-digest-close]");
  await ui.waitNoDialog();
};
const graphSelected = (app, sha) =>
  app.waitFor(() => app.$(`[data-row-kind="commit"][data-row-id="${sha}"][aria-selected="true"]`), 10_000, {
    message: `graph selects ${sha.slice(0, 8)}`,
  });

// =============================================================================================
// Scenarios
// =============================================================================================

scenario("a fetch with news opens the dialog; rows jump; the palette opens it again", "main", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    prepare(fx);
    const { app, ui } = await start(t);
    await openAndWait(app, ui, fx);
    miraWorks(fx);
    await fetchNow(ui);
    const login = git(fx, "rev-parse", "origin/main~1");
    const tip = git(fx, "rev-parse", "origin/main");
    assertEqual(git(fx, "log", "-1", "--format=%s", login), "Login prüfen", "origin/main~1 is Mira's first commit");

    await ui.waitDialog(TITLE, 30_000);
    assertEqual((await ui.waitDialog(TITLE)).title, "What's new in messnetz – last 24 hours", "title");
    assertEqual(await textOf(app, `${DIGEST} [data-digest-number="commits"]`), "2 new commits", "commits number");
    assertEqual(await textOf(app, `${DIGEST} [data-digest-number="files"]`), "1 of your files affected", "files number");
    assertEqual(
      await rowTexts(app),
      [
        "feature/export is 2 commits behind origin/main",
        "origin/main – updated",
        "Station Hafen umbenannt – Mira Weber",
        "Login prüfen – Mira Weber",
        "v1.0 – new tag",
        "stationen.csv – changed locally",
      ],
      "rows: behind, the base branch with its commits, the tag, your file (the old force push and the delete are no news)",
    );
    assertEqual(
      await app.exec((root) => document.querySelector(root).querySelector("[aria-live]")?.getAttribute("aria-live"), DIGEST),
      "polite",
      "numbers announced politely",
    );
    await t.shot("dialog");

    await app.click(await rowByText(app, "feature/export is 2 commits behind origin/main"));
    await ui.waitNoDialog();
    await graphSelected(app, tip);
    t.step("the behind row closes the dialog and selects origin/main");

    // The same 24 hours from the palette.
    await ui.runCommand("What's new", "repo.digest");
    await ui.waitDialog(TITLE);
    await waitCommits(app, "2 new commits");
    await app.click(await rowByText(app, "Login prüfen – Mira Weber"));
    await ui.waitNoDialog();
    await graphSelected(app, login);
    t.step("the commit row selects Login prüfen");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("a fetch that changes nothing opens nothing; new news open it again with the whole window", "main", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const { app, ui } = await start(t);
    await openAndWait(app, ui, fx);
    const mira = colleague(fx);
    mira.commit("docs/a.md", "A\n", "Messreihe A");
    mira.run("push", "-q", "origin", "main");
    await fetchNow(ui);
    await ui.waitDialog(TITLE, 30_000);
    await waitCommits(app, "1 new commit");
    await closeDialog(app, ui);

    await fetchNow(ui);
    // Nothing changed: the fetch reports nothing, so no check is made at all.
    assertEqual(await ui.dialog(), null, "the same refs open nothing");
    t.step("an unchanged fetch opens nothing");

    mira.commit("docs/b.md", "B\n", "Messreihe B");
    mira.run("push", "-q", "origin", "main");
    await fetchNow(ui);
    await ui.waitDialog(TITLE, 30_000);
    await waitCommits(app, "2 new commits");
    const rows = await rowTexts(app);
    assert(rows.includes("Messreihe A – Mira Weber") && rows.includes("Messreihe B – Mira Weber"), `both listed: ${JSON.stringify(rows)}`);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("news older than 24 hours open nothing; the palette shows the empty state", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const { app, ui } = await start(t);
    await openAndWait(app, ui, fx);
    // The fixture dates its commits long ago: the fetch changes the refs, the window holds nothing.
    const sha = fx.commitOnRemote({ message: "Kalibrierung nachgetragen" });
    await fetchNow(ui);
    assertEqual(git(fx, "rev-parse", "origin/main"), sha, "the fetch brought the colleague's tip");
    // The check stores the refs it looked at even when it opens nothing: that is its end.
    await waitSnapshotRef(app, "refs/remotes/origin/main", sha);
    assertEqual(await ui.dialog(), null, "no dialog");
    await ui.runCommand("What's new", "repo.digest");
    await ui.waitDialog(TITLE);
    assertEqual(await textOf(app, `${DIGEST} [data-digest-empty]`), "Nothing new in the last 24 hours.", "empty state");
    assertEqual(await rowTexts(app), [], "no rows");
    await closeDialog(app, ui);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("own pushes open nothing, but the own commits are listed", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    git(fx, "checkout", "-q", "-b", "feature/eigen");
    fx.write("eigen.md", "Eigene Auswertung.\n");
    git(fx, "add", "-A");
    git(fx, "commit", "-q", "-m", "Eigene Auswertung");
    const { app, ui } = await start(t);
    await openAndWait(app, ui, fx);

    await ui.clickTool("Push");
    await ui.waitDialog(/^Where to push\?$/, 30_000);
    await app.press("Enter");
    await ui.waitToast(/Pushed to origin\/feature\/eigen/, "success", 60_000);
    git(fx, "commit", "-q", "--amend", "-m", "Eigene Auswertung, korrigiert");
    await ui.refresh();
    await ui.clickTool("Push");
    await ui.waitDialog(/^Push rejected$/, 60_000);
    await app.click({ text: "Force push …", within: '[role="dialog"]' });
    await ui.waitDialog(/^Force push to origin\/feature\/eigen\?$/, 60_000);
    await ui.clickDialogButton("Force push");
    await ui.waitToast(/Force-pushed to origin\/feature\/eigen/, "success", 60_000);
    assertEqual(gitIn(fx, fx.remotePath, ["rev-parse", "feature/eigen"]), git(fx, "rev-parse", "HEAD"), "the amend is on the remote");

    await fetchNow(ui);
    // The pushes are what the app already knows: the fetch reports nothing, so no check is made.
    assertEqual(await ui.dialog(), null, "nothing opens");
    await ui.runCommand("What's new", "repo.digest");
    await ui.waitDialog(TITLE);
    const rows = await rowTexts(app);
    assert(rows.includes("origin/feature/eigen – updated"), `the branch is listed: ${JSON.stringify(rows)}`);
    assert(
      rows.some((row) => row.startsWith("Eigene Auswertung, korrigiert – ")),
      `the own commit is listed: ${JSON.stringify(rows)}`,
    );
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("German texts", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    prepare(fx);
    const { app, ui } = await start(t, { lang: "de" });
    await openAndWait(app, ui, fx);
    miraWorks(fx);
    await ui.clickTool("Fetch");
    await ui.waitDialog(/^Neu in messnetz – letzte 24 Stunden$/, 60_000);
    assertEqual(await textOf(app, `${DIGEST} [data-digest-number="commits"]`), "2 neue Commits", "German commits number");
    const rows = await rowTexts(app);
    assert(rows.includes("origin/main – aktualisiert"), `aktualisiert: ${JSON.stringify(rows)}`);
    assert(rows.includes("v1.0 – neuer Tag"), `neuer Tag: ${JSON.stringify(rows)}`);
    assertEqual(await textOf(app, "[data-digest-close]"), "Schließen", "German button");
    await t.shot("deutsch");
    await closeDialog(app, ui);
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("own unpushed commits: the palette lists them under the local branch and a row jumps", "main", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    git(fx, "checkout", "-q", "feature/export");
    fx.write("lokal.txt", "1\n");
    git(fx, "add", "-A");
    git(fx, "commit", "-q", "-m", "Noch nicht gepusht");
    const local = git(fx, "rev-parse", "HEAD");
    const { app, ui } = await start(t);
    await openAndWait(app, ui, fx);
    await ui.runCommand("What's new", "repo.digest");
    await ui.waitDialog(TITLE);
    await t.shot("local-dialog");
    const row = await app.waitFor(
      () =>
        app.exec(
          (root) =>
            [...document.querySelectorAll(`${root} [data-digest-row^="commit:"]`)].find((r) =>
              r.innerText.startsWith("Noch nicht gepusht"),
            ) ?? null,
          DIGEST,
        ),
      10_000,
      { message: "the local commit row" },
    );
    await app.click(row);
    await ui.waitNoDialog();
    await graphSelected(app, local);
    t.step("the local commit row closes the dialog and selects the commit");

    // The AI preview opens on top of the dialog, not queued behind it; closing it leaves the dialog open.
    await app.invoke("settings_set", { patch: { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
    await ui.runCommand("What's new", "repo.digest");
    await ui.waitDialog(TITLE);
    await app.click(await app.waitFor(() => app.$("[data-digest-what-is-sent]"), 10_000, { message: "What is sent?" }));
    await app.waitFor(() => app.$("[data-ai-preview]"), 10_000, { message: "the preview opens over the dialog" });
    assert(await app.$(DIGEST), "the digest stays open below");
    await app.click(
      await app.waitFor(() => app.$('[role="dialog"]:has([data-ai-preview]) button[data-autofocus]'), 5_000, { message: "Close" }),
    );
    await app.waitFor(async () => !(await app.$("[data-ai-preview]")), 5_000, { message: "the preview closes" });
    assert(await app.$(DIGEST), "the digest is still open");
    t.step("What is sent? opens on top of the digest (the send gate uses the same dialog)");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});
