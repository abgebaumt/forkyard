/**
 * Release notes in the real app (v1.2, Teilpaket 7.2):
 *
 * - main: the tag dialog writes grouped notes (a local Ollama stand-in behind
 *   FORKYARD_AI_BASE_URL_OLLAMA, debug builds only) into the annotation; with "Insert into
 *   CHANGELOG.md" and "Create release on GitHub" the tag is created, CHANGELOG.md gets a normal
 *   change, the annotated tag is pushed to the forge and the release is created there;
 * - edge: hidden while AI is not set up and in a repository with "AI off", back when switched on;
 * - edge: German, from the commit menu: "What is sent?" shows the commits without a token, the
 *   notes go to the clipboard.
 *
 *   cargo build && node scripts/e2e-wd/features/release-notes.mjs
 *   E2E_WD_ONLY="commit menu" node scripts/e2e-wd/features/release-notes.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { startForge } from "../fixtures/github-gitlab-host.mjs";
import { rightClick, waitToast } from "../fixtures/rebase.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };
const AI_ON = { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Local stand-in for Ollama: sorts every "- <id> <subject>" line of the prompt into added or fixed. */
async function startOllama() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: raw });
      let answer = null;
      if (req.method === "GET" && req.url === "/api/tags") answer = { models: [{ name: "qwen3:8b" }] };
      if (req.method === "POST" && req.url === "/api/show") answer = { model_info: { "qwen3.context_length": 40960 } };
      if (req.method === "POST" && req.url === "/api/chat") {
        const body = JSON.parse(raw || "{}");
        const prompt = (body.messages ?? []).map((message) => message.content ?? "").join("\n");
        const commits = [...prompt.matchAll(/^- ([0-9a-f]{12}) (.+)$/gm)].map((match) => ({ id: match[1], subject: match[2].trim() }));
        const fixed = commits.filter((commit) => /behoben|fix/i.test(commit.subject));
        const added = commits.filter((commit) => !fixed.includes(commit));
        const content = { language: "de", added: added.map((c) => ({ text: c.subject, commits: [c.id] })), changed: [], fixed: fixed.map((c) => ({ text: c.subject, commits: [c.id] })), other: [] };
        answer = { model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(content) }, done: true, done_reason: "stop", prompt_eval_count: 200, eval_count: 50 };
      }
      const text = JSON.stringify(answer ?? { error: "not found" });
      res.writeHead(answer ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, chats: () => requests.filter((r) => r.url === "/api/chat").length, close: () => new Promise((resolve) => server.close(resolve)) };
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

async function palette(app, text, commandId) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const optionCss = `[data-screen="command-palette"] [role="option"][data-key="command:${commandId}"]`;
  for (let attempt = 0; ; attempt++) {
    try {
      await app.click(await app.waitFor(optionCss, 10_000, { message: `palette entry ${commandId}` }));
      break;
    } catch (error) {
      if (attempt < 3 && /stale element|not interactable/.test(error.message)) {
        await sleep(200);
        continue;
      }
      throw error;
    }
  }
  await app.waitFor(async () => !(await app.$('[data-screen="command-palette"]')), 10_000, { message: "palette closed" });
}

const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
const value = (app, css) => app.exec((selector) => document.querySelector(selector)?.value ?? null, css);
const buttonByText = (app, label) =>
  app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((el) => el.innerText.trim() === wanted) ?? null, label), 10_000, { message: `button ${label}` });
const menuItem = (app, label) =>
  app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim().startsWith(wanted)) ?? null, label), 8000, { message: `menu item "${label}"` });
const menuLabels = (app) => app.exec(() => [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent.replace(/\s+/g, " ").trim()));
const noDialog = (app) => app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"]')), 10_000, { message: "dialog closed" });

async function eventually(fn, expected, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (JSON.stringify(last) === JSON.stringify(expected)) return last;
    if (Date.now() > deadline) throw new Error(`${message}: expected ${JSON.stringify(expected)}, last ${JSON.stringify(last)}`);
    await sleep(120);
  }
}

