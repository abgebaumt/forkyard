/**
 * Bisect autopilot in the real app (v1.2, 9.1), with a local Ollama stand-in that answers with a
 * fixed test script. The oracle for "first bad commit" is the fixture's own bug commit; every
 * verdict is checked against the file Git has at that commit.
 *
 * - main: from the context menu of the bad commit with a tag as good commit: description → "Write
 *   script" → the fixed script appears as a draft → Run → the bar names the first bad commit; the
 *   own working directory (with changes) and its Git directory are untouched; `<repo>.agents/bisect-1`
 *   exists (locked) while the result is open and goes with "Remove worktree";
 * - edge: from the palette, "Keep worktree" leaves it unlocked on the first bad commit;
 * - edge: from the bar of a running manual bisect – the manual bisect stays exactly as it was;
 * - edge: "Stop" ends a slow script and removes the worktree;
 * - edge: AI not set up – no menu entry and no palette command; after connecting, both appear.
 *
 *   node scripts/e2e-wd/features/bisect-autopilot.mjs
 *   E2E_WD_ONLY="stop" node scripts/e2e-wd/features/bisect-autopilot.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";
import { gitBisect, hasBug, makeBisectRepo } from "../fixtures/bisect.mjs";
import { closeToasts, rightClick } from "../fixtures/rebase.mjs";
import { eventually } from "../fixtures/commit-ui.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const PALETTE = '[data-screen="command-palette"]';
const FORMULA_SCRIPT = "if grep -q '5 / 9' umrechnung.py; then exit 1; fi\nexit 0\n";
const SLOW_SCRIPT = "sleep 120\nexit 0\n";
const short = (sha) => sha.slice(0, 7);

/** Local stand-in for Ollama: one model, and every chat answers with `script`. */
async function startOllama(script) {
  const requests = [];
  const chat = {
    model: "qwen3:8b",
    message: { role: "assistant", content: JSON.stringify({ script, summary: "Checks whether the formula swaps the factors." }) },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 50,
    eval_count: 7,
  };
  const routes = { "GET /api/tags": { models: [{ name: "qwen3:8b" }] }, "POST /api/show": { model_info: { "qwen3.context_length": 40960 } }, "POST /api/chat": chat };
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

async function connectAi(app) {
  await app.invoke("settings_set", { patch: { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
  await eventually(async () => (await app.invoke("ai_status")).connected, true, "core: connected to the local mock");
}

async function launchWithAi(t, script) {
  const ollama = await startOllama(script);
  t.cleanups.push(() => ollama.close());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await connectAi(app);
  return { app, ollama };
}

async function openGraph(app, repo) {
  const ids = await app.openRepo(repo.path);
  await app.waitFor('[data-screen="commit-graph"][data-state="ready"]', 30_000);
  await app.settle();
  return ids;
}

const row = (app, sha) => app.waitFor(`[data-row-id="${sha}"] [data-cell="message"]`, 15_000);
const menuItem = (app, label) =>
  app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim().startsWith(wanted)) ?? null, label), 8000, { message: `menu item "${label}"` });
const menuLabels = (app) => app.exec(() => [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent.replace(/\s+/g, " ").trim()));
const dialogTitled = (app, title) =>
  app.waitFor(
    () =>
      app.exec((wanted) => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((node) => {
        const label = node.getAttribute("aria-labelledby");
        const name = (label ? document.getElementById(label)?.textContent : node.getAttribute("aria-label")) ?? "";
        return name.trim().startsWith(wanted);
      }) ?? null, title),
    10_000,
    { message: `dialog "${title}"` },
  );
const noDialog = (app) => app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), 8000, { message: "dialog closed" });
const buttonIn = (app, root, text) =>
  app.waitFor(() => app.exec((scope, wanted) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === wanted) ?? null, root, text), 8000, { message: `button "${text}"` });

/** The good commit from the chooser: the tag v1.0 of the fixture. */
async function pickTag(app) {
  const box = await dialogTitled(app, "Bisect autopilot");
  const option = await app.waitFor(() => app.exec((scope) => [...scope.querySelectorAll('[role="option"]')].find((node) => node.querySelector("span")?.textContent.trim() === "v1.0") ?? null, box), 8000, { message: "option v1.0" });
  await app.click(option);
  await app.click(await buttonIn(app, box, "Continue"));
}

