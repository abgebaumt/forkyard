/**
 * Settings sections, their level (global, profile, project) and the search terms per section.
 * The terms are the titles of the rows in the section (plus a few common words for them); the
 * search counts matches per section. Both are in the UI language (locales/<language>/preferences.json).
 */
import { t } from "../../i18n";

export type Level = "global" | "profile" | "project" | "help";

export type SectionId =
  | "appearance"
  | "diff"
  | "external"
  | "commands"
  | "notifications"
  | "identity"
  | "git"
  | "ssh"
  | "credentials"
  | "integrations"
  | "network"
  | "p-identity"
  | "p-git"
  | "p-files"
  | "p-links"
  | "about";

export interface SectionDef {
  id: SectionId;
  level: Level;
  label: string;
  /** Titles and keywords of the rows in the section, for the search. */
  keywords: string[];
}

const section = (id: SectionId, level: Level, key: string): SectionDef => ({
  id,
  level,
  label: t(`preferences.sections.${key}.label`),
  keywords: t(`preferences.sections.${key}.keywords`).split("|"),
});

export const SECTIONS: SectionDef[] = [
  section("appearance", "global", "appearance"),
  section("diff", "global", "diff"),
  section("external", "global", "external"),
  section("commands", "global", "commands"),
  section("notifications", "global", "notifications"),
  section("identity", "profile", "identity"),
  section("git", "profile", "git"),
  section("ssh", "profile", "ssh"),
  section("credentials", "profile", "credentials"),
  section("integrations", "profile", "integrations"),
  section("network", "profile", "network"),
  section("p-identity", "project", "pIdentity"),
  section("p-git", "project", "pGit"),
  section("p-files", "project", "pFiles"),
  section("p-links", "project", "pLinks"),
  section("about", "help", "about"),
];

export function visibleSections(hasRepo: boolean): SectionDef[] {
  return SECTIONS.filter((section) => hasRepo || section.level !== "project");
}

/** Section → number of matching keywords; an empty search yields an empty list. */
export function searchSections(query: string, sections: SectionDef[]): Map<SectionId, number> {
  const wanted = query.trim().toLowerCase();
  const hits = new Map<SectionId, number>();
  if (!wanted) return hits;
  for (const section of sections) {
    const count = section.keywords.filter((keyword) => keyword.toLowerCase().includes(wanted)).length;
    if (count > 0) hits.set(section.id, count);
  }
  return hits;
}
