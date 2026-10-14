import { describe, expect, it } from "vitest";
import { segmentTarget } from "./Field";

const opts = (...disabled: boolean[]) => disabled.map((value) => ({ disabled: value }));

describe("segmentTarget", () => {
  it("wraps around like before", () => {
    expect(segmentTarget(opts(false, false, false), 2, "ArrowRight")).toBe(0);
    expect(segmentTarget(opts(false, false, false), 0, "ArrowLeft")).toBe(2);
    expect(segmentTarget(opts(false, false, false), 1, "ArrowDown")).toBe(2);
    expect(segmentTarget(opts(false, false, false), 1, "ArrowUp")).toBe(0);
    expect(segmentTarget(opts(false, false, false), 1, "Home")).toBe(0);
    expect(segmentTarget(opts(false, false, false), 1, "End")).toBe(2);
  });

  it("skips disabled entries", () => {
    expect(segmentTarget(opts(false, true, true, false), 0, "ArrowRight")).toBe(3);
    expect(segmentTarget(opts(false, true, true, false), 0, "ArrowLeft")).toBe(3);
    expect(segmentTarget(opts(true, false, true), 1, "Home")).toBe(1);
    expect(segmentTarget(opts(true, false, true), 1, "End")).toBe(1);
  });

  it("stays put when only the current entry is enabled and ignores other keys", () => {
    expect(segmentTarget(opts(false, true, true, true), 0, "ArrowRight")).toBe(0);
    expect(segmentTarget(opts(false, false), 0, "Enter")).toBe(-1);
    expect(segmentTarget([], 0, "ArrowRight")).toBe(-1);
  });
});