/** Description → Write script → the mock's script in the editor → Run. */
async function writeAndRun(app, expected) {
  await app.waitFor("[data-bisect-autopilot-dialog]", 10_000, { message: "autopilot dialog" });
  await app.type(await app.waitFor("[data-autopilot-description]"), "Fahrenheit values are too low");
  await app.click("[data-autopilot-write]:not([disabled])");
  const script = await app.waitFor(() => app.exec(() => document.querySelector("[data-autopilot-script]")?.value || null), 20_000, { message: "script from the mock" });
  assertEqual(script, expected, "the mock's script, unchanged");
  assertIncludes(await app.exec(() => document.querySelector("[data-bisect-autopilot-dialog]")?.innerText ?? ""), "Draft");
  await app.click("[data-autopilot-run]:not([disabled])");
  await noDialog(app);
}

const autopilotBar = (app) =>
  app.exec(() => {
    const node = document.querySelector("[data-bisect-autopilot]");
    return node ? { kind: node.dataset.bisectAutopilot, text: node.innerText.replace(/\s+/g, " ").trim() } : null;
  });
async function waitAutopilot(app, kind, timeout = 20_000) {
  return app.waitFor(async () => {
    const now = await autopilotBar(app);
    return kind === null ? (now === null ? { kind: null } : null) : now?.kind === kind ? now : null;
  }, timeout, { message: `autopilot bar ${kind ?? "hidden"}` }).catch(async (error) => {
    throw new Error(`${error.message}; is ${JSON.stringify(await autopilotBar(app))}`);
  });
}

async function paletteOffers(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor(`${PALETTE} input[role="combobox"]`, 10_000);
  await app.type(input, `>${text}`);
  await app.settle(300);
  return app.exec((css, key) => Boolean(document.querySelector(`${css} [role="option"][data-key="command:${key}"]`)), PALETTE, id);
}

const worktreeOf = (repo) => `${repo.path}.agents/bisect-1`;

// ---------------------------------------------------------------------------------------------

scenario("main: from the context menu, the autopilot names the first bad commit and leaves the own working directory alone", "main", withCleanup(async (t) => {
  const { repo, head, bug } = makeBisectRepo({ name: "autopilot-main" });
  t.cleanups.push(() => repo.cleanup());
  fs.appendFileSync(path.join(repo.path, "messwerte.csv"), "2026-05-01;99.9\n");
  fs.writeFileSync(path.join(repo.path, "notizen ä.txt"), "nicht committen\n");
  const statusBefore = repo.git("status", "--porcelain=v2", "--untracked-files=all");
  const headBefore = repo.tip("HEAD");
  const { app, ollama } = await launchWithAi(t, FORMULA_SCRIPT);
  const { repoId } = await openGraph(app, repo);

  await rightClick(app, await row(app, head));
  await app.click(await menuItem(app, "Bisect autopilot"));
  await pickTag(app);
  await writeAndRun(app, FORMULA_SCRIPT);
  const sent = JSON.parse(ollama.requests.find((request) => request.url === "/api/chat").body);
  assertIncludes(sent.messages[1].content, "Umrechnung vereinfacht", "the range's subjects went out");

  const found = await waitAutopilot(app, "found", 60_000);
  assertIncludes(found.text, `First bad commit: ${short(bug)}`);
  const run = await app.invoke("bisect_autopilot_status", { repoId });
  assertEqual(run.result, bug, "the fixture's bug commit");
  for (const step of run.steps) assertEqual(step.verdict, hasBug(repo, step.sha) ? "bad" : "good", `verdict of ${short(step.sha)}`);
  assertEqual(repo.git("status", "--porcelain=v2", "--untracked-files=all"), statusBefore, "own working directory unchanged");
  assertEqual(repo.tip("HEAD"), headBefore);
  assertEqual(gitBisect(repo).active, false, "no bisect in the own Git directory");
  assert(fs.existsSync(worktreeOf(repo)), "temporary worktree while the result is open");
  assertIncludes(repo.git("worktree", "list", "--porcelain"), "locked Forkyard bisect autopilot");
  await t.shot("autopilot-found");

  await app.click('[data-bisect-autopilot] [data-autopilot-action="remove"]');
  await waitAutopilot(app, null);
  assert(!fs.existsSync(worktreeOf(repo)), "worktree removed");
  assert(!repo.git("worktree", "list", "--porcelain").includes("bisect-1"));
  await t.noConsoleErrors(app);
}));

