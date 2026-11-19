import { expect, test } from "vitest";
import { indexWithout, leftStrip, visibleRect } from "./tabDrag";

const strip = { left: 0, top: 0, right: 800, bottom: 36 };

test("inside the strip and within the margin is still a reorder", () => {
  expect(leftStrip(strip, 400, 20)).toBe(false);
  expect(leftStrip(strip, 400, 59)).toBe(false);
});

test("beyond the margin below or outside the window is a drag out", () => {
  expect(leftStrip(strip, 400, 61)).toBe(true);
  expect(leftStrip(strip, -30, 10)).toBe(true);
});

test("the margin applies on every side and can be set", () => {
  expect(leftStrip(strip, -20, -20)).toBe(false);
  expect(leftStrip(strip, 830, 10)).toBe(true);
  expect(leftStrip(strip, 400, 50, 10)).toBe(true);
});

test("at 125 % zoom the layout rectangle is scaled to pointer pixels before the margin check", () => {
  // A 640 × 28.8 layout-pixel bar covers 800 × 36 visible pixels at 125 %.
  const layout = { left: 0, top: 0, right: 640, bottom: 28.8 };
  const visible = visibleRect(layout, 1.25);
  expect(visible).toEqual({ left: 0, top: 0, right: 800, bottom: 36 });
  // 700 is on the right part of the strip: still a reorder, not a drag out.
  expect(leftStrip(visible, 700, 20)).toBe(false);
  expect(leftStrip(visible, 830, 20)).toBe(true);
  expect(leftStrip(visible, 400, 59)).toBe(false);
  expect(leftStrip(visible, 400, 61)).toBe(true);
});

test("the insertion index counts without the dragged tab", () => {
  // Tabs A B C D, B (index 1) dragged.
  expect(indexWithout(0, 1)).toBe(0); // before A
  expect(indexWithout(1, 1)).toBe(1); // before itself: stays
  expect(indexWithout(2, 1)).toBe(1); // before C: still between A and C
  expect(indexWithout(3, 1)).toBe(2); // before D
  expect(indexWithout(4, 1)).toBe(3); // after D
});
