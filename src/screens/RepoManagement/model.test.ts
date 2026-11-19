import { describe, expect, it } from "vitest";
import type { Repo } from "../../core";
import { t } from "../../i18n";
import { buildItems, groupNames, matches, summarize, type RowStatus } from "./model";

const repo = (id: string, patch: Partial<Repo> = {}): Repo => ({
  id,
  path: `/home/anna/${id}`,
  name: id,
  alias: null,
  isFavorite: false,
  groupName: null,
  color: null,
  lastOpenedAt: null,
  missing: false,
  trusted: true,
  ...patch,
});

const REPOS = [
  repo("wetter", { isFavorite: true, groupName: "Kunde 10" }),
  repo("karte", { groupName: "Kunde 9", alias: "Kartendienst" }),
  repo("portal", { groupName: "Kunde 10" }),
  repo("notizen"),
];

describe("repository list", () => {
  it("searches alias, name, path and group with every word", () => {
    expect(matches(REPOS[1]!, [])).toBe(true);
    expect(matches(REPOS[1]!, ["kartend", "kunde"])).toBe(true);
    expect(matches(REPOS[1]!, ["kartend", "portal"])).toBe(false);
    expect(matches(REPOS[3]!, ["/home/anna/not"])).toBe(true);
  });

  it("sorts group names numerically", () => expect(groupNames(REPOS)).toEqual(["Kunde 9", "Kunde 10"]));

  const shape = (items: ReturnType<typeof buildItems>) =>
    items.map((item) => (item.kind === "header" ? `# ${item.label} (${item.count})${item.group ? " g" : ""}` : item.repo.id));

  it("lists favourites first, then the rest by last opened", () => {
    expect(shape(buildItems(REPOS, "recent"))).toEqual([
      `# ${t("repos.sections.favorites")} (1)`,
      "wetter",
      `# ${t("repos.sections.recent")} (3)`,
      "karte",
      "portal",
      "notizen",
    ]);
  });

  it("groups the rest by group, ungrouped last; empty sections are left out", () => {
    expect(shape(buildItems(REPOS, "groups"))).toEqual([
      `# ${t("repos.sections.favorites")} (1)`,
      "wetter",
      "# Kunde 9 (1) g",
      "karte",
      "# Kunde 10 (1) g",
      "portal",
      `# ${t("repos.sections.ungrouped")} (1)`,
      "notizen",
    ]);
    expect(buildItems([], "groups")).toEqual([]);
  });
});

describe("group sync summary", () => {
  const rows = (...statuses: RowStatus[]) => statuses.map((status) => ({ status }));

  it("shows progress while repositories are open", () => {
    expect(summarize(rows("done", "running", "waiting"), "fetch")).toBe(t("repos.sync.summary.progress", { done: 1, total: 3 }));
  });

  it("counts how each repository ended", () => {
    expect(summarize(rows("done", "done", "unchanged", "failed"), "pull")).toBe(
      [
        t("repos.sync.summary.updated", { count: 2 }),
        t("repos.sync.summary.unchanged", { count: 1 }),
        t("repos.sync.summary.failed", { count: 1 }),
      ].join(" · "),
    );
    expect(summarize(rows("done", "attention", "cancelled"), "fetch")).toBe(
      [
        t("repos.sync.summary.withNew", { count: 1 }),
        t("repos.sync.summary.attention", { count: 1 }),
        t("repos.sync.summary.cancelled", { count: 1 }),
      ].join(" · "),
    );
  });
});
