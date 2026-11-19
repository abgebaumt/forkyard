import { describe, expect, it, vi } from "vitest";
import { sectionMenu, type SectionMenuContext } from "./menus";

const noop = () => {};
const baseContext: SectionMenuContext = {
  section: "local",
  collapsed: false,
  maximized: false,
  hidden: "none",
  solo: "none",
  canToggle: true,
  hasRefs: true,
  visible: { local: true, remote: true, tags: true, stashes: true },
  toggleCollapsed: noop,
  toggleMaximized: noop,
  toggleHide: noop,
  toggleSolo: noop,
  setVisible: noop,
};

describe("sectionMenu", () => {
  it("the Local section menu offers Clean up branches first", () => {
    const cleanBranches = vi.fn();
    const entries = sectionMenu({ ...baseContext, section: "local", cleanBranches });
    expect(entries[0]).toMatchObject({ label: "Clean up branches …" });
    (entries[0] as { onSelect: () => void }).onSelect();
    expect(cleanBranches).toHaveBeenCalled();
    const tags = sectionMenu({ ...baseContext, section: "tags", cleanBranches });
    expect(tags.some((entry) => "label" in entry && entry.label === "Clean up branches …")).toBe(false);
  });
});
