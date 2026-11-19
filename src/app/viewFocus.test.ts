import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "./store";
import { keyBelongsToView } from "./viewFocus";

// Tests run without a DOM: a minimal Element with `tagName` and `closest(selector)`.
class FakeElement {
  constructor(
    readonly tagName: string,
    private readonly inside: string | null = null,
  ) {}
  closest(selector: string) {
    return this.inside && selector.includes(this.inside) ? this : null;
  }
}
(globalThis as { Element?: unknown }).Element ??= FakeElement;

const key = (target: unknown) => ({ target }) as unknown as KeyboardEvent;

describe("keyBelongsToView", () => {
  afterEach(() => useAppStore.setState({ overlay: null }));

  it("takes keys on the view itself", () => {
    expect(keyBelongsToView(key(new FakeElement("DIV")))).toBe(true);
    expect(keyBelongsToView(key(null))).toBe(true);
  });

  it("leaves keys to text fields, menus, dialogs and editor panels", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(keyBelongsToView(key(new FakeElement(tag)))).toBe(false);
    expect(keyBelongsToView(key(new FakeElement("DIV", '[role="menu"]')))).toBe(false);
    expect(keyBelongsToView(key(new FakeElement("DIV", '[role="dialog"]')))).toBe(false);
    expect(keyBelongsToView(key(new FakeElement("DIV", ".cm-panels")))).toBe(false);
  });

  // The agent cockpit used to check only for dialogs; an open overlay blocks every view now.
  it("leaves keys alone while an overlay is open", () => {
    useAppStore.setState({ overlay: { kind: "palette" } as never });
    expect(keyBelongsToView(key(new FakeElement("DIV")))).toBe(false);
  });
});
