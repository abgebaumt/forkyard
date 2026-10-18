/**
 * Coding-agent cockpit (v1.2, package 2a) in the real app over WebDriver: the fake agent
 * (target/debug/forkyard-fake-agent) is an own template; it prints, reports "waiting" over the
 * status channel, rings the bell and writes a file into its worktree. Every result is checked in the
 * UI and in Git (`git worktree list`, `git branch`), the typed task in the fake agent's log.
 *
 *   cargo build && node scripts/e2e-wd/features/agents.mjs
 *   E2E_WD_ONLY="undo" node scripts/e2e-wd/features/agents.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE = path.join(ROOT, "target", "debug", "forkyard-fake-agent");
const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const REAL_AGENTS = ["claude", "codex", "opencode"];

/**
 * The app must never find a real coding agent (it would start it and send the task to a real
 * service): a throw-away HOME (known places like ~/.local/bin, the login shell's profile), SHELL=/bin/sh
 * and a PATH without any folder that holds one of them.
 */
function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-agent-home-"));
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
  const holdsAgent = (dir) => REAL_AGENTS.some((name) => fs.existsSync(path.join(dir, name)));
  const PATH = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir && !holdsAgent(dir)).join(path.delimiter);
  return { HOME: home, SHELL: "/bin/sh", PATH };
}
const slashed = (file) => file.replaceAll("\\", "/");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

async function setUp(t, lang = "en") {
  assert(fs.existsSync(FAKE), `${FAKE} is missing – run cargo build first`);
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fy-agent-")), "fake agent.log");
  const app = await t.launch({ ...LAUNCH, lang, env: isolatedEnv() });
  await app.waitForShell();
  await app.invoke("settings_set", {
    patch: { autoFetchMinutes: 0, agentTemplates: [{ id: "custom:fake", name: "Fake", program: FAKE, args: ["--log", log], unattendedArgs: null, resumeArgs: ["--log", log], statusHook: true }] },
  });
  // Guard: the fake agent is the only template the app can start (and so the dialog's default).
  const found = (await app.invoke("agent_templates")).filter((item) => item.path !== null).map((item) => item.id);
  assertEqual(JSON.stringify(found), JSON.stringify(["custom:fake"]), "only the fake agent is found");
  const { repoId, tabId } = await app.openRepo(fx.path);
  await app.exec(() => {
    window.__gcTestNotifications = { focused: false, sent: [] };
    return true;
  });
  return { fx, app, repoId, tabId, log };
}

const agentBranches = (repoPath) =>
  git(repoPath, "branch", "--list", "--format=%(refname:short)", "agent/*").split("\n").filter(Boolean);

/** Starts an agent through the dialog; returns the branch Git has for it afterwards. */
async function startFromDialog(app, repoPath, task) {
  const before = new Set(agentBranches(repoPath));
  await app.press("Control+Shift+a");
  await app.waitFor('[role="dialog"] [data-field="task"]', 15_000, { message: "start dialog" });
  // The dialog first suggests a branch for the empty task. Type only once that answer is in, so the
  // task's own suggestion has to replace it (a branch read from the field too early would be stale).
  await app.waitFor(() => app.exec(() => document.querySelector('[role="dialog"] [data-field="branch"] input, [role="dialog"] input[data-field="branch"]')?.value === "agent/agent"), 15_000, { message: "suggestion for the empty task" });
  await app.type('[role="dialog"] [data-field="task"]', task);
  // The live check can enable the button for a moment and disable it again (a suggestion that
  // changes the branch starts one more check), so a WebDriver click may hit a disabled button. Check
  // and click in one turn of the page instead.
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
  // Which branch the agent got is Git's answer, not whatever the field showed at some moment.
  const created = await app.waitFor(() => {
    const fresh = agentBranches(repoPath).filter((name) => !before.has(name));
    return fresh.length === 1 ? fresh : null;
  }, 15_000, { message: "agent branch in git" });
  return created[0];
}

const rowStatus = (app) => app.exec(() => [...document.querySelectorAll("[data-agent-row]")].map((row) => ({ id: row.dataset.agentRow, status: row.dataset.status, text: row.innerText.replace(/\s+/g, " ") })));

