import { describe, expect, it } from "vitest";
import type { CustomCommandDef, CustomCommandList } from "../../core";
import type { MenuAction } from "../../ui/Menu";
import { qk, queryClient } from "../queries";
import { customCommandEntries } from "./custom";

const command = (id: string, title: string, scope: CustomCommandDef["scope"]): CustomCommandDef => ({
  id,
  title,
  kind: "shell",
  run: "make",
  cwd: "worktree",
  confirm: false,
  shell: false,
  inputs: [],
  scope,
});

const list: CustomCommandList = {
  commands: [
    { key: "global:bauen", source: "global", runnable: true, command: command("bauen", "Bauen", ["commit"]) },
    { key: "global:liste", source: "global", runnable: true, command: command("liste", "Liste", ["repo"]) },
    { key: "repo:ci", source: "repo", runnable: false, command: command("ci", "CI starten", ["commit", "branch"]) },
  ],
  repo: { state: "untrusted", hash: "abc", path: ".forkyard/commands.json", problems: [], changes: [] },
};

describe("custom commands in context menus", () => {
  it("adds a submenu with the commands of this scope; unapproved ones are disabled", () => {
    queryClient.setQueryData(qk.customCommands("r1"), list);
    const entries = customCommandEntries("r1", "commit", { sha: "abc1234" });
    expect(entries[0]).toEqual({ type: "separator" });
    const children = ((entries[1] as MenuAction).children ?? []) as MenuAction[];
    expect(children.map((child) => child.label)).toEqual(["Bauen", "CI starten"]);
    expect(typeof children[0]!.onSelect).toBe("function");
    expect(children[1]!.disabled).toBe(true);
    expect(children[1]!.onSelect).toBeUndefined();
  });

  it("adds nothing without commands for the scope or without loaded data", () => {
    queryClient.setQueryData(qk.customCommands("r1"), list);
    expect(customCommandEntries("r1", "submodule", {})).toEqual([]);
    expect(customCommandEntries("unbekannt", "commit", {})).toEqual([]);
  });
});
