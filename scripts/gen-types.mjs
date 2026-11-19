// Regenerates src/core/generated/ from the Rust contract types (ts-rs, feature `ts` of gitcore)
// and Settings::default() (settingsDefaults.json). Never edit the generated files by hand.
//
//   npm run gen:types
//
// Export dir and `u64 -> number` come from .cargo/config.toml.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "src/core/generated");

function run(cmd) {
  const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ts-rs only writes types that still exist; start empty so removed types disappear.
rmSync(out, { recursive: true, force: true });
run("cargo test -p gitcore --features ts --lib export_bindings");
run("npx biome format --write src/core/generated");
