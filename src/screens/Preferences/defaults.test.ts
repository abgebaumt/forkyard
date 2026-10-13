import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isChanged, resetPatch } from "./defaults";

describe("settings defaults", () => {
  it("detects deviations from the default, also for lists", () => {
    expect(isChanged(DEFAULT_SETTINGS, "zoom")).toBe(false);
    expect(isChanged({ ...DEFAULT_SETTINGS, zoom: 1.2 }, "zoom")).toBe(true);
    expect(isChanged({ ...DEFAULT_SETTINGS, proxyByHost: [] }, "proxyByHost")).toBe(false);
    expect(isChanged({ ...DEFAULT_SETTINGS, proxyByHost: [{ host: "a", proxy: "" }] }, "proxyByHost")).toBe(true);
  });
  it("resets exactly one field to the default", () => {
    expect(resetPatch("defaultPullMode")).toEqual({ defaultPullMode: "ff" });
    expect(resetPatch("externalEditor")).toEqual({ externalEditor: null });
  });
});
