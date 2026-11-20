import { describe, expect, it } from "vitest";
import type { PendingDrag } from "../../app/rebasePlan/graphEdit";
import { watchRelease } from "./useRowDrag";

const pointer = (type: string, pointerId: number) => Object.assign(new Event(type), { pointerId });

describe("a row drag waiting for the edit", () => {
  it("records the release of its own pointer, once", () => {
    const target = new EventTarget();
    const drag: PendingDrag = { sha: "a", pointerId: 1, clientX: 0, clientY: 0 };
    watchRelease(drag, target);
    target.dispatchEvent(pointer("pointerup", 2));
    expect(drag.released).toBeUndefined();
    target.dispatchEvent(pointer("pointerup", 1));
    expect(drag.released).toBe(true);
  });
  it("a cancelled pointer counts as released", () => {
    const target = new EventTarget();
    const drag: PendingDrag = { sha: "a", pointerId: 1, clientX: 0, clientY: 0 };
    watchRelease(drag, target);
    target.dispatchEvent(pointer("pointercancel", 1));
    expect(drag.released).toBe(true);
  });
});
