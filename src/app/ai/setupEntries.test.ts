import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>(
  ["/src/screens/Archaeology/index.tsx", "/src/screens/PullRequestCreate/AiWrite.tsx", "/src/screens/PullRequestView/ReviewThreads.tsx", "/src/screens/ReleaseNotes/Dialog.tsx"],
  { query: "?raw", import: "default", eager: true },
);

/**
 * Spec 1.3, visibility table: master switch on, provider missing → the element is visible and a
 * click opens the first-time setup (`openAiSetup`). Only "Change limit" opens Settings › AI
 * (`openAiSettings`), because the limit lives there and not in the setup dialog.
 */

describe("AI elements open the first-time setup while no provider is connected", () => {
  it("reads all four files", () => expect(Object.keys(SOURCES)).toHaveLength(4));
  for (const [file, source] of Object.entries(SOURCES)) {
    it(file, () => {
      const lines = source.split("\n");
      expect(lines.some((line) => /\bopenAiSetup\(\)/.test(line)), "calls openAiSetup()").toBe(true);
      lines.forEach((line, index) => {
        if (!/\bopenAiSettings\b/.test(line) || /^import /.test(line)) return;
        const around = lines.slice(index, index + 3).join("\n");
        expect(around, `${file}:${index + 1} opens Settings › AI for something other than "Change limit"`).toContain("ai.state.limitChange");
      });
    });
  }
});
