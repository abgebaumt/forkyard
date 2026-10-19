/**
 * Branches that are local but not on the remote, in the real app (German UI), against a local bare
 * remote. They must look like pending work ("to push"), never like "nothing to push".
 *
 * - main: `qa/blackbox`, created on the command line with `checkout -b qa/blackbox origin/develop`,
 *   follows origin/develop – but is not on the remote. Git's default (`push.default=simple`) refuses
 *   a plain push there; Forkyard must not push the QA commits onto develop either. The status bar
 *   says "↑1 · noch nicht auf origin" (not "↑0 ↓0"), Push carries the badge, asks "Wohin pushen?"
 *   with the branch's own name and creates origin/qa/blackbox; origin/develop is unchanged (checked
 *   with Git in the bare remote);
 * - edge: cancelling the dialog pushes nothing; the sidebar row counts the commit as not on the
 *   remote instead of counting towards develop;
 * - edge: a fresh branch without commits of its own: "↑0 · noch nicht auf origin", a dot on Push,
 *   and Push creates it on the remote.
 *
 *   node scripts/e2e-wd/features/push-upstream-name.mjs
 */
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { NO_PROXY_ENV, git, revParse, sleep, syncUi } from "../fixtures/sync-ui.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

/** Starts the app in German, switches auto-fetch off, installs the toast recorder. */
async function start(t) {
  const app = await t.launch({ lang: "de", theme: "light", width: 1440, height: 900, env: { SSH_AUTH_SOCK: "", ...NO_PROXY_ENV } });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const ui = syncUi(app);
  await ui.install();
  return { app, ui };
}

async function open(app, ui, repoPath) {
  const ids = await app.openRepo(repoPath);
  await app.waitFor(() => ui.toolButton("Fetch"), 20_000, { message: "repository toolbar" });
  await app.settle();
  return ids;
}

/** develop on the remote, then `qa/blackbox` from origin/develop with one commit of its own. */
function qaBranch(repo) {
  repo.git("checkout", "-q", "-b", "develop");
  repo.write("develop.md", "Entwicklungsstand\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Entwicklungsstand");
  repo.git("push", "-q", "-u", "origin", "develop");
  repo.git("checkout", "-q", "main");
  repo.git("checkout", "-q", "-b", "qa/blackbox", "origin/develop");
  repo.write("qa.md", "Blackbox-Test\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Blackbox-Test vorbereitet");
  // The oracles for the starting point: Git itself.
  assertEqual(repo.git("rev-parse", "--abbrev-ref", "qa/blackbox@{upstream}"), "origin/develop", "upstream origin/develop (git)");
  assertEqual(repo.git("rev-list", "--count", "qa/blackbox", "--not", "--remotes=origin"), "1", "one commit on no remote branch (git)");
  return { qa: repo.git("rev-parse", "HEAD"), develop: git(repo.remotePath, "rev-parse", "develop") };
}

/** The "not on the remote yet" part of the status bar. */
const statusPending = (app) =>
  app.exec(() => {
    const item = document.querySelector("footer [data-publish]");
    return item ? { kind: item.getAttribute("data-publish"), text: item.innerText.replace(/\s+/g, " ").trim(), title: item.getAttribute("title") ?? "" } : null;
  });

const pushDot = (app) => app.exec(() => Boolean([...document.querySelectorAll('[role="toolbar"] button')].find((button) => button.getAttribute("aria-label")?.startsWith("Push,"))?.querySelector("[data-badge-dot]")));

const remoteHeads = (repo) => git(repo.remotePath, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean);

/** aria-label of the sidebar row of a local branch. */
const rowLabel = (app, name) =>
  app.exec((wanted) => [...document.querySelectorAll('[data-kind="branch"]')].map((item) => item.getAttribute("aria-label") ?? "").find((label) => label.includes(wanted)) ?? null, name);

