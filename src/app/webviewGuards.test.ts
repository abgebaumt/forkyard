import { describe, expect, it } from "vitest";
import { isBrowserAccelerator } from "./webviewGuards";

const key = (init: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) => ({
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe("Browser shortcuts of the WebView", () => {
  it("find, print, save, view source belong to the app, not the WebView", () => {
    for (const letter of ["f", "g", "p", "s", "u", "o", "h", "j"]) {
      expect(isBrowserAccelerator(key({ key: letter, ctrlKey: true }), false, false)).toBe(true);
    }
    expect(isBrowserAccelerator(key({ key: "F", ctrlKey: true, shiftKey: true }), false, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "F3" }), false, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "F7" }), false, false)).toBe(true);
  });

  it("text editing stays free", () => {
    for (const letter of ["a", "c", "v", "x", "z", "y"]) {
      expect(isBrowserAccelerator(key({ key: letter, ctrlKey: true }), false, false)).toBe(false);
    }
    expect(isBrowserAccelerator(key({ key: "f" }), false, false)).toBe(false);
    expect(isBrowserAccelerator(key({ key: "ArrowLeft", ctrlKey: true }), false, false)).toBe(false);
    // AltGr on a German keyboard is Ctrl+Alt: "@" (AltGr+Q) and "€" (AltGr+E) must get through.
    expect(isBrowserAccelerator(key({ key: "€", ctrlKey: true, altKey: true }), false, false)).toBe(false);
    expect(isBrowserAccelerator(key({ key: "e", ctrlKey: true, altKey: true }), false, false)).toBe(false);
  });

  it("reload and developer tools only in the development build", () => {
    expect(isBrowserAccelerator(key({ key: "F5" }), false, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "r", ctrlKey: true }), false, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "F12" }), false, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "I", ctrlKey: true, shiftKey: true }), false, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "F5" }), false, true)).toBe(false);
    expect(isBrowserAccelerator(key({ key: "r", ctrlKey: true }), false, true)).toBe(false);
    expect(isBrowserAccelerator(key({ key: "F12" }), false, true)).toBe(false);
  });

  it("history: Alt+Arrow on Windows and Linux, Cmd+[ on macOS – Option+Arrow stays text editing", () => {
    expect(isBrowserAccelerator(key({ key: "ArrowLeft", altKey: true }), false, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "ArrowLeft", altKey: true }), true, false)).toBe(false);
    expect(isBrowserAccelerator(key({ key: "[", metaKey: true }), true, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "f", metaKey: true }), true, false)).toBe(true);
    expect(isBrowserAccelerator(key({ key: "f", ctrlKey: true }), true, false)).toBe(false);
  });
});

describe("Drag and drop from outside", () => {
  it("detects files and links, leaves our own dragging alone", async () => {
    const { isForeignDrag } = await import("./webviewGuards");
    expect(isForeignDrag({ types: ["Files"] })).toBe(true);
    expect(isForeignDrag({ types: ["text/uri-list", "text/plain"] })).toBe(true);
    // Our own dragging (tabs, branches, files) carries our own types or only text.
    expect(isForeignDrag({ types: ["application/x-forkyard-tab"] })).toBe(false);
    expect(isForeignDrag({ types: ["text/plain"] })).toBe(false);
    expect(isForeignDrag({ types: [] })).toBe(false);
    expect(isForeignDrag(null)).toBe(false);
  });
});
