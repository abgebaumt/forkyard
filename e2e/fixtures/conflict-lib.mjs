/**
 * Fixtures for conflict (conflict tool): a "lab" repository with an open merge that contains every
 * kind of conflict once, and a small repository with a rebase conflict.
 *
 * The text files are built from parts (`same`, `ours`, `theirs`, `conflict`). They produce the
 * three versions – and `resultLines(...)` computes, independently of the app, what the file must
 * contain after a series of decisions.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitIsolationEnv, globalGitConfig, TEST_IDENTITY } from "../fixtures.mjs";

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

const same = (...lines) => ({ kind: "same", lines });
/** Only `side` changed. */
const one = (side, base, changed) => ({ kind: side, base, changed });
const conflict = (base, ours, theirs) => ({ kind: "conflict", base, ours, theirs });

function versions(parts) {
  const out = { base: [], ours: [], theirs: [] };
  for (const part of parts) {
    if (part.kind === "same") for (const key of ["base", "ours", "theirs"]) out[key].push(...part.lines);
    else if (part.kind === "conflict") {
      out.base.push(...part.base);
      out.ours.push(...part.ours);
      out.theirs.push(...part.theirs);
    } else {
      out.base.push(...part.base);
      out.ours.push(...(part.kind === "ours" ? part.changed : part.base));
      out.theirs.push(...(part.kind === "theirs" ? part.changed : part.base));
    }
  }
  return out;
}

/**
 * Expected result. `decide(index, part)` returns, per conflict, the lines that stay
 * (e.g. `part.ours`, `[...part.theirs, ...part.ours]`).
 */
export function resultLines(parts, decide) {
  const out = [];
  let index = 0;
  for (const part of parts) {
    if (part.kind === "same") out.push(...part.lines);
    else if (part.kind === "conflict") out.push(...decide(index++, part));
    else out.push(...part.changed);
  }
  return out;
}

/** Text of a version or result: line endings and final newline as in the file. */
export function toText(lines, { eol = "\n", finalNewline = true } = {}) {
  return lines.join(eol) + (finalNewline && lines.length ? eol : "");
}

// --- The lab's files ------------------------------------------------------------------------

export const STATION = "src/station.py";
export const stationParts = [
  same('"""Auswertung der Wetterstation."""', "import csv", "import statistics", ""),
  conflict(["SCHWELLE_FROST = 0.0"], ["SCHWELLE_FROST = -0.5"], ["SCHWELLE_FROST = 0.5  # Bodenfrost früher melden"]),
  same("SCHWELLE_HITZE = 30.0", "", "", "def lade(pfad):"),
  one("theirs", ['    with open(pfad, newline="") as datei:'], ['    with open(pfad, newline="", encoding="utf-8") as datei:']),
  same('        return list(csv.DictReader(datei, delimiter=";"))', "", "", "def mittel(zeilen, spalte):"),
  conflict(
    ["    werte = [float(z[spalte]) for z in zeilen]", "    return statistics.mean(werte)"],
    ["    werte = [float(z[spalte]) for z in zeilen if z[spalte]]", "    if not werte:", "        return None", "    return statistics.mean(werte)"],
    ['    werte = [float(z[spalte].replace(",", ".")) for z in zeilen]', "    return round(statistics.mean(werte), 2)"],
  ),
  same("", "", "def bericht(zeilen):"),
  one("ours", ['    print(f"Tage: {len(zeilen)}")'], ['    print(f"Messtage: {len(zeilen)}")']),
  same('    print("-" * 40)'),
  conflict(
    ["    print(f\"Mittel: {mittel(zeilen, 'temperatur_c'):.1f} °C\")"],
    ["    print(f\"Durchschnitt: {mittel(zeilen, 'temperatur_c'):.1f} °C\")"],
    ["    print(f\"Mittel: {mittel(zeilen, 'temperatur_c'):.2f} Grad Celsius\")"],
  ),
  same('    print("Ende der Auswertung")'),
];

export const CRLF = "daten/crlf.txt";
export const crlfParts = [same("eins"), conflict(["zwei"], ["ZWEI (main)"], ["zwei (feature)"]), same("drei", "vier"), one("theirs", [], ["fünf"])];

