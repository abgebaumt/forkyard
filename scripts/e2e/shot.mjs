/**
 * Screenshot of the real app:
 *
 *   node scripts/e2e/shot.mjs --fixture rich --scenario RepoManagement.manage --size 1440x900 --out target/e2e/shots/repo-management.png
 *
 * Options:
 *   --fixture <name>     rich | clean | remote | empty | conflict | detached | large | notarepo | none (default: none)
 *                        The repository is opened before the scenario runs; the scenario gets its
 *                        path as ctx.fixture. `--no-open` only creates it.
 *   --scenario <id>      e.g. Shell.menu (src/screens/<Folder>/scenario.ts)
 *   --size <WxH>         inner size of the real window, default 1440x900 (the image has exactly that many pixels)
 *   --theme <dark|light> forces the theme
 *   --param key=value    additional URL parameter for the scenario (repeatable)
 *   --wait-for <css>     wait for this element before the shot
 *   --wait <ms>          wait additionally
 *   --out <file>         target file (PNG), relative to the project folder
 *   --no-git             starts the app as if Git were not installed
 *   --show               window visible on screen
 *
 * Exit code 1 if the page reported console errors or the scenario failed; the image is still
 * written where possible.
 */
import path from "node:path";
import { launchApp } from "./driver.mjs";
import { fixtures } from "./fixtures.mjs";

function parseArgs(argv) {
  const args = { fixture: "none", size: "1440x900", out: null, scenario: null, theme: null, params: {}, open: true, show: false, wait: 0, waitFor: null, noGit: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--fixture") args.fixture = value();
    else if (flag === "--scenario") args.scenario = value();
    else if (flag === "--size") args.size = value();
    else if (flag === "--theme") args.theme = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--wait") args.wait = Number(value());
    else if (flag === "--wait-for") args.waitFor = value();
    else if (flag === "--param") {
      const [key, ...rest] = value().split("=");
      args.params[key] = rest.join("=");
    } else if (flag === "--no-open") args.open = false;
    else if (flag === "--no-git") args.noGit = true;
    else if (flag === "--show") args.show = true;
    else throw new Error(`Unknown option ${flag}. See the header of scripts/e2e/shot.mjs.`);
  }
  const size = /^(\d+)x(\d+)$/.exec(args.size);
  if (!size) throw new Error(`--size expects WIDTHxHEIGHT, e.g. 1440x900 (was: ${args.size}).`);
  args.width = Number(size[1]);
  args.height = Number(size[2]);
  if (!args.out) throw new Error("--out is missing (target file of the screenshot).");
  if (args.fixture !== "none" && !fixtures[args.fixture]) throw new Error(`Unknown fixture "${args.fixture}". Available: ${Object.keys(fixtures).join(", ")}, none`);
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

let fixture = null;
let app = null;
let failed = false;
try {
  fixture = args.fixture === "none" ? null : fixtures[args.fixture]();
  app = await launchApp({
    width: args.width,
    height: args.height,
    theme: args.theme ?? undefined,
    show: args.show,
    gitPath: args.noGit ? path.join(process.cwd(), "no-git-here", "git.exe") : undefined,
    params: { ...args.params, ...(fixture ? { fixture: fixture.path } : {}) },
  });
  if (fixture && args.open && args.fixture !== "notarepo" && !args.noGit) await app.openRepo(fixture.path);
  if (args.scenario) {
    try {
      await app.runScenario(args.scenario);
    } catch (error) {
      failed = true;
      console.error(error.message);
    }
  }
  if (args.waitFor) await app.page.waitForSelector(args.waitFor, { state: "visible" });
  if (args.wait) await app.page.waitForTimeout(args.wait);
  await app.settle().catch(() => undefined);
  const file = await app.screenshot(args.out);
  console.log(`Screenshot: ${file} (${args.width}×${args.height}, started in ${app.startupMs} ms)`);
  if (app.consoleErrors.length) {
    failed = true;
    console.error(`${app.consoleErrors.length} console errors:`);
    for (const line of app.consoleErrors) console.error(`  ${line}`);
  }
} catch (error) {
  failed = true;
  console.error(error.stack ?? error.message);
} finally {
  await app?.close();
  fixture?.cleanup();
}
process.exit(failed ? 1 : 0);
