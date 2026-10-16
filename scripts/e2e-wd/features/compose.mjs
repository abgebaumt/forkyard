/**
 * "Compose commits" (v1.2, Teilpaket 3.2) in the real app, against a local stand-in for Ollama
 * (FORKYARD_AI_BASE_URL_OLLAMA, debug builds only) – never a real provider:
 *
 * - main: "Compose …" in the Commit Panel opens the view, the suggestion makes one commit per file,
 *   "Create 2 commits" creates them (checked with git log), the toast's Undo takes both back;
 * - edge: keyboard – 0 moves a change to "Don't commit", Alt+↓ back into commit 1, F2 edits the
 *   summary, Ctrl+Enter creates the commits;
 * - edge: a pre-commit hook that rejects the second commit leaves HEAD and the index as they were.
 *
 *   node scripts/e2e-wd/features/compose.mjs
 *   E2E_WD_ONLY="keyboard" node scripts/e2e-wd/features/compose.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { commitUi, eventually, lines, readText, until } from "../fixtures/commit-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const VIEW = '[data-screen="compose"]';

/** One commit "Update <file>" per file, in the order the prompt names the files (the core's format). */
function groupPerFile(user) {
  const commits = [];
  let current = null;
  for (const line of user.split("\n")) {
    const file = /^File: (.+?)(?: \(renamed from .*?\))?(?: [+–].*)?$/.exec(line);
    if (file) {
      current = { title: `Update ${file[1]}`, body: "", units: [] };
      commits.push(current);
    }
    for (const match of line.matchAll(/\[unit (u\d+)\]/g)) current?.units.push(match[1]);
  }
  return { commits: commits.filter((commit) => commit.units.length > 0) };
}

