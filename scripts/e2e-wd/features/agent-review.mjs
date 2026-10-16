/**
 * Review and takeover of a coding agent's work (v1.2, package 2c) in the real app over WebDriver.
 * The fake agent (target/debug/forkyard-fake-agent) writes AGENT_RESULT.md with its task into its
 * worktree; the test adds a CRLF change to a tracked list there. Results are checked byte for byte on
 * disk and in Git.
 *
 *   cargo build && node scripts/e2e-wd/features/agent-review.mjs
 *   E2E_WD_ONLY="undo" node scripts/e2e-wd/features/agent-review.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE = path.join(ROOT, "target", "debug", "forkyard-fake-agent");
const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const REAL_AGENTS = ["claude", "codex", "opencode"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const bytes = (file) => fs.readFileSync(file, "latin1");
const TASK = "Liste groß schreiben";
const LIST_BASE = "eins\r\nzwei\r\ndrei\r\n";
const LIST_AGENT = "EINS\r\nzwei\r\nDREI\r\n";

/**
 * The app must never find a real coding agent (it would start it and send the task to a real
 * service): a throw-away HOME, SHELL=/bin/sh and a PATH without any folder that holds one of them
 * (same isolation as agents.mjs).
 */
function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-review-home-"));
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
  const holdsAgent = (dir) => REAL_AGENTS.some((name) => fs.existsSync(path.join(dir, name)));
  const PATH = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir && !holdsAgent(dir)).join(path.delimiter);
  return { HOME: home, SHELL: "/bin/sh", PATH };
}

const agentBranches = (repoPath) =>
  git(repoPath, "branch", "--list", "--format=%(refname:short)", "agent/*").split("\n").filter(Boolean);

/** Starts an agent through the dialog; returns the branch Git has for it afterwards. */
async function startFromDialog(app, repoPath, task) {
  const before = new Set(agentBranches(repoPath));
  await app.press("Control+Shift+a");
  await app.waitFor('[role="dialog"] [data-field="task"]', 15_000, { message: "start dialog" });
  // Type only once the empty task's suggestion is in, so the task's own suggestion replaces it.
  await app.waitFor(() => app.exec(() => document.querySelector('[role="dialog"] [data-field="branch"] input, [role="dialog"] input[data-field="branch"]')?.value === "agent/agent"), 15_000, { message: "suggestion for the empty task" });
  await app.type('[role="dialog"] [data-field="task"]', task);
  // The live branch check can enable the button for a moment and disable it again: check and click
  // in one turn of the page.
  await app.waitFor(
    () =>
      app.exec(() => {
        const button = document.querySelector('[data-action="start-agent"]');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }),
    15_000,
    { message: "start enabled and clicked" },
  );
  await app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"] [data-field="task"]')), 30_000, { message: "dialog closed after the start" });
  const created = await app.waitFor(() => {
    const fresh = agentBranches(repoPath).filter((name) => !before.has(name));
    return fresh.length === 1 ? fresh : null;
  }, 15_000, { message: "agent branch in git" });
  return created[0];
}

/** A repository with a CRLF list on main, an agent on it that wrote its file and changed the list. */
async function setUp(t, lang = "en") {
  assert(fs.existsSync(FAKE), `${FAKE} is missing – run cargo build first`);
  const fx = makeCleanRepoWithRemote({ name: "pruefstand" });
  fs.writeFileSync(path.join(fx.path, "liste.txt"), LIST_BASE);
  git(fx.path, "add", "liste.txt");
  git(fx.path, "-c", "user.name=Test Person", "-c", "user.email=test@example.com", "commit", "-q", "-m", "Liste");
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fy-review-")), "fake agent.log");
  const app = await t.launch({ ...LAUNCH, lang, env: isolatedEnv() });
  await app.waitForShell();
  await app.invoke("settings_set", {
    patch: { autoFetchMinutes: 0, agentTemplates: [{ id: "custom:fake", name: "Fake", program: FAKE, args: ["--log", log], unattendedArgs: null, resumeArgs: null, statusHook: true }] },
  });
  // Guard: the fake agent is the only template the app can start (and so the dialog's default).
  const found = (await app.invoke("agent_templates")).filter((item) => item.path !== null).map((item) => item.id);
  assertEqual(JSON.stringify(found), JSON.stringify(["custom:fake"]), "only the fake agent is found");
  const { repoId, tabId } = await app.openRepo(fx.path);
  const branch = await startFromDialog(app, fx.path, TASK);
  assertEqual(branch, "agent/liste-gross-schreiben", "branch suggested from the task");
  const folder = path.join(path.dirname(fx.path), `${path.basename(fx.path)}.agents`, branch.replace("agent/", ""));
  await app.waitFor(() => fs.existsSync(path.join(folder, "AGENT_RESULT.md")), 60_000, { message: "agent wrote its file" });
  fs.writeFileSync(path.join(folder, "liste.txt"), LIST_AGENT);
  const agent = await app.waitFor(
    async () => (await app.invoke("agent_list", { repoId })).find((item) => item.branch === branch && item.changedFiles === 2) ?? null,
    30_000,
    { message: "the cockpit counts both changed files" },
  );
  return { fx, app, repoId, tabId, folder, branch, agent };
}

