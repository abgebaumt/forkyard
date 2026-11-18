/**
 * Real Git repositories for E2E tests and screenshots, in temp folders.
 *
 *   import { makeRichRepo } from "./fixtures.mjs";
 *   const repo = makeRichRepo();   // { path, remotePath, root, info, git(...args), write(rel, text), commitOnRemote(), cleanup() }
 *   …
 *   repo.cleanup();
 *
 * Available: makeRichRepo, makeCleanRepoWithRemote, makeEmptyRepo, makeConflictRepo, makeDetachedRepo,
 * makeLargeRepo(n), makeNotARepo. `node scripts/e2e/fixtures.mjs rich --keep` creates one and shows it.
 *
 * Properties:
 * - Fixed identity and fixed, increasing timestamps: the same steps produce the same SHAs.
 * - Isolated from the machine's Git configuration (GIT_CONFIG_NOSYSTEM, own GIT_CONFIG_GLOBAL) –
 *   the user's autocrlf, aliases and hook templates have no effect.
 * - The identity is also written to each repo's .git/config, so the app finds it even when it
 *   runs with a different global configuration.
 * - All content is made up (a small German project "Wetterstation-Auswertung", weather station
 *   analysis); it is test data and stays German on purpose.
 * - The functions are synchronous and return `cleanup()`; `cleanupAllFixtures()` removes
 *   everything this process created (also runs at process exit).
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const TEST_IDENTITY = { name: "Lena Hartmann", email: "lena.hartmann@wetterstation.example" };
const JONAS = { name: "Jonas Albrecht", email: "jonas.albrecht@wetterstation.example" };
const AYLIN = { name: "Aylin Demir", email: "aylin.demir@wetterstation.example" };
const MATS = { name: "Mats Öztürk", email: "mats.oeztuerk@wetterstation.example" };
const GRETA = { name: "Greta Vogel", email: "greta.vogel@wetterstation.example" };
const PEOPLE = [TEST_IDENTITY, JONAS, AYLIN, MATS, GRETA];

/** 2026-03-02 08:00:00 +01:00 – starting point of all fixture timestamps. */
const EPOCH = 1772434800;
const ZONE = "+0100";

/** Content of the global gitconfig fixtures are built with (and the driver starts the app with). */
export function globalGitConfig(identity = TEST_IDENTITY) {
  const user = identity ? `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n` : "";
  return `${user}[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n[advice]\n\tdetachedHead = false\n[gc]\n\tauto = 0\n`;
}

/** Environment that isolates Git from the machine's configuration. */
export function gitIsolationEnv(globalConfigPath) {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: ":",
    GIT_MERGE_AUTOEDIT: "no",
    LC_ALL: "C",
  };
}

const live = new Set();

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch {
    // On Windows a process that just exited may still hold the folder briefly; then it stays in temp.
  }
}

export function cleanupAllFixtures() {
  for (const dir of [...live]) {
    removeDir(dir);
    live.delete(dir);
  }
}
process.on("exit", cleanupAllFixtures);

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Removes temp folders with this prefix whose owner is no longer alive (a script was killed
 * before it could clean up). The owner is stored as a PID in the file `.owner`.
 */
export function sweepStaleTemp(prefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry === path.basename(CACHE_ROOT)) continue;
    const dir = path.join(os.tmpdir(), entry);
    try {
      const owner = Number(fs.readFileSync(path.join(dir, ".owner"), "utf8"));
      if (!isAlive(owner)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // no owner file or still locked: leave it
    }
  }
}
let swept = false;

const CACHE_ROOT = path.join(os.tmpdir(), "gc-fix-cache");
/** If this file or Git changes, the cache is rebuilt. */
let cacheVersion = null;
function cacheKey() {
  if (!cacheVersion) {
    const source = fs.readFileSync(new URL(import.meta.url));
    const gitVersion = execFileSync("git", ["--version"], { windowsHide: true }).toString();
    cacheVersion = crypto.createHash("sha1").update(source).update(gitVersion).digest("hex").slice(0, 12);
  }
  return cacheVersion;
}

/**
 * Fixtures are built once (the rich one takes a good 8 s on Windows) and afterwards only copied
 * from the cache under %TEMP%/gc-fix-cache. `GC_FIXTURE_CACHE=0` turns that off.
 */
function cached(prefix, variant, name, build, { remote = false } = {}) {
  if (process.env.GC_FIXTURE_CACHE === "0") {
    const built = build();
    return publish(built.ws, name, built.info, remote);
  }
  const dir = path.join(CACHE_ROOT, `${cacheKey()}-${prefix}-${variant.replace(/[^A-Za-z0-9_-]/g, "_")}`);
  const meta = path.join(dir, "fixture.json");
  if (!fs.existsSync(meta)) {
    const built = build();
    fs.writeFileSync(path.join(built.root, "fixture.json"), JSON.stringify({ info: built.info ?? null }));
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    try {
      fs.renameSync(built.root, dir);
      live.delete(built.root);
    } catch {
      // Another process was faster, or the folder is still locked: then do without the cache.
      if (!fs.existsSync(meta)) {
        fs.rmSync(path.join(built.root, "fixture.json"), { force: true });
        return publish(built.ws, name, built.info, remote);
      }
      built.cleanup();
    }
    pruneCache();
  }
  const ws = workspace(prefix);
  // The cache folder's bookkeeping files stay there. Above all `.owner`: it holds the PID of the
  // process that once built the fixture – long gone. If it were copied, the copy would look orphaned
  // while copying, and `sweepStaleTemp` of a script starting at the same time would delete it
  // mid-copy (seen: "ENOENT … fixture.json" in interaction.mjs).
  const own = new Set([".owner", "fixture.json", "gitconfig"].map((file) => path.join(dir, file)));
  fs.cpSync(dir, ws.root, { recursive: true, filter: (source) => !own.has(source) });
  const { info } = JSON.parse(fs.readFileSync(meta, "utf8"));
  if (remote) ws.git(path.join(ws.root, name), ["remote", "set-url", "origin", path.join(ws.root, "origin.git")]);
  return publish(ws, name, info, remote);
}

