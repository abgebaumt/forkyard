/**
 * "Write from commits" in the pull request form (v1.2, Paket 4) in the real app. Host: the local forge
 * (scripts/e2e/host-mock.mjs + Git over HTTP, see fixtures/github-gitlab-host.mjs); AI: a Node stand-in
 * for Ollama behind FORKYARD_AI_BASE_URL_OLLAMA (debug builds only). Nothing reaches a real service.
 *
 * - main: the template is filled from the commits, the automatic title is replaced, "Closes #12" comes
 *   from the commits, the .env file is never sent, Ctrl+Z in the field brings the template back;
 * - edge: own title and own text stay – "Replace title?" and Replace / Append / Discard;
 * - edge: visibility – AI not set up, explicitly off, AI off for the repository, the function switched off;
 * - edge: an unusable answer twice shows „Antwort unbrauchbar“ with „Nochmal“ (German texts);
 * - edge: cancelling drops the answer that arrives later.
 *
 *   node scripts/e2e-wd/features/ai-pr-description.mjs
 *   E2E_WD_ONLY=cancel node scripts/e2e-wd/features/ai-pr-description.mjs
 */
import http from "node:http";
import { startForge } from "../fixtures/github-gitlab-host.mjs";
import { eventually, until } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const PRC = '[data-screen="pr-create"]';
const BODY = `${PRC} textarea[name="body"]`;
const TITLE = `${PRC} input[name="title"]`;
const WRITE = `${PRC} [data-pr-ai-write]`;
const BRANCH = "thema/auswertung";
const TEMPLATE = "## Was ändert sich?\n\n<!-- Kurz beschreiben -->\n\n## Wie getestet?\n\n- [ ] Tests laufen\n";
const FILLED = "## Was ändert sich?\n\n<!-- Kurz beschreiben -->\nDie Auswertung je Station steht in einem eigenen Dokument; Umlaute werden richtig sortiert.\n\n## Wie getestet?\n\n- [ ] Tests laufen\n";
const AI_TITLE = "Auswertung je Station als eigenes Dokument";
const ANSWER = { title: AI_TITLE, body: FILLED };
const AI_ON = { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Local stand-in for Ollama: records the chat requests and answers them in turn (the last answer repeats). */
async function startOllama() {
  const state = { answers: [ANSWER], delayMs: 0, chats: [], replied: 0 };
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
      const reply = () => {
        state.replied += 1;
        send(200, { model: "qwen3:8b", message: { role: "assistant", content: typeof answer === "string" ? answer : JSON.stringify(answer) }, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 7 });
      };
      if (state.delayMs) setTimeout(reply, state.delayMs);
      else reply();
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

/** A local topic branch with two commits (one names issue #12, one adds a .env file), checked out; the template lies in the working directory. */
function topicBranch(repo) {
  repo.git("checkout", "-q", "-b", BRANCH, "main");
  repo.write("auswertung.md", "# Auswertung\n\nMonatsmittel je Station.\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Auswertung je Station");
  repo.write("sortierung.py", "def schluessel(name):\n    return name.casefold()\n");
  repo.write(".env", "DB_PASSWORD=hunter2-sehr-geheim\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Umlaute richtig sortieren (#12)");
  repo.write(".github/pull_request_template.md", TEMPLATE);
}

/** Forge, Ollama, repository with topic branch, launched app with the GitHub account connected. */
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

/** Opens the form through the palette; `query` is the command's title in the UI language. */
async function openCreateForm(app, query = "Create pull request") {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${query}`);
  await app.click(await app.waitFor('[data-screen="command-palette"] [role="option"][data-key="command:pr.create"]', 10_000, { message: "palette entry pr.create" }));
  await app.waitFor(`${PRC} form[data-pr-state="form"]`, 30_000, { message: "pull request form" });
}

const value = (app, css) => app.exec((selector) => document.querySelector(selector)?.value ?? null, css);
const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
const present = (app, css) => app.exec((selector) => Boolean(document.querySelector(selector)), css);

/** A settings command through the core; `repo_settings_set` emits no event for `aiOff`, so the UI's queries are refreshed. */
async function setThrough(app, command, args) {
  await app.invoke(command, args);
  await app.exec(() => window.__gc.queryClient.invalidateQueries().then(() => true));
  await app.settle();
}

/** Empties a field with the keyboard. */
async function clearField(app, css) {
  await app.exec((selector) => document.querySelector(selector).focus() ?? true, css);
  await app.press("Control+a", "Backspace");
}

/** Clicks the button with this text inside `scope`. */
async function press(app, label, scope) {
  const button = await app.waitFor(
    () => app.exec((wanted, css) => [...document.querySelectorAll(`${css} button`)].find((el) => el.innerText.trim() === wanted) ?? null, label, scope),
    10_000,
    { message: `button "${label}" in ${scope}` },
  );
  await app.click(button);
}

// ---------------------------------------------------------------------------------------------

scenario("write from commits fills the template, replaces the automatic title and closes #12", "main", withCleanup(async (t) => {
  const { forge, ollama, app } = await setUp(t);
  await openCreateForm(app);
  await eventually(() => value(app, TITLE), "Auswertung", "automatic title from the branch name (two commits)");
  await eventually(() => value(app, BODY), TEMPLATE, "description prefilled with the template");

  await app.click(await app.waitFor(`${WRITE}:not([disabled])`, 15_000, { message: "Write from commits" }));
  await until(async () => (await value(app, BODY))?.includes("Die Auswertung je Station"), "the filled template arrives", 20_000);
  assertEqual(await value(app, BODY), `${FILLED.trimEnd()}\n\nCloses #12`, "template filled, headings kept, Closes #12 from the commit");
  assertEqual(await value(app, TITLE), AI_TITLE, "the automatic title is replaced");
  assertIncludes(await text(app, "#s23-body-hint"), "Draft from the commits");
  await t.shot("pr-description-filled", app);

  const sent = ollama.state.chats[0].messages.map((message) => message.content).join("\n");
  assertIncludes(sent, "Auswertung je Station");
  assertIncludes(sent, "Umlaute richtig sortieren (#12)");
  assertIncludes(sent, "## Pull request template");
  assert(!sent.includes("hunter2") && !sent.includes(".env"), "the .env file is never sent, not even by name");
  assertEqual(ollama.state.chats.length, 1);
  assertEqual(forge.mock.state.created, [], "nothing was created at the host");

  await app.exec((css) => document.querySelector(css).focus() ?? true, BODY);
  await app.press("Control+z");
  await eventually(() => value(app, BODY), TEMPLATE, "Ctrl+Z takes the insertion back");
  await t.noConsoleErrors(app);
}));

