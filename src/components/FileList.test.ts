import { describe, expect, it } from "vitest";
import type { FileChange } from "../core";
import { treeRows } from "./FileList";

const file = (path: string) => ({ path, status: "modified" }) as FileChange;
const files = [file("src/app/a.ts"), file("src/app/b.ts"), file("src/ui/c.ts"), file("README.md")];
const keys = (rows: ReturnType<typeof treeRows>) => rows.map((row) => row.key);

describe("treeRows", () => {
  it("shows every folder open by default", () => {
    expect(keys(treeRows(files, new Set(), false))).toEqual(["dir:src", "dir:src/app", "src/app/a.ts", "src/app/b.ts", "dir:src/ui", "src/ui/c.ts", "README.md"]);
  });

  it("closes the toggled folders", () => {
    expect(keys(treeRows(files, new Set(["src/app"]), false))).toEqual(["dir:src", "dir:src/app", "dir:src/ui", "src/ui/c.ts", "README.md"]);
  });

  it("starts with every folder closed when collapsed by default", () => {
    expect(keys(treeRows(files, new Set(), true))).toEqual(["dir:src", "README.md"]);
  });

  it("opens only the toggled folders when collapsed by default", () => {
    expect(keys(treeRows(files, new Set(["src"]), true))).toEqual(["dir:src", "dir:src/app", "dir:src/ui", "README.md"]);
  });
});
