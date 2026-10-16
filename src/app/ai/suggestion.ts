/**
 * Where a suggestion goes (spec "Umgang mit Vorschlägen"): an empty field gets it as a draft; text
 * the user wrote is never replaced unasked ("Replace" / "Append" / "Discard"); if the user typed
 * while the request ran, the answer is only offered ("Suggestion ready"). Inserted text is plain
 * text at once – the field's own history undoes it.
 */
export type Placement = { kind: "insert"; text: string } | { kind: "choose" } | { kind: "ready" };

export function placeSuggestion(current: string, atStart: string, suggestion: string): Placement {
  if (current !== atStart) return { kind: "ready" };
  if (current.trim() === "") return { kind: "insert", text: suggestion };
  return { kind: "choose" };
}

export function applySuggestion(current: string, suggestion: string, how: "replace" | "append"): string {
  if (how === "replace") return suggestion;
  const base = current.replace(/\s+$/, "");
  return base ? `${base}\n\n${suggestion}` : suggestion;
}
