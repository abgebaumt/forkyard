/**
 * Collision warning between coding agents (v1.2, package 2b) in the real app over WebDriver. Two
 * fake agents (target/debug/forkyard-fake-agent as an own template) start from a commit with an
 * 80-line src/auth.ts; the test then writes different lines 40–62 into both worktrees, as the
 * agents would. Both fake agents also write their task into an untracked AGENT_RESULT.md, so Git
 * sees a second conflict there (add/add, line 1) – the banner lists both files.
 * Expected: after the debounced check a banner in the cockpit naming both agents and
 * "src/auth.ts (lines 40–62)", a preview with both sides, and "Inform agent" typing the confirmed
 * text into the later agent's terminal (seen in the fake agent's log).
 *
 *   cargo build && node scripts/e2e-wd/features/agent-collisions.mjs
 *   E2E_WD_ONLY="German" node scripts/e2e-wd/features/agent-collisions.mjs
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
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
/** 80 lines "line n"; with `side`, lines 40–62 read "<side> n". */
const numbered = (side) =>
  Array.from({ length: 80 }, (_, i) => i + 1)
    .map((n) => (side && n >= 40 && n <= 62 ? `${side} ${n}` : `line ${n}`))
    .join("\n") + "\n";

/**
 * The app must never find a real coding agent (it would start it and send the task to a real
 * service): a throw-away HOME, SHELL=/bin/sh and a PATH without any folder that holds one of them
 * (same isolation as agents.mjs).
 */
function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-collide-home-"));
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
  const holdsAgent = (dir) => REAL_AGENTS.some((name) => fs.existsSync(path.join(dir, name)));
  const PATH = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir && !holdsAgent(dir)).join(path.delimiter);
  return { HOME: home, SHELL: "/bin/sh", PATH };
}

async function setUp(t, lang) {
  assert(fs.existsSync(FAKE), `${FAKE} is missing – run cargo build first`);
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  fs.mkdirSync(path.join(fx.path, "src"), { recursive: true });
  fs.writeFileSync(path.join(fx.path, "src", "auth.ts"), numbered(null));
  git(fx.path, "add", "src/auth.ts");
  git(fx.path, "-c", "user.name=Test Person", "-c", "user.email=test@example.com", "commit", "-q", "-m", "Anmeldung");
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fy-collide-")), "fake agent.log");
  const app = await t.launch({ ...LAUNCH, lang, env: isolatedEnv() });
  await app.waitForShell();
  await app.invoke("settings_set", {
    patch: { autoFetchMinutes: 0, agentTemplates: [{ id: "custom:fake", name: "Fake", program: FAKE, args: ["--log", log], unattendedArgs: null, resumeArgs: null, statusHook: true }] },
  });
  // Guard: the fake agent is the only template the app can start (and so the dialog's default).
  const found = (await app.invoke("agent_templates")).filter((item) => item.path !== null).map((item) => item.id);
  assertEqual(JSON.stringify(found), JSON.stringify(["custom:fake"]), "only the fake agent is found");
  await app.openRepo(fx.path);
  return { fx, app, log };
}

const agentBranches = (repoPath) =>
  git(repoPath, "branch", "--list", "--format=%(refname:short)", "agent/*").split("\n").filter(Boolean);

