/**
 * Project settings inherit from the profile until an own value is set. Here each field defines
 * what "own value" means, what is inherited and what override and reset look like.
 */
import type { Id, Profile, RepoSettings, Settings } from "../../core";

export type InheritKey = "authorName" | "authorEmail" | "sshKeyId" | "defaultPullMode" | "autoFetch";

export interface InheritContext {
  profile: Profile;
  settings: Settings;
  /** The profile's default key; null = none (SSH agent or the user's configuration). */
  defaultKeyId: Id | null;
}

export interface Inherited {
  own: boolean;
  value: unknown;
  inherited: unknown;
}

const blank = (value: string | null | undefined) => value == null || value.trim() === "";

function inheritedOf(key: InheritKey, ctx: InheritContext): unknown {
  switch (key) {
    case "authorName":
      return ctx.profile.authorName;
    case "authorEmail":
      return ctx.profile.authorEmail;
    case "sshKeyId":
      return ctx.defaultKeyId;
    case "defaultPullMode":
      return ctx.settings.defaultPullMode;
    // Per repository the core only knows on/off; "on" follows the profile's interval.
    case "autoFetch":
      return true;
  }
}

function isOwn(key: InheritKey, repo: RepoSettings): boolean {
  switch (key) {
    case "authorName":
      return !blank(repo.authorName);
    case "authorEmail":
      return !blank(repo.authorEmail);
    case "sshKeyId":
      return repo.sshKeyId != null;
    case "defaultPullMode":
      return repo.defaultPullMode != null;
    case "autoFetch":
      return repo.autoFetch === false;
  }
}

export function inheritedValue(key: InheritKey, repo: RepoSettings, ctx: InheritContext): Inherited {
  const inherited = inheritedOf(key, ctx);
  const own = isOwn(key, repo);
  return { own, value: own ? repo[key] : inherited, inherited };
}

/** How many of the fields have an own value (for "n own" in the navigation). */
export function ownCount(repo: RepoSettings, keys: InheritKey[]): number {
  return keys.filter((key) => isOwn(key, repo)).length;
}

export function resetPatch(key: InheritKey): Partial<RepoSettings> {
  return key === "autoFetch" ? { autoFetch: true } : ({ [key]: null } as Partial<RepoSettings>);
}

export function overridePatch(key: InheritKey, ctx: InheritContext): Partial<RepoSettings> {
  return key === "autoFetch" ? { autoFetch: false } : ({ [key]: inheritedOf(key, ctx) } as Partial<RepoSettings>);
}

/** Fields per project section. */
export const SECTION_KEYS = { "p-identity": ["authorName", "authorEmail", "sshKeyId"], "p-git": ["defaultPullMode", "autoFetch"] } satisfies Record<string, InheritKey[]>;
