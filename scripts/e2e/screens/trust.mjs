/**
 * Trust per repository – in the real app, against real repositories.
 *
 *   node scripts/e2e/screens/trust.mjs                 everything (checks and screenshots)
 *   node scripts/e2e/screens/trust.mjs --only agree    only sections whose title contains "agree"
 *   node scripts/e2e/screens/trust.mjs --show          window visible
 *
 * A repository whose `.git` folder comes from someone else can bring commands along:
 * `core.fsmonitor` runs on every `git status`, hooks on checkout and commit, and a configured
 * proxy would see stored credentials. The file system is used to check that NONE of it runs until
 * the user agrees – and that it runs afterwards (proof that the lock was the reason). The first
 * section does not use the mouse at all.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { createChecks } from "./_wip.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const SHOTS = "target/e2e/shots";
const checks = createChecks("trust");
const { check, equal, eventually, section, finish } = checks;

const PROXY_PASSWORD = "proxy-geheim-4711";
const MARKER = "FSMONITOR-LIEF";
const HOOK_MARKER = "HOOK-LIEF";

let app = null;
/** Fixed data directory so the app can be restarted with the same state. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-e2e-trust-daten-"));
const onError = async (title) => {
  if (app) await app.screenshot(`target/e2e/trust-error-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
};
const run = (title, body) => section(title, body, onError);

/** A repository as it would come from an extracted archive: with commands in its configuration and a hook. */
function makeForeignRepo(name) {
  const repo = makeCleanRepoWithRemote({ name });
  // `git config` itself runs nothing; the status afterwards would be the first call that does.
  repo.git("config", "core.fsmonitor", `touch ${MARKER};:`);
  repo.git("config", "http.proxy", `http://anna:${PROXY_PASSWORD}@boese.example:8080`);
  repo.git("config", "http.sslVerify", "false");
  const hooks = path.join(repo.path, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${HOOK_MARKER}\n`, { mode: 0o755 });
  return repo;
}

const exists = (repo, file) => fs.existsSync(path.join(repo.path, file));
const gate = () => app.page.locator('[data-shell="untrusted"]');
const focusedName = () => app.page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
const codeOf = async (call) => {
  try {
    await call();
    return null;
  } catch (error) {
    return error.code;
  }
};

try {
  // Without the driver's help: the confirmation must stay here.
  app = await launchApp({ show, trustOpened: false, dataDir });
  const { page } = app;
  // No auto-fetch: after agreeing it would otherwise run against the made-up proxy.
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });

  const foreign = makeForeignRepo("fremdes-archiv");
  let foreignId = null;
  let foreignTab = null;

  // -------------------------------------------------------------------------------------------
  await run("Open a foreign repository: locked, nothing runs – keyboard only", async () => {
    check(!exists(foreign, MARKER), "initial state: the command from core.fsmonitor has never run");
    const opened = await app.openRepo(foreign.path);
    foreignId = opened.repoId;
    foreignTab = opened.tabId;
    await gate().waitFor({ state: "visible", timeout: 10_000 });
    await app.settle();

    const heading = await gate().getByRole("heading", { level: 1 }).innerText();
    equal(heading, "“fremdes-archiv” brings its own commands", "the confirmation names the repository");
    const text = await gate().innerText();
    for (const expected of ["core.fsmonitor", `touch ${MARKER};:`, "http.proxy", "http://***@boese.example:8080", "http.sslverify", "Hook post-checkout", "None of it has run so far"]) {
      check(text.includes(expected), `the confirmation shows "${expected}"`);
    }
    check(!text.includes(PROXY_PASSWORD), "a password from the configuration is not shown");
    check(!(await page.content()).includes(PROXY_PASSWORD), "… and is nowhere else in the page either");
    check((await gate().locator("li").count()) === 4, `four findings in the list (got ${await gate().locator("li").count()})`);

    // Instead of the workspace only the confirmation is shown: no repository toolbar, no panels.
    equal(await page.locator('[data-area="left"], [data-area="right"], [data-area="center"]').count(), 0, "no panel of the repo view");
    // The safe choice has focus.
    await eventually(focusedName, "Close tab", "focus is on \"Close tab\"");

    // The core rejects everything that would do something in this repository – even plain reads.
    equal(await codeOf(() => app.invoke("status_get", { repoId: foreignId })), "repo_untrusted", "status_get");
    equal(await codeOf(() => app.invoke("graph_page", { repoId: foreignId, cursor: null, limit: 50 })), "repo_untrusted", "graph_page");
    equal(await codeOf(() => app.invoke("fetch", { repoId: foreignId, jobId: "j-trust-1", remote: null, prune: false })), "repo_untrusted", "fetch");
    equal(await codeOf(() => app.invoke("terminal_open", { repoId: foreignId, cols: 80, rows: 24 })), "repo_untrusted", "terminal_open");
    equal(await codeOf(() => app.invoke("file_read", { repoId: foreignId, path: "README.md", sha: null, encoding: null })), "repo_untrusted", "file_read");
    const listed = (await app.invoke("repo_list")).find((repo) => repo.id === foreignId);
    equal(listed?.trusted, false, "repo_list: trusted is false");

    // Even after a while (file watcher, auto-fetch, tab bar status) nothing has run.
    await page.waitForTimeout(2500);
    check(!exists(foreign, MARKER), "the command from core.fsmonitor did NOT run");
    check(!exists(foreign, HOOK_MARKER), "the hook did not run");
    equal(await page.locator("[data-toast]").count(), 0, "no error toasts");

    await app.screenshot(`${SHOTS}/trust-gate.png`);
    await app.setTheme("light");
    await app.screenshot(`${SHOTS}/trust-gate-light.png`);
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await app.screenshot(`${SHOTS}/trust-gate-min.png`);
    await app.setSize(1440, 900);

    // Tab → "Trust and open" → "Check again": Enter checks again, the findings stay.
    await page.keyboard.press("Tab");
    equal(await focusedName(), "Trust and open", "Tab: on to agreeing");
    await page.keyboard.press("Tab");
    equal(await focusedName(), "Check again", "Tab: on to \"Check again\"");
    foreign.git("config", "--unset", "http.sslVerify");
    await page.keyboard.press("Enter");
    await eventually(() => gate().locator("li").count(), 3, "after \"Check again\" the removed entry is gone");
    check(!exists(foreign, MARKER), "the check itself runs nothing either");
  });

  // -------------------------------------------------------------------------------------------
  await run("App restart: the lock stays, nothing runs at start", async () => {
    await app.close();
    app = await launchApp({ show, trustOpened: false, dataDir });
    // The tab from the last session is back – with the confirmation, not with the workspace.
    equal(await app.page.locator(`[data-tab-id="${foreignTab}"]`).count(), 1, "the tab from the last session is back");
    await gate().waitFor({ state: "visible", timeout: 10_000 });
    await app.page.waitForTimeout(2000);
    check(!exists(foreign, MARKER), "starting with a remembered tab runs nothing");
    equal(await codeOf(() => app.invoke("status_get", { repoId: foreignId })), "repo_untrusted", "status_get after the restart");
  });

  // -------------------------------------------------------------------------------------------
  await run("Agree: afterwards the app works in the repository", async () => {
    const { page } = app;
    await gate().getByRole("button", { name: "Trust and open" }).click();
    await page.locator('[data-area="left"]').waitFor({ state: "visible", timeout: 10_000 });
    await app.settle();
    equal(await gate().count(), 0, "the confirmation is gone");
    const status = await app.invoke("status_get", { repoId: foreignId });
    check(status && typeof status === "object" && "head" in status, "status_get answers");
    const listed = (await app.invoke("repo_list")).find((repo) => repo.id === foreignId);
    equal(listed?.trusted, true, "repo_list: trusted is true");
    // Now Git's normal behaviour applies: the configured command runs on status.
    await eventually(() => exists(foreign, MARKER), true, "after agreeing the command from core.fsmonitor runs (the lock held it back)");
    const trust = await app.invoke("repo_trust_get", { repoId: foreignId });
    equal([trust.trusted, trust.findings.length > 0], [true, true], "repo_trust_get still lists the findings");
    check(!JSON.stringify(trust).includes(PROXY_PASSWORD), "repo_trust_get does not reveal the proxy password");
    await app.screenshot(`${SHOTS}/trust-agreed.png`);
  });

  // -------------------------------------------------------------------------------------------
  await run("Close tab is the default: Enter closes, the repository stays locked", async () => {
    const { page } = app;
    const second = makeForeignRepo("zweites-archiv");
    const opened = await app.openRepo(second.path);
    await gate().waitFor({ state: "visible", timeout: 10_000 });
    await eventually(focusedName, "Close tab", "focus on \"Close tab\"");
    await page.keyboard.press("Enter");
    await eventually(() => page.locator(`[data-tab-id="${opened.tabId}"]`).count(), 0, "the tab is closed");
    const listed = (await app.invoke("repo_list")).find((repo) => repo.id === opened.repoId);
    equal(listed?.trusted, false, "the repository is still listed as untrusted");
    check(!exists(second, MARKER) && !exists(second, HOOK_MARKER), "nothing has run");
    // Reopened from repository management, the same confirmation is shown.
    await app.invoke("tab_open", { repoId: opened.repoId });
    await gate().waitFor({ state: "visible", timeout: 10_000 });
    check(!exists(second, MARKER), "reopening runs nothing either");
    await gate().getByRole("button", { name: "Remove from list" }).click();
    await page.getByRole("button", { name: "Remove from list" }).last().click();
    await eventually(async () => (await app.invoke("repo_list")).some((repo) => repo.id === opened.repoId), false, "\"Remove from list\" removes the entry");
  });

  // -------------------------------------------------------------------------------------------
  await run("Ordinary repository: no confirmation", async () => {
    const { page } = app;
    const plain = makeCleanRepoWithRemote({ name: "eigenes-projekt" });
    const opened = await app.openRepo(plain.path);
    await page.locator('[data-area="left"]').waitFor({ state: "visible", timeout: 10_000 });
    equal(await gate().count(), 0, "no confirmation");
    const listed = (await app.invoke("repo_list")).find((repo) => repo.id === opened.repoId);
    equal(listed?.trusted, true, "trusted right away");
    const trust = await app.invoke("repo_trust_get", { repoId: opened.repoId });
    equal(trust.findings, [], "the check finds nothing");
  });

  equal(app.consoleErrors, [], "no console errors");
} finally {
  await app?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(finish());