/** What a fixture exposes. */
function publish(ws, name, info, remote) {
  const repo = path.join(ws.root, name);
  const remotePath = path.join(ws.root, "origin.git");
  // Later commits from tests come after the fixture's history in time.
  ws.tick(60 * 24 * 30);
  let colleagues = 0;
  return {
    /** The repository (working directory). */
    path: repo,
    /** Temp folder that holds everything. */
    root: ws.root,
    info,
    /** Runs git in the repository: `repo.git("status", "--short")` → stdout. Fixed author, increasing time. */
    git: (...args) => ws.git(repo, args, { time: ws.tick(1) }),
    /** Writes a file in the working directory (folders are created). */
    write: (rel, content) => write(repo, rel, content),
    cleanup: ws.cleanup,
    ...(remote
      ? {
          /** The bare repository behind "origin". */
          remotePath,
          /**
           * Creates a new commit on the remote – as if someone else had pushed. The local
           * repository only notices on the next fetch. Returns the SHA.
           */
          commitOnRemote({ branch = "main", file = "docs/aus-dem-remote.md", content, message = "Nachtrag aus dem Remote", person = JONAS } = {}) {
            colleagues += 1;
            const clone = path.join(ws.root, `kollege-${colleagues}`);
            ws.git(ws.root, ["clone", "-q", "--branch", branch, remotePath, clone]);
            write(clone, file, content ?? `Nachtrag ${colleagues} aus dem Remote.\n`);
            const time = ws.tick(1);
            ws.git(clone, ["add", "-A"], { time });
            ws.git(clone, ["commit", "-q", "-m", message], { person, time });
            const sha = ws.git(clone, ["rev-parse", "HEAD"]);
            ws.git(clone, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
            removeDir(clone);
            return sha;
          },
        }
      : {}),
  };
}

/** Removes cache folders of older versions of this file. */
function pruneCache() {
  try {
    for (const entry of fs.readdirSync(CACHE_ROOT)) {
      if (!entry.startsWith(`${cacheKey()}-`)) removeDir(path.join(CACHE_ROOT, entry));
    }
  } catch {
    // Cleanup is not important enough to fail over.
  }
}

/** Workspace of a fixture: own temp folder, own gitconfig, running clock. */
function workspace(prefix) {
  // realpath: on Windows os.tmpdir() is often an 8.3 short path that Git writes differently from the app.
  if (!swept) {
    swept = true;
    sweepStaleTemp("gc-fix-");
  }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `gc-fix-${prefix}-`)));
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  live.add(root);
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(config, globalGitConfig());
  const env = { ...process.env, ...gitIsolationEnv(config) };
  let clock = EPOCH;

  const ws = {
    root,
    /** Next timestamp; `minutes` after the previous one. */
    tick(minutes = 37) {
      clock += minutes * 60;
      return clock;
    },
    /** Runs git in `cwd`; returns stdout without the trailing newline. Errors throw with Git's output. */
    git(cwd, args, { input, person = TEST_IDENTITY, time } = {}) {
      const when = `${time ?? clock} ${ZONE}`;
      try {
        return execFileSync("git", args, {
          cwd,
          input,
          env: {
            ...env,
            GIT_AUTHOR_NAME: person.name,
            GIT_AUTHOR_EMAIL: person.email,
            GIT_AUTHOR_DATE: when,
            GIT_COMMITTER_NAME: person.name,
            GIT_COMMITTER_EMAIL: person.email,
            GIT_COMMITTER_DATE: when,
          },
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 256 * 1024 * 1024,
          windowsHide: true,
        })
          .toString("utf8")
          .replace(/\r?\n$/, "");
      } catch (error) {
        const detail = [error.stdout, error.stderr].map((part) => (part ? part.toString("utf8") : "")).join("\n").trim();
        throw new Error(`git ${args.join(" ")} failed (in ${cwd}):\n${detail || error.message}`);
      }
    },
    /** New repository `name` with branch main and a local identity. */
    init(name, { bare = false, identity = true } = {}) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      ws.git(dir, bare ? ["init", "--bare", "-b", "main"] : ["init", "-b", "main"]);
      if (!bare && identity) {
        ws.git(dir, ["config", "user.name", TEST_IDENTITY.name]);
        ws.git(dir, ["config", "user.email", TEST_IDENTITY.email]);
      }
      return dir;
    },
    cleanup() {
      removeDir(root);
      live.delete(root);
    },
  };
  return ws;
}

