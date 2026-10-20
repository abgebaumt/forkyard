/**
 * "Compose commits" (v1.2, Teilpaket 3.2) in the real app, in German, against a local stand-in for
 * Ollama (FORKYARD_AI_BASE_URL_OLLAMA, debug builds only) – never a real provider.
 *
 * The repository "messnetz" gets a new module src/plausibel.py that src/vergleich.py imports, a
 * rounding fix in vergleich.py with its test and a secret .env.local. The stand-in proposes the
 * import before the module (so commit 1 "doesn't build on its own") and is unsure about the test.
 *
 * - main: history strip, dependency tag and line, the protected .env.local, U and Enter review the
 *   unsure test, Ctrl+Enter asks "Zum Problem", moving the module fixes the order, the progress
 *   dialog creates both commits (checked with git), "Rückgängig" takes them back;
 * - edge: Ctrl click and N make a new commit from two units, its message with the 72 counter, a new
 *   proposal with an instruction keeps what the user moved (and the request says so), Ctrl+↓
 *   reorders into a broken order, Shift+↓ and 0 move two units at once, the file matrix;
 * - edge: a pre-commit hook rejects a commit after "Trotzdem anlegen": the dialog shows it, HEAD and
 *   the index are as before;
 * - edge: "Zusammenstellen …" sits small to the right of the commit button, on the same row.
 *
 *   node scripts/e2e-wd/features/compose.mjs
 *   E2E_WD_ONLY="instruction" node scripts/e2e-wd/features/compose.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { eventually, lines, until } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "de" };
const VIEW = '[data-screen="compose"]';
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const CONTROL = "";
const SHIFT = "";

const PLAUSIBEL = "src/plausibel.py";
const VERGLEICH = "src/vergleich.py";
const TEST = "tests/test_vergleich.py";
const ENV = ".env.local";

const TITLE_USE = "Plausibilitätsprüfung im Vergleich nutzen";
const TITLE_ADD = "Plausibilitätsprüfung ergänzen";
const TITLE_ROUND = "Rundung auf zwei Stellen";

/** Aliases per file in the order the prompt names them; sections other than the changes are skipped. */
function aliasesByFile(user) {
  const files = {};
  let current = null;
  for (const line of user.split("\n")) {
    if (line.startsWith("## ")) current = line === "## Local changes" ? current : null;
    const file = /^File: (.+?)(?: \(renamed from .*?\))?(?: [+–].*)?$/.exec(line);
    if (file) current = files[file[1]] = [];
    for (const match of line.matchAll(/\[unit (u\d+)\]/g)) current?.push(match[1]);
  }
  return files;
}

const unit = (alias, reason = "", unsure = false) => ({ unit: alias, reason, unsure });

/** The stand-in's answer: the first proposal in a broken order; with the instruction four small commits. */
function answer(system, user) {
  const files = aliasesByFile(user);
  const at = (file, index = 0) => files[file]?.[index];
  if (system.includes("«Tests in einen eigenen Commit»")) {
    return {
      commits: [
        { title: TITLE_ADD, body: "", reason: "Die neue Hilfsfunktion zuerst.", units: [unit(at(PLAUSIBEL), "Definiert ist_plausibel.")] },
        { title: TITLE_USE, body: "", reason: "Nutzt die Prüfung.", units: [unit(at(VERGLEICH, 0), "Import der Prüfung.")] },
        { title: TITLE_ROUND, body: "", reason: "Der Fix.", units: [unit(at(VERGLEICH, 1), "Rundung.")] },
        { title: "Test für die Rundung", body: "", reason: "Tests auf Wunsch getrennt.", units: [unit(at(TEST), "Der Test.")] },
      ],
    };
  }
  return {
    commits: [
      { title: TITLE_USE, body: "", reason: "Der Vergleich prüft die Werte vorher.", units: [unit(at(VERGLEICH, 0), "Importiert die neue Prüfung.")] },
      { title: TITLE_ADD, body: "", reason: "Neue Hilfsfunktion.", units: [unit(at(PLAUSIBEL), "Definiert ist_plausibel.")] },
      {
        title: TITLE_ROUND,
        body: "",
        reason: "Berechnung und Test gehören zusammen.",
        units: [unit(at(VERGLEICH, 1), "Rundet auf zwei Stellen."), unit(at(TEST), "Test zur Rundung; könnte auch ein eigener Commit sein.", true)],
      },
    ],
  };
}

