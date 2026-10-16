/**
 * Commit message from the staged changes (v1.2, Teilpaket 3.1) in the real app, against a local
 * stand-in for Ollama (FORKYARD_AI_BASE_URL_OLLAMA, debug builds only). A local provider asks no
 * first-use question; the confirmation gate itself is pinned by the Rust tests.
 *
 * - main: "Write" fills the empty fields as a draft; the request carries the staged diff and the
 *   repository's own subjects, the system text names German; "What is sent?" shows the same text and
 *   sends nothing; Ctrl+Z takes the draft back; the commit uses it;
 * - edge: the user's own text stays – Append, Replace, Discard;
 * - edge: typing while it writes only offers the suggestion; Cancel drops a late answer;
 * - edge: Ctrl+Shift+M, "Nothing staged", "AI off for this repository" hides it;
 * - edge: German texts.
 *
 *   cargo build && node scripts/e2e-wd/features/ai-commit-message.mjs
 *   E2E_WD_ONLY="Cancel" node scripts/e2e-wd/features/ai-commit-message.mjs
 */
import http from "node:http";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { commitUi, eventually, lines } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const WRITE = "[data-ai-write]";
const STATUS = "[data-ai-write-status]";
const OFFER = "[data-ai-offer]";
const SETTINGS = '[data-screen="settings"]';
const PALETTE = '[data-screen="command-palette"]';
const ANSWER = { summary: "Bericht je Station als CSV ergänzt", body: "Schreibt für jede Station eine Zeile mit dem Tagesmittel." };

