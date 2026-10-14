import { describe, expect, it } from "vitest";
import type { RepoStats, StatsAuthor, StatsBucket, StatsFolder } from "../../core";
import { authorPalette, folderSegments, hotspotSeverity, initials, knowledgeRows, statusOf, timeTicks } from "./layout";

const author = (name: string, email: string, commits: number): StatsAuthor => ({ name, email, commits, added: 0, removed: 0, firstAt: "", lastAt: "" });
const folder = (path: string, weight: number, top: [string, string, number][]): StatsFolder => ({
  path,
  weight,
  authors: top.length,
  mainAuthor: { name: top[0]?.[0] ?? "", email: top[0]?.[1] ?? "" },
  mainShare: 0,
  busFactor: 1,
  top: top.map(([name, email, w]) => ({ author: { name, email }, weight: w })),
});

describe("author colours", () => {
  it("the first eight authors get a lane colour each, matched by address like the core", () => {
    const authors = Array.from({ length: 10 }, (_, n) => author(`P${n}`, `p${n}@example.com`, 10 - n));
    const palette = authorPalette(authors);
    expect(palette.of({ name: "P0", email: "P0@Example.com " })).toBe(1);
    expect(palette.of({ name: "P7", email: "p7@example.com" })).toBe(8);
    expect(palette.of({ name: "P8", email: "p8@example.com" })).toBeNull();
    expect(authorPalette([author("Dan", "", 1)]).of({ name: "Dan", email: "" })).toBe(1);
  });

  it("initials of one or more names", () => {
    expect(initials("Maya Chen")).toBe("MC");
    expect(initials("Ada")).toBe("A");
    expect(initials("  jonas  von weber ")).toBe("JW");
    expect(initials("")).toBe("?");
  });
});

describe("knowledge per folder", () => {
  const palette = authorPalette([author("Ada", "ada@example.com", 5), author("Ben", "ben@example.com", 3)]);

  it("segments per top author in percent of the folder, the rest as others", () => {
    const segments = folderSegments(folder("src", 100, [["Ada", "ada@example.com", 60], ["Ben", "ben@example.com", 30]]), palette);
    expect(segments.map((s) => [s.name, s.percent, s.lane])).toEqual([
      ["Ada", 60, 1],
      ["Ben", 30, 2],
      [null, 10, null],
    ]);
    expect(folderSegments(folder("docs", 8, [["Ben", "ben@example.com", 8]]), palette).map((s) => s.percent)).toEqual([100]);
    expect(folderSegments(folder("empty", 0, []), palette)).toEqual([]);
  });

  it("the innermost folders, heaviest first; the root only when there is nothing else", () => {
    const root = folder("", 50, []);
    const list = [root, folder("src", 40, []), folder("src/app", 30, []), folder("src/lib", 5, []), folder("docs", 10, [])];
    expect(knowledgeRows(list, 6).map((f) => f.path)).toEqual(["src/app", "docs", "src/lib"]);
    expect(knowledgeRows(list, 2).map((f) => f.path)).toEqual(["src/app", "docs"]);
    expect(knowledgeRows([root], 6).map((f) => f.path)).toEqual([""]);
  });
});

describe("hotspots and time axis", () => {
  it("severity by the share of the top score", () => {
    expect([hotspotSeverity(30, 30), hotspotSeverity(20, 30), hotspotSeverity(10, 30), hotspotSeverity(1, 30)]).toEqual(["high", "medium", "low", "low"]);
    expect(hotspotSeverity(0, 0)).toBe("low");
  });

  const week = (period: string): StatsBucket => ({ period, commits: 1, added: 0, removed: 0 });

  it("weeks: a tick where a month starts, thinned to the limit", () => {
    const weeks = ["2025-01-27", "2025-02-03", "2025-02-10", "2025-03-03", "2025-03-10", "2025-04-07"].map(week);
    expect(timeTicks(weeks, 10).map((tick) => [tick.index, tick.period])).toEqual([
      [0, "2025-01"],
      [1, "2025-02"],
      [3, "2025-03"],
      [5, "2025-04"],
    ]);
    expect(timeTicks(weeks, 2).map((tick) => tick.period)).toEqual(["2025-01", "2025-03"]);
  });

  it("months: every month, thinned to the limit; nothing in, nothing out", () => {
    const months = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"].map(week);
    expect(timeTicks(months, 3).map((tick) => tick.period)).toEqual(["2025-01", "2025-03", "2025-05"]);
    expect(timeTicks([], 6)).toEqual([]);
  });
});

describe("status in the header", () => {
  const stats = (cached: boolean) => ({ tip: "t1", cached }) as RepoStats;

  it("updating while a run goes, otherwise whether the cache answered", () => {
    expect(statusOf({ kind: "running", jobId: "a", previous: null })).toBe("updating");
    expect(statusOf({ kind: "done", stats: stats(true) })).toBe("cached");
    expect(statusOf({ kind: "done", stats: stats(false) })).toBe("fresh");
    expect(statusOf({ kind: "idle" })).toBeNull();
    expect(statusOf({ kind: "done", stats: { ...stats(false), tip: null } })).toBeNull();
  });
});
