/**
 * "Open review comments" in the pull request view (v1.2, 8.2) in the real app. Host: the local forge
 * (GitHub flavour of scripts/e2e/host-mock.mjs + Git over HTTP, see fixtures/github-gitlab-host.mjs) with
 * pull request #7 on the real branch feature/export; AI: a Node stand-in for Ollama behind
 * FORKYARD_AI_BASE_URL_OLLAMA (debug builds only). Nothing reaches a real service.
 *
 * - main: thread loaded, fix suggested, taken over as fixup, reply posted, autosquash plan opened;
 * - edge: the branch is not checked out – "Branch auschecken", then the takeover works (German texts);
 * - edge: without AI the threads stay readable, "Suggest fix" is hidden and a reply still goes out.
 *
 *   node scripts/e2e-wd/features/review-fixups.mjs
 *   E2E_WD_ONLY="checked out" node scripts/e2e-wd/features/review-fixups.mjs
 */
import http from "node:http";
import path from "node:path";
import { startForge } from "../fixtures/github-gitlab-host.mjs";
import { until } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const PRV = '[data-screen="pr-view"]';
const SECTION = `${PRV} [data-review-threads]`;
const THREAD = `${SECTION} [data-review-thread="7001"]`;
const BRANCH = "feature/export";
const TARGET_SUBJECT = "CSV-Export für den Vergleich";
const AI_ON = { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" };
const NEW_LINE = '    return f"{station};{wert:.1f}"';
const ANSWER = { path: "src/export.py", startLine: 5, endLine: 5, newText: NEW_LINE, why: "Werte erscheinen jetzt mit einer Nachkommastelle." };

/** Local stand-in for Ollama: records the chat requests and answers with `ANSWER`. */
async function startOllama() {
  const state = { chats: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const send = (status, value) => {
        const text = JSON.stringify(value);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      const route = `${req.method} ${req.url}`;
      if (route === "POST /api/show") return send(200, { model_info: { "qwen3.context_length": 40960 } });
      if (route === "GET /api/tags") return send(200, { models: [{ name: "qwen3:8b" }] });
      if (route !== "POST /api/chat") return send(404, { error: "not found" });
      state.chats.push(JSON.parse(body));
      send(200, { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(ANSWER) }, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 7 });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** Review-thread node as GitHub's GraphQL returns it. */
const threadNode = (id, path, line, resolved, author, body, head) => ({
  isResolved: resolved,
  isOutdated: false,
  path,
  line,
  startLine: null,
  originalLine: line,
  originalStartLine: null,
  diffSide: "RIGHT",
  comments: { nodes: [{ databaseId: id, author: { login: author, avatarUrl: null }, body, createdAt: "2026-09-03T08:00:00Z", originalCommit: { oid: head } }] },
});

/** feature/export gets a second commit and is pushed; pull request #7 of the mock points at it with one open and one resolved thread. */
function preparePr(repo, forge, { checkout }) {
  repo.git("checkout", "-q", BRANCH);
  const featureHead = repo.git("rev-parse", "HEAD").trim();
  repo.write("src/kopf.py", '"""Kopfzeile der CSV."""\n\nKOPF = "station;wert"\n');
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Kopfzeile ergänzt");
  const head = repo.git("rev-parse", "HEAD").trim();
  // Filesystem push into the forge's bare repository: an HTTP push from this process would block the
  // event loop that serves it (execFileSync). The remote-tracking ref then matches the server.
  repo.git("push", "-q", path.join(forge.git.reposDir, "octo/demo.git"), `HEAD:refs/heads/${BRANCH}`);
  repo.git("update-ref", `refs/remotes/origin/${BRANCH}`, head);
  if (!checkout) repo.git("checkout", "-q", "main");
  forge.mock.state.prOverrides.set(7, { source: BRANCH, head, commits: [{ sha: featureHead, message: TARGET_SUBJECT }, { sha: head, message: "Kopfzeile ergänzt" }] });
  forge.mock.state.reviewThreads.set(7, [
    threadNode(7001, "src/export.py", 5, false, "mira", "Bitte eine Nachkommastelle ausgeben.", head),
    threadNode(7011, "src/kopf.py", 3, true, "jonas", "Passt.", head),
  ]);
  return { featureHead, head };
}

/** Forge, Ollama, repository with pull request #7, launched app with the GitHub account connected. */
async function setUp(t, { lang = "en", ai = AI_ON, checkout = true } = {}) {
  const forge = await startForge();
  const ollama = await startOllama();
  t.cleanups.push(() => forge.close(), () => ollama.close());
  const repo = forge.makeRepo("github");
  const pr = preparePr(repo, forge, { checkout });
  const app = await t.launch({ width: 1440, height: 900, theme: "light", lang, env: { ...forge.appEnv, FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  t.cleanups.push(async () => {
    for (const account of await app.invoke("host_accounts")) await app.invoke("host_disconnect", { accountId: account.id });
  });
  const { repoId, tabId } = await app.openRepo(repo.path);
  await app.invoke("host_connect", { kind: "github", baseUrl: forge.url, token: forge.token });
  if (ai) await app.invoke("settings_set", { patch: ai });
  await app.exec(() => window.__gc.queryClient.invalidateQueries().then(() => true));
  await app.settle();
  return { forge, ollama, repo, repoId, tabId, app, pr };
}

/** Runs a scenario body and always runs the registered cleanups (last first). */
const withCleanup = (fn) => async (t) => {
  t.cleanups = [];
  try {
    await fn(t);
  } finally {
    for (const cleanup of t.cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // best effort
      }
    }
  }
};

async function openPr(app, tabId) {
  await app.exec((id) => window.__gc.store.getState().setCenter(id, { kind: "pr", number: 7 }), tabId);
  await app.waitFor(`${PRV}[data-pr-number="7"] [data-pr-head]`, 30_000, { message: "view of #7" });
  await app.waitFor(THREAD, 20_000, { message: "the open review thread" });
  await app.settle();
}

const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
const content = (app, css) => app.exec((selector) => document.querySelector(selector)?.textContent.replace(/\s+/g, " ").trim() ?? null, css);
const value = (app, css) => app.exec((selector) => document.querySelector(selector)?.value ?? null, css);
const present = (app, css) => app.exec((selector) => Boolean(document.querySelector(selector)), css);
const subject = (repo) => repo.git("log", "-1", "--format=%s").trim();

// ---------------------------------------------------------------------------------------------

scenario("suggest a fix, take it over as fixup, reply and open the autosquash plan", "main", withCleanup(async (t) => {
  const { forge, ollama, repo, repoId, tabId, app } = await setUp(t);
  await openPr(app, tabId);
  const card = await text(app, THREAD);
  assertIncludes(card, "src/export.py");
  assertIncludes(card, "line 5");
  assertIncludes(card, "Bitte eine Nachkommastelle ausgeben.");
  assertIncludes(await text(app, `${SECTION} [data-review-resolved]`), "1 resolved thread is not shown.");
  assert(!(await present(app, `${SECTION} [data-review-thread="7011"]`)), "resolved threads are not listed");

  await app.click(await app.waitFor(`${THREAD} [data-review-fix-suggest]`, 10_000, { message: "Suggest fix" }));
  await app.waitFor(`${THREAD} [data-review-fix]`, 20_000, { message: "the suggestion arrives" });
  const lines = await app.exec((css) => [...document.querySelectorAll(`${css} [data-review-fix-line]`)].map((el) => [el.getAttribute("data-review-fix-line"), el.innerText.replace(/\s+/g, " ").trim()]), THREAD);
  assert(lines.some(([kind, line]) => kind === "removed" && line.includes('return f"{station};{wert}"')), JSON.stringify(lines));
  assert(lines.some(([kind, line]) => kind === "added" && line.includes("{wert:.1f}")), JSON.stringify(lines));
  assertIncludes(await text(app, `${THREAD} [data-review-fix-why]`), "Nachkommastelle");
  const sent = ollama.state.chats[0].messages.map((message) => message.content).join("\n");
  assertIncludes(sent, "Bitte eine Nachkommastelle ausgeben.");
  assertIncludes(sent, '5|     return f"{station};{wert}"');
  assert(!sent.includes("KOPF ="), "only the commented file is sent");
  assertEqual(subject(repo), "Kopfzeile ergänzt", "a suggestion writes nothing");
  await t.shot("review-fix-suggested", app);

  await app.click(await app.waitFor(`${THREAD} [data-review-fix-apply]:not([disabled])`, 10_000, { message: "Take over as fixup" }));
  await until(() => subject(repo) === `fixup! ${TARGET_SUBJECT}`, "the fixup commit", 20_000);
  assertEqual(repo.git("status", "--porcelain").trim(), "", "nothing left over");
  assertIncludes(repo.git("show", "HEAD:src/export.py"), "{wert:.1f}");
  assertEqual((await app.invoke("undo_peek", { repoId })).undo?.label, "Undo 1 fixup commit for #7");
  await app.waitFor(`${SECTION} [data-review-squash]`, 10_000, { message: "squash offer" });
  assertIncludes(await text(app, `${SECTION} [data-review-squash]`), "1 fixup commit – squash now?");

  // The reply is drafted from the fix, editable and only posted on the click.
  await app.click(`${THREAD} [data-review-reply-open]`);
  const field = `${THREAD} [data-review-reply] textarea[name="reply"]`;
  await app.waitFor(field, 5000);
  const sha = repo.git("rev-parse", "--short=7", "HEAD").trim();
  assertEqual(await value(app, field), `Fixed in ${sha}: ${ANSWER.why}`);
  assertEqual(forge.mock.state.replies.length, 0, "nothing is posted by itself");
  await app.type(field, " Danke!");
  await app.click(`${THREAD} [data-review-reply-post]:not([disabled])`);
  await until(() => forge.mock.state.replies.length === 1, "the reply reached the host", 15_000);
  assertEqual(forge.mock.state.replies[0].inReplyTo, 7001);
  assertEqual(forge.mock.state.replies[0].body, `Fixed in ${sha}: ${ANSWER.why} Danke!`);

  await app.click(`${SECTION} [data-review-squash-open]`);
  const rows = '[data-screen="rebase"][data-mode="interactive"] [data-index] [data-action]';
  await app.waitFor(rows, 20_000, { message: "interactive rebase with the plan" });
  const actions = await app.exec((css) => [...document.querySelectorAll(css)].map((el) => el.getAttribute("data-action")), rows);
  assertEqual(actions, ["pick", "fixup", "pick"], "the fixup sits below its commit");
  await t.shot("review-fix-autosquash", app);
  await t.noConsoleErrors(app);
}));

scenario("the branch is checked out first, then the fix goes onto it (German texts)", "edge", withCleanup(async (t) => {
  const { repo, tabId, app } = await setUp(t, { lang: "de", checkout: false });
  await openPr(app, tabId);
  // textContent: the heading is shown in capitals by CSS, innerText would return those.
  assertIncludes(await content(app, SECTION), "Offene Review-Kommentare");
  const suggest = await app.waitFor(`${THREAD} [data-review-fix-suggest]`, 10_000, { message: "Fix vorschlagen" });
  assertEqual((await suggest.text()).trim(), "Fix vorschlagen");
  await app.click(suggest);
  const checkout = await app.waitFor(`${THREAD} [data-review-fix-checkout]`, 20_000, { message: "Branch auschecken" });
  assertEqual((await checkout.text()).trim(), "Branch auschecken");
  assertIncludes(await text(app, `${THREAD} [data-review-fix]`), "„feature/export“");
  assert(!(await present(app, `${THREAD} [data-review-fix-apply]`)), "no takeover onto another branch");
  await app.click(checkout);
  await until(() => repo.git("symbolic-ref", "--short", "HEAD").trim() === BRANCH, "checked out", 20_000);
  const apply = await app.waitFor(`${THREAD} [data-review-fix-apply]:not([disabled])`, 10_000, { message: "Als fixup übernehmen" });
  assertEqual((await apply.text()).trim(), "Als fixup übernehmen");
  await app.click(apply);
  await until(() => subject(repo) === `fixup! ${TARGET_SUBJECT}`, "the fixup commit", 20_000);
  await app.waitFor(`${SECTION} [data-review-squash]`, 10_000, { message: "Hinweis zum Zusammenfassen" });
  assertIncludes(await text(app, `${SECTION} [data-review-squash]`), "1 fixup-Commit – jetzt zusammenfassen?");
  await t.shot("review-fix-checkout-de", app);
  await t.noConsoleErrors(app);
}));

scenario("without AI the threads stay readable, Suggest fix is hidden and a reply still goes out", "edge", withCleanup(async (t) => {
  const { forge, ollama, tabId, app } = await setUp(t, { ai: null });
  await openPr(app, tabId);
  assert(!(await present(app, `${THREAD} [data-review-fix-suggest]`)), "no AI button while AI is not set up");
  assert(!(await present(app, `${THREAD} [data-review-what-is-sent]`)), "no preview link either");
  await app.click(`${THREAD} [data-review-reply-open]`);
  const field = `${THREAD} [data-review-reply] textarea[name="reply"]`;
  await app.waitFor(field, 5000);
  assertEqual(await value(app, field), "", "nothing is drafted without a suggestion");
  await app.type(field, "Danke, erledige ich.");
  await app.click(`${THREAD} [data-review-reply-post]:not([disabled])`);
  await until(() => forge.mock.state.replies.length === 1, "the reply reached the host", 15_000);
  assertEqual(forge.mock.state.replies[0], { id: 8000, number: 7, inReplyTo: 7001, body: "Danke, erledige ich." });
  assertEqual(ollama.state.chats.length, 0, "nothing went to the AI");
  await t.noConsoleErrors(app);
}));