/** A settings command through the core; `repo_settings_set` emits no event for `aiOff`, so the UI's queries are refreshed. */
async function setThrough(app, command, args) {
  await app.invoke(command, args);
  await app.exec(() => window.__gc.queryClient.invalidateQueries().then(() => true));
  await app.settle();
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const commit = (repo, file, content, message, ...more) => {
  repo.write(file, content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message, ...more);
  return repo.git("rev-parse", "HEAD");
};

// ---------------------------------------------------------------------------------------------

scenario("tag dialog: grouped release notes become the tag message, a CHANGELOG entry and a GitHub release", "main", withCleanup(async (t) => {
  const forge = await startForge();
  t.cleanups.push(() => forge.close());
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const repo = forge.makeRepo("github");
  commit(repo, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n", "Changelog angelegt");
  repo.git("tag", "-a", "v1.0.0", "-m", "Erste Version");
  commit(repo, "src/export.py", '"""Schreibt die Tagesmittel als CSV."""\n', "Export der Tagesmittel als CSV");
  commit(repo, "src/vergleich.py", 'def name_oder_fragezeichen(name):\n    return name or "?"\n', "Absturz bei leerem Stationsnamen behoben");

  const app = await t.launch({ ...LAUNCH, env: { ...forge.appEnv, FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("host_connect", { kind: "github", baseUrl: forge.url, token: forge.token });
  await app.invoke("settings_set", { patch: AI_ON });
  await app.openRepo(repo.path);

  await palette(app, "Create annotated tag", "tag.createAnnotated");
  await app.type(await app.waitFor('[role="dialog"] [data-tag-name]', 10_000), "v1.1.0");
  await app.click(await app.waitFor('[role="dialog"] [data-release-notes-write]', 10_000, { message: "Write release notes" }));
  const expected = "### Neu\n\n- Export der Tagesmittel als CSV\n\n### Behoben\n\n- Absturz bei leerem Stationsnamen behoben";
  await eventually(() => value(app, "[data-tag-annotation]"), expected, "notes in the annotation");
  assertIncludes(await text(app, "[data-release-notes-state]"), "2 commits since v1.0.0");
  t.step("written");

  await app.click(await app.waitFor('[data-release-target="changelog"] [role="checkbox"]'));
  await app.click(await app.waitFor('[data-release-target="host_release"] [role="checkbox"]'));
  assertIncludes(await text(app, '[data-release-target="host_release"]'), "cannot be undone");
  await t.shot("tag-dialog-notes");
  await app.click(await buttonByText(app, "Create tag"));
  await app.click(await buttonByText(app, "Push and create release"));
  await waitToast(app, /Release “v1\.1\.0” created on GitHub/, "success");

  const local = repo.git("rev-parse", "refs/tags/v1.1.0");
  assertEqual(forge.bareGit("github", "rev-parse", "refs/tags/v1.1.0"), local, "the annotated tag was pushed first");
  assertIncludes(repo.git("cat-file", "-p", "v1.1.0"), "### Behoben");
  const release = forge.mock.requests.find((request) => request.method === "POST" && request.path === "/api/v3/repos/octo/demo/releases");
  assert(release, "the release was created at the host");
  assertEqual({ tag: release.body.tag_name, target: release.body.target_commitish, body: release.body.body }, { tag: "v1.1.0", target: repo.git("rev-parse", "v1.1.0^{commit}"), body: expected });
  assertEqual(fs.readFileSync(path.join(repo.path, "CHANGELOG.md"), "utf8"), `# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - ${today()}\n\n${expected}\n`);
  assertMatch(repo.git("status", "--porcelain"), /^\s?M CHANGELOG\.md$/, "a normal change, not committed");
  assertEqual(ollama.chats(), 1, "one request");
  await t.noConsoleErrors(app);
}));

scenario("hidden while AI is not set up and in a repository with AI off", "edge", withCleanup(async (t) => {
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  const app = await t.launch({ ...LAUNCH, env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  const { repoId } = await app.openRepo(repo.path);
  const head = repo.git("rev-parse", "HEAD");

  const dialogHasButton = async () => {
    await palette(app, "Create annotated tag", "tag.createAnnotated");
    await app.waitFor('[role="dialog"] [data-tag-name]', 10_000);
    await app.settle();
    const found = Boolean(await app.$("[data-release-notes-write]"));
    await app.press("Escape");
    await noDialog(app);
    return found;
  };
  const menuHasEntry = async () => {
    await rightClick(app, await app.waitFor(`[data-row-id="${head}"] [data-cell="message"]`, 15_000));
    await app.waitFor('[role="menuitem"]', 8000);
    const found = (await menuLabels(app)).some((label) => label.startsWith("Write release notes"));
    await app.press("Escape");
    return found;
  };

  assertEqual(await app.invoke("ai_status").then((status) => status.state), "unset");
  assert(!(await dialogHasButton()), "unset: no button in the tag dialog");
  assert(!(await menuHasEntry()), "unset: no menu entry");

  await app.invoke("settings_set", { patch: AI_ON });
  await setThrough(app, "repo_settings_set", { repoId, patch: { aiOff: true } });
  assert(!(await dialogHasButton()), "AI off for this repository: no button");
  assert(!(await menuHasEntry()), "AI off for this repository: no menu entry");

  await setThrough(app, "repo_settings_set", { repoId, patch: { aiOff: false } });
  assert(await dialogHasButton(), "AI on: the button is there");
  assert(await menuHasEntry(), "AI on: the menu entry is there");
  assertEqual(ollama.chats(), 0, "looking sends nothing");
  await t.noConsoleErrors(app);
}));

scenario("commit menu in German: what is sent, write, copy to the clipboard", "edge", withCleanup(async (t) => {
  const repo = makeCleanRepoWithRemote();
  t.cleanups.push(() => repo.cleanup());
  const ollama = await startOllama();
  t.cleanups.push(() => ollama.close());
  repo.git("tag", "v1.0.0", "HEAD~1");
  const head = commit(repo, "src/vergleich.py", 'def name_oder_fragezeichen(name):\n    return name or "?"\n', "Absturz bei leerem Stationsnamen behoben", "-m", "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  const app = await t.launch({ ...LAUNCH, lang: "de", env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
  await app.invoke("settings_set", { patch: AI_ON });
  await app.openRepo(repo.path);

  await rightClick(app, await app.waitFor(`[data-row-id="${head}"] [data-cell="message"]`, 15_000));
  await app.click(await menuItem(app, "Release Notes schreiben"));
  await app.waitFor("[data-release-notes-dialog]", 10_000);
  await eventually(() => text(app, "[data-release-notes-range]"), "2 Commits seit v1.0.0", "range line");

  await app.click(await app.waitFor("[data-release-notes-what]"));
  const preview = await app.waitFor(() => app.exec(() => document.querySelector("[data-ai-preview-text]")?.textContent ?? null), 15_000, { message: "preview text" });
  assertIncludes(preview, `- ${head.slice(0, 12)} Absturz bei leerem Stationsnamen behoben`);
  assert(!preview.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "the token is redacted");
  assertEqual(ollama.chats(), 0, "the preview sends nothing");
  await t.shot("what-is-sent-de");
  await app.press("Escape");
  await app.waitFor(() => app.exec(() => !document.querySelector("[data-ai-preview-text]")), 5000, { message: "preview closed" });

  await app.click(await app.waitFor("[data-release-notes-write]"));
  await eventually(() => value(app, "[data-release-notes-text]"), "### Neu\n\n- Vergleich der Tagesmittel zweier Stationen\n\n### Behoben\n\n- Absturz bei leerem Stationsnamen behoben", "notes");
  assertEqual(await app.exec(() => [...document.querySelectorAll("[data-release-target]")].map((el) => el.getAttribute("data-release-target"))), ["clipboard"], "a commit offers only the clipboard");
  await app.click(await app.waitFor('[data-release-target="clipboard"] [role="checkbox"]'));
  await t.shot("commit-dialog-de");
  await app.click(await buttonByText(app, "Übernehmen"));
  await waitToast(app, /Release Notes/, "success");
  await t.noConsoleErrors(app);
}));
