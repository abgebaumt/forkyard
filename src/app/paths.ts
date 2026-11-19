/**
 * Text helpers for repository paths, ref names and remote hosts. Repository paths always use "/"
 * (a backslash is a legal file name character in Git); OS paths live in osPaths.ts.
 */
import type { RemoteHost } from "../core";

/** Folder (with trailing slash, "" at the top level) and file name of a repository path. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}

/** File name of a repository path. */
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export type RefNameIssue =
  | "space"
  | "char"
  | "doubleDot"
  | "atBrace"
  | "leadingDash"
  | "slashes"
  | "trailingDot"
  | "dotOrLock"
  | "reserved";

/**
 * First rule of `git check-ref-format` a ref name breaks, or null. Only the spelling – whether the
 * name exists is up to the core. `char` is the offending character for "char".
 */
export function refNameIssue(name: string): { issue: RefNameIssue; char?: string } | null {
  if (/\s/.test(name)) return { issue: "space" };
  const bad = /[~^:?*[\\\u0000-\u001f\u007f]/.exec(name);
  if (bad) return { issue: "char", char: bad[0] };
  if (name.includes("..")) return { issue: "doubleDot" };
  if (name.includes("@{")) return { issue: "atBrace" };
  if (name.startsWith("-")) return { issue: "leadingDash" };
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return { issue: "slashes" };
  if (name.endsWith(".")) return { issue: "trailingDot" };
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return { issue: "dotOrLock" };
  if (name === "@" || name === "HEAD") return { issue: "reserved" };
  return null;
}

/** Hoster by server name (lower case), for badges only – the core decides for real. */
export function hostKindOf(host: string): RemoteHost {
  const labels = host.split(".");
  if (host === "dev.azure.com" || host.endsWith(".dev.azure.com") || host.endsWith(".visualstudio.com")) return "azure";
  if (labels.includes("github")) return "github";
  if (labels.includes("gitlab")) return "gitlab";
  if (labels.includes("bitbucket")) return "bitbucket";
  return "other";
}