scenario("Branch, der origin/develop folgt: ↑1 noch nicht auf origin, Push fragt wohin, develop bleibt", "main", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "qa-blackbox" });
  try {
    const { qa, develop } = qaBranch(repo);
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);

    const shown = await app.waitFor(() => statusPending(app), 15_000, { message: "status bar: not on origin yet" });
    assertEqual(shown.kind, "elsewhere", "follows a branch of another name");
    assertMatch(shown.text, /^1\s*· noch nicht auf origin$/, "the status bar shows the outgoing commit instead of ↑0 ↓0");
    assertEqual(shown.title, "Folgt origin/develop (anderer Name). Ein Push fragt, wohin.", "the tooltip names the upstream");
    const push = await ui.toolState("Push");
    assert(!push.disabled, `Push is not blocked with "nothing to push" (hint: ${push.hint})`);
    assertEqual(push.label, "Push, 1 Commit zum Pushen", "Push carries the badge");
    assertMatch(push.hint, /Nicht veröffentlicht/, "the push hint says it isn't published");
    await t.shot("not-on-origin");

    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Control+Shift+p");
    await ui.waitDialog(/^Wohin pushen\?$/, 30_000);
    const name = await ui.waitField("Name des Branches auf dem Remote");
    assertEqual(await name.prop("value"), "qa/blackbox", "the remote name defaults to the branch's own name");
    await t.shot("push-where-to");
    await app.press("Enter");
    await ui.waitToast(/Nach origin\/qa\/blackbox gepusht/, "success", 60_000);

    // Oracle: Git in the bare remote.
    assertEqual(git(repo.remotePath, "rev-parse", "develop"), develop, "origin/develop is unchanged");
    assertEqual(git(repo.remotePath, "rev-parse", "qa/blackbox"), qa, "qa/blackbox is on the remote");
    assertEqual(repo.git("rev-parse", "--abbrev-ref", "qa/blackbox@{upstream}"), "origin/qa/blackbox", "the new upstream is recorded (git)");
    await app.waitFor(async () => (await statusPending(app)) === null, 15_000, { message: "the status bar shows the normal counters again" });
    await app.waitFor(async () => (await ui.toolState("Push"))?.disabled === true, 15_000, { message: "now there is nothing to push" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Abbrechen pusht nichts; die Seitenleiste zählt nicht gegen develop", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "qa-blackbox-abbruch" });
  try {
    const { develop } = qaBranch(repo);
    const headsBefore = remoteHeads(repo);
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    await app.waitFor(() => statusPending(app), 15_000, { message: "status bar: not on origin yet" });

    // The sidebar row: the outgoing commit, "follows origin/develop", no "ahead of origin/develop".
    const row = await app.waitFor(() => rowLabel(app, "qa/blackbox"), 15_000, { message: "sidebar row of qa/blackbox" });
    assertIncludes(row, "1 Commit noch nicht auf dem Remote", "the row counts the commit as not on the remote");
    assertIncludes(row, "folgt origin/develop (anderer Name)", "and names the upstream");
    assert(!/voraus/.test(row), `no ahead count towards develop: ${row}`);

    await ui.clickTool("Push");
    await ui.waitDialog(/^Wohin pushen\?$/, 30_000);
    await app.press("Escape");
    await ui.waitNoDialog();
    await sleep(500);
    assertEqual(git(repo.remotePath, "rev-parse", "develop"), develop, "cancelled: develop unchanged (git)");
    assertEqual(remoteHeads(repo), headsBefore, "cancelled: no branch was created on the remote (git)");
    assertEqual(revParse(repo.remotePath, "refs/heads/qa/blackbox"), null, "qa/blackbox is not on the remote");
    assertEqual((await ui.dangerToasts()).length, 0, "no error toast");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Frischer Branch ohne eigene Commits: ↑0 noch nicht auf origin, Punkt auf Push, Push legt ihn an", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "frischer-branch" });
  try {
    repo.git("checkout", "-q", "-b", "messung/leer");
    assertEqual(repo.git("rev-list", "--count", "messung/leer", "--not", "--remotes"), "0", "no commit of its own (git)");
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);
    const shown = await app.waitFor(() => statusPending(app), 15_000, { message: "status bar: not on origin yet" });
    assertEqual(shown.kind, "none", "no upstream");
    assertMatch(shown.text, /^0\s*· noch nicht auf origin$/, "↑0 · not on origin yet");
    const push = await ui.toolState("Push");
    assert(!push.disabled, "Push is enabled");
    assertEqual(push.label, "Push, Branch noch nicht auf dem Remote", "the badge is described");
    assert(await pushDot(app), "a dot on Push instead of a number");
    const row = await app.waitFor(() => rowLabel(app, "messung/leer"), 15_000, { message: "sidebar row" });
    assertIncludes(row, "Noch nicht auf dem Remote", "the row says not on the remote yet");
    await t.shot("fresh-branch");

    await ui.clickTool("Push");
    await ui.waitDialog(/^Wohin pushen\?$/, 30_000);
    assertEqual(await (await ui.waitField("Name des Branches auf dem Remote")).prop("value"), "messung/leer", "same name prefilled");
    await app.press("Enter");
    await ui.waitToast(/Nach origin\/messung\/leer gepusht/, "success", 60_000);
    assertEqual(git(repo.remotePath, "rev-parse", "messung/leer"), repo.git("rev-parse", "HEAD"), "the branch exists on the remote (git)");
    await app.waitFor(async () => (await statusPending(app)) === null, 15_000, { message: "published now" });
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
