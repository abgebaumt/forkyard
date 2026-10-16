import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiPreview } from "../../core";

const confirmed: unknown[] = [];
let choice: { send: boolean; dontAskAgain: boolean } | null = null;
const shown: string[] = [];

const previewed: unknown[] = [];

vi.mock("../../core", () => ({
  core: {
    aiPreview: (input: unknown) => {
      previewed.push(input);
      return Promise.resolve({ text: "t", omitted: [], shortened: [], chars: 1, estimatedTokens: 1, estimatedCostUsd: null, asks: [], fingerprint: "f", monthCostUsd: 0, limitUsd: null });
    },
    aiPreviewConfirm: (input: unknown) => {
      confirmed.push(input);
      return Promise.resolve();
    },
  },
}));
vi.mock("./PreviewDialog", () => ({
  showAiPreview: (_preview: AiPreview, mode: string) => {
    shown.push(mode);
    return Promise.resolve(choice);
  },
}));
vi.mock("../run", () => ({
  runAction: async <T>(_label: string, fn: () => Promise<T>) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error };
    }
  },
}));

const { confirmSend, showWhatIsSent } = await import("./gate");

const preview = (asks: AiPreview["asks"]): AiPreview => ({
  text: "t",
  omitted: [],
  shortened: [],
  chars: 10,
  estimatedTokens: 3,
  estimatedCostUsd: null,
  asks,
  fingerprint: "abc",
  monthCostUsd: 0,
  limitUsd: null,
});

beforeEach(() => {
  confirmed.length = 0;
  shown.length = 0;
  choice = null;
});

describe("send gate", () => {
  it("sends without a dialog when nothing asks", async () => {
    expect(await confirmSend("r", "commit_message", preview([]))).toBe(true);
    expect(shown).toEqual([]);
    expect(confirmed).toEqual([]);
  });

  it("cancelling the dialog sends nothing and confirms nothing", async () => {
    choice = null;
    expect(await confirmSend("r", "commit_message", preview(["first_use"]))).toBe(false);
    expect(shown).toEqual(["confirm"]);
    expect(confirmed).toEqual([]);
  });

  it("'Send' confirms exactly this text with its triggers", async () => {
    choice = { send: true, dontAskAgain: true };
    expect(await confirmSend("r", "compose", preview(["large", "repo_first"]))).toBe(true);
    expect(confirmed).toEqual([{ repoId: "r", feature: "compose", fingerprint: "abc", triggers: ["large", "repo_first"], dontAskAgain: true }]);
  });

  it("“What is sent?” builds the preview of the given input and only shows it", async () => {
    previewed.length = 0;
    shown.length = 0;
    await showWhatIsSent("r", "commit_message", { kind: "commit_message" });
    await showWhatIsSent("r", "commit_message");
    expect(previewed).toEqual([
      { repoId: "r", feature: "commit_message", input: { kind: "commit_message" }, locale: "en-US" },
      { repoId: "r", feature: "commit_message", input: { kind: "staged_changes" }, locale: "en-US" },
    ]);
    expect(shown).toEqual(["look", "look"]);
    expect(confirmed).toEqual([]);
  });
});
