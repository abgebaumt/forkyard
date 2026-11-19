import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../core";
import { failed, formatDuration, formatLogTime, visibleEntries } from "./model";

const entry = (id: string, command: string, exitCode: number | null, output = ""): ActivityEntry => ({
  id,
  scope: "repo",
  repoId: null,
  startedAt: "2026-03-04T10:00:00Z",
  durationMs: 5,
  command,
  exitCode,
  output,
  code: null,
});

describe("activity log", () => {
  it("formats durations", () => {
    expect(formatDuration(-3)).toBe("0 ms");
    expect(formatDuration(840)).toBe("840 ms");
    expect(formatDuration(1300)).toMatch(/^1[.,]3 s$/);
    expect(formatDuration(125_000)).toBe("2 min 05 s");
  });

  it("shows only the clock today and the date on other days; bad times stay as they are", () => {
    const at = new Date(2026, 2, 4, 10, 0, 7);
    const today = formatLogTime(at.toISOString(), new Date(2026, 2, 4, 18, 0));
    const earlier = formatLogTime(at.toISOString(), new Date(2026, 2, 5, 9, 0));
    expect(today).toMatch(/10.00.07/);
    expect(earlier.length).toBeGreaterThan(today.length);
    expect(earlier).not.toContain(",");
    expect(formatLogTime("kaputt")).toBe("kaputt");
  });

  it("filters by failure and by text in command or output", () => {
    const list = [entry("1", "git fetch", 0), entry("2", "git push", 1, "rejected"), entry("3", "git status", null)];
    expect(list.filter(failed).map((e) => e.id)).toEqual(["2"]);
    expect(visibleEntries(list, true, "").map((e) => e.id)).toEqual(["2"]);
    expect(visibleEntries(list, false, "rejected").map((e) => e.id)).toEqual(["2"]);
    expect(visibleEntries(list, false, "git").map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(visibleEntries(list, true, "fetch")).toEqual([]);
  });
});
