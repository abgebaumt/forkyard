import { describe, expect, it } from "vitest";
import { dropZone } from "./ReorderList";

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
