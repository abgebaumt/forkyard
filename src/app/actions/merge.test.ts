import { describe, expect, it } from "vitest";
import { CoreError } from "../../core";
import { blockingFiles } from "./merge";

describe("blockingFiles", () => {
  it("reads file names in ‘…’ from the core's message", () => {
    const error = new CoreError({ code: "dirty_worktree", message: "Changes to ‘src/a.ts’ and ‘README.md’ would be overwritten.", gitOutput: null });
    expect(blockingFiles(error)).toEqual(["src/a.ts", "README.md"]);
  });
});