async function openReview(app, menuText = "Review changes") {
  await app.click('[data-toolbar="agents"] button');
  await app.waitFor("[data-agent-row]", 15_000, { message: "cockpit row" });
  await app.click('[data-agent-row] ~ [data-action="menu"]');
  await app.click({ text: menuText });
  await app.waitFor('[data-screen="agent-review"]', 15_000, { message: "review open" });
  await app.waitFor(() => app.exec(() => document.querySelectorAll('[data-review-list="chosen"] [role="option"]').length === 2), 30_000, { message: "both files selected" });
}

const listText = (app, name) => app.exec((which) => document.querySelector(`[data-review-list="${which}"]`)?.innerText.replace(/\s+/g, " ") ?? "", name);

scenario("take over one line of the agent's change into my working directory", "main", async (t) => {
  const { fx, app, folder } = await setUp(t);
  await openReview(app);
  await app.exec(() => [...document.querySelectorAll('[data-review-list="chosen"] [role="option"]')].find((row) => row.innerText.includes("liste.txt"))?.click());
  await app.waitFor('[data-review-diff="liste.txt"] [role="grid"] [data-row][tabindex="0"]', 15_000, { message: "diff of the list" });
  // All four changed lines start checked. Esc clears them (the list moves to “Not selected”),
  // then Space on the first change and on the line below picks exactly “eins” → “EINS”.
  await app.exec(() => document.querySelector('[data-review-diff="liste.txt"] [data-row][tabindex="0"]').focus());
  await app.press("Escape");
  await app.waitFor(async () => (await listText(app, "rest")).includes("liste.txt"), 5_000, { message: "list not selected after Esc" });
  await app.press("Space", "ArrowDown", "Space");
  await app.waitFor(async () => (await listText(app, "chosen")).includes("some lines"), 5_000, { message: "list selected with some lines" });
  await t.shot("one-line-picked");
  await app.click('[data-action="review-take-over"]');
  await app.waitFor(() => fs.existsSync(path.join(fx.path, "AGENT_RESULT.md")) && bytes(path.join(fx.path, "liste.txt")) === "EINS\r\nzwei\r\ndrei\r\n", 30_000, { message: "taken over" });
  assertEqual(fs.readFileSync(path.join(fx.path, "AGENT_RESULT.md"), "utf8"), TASK, "the agent's new file came over whole");
  assertEqual(git(fx.path, "diff", "--cached", "--name-only"), "", "unstaged: nothing in the index");
  assertEqual(bytes(path.join(folder, "liste.txt")), LIST_AGENT, "the agent's worktree keeps its state");
  await t.noConsoleErrors(app);
});

