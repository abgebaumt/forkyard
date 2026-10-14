// Takes the README screenshots on Linux: starts a virtual X display (Xvfb), a Vite server and the
// debug build of the app once per view, runs a showcase scenario (src/screens/Showcase/scenario.ts)
// against the demo repository and saves the window as PNG in docs/images/.
//
//   cargo build && node scripts/screenshots/shoot.mjs [graph diff conflict rebase settings stats] [--light]
//
// Needs Xvfb (or XVFB=/path/to/Xvfb) and ImageMagick's `import`.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const light = args.includes("--light");
const SHOTS = {
  graph: { demo: [] },
  diff: { demo: [] },
  conflict: { demo: ["--conflict"] },
  rebase: { demo: ["--rebase"] },
  settings: { demo: [] },
  stats: { demo: [] },
};
const wanted = args.filter((arg) => !arg.startsWith("--"));
const names = wanted.length ? wanted : Object.keys(SHOTS);
const WIDTH = 1440;
const HEIGHT = 900;
const DISPLAY = ":91";
const PORT = 1431;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "forkyard-shots-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];

function start(command, argv, env = {}) {
  const child = spawn(command, argv, { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  children.push(child);
  return child;
}

async function waitForUrl(url, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // still starting
    }
    await sleep(300);
  }
  throw new Error(`${url} did not come up`);
}

try {
  start(process.env.XVFB ?? "Xvfb", [DISPLAY, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-nolisten", "tcp"]);
  start(path.join(root, "node_modules/.bin/vite"), ["--port", String(PORT), "--strictPort"]);
  await waitForUrl(`http://127.0.0.1:${PORT}/`);
  fs.mkdirSync(path.join(root, "docs/images"), { recursive: true });

  for (const name of names) {
    const shot = SHOTS[name];
    if (!shot) throw new Error(`unknown view: ${name}`);
    // A short, neutral path: the settings page shows it.
    const demo = path.join(os.tmpdir(), "projects", "nimbus");
    execFileSync("node", [path.join(root, "scripts/screenshots/demo-repo.mjs"), demo, ...shot.demo], { stdio: "ignore" });
    const data = path.join(work, name, "data");
    fs.mkdirSync(data, { recursive: true });
    const query = new URLSearchParams({ scenario: `Showcase.${name}`, fixture: demo, theme: light ? "light" : "dark", lang: "en" });
    const app = start(path.join(root, "target/debug/forkyard"), [], {
      DISPLAY,
      GDK_BACKEND: "x11",
      XDG_SESSION_TYPE: "x11",
      WAYLAND_DISPLAY: "",
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      LANG: "en_US.UTF-8",
      LANGUAGE: "en",
      FORKYARD_DATA_DIR: data,
      FORKYARD_KEYRING_SERVICE: "forkyard-screenshots",
      FORKYARD_AVATAR_URL: "off",
      FORKYARD_WINDOW_SIZE: `${WIDTH}x${HEIGHT}`,
      FORKYARD_DEV_URL: `http://127.0.0.1:${PORT}/?${query}`,
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "projects", "nimbus.gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    });
    await sleep(14_000);
    const out = path.join(root, "docs/images", `${name}${light ? "-light" : ""}.png`);
    execFileSync("import", ["-display", DISPLAY, "-window", "root", "-crop", `${WIDTH}x${HEIGHT}+0+0`, "+repage", `png:${out}`]);
    console.log("written:", path.relative(root, out));
    app.kill();
    await sleep(800);
  }
} finally {
  for (const child of children.reverse()) child.kill();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), "projects"), { recursive: true, force: true });
}
