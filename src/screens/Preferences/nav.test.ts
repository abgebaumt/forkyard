import { describe, expect, it } from "vitest";
import { SECTIONS, searchSections, visibleSections } from "./nav";

describe("settings navigation", () => {
  it("shows project sections only with an open repo", () => {
    expect(visibleSections(false).some((s) => s.level === "project")).toBe(false);
    expect(visibleSections(true).filter((s) => s.level === "project").map((s) => s.id)).toEqual(["p-identity", "p-git", "p-files"]);
  });
  it("has unique IDs and the levels in the order global, profile, project, help", () => {
    expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
    const order = SECTIONS.map((s) => s.level).filter((level, i, all) => all.indexOf(level) === i);
    expect(order).toEqual(["global", "profile", "project", "help"]);
  });
  it("has unique labels (tabs are found by name)", () => {
    expect(new Set(SECTIONS.map((s) => s.label)).size).toBe(SECTIONS.length);
  });
  it("finds terms in several sections and counts them", () => {
    const hits = searchSections("pull", visibleSections(true));
    expect(hits.get("git")).toBeGreaterThan(0);
    expect(hits.get("p-git")).toBeGreaterThan(0);
    expect(hits.has("appearance")).toBe(false);
  });
  it("ignores case and surrounding spaces; an empty search finds nothing", () => {
    expect(searchSections("  ZOOM ", SECTIONS).get("appearance")).toBe(1);
    expect(searchSections("", SECTIONS).size).toBe(0);
    expect(searchSections("   ", SECTIONS).size).toBe(0);
  });
});
