/** Pure parts of the remote dialog: the host badge from the URL and the checks before saving. */
import type { RemoteHost } from "../../core";
import { hostKindOf, refNameIssue } from "../../app/paths";
import { t } from "../../i18n";

// Detect the host from the URL (only for the badge at the field; the core is authoritative).

const hostNames: Record<Exclude<RemoteHost, "other">, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
};

export interface DetectedHost {
  kind: RemoteHost | "local";
  /** Badge text, e.g. "GitHub" or the server name. */
  label: string;
}

/** `https://github.com/a/b.git`, `ssh://git@host:22/a`, `git@host:a/b.git`, `C:\pfad`, `/pfad`, `file:///pfad`. */
export function detectHost(url: string): DetectedHost | null {
  const text = url.trim();
  if (!text) return null;
  if (/^file:\/\//i.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^[\\/.~]/.test(text))
    return { kind: "local", label: t("remotes.host.localPath") };
  let host: string | null = null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^/:\s]+)/i.exec(text);
  if (withScheme) host = withScheme[1] ?? null;
  else {
    const scpLike = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)/.exec(text);
    if (scpLike) host = scpLike[1] ?? null;
  }
  if (!host?.includes(".")) return null;
  const kind = hostKindOf(host.toLowerCase());
  return { kind, label: kind === "other" ? host : hostNames[kind] };
}

// Checks before submitting.

export function checkName(name: string, others: string[]): string | null {
  if (!name) return t("remotes.validation.nameMissing");
  const issue = refNameIssue(name)?.issue;
  if (issue === "space") return t("remotes.validation.nameSpaces");
  if (issue === "char" || issue === "doubleDot" || issue === "atBrace") return t("remotes.validation.nameChars");
  if (issue && issue !== "reserved") return t("remotes.validation.nameEdges");
  if (others.includes(name)) return t("remotes.validation.nameExists", { name });
  return null;
}

export function checkUrl(url: string): string | null {
  if (!url) return t("remotes.validation.urlMissing");
  if (/\s/.test(url) && !detectLocal(url)) return t("remotes.validation.urlSpaces");
  return null;
}

const detectLocal = (url: string) => detectHost(url)?.kind === "local";
