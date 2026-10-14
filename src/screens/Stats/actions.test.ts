import { describe, expect, it } from "vitest";
import { getCommands } from "../../app/registry";
import { useAppStore } from "../../app/store";
import { backLabel } from "../FileView/nav";
import { closeStats, leaveStats, openStats, rememberChoice, rememberedChoice, toggleStats } from "./actions";

describe("opening the statistics", () => {
  it("puts the statistics into the centre of the tab", () => {
    openStats("tab-stats");
    expect(useAppStore.getState().views["tab-stats"]?.center).toEqual({ kind: "stats" });
  });

  it("is a palette command of the open repository, without a shortcut", () => {
    const command = getCommands().find((item) => item.id === "stats.show");
    expect(command?.title).toBe("Show statistics");
    expect(command?.group).toBe("Repository");
    expect(command?.shortcut).toBeUndefined();
  });

  it("the file history opened from the statistics leads back to them", () => {
    expect(backLabel({ kind: "stats" })).toBe("Back to the statistics");
  });

  it("remembers period and branch per tab for the way back from a file history", () => {
    expect(rememberedChoice("tab-a")).toEqual({ preset: "all", ref: "HEAD" });
    rememberChoice("tab-a", { preset: "month", ref: "refs/heads/main" });
    expect(rememberedChoice("tab-a")).toEqual({ preset: "month", ref: "refs/heads/main" });
    expect(rememberedChoice("tab-b")).toEqual({ preset: "all", ref: "HEAD" });
  });

  it("the Stats button toggles: open, and close back to the view before", () => {
    const store = useAppStore.getState();
    store.openHistory("tab-t", "src/a.ts");
    toggleStats("tab-t");
    expect(useAppStore.getState().views["tab-t"]?.center).toEqual({ kind: "stats" });
    toggleStats("tab-t");
    expect(useAppStore.getState().views["tab-t"]?.center).toEqual({ kind: "history", path: "src/a.ts" });
    toggleStats("tab-t");
    closeStats("tab-t");
    expect(useAppStore.getState().views["tab-t"]?.center).toEqual({ kind: "history", path: "src/a.ts" });
  });

  it("nothing else closes the open statistics: diffs from the side panels, back to the graph, other views", () => {
    const store = useAppStore.getState();
    openStats("tab-k");
    store.openDiff("tab-k", "a.txt", { kind: "unstaged" });
    store.closeCenter("tab-k");
    store.openConflict("tab-k", "a.txt");
    store.revealCommit("tab-k", "abc");
    store.setCenter("tab-k", { kind: "graph" });
    const view = useAppStore.getState().views["tab-k"];
    expect(view?.center).toEqual({ kind: "stats" });
    expect(view?.selection, "the selection still follows").toEqual({ kind: "commits", shas: ["abc"] });
  });

  it("the view's own links leave it on purpose", () => {
    openStats("tab-l");
    leaveStats(() => useAppStore.getState().openHistory("tab-l", "src/b.ts"));
    expect(useAppStore.getState().views["tab-l"]?.center).toEqual({ kind: "history", path: "src/b.ts" });
  });

  it("opening it again from the palette keeps it open", () => {
    openStats("tab-p");
    openStats("tab-p");
    expect(useAppStore.getState().views["tab-p"]?.center).toEqual({ kind: "stats" });
  });
});
