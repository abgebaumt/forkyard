import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateRepo, jobBelongsHere, ownsJob } from "./coreSync";
import { useAppStore } from "./store";
import { keepFirstPage, qk, queryClient } from "./queries";

const three: InfiniteData<string, string | null> = { pages: ["a", "b", "c"], pageParams: [null, "x", "y"] };

describe("keepFirstPage", () => {
  it("passes undefined through", () => expect(keepFirstPage(undefined)).toBeUndefined());
  it("keeps a single page as the same object", () => {
    const one = { pages: ["a"], pageParams: [null] };
    expect(keepFirstPage(one)).toBe(one);
  });
  it("trims three pages to the first", () => expect(keepFirstPage(three)).toEqual({ pages: ["a"], pageParams: [null] }));
});

describe("invalidateRepo", () => {
  it("leaves one graph page after a refs change", async () => {
    const client = new QueryClient();
    client.setQueryData(qk.graph("r"), three);
    await invalidateRepo(client, "r", ["refs"]);
    expect(client.getQueryData<InfiniteData<string>>(qk.graph("r"))?.pages).toEqual(["a"]);
  });
  it("keeps all pages on an unrelated change", async () => {
    const client = new QueryClient();
    client.setQueryData(qk.graph("r"), three);
    await invalidateRepo(client, "r", ["locks"]);
    expect(client.getQueryData<InfiniteData<string>>(qk.graph("r"))?.pages).toHaveLength(3);
  });
  it("a change in the working directory reloads the graph edit's plan, not the rebase tool's", async () => {
    const client = new QueryClient();
    client.setQueryData(qk.rebaseBranchPlan("r", null), "plan");
    client.setQueryData(qk.rebasePlan("r", "branch"), "plan");
    await invalidateRepo(client, "r", ["worktree"]);
    // The graph edit is refused with a dirty working directory and offers to stash.
    expect(client.getQueryState(qk.rebaseBranchPlan("r", null))?.isInvalidated).toBe(true);
    expect(client.getQueryState(qk.rebasePlan("r", "branch"))?.isInvalidated).toBe(false);
  });
});

describe("jobBelongsHere", () => {
  it("a job started here is always shown", () => expect(jobBelongsHere("j1", null, new Set(["j1"]), new Set())).toBe(true));
  it("a job of another window is shown only for a repo with a tab here", () => {
    expect(jobBelongsHere("j2", "r1", new Set(), new Set(["r1"]))).toBe(true);
    expect(jobBelongsHere("j2", "r2", new Set(), new Set(["r1"]))).toBe(false);
    expect(jobBelongsHere("j3", null, new Set(), new Set(["r1"]))).toBe(false);
  });
});

describe("ownsJob", () => {
  it("takes the store's jobs and the repositories of this window's tabs", () => {
    useAppStore.getState().startJob({ id: "mine", title: "Clone", repoId: null });
    queryClient.setQueryData(qk.tabs, [
      { id: "t1", kind: "repo", repoId: "r1" },
      { id: "t2", kind: "manager", repoId: null },
    ]);
    expect(ownsJob("mine", null)).toBe(true);
    expect(ownsJob("other", "r1")).toBe(true);
    expect(ownsJob("other", "r2")).toBe(false);
    expect(ownsJob("other", null)).toBe(false);
    useAppStore.getState().finishJob("mine");
    queryClient.removeQueries({ queryKey: qk.tabs });
  });
});
