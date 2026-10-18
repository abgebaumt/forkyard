/**
 * Search by meaning in the real app (v1.2, Teilpaket 9.2), against a Node stand-in for Ollama behind
 * FORKYARD_AI_BASE_URL_OLLAMA (debug builds only). The fake "meaning" of a text is how often words of
 * three families occur in it – the expected order follows from the fixture's commit texts, not from
 * the app's code.
 *
 * - main: a local embedder finds the CSV export by its meaning; typing alone sends nothing; Enter jumps;
 * - edge: the Text | Meaning switch exists only while AI is on and not off for the repository;
 * - edge: without embeddings the model rephrases the question and ranks – the hit carries its reason;
 * - edge: German texts;
 * - edge: Settings › AI shows the index of the open repository, "Delete index" empties it.
 *
 *   node scripts/e2e-wd/features/ai-semantic-search.mjs
 *   E2E_WD_ONLY="rephras" node scripts/e2e-wd/features/ai-semantic-search.mjs
 */
import http from "node:http";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { eventually } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const SEARCH = '[data-screen="commit-search"]';
const SETTINGS = '[data-screen="settings"]';
const MEANINGS = [
  ["export", "csv", "ausgabe", "tabelle"],
  ["station", "messnetz"],
  ["vergleich", "mittel", "differenz"],
];
const LOCAL_EMBEDDER = { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b", aiSearchEmbedProvider: "ollama", aiSearchEmbedModel: "embeddinggemma" };
const REPHRASING = { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b", aiSearchEmbedProvider: null, aiSearchEmbedModel: null };

const fakeVector = (text) => {
  const lower = text.toLowerCase();
  return [...MEANINGS.map((words) => words.reduce((sum, word) => sum + lower.split(word).length - 1, 0)), 0.1];
};

/** `[n] <sha7> · … ` and the subject below it, as the ranking request lists the candidates. */
function listed(user) {
  const lines = user.split("\n");
  return lines.flatMap((line, n) => {
    const match = /^\[(\d+)\] ([0-9a-f]{7}) · /.exec(line);
    return match ? [{ id: Number(match[1]), sha7: match[2], subject: lines[n + 1] ?? "" }] : [];
  });
}

/** Local stand-in for Ollama: models, context size, embeddings, and chat answers for rephrasing and ranking. */
async function startOllama({ plan = null, rank = () => ({ hits: [] }) } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      requests.push({ method: req.method, url: req.url, json });
      const route = `${req.method} ${req.url}`;
      let answer = null;
      if (route === "GET /api/tags") answer = { models: [{ name: "qwen3:8b" }, { name: "embeddinggemma" }] };
      else if (route === "POST /api/show") answer = { model_info: { "qwen3.context_length": 40960 } };
      else if (route === "POST /api/embed") answer = { model: json.model, embeddings: json.input.map(fakeVector) };
      else if (route === "POST /api/chat") {
        const content = json.format?.properties?.terms ? JSON.stringify(plan) : JSON.stringify(rank(listed(json.messages[1].content)));
        answer = { model: json.model, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 30, eval_count: 8 };
      }
      const text = JSON.stringify(answer ?? { error: "not found" });
      res.writeHead(answer ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

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

const selection = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.selection ?? { kind: "wip" }, tabId);
const hitShas = (app) => app.exec((css) => [...document.querySelectorAll(`${css} [role="listbox"] [data-sha]`)].map((row) => row.dataset.sha), SEARCH);
const switchShown = (app) => app.exec((css) => Boolean(document.querySelector(`${css} [data-search-mode]`)), SEARCH);

async function openRepoAndSearch(app, repo) {
  const ids = await app.openRepo(repo.path);
  await app.waitFor('[data-screen="commit-graph"][data-state="ready"]', 30_000, { message: "graph" });
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+f");
  await app.waitFor(`${SEARCH} input`, 5000, { message: "search field" });
  return ids;
}

async function chooseMeaning(app) {
  await app.click(await app.waitFor(`${SEARCH} [data-search-mode] [data-value="meaning"]`, 10_000, { message: "Text | Meaning switch" }));
  return app.waitFor(`${SEARCH}[data-mode="meaning"] input`, 5000, { message: "meaning field" });
}

async function searchByMeaning(app, question, minimum = 1) {
  const input = await chooseMeaning(app);
  await app.type(input, question);
  await app.press("Enter");
  return app.waitFor(
    async () => {
      const found = await hitShas(app);
      return found.length >= minimum ? found : null;
    },
    30_000,
    { message: `at least ${minimum} hits by meaning` },
  );
}

const activeTabLabel = (app) => app.exec((css) => document.querySelector(`${css} [role="tab"][data-state="active"] span`)?.textContent.trim() ?? null, SETTINGS);

async function openSettingsAt(app, label) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+,");
  await app.waitFor(SETTINGS, 10_000, { message: "settings dialog" });
  const tab = await app.waitFor(
    () => app.exec((css, wanted) => [...document.querySelectorAll(`${css} [role="tab"]`)].find((el) => el.querySelector("span")?.textContent.trim() === wanted) ?? null, SETTINGS, label),
    10_000,
    { message: `settings section ${label}` },
  );
  await app.click(tab);
  await eventually(() => activeTabLabel(app), label, `section ${label} active`);
  await app.settle();
}

// ---------------------------------------------------------------------------------------------

scenario("meaning: a local embedder finds the CSV export by what it is about, Enter jumps to it", "main", withCleanup(async (t) => {
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: LOCAL_EMBEDDER });
  const { tabId } = await openRepoAndSearch(app, repo);

  const input = await chooseMeaning(app);
  await app.type(input, "Ausgabe als Tabellendatei");
  await app.settle(500);
  assert(!ollama.requests.some((request) => request.url === "/api/embed"), "typing alone sends nothing");
  await app.press("Enter");
  const hits = await app.waitFor(
    async () => {
      const found = await hitShas(app);
      return found.length >= 2 ? found : null;
    },
    30_000,
    { message: "hits by meaning" },
  );
  const stations = repo.git("log", "--branches", "--format=%H", "--fixed-strings", "--grep=Liste der Stationen").trim();
  assertEqual(hits.slice(0, 2), [repo.info.featureHead, stations], "export and CSV words first: the export, then the CSV list");
  const reason = await app.exec((css) => document.querySelector(`${css} [role="option"] [data-reason]`)?.textContent ?? "", SEARCH);
  assertIncludes(reason, "Similar in meaning");
  assert(!ollama.requests.some((request) => request.url === "/api/chat"), "embeddings need no chat request");
  const embedded = ollama.requests.filter((request) => request.url === "/api/embed").flatMap((request) => request.json.input);
  assert(embedded.includes("CSV-Export für den Vergleich\nFiles: src/export.py"), "the index text of the export commit");
  await t.shot("meaning-hits");

  await app.press("Enter");
  await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === repo.info.featureHead, 5000, { message: "Enter selects the first hit" });
  await t.noConsoleErrors(app);
}));