function write(repo, rel, content) {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Small, valid PNG (RGB) with a gradient; `seed` changes the colors. */
export function makePng(width, height, seed = 0) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buffer) => {
    let c = -1;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      // Sky at the top, meadow at the bottom, a "mast" in the middle – visibly different per seed.
      const sky = y < height * 0.62;
      const mast = Math.abs(x - width / 2) < 2 && y > height * 0.25 && y < height * 0.8;
      const base = mast ? [70, 70, 80] : sky ? [90 + seed * 40, 150 + Math.round((y / height) * 60), 230 - seed * 50] : [70 + seed * 60, 150 - seed * 30, 80];
      raw.set(base.map((value) => Math.max(0, Math.min(255, value + ((x * 7 + y * 3) % 9)))), row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Fixed "random" bytes (with NUL) so Git detects the file as binary. */
function binaryBlob(length, seed) {
  const out = Buffer.alloc(length);
  let state = (seed * 2654435761) >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = index % 64 === 0 ? 0 : state >>> 24;
  }
  return out;
}

function csv(days, offset = 0) {
  const lines = ["datum;temperatur_c;luftfeuchte_prozent;regen_mm;wind_kmh"];
  for (let day = 1; day <= days; day++) {
    const temp = (2.5 + Math.sin((day + offset) / 4) * 4 + offset).toFixed(1).replace(".", ",");
    const humidity = 62 + ((day * 7 + offset * 3) % 30);
    const rain = ((day * 13 + offset) % 7 === 0 ? 4.2 + (day % 5) : 0).toFixed(1).replace(".", ",");
    const wind = 6 + ((day * 5 + offset) % 23);
    lines.push(`2026-01-${String(day).padStart(2, "0")};${temp};${humidity};${rain};${wind}`);
  }
  return `${lines.join("\n")}\n`;
}

/** File name with exactly 60 characters (for overflow tests in file lists). */
export const LONG_FILE_NAME = "messwerte-station-nord-januar-bis-maerz-2026-bereinigt-2.csv";
/** File name with an umlaut and spaces. */
export const UMLAUT_FILE_NAME = "Größen und Einheiten.md";
/** Changed in three places in the rich repository (three hunks, unstaged). */
export const MULTI_HUNK_FILE = "daten/messwerte-2026-01.csv";

/** Commit message with a very long summary (over 150 characters) and a multi-line description. */
const LONG_MESSAGE = `Plausibilitätsprüfung für alle Sensoren eingeführt, damit Ausreißer des Datenloggers bei Frost nicht länger unbemerkt in die Tagesmittel und Monatsberichte gelangen

Der Logger liefert bei Temperaturen unter -15 °C gelegentlich Werte weit außerhalb
des Messbereichs. Bisher landeten sie ungeprüft im Tagesmittel.

- Die Grenzen je Sensor stehen in src/sensoren.py.
- Werte außerhalb der Grenzen werden übersprungen und gezählt.
- Die Zahl der übersprungenen Werte steht am Ende der Ausgabe.

Siehe auch den Eintrag im Stationsbuch vom 14. Januar.`;

const FILES = {
  readme: `# Wetterstation-Auswertung

Kleine Sammlung von Skripten, die die Messwerte unserer Wetterstation auf dem Schuldach auswerten.

## Was die Skripte tun

- Messwerte aus den CSV-Dateien unter \`daten/\` einlesen
- Tagesmittel für Temperatur und Luftfeuchte berechnen
- Regenmengen je Woche zusammenzählen

## Aufruf

\`\`\`
python src/auswertung.py daten/messwerte-2026-01.csv
\`\`\`
`,
  sensoren: `"""Beschreibung der Sensoren der Wetterstation."""

SENSOREN = {
    "temperatur": {"einheit": "°C", "minimum": -40.0, "maximum": 60.0},
    "luftfeuchte": {"einheit": "%", "minimum": 0.0, "maximum": 100.0},
    "regen": {"einheit": "mm", "minimum": 0.0, "maximum": 300.0},
}


def ist_plausibel(sensor, wert):
    """Prüft, ob ein Messwert im Bereich des Sensors liegt."""
    grenzen = SENSOREN[sensor]
    return grenzen["minimum"] <= wert <= grenzen["maximum"]
`,
  auswertung: `"""Wertet die Messwerte der Wetterstation aus."""

import csv
import sys


def lies_messwerte(pfad):
    """Liest eine CSV-Datei mit Messwerten und liefert eine Liste von Zeilen."""
    with open(pfad, encoding="utf-8", newline="") as datei:
        return list(csv.DictReader(datei, delimiter=";"))


def zahl(text):
    """Wandelt „3,5“ in 3.5 um."""
    return float(text.replace(",", "."))


def hauptprogramm(pfad):
    zeilen = lies_messwerte(pfad)
    print(f"{len(zeilen)} Messtage gelesen")


if __name__ == "__main__":
    hauptprogramm(sys.argv[1])
`,
  aufbau: `# Aufbau der Station

Die Station steht auf dem Flachdach des Hauptgebäudes, etwa zwölf Meter über dem Hof.

| Sensor | Höhe über Dach | Messintervall |
| --- | --- | --- |
| Temperatur | 2,0 m | 10 Minuten |
| Luftfeuchte | 2,0 m | 10 Minuten |
| Regenmesser | 1,0 m | bei Ereignis |

Der Datenlogger schreibt jede Nacht eine CSV-Datei auf die Speicherkarte.
`,
  einheiten: `# Größen und Einheiten

| Größe | Einheit | Bemerkung |
| --- | --- | --- |
| Temperatur | °C | auf eine Nachkommastelle gerundet |
| Luftfeuchte | % | relative Feuchte |
| Regenmenge | mm | entspricht Litern je Quadratmeter |
`,
  pruefung: `"""Sortiert unplausible Messwerte aus."""

from sensoren import ist_plausibel


def pruefe(sensor, werte):
    """Liefert die plausiblen Werte und die Zahl der übersprungenen."""
    gute = [wert for wert in werte if ist_plausibel(sensor, wert)]
    return gute, len(werte) - len(gute)
`,
  testPruefung: `from pruefung import pruefe


def test_wert_im_bereich():
    assert pruefe("temperatur", [3.5]) == ([3.5], 0)


def test_wert_ueber_dem_bereich():
    assert pruefe("temperatur", [75.0]) == ([], 1)


def test_ausfallwert():
    assert pruefe("regen", [-999.0, 1.2]) == ([1.2], 1)
`,
  konzept: `# Altes Konzept (überholt)

Ursprünglich sollte die Auswertung in einer Tabellenkalkulation laufen.
Das war bei mehr als einem Monat Daten zu langsam.
`,
};

function addTagesmittel(text) {
  return text.replace(
    "def hauptprogramm(pfad):\n    zeilen = lies_messwerte(pfad)\n    print(f\"{len(zeilen)} Messtage gelesen\")",
    `def tagesmittel(zeilen, spalte):
    """Mittelwert einer Spalte über alle Zeilen."""
    werte = [zahl(zeile[spalte]) for zeile in zeilen]
    return sum(werte) / len(werte) if werte else 0.0


def hauptprogramm(pfad):
    zeilen = lies_messwerte(pfad)
    print(f"{len(zeilen)} Messtage gelesen")
    print(f"Mittlere Temperatur: {tagesmittel(zeilen, 'temperatur_c'):.1f} °C")`,
  );
}

function addRegen(text) {
  return text.replace(
    "def hauptprogramm(pfad):",
    `def regensumme(zeilen):
    """Gesamte Regenmenge in Millimetern."""
    return sum(zahl(zeile["regen_mm"]) for zeile in zeilen)


def hauptprogramm(pfad):`,
  );
}

/**
 * Rich repository "wetterstation":
 * - Branches: main (checked out, 2 ahead / 1 behind origin/main), feature/wind-diagramm (pushed),
 *   feature/luftdruck (local only), bugfix/sensor-ausfall (merged), experiment/alte-auswertung (old)
 * - Remote "origin" (bare, in the same temp folder) with origin/main, origin/feature/wind-diagramm,
 *   origin/feature/temperatur-karte (remote only)
 * - two merge commits, tags: v0.1.0 and v0.2.0 annotated, messreihe-januar lightweight
 * - two stashes
 * - uncommitted changes: modified, new, deleted, renamed – staged and unstaged mixed,
 *   binary file, PNG, long file name, file name with umlaut and spaces
 *
 * `dirty: false` leaves out the uncommitted changes and stashes.
 */
export function makeRichRepo({ dirty = true, name = "wetterstation" } = {}) {
  return cached("rich", `${name}-${dirty ? "dirty" : "clean"}`, name, () => buildRichRepo({ dirty, name }), { remote: true });
}

function buildRichRepo({ dirty, name }) {
  const ws = workspace("rich");
  const repo = ws.init(name);
  const remote = ws.init("origin.git", { bare: true });
  const git = (args, options) => ws.git(repo, args, options);
  const commit = (message, { person = TEST_IDENTITY, minutes = 37, all = true } = {}) => {
    const time = ws.tick(minutes);
    if (all) git(["add", "-A"], { time });
    git(["commit", "-q", "-m", message], { person, time });
    return git(["rev-parse", "HEAD"]);
  };
  const shas = {};

  // --- Skeleton on main ------------------------------------------------------------------------
  write(repo, "README.md", FILES.readme);
  write(repo, ".gitignore", "__pycache__/\n*.pyc\nausgabe/\n");
  write(repo, "src/sensoren.py", FILES.sensoren);
  shas.first = commit("Projektgerüst für die Wetterstation-Auswertung");

  write(repo, "src/auswertung.py", FILES.auswertung);
  write(repo, "daten/messwerte-2026-01.csv", csv(31));
  write(repo, "daten/testlauf.csv", csv(3, 2));
  shas.csv = commit("Messwerte aus CSV-Dateien einlesen\n\nDer Datenlogger schreibt Dezimalzahlen mit Komma; `zahl()` wandelt sie um.");
  git(["tag", "messreihe-januar"]);

  write(repo, "docs/aufbau.md", FILES.aufbau);
  write(repo, "docs/alt-konzept.md", FILES.konzept);
  write(repo, `docs/${UMLAUT_FILE_NAME}`, FILES.einheiten);
  write(repo, "docs/station.png", makePng(96, 64, 0));
  commit("Aufbau der Station und Einheiten beschrieben", { person: AYLIN });

  // Old side branch that never came back
  git(["checkout", "-q", "-b", "experiment/alte-auswertung"]);
  write(repo, "tabelle/auswertung.txt", "Auswertung per Tabellenkalkulation – Entwurf\n");
  commit("Entwurf: Auswertung in der Tabellenkalkulation", { person: JONAS });
  git(["checkout", "-q", "main"]);

  write(repo, "src/auswertung.py", addTagesmittel(FILES.auswertung));
  commit("Tagesmittel der Temperatur berechnen");

  // --- feature/regen-auswertung, merged back with a merge commit -----------------------------
  git(["checkout", "-q", "-b", "feature/regen-auswertung"]);
  write(repo, "src/auswertung.py", addRegen(addTagesmittel(FILES.auswertung)));
  commit("Regenmengen zusammenzählen", { person: JONAS });
  write(repo, "src/auswertung.py", addRegen(addTagesmittel(FILES.auswertung)).replace('°C")', '°C")\n    print(f"Regen gesamt: {regensumme(zeilen):.1f} mm")'));
  commit("Regensumme in der Ausgabe zeigen", { person: JONAS });
  git(["checkout", "-q", "main"]);
  write(repo, "daten/kalibrierung.bin", binaryBlob(2048, 1));
  write(repo, `daten/${LONG_FILE_NAME}`, csv(28, 1));
  commit("Kalibrierdaten und bereinigte Messreihe der Station Nord abgelegt", { person: AYLIN });
  git(["merge", "-q", "--no-ff", "-m", "Merge branch 'feature/regen-auswertung'", "feature/regen-auswertung"], { time: ws.tick() });
  shas.firstMerge = git(["rev-parse", "HEAD"]);
  git(["branch", "-q", "-d", "feature/regen-auswertung"]);
  git(["tag", "-a", "v0.1.0", "-m", "Erste nutzbare Fassung\n\nLiest Messwerte, berechnet Tagesmittel und Regensummen."], { time: ws.tick(5) });

  // --- bugfix/sensor-ausfall, merged, branch stays ------------------------------------------
  git(["checkout", "-q", "-b", "bugfix/sensor-ausfall"]);
  write(repo, "src/sensoren.py", `${FILES.sensoren}\n\ndef ist_ausfall(wert):\n    """Der Logger schreibt -999, wenn ein Sensor nichts liefert."""\n    return wert <= -999\n`);
  commit("Ausfallwert -999 des Loggers erkennen");
  git(["checkout", "-q", "main"]);
  write(repo, "README.md", `${FILES.readme}\n## Daten\n\nDie Rohdaten liegen unter \`daten/\`, eine Datei je Monat.\n`);
  commit("README: Abschnitt zu den Daten");
  git(["merge", "-q", "--no-ff", "-m", "Merge branch 'bugfix/sensor-ausfall'", "bugfix/sensor-ausfall"], { time: ws.tick() });
  shas.secondMerge = git(["rev-parse", "HEAD"]);

  // --- very long summary with multi-line description, then a commit with co-authors ---------
  write(repo, "src/pruefung.py", FILES.pruefung);
  shas.longSummary = commit(LONG_MESSAGE, { person: AYLIN });
  write(repo, "tests/test_pruefung.py", FILES.testPruefung);
  shas.coAuthored = commit(`Tests für die Plausibilitätsprüfung\n\nDrei Fälle: Wert im Bereich, Wert darüber, Ausfallwert des Loggers.\n\nCo-authored-by: ${JONAS.name} <${JONAS.email}>\nCo-authored-by: ${GRETA.name} <${GRETA.email}>`, { person: MATS });

  // --- set up origin --------------------------------------------------------------------------
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "-u", "origin", "main"]);
  git(["push", "-q", "origin", "v0.1.0"]);

  // --- feature/wind-diagramm: pushed, still open ----------------------------------------------
  git(["checkout", "-q", "-b", "feature/wind-diagramm"]);
  write(repo, "src/diagramm.py", '"""Zeichnet die Windgeschwindigkeit als Textdiagramm."""\n\n\ndef balken(wert, breite=40, maximum=60):\n    laenge = round(wert / maximum * breite)\n    return "#" * laenge\n');
  commit("Textdiagramm für die Windgeschwindigkeit", { person: JONAS });
  write(repo, "src/diagramm.py", '"""Zeichnet die Windgeschwindigkeit als Textdiagramm."""\n\n\ndef balken(wert, breite=40, maximum=60):\n    laenge = round(min(wert, maximum) / maximum * breite)\n    return "#" * laenge\n\n\ndef zeile(datum, wert):\n    return f"{datum} {balken(wert)} {wert} km/h"\n');
  commit("Böen über dem Maximum abschneiden", { person: JONAS });
  git(["push", "-q", "-u", "origin", "feature/wind-diagramm"]);

  // --- remote only: feature/temperatur-karte ---------------------------------------------------
  git(["checkout", "-q", "-b", "feature/temperatur-karte", "main"]);
  write(repo, "docs/karte.md", "# Temperaturkarte\n\nIdee: Tagesmittel als farbige Kacheln je Kalendertag.\n");
  commit("Idee für eine Temperaturkarte notiert", { person: AYLIN });
  git(["push", "-q", "origin", "feature/temperatur-karte"]);
  git(["checkout", "-q", "main"]);
  git(["branch", "-q", "-D", "feature/temperatur-karte"]);

  // --- the remote gets a commit that local main lacks (1 behind) ------------------------------
  const other = path.join(ws.root, "kollege");
  ws.git(ws.root, ["clone", "-q", remote, other]);
  write(other, "docs/aufbau.md", `${FILES.aufbau}\nSeit Februar hängt zusätzlich ein Windmesser am Mast.\n`);
  const time = ws.tick();
  ws.git(other, ["add", "-A"], { time });
  ws.git(other, ["commit", "-q", "-m", "Aufbau: Windmesser ergänzt"], { person: JONAS, time });
  ws.git(other, ["push", "-q", "origin", "main"]);
  fs.rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  // --- locally two commits further (2 ahead) -------------------------------------------------
  write(repo, "src/sensoren.py", fs.readFileSync(path.join(repo, "src/sensoren.py"), "utf8").replace('"regen": {', '"wind": {"einheit": "km/h", "minimum": 0.0, "maximum": 200.0},\n    "regen": {'));
  commit("Windsensor in die Sensorliste aufgenommen");
  git(["tag", "-a", "v0.2.0", "-m", "Windsensor und Ausfallerkennung"], { time: ws.tick(3) });
  write(repo, "daten/messwerte-2026-02.csv", csv(28, 3).replaceAll("2026-01-", "2026-02-"));
  shas.head = commit("Messwerte für Februar ergänzt", { person: TEST_IDENTITY });
  git(["fetch", "-q", "origin"]);

  // --- local only: feature/luftdruck ----------------------------------------------------------
  git(["branch", "-q", "feature/luftdruck", shas.secondMerge]);

  if (dirty) {
    // --- two stashes --------------------------------------------------------------------------
    write(repo, "src/sensoren.py", fs.readFileSync(path.join(repo, "src/sensoren.py"), "utf8").replace('"maximum": 60.0', '"maximum": 55.0'));
    git(["stash", "push", "-q", "-m", "Kalibrierung: engere Grenzen ausprobieren"], { time: ws.tick(11) });
    write(repo, "README.md", `${fs.readFileSync(path.join(repo, "README.md"), "utf8")}\n## Offene Punkte\n\n- Diagramm als Bild ausgeben\n`);
    write(repo, "notizen/ideen.txt", "Regenradar einbinden?\n");
    git(["stash", "push", "-q", "--include-untracked", "-m", "Ideen für das README"], { time: ws.tick(11) });

    // --- uncommitted changes ------------------------------------------------------------------
    // staged: modified, new, deleted, renamed
    write(repo, "README.md", fs.readFileSync(path.join(repo, "README.md"), "utf8").replace("Kleine Sammlung von Skripten", "Sammlung von Skripten"));
    write(repo, "src/export.py", '"""Schreibt die Auswertung als Textdatei."""\n\n\ndef schreibe(pfad, zeilen):\n    with open(pfad, "w", encoding="utf-8") as datei:\n        datei.write("\\n".join(zeilen))\n');
    git(["add", "README.md", "src/export.py"]);
    git(["rm", "-q", "daten/testlauf.csv"]);
    git(["mv", "docs/aufbau.md", "docs/stationsaufbau.md"]);
    // the same file staged AND changed further afterwards
    const sensoren = fs.readFileSync(path.join(repo, "src/sensoren.py"), "utf8");
    write(repo, "src/sensoren.py", sensoren.replace('"""Beschreibung der Sensoren der Wetterstation."""', '"""Beschreibung der Sensoren der Wetterstation auf dem Schuldach."""'));
    git(["add", "src/sensoren.py"]);
    write(repo, "src/sensoren.py", `${fs.readFileSync(path.join(repo, "src/sensoren.py"), "utf8")}\n\ndef einheit(sensor):\n    return SENSOREN[sensor]["einheit"]\n`);
    // unstaged: modified, deleted, new, binary, image, long name, umlaut
    write(repo, "src/auswertung.py", fs.readFileSync(path.join(repo, "src/auswertung.py"), "utf8").replace('print(f"{len(zeilen)} Messtage gelesen")', 'print(f"{len(zeilen)} Messtage aus {pfad} gelesen")'));
    fs.rmSync(path.join(repo, "docs/alt-konzept.md"));
    write(repo, "notizen/offene-fragen.md", "# Offene Fragen\n\n- Wie gehen wir mit Sommerzeit im Logger um?\n- Reicht eine Nachkommastelle beim Regen?\n");
    write(repo, "daten/kalibrierung.bin", binaryBlob(3072, 2));
    write(repo, "daten/rohdaten-logger.bin", binaryBlob(1024, 3));
    write(repo, "docs/station.png", makePng(96, 64, 1));
    write(repo, "docs/standort.png", makePng(120, 80, 2));
    const reihe = csv(28, 1).split("\n");
    reihe[10] = reihe[10].replace(/;\d+$/, ";0");
    write(repo, `daten/${LONG_FILE_NAME}`, `${reihe.join("\n")}2026-01-29;1,5;71;0,0;9\n`);
    // one file with three changes far apart (three hunks)
    const januar = csv(31).split("\n");
    januar[3] = januar[3].replace(/;\d+$/, ";41");
    januar[16] = "2026-01-16;-999;-999;0,0;0";
    januar.splice(29, 0, "2026-01-28;3,9;74;0,0;12");
    write(repo, MULTI_HUNK_FILE, januar.join("\n"));
    write(repo, `docs/${UMLAUT_FILE_NAME}`, `${FILES.einheiten}| Wind | km/h | Mittel über zehn Minuten |\n`);
    write(repo, "notizen/Übersicht März.txt", "Im März fehlen die Tage 12 bis 14 (Stromausfall).\n");
  }

  return {
    root: ws.root,
    ws,
    info: {
      head: shas.head,
      /** first, csv, firstMerge, secondMerge, longSummary (very long summary, multi-line description), coAuthored (Co-authored-by), head */
      shas,
      branch: "main",
      ahead: 2,
      behind: 1,
      localBranches: ["bugfix/sensor-ausfall", "experiment/alte-auswertung", "feature/luftdruck", "feature/wind-diagramm", "main"],
      remoteBranches: ["origin/feature/temperatur-karte", "origin/feature/wind-diagramm", "origin/main"],
      remoteOnlyBranch: "origin/feature/temperatur-karte",
      tags: ["messreihe-januar", "v0.1.0", "v0.2.0"],
      annotatedTags: ["v0.1.0", "v0.2.0"],
      stashes: dirty ? ["Ideen für das README", "Kalibrierung: engere Grenzen ausprobieren"] : [],
      authors: [TEST_IDENTITY, JONAS, AYLIN, MATS].map((person) => person.name),
      longFile: `daten/${LONG_FILE_NAME}`,
      umlautFile: `docs/${UMLAUT_FILE_NAME}`,
      multiHunkFile: MULTI_HUNK_FILE,
      binaryFile: "daten/kalibrierung.bin",
      imageFile: "docs/station.png",
      /** Expected status with `dirty: true` (paths as in `status_get`, sorted by path). */
      changes: dirty
        ? {
            staged: ["README.md", "daten/testlauf.csv", "docs/stationsaufbau.md", "src/export.py", "src/sensoren.py"],
            unstaged: [
              "daten/kalibrierung.bin",
              MULTI_HUNK_FILE,
              `daten/${LONG_FILE_NAME}`,
              "daten/rohdaten-logger.bin",
              `docs/${UMLAUT_FILE_NAME}`,
              "docs/alt-konzept.md",
              "docs/standort.png",
              "docs/station.png",
              "notizen/offene-fragen.md",
              "notizen/Übersicht März.txt",
              "src/auswertung.py",
              "src/sensoren.py",
            ],
          }
        : { staged: [], unstaged: [] },
    },
    cleanup: ws.cleanup,
  };
}

