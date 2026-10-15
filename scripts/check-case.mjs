#!/usr/bin/env node
// Fails when two tracked paths differ only in letter case. Windows and macOS treat them as the same
// file, so imports like "./ImageDiff" and "./imageDiff" break the build there while Linux is fine.
// Imports leave out the extension, so "imageDiff.ts" and "ImageDiff.tsx" count as a clash too.
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const SCRIPT = /\.(m?[jt]sx?)$/;
/** Lower-cased name → the spellings seen (folders as they are, files without a script extension). */
const spellings = new Map();
const note = (name) => {
  const key = name.toLowerCase();
  if (!spellings.has(key)) spellings.set(key, new Set());
  spellings.get(key).add(name);
};
for (const file of files) {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) note(parts.slice(0, depth).join("/") + "/");
  note(file.replace(SCRIPT, ""));
}
const clashes = [...spellings.values()].filter((names) => names.size > 1).map((names) => [...names]);
for (const names of clashes) console.error(`check-case: ${names.map((name) => `"${name}"`).join(" and ")} differ only in case`);
if (clashes.length) process.exit(1);
console.log(`check-case: ${files.length} files, no paths that differ only in case.`);
