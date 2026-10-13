/**
 * Smoke test of the real app: start → shell visible → open a repository through the UI →
 * tab and status bar are right → close the tab. No console errors.
 *
 *   node scripts/e2e/smoke.mjs                 one instance
 *   node scripts/e2e/smoke.mjs --instances 3   several at once (own ports and folders)
 *   node scripts/e2e/smoke.mjs --show          window visible
 */
import { launchApp } from "./driver.mjs";
import { makeRichRepo } from "./fixtures.mjs";

const argv = process.argv.slice(2);
const instances = Math.max(1, Number(argv[argv.indexOf("--instances") + 1]) || 1);
const show = argv.includes("--show");

async function run(index) {
  const label = instances > 1 ? `[${index + 1}] ` : "";
  const step = (text) => console.log(`${label}✓ ${text}`);
  const repo = makeRichRepo();
  let app = null;
  try {
    app = await launchApp({ show });
    const { page } = app;
    step(`App started (${app.startupMs} ms, CDP port ${app.port})`);

    if ((await app.waitForShell()) !== "app") throw new Error("A full-page error message is shown instead of the shell.");
    await page.getByRole("tablist", { name: "Open repositories" }).waitFor();
    await page.getByRole("tab", { name: "Repositories" }).waitFor();
    if (app.consoleErrors.length) throw new Error(`Console errors after start:\n${app.consoleErrors.join("\n")}`);
    step("Shell visible, no console errors");

    // The system folder dialog cannot be remote-controlled; window.__gcTestPicks replaces it.
    await app.pick(repo.path);
    // The button belongs to repository management (repo-management); if it is ever renamed there, the shell shortcut (Alt+O) does the job.
    const openButton = page.locator('[data-screen="repo-management"]').getByRole("button", { name: /^Open/ }).first();
    if (await openButton.isVisible().catch(() => false)) await openButton.click();
    else await page.keyboard.press("Alt+o");
    const tab = page.getByRole("tab", { name: /wetterstation/ });
    await tab.waitFor();
    if ((await tab.getAttribute("aria-selected")) !== "true") throw new Error("The new tab is not active.");
    await page.getByRole("toolbar", { name: "Repository actions" }).waitFor();
    step("Repository opened through the UI, tab \"wetterstation\" is active");

    const footer = page.locator("footer");
    await footer.getByText("main", { exact: true }).waitFor();
    await footer.getByLabel("2 commits ahead").waitFor();
    await footer.getByLabel("1 commit behind").waitFor();
    step("Status bar shows branch main, 2 ahead, 1 behind");

    await page.getByRole("button", { name: "Close wetterstation" }).click();
    await tab.waitFor({ state: "detached" });
    await page.locator('[data-screen="repo-management"]').waitFor();
    step("Tab closed, repository management is back");

    if (app.consoleErrors.length) throw new Error(`Console errors:\n${app.consoleErrors.join("\n")}`);
    step("no console errors");
  } catch (error) {
    if (app) await app.screenshot(`target/e2e-smoke/error-${index + 1}.png`).catch(() => undefined);
    throw error;
  } finally {
    await app?.close();
    repo.cleanup();
  }
}

const started = Date.now();
const results = await Promise.allSettled(Array.from({ length: instances }, (_, index) => run(index)));
const failures = results.filter((result) => result.status === "rejected");
for (const failure of failures) console.error(`✗ ${failure.reason?.stack ?? failure.reason}`);
console.log(
  failures.length
    ? `Smoke test failed: ${failures.length} of ${instances} instances (image under target/e2e-smoke/).`
    : `Smoke test green: ${instances} ${instances === 1 ? "instance" : "instances at once"}, ${Date.now() - started} ms.`,
);
process.exit(failures.length ? 1 : 0);
