import { describe, expect, it } from "vitest";
import de from "../i18n/locales/de/updates.json";
import en from "../i18n/locales/en/updates.json";
import { whatsNewItems, whatsNewKey } from "./whatsNew";

describe("what's new", () => {
  it("keys per version, nothing for unknown versions", () => {
    expect(whatsNewKey("1.3.0")).toBe("updates.whatsNew.1_3_0.items");
    expect(whatsNewKey("1.3.0-dev")).toBe("updates.whatsNew.1_3_0.items");
    expect(whatsNewKey("v1.3.0")).toBe(null);
    const items = whatsNewItems("1.3.0")!;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(6);
    expect(whatsNewItems("9.9.9")).toBe(null);
    expect(whatsNewItems("1.3.1")).toEqual(items);
    expect(whatsNewItems("1.3.2-dev")).toEqual(items);
  });
  it("en and de have the same highlights count", () => {
    expect(de.whatsNew["1_3_0"].items).toHaveLength(en.whatsNew["1_3_0"].items.length);
  });
});