scenario("start an agent: own worktree, typed task, waiting for you, cockpit and notification", "main", async (t) => {
  const { fx, app, log } = await setUp(t);
  const branch = await startFromDialog(app, fx.path, "Größe der Übersicht anpassen");
  assertEqual(branch, "agent/groesse-der-uebersicht-anpassen", "branch suggested from the task (umlauts folded)");
  t.step("agent started");
  // Git has the worktree next to the repository, on the new branch.
  const folder = path.join(path.dirname(fx.path), `${path.basename(fx.path)}.agents`, "groesse-der-uebersicht-anpassen");
  const listed = git(fx.path, "worktree", "list", "--porcelain");
  assertIncludes(slashed(listed), slashed(`worktree ${folder}`), "worktree in git");
  assertIncludes(git(fx.path, "branch", "--list", branch), branch, "branch in git");
  // The terminal tab carries the agent's name; the fake agent got the task byte for byte.
  await app.waitFor(() => app.exec(() => [...document.querySelectorAll("[data-terminal-tab]")].some((tab) => tab.innerText.includes("groesse-der-uebersicht-anpassen"))), 30_000, { message: "agent terminal tab" });
  await app.waitFor(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("task: Größe der Übersicht anpassen"), 60_000, { message: "typed task in the log" });
  assertEqual(fs.readFileSync(path.join(folder, "AGENT_RESULT.md"), "utf8"), "Größe der Übersicht anpassen", "file written by the agent");

  // Cockpit through the toolbar: "waiting for you", according to the agent, one changed file.
  await app.click('[data-toolbar="agents"] button');
  await app.waitFor('[data-screen="cockpit"]', 15_000, { message: "cockpit" });
  const rows = await app.waitFor(async () => {
    const list = await rowStatus(app);
    return list.length === 1 && list[0].status === "waiting" ? list : null;
  }, 60_000, { message: "agent waiting" });
  assertMatch(rows[0].text, /waiting for you/, "status as a word");
  assertMatch(rows[0].text, /according to Fake/, "where the status comes from");
  assertMatch(rows[0].text, /1 changed file/, "changed files");
  // The button names the running agent (“Agents 1”) and its badge the agent that waits for you.
  const badge = await app.exec(() => document.querySelector('[data-toolbar="agents"] button')?.getAttribute("aria-label") ?? "");
  assertEqual(badge, "Agents 1, 1 agent waits for you", "toolbar label and counter");
  const sent = await app.exec(() => window.__gcTestNotifications.sent);
  assert(sent.some((item) => item.title === "groesse-der-uebersicht-anpassen is waiting for you"), `notification: ${JSON.stringify(sent)}`);
  // The left section and the worktree mark.
  assert(await app.exec(() => Boolean(document.querySelector('[data-extra-section="agents"] [data-kind="agent"]'))), "row in the Agents section");
  assert(await app.exec(() => Boolean(document.querySelector('[data-flag="agent"]'))), "worktree marked as Agent");
  // Keyboard: Enter shows the details in the right panel.
  await app.exec(() => document.querySelector("[data-agent-row]")?.focus());
  await app.press("Enter");
  await app.waitFor('[data-panel="agent"]', 15_000, { message: "details panel" });
  await t.shot("cockpit-waiting");
  await t.noConsoleErrors(app);
});

scenario("an agent in a background repository tab still notifies", "main", async (t) => {
  const { fx, app, repoId, tabId } = await setUp(t);
  const branch = await startFromDialog(app, fx.path, "Im Hintergrund fertig werden");
  const short = branch.replace("agent/", "");
  const agent = await app.waitFor(async () => (await app.invoke("agent_list", { repoId })).find((item) => item.status === "waiting" && item.terminalId) ?? null, 60_000, { message: "agent waiting" });
  // Another repository becomes the active tab; the agent's tab is in the background now.
  const other = makeCleanRepoWithRemote({ name: "zweites-netz" });
  const second = await app.openRepo(other.path);
  assert(second.tabId !== tabId, "second repository in its own tab");
  // openRepo waits until the new tab is the selected one.
  const firstSelected = await app.exec((id) => document.querySelector(`[data-tab-id="${id}"] [role="tab"]`)?.getAttribute("aria-selected") ?? null, tabId);
  assertEqual(firstSelected, "false", "the agent's repository tab is in the background");
  // The fake agent reports "done" when it reads that line.
  await app.invoke("terminal_write", { terminalId: agent.terminalId, data: "done\r" });
  const sent = await app.waitFor(async () => {
    const list = await app.exec(() => window.__gcTestNotifications.sent);
    return list.some((item) => item.title === `${short} is done`) ? list : null;
  }, 30_000, { message: "notification from the background tab" });
  assert(sent.every((item) => !item.title.includes("zweites-netz")), "nothing about the other repository");
  await t.noConsoleErrors(app);
});

