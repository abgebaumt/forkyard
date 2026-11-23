import { describe, expect, it } from "vitest";
import { CoreError } from "../core";
import { describeError, errorInfo, toCoreError } from "./errors";

describe("error texts", () => {
  it("explain the code for repository commands that are not approved", () => {
    expect(errorInfo.command_untrusted.text).not.toBe("errors.command_untrusted.text");
    expect(errorInfo.command_untrusted.hint).toContain(".forkyard/commands.json");
  });
});

describe("toCoreError", () => {
  it("keeps core errors, wraps their shape, and takes the message of anything else", () => {
    const core = new CoreError({ code: "push_rejected", message: "no", gitOutput: null });
    expect(toCoreError(core)).toBe(core);
    expect(toCoreError({ code: "not_found", message: "gone", gitOutput: "x" })).toMatchObject({
      code: "not_found",
      message: "gone",
      gitOutput: "x",
    });
    expect(toCoreError(new Error("boom"))).toMatchObject({ code: "unknown", message: "boom" });
    expect(toCoreError("text")).toMatchObject({ code: "unknown", message: "text" });
    // No message: describeError then falls back to the text of `errors.unknown`.
    expect(toCoreError(undefined)).toMatchObject({ code: "unknown", message: "" });
  });
});

describe("describeError", () => {
  it("shows the localised text and hint for a wrong update signature, not the plugin's message", () => {
    const error = new CoreError({
      code: "update_signature_invalid",
      message: "minisign error: Signature verification failed",
      gitOutput: null,
    });
    expect(describeError(error)).toEqual(errorInfo.update_signature_invalid);
    expect(describeError(error).text).not.toContain("minisign");
  });
});
