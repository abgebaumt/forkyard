import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TerminalHandoff } from "../../screens/Terminal/sessions";

const invalidated: unknown[] = [];
const adopted: { tabId: string; repoId: string; list: TerminalHandoff[] }[] = [];
const released: string[] = [];
const shell: TerminalHandoff = {
  terminalId: "t-7",
  key: "term-a",
  title: "Shell",
  program: false,
  scrollback: "$ git status\nAuf Branch main",
};

vi.mock("../queries", () => ({
  qk: { draft: (repoId: string) => ["repo", repoId, "draft"] },
  queryClient: { invalidateQueries: (filter: unknown) => invalidated.push(filter) },
}));
vi.mock("../../screens/Terminal/sessions", () => ({
  releaseSessions: (tabId: string) => {
    released.push(tabId);
    return [shell];
  },
  adoptSessions: (tabId: string, repoId: string, list: TerminalHandoff[]) => adopted.push({ tabId, repoId, list }),
}));

const { useAppStore, getTabView } = await import("../store");
const { applyHandoff, buildHandoff, noteGraphTop, parseHandoff, serializeHandoff } = await import("./handoff");

beforeEach(() => {
  invalidated.length = 0;
  adopted.length = 0;
  released.length = 0;
});

describe("hand-over", () => {
  test("parseHandoff rejects other versions and broken JSON", () => {
    expect(parseHandoff("{")).toBeNull();
    expect(parseHandoff('{"version":2}')).toBeNull();
    expect(parseHandoff("null")).toBeNull();
    expect(parseHandoff('{"version":1,"view":{},"terminals":"no","topSha":null}')).toBeNull();
  });

  test("a hand-over round-trips the tab view", () => {
    const store = useAppStore.getState();
    store.selectCommits("tab-1", ["a1b2c3", "d4e5f6"]);
    store.setSearchOpen("tab-1", true);
    noteGraphTop("tab-1", "0badc0de");
    const built = buildHandoff("tab-1");
    expect(released).toEqual(["tab-1"]);
    expect(built.terminals).toEqual([shell]);
    expect(built.topSha).toBe("0badc0de");
    expect(built.view.selection).toEqual({ kind: "commits", shas: ["a1b2c3", "d4e5f6"] });
    expect(built.view.searchOpen).toBe(true);
    expect(parseHandoff(serializeHandoff(built))).toEqual(built);
  });

  test("unknown fields are ignored", () => {
    const text = JSON.stringify({ version: 1, view: getTabView("none"), terminals: [], topSha: null, later: "x" });
    expect(parseHandoff(text)).toEqual({ version: 1, view: getTabView("none"), terminals: [], topSha: null });
  });

  test("applyHandoff patches the view, reveals the top commit and adopts the terminals", () => {
    const view = { ...getTabView("none"), selection: { kind: "commits" as const, shas: ["d4e5f6"] }, terminalOpen: true };
    applyHandoff("tab-9", "r1", { version: 1, view, terminals: [shell], topSha: "0badc0de" });
    const now = getTabView("tab-9");
    expect(now.selection).toEqual({ kind: "commits", shas: ["d4e5f6"] });
    expect(now.terminalOpen).toBe(true);
    expect(now.reveal?.sha).toBe("0badc0de");
    expect(adopted).toEqual([{ tabId: "tab-9", repoId: "r1", list: [shell] }]);
  });

  test("applyHandoff invalidates the draft of the repository", () => {
    applyHandoff("tab-9", "r1", { version: 1, view: getTabView("none"), terminals: [], topSha: null });
    expect(invalidated).toEqual([{ queryKey: ["repo", "r1", "draft"] }]);
    expect(getTabView("tab-9").reveal).toBeNull();
  });

  test("without a repository nothing is adopted or invalidated", () => {
    applyHandoff("tab-9", null, { version: 1, view: getTabView("none"), terminals: [shell], topSha: null });
    expect(adopted).toEqual([]);
    expect(invalidated).toEqual([]);
  });
});
