/**
 * “Explain intent” in the conflict tool (v1.2, Teilpaket 6.1) in the real app over WebDriver, against a
 * local stand-in for Ollama (FORKYARD_AI_BASE_URL_OLLAMA, debug builds only) and real Git repositories:
 *
 * - main: rebase conflict – nothing is sent before the click; the column explains both sides; the
 *   request carried the commit messages of both sides between the delimiters; “Apply” replaces only
 *   this block (block “edited by hand”), Ctrl+Z / Ctrl+Y in the result undo and redo it, Ctrl+S saves
 *   and stages exactly that text;
 * - edge: three conflicts – Alt+↓ moves to the next conflict and the column follows without taking the
 *   focus; “Discard” changes nothing in the result;
 * - edge: not set up, on without a provider (Explain intent opens the setup dialog), function off, AI
 *   off: no toggle or column where hidden, nothing sent; the toggle hides and shows;
 * - edge: German texts.
 *
 *   node scripts/e2e-wd/features/conflict-intent.mjs
 *   E2E_WD_ONLY="three conflicts" node scripts/e2e-wd/features/conflict-intent.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeLabRepo, makeRebaseRepo, REBASE_FILE, rebaseParts, resultLines, STATION, toText } from "../../e2e/screens/conflict-lib.mjs";
import { eventually } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const LAUNCH = { width: 1600, height: 900, theme: "light", lang: "en" };
const CONFLICT = '[data-screen="conflict"]';
const COLUMN = `${CONFLICT} [data-intent-column]`;
const AI_ON = { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" };

const REBASE_PROPOSAL = "- Temperatur: alle 5 Minuten, nachts alle 30";
/** Per conflict of src/station.py (stationParts): the lines the stand-in proposes. */
const STATION_PROPOSALS = [
  ["SCHWELLE_FROST = -0.5  # Bodenfrost früher melden"],
  ['    werte = [float(z[spalte].replace(",", ".")) for z in zeilen if z[spalte]]', "    if not werte:", "        return None", "    return round(statistics.mean(werte), 2)"],
  ["    print(f\"Durchschnitt: {mittel(zeilen, 'temperatur_c'):.2f} Grad Celsius\")"],
];

/** What the stand-in answers: three blocks for the station, one for the rebase plan. */
function answerFor(user) {
  if (user.includes("## Conflict block 3")) {
    return { blocks: STATION_PROPOSALS.map((lines, index) => ({ block: index + 1, ours: `Main zu Konflikt ${index + 1}.`, theirs: `Feature zu Konflikt ${index + 1}.`, text: `${lines.join("\n")}\n` })) };
  }
  return { blocks: [{ block: 1, ours: "Main misst öfter: alle 5 statt 10 Minuten.", theirs: "Der Branch misst nachts seltener, alle 30 Minuten.", text: `${REBASE_PROPOSAL}\n` }] };
}

