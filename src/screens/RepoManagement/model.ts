/** Pure parts of the repository list: search and the sections it is grouped into. */
import type { Repo } from "../../core";
import { locale, t } from "../../i18n";
import type { ListItem } from "./RepoList";

export type Grouping = "recent" | "groups";

/** State of one repository in a group fetch or pull. */
export type RowStatus = "waiting" | "running" | "done" | "unchanged" | "attention" | "failed" | "cancelled";

const collator = new Intl.Collator(locale(), { sensitivity: "base", numeric: true });

/** The group names in use, sorted (numbers in names count as numbers). */
export const groupNames = (repos: Repo[]): string[] =>
  [...new Set(repos.flatMap((repo) => (repo.groupName ? [repo.groupName] : [])))].sort(collator.compare);

/** Every search word occurs in alias, name, path or group. */
export function matches(repo: Repo, words: string[]): boolean {
  if (!words.length) return true;
  const text = `${repo.alias ?? ""}\n${repo.name}\n${repo.path}\n${repo.groupName ?? ""}`.toLocaleLowerCase(locale());
  return words.every((word) => text.includes(word));
}

export function buildItems(repos: Repo[], grouping: Grouping): ListItem[] {
  const items: ListItem[] = [];
  const section = (key: string, label: string, list: Repo[], group?: string) => {
    if (!list.length) return;
    items.push({ kind: "header", key: `header:${key}`, label, count: list.length, group });
    for (const repo of list) items.push({ kind: "repo", key: repo.id, repo });
  };
  // The core already returns the list sorted by "last opened".
  section(
    "favorites",
    t("repos.sections.favorites"),
    repos.filter((repo) => repo.isFavorite),
  );
  const rest = repos.filter((repo) => !repo.isFavorite);
  if (grouping === "groups") {
    const names = groupNames(rest);
    for (const name of names)
      section(
        `group:${name}`,
        name,
        rest.filter((repo) => repo.groupName === name),
        name,
      );
    section(
      "ungrouped",
      t("repos.sections.ungrouped"),
      rest.filter((repo) => !repo.groupName),
    );
  } else {
    section("recent", t("repos.sections.recent"), rest);
  }
  return items;
}

/** The line under the list: progress while running, then how many repositories ended which way. */
export function summarize(rows: { status: RowStatus }[], kind: "fetch" | "pull"): string {
  const count = (status: RowStatus) => rows.filter((row) => row.status === status).length;
  const open = count("waiting") + count("running");
  if (open) return t("repos.sync.summary.progress", { done: rows.length - open, total: rows.length });
  const parts: string[] = [];
  const done = count("done");
  if (done)
    parts.push(kind === "fetch" ? t("repos.sync.summary.withNew", { count: done }) : t("repos.sync.summary.updated", { count: done }));
  if (count("unchanged")) parts.push(t("repos.sync.summary.unchanged", { count: count("unchanged") }));
  if (count("attention")) parts.push(t("repos.sync.summary.attention", { count: count("attention") }));
  if (count("failed")) parts.push(t("repos.sync.summary.failed", { count: count("failed") }));
  if (count("cancelled")) parts.push(t("repos.sync.summary.cancelled", { count: count("cancelled") }));
  return parts.join(" · ");
}