/** Starts an agent through the dialog; returns the branch Git has for it afterwards. */
async function startAgent(app, repoPath, task) {
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

async function twoCollidingAgents(t, lang) {
  const ctx = await setUp(t, lang);
  const first = await startAgent(ctx.app, ctx.fx.path, "Login prüfen");
  const second = await startAgent(ctx.app, ctx.fx.path, "Login umbauen");
  assertEqual(`${first} ${second}`, "agent/login-pruefen agent/login-umbauen", "branches suggested from the tasks");
  const folderOf = (branch) => path.join(path.dirname(ctx.fx.path), `${path.basename(ctx.fx.path)}.agents`, branch.replace("agent/", ""));
  const [a, b] = [folderOf(first), folderOf(second)];
  // Both agents took their task (their result file exists); then they change the same lines.
  await ctx.app.waitFor(() => fs.existsSync(path.join(a, "AGENT_RESULT.md")) && fs.existsSync(path.join(b, "AGENT_RESULT.md")), 60_000, { message: "both agents started" });
  fs.writeFileSync(path.join(a, "src", "auth.ts"), numbered("a"));
  fs.writeFileSync(path.join(b, "src", "auth.ts"), numbered("b"));
  await ctx.app.click('[data-toolbar="agents"] button');
  await ctx.app.waitFor('[data-screen="cockpit"]', 15_000, { message: "cockpit" });
  // The check runs ten seconds after the last change: wait for the banner itself.
  const banner = await ctx.app.waitFor(
    () =>
      ctx.app.exec(() => {
        const element = document.querySelector('[data-collision][data-kind="conflict"]');
        return element && element.innerText.includes("src/auth.ts") ? element.innerText.replace(/\s+/g, " ") : null;
      }),
    90_000,
    { message: "collision banner with src/auth.ts" },
  );
  return { ...ctx, banner };
}

scenario("two agents change the same lines: banner, preview with both sides, inform the later agent", "main", async (t) => {
  const { app, banner, log } = await twoCollidingAgents(t, "en");
  assertMatch(banner, /“login-pruefen” and “login-umbauen” would collide in /, "both agents named, the first started first");
  assertIncludes(banner, "src/auth.ts (lines 40–62)", "the file with the lines both changed (fixture)");
  assertIncludes(banner, "AGENT_RESULT.md (line 1)", "the result file both fake agents wrote (add/add)");
  await t.shot("collision-banner");

  // Preview: both sides of lines 40–62.
  await app.click('[data-collision][data-kind="conflict"] [data-action="collision-preview"]');
  await app.waitFor('[role="dialog"] [data-preview-file="src/auth.ts"]', 15_000, { message: "preview dialog" });
  await app.click('[role="dialog"] [data-preview-file="src/auth.ts"]');
  // Only the answer for src/auth.ts counts (the dialog opens on AGENT_RESULT.md, the first file).
  const block = await app.waitFor(
    () => app.exec(() => document.querySelector('[role="dialog"] [data-preview-path="src/auth.ts"] [data-collision-block]')?.innerText ?? null),
    15_000,
    { message: "preview block of src/auth.ts" },
  );
  assertIncludes(block, "lines 40–62", "range of the conflict");
  assertIncludes(block, "a 40", "first agent's side");
  assertIncludes(block, "b 62", "second agent's side");
  await t.shot("collision-preview");
  await app.press("Escape");
  await app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"] [data-preview-file]')), 15_000, { message: "preview closed" });

  // Inform: the later agent is preselected, the note names the first one; typed after confirming.
  await app.click('[data-collision][data-kind="conflict"] [data-action="collision-inform"]');
  const text = await app.waitFor(() => app.exec(() => document.querySelector('[role="dialog"] [data-field="inform-text"]')?.value ?? null), 15_000, { message: "inform dialog" });
  assertMatch(text, /^Note from Forkyard: the coding agent “login-pruefen” is also changing /, "prefilled note");
  await app.click('[data-action="inform-send"]');
  await app.waitFor(
    () => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("line: Note from Forkyard: the coding agent “login-pruefen” is also changing"),
    30_000,
    { message: "note typed into the later agent's terminal" },
  );
  await t.noConsoleErrors(app);
});

scenario("German texts of the collision warning", "edge", async (t) => {
  const { banner } = await twoCollidingAgents(t, "de");
  assertMatch(banner, /„login-pruefen“ und „login-umbauen“ würden in .+ kollidieren/, "Banner auf Deutsch");
  assertIncludes(banner, "src/auth.ts (Zeilen 40–62)", "Zeilen auf Deutsch");
  assertIncludes(banner, "Vorschau zeigen", "Knopf auf Deutsch");
});
