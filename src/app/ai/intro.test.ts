import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus } from "../../core";

const toast = vi.fn();
const dismissed: string[] = [];
const opened: string[] = [];

vi.mock("../../ui/Feedback", () => ({ toast: (data: unknown) => toast(data) }));
vi.mock("../../core", () => ({
  core: {
    aiIntroDismiss: () => {
      dismissed.push("dismiss");
      return Promise.resolve({ state: "unset", provider: null, model: null, connected: false, keyHint: null, local: false, price: null, introPending: false, featuresOff: [] });
    },
  },
}));
vi.mock("./open", () => ({ openAiSettings: () => opened.push("ai") }));

const { maybeShowAiIntro, resetAiIntroForTests } = await import("./intro");

const status = (patch: Partial<AiStatus> = {}): AiStatus => ({
  state: "unset",
  provider: null,
  model: null,
  connected: false,
  keyHint: null,
  local: false,
  price: null,
  introPending: true,
  featuresOff: [],
  ...patch,
});

type ToastArg = { tone: string; sticky?: boolean; title: string; action: { onClick: () => void }; secondaryAction: { onClick: () => void } };
const lastToast = () => toast.mock.calls.at(-1)?.[0] as ToastArg;

beforeEach(() => {
  toast.mockReset();
  dismissed.length = 0;
  opened.length = 0;
  resetAiIntroForTests();
});

describe("one-time notice after the update to 1.2", () => {
  it("shows once in unset, without a time limit", () => {
    expect(maybeShowAiIntro(status())).toBe(true);
    expect(lastToast()).toMatchObject({ tone: "info", sticky: true, title: "New in 1.2: AI features and coding agents – off by default." });
    expect(maybeShowAiIntro(status())).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it.each(["off", "on"] as const)("not in %s", (state) => {
    expect(maybeShowAiIntro(status({ state }))).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("not on a new installation (no marker)", () => {
    expect(maybeShowAiIntro(status({ introPending: false }))).toBe(false);
  });

  it("both buttons clear the marker; “Set up …” opens Settings › AI", async () => {
    maybeShowAiIntro(status());
    lastToast().action.onClick();
    await Promise.resolve();
    expect(opened).toEqual(["ai"]);
    expect(dismissed).toEqual(["dismiss"]);
    resetAiIntroForTests();
    maybeShowAiIntro(status());
    lastToast().secondaryAction.onClick();
    await Promise.resolve();
    expect(dismissed).toEqual(["dismiss", "dismiss"]);
    // "Close" opens nothing.
    expect(opened).toEqual(["ai"]);
  });
});
