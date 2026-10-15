// Builds the demo repository used for the README screenshots: a small invented project
// ("nimbus", a weather API) with several authors, feature branches, merges, tags, a remote
// that is ahead, a stash and uncommitted work. Same steps, same SHAs.
//
//   node scripts/screenshots/demo-repo.mjs <target-dir> [--conflict | --rebase] [--history] [--clean] [--image]
//
// --conflict leaves the repository in the middle of a merge with a conflict in src/forecast.ts.
// --rebase ends on feature/alerts, a few commits ahead of main.
// --history first adds two and a half years of invented history (six authors, several time zones),
//   so that the statistics have something to show.
// --clean leaves the working directory clean (no stash, no uncommitted work), e.g. for bisect.
// --image commits a radar map (docs/radar.png) and changes it in the working directory.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? "target/demo/nimbus");
const conflict = process.argv.includes("--conflict");
const rebase = process.argv.includes("--rebase");
const history = process.argv.includes("--history");
const clean = process.argv.includes("--clean");
const image = process.argv.includes("--image");

const PEOPLE = [
  { name: "Maya Chen", email: "maya@nimbus.example" },
  { name: "Leo Park", email: "leo@nimbus.example" },
  { name: "Sofia Rossi", email: "sofia@nimbus.example" },
  { name: "Noah Fischer", email: "noah@nimbus.example" },
  // Only in the --history part.
  { name: "Amara Okafor", email: "amara@nimbus.example" },
  { name: "Jonas Berg", email: "jonas@nimbus.example" },
];
let clock = Date.UTC(2026, 8, 1, 8, 0, 0) / 1000;
let zone = "+0000";
let person = PEOPLE[0];

const env = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(target, "..", "nimbus.gitconfig"),
  GIT_AUTHOR_NAME: person.name,
  GIT_AUTHOR_EMAIL: person.email,
  GIT_COMMITTER_NAME: person.name,
  GIT_COMMITTER_EMAIL: person.email,
  GIT_AUTHOR_DATE: `${clock} ${zone}`,
  GIT_COMMITTER_DATE: `${clock} ${zone}`,
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
if (history) addHistory(r);

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

