/**
 * AI setup with detection (v1.2, Teilpaket 1b) in the real app. The command-line tools are the fake
 * target/debug/forkyard-fake-cli copied into a temp folder that FORKYARD_AI_CLI_DIR points to (debug
 * builds only: nothing else is searched, so the tools of this machine never show up). Ollama and
 * LM Studio point at a closed port unless a scenario starts a local mock.
 *
 * - main: one signed-in Claude Code → “Turn on with Claude Code” → one click → AI on, nothing sent;
 * - main: “Other choice” → a local Ollama step by step (provider, Check, model, functions);
 * - edge: nothing found → API key / local model / only the cockpit (→ off);
 * - edge: the master switch without a provider opens the setup; Escape leaves AI unset;
 * - edge: a signed-out tool shows its sign-in command and offers no one-click;
 * - edge: German texts.
 *
 *   cargo build && node scripts/e2e-wd/features/ai-setup-cli.mjs
 *   E2E_WD_ONLY="one signed-in" node scripts/e2e-wd/features/ai-setup-cli.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../driver.mjs";
import { eventually } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const SETTINGS = '[data-screen="settings"]';
const ENTRY = "[data-ai-setup-entry]";
const SETUP = "[data-ai-setup]";
const FAKE = path.join(ROOT, "target", "debug", process.platform === "win32" ? "forkyard-fake-cli.exe" : "forkyard-fake-cli");
/** Nothing listens here: no local model of this machine shows up. */
const CLOSED = "http://127.0.0.1:9";

/** The option lines of `claude --help` (Claude Code 2.1.301) that Forkyard reads. */
const CLAUDE_HELP = [
  "  --json-schema <schema>                JSON Schema for structured output",
  "  --model <model>                       Model for the current session. Provide",
  "  --no-session-persistence              Disable session persistence - sessions",
  "  --output-format <format>              Output format (only works with --print):",
  "  -p, --print                           Print response and exit (useful for",
  "  --setting-sources <sources>           Comma-separated list of setting sources",
  "  --strict-mcp-config                   Only use MCP servers from --mcp-config,",
  "  --tools <tools...>                    Specify the list of available tools from",
].join("\n");

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

function cliFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-ai-cli-"));
  t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const launchEnv = (dir, extra = {}) => ({ FORKYARD_AI_CLI_DIR: dir, FORKYARD_AI_BASE_URL_OLLAMA: CLOSED, FORKYARD_AI_BASE_URL_LMSTUDIO: `${CLOSED}/v1`, ...extra });

