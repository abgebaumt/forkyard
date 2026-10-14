import { describe, expect, it } from "vitest";
import { getCommands } from "../../app/registry";
import { useAppStore } from "../../app/store";
import { backLabel } from "../FileView/nav";
import { openStats, rememberChoice, rememberedChoice } from "./actions";

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
});
