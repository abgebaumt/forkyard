/** Pure parts of the shortcut overview: sections from the registry and the fixed keys, and the filter. */
import type { AppCommand, CommandGroup } from "../../app/commandTypes";
import { formatShortcut } from "../../ui/shortcut";
import { fold } from "../CommandPalette/fuzzy";
import { fixedKeyGroups } from "./fixedKeys";
import { t } from "../../i18n";

export interface Entry {
  key: string;
  label: string;
  /** Alternatives; an alternative with "…" in between is a range (Ctrl+1 … Ctrl+8). */
  keys: string[][];
}

export interface Section {
  id: string;
  title: string;
  where?: string;
  entries: Entry[];
}

export const GROUP_ORDER: CommandGroup[] = ["General", "View", "Tabs", "Repository", "Remote", "Branch", "Commit", "Stash", "File"];
export const GROUP_TITLES: Record<CommandGroup, string> = {
  General: t("ui.general"),
  View: t("shortcuts.groups.view"),
  Tabs: t("shortcuts.groups.tabs"),
  Repository: t("ui.repository"),
  Remote: t("ui.remote"),
  Branch: t("ui.branch"),
  Commit: t("ui.commit"),
  Stash: t("ui.stash"),
  File: t("ui.file"),
};

export function registrySections(commands: readonly AppCommand[]): Section[] {
  const withKeys = commands.filter((command) => command.shortcut);
  const sections: Section[] = [];
  for (const group of GROUP_ORDER) {
    const list = withKeys.filter((command) => command.group === group);
    if (!list.length) continue;
    const entries: Entry[] = [];
    // Ctrl+1 … Ctrl+8 as one row instead of eight.
    const numbered = list.filter((command) => /^tab\.goto\.[1-8]$/.test(command.id));
    for (const command of list) {
      if (numbered.includes(command)) {
        if (command === numbered[0]) {
          entries.push({
            key: "tab.goto.range",
            label: t("shortcuts.gotoTabRange", { count: numbered.length }),
            keys: [[numbered[0]!.shortcut!, "…", numbered[numbered.length - 1]!.shortcut!]],
          });
        }
        continue;
      }
      entries.push({ key: command.id, label: command.title.replace(/ …$/, ""), keys: [[command.shortcut!]] });
    }
    sections.push({ id: `group-${group}`, title: GROUP_TITLES[group], entries });
  }
  return sections;
}

export const fixedSections: Section[] = fixedKeyGroups.map((group) => ({
  id: `fixed-${group.id}`,
  title: group.title,
  where: group.where,
  entries: group.entries.map((entry, index) => ({ key: `${group.id}-${index}`, label: entry.label, keys: entry.keys.map((key) => [key]) })),
}));

export function searchText(section: Section, entry: Entry): string {
  const keys = entry.keys.flat().map((key) => `${key} ${formatShortcut(key)}`);
  return fold(`${entry.label} ${section.title} ${keys.join(" ")}`);
}

export function filterSections(sections: Section[], query: string): Section[] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  const out: Section[] = [];
  for (const section of sections) {
    const entries = section.entries.filter((entry) => {
      const text = searchText(section, entry);
      return words.every((word) => text.includes(word));
    });
    if (entries.length) out.push({ ...section, entries });
  }
  return out;
}
