import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatsCancelled } from "./index";

describe("cancelled statistics", () => {
  it("tells that the run was cancelled and offers to compute again", () => {
    const html = renderToStaticMarkup(<StatsCancelled onCompute={() => undefined} />);
    expect(html).toContain("data-stats-cancelled");
    expect(html).toContain("Statistics not computed");
    expect(html).toMatch(/<button[^>]*>.*Compute statistics.*<\/button>/);
  });
});
