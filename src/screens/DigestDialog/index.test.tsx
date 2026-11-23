import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DigestSummary } from "./index";

describe("DigestSummary", () => {
  it("shows the numbers in an announced paragraph", () => {
    const markup = renderToStaticMarkup(<DigestSummary numbers={{ commits: 3, prs: 1, files: 0 }} />);
    expect(markup).toMatch(/^<p [^>]*aria-live="polite"[^>]*>/);
    expect(markup).toContain("3 new commits");
    expect(markup).toContain("1 pull request changed");
  });
});
