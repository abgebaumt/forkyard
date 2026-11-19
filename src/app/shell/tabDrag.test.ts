import { expect, test } from "vitest";
import { leftStrip } from "./tabDrag";

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
