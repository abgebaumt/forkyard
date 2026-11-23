import { describe, expect, it, vi } from "vitest";

vi.mock("./closeGuard", () => ({ restartForUpdate: vi.fn() }));
vi.mock("./actions/hosts", () => ({ openInBrowser: vi.fn() }));
vi.mock("./errors", () => ({ describeError: (error: unknown) => ({ text: String(error), hint: "hint" }) }));

const { restartFailure } = await import("./updateDialog");

describe("restartFailure", () => {
  it("is null when the restart works", async () => {
    expect(await restartFailure(async () => undefined)).toBeNull();
  });
  it("turns a failed install into the error text instead of staying silent", async () => {
    expect(await restartFailure(() => Promise.reject("boom"))).toEqual({ text: "boom", hint: "hint" });
  });
});