/** Local stand-in for Ollama: records every chat (system and user text) and answers with `answer`. */
async function startOllama() {
  const chats = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let reply = null;
      if (req.method === "POST" && req.url === "/api/show") reply = { model_info: { "qwen3.context_length": 40960 } };
      else if (req.method === "GET" && req.url === "/api/tags") reply = { models: [{ name: "qwen3:8b" }] };
      else if (req.method === "POST" && req.url === "/api/chat") {
        const messages = JSON.parse(body).messages;
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        chats.push({ system, user });
        reply = { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(answer(system, user)) }, done: true, done_reason: "stop", prompt_eval_count: 200, eval_count: 40 };
      }
      const text = JSON.stringify(reply ?? { error: "not found" });
      res.writeHead(reply ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, chats, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs a scenario body and always runs the registered cleanups. */
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

const VERGLEICH_HEAD = `"""Vergleicht die Tagesmittel der Stationen."""


def differenz(a, b):
    return round(a - b, 1)


def mittel(werte):
    werte = list(werte)
    if not werte:
        return None
    summe = sum(werte)
    anzahl = len(werte)
    return round(summe / anzahl, 1)
`;

/** The working directory of the prototype, in Python; optionally a pre-commit hook (written before opening: trust). */
async function setup(t, { hook } = {}) {
  const ollama = await startOllama();
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => ollama.close(), () => repo.cleanup());
  repo.write(VERGLEICH, VERGLEICH_HEAD);
  repo.write(TEST, "from src.vergleich import differenz\n\n\ndef test_differenz():\n    assert differenz(3.0, 1.0) == 2.0\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Tests für den Vergleich");
  repo.write(PLAUSIBEL, '"""Plausibilitätsprüfung der Messwerte."""\n\n\ndef ist_plausibel(wert):\n    return -60.0 <= wert <= 60.0\n');
  repo.write(
    VERGLEICH,
    VERGLEICH_HEAD.replace('"""Vergleicht die Tagesmittel der Stationen."""\n', '"""Vergleicht die Tagesmittel der Stationen."""\n\nfrom .plausibel import ist_plausibel\n').replace(
      "    return round(summe / anzahl, 1)\n",
      "    return round(summe / anzahl, 2)\n",
    ),
  );
  repo.write(TEST, "from src.vergleich import differenz, mittel\n\n\ndef test_differenz():\n    assert differenz(3.0, 1.0) == 2.0\n\n\ndef test_mittel_zwei_stellen():\n    assert mittel([1.0, 2.0, 2.0]) == 1.67\n");
  repo.write(ENV, "API_TOKEN=messnetz-geheim-7f3a9c\n");
  if (hook) {
    const file = path.join(repo.path, ".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${hook}\n`);
    fs.chmodSync(file, 0o755);
  }
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0, aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
  const { repoId, tabId } = await app.openRepo(repo.path);
  t.step("repository opened, AI on with the local stand-in");
  return { repo, app, ollama, repoId, tabId };
}

async function openCompose(app) {
  await app.click(await app.waitFor("[data-compose-open]:not([aria-disabled])", 15_000, { message: "“Zusammenstellen …” in the Commit Panel" }));
  await app.waitFor(VIEW, 10_000, { message: "compose view" });
}

const commitTitles = (app) => app.exec((css) => [...document.querySelectorAll(`${css} [data-compose-subject]`)].map((el) => el.value), VIEW);
const row = (file, hunk = "0") => `${VIEW} [data-compose-unit][data-path="${file}"][data-hunk="${hunk}"]`;
const fileRow = (file) => `${VIEW} [data-compose-unit][data-path="${file}"][data-hunk="file"]`;
const rowInfo = (app, css) =>
  app.exec((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return {
      group: el.getAttribute("data-group"),
      cursor: el.hasAttribute("data-cursor"),
      selected: el.getAttribute("aria-selected") === "true",
      tags: [...el.querySelectorAll("[data-compose-tag]")].map((tag) => tag.textContent.trim()),
    };
  }, css);
const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.textContent.replace(/\s+/g, " ").trim() ?? null, css);
const history = (app) =>
  app.exec((css) => [...document.querySelectorAll(`${css} [data-compose-history-commit]`)].map((el) => ({ text: el.textContent.trim(), broken: el.hasAttribute("data-broken") })), VIEW);
