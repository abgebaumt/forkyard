import { describe, expect, it } from "vitest";
import type { ReviewThread } from "../../core";
import { fixAvailability, replyDraft, splitThreads, targetHint, threadLines } from "./reviewModel";

const thread = (id: string, path: string, line: number | null, extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path,
  line,
  startLine: null,
  side: "new",
  commit: null,
  resolved: false,
  outdated: false,
  comments: [],
  ...extra,
});

describe("splitThreads", () => {
  it("shows the open threads by file and line, outdated last in their file, and counts the resolved ones", () => {
    const { open, resolved } = splitThreads([
      thread("1", "src/zeit.rs", 3),
      thread("2", "src/anmeldung.rs", 40),
      thread("3", "src/anmeldung.rs", 7),
      thread("4", "src/anmeldung.rs", 1, { resolved: true }),
      thread("5", "src/anmeldung.rs", null, { outdated: true }),
      thread("6", "src/Ärger.rs", 2),
    ]);
    expect(open.map((item) => item.id)).toEqual(["3", "2", "5", "6", "1"]);
    expect(resolved).toBe(1);
  });
});

describe("threadLines", () => {
  it("names one line, a range, or nothing for lines that are gone", () => {
    expect(threadLines({ line: 42, startLine: 40 })).toBe("lines 40–42");
    expect(threadLines({ line: 42, startLine: null })).toBe("line 42");
    expect(threadLines({ line: 42, startLine: 42 })).toBe("line 42");
    expect(threadLines({ line: null, startLine: null })).toBe("");
  });
});

describe("fixAvailability", () => {
  const on = { visible: true, opensSetup: false };
  it("is hidden without AI and opens the setup while no provider is connected", () => {
    expect(fixAvailability(thread("1", "a.rs", 3), { visible: false, opensSetup: false })).toBe("hidden");
    expect(fixAvailability(thread("1", "a.rs", 3), { visible: true, opensSetup: true })).toBe("setup");
  });
  it("is only offered for current lines on the new side", () => {
    expect(fixAvailability(thread("1", "a.rs", 3), on)).toBe("ready");
    expect(fixAvailability(thread("1", "a.rs", null), on)).toBe("unavailable");
    expect(fixAvailability(thread("1", "a.rs", 3, { outdated: true }), on)).toBe("unavailable");
    expect(fixAvailability(thread("1", "a.rs", 3, { side: "old" }), on)).toBe("unavailable");
  });
});

describe("replyDraft and targetHint", () => {
  it("drafts the reply from the reason, with the commit once taken over", () => {
    expect(replyDraft("  Leere Passwörter werden abgelehnt. ", null)).toBe("Leere Passwörter werden abgelehnt.");
    expect(replyDraft("Leere Passwörter werden abgelehnt.", "0123456789abcdef0123456789abcdef01234567")).toBe("Fixed in 0123456: Leere Passwörter werden abgelehnt.");
  });
  it("explains the chosen target only while it is the core's choice", () => {
    const fix = { target: { sha: "aaa", summary: "Teil 1", reason: "blame" as const } };
    expect(targetHint(fix, "aaa")).toBe("chosen from the blame of the commented lines");
    expect(targetHint({ target: { sha: "aaa", summary: "Teil 1", reason: "file" as const } }, "aaa")).toBe("the newest commit of the pull request that changes this file");
    expect(targetHint(fix, "bbb")).toBe("");
    expect(targetHint({ target: null }, "aaa")).toBe("");
  });
});
