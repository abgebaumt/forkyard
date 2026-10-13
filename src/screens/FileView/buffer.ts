/**
 * Working state of the editor: what was loaded, what is currently in the editor, in which
 * encoding and with which line endings it is saved.
 *
 * In the editor line endings are always “\n” (that is how CodeMirror works). On saving the core
 * puts the chosen line endings back in (`file_write` normalises to `eol`); this way an unchanged
 * file yields the same bytes.
 *
 * Unsaved states survive leaving the view in memory (`drafts`), so that a click into another
 * file loses nothing; they come back the next time the file is opened.
 */
import type { FileContent, Id } from "../../core";
import { t } from "../../i18n";

export type Eol = "lf" | "crlf";

export interface Buffer {
  /** repoId|path – does the state still belong to the file shown? */
  key: string;
  /** Loaded text (with “\n”). */
  base: string;
  baseEncoding: string;
  /** Line endings of the file; for “mixed” the more frequent kind. */
  baseEol: Eol;
  /** The file had mixed line endings. */
  mixed: boolean;
  /** For mixed line endings: a kind was chosen explicitly – saving normalises. */
  eolTouched: boolean;
  text: string;
  encoding: string;
  eol: Eol;
}

export const bufferKey = (repoId: Id, path: string) => `${repoId}|${path}`;

/**
 * “\r\n” to “\n” – that is how the editor holds the text. A SINGLE “\r” in the middle of a line
 * (progress output, old Mac files) is not a line ending of this file: it stays as a character
 * and survives saving (this used to be lost). The editor therefore splits lines only at “\n”
 * (`KEEP_LONE_CR` in index.tsx).
 */
export const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");

/** More frequent line ending kind of a text. */
export function majorityEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "crlf" : "lf";
}

export function bufferFrom(key: string, content: FileContent): Buffer {
  const raw = content.text ?? "";
  const base = normalizeEol(raw);
  const mixed = content.eol === "mixed";
  const baseEol: Eol = content.eol === "crlf" ? "crlf" : mixed ? majorityEol(raw) : "lf";
  const encoding = content.encoding || "utf-8";
  return { key, base, baseEncoding: encoding, baseEol, mixed, eolTouched: false, text: base, encoding, eol: baseEol };
}

export const isDirty = (buffer: Buffer | null) =>
  Boolean(buffer && (buffer.text !== buffer.base || buffer.encoding !== buffer.baseEncoding || buffer.eol !== buffer.baseEol || (buffer.mixed && buffer.eolTouched)));

// --- Unsaved states: whoever needs to know about them learns of every change ------------------

const unsavedListeners = new Set<() => void>();
const notifyUnsaved = () => unsavedListeners.forEach((listener) => listener());

/** Calls `listener` as soon as the set of files with unsaved text changes. */
export function onUnsavedChange(listener: () => void): () => void {
  unsavedListeners.add(listener);
  return () => unsavedListeners.delete(listener);
}

class BufferMap extends Map<string, Buffer> {
  set(key: string, value: Buffer) {
    super.set(key, value);
    notifyUnsaved();
    return this;
  }
  delete(key: string) {
    const had = super.delete(key);
    if (had) notifyUnsaved();
    return had;
  }
}

/** Unsaved states of files whose view was left (in memory only). */
export const drafts: Map<string, Buffer> = new BufferMap();
/** Unsaved states of the currently open editors. */
const live: Map<string, Buffer> = new BufferMap();

/** The open editor reports its state: `buffer` with unsaved text, otherwise `null`. */
export function setLiveBuffer(key: string, buffer: Buffer | null): void {
  if (buffer && isDirty(buffer)) {
    if (live.get(key) !== buffer) live.set(key, buffer);
  } else live.delete(key);
}

export interface UnsavedFile {
  repoId: Id;
  path: string;
  buffer: Buffer;
}

/** All files with unsaved text (open editors and left views), optionally only of one repository. */
export function unsavedFiles(repoId?: Id): UnsavedFile[] {
  const found = new Map<string, Buffer>();
  for (const [key, buffer] of drafts) if (isDirty(buffer)) found.set(key, buffer);
  // The open editor has the newer state.
  for (const [key, buffer] of live) found.set(key, buffer);
  const files: UnsavedFile[] = [];
  for (const [key, buffer] of found) {
    const split = key.indexOf("|");
    const file = { repoId: key.slice(0, split), path: key.slice(split + 1), buffer };
    if (!repoId || file.repoId === repoId) files.push(file);
  }
  return files;
}

/** Forgets the unsaved states (of one repository): the user chose “Don't save”. */
export function discardUnsaved(repoId?: Id): void {
  for (const file of unsavedFiles(repoId)) {
    const key = bufferKey(file.repoId, file.path);
    drafts.delete(key);
    live.delete(key);
  }
}

/**
 * Saves all unsaved states (of one repository). Returns the paths for which this failed; the
 * others are saved afterwards and no longer tracked as unsaved.
 */
export async function saveUnsaved(repoId?: Id): Promise<string[]> {
  const { core } = await import("../../core");
  const failed: string[] = [];
  for (const file of unsavedFiles(repoId)) {
    const { text, encoding, eol } = file.buffer;
    try {
      await core.fileWrite({ repoId: file.repoId, path: file.path, content: text, encoding, eol });
      const key = bufferKey(file.repoId, file.path);
      drafts.delete(key);
      live.delete(key);
    } catch {
      failed.push(file.path);
    }
  }
  return failed;
}

/** Text in the form it has on disk after saving. */
export const withEol = (text: string, eol: Eol) => (eol === "crlf" ? text.replace(/\n/g, "\r\n") : text);

export const ENCODINGS: { value: string; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-8-bom", label: t("fileView.encoding.utf8Bom") },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
  { value: "windows-1252", label: t("fileView.encoding.western", { name: "Windows-1252, Latin-1" }) },
  { value: "iso-8859-15", label: t("fileView.encoding.western", { name: "ISO-8859-15" }) },
  { value: "windows-1250", label: t("fileView.encoding.central", { name: "Windows-1250" }) },
  { value: "iso-8859-2", label: t("fileView.encoding.central", { name: "ISO-8859-2" }) },
  { value: "windows-1251", label: t("fileView.encoding.cyrillic", { name: "Windows-1251" }) },
  { value: "koi8-r", label: t("fileView.encoding.cyrillic", { name: "KOI8-R" }) },
  { value: "shift_jis", label: t("fileView.encoding.japanese", { name: "Shift_JIS" }) },
  { value: "euc-kr", label: t("fileView.encoding.korean", { name: "EUC-KR" }) },
  { value: "gbk", label: t("fileView.encoding.chineseSimplified", { name: "GBK" }) },
  { value: "big5", label: t("fileView.encoding.chineseTraditional", { name: "Big5" }) },
];

/** Short name for the status bar. */
export function encodingShort(encoding: string): string {
  const known: Record<string, string> = { "utf-8": "UTF-8", "utf-8-bom": "UTF-8 BOM", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE" };
  return known[encoding] ?? encoding.toUpperCase();
}

const MARKDOWN = /\.(md|markdown|mdown|mkd|mdx)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
export const isMarkdown = (path: string) => MARKDOWN.test(path);
export const isImagePath = (path: string) => IMAGE.test(path);

/** Git's empty tree (SHA-1). A comparison against it yields the whole file – that is how an image arrives as a data: URL. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
