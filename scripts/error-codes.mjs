// Cross-check of the error codes: `ErrorCode` in crates/core/src/error.rs (variants, `ErrorCode::ALL`,
// `as_str`), the TS union `ErrorCode` in src/core/types.ts, the `CODES` record in src/app/errors.ts
// and the texts in src/i18n/locales/{en,de}/errors.json. Used by scripts/check-commands.mjs;
// tests: node --test scripts/error-codes.test.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The text between the first `open` after `marker` and the next `close` (or null). */
function between(source, marker, open, close) {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const from = source.indexOf(open, at + marker.length);
  if (from < 0) return null;
  const to = source.indexOf(close, from + open.length);
  return to < 0 ? null : source.slice(from + open.length, to);
}

function rustCodes(source) {
  const clean = withoutComments(source);
  const enumBody = between(clean, "pub enum ErrorCode", "{", "\n}") ?? "";
  const variants = [...enumBody.matchAll(/^\s*([A-Z]\w*)\s*,/gm)].map((match) => match[1]);
  const all = /pub const ALL: \[ErrorCode; (\d+)\] = \[([\s\S]*?)\];/.exec(clean);
  const listed = all ? [...all[2].matchAll(/ErrorCode::(\w+)/g)].map((match) => match[1]) : [];
  const names = new Map([...clean.matchAll(/ErrorCode::(\w+) => "([a-z_]+)"/g)].map((match) => [match[1], match[2]]));
  return { variants, listed, declared: all ? Number(all[1]) : -1, names };
}

function tsUnion(source) {
  const body = between(withoutComments(source), "export type ErrorCode", "=", ";") ?? "";
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

function tsRecord(source) {
  const body = between(withoutComments(source), "const CODES: Record<ErrorCode, true>", "{", "}") ?? "";
  return [...body.matchAll(/^\s*([a-z_]+)\s*:\s*true/gm)].map((match) => match[1]);
}

export function compareErrorCodes({ rust, types, errorsTs, en, de }) {
  const problems = [];
  const { variants, listed, declared, names } = rustCodes(rust);
  if (variants.length === 0) problems.push("ErrorCode: no variants found in crates/core/src/error.rs");
  for (const variant of variants) if (!listed.includes(variant)) problems.push(`ErrorCode::${variant} is missing from ErrorCode::ALL`);
  for (const variant of listed) if (!variants.includes(variant)) problems.push(`ErrorCode::ALL lists the unknown ErrorCode::${variant}`);
  for (const [index, variant] of listed.entries()) if (listed.indexOf(variant) !== index) problems.push(`ErrorCode::ALL lists ErrorCode::${variant} twice`);
  if (declared !== listed.length) problems.push(`ErrorCode::ALL declares ${declared} entries but lists ${listed.length}`);
  for (const variant of variants) if (!names.has(variant)) problems.push(`ErrorCode::${variant} has no text in as_str`);
  const codes = variants.map((variant) => names.get(variant)).filter(Boolean);
  const compare = (label, list) => {
    for (const code of codes) if (!list.includes(code)) problems.push(`${label}: "${code}" is missing`);
    for (const code of list) if (!codes.includes(code)) problems.push(`${label}: "${code}" is not an ErrorCode in error.rs`);
  };
  compare("src/core/types.ts ErrorCode", tsUnion(types));
  compare("src/app/errors.ts CODES", tsRecord(errorsTs));
  for (const [label, texts] of [["en/errors.json", en], ["de/errors.json", de]]) {
    compare(label, Object.keys(texts));
    for (const code of codes) {
      const entry = texts[code];
      if (entry && (typeof entry.text !== "string" || entry.text.trim() === "" || typeof entry.hint !== "string")) {
        problems.push(`${label}: "${code}" needs "text" and "hint"`);
      }
    }
  }
  return problems;
}

export function readErrorCodeSources(root) {
  const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
  return {
    rust: read("crates", "core", "src", "error.rs"),
    types: read("src", "core", "types.ts"),
    errorsTs: read("src", "app", "errors.ts"),
    en: JSON.parse(read("src", "i18n", "locales", "en", "errors.json")),
    de: JSON.parse(read("src", "i18n", "locales", "de", "errors.json")),
  };
}
