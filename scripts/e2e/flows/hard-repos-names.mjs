/**
 * Difficult repositories, part 1: FILE NAMES AND PATHS – in the real app, against real git.
 *
 *   node scripts/e2e/flows/hard-repos-names.mjs [--show] [--only <part>[,<part>]]
 *
 * Every fixture goes through the core loop (open, graph, view commit, diff, stage, commit, create and
 * switch branch – see `coreLoop` in hard-repos-lib.mjs), plus targeted checks:
 *   N1  special characters NTFS allows: spaces, umlauts (NFC and NFD), emoji, leading dash,
 *       single quotes, brackets (pathspec glob), #, !, %, &, ;, $, leading space
 *   N2  names only Linux knows (", newline, tab, *, ?, |, <, >, :) – in the commit and in the index,
 *       working tree incomplete (this is what such a clone looks like on Windows)
 *   N3  the same after a failed checkout (empty index)
 *   N4  very long paths (> 260 characters), with core.longpaths
 *   N5  names in the index that differ only in case
 *   N6  UI: lists, diff and staging by click with these names
 *
 * At the end there is a list of green and red sections. Red sections with "BUG L2-…" are the tests
 * the respective bug is fixed against.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { healthy, call, closeRepo, coreLoop, coreStatusPaths, createRun, gitStatus, lines, sorted, toasts, wipRows, workspace, write, zlist, selectWip, selectCommit, sleep } from "./hard-repos-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("hard-repos-names", { argv });
const { check, equal, eventually, note } = t;
/** Before every section: if the UI crashed (empty window), a fresh instance starts. */
async function ensureApp() {
  if (app && (await healthy(app))) return;
  if (app) {
    console.log("  · the UI no longer responds – new instance");
    await app.close().catch(() => undefined);
  }
  app = await launchApp({ show });
  t.attach(app);
}
const section = async (title, run, options) => {
  await ensureApp();
  return t.section(title, run, options);
};

let app = null;
const spaces = [];
const ws0 = (prefix, options) => {
  const ws = workspace(prefix, options);
  spaces.push(ws);
  return ws;
};

/** Path in fast-import notation (C style, bytes in octal). */
const fiQuote = (name) => `"${[...Buffer.from(name, "utf8")].map((byte) => (byte === 0x22 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : byte < 0x20 || byte > 0x7e ? `\\${byte.toString(8).padStart(3, "0")}` : String.fromCharCode(byte))).join("")}"`;

const WHO = "Lena Hartmann <lena.hartmann@wetterstation.example>";
/** fast-import `data` block with the correct byte count. */
const data = (text) => `data ${Buffer.byteLength(text)}\n${text}`;

/** Names NTFS allows. */
const NTFS_NAMES = [
  "mit leerzeichen/datei mit leerzeichen.txt",
  "Größe/Übersicht äöüß ÄÖÜ.md",
  "emoji/🌦️ wetter 🚀.txt",
  "emoji/👨‍👩‍👧 familie.txt",
  "-rf.txt",
  "--help",
  "-",
  "--",
  "einfach'anführung.txt",
  "back`tick.txt",
  "$dollar ${HOME}.txt",
  "semi;colon.txt",
  "amp&ersand.txt",
  "daten[1].txt",
  "daten1.txt",
  "{braces}.txt",
  "#hash.txt",
  "!bang.txt",
  "%percent%20.txt",
  "~tilde.txt",
  "^caret.txt",
  "=gleich.txt",
  "+plus.txt",
  ",komma.txt",
  "@at.txt",
  " führendes leerzeichen.txt",
  "punkt..punkt.txt",
  ".versteckt",
  "日本語/ファイル.txt",
  "عربى.txt",
  // Umlaut composed (NFC) and decomposed (NFD): two different files
  "nfc-über.txt",
  "nfd-über.txt",
  "ordner mit ' und &/unter ordner/datei (kopie) [2].txt",
];

function buildNtfsNames(ws) {
  const repo = ws.init("sonder zeichen & co");
  for (const name of NTFS_NAMES) write(repo, name, `Inhalt von ${name}\nzweite Zeile\n`);
  ws.commit(repo, "Dateien mit schwierigen Namen angelegt");
  for (const name of NTFS_NAMES) write(repo, name, `Inhalt von ${name}\nzweite Zeile geändert\ndritte Zeile\n`);
  return repo;
}

/** Names that only exist on Linux. */
const LINUX_NAMES = ['anf"zeichen.txt', "zeile\numbruch.txt", "tab\tstopp.txt", "stern*.txt", "frage?.txt", "pipe|.txt", "spitz<>.txt", "wagen\rrücklauf.txt", 'alles "auf"\teinmal\n*?.txt'];
/**
 * Names for which NTFS creates something DIFFERENT than requested: "a:b" becomes a data stream on the
 * file "a", a trailing dot is dropped, "aux" is a device. Git then sees the file as present and modified,
 * but cannot read it (`git diff`: "cannot hash").
 */
const NTFS_TRAPS = ["doppel:punkt.txt", "ende.", "aux.txt"];

