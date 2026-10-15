/**
 * Builds the debug app (`cargo build`) and makes the copy the WebDriver tests run from
 * (target/e2e-wd/bin/<mtime>/forkyard plus its helpers). Prints the path of the copy.
 *
 *   node scripts/e2e-wd/prepare.mjs              build + copy
 *   node scripts/e2e-wd/prepare.mjs --no-build   only copy the current build
 */
import { spawnSync } from "node:child_process";
import { ROOT, ensureAppCopy, ensureDevServer, findTools } from "./driver.mjs";

if (!process.argv.includes("--no-build")) {
  console.log("cargo build …");
  const result = spawnSync("cargo", ["build"], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error("cargo build failed.");
    process.exit(result.status ?? 1);
  }
}
const copy = await ensureAppCopy();
console.log(`App copy: ${copy}`);
const tools = findTools();
for (const [name, value] of Object.entries({ "tauri-driver": tools.tauriDriver, "native driver": tools.native, ...(process.platform === "win32" ? {} : { Xvfb: tools.xvfb }) })) {
  console.log(`${name}: ${value ?? "MISSING"}`);
}
console.log(`Vite server: ${await ensureDevServer()}`);
