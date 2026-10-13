/**
 * Difficult repositories, part 2: FILE CONTENTS – in the real app, against real git.
 *
 *   node scripts/e2e/flows/hard-repos-content.mjs [--show] [--only <part>[,<part>]]
 *
 *   C1  line endings: CRLF, mixed, lone CR; core.autocrlf true / input / false; .gitattributes eol
 *   C2  encodings: Latin-1, UTF-16 LE/BE, Shift-JIS, UTF-8 with BOM, invalid UTF-8 – stage and discard
 *       hunks byte-exact
 *   C3  no newline at end, empty file, whitespace only
 *   C4  very large file (50 MB, text and binary)
 *   C5  very large diff (100,000 lines)
 *   C6  5000 changed files
 *   C7  binary files and images (also corrupt, SVG with script)
 *   C8  symlinks (in the index, core.symlinks=false) and mode changes (executable) – mode survives staging
 *   C9  file ↔ folder swapped
 *
 * At the end there is a list of green and red sections. Red sections with "BUG L2-…" are the tests
 * the respective bug is fixed against.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makePng } from "../fixtures.mjs";
import { healthy, call, closeRepo, coreLoop, coreStatusPaths, createRun, gitStatus, lines, sorted, toasts, wipRows, workspace, write, zlist, selectWip, selectCommit, sleep } from "./hard-repos-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("hard-repos-content", { argv });
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
const sha1 = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");
const bytes = (file) => fs.readFileSync(file);
/** Content of the index entry as a Buffer. */
const indexBlob = (ws, repo, rel) => ws.git(repo, ["cat-file", "blob", `:${rel}`], { raw: true });
const headBlob = (ws, repo, rel) => ws.git(repo, ["cat-file", "blob", `HEAD:${rel}`], { raw: true });
const indexMode = (ws, repo, rel) => ws.git(repo, ["ls-files", "-s", "--", rel]).split(/\s+/)[0];
const hex = (buffer) => buffer.toString("hex");
const commitArgs = (repoId, summary) => ({ repoId, opId: `l2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, summary, description: "", amend: false, skipHooks: false, pushAfter: false, stageAll: false });

/** Stages the whole hunk `index` of the file (unstaged diff). */
async function stageHunk(app, repoId, rel, index = 0, linesOnly = null) {
  const diff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
  if (!diff.ok) return diff;
  if (diff.value.kind !== "text") return { ok: false, code: "not_text", message: `diff kind ${diff.value.kind}` };
  return call(app, "stage_patch", { repoId, selection: { path: rel, hunks: [{ index, lines: linesOnly }], expect: diff.value.token } });
}
async function discardHunk(app, repoId, rel, index = 0, linesOnly = null) {
  const diff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
  if (!diff.ok) return diff;
  if (diff.value.kind !== "text") return { ok: false, code: "not_text", message: `diff kind ${diff.value.kind}` };
  return call(app, "discard_patch", { repoId, selection: { path: rel, hunks: [{ index, lines: linesOnly }], expect: diff.value.token } });
}

/** `count` lines of sample text. */
const textLines = (count, prefix = "Zeile") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}: Messwert ${(index * 37) % 101}`);

try {

  // ---------------------------------------------------------------------------------------------
  for (const mode of ["true", "input", "false"]) {
    await section(`C1 core.autocrlf=${mode}: CRLF, LF and mixed files through the core loop`, async () => {
      const ws = ws0(`c1-${mode}`);
      const repo = ws.init(`zeilenenden-${mode}`, { config: { "core.autocrlf": mode } });
      const base = textLines(40);
      // The repository holds LF (depending on the setting); the test deliberately writes different endings to the working tree.
      write(repo, "crlf.txt", `${base.join("\r\n")}\r\n`);
      write(repo, "lf.txt", `${base.join("\n")}\n`);
      write(repo, "gemischt.txt", base.map((line, index) => line + (index % 3 === 0 ? "\r\n" : "\n")).join(""));
      write(repo, "nur-cr.txt", `${base.slice(0, 5).join("\r")}\r`);
      ws.commit(repo, "Dateien mit verschiedenen Zeilenenden");
      const change = (lineEnd) => (line, index) => (index === 4 ? `${line} GEÄNDERT` : line) + (typeof lineEnd === "function" ? lineEnd(index) : lineEnd);
      write(repo, "crlf.txt", base.map(change("\r\n")).join(""));
      write(repo, "lf.txt", base.map(change("\n")).join(""));
      write(repo, "gemischt.txt", base.map(change((index) => (index % 3 === 0 ? "\r\n" : "\n"))).join(""));
      const { repoId, tabId } = await app.openRepo(repo);
      const status = await call(app, "status_get", { repoId });
      check(status.ok, `status_get fails: ${status.code} ${status.message}`);
      if (status.ok) equal(coreStatusPaths(status.value), gitStatus(ws, repo), "status as in git status");
      for (const rel of ["crlf.txt", "lf.txt", "gemischt.txt"]) {
        const diff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
        if (!check(diff.ok && diff.value.kind === "text", `diff_file(${rel}): ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`)) continue;
        const changed = diff.value.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context");
        equal(changed.map((line) => `${line.kind}:${line.text.replace(/\r$/, "")}`), [`remove:${base[4]}`, `add:${base[4]} GEÄNDERT`], `${rel}: the diff shows exactly one changed line`);
        // Stage hunk: afterwards the index has exactly the content `git add` would produce.
        const staged = await stageHunk(app, repoId, rel);
        check(staged.ok, `stage_patch(${rel}) fails: ${staged.code} ${staged.message}`);
        const got = indexBlob(ws, repo, rel);
        const expected = ws.git(repo, ["hash-object", "--path", rel, "--", rel]);
        equal(sha1(Buffer.concat([Buffer.from(`blob ${got.length}\0`), got])), expected, `${rel}: index blob after staging as from git add (${got.length} bytes)`);
        check(gitStatus(ws, repo).unstaged.includes(rel) === false, `${rel}: no longer unstaged after staging the only hunk`);
      }
      const commit = await call(app, "commit_create", commitArgs(repoId, `Zeile 5 geändert (autocrlf=${mode})`));
      check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
      equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after the commit");
      // Discarding a hunk leaves the line endings of the rest of the file untouched.
      // (With autocrlf=true/input that is the separate section for BUG L2-04.)
      for (const rel of mode === "false" ? ["crlf.txt", "gemischt.txt"] : []) {
        const before = bytes(path.join(repo, rel));
        const text = before.toString("utf8");
        fs.writeFileSync(path.join(repo, rel), text.replace("Zeile 30:", "Zeile 30 NEU:"));
        const discarded = await discardHunk(app, repoId, rel);
        check(discarded.ok, `discard_patch(${rel}) fails: ${discarded.code} ${discarded.message}`);
        equal(hex(bytes(path.join(repo, rel))) === hex(before), true, `${rel}: byte-identical to the previous state after discarding`);
      }
      // New file with CRLF: stage, commit – the repository holds what git add would store.
      write(repo, "neu-crlf.txt", "eins\r\nzwei\r\ndrei\r\n");
      const expectedNew = ws.git(repo, ["hash-object", "--path", "neu-crlf.txt", "--", "neu-crlf.txt"]);
      const add = await call(app, "stage_paths", { repoId, paths: ["neu-crlf.txt"] });
      check(add.ok, `stage_paths(neu-crlf.txt) fails: ${add.code} ${add.message}`);
      equal(ws.git(repo, ["rev-parse", ":neu-crlf.txt"]), expectedNew, "neu-crlf.txt: index blob as from git add");
      const lone = await call(app, "diff_file", { repoId, path: "nur-cr.txt", source: { kind: "commit", sha: ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]) } });
      check(lone.ok, `diff_file(nur-cr.txt, commit) fails: ${lone.code} ${lone.message}`);
      equal((await toasts(app)).filter((toast) => toast.tone === "danger"), [], "no error toast");
      await closeRepo(app, { repoId, tabId });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // BUG L2-04: "Discard hunk" rewrites the WHOLE file with the line endings a checkout would produce –
  // instead of reverting only that one hunk. With core.autocrlf=input a CRLF file in the working tree
  // loses all CRs (631 → 591 bytes), with autocrlf=true a file with mixed endings becomes CRLF
  // throughout. With autocrlf=false everything stays byte-identical (green, above).
  for (const [mode, rel] of [["input", "crlf.txt"], ["input", "gemischt.txt"], ["true", "gemischt.txt"]]) {
    await section(`C1 Discarding a hunk leaves the other line endings untouched (autocrlf=${mode}, ${rel})`, async () => {
      const ws = ws0("c1e");
      const repo = ws.init(`verwerfen-${mode}`, { config: { "core.autocrlf": mode } });
      const base = textLines(40);
      write(repo, "crlf.txt", `${base.join("\r\n")}\r\n`);
      write(repo, "gemischt.txt", base.map((line, index) => line + (index % 3 === 0 ? "\r\n" : "\n")).join(""));
      ws.commit(repo, "Dateien mit CRLF und gemischten Enden");
      const before = bytes(path.join(repo, rel));
      fs.writeFileSync(path.join(repo, rel), before.toString("utf8").replace("Zeile 30:", "Zeile 30 NEU:"));
      const { repoId, tabId } = await app.openRepo(repo);
      const discarded = await discardHunk(app, repoId, rel);
      check(discarded.ok, `discard_patch(${rel}) fails: ${discarded.code} ${discarded.message}`);
      const after = bytes(path.join(repo, rel));
      const count = (buffer) => {
        const text = buffer.toString("latin1");
        const crlf = (text.match(/\r\n/g) ?? []).length;
        return { crlf, lf: (text.match(/\n/g) ?? []).length - crlf, bytes: buffer.length };
      };
      equal(count(after), count(before), `${rel}: line endings after discarding a hunk as before`);
      check(after.equals(before), `${rel}: file byte-identical to the state before the change after discarding`);
      await closeRepo(app, { repoId, tabId });
    }, { bug: "L2-04" });
  }

  // ---------------------------------------------------------------------------------------------
  // BUG L2-06: If git refuses staging because of core.safecrlf=true, the app only shows a generic
  // "git add failed (exit code 128)" with code `unknown` – the reason
  // ("CRLF would be replaced by LF in …") is only in the raw output.
  await section("C1 core.safecrlf=true: refused staging names file and reason", async () => {
    const ws = ws0("c1f");
    const repo = ws.init("safecrlf", { config: { "core.autocrlf": "true", "core.safecrlf": "true" } });
    write(repo, "start.txt", "eins\r\n");
    ws.commit(repo, "Start");
    write(repo, "gemischt.txt", "eins\r\nzwei\ndrei\r\n");
    write(repo, "gut.txt", "eins\r\nzwei\r\n");
    const { repoId, tabId } = await app.openRepo(repo);
    const add = await call(app, "stage_paths", { repoId, paths: ["gemischt.txt"] });
    check(!add.ok, "fixture: git refuses staging");
    check(add.code !== "unknown", `error code is ${add.code}`);
    check(/gemischt\.txt/.test(add.message) && /line ending|CRLF|LF/i.test(add.message), `the message names file and reason: ${JSON.stringify(add.message)}`);
    // "Stage all" must not fail entirely on that one file without saying why.
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok || /gemischt\.txt/.test(all.message), `stage_paths(all): ${all.code} – ${all.message}`);
    await closeRepo(app, { repoId, tabId });
  }, { bug: "L2-06" });

  // ---------------------------------------------------------------------------------------------
  await section("C1 .gitattributes eol=lf over CRLF in the repository (\"forever modified\")", async () => {
    const ws = ws0("c1d");
    const repo = ws.init("normalisierung");
    write(repo, "alt.txt", "eins\r\nzwei\r\ndrei\r\n");
    ws.commit(repo, "Datei mit CRLF im Repository");
    write(repo, ".gitattributes", "*.txt text eol=lf\n");
    ws.commit(repo, "Attribute nachträglich");
    // Change the timestamp so git compares the file again.
    fs.utimesSync(path.join(repo, "alt.txt"), new Date(), new Date(Date.now() + 5000));
    const want = gitStatus(ws, repo);
    const seen = await coreLoop(t, app, ws, repo, { summary: "Zeilenenden normalisiert" });
    note(`git status before the loop: ${JSON.stringify(want)}`);
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  const ENCODINGS = [
    { name: "latin1.txt", encode: (text) => Buffer.from(text, "latin1"), sample: "Größe: 20 °C – nein: 20 °C, Überhöhung" .replace("–", "-") },
    { name: "sjis.txt", encode: (text) => sjis(text), sample: "日本語のテキスト" },
    { name: "utf8-bom.txt", encode: (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]), sample: "Größe mit BOM" },
    { name: "kaputt-utf8.txt", encode: (text) => Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0x0a, 0xc3, 0x28, 0xff, 0xfe, 0x41, 0x0a])]), sample: "gültig, dann ungültige Bytes" },
  ];
  /** Tiny Shift-JIS encoder for the few characters of the test (ASCII stays). */
  function sjis(text) {
    const table = { "日": [0x93, 0xfa], "本": [0x96, 0x7b], "語": [0x8c, 0xea], "の": [0x82, 0xcc], "テ": [0x83, 0x65], "キ": [0x83, 0x4c], "ス": [0x83, 0x58], "ト": [0x83, 0x67] };
    return Buffer.from([...text].flatMap((char) => table[char] ?? [char.charCodeAt(0) & 0x7f]));
  }

  await section("C2 Encodings (Latin-1, Shift-JIS, UTF-8 with BOM, invalid UTF-8): stage and discard hunks byte-exact", async () => {
    const ws = ws0("c2");
    const repo = ws.init("kodierungen");
    const body = (sample, extra = "") => [...Array.from({ length: 12 }, (_, index) => `${index + 1}: ${sample}`), extra].filter(Boolean).join("\n") + "\n";
    for (const entry of ENCODINGS) fs.writeFileSync(path.join(repo, entry.name), entry.encode(body(entry.sample)));
    ws.commit(repo, "Dateien in verschiedenen Kodierungen");
    const changed = {};
    for (const entry of ENCODINGS) {
      const next = entry.encode(body(entry.sample).replace(`3: ${entry.sample}`, `3: ${entry.sample} XX`).replace(`10: ${entry.sample}`, `10: ${entry.sample} YY`));
      fs.writeFileSync(path.join(repo, entry.name), next);
      changed[entry.name] = next;
    }
    const { repoId, tabId } = await app.openRepo(repo);
    for (const entry of ENCODINGS) {
      const diff = await call(app, "diff_file", { repoId, path: entry.name, source: { kind: "unstaged" } });
      if (!check(diff.ok && diff.value.kind === "text", `diff_file(${entry.name}): ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`)) continue;
      note(`${entry.name}: detected encoding ${diff.value.encoding}, ${diff.value.hunks.length} Hunk(s)`);
      const original = headBlob(ws, repo, entry.name);
      // Stage only the first change (line 3). The index must be byte-exact "original + new line 3".
      const firstAdd = diff.value.hunks[0].lines.findIndex((line) => line.kind === "add");
      const firstRemove = diff.value.hunks[0].lines.findIndex((line) => line.kind === "remove");
      const staged = await call(app, "stage_patch", { repoId, selection: { path: entry.name, hunks: [{ index: 0, lines: [firstRemove, firstAdd] }], expect: diff.value.token } });
      if (check(staged.ok, `stage_patch(${entry.name}, line 3) fails: ${staged.code} ${staged.message}`)) {
        const wantIndex = entry.encode(body(entry.sample).replace(`3: ${entry.sample}`, `3: ${entry.sample} XX`));
        equal(hex(indexBlob(ws, repo, entry.name)), hex(wantIndex), `${entry.name}: index byte-exact after line staging`);
      }
      equal(hex(bytes(path.join(repo, entry.name))), hex(changed[entry.name]), `${entry.name}: working tree untouched by staging`);
      // Discard the rest: afterwards the file matches the index byte-exactly.
      const discard = await discardHunk(app, repoId, entry.name);
      if (check(discard.ok, `discard_patch(${entry.name}) fails: ${discard.code} ${discard.message}`)) {
        equal(hex(bytes(path.join(repo, entry.name))), hex(indexBlob(ws, repo, entry.name)), `${entry.name}: byte-identical to the index after discarding`);
      }
      void original;
    }
    const commit = await call(app, "commit_create", commitArgs(repoId, "Zeile 3 in jeder Kodierung"));
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after the commit");
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C2 UTF-16 (LE/BE, with BOM): view, read, stage, commit", async () => {
    const ws = ws0("c2b");
    const repo = ws.init("utf16");
    const text = (extra = "") => `Größe in °C\r\nzweite Zeile\r\n${extra}`;
    const le = (value) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
    const be = (value) => {
      const swapped = Buffer.from(value, "utf16le");
      swapped.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
    };
    fs.writeFileSync(path.join(repo, "utf16le.txt"), le(text()));
    fs.writeFileSync(path.join(repo, "utf16be.txt"), be(text()));
    ws.commit(repo, "UTF-16-Dateien");
    fs.writeFileSync(path.join(repo, "utf16le.txt"), le(text("dritte Zeile\r\n")));
    fs.writeFileSync(path.join(repo, "utf16be.txt"), be(text("dritte Zeile\r\n")));
    const seenBefore = { le: bytes(path.join(repo, "utf16le.txt")) };
    const { repoId, tabId } = await app.openRepo(repo);
    for (const rel of ["utf16le.txt", "utf16be.txt"]) {
      const read = await call(app, "file_read", { repoId, path: rel, sha: null });
      check(read.ok && read.value.text?.includes("Größe in °C") && read.value.text.includes("dritte Zeile"), `file_read(${rel}): ${read.ok ? `${read.value.encoding} binary=${read.value.isBinary} ${JSON.stringify(read.value.text?.slice(0, 40))}` : `${read.code} ${read.message}`}`);
      const diff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
      check(diff.ok, `diff_file(${rel}) fails: ${diff.code} ${diff.message}`);
      if (diff.ok) note(`${rel}: diff kind ${diff.value.kind}${diff.value.kind === "text" ? `, encoding ${diff.value.encoding}, ${diff.value.hunks.length} Hunk(s)` : ""}`);
      if (diff.ok && diff.value.kind === "text" && diff.value.hunks.length) {
        const added = diff.value.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").map((line) => line.text.replace(/\r$/, ""));
        check(added.includes("dritte Zeile"), `${rel}: the diff shows the new line readably (added: ${JSON.stringify(added).slice(0, 200)})`);
        const staged = await stageHunk(app, repoId, rel);
        check(staged.ok, `stage_patch(${rel}) fails: ${staged.code} ${staged.message}`);
        const expected = ws.git(repo, ["hash-object", "--path", rel, "--", rel]);
        equal(ws.git(repo, ["rev-parse", `:${rel}`]), expected, `${rel}: index blob after hunk staging as from git add`);
      }
    }
    equal(hex(bytes(path.join(repo, "utf16le.txt"))), hex(seenBefore.le), "utf16le.txt unchanged in the working tree");
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok, `stage_paths(all) fails: ${all.code} ${all.message}`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "Dritte Zeile in UTF-16"));
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after the commit");
    // Editor: writing UTF-16 LE keeps BOM and encoding
    const written = await call(app, "file_write", { repoId, path: "utf16le.txt", content: "Größe in °C\r\nvom Editor\r\n", encoding: "utf-16le", eol: "crlf" });
    check(written.ok, `file_write(utf-16le) fails: ${written.code} ${written.message}`);
    if (written.ok) {
      const now = bytes(path.join(repo, "utf16le.txt"));
      const back = await call(app, "file_read", { repoId, path: "utf16le.txt", sha: null });
      check(back.ok && back.value.text === "Größe in °C\r\nvom Editor\r\n".replace(/\r\n/g, back.value.text?.includes("\r\n") ? "\r\n" : "\n"), `file_read after file_write(utf-16le): ${back.ok ? JSON.stringify(back.value.text) : back.message} (bytes: ${hex(now).slice(0, 40)}…)`);
    }
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-05: For a file with `working-tree-encoding=UTF-16LE-BOM` (git treats it as text and shows an
  // ordinary text diff), diff_file returns "binary" for the working tree. The status of the same file
  // says isBinary=false with +1 line, and the commit diff is text – only the local changes cannot be
  // viewed or staged hunk by hunk.
  await section("C2 UTF-16 with working-tree-encoding: local change as text diff, stage hunk", async () => {
    const ws = ws0("c2c");
    const repo = ws.init("utf16-attribut");
    const le = (value) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
    fs.writeFileSync(path.join(repo, "utf16-attr.txt"), le("Größe in °C\r\nzweite Zeile\r\n"));
    write(repo, ".gitattributes", "utf16-attr.txt text working-tree-encoding=UTF-16LE-BOM eol=crlf\n");
    ws.commit(repo, "UTF-16-Datei mit Attribut");
    fs.writeFileSync(path.join(repo, "utf16-attr.txt"), le("Größe in °C\r\nzweite Zeile\r\ndritte Zeile\r\n"));
    const before = bytes(path.join(repo, "utf16-attr.txt"));
    equal(ws.git(repo, ["diff", "--numstat"]), "1\t0\tutf16-attr.txt", "fixture: git shows a text diff with one new line");
    const { repoId, tabId } = await app.openRepo(repo);
    const status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.unstaged[0]?.isBinary === false && status.value.unstaged[0]?.added === 1, `status: not binary, +1 line (${status.ok ? JSON.stringify(status.value.unstaged[0]) : status.message})`);
    const diff = await call(app, "diff_file", { repoId, path: "utf16-attr.txt", source: { kind: "unstaged" } });
    check(diff.ok && diff.value.kind === "text", `diff_file(unstaged): kind ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`} instead of text`);
    if (diff.ok && diff.value.kind === "text") {
      equal(diff.value.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").map((line) => line.text.replace(/\r$/, "")), ["dritte Zeile"], "the diff shows the new line");
      const staged = await stageHunk(app, repoId, "utf16-attr.txt");
      check(staged.ok, `stage_patch fails: ${staged.code} ${staged.message}`);
      equal(ws.git(repo, ["rev-parse", ":utf16-attr.txt"]), ws.git(repo, ["hash-object", "--path", "utf16-attr.txt", "--", "utf16-attr.txt"]), "index after hunk staging as from git add");
    }
    equal(hex(bytes(path.join(repo, "utf16-attr.txt"))), hex(before), "working tree unchanged");
    await closeRepo(app, { repoId, tabId });
  }, { bug: "L2-05" });

  // ---------------------------------------------------------------------------------------------
  await section("C3 No newline at end, empty file, whitespace only: diff, stage hunk, discard", async () => {
    const ws = ws0("c3");
    const repo = ws.init("randfaelle");
    write(repo, "ohne-ende.txt", "eins\nzwei\ndrei");
    write(repo, "mit-ende.txt", "eins\nzwei\ndrei\n");
    write(repo, "leer.txt", "");
    write(repo, "wird-leer.txt", "eins\nzwei\n");
    write(repo, "nur-leerraum.txt", "   \n\t\n\n");
    write(repo, "eine-zeile-ohne-ende.txt", "x");
    ws.commit(repo, "Randfälle");
    write(repo, "ohne-ende.txt", "eins\nzwei\ndrei\nvier");
    write(repo, "mit-ende.txt", "eins\nzwei\ndrei");
    write(repo, "leer.txt", "nicht mehr leer\n");
    write(repo, "wird-leer.txt", "");
    write(repo, "nur-leerraum.txt", "\n\n\n   ");
    write(repo, "eine-zeile-ohne-ende.txt", "x\n");
    write(repo, "neu-leer.txt", "");
    write(repo, "neu-ohne-ende.txt", "kein Ende");
    const files = ["ohne-ende.txt", "mit-ende.txt", "leer.txt", "wird-leer.txt", "nur-leerraum.txt", "eine-zeile-ohne-ende.txt"];
    const { repoId, tabId } = await app.openRepo(repo);
    const status = await call(app, "status_get", { repoId });
    if (status.ok) equal(coreStatusPaths(status.value), gitStatus(ws, repo), "status as in git status");
    for (const rel of files) {
      const expected = ws.git(repo, ["hash-object", "--path", rel, "--", rel]);
      const diff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
      if (!check(diff.ok && diff.value.kind === "text" && diff.value.hunks.length >= 1, `diff_file(${rel}): ${diff.ok ? `${diff.value.kind}, ${diff.value.hunks?.length} Hunks` : `${diff.code} ${diff.message}`}`)) continue;
      const selection = { path: rel, hunks: diff.value.hunks.map((hunk) => ({ index: hunk.index, lines: null })), expect: diff.value.token };
      const staged = await call(app, "stage_patch", { repoId, selection });
      check(staged.ok, `stage_patch(${rel}) fails: ${staged.code} ${staged.message}`);
      equal(ws.git(repo, ["rev-parse", `:${rel}`]), expected, `${rel}: index after hunk staging as from git add`);
      // and back out of the index
      const stagedDiff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "staged" } });
      if (check(stagedDiff.ok && stagedDiff.value.kind === "text", `diff_file(staged, ${rel}): ${stagedDiff.ok ? stagedDiff.value.kind : stagedDiff.message}`)) {
        const un = await call(app, "unstage_patch", { repoId, selection: { path: rel, hunks: stagedDiff.value.hunks.map((hunk) => ({ index: hunk.index, lines: null })), expect: stagedDiff.value.token } });
        check(un.ok, `unstage_patch(${rel}) fails: ${un.code} ${un.message}`);
        equal(ws.git(repo, ["rev-parse", `:${rel}`]), ws.git(repo, ["rev-parse", `HEAD:${rel}`]), `${rel}: index back to HEAD after unstaging`);
      }
      // discard: file byte-identical to HEAD
      const again = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
      if (again.ok && again.value.kind === "text") {
        const gone = await call(app, "discard_patch", { repoId, selection: { path: rel, hunks: again.value.hunks.map((hunk) => ({ index: hunk.index, lines: null })), expect: again.value.token } });
        check(gone.ok, `discard_patch(${rel}) fails: ${gone.code} ${gone.message}`);
        equal(hex(bytes(path.join(repo, rel))), hex(headBlob(ws, repo, rel)), `${rel}: byte-identical to HEAD after discarding`);
      }
    }
    for (const rel of ["neu-leer.txt", "neu-ohne-ende.txt"]) {
      const diff = await call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } });
      check(diff.ok, `diff_file(${rel}, untracked) fails: ${diff.code} ${diff.message}`);
    }
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok, `stage_paths(all) fails: ${all.code} ${all.message}`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "Leere Dateien dazu"));
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(sorted(lines(ws.git(repo, ["show", "--name-only", "--format=", "HEAD"]))), ["neu-leer.txt", "neu-ohne-ende.txt"], "git: the commit contains the empty file and the file without final newline");
    // UI: the diff of an empty new file shows a hint instead of nothing
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    await selectCommit(app, tabId, head);
    const row = app.page.locator('[data-screen="commit-details"] [data-row-key="neu-leer.txt"]');
    await row.click();
    await app.settle();
    await eventually(async () => ((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")) ?? "").trim().length > 0, true, "UI: the diff of the empty file shows some text (no empty area)");
    note(`diff view of the empty file: ${JSON.stringify((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160))}`);
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C4 Very large file (50 MB text, 50 MB binary): status, diff, stage, commit, view", async () => {
    const ws = ws0("c4");
    const repo = ws.init("grosse-datei");
    write(repo, "README.md", "klein\n");
    ws.commit(repo, "Start");
    const line = `${"messwert;".repeat(11)}ende\n`; // 104 Bytes
    const chunk = Buffer.from(line.repeat(10_000));
    const fd = fs.openSync(path.join(repo, "gross.csv"), "w");
    for (let written = 0; written < 50 * 1024 * 1024; written += chunk.length) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    const random = crypto.randomBytes(1024 * 1024);
    const fdBin = fs.openSync(path.join(repo, "gross.bin"), "w");
    for (let index = 0; index < 50; index++) fs.writeSync(fdBin, random);
    fs.closeSync(fdBin);
    const timed = async (label, run, limitMs) => {
      const started = Date.now();
      const result = await run();
      const ms = Date.now() - started;
      note(`${label}: ${ms} ms`);
      check(ms < limitMs, `${label} takes ${ms} ms (limit ${limitMs} ms)`);
      return result;
    };
    const { repoId, tabId } = await app.openRepo(repo);
    const status = await timed("status_get with two untracked 50 MB files", () => call(app, "status_get", { repoId }), 15_000);
    check(status.ok, `status_get fails: ${status.code} ${status.message}`);
    if (status.ok) equal(sorted(status.value.unstaged.map((file) => `${file.path}:${file.isBinary}`)), ["gross.bin:true", "gross.csv:false"], "both files in the status, binary detected");
    for (const rel of ["gross.csv", "gross.bin"]) {
      const diff = await timed(`diff_file(${rel})`, () => call(app, "diff_file", { repoId, path: rel, source: { kind: "unstaged" } }), 15_000);
      check(diff.ok && ["too_large", "binary"].includes(diff.value.kind), `diff_file(${rel}): ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`);
      const read = await timed(`file_read(${rel})`, () => call(app, "file_read", { repoId, path: rel, sha: null }), 15_000);
      check(read.ok ? read.value.text === null || read.value.text.length < 6 * 1024 * 1024 : read.code !== "unknown", `file_read(${rel}): ${read.ok ? `text with ${read.value.text?.length} chars` : `${read.code} ${read.message}`}`);
    }
    // UI: clicking the large file freezes nothing
    await selectWip(app, tabId);
    await eventually(async () => (await wipRows(app, "unstaged")).length, 2, "UI: both files in the list", 20_000);
    const started = Date.now();
    await app.page.locator('[data-section="unstaged"] [data-row-key="gross.csv"]').click();
    await app.settle(60_000);
    await eventually(async () => ((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")) ?? "").trim().length > 0, true, "UI: diff view of the 50 MB file shows something", 30_000);
    note(`UI: click on gross.csv until shown ${Date.now() - started} ms; text: ${JSON.stringify((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 140))}`);
    const alive = await Promise.race([app.page.evaluate(() => 1 + 1), sleep(5000).then(() => "hangs")]);
    equal(alive, 2, "UI responds after opening the large file");
    const staged = await timed("stage_paths(both 50 MB files)", () => call(app, "stage_paths", { repoId, paths: null }), 120_000);
    check(staged.ok, `stage_paths fails: ${staged.code} ${staged.message}`);
    const commit = await timed("commit_create", () => call(app, "commit_create", commitArgs(repoId, "Zwei sehr große Dateien")), 60_000);
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const details = await timed("commit_details(commit with 100 MB)", () => call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } }), 30_000);
    check(details.ok && details.value.files.length === 2, `commit_details: ${details.ok ? details.value.files.length : details.message}`);
    // Change the large file: one line in the middle
    const big = path.join(repo, "gross.csv");
    const handle = fs.openSync(big, "r+");
    fs.writeSync(handle, Buffer.from("GEAENDERT"), 0, 9, 25 * 1024 * 1024 - ((25 * 1024 * 1024) % 104));
    fs.closeSync(handle);
    const status2 = await timed("status_get after changing the 50 MB file", () => call(app, "status_get", { repoId }), 30_000);
    check(status2.ok && status2.value.unstaged.length === 1, `status_get: ${status2.ok ? JSON.stringify(status2.value.unstaged.map((file) => file.path)) : status2.message}`);
    const diff2 = await timed("diff_file(changed 50 MB file)", () => call(app, "diff_file", { repoId, path: "gross.csv", source: { kind: "unstaged" } }), 30_000);
    check(diff2.ok, `diff_file fails: ${diff2.code} ${diff2.message}`);
    if (diff2.ok) note(`diff of the changed 50 MB file: ${diff2.value.kind}`);
    const forced = await timed("diff_file(force) of the changed 50 MB file", () => call(app, "diff_file", { repoId, path: "gross.csv", source: { kind: "unstaged" }, force: true }), 60_000);
    check(forced.ok ? JSON.stringify(forced.value).length < 20 * 1024 * 1024 : forced.code !== "unknown", `diff_file(force): ${forced.ok ? `${forced.value.kind}, ${JSON.stringify(forced.value).length} chars` : `${forced.code} ${forced.message}`}`);
    const discard = await timed("discard_paths(50 MB file)", () => call(app, "discard_paths", { repoId, paths: ["gross.csv"] }), 120_000);
    check(discard.ok, `discard_paths fails: ${discard.code} ${discard.message}`);
    const undo = await timed("undo(discard of the 50 MB file)", () => call(app, "undo", { repoId }), 120_000);
    check(undo.ok, `undo fails: ${undo.code} ${undo.message}`);
    check(fs.readFileSync(big).subarray(25 * 1024 * 1024 - ((25 * 1024 * 1024) % 104)).subarray(0, 9).toString() === "GEAENDERT", "undo brings back the change to the 50 MB file");
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C5 Very large diff (100,000 lines): core and UI stay usable", async () => {
    const ws = ws0("c5");
    const repo = ws.init("grosser-diff");
    const make = (suffix) => Array.from({ length: 100_000 }, (_, index) => `Zeile ${index + 1};${(index * 7919) % 10007};${suffix}`).join("\n") + "\n";
    write(repo, "reihe.csv", make("alt"));
    ws.commit(repo, "100 000 Zeilen");
    write(repo, "reihe.csv", make("neu"));
    const { repoId, tabId } = await app.openRepo(repo);
    let started = Date.now();
    const status = await call(app, "status_get", { repoId });
    note(`status_get: ${Date.now() - started} ms`);
    check(status.ok && status.value.unstaged[0]?.added === 100_000 && status.value.unstaged[0]?.removed === 100_000, `status counts 100,000 added and removed lines: ${status.ok ? JSON.stringify(status.value.unstaged[0]) : status.message}`);
    started = Date.now();
    const diff = await call(app, "diff_file", { repoId, path: "reihe.csv", source: { kind: "unstaged" } });
    note(`diff_file: ${Date.now() - started} ms, kind ${diff.ok ? diff.value.kind : diff.code}`);
    check(diff.ok && diff.value.kind === "too_large", `diff_file without force: ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`);
    // UI: click the file → "too large" hint; "Load anyway" must not freeze the app
    await selectWip(app, tabId);
    await app.page.locator('[data-section="unstaged"] [data-row-key="reihe.csv"]').click();
    await app.settle(60_000);
    const view = app.page.locator('[data-screen="diff"]');
    await eventually(async () => ((await view.innerText().catch(() => "")) ?? "").trim().length > 0, true, "UI: hint in the diff view");
    const hint = (await view.innerText()).replace(/\s+/g, " ");
    note(`diff view: ${JSON.stringify(hint.slice(0, 200))}`);
    const load = view.getByRole("button", { name: /load|show/i }).first();
    if (check((await load.count()) > 0, "UI: there is a button to load the large diff anyway")) {
      started = Date.now();
      await load.click();
      // If the page does not respond for 20 s, it counts as frozen.
      const alive = async () =>
        Promise.race([
          app.page.evaluate(() => {
            const root = document.querySelector('[data-screen="diff"]');
            return { shown: /Hunk 1 of 1/.test(root?.innerText ?? ""), nodes: root?.querySelectorAll("*").length ?? 0 };
          }),
          sleep(20_000).then(() => "hangs"),
        ]);
      let seen = await alive();
      const deadline = Date.now() + 90_000;
      while (seen !== "hangs" && !seen.shown && Date.now() < deadline) {
        await sleep(250);
        seen = await alive();
      }
      note(`UI: large diff visible after ${Date.now() - started} ms (${JSON.stringify(seen)})`);
      check(seen !== "hangs" && seen.shown, `UI: the large diff appears (${JSON.stringify(seen)})`);
      check(seen !== "hangs" && seen.nodes < 5000, `UI: the large diff is virtualized (${seen.nodes} elements in the DOM)`);
      check(Date.now() - started < 30_000, `UI: "Load anyway" takes ${Date.now() - started} ms`);
      // Scrolling to the end responds
      const frame = await Promise.race([app.page.evaluate(() => new Promise((resolve) => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0))); })), sleep(10_000).then(() => "hangs")]);
      check(frame !== "hangs" && frame < 1000, `UI: two frames after loading take ${frame} ms`);
    }
    started = Date.now();
    const staged = await call(app, "stage_paths", { repoId, paths: ["reihe.csv"] });
    note(`stage_paths: ${Date.now() - started} ms`);
    check(staged.ok, `stage_paths fails: ${staged.code} ${staged.message}`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "Alle Zeilen geändert"));
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    started = Date.now();
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    note(`commit_details: ${Date.now() - started} ms`);
    check(details.ok && details.value.added === 100_000, `commit_details counts 100,000 lines: ${details.ok ? details.value.added : details.message}`);
    // Stage a hunk in a file with 100,000 lines, one change in the middle
    const text = fs.readFileSync(path.join(repo, "reihe.csv"), "utf8").replace("Zeile 50000;", "Zeile 50000 GEÄNDERT;");
    write(repo, "reihe.csv", text);
    started = Date.now();
    // The file is over 1 MB: the diff only comes as text with `force`.
    const forced = await call(app, "diff_file", { repoId, path: "reihe.csv", source: { kind: "unstaged" }, force: true });
    const hunk = forced.ok && forced.value.kind === "text" ? await call(app, "stage_patch", { repoId, selection: { path: "reihe.csv", hunks: [{ index: 0, lines: null }], expect: forced.value.token } }) : { ok: false, code: forced.code ?? forced.value?.kind, message: forced.message ?? "no text diff" };
    note(`diff_file(force) and stage_patch in 100,000 lines: ${Date.now() - started} ms`);
    check(hunk.ok, `stage_patch fails: ${hunk.code} ${hunk.message}`);
    equal(ws.git(repo, ["rev-parse", ":reihe.csv"]), ws.git(repo, ["hash-object", "reihe.csv"]), "git: index after hunk staging matches the file");
    started = Date.now();
    const blame = await call(app, "file_blame", { repoId, path: "reihe.csv", sha: head });
    note(`file_blame(100,000 lines): ${Date.now() - started} ms, ${blame.ok ? blame.value.length : blame.code}`);
    check(blame.ok && blame.value.length === 100_000, `file_blame: ${blame.ok ? blame.value.length : `${blame.code} ${blame.message}`}`);
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C6 5000 changed files (3000 modified, 1000 deleted, 1000 new): status, list, stage all, commit", async () => {
    const ws = ws0("c6");
    const repo = ws.init("viele-aenderungen");
    const who = "Lena Hartmann <lena.hartmann@wetterstation.example>";
    const file = (index) => `daten/jahr-${2000 + (index % 20)}/station-${String(index % 25).padStart(2, "0")}/reihe-${String(index).padStart(4, "0")}.csv`;
    let stream = "";
    let tree = "";
    for (let index = 0; index < 4000; index++) {
      const content = `datum;wert\n2026-01-01;${index}\n`;
      tree += `M 100644 inline ${file(index)}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    }
    stream += `commit refs/heads/main\nmark :1\nauthor ${who} 1772434800 +0100\ncommitter ${who} 1772434800 +0100\ndata 15\n4000 Messreihen\n${tree}\n`;
    ws.git(repo, ["fast-import", "--quiet"], { input: Buffer.from(stream, "utf8") });
    ws.git(repo, ["checkout", "-q", "-f", "main"]);
    for (let index = 0; index < 3000; index++) fs.appendFileSync(path.join(repo, file(index)), `2026-01-02;${index * 2}\n`);
    for (let index = 3000; index < 4000; index++) fs.rmSync(path.join(repo, file(index)));
    for (let index = 4000; index < 5000; index++) write(repo, file(index), `datum;wert\nneu;${index}\n`);
    const want = gitStatus(ws, repo);
    equal(want.unstaged.length, 5000, "fixture: 5000 changes according to git");
    const { repoId, tabId } = await app.openRepo(repo);
    let started = Date.now();
    const status = await call(app, "status_get", { repoId });
    const statusMs = Date.now() - started;
    note(`status_get with 5000 changes: ${statusMs} ms`);
    check(status.ok && status.value.unstaged.length === 5000, `status_get: ${status.ok ? status.value.unstaged.length : `${status.code} ${status.message}`}`);
    check(statusMs < 20_000, `status_get takes ${statusMs} ms`);
    if (status.ok) equal(coreStatusPaths(status.value), want, "status as in git status");
    await selectWip(app, tabId);
    await eventually(async () => (await app.page.locator('[data-section="unstaged"] [data-row-key]').count()) > 0, true, "UI: list appears", 30_000);
    const domRows = await app.page.locator('[data-section="unstaged"] [data-row-key]').count();
    note(`UI: ${domRows} rows in the DOM for 5000 files`);
    check(domRows < 400, `UI: the list is virtualized (${domRows} rows in the DOM)`);
    const header = (await app.page.locator('[data-section="unstaged"]').innerText()).replace(/\s+/g, " ").slice(0, 120);
    check(/5[,.   ]?000/.test(header), `UI: the section shows 5000 (${JSON.stringify(header)})`);
    const frame = await Promise.race([app.page.evaluate(() => new Promise((resolve) => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0))); })), sleep(10_000).then(() => "hangs")]);
    check(frame !== "hangs" && frame < 500, `UI: two frames take ${frame} ms`);
    started = Date.now();
    const staged = await call(app, "stage_paths", { repoId, paths: null });
    const stageMs = Date.now() - started;
    note(`stage_paths(all 5000): ${stageMs} ms`);
    check(staged.ok, `stage_paths fails: ${staged.code} ${staged.message}`);
    check(stageMs < 60_000, `"stage all" takes ${stageMs} ms`);
    equal(gitStatus(ws, repo).unstaged, [], "git: nothing unstaged anymore");
    // Unstage 2500 individual paths (long argument list)
    const some = want.unstaged.filter((_, index) => index % 2 === 0);
    started = Date.now();
    const un = await call(app, "unstage_paths", { repoId, paths: some });
    note(`unstage_paths(2500 individual paths): ${Date.now() - started} ms`);
    check(un.ok, `unstage_paths(2500 paths) fails: ${un.code} ${un.message}`);
    equal(gitStatus(ws, repo).staged.length, 2500, "git: 2500 stay staged");
    started = Date.now();
    const again = await call(app, "stage_paths", { repoId, paths: some });
    note(`stage_paths(2500 individual paths): ${Date.now() - started} ms`);
    check(again.ok, `stage_paths(2500 paths) fails: ${again.code} ${again.message}`);
    started = Date.now();
    const commit = await call(app, "commit_create", commitArgs(repoId, "5000 Dateien auf einmal"));
    note(`commit_create: ${Date.now() - started} ms`);
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after the commit");
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    started = Date.now();
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    note(`commit_details(5000 files): ${Date.now() - started} ms`);
    check(details.ok && details.value.files.length === 5000, `commit_details: ${details.ok ? details.value.files.length : `${details.code} ${details.message}`}`);
    await selectCommit(app, tabId, head);
    await eventually(async () => (await app.page.locator('[data-screen="commit-details"] [data-row-key]').count()) > 0, true, "UI: commit details show files", 30_000);
    const detailRows = await app.page.locator('[data-screen="commit-details"] [data-row-key]').count();
    check(detailRows < 400, `UI: the commit's file list is virtualized (${detailRows} rows in the DOM)`);
    // Hard reset to the root commit and undo – 5000 files there and back
    const root = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    started = Date.now();
    const reset = await call(app, "reset_branch", { repoId, sha: root, mode: "hard" });
    note(`reset_branch(hard) over 5000 files: ${Date.now() - started} ms`);
    check(reset.ok, `reset_branch fails: ${reset.code} ${reset.message}`);
    const undo = await call(app, "undo", { repoId });
    check(undo.ok, `undo fails: ${undo.code} ${undo.message}`);
    equal(ws.git(repo, ["rev-parse", "HEAD"]), head, "git: undo restores HEAD");
    equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after the undo");
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C7 Binary files and images (also corrupt, empty, SVG with script): diff kind, no crash, no script", async () => {
    const ws = ws0("c7");
    const repo = ws.init("binaer");
    const png = makePng(32, 24, 0);
    const files = {
      "bild.png": png,
      "kaputt.png": Buffer.concat([png.subarray(0, 40), Buffer.from("das ist kein PNG mehr")]),
      "leer.png": Buffer.alloc(0),
      "falsche-endung.png": Buffer.from("eigentlich Text\nmit zwei Zeilen\n"),
      "text-mit-nul.txt": Buffer.from("vorne\0hinten\nzweite Zeile\n"),
      "binaer.dat": crypto.randomBytes(4096),
      "skript.svg": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.__l2Xss=1"><script>window.__l2Xss=2</script><rect width="40" height="40" fill="red"/><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="window.__l2Xss=3"/></foreignObject></svg>\n'),
      "bild.gif": Buffer.from("47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b", "hex"),
      "bild.bmp": Buffer.concat([Buffer.from("424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000", "hex"), Buffer.from([0, 0, 255, 0])]),
      "dokument.pdf": Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "latin1"),
      "archiv.zip": Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
    };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
    ws.commit(repo, "Binärdateien und Bilder");
    for (const name of Object.keys(files)) fs.writeFileSync(path.join(repo, name), Buffer.concat([files[name], Buffer.from(name === "falsche-endung.png" ? "dritte Zeile\n" : [1, 2, 3, 0, 4])]));
    fs.writeFileSync(path.join(repo, "bild.png"), makePng(32, 24, 1));
    fs.writeFileSync(path.join(repo, "skript.svg"), files["skript.svg"].toString().replace("red", "blue"));
    const { repoId, tabId } = await app.openRepo(repo);
    const status = await call(app, "status_get", { repoId });
    if (check(status.ok, `status_get fails: ${status.code} ${status.message}`)) equal(coreStatusPaths(status.value), gitStatus(ws, repo), "status as in git status");
    const kinds = {};
    for (const name of Object.keys(files)) {
      const diff = await call(app, "diff_file", { repoId, path: name, source: { kind: "unstaged" } });
      check(diff.ok, `diff_file(${name}) fails: ${diff.code} ${diff.message}`);
      kinds[name] = diff.ok ? diff.value.kind : diff.code;
    }
    note(`diff kinds: ${JSON.stringify(kinds)}`);
    equal(kinds["bild.png"], "image", "bild.png as image");
    equal(kinds["binaer.dat"], "binary", "binaer.dat as binary");
    equal(kinds["text-mit-nul.txt"], "binary", "text with NUL byte as binary (like git)");
    // UI: click every file – no crash, no console error, no script from the SVG
    await selectWip(app, tabId);
    await eventually(async () => (await wipRows(app, "unstaged")).length, Object.keys(files).length, "UI: all files in the list", 20_000);
    for (const name of Object.keys(files)) {
      await app.page.locator(`[data-section="unstaged"] [data-row-key=${JSON.stringify(name)}]`).click();
      await app.settle(30_000);
      await sleep(250);
      const text = ((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      const images = await app.page.locator('[data-screen="diff"] img').count();
      check(text.length > 0 || images > 0, `UI: ${name} shows neither text nor image`);
    }
    equal(await app.page.evaluate(() => window.__l2Xss ?? null), null, "no script from the SVG file was executed");
    const all = await call(app, "stage_paths", { repoId, paths: null });
    check(all.ok, `stage_paths(all) fails: ${all.code} ${all.message}`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "Binärdateien geändert"));
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    for (const name of Object.keys(files)) {
      const diff = await call(app, "diff_file", { repoId, path: name, source: { kind: "commit", sha: head } });
      check(diff.ok, `diff_file(commit, ${name}) fails: ${diff.code} ${diff.message}`);
      const blame = await call(app, "file_blame", { repoId, path: name, sha: head });
      check(blame.ok || blame.code !== "unknown", `file_blame(${name}): ${blame.code} ${blame.message}`);
      const read = await call(app, "file_read", { repoId, path: name, sha: head });
      check(read.ok, `file_read(${name}) fails: ${read.code} ${read.message}`);
    }
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C8 Executable file (100755): mode survives hunk staging, line staging, stash, discard and undo", async () => {
    const ws = ws0("c8");
    const repo = ws.init("modus");
    write(repo, "start.sh", `#!/bin/sh\n${textLines(30, "echo").join("\n")}\n`);
    write(repo, "normal.txt", "eins\n");
    ws.git(repo, ["add", "-A"]);
    ws.git(repo, ["update-index", "--chmod=+x", "start.sh"]);
    ws.commit(repo, "Ausführbares Skript");
    equal(indexMode(ws, repo, "start.sh"), "100755", "fixture: start.sh is recorded as executable");
    const change = () => write(repo, "start.sh", fs.readFileSync(path.join(repo, "start.sh"), "utf8").replace("echo 3:", "echo 3 GEÄNDERT:").replace("echo 25:", "echo 25 GEÄNDERT:"));
    change();
    const { repoId, tabId } = await app.openRepo(repo);
    const first = await stageHunk(app, repoId, "start.sh", 0);
    check(first.ok, `stage_patch(start.sh, hunk 1) fails: ${first.code} ${first.message}`);
    equal(indexMode(ws, repo, "start.sh"), "100755", "mode after hunk staging");
    const diff = await call(app, "diff_file", { repoId, path: "start.sh", source: { kind: "unstaged" } });
    if (diff.ok && diff.value.kind === "text") {
      const picks = diff.value.hunks[0].lines.map((line, index) => (line.kind === "context" ? -1 : index)).filter((index) => index >= 0);
      const second = await call(app, "stage_patch", { repoId, selection: { path: "start.sh", hunks: [{ index: 0, lines: picks }], expect: diff.value.token } });
      check(second.ok, `stage_patch(start.sh, lines) fails: ${second.code} ${second.message}`);
      equal(indexMode(ws, repo, "start.sh"), "100755", "mode after line staging");
    }
    const staged = await call(app, "diff_file", { repoId, path: "start.sh", source: { kind: "staged" } });
    if (staged.ok && staged.value.kind === "text") {
      const un = await call(app, "unstage_patch", { repoId, selection: { path: "start.sh", hunks: [{ index: 0, lines: null }], expect: staged.value.token } });
      check(un.ok, `unstage_patch fails: ${un.code} ${un.message}`);
      equal(indexMode(ws, repo, "start.sh"), "100755", "mode after unstaging a hunk");
    }
    const commit = await call(app, "commit_create", { ...commitArgs(repoId, "Skript geändert"), stageAll: true });
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(ws.git(repo, ["ls-tree", "HEAD", "start.sh"]).split(/\s+/)[0], "100755", "git: start.sh is still executable in the commit");
    // Stash and pop
    change();
    write(repo, "start.sh", `${fs.readFileSync(path.join(repo, "start.sh"), "utf8")}echo ende\n`);
    const stash = await call(app, "stash_create", { repoId, opId: "l2-c8", message: "Modus", paths: null, includeUntracked: false });
    check(stash.ok, `stash_create fails: ${stash.code} ${stash.message}`);
    const pop = await call(app, "stash_pop", { repoId, index: 0 });
    check(pop.ok, `stash_pop fails: ${pop.code} ${pop.message}`);
    equal(indexMode(ws, repo, "start.sh"), "100755", "mode after stash and pop");
    // Discard and undo
    const discard = await call(app, "discard_paths", { repoId, paths: ["start.sh"] });
    check(discard.ok, `discard_paths fails: ${discard.code} ${discard.message}`);
    const undo = await call(app, "undo", { repoId });
    check(undo.ok, `undo fails: ${undo.code} ${undo.message}`);
    equal(indexMode(ws, repo, "start.sh"), "100755", "mode after discard and undo");
    const final = await call(app, "commit_create", { ...commitArgs(repoId, "Skript noch einmal geändert"), stageAll: true });
    check(final.ok, `commit_create fails: ${final.code} ${final.message}`);
    equal(ws.git(repo, ["ls-tree", "HEAD", "start.sh"]).split(/\s+/)[0], "100755", "git: start.sh is still executable at the end");
    // Restore a file from an old commit
    const rootSha = ws.git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    const restore = await call(app, "file_restore", { repoId, sha: rootSha, paths: ["start.sh"] });
    check(restore.ok, `file_restore fails: ${restore.code} ${restore.message}`);
    equal(indexMode(ws, repo, "start.sh"), "100755", "mode after \"restore from commit\"");
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C8 Pure mode change (core.filemode=true on Windows, staged chmod): visible, stage, commit", async () => {
    const ws = ws0("c8b");
    const repo = ws.init("nur-modus");
    write(repo, "start.sh", "#!/bin/sh\necho hallo\n");
    write(repo, "lies.txt", "text\n");
    ws.commit(repo, "Start");
    // staged: only the mode
    ws.git(repo, ["update-index", "--chmod=+x", "start.sh"]);
    const { repoId, tabId } = await app.openRepo(repo);
    const status = await call(app, "status_get", { repoId });
    check(status.ok && status.value.staged.length === 1 && status.value.staged[0].path === "start.sh", `status lists start.sh as staged: ${status.ok ? JSON.stringify(status.value.staged) : status.message}`);
    const diff = await call(app, "diff_file", { repoId, path: "start.sh", source: { kind: "staged" } });
    check(diff.ok, `diff_file(staged, mode only) fails: ${diff.code} ${diff.message}`);
    if (diff.ok) note(`diff of a pure mode change: ${JSON.stringify(diff.value).slice(0, 300)}`);
    await selectWip(app, tabId);
    await eventually(async () => (await wipRows(app, "staged")).length, 1, "UI: start.sh under \"Staged\"");
    await app.page.locator('[data-section="staged"] [data-row-key="start.sh"]').click();
    await app.settle();
    await sleep(300);
    const shown = ((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    note(`UI shows for the pure mode change: ${JSON.stringify(shown.slice(0, 220))}`);
    // The user must be able to see WHAT changed: mode / executable / 100644 → 100755.
    check(/mode|executable|100755|chmod|permission/i.test(shown), `UI: the diff names the mode change (text: ${JSON.stringify(shown.slice(0, 220))})`);
    const commit = await call(app, "commit_create", commitArgs(repoId, "start.sh ausführbar"));
    check(commit.ok, `commit_create fails: ${commit.code} ${commit.message}`);
    equal(ws.git(repo, ["ls-tree", "HEAD", "start.sh"]).split(/\s+/)[0], "100755", "git: the commit carries the mode");
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: head } });
    check(details.ok && details.value.files.length === 1 && details.value.files[0].path === "start.sh", `commit details list start.sh: ${details.ok ? JSON.stringify(details.value.files) : details.message}`);
    // core.filemode=true: on Windows git now reports the file as modified (755 → 644)
    ws.git(repo, ["config", "core.filemode", "true"]);
    const want = gitStatus(ws, repo);
    const status2 = await call(app, "status_get", { repoId });
    if (check(status2.ok, `status_get with core.filemode=true fails: ${status2.code} ${status2.message}`)) equal(coreStatusPaths(status2.value), want, "status as in git status");
    note(`git status with core.filemode=true: ${JSON.stringify(want)}`);
    if (want.unstaged.includes("start.sh")) {
      const d2 = await call(app, "diff_file", { repoId, path: "start.sh", source: { kind: "unstaged" } });
      check(d2.ok, `diff_file(unstaged, mode only) fails: ${d2.code} ${d2.message}`);
      const discard = await call(app, "discard_paths", { repoId, paths: ["start.sh"] });
      check(discard.ok, `discard_paths(mode only) fails: ${discard.code} ${discard.message}`);
      const stage = await call(app, "stage_paths", { repoId, paths: ["start.sh"] });
      check(stage.ok, `stage_paths(mode only) fails: ${stage.code} ${stage.message}`);
      equal(indexMode(ws, repo, "start.sh"), "100644", "git: the mode change is staged");
    }
    await closeRepo(app, { repoId, tabId });
  });

  // ---------------------------------------------------------------------------------------------
  await section("C8 Symlinks in the index (120000, core.symlinks=false): core loop, mode survives staging", async () => {
    const ws = ws0("c8c");
    const repo = ws.init("symlinks", { config: { "core.symlinks": "false" } });
    write(repo, "ziel.txt", "das Ziel\n");
    write(repo, "ordner/datei.txt", "im Ordner\n");
    ws.git(repo, ["add", "-A"]);
    const link = (target) => ws.git(repo, ["hash-object", "-w", "--stdin"], { input: target });
    ws.git(repo, ["update-index", "--add", "--cacheinfo", `120000,${link("ziel.txt")},verweis.txt`]);
    ws.git(repo, ["update-index", "--add", "--cacheinfo", `120000,${link("ordner")},verweis-ordner`]);
    ws.git(repo, ["update-index", "--add", "--cacheinfo", `120000,${link("gibt/es/nicht")},verweis-kaputt`]);
    ws.git(repo, ["update-index", "--add", "--cacheinfo", `120000,${link("../../../ausserhalb.txt")},verweis-hinaus`]);
    ws.git(repo, ["commit", "-q", "-m", "Symlinks"]);
    ws.git(repo, ["checkout", "-q", "-f", "main"]);
    // On Windows without symlink privilege the links are small text files; change one.
    fs.writeFileSync(path.join(repo, "verweis.txt"), "ordner/datei.txt");
    write(repo, "ziel.txt", "das Ziel\nneu\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Verweis umgebogen" });
    equal(ws.git(repo, ["ls-tree", "HEAD", "verweis.txt"]).split(/\s+/)[0], "120000", "git: verweis.txt is still a symlink after the app's commit");
    equal(ws.git(repo, ["cat-file", "blob", "HEAD:verweis.txt"]), "ordner/datei.txt", "git: new target of the symlink");
    const { repoId } = seen.opened;
    // Hunk staging on a symlink: mode stays 120000
    fs.writeFileSync(path.join(repo, "verweis.txt"), "ziel.txt");
    const hunk = await stageHunk(app, repoId, "verweis.txt");
    check(hunk.ok || hunk.code !== "unknown", `stage_patch(Symlink): ${hunk.code} ${hunk.message}`);
    if (hunk.ok) {
      equal(indexMode(ws, repo, "verweis.txt"), "120000", "mode after hunk staging a symlink");
      equal(ws.git(repo, ["cat-file", "blob", ":verweis.txt"]), "ziel.txt", "target in the index after hunk staging");
    }
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    for (const rel of ["verweis.txt", "verweis-ordner", "verweis-kaputt", "verweis-hinaus"]) {
      const read = await call(app, "file_read", { repoId, path: rel, sha: head });
      check(read.ok, `file_read(HEAD, ${rel}) fails: ${read.code} ${read.message}`);
      const worktree = await call(app, "file_read", { repoId, path: rel, sha: null });
      check(worktree.ok || worktree.code !== "unknown", `file_read(working tree, ${rel}): ${worktree.code} ${worktree.message}`);
    }
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  await section("C9 File ↔ folder swapped: status, diff, commit, switch between both states", async () => {
    const ws = ws0("c9");
    const repo = ws.init("tausch");
    write(repo, "ding", "ich bin eine Datei\n");
    write(repo, "ordner/a.txt", "a\n");
    write(repo, "ordner/b.txt", "b\n");
    write(repo, "bleibt.txt", "bleibt\n");
    const before = ws.commit(repo, "ding ist eine Datei, ordner ein Ordner");
    ws.git(repo, ["branch", "vorher"]);
    fs.rmSync(path.join(repo, "ding"));
    write(repo, "ding/inhalt.txt", "jetzt bin ich ein Ordner\n");
    write(repo, "ding/tief/noch-eins.txt", "tiefer\n");
    fs.rmSync(path.join(repo, "ordner"), { recursive: true });
    write(repo, "ordner", "jetzt bin ich eine Datei\n");
    const seen = await coreLoop(t, app, ws, repo, { summary: "Datei und Ordner getauscht" });
    const { repoId } = seen.opened;
    const after = ws.git(repo, ["rev-parse", "HEAD"]);
    equal(sorted(lines(ws.git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]))), ["bleibt.txt", "ding/inhalt.txt", "ding/tief/noch-eins.txt", "ordner"], "git: the app's commit contains the swapped state");
    // Switch across the swap boundary, there and back
    const back = await call(app, "branch_checkout", { repoId, target: "vorher" });
    check(back.ok, `branch_checkout(vorher) fails: ${back.code} ${back.message}`);
    check(fs.statSync(path.join(repo, "ding")).isFile() && fs.statSync(path.join(repo, "ordner")).isDirectory(), "after switching: ding is a file again, ordner a folder again");
    const forth = await call(app, "branch_checkout", { repoId, target: "main" });
    check(forth.ok, `branch_checkout(main) fails: ${forth.code} ${forth.message}`);
    check(fs.statSync(path.join(repo, "ding")).isDirectory() && fs.statSync(path.join(repo, "ordner")).isFile(), "back: ding is a folder, ordner is a file");
    // (The diff of the swapped paths in the commit is the separate section for BUG L2-07.)
    const details = await call(app, "commit_details", { repoId, source: { kind: "commit", sha: after } });
    if (check(details.ok, `commit_details fails: ${details.code} ${details.message}`)) {
      equal(sorted(details.value.files.map((file) => `${file.status}:${file.path}`)), ["added:ding/inhalt.txt", "added:ding/tief/noch-eins.txt", "added:ordner", "deleted:ding", "deleted:ordner/a.txt", "deleted:ordner/b.txt"], "commit details of the swap commit");
    }
    // History and blame of a path that was once a file and once a folder
    const history = await call(app, "file_history", { repoId, path: "ding", limit: 10 });
    check(history.ok, `file_history(ding) fails: ${history.code} ${history.message}`);
    const oldRead = await call(app, "file_read", { repoId, path: "ding", sha: before });
    check(oldRead.ok && oldRead.value.text === "ich bin eine Datei\n", `file_read(ding in the old commit): ${oldRead.ok ? JSON.stringify(oldRead.value.text) : `${oldRead.code} ${oldRead.message}`}`);
    const nowRead = await call(app, "file_read", { repoId, path: "ding", sha: null });
    check(!nowRead.ok && nowRead.code !== "unknown", `file_read(ding, now a folder): ${nowRead.ok ? "returns content" : `${nowRead.code} ${nowRead.message}`}`);
    // Restore the file from the old commit where a folder now is: clear refusal or clean swap – no half state
    const restore = await call(app, "file_restore", { repoId, sha: before, paths: ["ding"] });
    note(`file_restore(ding, where a folder now is): ${restore.ok ? "ok" : `${restore.code} – ${restore.message}`}`);
    const state = gitStatus(ws, repo);
    if (restore.ok) check(fs.statSync(path.join(repo, "ding")).isFile(), "after restoring, ding is a file");
    else {
      check(restore.code !== "unknown", `file_restore reports understandably: ${restore.code} ${restore.message}`);
      equal(state, { staged: [], unstaged: [], conflicted: [] }, "after a refused restore nothing is half changed");
    }
    if (restore.ok) {
      const undo = await call(app, "undo", { repoId });
      check(undo.ok, `undo(restore) fails: ${undo.code} ${undo.message}`);
      check(fs.existsSync(path.join(repo, "ding/inhalt.txt")) && fs.existsSync(path.join(repo, "ding/tief/noch-eins.txt")), "undo brings back the folder ding with both files");
      equal(gitStatus(ws, repo), { staged: [], unstaged: [], conflicted: [] }, "git: clean after the undo");
    }
    await closeRepo(app, seen.opened);
  });

  // ---------------------------------------------------------------------------------------------
  // BUG L2-07: If a file is replaced by a folder of the same name (or vice versa), diff_file for the
  // path of the FILE also returns the hunks of all files in the FOLDER of the same name: the path acts
  // as a directory pathspec. The diff view of "ding" then shows three hunks from three files.
  await section("C9 File ↔ folder swapped: a file's diff contains only its own lines (commit and staged)", async () => {
    const ws = ws0("c9b");
    const repo = ws.init("tausch-diff");
    write(repo, "ding", "ich bin eine Datei\n");
    write(repo, "ordner/a.txt", "a\n");
    write(repo, "ordner/b.txt", "b\n");
    ws.commit(repo, "ding ist eine Datei, ordner ein Ordner");
    fs.rmSync(path.join(repo, "ding"));
    write(repo, "ding/inhalt.txt", "jetzt bin ich ein Ordner\n");
    write(repo, "ding/tief/noch-eins.txt", "tiefer\n");
    fs.rmSync(path.join(repo, "ordner"), { recursive: true });
    write(repo, "ordner", "jetzt bin ich eine Datei\n");
    ws.git(repo, ["add", "-A"]);
    const { repoId, tabId } = await app.openRepo(repo);
    const expectLines = { ding: ["remove:ich bin eine Datei"], ordner: ["add:jetzt bin ich eine Datei"] };
    const probe = async (label, source) => {
      for (const [rel, want] of Object.entries(expectLines)) {
        const diff = await call(app, "diff_file", { repoId, path: rel, source });
        if (!check(diff.ok && diff.value.kind === "text", `diff_file(${label}, ${rel}): ${diff.ok ? diff.value.kind : `${diff.code} ${diff.message}`}`)) continue;
        equal(diff.value.hunks.flatMap((hunk) => hunk.lines).map((line) => `${line.kind}:${line.text}`), want, `diff_file(${label}, ${rel}): only this file's lines (${diff.value.hunks.length} Hunks)`);
      }
    };
    await probe("staged", { kind: "staged" });
    // Unstaging hunk 1 of "ding" must only affect "ding".
    const staged = await call(app, "diff_file", { repoId, path: "ding", source: { kind: "staged" } });
    if (staged.ok && staged.value.kind === "text") {
      const un = await call(app, "unstage_patch", { repoId, selection: { path: "ding", hunks: staged.value.hunks.map((hunk) => ({ index: hunk.index, lines: null })), expect: staged.value.token } });
      note(`unstage_patch(ding, all ${staged.value.hunks.length} Hunks): ${un.ok ? "ok" : `${un.code} – ${un.message}`}`);
      const index = sorted(lines(ws.git(repo, ["ls-files"])));
      note(`index afterwards: ${JSON.stringify(index)}`);
      check(index.includes("ding/inhalt.txt") && index.includes("ding/tief/noch-eins.txt"), `the files in the folder ding stay staged (index: ${JSON.stringify(index)})`);
    }
    ws.git(repo, ["add", "-A"]);
    ws.git(repo, ["commit", "-q", "-m", "Datei und Ordner getauscht"]);
    const head = ws.git(repo, ["rev-parse", "HEAD"]);
    await probe("commit", { kind: "commit", sha: head });
    // UI: the diff view of "ding" in the commit
    await selectCommit(app, tabId, head);
    await app.page.locator('[data-screen="commit-details"] [data-row-key="ding"]').click();
    await app.settle();
    await sleep(300);
    const shown = ((await app.page.locator('[data-screen="diff"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    check(!shown.includes("jetzt bin ich ein Ordner") && !shown.includes("tiefer"), `UI: the diff of "ding" shows no lines from ding/inhalt.txt (text: ${JSON.stringify(shown.slice(0, 260))})`);
    await closeRepo(app, { repoId, tabId });
  }, { bug: "L2-07" });
} catch (error) {
  t.check(false, `script aborted: ${error?.stack ?? error}`);
} finally {
  await app?.close().catch(() => undefined);
  for (const ws of spaces) ws.cleanup();
}
await sleep(50);
process.exit(t.finish());