/** Current side with CRLF, incoming with LF; the changes themselves do not touch. */
export const MIXED = "daten/gemischt.txt";
export const mixedParts = [same("eins"), one("ours", ["zwei"], ["ZWEI"]), same("drei"), one("theirs", ["vier"], ["VIER"]), same("fünf")];

export const NO_EOL = "daten/ohne-ende.txt";
export const noEolParts = [same("alpha"), conflict(["beta"], ["BETA-main"], ["beta-feature"]), same("mitte"), conflict(["gamma"], ["gamma-main"], ["gamma-feature"])];

export const LATIN1 = "text/latin1.txt";
export const latin1Parts = [same("Größe;Einheit"), conflict(["Temperatur;°C"], ["Temperatur;°C (Mittel)"], ["Temperatur;Grad Celsius"]), same("Druck;hPa")];

export const BOTH_ADDED = "neu/beide.txt";
export const bothAdded = { ours: ["kopf", "eins", "mitte", "zwei", "ende"], theirs: ["kopf", "EINS", "mitte", "ZWEI", "ende"] };

export const MANY = "gross/viele.txt";
const manyLine = (index) => `Messpunkt ${String(index).padStart(5, "0")};${index % 97}`;
const range = (from, to) => Array.from({ length: to - from }, (_, offset) => manyLine(from + offset));
export const manyParts = [
  same(...range(0, 100)),
  conflict([manyLine(100)], [`${manyLine(100)};geprüft`], [`${manyLine(100)};korrigiert`]),
  same(...range(101, 5000)),
  one("ours", [manyLine(5000)], [`${manyLine(5000)};nur main`]),
  same(...range(5001, 10000)),
  one("theirs", [manyLine(10000)], [`${manyLine(10000)};nur feature`]),
  same(...range(10001, 15000)),
  conflict([manyLine(15000)], [`${manyLine(15000)};Ausreißer entfernt`], [`${manyLine(15000)};Ausreißer markiert`, `${manyLine(15000)};Zusatzzeile`]),
  same(...range(15001, 20000)),
];

export const HUGE = "gross/riesig.txt";
const HUGE_LINES = 130_000;
function hugeVersion(tag) {
  const lines = Array.from({ length: HUGE_LINES }, (_, index) => `Zeile ${index}`);
  if (tag) {
    lines[10] = `Zeile 10 (${tag})`;
    lines[120_000] = `Zeile 120000 (${tag})`;
  }
  return lines;
}
export const hugeText = (tag) => toText(hugeVersion(tag));

export const BINARY = "bild/logo.bin";
export function binaryBlob(seed) {
  const bytes = Buffer.alloc(512);
  let state = seed * 2654435761;
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = index % 16 === 0 ? 0 : state >>> 24;
  }
  return bytes;
}

export const DELETED_BY_US = "docs/alt.md";
export const DELETED_BY_THEM = "docs/weg.md";
export const RENAMED = { old: "docs/name.md", ours: "docs/name-main.md", theirs: "docs/name-feature.md" };
export const deletedByUsTheirs = "# Alte Anleitung\n\nAufbau der Station, überarbeitet für den zweiten Standort.\n";
export const deletedByThemOurs = "# Wegweiser\n\nDer Weg zur Station führt jetzt über den Nordhang.\n";
const renamedText = "# Namensliste\n\nStation Nord, Station Süd, Station Tal.\nDiese Datei wurde auf beiden Seiten umbenannt.\n";

/** All conflict files of the lab, in Git's order. */
export const LAB_CONFLICTS = [BINARY, CRLF, MIXED, NO_EOL, DELETED_BY_US, RENAMED.theirs, RENAMED.ours, RENAMED.old, DELETED_BY_THEM, HUGE, MANY, BOTH_ADDED, STATION, LATIN1];
export const LAB = { ours: "main", theirs: "feature/umbau" };

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

const live = new Set();
process.on("exit", () => {
  for (const dir of live) remove(dir);
});

function remove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch {
    // stays in the temp folder; the next fixture run removes orphaned folders
  }
}

function tempRoot(prefix) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `gc-fix-${prefix}-`)));
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  fs.writeFileSync(path.join(root, "gitconfig"), globalGitConfig());
  live.add(root);
  return root;
}

