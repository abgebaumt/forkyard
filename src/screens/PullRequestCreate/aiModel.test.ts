import { describe, expect, it } from "vitest";
import { suggestTitle } from "../../app/actions/pullrequests";
import { isUndoKey, placeDescription, titleDecision, undoInsertion, writeBlockedReason } from "./aiModel";

const TEMPLATE = "## Was ändert sich?\n\n## Wie getestet?\n\n- [ ] Tests grün\n";
const FILLED = "## Was ändert sich?\nNeu.\n\n## Wie getestet?\n\n- [ ] Tests grün\n";

describe("title (spec Paket 4)", () => {
  it("the title is replaced only while it is still the automatic suggestion", () => {
    // Oracle of the automatic title: the form's own rule, with two commits the branch name in words.
    const automatic = suggestTitle("thema/neue-auswertung", ["Auswertung je Station", "Umlaute sortieren"]);
    expect(automatic).toBe("Neue auswertung");
    expect(titleDecision(automatic, automatic, "Auswertung je Station als Dokument")).toBe("replace");
    expect(titleDecision("", automatic, "Auswertung je Station als Dokument")).toBe("replace");
    expect(titleDecision("Meine Überschrift", automatic, "Auswertung je Station als Dokument")).toBe("ask");
    expect(titleDecision("Neue auswertung ", automatic, "X"), "even a typed space is the user's").toBe("ask");
    expect(titleDecision("Auswertung je Station", automatic, " Auswertung je Station ")).toBe("same");
  });
});

describe("description (spec “Umgang mit Vorschlägen”)", () => {
  it("the untouched template counts as empty, typed text never", () => {
    expect(placeDescription(TEMPLATE, TEMPLATE, true, FILLED)).toEqual({ kind: "insert", text: FILLED });
    expect(placeDescription("", "", false, FILLED)).toEqual({ kind: "insert", text: FILLED });
    expect(placeDescription("Mein Text", "Mein Text", false, FILLED)).toEqual({ kind: "choose" });
    expect(placeDescription(TEMPLATE, TEMPLATE, false, FILLED), "the template after the user edited and restored it").toEqual({ kind: "choose" });
    expect(placeDescription(`${TEMPLATE}x`, TEMPLATE, true, FILLED), "typed into the template meanwhile").toEqual({ kind: "ready" });
    expect(placeDescription("M", "", false, FILLED)).toEqual({ kind: "ready" });
  });

  it("Mod+Z takes back exactly the insertion, nothing after it", () => {
    const undo = { before: TEMPLATE, after: FILLED };
    expect(undoInsertion(FILLED, undo)).toBe(TEMPLATE);
    expect(undoInsertion(`${FILLED}!`, undo), "edited after the insertion: the field's own undo").toBeNull();
    expect(undoInsertion(FILLED, null)).toBeNull();
    const key = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
    expect(isUndoKey(key("z", { ctrlKey: true }))).toBe(true);
    expect(isUndoKey(key("z", { metaKey: true }))).toBe(true);
    expect(isUndoKey(key("Z", { ctrlKey: true })), "caps lock").toBe(true);
    expect(isUndoKey(key("z", { ctrlKey: true, shiftKey: true })), "redo").toBe(false);
    expect(isUndoKey(key("z", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isUndoKey(key("z", {}))).toBe(false);
  });
});

describe("why “Write from commits” is disabled", () => {
  it("names the reason", () => {
    const base = { source: "refs/heads/thema", target: "refs/remotes/origin/main", ahead: 2, sameBranch: false };
    expect(writeBlockedReason(base)).toBeNull();
    expect(writeBlockedReason({ ...base, ahead: null }), "unknown count: the core decides").toBeNull();
    expect(writeBlockedReason({ ...base, source: null })).toBe("Choose a source branch first.");
    expect(writeBlockedReason({ ...base, target: null })).toBe("Choose a target branch first.");
    expect(writeBlockedReason({ ...base, sameBranch: true })).toBe("Source and target are the same branch.");
    expect(writeBlockedReason({ ...base, ahead: 0 })).toBe("The branch has no commits the target does not have.");
  });
});