/**
 * Clean repository "messnetz" with a bare "origin": main and `feature/export` are pushed and
 * have an upstream, nothing is ahead or behind, the working directory is clean.
 * Meant for fetch, pull and push:
 *
 *   const repo = makeCleanRepoWithRemote();
 *   const sha = repo.commitOnRemote({ message: "Kalibrierung nachgetragen" });   // remote is now 1 ahead
 *   repo.write("NOTIZ.md", "…"); repo.git("add", "-A"); repo.git("commit", "-m", "Lokaler Commit");   // local 1 ahead
 */
export function makeCleanRepoWithRemote({ name = "messnetz" } = {}) {
  return cached("remote", name, name, () => buildCleanRepoWithRemote({ name }), { remote: true });
}

function buildCleanRepoWithRemote({ name }) {
  const ws = workspace("remote");
  const repo = ws.init(name);
  const remote = ws.init("origin.git", { bare: true });
  const git = (args, options) => ws.git(repo, args, options);
  const commit = (message, person = TEST_IDENTITY) => {
    const time = ws.tick();
    git(["add", "-A"], { time });
    git(["commit", "-q", "-m", message], { person, time });
    return git(["rev-parse", "HEAD"]);
  };
  write(repo, "README.md", "# Messnetz\n\nGemeinsame Auswertung der drei Schulstationen Nord, Süd und Hafen.\n");
  write(repo, ".gitignore", "ausgabe/\n");
  commit("Projekt für das Messnetz angelegt");
  write(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen;3\n");
  commit("Liste der Stationen", AYLIN);
  write(repo, "src/vergleich.py", '"""Vergleicht die Tagesmittel der Stationen."""\n\n\ndef differenz(a, b):\n    return round(a - b, 1)\n');
  const mainHead = commit("Vergleich der Tagesmittel zweier Stationen");
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "-u", "origin", "main"]);
  git(["checkout", "-q", "-b", "feature/export"]);
  write(repo, "src/export.py", '"""Schreibt den Vergleich als CSV."""\n\n\ndef zeile(station, wert):\n    return f"{station};{wert}"\n');
  const featureHead = commit("CSV-Export für den Vergleich", JONAS);
  git(["push", "-q", "-u", "origin", "feature/export"]);
  git(["checkout", "-q", "main"]);
  git(["fetch", "-q", "origin"]);
  return {
    root: ws.root,
    ws,
    info: { branch: "main", head: mainHead, featureHead, localBranches: ["feature/export", "main"], remoteBranches: ["origin/feature/export", "origin/main"] },
    cleanup: ws.cleanup,
  };
}

