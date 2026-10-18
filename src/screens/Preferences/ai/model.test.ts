import { describe, expect, it } from "vitest";
import { acceptsKey, cliPathField, FEATURES, featureToggle, isCli, isLocal, needsKey, parsePatterns, parsePricePair, parseUsd, patternsText, pricePairText, PROVIDERS, usesBaseUrl, withCliPath, withOwnPrice } from "./model";

describe("AI settings model", () => {
  it("knows which providers need a key, an address or run locally", () => {
    expect(PROVIDERS).toHaveLength(9);
    expect(PROVIDERS.filter(isCli)).toEqual(["claude_code", "codex", "opencode"]);
    expect(PROVIDERS.filter(isCli).some((provider) => acceptsKey(provider) || usesBaseUrl(provider) || isLocal(provider))).toBe(false);
    expect(PROVIDERS.filter(needsKey)).toEqual(["anthropic", "openai", "gemini"]);
    expect(acceptsKey("openai_compatible") && !needsKey("openai_compatible")).toBe(true);
    expect(PROVIDERS.filter(usesBaseUrl)).toEqual(["openai_compatible", "ollama", "lmstudio"]);
    expect(PROVIDERS.filter(isLocal)).toEqual(["ollama", "lmstudio"]);
    expect(acceptsKey("ollama")).toBe(false);
    expect(FEATURES).toHaveLength(12);
  });

  it("reads exclusion patterns line by line, without blanks and doubles", () => {
    expect(parsePatterns(" *.sql \r\n\n*.sql\ngeheim/**\n")).toEqual(["*.sql", "geheim/**"]);
    expect(patternsText(["*.sql", "geheim/**"])).toBe("*.sql\ngeheim/**");
    expect(parsePatterns("   \n")).toEqual([]);
  });

  it("reads amounts with a dot or a comma", () => {
    expect(parseUsd("0,10")).toBe(0.1);
    expect(parseUsd(" 25 USD")).toBe(25);
    expect(parseUsd("")).toBeNull();
    expect(parseUsd("-1")).toBe("invalid");
    expect(parseUsd("1e3")).toBe("invalid");
    expect(parseUsd("zehn")).toBe("invalid");
  });

  it("switches single functions off and on", () => {
    expect(featureToggle([], "compose", false)).toEqual(["compose"]);
    expect(featureToggle(["compose", "plan"], "compose", true)).toEqual(["plan"]);
    expect(featureToggle(["plan"], "plan", false)).toEqual(["plan"]);
  });

  it("keeps one own price per model", () => {
    expect(parsePricePair("2 / 10")).toEqual({ input: 2, output: 10 });
    expect(parsePricePair("2,5/12")).toEqual({ input: 2.5, output: 12 });
    expect(parsePricePair("")).toBeNull();
    expect(parsePricePair("2")).toBe("invalid");
    const prices = withOwnPrice([{ model: "a", inputUsdPerMtok: 1, outputUsdPerMtok: 2 }], "a", { input: 3, output: 4 });
    expect(prices).toEqual([{ model: "a", inputUsdPerMtok: 3, outputUsdPerMtok: 4 }]);
    expect(withOwnPrice(prices, "a", null)).toEqual([]);
    expect(pricePairText(prices[0])).toBe("3 / 4");
    expect(pricePairText(undefined)).toBe("");
  });

  it("keeps one own path per command-line tool, blank = found automatically", () => {
    const none = { claudeCode: null, codex: null, opencode: null };
    expect(cliPathField("claude_code")).toBe("claudeCode");
    const paths = withCliPath(none, "codex", "  /opt/Programme mit Leerzeichen/codex  ");
    expect(paths).toEqual({ claudeCode: null, codex: "/opt/Programme mit Leerzeichen/codex", opencode: null });
    expect(withCliPath(paths, "codex", "   ")).toEqual(none);
    expect(withCliPath(none, "opencode", String.raw`C:\Users\Lena\AppData\Roaming\npm\opencode.cmd`).opencode).toBe(String.raw`C:\Users\Lena\AppData\Roaming\npm\opencode.cmd`);
  });
});

describe("stacked pull requests", () => {
  it("lists the function last, with its texts in both languages", async () => {
    expect(FEATURES[FEATURES.length - 1]).toBe("stack_split");
    const en = (await import("../../../i18n/locales/en/ai.json")).default as { features: Record<string, string>; featureHints: Record<string, string> };
    const de = (await import("../../../i18n/locales/de/ai.json")).default as { features: Record<string, string>; featureHints: Record<string, string> };
    expect(en.features.stack_split).toBe("Split into stacked pull requests");
    expect(de.features.stack_split).toBe("In gestapelte PRs zerlegen");
    expect(en.featureHints.stack_split).toBeTruthy();
    expect(de.featureHints.stack_split).toBeTruthy();
  });
});
