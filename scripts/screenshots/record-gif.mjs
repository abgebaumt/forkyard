// Records the README animation (docs/images/tour.gif): runs the showcase tour
// (src/screens/Showcase/scenario.ts › tour) on the demo repository (with --history, for the statistics) under Xvfb and captures it with ffmpeg.
//
//   cargo build && node scripts/screenshots/record-gif.mjs
//
// Needs Xvfb (or XVFB=/path/to/Xvfb) and ffmpeg.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WIDTH = 1440;
const HEIGHT = 900;
const DISPLAY = ":92";
const PORT = 1432;
/** The app needs a few seconds to start; the tour waits that long before its first step. */
const START_DELAY_MS = 10000;
/** The page starts loading about this long after the process (the tour counts from page load). */
const PAGE_LOAD_MS = 4000;
const LENGTH_S = 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const start = (command, argv, env = {}) => {
  const child = spawn(command, argv, { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  children.push(child);
  return child;
};

const projects = path.join(os.tmpdir(), "projects");
const demo = path.join(projects, "nimbus");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "forkyard-gif-"));
const video = path.join(data, "tour.mp4");
const out = path.join(root, "docs/images/tour.gif");

try {
  start(process.env.XVFB ?? "Xvfb", [DISPLAY, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-nolisten", "tcp"]);
  start(path.join(root, "node_modules/.bin/vite"), ["--port", String(PORT), "--strictPort"]);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
    } catch {
      await sleep(300);
    }
  }
  execFileSync("node", [path.join(root, "scripts/screenshots/demo-repo.mjs"), demo, "--history"], { stdio: "ignore" });
  const query = new URLSearchParams({ scenario: "Showcase.tour", fixture: demo, theme: "dark", lang: "en", delay: String(START_DELAY_MS - PAGE_LOAD_MS) });
  start(path.join(root, "target/debug/forkyard"), [], {
    DISPLAY,
    GDK_BACKEND: "x11",
    XDG_SESSION_TYPE: "x11",
    WAYLAND_DISPLAY: "",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    LANG: "en_US.UTF-8",
    FORKYARD_DATA_DIR: path.join(data, "app"),
    FORKYARD_KEYRING_SERVICE: "forkyard-screenshots",
    FORKYARD_AVATAR_URL: "off",
    FORKYARD_UPDATE_URL: "off",
    FORKYARD_WINDOW_SIZE: `${WIDTH}x${HEIGHT}`,
    FORKYARD_DEV_URL: `http://127.0.0.1:${PORT}/?${query}`,
    GIT_CONFIG_GLOBAL: path.join(projects, "nimbus.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  await sleep(START_DELAY_MS + 800);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${WIDTH}x${HEIGHT}`, "-framerate", "15", "-i", `${DISPLAY}.0`, "-t", String(LENGTH_S), "-pix_fmt", "yuv420p", video]);
  const filters = "fps=12,scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vf", filters, "-loop", "0", out]);
  console.log("written:", path.relative(root, out), `${Math.round(fs.statSync(out).size / 1024)} KB`);
} finally {
  for (const child of children.reverse()) child.kill();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(projects, { recursive: true, force: true });
}
