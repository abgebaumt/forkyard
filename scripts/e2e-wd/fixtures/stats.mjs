/**
 * Real Git repositories for scripts/e2e-wd/features/stats.mjs. Every commit has a fixed author,
 * a fixed hour in a fixed time zone and a known day relative to today (the statistics' periods
 * are relative to "now"), so the expected numbers can be derived here – independently of the
 * core – from what was committed and from git itself.
 *
 *   const repo = makeStatsRepo();   // { path, git(...), commit(...), expected, cleanup() }
 *
 * Isolated from the machine's Git configuration (own global gitconfig, GIT_CONFIG_NOSYSTEM).
 * Content is made-up German test data on purpose.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEST_IDENTITY, gitIsolationEnv, globalGitConfig } from "../../e2e/fixtures.mjs";

export const DAY_MS = 86_400_000;
/** Time zone of every fixture commit (the heatmap uses the author's local time). */
export const ZONE = "+0200";
const ZONE_HOURS = 2;

export const PEOPLE = {
  lena: TEST_IDENTITY,
  jonas: { name: "Jonas Becker", email: "jonas.becker@wetterstation.example" },
  /** The same person with a differently cased address: one author for the statistics. */
  jonasUpper: { name: "Jonas Becker", email: "Jonas.Becker@Wetterstation.example" },
  aylin: { name: "Aylin Demir", email: "aylin.demir@wetterstation.example" },
  mehmet: { name: "Mehmet Yılmaz", email: "mehmet.yilmaz@wetterstation.example" },
};

const leftovers = new Set();
process.on("exit", () => {
  for (const dir of leftovers) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // still locked: stays in the temp folder
    }
  }
});

/** Midnight UTC of today minus `days`, as ms. */
export const midnightDaysAgo = (days, now = Date.now()) => Math.floor(now / DAY_MS) * DAY_MS - days * DAY_MS;

/** Unix seconds of `hour:minute` local time (ZONE) on the day `days` ago. */
export function stamp(days, hour, minute = 0) {
  return Math.round((midnightDaysAgo(days) + (hour - ZONE_HOURS) * 3_600_000 + minute * 60_000) / 1000);
}

/** Weekday index Monday first (0..6) of the local day `days` ago. */
export const weekdayOf = (days) => (new Date(midnightDaysAgo(days)).getUTCDay() + 6) % 7;
/** YYYY-MM-DD of the local day `days` ago. */
export const dateOf = (days) => new Date(midnightDaysAgo(days)).toISOString().slice(0, 10);

const lines = (prefix, count, from = 1) => Array.from({ length: count }, (_, index) => `${prefix} ${from + index}`).join("\n") + "\n";

