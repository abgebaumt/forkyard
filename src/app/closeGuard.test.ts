import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  updateInstall: vi.fn(async () => undefined),
  appQuit: vi.fn(async () => undefined),
  windowClose: vi.fn(async () => undefined),
  appLossesElsewhere: vi.fn(async () => 0),
  appCloseGuard: vi.fn(async () => undefined),
}));
const dialogs = vi.hoisted(() => ({ confirm: vi.fn(async () => true), choose: vi.fn(async () => null) }));
vi.mock("../core", () => ({ core }));
vi.mock("./dialogs", () => dialogs);

import { isLastWindow, restartForUpdate } from "./closeGuard";

const window = (label: string) => ({ label, title: "", tabs: 1, focused: false });

describe("isLastWindow", () => {
  it("an unknown or empty list counts as the last window, so the guard asks", () => {
    expect(isLastWindow(undefined)).toBe(true);
    expect(isLastWindow([])).toBe(true);
  });
  it("one window is the last, two are not", () => {
    expect(isLastWindow([window("w1")])).toBe(true);
    expect(isLastWindow([window("w1"), window("w2")])).toBe(false);
  });
});

describe("restartForUpdate", () => {
  beforeEach(() => vi.clearAllMocks());
  it("installs instead of quitting when nothing would be lost", async () => {
    await restartForUpdate();
    expect(core.updateInstall).toHaveBeenCalledTimes(1);
    expect(core.appQuit).not.toHaveBeenCalled();
  });
  it("does not install when the user cancels", async () => {
    core.appLossesElsewhere.mockResolvedValueOnce(1);
    dialogs.confirm.mockResolvedValueOnce(false);
    await restartForUpdate();
    expect(core.updateInstall).not.toHaveBeenCalled();
  });
});
