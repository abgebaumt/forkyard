import { describe, expect, it } from "vitest";
import { placeCommitSuggestion, resolveOffer, suggestionParts, undoTarget, writeBlocked, writeLabel } from "./aiDraft";

const parts = (summary: string, description = "") => ({ summary, description });

describe("commit message draft (spec 3.1, “Umgang mit Vorschlägen”)", () => {
  it("turns the core's answer into the two fields", () => {
    expect(suggestionParts({ summary: "Tagesmittel als CSV exportieren", body: null })).toEqual(parts("Tagesmittel als CSV exportieren"));
    expect(suggestionParts({ summary: "Fix", body: "Zeile 1\nZeile 2" })).toEqual(parts("Fix", "Zeile 1\nZeile 2"));
  });

  it("fills empty fields as a draft", () => {
    expect(placeCommitSuggestion(parts(""), parts(""), null, parts("Fix"))).toEqual({ kind: "insert" });
    expect(placeCommitSuggestion(parts("  ", "\n"), parts("  ", "\n"), null, parts("Fix"))).toEqual({ kind: "insert" });
  });

  it("treats the untouched commit template like an empty field", () => {
    const template = parts("Bereich: Kurzbeschreibung", "Warum?");
    expect(placeCommitSuggestion(template, template, template, parts("Fix"))).toEqual({ kind: "insert" });
    expect(placeCommitSuggestion(parts("Bereich: Login"), parts("Bereich: Login"), template, parts("Fix"))).toEqual({ kind: "choose" });
  });

  it("never replaces the user's text unasked", () => {
    expect(placeCommitSuggestion(parts("WIP: Anmeldung"), parts("WIP: Anmeldung"), null, parts("Fix"))).toEqual({ kind: "choose" });
    expect(placeCommitSuggestion(parts("", "Nur eine Beschreibung"), parts("", "Nur eine Beschreibung"), null, parts("Fix"))).toEqual({ kind: "choose" });
  });

  it("only offers the suggestion when the user typed while the request ran", () => {
    expect(placeCommitSuggestion(parts("F"), parts(""), null, parts("Fix"))).toEqual({ kind: "ready" });
    expect(placeCommitSuggestion(parts("", "Notiz"), parts(""), null, parts("Fix"))).toEqual({ kind: "ready" });
    expect(placeCommitSuggestion(parts("WIP: Anmeldung!"), parts("WIP: Anmeldung"), null, parts("Fix"))).toEqual({ kind: "ready" });
  });

  it("replaces, or appends after a blank line", () => {
    expect(resolveOffer(parts("WIP: Anmeldung"), parts("Fix login", "Body"), "replace")).toEqual(parts("Fix login", "Body"));
    expect(resolveOffer(parts("WIP: Anmeldung", "Notiz"), parts("Fix login", "Body"), "append")).toEqual(parts("WIP: Anmeldung", "Notiz\n\nFix login\n\nBody"));
    expect(resolveOffer(parts("WIP: Anmeldung"), parts("Fix login"), "append")).toEqual(parts("WIP: Anmeldung", "Fix login"));
  });

  it("Mod+Z restores the text from before the insertion only while the inserted text is untouched", () => {
    const undo = { before: parts(""), inserted: parts("Fix", "Body") };
    expect(undoTarget(undo, parts("Fix", "Body"))).toEqual(parts(""));
    expect(undoTarget(undo, parts("Fix!", "Body"))).toBeNull();
    expect(undoTarget(undo, parts("Fix", "Body\n"))).toBeNull();
    expect(undoTarget(null, parts("Fix", "Body"))).toBeNull();
  });

  it("the button says Write, Cancel while it runs, New afterwards – and is blocked without staged changes", () => {
    expect(writeLabel("idle")).toBe("write");
    expect(writeLabel("error")).toBe("write");
    expect(writeLabel("running")).toBe("cancel");
    expect(writeLabel("done")).toBe("again");
    expect(writeLabel("offer")).toBe("again");
    expect(writeBlocked(0)).toBe("Nothing staged");
    expect(writeBlocked(3)).toBeNull();
  });
});
