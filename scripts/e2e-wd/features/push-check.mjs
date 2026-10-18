/**
 * Push check in the real app (v1.2, Teilpaket 6.2), against a local bare remote:
 *
 * - main: a fake key in a new commit stops the push – "1 added line looks like a key", file:line, only
 *   the last four characters; Back pushes nothing, Push anyway pushes (checked with git on the remote);
 * - edge (German): "Nicht mehr melden" lets the next push through without asking;
 * - main: "Review and push …" from the Push menu asks a local Ollama stand-in (Node mock behind
 *   FORKYARD_AI_BASE_URL_OLLAMA, debug builds only), shows its finding, Push anyway pushes;
 * - edge: with "AI review before every push" Ctrl+Shift+P reviews first; Back while it runs pushes
 *   nothing, a review without findings offers "Push".
 *
 * Fake keys are built at run time. Nothing touches a real service.
 *
 *   node scripts/e2e-wd/features/push-check.mjs
 *   E2E_WD_ONLY="Review" node scripts/e2e-wd/features/push-check.mjs
 */
import http from "node:http";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { NO_PROXY_ENV, git, syncUi } from "../fixtures/sync-ui.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const FAKE_KEY = `AKIA${"Q7RZ4M2XK9PLW3NB"}`;

/** Local stand-in for Ollama: records the chat requests, answers with `answer`, optionally late. */
async function startOllama() {
  const state = { answer: { findings: [] }, delayMs: 0, chats: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const reply = (status, value) => {
        const text = JSON.stringify(value);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      const route = `${req.method} ${req.url}`;
      if (route === "GET /api/tags") return reply(200, { models: [{ name: "qwen3:8b" }] });
      if (route === "POST /api/show") return reply(200, { model_info: { "qwen3.context_length": 40960 } });
      if (route !== "POST /api/chat") return reply(404, { error: "not found" });
      state.chats.push(body);
      const content = JSON.stringify(state.answer);
      setTimeout(() => reply(200, { model: "qwen3:8b", message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 900, eval_count: 40 }), state.delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Starts the app, switches auto-fetch off, installs the toast recorder. */
async function start(t, options = {}) {
  const app = await t.launch({ lang: "en", theme: "light", width: 1440, height: 900, ...options, env: { SSH_AUTH_SOCK: "", ...NO_PROXY_ENV, ...(options.env ?? {}) } });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const ui = syncUi(app);
  await ui.install();
  return { app, ui };
}

async function open(app, ui, repoPath) {
  const ids = await app.openRepo(repoPath);
  await app.waitFor(() => ui.toolButton("Fetch"), 20_000, { message: "repository toolbar" });
  await ui.refresh();
  return ids;
}

/** A commit made outside the app (before it starts). */
function commitFile(repo, file, content, message) {
  repo.write(file, content);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

const remoteMain = (repo) => git(repo.remotePath, "rev-parse", "refs/heads/main");

scenario("Push mit eingebautem Fake-Schlüssel zeigt den Fund; Zurück pusht nichts, Trotzdem pushen schon", "main", async (t) => {
  const repo = makeCleanRepoWithRemote();
  try {
    const pushed = remoteMain(repo);
    const head = commitFile(repo, "einstellungen/dienst.py", `REGION = "eu-central-1"\nAWS_ZUGANG = "${FAKE_KEY}"\n`, "Dienst anbinden");
    const { app, ui } = await start(t);
    await open(app, ui, repo.path);

    await ui.clickTool("Push");
    const shown = await ui.waitDialog(/^1 added line looks like a key$/);
    assertIncludes(shown.text, "einstellungen/dienst.py:2", "file:line");
    assertIncludes(shown.text, "…W3NB", "the last four characters");
    assert(!shown.text.includes(FAKE_KEY), "the value itself is never shown");
    await t.shot("secret-scan-dialog");
    await ui.clickDialogButton("Back");
    await ui.waitNoDialog();
    await app.settle();
    assertEqual(remoteMain(repo), pushed, "Back pushes nothing (git rev-parse on the remote)");

    await ui.clickTool("Push");
    await ui.waitDialog(/looks like a key/);
    await ui.clickDialogButton("Push anyway");
    await ui.waitToast(/Pushed to origin\/main/, "success", 60_000);
    assertEqual(remoteMain(repo), head, "Push anyway pushes exactly the local commit");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Nicht mehr melden lässt den nächsten Push ohne Rückfrage durch (Deutsch)", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "melden" });
  try {
    const pushed = remoteMain(repo);
    const head = commitFile(repo, "dienst.py", `AWS_ZUGANG = "${FAKE_KEY}"\n`, "Dienst");
    const { app, ui } = await start(t, { lang: "de" });
    const { repoId } = await open(app, ui, repo.path);

    await ui.clickTool("Push");
    await ui.waitDialog(/^1 hinzugefügte Zeile sieht aus wie ein Schlüssel$/);
    await ui.clickDialogButton("Nicht mehr melden");
    await app.waitFor(async () => ((await ui.dialog())?.text ?? "").includes("Wird nicht mehr gemeldet"), 10_000, { message: "row marked as not reported" });
    await t.shot("secret-scan-ignored-de");
    await ui.clickDialogButton("Zurück");
    await ui.waitNoDialog();
    assertEqual(remoteMain(repo), pushed, "Zurück pushes nothing");
    const settings = await app.invoke("repo_settings_get", { repoId });
    assertEqual(settings.secretScanIgnoredCount, 1, "one hash stored");

    await ui.clickTool("Push");
    await ui.waitToast(/Nach origin\/main gepusht/, "success", 60_000);
    assertEqual(await ui.dialog(), null, "no dialog this time");
    assertEqual(remoteMain(repo), head);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("Review and push fragt den lokalen Mock-Anbieter und zeigt seinen Fund", "main", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "pruefen" });
  const ollama = await startOllama();
  try {
    ollama.state.answer = { findings: [{ path: "src/zaehler.py", line: 2, kind: "debug_output", note: "Leftover print of the intermediate state." }] };
    const head = commitFile(repo, "src/zaehler.py", 'def zaehle(n):\n    print("zwischenstand", n)\n    return n + 1\n', "Zähler ausgeben");
    const { app, ui } = await start(t, { env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
    await app.invoke("settings_set", { patch: { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
    await open(app, ui, repo.path);

    await app.click({ text: "Push: options" });
    const entry = await app.waitFor(() => app.byText("Review and push …", { within: '[role="menu"]' }), 10_000, { message: "menu entry Review and push" });
    await entry.click();
    await ui.waitDialog(/^Review before push$/);
    await app.waitFor(() => app.exec(() => document.querySelector('[data-review-finding="src/zaehler.py:2"]')), 30_000, { message: "the finding of the review" });
    const shown = await ui.dialog();
    assertIncludes(shown.text, "1 finding · in 1 commit");
    assertIncludes(shown.text, "Debug output");
    assertIncludes(shown.text, "Leftover print of the intermediate state.");
    assertEqual(ollama.state.chats.length, 1, "one request");
    assertIncludes(ollama.state.chats[0], "zwischenstand", "what the push sends");
    assert(!ollama.state.chats[0].includes("Gemeinsame Auswertung der drei Schulstationen"), "what is already on the remote stays out");
    await t.shot("push-review-finding");

    await ui.clickDialogButton("Push anyway");
    await ui.waitNoDialog();
    await ui.waitToast(/Pushed to origin\/main/, "success", 60_000);
    assertEqual(remoteMain(repo), head);
    await t.noConsoleErrors(app);
  } finally {
    await ollama.close();
    repo.cleanup();
  }
});

scenario("Mit Vor jedem Push KI-Prüfung prüft Ctrl+Shift+P zuerst; Zurück während der Prüfung pusht nicht", "edge", async (t) => {
  const repo = makeCleanRepoWithRemote({ name: "immer-pruefen" });
  const ollama = await startOllama();
  try {
    const pushed = remoteMain(repo);
    const head = commitFile(repo, "notiz.md", "Messreihe Hafen ergänzt\n", "Notiz");
    const { app, ui } = await start(t, { env: { FORKYARD_AI_BASE_URL_OLLAMA: ollama.url } });
    await app.invoke("settings_set", { patch: { aiEnabled: true, aiProvider: "ollama", aiModel: "qwen3:8b" } });
    const { repoId } = await open(app, ui, repo.path);
    await app.invoke("repo_settings_set", { repoId, patch: { aiReviewBeforePush: true } });
    await ui.refresh();

    // A slow answer: Back while it runs.
    ollama.state.delayMs = 8000;
    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Control+Shift+p");
    await ui.waitDialog(/^Review before push$/);
    await app.waitFor(() => ui.dialog().then((top) => (top?.text ?? "").includes("Reviewing")), 10_000, { message: "the review is running" });
    await ui.clickDialogButton("Back");
    await ui.waitNoDialog();
    await app.settle();
    assertEqual(remoteMain(repo), pushed, "Back during the review pushes nothing");

    // Quick, without findings: the button says "Push".
    ollama.state.delayMs = 0;
    await app.exec(() => document.activeElement?.blur?.());
    await app.press("Control+Shift+p");
    await ui.waitDialog(/^Review before push$/);
    await app.waitFor(() => ui.dialog().then((top) => (top?.text ?? "").includes("No findings")), 30_000, { message: "No findings" });
    await ui.clickDialogButton("Push");
    await ui.waitToast(/Pushed to origin\/main/, "success", 60_000);
    assertEqual(remoteMain(repo), head);
    await t.noConsoleErrors(app);
  } finally {
    await ollama.close();
    repo.cleanup();
  }
});
