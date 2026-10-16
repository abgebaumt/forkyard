/**
 * AI setup and visibility in the real app (v1.2, Teilpaket 1a):
 *
 * - main: "unset" shows one muted start-page entry "Set up AI features": reachable with Tab, Enter and a
 *   click open Settings › AI; the palette offers "Set up AI …" and leads there as well;
 * - main: connecting a local Ollama (a Node mock behind FORKYARD_AI_BASE_URL_OLLAMA, debug builds only)
 *   in Settings › AI – switch on, provider, Check, model – removes the entry and the palette command;
 * - edge: turned off on purpose: no entry, no palette command, Settings › AI is still reachable;
 * - edge: German texts;
 * - edge: "What is sent?" shows the staged example of the open repository, never a .env file or a token.
 *
 *   node scripts/e2e-wd/features/ai-setup.mjs
 *   E2E_WD_ONLY="what is sent" node scripts/e2e-wd/features/ai-setup.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { eventually } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const SETTINGS = '[data-screen="settings"]';
const ENTRY = "[data-ai-setup-entry]";
const PALETTE = '[data-screen="command-palette"]';

/** Local stand-in for Ollama: records every request and knows two models. */
async function startOllama() {
  const requests = [];
  const routes = {
    "GET /api/tags": { models: [{ name: "qwen3:8b" }, { name: "llama3.2:3b" }] },
    "POST /api/show": { model_info: { "qwen3.context_length": 40960 } },
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      const answer = routes[`${req.method} ${req.url}`];
      const text = JSON.stringify(answer ?? { error: "not found" });
      res.writeHead(answer ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
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

const entryGone = (app) => app.waitFor(() => app.exec((css) => !document.querySelector(css), ENTRY), 10_000, { message: "start-page entry hidden" });
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
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), SETTINGS), 5000, { message: "settings closed" });
}

/** Opens the palette with ">text" and tells whether the command with this id is listed (the palette stays open). */
async function paletteOffers(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor(`${PALETTE} input[role="combobox"]`, 10_000);
  await app.type(input, `>${text}`);
  await app.settle(300);
  return app.exec((css, key) => Boolean(document.querySelector(`${css} [role="option"][data-key="command:${key}"]`)), PALETTE, id);
}

async function chooseOption(app, trigger, label) {
  await app.click(await app.waitFor(trigger, 10_000, { message: `select ${trigger}` }));
  const option = await app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="option"]')].find((el) => el.innerText.trim() === wanted) ?? null, label), 5000, { message: `option ${label}` });
  await app.click(option);
}

const masterSwitch = (app) => app.waitFor(() => app.exec(() => document.querySelector('[data-ai-settings] [data-setting="AI features"] [role="switch"]')), 10_000, { message: "master switch" });

// ---------------------------------------------------------------------------------------------

