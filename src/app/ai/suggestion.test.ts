import { describe, expect, it } from "vitest";
import { applySuggestion, placeSuggestion } from "./suggestion";

describe("placing a suggestion (spec “Umgang mit Vorschlägen”)", () => {
  it("fills an empty field as a draft", () => {
    expect(placeSuggestion("", "", "Fix login")).toEqual({ kind: "insert", text: "Fix login" });
    expect(placeSuggestion("  \n", "  \n", "Fix login")).toEqual({ kind: "insert", text: "Fix login" });
  });

  it("never replaces the user's text unasked", () => {
    expect(placeSuggestion("WIP: Anmeldung", "WIP: Anmeldung", "Fix login")).toEqual({ kind: "choose" });
  });

  it("only offers the suggestion when the user typed while it was running", () => {
    expect(placeSuggestion("F", "", "Fix login")).toEqual({ kind: "ready" });
    expect(placeSuggestion("WIP: Anmeldung!", "WIP: Anmeldung", "Fix login")).toEqual({ kind: "ready" });
  });

  it("replaces or appends after a blank line", () => {
    expect(applySuggestion("WIP: Anmeldung", "Fix login", "replace")).toBe("Fix login");
    expect(applySuggestion("WIP: Anmeldung\n\n", "Fix login", "append")).toBe("WIP: Anmeldung\n\nFix login");
    expect(applySuggestion("Zeile 1\r\nZeile 2\r\n", "Fix", "append")).toBe("Zeile 1\r\nZeile 2\n\nFix");
    expect(applySuggestion("   ", "Fix login", "append")).toBe("Fix login");
  });
});