scenario("the Text | Meaning switch exists only while AI is on and not off for the repository", "edge", withCleanup(async (t) => {
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  const { repoId } = await openRepoAndSearch(app, repo);
  assert(!(await switchShown(app)), "AI not set up: text search only");
  await app.invoke("settings_set", { patch: LOCAL_EMBEDDER });
  await app.waitFor(() => switchShown(app), 10_000, { message: "switch appears once AI is on" });
  await app.invoke("repo_settings_set", { repoId, patch: { aiOff: true } });
  await app.exec(() => window.__gc.queryClient.invalidateQueries());
  await app.waitFor(async () => !(await switchShown(app)), 10_000, { message: "switch hidden with “AI off for this repository”" });
  assert(!ollama.requests.some((request) => request.url === "/api/embed" || request.url === "/api/chat"), "nothing was sent");
  await t.noConsoleErrors(app);
}));

scenario("rephrasing without embeddings: the model's search and order, the hit with its reason", "edge", withCleanup(async (t) => {
  const plan = { terms: ["export"], code: null, paths: [], author: null, since: null, until: null };
  const ollama = await startOllama({
    plan,
    rank: (candidates) => ({ hits: candidates.filter((c) => c.subject === "CSV-Export für den Vergleich").map((c) => ({ id: c.id, reason: "Schreibt den Vergleich als CSV." })) }),
  });
  t.cleanups.push(() => ollama.close());
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: REPHRASING });
  await openRepoAndSearch(app, repo);
  const hits = await searchByMeaning(app, "Wo exportieren wir die Werte?");
  assertEqual(hits, [repo.info.featureHead], "the commit Git finds for “export”, kept by the model");
  const reason = await app.exec((css) => document.querySelector(`${css} [data-reason]`)?.textContent ?? "", SEARCH);
  assertEqual(reason, "Schreibt den Vergleich als CSV.");
  assertIncludes(await app.exec((css) => document.querySelector(`${css} [data-searched-for]`)?.textContent ?? "", SEARCH), "“export”");
  const chats = ollama.requests.filter((request) => request.url === "/api/chat");
  assertEqual(chats.length, 2, "rephrasing, then ranking");
  assert(!ollama.requests.some((request) => request.url === "/api/embed"), "no embeddings on this way");
  await t.shot("meaning-rephrased");
  await t.noConsoleErrors(app);
}));