/** Fresh repository without a commit (branch main "unborn"), with one untracked file. */
export function makeEmptyRepo({ name = "leeres-projekt", withFile = true } = {}) {
  return cached("empty", `${name}-${withFile}`, name, () => buildEmptyRepo({ name, withFile }));
}

function buildEmptyRepo({ name, withFile }) {
  const ws = workspace("empty");
  const repo = ws.init(name);
  if (withFile) write(repo, "LIESMICH.txt", "Hier entsteht die Auswertung für die zweite Station.\n");
  return { root: ws.root, ws, info: { branch: "main", untracked: withFile ? ["LIESMICH.txt"] : [] }, cleanup: ws.cleanup };
}

/**
 * Open merge with conflicts in two text files (`src/auswertung.py`, `docs/aufbau.md`);
 * `README.md` merged cleanly and is staged. main is checked out, `feature/einheiten`
 * is being merged in.
 */
export function makeConflictRepo({ name = "konflikt-demo" } = {}) {
  return cached("conflict", name, name, () => buildConflictRepo({ name }));
}

function buildConflictRepo({ name }) {
  const ws = workspace("conflict");
  const repo = ws.init(name);
  const git = (args, options) => ws.git(repo, args, options);
  const commit = (message, person = TEST_IDENTITY) => {
    const time = ws.tick();
    git(["add", "-A"], { time });
    git(["commit", "-q", "-m", message], { person, time });
  };
  write(repo, "README.md", FILES.readme);
  write(repo, "src/auswertung.py", addTagesmittel(FILES.auswertung));
  write(repo, "docs/aufbau.md", FILES.aufbau);
  commit("Ausgangsstand der Auswertung");

  git(["checkout", "-q", "-b", "feature/einheiten"]);
  write(repo, "src/auswertung.py", addTagesmittel(FILES.auswertung).replace("Mittlere Temperatur: {tagesmittel(zeilen, 'temperatur_c'):.1f} °C", "Temperatur im Mittel: {tagesmittel(zeilen, 'temperatur_c'):.2f} Grad Celsius"));
  write(repo, "docs/aufbau.md", FILES.aufbau.replace("| Temperatur | 2,0 m | 10 Minuten |", "| Temperatur | 2,0 m | 5 Minuten |"));
  write(repo, "README.md", FILES.readme.replace("## Aufruf", "## Einheiten\n\nAlle Temperaturen in Grad Celsius.\n\n## Aufruf"));
  commit("Einheiten ausschreiben, Messintervall auf 5 Minuten", JONAS);

  git(["checkout", "-q", "main"]);
  write(repo, "src/auswertung.py", addTagesmittel(FILES.auswertung).replace("Mittlere Temperatur: {tagesmittel(zeilen, 'temperatur_c'):.1f} °C", "Durchschnittstemperatur: {tagesmittel(zeilen, 'temperatur_c'):.1f} °C"));
  write(repo, "docs/aufbau.md", FILES.aufbau.replace("| Temperatur | 2,0 m | 10 Minuten |", "| Temperatur | 2,5 m | 10 Minuten |"));
  commit("Ausgabe umformuliert, Sensorhöhe korrigiert");

  let conflicted = false;
  try {
    git(["merge", "--no-ff", "feature/einheiten"], { time: ws.tick() });
  } catch {
    conflicted = true;
  }
  if (!conflicted) throw new Error("makeConflictRepo: the merge should have produced a conflict.");
  return {
    root: ws.root,
    ws,
    info: { conflicted: ["docs/aufbau.md", "src/auswertung.py"], staged: ["README.md"], source: "feature/einheiten", target: "main" },
    cleanup: ws.cleanup,
  };
}

