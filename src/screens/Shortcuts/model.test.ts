import { describe, expect, it } from "vitest";
import type { AppCommand } from "../../app/commandTypes";
import { t } from "../../i18n";
import { GROUP_TITLES, filterSections, fixedSections, registrySections } from "./model";

const command = (id: string, group: AppCommand["group"], shortcut?: string, title = id): AppCommand =>
  ({ id, title, group, shortcut, run: () => undefined }) as AppCommand;

describe("shortcut overview", () => {
  const commands = [
    command("sync.pull", "Remote", "Mod+Shift+P", "Pull …"),
    command("tab.new", "Tabs", "Mod+T"),
    ...Array.from({ length: 8 }, (_, index) => command(`tab.goto.${index + 1}`, "Tabs", `Mod+${index + 1}`)),
    command("app.palette", "General", "Mod+K"),
    command("no.keys", "General"),
  ];

  it("groups commands with a shortcut in the palette's order and folds Mod+1 … Mod+8 into one row", () => {
    const sections = registrySections(commands);
    expect(sections.map((section) => section.title)).toEqual([GROUP_TITLES.General, GROUP_TITLES.Tabs, GROUP_TITLES.Remote]);
    expect(sections[1]!.entries).toEqual([
      { key: "tab.new", label: "tab.new", keys: [["Mod+T"]] },
      { key: "tab.goto.range", label: t("shortcuts.gotoTabRange", { count: 8 }), keys: [["Mod+1", "…", "Mod+8"]] },
    ]);
    expect(sections[2]!.entries[0]!.label, "without the trailing ellipsis").toBe("Pull");
  });

  it("filters by label, group and keys with every word", () => {
    const sections = registrySections(commands);
    expect(filterSections(sections, "")).toBe(sections);
    expect(filterSections(sections, "pull").map((section) => section.entries.map((entry) => entry.key))).toEqual([["sync.pull"]]);
    expect(filterSections(sections, "mod+t").flatMap((section) => section.entries.map((entry) => entry.key))).toEqual(["tab.new"]);
    expect(filterSections(sections, "pull tabs")).toEqual([]);
  });

  it("lists every fixed key group with entries", () => {
    const sections = fixedSections(commands);
    expect(sections.length).toBeGreaterThan(3);
    for (const section of sections) expect(section.entries.length, section.id).toBeGreaterThan(0);
  });

  it("shows the effective keys of the registry commands among the fixed keys", () => {
    const keys = (list: AppCommand[]) =>
      fixedSections(list)
        .find((section) => section.id === "fixed-file")!
        .entries.find((entry) => entry.label === t("ui.fileHistory"))?.keys;
    expect(keys([command("file.history", "File", "Alt+H")])).toEqual([["Alt+H"]]);
    expect(keys([command("file.history", "File")]), "without a key the row is left out").toBeUndefined();
  });
});

describe("shortcut overview in edit mode", () => {
  const tabs = [
    command("tab.new", "Tabs", "Mod+T"),
    ...Array.from({ length: 8 }, (_, index) => command(`tab.goto.${index + 1}`, "Tabs", `Mod+${index + 1}`)),
  ];
  const ids = (sections: ReturnType<typeof registrySections>) => sections.flatMap((section) => section.entries.map((entry) => entry.key));

  it("in edit mode every command is a row, also without a key", () => {
    const list = [command("app.palette", "General", "Mod+K"), command("no.keys", "General")];
    expect(ids(registrySections(list, { editing: true }))).toEqual(["app.palette", "no.keys"]);
    expect(ids(registrySections(list))).toEqual(["app.palette"]);
    expect(registrySections(list, { editing: true })[0]!.entries[1]!.keys).toEqual([]);
  });

  it("the tab range collapses only with all defaults", () => {
    expect(ids(registrySections(tabs))).toEqual(["tab.new", "tab.goto.range"]);
    const rebound = tabs.map((item) => (item.id === "tab.goto.3" ? { ...item, shortcut: "Mod+Alt+3" } : item));
    expect(ids(registrySections(rebound))).toHaveLength(9);
    expect(ids(registrySections(tabs, { editing: true })), "each tab is editable").toHaveLength(9);
  });
});