scenario("own title and own text stay: replace title? and replace / append / discard", "edge", withCleanup(async (t) => {
  const { app } = await setUp(t);
  await openCreateForm(app);
  await eventually(() => value(app, BODY), TEMPLATE, "template");
  await clearField(app, TITLE);
  await app.type(TITLE, "Meine Überschrift");
  await clearField(app, BODY);
  await app.type(BODY, "Eigener Text");
  await app.click(await app.waitFor(`${WRITE}:not([disabled])`, 15_000));
  await app.waitFor(`${PRC} [data-pr-ai-body-offer="choose"]`, 20_000, { message: "description offer" });
  await app.waitFor(`${PRC} [data-pr-ai-title-offer]`, 5000, { message: "Replace title?" });
  assertEqual(await value(app, TITLE), "Meine Überschrift", "own title untouched");
  assertEqual(await value(app, BODY), "Eigener Text", "own text untouched");
  assertIncludes(await text(app, `${PRC} [data-pr-ai-title-offer]`), AI_TITLE);
  await t.shot("pr-description-offers", app);

  await press(app, "Keep", `${PRC} [data-pr-ai-title-offer]`);
  await until(async () => !(await present(app, `${PRC} [data-pr-ai-title-offer]`)), "title offer closed");
  assertEqual(await value(app, TITLE), "Meine Überschrift");
  await press(app, "Append", `${PRC} [data-pr-ai-body-offer]`);
  await eventually(() => value(app, BODY), `Eigener Text\n\n${FILLED.trimEnd()}\n\nCloses #12`, "appended after a blank line");
  await t.noConsoleErrors(app);
}));

