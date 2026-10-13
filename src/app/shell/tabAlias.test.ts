import { describe, expect, it } from "vitest";
import { splitForMiddle } from "../../ui/Chrome";
import { aliasFromInput } from "./tabAlias";

describe("Alias on the tab", () => {
  const plain = { name: "messnetz", alias: null };
  const named = { name: "messnetz", alias: "Messnetz der Schulen" };

  it("a new input becomes the alias, without surrounding whitespace", () => {
    expect(aliasFromInput(plain, "  Wetter  ")).toBe("Wetter");
    expect(aliasFromInput(named, "Wetter")).toBe("Wetter");
  });

  it("empty or exactly the folder name resets", () => {
    expect(aliasFromInput(named, "")).toBeNull();
    expect(aliasFromInput(named, "   ")).toBeNull();
    expect(aliasFromInput(named, "messnetz")).toBeNull();
  });

  it("unchanged means: nothing to do", () => {
    expect(aliasFromInput(named, "Messnetz der Schulen")).toBeUndefined();
    expect(aliasFromInput(plain, "messnetz")).toBeUndefined();
    expect(aliasFromInput(plain, "")).toBeUndefined();
  });
});

describe("Truncating in the middle", () => {
  it("short names stay whole", () => {
    expect(splitForMiddle("main")).toBeNull();
    expect(splitForMiddle("station")).toBeNull();
  });

  it("splits at the last separator shortly before the end", () => {
    expect(splitForMiddle("station-14")).toEqual({ head: "station", tail: "-14" });
    expect(splitForMiddle("kundenportal-frontend-2026")).toEqual({ head: "kundenportal-frontend", tail: "-2026" });
    expect(splitForMiddle("bericht.final.docx")).toEqual({ head: "bericht.final", tail: ".docx" });
  });

  it("without a separator the last five characters remain", () => {
    expect(splitForMiddle("Wetterstationen")).toEqual({ head: "Wetterstat", tail: "ionen" });
  });

  it("head and tail together give the whole name again – also with umlauts and emoji", () => {
    for (const name of ["Größen und Einheiten", "schulgarten-bewässerung", "projekt 🚀 start-2026", "a-b-c-d-e-f-g-h"]) {
      const parts = splitForMiddle(name);
      expect(parts && parts.head + parts.tail).toBe(name);
    }
  });
});
