/**
 * Line archaeology (v1.2, Teilpaket 7.1) in the real app against a real temp repository:
 *
 * - main: without AI the blame line menu offers “History of this line”; the panel lists exactly the
 *   commits of `git log -L3,3:src/station.py`, newest first, with the change of the line; W opens it
 *   from the keyboard; a step opens its commit's diff in the centre while the panel stays;
 * - main: with a local Ollama stand-in (FORKYARD_AI_BASE_URL_OLLAMA, debug builds only) the entry reads
 *   “Why is this so?”, “Explain” sends one request without author e-mails and shows the summary and
 *   the note at its commit; switching AI off hides the AI block at once and keeps the timeline;
 * - edge: the diff line menu on a removed line opens the history at the parent commit;
 * - edge: German texts.
 *
 *   node scripts/e2e-wd/features/archaeology.mjs
 *   E2E_WD_ONLY="Explain" node scripts/e2e-wd/features/archaeology.mjs
 */
import http from "node:http";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";
import { PEOPLE, makeDiffRepo } from "../fixtures/diff-repo.mjs";
import { rightClick } from "../fixtures/rebase.mjs";
import { eventually } from "../fixtures/commit-ui.mjs";

const LIGHT = { width: 1440, height: 900, theme: "light", lang: "en" };
const BL = '[data-screen="blame"]';
const PANEL = '[data-screen="archaeology"]';
const FILE = "src/station.py";
const LINES = ['"""Steuerung der Wetterstation."""', "", "INTERVALL_MINUTEN = 10", "", "def messen(sensor):", "    return sensor.lesen()", ""];

/**
 * src/station.py: line 3 changed by two later commits of other authors. The remote is on a public
 * host without a connected account: `#12` becomes a host link, no title is looked up (nothing leaves
 * the machine).
 */
function makeStationRepo() {
  const repo = makeDiffRepo("station");
  repo.git("remote", "add", "origin", "https://github.com/wetter/station.git");
  const shas = {};
  repo.write(FILE, LINES.join("\n"));
  shas.first = repo.commit("Steuerung der Station angelegt", PEOPLE.lena);
  const v2 = [...LINES];
  v2[2] = "INTERVALL_MINUTEN = 5";
  repo.write(FILE, v2.join("\n"));
  shas.interval = repo.commit("Messintervall auf fünf Minuten (#12)", PEOPLE.jonas);
  const v3 = [...v2];
  v3[2] = "INTERVALL_MINUTEN = 2  # Sturmwarnung";
  repo.write(FILE, v3.join("\n"));
  shas.storm = repo.commit("Bei Sturm alle zwei Minuten messen", PEOPLE.aylin);
  return { repo, shas };
}

/** The oracle: the commits Git itself names for line 3 at `rev`, newest first. */
const gitLineLog = (repo, rev = "HEAD") => repo.git("log", "-L3,3:" + FILE, "-s", "--format=%H", rev).split("\n").filter(Boolean);

const store = (app, method, ...args) => app.exec((name, list) => window.__gc.store.getState()[name](...list), method, args);
/** The tab's right panel, archaeology target and centre; objects in a fixed key order, since WebDriver does not keep it. */
const ordered = (value) =>
  Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const tabView = async (app, tabId) => {
  const view = await app.exec((tab) => {
    const found = window.__gc.store.getState().views[tab];
    return found ? { rightPanel: found.rightPanel, archaeology: found.archaeology, center: found.center } : null;
  }, tabId);
  return view && { rightPanel: view.rightPanel, archaeology: ordered(view.archaeology), center: ordered(view.center) };
};
const panelShas = (app) => app.exec((sel) => [...document.querySelectorAll(`${sel} [data-step-sha]`)].map((el) => el.dataset.stepSha), PANEL);

async function blameReady(app, stand = "worktree") {
  await app.waitFor(
    () => app.exec((sel, wanted) => {
      const root = document.querySelector(sel);
      return root?.getAttribute("data-stand") === wanted && !root.querySelector("[data-loading]") && Boolean(root.querySelector(".cm-content .cm-line"));
    }, BL, stand),
    30_000,
    { message: `blame at ${stand}` },
  );
  await app.settle();
}

const blameLine = (app, index) => app.waitFor(() => app.exec((sel, at) => document.querySelectorAll(`${sel} .cm-content .cm-line`)[at] ?? null, BL, index), 10_000, { message: `blame line ${index + 1}` });

async function panelReady(app) {
  await app.waitFor(() => app.exec((sel) => Boolean(document.querySelector(`${sel} [data-archaeology-timeline]`)), PANEL), 30_000, { message: "archaeology panel with timeline" });
  await app.settle();
}

/** Labels of the open menu's items (without hints and shortcuts). */
const menuLabels = (app) => app.exec(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.innerText.replace(/\s+/g, " ").trim()));
const startsWithEach = (labels, expected) => expected.every((label, index) => (labels[index] ?? "").startsWith(label));

async function chooseMenuItem(app, label) {
  await app.click({ text: label, within: '[role="menu"]' });
}