/** A commit with `names` and normal.txt, checked out with core.protectNTFS=false (the usual advice for "invalid path"). */
function buildWithNames(ws, names) {
  const repo = ws.init("von-linux-2");
  let stream = `blob\nmark :1\n${data("hallo\n")}\ncommit refs/heads/main\nmark :2\nauthor ${WHO} 1772434800 +0100\ncommitter ${WHO} 1772434800 +0100\n${data("Dateien von einem Linux-System")}\n`;
  for (const name of [...names, "normal.txt"]) stream += `M 100644 :1 ${fiQuote(name)}\n`;
  stream += "\n";
  ws.git(repo, ["-c", "core.protectNTFS=false", "fast-import", "--quiet"], { input: Buffer.from(stream, "utf8") });
  ws.tryGit(repo, ["-c", "core.protectNTFS=false", "checkout", "-q", "-f", "main"]);
  return repo;
}

function buildLinuxNames(ws, { checkout }) {
  const repo = ws.init("von-linux");
  let stream = `blob\nmark :1\n${data("hallo\n")}\ncommit refs/heads/main\nmark :2\nauthor ${WHO} 1772434800 +0100\ncommitter ${WHO} 1772434800 +0100\n${data("Dateien von einem Linux-System")}\n`;
  for (const name of [...LINUX_NAMES, "normal.txt", "ordner/auch normal.txt"]) stream += `M 100644 :1 ${fiQuote(name)}\n`;
  stream += `\nblob\nmark :3\n${data("hallo\nwelt!\n")}\ncommit refs/heads/main\nmark :4\nauthor ${WHO} 1772438400 +0100\ncommitter ${WHO} 1772438400 +0100\n${data("Zweite Zeile ergänzt")}\nfrom :2\n`;
  for (const name of [...LINUX_NAMES.slice(0, 4), "normal.txt"]) stream += `M 100644 :3 ${fiQuote(name)}\n`;
  stream += "\n";
  ws.git(repo, ["-c", "core.protectNTFS=false", "fast-import", "--quiet"], { input: Buffer.from(stream, "utf8") });
  // On Windows the checkout fails on these names – just like after a `git clone`.
  if (checkout) ws.tryGit(repo, ["-c", "core.protectNTFS=false", "checkout", "-q", "-f", "main"]);
  else ws.tryGit(repo, ["checkout", "-q", "-f", "main"]);
  return repo;
}

