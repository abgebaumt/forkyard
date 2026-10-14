import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveMode, loadImageMode, modeOptions, sameSize, saveImageMode, stackFrameStyle, stackGeometry } from "./imageDiff";

describe("image diff modes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers every mode only when both versions exist", () => {
    expect(modeOptions(true, true).map((option) => [option.value, option.disabled])).toEqual([
      ["side", false],
      ["swipe", false],
      ["onion", false],
      ["difference", false],
    ]);
    const single = modeOptions(false, true);
    expect(single.filter((option) => !option.disabled).map((option) => option.value)).toEqual(["side"]);
    expect(single.find((option) => option.value === "swipe")?.hint).toBeTruthy();
    expect(modeOptions(true, true).every((option) => option.label.length > 0 && !option.label.startsWith("diff."))).toBe(true);
    expect(effectiveMode("onion", true, true)).toBe("onion");
    expect(effectiveMode("onion", true, false)).toBe("side");
    expect(effectiveMode("difference", false, true)).toBe("side");
  });

  it("remembers the last mode and falls back without storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) });
    expect(loadImageMode()).toBe("side");
    saveImageMode("difference");
    expect(loadImageMode()).toBe("difference");
    store.set("gc.imageDiff.mode", "zoom");
    expect(loadImageMode()).toBe("side");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadImageMode()).toBe("side");
    expect(() => saveImageMode("swipe")).not.toThrow();
  });
});

describe("stack geometry", () => {
  it("aligns both images at the top left of a frame as large as both", () => {
    expect(stackGeometry({ width: 100, height: 50 }, { width: 200, height: 25 })).toEqual({
      width: 200,
      height: 50,
      before: { width: 50, height: 100 },
      after: { width: 100, height: 50 },
    });
    expect(sameSize({ width: 3, height: 4 }, { width: 3, height: 4 })).toBe(true);
    expect(sameSize({ width: 3, height: 4 }, { width: 4, height: 3 })).toBe(false);
  });

  it("the frame keeps the aspect ratio and never grows beyond the natural size", () => {
    expect(stackFrameStyle({ width: 200, height: 50 })).toEqual({
      aspectRatio: "200 / 50",
      width: "min(100cqw, calc(100cqh * 200 / 50), 200px)",
    });
  });
});