/** Detached HEAD: the second-to-last commit of main is checked out (also tag v0.1.0). */
export function makeDetachedRepo({ name = "detached-demo" } = {}) {
  return cached("detached", name, name, () => buildDetachedRepo({ name }));
}

function buildDetachedRepo({ name }) {
  const ws = workspace("detached");
  const repo = ws.init(name);
  const git = (args, options) => ws.git(repo, args, options);
  const commit = (message) => {
    const time = ws.tick();
    git(["add", "-A"], { time });
    git(["commit", "-q", "-m", message], { time });
    return git(["rev-parse", "HEAD"]);
  };
  write(repo, "README.md", FILES.readme);
  commit("Projektgerüst für die Wetterstation-Auswertung");
  write(repo, "src/auswertung.py", FILES.auswertung);
  const detachedAt = commit("Messwerte aus CSV-Dateien einlesen");
  git(["tag", "v0.1.0"]);
  write(repo, "src/auswertung.py", addTagesmittel(FILES.auswertung));
  commit("Tagesmittel der Temperatur berechnen");
  git(["checkout", "-q", "--detach", detachedAt]);
  return { root: ws.root, ws, info: { sha: detachedAt, tag: "v0.1.0" }, cleanup: ws.cleanup };
}

const VERBS = ["Auswertung", "Einlesen", "Diagramm", "Kalibrierung", "Export", "Plausibilitätsprüfung", "Regensumme", "Tagesmittel", "Windmessung", "Protokoll"];
const CHANGES = ["beschleunigt", "aufgeräumt", "korrigiert", "erweitert", "vereinfacht", "dokumentiert", "robuster gemacht", "an neue Logger-Fassung angepasst", "mit Tests abgesichert", "umbenannt"];
const DETAILS = ["für Station Nord", "für Station Süd", "bei fehlenden Werten", "im Winterhalbjahr", "für Monatsberichte", "bei Sommerzeit", "für große Dateien", "nach Rückmeldung aus dem Kollegium"];

