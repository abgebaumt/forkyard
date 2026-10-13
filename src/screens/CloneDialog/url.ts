/** Reading clone URLs: kind, server, host and a suggestion for the folder name. */
import type { RemoteHost } from "../../core";
import { t } from "../../i18n";

export type UrlKind = "https" | "http" | "ssh" | "git" | "file" | "local";

export interface ParsedUrl {
  ok: true;
  kind: UrlKind;
  /** Server name in lower case; null for local paths and file://. */
  host: string | null;
  hoster: RemoteHost | null;
  /** Suggestion for the folder name, may be empty. */
  name: string;
}

export type UrlCheck = ParsedUrl | { ok: false; reason: string };

const SCHEMES: Record<string, UrlKind | null> = {
  https: "https",
  http: "http",
  ssh: "ssh",
  "git+ssh": "ssh",
  "ssh+git": "ssh",
  git: "git",
  file: "file",
  // Git could do it, but there is no sign-in for it here.
  ftp: null,
  ftps: null,
};

function hosterOf(host: string): RemoteHost {
  const labels = host.split(".");
  if (host === "dev.azure.com" || host.endsWith(".dev.azure.com") || host.endsWith(".visualstudio.com")) return "azure";
  if (labels.includes("github")) return "github";
  if (labels.includes("gitlab")) return "gitlab";
  if (labels.includes("bitbucket")) return "bitbucket";
  return "other";
}

/** Last path segment without “.git”, cleaned of characters that are not allowed in folder names. */
export function suggestName(pathPart: string): string {
  const clean = pathPart.replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  const last = clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"), clean.lastIndexOf(":")) + 1);
  let name = last.replace(/\.git$/i, "");
  try {
    name = decodeURIComponent(name);
  } catch {
    // kaputte %-Folge: so lassen
  }
  return name.replace(/[<>:"|?*\\/]/g, "-").replace(/^[\s.]+|[\s.]+$/g, "");
}

const hostFrom = (authority: string) => {
  const withoutUser = authority.slice(authority.lastIndexOf("@") + 1);
  // Keep IPv6 in square brackets, otherwise cut off the port.
  const host = withoutUser.startsWith("[") ? withoutUser.slice(0, withoutUser.indexOf("]") + 1) : withoutUser.replace(/:\d*$/, "");
  return host.toLowerCase();
};

/**
 * What follows the server name after a colon is the port in a URL with “://”:
 * a number from 1 to 65535. `null` = fine (also without a port).
 */
function portProblem(authority: string, scheme: string): string | null {
  const withoutUser = authority.slice(authority.lastIndexOf("@") + 1);
  const afterHost = withoutUser.startsWith("[") ? withoutUser.slice(withoutUser.indexOf("]") + 1) : withoutUser.slice(withoutUser.includes(":") ? withoutUser.indexOf(":") : withoutUser.length);
  if (!afterHost.startsWith(":") || afterHost === ":") return null;
  const port = afterHost.slice(1);
  if (!/^\d+$/.test(port)) {
    const shown = port.length > 24 ? `${port.slice(0, 24)}…` : port;
    return t(scheme.includes("ssh") ? "clone.parse.portNotNumberSsh" : "clone.parse.portNotNumber", { port: shown, scheme });
  }
  const number = Number(port);
  if (number < 1 || number > 65535) return t("clone.parse.portRange", { port: port.length > 8 ? `${port.slice(0, 8)}…` : port });
  return null;
}

/**
 * Recognises https://…, ssh://…, git@host:path, file://… and local paths.
 * `reason` is a ready-made sentence for the field.
 */
export function parseCloneUrl(raw: string): UrlCheck {
  const url = raw.trim();
  if (!url) return { ok: false, reason: t("clone.validation.urlMissing") };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(url)) return { ok: false, reason: t("clone.parse.control") };
  if (url.startsWith("-")) return { ok: false, reason: t("clone.parse.dash") };

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(url);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    const rest = scheme[2]!;
    const kind = SCHEMES[name];
    if (kind === undefined || kind === null) {
      return { ok: false, reason: t("clone.parse.scheme", { scheme: name }) };
    }
    if (!rest) return { ok: false, reason: t("clone.parse.restMissing") };
    if (kind === "file") return { ok: true, kind, host: null, hoster: null, name: suggestName(rest) };
    if (/\s/.test(url)) return { ok: false, reason: t("clone.parse.spaces") };
    const slash = rest.indexOf("/");
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const host = hostFrom(authority);
    if (!host) return { ok: false, reason: t("clone.parse.hostMissing") };
    const badPort = portProblem(authority, name);
    if (badPort) return { ok: false, reason: badPort };
    const path = slash < 0 ? "" : rest.slice(slash + 1);
    if (!path.replace(/\/+$/, "")) return { ok: false, reason: t("clone.parse.pathMissing") };
    return { ok: true, kind, host, hoster: hosterOf(host), name: suggestName(path) };
  }

  // “ssh:/host/…” – one slash too few. Git would read this as a server named “ssh” and later report
  // that it is unreachable.
  const half = /^([A-Za-z][A-Za-z0-9+.-]+):\/(?!\/)/.exec(url);
  if (half && half[1]!.toLowerCase() in SCHEMES) {
    const name = half[1]!.toLowerCase();
    return { ok: false, reason: t("clone.parse.slashes", { scheme: name }) };
  }

  // Transport helpers like “ext::” start arbitrary programs.
  if (/^[A-Za-z0-9+.-]+::/.test(url)) return { ok: false, reason: t("clone.parse.helper") };

  // Lokale Pfade: C:\…, \\server\freigabe, /…, ./…, ../…, ~/…
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith("\\\\") || /^(\/|\.\.?[\\/]|~[\\/])/.test(url)) {
    return { ok: true, kind: "local", host: null, hoster: null, name: suggestName(url) };
  }

  // scp-like: [user@]host:path – there is no slash before the colon.
  const scp = /^(?:([^@\s/:]+)@)?([^@\s/:]+):(.*)$/.exec(url);
  if (scp) {
    const host = scp[2]!.toLowerCase();
    const path = scp[3]!;
    if (/\s/.test(url)) return { ok: false, reason: t("clone.parse.spaces") };
    if (!path.replace(/\/+$/, "")) return { ok: false, reason: t("clone.parse.scpPathMissing") };
    return { ok: true, kind: "ssh", host, hoster: hosterOf(host), name: suggestName(path) };
  }

  return {
    ok: false,
    reason: t("clone.parse.incomplete"),
  };
}

const HOSTER_NAMES: Record<RemoteHost, string | null> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
  other: null,
};

const KIND_NAMES: Record<UrlKind, string> = {
  https: "HTTPS",
  http: t("clone.kind.http"),
  ssh: "SSH",
  git: t("clone.kind.git"),
  file: t("clone.kind.local"),
  local: t("clone.kind.local"),
};

/** Short badge on the URL field, e.g. “GitHub · SSH” or “Local folder”. */
export function describeUrl(parsed: ParsedUrl): string {
  if (parsed.kind === "local" || parsed.kind === "file") return t("clone.kind.localFolder");
  const who = (parsed.hoster && HOSTER_NAMES[parsed.hoster]) ?? parsed.host ?? "";
  return who ? `${who} · ${KIND_NAMES[parsed.kind]}` : KIND_NAMES[parsed.kind];
}
