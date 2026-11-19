import { describe, expect, it } from "vitest";
import { isLastWindow } from "./closeGuard";

const window = (label: string) => ({ label, title: "", tabs: 1, focused: false });

describe("isLastWindow", () => {
  it("an unknown or empty list counts as the last window, so the guard asks", () => {
    expect(isLastWindow(undefined)).toBe(true);
    expect(isLastWindow([])).toBe(true);
  });
  it("one window is the last, two are not", () => {
    expect(isLastWindow([window("w1")])).toBe(true);
    expect(isLastWindow([window("w1"), window("w2")])).toBe(false);
  });
});