/** Local stand-in for Ollama: one fixed answer, every request recorded. */
async function startOllama(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      const routes = {
        "GET /api/tags": { models: [{ name: "qwen3:8b" }] },
        "POST /api/show": { model_info: { "qwen3.context_length": 40960 } },
        "POST /api/chat": { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(answer) }, done: true, done_reason: "stop", prompt_eval_count: 420, eval_count: 60 },
      };
      const found = routes[`${req.method} ${req.url}`];
      const text = JSON.stringify(found ?? { error: "not found" });
      res.writeHead(found ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

// ---------------------------------------------------------------------------------------------

scenario("History of this line from the blame line menu, like git log -L, without AI", "main", async (t) => {
  const { repo, shas } = makeStationRepo();
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    assertEqual((await app.invoke("ai_status")).state, "unset", "AI is not set up");
    await store(app, "openBlame", tabId, FILE, null);
    await blameReady(app);

    await rightClick(app, await blameLine(app, 2));
    await app.waitFor('[role="menu"]', 5_000, { message: "line menu" });
    const items = await menuLabels(app);
    assert(startsWithEach(items, ["Copy line", "Show commit", "Blame of the previous version", "History of this line"]), `the four line actions, no AI wording: ${JSON.stringify(items)}`);
    await chooseMenuItem(app, "History of this line");
    await panelReady(app);

    const expected = gitLineLog(repo);
    assertEqual(expected, [shas.storm, shas.interval, shas.first], "precondition: Git names three commits");
    assertEqual(await panelShas(app), expected, "the panel lists exactly Git's commits, newest first");
    assertEqual((await tabView(app, tabId)).archaeology, ordered({ path: FILE, line: 3, sha: null }));
    assertEqual(await app.exec((sel) => document.querySelector(`${sel} [data-archaeology-line]`)?.textContent ?? null, PANEL), "INTERVALL_MINUTEN = 2  # Sturmwarnung");
    const newest = await app.exec((sel, sha) => document.querySelector(`${sel} [data-step-sha="${sha}"]`)?.innerText ?? "", PANEL, shas.storm);
    assertIncludes(newest, "INTERVALL_MINUTEN = 5");
    assertIncludes(newest, "INTERVALL_MINUTEN = 2  # Sturmwarnung");
    assertIncludes(await app.exec((sel, sha) => document.querySelector(`${sel} [data-step-sha="${sha}"] [data-step-refs]`)?.innerText ?? "", PANEL, shas.interval), "#12", "the reference of the message is shown");
    assertEqual(
      await app.exec((sel, sha) => document.querySelector(`${sel} [data-step-sha="${sha}"] [data-ticket-link]`)?.getAttribute("title") ?? null, PANEL, shas.interval),
      "Open https://github.com/wetter/station/issues/12 in the browser",
      "the host rule's address",
    );
    assert(await app.exec((sel, sha) => Boolean(document.querySelector(`${sel} [data-step-sha="${sha}"] [data-step-introduced]`)), PANEL, shas.first), "the oldest step says where the line starts");
    assert(!(await app.exec((sel) => Boolean(document.querySelector(`${sel} [data-archaeology-ai]`)), PANEL)), "no AI block while AI is not set up");
    await t.shot("history-panel");

    // W on line 5 from the keyboard.
    await app.click(`${BL} .cm-content`);
    await app.press("Control+Home", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
    await app.press("w");
    await eventually(async () => (await tabView(app, tabId)).archaeology, ordered({ path: FILE, line: 5, sha: null }), "W opens the panel for the cursor line");
    await panelReady(app);
    assertEqual(await panelShas(app), [shas.first], "line 5 was never changed after the first commit");

    // A step opens its commit's diff in the centre; the panel stays.
    await rightClick(app, await blameLine(app, 2));
    await chooseMenuItem(app, "History of this line");
    await panelReady(app);
    await app.click(`${PANEL} [data-step-sha="${shas.interval}"] [data-step-open]`);
    await eventually(async () => (await tabView(app, tabId)).center, ordered({ kind: "diff", path: FILE, source: { kind: "commit", sha: shas.interval } }), "the diff of the step's commit");
    assertEqual((await tabView(app, tabId)).rightPanel, "archaeology", "the panel stays open");
    assertEqual(repo.git("status", "--porcelain"), "", "nothing changed in Git");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Why is this so? with a local stand-in explains the line without author e-mails", "main", async (t) => {
  const { repo, shas } = makeStationRepo();
  const answer = {
    summary: "Das Messintervall wurde zweimal verkürzt: erst auf fünf, dann bei Sturm auf zwei Minuten.",
    steps: [{ sha: shas.interval.slice(0, 7), note: "Halbiert das Intervall." }, { sha: "1234567", note: "Erfunden." }],
    confidence: "medium",
  };
  const ollama = await startOllama(answer);
  try {
    const app = await t.launch({ ...LIGHT, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
    const { tabId } = await app.openRepo(repo.path);
    await app.invoke("settings_set", { patch: { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
    await eventually(async () => (await app.invoke("ai_status")).connected, true, "connected to the stand-in");
    await store(app, "openBlame", tabId, FILE, null);
    await blameReady(app);

    await rightClick(app, await blameLine(app, 2));
    await chooseMenuItem(app, "Why is this so?");
    await panelReady(app);
    assertEqual(await app.exec((sel) => document.querySelector(`${sel} [data-archaeology-title]`)?.textContent ?? null, PANEL), "Why is this so?");
    assertEqual(ollama.requests.filter((request) => request.url === "/api/chat").length, 0, "opening the panel sends nothing");

    await app.click(`${PANEL} [data-archaeology-explain="explain"]`);
    const summary = await app.waitFor(() => app.exec((sel) => document.querySelector(`${sel} [data-archaeology-summary]`)?.textContent ?? null, PANEL), 30_000, { message: "summary" });
    assertEqual(summary, answer.summary);
    assertEqual(await app.exec((sel, sha) => document.querySelector(`${sel} [data-step-sha="${sha}"] [data-step-note]`)?.textContent ?? null, PANEL, shas.interval), "Halbiert das Intervall.");
    assertEqual(await app.exec((sel) => document.querySelectorAll(`${sel} [data-step-note]`).length, PANEL), 1, "the invented commit gets no note");
    assertEqual(await app.exec((sel) => document.querySelector(`${sel} [data-archaeology-status]`)?.textContent ?? null, PANEL), "Explanation ready");
    assertEqual(await app.exec((sel) => document.querySelector(`${sel} [data-archaeology-explain]`)?.getAttribute("data-archaeology-explain"), PANEL), "again");

    const chats = ollama.requests.filter((request) => request.url === "/api/chat");
    assertEqual(chats.length, 1, "exactly one request");
    for (const sha of [shas.storm, shas.interval, shas.first]) assertIncludes(chats[0].body, sha);
    assertIncludes(chats[0].body, "Messintervall auf fünf Minuten (#12)");
    for (const person of [PEOPLE.lena, PEOPLE.jonas, PEOPLE.aylin]) assert(!chats[0].body.includes(person.email), `no e-mail of ${person.name}`);
    await t.shot("why-explained");
    assertEqual(repo.git("status", "--porcelain"), "", "nothing changed in Git");

    // Master switch off (state "off"): the AI block disappears at once, the timeline stays.
    await app.invoke("settings_set", { patch: { aiEnabled: false } });
    await eventually(async () => app.exec((sel) => Boolean(document.querySelector(`${sel} [data-archaeology-ai]`)), PANEL), false, "the AI block is gone");
    assertEqual(await app.exec((sel) => document.querySelector(`${sel} [data-archaeology-title]`)?.textContent ?? null, PANEL), "History of this line");
    assertEqual(await panelShas(app), gitLineLog(repo), "the timeline stays");
    assertEqual(ollama.requests.filter((request) => request.url === "/api/chat").length, 1, "nothing more was sent");
    await t.noConsoleErrors(app);
  } finally {
    await ollama.close();
    repo.cleanup();
  }
});

scenario("Diff menu on a removed line opens the history at the parent commit", "edge", async (t) => {
  const { repo, shas } = makeStationRepo();
  try {
    const app = await t.launch(LIGHT);
    const { tabId } = await app.openRepo(repo.path);
    await store(app, "openDiff", tabId, FILE, { kind: "commit", sha: shas.storm });
    const removed = await app.waitFor(() => app.exec(() => document.querySelector('[data-diff-grid] [data-row][data-kind="remove"]')), 30_000, { message: "removed line in the diff" });
    await rightClick(app, removed);
    await chooseMenuItem(app, "History of this line");
    await eventually(async () => (await tabView(app, tabId)).archaeology, ordered({ path: FILE, line: 3, sha: `${shas.storm}^` }), "target on the old side");
    await panelReady(app);
    assertEqual(await panelShas(app), gitLineLog(repo, `${shas.storm}^`), "Git's commits of the parent state");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("German texts", "edge", async (t) => {
  const { repo } = makeStationRepo();
  try {
    const app = await t.launch({ ...LIGHT, lang: "de" });
    const { tabId } = await app.openRepo(repo.path);
    await store(app, "openBlame", tabId, FILE, null);
    await blameReady(app);
    await rightClick(app, await blameLine(app, 2));
    await app.waitFor('[role="menu"]', 5_000, { message: "Zeilenmenü" });
    const items = await menuLabels(app);
    assert(startsWithEach(items, ["Zeile kopieren", "Commit zeigen", "Blame der Vorversion", "Geschichte dieser Zeile"]), `German line actions: ${JSON.stringify(items)}`);
    await chooseMenuItem(app, "Geschichte dieser Zeile");
    await panelReady(app);
    assertEqual(await app.exec((sel) => document.querySelector(`${sel} [data-archaeology-title]`)?.textContent ?? null, PANEL), "Geschichte dieser Zeile");
    assertIncludes(await app.exec((sel) => document.querySelector(`${sel} [data-archaeology-count]`)?.textContent ?? "", PANEL), "3 Änderungen");
    await t.shot("history-de");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