/** Local stand-in for Ollama: records every chat and answers with `groupPerFile`. */
async function startOllama() {
  const chats = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let answer = null;
      if (req.method === "POST" && req.url === "/api/show") answer = { model_info: { "qwen3.context_length": 40960 } };
      else if (req.method === "GET" && req.url === "/api/tags") answer = { models: [{ name: "qwen3:8b" }] };
      else if (req.method === "POST" && req.url === "/api/chat") {
        const user = JSON.parse(body).messages.find((message) => message.role === "user")?.content ?? "";
        chats.push(user);
        answer = { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(groupPerFile(user)) }, done: true, done_reason: "stop", prompt_eval_count: 200, eval_count: 40 };
      }
      const text = JSON.stringify(answer ?? { error: "not found" });
      res.writeHead(answer ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
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

/** README.md and stationen.csv changed; optionally a pre-commit hook (written before opening: trust). */
async function setup(t, { hook } = {}) {
  const ollama = await startOllama();
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => ollama.close(), () => repo.cleanup());
  repo.write("README.md", `${readText(repo, "README.md")}\nStand: Auswertung für März begonnen.\n`);
  repo.write("stationen.csv", `${readText(repo, "stationen.csv")}W;Wald;212\n`);
  if (hook) {
    const file = path.join(repo.path, ".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${hook}\n`);
    fs.chmodSync(file, 0o755);
  }
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0, aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
  const ui = commitUi(app);
  const { repoId, tabId } = await app.openRepo(repo.path);
  t.step("repository opened, AI on with the local stand-in");
  return { repo, app, ui, ollama, repoId, tabId };
}

async function openCompose(app) {
  await app.click(await app.waitFor("[data-compose-open]:not([aria-disabled])", 15_000, { message: "“Compose …” in the Commit Panel" }));
  await app.waitFor(VIEW, 10_000, { message: "compose view" });
}

const commitTitles = (app) =>
  app.exec((css) => [...document.querySelectorAll(`${css} [data-compose-group]:not([data-compose-group="skip"]) [data-compose-commit-title]`)].map((el) => el.textContent.trim()), VIEW);
const unitGroup = (app, file) => app.exec((css, p) => document.querySelector(`${css} [data-compose-unit][data-path="${p}"]`)?.getAttribute("data-group") ?? null, VIEW, file);
const applyButton = (app) => app.waitFor(`${VIEW} [data-action="compose-apply"]:not([data-blocked])`, 5000, { message: "“Create 2 commits”" });

// ---------------------------------------------------------------------------------------------

scenario("Compose suggests one commit per file, creates both and one Undo takes them back", "main", withCleanup(async (t) => {
  const { repo, app, ui, ollama } = await setup(t);
  const before = repo.git("rev-parse", "HEAD");
  await openCompose(app);
  await eventually(() => commitTitles(app), ["Update README.md", "Update stationen.csv"], "the suggestion groups per file", 20_000);
  assertEqual(ollama.chats.length, 1, "one request to the provider");
  assertIncludes(ollama.chats[0], "[unit u1]");
  assert(!/#(\d+|file)@[0-9a-f]{32}/.test(ollama.chats[0]), "unit IDs never go out, only aliases");
  await t.shot("compose-suggested");

  await app.click(await applyButton(app));
  await ui.waitToast("success", /2 commits created/);
  assertEqual(lines(repo.git("log", "-2", "--format=%s")), ["Update stationen.csv", "Update README.md"], "git: two commits, the first of the plan is the older");
  assertEqual(lines(repo.git("show", "--name-only", "--format=", "HEAD")), ["stationen.csv"], "git: the second commit has stationen.csv only");
  assertEqual(repo.git("rev-parse", "HEAD~2"), before, "git: both on top of the old HEAD");
  assertEqual(repo.git("status", "--porcelain"), "", "git: clean");
  await t.shot("compose-created");

  await app.click({ text: "Undo", within: "[data-toast]" });
  // Undo moves the branch first and restores the index snapshot after that: wait for the whole end state.
  await eventually(
    () => ({ head: repo.git("rev-parse", "HEAD"), unstaged: lines(repo.git("diff", "--name-only")), staged: repo.git("diff", "--cached", "--name-only") }),
    { head: before, unstaged: ["README.md", "stationen.csv"], staged: "" },
    "git: Undo takes both commits back, the changes are unstaged as before",
  );
  await t.noConsoleErrors(app);
}));

scenario("keyboard: 0 to Don't commit, Alt+↓ back into commit 1, F2 edits the summary, Ctrl+Enter creates", "edge", withCleanup(async (t) => {
  const { repo, app, ui } = await setup(t);
  await openCompose(app);
  await eventually(() => commitTitles(app), ["Update README.md", "Update stationen.csv"], "the suggestion", 20_000);

  await app.click(await app.waitFor(`${VIEW} [data-compose-unit][data-path="README.md"]`, 5000, { message: "the README.md row" }));
  await app.press("0");
  await eventually(() => unitGroup(app, "README.md"), "skip", "0 moves the change to “Don't commit”");
  await app.press("Alt+ArrowDown");
  await eventually(() => unitGroup(app, "README.md"), "0", "Alt+↓ moves it into commit 1");
  await app.press("F2");
  await until(() => app.exec(() => document.activeElement?.matches("[data-compose-title]") ?? false), "F2 focuses the summary of commit 1");
  await app.press("End");
  await app.type(await app.waitFor(`${VIEW} [data-compose-title]`), " (geprüft)");
  await t.shot("compose-keyboard");
  await app.press("Control+Enter");
  await ui.waitToast("success", /2 commits created/);
  assertEqual(lines(repo.git("log", "-2", "--format=%s")), ["Update stationen.csv", "Update README.md (geprüft)"], "git: the edited summary");
  await t.noConsoleErrors(app);
}));

scenario("a pre-commit hook that rejects the second commit leaves HEAD and the index as they were", "edge", withCleanup(async (t) => {
  const { repo, app, ui } = await setup(t, { hook: "if git diff --cached --name-only | grep -q '^stationen.csv$'; then echo 'stationen.csv ist gesperrt'; exit 1; fi" });
  const before = repo.git("rev-parse", "HEAD");
  await openCompose(app);
  await eventually(() => commitTitles(app), ["Update README.md", "Update stationen.csv"], "the suggestion", 20_000);

  await app.click(await applyButton(app));
  const message = await ui.waitToast("danger", /pre-commit/);
  assertIncludes(message, "stationen.csv ist gesperrt", "the hook's output is shown");
  assertEqual(repo.git("rev-parse", "HEAD"), before, "git: the first commit was taken back");
  assertEqual(repo.git("diff", "--cached", "--name-only"), "", "git: the index is as before");
  assertEqual(lines(repo.git("diff", "--name-only")), ["README.md", "stationen.csv"], "git: the changes are untouched");
  assertEqual(repo.git("for-each-ref", "refs/forkyard/"), "", "git: no backup refs are left");
  await app.waitFor(VIEW, 2000, { message: "the view stays open" });
  await t.shot("compose-hook-rejected");
  await t.noConsoleErrors(app);
}));
