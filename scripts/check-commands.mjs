// Checks the contract: methods of CoreCommands in src/core/api.ts against
//   1. the commands in src-tauri/src/commands.rs (names and parameters): the lines of the
//      `commands! { … }` table plus the hand-written #[tauri::command] functions,
//   2. the registration: table lines and the `hand_written:` list (the macro's `handler()`,
//      which lib.rs must pass to `invoke_handler`),
//   3. the functions in crates/core/src/commands/**/*.rs (names).
// Usage: node scripts/check-commands.mjs   (exit code 1 on mismatches)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** Parameter keys of a Rust parameter list, without the ones Tauri injects. */
function paramKeys(params) {
  const keys = [];
  for (const param of splitTopLevel(params, ",")) {
    const colon = param.indexOf(":");
    if (INJECTED.test(param.slice(colon + 1).trim())) continue;
    keys.push(
      toCamel(
        param
          .slice(0, colon)
          .trim()
          .replace(/^mut\s+/, ""),
      ),
    );
  }
  return keys;
}

/**
 * Reads commands.rs: `bindings` (name -> parameter keys) from the `commands! { … }` table and the
 * hand-written functions, `handlers` (registered names) from the table and its `hand_written:` list.
 */
export function parseBindings(source) {
  const bindings = new Map();
  const handlers = [];
  const start = source.search(/^commands! \{/m);
  if (start < 0) throw new Error("commands! { … } table not found in commands.rs");
  const table = balanced(source, source.indexOf("{", start)).replace(/\/\/.*$/gm, "");
  const hand = /hand_written:([^;]*);/.exec(table);
  if (!hand) throw new Error("hand_written: list not found in the commands! table");
  handlers.push(...splitTopLevel(hand[1], ","));
  for (const match of table.matchAll(/^\s*(\w+)\s*=>\s*\w+::\w+\(/gm)) {
    bindings.set(match[1], paramKeys(balanced(table, match.index + match[0].length - 1)));
    handlers.push(match[1]);
  }
  const pattern = /((?:^[ \t]*\/\/.*\n)*)^#\[tauri::command\]\s*\n(?:^#\[[^\]]*\]\s*\n)*^pub async fn (\w+)\(/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match[2];
    if (bindings.has(name)) throw new Error(`${name} is both in the table and hand-written`);
    const annotated = /gc:params\s+([\w,]+)/.exec(match[1]);
    bindings.set(
      name,
      annotated ? annotated[1].split(",").filter(Boolean) : paramKeys(balanced(source, match.index + match[0].length - 1)),
    );
  }
  return { bindings, handlers };
}

function parseCore() {
  const dir = join(root, "crates", "core", "src", "commands");
  const names = new Map();
  // Commands may live in a module's sub-files (e.g. commands/rebase/cherry_pick.rs).
  for (const file of readdirSync(dir, { recursive: true })) {
    if (!file.endsWith(".rs") || file === "mod.rs") continue;
    const source = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    for (const match of source.matchAll(/^pub async fn (\w+)\(\s*core: &Core/gm)) names.set(match[1], file);
  }
  return names;
}

// --- Comparison -------------------------------------------------------------

function main() {
  const api = parseApi();
  const { bindings, handlers } = parseBindings(read("src-tauri", "src", "commands.rs"));
  const core = parseCore();
  const problems = [];
  if (!read("src-tauri", "src", "lib.rs").includes(".invoke_handler(commands::handler())")) {
    problems.push("lib.rs does not register commands::handler() with invoke_handler");
  }

  for (const [name, keys] of api) {
    if (!bindings.has(name)) problems.push(`Binding missing in src-tauri/src/commands.rs: ${name}`);
    else {
      const got = bindings.get(name);
      const missing = keys.filter((key) => !got.includes(key));
      const extra = got.filter((key) => !keys.includes(key));
      if (missing.length || extra.length) {
        problems.push(`Parameters differ for ${name}: api.ts [${keys.join(", ")}] / Rust [${got.join(", ")}]`);
      }
    }
    if (!handlers.includes(name)) problems.push(`Not registered (table or hand_written list): ${name}`);
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
  console.log(`check-commands: ${api.size} commands in api.ts, ${bindings.size} bindings, ${handlers.length} registered – no mismatches.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
