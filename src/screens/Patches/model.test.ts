import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { decodeMailHeader, parseApplyErrors, parsePatch, relativeInside, slug, suggestFileName } from "./model";

const MAIL = [
  "From 1234567890abcdef Mon Sep 17 00:00:00 2001",
  "From: =?UTF-8?q?J=C3=BCrgen?= <j@example.test>",
  "Subject: [PATCH 1/2] Karte: Legende",
  " ergänzt",
  "",
  "diff --git a/src/karte.ts b/src/karte.ts",
  "index 111..222 100644",
  "--- a/src/karte.ts",
  "+++ b/src/karte.ts",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+c",
  "",
  "\\ No newline at end of file",
  "diff --git a/neu.txt b/neu.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/neu.txt",
  "@@ -0,0 +1 @@",
  "+hallo",
  "diff --git a/alt.txt b/alt.txt",
  "deleted file mode 100644",
  "--- a/alt.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-weg",
  'diff --git "a/b\\303\\244r.txt" "b/b\\303\\244r 2.txt"',
  "similarity index 100%",
  'rename from "b\\303\\244r.txt"',
  'rename to "b\\303\\244r 2.txt"',
  "diff --git a/bild.png b/bild.png",
  "Binary files a/bild.png and b/bild.png differ",
].join("\r\n");

describe("reading patch text", () => {
  const info = parsePatch(MAIL);

  it("reads the mail header (folded subject without [PATCH], encoded author)", () => {
    expect(info.subject).toBe("Karte: Legende ergänzt");
    expect(info.author).toBe("Jürgen <j@example.test>");
  });

  it("lists files with status, counts and quoted paths", () => {
    expect(info.files.map((file) => [file.path, file.status, file.added, file.removed, file.binary])).toEqual([
      ["src/karte.ts", "modified", 1, 1, false],
      ["neu.txt", "added", 1, 0, false],
      ["alt.txt", "deleted", 0, 1, false],
      ["bär 2.txt", "renamed", 0, 0, false],
      ["bild.png", "modified", 0, 0, true],
    ]);
    expect(info.files[3]!.oldPath).toBe("bär.txt");
    expect([info.added, info.removed]).toEqual([2, 2]);
  });

  it("gives every line a kind", () => {
    expect(info.kinds).toHaveLength(info.lines.length);
    expect(info.kinds.slice(0, 5)).toEqual(["mail", "mail", "mail", "mail", "mail"]);
    expect(info.kinds.slice(9, 15)).toEqual(["hunk", "context", "remove", "add", "context", "meta"]);
  });

  it("a hunk shorter than announced does not swallow the next file", () => {
    const short = parsePatch(
      ["diff --git a/x b/x", "@@ -1,5 +1,5 @@", "-a", "+b", "diff --git a/y b/y", "@@ -1 +1 @@", "-c", "+d"].join("\n"),
    );
    expect(short.files.map((file) => file.path)).toEqual(["x", "y"]);
  });
});

describe("mail headers", () => {
  it("decodes Q and B encoded words and joins adjacent ones", () => {
    expect(decodeMailHeader("=?UTF-8?q?Gr=C3=B6=C3=9Fe_aus?= =?UTF-8?B?S8O2bG4=?=")).toBe("Größe ausKöln");
    expect(decodeMailHeader("plain")).toBe("plain");
    expect(decodeMailHeader("=?no-such-charset?q?x?=")).toBe("=?no-such-charset?q?x?=");
  });
});

describe("git apply --check output", () => {
  it("maps each file to a reason, the first specific one wins", () => {
    const reasons = parseApplyErrors(
      [
        "error: patch failed: src/a.ts:12",
        "error: src/a.ts: patch does not apply",
        "error: neu.txt: already exists in working directory",
        "error: weg.txt: No such file or directory",
        "error: b.ts: patch does not apply",
        "error: c.ts: something else",
      ].join("\n"),
    );
    expect(reasons.get("src/a.ts")).toBe(t("patches.applyErrors.failedAt", { line: "12" }));
    expect(reasons.get("neu.txt")).toBe(t("patches.applyErrors.exists"));
    expect(reasons.get("weg.txt")).toBe(t("patches.applyErrors.missing"));
    expect(reasons.get("b.ts")).toBe(t("patches.applyErrors.noFit"));
    expect(reasons.get("c.ts")).toBe("something else");
    expect(parseApplyErrors(null).size).toBe(0);
  });
});

describe("patch file names", () => {
  const day = new Date(2026, 0, 5);

  it("slugs keep letters and digits", () => {
    expect(slug("  Größe: 7 × 24 h!  ")).toBe("Größe-7-24-h");
    expect(slug("a b c d", 4)).toBe("a-b");
  });

  it("suggests a name by source", () => {
    expect(suggestFileName({ kind: "commit", sha: "abcdef1234567" }, null, day)).toBe("0001-abcdef1.patch");
    expect(suggestFileName({ kind: "commit", sha: "abcdef1234567" }, "Fix: Karte", day)).toBe("0001-Fix-Karte.patch");
    expect(suggestFileName({ kind: "stash", index: 2 }, null, day)).toBe("stash-2.patch");
    expect(suggestFileName({ kind: "range", from: "a", to: null }, null, day)).toBe(`${t("patches.fileName.range")}-2026-01-05.patch`);
    expect(suggestFileName({ kind: "unstaged" }, null, day)).toBe(`${t("patches.fileName.changes")}-2026-01-05.patch`);
  });

  it("a save target counts only strictly inside the repository, never in .git", () => {
    expect(relativeInside("/r/repo", "/r/repo/patches/a.patch", false)).toBe("patches/a.patch");
    expect(relativeInside("C:\\R\\Repo\\", "c:\\r\\repo\\a.patch", true)).toBe("a.patch");
    expect(relativeInside("/r/repo", "/r/Repo/a.patch", false)).toBeNull();
    expect(relativeInside("/r/repo", "/r/repo2/a.patch", false)).toBeNull();
    expect(relativeInside("/r/repo", "/r/repo/.git/a.patch", false)).toBeNull();
    expect(relativeInside("/r/repo", "/r/repo/x/../a.patch", false)).toBeNull();
  });
});
