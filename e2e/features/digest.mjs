/**
 * "What's new since …" in the real app over WebDriver: a colleague (a second clone of the bare remote)
 * pushes commits, force-pushes, deletes a branch and pushes a tag; the card from the palette shows it,
 * every row jumps (the commit, the base branch; a deleted ref stays reachable by keyboard) and
 * "Mark as seen" empties it. After a fetch the card opens by itself once the seen state is old; a fetch
 * while it is open makes "Mark as seen" reload it first. Own pushes and force pushes never count, a
 * young seen state opens no card, two windows close together, and the German texts.
 *
 *   node e2e/features/digest.mjs
 *   E2E_WD_ONLY=windows node e2e/features/digest.mjs
 *
 * The seen state ages by editing `repo_seen.seen_at` in the app's database (no debug switch in the app).
 * Every check of a jump target asks Git: `git rev-parse` in the app's clone.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../fixtures/fixtures.mjs";
import { syncUi } from "../fixtures/sync-ui.mjs";
import { assert, assertEqual, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const CARD = '[data-screen="digest-card"]';
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

/** What Mira does: two commits on `main` (the second touches `stationen.csv`), a force push, a delete, a tag. */
function miraWorks(fx) {
  const mira = colleague(fx);
  mira.commit("src/login.py", '"""Prüft die Anmeldung."""\n', "Login prüfen");
  mira.commit("stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafenkante;3\n", "Station Hafen umbenannt");
  mira.run("push", "-q", "origin", "main");
  // Back to an older commit: rewritten, but nothing new to list.
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

/** Opens the repository and takes the seen state now (as a first look at the card would). */
async function openAndSee(app, ui, fx) {
  const ids = await app.openRepo(fx.path);
  await app.waitFor(() => ui.toolButton("Fetch"), 20_000, { message: "repository toolbar" });
  const { mark } = await app.invoke("digest_get", { repoId: ids.repoId });
  await app.invoke("digest_mark_seen", { repoId: ids.repoId, mark });
  await app.settle();
  return ids;
}

/** Moves the seen state a day back in the app's database, so the check after a fetch may open the card. */
async function ageSeenState(app) {
  // node:sqlite warns once that it is experimental; that line is noise in the feature log.
  const emit = process.emitWarning;
  process.emitWarning = () => undefined;
  const { DatabaseSync } = await import("node:sqlite");
  process.emitWarning = emit;
  const db = new DatabaseSync(path.join(app.dataDir, "forkyard.db"));
  try {
    db.exec("pragma busy_timeout = 5000");
    const { changes } = db.prepare("update repo_seen set seen_at = ?").run(new Date(Date.now() - 24 * 3600_000).toISOString());
    assertEqual(changes, 1, "one seen state aged");
  } finally {
    db.close();
  }
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
    (card) => [...document.querySelectorAll(`${card} [data-digest-row]`)].map((row) => row.innerText.replace(/\s+/g, " ").trim()),
    CARD,
  );
const rowByText = (app, text) =>
  app.waitFor(
    () =>
      app.exec(
        (card, wanted) =>
          [...document.querySelectorAll(`${card} [data-digest-row]`)].find((row) => row.innerText.replace(/\s+/g, " ").trim() === wanted) ??
          null,
        CARD,
        text,
      ),
    10_000,
    { message: `row “${text}”` },
  );
const waitCard = (app) => app.waitFor(`${CARD} [data-digest-number="commits"]`, 20_000);
const waitNoCard = (app, message = "card closed") => app.waitFor(async () => !(await app.$(CARD)), 10_000, { message });
const waitCommits = (app, wanted) =>
  app.waitFor(async () => (await textOf(app, `${CARD} [data-digest-number="commits"]`)) === wanted, 10_000, {
    message: `card says “${wanted}”`,
  });
const graphSelected = (app, sha) =>
  app.waitFor(() => app.$(`[data-row-kind="commit"][data-row-id="${sha}"][aria-selected="true"]`), 10_000, {
    message: `graph selects ${sha.slice(0, 8)}`,
  });
const digestStale = (app, repoId) =>
  app.exec((id) => window.__gc.queryClient.getQueryState(["repo", id, "digest"])?.isInvalidated === true, repoId);

// =============================================================================================
// Scenarios
// =============================================================================================

scenario("palette shows what the colleague did; rows jump; Mark as seen empties it", "main", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    prepare(fx);
    const { app, ui } = await start(t);
    await openAndSee(app, ui, fx);
    miraWorks(fx);
    await fetchNow(ui);
    const login = git(fx, "rev-parse", "origin/main~1");
    const tip = git(fx, "rev-parse", "origin/main");
    assertEqual(git(fx, "log", "-1", "--format=%s", login), "Login prüfen", "origin/main~1 is Mira's first commit");

    await ui.runCommand("What's new since", "repo.digest");
    await waitCard(app);
    assertMatch(await textOf(app, `${CARD} h2`), /^What's new – last looked /, "title");
    assertEqual(await textOf(app, `${CARD} [data-digest-number="commits"]`), "2 new commits", "commits number");
    assertEqual(await textOf(app, `${CARD} [data-digest-number="files"]`), "1 of your files affected", "files number");
    assertEqual(
      await rowTexts(app),
      [
        "feature/export is 2 commits behind origin/main",
        "origin/feature/alt – force-pushed",
        "origin/feature/weg – deleted",
        "origin/main – updated",
        "Station Hafen umbenannt – Mira Weber",
        "Login prüfen – Mira Weber",
        "v1.0 – new tag",
        "stationen.csv – changed locally",
      ],
      "rows: behind, refs with their commits, your file",
    );
    assertEqual(
      await app.exec((card) => document.querySelector(card).querySelector("[aria-live]")?.getAttribute("aria-live"), CARD),
      "polite",
      "numbers announced politely",
    );
    assertMatch(
      (await textOf(app, "[data-digest-announce]")) ?? "",
      /^What's new – last looked /,
      "the live region mounted before the card announces it",
    );
    await t.shot("card");

    // The deleted ref has no target, but stays in the Tab order: aria-disabled, not disabled.
    const deleted = await rowByText(app, "origin/feature/weg – deleted");
    assertEqual(await deleted.attr("aria-disabled"), "true", "deleted row is aria-disabled");
    assertEqual(await deleted.prop("disabled"), false, "deleted row is not natively disabled");
    await app.exec((row) => row.focus(), await rowByText(app, "origin/feature/alt – force-pushed"));
    await app.press("Tab");
    assertEqual(
      await app.exec(() => document.activeElement?.getAttribute("data-digest-row")),
      "ref:remote:origin/feature/weg",
      "Tab reaches the deleted row",
    );

    await app.click(await rowByText(app, "feature/export is 2 commits behind origin/main"));
    await graphSelected(app, tip);
    t.step("the behind row selects origin/main");
    await app.click(await rowByText(app, "Login prüfen – Mira Weber"));
    await graphSelected(app, login);
    t.step("the commit row selects Login prüfen");

    await app.click(`${CARD} [data-digest-seen]`);
    await waitNoCard(app);
    await ui.runCommand("What's new since", "repo.digest");
    await ui.waitToast(/^Nothing new – last looked /, "info");
    assert(!(await app.$(CARD)), "no card when nothing is new");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario(
  "after a fetch the card opens; a fetch while it is open makes Mark as seen reload first; seen news stay away",
  "main",
  async (t) => {
    const fx = makeCleanRepoWithRemote({ name: "messnetz" });
    try {
      const { app, ui } = await start(t);
      const { repoId } = await openAndSee(app, ui, fx);
      const mira = colleague(fx);
      await ageSeenState(app);
      mira.commit("docs/a.md", "A\n", "Messreihe A");
      mira.run("push", "-q", "origin", "main");
      await fetchNow(ui);
      await waitCard(app);
      await waitCommits(app, "1 new commit");
      assert(
        await app.exec((card) => !document.querySelector(card).contains(document.activeElement), CARD),
        "the card does not take focus",
      );
      t.step("card opened by the fetch");

      mira.commit("docs/b.md", "B\n", "Messreihe B");
      mira.run("push", "-q", "origin", "main");
      await fetchNow(ui);
      await app.waitFor(() => digestStale(app, repoId), 10_000, { message: "the open card knows it is behind the fetch" });
      await waitCommits(app, "1 new commit");
      await app.click(`${CARD} [data-digest-seen]`);
      await app.waitFor(`${CARD} [data-digest-reloaded]`, 10_000);
      assertEqual(
        await textOf(app, `${CARD} [data-digest-reloaded]`),
        "New changes arrived – check them, then mark as seen",
        "reload hint",
      );
      await waitCommits(app, "2 new commits");
      await t.shot("reloaded");
      await app.click(`${CARD} [data-digest-seen]`);
      await waitNoCard(app, "the second click marks as seen");

      // Old enough again, and one more commit: only that one is news.
      await ageSeenState(app);
      mira.commit("docs/c.md", "C\n", "Messreihe C");
      mira.run("push", "-q", "origin", "main");
      await fetchNow(ui);
      await waitCard(app);
      await waitCommits(app, "1 new commit");
      const rows = await rowTexts(app);
      assert(rows.includes("Messreihe C – Mira Weber"), `C listed: ${JSON.stringify(rows)}`);
      assert(!rows.some((row) => /Messreihe [AB]/.test(row)), `A and B do not come back: ${JSON.stringify(rows)}`);
      await t.noConsoleErrors(app);
    } finally {
      fx.cleanup();
    }
  },
);

scenario("own push and own force push never appear", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    git(fx, "checkout", "-q", "-b", "feature/eigen");
    fx.write("eigen.md", "Eigene Auswertung.\n");
    git(fx, "add", "-A");
    git(fx, "commit", "-q", "-m", "Eigene Auswertung");
    const { app, ui } = await start(t);
    await openAndSee(app, ui, fx);

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

    await ui.runCommand("What's new since", "repo.digest");
    await ui.waitToast(/^Nothing new – last looked /, "info");
    assert(!(await app.$(CARD)), "no card for own pushes");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("a fetch with a fresh seen state opens no card", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const { app, ui } = await start(t);
    const { repoId } = await openAndSee(app, ui, fx);
    const sha = fx.commitOnRemote({ message: "Kalibrierung nachgetragen" });
    await fetchNow(ui);
    assertEqual(git(fx, "rev-parse", "origin/main"), sha, "the fetch brought the colleague's tip");
    // The check after the fetch answers before any Git work while the seen state is young.
    assertEqual(await app.invoke("digest_get", { repoId, minAgeHours: 8 }), null, "the young seen state answers nothing");
    await app.settle();
    assert(!(await app.$(CARD)), "no card");
    // The news are there, the palette shows them.
    await ui.runCommand("What's new since", "repo.digest");
    await waitCard(app);
    await waitCommits(app, "1 new commit");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

/** Switches into the window with this label and waits for its shell. */
async function enter(app, wanted) {
  await app.waitFor(
    async () => {
      for (const handle of await app.windowHandles()) {
        await app.switchToWindow(handle);
        const here = await app.exec(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label).catch(() => null);
        if (here === wanted) return handle;
      }
      return null;
    },
    15_000,
    { message: `window ${wanted}` },
  );
  await app.waitForShell(30_000);
  await app.settle();
}

scenario("two windows: closing the card in one closes it in the other", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const { app, ui } = await start(t);
    await openAndSee(app, ui, fx);
    fx.commitOnRemote({ message: "Kalibrierung nachgetragen" });
    await fetchNow(ui);
    const second = await app.invoke("window_new");
    await enter(app, second);
    await app.openRepo(fx.path);
    await ui.install();
    await ui.runCommand("What's new since", "repo.digest");
    await waitCard(app);

    await enter(app, "main");
    await ui.runCommand("What's new since", "repo.digest");
    await waitCard(app);
    await app.click(`${CARD} [data-digest-close]`);
    await waitNoCard(app, "closed in the main window");

    await enter(app, second);
    await waitNoCard(app, "closed in the second window too");
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
    await openAndSee(app, ui, fx);
    miraWorks(fx);
    await ui.clickTool("Fetch");
    await app.waitFor(() => git(fx, "rev-parse", "origin/main") === git(fx, "rev-parse", "refs/tags/v1.0"), 60_000, {
      message: "fetched",
    });
    await app.settle();
    await ui.runCommand("Was ist neu seit", "repo.digest");
    await waitCard(app);
    assertMatch(await textOf(app, `${CARD} h2`), /^Neu – zuletzt angesehen /, "German title");
    assertEqual(await textOf(app, `${CARD} [data-digest-number="commits"]`), "2 neue Commits", "German commits number");
    const rows = await rowTexts(app);
    assert(rows.includes("origin/feature/alt – force-gepusht"), `force-gepusht: ${JSON.stringify(rows)}`);
    assertEqual(await textOf(app, `${CARD} [data-digest-seen]`), "Als gesehen markieren", "German button");
    await t.shot("deutsch");
    await app.click(`${CARD} [data-digest-seen]`);
    await waitNoCard(app);
    await ui.runCommand("Was ist neu seit", "repo.digest");
    await ui.waitToast(/^Nichts Neues – zuletzt angesehen /, "info");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});
