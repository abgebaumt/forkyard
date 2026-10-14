import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { TicketLink } from "../LinkedText";
import { CollapseToggle } from "./GraphRowView";

type Props = { tabIndex?: number; onMouseDown?: (event: { preventDefault(): void }) => void };

/** A mouse press on the button must not take the focus off the row (keyboard navigation). */
function keepsFocus(element: ReactElement<Props>): boolean {
  const preventDefault = vi.fn();
  element.props.onMouseDown?.({ preventDefault });
  return element.props.tabIndex === -1 && preventDefault.mock.calls.length === 1;
}

describe("buttons inside graph rows", () => {
  it("keep the focus on the row when clicked", () => {
    expect(keepsFocus(CollapseToggle({ repoId: "r", sha: "abc", collapsed: false, tooLarge: false }) as ReactElement<Props>)).toBe(true);
    expect(keepsFocus(TicketLink({ text: "#1", url: "https://x.example/1", ruleId: "host:issue", focusable: false }) as ReactElement<Props>)).toBe(true);
  });

  it("stay ordinary buttons where the keyboard reaches the links (commit details)", () => {
    const link = TicketLink({ text: "#1", url: "https://x.example/1", ruleId: "host:issue", focusable: true }) as ReactElement<Props>;
    expect(link.props.tabIndex).toBeUndefined();
    expect(link.props.onMouseDown).toBeUndefined();
  });
});