scenario("German texts", "edge", withCleanup(async (t) => {
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  const app = await t.launch({ ...LAUNCH, lang: "de", env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: LOCAL_EMBEDDER });
  await openRepoAndSearch(app, repo);
  const labels = await app.waitFor(
    () => app.exec((css) => {
      const items = [...document.querySelectorAll(`${css} [data-search-mode] [data-value]`)].map((item) => item.textContent.trim());
      return items.length === 2 ? items : null;
    }, SEARCH),
    10_000,
    { message: "switch" },
  );
  assertEqual(labels, ["Text", "Bedeutung"]);
  await chooseMeaning(app);
  const hint = await app.waitFor(() => app.exec((css) => document.querySelector(`${css} [data-testid="meaning-hint"]`)?.innerText ?? null, SEARCH), 5000, { message: "hint" });
  assertIncludes(hint, "Sucht nach Bedeutung");
  assertIncludes(hint, "Was wird gesendet?");
  await t.shot("meaning-de");
  await t.noConsoleErrors(app);
}));

scenario("Settings › AI shows the index of the open repository, “Delete index” empties it", "edge", withCleanup(async (t) => {
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: LOCAL_EMBEDDER });
  const { repoId } = await openRepoAndSearch(app, repo);
  await searchByMeaning(app, "Ausgabe als Tabellendatei", 2);
  const commits = repo.git("rev-list", "--branches", "--remotes", "--tags", "HEAD").trim().split("\n").length;
  await app.press("Escape");
  await openSettingsAt(app, "AI");
  const row = '[data-setting="Index of this repository"]';
  await app.waitFor(() => app.exec((css, wanted) => document.querySelector(css)?.innerText.includes(wanted) ?? false, row, `${commits} commits with embeddinggemma`), 10_000, { message: "index size" });
  await app.click(await app.waitFor("[data-ai-index-delete]", 5000, { message: "Delete index" }));
  const confirmButton = await app.waitFor(
    () => app.exec(() => [...document.querySelectorAll("button")].filter((button) => button.innerText.trim() === "Delete index").at(-1) ?? null),
    5000,
    { message: "confirmation" },
  );
  await app.click(confirmButton);
  await app.waitFor(() => app.exec((css) => document.querySelector(css)?.innerText.includes("No index yet") ?? false, row), 10_000, { message: "index gone" });
  const status = await app.invoke("ai_semantic_status", { repoId });
  assertEqual([status.indexed, status.used], [0, false], "the core agrees");
  await t.shot("index-deleted");
  await t.noConsoleErrors(app);
}));
