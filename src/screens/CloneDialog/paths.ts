/**
 * Path helpers for cloning and creating (also used by the repository manager and the init dialog). Text only – whether a
 * folder exists is known only to the core.
 */
import { t } from "../../i18n";

const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path) || path.startsWith("\\\\") || (path.includes("\\") && !path.includes("/"));

/** Appends `name` to `parent`, with the separator `parent` already uses. */
export function joinPath(parent: string, name: string): string {
  const base = parent.trim();
  if (!base) return name;
  const separator = isWindowsPath(base) ? "\\" : "/";
  return /[\\/]$/.test(base) ? `${base}${name}` : `${base}${separator}${name}`;
}

const stripTrailing = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

/** Letzter Teil eines Pfads. */
export function baseName(path: string): string {
  const clean = stripTrailing(path.trim());
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return index >= 0 ? clean.slice(index + 1) : clean;
}

/** Parent folder; for a root directory the path itself. */
export function parentOf(path: string): string {
  const clean = stripTrailing(path.trim());
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (index < 0) return "";
  const parent = clean.slice(0, index);
  // "C:" → "C:\", "" → "/"
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || clean.slice(0, 1);
}

/** For comparison: uniform separators, no trailing separator, case-insensitive on Windows. */
export function pathKey(path: string): string {
  const clean = stripTrailing(path.trim()).replaceAll("\\", "/");
  return isWindowsPath(path.trim()) ? clean.toLowerCase() : clean;
}

export function isAbsolutePath(path: string): boolean {
  const value = path.trim();
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

/**
 * Splits a path for display: the beginning may be shortened, the end (the last two folders)
 * always stays readable. Together with `truncate` at the start this gives truncation in the middle.
 */
export function splitForDisplay(path: string): { head: string; tail: string } {
  const clean = stripTrailing(path);
  const separators = [...clean.matchAll(/[\\/]/g)].map((match) => match.index);
  if (separators.length < 3) return { head: "", tail: clean };
  const cut = separators[separators.length - 2]!;
  return { head: clean.slice(0, cut), tail: clean.slice(cut) };
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Why `name` cannot be a folder name – or null. The core checks the same rules on submit. */
export function folderNameError(name: string): string | null {
  if (!name) return t("clone.folderName.missing");
  if (name === "." || name === "..") return t("clone.folderName.dots");
  const bad = /[\\/<>:"|?*]/.exec(name);
  if (bad) return t("clone.folderName.char", { char: bad[0] });
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return t("clone.folderName.control");
  if (name.startsWith(" ")) return t("clone.folderName.leadingSpace");
  if (name.endsWith(" ") || name.endsWith(".")) return t("clone.folderName.trailing");
  if (RESERVED.test(name.split(".")[0] ?? name)) return t("clone.folderName.reserved");
  // No common file system allows longer names (the core additionally checks the length of the whole path).
  if (name.length > MAX_NAME_LENGTH) return t("clone.folderName.tooLong", { length: name.length, max: MAX_NAME_LENGTH });
  return null;
}

/** A single file or folder name may not be longer than this. */
export const MAX_NAME_LENGTH = 255;

/** Rough check of a branch name while typing; Git does the exact one. */
export function branchNameError(name: string): string | null {
  if (!name) return null;
  if (/\s/.test(name)) return t("clone.branchName.spaces");
  if (name.startsWith("-")) return t("clone.branchName.dash");
  const bad = /[~^:?*[\\]/.exec(name);
  if (bad) return t("clone.branchName.char", { char: bad[0] });
  if (name.includes("..") || name.includes("@{")) return t("clone.branchName.sequence");
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return t("clone.branchName.slashes");
  if (name.endsWith(".") || name.endsWith(".lock")) return t("clone.branchName.ending");
  return null;
}

const PARENT_KEY = "gc.repoParent";

/** The parent folder last chosen for cloning or creating. */
export function rememberedParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberParent(path: string): void {
  try {
    if (path.trim()) localStorage.setItem(PARENT_KEY, path.trim());
  } catch {
    // without localStorage the choice only applies to this dialog
  }
}
