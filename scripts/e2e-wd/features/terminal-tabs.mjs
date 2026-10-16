/**
 * Terminal tabs (1.2, Paket 0): several shells in one repository tab, switching keeps each output,
 * arrow keys move between the tabs, closing a running session asks first, the last one closes the
 * panel; German texts.
 *
 *   node scripts/e2e-wd/features/terminal-tabs.mjs
 *
 * Like palette-shortcuts.mjs the app runs with SHELL=/bin/bash and a throw-away HOME (prompt "fy$ "),
 * so the user's shell profile and history are never touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";
import { makeBranchRepo } from "../fixtures/branches.mjs";

const TERMINAL = '[data-screen="terminal"]';
const TERMINAL_INPUT = `${TERMINAL} .xterm-helper-textarea`;
const TABS = `${TERMINAL} [role="tablist"]`;

function shellHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-shell-home-"));
  fs.writeFileSync(path.join(home, ".bash_profile"), "export PS1='fy$ '\nunset HISTFILE\nexport HISTSIZE=0\n");
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const shellEnv = () => ({ SHELL: "/bin/bash", HOME: shellHome(), HISTFILE: "/dev/null" });

const sessions = (app, tabId) => app.exec((id) => window.__gcTerminal?.sessions(id) ?? [], tabId);
const text = (app, tabId) => app.exec((id) => window.__gcTerminal?.text(id) ?? "", tabId);
const focused = (app) => app.exec((selector) => Boolean(document.activeElement?.closest(`${selector} .xterm`)), TERMINAL);
const tabStripText = (app) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? "", TABS);

async function waitText(app, tabId, pattern) {
  try {
    return await app.waitFor(async () => (await text(app, tabId)).match(pattern), 20_000, { message: `terminal shows ${pattern}` });
  } catch (error) {
    throw new Error(`${error.message}\nLast lines:\n${(await text(app, tabId)).split("\n").slice(-12).join("\n")}`);
  }
}

async function run(app, line) {
  await app.type(TERMINAL_INPUT, line);
  await app.press("Enter");
}

function dialogInfo(app) {
  return app.exec(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
    if (!dialog) return null;
    return {
      title: dialog.querySelector("h2")?.innerText.trim() ?? "",
      text: dialog.innerText.replace(/\s+/g, " ").trim(),
      buttons: [...dialog.querySelectorAll("footer button")].map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })),
    };
  });
}

const waitDialog = (app, titlePattern) =>
  app.waitFor(
    async () => {
      const info = await dialogInfo(app);
      return info && titlePattern.test(info.title) ? info : null;
    },
    10_000,
    { message: `dialog ${titlePattern}` },
  );

const noDialog = (app) => app.waitFor(async () => (await app.$$('[role="dialog"], [role="alertdialog"]')).length === 0, 8000, { message: "dialog closed" });

async function dialogButton(app, label) {
  const button = await app.waitFor(
    () =>
      app.exec((wanted) => {
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
        return [...(dialog?.querySelectorAll("footer button") ?? [])].find((el) => el.innerText.trim() === wanted && !el.disabled) ?? null;
      }, label),
    8000,
    { message: `dialog button “${label}”` },
  );
  await button.click();
}

async function start(t, options = {}) {
  const repo = makeBranchRepo();
  const app = await t.launch({ lang: "en", theme: "light", width: 1440, height: 900, env: shellEnv(), ...options });
  const { tabId } = await app.openRepo(repo.path);
  await app.press("Control+`");
  await app.waitFor(TERMINAL, 10_000, { message: "terminal panel" });
  await app.waitFor(
    async () => {
      const list = await sessions(app, tabId);
      return list.length === 1 && list[0].status === "running";
    },
    20_000,
    { message: "first shell running" },
  );
  await waitText(app, tabId, /fy\$/);
  await app.waitFor(() => focused(app), 10_000, { message: "focus in the terminal" });
  return { repo, app, tabId };
}

scenario("terminal tabs: a second shell, switching keeps each output, closing asks first", "main", async (t) => {
  const { repo, app, tabId } = await start(t);
  try {
    let list = await sessions(app, tabId);
    assertEqual(list.map((session) => session.title), ["Shell"], "one tab named Shell");
    assertIncludes(await tabStripText(app), "running", "the state as a word in the tab");
    await run(app, "echo EINS-$((1+1))");
    await waitText(app, tabId, /EINS-2/);

    await app.click(`${TERMINAL} button[data-action="new-shell"]`);
    await app.waitFor(
      async () => {
        const now = await sessions(app, tabId);
        return now.length === 2 && now[1].active && now[1].status === "running";
      },
      20_000,
      { message: "second shell shown and running" },
    );
    list = await sessions(app, tabId);
    assertEqual(list.map((session) => session.title), ["Shell", "Shell 2"]);
    await waitText(app, tabId, /fy\$/);
    await app.waitFor(() => focused(app), 10_000, { message: "focus in the new shell" });
    await run(app, "echo ZWEI-$((2+2))");
    await waitText(app, tabId, /ZWEI-4/);
    assert(!(await text(app, tabId)).includes("EINS-2"), "the second shell has its own output");
    await t.shot("terminal-tabs-two-shells");

    await app.click(`${TERMINAL} [data-terminal-tab="${list[0].key}"] [role="tab"]`);
    await app.waitFor(async () => (await sessions(app, tabId))[0].active, 5000, { message: "first tab shown" });
    await waitText(app, tabId, /EINS-2/);
    assert(!(await text(app, tabId)).includes("ZWEI-4"), "switching shows the first shell's output");

    // Keyboard: the arrow keys move between the tabs.
    await app.exec((selector) => document.querySelector(selector)?.focus(), `${TERMINAL} [data-terminal-tab="${list[0].key}"] [role="tab"]`);
    await app.press("ArrowRight");
    await app.waitFor(async () => (await sessions(app, tabId))[1].active, 5000, { message: "ArrowRight shows the second tab" });

    // Closing a running session asks; Cancel keeps it.
    const closeSecond = `${TERMINAL} [data-terminal-tab="${list[1].key}"] button[data-action="close-session"]`;
    await app.click(closeSecond);
    const info = await waitDialog(app, /Shell 2/);
    assertIncludes(info.text, "ends", "the dialog says that the session ends");
    await dialogButton(app, "Cancel");
    await noDialog(app);
    assertEqual((await sessions(app, tabId)).length, 2, "Cancel keeps both");
    await app.click(closeSecond);
    await waitDialog(app, /Shell 2/);
    await dialogButton(app, "Close session");
    await noDialog(app);
    await app.waitFor(
      async () => {
        const now = await sessions(app, tabId);
        return now.length === 1 && now[0].active;
      },
      5000,
      { message: "one tab left and shown" },
    );
    assert(await app.$(TERMINAL), "the panel stays");
    await waitText(app, tabId, /EINS-2/);

    // The last one closes the panel.
    await app.click(`${TERMINAL} [data-terminal-tab="${list[0].key}"] button[data-action="close-session"]`);
    await waitDialog(app, /Shell/);
    await dialogButton(app, "Close session");
    await app.waitFor(async () => !(await app.$(TERMINAL)), 5000, { message: "terminal panel gone" });
    assertEqual(await sessions(app, tabId), [], "no session left");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("terminal tabs: German texts", "edge", async (t) => {
  const { repo, app, tabId } = await start(t, { lang: "de" });
  try {
    const label = await app.exec((selector) => document.querySelector(selector)?.getAttribute("aria-label"), `${TERMINAL} button[data-action="new-shell"]`);
    assertEqual(label, "Neue Shell");
    assertIncludes(await tabStripText(app), "läuft", "German state word");
    const key = (await sessions(app, tabId))[0].key;
    await app.click(`${TERMINAL} [data-terminal-tab="${key}"] button[data-action="close-session"]`);
    const info = await waitDialog(app, /„Shell“ schließen\?/);
    assert(info.buttons.some((button) => button.text === "Sitzung schließen"), "German confirm button");
    await dialogButton(app, "Abbrechen");
    await noDialog(app);
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
