/**
 * Reading patch text: which files it changes, how many lines, which line is what – for the preview
 * when creating and for the check result when applying. Computed for display only; whether a
 * patch applies is decided by Git in the core alone.
 */
import type { DiffSource } from "../../core";
import { locale, t } from "../../i18n";

export type PatchFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface PatchFile {
  path: string;
  oldPath: string | null;
  status: PatchFileStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export type PatchLineKind = "mail" | "meta" | "hunk" | "add" | "remove" | "context";

export interface PatchInfo {
  files: PatchFile[];
  added: number;
  removed: number;
  /** From the header of a patch in `git format-patch` format. */
  subject: string | null;
  author: string | null;
  /** Kind of every line, in the order of the text. */
  kinds: PatchLineKind[];
  lines: string[];
}

/** Splits `a/<old> b/<new>` from the `diff --git` line; unambiguous for equal paths, otherwise the latter part. */
function pathFromHeader(rest: string): string {
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0 && rest.slice(2, 2 + half) === rest.slice(rest.length - half) && rest.startsWith("a/")) return rest.slice(2, 2 + half);
  const at = rest.lastIndexOf(" b/");
  return at >= 0 ? rest.slice(at + 3) : rest;
}

/** Git quotes paths with special characters and escapes them like in C. */
function unquote(value: string): string {
  const text = value.replace(/\t.*$/, "");
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) return text;
  const bytes: number[] = [];
  const inner = text.slice(1, -1);
  const encoder = new TextEncoder();
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!;
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = inner[++index] ?? "";
    if (/[0-7]/.test(next)) {
      const octal = inner.slice(index, index + 3);
      bytes.push(Number.parseInt(octal, 8));
      index += 2;
    } else {
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
      bytes.push(...encoder.encode(map[next] ?? next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const stripPrefix = (value: string) => (value === "/dev/null" ? null : unquote(value).replace(/^[ab]\//, ""));

/** Header lines of an email may be encoded: `=?UTF-8?q?Gr=C3=B6=C3=9Fe?=`. */
export function decodeMailHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (whole, charset: string, mode: string, body: string) => {
      try {
        let bytes: Uint8Array;
        if (mode.toLowerCase() === "b") {
          bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
        } else {
          const raw = body.replace(/_/g, " ");
          const list: number[] = [];
          for (let index = 0; index < raw.length; index++) {
            if (raw[index] === "=" && /^[0-9a-fA-F]{2}$/.test(raw.slice(index + 1, index + 3))) {
              list.push(Number.parseInt(raw.slice(index + 1, index + 3), 16));
              index += 2;
            } else list.push(raw.charCodeAt(index) & 255);
          }
          bytes = new Uint8Array(list);
        }
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return whole;
      }
    });
}

export function parsePatch(text: string): PatchInfo {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kinds: PatchLineKind[] = [];
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let subject: string | null = null;
  let author: string | null = null;
  let lastHeader: "subject" | null = null;

  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      const sign = line[0];
      if (sign === "+" && current) {
        current.added++;
        newLeft--;
        kinds.push("add");
        continue;
      }
      if (sign === "-" && current) {
        current.removed++;
        oldLeft--;
        kinds.push("remove");
        continue;
      }
      if (sign === "\\") {
        kinds.push("meta");
        continue;
      }
      if (sign === " " || line === "") {
        oldLeft--;
        newLeft--;
        kinds.push("context");
        continue;
      }
      // The hunk is shorter than announced: keep reading normally.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      current = { path: pathFromHeader(line.slice("diff --git ".length)), oldPath: null, status: "modified", added: 0, removed: 0, binary: false };
      files.push(current);
      kinds.push("meta");
      lastHeader = null;
      continue;
    }
    if (current) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        kinds.push("hunk");
        continue;
      }
      if (line.startsWith("new file mode")) current.status = "added";
      else if (line.startsWith("deleted file mode")) current.status = "deleted";
      else if (line.startsWith("rename from ")) {
        current.status = "renamed";
        current.oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) current.path = unquote(line.slice("rename to ".length));
      else if (line.startsWith("--- ")) {
        const path = stripPrefix(line.slice(4));
        if (path && current.status === "deleted") current.path = path;
      } else if (line.startsWith("+++ ")) {
        const path = stripPrefix(line.slice(4));
        if (path) current.path = path;
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) current.binary = true;
      kinds.push("meta");
      continue;
    }
    // Before the first file: header in `git format-patch` format.
    if (line.startsWith("Subject: ")) {
      subject = line.slice("Subject: ".length);
      lastHeader = "subject";
    } else if (lastHeader === "subject" && /^[ \t]/.test(line)) {
      subject = `${subject ?? ""} ${line.trim()}`;
    } else {
      lastHeader = null;
      if (line.startsWith("From: ")) author = decodeMailHeader(line.slice("From: ".length)).trim();
    }
    kinds.push("mail");
  }
  if (subject !== null) subject = decodeMailHeader(subject).replace(/^\[PATCH[^\]]*\]\s*/, "").trim() || null;
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    subject,
    author,
    kinds,
    lines,
  };
}