scenario("unset: one muted start-page entry and the palette lead to Settings › AI", "main", withCleanup(async (t) => {
  const app = await t.launch(LAUNCH);
  await app.waitFor(ENTRY, 15_000, { message: "start-page entry" });
  const entry = await app.exec((css) => {
    const el = document.querySelector(css);
    // An array, not an object: WebDriver does not keep the key order, and assertEqual compares JSON text.
    return [el.innerText.trim(), el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true", el.classList.contains("text-text-muted")];
  }, ENTRY);
  assertEqual(entry, ["Set up AI features", false, true], "text, disabled, muted: muted, not disabled");
  assertEqual((await app.invoke("ai_status")).state, "unset");

  await app.exec(() => [...document.querySelectorAll("button")].find((el) => el.innerText.trim() === "Create new …")?.focus());
  await app.press("Tab");
  await app.waitFor(() => app.exec((css) => document.activeElement?.matches(css) ?? false, ENTRY), 5000, { message: "Tab reaches the entry" });
  await t.shot("entry-focused");
  await app.press("Enter");
  await app.waitFor(SETTINGS, 10_000, { message: "settings opened with Enter" });
  await eventually(() => activeTabLabel(app), "AI", "Enter lands on Settings › AI");
  await app.waitFor("[data-ai-settings]", 5000, { message: "the AI section" });
  await closeSettings(app);
  t.step("Tab and Enter");

  await app.click(ENTRY);
  await app.waitFor(SETTINGS, 10_000, { message: "settings opened with a click" });
  await eventually(() => activeTabLabel(app), "AI", "a click lands on Settings › AI");
  await closeSettings(app);
  t.step("click");

  assert(await paletteOffers(app, "Set up AI", "ai.setup"), "the palette offers “Set up AI …”");
  await app.click(await app.waitFor(`${PALETTE} [role="option"][data-key="command:ai.setup"]`));
  await app.waitFor(SETTINGS, 10_000, { message: "settings from the palette" });
  await eventually(() => activeTabLabel(app), "AI", "the palette lands on Settings › AI");
  await t.noConsoleErrors(app);
}));

scenario("connecting a local Ollama in Settings › AI removes the entry and the setup command", "main", withCleanup(async (t) => {
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.click(await app.waitFor(ENTRY, 15_000, { message: "start-page entry" }));
  await app.waitFor("[data-ai-settings]", 10_000, { message: "the AI section" });

  await app.click(await masterSwitch(app));
  await eventually(async () => (await app.invoke("ai_status")).state, "on", "core: AI on");
  assertEqual((await app.invoke("ai_status")).connected, false, "on, but no provider yet");

  await chooseOption(app, '[data-ai-provider] button[role="combobox"]', "Ollama (on this computer)");
  await eventually(async () => (await app.invoke("settings_get")).aiProvider, "ollama", "core: provider ollama");
  await app.click(await app.waitFor("[data-ai-check]", 5000, { message: "Check" }));
  const result = await app.waitFor(() => app.exec(() => document.querySelector('[data-ai-settings] [role="status"]')?.innerText.trim() ?? null), 10_000, { message: "check result" });
  assertEqual(result, "Connected – 2 models found");
  assert(ollama.requests.some((request) => request.method === "GET" && request.url === "/api/tags"), "the check asked the local mock");

  await chooseOption(app, '[data-ai-model] button[role="combobox"]', "qwen3:8b");
  await eventually(async () => (await app.invoke("ai_status")).connected, true, "core: connected");
  await t.shot("ai-connected");
  await closeSettings(app);
  await entryGone(app);
  assert(!(await paletteOffers(app, "Set up AI", "ai.setup")), "no setup command once connected");
  await app.press("Escape");
  assert(!ollama.requests.some((request) => request.url === "/api/chat"), "setting up sends no content");
  await t.noConsoleErrors(app);
}));

scenario("turned off on purpose: no entry, no palette command, Settings › AI still reachable", "edge", withCleanup(async (t) => {
  const app = await t.launch(LAUNCH);
  await app.waitFor(ENTRY, 15_000, { message: "start-page entry" });
  await app.invoke("settings_set", { patch: { aiEnabled: false } });
  await entryGone(app);
  assertEqual((await app.invoke("ai_status")).state, "off");
  assert(!(await paletteOffers(app, "Set up AI", "ai.setup")), "no palette command in off");
  await app.press("Escape");
  await openSettingsAt(app, "AI");
  assertEqual(await (await masterSwitch(app)).attr("aria-checked"), "false");
  await t.shot("ai-off");
  await closeSettings(app);
  await t.noConsoleErrors(app);
}));

scenario("German texts", "edge", withCleanup(async (t) => {
  const app = await t.launch({ ...LAUNCH, lang: "de" });
  const text = await app.waitFor(() => app.exec((css) => document.querySelector(css)?.innerText.trim() ?? null, ENTRY), 15_000, { message: "start-page entry" });
  assertEqual(text, "KI-Funktionen einrichten");
  await app.click(ENTRY);
  await app.waitFor(SETTINGS, 10_000, { message: "Einstellungen" });
  await eventually(() => activeTabLabel(app), "KI", "Einstellungen › KI");
  assertIncludes(await app.exec(() => document.querySelector("[data-ai-settings]")?.innerText ?? ""), "Was wird gesendet?");
  await t.shot("ai-de");
  await t.noConsoleErrors(app);
}));

scenario("What is sent? shows the staged example and never a secret", "edge", withCleanup(async (t) => {
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  fs.mkdirSync(path.join(repo.path, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo.path, "src", "zugang.py"), 'TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\nprint("Zugang für Süd")\n');
  fs.writeFileSync(path.join(repo.path, ".env"), "DB_PASSWORD=hunter2-sehr-geheim\n");
  repo.git("add", "-f", "src/zugang.py", ".env");
  const app = await t.launch(LAUNCH);
  await app.openRepo(repo.path);
  await openSettingsAt(app, "AI");
  await app.click(await app.waitFor("[data-ai-what-is-sent]:not([disabled])", 10_000, { message: "example button, enabled with a repository" }));
  const text = await app.waitFor(() => app.exec(() => document.querySelector("[data-ai-preview-text]")?.textContent ?? null), 15_000, { message: "preview text" });
  assertIncludes(text, "File: src/zugang.py");
  assertIncludes(text, 'print("Zugang für Süd")');
  assert(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "the token is redacted");
  assert(!text.includes("hunter2") && !text.includes("File: .env"), ".env never appears in the text");
  const omitted = await app.exec(() => document.querySelector("[data-ai-omitted]")?.innerText ?? "");
  assertIncludes(omitted, ".env");
  assertIncludes(omitted, "never sent");
  await t.shot("what-is-sent");
  await app.press("Escape");
  await t.noConsoleErrors(app);
}));