commit(r, 0, history ? "Move the service to the new project layout" : "Initial project setup", {
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

if (image) {
  fs.mkdirSync(path.join(r, "docs"), { recursive: true });
  radar(path.join(r, "docs/radar.png"), 0);
  person = PEOPLE[2];
  clock += 3 * 3600;
  git(r, "add", "docs/radar.png");
  git(r, "commit", "-q", "-m", "Docs: add the radar map");
}

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
} else if (!clean) {
  // A stash and uncommitted work for the commit panel.
  write(r, "src/cache.ts", fs.readFileSync(path.join(r, "src/cache.ts"), "utf8").replace("ttl = 600_000", "ttl = 300_000"));
  git(r, "stash", "push", "-q", "-m", "Try a shorter cache TTL");
  write(r, "src/forecast.ts", forecast().replace("hours = 24", "hours = 36").replace(" * station.rain", " * station.rain * 1.1"));
  write(r, "README.md", fs.readFileSync(path.join(r, "README.md"), "utf8") + "\n## Development\n\nRun `npm test` before pushing.\n");
  write(r, "src/units.ts", "export const toFahrenheit = (celsius: number) => celsius * 1.8 + 32;\n");
  git(r, "add", "README.md");
}

// The rain radar map moves east in the working directory.
if (image) radar(path.join(r, "docs/radar.png"), 1);

console.log(target);

/** Draws the radar map with ImageMagick; `step` moves the rain front. */
function radar(file, step) {
  const dx = step * 170;
  const cells = [
    [150, 170, 70, "#2f9e6b"],
    [215, 215, 58, "#2f9e6b"],
    [120, 255, 46, "#2f9e6b"],
    [175, 205, 36, "#d9b531"],
    [205, 180, 22, "#d9b531"],
    [190, 200, 14, "#d0503c"],
    [270, 140, 40, "#2f9e6b"],
    [95, 120, 30, "#2f9e6b"],
  ];
  const draw = [];
  for (const [x, y, rad, color] of cells) {
    const cx = x + dx;
    const cy = y - step * 25;
    const size = step ? Math.round(rad * 1.12) : rad;
    draw.push("-fill", color, "-draw", `circle ${cx},${cy} ${cx + size},${cy}`);
  }
  const coast = "polygon 0,330 90,300 160,315 240,290 330,305 420,270 520,290 640,250 640,400 0,400";
  const args = [
    "-size", "640x400", "xc:#16303f",
    "-fill", "#29483a", "-draw", coast,
    "(", "-size", "640x400", "xc:none", ...draw, "-blur", "0x14", "-channel", "A", "-evaluate", "multiply", "0.85", "+channel", ")",
    "-composite",
    "-stroke", "#5d7c8a", "-strokewidth", "1", "-fill", "none",
    "-draw", "line 0,100 640,100", "-draw", "line 0,200 640,200", "-draw", "line 0,300 640,300",
    "-draw", "line 160,0 160,400", "-draw", "line 320,0 320,400", "-draw", "line 480,0 480,400",
    "-stroke", "none", "-fill", "#e6edf0", "-draw", "circle 470,262 476,262", "-draw", "circle 205,302 211,302",
    "-strip", "-define", "png:exclude-chunks=date,time",
    `png24:${file}`,
  ];
  execFileSync("magick", args, { stdio: "ignore" });
}

/**
 * Two and a half years of history before the scripted commits: the service grows from a sensor
 * importer into an API, people join and leave, activity has quiet summers and busy release weeks.
 * Deterministic (own random generator), so the numbers stay the same between runs.
 */
function addHistory(root) {
  let seed = 20240401;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const DAY = 86_400;
  // Per person: time zone (hours), working hours (local), share of commits, files they work on, active period.
  const crew = [
    { who: 0, zone: 2, start: 9, end: 18, weight: 5, areas: ["models", "api", "docs"], from: "2024-04-01", to: "2026-12-31" },
    { who: 1, zone: 2, start: 10, end: 20, weight: 4, areas: ["api", "server", "test"], from: "2024-04-20", to: "2026-12-31" },
    { who: 2, zone: 1, start: 8, end: 17, weight: 3, areas: ["charts", "docs", "test"], from: "2024-09-02", to: "2026-12-31" },
    { who: 3, zone: -5, start: 9, end: 23, weight: 2, areas: ["sensors", "models"], from: "2024-06-10", to: "2026-12-31" },
    { who: 4, zone: 1, start: 7, end: 16, weight: 3, areas: ["sensors", "scripts", "test"], from: "2025-02-03", to: "2026-12-31" },
    { who: 5, zone: 1, start: 11, end: 22, weight: 3, areas: ["api", "scripts", "sensors"], from: "2024-04-01", to: "2025-06-30" },
  ];
  const AREAS = {
    models: ["src/models/wind.ts", "src/models/humidity.ts", "src/models/pressure.ts", "src/models/dewpoint.ts"],
    api: ["src/api/routes.ts", "src/api/auth.ts", "src/api/rate-limit.ts", "src/api/errors.ts"],
    server: ["src/api/routes.ts", "src/api/middleware.ts"],
    charts: ["src/charts/axis.ts", "src/charts/legend.ts", "src/charts/palette.ts"],
    sensors: ["src/sensors/harbor.ts", "src/sensors/ridge.ts", "src/sensors/calibrate.ts", "src/sensors/protocol.ts"],
    scripts: ["scripts/import-readings.ts", "scripts/backfill.ts"],
    test: ["test/models.test.ts", "test/api.test.ts", "test/sensors.test.ts"],
    docs: ["docs/api.md", "docs/deploy.md", "docs/sensors.md"],
  };
  const VERBS = {
    models: ["Wind model: smooth gusts over five minutes", "Humidity: clamp readings above 100 %", "Pressure: convert to sea level", "Models: share the rounding helper", "Dew point: use the Magnus formula", "Wind model: handle calm readings", "Models: cache derived values", "Pressure: trend over three hours"],
    api: ["API: validate station ids", "API: return 404 for unknown stations", "Auth: rotate signing keys", "Rate limit: per token instead of per IP", "API: add ETag headers", "Errors: one JSON shape for all routes", "API: paginate /readings", "Auth: reject expired tokens early"],
    server: ["Server: graceful shutdown", "Middleware: log request ids", "Server: compress JSON responses", "Middleware: time out slow requests"],
    charts: ["Charts: nicer axis ticks", "Legend: wrap long station names", "Palette: colour-blind safe rain scale", "Charts: draw the zero line", "Axis: label every third hour"],
    sensors: ["Harbor sensor: retry on checksum errors", "Ridge sensor: new firmware protocol", "Calibrate: per-season offsets", "Sensors: drop duplicate readings", "Protocol: parse battery level", "Harbor sensor: wind direction in degrees", "Calibrate: store offsets per station"],
    scripts: ["Import: read the 2023 archive", "Backfill: skip stations without data", "Import: progress output", "Backfill: run per month"],
    test: ["Tests: cover pressure conversion", "Tests: API error shapes", "Tests: sensor fixtures from the harbor", "Tests: faster model tests", "Tests: flaky timeout in api.test"],
    docs: ["Docs: deployment with systemd", "Docs: API examples", "Docs: sensor wiring", "Docs: fix broken links", "Docs: describe rate limits"],
  };
  const files = new Map();
  let serial = 0;
  const block = (rel) => {
    serial += 1;
    if (rel.endsWith(".md")) return [`## Note ${serial}`, "", `Readings are averaged over ${2 + (serial % 9)} minutes before they are stored.`, ""];
    const name = `${pick(["adjust", "normalize", "smooth", "derive", "check", "parse"])}${serial}`;
    return [`export function ${name}(value: number): number {`, `  return value * ${(0.5 + random()).toFixed(3)} + ${(random() * 4 - 2).toFixed(2)};`, "}", ""];
  };
  const edit = (rel) => {
    const lines = files.get(rel) ?? (rel.endsWith(".md") ? [`# ${path.basename(rel, ".md")}`, ""] : [`// ${rel}`, ""]);
    if (lines.length > 12 && random() < 0.45) {
      // Rewrite a few existing lines somewhere in the file.
      const at = 2 + Math.floor(random() * (lines.length - 6));
      const fresh = block(rel);
      lines.splice(at, Math.min(fresh.length, lines.length - at), ...fresh);
    } else {
      lines.push(...block(rel));
    }
    if (random() < 0.12 && lines.length > 30) lines.splice(2 + Math.floor(random() * 10), 4);
    files.set(rel, lines);
    write(root, rel, lines.join("\n"));
  };
  // Activity per month: a slow start, quiet summers and Christmas, busy weeks before releases.
  const intensity = (date) => {
    const month = date.getUTCMonth();
    const year = date.getUTCFullYear();
    let level = year === 2024 ? 0.9 : year === 2025 ? 1.5 : 1.25;
    if (month === 6 || month === 7) level *= 0.45;
    if (month === 11 && date.getUTCDate() > 18) level *= 0.15;
    if ((year === 2025 && month === 2) || (year === 2025 && month === 9) || (year === 2026 && month === 4)) level *= 1.9;
    return level;
  };
  const start = Date.UTC(2024, 3, 1) / 1000;
  const end = Date.UTC(2026, 7, 28) / 1000;
  for (let day = start; day < end; day += DAY) {
    const date = new Date(day * 1000);
    const iso = date.toISOString().slice(0, 10);
    const weekday = date.getUTCDay();
    const team = crew.filter((member) => iso >= member.from && iso <= member.to);
    const planned = [];
    for (const member of team) {
      const workday = weekday !== 0 && weekday !== 6;
      const chance = (workday ? 0.16 : 0.025) * member.weight * 0.22 * intensity(date) * (weekday === 5 ? 0.7 : 1);
      let count = 0;
      while (random() < chance && count < 4) count += 1;
      const hours = [];
      for (let i = 0; i < count; i++) {
        const late = random() < 0.12;
        hours.push(late ? member.end + random() * 2 : member.start + random() * (member.end - member.start));
      }
      for (const hour of hours) planned.push({ member, at: Math.round(day + (hour - member.zone) * 3600) });
    }
    planned.sort((a, b) => a.at - b.at);
    for (const { member, at } of planned) {
      const area = pick(member.areas);
      const touched = new Set([pick(AREAS[area])]);
      if (random() < 0.15) touched.add(pick(AREAS.test));
      if (random() < 0.2) touched.add(pick(AREAS[pick(member.areas)]));
      for (const rel of touched) edit(rel);
      // Now and then a larger piece of work.
      if (random() < 0.04) for (let i = 0; i < 4 + Math.floor(random() * 8); i++) edit(pick(AREAS[area]));
      person = PEOPLE[member.who];
      zone = `${member.zone < 0 ? "-" : "+"}${String(Math.abs(member.zone)).padStart(2, "0")}00`;
      clock = at;
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", pick(VERBS[area]));
    }
  }
  clock = Date.UTC(2026, 8, 1, 8, 0, 0) / 1000;
  zone = "+0000";
}
