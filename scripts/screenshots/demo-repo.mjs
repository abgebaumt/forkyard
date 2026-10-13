// Builds the demo repository used for the README screenshots: a small invented project
// ("nimbus", a weather API) with several authors, feature branches, merges, tags, a remote
// that is ahead, a stash and uncommitted work. Same steps, same SHAs.
//
//   node scripts/screenshots/demo-repo.mjs <target-dir> [--conflict]
//
// --conflict leaves the repository in the middle of a merge with a conflict in src/forecast.ts.
// --rebase ends on feature/alerts, a few commits ahead of main.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? "target/demo/nimbus");
const conflict = process.argv.includes("--conflict");
const rebase = process.argv.includes("--rebase");

const PEOPLE = [
  { name: "Maya Chen", email: "maya@nimbus.example" },
  { name: "Leo Park", email: "leo@nimbus.example" },
  { name: "Sofia Rossi", email: "sofia@nimbus.example" },
  { name: "Noah Fischer", email: "noah@nimbus.example" },
];
let clock = Date.UTC(2026, 8, 1, 8, 0, 0) / 1000;
let person = PEOPLE[0];

const env = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(target, "..", "nimbus.gitconfig"),
  GIT_AUTHOR_NAME: person.name,
  GIT_AUTHOR_EMAIL: person.email,
  GIT_COMMITTER_NAME: person.name,
  GIT_COMMITTER_EMAIL: person.email,
  GIT_AUTHOR_DATE: `${clock} +0000`,
  GIT_COMMITTER_DATE: `${clock} +0000`,
  LC_ALL: "C",
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function commit(root, who, message, files) {
  person = PEOPLE[who];
  clock += 3600 * (3 + ((clock / 3600) % 5));
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

fs.rmSync(path.dirname(target), { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(env().GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[gc]\n\tauto = 0\n");
const remote = path.join(path.dirname(target), "nimbus-origin.git");
git(path.dirname(target), "init", "-q", "--bare", remote);
git(path.dirname(target), "init", "-q", target);
const r = target;
git(r, "config", "user.name", PEOPLE[0].name);
git(r, "config", "user.email", PEOPLE[0].email);

const forecast = (extra = "") => `import { Station } from "./station";

export interface Forecast {
  station: string;
  hours: number[];
  /** Degrees Celsius per hour. */
  temperature: number[];
  precipitation: number[];
}

export function forecastFor(station: Station, hours = 24): Forecast {
  const range = Array.from({ length: hours }, (_, i) => i);
  return {
    station: station.id,
    hours: range,
    temperature: range.map((h) => station.baseline + Math.sin(h / 3) * station.swing),
    precipitation: range.map((h) => Math.max(0, Math.cos(h / 5)) * station.rain),
  };
}
${extra}`;

commit(r, 0, "Initial project setup", {
  "README.md": "# nimbus\n\nA tiny weather API for local stations.\n",
  "package.json": JSON.stringify({ name: "nimbus", version: "0.1.0", type: "module", scripts: { test: "vitest run" } }, null, 2) + "\n",
  ".gitignore": "node_modules/\ndist/\n.env\n",
  "src/station.ts": "export interface Station {\n  id: string;\n  name: string;\n  baseline: number;\n  swing: number;\n  rain: number;\n}\n",
});
commit(r, 0, "Add forecast model", { "src/forecast.ts": forecast() });
commit(r, 1, "Add HTTP server with /forecast route", {
  "src/server.ts": 'import { createServer } from "node:http";\nimport { forecastFor } from "./forecast";\nimport { stations } from "./stations";\n\ncreateServer((req, res) => {\n  const id = new URL(req.url ?? "/", "http://x").searchParams.get("station") ?? "north";\n  res.setHeader("content-type", "application/json");\n  res.end(JSON.stringify(forecastFor(stations[id] ?? stations.north)));\n}).listen(8080);\n',
  "src/stations.ts": 'import type { Station } from "./station";\n\nexport const stations: Record<string, Station> = {\n  north: { id: "north", name: "North Ridge", baseline: 9, swing: 4, rain: 2 },\n  harbor: { id: "harbor", name: "Harbor", baseline: 13, swing: 3, rain: 4 },\n};\n',
});
git(r, "tag", "-a", "v0.1.0", "-m", "First preview");
git(r, "remote", "add", "origin", remote);
git(r, "push", "-q", "-u", "origin", "main", "--tags");

git(r, "switch", "-q", "-c", "feature/hourly-chart");
commit(r, 2, "Render hourly temperature chart", { "src/chart.ts": "export function sparkline(values: number[]): string {\n  const bars = \"▁▂▃▄▅▆▇█\";\n  const min = Math.min(...values);\n  const max = Math.max(...values);\n  return values.map((v) => bars[Math.round(((v - min) / (max - min || 1)) * 7)]).join(\"\");\n}\n" });
commit(r, 2, "Chart: show precipitation as second row", { "src/chart.ts": "export function sparkline(values: number[]): string {\n  const bars = \"▁▂▃▄▅▆▇█\";\n  const min = Math.min(...values);\n  const max = Math.max(...values);\n  return values.map((v) => bars[Math.round(((v - min) / (max - min || 1)) * 7)]).join(\"\");\n}\n\nexport function chart(temperature: number[], rain: number[]): string {\n  return `${sparkline(temperature)}\\n${sparkline(rain)}`;\n}\n" });

git(r, "switch", "-q", "main");
git(r, "switch", "-q", "-c", "fix/negative-rain");
commit(r, 3, "Clamp precipitation to zero", { "src/forecast.ts": forecast("\nexport const clamp = (value: number) => Math.max(0, value);\n") });
git(r, "switch", "-q", "main");
person = PEOPLE[0];
clock += 7200;
git(r, "merge", "-q", "--no-ff", "fix/negative-rain", "-m", "Merge branch 'fix/negative-rain'");
git(r, "branch", "-q", "-d", "fix/negative-rain");
commit(r, 1, "Cache forecasts for ten minutes", { "src/cache.ts": "const store = new Map<string, { at: number; value: unknown }>();\n\nexport function cached<T>(key: string, make: () => T, ttl = 600_000): T {\n  const hit = store.get(key);\n  if (hit && Date.now() - hit.at < ttl) return hit.value as T;\n  const value = make();\n  store.set(key, { at: Date.now(), value });\n  return value;\n}\n" });
person = PEOPLE[2];
clock += 5400;
git(r, "merge", "-q", "--no-ff", "feature/hourly-chart", "-m", "Merge branch 'feature/hourly-chart'");
commit(r, 0, "Document the API in the README", { "README.md": "# nimbus\n\nA tiny weather API for local stations.\n\n## API\n\n`GET /forecast?station=north` returns the next 24 hours.\n" });
git(r, "tag", "-a", "v0.2.0", "-m", "Charts and caching");
git(r, "push", "-q", "origin", "main", "--tags");

git(r, "switch", "-q", "-c", "feature/alerts");
commit(r, 3, "Add storm alert thresholds", { "src/alerts.ts": "export const STORM_WIND = 75;\nexport const HEAVY_RAIN = 8;\n\nexport function alertsFor(wind: number, rain: number): string[] {\n  const alerts: string[] = [];\n  if (wind >= STORM_WIND) alerts.push(\"storm\");\n  if (rain >= HEAVY_RAIN) alerts.push(\"heavy-rain\");\n  return alerts;\n}\n" });
commit(r, 3, "Alerts: expose /alerts route", { "src/server.ts": fs.readFileSync(path.join(r, "src/server.ts"), "utf8") + "\n// TODO: route /alerts to alertsFor()\n" });
git(r, "push", "-q", "-u", "origin", "feature/alerts");

git(r, "switch", "-q", "main");
git(r, "switch", "-q", "-c", "feature/stations-api");
commit(r, 1, "List all stations at /stations", { "src/stations.ts": fs.readFileSync(path.join(r, "src/stations.ts"), "utf8") + "\nexport const stationList = () => Object.values(stations).map(({ id, name }) => ({ id, name }));\n" });
git(r, "switch", "-q", "main");

// The remote gets a commit the local main does not have yet (shown as "behind").
const other = path.join(path.dirname(target), "nimbus-teammate");
git(path.dirname(target), "clone", "-q", remote, other);
git(other, "config", "user.name", PEOPLE[1].name);
git(other, "config", "user.email", PEOPLE[1].email);
commit(other, 1, "Add harbor wind sensor", { "src/stations.ts": fs.readFileSync(path.join(other, "src/stations.ts"), "utf8").replace("rain: 4 }", "rain: 4, wind: true }") });
git(other, "push", "-q", "origin", "main");
git(r, "fetch", "-q", "origin");

if (rebase) {
  git(r, "switch", "-q", "feature/alerts");
  commit(r, 3, "Alerts: add wind gust threshold", { "src/alerts.ts": fs.readFileSync(path.join(r, "src/alerts.ts"), "utf8").replace("export const HEAVY_RAIN = 8;", "export const HEAVY_RAIN = 8;\nexport const GUST = 90;") });
  commit(r, 3, "fixup: typo in alert name", { "src/alerts.ts": fs.readFileSync(path.join(r, "src/alerts.ts"), "utf8").replace('"heavy-rain"', '"heavy_rain"') });
  commit(r, 0, "Alerts: document thresholds", { "docs/alerts.md": "# Alerts\n\n| Alert | Threshold |\n| --- | --- |\n| storm | wind ≥ 75 km/h |\n| heavy_rain | ≥ 8 mm/h |\n" });
} else if (conflict) {
  commit(r, 0, "Forecast: default to 48 hours", { "src/forecast.ts": forecast().replace("hours = 24", "hours = 48") });
  git(r, "switch", "-q", "-c", "feature/units", "HEAD~1");
  commit(r, 2, "Forecast: default to 12 hours for mobile", { "src/forecast.ts": forecast().replace("hours = 24", "hours = 12") });
  git(r, "switch", "-q", "main");
  try {
    git(r, "merge", "feature/units");
  } catch {
    // expected: conflict in src/forecast.ts
  }
} else {
  // A stash and uncommitted work for the commit panel.
  write(r, "src/cache.ts", fs.readFileSync(path.join(r, "src/cache.ts"), "utf8").replace("ttl = 600_000", "ttl = 300_000"));
  git(r, "stash", "push", "-q", "-m", "Try a shorter cache TTL");
  write(r, "src/forecast.ts", forecast().replace("hours = 24", "hours = 36").replace(" * station.rain", " * station.rain * 1.1"));
  write(r, "README.md", fs.readFileSync(path.join(r, "README.md"), "utf8") + "\n## Development\n\nRun `npm test` before pushing.\n");
  write(r, "src/units.ts", "export const toFahrenheit = (celsius: number) => celsius * 1.8 + 32;\n");
  git(r, "add", "README.md");
}

console.log(target);
