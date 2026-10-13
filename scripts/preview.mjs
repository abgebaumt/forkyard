/**
 * Öffnet eine sichtbare Vorschau der Debug-App.
 * Die App läuft aus einer Kopie unter target/preview, damit `cargo build` weiterarbeiten kann.
 * Ihre Daten (offene Tabs, Repository-Liste, Einstellungen) liegen unter target/preview-data und
 * bleiben zwischen den Starts erhalten. Nur beim ersten Start wird ein Beispiel-Repository geöffnet.
 *
 *   node scripts/preview.mjs [--shot <png>] [--reset]
 *
 * --reset verwirft die gemerkten Daten und beginnt wieder mit dem Beispiel-Repository.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDevServer, launchApp } from "./e2e/driver.mjs";
import { makeRichRepo } from "./e2e/fixtures.mjs";

const shotIndex = process.argv.indexOf("--shot");
const shot = shotIndex > 0 ? process.argv[shotIndex + 1] : null;
const reset = process.argv.includes("--reset");

const previewDir = path.join(ROOT, "target", "preview");
const dataDir = path.join(ROOT, "target", "preview-data");
// Frühere Fassungen hielten die Daten unter target/preview/data und löschten sie bei jedem Start.
const oldDataDir = path.join(previewDir, "data");
if (!reset && !fs.existsSync(dataDir) && fs.existsSync(oldDataDir)) fs.cpSync(oldDataDir, dataDir, { recursive: true });
fs.rmSync(previewDir, { recursive: true, force: true });
fs.mkdirSync(previewDir, { recursive: true });
if (reset) fs.rmSync(dataDir, { recursive: true, force: true });
const firstRun = !fs.existsSync(dataDir);
fs.mkdirSync(dataDir, { recursive: true });

if (firstRun || shot) {
  const app = await launchApp({ dataDir });
  if (firstRun) {
    const repo = makeRichRepo();
    await app.openRepo(repo.path);
    console.log(`Beispiel-Repository: ${repo.path}`);
  }
  if (shot) await app.screenshot(shot);
  await app.close();
}

for (const file of ["forkyard.exe", "forkyard-askpass.exe", "forkyard-editor.exe"]) {
  fs.copyFileSync(path.join(ROOT, "target", "debug", file), path.join(previewDir, file));
}
const url = await ensureDevServer();
const child = spawn(path.join(previewDir, "forkyard.exe"), [], {
  cwd: ROOT,
  detached: true,
  stdio: "ignore",
  env: { ...process.env, FORKYARD_DEV_URL: url, FORKYARD_DATA_DIR: dataDir },
});
child.unref();
console.log(`Vorschau offen (PID ${child.pid}), Daten: ${dataDir}`);
process.exit(0);
