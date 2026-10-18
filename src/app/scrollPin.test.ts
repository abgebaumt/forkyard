import { describe, expect, it } from "vitest";
import { installScrollPin } from "./scrollPin";

/** Minimal stand-in for an element: scroll offsets and attributes. */
class FakeElement {
  scrollTop = 0;
  scrollLeft = 0;
  constructor(private readonly attrs: Record<string, string> = {}) {}
  hasAttribute(name: string) {
    return name in this.attrs;
  }
}

type Listener = (event: { target: unknown }) => void;

function fakeDocument() {
  const html = new FakeElement();
  const body = new FakeElement();
  const root = new FakeElement();
  const shell = new FakeElement({ "data-no-scroll": "" });
  const list = new FakeElement();
  // Only capture-phase "scroll" listeners on the document see element scrolls (the event does not bubble).
  const listeners = new Set<Listener>();
  const doc = {
    listeners,
    addEventListener: (type: string, listener: Listener, options?: { capture?: boolean }) => {
      if (type === "scroll" && options?.capture) listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    scrollingElement: html,
    documentElement: html,
    body,
    getElementById: (id: string) => (id === "root" ? root : null),
  };
  return { doc, html, body, root, shell, list };
}

/** Like the browser: the element scrolls, then "scroll" is dispatched at it (or at the document for the viewport). */
function scroll(doc: { listeners: Set<Listener> }, target: FakeElement | null, element: FakeElement, top: number, left = 0) {
  element.scrollTop = top;
  element.scrollLeft = left;
  for (const listener of doc.listeners) listener({ target: target ?? doc });
}

describe("scroll pin of the app shell", () => {
  it("puts the viewport back to 0 when the document scrolls", () => {
    const { doc, html } = fakeDocument();
    const stop = installScrollPin(doc as unknown as Document);
    scroll(doc, null, html, 120, 30);
    expect([html.scrollTop, html.scrollLeft]).toEqual([0, 0]);
    stop();
  });

  it("puts body, #root and every element marked data-no-scroll back to 0", () => {
    const { doc, body, root, shell } = fakeDocument();
    const stop = installScrollPin(doc as unknown as Document);
    for (const element of [body, root, shell]) {
      scroll(doc, element, element, 48, 12);
      expect([element.scrollTop, element.scrollLeft]).toEqual([0, 0]);
    }
    stop();
  });

  it("leaves real scroll areas (lists, editors) alone", () => {
    const { doc, list } = fakeDocument();
    const stop = installScrollPin(doc as unknown as Document);
    scroll(doc, list, list, 300, 5);
    expect([list.scrollTop, list.scrollLeft]).toEqual([300, 5]);
    stop();
  });

  it("stops after uninstalling", () => {
    const { doc, root } = fakeDocument();
    installScrollPin(doc as unknown as Document)();
    scroll(doc, root, root, 40);
    expect(root.scrollTop).toBe(40);
  });
});

describe("global CSS of the shell", async () => {
  // Read from disk: the test runner hands CSS imports (even ?raw) over empty. The UI has no Node types.
  const nodeFs = "node:fs";
  const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (file: URL, encoding: "utf8") => string };
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleFor = (selector: RegExp) => {
    const match = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(css);
    return match?.[1] ?? "";
  };

  it("html, body and #root fill the window and cannot scroll", () => {
    const rule = ruleFor(/html,\s*body,\s*#root/);
    expect(rule).toMatch(/height:\s*100%/);
    // `clip` also blocks programmatic scrolling; `hidden` first as the fallback.
    expect(rule).toMatch(/overflow:\s*hidden;[\s\S]*overflow:\s*clip/);
    expect(rule).toMatch(/overscroll-behavior:\s*none/);
  });

  it("shell containers marked data-no-scroll clip instead of scrolling", () => {
    const rule = ruleFor(/\[data-no-scroll\]/);
    expect(rule).toMatch(/overflow:\s*hidden;[\s\S]*overflow:\s*clip/);
    expect(rule).toMatch(/overscroll-behavior:\s*none/);
  });
});
