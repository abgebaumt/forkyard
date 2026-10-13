import { describe, expect, it } from "vitest";
import { highlightParts, shaMatchLength } from "./highlight";

const join = (parts: { text: string }[]) => parts.map((part) => part.text).join("");

describe("highlightParts", () => {
  it("finds all occurrences case-insensitively", () => {
    const parts = highlightParts("Regensumme und regen", "REGEN");
    expect(parts).toEqual([
      { text: "Regen", match: true },
      { text: "summe und ", match: false },
      { text: "regen", match: true },
    ]);
  });

  it("returns the text unchanged when nothing matches or nothing is searched", () => {
    expect(highlightParts("Tagesmittel", "wind")).toEqual([{ text: "Tagesmittel", match: false }]);
    expect(highlightParts("Tagesmittel", "  ")).toEqual([{ text: "Tagesmittel", match: false }]);
    expect(highlightParts("", "x")).toEqual([{ text: "", match: false }]);
  });

  it("puts the parts back together into the original – also with umlauts and special characters", () => {
    for (const [text, needle] of [
      ["Plausibilitätsprüfung für alle Sensoren", "prüf"],
      ["Ausfallwert -999 des Loggers", "-999"],
      ["a.b*c (x) [y]", "(x)"],
      ["aaaa", "aa"],
    ] as const) {
      const parts = highlightParts(text, needle);
      expect(join(parts)).toBe(text);
      expect(parts.some((part) => part.match)).toBe(true);
    }
  });

  it("skips highlighting when lower-casing changes the length", () => {
    expect(highlightParts("İstanbul-Messung", "messung")).toEqual([{ text: "İstanbul-Messung", match: false }]);
  });
});

describe("shaMatchLength", () => {
  const sha = "32232c856d1355424fd02b757f0e8e479ab21e04";

  it("highlights the prefix, at most the seven characters shown", () => {
    expect(shaMatchLength(sha, "3223")).toBe(4);
    expect(shaMatchLength(sha, "32232C8")).toBe(7);
    expect(shaMatchLength(sha, "32232c856d13")).toBe(7);
  });

  it("requires at least four hex characters at the start of the SHA", () => {
    expect(shaMatchLength(sha, "322")).toBe(0);
    expect(shaMatchLength(sha, "2232c")).toBe(0);
    expect(shaMatchLength(sha, "regen")).toBe(0);
  });
});
