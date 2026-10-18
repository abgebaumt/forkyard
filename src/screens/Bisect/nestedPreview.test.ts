/**
 * The autopilot dialog sits in the dialog host, which shows one dialog at a time, so "What is sent?"
 * (look and confirm) must open nested in it. The asker drives the real send gate: nothing is
 * confirmed before "Send", closing answers "no", a second ask ends the first one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiPreview } from "../../core";

const confirmed: unknown[] = [];
vi.mock("../../core", () => ({
  core: {
    aiPreviewConfirm: (input: unknown) => {
      confirmed.push(input);
      return Promise.resolve();
    },
  },
}));
vi.mock("../../app/ai/PreviewDialog", () => ({
  showAiPreview: () => {
    throw new Error("the queued dialog host must not be used inside the autopilot dialog");
  },
}));
vi.mock("../../app/run", () => ({
  runAction: async <T>(_label: string, fn: () => Promise<T>) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error };
    }
  },
}));

const { confirmSend } = await import("../../app/ai/gate");
const { nestedPreview } = await import("./nestedPreview");
type Shown = { preview: AiPreview; mode: "look" | "confirm" } | null;

const preview = (asks: AiPreview["asks"]): AiPreview => ({
  text: "## Commits good..bad\n- 3f2a91c Swap the factors",
  omitted: [],
  shortened: [],
  chars: 44,
  estimatedTokens: 11,
  estimatedCostUsd: null,
  asks,
  fingerprint: "fp-bisect",
  monthCostUsd: 0,
  limitUsd: null,
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let shown: Shown[] = [];
beforeEach(() => {
  confirmed.length = 0;
  shown = [];
});

describe("bisect autopilot: “What is sent?” nested in the dialog", () => {
  it("sends without a dialog when the core asks for nothing", async () => {
    const asker = nestedPreview((value) => shown.push(value));
    expect(await confirmSend("repo", "bisect_script", preview([]), asker.ask)).toBe(true);
    expect(shown).toEqual([]);
    expect(confirmed).toEqual([]);
  });

  it("waits for “Send” in the nested dialog and confirms exactly the shown preview", async () => {
    const asker = nestedPreview((value) => shown.push(value));
    const asks: AiPreview["asks"] = ["first_use", "repo_first"];
    let done: boolean | null = null;
    void confirmSend("repo", "bisect_script", preview(asks), asker.ask).then((value) => (done = value));
    await settle();
    expect(shown.at(-1)?.mode).toBe("confirm");
    expect(done).toBeNull();
    expect(confirmed).toEqual([]);
    asker.close({ send: true, dontAskAgain: false });
    await settle();
    expect(shown.at(-1)).toBeNull();
    expect(done).toBe(true);
    expect(confirmed).toEqual([{ repoId: "repo", feature: "bisect_script", fingerprint: "fp-bisect", triggers: asks, dontAskAgain: false }]);
  });

  it("closing the nested dialog sends nothing", async () => {
    const asker = nestedPreview((value) => shown.push(value));
    let done: boolean | null = null;
    void confirmSend("repo", "bisect_script", preview(["first_use", "repo_first"]), asker.ask).then((value) => (done = value));
    await settle();
    asker.close(null);
    await settle();
    expect(done).toBe(false);
    expect(confirmed).toEqual([]);
  });

  it("a second ask answers the first one with “no” and shows only the new preview", async () => {
    const asker = nestedPreview((value) => shown.push(value));
    const first = asker.ask(preview([]), "look");
    const second = asker.ask(preview([]), "look");
    expect(await first).toBeNull();
    asker.close({ send: false, dontAskAgain: false });
    expect(await second).toEqual({ send: false, dontAskAgain: false });
    expect(shown.filter((value) => value !== null)).toHaveLength(2);
  });
});