/** An empty repository with helpers (nothing committed). */
export function makeBareStatsRepo(name = "messnetz-statistik") {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fy-wd-stats-")));
  leftovers.add(root);
  const globalConfig = path.join(root, "gitconfig");
  fs.writeFileSync(globalConfig, globalGitConfig());
  const repoPath = path.join(root, name);
  fs.mkdirSync(repoPath);
  let when = { person: PEOPLE.lena, time: stamp(0, 12) };
  const env = () => ({
    ...process.env,
    ...gitIsolationEnv(globalConfig),
    GIT_AUTHOR_NAME: when.person.name,
    GIT_AUTHOR_EMAIL: when.person.email,
    GIT_COMMITTER_NAME: when.person.name,
    GIT_COMMITTER_EMAIL: when.person.email,
    GIT_AUTHOR_DATE: `${when.time} ${ZONE}`,
    GIT_COMMITTER_DATE: `${when.time} ${ZONE}`,
  });
  const git = (...args) => execFileSync("git", args, { cwd: repoPath, env: env(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString().replace(/\n$/, "");
  const write = (rel, content) => {
    const target = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const append = (rel, content) => fs.appendFileSync(path.join(repoPath, rel), content);
  const read = (rel) => fs.readFileSync(path.join(repoPath, rel), "utf8");
  /** Commits everything as `person` on the day `days` ago at `hour` (local, ZONE). */
  const commit = (person, days, hour, message, minute = 0) => {
    when = { person, time: stamp(days, hour, minute) };
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  /** Runs git with the identity and time of the given commit moment. */
  const gitAt = (person, days, hour, ...args) => {
    when = { person, time: stamp(days, hour) };
    return git(...args);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", TEST_IDENTITY.name);
  git("config", "user.email", TEST_IDENTITY.email);
  return {
    root,
    path: repoPath,
    git,
    gitAt,
    write,
    append,
    read,
    commit,
    head: () => git("rev-parse", "HEAD"),
    cleanup() {
      // removed at process exit: the app may still write into .git (see the branches ledger ruling)
    },
  };
}

/**
 * The standard repository (branch main, HEAD = a merge commit three days ago):
 *
 *  days ago  hour  author        change
 *  800       10    Lena          README.md, src/station/sensor.rs, docs/handbuch.md, bild.png (binary)
 *  400       15    Jonas         src/station/export.rs
 *  200       11    Aylin         docs/handbuch.md
 *  100       13    Jonas         src/station/sensor.rs
 *   60       17    Lena          "docs/Größen und Einheiten.md"
 *   20       10    Aylin         src/station/sensor.rs
 *   10       21    Jonas (Upper-case address)   daten/messwerte.csv (+500, the biggest commit)
 *    5       10    Lena          src/station/export.rs
 *    4  9, 11, 14  Lena          src/station/sensor.rs (three commits)
 *    4       12    Mehmet        src/kalibrierung/tabelle.rs  (branch feature/kalibrierung)
 *    3       16    Aylin         README.md
 *    3       18    Lena          merge of feature/kalibrierung (no-ff, not counted)
 *
 * Unmerged branch experiment/funk: one more commit by Mehmet two days ago at 20:00 (funk/modul.rs).
 */
export function makeStatsRepo(name = "messnetz-statistik") {
  const repo = makeBareStatsRepo(name);
  const { write, append, commit, git, gitAt } = repo;
  /** [person, days, hour] of every counted commit on main. */
  const counted = [];
  const add = (person, days, hour, message, minute = 0) => {
    counted.push({ person, days, hour });
    return commit(person, days, hour, message, minute);
  };

  write("README.md", "# Messnetz\n\n" + lines("Hinweis", 8));
  write("src/station/sensor.rs", lines("// Sensorwert", 30));
  write("docs/handbuch.md", "# Handbuch\n\n" + lines("Abschnitt", 18));
  write("bild.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0, 1, 2, 3, 0, 0, 0xff, 0xfe]));
  add(PEOPLE.lena, 800, 10, "Messnetz anlegen");
  write("src/station/export.rs", lines("// Export", 40));
  add(PEOPLE.jonas, 400, 15, "Export der Messwerte");
  write("docs/handbuch.md", "# Handbuch\n\n" + lines("Abschnitt", 16) + lines("Neu", 5));
  add(PEOPLE.aylin, 200, 11, "Handbuch ergänzen");
  write("src/station/sensor.rs", lines("// Sensorwert", 25) + lines("// Kalibriert", 10));
  add(PEOPLE.jonas, 100, 13, "Sensor kalibrieren");
  write("docs/Größen und Einheiten.md", lines("Größe", 8));
  add(PEOPLE.lena, 60, 17, "Größen und Einheiten beschreiben");
  append("src/station/sensor.rs", lines("// Grenzwert", 3));
  add(PEOPLE.aylin, 20, 10, "Grenzwerte für den Sensor");
  write("daten/messwerte.csv", "zeit;wert\n" + lines("2026-01-01;", 499));
  const biggest = add(PEOPLE.jonasUpper, 10, 21, "Messwerte Januar importieren");
  append("src/station/export.rs", lines("// CSV", 2));
  const branchBase = add(PEOPLE.lena, 5, 10, "Export als CSV");
  append("src/station/sensor.rs", "// Frühmessung\n");
  add(PEOPLE.lena, 4, 9, "Frühmessung");
  append("src/station/sensor.rs", "// Mittagsmessung\n");
  add(PEOPLE.lena, 4, 11, "Mittagsmessung");
  append("src/station/sensor.rs", "// Nachmittagsmessung\n");
  add(PEOPLE.lena, 4, 14, "Nachmittagsmessung");
  // Side branch from "Export als CSV", one commit by Mehmet.
  git("branch", "feature/kalibrierung", branchBase);
  git("checkout", "-q", "feature/kalibrierung");
  write("src/kalibrierung/tabelle.rs", lines("// Tabelle", 12));
  add(PEOPLE.mehmet, 4, 12, "Kalibriertabelle");
  git("checkout", "-q", "main");
  append("README.md", "Siehe Handbuch.\n");
  add(PEOPLE.aylin, 3, 16, "README verweist auf das Handbuch");
  gitAt(PEOPLE.lena, 3, 18, "merge", "-q", "--no-ff", "-m", "Merge feature/kalibrierung", "feature/kalibrierung");
  const tip = repo.head();
  // Unmerged branch.
  git("checkout", "-q", "-b", "experiment/funk");
  write("funk/modul.rs", lines("// Funk", 6));
  commit(PEOPLE.mehmet, 2, 20, "Funkmodul ausprobieren");
  git("checkout", "-q", "main");

  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const { days, hour } of counted) heatmap[weekdayOf(days)][hour] += 1;
  const inLast = (days) => counted.filter((item) => item.days <= days).length;
  return {
    ...repo,
    tip,
    biggest,
    counted,
    expected: {
      commits: counted.length,
      heatmap,
      /** Commits within the presets (the fixture keeps clear of their borders). */
      presets: { all: counted.length, year: inLast(365), quarter: inLast(90), month: inLast(30) },
      authors: { all: 4 },
      streak: { days: 3, start: dateOf(5), end: dateOf(3) },
      busiest: { date: dateOf(4), commits: 4 },
      topHotspot: "src/station/sensor.rs",
    },
  };
}

/** Only old history: nothing within the last 30 days (empty-period case). */
export function makeOldStatsRepo(name = "altes-archiv") {
  const repo = makeBareStatsRepo(name);
  repo.write("chronik.md", lines("Eintrag", 5));
  repo.commit(PEOPLE.lena, 500, 10, "Chronik beginnen");
  repo.write("chronik.md", lines("Eintrag", 9));
  repo.commit(PEOPLE.aylin, 450, 14, "Chronik fortsetzen");
  return repo;
}

/** Many authors with one commit each, files with odd names in deep folders. */
export function makeCrowdStatsRepo(authors = 14, name = "viele-hände") {
  const repo = makeBareStatsRepo(name);
  for (let index = 0; index < authors; index += 1) {
    const person = { name: `Prüferin Nummer ${index + 1}`, email: `pruefer.${index + 1}@wetterstation.example` };
    const folder = `tief/ebene ${index % 3}/unter ordner/ä ö ü`;
    repo.write(`${folder}/datei #${index} (kopie).txt`, lines("Zeile", index + 1));
    repo.commit(person, 30 + index, 9 + (index % 10), `Beitrag ${index + 1}`);
  }
  return repo;
}

/** Lines of every text file at `rev` (bytes without a NUL in the first 8000 bytes). */
export function textLinesAt(repo, rev = "HEAD") {
  const files = repo.git("ls-tree", "-r", "--name-only", "-z", rev).split("\0").filter(Boolean);
  let total = 0;
  let count = 0;
  for (const file of files) {
    const content = execFileSync("git", ["show", `${rev}:${file}`], { cwd: repo.path, maxBuffer: 64 * 1024 * 1024 });
    if (content.subarray(0, 8000).includes(0)) continue;
    count += 1;
    const text = content.toString("latin1");
    total += text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }
  return { files: count, lines: total };
}

/** Per author (lower-case address): commits, added and removed lines (no merges, text only). */
export function authorTotals(repo, rev = "HEAD") {
  const out = repo.git("log", "--no-merges", "--numstat", "--format=@%ae", rev);
  const totals = {};
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@")) {
      current = line.slice(1).toLowerCase();
      totals[current] ??= { commits: 0, added: 0, removed: 0 };
      totals[current].commits += 1;
    } else if (current && /^\d+\t\d+\t/.test(line)) {
      const [added, removed] = line.split("\t");
      totals[current].added += Number(added);
      totals[current].removed += Number(removed);
    }
  }
  return totals;
}

/** Code age buckets from git blame (author time of each line against the commit time of `rev`). */
export function codeAgeFromBlame(repo, rev = "HEAD") {
  const reference = Number(repo.git("log", "-1", "--format=%ct", rev));
  const files = repo.git("ls-tree", "-r", "--name-only", "-z", rev).split("\0").filter(Boolean);
  const buckets = { month: 0, halfYear: 0, year: 0, twoYears: 0, older: 0 };
  const DAY = 86_400;
  for (const file of files) {
    const content = execFileSync("git", ["show", `${rev}:${file}`], { cwd: repo.path });
    if (content.subarray(0, 8000).includes(0)) continue;
    const blame = repo.git("blame", "--line-porcelain", rev, "--", file);
    for (const line of blame.split("\n")) {
      if (!line.startsWith("author-time ")) continue;
      const age = reference - Number(line.slice(12));
      if (age < 30 * DAY) buckets.month += 1;
      else if (age < 180 * DAY) buckets.halfYear += 1;
      else if (age < 365 * DAY) buckets.year += 1;
      else if (age < 730 * DAY) buckets.twoYears += 1;
      else buckets.older += 1;
    }
  }
  return buckets;
}
