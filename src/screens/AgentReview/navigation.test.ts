import { beforeEach, describe, expect, it } from "vitest";
import { getTabView, useAppStore } from "../../app/store";
import { closeAgentReview, compareWith, openAgentReview, showColumns, stopComparing } from "./navigation";
import { getPane, pin, useReviewStore } from "./state";

beforeEach(() => {
  useAppStore.setState({ views: {}, overlay: null });
  useReviewStore.setState({ panes: {}, focus: {} });
});

describe("agent review navigation", () => {
  it("opens over the cockpit with the commit panel and goes back on close", () => {
    useAppStore.getState().setCenter("t1", { kind: "cockpit" });
    openAgentReview("t1", "a1");
    expect(getTabView("t1").center).toEqual({ kind: "agent_review", agentIds: ["a1"], show: "first" });
    expect(getTabView("t1").rightPanel).toBe("review_commit");
    closeAgentReview("t1");
    expect(getTabView("t1").center).toEqual({ kind: "cockpit" });
    expect(getTabView("t1").rightPanel).toBe("details");
  });

  it("compares two agents at most and switches the columns", () => {
    openAgentReview("t1", "a1");
    compareWith("t1", "a2");
    expect(getTabView("t1").center).toEqual({ kind: "agent_review", agentIds: ["a1", "a2"], show: "both" });
    compareWith("t1", "a1");
    compareWith("t1", "a3");
    expect(getTabView("t1").center).toEqual({ kind: "agent_review", agentIds: ["a1", "a3"], show: "both" });
    showColumns("t1", "second");
    expect(getTabView("t1").center).toEqual({ kind: "agent_review", agentIds: ["a1", "a3"], show: "second" });
    stopComparing("t1");
    expect(getTabView("t1").center).toEqual({ kind: "agent_review", agentIds: ["a1"], show: "first" });
  });

  it("opening another agent while a review is open keeps the way back; closing forgets the panes", () => {
    useAppStore.getState().setCenter("t1", { kind: "graph" });
    openAgentReview("t1", "a1");
    pin("t1", "a1", { agentId: "a1", repoId: "r", worktreeRepoId: "w", source: "branch", from: "1".repeat(40), to: "2".repeat(40), tip: "2".repeat(40), base: "main", uncommittedFiles: 0, running: false });
    openAgentReview("t1", "a2");
    expect(getTabView("t1").center).toEqual({ kind: "agent_review", agentIds: ["a2"], show: "first" });
    closeAgentReview("t1");
    expect(getTabView("t1").center).toEqual({ kind: "graph" });
    expect(getPane("t1", "a1").pinned).toBeNull();
    // Closing again (nothing open) changes nothing.
    closeAgentReview("t1");
    expect(getTabView("t1").center).toEqual({ kind: "graph" });
  });
});
