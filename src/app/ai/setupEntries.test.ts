import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>(
  [
    "/src/app/ai/AiErrorNotice.tsx",
    "/src/screens/Archaeology/index.tsx",
    "/src/screens/PullRequestCreate/AiWrite.tsx",
    "/src/screens/PullRequestView/ReviewThreads.tsx",
    "/src/screens/ReleaseNotes/Dialog.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
);

/**
 * master switch on, provider missing → the element is visible and a
 * click opens the first-time setup (`openAiSetup`, also through `checkProvider`). Only "Change limit" opens Settings › AI
 * (`openAiSettings`), because the limit lives there and not in the setup dialog.
 */

describe("AI elements open the first-time setup while no provider is connected", () => {
  it("reads all five files", () => expect(Object.keys(SOURCES)).toHaveLength(5));
  for (const [file, source] of Object.entries(SOURCES)) {
    it(file, () => {
      const lines = source.split("\n");
      expect(
        lines.some((line) => /\bopenAiSetup\(\)|\bcheckProvider\(/.test(line)),
        "calls openAiSetup() or checkProvider()",
      ).toBe(true);
      lines.forEach((line, index) => {
        if (!/\bopenAiSettings\b/.test(line) || /^import /.test(line)) return;
        const around = lines.slice(index, index + 3).join("\n");
        expect(around, `${file}:${index + 1} opens Settings › AI for something other than "Change limit"`).toContain(
          "ai.state.limitChange",
        );
      });
    });
  }
});
