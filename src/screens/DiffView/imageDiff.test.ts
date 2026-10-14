import { afterEach, describe, expect, it, vi } from "vitest";
import { canCompare, effectiveMode, hexToRgb, loadImageMode, MAX_DIFF_PIXELS, modeOptions, pixelDifference, sameSize, saveImageMode, stackFrameStyle, stackGeometry, type Pixels } from "./imageDiff";

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

function image(width: number, height: number, rgba: number[]): Pixels {
  return { width, height, data: new Uint8ClampedArray(rgba) };
}
const RED = [255, 0, 0] as const;

describe("pixel difference", () => {
  it("identical images: nothing highlighted, the rest dimmed", () => {
    const result = pixelDifference(image(1, 1, [200, 100, 40, 255]), image(1, 1, [200, 100, 40, 255]), RED);
    expect(result.changed).toBe(0);
    expect([...result.data]).toEqual([50, 25, 10, 255]);
  });

  it("highlights changed pixels; transparent pixels are equal whatever their colour", () => {
    const before = image(2, 1, [0, 0, 0, 255, 9, 9, 9, 0]);
    const after = image(2, 1, [0, 0, 1, 255, 7, 7, 7, 0]);
    const result = pixelDifference(before, after, RED);
    expect(result.changed).toBe(1);
    expect([...result.data]).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
  });

  it("different sizes: aligned at the origin, the extra area counts as changed", () => {
    const before = image(1, 1, [12, 12, 12, 255]);
    const after = image(2, 1, [12, 12, 12, 255, 20, 20, 20, 255]);
    const result = pixelDifference(before, after, RED);
    expect([result.width, result.height, result.changed]).toEqual([2, 1, 1]);
    expect([...result.data]).toEqual([3, 3, 3, 255, 255, 0, 0, 255]);
  });

  it("a fully transparent pixel that only the larger image has is not a change", () => {
    expect(pixelDifference(image(1, 1, [5, 5, 5, 255]), image(2, 1, [5, 5, 5, 255, 1, 2, 3, 0]), RED).changed).toBe(0);
  });

  it("limits the comparison to MAX_DIFF_PIXELS", () => {
    expect(MAX_DIFF_PIXELS).toBe(4096 * 4096);
    expect(canCompare({ width: 4096, height: 4096 }, { width: 10, height: 10 })).toBe(true);
    expect(canCompare({ width: 4097, height: 10 }, { width: 10, height: 4096 })).toBe(false);
  });

  it("reads the highlight colour from hex tokens", () => {
    expect(hexToRgb("#e3877d")).toEqual([227, 135, 125]);
    expect(hexToRgb(" #abc ")).toEqual([170, 187, 204]);
    expect(hexToRgb("oklch(0.6 0.1 20)")).toBeNull();
  });
});
