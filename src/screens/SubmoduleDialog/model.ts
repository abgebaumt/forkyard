/** Pure functions for submodules: suggest a path from the URL, check a path, row texts. No React, no core. */
import type { Submodule } from "../../core";
import { submoduleStateHint, submoduleStateText } from "../../app/actions/submodules";
import { shortSha } from "../../app/format";
import { t } from "../../i18n";
import { parseCloneUrl } from "../CloneDialog/url";

/** Folder in the repository derived from the address: the last part without ".git". Empty if the address yields nothing. */
export function suggestPath(url: string): string {
  const parsed = parseCloneUrl(url);
  return parsed.ok ? parsed.name.replace(/\s+/g, "-") : "";
}

/** Uniform notation: forward slashes, none at the start or end, no "./". */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Why `raw` cannot be a submodule path – or null. Whether the folder is free only the core knows. */
export function pathProblem(raw: string, existing: Pick<Submodule, "path">[]): string | null {
  const value = raw.trim().replace(/\\/g, "/");
  if (!value) return t("submodules.path.required");
  if (/^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("~")) return t("submodules.path.absolute");
  const path = normalizePath(value);
  if (!path || path === ".") return t("submodules.path.root");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) return t("submodules.path.emptySegment");
  if (segments.some((segment) => segment === "..")) return t("submodules.path.parent");
  if (segments.some((segment) => segment === ".")) return t("submodules.path.dot");
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return t("submodules.path.git");
  for (const segment of segments) {
    const bad = /[<>:"|?*]/.exec(segment);
    if (bad) return t("submodules.path.badChar", { char: bad[0] });
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(segment)) return t("submodules.path.control");
    if (segment.startsWith(" ") || segment.endsWith(" ") || segment.endsWith(".")) return t("submodules.path.edges", { segment });
    if (RESERVED.test(segment.split(".")[0] ?? segment)) return t("submodules.path.reserved", { segment });
  }
  if (path.startsWith("-")) return t("submodules.path.dash");
  const key = path.toLowerCase();
  if (existing.some((item) => item.path.toLowerCase() === key)) return t("submodules.path.taken");
  if (existing.some((item) => key.startsWith(`${item.path.toLowerCase()}/`))) return t("submodules.path.nested");
  return null;
}

/** Last part of the path and the folder before it (with slash), for "name first, folder dimmed". */
export function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { name: path, dir: "" } : { name: path.slice(index + 1), dir: path.slice(0, index + 1) };
}

/** Second line: state as a word, followed by the commit. */
export function submoduleSecondary(submodule: Submodule): string {
  const state = submoduleStateText[submodule.state];
  if (submodule.state === "uninitialized") return state;
  const at = submodule.headSha ? shortSha(submodule.headSha) : shortSha(submodule.sha);
  const parts = [state, submodule.state === "out_of_sync" && submodule.headSha ? t("submodules.row.outOfSync", { head: at, sha: shortSha(submodule.sha) }) : at];
  if (submodule.branch) parts.push(submodule.branch);
  return parts.join(" · ");
}

export function describeSubmodule(submodule: Submodule): string {
  const parts = [t("submodules.row.describe", { path: submodule.path }), submoduleStateText[submodule.state]];
  if (submodule.state === "out_of_sync" && submodule.headSha) parts.push(t("submodules.row.describeOutOfSync", { head: shortSha(submodule.headSha), sha: shortSha(submodule.sha) }));
  if (submodule.branch) parts.push(t("submodules.row.describeBranch", { branch: submodule.branch }));
  return parts.join(", ");
}

export function submoduleTipLines(submodule: Submodule): string[] {
  const lines = [submodule.path, `${submoduleStateText[submodule.state].replace(/^./, (char) => char.toUpperCase())}: ${submoduleStateHint[submodule.state]}`];
  if (submodule.url) lines.push(submodule.url);
  lines.push(`${t("submodules.row.tipRecorded", { sha: shortSha(submodule.sha) })}${submodule.headSha && submodule.headSha !== submodule.sha ? t("submodules.row.tipCheckedOut", { head: shortSha(submodule.headSha) }) : ""}`);
  if (submodule.trackingBranch) lines.push(t("submodules.row.tipTracking", { branch: submodule.trackingBranch }));
  if (submodule.name !== submodule.path) lines.push(t("submodules.row.tipName", { name: submodule.name }));
  return lines;
}

export function matchesSubmodule(submodule: Submodule, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return submodule.path.toLowerCase().includes(needle) || (submodule.url?.toLowerCase().includes(needle) ?? false) || submodule.name.toLowerCase().includes(needle);
}
