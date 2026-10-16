import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./searchFilters";

describe("commit search filters in the search text", () => {
  it("takes code:, path:, since: and until: out of the text", () => {
    expect(parseSearchQuery('fix code:geheimeFunktion path:"src/ä b" since:2026-01-01')).toEqual({
      query: "fix",
      filters: { pickaxe: "geheimeFunktion", paths: ["src/ä b"], since: "2026-01-01" },
    });
    expect(parseSearchQuery("path:a path:-b until:2026-02-01T10:00:00Z")).toEqual({ query: "", filters: { paths: ["a", "-b"], until: "2026-02-01T10:00:00Z" } });
  });

  it("leaves ordinary text alone", () => {
    expect(parseSearchQuery("Fix: Absturz beim Öffnen")).toEqual({ query: "Fix: Absturz beim Öffnen", filters: null });
    expect(parseSearchQuery("code:")).toEqual({ query: "code:", filters: null });
    expect(parseSearchQuery('code:""')).toEqual({ query: "", filters: null });
    expect(parseSearchQuery("  ")).toEqual({ query: "", filters: null });
  });
});