let clock = 1772434800;
/** git in `repoPath`; stdout as a raw Buffer – nothing is decoded or truncated. */
export function gitRaw(repoPath, args, { allowFail = false } = {}) {
  clock += 600;
  const when = `${clock} +0100`;
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      env: {
        ...process.env,
        ...gitIsolationEnv(path.join(path.dirname(repoPath), "gitconfig")),
        GIT_AUTHOR_NAME: TEST_IDENTITY.name,
        GIT_AUTHOR_EMAIL: TEST_IDENTITY.email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: TEST_IDENTITY.name,
        GIT_COMMITTER_EMAIL: TEST_IDENTITY.email,
        GIT_COMMITTER_DATE: when,
      },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (allowFail) return Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]);
    const detail = [error.stdout, error.stderr].map((part) => (part ? part.toString("utf8") : "")).join("\n").trim();
    throw new Error(`git ${args.join(" ")} failed (in ${repoPath}):\n${detail || error.message}`);
  }
}

function writeFile(repoPath, rel, content) {
  const file = path.join(repoPath, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function init(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  gitRaw(repo, ["init", "-q", "-b", "main"]);
  gitRaw(repo, ["config", "user.name", TEST_IDENTITY.name]);
  gitRaw(repo, ["config", "user.email", TEST_IDENTITY.email]);
  return repo;
}

/** What every fixture exposes. */
function publish(root, repo, info) {
  const git = (...args) => gitRaw(repo, args).toString("utf8").replace(/\r?\n$/, "");
  return {
    path: repo,
    root,
    info,
    git,
    gitRaw: (...args) => gitRaw(repo, args),
    /** File in the working directory as bytes; null if it does not exist. */
    read: (rel) => (fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel)) : null),
    write: (rel, content) => writeFile(repo, rel, content),
    /** Blob of an index stage (1 base, 2 ours, 3 theirs) or of the staged version (0). */
    stage: (stage, rel) => gitRaw(repo, ["cat-file", "blob", `:${stage}:${rel}`]),
    unmerged: (rel) => git("ls-files", "-u", ...(rel ? ["--", rel] : [])),
    stagedNames: () => git("diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean),
    cleanup: () => {
      remove(root);
      live.delete(root);
    },
  };
}

// ---------------------------------------------------------------------------
// Lab: open merge with every kind of conflict
// ---------------------------------------------------------------------------

let labTemplate = null;

function buildLabTemplate() {
  const root = tempRoot("s13-template");
  const repo = init(root, "konflikt-labor");
  const texts = {
    [STATION]: [versions(stationParts), {}],
    [CRLF]: [versions(crlfParts), { eol: "\r\n" }],
    [NO_EOL]: [versions(noEolParts), { finalNewline: false }],
    [MANY]: [versions(manyParts), {}],
  };
  const latin = versions(latin1Parts);
  const mixed = versions(mixedParts);
  const put = (which) => {
    for (const [file, [version, options]] of Object.entries(texts)) writeFile(repo, file, toText(version[which], options));
    writeFile(repo, MIXED, toText(mixed[which], { eol: which === "ours" ? "\r\n" : "\n" }));
    writeFile(repo, LATIN1, Buffer.from(toText(latin[which]), "latin1"));
  };

  // Initial state
  put("base");
  writeFile(repo, "README.md", "# Konflikt-Labor\n\nHier kommt jede Art von Merge-Konflikt einmal vor.\n");
  writeFile(repo, BINARY, binaryBlob(1));
  writeFile(repo, DELETED_BY_US, "# Alte Anleitung\n\nAufbau der Station.\n");
  writeFile(repo, DELETED_BY_THEM, "# Wegweiser\n\nDer Weg zur Station.\n");
  writeFile(repo, RENAMED.old, renamedText);
  writeFile(repo, HUGE, hugeText(null));
  gitRaw(repo, ["add", "-A"]);
  gitRaw(repo, ["commit", "-q", "-m", "Ausgangsstand des Labors"]);

  // feature/umbau – the incoming side
  gitRaw(repo, ["checkout", "-q", "-b", LAB.theirs]);
  put("theirs");
  writeFile(repo, BINARY, binaryBlob(3));
  writeFile(repo, DELETED_BY_US, deletedByUsTheirs);
  gitRaw(repo, ["rm", "-q", DELETED_BY_THEM]);
  gitRaw(repo, ["mv", RENAMED.old, RENAMED.theirs]);
  writeFile(repo, BOTH_ADDED, toText(bothAdded.theirs));
  writeFile(repo, HUGE, hugeText("feature"));
  writeFile(repo, "README.md", "# Konflikt-Labor\n\nHier kommt jede Art von Merge-Konflikt einmal vor.\n\nStand: Umbau.\n");
  gitRaw(repo, ["add", "-A"]);
  gitRaw(repo, ["commit", "-q", "-m", "Umbau: Schwellen, Rundung, neue Namen"]);

  // main – the current side
  gitRaw(repo, ["checkout", "-q", "main"]);
  put("ours");
  writeFile(repo, BINARY, binaryBlob(2));
  gitRaw(repo, ["rm", "-q", DELETED_BY_US]);
  writeFile(repo, DELETED_BY_THEM, deletedByThemOurs);
  gitRaw(repo, ["mv", RENAMED.old, RENAMED.ours]);
  writeFile(repo, BOTH_ADDED, toText(bothAdded.ours));
  writeFile(repo, HUGE, hugeText("main"));
  gitRaw(repo, ["add", "-A"]);
  gitRaw(repo, ["commit", "-q", "-m", "Frostschwelle gesenkt, leere Werte abgefangen"]);
  return root;
}

/**
 * Fresh copy of the lab with an open merge (main ← feature/umbau). 14 conflict files
 * (`LAB_CONFLICTS`); README.md is merged cleanly and staged.
 */
export function makeLabRepo() {
  labTemplate ??= buildLabTemplate();
  const root = tempRoot("s13");
  fs.cpSync(labTemplate, root, { recursive: true });
  fs.writeFileSync(path.join(root, ".owner"), String(process.pid));
  const repo = path.join(root, "konflikt-labor");
  const output = gitRaw(repo, ["merge", "--no-ff", LAB.theirs], { allowFail: true }).toString("utf8");
  if (!/CONFLICT/.test(output)) throw new Error(`makeLabRepo: the merge should have produced conflicts.\n${output}`);
  return publish(root, repo, { conflicted: LAB_CONFLICTS, ...LAB });
}

// ---------------------------------------------------------------------------
// Rebase conflict
// ---------------------------------------------------------------------------

export const REBASE_FILE = "notizen/messplan.md";
export const rebaseParts = [
  same("# Messplan", ""),
  conflict(["- Temperatur: alle 10 Minuten"], ["- Temperatur: alle 5 Minuten"], ["- Temperatur: alle 10 Minuten, nachts alle 30"]),
  same("- Regen: bei Ereignis", "- Wind: alle 10 Minuten"),
];

/**
 * `feature/nachtmodus` is rebased onto `main` and stops at a conflict. For Git, "ours" is then
 * the state of main (the target) and "theirs" is the branch's own commit.
 */
export function makeRebaseRepo() {
  const root = tempRoot("s13-rebase");
  const repo = init(root, "rebase-labor");
  const version = versions(rebaseParts);
  writeFile(repo, REBASE_FILE, toText(version.base));
  gitRaw(repo, ["add", "-A"]);
  gitRaw(repo, ["commit", "-q", "-m", "Messplan angelegt"]);
  gitRaw(repo, ["checkout", "-q", "-b", "feature/nachtmodus"]);
  writeFile(repo, REBASE_FILE, toText(version.theirs));
  gitRaw(repo, ["commit", "-q", "-am", "Nachts seltener messen"]);
  gitRaw(repo, ["checkout", "-q", "main"]);
  writeFile(repo, REBASE_FILE, toText(version.ours));
  gitRaw(repo, ["commit", "-q", "-am", "Temperatur alle 5 Minuten"]);
  gitRaw(repo, ["checkout", "-q", "feature/nachtmodus"]);
  const output = gitRaw(repo, ["rebase", "main"], { allowFail: true }).toString("utf8");
  if (!/CONFLICT/.test(output)) throw new Error(`makeRebaseRepo: the rebase should have produced a conflict.\n${output}`);
  return publish(root, repo, { conflicted: [REBASE_FILE], onto: "main", branch: "feature/nachtmodus" });
}