scenario("visibility: not set up, off, ai off for the repository, function off", "edge", withCleanup(async (t) => {
  const { app, repoId } = await setUp(t, { ai: null });
  await openCreateForm(app);
  await eventually(() => value(app, BODY), TEMPLATE, "form ready");
  assert(!(await present(app, WRITE)), "AI not set up (unset): no button");
  await setThrough(app, "settings_set", { patch: AI_ON });
  await app.waitFor(WRITE, 10_000, { message: "button after connecting the provider" });
  await setThrough(app, "repo_settings_set", { repoId, patch: { aiOff: true } });
  await until(async () => !(await present(app, WRITE)), "hidden while AI is off for this repository");
  await setThrough(app, "repo_settings_set", { repoId, patch: { aiOff: false } });
  await app.waitFor(WRITE, 10_000, { message: "back again" });
  await setThrough(app, "settings_set", { patch: { aiFeaturesOff: ["pr_description"] } });
  await until(async () => !(await present(app, WRITE)), "hidden while the function is off");
  await setThrough(app, "settings_set", { patch: { aiFeaturesOff: [] } });
  await app.waitFor(WRITE, 10_000, { message: "function on again" });
  await setThrough(app, "settings_set", { patch: { aiEnabled: false } });
  await until(async () => !(await present(app, `${PRC} [data-pr-ai]`)), "explicitly off: nothing of the AI is left in the form");
  assert(!(await present(app, `${PRC} [data-pr-ai-notices]`)), "no status line either");
  await t.noConsoleErrors(app);
}));

scenario("an unusable answer twice shows the state in german and changes nothing", "edge", withCleanup(async (t) => {
  const { ollama, app } = await setUp(t, { lang: "de" });
  ollama.state.answers = ["Klar! Hier ist dein Text: Auswertung"];
  await openCreateForm(app, "Pull Request anlegen");
  await eventually(() => value(app, BODY), TEMPLATE, "Vorlage");
  const write = await app.waitFor(`${WRITE}:not([disabled])`, 15_000);
  assertEqual(await text(app, WRITE), "Aus Commits schreiben");
  await app.click(write);
  await app.waitFor(`${PRC} [data-pr-ai-error="invalid"]`, 20_000, { message: "Antwort unbrauchbar" });
  assertIncludes(await text(app, `${PRC} [data-pr-ai-error]`), "Antwort unbrauchbar");
  assertIncludes(await text(app, `${PRC} [data-pr-ai-error]`), "Nochmal");
  assertIncludes(await text(app, `${PRC} [data-pr-ai-error]`), "Gesendetes ansehen");
  assertEqual(ollama.state.chats.length, 2, "exactly one repair attempt");
  assertEqual(await value(app, BODY), TEMPLATE, "description unchanged");
  assertEqual(await value(app, TITLE), "Auswertung", "title unchanged");
  await t.shot("pr-description-invalid-de", app);
  await t.noConsoleErrors(app);
}));

scenario("cancel drops the answer that arrives later", "edge", withCleanup(async (t) => {
  const { ollama, app } = await setUp(t);
  ollama.state.delayMs = 6000;
  await openCreateForm(app);
  await eventually(() => value(app, BODY), TEMPLATE, "template");
  await app.click(await app.waitFor(`${WRITE}:not([disabled])`, 15_000));
  const cancel = await app.waitFor(`${PRC} [data-pr-ai-cancel]`, 10_000, { message: "the button becomes Cancel" });
  assertIncludes(await text(app, `${PRC} [data-pr-ai-status]`), "Writing");
  await until(() => ollama.state.chats.length === 1, "the request reached the provider");
  await app.click(cancel);
  await app.waitFor(WRITE, 5000, { message: "back to Write from commits" });
  await until(() => ollama.state.replied === 1, "the provider answered after the cancel", 15_000);
  await sleep(300);
  await app.settle();
  assertEqual(await value(app, BODY), TEMPLATE, "the late answer is dropped");
  assertEqual(await value(app, TITLE), "Auswertung");
  assert(!(await present(app, `${PRC} [data-pr-ai-body-offer]`)), "not even offered");
  await t.noConsoleErrors(app);
}));