scenario("edge: from the palette, Keep worktree leaves it unlocked on the first bad commit", "edge", withCleanup(async (t) => {
  const { repo, bug } = makeBisectRepo({ name: "autopilot-keep" });
  t.cleanups.push(() => repo.cleanup());
  const { app } = await launchWithAi(t, FORMULA_SCRIPT);
  await openGraph(app, repo);
  assert(await paletteOffers(app, "Bisect autopilot", "bisect.autopilot"), "the palette offers the autopilot");
  await app.click(await app.waitFor(`${PALETTE} [role="option"][data-key="command:bisect.autopilot"]`));
  await pickTag(app);
  await writeAndRun(app, FORMULA_SCRIPT);
  await waitAutopilot(app, "found", 60_000);
  await app.click('[data-bisect-autopilot] [data-autopilot-action="keep"]');
  await waitAutopilot(app, null);
  const listed = repo.git("worktree", "list", "--porcelain");
  assertIncludes(listed, "bisect-1");
  assert(!listed.includes("locked"), "a kept worktree is unlocked");
  assertEqual(repo.git("-C", worktreeOf(repo), "rev-parse", "HEAD"), bug, "the kept worktree shows the first bad commit");
  await closeToasts(app);
  await t.noConsoleErrors(app);
}));

scenario("edge: from the bar of a running manual bisect, the manual bisect stays as it was", "edge", withCleanup(async (t) => {
  const { repo, good, head, bug } = makeBisectRepo({ name: "autopilot-manual" });
  t.cleanups.push(() => repo.cleanup());
  repo.git("bisect", "start", head, good);
  const before = gitBisect(repo);
  const { app } = await launchWithAi(t, FORMULA_SCRIPT);
  await openGraph(app, repo);
  await app.click(await app.waitFor("[data-graph-bisect] [data-bisect-autopilot-open]:not([disabled])", 15_000, { message: "Autopilot … in the bisect bar" }));
  await writeAndRun(app, FORMULA_SCRIPT);
  const found = await waitAutopilot(app, "found", 60_000);
  assertIncludes(found.text, short(bug));
  const after = gitBisect(repo);
  assertEqual([after.refs, after.log, after.head], [before.refs, before.log, before.head], "manual bisect: refs, log and HEAD unchanged");
  await app.click('[data-bisect-autopilot] [data-autopilot-action="remove"]');
  await waitAutopilot(app, null);
  await t.noConsoleErrors(app);
}));

scenario("edge: Stop ends a slow script and removes the worktree", "edge", withCleanup(async (t) => {
  const { repo, head } = makeBisectRepo({ name: "autopilot-stop" });
  t.cleanups.push(() => repo.cleanup());
  const { app } = await launchWithAi(t, SLOW_SCRIPT);
  await openGraph(app, repo);
  await rightClick(app, await row(app, head));
  await app.click(await menuItem(app, "Bisect autopilot"));
  await pickTag(app);
  await writeAndRun(app, SLOW_SCRIPT);
  const running = await waitAutopilot(app, "testing", 30_000);
  assertIncludes(running.text, "Running · Step 1 of");
  assert(fs.existsSync(worktreeOf(repo)), "worktree while running");
  await t.shot("autopilot-running");
  await app.click('[data-bisect-autopilot] [data-autopilot-action="stop"]');
  await waitAutopilot(app, null);
  await eventually(() => fs.existsSync(worktreeOf(repo)), false, "worktree removed after Stop");
  assert(!repo.git("worktree", "list", "--porcelain").includes("bisect-1"));
  await t.noConsoleErrors(app);
}));

scenario("edge: AI not set up – no menu entry, no palette command; connecting shows both", "edge", withCleanup(async (t) => {
  const { repo, head } = makeBisectRepo({ name: "autopilot-hidden" });
  t.cleanups.push(() => repo.cleanup());
  const ollama = await startOllama(FORMULA_SCRIPT);
  t.cleanups.push(() => ollama.close());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  assertEqual((await app.invoke("ai_status")).state, "unset");
  await openGraph(app, repo);
  await rightClick(app, await row(app, head));
  await menuItem(app, "Start bisect");
  assert(!(await menuLabels(app)).some((label) => label.startsWith("Bisect autopilot")), "no autopilot entry while AI is not set up");
  await app.press("Escape");
  assert(!(await paletteOffers(app, "Bisect autopilot", "bisect.autopilot")), "no palette command");
  await app.press("Escape");

  await connectAi(app);
  await rightClick(app, await row(app, head));
  await menuItem(app, "Bisect autopilot");
  await app.press("Escape");
  assert(await paletteOffers(app, "Bisect autopilot", "bisect.autopilot"), "the palette offers it once AI is connected");
  await app.press("Escape");
  assert(!ollama.requests.some((request) => request.url === "/api/chat"), "nothing was sent");
  await t.noConsoleErrors(app);
}));
