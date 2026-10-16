import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus, PushResult, RepoSettings } from "../../core";

// How push() routes with the project switch "AI review before every push" (spec 6.2):
// the review runs first only where it can run; a plain push must always stay possible.
const corePush = vi.fn<(input: { force: boolean }) => Promise<PushResult>>();
const aiPreview = vi.fn<(input: unknown) => Promise<unknown>>();
const openAiSetup = vi.fn(async () => false);
const confirmSpy = vi.fn(async () => false);
const context = vi.hoisted(() => ({ value: { status: undefined as AiStatus | undefined, repo: undefined as Partial<RepoSettings> | undefined } }));

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    push: (input: { force: boolean }) => corePush(input),
    aiPreview: (input: unknown) => aiPreview(input),
    fetch: async () => ({ updatedRefs: 0, prunedRefs: 0, failed: [] }),
    status: async () => {
      throw new Error("not needed");
    },
    refs: async () => {
      throw new Error("not needed");
    },
    on: () => () => undefined,
  },
}));
vi.mock("./pushCheck", async (original) => ({
  ...(await original<typeof import("./pushCheck")>()),
  reviewContext: async () => context.value,
}));
vi.mock("../ai/open", () => ({ openAiSetup: () => openAiSetup() }));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirm: () => confirmSpy(),
}));
vi.mock("../../ui/Feedback", async (original) => ({
  ...(await original<typeof import("../../ui/Feedback")>()),
  toast: () => undefined,
}));

const { push } = await import("./sync");

const REPO = "repo-1";
const done: PushResult = { status: "done", remote: "origin", branch: "main", createdUpstream: false, forced: false };
const aiStatus = (patch: Partial<AiStatus>): AiStatus => ({
  state: "on",
  provider: "anthropic",
  model: "claude-sonnet",
  connected: true,
  keyHint: "…abcd",
  local: false,
  price: null,
  introPending: false,
  featuresOff: [],
  ...patch,
});
const switchOn = { aiOff: false, aiReviewBeforePush: true };

beforeEach(() => {
  corePush.mockReset().mockResolvedValue(done);
  aiPreview.mockReset().mockRejectedValue({ code: "cancelled", message: "stop here", gitOutput: null });
  openAiSetup.mockClear();
  confirmSpy.mockClear();
});

describe("push with 'AI review before every push'", () => {
  it("switch on but provider not connected (key removed): a plain push, no setup dialog", async () => {
    context.value = { status: aiStatus({ connected: false, keyHint: null }), repo: switchOn };
    const result = await push(REPO);
    expect(corePush).toHaveBeenCalledTimes(1);
    expect(result?.ok).toBe(true);
    expect(openAiSetup).not.toHaveBeenCalled();
    expect(aiPreview).not.toHaveBeenCalled();
  });

  it("switch on and provider connected: the review runs first, nothing is pushed before it", async () => {
    context.value = { status: aiStatus({}), repo: switchOn };
    await push(REPO);
    expect(aiPreview).toHaveBeenCalledTimes(1);
    expect(corePush).not.toHaveBeenCalled();
  });

  it("reviewed skips the review and pushes", async () => {
    context.value = { status: aiStatus({}), repo: switchOn };
    await push(REPO, { reviewed: true });
    expect(aiPreview).not.toHaveBeenCalled();
    expect(corePush).toHaveBeenCalledTimes(1);
  });

  it("force skips the review and goes to the force prompt", async () => {
    context.value = { status: aiStatus({}), repo: switchOn };
    expect(await push(REPO, { force: true })).toBeNull();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(aiPreview).not.toHaveBeenCalled();
    expect(corePush).not.toHaveBeenCalled();
  });

  it("switch off: a plain push", async () => {
    context.value = { status: aiStatus({}), repo: { aiOff: false, aiReviewBeforePush: false } };
    await push(REPO);
    expect(aiPreview).not.toHaveBeenCalled();
    expect(corePush).toHaveBeenCalledTimes(1);
  });
});
