// Checks the contract: methods of CoreCommands in src/core/api.ts against
//   1. the #[tauri::command] functions in src-tauri/src/commands.rs (names and parameters),
//   2. the list in tauri::generate_handler![…] in src-tauri/src/lib.rs,
//   3. the functions in crates/core/src/commands/*.rs (names).
// Usage: node scripts/check-commands.mjs   (exit code 1 on mismatches)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareErrorCodes, readErrorCodeSources } from "./error-codes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");

const toSnake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const toCamel = (name) => name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());

/** Splits at a separator, but only on the top bracket level. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("{(<[".includes(ch)) depth += 1;
    else if ("})>]".includes(ch)) depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Contents of the bracket pair that opens at `start`. */
function balanced(text, start) {
  const open = text[start];
  const close = { "(": ")", "{": "}", "[": "]" }[open];
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  throw new Error(`Bracket at ${start} is never closed`);
}

// --- api.ts -----------------------------------------------------------------

function parseApi() {
  const source = read("src", "core", "api.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const start = source.indexOf("export interface CoreCommands");
  if (start < 0) throw new Error("CoreCommands not found in api.ts");
  const body = balanced(source, source.indexOf("{", start));
  const commands = new Map();
  const method = /(?:^|[;\n])\s*(\w+)\(/g;
  let match;
  while ((match = method.exec(body))) {
    const name = match[1];
    const parenStart = match.index + match[0].length - 1;
    const params = balanced(body, parenStart).trim();
    method.lastIndex = parenStart + params.length + 2;
    const keys = [];
    if (params) {
      const type = params.slice(params.indexOf(":") + 1).trim();
      for (const part of splitTopLevel(type, "&")) {
        if (part === "R") keys.push("repoId");
        else if (part.startsWith("{")) {
          for (const field of splitTopLevel(balanced(part, 0), ";")) {
            const key = /^(\w+)\??\s*:/.exec(field);
            if (!key) throw new Error(`Unreadable field in ${name}: ${field}`);
            keys.push(key[1]);
          }
        } else throw new Error(`Unknown input type in ${name}: ${part}`);
      }
    }
    commands.set(toSnake(name), keys);
  }
  return commands;
}

// --- src-tauri/src/commands.rs -------------------------------------------------

/** Parameters that Tauri supplies itself and that don't come from the input object. */
const INJECTED = /^(tauri::)?(State|AppHandle|Window|WebviewWindow|ipc::Request|Request)\b/;

function parseBindings() {
  const source = read("src-tauri", "src", "commands.rs");
  const commands = new Map();
  const pattern = /((?:^[ \t]*\/\/.*\n)*)^#\[tauri::command\]\s*\n(?:^#\[[^\]]*\]\s*\n)*^pub async fn (\w+)\(/gm;
  let match;
  while ((match = pattern.exec(source))) {
    const name = match[2];
    const params = balanced(source, match.index + match[0].length - 1);
    const annotated = /gc:params\s+([\w,]+)/.exec(match[1]);
    let keys;
    if (annotated) keys = annotated[1].split(",").filter(Boolean);
    else {
      keys = [];
      for (const param of splitTopLevel(params, ",")) {
        const colon = param.indexOf(":");
        const type = param.slice(colon + 1).trim();
        if (INJECTED.test(type)) continue;
        keys.push(toCamel(param.slice(0, colon).trim().replace(/^mut\s+/, "")));
      }
    }
    commands.set(name, keys);
  }
  return commands;
}

function parseHandlerList() {
  const source = read("src-tauri", "src", "lib.rs");
  const start = source.indexOf("generate_handler![");
  if (start < 0) throw new Error("generate_handler! not found in lib.rs");
  const list = balanced(source, source.indexOf("[", start));
  return list
    .split(",")
    .map((entry) => entry.trim().replace(/^commands::/, ""))
    .filter(Boolean);
}

function parseCore() {
  const dir = join(root, "crates", "core", "src", "commands");
  const names = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".rs") || file === "mod.rs") continue;
    const source = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    for (const match of source.matchAll(/^pub async fn (\w+)\(\s*core: &Core/gm)) names.set(match[1], file);
  }
  return names;
}

// --- Comparison -------------------------------------------------------------

const api = parseApi();
const bindings = parseBindings();
const handlers = parseHandlerList();
const core = parseCore();
const problems = [];

for (const [name, keys] of api) {
  if (!bindings.has(name)) problems.push(`Binding missing in src-tauri/src/commands.rs: ${name}`);
  else {
    const got = bindings.get(name);
    const missing = keys.filter((key) => !got.includes(key));
    const extra = got.filter((key) => !keys.includes(key));
    if (missing.length || extra.length) {
      problems.push(
        `Parameters differ for ${name}: api.ts [${keys.join(", ")}] / Rust [${got.join(", ")}]`,
      );
    }
  }
  if (!handlers.includes(name)) problems.push(`Not registered in generate_handler!: ${name}`);
  if (!core.has(name)) problems.push(`Missing in crates/core/src/commands: ${name}`);
}
for (const name of bindings.keys()) {
  if (!api.has(name)) problems.push(`Binding without an entry in api.ts: ${name}`);
}
for (const name of handlers) {
  if (!api.has(name)) problems.push(`Registered, but not in api.ts: ${name}`);
  if (!bindings.has(name)) problems.push(`Registered, but no binding: ${name}`);
}
const seen = new Set();
for (const name of handlers) {
  if (seen.has(name)) problems.push(`Registered twice: ${name}`);
  seen.add(name);
}

// The error codes: Rust enum, TS union, errors.ts record and both locale files (scripts/error-codes.mjs).
problems.push(...compareErrorCodes(readErrorCodeSources(root)));

if (problems.length) {
  console.error(`check-commands: ${problems.length} mismatch(es)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `check-commands: ${api.size} commands in api.ts, ${bindings.size} bindings, ${handlers.length} registered – no mismatches.`,
);
