/**
 * Fixtures for scripts/e2e-wd/features/stash.mjs: the clean "messnetz" repository from
 * scripts/e2e/fixtures.mjs plus committed files that make line and hunk selection interesting
 * (two hunks far apart, CRLF line endings, no final newline).
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";

/** 30 lines; changes in line 3 and line 27 end up in two separate hunks. */
export const MEASUREMENTS = Array.from({ length: 30 }, (_, index) => `2026-03-${String(index + 1).padStart(2, "0")};${(4 + index / 10).toFixed(1)}`);
export const CRLF_LINES = ["eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn"];

/**
 * Clean repository (branch main, remote origin) with three extra committed files:
 * `messwerte.csv` (30 lines, LF), `crlf.txt` (CRLF) and `ohne-ende.txt` (no final newline).
 * Extra helpers: `read(rel)` (utf8), `bytes(rel)` (Buffer), `lines(...gitArgs)`.
 */
export function makeStashRepo({ name = "stash-messnetz" } = {}) {
  const repo = makeCleanRepoWithRemote({ name });
  repo.write("messwerte.csv", `${MEASUREMENTS.join("\n")}\n`);
  repo.write("crlf.txt", `${CRLF_LINES.join("\r\n")}\r\n`);
  repo.write("ohne-ende.txt", "alpha\nbeta\ngamma");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Messwerte und Textdateien");
  return {
    ...repo,
    read: (rel) => fs.readFileSync(path.join(repo.path, rel), "utf8"),
    bytes: (rel) => fs.readFileSync(path.join(repo.path, rel)),
    exists: (rel) => fs.existsSync(path.join(repo.path, rel)),
    remove: (rel) => fs.rmSync(path.join(repo.path, rel), { force: true }),
    lines: (...args) => repo.git(...args).split(/\r?\n/).filter(Boolean),
  };
}

/** `messwerte.csv` with line 3 and line 27 changed (two hunks). */
export function measurementsWithTwoChanges() {
  const lines = [...MEASUREMENTS];
  lines[2] = "2026-03-03;9.9";
  lines[26] = "2026-03-27;0.1";
  return `${lines.join("\n")}\n`;
}