/**
 * Large repository for performance tests: `n` commits (default 50,000) via `git fast-import`.
 * Every 400 commits a side branch with 12 commits forks off main and comes back with a merge
 * commit; at the end there are four open branches and a few tags. Takes a few seconds.
 */
export function makeLargeRepo(n = 50000, { name = "grosses-archiv" } = {}) {
  return cached("large", `${name}-${n}`, name, () => buildLargeRepo(n, { name }));
}

function buildLargeRepo(n, { name }) {
  const ws = workspace("large");
  const repo = ws.init(name);
  const parts = [];
  let mark = 0;
  let time = EPOCH - n * 600;
  let produced = 0;
  const message = (index) => `${VERBS[index % VERBS.length]} ${CHANGES[(index * 7) % CHANGES.length]} ${DETAILS[(index * 3) % DETAILS.length]} (#${index + 1})`;

  const emit = (ref, { from, merge, file }) => {
    mark += 1;
    time += 600;
    const person = PEOPLE[(mark * 5) % PEOPLE.length];
    const text = merge ? `Merge branch '${merge.name}'` : message(produced);
    const body = `Messreihe ${mark}\nwert;${(mark * 37) % 1000}\n`;
    parts.push(
      `commit ${ref}\nmark :${mark}\n` +
        `author ${person.name} <${person.email}> ${time} ${ZONE}\n` +
        `committer ${person.name} <${person.email}> ${time} ${ZONE}\n` +
        `data ${Buffer.byteLength(text)}\n${text}\n` +
        (from ? `from :${from}\n` : "") +
        (merge ? `merge :${merge.mark}\n` : "") +
        `M 100644 inline ${file}\ndata ${Buffer.byteLength(body)}\n${body}\n`,
    );
    produced += 1;
    return mark;
  };

  let main = 0;
  let side = 0;
  const tags = [];
  while (produced < n) {
    main = emit("refs/heads/main", { from: main || undefined, file: `daten/reihe-${String(produced % 40).padStart(2, "0")}.csv` });
    if (produced % 5000 === 1 && produced > 1) tags.push([`archiv-${String(tags.length + 1).padStart(2, "0")}`, main]);
    if (produced % 400 === 200 && produced + 17 <= n) {
      side += 1;
      const branch = `refs/heads/thema/zweig-${String(side).padStart(3, "0")}`;
      let tip = main;
      for (let step = 0; step < 12; step++) {
        tip = emit(branch, { from: tip, file: `themen/zweig-${side % 8}.txt` });
        // main keeps going meanwhile so the lanes run side by side
        if (step % 4 === 3) main = emit("refs/heads/main", { from: main, file: `daten/reihe-${String(produced % 40).padStart(2, "0")}.csv` });
      }
      const merged = { name: `thema/zweig-${String(side).padStart(3, "0")}`, mark: tip };
      main = emit("refs/heads/main", { from: main, merge: merged, file: "README.md" });
    }
  }
  for (const [tag, at] of tags) parts.push(`reset refs/tags/${tag}\nfrom :${at}\n\n`);
  ws.git(repo, ["fast-import", "--quiet", "--date-format=raw"], { input: Buffer.from(parts.join(""), "utf8") });

  // Delete all but the last four side branches (they are merged), otherwise the repo has 100+ branches.
  const branches = ws.git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/thema"]).split(/\r?\n/).filter(Boolean);
  const drop = branches.slice(0, Math.max(0, branches.length - 4));
  if (drop.length) ws.git(repo, ["update-ref", "--stdin"], { input: drop.map((branch) => `delete refs/heads/${branch}\n`).join("") });
  ws.git(repo, ["checkout", "-q", "-f", "main"]);
  const count = Number(ws.git(repo, ["rev-list", "--count", "--all"]));
  return {
    root: ws.root,
    ws,
    info: { commits: count, branches: ["main", ...branches.slice(-4)], tags: tags.map(([tag]) => tag) },
    cleanup: ws.cleanup,
  };
}

