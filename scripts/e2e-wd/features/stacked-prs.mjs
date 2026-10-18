/**
 * Stacked pull requests (v1.2, Paket 8.1) in the real app. Host: the local forge (scripts/e2e/host-mock.mjs
 * + Git over HTTP, see fixtures/github-gitlab-host.mjs); AI: a Node stand-in for Ollama behind
 * FORKYARD_AI_BASE_URL_OLLAMA (debug builds only). Nothing reaches a real service.
 *
 * - main: the AI suggests two parts, "Create branches" makes them without a checkout, "Push all parts"
 *   pushes both (after "Push anyway" in the key check, which stops at the .env file's password),
 *   "Create pull requests" opens one into main and one into part 1 – the .env file is never sent;
 * - edge: without AI there is no "Suggest parts"; Space cuts and joins, Ctrl+Z removes both branches;
 * - edge: with AI switched off, "Check each part" runs the test command in temporary worktrees – part 1
 *   fails, part 2 passes, no worktree is left behind; AI on without a provider shows only "Suggest parts";
 * - edge: a new commit on part 1 offers „Nachziehen“ (German texts), which rebases part 2 onto it.
 *
 *   node scripts/e2e-wd/features/stacked-prs.mjs
 *   E2E_WD_ONLY=check node scripts/e2e-wd/features/stacked-prs.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { startForge } from "../fixtures/github-gitlab-host.mjs";
import { until } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const VIEW = '[data-screen="stack"]';
const BRANCH = "thema/auswertung";
const P1 = "thema/auswertung-1-datenmodell";
const P2 = "thema/auswertung-2-auswertung";
/** The names Forkyard derives from the first commit subjects when no name is typed. */
const AUTO1 = "thema/auswertung-1-datenmodell-fuer";
const AUTO2 = "thema/auswertung-2-auswertung-je-monat";
const AI_ON = { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" };
const SPLIT = {
  parts: [
    { end: 1, name: "Datenmodell", title: "Datenmodell für Stationen", why: "Das Modell steht für sich." },
    { end: 3, name: "Auswertung", title: "Auswertung je Monat", why: "Baut auf dem Modell auf." },
  ],
};

/** Local stand-in for Ollama: records the chat requests and answers them in turn (the last answer repeats). */
async function startOllama() {
  const state = { answers: [SPLIT], chats: [] };
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
      const answer = state.answers[Math.min(state.chats.length - 1, state.answers.length - 1)];
      send(200, { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(answer) }, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 7 });
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

/** `thema/auswertung` with three commits (the second adds ok.txt and a .env file), checked out, clean. */
function topicBranch(repo) {
  repo.git("checkout", "-q", "-b", BRANCH, "main");
  repo.write("src/modell.py", "class Station:\n    pass\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Datenmodell für Stationen");
  repo.write("auswertung.py", "def monatsmittel(werte):\n    return sum(werte) / len(werte)\n");
  repo.write("ok.txt", "ok\n");
  repo.write(".env", "DB_PASSWORD=hunter2-sehr-geheim\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Auswertung je Monat");
  repo.write("diagramme.md", "# Diagramme\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Diagramme");
}

/** Forge, Ollama, repository with the topic branch, launched app with the GitHub account connected. */
async function setUp(t, { lang = "en", ai = AI_ON } = {}) {
  const forge = await startForge();
  const ollama = await startOllama();
  t.cleanups.push(() => forge.close(), () => ollama.close());
  const repo = forge.makeRepo("github");
  topicBranch(repo);
  const app = await t.launch({ width: 1440, height: 900, theme: "light", lang, env: { ...forge.appEnv, FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  t.cleanups.push(async () => {
    for (const account of await app.invoke("host_accounts")) await app.invoke("host_disconnect", { accountId: account.id });
  });
  const { repoId } = await app.openRepo(repo.path);
  await app.invoke("host_connect", { kind: "github", baseUrl: forge.url, token: forge.token });
  if (ai) await app.invoke("settings_set", { patch: ai });
  await app.exec(() => window.__gc.queryClient.invalidateQueries().then(() => true));
  await app.settle();
  return { forge, ollama, repo, repoId, app };
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

const present = (app, css) => app.exec((selector) => Boolean(document.querySelector(selector)), css);
const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
const branchNames = (app) => app.exec((selector) => [...document.querySelectorAll(`${selector} [data-stack-branch]`)].map((el) => el.innerText.trim()), VIEW);
const gitOk = (repo, ...args) => {
  try {
    repo.git(...args);
    return true;
  } catch {
    return false;
  }
};
const sha = (repo, rev) => String(repo.git("rev-parse", rev)).trim();

/** The stack view of the checked-out branch, through the palette; `query` is in the UI language. */
async function openStack(app, query = ">stacked pull requests") {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, query);
  await app.click(await app.waitFor('[data-screen="command-palette"] [role="option"][data-key="command:pr.stack"]', 10_000, { message: "palette entry pr.stack" }));
  await app.waitFor(`${VIEW} [data-stack-list]`, 30_000, { message: "the commits of the branch" });
}

/** Clicks a footer button of the open dialog by its text. */
async function dialogButton(app, label) {
  const button = await app.waitFor(
    () =>
      app.exec((wanted) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
        return [...(dialog?.querySelectorAll("footer button") ?? [])].find((el) => el.innerText.trim() === wanted && !el.disabled) ?? null;
      }, label),
    8000,
    { message: `dialog button “${label}”` },
  );
  await button.click();
}

// ---------------------------------------------------------------------------------------------

scenario("the ai suggests the parts; create, push and open the stacked pull requests", "main", withCleanup(async (t) => {
  const { forge, ollama, repo, app } = await setUp(t);
  await openStack(app);
  assertEqual(await branchNames(app), [AUTO1], "one part before cutting, named after the first commit");
  await app.click(await app.waitFor(`${VIEW} [data-stack-suggest]:not([disabled])`, 15_000, { message: "Suggest parts" }));
  await until(async () => (await branchNames(app)).length === 2, "two parts suggested", 20_000);
  assertEqual(await branchNames(app), [P1, P2]);
  assert(await present(app, `${VIEW} [data-stack-suggested]`), "marked as a suggestion");
  const sent = ollama.state.chats[0].messages.map((message) => message.content).join("\n");
  assertIncludes(sent, "1. Datenmodell für Stationen");
  assertIncludes(sent, "3. Diagramme");
  assert(!sent.includes("hunter2") && !sent.includes(".env"), "the .env file is never sent, not even by name");
  await t.shot("stack-suggested", app);

  const head = sha(repo, "HEAD");
  await app.click(await app.waitFor(`${VIEW} [data-stack-create]:not([disabled])`, 10_000));
  await app.waitFor(`${VIEW} [data-stack-existing]`, 15_000, { message: "the existing stack" });
  assertEqual(sha(repo, P1), sha(repo, `${BRANCH}~2`), "part 1 at commit 1");
  assertEqual(sha(repo, P2), sha(repo, BRANCH), "part 2 at the tip");
  assertEqual(String(repo.git("symbolic-ref", "--short", "HEAD")).trim(), BRANCH, "nothing was checked out");
  assertEqual(sha(repo, "HEAD"), head);

  await app.click(await app.waitFor(`${VIEW} [data-stack-push]`, 5000));
  await dialogButton(app, "Push");
  // The .env file of part 2 holds a password: the secret scan stops the stack push like every push.
  const dialogText = () => app.exec(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop()?.innerText ?? "");
  await until(async () => /looks like a key/.test(await dialogText()), "the key check stops the stack push", 20_000);
  const shown = await dialogText();
  assertIncludes(shown, ".env:1", "file:line of the finding");
  assert(!shown.includes("hunter2-sehr-geheim"), "the value itself is never shown");
  assertEqual(forge.bareBranch("github", P1), null, "nothing was pushed before “Push anyway”");
  await t.shot("stack-push-key-check", app);
  await dialogButton(app, "Push anyway");
  await until(() => forge.bareBranch("github", P2) !== null, "part 2 on the server", 20_000);
  assertEqual(String(forge.bareBranch("github", P1)).trim(), sha(repo, P1));
  assertEqual(String(forge.bareBranch("github", P2)).trim(), sha(repo, P2));

  await app.click(await app.waitFor(`${VIEW} [data-stack-prs]:not([disabled])`, 20_000, { message: "pull requests possible after the push" }));
  await dialogButton(app, "Create pull requests");
  await until(() => forge.mock.state.created.length === 2, "two pull requests created", 15_000);
  assertEqual(
    forge.mock.state.created.map((pr) => [pr.source, pr.target, pr.title]),
    [
      [P1, "main", "Datenmodell für Stationen"],
      [P2, P1, "Auswertung je Monat"],
    ],
    "each pull request targets the part below it",
  );
  await t.shot("stack-pull-requests", app);
  await t.noConsoleErrors(app);
}));

scenario("without ai: space cuts and joins, create, one ctrl+z removes both branches", "edge", withCleanup(async (t) => {
  const { repo, app } = await setUp(t, { ai: null });
  await openStack(app);
  assert(!(await present(app, `${VIEW} [data-stack-suggest]`)), "no AI button while AI is not set up");
  await app.click(await app.waitFor(`${VIEW} [data-commit="1"]`, 5000));
  await app.press("Space");
  await until(async () => (await branchNames(app)).length === 2, "split after commit 1");
  assertEqual(await branchNames(app), [AUTO1, AUTO2], "names from the first commit subjects");
  await app.press("ArrowDown", "Space");
  await until(async () => (await branchNames(app)).length === 3, "split after commit 2 as well");
  await app.press("Space");
  await until(async () => (await branchNames(app)).length === 2, "space again joins the parts");
  await app.click(await app.waitFor(`${VIEW} [data-stack-create]:not([disabled])`, 10_000));
  await app.waitFor(`${VIEW} [data-stack-existing]`, 15_000);
  assert(gitOk(repo, "rev-parse", "--verify", "-q", AUTO1) && gitOk(repo, "rev-parse", "--verify", "-q", AUTO2), "both branches exist");

  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+z");
  await until(() => !gitOk(repo, "rev-parse", "--verify", "-q", AUTO1) && !gitOk(repo, "rev-parse", "--verify", "-q", AUTO2), "undo removed both branches", 15_000);
  await app.waitFor(`${VIEW} [data-stack-gone]`, 10_000, { message: "the view says the stack is gone" });
  await t.noConsoleErrors(app);
}));

scenario("check each part runs the test command in temporary worktrees", "edge", withCleanup(async (t) => {
  // AI explicitly switched off: no AI element, splitting and checking work all the same.
  const { repo, repoId, app } = await setUp(t, { ai: { aiEnabled: false } });
  await app.invoke("repo_settings_set", { repoId, patch: { testCommand: "test -f ok.txt" } });
  await app.exec(() => window.__gc.queryClient.invalidateQueries().then(() => true));
  await openStack(app);
  assert(!(await present(app, `${VIEW} [data-stack-suggest]`)) && !(await present(app, `${VIEW} [data-stack-what-is-sent]`)), "no AI element while AI is switched off");
  await app.click(await app.waitFor(`${VIEW} [data-commit="1"]`, 5000));
  await app.press("Space");
  await until(async () => (await branchNames(app)).length === 2, "two parts");
  await app.click(await app.waitFor(`${VIEW} [data-stack-check]:not([disabled])`, 10_000, { message: "Check each part" }));
  await app.waitFor(`${VIEW} [data-stack-part="2"] [data-stack-check-state="passed"]`, 60_000, { message: "part 2 passed" });
  const first = await text(app, `${VIEW} [data-stack-part="1"] [data-stack-check-state]`);
  assert(await present(app, `${VIEW} [data-stack-part="1"] [data-stack-check-state="failed"]`), `part 1 failed: ${first}`);
  assertIncludes(first, "failed");
  assertIncludes(first, "exit code 1");
  const agents = `${repo.path}.agents`;
  assert(!fs.existsSync(path.join(agents, "stack-check-1")) && !fs.existsSync(path.join(agents, "stack-check-2")), "temporary worktrees removed");
  const worktrees = String(repo.git("worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree "));
  assertEqual(worktrees.length, 1, "only the main worktree is left");
  await t.shot("stack-checks", app);

  // AI on but no provider connected: "Suggest parts" appears (a click opens the setup), "What is sent?" does not.
  await app.invoke("settings_set", { patch: { aiEnabled: true } });
  await app.exec(() => window.__gc.queryClient.invalidateQueries().then(() => true));
  await app.waitFor(`${VIEW} [data-stack-suggest]`, 10_000, { message: "Suggest parts while AI is on without a provider" });
  assert(!(await present(app, `${VIEW} [data-stack-what-is-sent]`)), "no preview link before a provider is connected");
  await t.noConsoleErrors(app);
}));

scenario("a new commit on part 1 offers nachziehen in german and restacks part 2", "edge", withCleanup(async (t) => {
  const { repo, app } = await setUp(t, { ai: null, lang: "de" });
  await openStack(app, ">gestapelte PRs");
  await app.click(await app.waitFor(`${VIEW} [data-commit="1"]`, 5000));
  await app.press("Space");
  await until(async () => (await branchNames(app)).length === 2, "zwei Teile");
  const create = await app.waitFor(`${VIEW} [data-stack-create]:not([disabled])`, 10_000);
  assertEqual((await create.text()).trim(), "Branches anlegen");
  await app.click(create);
  await app.waitFor(`${VIEW} [data-stack-up-to-date]`, 15_000, { message: "der Stapel ist aktuell" });

  repo.git("checkout", "-q", AUTO1);
  repo.write("src/notiz.md", "Nachtrag\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Nachtrag zum Datenmodell");
  await app.waitFor(`${VIEW} [data-stack-restack-needed]`, 20_000, { message: "Nachziehen angeboten" });
  assertIncludes(await text(app, `${VIEW} [data-stack-restack-needed]`), "Teil 2 enthält den Teil darunter nicht mehr.");
  const restack = await app.waitFor(`${VIEW} [data-stack-restack]`, 5000);
  assertEqual((await restack.text()).trim(), "Nachziehen");
  await t.shot("stack-restack-de", app);
  await app.click(restack);
  await until(() => gitOk(repo, "merge-base", "--is-ancestor", AUTO1, AUTO2), "Teil 2 baut auf dem neuen Teil 1 auf", 20_000);
  await app.waitFor(`${VIEW} [data-stack-up-to-date]`, 15_000, { message: "wieder aktuell" });
  await t.noConsoleErrors(app);
}));