/** Local stand-in for Ollama: native /api/chat with the JSON answer as message content; records every request. */
async function startOllama() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      let reply = null;
      if (req.method === "POST" && req.url === "/api/show") reply = { model_info: { "qwen3.context_length": 40960 } };
      else if (req.method === "GET" && req.url === "/api/tags") reply = { models: [{ name: "qwen3:8b" }] };
      else if (req.method === "POST" && req.url === "/api/chat") {
        const user = JSON.parse(body).messages.at(-1).content;
        reply = { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(answerFor(user)) }, done: true, done_reason: "stop", prompt_eval_count: 900, eval_count: 120 };
      }
      const text = JSON.stringify(reply ?? { error: "not found" });
      res.writeHead(reply ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Debug switches of every launch: the Ollama stand-in, LM Studio on a closed loopback port and an empty
 * folder as the only place the command-line tools are searched (1b) – the setup dialog's detection never
 * reaches a real tool or service.
 */
function aiEnv(t, ollama) {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-intent-cli-"));
  t.cleanups.push(() => fs.rmSync(cliDir, { recursive: true, force: true }));
  return { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url, FORKYARD_AI_BASE_URL_LMSTUDIO: "http://127.0.0.1:9", FORKYARD_AI_CLI_DIR: cliDir };
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

const chats = (ollama) => ollama.requests.filter((request) => request.method === "POST" && request.url === "/api/chat");
const lastUser = (ollama) => JSON.parse(chats(ollama).at(-1).body).messages.at(-1).content;
const resultText = (app) => app.exec(() => document.querySelector("[data-result-editor]")?.__gcView?.state.doc.toString() ?? null);
const blockState = (app, conflict) =>
  app.exec((root, index) => document.querySelector(`${root} [data-sides] [data-conflict-head="${index}"][data-side="ours"] [data-block-state]`)?.getAttribute("data-block-state") ?? null, CONFLICT, conflict);
const toggleShown = (app) => app.exec((root) => Boolean(document.querySelector(`${root} [data-intent-toggle]`)), CONFLICT);
const columnShown = (app) =>
  app.exec((css) => {
    const element = document.querySelector(css);
    return Boolean(element) && getComputedStyle(element).display !== "none";
  }, COLUMN);

async function openConflictFromList(app, file, label = `Resolve conflict: ${file}`) {
  const row = await app.waitFor(`[data-section="conflicts"] [data-row-key="${file}"]`, 20_000);
  await app.click(row);
  await app.waitFor(
    () => app.exec((root, wanted) => {
      const element = document.querySelector(root);
      return element?.getAttribute("aria-label") === wanted && element.getAttribute("data-conflict-state") !== "loading";
    }, CONFLICT, label),
    60_000,
    { message: `conflict tool for ${file}` },
  );
  await app.settle();
}

/** The column is open (its state is remembered per viewer). */
async function showColumn(app) {
  const toggle = await app.waitFor(`${CONFLICT} [data-intent-toggle]`, 15_000, { message: "intent toggle" });
  if ((await toggle.attr("aria-pressed")) !== "true") await app.click(toggle);
  await eventually(() => columnShown(app), true, "intent column shown");
}

async function launchWithAi(t, extra = {}) {
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const app = await t.launch({ ...LAUNCH, ...extra, env: aiEnv(t, ollama) });
  await app.invoke("settings_set", { patch: AI_ON });
  return { app, ollama };
}

// ---------------------------------------------------------------------------------------------

scenario("rebase conflict: Explain intent, Apply one block, undo and redo in the result, save", "main", withCleanup(async (t) => {
  const fixture = makeRebaseRepo();
  t.cleanups.push(() => fixture.cleanup());
  const { app, ollama } = await launchWithAi(t);
  await app.openRepo(fixture.path);
  await openConflictFromList(app, REBASE_FILE);
  await showColumn(app);
  await app.waitFor(`${COLUMN} [data-intent-explain]`, 5000, { message: "Explain intent" });
  assertEqual(chats(ollama).length, 0, "nothing is sent before the click");
  await t.shot("intent-idle");

  await app.click(`${COLUMN} [data-intent-explain]`);
  await app.waitFor(`${COLUMN} [data-intent-card="0"] [data-intent-apply]`, 30_000, { message: "proposal for conflict 1" });
  const why = await app.exec((css) => [...document.querySelectorAll(`${css} [data-intent-card="0"] [data-intent-why]`)].map((element) => element.innerText.trim()), COLUMN);
  assertEqual(why, ["Main misst öfter: alle 5 statt 10 Minuten.", "Der Branch misst nachts seltener, alle 30 Minuten."], "both sides explained");
  const diff = await app.exec((css) => [...document.querySelectorAll(`${css} [data-intent-card="0"] [data-diff-row]`)].map((element) => `${element.dataset.diffRow}:${element.innerText}`), COLUMN);
  assert(diff.includes(`add:+ ${REBASE_PROPOSAL}`), `the proposal shows as an added line: ${JSON.stringify(diff)}`);
  assertIncludes(await app.exec((css) => document.querySelector(`${css} [data-intent-status="ready"]`)?.innerText ?? "", COLUMN), "Intent explained for 1 conflict.");
  assert(await app.exec(() => !document.activeElement?.closest("[data-intent-card]")), "the answer did not move the focus");

  assertEqual(chats(ollama).length, 1, "exactly one request");
  const user = lastUser(ollama);
  assertIncludes(user, "Temperatur alle 5 Minuten", "commit message of the target side");
  assertIncludes(user, "Nachts seltener messen", "commit message of your commit");
  assertIncludes(user, "- Temperatur: alle 10 Minuten, nachts alle 30", "the incoming block text");
  assertMatch(user, /<<<REPO [0-9a-f]+>>>/, "repository content between delimiters");
  await t.shot("intent-ready");

  await app.click(`${COLUMN} [data-intent-card="0"] [data-intent-apply]`);
  const expected = toText(resultLines(rebaseParts, () => [REBASE_PROPOSAL]));
  await eventually(() => resultText(app), expected, "result: only the block replaced");
  await eventually(() => blockState(app, 0), "manual", "the block counts as edited by hand");
  await app.waitFor(`${COLUMN} [data-intent-card="0"] [data-intent-decision="taken"]`, 5000, { message: "card says applied" });
  await t.shot("intent-applied");

  await app.exec(() => document.querySelector("[data-result-editor] .cm-content")?.focus());
  await app.press("Control+z");
  await eventually(async () => /<<<<<<< /.test((await resultText(app)) ?? ""), true, "Ctrl+Z in the result takes Apply back");
  await app.press("Control+y");
  await eventually(() => resultText(app), expected, "redo brings the proposal back");

  await app.press("Control+s");
  await eventually(() => String(fixture.read(REBASE_FILE)), expected, "saved file", 20_000);
  assertEqual(fixture.git("ls-files", "-u", "--", REBASE_FILE), "", "git: no conflict left");
  assertEqual(fixture.git("cat-file", "blob", `:0:${REBASE_FILE}`) + "\n", expected, "git: staged blob");
  await t.noConsoleErrors(app);
}));

scenario("three conflicts: Alt+↓ moves to the next conflict and the column follows; Discard keeps the result", "edge", withCleanup(async (t) => {
  const fixture = makeLabRepo();
  t.cleanups.push(() => fixture.cleanup());
  const { app, ollama } = await launchWithAi(t);
  await app.openRepo(fixture.path);
  await openConflictFromList(app, STATION);
  await showColumn(app);
  await app.click(await app.waitFor(`${COLUMN} [data-intent-explain]`, 10_000, { message: "Explain intent" }));
  await app.waitFor(`${COLUMN} [data-intent-card="2"] [data-intent-apply]`, 30_000, { message: "three proposals" });
  assertEqual(await app.exec((css) => document.querySelectorAll(`${css} [data-intent-card]`).length, COLUMN), 3, "one card per conflict");
  assertIncludes(lastUser(ollama), "## Conflict block 3", "all three blocks went out");
  await app.waitFor(`${COLUMN} [data-intent-card="0"][aria-current="true"]`, 5000, { message: "the first conflict is current" });

  await app.exec(() => document.activeElement?.blur());
  await app.press("Alt+ArrowDown");
  await app.press("Alt+ArrowDown");
  await app.waitFor(`${COLUMN} [data-intent-card="2"][aria-current="true"]`, 5000, { message: "the card of conflict 3 is current" });
  await eventually(
    () =>
      app.exec((css) => {
        const scroller = document.querySelector(`${css} [data-intent-scroller]`).getBoundingClientRect();
        const card = document.querySelector(`${css} [data-intent-card="2"]`).getBoundingClientRect();
        return card.top >= scroller.top - 1 && card.top < scroller.bottom;
      }, COLUMN),
    true,
    "the column scrolled to the current conflict",
  );
  assert(await app.exec(() => !document.activeElement?.closest("[data-intent-column]")), "the focus stayed outside the column");

  const before = await resultText(app);
  await app.click(`${COLUMN} [data-intent-card="0"] [data-intent-discard]`);
  await app.waitFor(`${COLUMN} [data-intent-card="0"] [data-intent-decision="discarded"]`, 5000, { message: "card says discarded" });
  assertEqual(await resultText(app), before, "Discard changes nothing in the result");
  await t.shot("intent-three");
  await t.noConsoleErrors(app);
}));

scenario("nothing of it while AI is not set up, the function is off or AI is turned off", "edge", withCleanup(async (t) => {
  const fixture = makeRebaseRepo();
  t.cleanups.push(() => fixture.cleanup());
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const app = await t.launch({ ...LAUNCH, env: aiEnv(t, ollama) });
  await app.openRepo(fixture.path);
  await openConflictFromList(app, REBASE_FILE);
  assertEqual(await toggleShown(app), false, "unset: no intent toggle");
  assertEqual(await columnShown(app), false, "unset: no column");

  // On, but no provider yet: the element is there, a click opens the setup instead of sending.
  await app.invoke("settings_set", { patch: { aiEnabled: true } });
  await eventually(() => toggleShown(app), true, "on without a provider: the toggle appears");
  await showColumn(app);
  await app.click(await app.waitFor(`${COLUMN} [data-intent-explain]`, 5000, { message: "Explain intent" }));
  await app.waitFor("[data-ai-setup]", 10_000, { message: "the setup dialog opens" });
  await app.click(await app.waitFor("[data-ai-setup-cancel]", 10_000, { message: "Cancel in the setup dialog" }));
  await eventually(() => app.exec(() => document.querySelector("[data-ai-setup]") === null), true, "setup cancelled");
  assertEqual(await app.exec((css) => document.querySelector(css)?.getAttribute("data-intent-state") ?? null, COLUMN), "idle", "nothing started");
  assertEqual(chats(ollama).length, 0, "nothing sent without a provider");

  await app.invoke("settings_set", { patch: AI_ON });
  await eventually(() => toggleShown(app), true, "on and connected: the toggle appears");
  await showColumn(app);
  await app.click(`${CONFLICT} [data-intent-toggle]`);
  await eventually(() => columnShown(app), false, "the toggle hides the column");
  await app.click(`${CONFLICT} [data-intent-toggle]`);
  await eventually(() => columnShown(app), true, "and shows it again");

  await app.invoke("settings_set", { patch: { aiFeaturesOff: ["conflict_intent"] } });
  await eventually(() => toggleShown(app), false, "function off: hidden");
  await app.invoke("settings_set", { patch: { aiFeaturesOff: [], aiEnabled: false } });
  await eventually(() => toggleShown(app), false, "AI turned off: hidden");
  assertEqual(await columnShown(app), false, "no column either");
  assertEqual(chats(ollama).length, 0, "nothing was ever sent");
  await t.noConsoleErrors(app);
}));

scenario("German texts", "edge", withCleanup(async (t) => {
  const fixture = makeRebaseRepo();
  t.cleanups.push(() => fixture.cleanup());
  const { app } = await launchWithAi(t, { lang: "de" });
  await app.openRepo(fixture.path);
  await openConflictFromList(app, REBASE_FILE, `Konflikt lösen: ${REBASE_FILE}`);
  await showColumn(app);
  assertEqual(await app.exec((root) => document.querySelector(`${root} [data-intent-toggle]`)?.innerText.trim() ?? null, CONFLICT), "Absicht");
  assertEqual(await app.exec((css) => document.querySelector(`${css} [data-intent-explain]`)?.innerText.trim() ?? null, COLUMN), "Absicht erklären");
  await app.click(`${COLUMN} [data-intent-explain]`);
  const apply = await app.waitFor(`${COLUMN} [data-intent-card="0"] [data-intent-apply]`, 30_000, { message: "Vorschlag" });
  assertEqual((await app.exec((css) => document.querySelector(`${css} [data-intent-card="0"] [data-intent-apply]`)?.innerText.trim(), COLUMN)), "Übernehmen");
  assertIncludes(await app.exec((css) => document.querySelector(`${css} [data-intent-status="ready"]`)?.innerText ?? "", COLUMN), "Absicht für 1 Konflikt erklärt.");
  assert(apply, "apply button present");
  await t.shot("intent-de");
  await t.noConsoleErrors(app);
}));
