import { describe, expect, it } from "vitest";
import type { AiPreview } from "../../core";
import { askLines, formatUsd, formatUsdExact, offersDontAskAgain, omittedReason } from "./preview";

const preview = (patch: Partial<AiPreview> = {}): AiPreview => ({
  text: "x",
  omitted: [],
  shortened: [],
  chars: 123_456,
  estimatedTokens: 35_274,
  estimatedCostUsd: 0.1234,
  asks: [],
  fingerprint: "f",
  monthCostUsd: 12.5,
  limitUsd: 10,
  ...patch,
});

describe("What is sent?", () => {
  it("estimates are always 'about' and below a cent 'under 0.01 USD' (spec 1.5)", () => {
    expect(formatUsd(0.0314, "en-US")).toBe("about 0.03 USD");
    expect(formatUsd(0.004, "en-US")).toBe("under 0.01 USD");
    expect(formatUsd(1234.5, "de-DE")).toBe("about 1.234,50 USD");
    expect(formatUsdExact(10, "en-US")).toBe("10.00 USD");
  });

  it("offers 'Don't ask again' only for size and cost", () => {
    expect(offersDontAskAgain(["first_use", "repo_first", "limit"])).toBe(false);
    expect(offersDontAskAgain(["large"])).toBe(true);
    expect(offersDontAskAgain(["cost", "limit"])).toBe(true);
  });

  it("names every trigger with its numbers", () => {
    const lines = askLines(preview({ asks: ["first_use", "large", "cost", "repo_first", "limit"] }), "en-US");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("This function sends content to the provider for the first time.");
    expect(lines[1]).toContain("123,456");
    expect(lines[2]).toContain("about 0.12 USD");
    expect(lines[3]).toContain("for the first time");
    expect(lines[4]).toContain("about 12.50 USD");
    expect(lines[4]).toContain("10.00 USD");
  });

  it("explains why a file is left out", () => {
    expect(omittedReason("secret")).toContain("never sent");
    expect(omittedReason("binary")).toContain("name and size");
  });
});
