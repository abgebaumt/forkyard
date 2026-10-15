import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatsFolder } from "../../core";
import { AuthorsList, CodeAgeChart, formatPeriod, Heatmap, HotspotList, KnowledgeTable, Records, TimeChart, Treemap } from "./charts";
import { authorPalette } from "./layout";
import { buildTree } from "./model";
import de from "../../i18n/locales/de/stats.json";
import en from "../../i18n/locales/en/stats.json";

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
    for (const hour of ["00", "06", "12", "18"]) expect(html).toContain(`>${hour}<`);
    expect(html).toContain(">Mon<");
  });

  it("time chart: one bar per period, month names below", () => {
    const html = renderToStaticMarkup(
      <TimeChart buckets={[{ period: "2025-06-02", commits: 1, added: 0, removed: 0 }, { period: "2025-06-09", commits: 0, added: 0, removed: 0 }, { period: "2025-06-16", commits: 3, added: 0, removed: 0 }]} />,
    );
    expect(html.match(/data-period=/g)).toHaveLength(3);
    expect(html).toContain(": 1 commit<");
    expect(html).toContain(": 0 commits<");
    expect(html).toContain(">Jun<");
    expect(formatPeriod("2025-06")).toContain("2025");
    expect(formatPeriod("kaputt")).toBe("kaputt");
  });

  it("authors: initials in their colour, commits, lines added and deleted, a note for the rest", () => {
    const author = { name: "Maya Chen", email: "maya@example.com", commits: 412, added: 18204, removed: 6912, firstAt: "", lastAt: "" };
    const palette = authorPalette([author]);
    const html = renderToStaticMarkup(<AuthorsList authors={[author]} total={3} palette={palette} />);
    expect(html.match(/data-author=/g)).toHaveLength(1);
    expect(html).toMatch(/bg-lane-1[^"]*">MC</);
    expect(html).toContain("+18,204");
    expect(html).toContain("−6,912");
    expect(html).toContain("and 2 more authors");
    expect(renderToStaticMarkup(<AuthorsList authors={[author]} total={1} palette={palette} />)).not.toContain("more author");
  });

  it("treemap tiles are buttons in their own colour: folders open in place, files lead to their history", () => {
    const root = buildTree([
      { path: "src/app/main.rs", commits: 4, authors: 3, added: 0, removed: 0 },
      { path: "src/lib/util.rs", commits: 2, authors: 1, added: 0, removed: 0 },
      { path: "README.md", commits: 2, authors: 1, added: 0, removed: 0 },
    ]);
    const html = renderToStaticMarkup(<Treemap node={root} onFile={none} onFolder={none} />);
    expect(html).toMatch(/data-tile="src" data-kind="folder" aria-label="src\/ – 6 changes. Open folder"[^>]*bg-lane-1/);
    expect(html).toMatch(/data-tile="README.md" data-kind="file" aria-label="README.md – 2 changes. Show history"[^>]*bg-lane-2/);
    expect(html).toContain("6 changes");
    expect(html).toContain('aria-label="Files and folders in Repository"');
  });

  it("hotspots: file, changes, authors and a bar coloured by severity", () => {
    const spots = [
      { path: "src/api/routes.ts", commits: 96, authors: 5, score: 480 },
      { path: "src/util/units.ts", commits: 29, authors: 2, score: 58 },
    ];
    const html = renderToStaticMarkup(<HotspotList hotspots={spots} onFile={none} />);
    expect(html).toContain('aria-label="Show the history of src/api/routes.ts"');
    expect(html).toMatch(/data-severity="high"[\s\S]*>96<[\s\S]*>5<[\s\S]*bg-danger/);
    expect(html).toMatch(/data-severity="low"[\s\S]*bg-lane-1/);
    expect(renderToStaticMarkup(<HotspotList hotspots={[]} onFile={none} />)).toContain("exists any more");
  });

  it("knowledge: a bar of line shares in the authors' colours and the bus factor", () => {
    const palette = authorPalette([
      { name: "Ada", email: "ada@example.com", commits: 5, added: 0, removed: 0, firstAt: "", lastAt: "" },
      { name: "Ben", email: "ben@example.com", commits: 3, added: 0, removed: 0, firstAt: "", lastAt: "" },
    ]);
    const folder: StatsFolder = {
      path: "src/api",
      weight: 100,
      authors: 3,
      mainAuthor: { name: "Ada", email: "ada@example.com" },
      mainShare: 60,
      busFactor: 1,
      top: [
        { author: { name: "Ada", email: "ada@example.com" }, weight: 60 },
        { author: { name: "Ben", email: "ben@example.com" }, weight: 30 },
      ],
    };
    const html = renderToStaticMarkup(<KnowledgeTable folders={[folder]} palette={palette} onFolder={none} />);
    expect(html).toContain(">src/api/<");
    expect(html).toMatch(/data-share="ada@example.com" title="Ada: 60%" class="h-full bg-lane-1" style="width:60%"/);
    expect(html).toMatch(/data-share="ben@example.com"[^>]*bg-lane-2/);
    expect(html).toMatch(/data-share="others" title="Other authors: 10%"/);
    expect(html).toMatch(/text-danger">1</);
  });

  it("knowledge: the column says what the weight is – lines changed over the history, not lines owned", () => {
    const html = renderToStaticMarkup(<KnowledgeTable folders={[]} palette={authorPalette([])} onFolder={none} />);
    expect(html).toContain(">Share of changed lines per person<");
    expect(en.knowledge.hint).toBe("share of changed lines per person · bus factor");
    expect(de.knowledge.lines).toBe("Anteil der geänderten Zeilen pro Person");
    expect(de.knowledge.hint).toBe("Anteil der geänderten Zeilen pro Person · Bus-Faktor");
  });

  it("code age: a bar per bucket with its compact line count", () => {
    const age = renderToStaticMarkup(<CodeAgeChart age={{ files: 4, skipped: 1, month: 3100, halfYear: 6900, year: 0, twoYears: 0, older: 11 }} />);
    expect(age.match(/data-age=/g)).toHaveLength(5);
    expect(age).toContain("3.1K");
    expect(age).toContain("6.9K");
    expect(age).toContain("&lt; 1 mo: 3100 lines");
    expect(age).toContain("1–6 mo");
    expect(age).toContain("1 file could not be read.");
    expect(renderToStaticMarkup(<CodeAgeChart age={{ files: 0, skipped: 0, month: 0, halfYear: 0, year: 0, twoYears: 0, older: 0 }} />)).toContain("no text file");
  });

  it("records: streak with its days, largest commit with its message, busiest day", () => {
    const records = { longestStreak: { days: 23, start: "2025-03-03", end: "2025-03-25" }, biggestCommit: { sha: "abcdef1234567", added: 1284, removed: 312, at: "" }, busiestDay: null };
    const html = renderToStaticMarkup(<Records records={records} biggest={{ summary: "Add forecast model", author: "Maya Chen" }} onCommit={none} />);
    expect(html).toContain("23 days");
    expect(html).toMatch(/March 3\s*–\s*25, 2025/);
    expect(html).toContain("+1,284");
    expect(html).toContain("−312");
    expect(html).toContain("Add forecast model · Maya Chen");
    expect(html).toContain("–");
    expect(renderToStaticMarkup(<Records records={records} onCommit={none} />)).toContain("Show abcdef1 in the graph");
  });
});
