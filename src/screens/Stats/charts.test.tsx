import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatsFolder } from "../../core";
import { AuthorsTable, CodeAgeBar, formatPeriod, Heatmap, HotspotList, KnowledgeTable, Records, TimeChart, Treemap } from "./charts";
import { buildTree } from "./model";

const none = () => undefined;

describe("statistics charts", () => {
  it("the heatmap has a cell with a tooltip for every weekday and hour", () => {
    const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    heatmap[1]![23] = 2;
    const html = renderToStaticMarkup(<Heatmap heatmap={heatmap} />);
    expect(html.match(/data-cell=/g)).toHaveLength(168);
    expect(html).toMatch(/data-cell="1-23"[^>]*class="fill-accent"/);
    expect(html).toMatch(/data-cell="0-0"[^>]*class="fill-surface-sunken"/);
    expect(html).toContain("23:00 – 2 commits");
  });

  it("time chart: one bar per period, the first and last period below", () => {
    const html = renderToStaticMarkup(
      <TimeChart buckets={[{ period: "2025-06-02", commits: 1, added: 0, removed: 0 }, { period: "2025-06-09", commits: 0, added: 0, removed: 0 }, { period: "2025-06-16", commits: 3, added: 0, removed: 0 }]} />,
    );
    expect(html.match(/data-period=/g)).toHaveLength(3);
    expect(html).toContain(": 1 commit<");
    expect(html).toContain(": 0 commits<");
    expect(formatPeriod("2025-06")).toContain("2025");
    expect(formatPeriod("kaputt")).toBe("kaputt");
  });

  it("authors with a note for the ones not listed", () => {
    const author = { name: "Ada", email: "ada@example.com", commits: 3, added: 18, removed: 2, firstAt: "", lastAt: "" };
    const html = renderToStaticMarkup(<AuthorsTable authors={[author]} total={3} />);
    expect(html.match(/data-author=/g)).toHaveLength(1);
    expect(html).toContain("+18");
    expect(html).toContain("and 2 more authors");
    expect(renderToStaticMarkup(<AuthorsTable authors={[author]} total={1} />)).not.toContain("more author");
  });

  it("treemap tiles are buttons: folders open in place, files lead to their history", () => {
    const root = buildTree([
      { path: "src/app/main.rs", commits: 4, authors: 3, added: 0, removed: 0 },
      { path: "src/lib/util.rs", commits: 2, authors: 1, added: 0, removed: 0 },
      { path: "README.md", commits: 2, authors: 1, added: 0, removed: 0 },
    ]);
    const html = renderToStaticMarkup(<Treemap node={root} onFile={none} onFolder={none} />);
    expect(html).toContain('data-tile="src" data-kind="folder" role="button" tabindex="0" aria-label="src/ – 6 commits. Open folder"');
    expect(html).toContain('data-tile="README.md" data-kind="file" role="button" tabindex="0" aria-label="README.md – 2 commits. Show history"');
    expect(html).toContain('aria-label="Files and folders in Repository"');
  });

  it("hotspots, knowledge, code age and records", () => {
    const hotspots = renderToStaticMarkup(<HotspotList hotspots={[{ path: "src/app/main.rs", commits: 4, authors: 3, score: 12 }]} onFile={none} />);
    expect(hotspots).toContain('aria-label="Show the history of src/app/main.rs"');
    expect(hotspots).toContain("Commits: 4 · Authors: 3");
    expect(renderToStaticMarkup(<HotspotList hotspots={[]} onFile={none} />)).toContain("exists any more");

    const folder: StatsFolder = { path: "", weight: 40, authors: 3, mainAuthor: { name: "Ada", email: "ada@example.com" }, mainShare: 45, busFactor: 2, top: [] };
    const knowledge = renderToStaticMarkup(<KnowledgeTable folders={[folder, { ...folder, path: "docs", mainShare: 100, busFactor: 1 }]} onFolder={none} />);
    expect(knowledge).toContain("(whole repository)");
    expect(knowledge).toContain("45%");
    expect(knowledge).toMatch(/text-warning">1</);

    const age = renderToStaticMarkup(<CodeAgeBar age={{ files: 4, skipped: 1, month: 18, halfYear: 0, year: 0, twoYears: 0, older: 11 }} />);
    expect(age.match(/data-age=/g)).toHaveLength(5);
    expect(age).toContain("&lt; 1 mo: 18 lines");
    expect(age).toContain("1 file could not be read.");
    expect(renderToStaticMarkup(<CodeAgeBar age={{ files: 0, skipped: 0, month: 0, halfYear: 0, year: 0, twoYears: 0, older: 0 }} />)).toContain("no text file");

    const records = renderToStaticMarkup(
      <Records
        records={{ longestStreak: { days: 4, start: "2025-06-02", end: "2025-06-05" }, biggestCommit: { sha: "abcdef1234567", added: 15, removed: 0, at: "" }, busiestDay: null }}
        onCommit={none}
      />,
    );
    expect(records).toContain("4 days");
    expect(records).toContain("15 lines");
    expect(records).toContain("Show abcdef1 in the graph");
    expect(records).toContain("–");
  });
});
