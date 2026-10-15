/**
 * Tiny test framework for WebDriver features (scripts/e2e-wd/features/*.mjs).
 *
 *   import { scenario, assert, assertEqual } from "../lib.mjs";
 *   scenario("graph renders", "main", async (t) => {
 *     const app = await t.launch();            // closed automatically after the scenario
 *     await app.openRepo(repo.path);
 *     await t.shot("graph");                   // target/e2e-wd/shots/<feature>/graph.png
 *     assert(await app.$("canvas"), "no canvas");
 *     await t.noConsoleErrors(app);
 *   });
 *
 * Scenarios of a file run one after another in the order they are declared. When the event loop
 * runs dry, the results go to target/e2e-wd/results/<feature>.json and the process exit code is
 * 1 if any scenario failed. A failing scenario screenshots every app that is still open
 * (shots/<feature>/FAIL-<scenario>[-n].png). `E2E_WD_ONLY=<text>` runs only scenarios whose name
 * contains the text.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, launchApp, openApps } from "./driver.mjs";

const featureFile = process.argv[1] ? path.basename(process.argv[1], ".mjs") : "feature";
export const FEATURE = process.env.E2E_WD_FEATURE || featureFile;
export const RESULTS_DIR = path.join(ROOT, "target", "e2e-wd", "results");
export const SHOTS_DIR = path.join(ROOT, "target", "e2e-wd", "shots", FEATURE);
const ONLY = process.env.E2E_WD_ONLY || null;

const results = [];
let chain = Promise.resolve();
let declared = 0;

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "scenario";

export class AssertionError extends Error {}

export function assert(condition, message = "assertion failed") {
  if (!condition) throw new AssertionError(message);
  return condition;
}

export function assertEqual(actual, expected, message = "values differ") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${message}: expected ${e}, got ${a}`);
}

export function assertIncludes(haystack, needle, message = "not included") {
  const ok = typeof haystack === "string" ? haystack.includes(needle) : Array.isArray(haystack) && haystack.includes(needle);
  if (!ok) throw new AssertionError(`${message}: ${JSON.stringify(needle)} not in ${JSON.stringify(haystack).slice(0, 300)}`);
}

export function assertMatch(text, pattern, message = "does not match") {
  if (!pattern.test(String(text))) throw new AssertionError(`${message}: ${JSON.stringify(String(text)).slice(0, 300)} !~ ${pattern}`);
}

/**
 * Declares a scenario. `kind` is "main" (the main path of a feature) or "edge" (edge case).
 * `fn(t)` gets: t.launch(options) -> app (closed after the scenario), t.app (last launched),
 * t.shot(name, app?) -> path, t.step(text), t.noConsoleErrors(app?), t.shotsDir, t.feature.
 */
export function scenario(name, kind, fn) {
  if (kind !== "main" && kind !== "edge") throw new Error(`scenario "${name}": kind must be "main" or "edge"`);
  declared += 1;
  if (ONLY && !name.includes(ONLY)) return;
  chain = chain.then(() => runOne(name, kind, fn));
}

async function runOne(name, kind, fn) {
  const started = Date.now();
  const apps = [];
  const steps = [];
  const shots = [];
  const t = {
    feature: FEATURE,
    shotsDir: SHOTS_DIR,
    app: null,
    async launch(options) {
      const app = await launchApp(options);
      apps.push(app);
      t.app = app;
      return app;
    },
    step(text) {
      steps.push({ at: Date.now() - started, text });
      console.log(`  · ${text}`);
    },
    async shot(shotName, app = t.app) {
      const file = await app.screenshot(path.join(SHOTS_DIR, `${slug(shotName)}.png`));
      shots.push(path.relative(ROOT, file));
      return file;
    },
    async noConsoleErrors(app = t.app) {
      const errors = await app.errors();
      if (errors.length) throw new AssertionError(`console errors:\n${errors.join("\n")}`);
    },
  };
  console.log(`▶ ${FEATURE} › ${name} [${kind}]`);
  let error = null;
  try {
    await fn(t);
  } catch (caught) {
    error = caught;
  }
  if (error) {
    // Every app this process still has open, not only the ones launched via t.launch.
    let index = 0;
    for (const app of openApps()) {
      index += 1;
      try {
        const file = await app.screenshot(path.join(SHOTS_DIR, `FAIL-${slug(name)}${index > 1 ? `-${index}` : ""}.png`));
        shots.push(path.relative(ROOT, file));
      } catch {
        // the app may be gone
      }
    }
  }
  const consoleErrors = [];
  for (const app of apps) {
    try {
      consoleErrors.push(...(await app.errors()));
    } catch {
      consoleErrors.push(...app.consoleErrors);
    }
    await app.close().catch(() => undefined);
  }
  const result = {
    name,
    kind,
    status: error ? "failed" : "passed",
    ms: Date.now() - started,
    startupMs: apps.map((app) => app.startupMs),
    steps,
    shots,
    consoleErrors,
    error: error ? String(error.stack ?? error.message ?? error) : null,
  };
  results.push(result);
  console.log(`${error ? "✗" : "✓"} ${FEATURE} › ${name} (${result.ms} ms)${error ? `\n${result.error}` : ""}`);
}

let written = false;
process.on("beforeExit", async () => {
  if (written) return;
  // Wait for the chain (beforeExit fires again once it settles, but be explicit).
  await chain;
  if (written) return;
  written = true;
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const failed = results.filter((result) => result.status === "failed").length;
  const summary = {
    feature: FEATURE,
    finishedAt: new Date().toISOString(),
    declared,
    ran: results.length,
    passed: results.length - failed,
    failed,
    ms: results.reduce((sum, result) => sum + result.ms, 0),
    scenarios: results,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, `${FEATURE}.json`), JSON.stringify(summary, null, 2));
  if (failed || results.length === 0) process.exitCode = 1;
  console.log(`${FEATURE}: ${summary.passed}/${summary.ran} passed${results.length === 0 ? " (no scenario ran)" : ""}`);
});