try {

  // ---------------------------------------------------------------------------------------------
  await section("N1 Special characters (NTFS): core loop", async () => {
    const ws = ws0("n1");
    const repo = buildNtfsNames(ws);
    const seen = await coreLoop(t, app, ws, repo, { summary: "Änderungen an Dateien mit schwierigen Namen" });
    if (seen.status) equal(sorted(seen.status.unstaged.map((file) => file.path)), sorted(NTFS_NAMES), "status_get lists every name unchanged");
    equal(sorted(zlist(ws.git(repo, ["-c", "core.quotepath=false", "show", "--name-only", "--format=", "-z", "HEAD"], { raw: true }).toString("utf8"))), sorted(NTFS_NAMES), "git: the app's commit contains all files");
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("N1 Pathspec glob: staging, unstaging, discarding daten[1].txt does not hit daten1.txt", async () => {
    const ws = ws0("n1b");
    const repo = buildNtfsNames(ws);
    const { repoId, tabId } = await app.openRepo(repo);
    const cached = () => sorted(zlist(ws.git(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"], { raw: true }).toString("utf8")));
    for (const name of ["daten[1].txt", "-rf.txt", "--help", "-", "--", "#hash.txt", "!bang.txt", " führendes leerzeichen.txt", "nfd-über.txt", "emoji/👨‍👩‍👧 familie.txt"]) {
      const staged = await call(app, "stage_paths", { repoId, paths: [name] });
      check(staged.ok, `stage_paths(${JSON.stringify(name)}) fails: ${staged.code} ${staged.message}`);
      equal(cached(), [name], `git: only ${JSON.stringify(name)} is staged`);
      const diff = await call(app, "diff_file", { repoId, path: name, source: { kind: "staged" } });
      check(diff.ok && diff.value.kind === "text" && diff.value.hunks.length === 1, `diff_file(staged, ${JSON.stringify(name)}): ${diff.ok ? diff.value.kind : diff.message}`);
      const history = await call(app, "file_history", { repoId, path: name, limit: 10 });
      check(history.ok && history.value.length === 1, `file_history(${JSON.stringify(name)}): ${history.ok ? `${history.value.length} entries` : history.message}`);
      const blame = await call(app, "file_blame", { repoId, path: name, sha: null });
      check(blame.ok && blame.value.length === 3, `file_blame(${JSON.stringify(name)}): ${blame.ok ? `${blame.value.length} lines` : blame.message}`);
      const read = await call(app, "file_read", { repoId, path: name, sha: null });
      check(read.ok && read.value.text?.includes("dritte Zeile"), `file_read(${JSON.stringify(name)}): ${read.ok ? "different content" : read.message}`);
      const unstaged = await call(app, "unstage_paths", { repoId, paths: [name] });
      check(unstaged.ok, `unstage_paths(${JSON.stringify(name)}) fails: ${unstaged.code} ${unstaged.message}`);
      equal(cached(), [], `git: after unstaging ${JSON.stringify(name)} nothing is staged`);
    }
    // Discard: only that one file
    const before = fs.readFileSync(path.join(repo, "daten1.txt"), "utf8");
    const discarded = await call(app, "discard_paths", { repoId, paths: ["daten[1].txt"] });
    check(discarded.ok, `discard_paths(daten[1].txt) fails: ${discarded.code} ${discarded.message}`);
    equal(fs.readFileSync(path.join(repo, "daten1.txt"), "utf8"), before, "daten1.txt keeps its change");
    check(!fs.readFileSync(path.join(repo, "daten[1].txt"), "utf8").includes("dritte Zeile"), "daten[1].txt is reset");
    // Undo brings back exactly this file
    const undone = await call(app, "undo", { repoId });
    check(undone.ok, `undo fails: ${undone.code} ${undone.message}`);
    check(fs.readFileSync(path.join(repo, "daten[1].txt"), "utf8").includes("dritte Zeile"), "undo brings back the change to daten[1].txt");
    // Delete a file and restore it from HEAD
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    for (const name of ["-rf.txt", "daten[1].txt", "#hash.txt"]) {
      const restored = await call(app, "file_restore", { repoId, sha: head, paths: [name] });
      check(restored.ok, `file_restore(${JSON.stringify(name)}) fails: ${restored.code} ${restored.message}`);
      check(!fs.readFileSync(path.join(repo, name), "utf8").includes("dritte Zeile"), `${name} is back at the HEAD state`);
    }
    check(fs.readFileSync(path.join(repo, "daten1.txt"), "utf8").includes("dritte Zeile"), "daten1.txt is not affected by restoring daten[1].txt");
    // Stash with selected files only
    const stashed = await call(app, "stash_create", { repoId, opId: "l2-stash", message: "Teil-Stash mit Sonderzeichen", paths: ["--help", "daten1.txt", "emoji/🌦️ wetter 🚀.txt"], includeUntracked: false });
    check(stashed.ok, `stash_create(selection) fails: ${stashed.code} ${stashed.message}`);
    if (stashed.ok) {
      equal(sorted(zlist(ws.git(repo, ["-c", "core.quotepath=false", "stash", "show", "--name-only", "-z", "stash@{0}"], { raw: true }).toString("utf8"))), sorted(["--help", "daten1.txt", "emoji/🌦️ wetter 🚀.txt"]), "git: the stash contains exactly the three selected files");
      const popped = await call(app, "stash_pop", { repoId, index: 0 });
      check(popped.ok && popped.value.status === "done", `stash_pop: ${popped.ok ? popped.value.status : popped.message}`);
    }
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("N1 Ignoring with special characters: the UI suggestion matches exactly the file", async () => {
    const ws = ws0("n1c");
    const repo = ws.init("ignorieren");
    write(repo, "README.md", "x\n");
    ws.commit(repo, "Start");
    const candidates = ["#hash.txt", "!bang.txt", "daten[1].txt", " führendes leerzeichen.txt", "stern\\backslash-nicht.txt".replace("\\", "_"), "ordner mit [x]/datei.txt", "-rf.txt", "emoji 🚀.txt"];
    const decoys = ["daten1.txt", "hash.txt", "bang.txt", "führendes leerzeichen.txt", "ordner mit x/datei.txt"];
    for (const name of [...candidates, ...decoys]) write(repo, name, "neu\n");
    const { repoId, tabId } = await app.openRepo(repo);
    for (const name of candidates) {
      // The "only this file" suggestion – as the context menu builds it (src/app/actions/files.ts).
      const pattern = await app.page.evaluate(async (file) => {
        const module = await import("/src/app/actions/files.ts");
        return module.ignoreSuggestions([{ path: file }]).find((entry) => entry.key === "file")?.pattern ?? null;
      }, name);
      if (!check(typeof pattern === "string", `no suggestion for ${JSON.stringify(name)}`)) continue;
      const done = await call(app, "ignore_add", { repoId, pattern, stopTracking: false });
      check(done.ok, `ignore_add(${JSON.stringify(pattern)}) fails: ${done.code} ${done.message}`);
      const ignored = ws.tryGit(repo, ["check-ignore", "-q", "--", name]);
      check(ignored.ok, `git: ${JSON.stringify(name)} is NOT ignored with the pattern ${JSON.stringify(pattern)}`);
    }
    for (const name of decoys) check(!ws.tryGit(repo, ["check-ignore", "-q", "--", name]).ok, `git: ${JSON.stringify(name)} is wrongly ignored too`);
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("N2 Linux names in the commit and in the index: view, diff, status", async () => {
    const ws = ws0("n2");
    const repo = buildLinuxNames(ws, { checkout: true });
    const seen = await coreLoop(t, app, ws, repo, { mutate: false });
    const { repoId } = seen.opened;
    const root = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: root } });
    if (check(details.ok, `commit_details(Root) fails: ${details.code} ${details.message}`)) {
      equal(sorted(details.value.files.map((file) => file.path)), sorted([...LINUX_NAMES, "normal.txt", "ordner/auch normal.txt"]), "root commit: file names unchanged (quotes, newline, tab …)");
      for (const file of details.value.files) {
        const diff = await call(app, "diff_file", { repoId, path: file.path, source: { kind: "commit", sha: root } });
        check(diff.ok && diff.value.kind === "text" && diff.value.hunks[0]?.lines[0]?.text === "hallo", `diff_file(Root, ${JSON.stringify(file.path)}): ${diff.ok ? JSON.stringify(diff.value).slice(0, 200) : `${diff.code} ${diff.message}`}`);
      }
    }
    const tree = await call(app, "tree_list", { repoId, sha: root, filter: null });
    if (check(tree.ok, `tree_list(Root) fails: ${tree.code} ${tree.message}`)) equal(sorted(tree.value), sorted([...LINUX_NAMES, "normal.txt", "ordner/auch normal.txt"]), "tree_list lists every name unchanged");
    for (const name of LINUX_NAMES.slice(0, 5)) {
      const read = await call(app, "file_read", { repoId, path: name, sha: ws.git(repo, ["rev-parse", "HEAD"]) });
      check(read.ok && typeof read.value.text === "string" && read.value.text.startsWith("hallo"), `file_read(HEAD, ${JSON.stringify(name)}): ${read.ok ? JSON.stringify(read.value.text) : `${read.code} ${read.message}`}`);
      const history = await call(app, "file_history", { repoId, path: name, limit: 10 });
      check(history.ok && history.value.length >= 1, `file_history(${JSON.stringify(name)}): ${history.ok ? `${history.value.length} entries` : `${history.code} ${history.message}`}`);
      const blame = await call(app, "file_blame", { repoId, path: name, sha: ws.git(repo, ["rev-parse", "HEAD"]) });
      check(blame.ok && blame.value.length >= 1, `file_blame(HEAD, ${JSON.stringify(name)}): ${blame.ok ? `${blame.value.length} lines` : `${blame.code} ${blame.message}`}`);
    }
    // The files are missing from the working tree (NTFS cannot hold them): reported as deleted, diff readable.
    for (const file of (seen.status?.unstaged ?? []).filter((entry) => LINUX_NAMES.includes(entry.path))) {
      equal(file.status, "deleted", `status of ${JSON.stringify(file.path)}`);
    }
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("N2 Linux names: stage deletions one by one and commit", async () => {
    const ws = ws0("n2b");
    const repo = buildLinuxNames(ws, { checkout: true });
    const { repoId, tabId } = await app.openRepo(repo);
    const cached = () => sorted(zlist(ws.git(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"], { raw: true }).toString("utf8")));
    for (const hard of ['anf"zeichen.txt', "zeile\numbruch.txt", "tab\tstopp.txt", "stern*.txt", "frage?.txt"]) {
      const one = await call(app, "stage_paths", { repoId, paths: [hard] });
      check(one.ok, `stage_paths(${JSON.stringify(hard)}) fails: ${one.code} ${one.message}`);
      equal(cached(), [hard], `git: exactly ${JSON.stringify(hard)} is staged`);
      // git itself unstages here (with core.protectNTFS=false) – see the section for BUG L2-03.
      ws.git(repo, ["-c", "core.protectNTFS=false", "reset", "-q", "--", hard], { env: { GIT_LITERAL_PATHSPECS: "1" } });
      equal(cached(), [], "fixture: nothing staged again");
    }
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok, `stage_paths(all) fails: ${all.code} ${all.message}`);
    equal(gitStatus(ws, repo).unstaged, [], "git: nothing unstaged after \"stage all\"");
    const committed = await call(app, "commit_create", { repoId, opId: "l2-n2", summary: "Unter Windows nicht darstellbare Dateien entfernt", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
    check(committed.ok, `commit_create fails: ${committed.code} ${committed.message}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after the commit");
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-03: If the deletion of a file whose name is invalid on Windows is staged, "Unstage all"
  // fails as a whole with "Not found." – the ordinary files stay staged too. Git rejects the one path
  // ("invalid path"); the app passes that through unexplained.
  await section("N2 Linux names: \"Unstage all\" with a staged deletion of an invalid name", async () => {
    const ws = ws0("n2e");
    const repo = buildLinuxNames(ws, { checkout: true });
    write(repo, "normal.txt", "hallo\nwelt!\nund mehr\n");
    const { repoId, tabId } = await app.openRepo(repo);
    const cached = () => sorted(zlist(ws.git(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"], { raw: true }).toString("utf8")));
    const name = 'anf"zeichen.txt';
    const staged = await call(app, "stage_paths", { repoId, paths: [name, "normal.txt"] });
    check(staged.ok, `stage_paths fails: ${staged.code} ${staged.message}`);
    equal(cached(), sorted([name, "normal.txt"]), "git: both staged");
    const all = await call(app, "unstage_paths", { repoId, paths: null });
    // Either it works (the app unstages the invalid name itself), or the message explains the cause –
    // and the ordinary file is unstaged anyway.
    check(all.ok || /Windows|invalid|name|character/i.test(all.message), `unstage_paths(all): ${all.code} – ${all.message}`);
    check(!cached().includes("normal.txt"), `git: normal.txt is no longer staged after "Unstage all" (staged: ${JSON.stringify(cached())})`);
    const one = await call(app, "unstage_paths", { repoId, paths: [name] });
    check(one.ok || /Windows|invalid|name|character/i.test(one.message), `unstage_paths(${JSON.stringify(name)}): ${one.code} – ${one.message}`);
    await closeRepo(app, { repoId, tabId });
  }, { bug: "L2-03" });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-01: status_get fails as a whole (`not_found`, "Not found.") as soon as ONE modified file in
  // the working tree is unreadable – `git diff --numstat` then aborts with "cannot hash" and read_status
  // passes the error through (crates/core/src/commands/status.rs). `git status` itself returns a complete
  // list in the same situation. Result: empty WIP list, no commit possible.
  for (const trap of NTFS_TRAPS) {
    await section(`N2 NTFS trap ${JSON.stringify(trap)} in the index: status stays readable, normal.txt can be committed`, async () => {
      const ws = ws0("n2c");
      const repo = buildWithNames(ws, [trap]);
      write(repo, "normal.txt", "hallo\nund weiter\n");
      const want = gitStatus(ws, repo);
      check(want.unstaged.includes("normal.txt"), `fixture: git status lists normal.txt (${JSON.stringify(want)})`);
      const opened = await app.openRepo(repo);
      const { repoId, tabId } = opened;
      const status = await call(app, "status_get", { repoId });
      check(status.ok, `status_get fails: ${status.code} – ${status.message} – ${String(status.gitOutput ?? "").replace(/\s+/g, " ")}`);
      if (status.ok) equal(coreStatusPaths(status.value), want, "status as in git status");
      await selectWip(app, tabId);
      await eventually(async () => (await wipRows(app, "unstaged")).includes("normal.txt"), true, "UI: normal.txt is listed under \"Unstaged\"", 10_000);
      const stage = await call(app, "stage_paths", { repoId, paths: ["normal.txt"] });
      check(stage.ok, `stage_paths(normal.txt) fails: ${stage.code} – ${stage.message}`);
      const commit = await call(app, "commit_create", { repoId, opId: `l2-trap-${Date.now()}`, summary: "normal.txt ergänzt", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
      check(commit.ok, `commit_create fails: ${commit.code} – ${commit.message}`);
      equal(ws.git(repo, ["log", "-1", "--format=%s"]), "normal.txt ergänzt", "git: the commit is there");
      await closeRepo(app, opened);
    }, { bug: "L2-01" });
  }

  // ---------------------------------------------------------------------------------------------
  // BUG L2-02: A file name with a backslash (an ordinary character on Linux) appears in the lists, but
  // its diff cannot be opened: "The file … does not exist in this comparison."
  await section("N2 File name with a backslash: diff in the commit and in the working tree", async () => {
    const ws = ws0("n2d");
    const name = "back\\slash.txt";
    const repo = buildWithNames(ws, [name]);
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    check(details.ok && details.value.files.some((file) => file.path === name), `commit details list ${JSON.stringify(name)}: ${details.ok ? JSON.stringify(details.value.files.map((file) => file.path)) : details.message}`);
    const inCommit = await call(app, "diff_file", { repoId, path: name, source: { kind: "commit", sha: head } });
    check(inCommit.ok && inCommit.value.kind === "text" && inCommit.value.hunks[0]?.lines[0]?.text === "hallo", `diff_file(commit, ${JSON.stringify(name)}): ${inCommit.ok ? inCommit.value.kind : `${inCommit.code} – ${inCommit.message}`}`);
    const status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.unstaged.some((file) => file.path === name && file.status === "deleted"), `status lists ${JSON.stringify(name)} as deleted`);
    const inWorktree = await call(app, "diff_file", { repoId, path: name, source: { kind: "unstaged" } });
    check(inWorktree.ok && inWorktree.value.kind === "text", `diff_file(unstaged, ${JSON.stringify(name)}): ${inWorktree.ok ? inWorktree.value.kind : `${inWorktree.code} – ${inWorktree.message}`}`);
    const read = await call(app, "file_read", { repoId, path: name, sha: head });
    check(read.ok && read.value.text === "hallo\n", `file_read(HEAD, ${JSON.stringify(name)}): ${read.ok ? JSON.stringify(read.value.text) : `${read.code} – ${read.message}`}`);
    const stage = await call(app, "stage_paths", { repoId, paths: [name] });
    check(stage.ok, `stage_paths(${JSON.stringify(name)}) fails: ${stage.code} – ${stage.message}`);
    equal(zlist(ws.git(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"], { raw: true }).toString("utf8")), [name], "git: the deletion is staged");
    await closeRepo(app, opened);
  }, { bug: "L2-02" });

  // ---------------------------------------------------------------------------------------------
  await section("N3 Clone from Linux with failed checkout (empty index): core loop without writes", async () => {
    const ws = ws0("n3");
    const repo = buildLinuxNames(ws, { checkout: false });
    const seen = await coreLoop(t, app, ws, repo, { mutate: false });
    if (seen.status) check(seen.status.staged.length === LINUX_NAMES.length + 2, `all ${LINUX_NAMES.length + 2} files as staged deletions (got ${seen.status.staged.length})`);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("N4 Very long paths (> 260 characters) with core.longpaths: core loop", async () => {
    const ws = ws0("n4");
    const repo = ws.init("lange-pfade", { config: { "core.longpaths": "true" } });
    const deep = Array.from({ length: 9 }, (_, index) => `ebene-${index + 1}-mit-einem-recht-langen-ordnernamen-für-den-test`).join("/");
    const long = `${deep}/${"sehr-langer-dateiname-".repeat(8)}ende.txt`;
    const total = path.join(repo, long).length;
    write(repo, long, "erste Fassung\n");
    write(repo, "kurz.txt", "kurz\n");
    ws.commit(repo, "Datei mit sehr langem Pfad");
    write(repo, long, "erste Fassung\nzweite Zeile\n");
    write(repo, `${deep}/neu-${"x".repeat(120)}.txt`, "neu\n");
    note(`full path: ${total} characters`);
    check(total > 260, `the path is longer than 260 characters (${total})`);
    const seen = await coreLoop(t, app, ws, repo, { summary: "Lange Pfade geändert" });
    const { repoId } = seen.opened;
    // File view, history, blame, writing and deleting a file with a long path
    const read = await call(app, "file_read", { repoId, path: long, sha: null });
    check(read.ok && read.value.text === "erste Fassung\nzweite Zeile\n", `file_read(long path): ${read.ok ? JSON.stringify(read.value.text) : `${read.code} ${read.message}`}`);
    const written = await call(app, "file_write", { repoId, path: long, content: "erste Fassung\nzweite Zeile\ndritte aus der App\n", encoding: "utf-8", eol: "lf" });
    check(written.ok, `file_write(long path) fails: ${written.code} ${written.message}`);
    equal(fs.readFileSync(path.join(repo, long), "utf8"), "erste Fassung\nzweite Zeile\ndritte aus der App\n", "file with long path written");
    const diff = await call(app, "diff_file", { repoId, path: long, source: { kind: "unstaged" } });
    check(diff.ok && diff.value.kind === "text" && diff.value.hunks.length === 1, `diff_file(unstaged, long path): ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`);
    if (diff.ok && diff.value.kind === "text") {
      const hunk = await call(app, "stage_patch", { repoId, selection: { path: long, hunks: [{ index: 0, lines: null }], expect: diff.value.token } });
      check(hunk.ok, `stage_patch(long path) fails: ${hunk.code} ${hunk.message}`);
      equal(zlist(ws.git(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"], { raw: true }).toString("utf8")), [long], "git: hunk of the file with long path staged");
    }
    const discard = await call(app, "discard_paths", { repoId, paths: null });
    check(discard.ok, `discard_paths(all) fails: ${discard.code} ${discard.message}`);
    equal(fs.readFileSync(path.join(repo, long), "utf8"), "erste Fassung\nzweite Zeile\n", "discard restores the file with long path");
    const undo = await call(app, "undo", { repoId });
    check(undo.ok, `undo(discard) fails: ${undo.code} ${undo.message}`);
    equal(fs.existsSync(path.join(repo, long)) ? fs.readFileSync(path.join(repo, long), "utf8") : null, "erste Fassung\nzweite Zeile\ndritte aus der App\n", "undo brings back the discarded change on the long path");
    const deleted = await call(app, "file_delete", { repoId, path: long });
    check(deleted.ok, `file_delete(long path) fails: ${deleted.code} ${deleted.message}`);
    check(!fs.existsSync(path.join(repo, long)), "file with long path is deleted");
    const stash = await call(app, "stash_create", { repoId, opId: "l2-n4", message: "lange Pfade", paths: null, includeUntracked: true });
    check(stash.ok, `stash_create with long path fails: ${stash.code} ${stash.message}`);
    const pop = await call(app, "stash_pop", { repoId, index: 0 });
    check(pop.ok, `stash_pop with long path fails: ${pop.code} ${pop.message}`);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("N4 Very long paths WITHOUT core.longpaths: understandable message instead of a silent gap", async () => {
    const ws = ws0("n4b");
    const repo = ws.init("lange-pfade-ohne");
    const deep = Array.from({ length: 9 }, (_, index) => `ebene-${index + 1}-mit-einem-recht-langen-ordnernamen-für-den-test`).join("/");
    const long = `${deep}/${"sehr-langer-dateiname-".repeat(8)}ende.txt`;
    write(repo, "kurz.txt", "kurz\n");
    write(repo, long, "erste Fassung\n");
    ws.git(repo, ["-c", "core.longpaths=true", "add", "-A"]);
    ws.git(repo, ["-c", "core.longpaths=true", "commit", "-q", "-m", "Datei mit sehr langem Pfad"]);
    write(repo, "kurz.txt", "kurz\ngeändert\n");
    const opened = await app.openRepo(repo);
    const { repoId } = opened;
    const status = await call(app, "status_get", { repoId });
    // git without longpaths: "Filename too long" – the file counts as deleted. That is Git's view; the app
    // may show it, but must stay usable.
    check(status.ok, `status_get fails: ${status.code} ${status.message}`);
    if (status.ok) note(`status without core.longpaths: unstaged=${JSON.stringify(status.value.unstaged.map((file) => `${file.status}:${file.path.slice(-20)}`))}`);
    const stage = await call(app, "stage_paths", { repoId, paths: ["kurz.txt"] });
    check(stage.ok, `stage_paths(kurz.txt) fails: ${stage.code} ${stage.message}`);
    const commit = await call(app, "commit_create", { repoId, opId: "l2-n4b", summary: "kurz geändert", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(zlist(ws.git(repo, ["-c", "core.quotepath=false", "show", "--name-only", "--format=", "-z", "HEAD"], { raw: true }).toString("utf8")), ["kurz.txt"], "git: the commit only contains kurz.txt – the long file is not accidentally deleted");
    check(fs.existsSync(path.join(repo, long)), "the file with long path is still on disk");
    await closeRepo(app, opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("N5 Names differing only in case in the index: status, diff, commit without loss", async () => {
    const ws = ws0("n5");
    const repo = ws.init("gross-klein");
    let stream = `blob\nmark :1\n${data("GROSS: README\n")}\nblob\nmark :2\n${data("klein: readme\n")}\ncommit refs/heads/main\nmark :3\nauthor ${WHO} 1772434800 +0100\ncommitter ${WHO} 1772434800 +0100\n${data("README.md und readme.md nebeneinander")}\n`;
    stream += "M 100644 :1 README.md\nM 100644 :2 readme.md\nM 100644 :1 Ordner/Datei.txt\nM 100644 :2 ordner/datei.txt\nM 100644 :1 normal.txt\n\n";
    ws.git(repo, ["-c", "core.ignorecase=false", "fast-import", "--quiet"], { input: Buffer.from(stream, "utf8") });
    ws.tryGit(repo, ["checkout", "-q", "-f", "main"]);
    const tracked = sorted(zlist(ws.git(repo, ["ls-files", "-z"], { raw: true }).toString("utf8")));
    equal(tracked, sorted(["README.md", "readme.md", "Ordner/Datei.txt", "ordner/datei.txt", "normal.txt"]), "fixture: five entries in the index");
    write(repo, "normal.txt", "GROSS: README\nund mehr\n");
    const seen = await coreLoop(t, app, ws, repo, { mutate: false });
    const { repoId } = seen.opened;
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    if (details.ok) equal(sorted(details.value.files.map((file) => file.path)), tracked, "commit details list both spellings");
    for (const name of ["README.md", "readme.md", "Ordner/Datei.txt", "ordner/datei.txt"]) {
      const read = await call(app, "file_read", { repoId, path: name, sha: head });
      const want = ws.git(repo, ["show", `HEAD:${name}`]);
      check(read.ok && read.value.text?.trim() === want, `file_read(HEAD, ${name}): expected ${JSON.stringify(want)}, got ${read.ok ? JSON.stringify(read.value.text) : `${read.code} ${read.message}`}`);
      const diff = await call(app, "diff_file", { repoId, path: name, source: { kind: "commit", sha: head } });
      check(diff.ok && diff.value.kind === "text" && diff.value.hunks[0]?.lines[0]?.text === want, `diff_file(HEAD, ${name}) shows the content of the right spelling: ${diff.ok ? JSON.stringify(diff.value.hunks?.[0]?.lines?.[0]?.text) : diff.message}`);
    }
    // Commit only normal.txt: the duplicate entries must not disappear.
    const stage = await call(app, "stage_paths", { repoId, paths: ["normal.txt"] });
    check(stage.ok, `stage_paths(normal.txt) fails: ${stage.code} ${stage.message}`);
    const commit = await call(app, "commit_create", { repoId, opId: "l2-n5", summary: "normal.txt ergänzt", description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(sorted(zlist(ws.git(repo, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], { raw: true }).toString("utf8"))), tracked, "git: the new commit still contains both spellings");
    equal(zlist(ws.git(repo, ["show", "--name-only", "--format=", "-z", "HEAD"], { raw: true }).toString("utf8")), ["normal.txt"], "git: the commit only changes normal.txt");
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("N6 UI: lists show the names, click opens the diff, stage by button", async () => {
    const ws = ws0("n6");
    const repo = buildNtfsNames(ws);
    const { repoId, tabId } = await app.openRepo(repo);
    await selectWip(app, tabId);
    await eventually(async () => (await app.page.locator('[data-section="unstaged"] [data-row-key]').count()) > 0, true, "the \"Unstaged\" list appears", 20_000);
    // The list is virtualized from 500 on; all 33 files are in the DOM.
    equal(sorted(await wipRows(app, "unstaged")), sorted(NTFS_NAMES), "\"Unstaged\" list shows every name");
    for (const name of ["-rf.txt", "--help", "emoji/🌦️ wetter 🚀.txt", "daten[1].txt", "nfd-über.txt", " führendes leerzeichen.txt", "ordner mit ' und &/unter ordner/datei (kopie) [2].txt"]) {
      const row = app.page.locator(`[data-section="unstaged"] [data-row-key=${JSON.stringify(name)}]`);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await eventually(() => app.page.evaluate((tab) => window.__gc.store.getState().views[tab]?.center ?? null, tabId), { kind: "diff", path: name, source: { kind: "unstaged" } }, `clicking ${JSON.stringify(name)} opens the diff`);
      await app.settle();
      await eventually(async () => (await app.page.locator('[data-screen="diff"]').innerText()).includes("dritte Zeile"), true, `the diff of ${JSON.stringify(name)} shows the new line`);
      await row.hover();
      await row.getByRole("button", { name: "Stage" }).click();
      await eventually(() => zlist(ws.git(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"], { raw: true }).toString("utf8")).includes(name), true, `git: ${JSON.stringify(name)} is staged after the click`);
    }
    equal((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error toast");
    // The visible text of a row contains the file name (not mangled).
    const shown = await app.page.locator('[data-section="staged"] [data-row-key]').evaluateAll((list) => list.map((item) => ({ key: item.dataset.rowKey, text: item.innerText })));
    for (const entry of shown) {
      const base = entry.key.slice(entry.key.lastIndexOf("/") + 1);
      check(entry.text.replace(/\s+/g, " ").includes(base.trim().replace(/\s+/g, " ")), `row of ${JSON.stringify(entry.key)} shows the name (text: ${JSON.stringify(entry.text)})`);
    }
    // Commit through the UI
    await app.page.locator("[data-commit-summary]").fill("Sieben Dateien mit Sonderzeichen über die Oberfläche");
    await app.page.keyboard.press("Control+Enter");
    await eventually(() => ws.git(repo, ["log", "-1", "--format=%s"]), "Sieben Dateien mit Sonderzeichen über die Oberfläche", "git: commit through the UI");
    equal(zlist(ws.git(repo, ["-c", "core.quotepath=false", "show", "--name-only", "--format=", "-z", "HEAD"], { raw: true }).toString("utf8")).length, 7, "git: seven files in the commit");
    // View commit: file list and diff in the UI
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    await selectCommit(app, tabId, head);
    await eventually(async () => sorted(await app.page.locator('[data-screen="commit-details"] [data-row-key]').evaluateAll((list) => list.map((item) => item.dataset.rowKey))).length, 7, "commit details show seven files");
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("N6 UI: Linux names (newline, tab, quotes) in lists and diff", async () => {
    const ws = ws0("n6b");
    const repo = buildLinuxNames(ws, { checkout: true });
    const { repoId, tabId } = await app.openRepo(repo);
    const root = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    await selectCommit(app, tabId, root);
    await eventually(async () => (await app.page.locator('[data-screen="commit-details"] [data-row-key]').count()) >= LINUX_NAMES.length, true, "commit details list the files", 20_000);
    const keys = await app.page.locator('[data-screen="commit-details"] [data-row-key]').evaluateAll((list) => list.map((item) => item.dataset.rowKey));
    equal(sorted(keys), sorted([...LINUX_NAMES, "normal.txt", "ordner/auch normal.txt"]), "commit details: every file has its row");
    // A row stays one row: a newline in the name must not break the list.
    const heights = await app.page.locator('[data-screen="commit-details"] [data-row-key]').evaluateAll((list) => list.map((item) => ({ key: item.dataset.rowKey, height: Math.round(item.getBoundingClientRect().height) })));
    const normal = heights.find((entry) => entry.key === "normal.txt")?.height;
    for (const entry of heights) check(entry.height === normal, `row ${JSON.stringify(entry.key)} is ${entry.height}px tall instead of ${normal}px`);
    for (const name of ["zeile\numbruch.txt", 'anf"zeichen.txt', "tab\tstopp.txt"]) {
      const row = app.page.locator('[data-screen="commit-details"] [data-row-key]').filter({ has: app.page.locator(":scope") }).nth(keys.indexOf(name));
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await eventually(() => app.page.evaluate((tab) => window.__gc.store.getState().views[tab]?.center?.path ?? null, tabId), name, `clicking ${JSON.stringify(name)} opens its diff`);
      await app.settle();
      await eventually(async () => (await app.page.locator('[data-screen="diff"]').innerText()).includes("hallo"), true, `the diff of ${JSON.stringify(name)} shows the content`);
    }
    await selectWip(app, tabId);
    await eventually(async () => (await wipRows(app, "unstaged")).length, LINUX_NAMES.length, "WIP: the unrepresentable files are listed as deleted");
    equal((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error toast");
    await closeRepo(app, { repoId, tabId });
  });
} catch (error) {
  t.check(false, `script aborted: ${error?.stack ?? error}`);
} finally {
  await app?.close().catch(() => undefined);
  for (const ws of spaces) ws.cleanup();
}
await sleep(50);
process.exit(t.finish());
