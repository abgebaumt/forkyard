/**
 * Custom commands in the real app: a command of the user from the palette (its run lands in the
 * activity log), the confirmation that shows the finished command first, and a repository file
 * that only runs after its own approval – and needs a new one after every change.
 *
 *   node scripts/e2e/screens/custom-commands.mjs
 *   node scripts/e2e/screens/custom-commands.mjs --only approval
 *   node scripts/e2e/screens/custom-commands.mjs --show
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { createChecks } from "./_wip.mjs";

const show = process.argv.includes("--show");
const { check, equal, eventually, section, finish } = createChecks("custom-commands");
const PALETTE = '[data-screen="command-palette"]';

let app = null;
const onError = async (title) => {
  if (app) await app.screenshot(`target/e2e/custom-commands-error-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
};
const run = (title, body) => section(title, body, onError);

const command = (patch) => ({ cwd: "worktree", confirm: false, shell: false, inputs: [], scope: ["repo"], ...patch });

/** Opens the palette, searches for `query` and waits until `key` is the first entry. */
async function paletteFind(key, query) {
  const { page } = app;
  await page.keyboard.press("Control+p");
  await page.locator(`${PALETTE} input[role="combobox"]`).waitFor({ timeout: 5000 });
  await page.keyboard.type(`>${query}`, { delay: 5 });
  await app.settle();
  await eventually(() => page.locator(`${PALETTE} [role="option"]`).evaluateAll((rows) => rows[0]?.dataset.key ?? null), key, `the palette offers ${key} first`);
}

const loggedCommands = async (repoId) => (await app.invoke("activity_list", { scope: "repo", repoId, cursor: null, limit: 50 })).entries.map((entry) => entry.command);

try {
  app = await launchApp({ show });
  const { page } = app;
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const repo = makeCleanRepoWithRemote({ name: "eigene-befehle" });
  const branch = repo.git("symbolic-ref", "--short", "HEAD").trim();
  const { repoId } = await app.openRepo(repo.path);

  await run("A command of the user runs from the palette and lands in the activity log", async () => {
    await app.invoke("custom_commands_save", { commands: [command({ id: "quote", title: "Quote branch", kind: "shell", run: "git rev-parse --sq-quote ${branch}" })] });
    await app.settle();
    await paletteFind("command:custom.global:quote", "Quote branch");
    await page.keyboard.press("Enter");
    await eventually(async () => (await loggedCommands(repoId)).includes(`git rev-parse --sq-quote ${branch}`), true, "the run is in the activity log");
  });

  await run("Confirm shows the finished command before anything runs", async () => {
    await app.invoke("custom_commands_save", {
      commands: [command({ id: "careful", title: "Careful quote", kind: "shell", run: "git rev-parse --sq-quote ${input:text}", confirm: true, inputs: [{ id: "text", label: "Text", type: "text", default: null, options: [] }] })],
    });
    await app.settle();
    await paletteFind("command:custom.global:careful", "Careful quote");
    await page.keyboard.press("Enter");
    const form = page.getByRole("dialog", { name: "Careful quote" });
    await form.waitFor({ timeout: 5000 });
    await page.keyboard.type("zwei Wörter; echo x", { delay: 5 });
    await page.keyboard.press("Enter");
    const ask = page.getByRole("dialog", { name: "Run “Careful quote”?" });
    await ask.waitFor({ timeout: 5000 });
    check((await ask.innerText()).includes('git rev-parse --sq-quote "zwei Wörter; echo x"'), "the confirmation shows the finished command line");
    check(!(await loggedCommands(repoId)).some((line) => line.includes("zwei Wörter")), "nothing has run before confirming");
    await ask.getByRole("button", { name: "Run" }).click();
    await eventually(async () => (await loggedCommands(repoId)).some((line) => line.includes("zwei Wörter; echo x")), true, "runs after confirming, the value as one argument");
  });

  await run("approval: a repository file runs only after its own approval, and again after a change", async () => {
    const file = path.join(repo.path, ".forkyard", "commands.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const version = (runLine) => JSON.stringify({ version: 1, commands: [{ id: "hallo", title: "Repo hello", kind: "shell", run: runLine }] });
    fs.writeFileSync(file, version("git rev-parse --sq-quote hallo"));
    await eventually(async () => (await app.invoke("custom_commands_list", { repoId })).repo.state, "untrusted", "the new file is not approved");
    // Disabled entries rank last, so look for the entry itself rather than the first one.
    await page.keyboard.press("Control+p");
    await page.locator(`${PALETTE} input[role="combobox"]`).waitFor({ timeout: 5000 });
    await page.keyboard.type(">Repo hello", { delay: 5 });
    await app.settle();
    const option = page.locator(`${PALETTE} [data-key="command:custom.repo:hallo"]`);
    await option.waitFor({ timeout: 5000 });
    equal(await option.getAttribute("aria-disabled"), "true", "the palette shows it disabled");
    await page.keyboard.press("Escape");
    const listed = await app.invoke("custom_commands_list", { repoId });
    await app.invoke("custom_commands_trust", { repoId, hash: listed.repo.hash });
    await eventually(async () => (await app.invoke("custom_commands_list", { repoId })).repo.state, "trusted", "approved");
    fs.writeFileSync(file, version("git rev-parse --sq-quote anders"));
    await eventually(async () => (await app.invoke("custom_commands_list", { repoId })).repo.state, "changed", "a change needs a new approval");
    const code = await app.invoke("custom_command_run", { repoId, id: "repo:hallo", context: {}, inputs: {}, jobId: "e2e-hallo", confirmed: true }).then(
      () => null,
      (error) => error.code,
    );
    equal(code, "command_untrusted", "the changed file does not run");
  });
} finally {
  if (app) await app.close();
}

process.exit(finish());
