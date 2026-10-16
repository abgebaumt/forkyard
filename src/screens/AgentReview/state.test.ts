import { beforeEach, describe, expect, it } from "vitest";
import type { AgentReview, FileChange } from "../../core";
import { DEFAULT_PANE, focusedAgent, getPane, initPicks, pin, useReviewStore } from "./state";

const review = (to: string): AgentReview => ({
  agentId: "a1",
  repoId: "r",
  worktreeRepoId: "w",
  source: "snapshot",
  from: "1".repeat(40),
  to,
  tip: "3".repeat(40),
  base: "main",
  uncommittedFiles: 1,
  running: false,
});
const file = (path: string, patch: Partial<FileChange> = {}): FileChange => ({ path, oldPath: null, status: "modified", area: "commit", isBinary: false, isLfs: false, added: 1, removed: 1, conflict: null, ...patch });

beforeEach(() => useReviewStore.setState({ panes: {}, focus: {} }));

describe("agent review state", () => {
  it("starts with the defaults", () => {
    expect(getPane("t1", "a1")).toEqual(DEFAULT_PANE);
    expect(DEFAULT_PANE).toEqual({ source: "snapshot", pinned: null, picks: null, active: null, target: "worktree", message: null, skipHooks: false });
  });

  it("pins a review and starts with every line-pickable file selected, the first file active", () => {
    pin("t1", "a1", review("a".repeat(40)));
    expect(getPane("t1", "a1").pinned?.to).toBe("a".repeat(40));
    expect(getPane("t1", "a1").picks).toBeNull();
    initPicks("t1", "a1", [file("bild.png", { isBinary: true }), file("liste.txt")]);
    expect(getPane("t1", "a1").picks).toEqual({ "liste.txt": { kind: "all" } });
    expect(getPane("t1", "a1").active).toBe("bild.png");
    // The file list loads again (refetch): what the user chose stays.
    useReviewStore.getState().patch("t1", "a1", { picks: {} });
    initPicks("t1", "a1", [file("liste.txt")]);
    expect(getPane("t1", "a1").picks).toEqual({});
  });

  it("reloading pins the newer state and starts the selection over, the rest stays", () => {
    pin("t1", "a1", review("a".repeat(40)));
    initPicks("t1", "a1", [file("liste.txt")]);
    useReviewStore.getState().patch("t1", "a1", { target: "both", skipHooks: true, message: { summary: "Eigene Zeile", description: "" } });
    pin("t1", "a1", review("b".repeat(40)));
    const pane = getPane("t1", "a1");
    expect([pane.pinned?.to, pane.picks, pane.active]).toEqual(["b".repeat(40), null, null]);
    expect([pane.target, pane.skipHooks, pane.message]).toEqual(["both", true, { summary: "Eigene Zeile", description: "" }]);
  });

  it("panes belong to a tab and an agent; closing a tab's review forgets only that tab", () => {
    pin("t1", "a1", review("a".repeat(40)));
    pin("t1", "a2", review("b".repeat(40)));
    pin("t2", "a1", review("c".repeat(40)));
    useReviewStore.getState().setFocus("t1", "a2");
    useReviewStore.getState().forget("t1");
    expect(getPane("t1", "a1")).toEqual(DEFAULT_PANE);
    expect(getPane("t1", "a2")).toEqual(DEFAULT_PANE);
    expect(getPane("t2", "a1").pinned?.to).toBe("c".repeat(40));
    expect(useReviewStore.getState().focus).toEqual({});
  });

  it("the commit panel follows the pane focused last, otherwise the first agent", () => {
    expect(focusedAgent(undefined, ["a1", "a2"])).toBe("a1");
    expect(focusedAgent("a2", ["a1", "a2"])).toBe("a2");
    expect(focusedAgent("weg", ["a1"])).toBe("a1");
    expect(focusedAgent(undefined, [])).toBeNull();
  });
});