/** Copies the fake tool as `claude` into `dir`, signed in or not; returns its recorded calls. */
function installClaude(dir, { loggedIn }) {
  assert(fs.existsSync(FAKE), `${FAKE} is missing – run cargo build first`);
  const program = path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
  fs.copyFileSync(FAKE, program);
  fs.chmodSync(program, 0o755);
  const status = { loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" };
  const answer = { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.0123, usage: { input_tokens: 120, output_tokens: 9 }, structured_output: { summary: "Fix login", body: null } };
  const config = {
    rules: [
      { args: ["--version"], stdout: "2.1.301 (Claude Code)\n" },
      { args: ["--help"], stdout: CLAUDE_HELP },
      { args: ["auth", "status", "--json"], stdout: JSON.stringify(status), exit: loggedIn ? 0 : 1 },
      { prefix: ["-p"], stdout: JSON.stringify(answer) },
    ],
    fallback: { exit: 2, stderr: "fake claude: unknown call" },
  };
  fs.writeFileSync(path.join(dir, "claude.fake.json"), JSON.stringify(config));
  const log = path.join(dir, "claude.calls.jsonl");
  return {
    program,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

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

const textOf = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.trim() ?? null, css);
const stepIs = (app, step) => app.waitFor(`${SETUP}[data-step="${step}"]`, 10_000, { message: `setup step ${step}` });
const setupGone = (app) => app.waitFor(() => app.exec((css) => !document.querySelector(css), SETUP), 5000, { message: "setup closed" });
const entryGone = (app) => app.waitFor(() => app.exec((css) => !document.querySelector(css), ENTRY), 10_000, { message: "start-page entry hidden" });
const masterSwitch = (app) => app.waitFor(() => app.exec(() => document.querySelector('[data-ai-settings] [data-setting="AI features"] [role="switch"]')), 10_000, { message: "master switch" });

async function openAiSettings(app) {
  await app.click(await app.waitFor(ENTRY, 15_000, { message: "start-page entry" }));
  await app.waitFor("[data-ai-settings]", 10_000, { message: "Settings › AI" });
}

/** Start page → Settings › AI → “Set up …”, until the search is done. */
async function openSetup(app) {
  await openAiSettings(app);
  await app.click(await app.waitFor("[data-ai-setup-open]", 5000, { message: "Set up …" }));
  await stepIs(app, "found");
}

async function closeSettings(app) {
  await app.press("Escape");
  await app.waitFor(() => app.exec((css) => !document.querySelector(css), SETTINGS), 5000, { message: "settings closed" });
}

async function chooseOption(app, trigger, label) {
  await app.click(await app.waitFor(trigger, 10_000, { message: `select ${trigger}` }));
  const option = await app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="option"]')].find((el) => el.innerText.trim() === wanted) ?? null, label), 5000, { message: `option ${label}` });
  await app.click(option);
}

// ---------------------------------------------------------------------------------------------

scenario("one signed-in Claude Code: the setup turns AI on with one click", "main", withCleanup(async (t) => {
  const dir = cliFolder(t);
  const claude = installClaude(dir, { loggedIn: true });
  const app = await t.launch({ ...LAUNCH, env: launchEnv(dir) });
  await openSetup(app);
  const find = await textOf(app, '[data-ai-find="cli:claude_code"]');
  assertIncludes(find, "Claude Code");
  assertIncludes(find, "Version 2.1.301");
  assertIncludes(find, "Signed in (claude.ai)");
  assertIncludes(find, claude.program);
  assertEqual(await app.exec(() => document.querySelector('[data-ai-find="cli:claude_code"] input[type="radio"]')?.checked ?? null), true, "preselected");
  assertEqual(await textOf(app, "[data-ai-setup-primary]"), "Turn on with Claude Code");
  await t.shot("setup-one-tool");

  await app.click("[data-ai-setup-primary]");
  await app.waitFor("[data-ai-setup-done]", 10_000, { message: "done step" });
  assertIncludes(await textOf(app, "[data-ai-setup-done]"), "Requests go to Claude Code on this computer");
  const status = await app.invoke("ai_status");
  assertEqual(
    { state: status.state, provider: status.provider, model: status.model, connected: status.connected, featuresOff: status.featuresOff },
    { state: "on", provider: "claude_code", model: null, connected: true, featuresOff: [] },
  );
  assert(!claude.calls().some((call) => call.args[0] === "-p"), "setting up sends no content");
  await t.shot("setup-done");
  await app.click("[data-ai-setup-close]");
  await setupGone(app);
  await closeSettings(app);
  await entryGone(app);
  await t.noConsoleErrors(app);
}));

scenario("other choice: a local Ollama step by step", "main", withCleanup(async (t) => {
  const dir = cliFolder(t);
  installClaude(dir, { loggedIn: true });
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const app = await t.launch({ ...LAUNCH, env: launchEnv(dir, { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url }) });
  await openSetup(app);
  assertIncludes(await textOf(app, '[data-ai-find="local:ollama"]'), "2 models");
  await app.click("[data-ai-setup-other]");
  await stepIs(app, "provider");
  await chooseOption(app, '[data-ai-setup-provider] button[role="combobox"]', "Ollama (on this computer)");
  assertEqual(await app.exec(() => document.querySelector("[data-ai-setup-primary]")?.disabled ?? null), true, "Continue only after a successful check");
  await app.click(await app.waitFor("[data-ai-setup-check]", 5000, { message: "Check" }));
  const result = await app.waitFor(() => app.exec((css) => document.querySelector(`${css} [data-ai-setup-check] ~ [role="status"]`)?.innerText.trim() ?? null, SETUP), 10_000, { message: "check result" });
  assertEqual(result, "Connected – 2 models found");
  await app.click("[data-ai-setup-primary]");
  await stepIs(app, "model");
  await chooseOption(app, '[data-ai-setup-model] button[role="combobox"]', "llama3.2:3b");
  await app.click("[data-ai-setup-primary]");
  await stepIs(app, "features");
  await app.click('[data-ai-setup-feature="compose"] [role="switch"]');
  await t.shot("setup-features");
  await app.click("[data-ai-setup-primary]");
  await app.waitFor("[data-ai-setup-done]", 10_000, { message: "done step" });
  assertIncludes(await textOf(app, "[data-ai-setup-done]"), "Requests stay on this computer (Ollama).");
  const settings = await app.invoke("settings_get");
  assertEqual(
    { aiEnabled: settings.aiEnabled, aiProvider: settings.aiProvider, aiModel: settings.aiModel, aiFeaturesOff: settings.aiFeaturesOff },
    { aiEnabled: true, aiProvider: "ollama", aiModel: "llama3.2:3b", aiFeaturesOff: ["compose"] },
  );
  assertEqual((await app.invoke("ai_status")).connected, true);
  assert(!ollama.requests.some((request) => request.url === "/api/chat"), "setting up sends no content");
  await app.click("[data-ai-setup-close]");
  await setupGone(app);
  await t.noConsoleErrors(app);
}));

scenario("nothing found: an API key, a local model or only the cockpit", "edge", withCleanup(async (t) => {
  const dir = cliFolder(t);
  const app = await t.launch({ ...LAUNCH, env: launchEnv(dir) });
  await openSetup(app);
  assertIncludes(await textOf(app, SETUP), "No AI tool, local model or stored key was found.");
  for (const option of ["key", "local", "cockpit"]) {
    assert(await app.exec((name) => Boolean(document.querySelector(`[data-ai-setup-nothing-option="${name}"]`)), option), `option ${option}`);
  }
  assertEqual(await app.exec(() => document.querySelector("[data-ai-setup-primary]")?.disabled ?? null), true, "nothing to turn on");
  await app.click('[data-ai-setup-nothing-option="key"]');
  await stepIs(app, "provider");
  await app.click("[data-ai-setup-back]");
  await stepIs(app, "found");
  await t.shot("setup-nothing");
  await app.click('[data-ai-setup-nothing-option="cockpit"]');
  await setupGone(app);
  await eventually(async () => (await app.invoke("ai_status")).state, "off", "only the cockpit: AI off on purpose");
  await closeSettings(app);
  await entryGone(app);
  await t.noConsoleErrors(app);
}));

scenario("the master switch without a provider opens the setup; Escape leaves AI unset", "edge", withCleanup(async (t) => {
  const dir = cliFolder(t);
  const app = await t.launch({ ...LAUNCH, env: launchEnv(dir) });
  await openAiSettings(app);
  await app.click(await masterSwitch(app));
  await stepIs(app, "found");
  await app.press("Escape");
  await setupGone(app);
  assertEqual((await app.invoke("ai_status")).state, "unset", "Cancel changes nothing");
  assertEqual(await (await masterSwitch(app)).attr("aria-checked"), "false");
  assert(await app.exec(() => Boolean(document.querySelector("[data-ai-settings]"))), "Settings › AI stays open");
  await t.noConsoleErrors(app);
}));

scenario("a signed-out tool shows how to sign in and offers no one-click", "edge", withCleanup(async (t) => {
  const dir = cliFolder(t);
  installClaude(dir, { loggedIn: false });
  const app = await t.launch({ ...LAUNCH, env: launchEnv(dir) });
  await openSetup(app);
  const find = await textOf(app, '[data-ai-find="cli:claude_code"]');
  assertIncludes(find, "Not signed in");
  assertIncludes(find, "claude auth login");
  assertEqual(await app.exec(() => document.querySelector('[data-ai-find="cli:claude_code"]')?.getAttribute("data-login") ?? null), "logged_out");
  assertEqual(await app.exec(() => document.querySelector('[data-ai-find="cli:claude_code"] input[type="radio"]')?.disabled ?? null), true);
  assertEqual(await app.exec(() => document.querySelector("[data-ai-setup-primary]")?.disabled ?? null), true);
  assert(await app.exec(() => Boolean(document.querySelector("[data-ai-setup-nothing]"))), "the other ways are offered");
  assert(await app.exec(() => !document.querySelector("[data-ai-setup-sign-in]")), "no repository open: the command is shown as text, no terminal");
  await t.shot("setup-signed-out");
  await app.press("Escape");
  await setupGone(app);
  await t.noConsoleErrors(app);
}));

scenario("German texts", "edge", withCleanup(async (t) => {
  const dir = cliFolder(t);
  installClaude(dir, { loggedIn: true });
  const app = await t.launch({ ...LAUNCH, lang: "de", env: launchEnv(dir) });
  await openAiSettings(app);
  assertEqual(await textOf(app, "[data-ai-setup-open]"), "Einrichten …");
  await app.click("[data-ai-setup-open]");
  await stepIs(app, "found");
  const titles = await app.exec(() => [...document.querySelectorAll('[role="dialog"] h2')].map((heading) => heading.innerText.trim()));
  assert(titles.includes("KI einrichten"), JSON.stringify(titles));
  assertEqual(await textOf(app, "[data-ai-setup-primary]"), "Mit Claude Code einschalten");
  assertIncludes(await textOf(app, '[data-ai-find="cli:claude_code"]'), "Angemeldet (claude.ai)");
  await t.shot("setup-de");
  await app.press("Escape");
  await setupGone(app);
  await t.noConsoleErrors(app);
}));
