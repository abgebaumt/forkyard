import { describe, expect, it, vi } from "vitest";

vi.mock("./closeGuard", () => ({ restartForUpdate: vi.fn() }));
vi.mock("./actions/hosts", () => ({ openInBrowser: vi.fn() }));
vi.mock("./errors", () => ({ describeError: (error: unknown) => ({ text: String(error), hint: "hint" }) }));

const { restartOutcome } = await import("./updateDialog");

describe("restartOutcome", () => {
  it("is null when the restart works", async () => {
    expect(await restartOutcome(async () => true)).toBeNull();
  });
  it("says so when the user cancelled the close guard", async () => {
    expect(await restartOutcome(async () => false)).toBe("cancelled");
  });
  it("turns a failed install into the error text instead of staying silent", async () => {
    expect(await restartOutcome(() => Promise.reject("boom"))).toEqual({ text: "boom", hint: "hint" });
  });
});