/** Ordinary folder without a repository (for the error case when opening). */
export function makeNotARepo({ name = "kein-repository" } = {}) {
  const ws = workspace("plain");
  const dir = path.join(ws.root, name);
  fs.mkdirSync(dir, { recursive: true });
  write(dir, "einkaufsliste.txt", "Batterien für den Regenmesser\nKabelbinder\n");
  write(dir, "bilder/dach.png", makePng(64, 48, 1));
  return { path: dir, root: ws.root, info: null, cleanup: ws.cleanup };
}

/** For CLI tools: fixture by name. */
export const fixtures = {
  rich: makeRichRepo,
  clean: () => makeRichRepo({ dirty: false }),
  remote: makeCleanRepoWithRemote,
  empty: makeEmptyRepo,
  conflict: makeConflictRepo,
  detached: makeDetachedRepo,
  large: () => makeLargeRepo(),
  notarepo: makeNotARepo,
};

// Called directly: `node scripts/e2e/fixtures.mjs rich [--keep]` creates the fixture and shows
// what is in it. With --keep the folder stays (for a look); otherwise it is cleaned up.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const name = process.argv[2] ?? "rich";
  const make = fixtures[name];
  if (!make) {
    console.error(`Unknown fixture "${name}". Available: ${Object.keys(fixtures).join(", ")}`);
    process.exit(2);
  }
  const started = Date.now();
  const made = make();
  console.log(`${name}: ${made.path} (${Date.now() - started} ms)`);
  if (made.info) console.log(JSON.stringify(made.info, null, 2));
  if (made.git) {
    console.log(made.git("status", "--short", "--branch"));
    console.log(made.git("log", "--oneline", "--graph", "--all", "-n", "25"));
    if (name !== "empty") console.log(made.git("stash", "list"));
  }
  if (process.argv.includes("--keep")) live.clear();
  else made.cleanup();
}