/**
 * Reads from the output of `git apply --check` which file does not apply and why.
 * The key is the path; the value a phrase for the file's row.
 */
export function parseApplyErrors(gitOutput: string | null): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const raw of (gitOutput ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^error: /, "").trim();
    if (!line) continue;
    let match = /^patch failed: (.+):(\d+)$/.exec(line);
    if (match) {
      reasons.set(match[1]!, t("patches.applyErrors.failedAt", { line: match[2] }));
      continue;
    }
    match = /^(.+): already exists in (?:working directory|index)$/.exec(line);
    if (match) {
      reasons.set(match[1]!, t("patches.applyErrors.exists"));
      continue;
    }
    match = /^(.+): No such file or directory$/.exec(line) ?? /^(.+): does not exist in index$/.exec(line);
    if (match) {
      reasons.set(match[1]!, t("patches.applyErrors.missing"));
      continue;
    }
    match = /^(.+): patch does not apply$/.exec(line);
    if (match) {
      if (!reasons.has(match[1]!)) reasons.set(match[1]!, t("patches.applyErrors.noFit"));
      continue;
    }
    match = /^(.+): (.+)$/.exec(line);
    if (match && !reasons.has(match[1]!)) reasons.set(match[1]!, match[2]!);
  }
  return reasons;
}

/** Turn a text into a file name part: letters and digits stay, everything else becomes "-". */
export function slug(text: string, max = 52): string {
  const cleaned = text
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, max).replace(/-+$/, "");
}

/** Suggested file name, depending on what the patch is made from. */
export function suggestFileName(source: DiffSource, hint: string | null, today = new Date()): string {
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const name = hint ? slug(hint) : "";
  switch (source.kind) {
    case "commit":
      return `0001-${name || source.sha.slice(0, 7)}.patch`;
    case "stash":
      return `stash-${name || source.index}.patch`;
    case "range":
      return `${t("patches.fileName.range")}-${name || date}.patch`;
    default:
      return `${t("patches.fileName.changes")}-${name ? `${name}-` : ""}${date}.patch`;
  }
}

/** Path relative to the repository if `target` lies inside it – otherwise null. Case-insensitive on Windows. */
export function relativeInside(repoPath: string, target: string, caseInsensitive: boolean): string | null {
  const clean = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = clean(repoPath);
  const file = clean(target);
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  if (!fold(file).startsWith(`${fold(root)}/`)) return null;
  const relative = file.slice(root.length + 1);
  if (!relative || relative.split("/").some((part) => part === ".." || part === "." || part.toLowerCase() === ".git")) return null;
  return relative;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return t("patches.size.bytes", { size: bytes.toLocaleString(locale()) });
  if (bytes < 1024 * 1024) return t("patches.size.kb", { size: (bytes / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 }) });
  return t("patches.size.mb", { size: (bytes / 1024 / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 }) });
}
