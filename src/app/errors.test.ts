import { describe, expect, it } from "vitest";
import { errorInfo } from "./errors";

describe("error texts", () => {
  it("explain the code for repository commands that are not approved", () => {
    expect(errorInfo.command_untrusted.text).not.toBe("errors.command_untrusted.text");
    expect(errorInfo.command_untrusted.hint).toContain(".forkyard/commands.json");
  });
});
