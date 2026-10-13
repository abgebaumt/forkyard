// Checks the colour pairs from design/tokens.json (“pairs”) against WCAG 2.2:
// text 4.5:1, large text (“large”) and UI controls (“ui”) 3:1. Exit code 1 on a violation.
//
//   node scripts/check-contrast.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(resolve(root, "design/tokens.json"), "utf8"));

function color(name) {
  const [theme, ...role] = name.split("-");
  const hex = tokens.color[theme]?.[role.join("-")];
  if (!hex) throw new Error(`Unknown colour: ${name}`);
  return hex;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let failed = 0;
for (const [fg, bg, kind] of tokens.pairs) {
  const needed = kind === "large" || kind === "ui" ? 3 : 4.5;
  const value = ratio(color(fg), color(bg));
  if (value < needed) {
    failed++;
    console.log(`FAIL ${value.toFixed(2)}:1  ${fg} on ${bg} (needs ${needed}:1)`);
  }
}
console.log(`${tokens.pairs.length} pairs, ${failed} below the threshold`);
process.exit(failed ? 1 : 0);
