/**
 * Sync in the real app over WebDriver, against real Git: fetch, pull (modes, dirty worktree), push
 * (counter, new branch, rejected → force with lease), remotes (add, edit, remove, undo), HTTPS
 * credentials (prompt, cancel, wrong password, remember, forget), SSH keys and SSH remotes (real
 * sshd on 127.0.0.1, host key prompt), proxy (CONNECT proxy in this process) and – v1.1 – pushing
 * several branches and tags in one (atomic) push.
 *
 * Remotes are local bare repositories, scripts/e2e/git-http-server.mjs (HTTPS with a self-signed
 * certificate) and scripts/e2e/git-ssh-server.mjs. Nothing touches a real service.
 *
 *   node scripts/e2e-wd/features/sync.mjs
 *   node scripts/e2e-wd/run.mjs sync --only "atomic"
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { makeCleanRepoWithRemote, makeEmptyRepo } from "../../e2e/fixtures.mjs";
import { startGitHttpServer } from "../../e2e/git-http-server.mjs";
import { findSshd, startGitSshServer } from "../../e2e/git-ssh-server.mjs";
import { startPrivateKeyring } from "../fixtures/sync-keyring.mjs";
import { NO_PROXY_ENV, appendAppGitConfig, closedPort, git, revParse, slash, sleep, syncUi } from "../fixtures/sync-ui.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

/** Starts the app (English, light, 1440x900), switches auto-fetch off, installs the recorders. */
async function start(t, options = {}) {
  const app = await t.launch({ lang: "en", theme: "light", width: 1440, height: 900, ...options, env: { SSH_AUTH_SOCK: "", ...NO_PROXY_ENV, ...(options.env ?? {}) } });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const ui = syncUi(app);
  await ui.install();
  return { app, ui };
}

/** Opens the repository and waits until the toolbar reflects it. */
async function open(app, ui, repoPath) {
  const ids = await app.openRepo(repoPath);
  await app.waitFor(() => ui.toolButton("Fetch"), 20_000, { message: "repository toolbar" });
  await app.settle();
  return ids;
}

