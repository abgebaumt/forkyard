import { describe, expect, test } from "vitest";
import type { WindowFrame, WindowLayout } from "../../core";
import { dropTarget } from "./dropTarget";

const main: WindowFrame = {
  label: "main",
  inner: { x: 0, y: 0, width: 1000, height: 700 },
  strip: { x: 0, y: 0, width: 1000, height: 36 },
  tabMids: [60, 180, 300],
  focusRank: 0,
};
// On a monitor left of the primary one.
const wB: WindowFrame = {
  label: "w-b",
  inner: { x: -1600, y: 100, width: 900, height: 600 },
  strip: { x: -1600, y: 100, width: 900, height: 36 },
  tabMids: [-1540],
  focusRank: 1,
};
const L: WindowLayout = { frames: [main, wB], cursor: null, positionsKnown: true };

describe("dropTarget", () => {
  test("over the own strip: reorder at the insertion index", () =>
    expect(dropTarget(L, { x: 200, y: 10 }, "main", true)).toEqual({ kind: "reorder", index: 2 }));

  test("left of every tab in the own strip: index 0; right of all: the end", () => {
    expect(dropTarget(L, { x: 10, y: 10 }, "main", true)).toEqual({ kind: "reorder", index: 0 });
    expect(dropTarget(L, { x: 900, y: 10 }, "main", true)).toEqual({ kind: "reorder", index: 3 });
  });

  test("over the own content: nothing", () => expect(dropTarget(L, { x: 500, y: 400 }, "main", true)).toEqual({ kind: "none" }));

  test("over another window's strip: move with the index from its tab midpoints", () =>
    expect(dropTarget(L, { x: -1500, y: 110 }, "main", false)).toEqual({ kind: "move", window: "w-b", index: 1 }));

  test("over another window's strip left of its only tab: index 0", () =>
    expect(dropTarget(L, { x: -1590, y: 130 }, "main", false)).toEqual({ kind: "move", window: "w-b", index: 0 }));

  test("over another window's content: nothing", () =>
    expect(dropTarget(L, { x: -1500, y: 400 }, "main", false)).toEqual({ kind: "none" }));

  test("outside every window: new window at the point", () =>
    expect(dropTarget(L, { x: 1500, y: 900 }, "main", false)).toEqual({ kind: "new", at: { x: 1500, y: 900 } }));

  test("outside every window on the left monitor: new window at the negative point", () =>
    expect(dropTarget(L, { x: -1650, y: 50 }, "main", false)).toEqual({ kind: "new", at: { x: -1650, y: 50 } }));

  test("overlapping windows: the most recently focused one wins", () => {
    // w-b moved over main's strip and focused last.
    const over: WindowFrame = {
      label: "w-b",
      inner: { x: 100, y: 0, width: 400, height: 300 },
      strip: { x: 100, y: 0, width: 400, height: 36 },
      tabMids: [150, 250],
      focusRank: 0,
    };
    const layout: WindowLayout = { frames: [{ ...main, focusRank: 1 }, over], cursor: null, positionsKnown: true };
    expect(dropTarget(layout, { x: 200, y: 10 }, "main", true)).toEqual({ kind: "move", window: "w-b", index: 1 });
    // Outside w-b, main's strip is visible again.
    expect(dropTarget(layout, { x: 600, y: 10 }, "main", true)).toEqual({ kind: "reorder", index: 3 });
    // Same frames, main focused last: main is on top.
    const mainOnTop: WindowLayout = { frames: [main, { ...over, focusRank: 1 }], cursor: null, positionsKnown: true };
    expect(dropTarget(mainOnTop, { x: 200, y: 10 }, "main", true)).toEqual({ kind: "reorder", index: 2 });
  });

  test("edges are half-open", () => {
    // x === 1000 is outside main, x === 999 inside.
    expect(dropTarget(L, { x: 1000, y: 10 }, "main", false)).toEqual({ kind: "new", at: { x: 1000, y: 10 } });
    expect(dropTarget(L, { x: 999, y: 10 }, "main", true)).toEqual({ kind: "reorder", index: 3 });
    // y === 36 is below main's strip (content), y === 700 below main.
    expect(dropTarget(L, { x: 500, y: 36 }, "main", true)).toEqual({ kind: "none" });
    expect(dropTarget(L, { x: 500, y: 700 }, "main", false)).toEqual({ kind: "new", at: { x: 500, y: 700 } });
    // x === -1600 is w-b's left edge (inside), x === -700 its right edge (outside).
    expect(dropTarget(L, { x: -1600, y: 100 }, "main", false)).toEqual({ kind: "move", window: "w-b", index: 0 });
    expect(dropTarget(L, { x: -700, y: 110 }, "main", false)).toEqual({ kind: "new", at: { x: -700, y: 110 } });
  });

  test("a tab midpoint exactly at the point does not count as left of it", () =>
    expect(dropTarget(L, { x: 180, y: 10 }, "main", true)).toEqual({ kind: "reorder", index: 1 }));

  test("a window without a reported strip only takes nothing", () => {
    const layout: WindowLayout = { frames: [main, { ...wB, strip: null, tabMids: [] }], cursor: null, positionsKnown: true };
    expect(dropTarget(layout, { x: -1500, y: 110 }, "main", false)).toEqual({ kind: "none" });
  });

  test("positions unknown (Wayland): outside self opens a new window, inside does nothing", () => {
    const layout: WindowLayout = {
      frames: [
        { label: "main", inner: null, strip: null, tabMids: [], focusRank: 0 },
        { label: "w-b", inner: null, strip: null, tabMids: [], focusRank: 1 },
      ],
      cursor: null,
      positionsKnown: false,
    };
    expect(dropTarget(layout, { x: -1500, y: 110 }, "main", false)).toEqual({ kind: "new", at: { x: -1500, y: 110 } });
    expect(dropTarget(layout, { x: 200, y: 10 }, "main", true)).toEqual({ kind: "none" });
  });
});