scenario("commit the agent's selection on my branch", "main", async (t) => {
  const { fx, app, folder, branch } = await setUp(t);
  const before = git(fx.path, "rev-parse", "HEAD");
  const tip = git(fx.path, "rev-parse", branch);
  await openReview(app);
  const summary = await app.waitFor(() => app.exec(() => document.querySelector('[data-panel="review-commit"] input[data-field="review-summary"]')?.value ?? null), 15_000, { message: "commit panel" });
  assertEqual(summary, TASK, "summary from the task");
  await app.click('[data-action="review-commit"]');
  await app.waitFor(() => git(fx.path, "rev-parse", "HEAD") !== before, 30_000, { message: "commit made" });
  assertEqual(git(fx.path, "log", "-1", "--format=%s"), TASK);
  assertEqual(git(fx.path, "rev-parse", "HEAD^"), before, "one commit on top of my branch");
  assertEqual(git(fx.path, "symbolic-ref", "--short", "HEAD"), "main");
  assertEqual(git(fx.path, "show", "--format=", "--name-only", "HEAD").split("\n").filter(Boolean).sort().join(","), "AGENT_RESULT.md,liste.txt");
  assertEqual(execFileSync("git", ["-C", fx.path, "show", "HEAD:liste.txt"], { encoding: "latin1" }), LIST_AGENT, "CRLF committed as the agent wrote it");
  assertEqual(git(fx.path, "status", "--porcelain"), "", "nothing left over in my working directory");
  assertEqual(git(fx.path, "rev-parse", branch), tip, "the agent's branch did not move");
  assertEqual(bytes(path.join(folder, "liste.txt")), LIST_AGENT);
  await app.waitFor(async () => (await listText(app, "chosen")).includes("Selected (0)"), 15_000, { message: "selection cleared after the commit" });
  await t.noConsoleErrors(app);
});

scenario("discard the rest in the agent's worktree and undo it", "main", async (t) => {
  const { app, folder, agent, repoId } = await setUp(t);
  await app.invoke("agent_stop", { agentId: agent.id });
  await app.waitFor(async () => (await app.invoke("agent_list", { repoId })).find((item) => item.id === agent.id)?.terminalId === null, 30_000, { message: "agent stopped" });
  await openReview(app);
  await app.waitFor(() => app.exec(() => document.querySelector('[data-action="review-discard"]')?.disabled === false), 15_000, { message: "discard available" });
  assertIncludes(await app.exec(() => document.querySelector('[data-action="review-discard"]').innerText), "(destructive)", "the destructive step carries the word");
  await app.click('[data-action="review-discard"]');
  const dialog = await app.waitFor(() => app.exec(() => document.querySelector('[role="alertdialog"], [role="dialog"]')?.innerText ?? null), 15_000, { message: "confirmation" });
  assertIncludes(dialog, "2 uncommitted files in the agent's worktree are discarded", "the confirmation counts the files");
  await app.click({ text: "Discard" });
  await app.waitFor(() => !fs.existsSync(path.join(folder, "AGENT_RESULT.md")) && bytes(path.join(folder, "liste.txt")) === LIST_BASE, 30_000, { message: "rest discarded" });
  assertEqual(git(folder, "status", "--porcelain", "--untracked-files=all"), "", "nothing uncommitted left");
  await app.click('[data-toast="info"] [data-toast-action="primary"]');
  await app.waitFor(() => fs.existsSync(path.join(folder, "AGENT_RESULT.md")) && bytes(path.join(folder, "liste.txt")) === LIST_AGENT, 30_000, { message: "undo brought the rest back" });
  assertEqual(fs.readFileSync(path.join(folder, "AGENT_RESULT.md"), "utf8"), TASK);
  await t.noConsoleErrors(app);
});

scenario("German texts in the review", "edge", async (t) => {
  const { app } = await setUp(t, "de");
  await openReview(app, "Änderungen prüfen");
  assertIncludes(await listText(app, "chosen"), "Ausgewählt (2)", "Liste auf Deutsch");
  assertIncludes(await listText(app, "rest"), "Nicht ausgewählt (0)");
  assertEqual(await app.exec(() => document.querySelector('[data-action="review-take-over"]')?.innerText.trim()), "Auswahl in meinen Arbeitsbereich");
  assertIncludes(await app.exec(() => document.querySelector('[data-action="review-discard"]')?.innerText ?? ""), "(zerstörerisch)");
  assertIncludes(await app.exec(() => document.querySelector('[data-panel="review-commit"]')?.innerText ?? ""), "Auswahl committen (2 Dateien)");
  await t.shot("review-de");
});