scenario("clean up an agent with the warning about unpushed commits, then undo brings it back", "main", async (t) => {
  const { fx, app } = await setUp(t);
  const branch = await startFromDialog(app, fx.path, "Aufräumen und zurückholen");
  const short = branch.replace("agent/", "");
  const folder = path.join(path.dirname(fx.path), `${path.basename(fx.path)}.agents`, short);
  // A commit only the agent's branch has.
  await app.waitFor(() => fs.existsSync(path.join(folder, "AGENT_RESULT.md")), 60_000, { message: "agent wrote its file" });
  git(folder, "add", "-A");
  git(folder, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-q", "-m", "Ergebnis des Agenten");
  const tip = git(fx.path, "rev-parse", branch);
  await app.click('[data-toolbar="agents"] button');
  await app.waitFor("[data-agent-row]", 15_000);
  await app.click('[data-agent-row] ~ [data-action="menu"]');
  await app.click({ text: "Stop agent and clean up …" });
  const dialog = await app.waitFor(() => app.exec(() => document.querySelector('[role="alertdialog"], [role="dialog"]')?.innerText ?? null), 15_000, { message: "confirmation" });
  assertMatch(dialog, /1 commit of this branch is not pushed/, "unpushed warning (git: 1 commit ahead, no remote branch)");
  await app.click({ text: "Clean up" });
  await app.waitFor(() => !fs.existsSync(folder), 30_000, { message: "worktree folder removed" });
  assertEqual(git(fx.path, "branch", "--list", branch), "", "branch deleted");
  // Undo (Ctrl+Z in the repository) restores branch and folder.
  await app.exec(() => document.querySelector('[data-screen="cockpit"]')?.focus());
  await app.press("Control+z");
  await app.waitFor(() => fs.existsSync(folder), 30_000, { message: "worktree folder back" });
  assertEqual(git(fx.path, "rev-parse", branch), tip, "branch back at its tip");
  await app.waitFor(async () => (await rowStatus(app)).some((row) => row.status === "stopped"), 30_000, { message: "agent back as stopped" });
  await t.noConsoleErrors(app);
});

scenario("without prompts: unavailable for a template without arguments, warning and button text", "edge", async (t) => {
  const { app, log } = await setUp(t);
  await app.press("Control+Shift+a");
  await app.waitFor('[role="dialog"] [data-field="task"]', 15_000);
  const disabled = await app.exec(() => document.querySelector('[role="dialog"] [role="switch"]')?.disabled ?? null);
  assertEqual(disabled, true, "switch off without unattendedArgs");
  await app.press("Escape");
  await app.invoke("settings_set", { patch: { agentTemplates: [{ id: "custom:fake", name: "Fake", program: FAKE, args: ["--log", log], unattendedArgs: ["--unattended"], resumeArgs: null, statusHook: true }] } });
  await app.press("Control+Shift+a");
  await app.waitFor('[role="dialog"] [data-field="task"]', 15_000);
  assertEqual(await app.exec(() => document.querySelector('[data-action="start-agent"]')?.innerText.trim()), "Start", "plain start");
  await app.click('[role="dialog"] [role="switch"]');
  const warning = await app.waitFor(() => app.exec(() => document.querySelector('[data-warning="unattended"]')?.innerText ?? null), 5_000);
  assertMatch(warning, /^Warning: The agent makes changes and runs commands without asking\./, "warning with the word");
  assertEqual(await app.exec(() => document.querySelector('[data-action="start-agent"]')?.innerText.trim()), "Start without prompts", "button text");
  await app.press("Escape");
});

scenario("quitting asks while an agent runs", "edge", async (t) => {
  const { fx, app } = await setUp(t);
  await startFromDialog(app, fx.path, "Läuft beim Beenden");
  await app.waitFor(() => app.exec(() => window.__gc?.store.getState().agentsRunning === 1), 30_000, { message: "agent counted" });
  await app.exec(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "app:close_requested", payload: {} }));
  // The app's confirm() renders a plain dialog (role="dialog"), not an alertdialog.
  const text = await app.waitFor(() => app.exec(() => document.querySelector('[role="alertdialog"], [role="dialog"]')?.innerText ?? null), 15_000, { message: "quit prompt" });
  assertMatch(text, /1 coding agent is running and will be stopped\./, "prompt names the agent");
  await app.press("Escape");
});

scenario("German texts in the cockpit", "edge", async (t) => {
  const { fx, app } = await setUp(t, "de");
  await startFromDialog(app, fx.path, "Deutsch prüfen");
  await app.click('[data-toolbar="agents"] button');
  const row = await app.waitFor(async () => (await rowStatus(app)).find((item) => item.status === "waiting") ?? null, 60_000);
  assertMatch(row.text, /wartet auf dich/, "Status auf Deutsch");
  assertMatch(row.text, /laut Fake/, "Herkunft auf Deutsch");
});
