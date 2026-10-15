import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoStats } from "../../core";
import { StatsEmpty } from "./index";

describe("statistics without commits", () => {
  it("a branch without any commit says so instead of blaming the period", () => {
    const html = renderToStaticMarkup(<StatsEmpty stats={{ tip: null, commits: 0 } as RepoStats} />);
    expect(html).toContain('data-stats-empty="unborn"');
    expect(html).toContain("No commits yet");
    expect(html).toContain("The statistics appear after the first commit.");
    expect(html).not.toContain("No commits in this period");
  });

  it("history outside the period points to a longer period", () => {
    const html = renderToStaticMarkup(<StatsEmpty stats={{ tip: "abc", commits: 0 } as RepoStats} />);
    expect(html).toContain('data-stats-empty="period"');
    expect(html).toContain("No commits in this period");
    expect(html).toContain("Choose a longer period or another branch.");
  });
});