/** Local commit in the fixture (outside the app); returns the SHA. */
function localCommit(repo, file, message) {
  repo.write(file, `${message}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

// ---------------------------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------------------------

scenario("Fetch holt neue Commits vom Remote und zeigt sie zum Pullen an", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const remoteSha = repo.commitOnRemote({ message: "Kalibrierung nachgetragen" });
    assertEqual(revParse(repo.path, "origin/main"), repo.info.head, "before the fetch origin/main is still the old state");
    // Keyboard shortcut of the Fetch button (Mod+Shift+L).
    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Control+Shift+l");
    const toast = await ui.waitToast(/Fetch complete/, "success", 60_000);
    assertMatch(toast.text, /1 ref updated/, "the toast says what arrived");
    t.step("fetch via Ctrl+Shift+L done");
    assertEqual(revParse(repo.path, "origin/main"), remoteSha, "origin/main is the remote's commit (git rev-parse)");
    assertEqual(repo.git("rev-parse", "HEAD"), repo.info.head, "fetch leaves HEAD alone");
    await app.waitFor(async () => (await ui.toolState("Pull"))?.label === "Pull, 1 commit to pull", 15_000, { message: "Pull shows ↓1" });
    await app.waitFor(() => app.byText("Kalibrierung nachgetragen"), 15_000, { message: "the fetched commit appears in the graph" });
    await t.shot("fetch-new-commits");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Fetch mit unerreichbarem zweitem Remote nennt es, der Rest kommt an", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "funkloch" });
  try {
    const port = await closedPort();
    repo.git("remote", "add", "spiegel", `http://127.0.0.1:${port}/spiegel.git`);
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const remoteSha = repo.commitOnRemote({ message: "Neuer Stand im Hauptremote" });
    await ui.clickTool("Fetch");
    const toast = await ui.waitToast(/Fetch from “spiegel” failed/, "warning", 60_000);
    assertMatch(toast.text, /The other remote was fetched/, "the toast says the other remote was fetched");
    assertEqual(revParse(repo.path, "origin/main"), remoteSha, "origin was fetched anyway (git rev-parse)");
    await t.shot("fetch-unreachable-remote");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Ohne Remote sind Fetch, Pull und Push gesperrt und erklären warum", "edge", async (t) => {
  const repo = makeEmptyRepo({ name: "ohne-remote", withFile: true });
  try {
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Erster Stand");
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const fetch = await ui.toolState("Fetch");
    assert(fetch.disabled, "Fetch is disabled without a remote");
    assertMatch(fetch.hint, /remote/i, "the hint names the missing remote");
    assert((await ui.toolState("Push")).disabled, "Push is disabled");
    // The pull menu offers the way out: "Add remote".
    await app.click({ text: "Pull: options" });
    const entry = await app.waitFor(() => app.byText("Add remote …", { within: '[role="menu"]' }), 10_000, { message: "menu entry Add remote" });
    await entry.click();
    await ui.waitDialog(/^Add remote$/);
    await app.press("Escape");
    await ui.waitNoDialog();
    assertEqual(git(repo.path, "remote"), "", "nothing was added");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------------

scenario("Pull holt den Remote-Stand per Fast-Forward", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const remoteSha = repo.commitOnRemote({ message: "Messreihe Hafen ergänzt", file: "daten/hafen.csv", content: "tag;wert\n1;3.4\n" });
    await ui.clickTool("Pull");
    await ui.waitToast(/Pull complete/, "success", 60_000);
    assertEqual(repo.git("rev-parse", "HEAD"), remoteSha, "HEAD is the remote's commit (git)");
    assertEqual(repo.git("rev-list", "--count", "--merges", "HEAD"), "0", "no merge commit");
    assert(fs.existsSync(path.join(repo.path, "daten/hafen.csv")), "the new file is in the working directory");
    await app.waitFor(async () => (await ui.toolState("Pull"))?.label === null, 15_000, { message: "Pull counter gone" });
    await t.shot("pull-fast-forward");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Pull mit Rebase über das Menü legt eigene Commits obenauf", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const remoteSha = repo.commitOnRemote({ message: "Remote: Kalibrierung" });
    localCommit(repo, "notiz.md", "Lokale Notiz zur Station");
    await ui.refresh();
    await app.click({ text: "Pull: options" });
    const entry = await app.waitFor(() => app.byText("Pull (rebase)", { within: '[role="menu"]' }), 10_000, { message: "menu entry Pull (rebase)" });
    await t.shot("pull-menu");
    await entry.click();
    await ui.waitToast(/Pull complete/, "success", 60_000);
    assertEqual(repo.git("rev-parse", "HEAD~1"), remoteSha, "the local commit sits on top of the remote's commit (git)");
    assertEqual(repo.git("log", "-1", "--format=%s"), "Lokale Notiz zur Station", "HEAD is the rebased local commit");
    assertEqual(repo.git("rev-list", "--count", "--merges", "HEAD"), "0", "no merge commit");
    await app.waitFor(async () => (await ui.toolState("Push"))?.label === "Push, 1 commit to push", 15_000, { message: "Push shows ↑1" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Pull nur Fast-Forward bricht bei eigenen Commits ab und ändert nichts", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    repo.commitOnRemote({ message: "Remote: neuer Stand" });
    const local = localCommit(repo, "notiz.md", "Lokaler Commit");
    await ui.refresh();
    await app.click({ text: "Pull: options" });
    const entry = await app.waitFor(() => app.byText("Pull (fast-forward only)", { within: '[role="menu"]' }), 10_000, { message: "menu entry ff-only" });
    await entry.click();
    const toast = await app.waitFor(async () => (await ui.seenToasts()).find((item) => item.tone === "danger" || item.tone === "warning") ?? null, 60_000, { message: "a refusal toast" });
    t.step(`toast: ${toast.text}`);
    assertEqual(repo.git("rev-parse", "HEAD"), local, "HEAD is unchanged (git)");
    assertEqual(repo.git("status", "--porcelain"), "", "the working directory is clean");
    await t.shot("pull-ff-only-refused");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Pull mit Änderungen im Weg: erst stashen, dann pullen, Änderungen zurück", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    // Remote changes the last line, the local edit the first one: the pull is blocked, the stash comes back cleanly.
    const remoteSha = repo.commitOnRemote({ message: "Hafen höher eingemessen", file: "stationen.csv", content: "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen;4\n" });
    repo.write("stationen.csv", "kürzel;name;höhe_m;bemerkung\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen;3\n");
    await ui.refresh();
    await ui.clickTool("Pull");
    const ask = await ui.waitDialog(/^Uncommitted changes are in the way of the pull$/, 60_000);
    assertIncludes(ask.text, "stationen.csv", "the dialog names the blocking file");
    await t.shot("pull-dirty-offer-stash");
    await app.click({ text: "Stash first, then pull", within: '[role="dialog"]' });
    // After the pull the stash comes back – here it conflicts with the pulled README.
    await app.waitFor(async () => repo.git("rev-parse", "HEAD") === remoteSha, 60_000, { message: "HEAD reaches the remote's commit" });
    await app.settle();
    await app.waitFor(() => repo.git("stash", "list") === "", 30_000, { message: "the stash was popped again" });
    const csv = fs.readFileSync(path.join(repo.path, "stationen.csv"), "utf8");
    assertEqual(csv, "kürzel;name;höhe_m;bemerkung\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen;4\n", "local edit and pulled change are both in the file");
    assertEqual(repo.git("status", "--porcelain").trim(), "M stationen.csv", "only the local change is left uncommitted (unstaged)");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------------------------

scenario("Push eines lokalen Commits mit Zähler in der Werkzeugleiste", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const local = localCommit(repo, "auswertung.md", "Auswertung Januar");
    await ui.refresh();
    await app.waitFor(async () => (await ui.toolState("Push"))?.label === "Push, 1 commit to push", 15_000, { message: "Push shows ↑1" });
    assertMatch((await ui.toolState("Push")).hint, /origin\/main/, "the hint names the upstream");
    await t.shot("push-counter");
    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Control+Shift+p");
    await ui.waitToast(/Pushed to origin\/main/, "success", 60_000);
    assertEqual(git(repo.remotePath, "rev-parse", "main"), local, "the commit is on the remote (git in the bare repo)");
    await app.waitFor(async () => (await ui.toolState("Push"))?.disabled === true, 15_000, { message: "Push has nothing left" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Push eines neuen Branches fragt nach dem Ziel und setzt den Upstream", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    repo.git("checkout", "-q", "-b", "analyse/hafen");
    const local = localCommit(repo, "hafen.md", "Analyse Hafen begonnen");
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    await ui.clickTool("Push");
    await ui.waitDialog(/^Where to push\?$/, 30_000);
    const name = await ui.waitField("Branch name on the remote");
    assertEqual(await name.prop("value"), "analyse/hafen", "the remote name defaults to the branch name");
    // An invalid name blocks the push.
    await ui.retype(name, "analyse..hafen");
    await app.waitFor(async () => (await ui.dialog()).text.includes("aren"), 5000, { message: "field error for '..'" }).catch(() => undefined);
    const blocked = await ui.dialogButton("Push");
    assert(await blocked.prop("disabled"), "Push is disabled for an invalid name");
    await ui.retype(name, "analyse/hafen-remote");
    await t.shot("push-where-to");
    await app.press("Enter");
    await ui.waitToast(/Pushed to origin\/analyse\/hafen-remote/, "success", 60_000);
    assertEqual(git(repo.remotePath, "rev-parse", "analyse/hafen-remote"), local, "the branch exists on the remote (git)");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "analyse/hafen@{upstream}"), "origin/analyse/hafen-remote", "the upstream is set (git)");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Abgelehnter Push: Force mit Lease nach Bestätigung, verlorene Commits genannt", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    repo.commitOnRemote({ message: "Fremder Commit auf dem Remote" });
    const local = localCommit(repo, "lokal.md", "Eigener Commit");
    await ui.refresh();
    await ui.clickTool("Push");
    const rejected = await ui.waitDialog(/^Push rejected$/, 60_000);
    assertIncludes(rejected.text, "Pull first", "offers Pull first");
    assertIncludes(rejected.text, "Force push", "offers Force push");
    await t.shot("push-rejected");
    await app.click({ text: "Force push …", within: '[role="dialog"]' });
    const confirm = await ui.waitDialog(/^Force push to origin\/main\?$/, 60_000);
    assertIncludes(confirm.text, "Fremder Commit auf dem Remote", "the confirmation lists the commit that will be lost");
    assertIncludes(confirm.text, "--force-with-lease", "and says it uses --force-with-lease");
    await t.shot("push-force-confirm");
    // Cancel first: nothing happens.
    await app.press("Escape");
    await ui.waitNoDialog();
    assert(git(repo.remotePath, "rev-parse", "main") !== local, "after cancelling the remote is unchanged");
    // Second attempt, now confirmed.
    await ui.clickTool("Push");
    await ui.waitDialog(/^Push rejected$/, 60_000);
    await app.click({ text: "Force push …", within: '[role="dialog"]' });
    await ui.waitDialog(/^Force push to origin\/main\?$/, 60_000);
    await ui.clickDialogButton("Force push");
    await ui.waitToast(/Force-pushed to origin\/main/, "success", 60_000);
    assertEqual(git(repo.remotePath, "rev-parse", "main"), local, "the remote now has the local commit (git)");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Abgelehnter Push: erst pullen, dann automatisch erneut pushen", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const remoteSha = repo.commitOnRemote({ message: "Fremder Commit", file: "fremd.md" });
    localCommit(repo, "lokal.md", "Eigener Commit");
    await ui.refresh();
    await ui.clickTool("Push");
    await ui.waitDialog(/^Push rejected$/, 60_000);
    await app.click({ text: "Pull first", within: '[role="dialog"]' });
    await ui.waitToast(/Pushed to origin\/main/, "success", 90_000);
    const remoteMain = git(repo.remotePath, "rev-parse", "main");
    assertEqual(remoteMain, repo.git("rev-parse", "HEAD"), "the remote has the local HEAD (git)");
    assertEqual(git(repo.remotePath, "merge-base", "--is-ancestor", remoteSha, "main") === "", true, "the foreign commit is kept");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------------------------

/** Lines of `git remote -v`, spaces normalised. */
const remoteLines = (repoPath) => git(repoPath, "remote", "-v").split("\n").filter(Boolean).map((line) => line.replace(/\s+/g, " "));

scenario("Remote hinzufügen (nur Tastatur) und sofort fetchen", "main", async (t) => {
  const fresh = makeEmptyRepo({ name: "station-sued", withFile: true });
  const shared = makeCleanRepoWithRemote();
  try {
    fresh.git("add", "-A");
    fresh.git("commit", "-q", "-m", "Erster Stand der Station Süd");
    const { app, ui } = await start(t);
    await open(app, ui, fresh.path);
    await ui.runCommand("Add remote", "remote.add");
    const dialog = await ui.waitDialog(/^Add remote$/);
    assertIncludes(dialog.text, "Fetch right away", "the dialog offers to fetch right away");
    const name = await ui.waitField("Name");
    assertEqual(await name.prop("value"), "origin", "the first remote is suggested as origin");
    assertEqual((await ui.focused()).label, "Name", "focus starts in the Name field");
    // Empty URL: field error, nothing is added.
    await app.press("Enter");
    await app.waitFor(async () => (await ui.dialog()).text.includes("The URL is missing."), 10_000, { message: "field error for the missing URL" });
    await app.press("Tab");
    assertEqual((await ui.focused()).label, "Fetch URL", "Tab reaches the URL field");
    await (await ui.waitField("Fetch URL")).type(shared.remotePath);
    await app.waitFor(async () => (await ui.dialog()).text.includes("Local path"), 10_000, { message: "a folder is recognised as a local path" });
    await t.shot("remote-add");
    await app.press("Enter");
    await ui.waitToast(/Remote “origin” added/, "success");
    await ui.waitToast(/Fetch( from origin)? complete/, "success", 60_000);
    assertEqual(remoteLines(fresh.path), [`origin ${shared.remotePath} (fetch)`, `origin ${shared.remotePath} (push)`], "git remote -v shows the new remote");
    assertEqual(git(fresh.path, "branch", "-r", "--format=%(refname)").split("\n").filter((ref) => ref && !ref.endsWith("/HEAD")).sort(), ["refs/remotes/origin/feature/export", "refs/remotes/origin/main"], "the fetch got the remote branches");
    await app.waitFor(() => app.byText("Vergleich der Tagesmittel zweier Stationen"), 15_000, { message: "remote commits appear in the graph" });
    await t.noConsoleErrors(app);
  } finally {
    fresh.cleanup();
    shared.cleanup();
  }
});

scenario("Remote-Dialog: Name vergeben, ungültiger Name, Protokoll abgelehnt", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    await ui.runCommand("Add remote", "remote.add");
    await ui.waitDialog(/^Add remote$/);
    const name = await ui.waitField("Name");
    assertEqual(await name.prop("value"), "", "origin is taken: no suggestion");
    await (await ui.waitField("Fetch URL")).type("svn://server.example/projekt");
    await ui.retype(name, "origin");
    await app.press("Enter");
    await app.waitFor(async () => (await ui.dialog()).text.includes("A remote named “origin” already exists."), 10_000, { message: "taken name: field error" });
    await ui.retype(name, "zwei..punkte");
    await app.press("Enter");
    await app.waitFor(async () => /aren't allowed/.test((await ui.dialog()).text), 10_000, { message: "invalid name: field error" });
    await ui.retype(name, "spiegel");
    await app.press("Enter");
    await app.waitFor(async () => /svn/.test((await ui.dialog()).text) && /not supported|doesn't accept/.test((await ui.dialog()).text), 10_000, { message: "svn URL rejected at the field" });
    await t.shot("remote-add-errors");
    assertEqual((await ui.seenToasts()).length, 0, "field errors come without a toast");
    await ui.clickDialogButton("Cancel");
    await ui.waitNoDialog();
    assertEqual(remoteLines(repo.path).length, 2, "nothing was added (git remote -v)");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Remote umbenennen, entfernen und mit Rückgängig zurückholen", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const before = remoteLines(repo.path);
    await ui.runCommand("Edit remote", "remote.edit");
    // With a single remote the picker is skipped.
    if ((await ui.waitDialog(/^(Edit which remote\?|Edit remote “origin”)$/)).title !== "Edit remote “origin”") await app.press("Enter");
    await ui.waitDialog(/^Edit remote “origin”$/);
    const name = await ui.waitField("Name");
    await ui.retype(name, "zentrale");
    await ui.clickDialogButton("Save");
    await ui.waitToast(/Remote “zentrale” saved/, "success");
    await ui.waitNoDialog();
    assertEqual(remoteLines(repo.path), before.map((line) => line.replace(/^origin /, "zentrale ")), "renamed (git remote -v)");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "main@{upstream}"), "zentrale/main", "the upstream follows the rename (git)");
    await ui.closeToasts();

    await ui.runCommand("Remove remote", "remote.remove");
    if ((await ui.waitDialog(/^(Remove which remote\?|Remove remote “zentrale”\?)$/)).title === "Remove which remote?") await app.press("Enter");
    const ask = await ui.waitDialog(/^Remove remote “zentrale”\?$/);
    assertIncludes(ask.text, "Nothing changes on the server.", "the confirmation says the server is untouched");
    await t.shot("remote-remove-confirm");
    await ui.clickDialogButton("Remove remote");
    await ui.waitToast(/Remote “zentrale” removed/, "success");
    assertEqual(remoteLines(repo.path), [], "git remote -v is empty");
    assertEqual(git(repo.path, "branch", "-r"), "", "the remote branches are gone");
    // Undo in the toolbar names the removal and brings the remote back.
    await app.waitFor(async () => /remote/i.test((await ui.toolState("Undo"))?.hint ?? ""), 10_000, { message: "Undo names the removal" });
    t.step(`undo hint: ${(await ui.toolState("Undo")).hint}`);
    await ui.clickTool("Undo");
    await app.waitFor(() => remoteLines(repo.path).length === 2, 20_000, { message: "Undo brings the remote back" });
    assertEqual(remoteLines(repo.path), before.map((line) => line.replace(/^origin /, "zentrale ")), "name and URLs are restored (git remote -v)");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// v1.1: several refs in one push, atomic
// ---------------------------------------------------------------------------------------------

/** main 1 ahead, feature/export 1 ahead, a new local branch and a tag – nothing pushed yet. */
function prepareMultiPush(repo) {
  const main = localCommit(repo, "auswertung.md", "Auswertung Februar");
  repo.git("checkout", "-q", "feature/export");
  const feature = localCommit(repo, "src/export.md", "Export dokumentiert");
  repo.git("checkout", "-q", "-b", "auswertung/neu", "main");
  const fresh = localCommit(repo, "neu.md", "Neue Auswertung angelegt");
  repo.git("checkout", "-q", "main");
  repo.git("tag", "-a", "v1.0", "-m", "Erste Fassung", "main");
  return { main, feature, fresh, tag: repo.git("rev-parse", "v1.0") };
}

/** Opens "Push with more branches and tags …" through the palette. */
async function openPushMany(app, ui) {
  await ui.runCommand("Push with more", "sync.push.more");
  return ui.waitDialog(/^Push main and more$/);
}

scenario("Mehrere Branches und einen Tag in einem atomaren Push senden", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const refs = prepareMultiPush(repo);
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const dialog = await openPushMany(app, ui);
    assertIncludes(dialog.text, "Branch feature/export", "feature/export is offered");
    assertIncludes(dialog.text, "1 commit to origin/feature/export", "with what it carries");
    assertIncludes(dialog.text, "creates the remote branch", "a new branch says it creates the remote branch");
    assertIncludes(dialog.text, "Tag v1.0", "the tag is offered");
    const atomic = await ui.waitField("All or nothing");
    assertEqual(await ui.checked(atomic), false, "with nothing selected, all or nothing is off");
    assert(await (await ui.dialogButton("Push 1 ref")).prop("disabled"), "nothing selected: submit disabled");
    for (const label of ["Branch feature/export", "Branch auswertung/neu", "Tag v1.0"]) await (await ui.waitField(label)).click();
    await app.waitFor(() => ui.dialogButton("Push 4 refs"), 5000, { message: "submit counts 4 refs" });
    assertEqual(await ui.checked(atomic), true, "all or nothing is switched on by itself");
    await t.shot("push-many-atomic");
    await ui.clickDialogButton("Push 4 refs");
    await ui.waitToast(/4 refs pushed/, "success", 60_000);
    assertEqual(git(repo.remotePath, "rev-parse", "main"), refs.main, "main on the remote (git)");
    assertEqual(git(repo.remotePath, "rev-parse", "feature/export"), refs.feature, "feature/export on the remote (git)");
    assertEqual(git(repo.remotePath, "rev-parse", "auswertung/neu"), refs.fresh, "the new branch on the remote (git)");
    assertEqual(git(repo.remotePath, "rev-parse", "refs/tags/v1.0"), refs.tag, "the annotated tag on the remote (git)");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Atomarer Push mit abgelehntem Ref ändert auf dem Remote nichts", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const refs = prepareMultiPush(repo);
    repo.commitOnRemote({ branch: "feature/export", message: "Fremder Commit auf feature/export", file: "fremd.md" });
    const remoteBefore = { main: git(repo.remotePath, "rev-parse", "main"), feature: git(repo.remotePath, "rev-parse", "feature/export") };
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    await openPushMany(app, ui);
    await (await ui.waitField("Branch feature/export")).click();
    await (await ui.waitField("Tag v1.0")).click();
    assertEqual(await ui.checked(await ui.waitField("All or nothing")), true, "atomic is on");
    await ui.clickDialogButton("Push 3 refs");
    const result = await ui.waitDialog(/^Push result per ref$/, 60_000);
    t.step(`result: ${result.text}`);
    assertMatch(result.text, /feature\/export\s+rejected/, "feature/export is listed as rejected");
    assertMatch(result.text, /main\s+rejected/, "main is rejected too (atomic)");
    await t.shot("push-many-atomic-rejected");
    assertEqual(git(repo.remotePath, "rev-parse", "main"), remoteBefore.main, "main on the remote is unchanged (git)");
    assertEqual(git(repo.remotePath, "rev-parse", "feature/export"), remoteBefore.feature, "feature/export on the remote is unchanged (git)");
    assertEqual(revParse(repo.remotePath, "refs/tags/v1.0"), null, "the tag did not arrive (git)");
    assert(refs.main !== remoteBefore.main, "sanity: main was ahead");
    await ui.clickDialogButton("Close");
    await ui.waitNoDialog();
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Ohne „Alles oder nichts“ gehen die übrigen Refs trotz Ablehnung durch", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const refs = prepareMultiPush(repo);
    repo.commitOnRemote({ branch: "feature/export", message: "Fremder Commit auf feature/export", file: "fremd.md" });
    const featureBefore = git(repo.remotePath, "rev-parse", "feature/export");
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    await openPushMany(app, ui);
    await (await ui.waitField("Branch feature/export")).click();
    await (await ui.waitField("Tag v1.0")).click();
    const atomic = await ui.waitField("All or nothing");
    await atomic.click();
    assertEqual(await ui.checked(atomic), false, "atomic switched off");
    await ui.clickDialogButton("Push 3 refs");
    const result = await ui.waitDialog(/^Push result per ref$/, 60_000);
    t.step(`result: ${result.text}`);
    assertMatch(result.text, /feature\/export\s+rejected/, "feature/export is rejected");
    assertMatch(result.text, /main\s+pushed/, "main is pushed");
    assertMatch(result.text, /v1\.0\s+pushed/, "the tag is pushed");
    await t.shot("push-many-partial");
    assertEqual(git(repo.remotePath, "rev-parse", "main"), refs.main, "main arrived (git)");
    assertEqual(git(repo.remotePath, "rev-parse", "refs/tags/v1.0"), refs.tag, "the tag arrived (git)");
    assertEqual(git(repo.remotePath, "rev-parse", "feature/export"), featureBefore, "feature/export on the remote is unchanged (git)");
    await ui.clickDialogButton("Close");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Push-Dialog: Filter ohne Treffer, Filter auf Tag, Abbrechen pusht nichts", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    prepareMultiPush(repo);
    const remoteMain = git(repo.remotePath, "rev-parse", "main");
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    await openPushMany(app, ui);
    const filter = await ui.waitField("Filter");
    await filter.type("gibt-es-nicht");
    await app.waitFor(async () => (await ui.dialog()).text.includes("Nothing matches the filter."), 5000, { message: "empty filter result" });
    await t.shot("push-many-filter-empty");
    await ui.retype(filter, "V1");
    await app.waitFor(async () => {
      const text = (await ui.dialog()).text;
      return text.includes("Tag v1.0") && !text.includes("Branch feature/export");
    }, 5000, { message: "filter is case-insensitive and keeps only the tag" });
    await (await ui.waitField("Tag v1.0")).click();
    await app.press("Escape");
    await ui.waitNoDialog();
    await sleep(500);
    assertEqual(git(repo.remotePath, "rev-parse", "main"), remoteMain, "cancelled: main on the remote unchanged (git)");
    assertEqual(revParse(repo.remotePath, "refs/tags/v1.0"), null, "cancelled: no tag on the remote (git)");
    assertEqual((await ui.seenToasts()).length, 0, "no toast after cancelling");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// HTTPS credentials (git http-backend behind a local HTTPS server with basic auth)
// ---------------------------------------------------------------------------------------------

const HTTPS_USER = "lena";
const HTTPS_PASSWORD = "Sonnen-Sensor-42";

/** Repository whose origin is the HTTPS server; the app trusts the server's self-signed certificate. */
async function httpsSetup() {
  const server = await startGitHttpServer({ users: { [HTTPS_USER]: HTTPS_PASSWORD }, tls: true });
  const repo = makeCleanRepoWithRemote();
  const bare = server.createBare("messnetz.git", { from: repo.path });
  repo.git("remote", "set-url", "origin", server.url("messnetz.git"));
  const keyring = await startPrivateKeyring();
  assert(keyring, "a private Secret Service (dbus-daemon + gnome-keyring-daemon) could be started");
  const env = { server, repo, bare, keyring, app: null };
  env.cleanup = async () => {
    if (env.app) {
      await forgetAll(env.app);
      await env.app.close();
    }
    await keyring.close();
    await server.close();
    repo.cleanup();
  };
  return env;
}

/** App with the private keychain that trusts the server's self-signed certificate. */
async function httpsApp(t, env) {
  const started = await start(t, { env: env.keyring.env });
  env.app = started.app;
  appendAppGitConfig(started.app, `[http]\n\tsslCAInfo = ${slash(env.server.caFile)}\n`);
  return started;
}

/** Leaves the keychain clean (the app's test service), even after a failure. */
async function forgetAll(app) {
  await app.invoke("credentials_forget_all").catch(() => undefined);
}

/** Answers the two prompts of a fetch: username, then password (optionally remembered). */
async function signIn(app, ui, { password = HTTPS_PASSWORD, remember = false, shot = null, t = null } = {}) {
  const user = await ui.waitDialog(/^Username for the remote$/, 60_000);
  assertIncludes(user.text, "127.0.0.1", "the prompt names the host");
  await (await ui.waitField("Username")).type(HTTPS_USER);
  await app.press("Enter");
  const ask = await ui.waitDialog(/^Sign in to the remote$/, 60_000);
  assertIncludes(ask.text, HTTPS_USER, "the password prompt names the user");
  await (await ui.waitField("Password or token")).type(password);
  if (remember) {
    const box = await ui.waitField("Remember in the system keychain");
    await box.click();
    assertEqual(await ui.checked(box), true, "remember is ticked");
  }
  if (shot && t) await t.shot(shot);
  await ui.clickDialogButton("Sign in");
}

/** A new commit directly in the server's bare repository (no network). Returns the SHA. */
function commitOnServer(bare, message) {
  const tree = git(bare, "rev-parse", "main^{tree}");
  const commit = git(bare, "-c", "user.name=Jonas Albrecht", "-c", "user.email=jonas.albrecht@wetterstation.example", "commit-tree", tree, "-p", "main", "-m", message);
  git(bare, "update-ref", "refs/heads/main", commit);
  return commit;
}

scenario("HTTPS: Anmeldung beim Fetch, im Schlüsselbund merken, nächster Fetch fragt nicht", "main", async (t) => {
  const env = await httpsSetup();
  try {
    const { app, ui } = await httpsApp(t, env);
    assertEqual((await app.invoke("app_info")).keyringAvailable, true, "the (private) system keychain is available");
    assertEqual(await app.invoke("credentials_list"), [], "nothing remembered at the start");
    await open(app, ui, env.repo.path);
    const first = commitOnServer(env.bare, "Nachtrag auf dem Server");
    await ui.clickTool("Fetch");
    await signIn(app, ui, { remember: true, shot: "https-sign-in-remember", t });
    await ui.waitToast(/Fetch complete/, "success", 60_000);
    assertEqual(revParse(env.repo.path, "origin/main"), first, "the server's commit arrived over HTTPS (git)");
    const remembered = await app.waitFor(async () => {
      const list = await app.invoke("credentials_list");
      return list.length ? list : null;
    }, 10_000, { message: "the credential is remembered" });
    assertEqual(remembered.map((entry) => [entry.username, entry.kind, entry.host.includes(`127.0.0.1:${env.server.port}`)]), [[HTTPS_USER, "password", true]], "credentials_list: user, kind and host");
    assert(!JSON.stringify(remembered).includes(HTTPS_PASSWORD), "the list never contains the secret");
    assert(!fs.readFileSync(path.join(env.repo.path, ".git", "config"), "utf8").includes(HTTPS_PASSWORD), "the password is not in .git/config");
    await ui.closeToasts();
    await ui.forgetToasts();

    // Second fetch: answered from the keychain, no prompt.
    const asked = (await ui.credentialRequests()).length;
    const before = env.server.requests.length;
    const second = commitOnServer(env.bare, "Zweiter Nachtrag auf dem Server");
    await ui.clickTool("Fetch");
    await ui.waitToast(/Fetch complete/, "success", 60_000);
    assertEqual(revParse(env.repo.path, "origin/main"), second, "the second commit arrived (git)");
    assertEqual((await ui.credentialRequests()).length, asked, "the second fetch did not ask");
    assert(env.server.requests.slice(before).some((entry) => entry.user === HTTPS_USER && entry.status === 200), "the server saw the remembered sign-in");
    const log = JSON.stringify(await app.invoke("activity_list", { scope: "repo", repoId: (await app.invoke("repo_list"))[0].id, cursor: null, limit: 100 }));
    assert(!log.includes(HTTPS_PASSWORD), "the activity log contains no password");
    await t.noConsoleErrors(app);
  } finally {
    await env.cleanup();
  }
});

scenario("HTTPS: Push nach gemerkter Anmeldung fragt nicht erneut", "edge", async (t) => {
  const env = await httpsSetup();
  try {
    const { app, ui } = await httpsApp(t, env);
    await open(app, ui, env.repo.path);
    await ui.clickTool("Fetch");
    await signIn(app, ui, { remember: true });
    await ui.waitToast(/Fetch complete/, "success", 60_000);
    await app.waitFor(async () => (await app.invoke("credentials_list")).length === 1, 10_000, { message: "the credential is remembered" });
    await ui.closeToasts();

    const asked = (await ui.credentialRequests()).length;
    const local = localCommit(env.repo, "lokal.md", "Vom Laptop über HTTPS gepusht");
    await ui.refresh();
    await app.waitFor(async () => (await ui.toolState("Push"))?.label === "Push, 1 commit to push", 15_000, { message: "Push shows ↑1" });
    await ui.clickTool("Push");
    const pushed = await app.waitFor(async () => (await ui.seenToasts()).find((toast) => /Pushed to origin\/main/.test(toast.text)) ?? ((await ui.dialog()) ? "prompt" : null), 60_000, { message: "push result or prompt" });
    if (pushed === "prompt") {
      await t.shot("https-push-asks-again");
      const hooks = fs.readdirSync(path.join(env.repo.path, ".git", "hooks")).filter((name) => !name.endsWith(".sample"));
      t.step(`hooks in the repository: ${hooks.join(",") || "none"}`);
      throw new Error(`APP BUG: the push asks again although the credential is remembered – prompt ${JSON.stringify((await ui.credentialRequests()).slice(asked))}, dialog ${JSON.stringify(await ui.dialog())}`);
    }
    assertEqual(git(env.bare, "rev-parse", "main"), local, "the commit is on the server (git in the bare repo)");
    assertEqual((await ui.credentialRequests()).length, asked, "the push did not ask (credential from the keychain)");
    await t.noConsoleErrors(app);
  } finally {
    await env.cleanup();
  }
});

scenario("Öffnen eines Repositorys legt keine Hooks an (Push-Hooks bleiben unverändert)", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const hooksDir = path.join(repo.path, ".git", "hooks");
    const own = () => fs.readdirSync(hooksDir).filter((name) => !name.endsWith(".sample")).sort();
    assertEqual(own(), [], "the fixture has no hooks");
    const configBefore = git(repo.path, "config", "--local", "--list");
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    await sleep(1500);
    await app.settle();
    const after = own();
    if (after.length) await t.shot("open-adds-hooks");
    assertEqual(after, [], "opening the repository did not create hooks in .git/hooks");
    assertEqual(git(repo.path, "config", "--local", "--list"), configBefore, "opening the repository did not change .git/config");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("HTTPS: Abbrechen ist kein Fehler, falsches Passwort wird abgelehnt und nicht gemerkt", "edge", async (t) => {
  const env = await httpsSetup();
  try {
    const { app, ui } = await httpsApp(t, env);
    await open(app, ui, env.repo.path);
    await ui.clickTool("Fetch");
    await ui.waitDialog(/^Username for the remote$/, 60_000);
    await app.press("Escape");
    await ui.waitNoDialog(30_000);
    await app.waitFor(async () => (await ui.toolState("Fetch"))?.busy === false, 30_000, { message: "the fetch ended" });
    await sleep(500);
    assertEqual(await ui.dangerToasts(), [], "a cancelled sign-in is not an error message");
    await ui.forgetToasts();

    await ui.clickTool("Fetch");
    await signIn(app, ui, { password: "falsch-geraten", remember: true });
    const failed = await ui.waitToast(/Fetch from “origin” failed/, "danger", 60_000);
    assertMatch(failed.text, /sign|credential|password/i, "the message explains the rejected sign-in");
    assert(!failed.text.includes("falsch-geraten"), "the toast does not show the password");
    assert(env.server.requests.some((entry) => entry.rejected === HTTPS_USER), "the server rejected the sign-in");
    await t.shot("https-wrong-password");
    assertEqual(await app.invoke("credentials_list"), [], "a rejected password is not remembered even with the box ticked");
    await t.noConsoleErrors(app);
  } finally {
    await env.cleanup();
  }
});

scenario("HTTPS: geändertes Server-Passwort verwirft den Eintrag, „Alle vergessen“ in den Einstellungen", "edge", async (t) => {
  const env = await httpsSetup();
  try {
    const { app, ui } = await httpsApp(t, env);
    await open(app, ui, env.repo.path);
    await ui.clickTool("Fetch");
    await signIn(app, ui, { remember: true });
    await ui.waitToast(/Fetch complete/, "success", 60_000);
    await app.waitFor(async () => (await app.invoke("credentials_list")).length === 1, 10_000, { message: "remembered" });

    // The server changes the password: the remembered entry is rejected and forgotten.
    env.server.setPassword(HTTPS_USER, "Regen-Messer-17");
    const asked = (await ui.credentialRequests()).length;
    await ui.forgetToasts();
    await ui.clickTool("Fetch");
    await ui.waitToast(/Fetch from “origin” failed/, "danger", 60_000);
    assertEqual((await ui.credentialRequests()).length, asked, "no prompt (the keychain answered)");
    await app.waitFor(async () => (await app.invoke("credentials_list")).length === 0, 10_000, { message: "the rejected entry is forgotten" });
    await ui.closeToasts();

    // Sign in again with the new password, remember, then "Forget all" in the preferences.
    await ui.clickTool("Fetch");
    await signIn(app, ui, { password: "Regen-Messer-17", remember: true });
    await ui.waitToast(/Fetch complete/, "success", 60_000);
    await app.waitFor(async () => (await app.invoke("credentials_list")).length === 1, 10_000, { message: "remembered again" });
    await ui.openPrefs("Credentials");
    const rows = await app.exec(() => [...document.querySelectorAll('[data-screen="settings"] table tbody tr')].map((row) => [...row.cells].map((cell) => cell.innerText.trim())));
    assertEqual(rows.length, 1, "one entry in the table");
    assertIncludes(rows[0].join(" "), HTTPS_USER, "the row names the user");
    assert(!(await ui.pageText()).includes("Regen-Messer-17"), "the secret appears nowhere");
    await t.shot("https-credentials-prefs");
    await app.click({ text: "Forget all", within: '[data-screen="settings"]' });
    await ui.waitDialog(/^Forget the saved entry\?$/);
    assertEqual((await ui.focused()).text, "Cancel", "the confirmation focuses Cancel");
    await ui.clickDialogButton("Forget all");
    await ui.waitToast(/1 entry forgotten/, "success");
    await app.waitFor('[data-screen="settings"] [data-state="empty"]', 10_000);
    assertEqual(await app.invoke("credentials_list"), [], "credentials_list is empty");
    await ui.closePrefs();
    // Afterwards the app asks again.
    await ui.clickTool("Fetch");
    await ui.waitDialog(/^Username for the remote$/, 60_000);
    await app.press("Escape");
    await ui.waitNoDialog(30_000);
    await t.noConsoleErrors(app);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// SSH keys and SSH remotes (the system's sshd as a user process on 127.0.0.1)
// ---------------------------------------------------------------------------------------------

/** Own SSH folder and known_hosts; ssh ignores ~/.ssh/config. */
function sshSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fy-e2e-sync-ssh-"));
  const sshDir = path.join(root, "ssh-ordner");
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const knownHosts = path.join(root, "known_hosts");
  return {
    root,
    sshDir,
    knownHosts,
    knownHostsText: () => (fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, "utf8") : ""),
    configure: (app) => appendAppGitConfig(app, `[core]\n\tsshCommand = ssh -F none -o UserKnownHostsFile='${slash(knownHosts)}' -o GlobalKnownHostsFile=/dev/null\n`),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

scenario("SSH-Schlüssel in den Einstellungen erzeugen, als Standard setzen, öffentlichen Schlüssel kopieren", "main", async (t) => {
  const box = sshSandbox();
  try {
    const { app, ui } = await start(t, { env: { FORKYARD_SSH_DIR: box.sshDir } });
    assertEqual(await app.invoke("ssh_key_list"), [], "no key at the start (redirected SSH folder)");
    await ui.openPrefs("SSH keys");
    await app.waitFor('[data-screen="settings"] [data-state="empty"]', 10_000);
    const agent = await app.waitFor('[data-screen="settings"] [role="switch"]', 10_000);
    assertEqual(await agent.attr("aria-checked"), "true", "Use the system SSH agent is on initially");
    await app.click({ text: "Generate key", within: '[data-screen="settings"]' });
    await ui.waitDialog(/^Generate SSH key$/);
    assertEqual((await ui.focused()).label, "Label", "focus is in Label");
    // Empty label is refused.
    await app.press("Enter");
    await app.waitFor(async () => (await ui.dialog()).text.includes("Give the key a label"), 5000, { message: "label required" });
    await (await ui.waitField("Label")).type("Messrechner");
    assertEqual(await (await ui.waitField("File name")).prop("value"), "id_ed25519", "default file name");
    await app.press("Enter");
    await ui.waitToast(/Key “Messrechner” generated/, "success", 60_000);
    const keys = await app.invoke("ssh_key_list");
    assertEqual(keys.length, 1, "one key in the list");
    assert(fs.existsSync(path.join(box.sshDir, "id_ed25519")) && fs.existsSync(path.join(box.sshDir, "id_ed25519.pub")), "both key files are in the SSH folder");
    assertMatch(keys[0].fingerprint, /^SHA256:/, "fingerprint");
    assertEqual((fs.statSync(path.join(box.sshDir, "id_ed25519")).mode & 0o077), 0, "the private key is readable only by the owner");
    await app.waitFor('[data-key="Messrechner"]', 10_000);
    const cardText = await app.exec(() => {
      const card = document.querySelector('[data-key="Messrechner"]');
      return `${card.textContent} ${[...card.querySelectorAll("[title]")].map((item) => item.getAttribute("title")).join(" ")}`;
    });
    assertIncludes(cardText, keys[0].fingerprint, "the card shows the fingerprint");
    await ui.closeToasts();
    await app.click({ text: "Use as default", within: '[data-key="Messrechner"]' });
    await ui.waitToast(/“Messrechner” is now the default key/, "success");
    await app.waitFor(async () => (await app.invoke("ssh_key_list"))[0].isDefault === true, 10_000, { message: "default key saved" });
    await agent.click();
    await app.waitFor(async () => (await app.invoke("settings_get")).sshUseAgent === false, 10_000, { message: "agent switch saved" });
    await app.click({ text: "Copy public key", within: '[data-key="Messrechner"]' });
    await ui.waitToast(/Public key copied/, "success");
    await t.shot("ssh-key-generated");
    // Same file name again: refused, nothing overwritten.
    const before = fs.readFileSync(path.join(box.sshDir, "id_ed25519"), "utf8");
    await app.click({ text: "Generate key", within: '[data-screen="settings"]' });
    await ui.waitDialog(/^Generate SSH key$/);
    await (await ui.waitField("Label")).type("Zweitschlüssel");
    const fileName = await ui.waitField("File name");
    assertEqual(await fileName.prop("value"), "id_ed25519_2", "the suggested file name avoids the existing one");
    await ui.retype(fileName, "id_ed25519");
    await app.press("Enter");
    await app.waitFor(async () => (await ui.dialog())?.text.includes("already exists"), 15_000, { message: "existing file refused" });
    assertEqual(fs.readFileSync(path.join(box.sshDir, "id_ed25519"), "utf8"), before, "the existing key file is untouched");
    await app.press("Escape");
    await t.noConsoleErrors(app);
  } finally {
    box.cleanup();
  }
});

/** sshd with the fixture's bare repository; null if there is no sshd. */
async function sshServer(repo) {
  if (!findSshd()) return null;
  const server = await startGitSshServer();
  server.createBare("messnetz.git", { from: repo.path });
  return server;
}

/** App with a generated default key (agent off) whose public part the server accepts. */
async function sshApp(t, box, server, { passphrase = null, env = {} } = {}) {
  const started = await start(t, { env: { FORKYARD_SSH_DIR: box.sshDir, ...env } });
  box.configure(started.app);
  const keys = await started.app.invoke("ssh_key_generate", { label: "Messrechner", fileName: "id_ed25519", passphrase });
  await started.app.invoke("ssh_key_set_default", { id: keys[0].id });
  await started.app.invoke("settings_set", { patch: { sshUseAgent: false } });
  server.authorize(keys[0].publicKey);
  return { ...started, key: (await started.app.invoke("ssh_key_list"))[0] };
}

scenario("SSH: Fetch und Push mit Host-Prüfung und dem Standardschlüssel", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  const box = sshSandbox();
  const server = await sshServer(repo);
  try {
    assert(server, "sshd is available on this machine");
    const { app, ui, key } = await sshApp(t, box, server);
    repo.git("remote", "set-url", "origin", server.url("messnetz.git"));
    await open(app, ui, repo.path);
    const bare = path.join(server.reposDir, "messnetz.git");
    const serverSha = commitOnServer(bare, "Nachtrag über SSH");
    await server.ready();
    await ui.clickTool("Fetch");
    const ask = await ui.waitDialog(/^Unknown SSH host$/, 60_000);
    assertIncludes(ask.text, server.hostFingerprint, "the prompt shows the server's fingerprint");
    assertEqual((await ui.focused()).text, "Cancel", "focus is on Cancel – Enter never trusts by accident");
    await t.shot("ssh-host-key");
    await ui.clickDialogButton("Trust host and connect");
    await ui.waitToast(/Fetch complete/, "success", 60_000);
    assertEqual(revParse(repo.path, "origin/main"), serverSha, "the server's commit arrived over SSH (git)");
    assertIncludes(box.knownHostsText(), `[127.0.0.1]:${server.port}`, "the host is in the (own) known_hosts file");
    assertEqual(server.accepted().at(-1), key.fingerprint, "the server saw the app's default key");
    await ui.closeToasts();

    const asked = (await ui.credentialRequests()).length;
    repo.git("merge", "-q", "--ff-only", "origin/main");
    const local = localCommit(repo, "lokal.md", "Über SSH gepusht");
    await ui.refresh();
    await app.waitFor(async () => (await ui.toolState("Push"))?.label === "Push, 1 commit to push", 15_000, { message: "Push shows ↑1" });
    await server.ready();
    await ui.clickTool("Push");
    const pushed = await app.waitFor(async () => (await ui.seenToasts()).find((toast) => /Pushed to origin\/main|Push failed|rejected/i.test(toast.text)) ?? ((await ui.dialog()) ? { prompt: await ui.dialog() } : null), 90_000, { message: "push result" });
    if (pushed.prompt) throw new Error(`the SSH push asks: ${JSON.stringify(pushed.prompt)} – requests ${JSON.stringify((await ui.credentialRequests()).slice(asked))}`);
    assertMatch(pushed.text, /Pushed to origin\/main/, "push succeeded");
    assertEqual(git(bare, "rev-parse", "main"), local, "the commit is on the server (git in the bare repo)");
    assertEqual((await ui.credentialRequests()).length, asked, "no further prompt (host is known, key without passphrase)");
    await t.noConsoleErrors(app);
  } finally {
    await server?.close();
    box.cleanup();
    repo.cleanup();
  }
});

scenario("SSH: unbekannten Host ablehnen – kein Fehler, nichts in known_hosts", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  const box = sshSandbox();
  const server = await sshServer(repo);
  try {
    assert(server, "sshd is available on this machine");
    const { app, ui } = await sshApp(t, box, server);
    repo.git("remote", "set-url", "origin", server.url("messnetz.git"));
    await open(app, ui, repo.path);
    await server.ready();
    await ui.clickTool("Fetch");
    await ui.waitDialog(/^Unknown SSH host$/, 60_000);
    // Enter on the focused Cancel button rejects.
    await app.press("Enter");
    await ui.waitNoDialog(30_000);
    await app.waitFor(async () => (await ui.toolState("Fetch"))?.busy === false, 30_000, { message: "fetch ended" });
    await sleep(500);
    assertEqual(await ui.dangerToasts(), [], "rejecting is not an error message");
    assert(!box.knownHostsText().includes(String(server.port)), "the host is not in known_hosts");
    assertEqual(revParse(repo.path, "origin/main"), repo.info.head, "nothing was fetched (git)");
    await t.noConsoleErrors(app);
  } finally {
    await server?.close();
    box.cleanup();
    repo.cleanup();
  }
});

scenario("SSH: Server nicht erreichbar – verständliche Meldung, Eintrag im Protokoll", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "funkloch" });
  const box = sshSandbox();
  try {
    const port = await closedPort();
    repo.git("remote", "set-url", "origin", `ssh://${os.userInfo().username}@127.0.0.1:${port}/funkloch.git`);
    const { app, ui } = await start(t, { env: { FORKYARD_SSH_DIR: box.sshDir } });
    box.configure(app);
    const { repoId } = await open(app, ui, repo.path);
    await ui.clickTool("Fetch");
    const failed = await ui.waitToast(/Fetch from “origin” failed/, "danger", 90_000);
    assertMatch(failed.text, /reach|connect/i, "the message says the server cannot be reached");
    assertEqual(await ui.credentialRequests(), [], "no prompt came up");
    await t.shot("ssh-unreachable");
    const entries = (await app.invoke("activity_list", { scope: "repo", repoId, cursor: null, limit: 50 })).entries;
    const fetchEntry = entries.find((entry) => /^git fetch/.test(entry.command));
    assert(fetchEntry && fetchEntry.exitCode !== 0, "the failed fetch is in the activity log");
    assertMatch(fetchEntry.output ?? "", /Connection refused|connect to host/i, "with ssh's output");
    await t.noConsoleErrors(app);
  } finally {
    box.cleanup();
    repo.cleanup();
  }
});

scenario("SSH: Schlüssel mit Passphrase – falsche Passphrase fragt erneut, richtige verbindet", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote();
  const box = sshSandbox();
  const server = await sshServer(repo);
  try {
    assert(server, "sshd is available on this machine");
    const { app, ui, key } = await sshApp(t, box, server, { passphrase: "Wolken-Zug-Nordwest" });
    assert(key.hasPassphrase, "the key has a passphrase");
    // The host is trusted beforehand: this scenario is about the passphrase.
    fs.writeFileSync(box.knownHosts, `[127.0.0.1]:${server.port} ${server.hostPublicKey}\n`);
    repo.git("remote", "set-url", "origin", server.url("messnetz.git"));
    await open(app, ui, repo.path);
    await server.ready();
    await ui.clickTool("Fetch");
    const ask = await ui.waitDialog(/^Passphrase for the SSH key$/, 60_000);
    assertIncludes(ask.text, "id_ed25519", "the prompt names the key file");
    assertEqual((await ui.focused()).label, "Passphrase", "focus is in the Passphrase field");
    await (await ui.waitField("Passphrase")).type("falsch-geraten");
    await app.press("Enter");
    await app.waitFor(async () => (await ui.credentialRequests()).filter((request) => request.kind === "passphrase").length >= 2, 30_000, { message: "ssh asks again after a wrong passphrase" });
    await ui.waitDialog(/^Passphrase for the SSH key$/, 30_000);
    await (await ui.waitField("Passphrase")).type("Wolken-Zug-Nordwest");
    await t.shot("ssh-passphrase");
    await ui.clickDialogButton("Sign in");
    await ui.waitToast(/Fetch complete/, "success", 60_000);
    assertEqual(server.accepted().at(-1), key.fingerprint, "the server accepted the passphrase key");
    const log = JSON.stringify(await app.invoke("activity_list", { scope: "repo", repoId: (await app.invoke("repo_list"))[0].id, cursor: null, limit: 100 }));
    assert(!log.includes("Wolken-Zug-Nordwest") && !log.includes("falsch-geraten"), "no passphrase in the activity log");
    await t.noConsoleErrors(app);
  } finally {
    await server?.close();
    box.cleanup();
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Proxy (HTTP CONNECT proxy in this process, HTTPS Git server with a self-signed certificate)
// ---------------------------------------------------------------------------------------------

/** A CONNECT proxy that records where it is asked to connect. */
async function startConnectProxy() {
  const connects = [];
  const proxy = http.createServer((request, response) => {
    response.writeHead(405);
    response.end();
  });
  proxy.on("connect", (request, client, head) => {
    connects.push(request.url);
    const [host, port] = request.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${proxy.address().port}`, connects, close: () => new Promise((resolve) => proxy.close(() => resolve())) };
}

/** HTTPS server + proxy; the remote URL carries the credentials so no prompt interferes. The CA bundle comes from the app's own setting. */
async function proxySetup(t) {
  const server = await startGitHttpServer({ users: { [HTTPS_USER]: HTTPS_PASSWORD }, tls: true });
  const repo = makeCleanRepoWithRemote({ name: "netz" });
  const bare = server.createBare("messnetz.git", { from: repo.path });
  const hostPort = new URL(server.url("messnetz.git")).host;
  repo.git("remote", "set-url", "origin", `https://${HTTPS_USER}:${HTTPS_PASSWORD}@${hostPort}/messnetz.git`);
  const proxy = await startConnectProxy();
  const { app, ui } = await start(t);
  await app.invoke("settings_set", { patch: { sslCaFile: server.caFile, proxyUrl: null, proxyByHost: [] } });
  const { repoId } = await open(app, ui, repo.path);
  /** New commit on the server, fetched through the toolbar: { arrived, toast }. */
  const fetchNow = async () => {
    await ui.closeToasts();
    await ui.forgetToasts();
    const wanted = commitOnServer(bare, `Nachtrag ${Date.now()}`);
    await ui.clickTool("Fetch");
    const toast = await ui.waitToast(/Fetch/, null, 90_000);
    await app.settle();
    return { arrived: revParse(repo.path, "refs/remotes/origin/main") === wanted, toast };
  };
  const cleanup = async () => {
    await proxy.close();
    await server.close();
    repo.cleanup();
  };
  return { server, repo, bare, hostPort, proxy, app, ui, repoId, fetchNow, cleanup };
}

scenario("Proxy in den Einstellungen setzen: Fetch läuft über den Proxy, falsche Adressen am Feld abgelehnt", "main", async (t) => {
  const env = await proxySetup(t);
  try {
    const { app, ui } = env;
    const direct = await env.fetchNow();
    assert(direct.arrived, `without a proxy the fetch works directly (${direct.toast.text})`);
    assertEqual(env.proxy.connects.length, 0, "nothing went through the proxy yet");

    await ui.openPrefs("Network");
    const field = await app.waitFor('[data-screen="network"] [data-setting="Proxy"] input', 10_000);
    const rowText = () => app.exec(() => document.querySelector('[data-screen="network"] [data-setting="Proxy"]').innerText);
    await ui.retype(field, "kein proxy");
    await app.press("Enter");
    await app.waitFor(async () => (await rowText()).includes("A proxy address contains no spaces."), 5000, { message: "spaces rejected at the field" });
    await ui.retype(field, "proxy.firma.example");
    await app.press("Enter");
    await app.waitFor(async () => (await rowText()).includes("http://proxy.company.example:8080"), 5000, { message: "without a scheme: the field shows the expected form" });
    assertEqual((await app.invoke("settings_get")).proxyUrl ?? null, null, "invalid input is not saved");
    await ui.retype(field, env.proxy.url);
    await app.press("Enter");
    await app.waitFor(async () => (await app.invoke("settings_get")).proxyUrl === env.proxy.url, 10_000, { message: "the proxy is saved" });
    await t.shot("proxy-settings");
    await ui.closePrefs();

    const viaProxy = await env.fetchNow();
    assert(viaProxy.arrived, `the commit arrives through the proxy (${viaProxy.toast.text})`);
    assert(env.proxy.connects.length > 0 && env.proxy.connects.every((target) => target === env.hostPort), `the proxy opened the connection to the Git server: ${JSON.stringify(env.proxy.connects)}`);
    await t.noConsoleErrors(app);
  } finally {
    await env.app.invoke("settings_set", { patch: { proxyUrl: null, proxyByHost: [], sslCaFile: null } }).catch(() => undefined);
    await env.cleanup();
  }
});

scenario("Proxy unerreichbar: Fetch schlägt fehl, Ausnahme für den Host umgeht ihn", "edge", async (t) => {
  const env = await proxySetup(t);
  try {
    const { app, ui } = env;
    const port = await closedPort();
    await app.invoke("settings_set", { patch: { proxyUrl: `http://127.0.0.1:${port}` } });
    await app.exec(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    const failed = await env.fetchNow();
    assertEqual(failed.arrived, false, "nothing arrives through an unreachable proxy");
    assertEqual(failed.toast.tone, "danger", `the app reports the failure (${failed.toast.text})`);
    await t.shot("proxy-unreachable");

    await ui.openPrefs("Network");
    const scope = '[data-network-form="proxy-host"]';
    await (await ui.waitField("Host", scope)).type(env.hostPort);
    await app.click({ text: "Add", within: scope });
    await app.waitFor(async () => JSON.stringify((await app.invoke("settings_get")).proxyByHost ?? []) === JSON.stringify([{ host: `https://${env.hostPort}`, proxy: "" }]), 10_000, { message: "the exception is saved: this host without proxy" });
    const line = await app.waitFor(() => app.exec((selector) => document.querySelector(selector)?.textContent ?? null, `[data-network-proxy-host="https://${env.hostPort}"]`), 10_000, { message: "the exception is listed" });
    assertIncludes(line, "no proxy", "the list says it as text");
    await ui.closePrefs();
    const direct = await env.fetchNow();
    assert(direct.arrived, `with the exception the fetch goes direct (${direct.toast.text})`);
    assertEqual(env.proxy.connects.length, 0, "and not through any proxy");
    await t.noConsoleErrors(app);
  } finally {
    await env.app.invoke("settings_set", { patch: { proxyUrl: null, proxyByHost: [], sslCaFile: null } }).catch(() => undefined);
    await env.cleanup();
  }
});
