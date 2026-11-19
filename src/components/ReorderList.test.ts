import { describe, expect, it } from "vitest";
import { dropZone, releasedEarly } from "./ReorderList";

describe("dropZone", () => {
  it("the outer quarters insert, the middle folds onto the row", () => {
    expect([dropZone(2, 28), dropZone(7, 28), dropZone(14, 28), dropZone(21, 28), dropZone(26, 28)]).toEqual([
      "before",
      "onto",
      "onto",
      "onto",
      "after",
    ]);
  });
});

describe("releasedEarly", () => {
  it("ends only a handed-over drag on a move without buttons", () => {
    expect(releasedEarly({ started: true, handedOver: true }, 0)).toBe(true);
    expect(releasedEarly({ started: true, handedOver: true }, 1)).toBe(false);
    // A drag the list started itself sees its own pointerup; a stray button-less move must not end it.
    expect(releasedEarly({ started: true }, 0)).toBe(false);
  });
});