const focused = (app) => app.exec(() => ({ subject: document.activeElement?.getAttribute("data-compose-subject") ?? null, list: document.activeElement?.hasAttribute("data-compose-list") ?? false }));
const runState = (app) => app.exec(() => document.querySelector("[data-compose-run]")?.getAttribute("data-state") ?? null);

/** Click with Control or Shift held – real W3C input. */
async function modClick(app, css, modifier) {
  const element = await app.waitFor(css, 5000, { message: css });
  await app.exec((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), css);
  await app.webdriver("POST", "/actions", {
    actions: [
      { type: "key", id: "keyboard", actions: [{ type: "keyDown", value: modifier }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: modifier }] },
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pause", duration: 0 }, { type: "pointerMove", origin: { [ELEMENT_KEY]: element.id }, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 0 }],
      },
    ],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

const proposed = (app) => eventually(() => commitTitles(app), [TITLE_USE, TITLE_ADD, TITLE_ROUND], "the stand-in's proposal", 20_000);

// ---------------------------------------------------------------------------------------------

scenario("dependency warning, protected file, unsure review, fix by moving, apply and Rückgängig", "main", withCleanup(async (t) => {
  const { repo, app, ollama } = await setup(t);
  const before = repo.git("rev-parse", "HEAD");
  await openCompose(app);
  await proposed(app);
  assertEqual(ollama.chats.length, 1, "one request to the provider");
  assert(!ollama.chats[0].user.includes(ENV) && !ollama.chats[0].user.includes("messnetz-geheim"), "the secret file is never sent");

  // History strip and the dependency check of the core.
  assertEqual(
    await history(app),
    [
      { text: `${TITLE_USE}baut nicht allein`, broken: true },
      { text: TITLE_ADD, broken: false },
      { text: TITLE_ROUND, broken: false },
    ],
    "the history after: commit 1 doesn't build on its own",
  );
  assertEqual((await rowInfo(app, row(VERGLEICH, "0"))).tags, ["braucht plausibel.py (erst Commit 2)"], "the tag on the unit");
  assertEqual(await text(app, `${VIEW} [data-compose-problem="0"]`), "braucht plausibel.py aus Commit 2", "the line on the commit");
  await t.shot("compose-proposed");

  // The protected file: locked in "Nicht committen", 1 does not move it.
  const env = await rowInfo(app, fileRow(ENV));
  assertEqual(env.group, "skip");
  assertEqual(env.tags, ["geschützt · nie an die KI gesendet"]);
  await app.click(fileRow(ENV));
  await until(async () => (await text(app, `${VIEW} [data-compose-detail="protected"]`))?.includes(".env.local ist geschützt"), "the explanation on the right");
  await app.press("1");
  await until(async () => (await text(app, `${VIEW} [data-compose-notice]`)) === ".env.local ist geschützt und bleibt draußen.", "the notice");
  assertEqual((await rowInfo(app, fileRow(ENV))).group, "skip", "it stays out");

  // Review the unsure unit: U jumps there, Enter confirms.
  assertEqual(await text(app, `${VIEW} [data-compose-review]`), "1 unsichere prüfen");
  await app.press("u");
  await until(async () => (await rowInfo(app, row(TEST)))?.cursor, "U goes to the unsure test");
  assertIncludes(await text(app, `${VIEW} [data-compose-reason]`), "Test zur Rundung; könnte auch ein eigener Commit sein.", "the AI's reason");
  assertEqual((await rowInfo(app, row(TEST))).tags, ["KI unsicher"]);
  await app.press("Enter");
  await until(async () => (await text(app, `${VIEW} [data-compose-review]`)) === "Alles geprüft", "Enter confirms");
  assertEqual((await rowInfo(app, row(TEST))).tags, [], "no longer unsure");

  // Creating asks first, "Zum Problem" goes to the unit.
  await app.press("Control+Enter");
  await app.waitFor("[data-compose-broken-fix]", 5000, { message: "the dependency question" });
  assertIncludes(await text(app, '[role="dialog"]'), "Ein Commit baut nicht für sich");
  assertIncludes(await text(app, '[role="dialog"]'), "Commit 1 braucht plausibel.py aus Commit 2.");
  await t.shot("compose-broken-dialog");
  await app.click("[data-compose-broken-fix]");
  await until(async () => (await rowInfo(app, row(VERGLEICH, "0")))?.cursor, "the cursor is on the unit with the problem");

  // Moving the module into commit 1 fixes the order; the emptied commit goes away.
  await app.click(fileRow(PLAUSIBEL));
  await app.press("1");
  await eventually(() => commitTitles(app), [TITLE_USE, TITLE_ROUND], "commit 2 is gone");
  assertEqual((await rowInfo(app, fileRow(PLAUSIBEL))).tags, ["neu", "von dir"]);
  assertEqual((await history(app)).map((node) => node.broken), [false, false], "every commit builds on its own now");
  assertEqual(await text(app, `${VIEW} [data-compose-summary]`), "2 Commits aus 4 Änderungen · 1 bleibt liegen");

  // Create: the progress dialog, then git.
  await app.click(`${VIEW} [data-action="compose-apply"]:not([data-blocked])`);
  await until(async () => (await runState(app)) === "done", "both commits created", 20_000);
  assertIncludes(await text(app, '[role="dialog"]'), "2 Commits angelegt");
  assertEqual(await app.exec(() => [...document.querySelectorAll("[data-compose-run-step]")].map((el) => el.lastElementChild.textContent)), ["angelegt", "angelegt"]);
  await t.shot("compose-created");
  assertEqual(lines(repo.git("log", "-2", "--format=%s")), [TITLE_ROUND, TITLE_USE], "git: two commits, the first of the plan is the older");
  assertEqual(lines(repo.git("show", "--name-only", "--format=", "HEAD~1")), [PLAUSIBEL, VERGLEICH], "git: module and import together");
  assertIncludes(repo.git("show", "HEAD~1", "--", VERGLEICH), "+from .plausibel import ist_plausibel");
  assert(!repo.git("show", "HEAD~1", "--", VERGLEICH).includes("summe / anzahl, 2"), "git: the rounding fix is not in commit 1");
  assertEqual(repo.git("rev-parse", "HEAD~2"), before, "git: both on top of the old HEAD");
  assertEqual(repo.git("status", "--porcelain"), `?? ${ENV}`, "git: only the protected file is left");

  // Rückgängig takes both back, the view stays with the changes.
  await app.click("[data-compose-run-undo]");
  await eventually(
    () => ({ head: repo.git("rev-parse", "HEAD"), status: lines(repo.git("status", "--porcelain")).map((line) => line.trim()) }),
    { head: before, status: [`M ${VERGLEICH}`, `M ${TEST}`, `?? ${ENV}`, `?? ${PLAUSIBEL}`] },
    "git: Rückgängig takes both commits back",
  );
  await until(async () => (await text(app, `${VIEW} [data-compose-notice]`))?.startsWith("Alle Commits zurückgenommen"), "the notice after undo");
  await app.waitFor(VIEW, 2000, { message: "the view stays open" });
  await t.noConsoleErrors(app);
}));

scenario("multi-select, N with a message, an instruction keeps what the user moved, reorder and the file matrix", "edge", withCleanup(async (t) => {
  const { app, ollama } = await setup(t);
  await openCompose(app);
  await proposed(app);

  // The file matrix: vergleich.py is split over commits 1 and 3.
  await app.click(`${VIEW} [data-value="files"]`);
  await app.waitFor(`${VIEW} [data-compose-matrix]`, 5000, { message: "Nach Dateien" });
  const split = await app.exec((css) => {
    const tr = document.querySelector(`${css} [data-compose-matrix-row="src/vergleich.py"]`);
    return { split: tr?.hasAttribute("data-split"), cells: [...tr.querySelectorAll("[data-compose-cell]")].map((cell) => [cell.dataset.composeCell, cell.textContent]) };
  }, VIEW);
  assertEqual(split, { split: true, cells: [["0", "1"], ["2", "1"]] }, "split: one hunk in commit 1, one in commit 3");
  assertIncludes(await text(app, `${VIEW} [data-compose-matrix-row="src/vergleich.py"]`), "aufgeteilt");
  await t.shot("compose-files");
  await app.click(`${VIEW} [data-compose-matrix-row="src/vergleich.py"] [data-compose-cell="2"]`);
  await until(async () => (await rowInfo(app, row(VERGLEICH, "1")))?.cursor, "a cell jumps to the unit in the commit view");

  // Ctrl click adds the test; N makes a new commit from both and focuses its message.
  await modClick(app, row(TEST), CONTROL);
  await until(async () => (await rowInfo(app, row(TEST)))?.selected && (await rowInfo(app, row(VERGLEICH, "1")))?.selected, "two units selected");
  assertEqual(await text(app, `${VIEW} [data-compose-detail="multi"] strong`), "2 Änderungen ausgewählt");
  await app.press("n");
  await until(async () => (await focused(app)).subject === "2", "the message of the new commit has the focus");
  assertEqual(await commitTitles(app), [TITLE_USE, TITLE_ADD, ""], "the emptied commit 3 is gone, the new one is last");
  assertIncludes(await text(app, `${VIEW} [data-compose-summary]`), "1 ohne Nachricht");
  await app.waitFor(`${VIEW} [data-action="compose-apply"][data-blocked]`, 2000, { message: "creating is blocked without a message" });
  await app.type(`${VIEW} [data-compose-subject="2"]`, "Rundung und Test");
  assertEqual(await text(app, `${VIEW} [data-compose-group="2"] [data-compose-length]`), "16/72 Zeichen");
  await app.press("Enter");
  await until(async () => (await focused(app)).list, "Enter goes back to the list");
  assertEqual((await rowInfo(app, row(TEST))).tags, ["von dir"]);

  // A new proposal with an instruction: the two moved units stay in “Rundung und Test”.
  await app.type(`${VIEW} [data-compose-instruction]`, "Tests in einen eigenen Commit");
  await app.press("Enter");
  await until(() => ollama.chats.length === 2, "the second request", 20_000);
  const { system, user } = ollama.chats[1];
  assertIncludes(system, "«Tests in einen eigenen Commit»", "the instruction, delimited as the user's words");
  assertIncludes(user, "## Placed by the user", "the request names what the user placed");
  assertIncludes(user, "is in the commit “Rundung und Test”");
  await eventually(() => commitTitles(app), [TITLE_ADD, TITLE_USE, "Rundung und Test"], "the new proposal, the user's commit kept", 20_000);
  assertEqual((await rowInfo(app, row(TEST))).group, "2", "the test stays where the user put it");
  assertEqual((await rowInfo(app, row(VERGLEICH, "1"))).group, "2");
  await until(async () => (await text(app, `${VIEW} [data-compose-notice]`))?.includes("2 von dir verschobene Änderungen bleiben, wo sie sind"), "the notice");
  assertEqual((await history(app)).map((node) => node.broken), [false, false, false]);
  await t.shot("compose-reproposed");

  // Ctrl+↓ on the module's commit puts it after its user: commit 1 doesn't build any more.
  await app.click(fileRow(PLAUSIBEL));
  await app.press("Control+ArrowDown");
  await eventually(() => commitTitles(app), [TITLE_USE, TITLE_ADD, "Rundung und Test"], "Ctrl+↓ reorders");
  assertEqual((await history(app)).map((node) => node.broken), [true, false, false], "the marker in the history");

  // Shift+↓ extends the selection, 0 moves both to “Nicht committen”.
  await app.click(row(VERGLEICH, "0"));
  await app.press("Shift+ArrowDown");
  await until(async () => (await rowInfo(app, fileRow(PLAUSIBEL)))?.selected, "Shift+↓ adds the next unit");
  await app.press("0");
  await until(async () => (await rowInfo(app, row(VERGLEICH, "0")))?.group === "skip" && (await rowInfo(app, fileRow(PLAUSIBEL)))?.group === "skip", "both in “Nicht committen”");
  assertEqual(await text(app, `${VIEW} [data-compose-notice]`), "2 Änderungen nach „Nicht committen“ verschoben");
  assertEqual(await commitTitles(app), ["Rundung und Test"]);
  // The test needs vergleich.py's first hunk, which is not committed now.
  assertEqual((await rowInfo(app, row(TEST))).tags, ["von dir", "braucht vergleich.py (nicht committet)"]);

  // Dragging the test onto “Nicht committen” (pointer events, a few pixels before it counts).
  await app.exec((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), row(TEST));
  const from = await app.waitFor(row(TEST));
  const to = await app.waitFor(`${VIEW} [data-compose-drop="-1"]`);
  await app.webdriver("POST", "/actions", {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", origin: { [ELEMENT_KEY]: from.id }, x: 0, y: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", origin: { [ELEMENT_KEY]: from.id }, x: 0, y: 12, duration: 50 },
          { type: "pointerMove", origin: { [ELEMENT_KEY]: to.id }, x: 0, y: 0, duration: 100 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
  await until(async () => (await rowInfo(app, row(TEST)))?.group === "skip", "the dragged test is in “Nicht committen”");
  // “Neu vorschlagen” without an instruction asks again as well (it used to do nothing).
  assertEqual(await app.exec((css) => document.querySelector(`${css} [data-compose-instruction]`).value, VIEW), "", "the field is empty after the request");
  await app.click(`${VIEW} [data-compose-repropose]`);
  await until(() => ollama.chats.length === 3, "a third request without an instruction", 20_000);
  assert(!ollama.chats[2].system.includes("«"), "no instruction in the third request");
  await until(async () => (await rowInfo(app, row(TEST)))?.group === "skip", "the test still stays where the user put it");
  await t.noConsoleErrors(app);
}));

scenario("a pre-commit hook rejects a commit after “Trotzdem anlegen”: the dialog says so, nothing is created", "edge", withCleanup(async (t) => {
  const { repo, app } = await setup(t, { hook: "if git diff --cached --name-only | grep -q '^tests/'; then echo 'Tests erst nach dem Review'; exit 1; fi" });
  const before = repo.git("rev-parse", "HEAD");
  await openCompose(app);
  await proposed(app);

  await app.click(`${VIEW} [data-action="compose-apply"]:not([data-blocked])`);
  await app.click(await app.waitFor("[data-compose-broken-go]", 5000, { message: "the dependency question" }));
  await until(async () => (await runState(app)) === "failed", "the run stops", 20_000);
  const dialog = await text(app, '[role="dialog"]');
  assertIncludes(dialog, "Kein Commit angelegt");
  assertIncludes(dialog, "Tests erst nach dem Review", "the hook's output is shown");
  assertEqual(await app.exec(() => document.querySelector('[data-compose-run-step="2"]')?.getAttribute("data-state")), "failed", "the third commit is the one that stopped");
  await t.shot("compose-hook-rejected");
  assertEqual(repo.git("rev-parse", "HEAD"), before, "git: the first commits were taken back");
  assertEqual(repo.git("diff", "--cached", "--name-only"), "", "git: the index is as before");
  assertEqual(lines(repo.git("diff", "--name-only")), [VERGLEICH, TEST], "git: the changes are untouched");
  assertEqual(repo.git("for-each-ref", "refs/forkyard/"), "", "git: no backup refs are left");
  await app.click("[data-compose-run-close]");
  await app.waitFor(VIEW, 2000, { message: "the view stays open" });
  await t.noConsoleErrors(app);
}));

scenario("“Zusammenstellen …” sits narrow to the right of the commit button, just as tall", "edge", withCleanup(async (t) => {
  const { app } = await setup(t);
  await app.waitFor("[data-compose-open]", 15_000, { message: "the compose button" });
  const box = await app.exec(() => {
    const rect = (css) => document.querySelector(css)?.getBoundingClientRect();
    const commit = rect('[data-action="commit"]');
    const compose = rect("[data-compose-open]");
    return { commit: { left: commit.left, right: commit.right, top: commit.top, bottom: commit.bottom, width: commit.width }, compose: { left: compose.left, top: compose.top, bottom: compose.bottom, width: compose.width, height: compose.height }, commitHeight: commit.height };
  });
  assert(box.compose.left >= box.commit.right, `right of the commit button: ${JSON.stringify(box)}`);
  assertEqual([box.compose.top, box.compose.bottom], [box.commit.top, box.commit.bottom], `on the same row, just as tall: ${JSON.stringify(box)}`);
  assert(box.commit.width > 1.4 * box.compose.width, `the commit button keeps most of the width: ${JSON.stringify(box)}`);
  assertEqual(await text(app, "[data-compose-open]"), "Zusammenstellen …");
  await t.shot("compose-button");

  // AI off: the button is gone, the commit button takes the whole row.
  await app.invoke("settings_set", { patch: { aiEnabled: false } });
  await until(async () => !(await app.exec(() => Boolean(document.querySelector("[data-compose-open]")))), "no compose button with AI off");
  await t.noConsoleErrors(app);
}));