/** Local stand-in for Ollama: records every request, answers the chat with ANSWER (optionally late). */
async function startOllama() {
  const state = { requests: [], answered: 0, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const route = `${req.method} ${req.url}`;
      state.requests.push({ route, body });
      const answer =
        route === "GET /api/tags"
          ? { models: [{ name: "qwen3:8b" }] }
          : route === "POST /api/show"
            ? { model_info: { "qwen3.context_length": 40960 } }
            : route === "POST /api/chat"
              ? { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(ANSWER) }, done: true, done_reason: "stop", prompt_eval_count: 420, eval_count: 31 }
              : null;
      const send = () => {
        const text = JSON.stringify(answer ?? { error: "not found" });
        res.writeHead(answer ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
        if (route === "POST /api/chat") state.answered += 1;
      };
      if (route === "POST /api/chat" && state.delayMs > 0) setTimeout(send, state.delayMs);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    chats: () => state.requests.filter((request) => request.route === "POST /api/chat"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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

/** App with AI on (local mock), the "messnetz" fixture opened, src/bericht.py staged. */
async function setup(t, { lang = "en" } = {}) {
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  repo.write("src/bericht.py", '"""Bericht je Station."""\n\n\ndef zeile(station, mittel):\n    return f"{station};{mittel}"\n');
  repo.git("add", "src/bericht.py");
  const app = await t.launch({ ...LAUNCH, lang, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0, aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
  const ui = commitUi(app);
  const { repoId } = await app.openRepo(repo.path);
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "one staged file");
  await app.waitFor(WRITE, 15_000, { message: "Write button in the summary field" });
  t.step("repository opened, AI on");
  return { ollama, repo, app, ui, repoId };
}

const writeLabel = (app) => app.exec((css) => document.querySelector(css)?.textContent.trim() ?? null, WRITE);
const statusText = (app) => app.exec((css) => document.querySelector(css)?.innerText.replace(/\s+/g, " ").trim() ?? null, STATUS);
const summaryValue = (app) => app.exec(() => document.querySelector("input[data-commit-summary]")?.value ?? null);
const gone = (app, css, message) => app.waitFor(() => app.exec((selector) => !document.querySelector(selector), css), 10_000, { message });
const chatPrompt = (ollama, index = 0) => {
  const body = JSON.parse(ollama.chats()[index].body);
  return { system: body.messages[0].content, user: body.messages[1].content };
};
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

async function closeSettings(app) {
  await app.press("Escape");
  await gone(app, SETTINGS, "settings closed");
}

async function openPalette(app, text) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor(`${PALETTE} input[role="combobox"]`, 10_000);
  await app.type(input, `>${text}`);
}

/** Opens the palette with ">text" and waits for the row of command `id`; returns its text (the palette stays open). */
async function paletteRow(app, text, id) {
  await openPalette(app, text);
  return app.waitFor(() => app.exec((css, key) => document.querySelector(`${css} [role="option"][data-key="command:${key}"]`)?.innerText ?? null, PALETTE, id), 10_000, { message: `palette entry ${id}` });
}

/** Whether the palette lists command `id` – read only once the row of `known` (always listed) is there. */
async function paletteLists(app, text, id, known) {
  await openPalette(app, text);
  await app.waitFor(`${PALETTE} [role="option"][data-key="command:${known}"]`, 10_000, { message: `palette entry ${known}` });
  return app.exec((css, key) => Boolean(document.querySelector(`${css} [role="option"][data-key="command:${key}"]`)), PALETTE, id);
}

// ---------------------------------------------------------------------------------------------

scenario("Write fills the empty message from a local model, Ctrl+Z takes it back, the commit uses it", "main", withCleanup(async (t) => {
  const { ollama, repo, app, ui } = await setup(t);
  assertEqual(await writeLabel(app), "Write");
  await app.waitFor("[data-ai-write-idle] [data-ai-commit-preview]", 5000, { message: "“What is sent?” before the first use" });
  await app.click(WRITE);
  await eventually(ui.fields, { summary: ANSWER.summary, description: ANSWER.body }, "the draft is in both fields");
  await eventually(async () => ((await statusText(app)) ?? "").includes("Draft from the staged diff, styled like the last 30 commits"), true, "the status line names the draft");
  assertEqual(await writeLabel(app), "New", "the button offers a new draft");
  assert(await app.exec(() => !document.activeElement?.matches("input[data-commit-summary], form textarea")), "the answer did not move the focus into a field");

  // What went out: the staged diff and the repository's own subjects (oracle: git log), in German.
  assertEqual(ollama.chats().length, 1);
  const prompt = chatPrompt(ollama);
  assertIncludes(prompt.user, "File: src/bericht.py");
  assertIncludes(prompt.user, "+def zeile(station, mittel):");
  for (const subject of lines(repo.git("log", "--no-merges", "-n", "30", "--format=%s"))) assertIncludes(prompt.user, subject, "style example");
  assertIncludes(prompt.system, "in German");
  await t.shot("draft-inserted");
  t.step("draft inserted");

  await app.click(await app.waitFor("[data-ai-commit-preview]", 5000, { message: "What is sent? link" }));
  const previewText = await app.waitFor(() => app.exec(() => document.querySelector("[data-ai-preview-text]")?.textContent ?? null), 15_000, { message: "What is sent?" });
  assertIncludes(previewText, "File: src/bericht.py");
  assertIncludes(previewText, "## Recent commit subjects");
  assertEqual(ollama.chats().length, 1, "the preview sends nothing");
  await app.press("Escape");
  await gone(app, "[data-ai-preview-text]", "preview closed");

  await app.click(await ui.summary());
  await app.press("Control+z");
  await eventually(ui.fields, { summary: "", description: "" }, "Ctrl+Z takes the draft back");
  await eventually(() => writeLabel(app), "Write", "back to the start");
  t.step("undone");

  await app.click(WRITE);
  await eventually(ui.fields, { summary: ANSWER.summary, description: ANSWER.body }, "written again");
  await app.click(await ui.summary());
  await app.press("Control+Enter");
  await ui.waitToast("success", /Commit created/);
  assertEqual(repo.git("log", "-1", "--format=%s"), ANSWER.summary, "git: summary");
  assertEqual(repo.git("log", "-1", "--format=%b").trim(), ANSWER.body, "git: body");
  await gone(app, STATUS, "the hint is gone after the commit");
  await t.noConsoleErrors(app);
}));

scenario("the user's own text stays: Append, Replace and Discard", "edge", withCleanup(async (t) => {
  const { app, ui } = await setup(t);
  await ui.fill(await ui.summary(), "WIP: Bericht");
  await app.click(WRITE);
  const offer = await app.waitFor(() => app.exec((css) => document.querySelector(css)?.innerText ?? null, OFFER), 15_000, { message: "suggestion offered" });
  assertIncludes(offer, ANSWER.summary);
  assertIncludes(offer, "Suggestion – your text stays until you choose");
  assertEqual(await ui.fields(), { summary: "WIP: Bericht", description: "" }, "nothing replaced unasked");
  await t.shot("offer");
  await app.click(`${OFFER} [data-ai-offer-action="append"]`);
  await eventually(ui.fields, { summary: "WIP: Bericht", description: `${ANSWER.summary}\n\n${ANSWER.body}` }, "appended after a blank line");
  t.step("append");

  await app.click(WRITE);
  await app.waitFor(OFFER, 15_000, { message: "offered again" });
  await app.click(`${OFFER} [data-ai-offer-action="replace"]`);
  await eventually(ui.fields, { summary: ANSWER.summary, description: ANSWER.body }, "replaced on request");
  t.step("replace");

  await ui.fill(await ui.summary(), "Eigener Betreff");
  await app.click(WRITE);
  await app.waitFor(OFFER, 15_000, { message: "offered a third time" });
  await app.click(`${OFFER} [data-ai-offer-action="discard"]`);
  await gone(app, OFFER, "offer gone");
  assertEqual((await ui.fields()).summary, "Eigener Betreff", "Discard keeps the user's text");
  await t.noConsoleErrors(app);
}));

scenario("typing while it writes only offers the suggestion; Cancel drops a late answer", "edge", withCleanup(async (t) => {
  const { ollama, app, ui } = await setup(t);
  ollama.state.delayMs = 5000;
  await app.click(WRITE);
  await eventually(() => writeLabel(app), "Cancel", "the button becomes Cancel");
  await app.waitFor(async () => /^Writing … \(\d+ s\)/.test((await statusText(app)) ?? ""), 10_000, { message: "seconds are counted from 3 s" });
  await t.shot("writing");
  await app.type(await ui.summary(), "Notiz");
  const offer = await app.waitFor(() => app.exec((css) => document.querySelector(css)?.innerText ?? null, OFFER), 15_000, { message: "the answer arrived" });
  assertIncludes(offer, "Suggestion ready");
  assertEqual((await ui.fields()).summary, "Notiz", "typed text is kept");
  await app.click(`${OFFER} [data-ai-offer-action="discard"]`);
  await gone(app, OFFER, "offer discarded");
  t.step("typed during the request");

  const answeredBefore = ollama.state.answered;
  const chatsBefore = ollama.chats().length;
  await app.click(WRITE);
  await eventually(() => writeLabel(app), "Cancel", "running again");
  // The request state starts at the click (preview first); cancel only once the chat is at the provider.
  await app.waitFor(() => ollama.chats().length > chatsBefore, 15_000, { message: "the second chat reached the provider" });
  await app.click(WRITE);
  await eventually(() => writeLabel(app), "Write", "cancelled at once");
  await app.waitFor(() => ollama.state.answered > answeredBefore, 15_000, { message: "the late answer reached the app" });
  await app.settle(500);
  assertEqual(await ui.fields(), { summary: "Notiz", description: "" }, "a cancelled answer is dropped");
  assert(await app.exec((css) => !document.querySelector(css), OFFER), "and not offered");
  await t.noConsoleErrors(app);
}));

scenario("Ctrl+Shift+M, “Nothing staged” and “AI off for this repository”", "edge", withCleanup(async (t) => {
  const { ollama, repo, app, ui, repoId } = await setup(t);
  await app.click(await ui.summary());
  await app.press("Control+Shift+m");
  await eventually(ui.fields, { summary: ANSWER.summary, description: ANSWER.body }, "the shortcut writes");
  await app.press("Control+z");
  await eventually(ui.fields, { summary: "", description: "" }, "Ctrl+Z in the field");
  t.step("shortcut");

  repo.git("reset", "-q");
  await ui.refresh();
  await ui.waitCounts(repoId, { unstaged: 1, staged: 0, conflicted: 0 }, "nothing staged");
  await eventually(() => app.exec((css) => document.querySelector(css)?.getAttribute("aria-disabled") ?? null, WRITE), "true", "Write is blocked");
  const row = await paletteRow(app, "Write commit message", "wip.writeMessage");
  assertIncludes(row ?? "", "Nothing staged", "the palette names the reason");
  await app.press("Escape");
  t.step("nothing staged");

  repo.git("add", "src/bericht.py");
  await ui.refresh();
  await ui.waitCounts(repoId, { unstaged: 0, staged: 1, conflicted: 0 }, "staged again");
  await openSettingsAt(app, "AI and agents");
  const toggle = await app.waitFor(() => app.exec(() => document.querySelector('[data-ai-project] [data-setting="AI off for this repository"] [role="switch"]')), 10_000, { message: "AI off switch" });
  await app.click(toggle);
  await eventually(async () => (await app.invoke("repo_settings_get", { repoId })).aiOff, true, "core: AI off for this repository");
  await closeSettings(app);
  await gone(app, WRITE, "Write is hidden");
  assertEqual(await paletteLists(app, "commit", "wip.writeMessage", "wip.commit"), false, "and not in the palette (“Commit” is listed, “Write commit message” is not)");
  await app.press("Escape");
  assertEqual(ollama.chats().length, 1, "only the request of the shortcut went out");
  await t.noConsoleErrors(app);
}));

scenario("German texts", "edge", withCleanup(async (t) => {
  const { app } = await setup(t, { lang: "de" });
  assertEqual(await writeLabel(app), "Schreiben");
  await app.click(WRITE);
  await eventually(() => summaryValue(app), ANSWER.summary, "draft inserted");
  await eventually(async () => ((await statusText(app)) ?? "").includes("Entwurf aus dem gestagten Diff, Stil wie die letzten 30 Commits"), true, "German hint");
  assertEqual(await writeLabel(app), "Neu");
  await t.shot("de");
  await t.noConsoleErrors(app);
}));
