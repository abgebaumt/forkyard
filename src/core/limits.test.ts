import { describe, expect, it } from "vitest";
import { SUMMARY_LIMIT } from "./limits";

describe("commit summary limit", () => {
  it("is the common 72 characters", () => {
    expect(SUMMARY_LIMIT).toBe(72);
  });

  it("is defined only once in the UI", () => {
    const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const owners = Object.entries(sources)
      .filter(([, text]) => /const SUMMARY_LIMIT\s*=/.test(text))
      .map(([file]) => file.split("/").pop());
    expect(owners).toEqual(["limits.ts"]);
  });

  it("is the number the core cuts AI summaries at", () => {
    const files = import.meta.glob("../../crates/core/src/ai/commit_message.rs", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const rust = Object.values(files)[0] ?? "";
    expect(rust).toMatch(new RegExp(`pub const SUMMARY_LIMIT: usize = ${SUMMARY_LIMIT};`));
  });
});
