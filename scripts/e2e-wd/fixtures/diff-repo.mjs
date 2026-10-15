/**
 * Fixtures for features/diff.mjs: a small, fully controlled Git repository (several authors,
 * fixed dates) and a PNG encoder that draws pixel by pixel, so the image diff can be checked
 * against an exact number of changed pixels.
 *
 *   const repo = makeDiffRepo();
 *   repo.write("a.txt", "eins\n"); repo.commit("Erster Stand", PEOPLE.lena);
 *   repo.git("status", "--porcelain");   // stdout (trimmed)
 *   repo.cleanup();
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { globalGitConfig, gitIsolationEnv } from "../../e2e/fixtures.mjs";

export const PEOPLE = {
  lena: { name: "Lena Hartmann", email: "lena.hartmann@wetterstation.example" },
  jonas: { name: "Jonas Albrecht", email: "jonas.albrecht@wetterstation.example" },
  aylin: { name: "Aylin Demir", email: "aylin.demir@wetterstation.example" },
};

const live = new Set();
process.on("exit", () => {
  for (const dir of live) fs.rmSync(dir, { recursive: true, force: true });
});

/** Empty repository on branch main in its own temp folder (prefix fy-wd-diff-). */
export function makeDiffRepo(name = "messdaten") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-diff-"));
  live.add(root);
  const repoPath = path.join(root, name);
  fs.mkdirSync(repoPath);
  const configPath = path.join(root, "gitconfig");
  fs.writeFileSync(configPath, globalGitConfig());
  const env = { ...process.env, ...gitIsolationEnv(configPath), GIT_OPTIONAL_LOCKS: "0" };
  let day = 0;
  const gitRaw = (args, { person = PEOPLE.lena, date = null, input } = {}) =>
    execFileSync("git", args, {
      cwd: repoPath,
      input,
      env: {
        ...env,
        GIT_AUTHOR_NAME: person.name,
        GIT_AUTHOR_EMAIL: person.email,
        GIT_COMMITTER_NAME: person.name,
        GIT_COMMITTER_EMAIL: person.email,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  const git = (...args) => gitRaw(args).toString("utf8").trim();
  gitRaw(["init", "-q", "-b", "main"]);
  const write = (file, content) => {
    const target = path.join(repoPath, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const read = (file) => fs.readFileSync(path.join(repoPath, file));
  const exists = (file) => fs.existsSync(path.join(repoPath, file));
  const remove = (file) => fs.rmSync(path.join(repoPath, file), { force: true });
  /** Stages everything and commits with a fixed date (one day per commit); returns the SHA. */
  const commit = (message, person = PEOPLE.lena) => {
    day += 1;
    const date = `2026-03-${String(day).padStart(2, "0")}T09:${String(day).padStart(2, "0")}:00+01:00`;
    gitRaw(["add", "-A"], { person, date });
    gitRaw(["commit", "-q", "-m", message], { person, date });
    return git("rev-parse", "HEAD");
  };
  return {
    path: repoPath,
    root,
    git,
    gitRaw,
    write,
    read,
    exists,
    remove,
    commit,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      live.delete(root);
    },
  };
}

/** git log --follow as a list: SHA, author, summary, +/- (like the history list). */
export function followLog(repo, file) {
  const entries = [];
  for (const line of repo.git("-c", "core.quotepath=false", "log", "--follow", "--numstat", "--format=%H%x09%an%x09%s", "--", file).split("\n")) {
    const parts = line.split("\t");
    if (/^[0-9a-f]{40}$/.test(parts[0] ?? "")) entries.push({ sha: parts[0], author: parts[1], summary: parts[2], added: null, removed: null });
    else if (parts.length >= 3 && entries.length) Object.assign(entries[entries.length - 1], { added: parts[0], removed: parts[1] });
  }
  return entries;
}

/** git blame --porcelain as one entry per line: SHA, author, summary, text. */
export function blamePorcelain(repo, file, rev = null) {
  const output = repo.gitRaw(["blame", "--porcelain", ...(rev ? [rev] : []), "--", file]).toString("utf8").split("\n");
  const commits = new Map();
  const lines = [];
  let current = null;
  for (const line of output) {
    if (line.startsWith("\t")) {
      lines.push({ sha: current, text: line.slice(1), ...commits.get(current) });
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header) {
      current = header[1];
      if (!commits.has(current)) commits.set(current, {});
    } else if (line.startsWith("author ")) commits.get(current).author = line.slice(7);
    else if (line.startsWith("summary ")) commits.get(current).summary = line.slice(8);
  }
  return lines;
}

/** Consecutive lines of the same commit merged into blocks (1-based line numbers). */
export function blameBlocks(lines) {
  const blocks = [];
  lines.forEach((line, index) => {
    const last = blocks[blocks.length - 1];
    if (last && last.sha === line.sha) last.end = index + 1;
    else blocks.push({ sha: line.sha, start: index + 1, end: index + 1, author: line.author, summary: line.summary });
  });
  return blocks;
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

/** Opaque RGB PNG; `pixel(x, y)` returns [r, g, b]. `level`: zlib level (same pixels, other bytes). */
export function pngFrom(width, height, pixel, { level = 6 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
}

/** A "landscape" picture: sky above, meadow below; optionally a sun rectangle (x, y, w, h). */
export function landscape(width, height, { sun = null, sky = [110, 170, 230], meadow = [80, 150, 80] } = {}) {
  return pngFrom(width, height, (x, y) => {
    if (sun && x >= sun.x && x < sun.x + sun.w && y >= sun.y && y < sun.y + sun.h) return [250, 200, 40];
    return y < height * 0.6 ? sky : meadow;
  });
}
