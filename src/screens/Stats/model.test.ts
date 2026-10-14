import { describe, expect, it } from "vitest";
import type { Ref, RefsSnapshot, StatsBucket, StatsFile } from "../../core";
import { ageShares, buildTree, currentTip, defaultGranularity, fillMonths, fillWeeks, findNode, heatLevels, parentFolder, rangeFor, squarify } from "./model";

const bucket = (period: string, commits: number): StatsBucket => ({ period, commits, added: commits, removed: 0 });

describe("periods", () => {
  const now = Date.UTC(2026, 9, 14, 15, 30);

  it("all time leaves both ends open", () => {
    expect(rangeFor("all", "HEAD", now)).toEqual({ from: null, to: null, ref: "HEAD" });
  });

  it("presets start at midnight UTC, so the cache stays valid for the day", () => {
    expect(rangeFor("month", "refs/heads/main", now)).toEqual({ from: "2026-09-14T00:00:00.000Z", to: null, ref: "refs/heads/main" });
    expect(rangeFor("quarter", "HEAD", now).from).toBe("2026-07-16T00:00:00.000Z");
    expect(rangeFor("year", "HEAD", now).from).toBe("2025-10-14T00:00:00.000Z");
    expect(rangeFor("month", "HEAD", Date.UTC(2026, 9, 14, 23, 59))).toEqual(rangeFor("month", "HEAD", now));
  });
});

describe("time series", () => {
  it("fills missing weeks with zeros", () => {
    expect(fillWeeks([bucket("2025-06-02", 5), bucket("2025-06-16", 3)]).map((b) => [b.period, b.commits])).toEqual([
      ["2025-06-02", 5],
      ["2025-06-09", 0],
      ["2025-06-16", 3],
    ]);
  });

  it("fills missing months across the turn of the year", () => {
    expect(fillMonths([bucket("2024-11", 1), bucket("2025-02", 2)]).map((b) => b.period)).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
  });

  it("nothing in, nothing out; weeks up to two years, months beyond", () => {
    expect(fillWeeks([])).toEqual([]);
    expect(defaultGranularity(Array.from({ length: 104 }, (_, i) => bucket(String(i), 1)))).toBe("weeks");
    expect(defaultGranularity(Array.from({ length: 105 }, (_, i) => bucket(String(i), 1)))).toBe("months");
  });
});

describe("heatmap and code age", () => {
  it("levels are quarters of the busiest cell, any commit at least level 1", () => {
    expect(heatLevels([[0, 1, 4, 8]])).toEqual([[0, 1, 2, 4]]);
    expect(heatLevels([[0, 0]])).toEqual([[0, 0]]);
  });

  it("code age shares in percent", () => {
    expect(ageShares({ files: 3, skipped: 0, month: 1, halfYear: 1, year: 0, twoYears: 2, older: 0 }).map((s) => [s.key, s.percent])).toEqual([
      ["month", 25],
      ["halfYear", 25],
      ["year", 0],
      ["twoYears", 50],
      ["older", 0],
    ]);
    expect(ageShares({ files: 0, skipped: 0, month: 0, halfYear: 0, year: 0, twoYears: 0, older: 0 }).every((s) => s.percent === 0)).toBe(true);
  });
});

describe("tip of a ref", () => {
  const ref = (name: string, fullName: string, sha: string, kind: Ref["kind"]): Ref => ({
    name,
    fullName,
    kind,
    sha,
    isHead: false,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    remote: kind === "remote" ? "origin" : null,
    annotation: null,
    isAnnotated: false,
    worktreePath: null,
  });
  const refs: RefsSnapshot = {
    head: { kind: "branch", branch: "main", sha: "aaa" },
    locals: [ref("main", "refs/heads/main", "aaa", "local")],
    remotes: [ref("origin/main", "refs/remotes/origin/main", "bbb", "remote")],
    tags: [ref("v1", "refs/tags/v1", "ccc", "tag")],
  };

  it("HEAD, local and remote branches; tags and unknown refs are not judged", () => {
    expect(currentTip(refs, "HEAD")).toBe("aaa");
    expect(currentTip(refs, "refs/remotes/origin/main")).toBe("bbb");
    expect(currentTip(refs, "refs/tags/v1")).toBeNull();
    expect(currentTip({ ...refs, head: { kind: "unborn", branch: "main" } }, "HEAD")).toBeNull();
    expect(currentTip(undefined, "HEAD")).toBeNull();
  });
});

describe("treemap", () => {
  const file = (path: string, commits: number): StatsFile => ({ path, commits, authors: 1, added: 0, removed: 0 });
  const files = [file("src/app/main.rs", 4), file("docs/guide.md", 4), file("src/lib/util.rs", 2), file("README.md", 2)];

  it("builds folders with summed commits, largest first", () => {
    const root = buildTree(files);
    expect(root.value).toBe(12);
    expect(root.children.map((c) => [c.path, c.value, c.file ? "file" : "folder"])).toEqual([
      ["src", 6, "folder"],
      ["docs", 4, "folder"],
      ["README.md", 2, "file"],
    ]);
    const src = findNode(root, "src");
    expect(src?.children.map((c) => c.path)).toEqual(["src/app", "src/lib"]);
    expect(findNode(root, "src/app")?.children[0]?.file?.path).toBe("src/app/main.rs");
    expect(findNode(root, "")).toBe(root);
    expect(findNode(root, "gibt/es/nicht")).toBeNull();
    expect(findNode(root, "README.md")).toBeNull();
    expect([parentFolder("src/app"), parentFolder("src")]).toEqual(["src", ""]);
  });

  const items = [6, 6, 4, 3, 2, 2, 1].map((value, index) => ({ value, item: index }));

  it("squarifies like the paper's example", () => {
    const tiles = squarify(items, { x: 0, y: 0, w: 6, h: 4 });
    expect(tiles.map((t) => t.item)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(tiles.slice(0, 2).map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [0, 0, 3, 2],
      [0, 2, 3, 2],
    ]);
    const third = tiles[2]!;
    expect([third.x, third.y, third.h]).toEqual([3, 0, 7 / 3]);
  });

  it("the tiles fill the rectangle exactly and stay inside it", () => {
    const rect = { x: 10, y: 20, w: 1000, h: 480 };
    const tiles = squarify(items, rect);
    const area = tiles.reduce((sum, t) => sum + t.w * t.h, 0);
    expect(area).toBeCloseTo(rect.w * rect.h, 6);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
      expect(t.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
      expect(t.x + t.w).toBeLessThanOrEqual(rect.x + rect.w + 1e-9);
      expect(t.y + t.h).toBeLessThanOrEqual(rect.y + rect.h + 1e-9);
    }
  });

  it("one item fills everything; zeros and empty input give no tiles", () => {
    expect(squarify([{ value: 3, item: "a" }], { x: 0, y: 0, w: 10, h: 5 })).toEqual([{ x: 0, y: 0, w: 10, h: 5, item: "a" }]);
    expect(squarify([{ value: 0, item: "a" }], { x: 0, y: 0, w: 10, h: 5 })).toEqual([]);
    expect(squarify([], { x: 0, y: 0, w: 10, h: 5 })).toEqual([]);
  });
});
